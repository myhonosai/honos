import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AiControlError, aiControlApi } from '../src/components/hq-ai-control/http';
import { AiCostAlertsView, alertKey, type AiCostAlertsViewProps } from '../src/components/hq-ai-control/view';
import { id } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), school2 = id(3), key = id(77);
const WINDOW = '2026-11-01T00:00:00.000Z';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as AiControlError; } throw new Error('expected a failure'); };
const alert = (over: Record<string, unknown> = {}) => ({ schoolId: school, organizationId: org, schoolName: 'Test Dojo North', trial: false, level: 'WARNING_90',
  ceilingMicros: 2000, committedCostMicros: 1800, usedBasisPoints: 9000, crossedAt: '2026-11-05T10:00:00.000Z', windowStart: WINDOW, acknowledgement: null, ...over });
const list = (alerts = [alert(), alert({ level: 'WARNING_75', acknowledgement: { acknowledgedAt: '2026-11-05T11:00:00.000Z', reason: 'Owner is aware of the launch week' } })],
  openCount = 1) => ({ alerts, openCount, asOf: '2026-11-06T00:00:00.000Z' });
const view = (over: Partial<AiCostAlertsViewProps> = {}) => renderToStaticMarkup(<AiCostAlertsView language="en" concealed={false}
  alerts={{ state: 'READY', view: list() as never }} open={null} outcome={null} locked={false} canRetry={false} {...over}/>);

it('reads alerts as a plain same-origin GET and refuses answers that drift from the contract', async () => {
  const f = stub(json({ data: list() }));
  const got = await aiControlApi.costAlerts(signal(), () => true);
  expect(got.openCount).toBe(1);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/hq/ai/school-cost-alerts');
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', redirect: 'error' });
  // A level the committed cost has not reached, wrong basis points, an open alert after an acknowledged one, or a wrong open count is drift.
  for (const bad of [list([alert({ level: 'CEILING_REACHED' })]), list([alert({ usedBasisPoints: 8999 })]),
    list([alert({ level: 'WARNING_75', acknowledgement: { acknowledgedAt: WINDOW, reason: 'Owner is aware already' } }), alert()]), list([alert()], 2),
    list([alert(), alert()], 2), list([alert({ crossedAt: '2026-10-31T00:00:00.000Z' })])]) {
    stub(json({ data: bad }));
    expect((await fails(aiControlApi.costAlerts(signal(), () => true))).kind).toBe('UNKNOWN');
  }
});

it('acknowledges with its own human-command marker and key, and checks the receipt is for this alert', async () => {
  const body = { schoolId: school, level: 'WARNING_90', windowStart: WINDOW, reason: 'Owner is aware of the launch week' } as const;
  const receipt = { schoolId: school, organizationId: org, level: 'WARNING_90', windowStart: WINDOW, acknowledgedAt: '2026-11-06T00:00:00.000Z', replayed: false };
  const f = stub(json({ data: receipt }));
  expect((await aiControlApi.acknowledgeCostAlert(body, key, signal(), () => true)).replayed).toBe(false);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/hq/ai/school-cost-alerts/acknowledgements');
  expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'X-HON-Human-Command': 'ai-school-cost-alert-ack', 'Idempotency-Key': key } });
  expect(JSON.parse(init.body as string)).toEqual(body);
  for (const other of [{ schoolId: school2 }, { level: 'WARNING_75' }, { windowStart: '2026-10-01T00:00:00.000Z' }]) {
    stub(json({ data: { ...receipt, ...other } }));
    expect((await fails(aiControlApi.acknowledgeCostAlert(body, key, signal(), () => true))).kind).toBe('UNKNOWN');
  }
  const g = stub(json({}));
  expect((await fails(aiControlApi.acknowledgeCostAlert({ ...body, reason: 'short' }, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(aiControlApi.acknowledgeCostAlert({ ...body, level: 'NORMAL' as never }, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(aiControlApi.acknowledgeCostAlert(body, 'nope', signal(), () => true))).kind).toBe('INVALID');
  expect(g).not.toHaveBeenCalled();
  // Busy or a refusal from the HQ billing reader who is not the owner.
  stub(json({ code: 'SAAS_FORBIDDEN' }, 403));
  expect((await fails(aiControlApi.acknowledgeCostAlert(body, key, signal(), () => true))).kind).toBe('DENIED');
});

it('shows each alert with its level, cost and when it was reached, and offers Acknowledge only on open alerts', () => {
  const html = view();
  expect(html).toContain('90% of the limit used'); expect(html).toContain('75% of the limit used');
  expect(html).toContain('Test Dojo North'); expect(html).toContain('1 open');
  expect(html).toContain('(90%)'); expect(html).toContain('Reached Nov 5, 2026');
  expect(html).toContain('Acknowledged Nov 5, 2026'); expect(html).toContain('Owner is aware of the launch week');
  expect(html.match(/>Acknowledge</g)?.length).toBe(1);
  const holds = view({ alerts: { state: 'READY', view: list([alert({ crossedAt: null, trial: true })]) as never } });
  expect(holds).toContain('Reached by work still in progress'); expect(holds).toContain('Free trial');
  expect(view({ alerts: { state: 'READY', view: list([], 0) as never } })).toContain('No school is near its AI cost limit.');
  const form = view({ open: alertKey({ schoolId: school, level: 'WARNING_90' }) });
  expect(form).toContain('ack-form'); expect(form).toContain('Acknowledge alert'); expect(form).toContain('minLength="10"');
});

it('offers Try again only for a kept acknowledgement, hides everything when concealed, and is mounted on the AI costs page', () => {
  const kept = view({ outcome: { kind: 'UNKNOWN' }, locked: true, canRetry: true, onTryAgain: () => {}, onDiscard: () => {} });
  expect(kept).toContain('Try again');
  expect(view({ outcome: { kind: 'INVALID' }, onTryAgain: () => {} })).not.toContain('Try again');
  expect(view({ outcome: { kind: 'DONE', replayed: true } })).toContain('already done with the same request');
  const hidden = view({ concealed: true, onReveal: () => {} });
  expect(hidden).not.toContain('Test Dojo North'); expect(hidden).toContain('Show again');
  expect(view({ alerts: { state: 'DENIED' } })).not.toContain('cost-alert"');
  const ko = renderToStaticMarkup(<AiCostAlertsView language="ko" concealed={false} alerts={{ state: 'READY', view: list() as never }} open={null} outcome={null} locked={false} canRetry={false}/>);
  expect(ko).toContain('한도의 90% 사용');
  expect(readFileSync('src/app/hq/ai-costs/page.tsx', 'utf8')).toContain('<HqAiCostAlerts />');
});
