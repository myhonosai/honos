import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CLAIRE_KPI_CODES, type ClaireKpiView } from '@hon/contracts';
import { ClaireKpiError, claireKpiApi, claireKpiErrorFor } from '../src/components/hon-command/claire-kpi-http';
import { CLAIRE_KPI_NOTICE, ClaireKpiPanel, ClaireKpiResult, claireKpiChange } from '../src/components/hon-command/claire-kpi-panel';
import { HON_COMMAND_ROSTER } from '../src/components/hon-command/roster';

const ORG = '11111111-1111-4111-8111-111111111111', SCHOOL = '22222222-2222-4222-8222-222222222222', ID = '33333333-3333-4333-8333-333333333333', KEY = '44444444-4444-4444-8444-444444444444';
const scope = { organizationId: ORG, schoolId: SCHOOL };
const kpis = CLAIRE_KPI_CODES.map((kpi, n) => ({ kpi, current: n + 2, previous: kpi === 'ACTIVE_MEMBERSHIPS' ? null : n + 1 }));
const view = (patch: Partial<ClaireKpiView> = {}): ClaireKpiView => ({ id: ID, status: 'RESULT_RECORDED', reason: null, brief: { period: 'LAST_7_DAYS', focus: '' }, kpis,
  summary: 'A busier week.', notes: [{ kpi: 'NEW_LEADS', note: 'More leads from the trial offer.' }], watch: [{ title: 'Ended memberships', detail: 'Two left this week.' }],
  actions: [{ title: 'Call new leads', detail: 'Three are still open.' }], problems: [], createdAt: '2026-11-22T00:00:00.000Z', updatedAt: '2026-11-22T00:00:00.000Z', ...patch });
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const call = (f: ReturnType<typeof stub>, n = 0) => f.mock.calls[n] as unknown as [string, RequestInit];
const signal = () => new AbortController().signal;
const yes = () => true;
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('marks Claire KPI reports available, with nothing left as backend required', () => {
  const claire = HON_COMMAND_ROSTER.find((a) => a.id === 'claire')!;
  expect(claire.capabilities.filter((c) => c.state === 'BACKEND_REQUIRED')).toEqual([]);
  expect(claire.capabilities.find((c) => /KPI report/.test(c.label))?.state).toBe('AVAILABLE');
});

it('lists with a plain GET and asks and dismisses with their own human command and key', async () => {
  let f = stub(json({ data: { aiAvailable: true, reports: [view()] } }));
  expect((await claireKpiApi.list(scope, signal(), yes)).reports).toHaveLength(1);
  let [url, init] = call(f);
  expect(url).toBe(`/api/v1/organizations/${ORG}/schools/${SCHOOL}/claire/kpi-reports`); expect(init.method).toBe('GET');
  expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBeUndefined();
  f = stub(json({ data: view() }));
  await claireKpiApi.request(scope, { period: 'LAST_30_DAYS', focus: 'Retention' }, KEY, signal(), yes);
  [url, init] = call(f);
  expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe('claire.kpi_report.request'); expect(JSON.parse(init.body as string)).toEqual({ period: 'LAST_30_DAYS', focus: 'Retention' });
  f = stub(json({ data: view({ status: 'DISMISSED', summary: null, notes: null, watch: null, actions: null }) }));
  await claireKpiApi.dismiss(scope, ID, KEY, signal(), yes);
  [url, init] = call(f);
  expect(url).toMatch(/\/claire\/kpi-reports\/33333333-3333-4333-8333-333333333333\/close$/); expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe('claire.kpi_report.close');
});

it('refuses bad input before anything is sent, and maps refusals to plain outcomes', async () => {
  const f = stub();
  await expect(claireKpiApi.request(scope, { period: 'LAST_7_DAYS', focus: ' padded' }, KEY, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(claireKpiApi.request(scope, { period: 'LAST_90_DAYS' as never, focus: '' }, KEY, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  expect(f).not.toHaveBeenCalled();
  expect(claireKpiErrorFor(403, 'CLAIRE_KPI_SPEND_STOPPED').kind).toBe('PAUSED');
  expect(claireKpiErrorFor(403, 'CLAIRE_KPI_FORBIDDEN').kind).toBe('NO_ACCESS');
  expect(claireKpiErrorFor(409, 'CLAIRE_KPI_NOT_OPEN').kind).toBe('GONE');
  stub(json({ code: 'CLAIRE_KPI_FORBIDDEN' }, 403));
  await expect(claireKpiApi.request(scope, { period: 'LAST_7_DAYS', focus: '' }, KEY, signal(), yes)).rejects.toBeInstanceOf(ClaireKpiError);
  expect(CLAIRE_KPI_NOTICE.NO_ACCESS).toMatch(/Nothing was sent/);
});

it('shows every counted number with its change, Claire’s note beside it, things to watch, actions and dismiss', () => {
  const html = renderToStaticMarkup(<ClaireKpiResult view={view()} busy={false} onDismiss={() => {}} />);
  expect(html).toContain('New leads: 2'); expect(html).toContain('up 1 from 1'); expect(html).toContain('More leads from the trial offer.');
  expect(html).toContain('Active memberships now: 10'); expect(html.match(/data-claire-kpi-row=/g)).toHaveLength(9);
  expect(html).toContain('Ended memberships'); expect(html).toContain('Call new leads'); expect(html).toContain('data-claire-dismiss');
  expect(html).toContain('last 7 days against the 7 days before');
  expect(claireKpiChange({ kpi: 'NEW_LEADS', current: 3, previous: 3 })).toBe('same as before (3)');
  expect(claireKpiChange({ kpi: 'LOST_LEADS', current: 1, previous: 4 })).toBe('down 3 from 4');
  expect(renderToStaticMarkup(<ClaireKpiResult view={view({ watch: [] })} busy={false} onDismiss={() => {}} />)).not.toContain('Keep an eye on');
});

it('starts by checking availability and never renders a report before the server answers', () => {
  const html = renderToStaticMarkup(<ClaireKpiPanel scope={scope} api={{ ...claireKpiApi, list: () => new Promise(() => {}) }} />);
  expect(html).toContain('data-claire-kpi="CHECKING"'); expect(html).not.toContain('data-claire-ask'); expect(html).not.toContain('data-claire-result');
});
