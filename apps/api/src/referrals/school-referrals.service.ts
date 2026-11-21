import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  validateFamilyReferralRewardInput, validateSchoolReferralProgramInput, verifyFamilyReferralRewardReceipt, verifySchoolReferralProgramReceipt,
  verifySchoolReferrals, type SchoolReferral, type SchoolReferralProgram, type SchoolReferrals,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ERRORS: Record<string, () => HttpException> = {
  VALIDATION_FAILED: () => new BadRequestException({ code: 'VALIDATION_FAILED' }),
  SCHOOL_REFERRAL_FORBIDDEN: () => new ForbiddenException({ code: 'SCHOOL_REFERRAL_FORBIDDEN' }),
  REFERRAL_FORM_REQUIRED: () => new UnprocessableEntityException({ code: 'REFERRAL_FORM_REQUIRED', detail: 'Choose the form your friends fill in before turning referrals on.' }),
  REFERRAL_FORM_UNAVAILABLE: () => new UnprocessableEntityException({ code: 'REFERRAL_FORM_UNAVAILABLE', detail: 'That form is not a published form of this school.' }),
  REFERRAL_NOT_FOUND: () => new UnprocessableEntityException({ code: 'REFERRAL_NOT_FOUND', detail: 'That referral is not a referral of this school.' }),
  VERSION_CONFLICT: () => new ConflictException({ code: 'VERSION_CONFLICT', detail: 'This changed since you opened it. Reload and try again with a new Idempotency-Key.' }),
  IDEMPOTENCY_KEY_REUSED: () => new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', detail: 'The idempotency key was already used for a different command.' }),
};
export function translateSchoolReferralsError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && ['22023', '42501', '40001', '23505'].includes(sqlState)) throw known();
  if (sqlState === '42501') throw new ForbiddenException({ code: 'SCHOOL_REFERRAL_FORBIDDEN' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'SCHOOL_REFERRAL_CONFLICT' });
  if (['22023', '22P02', '23514'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'SCHOOL_REFERRAL_UNAVAILABLE' });
}

/**
 * 0604 family referrals, staff side (Marketing > Referrals). Each read and change is one protected definer call that
 * re-proves the direct human subject and the live crm.referral.* permission. Recording a reward moves no money or credit.
 */
@Injectable()
export class SchoolReferralsService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async read(context: MembershipLifecycleContext): Promise<SchoolReferrals> {
    this.assertHuman(context, false);
    return this.verified(verifySchoolReferrals, await this.run(context, false, 'SELECT hon.read_school_referrals($1) AS data', [context.externalSubject]));
  }

  async configure(context: MembershipLifecycleContext, value: unknown): Promise<{ program: SchoolReferralProgram; replayed: boolean }> {
    this.assertHuman(context, true);
    let input;
    try { input = validateSchoolReferralProgramInput(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.verified(verifySchoolReferralProgramReceipt, await this.run(context, true, 'SELECT hon.configure_school_referral_program($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
      [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]));
  }

  async reward(context: MembershipLifecycleContext, referralId: string, value: unknown): Promise<{ referral: SchoolReferral; replayed: boolean }> {
    this.assertHuman(context, true);
    if (typeof referralId !== 'string' || !UUID.test(referralId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    let input;
    try { input = validateFamilyReferralRewardInput(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.verified(verifyFamilyReferralRewardReceipt, await this.run(context, true, 'SELECT hon.decide_family_referral_reward($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, referralId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]));
  }

  /** A database answer that fails its contract is the closed "unavailable" answer, never a raw server error. */
  private verified<T>(verify: (value: unknown) => T, data: unknown): T {
    try { return verify(data); } catch { throw new ServiceUnavailableException({ code: 'SCHOOL_REFERRAL_UNAVAILABLE' }); }
  }

  private assertHuman(context: MembershipLifecycleContext, write: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'SCHOOL_REFERRAL_FORBIDDEN' });
    }
    if (write && (typeof context.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(context.idempotencyKey))) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header (16-100 letters, digits, _ or -) is required.' });
    }
  }

  private async run(context: MembershipLifecycleContext, write: boolean, statement: string, values: unknown[]): Promise<unknown> {
    try {
      const work = async (client: PoolClient) => {
        await client.query(write ? WRITE_LIMITS : READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>(statement, values);
        if (result.rows.length !== 1) throw new Error('Unverified referral answer.');
        return result.rows[0]!.data;
      };
      const data = write ? await this.database.withTenantTransaction(context, work) : await this.database.withTenantReadOnlyTransaction(context, work);
      return data;
    } catch (error) { return translateSchoolReferralsError(error); }
  }
}
