import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MayaRenewalView } from '@hon/contracts';
import { MayaRenewalError, mayaRenewalApi, mayaRenewalErrorFor } from '../src/components/hon-command/maya-renewal-http';
import { MAYA_RENEWAL_NOTICE, MayaRenewalPanel, MayaRenewalResult } from '../src/components/hon-command/maya-renewal-panel';
import { HON_COMMAND_ROSTER } from '../src/components/hon-command/roster';

const ORG = '11111111-1111-4111-8111-111111111111', SCHOOL = '22222222-2222-4222-8222-222222222222', ID = '33333333-3333-4333-8333-333333333333', KEY = '44444444-4444-4444-8444-444444444444';
const MEMBER = '55555555-5555-4555-8555-555555555555';
const scope = { organizationId: ORG, schoolId: SCHOOL };
const view = (patch: Partial<MayaRenewalView> = {}): MayaRenewalView => ({ id: ID, status: 'RESULT_RECORDED', reason: null, brief: { window: 'NEXT_30_DAYS', note: '' },
  summary: 'Two renewals this month.', suggestions: [{ membership: 'M1', priority: 'HIGH', talkingPoint: 'Ask how the new class time works for them.', reason: 'Attendance halved.' },
    { membership: 'M2', priority: 'LOW', talkingPoint: 'Thank them for a strong year.', reason: 'Comes every week.' }],
  memberships: [{ ref: 'M1', membershipId: MEMBER, name: 'Sample Student', termEndsOn: '2026-12-01' }], applied: [], problems: [],
  createdAt: '2026-11-22T00:00:00.000Z', updatedAt: '2026-11-22T00:00:00.000Z', ...patch });
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const call = (f: ReturnType<typeof stub>, n = 0) => f.mock.calls[n] as unknown as [string, RequestInit];
const signal = () => new AbortController().signal;
const yes = () => true;
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('marks Maya renewal prep and check-in sending available with nothing backend required', () => {
  const maya = HON_COMMAND_ROSTER.find((a) => a.id === 'maya')!;
  expect(maya.capabilities.find((c) => /Renewal prep/.test(c.label))?.state).toBe('AVAILABLE');
  expect(maya.capabilities.filter((c) => c.state === 'BACKEND_REQUIRED').map((c) => c.label)).toEqual([]);
});

it('lists with a plain GET and asks, applies and dismisses with their own human command and key', async () => {
  let f = stub(json({ data: { aiAvailable: true, renewalPreps: [view()] } }));
  expect((await mayaRenewalApi.list(scope, signal(), yes)).renewalPreps).toHaveLength(1);
  let [url, init] = call(f);
  expect(url).toBe(`/api/v1/organizations/${ORG}/schools/${SCHOOL}/maya/renewal-prep`); expect(init.method).toBe('GET');
  expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBeUndefined();
  f = stub(json({ data: view() }));
  await mayaRenewalApi.request(scope, { window: 'NEXT_60_DAYS', note: 'Summer break' }, KEY, signal(), yes);
  [url, init] = call(f);
  expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe('maya.renewal_prep.request'); expect(JSON.parse(init.body as string)).toEqual({ window: 'NEXT_60_DAYS', note: 'Summer break' });
  f = stub(json({ data: { renewalPrep: view({ status: 'APPLIED', applied: [{ index: 0, renewalId: KEY }] }), replayed: false } }));
  expect((await mayaRenewalApi.apply(scope, ID, [0], KEY, signal(), yes)).applied).toHaveLength(1);
  [url, init] = call(f);
  expect(url).toMatch(/\/maya\/renewal-prep\/33333333-3333-4333-8333-333333333333\/apply$/); expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe('maya.renewal_prep.apply');
  expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(KEY); expect(JSON.parse(init.body as string)).toEqual({ suggestions: [0] });
  f = stub(json({ data: view({ status: 'DISMISSED', summary: null, suggestions: null }) }));
  await mayaRenewalApi.dismiss(scope, ID, KEY, signal(), yes);
  [url, init] = call(f);
  expect(url).toMatch(/\/close$/); expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe('maya.renewal_prep.close');
});

it('refuses bad input before anything is sent, and maps refusals to plain outcomes', async () => {
  const f = stub();
  await expect(mayaRenewalApi.request(scope, { window: 'NEXT_30_DAYS', note: ' padded' }, KEY, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(mayaRenewalApi.request(scope, { window: 'NEXT_90_DAYS' as never, note: '' }, KEY, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(mayaRenewalApi.apply(scope, ID, [10], KEY, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  expect(f).not.toHaveBeenCalled();
  expect(mayaRenewalErrorFor(403, 'MAYA_RENEWAL_SPEND_STOPPED').kind).toBe('PAUSED');
  expect(mayaRenewalErrorFor(403, 'MAYA_RENEWAL_FORBIDDEN').kind).toBe('NO_ACCESS');
  expect(mayaRenewalErrorFor(409, 'MAYA_RENEWAL_NOT_OPEN').kind).toBe('GONE');
  expect(mayaRenewalErrorFor(409, 'MAYA_RENEWAL_MEMBERSHIP_CHANGED').kind).toBe('CHANGED');
  expect(mayaRenewalErrorFor(409, 'MAYA_RENEWAL_REVIEW_OPEN').kind).toBe('REVIEW_OPEN');
  stub(json({ code: 'MAYA_RENEWAL_FORBIDDEN' }, 403));
  await expect(mayaRenewalApi.request(scope, { window: 'NEXT_30_DAYS', note: '' }, KEY, signal(), yes)).rejects.toBeInstanceOf(MayaRenewalError);
  expect(MAYA_RENEWAL_NOTICE.CHANGED).toMatch(/Nothing was applied/); expect(MAYA_RENEWAL_NOTICE.REVIEW_OPEN).toMatch(/Nothing was applied/);
});

it('shows each suggestion with the member name, priority, term end and talking point, with tick boxes, open and dismiss', () => {
  const html = renderToStaticMarkup(<MayaRenewalResult view={view()} ticked={[0]} busy={false} onTick={() => {}} onApply={() => {}} onDismiss={() => {}} />);
  expect(html).toContain('Sample Student'); expect(html).toContain('High priority · term ends 2026-12-01'); expect(html).toContain('Ask how the new class time works for them.');
  expect(html).toContain('A member'); expect(html.match(/data-maya-tick=/g)).toHaveLength(2); expect(html).toContain('Open 1 review'); expect(html).toContain('data-maya-dismiss');
  const done = renderToStaticMarkup(<MayaRenewalResult view={view({ status: 'APPLIED', applied: [{ index: 0, renewalId: KEY }] })} ticked={[]} busy={false} onTick={() => {}} onApply={() => {}} onDismiss={() => {}} />);
  expect(done).not.toContain('data-maya-tick'); expect(done).toContain('href="/staff/billing/renewals"'); expect(done).toContain('1 renewal review was opened');
});

it('starts by checking availability and never renders suggestions before the server answers', () => {
  const html = renderToStaticMarkup(<MayaRenewalPanel scope={scope} api={{ ...mayaRenewalApi, list: () => new Promise(() => {}) }} />);
  expect(html).toContain('data-maya-renewal="CHECKING"'); expect(html).not.toContain('data-maya-ask'); expect(html).not.toContain('data-maya-result');
});
