import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  ATTENDANCE_STATUSES,
  type AttendanceRecordSummary,
  type AttendanceStatus,
  type CommandContext,
  type RecordAttendanceInput,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

interface AttendanceRecordRow {
  id: string;
  classSessionId: string;
  studentProfileId: string;
  classBookingId: string | null;
  status: AttendanceStatus;
  recordedByPrincipalId: string | null;
  recordedAt: Date | string;
  note: string | null;
  version: number;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface IdempotencyRecord {
  request_fingerprint: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  response_body: AttendanceRecordSummary | null;
}

interface NormalizedAttendanceInput {
  studentProfileId: string;
  status: AttendanceStatus;
  note: string | null;
  expectedVersion: number | undefined;
}

type AttendanceOperation = 'CREATED' | 'UPDATED';

function validationError(detail: string): BadRequestException {
  return new BadRequestException({ code: 'VALIDATION_FAILED', detail });
}

function normalizeInput(input: RecordAttendanceInput): NormalizedAttendanceInput {
  const note = input.note?.trim() || null;
  if (note && note.length > 2000) {
    throw validationError('Attendance note cannot exceed 2000 characters.');
  }
  if (!ATTENDANCE_STATUSES.includes(input.status)) {
    throw validationError('Attendance status is invalid.');
  }
  if (
    input.expectedVersion !== undefined
    && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
  ) {
    throw validationError('expectedVersion must be a positive whole number.');
  }
  return {
    studentProfileId: input.studentProfileId,
    status: input.status,
    note,
    expectedVersion: input.expectedVersion,
  };
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toAttendanceSummary(row: AttendanceRecordRow): AttendanceRecordSummary {
  return {
    id: row.id,
    classSessionId: row.classSessionId,
    studentProfileId: row.studentProfileId,
    ...(row.classBookingId === null ? {} : { classBookingId: row.classBookingId }),
    status: row.status,
    ...(row.recordedByPrincipalId === null ? {} : { recordedByPrincipalId: row.recordedByPrincipalId }),
    recordedAt: asIso(row.recordedAt),
    ...(row.note === null ? {} : { note: row.note }),
    version: row.version,
    createdAt: asIso(row.createdAt),
    updatedAt: asIso(row.updatedAt),
  };
}

function isExactState(
  existing: AttendanceRecordSummary,
  input: NormalizedAttendanceInput,
): boolean {
  return existing.status === input.status && (existing.note ?? null) === input.note;
}

@Injectable()
export class AttendanceService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async record(
    context: CommandContext,
    sessionId: string,
    input: RecordAttendanceInput,
  ): Promise<{ attendance: AttendanceRecordSummary; replayed: boolean; created: boolean }> {
    const normalized = normalizeInput(input);
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({ sessionId, ...normalized }))
      .digest('hex');

    return this.database.withTenantTransaction(context, async (client) => {
      // Both lookups execute inside the transaction-bound RLS scope. A cross-tenant
      // identifier is therefore indistinguishable from an identifier that does not exist.
      const session = await client.query<{ id: string }>(
        'SELECT id FROM hon.class_sessions WHERE id = $1::uuid',
        [sessionId],
      );
      if (!session.rowCount) {
        throw new NotFoundException('Class session was not found in this school.');
      }
      const student = await client.query<{ id: string }>(
        'SELECT id FROM hon.student_profiles WHERE id = $1::uuid',
        [normalized.studentProfileId],
      );
      if (!student.rowCount) {
        throw new NotFoundException('Student profile was not found in this school.');
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
        if (!record) throw new Error('HON attendance idempotency record unexpectedly missing.');
        if (record.request_fingerprint !== requestFingerprint) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            detail: 'The idempotency key was already used for a different attendance command.',
          });
        }
        if (record.status === 'COMPLETED' && record.response_body) {
          return { attendance: record.response_body, replayed: true, created: false };
        }
        throw new ConflictException({
          code: 'IDEMPOTENCY_IN_PROGRESS',
          detail: 'The matching attendance command is being processed.',
        });
      }

      // A transaction-scoped advisory lock serializes first-record races for this
      // session/student pair without weakening RLS or relying on unique-violation recovery.
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended($1::text || ':' || $2::text, 0)
         )`,
        [sessionId, normalized.studentProfileId],
      );
      const current = await client.query<AttendanceRecordRow>(
        `SELECT
           id,
           class_session_id AS "classSessionId",
           student_profile_id AS "studentProfileId",
           class_booking_id AS "classBookingId",
           status::text AS status,
           recorded_by_principal_id AS "recordedByPrincipalId",
           recorded_at AS "recordedAt",
           note,
           version,
           created_at AS "createdAt",
           updated_at AS "updatedAt"
         FROM hon.attendance_records
         WHERE class_session_id = $1::uuid AND student_profile_id = $2::uuid
         FOR UPDATE`,
        [sessionId, normalized.studentProfileId],
      );
      const currentRow = current.rows[0];

      if (currentRow) {
        const priorAttendance = toAttendanceSummary(currentRow);
        if (isExactState(priorAttendance, normalized)) {
          await this.completeIdempotencyRecord(client, context, priorAttendance, 200);
          return { attendance: priorAttendance, replayed: true, created: false };
        }
        if (normalized.expectedVersion === undefined) {
          throw new ConflictException({
            code: 'VERSION_REQUIRED',
            detail: 'expectedVersion is required to change an existing attendance state; use a new Idempotency-Key.',
          });
        }
        if (normalized.expectedVersion !== currentRow.version) {
          throw new ConflictException({
            code: 'VERSION_CONFLICT',
            detail: 'The attendance state has changed. Refresh the record and retry with its current version and a new Idempotency-Key.',
          });
        }

        const updated = await client.query<AttendanceRecordRow>(
          `UPDATE hon.attendance_records
           SET status = $3::hon.attendance_status,
               note = $4,
               recorded_by_principal_id = $5::uuid,
               recorded_at = now(),
               version = version + 1,
               updated_at = now()
           WHERE id = $1::uuid
             AND student_profile_id = $2::uuid
             AND version = $6
           RETURNING
             id,
             class_session_id AS "classSessionId",
             student_profile_id AS "studentProfileId",
             class_booking_id AS "classBookingId",
             status::text AS status,
             recorded_by_principal_id AS "recordedByPrincipalId",
             recorded_at AS "recordedAt",
             note,
             version,
             created_at AS "createdAt",
             updated_at AS "updatedAt"`,
          [
            currentRow.id,
            normalized.studentProfileId,
            normalized.status,
            normalized.note,
            context.principalId,
            normalized.expectedVersion,
          ],
        );
        const updatedRow = updated.rows[0];
        if (!updatedRow) {
          throw new ConflictException({
            code: 'VERSION_CONFLICT',
            detail: 'The attendance state changed before this command could be recorded.',
          });
        }
        const attendance = toAttendanceSummary(updatedRow);
        await this.recordMutationEvidence(
          client,
          context,
          priorAttendance,
          attendance,
          'UPDATED',
          200,
        );
        return { attendance, replayed: false, created: false };
      }

      const booking = await client.query<{ id: string }>(
        `SELECT id
         FROM hon.class_bookings
         WHERE class_session_id = $1::uuid AND student_profile_id = $2::uuid`,
        [sessionId, normalized.studentProfileId],
      );
      const created = await client.query<AttendanceRecordRow>(
        `INSERT INTO hon.attendance_records (
           organization_id, school_id, class_session_id, student_profile_id, class_booking_id,
           status, recorded_by_principal_id, note
         )
         VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid, $6::hon.attendance_status, $7::uuid, $8)
         RETURNING
           id,
           class_session_id AS "classSessionId",
           student_profile_id AS "studentProfileId",
           class_booking_id AS "classBookingId",
           status::text AS status,
           recorded_by_principal_id AS "recordedByPrincipalId",
           recorded_at AS "recordedAt",
           note,
           version,
           created_at AS "createdAt",
           updated_at AS "updatedAt"`,
        [
          context.organizationId,
          context.schoolId,
          sessionId,
          normalized.studentProfileId,
          booking.rows[0]?.id ?? null,
          normalized.status,
          context.principalId,
          normalized.note,
        ],
      );
      const createdRow = created.rows[0];
      if (!createdRow) throw new Error('HON attendance insert did not return a record.');
      const attendance = toAttendanceSummary(createdRow);
      await this.recordMutationEvidence(client, context, null, attendance, 'CREATED', 201);
      return { attendance, replayed: false, created: true };
    });
  }

  private async completeIdempotencyRecord(
    client: PoolClient,
    context: CommandContext,
    attendance: AttendanceRecordSummary,
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
        JSON.stringify(attendance),
      ],
    );
  }

  private async recordMutationEvidence(
    client: PoolClient,
    context: CommandContext,
    priorAttendance: AttendanceRecordSummary | null,
    attendance: AttendanceRecordSummary,
    operation: AttendanceOperation,
    responseStatus: number,
  ): Promise<void> {
    const payload = {
      attendanceRecordId: attendance.id,
      classSessionId: attendance.classSessionId,
      studentProfileId: attendance.studentProfileId,
      classBookingId: attendance.classBookingId ?? null,
      status: attendance.status,
      note: attendance.note ?? null,
      recordedByPrincipalId: attendance.recordedByPrincipalId ?? null,
      recordedAt: attendance.recordedAt,
      version: attendance.version,
      operation,
    };
    await client.query(
      `INSERT INTO hon.audit_events (
         organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
         prior_state, next_state, result, request_id, correlation_id, action_request_id, occurred_at
       )
       VALUES (
         $1, $2, $3, $4, 'attendance.record', 'ATTENDANCE_RECORD', $5::uuid,
         $6::jsonb, $7::jsonb, 'SUCCEEDED', $8::uuid, $9::uuid, $10::uuid, now()
       )`,
      [
        context.organizationId,
        context.schoolId,
        context.principalId,
        context.source,
        attendance.id,
        priorAttendance === null ? null : JSON.stringify(priorAttendance),
        JSON.stringify(attendance),
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
         $1::uuid, $2, $3, 'attendance.recorded', 1, 'ATTENDANCE_RECORD', $4::uuid,
         $5, $6::uuid, $7::uuid, $8::jsonb
       )`,
      [
        randomUUID(),
        context.organizationId,
        context.schoolId,
        attendance.id,
        attendance.version,
        context.correlationId,
        context.requestId,
        JSON.stringify(payload),
      ],
    );
    await this.completeIdempotencyRecord(client, context, attendance, responseStatus);
  }
}
