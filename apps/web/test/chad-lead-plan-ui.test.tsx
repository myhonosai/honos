import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChadLeadPlanView } from '@hon/contracts';
import { ChadLeadPlanError, chadLeadPlanApi, chadLeadPlanErrorFor } from '../src/components/hon-command/chad-lead-plan-http';
import { CHAD_LEAD_PLAN_NOTICE, ChadLeadPlanPanel, ChadLeadPlanResult, chadStepLabel } from '../src/components/hon-command/chad-lead-plan-panel';
import { HON_COMMAND_ROSTER } from '../src/components/hon-command/roster';

const ORG = '11111111-1111-4111-8111-111111111111', SCHOOL = '22222222-2222-4222-8222-222222222222', ID = '33333333-3333-4333-8333-333333333333', KEY = '44444444-4444-4444-8444-444444444444';
const LEAD = '55555555-5555-4555-8555-555555555555', STAGE = '66666666-6666-4666-8666-666666666666', CLASS = '77777777-7777-4777-8777-777777777777';
const scope = { organizationId: ORG, schoolId: SCHOOL };
const view = (patch: Partial<ChadLeadPlanView> = {}): ChadLeadPlanView => ({ id: ID, status: 'RESULT_RECORDED', reason: null, brief: { focus: 'ALL_OPEN', note: '' },
  summary: 'Two leads are ready.', suggestions: [{ lead: 'L1', action: 'MOVE_STAGE', stage: 'S2', slot: null, reason: 'Asked for a call back.' },
    { lead: 'L2', action: 'BOOK_TRIAL', stage: null, slot: 'C1', reason: 'Keen to try a kids class.' }],
  leads: [{ ref: 'L1', leadId: LEAD, leadVersion: 2, name: 'Sample Lead' }], stages: [{ ref: 'S2', stageId: STAGE, name: 'Contacted' }],
  classes: [{ ref: 'C1', classSessionId: CLASS, name: 'Kids basics', startsAt: '2026-11-23T17:00:00.000Z', endsAt: '2026-11-23T18:00:00.000Z' }],
  applied: [], problems: [], createdAt: '2026-11-22T00:00:00.000Z', updatedAt: '2026-11-22T00:00:00.000Z', ...patch });
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const call = (f: ReturnType<typeof stub>, n = 0) => f.mock.calls[n] as unknown as [string, RequestInit];
const signal = () => new AbortController().signal;
const yes = () => true;
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('marks Chad lead next steps available with nothing backend required', () => {
  const chad = HON_COMMAND_ROSTER.find((a) => a.id === 'chad')!;
  expect(chad.capabilities.find((c) => /Next steps for open leads/.test(c.label))?.state).toBe('AVAILABLE');
  expect(chad.capabilities.filter((c) => c.state === 'BACKEND_REQUIRED')).toEqual([]);
});

it('lists with a plain GET and asks, records steps and dismisses with their own human command and key', async () => {
  let f = stub(json({ data: { aiAvailable: true, leadPlans: [view()] } }));
  expect((await chadLeadPlanApi.list(scope, signal(), yes)).leadPlans).toHaveLength(1);
  let [url, init] = call(f);
  expect(url).toBe(`/api/v1/organizations/${ORG}/schools/${SCHOOL}/chad/lead-plan`); expect(init.method).toBe('GET');
  expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBeUndefined();
  f = stub(json({ data: view() }));
  await chadLeadPlanApi.request(scope, { focus: 'NO_TRIAL_YET', note: 'Spring push' }, KEY, signal(), yes);
  [url, init] = call(f);
  expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe('chad.lead_plan.request'); expect(JSON.parse(init.body as string)).toEqual({ focus: 'NO_TRIAL_YET', note: 'Spring push' });
  f = stub(json({ data: { leadPlan: view({ applied: [{ index: 1, action: 'BOOK_TRIAL', leadId: LEAD, appointmentId: KEY }] }), replayed: false } }));
  expect((await chadLeadPlanApi.step(scope, ID, 1, KEY, KEY, signal(), yes)).applied).toHaveLength(1);
  [url, init] = call(f);
  expect(url).toMatch(/\/chad\/lead-plan\/33333333-3333-4333-8333-333333333333\/steps\/1$/); expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe('chad.lead_plan.step');
  expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(KEY); expect(JSON.parse(init.body as string)).toEqual({ appointmentId: KEY });
  f = stub(json({ data: view({ status: 'DISMISSED', summary: null, suggestions: null }) }));
  await chadLeadPlanApi.dismiss(scope, ID, KEY, signal(), yes);
  [url, init] = call(f);
  expect(url).toMatch(/\/close$/); expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe('chad.lead_plan.close');
});

it('refuses bad input before anything is sent, and maps refusals to plain outcomes', async () => {
  const f = stub();
  await expect(chadLeadPlanApi.request(scope, { focus: 'ALL_OPEN', note: ' padded' }, KEY, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(chadLeadPlanApi.request(scope, { focus: 'HOT' as never, note: '' }, KEY, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(chadLeadPlanApi.step(scope, ID, 10, null, KEY, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(chadLeadPlanApi.step(scope, ID, 0, 'not-a-uuid', KEY, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  expect(f).not.toHaveBeenCalled();
  expect(chadLeadPlanErrorFor(403, 'CHAD_LEAD_PLAN_SPEND_STOPPED').kind).toBe('PAUSED');
  expect(chadLeadPlanErrorFor(403, 'CHAD_LEAD_PLAN_FORBIDDEN').kind).toBe('NO_ACCESS');
  expect(chadLeadPlanErrorFor(409, 'CHAD_LEAD_PLAN_NOT_OPEN').kind).toBe('GONE');
  expect(chadLeadPlanErrorFor(409, 'CHAD_LEAD_PLAN_NOT_DONE').kind).toBe('NOT_DONE');
  stub(json({ code: 'CHAD_LEAD_PLAN_FORBIDDEN' }, 403));
  await expect(chadLeadPlanApi.request(scope, { focus: 'ALL_OPEN', note: '' }, KEY, signal(), yes)).rejects.toBeInstanceOf(ChadLeadPlanError);
  expect(CHAD_LEAD_PLAN_NOTICE.NOT_DONE).toMatch(/Nothing was recorded/); expect(CHAD_LEAD_PLAN_NOTICE.STEP_CHANGED).toMatch(/Nothing changed/);
});

it('shows each suggestion with the lead name, the step it runs and the reason, with a step button and dismiss', () => {
  const html = renderToStaticMarkup(<ChadLeadPlanResult view={view()} working={null} busy={false} onStep={() => {}} onDismiss={() => {}} />);
  expect(html).toContain('Sample Lead'); expect(html).toContain('Move to Contacted'); expect(html).toContain('Asked for a call back.');
  expect(html).toContain('A lead'); expect(html).toContain('Book a trial: Kids basics');
  expect(html.match(/data-chad-step=/g)).toHaveLength(2); expect(html).toContain('data-chad-dismiss');
  const half = renderToStaticMarkup(<ChadLeadPlanResult view={view({ applied: [{ index: 0, action: 'MOVE_STAGE', leadId: LEAD, appointmentId: null }] })} working={null} busy={false} onStep={() => {}} onDismiss={() => {}} />);
  expect(half.match(/data-chad-step=/g)).toHaveLength(1); expect(half).toContain('data-chad-done="0"'); expect(half).toContain('Done with this list');
  const done = renderToStaticMarkup(<ChadLeadPlanResult view={view({ status: 'APPLIED', applied: [{ index: 0, action: 'MOVE_STAGE', leadId: LEAD, appointmentId: null }, { index: 1, action: 'BOOK_TRIAL', leadId: LEAD, appointmentId: KEY }] })} working={null} busy={false} onStep={() => {}} onDismiss={() => {}} />);
  expect(done).not.toContain('data-chad-step'); expect(done).toContain('href="/staff/crm/trials"'); expect(done).toContain('2 steps were done');
  expect(chadStepLabel(view(), { lead: 'L1', action: 'MOVE_STAGE', stage: 'S9', slot: null, reason: 'x' })).toBe('Move to the suggested stage');
});

it('starts by checking availability and never renders suggestions before the server answers', () => {
  const html = renderToStaticMarkup(<ChadLeadPlanPanel scope={scope} api={{ ...chadLeadPlanApi, list: () => new Promise(() => {}) }} />);
  expect(html).toContain('data-chad-lead-plan="CHECKING"'); expect(html).not.toContain('data-chad-ask'); expect(html).not.toContain('data-chad-result');
});
