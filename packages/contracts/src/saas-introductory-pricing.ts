/** Commercial A1: internal schedule contracts only. Not an offer publication, purchase or payment API. */
import { championsExactKeys as keys, championsIsInt as integer, championsRecord as record } from './champions-club.js';

export const SAAS_SCHEDULED_OFFER_KINDS = Object.freeze(['REGULAR_MONTHLY', 'REGULAR_ANNUAL', 'FOUNDER_MONTHLY', 'FOUNDER_ANNUAL'] as const);
export type SaasScheduledOfferKind = typeof SAAS_SCHEDULED_OFFER_KINDS[number];
export const SAAS_PRICE_SCHEDULE_CONFIRMATION = 'ACCEPT_INITIAL_AND_SCHEDULED_RENEWAL_PRICES' as const;

/** New owner direction, not live configuration, a published offer, inventory availability or policy approval. */
export const HON_OS_LAUNCH_PRICING_REFERENCE = Object.freeze({
  productCode: 'HON_OS', currency: 'USD', proposedTrialDays: 14, founderOrganizationLimit: 50,
  monthlyListPriceMinor: 24_900, standardAnnualPriceMinor: 209_700,
  founderMonthlyPriceMinor: 19_920, founderMonthlyPaidPeriods: 12,
  founderAnnualPriceMinor: 149_400, founderAnnualPaidPeriods: 1,
  annualMonthlyListReferenceMinor: 298_800,
  newLifetimeSales: false, published: false, purchasingEnabled: false,
} as const);

/** Attach to a NEW immutable offer/acceptance schema later; never flatten into the existing single priceMinor. */
export interface SaasPriceScheduleTermsV1 {
  readonly schemaVersion: 1;
  readonly productCode: 'HON_OS';
  readonly currency: 'USD';
  readonly offerKind: SaasScheduledOfferKind;
  readonly billingInterval: 'MONTHLY' | 'ANNUAL';
  readonly initialPriceMinor: number;
  readonly introductoryPaidPeriods: number;
  readonly renewalPriceMinor: number;
  readonly monthlyListReferenceMinor: number;
  readonly renewalPriceRule: 'FIXED_ACCEPTED_SCHEDULE';
  readonly periodCountingRule: 'DISTINCT_VERIFIED_PAID_PERIODS';
  readonly discountStacking: 'FORBIDDEN';
  readonly promotionReuse: 'REQUIRES_ORGANIZATION_PROMOTION_HISTORY';
  readonly existingCustomerPrices: 'UNCHANGED';
}

/** An intention for a future protected command, never evidence of consent, payment or access. */
export interface SaasPriceScheduleAcknowledgementInput {
  readonly scheduleDigest: string;
  readonly confirmation: typeof SAAS_PRICE_SCHEDULE_CONFIRMATION;
}

const invalid = (): never => { throw new Error('INVALID_SAAS_PRICE_SCHEDULE'); };
const money = (v: unknown) => integer(v, 100, 10_000_000);
const TERM_KEYS = ['schemaVersion', 'productCode', 'currency', 'offerKind', 'billingInterval', 'initialPriceMinor',
  'introductoryPaidPeriods', 'renewalPriceMinor', 'monthlyListReferenceMinor', 'renewalPriceRule', 'periodCountingRule',
  'discountStacking', 'promotionReuse', 'existingCustomerPrices'] as const;

/** Closed, copied and frozen. Engineering ceilings are not approved HQ price limits. */
export function validateSaasPriceScheduleTermsV1(value: unknown): SaasPriceScheduleTermsV1 {
  const r = record(value, invalid);
  keys(r, TERM_KEYS, invalid);
  if (r.schemaVersion !== 1 || r.productCode !== 'HON_OS' || r.currency !== 'USD'
    || !SAAS_SCHEDULED_OFFER_KINDS.includes(r.offerKind as SaasScheduledOfferKind)
    || !money(r.initialPriceMinor) || !money(r.renewalPriceMinor) || !money(r.monthlyListReferenceMinor)
    || r.renewalPriceRule !== 'FIXED_ACCEPTED_SCHEDULE' || r.periodCountingRule !== 'DISTINCT_VERIFIED_PAID_PERIODS'
    || r.discountStacking !== 'FORBIDDEN' || r.promotionReuse !== 'REQUIRES_ORGANIZATION_PROMOTION_HISTORY'
    || r.existingCustomerPrices !== 'UNCHANGED') invalid();
  const kind = r.offerKind as SaasScheduledOfferKind;
  const annual = kind.endsWith('_ANNUAL');
  const founder = kind.startsWith('FOUNDER_');
  if (r.billingInterval !== (annual ? 'ANNUAL' : 'MONTHLY')
    || r.introductoryPaidPeriods !== (founder ? (annual ? 1 : 12) : 0)
    || (founder ? (r.initialPriceMinor as number) >= (r.renewalPriceMinor as number)
      || (r.initialPriceMinor as number) >= (r.monthlyListReferenceMinor as number) * (annual ? 12 : 1)
      : r.initialPriceMinor !== r.renewalPriceMinor)
    || (kind === 'REGULAR_MONTHLY' && r.initialPriceMinor !== r.monthlyListReferenceMinor)) invalid();
  return Object.freeze(Object.fromEntries(TERM_KEYS.map(k => [k, r[k]]))) as unknown as SaasPriceScheduleTermsV1;
}

/** Explicit design input only. No database default or migration seed calls this function. */
export function proposedHonOsLaunchPriceSchedule(kind: unknown): SaasPriceScheduleTermsV1 {
  if (!SAAS_SCHEDULED_OFFER_KINDS.includes(kind as SaasScheduledOfferKind)) invalid();
  const k = kind as SaasScheduledOfferKind, p = HON_OS_LAUNCH_PRICING_REFERENCE;
  const annual = k.endsWith('_ANNUAL'), founder = k.startsWith('FOUNDER_');
  return validateSaasPriceScheduleTermsV1({
    schemaVersion: 1, productCode: 'HON_OS', currency: 'USD', offerKind: k, billingInterval: annual ? 'ANNUAL' : 'MONTHLY',
    initialPriceMinor: founder ? (annual ? p.founderAnnualPriceMinor : p.founderMonthlyPriceMinor)
      : (annual ? p.standardAnnualPriceMinor : p.monthlyListPriceMinor),
    introductoryPaidPeriods: founder ? (annual ? p.founderAnnualPaidPeriods : p.founderMonthlyPaidPeriods) : 0,
    renewalPriceMinor: annual ? p.standardAnnualPriceMinor : p.monthlyListPriceMinor,
    monthlyListReferenceMinor: p.monthlyListPriceMinor, renewalPriceRule: 'FIXED_ACCEPTED_SCHEDULE',
    periodCountingRule: 'DISTINCT_VERIFIED_PAID_PERIODS', discountStacking: 'FORBIDDEN',
    promotionReuse: 'REQUIRES_ORGANIZATION_PROMOTION_HISTORY', existingCustomerPrices: 'UNCHANGED',
  });
}

export function validateSaasPriceScheduleAcknowledgementInput(value: unknown): SaasPriceScheduleAcknowledgementInput {
  const r = record(value, invalid);
  keys(r, ['scheduleDigest', 'confirmation'], invalid);
  if (typeof r.scheduleDigest !== 'string' || !/^[0-9a-f]{64}$/.test(r.scheduleDigest)
    || r.confirmation !== SAAS_PRICE_SCHEDULE_CONFIRMATION) invalid();
  return Object.freeze({ scheduleDigest: r.scheduleDigest as string, confirmation: SAAS_PRICE_SCHEDULE_CONFIRMATION });
}
