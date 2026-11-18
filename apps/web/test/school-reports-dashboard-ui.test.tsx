import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { verifySchoolDashboard } from '@hon/contracts';
import { ReportsError, schoolReportsApi } from '../src/components/school-reports/http';
import { SchoolDashboardView, pointLabel, primaryCurrency } from '../src/components/school-reports/dashboard';
import { DASHBOARD_COPY } from '../src/components/school-reports/dashboard-copy';
import { dashboardLinks } from '../src/components/school-reports/school-reports';
import { SchoolReportsView } from '../src/components/school-reports/view';
import { id } from './account-status-fixtures';

// R3 (0480): the reports dashboard, read with one same-origin GET and drawn from counts and totals only.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), meta = { requestId: id(5), correlationId: id(5) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const kpis = (over: Record<string, unknown> = {}) => ({ activeStudents: 41, newStudents: 3, appointments: 7, leadsWon: 3, leadsLost: 1,
  income: [{ currency: 'USD', paymentsMinor: 950000, refundsMinor: 15000 }, { currency: 'CAD', paymentsMinor: 7000, refundsMinor: 0 }], ...over });
const raw = (over: Record<string, unknown> = {}) => ({ schoolId: school, schoolName: 'Synthetic Dojo', timezone: 'America/Los_Angeles', range: 'LAST_MONTH',
  generatedAt: '2026-11-13T18:00:00.000Z', from: '2026-10-01T07:00:00.000Z', to: '2026-11-01T07:00:00.000Z',
  previous: { from: '2026-09-01T07:00:00.000Z', to: '2026-10-01T07:00:00.000Z', kpis: kpis({ activeStudents: 38, newStudents: 5, leadsWon: 1, leadsLost: 1,
    income: [{ currency: 'USD', paymentsMinor: 800000, refundsMinor: 0 }] }) },
  kpis: kpis(),
  series: { bucket: 'DAY', truncated: false, points: [
    { start: '2026-10-01', income: [] }, { start: '2026-10-02', income: [{ currency: 'USD', paymentsMinor: 950000, refundsMinor: 0 }] },
    { start: '2026-10-03', income: [{ currency: 'USD', paymentsMinor: 0, refundsMinor: 15000 }, { currency: 'CAD', paymentsMinor: 7000, refundsMinor: 0 }] }] },
  belts: { students: 41, unranked: 2, truncated: false, ranks: [
    { curriculumId: id(10), curriculum: 'Karate', rankId: id(11), rank: 'White', color: '#ffffff', order: 1, students: 20 },
    { curriculumId: id(10), curriculum: 'Karate', rankId: id(12), rank: 'Yellow', color: null, order: 2, students: 19 }] },
  pipeline: { open: 6, stages: [{ pipelineId: id(20), pipeline: 'Main', stageId: id(21), stage: 'New', position: 1, leads: 4 },
    { pipelineId: id(20), pipeline: 'Main', stageId: id(22), stage: 'Trial booked', position: 2, leads: 2 }] }, ...over });
const read = (over: Record<string, unknown> = {}) => verifySchoolDashboard(raw(over), school, { range: (over.range as 'ALL') ?? 'LAST_MONTH' });
const html = (over: Record<string, unknown> = {}, language = 'en', links = {}) => renderToStaticMarkup(<SchoolDashboardView language={language} range="LAST_MONTH"
  dashboard={{ state: 'READY', read: read(over) }} links={links}/>);

it('reads as a plain same-origin GET with ?range and verifies the answer', async () => {
  const f = stub(json({ data: raw(), meta }));
  const result = await schoolReportsApi.dashboard({ organizationId: org, schoolId: school }, 'LAST_MONTH', new AbortController().signal, () => true);
  expect(result.kpis.activeStudents).toBe(41);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/reports/dashboard?range=LAST_MONTH`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  stub(json({ data: raw({ schoolId: id(9) }), meta }));
  await expect(schoolReportsApi.dashboard({ organizationId: org, schoolId: school }, 'LAST_MONTH', new AbortController().signal, () => true)).rejects.toBeInstanceOf(ReportsError);
  stub(json({ code: 'SCHOOL_REPORTS_FORBIDDEN' }, 403));
  await expect(schoolReportsApi.dashboard({ organizationId: org, schoolId: school }, 'LAST_MONTH', new AbortController().signal, () => true)).rejects.toMatchObject({ kind: 'DENIED' });
});

it('the contract refuses a wrong range, a missing comparison, unsorted points and a person count above the total', () => {
  expect(() => verifySchoolDashboard(raw(), school, { range: 'M12' })).toThrow();
  expect(() => verifySchoolDashboard(raw({ previous: null }), school, { range: 'LAST_MONTH' })).toThrow();
  expect(() => verifySchoolDashboard(raw({ series: { bucket: 'DAY', truncated: false, points: [{ start: '2026-10-02', income: [] }, { start: '2026-10-01', income: [] }] } }), school, { range: 'LAST_MONTH' })).toThrow();
  expect(() => verifySchoolDashboard(raw({ series: { bucket: 'MONTH', truncated: false, points: [{ start: '2026-10-01', income: [] }] } }), school, { range: 'LAST_MONTH' })).toThrow();
  expect(() => verifySchoolDashboard(raw({ belts: { students: 1, unranked: 2, truncated: false, ranks: [] } }), school, { range: 'LAST_MONTH' })).toThrow();
  expect(() => verifySchoolDashboard(raw({ extra: 1 }), school, { range: 'LAST_MONTH' })).toThrow();
  const all = verifySchoolDashboard(raw({ range: 'ALL', from: null, previous: null, series: { bucket: 'MONTH', truncated: true, points: [{ start: '2026-10-01', income: [] }] } }), school, { range: 'ALL' });
  expect(all.previous).toBeNull();
});

it('shows five KPI cards with plain trends, the win rate and other currencies', () => {
  const page = html();
  for (const label of ['Active students', 'New students', 'Appointments', 'Lead conversion', 'Income']) expect(page).toContain(label);
  expect(page).toContain('41'); expect(page).toContain('up 3'); expect(page).toContain('down 2');
  expect(page).toContain('75%'); expect(page).toContain('3 won of 4 closed'); expect(page).toContain('up 25 points');
  expect(page).toContain('$9,350.00'); expect(page).toContain('up $1,350.00'); expect(page).toContain('Also: CA$70.00');
  expect(page).toContain('Oct 1, 2026 to Oct 31, 2026 (America/Los_Angeles)');
});

it('draws the income chart in one currency with a table view, and belts, stages and won vs lost', () => {
  const page = html();
  expect(primaryCurrency(read())).toBe('USD');
  expect(page).toContain('Shown in USD');
  expect((page.match(/<rect[^>]*class="[^"]*bar/g) ?? []).length).toBe(2);
  expect(page).toContain('Show as a table');
  expect(page).toContain('White'); expect(page).toContain('Yellow'); expect(page).toContain('No rank yet: 2');
  expect(page).toContain('Trial booked'); expect(page).toContain('Win rate 75%');
  expect(page).not.toMatch(/Main · New/);
  expect(pointLabel('en', '2026-10-01', 'MONTH')).toBe('Oct 2026');
});

it('links only to pages in the school menu, never to one that is missing', () => {
  const links = dashboardLinks(null);
  expect(links.renewals).toBe('/staff/billing/renewals');
  expect(links.leads).toBe('/staff/crm');
  const page = html({}, 'en', links);
  expect(page).toContain('href="/staff/billing/renewals"');
  if (!links.goal) expect(page).not.toContain('Monthly goal');
  expect(html({}, 'en', {})).not.toContain('View details');
});

it('says when nothing closed and when there is no earlier period', () => {
  const page = html({ range: 'ALL', from: null, previous: null, kpis: kpis({ leadsWon: 0, leadsLost: 0, income: [] }),
    series: { bucket: 'MONTH', truncated: true, points: [{ start: '2026-10-01', income: [] }] } });
  expect(page).toContain('No leads closed'); expect(page).toContain('No earlier period to compare with.');
  expect(page).toContain('No payments'); expect(page).toContain('Showing the last 36 months.');
  expect(page).not.toContain('▲');
});

it('the reports page switches between the overview and the month tables; a failed overview shows a retry', () => {
  const base = { language: 'en', waiting: false, concealed: false, hasSchool: true, months: 6, report: { state: 'LOADING' as const }, onView: () => {} };
  const overview = renderToStaticMarkup(<SchoolReportsView {...base} view="OVERVIEW" dashboard={{ state: 'UNAVAILABLE' }}/>);
  expect(overview).toContain('Overview'); expect(overview).toContain('Month by month'); expect(overview).toContain('Read again');
  expect(overview).not.toContain('6 months');
  const monthly = renderToStaticMarkup(<SchoolReportsView {...base} view="MONTHLY"/>);
  expect(monthly).toContain('6 months'); expect(monthly).not.toContain('This month');
});

it('has the same wording keys in English, Korean and Spanish', () => {
  const keys = Object.keys(DASHBOARD_COPY.en).sort();
  expect(Object.keys(DASHBOARD_COPY.ko).sort()).toEqual(keys);
  expect(Object.keys(DASHBOARD_COPY.es).sort()).toEqual(keys);
  expect(html({}, 'ko')).toContain('활동 학생');
});
