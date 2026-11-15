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
