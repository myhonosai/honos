import { CLASS_SESSION_ROSTER_ATTENDANCE_STATUSES, CLASS_SESSION_ROSTER_BOOKING_STATUSES, type ClassSessionRosterEntry, type CurrentSchoolClassSession } from '@hon/contracts';
import { classSessionsReadPath, parseClassSessionsRead } from '../class-sessions-read-http';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * U5 class rosters: read-only. The session list is the existing current-school read (schedule.session.read); a roster is
 * the U5 read (attendance.record), re-decided live on every page. The browser names only the verified school and one
 * session; nothing here books, records attendance or changes a session.
 */
export type RosterErrorKind = 'SESSION' | 'DENIED' | 'CURSOR' | 'UNAVAILABLE';
export class RosterError extends Error { constructor(readonly kind: RosterErrorKind) { super(kind); } }
export type Owned = () => boolean;
export type RosterScope = Readonly<{ organizationId: string; schoolId: string }>;
export type RosterPage = Readonly<{ entries: readonly ClassSessionRosterEntry[]; nextCursor: string | null }>;
export const ROSTER_PAGE = 50;
const CURSOR_MAX = 512;
const RESPONSE_MAX = 262_144;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KINDS = ['REGULAR', 'TRIAL', 'MAKEUP', 'PRIVATE_LESSON', 'EVENT', 'CLASS_PASS'];
const SOURCES = ['STAFF', 'PARENT_APP', 'AUTOMATION', 'INTEGRATION'];

const fail = (): never => { throw new Error('shape'); };
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const own = Object.keys(value);
  if (own.length !== keys.length || keys.some((k) => !own.includes(k))) fail();
  return value as Record<string, unknown>;
}
const uuid = (v: unknown) => typeof v === 'string' && UUID.test(v);
const text = (v: unknown, max: number) => typeof v === 'string' && v.length >= 1 && v.length <= max;
const instant = (v: unknown) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const version = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 1;
function booking(value: unknown): void {
  if (value === null) return;
  const b = closed(value, ['id', 'kind', 'status', 'source', 'bookedAt', 'cancelledAt', 'version']);
  if (!uuid(b.id) || !KINDS.includes(b.kind as string) || !(CLASS_SESSION_ROSTER_BOOKING_STATUSES as readonly unknown[]).includes(b.status) || !SOURCES.includes(b.source as string)
    || !instant(b.bookedAt) || (b.cancelledAt !== null && !instant(b.cancelledAt)) || (b.status === 'CANCELLED' && b.cancelledAt === null) || !version(b.version)) fail();
}
function attendance(value: unknown): void {
  if (value === null) return;
  const a = closed(value, ['id', 'status', 'category', 'recordedAt', 'version']);
  if (!uuid(a.id) || !(CLASS_SESSION_ROSTER_ATTENDANCE_STATUSES as readonly unknown[]).includes(a.status) || !text(a.category, 64) || !instant(a.recordedAt) || !version(a.version)) fail();
}
/**
 * One roster page, closed: at most one page of distinct students, each booked on or recorded for the session. The roster
 * does not name its session (an unknown or other-school session reads as an empty roster); the session facts shown come
 * from the verified session list.
 */
export function verifyRosterPage(value: unknown): RosterPage {
  const body = closed(value, ['data', 'meta']), meta = closed(body.meta, ['requestId', 'correlationId', 'limit', 'nextCursor']);
  if (!uuid(meta.requestId) || meta.correlationId !== meta.requestId || meta.limit !== ROSTER_PAGE
    || (meta.nextCursor !== null && (typeof meta.nextCursor !== 'string' || meta.nextCursor.length < 1 || meta.nextCursor.length > CURSOR_MAX))) fail();
  if (!Array.isArray(body.data) || body.data.length > ROSTER_PAGE || (meta.nextCursor !== null && body.data.length === 0)) fail();
  const entries = (body.data as unknown[]).map((item) => {
    const e = closed(item, ['studentProfileId', 'personId', 'givenName', 'familyName', 'studentStatus', 'booking', 'attendance']);
    if (!uuid(e.studentProfileId) || !uuid(e.personId) || !text(e.givenName, 500) || !text(e.familyName, 500) || !text(e.studentStatus, 32)) fail();
    booking(e.booking); attendance(e.attendance);
    if (e.booking === null && e.attendance === null) fail();
    return e as unknown as ClassSessionRosterEntry;
  });
  if (new Set(entries.map((e) => e.studentProfileId.toLowerCase())).size !== entries.length) fail();
  return { entries, nextCursor: meta.nextCursor as string | null };
}

async function read(path: string, signal: AbortSignal, owned: Owned, headers: Record<string, string> = {}): Promise<{ status: number; value: unknown }> {
  let response: Response;
  try {
    response = await fetch(path, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', ...headers }, signal });
  } catch (error) { if (signal.aborted) throw error; throw new RosterError('UNAVAILABLE'); }
  // A retired read (aborted, or no longer the one shown) never ends a newer session.
  signal.throwIfAborted();
  if (response.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new RosterError('SESSION'); }
  if (response.status === 403) throw new RosterError('DENIED');
  if (response.redirected || !JSON_TYPE.test(response.headers.get('content-type') ?? '')) return { status: response.status, value: null };
  try {
    const raw = await response.text();
    if (raw.length > RESPONSE_MAX) throw new RosterError('UNAVAILABLE');
    return { status: response.status, value: JSON.parse(raw) as unknown };
  } catch (error) { if (signal.aborted) throw error; throw new RosterError('UNAVAILABLE'); }
}
const codeOf = (v: unknown) => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;

export interface RosterApi {
  sessions(scope: RosterScope, signal: AbortSignal, owned: Owned): Promise<CurrentSchoolClassSession[]>;
  roster(scope: RosterScope, sessionId: string, cursor: string | null, signal: AbortSignal, owned: Owned): Promise<RosterPage>;
}
export const rosterApi: RosterApi = {
  async sessions(scope, signal, owned) {
    let path: string;
    try { path = classSessionsReadPath(scope.organizationId, scope.schoolId); } catch { throw new RosterError('UNAVAILABLE'); }
    const { status, value } = await read(path, signal, owned, { 'X-HON-Human-Read': 'class-sessions' });
    if (status !== 200) throw new RosterError('UNAVAILABLE');
    try { return parseClassSessionsRead(value); } catch { throw new RosterError('UNAVAILABLE'); }
  },
  async roster(scope, sessionId, cursor, signal, owned) {
    if (!uuid(sessionId) || !uuid(scope.organizationId) || !uuid(scope.schoolId) || (cursor !== null && (cursor.length < 1 || cursor.length > CURSOR_MAX))) throw new RosterError('UNAVAILABLE');
    const query = new URLSearchParams({ limit: String(ROSTER_PAGE), ...(cursor === null ? {} : { cursor }) });
    const path = `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/schedule/sessions/${sessionId.toLowerCase()}/roster?${query}`;
    const { status, value } = await read(path, signal, owned);
    if (status === 400 && codeOf(value) === 'INVALID_CURSOR') throw new RosterError('CURSOR');
    if (status !== 200) throw new RosterError('UNAVAILABLE');
    try { return verifyRosterPage(value); } catch { throw new RosterError('UNAVAILABLE'); }
  },
};

/** Counts over the rows read so far only; the view says when more rows exist. */
export function rosterCounts(entries: readonly ClassSessionRosterEntry[]) {
  let booked = 0, waitlisted = 0, cancelled = 0, walkIns = 0, recorded = 0;
  for (const e of entries) {
    if (e.booking === null) walkIns++;
    else if (e.booking.status === 'WAITLISTED') waitlisted++;
    else if (e.booking.status === 'CANCELLED') cancelled++;
    else booked++;
    if (e.attendance !== null) recorded++;
  }
  return { booked, waitlisted, cancelled, walkIns, recorded };
}
