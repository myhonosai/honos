/** HON OS schedule billing, piece 1 (0230): TEST-only schedule binding, verified paid-period evidence and the binding
 * lifecycle. Billing outcome only: a binding status never implies access, which is a separate outcome (`access`).
 * It never opens checkout, collects money, changes entitlements, or grants paid access. */
import { championsExactKeys as keys, championsIsInt as integer, championsIsTimestamp as timestamp,
  championsIsUuid as uuid, championsNullable as nullable, championsRecord as record } from './champions-club.js';

export const SAAS_SCHEDULE_BINDING_CONFIRMATION = 'BIND_TEST_ONLY_SCHEDULE_NO_COLLECTION' as const;
export const SAAS_SCHEDULE_BINDING_STATUSES = ['PENDING_PROVIDER_BINDING','BOUND_TEST_ONLY','ACTIVE','NEEDS_REVIEW','EXPIRED_UNPAID','VOIDED_PROVIDER_FAILED','CANCELLED_BEFORE_PAYMENT','REFUNDED_ENDED','SWITCHED_TO_LIFETIME'] as const;
export type SaasScheduleBindingStatus = typeof SAAS_SCHEDULE_BINDING_STATUSES[number];
export const SAAS_SCHEDULE_BINDING_REASONS = ['BINDING_REQUESTED','BINDING_OBSERVED_TEST_ONLY','FIRST_PAYMENT_VERIFIED','PROVIDER_CONFIRMED_NOT_CREATED',
  'PROVIDER_TERMS_MISMATCH','UNPAID_WINDOW_ELAPSED','AMOUNT_MISMATCH','OVERLAPPING_COVERED_PERIOD','REVERSAL_REVIEW_REQUIRED','UNLINKED_REVERSAL','PURCHASER_CANCELLED_BEFORE_PAYMENT','PERIOD_INTERVAL_MISMATCH','REVIEW_REFUND_VERIFIED','FOUNDER_SPOT_UNAVAILABLE','LIFETIME_SALE_LIMIT_REACHED','LIFETIME_REFUND_IN_WINDOW','SWITCHED_TO_LIFETIME','LIFETIME_SWITCH_SOURCE_CHANGED'] as const;
export type SaasScheduleBindingReason = typeof SAAS_SCHEDULE_BINDING_REASONS[number];
export type SaasScheduleEvidenceOutcome = 'APPLIED' | 'ALREADY_APPLIED' | 'ATTEMPT_FAILED' | 'NEEDS_REVIEW';
/** ENDED (0309): a verified refund inside the refund window ended a lifetime plan. */
export type SaasScheduleAccessActivation = 'APPLIED' | 'EXTENDED' | 'NEEDS_REVIEW' | 'NOT_ATTEMPTED' | 'ENDED';
const TERMINAL: readonly string[] = ['EXPIRED_UNPAID','VOIDED_PROVIDER_FAILED','CANCELLED_BEFORE_PAYMENT','REFUNDED_ENDED','SWITCHED_TO_LIFETIME'];
const BOUND: readonly string[] = ['BOUND_TEST_ONLY','ACTIVE','EXPIRED_UNPAID','CANCELLED_BEFORE_PAYMENT','REFUNDED_ENDED','SWITCHED_TO_LIFETIME'];

export interface SaasScheduleBindingInput {
  generationId: string;
  generationDigest: string;
  confirmation: typeof SAAS_SCHEDULE_BINDING_CONFIRMATION;
}

export interface SaasScheduleRequirements {
  generationId: string;
  generationDigest: string;
  organizationId: string;
  schoolId: string;
  acceptanceId: string;
  acceptanceDigest: string;
  scheduleDigest: string;
  offerId: string;
  renewalOfferId: string;
  offerSetId: string;
  offerSetVersion: number;
  acceptedOfferDigest: string;
  disclosureVersion: string;
  disclosureText: string;
  termsReference: string;
  refundTerms: { termsReference: string; windowDays: number };
  /** Null only for a one-time (lifetime) purchase, which has nothing to cancel. */
  cancellationTerms: { termsReference: string; timing: 'END_OF_PAID_PERIOD' | null };
  /** The single price every qualifying payment must equal, locked at acceptance for as long as the school stays subscribed
   * (or, for ONE_TIME, the one lifetime payment). */
  lockedPriceMinor: number;
  currency: 'USD';
  billingInterval: 'MONTHLY' | 'ANNUAL' | 'ONE_TIME';
  priceRule: 'LOCKED_WHILE_SUBSCRIBED' | 'ONE_TIME_PURCHASE';
  periodCountingRule: 'DISTINCT_VERIFIED_PAID_PERIODS';
  automaticCalendarTransition: false;
  automaticCollectionEnabled: false;
}

export interface SaasScheduleBinding {
  bindingId: string;
  bindingKey: string;
  generationId: string;
  generationDigest: string;
  organizationId: string;
  schoolId: string;
  requirements: SaasScheduleRequirements;
  provider: 'STRIPE_SIMULATED';
  mode: 'TEST';
  status: SaasScheduleBindingStatus;
  statusReason: SaasScheduleBindingReason;
  version: number;
  providerAccountReference: string | null;
  providerSubscriptionReference: string | null;
  providerScheduleReference: string | null;
  requirementsDigest: string;
  qualifyingPaidPeriodCount: number;
  unresolvedReconciliation: boolean;
  accessDecidedSeparately: true;
  checkoutAvailable: false;
  billingEnabled: false;
  createdAt: string;
  boundAt: string | null;
  activatedAt: string | null;
  terminalAt: string | null;
}

export interface SaasScheduleBindingReceipt {
  binding: SaasScheduleBinding;
  replayed: boolean;
}

/** Internal, post-verification provider evidence. It is intentionally not a browser command payload. */
export interface SaasScheduleEvidenceReceipt {
  /** 0341: present only when this payment completed a switch to lifetime; the API stops that old schedule. */
  switchedFrom?: { bindingId: string; accountReference: string; subscriptionReference: string; scheduleReference: string;
    billingStatus: 'SWITCHED_TO_LIFETIME'; stopSchedule: 'NO_PRORATION_NO_REFUND' };
  providerEventId: string;
  bindingId: string;
  outcome: SaasScheduleEvidenceOutcome;
  reason: string;
  /** Billing outcome: the binding status after this event. */
  billingStatus: SaasScheduleBindingStatus;
  qualifyingPaidPeriodCount: number;
  /** Access outcome, decided separately and never derived from billingStatus. */
  access: { accessActivation: SaasScheduleAccessActivation; accessGranted: boolean; reason?: string };
  checkoutAvailable: false;
  billingEnabled: false;
}

const invalid = (): never => { throw new Error('INVALID_SAAS_INPUT'); };
const drift = (): never => { throw new Error('SAAS_CONTRACT_DRIFT'); };
const digest = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const text = (v: unknown, min = 1, max = 1000): v is string => typeof v === 'string' && v.trim() === v && v.length >= min && v.length <= max;
const fakeReference = (v: unknown): v is string => typeof v === 'string' && /^fake_[a-z0-9_-]{1,150}$/.test(v);
const status = (v: unknown): v is SaasScheduleBindingStatus => (SAAS_SCHEDULE_BINDING_STATUSES as readonly unknown[]).includes(v);
const reason = (v: unknown): v is SaasScheduleBindingReason => (SAAS_SCHEDULE_BINDING_REASONS as readonly unknown[]).includes(v);

export function validateSaasScheduleBindingInput(value: unknown): SaasScheduleBindingInput {
  const r = record(value, invalid); keys(r, ['generationId','generationDigest','confirmation'], invalid);
  if (!uuid(r.generationId) || !digest(r.generationDigest) || r.confirmation !== SAAS_SCHEDULE_BINDING_CONFIRMATION) invalid();
  return Object.freeze({ generationId: (r.generationId as string).toLowerCase(), generationDigest: r.generationDigest, confirmation: r.confirmation }) as SaasScheduleBindingInput;
}

export function validateSaasScheduleRequirements(value: unknown): SaasScheduleRequirements {
  const r = record(value, drift);
  keys(r, ['generationId','generationDigest','organizationId','schoolId','acceptanceId','acceptanceDigest','scheduleDigest','offerId','renewalOfferId',
    'offerSetId','offerSetVersion','acceptedOfferDigest','disclosureVersion','disclosureText','termsReference','refundTerms','cancellationTerms','lockedPriceMinor',
    'currency','billingInterval','priceRule','periodCountingRule','automaticCalendarTransition','automaticCollectionEnabled'], drift);
  const refund = record(r.refundTerms, drift), cancellation = record(r.cancellationTerms, drift);
  keys(refund, ['termsReference','windowDays'], drift); keys(cancellation, ['termsReference','timing'], drift);
  if (![r.generationId,r.organizationId,r.schoolId,r.acceptanceId,r.offerId,r.renewalOfferId,r.offerSetId].every(uuid)
    || ![r.generationDigest,r.acceptanceDigest,r.scheduleDigest,r.acceptedOfferDigest].every(digest)
    || !integer(r.offerSetVersion, 1, 999999999) || !text(r.disclosureVersion, 1, 100) || !text(r.disclosureText, 10, 1000)
    || !text(r.termsReference, 1, 200) || refund.termsReference !== r.termsReference || !integer(refund.windowDays, 0, 365)
    || cancellation.termsReference !== r.termsReference
    || !integer(r.lockedPriceMinor, 100, 10000000) || r.currency !== 'USD' || !['MONTHLY','ANNUAL','ONE_TIME'].includes(r.billingInterval as string)
    || (r.billingInterval === 'ONE_TIME' ? cancellation.timing !== null || r.priceRule !== 'ONE_TIME_PURCHASE'
      : cancellation.timing !== 'END_OF_PAID_PERIOD' || r.priceRule !== 'LOCKED_WHILE_SUBSCRIBED')
    || r.periodCountingRule !== 'DISTINCT_VERIFIED_PAID_PERIODS' || r.automaticCalendarTransition !== false || r.automaticCollectionEnabled !== false) drift();
  return r as unknown as SaasScheduleRequirements;
}

export function validateSaasScheduleBinding(value: unknown): SaasScheduleBinding {
  const r = record(value, drift);
  keys(r, ['bindingId','bindingKey','generationId','generationDigest','organizationId','schoolId','requirements','provider','mode','status','statusReason',
    'version','providerAccountReference','providerSubscriptionReference','providerScheduleReference','requirementsDigest','qualifyingPaidPeriodCount',
    'unresolvedReconciliation','accessDecidedSeparately','checkoutAvailable','billingEnabled','createdAt','boundAt','activatedAt','terminalAt'], drift);
  const requirements = validateSaasScheduleRequirements(r.requirements);
  if (![r.bindingId,r.bindingKey,r.generationId,r.organizationId,r.schoolId].every(uuid) || !digest(r.generationDigest) || !digest(r.requirementsDigest)
    || requirements.generationId !== r.generationId || requirements.generationDigest !== r.generationDigest
    || requirements.organizationId !== r.organizationId || requirements.schoolId !== r.schoolId || r.provider !== 'STRIPE_SIMULATED' || r.mode !== 'TEST'
    || !status(r.status) || !reason(r.statusReason) || !nullable(r.providerAccountReference, fakeReference)
    || !nullable(r.providerSubscriptionReference, fakeReference) || !nullable(r.providerScheduleReference, fakeReference)
    || !integer(r.qualifyingPaidPeriodCount, 0, 1000) || typeof r.unresolvedReconciliation !== 'boolean'
    || !integer(r.version, 1, 1000000) || r.accessDecidedSeparately !== true || r.checkoutAvailable !== false || r.billingEnabled !== false
    || !timestamp(r.createdAt) || !nullable(r.boundAt, timestamp) || !nullable(r.activatedAt, timestamp) || !nullable(r.terminalAt, timestamp)) drift();
  const bound = BOUND.includes(r.status as string);
  if ((bound && (r.boundAt === null || ![r.providerAccountReference,r.providerSubscriptionReference,r.providerScheduleReference].every(fakeReference)))
    || TERMINAL.includes(r.status as string) !== (r.terminalAt !== null) || (r.status === 'ACTIVE' && r.activatedAt === null)
    || (r.status === 'BOUND_TEST_ONLY' && r.activatedAt !== null)
    || (r.status === 'REFUNDED_ENDED' && (r.activatedAt === null || r.statusReason !== 'LIFETIME_REFUND_IN_WINDOW' || requirements.billingInterval !== 'ONE_TIME'))
    // 0341: only a paid recurring plan is switched to lifetime.
    || ((r.status === 'SWITCHED_TO_LIFETIME') !== (r.statusReason === 'SWITCHED_TO_LIFETIME'))
    || (r.status === 'SWITCHED_TO_LIFETIME' && (r.activatedAt === null || requirements.billingInterval === 'ONE_TIME'))) drift();
  if (r.status === 'PENDING_PROVIDER_BINDING' && (r.providerAccountReference !== null || r.providerSubscriptionReference !== null || r.providerScheduleReference !== null || r.boundAt !== null)) drift();
  return { ...r, requirements } as unknown as SaasScheduleBinding;
}

export function validateSaasScheduleBindingReceipt(value: unknown): SaasScheduleBindingReceipt {
  const r = record(value, drift); keys(r, ['binding','replayed'], drift);
  if (typeof r.replayed !== 'boolean') drift();
  return { binding: validateSaasScheduleBinding(r.binding), replayed: r.replayed as boolean };
}

export function validateSaasScheduleEvidenceReceipt(value: unknown): SaasScheduleEvidenceReceipt {
  const r = record(value, drift);
  const receiptKeys = ['providerEventId','bindingId','outcome','reason','billingStatus','qualifyingPaidPeriodCount','access','checkoutAvailable','billingEnabled'];
  keys(r, 'switchedFrom' in r ? [...receiptKeys,'switchedFrom'] : receiptKeys, drift);
  // 0341: a paid switch names the old plan whose schedule the API then stops (no proration, no refund).
  if ('switchedFrom' in r) {
    const f = record(r.switchedFrom, drift);
    keys(f, ['bindingId','accountReference','subscriptionReference','scheduleReference','billingStatus','stopSchedule'], drift);
    if (!uuid(f.bindingId) || f.bindingId === r.bindingId || ![f.accountReference,f.subscriptionReference,f.scheduleReference].every(fakeReference)
      || f.billingStatus !== 'SWITCHED_TO_LIFETIME' || f.stopSchedule !== 'NO_PRORATION_NO_REFUND'
      || r.outcome !== 'APPLIED' || r.billingStatus !== 'ACTIVE') drift();
  }
  const access = record(r.access, drift);
  keys(access, 'reason' in access ? ['accessActivation','accessGranted','reason'] : ['accessActivation','accessGranted'], drift);
  if (!text(r.providerEventId, 3, 200) || !uuid(r.bindingId) || !['APPLIED','ALREADY_APPLIED','ATTEMPT_FAILED','NEEDS_REVIEW'].includes(r.outcome as string)
    || typeof r.reason !== 'string' || !/^[A-Z_]{3,80}$/.test(r.reason) || !status(r.billingStatus) || !integer(r.qualifyingPaidPeriodCount, 0, 1000)
    || !['APPLIED','EXTENDED','NEEDS_REVIEW','NOT_ATTEMPTED','ENDED'].includes(access.accessActivation as string) || typeof access.accessGranted !== 'boolean'
    || ((access.accessActivation === 'ENDED') !== (r.reason === 'LIFETIME_REFUND_IN_WINDOW' && r.billingStatus === 'REFUNDED_ENDED' && r.outcome === 'APPLIED'))
    || ('reason' in access && (typeof access.reason !== 'string' || !/^[A-Z_]{3,80}$/.test(access.reason)))
    || (access.accessActivation !== 'APPLIED' && access.accessActivation !== 'EXTENDED' && access.accessGranted !== false)
    || r.checkoutAvailable !== false || r.billingEnabled !== false) drift();
  return r as unknown as SaasScheduleEvidenceReceipt;
}

/** Piece 2 (0235): the access outcome of a binding, reported beside (never derived from) its billing status. */
export interface SaasScheduleBindingAccess {
  /** ENDED (0309): a verified refund inside the refund window ended this lifetime plan; nothing is in effect.
   * SWITCHED (0341): this plan's access moved to the lifetime plan it was switched to. */
  accessActivation: 'APPLIED' | 'NEEDS_REVIEW' | 'NOT_ATTEMPTED' | 'ENDED' | 'SWITCHED';
  reason: string | null;
  /** End of the latest verified paid period (APPLIED only; null for a lifetime purchase, which never ends by time). */
  paidThrough: string | null;
  /** paidThrough plus the owner-approved 7-day grace: when access lapses if no renewal is verified (APPLIED only; null for
   * a lifetime purchase). */
  accessUntil: string | null;
}
export interface SaasScheduleBindingView extends SaasScheduleBinding { access: SaasScheduleBindingAccess; welcomeCredit: SaasScheduleWelcomeCreditAmounts;
  /** 0341: the switch to lifetime this binding is part of (either side), or null. */
  lifetimeSwitch: SaasLifetimeSwitch | null }
export interface SaasScheduleAccessRetryInput { expectedBindingVersion: number }
export interface SaasScheduleAccessRetryReceipt { bindingId: string; access: SaasScheduleBindingAccess & { accessGranted: boolean }; replayed: boolean }

/** `lifetime`: true for a ONE_TIME binding, false for a recurring one, undefined when the caller cannot tell (retry receipt). */
function validateBindingAccess(value: unknown, withGranted: boolean, lifetime?: boolean): SaasScheduleBindingAccess & { accessGranted?: boolean } {
  const a = record(value, drift);
  keys(a, withGranted ? ['accessActivation','reason','paidThrough','accessUntil','accessGranted'] : ['accessActivation','reason','paidThrough','accessUntil'], drift);
  const applied = a.accessActivation === 'APPLIED';
  const timed = timestamp(a.paidThrough) && timestamp(a.accessUntil) && Date.parse(a.accessUntil as string) > Date.parse(a.paidThrough as string);
  const openEnded = a.paidThrough === null && a.accessUntil === null;
  if (!['APPLIED','NEEDS_REVIEW','NOT_ATTEMPTED','ENDED','SWITCHED'].includes(a.accessActivation as string)
    || (a.accessActivation === 'NEEDS_REVIEW') !== (typeof a.reason === 'string' && /^[A-Z_]{3,80}$/.test(a.reason)) || (a.accessActivation !== 'NEEDS_REVIEW' && a.reason !== null)
    || (applied ? !(lifetime === true ? openEnded : lifetime === false ? timed : timed || openEnded) : !openEnded)
    || (withGranted && (typeof a.accessGranted !== 'boolean' || (a.accessGranted && !applied)))) drift();
  return a as unknown as SaasScheduleBindingAccess & { accessGranted?: boolean };
}

export function validateSaasScheduleBindingView(value: unknown): SaasScheduleBindingView {
  const r = record(value, drift);
  const { access, welcomeCredit, lifetimeSwitch, ...binding } = r;
  const checked = validateSaasScheduleBinding(binding);
  const credit = validateWelcomeCreditAmounts(welcomeCredit);
  const a = validateBindingAccess(access, false, checked.requirements.billingInterval === 'ONE_TIME');
  // Access can only have been applied after billing became ACTIVE; a review never relabels the billing status.
  if (a.accessActivation === 'APPLIED' && checked.status !== 'ACTIVE' && checked.status !== 'NEEDS_REVIEW') drift();
  // 0309: an ended lifetime plan reports ENDED, and only it does.
  if ((a.accessActivation === 'ENDED') !== (checked.status === 'REFUNDED_ENDED')) drift();
  // 0325: only a recurring plan can carry a welcome credit.
  if (credit.creditedMinor > 0 && checked.requirements.billingInterval === 'ONE_TIME') drift();
  // 0341: a switched plan reports SWITCHED, and only it does; a switch names this binding on one side.
  if ((a.accessActivation === 'SWITCHED') !== (checked.status === 'SWITCHED_TO_LIFETIME')) drift();
  const sw = lifetimeSwitch === null ? null : validateSaasLifetimeSwitch(lifetimeSwitch);
  if (sw && sw.fromBindingId !== checked.bindingId && sw.toBindingId !== checked.bindingId) drift();
  if (checked.status === 'SWITCHED_TO_LIFETIME' && (!sw || sw.fromBindingId !== checked.bindingId || sw.status !== 'SWITCHED')) drift();
  return { ...checked, access: a, welcomeCredit: credit, lifetimeSwitch: sw };
}

/** 0325: a HON OS plan's welcome credit, amounts only (never who referred the school). */
export interface SaasScheduleWelcomeCreditAmounts { creditedMinor: number; usedMinor: number; remainingMinor: number }
function validateWelcomeCreditAmounts(value: unknown): SaasScheduleWelcomeCreditAmounts {
  const r = record(value, drift); keys(r, ['creditedMinor','usedMinor','remainingMinor'], drift);
  if (!integer(r.creditedMinor, 0, 100000000) || !integer(r.usedMinor, 0, 100000000) || !integer(r.remainingMinor, 0, 100000000)
    || (r.usedMinor as number) + (r.remainingMinor as number) !== r.creditedMinor) drift();
  return { creditedMinor: r.creditedMinor as number, usedMinor: r.usedMinor as number, remainingMinor: r.remainingMinor as number };
}
/** 0325: HQ owner applies one approved Champions WELCOME_CREDIT entry to the referred school's HON OS plan. */
export interface SaasScheduleWelcomeCreditInput { rewardEntryId: string; expectedEntryVersion: number }
export function validateSaasScheduleWelcomeCreditInput(value: unknown): SaasScheduleWelcomeCreditInput {
  const r = record(value, invalid); keys(r, ['expectedEntryVersion','rewardEntryId'], invalid);
  if (!uuid(r.rewardEntryId) || !integer(r.expectedEntryVersion, 1, 999999999)) invalid();
  return Object.freeze({ rewardEntryId: r.rewardEntryId as string, expectedEntryVersion: r.expectedEntryVersion as number });
}
export interface SaasScheduleWelcomeCreditReceipt {
  welcomeCreditId: string; rewardEntryId: string; bindingId: string; organizationId: string; amountMinor: number;
  providerAccountReference: string; providerCreditKey: string; appliedAt: string; welcomeCredit: SaasScheduleWelcomeCreditAmounts;
  cashPayout: false; replayed: boolean;
}
export function validateSaasScheduleWelcomeCreditReceipt(value: unknown): SaasScheduleWelcomeCreditReceipt {
  const r = record(value, drift);
  keys(r, ['welcomeCreditId','rewardEntryId','bindingId','organizationId','amountMinor','providerAccountReference','providerCreditKey','appliedAt',
    'welcomeCredit','cashPayout','replayed'], drift);
  if (![r.welcomeCreditId,r.rewardEntryId,r.bindingId,r.organizationId,r.providerCreditKey].every(uuid) || !integer(r.amountMinor, 1, 100000)
    || !fakeReference(r.providerAccountReference) || !timestamp(r.appliedAt) || r.cashPayout !== false || typeof r.replayed !== 'boolean') drift();
  const credit = validateWelcomeCreditAmounts(r.welcomeCredit);
  if (credit.creditedMinor < (r.amountMinor as number)) drift();
  return { ...(r as object), welcomeCredit: credit } as SaasScheduleWelcomeCreditReceipt;
}

export function validateSaasScheduleAccessRetryInput(value: unknown): SaasScheduleAccessRetryInput {
  const r = record(value, drift); keys(r, ['expectedBindingVersion'], drift);
  if (!integer(r.expectedBindingVersion, 1, 999999999)) drift();
  return Object.freeze({ expectedBindingVersion: r.expectedBindingVersion as number });
}

export function validateSaasScheduleAccessRetryReceipt(value: unknown): SaasScheduleAccessRetryReceipt {
  const r = record(value, drift); keys(r, ['bindingId','access','replayed'], drift);
  if (!uuid(r.bindingId) || typeof r.replayed !== 'boolean') drift();
  return { bindingId: r.bindingId as string, access: validateBindingAccess(r.access, true) as SaasScheduleAccessRetryReceipt['access'], replayed: r.replayed as boolean };
}

/** 0324: a worker's list of plans past due after grace (ids only). */
export interface SaasSchedulePastDueList { bindingIds: string[] }
export function validateSaasSchedulePastDueList(value: unknown): SaasSchedulePastDueList {
  const r = record(value, drift); keys(r, ['bindingIds'], drift);
  if (!Array.isArray(r.bindingIds) || r.bindingIds.length > 200 || !r.bindingIds.every(uuid) || new Set(r.bindingIds).size !== r.bindingIds.length) drift();
  return { bindingIds: [...(r.bindingIds as string[])] };
}
/** 0324: one past-due suspension (terms v2): entitlement SUSPENDED, owner read-only window open. replayed on a repeat run. */
export interface SaasSchedulePastDueSuspension {
  bindingId: string; outcome: 'SUSPENDED'; paidThrough: string; graceEndedAt: string; suspendedAt: string; ownerReadOnlyUntil: string;
  policyVersion: number; replayed: boolean;
}
export function validateSaasSchedulePastDueSuspension(value: unknown): SaasSchedulePastDueSuspension {
  const r = record(value, drift);
  keys(r, ['bindingId','outcome','paidThrough','graceEndedAt','suspendedAt','ownerReadOnlyUntil','policyVersion','replayed'], drift);
  if (!uuid(r.bindingId) || r.outcome !== 'SUSPENDED' || ![r.paidThrough,r.graceEndedAt,r.suspendedAt,r.ownerReadOnlyUntil].every(timestamp)
    || !integer(r.policyVersion, 1, 1000) || typeof r.replayed !== 'boolean'
    || !(Date.parse(r.paidThrough as string) < Date.parse(r.graceEndedAt as string) && Date.parse(r.graceEndedAt as string) <= Date.parse(r.suspendedAt as string)
      && Date.parse(r.suspendedAt as string) < Date.parse(r.ownerReadOnlyUntil as string))) drift();
  return r as unknown as SaasSchedulePastDueSuspension;
}

/** 0341 (owner D3/D3a): switch from a monthly or annual plan straight to lifetime. The unused whole days of the current paid
 * period are credited off the lifetime price; no refund is ever sent. TEST provider only. */
export const SAAS_LIFETIME_SWITCH_CONFIRMATION = 'SWITCH_TO_LIFETIME_UNUSED_DAYS_CREDITED_NO_REFUND' as const;
export const SAAS_LIFETIME_SWITCH_STATUSES = ['AWAITING_PAYMENT','SWITCHED','SWITCHED_THEN_REFUNDED','NEEDS_REVIEW','NOT_COMPLETED'] as const;
export const SAAS_LIFETIME_SWITCH_REFUSALS = ['NO_ACTIVE_PLAN','SWITCH_IN_PROGRESS','BILLING_REVIEW_PENDING','ACCESS_EXCEPTION_ACTIVE','OTHER_BILLING_OPEN',
  'ACCESS_NOT_ACTIVE','NO_CURRENT_PAID_PERIOD'] as const;
export interface SaasLifetimeSwitchPlan { offerKind: string; billingInterval: 'MONTHLY' | 'ANNUAL'; lockedPriceMinor: number }
export interface SaasLifetimeSwitch {
  switchId: string; fromBindingId: string; toBindingId: string; fromPlan: SaasLifetimeSwitchPlan;
  fromPeriod: { startsAt: string; endsAt: string; paidMinor: number; unusedDays: number; periodDays: number };
  lifetimePriceMinor: number; creditMinor: number; amountDueMinor: number; providerCreditKey: string; quotedAt: string;
  status: typeof SAAS_LIFETIME_SWITCH_STATUSES[number]; lifetimeStartedAt: string | null; refundSent: false;
}
function validatePlan(value: unknown): SaasLifetimeSwitchPlan {
  const p = record(value, drift); keys(p, ['offerKind','billingInterval','lockedPriceMinor'], drift);
  if (!text(p.offerKind, 3, 60) || !['MONTHLY','ANNUAL'].includes(p.billingInterval as string) || !integer(p.lockedPriceMinor, 100, 10000000)) drift();
  return p as unknown as SaasLifetimeSwitchPlan;
}
export function validateSaasLifetimeSwitch(value: unknown): SaasLifetimeSwitch {
  const r = record(value, drift);
  keys(r, ['switchId','fromBindingId','toBindingId','fromPlan','fromPeriod','lifetimePriceMinor','creditMinor','amountDueMinor','providerCreditKey',
    'quotedAt','status','lifetimeStartedAt','refundSent'], drift);
  validatePlan(r.fromPlan);
  const p = record(r.fromPeriod, drift); keys(p, ['startsAt','endsAt','paidMinor','unusedDays','periodDays'], drift);
  if (![r.switchId,r.fromBindingId,r.toBindingId,r.providerCreditKey].every(uuid) || r.fromBindingId === r.toBindingId
    || !timestamp(p.startsAt) || !timestamp(p.endsAt) || Date.parse(p.endsAt as string) <= Date.parse(p.startsAt as string)
    || !integer(p.paidMinor, 0, 10000000) || !integer(p.periodDays, 1, 400) || !integer(p.unusedDays, 0, p.periodDays as number)
    || !integer(r.lifetimePriceMinor, 200, 10000000) || !integer(r.creditMinor, 0, (r.lifetimePriceMinor as number) - 100)
    || r.amountDueMinor !== (r.lifetimePriceMinor as number) - (r.creditMinor as number) || !timestamp(r.quotedAt)
    || !(SAAS_LIFETIME_SWITCH_STATUSES as readonly unknown[]).includes(r.status) || !nullable(r.lifetimeStartedAt, timestamp)
    || (r.lifetimeStartedAt !== null) !== (r.status === 'SWITCHED' || r.status === 'SWITCHED_THEN_REFUNDED')
    || r.refundSent !== false) drift();
  return r as unknown as SaasLifetimeSwitch;
}

export interface SaasLifetimeSwitchQuoteOffer {
  offerId: string; offerKind: 'LIFETIME' | 'FOUNDER_LIFETIME'; displayName: string; priceMinor: number; unusedDays: number; periodDays: number;
  creditMinor: number; amountDueMinor: number; availability: 'AVAILABLE' | 'SOLD_OUT' | 'NOT_ELIGIBLE';
}
export interface SaasLifetimeSwitchQuote {
  schoolId: string; quotedAt: string; eligible: boolean; refusal: typeof SAAS_LIFETIME_SWITCH_REFUSALS[number] | null;
  fromBindingId: string | null; fromBindingVersion: number | null; fromPlan: SaasLifetimeSwitchPlan | null;
  fromPeriod: { startsAt: string; endsAt: string; paidMinor: number } | null; offers: SaasLifetimeSwitchQuoteOffer[];
  refundSent: false; paidAccessProgram: 'ACTIVE' | 'INACTIVE'; chargesEnabled: false;
}
export function validateSaasLifetimeSwitchQuote(value: unknown): SaasLifetimeSwitchQuote {
  const r = record(value, drift);
  keys(r, ['schoolId','quotedAt','eligible','refusal','fromBindingId','fromBindingVersion','fromPlan','fromPeriod','offers','refundSent','paidAccessProgram','chargesEnabled'], drift);
  if (!uuid(r.schoolId) || !timestamp(r.quotedAt) || typeof r.eligible !== 'boolean' || !Array.isArray(r.offers) || r.refundSent !== false
    || !['ACTIVE','INACTIVE'].includes(r.paidAccessProgram as string) || r.chargesEnabled !== false) drift();
  if (r.eligible) {
    if (r.refusal !== null || !uuid(r.fromBindingId) || !integer(r.fromBindingVersion, 1, 1000000)) drift();
    validatePlan(r.fromPlan);
    const p = record(r.fromPeriod, drift); keys(p, ['startsAt','endsAt','paidMinor'], drift);
    if (!timestamp(p.startsAt) || !timestamp(p.endsAt) || !integer(p.paidMinor, 0, 10000000)) drift();
  } else if (!(SAAS_LIFETIME_SWITCH_REFUSALS as readonly unknown[]).includes(r.refusal) || r.fromBindingId !== null || r.fromBindingVersion !== null
    || r.fromPlan !== null || r.fromPeriod !== null || (r.offers as unknown[]).length !== 0) drift();
  for (const o of r.offers as unknown[]) {
    const x = record(o, drift);
    keys(x, ['offerId','offerKind','displayName','priceMinor','unusedDays','periodDays','creditMinor','amountDueMinor','availability'], drift);
    if (!uuid(x.offerId) || !['LIFETIME','FOUNDER_LIFETIME'].includes(x.offerKind as string) || !text(x.displayName, 1, 200)
      || !integer(x.priceMinor, 200, 10000000) || !integer(x.periodDays, 1, 400) || !integer(x.unusedDays, 0, x.periodDays as number)
      || !integer(x.creditMinor, 0, (x.priceMinor as number) - 100) || x.amountDueMinor !== (x.priceMinor as number) - (x.creditMinor as number)
      || !['AVAILABLE','SOLD_OUT','NOT_ELIGIBLE'].includes(x.availability as string)) drift();
  }
  return r as unknown as SaasLifetimeSwitchQuote;
}

export interface SaasLifetimeSwitchInput {
  generationId: string; generationDigest: string; fromBindingId: string; expectedFromVersion: number; expectedCreditMinor: number;
  confirmation: typeof SAAS_LIFETIME_SWITCH_CONFIRMATION;
}
export function validateSaasLifetimeSwitchInput(value: unknown): SaasLifetimeSwitchInput {
  const r = record(value, invalid);
  keys(r, ['confirmation','expectedCreditMinor','expectedFromVersion','fromBindingId','generationDigest','generationId'], invalid);
  if (!uuid(r.generationId) || !digest(r.generationDigest) || !uuid(r.fromBindingId) || !integer(r.expectedFromVersion, 1, 999999999)
    || !integer(r.expectedCreditMinor, 0, 10000000) || r.confirmation !== SAAS_LIFETIME_SWITCH_CONFIRMATION) invalid();
  return Object.freeze({ generationId: r.generationId as string, generationDigest: r.generationDigest as string, fromBindingId: r.fromBindingId as string,
    expectedFromVersion: r.expectedFromVersion as number, expectedCreditMinor: r.expectedCreditMinor as number, confirmation: SAAS_LIFETIME_SWITCH_CONFIRMATION });
}
export interface SaasLifetimeSwitchReceipt { binding: SaasScheduleBinding; lifetimeSwitch: SaasLifetimeSwitch; replayed: boolean }
export function validateSaasLifetimeSwitchReceipt(value: unknown): SaasLifetimeSwitchReceipt {
  const r = record(value, drift); keys(r, ['binding','lifetimeSwitch','replayed'], drift);
  if (typeof r.replayed !== 'boolean') drift();
  const binding = validateSaasScheduleBinding(r.binding), lifetimeSwitch = validateSaasLifetimeSwitch(r.lifetimeSwitch);
  if (lifetimeSwitch.toBindingId !== binding.bindingId || binding.requirements.billingInterval !== 'ONE_TIME'
    || binding.requirements.lockedPriceMinor !== lifetimeSwitch.lifetimePriceMinor) drift();
  return { binding, lifetimeSwitch, replayed: r.replayed as boolean };
}
export interface SaasHqLifetimeSwitch extends SaasLifetimeSwitch { organizationId: string; schoolId: string; schoolName: string }
export interface SaasHqLifetimeSwitchList { switches: SaasHqLifetimeSwitch[]; refundSent: false }
export function validateSaasHqLifetimeSwitchList(value: unknown): SaasHqLifetimeSwitchList {
  const r = record(value, drift); keys(r, ['switches','refundSent'], drift);
  if (!Array.isArray(r.switches) || r.refundSent !== false) drift();
  const switches = (r.switches as unknown[]).map(v => {
    const x = record(v, drift); const { organizationId, schoolId, schoolName, ...rest } = x;
    if (!uuid(organizationId) || !uuid(schoolId) || !text(schoolName, 1, 300)) drift();
    return { ...validateSaasLifetimeSwitch(rest), organizationId, schoolId, schoolName } as SaasHqLifetimeSwitch;
  });
  return { switches, refundSent: false };
}
