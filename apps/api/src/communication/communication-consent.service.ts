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
  COMMUNICATION_CONSENT_CHANNELS,
  COMMUNICATION_CONSENT_STATUSES,
  type CommandContext,
  type CommunicationConsentChannel,
  type CommunicationConsentSource,
  type CommunicationConsentStatus,
  type CommunicationConsentSummary,
  type RecordCommunicationConsentInput,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/**
 * Person/channel serialization key shared with every writer that must order against consent capture
 * (0217 hon.update_school_person). The person id is canonicalized through uuid so an uppercase selector
 * takes the same lock as the lowercase uuid text other writers derive.
 */
export const COMMUNICATION_CONSENT_ADVISORY_LOCK_SQL =
  `SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text || ':' || $2::text, 0))`;
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

interface CommunicationConsentRow {
  id: string;
  channel: CommunicationConsentChannel;
  status: CommunicationConsentStatus;
  source: CommunicationConsentSource;
  capturedAt: Date | string;
  version: number;
  updatedByPrincipalId: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface IdempotencyRecord {
  request_fingerprint: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  response_body: CommunicationConsentSummary | null;
}

interface NormalizedConsentInput {
  status: CommunicationConsentStatus;
  source: 'STAFF';
  capturedAt: string;
  expectedVersion: number | undefined;
}

function validationError(detail: string): BadRequestException {
  return new BadRequestException({ code: 'VALIDATION_FAILED', detail });
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Rejects timezone-free, impossible-calendar, and impossible-clock ISO instants. */
function normalizeCapturedAt(value: unknown): string {
  if (typeof value !== 'string') {
    throw validationError('capturedAt must be an ISO 8601 timestamp with a timezone.');
  }
  const normalized = value.trim();
  const match = ISO_INSTANT.exec(normalized);
  if (!match) throw validationError('capturedAt must be an ISO 8601 timestamp with a timezone.');

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth
    || hour > 23 || minute > 59 || second > 59) {
    throw validationError('capturedAt must be a valid ISO 8601 timestamp.');
  }
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw validationError('capturedAt must be a valid ISO 8601 timestamp.');
  }
  return parsed.toISOString();
}

/** Repeats transport checks to keep direct service callers within the same boundary. */
function normalizeInput(input: RecordCommunicationConsentInput): NormalizedConsentInput {
  if (!input || !COMMUNICATION_CONSENT_STATUSES.includes(input.status)) {
    throw validationError('status must be OPTED_IN or OPTED_OUT.');
  }
  if (input.source !== 'STAFF') {
    throw validationError('source must be STAFF for this staff consent endpoint.');
  }
  if (input.expectedVersion !== undefined
    && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)) {
    throw validationError('expectedVersion must be a positive whole number when provided.');
  }
  return {
    status: input.status,
    source: 'STAFF',
    capturedAt: normalizeCapturedAt(input.capturedAt),
    expectedVersion: input.expectedVersion,
  };
}

function toSummary(row: CommunicationConsentRow): CommunicationConsentSummary {
  if (!COMMUNICATION_CONSENT_CHANNELS.includes(row.channel)
    || !COMMUNICATION_CONSENT_STATUSES.includes(row.status)) {
    throw new Error('HON communication consent query returned an invalid enum value.');
  }
  return {
    channel: row.channel,
    status: row.status,
    source: row.source,
    capturedAt: asIso(row.capturedAt),
    version: row.version,
    updatedAt: asIso(row.updatedAt),
  };
}

@Injectable()
export class CommunicationConsentService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  /**
   * Records only one person's channel consent evidence. It cannot send a
   * message, call a provider, create a marketing automation, invoke AI, or
   * invoke the Action Engine.
   */
  async record(
    context: CommandContext,
    personId: string,
    channel: CommunicationConsentChannel,
    input: RecordCommunicationConsentInput,
  ): Promise<{ consent: CommunicationConsentSummary; replayed: boolean; created: boolean }> {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI') {
      throw new ForbiddenException('HON communication consent recording requires an authenticated human UI command.');
    }
    if (context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException('HON communication consent recording cannot be delegated or action-engine executed.');
    }
    if (!UUID.test(personId)) throw validationError('personId must be a UUID.');
    if (!COMMUNICATION_CONSENT_CHANNELS.includes(channel)) {
      throw validationError('channel must be SMS, EMAIL, or PUSH.');
    }

    const normalized = normalizeInput(input);
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({ command: 'communication.consent.record', personId, channel, ...normalized }))
      .digest('hex');

    return this.database.withTenantTransaction(context, async (client) => {
      // This lookup is deliberately executed in the transaction-bound RLS scope.
      // A person in another tenant is indistinguishable from an absent person.
      const person = await client.query<{ id: string }>(
        'SELECT id FROM hon.people WHERE id = $1::uuid',
        [personId],
      );
      if (!person.rowCount) throw new NotFoundException('Person was not found in this school.');

      const reservation = await client.query<{ id: string }>(
        `INSERT INTO hon.idempotency_records (
           organization_id, school_id, principal_id, idempotency_key, request_fingerprint, status, expires_at
         ) VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', now() + interval '24 hours')
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
        const existing = await client.query<IdempotencyRecord>(
          `SELECT request_fingerprint, status, response_body
           FROM hon.idempotency_records
           WHERE organization_id = $1 AND school_id = $2 AND principal_id = $3 AND idempotency_key = $4
           FOR UPDATE`,
          [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey],
        );
        const record = existing.rows[0];
        if (!record) throw new Error('HON communication consent idempotency record unexpectedly missing.');
        if (record.request_fingerprint !== requestFingerprint) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            detail: 'The idempotency key was already used for a different communication consent command.',
          });
        }
        if (record.status === 'COMPLETED' && record.response_body) {
          return { consent: record.response_body, replayed: true, created: false };
        }
        throw new ConflictException({
          code: 'IDEMPOTENCY_IN_PROGRESS',
          detail: 'The matching communication consent command is being processed.',
        });
      }

      // The unique person/channel constraint plus this scoped advisory lock makes
      // first-write races deterministic without weakening RLS.
      await client.query(COMMUNICATION_CONSENT_ADVISORY_LOCK_SQL, [personId, channel]);
      const currentResult = await client.query<CommunicationConsentRow>(
        `SELECT
           id,
           channel::text AS channel,
           status::text AS status,
           source::text AS source,
           captured_at AS "capturedAt",
           version,
           updated_by_principal_id AS "updatedByPrincipalId",
           created_at AS "createdAt",
           updated_at AS "updatedAt"
         FROM hon.communication_consents
         WHERE person_id = $1::uuid AND channel = $2::hon.communication_consent_channel
         FOR UPDATE`,
        [personId, channel],
      );
      const current = currentResult.rows[0];

      if (current) {
        if (normalized.expectedVersion === undefined) {
          throw new ConflictException({
            code: 'VERSION_REQUIRED',
            detail: 'expectedVersion is required to update an existing communication consent; use a new Idempotency-Key.',
          });
        }
        if (normalized.expectedVersion !== current.version) {
          throw new ConflictException({
            code: 'VERSION_CONFLICT',
            detail: 'The communication consent has changed. Refresh it and retry with its current version and a new Idempotency-Key.',
          });
        }
        const updatedResult = await client.query<CommunicationConsentRow>(
          `UPDATE hon.communication_consents
           SET status = $3::hon.communication_consent_status,
               source = $4::hon.communication_consent_source,
               captured_at = $5::timestamptz,
               updated_by_principal_id = $6::uuid,
               version = version + 1,
               updated_at = now()
           WHERE id = $1::uuid AND person_id = $2::uuid AND version = $7
           RETURNING
             id,
             channel::text AS channel,
             status::text AS status,
             source::text AS source,
             captured_at AS "capturedAt",
             version,
             updated_by_principal_id AS "updatedByPrincipalId",
             created_at AS "createdAt",
             updated_at AS "updatedAt"`,
          [current.id, personId, normalized.status, normalized.source, normalized.capturedAt, context.principalId, normalized.expectedVersion],
        );
        const updated = updatedResult.rows[0];
        if (!updated) {
          throw new ConflictException({
            code: 'VERSION_CONFLICT',
            detail: 'The communication consent changed before this command could be recorded.',
          });
        }
        const consent = toSummary(updated);
        await this.recordEvidence(client, context, personId, updated.id, toSummary(current), consent, 'UPDATED');
        return { consent, replayed: false, created: false };
      }

      if (normalized.expectedVersion !== undefined) {
        throw new ConflictException({
          code: 'VERSION_NOT_ALLOWED_ON_CREATE',
          detail: 'expectedVersion must be absent when creating a first communication consent for a channel.',
        });
      }
      const createdResult = await client.query<CommunicationConsentRow>(
        `INSERT INTO hon.communication_consents (
           organization_id, school_id, person_id, channel, status, source, captured_at, updated_by_principal_id
         ) VALUES ($1, $2, $3::uuid, $4::hon.communication_consent_channel,
                   $5::hon.communication_consent_status, $6::hon.communication_consent_source, $7::timestamptz, $8::uuid)
         RETURNING
           id,
           channel::text AS channel,
           status::text AS status,
           source::text AS source,
           captured_at AS "capturedAt",
           version,
           updated_by_principal_id AS "updatedByPrincipalId",
           created_at AS "createdAt",
           updated_at AS "updatedAt"`,
        [
          context.organizationId,
          context.schoolId,
          personId,
          channel,
          normalized.status,
          normalized.source,
          normalized.capturedAt,
          context.principalId,
        ],
      );
      const created = createdResult.rows[0];
      if (!created) throw new Error('HON communication consent insert did not return a record.');
      const consent = toSummary(created);
      await this.recordEvidence(client, context, personId, created.id, null, consent, 'CREATED');
      return { consent, replayed: false, created: true };
    });
  }

  /** Read projection is restricted to consent evidence fields for the selected RLS-scoped person. */
  async list(
    context: Pick<CommandContext, 'organizationId' | 'schoolId' | 'principalId' | 'principalType' | 'requestId'>,
    personId: string,
  ): Promise<CommunicationConsentSummary[]> {
    if (!UUID.test(personId)) throw validationError('personId must be a UUID.');
    return this.database.withTenantTransaction(context, async (client) => {
      const person = await client.query<{ id: string }>('SELECT id FROM hon.people WHERE id = $1::uuid', [personId]);
      if (!person.rowCount) throw new NotFoundException('Person was not found in this school.');
      const records = await client.query<CommunicationConsentRow>(
        `SELECT
           id,
           channel::text AS channel,
           status::text AS status,
           source::text AS source,
           captured_at AS "capturedAt",
           version,
           updated_by_principal_id AS "updatedByPrincipalId",
           created_at AS "createdAt",
           updated_at AS "updatedAt"
         FROM hon.communication_consents
         WHERE person_id = $1::uuid
         ORDER BY channel ASC`,
        [personId],
      );
      return records.rows.map(toSummary);
    });
  }

  private async recordEvidence(
    client: PoolClient,
    context: CommandContext,
    personId: string,
    consentId: string,
    priorConsent: CommunicationConsentSummary | null,
    consent: CommunicationConsentSummary,
    operation: 'CREATED' | 'UPDATED',
  ): Promise<void> {
    const payload = {
      communicationConsentId: consentId,
      personId,
      channel: consent.channel,
      status: consent.status,
      source: consent.source,
      capturedAt: consent.capturedAt,
      version: consent.version,
      operation,
    };
    await client.query(
      `INSERT INTO hon.audit_events (
         organization_id, school_id, actor_principal_id, source, action_code,
         entity_type, entity_id, prior_state, next_state, result,
         request_id, correlation_id, action_request_id, occurred_at
       ) VALUES (
         $1, $2, $3, 'HUMAN_UI', 'communication.consent.record',
         'COMMUNICATION_CONSENT', $4::uuid, $5::jsonb, $6::jsonb, 'SUCCEEDED',
         $7::uuid, $8::uuid, NULL, now()
       )`,
      [
        context.organizationId,
        context.schoolId,
        context.principalId,
        consentId,
        priorConsent === null ? null : JSON.stringify(priorConsent),
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
         $1::uuid, $2, $3, 'communication.consent.recorded', 1,
         'COMMUNICATION_CONSENT', $4::uuid, $5, $6::uuid, $7::uuid, $8::jsonb
       )`,
      [
        randomUUID(),
        context.organizationId,
        context.schoolId,
        consentId,
        consent.version,
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
        operation === 'CREATED' ? 201 : 200,
        JSON.stringify(consent),
      ],
    );
  }
}
