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
  validateConfirmMembershipDateRevisionInput,
  validateMembershipDateConfirmationQueueInput,
  validateMembershipDateHistoryInput,
  validateMembershipDateRevisionPreviewInput,
  verifyMembershipDateConfirmationQueue,
  verifyMembershipDateHistory,
  verifyMembershipDateRevisionPreview,
  verifyMembershipDateRevisionReceipt,
  verifySchoolMembershipStatusSummary,
  type ConfirmMembershipDateRevisionInput,
  type MembershipDateConfirmationQueue,
  type MembershipDateConfirmationQueueInput,
  type MembershipDateHistory,
  type MembershipDateRevisionPreview,
  type MembershipDateRevisionPreviewInput,
  type MembershipDateRevisionReceipt,
  type SchoolMembershipStatusSummary,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from './membership.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";

// Exact 0178 error codes; every unknown database failure is unavailable, never success.
const DATE_ERRORS: Record<string, (code: string) => HttpException> = {
  VALIDATION_FAILED: code => new BadRequestException({ code }),
  MEMBERSHIP_DATE_REVISION_FORBIDDEN: code => new ForbiddenException({ code }),
  MEMBERSHIP_RETROACTIVE_DATE_REVISION_FORBIDDEN: code => new ForbiddenException({ code, detail: 'This change affects past school days and needs the retroactive date change permission at this school.' }),
  MEMBERSHIP_DATE_HISTORY_FORBIDDEN: code => new ForbiddenException({ code }),
  MEMBERSHIP_STATUS_SUMMARY_FORBIDDEN: code => new ForbiddenException({ code }),
  BILLING_MEMBERSHIP_NOT_FOUND: code => new NotFoundException({ code, detail: 'The membership is not available in this school.' }),
  MEMBERSHIP_NOT_ACTIVE: code => new ConflictException({ code, detail: 'Only a confirmed (ACTIVE) membership can have its dates changed.' }),
  VERSION_CONFLICT: code => new ConflictException({ code, detail: 'The membership has changed. Preview again and confirm with a new Idempotency-Key.' }),
  PERIOD_VERSION_CONFLICT: code => new ConflictException({ code, detail: 'The membership dates have changed. Preview again and confirm with a new Idempotency-Key.' }),
  DATE_REVISION_PREVIEW_STALE: code => new ConflictException({ code, detail: 'The membership, its records or the school date changed after the preview. Preview again and review the result.' }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different command.' }),
  IDEMPOTENCY_IN_PROGRESS: code => new ConflictException({ code, detail: 'The matching command is being processed.' }),
  SCHOOL_TIMEZONE_INVALID: code => new ConflictException({ code, detail: 'The school timezone is not a valid IANA timezone.' }),
  DATE_REVISION_BLOCKED: code => new UnprocessableEntityException({ code, detail: 'The preview lists blocks that must be resolved before the dates can change.' }),
  DATE_SOURCE_MISMATCH: code => new UnprocessableEntityException({ code }),
  DATE_REVISION_ACKNOWLEDGEMENT_REQUIRED: code => new UnprocessableEntityException({ code, detail: 'Acknowledge exactly the warnings the preview listed.' }),
};
function translateDateError(error: unknown, forbidden: string): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = DATE_ERRORS[message];
  if (known && ['22023', '42501', 'P0002', '40001', '23505'].includes(sqlState)) throw known(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: forbidden });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'MEMBERSHIP_LIFECYCLE_CONFLICT' });
  if (['22023', '22P02', '22003', '22007', '22008'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'MEMBERSHIP_LIFECYCLE_UNAVAILABLE' });
}

/**
 * E1b-1 membership date management (0178). Every call runs one protected definer function that re-proves the direct
 * human subject and the live school-scoped permission; the runtime role has no UPDATE on memberships. A revision
 * never creates, changes, refunds, credits or cancels any payment, schedule, invoice, agreement, consent, payer,
 * price, SaaS billing record or entitlement, and never sends a communication or runs an automation.
 */
@Injectable()
export class MembershipDateRevisionService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  /** Step one: read-only preview of one current-school membership for one change kind. No Idempotency-Key, no effects. */
  async preview(context: MembershipLifecycleContext, membershipId: string, value: unknown): Promise<MembershipDateRevisionPreview> {
    this.assertHumanContext(context, 'MEMBERSHIP_DATE_REVISION_FORBIDDEN', false);
    this.assertMembershipId(membershipId);
    let input: MembershipDateRevisionPreviewInput;
    try { input = validateMembershipDateRevisionPreviewInput(value ?? {}); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.preview_membership_date_revision($1,$2::uuid,$3::jsonb) AS data',
          [context.externalSubject, membershipId, JSON.stringify(input)]);
        if (result.rows.length !== 1) throw new Error('Unverified date revision preview.');
        return verifyMembershipDateRevisionPreview(result.rows[0]!.data);
      });
    } catch (error) { return translateDateError(error, 'MEMBERSHIP_DATE_REVISION_FORBIDDEN'); }
  }

  /**
   * Step two: confirms exactly one previewed revision. The database re-derives every fact under the canonical locks,
   * refuses a stale digest, requires dates.retroactive live when a past school day changes, and records one immutable
   * revision row before the evidence-bound projection update.
   */
  async revise(context: MembershipLifecycleContext, membershipId: string, value: unknown): Promise<{ receipt: MembershipDateRevisionReceipt; replayed: boolean }> {
    this.assertHumanContext(context, 'MEMBERSHIP_DATE_REVISION_FORBIDDEN', true);
    this.assertMembershipId(membershipId);
    let input: ConfirmMembershipDateRevisionInput;
    try { input = validateConfirmMembershipDateRevisionInput(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0");
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: { receipt: unknown; replayed: boolean } }>(
          'SELECT hon.revise_membership_dates($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
          [context.externalSubject, membershipId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        const data = result.rows[0]?.data;
        if (result.rows.length !== 1 || !data || Object.keys(data).sort().join(',') !== 'receipt,replayed' || typeof data.replayed !== 'boolean') {
          throw new Error('Unverified date revision receipt.');
        }
        return { receipt: verifyMembershipDateRevisionReceipt(data.receipt, membershipId), replayed: data.replayed };
      });
    } catch (error) { return translateDateError(error, 'MEMBERSHIP_DATE_REVISION_FORBIDDEN'); }
  }

  /** Read-only confirmed date history of one current-school membership, newest first. */
  async history(context: MembershipLifecycleContext, membershipId: string, value: unknown): Promise<MembershipDateHistory> {
    this.assertHumanContext(context, 'MEMBERSHIP_DATE_HISTORY_FORBIDDEN', false);
    this.assertMembershipId(membershipId);
    try { validateMembershipDateHistoryInput(value ?? {}); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_membership_date_history($1,$2::uuid) AS data', [context.externalSubject, membershipId]);
        if (result.rows.length !== 1) throw new Error('Unverified date history.');
        return verifyMembershipDateHistory(result.rows[0]!.data, membershipId);
      });
    } catch (error) { return translateDateError(error, 'MEMBERSHIP_DATE_HISTORY_FORBIDDEN'); }
  }

  /** E1b-D7: ACTIVE memberships with no confirmed dates, oldest first, for individual confirmation. Never bulk. */
  async confirmationQueue(context: MembershipLifecycleContext, value: unknown): Promise<MembershipDateConfirmationQueue> {
    this.assertHumanContext(context, 'MEMBERSHIP_DATE_REVISION_FORBIDDEN', false);
    let input: MembershipDateConfirmationQueueInput;
    try { input = validateMembershipDateConfirmationQueueInput(value ?? {}); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_membership_date_confirmation_queue($1,$2::jsonb) AS data',
          [context.externalSubject, JSON.stringify(input)]);
        if (result.rows.length !== 1) throw new Error('Unverified date confirmation queue.');
        return verifyMembershipDateConfirmationQueue(result.rows[0]!.data);
      });
    } catch (error) { return translateDateError(error, 'MEMBERSHIP_DATE_REVISION_FORBIDDEN'); }
  }

  /** Lifecycle totals with lifecycle-ACTIVE split by SCHEDULED, IN_EFFECT, ENDED and UNDATED. No money, names or reasons. */
  async statusSummary(context: MembershipLifecycleContext): Promise<SchoolMembershipStatusSummary> {
    this.assertHumanContext(context, 'MEMBERSHIP_STATUS_SUMMARY_FORBIDDEN', false);
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_school_membership_status_summary($1) AS data', [context.externalSubject]);
        if (result.rows.length !== 1) throw new Error('Unverified membership status summary.');
        return verifySchoolMembershipStatusSummary(result.rows[0]!.data, { organizationId: context.organizationId, schoolId: context.schoolId });
      });
    } catch (error) { return translateDateError(error, 'MEMBERSHIP_STATUS_SUMMARY_FORBIDDEN'); }
  }

  private assertMembershipId(membershipId: string): void {
    if (!UUID.test(membershipId)) throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'membershipId must be a UUID.' });
  }

  private assertHumanContext(context: MembershipLifecycleContext, forbidden: string, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Membership dates are managed only by a direct human operator.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code: forbidden });
    if (!command) {
      if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
      return;
    }
    if (!context.idempotencyKey || context.idempotencyKey !== context.idempotencyKey.trim() || context.idempotencyKey.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required to change membership dates.' });
    }
  }
}
