import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { JordanFollowUpView } from '@hon/contracts';
import { JordanFollowUpError, jordanFollowUpApi, jordanFollowUpErrorFor } from '../src/components/hon-command/jordan-follow-up-http';
import { JORDAN_FOLLOW_UP_NOTICE, JordanFollowUpPanel, JordanFollowUpResult } from '../src/components/hon-command/jordan-follow-up-panel';
import { HON_COMMAND_ROSTER } from '../src/components/hon-command/roster';

const ORG = '11111111-1111-4111-8111-111111111111', SCHOOL = '22222222-2222-4222-8222-222222222222', ID = '33333333-3333-4333-8333-333333333333', KEY = '44444444-4444-4444-8444-444444444444';
const COACH = '55555555-5555-4555-8555-555555555555', ITEM = '66666666-6666-4666-8666-666666666666', ITEM2 = '77777777-7777-4777-8777-777777777777';
const scope = { organizationId: ORG, schoolId: SCHOOL };
const s = (patch = {}) => ({ item: 'W1', action: 'RESCHEDULE' as const, reason: 'The coach is out until Thursday.', dueInDays: 3, assignee: null, priority: null, ...patch });
const view = (patch: Partial<JordanFollowUpView> = {}): JordanFollowUpView => ({ id: ID, status: 'RESULT_RECORDED', reason: null, brief: { focus: 'OVERDUE', note: '' }, mine: true,
  summary: 'Two tasks are late.', suggestions: [s(), s({ item: 'W2', action: 'REASSIGN', dueInDays: null, assignee: 'S2' })],
  staff: [{ ref: 'S2', principalId: COACH, name: 'Synthetic Coach' }], items: [{ ref: 'W1', workItemId: ITEM, title: 'Order new belts' }, { ref: 'W2', workItemId: ITEM2, title: 'Fix the door lock' }],
  applied: [], problems: [], createdAt: '2026-11-22T00:00:00.000Z', updatedAt: '2026-11-22T00:00:00.000Z', ...patch });
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const call = (f: ReturnType<typeof stub>, n = 0) => f.mock.calls[n] as unknown as [string, RequestInit];
const signal = () => new AbortController().signal;
const yes = () => true;
const result = (v: JordanFollowUpView, ticked: number[] = [0, 1], busy = false) => renderToStaticMarkup(<JordanFollowUpResult view={v} ticked={ticked} busy={busy} onTick={() => {}} onApply={() => {}} onDismiss={() => {}} />);
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('marks Jordan follow-through available, with nothing left as backend required', () => {
  const jordan = HON_COMMAND_ROSTER.find((a) => a.id === 'jordan')!;
  expect(jordan.capabilities.filter((c) => c.state === 'BACKEND_REQUIRED')).toEqual([]);
});

it('lists with a plain GET and asks, applies and dismisses with their own human command and key', async () => {
  let f = stub(json({ data: { aiAvailable: true, followUps: [view()] } }));
  expect((await jordanFollowUpApi.list(scope, signal(), yes)).followUps).toHaveLength(1);
  let [url, init] = call(f);
  expect(url).toBe(`/api/v1/organizations/${ORG}/schools/${SCHOOL}/jordan/follow-ups`); expect(init.method).toBe('GET');
  expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBeUndefined();

  f = stub(json({ data: view() }));
  await jordanFollowUpApi.request(scope, { focus: 'OPEN', note: 'Belt test Saturday' }, KEY, signal(), yes);
  [url, init] = call(f);
  expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe('jordan.follow_up.request'); expect(JSON.parse(init.body as string)).toEqual({ focus: 'OPEN', note: 'Belt test Saturday' });

  f = stub(json({ data: { followUp: view({ status: 'APPLIED', applied: [{ index: 0, workItemId: ITEM }] }), replayed: false } }));
  expect((await jordanFollowUpApi.apply(scope, ID, [0], KEY, signal(), yes)).applied).toEqual([{ index: 0, workItemId: ITEM }]);
  [url, init] = call(f);
  expect(url).toMatch(/\/jordan\/follow-ups\/33333333-3333-4333-8333-333333333333\/apply$/); expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe('jordan.follow_up.apply');
  expect(JSON.parse(init.body as string)).toEqual({ suggestions: [0] });

  f = stub(json({ data: view({ status: 'DISMISSED', summary: null, suggestions: null }) }));
  await jordanFollowUpApi.dismiss(scope, ID, KEY, signal(), yes);
  expect((call(f)[1].headers as Record<string, string>)['X-HON-Human-Command']).toBe('jordan.follow_up.close');
});

it('refuses bad input before anything is sent, and maps refusals to plain outcomes', async () => {
  const f = stub();
  await expect(jordanFollowUpApi.request(scope, { focus: 'OPEN', note: ' padded' }, KEY, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(jordanFollowUpApi.apply(scope, ID, [10], KEY, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(jordanFollowUpApi.apply(scope, ID, [1, 1], KEY, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  expect(f).not.toHaveBeenCalled();
  expect(jordanFollowUpErrorFor(409, 'JORDAN_FOLLOW_UP_TASK_CHANGED').kind).toBe('CHANGED');
  expect(jordanFollowUpErrorFor(403, 'JORDAN_FOLLOW_UP_SPEND_STOPPED').kind).toBe('PAUSED');
  expect(jordanFollowUpErrorFor(403, 'JORDAN_FOLLOW_UP_ASSIGNEE_UNAVAILABLE').kind).toBe('ASSIGNEE');
  expect(jordanFollowUpErrorFor(403, 'JORDAN_FOLLOW_UP_FORBIDDEN').kind).toBe('NO_ACCESS');
  stub(json({ code: 'JORDAN_FOLLOW_UP_TASK_CHANGED' }, 409));
  await expect(jordanFollowUpApi.apply(scope, ID, [0], KEY, signal(), yes)).rejects.toBeInstanceOf(JordanFollowUpError);
  expect(JORDAN_FOLLOW_UP_NOTICE.CHANGED).toMatch(/Nothing was applied/);
});

it('shows each suggestion by task title in plain words, with ticks, apply and dismiss', () => {
  const html = result(view(), [1]);
  expect(html).toContain('Order new belts'); expect(html).toContain('Move the due date to in 3 days');
  expect(html).toContain('Fix the door lock'); expect(html).toContain('Give it to Synthetic Coach');
  expect(html).toContain('Apply 1 suggestion'); expect(html).toContain('data-jordan-dismiss');
  expect(html).toContain('Check it before you apply anything');
  const more = result(view({ suggestions: [s({ action: 'REPRIORITIZE', dueInDays: null, priority: 'HIGH' }), s({ item: 'W2', action: 'FOLLOW_UP', dueInDays: 0 })] }));
  expect(more).toContain('Set priority to high'); expect(more).toContain('Add a check-in task for you, due today');
});

it('shows what was applied and offers no action on another person’s list', () => {
  const applied = result(view({ status: 'APPLIED', applied: [{ index: 1, workItemId: ITEM2 }] }));
  expect(applied).toContain('data-jordan-done="1"'); expect(applied).not.toContain('data-jordan-done="0"');
  expect(applied).toContain('1 suggestion was applied in Work. Jordan did not send or change anything else.');
  expect(applied).not.toContain('data-jordan-apply');
  expect(result(view({ mine: false }))).not.toContain('data-jordan-tick');
});

it('starts by checking availability and never renders suggestions before the server answers', () => {
  const html = renderToStaticMarkup(<JordanFollowUpPanel scope={scope} api={{ ...jordanFollowUpApi, list: () => new Promise(() => {}) }} />);
  expect(html).toContain('data-jordan-follow-up="CHECKING"'); expect(html).not.toContain('data-jordan-ask'); expect(html).not.toContain('data-jordan-result');
});
