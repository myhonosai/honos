import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/components/hq-modern/shell', () => ({ useHqModern: () => ({ view: 'modern' }) }));
import { HqOnboardingPanel } from '../src/components/hq-onboarding-panel';
import { SchoolCreationController } from '../src/components/hq-onboarding-controller';
import { createSchoolRequest, schoolCreationApi, SchoolCreationError, verifySchoolCreationReceipt, type SchoolCreationReceipt, type SchoolCreationRequest } from '../src/components/hq-onboarding-http';
import { readFileSync } from 'node:fs';

const principalId = '10000000-0000-4000-8000-000000000001';
const otherPrincipal = '10000000-0000-4000-8000-000000000002';
const form = { legalName: 'Harbor LLC', displayName: 'Harbor', schoolName: 'Harbor Main', schoolSlug: 'harbor-main', timezone: 'America/Los_Angeles' };
const receipt: SchoolCreationReceipt = { organizationId: '20000000-0000-4000-8000-000000000001', schoolId: '30000000-0000-4000-8000-000000000001', ownerRoleId: '40000000-0000-4000-8000-000000000001', replayed: false, actorPrincipalId: principalId, entitlementStatus: 'SUSPENDED' };
const envelope = (data = receipt) => ({ data, meta: { replayed: data.replayed } });
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; };
function setup() {
  const api = { authorize: vi.fn(async (_signal: AbortSignal) => principalId), send: vi.fn(async (_request: SchoolCreationRequest) => receipt) };
  const controller = new SchoolCreationController(api); controller.start(); return { api, controller };
}
async function prepare(s: ReturnType<typeof setup>) {
  await s.controller.authorize();
  for (const key of Object.keys(form) as (keyof typeof form)[]) s.controller.edit(key, form[key]);
  s.controller.confirm(true);
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('HQ school creation controller', () => {
  it('starts inert and requires explicit authorization, complete input and human confirmation', async () => {
    const s = setup(); expect(s.api.authorize).not.toHaveBeenCalled();
    await s.controller.submit(); expect(s.api.send).not.toHaveBeenCalled();
    await s.controller.authorize(); s.controller.confirm(true); await s.controller.submit();
    expect(s.api.send).not.toHaveBeenCalled(); expect(s.controller.snapshot().confirmed).toBe(false);
    await prepare(s); s.controller.edit('schoolName', 'Changed school'); await s.controller.submit();
    expect(s.api.send).not.toHaveBeenCalled(); s.controller.confirm(true); await s.controller.submit();
    expect(s.api.authorize).toHaveBeenCalledTimes(4); expect(s.api.send).toHaveBeenCalledTimes(1);
    expect(s.controller.snapshot().receipt).toEqual(receipt); expect(s.controller.snapshot().form.legalName).toBe('');
  });
  it('blocks double clicks with an immediate command lock including authorization waits', async () => {
    const s = setup(); await prepare(s); const gate = deferred<string>(); s.api.authorize.mockImplementation(() => gate.promise);
    const run = s.controller.submit(); await s.controller.submit(); await s.controller.authorize();
    expect(s.api.authorize).toHaveBeenCalledTimes(2); expect(s.api.send).not.toHaveBeenCalled();
    gate.resolve(principalId); await run; expect(s.api.send).toHaveBeenCalledTimes(1);
  });
  it('retains immutable exact payload and key after an unknown result, with locked fields and fresh confirmation', async () => {
    const s = setup(); await prepare(s); s.api.send.mockRejectedValueOnce(new Error('unknown'));
    await s.controller.submit(); const original = s.api.send.mock.calls[0]![0];
    expect(Object.isFrozen(original)).toBe(true); expect(s.controller.snapshot().uncertain).toBe(true);
    s.controller.edit('schoolName', 'Replacement'); await s.controller.submit(); expect(s.api.send).toHaveBeenCalledTimes(1);
    expect(s.controller.snapshot().form).toEqual(form); s.controller.confirm(true); await s.controller.submit();
    expect(s.api.send.mock.calls[1]![0]).toBe(original); expect(s.controller.snapshot().uncertain).toBe(false);
  });
  it('clears private visible data on concealment and keeps the command locked until physical settlement', async () => {
    const s = setup(); await prepare(s); const wait = deferred<SchoolCreationReceipt>(); s.api.send.mockImplementation(() => wait.promise);
    const run = s.controller.submit(); await Promise.resolve(); expect(s.api.send).toHaveBeenCalledTimes(1);
    s.controller.conceal(); expect(s.controller.snapshot()).toMatchObject({ concealed: true, confirmed: false, receipt: null, busy: true, form: { legalName: '' } });
    await s.controller.authorize(); expect(s.api.authorize).toHaveBeenCalledTimes(2);
    wait.resolve(receipt); await run;
    expect(s.controller.snapshot()).toMatchObject({ concealed: true, receipt: null, busy: false });
    await s.controller.authorize(); expect(s.controller.snapshot()).toMatchObject({ concealed: false, uncertain: true, form });
    expect(s.api.send).toHaveBeenCalledTimes(1); s.controller.confirm(true); await s.controller.submit();
    expect(s.api.send.mock.calls[1]![0]).toBe(s.api.send.mock.calls[0]![0]);
  });
  it('settles a rejected command after concealment without a stale error or automatic retry', async () => {
    const s = setup(); await prepare(s); const wait = deferred<SchoolCreationReceipt>(); s.api.send.mockImplementation(() => wait.promise);
    const run = s.controller.submit(); await Promise.resolve(); s.controller.conceal(); wait.reject(new Error('network')); await run;
    expect(s.controller.snapshot()).toMatchObject({ busy: false, concealed: true, receipt: null, message: '' });
    await s.controller.authorize(); expect(s.controller.snapshot().uncertain).toBe(true); expect(s.api.send).toHaveBeenCalledTimes(1);
  });
  it('refuses a retained request under a different owner and permits restoration only to its original owner', async () => {
    const s = setup(); await prepare(s); s.api.send.mockRejectedValueOnce(new Error('unknown')); await s.controller.submit(); s.controller.conceal();
    s.api.authorize.mockResolvedValue(otherPrincipal); await s.controller.authorize();
    expect(s.controller.snapshot()).toMatchObject({ concealed: true, access: 'forbidden', form: { legalName: '' } });
    s.controller.confirm(true); await s.controller.submit(); expect(s.api.send).toHaveBeenCalledTimes(1);
    s.api.authorize.mockResolvedValue(principalId); await s.controller.authorize(); s.controller.confirm(true); await s.controller.submit();
    expect(s.api.send.mock.calls[1]![0]).toBe(s.api.send.mock.calls[0]![0]);
  });
  it('rechecks current identity immediately before dispatch and refuses switched/revoked sessions', async () => {
    for (const failure of [otherPrincipal, new SchoolCreationError(401), new SchoolCreationError(403)]) {
      const s = setup(); await prepare(s);
      if (typeof failure === 'string') s.api.authorize.mockResolvedValue(failure); else s.api.authorize.mockRejectedValue(failure);
      await s.controller.submit(); expect(s.api.send).not.toHaveBeenCalled(); expect(s.controller.snapshot().concealed).toBe(true);
    }
  });
  it('keeps sign-in available when a transport 401 broadcast has already concealed the form', async () => {
    const s = setup(); s.api.authorize.mockImplementationOnce(async () => { s.controller.conceal(); throw new SchoolCreationError(401); });
    await s.controller.authorize(); expect(s.controller.snapshot()).toMatchObject({ concealed: true, access: 'signed-out', busy: false });
  });
  it('conceals 401/403 command refusals and requires same-owner explicit restoration and exact retry', async () => {
    for (const status of [401, 403]) {
      const s = setup(); await prepare(s); s.api.send.mockRejectedValueOnce(new SchoolCreationError(status)); await s.controller.submit();
      expect(s.controller.snapshot()).toMatchObject({ concealed: true, form: { schoolName: '' }, receipt: null, busy: false });
      await s.controller.authorize(); expect(s.controller.snapshot().uncertain).toBe(true); expect(s.api.send).toHaveBeenCalledTimes(1);
    }
  });
  it('conceals a verified principal-mismatch refusal and restores only the original owner and exact request', async () => {
    const s = setup(); await prepare(s);
    s.api.send.mockRejectedValueOnce(new SchoolCreationError(409, 'HQ_EXPECTED_PRINCIPAL_MISMATCH'));
    await s.controller.submit(); const original = s.api.send.mock.calls[0]![0];
    expect(s.controller.snapshot()).toMatchObject({ concealed: true, access: 'idle', message: 'principalChanged', uncertain: false, receipt: null, busy: false, form: { schoolName: '' } });
    s.controller.confirm(true); await s.controller.submit(); expect(s.api.send).toHaveBeenCalledTimes(1);
    s.api.authorize.mockResolvedValueOnce(otherPrincipal); await s.controller.authorize();
    expect(s.controller.snapshot()).toMatchObject({ concealed: true, access: 'forbidden', form: { legalName: '' } });
    await s.controller.authorize(); s.controller.edit('schoolName', 'Replacement');
    expect(s.controller.snapshot().form).toEqual(JSON.parse(original.body)); s.controller.confirm(true); await s.controller.submit();
    expect(s.api.send.mock.calls[1]![0]).toBe(original); expect(s.controller.snapshot().receipt).toEqual(receipt);
  });
  it('keeps an earlier unknown request intact when a later exact retry is refused for principal mismatch', async () => {
    const s = setup(); await prepare(s); s.api.send.mockRejectedValueOnce(new Error('lost response'));
    await s.controller.submit(); const original = s.api.send.mock.calls[0]![0];
    s.api.send.mockRejectedValueOnce(new SchoolCreationError(409, 'HQ_EXPECTED_PRINCIPAL_MISMATCH'));
    s.controller.confirm(true); await s.controller.submit();
    expect(s.controller.snapshot()).toMatchObject({ concealed: true, message: 'principalChanged', receipt: null });
    await s.controller.authorize(); expect(s.controller.snapshot().uncertain).toBe(true);
    s.controller.confirm(true); await s.controller.submit();
    for (const [request] of s.api.send.mock.calls) expect(request).toBe(original);
    expect(s.api.send).toHaveBeenCalledTimes(3);
  });
  it('discards a late mismatch after privacy concealment without releasing or replacing its request', async () => {
    const s = setup(); await prepare(s); const wait = deferred<SchoolCreationReceipt>(); s.api.send.mockImplementationOnce(() => wait.promise);
    const run = s.controller.submit(); await Promise.resolve(); const original = s.api.send.mock.calls[0]![0];
    s.controller.conceal(); await s.controller.authorize();
    expect(s.controller.snapshot().busy).toBe(true); expect(s.api.authorize).toHaveBeenCalledTimes(2);
    wait.reject(new SchoolCreationError(409, 'HQ_EXPECTED_PRINCIPAL_MISMATCH')); await run;
    expect(s.controller.snapshot()).toMatchObject({ concealed: true, receipt: null, message: '', busy: false });
    await s.controller.authorize(); s.controller.confirm(true); await s.controller.submit();
    expect(s.api.send.mock.calls[1]![0]).toBe(original);
  });
  it('retains unknown recovery for a wrong-actor success and unclassified 409 without showing a receipt', async () => {
    for (const response of [new Response(JSON.stringify(envelope({ ...receipt, actorPrincipalId: otherPrincipal })), { status: 201 }),
      new Response(JSON.stringify({ code: 'HQ_PROVISIONING_IN_PROGRESS' }), { status: 409 })]) {
      const s = setup(); await prepare(s); s.api.send.mockImplementation(request => schoolCreationApi.send(request));
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response)
        .mockResolvedValueOnce(new Response(JSON.stringify(envelope({ ...receipt, replayed: true })), { status: 200 }));
      await s.controller.submit(); const original = s.api.send.mock.calls[0]![0];
      expect(s.controller.snapshot()).toMatchObject({ uncertain: true, message: 'unknownOutcome', receipt: null, confirmed: false });
      s.controller.confirm(true); await s.controller.submit();
      expect(s.api.send.mock.calls[1]![0]).toBe(original);
      for (const [, options] of fetch.mock.calls) expect(options).toMatchObject({ body: original.body, headers: expect.objectContaining({ 'Idempotency-Key': original.key, 'X-HON-Expected-Principal': original.principalId }) });
      expect(s.controller.snapshot().receipt?.replayed).toBe(true); fetch.mockRestore();
    }
  });
  it('verifies current ownership again before revealing a creation receipt', async () => {
    const s = setup(); await prepare(s);
    s.api.send.mockImplementationOnce(async () => { s.api.authorize.mockResolvedValue(otherPrincipal); return receipt; });
    await s.controller.submit(); expect(s.controller.snapshot()).toMatchObject({ concealed: true, access: 'forbidden', receipt: null });
    s.api.authorize.mockResolvedValue(principalId); await s.controller.authorize();
    expect(s.controller.snapshot().uncertain).toBe(true); expect(s.api.send).toHaveBeenCalledTimes(1);
  });
  it('does not show a receipt when privacy changes during the post-response ownership read', async () => {
    const s = setup(); await prepare(s); const postRead = deferred<string>();
    s.api.send.mockImplementationOnce(async () => { s.api.authorize.mockImplementationOnce(() => postRead.promise); return receipt; });
    const run = s.controller.submit(); await Promise.resolve(); await Promise.resolve();
    s.controller.conceal(); postRead.resolve(principalId); await run;
    expect(s.controller.snapshot()).toMatchObject({ concealed: true, receipt: null, busy: false });
    await s.controller.authorize(); expect(s.controller.snapshot().uncertain).toBe(true);
  });
  it('invalidates late access and prevents dispatch when privacy changes during preflight', async () => {
    const s = setup(), wait = deferred<string>(); s.api.authorize.mockImplementationOnce(() => wait.promise);
    const auth = s.controller.authorize(); s.controller.conceal(); wait.resolve(principalId); await auth;
    expect(s.controller.snapshot()).toMatchObject({ concealed: true, busy: false });
    await prepare(s); const preflight = deferred<string>(); s.api.authorize.mockImplementationOnce(() => preflight.promise);
    const run = s.controller.submit(); s.controller.conceal(); preflight.resolve(principalId); await run;
    expect(s.api.send).not.toHaveBeenCalled(); expect(s.controller.snapshot().busy).toBe(false);
  });
  it('ignores responses from an unmounted instance and clears receipt after privacy shutdown', async () => {
    const s = setup(); await prepare(s); const wait = deferred<SchoolCreationReceipt>(); s.api.send.mockImplementationOnce(() => wait.promise);
    const run = s.controller.submit(); await Promise.resolve(); s.controller.stop(); wait.resolve(receipt); await run; expect(s.controller.snapshot().receipt).toBeNull();
    const next = setup(); await prepare(next); await next.controller.submit(); next.controller.conceal();
    expect(next.controller.snapshot()).toMatchObject({ receipt: null, confirmed: false, form: { legalName: '' } });
  });
});

describe('existing HQ transport and verified receipt', () => {
  it('sends only normalized existing DTO fields with an internal COMPLETE placeholder', () => {
    const request = createSchoolRequest({ ...form, legalName: '  Harbor LLC  ' }, principalId);
    expect(JSON.parse(request.body)).toEqual({ ...form, initialTier: 'COMPLETE' }); expect(request.principalId).toBe(principalId);
    for (const patch of [{ schoolSlug: 'bad slug' }, { timezone: 'wrong/timezone' }, { legalName: '' }, { schoolName: 'bad\u202ename' }]) expect(() => createSchoolRequest({ ...form, ...patch }, principalId)).toThrow();
  });
  it('accepts only the actual closed creation/replay response, refusing invented access or payment facts', () => {
    expect(verifySchoolCreationReceipt(envelope(), 201, principalId)).toEqual(receipt);
    expect(verifySchoolCreationReceipt(envelope({ ...receipt, replayed: true }), 200, principalId).replayed).toBe(true);
    for (const value of [
      { data: receipt }, { ...envelope(), secret: 'private' }, { data: { ...receipt, access: 'NONE' }, meta: { replayed: false } },
      { data: { ...receipt, payment: 'PAID' }, meta: { replayed: false } }, { data: { ...receipt, schoolId: 'unverified' }, meta: { replayed: false } },
      { data: receipt, meta: { replayed: true } }, { data: { ...receipt, schoolId: receipt.organizationId }, meta: { replayed: false } },
      { data: { ...receipt, actorPrincipalId: otherPrincipal }, meta: { replayed: false } },
      { data: { ...receipt, actorPrincipalId: 'not-a-uuid' }, meta: { replayed: false } },
      { data: { ...receipt, entitlementStatus: 'PAID' }, meta: { replayed: false } },
      { data: { ...receipt, entitlementStatus: 'ACTIVE' }, meta: { replayed: false } },
      { data: { ...receipt, entitlementStatus: 'ARCHIVED' }, meta: { replayed: false } },
      { data: (({ actorPrincipalId: _actor, entitlementStatus: _status, ...legacy }) => legacy)(receipt), meta: { replayed: false } },
      { data: (({ actorPrincipalId: _actor, ...missing }) => missing)(receipt), meta: { replayed: false } },
      { data: (({ entitlementStatus: _status, ...missing }) => missing)(receipt), meta: { replayed: false } },
    ]) expect(() => verifySchoolCreationReceipt(value, 201, principalId)).toThrow();
    expect(() => verifySchoolCreationReceipt(envelope(), 200, principalId)).toThrow();
    expect(() => verifySchoolCreationReceipt(envelope(), 201, 'invalid')).toThrow();
  });
  it('accepts only the documented replay statuses and canonicalizes UUID case for actor binding', () => {
    for (const entitlementStatus of ['ACTIVE', 'SUSPENDED', 'ARCHIVED'] as const) {
      expect(verifySchoolCreationReceipt(envelope({ ...receipt, replayed: true, entitlementStatus }), 200, principalId).entitlementStatus).toBe(entitlementStatus);
    }
    const actor = 'abcdef01-0000-4000-8000-000000000001';
    expect(verifySchoolCreationReceipt(envelope({ ...receipt, actorPrincipalId: actor.toUpperCase() }), 201, actor).actorPrincipalId).toBe(actor);
    expect(createSchoolRequest(form, actor.toUpperCase()).principalId).toBe(actor);
  });
  it('classifies only the exact documented mismatch 409 as a known refusal without global 401 invalidation', async () => {
    const dispatchEvent = vi.fn(); vi.stubGlobal('window', { dispatchEvent });
    const fetch = vi.spyOn(globalThis, 'fetch');
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'HQ_EXPECTED_PRINCIPAL_MISMATCH' }), { status: 409 }));
    await expect(schoolCreationApi.send(createSchoolRequest(form, principalId))).rejects.toMatchObject({ status: 409, code: 'HQ_EXPECTED_PRINCIPAL_MISMATCH' });
    for (const body of [JSON.stringify({ code: 'HQ_PROVISIONING_CONFLICT' }), JSON.stringify({ code: 'HQ_PROVISIONING_IN_PROGRESS' }),
      JSON.stringify({ code: 'HQ_EXPECTED_PRINCIPAL_MISMATCH', detail: 'unverified' }), JSON.stringify({ error: 'HQ_EXPECTED_PRINCIPAL_MISMATCH' }), '{}', 'not json']) {
      fetch.mockResolvedValueOnce(new Response(body, { status: 409 }));
      await expect(schoolCreationApi.send(createSchoolRequest(form, principalId))).rejects.toMatchObject({ status: 409, code: null });
    }
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
  it('uses fixed same-origin no-store GET and POST; ownership is never sent as a body authority field', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ data: { principalId, hqRole: 'HON_HQ_OWNER' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(envelope()), { status: 201 }));
    await expect(schoolCreationApi.authorize(new AbortController().signal)).resolves.toBe(principalId);
    const request = createSchoolRequest(form, principalId); await expect(schoolCreationApi.send(request)).resolves.toEqual(receipt);
    expect(fetchSpy.mock.calls[0]).toEqual(['/api/v1/hq/session', expect.objectContaining({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' })]);
    expect(fetchSpy.mock.calls[1]).toEqual(['/api/v1/hq/organizations', expect.objectContaining({ method: 'POST', cache: 'no-store', body: request.body, headers: expect.objectContaining({ 'X-HON-Human-Command': 'hq-school-provisioning', 'X-HON-Expected-Principal': principalId, 'Idempotency-Key': request.key }) })]);
    expect(JSON.parse(request.body)).not.toHaveProperty('principalId');
  });
  it('fails closed for operator/support or malformed session and broadcasts only authenticated 401', async () => {
    for (const role of ['HON_HQ_OPERATOR', 'HON_HQ_SUPPORT']) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: { principalId, hqRole: role } })));
      await expect(schoolCreationApi.authorize(new AbortController().signal)).rejects.toMatchObject({ status: 403 }); vi.restoreAllMocks();
    }
    const dispatchEvent = vi.fn(); vi.stubGlobal('window', { dispatchEvent });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const status of [401, 403, 503]) {
      fetchSpy.mockResolvedValue(new Response('{}', { status }));
      await expect(schoolCreationApi.send(createSchoolRequest(form, principalId))).rejects.toMatchObject({ status });
    }
    expect(dispatchEvent).toHaveBeenCalledTimes(1); expect(dispatchEvent.mock.calls[0]![0].type).toBe('hon:session-invalidated');
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ data: { principalId, hqRole: 'HON_HQ_OWNER', permission: '*' } })));
    await expect(schoolCreationApi.authorize(new AbortController().signal)).rejects.toThrow();
  });
  it('mounts the reused panel beside the unchanged minimized directory and renders no automatic command or public tier choice', () => {
    const spy = vi.spyOn(globalThis, 'fetch'); const html = renderToStaticMarkup(<HqOnboardingPanel />);
    expect(spy).not.toHaveBeenCalled(); expect(html).toContain('Verify HQ-owner access'); expect(html).toContain('SUSPENDED');
    expect(html).not.toMatch(/<form|<select|\$|ONBOARDING COMPLETE|Harbor LLC/);
    expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"');
    expect(html).toContain('exception requires an approved policy and verified eligibility');
    const route = readFileSync('src/app/hq/schools/page.tsx', 'utf8'); expect(route).toContain('<HqSchoolDirectory /><HqOnboardingPanel />');
    const ui = readFileSync('src/components/hq-onboarding-panel.tsx', 'utf8');
    expect(ui).toContain('bindSchoolCreationPrivacy');
    const privacy = readFileSync('src/components/hq-onboarding-controller.ts', 'utf8');
    for (const event of ['blur', 'pagehide', 'visibilitychange', 'HON_SESSION_INVALIDATED_EVENT', 'HON_SCHOOL_CONTEXT_CHANGED_EVENT']) expect(privacy).toContain(event);
    expect(ui).toContain('useHqModern');
    expect(ui).not.toContain('COMPLETE');
  });
});
