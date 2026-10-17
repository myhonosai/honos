import { StaffDashboardAccessError } from './staff-dashboard-http';

const PATH = '/api/v1/staff/current-reporting-school';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type CurrentStaffReportingSchool = { state: 'RESOLVED'; organizationId: string; schoolId: string }
  | { state: 'MANUAL_ENTRY_REQUIRED' };

function invalid(): never { throw new Error('The current reporting school response could not be verified. No school was selected.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))) invalid();
  return row;
}

export function verifyCurrentStaffReportingSchool(value: unknown): CurrentStaffReportingSchool {
  const envelope = record(value, ['data']);
  const data = envelope.data;
  if (!data || typeof data !== 'object' || !('state' in data)) invalid();
  if (data.state === 'MANUAL_ENTRY_REQUIRED') {
    record(data, ['state']);
    return { state: 'MANUAL_ENTRY_REQUIRED' };
  }
  const row = record(data, ['state', 'organizationId', 'schoolId']);
  if (row.state !== 'RESOLVED' || typeof row.organizationId !== 'string' || typeof row.schoolId !== 'string'
    || !UUID.test(row.organizationId) || !UUID.test(row.schoolId)) invalid();
  return { state: 'RESOLVED', organizationId: row.organizationId.toLowerCase(), schoolId: row.schoolId.toLowerCase() };
}

/** No arguments, selectors, storage, or owner/family/HQ scope are accepted. */
export async function loadCurrentStaffReportingSchool(): Promise<CurrentStaffReportingSchool> {
  const response = await fetch(PATH, {
    method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const message = response.status === 401 ? 'Sign in with a verified human staff session to resolve the current reporting school.'
      : response.status === 403 ? 'Current staff reporting scope is not authorized. No school was selected.'
        : 'Current staff reporting scope is unavailable. No school was selected.';
    throw new StaffDashboardAccessError(message, response.status);
  }
  if (response.redirected || response.status !== 200
    || !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('Cache-Control') ?? '')
    || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')) invalid();
  if (response.url) {
    if (typeof location === 'undefined' || response.url !== new URL(PATH, location.origin).href) invalid();
  }
  let envelope: unknown;
  try { envelope = await response.json(); } catch { invalid(); }
  return verifyCurrentStaffReportingSchool(envelope);
}
