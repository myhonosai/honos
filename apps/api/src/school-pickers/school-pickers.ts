import { BadRequestException, Controller, ForbiddenException, Get, Injectable, Param, ParseUUIDPipe, Query, Req, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { CommandContext } from '@hon/contracts';
import type { QueryResultRow } from 'pg';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

/**
 * Read-only pick lists for the school the staff member already works in (owner decision 2026-11-15), so curriculum,
 * testing and promotion screens offer names instead of asking for record IDs. Each list is checked against the same
 * permission as the screen it feeds, re-checked inside the read, and limited to the exact school. Nothing here writes;
 * every command these screens send still re-checks the record, school and permission itself.
 */
export const PICKER_LIMIT = 50;
/** A school's belt list across all its curricula is longer than one page of students, so ranks get a larger cap. */
export const RANK_LIMIT = 200;
export const ENROLLMENT_PURPOSES = { progress: 'curriculum.progress.record', readiness: 'testing.promotion.readiness.read', testing: 'testing.manage' } as const;
export const CANDIDATE_PURPOSES = { grade: 'testing.manage', decision: 'testing.promotion.decide' } as const;
/** attendance: front-desk check-in by name, for any active student (a booking is never required to attend). */
export const STUDENT_PURPOSES = { teaching: 'teaching.studio.read', achievements: 'achievement.award.read', attendance: 'attendance.record' } as const;
export const RANK_PURPOSES = { teaching: 'teaching.studio.read' } as const;
/** Screens that assign or manage a teammate, each with the permission that screen's own command needs (0404 allow-list). */
export const STAFF_PURPOSES = { followups: 'crm.follow_up.manage', work: 'work_item.manage', qualifications: 'staff.instructor_qualification.manage',
  roles: 'iam.staff_role.grant', availability: 'staff.availability.manage' } as const;
export const STAFF_LIMIT = 200;
export type StaffPurpose = keyof typeof STAFF_PURPOSES;
export type EnrollmentPurpose = keyof typeof ENROLLMENT_PURPOSES;
export type StudentPurpose = keyof typeof STUDENT_PURPOSES;
export type RankPurpose = keyof typeof RANK_PURPOSES;
export type CandidatePurpose = keyof typeof CANDIDATE_PURPOSES;
type Scope = { organizationId: string; schoolId: string; principalId: string };

export interface PickerEnrollment extends QueryResultRow { enrollmentId: string; curriculumId: string; curriculumName: string; studentProfileId: string; givenName: string; familyName: string;
  currentRankId: string | null; currentRankName: string | null; nextRankId: string | null; nextRankName: string | null; version: number }
export interface PickerTestingEvent extends QueryResultRow { testingEventId: string; name: string; curriculumId: string; curriculumName: string; startsAt: string; status: string }
export interface PickerCandidate extends QueryResultRow { candidateId: string; version: number; result: string; testingEventId: string; testingEventName: string; startsAt: string;
  studentProfileId: string; givenName: string; familyName: string; curriculumName: string; targetRankId: string; targetRankName: string }

export interface PickerStudent extends QueryResultRow { studentProfileId: string; givenName: string; familyName: string }
export interface PickerRank extends QueryResultRow { curriculumId: string; curriculumName: string; rankId: string; rankName: string; progressionOrder: number }

export type PickerStaff = { principalId: string; displayName: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function needle(search: unknown): string | null {
  if (search === undefined) return null;
  if (typeof search !== 'string' || search.length > 120 || /[\u0000-\u001f\u007f]/.test(search)) throw new BadRequestException({ code: 'SEARCH_INVALID', detail: 'Search text is limited to 120 plain characters.' });
  return search.trim() || null;
}
/** LIKE pattern text with the wildcard characters escaped, so a search is always a plain substring. */
const LIKE = `'%' || replace(replace(replace($3::text, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'`;

@Injectable()
export class SchoolPickersService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  private async read<T extends QueryResultRow>(context: CommandContext, subject: string, permission: string, work: (query: (sql: string, values: unknown[]) => Promise<T[]>) => Promise<T[]>): Promise<T[]> {
    return this.database.withTenantTransaction(context, async (client) => {
      // The controller's authority is re-checked inside the read: a revoked grant or an inactive school reads nothing.
      const again = (await client.query<{ principal_id: string; organization_id: string; school_id: string }>(
        'SELECT principal_id, organization_id, school_id FROM hon.resolve_authorized_scope($1, $2::uuid, $3)', [subject, context.schoolId, permission])).rows[0];
      if (!again || again.principal_id !== context.principalId || again.organization_id !== context.organizationId || again.school_id !== context.schoolId) {
        throw new ForbiddenException('This list is no longer authorized for this school.');
      }
      // Same live entitlement the screens require (0070 require_curriculum_actor, 0116 readiness): a lapsed or suspended
      // school lists nothing, matching the owner's suspension policy. Tenant RLS alone would not stop it. Read through the
      // no-argument boundary, which takes the organization from this transaction only.
      const entitled = await client.query<{ tier: string }>('SELECT tier FROM hon.read_current_organization_entitlement()', []);
      if (!entitled.rows.some((row) => ['ESSENTIAL', 'CORE', 'COMPLETE'].includes(row.tier))) {
        throw new ForbiddenException({ code: 'TIER_ENTITLEMENT_REQUIRED', detail: 'This school does not have an active subscription.' });
      }
      await client.query("SET LOCAL statement_timeout='5s'");
      return work(async (sql, values) => (await client.query<T>(sql, values)).rows);
    });
  }

  /** Active students' active curriculum enrollments, with their current and next rank, by name. */
  async enrollments(context: CommandContext, subject: string, purpose: EnrollmentPurpose, curriculumId: string | null, search: string | null): Promise<PickerEnrollment[]> {
    return this.read<PickerEnrollment>(context, subject, ENROLLMENT_PURPOSES[purpose], (query) => query(
      `SELECT e.id AS "enrollmentId", e.curriculum_id AS "curriculumId", c.name AS "curriculumName", e.student_profile_id AS "studentProfileId",
              p.given_name AS "givenName", p.family_name AS "familyName", r.id AS "currentRankId", r.name AS "currentRankName",
              n.id AS "nextRankId", n.name AS "nextRankName", e.version AS "version"
         FROM hon.student_curriculum_enrollments AS e
         JOIN hon.curricula AS c ON c.id = e.curriculum_id AND c.organization_id = e.organization_id AND c.school_id = e.school_id
         JOIN hon.student_profiles AS s ON s.id = e.student_profile_id AND s.organization_id = e.organization_id AND s.school_id = e.school_id
         JOIN hon.people AS p ON p.id = s.person_id AND p.organization_id = s.organization_id AND p.school_id = s.school_id
         LEFT JOIN hon.curriculum_ranks AS r ON r.id = e.current_rank_id AND r.organization_id = e.organization_id AND r.school_id = e.school_id
         LEFT JOIN LATERAL (SELECT id, name FROM hon.curriculum_ranks AS x
                             WHERE x.curriculum_id = e.curriculum_id AND x.organization_id = e.organization_id AND x.school_id = e.school_id
                               AND x.progression_order > coalesce(r.progression_order, 0) ORDER BY x.progression_order LIMIT 1) AS n ON true
        WHERE e.organization_id = $1 AND e.school_id = $2 AND e.status = 'ACTIVE' AND s.status = 'ACTIVE'
          AND ($4::uuid IS NULL OR e.curriculum_id = $4::uuid)
          AND ($3::text IS NULL OR (p.given_name || ' ' || p.family_name) ILIKE ${LIKE})
        ORDER BY p.family_name, p.given_name, c.name, e.id
        LIMIT ${PICKER_LIMIT}`, [context.organizationId, context.schoolId, search, curriculumId]));
  }

  /** Active students at this school, by name (for screens that note something about one student). */
  async students(context: CommandContext, subject: string, purpose: StudentPurpose, search: string | null): Promise<PickerStudent[]> {
    return this.read<PickerStudent>(context, subject, STUDENT_PURPOSES[purpose], (query) => query(
      `SELECT s.id AS "studentProfileId", p.given_name AS "givenName", p.family_name AS "familyName"
         FROM hon.student_profiles AS s
         JOIN hon.people AS p ON p.id = s.person_id AND p.organization_id = s.organization_id AND p.school_id = s.school_id
        WHERE s.organization_id = $1 AND s.school_id = $2 AND s.status = 'ACTIVE'
          AND ($3::text IS NULL OR (p.given_name || ' ' || p.family_name) ILIKE ${LIKE})
        ORDER BY p.family_name, p.given_name, s.id
        LIMIT ${PICKER_LIMIT}`, [context.organizationId, context.schoolId, search]));
  }

  /** Ranks of this school's draft and published curricula, by curriculum then belt order. */
  async ranks(context: CommandContext, subject: string, purpose: RankPurpose): Promise<PickerRank[]> {
    return this.read<PickerRank>(context, subject, RANK_PURPOSES[purpose], (query) => query(
      `SELECT c.id AS "curriculumId", c.name AS "curriculumName", r.id AS "rankId", r.name AS "rankName", r.progression_order AS "progressionOrder"
         FROM hon.curricula AS c
         JOIN hon.curriculum_ranks AS r ON r.curriculum_id = c.id AND r.organization_id = c.organization_id AND r.school_id = c.school_id
        WHERE c.organization_id = $1 AND c.school_id = $2 AND c.lifecycle <> 'ARCHIVED'
        ORDER BY c.name, r.progression_order, r.id
        LIMIT ${RANK_LIMIT}`, [context.organizationId, context.schoolId]));
  }

  /** People with an active role at this school, by display name only, through the closed 0404 boundary. */
  async staff(context: CommandContext, subject: string, purpose: StaffPurpose): Promise<PickerStaff[]> {
    const rows = await this.read<{ data: unknown }>(context, subject, STAFF_PURPOSES[purpose], async (query) => {
      // The 0404 boundary serves signed-in people only; it refuses any other source.
      await query("SELECT set_config('app.hon_source', 'HUMAN_UI', true)", []);
      return query('SELECT hon.list_school_staff_for_picker($1, $2) AS data', [subject, STAFF_PURPOSES[purpose]]);
    });
    const data = rows[0]?.data as { items?: unknown } | null | undefined;
    if (!data || typeof data !== 'object' || Object.keys(data).join() !== 'items' || !Array.isArray(data.items) || data.items.length > STAFF_LIMIT) throw new Error('Invalid staff list.');
    return data.items.map((item) => {
      const r = item as Record<string, unknown>;
      if (!r || typeof r !== 'object' || Object.keys(r).sort().join() !== 'displayName,principalId' || typeof r.principalId !== 'string' || !UUID.test(r.principalId)
        || typeof r.displayName !== 'string' || !r.displayName.trim() || r.displayName.length > 120) throw new Error('Invalid staff list.');
      return { principalId: r.principalId, displayName: r.displayName };
    });
  }

  /** Testing events that are not finished or cancelled, soonest first. */
  async testingEvents(context: CommandContext, subject: string): Promise<PickerTestingEvent[]> {
    return this.read<PickerTestingEvent>(context, subject, 'testing.manage', (query) => query(
      `SELECT t.id AS "testingEventId", t.name AS "name", t.curriculum_id AS "curriculumId", c.name AS "curriculumName",
              to_char(t.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startsAt", t.status::text AS "status"
         FROM hon.testing_events AS t
         JOIN hon.curricula AS c ON c.id = t.curriculum_id AND c.organization_id = t.organization_id AND c.school_id = t.school_id
        WHERE t.organization_id = $1 AND t.school_id = $2 AND t.status IN ('DRAFT', 'OPEN', 'CLOSED')
        ORDER BY t.starts_at, t.id
        LIMIT ${PICKER_LIMIT}`, [context.organizationId, context.schoolId]));
  }

  /**
   * Candidates waiting on the next human step: for grading, those still PENDING; for a promotion decision, graded
   * candidates with no final decision yet. Soonest event first.
   */
  async candidates(context: CommandContext, subject: string, purpose: CandidatePurpose, search: string | null): Promise<PickerCandidate[]> {
    const waiting = purpose === 'grade'
      ? `k.result = 'PENDING'`
      : `k.result IN ('PASSED', 'DEFERRED', 'NOT_PASSED') AND NOT EXISTS (SELECT 1 FROM hon.promotion_decisions AS d
           WHERE d.testing_candidate_id = k.id AND d.organization_id = k.organization_id AND d.school_id = k.school_id)`;
    return this.read<PickerCandidate>(context, subject, CANDIDATE_PURPOSES[purpose], (query) => query(
      `SELECT k.id AS "candidateId", k.version AS "version", k.result::text AS "result", t.id AS "testingEventId", t.name AS "testingEventName",
              to_char(t.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startsAt", s.id AS "studentProfileId",
              p.given_name AS "givenName", p.family_name AS "familyName", c.name AS "curriculumName", r.id AS "targetRankId", r.name AS "targetRankName"
         FROM hon.testing_candidates AS k
         JOIN hon.testing_events AS t ON t.id = k.testing_event_id AND t.organization_id = k.organization_id AND t.school_id = k.school_id
         JOIN hon.student_curriculum_enrollments AS e ON e.id = k.student_curriculum_enrollment_id AND e.organization_id = k.organization_id AND e.school_id = k.school_id
         JOIN hon.curricula AS c ON c.id = e.curriculum_id AND c.organization_id = e.organization_id AND c.school_id = e.school_id
         JOIN hon.student_profiles AS s ON s.id = e.student_profile_id AND s.organization_id = e.organization_id AND s.school_id = e.school_id
         JOIN hon.people AS p ON p.id = s.person_id AND p.organization_id = s.organization_id AND p.school_id = s.school_id
         JOIN hon.curriculum_ranks AS r ON r.id = k.target_rank_id AND r.organization_id = k.organization_id AND r.school_id = k.school_id
        WHERE k.organization_id = $1 AND k.school_id = $2 AND ${waiting}
          AND ($3::text IS NULL OR (p.given_name || ' ' || p.family_name) ILIKE ${LIKE})
        ORDER BY t.starts_at, p.family_name, p.given_name, k.id
        LIMIT ${PICKER_LIMIT}`, [context.organizationId, context.schoolId, search]));
  }
}

@Controller('organizations/:organizationId/schools/:schoolId/pickers')
@UseGuards(HonIdentityGuard)
export class SchoolPickersController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly pickers: SchoolPickersService) {}

  private async scope(request: HonRequest, organizationId: string, schoolId: string, permission: string): Promise<{ context: CommandContext; subject: string }> {
    const identity = request.honIdentity; if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope: Scope | undefined = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException('This list is not authorized for this school.');
    const requestId = randomUUID();
    // These lists are for a signed-in person on a school screen only: the read runs as HUMAN_UI, never as an agent,
    // delegated or automation context, so no AI or Action Engine path can use them to enumerate students.
    return { subject: identity.externalSubject, context: { organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId, principalType: 'HUMAN_USER',
      requestId, correlationId: requestId, idempotencyKey: `read:${requestId}`, source: 'HUMAN_UI' } };
  }

  @Get('enrollments')
  async enrollments(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query('for') purpose: unknown, @Query('curriculumId') curriculumId: unknown, @Query('search') search: unknown, @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'private, no-store');
    if (typeof purpose !== 'string' || !Object.hasOwn(ENROLLMENT_PURPOSES, purpose)) throw new BadRequestException({ code: 'PURPOSE_INVALID', detail: 'Say which screen this list is for.' });
    if (curriculumId !== undefined && (typeof curriculumId !== 'string' || !UUID.test(curriculumId))) throw new BadRequestException({ code: 'CURRICULUM_INVALID' });
    const text = needle(search);
    const { context, subject } = await this.scope(request, organizationId, schoolId, ENROLLMENT_PURPOSES[purpose as EnrollmentPurpose]);
    const data = await this.pickers.enrollments(context, subject, purpose as EnrollmentPurpose, curriculumId === undefined ? null : (curriculumId as string).toLowerCase(), text);
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId, limit: PICKER_LIMIT } };
  }

  @Get('testing-events')
  async testingEvents(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'private, no-store');
    const { context, subject } = await this.scope(request, organizationId, schoolId, 'testing.manage');
    return { data: await this.pickers.testingEvents(context, subject), meta: { requestId: context.requestId, correlationId: context.correlationId, limit: PICKER_LIMIT } };
  }

  @Get('testing-candidates')
  async candidates(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query('for') purpose: unknown, @Query('search') search: unknown, @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'private, no-store');
    if (typeof purpose !== 'string' || !Object.hasOwn(CANDIDATE_PURPOSES, purpose)) throw new BadRequestException({ code: 'PURPOSE_INVALID', detail: 'Say which screen this list is for.' });
    const text = needle(search);
    const { context, subject } = await this.scope(request, organizationId, schoolId, CANDIDATE_PURPOSES[purpose as CandidatePurpose]);
    return { data: await this.pickers.candidates(context, subject, purpose as CandidatePurpose, text), meta: { requestId: context.requestId, correlationId: context.correlationId, limit: PICKER_LIMIT } };
  }

  @Get('students')
  async students(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query('for') purpose: unknown, @Query('search') search: unknown, @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'private, no-store');
    if (typeof purpose !== 'string' || !Object.hasOwn(STUDENT_PURPOSES, purpose)) throw new BadRequestException({ code: 'PURPOSE_INVALID', detail: 'Say which screen this list is for.' });
    const text = needle(search);
    const { context, subject } = await this.scope(request, organizationId, schoolId, STUDENT_PURPOSES[purpose as StudentPurpose]);
    return { data: await this.pickers.students(context, subject, purpose as StudentPurpose, text), meta: { requestId: context.requestId, correlationId: context.correlationId, limit: PICKER_LIMIT } };
  }

  @Get('ranks')
  async ranks(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query('for') purpose: unknown, @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'private, no-store');
    if (typeof purpose !== 'string' || !Object.hasOwn(RANK_PURPOSES, purpose)) throw new BadRequestException({ code: 'PURPOSE_INVALID', detail: 'Say which screen this list is for.' });
    const { context, subject } = await this.scope(request, organizationId, schoolId, RANK_PURPOSES[purpose as RankPurpose]);
    return { data: await this.pickers.ranks(context, subject, purpose as RankPurpose), meta: { requestId: context.requestId, correlationId: context.correlationId, limit: RANK_LIMIT } };
  }

  @Get('staff')
  async staff(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query('for') purpose: unknown, @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'private, no-store');
    if (typeof purpose !== 'string' || !Object.hasOwn(STAFF_PURPOSES, purpose)) throw new BadRequestException({ code: 'PURPOSE_INVALID', detail: 'Say which screen this list is for.' });
    const { context, subject } = await this.scope(request, organizationId, schoolId, STAFF_PURPOSES[purpose as StaffPurpose]);
    return { data: await this.pickers.staff(context, subject, purpose as StaffPurpose), meta: { requestId: context.requestId, correlationId: context.correlationId, limit: STAFF_LIMIT } };
  }
}
