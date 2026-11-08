import React from 'react';
import { existsSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SAAS_COMMANDS, SAAS_PLAN_CAPABILITIES, validateSaasAccessOverview, type SaasAccessOverview } from '@hon/contracts';
import { AccessOverviewError, accessApi, commandErrorFor } from '../src/components/hq-access/http';
import { commandOutcome, grantInput, revokeReason } from '../src/components/hq-access/model';
import { HqAccessView, outcomeText, type AccessViewProps } from '../src/components/hq-access/view';
import { HQ_NAV_GROUPS, hqPageLabel } from '../src/components/hq-modern/catalog';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';

const yes = () => true;

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-11-01T00:00:00.000Z', START = '2026-11-02T00:00:00.000Z', END = '2026-12-02T00:00:00.000Z';
const school = (n: number, status = 'ACTIVE') => ({ schoolId: id(n), schoolDisplayName: `Synthetic Academy ${n}`, schoolStatus: status });
function eligible(n = 10) {
  return { organizationId: id(n), organizationDisplayName: `Synthetic Dojo ${n}`, organizationStatus: 'ACTIVE', createdAt: `2026-10-${String(n).padStart(2, '0')}T00:00:00.000Z`,
    schools: [school(n + 100), school(n + 200, 'SUSPENDED')], schoolCount: 2,
    entitlement: { tier: 'COMPLETE', status: 'SUSPENDED', effectiveFrom: T, effectiveUntil: null, version: 2, inEffect: false },
    accessState: 'PROVISIONED', accessStatus: 'NO_ACCESS', currentException: null, subscription: null, openCheckout: false,
    ownerOnboarding: { status: 'PENDING', invitedAt: T, expiresAt: END, acceptedAt: null },
    exceptionGrant: { eligible: true, blockers: [], expectedEntitlementVersion: 2 } };
}
function inEffect(n = 11) {
  return { ...eligible(n), entitlement: { tier: 'COMPLETE', status: 'ACTIVE', effectiveFrom: START, effectiveUntil: END, version: 3, inEffect: true },
    accessStatus: 'EXCEPTION_IN_EFFECT', currentException: { exceptionId: id(n + 500), schoolId: id(n + 100), purpose: 'APPROVED_PILOT', scopeTier: 'COMPLETE',
      startsAt: START, expiresAt: END, lifecycle: 'IN_EFFECT', revocable: true },
    ownerOnboarding: { status: 'ACCEPTED', invitedAt: T, expiresAt: END, acceptedAt: T },
    exceptionGrant: { eligible: false, blockers: ['ACCESS_EXCEPTION_ACTIVE', 'ENTITLEMENT_IN_EFFECT'], expectedEntitlementVersion: 3 } };
}
function overview(owner = true, ready = true, orgs = [eligible(), inEffect()]) {
  const rows = ready ? orgs : orgs.map(o => ({ ...o, exceptionGrant: { ...o.exceptionGrant, eligible: false,
    blockers: ['EXCEPTION_POLICY_REQUIRED', ...o.exceptionGrant.blockers] } }));
  return { viewer: { canGrantAndRevokeExceptions: owner }, paidAccessProgram: 'INACTIVE',
    exceptionPolicy: ready ? { ready: true, maxDays: 90, validUntil: END, maxScheduleAheadDays: 30 } : { ready: false, maxDays: null, validUntil: null, maxScheduleAheadDays: 30 },
    summary: { AWAITING_FIRST_PAYMENT: 0, EXCEPTION_IN_EFFECT: 1, EXCEPTION_SCHEDULED: 0, PAID_ACCESS: 0, PROVISIONED_ACCESS: 0, NO_ACCESS: 1, total: 2 },
    organizations: rows, limit: 25, nextCursor: null, asOf: T };
}
const view = (raw = overview()) => validateSaasAccessOverview(raw);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: (Response | Error)[]) => {
  const fetch = vi.fn(async () => { const a = answers.shift(); if (!a || a instanceof Error) throw a ?? new Error('none'); return a; });
  vi.stubGlobal('fetch', fetch); return fetch;
};

it('accepts the fixtures as real contract rows', () => {
  expect(view().organizations.map(o => o.accessStatus)).toEqual(['NO_ACCESS', 'EXCEPTION_IN_EFFECT']);
  expect(view(overview(true, false)).organizations[0]!.exceptionGrant.blockers).toEqual(['EXCEPTION_POLICY_REQUIRED']);
});

it('maps only exact command answers; anything else keeps the request for Try again', () => {
  const rows: [number, string | null, string][] = [[403, 'SAAS_FORBIDDEN', 'DENIED'], [403, 'HUMAN_UI_REQUIRED', 'DENIED'], [400, 'INVALID_SAAS_INPUT', 'INVALID'],
    [409, 'SAAS_VERSION_CONFLICT', 'CHANGED'], [422, 'SAAS_ACCESS_EXCEPTION_ACTIVE', 'CHANGED'], [422, 'SAAS_EXCEPTION_ENDED', 'CHANGED'], [404, 'SAAS_UNAVAILABLE', 'CHANGED'],
    [422, 'SAAS_EXCEPTION_WINDOW_INVALID', 'REFUSED'], [422, 'SAAS_EXCEPTION_TOO_LONG', 'REFUSED'], [409, 'SAAS_OUTCOME_UNKNOWN', 'UNKNOWN'], [409, 'IDEMPOTENCY_KEY_REUSED', 'UNKNOWN'],
    [422, 'SOMETHING_NEW', 'UNKNOWN'], [503, 'SAAS_UNAVAILABLE', 'UNKNOWN'], [500, null, 'UNKNOWN'], [404, null, 'UNKNOWN']];
  for (const [status, code, kind] of rows) expect(commandErrorFor(status, code).kind, `${status} ${code}`).toBe(kind);
  expect(commandOutcome(new AccessOverviewError('UNKNOWN'), 'grant', 'Dojo').keep).toBe(true);
  expect(commandOutcome(new TypeError('network'), 'revoke', 'Dojo')).toEqual({ outcome: { kind: 'UNKNOWN', command: 'revoke', organization: 'Dojo' }, keep: true });
  for (const kind of ['DENIED', 'CHANGED', 'INVALID'] as const) expect(commandOutcome(new AccessOverviewError(kind), 'grant', 'Dojo').keep).toBe(false);
});

it('reads one bounded page with only the declared query keys, and refuses rows outside the filter', async () => {
  const fetch = stub(json({ data: overview() }));
  await accessApi.overview({ status: null, cursor: { createdAt: T, organizationId: id(9) } }, new AbortController().signal, yes);
  const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/hq/saas/access-overview?${new URLSearchParams({ cursor: `${T}~${id(9)}`, limit: '25' })}`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' });
  stub(json({ data: overview() }));
  await expect(accessApi.overview({ status: 'NO_ACCESS', cursor: null }, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  stub(json({ code: 'SAAS_FORBIDDEN' }, 403));
  await expect(accessApi.overview({ status: null, cursor: null }, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'DENIED' });
  stub(json({ data: { ...overview(), viewer: { canGrantAndRevokeExceptions: true, role: 'OWNER' } } }));
  await expect(accessApi.overview({ status: null, cursor: null }, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
});

it('builds a grant only for an active school inside the policy window', () => {
  const org = view().organizations[0]!, now = new Date('2026-11-08T15:00:00.000Z');
  const draft = { schoolId: id(110), purpose: 'APPROVED_PILOT', scopeTier: 'COMPLETE', startDate: '', days: '30', reason: 'Pilot for a partner academy' };
  expect(grantInput(org, 90, draft, now)).toEqual({ schoolId: id(110), purpose: 'APPROVED_PILOT', reason: 'Pilot for a partner academy', scopeTier: 'COMPLETE',
    startsAt: '2026-11-08T15:00:00.000Z', expiresAt: '2026-12-08T15:00:00.000Z', expectedEntitlementVersion: 2 });
  expect(grantInput(org, 90, { ...draft, schoolId: id(210) }, now)).toBeNull(); // suspended school
  expect(grantInput(org, 90, { ...draft, days: '91' }, now)).toBeNull();
  expect(grantInput(org, 20, { ...draft, days: '30' }, now)).toBeNull();
  expect(grantInput(org, null, draft, now)).toBeNull();
  expect(grantInput(org, 90, { ...draft, reason: 'short' }, now)).toBeNull();
  expect(grantInput(org, 90, { ...draft, purpose: 'FREE' }, now)).toBeNull();
  expect(grantInput(org, 90, { ...draft, startDate: '2027-01-30' }, now)).toBeNull(); // more than 30 days ahead
  expect(grantInput(org, 90, { ...draft, startDate: '2026-11-01' }, now)).toBeNull(); // in the past
  expect(revokeReason('  Pilot ended early by agreement ')).toBe('Pilot ended early by agreement');
  expect(revokeReason('too short')).toBeNull();
});

it('sends a grant with the SaaS command header and key, and only a matching receipt confirms it', async () => {
  const org = view().organizations[0]!;
  const input = grantInput(org, 90, { schoolId: id(110), purpose: 'APPROVED_PILOT', scopeTier: 'COMPLETE', startDate: '', days: '30', reason: 'Pilot for a partner academy' })!;
  const ent = { tier: 'COMPLETE', status: 'ACTIVE', effectiveFrom: input.startsAt, effectiveUntil: input.expiresAt, version: 3, inEffect: true };
  const exception = { exceptionId: id(700), organizationId: org.organizationId, schoolId: input.schoolId, purpose: input.purpose, reason: input.reason, scopeTier: 'COMPLETE',
    capabilities: [...SAAS_PLAN_CAPABILITIES.COMPLETE], aiCredits: 'NONE', startsAt: input.startsAt, expiresAt: input.expiresAt, policyVersion: 1, maxDays: 90, status: 'GRANTED',
    lifecycle: 'IN_EFFECT', grantedByPrincipalId: id(800), grantedAt: input.startsAt, priorEntitlement: org.entitlement, grantedEntitlement: ent,
    endReason: null, endNote: null, endEntitlement: null, endedByPrincipalId: null, endedAt: null };
  const access = { organizationId: org.organizationId, state: 'PROVISIONED', source: 'PROVISIONED', entitlement: ent, capabilities: [...SAAS_PLAN_CAPABILITIES.COMPLETE], paidAccessProgram: 'INACTIVE' };
  const key = id(900);
  const fetch = stub(json({ data: { exception, access, replayed: false } }));
  expect((await accessApi.grant(org.organizationId, input, key, new AbortController().signal, yes)).exception.exceptionId).toBe(id(700));
  const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/hq/saas/organizations/${org.organizationId}/access-exceptions`);
  expect(init).toMatchObject({ method: 'POST', mode: 'same-origin', credentials: 'same-origin', redirect: 'error' });
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': SAAS_COMMANDS.grantAccessException, 'Idempotency-Key': key, 'Content-Type': 'application/json' });
  expect(JSON.parse(String(init.body))).toEqual(input);
  stub(json({ data: { exception: { ...exception, schoolId: id(111) }, access, replayed: false } }));
  await expect(accessApi.grant(org.organizationId, input, key, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  stub(new TypeError('network'));
  await expect(accessApi.grant(org.organizationId, input, key, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  stub(json({ code: 'SAAS_ACCESS_EXCEPTION_ACTIVE' }, 422));
  await expect(accessApi.grant(org.organizationId, input, key, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'CHANGED' });
});

it('ends the attempt on definite pre-write refusals: policy missing or withdrawn, an access state or an open checkout', () => {
  for (const code of ['SAAS_EXCEPTION_POLICY_REQUIRED', 'SAAS_POLICY_UNDECIDED']) {
    const error = commandErrorFor(422, code);
    expect(error.kind).toBe('REFUSED');
    const { outcome, keep } = commandOutcome(error, 'grant', 'Dojo');
    expect(keep).toBe(false);
    expect(outcomeText('en', outcome)?.text).toContain('no approved access exception policy is in effect');
    expect(outcomeText('ko', outcome)?.text).toContain('승인된 접근 예외 정책');
    expect(outcomeText('es', outcome)?.text).toContain('no hay una política de excepciones de acceso aprobada');
  }
  for (const code of ['SAAS_ACCESS_STATE_EXISTS', 'SAAS_CHECKOUT_OPEN']) {
    expect(commandErrorFor(422, code).kind).toBe('CHANGED');
    expect(commandOutcome(commandErrorFor(422, code), 'grant', 'Dojo').keep).toBe(false);
  }
  // Still unknown: an answer that is not one of the documented refusals.
  expect(commandErrorFor(422, 'SAAS_SOMETHING_NEW').kind).toBe('UNKNOWN');
  expect(commandErrorFor(409, 'SAAS_OUTCOME_UNKNOWN').kind).toBe('UNKNOWN');
});

it('a 401 for a retired read or command does not end the newer session; a current one does', async () => {
  const seen = vi.fn(); (window as unknown as EventTarget).addEventListener(HON_SESSION_INVALIDATED_EVENT, seen);
  const org = view().organizations[0]!, retired = () => false;
  const input = grantInput(org, 90, { schoolId: id(110), purpose: 'APPROVED_PILOT', scopeTier: 'COMPLETE', startDate: '', days: '30', reason: 'Pilot for a partner academy' })!;
  const calls = [
    (owned: () => boolean) => accessApi.overview({ status: null, cursor: { createdAt: T, organizationId: id(9) } }, new AbortController().signal, owned),
    (owned: () => boolean) => accessApi.grant(org.organizationId, input, id(900), new AbortController().signal, owned),
    (owned: () => boolean) => accessApi.revoke(id(511), 'Pilot ended early by agreement', id(901), new AbortController().signal, owned)];
  for (const call of calls) { stub(json({ code: 'SIGN_IN_REQUIRED' }, 401)); await expect(call(retired)).rejects.toMatchObject({ kind: 'SESSION' }); }
  expect(seen).not.toHaveBeenCalled();
  for (const call of calls) { stub(json({ code: 'SIGN_IN_REQUIRED' }, 401)); await expect(call(yes)).rejects.toMatchObject({ kind: 'SESSION' }); }
  expect(seen).toHaveBeenCalledTimes(3);
});

const base = (v: SaasAccessOverview = view()): AccessViewProps => ({ language: 'en', concealed: false, state: { state: 'READY', view: v, organizations: v.organizations, loadingMore: false, moreFailed: false },
  filter: null, outcome: null, locked: false, canRetry: false, form: null });
const render = (props: AccessViewProps) => renderToStaticMarkup(<HqAccessView {...props}/>);

it('offers grant only for an eligible row and revoke only for a revocable exception, to the HQ owner', () => {
  const html = render(base());
  expect(html.match(/Grant an exception/g)).toHaveLength(1);
  expect(html.match(/>Revoke</g)).toHaveLength(1);
  expect(html).toContain('Exception policy approved: up to 90 days');
  expect(html).not.toContain('Only the HQ owner can grant');
});

it('an HQ operator sees the same facts with no grant or revoke control', () => {
  const html = render(base(view(overview(false))));
  expect(html).toContain('Only the HQ owner can grant or revoke');
  expect(html).not.toContain('Grant an exception'); expect(html).not.toMatch(/>Revoke</);
  expect(html).toContain('Synthetic Dojo 10'); expect(html).toContain('Approved pilot');
});

it('without an approved policy no grant is offered and the reason is shown', () => {
  const html = render(base(view(overview(true, false))));
  expect(html).not.toContain('Grant an exception');
  expect(html).toContain('The exception policy is not approved yet');
  expect(html).toContain('the exception policy is not approved');
});

it('shows the grant form with only active schools, and locks it while a command is pending', () => {
  const v = view(), org = v.organizations[0]!;
  const html = render({ ...base(v), form: { command: 'grant', organizationId: org.organizationId } });
  expect(html).toContain('Synthetic Academy 110'); expect(html).not.toContain('<option value="' + id(210));
  expect(html).toContain('No AI credits, payment or subscription is created.');
  const locked = render({ ...base(v), form: { command: 'grant', organizationId: org.organizationId }, locked: true, canRetry: true,
    outcome: { kind: 'UNKNOWN', command: 'grant', organization: 'Synthetic Dojo 10' } });
  expect(locked).toMatch(/<fieldset[^>]*disabled/); expect(locked).toContain('Try again'); expect(locked).toContain('never grants or revokes twice');
});

it('hides every customer fact while concealed, loading, denied or unavailable', () => {
  for (const props of [{ ...base(), concealed: true }, { ...base(), state: { state: 'LOADING' } }, { ...base(), state: { state: 'DENIED' } }, { ...base(), state: { state: 'UNAVAILABLE' } }] as AccessViewProps[]) {
    const html = render(props);
    expect(html).not.toMatch(/Synthetic|Grant an exception/);
  }
});

it('words every outcome in three languages', () => {
  for (const language of ['en', 'ko', 'es']) for (const kind of ['SENDING', 'DONE', 'UNKNOWN', 'CHANGED', 'DENIED', 'INVALID', 'LOCAL_INVALID'] as const)
    for (const command of ['grant', 'revoke'] as const) expect(outcomeText(language, { kind, command, organization: 'Dojo' })?.text).toMatch(/^Dojo: \S/);
  expect(outcomeText('en', { kind: 'REFUSED', command: 'grant', organization: 'Dojo', code: 'SAAS_EXCEPTION_TOO_LONG' })?.text).toContain('longer than the policy allows');
});

it('is in the Schools navigation group and the route manifest', () => {
  expect(HQ_NAV_GROUPS['/hq/schools']?.children.map(c => c.path)).toEqual(['/hq/schools', '/hq/schools/access', '/hq/schools/access/policy']);
  expect(hqPageLabel('/hq/schools/access')).toBe('School Access');
  expect(hqPageLabel('/hq/schools')).toBe('Schools');
  expect(existsSync('src/app/hq/schools/access/page.tsx')).toBe(true);
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string }[] };
  expect(manifest.routes.some(r => r.path === '/hq/schools/access')).toBe(true);
});
