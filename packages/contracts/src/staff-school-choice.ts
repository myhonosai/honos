/**
 * Which school a signed-in staff member works at: the two fixed staff reads `GET /v1/staff/current-reporting-school`
 * and `GET /v1/staff/reporting-schools`. Shared by the web app and the HON Staff app (S0b). Navigation hints only:
 * a choice never authorizes anything; every school route re-checks the staff member's role itself.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
export const MAX_STAFF_REPORTING_SCHOOLS = 20;
export type StaffReportingSchoolChoice = { organizationId: string; schoolId: string; organizationName: string; schoolName: string };
export type StaffReportingSchools = { state: 'SELECTION_REQUIRED'; schools: StaffReportingSchoolChoice[] }
  | { state: 'MANUAL_ENTRY_REQUIRED' };

function invalidChoices(): never { throw new Error('The reporting school choices could not be verified. No school was selected.'); }
function choiceRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidChoices();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))) invalidChoices();
  return row;
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !value.length || Array.from(value).length > 120 || value.trim() !== value || UNSAFE_NAME.test(value)) invalidChoices();
  return value;
}
export function verifyStaffReportingSchools(value: unknown): StaffReportingSchools {
  const envelope = choiceRecord(value, ['data']);
  const data = envelope.data;
  if (!data || typeof data !== 'object' || !('state' in data)) invalidChoices();
  if (data.state === 'MANUAL_ENTRY_REQUIRED') {
    choiceRecord(data, ['state']);
    return { state: 'MANUAL_ENTRY_REQUIRED' };
  }
  const row = choiceRecord(data, ['state', 'schools']);
  if (row.state !== 'SELECTION_REQUIRED' || !Array.isArray(row.schools)
    || row.schools.length < 2 || row.schools.length > MAX_STAFF_REPORTING_SCHOOLS) invalidChoices();
  const seen = new Set<string>();
  const schools = row.schools.map((value) => {
    const school = choiceRecord(value, ['organizationId', 'schoolId', 'organizationName', 'schoolName']);
    if (typeof school.organizationId !== 'string' || typeof school.schoolId !== 'string'
      || !UUID.test(school.organizationId) || !UUID.test(school.schoolId)) invalidChoices();
    const schoolId = school.schoolId.toLowerCase();
    if (seen.has(schoolId)) invalidChoices();
    seen.add(schoolId);
    return { organizationId: school.organizationId.toLowerCase(), schoolId,
      organizationName: name(school.organizationName), schoolName: name(school.schoolName) };
  });
  return { state: 'SELECTION_REQUIRED', schools };
}

export type CurrentStaffReportingSchool = { state: 'RESOLVED'; organizationId: string; schoolId: string }
  | { state: 'MANUAL_ENTRY_REQUIRED' };

function invalidCurrent(): never { throw new Error('The current reporting school response could not be verified. No school was selected.'); }
function currentRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidCurrent();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))) invalidCurrent();
  return row;
}

export function verifyCurrentStaffReportingSchool(value: unknown): CurrentStaffReportingSchool {
  const envelope = currentRecord(value, ['data']);
  const data = envelope.data;
  if (!data || typeof data !== 'object' || !('state' in data)) invalidCurrent();
  if (data.state === 'MANUAL_ENTRY_REQUIRED') {
    currentRecord(data, ['state']);
    return { state: 'MANUAL_ENTRY_REQUIRED' };
  }
  const row = currentRecord(data, ['state', 'organizationId', 'schoolId']);
  if (row.state !== 'RESOLVED' || typeof row.organizationId !== 'string' || typeof row.schoolId !== 'string'
    || !UUID.test(row.organizationId) || !UUID.test(row.schoolId)) invalidCurrent();
  return { state: 'RESOLVED', organizationId: row.organizationId.toLowerCase(), schoolId: row.schoolId.toLowerCase() };
}
