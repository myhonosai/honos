import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  CLASS_SESSION_BOOKING_POLICIES,
  type ClassSessionBookingPolicy,
  type ClassSessionSummary,
  type CommandContext,
  type CreateClassSessionInput,
  type ScheduleItemStatus,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

interface ClassSessionRow {
  id: string;
  programId: string;
  name: string;
  roomName: string | null;
  startsAt: Date | string;
  endsAt: Date | string;
  capacity: number;
  bookingPolicy: ClassSessionBookingPolicy;
  status: ScheduleItemStatus;
  version: number;
  createdAt: Date | string;
}

interface IdempotencyRecord {
  request_fingerprint: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  response_body: ClassSessionSummary | null;
}

interface NormalizedClassSessionInput {
  programId: string;
  name: string;
  roomName: string | null;
  startsAt: string;
  endsAt: string;
  capacity: number;
  bookingPolicy: ClassSessionBookingPolicy;
}

function validationError(detail: string): BadRequestException {
  return new BadRequestException({ code: 'VALIDATION_FAILED', detail });
}

function normalizeTimestamp(value: string, fieldName: string): string {
  const hasTimezone = /[Tt].*(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value);
  const timestamp = new Date(value);
  if (!hasTimezone || Number.isNaN(timestamp.getTime())) {
    throw validationError(`${fieldName} must be an ISO-8601 timestamp with a timezone.`);
  }
  return timestamp.toISOString();
}

function normalizeInput(input: CreateClassSessionInput): NormalizedClassSessionInput {
  const name = input.name.trim();
  const roomName = input.roomName?.trim() || null;
  const startsAt = normalizeTimestamp(input.startsAt, 'startsAt');
  const endsAt = normalizeTimestamp(input.endsAt, 'endsAt');

  if (!name) throw validationError('Class session name cannot be blank.');
  if (name.length > 160) throw validationError('Class session name cannot exceed 160 characters.');
  if (roomName && roomName.length > 160) throw validationError('Room name cannot exceed 160 characters.');
  if (!Number.isSafeInteger(input.capacity) || input.capacity < 1) {
    throw validationError('Class session capacity must be a positive whole number.');
  }
  if (!CLASS_SESSION_BOOKING_POLICIES.includes(input.bookingPolicy)) {
    throw validationError('Class session booking policy is invalid.');
  }
  if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    throw validationError('Class session endsAt must be after startsAt.');
  }

  return {
    programId: input.programId,
    name,
    roomName,
    startsAt,
    endsAt,
    capacity: input.capacity,
    bookingPolicy: input.bookingPolicy,
  };
}

function toClassSessionSummary(row: ClassSessionRow): ClassSessionSummary {
  return {
    id: row.id,
    programId: row.programId,
    name: row.name,
    ...(row.roomName === null ? {} : { roomName: row.roomName }),
    startsAt: row.startsAt instanceof Date ? row.startsAt.toISOString() : row.startsAt,
    endsAt: row.endsAt instanceof Date ? row.endsAt.toISOString() : row.endsAt,
    capacity: row.capacity,
    bookingPolicy: row.bookingPolicy,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

@Injectable()
export class ClassSessionService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async create(
    context: CommandContext,
    input: CreateClassSessionInput,
  ): Promise<{ classSession: ClassSessionSummary; replayed: boolean }> {
    const normalized = normalizeInput(input);
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify(normalized))
      .digest('hex');

    return this.database.withTenantTransaction(context, async (client) => {
      const program = await client.query<{ id: string }>(
        'SELECT id FROM hon.programs WHERE id = $1::uuid',
        [normalized.programId],
      );
      if (!program.rowCount) {
        throw new NotFoundException('Program was not found in this school.');
      }

      const reservation = await client.query<{ id: string }>(
        `INSERT INTO hon.idempotency_records (
           organization_id, school_id, principal_id, idempotency_key, request_fingerprint, status, expires_at
         )
         VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', now() + interval '24 hours')
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
           WHERE organization_id = $1
             AND school_id = $2
             AND principal_id = $3
             AND idempotency_key = $4
           FOR UPDATE`,
          [
            context.organizationId,
            context.schoolId,
            context.principalId,
            context.idempotencyKey,
          ],
        );
        const record = existing.rows[0];
        if (!record) throw new Error('HON class-session idempotency record unexpectedly missing.');
        if (record.request_fingerprint !== requestFingerprint) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            detail: 'The idempotency key was already used for a different class-session command.',
          });
        }
        if (record.status === 'COMPLETED' && record.response_body) {
          return { classSession: record.response_body, replayed: true };
        }
        throw new ConflictException({
          code: 'IDEMPOTENCY_IN_PROGRESS',
          detail: 'The matching class-session command is being processed.',
        });
      }

      const created = await client.query<ClassSessionRow>(
        `INSERT INTO hon.class_sessions (
           organization_id, school_id, program_id, name, room_name, starts_at, ends_at, capacity, booking_policy
         )
         VALUES ($1, $2, $3::uuid, $4, $5, $6::timestamptz, $7::timestamptz, $8, $9)
         RETURNING
           id,
           program_id AS "programId",
           name,
           room_name AS "roomName",
           starts_at AS "startsAt",
           ends_at AS "endsAt",
           capacity,
           booking_policy AS "bookingPolicy",
           status::text AS status,
           version,
           created_at AS "createdAt"`,
        [
          context.organizationId,
          context.schoolId,
          normalized.programId,
          normalized.name,
          normalized.roomName,
          normalized.startsAt,
          normalized.endsAt,
          normalized.capacity,
          normalized.bookingPolicy,
        ],
      );
      const row = created.rows[0];
      if (!row) throw new Error('HON class session insert did not return a record.');

      const classSession = toClassSessionSummary(row);
      const payload = {
        classSessionId: classSession.id,
        programId: classSession.programId,
        name: classSession.name,
        roomName: classSession.roomName ?? null,
        startsAt: classSession.startsAt,
        endsAt: classSession.endsAt,
        capacity: classSession.capacity,
        bookingPolicy: classSession.bookingPolicy,
        status: classSession.status,
        version: classSession.version,
      };

      await client.query(
        `INSERT INTO hon.audit_events (
           organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
           prior_state, next_state, result, request_id, correlation_id, action_request_id, occurred_at
         )
         VALUES (
           $1, $2, $3, $4, 'schedule.session.create', 'CLASS_SESSION', $5::uuid,
           NULL, $6::jsonb, 'SUCCEEDED', $7::uuid, $8::uuid, $9::uuid, now()
         )`,
        [
          context.organizationId,
          context.schoolId,
          context.principalId,
          context.source,
          classSession.id,
          JSON.stringify(payload),
          context.requestId,
          context.correlationId,
          context.actionRequestId ?? null,
        ],
      );
      await client.query(
        `INSERT INTO hon.outbox_events (
           id, organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id,
           aggregate_version, correlation_id, causation_id, payload
         )
         VALUES (
           $1::uuid, $2, $3, 'class_session.created', 1, 'CLASS_SESSION', $4::uuid,
           $5, $6::uuid, $7::uuid, $8::jsonb
         )`,
        [
          randomUUID(),
          context.organizationId,
          context.schoolId,
          classSession.id,
          classSession.version,
          context.correlationId,
          context.requestId,
          JSON.stringify(payload),
        ],
      );
      await client.query(
        `UPDATE hon.idempotency_records
         SET status = 'COMPLETED', response_status = 201, response_body = $5::jsonb
         WHERE organization_id = $1
           AND school_id = $2
           AND principal_id = $3
           AND idempotency_key = $4`,
        [
          context.organizationId,
          context.schoolId,
          context.principalId,
          context.idempotencyKey,
          JSON.stringify(classSession),
        ],
      );

      return { classSession, replayed: false };
    });
  }
}
