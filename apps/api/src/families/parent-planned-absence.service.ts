import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  CommandContext,
  CreatePlannedAbsenceRequestInput,
  PlannedAbsenceRequestStatus,
  PlannedAbsenceRequestSummary,
} from '@hon/contracts';
import type { ResolvedParentFamilyScope } from '../foundation/runtime-database.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

const MAX_FUTURE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMEZONE_QUALIFIED_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

interface PlannedAbsenceRequestRow {
  id: string;
  studentProfileId: string;
  startsAt: Date | string;
  endsAt: Date | string;
  reason: string | null;
  status: PlannedAbsenceRequestStatus;
  version: number;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface IdempotencyRecord {
  request_fingerprint: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  response_body: PlannedAbsenceRequestSummary | null;
}

interface NormalizedPlannedAbsenceInput {
  studentProfileId: string;
  startsAt: string;
  endsAt: string;
  reason?: string;
}

function validationError(detail: string): BadRequestException {
  return new BadRequestException({ code: 'VALIDATION_FAILED', detail });
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function parseStrictTimestamp(value: unknown, field: 'startsAt' | 'endsAt'): Date {
  if (typeof value !== 'string') {
    throw validationError(`${field} must be a timezone-qualified ISO 8601 timestamp.`);
  }
  const match = TIMEZONE_QUALIFIED_ISO_TIMESTAMP.exec(value);
  if (!match) {
    throw validationError('Planned absence timestamps must be timezone-qualified ISO 8601 values.');
  }
  const [datePart = '', timePart = ''] = value.split('T');
  const [yearPart = '', monthPart = '', dayPart = ''] = datePart.split('-');
  const [hourPart = '', minutePart = '', secondPart = ''] = timePart.slice(0, 8).split(':');
  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  const hour = Number(hourPart);
  const minute = Number(minutePart);
  const second = Number(secondPart);
  if (![year, month, day, hour, minute, second].every(Number.isInteger)
    || year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    throw validationError('Planned absence timestamps must be valid ISO 8601 values.');
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) throw validationError('Planned absence timestamps must be valid ISO 8601 values.');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw validationError('Planned absence timestamps must be valid ISO 8601 values.');
  }
  return parsed;
}

/**
 * Service-side validation mirrors the DTO so a caller cannot bypass the public
 * validation pipe through a direct invocation or a future transport adapter.
 */
function normalizeInput(input: CreatePlannedAbsenceRequestInput): NormalizedPlannedAbsenceInput {
  if (!input || typeof input.studentProfileId !== 'string' || !UUID.test(input.studentProfileId)) {
    throw validationError('studentProfileId must be a UUID.');
  }
  const startsAt = parseStrictTimestamp(input.startsAt, 'startsAt');
  const endsAt = parseStrictTimestamp(input.endsAt, 'endsAt');
  const now = Date.now();
  if (startsAt.getTime() <= now) {
    throw validationError('Planned absence requests must start in the future.');
  }
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw validationError('Planned absence end must be strictly later than its start.');
  }
  // Bound both the requested absence duration and how far in advance it may be
  // submitted. This keeps a request from becoming an unbounded future hold.
  if (endsAt.getTime() - startsAt.getTime() > MAX_FUTURE_WINDOW_MS
    || startsAt.getTime() > now + MAX_FUTURE_WINDOW_MS
    || endsAt.getTime() > now + MAX_FUTURE_WINDOW_MS) {
    throw validationError('Planned absence requests must fit within the next 90 days.');
  }

  if (input.reason !== undefined && typeof input.reason !== 'string') {
    throw validationError('Planned absence reason must be a string when provided.');
  }
  const reason = input.reason?.trim();
  if (reason !== undefined && !reason) {
    throw validationError('Planned absence reason cannot be blank when provided.');
  }
  if (reason && reason.length > 1000) {
    throw validationError('Planned absence reason must be at most 1000 characters.');
  }

  return {
    studentProfileId: input.studentProfileId,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    ...(reason ? { reason } : {}),
  };
}

function toSummary(row: PlannedAbsenceRequestRow): PlannedAbsenceRequestSummary {
  return {
    id: row.id,
    studentProfileId: row.studentProfileId,
    startsAt: asIso(row.startsAt),
    endsAt: asIso(row.endsAt),
    ...(row.reason === null ? {} : { reason: row.reason }),
    status: row.status,
    version: row.version,
    createdAt: asIso(row.createdAt),
    updatedAt: asIso(row.updatedAt),
  };
}

@Injectable()
export class ParentPlannedAbsenceService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async request(
    resolvedScope: ResolvedParentFamilyScope,
    requestedFamilyId: string,
    context: CommandContext,
    input: CreatePlannedAbsenceRequestInput,
  ): Promise<{ plannedAbsenceRequest: PlannedAbsenceRequestSummary; replayed: boolean }> {
    // This command is deliberately unavailable to automated, AI, integration,
    // staff, or Action Engine callers. The parent resolver and controller derive
    // every tenant/actor field; this invariant is repeated at the domain edge.
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI'
      || resolvedScope.familyId !== requestedFamilyId
      || resolvedScope.organizationId !== context.organizationId
      || resolvedScope.schoolId !== context.schoolId
      || resolvedScope.principalId !== context.principalId) {
      throw new ForbiddenException('HON parent access is not authorized for this planned absence request.');
    }

    const normalized = normalizeInput(input);
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({ familyId: requestedFamilyId, ...normalized }))
      .digest('hex');

    return this.database.withTenantTransaction(context, async (client) => {
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
        if (!record) throw new Error('HON planned-absence idempotency record unexpectedly missing.');
        if (record.request_fingerprint !== requestFingerprint) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            detail: 'The idempotency key was already used for a different planned absence request.',
          });
        }
        if (record.status === 'COMPLETED' && record.response_body) {
          return { plannedAbsenceRequest: record.response_body, replayed: true };
        }
        throw new ConflictException({
          code: 'IDEMPOTENCY_IN_PROGRESS',
          detail: 'The matching planned absence request is being processed.',
        });
      }

      // This query intentionally has no fallback to another same-school family:
      // exact selected family + primary family + STUDENT membership is required.
      const student = await client.query<{ id: string }>(
        `SELECT profile.id
         FROM hon.student_profiles AS profile
         JOIN hon.family_members AS member
           ON member.organization_id = profile.organization_id
          AND member.school_id = profile.school_id
          AND member.person_id = profile.person_id
          AND member.family_id = $1::uuid
          AND member.member_role = 'STUDENT'::hon.family_member_role
         WHERE profile.id = $2::uuid
           AND profile.primary_family_id = $1::uuid`,
        [requestedFamilyId, normalized.studentProfileId],
      );
      if (!student.rowCount) {
        // Do not reveal whether a supplied profile belongs to another family.
        throw new NotFoundException('Student profile was not found in this family.');
      }

      const inserted = await client.query<PlannedAbsenceRequestRow>(
        `INSERT INTO hon.planned_absence_requests (
           organization_id, school_id, family_id, student_profile_id,
           requested_by_principal_id, starts_at, ends_at, reason, status
         ) VALUES (
           $1, $2, $3::uuid, $4::uuid, $5::uuid, $6::timestamptz, $7::timestamptz,
           $8, 'SUBMITTED'::hon.planned_absence_request_status
         )
         RETURNING
           id,
           student_profile_id AS "studentProfileId",
           starts_at AS "startsAt",
           ends_at AS "endsAt",
           reason,
           status::text AS status,
           version,
           created_at AS "createdAt",
           updated_at AS "updatedAt"`,
        [
          context.organizationId,
          context.schoolId,
          requestedFamilyId,
          normalized.studentProfileId,
          context.principalId,
          normalized.startsAt,
          normalized.endsAt,
          normalized.reason ?? null,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('HON planned absence request insert did not return a record.');
      const plannedAbsenceRequest = toSummary(row);
      const payload = {
        plannedAbsenceRequestId: plannedAbsenceRequest.id,
        familyId: requestedFamilyId,
        studentProfileId: plannedAbsenceRequest.studentProfileId,
        startsAt: plannedAbsenceRequest.startsAt,
        endsAt: plannedAbsenceRequest.endsAt,
        status: plannedAbsenceRequest.status,
        version: plannedAbsenceRequest.version,
      };

      // Audit, outbox, and idempotency completion share the creation transaction.
      // There is intentionally no booking, attendance, makeup, cancellation,
      // provider, AI, or Action Engine mutation in this request foundation.
      await client.query(
        `INSERT INTO hon.audit_events (
           organization_id, school_id, actor_principal_id, source, action_code,
           entity_type, entity_id, prior_state, next_state, result,
           request_id, correlation_id, occurred_at
         ) VALUES (
           $1, $2, $3, $4, 'parent.planned_absence.request',
           'PLANNED_ABSENCE_REQUEST', $5::uuid, NULL, $6::jsonb, 'SUCCEEDED',
           $7::uuid, $8::uuid, now()
         )`,
        [
          context.organizationId,
          context.schoolId,
          context.principalId,
          context.source,
          plannedAbsenceRequest.id,
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
           $1::uuid, $2, $3, 'parent.planned_absence.requested', 1,
           'PLANNED_ABSENCE_REQUEST', $4::uuid, $5, $6::uuid, $7::uuid, $8::jsonb
         )`,
        [
          randomUUID(),
          context.organizationId,
          context.schoolId,
          plannedAbsenceRequest.id,
          plannedAbsenceRequest.version,
          context.correlationId,
          context.requestId,
          JSON.stringify(payload),
        ],
      );
      await client.query(
        `UPDATE hon.idempotency_records
         SET status = 'COMPLETED', response_status = 201, response_body = $5::jsonb
         WHERE organization_id = $1 AND school_id = $2 AND principal_id = $3 AND idempotency_key = $4`,
        [
          context.organizationId,
          context.schoolId,
          context.principalId,
          context.idempotencyKey,
          JSON.stringify(plannedAbsenceRequest),
        ],
      );

      return { plannedAbsenceRequest, replayed: false };
    });
  }
}
