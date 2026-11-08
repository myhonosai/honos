/**
 * U5 class-session roster read (GET /v1/organizations/:org/schools/:school/schedule/sessions/:sessionId/roster).
 * Read-only: one row per student who is booked on, or has attendance recorded for, the exact session of the verified
 * school. Cancelled bookings stay listed with their status. Ordered by family name, given name, student profile id.
 */
export const CLASS_SESSION_ROSTER_BOOKING_STATUSES = ['BOOKED', 'WAITLISTED', 'CANCELLED', 'CHECKED_IN', 'NO_SHOW'] as const;
export const CLASS_SESSION_ROSTER_ATTENDANCE_STATUSES = ['PRESENT', 'LATE', 'EXCUSED_ABSENCE', 'UNEXCUSED_ABSENCE', 'MAKEUP'] as const;

export interface ClassSessionRosterBooking {
  id: string;
  kind: 'REGULAR' | 'TRIAL' | 'MAKEUP' | 'PRIVATE_LESSON' | 'EVENT';
  status: (typeof CLASS_SESSION_ROSTER_BOOKING_STATUSES)[number];
  source: 'STAFF' | 'PARENT_APP' | 'AUTOMATION' | 'INTEGRATION';
  bookedAt: string;
  cancelledAt: string | null;
  version: number;
}

export interface ClassSessionRosterAttendance {
  id: string;
  status: (typeof CLASS_SESSION_ROSTER_ATTENDANCE_STATUSES)[number];
  category: string;
  recordedAt: string;
  version: number;
}

export interface ClassSessionRosterEntry {
  studentProfileId: string;
  personId: string;
  givenName: string;
  familyName: string;
  studentStatus: string;
  booking: ClassSessionRosterBooking | null;
  attendance: ClassSessionRosterAttendance | null;
}

export interface ClassSessionRosterSession {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  status: string;
  capacity: number;
}

/** Response meta: { requestId, correlationId, limit, nextCursor, session }. */
export interface ClassSessionRosterMeta {
  requestId: string;
  correlationId: string;
  limit: number;
  nextCursor: string | null;
  session: ClassSessionRosterSession;
}
