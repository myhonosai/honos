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
  COMMUNICATION_MESSAGE_CHANNELS,
  COMMUNICATION_MESSAGE_LIFECYCLES,
  type CommandContext,
  type CommunicationMessageChannel,
  type CommunicationMessageLifecycle,
  type CommunicationMessageSummary,
  type CreateCommunicationMessageInput,
  type QueueCommunicationMessageInput,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { ListCommunicationMessagesDto } from './communication-message.dto.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

interface CommunicationMessageRow {
  id: string;
  recipientPersonId: string;
  channel: CommunicationMessageChannel;
  content: string;
  lifecycle: CommunicationMessageLifecycle;
  scheduledAt: Date | string | null;
  createdByPrincipalId: string;
  queuedByPrincipalId: string | null;
  version: number;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface IdempotencyRecord {
  request_fingerprint: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  response_body: CommunicationMessageSummary | null;
}

interface NormalizedCreateInput {
  recipientPersonId: string;
  channel: CommunicationMessageChannel;
  content: string;
  scheduledAt: string | null;
}

function validationError(detail: string): BadRequestException {
  return new BadRequestException({ code: 'VALIDATION_FAILED', detail });
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Rejects timezone-free, impossible-calendar, and impossible-clock scheduled instants. */
function normalizeOptionalInstant(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw validationError('scheduledAt must be an ISO 8601 timestamp with a timezone.');
  const normalized = value.trim();
  const match = ISO_INSTANT.exec(normalized);
  if (!match) throw validationError('scheduledAt must be an ISO 8601 timestamp with a timezone.');
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) {
    throw validationError('scheduledAt must be a valid ISO 8601 timestamp.');
  }
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) throw validationError('scheduledAt must be a valid ISO 8601 timestamp.');
  return parsed.toISOString();
}

/** Repeats transport validation so direct service callers cannot bypass command boundaries. */
function normalizeCreateInput(input: CreateCommunicationMessageInput): NormalizedCreateInput {
  if (!input || !UUID.test(input.recipientPersonId)) throw validationError('recipientPersonId must be a UUID.');
  if (!COMMUNICATION_MESSAGE_CHANNELS.includes(input.channel)) {
    throw validationError('channel must be SMS, EMAIL, or PUSH.');
  }
  if (typeof input.content !== 'string') throw validationError('content must be a string.');
  const content = input.content.trim();
  if (content.length < 1 || content.length > 4000) {
    throw validationError('content must contain between 1 and 4000 characters.');
  }
  return {
    recipientPersonId: input.recipientPersonId,
    channel: input.channel,
    content,
    scheduledAt: normalizeOptionalInstant(input.scheduledAt),
  };
}

function normalizeQueueInput(input: QueueCommunicationMessageInput): QueueCommunicationMessageInput {
  if (!input || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw validationError('expectedVersion must be a positive whole number.');
  }
  return { expectedVersion: input.expectedVersion };
}

function toSummary(row: CommunicationMessageRow): CommunicationMessageSummary {
  if (!COMMUNICATION_MESSAGE_CHANNELS.includes(row.channel)
    || !COMMUNICATION_MESSAGE_LIFECYCLES.includes(row.lifecycle)) {
    throw new Error('HON communication message query returned an invalid enum value.');
  }
  return {
    id: row.id,
    recipientPersonId: row.recipientPersonId,
    channel: row.channel,
    content: row.content,
    lifecycle: row.lifecycle,
    ...(row.scheduledAt === null ? {} : { scheduledAt: asIso(row.scheduledAt) }),
    createdByPrincipalId: row.createdByPrincipalId,
    ...(row.queuedByPrincipalId === null ? {} : { queuedByPrincipalId: row.queuedByPrincipalId }),
    version: row.version,
    createdAt: asIso(row.createdAt),
    updatedAt: asIso(row.updatedAt),
  };
}

const MESSAGE_COLUMNS = `
  id,
  recipient_person_id AS "recipientPersonId",
  channel::text AS channel,
  content,
  lifecycle::text AS lifecycle,
  scheduled_at AS "scheduledAt",
  created_by_principal_id AS "createdByPrincipalId",
  queued_by_principal_id AS "queuedByPrincipalId",
  version,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

@Injectable()
export class CommunicationMessageService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  /**
   * Creates a DRAFT only. This intentionally cannot inspect contact data, call
   * a provider, send/deliver a message, alter consent, create CRM work, invoke
   * AI, or invoke the Action Engine.
   */
  async create(
    context: CommandContext,
    input: CreateCommunicationMessageInput,
  ): Promise<{ message: CommunicationMessageSummary; replayed: boolean; created: boolean }> {
    this.assertHumanUi(context, 'creation');
    const normalized = normalizeCreateInput(input);
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({ command: 'communication.message.create', ...normalized }))
      .digest('hex');

    return this.database.withTenantTransaction(context, async (client) => {
      const replay = await this.reserveIdempotency(client, context, requestFingerprint);
      if (replay) return { message: replay, replayed: true, created: false };

      // This RLS-bound lookup makes a foreign-school person indistinguishable from an absent person.
      const recipient = await client.query<{ id: string }>('SELECT id FROM hon.people WHERE id = $1::uuid', [normalized.recipientPersonId]);
      if (!recipient.rowCount) throw new NotFoundException('Recipient person was not found in this school.');

      const inserted = await client.query<CommunicationMessageRow>(
        `INSERT INTO hon.communication_messages (
           organization_id, school_id, recipient_person_id, channel, content, lifecycle,
           scheduled_at, created_by_principal_id
         ) VALUES ($1, $2, $3::uuid, $4::hon.communication_message_channel, $5, 'DRAFT', $6::timestamptz, $7::uuid)
         RETURNING ${MESSAGE_COLUMNS}`,
        [
          context.organizationId,
          context.schoolId,
          normalized.recipientPersonId,
          normalized.channel,
          normalized.content,
          normalized.scheduledAt,
          context.principalId,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('HON communication message insert did not return a record.');
      const message = toSummary(row);
      await this.recordEvidence(client, context, message, null, 'CREATED', 201, 'communication.message.create', 'communication.message.drafted');
      return { message, replayed: false, created: true };
    });
  }

  /**
   * Queues exactly one DRAFT after checking the recipient's current, RLS-scoped
   * channel consent. It writes queue evidence only; delivery remains absent.
   */
  async queue(
    context: CommandContext,
    messageId: string,
    input: QueueCommunicationMessageInput,
  ): Promise<{ message: CommunicationMessageSummary; replayed: boolean }> {
    this.assertHumanUi(context, 'queueing');
    if (!UUID.test(messageId)) throw validationError('messageId must be a UUID.');
    const normalized = normalizeQueueInput(input);
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({ command: 'communication.message.queue', messageId, expectedVersion: normalized.expectedVersion }))
      .digest('hex');

    return this.database.withTenantTransaction(context, async (client) => {
      const replay = await this.reserveIdempotency(client, context, requestFingerprint);
      if (replay) return { message: replay, replayed: true };

      const selected = await client.query<CommunicationMessageRow>(
        `SELECT ${MESSAGE_COLUMNS}
         FROM hon.communication_messages
         WHERE id = $1::uuid
         FOR UPDATE`,
        [messageId],
      );
      const current = selected.rows[0];
      if (!current) throw new NotFoundException('Communication message was not found in this school.');
      const prior = toSummary(current);
      if (current.version !== normalized.expectedVersion) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          detail: 'Communication message version does not match expectedVersion.',
        });
      }
      if (current.lifecycle !== 'DRAFT') {
        throw new ConflictException({
          code: 'MESSAGE_NOT_DRAFT',
          detail: 'Only a DRAFT communication message can be queued.',
        });
      }

      const consent = await client.query<{ status: 'OPTED_IN' | 'OPTED_OUT' }>(
        `SELECT status::text AS status
         FROM hon.communication_consents
         WHERE person_id = $1::uuid
           AND channel = $2::hon.communication_consent_channel`,
        [current.recipientPersonId, current.channel],
      );
      if (consent.rows[0]?.status !== 'OPTED_IN') {
        throw new ForbiddenException({
          code: 'COMMUNICATION_CONSENT_REQUIRED',
          detail: 'The recipient has not currently opted in to this communication channel.',
        });
      }

      const updated = await client.query<CommunicationMessageRow>(
        `UPDATE hon.communication_messages
         SET lifecycle = 'QUEUED',
             queued_by_principal_id = $2::uuid,
             version = version + 1,
             updated_at = now()
         WHERE id = $1::uuid
         RETURNING ${MESSAGE_COLUMNS}`,
        [messageId, context.principalId],
      );
      const row = updated.rows[0];
      if (!row) throw new Error('HON communication message queue transition did not return a record.');
      const message = toSummary(row);
      await this.recordEvidence(client, context, message, prior, 'QUEUED', 200, 'communication.message.queue', 'communication.message.queued');
      return { message, replayed: false };
    });
  }

  /** Bounded school-scoped list without contact addresses, provider data, or delivery state. */
  async list(
    context: Pick<CommandContext, 'organizationId' | 'schoolId' | 'principalId' | 'principalType' | 'requestId'>,
    input: ListCommunicationMessagesDto,
  ): Promise<CommunicationMessageSummary[]> {
    const limit = input.limit === undefined ? 50 : Number(input.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw validationError('limit must be a whole number between 1 and 100.');
    }
    if (input.recipientPersonId !== undefined && !UUID.test(input.recipientPersonId)) {
      throw validationError('recipientPersonId must be a UUID.');
    }
    if (input.channel !== undefined && !COMMUNICATION_MESSAGE_CHANNELS.includes(input.channel)) {
      throw validationError('channel must be SMS, EMAIL, or PUSH.');
    }
    if (input.lifecycle !== undefined && !COMMUNICATION_MESSAGE_LIFECYCLES.includes(input.lifecycle)) {
      throw validationError('lifecycle must be DRAFT, QUEUED, or CANCELLED.');
    }
    return this.database.withTenantTransaction(context, async (client) => {
      if (input.recipientPersonId) {
        const recipient = await client.query<{ id: string }>('SELECT id FROM hon.people WHERE id = $1::uuid', [input.recipientPersonId]);
        if (!recipient.rowCount) throw new NotFoundException('Recipient person was not found in this school.');
      }
      const records = await client.query<CommunicationMessageRow>(
        `SELECT ${MESSAGE_COLUMNS}
         FROM hon.communication_messages
         WHERE ($1::uuid IS NULL OR recipient_person_id = $1::uuid)
           AND ($2::hon.communication_message_channel IS NULL OR channel = $2::hon.communication_message_channel)
           AND ($3::hon.communication_message_lifecycle IS NULL OR lifecycle = $3::hon.communication_message_lifecycle)
         ORDER BY created_at DESC, id DESC
         LIMIT $4`,
        [input.recipientPersonId ?? null, input.channel ?? null, input.lifecycle ?? null, limit],
      );
      return records.rows.map(toSummary);
    });
  }

  private assertHumanUi(context: CommandContext, operation: string): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI') {
      throw new ForbiddenException(`HON communication message ${operation} requires an authenticated human UI command.`);
    }
    if (context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException(`HON communication message ${operation} cannot be delegated or action-engine executed.`);
    }
  }

  private async reserveIdempotency(
    client: PoolClient,
    context: CommandContext,
    requestFingerprint: string,
  ): Promise<CommunicationMessageSummary | null> {
    const reservation = await client.query<{ id: string }>(
      `INSERT INTO hon.idempotency_records (
         organization_id, school_id, principal_id, idempotency_key, request_fingerprint, status, expires_at
       ) VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', now() + interval '24 hours')
       ON CONFLICT (organization_id, school_id, principal_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey, requestFingerprint],
    );
    if (reservation.rowCount) return null;
    const existing = await client.query<IdempotencyRecord>(
      `SELECT request_fingerprint, status, response_body
       FROM hon.idempotency_records
       WHERE organization_id = $1 AND school_id = $2 AND principal_id = $3 AND idempotency_key = $4
       FOR UPDATE`,
      [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey],
    );
    const record = existing.rows[0];
    if (!record) throw new Error('HON communication message idempotency record unexpectedly missing.');
    if (record.request_fingerprint !== requestFingerprint) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        detail: 'The idempotency key was already used for a different communication message command.',
      });
    }
    if (record.status === 'COMPLETED' && record.response_body) return record.response_body;
    throw new ConflictException({
      code: 'IDEMPOTENCY_IN_PROGRESS',
      detail: 'The matching communication message command is being processed.',
    });
  }

  private async recordEvidence(
    client: PoolClient,
    context: CommandContext,
    message: CommunicationMessageSummary,
    priorMessage: CommunicationMessageSummary | null,
    operation: 'CREATED' | 'QUEUED',
    responseStatus: 200 | 201,
    actionCode: 'communication.message.create' | 'communication.message.queue',
    eventType: 'communication.message.drafted' | 'communication.message.queued',
  ): Promise<void> {
    const payload = {
      communicationMessageId: message.id,
      recipientPersonId: message.recipientPersonId,
      channel: message.channel,
      lifecycle: message.lifecycle,
      scheduledAt: message.scheduledAt ?? null,
      version: message.version,
      operation,
    };
    await client.query(
      `INSERT INTO hon.audit_events (
         organization_id, school_id, actor_principal_id, source, action_code,
         entity_type, entity_id, prior_state, next_state, result,
         request_id, correlation_id, action_request_id, occurred_at
       ) VALUES (
         $1, $2, $3, 'HUMAN_UI', $4, 'COMMUNICATION_MESSAGE', $5::uuid,
         $6::jsonb, $7::jsonb, 'SUCCEEDED', $8::uuid, $9::uuid, NULL, now()
       )`,
      [
        context.organizationId,
        context.schoolId,
        context.principalId,
        actionCode,
        message.id,
        priorMessage === null ? null : JSON.stringify(priorMessage),
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
         $1::uuid, $2, $3, $4, 1, 'COMMUNICATION_MESSAGE', $5::uuid,
         $6, $7::uuid, $8::uuid, $9::jsonb
       )`,
      [
        randomUUID(),
        context.organizationId,
        context.schoolId,
        eventType,
        message.id,
        message.version,
        context.correlationId,
        context.requestId,
        JSON.stringify(payload),
      ],
    );
    await client.query(
      `UPDATE hon.idempotency_records
       SET status = 'COMPLETED', response_status = $5, response_body = $6::jsonb
       WHERE organization_id = $1 AND school_id = $2 AND principal_id = $3 AND idempotency_key = $4`,
      [
        context.organizationId,
        context.schoolId,
        context.principalId,
        context.idempotencyKey,
        responseStatus,
        JSON.stringify(message),
      ],
    );
  }
}
