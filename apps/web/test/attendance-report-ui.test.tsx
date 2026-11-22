import React from 'react';
import { existsSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { attendanceReportPercent, validateAttendanceReportQuery, verifyAttendanceReport } from '@hon/contracts';
import { ReportsError, schoolReportsApi } from '../src/components/school-reports/http';
import { AttendanceReportView, daysBetween, missingStudents, monthChoices, shiftDay, timeLabel, weekChart } from '../src/components/attendance-report/view';
import { ATTENDANCE_REPORT_COPY } from '../src/components/attendance-report/copy';
import { SCHOOL_SHELL_NAV } from '../src/components/school-shell/catalog';
import { id } from './account-status-fixtures';

// AR1 (0633): the attendance report, read with one same-origin GET and drawn from that verified read only.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), meta = { requestId: id(5), correlationId: id(5) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const student = (n: number, given: string, lastCheckIn: string | null, a7: boolean, a30: boolean, program: string | null = 'Kids', rank: string | null = 'White') =>
  ({ studentProfileId: id(100 + n), personId: id(200 + n), givenName: given, familyName: 'Synthetic', program, rank, lastCheckIn, attended7Days: a7, attended30Days: a30 });
// Today is Saturday 2026-11-21 in school time; the week is Monday 16 to Sunday 22.
const raw = (over: Record<string, unknown> = {}) => ({ schoolId: school, schoolName: 'Synthetic Dojo', timezone: 'America/Los_Angeles',
  generatedAt: '2026-11-22T04:00:00.000Z', localToday: '2026-11-21', savedCheckIns: 2956,
  participation: { activeStudents: 4, attended7Days: 1, attended30Days: 2 },
  week: { start: '2026-11-16', end: '2026-11-22', sessions: [
    { date: '2026-11-16', time: '15:30', checkIns: 10 }, { date: '2026-11-16', time: '18:30', checkIns: 14 },
    { date: '2026-11-17', time: '15:30', checkIns: 13 }, { date: '2026-11-17', time: '18:30', checkIns: 30 }, { date: '2026-11-18', time: '18:30', checkIns: 0 }] },
  classes: { month: '2026-11', truncated: false, rows: [
    { weekday: 1, time: '15:30', name: 'Tiny Tigers', program: 'Kids', sessions: 3, sessionsWithCheckIns: 2, checkIns: 21 },
    { weekday: 2, time: '18:30', name: 'All belts', program: 'Kids', sessions: 2, sessionsWithCheckIns: 0, checkIns: 0 }] },
  programs: [{ programId: id(30), name: 'Kids', activeStudents: 3, attended30Days: 2 }, { programId: null, name: null, activeStudents: 1, attended30Days: 0 }],
  students: { truncated: false, items: [student(1, 'Never', null, false, false, null, null), student(2, 'Longgone', '2026-10-12', false, false),
    student(3, 'Tenago', '2026-11-11', false, true), student(4, 'Recent', '2026-11-20', true, true)] }, ...over });
const read = (over: Record<string, unknown> = {}) => verifyAttendanceReport(raw(over), school, {});
const view = (props: Partial<React.ComponentProps<typeof AttendanceReportView>> = {}, over: Record<string, unknown> = {}) => renderToStaticMarkup(
  <AttendanceReportView language="en" waiting={false} concealed={false} hasSchool report={{ state: 'READY', read: read(over) }} month="2026-11" filter="MISSING" search="" {...props}/>);

it('reads as a plain same-origin GET with ?week and ?month and verifies the answer', async () => {
  const f = stub(json({ data: raw({ classes: { month: 'ALL', truncated: false, rows: [] } }), meta }));
  const result = await schoolReportsApi.attendance({ organizationId: org, schoolId: school }, { week: '2026-11-18', month: 'ALL' }, new AbortController().signal, () => true);
  expect(result.participation.activeStudents).toBe(4);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/reports/attendance?week=2026-11-18&month=ALL`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  const plain = stub(json({ data: raw(), meta }));
  await schoolReportsApi.attendance({ organizationId: org, schoolId: school }, {}, new AbortController().signal, () => true);
  expect((plain.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/reports/attendance`);
  stub(json({ data: raw({ schoolId: id(9) }), meta }));
  await expect(schoolReportsApi.attendance({ organizationId: org, schoolId: school }, {}, new AbortController().signal, () => true)).rejects.toBeInstanceOf(ReportsError);
  stub(json({ code: 'SCHOOL_REPORTS_FORBIDDEN' }, 403));
  await expect(schoolReportsApi.attendance({ organizationId: org, schoolId: school }, {}, new AbortController().signal, () => true)).rejects.toMatchObject({ kind: 'DENIED' });
  const untouched = stub(json({ data: raw(), meta }));
  await expect(schoolReportsApi.attendance({ organizationId: org, schoolId: school }, { week: '2026-02-30' }, new AbortController().signal, () => true)).rejects.toBeInstanceOf(ReportsError);
  expect(untouched).not.toHaveBeenCalled();
});

it('the contract closes the query and refuses numbers that do not add up', () => {
  expect(validateAttendanceReportQuery({ week: '2026-11-18', month: '2026-10' })).toEqual({ week: '2026-11-18', month: '2026-10' });
  for (const bad of [{ week: '2026-02-30' }, { week: '11/18/2026' }, { month: 'all' }, { month: '2026-13' }, { range: 'D30' }, { week: 1 }, null, []]) expect(() => validateAttendanceReportQuery(bad)).toThrow();
  expect(() => verifyAttendanceReport(raw(), school, { week: '2026-11-10' })).toThrow();
  expect(() => verifyAttendanceReport(raw(), school, { month: 'ALL' })).toThrow();
  expect(() => verifyAttendanceReport(raw({ participation: { activeStudents: 4, attended7Days: 3, attended30Days: 2 } }), school, {})).toThrow();
  expect(() => verifyAttendanceReport(raw({ programs: [{ programId: id(30), name: 'Kids', activeStudents: 3, attended30Days: 2 }] }), school, {})).toThrow();
  expect(() => verifyAttendanceReport(raw({ week: { start: '2026-11-17', end: '2026-11-23', sessions: [] } }), school, {})).toThrow();
  expect(() => verifyAttendanceReport(raw({ students: { truncated: false, items: [] } }), school, {})).toThrow();
  expect(() => verifyAttendanceReport(raw({ students: { truncated: false, items: [student(1, 'A', '2026-11-22', true, true), student(2, 'B', null, false, false), student(3, 'C', null, false, false), student(4, 'D', null, false, false)] } }), school, {})).toThrow();
  expect(() => verifyAttendanceReport(raw({ extra: 1 }), school, {})).toThrow();
  expect(attendanceReportPercent(147, 202)).toBe(73); expect(attendanceReportPercent(0, 0)).toBeNull();
});

it('lays the week out by class time, with the busiest time and day', () => {
  const chart = weekChart(read().week);
  expect(chart.series).toEqual(['15:30', '18:30']);
  expect(chart.days.map((d) => d.total)).toEqual([24, 43, 0, 0, 0, 0, 0]);
  expect(chart.days.map((d) => d.held)).toEqual([true, true, true, false, false, false, false]);
  expect(chart.max).toBe(30); expect(chart.busiestTime).toEqual({ time: '18:30', checkIns: 44 }); expect(chart.busiestDay).toEqual({ date: '2026-11-17', checkIns: 43 });
  // Ten class times: the seven busiest keep their own colour in clock order, the rest fold into one "other" series.
  const many = weekChart({ start: '2026-11-16', end: '2026-11-22', sessions: Array.from({ length: 10 }, (_, i) => ({ date: '2026-11-16', time: `${String(9 + i).padStart(2, '0')}:00`, checkIns: i + 1 })) });
  expect(many.series).toEqual(['12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', 'OTHER']);
  expect(many.days[0]?.values.at(-1)).toBe(1 + 2 + 3); expect(many.total).toBe(55);
  expect(shiftDay('2026-11-16', -7)).toBe('2026-11-09'); expect(daysBetween('2026-10-12', '2026-11-21')).toBe(40);
  expect(timeLabel('en', '18:30')).toBe('6:30 PM'); expect(monthChoices('2026-01-15').slice(0, 2)).toEqual(['2026-01', '2025-12']);
});

it('shows participation, the week, class averages, programs and the students missing two weeks or more', () => {
  const page = view({ contactsHref: '/staff/people' });
  expect(page).toContain('25%'); expect(page).toContain('50%'); expect(page).toContain('1 of 4 active students attended'); expect(page).toContain('2,956');
  expect(page).toContain('View 3 missing'); expect(page).toContain('View 2 missing');
  expect(page).toContain('This week · Nov 16 – Nov 22, 2026'); expect(page).toContain('6:30 PM'); expect(page).toContain('44 check-ins this week'); expect(page).toContain('Tuesday');
  expect(page).toContain('Monday · 3:30 PM: 10 check-ins');
  expect(page).toContain('Avg 10.5'); expect(page).toContain('2 classes held'); expect(page).toContain('No check-ins recorded');
  expect(page).toContain('67% (2/3)'); expect(page).toContain('No program'); expect(page).toContain('0% (0/1)');
  expect(missingStudents(read()).map((s) => s.givenName)).toEqual(['Never', 'Longgone']);
  expect(page).toContain('2 students need attention'); expect(page).toContain('1 absent 14+ days'); expect(page).toContain('1 no check-in recorded');
  expect(page).toContain('Never Synthetic'); expect(page).toContain('40 days absent'); expect(page).not.toContain('Tenago'); expect(page).not.toContain('Recent Synthetic');
  expect(page).toContain('href="/staff/people"'); expect(page).not.toContain('Import past attendance');
  expect(view({ importHref: '/staff/migration/classes' })).toContain('href="/staff/migration/classes"');
  const all = view({ filter: 'ALL' });
  expect(all).toContain('Tenago Synthetic'); expect(all).toContain('Attended 10 days ago'); expect(all).toContain('Attended yesterday');
  expect(view({ filter: 'ALL', search: 'tena' })).not.toContain('Recent Synthetic');
  expect(view({ search: 'zzz' })).toContain('No student matches that name.');
  // The next-week arrow is off in the current week; no student id is printed anywhere.
  expect(page).toMatch(/aria-label="Next week" disabled=""/); expect(page).not.toContain(id(101)); expect(page).not.toContain(id(201));
});

it('says so plainly when there is nothing to show or the read is refused', () => {
  const empty = view({}, { savedCheckIns: 0, participation: { activeStudents: 0, attended7Days: 0, attended30Days: 0 }, week: { start: '2026-11-16', end: '2026-11-22', sessions: [] },
    classes: { month: '2026-11', truncated: false, rows: [] }, programs: [], students: { truncated: false, items: [] } });
  for (const text of ['No classes this week.', 'No classes were held in this period.', 'No active students yet', '—']) expect(empty).toContain(text);
  const state = (s: 'LOADING' | 'DENIED' | 'TIMEZONE' | 'UNAVAILABLE') => renderToStaticMarkup(<AttendanceReportView language="en" waiting={false} concealed={false} hasSchool report={{ state: s }} month="ALL" filter="MISSING" search=""/>);
  expect(state('DENIED')).toContain('reporting permission'); expect(state('UNAVAILABLE')).toContain('not available right now'); expect(state('LOADING')).toContain('Reading');
  expect(renderToStaticMarkup(<AttendanceReportView language="en" waiting={false} concealed hasSchool report={{ state: 'READY', read: read() }} month="ALL" filter="ALL" search=""/>)).not.toContain('Synthetic');
  expect(view({ language: 'ko' } as never)).toContain('출석 리포트'); expect(view({ language: 'es' } as never)).toContain('Informe de asistencia');
});

it('is a page under Attendance in the school menu, in three languages, behind a verified session', () => {
  const attendance = SCHOOL_SHELL_NAV.find((item) => item.key === 'attendance');
  expect(attendance?.routes.map((route) => route.href).slice(0, 2)).toEqual(['/staff/attendance', '/staff/attendance/report']);
  const route = readFileSync('src/app/staff/attendance/report/page.tsx', 'utf8');
  for (const token of ['requireVerifiedWebSession', 'force-dynamic', 'no-referrer', 'index: false']) expect(route).toContain(token);
  expect(existsSync('src/components/attendance-report/report.tsx')).toBe(true);
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string }[] };
  expect(manifest.routes.filter((item) => item.path === '/staff/attendance/report')).toHaveLength(1);
  const keys = Object.keys(ATTENDANCE_REPORT_COPY.en).sort();
  expect(Object.keys(ATTENDANCE_REPORT_COPY.ko).sort()).toEqual(keys); expect(Object.keys(ATTENDANCE_REPORT_COPY.es).sort()).toEqual(keys);
});
