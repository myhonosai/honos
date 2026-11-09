import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CHANGE_LANGUAGES, changeText } from '../src/components/membership-changes/copy';
import { ChangeError, addDays, changeErrorFor, keepForRetry, membershipChangesApi, toMinor } from '../src/components/membership-changes/http';
import { changeBody } from '../src/components/membership-changes/membership-changes';
import { MembershipChangesView, type MembershipChangesViewProps } from '../src/components/membership-changes/view';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { id } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), member = id(30), key = id(77), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5), correlationId: id(5) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ChangeError; } throw new Error('expected a failure'); };
const policy = (over: Record<string, unknown> = {}) => ({ version: 3, pausesAllowed: true, maxPauseDays: 60, maxPausedDaysPerYear: 90, holdFee: { amountMinor: 1500, currency: 'USD' },
  createdAt: '2026-11-01T10:00:00.000Z', ...over });
const pauseRow = (over: Record<string, unknown> = {}) => ({ pauseId: id(40), membershipId: member, policyVersion: 3, startsOn: '2026-11-09', plannedResumeOn: '2026-12-09',
  pauseReason: 'Travel', holdFee: { amountMinor: 1500, currency: 'USD' }, pausedAt: '2026-11-09T10:00:00.000Z', endedKind: null, endedOn: null, endReason: null, endedAt: null, ...over });
const refundRow = (over: Record<string, unknown> = {}) => ({ refundId: id(60), membershipId: member, amountMinor: 4999, currency: 'USD', refundedOn: '2026-11-09', method: 'CASH',
  reason: 'Unused month', recordedAt: '2026-11-09T11:00:00.000Z', ...over });
const historyRaw = (over: Record<string, unknown> = {}) => ({ membershipId: member, state: 'ACTIVE', version: 4, localToday: '2026-11-09', pauses: [], refunds: [], ...over });
const listItem = { membershipId: member, state: 'ACTIVE', version: 4, planCode: 'ADULT-MONTHLY', billingAccountId: id(31), participant: { personId: id(32), givenName: 'Sam', familyName: 'Lee' },
  effectiveStatus: 'IN_EFFECT', datesConfirmed: true, currentPeriod: { periodVersion: 1, changeKind: 'ACTIVATION', startDate: '2026-10-01', endDate: null }, legacyStoredTerm: null,
  createdAt: '2026-10-01T10:00:00.000Z' } as const;

it('reads rules and history as plain same-origin GETs with no query, no key and no x-hon header', async () => {
  const f = stub(json({ data: { policy: policy(), localToday: '2026-11-09' }, meta }));
  const read = await membershipChangesApi.policy({ organizationId: org.toUpperCase(), schoolId: school }, signal(), () => true);
  expect(read.policy?.maxPauseDays).toBe(60);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/billing/membership-pause-policy`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  const g = stub(json({ data: historyRaw({ state: 'FROZEN', version: 5, pauses: [pauseRow()] }), meta }));
  await expect(membershipChangesApi.history(scope, member, signal(), () => true)).resolves.toMatchObject({ state: 'FROZEN', pauses: [{ pauseReason: 'Travel' }] });
  expect((g.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/billing/memberships/${member}/pauses-and-refunds`);
});

it('refuses another membership, an open pause on an ACTIVE membership and drifted shapes', async () => {
  stub(json({ data: historyRaw({ membershipId: id(33) }), meta }));
  expect((await fails(membershipChangesApi.history(scope, member, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: historyRaw({ pauses: [pauseRow()] }), meta }));
  expect((await fails(membershipChangesApi.history(scope, member, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: historyRaw({ extra: 1 }), meta }));
  expect((await fails(membershipChangesApi.history(scope, member, signal(), () => true))).kind).toBe('UNKNOWN');
  await expect(fails(membershipChangesApi.history(scope, 'nope', signal(), () => true))).resolves.toMatchObject({ kind: 'INVALID' });
});

it('sends each command with its own human-command header and the idempotency key, and verifies the receipt', async () => {
  const cases = [
    ['pause', () => membershipChangesApi.pause(scope, member, { expectedVersion: 4, resumeOn: '2026-12-09', pauseReason: 'Travel' }, key, signal(), () => true),
      'pause', 'billing.membership.pause', { ...pauseRow(), membershipState: 'FROZEN', membershipVersion: 5 }],
    ['resume', () => membershipChangesApi.resume(scope, member, { expectedVersion: 5 }, key, signal(), () => true), 'resume', 'billing.membership.resume',
      { ...pauseRow({ endedKind: 'RESUMED', endedOn: '2026-11-20', endedAt: '2026-11-20T10:00:00.000Z' }), membershipState: 'ACTIVE', membershipVersion: 6 }],
    ['cancel', () => membershipChangesApi.cancel(scope, member, { expectedVersion: 4, cancellationReason: '  Moving away ' }, key, signal(), () => true), 'cancel', 'billing.membership.cancel',
      { id: member, billingAccountId: id(31), participantPersonId: id(32), planCode: 'ADULT-MONTHLY', state: 'CANCELLED', version: 5, cancellationReason: 'Moving away', createdAt: '2026-10-01T10:00:00.000Z' }],
    ['refund', () => membershipChangesApi.recordRefund(scope, member, { amountMinor: 4999, currency: 'USD', refundedOn: '2026-11-09', method: 'CASH', reason: 'Unused month' }, key, signal(), () => true),
      'refund-records', 'billing.membership.refund.record', refundRow()],
  ] as const;
  for (const [, run, tail, command, receipt] of cases) {
    const f = stub(json({ data: receipt, meta: { ...meta, replayed: false } }));
    await run();
    const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/billing/memberships/${member}/${tail}`);
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': command, 'Idempotency-Key': key } });
    expect(Object.keys(init.headers as object).filter(k => /^x-hon/i.test(k))).toEqual(['X-HON-Human-Command']);
  }
  expect(JSON.parse((vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ amountMinor: 4999, currency: 'USD', refundedOn: '2026-11-09', method: 'CASH', reason: 'Unused month' });
  const p = stub(json({ data: policy({ version: 4 }), meta }));
  await membershipChangesApi.setPolicy(scope, { expectedVersion: 3, pausesAllowed: true, maxPauseDays: 60, maxPausedDaysPerYear: 90, holdFee: null }, key, signal(), () => true);
  expect((p.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'X-HON-Human-Command': 'billing.membership.pause_policy.set' });
  // A receipt for a different state or membership is not success.
  stub(json({ data: { ...pauseRow(), membershipState: 'ACTIVE', membershipVersion: 5 }, meta }));
  expect((await fails(membershipChangesApi.pause(scope, member, { expectedVersion: 4, resumeOn: '2026-12-09', pauseReason: 'Travel' }, key, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: { id: id(33), state: 'CANCELLED', version: 5 }, meta }));
  expect((await fails(membershipChangesApi.cancel(scope, member, { expectedVersion: 4, cancellationReason: 'x' }, key, signal(), () => true))).kind).toBe('UNKNOWN');
});

it('refuses bad input locally without sending anything', async () => {
  const f = stub(json({}));
  for (const run of [
    () => membershipChangesApi.pause(scope, member, { expectedVersion: 4, resumeOn: '2026-02-30', pauseReason: 'x' }, key, signal(), () => true),
    () => membershipChangesApi.pause(scope, member, { expectedVersion: 4, resumeOn: '2026-12-09', pauseReason: '' }, key, signal(), () => true),
    () => membershipChangesApi.cancel(scope, member, { expectedVersion: 4, cancellationReason: '   ' }, key, signal(), () => true),
    () => membershipChangesApi.recordRefund(scope, member, { amountMinor: 0, currency: 'USD', refundedOn: '2026-11-09', method: 'CASH', reason: 'x' }, key, signal(), () => true),
    () => membershipChangesApi.setPolicy(scope, { expectedVersion: 0, pausesAllowed: true, maxPauseDays: 100, maxPausedDaysPerYear: 90, holdFee: null }, key, signal(), () => true),
    () => membershipChangesApi.resume(scope, member, { expectedVersion: 5 }, 'not-a-key', signal(), () => true),
  ]) expect((await fails(run())).kind).toBe('INVALID');
  expect(f).not.toHaveBeenCalled();
});

it('maps every refusal, keeps only unknown outcomes and rate limits for Try again, and ends the session only for the current call', async () => {
  expect(changeErrorFor(403, null).kind).toBe('DENIED');
  expect(changeErrorFor(404, 'BILLING_MEMBERSHIP_NOT_FOUND').kind).toBe('GONE');
  expect(changeErrorFor(409, 'VERSION_CONFLICT').kind).toBe('CHANGED');
  for (const code of ['MEMBERSHIP_NOT_ACTIVE', 'MEMBERSHIP_NOT_PAUSED', 'MEMBERSHIP_NOT_CANCELLED']) expect(changeErrorFor(409, code).kind).toBe('STATE');
  expect(changeErrorFor(409, 'MEMBERSHIP_PAUSE_NOT_OFFERED').kind).toBe('NOT_OFFERED');
  expect(changeErrorFor(422, 'MEMBERSHIP_PAUSE_TOO_LONG').kind).toBe('TOO_LONG');
  expect(changeErrorFor(422, 'MEMBERSHIP_PAUSE_YEARLY_LIMIT').kind).toBe('YEARLY');
  expect(changeErrorFor(409, 'MEMBERSHIP_PAUSE_REQUIRES_BILLING_ARRANGEMENT').kind).toBe('SCHEDULE');
  expect(changeErrorFor(409, 'MEMBERSHIP_PAUSE_EVIDENCE_MISSING').kind).toBe('LEGACY');
  expect(changeErrorFor(409, 'MEMBERSHIP_LIFECYCLE_CONFLICT').kind).toBe('UNKNOWN');
  expect(changeErrorFor(409, 'IDEMPOTENCY_IN_PROGRESS').kind).toBe('UNKNOWN');
  expect(changeErrorFor(503, null).kind).toBe('UNKNOWN');
  expect(changeErrorFor(429, null).kind).toBe('RATE');
  expect([new ChangeError('UNKNOWN'), new ChangeError('RATE'), new Error('network')].every(keepForRetry)).toBe(true);
  expect(['DENIED', 'GONE', 'CHANGED', 'STATE', 'INVALID', 'TOO_LONG', 'SESSION'].some(k => keepForRetry(new ChangeError(k as never)))).toBe(false);
  const ended = vi.fn(); window.addEventListener(HON_SESSION_INVALIDATED_EVENT, ended);
  stub(json({}, 401));
  expect((await fails(membershipChangesApi.history(scope, member, signal(), () => false))).kind).toBe('SESSION');
  expect(ended).not.toHaveBeenCalled();
  stub(json({}, 401));
  expect((await fails(membershipChangesApi.history(scope, member, signal(), () => true))).kind).toBe('SESSION');
  expect(ended).toHaveBeenCalledTimes(1);
});

it('builds request bodies from the form: minor units per currency, school-local dates, optional resume note', () => {
  expect(toMinor('49.99', 'USD')).toBe(4999); expect(toMinor('12', 'USD')).toBe(1200); expect(toMinor('5000', 'KRW')).toBe(5000);
  expect(toMinor('1.234', 'USD')).toBeNull(); expect(toMinor('0', 'USD')).toBeNull(); expect(toMinor('1.5', 'KRW')).toBeNull(); expect(toMinor('-1', 'USD')).toBeNull();
  expect(addDays('2026-12-31', 1)).toBe('2027-01-01'); expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  const p = policy() as never;
  expect(changeBody('pause', { resumeOn: '2026-12-09', pauseReason: ' Travel ' }, 4, p)).toEqual({ expectedVersion: 4, resumeOn: '2026-12-09', pauseReason: 'Travel' });
  expect(changeBody('resume', { resumeReason: '  ' }, 5, p)).toEqual({ expectedVersion: 5 });
  expect(changeBody('resume', { resumeReason: 'Back' }, 5, p)).toEqual({ expectedVersion: 5, resumeReason: 'Back' });
  expect(changeBody('refund', { amount: '49.99', currency: 'usd', refundedOn: '2026-11-09', method: 'CHECK', reason: 'Unused' }, 5, p))
    .toEqual({ amountMinor: 4999, currency: 'USD', refundedOn: '2026-11-09', method: 'CHECK', reason: 'Unused' });
  expect(changeBody('policy', { allowed: 'on', max: '30', year: '60', fee: 'on', feeAmount: '10', feeCurrency: 'usd' }, 0, p))
    .toEqual({ expectedVersion: 3, pausesAllowed: true, maxPauseDays: 30, maxPausedDaysPerYear: 60, holdFee: { amountMinor: 1000, currency: 'USD' } });
  expect(changeBody('policy', { max: '30', year: '60', fee: 'on', feeAmount: '10' }, 0, null))
    .toEqual({ expectedVersion: 0, pausesAllowed: false, maxPauseDays: null, maxPausedDaysPerYear: null, holdFee: null });
  for (const [action, fields] of [['policy', { allowed: 'on', max: '', year: '60' }], ['refund', { amount: 'ten', currency: 'USD', refundedOn: '2026-11-09', method: 'CASH', reason: 'x' }],
    ['refund', { amount: '10', currency: 'USD', refundedOn: '2026-11-09', method: 'PAYPAL', reason: 'x' }], ['cancel', { cancellationReason: '' }]] as const) {
    expect(() => changeBody(action, fields, 4, p)).toThrow();
  }
});

const base = (over: Partial<MembershipChangesViewProps> = {}): MembershipChangesViewProps => ({ language: 'en', waiting: false, concealed: false, hasSchool: true,
  policy: { state: 'READY', read: { policy: policy() as never, localToday: '2026-11-09' } },
  list: { state: 'READY', filter: 'ACTIVE', items: [listItem as never], nextCursor: null, more: 'IDLE' }, filter: 'ACTIVE', selected: member, selectedLabel: 'Sam Lee — ADULT-MONTHLY',
  history: { state: 'READY', view: historyRaw() as never }, form: null, outcome: null, locked: false, canRetry: false, ...over });
const html = (over: Partial<MembershipChangesViewProps> = {}) => renderToStaticMarkup(<MembershipChangesView {...base(over)}/>);

it('shows the school rules, the chosen membership and only the actions its state allows', () => {
  const active = html();
  expect(active).toContain('Up to 60 days per pause, and 90 paused days in any 365 days.');
  expect(active).toContain('$15.00 (recorded only, never charged)');
  expect(active).toContain('Sam Lee — ADULT-MONTHLY');
  expect(active).toContain('Pause membership'); expect(active).toContain('Cancel membership'); expect(active).not.toContain('Resume now'); expect(active).not.toContain('Record a refund');
  expect(active).toContain('Nothing here charges, refunds or moves money.');
  const off = html({ policy: { state: 'READY', read: { policy: null, localToday: '2026-11-09' } } });
  expect(off).not.toContain('>Pause membership<'); expect(off).toContain('Pauses are not offered at this school');
  const frozen = html({ history: { state: 'READY', view: historyRaw({ state: 'FROZEN', version: 5, localToday: '2026-12-10', pauses: [pauseRow()] }) as never } });
  expect(frozen).toContain('Resume now'); expect(frozen).toContain('Cancel membership'); expect(frozen).toContain('Planned resume date has passed');
  const legacy = html({ history: { state: 'READY', view: historyRaw({ state: 'FROZEN', version: 5 }) as never } });
  expect(legacy).not.toContain('Resume now'); expect(legacy).not.toContain('>Cancel membership<'); expect(legacy).toContain('paused before HON kept pause records');
  const cancelled = html({ history: { state: 'READY', view: historyRaw({ state: 'CANCELLED', version: 5, refunds: [refundRow()] }) as never } });
  expect(cancelled).toContain('Record a refund'); expect(cancelled).toContain('$49.99 on Nov 9, 2026 by Cash'); expect(cancelled).not.toContain('Pause membership');
  expect(html({ history: { state: 'READY', view: historyRaw({ state: 'EXPIRED' }) as never } })).toContain('There is nothing to change here for this membership (Expired).');
});

it('bounds the pause date by the school day and the longest pause, and the refund date by today', () => {
  const pause = html({ form: 'pause' });
  expect(pause).toContain('min="2026-11-10"'); expect(pause).toContain('max="2027-01-08"');
  const refund = html({ form: 'refund', history: { state: 'READY', view: historyRaw({ state: 'CANCELLED', version: 5 }) as never } });
  expect(refund).toContain('max="2026-11-09"'); for (const m of ['Cash', 'Check', 'Card terminal', 'Bank transfer', 'Other']) expect(refund).toContain(m);
  expect(html({ form: 'cancel' })).toContain('It does not refund anything.');
  expect(html({ form: 'policy' })).toContain('Save pause rules');
});

it('shows nothing private before the school is verified, while hidden, or when access is refused', () => {
  for (const over of [{ waiting: true }, { concealed: true }, { hasSchool: false }] as const) {
    const out = html(over);
    expect(out).not.toContain('Sam Lee'); expect(out).not.toContain('Up to 60 days');
  }
  expect(html({ history: { state: 'DENIED' } })).toContain('cannot see this membership');
  expect(html({ policy: { state: 'DENIED' } })).toContain('cannot see this school');
  expect(html({ outcome: { kind: 'UNKNOWN', action: 'cancel' }, canRetry: true, locked: true })).toContain('Try again');
  expect(html({ outcome: { kind: 'CHANGED', action: 'pause' } })).not.toContain('Try again');
});

it('has every wording in English, Korean and Spanish, and a staff billing route', () => {
  const keys = Object.keys(CHANGE_LANGUAGES.en).sort();
  expect(Object.keys(CHANGE_LANGUAGES.ko).sort()).toEqual(keys); expect(Object.keys(CHANGE_LANGUAGES.es).sort()).toEqual(keys);
  expect(changeText('ko', 'title')).toBe('일시정지·취소·환불');
  const billing = SCHOOL_SHELL_NAV.find(g => g.key === 'billing');
  expect(billing?.routes.map(r => r.href)).toContain('/staff/billing/membership-changes');
  expect(schoolShellActiveRoute('/staff/billing/membership-changes')?.href).toBe('/staff/billing/membership-changes');
  const page = readFileSync('src/app/staff/billing/membership-changes/page.tsx', 'utf8');
  expect(page).toContain('await requireVerifiedWebSession()');
  expect(readFileSync('public/manus-routes.json', 'utf8')).toContain('"/staff/billing/membership-changes"');
});
