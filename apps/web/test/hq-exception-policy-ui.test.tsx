import React from 'react';
import { existsSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SAAS_COMMANDS, validateSaasExceptionPolicyView, type SaasExceptionPolicyView } from '@hon/contracts';
import { PolicyError, policyApi, policyErrorFor } from '../src/components/hq-exception-policy/http';
import { allowed, decisionInput, decisionOutcome, draftFrom, endInput, localDay, EMPTY_DRAFT } from '../src/components/hq-exception-policy/model';
import { HqExceptionPolicyView, outcomeText, type PolicyViewProps } from '../src/components/hq-exception-policy/view';
import { HQ_NAV_GROUPS, hqPageLabel } from '../src/components/hq-modern/catalog';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';

const yes = () => true;
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date(2026, 10, 8, 10, 0, 0);
const iso = (d: Date) => d.toISOString();
const day = (n: number) => new Date(2026, 10, 8 + n);
function decision(revision: number, status: 'PROPOSED' | 'APPROVED' | 'WITHDRAWN' | 'REVOKED', patch: Record<string, unknown> = {}) {
  return { approvalId: id(revision), revision, status, termsVersion: 1, maxDays: 30, validFrom: iso(day(-1)), validUntil: iso(day(60)),
    reason: 'Synthetic exception policy decision', actorPrincipalId: id(900), recordedAt: iso(day(-1)), ...patch };
}
function raw(history: ReturnType<typeof decision>[] = [], patch: Record<string, unknown> = {}) {
  const current = history[0] ?? null;
  const effectiveStatus = !current ? 'ABSENT' : current.status !== 'APPROVED' ? current.status
    : current.termsVersion !== 1 ? 'SUPERSEDED' : Date.parse(current.validFrom) > NOW.getTime() ? 'SCHEDULED' : Date.parse(current.validUntil) <= NOW.getTime() ? 'EXPIRED' : 'ACTIVE';
  return { scope: 'ACCESS_EXCEPTIONS_ONLY', current, effectiveStatus, history, historyLimit: 100, asOf: iso(NOW), termsStatus: 'PROPOSED',
    terms: { policyVersion: 1, exceptionMaxDays: 90, exceptionAuthority: 'HQ_OWNER' }, viewer: { canDecide: true },
    paidAccessProgram: 'INACTIVE', aiCreditProgram: 'INACTIVE', ...patch };
}
const view = (r: Record<string, unknown> = raw()): SaasExceptionPolicyView => validateSaasExceptionPolicyView(r);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: (Response | Error)[]) => {
  const fetch = vi.fn(async () => { const a = answers.shift(); if (!a || a instanceof Error) throw a ?? new Error('none'); return a; });
  vi.stubGlobal('fetch', fetch); return fetch;
};
const draft = (patch: Partial<typeof EMPTY_DRAFT> = {}) => ({ maxDays: '30', startDate: '', endDate: localDay(day(30)), reason: 'Approve exceptions for pilots', confirmed: true, ...patch });
const props = (state: PolicyViewProps['state'], patch: Partial<PolicyViewProps> = {}): PolicyViewProps =>
  ({ language: 'en', concealed: false, state, outcome: null, locked: false, canRetry: false, form: null, ...patch });
const html = (p: PolicyViewProps) => renderToStaticMarkup(<HqExceptionPolicyView {...p}/>);

it('the fixtures are real contract rows, and the read refuses terms it does not explain', () => {
  expect(view().effectiveStatus).toBe('ABSENT');
  expect(view(raw([decision(2, 'APPROVED', { termsVersion: 1 })], { terms: { policyVersion: 2, exceptionMaxDays: 90, exceptionAuthority: 'HQ_OWNER' }, effectiveStatus: 'SUPERSEDED' })).effectiveStatus).toBe('SUPERSEDED');
  expect(() => view(raw([decision(1, 'APPROVED')], { effectiveStatus: 'SUPERSEDED' }))).toThrow();
  expect(() => view(raw([], { viewer: { canDecide: 'yes' } }))).toThrow();
});

it('maps only exact decision answers; anything else keeps the request for Try again', () => {
  expect(policyErrorFor(403, 'SAAS_FORBIDDEN').kind).toBe('DENIED');
  expect(policyErrorFor(400, 'INVALID_SAAS_INPUT').kind).toBe('INVALID');
  expect(policyErrorFor(409, 'SAAS_VERSION_CONFLICT').kind).toBe('CHANGED');
  for (const code of ['SAAS_EXCEPTION_POLICY_WINDOW_INVALID', 'SAAS_EXCEPTION_POLICY_LIMIT', 'SAAS_EXCEPTION_POLICY_REQUIRED']) expect(policyErrorFor(422, code).kind).toBe('REFUSED');
  for (const [s, c] of [[409, 'SAAS_OUTCOME_UNKNOWN'], [422, 'SAAS_EXCEPTION_POLICY_EVIDENCE_REQUIRED'], [503, 'SAAS_UNAVAILABLE'], [500, null], [409, 'IDEMPOTENCY_KEY_REUSED']] as const)
    expect(policyErrorFor(s, c).kind).toBe('UNKNOWN');
  expect(decisionOutcome(new PolicyError('UNKNOWN'), 'APPROVED')).toEqual({ outcome: { kind: 'UNKNOWN', command: 'APPROVED' }, keep: true });
  expect(decisionOutcome(new Error('network'), 'APPROVED').keep).toBe(true);
  expect(decisionOutcome(new PolicyError('CHANGED'), 'APPROVED').keep).toBe(false);
  expect(decisionOutcome(new PolicyError('SESSION'), 'APPROVED')).toEqual({ outcome: null, keep: false });
});

it('builds a decision at the next revision for the current terms, within their limit, only with the confirmation for approval', () => {
  const v = view(raw([decision(1, 'PROPOSED')]));
  const input = decisionInput(v, 'APPROVED', draft(), NOW)!;
  expect(input).toEqual({ expectedRevision: 1, decision: 'APPROVED', termsVersion: 1, maxDays: 30, validFrom: iso(NOW), validUntil: iso(day(31)),
    reason: 'Approve exceptions for pilots', confirmation: 'APPROVE_ACCESS_EXCEPTION_POLICY_ONLY' });
  const proposed = decisionInput(v, 'PROPOSED', draft({ confirmed: false, startDate: localDay(day(3)) }), NOW)!;
  expect(proposed).not.toHaveProperty('confirmation'); expect(proposed.decision === 'PROPOSED' && proposed.validFrom).toBe(iso(day(3)));
  expect(decisionInput(view(), 'PROPOSED', draft(), NOW)?.expectedRevision).toBe(0);
  for (const bad of [{ confirmed: false }, { maxDays: '91' }, { maxDays: '0' }, { maxDays: '2.5' }, { endDate: '' }, { endDate: localDay(day(-1)) },
    { startDate: localDay(day(-2)) }, { startDate: localDay(day(40)), endDate: localDay(day(30)) }, { reason: 'short' }, { endDate: '2026-02-30' }])
    expect(decisionInput(v, 'APPROVED', draft(bad), NOW)).toBeNull();
  expect(decisionInput(view(raw([], { terms: { policyVersion: 1, exceptionMaxDays: 14, exceptionAuthority: 'HQ_OWNER' } })), 'PROPOSED', draft({ maxDays: '15' }), NOW)).toBeNull();
  expect(decisionInput(view(raw([], { viewer: { canDecide: false } })), 'PROPOSED', draft(), NOW)).toBeNull();
});

it('offers withdraw for a proposal and revoke for an approval only while they cite the current terms', () => {
  expect(allowed(view())).toEqual({ decide: true, end: null });
  expect(allowed(view(raw([decision(1, 'PROPOSED')]))).end).toBe('WITHDRAWN');
  expect(allowed(view(raw([decision(2, 'APPROVED')]))).end).toBe('REVOKED');
  expect(allowed(view(raw([decision(2, 'REVOKED')]))).end).toBeNull();
  const superseded = view(raw([decision(2, 'APPROVED')], { terms: { policyVersion: 2, exceptionMaxDays: 90, exceptionAuthority: 'HQ_OWNER' }, effectiveStatus: 'SUPERSEDED' }));
  expect(allowed(superseded).end).toBeNull();
  expect(allowed(view(raw([decision(2, 'APPROVED')], { viewer: { canDecide: false } })))).toEqual({ decide: false, end: null });
  expect(endInput(view(raw([decision(2, 'APPROVED')])), ' Pilot program has ended ')).toEqual({ expectedRevision: 2, decision: 'REVOKED', reason: 'Pilot program has ended' });
  expect(endInput(view(raw([decision(2, 'APPROVED')])), 'short')).toBeNull();
});

it('prefills the form from the latest proposal, never from an ended one', () => {
  const p = decision(1, 'PROPOSED', { maxDays: 14, validFrom: iso(day(2)), validUntil: iso(day(32)) });
  expect(draftFrom(view(raw([p])).current, NOW)).toEqual({ maxDays: '14', startDate: localDay(day(2)), endDate: localDay(day(31)), reason: '', confirmed: false });
  expect(draftFrom(view(raw([decision(2, 'WITHDRAWN')])).current, NOW)).toEqual(EMPTY_DRAFT);
});

it('reads the policy and sends a decision with the SaaS command header and key; only a matching receipt confirms it', async () => {
  const fetch = stub(json({ data: raw([decision(1, 'PROPOSED')]) }));
  expect((await policyApi.read(AbortSignal.timeout(1000), yes)).current?.revision).toBe(1);
  expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe('/api/v1/hq/saas/access-exception-policy');
  const v = view(raw([decision(1, 'PROPOSED')])), input = decisionInput(v, 'APPROVED', draft(), NOW)!, key = id(77);
  const recorded = { ...decision(2, 'APPROVED'), maxDays: 30, validFrom: iso(NOW), validUntil: iso(day(31)), reason: 'Approve exceptions for pilots' };
  const send = stub(json({ data: { policy: recorded, replayed: false } }));
  expect((await policyApi.decide(input, key, AbortSignal.timeout(1000), yes)).policy.revision).toBe(2);
  const [path, init] = send.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/hq/saas/access-exception-policy');
  expect(init.method).toBe('POST'); expect(JSON.parse(String(init.body))).toEqual(input);
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': SAAS_COMMANDS.decideExceptionPolicy, 'Idempotency-Key': key });
  for (const wrong of [{ revision: 3 }, { status: 'PROPOSED' }, { maxDays: 29 }, { reason: 'A different synthetic reason' }, { validUntil: iso(day(40)) }]) {
    stub(json({ data: { policy: { ...recorded, ...wrong }, replayed: false } }));
    await expect(policyApi.decide(input, key, AbortSignal.timeout(1000), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  }
  stub(json({ code: 'SAAS_VERSION_CONFLICT' }, 409));
  await expect(policyApi.decide(input, key, AbortSignal.timeout(1000), yes)).rejects.toMatchObject({ kind: 'CHANGED' });
  stub(new TypeError('network'));
  await expect(policyApi.decide(input, key, AbortSignal.timeout(1000), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
});

it('a 401 for a retired read or decision does not end the newer session; a current one does', async () => {
  const seen = vi.fn(); window.addEventListener(HON_SESSION_INVALIDATED_EVENT, seen);
  stub(json({ code: 'UNAUTHENTICATED' }, 401));
  await expect(policyApi.read(AbortSignal.timeout(1000), () => false)).rejects.toMatchObject({ kind: 'SESSION' });
  const input = decisionInput(view(), 'PROPOSED', draft(), NOW)!;
  stub(json({ code: 'UNAUTHENTICATED' }, 401));
  await expect(policyApi.decide(input, id(5), AbortSignal.timeout(1000), () => false)).rejects.toMatchObject({ kind: 'SESSION' });
  expect(seen).not.toHaveBeenCalled();
  stub(json({ code: 'UNAUTHENTICATED' }, 401));
  await expect(policyApi.read(AbortSignal.timeout(1000), yes)).rejects.toMatchObject({ kind: 'SESSION' });
  expect(seen).toHaveBeenCalledTimes(1);
});

it('says what the latest decision allows, and states that approval is for exceptions only', () => {
  const absent = html(props({ state: 'READY', view: view() }));
  expect(absent).toContain('No decision yet'); expect(absent).toContain('Not decided');
  expect(absent).toContain('version 1, up to 90 days'); expect(absent).toContain('does not approve paid access terms');
  expect(absent).toContain('Propose or approve'); expect(absent).not.toContain('Withdraw proposal');
  const active = html(props({ state: 'READY', view: view(raw([decision(2, 'APPROVED'), decision(1, 'PROPOSED')])) }));
  expect(active).toContain('Approved, in effect'); expect(active).toContain('Exceptions can be granted now.'); expect(active).toContain('Revoke approval');
  expect(active).toContain('Revision 2'); expect(active).toContain('Revision 1');
  const superseded = html(props({ state: 'READY', view: view(raw([decision(2, 'APPROVED')], { terms: { policyVersion: 2, exceptionMaxDays: 90, exceptionAuthority: 'HQ_OWNER' }, effectiveStatus: 'SUPERSEDED' })) }));
  expect(superseded).toContain('Approved for older terms'); expect(superseded).not.toContain('Revoke approval');
});

it('an HQ operator sees the policy with no decision control', () => {
  const out = html(props({ state: 'READY', view: view(raw([decision(1, 'PROPOSED')], { viewer: { canDecide: false } })) }));
  expect(out).toContain('Only the HQ owner can propose'); expect(out).not.toContain('Propose or approve'); expect(out).not.toContain('Withdraw proposal');
});

it('shows the decision form with the confirmation, prefilled from the proposal, and locks it while a decision is pending', () => {
  const v = view(raw([decision(1, 'PROPOSED', { maxDays: 14 })]));
  const open = html(props({ state: 'READY', view: v }, { form: 'DECIDE' }));
  expect(open).toContain('value="14"'); expect(open).toContain('name="confirmed"'); expect(open).toContain('Approve policy'); expect(open).toContain('Save as proposal');
  expect(html(props({ state: 'READY', view: v }, { form: 'DECIDE', locked: true }))).toContain('<fieldset disabled=""');
  expect(html(props({ state: 'READY', view: v }, { form: 'END' }))).toContain('Withdraw this proposal');
});

it('hides the policy while concealed, loading, denied or unavailable', () => {
  const v = view(raw([decision(1, 'PROPOSED')]));
  expect(html(props({ state: 'READY', view: v }, { concealed: true }))).not.toContain('Synthetic exception policy decision');
  for (const state of [{ state: 'LOADING' }, { state: 'DENIED' }, { state: 'UNAVAILABLE' }] as const) expect(html(props(state))).not.toContain('Latest decision');
  expect(html(props({ state: 'READY', view: v }, { concealed: true, outcome: { kind: 'DONE', command: 'APPROVED' } }))).not.toContain('Recorded');
});

it('words every outcome in three languages, with Try again only for an unknown outcome that is kept', () => {
  for (const language of ['en', 'ko', 'es']) for (const kind of ['SENDING', 'DONE', 'UNKNOWN', 'CHANGED', 'DENIED', 'INVALID', 'LOCAL_INVALID'] as const)
    for (const command of ['PROPOSED', 'APPROVED', 'WITHDRAWN', 'REVOKED'] as const) expect(outcomeText(language, { kind, command })?.text).toMatch(/\S/);
  expect(outcomeText('en', { kind: 'REFUSED', command: 'APPROVED', code: 'SAAS_EXCEPTION_POLICY_LIMIT' })?.text).toContain('access terms changed');
  expect(outcomeText('en', { kind: 'DONE', command: 'APPROVED' })?.text).toContain('Recorded: Approved');
  const v = view();
  expect(html(props({ state: 'READY', view: v }, { outcome: { kind: 'UNKNOWN', command: 'APPROVED' }, canRetry: true, onTryAgain: () => {} }))).toContain('>Try again</button>');
  expect(html(props({ state: 'READY', view: v }, { outcome: { kind: 'UNKNOWN', command: 'APPROVED' }, canRetry: false, onTryAgain: () => {} }))).not.toContain('>Try again</button>');
});

it('is in the Schools navigation group and the route manifest', () => {
  expect(HQ_NAV_GROUPS['/hq/schools']?.children.map(c => c.path)).toContain('/hq/schools/access/policy');
  expect(hqPageLabel('/hq/schools/access/policy')).toBe('Exception Policy');
  expect(existsSync('src/app/hq/schools/access/policy/page.tsx')).toBe(true);
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string }[] };
  expect(manifest.routes.some(r => r.path === '/hq/schools/access/policy')).toBe(true);
});
