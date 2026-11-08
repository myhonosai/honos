import { Injectable, NotFoundException } from '@nestjs/common';
import type { AttendanceCommandContext, ClassSessionRosterEntry, ClassSessionRosterSession } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { decodeListCursor, encodeListCursor, staleListCursor } from '../foundation/list-cursor.js';
import { markAttendanceHuman, requireAttendanceHuman } from './attendance-policy.service.js';
import { attendanceDatabaseError } from './attendance-database-error.js';

/** A roster position is the last student's (studentProfileId, person version); live name keys are read from the row. */
const ROSTER_CURSOR = ['uuid', 'version'] as const;
const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

interface RosterRow {
  studentProfileId: string; personId: string; givenName: string; familyName: string; studentStatus: string; personVersion: number;
  bookingId: string | null; bookingKind: string | null; bookingStatus: string | null; bookingSource: string | null;
  bookedAt: Date | null; cancelledAt: Date | null; bookingVersion: number | null;
  attendanceId: string | null; attendanceStatus: string | null; attendanceCategory: string | null; recordedAt: Date | null; attendanceVersion: number | null;
}

@Injectable()
export class ClassSessionRosterService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  /**
   * Read-only roster of one exact class session. Authority, the human-UI boundary, organization/school lifecycle and the
   * attendance entitlement are re-decided live inside the transaction by hon.lock_attendance_actor (the same gate the
   * exact attendance lookup uses), so a permission removed or a school suspended between pages refuses the next page.
   */
  async read(
    context: AttendanceCommandContext,
    sessionId: string,
    page: { limit?: number | undefined; cursor?: string | undefined },
  ): Promise<{ entries: ClassSessionRosterEntry[]; session: ClassSessionRosterSession; nextCursor: string | null; limit: number }> {
    requireAttendanceHuman(context);
    const limit = page.limit ?? 50;
    const after = decodeListCursor(page.cursor, 'schedule.session.roster', context.schoolId, { sessionId }, ROSTER_CURSOR);
    try {
      return await this.database.withTenantTransaction(context, async (client) => {
        await markAttendanceHuman(client, context);
        await client.query('SELECT hon.lock_attendance_actor($1,$2)', [context.externalSubject, 'attendance.record']);
        const sessionRow = await client.query<{ id: string; name: string; startsAt: Date; endsAt: Date; status: string; capacity: number }>(
          `SELECT id, name, starts_at AS "startsAt", ends_at AS "endsAt", status::text AS status, capacity
           FROM hon.class_sessions WHERE id = $1::uuid AND organization_id = $2 AND school_id = $3`,
          [sessionId, context.organizationId, context.schoolId],
        );
        const found = sessionRow.rows[0];
        if (!found) throw new NotFoundException({ code: 'CLASS_SESSION_NOT_FOUND', detail: 'The class session is not available in this school.' });
        // Every roster entry: a booking or an attendance record of this exact session (walk-ins have no booking).
        const entries = `SELECT student_profile_id FROM hon.class_bookings WHERE class_session_id = $3::uuid AND organization_id = $1 AND school_id = $2
                         UNION SELECT student_profile_id FROM hon.attendance_records WHERE class_session_id = $3::uuid AND organization_id = $1 AND school_id = $2`;
        if (after) {
          // The anchor must still be on this roster with the same person version; otherwise the position moved.
          const anchor = await client.query(
            `SELECT 1 FROM (${entries}) AS e JOIN hon.student_profiles AS sp ON sp.id = e.student_profile_id
             JOIN hon.people AS p ON p.id = sp.person_id AND p.organization_id = $1 AND p.school_id = $2
             WHERE sp.id = $4::uuid AND p.version = $5::bigint`,
            [context.organizationId, context.schoolId, sessionId, after[0], after[1]],
          );
          if (anchor.rowCount !== 1) staleListCursor();
        }
        const result = await client.query<RosterRow>(
          `SELECT sp.id AS "studentProfileId", sp.person_id AS "personId", p.given_name AS "givenName", p.family_name AS "familyName",
                  sp.status::text AS "studentStatus", p.version AS "personVersion",
                  b.id AS "bookingId", b.booking_kind AS "bookingKind", b.status::text AS "bookingStatus", b.source AS "bookingSource",
                  b.booked_at AS "bookedAt", b.cancelled_at AS "cancelledAt", b.version AS "bookingVersion",
                  a.id AS "attendanceId", a.status::text AS "attendanceStatus", a.category AS "attendanceCategory",
                  a.recorded_at AS "recordedAt", a.version AS "attendanceVersion"
           FROM (${entries}) AS e
           JOIN hon.student_profiles AS sp ON sp.id = e.student_profile_id AND sp.organization_id = $1 AND sp.school_id = $2
           JOIN hon.people AS p ON p.id = sp.person_id AND p.organization_id = $1 AND p.school_id = $2
           LEFT JOIN hon.class_bookings AS b ON b.class_session_id = $3::uuid AND b.student_profile_id = sp.id AND b.organization_id = $1 AND b.school_id = $2
           LEFT JOIN hon.attendance_records AS a ON a.class_session_id = $3::uuid AND a.student_profile_id = sp.id AND a.organization_id = $1 AND a.school_id = $2
           WHERE $5::uuid IS NULL OR (p.family_name, p.given_name, sp.id) > (
             SELECT ap.family_name, ap.given_name, asp.id FROM hon.student_profiles AS asp
             JOIN hon.people AS ap ON ap.id = asp.person_id AND ap.organization_id = $1 AND ap.school_id = $2
             WHERE asp.id = $5::uuid AND asp.organization_id = $1 AND asp.school_id = $2)
           ORDER BY p.family_name ASC, p.given_name ASC, sp.id ASC
           LIMIT $4`,
          [context.organizationId, context.schoolId, sessionId, limit + 1, after?.[0] ?? null],
        );
        const rows = result.rows.slice(0, limit);
        const last = result.rows.length > limit ? rows[rows.length - 1] : undefined;
        return {
          entries: rows.map(toEntry),
          session: { id: found.id, name: found.name, startsAt: iso(found.startsAt)!, endsAt: iso(found.endsAt)!, status: found.status, capacity: found.capacity },
          nextCursor: last ? encodeListCursor('schedule.session.roster', context.schoolId, { sessionId }, ROSTER_CURSOR, [last.studentProfileId, String(last.personVersion)]) : null,
          limit,
        };
      });
    } catch (error) {
      if (error instanceof NotFoundException || (error as { getStatus?: () => number }).getStatus?.() === 400) throw error;
      return attendanceDatabaseError(error);
    }
  }
}

function toEntry(row: RosterRow): ClassSessionRosterEntry {
  return {
    studentProfileId: row.studentProfileId,
    personId: row.personId,
    givenName: row.givenName,
    familyName: row.familyName,
    studentStatus: row.studentStatus,
    booking: row.bookingId === null ? null : {
      id: row.bookingId, kind: row.bookingKind as never, status: row.bookingStatus as never, source: row.bookingSource as never,
      bookedAt: iso(row.bookedAt)!, cancelledAt: iso(row.cancelledAt), version: row.bookingVersion!,
    },
    attendance: row.attendanceId === null ? null : {
      id: row.attendanceId, status: row.attendanceStatus as never, category: row.attendanceCategory!, recordedAt: iso(row.recordedAt)!, version: row.attendanceVersion!,
    },
  };
}
