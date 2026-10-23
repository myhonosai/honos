// HON OS commercial offers (0181): one customer-facing product, HON OS, sold through several independently identified,
// HQ-owner-published payment offers. Prices, windows, limits and terms are HQ data, never constants in code. Purchase
// binding (0182) sells a published offer through the TEST MODE hosted checkout only; nothing here grants credits, enables
// live charges or changes an entitlement.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsNullable as nullable, championsRecord as record } from './champions-club.js';
import { SAAS_PLAN_CAPABILITIES } from './saas-billing.js';
import { validateSaasCheckout, type SaasCheckout, type SaasHonOsRecurringBilling } from './saas-payments.js';

export const SAAS_HON_OS_OFFER_KINDS = ['REGULAR_MONTHLY','REGULAR_ANNUAL','FOUNDER_MONTHLY','FOUNDER_ANNUAL','LIFETIME','FOUNDER_LIFETIME'] as const;
export type SaasHonOsOfferKind = typeof SAAS_HON_OS_OFFER_KINDS[number];
export type SaasHonOsBillingInterval = 'MONTHLY' | 'ANNUAL' | 'ONE_TIME';
export type SaasHonOsOfferEligibility = 'ANY_ACTIVE_ORGANIZATION' | 'NEW_ORGANIZATIONS_ONLY';
export type SaasHonOsOfferPriceLock = 'NONE' | 'WHILE_CONTINUOUSLY_SUBSCRIBED' | 'FIXED_MONTHS';
export type SaasHonOsOfferAnnualRenewal = 'AUTO_RENEW_AT_LOCKED_PRICE' | 'AUTO_RENEW_AT_CURRENT_PRICE' | 'NO_AUTO_RENEWAL';
export type SaasHonOsOfferSetStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED' | 'DISCARDED';
export type SaasHonOsOfferStopReason = 'OWNER_DISABLED' | 'PRICE_CHANGE_PENDING' | 'TERMS_REVIEW';
export type SaasHonOsOfferReadinessIssue = 'TERMS_REFERENCE_REQUIRED' | 'OFFER_REQUIRED' | 'FOUNDER_LIMIT_REQUIRED' | 'REFUND_WINDOW_REQUIRED'
  | 'CANCELLATION_TIMING_REQUIRED' | 'LIFETIME_FAIR_USE_REQUIRED' | 'LIFETIME_SALE_LIMIT_REQUIRED';
/** The server's purchase decision for one offer and the reading school's organization, now. Never re-derived by a client. */
export type SaasHonOsSchoolOfferEligibility = 'ELIGIBLE' | 'NOT_ELIGIBLE_EXISTING_SUBSCRIPTION' | 'NOT_ELIGIBLE_PRIOR_PURCHASE'
  | 'NOT_ELIGIBLE_ENTITLEMENT' | 'CHECKOUT_IN_PROGRESS' | 'SOLD_OUT' | 'FOUNDER_SOLD_OUT' | 'NOT_AVAILABLE_TERMS' | 'NOT_AVAILABLE';
export const SAAS_HON_OS_SCHOOL_ELIGIBILITY: readonly SaasHonOsSchoolOfferEligibility[] = ['ELIGIBLE','NOT_ELIGIBLE_EXISTING_SUBSCRIPTION',
  'NOT_ELIGIBLE_PRIOR_PURCHASE','NOT_ELIGIBLE_ENTITLEMENT','CHECKOUT_IN_PROGRESS','SOLD_OUT','FOUNDER_SOLD_OUT','NOT_AVAILABLE_TERMS','NOT_AVAILABLE'];

/** The publish approval phrase: a published price applies to new purchases only. */
export const SAAS_HON_OS_OFFER_PUBLISH_APPROVAL = 'APPROVE_FOR_NEW_PURCHASES_ONLY';

/** The one HON OS product. Mirrors hon.saas_hon_os_product_json() in 0181: the COMPLETE entitlement capability policy. */
export const HON_OS_PRODUCT = Object.freeze({
  productCode: 'HON_OS', displayName: 'HON OS', entitlementTier: 'COMPLETE', capabilityPolicyVersion: 1,
  capabilities: SAAS_PLAN_CAPABILITIES.COMPLETE, capabilityStatus: 'ENTITLEMENT_POLICY_NOT_A_READINESS_CLAIM', legacyTiersForNewSale: false,
} as const);
export type HonOsProduct = typeof HON_OS_PRODUCT;

export function saasHonOsOfferBillingInterval(kind: SaasHonOsOfferKind): SaasHonOsBillingInterval {
  return kind.endsWith('_MONTHLY') ? 'MONTHLY' : kind.endsWith('_ANNUAL') ? 'ANNUAL' : 'ONE_TIME';
}

// ---------- inputs ----------
export interface SaasHonOsOfferInput {
  offerCode: string; offerKind: SaasHonOsOfferKind; displayName: string; priceMinor: number;
  salesOpensAt: string | null; salesClosesAt: string | null; eligibility: SaasHonOsOfferEligibility; saleLimit: number | null;
  priceLock: SaasHonOsOfferPriceLock; priceLockMonths: number | null; annualRenewal: SaasHonOsOfferAnnualRenewal | null;
  plannedMonthlyPremiumCredits: number | null; aiFairUseReference: string | null; refundWindowDays: number | null;
  cancellationTiming: 'END_OF_PAID_PERIOD' | null;
}
export interface SaasHonOsOfferSetContent { termsReference: string | null; founderTotalLimit: number | null; offers: SaasHonOsOfferInput[] }
export interface SaasHonOsOfferSetDraftInput extends SaasHonOsOfferSetContent { basedOnSetId: string | null }
export interface SaasHonOsOfferSetReviseInput extends SaasHonOsOfferSetContent { expectedRevision: number }
export interface SaasHonOsOfferSetDiscardInput { expectedRevision: number }
export interface SaasHonOsOfferSetPublishInput { expectedRevision: number; previewDigest: string; approval: typeof SAAS_HON_OS_OFFER_PUBLISH_APPROVAL }
export interface SaasHonOsOfferStopSalesInput { reasonCode: SaasHonOsOfferStopReason }

// ---------- responses ----------
export interface SaasHonOsOffer {
  offerId: string; offerCode: string; position: number; offerKind: SaasHonOsOfferKind; billingInterval: SaasHonOsBillingInterval; founder: boolean;
  displayName: string; priceMinor: number; currency: 'USD'; salesOpensAt: string | null; salesClosesAt: string | null;
  eligibility: SaasHonOsOfferEligibility; saleLimit: number | null; priceLock: SaasHonOsOfferPriceLock; priceLockMonths: number | null;
  annualRenewal: SaasHonOsOfferAnnualRenewal | null; plannedMonthlyPremiumCredits: number | null; premiumCreditsStatus: 'PLANNING_ONLY_NOT_A_CREDIT_GRANT';
  aiFairUseReference: string | null; refundWindowDays: number | null; cancellationTiming: 'END_OF_PAID_PERIOD' | null;
  salesStop: { reasonCode: SaasHonOsOfferStopReason; stoppedAt: string } | null;
}
export interface SaasHonOsOfferSet {
  setId: string; setVersion: number; productCode: 'HON_OS'; status: SaasHonOsOfferSetStatus; revision: number; basedOnSetId: string | null;
  termsReference: string | null; founderTotalLimit: number | null; offers: SaasHonOsOffer[]; approvedPreviewDigest: string | null;
  chargesEnabled: false; creditGrantsEnabled: false; createdAt: string; updatedAt: string;
  publishedAt: string | null; retiredAt: string | null; discardedAt: string | null;
}
export interface SaasHonOsOfferQuote {
  offerCode: string; offerKind: SaasHonOsOfferKind; billingInterval: SaasHonOsBillingInterval; priceMinor: number; currency: 'USD';
  monthlyEquivalentMinor: number | null; annualSavingsVsRegularMonthlyMinor: number | null; lifetimeBreakEvenMonths: number | null;
  founderDiscountPercentVsRegular: number | null;
}
export interface SaasHonOsOfferSetPreview {
  setId: string; revision: number; previewDigest: string; ready: boolean; issues: { code: SaasHonOsOfferReadinessIssue; offerCode: string | null }[];
  quotes: SaasHonOsOfferQuote[]; comparisonOfferCode: string | null; effect: 'NEW_PURCHASES_ONLY'; existingSubscriptionsRepriced: false; product: HonOsProduct;
}
export interface SaasHonOsOfferSetDetail { set: SaasHonOsOfferSet; preview: SaasHonOsOfferSetPreview }
export interface SaasHonOsOfferSetHistoryEntry {
  setId: string; setVersion: number; status: SaasHonOsOfferSetStatus; revision: number; offerCount: number;
  createdAt: string; publishedAt: string | null; retiredAt: string | null; discardedAt: string | null;
}
export interface SaasLegacySalesRow { catalogVersion: number; planCode: 'CORE' | 'COMPLETE'; offerKind: 'REGULAR_MONTHLY' | 'FOUNDER_MONTHLY' | 'FOUNDER_LIFETIME'; priceMinor: number; status: string; subscriptions: number }
export interface SaasHonOsSalesRow {
  offerId: string; setVersion: number; offerCode: string; offerKind: SaasHonOsOfferKind; displayName: string; priceMinor: number; saleLimit: number | null;
  /** Whether a school can buy it now; TERMS_UNSUPPORTED is published but never purchasable (renewal repricing is not built). */
  saleStatus: 'ON_SALE' | 'TERMS_UNSUPPORTED' | 'NOT_ON_SALE';
  subscriptions: number; openCheckouts: number; paidNeedsReview: number;
}
/** Recorded test-mode HON OS sales and the one cumulative HON OS founder pool (separate from the legacy founder inventory). */
export interface SaasHonOsSales {
  offers: SaasHonOsSalesRow[];
  founderPool: { limit: number | null; allocated: number; held: number; remaining: number | null };
}
export interface SaasHonOsOfferManagementView {
  product: HonOsProduct; published: SaasHonOsOfferSet | null; onSaleOfferIds: string[]; drafts: SaasHonOsOfferSet[]; history: SaasHonOsOfferSetHistoryEntry[];
  honOsSales: SaasHonOsSales; legacySales: SaasLegacySalesRow[]; paidAccessProgram: 'ACTIVE' | 'INACTIVE';
  purchase: 'TEST_MODE' | 'UNAVAILABLE'; chargesEnabled: false; creditGrantsEnabled: false;
}
export interface SaasHonOsOfferSetReceipt { set: SaasHonOsOfferSet; preview: SaasHonOsOfferSetPreview; replayed: boolean }
export interface SaasHonOsOfferSetDiscardReceipt { set: SaasHonOsOfferSet; replayed: boolean }
export interface SaasHonOsOfferSetPublishReceipt { set: SaasHonOsOfferSet; retiredSetId: string | null; replayed: boolean }
export interface SaasHonOsOfferStopSalesReceipt { offer: SaasHonOsOffer; replayed: boolean }
export type SaasHonOsSchoolOffer = Omit<SaasHonOsOffer, 'salesStop' | 'salesOpensAt' | 'position' | 'saleLimit' | 'eligibility'>
  & { eligibility: SaasHonOsSchoolOfferEligibility; recurringBilling: SaasHonOsRecurringBilling | null };
/** The HON OS offer this organization bought, as accepted (later HQ changes never alter it). */
export interface SaasHonOsPurchased {
  subscriptionId: string; offerId: string; offerKind: SaasHonOsOfferKind; displayName: string; priceMinor: number; recurringBilling: SaasHonOsRecurringBilling;
  offerSetVersion: number; acceptedOfferDigest: string; status: 'PENDING_ACTIVATION' | 'IN_SERVICE' | 'SUSPENDED'; serviceStartedAt: string | null;
}
export interface SaasHonOsSchoolOfferView {
  schoolId: string; product: HonOsProduct; offerSetVersion: number | null; termsReference: string | null; offers: SaasHonOsSchoolOffer[];
  purchase: 'TEST_MODE' | 'UNAVAILABLE'; checkout: SaasCheckout | null; purchased: SaasHonOsPurchased | null;
  paidAccessProgram: 'ACTIVE' | 'INACTIVE'; chargesEnabled: false;
}

// ---------- helpers ----------
const has = (list: readonly unknown[], value: unknown) => list.includes(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max && value.trim() === value;
const OFFER_CODE = /^[A-Z][A-Z0-9_]{2,47}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ISO_INPUT = /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ELIGIBILITIES = ['ANY_ACTIVE_ORGANIZATION','NEW_ORGANIZATIONS_ONLY'] as const;
const PRICE_LOCKS = ['NONE','WHILE_CONTINUOUSLY_SUBSCRIBED','FIXED_MONTHS'] as const;
const RENEWALS = ['AUTO_RENEW_AT_LOCKED_PRICE','AUTO_RENEW_AT_CURRENT_PRICE','NO_AUTO_RENEWAL'] as const;
const STOP_REASONS = ['OWNER_DISABLED','PRICE_CHANGE_PENDING','TERMS_REVIEW'] as const;
const SET_STATUSES = ['DRAFT','PUBLISHED','RETIRED','DISCARDED'] as const;
const ISSUES = ['TERMS_REFERENCE_REQUIRED','OFFER_REQUIRED','FOUNDER_LIMIT_REQUIRED','REFUND_WINDOW_REQUIRED','CANCELLATION_TIMING_REQUIRED',
  'LIFETIME_FAIR_USE_REQUIRED','LIFETIME_SALE_LIMIT_REQUIRED'] as const;
const OFFER_KEYS = ['offerCode','offerKind','displayName','priceMinor','salesOpensAt','salesClosesAt','eligibility','saleLimit','priceLock',
  'priceLockMonths','annualRenewal','plannedMonthlyPremiumCredits','aiFairUseReference','refundWindowDays','cancellationTiming'] as const;
const inputTs = (v: unknown): v is string => typeof v === 'string' && ISO_INPUT.test(v) && isTimestamp(v);
const nint = (v: unknown, min: number, max: number) => v === null || isInt(v, min, max);

/** Shared business rules for one offer: a lifetime offer has no recurring terms, an annual offer states its renewal. */
function offerTermsConsistent(o: Record<string, unknown>): boolean {
  const interval = saasHonOsOfferBillingInterval(o.offerKind as SaasHonOsOfferKind);
  return (o.priceLock === 'FIXED_MONTHS') === (o.priceLockMonths !== null)
    && (interval !== 'ONE_TIME' || (o.priceLock === 'NONE' && o.cancellationTiming === null))
    && (interval === 'ANNUAL') === (o.annualRenewal !== null)
    && (o.salesOpensAt === null || o.salesClosesAt === null || Date.parse(o.salesClosesAt as string) > Date.parse(o.salesOpensAt as string));
}

function validateOfferInput(value: unknown): SaasHonOsOfferInput {
  const o = record(value, invalid); exactKeys(o, OFFER_KEYS, invalid);
  if (typeof o.offerCode !== 'string' || !OFFER_CODE.test(o.offerCode) || !has(SAAS_HON_OS_OFFER_KINDS, o.offerKind) || !text(o.displayName, 80)
    || !isInt(o.priceMinor, 100, 10_000_000) || !nullable(o.salesOpensAt, inputTs) || !nullable(o.salesClosesAt, inputTs)
    || !has(ELIGIBILITIES, o.eligibility) || !nint(o.saleLimit, 1, 10_000) || !has(PRICE_LOCKS, o.priceLock) || !nint(o.priceLockMonths, 1, 120)
    || !(o.annualRenewal === null || has(RENEWALS, o.annualRenewal)) || !nint(o.plannedMonthlyPremiumCredits, 0, 1_000_000)
    || !(o.aiFairUseReference === null || text(o.aiFairUseReference, 500)) || !nint(o.refundWindowDays, 0, 365)
    || !(o.cancellationTiming === null || o.cancellationTiming === 'END_OF_PAID_PERIOD') || !offerTermsConsistent(o)) invalid();
  const out = {} as Record<string, unknown>;
  for (const key of OFFER_KEYS) out[key] = o[key];
  return out as unknown as SaasHonOsOfferInput;
}
function validateContent(r: Record<string, unknown>): SaasHonOsOfferSetContent {
  if (!(r.termsReference === null || text(r.termsReference, 500)) || !nint(r.founderTotalLimit, 0, 1000)
    || !Array.isArray(r.offers) || r.offers.length < 1 || r.offers.length > 12) invalid();
  const offers = (r.offers as unknown[]).map(validateOfferInput);
  if (new Set(offers.map(o => o.offerCode)).size !== offers.length) invalid();
  return { termsReference: r.termsReference as string | null, founderTotalLimit: r.founderTotalLimit as number | null, offers };
}
export function validateSaasHonOsOfferSetDraftInput(value: unknown): SaasHonOsOfferSetDraftInput {
  const r = record(value, invalid); exactKeys(r, ['basedOnSetId','termsReference','founderTotalLimit','offers'], invalid);
  if (!(r.basedOnSetId === null || (typeof r.basedOnSetId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.basedOnSetId)))) invalid();
  return { basedOnSetId: r.basedOnSetId as string | null, ...validateContent(r) };
}
const revision = (v: unknown) => { if (!isInt(v, 1, 999_999_999)) invalid(); return v as number; };
export function validateSaasHonOsOfferSetReviseInput(value: unknown): SaasHonOsOfferSetReviseInput {
  const r = record(value, invalid); exactKeys(r, ['expectedRevision','termsReference','founderTotalLimit','offers'], invalid);
  return { expectedRevision: revision(r.expectedRevision), ...validateContent(r) };
}
export function validateSaasHonOsOfferSetDiscardInput(value: unknown): SaasHonOsOfferSetDiscardInput {
  const r = record(value, invalid); exactKeys(r, ['expectedRevision'], invalid);
  return { expectedRevision: revision(r.expectedRevision) };
}
export function validateSaasHonOsOfferSetPublishInput(value: unknown): SaasHonOsOfferSetPublishInput {
  const r = record(value, invalid); exactKeys(r, ['expectedRevision','previewDigest','approval'], invalid);
  if (typeof r.previewDigest !== 'string' || !DIGEST.test(r.previewDigest) || r.approval !== SAAS_HON_OS_OFFER_PUBLISH_APPROVAL) invalid();
  return { expectedRevision: revision(r.expectedRevision), previewDigest: r.previewDigest, approval: SAAS_HON_OS_OFFER_PUBLISH_APPROVAL };
}
export function validateSaasHonOsOfferStopSalesInput(value: unknown): SaasHonOsOfferStopSalesInput {
  const r = record(value, invalid); exactKeys(r, ['reasonCode'], invalid);
  if (!has(STOP_REASONS, r.reasonCode)) invalid();
  return { reasonCode: r.reasonCode as SaasHonOsOfferStopReason };
}

// ---------- response verification (closed: any extra key, activation flag or inconsistent term is drift) ----------
function validateProduct(value: unknown): void {
  const p = record(value, drift);
  exactKeys(p, ['productCode','displayName','entitlementTier','capabilityPolicyVersion','capabilities','capabilityStatus','legacyTiersForNewSale'], drift);
  if (p.productCode !== 'HON_OS' || p.displayName !== 'HON OS' || p.entitlementTier !== 'COMPLETE' || p.capabilityPolicyVersion !== 1
    || !Array.isArray(p.capabilities) || p.capabilities.join(',') !== HON_OS_PRODUCT.capabilities.join(',')
    || p.capabilityStatus !== 'ENTITLEMENT_POLICY_NOT_A_READINESS_CLAIM' || p.legacyTiersForNewSale !== false) drift();
}
function validateOfferBody(o: Record<string, unknown>): void {
  if (!OFFER_CODE.test(String(o.offerCode)) || !has(SAAS_HON_OS_OFFER_KINDS, o.offerKind)
    || o.billingInterval !== saasHonOsOfferBillingInterval(o.offerKind as SaasHonOsOfferKind) || o.founder !== String(o.offerKind).startsWith('FOUNDER_')
    || !text(o.displayName, 80) || !isInt(o.priceMinor, 100, 10_000_000) || o.currency !== 'USD' || !nullable(o.salesClosesAt, isTimestamp)
    || !has(PRICE_LOCKS, o.priceLock) || !nint(o.priceLockMonths, 1, 120) || !(o.annualRenewal === null || has(RENEWALS, o.annualRenewal))
    || !nint(o.plannedMonthlyPremiumCredits, 0, 1_000_000) || o.premiumCreditsStatus !== 'PLANNING_ONLY_NOT_A_CREDIT_GRANT'
    || !(o.aiFairUseReference === null || text(o.aiFairUseReference, 500)) || !nint(o.refundWindowDays, 0, 365)
    || !(o.cancellationTiming === null || o.cancellationTiming === 'END_OF_PAID_PERIOD')
    || !offerTermsConsistent({ ...o, salesOpensAt: o.salesOpensAt ?? null })) drift();
}
function validateOffer(value: unknown): void {
  const o = record(value, drift);
  exactKeys(o, ['offerId','position',...OFFER_KEYS,'billingInterval','founder','currency','premiumCreditsStatus','salesStop'], drift);
  if (!isUuid(o.offerId) || !isInt(o.position, 1, 12) || !nullable(o.salesOpensAt, isTimestamp) || !has(ELIGIBILITIES, o.eligibility)
    || !nint(o.saleLimit, 1, 10_000)) drift();
  validateOfferBody(o);
  if (o.salesStop !== null) {
    const s = record(o.salesStop, drift); exactKeys(s, ['reasonCode','stoppedAt'], drift);
    if (!has(STOP_REASONS, s.reasonCode) || !isTimestamp(s.stoppedAt)) drift();
  }
}
function validateSet(value: unknown): SaasHonOsOfferSet {
  const s = record(value, drift);
  exactKeys(s, ['setId','setVersion','productCode','status','revision','basedOnSetId','termsReference','founderTotalLimit','offers','approvedPreviewDigest',
    'chargesEnabled','creditGrantsEnabled','createdAt','updatedAt','publishedAt','retiredAt','discardedAt'], drift);
  const published = s.status === 'PUBLISHED' || s.status === 'RETIRED';
  if (!isUuid(s.setId) || !isInt(s.setVersion, 1, 2147483647) || s.productCode !== 'HON_OS' || !has(SET_STATUSES, s.status)
    || !isInt(s.revision, 1, 2147483647) || !nullable(s.basedOnSetId, isUuid) || !(s.termsReference === null || text(s.termsReference, 500))
    || !nint(s.founderTotalLimit, 0, 1000) || !Array.isArray(s.offers) || s.offers.length > 12
    || !(s.approvedPreviewDigest === null || (typeof s.approvedPreviewDigest === 'string' && DIGEST.test(s.approvedPreviewDigest)))
    || s.chargesEnabled !== false || s.creditGrantsEnabled !== false || !isTimestamp(s.createdAt) || !isTimestamp(s.updatedAt)
    || !nullable(s.publishedAt, isTimestamp) || !nullable(s.retiredAt, isTimestamp) || !nullable(s.discardedAt, isTimestamp)
    || (s.publishedAt !== null) !== published || (s.approvedPreviewDigest !== null) !== published
    || (s.retiredAt !== null) !== (s.status === 'RETIRED') || (s.discardedAt !== null) !== (s.status === 'DISCARDED')) drift();
  (s.offers as unknown[]).forEach((o, i) => { validateOffer(o); if ((o as SaasHonOsOffer).position !== i + 1) drift(); });
  if (new Set((s.offers as SaasHonOsOffer[]).map(o => o.offerCode)).size !== (s.offers as unknown[]).length) drift();
  // Sales can only be stopped on a published set; a retired set keeps its stop history.
  if ((s.status === 'DRAFT' || s.status === 'DISCARDED') && (s.offers as SaasHonOsOffer[]).some(o => o.salesStop !== null)) drift();
  return s as unknown as SaasHonOsOfferSet;
}
function validatePreview(value: unknown, set: SaasHonOsOfferSet): void {
  const p = record(value, drift);
  exactKeys(p, ['setId','revision','previewDigest','ready','issues','quotes','comparisonOfferCode','effect','existingSubscriptionsRepriced','product'], drift);
  if (p.setId !== set.setId || p.revision !== set.revision || typeof p.previewDigest !== 'string' || !DIGEST.test(p.previewDigest)
    || typeof p.ready !== 'boolean' || !Array.isArray(p.issues) || p.ready !== (p.issues.length === 0) || !Array.isArray(p.quotes)
    || p.quotes.length !== set.offers.length || !(p.comparisonOfferCode === null || set.offers.some(o => o.offerCode === p.comparisonOfferCode))
    || p.effect !== 'NEW_PURCHASES_ONLY' || p.existingSubscriptionsRepriced !== false) drift();
  validateProduct(p.product);
  for (const i of p.issues as unknown[]) {
    const q = record(i, drift); exactKeys(q, ['code','offerCode'], drift);
    if (!has(ISSUES, q.code) || !(q.offerCode === null || set.offers.some(o => o.offerCode === q.offerCode))) drift();
  }
  (p.quotes as unknown[]).forEach((value, i) => {
    const q = record(value, drift);
    exactKeys(q, ['offerCode','offerKind','billingInterval','priceMinor','currency','monthlyEquivalentMinor','annualSavingsVsRegularMonthlyMinor',
      'lifetimeBreakEvenMonths','founderDiscountPercentVsRegular'], drift);
    const o = set.offers[i]!;
    if (q.offerCode !== o.offerCode || q.offerKind !== o.offerKind || q.billingInterval !== o.billingInterval || q.priceMinor !== o.priceMinor
      || q.currency !== 'USD' || (o.billingInterval === 'ONE_TIME' ? q.monthlyEquivalentMinor !== null : !isInt(q.monthlyEquivalentMinor, 0, 10_000_000))
      || (o.billingInterval === 'ANNUAL' ? !nint(q.annualSavingsVsRegularMonthlyMinor, -10_000_000, 1_200_000_000) : q.annualSavingsVsRegularMonthlyMinor !== null)
      || (o.billingInterval === 'ONE_TIME' ? !nint(q.lifetimeBreakEvenMonths, 1, 10_000_000) : q.lifetimeBreakEvenMonths !== null)
      || (o.founder ? !nint(q.founderDiscountPercentVsRegular, -100_000, 100) : q.founderDiscountPercentVsRegular !== null)) drift();
  });
}
export function validateSaasHonOsOfferSetDetail(value: unknown): SaasHonOsOfferSetDetail {
  const r = record(value, drift); exactKeys(r, ['set','preview'], drift);
  validatePreview(r.preview, validateSet(r.set));
  return r as unknown as SaasHonOsOfferSetDetail;
}
export function validateSaasHonOsOfferSetReceipt(value: unknown): SaasHonOsOfferSetReceipt {
  const r = record(value, drift); exactKeys(r, ['set','preview','replayed'], drift);
  const set = validateSet(r.set); validatePreview(r.preview, set);
  if (typeof r.replayed !== 'boolean' || (!r.replayed && set.status !== 'DRAFT')) drift();
  return r as unknown as SaasHonOsOfferSetReceipt;
}
export function validateSaasHonOsOfferSetDiscardReceipt(value: unknown): SaasHonOsOfferSetDiscardReceipt {
  const r = record(value, drift); exactKeys(r, ['set','replayed'], drift);
  if (validateSet(r.set).status !== 'DISCARDED' || typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasHonOsOfferSetDiscardReceipt;
}
export function validateSaasHonOsOfferSetPublishReceipt(value: unknown): SaasHonOsOfferSetPublishReceipt {
  const r = record(value, drift); exactKeys(r, ['set','retiredSetId','replayed'], drift);
  const set = validateSet(r.set);
  if (!(set.status === 'PUBLISHED' || (r.replayed === true && set.status === 'RETIRED')) || !nullable(r.retiredSetId, isUuid) || typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasHonOsOfferSetPublishReceipt;
}
export function validateSaasHonOsOfferStopSalesReceipt(value: unknown): SaasHonOsOfferStopSalesReceipt {
  const r = record(value, drift); exactKeys(r, ['offer','replayed'], drift);
  validateOffer(r.offer);
  if ((r.offer as SaasHonOsOffer).salesStop === null || typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasHonOsOfferStopSalesReceipt;
}
export function validateSaasHonOsOfferManagementView(value: unknown): SaasHonOsOfferManagementView {
  const r = record(value, drift);
  exactKeys(r, ['product','published','onSaleOfferIds','drafts','history','honOsSales','legacySales','paidAccessProgram','purchase','chargesEnabled','creditGrantsEnabled'], drift);
  validateProduct(r.product);
  if (r.published !== null && validateSet(r.published).status !== 'PUBLISHED') drift();
  const publishedIds = new Set(r.published === null ? [] : (r.published as SaasHonOsOfferSet).offers.filter(o => o.salesStop === null).map(o => o.offerId));
  if (!Array.isArray(r.onSaleOfferIds) || (r.onSaleOfferIds as unknown[]).some(id => !publishedIds.has(id as string))) drift();
  if (!Array.isArray(r.drafts) || r.drafts.length > 20) drift();
  for (const d of r.drafts as unknown[]) if (validateSet(d).status !== 'DRAFT') drift();
  if (!Array.isArray(r.history) || r.history.length > 100) drift();
  for (const h of r.history as unknown[]) {
    const e = record(h, drift); exactKeys(e, ['setId','setVersion','status','revision','offerCount','createdAt','publishedAt','retiredAt','discardedAt'], drift);
    if (!isUuid(e.setId) || !isInt(e.setVersion, 1, 2147483647) || !has(SET_STATUSES, e.status) || !isInt(e.revision, 1, 2147483647)
      || !isInt(e.offerCount, 0, 12) || !isTimestamp(e.createdAt) || !nullable(e.publishedAt, isTimestamp) || !nullable(e.retiredAt, isTimestamp)
      || !nullable(e.discardedAt, isTimestamp)) drift();
  }
  const sales = record(r.honOsSales, drift); exactKeys(sales, ['offers','founderPool'], drift);
  if (!Array.isArray(sales.offers) || sales.offers.length > 100) drift();
  for (const row of sales.offers as unknown[]) {
    const o = record(row, drift);
    exactKeys(o, ['offerId','setVersion','offerCode','offerKind','displayName','priceMinor','saleLimit','saleStatus','subscriptions','openCheckouts','paidNeedsReview'], drift);
    if (!isUuid(o.offerId) || !isInt(o.setVersion, 1, 2147483647) || typeof o.offerCode !== 'string' || !OFFER_CODE.test(o.offerCode)
      || !has(SAAS_HON_OS_OFFER_KINDS, o.offerKind) || !text(o.displayName, 80) || !isInt(o.priceMinor, 100, 10_000_000)
      || !nint(o.saleLimit, 1, 1_000_000) || !isInt(o.subscriptions, 0, 2147483647) || !isInt(o.openCheckouts, 0, 2147483647)
      || !isInt(o.paidNeedsReview, 0, 2147483647) || !has(['ON_SALE','TERMS_UNSUPPORTED','NOT_ON_SALE'], o.saleStatus)
      || (o.saleStatus !== 'NOT_ON_SALE' && !(r.onSaleOfferIds as unknown[]).includes(o.offerId))) drift();
  }
  const pool = record(sales.founderPool, drift); exactKeys(pool, ['limit','allocated','held','remaining'], drift);
  if (!nint(pool.limit, 0, 1000) || !isInt(pool.allocated, 0, 2147483647) || !isInt(pool.held, 0, 2147483647)
    || (pool.limit === null ? pool.remaining !== null : pool.remaining !== Math.max((pool.limit as number) - (pool.allocated as number) - (pool.held as number), 0))) drift();
  if (!Array.isArray(r.legacySales) || r.legacySales.length > 500) drift();
  for (const row of r.legacySales as unknown[]) {
    const l = record(row, drift); exactKeys(l, ['catalogVersion','planCode','offerKind','priceMinor','status','subscriptions'], drift);
    if (!isInt(l.catalogVersion, 1, 2147483647) || !has(['CORE','COMPLETE'], l.planCode) || !has(['REGULAR_MONTHLY','FOUNDER_MONTHLY','FOUNDER_LIFETIME'], l.offerKind)
      || !isInt(l.priceMinor, 100, 10_000_000) || !has(['PENDING_ACTIVATION','IN_SERVICE','SUSPENDED','VOIDED'], l.status) || !isInt(l.subscriptions, 1, 2147483647)) drift();
  }
  if (!has(['ACTIVE','INACTIVE'], r.paidAccessProgram) || !has(['TEST_MODE','UNAVAILABLE'], r.purchase) || r.chargesEnabled !== false || r.creditGrantsEnabled !== false) drift();
  return r as unknown as SaasHonOsOfferManagementView;
}
export function validateSaasHonOsSchoolOfferView(value: unknown): SaasHonOsSchoolOfferView {
  const r = record(value, drift);
  exactKeys(r, ['schoolId','product','offerSetVersion','termsReference','offers','purchase','checkout','purchased','paidAccessProgram','chargesEnabled'], drift);
  validateProduct(r.product);
  if (!isUuid(r.schoolId) || !nint(r.offerSetVersion, 1, 2147483647) || !(r.termsReference === null || text(r.termsReference, 500))
    || !Array.isArray(r.offers) || r.offers.length > 12 || (r.offerSetVersion === null && r.offers.length !== 0)
    || !has(['TEST_MODE','UNAVAILABLE'], r.purchase) || !has(['ACTIVE','INACTIVE'], r.paidAccessProgram) || r.chargesEnabled !== false) drift();
  if (r.checkout !== null && validateSaasCheckout(r.checkout).schoolId === null) drift();
  if (r.purchased !== null) {
    const p = record(r.purchased, drift);
    exactKeys(p, ['subscriptionId','offerId','offerKind','displayName','priceMinor','recurringBilling','offerSetVersion','acceptedOfferDigest','status','serviceStartedAt'], drift);
    if (!isUuid(p.subscriptionId) || !isUuid(p.offerId) || !has(SAAS_HON_OS_OFFER_KINDS, p.offerKind) || !text(p.displayName, 80)
      || !isInt(p.priceMinor, 100, 10_000_000) || !has(['MONTH','YEAR','NONE'], p.recurringBilling) || !isInt(p.offerSetVersion, 1, 2147483647)
      || typeof p.acceptedOfferDigest !== 'string' || !DIGEST.test(p.acceptedOfferDigest) || !has(['PENDING_ACTIVATION','IN_SERVICE','SUSPENDED'], p.status)
      || !nullable(p.serviceStartedAt, isTimestamp) || (p.serviceStartedAt === null) !== (p.status === 'PENDING_ACTIVATION')) drift();
  }
  for (const value of r.offers as unknown[]) {
    const o = record(value, drift);
    exactKeys(o, ['offerId','offerCode','offerKind','billingInterval','founder','displayName','priceMinor','currency','salesClosesAt','eligibility',
      'priceLock','priceLockMonths','annualRenewal','plannedMonthlyPremiumCredits','premiumCreditsStatus','aiFairUseReference','refundWindowDays',
      'cancellationTiming','recurringBilling'], drift);
    // Recurring billing is derived by the server; null only for terms that cannot be sold yet (repricing at renewal).
    const recurring = o.billingInterval === 'MONTHLY' ? 'MONTH' : o.billingInterval === 'ONE_TIME' ? 'NONE'
      : o.annualRenewal === 'AUTO_RENEW_AT_LOCKED_PRICE' ? 'YEAR' : o.annualRenewal === 'NO_AUTO_RENEWAL' ? 'NONE' : null;
    if (!isUuid(o.offerId) || !has(SAAS_HON_OS_SCHOOL_ELIGIBILITY, o.eligibility) || o.recurringBilling !== recurring
      || ((recurring === null) !== (o.eligibility === 'NOT_AVAILABLE_TERMS'))
      || (o.eligibility === 'FOUNDER_SOLD_OUT' && o.founder !== true)) drift();
    validateOfferBody(o);
  }
  return r as unknown as SaasHonOsSchoolOfferView;
}
