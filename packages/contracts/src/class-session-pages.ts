/**
 * Forward-paging class-session list (GET /v1/organizations/:org/schools/:school/schedule/sessions/list, migration 0221).
 * Read-only: the verified school's class sessions starting on or after a school-local date (default the school's local
 * today), in published order (UTC millisecond startsAt, then sessionId), 1-100 rows per page with a signed cursor and
 * no fixed window. Rows have exactly the fields of the bounded current-school read (0147/0203).
 */
import { verifyCurrentSchoolClassSessionItems, type CurrentSchoolClassSession } from './class-sessions-read.js';

export const CLASS_SESSION_PAGE_MAXIMUM = 100;
export const CLASS_SESSION_PAGE_DEFAULT_LIMIT = 50;

export type ClassSessionPageItem = CurrentSchoolClassSession;

/** Response meta: { requestId, correlationId, limit, nextCursor, schoolTimezone, localToday, fromDate }. */
export interface ClassSessionPageMeta {
  requestId: string;
  correlationId: string;
  limit: number;
  nextCursor: string | null;
  schoolTimezone: string;
  localToday: string;
  /** The school-local date this list starts from (the requested `from`, or localToday). */
  fromDate: string;
}

/** The database page as returned by hon.read_school_class_session_page (cursorStartsAt is internal to the API). */
export interface ClassSessionDatabasePage {
  items: Array<ClassSessionPageItem & { cursorStartsAt: string }>;
  hasMore: boolean;
  limit: number;
  schoolTimezone: string;
  localToday: string;
  fromDate: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function fail(): never { throw new Error('Unverified class-session page.'); }

/** Strict verifier of the 0221 projection: closed shapes, the 0147 row rules and order, and coherent cursor instants. */
export function verifyClassSessionDatabasePage(value: unknown, expectedLimit: number): ClassSessionDatabasePage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail();
  const page = value as Record<string, unknown>;
  if (Object.keys(page).sort().join(',') !== 'fromDate,hasMore,items,limit,localToday,schoolTimezone' || page.limit !== expectedLimit
    || typeof page.hasMore !== 'boolean' || typeof page.schoolTimezone !== 'string' || !page.schoolTimezone
    || typeof page.localToday !== 'string' || !DATE.test(page.localToday) || typeof page.fromDate !== 'string' || !DATE.test(page.fromDate)
    || !Array.isArray(page.items) || page.items.length > expectedLimit) fail();
  const cursors: string[] = [];
  const rows = page.items.map((raw) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail();
    const { cursorStartsAt, ...row } = raw as Record<string, unknown>;
    if (typeof cursorStartsAt !== 'string') fail();
    cursors.push(cursorStartsAt);
    return row;
  });
  let verified: CurrentSchoolClassSession[];
  try { verified = verifyCurrentSchoolClassSessionItems(rows, expectedLimit); } catch { fail(); }
  // The cursor instant is the published millisecond with three zero microsecond digits, nothing else.
  verified.forEach((row, index) => { if (cursors[index] !== `${row.startsAt.slice(0, -1)}000Z`) fail(); });
  if (page.hasMore && verified.length !== expectedLimit) fail();
  return { items: verified.map((row, index) => ({ ...row, cursorStartsAt: cursors[index]! })), hasMore: page.hasMore,
    limit: expectedLimit, schoolTimezone: page.schoolTimezone, localToday: page.localToday, fromDate: page.fromDate };
}
