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
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { tierIncludesFeature } from '@hon/config';
import {
  isLegacyMembershipActivationInput,
  MEMBERSHIP_ACTIVATION_TWO_STEP_REQUIRED,
  validateConfirmMembershipActivationInput,
  validateMembershipActivationPreviewInput,
  verifyMembershipActivationPreview,
  verifyMembershipActivationReceipt,
  type CancelMembershipInput,
  type CancelledMembershipSummary,
  type CommandContext,
  type ConfirmMembershipActivationInput,
  type CreateMembershipInput,
  type HonTier,
  type MembershipActivationContext,
  type MembershipActivationPreview,
  type MembershipActivationPreviewInput,
  type MembershipActivationReceipt,
  type MembershipSummary,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANCEL_INPUT_KEYS = new Set(['expectedVersion', 'cancellationReason', 'effectiveAt']);
const MAX_CANCELLATION_REASON_LENGTH = 1000;
const EFFECTIVE_AT_PAST_TOLERANCE_MS = 5 * 60 * 1000;
const TIMEZONE_QUALIFIED_ISO_8601 = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,9})?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const CANCELLATION_KEYS = ['id', 'billingAccountId', 'participantPersonId', 'planCode', 'state', 'version', 'cancellationReason', 'effectiveAt', 'createdAt'];

/** Lifecycle commands run inside 0177 definer functions that re-prove this direct human subject live. */
export type MembershipLifecycleContext = CommandContext & { externalSubject: string };

export interface CreateMembershipResult {
  membership: MembershipSummary;
  replayed: boolean;
}

function fingerprint(input: CreateMembershipInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

// Exact 0177 error codes; every unknown database failure is unavailable, never success.
const LIFECYCLE_ERRORS: Record<string, (code: string) => HttpException> = {
  VALIDATION_FAILED: code => new BadRequestException({ code }),
  MEMBERSHIP_ACTIVATION_FORBIDDEN: code => new ForbiddenException({ code }),
  ACTIVATION_OVERRIDE_FORBIDDEN: code => new ForbiddenException({ code }),
  MEMBERSHIP_CANCELLATION_FORBIDDEN: code => new ForbiddenException({ code }),
  BILLING_MEMBERSHIP_NOT_FOUND: code => new NotFoundException({ code, detail: 'The membership is not available in this school.' }),
  MEMBERSHIP_NOT_DRAFT: code => new ConflictException({ code, detail: 'Only a DRAFT membership can be activated.' }),
  MEMBERSHIP_NOT_ACTIVE: code => new ConflictException({ code, detail: 'Only an ACTIVE membership can be directly cancelled.' }),
  VERSION_CONFLICT: code => new ConflictException({ code, detail: 'The membership has changed. Refresh it and retry with its current version and a new Idempotency-Key.' }),
  ACTIVATION_PREVIEW_STALE: code => new ConflictException({ code, detail: 'The membership, its records or the school date changed after the preview. Preview again and review the result.' }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different command.' }),
  IDEMPOTENCY_IN_PROGRESS: code => new ConflictException({ code, detail: 'The matching command is being processed.' }),
  SCHOOL_TIMEZONE_INVALID: code => new ConflictException({ code, detail: 'The school timezone is not a valid IANA timezone.' }),
  ACTIVATION_BLOCKED: code => new UnprocessableEntityException({ code, detail: 'The preview lists blocks that must be fixed before activation.' }),
  DATE_SOURCE_MISMATCH: code => new UnprocessableEntityException({ code }),
  ACTIVATION_ACKNOWLEDGEMENT_REQUIRED: code => new UnprocessableEntityException({ code, detail: 'Acknowledge exactly the warnings the preview listed.' }),
  ACTIVATION_OVERRIDE_REQUIRED: code => new UnprocessableEntityException({ code, detail: 'Document exactly the overridable warnings the preview listed.' }),
  ADULT_VERIFICATION_NOT_APPLICABLE: code => new UnprocessableEntityException({ code }),
  ACTIVATION_REASON_TEXT_REQUIRED: code => new UnprocessableEntityException({ code, detail: 'A reason text is required for this activation.' }),
};
function assertSubject(context: { externalSubject?: unknown }, code: string): void {
  const subject = context.externalSubject;
  if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code });
}
function translateLifecycleError(error: unknown, forbidden: string): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = LIFECYCLE_ERRORS[message];
  if (known && ['22023', '42501', 'P0002', '40001', '23505'].includes(sqlState)) throw known(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: forbidden });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'MEMBERSHIP_LIFECYCLE_CONFLICT' });
  if (['22023', '22P02', '22003', '22007', '22008'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'MEMBERSHIP_LIFECYCLE_UNAVAILABLE' });
}

@Injectable()
export class MembershipService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async createDraft(context: CommandContext, input: CreateMembershipInput): Promise<CreateMembershipResult> {
    if (input.termStartedAt && input.termEndsAt && new Date(input.termEndsAt) <= new Date(input.termStartedAt)) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Membership term end must be later than its start.' });
    }
    const requestFingerprint = fingerprint(input);
    return this.database.withTenantTransaction(context, async (client) => {
      const entitlement = await client.query<{ tier: HonTier }>(
        'SELECT tier FROM hon.read_current_organization_entitlement()',
      );
      if (!entitlement.rows[0] || !tierIncludesFeature(entitlement.rows[0].tier, 'billing.foundation')) {
        throw new ForbiddenException({ code: 'TIER_ENTITLEMENT_REQUIRED', detail: 'An active HON billing entitlement is required for membership drafts.' });
      }
      const reservation = await client.query<{ id: string }>(
        `INSERT INTO hon.idempotency_records (organization_id, school_id, principal_id, idempotency_key, request_fingerprint, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', now() + interval '24 hours')
         ON CONFLICT (organization_id, school_id, principal_id, idempotency_key) DO NOTHING RETURNING id`,
        [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey, requestFingerprint],
      );
      if (!reservation.rowCount) {
        const existing = await client.query<{ request_fingerprint: string; status: 'IN_PROGRESS' | 'COMPLETED'; response_body: MembershipSummary | null }>(
          `SELECT request_fingerprint, status, response_body FROM hon.idempotency_records
           WHERE organization_id = $1 AND school_id = $2 AND principal_id = $3 AND idempotency_key = $4 FOR UPDATE`,
          [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey],
        );
        const record = existing.rows[0];
        if (!record) throw new Error('HON membership idempotency record unexpectedly missing.');
        if (record.request_fingerprint !== requestFingerprint) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', detail: 'The idempotency key was already used for another membership draft.' });
        if (record.status === 'COMPLETED' && record.response_body) return { membership: record.response_body, replayed: true };
        throw new ConflictException({ code: 'IDEMPOTENCY_IN_PROGRESS', detail: 'The matching membership draft is being processed.' });
      }

      const relatedRecords = await client.query<{ billing_account_id: string; participant_id: string; currency: string }>(
        `SELECT account.id AS billing_account_id, participant.id AS participant_id, account.currency
         FROM hon.billing_accounts AS account
         JOIN hon.people AS participant ON participant.id = $2::uuid
           AND participant.organization_id = account.organization_id AND participant.school_id = account.school_id
         WHERE account.id = $1::uuid AND account.organization_id = $3 AND account.school_id = $4`,
        [input.billingAccountId, input.participantPersonId, context.organizationId, context.schoolId],
      );
      const related = relatedRecords.rows[0];
      if (!related) throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Billing account and participant must both belong to this school.' });

      const inserted = await client.query<MembershipSummary>(
        // 0177: the runtime may insert only these DRAFT columns; state DRAFT and version 1 are the column defaults.
        `INSERT INTO hon.memberships (
           organization_id, school_id, billing_account_id, participant_person_id, plan_code, term_started_at, term_ends_at
         ) VALUES ($1, $2, $3::uuid, $4::uuid, $5, $6::timestamptz, $7::timestamptz)
         RETURNING id, billing_account_id AS "billingAccountId", participant_person_id AS "participantPersonId", plan_code AS "planCode", state, version, created_at AS "createdAt"`,
        [context.organizationId, context.schoolId, input.billingAccountId, input.participantPersonId, input.planCode.trim(), input.termStartedAt ?? null, input.termEndsAt ?? null],
      );
      const membership = inserted.rows[0];
      if (!membership) throw new Error('HON membership draft insert did not return a record.');
      if (input.paymentSchedule) {
        const schedule = await client.query<{ id: string }>(
          `INSERT INTO hon.membership_payment_schedules (
             organization_id, school_id, membership_id, frequency, amount_minor, currency, next_charge_at, auto_renew
           ) VALUES ($1, $2, $3::uuid, $4, $5, $6, $7::timestamptz, $8) RETURNING id`,
          [context.organizationId, context.schoolId, membership.id, input.paymentSchedule.frequency, input.paymentSchedule.amountMinor, related.currency, input.paymentSchedule.nextChargeAt ?? null, input.paymentSchedule.autoRenew],
        );
        membership.paymentScheduleId = schedule.rows[0]?.id;
      }
      const payload = { membershipId: membership.id, planCode: membership.planCode, state: membership.state, paymentScheduleId: membership.paymentScheduleId ?? null };
      await client.query(
        `INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id, prior_state, next_state, result, request_id, correlation_id, occurred_at)
         VALUES ($1, $2, $3, $4, 'billing.membership.create', 'MEMBERSHIP', $5::uuid, NULL, $6::jsonb, 'SUCCEEDED', $7::uuid, $8::uuid, now())`,
        [context.organizationId, context.schoolId, context.principalId, context.source, membership.id, JSON.stringify(payload), context.requestId, context.correlationId],
      );
      await client.query(
        `INSERT INTO hon.outbox_events (id, organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version, correlation_id, causation_id, payload)
         VALUES ($1::uuid, $2, $3, 'billing.membership.drafted', 1, 'MEMBERSHIP', $4::uuid, $5, $6::uuid, $7::uuid, $8::jsonb)`,
        [randomUUID(), context.organizationId, context.schoolId, membership.id, membership.version, context.correlationId, context.requestId, JSON.stringify(payload)],
      );
      await client.query(
        `UPDATE hon.idempotency_records SET status = 'COMPLETED', response_status = 201, response_body = $5::jsonb
         WHERE organization_id = $1 AND school_id = $2 AND principal_id = $3 AND idempotency_key = $4`,
        [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey, JSON.stringify(membership)],
      );
      return { membership, replayed: false };
    });
  }

  /** Only lifecycle state/version for one known RLS-visible ID. No related joins or effects. */
  async readActivationContext(context: CommandContext, membershipId: string): Promise<MembershipActivationContext> {
    this.assertHumanActivationContext(context, false);
    if (!UUID.test(membershipId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    return this.database.withTenantReadOnlyTransaction(context, async client => {
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'");
      await this.assertLiveActivationAuthority(client, context);
      const result = await client.query<{ state: MembershipSummary['state']; version: number }>(
        `SELECT state::text AS state, version FROM hon.memberships
         WHERE id = $1::uuid AND organization_id = $2::uuid AND school_id = $3::uuid LIMIT 1`,
        [membershipId, context.organizationId, context.schoolId],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundException({ code: 'BILLING_MEMBERSHIP_NOT_FOUND', detail: 'The membership is not available in this school.' });
      return { organizationId: context.organizationId, schoolId: context.schoolId, membershipId, state: row.state, version: row.version };
    });
  }

  private async assertLiveActivationAuthority(client: PoolClient, context: CommandContext): Promise<void> {
    const result = await client.query<{ authorized: boolean; tier: HonTier | null }>(
      `SELECT hon.principal_has_school_permission($1::uuid, $2::uuid, $3::uuid, 'billing.membership.activate') AS authorized,
              entitlement.tier
       FROM (SELECT 1) AS boundary LEFT JOIN hon.read_current_organization_entitlement() AS entitlement ON true`,
      [context.principalId, context.organizationId, context.schoolId],
    );
    const row = result.rows[0];
    if (!row?.authorized) throw new ForbiddenException({ code: 'MEMBERSHIP_ACTIVATION_FORBIDDEN', detail: 'Current membership activation permission is required.' });
    if (!row.tier || !tierIncludesFeature(row.tier, 'billing.foundation')) {
      throw new ForbiddenException({ code: 'TIER_ENTITLEMENT_REQUIRED', detail: 'An active HON billing entitlement is required.' });
    }
  }

  /**
   * Step one of activation (0177): a read-only server preview of exactly one current-school membership. Returns the
   * evaluated facts, warnings needing acknowledgement, available overrides, blocks, suggested and proposed dates in
   * the school timezone and a digest. Writes nothing; the digest is never proof of authorization.
   */
  async previewActivation(context: MembershipLifecycleContext, membershipId: string, value: unknown): Promise<MembershipActivationPreview> {
    this.assertHumanActivationContext(context, false);
    assertSubject(context, 'MEMBERSHIP_ACTIVATION_FORBIDDEN');
    if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    if (!UUID.test(membershipId)) throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'membershipId must be a UUID.' });
    let input: MembershipActivationPreviewInput;
    try { input = validateMembershipActivationPreviewInput(value ?? {}); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.preview_school_membership_activation($1,$2::uuid,$3::jsonb) AS data',
          [context.externalSubject, membershipId, JSON.stringify(input)]);
        if (result.rows.length !== 1) throw new Error('Unverified activation preview.');
        return verifyMembershipActivationPreview(result.rows[0]!.data);
      });
    } catch (error) { return translateLifecycleError(error, 'MEMBERSHIP_ACTIVATION_FORBIDDEN'); }
  }

  /**
   * Step two: confirms one previewed DRAFT. The database re-derives every fact under the canonical locks, refuses a
   * stale digest, re-checks live school-scoped authority, and records one decision and the initial effective period.
   * A pre-0177 `{ expectedVersion }` body fails closed. No payment, provider, agreement, consent, schedule, invoice,
   * communication, delegated, Action Engine or AI work occurs.
   */
  async activate(context: MembershipLifecycleContext, membershipId: string, value: unknown): Promise<{ membership: MembershipActivationReceipt; replayed: boolean }> {
    this.assertHumanActivationContext(context);
    assertSubject(context, 'MEMBERSHIP_ACTIVATION_FORBIDDEN');
    if (!UUID.test(membershipId)) throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'membershipId must be a UUID.' });
    if (isLegacyMembershipActivationInput(value)) {
      throw new BadRequestException({ code: MEMBERSHIP_ACTIVATION_TWO_STEP_REQUIRED,
        detail: 'Membership activation now requires a server preview and an explicit confirmation of dates, warnings and reason.' });
    }
    let input: ConfirmMembershipActivationInput;
    try { input = validateConfirmMembershipActivationInput(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0");
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: { receipt: unknown; replayed: boolean } }>(
          'SELECT hon.activate_school_membership($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
          [context.externalSubject, membershipId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        const data = result.rows[0]?.data;
        if (result.rows.length !== 1 || !data || Object.keys(data).sort().join(',') !== 'receipt,replayed' || typeof data.replayed !== 'boolean') {
          throw new Error('Unverified activation receipt.');
        }
        return { membership: verifyMembershipActivationReceipt(data.receipt, membershipId), replayed: data.replayed };
      });
    } catch (error) { return translateLifecycleError(error, 'MEMBERSHIP_ACTIVATION_FORBIDDEN'); }
  }

  /**
   * Cancels exactly one current-school ACTIVE membership through the 0177 protected function. The public contract,
   * response and request fingerprint are unchanged; authority is now re-checked live after every wait. This direct
   * human command is limited to ACTIVE-to-CANCELLED and does not schedule a future transition. `effectiveAt` is
   * evidenced cancellation metadata only. No payment, provider, refund, credit, waiver, proration, billing-account,
   * payment-schedule, invoice, attendance, booking, communication, AI, delegation, or Action Engine work occurs here.
   */
  async cancel(
    context: MembershipLifecycleContext,
    membershipId: string,
    input: CancelMembershipInput,
  ): Promise<{ membership: CancelledMembershipSummary; replayed: boolean }> {
    this.assertHumanCancellationContext(context);
    assertSubject(context, 'MEMBERSHIP_CANCELLATION_FORBIDDEN');
    if (!UUID.test(membershipId)) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'membershipId must be a UUID.' });
    }
    const cancellation = this.normalizeCancellationInput(input);
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0");
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: { membership: CancelledMembershipSummary; replayed: boolean } }>(
          'SELECT hon.cancel_school_membership($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
          [context.externalSubject, membershipId, JSON.stringify(cancellation), context.idempotencyKey, context.requestId, context.correlationId]);
        const data = result.rows[0]?.data;
        const membership = data?.membership;
        if (result.rows.length !== 1 || !data || typeof data.replayed !== 'boolean' || !membership || typeof membership !== 'object'
          || Object.keys(membership).some(key => !CANCELLATION_KEYS.includes(key)) || membership.state !== 'CANCELLED'
          || membership.id.toLowerCase() !== membershipId.toLowerCase() || !Number.isSafeInteger(membership.version)) {
          throw new Error('Unverified cancellation receipt.');
        }
        return { membership, replayed: data.replayed };
      });
    } catch (error) { return translateLifecycleError(error, 'MEMBERSHIP_CANCELLATION_FORBIDDEN'); }
  }
  private assertHumanCancellationContext(context: MembershipLifecycleContext): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI') {
      throw new ForbiddenException({
        code: 'HUMAN_COMMAND_REQUIRED',
        detail: 'Membership cancellation accepts only HUMAN_USER commands from HUMAN_UI.',
      });
    }
    if (context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({
        code: 'HUMAN_COMMAND_REQUIRED',
        detail: 'Membership cancellation cannot be delegated or executed through the Action Engine.',
      });
    }
    if (
      !context.idempotencyKey
      || context.idempotencyKey !== context.idempotencyKey.trim()
      || context.idempotencyKey.length > 200
    ) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: 'A bounded Idempotency-Key is required for membership cancellation.',
      });
    }
  }

  private normalizeCancellationInput(input: CancelMembershipInput): CancelMembershipInput {
    for (const key of Object.keys(input as unknown as Record<string, unknown>)) {
      if (!CANCEL_INPUT_KEYS.has(key)) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          detail: `Unsupported membership cancellation field: ${key}.`,
        });
      }
    }
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        detail: 'expectedVersion must be a positive whole number.',
      });
    }
    if (
      typeof input.cancellationReason !== 'string'
      || input.cancellationReason.length > MAX_CANCELLATION_REASON_LENGTH
      || input.cancellationReason.trim().length === 0
      || /[\u0000-\u001f\u007f]/.test(input.cancellationReason)
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        detail: 'cancellationReason must be non-blank, control-character-free, and at most 1000 characters.',
      });
    }
    const cancellationReason = input.cancellationReason.trim();
    if (input.effectiveAt === undefined) {
      return { expectedVersion: input.expectedVersion, cancellationReason };
    }
    if (typeof input.effectiveAt !== 'string' || input.effectiveAt.length > 40) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        detail: 'effectiveAt must be a bounded timezone-qualified ISO 8601 timestamp when provided.',
      });
    }
    const match = TIMEZONE_QUALIFIED_ISO_8601.exec(input.effectiveAt);
    if (!match) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        detail: 'effectiveAt must be a bounded timezone-qualified ISO 8601 timestamp when provided.',
      });
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const daysInMonth = year >= 1 && month >= 1 && month <= 12
      ? new Date(Date.UTC(year, month, 0)).getUTCDate()
      : 0;
    const effectiveAtMs = Date.parse(input.effectiveAt);
    if (day < 1 || day > daysInMonth || Number.isNaN(effectiveAtMs)) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        detail: 'effectiveAt must be a valid timezone-qualified ISO 8601 timestamp when provided.',
      });
    }
    // Five minutes permits normal operator/client clock skew but rejects stale
    // historical effective timestamps. Future timestamps remain evidence only;
    // this direct endpoint never schedules a pending cancellation.
    if (effectiveAtMs < Date.now() - EFFECTIVE_AT_PAST_TOLERANCE_MS) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        detail: 'effectiveAt must not be more than five minutes in the past.',
      });
    }
    return {
      expectedVersion: input.expectedVersion,
      cancellationReason,
      effectiveAt: input.effectiveAt,
    };
  }

  private assertHumanActivationContext(context: CommandContext & { externalSubject?: string }, requireKey = true): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI') {
      throw new ForbiddenException({
        code: 'HUMAN_COMMAND_REQUIRED',
        detail: 'Membership activation accepts only HUMAN_USER commands from HUMAN_UI.',
      });
    }
    if (context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({
        code: 'HUMAN_COMMAND_REQUIRED',
        detail: 'Membership activation cannot be delegated or executed through the Action Engine.',
      });
    }
    if (
      requireKey && (!context.idempotencyKey
      || context.idempotencyKey !== context.idempotencyKey.trim()
      || context.idempotencyKey.length > 200)
    ) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: 'A bounded Idempotency-Key is required for membership activation.',
      });
    }
  }
}
