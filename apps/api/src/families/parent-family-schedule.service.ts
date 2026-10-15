import { ForbiddenException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  ClassBookingKind,
  ClassBookingStatus,
  ParentFamilySchedule,
  ScheduleItemStatus,
} from '@hon/contracts';
import type { ResolvedParentFamilyScope } from '../foundation/runtime-database.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { ParentFamilyScheduleRange } from './parent-family-schedule-query.dto.js';

interface ParentFamilyScheduleRow {
  studentDisplayName: string;
  bookingKind: ClassBookingKind;
  bookingStatus: ClassBookingStatus;
  sessionName: string;
  sessionStartsAt: Date | string;
  sessionEndsAt: Date | string;
  sessionRoomName: string | null;
  sessionStatus: ScheduleItemStatus;
  programName: string;
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Read-only Parent/Eian schedule projection. The controller must supply a
 * scope returned by resolveParentFamilyScopes and the exact family ID it
 * matched. The service repeats the family match before it opens the RLS-bound
 * transaction so accidental reuse of a tenant scope fails closed.
 */
@Injectable()
export class ParentFamilyScheduleService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async get(
    resolvedScope: ResolvedParentFamilyScope,
    requestedFamilyId: string,
    range: ParentFamilyScheduleRange,
    requestId: string,
  ): Promise<ParentFamilySchedule> {
    if (resolvedScope.familyId !== requestedFamilyId) {
      throw new ForbiddenException('HON parent access is not authorized for this family.');
    }

    return this.database.withTenantTransaction(
      {
        // All tenant values originate in the parent-family resolver. This read
        // never receives an organization or broad authorization scope from a
        // client request.
        organizationId: resolvedScope.organizationId,
        schoolId: resolvedScope.schoolId,
        principalId: resolvedScope.principalId,
        principalType: 'HUMAN_USER',
        requestId,
      },
      async (client) => ({
        bookings: await this.selectBookings(client, requestedFamilyId, range),
      }),
    );
  }

  private async selectBookings(
    client: PoolClient,
    familyId: string,
    range: ParentFamilyScheduleRange,
  ): Promise<ParentFamilySchedule['bookings']> {
    // The relation path is intentionally fixed: exact-family STUDENT
    // membership -> its primary-family profile -> booking -> session ->
    // program. It is not a school schedule or session roster query. The family
    // predicate is repeated at the profile and membership links so a same-school
    // profile cannot expand this result.
    const result = await client.query<ParentFamilyScheduleRow>(
      `SELECT
         concat_ws(' ', person.given_name, person.family_name) AS "studentDisplayName",
         booking.booking_kind AS "bookingKind",
         booking.status::text AS "bookingStatus",
         session.name AS "sessionName",
         session.starts_at AS "sessionStartsAt",
         session.ends_at AS "sessionEndsAt",
         session.room_name AS "sessionRoomName",
         session.status::text AS "sessionStatus",
         program.name AS "programName"
       FROM hon.family_members AS member
       JOIN hon.student_profiles AS profile
         ON profile.person_id = member.person_id
        AND profile.organization_id = member.organization_id
        AND profile.school_id = member.school_id
        AND profile.primary_family_id = member.family_id
        AND profile.primary_family_id = $1::uuid
       JOIN hon.class_bookings AS booking
         ON booking.student_profile_id = profile.id
        AND booking.organization_id = profile.organization_id
        AND booking.school_id = profile.school_id
       JOIN hon.class_sessions AS session
         ON session.id = booking.class_session_id
        AND session.organization_id = booking.organization_id
        AND session.school_id = booking.school_id
       JOIN hon.programs AS program
         ON program.id = session.program_id
        AND program.organization_id = session.organization_id
        AND program.school_id = session.school_id
       JOIN hon.people AS person
         ON person.id = member.person_id
        AND person.organization_id = member.organization_id
        AND person.school_id = member.school_id
       WHERE member.family_id = $1::uuid
         AND member.member_role = 'STUDENT'::hon.family_member_role
         AND session.starts_at >= $2::timestamptz
         AND session.starts_at < $3::timestamptz
       ORDER BY session.starts_at ASC, session.id ASC, booking.id ASC`,
      [familyId, range.from, range.to],
    );

    return result.rows.map((row) => ({
      student: { displayName: row.studentDisplayName },
      booking: { kind: row.bookingKind, status: row.bookingStatus },
      session: {
        name: row.sessionName,
        startsAt: asIso(row.sessionStartsAt),
        endsAt: asIso(row.sessionEndsAt),
        ...(row.sessionRoomName === null ? {} : { roomName: row.sessionRoomName }),
        status: row.sessionStatus,
      },
      program: { name: row.programName },
    }));
  }
}
