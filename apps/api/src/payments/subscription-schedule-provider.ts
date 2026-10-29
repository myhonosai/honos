import { createHash } from 'node:crypto';
import { validateSaasSubscriptionGeneration, type SaasSubscriptionGeneration } from '@hon/contracts';

/** Server-only boundary. No production adapter is configured by B1; fake implementations are test-injected only. */
export const SUBSCRIPTION_SCHEDULE_PROVIDER = Symbol('SUBSCRIPTION_SCHEDULE_PROVIDER');
export interface ProviderSubscriptionScheduleAdapter {
  readonly identity: string;
  readonly mode: 'TEST';
  inspectSchedule(requirements: ProviderScheduleRequirements): Promise<ProviderScheduleObservation>;
  /** A test-only binding key must be reused after an unknown outcome; never collect or calendar-advance. */
  bindOrFindSchedule(request: ProviderScheduleBindingRequest): Promise<ProviderScheduleBindingObservation>;
}
export interface ProviderScheduleRequirements {
  readonly generationId: string; readonly generationDigest: string;
  readonly organizationId: string; readonly schoolId: string;
  readonly acceptanceId: string; readonly acceptanceDigest: string; readonly scheduleDigest: string;
  readonly offerId: string; readonly offerSetId: string; readonly offerSetVersion: number;
  readonly acceptedOfferDigest: string; readonly disclosureVersion: string; readonly disclosureText: string;
  readonly currency: 'USD'; readonly initialAmountMinor: number; readonly renewalAmountMinor: number;
  readonly billingInterval: 'MONTHLY' | 'ANNUAL'; readonly introductoryPaidPeriods: number;
  readonly periodCountingRule: 'DISTINCT_VERIFIED_PAID_PERIODS';
  readonly refundTerms: { readonly termsReference: string; readonly windowDays: number };
  readonly cancellationTerms: { readonly termsReference: string; readonly timing: 'END_OF_PAID_PERIOD' };
}
export interface ProviderScheduleObservation {
  readonly identity: string; readonly mode: 'TEST'; readonly evidenceKind: 'DETERMINISTIC_FAKE';
  readonly outcome: 'OBSERVED' | 'UNAVAILABLE' | 'UNKNOWN';
  readonly accountReference: string; readonly subscriptionReference: string; readonly scheduleReference: string;
  readonly requirements: ProviderScheduleRequirements;
  readonly phaseControl: 'VERIFIED_PAID_PERIOD_GATE' | 'CALENDAR_ONLY' | 'FIXED_PRICE';
  readonly automaticCalendarTransition: boolean;
  readonly automaticCollectionEnabled: false;
}
export interface ProviderScheduleBindingRequest {
  readonly bindingId: string; readonly bindingKey: string; readonly requirementsDigest: string; readonly requirements: ProviderScheduleRequirements;
}
export interface ProviderScheduleBindingObservation {
  readonly identity: 'DETERMINISTIC_FAKE'; readonly mode: 'TEST'; readonly outcome: 'BOUND' | 'ALREADY_BOUND';
  readonly bindingId: string; readonly bindingKey: string; readonly requirementsDigest: string;
  readonly accountReference: string; readonly subscriptionReference: string; readonly scheduleReference: string;
  readonly automaticCalendarTransition: false; readonly automaticCollectionEnabled: false;
}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
};
export const providerScheduleRequirementsDigest = (requirements: ProviderScheduleRequirements) =>
  createHash('sha256').update(canonical(requirements)).digest('hex');
export function subscriptionScheduleRequirements(value: SaasSubscriptionGeneration): ProviderScheduleRequirements {
  const g = validateSaasSubscriptionGeneration(value), a = g.acceptance, s = a.schedule, t = s.terms;
  const result: ProviderScheduleRequirements = { generationId:g.generationId, generationDigest:g.generationDigest,
    organizationId:g.organizationId, schoolId:g.schoolId, acceptanceId:a.acceptanceId, acceptanceDigest:a.acceptanceDigest,
    scheduleDigest:a.scheduleDigest, offerId:s.offerId, offerSetId:s.offerSetId, offerSetVersion:s.offerSetVersion,
    acceptedOfferDigest:s.acceptedOfferDigest, disclosureVersion:a.disclosureVersion, disclosureText:a.disclosureText,
    currency:t.currency, initialAmountMinor:t.initialPriceMinor, renewalAmountMinor:t.renewalPriceMinor,
    billingInterval:t.billingInterval, introductoryPaidPeriods:t.introductoryPaidPeriods, periodCountingRule:t.periodCountingRule,
    refundTerms:Object.freeze({...s.refundTerms}), cancellationTerms:Object.freeze({...s.cancellationTerms}) };
  return Object.freeze(result);
}

/** Parity is a pure test result. It cannot bind a provider, lift the A2 guard or confer billing authority. */
export function verifyProviderScheduleParity(expected: ProviderScheduleRequirements, candidate: unknown) {
  const refused = (reason: string) => Object.freeze({ status:'REVIEW_REQUIRED' as const, reason, checkoutAvailable:false as const, billingEnabled:false as const });
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return refused('INVALID_PROVIDER_OBSERVATION');
  const o = candidate as ProviderScheduleObservation;
  const allowed = ['identity','mode','evidenceKind','outcome','accountReference','subscriptionReference','scheduleReference',
    'requirements','phaseControl','automaticCalendarTransition','automaticCollectionEnabled'];
  if (Object.keys(o).length !== allowed.length || Object.keys(o).some(k => !allowed.includes(k))) return refused('INVALID_PROVIDER_OBSERVATION');
  if (o.identity !== 'DETERMINISTIC_FAKE' || o.mode !== 'TEST' || o.evidenceKind !== 'DETERMINISTIC_FAKE'
    || o.outcome !== 'OBSERVED' || ![o.accountReference,o.subscriptionReference,o.scheduleReference].every(v => typeof v === 'string' && /^fake_[a-z0-9_-]{1,150}$/.test(v))) return refused('PROVIDER_EVIDENCE_UNAVAILABLE');
  try {
    if (canonical(o.requirements) !== canonical(expected)) return refused('ACCEPTED_TERMS_MISMATCH');
  } catch { return refused('INVALID_PROVIDER_OBSERVATION'); }
  if (o.automaticCollectionEnabled !== false || o.automaticCalendarTransition !== false) return refused('BILLING_EXECUTION_FORBIDDEN');
  if (expected.introductoryPaidPeriods > 0 ? o.phaseControl !== 'VERIFIED_PAID_PERIOD_GATE' : o.phaseControl !== 'FIXED_PRICE') return refused('PAID_PERIOD_GUARANTEE_UNAVAILABLE');
  return Object.freeze({status:'PARITY_VERIFIED_TEST_ONLY' as const, reason:'SIMULATION_NOT_PROVIDER_BINDING',
    parityDigest:createHash('sha256').update(canonical({requirements:expected,observation:o})).digest('hex'),
    checkoutAvailable:false as const,billingEnabled:false as const});
}

export class UnconfiguredSubscriptionScheduleProvider implements ProviderSubscriptionScheduleAdapter {
  readonly identity = 'UNCONFIGURED'; readonly mode = 'TEST' as const;
  async inspectSchedule(): Promise<ProviderScheduleObservation> { throw new Error('SAAS_SCHEDULE_PROVIDER_UNAVAILABLE'); }
  async bindOrFindSchedule(): Promise<ProviderScheduleBindingObservation> { throw new Error('SAAS_SCHEDULE_PROVIDER_UNAVAILABLE'); }
}
