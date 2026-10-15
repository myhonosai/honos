import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { tierIncludesFeature } from '@hon/config';
import type { CommandContext, CreateMembershipInput, HonTier, MembershipSummary } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

export interface CreateMembershipResult {
  membership: MembershipSummary;
  replayed: boolean;
}

function fingerprint(input: CreateMembershipInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
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
}
