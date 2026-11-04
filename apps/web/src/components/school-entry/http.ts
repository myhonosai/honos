import { verifyCurrentStaffReportingSchool } from '../current-staff-reporting-school-http';
import { verifyStaffReportingSchools } from '../staff-reporting-schools-http';
import { staffDashboardReportPath, verifyStaffDashboardSnapshot } from '../staff-dashboard-http';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

export type SchoolScope = Readonly<{ organizationId: string; schoolId: string }>;
export class SchoolEntryError extends Error {
  constructor(readonly kind: 'SESSION' | 'DENIED' | 'UNAVAILABLE' | 'IDENTITY') { super(kind); }
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new SchoolEntryError('UNAVAILABLE');
  return value as Record<string, unknown>;
}
/** Read-only fixed paths; no browser role, actor, delegation or authority headers. */
async function read(path: string, signal: AbortSignal, requireNoStoreEcho = true): Promise<unknown> {
  const response = await fetch(path, { method: 'GET', credentials: 'same-origin', mode: 'same-origin',
    cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal });
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new SchoolEntryError('SESSION'); }
  if (response.status === 403) throw new SchoolEntryError('DENIED');
  if (response.status !== 200 || response.redirected || response.url && (typeof location === 'undefined' || response.url !== new URL(path, location.origin).href)
    || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
    || requireNoStoreEcho && !response.headers.get('cache-control')?.split(',').map(s => s.trim()).includes('no-store') || !response.body) throw new SchoolEntryError('UNAVAILABLE');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let bytes = 0, text = '';
  try {
    while (true) {
      signal.throwIfAborted(); const chunk = await reader.read(); signal.throwIfAborted(); if (chunk.done) break;
      bytes += chunk.value.byteLength; if (bytes > 65536) throw new SchoolEntryError('UNAVAILABLE');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
}
export const schoolEntryApi = {
  async identity(subject: string, signal: AbortSignal): Promise<void> {
    const data = closed(await read('/api/identity/me', signal), ['data']).data;
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(k => !['externalSubject', 'displayName', 'email'].includes(k))
      || !('externalSubject' in data) || typeof data.externalSubject !== 'string') throw new SchoolEntryError('UNAVAILABLE');
    if (!subject || data.externalSubject !== subject) throw new SchoolEntryError('IDENTITY');
  },
  async current(signal: AbortSignal) { return verifyCurrentStaffReportingSchool(await read('/api/v1/staff/current-reporting-school', signal)); },
  async choices(signal: AbortSignal) { return verifyStaffReportingSchools(await read('/api/v1/staff/reporting-schools', signal)); },
  async verifySchool(scope: SchoolScope, signal: AbortSignal): Promise<void> {
    // The existing operations-report controller does not echo Cache-Control. The
    // browser request still forbids caching; do not invent a new backend contract.
    const data = closed(closed(await read(staffDashboardReportPath(scope.organizationId, scope.schoolId), signal, false), ['data', 'meta']).data, ['operationalSnapshot']);
    // Use the canonical closed aggregate validator; retain neither counts nor student facts.
    verifyStaffDashboardSnapshot(data.operationalSnapshot, scope.organizationId, scope.schoolId);
  },
};
export type SchoolEntryApi = typeof schoolEntryApi;
