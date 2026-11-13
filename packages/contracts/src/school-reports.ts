/**
 * R1 (0331): standard school reports. Month by month totals for one school in the school's own time zone: attendance,
 * enrollment, retention and revenue. Counts and money totals only; no names, people, invoices or payment rows.
 * Revenue figures are operational totals from HON records, not accounting or provider-settled figures.
 */
export const SCHOOL_REPORT_MONTHS_MIN = 3;
export const SCHOOL_REPORT_MONTHS_MAX = 12;
export const SCHOOL_REPORT_MONTHS_DEFAULT = 6;

export interface SchoolReportsQuery { months?: number }
export interface SchoolReportAttendance { classesHeld: number; checkIns: number; absences: number; studentsAttended: number }
export interface SchoolReportEnrollment { newLeads: number; leadsWon: number; newMemberships: number }
export interface SchoolReportRetention { activeAtStart: number; activeAtEnd: number; ended: number; retainedFromStart: number }
export interface SchoolReportRevenue { currency: string; billedMinor: number; recordedPaymentsMinor: number; onlinePaymentsMinor: number; refundsMinor: number }
export interface SchoolReportPeriod {
  month: string; from: string; to: string; partial: boolean;
  attendance: SchoolReportAttendance; enrollment: SchoolReportEnrollment; retention: SchoolReportRetention; revenue: SchoolReportRevenue[];
}
export interface SchoolReports {
  schoolId: string; schoolName: string; timezone: string; months: number; generatedAt: string;
  /** Cancelled memberships with no recorded cancellation time: left out of retention and counted here once. */
  cancelledWithoutDate: number;
  periods: SchoolReportPeriod[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const CURRENCY = /^[A-Z]{3}$/;
const UNSAFE = /[\x00-\x1f\x7f-\x9f​-‏‪-‮⁠-⁯﻿]/;

function fail(): never { throw new Error('Unverified school reports.'); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== keys.length || keys.some(key => !Object.hasOwn(source, key))) fail();
  return source;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail();
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value || value.length > max || value.trim() !== value || UNSAFE.test(value)) fail();
  return value;
}
function instant(value: unknown): string {
  const source = text(value, 30);
  if (!UTC.test(source) || new Date(source).toISOString() !== source) fail();
  return source;
}
function nextMonth(month: string): string {
  const [year, value] = month.split('-').map(Number) as [number, number];
  return value === 12 ? `${year + 1}-01` : `${year}-${String(value + 1).padStart(2, '0')}`;
}

/** Query string to input: only ?months=3..12 is accepted. */
export function validateSchoolReportsQuery(value: unknown): SchoolReportsQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('VALIDATION_FAILED');
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.some(key => key !== 'months')) throw new Error('VALIDATION_FAILED');
  if (source.months === undefined) return {};
  const raw = source.months;
  const months = typeof raw === 'string' && /^(3|4|5|6|7|8|9|10|11|12)$/.test(raw) ? Number(raw)
    : typeof raw === 'number' && Number.isInteger(raw) ? raw : NaN;
  if (!(months >= SCHOOL_REPORT_MONTHS_MIN && months <= SCHOOL_REPORT_MONTHS_MAX)) throw new Error('VALIDATION_FAILED');
  return { months };
}

export function verifySchoolReportPeriods(value: unknown, months: number): SchoolReportPeriod[] {
  if (!Array.isArray(value) || value.length !== months) fail();
  let previous: string | null = null;
  return value.map((item, index) => {
    const source = exact(item, ['month', 'from', 'to', 'partial', 'attendance', 'enrollment', 'retention', 'revenue']);
    const month = text(source.month, 7);
    if (!MONTH.test(month) || (previous !== null && month !== nextMonth(previous))) fail();
    previous = month;
    const from = instant(source.from), to = instant(source.to);
    if (Date.parse(to) <= Date.parse(from) || typeof source.partial !== 'boolean' || (source.partial && index !== months - 1)) fail();
    const a = exact(source.attendance, ['classesHeld', 'checkIns', 'absences', 'studentsAttended']);
    const attendance = { classesHeld: count(a.classesHeld), checkIns: count(a.checkIns), absences: count(a.absences), studentsAttended: count(a.studentsAttended) };
    if (attendance.studentsAttended > attendance.checkIns) fail();
    const e = exact(source.enrollment, ['newLeads', 'leadsWon', 'newMemberships']);
    const enrollment = { newLeads: count(e.newLeads), leadsWon: count(e.leadsWon), newMemberships: count(e.newMemberships) };
    const r = exact(source.retention, ['activeAtStart', 'activeAtEnd', 'ended', 'retainedFromStart']);
    const retention = { activeAtStart: count(r.activeAtStart), activeAtEnd: count(r.activeAtEnd), ended: count(r.ended), retainedFromStart: count(r.retainedFromStart) };
    if (retention.retainedFromStart > retention.activeAtStart || retention.retainedFromStart > retention.activeAtEnd) fail();
    if (!Array.isArray(source.revenue) || source.revenue.length > 10) fail();
    const seen = new Set<string>();
    const revenue = source.revenue.map(line => {
      const v = exact(line, ['currency', 'billedMinor', 'recordedPaymentsMinor', 'onlinePaymentsMinor', 'refundsMinor']);
      const currency = text(v.currency, 3);
      if (!CURRENCY.test(currency) || seen.has(currency)) fail();
      seen.add(currency);
      return { currency, billedMinor: count(v.billedMinor), recordedPaymentsMinor: count(v.recordedPaymentsMinor),
        onlinePaymentsMinor: count(v.onlinePaymentsMinor), refundsMinor: count(v.refundsMinor) };
    });
    return { month, from, to, partial: source.partial, attendance, enrollment, retention, revenue };
  });
}

export function verifySchoolReports(value: unknown, expectedSchoolId: string, query: SchoolReportsQuery): SchoolReports {
  const source = exact(value, ['schoolId', 'schoolName', 'timezone', 'months', 'generatedAt', 'cancelledWithoutDate', 'periods']);
  const schoolId = text(source.schoolId, 36).toLowerCase();
  if (!UUID.test(schoolId) || schoolId !== expectedSchoolId.toLowerCase()) fail();
  const months = count(source.months);
  if (months !== (query.months ?? SCHOOL_REPORT_MONTHS_DEFAULT)) fail();
  return { schoolId, schoolName: text(source.schoolName, 200), timezone: text(source.timezone, 64), months, generatedAt: instant(source.generatedAt),
    cancelledWithoutDate: count(source.cancelledWithoutDate), periods: verifySchoolReportPeriods(source.periods, months) };
}

/** Members at the start who were still members at the end, as a whole percent; null when nobody was a member at the start. */
export function schoolReportRetainedPercent(retention: SchoolReportRetention): number | null {
  return retention.activeAtStart === 0 ? null : Math.round((100 * retention.retainedFromStart) / retention.activeAtStart);
}

/** R2 (0332): the same month by month totals for each location of the organization where the reader may see reports. */
export const SCHOOL_REPORT_LOCATIONS_MAX = 20;
export interface SchoolReportLocation { schoolId: string; schoolName: string; timezone: string; cancelledWithoutDate: number; periods: SchoolReportPeriod[] }
export interface SchoolReportLocations { organizationId: string; months: number; generatedAt: string; locations: SchoolReportLocation[] }
export interface SchoolReportTotals {
  month: string; partial: boolean; attendance: SchoolReportAttendance; enrollment: SchoolReportEnrollment; retention: SchoolReportRetention;
  revenue: SchoolReportRevenue[];
}

export function verifySchoolReportLocations(value: unknown, expectedOrganizationId: string, expectedSchoolId: string, query: SchoolReportsQuery): SchoolReportLocations {
  const source = exact(value, ['organizationId', 'months', 'generatedAt', 'locations']);
  const organizationId = text(source.organizationId, 36).toLowerCase();
  if (!UUID.test(organizationId) || organizationId !== expectedOrganizationId.toLowerCase()) fail();
  const months = count(source.months);
  if (months !== (query.months ?? SCHOOL_REPORT_MONTHS_DEFAULT)) fail();
  if (!Array.isArray(source.locations) || source.locations.length < 1 || source.locations.length > SCHOOL_REPORT_LOCATIONS_MAX) fail();
  const seen = new Set<string>();
  const locations = source.locations.map(item => {
    const l = exact(item, ['schoolId', 'schoolName', 'timezone', 'cancelledWithoutDate', 'periods']);
    const schoolId = text(l.schoolId, 36).toLowerCase();
    if (!UUID.test(schoolId) || seen.has(schoolId)) fail();
    seen.add(schoolId);
    return { schoolId, schoolName: text(l.schoolName, 200), timezone: text(l.timezone, 64), cancelledWithoutDate: count(l.cancelledWithoutDate),
      periods: verifySchoolReportPeriods(l.periods, months) };
  });
  // The school the reader is working in is always one of the locations (the server checked it first).
  if (!seen.has(expectedSchoolId.toLowerCase())) fail();
  return { organizationId, months, generatedAt: instant(source.generatedAt), locations };
}

/** Organization totals per month label (each location's months follow its own school time). */
export function sumSchoolReportLocations(locations: readonly SchoolReportLocation[]): SchoolReportTotals[] {
  const byMonth = new Map<string, SchoolReportTotals>();
  for (const location of locations) for (const p of location.periods) {
    const t = byMonth.get(p.month) ?? { month: p.month, partial: false, attendance: { classesHeld: 0, checkIns: 0, absences: 0, studentsAttended: 0 },
      enrollment: { newLeads: 0, leadsWon: 0, newMemberships: 0 }, retention: { activeAtStart: 0, activeAtEnd: 0, ended: 0, retainedFromStart: 0 }, revenue: [] };
    t.partial = t.partial || p.partial;
    for (const k of ['classesHeld', 'checkIns', 'absences', 'studentsAttended'] as const) t.attendance[k] += p.attendance[k];
    for (const k of ['newLeads', 'leadsWon', 'newMemberships'] as const) t.enrollment[k] += p.enrollment[k];
    for (const k of ['activeAtStart', 'activeAtEnd', 'ended', 'retainedFromStart'] as const) t.retention[k] += p.retention[k];
    for (const line of p.revenue) {
      const r = t.revenue.find(x => x.currency === line.currency);
      if (!r) t.revenue.push({ ...line });
      else { r.billedMinor += line.billedMinor; r.recordedPaymentsMinor += line.recordedPaymentsMinor; r.onlinePaymentsMinor += line.onlinePaymentsMinor; r.refundsMinor += line.refundsMinor; }
    }
    byMonth.set(p.month, t);
  }
  for (const t of byMonth.values()) t.revenue.sort((a, b) => a.currency.localeCompare(b.currency));
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}
