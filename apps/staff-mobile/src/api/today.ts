import { verifyCurrentSchoolClassSessionItems, type CurrentSchoolClassSession } from '@hon/contracts/class-sessions-read';
import { CLASS_SESSION_ROSTER_ATTENDANCE_STATUSES, CLASS_SESSION_ROSTER_BOOKING_STATUSES, type ClassSessionRosterAttendance, type ClassSessionRosterEntry } from '@hon/contracts/class-session-roster';
import { ATTENDANCE_CATEGORIES } from '@hon/contracts/attendance-policy';

/**
 * S1 Today response checks (docs/architecture/STAFF_MOBILE_TODAY.md). Closed: an answer with a missing, extra or
 * ill-typed field is refused and nothing is shown. Same rules as the web roster (apps/web/src/components/class-roster)
 * and attendance pages; session rows and the clock use the shared contract verifiers.
 */
export const CLASS_PAGE = 50;
export const ROSTER_PAGE = 50;
export const ROSTER_MARKS = ['PRESENT', 'LATE', 'EXCUSED_ABSENCE', 'UNEXCUSED_ABSENCE'] as const;
export type RosterMark = (typeof ROSTER_MARKS)[number];

export interface TodayClasses {
  timezone: string;
  localToday: string;
  /** Today's classes in start order (school-local date). */
  classes: CurrentSchoolClassSession[];
  /** True when the first page ended inside today, so more classes may exist than shown. */
  more: boolean;
}
export const STUDENT_SEARCH_LIMIT = 50;
export interface FoundStudent { studentProfileId: string; givenName: string; familyName: string }
export interface StudentSearch { students: FoundStudent[]; more: boolean }
export interface RosterPage { entries: ClassSessionRosterEntry[]; more: boolean }
/** The exact attendance record the server holds for one student in one class. */
export interface AttendanceRecord { id: string; status: string; category: string; note: string | null; recordedAt: string; version: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURSOR_MAX = 512;
const KINDS = ['REGULAR', 'TRIAL', 'MAKEUP', 'PRIVATE_LESSON', 'EVENT', 'CLASS_PASS'];
const SOURCES = ['STAFF', 'PARENT_APP', 'AUTOMATION', 'INTEGRATION'];

const fail = (): never => { throw new Error('The HON answer could not be verified.'); };
function closed(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const own = Object.keys(value);
  if (keys.some(k => !own.includes(k)) || own.some(k => !keys.includes(k) && !optional.includes(k))) fail();
  return value as Record<string, unknown>;
}
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const text = (v: unknown, max: number) => typeof v === 'string' && v.length >= 1 && v.length <= max;
const instant = (v: unknown) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const version = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 1;
const realDate = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DATE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
};
const cursor = (v: unknown) => v === null || (typeof v === 'string' && v.length >= 1 && v.length <= CURSOR_MAX);
function meta(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const m = closed(value, keys);
  if (!isUuid(m.requestId) || m.correlationId !== m.requestId) fail();
  return m;
}

/** YYYY-MM-DD of an instant in a time zone. */
export function localDate(at: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
/** h:mm AM/PM of an instant in a time zone. */
export function localTime(at: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(at));
}

/** The first class-list page from the school's own today (no from date sent), kept to today's classes. */
export function verifyTodayClasses(value: unknown): TodayClasses {
  const body = closed(value, ['data', 'meta']);
  const m = meta(body.meta, ['requestId', 'correlationId', 'limit', 'nextCursor', 'schoolTimezone', 'localToday', 'fromDate']);
  if (m.limit !== CLASS_PAGE || !text(m.schoolTimezone, 64) || !realDate(m.localToday) || m.fromDate !== m.localToday || !cursor(m.nextCursor)) fail();
  if (!Array.isArray(body.data) || (m.nextCursor !== null && body.data.length !== CLASS_PAGE)) fail();
  const timezone = m.schoolTimezone as string, localToday = m.localToday as string;
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { fail(); }
  const items = verifyCurrentSchoolClassSessionItems(body.data, CLASS_PAGE);
  const classes = items.filter(item => localDate(item.startsAt, timezone) === localToday);
  const lastIsToday = items.length > 0 && localDate(items[items.length - 1]!.startsAt, timezone) === localToday;
  return { timezone, localToday, classes, more: m.nextCursor !== null && lastIsToday };
}

function booking(value: unknown): void {
  if (value === null) return;
  const b = closed(value, ['id', 'kind', 'status', 'source', 'bookedAt', 'cancelledAt', 'version']);
  if (!isUuid(b.id) || !KINDS.includes(b.kind as string) || !(CLASS_SESSION_ROSTER_BOOKING_STATUSES as readonly unknown[]).includes(b.status)
    || !SOURCES.includes(b.source as string) || !instant(b.bookedAt) || (b.cancelledAt !== null && !instant(b.cancelledAt))
    || (b.status === 'CANCELLED' && b.cancelledAt === null) || !version(b.version)) fail();
}
function rosterAttendance(value: unknown): void {
  if (value === null) return;
  const a = closed(value, ['id', 'status', 'category', 'recordedAt', 'version']);
  if (!isUuid(a.id) || !(CLASS_SESSION_ROSTER_ATTENDANCE_STATUSES as readonly unknown[]).includes(a.status) || !text(a.category, 64) || !instant(a.recordedAt) || !version(a.version)) fail();
}
/** One roster page: distinct students, each booked on or recorded for the class. */
export function verifyRosterPage(value: unknown): RosterPage {
  const body = closed(value, ['data', 'meta']);
  const m = meta(body.meta, ['requestId', 'correlationId', 'limit', 'nextCursor']);
  if (m.limit !== ROSTER_PAGE || !cursor(m.nextCursor)) fail();
  if (!Array.isArray(body.data) || body.data.length > ROSTER_PAGE || (m.nextCursor !== null && body.data.length === 0)) fail();
  const entries = (body.data as unknown[]).map(item => {
    const e = closed(item, ['studentProfileId', 'personId', 'givenName', 'familyName', 'studentStatus', 'booking', 'attendance']);
    if (!isUuid(e.studentProfileId) || !isUuid(e.personId) || !text(e.givenName, 500) || !text(e.familyName, 500) || !text(e.studentStatus, 32)) fail();
    booking(e.booking); rosterAttendance(e.attendance);
    if (e.booking === null && e.attendance === null) fail();
    return e as unknown as ClassSessionRosterEntry;
  });
  if (new Set(entries.map(e => e.studentProfileId.toLowerCase())).size !== entries.length) fail();
  return { entries, more: m.nextCursor !== null };
}

/** Active students of the school found by name (the attendance pick list): distinct, at most one page. */
export function verifyStudentSearch(value: unknown): StudentSearch {
  const body = closed(value, ['data', 'meta']);
  const m = meta(body.meta, ['requestId', 'correlationId', 'limit']);
  if (m.limit !== STUDENT_SEARCH_LIMIT || !Array.isArray(body.data) || body.data.length > STUDENT_SEARCH_LIMIT) fail();
  const students = (body.data as unknown[]).map(item => {
    const r = closed(item, ['studentProfileId', 'givenName', 'familyName']);
    if (!isUuid(r.studentProfileId) || !text(r.givenName, 500) || !text(r.familyName, 500)) fail();
    return { studentProfileId: (r.studentProfileId as string).toLowerCase(), givenName: r.givenName as string, familyName: r.familyName as string };
  });
  if (new Set(students.map(s => s.studentProfileId)).size !== students.length) fail();
  return { students, more: students.length === STUDENT_SEARCH_LIMIT };
}

/** The exact record (or null on a read with none yet) for this class and student; a save always returns one. */
export function verifyAttendanceEnvelope(value: unknown, sessionId: string, studentProfileId: string, save: boolean): { record: AttendanceRecord | null; replayed: boolean } {
  const body = closed(value, ['data', 'meta']);
  const m = save ? meta(body.meta, ['requestId', 'correlationId', 'replayed']) : meta(body.meta, ['requestId', 'correlationId']);
  if (save && typeof m.replayed !== 'boolean') fail();
  if (body.data === null) { if (save) fail(); return { record: null, replayed: false }; }
  const d = closed(body.data,
    ['id', 'classSessionId', 'studentProfileId', 'status', 'category', 'progressionPolicyVersion', 'progressionEnabled', 'progressionWeightMilli', 'progressionCreditMilli', 'recordedAt', 'version', 'createdAt', 'updatedAt'],
    ['classBookingId', 'recordedByPrincipalId', 'note']);
  if (!isUuid(d.id) || typeof d.classSessionId !== 'string' || d.classSessionId.toLowerCase() !== sessionId.toLowerCase()
    || typeof d.studentProfileId !== 'string' || d.studentProfileId.toLowerCase() !== studentProfileId.toLowerCase()
    || !(CLASS_SESSION_ROSTER_ATTENDANCE_STATUSES as readonly unknown[]).includes(d.status) || !(ATTENDANCE_CATEGORIES as readonly unknown[]).includes(d.category)
    || !version(d.version) || !instant(d.recordedAt) || !instant(d.createdAt) || !instant(d.updatedAt)
    || typeof d.progressionEnabled !== 'boolean' || !Number.isSafeInteger(d.progressionPolicyVersion) || (d.progressionPolicyVersion as number) < 0
    || !Number.isSafeInteger(d.progressionWeightMilli) || !Number.isSafeInteger(d.progressionCreditMilli)
    || ('classBookingId' in d && !isUuid(d.classBookingId)) || ('recordedByPrincipalId' in d && !isUuid(d.recordedByPrincipalId))
    || ('note' in d && (typeof d.note !== 'string' || d.note.length > 2000))) fail();
  return {
    record: { id: d.id as string, status: d.status as string, category: d.category as string, note: 'note' in d ? (d.note as string) : null, recordedAt: d.recordedAt as string, version: d.version as number },
    replayed: m.replayed === true,
  };
}

/**
 * The attendance category for a new mark: the booking says what kind of visit it was (a trial is never counted as a
 * regular member's class). Same rule as the web roster.
 */
export function rosterCategory(entry: Pick<ClassSessionRosterEntry, 'booking' | 'attendance'>): string {
  if (entry.attendance && (ATTENDANCE_CATEGORIES as readonly string[]).includes(entry.attendance.category)) return entry.attendance.category;
  switch (entry.booking?.kind) {
    case 'TRIAL': return 'TRIAL_STUDENT';
    case 'MAKEUP': return 'MAKEUP_CLASS';
    case 'PRIVATE_LESSON': return 'PRIVATE_LESSON';
    case 'EVENT': return 'SPECIAL_EVENT';
    case 'CLASS_PASS': return 'GUEST_DROP_IN';
    default: return 'REGULAR_PARTICIPANT';
  }
}

export type { ClassSessionRosterAttendance, ClassSessionRosterEntry, CurrentSchoolClassSession };
