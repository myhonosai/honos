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
    externalSubject: string,
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
        bookings: await this.selectBookings(client, externalSubject, requestedFamilyId, range),
      }),
    );
  }

  private async selectBookings(
    client: PoolClient,
    externalSubject: string,
    familyId: string,
    range: ParentFamilyScheduleRange,
  ): Promise<ParentFamilySchedule['bookings']> {
    // #177 (0632): the runtime has no SELECT on hon.class_sessions. The definer read keeps the fixed relation path
    // (exact-family STUDENT membership -> primary-family profile -> booking -> session -> program) and re-proves this
    // family for this transaction's own principal through hon.resolve_parent_family_scope.
    let result: { rows: ParentFamilyScheduleRow[] };
    try {
      result = await client.query<ParentFamilyScheduleRow>(
        `SELECT student_display_name AS "studentDisplayName", booking_kind AS "bookingKind",
                booking_status AS "bookingStatus", session_name AS "sessionName",
                session_starts_at AS "sessionStartsAt", session_ends_at AS "sessionEndsAt",
                session_room_name AS "sessionRoomName", session_status AS "sessionStatus", program_name AS "programName"
         FROM hon.read_parent_family_schedule($1, $2::uuid, $3::timestamptz, $4::timestamptz)`,
        [externalSubject, familyId, range.from, range.to],
      );
    } catch (error) {
      const refused = error as { code?: string; message?: string } | null;
      if (refused?.code === '42501' && refused.message === 'CLASS_SESSIONS_READ_FORBIDDEN') {
        throw new ForbiddenException('HON parent access is not authorized for this family.');
      }
      throw error;
    }

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
