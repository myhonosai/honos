/** HON OS schedule billing, piece 1 (0230): TEST-only schedule binding, verified paid-period evidence and the binding
 * lifecycle. Billing outcome only: a binding status never implies access, which is a separate outcome (`access`).
 * It never opens checkout, collects money, changes entitlements, or grants paid access. */
import { championsExactKeys as keys, championsIsInt as integer, championsIsTimestamp as timestamp,
  championsIsUuid as uuid, championsNullable as nullable, championsRecord as record } from './champions-club.js';

export const SAAS_SCHEDULE_BINDING_CONFIRMATION = 'BIND_TEST_ONLY_SCHEDULE_NO_COLLECTION' as const;
export const SAAS_SCHEDULE_BINDING_STATUSES = ['PENDING_PROVIDER_BINDING','BOUND_TEST_ONLY','ACTIVE','NEEDS_REVIEW','EXPIRED_UNPAID','VOIDED_PROVIDER_FAILED','CANCELLED_BEFORE_PAYMENT','REFUNDED_ENDED'] as const;
export type SaasScheduleBindingStatus = typeof SAAS_SCHEDULE_BINDING_STATUSES[number];
export const SAAS_SCHEDULE_BINDING_REASONS = ['BINDING_REQUESTED','BINDING_OBSERVED_TEST_ONLY','FIRST_PAYMENT_VERIFIED','PROVIDER_CONFIRMED_NOT_CREATED',
  'PROVIDER_TERMS_MISMATCH','UNPAID_WINDOW_ELAPSED','AMOUNT_MISMATCH','OVERLAPPING_COVERED_PERIOD','REVERSAL_REVIEW_REQUIRED','UNLINKED_REVERSAL','PURCHASER_CANCELLED_BEFORE_PAYMENT','PERIOD_INTERVAL_MISMATCH','REVIEW_REFUND_VERIFIED','FOUNDER_SPOT_UNAVAILABLE','LIFETIME_SALE_LIMIT_REACHED','LIFETIME_REFUND_IN_WINDOW'] as const;
export type SaasScheduleBindingReason = typeof SAAS_SCHEDULE_BINDING_REASONS[number];
export type SaasScheduleEvidenceOutcome = 'APPLIED' | 'ALREADY_APPLIED' | 'ATTEMPT_FAILED' | 'NEEDS_REVIEW';
/** ENDED (0309): a verified refund inside the refund window ended a lifetime plan. */
export type SaasScheduleAccessActivation = 'APPLIED' | 'EXTENDED' | 'NEEDS_REVIEW' | 'NOT_ATTEMPTED' | 'ENDED';
const TERMINAL: readonly string[] = ['EXPIRED_UNPAID','VOIDED_PROVIDER_FAILED','CANCELLED_BEFORE_PAYMENT','REFUNDED_ENDED'];
const BOUND: readonly string[] = ['BOUND_TEST_ONLY','ACTIVE','EXPIRED_UNPAID','CANCELLED_BEFORE_PAYMENT','REFUNDED_ENDED'];

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
    || (r.status === 'REFUNDED_ENDED' && (r.activatedAt === null || r.statusReason !== 'LIFETIME_REFUND_IN_WINDOW' || requirements.billingInterval !== 'ONE_TIME'))) drift();
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
  keys(r, ['providerEventId','bindingId','outcome','reason','billingStatus','qualifyingPaidPeriodCount','access','checkoutAvailable','billingEnabled'], drift);
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
  /** ENDED (0309): a verified refund inside the refund window ended this lifetime plan; nothing is in effect. */
  accessActivation: 'APPLIED' | 'NEEDS_REVIEW' | 'NOT_ATTEMPTED' | 'ENDED';
  reason: string | null;
  /** End of the latest verified paid period (APPLIED only; null for a lifetime purchase, which never ends by time). */
  paidThrough: string | null;
  /** paidThrough plus the owner-approved 7-day grace: when access lapses if no renewal is verified (APPLIED only; null for
   * a lifetime purchase). */
  accessUntil: string | null;
}
export interface SaasScheduleBindingView extends SaasScheduleBinding { access: SaasScheduleBindingAccess }
export interface SaasScheduleAccessRetryInput { expectedBindingVersion: number }
export interface SaasScheduleAccessRetryReceipt { bindingId: string; access: SaasScheduleBindingAccess & { accessGranted: boolean }; replayed: boolean }

/** `lifetime`: true for a ONE_TIME binding, false for a recurring one, undefined when the caller cannot tell (retry receipt). */
function validateBindingAccess(value: unknown, withGranted: boolean, lifetime?: boolean): SaasScheduleBindingAccess & { accessGranted?: boolean } {
  const a = record(value, drift);
  keys(a, withGranted ? ['accessActivation','reason','paidThrough','accessUntil','accessGranted'] : ['accessActivation','reason','paidThrough','accessUntil'], drift);
  const applied = a.accessActivation === 'APPLIED';
  const timed = timestamp(a.paidThrough) && timestamp(a.accessUntil) && Date.parse(a.accessUntil as string) > Date.parse(a.paidThrough as string);
  const openEnded = a.paidThrough === null && a.accessUntil === null;
  if (!['APPLIED','NEEDS_REVIEW','NOT_ATTEMPTED','ENDED'].includes(a.accessActivation as string)
    || (a.accessActivation === 'NEEDS_REVIEW') !== (typeof a.reason === 'string' && /^[A-Z_]{3,80}$/.test(a.reason)) || (a.accessActivation !== 'NEEDS_REVIEW' && a.reason !== null)
    || (applied ? !(lifetime === true ? openEnded : lifetime === false ? timed : timed || openEnded) : !openEnded)
    || (withGranted && (typeof a.accessGranted !== 'boolean' || (a.accessGranted && !applied)))) drift();
  return a as unknown as SaasScheduleBindingAccess & { accessGranted?: boolean };
}

export function validateSaasScheduleBindingView(value: unknown): SaasScheduleBindingView {
  const r = record(value, drift);
  const { access, ...binding } = r;
  const checked = validateSaasScheduleBinding(binding);
  const a = validateBindingAccess(access, false, checked.requirements.billingInterval === 'ONE_TIME');
  // Access can only have been applied after billing became ACTIVE; a review never relabels the billing status.
  if (a.accessActivation === 'APPLIED' && checked.status !== 'ACTIVE' && checked.status !== 'NEEDS_REVIEW') drift();
  // 0309: an ended lifetime plan reports ENDED, and only it does.
  if ((a.accessActivation === 'ENDED') !== (checked.status === 'REFUNDED_ENDED')) drift();
  return { ...checked, access: a };
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
