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
  PLANNED_ABSENCE_REQUEST_STATUSES,
  PLANNED_ABSENCE_REVIEW_DECISIONS,
  validatePlannedAbsenceReviewInput,
  type PlannedAbsenceReviewContext,
  type DecidePlannedAbsenceRequestInput,
  type PlannedAbsenceRequestStatus,
  type PlannedAbsenceReviewDecision,
  type PlannedAbsenceReviewSummary,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface PlannedAbsenceRequestRow {
  id: string;
  studentProfileId: string;
  startsAt: Date | string;
  endsAt: Date | string;
  reason: string | null;
  status: PlannedAbsenceRequestStatus;
  reviewedByPrincipalId: string | null;
  reviewedAt: Date | string | null;
  reviewNote: string | null;
  version: number;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface IdempotencyRecord {
  request_fingerprint: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  response_body: PlannedAbsenceReviewSummary | null;
}

interface NormalizedDecisionInput {
  decision: PlannedAbsenceReviewDecision;
  reviewNote: string;
  expectedVersion: number;
}

function validationError(detail: string): BadRequestException {
  return new BadRequestException({ code: 'VALIDATION_FAILED', detail });
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeInput(input: DecidePlannedAbsenceRequestInput): NormalizedDecisionInput {
  try { validatePlannedAbsenceReviewInput(input); } catch { throw validationError('Only a bounded decision, nonempty review note and expected version are accepted.'); }
  if (!input || !PLANNED_ABSENCE_REVIEW_DECISIONS.includes(input.decision)) {
    throw validationError('decision must be APPROVED or DECLINED.');
  }
  if (typeof input.reviewNote !== 'string' || input.reviewNote.length > 1000) {
    throw validationError('reviewNote is required and cannot exceed 1000 characters.');
  }
  const reviewNote = input.reviewNote.trim();
  if (!reviewNote) throw validationError('reviewNote is required and cannot be blank.');
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw validationError('expectedVersion must be a positive whole number.');
  }
  return { decision: input.decision, reviewNote, expectedVersion: input.expectedVersion };
}

function toSummary(row: PlannedAbsenceRequestRow): PlannedAbsenceReviewSummary {
  if (!PLANNED_ABSENCE_REQUEST_STATUSES.includes(row.status)) {
    throw new Error('HON planned absence request query returned an invalid status.');
  }
  if (!PLANNED_ABSENCE_REVIEW_DECISIONS.includes(row.status as PlannedAbsenceReviewDecision)
    || !row.reviewedByPrincipalId || !row.reviewedAt || row.reviewNote === null) {
    throw new Error('HON planned absence review query returned incomplete review facts.');
  }
  return {
    id: row.id,
    studentProfileId: row.studentProfileId,
    startsAt: asIso(row.startsAt),
    endsAt: asIso(row.endsAt),
    ...(row.reason === null ? {} : { reason: row.reason }),
    status: row.status as PlannedAbsenceReviewDecision,
    reviewedByPrincipalId: row.reviewedByPrincipalId,
    reviewedAt: asIso(row.reviewedAt),
    reviewNote: row.reviewNote,
    version: row.version,
    createdAt: asIso(row.createdAt),
    updatedAt: asIso(row.updatedAt),
  };
}

@Injectable()
export class PlannedAbsenceReviewService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  /**
   * Reviews exactly one submitted parent/Eian absence request. This is a human
   * staff decision record only: it does not change booking, attendance, makeup,
   * payment, or communication state, and it is not Action Engine executable.
   */
  async decide(
    context: PlannedAbsenceReviewContext,
    requestId: string,
    input: DecidePlannedAbsenceRequestInput,
  ): Promise<{ plannedAbsenceRequest: PlannedAbsenceReviewSummary; replayed: boolean }> {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI') {
      throw new ForbiddenException('Planned absence review is a human staff command.');
    }
    if (context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException('Planned absence review cannot be proposed or executed through delegated actions.');
    }
    if (typeof context.externalSubject !== 'string' || !context.externalSubject.trim() || context.externalSubject.length > 200) throw new ForbiddenException('Verified current human subject is required.');
    if (!UUID.test(requestId)) throw validationError('requestId must be a UUID.');

    const normalized = normalizeInput(input);
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({ requestId, ...normalized }))
      .digest('hex');

    return this.database.withTenantTransaction(context, async (client) => {
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id',$3,true),set_config('app.hon_delegated_by_principal_id',$4,true)", [context.source, context.externalSubject, context.actionRequestId ?? '', context.delegatedByPrincipalId ?? '']);
      await client.query('SELECT hon.lock_planned_absence_review_actor($1)', [context.externalSubject]);
      // The lock lookup runs only after transaction-local tenant context is set.
      // RLS therefore makes an out-of-scope request indistinguishable from absent.
      const currentResult = await client.query<PlannedAbsenceRequestRow>(
        `SELECT
           id,
           student_profile_id AS "studentProfileId",
           starts_at AS "startsAt",
           ends_at AS "endsAt",
           reason,
           status::text AS status,
           reviewed_by_principal_id AS "reviewedByPrincipalId",
           reviewed_at AS "reviewedAt",
           review_note AS "reviewNote",
           version,
           created_at AS "createdAt",
           updated_at AS "updatedAt"
         FROM hon.planned_absence_requests
         WHERE id = $1::uuid
         FOR UPDATE`,
        [requestId],
      );
      const current = currentResult.rows[0];
      if (!current) throw new NotFoundException('Planned absence request was not found in this school.');
      if (!PLANNED_ABSENCE_REQUEST_STATUSES.includes(current.status)) {
        throw new Error('HON planned absence request query returned an invalid status.');
      }

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
        if (!record) throw new Error('HON planned-absence review idempotency record unexpectedly missing.');
        if (record.request_fingerprint !== requestFingerprint) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            detail: 'The idempotency key was already used for a different planned absence review decision.',
          });
        }
        if (record.status === 'COMPLETED' && record.response_body) {
          return { plannedAbsenceRequest: record.response_body, replayed: true };
        }
        throw new ConflictException({
          code: 'IDEMPOTENCY_IN_PROGRESS',
          detail: 'The matching planned absence review decision is being processed.',
        });
      }

      // A new idempotency key must observe both the exact submitted state and
      // the version the reviewer saw. The UPDATE repeats both predicates as a
      // final guard, even though the RLS-scoped row lock serializes contenders.
      if (current.status !== 'SUBMITTED') {
        throw new ConflictException({
          code: 'PLANNED_ABSENCE_REQUEST_NOT_SUBMITTED',
          detail: 'Only a submitted planned absence request can be reviewed.',
        });
      }
      if (normalized.expectedVersion !== current.version) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          detail: 'The planned absence request has changed. Refresh it and retry with its current version and a new Idempotency-Key.',
        });
      }

      const updatedResult = await client.query<PlannedAbsenceRequestRow>(
        `UPDATE hon.planned_absence_requests
         SET status = $2::hon.planned_absence_request_status,
             reviewed_by_principal_id = $3::uuid,
             reviewed_at = now(),
             review_note = $4,
             version = version + 1,
             updated_at = now()
         WHERE id = $1::uuid
           AND status = 'SUBMITTED'::hon.planned_absence_request_status
           AND version = $5
         RETURNING
           id,
           student_profile_id AS "studentProfileId",
           starts_at AS "startsAt",
           ends_at AS "endsAt",
           reason,
           status::text AS status,
           reviewed_by_principal_id AS "reviewedByPrincipalId",
           reviewed_at AS "reviewedAt",
           review_note AS "reviewNote",
           version,
           created_at AS "createdAt",
           updated_at AS "updatedAt"`,
        [requestId, normalized.decision, context.principalId, normalized.reviewNote, normalized.expectedVersion],
      );
      const updated = updatedResult.rows[0];
      if (!updated) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          detail: 'The planned absence request changed before this review decision could be recorded.',
        });
      }
      const plannedAbsenceRequest = toSummary(updated);
      const priorState = {
        status: current.status,
        version: current.version,
        reviewedByPrincipalId: current.reviewedByPrincipalId,
        reviewedAt: current.reviewedAt === null ? null : asIso(current.reviewedAt),
        reviewNote: current.reviewNote,
      };
      const payload = {
        plannedAbsenceRequestId: plannedAbsenceRequest.id,
        studentProfileId: plannedAbsenceRequest.studentProfileId,
        decision: plannedAbsenceRequest.status,
        reviewNote: plannedAbsenceRequest.reviewNote,
        reviewedByPrincipalId: plannedAbsenceRequest.reviewedByPrincipalId,
        reviewedAt: plannedAbsenceRequest.reviewedAt,
        version: plannedAbsenceRequest.version,
      };

      // Audit, outbox, and idempotency completion are transactional with the
      // single request-record transition. No operational side effect is invoked.
      await client.query(
        `INSERT INTO hon.audit_events (
           organization_id, school_id, actor_principal_id, source, action_code,
           entity_type, entity_id, prior_state, next_state, result,
           request_id, correlation_id, action_request_id, occurred_at
         ) VALUES (
           $1, $2, $3, 'HUMAN_UI', 'schedule.planned_absence.decide',
           'PLANNED_ABSENCE_REQUEST', $4::uuid, $5::jsonb, $6::jsonb, 'SUCCEEDED',
           $7::uuid, $8::uuid, NULL, now()
         )`,
        [
          context.organizationId,
          context.schoolId,
          context.principalId,
          plannedAbsenceRequest.id,
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
           $1::uuid, $2, $3, 'planned_absence.request.decided', 1,
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
         SET status = 'COMPLETED', response_status = 200, response_body = $5::jsonb
         WHERE organization_id = $1
           AND school_id = $2
           AND principal_id = $3
           AND idempotency_key = $4`,
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
