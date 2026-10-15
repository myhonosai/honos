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
  CLASS_BOOKING_KINDS,
  type ClassBookingKind,
  type ClassBookingStatus,
  type ClassSessionBookingPolicy,
  type ClassBookingSummary,
  type CommandContext,
  type CreateClassBookingInput,
  type ScheduleItemStatus,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

const STAFF_BOOKING_SOURCE = 'STAFF' as const;

type BookingOperation = 'CREATED';

interface ClassSessionRow {
  id: string;
  capacity: number;
  bookingPolicy: ClassSessionBookingPolicy;
  status: ScheduleItemStatus;
}

interface ClassBookingRow {
  id: string;
  classSessionId: string;
  studentProfileId: string;
  bookingKind: ClassBookingKind;
  status: ClassBookingStatus;
  source: 'STAFF' | 'PARENT_APP' | 'AUTOMATION' | 'INTEGRATION';
  bookedAt: Date | string;
  version: number;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface IdempotencyRecord {
  request_fingerprint: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  response_body: ClassBookingSummary | null;
}

interface NormalizedClassBookingInput {
  studentProfileId: string;
  bookingKind: ClassBookingKind;
}

function validationError(detail: string): BadRequestException {
  return new BadRequestException({ code: 'VALIDATION_FAILED', detail });
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeInput(input: CreateClassBookingInput): NormalizedClassBookingInput {
  if (!CLASS_BOOKING_KINDS.includes(input.bookingKind)) {
    throw validationError('Class booking kind is invalid.');
  }
  return {
    studentProfileId: input.studentProfileId,
    bookingKind: input.bookingKind,
  };
}

function toClassBookingSummary(
  row: ClassBookingRow,
  session: ClassSessionRow,
  activeSeatCount: number,
): ClassBookingSummary {
  return {
    id: row.id,
    classSessionId: row.classSessionId,
    studentProfileId: row.studentProfileId,
    bookingKind: row.bookingKind,
    status: row.status,
    source: row.source,
    bookedAt: asIso(row.bookedAt),
    version: row.version,
    createdAt: asIso(row.createdAt),
    updatedAt: asIso(row.updatedAt),
    // Preserve the session capacity facts with every command response/event.
    // WALK_IN may intentionally have activeSeatCount > sessionCapacity.
    sessionCapacity: session.capacity,
    bookingPolicy: session.bookingPolicy,
    activeSeatCount,
  };
}

@Injectable()
export class ClassBookingService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async create(
    context: CommandContext,
    sessionId: string,
    input: CreateClassBookingInput,
  ): Promise<{ booking: ClassBookingSummary; replayed: boolean; created: boolean }> {
    // This staff-only service is deliberately closed to future callers that
    // could otherwise supply an AI, automation, or untrusted public source.
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI') {
      throw new ForbiddenException('Class booking creation requires a human staff UI command.');
    }

    const normalized = normalizeInput(input);
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({ sessionId, ...normalized }))
      .digest('hex');

    return this.database.withTenantTransaction(context, async (client) => {
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
        if (!record) throw new Error('HON class-booking idempotency record unexpectedly missing.');
        if (record.request_fingerprint !== requestFingerprint) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            detail: 'The idempotency key was already used for a different class-booking command.',
          });
        }
        if (record.status === 'COMPLETED' && record.response_body) {
          return { booking: record.response_body, replayed: true, created: false };
        }
        throw new ConflictException({
          code: 'IDEMPOTENCY_IN_PROGRESS',
          detail: 'The matching class-booking command is being processed.',
        });
      }

      // This RLS-bound row lock serializes all booking decisions for the
      // session. The count below is therefore capacity-safe across concurrent
      // staff requests without taking a table-wide lock.
      const sessionResult = await client.query<ClassSessionRow>(
        `SELECT
           id,
           capacity,
           booking_policy AS "bookingPolicy",
           status::text AS status
         FROM hon.class_sessions
         WHERE id = $1::uuid
         FOR UPDATE`,
        [sessionId],
      );
      const session = sessionResult.rows[0];
      if (!session) {
        throw new NotFoundException('Class session was not found in this school.');
      }
      if (session.status === 'CANCELLED') {
        throw new ConflictException({
          code: 'SESSION_CANCELLED',
          detail: 'Cancelled class sessions cannot accept bookings.',
        });
      }

      // This is intentionally a separate RLS-scoped lookup: a foreign-school
      // student ID is indistinguishable from a non-existent student ID.
      const student = await client.query<{ id: string }>(
        'SELECT id FROM hon.student_profiles WHERE id = $1::uuid',
        [normalized.studentProfileId],
      );
      if (!student.rowCount) {
        throw new NotFoundException('Student profile was not found in this school.');
      }

      const current = await client.query<ClassBookingRow>(
        `SELECT
           id,
           class_session_id AS "classSessionId",
           student_profile_id AS "studentProfileId",
           booking_kind AS "bookingKind",
           status::text AS status,
           source,
           booked_at AS "bookedAt",
           version,
           created_at AS "createdAt",
         updated_at AS "updatedAt"
         FROM hon.class_bookings
         WHERE class_session_id = $1::uuid AND student_profile_id = $2::uuid`,
        [sessionId, normalized.studentProfileId],
      );
      const existingBooking = current.rows[0];

      const activeSeats = await this.activeSeatCount(client, sessionId);
      if (existingBooking) {
        const existing = toClassBookingSummary(existingBooking, session, activeSeats);
        // A retried semantically identical command with a new client key is
        // safe to acknowledge. A different kind cannot mutate the sole
        // session/student booking and must be an explicit future workflow.
        if (existing.bookingKind === normalized.bookingKind) {
          await this.completeIdempotencyRecord(client, context, existing, 200);
          return { booking: existing, replayed: true, created: false };
        }
        throw new ConflictException({
          code: 'BOOKING_ALREADY_EXISTS',
          detail: 'This student already has a booking for this class session.',
        });
      }

      // REQUIRED_BOOKING and OPTIONAL_BOOKING enforce capacity: seats at or
      // above capacity receive a durable WAITLISTED booking. WALK_IN records a
      // staff registration as BOOKED even over capacity; sessionCapacity and
      // activeSeatCount remain in the result/audit/outbox for downstream
      // operational visibility rather than silently discarding that metadata.
      const status: ClassBookingStatus = session.bookingPolicy === 'WALK_IN' || activeSeats < session.capacity
        ? 'BOOKED'
        : 'WAITLISTED';

      const inserted = await client.query<ClassBookingRow>(
        `INSERT INTO hon.class_bookings (
           organization_id, school_id, class_session_id, student_profile_id, booking_kind, status, source
         )
         VALUES ($1, $2, $3::uuid, $4::uuid, $5, $6::hon.class_booking_status, $7)
         RETURNING
           id,
           class_session_id AS "classSessionId",
           student_profile_id AS "studentProfileId",
           booking_kind AS "bookingKind",
           status::text AS status,
           source,
           booked_at AS "bookedAt",
           version,
           created_at AS "createdAt",
           updated_at AS "updatedAt"`,
        [
          context.organizationId,
          context.schoolId,
          sessionId,
          normalized.studentProfileId,
          normalized.bookingKind,
          status,
          STAFF_BOOKING_SOURCE,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('HON class booking insert did not return a record.');

      const activeSeatCount = activeSeats + (status === 'BOOKED' ? 1 : 0);
      const booking = toClassBookingSummary(row, session, activeSeatCount);
      await this.recordCreationEvidence(client, context, booking, 'CREATED', 201);
      return { booking, replayed: false, created: true };
    });
  }

  private async activeSeatCount(client: PoolClient, sessionId: string): Promise<number> {
    const count = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM hon.class_bookings
       WHERE class_session_id = $1::uuid
         AND status IN ('BOOKED'::hon.class_booking_status, 'CHECKED_IN'::hon.class_booking_status)`,
      [sessionId],
    );
    return Number(count.rows[0]?.count ?? '0');
  }

  private async completeIdempotencyRecord(
    client: PoolClient,
    context: CommandContext,
    booking: ClassBookingSummary,
    responseStatus: number,
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
        JSON.stringify(booking),
      ],
    );
  }

  private async recordCreationEvidence(
    client: PoolClient,
    context: CommandContext,
    booking: ClassBookingSummary,
    operation: BookingOperation,
    responseStatus: number,
  ): Promise<void> {
    const payload = {
      classBookingId: booking.id,
      classSessionId: booking.classSessionId,
      studentProfileId: booking.studentProfileId,
      bookingKind: booking.bookingKind,
      status: booking.status,
      source: booking.source,
      sessionCapacity: booking.sessionCapacity,
      bookingPolicy: booking.bookingPolicy,
      activeSeatCount: booking.activeSeatCount,
      bookedAt: booking.bookedAt,
      version: booking.version,
      operation,
    };
    await client.query(
      `INSERT INTO hon.audit_events (
         organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
         prior_state, next_state, result, request_id, correlation_id, action_request_id, occurred_at
       )
       VALUES (
         $1, $2, $3, $4, 'schedule.booking.create', 'CLASS_BOOKING', $5::uuid,
         NULL, $6::jsonb, 'SUCCEEDED', $7::uuid, $8::uuid, $9::uuid, now()
       )`,
      [
        context.organizationId,
        context.schoolId,
        context.principalId,
        context.source,
        booking.id,
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
         $1::uuid, $2, $3, 'class.booking.created', 1, 'CLASS_BOOKING', $4::uuid,
         $5, $6::uuid, $7::uuid, $8::jsonb
       )`,
      [
        randomUUID(),
        context.organizationId,
        context.schoolId,
        booking.id,
        booking.version,
        context.correlationId,
        context.requestId,
        JSON.stringify(payload),
      ],
    );
    await this.completeIdempotencyRecord(client, context, booking, responseStatus);
  }
}
