/** Commercial B2: TEST-only schedule binding and verified-period reconciliation.
 * It never opens checkout, collects money, changes entitlements, or grants paid access. */
import { championsExactKeys as keys, championsIsInt as integer, championsIsTimestamp as timestamp,
  championsIsUuid as uuid, championsNullable as nullable, championsRecord as record } from './champions-club.js';

export const SAAS_SCHEDULE_BINDING_CONFIRMATION = 'BIND_TEST_ONLY_SCHEDULE_NO_COLLECTION' as const;
export type SaasScheduleBindingStatus = 'PENDING_PROVIDER_BINDING' | 'BOUND_TEST_ONLY' | 'NEEDS_REVIEW';
export type SaasScheduleBindingReason = 'BINDING_REQUESTED' | 'BINDING_OBSERVED_TEST_ONLY' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_UNKNOWN' | 'TERMS_MISMATCH' | 'RECONCILIATION_REQUIRED';
export type SaasScheduleEvidenceOutcome = 'APPLIED' | 'ALREADY_APPLIED' | 'NEEDS_REVIEW' | 'RETRY_NOT_READY';

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
  cancellationTerms: { termsReference: string; timing: 'END_OF_PAID_PERIOD' };
  initialAmountMinor: number;
  renewalAmountMinor: number;
  currency: 'USD';
  billingInterval: 'MONTHLY' | 'ANNUAL';
  introductoryPaidPeriods: number;
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
  providerAccountReference: string | null;
  providerSubscriptionReference: string | null;
  providerScheduleReference: string | null;
  requirementsDigest: string;
  qualifyingPaidPeriodCount: number;
  unresolvedReconciliation: boolean;
  checkoutAvailable: false;
  billingEnabled: false;
  accessGranted: false;
  paidAccessProgram: 'INACTIVE';
  createdAt: string;
  boundAt: string | null;
}

export interface SaasScheduleBindingReceipt {
  binding: SaasScheduleBinding;
  replayed: boolean;
}

/** Internal, post-verification provider evidence. It is intentionally not a browser command payload. */
export interface SaasScheduleEvidenceReceipt {
  providerEventId: string;
  bindingId: string | null;
  outcome: SaasScheduleEvidenceOutcome;
  reason: string;
  qualifyingPaidPeriodCount: number;
  checkoutAvailable: false;
  billingEnabled: false;
  accessGranted: false;
  paidAccessProgram: 'INACTIVE';
}

const invalid = (): never => { throw new Error('INVALID_SAAS_INPUT'); };
const drift = (): never => { throw new Error('SAAS_CONTRACT_DRIFT'); };
const digest = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const text = (v: unknown, min = 1, max = 1000): v is string => typeof v === 'string' && v.trim() === v && v.length >= min && v.length <= max;
const fakeReference = (v: unknown): v is string => typeof v === 'string' && /^fake_[a-z0-9_-]{1,150}$/.test(v);
const status = (v: unknown): v is SaasScheduleBindingStatus => v === 'PENDING_PROVIDER_BINDING' || v === 'BOUND_TEST_ONLY' || v === 'NEEDS_REVIEW';
const reason = (v: unknown): v is SaasScheduleBindingReason => ['BINDING_REQUESTED','BINDING_OBSERVED_TEST_ONLY','PROVIDER_UNAVAILABLE','PROVIDER_UNKNOWN','TERMS_MISMATCH','RECONCILIATION_REQUIRED'].includes(v as string);

export function validateSaasScheduleBindingInput(value: unknown): SaasScheduleBindingInput {
  const r = record(value, invalid); keys(r, ['generationId','generationDigest','confirmation'], invalid);
  if (!uuid(r.generationId) || !digest(r.generationDigest) || r.confirmation !== SAAS_SCHEDULE_BINDING_CONFIRMATION) invalid();
  return Object.freeze({ generationId: (r.generationId as string).toLowerCase(), generationDigest: r.generationDigest, confirmation: r.confirmation }) as SaasScheduleBindingInput;
}

export function validateSaasScheduleRequirements(value: unknown): SaasScheduleRequirements {
  const r = record(value, drift);
  keys(r, ['generationId','generationDigest','organizationId','schoolId','acceptanceId','acceptanceDigest','scheduleDigest','offerId','renewalOfferId',
    'offerSetId','offerSetVersion','acceptedOfferDigest','disclosureVersion','disclosureText','termsReference','refundTerms','cancellationTerms','initialAmountMinor','renewalAmountMinor',
    'currency','billingInterval','introductoryPaidPeriods','periodCountingRule','automaticCalendarTransition','automaticCollectionEnabled'], drift);
  const refund = record(r.refundTerms, drift), cancellation = record(r.cancellationTerms, drift);
  keys(refund, ['termsReference','windowDays'], drift); keys(cancellation, ['termsReference','timing'], drift);
  if (![r.generationId,r.organizationId,r.schoolId,r.acceptanceId,r.offerId,r.renewalOfferId,r.offerSetId].every(uuid)
    || ![r.generationDigest,r.acceptanceDigest,r.scheduleDigest,r.acceptedOfferDigest].every(digest)
    || !integer(r.offerSetVersion, 1, 999999999) || !text(r.disclosureVersion, 1, 100) || !text(r.disclosureText, 10, 1000)
    || !text(r.termsReference, 1, 200) || refund.termsReference !== r.termsReference || !integer(refund.windowDays, 0, 365)
    || cancellation.termsReference !== r.termsReference || cancellation.timing !== 'END_OF_PAID_PERIOD'
    || !integer(r.initialAmountMinor, 100, 10000000) || !integer(r.renewalAmountMinor, 100, 10000000)
    || r.currency !== 'USD' || !['MONTHLY','ANNUAL'].includes(r.billingInterval as string) || !integer(r.introductoryPaidPeriods, 0, 12)
    || r.periodCountingRule !== 'DISTINCT_VERIFIED_PAID_PERIODS' || r.automaticCalendarTransition !== false || r.automaticCollectionEnabled !== false) drift();
  return r as unknown as SaasScheduleRequirements;
}

export function validateSaasScheduleBinding(value: unknown): SaasScheduleBinding {
  const r = record(value, drift);
  keys(r, ['bindingId','bindingKey','generationId','generationDigest','organizationId','schoolId','requirements','provider','mode','status','statusReason',
    'providerAccountReference','providerSubscriptionReference','providerScheduleReference','requirementsDigest','qualifyingPaidPeriodCount',
    'unresolvedReconciliation','checkoutAvailable','billingEnabled','accessGranted','paidAccessProgram','createdAt','boundAt'], drift);
  const requirements = validateSaasScheduleRequirements(r.requirements);
  if (![r.bindingId,r.bindingKey,r.generationId,r.organizationId,r.schoolId].every(uuid) || !digest(r.generationDigest) || !digest(r.requirementsDigest)
    || requirements.generationId !== r.generationId || requirements.generationDigest !== r.generationDigest
    || requirements.organizationId !== r.organizationId || requirements.schoolId !== r.schoolId || r.provider !== 'STRIPE_SIMULATED' || r.mode !== 'TEST'
    || !status(r.status) || !reason(r.statusReason) || !nullable(r.providerAccountReference, fakeReference)
    || !nullable(r.providerSubscriptionReference, fakeReference) || !nullable(r.providerScheduleReference, fakeReference)
    || !integer(r.qualifyingPaidPeriodCount, 0, 1000) || typeof r.unresolvedReconciliation !== 'boolean'
    || r.checkoutAvailable !== false || r.billingEnabled !== false || r.accessGranted !== false || r.paidAccessProgram !== 'INACTIVE'
    || !timestamp(r.createdAt) || !nullable(r.boundAt, timestamp)) drift();
  const bound = r.status === 'BOUND_TEST_ONLY';
  if (bound !== (r.boundAt !== null) || (bound && ![r.providerAccountReference,r.providerSubscriptionReference,r.providerScheduleReference].every(fakeReference))) drift();
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
  keys(r, ['providerEventId','bindingId','outcome','reason','qualifyingPaidPeriodCount','checkoutAvailable','billingEnabled','accessGranted','paidAccessProgram'], drift);
  if (!text(r.providerEventId, 3, 200) || !nullable(r.bindingId, uuid) || !['APPLIED','ALREADY_APPLIED','NEEDS_REVIEW','RETRY_NOT_READY'].includes(r.outcome as string)
    || !/^[A-Z_]{3,80}$/.test(r.reason as string) || !integer(r.qualifyingPaidPeriodCount, 0, 1000)
    || r.checkoutAvailable !== false || r.billingEnabled !== false || r.accessGranted !== false || r.paidAccessProgram !== 'INACTIVE') drift();
  return r as unknown as SaasScheduleEvidenceReceipt;
}
