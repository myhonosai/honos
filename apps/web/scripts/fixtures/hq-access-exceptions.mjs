/** Synthetic browser state only. No database, policy approval, provider or real entitlement. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  SAAS_PLAN_CAPABILITIES, validateSaasExceptionPolicyView, validateSaasAccessExceptionsView,
  validateSaasOrganizationSubscription, validateSaasAccessExceptionGrantInput, validateSaasAccessExceptionRevokeInput,
  validateSaasAccessExceptionGrantReceipt, validateSaasAccessExceptionRevokeReceipt,
} from '@hon/contracts';

export const target = Object.freeze({ organizationId: '20000000-0000-4000-8000-000000000001', schoolId: '30000000-0000-4000-8000-000000000001' });
export const ownerId = '10000000-0000-4000-8000-000000000001';
export const otherOwnerId = '10000000-0000-4000-8000-000000000002';
const day = 86400000, iso = value => new Date(value).toISOString();
export function createExceptionFixture(policyStatus = 'ACTIVE') {
  const now = Math.floor(Date.now() / 60000) * 60000, at = iso(now);
  const prior = { tier: 'COMPLETE', status: 'SUSPENDED', effectiveFrom: iso(now - 30 * day), effectiveUntil: null, version: 3, inEffect: false };
  const decision = { approvalId: '50000000-0000-4000-8000-000000000001', revision: 2, status: 'APPROVED', termsVersion: 1, maxDays: 7,
    validFrom: iso(now - day), validUntil: iso(now + 60 * day), reason: 'Synthetic exception-only policy fixture.', actorPrincipalId: ownerId, recordedAt: at };
  let status = policyStatus, entitlement = structuredClone(prior), exceptions = [], mutations = 0;
  const claims = new Map(), attempts = [];
  const access = () => ({ organizationId: target.organizationId, state: 'PROVISIONED', source: 'NONE', entitlement: structuredClone(entitlement), capabilities: [], paidAccessProgram: 'INACTIVE' });
  function policy() {
    const current = status === 'ABSENT' ? null : { ...decision, status: status === 'ACTIVE' ? 'APPROVED' : status };
    return validateSaasExceptionPolicyView({ scope: 'ACCESS_EXCEPTIONS_ONLY', current, effectiveStatus: status, history: current ? [current] : [], historyLimit: 100, asOf: at,
      termsStatus: 'PROPOSED', paidAccessProgram: 'INACTIVE', aiCreditProgram: 'INACTIVE' });
  }
  function history() { return validateSaasAccessExceptionsView({ organizationId: target.organizationId, access: access(), exceptions: structuredClone(exceptions), asOf: at }); }
  function subscription() {
    const { inEffect: _effect, ...view } = entitlement;
    return validateSaasOrganizationSubscription({ organizationId: target.organizationId, organizationName: 'Synthetic browser organization', organizationStatus: 'ACTIVE', entitlement: view,
      current: null, alignment: 'NO_SUBSCRIPTION', history: [], founderReservations: [], chargesEnabled: false });
  }
  const refusal = code => Object.assign(new Error(code), { code, status: 422 });
  function command(kind, id, input, key, principalId = ownerId) {
    assert.match(key, /^[0-9a-f-]{36}$/i);
    attempts.push({ kind, id, input: structuredClone(input), key, principalId });
    const fingerprint = JSON.stringify({ kind, id, input, principalId });
    if (claims.has(key)) {
      const claim = claims.get(key); assert.equal(fingerprint, claim.fingerprint, 'A retained key changed its exact request');
      return { ...structuredClone(claim.receipt), replayed: true };
    }
    let receipt;
    if (kind === 'grant') {
      const fields = validateSaasAccessExceptionGrantInput(input);
      if (status !== 'ACTIVE') throw refusal('SAAS_EXCEPTION_POLICY_REQUIRED');
      if (fields.schoolId !== target.schoolId) throw refusal('SAAS_UNAVAILABLE');
      if (fields.expectedEntitlementVersion !== entitlement.version) throw refusal('SAAS_VERSION_CONFLICT');
      if (exceptions.some(x => x.status === 'GRANTED')) throw refusal('SAAS_ACCESS_EXCEPTION_ACTIVE');
      if (Date.parse(fields.expiresAt) - Date.parse(fields.startsAt) > decision.maxDays * day) throw refusal('SAAS_EXCEPTION_TOO_LONG');
      assert(Date.parse(fields.startsAt) > now, 'This fixture only models future scheduled grants');
      const { expectedEntitlementVersion: _version, ...body } = fields;
      const granted = { tier: fields.scopeTier, status: 'ACTIVE', effectiveFrom: fields.startsAt, effectiveUntil: fields.expiresAt, version: entitlement.version + 1, inEffect: false };
      const exception = { exceptionId: randomUUID(), organizationId: target.organizationId, ...body, capabilities: [...SAAS_PLAN_CAPABILITIES[fields.scopeTier]], aiCredits: 'NONE',
        policyVersion: 1, maxDays: decision.maxDays, status: 'GRANTED', lifecycle: 'SCHEDULED', grantedByPrincipalId: principalId, grantedAt: at, priorEntitlement: structuredClone(entitlement), grantedEntitlement: granted,
        endReason: null, endNote: null, endEntitlement: null, endedByPrincipalId: null, endedAt: null,
        governingPolicy: { approvalId: decision.approvalId, revision: decision.revision, termsVersion: 1, maxDays: decision.maxDays } };
      entitlement = granted; exceptions.unshift(exception);
      receipt = validateSaasAccessExceptionGrantReceipt({ exception: structuredClone(exception), access: access(), replayed: false });
    } else {
      const body = validateSaasAccessExceptionRevokeInput(input), exception = exceptions.find(x => x.exceptionId === id);
      if (!exception || exception.status !== 'GRANTED') throw refusal('SAAS_EXCEPTION_ENDED');
      entitlement = { ...prior, version: entitlement.version + 1 };
      Object.assign(exception, { status: 'ENDED', lifecycle: 'REVOKED', endReason: 'REVOKED', endNote: body.reason, endEntitlement: structuredClone(entitlement), endedByPrincipalId: principalId, endedAt: at });
      receipt = validateSaasAccessExceptionRevokeReceipt({ exception: structuredClone(exception), entitlementSuspended: true, access: access(), replayed: false });
    }
    mutations++; claims.set(key, { fingerprint, receipt: structuredClone(receipt) }); return receipt;
  }
  // Validate every seed before exposing it to a browser context.
  policy(); history(); subscription();
  return { policy, history, subscription, command, attempts, get mutations() { return mutations; }, setPolicy(value) { status = value; policy(); },
    startsAt: iso(now + day).slice(0, 16), expiresAt: iso(now + 4 * day).slice(0, 16) };
}
