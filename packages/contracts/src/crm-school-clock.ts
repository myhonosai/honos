// B-CRM-3 (0236): the session school's IANA timezone and local date, for CRM time entry and display.
// GET /v1/organizations/:organizationId/schools/:schoolId/crm/school-clock (browser command header crm.school-clock).
// Commands are unchanged: CRM times are still sent as offset-qualified ISO 8601 instants.

export interface CrmSchoolClock {
  schoolId: string;
  /** IANA timezone name, e.g. America/Los_Angeles. */
  schoolTimezone: string;
  /** The school's local date at asOf, YYYY-MM-DD. */
  localToday: string;
  /** The read instant, UTC with milliseconds. */
  asOf: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IANA = /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]{0,40}(?:\/[A-Za-z0-9_+-]{1,40}){1,2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Strict closed verifier: exactly these keys, the expected school (case-insensitive), a real date and instant. */
export function verifyCrmSchoolClock(value: unknown, expectedSchoolId: string): CrmSchoolClock {
  const fail = (): never => { throw new Error('Unverified CRM school clock.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const r = value as Record<string, unknown>;
  if (Object.keys(r).sort().join(',') !== 'asOf,localToday,schoolId,schoolTimezone') fail();
  const { schoolId, schoolTimezone, localToday, asOf } = r;
  if (typeof schoolId !== 'string' || !UUID.test(schoolId) || schoolId.toLowerCase() !== expectedSchoolId.toLowerCase()) fail();
  if (typeof schoolTimezone !== 'string' || !IANA.test(schoolTimezone)) fail();
  if (typeof localToday !== 'string' || !DATE.test(localToday) || new Date(`${localToday}T00:00:00Z`).toISOString().slice(0, 10) !== localToday) fail();
  if (typeof asOf !== 'string' || !INSTANT.test(asOf) || Number.isNaN(Date.parse(asOf)) || new Date(asOf).toISOString() !== asOf) fail();
  return { schoolId: (schoolId as string).toLowerCase(), schoolTimezone: schoolTimezone as string, localToday: localToday as string, asOf: asOf as string };
}
