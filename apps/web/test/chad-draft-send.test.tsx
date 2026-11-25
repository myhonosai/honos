import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { CHAD_SEND_ERROR, ChadSendError, chadSendApi, sendAtFromLocal, verifyChadSendView, type ChadSendView } from '../src/components/chad-draft-send-http';
import { CHAD_SEND_COPY, ChadDraftSendPlan, chadSendSummary } from '../src/components/chad-draft-send-plan';
import { HON_COMMAND_ROSTER } from '../src/components/hon-command/roster';

const ID = '33333333-3333-4333-8333-333333333333', WHO = '44444444-4444-4444-8444-444444444444', MSG = '55555555-5555-4555-8555-555555555555';
const at = '2026-11-24T17:00:00.000Z';
const sent = (patch = {}) => ({ outcome: 'QUEUED', messageId: MSG, channel: 'EMAIL', scheduledAt: at, approvedBy: WHO, approvedAt: '2026-11-22T09:00:00.000Z', approvalMethod: 'BUTTON', cancelled: false, delivery: null, ...patch });
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('marks Chad sending and lead next steps available with nothing backend required', () => {
  const chad = HON_COMMAND_ROSTER.find((a) => a.id === 'chad')!;
  expect(chad.capabilities.find((c) => /approved follow-up/.test(c.label))?.state).toBe('AVAILABLE');
  expect(chad.capabilities.filter((c) => c.state === 'BACKEND_REQUIRED').map((c) => c.label)).toEqual([]);
});

it('verifies the send view strictly', () => {
  expect(verifyChadSendView({ invocationId: ID, plan: { version: 1, channel: 'EMAIL', sendAt: at }, send: null }, ID).plan?.channel).toBe('EMAIL');
  expect(verifyChadSendView({ invocationId: ID, plan: { version: 1, channel: 'EMAIL', sendAt: null }, send: sent() }, ID).send?.outcome).toBe('QUEUED');
  for (const bad of [{ invocationId: WHO, plan: null, send: null }, { invocationId: ID, plan: { version: 1, channel: 'FAX', sendAt: null }, send: null },
    { invocationId: ID, plan: null, send: sent({ approvalMethod: 'PHONE' }) }, { invocationId: ID, plan: null, send: sent({ scheduledAt: 'soon' }) }]) {
    expect(() => verifyChadSendView(bad, ID)).toThrow();
  }
});

it('says in one line what will happen or what happened', () => {
  const v = (plan: ChadSendView['plan'], send: unknown = null) => ({ invocationId: ID, plan, send } as ChadSendView);
  expect(chadSendSummary(v(null))).toBe(CHAD_SEND_COPY.noPlan);
  expect(chadSendSummary(v({ version: 2, channel: 'NONE', sendAt: null }))).toBe(CHAD_SEND_COPY.noPlan);
  expect(chadSendSummary(v({ version: 1, channel: 'SMS', sendAt: null }))).toBe('Once approved, this goes out as a text message right away.');
  expect(chadSendSummary(v({ version: 1, channel: 'EMAIL', sendAt: at }))).toMatch(/^Once approved, this goes out as an email on /);
  expect(chadSendSummary(v(null, sent({ approvalMethod: 'VOICE' })))).toMatch(/^Approved by voice at .*Email: Queued for /);
  expect(chadSendSummary(v(null, sent({ delivery: 'SUPPRESSED' })))).toMatch(/Not sent \(no consent or address at send time\)/);
  expect(chadSendSummary(v(null, sent({ cancelled: true })))).toMatch(/was cancelled before it went out/);
  expect(chadSendSummary(v(null, sent({ outcome: 'DAILY_CAP', messageId: null })))).toBe(CHAD_SEND_COPY.outcome.DAILY_CAP);
});

it('posts the plan with the fixed command header and a retained key, and maps refusals to plain words', async () => {
  const f = vi.fn(async () => json({ data: { invocationId: ID, plan: { version: 1, channel: 'EMAIL', sendAt: null }, send: null } }));
  vi.stubGlobal('fetch', f);
  await chadSendApi.setPlan(ID, { channel: 'EMAIL', sendAt: null }, 'plan-key');
  const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(`/api/v1/staff/leads/assistant/${ID}/send-plan`);
  expect(init.method).toBe('POST'); expect(init.credentials).toBe('same-origin');
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'chad-follow-up-assistant', 'Idempotency-Key': 'plan-key' });
  expect(JSON.parse(String(init.body))).toEqual({ channel: 'EMAIL', sendAt: null });
  vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'CHAD_SEND_PLAN_NO_CONSENT' }, 409)));
  await expect(chadSendApi.setPlan(ID, { channel: 'SMS', sendAt: null }, 'k2')).rejects.toEqual(new ChadSendError(CHAD_SEND_ERROR.CHAD_SEND_PLAN_NO_CONSENT!, 409, 'CHAD_SEND_PLAN_NO_CONSENT'));
  await expect(chadSendApi.read('not-an-id')).rejects.toThrow();
});

it('turns a picked local time into the exact UTC string the server accepts', () => {
  const iso = sendAtFromLocal('2026-11-24T09:30');
  expect(iso).toMatch(/^2026-11-2[45]T\d{2}:30:00\.000Z$/);
  expect(sendAtFromLocal('tomorrow')).toBeNull();
});

it('renders nothing for a draft that is not awaiting approval or approved', () => {
  const api = { read: vi.fn(async () => ({ invocationId: ID, plan: null, send: null })), setPlan: vi.fn(), cancel: vi.fn() };
  expect(renderToStaticMarkup(<ChadDraftSendPlan invocationId={ID} status="REJECTED" api={api} />)).toBe('');
  const html = renderToStaticMarkup(<ChadDraftSendPlan invocationId={ID} status="AWAITING_APPROVAL" api={api} />);
  expect(html).toContain('Send once approved');
  expect(html).toContain(CHAD_SEND_COPY.intro);
  expect(html).toContain('Don’t send. Approval only records the decision.');
  expect(renderToStaticMarkup(<ChadDraftSendPlan invocationId={ID} status="AWAITING_APPROVAL" mine={false} api={api} />)).not.toContain(CHAD_SEND_COPY.intro);
});

it('binds an approval to the send plan version it saw and reads the plan on the approvals route', async () => {
  const { validateHumanActionDecision } = await import('@hon/contracts');
  const binding = { actionRequestId: ID, actionCode: 'crm.follow_up_draft.propose', requestedByPrincipalId: WHO, payloadHash: 'a'.repeat(64), policyVersion: 1, approvalExpiresAt: at, effectiveAuthorityMode: 'CONFIRM' as const };
  for (const sendPlanVersion of [null, 1, 1000]) expect(() => validateHumanActionDecision({ decision: 'APPROVED', binding, sendPlanVersion })).not.toThrow();
  for (const sendPlanVersion of [0, 1001, 1.5, '1']) expect(() => validateHumanActionDecision({ decision: 'APPROVED', binding, sendPlanVersion })).toThrow();
  const { readChadSendForReview } = await import('../src/components/action-approvals-http');
  const fetchMock = vi.fn(async (_url: string) => json({ data: { invocationId: MSG, plan: { version: 2, channel: 'SMS', sendAt: null }, send: null } }));
  vi.stubGlobal('fetch', fetchMock);
  const school = '66666666-6666-4666-8666-666666666666';
  expect((await readChadSendForReview(school, ID, MSG)).plan?.version).toBe(2);
  expect(fetchMock.mock.calls[0]![0]).toBe(`/api/v1/staff/action-center/approvals/${school}/${ID}/chad-send`);
  await expect(readChadSendForReview(school, ID, WHO)).rejects.toThrow();
  expect(CHAD_SEND_COPY.readFailed).toMatch(/cannot be approved here yet/);
});
