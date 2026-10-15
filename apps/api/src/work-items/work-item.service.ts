import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  type CommandContext,
  type CreateWorkItemInput,
  type TransitionWorkItemInput,
  type WorkItemStatus,
  type WorkItemSummary,
} from '@hon/contracts';
import {
  assertWorkItemTransition,
  isWorkItemStatus,
} from '@hon/domain';
import type { TenantTransactionContext } from '@hon/database';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JSON_OBJECT_LIMIT_BYTES = 32_768;

interface WorkItemRow {
  id: string;
  workType: string;
  status: string;
  subjectType: string | null;
  subjectId: string | null;
  version: number;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface IdempotencyRecord {
  request_fingerprint: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  response_body: WorkItemSummary | null;
}

interface NormalizedCreateInput {
  workType: string;
  subjectType: string | null;
  subjectId: string | null;
  payload: Record<string, unknown>;
}

interface NormalizedTransitionInput {
  targetStatus: WorkItemStatus;
  expectedVersion: number;
  result: Record<string, unknown> | undefined;
  hasResult: boolean;
  errorReason: string | null;
}

function validationError(detail: string): BadRequestException {
  return new BadRequestException({ code: 'VALIDATION_FAILED', detail });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encodedObject(value: Record<string, unknown>, field: 'payload' | 'result'): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw validationError(`Work item ${field} must be JSON serializable.`);
  }
  if (!encoded || Buffer.byteLength(encoded, 'utf8') > JSON_OBJECT_LIMIT_BYTES) {
    throw validationError(`Work item ${field} must be a JSON object of at most ${JSON_OBJECT_LIMIT_BYTES} bytes.`);
  }
  return encoded;
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toSummary(row: WorkItemRow): WorkItemSummary {
  const status = row.status;
  if (!isWorkItemStatus(status)) {
    throw new Error('HON work item query returned an invalid status.');
  }
  return {
    id: row.id,
    workType: row.workType,
    status,
    ...(row.subjectType === null ? {} : { subjectType: row.subjectType }),
    ...(row.subjectId === null ? {} : { subjectId: row.subjectId }),
    version: row.version,
    createdAt: asIso(row.createdAt),
    updatedAt: asIso(row.updatedAt),
  };
}

function normalizeCreate(input: CreateWorkItemInput): NormalizedCreateInput {
  if (typeof input.workType !== 'string') throw validationError('workType must be a string.');
  const workType = input.workType.trim();
  if (!workType || workType.length > 100) {
    throw validationError('workType must contain at most 100 non-blank characters.');
  }
  if (input.subjectType !== undefined && typeof input.subjectType !== 'string') {
    throw validationError('subjectType must be a string when supplied.');
  }
  const subjectType = input.subjectType === undefined ? null : input.subjectType.trim();
  if (subjectType !== null && (!subjectType || subjectType.length > 100)) {
    throw validationError('subjectType must contain at most 100 non-blank characters when supplied.');
  }
  const subjectId = input.subjectId ?? null;
  if (subjectId !== null && !UUID.test(subjectId)) {
    throw validationError('subjectId must be a UUID when supplied.');
  }
  const payload = input.payload ?? {};
  if (!isRecord(payload)) throw validationError('payload must be a JSON object when supplied.');
  encodedObject(payload, 'payload');
  return { workType, subjectType, subjectId, payload };
}

function normalizeTransition(input: TransitionWorkItemInput): NormalizedTransitionInput {
  if (!isWorkItemStatus(input.targetStatus)) {
    throw validationError('targetStatus is not a supported work-item state.');
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw validationError('expectedVersion must be a positive integer.');
  }
  const hasResult = input.result !== undefined;
  if (hasResult && !isRecord(input.result)) throw validationError('result must be a JSON object when supplied.');
  if (hasResult) encodedObject(input.result as Record<string, unknown>, 'result');
  let errorReason: string | null = null;
  if (input.errorReason !== undefined) {
    if (typeof input.errorReason !== 'string') throw validationError('errorReason must be a string when supplied.');
    errorReason = input.errorReason.trim();
    if (!errorReason || errorReason.length > 1000) {
      throw validationError('errorReason must contain at most 1000 non-blank characters when supplied.');
    }
    if (input.targetStatus !== 'NEEDS_ATTENTION' && input.targetStatus !== 'FAILED') {
      throw validationError('errorReason is permitted only for NEEDS_ATTENTION or FAILED transitions.');
    }
  }
  return {
    targetStatus: input.targetStatus,
    expectedVersion: input.expectedVersion,
    result: input.result,
    hasResult,
    errorReason,
  };
}

function assertHumanCommandContext(context: CommandContext): void {
  if (
    context.principalType !== 'HUMAN_USER'
    || context.source !== 'HUMAN_UI'
    || context.delegatedByPrincipalId
  ) {
    throw new ForbiddenException('Work-item commands require a direct human user context.');
  }
}

@Injectable()
export class WorkItemService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async create(
    context: CommandContext,
    input: CreateWorkItemInput,
  ): Promise<{ workItem: WorkItemSummary; replayed: boolean }> {
    assertHumanCommandContext(context);
    const normalized = normalizeCreate(input);
    const payloadJson = encodedObject(normalized.payload, 'payload');
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({ command: 'work_item.create', ...normalized }))
      .digest('hex');

    return this.database.withTenantTransaction(context, async (client) => {
      const reservation = await client.query<{ id: string }>(
        `INSERT INTO hon.idempotency_records (
           organization_id, school_id, principal_id, idempotency_key, request_fingerprint, status, expires_at
         ) VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', now() + interval '24 hours')
         ON CONFLICT (organization_id, school_id, principal_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey, requestFingerprint],
      );
      if (!reservation.rowCount) {
        const existing = await this.loadIdempotencyRecord(client, context);
        if (existing.request_fingerprint !== requestFingerprint) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            detail: 'The idempotency key was already used for a different work-item creation command.',
          });
        }
        if (existing.status === 'COMPLETED' && existing.response_body) {
          return { workItem: existing.response_body, replayed: true };
        }
        throw new ConflictException({
          code: 'IDEMPOTENCY_IN_PROGRESS',
          detail: 'The matching work-item creation command is being processed.',
        });
      }

      // Assignment is deliberately absent from this command: clients cannot
      // nominate arbitrary principals, and no executor/worker is introduced.
      const created = await client.query<WorkItemRow>(
        `INSERT INTO hon.work_items (
           organization_id, school_id, work_type, status, subject_type, subject_id, payload, correlation_id
         ) VALUES ($1, $2, $3, 'READY', $4, $5::uuid, $6::jsonb, $7::uuid)
         RETURNING
           id,
           work_type AS "workType",
           status,
           subject_type AS "subjectType",
           subject_id AS "subjectId",
           version,
           created_at AS "createdAt",
           updated_at AS "updatedAt"`,
        [
          context.organizationId,
          context.schoolId,
          normalized.workType,
          normalized.subjectType,
          normalized.subjectId,
          payloadJson,
          context.correlationId,
        ],
      );
      const row = created.rows[0];
      if (!row) throw new Error('HON work-item insert did not return a record.');
      const workItem = toSummary(row);
      await this.recordEvidence(client, context, 'work_item.create', 'work_item.created', workItem, null);
      await this.completeIdempotency(client, context, HttpCreated, workItem);
      return { workItem, replayed: false };
    });
  }

  async transition(
    context: CommandContext,
    workItemId: string,
    input: TransitionWorkItemInput,
  ): Promise<{ workItem: WorkItemSummary; replayed: boolean }> {
    assertHumanCommandContext(context);
    if (!UUID.test(workItemId)) throw validationError('workItemId must be a UUID.');
    const normalized = normalizeTransition(input);
    const resultJson = normalized.hasResult ? encodedObject(normalized.result as Record<string, unknown>, 'result') : null;
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({ command: 'work_item.transition', workItemId, ...normalized }))
      .digest('hex');

    return this.database.withTenantTransaction(context, async (client) => {
      // The scoped FOR UPDATE lookup happens after the transaction-local RLS
      // context is installed, so another school's item is indistinguishable from absent.
      const currentResult = await client.query<WorkItemRow>(
        `SELECT
           id,
           work_type AS "workType",
           status,
           subject_type AS "subjectType",
           subject_id AS "subjectId",
           version,
           created_at AS "createdAt",
           updated_at AS "updatedAt"
         FROM hon.work_items
         WHERE id = $1::uuid
         FOR UPDATE`,
        [workItemId],
      );
      const current = currentResult.rows[0];
      if (!current) throw new NotFoundException('Work item was not found in this school.');
      if (!isWorkItemStatus(current.status)) throw new Error('HON work item query returned an invalid status.');

      const reservation = await client.query<{ id: string }>(
        `INSERT INTO hon.idempotency_records (
           organization_id, school_id, principal_id, idempotency_key, request_fingerprint, status, expires_at
         ) VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', now() + interval '24 hours')
         ON CONFLICT (organization_id, school_id, principal_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey, requestFingerprint],
      );
      if (!reservation.rowCount) {
        const existing = await this.loadIdempotencyRecord(client, context);
        if (existing.request_fingerprint !== requestFingerprint) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            detail: 'The idempotency key was already used for a different work-item transition command.',
          });
        }
        if (existing.status === 'COMPLETED' && existing.response_body) {
          return { workItem: existing.response_body, replayed: true };
        }
        throw new ConflictException({
          code: 'IDEMPOTENCY_IN_PROGRESS',
          detail: 'The matching work-item transition command is being processed.',
        });
      }

      if (normalized.expectedVersion !== current.version) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          detail: 'The work item has changed. Refresh it and retry with its current version and a new Idempotency-Key.',
        });
      }
      try {
        assertWorkItemTransition(current.status, normalized.targetStatus);
      } catch (error) {
        const code = error instanceof Error ? error.message : 'WORK_ITEM_TRANSITION_DENIED';
        throw new ConflictException({
          code,
          detail: code === 'WORK_ITEM_TERMINAL_REOPEN_DENIED'
            ? 'Completed and failed work items cannot be reopened by a transition command.'
            : `The transition from ${current.status} to ${normalized.targetStatus} is not allowed.`,
        });
      }

      const updatedResult = await client.query<WorkItemRow>(
        `UPDATE hon.work_items
         SET status = $2,
             result = CASE WHEN $3::boolean THEN $4::jsonb ELSE result END,
             error_reason = CASE WHEN $2 IN ('NEEDS_ATTENTION', 'FAILED') THEN $5 ELSE NULL END,
             version = version + 1,
             updated_at = now()
         WHERE id = $1::uuid
           AND version = $6
         RETURNING
           id,
           work_type AS "workType",
           status,
           subject_type AS "subjectType",
           subject_id AS "subjectId",
           version,
           created_at AS "createdAt",
           updated_at AS "updatedAt"`,
        [workItemId, normalized.targetStatus, normalized.hasResult, resultJson, normalized.errorReason, normalized.expectedVersion],
      );
      const updated = updatedResult.rows[0];
      if (!updated) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          detail: 'The work item changed before this transition could be recorded.',
        });
      }
      const workItem = toSummary(updated);
      const priorState = {
        status: current.status,
        version: current.version,
      };
      await this.recordEvidence(client, context, 'work_item.transition', 'work_item.transitioned', workItem, priorState);
      await this.completeIdempotency(client, context, 200, workItem);
      return { workItem, replayed: false };
    });
  }

  async list(context: TenantTransactionContext, requestedLimit?: number): Promise<WorkItemSummary[]> {
    const limit = requestedLimit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw validationError('limit must be a whole number from 1 through 50.');
    }
    return this.database.withTenantTransaction(context, async (client) => {
      const rows = await client.query<WorkItemRow>(
        `SELECT
           id,
           work_type AS "workType",
           status,
           subject_type AS "subjectType",
           subject_id AS "subjectId",
           version,
           created_at AS "createdAt",
           updated_at AS "updatedAt"
         FROM hon.work_items
         ORDER BY updated_at DESC, id DESC
         LIMIT $1`,
        [limit],
      );
      return rows.rows.map(toSummary);
    });
  }

  private async loadIdempotencyRecord(client: PoolClient, context: CommandContext): Promise<IdempotencyRecord> {
    const existing = await client.query<IdempotencyRecord>(
      `SELECT request_fingerprint, status, response_body
       FROM hon.idempotency_records
       WHERE organization_id = $1
         AND school_id = $2
         AND principal_id = $3
         AND idempotency_key = $4
       FOR UPDATE`,
      [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey],
    );
    const record = existing.rows[0];
    if (!record) throw new Error('HON work-item idempotency record unexpectedly missing.');
    return record;
  }

  private async recordEvidence(
    client: PoolClient,
    context: CommandContext,
    actionCode: 'work_item.create' | 'work_item.transition',
    eventType: 'work_item.created' | 'work_item.transitioned',
    workItem: WorkItemSummary,
    priorState: Record<string, unknown> | null,
  ): Promise<void> {
    const eventPayload = {
      workItemId: workItem.id,
      workType: workItem.workType,
      status: workItem.status,
      subjectType: workItem.subjectType ?? null,
      subjectId: workItem.subjectId ?? null,
      version: workItem.version,
    };
    await client.query(
      `INSERT INTO hon.audit_events (
         organization_id, school_id, actor_principal_id, source, action_code,
         entity_type, entity_id, prior_state, next_state, result,
         request_id, correlation_id, action_request_id, occurred_at
       ) VALUES (
         $1, $2, $3, $4, $5, 'WORK_ITEM', $6::uuid, $7::jsonb, $8::jsonb, 'SUCCEEDED',
         $9::uuid, $10::uuid, NULL, now()
       )`,
      [
        context.organizationId,
        context.schoolId,
        context.principalId,
        context.source,
        actionCode,
        workItem.id,
        priorState === null ? null : JSON.stringify(priorState),
        JSON.stringify(eventPayload),
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
         $1::uuid, $2, $3, $4, 1,
         'WORK_ITEM', $5::uuid, $6, $7::uuid, $8::uuid, $9::jsonb
       )`,
      [
        randomUUID(),
        context.organizationId,
        context.schoolId,
        eventType,
        workItem.id,
        workItem.version,
        context.correlationId,
        context.requestId,
        JSON.stringify(eventPayload),
      ],
    );
  }

  private async completeIdempotency(
    client: PoolClient,
    context: CommandContext,
    responseStatus: number,
    workItem: WorkItemSummary,
  ): Promise<void> {
    await client.query(
      `UPDATE hon.idempotency_records
       SET status = 'COMPLETED', response_status = $5, response_body = $6::jsonb
       WHERE organization_id = $1
         AND school_id = $2
         AND principal_id = $3
         AND idempotency_key = $4`,
      [
        context.organizationId,
        context.schoolId,
        context.principalId,
        context.idempotencyKey,
        responseStatus,
        JSON.stringify(workItem),
      ],
    );
  }
}

const HttpCreated = 201;
