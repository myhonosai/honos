import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  ISO_4217_CURRENCIES,
  type CommandContext,
  type CreateInvoiceDraftInput,
  type InvoiceDraftSummary,
  type InvoiceIssuedSummary,
  type IssueInvoiceInput,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

const MAX_MINOR_UNITS = 2_147_483_647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMEZONE_QUALIFIED_ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const CURRENCIES = new Set<string>(ISO_4217_CURRENCIES);
const INPUT_KEYS = new Set(['billingAccountId', 'membershipId', 'dueAt', 'currency', 'subtotalMinor']);
const ISSUE_INPUT_KEYS = new Set(['expectedVersion']);

type IdempotencyRecord = {
  request_fingerprint: string;
  status: 'IN_PROGRESS' | 'COMPLETED';
  response_body: InvoiceDraftSummary | null;
};

type InvoiceRow = {
  id: string;
  billingAccountId: string;
  membershipId: string | null;
  status: 'DRAFT';
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  dueAt: Date | string;
  version: number;
  createdAt: Date | string;
};

type InvoiceIssuanceRow = {
  id: string;
  billingAccountId: string;
  membershipId: string | null;
  status: string;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  dueAt: Date | string | null;
  version: number;
  createdAt: Date | string;
};

type IssueIdempotencyRecord = {
  request_fingerprint: string;
  status: 'IN_PROGRESS' | 'COMPLETED';
  response_body: InvoiceIssuedSummary | null;
};

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function summarize(row: InvoiceRow): InvoiceDraftSummary {
  return {
    id: row.id,
    billingAccountId: row.billingAccountId,
    membershipId: row.membershipId ?? undefined,
    status: row.status,
    currency: row.currency,
    subtotalMinor: row.subtotalMinor,
    discountMinor: 0,
    totalMinor: row.totalMinor,
    dueAt: timestamp(row.dueAt),
    version: row.version,
    createdAt: timestamp(row.createdAt),
  };
}

function summarizeIssued(row: InvoiceIssuanceRow): InvoiceIssuedSummary {
  if (row.status !== 'ISSUED') {
    throw new Error('HON invoice issuance query returned an invalid invoice status.');
  }
  return {
    id: row.id,
    billingAccountId: row.billingAccountId,
    membershipId: row.membershipId ?? undefined,
    status: 'ISSUED',
    currency: row.currency,
    subtotalMinor: row.subtotalMinor,
    discountMinor: row.discountMinor,
    totalMinor: row.totalMinor,
    dueAt: row.dueAt === null ? undefined : timestamp(row.dueAt),
    version: row.version,
    createdAt: timestamp(row.createdAt),
  };
}

/**
 * This command intentionally creates only a DRAFT invoice. It has no issuance,
 * payment/provider, membership-state, concession, or Action Engine behavior.
 */
@Injectable()
export class InvoiceService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async createDraft(
    context: CommandContext,
    input: CreateInvoiceDraftInput,
  ): Promise<{ invoice: InvoiceDraftSummary; replayed: boolean }> {
    this.assertHumanInvoiceDraftContext(context);
    this.assertInput(input);
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({
        operation: 'billing.invoice.create',
        billingAccountId: input.billingAccountId,
        membershipId: input.membershipId ?? null,
        dueAt: input.dueAt,
        currency: input.currency,
        subtotalMinor: input.subtotalMinor,
      }))
      .digest('hex');

    return this.database.withTenantTransaction(context, async (client) => {
      const replay = await this.reserveIdempotency(client, context, requestFingerprint);
      if (replay) return { invoice: replay, replayed: true };

      // This lookup runs inside the RLS-bound tenant transaction. It deliberately
      // does not infer an account from a membership or permit a cross-account link.
      const accountResult = await client.query<{ id: string; currency: string }>(
        `SELECT id, currency
         FROM hon.billing_accounts
         WHERE id = $1::uuid
           AND organization_id = $2::uuid
           AND school_id = $3::uuid`,
        [input.billingAccountId, context.organizationId, context.schoolId],
      );
      const account = accountResult.rows[0];
      if (!account) {
        throw new NotFoundException({
          code: 'BILLING_ACCOUNT_NOT_FOUND',
          detail: 'The billing account is not available in this school.',
        });
      }
      if (account.currency !== input.currency) {
        throw new BadRequestException({
          code: 'INVOICE_CURRENCY_ACCOUNT_MISMATCH',
          detail: 'Invoice currency must match the selected billing account currency.',
        });
      }

      if (input.membershipId) {
        const membershipResult = await client.query<{ id: string; billing_account_id: string }>(
          `SELECT id, billing_account_id
           FROM hon.memberships
           WHERE id = $1::uuid
             AND organization_id = $2::uuid
             AND school_id = $3::uuid`,
          [input.membershipId, context.organizationId, context.schoolId],
        );
        const membership = membershipResult.rows[0];
        if (!membership) {
          throw new NotFoundException({
            code: 'BILLING_MEMBERSHIP_NOT_FOUND',
            detail: 'The membership is not available in this school.',
          });
        }
        if (membership.billing_account_id !== account.id) {
          throw new BadRequestException({
            code: 'INVOICE_MEMBERSHIP_ACCOUNT_MISMATCH',
            detail: 'The membership must belong to the selected billing account.',
          });
        }
      }

      const inserted = await client.query<InvoiceRow>(
        `INSERT INTO hon.invoices (
           organization_id, school_id, billing_account_id, membership_id, status,
           currency, subtotal_minor, discount_minor, total_minor, due_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'DRAFT',
           $5::char(3), $6::integer, 0, $6::integer, $7::timestamptz
         )
         RETURNING
           id,
           billing_account_id AS "billingAccountId",
           membership_id AS "membershipId",
           status,
           currency,
           subtotal_minor AS "subtotalMinor",
           discount_minor AS "discountMinor",
           total_minor AS "totalMinor",
           due_at AS "dueAt",
           version,
           created_at AS "createdAt"`,
        [
          context.organizationId,
          context.schoolId,
          account.id,
          input.membershipId ?? null,
          input.currency,
          input.subtotalMinor,
          input.dueAt,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('HON invoice draft insert did not return a record.');
      const invoice = summarize(row);
      const payload = {
        invoiceId: invoice.id,
        billingAccountId: invoice.billingAccountId,
        membershipId: invoice.membershipId ?? null,
        status: invoice.status,
        currency: invoice.currency,
        subtotalMinor: invoice.subtotalMinor,
        discountMinor: invoice.discountMinor,
        totalMinor: invoice.totalMinor,
        dueAt: invoice.dueAt,
        version: invoice.version,
      };

      await client.query(
        `INSERT INTO hon.audit_events (
           organization_id, school_id, actor_principal_id, source, action_code,
           entity_type, entity_id, prior_state, next_state, result,
           request_id, correlation_id, action_request_id, occurred_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'HUMAN_UI', 'billing.invoice.create',
           'INVOICE', $4::uuid, NULL, $5::jsonb, 'SUCCEEDED',
           $6::uuid, $7::uuid, NULL, now()
         )`,
        [
          context.organizationId,
          context.schoolId,
          context.principalId,
          invoice.id,
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
           $1::uuid, $2::uuid, $3::uuid, 'billing.invoice.created', 1,
           'INVOICE', $4::uuid, $5::integer, $6::uuid, $7::uuid, $8::jsonb
         )`,
        [
          randomUUID(),
          context.organizationId,
          context.schoolId,
          invoice.id,
          invoice.version,
          context.correlationId,
          context.requestId,
          JSON.stringify(payload),
        ],
      );
      await client.query(
        `UPDATE hon.idempotency_records
         SET status = 'COMPLETED', response_status = 201, response_body = $5::jsonb
         WHERE organization_id = $1::uuid
           AND school_id = $2::uuid
           AND principal_id = $3::uuid
           AND idempotency_key = $4`,
        [
          context.organizationId,
          context.schoolId,
          context.principalId,
          context.idempotencyKey,
          JSON.stringify(invoice),
        ],
      );
      return { invoice, replayed: false };
    });
  }

  /**
   * Issues an already-created DRAFT. This intentionally records no provider,
   * payment attempt, delivery, membership, credit, discount, refund, waiver,
   * extension, or Action Engine side effect.
   */
  async issue(
    context: CommandContext,
    invoiceId: string,
    input: IssueInvoiceInput,
  ): Promise<{ invoice: InvoiceIssuedSummary; replayed: boolean }> {
    this.assertHumanInvoiceIssueContext(context);
    if (!UUID.test(invoiceId)) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'invoiceId must be a UUID.' });
    }
    this.assertIssueInput(input);
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({
        operation: 'billing.invoice.issue',
        invoiceId,
        expectedVersion: input.expectedVersion,
      }))
      .digest('hex');

    return this.database.withTenantTransaction(context, async (client) => {
      // This lookup is deliberately only ID-constrained: transaction-local RLS
      // hides a record outside the permission-derived organization and school.
      const currentResult = await client.query<InvoiceIssuanceRow>(
        `SELECT
           id,
           billing_account_id AS "billingAccountId",
           membership_id AS "membershipId",
           status::text AS status,
           currency,
           subtotal_minor AS "subtotalMinor",
           discount_minor AS "discountMinor",
           total_minor AS "totalMinor",
           due_at AS "dueAt",
           version,
           created_at AS "createdAt"
         FROM hon.invoices
         WHERE id = $1::uuid
         FOR UPDATE`,
        [invoiceId],
      );
      const current = currentResult.rows[0];
      if (!current) {
        throw new NotFoundException({
          code: 'INVOICE_NOT_FOUND',
          detail: 'The invoice is not available in this school.',
        });
      }

      const reservation = await client.query<{ id: string }>(
        `INSERT INTO hon.idempotency_records (
           organization_id, school_id, principal_id, idempotency_key, request_fingerprint, status, expires_at
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
        const existing = await client.query<IssueIdempotencyRecord>(
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
        if (!record) throw new Error('HON invoice issuance idempotency record unexpectedly missing.');
        if (record.request_fingerprint !== requestFingerprint) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            detail: 'The idempotency key was already used for a different invoice issue command.',
          });
        }
        if (record.status === 'COMPLETED' && record.response_body) {
          return { invoice: record.response_body, replayed: true };
        }
        throw new ConflictException({
          code: 'IDEMPOTENCY_IN_PROGRESS',
          detail: 'The matching invoice issue command is being processed.',
        });
      }

      if (current.status !== 'DRAFT') {
        throw new ConflictException({
          code: 'INVOICE_NOT_DRAFT',
          detail: 'Only a DRAFT invoice can be issued.',
        });
      }
      if (current.version !== input.expectedVersion) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          detail: 'The invoice has changed. Refresh it and retry with its current version and a new Idempotency-Key.',
        });
      }

      const updatedResult = await client.query<InvoiceIssuanceRow>(
        `UPDATE hon.invoices
         SET status = 'ISSUED'::hon.invoice_status,
             version = version + 1
         WHERE id = $1::uuid
           AND status = 'DRAFT'::hon.invoice_status
           AND version = $2::integer
         RETURNING
           id,
           billing_account_id AS "billingAccountId",
           membership_id AS "membershipId",
           status::text AS status,
           currency,
           subtotal_minor AS "subtotalMinor",
           discount_minor AS "discountMinor",
           total_minor AS "totalMinor",
           due_at AS "dueAt",
           version,
           created_at AS "createdAt"`,
        [invoiceId, input.expectedVersion],
      );
      const updated = updatedResult.rows[0];
      if (!updated) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          detail: 'The invoice changed before it could be issued.',
        });
      }
      const invoice = summarizeIssued(updated);
      const priorState = { status: current.status, version: current.version };
      const payload = { invoiceId: invoice.id, status: invoice.status, version: invoice.version };

      await client.query(
        `INSERT INTO hon.audit_events (
           organization_id, school_id, actor_principal_id, source, action_code,
           entity_type, entity_id, prior_state, next_state, result,
           request_id, correlation_id, action_request_id, occurred_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'HUMAN_UI', 'billing.invoice.issue',
           'INVOICE', $4::uuid, $5::jsonb, $6::jsonb, 'SUCCEEDED',
           $7::uuid, $8::uuid, NULL, now()
         )`,
        [
          context.organizationId,
          context.schoolId,
          context.principalId,
          invoice.id,
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
           $1::uuid, $2::uuid, $3::uuid, 'billing.invoice.issued', 1,
           'INVOICE', $4::uuid, $5::integer, $6::uuid, $7::uuid, $8::jsonb
         )`,
        [
          randomUUID(),
          context.organizationId,
          context.schoolId,
          invoice.id,
          invoice.version,
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
          JSON.stringify(invoice),
        ],
      );
      return { invoice, replayed: false };
    });
  }

  private assertHumanInvoiceDraftContext(context: CommandContext): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI') {
      throw new ForbiddenException({
        code: 'HUMAN_COMMAND_REQUIRED',
        detail: 'Invoice draft creation accepts only HUMAN_USER commands from HUMAN_UI.',
      });
    }
    if (
      !context.idempotencyKey
      || context.idempotencyKey !== context.idempotencyKey.trim()
      || context.idempotencyKey.length > 200
    ) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: 'A bounded Idempotency-Key is required for invoice draft creation.',
      });
    }
  }

  private assertHumanInvoiceIssueContext(context: CommandContext): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI') {
      throw new ForbiddenException({
        code: 'HUMAN_COMMAND_REQUIRED',
        detail: 'Invoice issuance accepts only HUMAN_USER commands from HUMAN_UI.',
      });
    }
    if (context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({
        code: 'HUMAN_COMMAND_REQUIRED',
        detail: 'Invoice issuance cannot be delegated or executed through the Action Engine.',
      });
    }
    if (
      !context.idempotencyKey
      || context.idempotencyKey !== context.idempotencyKey.trim()
      || context.idempotencyKey.length > 200
    ) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: 'A bounded Idempotency-Key is required for invoice issuance.',
      });
    }
  }

  private assertInput(input: CreateInvoiceDraftInput): void {
    for (const key of Object.keys(input as unknown as Record<string, unknown>)) {
      if (!INPUT_KEYS.has(key)) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          detail: `Unsupported invoice draft field: ${key}.`,
        });
      }
    }
    if (typeof input.billingAccountId !== 'string' || !UUID.test(input.billingAccountId)) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'billingAccountId must be a UUID.' });
    }
    if (input.membershipId !== undefined && (typeof input.membershipId !== 'string' || !UUID.test(input.membershipId))) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'membershipId must be a UUID when provided.' });
    }
    if (
      typeof input.dueAt !== 'string'
      || input.dueAt.length > 40
      || !TIMEZONE_QUALIFIED_ISO_8601.test(input.dueAt)
      || Number.isNaN(Date.parse(input.dueAt))
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        detail: 'dueAt must be a bounded timezone-qualified ISO 8601 timestamp.',
      });
    }
    if (typeof input.currency !== 'string' || !CURRENCIES.has(input.currency)) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        detail: 'currency must be a supported uppercase ISO 4217 code.',
      });
    }
    if (
      !Number.isSafeInteger(input.subtotalMinor)
      || input.subtotalMinor < 0
      || input.subtotalMinor > MAX_MINOR_UNITS
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        detail: 'subtotalMinor must be a non-negative signed 32-bit integer.',
      });
    }
  }

  private assertIssueInput(input: IssueInvoiceInput): void {
    for (const key of Object.keys(input as unknown as Record<string, unknown>)) {
      if (!ISSUE_INPUT_KEYS.has(key)) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          detail: `Unsupported invoice issue field: ${key}.`,
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

  private async reserveIdempotency(
    client: PoolClient,
    context: CommandContext,
    requestFingerprint: string,
  ): Promise<InvoiceDraftSummary | null> {
    const reservation = await client.query(
      `INSERT INTO hon.idempotency_records (
         organization_id, school_id, principal_id, idempotency_key, request_fingerprint, status, expires_at
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
    if (reservation.rowCount) return null;

    const existing = await client.query<IdempotencyRecord>(
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
    if (!record) throw new Error('HON invoice idempotency record unexpectedly missing.');
    if (record.request_fingerprint !== requestFingerprint) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        detail: 'The idempotency key was already used for a different invoice draft command.',
      });
    }
    if (record.status === 'COMPLETED' && record.response_body) return record.response_body;
    throw new ConflictException({
      code: 'IDEMPOTENCY_IN_PROGRESS',
      detail: 'The matching invoice draft command is being processed.',
    });
  }
}
