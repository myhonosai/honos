import { afterEach, describe, expect, it, vi } from 'vitest';
import { SAAS_PLAN_CAPABILITIES, validateSaasAccessExceptionGrantReceipt, validateSaasAccessExceptionRevokeReceipt, validateSaasAccessExceptionsView, validateSaasExceptionPolicyView, validateSaasOrganizationSubscription, type SaasAccessException, type SaasSubscription } from '@hon/contracts';
import { AccessExceptionController, bindExceptionPrivacy, blockers } from '../src/components/hq-access-exceptions/controller';
import { ExceptionError, type Capsule, type Receipt, type Snapshot } from '../src/components/hq-access-exceptions/http';
import { HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT } from '../src/components/session-invalidation';

const owner = '10000000-0000-4000-8000-000000000001', otherOwner = '10000000-0000-4000-8000-000000000002';
const selected = { organizationId: '20000000-0000-4000-8000-000000000001', schoolId: '30000000-0000-4000-8000-000000000001' };
const exceptionId = '40000000-0000-4000-8000-000000000001', approvalId = '50000000-0000-4000-8000-000000000001';
const at = '2026-11-01T12:00:00.000Z', startsAt = '2026-11-02T12:00:00.000Z', expiresAt = '2026-11-09T12:00:00.000Z';
const reason = 'Reviewed internal testing scope.';
const entitlement = () => ({ tier: 'COMPLETE' as const, status: 'SUSPENDED' as const, effectiveFrom: '2026-10-01T00:00:00.000Z', effectiveUntil: null, version: 3, inEffect: false });
function data(): Snapshot {
  const policy = { scope: 'ACCESS_EXCEPTIONS_ONLY', current: { approvalId, revision: 2, status: 'APPROVED', termsVersion: 1, maxDays: 7, validFrom: '2026-10-01T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', reason, actorPrincipalId: owner, recordedAt: at }, effectiveStatus: 'ACTIVE', history: [] as unknown[], historyLimit: 100, asOf: at, termsStatus: 'PROPOSED', paidAccessProgram: 'INACTIVE', aiCreditProgram: 'INACTIVE' };
  policy.history = [policy.current];
  return {
    policy: validateSaasExceptionPolicyView(policy),
    exceptions: validateSaasAccessExceptionsView({ organizationId: selected.organizationId, access: { organizationId: selected.organizationId, state: 'PROVISIONED', source: 'NONE', entitlement: entitlement(), capabilities: [], paidAccessProgram: 'INACTIVE' }, exceptions: [], asOf: at }),
    subscription: validateSaasOrganizationSubscription({ organizationId: selected.organizationId, organizationName: 'Synthetic organization', organizationStatus: 'ACTIVE', entitlement: { tier: 'COMPLETE', status: 'SUSPENDED', effectiveFrom: entitlement().effectiveFrom, effectiveUntil: null, version: 3 }, current: null, alignment: 'NO_SUBSCRIPTION', history: [], founderReservations: [], chargesEnabled: false }),
  };
}
function openException(): SaasAccessException {
  return { exceptionId, ...selected, purpose: 'INTERNAL_TESTING', reason, scopeTier: 'COMPLETE', capabilities: [...SAAS_PLAN_CAPABILITIES.COMPLETE], aiCredits: 'NONE', startsAt, expiresAt, policyVersion: 1, maxDays: 7, status: 'GRANTED', lifecycle: 'SCHEDULED', grantedByPrincipalId: owner, grantedAt: at, priorEntitlement: entitlement(), grantedEntitlement: { tier: 'COMPLETE', status: 'ACTIVE', effectiveFrom: startsAt, effectiveUntil: expiresAt, version: 4, inEffect: false }, endReason: null, endNote: null, endEntitlement: null, endedByPrincipalId: null, endedAt: null, governingPolicy: { approvalId, revision: 2, termsVersion: 1, maxDays: 7 } };
}
function subscription(): SaasSubscription {
  return { subscriptionId: '60000000-0000-4000-8000-000000000001', organizationId: selected.organizationId, organizationName: 'Synthetic organization', source: 'LEGACY_ENTITLEMENT', catalogVersion: null, offerId: null, planCode: 'COMPLETE', entitlementTier: 'COMPLETE', offerKind: null, billingInterval: 'NONE', priceMinor: null, currency: 'USD', founderReservationId: null, status: 'PENDING_ACTIVATION', statusReason: 'RECORDED', version: 1, serviceStartedAt: null, currentPeriod: null, paymentStatus: 'NOT_BILLED', paidThroughAt: null, chargesEnabled: false, premiumCredits: { plannedMonthlyAllowance: null, status: 'NOT_GRANTED' }, createdAt: at, updatedAt: at };
}
function receipt(request: Capsule): Receipt {
  const x = openException();
  if (request.kind === 'grant') {
    const { expectedEntitlementVersion: _version, ...fields } = JSON.parse(request.body);
    return { kind: 'grant', data: validateSaasAccessExceptionGrantReceipt({ exception: { ...x, ...fields }, access: data().exceptions.access, replayed: false }) };
  }
  return { kind: 'revoke', data: validateSaasAccessExceptionRevokeReceipt({ exception: { ...x, status: 'ENDED', lifecycle: 'REVOKED', endReason: 'REVOKED', endNote: JSON.parse(request.body).reason, endEntitlement: entitlement(), endedByPrincipalId: owner, endedAt: at }, entitlementSuspended: true, access: data().exceptions.access, replayed: false }) };
}
function verify(snapshot: Snapshot) {
  validateSaasExceptionPolicyView(snapshot.policy); validateSaasAccessExceptionsView(snapshot.exceptions); validateSaasOrganizationSubscription(snapshot.subscription); return snapshot;
}
function setup(initial = data()) {
  const state = { data: verify(initial) };
  const api = { owner: vi.fn(async (_signal: AbortSignal) => owner), read: vi.fn(async (_target: typeof selected, _signal: AbortSignal) => structuredClone(verify(state.data))), send: vi.fn(async (request: Capsule) => receipt(request)) };
  const c = new AccessExceptionController(api); c.start(); return { c, api, state };
}
async function load(s: ReturnType<typeof setup>) {
  s.c.editSelector('organizationId', selected.organizationId); s.c.editSelector('schoolId', selected.schoolId); await s.c.load();
}
async function prepare(s: ReturnType<typeof setup>) {
  await load(s); s.c.editDraft('reason', reason); s.c.editDraft('startsAt', '2026-11-02T12:00'); s.c.editDraft('expiresAt', '2026-11-09T12:00'); s.c.confirm(true);
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function settle() { for (let n = 0; n < 12; n++) await Promise.resolve(); }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('HQ access exceptions — explicit authorization, policy and target ownership', () => {
  it('starts idle and performs neither a read nor a command until explicit valid selector submission', async () => {
    const s = setup(); expect(s.c.snapshot()).toMatchObject({ status: 'idle', data: null, pending: null });
    expect(s.api.owner).not.toHaveBeenCalled(); await s.c.load(); await s.c.grant(); await s.c.revoke(); await s.c.retry();
    expect(s.api.owner).not.toHaveBeenCalled(); expect(s.api.send).not.toHaveBeenCalled(); expect(s.c.snapshot().message).toBe('INVALID_INPUT');
    await load(s); expect(s.api.owner).toHaveBeenCalledTimes(2); expect(s.api.read).toHaveBeenCalledTimes(1); expect(s.api.send).not.toHaveBeenCalled();
  });
  it('fails closed for denied, expired or changed owner identity before revealing records', async () => {
    for (const status of [401, 403]) {
      const s = setup(); s.api.owner.mockRejectedValue(new ExceptionError(status === 401 ? 'SIGNED_OUT' : 'FORBIDDEN', status)); await load(s);
      expect(s.c.snapshot()).toMatchObject({ hidden: true, data: null, status: status === 401 ? 'signed-out' : 'denied' }); expect(s.api.read).not.toHaveBeenCalled();
    }
    const s = setup(); s.api.owner.mockResolvedValueOnce(owner).mockResolvedValueOnce(otherOwner); await load(s);
    expect(s.c.snapshot()).toMatchObject({ hidden: true, data: null, status: 'denied' });
  });
  it('requires APPROVED plus effective ACTIVE and permits PROPOSED broader terms without treating 90 days as an approval', async () => {
    for (const effectiveStatus of ['ABSENT','PROPOSED','SCHEDULED','EXPIRED','WITHDRAWN','REVOKED','SUPERSEDED'] as const) {
      const snapshot = data(); snapshot.policy.effectiveStatus = effectiveStatus;
      if (effectiveStatus === 'ABSENT') { snapshot.policy.current = null; snapshot.policy.history = []; }
      if (['PROPOSED','WITHDRAWN','REVOKED'].includes(effectiveStatus)) snapshot.policy.current!.status = effectiveStatus as 'PROPOSED' | 'WITHDRAWN' | 'REVOKED';
      if (effectiveStatus === 'SCHEDULED') snapshot.policy.current!.validFrom = startsAt;
      if (effectiveStatus === 'EXPIRED') snapshot.policy.current!.validUntil = '2026-11-01T00:00:00.000Z';
      const s = setup(snapshot); await prepare(s); await s.c.grant(); expect(s.api.send).not.toHaveBeenCalled(); expect(s.c.canGrant()).toBe(false);
    }
    const s = setup(); await prepare(s); expect(s.c.snapshot().data?.policy.termsStatus).toBe('PROPOSED'); expect(s.c.canGrant()).toBe(true);
    s.c.editDraft('expiresAt', '2026-11-10T12:00'); s.c.confirm(true); await s.c.grant(); expect(s.api.send).not.toHaveBeenCalled();
    s.c.editDraft('expiresAt', '2026-11-09T12:00'); s.c.confirm(true); await s.c.grant(); expect(s.api.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(s.api.send.mock.calls[0]![0].body)).toMatchObject({ expectedEntitlementVersion: 3, startsAt, expiresAt, schoolId: selected.schoolId });
  });
  it('refuses invalid calendar, missing expiry, too-distant start and over-policy duration without dispatch', async () => {
    for (const fields of [{ startsAt: '2026-02-30T12:00' }, { expiresAt: '' }, { startsAt: '2026-12-02T12:00', expiresAt: '2026-12-03T12:00' }, { expiresAt: '2026-11-10T12:00' }]) {
      const s = setup(); await prepare(s);
      for (const [key, value] of Object.entries(fields)) s.c.editDraft(key as 'startsAt' | 'expiresAt', value);
      s.c.confirm(true); await s.c.grant(); expect(s.api.send).not.toHaveBeenCalled(); expect(s.c.snapshot().confirmed).toBe(false);
    }
  });
  it('invalidates loaded facts and acknowledgement on manual target changes; draft changes require a new confirmation', async () => {
    const s = setup(); await prepare(s); s.c.editDraft('reason', 'Updated reviewed internal purpose.'); await s.c.grant(); expect(s.api.send).not.toHaveBeenCalled();
    s.c.confirm(true); s.c.editSelector('schoolId', '30000000-0000-4000-8000-000000000002');
    expect(s.c.snapshot()).toMatchObject({ data: null, confirmed: false }); await s.c.grant(); expect(s.api.send).not.toHaveBeenCalled();
  });
  it('identifies known server-backed blockers without equating an unblocked read to full eligibility', async () => {
    const cases: Array<[string, (snapshot: Snapshot) => void]> = [
      ['AWAITING_PAYMENT', s => { s.exceptions.access.state = 'AWAITING_FIRST_PAYMENT'; }],
      ['SAAS_ENTITLEMENT_IN_EFFECT', s => { s.exceptions.access.entitlement = { ...entitlement(), status: 'ACTIVE', inEffect: true }; s.exceptions.access.source = 'PROVISIONED'; s.exceptions.access.capabilities = [...SAAS_PLAN_CAPABILITIES.COMPLETE]; }],
      ['SAAS_ACCESS_STATE_EXISTS', s => { s.exceptions.access.state = 'PAYMENT_ACTIVE'; }],
      ['SAAS_SUBSCRIPTION_EXISTS', s => { s.subscription.current = subscription(); s.subscription.alignment = 'ALIGNED'; }],
      ['SAAS_ACCESS_EXCEPTION_ACTIVE', s => { s.exceptions.exceptions = [openException()]; }],
      ['NO_ENTITLEMENT', s => { s.exceptions.access.entitlement = null; s.exceptions.access.state = 'NONE'; }],
      ['ORGANIZATION_INACTIVE', s => { s.subscription.organizationStatus = 'ARCHIVED'; }],
    ];
    for (const [expected, change] of cases) { const snapshot = data(); change(snapshot); expect(blockers(snapshot)).toContain(expected); const s = setup(snapshot); await prepare(s); await s.c.grant(); expect(s.api.send).not.toHaveBeenCalled(); }
  });
  it('revalidates policy, version and current principal before a fresh POST', async () => {
    for (const change of ['policy','version','owner']) {
      const s = setup(); await prepare(s);
      if (change === 'policy') s.state.data.policy.current!.approvalId = '50000000-0000-4000-8000-000000000002';
      if (change === 'version') s.state.data.exceptions.access.entitlement!.version++;
      if (change === 'owner') s.api.owner.mockResolvedValue(otherOwner);
      await s.c.grant(); expect(s.api.send).not.toHaveBeenCalled(); expect(s.c.snapshot().data).toBeNull();
    }
  });
  it('binds a successful receipt to current ownership after the command before revealing it', async () => {
    const s = setup(); await prepare(s); s.api.send.mockImplementationOnce(async request => { s.api.owner.mockResolvedValue(otherOwner); return receipt(request); });
    await s.c.grant(); expect(s.c.snapshot()).toMatchObject({ hidden: true, receipt: null, status: 'denied' });
    s.api.owner.mockResolvedValue(owner); await s.c.restore(); expect(s.c.snapshot().pending).toBe(s.api.send.mock.calls[0]![0]);
  });
  it('refuses a newly reduced approved window or owner change after fresh command preflight', async () => {
    const s = setup(); await prepare(s); s.state.data.policy.current!.maxDays = 3; await s.c.grant(); expect(s.api.send).not.toHaveBeenCalled();
    const changed = setup(); await prepare(changed); changed.api.owner.mockResolvedValueOnce(owner).mockResolvedValueOnce(otherOwner);
    await changed.c.grant(); expect(changed.api.read).toHaveBeenCalledTimes(2); expect(changed.api.send).not.toHaveBeenCalled(); expect(changed.c.snapshot()).toMatchObject({ hidden: true, data: null, status: 'denied' });
  });
});

describe('HQ access exceptions — immutable recovery and privacy lifetimes', () => {
  it('blocks duplicate clicks before authorization completes and creates one frozen request', async () => {
    const s = setup(); await prepare(s); const wait = deferred<string>(); s.api.owner.mockImplementationOnce(() => wait.promise);
    const run = s.c.grant(); await s.c.grant(); await s.c.load(); expect(s.api.send).not.toHaveBeenCalled();
    wait.resolve(owner); await run; expect(s.api.send).toHaveBeenCalledTimes(1); const request = s.api.send.mock.calls[0]![0];
    expect(Object.isFrozen(request)).toBe(true); expect(Object.isFrozen(request.target)).toBe(true);
  });
  it('retains an unknown capsule through concealment and restores only its original owner without automatic retry', async () => {
    const s = setup(); await prepare(s); s.api.send.mockRejectedValueOnce(new Error('lost response')); await s.c.grant();
    const request = s.api.send.mock.calls[0]![0]; expect(s.c.snapshot().pending).toBe(request); s.c.conceal(); expect(s.c.retainsRequest()).toBe(true);
    expect(s.c.snapshot()).toMatchObject({ hidden: true, pending: null, data: null, selectors: { organizationId: '', schoolId: '' }, draft: { reason: '' } });
    s.api.owner.mockResolvedValue(otherOwner); await s.c.restore(); expect(s.c.snapshot()).toMatchObject({ hidden: true, pending: null, data: null }); s.c.confirm(true); await s.c.retry(); expect(s.api.send).toHaveBeenCalledTimes(1);
    s.api.owner.mockResolvedValue(owner); await s.c.restore(); expect(s.c.snapshot().pending).toBe(request); expect(s.api.send).toHaveBeenCalledTimes(1);
    s.c.editDraft('reason', 'A replacement request is forbidden.'); s.c.editSelector('schoolId', '30000000-0000-4000-8000-000000000002');
    expect(s.c.snapshot().selectors).toEqual(selected); s.c.confirm(true); await s.c.retry(); expect(s.api.send.mock.calls[1]![0]).toBe(request); expect(s.c.retainsRequest()).toBe(false);
  });
  it('allows explicit exact recovery when current policy has become inactive, while blocking a fresh grant', async () => {
    const s = setup(); await prepare(s); s.api.send.mockRejectedValueOnce(new Error('lost')); await s.c.grant(); const request = s.api.send.mock.calls[0]![0];
    s.c.conceal(); s.state.data.policy.current!.status = 'WITHDRAWN'; s.state.data.policy.effectiveStatus = 'WITHDRAWN'; await s.c.restore();
    expect(s.c.canGrant()).toBe(false); expect(s.api.send).toHaveBeenCalledTimes(1); s.c.confirm(true); await s.c.retry(); expect(s.api.send.mock.calls[1]![0]).toBe(request);
  });
  it('keeps the physical command locked behind privacy until settlement, discarding late receipts', async () => {
    const s = setup(); await prepare(s); const wait = deferred<Receipt>(); s.api.send.mockImplementationOnce(() => wait.promise);
    const run = s.c.grant(); await settle(); expect(s.api.send).toHaveBeenCalledTimes(1); const request = s.api.send.mock.calls[0]![0];
    s.c.conceal(); const reads = s.api.owner.mock.calls.length; await s.c.restore(); await s.c.retry(); expect(s.api.owner).toHaveBeenCalledTimes(reads);
    expect(s.c.snapshot()).toMatchObject({ hidden: true, busy: true, receipt: null }); wait.resolve(receipt(request)); await run;
    expect(s.c.snapshot()).toMatchObject({ hidden: true, busy: false, receipt: null }); await s.c.restore(); expect(s.c.snapshot().pending).toBe(request);
  });
  it('rejects late read and command-preflight responses after concealment or unmount', async () => {
    const s = setup(), wait = deferred<Snapshot>(); s.api.read.mockImplementationOnce(() => wait.promise);
    s.c.editSelector('organizationId', selected.organizationId); s.c.editSelector('schoolId', selected.schoolId); const read = s.c.load(); await settle(); s.c.conceal(); wait.resolve(data()); await read;
    expect(s.c.snapshot()).toMatchObject({ hidden: true, data: null, busy: false });
    const fresh = setup(); await prepare(fresh); const gate = deferred<Snapshot>(); fresh.api.read.mockImplementationOnce(() => gate.promise);
    const run = fresh.c.grant(); await settle(); fresh.c.stop(); gate.resolve(data()); await run; expect(fresh.api.send).not.toHaveBeenCalled(); expect(fresh.c.snapshot().receipt).toBeNull();
  });
  it('stops a new POST when blur arrives while the command preflight read is unresolved', async () => {
    const s = setup(); await prepare(s); const wait = deferred<Snapshot>(), browser = new EventTarget(), doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    s.api.read.mockImplementationOnce(() => wait.promise); const hide = vi.fn(), unbind = bindExceptionPrivacy(s.c, hide, browser, doc);
    const run = s.c.grant(); await settle(); const preflightSignal = s.api.read.mock.calls[1]![1]; browser.dispatchEvent(new Event('blur'));
    expect(hide).toHaveBeenCalledTimes(1); expect(preflightSignal.aborted).toBe(true); expect(s.c.snapshot()).toMatchObject({ hidden: true, busy: true, data: null, pending: null, receipt: null, selectors: { organizationId: '', schoolId: '' } });
    wait.resolve(data()); await run; expect(s.api.send).not.toHaveBeenCalled(); expect(s.c.snapshot().busy).toBe(false); expect(s.c.retainsRequest()).toBe(false); unbind();
  });
  it('retains unknown requests on replay rejection but permits a fresh read after an initial definitive refusal', async () => {
    const first = setup(); await prepare(first); first.api.send.mockRejectedValueOnce(new ExceptionError('SAAS_CHECKOUT_OPEN', 422)); await first.c.grant();
    expect(first.c.snapshot()).toMatchObject({ pending: null, data: null, message: 'SAAS_CHECKOUT_OPEN' });
    const s = setup(); await prepare(s); s.api.send.mockRejectedValueOnce(new Error('unknown')); await s.c.grant(); const request = s.c.snapshot().pending;
    s.api.send.mockRejectedValueOnce(new ExceptionError('SAAS_EXCEPTION_POLICY_REQUIRED', 422)); s.c.confirm(true); await s.c.retry(); expect(s.c.snapshot().pending).toBe(request);
  });
  it('conceals on command access denials while preserving the original immutable retry', async () => {
    for (const status of [401, 403]) {
      const s = setup(); await prepare(s); s.api.send.mockRejectedValueOnce(new ExceptionError(status === 401 ? 'SIGNED_OUT' : 'FORBIDDEN', status)); await s.c.grant();
      expect(s.c.snapshot()).toMatchObject({ hidden: true, receipt: null, data: null, status: status === 401 ? 'signed-out' : 'denied' });
      await s.c.restore(); expect(s.c.snapshot().pending).toBe(s.api.send.mock.calls[0]![0]);
    }
  });
  it('synchronously shields DOM before clearing state on every privacy signal and never reads on focus or restored visibility', async () => {
    for (const event of ['blur','pagehide',HON_SESSION_INVALIDATED_EVENT,HON_SCHOOL_CONTEXT_CHANGED_EVENT,'visibilitychange']) {
      const s = setup(); await prepare(s); const browser = new EventTarget(), doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
      const dom = { hidden: false, inert: false }; const hide = vi.fn(() => { expect(s.c.snapshot().data).not.toBeNull(); dom.hidden = true; dom.inert = true; });
      const unbind = bindExceptionPrivacy(s.c, hide, browser, doc);
      if (event === 'visibilitychange') { doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event(event)); } else browser.dispatchEvent(new Event(event));
      expect(dom).toEqual({ hidden: true, inert: true }); expect(s.c.snapshot()).toMatchObject({ hidden: true, data: null, confirmed: false });
      const count = s.api.owner.mock.calls.length; browser.dispatchEvent(new Event('focus')); doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange'));
      await settle(); expect(s.api.owner).toHaveBeenCalledTimes(count); hide.mockImplementation(() => {}); unbind();
    }
  });
  it('does not restore a receipt or command memory after stop and a new instance', async () => {
    const s = setup(); await prepare(s); s.api.send.mockRejectedValueOnce(new Error('unknown')); await s.c.grant(); s.c.stop(); expect(s.c.retainsRequest()).toBe(false);
    const fresh = new AccessExceptionController(s.api); fresh.start(); expect(fresh.snapshot()).toMatchObject({ pending: null, data: null, receipt: null });
    await fresh.retry(); expect(s.api.send).toHaveBeenCalledTimes(1);
  });
});

describe('HQ access exceptions — revocation stays separate from policy approval and new grants', () => {
  it('revokes only a selected current-school GRANTED record, even without an active new-grant policy', async () => {
    const snapshot = data(); snapshot.policy.current = null; snapshot.policy.history = []; snapshot.policy.effectiveStatus = 'ABSENT'; snapshot.exceptions.exceptions = [openException()];
    const s = setup(snapshot); await load(s); expect(s.c.canGrant()).toBe(false);
    s.c.selectRevoke('40000000-0000-4000-8000-000000000002'); s.c.editRevokeReason('Explicitly ending the approved pilot.'); s.c.confirm(true); await s.c.revoke(); expect(s.api.send).not.toHaveBeenCalled();
    s.c.selectRevoke(exceptionId); s.c.editRevokeReason('Explicitly ending the approved pilot.'); s.c.confirm(true); await s.c.revoke();
    expect(s.api.send).toHaveBeenCalledTimes(1); expect(s.api.send.mock.calls[0]![0]).toMatchObject({ kind: 'revoke', exceptionId, target: selected });
    expect(JSON.parse(s.api.send.mock.calls[0]![0].body)).toEqual({ reason: 'Explicitly ending the approved pilot.' });
  });
  it('refuses to dispatch a revoke when the fresh read says the selected exception has already ended', async () => {
    const snapshot = data(); snapshot.exceptions.exceptions = [openException()]; const s = setup(snapshot); await load(s);
    s.c.selectRevoke(exceptionId); s.c.editRevokeReason('Explicitly ending the approved pilot.'); s.c.confirm(true); s.state.data.exceptions.exceptions = [];
    await s.c.revoke(); expect(s.api.send).not.toHaveBeenCalled(); expect(s.c.snapshot()).toMatchObject({ data: null, message: 'RELOAD_REQUIRED' });
  });
  it('does not let a shared acknowledgement dispatch a stale grant after switching to revoke', async () => {
    const snapshot = data(); snapshot.exceptions.exceptions = [{ ...openException(), lifecycle: 'SUPERSEDED' }]; const s = setup(snapshot); await prepare(s);
    expect(s.c.canGrant()).toBe(true); s.c.selectRevoke(exceptionId); s.c.editRevokeReason('Explicitly ending the superseded exception.'); s.c.confirm(true);
    await s.c.grant(); expect(s.api.send).not.toHaveBeenCalled(); await s.c.revoke(); expect(s.api.send.mock.calls[0]![0].kind).toBe('revoke');
  });
  it('clears acknowledgement when revocation is cancelled and rejects records from another school', async () => {
    const snapshot = data(); snapshot.exceptions.exceptions = [{ ...openException(), schoolId: '30000000-0000-4000-8000-000000000002', lifecycle: 'SUPERSEDED' }]; const s = setup(snapshot); await prepare(s);
    s.c.selectRevoke(exceptionId); expect(s.c.snapshot().revokeId).toBe(''); await s.c.revoke(); expect(s.api.send).not.toHaveBeenCalled();
    s.state.data.exceptions.exceptions = [{ ...openException(), lifecycle: 'SUPERSEDED' }]; await s.c.load(); s.c.selectRevoke(exceptionId); s.c.editRevokeReason(reason); s.c.confirm(true); s.c.cancelRevoke();
    expect(s.c.snapshot()).toMatchObject({ revokeId: '', revokeReason: '', confirmed: false }); await s.c.grant(); expect(s.api.send).not.toHaveBeenCalled();
  });
});
