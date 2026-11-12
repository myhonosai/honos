import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  validateSaveSchoolBrandingInput, verifySchoolBrandingRead, verifySchoolBrandingReceipt, type SchoolBrandingReceipt,
} from '@hon/contracts';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

// Exact 0268 error codes; every unknown database failure is unavailable, never success.
const ERRORS: Record<string, (code: string) => HttpException> = {
  VALIDATION_FAILED: code => new BadRequestException({ code }),
  SCHOOL_BRANDING_FORBIDDEN: code => new ForbiddenException({ code }),
  VERSION_CONFLICT: code => new ConflictException({ code, detail: 'The school branding has changed. Reload it and try again with a new Idempotency-Key.' }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different command.' }),
  IDEMPOTENCY_IN_PROGRESS: code => new ConflictException({ code, detail: 'The matching command is being processed.' }),
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && ['22023', '42501', '40001', '23505'].includes(sqlState)) throw known(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'SCHOOL_BRANDING_FORBIDDEN' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'SCHOOL_BRANDING_CONFLICT' });
  if (['22023', '22P02', '22003', '23514'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'SCHOOL_BRANDING_UNAVAILABLE' });
}

/**
 * 0268: the school's shared page branding. Each read and save is one protected definer call that re-proves the direct human
 * subject and the live school_branding.manage permission. Images are https references only: nothing here uploads, fetches or
 * proxies an image, and nothing is public.
 */
@Injectable()
export class SchoolBrandingService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async read(context: MembershipLifecycleContext): Promise<SchoolBrandingReceipt> {
    this.assertHumanContext(context, false);
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async (client: PoolClient) => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_school_page_branding($1) AS data', [context.externalSubject]);
        if (result.rows.length !== 1) throw new Error('Unverified school branding.');
        return verifySchoolBrandingRead(result.rows[0]!.data);
      });
    } catch (error) { return translate(error); }
  }

  async save(context: MembershipLifecycleContext, value: unknown): Promise<{ receipt: SchoolBrandingReceipt; replayed: boolean }> {
    this.assertHumanContext(context, true);
    let input;
    try { input = validateSaveSchoolBrandingInput(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: Record<string, unknown> }>('SELECT hon.save_school_page_branding($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
          [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        const data = result.rows[0]?.data;
        if (result.rows.length !== 1 || !data || Object.keys(data).sort().join(',') !== 'receipt,replayed' || typeof data.replayed !== 'boolean') {
          throw new Error('Unverified school branding receipt.');
        }
        // A save (or its exact replay, which carries the same expected version) produces the next version.
        const receipt = verifySchoolBrandingReceipt(data.receipt, { version: input.expectedVersion + 1 });
        return { receipt, replayed: data.replayed };
      });
    } catch (error) { return translate(error); }
  }

  private assertHumanContext(context: MembershipLifecycleContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'School branding accepts only direct human commands.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code: 'SCHOOL_BRANDING_FORBIDDEN' });
    if (!command) {
      if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
      return;
    }
    if (!context.idempotencyKey || context.idempotencyKey !== context.idempotencyKey.trim() || context.idempotencyKey.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
  }
}
