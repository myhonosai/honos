import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { tierIncludesFeature } from '@hon/config';
import { validateCreateBillingAccountInput, type BillingAccountClassification, type BillingAccountSummary, type CommandContext, type CreateBillingAccountInput, type HonTier } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

export type BillingAccountCommandReceipt = BillingAccountSummary & { reused: boolean };
/** Receipt stored before 0159 (no classification or reuse fact); replayed verbatim, never rewritten. */
export type LegacyBillingAccountReceipt = Omit<BillingAccountSummary, 'classification'>;
export interface CreateBillingAccountResult { account: BillingAccountCommandReceipt | LegacyBillingAccountReceipt; replayed: boolean; }
export interface BillingAccountPayerChoice { id: string; displayName: string; }
type BillingAccountReadContext = Omit<CommandContext, 'idempotencyKey'>;
type NormalizedInput = { responsiblePersonId: string; currency: string; createAdditional: boolean; additionalReason?: string };
type BillingAccountDatabaseRow = Omit<BillingAccountSummary, 'createdAt'> & {
  classification: BillingAccountClassification;
  createdAt: Date | string;
};

function serializeAccount(row: BillingAccountDatabaseRow): BillingAccountSummary & { classification: BillingAccountClassification } {
  return {
    ...row,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

function normalizedInput(input: CreateBillingAccountInput): NormalizedInput {
  validateCreateBillingAccountInput(input);
  return {
    responsiblePersonId: input.responsiblePersonId.toLowerCase(),
    currency: (input.currency ?? 'USD').toUpperCase(),
    createAdditional: input.createAdditional === true,
    ...(input.createAdditional ? { additionalReason: input.additionalReason } : {}),
  };
}

function fingerprint(value: object): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Fingerprints the pre-0159 service recorded for the same request: it hashed
 * `{ responsiblePersonId (as submitted), currency }`. Only a normal (canonical)
 * request can be equivalent to a legacy one; an additional-account request
 * never is. Both submitted and lower-cased person ids are accepted because the
 * legacy service did not normalize case.
 */
function legacyFingerprints(input: CreateBillingAccountInput, normalized: NormalizedInput): string[] {
  if (normalized.createAdditional) return [];
  return [...new Set([input.responsiblePersonId, normalized.responsiblePersonId])]
    .map(responsiblePersonId => fingerprint({ responsiblePersonId, currency: normalized.currency }));
}

function assertDirectHumanContext(context: Pick<CommandContext, 'principalType' | 'source' | 'actionRequestId' | 'delegatedByPrincipalId'>): void {
  if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI'
    || context.actionRequestId !== undefined || context.delegatedByPrincipalId !== undefined) {
    throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED', detail: 'Billing account commands require a direct current human staff session.' });
  }
}

@Injectable()
export class BillingAccountService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async create(context: CommandContext, input: CreateBillingAccountInput): Promise<CreateBillingAccountResult> {
    assertDirectHumanContext(context);
    const normalized = normalizedInput(input);
    const requestFingerprint = fingerprint(normalized);
    const equivalentFingerprints = new Set([requestFingerprint, ...legacyFingerprints(input, normalized)]);
    return this.database.withTenantTransaction(context, async (client) => {
      await client.query(
        "SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id',$2,true),set_config('app.hon_delegated_by_principal_id',$3,true)",
        [context.source, context.actionRequestId ?? '', context.delegatedByPrincipalId ?? ''],
      );
      await this.recheckCurrentHuman(client, context);
      const entitlement = await client.query<{ tier: HonTier }>(
        'SELECT tier FROM hon.read_current_organization_entitlement()',
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
        const existing = await client.query<{ request_fingerprint: string; status: 'IN_PROGRESS' | 'COMPLETED'; response_body: BillingAccountCommandReceipt | LegacyBillingAccountReceipt | null }>(
          `SELECT request_fingerprint, status, response_body FROM hon.idempotency_records
           WHERE organization_id = $1 AND school_id = $2 AND principal_id = $3 AND idempotency_key = $4 FOR UPDATE`,
          [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey],
        );
        const record = existing.rows[0];
        if (!record) throw new Error('HON billing account idempotency record unexpectedly missing.');
        if (!equivalentFingerprints.has(record.request_fingerprint)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', detail: 'The idempotency key was already used for another billing account.' });
        if (record.status === 'COMPLETED' && record.response_body) return { account: record.response_body, replayed: true };
        throw new ConflictException({ code: 'IDEMPOTENCY_IN_PROGRESS', detail: 'The matching billing account command is being processed.' });
      }
      const person = await client.query<{ id: string }>(
        `SELECT id FROM hon.people WHERE id = $1::uuid AND organization_id = $2 AND school_id = $3`,
        [normalized.responsiblePersonId, context.organizationId, context.schoolId],
      );
      if (!person.rowCount) throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'The responsible person must belong to this school.' });

      // The fixed definer helper retains the relation lock without granting the
      // restricted runtime UPDATE/DELETE privilege; 0152's partial unique index
      // remains the durable invariant if another writer races this boundary.
      await client.query('SELECT hon.lock_current_direct_human_billing_accounts($1::uuid)', [context.principalId]);
      const accounts = await client.query<BillingAccountDatabaseRow>(
        `SELECT id, responsible_person_id AS "responsiblePersonId", currency,
                account_classification AS classification, version, created_at AS "createdAt"
         FROM hon.billing_accounts
         WHERE organization_id = $1 AND school_id = $2 AND responsible_person_id = $3::uuid
         ORDER BY created_at ASC, id ASC`,
        [context.organizationId, context.schoolId, normalized.responsiblePersonId],
      );
      const canonical = accounts.rows.map(serializeAccount).find(account => account.classification === 'CANONICAL');

      if (!normalized.createAdditional && canonical) {
        if (canonical.currency !== normalized.currency) {
          throw new ConflictException({
            code: 'CANONICAL_ACCOUNT_CURRENCY_CONFLICT',
            detail: 'The current canonical billing account has a different currency. Review it and explicitly request an additional account with a documented reason; no currency was changed.',
          });
        }
        const account: BillingAccountCommandReceipt = { ...canonical, reused: true };
        const payload = { billingAccountId: account.id, responsiblePersonId: account.responsiblePersonId,
          currency: account.currency, accountClassification: account.classification, reused: true };
        await client.query(
          `INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id, prior_state, next_state, result, request_id, correlation_id, occurred_at)
           VALUES ($1, $2, $3, $4, 'billing.account.reuse', 'BILLING_ACCOUNT', $5::uuid, NULL, $6::jsonb, 'SUCCEEDED', $7::uuid, $8::uuid, now())`,
          [context.organizationId, context.schoolId, context.principalId, context.source, account.id, JSON.stringify(payload), context.requestId, context.correlationId],
        );
        await client.query(
          `UPDATE hon.idempotency_records SET status = 'COMPLETED', response_status = 200, response_body = $5::jsonb
           WHERE organization_id = $1 AND school_id = $2 AND principal_id = $3 AND idempotency_key = $4`,
          [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey, JSON.stringify(account)],
        );
        await this.recheckCurrentHuman(client, context);
        return { account, replayed: false };
      }

      if (normalized.createAdditional && !canonical) {
        throw new ConflictException({ code: 'CANONICAL_ACCOUNT_REQUIRED', detail: 'An additional billing account requires an existing current canonical account for this responsible person.' });
      }

      const classification: BillingAccountClassification = normalized.createAdditional ? 'ADDITIONAL' : 'CANONICAL';
      const created = await client.query<BillingAccountDatabaseRow>(
        `INSERT INTO hon.billing_accounts (organization_id, school_id, responsible_person_id, currency, account_classification)
         VALUES ($1, $2, $3::uuid, $4, $5)
         RETURNING id, responsible_person_id AS "responsiblePersonId", currency,
                   account_classification AS classification, version, created_at AS "createdAt"`,
        [context.organizationId, context.schoolId, normalized.responsiblePersonId, normalized.currency, classification],
      );
      const createdAccount = created.rows[0] ? serializeAccount(created.rows[0]) : undefined;
      if (!createdAccount) throw new Error('HON billing account insert did not return a record.');
      const account: BillingAccountCommandReceipt = { ...createdAccount, reused: false };
      const payload = { billingAccountId: account.id, responsiblePersonId: account.responsiblePersonId, currency: account.currency,
        accountClassification: account.classification, reused: false, ...(normalized.createAdditional ? { additionalReason: normalized.additionalReason } : {}) };
      await client.query(
        `INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id, prior_state, next_state, result, request_id, correlation_id, occurred_at)
         VALUES ($1, $2, $3, $4, 'billing.account.create', 'BILLING_ACCOUNT', $5::uuid, NULL, $6::jsonb, 'SUCCEEDED', $7::uuid, $8::uuid, now())`,
        [context.organizationId, context.schoolId, context.principalId, context.source, account.id, JSON.stringify(payload), context.requestId, context.correlationId],
      );
      const outboxPayload = { billingAccountId: account.id, responsiblePersonId: account.responsiblePersonId,
        currency: account.currency, accountClassification: account.classification };
      await client.query(
        `INSERT INTO hon.outbox_events (id, organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version, correlation_id, causation_id, payload)
         VALUES ($1::uuid, $2, $3, 'billing.account.created', 1, 'BILLING_ACCOUNT', $4::uuid, $5, $6::uuid, $7::uuid, $8::jsonb)`,
        [randomUUID(), context.organizationId, context.schoolId, account.id, account.version, context.correlationId, context.requestId, JSON.stringify(outboxPayload)],
      );
      await client.query(
        `UPDATE hon.idempotency_records SET status = 'COMPLETED', response_status = 201, response_body = $5::jsonb
         WHERE organization_id = $1 AND school_id = $2 AND principal_id = $3 AND idempotency_key = $4`,
        [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey, JSON.stringify(account)],
      );
      await this.recheckCurrentHuman(client, context);
      return { account, replayed: false };
    });
  }

  /** Explicit bounded current-school payer lookup; it never lists accounts or invokes a command. */
  async lookupPayers(context: BillingAccountReadContext, query: string): Promise<BillingAccountPayerChoice[]> {
    assertDirectHumanContext(context);
    if (typeof query !== 'string' || query.length < 2 || query.length > 20 || query.trim() !== query
      || /[\u0000-\u001f\u007f-\u009f]/u.test(query)) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Enter a current-school payer lookup of 2 to 20 non-control characters.' });
    }
    return this.database.withTenantTransaction(context, async (client) => {
      await client.query(
        "SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id',$2,true),set_config('app.hon_delegated_by_principal_id',$3,true)",
        [context.source, context.actionRequestId ?? '', context.delegatedByPrincipalId ?? ''],
      );
      await this.recheckCurrentHuman(client, context);
      const entitlement = await client.query<{ tier: HonTier }>('SELECT tier FROM hon.read_current_organization_entitlement()');
      if (!entitlement.rows[0] || !tierIncludesFeature(entitlement.rows[0].tier, 'billing.foundation')) {
        throw new ForbiddenException({ code: 'TIER_ENTITLEMENT_REQUIRED', detail: 'An active HON billing entitlement is required for billing accounts.' });
      }
      const matches = await client.query<BillingAccountPayerChoice>(
        `SELECT id, concat_ws(' ', given_name, family_name) AS "displayName"
         FROM hon.people
         WHERE organization_id = $1 AND school_id = $2
           AND (given_name ILIKE $3 || '%' OR family_name ILIKE $3 || '%'
             OR concat_ws(' ', given_name, family_name) ILIKE $3 || '%')
         ORDER BY family_name ASC, given_name ASC, id ASC LIMIT 10`,
        [context.organizationId, context.schoolId, query],
      );
      await this.recheckCurrentHuman(client, context);
      return matches.rows;
    });
  }

  private async recheckCurrentHuman(client: PoolClient, context: Pick<CommandContext, 'principalId' | 'organizationId' | 'schoolId'>): Promise<void> {
    const current = await client.query<{ authorized: boolean }>(
      'SELECT hon.require_current_direct_human_billing_account_actor($1::uuid) AS authorized',
      [context.principalId],
    );
    if (current.rows[0]?.authorized !== true) {
      throw new ForbiddenException({ code: 'PERMISSION_DENIED', detail: 'The current direct human billing-account permission is no longer authorized.' });
    }
  }
}
