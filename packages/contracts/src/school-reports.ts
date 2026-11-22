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

/**
 * R3 (0520): the reports dashboard for one school. A range in school time, KPI counts with the previous equal range,
 * income per day / week / month, belts and open leads by stage now. Counts and money totals only; no people.
 */
export const SCHOOL_DASHBOARD_RANGES = ['THIS_MONTH', 'LAST_MONTH', 'D30', 'D90', 'M12', 'ALL'] as const;
export type SchoolDashboardRange = typeof SCHOOL_DASHBOARD_RANGES[number];
export const SCHOOL_DASHBOARD_RANGE_DEFAULT: SchoolDashboardRange = 'THIS_MONTH';
export interface SchoolDashboardQuery { range?: SchoolDashboardRange }
export interface SchoolDashboardIncome { currency: string; paymentsMinor: number; refundsMinor: number }
export interface SchoolDashboardKpis {
  activeStudents: number; newStudents: number; appointments: number; leadsWon: number; leadsLost: number; income: SchoolDashboardIncome[];
}
export type SchoolDashboardBucket = 'DAY' | 'WEEK' | 'MONTH';
export interface SchoolDashboardPoint { start: string; income: SchoolDashboardIncome[] }
export interface SchoolDashboardRank { curriculumId: string; curriculum: string; rankId: string; rank: string; color: string | null; order: number; students: number }
export interface SchoolDashboardStage { pipelineId: string; pipeline: string; stageId: string; stage: string; position: number; leads: number }
export interface SchoolDashboard {
  schoolId: string; schoolName: string; timezone: string; range: SchoolDashboardRange; generatedAt: string;
  /** null for ALL (every record up to now). */
  from: string | null; to: string;
  previous: { from: string; to: string; kpis: SchoolDashboardKpis } | null;
  kpis: SchoolDashboardKpis;
  series: { bucket: SchoolDashboardBucket; truncated: boolean; points: SchoolDashboardPoint[] };
  belts: { students: number; unranked: number; truncated: boolean; ranks: SchoolDashboardRank[] };
  pipeline: { open: number; stages: SchoolDashboardStage[] };
}

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const COLOR = /^#[0-9a-f]{3,8}$/i;

/** Query string to input: only ?range=<one of SCHOOL_DASHBOARD_RANGES> is accepted. */
export function validateSchoolDashboardQuery(value: unknown): SchoolDashboardQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('VALIDATION_FAILED');
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some(key => key !== 'range')) throw new Error('VALIDATION_FAILED');
  if (source.range === undefined) return {};
  if (typeof source.range !== 'string' || !(SCHOOL_DASHBOARD_RANGES as readonly string[]).includes(source.range)) throw new Error('VALIDATION_FAILED');
  return { range: source.range as SchoolDashboardRange };
}

function income(value: unknown): SchoolDashboardIncome[] {
  if (!Array.isArray(value) || value.length > 10) fail();
  const seen = new Set<string>();
  return value.map(line => {
    const v = exact(line, ['currency', 'paymentsMinor', 'refundsMinor']);
    const currency = text(v.currency, 3);
    if (!CURRENCY.test(currency) || seen.has(currency)) fail();
    seen.add(currency);
    return { currency, paymentsMinor: count(v.paymentsMinor), refundsMinor: count(v.refundsMinor) };
  });
}
function kpis(value: unknown): SchoolDashboardKpis {
  const k = exact(value, ['activeStudents', 'newStudents', 'appointments', 'leadsWon', 'leadsLost', 'income']);
  return { activeStudents: count(k.activeStudents), newStudents: count(k.newStudents), appointments: count(k.appointments),
    leadsWon: count(k.leadsWon), leadsLost: count(k.leadsLost), income: income(k.income) };
}
function uuid(value: unknown): string {
  const id = text(value, 36).toLowerCase();
  if (!UUID.test(id)) fail();
  return id;
}

export function verifySchoolDashboard(value: unknown, expectedSchoolId: string, query: SchoolDashboardQuery): SchoolDashboard {
  const source = exact(value, ['schoolId', 'schoolName', 'timezone', 'range', 'generatedAt', 'from', 'to', 'previous', 'kpis', 'series', 'belts', 'pipeline']);
  const schoolId = uuid(source.schoolId);
  if (schoolId !== expectedSchoolId.toLowerCase()) fail();
  const range = source.range;
  if (range !== (query.range ?? SCHOOL_DASHBOARD_RANGE_DEFAULT)) fail();
  const to = instant(source.to), from = source.from === null ? null : instant(source.from);
  if ((from === null) !== (range === 'ALL') || (from !== null && Date.parse(from) >= Date.parse(to))) fail();
  let previous: SchoolDashboard['previous'] = null;
  if (source.previous !== null) {
    const p = exact(source.previous, ['from', 'to', 'kpis']);
    previous = { from: instant(p.from), to: instant(p.to), kpis: kpis(p.kpis) };
    if (from === null || Date.parse(previous.from) >= Date.parse(previous.to) || Date.parse(previous.to) > Date.parse(from)) fail();
  } else if (range !== 'ALL') fail();
  const s = exact(source.series, ['bucket', 'truncated', 'points']);
  const bucket = s.bucket;
  const expectedBucket = range === 'D90' ? 'WEEK' : range === 'M12' || range === 'ALL' ? 'MONTH' : 'DAY';
  if (bucket !== expectedBucket || typeof s.truncated !== 'boolean' || (s.truncated && range !== 'ALL') || !Array.isArray(s.points) || s.points.length < 1 || s.points.length > 36) fail();
  let last = '';
  const points = s.points.map(item => {
    const pt = exact(item, ['start', 'income']);
    const start = text(pt.start, 10);
    if (!DAY.test(start) || start <= last || (bucket === 'MONTH' && !start.endsWith('-01'))) fail();
    last = start;
    return { start, income: income(pt.income) };
  });
  const b = exact(source.belts, ['students', 'unranked', 'truncated', 'ranks']);
  if (typeof b.truncated !== 'boolean' || !Array.isArray(b.ranks) || b.ranks.length > 100) fail();
  const students = count(b.students), unranked = count(b.unranked);
  if (unranked > students) fail();
  const ranks = b.ranks.map(item => {
    const r = exact(item, ['curriculumId', 'curriculum', 'rankId', 'rank', 'color', 'order', 'students']);
    const color = r.color === null ? null : text(r.color, 9);
    if (color !== null && !COLOR.test(color)) fail();
    const n = count(r.students);
    if (n < 1 || n > students) fail();
    return { curriculumId: uuid(r.curriculumId), curriculum: text(r.curriculum, 200), rankId: uuid(r.rankId), rank: text(r.rank, 200), color, order: count(r.order), students: n };
  });
  const pl = exact(source.pipeline, ['open', 'stages']);
  if (!Array.isArray(pl.stages) || pl.stages.length > 50) fail();
  const open = count(pl.open);
  const stages = pl.stages.map(item => {
    const x = exact(item, ['pipelineId', 'pipeline', 'stageId', 'stage', 'position', 'leads']);
    const leads = count(x.leads);
    if (leads < 1 || leads > open) fail();
    return { pipelineId: uuid(x.pipelineId), pipeline: text(x.pipeline, 200), stageId: uuid(x.stageId), stage: text(x.stage, 200), position: count(x.position), leads };
  });
  return { schoolId, schoolName: text(source.schoolName, 200), timezone: text(source.timezone, 64), range: range as SchoolDashboardRange,
    generatedAt: instant(source.generatedAt), from, to, previous, kpis: kpis(source.kpis),
    series: { bucket: bucket as SchoolDashboardBucket, truncated: s.truncated, points }, belts: { students, unranked, truncated: b.truncated, ranks }, pipeline: { open, stages } };
}

/** Won ÷ (won + lost) as a whole percent; null when no lead was closed. */
export function schoolDashboardWinRate(k: Pick<SchoolDashboardKpis, 'leadsWon' | 'leadsLost'>): number | null {
  const closed = k.leadsWon + k.leadsLost;
  return closed === 0 ? null : Math.round((100 * k.leadsWon) / closed);
}

/**
 * AR1 (0633): the attendance report for one school. One week of check-ins by class time, 7 and 30 day participation,
 * average check-ins per scheduled class, participation by program and each active student's last check-in.
 */
export interface AttendanceReportQuery { week?: string; month?: string }
export interface AttendanceReportSession { date: string; time: string; checkIns: number }
export interface AttendanceReportClass {
  /** 1 = Monday ... 7 = Sunday, in school time. */
  weekday: number; time: string; name: string; program: string; sessions: number; sessionsWithCheckIns: number; checkIns: number;
}
export interface AttendanceReportProgram { programId: string | null; name: string | null; activeStudents: number; attended30Days: number }
export interface AttendanceReportStudent {
  studentProfileId: string; personId: string; givenName: string; familyName: string; program: string | null; rank: string | null;
  lastCheckIn: string | null; attended7Days: boolean; attended30Days: boolean;
}
export interface AttendanceReport {
  schoolId: string; schoolName: string; timezone: string; generatedAt: string; localToday: string; savedCheckIns: number;
  participation: { activeStudents: number; attended7Days: number; attended30Days: number };
  week: { start: string; end: string; sessions: AttendanceReportSession[] };
  classes: { month: string; truncated: boolean; rows: AttendanceReportClass[] };
  programs: AttendanceReportProgram[];
  students: { truncated: boolean; items: AttendanceReportStudent[] };
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Query string to input: only ?week=YYYY-MM-DD (any day of the week wanted) and ?month=YYYY-MM|ALL are accepted. */
export function validateAttendanceReportQuery(value: unknown): AttendanceReportQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('VALIDATION_FAILED');
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some(key => key !== 'week' && key !== 'month')) throw new Error('VALIDATION_FAILED');
  const query: AttendanceReportQuery = {};
  if (source.week !== undefined) {
    if (typeof source.week !== 'string' || !DAY.test(source.week) || Number.isNaN(Date.parse(`${source.week}T00:00:00Z`))
      || new Date(`${source.week}T00:00:00Z`).toISOString().slice(0, 10) !== source.week) throw new Error('VALIDATION_FAILED');
    query.week = source.week;
  }
  if (source.month !== undefined) {
    if (typeof source.month !== 'string' || (source.month !== 'ALL' && !MONTH.test(source.month))) throw new Error('VALIDATION_FAILED');
    query.month = source.month;
  }
  return query;
}

function optionalText(value: unknown, max: number): string | null { return value === null ? null : text(value, max); }
function day(value: unknown): string { const d = text(value, 10); if (!DAY.test(d)) fail(); return d; }
/** A person's name part: may be empty, never unsafe or over 200 characters. */
function namePart(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200 || UNSAFE.test(value)) fail();
  return value;
}

export function verifyAttendanceReport(value: unknown, expectedSchoolId: string, query: AttendanceReportQuery): AttendanceReport {
  const source = exact(value, ['schoolId', 'schoolName', 'timezone', 'generatedAt', 'localToday', 'savedCheckIns', 'participation', 'week', 'classes', 'programs', 'students']);
  const schoolId = uuid(source.schoolId);
  if (schoolId !== expectedSchoolId.toLowerCase()) fail();
  const localToday = day(source.localToday);
  const p = exact(source.participation, ['activeStudents', 'attended7Days', 'attended30Days']);
  const participation = { activeStudents: count(p.activeStudents), attended7Days: count(p.attended7Days), attended30Days: count(p.attended30Days) };
  if (participation.attended7Days > participation.attended30Days || participation.attended30Days > participation.activeStudents) fail();

  const w = exact(source.week, ['start', 'end', 'sessions']);
  const start = day(w.start), end = day(w.end);
  const startAt = Date.parse(`${start}T00:00:00Z`);
  if (new Date(startAt).getUTCDay() !== 1 || Date.parse(`${end}T00:00:00Z`) - startAt !== 6 * 86400000 || start > localToday) fail();
  if (query.week !== undefined && (query.week < start || query.week > end)) fail();
  if (query.week === undefined && (localToday < start || localToday > end)) fail();
  if (!Array.isArray(w.sessions) || w.sessions.length > 500) fail();
  let last = '';
  const sessions = w.sessions.map(item => {
    const x = exact(item, ['date', 'time', 'checkIns']);
    const date = day(x.date), time = text(x.time, 5);
    if (!CLOCK.test(time) || date < start || date > end || `${date} ${time}` <= last) fail();
    last = `${date} ${time}`;
    return { date, time, checkIns: count(x.checkIns) };
  });

  const c = exact(source.classes, ['month', 'truncated', 'rows']);
  if (c.month !== (query.month ?? localToday.slice(0, 7)) || typeof c.truncated !== 'boolean' || !Array.isArray(c.rows) || c.rows.length > 300) fail();
  const rows = c.rows.map(item => {
    const x = exact(item, ['weekday', 'time', 'name', 'program', 'sessions', 'sessionsWithCheckIns', 'checkIns']);
    const weekday = count(x.weekday), time = text(x.time, 5), held = count(x.sessions), withCheckIns = count(x.sessionsWithCheckIns), checkIns = count(x.checkIns);
    if (weekday < 1 || weekday > 7 || !CLOCK.test(time) || held < 1 || withCheckIns > held || (withCheckIns === 0) !== (checkIns === 0) || checkIns < withCheckIns) fail();
    return { weekday, time, name: text(x.name, 200), program: text(x.program, 200), sessions: held, sessionsWithCheckIns: withCheckIns, checkIns };
  });

  if (!Array.isArray(source.programs) || source.programs.length > 500) fail();
  let programStudents = 0, programAttended = 0;
  const seenPrograms = new Set<string>();
  const programs = source.programs.map(item => {
    const x = exact(item, ['programId', 'name', 'activeStudents', 'attended30Days']);
    const programId = x.programId === null ? null : uuid(x.programId);
    const active = count(x.activeStudents), attended = count(x.attended30Days);
    if (active < 1 || attended > active || seenPrograms.has(programId ?? '')) fail();
    seenPrograms.add(programId ?? '');
    programStudents += active; programAttended += attended;
    return { programId, name: optionalText(x.name, 200), activeStudents: active, attended30Days: attended };
  });
  if (programStudents !== participation.activeStudents || programAttended !== participation.attended30Days) fail();

  const st = exact(source.students, ['truncated', 'items']);
  if (typeof st.truncated !== 'boolean' || !Array.isArray(st.items) || st.items.length > 2000
    || st.truncated !== (participation.activeStudents > 2000) || (!st.truncated && st.items.length !== participation.activeStudents)) fail();
  const seenStudents = new Set<string>();
  const items = st.items.map(item => {
    const x = exact(item, ['studentProfileId', 'personId', 'givenName', 'familyName', 'program', 'rank', 'lastCheckIn', 'attended7Days', 'attended30Days']);
    const studentProfileId = uuid(x.studentProfileId);
    const lastCheckIn = x.lastCheckIn === null ? null : day(x.lastCheckIn);
    if (seenStudents.has(studentProfileId) || typeof x.attended7Days !== 'boolean' || typeof x.attended30Days !== 'boolean'
      || (x.attended7Days && !x.attended30Days) || (x.attended30Days && lastCheckIn === null) || (lastCheckIn !== null && lastCheckIn > localToday)) fail();
    seenStudents.add(studentProfileId);
    return { studentProfileId, personId: uuid(x.personId), givenName: namePart(x.givenName), familyName: namePart(x.familyName),
      program: optionalText(x.program, 200), rank: optionalText(x.rank, 200), lastCheckIn, attended7Days: x.attended7Days as boolean, attended30Days: x.attended30Days as boolean };
  });

  return { schoolId, schoolName: text(source.schoolName, 200), timezone: text(source.timezone, 64), generatedAt: instant(source.generatedAt), localToday,
    savedCheckIns: count(source.savedCheckIns), participation, week: { start, end, sessions }, classes: { month: c.month as string, truncated: c.truncated, rows },
    programs, students: { truncated: st.truncated, items } };
}

/** Whole percent of a over b; null when b is 0. */
export function attendanceReportPercent(a: number, b: number): number | null { return b === 0 ? null : Math.round((100 * a) / b); }
