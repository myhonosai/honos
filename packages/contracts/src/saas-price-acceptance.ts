/** Commercial A2: immutable acknowledgement evidence. Never a payment or access authorization. */
import { championsExactKeys as keys, championsIsInt as integer, championsIsTimestamp as timestamp,
  championsIsUuid as uuid, championsRecord as record } from './champions-club.js';
import { SAAS_PRICE_SCHEDULE_CONFIRMATION, validateSaasPriceScheduleTerms, type SaasPriceScheduleTerms } from './saas-introductory-pricing.js';
import { validateSaasHonOsOffer } from './saas-offers.js';

export const SAAS_PRICE_DISCLOSURE_VERSION = 'HON_OS_PRICING_EN_V1' as const;
export const SAAS_PRICE_RECORD_CONFIRMATION = 'RECORD_IMMUTABLE_PRICING_SCHEDULE_ONLY' as const;
export interface SaasPriceScheduleRecordInput {
  offerId: string; renewalOfferId: string; expectedOfferSetRevision: number; expectedVersion: number;
  disclosureVersion: typeof SAAS_PRICE_DISCLOSURE_VERSION; confirmation: typeof SAAS_PRICE_RECORD_CONFIRMATION; reason: string;
}
export interface SaasPriceAcceptanceInput {
  scheduleId: string; scheduleDigest: string; acceptanceDigest: string; confirmation: typeof SAAS_PRICE_SCHEDULE_CONFIRMATION;
}
export interface SaasPriceSchedule {
  scheduleId: string; version: number; offerId: string; offerSetId: string; offerSetVersion: number; offerSetRevision: number;
  renewalOfferId: string; terms: SaasPriceScheduleTerms; acceptedOffer: Readonly<Record<string, unknown>>; acceptedOfferDigest: string;
  disclosureVersion: typeof SAAS_PRICE_DISCLOSURE_VERSION; disclosureLanguage: 'en'; disclosureText: string; termsReference: string;
  refundTerms: { termsReference: string; windowDays: number }; cancellationTerms: { termsReference: string; timing: 'END_OF_PAID_PERIOD' };
  scheduleDigest: string; actorPrincipalId: string; recordedAt: string; providerBinding: 'UNAVAILABLE_COMMERCIAL_B'; billingEnabled: false;
}
/** Founder blockers (0279) describe availability now; they are never a promise of a spot. A spot is counted only at the
 * first verified payment, so FOUNDER_* blockers can appear later than an acceptance. */
export const SAAS_PRICE_ACCEPTANCE_BLOCKERS = ['SCHEDULE_CHANGED','OFFER_NOT_AVAILABLE','SCHEDULE_SUPERSEDED',
  'FOUNDER_TERMS_NOT_LOCKED','FOUNDER_ALREADY_USED','FOUNDER_SOLD_OUT','FOUNDER_SET_LIMIT_REACHED','FOUNDER_OFFER_LIMIT_REACHED',
  'ALREADY_ACCEPTED'] as const;
export interface SaasPriceAcceptancePreview {
  organizationId: string; schoolId: string; schedule: SaasPriceSchedule; acceptanceDigest: string; canAcknowledge: boolean;
  blockers: typeof SAAS_PRICE_ACCEPTANCE_BLOCKERS[number][]; purchaseAvailable: false; paymentAuthorized: false; accessGranted: false; asOf: string;
}
export interface SaasPriceAcceptance {
  acceptanceId: string; organizationId: string; schoolId: string; schedule: SaasPriceSchedule; scheduleDigest: string; acceptanceDigest: string;
  disclosureVersion: typeof SAAS_PRICE_DISCLOSURE_VERSION; disclosureText: string; confirmation: typeof SAAS_PRICE_SCHEDULE_CONFIRMATION;
  founderAllocationId: null; actorPrincipalId: string; idempotencyKey: string; acceptedAt: string;
  paymentStatus: 'NOT_AUTHORIZED'; subscriptionStatus: 'NOT_CREATED'; accessGranted: false; paidPeriodEvidence: 'NOT_IMPLEMENTED_COMMERCIAL_B';
}
const invalid = (): never => { throw new Error('INVALID_SAAS_INPUT'); };
const drift = (): never => { throw new Error('SAAS_CONTRACT_DRIFT'); };
const digest = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const text = (v: unknown, min = 1, max = 500) => typeof v === 'string' && v === v.trim() && v.length >= min && v.length <= max;
export function validateSaasPriceScheduleRecordInput(value: unknown): SaasPriceScheduleRecordInput {
  const r = record(value, invalid);
  keys(r, ['offerId','renewalOfferId','expectedOfferSetRevision','expectedVersion','disclosureVersion','confirmation','reason'], invalid);
  if (!uuid(r.offerId) || !uuid(r.renewalOfferId) || !integer(r.expectedOfferSetRevision, 1, 999999999)
    || !integer(r.expectedVersion, 0, 999999998) || r.disclosureVersion !== SAAS_PRICE_DISCLOSURE_VERSION
    || r.confirmation !== SAAS_PRICE_RECORD_CONFIRMATION || !text(r.reason, 10)) invalid();
  return Object.freeze({ ...r }) as unknown as SaasPriceScheduleRecordInput;
}
export function validateSaasPriceAcceptanceInput(value: unknown): SaasPriceAcceptanceInput {
  const r = record(value, invalid); keys(r, ['scheduleId','scheduleDigest','acceptanceDigest','confirmation'], invalid);
  if (!uuid(r.scheduleId) || !digest(r.scheduleDigest) || !digest(r.acceptanceDigest) || r.confirmation !== SAAS_PRICE_SCHEDULE_CONFIRMATION) invalid();
  return Object.freeze({ ...r }) as unknown as SaasPriceAcceptanceInput;
}
export function validateSaasPriceSchedule(value: unknown): SaasPriceSchedule {
  const r = record(value, drift);
  keys(r, ['scheduleId','version','offerId','offerSetId','offerSetVersion','offerSetRevision','renewalOfferId','terms','acceptedOffer',
    'acceptedOfferDigest','disclosureVersion','disclosureLanguage','disclosureText','termsReference','refundTerms','cancellationTerms',
    'scheduleDigest','actorPrincipalId','recordedAt','providerBinding','billingEnabled'], drift);
  const terms = validateSaasPriceScheduleTerms(r.terms), refund = record(r.refundTerms, drift), cancel = record(r.cancellationTerms, drift);
  keys(refund, ['termsReference','windowDays'], drift); keys(cancel, ['termsReference','timing'], drift);
  const a = record(r.acceptedOffer, drift);
  const extra = ['productCode','capabilityPolicyVersion','planCode','offerSetId','offerSetVersion','termsReference','approvedPreviewDigest','recurringBilling'];
  const core = Object.fromEntries(Object.entries(a).filter(([k]) => !extra.includes(k)));
  // Position/sales-stop are deliberately excluded from the historical accepted-offer lineage.
  validateSaasHonOsOffer({ ...core, position: 1, salesStop: null });
  keys(a, [...Object.keys(core), ...extra], drift);
  if (![r.scheduleId,r.offerId,r.offerSetId,r.renewalOfferId,r.actorPrincipalId].every(uuid)
    || ![r.version,r.offerSetVersion,r.offerSetRevision].every(v => integer(v, 1, 999999999))
    || !digest(r.acceptedOfferDigest) || !digest(r.scheduleDigest) || !timestamp(r.recordedAt)
    || r.disclosureVersion !== SAAS_PRICE_DISCLOSURE_VERSION || r.disclosureLanguage !== 'en' || !text(r.disclosureText, 10, 1000)
    || !text(r.termsReference) || refund.termsReference !== r.termsReference || cancel.termsReference !== r.termsReference
    || !integer(refund.windowDays, 0, 365) || cancel.timing !== 'END_OF_PAID_PERIOD'
    || r.providerBinding !== 'UNAVAILABLE_COMMERCIAL_B' || r.billingEnabled !== false
    || a.offerId !== r.offerId || a.offerSetId !== r.offerSetId || a.offerSetVersion !== r.offerSetVersion
    || a.productCode !== 'HON_OS' || a.planCode !== 'COMPLETE' || a.capabilityPolicyVersion !== 1 || !digest(a.approvedPreviewDigest)
    || !['MONTH','YEAR','NONE',null].includes(a.recurringBilling as string | null) || a.termsReference !== r.termsReference
    || a.offerKind !== terms.offerKind || a.priceMinor !== terms.initialPriceMinor || a.currency !== terms.currency
    || a.refundWindowDays !== refund.windowDays || a.cancellationTiming !== cancel.timing) drift();
  return { ...r, terms } as unknown as SaasPriceSchedule;
}
export function validateSaasPriceAcceptancePreview(value: unknown): SaasPriceAcceptancePreview {
  const r = record(value, drift); keys(r, ['organizationId','schoolId','schedule','acceptanceDigest','canAcknowledge','blockers',
    'purchaseAvailable','paymentAuthorized','accessGranted','asOf'], drift);
  validateSaasPriceSchedule(r.schedule);
  if (!uuid(r.organizationId) || !uuid(r.schoolId) || !digest(r.acceptanceDigest) || !Array.isArray(r.blockers)
    || !r.blockers.every(x => SAAS_PRICE_ACCEPTANCE_BLOCKERS.includes(x)) || r.canAcknowledge !== (r.blockers.length === 0)
    || r.purchaseAvailable !== false || r.paymentAuthorized !== false || r.accessGranted !== false || !timestamp(r.asOf)) drift();
  return r as unknown as SaasPriceAcceptancePreview;
}
export function validateSaasPriceAcceptance(value: unknown): SaasPriceAcceptance {
  const r = record(value, drift); keys(r, ['acceptanceId','organizationId','schoolId','schedule','scheduleDigest','acceptanceDigest',
    'disclosureVersion','disclosureText','confirmation','founderAllocationId','actorPrincipalId','idempotencyKey','acceptedAt',
    'paymentStatus','subscriptionStatus','accessGranted','paidPeriodEvidence'], drift);
  const s = validateSaasPriceSchedule(r.schedule);
  if (![r.acceptanceId,r.organizationId,r.schoolId,r.actorPrincipalId,r.idempotencyKey].every(uuid) || !digest(r.acceptanceDigest)
    || r.scheduleDigest !== s.scheduleDigest || r.disclosureVersion !== s.disclosureVersion || r.disclosureText !== s.disclosureText
    || r.confirmation !== SAAS_PRICE_SCHEDULE_CONFIRMATION || r.founderAllocationId !== null || (s.terms.offerKind.startsWith('FOUNDER_') && s.terms.schemaVersion !== 2)
    || !timestamp(r.acceptedAt) || r.paymentStatus !== 'NOT_AUTHORIZED' || r.subscriptionStatus !== 'NOT_CREATED'
    || r.accessGranted !== false || r.paidPeriodEvidence !== 'NOT_IMPLEMENTED_COMMERCIAL_B') drift();
  return r as unknown as SaasPriceAcceptance;
}
export function validateSaasPriceScheduleReceipt(value: unknown) {
  const r = record(value, drift); keys(r, ['schedule','replayed'], drift);
  if (typeof r.replayed !== 'boolean') drift(); return { schedule: validateSaasPriceSchedule(r.schedule), replayed: r.replayed as boolean };
}
export function validateSaasPriceAcceptanceReceipt(value: unknown) {
  const r = record(value, drift); keys(r, ['acceptance','replayed'], drift);
  if (typeof r.replayed !== 'boolean') drift(); return { acceptance: validateSaasPriceAcceptance(r.acceptance), replayed: r.replayed as boolean };
}
