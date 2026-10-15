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
  TESTING_CANDIDATE_GRADE_RESULTS,
  TESTING_CANDIDATE_RESULTS,
  type CommandContext,
  type GradeTestingCandidateInput,
  type RegisterTestingCandidateInput,
  type TestingCandidateGradeResult,
  type TestingCandidateResult,
  type TestingCandidateSummary,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

interface CurriculumScopedRow {
  id: string;
  curriculumId: string;
}

interface TestingCandidateRow {
  id: string;
  testingEventId: string;
  studentCurriculumEnrollmentId: string;
  targetRankId: string;
  result: TestingCandidateResult;
  instructorNotes: string | null;
  version: number;
  createdAt: Date | string;
}

interface IdempotencyRecord {
  request_fingerprint: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  response_body: TestingCandidateSummary | null;
}

interface NormalizedCandidateInput {
  studentCurriculumEnrollmentId: string;
  targetRankId: string;
  instructorNotes: string | null;
}

interface NormalizedCandidateGradeInput {
  result: TestingCandidateGradeResult;
  instructorNotes: string | null;
  expectedVersion: number;
}

function validationError(detail: string): BadRequestException {
  return new BadRequestException({ code: 'VALIDATION_FAILED', detail });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function normalizeInput(input: RegisterTestingCandidateInput): NormalizedCandidateInput {
  if (!isUuid(input.studentCurriculumEnrollmentId)) {
    throw validationError('studentCurriculumEnrollmentId must be a UUID.');
  }
  if (!isUuid(input.targetRankId)) {
    throw validationError('targetRankId must be a UUID.');
  }

  if (input.instructorNotes && input.instructorNotes.length > 2000) {
    throw validationError('instructorNotes cannot exceed 2000 characters.');
  }
  const instructorNotes = input.instructorNotes?.trim() || null;

  return {
    studentCurriculumEnrollmentId: input.studentCurriculumEnrollmentId,
    targetRankId: input.targetRankId,
    instructorNotes,
  };
}

function normalizeGradeInput(input: GradeTestingCandidateInput): NormalizedCandidateGradeInput {
  if (!TESTING_CANDIDATE_GRADE_RESULTS.includes(input.result)) {
    throw validationError('Testing candidate grade result is invalid.');
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw validationError('expectedVersion must be a positive whole number.');
  }
  if (input.instructorNotes && input.instructorNotes.length > 2000) {
    throw validationError('instructorNotes cannot exceed 2000 characters.');
  }

  return {
    result: input.result,
    instructorNotes: input.instructorNotes?.trim() || null,
    expectedVersion: input.expectedVersion,
  };
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toSummary(row: TestingCandidateRow): TestingCandidateSummary {
  if (!TESTING_CANDIDATE_RESULTS.includes(row.result)) {
    throw new Error('HON testing candidate query returned an invalid result.');
  }
  return {
    id: row.id,
    testingEventId: row.testingEventId,
    studentCurriculumEnrollmentId: row.studentCurriculumEnrollmentId,
    targetRankId: row.targetRankId,
    result: row.result,
    ...(row.instructorNotes === null ? {} : { instructorNotes: row.instructorNotes }),
    version: row.version,
    createdAt: asIso(row.createdAt),
  };
}

@Injectable()
export class TestingCandidateService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async register(
    context: CommandContext,
    testingEventId: string,
    input: RegisterTestingCandidateInput,
  ): Promise<{ candidate: TestingCandidateSummary; replayed: boolean }> {
    const normalized = normalizeInput(input);
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({ testingEventId, ...normalized }))
      .digest('hex');

    return this.database.withTenantTransaction(context, async (client) => {
      // These dependency reads deliberately execute after tenant context is bound.
      // RLS therefore makes an out-of-scope identifier indistinguishable from absent data.
      const testingEvent = await this.requireCurriculumScopedRecord(
        client,
        'hon.testing_events',
        testingEventId,
        'Testing event was not found in this school.',
      );
      const enrollment = await this.requireCurriculumScopedRecord(
        client,
        'hon.student_curriculum_enrollments',
        normalized.studentCurriculumEnrollmentId,
        'Student curriculum enrollment was not found in this school.',
      );
      const targetRank = await this.requireCurriculumScopedRecord(
        client,
        'hon.curriculum_ranks',
        normalized.targetRankId,
        'Target rank was not found in this school.',
      );

      if (
        testingEvent.curriculumId !== enrollment.curriculumId
        || testingEvent.curriculumId !== targetRank.curriculumId
      ) {
        throw validationError(
          'The testing event, student curriculum enrollment, and target rank must belong to the same curriculum.',
        );
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
        if (!record) throw new Error('HON testing candidate idempotency record unexpectedly missing.');
        if (record.request_fingerprint !== requestFingerprint) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            detail: 'The idempotency key was already used for a different testing-candidate command.',
          });
        }
        if (record.status === 'COMPLETED' && record.response_body) {
          return { candidate: record.response_body, replayed: true };
        }
        throw new ConflictException({
          code: 'IDEMPOTENCY_IN_PROGRESS',
          detail: 'The matching testing-candidate command is being processed.',
        });
      }

      // Serialize first-registration races. The database uniqueness constraint remains
      // authoritative; the lock supplies a deterministic command-level conflict instead
      // of leaking a raw unique-violation response.
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended($1::text || ':' || $2::text, 0)
         )`,
        [testingEventId, normalized.studentCurriculumEnrollmentId],
      );
      const existingCandidate = await client.query<{ id: string }>(
        `SELECT id
         FROM hon.testing_candidates
         WHERE testing_event_id = $1::uuid
           AND student_curriculum_enrollment_id = $2::uuid
         FOR KEY SHARE`,
        [testingEventId, normalized.studentCurriculumEnrollmentId],
      );
      if (existingCandidate.rowCount) {
        throw new ConflictException({
          code: 'TESTING_CANDIDATE_ALREADY_REGISTERED',
          detail: 'This student curriculum enrollment is already registered for the testing event.',
        });
      }

      // Registration is intentionally only a pending candidacy. It does not create a
      // promotion decision, evaluate criteria, change rank, or invoke any provider.
      const inserted = await client.query<TestingCandidateRow>(
        `INSERT INTO hon.testing_candidates (
           organization_id, school_id, testing_event_id, student_curriculum_enrollment_id,
           target_rank_id, result, instructor_notes
         )
         VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid, 'PENDING'::hon.testing_candidate_result, $6)
         RETURNING
           id,
           testing_event_id AS "testingEventId",
           student_curriculum_enrollment_id AS "studentCurriculumEnrollmentId",
           target_rank_id AS "targetRankId",
           result::text AS result,
           instructor_notes AS "instructorNotes",
           version,
           created_at AS "createdAt"`,
        [
          context.organizationId,
          context.schoolId,
          testingEventId,
          normalized.studentCurriculumEnrollmentId,
          normalized.targetRankId,
          normalized.instructorNotes,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('HON testing candidate insert did not return a record.');
      const candidate = toSummary(row);

      const payload = {
        testingCandidateId: candidate.id,
        testingEventId: candidate.testingEventId,
        studentCurriculumEnrollmentId: candidate.studentCurriculumEnrollmentId,
        targetRankId: candidate.targetRankId,
        result: candidate.result,
        instructorNotes: candidate.instructorNotes ?? null,
        version: candidate.version,
      };
      await client.query(
        `INSERT INTO hon.audit_events (
           organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
           prior_state, next_state, result, request_id, correlation_id, action_request_id, occurred_at
         )
         VALUES (
           $1, $2, $3, $4, 'testing.candidate.register', 'TESTING_CANDIDATE', $5::uuid,
           NULL, $6::jsonb, 'SUCCEEDED', $7::uuid, $8::uuid, $9::uuid, now()
         )`,
        [
          context.organizationId,
          context.schoolId,
          context.principalId,
          context.source,
          candidate.id,
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
           $1::uuid, $2, $3, 'testing.candidate.registered', 1, 'TESTING_CANDIDATE', $4::uuid,
           $5, $6::uuid, $7::uuid, $8::jsonb
         )`,
        [
          randomUUID(),
          context.organizationId,
          context.schoolId,
          candidate.id,
          candidate.version,
          context.correlationId,
          context.requestId,
          JSON.stringify(payload),
        ],
      );
      await this.completeIdempotencyRecord(client, context, candidate);

      return { candidate, replayed: false };
    });
  }

  /**
   * Records only a human instructor's assessment of a candidate. This command
   * deliberately does not decide promotion, advance an enrollment rank, or
   * create an Action Engine proposal; each is an independent workflow.
   */
  async grade(
    context: CommandContext,
    candidateId: string,
    input: GradeTestingCandidateInput,
  ): Promise<{ candidate: TestingCandidateSummary; replayed: boolean }> {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI') {
      throw new ForbiddenException('Testing candidate grading is a human-only instructor command.');
    }
    if (!isUuid(candidateId)) {
      throw validationError('candidateId must be a UUID.');
    }

    const normalized = normalizeGradeInput(input);
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({ candidateId, ...normalized }))
      .digest('hex');

    return this.database.withTenantTransaction(context, async (client) => {
      // The lookup is inside the transaction-bound RLS scope, so an identifier
      // from another school is indistinguishable from one that does not exist.
      const current = await client.query<TestingCandidateRow>(
        `SELECT
           id,
           testing_event_id AS "testingEventId",
           student_curriculum_enrollment_id AS "studentCurriculumEnrollmentId",
           target_rank_id AS "targetRankId",
           result::text AS result,
           instructor_notes AS "instructorNotes",
           version,
           created_at AS "createdAt"
         FROM hon.testing_candidates
         WHERE id = $1::uuid
         FOR UPDATE`,
        [candidateId],
      );
      const currentRow = current.rows[0];
      if (!currentRow) {
        throw new NotFoundException('Testing candidate was not found in this school.');
      }
      const priorCandidate = toSummary(currentRow);

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
        if (!record) throw new Error('HON testing candidate grade idempotency record unexpectedly missing.');
        if (record.request_fingerprint !== requestFingerprint) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            detail: 'The idempotency key was already used for a different testing-candidate grading command.',
          });
        }
        if (record.status === 'COMPLETED' && record.response_body) {
          return { candidate: record.response_body, replayed: true };
        }
        throw new ConflictException({
          code: 'IDEMPOTENCY_IN_PROGRESS',
          detail: 'The matching testing-candidate grading command is being processed.',
        });
      }

      // A matching completed key is replayed above. Thus every fresh mutation
      // has its own key and must match the version the instructor observed.
      if (normalized.expectedVersion !== currentRow.version) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          detail: 'The testing candidate has changed. Refresh it and retry with its current version and a new Idempotency-Key.',
        });
      }

      const updated = await client.query<TestingCandidateRow>(
        `UPDATE hon.testing_candidates
         SET result = $2::hon.testing_candidate_result,
             instructor_notes = $3,
             version = version + 1,
             updated_at = now()
         WHERE id = $1::uuid
           AND version = $4
         RETURNING
           id,
           testing_event_id AS "testingEventId",
           student_curriculum_enrollment_id AS "studentCurriculumEnrollmentId",
           target_rank_id AS "targetRankId",
           result::text AS result,
           instructor_notes AS "instructorNotes",
           version,
           created_at AS "createdAt"`,
        [candidateId, normalized.result, normalized.instructorNotes, normalized.expectedVersion],
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          detail: 'The testing candidate changed before this grade could be recorded.',
        });
      }
      const candidate = toSummary(updatedRow);
      const payload = {
        testingCandidateId: candidate.id,
        testingEventId: candidate.testingEventId,
        studentCurriculumEnrollmentId: candidate.studentCurriculumEnrollmentId,
        targetRankId: candidate.targetRankId,
        result: candidate.result,
        instructorNotes: candidate.instructorNotes ?? null,
        gradedByPrincipalId: context.principalId,
        version: candidate.version,
      };

      await client.query(
        `INSERT INTO hon.audit_events (
           organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
           prior_state, next_state, result, request_id, correlation_id, action_request_id, occurred_at
         )
         VALUES (
           $1, $2, $3, $4, 'testing.candidate.grade', 'TESTING_CANDIDATE', $5::uuid,
           $6::jsonb, $7::jsonb, 'SUCCEEDED', $8::uuid, $9::uuid, NULL, now()
         )`,
        [
          context.organizationId,
          context.schoolId,
          context.principalId,
          context.source,
          candidate.id,
          JSON.stringify(priorCandidate),
          JSON.stringify(payload),
          context.requestId,
          context.correlationId,
        ],
      );
      await client.query(
        `INSERT INTO hon.outbox_events (
           id, organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id,
           aggregate_version, correlation_id, causation_id, payload
         )
         VALUES (
           $1::uuid, $2, $3, 'testing.candidate.graded', 1, 'TESTING_CANDIDATE', $4::uuid,
           $5, $6::uuid, $7::uuid, $8::jsonb
         )`,
        [
          randomUUID(),
          context.organizationId,
          context.schoolId,
          candidate.id,
          candidate.version,
          context.correlationId,
          context.requestId,
          JSON.stringify(payload),
        ],
      );
      await this.completeIdempotencyRecord(client, context, candidate, 200);

      return { candidate, replayed: false };
    });
  }

  private async requireCurriculumScopedRecord(
    client: PoolClient,
    table: 'hon.testing_events' | 'hon.student_curriculum_enrollments' | 'hon.curriculum_ranks',
    id: string,
    notFoundDetail: string,
  ): Promise<CurriculumScopedRow> {
    const result = await client.query<CurriculumScopedRow>(
      `SELECT id, curriculum_id AS "curriculumId"
       FROM ${table}
       WHERE id = $1::uuid
       FOR KEY SHARE`,
      [id],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException(notFoundDetail);
    return row;
  }

  private async completeIdempotencyRecord(
    client: PoolClient,
    context: CommandContext,
    candidate: TestingCandidateSummary,
    responseStatus = 201,
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
        JSON.stringify(candidate),
      ],
    );
  }
}
