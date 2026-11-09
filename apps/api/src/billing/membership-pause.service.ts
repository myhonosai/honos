import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  validatePauseMembershipInput,
  validateRecordMembershipRefundInput,
  validateResumeMembershipInput,
  validateSetSchoolMembershipPausePolicyInput,
  verifyMembershipPauseReceipt,
  verifyMembershipPausesAndRefunds,
  verifyMembershipRefundRecord,
  verifySchoolMembershipPausePolicy,
  verifySchoolMembershipPausePolicyRead,
  type MembershipPauseReceipt,
  type MembershipPausesAndRefunds,
  type MembershipRefundRecord,
  type SchoolMembershipPausePolicy,
  type SchoolMembershipPausePolicyRead,
} from '@hon/contracts';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from './membership.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

// Exact 0224 error codes; every unknown database failure is unavailable, never success.
const PAUSE_ERRORS: Record<string, (code: string) => HttpException> = {
  VALIDATION_FAILED: code => new BadRequestException({ code }),
  MEMBERSHIP_PAUSE_FORBIDDEN: code => new ForbiddenException({ code }),
  MEMBERSHIP_PAUSE_POLICY_FORBIDDEN: code => new ForbiddenException({ code }),
  MEMBERSHIP_REFUND_RECORD_FORBIDDEN: code => new ForbiddenException({ code }),
  MEMBERSHIP_PAUSE_HISTORY_FORBIDDEN: code => new ForbiddenException({ code }),
  BILLING_MEMBERSHIP_NOT_FOUND: code => new NotFoundException({ code, detail: 'The membership is not available in this school.' }),
  MEMBERSHIP_NOT_ACTIVE: code => new ConflictException({ code, detail: 'Only an ACTIVE membership can be paused.' }),
  MEMBERSHIP_NOT_PAUSED: code => new ConflictException({ code, detail: 'Only a paused membership can be resumed.' }),
  MEMBERSHIP_NOT_CANCELLED: code => new ConflictException({ code, detail: 'A refund can be recorded only for a cancelled membership.' }),
  MEMBERSHIP_PAUSE_NOT_OFFERED: code => new ConflictException({ code, detail: 'This school has not turned on membership pauses.' }),
  MEMBERSHIP_PAUSE_TOO_LONG: code => new UnprocessableEntityException({ code, detail: 'The resume date must be after today and within the school\'s maximum pause length.' }),
  MEMBERSHIP_PAUSE_YEARLY_LIMIT: code => new UnprocessableEntityException({ code, detail: 'This pause would exceed the school\'s paused days per year.' }),
  MEMBERSHIP_PAUSE_REQUIRES_BILLING_ARRANGEMENT: code => new ConflictException({ code, detail: 'This membership has an active payment schedule, so it cannot be paused yet.' }),
  MEMBERSHIP_PAUSE_EVIDENCE_MISSING: code => new ConflictException({ code, detail: 'This membership was paused outside HON and has no pause record to close.' }),
  VERSION_CONFLICT: code => new ConflictException({ code, detail: 'The record has changed. Reload it and try again with a new Idempotency-Key.' }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different command.' }),
  IDEMPOTENCY_IN_PROGRESS: code => new ConflictException({ code, detail: 'The matching command is being processed.' }),
  SCHOOL_TIMEZONE_INVALID: code => new ConflictException({ code, detail: 'The school timezone is not a valid IANA timezone.' }),
};
function translatePauseError(error: unknown, forbidden: string): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = PAUSE_ERRORS[message];
  if (known && ['22023', '42501', 'P0002', '40001', '23505'].includes(sqlState)) throw known(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: forbidden });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'MEMBERSHIP_LIFECYCLE_CONFLICT' });
  if (['22023', '22P02', '22003', '22007', '22008'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'MEMBERSHIP_LIFECYCLE_UNAVAILABLE' });
}

/**
 * Membership pause, resume and manual refund records (0224). Each call runs one protected definer function that
 * re-proves the direct human subject and the live school-scoped permission; the runtime role has no table privilege on
 * the pause, policy or refund tables and no UPDATE on memberships. Nothing here charges, schedules, invoices, refunds
 * through a provider, sends a communication or runs an automation.
 */
@Injectable()
export class MembershipPauseService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async readPolicy(context: MembershipLifecycleContext): Promise<SchoolMembershipPausePolicyRead> {
    this.assertHumanContext(context, 'MEMBERSHIP_PAUSE_POLICY_FORBIDDEN', false);
    return this.read(context, 'MEMBERSHIP_PAUSE_POLICY_FORBIDDEN', async client => {
      const result = await client.query<{ data: unknown }>('SELECT hon.read_school_membership_pause_policy($1) AS data', [context.externalSubject]);
      if (result.rows.length !== 1) throw new Error('Unverified pause policy.');
      return verifySchoolMembershipPausePolicyRead(result.rows[0]!.data);
    });
  }

  async setPolicy(context: MembershipLifecycleContext, value: unknown): Promise<{ policy: SchoolMembershipPausePolicy; replayed: boolean }> {
    this.assertHumanContext(context, 'MEMBERSHIP_PAUSE_POLICY_FORBIDDEN', true);
    const input = this.validated(() => validateSetSchoolMembershipPausePolicyInput(value));
    return this.write(context, 'MEMBERSHIP_PAUSE_POLICY_FORBIDDEN', 'policy',
      'SELECT hon.set_school_membership_pause_policy($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
      [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifySchoolMembershipPausePolicy(data))
      .then(({ value: policy, replayed }) => ({ policy, replayed }));
  }

  async pause(context: MembershipLifecycleContext, membershipId: string, value: unknown): Promise<{ pause: MembershipPauseReceipt; replayed: boolean }> {
    this.assertHumanContext(context, 'MEMBERSHIP_PAUSE_FORBIDDEN', true);
    this.assertMembershipId(membershipId);
    const input = this.validated(() => validatePauseMembershipInput(value));
    return this.write(context, 'MEMBERSHIP_PAUSE_FORBIDDEN', 'pause',
      'SELECT hon.pause_school_membership($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, membershipId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifyMembershipPauseReceipt(data, membershipId, 'FROZEN'))
      .then(({ value: pause, replayed }) => ({ pause, replayed }));
  }

  async resume(context: MembershipLifecycleContext, membershipId: string, value: unknown): Promise<{ pause: MembershipPauseReceipt; replayed: boolean }> {
    this.assertHumanContext(context, 'MEMBERSHIP_PAUSE_FORBIDDEN', true);
    this.assertMembershipId(membershipId);
    const input = this.validated(() => validateResumeMembershipInput(value));
    return this.write(context, 'MEMBERSHIP_PAUSE_FORBIDDEN', 'pause',
      'SELECT hon.resume_school_membership($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, membershipId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifyMembershipPauseReceipt(data, membershipId, 'ACTIVE'))
      .then(({ value: pause, replayed }) => ({ pause, replayed }));
  }

  async recordRefund(context: MembershipLifecycleContext, membershipId: string, value: unknown): Promise<{ refund: MembershipRefundRecord; replayed: boolean }> {
    this.assertHumanContext(context, 'MEMBERSHIP_REFUND_RECORD_FORBIDDEN', true);
    this.assertMembershipId(membershipId);
    const input = this.validated(() => validateRecordMembershipRefundInput(value));
    return this.write(context, 'MEMBERSHIP_REFUND_RECORD_FORBIDDEN', 'refund',
      'SELECT hon.record_membership_refund($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, membershipId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      data => verifyMembershipRefundRecord(data, membershipId))
      .then(({ value: refund, replayed }) => ({ refund, replayed }));
  }

  async history(context: MembershipLifecycleContext, membershipId: string): Promise<MembershipPausesAndRefunds> {
    this.assertHumanContext(context, 'MEMBERSHIP_PAUSE_HISTORY_FORBIDDEN', false);
    this.assertMembershipId(membershipId);
    return this.read(context, 'MEMBERSHIP_PAUSE_HISTORY_FORBIDDEN', async client => {
      const result = await client.query<{ data: unknown }>('SELECT hon.read_membership_pauses_and_refunds($1,$2::uuid) AS data',
        [context.externalSubject, membershipId]);
      if (result.rows.length !== 1) throw new Error('Unverified pause history.');
      return verifyMembershipPausesAndRefunds(result.rows[0]!.data, membershipId);
    });
  }

  private async read<T>(context: MembershipLifecycleContext, forbidden: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        return run(client);
      });
    } catch (error) { return translatePauseError(error, forbidden); }
  }

  private async write<T>(context: MembershipLifecycleContext, forbidden: string, key: string, statement: string, values: unknown[],
    verify: (data: unknown) => T): Promise<{ value: T; replayed: boolean }> {
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: Record<string, unknown> }>(statement, values);
        const data = result.rows[0]?.data;
        if (result.rows.length !== 1 || !data || Object.keys(data).sort().join(',') !== [key, 'replayed'].sort().join(',') || typeof data.replayed !== 'boolean') {
          throw new Error('Unverified membership pause receipt.');
        }
        return { value: verify(data[key]), replayed: data.replayed };
      });
    } catch (error) { return translatePauseError(error, forbidden); }
  }

  private validated<T>(run: () => T): T {
    try { return run(); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
  }

  private assertMembershipId(membershipId: string): void {
    if (!UUID.test(membershipId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  }

  private assertHumanContext(context: MembershipLifecycleContext, forbidden: string, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Membership pauses and refund records accept only direct human commands.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code: forbidden });
    if (!command) {
      if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
      return;
    }
    if (!context.idempotencyKey || context.idempotencyKey !== context.idempotencyKey.trim() || context.idempotencyKey.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
  }
}
