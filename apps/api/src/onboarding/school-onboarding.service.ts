import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { validateOnboardingSaveInput, verifyOnboardingProfile, verifySchoolOnboarding, type OnboardingProfile, type SchoolOnboarding } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

export type SchoolOnboardingContext = MembershipLifecycleContext;

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='2s'; SET LOCAL log_parameter_max_length_on_error=0";

const ERRORS: Record<string, (code: string) => HttpException> = {
  ONBOARDING_INVALID: code => new BadRequestException({ code, detail: 'Send every welcome answer from the allowed choices.' }),
  ONBOARDING_FORBIDDEN: code => new ForbiddenException({ code, detail: 'Onboarding permission at this school is required.' }),
  ONBOARDING_BUSY: code => new ConflictException({ code, detail: 'The same save is still being processed. Try again shortly with the same key.' }),
  VERSION_CONFLICT: code => new ConflictException({ code, detail: 'The answers changed in another tab or by another person. Reload them, then save again.' }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for different answers.' }),
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '', message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && ['22023', '42501', '40001', '23505', '55P03'].includes(sqlState)) throw known(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'ONBOARDING_FORBIDDEN' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'ONBOARDING_CONFLICT' });
  if (['22023', '22P02', '22003'].includes(sqlState)) throw new BadRequestException({ code: 'ONBOARDING_INVALID' });
  throw new ServiceUnavailableException({ code: 'ONBOARDING_UNAVAILABLE', detail: 'Nothing is assumed saved. Reload, or retry the unchanged save with the same key.' });
}

/**
 * Onboarding answers and setup progress (0323). Each call runs one protected definer function that re-proves the direct
 * human subject and live onboarding.manage at the session school. Progress is recomputed from real records on every read.
 * Deliberately no active-entitlement requirement (owner decision D3); school-data steps read UNAVAILABLE until access starts.
 */
@Injectable()
export class SchoolOnboardingService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async read(context: SchoolOnboardingContext): Promise<SchoolOnboarding> {
    this.assertHuman(context, false);
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(LIMITS); await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        return verifySchoolOnboarding((await client.query<{ data: unknown }>('SELECT hon.read_school_onboarding($1) AS data', [context.externalSubject])).rows[0]?.data);
      });
    } catch (error) { return translate(error); }
  }

  async save(context: SchoolOnboardingContext, value: unknown): Promise<{ profile: OnboardingProfile; replayed: boolean }> {
    this.assertHuman(context, true);
    let input;
    try { input = validateOnboardingSaveInput(value); } catch { throw new BadRequestException({ code: 'ONBOARDING_INVALID' }); }
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(LIMITS); await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: Record<string, unknown> }>('SELECT hon.save_school_onboarding($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
          [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        const data = result.rows[0]?.data;
        if (result.rows.length !== 1 || !data || Object.keys(data).sort().join(',') !== 'record,replayed' || typeof data.replayed !== 'boolean') throw new Error('Unverified onboarding receipt.');
        return { profile: verifyOnboardingProfile(data.record), replayed: data.replayed };
      });
    } catch (error) { return translate(error); }
  }

  private assertHuman(context: SchoolOnboardingContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || !context.externalSubject
      || (command ? !context.idempotencyKey || context.idempotencyKey.length > 200 : context.idempotencyKey !== '')) throw new ForbiddenException({ code: 'ONBOARDING_FORBIDDEN' });
  }
}
