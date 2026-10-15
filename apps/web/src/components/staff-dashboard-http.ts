import type { OperationalSnapshot } from '@hon/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ATTENDANCE = ['PRESENT', 'LATE', 'EXCUSED_ABSENCE', 'UNEXCUSED_ABSENCE', 'MAKEUP'] as const;
const LEADS = ['OPEN', 'WON', 'LOST', 'ARCHIVED'] as const;
const MEMBERSHIPS = ['DRAFT', 'ACTIVE', 'FROZEN', 'CANCELLATION_PENDING', 'CANCELLED', 'EXPIRED'] as const;
const INVOICES = ['DRAFT', 'ISSUED', 'PAID', 'VOID', 'UNCOLLECTIBLE'] as const;
const PAYMENTS = ['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'REQUIRES_ACTION', 'UNKNOWN', 'REFUNDED'] as const;

export class StaffDashboardAccessError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function invalid(): never { throw new Error('Dashboard data was not a verified aggregate-only operations report.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))) invalid();
  return row;
}
function text(value: unknown): string { if (typeof value !== 'string' || !value) invalid(); return value; }
function count(value: unknown): number { if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) invalid(); return value; }
function timestamp(value: unknown): string {
  const raw = text(value); const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) invalid();
  return parsed.toISOString();
}
function scopedId(value: unknown, expected: string): string {
  const id = text(value).toLowerCase();
  if (!UUID.test(id) || id !== expected) invalid();
  return id;
}
function counts<const T extends readonly string[]>(value: unknown, values: T): Record<T[number], number> {
  const row = record(value, values);
  return Object.fromEntries(values.map((key) => [key, count(row[key])])) as Record<T[number], number>;
}

/** Fixed same-origin route only; typed input is a selector and never authority. */
export function staffDashboardReportPath(organizationId: string, schoolId: string): string {
  const organization = organizationId.trim().toLowerCase();
  const school = schoolId.trim().toLowerCase();
  if (!UUID.test(organization) || !UUID.test(school)) throw new Error('Enter the exact organization and school UUIDs from your staff context.');
  return `/api/v1/organizations/${organization}/schools/${school}/reports/operations`;
}

/**
 * Strict browser boundary for the existing read-only operational snapshot.
 * This rebuilds the approved DTO instead of forwarding a server object, so no
 * person/contact, note, payment-method, provider, or row-level field can enter
 * the dashboard when an upstream response is malformed.
 */
export function verifyStaffDashboardSnapshot(value: unknown, organizationId: string, schoolId: string): OperationalSnapshot {
  const organization = organizationId.trim().toLowerCase(); const school = schoolId.trim().toLowerCase();
  const row = record(value, ['organizationId', 'schoolId', 'generatedAt', 'from', 'to', 'studentProfiles', 'leads', 'classSessions', 'attendance', 'memberships', 'invoices', 'paymentAttempts']);
  const from = timestamp(row.from); const to = timestamp(row.to);
  if (Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > 92 * 24 * 60 * 60 * 1000) invalid();
  const studentProfiles = record(row.studentProfiles, ['total']);
  const leads = record(row.leads, ['byStatus']);
  const sessions = record(row.classSessions, ['inRange']);
  const sessionCounts = record(sessions.inRange, ['scheduled', 'completed', 'cancelled']);
  const attendance = record(row.attendance, ['inRangeByStatus']);
  const memberships = record(row.memberships, ['byState']);
  const invoices = record(row.invoices, ['inRangeByStatus']);
  const paymentAttempts = record(row.paymentAttempts, ['inRangeByState']);
  return {
    organizationId: scopedId(row.organizationId, organization),
    schoolId: scopedId(row.schoolId, school),
    generatedAt: timestamp(row.generatedAt),
    from,
    to,
    studentProfiles: { total: count(studentProfiles.total) },
    leads: { byStatus: counts(leads.byStatus, LEADS) },
    classSessions: { inRange: { scheduled: count(sessionCounts.scheduled), completed: count(sessionCounts.completed), cancelled: count(sessionCounts.cancelled) } },
    attendance: { inRangeByStatus: counts(attendance.inRangeByStatus, ATTENDANCE) },
    memberships: { byState: counts(memberships.byState, MEMBERSHIPS) },
    invoices: { inRangeByStatus: counts(invoices.inRangeByStatus, INVOICES) },
    paymentAttempts: { inRangeByState: counts(paymentAttempts.inRangeByState, PAYMENTS) },
  };
}

export async function loadStaffDashboard(organizationId: string, schoolId: string): Promise<OperationalSnapshot> {
  const response = await fetch(staffDashboardReportPath(organizationId, schoolId), {
    method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const message = response.status === 401 ? 'Sign in with a verified human staff session, then load the school dashboard.'
      : response.status === 403 ? 'Operations reporting is not authorized for this current school. Dashboard content was cleared.'
        : response.status === 404 ? 'This school report is no longer available. Dashboard content was cleared.'
          : 'The operations report is unavailable. No operational result is shown.';
    throw new (response.status === 401 || response.status === 403 ? StaffDashboardAccessError : Error)(message, response.status);
  }
  let envelope: unknown;
  try { envelope = await response.json(); } catch { throw new Error('The operations report response could not be verified.'); }
  const root = record(envelope, ['data', 'meta']);
  const data = record(root.data, ['operationalSnapshot']);
  return verifyStaffDashboardSnapshot(data.operationalSnapshot, organizationId, schoolId);
}
