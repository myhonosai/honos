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

// ---------- D9: HQ-owner access exceptions ----------
// Time-limited free access an HQ owner grants one school for internal testing, a product demonstration or an approved
// pilot. The server decides eligibility, the window cap (policy exception_max_days) and the scope's capabilities; an
// exception never carries AI credits and is never a purchase basis.
export const SAAS_ACCESS_EXCEPTION_PURPOSES = ['INTERNAL_TESTING','PRODUCT_DEMONSTRATION','APPROVED_PILOT'] as const;
export type SaasAccessExceptionPurpose = typeof SAAS_ACCESS_EXCEPTION_PURPOSES[number];
export type SaasAccessExceptionLifecycle = 'SCHEDULED' | 'IN_EFFECT' | 'EXPIRED' | 'SUPERSEDED' | 'REVOKED';
const EXCEPTION_LIFECYCLES: readonly SaasAccessExceptionLifecycle[] = ['SCHEDULED','IN_EFFECT','EXPIRED','SUPERSEDED','REVOKED'];

export interface SaasAccessExceptionGrantInput {
  schoolId: string; purpose: SaasAccessExceptionPurpose; reason: string; scopeTier: 'CORE' | 'COMPLETE';
  startsAt: string; expiresAt: string; expectedEntitlementVersion: number;
}
export interface SaasAccessExceptionRevokeInput { reason: string }
export interface SaasAccessException {
  exceptionId: string; organizationId: string; schoolId: string; purpose: SaasAccessExceptionPurpose; reason: string;
  scopeTier: 'CORE' | 'COMPLETE'; capabilities: string[]; aiCredits: 'NONE'; startsAt: string; expiresAt: string;
  policyVersion: number; maxDays: number; status: 'GRANTED' | 'ENDED'; lifecycle: SaasAccessExceptionLifecycle;
  grantedByPrincipalId: string; grantedAt: string; priorEntitlement: SaasEntitlementView | null; grantedEntitlement: SaasEntitlementView;
  endReason: 'REVOKED' | 'EXPIRED' | 'SUPERSEDED' | null; endNote: string | null; endEntitlement: SaasEntitlementView | null;
  endedByPrincipalId: string | null; endedAt: string | null;
  // Absent only on exact pre-D10 receipts; null identifies an unapproved historical row.
  governingPolicy?: { approvalId: string; revision: number; termsVersion: number; maxDays: number } | null;
}
export interface SaasAccessExceptionsView { organizationId: string; access: SaasOrganizationAccess; exceptions: SaasAccessException[]; asOf: string }
export interface SaasAccessExceptionGrantReceipt { exception: SaasAccessException; access: SaasOrganizationAccess; replayed: boolean }
export interface SaasAccessExceptionRevokeReceipt {
  exception: SaasAccessException; entitlementSuspended: boolean; access: SaasOrganizationAccess; replayed: boolean;
}
export interface SaasAccessExceptionCloseReceipt { closed: SaasAccessException[]; asOf: string; replayed: boolean }

const note = (v: unknown): v is string => typeof v === 'string' && v === v.trim() && v.length >= 10 && v.length <= 500;

export function validateSaasAccessExceptionGrantInput(value: unknown): SaasAccessExceptionGrantInput {
  const r = record(value, invalid);
  exactKeys(r, ['schoolId','purpose','reason','scopeTier','startsAt','expiresAt','expectedEntitlementVersion'], invalid);
  if (!isUuid(r.schoolId) || !has(SAAS_ACCESS_EXCEPTION_PURPOSES, r.purpose) || !note(r.reason) || !has(['CORE','COMPLETE'], r.scopeTier)
    || !isTimestamp(r.startsAt) || !isTimestamp(r.expiresAt) || Date.parse(r.expiresAt as string) <= Date.parse(r.startsAt as string)
    || !isInt(r.expectedEntitlementVersion, 1, 999_999_999)) invalid();
  return r as unknown as SaasAccessExceptionGrantInput;
}
export function validateSaasAccessExceptionRevokeInput(value: unknown): SaasAccessExceptionRevokeInput {
  const r = record(value, invalid); exactKeys(r, ['reason'], invalid);
  if (!note(r.reason)) invalid();
  return { reason: r.reason as string };
}
export function validateSaasAccessExceptionCloseInput(value: unknown): Record<string, never> {
  exactKeys(record(value, invalid), [], invalid);
  return {};
}

function exception(value: unknown): SaasAccessException {
  const x = record(value, drift);
  exactKeys(x, ['exceptionId','organizationId','schoolId','purpose','reason','scopeTier','capabilities','aiCredits','startsAt','expiresAt',
    'policyVersion','maxDays','status','lifecycle','grantedByPrincipalId','grantedAt','priorEntitlement','grantedEntitlement','endReason','endNote',
    'endEntitlement','endedByPrincipalId','endedAt', ...(Object.hasOwn(x,'governingPolicy') ? ['governingPolicy'] : [])], drift);
  if (x.governingPolicy !== undefined && x.governingPolicy !== null) {
    const p = record(x.governingPolicy, drift); exactKeys(p,['approvalId','revision','termsVersion','maxDays'],drift);
    if (!isUuid(p.approvalId) || !isInt(p.revision,1,999_999_999) || p.termsVersion !== x.policyVersion || p.maxDays !== x.maxDays) drift();
  }
  validateSaasEntitlementView(x.priorEntitlement); validateSaasEntitlementView(x.grantedEntitlement); validateSaasEntitlementView(x.endEntitlement);
  const granted = x.grantedEntitlement as SaasEntitlementView | null;
  const ended = x.status === 'ENDED';
  if (!isUuid(x.exceptionId) || !isUuid(x.organizationId) || !isUuid(x.schoolId) || !has(SAAS_ACCESS_EXCEPTION_PURPOSES, x.purpose) || !note(x.reason)
    || !has(['CORE','COMPLETE'], x.scopeTier) || !Array.isArray(x.capabilities)
    || x.capabilities.join(',') !== (SAAS_PLAN_CAPABILITIES[x.scopeTier as 'CORE' | 'COMPLETE'] ?? []).join(',')
    // An exception never carries premium AI credits.
    || x.aiCredits !== 'NONE'
    || !isTimestamp(x.startsAt) || !isTimestamp(x.expiresAt) || Date.parse(x.expiresAt as string) <= Date.parse(x.startsAt as string)
    || !isInt(x.policyVersion, 1, 999_999) || !isInt(x.maxDays, 1, 90)
    || Date.parse(x.expiresAt as string) - Date.parse(x.startsAt as string) > (x.maxDays as number) * 86_400_000
    || !has(['GRANTED','ENDED'], x.status) || !has(EXCEPTION_LIFECYCLES, x.lifecycle)
    || granted === null || granted.tier !== x.scopeTier || granted.status !== 'ACTIVE' || granted.effectiveUntil !== x.expiresAt
    || !isUuid(x.grantedByPrincipalId) || !isTimestamp(x.grantedAt)
    || ended !== (x.endReason !== null) || ended !== (x.endedAt !== null) || ended !== (x.endedByPrincipalId !== null)
    || (ended && (x.lifecycle !== x.endReason || x.endEntitlement === null)) || (!ended && x.endEntitlement !== null)
    || !nullable(x.endReason, (v): v is string => has(['REVOKED','EXPIRED','SUPERSEDED'], v))
    || (x.endReason === 'REVOKED') !== (x.endNote !== null) || !nullable(x.endNote, note)
    || !nullable(x.endedByPrincipalId, isUuid) || !nullable(x.endedAt, isTimestamp)
    || (!ended && x.lifecycle === 'REVOKED')) drift();
  return x as unknown as SaasAccessException;
}
export function validateSaasAccessExceptionsView(value: unknown): SaasAccessExceptionsView {
  const r = record(value, drift); exactKeys(r, ['organizationId','access','exceptions','asOf'], drift);
  validateSaasOrganizationAccess(r.access);
  if (!isUuid(r.organizationId) || (r.access as SaasOrganizationAccess).organizationId !== r.organizationId || !isTimestamp(r.asOf)
    || !Array.isArray(r.exceptions) || r.exceptions.length > 50) drift();
  (r.exceptions as unknown[]).forEach(v => { if (exception(v).organizationId !== r.organizationId) drift(); });
  // At most one open exception per organization.
  if ((r.exceptions as SaasAccessException[]).filter(x => x.status === 'GRANTED').length > 1) drift();
  return r as unknown as SaasAccessExceptionsView;
}
export function validateSaasAccessExceptionGrantReceipt(value: unknown): SaasAccessExceptionGrantReceipt {
  const r = record(value, drift); exactKeys(r, ['exception','access','replayed'], drift);
  const x = exception(r.exception); validateSaasOrganizationAccess(r.access);
  if (typeof r.replayed !== 'boolean' || x.organizationId !== (r.access as SaasOrganizationAccess).organizationId) drift();
  return r as unknown as SaasAccessExceptionGrantReceipt;
}
export function validateSaasAccessExceptionRevokeReceipt(value: unknown): SaasAccessExceptionRevokeReceipt {
  const r = record(value, drift); exactKeys(r, ['exception','entitlementSuspended','access','replayed'], drift);
  const x = exception(r.exception); validateSaasOrganizationAccess(r.access);
  if (typeof r.replayed !== 'boolean' || typeof r.entitlementSuspended !== 'boolean' || x.status !== 'ENDED' || x.endReason !== 'REVOKED'
    || x.organizationId !== (r.access as SaasOrganizationAccess).organizationId
    // A revoked exception that still held the entitlement leaves no access in effect.
    || (r.entitlementSuspended && (r.access as SaasOrganizationAccess).entitlement?.inEffect !== false)) drift();
  return r as unknown as SaasAccessExceptionRevokeReceipt;
}
export function validateSaasAccessExceptionCloseReceipt(value: unknown): SaasAccessExceptionCloseReceipt {
  const r = record(value, drift); exactKeys(r, ['closed','asOf','replayed'], drift);
  if (!Array.isArray(r.closed) || r.closed.length > 200 || !isTimestamp(r.asOf) || typeof r.replayed !== 'boolean') drift();
  (r.closed as unknown[]).forEach(v => { const x = exception(v); if (x.status !== 'ENDED' || x.endReason === 'REVOKED') drift(); });
  return r as unknown as SaasAccessExceptionCloseReceipt;
}
