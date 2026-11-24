import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AlexPlanView } from '@hon/contracts';
import { AlexPlanError, alexPlanApi, alexPlanErrorFor } from '../src/components/hon-command/alex-plan-http';
import { ALEX_PLAN_NOTICE, AlexPlanPanel, AlexPlanResult } from '../src/components/hon-command/alex-plan-panel';
import { HON_COMMAND_ROSTER } from '../src/components/hon-command/roster';

const ORG = '11111111-1111-4111-8111-111111111111', SCHOOL = '22222222-2222-4222-8222-222222222222', ID = '33333333-3333-4333-8333-333333333333', KEY = '44444444-4444-4444-8444-444444444444';
const COACH = '55555555-5555-4555-8555-555555555555', ITEM = '66666666-6666-4666-8666-666666666666';
const scope = { organizationId: ORG, schoolId: SCHOOL };
const task = (patch = {}) => ({ title: 'Call trial leads', description: 'Phone each trial lead who did not book a second class.', priority: 'HIGH' as const, assignee: 'S2', dueInDays: 2, area: 'chad' as const, ...patch });
const view = (patch: Partial<AlexPlanView> = {}): AlexPlanView => ({ id: ID, status: 'RESULT_RECORDED', reason: null, brief: { goal: 'Get ten more trial bookings', horizon: 'WEEK' }, mine: true,
  summary: 'Follow up on trials first.', tasks: [task(), task({ title: 'Check capacity', assignee: null, dueInDays: null, area: null, priority: 'LOW' })],
  staff: [{ ref: 'S2', principalId: COACH, name: 'Synthetic Coach' }], created: [], problems: [], createdAt: '2026-11-22T00:00:00.000Z', updatedAt: '2026-11-22T00:00:00.000Z', ...patch });
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const call = (f: ReturnType<typeof stub>, n = 0) => f.mock.calls[n] as unknown as [string, RequestInit];
const signal = () => new AbortController().signal;
const yes = () => true;
const result = (v: AlexPlanView, ticked: number[] = [0, 1], busy = false) => renderToStaticMarkup(<AlexPlanResult view={v} ticked={ticked} busy={busy} onTick={() => {}} onCreate={() => {}} onDismiss={() => {}} />);
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('marks Alex planning available, with nothing left as backend required', () => {
  const alex = HON_COMMAND_ROSTER.find((a) => a.id === 'alex')!;
  expect(alex.capabilities.filter((c) => c.state === 'BACKEND_REQUIRED')).toEqual([]);
  expect(alex.capabilities.find((c) => /Plan with Alex/.test(c.label))?.state).toBe('AVAILABLE');
});

it('lists plans with a plain same-origin GET and verifies the answer', async () => {
  const f = stub(json({ data: { aiAvailable: true, plans: [view()] } }));
  const list = await alexPlanApi.list(scope, signal(), yes);
  expect(list.aiAvailable).toBe(true); expect(list.plans[0]!.tasks).toHaveLength(2);
  const [url, init] = call(f);
  expect(url).toBe(`/api/v1/organizations/${ORG}/schools/${SCHOOL}/alex/plans`);
  expect(init.method).toBe('GET'); expect(init.credentials).toBe('same-origin'); expect(init.redirect).toBe('error');
  expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBeUndefined();
  stub(json({ data: { aiAvailable: true, plans: [{ ...view(), extra: 1 }] } }));
  await expect(alexPlanApi.list(scope, signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
});

it('asks, creates and dismisses with their own human command and key', async () => {
  let f = stub(json({ data: view() }));
  await alexPlanApi.request(scope, { goal: 'Get ten more trial bookings', horizon: 'WEEK' }, KEY, signal(), yes);
  let [url, init] = call(f); let h = init.headers as Record<string, string>;
  expect(url).toBe(`/api/v1/organizations/${ORG}/schools/${SCHOOL}/alex/plans`); expect(h['X-HON-Human-Command']).toBe('alex.plan.request'); expect(h['Idempotency-Key']).toBe(KEY);
  expect(JSON.parse(init.body as string)).toEqual({ goal: 'Get ten more trial bookings', horizon: 'WEEK' });

  f = stub(json({ data: { plan: view({ status: 'APPLIED', created: [{ index: 0, workItemId: ITEM }] }), replayed: false } }));
  const made = await alexPlanApi.create(scope, ID, [0], KEY, signal(), yes);
  expect(made.created).toEqual([{ index: 0, workItemId: ITEM }]);
  [url, init] = call(f); h = init.headers as Record<string, string>;
  expect(url).toBe(`/api/v1/organizations/${ORG}/schools/${SCHOOL}/alex/plans/${ID}/create`); expect(h['X-HON-Human-Command']).toBe('alex.plan.create'); expect(JSON.parse(init.body as string)).toEqual({ tasks: [0] });

  f = stub(json({ data: view({ status: 'DISMISSED', summary: null, tasks: null }) }));
  await alexPlanApi.dismiss(scope, ID, KEY, signal(), yes);
  [url, init] = call(f);
  expect(url).toMatch(/\/close$/); expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe('alex.plan.close'); expect(JSON.parse(init.body as string)).toEqual({ status: 'DISMISSED' });
});

it('refuses bad input before anything is sent', async () => {
  const f = stub();
  await expect(alexPlanApi.request(scope, { goal: ' padded', horizon: 'WEEK' }, KEY, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(alexPlanApi.request(scope, { goal: 'ok', horizon: 'WEEK' }, 'not-a-key', signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(alexPlanApi.create(scope, ID, [0, 0], KEY, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(alexPlanApi.create(scope, ID, [8], KEY, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(alexPlanApi.list({ organizationId: 'x', schoolId: SCHOOL }, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  expect(f).not.toHaveBeenCalled();
});

it('maps server refusals to plain outcomes', async () => {
  expect(alexPlanErrorFor(403, 'ALEX_PLAN_SPEND_STOPPED').kind).toBe('PAUSED');
  expect(alexPlanErrorFor(403, 'ALEX_PLAN_ASSIGN_FORBIDDEN').kind).toBe('ASSIGN');
  expect(alexPlanErrorFor(403, 'ALEX_PLAN_ASSIGNEE_UNAVAILABLE').kind).toBe('ASSIGNEE');
  expect(alexPlanErrorFor(403, 'ALEX_PLAN_FORBIDDEN').kind).toBe('NO_ACCESS');
  expect(alexPlanErrorFor(409, 'ALEX_PLAN_NOT_OPEN').kind).toBe('GONE');
  expect(alexPlanErrorFor(502, null).kind).toBe('UNKNOWN');
  stub(json({ code: 'ALEX_PLAN_ASSIGN_FORBIDDEN' }, 403));
  await expect(alexPlanApi.create(scope, ID, [0], KEY, signal(), yes)).rejects.toBeInstanceOf(AlexPlanError);
  expect(ALEX_PLAN_NOTICE.ASSIGN).toMatch(/Nothing was created/);
  expect(ALEX_PLAN_NOTICE.UNKNOWN).toMatch(/never sent twice/);
});

it('shows an open plan with staff names, due dates and ticks, and creates only what is ticked', () => {
  const html = result(view(), [1]);
  expect(html).toContain('Synthetic Coach · Due in 2 days · High priority');
  expect(html).toContain('Anyone · No due date · Low priority');
  expect(html).toContain('href="/staff/crm/leads"');
  expect(html).toContain('Create 1 task');
  expect(html).toMatch(/data-alex-tick="1"[^>]*checked|checked=""[^>]*data-alex-tick="1"/);
  expect(html).toContain('data-alex-dismiss');
  expect(html).toContain('Check it before you create anything');
  expect(result(view(), [])).toMatch(/disabled=""[^>]*data-alex-create|data-alex-create[^>]*disabled/);
});

it('shows created tasks after use and offers no action on another person’s plan', () => {
  const applied = result(view({ status: 'APPLIED', created: [{ index: 0, workItemId: ITEM }] }));
  expect(applied).toContain('data-alex-made="0"'); expect(applied).not.toContain('data-alex-made="1"');
  expect(applied).toContain('1 task was created in Work. Alex did not send or change anything else.');
  expect(applied).not.toContain('data-alex-create'); expect(applied).not.toContain('data-alex-tick');
  const theirs = result(view({ mine: false }));
  expect(theirs).not.toContain('data-alex-create'); expect(theirs).not.toContain('data-alex-tick');
});

it('starts by checking availability and never renders a plan before the server answers', () => {
  const html = renderToStaticMarkup(<AlexPlanPanel scope={scope} api={{ ...alexPlanApi, list: () => new Promise(() => {}) }} />);
  expect(html).toContain('id="alex-plan"'); expect(html).toContain('data-alex-plan="CHECKING"');
  expect(html).not.toContain('data-alex-ask'); expect(html).not.toContain('data-alex-result');
});
