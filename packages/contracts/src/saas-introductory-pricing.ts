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

/** Piece 4 (0279): founder terms locked while subscribed (owner policy 2026-11-09). The founder price is both the first
 * and every renewal price for as long as the subscription stays active; after a cancellation or a lapse past the grace
 * period a new subscription is at the standard price. A founder spot is counted only at the first verified payment.
 * Version 1 founder (step-up) terms stay valid as history only; they can never be accepted. */
export const SAAS_FOUNDER_OFFER_KINDS = Object.freeze(['FOUNDER_MONTHLY', 'FOUNDER_ANNUAL'] as const);
export type SaasFounderOfferKind = typeof SAAS_FOUNDER_OFFER_KINDS[number];
export interface SaasFounderLockedTermsV2 {
  readonly schemaVersion: 2;
  readonly productCode: 'HON_OS';
  readonly currency: 'USD';
  readonly offerKind: SaasFounderOfferKind;
  readonly billingInterval: 'MONTHLY' | 'ANNUAL';
  readonly initialPriceMinor: number;
  readonly introductoryPaidPeriods: 0;
  readonly renewalPriceMinor: number;
  readonly monthlyListReferenceMinor: number;
  readonly renewalPriceRule: 'FIXED_ACCEPTED_SCHEDULE';
  readonly periodCountingRule: 'DISTINCT_VERIFIED_PAID_PERIODS';
  readonly discountStacking: 'FORBIDDEN';
  readonly promotionReuse: 'REQUIRES_ORGANIZATION_PROMOTION_HISTORY';
  readonly existingCustomerPrices: 'UNCHANGED';
  readonly standardPriceMinor: number;
  readonly founderPriceRule: 'LOCKED_WHILE_SUBSCRIBED';
  readonly returnPriceRule: 'STANDARD_PRICE_AFTER_CANCEL_OR_LAPSE';
  readonly founderSpotRule: 'ONE_PER_ORGANIZATION_COUNTED_AT_FIRST_VERIFIED_PAYMENT';
}
export type SaasPriceScheduleTerms = SaasPriceScheduleTermsV1 | SaasFounderLockedTermsV2 | SaasLifetimeTermsV3;
const FOUNDER_TERM_KEYS = [...TERM_KEYS, 'standardPriceMinor', 'founderPriceRule', 'returnPriceRule', 'founderSpotRule'] as const;

export function validateSaasFounderLockedTermsV2(value: unknown): SaasFounderLockedTermsV2 {
  const r = record(value, invalid);
  keys(r, FOUNDER_TERM_KEYS, invalid);
  if (r.schemaVersion !== 2 || r.productCode !== 'HON_OS' || r.currency !== 'USD'
    || !SAAS_FOUNDER_OFFER_KINDS.includes(r.offerKind as SaasFounderOfferKind)
    || !money(r.initialPriceMinor) || !money(r.renewalPriceMinor) || !money(r.monthlyListReferenceMinor) || !money(r.standardPriceMinor)
    || r.introductoryPaidPeriods !== 0 || r.initialPriceMinor !== r.renewalPriceMinor
    || (r.initialPriceMinor as number) >= (r.standardPriceMinor as number)
    || r.billingInterval !== (String(r.offerKind).endsWith('_ANNUAL') ? 'ANNUAL' : 'MONTHLY')
    || (r.billingInterval === 'MONTHLY' && r.standardPriceMinor !== r.monthlyListReferenceMinor)
    || r.renewalPriceRule !== 'FIXED_ACCEPTED_SCHEDULE' || r.periodCountingRule !== 'DISTINCT_VERIFIED_PAID_PERIODS'
    || r.discountStacking !== 'FORBIDDEN' || r.promotionReuse !== 'REQUIRES_ORGANIZATION_PROMOTION_HISTORY'
    || r.existingCustomerPrices !== 'UNCHANGED' || r.founderPriceRule !== 'LOCKED_WHILE_SUBSCRIBED'
    || r.returnPriceRule !== 'STANDARD_PRICE_AFTER_CANCEL_OR_LAPSE'
    || r.founderSpotRule !== 'ONE_PER_ORGANIZATION_COUNTED_AT_FIRST_VERIFIED_PAYMENT') invalid();
  return Object.freeze(Object.fromEntries(FOUNDER_TERM_KEYS.map(k => [k, r[k]]))) as unknown as SaasFounderLockedTermsV2;
}

/** 0306: one-time (lifetime) terms, sold through the schedule path (owner decisions 2026-11-12). One verified payment of
 * the price gives open-ended access; nothing renews. Each lifetime offer has its own HQ sale limit, counted at the first
 * verified payment; founder lifetime never uses the 50 founder spots. A verified refund inside the refund window ends
 * lifetime access. */
export const SAAS_LIFETIME_OFFER_KINDS = Object.freeze(['LIFETIME', 'FOUNDER_LIFETIME'] as const);
export type SaasLifetimeOfferKind = typeof SAAS_LIFETIME_OFFER_KINDS[number];
export interface SaasLifetimeTermsV3 {
  readonly schemaVersion: 3;
  readonly productCode: 'HON_OS';
  readonly currency: 'USD';
  readonly offerKind: SaasLifetimeOfferKind;
  readonly billingInterval: 'ONE_TIME';
  readonly initialPriceMinor: number;
  readonly introductoryPaidPeriods: 0;
  readonly renewalPriceMinor: number;
  readonly monthlyListReferenceMinor: number;
  readonly renewalPriceRule: 'NO_RENEWAL_ONE_TIME';
  readonly periodCountingRule: 'DISTINCT_VERIFIED_PAID_PERIODS';
  readonly discountStacking: 'FORBIDDEN';
  readonly promotionReuse: 'REQUIRES_ORGANIZATION_PROMOTION_HISTORY';
  readonly existingCustomerPrices: 'UNCHANGED';
  readonly lifetimeAccessRule: 'OPEN_ENDED_AFTER_ONE_VERIFIED_PAYMENT';
  readonly saleLimitRule: 'OFFER_SALE_LIMIT_COUNTED_AT_FIRST_VERIFIED_PAYMENT';
  readonly founderSpotRule: 'NOT_COUNTED_IN_FOUNDER_POOL';
  readonly refundAccessRule: 'VERIFIED_REFUND_IN_WINDOW_ENDS_ACCESS';
}
const LIFETIME_TERM_KEYS = [...TERM_KEYS, 'lifetimeAccessRule', 'saleLimitRule', 'founderSpotRule', 'refundAccessRule'] as const;
export function validateSaasLifetimeTermsV3(value: unknown): SaasLifetimeTermsV3 {
  const r = record(value, invalid);
  keys(r, LIFETIME_TERM_KEYS, invalid);
  if (r.schemaVersion !== 3 || r.productCode !== 'HON_OS' || r.currency !== 'USD'
    || !SAAS_LIFETIME_OFFER_KINDS.includes(r.offerKind as SaasLifetimeOfferKind) || r.billingInterval !== 'ONE_TIME'
    || !money(r.initialPriceMinor) || !money(r.monthlyListReferenceMinor) || r.renewalPriceMinor !== r.initialPriceMinor
    || r.introductoryPaidPeriods !== 0 || r.renewalPriceRule !== 'NO_RENEWAL_ONE_TIME'
    || r.periodCountingRule !== 'DISTINCT_VERIFIED_PAID_PERIODS' || r.discountStacking !== 'FORBIDDEN'
    || r.promotionReuse !== 'REQUIRES_ORGANIZATION_PROMOTION_HISTORY' || r.existingCustomerPrices !== 'UNCHANGED'
    || r.lifetimeAccessRule !== 'OPEN_ENDED_AFTER_ONE_VERIFIED_PAYMENT'
    || r.saleLimitRule !== 'OFFER_SALE_LIMIT_COUNTED_AT_FIRST_VERIFIED_PAYMENT'
    || r.founderSpotRule !== 'NOT_COUNTED_IN_FOUNDER_POOL' || r.refundAccessRule !== 'VERIFIED_REFUND_IN_WINDOW_ENDS_ACCESS') invalid();
  return Object.freeze(Object.fromEntries(LIFETIME_TERM_KEYS.map(k => [k, r[k]]))) as unknown as SaasLifetimeTermsV3;
}
export const saasLifetimeTerms = (t: SaasPriceScheduleTerms): t is SaasLifetimeTermsV3 => t.schemaVersion === 3;

/** Any recorded schedule's terms: version 1 (regular, or historical step-up founder), version 2 (locked founder) or
 * version 3 (lifetime, 0306). */
export function validateSaasPriceScheduleTerms(value: unknown): SaasPriceScheduleTerms {
  const r = record(value, invalid);
  return r.schemaVersion === 3 ? validateSaasLifetimeTermsV3(r)
    : r.schemaVersion === 2 ? validateSaasFounderLockedTermsV2(r) : validateSaasPriceScheduleTermsV1(r);
}
export const saasFounderTermsLocked = (t: SaasPriceScheduleTerms): t is SaasFounderLockedTermsV2 => t.schemaVersion === 2;

/** The terms a schedule recorded today carries for the proposed launch prices: regular terms are unchanged (v1),
 * founder terms are locked (v2). Explicit design input only; never a seed. */
export function honOsLaunchScheduleTerms(kind: unknown): SaasPriceScheduleTerms {
  if (!SAAS_SCHEDULED_OFFER_KINDS.includes(kind as SaasScheduledOfferKind)) invalid();
  const k = kind as SaasScheduledOfferKind, p = HON_OS_LAUNCH_PRICING_REFERENCE;
  if (!k.startsWith('FOUNDER_')) return proposedHonOsLaunchPriceSchedule(k);
  const annual = k.endsWith('_ANNUAL'), price = annual ? p.founderAnnualPriceMinor : p.founderMonthlyPriceMinor;
  return validateSaasFounderLockedTermsV2({
    schemaVersion: 2, productCode: 'HON_OS', currency: 'USD', offerKind: k, billingInterval: annual ? 'ANNUAL' : 'MONTHLY',
    initialPriceMinor: price, introductoryPaidPeriods: 0, renewalPriceMinor: price, monthlyListReferenceMinor: p.monthlyListPriceMinor,
    renewalPriceRule: 'FIXED_ACCEPTED_SCHEDULE', periodCountingRule: 'DISTINCT_VERIFIED_PAID_PERIODS', discountStacking: 'FORBIDDEN',
    promotionReuse: 'REQUIRES_ORGANIZATION_PROMOTION_HISTORY', existingCustomerPrices: 'UNCHANGED',
    standardPriceMinor: annual ? p.standardAnnualPriceMinor : p.monthlyListPriceMinor, founderPriceRule: 'LOCKED_WHILE_SUBSCRIBED',
    returnPriceRule: 'STANDARD_PRICE_AFTER_CANCEL_OR_LAPSE', founderSpotRule: 'ONE_PER_ORGANIZATION_COUNTED_AT_FIRST_VERIFIED_PAYMENT',
  });
}
