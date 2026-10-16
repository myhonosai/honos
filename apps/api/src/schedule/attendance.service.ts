import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import {
  ATTENDANCE_STATUSES,
  ATTENDANCE_CATEGORIES,
  type AttendanceCategory,
  type AttendanceRecordSummary,
  type AttendanceStatus,
  type AttendanceCommandContext,
  type RecordAttendanceInput,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { markAttendanceHuman, requireAttendanceHuman } from './attendance-policy.service.js';
import { attendanceDatabaseError } from './attendance-database-error.js';

interface AttendanceRecordRow {
  id: string;
  classSessionId: string;
  studentProfileId: string;
  classBookingId: string | null;
  status: AttendanceStatus;
  category: AttendanceCategory;
  progressionPolicyVersion: number;
  progressionEnabled: boolean;
  progressionWeightMilli: number;
  progressionCreditMilli: number;
  recordedByPrincipalId: string | null;
  recordedAt: Date | string;
  note: string | null;
  version: number;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface NormalizedAttendanceInput {
  studentProfileId: string;
  status: AttendanceStatus;
  category: AttendanceCategory;
  note: string | null;
  expectedVersion: number | undefined;
}

type AttendanceCommandResult = { attendance: AttendanceRecordSummary; replayed: boolean; created: boolean };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

function validationError(detail: string): BadRequestException {
  return new BadRequestException({ code: 'VALIDATION_FAILED', detail });
}

function normalizeInput(input: RecordAttendanceInput): NormalizedAttendanceInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['studentProfileId', 'status', 'category', 'note', 'expectedVersion'].includes(key))
    || typeof input.studentProfileId !== 'string' || !UUID.test(input.studentProfileId)
    || (input.note !== undefined && input.note !== null && typeof input.note !== 'string')) {
    throw validationError('Attendance input is invalid.');
  }
  const note = input.note?.trim() || null;
  if (note && CONTROL.test(note)) throw validationError('Attendance note contains unsafe control characters.');
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
  const category = input.category === undefined ? (input.status === 'MAKEUP' ? 'MAKEUP_CLASS' : 'REGULAR_PARTICIPANT') : input.category;
  if (!ATTENDANCE_CATEGORIES.includes(category)) throw validationError('Attendance category is invalid.');
  return {
    category,
    studentProfileId: input.studentProfileId.toLowerCase(),
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
    category: row.category,
    progressionPolicyVersion: row.progressionPolicyVersion,
    progressionEnabled: row.progressionEnabled,
    progressionWeightMilli: row.progressionWeightMilli,
    progressionCreditMilli: row.progressionCreditMilli,
    ...(row.recordedByPrincipalId === null ? {} : { recordedByPrincipalId: row.recordedByPrincipalId }),
    recordedAt: asIso(row.recordedAt),
    ...(row.note === null ? {} : { note: row.note }),
    version: row.version,
    createdAt: asIso(row.createdAt),
    updatedAt: asIso(row.updatedAt),
  };
}

@Injectable()
export class AttendanceService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async get(context: AttendanceCommandContext, sessionId: string, studentProfileId: string): Promise<AttendanceRecordSummary | null> {
    requireAttendanceHuman(context);
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await markAttendanceHuman(client, context);
        await client.query('SELECT hon.lock_attendance_actor($1,$2)', [context.externalSubject, 'attendance.record']);
        const result = await client.query<AttendanceRecordRow>(`SELECT id, class_session_id AS "classSessionId", student_profile_id AS "studentProfileId", class_booking_id AS "classBookingId", status::text AS status, category, progression_policy_version AS "progressionPolicyVersion", progression_enabled AS "progressionEnabled", progression_weight_milli AS "progressionWeightMilli", progression_credit_milli AS "progressionCreditMilli", recorded_by_principal_id AS "recordedByPrincipalId", recorded_at AS "recordedAt", note, version, created_at AS "createdAt", updated_at AS "updatedAt" FROM hon.attendance_records WHERE class_session_id=$1::uuid AND student_profile_id=$2::uuid`, [sessionId, studentProfileId]);
        return result.rows[0] ? toAttendanceSummary(result.rows[0]) : null;
      });
    } catch (error) { return attendanceDatabaseError(error); }
  }

  async record(
    context: AttendanceCommandContext,
    sessionId: string,
    input: RecordAttendanceInput,
  ): Promise<AttendanceCommandResult> {
    requireAttendanceHuman(context);
    if (typeof context.idempotencyKey !== 'string' || !context.idempotencyKey || context.idempotencyKey.length > 200
      || context.idempotencyKey !== context.idempotencyKey.trim() || CONTROL.test(context.idempotencyKey)) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    }
    if (typeof sessionId !== 'string' || !UUID.test(sessionId)) throw validationError('Class session identifier is invalid.');
    const normalized = normalizeInput(input);
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await markAttendanceHuman(client, context);
        const result = await client.query<{ data: AttendanceCommandResult }>(
          'SELECT hon.record_attendance($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
          [context.externalSubject, sessionId.toLowerCase(), JSON.stringify(normalized), context.idempotencyKey, context.requestId, context.correlationId],
        );
        if (!result.rows[0]) throw new Error('Attendance command did not return a receipt.');
        return result.rows[0].data;
      });
    } catch (error) { return attendanceDatabaseError(error); }
  }
}
