import { testingDatabaseError } from './testing-database-error.js';
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
  PROMOTION_DECISION_STATUSES,
  TESTING_CANDIDATE_RESULTS,
  type CommandContext,
  type DecidePromotionInput,
  type PromotionDecisionStatus,
  type PromotionDecisionSummary,
  type TestingCandidateResult,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

interface TestingCandidateRow {
  id: string;
  studentCurriculumEnrollmentId: string;
  targetRankId: string;
  result: TestingCandidateResult;
  version: number;
}

interface EnrollmentRow {
  id: string;
  curriculumId: string;
  currentRankId: string | null;
  version: number;
}

interface CurriculumRankRow {
  id: string;
  curriculumId: string;
}

interface UpdatedEnrollmentRow {
  currentRankId: string | null;
  version: number;
}

interface PromotionDecisionRow {
  id: string;
  testingCandidateId: string;
  studentCurriculumEnrollmentId: string;
  priorRankId: string | null;
  targetRankId: string;
  status: PromotionDecisionStatus;
  instructorPrincipalId: string;
  rationale: string;
  decidedAt: Date | string;
  version: number;
  createdAt: Date | string;
}

interface IdempotencyRecord {
  request_fingerprint: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  response_body: PromotionDecisionSummary | null;
}

interface NormalizedDecisionInput {
  expectedVersion: number;
  status: PromotionDecisionStatus;
  rationale: string;
}

function validationError(detail: string): BadRequestException {
  return new BadRequestException({ code: 'VALIDATION_FAILED', detail });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeInput(input: DecidePromotionInput): NormalizedDecisionInput {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw validationError('expectedVersion must be a positive whole number.');
  }
  if (!PROMOTION_DECISION_STATUSES.includes(input.status)) {
    throw validationError('Promotion decision status must be PROMOTED, DEFERRED, or NOT_PROMOTED.');
  }
  if (typeof input.rationale !== 'string' || input.rationale.length > 2000) {
    throw validationError('rationale is required and cannot exceed 2000 characters.');
  }
  const rationale = input.rationale.trim();
  if (!rationale) throw validationError('rationale is required and cannot be blank.');
  return { expectedVersion: input.expectedVersion, status: input.status, rationale };
}

function toSummary(row: PromotionDecisionRow): PromotionDecisionSummary {
  if (!PROMOTION_DECISION_STATUSES.includes(row.status)) {
    throw new Error('HON promotion decision query returned an invalid status.');
  }
  return {
    id: row.id,
    testingCandidateId: row.testingCandidateId,
    studentCurriculumEnrollmentId: row.studentCurriculumEnrollmentId,
    ...(row.priorRankId === null ? {} : { priorRankId: row.priorRankId }),
    targetRankId: row.targetRankId,
    status: row.status,
    instructorPrincipalId: row.instructorPrincipalId,
    rationale: row.rationale,
    decidedAt: asIso(row.decidedAt),
    version: row.version,
    createdAt: asIso(row.createdAt),
  };
}

@Injectable()
export class PromotionDecisionService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  /**
   * Finalizes exactly one instructor-owned promotion decision. This service is
   * intentionally isolated from ActionEngineService: it never creates an AI
   * proposal, accepts delegated actor/source data, or invokes another workflow.
   */
  async decide(
    context: CommandContext,
    candidateId: string,
    input: DecidePromotionInput,
  ): Promise<{ decision: PromotionDecisionSummary; replayed: boolean }> {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI') {
      throw new ForbiddenException('Promotion decisions are a human-only instructor command.');
    }
    if (context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException('Promotion decisions cannot be proposed or executed through delegated actions.');
    }
    if (!isUuid(candidateId)) throw validationError('candidateId must be a UUID.');

    const normalized = normalizeInput(input);
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({ candidateId, ...normalized }))
      .digest('hex');

    return this.database.withTenantTransaction(context, async (client) => {
      await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)");
      await client.query("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'");
      await client.query('SELECT hon.lock_human_testing_authority($1)', ['testing.promotion.decide']);
      await client.query('SELECT hon.lock_human_testing_record($1,$2,$3::uuid)', ['testing.promotion.decide','CANDIDATE',candidateId]);
      // Every dependency read is both transaction-bound and RLS-scoped. Holding
      // a row lock on the candidate also prevents a competing decision insert.
      const candidateResult = await client.query<TestingCandidateRow>(
        `SELECT
           id,
           student_curriculum_enrollment_id AS "studentCurriculumEnrollmentId",
           target_rank_id AS "targetRankId",
           result::text AS result,
           version
         FROM hon.testing_candidates
         WHERE id = $1::uuid
         `,
        [candidateId],
      );
      const candidate = candidateResult.rows[0];
      if (!candidate) throw new NotFoundException('Testing candidate was not found in this school.');
      // A matching completed command can replay only while it still identifies
      // the same current candidate version. New commands never reserve or
      // mutate idempotency state for a stale candidate observation.
      if (candidate.version !== normalized.expectedVersion) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          detail: 'The testing candidate has changed. Refresh it and retry with its current version and a new Idempotency-Key.',
        });
      }
      if (!TESTING_CANDIDATE_RESULTS.includes(candidate.result)) {
        throw new Error('HON testing candidate query returned an invalid result.');
      }

      const enrollmentResult = await client.query<EnrollmentRow>(
        `SELECT
           id,
           curriculum_id AS "curriculumId",
           current_rank_id AS "currentRankId",
           version
         FROM hon.student_curriculum_enrollments
         WHERE id = $1::uuid
         FOR UPDATE`,
        [candidate.studentCurriculumEnrollmentId],
      );
      const enrollment = enrollmentResult.rows[0];
      if (!enrollment) {
        throw new NotFoundException('Student curriculum enrollment was not found in this school.');
      }

      const targetRank = await this.requireRank(
        client,
        candidate.targetRankId,
        'Target rank was not found in this school.',
      );
      const priorRank = enrollment.currentRankId
        ? await this.requireRank(client, enrollment.currentRankId, 'Current rank was not found in this school.')
        : undefined;
      if (
        targetRank.curriculumId !== enrollment.curriculumId
        || (priorRank && priorRank.curriculumId !== enrollment.curriculumId)
      ) {
        throw validationError('The enrollment, current rank, and target rank must belong to the same curriculum.');
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
        if (!record) throw new Error('HON promotion decision idempotency record unexpectedly missing.');
        if (record.request_fingerprint !== requestFingerprint) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            detail: 'The idempotency key was already used for a different promotion decision command.',
          });
        }
        if (record.status === 'COMPLETED' && record.response_body) {
          return { decision: record.response_body, replayed: true };
        }
        throw new ConflictException({
          code: 'IDEMPOTENCY_IN_PROGRESS',
          detail: 'The matching promotion decision command is being processed.',
        });
      }

      const existingDecision = await client.query<{ id: string }>(
        `SELECT id
         FROM hon.promotion_decisions
         WHERE testing_candidate_id = $1::uuid`,
        [candidate.id],
      );
      // The candidate is already locked until commit. Decisions are insert-only
      // for runtime, so this check must not demand a decision UPDATE privilege.
      if (existingDecision.rowCount) {
        throw new ConflictException({
          code: 'PROMOTION_DECISION_ALREADY_EXISTS',
          detail: 'This testing candidate already has a final promotion decision.',
        });
      }

      this.assertCandidateDecisionCoherency(candidate.result, normalized.status);

      let enrollmentVersion = enrollment.version;
      let resultingRankId = enrollment.currentRankId;
      if (normalized.status === 'PROMOTED') {
        const updatedEnrollment = await client.query<UpdatedEnrollmentRow>(
          `UPDATE hon.student_curriculum_enrollments
           SET current_rank_id = $2::uuid,
               version = version + 1,
               updated_at = now()
           WHERE id = $1::uuid
             AND version = $3
           RETURNING current_rank_id AS "currentRankId", version`,
          [enrollment.id, candidate.targetRankId, enrollment.version],
        );
        const updated = updatedEnrollment.rows[0];
        if (!updated) {
          throw new ConflictException({
            code: 'VERSION_CONFLICT',
            detail: 'The student curriculum enrollment changed before this promotion could be decided.',
          });
        }
        enrollmentVersion = updated.version;
        resultingRankId = updated.currentRankId;
      }

      const inserted = await client.query<PromotionDecisionRow>(
        `INSERT INTO hon.promotion_decisions (
           organization_id, school_id, testing_candidate_id, student_curriculum_enrollment_id,
           prior_rank_id, target_rank_id, status, instructor_principal_id, rationale, decided_at
         )
         VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
                 $7::hon.promotion_decision_status, $8::uuid, $9, now())
         RETURNING
           id,
           testing_candidate_id AS "testingCandidateId",
           student_curriculum_enrollment_id AS "studentCurriculumEnrollmentId",
           prior_rank_id AS "priorRankId",
           target_rank_id AS "targetRankId",
           status::text AS status,
           instructor_principal_id AS "instructorPrincipalId",
           rationale,
           decided_at AS "decidedAt",
           version,
           created_at AS "createdAt"`,
        [
          context.organizationId,
          context.schoolId,
          candidate.id,
          enrollment.id,
          enrollment.currentRankId,
          candidate.targetRankId,
          normalized.status,
          context.principalId,
          normalized.rationale,
        ],
      );
      const insertedRow = inserted.rows[0];
      if (!insertedRow) throw new Error('HON promotion decision insert did not return a record.');
      const decision = toSummary(insertedRow);

      const priorState = {
        testingCandidateId: candidate.id,
        candidateResult: candidate.result,
        candidateVersion: candidate.version,
        studentCurriculumEnrollmentId: enrollment.id,
        currentRankId: enrollment.currentRankId,
        enrollmentVersion: enrollment.version,
      };
      const payload = {
        promotionDecisionId: decision.id,
        testingCandidateId: candidate.id,
        studentCurriculumEnrollmentId: enrollment.id,
        priorRankId: enrollment.currentRankId,
        targetRankId: candidate.targetRankId,
        status: decision.status,
        rationale: decision.rationale,
        instructorPrincipalId: context.principalId,
        decidedAt: decision.decidedAt,
        candidateResult: candidate.result,
        enrollmentVersion,
        resultingRankId,
      };

      await client.query(
        `INSERT INTO hon.audit_events (
           organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
           prior_state, next_state, result, request_id, correlation_id, action_request_id, occurred_at
         )
         VALUES (
           $1, $2, $3, 'HUMAN_UI', 'testing.promotion.decide', 'PROMOTION_DECISION', $4::uuid,
           $5::jsonb, $6::jsonb, 'SUCCEEDED', $7::uuid, $8::uuid, NULL, now()
         )`,
        [
          context.organizationId,
          context.schoolId,
          context.principalId,
          decision.id,
          JSON.stringify(priorState),
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
           $1::uuid, $2, $3, 'testing.promotion.decided', 1, 'PROMOTION_DECISION', $4::uuid,
           $5, $6::uuid, $7::uuid, $8::jsonb
         )`,
        [
          randomUUID(),
          context.organizationId,
          context.schoolId,
          decision.id,
          decision.version,
          context.correlationId,
          context.requestId,
          JSON.stringify(payload),
        ],
      );
      await this.completeIdempotencyRecord(client, context, decision);

      return { decision, replayed: false };
    }).catch(testingDatabaseError);
  }

  private assertCandidateDecisionCoherency(
    candidateResult: TestingCandidateResult,
    decisionStatus: PromotionDecisionStatus,
  ): void {
    if (candidateResult === 'PENDING') {
      throw new ConflictException({
        code: 'CANDIDATE_RESULT_NOT_FINAL',
        detail: 'A promotion decision requires a final testing candidate result.',
      });
    }
    if (decisionStatus === 'PROMOTED' && candidateResult !== 'PASSED') {
      throw new ConflictException({
        code: 'PROMOTION_DECISION_INCOHERENT',
        detail: 'PROMOTED requires a PASSED testing candidate result.',
      });
    }
    if (
      decisionStatus === 'NOT_PROMOTED'
      && candidateResult !== 'NOT_PASSED'
      && candidateResult !== 'WITHDRAWN'
    ) {
      throw new ConflictException({
        code: 'PROMOTION_DECISION_INCOHERENT',
        detail: 'NOT_PROMOTED requires a NOT_PASSED or WITHDRAWN testing candidate result.',
      });
    }
  }

  private async requireRank(
    client: PoolClient,
    rankId: string,
    notFoundDetail: string,
  ): Promise<CurriculumRankRow> {
    await client.query('SELECT hon.lock_human_testing_record($1,$2,$3::uuid)', ['testing.promotion.decide','RANK',rankId]);
    const result = await client.query<CurriculumRankRow>(
      `SELECT id, curriculum_id AS "curriculumId"
       FROM hon.curriculum_ranks
       WHERE id = $1::uuid
       `,
      [rankId],
    );
    const rank = result.rows[0];
    if (!rank) throw new NotFoundException(notFoundDetail);
    return rank;
  }

  private async completeIdempotencyRecord(
    client: PoolClient,
    context: CommandContext,
    decision: PromotionDecisionSummary,
  ): Promise<void> {
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
        JSON.stringify(decision),
      ],
    );
  }
}
