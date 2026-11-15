import { validateSchoolReportsQuery, verifySchoolReportLocations, verifySchoolReports, type SchoolReportLocations, type SchoolReports } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/** School reports (R1, 0331): one same-origin GET with no key and no command header. The server decides every permission. */
export type ReportsErrorKind = 'SESSION' | 'DENIED' | 'TIMEZONE' | 'TOO_MANY' | 'UNAVAILABLE';
export class ReportsError extends Error { constructor(readonly kind: ReportsErrorKind) { super(kind); } }
export type ReportsScope = Readonly<{ organizationId: string; schoolId: string }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const RESPONSE_MAX = 1_000_000;
const id = (value: string) => { if (!UUID.test(value)) throw new ReportsError('UNAVAILABLE'); return value.toLowerCase(); };

export function reportsErrorFor(status: number, code: string | null): ReportsError {
  if (status === 403) return new ReportsError('DENIED');
  if (status === 409 && code === 'SCHOOL_TIMEZONE_INVALID') return new ReportsError('TIMEZONE');
  if (status === 422 && code === 'SCHOOL_REPORTS_TOO_MANY_LOCATIONS') return new ReportsError('TOO_MANY');
  return new ReportsError('UNAVAILABLE');
}

async function get<T>(scope: ReportsScope, suffix: string, months: number, signal: AbortSignal, owned: () => boolean,
  verify: (data: unknown, query: { months?: number }) => T): Promise<T> {
  let query;
  try { query = validateSchoolReportsQuery({ months }); } catch { throw new ReportsError('UNAVAILABLE'); }
  const path = `/api/v1/organizations/${id(scope.organizationId)}/schools/${id(scope.schoolId)}/reports/monthly${suffix}?months=${query.months}`;
  let r: Response;
  try {
    r = await fetch(path, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      signal, headers: { Accept: 'application/json' } });
  } catch (error) { if (signal.aborted) throw error; throw new ReportsError('UNAVAILABLE'); }
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new ReportsError('SESSION'); }
  let value: unknown = null;
  if (!r.redirected && JSON_TYPE.test(r.headers.get('content-type') ?? '')) {
    const text = await r.text();
    if (text.length > RESPONSE_MAX) throw new ReportsError('UNAVAILABLE');
    try { value = JSON.parse(text) as unknown; } catch { value = null; }
  }
  const code = value && typeof value === 'object' && typeof (value as { code?: unknown }).code === 'string' ? (value as { code: string }).code : null;
  if (r.status !== 200) throw reportsErrorFor(r.status, code);
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
    return verify((value as { data: unknown }).data, query);
  } catch { throw new ReportsError('UNAVAILABLE'); }
}

export const schoolReportsApi = {
  /** This school's months (reporting.view here). */
  read(scope: ReportsScope, months: number, signal: AbortSignal, owned: () => boolean): Promise<SchoolReports> {
    return get(scope, '', months, signal, owned, (data, query) => verifySchoolReports(data, scope.schoolId, query));
  },
  /** R2 (0332): every location of this organization where the same person may see reports. */
  locations(scope: ReportsScope, months: number, signal: AbortSignal, owned: () => boolean): Promise<SchoolReportLocations> {
    return get(scope, '/locations', months, signal, owned, (data, query) => verifySchoolReportLocations(data, scope.organizationId, scope.schoolId, query));
  },
};
export type SchoolReportsApi = typeof schoolReportsApi;
