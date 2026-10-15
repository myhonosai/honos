import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { tierIncludesFeature } from '@hon/config';
import type { BillingAccountSummary, CommandContext, CreateBillingAccountInput, HonTier } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

export interface CreateBillingAccountResult { account: BillingAccountSummary; replayed: boolean; }

@Injectable()
export class BillingAccountService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async create(context: CommandContext, input: CreateBillingAccountInput): Promise<CreateBillingAccountResult> {
    const normalized = { responsiblePersonId: input.responsiblePersonId, currency: (input.currency ?? 'USD').toUpperCase() };
    const requestFingerprint = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    return this.database.withTenantTransaction(context, async (client) => {
      const entitlement = await client.query<{ tier: HonTier }>(
        `SELECT tier::text AS tier FROM hon.organization_entitlements
         WHERE organization_id = $1 AND status = 'ACTIVE' AND effective_from <= now()
           AND (effective_until IS NULL OR effective_until > now())`, [context.organizationId],
      );
      if (!entitlement.rows[0] || !tierIncludesFeature(entitlement.rows[0].tier, 'billing.foundation')) {
        throw new ForbiddenException({ code: 'TIER_ENTITLEMENT_REQUIRED', detail: 'An active HON billing entitlement is required for billing accounts.' });
      }
      const reservation = await client.query<{ id: string }>(
        `INSERT INTO hon.idempotency_records (organization_id, school_id, principal_id, idempotency_key, request_fingerprint, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', now() + interval '24 hours')
         ON CONFLICT (organization_id, school_id, principal_id, idempotency_key) DO NOTHING RETURNING id`,
        [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey, requestFingerprint],
      );
      if (!reservation.rowCount) {
        const existing = await client.query<{ request_fingerprint: string; status: 'IN_PROGRESS' | 'COMPLETED'; response_body: BillingAccountSummary | null }>(
          `SELECT request_fingerprint, status, response_body FROM hon.idempotency_records
           WHERE organization_id = $1 AND school_id = $2 AND principal_id = $3 AND idempotency_key = $4 FOR UPDATE`,
          [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey],
        );
        const record = existing.rows[0];
        if (!record) throw new Error('HON billing account idempotency record unexpectedly missing.');
        if (record.request_fingerprint !== requestFingerprint) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', detail: 'The idempotency key was already used for another billing account.' });
        if (record.status === 'COMPLETED' && record.response_body) return { account: record.response_body, replayed: true };
        throw new ConflictException({ code: 'IDEMPOTENCY_IN_PROGRESS', detail: 'The matching billing account command is being processed.' });
      }
      const person = await client.query<{ id: string }>(
        `SELECT id FROM hon.people WHERE id = $1::uuid AND organization_id = $2 AND school_id = $3`,
        [normalized.responsiblePersonId, context.organizationId, context.schoolId],
      );
      if (!person.rowCount) throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'The responsible person must belong to this school.' });
      const created = await client.query<BillingAccountSummary>(
        `INSERT INTO hon.billing_accounts (organization_id, school_id, responsible_person_id, currency)
         VALUES ($1, $2, $3::uuid, $4)
         RETURNING id, responsible_person_id AS "responsiblePersonId", currency, version, created_at AS "createdAt"`,
        [context.organizationId, context.schoolId, normalized.responsiblePersonId, normalized.currency],
      );
      const account = created.rows[0];
      if (!account) throw new Error('HON billing account insert did not return a record.');
      const payload = { billingAccountId: account.id, responsiblePersonId: account.responsiblePersonId, currency: account.currency };
      await client.query(
        `INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id, prior_state, next_state, result, request_id, correlation_id, occurred_at)
         VALUES ($1, $2, $3, $4, 'billing.account.create', 'BILLING_ACCOUNT', $5::uuid, NULL, $6::jsonb, 'SUCCEEDED', $7::uuid, $8::uuid, now())`,
        [context.organizationId, context.schoolId, context.principalId, context.source, account.id, JSON.stringify(payload), context.requestId, context.correlationId],
      );
      await client.query(
        `INSERT INTO hon.outbox_events (id, organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version, correlation_id, causation_id, payload)
         VALUES ($1::uuid, $2, $3, 'billing.account.created', 1, 'BILLING_ACCOUNT', $4::uuid, $5, $6::uuid, $7::uuid, $8::jsonb)`,
        [randomUUID(), context.organizationId, context.schoolId, account.id, account.version, context.correlationId, context.requestId, JSON.stringify(payload)],
      );
      await client.query(
        `UPDATE hon.idempotency_records SET status = 'COMPLETED', response_status = 201, response_body = $5::jsonb
         WHERE organization_id = $1 AND school_id = $2 AND principal_id = $3 AND idempotency_key = $4`,
        [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey, JSON.stringify(account)],
      );
      return { account, replayed: false };
    });
  }
}
