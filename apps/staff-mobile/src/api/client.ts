import { verifyCurrentStaffReportingSchool, verifyStaffReportingSchools } from '@hon/contracts/staff-school-choice';

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

export interface StaffApi { whereIWork(): Promise<WhereIWork> }

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

function classify(status: number): StaffFailureState {
  if (status === 401) return 'signed-out';
  if (status === 403) return 'no-staff-access';
  return 'unavailable';
}

export function createStaffApi(options: StaffApiOptions): StaffApi {
  const baseUrl = checkedBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function get<T>(path: string, verify: (body: unknown) => T): Promise<StaffRead<T>> {
    const token = await options.getToken();
    if (!token) return { ok: false, state: 'signed-out' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          method: 'GET', credentials: 'omit', signal: controller.signal,
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        });
      } catch {
        return { ok: false, state: 'offline' };
      }
      let body: unknown = null;
      try { body = await response.json(); } catch { /* an unreadable body is handled below */ }
      if (!response.ok) return { ok: false, state: classify(response.status) };
      try { return { ok: true, data: verify(body) }; } catch { return { ok: false, state: 'unavailable' }; }
    } finally {
      clearTimeout(timer);
    }
  }

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
  };
}
