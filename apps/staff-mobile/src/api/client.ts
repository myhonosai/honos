import { verifyCurrentStaffReportingSchool, verifyStaffReportingSchools } from '@hon/contracts/staff-school-choice';
import { verifyMyTimeClock, verifyTimeEntryReceipt, type MyTimeClock, type TimeClockAction, type TimeEntry } from '@hon/contracts/staff-time-clock';
import {
  CLASS_PAGE, ROSTER_PAGE, isUuid, rosterCategory, verifyAttendanceEnvelope, verifyRosterPage, verifyStudentSearch, verifyTodayClasses,
  type StudentSearch, type ClassSessionRosterAttendance, type ClassSessionRosterEntry, type RosterMark, type RosterPage, type TodayClasses,
} from './today';

/**
 * HON Staff app API client (S0b). Every call is a native bearer request: no cookies, no Origin. The server decides
 * who the person is and which schools they may work at; the app only shows what a shared contract verifier accepts.
 */
export type StaffFailureState = 'signed-out' | 'no-staff-access' | 'unavailable' | 'offline';
export type StaffRead<T> = { ok: true; data: T } | { ok: false; state: StaffFailureState };

/** A school is a place to look at, never authority: each later school read re-checks the person's role itself. */
export interface StaffSchool { organizationId: string; schoolId: string; schoolName: string | null }
export type WorkPlace = { kind: 'one'; school: StaffSchool } | { kind: 'choose'; schools: StaffSchool[] };
export type WhereIWork = StaffRead<WorkPlace>;

/**
 * A command's outcome. `changed`: someone else changed it first, nothing was saved (read again). `rejected`: not
 * accepted as sent, nothing was saved. `unknown` and `offline`: the outcome is not known, and only the identical
 * command with the same key may be sent again.
 */
export type StaffCommandFailure = 'signed-out' | 'no-staff-access' | 'changed' | 'rejected' | 'unknown' | 'offline';
export type StaffCommand<T> = { ok: true; data: T } | { ok: false; state: StaffCommandFailure };

export interface StaffApi {
  whereIWork(): Promise<WhereIWork>;
  /** S1 Today: today's classes at the school (schedule.session.read, re-decided by the server). */
  todayClasses(school: StaffSchool): Promise<StaffRead<TodayClasses>>;
  /** The roster of one class (attendance.record). */
  roster(school: StaffSchool, sessionId: string): Promise<StaffRead<RosterPage>>;
  /** Find active students of the school by name, to mark one who is not on the roster (attendance.record). */
  findStudents(school: StaffSchool, search: string): Promise<StaffRead<StudentSearch>>;
  /** Mark one student. A change to an existing mark re-reads it first and sends its version, note and category back. */
  mark(school: StaffSchool, sessionId: string, entry: ClassSessionRosterEntry, status: RosterMark, key: string): Promise<StaffCommand<ClassSessionRosterAttendance>>;
  /** The person's own clock (staff.time.clock). */
  clock(school: StaffSchool): Promise<StaffRead<MyTimeClock>>;
  /** Clock in or out at the server's clock. */
  punch(school: StaffSchool, action: TimeClockAction, expectedVersion: number, key: string): Promise<StaffCommand<TimeEntry>>;
}

export interface StaffApiOptions {
  baseUrl: string;
  getToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The API base exactly as reads use it (origin + path, e.g. https://app.myhonos.com/api). Sign-in must use the same base. */
export function checkedBaseUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('The HON API address is not a valid URL.'); }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '10.0.2.2';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('The HON API address must use https.');
  if (url.username || url.password || url.search || url.hash) throw new Error('The HON API address must be a plain origin.');
  if (/REPLACE-WITH/i.test(raw)) throw new Error('The HON API address has not been configured for this build.');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

const codeOf = (v: unknown): string | null =>
  v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;

function classify(status: number): StaffFailureState {
  if (status === 401) return 'signed-out';
  if (status === 403) return 'no-staff-access';
  return 'unavailable';
}

export function createStaffApi(options: StaffApiOptions): StaffApi {
  const baseUrl = checkedBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  type Answer = { kind: 'answer'; status: number; body: unknown } | { kind: 'signed-out' } | { kind: 'offline' };
  async function send(method: 'GET' | 'POST', path: string, extra: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Answer> {
    const token = await options.getToken();
    if (!token) return { kind: 'signed-out' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          method, credentials: 'omit', signal: controller.signal,
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(extra.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra.headers },
          ...(extra.body !== undefined ? { body: JSON.stringify(extra.body) } : {}),
        });
      } catch {
        return { kind: 'offline' };
      }
      let body: unknown = null;
      try { body = await response.json(); } catch { /* an unreadable body is handled by the caller */ }
      return { kind: 'answer', status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  async function get<T>(path: string, verify: (body: unknown) => T, headers?: Record<string, string>): Promise<StaffRead<T>> {
    const answer = await send('GET', path, { headers });
    if (answer.kind !== 'answer') return { ok: false, state: answer.kind };
    if (answer.status < 200 || answer.status > 299) return { ok: false, state: classify(answer.status) };
    try { return { ok: true, data: verify(answer.body) }; } catch { return { ok: false, state: 'unavailable' }; }
  }

  const CHANGED = new Set(['VERSION_CONFLICT', 'VERSION_REQUIRED', 'TIME_CLOCK_STATE_CHANGED']);
  async function post<T>(path: string, command: string, key: string, body: unknown, verify: (body: unknown) => T): Promise<StaffCommand<T>> {
    const answer = await send('POST', path, { headers: { 'X-HON-Human-Command': command, 'Idempotency-Key': key }, body });
    if (answer.kind !== 'answer') return { ok: false, state: answer.kind };
    const { status } = answer;
    if (status === 401) return { ok: false, state: 'signed-out' };
    if (status === 403) return { ok: false, state: 'no-staff-access' };
    if (status === 409) return { ok: false, state: CHANGED.has(codeOf(answer.body) ?? '') ? 'changed' : 'unknown' };
    if (status === 400 || status === 404 || status === 422) return { ok: false, state: 'rejected' };
    if (status < 200 || status > 299) return { ok: false, state: 'unknown' };
    try { return { ok: true, data: verify(answer.body) }; } catch { return { ok: false, state: 'unknown' }; }
  }

  const schoolPath = (school: StaffSchool) => {
    if (!isUuid(school.organizationId) || !isUuid(school.schoolId)) throw new Error('Not a school.');
    return `/v1/organizations/${school.organizationId.toLowerCase()}/schools/${school.schoolId.toLowerCase()}`;
  };
  const sessionPath = (school: StaffSchool, sessionId: string) => {
    if (!isUuid(sessionId)) throw new Error('Not a class.');
    return `${schoolPath(school)}/schedule/sessions/${sessionId.toLowerCase()}`;
  };
  const envelopeData = (body: unknown): unknown => {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('data' in body) || !('meta' in body)) throw new Error('shape');
    return (body as { data: unknown }).data;
  };

  return {
    /** Same order as the web sign-in routing: the one current school, else the list to choose from. */
    async whereIWork(): Promise<WhereIWork> {
      const current = await get('/v1/staff/current-reporting-school', verifyCurrentStaffReportingSchool);
      if (!current.ok) return current;
      if (current.data.state === 'RESOLVED') {
        return { ok: true, data: { kind: 'one', school: { organizationId: current.data.organizationId, schoolId: current.data.schoolId, schoolName: null } } };
      }
      const choices = await get('/v1/staff/reporting-schools', verifyStaffReportingSchools);
      if (!choices.ok) return choices;
      if (choices.data.state !== 'SELECTION_REQUIRED') return { ok: false, state: 'no-staff-access' };
      return { ok: true, data: { kind: 'choose', schools: choices.data.schools.map(s => ({ organizationId: s.organizationId, schoolId: s.schoolId, schoolName: s.schoolName })) } };
    },

    todayClasses(school) {
      return get(`${schoolPath(school)}/schedule/sessions/list?limit=${CLASS_PAGE}`, verifyTodayClasses, { 'X-HON-Human-Read': 'class-sessions' });
    },

    roster(school, sessionId) {
      return get(`${sessionPath(school, sessionId)}/roster?limit=${ROSTER_PAGE}`, verifyRosterPage);
    },

    findStudents(school, search) {
      const text = search.trim().slice(0, 120);
      return get(`${schoolPath(school)}/pickers/students?${new URLSearchParams({ for: 'attendance', search: text })}`, verifyStudentSearch);
    },

    async mark(school, sessionId, entry, status, key) {
      const path = `${sessionPath(school, sessionId)}/attendance`;
      const student = entry.studentProfileId.toLowerCase();
      if (!isUuid(student)) return { ok: false, state: 'rejected' };
      let note = '', category = rosterCategory(entry), expectedVersion: number | undefined;
      if (entry.attendance) {
        // The roster does not carry the note and the server replaces it on every save: read the exact record first.
        const current = await get(`${path}?studentProfileId=${student}`, body => verifyAttendanceEnvelope(body, sessionId, student, false).record);
        if (!current.ok) return { ok: false, state: current.state === 'unavailable' ? 'unknown' : current.state };
        if (!current.data || current.data.id.toLowerCase() !== entry.attendance.id.toLowerCase() || current.data.version !== entry.attendance.version) return { ok: false, state: 'changed' };
        note = current.data.note ?? ''; category = current.data.category; expectedVersion = current.data.version;
      }
      return post(path, 'attendance', key, { studentProfileId: student, status, category, note, ...(expectedVersion !== undefined ? { expectedVersion } : {}) }, body => {
        const { record } = verifyAttendanceEnvelope(body, sessionId, student, true);
        if (!record || record.status !== status) throw new Error('shape');
        return { id: record.id, status: record.status as ClassSessionRosterAttendance['status'], category: record.category, recordedAt: record.recordedAt, version: record.version };
      });
    },

    clock(school) {
      return get(`${schoolPath(school)}/staff/time/clock`, body => verifyMyTimeClock(envelopeData(body)));
    },

    punch(school, action, expectedVersion, key) {
      return post(`${schoolPath(school)}/staff/time/clock`, 'staff_time.punch', key, { action, expectedVersion }, body => {
        const replayed = (body as { meta?: { replayed?: unknown } } | null)?.meta?.replayed;
        return verifyTimeEntryReceipt({ entry: envelopeData(body), replayed }, { version: expectedVersion + 1, closed: action === 'CLOCK_OUT' }).entry;
      });
    },
  };
}
