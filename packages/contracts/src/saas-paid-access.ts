// HON paid access B6A closed contracts: the central access authority (how an organization's entitlement was
// obtained) and the inactive first-payment activation pathway. The server alone decides tier, capabilities
// and allowance from the frozen checkout and provider-verified evidence; nothing the browser submits (price,
// school, success URL, entitlement claim) is authority. Every command is refused while the paid-access program
// is INACTIVE, which it is until the owner approves the policy and a reviewed migration enables it.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsNullable as nullable, championsRecord as record } from './champions-club.js';
import { SAAS_PLAN_CAPABILITIES } from './saas-billing.js';
import { SAAS_ORGANIZATION_ACCESS_STATES, validateSaasEntitlementView, type SaasEntitlementView,
  type SaasOrganizationAccessState } from './saas-school-billing.js';

const has = (list: readonly unknown[], value: unknown) => list.includes(value);
const code = (v: unknown): v is string => typeof v === 'string' && /^[A-Z_]{3,60}$/.test(v);

export type SaasAccessSource = 'NONE' | 'PROVISIONED' | 'PAYMENT_ACTIVATED';
export type SaasAccessTransitionKind = 'AWAITING_FIRST_PAYMENT' | 'FIRST_PAYMENT_ACTIVATION';
export type SaasAccessTransitionOutcome = 'APPLIED' | 'NEEDS_REVIEW';

// ---------- inputs ----------
export interface SaasAccessAwaitInput { expectedEntitlementVersion: number }
export interface SaasAccessRetryInput { expectedCheckoutVersion: number }

// ---------- responses ----------
export interface SaasOrganizationAccess {
  organizationId: string; state: SaasOrganizationAccessState; source: SaasAccessSource; entitlement: SaasEntitlementView | null;
  capabilities: string[]; paidAccessProgram: 'INACTIVE' | 'ACTIVE';
}
export interface SaasAccessTransition {
  transitionId: string; kind: SaasAccessTransitionKind; outcome: SaasAccessTransitionOutcome; reason: string; checkoutId: string | null;
  subscriptionId: string | null; allowanceId: string | null; providerEventId: string | null; priorEntitlement: SaasEntitlementView | null;
  nextEntitlement: SaasEntitlementView | null; occurredAt: string;
}
export interface SaasOrganizationAccessView extends SaasOrganizationAccess { transitions: SaasAccessTransition[]; asOf: string }
export interface SaasAccessAwaitReceipt { access: SaasOrganizationAccess; replayed: boolean }
export interface SaasAccessRetryReceipt {
  outcome: SaasAccessTransitionOutcome; detail: string; checkoutId: string; access: SaasOrganizationAccess; replayed: boolean;
}

function version(value: unknown, key: string): number {
  const r = record(value, invalid); exactKeys(r, [key], invalid);
  if (!isInt(r[key], 1, 999_999_999)) invalid();
  return r[key] as number;
}
export function validateSaasAccessAwaitInput(value: unknown): SaasAccessAwaitInput {
  return { expectedEntitlementVersion: version(value, 'expectedEntitlementVersion') };
}
export function validateSaasAccessRetryInput(value: unknown): SaasAccessRetryInput {
  return { expectedCheckoutVersion: version(value, 'expectedCheckoutVersion') };
}

function access(value: unknown, extra: readonly string[] = []): Record<string, unknown> {
  const r = record(value, drift);
  exactKeys(r, ['organizationId','state','source','entitlement','capabilities','paidAccessProgram', ...extra], drift);
  validateSaasEntitlementView(r.entitlement);
  const ent = r.entitlement as SaasEntitlementView | null;
  const inEffect = ent?.inEffect === true;
  if (!isUuid(r.organizationId) || !has(SAAS_ORGANIZATION_ACCESS_STATES, r.state) || !has(['INACTIVE','ACTIVE'], r.paidAccessProgram)
    || (ent === null) !== (r.state === 'NONE')
    || r.source !== (!inEffect ? 'NONE' : r.state === 'PAYMENT_ACTIVE' ? 'PAYMENT_ACTIVATED' : 'PROVISIONED')
    // Awaiting a first payment never has access in effect.
    || (r.state === 'AWAITING_FIRST_PAYMENT' && inEffect)
    // Capabilities are exactly the plan's when the entitlement is in effect, otherwise none.
    || !Array.isArray(r.capabilities)
    || r.capabilities.join(',') !== (inEffect ? (SAAS_PLAN_CAPABILITIES[ent!.tier] ?? []).join(',') : '')) drift();
  return r;
}
export function validateSaasOrganizationAccess(value: unknown): SaasOrganizationAccess {
  return access(value) as unknown as SaasOrganizationAccess;
}
export function validateSaasOrganizationAccessView(value: unknown): SaasOrganizationAccessView {
  const r = access(value, ['transitions','asOf']);
  if (!isTimestamp(r.asOf) || !Array.isArray(r.transitions) || r.transitions.length > 50) drift();
  (r.transitions as unknown[]).forEach(v => {
    const t = record(v, drift);
    exactKeys(t, ['transitionId','kind','outcome','reason','checkoutId','subscriptionId','allowanceId','providerEventId','priorEntitlement',
      'nextEntitlement','occurredAt'], drift);
    validateSaasEntitlementView(t.priorEntitlement); validateSaasEntitlementView(t.nextEntitlement);
    if (!isUuid(t.transitionId) || !has(['AWAITING_FIRST_PAYMENT','FIRST_PAYMENT_ACTIVATION'], t.kind) || !has(['APPLIED','NEEDS_REVIEW'], t.outcome)
      || !code(t.reason) || !nullable(t.checkoutId, isUuid) || !nullable(t.subscriptionId, isUuid) || !nullable(t.allowanceId, isUuid)
      || !nullable(t.providerEventId, (x): x is string => typeof x === 'string' && /^evt_[A-Za-z0-9_]{1,200}$/.test(x))
      || (t.kind === 'FIRST_PAYMENT_ACTIVATION') !== (t.checkoutId !== null) || (t.outcome === 'APPLIED') !== (t.nextEntitlement !== null)
      || !isTimestamp(t.occurredAt)) drift();
  });
  return r as unknown as SaasOrganizationAccessView;
}
export function validateSaasAccessAwaitReceipt(value: unknown): SaasAccessAwaitReceipt {
  const r = record(value, drift); exactKeys(r, ['access','replayed'], drift);
  validateSaasOrganizationAccess(r.access);
  if (typeof r.replayed !== 'boolean' || (r.access as SaasOrganizationAccess).state !== 'AWAITING_FIRST_PAYMENT') drift();
  return r as unknown as SaasAccessAwaitReceipt;
}
export function validateSaasAccessRetryReceipt(value: unknown): SaasAccessRetryReceipt {
  const r = record(value, drift); exactKeys(r, ['outcome','detail','checkoutId','access','replayed'], drift);
  validateSaasOrganizationAccess(r.access);
  const a = r.access as SaasOrganizationAccess;
  if (!has(['APPLIED','NEEDS_REVIEW'], r.outcome) || !code(r.detail) || !isUuid(r.checkoutId) || typeof r.replayed !== 'boolean'
    // Activation is reported only when the access state actually became payment-active.
    || (r.outcome === 'APPLIED' && r.detail === 'ACCESS_ACTIVATED') !== (a.state === 'PAYMENT_ACTIVE')) drift();
  return r as unknown as SaasAccessRetryReceipt;
}
