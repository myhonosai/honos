import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SCHOOL_SHELL_NAV } from '../src/components/school-shell/catalog';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { ReportsError, schoolReportsApi } from '../src/components/school-reports/http';
import { SchoolReportsView, money, monthLabel, type SchoolReportsViewProps } from '../src/components/school-reports/view';
import { sumSchoolReportLocations } from '@hon/contracts';
import { REPORTS_COPY, reportsText } from '../src/components/school-reports/copy';
import { id } from './account-status-fixtures';

// R1 (0331): month by month school reports, read with one same-origin GET.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5), correlationId: id(5) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ReportsError; } throw new Error('expected a failure'); };
const period = (month: string, from: string, to: string, over: Record<string, unknown> = {}) => ({ month, from, to, partial: false,
  attendance: { classesHeld: 2, checkIns: 5, absences: 1, studentsAttended: 3 }, enrollment: { newLeads: 4, leadsWon: 1, newMemberships: 2 },
  retention: { activeAtStart: 40, activeAtEnd: 41, ended: 3, retainedFromStart: 37 },
  revenue: [{ currency: 'USD', billedMinor: 1250000, recordedPaymentsMinor: 900000, onlinePaymentsMinor: 50000, refundsMinor: 15000 }], ...over });
const raw = (over: Record<string, unknown> = {}) => ({ schoolId: school, schoolName: 'Synthetic Dojo', timezone: 'America/Los_Angeles', months: 3,
  generatedAt: '2026-11-13T18:00:00.000Z', cancelledWithoutDate: 0, periods: [
    period('2026-09', '2026-09-01T07:00:00.000Z', '2026-10-01T07:00:00.000Z'),
    period('2026-10', '2026-10-01T07:00:00.000Z', '2026-11-01T07:00:00.000Z', { retention: { activeAtStart: 0, activeAtEnd: 2, ended: 0, retainedFromStart: 0 }, revenue: [] }),
    period('2026-11', '2026-11-01T07:00:00.000Z', '2026-11-13T18:00:00.000Z', { partial: true })], ...over });

it('reads as a plain same-origin GET with months and no key or x-hon header', async () => {
  const f = stub(json({ data: raw(), meta }));
  const read = await schoolReportsApi.read({ organizationId: org.toUpperCase(), schoolId: school }, 3, signal(), () => true);
  expect(read.periods).toHaveLength(3);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/reports/monthly?months=3`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
});

it('maps refusals and refuses anything it cannot verify', async () => {
  stub(json({ code: 'SCHOOL_REPORTS_FORBIDDEN' }, 403));
  expect((await fails(schoolReportsApi.read(scope, 3, signal(), () => true))).kind).toBe('DENIED');
  stub(json({ code: 'SCHOOL_TIMEZONE_INVALID' }, 409));
  expect((await fails(schoolReportsApi.read(scope, 3, signal(), () => true))).kind).toBe('TIMEZONE');
  stub(json({ code: 'SCHOOL_REPORTS_UNAVAILABLE' }, 503));
  expect((await fails(schoolReportsApi.read(scope, 3, signal(), () => true))).kind).toBe('UNAVAILABLE');
  for (const bad of [raw({ schoolId: id(9) }), raw({ months: 6 }), raw({ extra: true }), raw({ periods: raw().periods.slice(0, 2) }),
    raw({ periods: [raw().periods[0], raw().periods[2], raw().periods[1]] }), raw({ cancelledWithoutDate: -1 }),
    raw({ periods: raw().periods.map((p) => ({ ...p, attendance: { ...p.attendance, studentsAttended: 99 } })) }),
    raw({ periods: raw().periods.map((p) => ({ ...p, revenue: [{ currency: 'usd', billedMinor: 1, recordedPaymentsMinor: 0, onlinePaymentsMinor: 0, refundsMinor: 0 }] })) }),
    raw({ periods: raw().periods.map((p) => ({ ...p, partial: true })) })]) {
    stub(json({ data: bad, meta }));
    expect((await fails(schoolReportsApi.read(scope, 3, signal(), () => true))).kind).toBe('UNAVAILABLE');
  }
  expect((await fails(schoolReportsApi.read(scope, 2, signal(), () => true))).kind).toBe('UNAVAILABLE');
});

it('a 401 ends the session only for the request still shown', async () => {
  const seen = vi.fn(); (window as unknown as EventTarget).addEventListener(HON_SESSION_INVALIDATED_EVENT, seen);
  stub(new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } }));
  expect((await fails(schoolReportsApi.read(scope, 3, signal(), () => false))).kind).toBe('SESSION');
  expect(seen).not.toHaveBeenCalled();
  stub(new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } }));
  expect((await fails(schoolReportsApi.read(scope, 3, signal(), () => true))).kind).toBe('SESSION');
  expect(seen).toHaveBeenCalledTimes(1);
});

const view = async (over: Partial<SchoolReportsViewProps> = {}) => {
  stub(json({ data: raw({ cancelledWithoutDate: 2 }), meta }));
  const read = await schoolReportsApi.read(scope, 3, signal(), () => true);
  return renderToStaticMarkup(<SchoolReportsView language="en" waiting={false} concealed={false} hasSchool months={3} report={{ state: 'READY', read }} {...over}/>);
};

it('shows the four reports month by month with exact figures and no names', async () => {
  const html = await view();
  for (const testId of ['report-attendance', 'report-enrollment', 'report-retention', 'report-revenue', 'reports-undated']) expect(html).toContain(`data-testid="${testId}"`);
  expect(html).toContain('Sep 2026'); expect(html).toContain('Nov 2026'); expect(html).toContain('so far');
  expect(html).toContain('93%'); // 37 of 40 kept from the start
  expect(html).toContain('$12,500.00'); expect(html).toContain('$9,350.00'); // net = 9,000 + 500 - 150
  expect(html).toContain('2.5'); // check-ins per class
  expect(html).toContain('Not counted: 2 cancelled memberships');
  expect(html).toContain('aria-pressed="true"');
  expect(html).not.toContain('Synthetic Dojo');
});

it('shows each refusal plainly, hides while concealed and waits for a school', async () => {
  const t = (s: SchoolReportsViewProps['report']) => renderToStaticMarkup(<SchoolReportsView language="en" waiting={false} concealed={false} hasSchool months={6} report={s}/>);
  expect(t({ state: 'DENIED' })).toContain('reporting permission');
  expect(t({ state: 'TIMEZONE' })).toContain('time zone');
  expect(t({ state: 'UNAVAILABLE' })).toContain('Read again');
  expect(t({ state: 'LOADING' })).toContain('Reading the reports');
  expect(await view({ concealed: true })).not.toContain('report-attendance');
  expect(await view({ hasSchool: false })).toContain('Choose a school');
});

it('formats money by the currency and months as school calendar labels', () => {
  expect(money('en', 'USD', 123456)).toBe('$1,234.56');
  expect(money('en', 'JPY', 5000)).toBe('¥5,000');
  expect(monthLabel('en', '2026-01')).toBe('Jan 2026');
});

it('has every report label in Korean and Spanish with the same placeholders', () => {
  const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const key of Object.keys(REPORTS_COPY.en) as (keyof typeof REPORTS_COPY.en)[]) {
    for (const lang of ['ko', 'es'] as const) {
      expect(REPORTS_COPY[lang][key], `${lang}.${key}`).toBeTruthy();
      expect(holes(REPORTS_COPY[lang][key]), `${lang}.${key}`).toBe(holes(REPORTS_COPY.en[key]));
    }
  }
  expect(reportsText('ko-KR', 'pageTitle')).toBe('학교 보고서');
});

it('is a protected no-index route in the analytics menu and the manifest, with no command or provider path', () => {
  const route = readFileSync('src/app/staff/reports/page.tsx', 'utf8');
  for (const text of ['requireVerifiedWebSession', 'index: false', 'follow: false', 'force-dynamic']) expect(route).toContain(text);
  const analytics = SCHOOL_SHELL_NAV.find((g) => g.key === 'analytics');
  expect(analytics?.routes.some((r) => r.href === '/staff/reports')).toBe(true);
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
  expect(manifest.routes.filter((item: { path: string }) => item.path === '/staff/reports')).toHaveLength(1);
  const code = ['http.ts', 'school-reports.tsx', 'view.tsx'].map((f) => readFileSync(`src/components/school-reports/${f}`, 'utf8')).join('\n');
  expect(code).not.toMatch(/method:\s*'POST'|Idempotency-Key|X-HON-Human-Command|localStorage|sendMessage|from ['"][^'"]*(ai-|llm|stripe|square|payment)[^'"]*['"]/i);
});

// R2 (0332): every location where the reader may see reports.
const school2 = id(3);
const locationsRaw = (over: Record<string, unknown> = {}) => ({ organizationId: org, months: 3, generatedAt: '2026-11-13T18:00:00.000Z', locations: [
  { schoolId: school2, schoolName: 'Eastside Dojo', timezone: 'America/New_York', cancelledWithoutDate: 1, periods: raw().periods },
  { schoolId: school, schoolName: 'Westside Dojo', timezone: 'America/Los_Angeles', cancelledWithoutDate: 0, periods: raw().periods }], ...over });

it('reads the locations as a plain GET and refuses anything it cannot verify', async () => {
  const f = stub(json({ data: locationsRaw(), meta }));
  const read = await schoolReportsApi.locations(scope, 3, signal(), () => true);
  expect(read.locations).toHaveLength(2);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/reports/monthly/locations?months=3`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store' });
  stub(json({ code: 'SCHOOL_REPORTS_TOO_MANY_LOCATIONS' }, 422));
  expect((await fails(schoolReportsApi.locations(scope, 3, signal(), () => true))).kind).toBe('TOO_MANY');
  for (const bad of [locationsRaw({ organizationId: id(9) }), locationsRaw({ locations: [] }), locationsRaw({ locations: [locationsRaw().locations[0]] }),
    locationsRaw({ locations: [locationsRaw().locations[1], locationsRaw().locations[1]] }), locationsRaw({ months: 6 })]) {
    stub(json({ data: bad, meta }));
    expect((await fails(schoolReportsApi.locations(scope, 3, signal(), () => true))).kind).toBe('UNAVAILABLE');
  }
});

it('adds the locations up per month and shows them side by side', async () => {
  stub(json({ data: locationsRaw(), meta }));
  const read = await schoolReportsApi.locations(scope, 3, signal(), () => true);
  const totals = sumSchoolReportLocations(read.locations);
  expect(totals.map((x) => x.month)).toEqual(['2026-09', '2026-10', '2026-11']);
  expect(totals[0]?.attendance.checkIns).toBe(10);
  expect(totals[0]?.retention).toEqual({ activeAtStart: 80, activeAtEnd: 82, ended: 6, retainedFromStart: 74 });
  expect(totals[0]?.revenue).toEqual([{ currency: 'USD', billedMinor: 2500000, recordedPaymentsMinor: 1800000, onlinePaymentsMinor: 100000, refundsMinor: 30000 }]);
  expect(totals[2]?.partial).toBe(true);
  const html = renderToStaticMarkup(<SchoolReportsView language="en" waiting={false} concealed={false} hasSchool months={3} report={{ state: 'LOADING' }}
    scope="ALL" locations={{ state: 'READY', read }}/>);
  for (const text of ['Eastside Dojo', 'Westside Dojo', '2 locations', 'By location', 'data-testid="report-attendance"', 'Not counted: 1 cancelled']) expect(html).toContain(text);
  expect(html).toContain('<option value="2026-10" selected="">'); // the latest full month
  expect(html).toContain('$18,700.00'); // organization net for September: 2 x (9,000 + 500 - 150)
  const tooMany = renderToStaticMarkup(<SchoolReportsView language="es" waiting={false} concealed={false} hasSchool months={3} report={{ state: 'LOADING' }}
    scope="ALL" locations={{ state: 'TOO_MANY' }}/>);
  expect(tooMany).toContain('más de 20 sedes');
});
