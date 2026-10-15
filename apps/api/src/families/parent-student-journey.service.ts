import { ForbiddenException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  TESTING_CANDIDATE_RESULTS,
  type ParentStudentJourney,
  type ParentStudentJourneyEnrollment,
  type ParentStudentJourneyPromotionDecision,
  type ParentStudentJourneyStudent,
  type ParentStudentJourneyTestingCandidate,
  type TestingCandidateResult,
} from '@hon/contracts';
import type { ResolvedParentFamilyScope } from '../foundation/runtime-database.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

interface StudentRow {
  familyMemberId: string;
  studentProfileId: string | null;
  studentProfileStatus: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED' | null;
  personId: string;
  givenName: string;
  familyName: string;
}

interface EnrollmentRow {
  id: string;
  studentProfileId: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
  enrolledAt: Date | string;
  curriculumId: string;
  curriculumName: string;
  currentRankId: string | null;
  currentRankName: string | null;
  currentRankProgressionOrder: number | null;
}

interface CandidateRow {
  id: string;
  studentCurriculumEnrollmentId: string;
  result: string;
  createdAt: Date | string;
  testingEventId: string;
  testingEventName: string;
  testingEventStartsAt: Date | string;
  testingEventStatus: string;
  targetRankId: string;
  targetRankName: string;
  targetRankProgressionOrder: number;
  promotionDecisionId: string | null;
  promotionDecisionStatus: string | null;
  promotionDecisionDecidedAt: Date | string | null;
}

const TESTING_EVENT_STATUSES = ['DRAFT', 'OPEN', 'CLOSED', 'COMPLETED', 'CANCELLED'] as const;
const PARENT_PROMOTION_DECISION_STATUSES = [
  'PENDING_INSTRUCTOR_DECISION',
  'PROMOTED',
  'DEFERRED',
  'NOT_PROMOTED',
] as const;

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function isTestingCandidateResult(value: string): value is TestingCandidateResult {
  return (TESTING_CANDIDATE_RESULTS as readonly string[]).includes(value);
}

function isTestingEventStatus(
  value: string,
): value is (typeof TESTING_EVENT_STATUSES)[number] {
  return (TESTING_EVENT_STATUSES as readonly string[]).includes(value);
}

function isPromotionDecisionStatus(
  value: string | null,
): value is (typeof PARENT_PROMOTION_DECISION_STATUSES)[number] {
  return value !== null && (PARENT_PROMOTION_DECISION_STATUSES as readonly string[]).includes(value);
}

/**
 * Read-only Parent/Eian view. Its inputs are a parent-family scope resolved from
 * the authenticated external subject and the exact family id the controller
 * already matched; it has no organization/school values supplied by a client.
 */
@Injectable()
export class ParentStudentJourneyService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async get(
    resolvedScope: ResolvedParentFamilyScope,
    requestedFamilyId: string,
    requestId: string,
  ): Promise<ParentStudentJourney> {
    // Keep the controller's authorization invariant local to the data access
    // boundary as well: an accidentally reused tenant scope cannot widen this read.
    if (resolvedScope.familyId !== requestedFamilyId) {
      throw new ForbiddenException('HON parent access is not authorized for this family.');
    }

    return this.database.withTenantTransaction(
      {
        organizationId: resolvedScope.organizationId,
        schoolId: resolvedScope.schoolId,
        principalId: resolvedScope.principalId,
        principalType: 'HUMAN_USER',
        requestId,
      },
      async (client) => {
        const students = await this.selectStudents(client, requestedFamilyId);
        const studentsByProfileId = new Map<string, ParentStudentJourneyStudent>();
        for (const student of students) {
          if (student.studentProfile?.id) studentsByProfileId.set(student.studentProfile.id, student);
        }

        if (studentsByProfileId.size === 0) {
          return {
            familyId: resolvedScope.familyId,
            accessLevel: resolvedScope.accessLevel,
            students,
          };
        }

        const enrollmentsById = await this.selectEnrollments(
          client,
          requestedFamilyId,
          studentsByProfileId,
        );
        await this.selectTestingCandidates(client, requestedFamilyId, enrollmentsById);

        return {
          familyId: resolvedScope.familyId,
          accessLevel: resolvedScope.accessLevel,
          students,
        };
      },
    );
  }

  private async selectStudents(client: PoolClient, familyId: string): Promise<ParentStudentJourneyStudent[]> {
    // This is intentionally not a people/profile directory query. The exact
    // requested family is its only anchor and only explicit STUDENT members join.
    const result = await client.query<StudentRow>(
      `SELECT
         member.id AS "familyMemberId",
         profile.id AS "studentProfileId",
         profile.status::text AS "studentProfileStatus",
         person.id AS "personId",
         person.given_name AS "givenName",
         person.family_name AS "familyName"
       FROM hon.family_members AS member
       JOIN hon.people AS person
         ON person.id = member.person_id
        AND person.organization_id = member.organization_id
        AND person.school_id = member.school_id
       LEFT JOIN hon.student_profiles AS profile
         ON profile.person_id = member.person_id
        AND profile.organization_id = member.organization_id
        AND profile.school_id = member.school_id
        AND profile.primary_family_id = member.family_id
       WHERE member.family_id = $1::uuid
         AND member.member_role = 'STUDENT'::hon.family_member_role
       ORDER BY person.given_name ASC, person.family_name ASC, member.id ASC`,
      [familyId],
    );

    return result.rows.map((row) => ({
      familyMemberId: row.familyMemberId,
      person: {
        id: row.personId,
        givenName: row.givenName,
        familyName: row.familyName,
      },
      ...(row.studentProfileId && row.studentProfileStatus
        ? { studentProfile: { id: row.studentProfileId, status: row.studentProfileStatus } }
        : {}),
      curriculumEnrollments: [],
    }));
  }

  private async selectEnrollments(
    client: PoolClient,
    familyId: string,
    studentsByProfileId: Map<string, ParentStudentJourneyStudent>,
  ): Promise<Map<string, ParentStudentJourneyEnrollment>> {
    // The second read repeats the family membership anchor rather than relying on
    // a client-provided profile/enrollment id. Every enrollment belongs to a
    // selected student profile in this exact family.
    const result = await client.query<EnrollmentRow>(
      `SELECT
         enrollment.id,
         enrollment.student_profile_id AS "studentProfileId",
         enrollment.status::text AS status,
         enrollment.enrolled_at AS "enrolledAt",
         curriculum.id AS "curriculumId",
         curriculum.name AS "curriculumName",
         rank.id AS "currentRankId",
         rank.name AS "currentRankName",
         rank.progression_order AS "currentRankProgressionOrder"
       FROM hon.student_curriculum_enrollments AS enrollment
       JOIN hon.student_profiles AS profile
         ON profile.id = enrollment.student_profile_id
        AND profile.organization_id = enrollment.organization_id
        AND profile.school_id = enrollment.school_id
        AND profile.primary_family_id = $1::uuid
       JOIN hon.family_members AS member
         ON member.family_id = $1::uuid
        AND member.person_id = profile.person_id
        AND member.organization_id = profile.organization_id
        AND member.school_id = profile.school_id
        AND member.member_role = 'STUDENT'::hon.family_member_role
       JOIN hon.curricula AS curriculum
         ON curriculum.id = enrollment.curriculum_id
        AND curriculum.organization_id = enrollment.organization_id
        AND curriculum.school_id = enrollment.school_id
       LEFT JOIN hon.curriculum_ranks AS rank
         ON rank.id = enrollment.current_rank_id
        AND rank.organization_id = enrollment.organization_id
        AND rank.school_id = enrollment.school_id
       ORDER BY enrollment.enrolled_at ASC, enrollment.id ASC`,
      [familyId],
    );

    const enrollmentsById = new Map<string, ParentStudentJourneyEnrollment>();
    for (const row of result.rows) {
      const student = studentsByProfileId.get(row.studentProfileId);
      // A matching family/student predicate is present in SQL. This check makes
      // an unexpected relationship fail closed instead of being returned.
      if (!student) throw new Error('HON parent journey enrollment was not linked to the selected student.');

      const enrollment: ParentStudentJourneyEnrollment = {
        id: row.id,
        status: row.status,
        enrolledAt: asIso(row.enrolledAt),
        curriculum: { id: row.curriculumId, name: row.curriculumName },
        ...(row.currentRankId && row.currentRankName && row.currentRankProgressionOrder !== null
          ? {
              currentRank: {
                id: row.currentRankId,
                name: row.currentRankName,
                progressionOrder: row.currentRankProgressionOrder,
              },
            }
          : {}),
        testingCandidates: [],
      };
      student.curriculumEnrollments.push(enrollment);
      enrollmentsById.set(enrollment.id, enrollment);
    }
    return enrollmentsById;
  }

  private async selectTestingCandidates(
    client: PoolClient,
    familyId: string,
    enrollmentsById: Map<string, ParentStudentJourneyEnrollment>,
  ): Promise<void> {
    // This is not an event roster: candidate rows reach this result only through
    // an enrollment that is again anchored to the selected family member.
    const result = await client.query<CandidateRow>(
      `SELECT
         candidate.id,
         candidate.student_curriculum_enrollment_id AS "studentCurriculumEnrollmentId",
         candidate.result::text AS result,
         candidate.created_at AS "createdAt",
         event.id AS "testingEventId",
         event.name AS "testingEventName",
         event.starts_at AS "testingEventStartsAt",
         event.status::text AS "testingEventStatus",
         target_rank.id AS "targetRankId",
         target_rank.name AS "targetRankName",
         target_rank.progression_order AS "targetRankProgressionOrder",
         decision.id AS "promotionDecisionId",
         decision.status::text AS "promotionDecisionStatus",
         decision.decided_at AS "promotionDecisionDecidedAt"
       FROM hon.testing_candidates AS candidate
       JOIN hon.student_curriculum_enrollments AS enrollment
         ON enrollment.id = candidate.student_curriculum_enrollment_id
        AND enrollment.organization_id = candidate.organization_id
        AND enrollment.school_id = candidate.school_id
       JOIN hon.student_profiles AS profile
         ON profile.id = enrollment.student_profile_id
        AND profile.organization_id = enrollment.organization_id
        AND profile.school_id = enrollment.school_id
        AND profile.primary_family_id = $1::uuid
       JOIN hon.family_members AS member
         ON member.family_id = $1::uuid
        AND member.person_id = profile.person_id
        AND member.organization_id = profile.organization_id
        AND member.school_id = profile.school_id
        AND member.member_role = 'STUDENT'::hon.family_member_role
       JOIN hon.testing_events AS event
         ON event.id = candidate.testing_event_id
        AND event.organization_id = candidate.organization_id
        AND event.school_id = candidate.school_id
       JOIN hon.curriculum_ranks AS target_rank
         ON target_rank.id = candidate.target_rank_id
        AND target_rank.organization_id = candidate.organization_id
        AND target_rank.school_id = candidate.school_id
       LEFT JOIN hon.promotion_decisions AS decision
         ON decision.testing_candidate_id = candidate.id
        AND decision.organization_id = candidate.organization_id
        AND decision.school_id = candidate.school_id
       ORDER BY event.starts_at DESC, candidate.created_at DESC, candidate.id ASC`,
      [familyId],
    );

    for (const row of result.rows) {
      const enrollment = enrollmentsById.get(row.studentCurriculumEnrollmentId);
      if (!enrollment) {
        throw new Error('HON parent journey candidate was not linked to a selected family enrollment.');
      }
      if (!isTestingCandidateResult(row.result)) {
        throw new Error('HON parent journey query returned an invalid testing candidate result.');
      }
      if (!isTestingEventStatus(row.testingEventStatus)) {
        throw new Error('HON parent journey query returned an invalid testing event status.');
      }

      const candidate: ParentStudentJourneyTestingCandidate = {
        id: row.id,
        result: row.result,
        createdAt: asIso(row.createdAt),
        testingEvent: {
          id: row.testingEventId,
          name: row.testingEventName,
          startsAt: asIso(row.testingEventStartsAt),
          status: row.testingEventStatus,
        },
        targetRank: {
          id: row.targetRankId,
          name: row.targetRankName,
          progressionOrder: row.targetRankProgressionOrder,
        },
      };
      if (row.promotionDecisionId) {
        if (!isPromotionDecisionStatus(row.promotionDecisionStatus)) {
          throw new Error('HON parent journey query returned an invalid promotion decision status.');
        }
        const decision: ParentStudentJourneyPromotionDecision = {
          id: row.promotionDecisionId,
          status: row.promotionDecisionStatus,
          ...(row.promotionDecisionDecidedAt
            ? { decidedAt: asIso(row.promotionDecisionDecidedAt) }
            : {}),
        };
        candidate.promotionDecision = decision;
      }
      enrollment.testingCandidates.push(candidate);
    }
  }
}
