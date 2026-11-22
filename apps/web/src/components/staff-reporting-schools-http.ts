import { StaffDashboardAccessError } from './staff-dashboard-http';

const PATH = '/api/v1/staff/reporting-schools';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
export const MAX_STAFF_REPORTING_SCHOOLS = 20;
export type StaffReportingSchoolChoice = { organizationId: string; schoolId: string; organizationName: string; schoolName: string };
export type StaffReportingSchools = { state: 'SELECTION_REQUIRED'; schools: StaffReportingSchoolChoice[] }
  | { state: 'MANUAL_ENTRY_REQUIRED' };

function invalid(): never { throw new Error('The reporting school choices could not be verified. No school was selected.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))) invalid();
  return row;
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !value.length || Array.from(value).length > 120 || value.trim() !== value || UNSAFE_NAME.test(value)) invalid();
  return value;
}
export function verifyStaffReportingSchools(value: unknown): StaffReportingSchools {
  const envelope = record(value, ['data']);
  const data = envelope.data;
  if (!data || typeof data !== 'object' || !('state' in data)) invalid();
  if (data.state === 'MANUAL_ENTRY_REQUIRED') {
    record(data, ['state']);
    return { state: 'MANUAL_ENTRY_REQUIRED' };
  }
  const row = record(data, ['state', 'schools']);
  if (row.state !== 'SELECTION_REQUIRED' || !Array.isArray(row.schools)
    || row.schools.length < 2 || row.schools.length > MAX_STAFF_REPORTING_SCHOOLS) invalid();
  const seen = new Set<string>();
  const schools = row.schools.map((value) => {
    const school = record(value, ['organizationId', 'schoolId', 'organizationName', 'schoolName']);
    if (typeof school.organizationId !== 'string' || typeof school.schoolId !== 'string'
      || !UUID.test(school.organizationId) || !UUID.test(school.schoolId)) invalid();
    const schoolId = school.schoolId.toLowerCase();
    if (seen.has(schoolId)) invalid();
    seen.add(schoolId);
    return { organizationId: school.organizationId.toLowerCase(), schoolId,
      organizationName: name(school.organizationName), schoolName: name(school.schoolName) };
  });
  return { state: 'SELECTION_REQUIRED', schools };
}

/** No selector inputs or persistence. Choices never authorize a report. */
export async function loadStaffReportingSchools(): Promise<StaffReportingSchools> {
  const response = await fetch(PATH, {
    method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const message = response.status === 401 ? 'Sign in with a verified human staff session to view reporting school choices.'
      : response.status === 403 ? 'Staff reporting schools are not authorized. No school was selected.'
        : 'Staff reporting schools are unavailable. No school was selected.';
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
  return verifyStaffReportingSchools(envelope);
}
