import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MayaCheckInView } from '@hon/contracts';
import { MayaCheckInError, mayaCheckInApi, mayaCheckInErrorFor } from '../src/components/hon-command/maya-check-in-http';
import { MAYA_CHECK_IN_NOTICE, MayaCheckIn, isApprovalPhrase, mayaCheckInSummary } from '../src/components/maya-at-risk/maya-check-in';
import { HON_COMMAND_ROSTER } from '../src/components/hon-command/roster';

const ORG = '11111111-1111-4111-8111-111111111111', SCHOOL = '22222222-2222-4222-8222-222222222222', ID = '33333333-3333-4333-8333-333333333333', KEY = '44444444-4444-4444-8444-444444444444';
const MEMBER = '55555555-5555-4555-8555-555555555555';
const scope = { organizationId: ORG, schoolId: SCHOOL };
const T = '2026-11-22T00:00:00.000Z';
const view = (patch: Partial<MayaCheckInView> = {}): MayaCheckInView => ({ id: ID, status: 'RESULT_RECORDED', reason: null, brief: { membershipId: MEMBER, channel: 'SMS', note: '' },
  studentName: 'Sample Student', level: 'HIGH', summary: 'Attendance dropped after the class time moved.', message: 'Hi [First name], we miss you on the mat. Is the new time working?', subject: '',
  recipients: [{ recipient: 'STUDENT', name: 'Sample Student', reachable: true }, { recipient: 'BILLING_CONTACT', name: 'Sample Parent', reachable: false }],
  send: null, problems: [], createdAt: T, updatedAt: T, ...patch });
const sent = (patch: Partial<NonNullable<MayaCheckInView['send']>> = {}): MayaCheckInView => view({ status: 'APPLIED', send: { recipient: 'STUDENT', channel: 'SMS',
  scheduledAt: T, approvedAt: T, approvalMethod: 'VOICE', edited: false, cancelled: false, delivery: null, ...patch } });
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async (_url: string, _init?: RequestInit) => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const call = (f: ReturnType<typeof stub>, n = 0) => f.mock.calls[n] as unknown as [string, RequestInit];
const signal = () => new AbortController().signal;
const yes = () => true;
const approval = { recipient: 'STUDENT' as const, message: 'Hi [First name], we miss you.', subject: '', sendAt: null, approvalMethod: 'BUTTON' as const, voiceTurnId: null };
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('marks sending a check-in available for Maya', () => {
  const maya = HON_COMMAND_ROSTER.find((a) => a.id === 'maya')!;
  expect(maya.capabilities.find((c) => /Check-in draft/.test(c.label))?.state).toBe('AVAILABLE');
});

it('asks, approves, cancels and dismisses each with its own human command and key', async () => {
  const base = `/api/v1/organizations/${ORG}/schools/${SCHOOL}/maya/check-ins`;
  let f = stub(json({ data: { aiAvailable: true, checkIns: [view()] } }));
  expect((await mayaCheckInApi.list(scope, signal(), yes)).checkIns).toHaveLength(1);
  expect(call(f)[0]).toBe(base); expect(call(f)[1].method).toBe('GET');
  f = stub(json({ data: view() }));
  await mayaCheckInApi.request(scope, { membershipId: MEMBER, channel: 'SMS', note: '' }, KEY, signal(), yes);
  let [url, init] = call(f);
  expect(url).toBe(base); expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe('maya.check_in.request');
  expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(KEY);
  f = stub(json({ data: { checkIn: sent(), replayed: false } }));
  expect((await mayaCheckInApi.approve(scope, ID, 'SMS', approval, KEY, signal(), yes)).status).toBe('APPLIED');
  [url, init] = call(f);
  expect(url).toBe(`${base}/${ID}/approve`); expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe('maya.check_in.approve');
  expect(JSON.parse(init.body as string)).toEqual(approval);
  f = stub(json({ data: sent({ cancelled: true }) }));
  await mayaCheckInApi.cancel(scope, ID, KEY, signal(), yes);
  [url, init] = call(f); expect(url).toBe(`${base}/${ID}/cancel`); expect(JSON.parse(init.body as string)).toEqual({});
  f = stub(json({ data: view({ status: 'DISMISSED', summary: null, message: null, subject: null }) }));
  await mayaCheckInApi.dismiss(scope, ID, KEY, signal(), yes);
  [url, init] = call(f); expect(url).toBe(`${base}/${ID}/close`); expect(JSON.parse(init.body as string)).toEqual({ status: 'DISMISSED' });
});

it('refuses a bad approval before any request', async () => {
  const f = stub();
  await expect(mayaCheckInApi.approve(scope, ID, 'SMS', { ...approval, message: 'See https://example.test' }, KEY, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(mayaCheckInApi.approve(scope, ID, 'SMS', { ...approval, approvalMethod: 'VOICE' }, KEY, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  expect(f).not.toHaveBeenCalled();
});

it('maps the server refusals to plain notices', () => {
  const kind = (s: number, c: string | null) => mayaCheckInErrorFor(s, c).kind;
  expect(kind(409, 'MAYA_CHECK_IN_NO_CONSENT')).toBe('NO_CONSENT');
  expect(kind(409, 'MAYA_CHECK_IN_NO_ADDRESS')).toBe('NO_ADDRESS');
  expect(kind(409, 'MAYA_CHECK_IN_DAILY_CAP')).toBe('DAILY_CAP');
  expect(kind(409, 'MAYA_CHECK_IN_NOT_CANCELLABLE')).toBe('NOT_CANCELLABLE');
  expect(kind(404, 'MAYA_CHECK_IN_NOT_AT_RISK')).toBe('NOT_AT_RISK');
  expect(kind(403, 'MAYA_CHECK_IN_SPEND_STOPPED')).toBe('PAUSED');
  expect(kind(500, null)).toBe('UNKNOWN');
  expect(new MayaCheckInError('GONE')).toBeInstanceOf(Error);
  for (const k of Object.keys(MAYA_CHECK_IN_NOTICE)) expect(MAYA_CHECK_IN_NOTICE[k as keyof typeof MAYA_CHECK_IN_NOTICE].length).toBeGreaterThan(10);
});

it('approves by voice only on a short approval phrase', () => {
  for (const s of ['approve', 'Approve.', 'send it', 'Yes, send it!', '  approve   and send ']) expect(isApprovalPhrase(s)).toBe(true);
  for (const s of ['do not approve', 'approve it later', 'send it to everyone', 'yes', '']) expect(isApprovalPhrase(s)).toBe(false);
});

it('says how and when an approved draft goes out', () => {
  expect(mayaCheckInSummary(sent())).toMatch(/^Approved by voice at .+\. The text is queued for /);
  expect(mayaCheckInSummary(sent({ approvalMethod: 'BUTTON', delivery: 'DELIVERED', channel: 'EMAIL' }))).toMatch(/with the button.+The email is delivered\./);
  expect(mayaCheckInSummary(sent({ cancelled: true }))).toBe('Approved by voice. The text was cancelled before it went out.');
  expect(mayaCheckInSummary(view())).toBe('');
});

it('starts with the ask form and promises nothing is sent until approval', () => {
  const html = renderToStaticMarkup(<MayaCheckIn school={scope} membershipId={MEMBER} givenName="Sample" recognition={null} />);
  expect(html).toContain('data-maya-check-in="IDLE"');
  expect(html).toContain('Draft a check-in with Maya');
  expect(html).toContain('Nothing is sent until you approve it.');
  expect(html).not.toContain('data-maya-check-in-approve');
});
