import { afterEach, describe, expect, it, vi } from 'vitest';
import { SAAS_COMMANDS, SAAS_PLAN_CAPABILITIES, validateSaasAccessExceptionGrantReceipt, validateSaasAccessExceptionRevokeReceipt, validateSaasAccessExceptionsView, validateSaasExceptionPolicyView, validateSaasOrganizationSubscription, type SaasAccessExceptionGrantInput } from '@hon/contracts';
import { exceptionApi, prepareGrant, prepareRevoke, target, type Capsule, type Snapshot } from '../src/components/hq-access-exceptions/http';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';

const owner = '10000000-0000-4000-8000-000000000001', otherOwner = '10000000-0000-4000-8000-000000000002';
const selected = { organizationId: '20000000-0000-4000-8000-000000000001', schoolId: '30000000-0000-4000-8000-000000000001' };
const exceptionId = '40000000-0000-4000-8000-000000000001', approvalId = '50000000-0000-4000-8000-000000000001';
const at = '2026-11-01T12:00:00.000Z', startsAt = '2026-11-02T12:00:00.000Z', expiresAt = '2026-11-09T12:00:00.000Z';
const reason = 'Reviewed internal testing scope.', base = `/api/v1/hq/saas/organizations/${selected.organizationId}`;
const input = (): SaasAccessExceptionGrantInput => ({ schoolId: selected.schoolId, purpose: 'INTERNAL_TESTING', reason, scopeTier: 'COMPLETE', startsAt, expiresAt, expectedEntitlementVersion: 3 });
const entitlement = () => ({ tier: 'COMPLETE' as const, status: 'SUSPENDED' as const, effectiveFrom: '2026-10-01T00:00:00.000Z', effectiveUntil: null, version: 3, inEffect: false });
function snapshot(): Snapshot {
  const current = { approvalId, revision: 2, status: 'APPROVED', termsVersion: 1, maxDays: 7, validFrom: '2026-10-01T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', reason, actorPrincipalId: owner, recordedAt: at };
  return {
    policy: validateSaasExceptionPolicyView({ scope: 'ACCESS_EXCEPTIONS_ONLY', current, effectiveStatus: 'ACTIVE', history: [current], historyLimit: 100, asOf: at, termsStatus: 'PROPOSED', paidAccessProgram: 'INACTIVE', aiCreditProgram: 'INACTIVE' }),
    exceptions: validateSaasAccessExceptionsView({ organizationId: selected.organizationId, access: { organizationId: selected.organizationId, state: 'PROVISIONED', source: 'NONE', entitlement: entitlement(), capabilities: [], paidAccessProgram: 'INACTIVE' }, exceptions: [], asOf: at }),
    subscription: validateSaasOrganizationSubscription({ organizationId: selected.organizationId, organizationName: 'Synthetic organization', organizationStatus: 'ACTIVE', entitlement: { tier: 'COMPLETE', status: 'SUSPENDED', effectiveFrom: entitlement().effectiveFrom, effectiveUntil: null, version: 3 }, current: null, alignment: 'NO_SUBSCRIPTION', history: [], founderReservations: [], chargesEnabled: false }),
  };
}
function grantReceipt(request: Capsule = prepareGrant(owner, selected, input())) {
  const body = JSON.parse(request.body) as SaasAccessExceptionGrantInput;
  return validateSaasAccessExceptionGrantReceipt({ exception: { exceptionId, ...selected, purpose: body.purpose, reason: body.reason, scopeTier: body.scopeTier, capabilities: [...SAAS_PLAN_CAPABILITIES[body.scopeTier]], aiCredits: 'NONE', startsAt: body.startsAt, expiresAt: body.expiresAt, policyVersion: 1, maxDays: 7, status: 'GRANTED', lifecycle: 'SCHEDULED', grantedByPrincipalId: owner, grantedAt: at, priorEntitlement: entitlement(), grantedEntitlement: { tier: body.scopeTier, status: 'ACTIVE', effectiveFrom: body.startsAt, effectiveUntil: body.expiresAt, version: 4, inEffect: false }, endReason: null, endNote: null, endEntitlement: null, endedByPrincipalId: null, endedAt: null, governingPolicy: { approvalId, revision: 2, termsVersion: 1, maxDays: 7 } }, access: snapshot().exceptions.access, replayed: false });
}
function revokeReceipt() {
  return validateSaasAccessExceptionRevokeReceipt({ exception: { ...grantReceipt().exception, status: 'ENDED', lifecycle: 'REVOKED', endReason: 'REVOKED', endNote: reason, endEntitlement: entitlement(), endedByPrincipalId: owner, endedAt: at }, entitlementSuspended: true, access: snapshot().exceptions.access, replayed: false });
}
function reply(data: unknown, init: ResponseInit = {}) { return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }, ...init }); }
function setup() {
  const state = { data: snapshot() };
  const fetch = vi.fn(async (path: string, _options: RequestInit) => {
    if (path === '/api/v1/hq/session') return reply({ principalId: owner, hqRole: 'HON_HQ_OWNER' });
    if (path === '/api/v1/hq/saas/access-exception-policy') return reply(state.data.policy);
    if (path === `${base}/access-exceptions`) return reply(state.data.exceptions);
    if (path === `${base}/subscription`) return reply(state.data.subscription);
    throw Error('Unlisted API call');
  });
  vi.stubGlobal('fetch', fetch); return { state, fetch };
}
const signal = () => new AbortController().signal;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('HQ exception transport — closed current-owner reads', () => {
  it('uses only the fixed session resolver and refuses operator/support roles or extra authority claims', async () => {
    const s = setup(); expect(await exceptionApi.owner(signal())).toBe(owner);
    expect(s.fetch.mock.calls[0]).toMatchObject(['/api/v1/hq/session', { method: 'GET', cache: 'no-store', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', referrerPolicy: 'no-referrer' }]);
    for (const value of [{ principalId: owner, hqRole: 'HON_HQ_OPERATOR' }, { principalId: owner, hqRole: 'HON_HQ_SUPPORT' }, { principalId: owner, hqRole: 'HON_HQ_OWNER', canGrant: true }, { principalId: 'forged', hqRole: 'HON_HQ_OWNER' }]) {
      s.fetch.mockResolvedValueOnce(reply(value)); await expect(exceptionApi.owner(signal())).rejects.toBeDefined();
    }
    expect(s.fetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
  });
  it('reads exactly the three existing endpoints, preserving approved maxDays and PROPOSED broader terms', async () => {
    const s = setup(), abort = new AbortController(); const result = await exceptionApi.read(selected, abort.signal);
    expect(result).toEqual(s.state.data); expect(result.policy.current?.maxDays).toBe(7); expect(result.policy.termsStatus).toBe('PROPOSED');
    expect(s.fetch.mock.calls.map(([path]) => path).sort()).toEqual(['/api/v1/hq/saas/access-exception-policy', `${base}/access-exceptions`, `${base}/subscription`].sort());
    for (const [, options] of s.fetch.mock.calls) expect(options).toMatchObject({ method: 'GET', headers: { Accept: 'application/json' }, credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
    abort.abort(); expect(s.fetch.mock.calls.every(([, options]) => options.signal?.aborted)).toBe(true);
  });
  it('reads absence of an approved policy and labels historical nullable policy bindings without inventing authority', async () => {
    const s = setup(); s.state.data.policy.current = null; s.state.data.policy.history = []; s.state.data.policy.effectiveStatus = 'ABSENT';
    s.state.data.exceptions.exceptions = [{ ...grantReceipt().exception, governingPolicy: null }];
    const result = await exceptionApi.read(selected, signal()); expect(result.policy.current).toBeNull(); expect(result.exceptions.exceptions[0]!.governingPolicy).toBeNull();
    expect(s.fetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
  });
  it('rejects invalid or additional selectors before any request and closed response drift after read', async () => {
    const s = setup(); for (const candidate of [{ ...selected, organizationId: '../other' }, { ...selected, schoolId: 'not-a-uuid' }, { ...selected, principalId: owner }]) {
      await expect(exceptionApi.read(candidate, signal())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(s.fetch).not.toHaveBeenCalled(); s.fetch.mockResolvedValue(reply({ ...s.state.data.policy, canGrant: true }));
    await expect(exceptionApi.read(selected, signal())).rejects.toBeDefined();
  });
  it('rejects individually valid data belonging to a different organization', async () => {
    const s = setup(), foreign = '20000000-0000-4000-8000-000000000002';
    s.state.data.exceptions.organizationId = foreign; s.state.data.exceptions.access.organizationId = foreign;
    validateSaasAccessExceptionsView(s.state.data.exceptions);
    await expect(exceptionApi.read(selected, signal())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('broadcasts only confirmed 401, before reading a denied body; 403 remains local', async () => {
    const s = setup(), browser = new EventTarget(), invalidated = vi.fn(); browser.addEventListener(HON_SESSION_INVALIDATED_EVENT, invalidated); vi.stubGlobal('window', browser);
    for (const status of [401, 403]) for (const operation of ['owner', 'read'] as const) {
      const denied = new Response('private denied details', { status }), consume = vi.spyOn(denied, 'json'); s.fetch.mockResolvedValue(denied);
      await expect(operation === 'owner' ? exceptionApi.owner(signal()) : exceptionApi.read(selected, signal())).rejects.toMatchObject({ code: status === 401 ? 'SIGNED_OUT' : 'FORBIDDEN', status });
      expect(consume).not.toHaveBeenCalled();
    }
    expect(invalidated).toHaveBeenCalledTimes(4); // one owner request and three simultaneous domain reads returned 401
  });
  it('refuses unexpected successful status, redirected, cacheable, oversized or non-JSON responses', async () => {
    const s = setup();
    const redirected = reply(s.state.data.policy); Object.defineProperty(redirected, 'redirected', { value: true });
    const replies = [reply(s.state.data.policy, { status: 201 }), redirected, reply(s.state.data.policy, { headers: { 'Content-Type': 'application/json' } }), reply(s.state.data.policy, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } }), new Response(' '.repeat(1_000_001), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }), new Response(JSON.stringify({ data: s.state.data.policy, authority: true }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })];
    for (const response of replies) { s.fetch.mockImplementation(async () => { const copy = response.clone(); if (response.redirected) Object.defineProperty(copy, 'redirected', { value: true }); return copy; }); await expect(exceptionApi.read(selected, signal())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }); }
  });
});

describe('HQ exception transport — exact closed human commands and verified receipts', () => {
  it('allocates one immutable capsule only after local validation; never accepts an actor in a closed DTO', () => {
    const uuid = vi.spyOn(crypto, 'randomUUID'); const request = prepareGrant(owner, selected, input());
    expect(uuid).toHaveBeenCalledTimes(1); expect(Object.isFrozen(request)).toBe(true); expect(Object.isFrozen(request.target)).toBe(true); expect(target(selected)).toEqual(selected);
    for (const candidate of [{ ...input(), actorPrincipalId: owner }, { ...input(), schoolId: '30000000-0000-4000-8000-000000000002' }, { ...input(), expiresAt: null }, { ...input(), aiCredits: 100 }]) expect(() => prepareGrant(owner, selected, candidate as SaasAccessExceptionGrantInput)).toThrow();
    expect(uuid).toHaveBeenCalledTimes(1); expect(() => prepareRevoke(owner, selected, '../exception', reason)).toThrow();
  });
  it('sends only the canonical grant with the exact human marker, immutable body and key, including explicit replay', async () => {
    const s = setup(), request = prepareGrant(owner, selected, input()), uuid = vi.spyOn(crypto, 'randomUUID'); const result = grantReceipt(request);
    s.fetch.mockResolvedValueOnce(reply(result)).mockResolvedValueOnce(reply({ ...result, replayed: true }));
    expect((await exceptionApi.send(request)).kind).toBe('grant'); expect((await exceptionApi.send(request)).data.replayed).toBe(true); expect(uuid).not.toHaveBeenCalled();
    expect(s.fetch).toHaveBeenCalledTimes(2); const first = s.fetch.mock.calls[0]!;
    expect(first).toMatchObject([`${base}/access-exceptions`, { method: 'POST', body: request.body, credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.key, 'X-HON-Human-Command': SAAS_COMMANDS.grantAccessException } }]);
    expect(s.fetch.mock.calls[1]![1].body).toBe(first[1].body); expect(s.fetch.mock.calls[1]![1].headers).toEqual(first[1].headers);
    expect(Object.keys(JSON.parse(request.body)).sort()).toEqual(['schoolId','purpose','reason','scopeTier','startsAt','expiresAt','expectedEntitlementVersion'].sort());
  });
  it('does not automatically retry a lost response or allocate a replacement request', async () => {
    const s = setup(), request = prepareGrant(owner, selected, input()), uuid = vi.spyOn(crypto, 'randomUUID'); s.fetch.mockRejectedValue(new TypeError('response lost'));
    await expect(exceptionApi.send(request)).rejects.toThrow('response lost'); await Promise.resolve(); expect(s.fetch).toHaveBeenCalledTimes(1); expect(uuid).not.toHaveBeenCalled();
  });
  it('rejects forged paths, command kinds, invalid keys and extra DTO fields before any dispatch', async () => {
    const s = setup(), request = prepareGrant(owner, selected, input());
    for (const forged of [{ ...request, path: '/api/v1/hq/saas/access-exception-policy' }, { ...request, kind: 'approve' }, { ...request, key: 'bad-key' }, { ...request, body: JSON.stringify({ ...input(), actorPrincipalId: owner }) }, { ...request, target: { ...selected, schoolId: '30000000-0000-4000-8000-000000000002' } }]) await expect(exceptionApi.send(forged as Capsule)).rejects.toBeDefined();
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it('rejects grant receipts with foreign scope, actor, changed normalized fields, absent policy or invented AI credits', async () => {
    const s = setup(), request = prepareGrant(owner, selected, input());
    const changes = [{ organizationId: '20000000-0000-4000-8000-000000000002' }, { schoolId: '30000000-0000-4000-8000-000000000002' }, { grantedByPrincipalId: otherOwner }, { reason: 'A different internal justification.' }, { purpose: 'PRODUCT_DEMONSTRATION' }, { startsAt: '2026-11-03T12:00:00.000Z' }, { governingPolicy: null }, { aiCredits: 'GRANTED' }];
    for (const change of changes) { const result = grantReceipt(request); s.fetch.mockResolvedValueOnce(reply({ ...result, exception: { ...result.exception, ...change } })); await expect(exceptionApi.send(request)).rejects.toBeDefined(); }
  });
  it('uses only the revoke command and verifies exact exception, current actor and submitted reason', async () => {
    const s = setup(), request = prepareRevoke(owner, selected, exceptionId, reason); s.fetch.mockResolvedValueOnce(reply(revokeReceipt()));
    expect((await exceptionApi.send(request)).kind).toBe('revoke'); expect(s.fetch.mock.calls[0]).toMatchObject([`/api/v1/hq/saas/access-exceptions/${exceptionId}/revoke`, { method: 'POST', body: JSON.stringify({ reason }), headers: { 'X-HON-Human-Command': SAAS_COMMANDS.revokeAccessException, 'Idempotency-Key': request.key } }]);
    for (const change of [{ exceptionId: '40000000-0000-4000-8000-000000000002' }, { endedByPrincipalId: otherOwner }, { endNote: 'A different revocation justification.' }, { schoolId: '30000000-0000-4000-8000-000000000002' }]) { const result = revokeReceipt(); s.fetch.mockResolvedValueOnce(reply({ ...result, exception: { ...result.exception, ...change } })); await expect(exceptionApi.send(request)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }); }
  });
  it('reports only allowlisted denial codes and shares confirmed POST 401 with sibling surfaces', async () => {
    const s = setup(), request = prepareGrant(owner, selected, input()), browser = new EventTarget(), invalidated = vi.fn(); browser.addEventListener(HON_SESSION_INVALIDATED_EVENT, invalidated); vi.stubGlobal('window', browser);
    for (const [code, expected] of [['SAAS_CHECKOUT_OPEN','SAAS_CHECKOUT_OPEN'],['private SQL failure for another organization','UNAVAILABLE']]) { s.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code, message: 'private details' }), { status: 422 })); await expect(exceptionApi.send(request)).rejects.toMatchObject({ code: expected, status: 422 }); }
    s.fetch.mockResolvedValueOnce(new Response(null, { status: 403 })); await expect(exceptionApi.send(request)).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(invalidated).not.toHaveBeenCalled();
    s.fetch.mockResolvedValueOnce(new Response(null, { status: 401 })); await expect(exceptionApi.send(request)).rejects.toMatchObject({ code: 'SIGNED_OUT' }); expect(invalidated).toHaveBeenCalledTimes(1);
  });
});
