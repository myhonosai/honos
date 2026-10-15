import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { tierIncludesFeature } from '@hon/config';
import type {
  ActivateMembershipInput,
  ActivatedMembershipSummary,
  CommandContext,
  CreateMembershipInput,
  HonTier,
  MembershipSummary,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVATE_INPUT_KEYS = new Set(['expectedVersion']);

type MembershipActivationRow = {
  id: string;
  billingAccountId: string;
  participantPersonId: string;
  planCode: string;
  state: string;
  version: number;
  createdAt: Date | string;
};

type ActivationIdempotencyRecord = {
  request_fingerprint: string;
  status: 'IN_PROGRESS' | 'COMPLETED';
  response_body: ActivatedMembershipSummary | null;
};

export interface CreateMembershipResult {
  membership: MembershipSummary;
  replayed: boolean;
}

function fingerprint(input: CreateMembershipInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function summarizeActivated(row: MembershipActivationRow): ActivatedMembershipSummary {
  if (row.state !== 'ACTIVE') {
    throw new Error('HON membership activation query returned an invalid membership state.');
  }
  return {
    id: row.id,
    billingAccountId: row.billingAccountId,
    participantPersonId: row.participantPersonId,
    planCode: row.planCode,
    state: 'ACTIVE',
    version: row.version,
    createdAt: timestamp(row.createdAt),
  };
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
        `SELECT tier::text AS tier FROM hon.organization_entitlements
         WHERE organization_id = $1 AND status = 'ACTIVE' AND effective_from <= now()
           AND (effective_until IS NULL OR effective_until > now())`,
        [context.organizationId],
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
        `INSERT INTO hon.memberships (
           organization_id, school_id, billing_account_id, participant_person_id, plan_code, state, term_started_at, term_ends_at
         ) VALUES ($1, $2, $3::uuid, $4::uuid, $5, 'DRAFT', $6::timestamptz, $7::timestamptz)
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

  /**
   * Activates exactly one RLS-visible DRAFT membership. This transition neither
   * creates nor requires an invoice, and deliberately performs no payment,
   * provider, pricing, term, schedule, concession, attendance, booking,
   * communication, AI, delegated, or Action Engine work.
   */
  async activate(
    context: CommandContext,
    membershipId: string,
    input: ActivateMembershipInput,
  ): Promise<{ membership: ActivatedMembershipSummary; replayed: boolean }> {
    this.assertHumanActivationContext(context);
    if (!UUID.test(membershipId)) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'membershipId must be a UUID.' });
    }
    this.assertActivationInput(input);
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({
        operation: 'billing.membership.activate',
        membershipId,
        expectedVersion: input.expectedVersion,
      }))
      .digest('hex');

    return this.database.withTenantTransaction(context, async (client) => {
      // This ID-only locked lookup relies on transaction-local RLS. A record in
      // another school is intentionally indistinguishable from a missing one.
      const currentResult = await client.query<MembershipActivationRow>(
        `SELECT
           id,
           billing_account_id AS "billingAccountId",
           participant_person_id AS "participantPersonId",
           plan_code AS "planCode",
           state::text AS state,
           version,
           created_at AS "createdAt"
         FROM hon.memberships
         WHERE id = $1::uuid
         FOR UPDATE`,
        [membershipId],
      );
      const current = currentResult.rows[0];
      if (!current) {
        throw new NotFoundException({
          code: 'BILLING_MEMBERSHIP_NOT_FOUND',
          detail: 'The membership is not available in this school.',
        });
      }

      const reservation = await client.query<{ id: string }>(
        `INSERT INTO hon.idempotency_records (
           organization_id, school_id, principal_id, idempotency_key,
           request_fingerprint, status, expires_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'IN_PROGRESS', now() + interval '24 hours')
         ON CONFLICT (organization_id, school_id, principal_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [
          context.organizationId,
          context.schoolId,
          context.principalId,
          context.idempotencyKey,
          requestFingerprint,
        ],
      );
      if (!reservation.rowCount) {
        const existing = await client.query<ActivationIdempotencyRecord>(
          `SELECT request_fingerprint, status, response_body
           FROM hon.idempotency_records
           WHERE organization_id = $1::uuid
             AND school_id = $2::uuid
             AND principal_id = $3::uuid
             AND idempotency_key = $4
           FOR UPDATE`,
          [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey],
        );
        const record = existing.rows[0];
        if (!record) throw new Error('HON membership activation idempotency record unexpectedly missing.');
        if (record.request_fingerprint !== requestFingerprint) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            detail: 'The idempotency key was already used for a different membership activation command.',
          });
        }
        if (record.status === 'COMPLETED' && record.response_body) {
          return { membership: record.response_body, replayed: true };
        }
        throw new ConflictException({
          code: 'IDEMPOTENCY_IN_PROGRESS',
          detail: 'The matching membership activation command is being processed.',
        });
      }

      if (current.state !== 'DRAFT') {
        throw new ConflictException({
          code: 'MEMBERSHIP_NOT_DRAFT',
          detail: 'Only a DRAFT membership can be activated.',
        });
      }
      if (current.version !== input.expectedVersion) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          detail: 'The membership has changed. Refresh it and retry with its current version and a new Idempotency-Key.',
        });
      }

      const updatedResult = await client.query<MembershipActivationRow>(
        `UPDATE hon.memberships
         SET state = 'ACTIVE'::hon.membership_state,
             version = version + 1
         WHERE id = $1::uuid
           AND state = 'DRAFT'::hon.membership_state
           AND version = $2::integer
         RETURNING
           id,
           billing_account_id AS "billingAccountId",
           participant_person_id AS "participantPersonId",
           plan_code AS "planCode",
           state::text AS state,
           version,
           created_at AS "createdAt"`,
        [membershipId, input.expectedVersion],
      );
      const updated = updatedResult.rows[0];
      if (!updated) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          detail: 'The membership changed before it could be activated.',
        });
      }
      const membership = summarizeActivated(updated);
      const priorState = { state: current.state, version: current.version };
      const payload = {
        membershipId: membership.id,
        state: membership.state,
        version: membership.version,
      };

      await client.query(
        `INSERT INTO hon.audit_events (
           organization_id, school_id, actor_principal_id, source, action_code,
           entity_type, entity_id, prior_state, next_state, result,
           request_id, correlation_id, action_request_id, occurred_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'HUMAN_UI', 'billing.membership.activate',
           'MEMBERSHIP', $4::uuid, $5::jsonb, $6::jsonb, 'SUCCEEDED',
           $7::uuid, $8::uuid, NULL, now()
         )`,
        [
          context.organizationId,
          context.schoolId,
          context.principalId,
          membership.id,
          JSON.stringify(priorState),
          JSON.stringify(payload),
          context.requestId,
          context.correlationId,
        ],
      );
      await client.query(
        `INSERT INTO hon.outbox_events (
           id, organization_id, school_id, event_type, schema_version,
           aggregate_type, aggregate_id, aggregate_version, correlation_id,
           causation_id, payload
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'billing.membership.activated', 1,
           'MEMBERSHIP', $4::uuid, $5::integer, $6::uuid, $7::uuid, $8::jsonb
         )`,
        [
          randomUUID(),
          context.organizationId,
          context.schoolId,
          membership.id,
          membership.version,
          context.correlationId,
          context.requestId,
          JSON.stringify(payload),
        ],
      );
      await client.query(
        `UPDATE hon.idempotency_records
         SET status = 'COMPLETED', response_status = 200, response_body = $5::jsonb
         WHERE organization_id = $1::uuid
           AND school_id = $2::uuid
           AND principal_id = $3::uuid
           AND idempotency_key = $4`,
        [
          context.organizationId,
          context.schoolId,
          context.principalId,
          context.idempotencyKey,
          JSON.stringify(membership),
        ],
      );
      return { membership, replayed: false };
    });
  }

  private assertHumanActivationContext(context: CommandContext): void {
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
      !context.idempotencyKey
      || context.idempotencyKey !== context.idempotencyKey.trim()
      || context.idempotencyKey.length > 200
    ) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: 'A bounded Idempotency-Key is required for membership activation.',
      });
    }
  }

  private assertActivationInput(input: ActivateMembershipInput): void {
    for (const key of Object.keys(input as unknown as Record<string, unknown>)) {
      if (!ACTIVATE_INPUT_KEYS.has(key)) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          detail: `Unsupported membership activation field: ${key}.`,
        });
      }
    }
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        detail: 'expectedVersion must be a positive whole number.',
      });
    }
  }
}
