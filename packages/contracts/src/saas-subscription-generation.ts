/** Commercial B1: inert subscription intent. Neither provider evidence nor payment/access authority. */
import { championsExactKeys as keys, championsIsTimestamp as timestamp, championsIsUuid as uuid, championsRecord as record } from './champions-club.js';
import { validateSaasPriceAcceptance, type SaasPriceAcceptance } from './saas-price-acceptance.js';

export const SAAS_GENERATION_CONFIRMATION = 'RECORD_SUBSCRIPTION_GENERATION_ONLY_NO_BILLING' as const;
export interface SaasSubscriptionGenerationInput {
  acceptanceId: string; acceptanceDigest: string; confirmation: typeof SAAS_GENERATION_CONFIRMATION;
}
export interface SaasSubscriptionGeneration {
  generationId: string; organizationId: string; schoolId: string; acceptance: SaasPriceAcceptance;
  generationDigest: string; actorPrincipalId: string; idempotencyKey: string; recordedAt: string;
  provider: { identity: 'UNCONFIGURED'; mode: 'TEST'; generationReference: string;
    accountReference: null; subscriptionReference: null; scheduleReference: null; bindingStatus: 'NOT_BOUND' };
  checkoutAvailable: false; billingEnabled: false; accessGranted: false; paidPeriodEvidence: 'NOT_IMPLEMENTED_B2';
}
const invalid = (): never => { throw new Error('INVALID_SAAS_INPUT'); };
const drift = (): never => { throw new Error('SAAS_CONTRACT_DRIFT'); };
const digest = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
export function validateSaasSubscriptionGenerationInput(value: unknown): SaasSubscriptionGenerationInput {
  const r = record(value, invalid); keys(r, ['acceptanceId','acceptanceDigest','confirmation'], invalid);
  if (!uuid(r.acceptanceId) || !digest(r.acceptanceDigest) || r.confirmation !== SAAS_GENERATION_CONFIRMATION) invalid();
  return Object.freeze({ ...r }) as unknown as SaasSubscriptionGenerationInput;
}
export function validateSaasSubscriptionGeneration(value: unknown): SaasSubscriptionGeneration {
  const r = record(value, drift);
  keys(r, ['generationId','organizationId','schoolId','acceptance','generationDigest','actorPrincipalId','idempotencyKey',
    'recordedAt','provider','checkoutAvailable','billingEnabled','accessGranted','paidPeriodEvidence'], drift);
  const acceptance = validateSaasPriceAcceptance(r.acceptance), p = record(r.provider, drift);
  keys(p, ['identity','mode','generationReference','accountReference','subscriptionReference','scheduleReference','bindingStatus'], drift);
  if (![r.generationId,r.organizationId,r.schoolId,r.actorPrincipalId,r.idempotencyKey].every(uuid)
    || r.organizationId !== acceptance.organizationId || r.schoolId !== acceptance.schoolId || !digest(r.generationDigest)
    || !timestamp(r.recordedAt) || p.identity !== 'UNCONFIGURED' || p.mode !== 'TEST' || p.generationReference !== r.generationId
    || p.accountReference !== null || p.subscriptionReference !== null || p.scheduleReference !== null || p.bindingStatus !== 'NOT_BOUND'
    || r.checkoutAvailable !== false || r.billingEnabled !== false || r.accessGranted !== false || r.paidPeriodEvidence !== 'NOT_IMPLEMENTED_B2') drift();
  return r as unknown as SaasSubscriptionGeneration;
}
export function validateSaasSubscriptionGenerationReceipt(value: unknown) {
  const r = record(value, drift); keys(r, ['generation','replayed'], drift);
  if (typeof r.replayed !== 'boolean') drift();
  return { generation: validateSaasSubscriptionGeneration(r.generation), replayed: r.replayed as boolean };
}

/** B2 boundary ONLY: candidates require authenticated provider provenance, reconciliation and DB uniqueness.
 * No caller may persist these through B1. Refund/dispute/reversal qualification requires owner-reviewed rules. */
export interface SaasPaidPeriodEvidenceCandidate {
  readonly generationId: string;
  readonly provider: string;
  readonly mode: 'TEST';
  readonly providerAccountReference: string;
  readonly providerSubscriptionReference: string;
  readonly providerInvoiceReference: string;
  readonly providerEventReference: string;
  readonly verifiedEventDigest: string;
  readonly coveredPeriod: { readonly startsAt: string; readonly endsAt: string };
  readonly amountMinor: number;
  readonly currency: 'USD';
  readonly outcome: 'PENDING' | 'FAILED' | 'VERIFIED_PAID' | 'UNKNOWN' | 'REFUNDED' | 'DISPUTED' | 'REVERSED';
  readonly relatedEvidenceId: string | null;
}
export interface SaasRenewalTransitionReview {
  readonly generationId: string;
  readonly distinctVerifiedPaidPeriodIds: readonly string[];
  readonly unresolvedEvidenceIds: readonly string[];
  readonly qualification: 'NOT_EVALUATED' | 'REVIEW_REQUIRED';
  readonly transitionAllowed: false;
  readonly providerBindingRequired: true;
  readonly paidAccessAuthority: 'SEPARATE';
}
