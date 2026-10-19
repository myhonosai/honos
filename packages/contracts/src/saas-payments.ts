// HON Subscription Billing Milestone B5 closed contracts: hosted checkout and provider-verified payment
// accounting, TEST MODE ONLY. HON never receives or stores card data, never initiates a charge or a
// refund, and live mode is unavailable. A checkout is only offered for the plan matching the school's
// active entitlement (or, for an organization awaiting its first payment, any Core or Complete offer); a
// verified payment records the subscription, invoice and evidence and changes access only through the B6A
// transition while the paid-access program is ACTIVE (it is INACTIVE until the owner approves).
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsNullable as nullable, championsRecord as record } from './champions-club.js';
import { saasUuid, validateSaasSubscriptionForSchool, type SaasSubscription } from './saas-billing.js';

export type SaasProviderCode = 'STRIPE' | 'STRIPE_SIMULATED';
export type SaasCheckoutStatus = 'CREATED' | 'OPEN' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED' | 'FAILED' | 'PAID_NEEDS_REVIEW';
export type SaasCheckoutReason = 'CREATED' | 'PROVIDER_SESSION_OPENED' | 'PROVIDER_CREATE_FAILED' | 'PAYMENT_VERIFIED' | 'PROVIDER_EXPIRED'
  | 'LOCAL_EXPIRED' | 'CANCELLED_BY_REQUESTER' | 'CANCELLED_BY_HQ' | 'ASYNC_PAYMENT_FAILED' | 'PAID_AFTER_CLOSE' | 'AMOUNT_MISMATCH'
  | 'FOUNDER_UNAVAILABLE' | 'ENTITLEMENT_CHANGED' | 'SUBSCRIPTION_EXISTS' | 'ACCESS_PROGRAM_INACTIVE';
export type SaasProviderEventOutcome = 'APPLIED' | 'ALREADY_APPLIED' | 'IGNORED' | 'NEEDS_REVIEW' | 'AWAITING_ASYNC_PAYMENT';
const PROVIDERS: readonly SaasProviderCode[] = ['STRIPE','STRIPE_SIMULATED'];
const STATUSES: readonly SaasCheckoutStatus[] = ['CREATED','OPEN','COMPLETED','EXPIRED','CANCELLED','FAILED','PAID_NEEDS_REVIEW'];
const REASONS: readonly SaasCheckoutReason[] = ['CREATED','PROVIDER_SESSION_OPENED','PROVIDER_CREATE_FAILED','PAYMENT_VERIFIED','PROVIDER_EXPIRED',
  'LOCAL_EXPIRED','CANCELLED_BY_REQUESTER','CANCELLED_BY_HQ','ASYNC_PAYMENT_FAILED','PAID_AFTER_CLOSE','AMOUNT_MISMATCH','FOUNDER_UNAVAILABLE',
  'ENTITLEMENT_CHANGED','SUBSCRIPTION_EXISTS','ACCESS_PROGRAM_INACTIVE'];
const OUTCOMES: readonly SaasProviderEventOutcome[] = ['APPLIED','ALREADY_APPLIED','IGNORED','NEEDS_REVIEW','AWAITING_ASYNC_PAYMENT'];
const OFFER_KINDS = ['REGULAR_MONTHLY','FOUNDER_MONTHLY','FOUNDER_LIFETIME'] as const;

/** Normalized, signature-verified provider event (only the fields HON applies; never card data). */
export interface SaasProviderEvent {
  provider: SaasProviderCode; eventId: string; type: string; livemode: false; createdAt: string; object: Record<string, string | number | null>;
}

// ---------- inputs ----------
export interface SaasPaymentProgramInput {
  action: 'ENABLE_TEST_MODE' | 'DISABLE'; expectedVersion: number; authorizationReference: string;
  provider: SaasProviderCode | null; testTaxReference: string | null;
}
export interface SaasSchoolCheckoutInput { offerId: string }
export interface SaasHqCheckoutInput { organizationId: string; offerId: string }
export interface SaasCheckoutCancelInput { expectedVersion: number }
export interface SaasPaymentRecoveryInput { sinceHours: number }

// ---------- responses ----------
export interface SaasPaymentProgram {
  status: 'DISABLED' | 'TEST_MODE'; provider: SaasProviderCode | null; mode: 'TEST' | null; liveMode: 'UNAVAILABLE';
  testTaxReference: string | null; authorizationReference: string | null; version: number; changedAt: string;
  cardDataStored: false; refundExecution: 'UNAVAILABLE';
}
export interface SaasCheckout {
  checkoutId: string; organizationId: string; schoolId: string | null; offerId: string; planCode: 'CORE' | 'COMPLETE';
  offerKind: typeof OFFER_KINDS[number]; billingInterval: 'MONTHLY' | 'LIFETIME'; amountMinor: number; currency: 'USD';
  founderReservationId: string | null; requesterKind: 'SCHOOL_OWNER' | 'HQ'; provider: SaasProviderCode; mode: 'TEST';
  providerSessionId: string | null; checkoutUrl: string | null; status: SaasCheckoutStatus; statusReason: SaasCheckoutReason;
  subscriptionId: string | null; invoiceId: string | null; expiresAt: string; version: number; createdAt: string; completedAt: string | null;
}
export interface SaasProviderEventSummary {
  eventId: string; provider: SaasProviderCode; providerEventId: string; type: string; organizationId: string | null; checkoutId: string | null;
  subscriptionId: string | null; outcome: SaasProviderEventOutcome; detail: string; providerCreatedAt: string; receivedAt: string;
}
export interface SaasPaymentsView {
  program: SaasPaymentProgram; checkouts: SaasCheckout[]; events: SaasProviderEventSummary[];
  reconciliation: { openPastExpiry: number; createdWithoutProviderSession: number; paidNeedsReview: number; eventsNeedingReview: number; awaitingAsyncPayment: number };
  asOf: string;
}
export interface SaasPlanOffer {
  offerId: string; planCode: 'CORE' | 'COMPLETE'; offerKind: typeof OFFER_KINDS[number]; billingInterval: 'MONTHLY' | 'LIFETIME';
  priceMinor: number; currency: 'USD'; monthlyPremiumCredits: number | null; founderSlotsRemaining: number | null;
}
export interface SaasSchoolPlanOptions {
  schoolId: string; entitlementTier: 'ESSENTIAL' | 'CORE' | 'COMPLETE' | null;
  payments: { status: 'DISABLED' | 'TEST_MODE'; mode: 'TEST' | null }; offers: SaasPlanOffer[];
  subscription: Omit<SaasSubscription, 'organizationName'> | null;
  paymentVerification: 'PROVIDER_VERIFIED' | 'HQ_ATTESTED' | 'NONE'; checkout: SaasCheckout | null;
  annualBilling: 'UNAVAILABLE'; planChanges: 'UNAVAILABLE'; cardDataStored: false;
}
export interface SaasPaymentProgramReceipt { program: SaasPaymentProgram; replayed: boolean }
export interface SaasCheckoutReceipt { checkout: SaasCheckout; replayed: boolean }
export interface SaasProviderEventReceipt {
  event: { eventId: string; providerEventId: string; type: string; outcome: SaasProviderEventOutcome; detail: string;
    organizationId: string | null; checkoutId: string | null; subscriptionId: string | null };
  replayed: boolean;
}
export interface SaasCheckoutSweepReceipt { expired: number; asOf: string; replayed: boolean }
export interface SaasPaymentRecoveryResult { fetched: number; results: SaasProviderEventReceipt['event'][] }

// ---------- input validators ----------
const has = (list: readonly unknown[], value: unknown) => list.includes(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max && value.trim() === value;
const nts = (v: unknown) => v === null || isTimestamp(v);
const count = (v: unknown): v is number => isInt(v, 0, Number.MAX_SAFE_INTEGER);
const SESSION = /^cs_test_[A-Za-z0-9_]{1,200}$/;
const URL_RE = /^https:\/\/(checkout\.stripe\.com|checkout\.simulated\.invalid)\/[A-Za-z0-9_/#%?=&.-]{1,1960}$/;

export function validateSaasPaymentProgramInput(value: unknown): SaasPaymentProgramInput {
  const input = record(value, invalid); exactKeys(input, ['action','expectedVersion','authorizationReference','provider','testTaxReference'], invalid);
  if (!isInt(input.expectedVersion, 1, 999_999_999) || !text(input.authorizationReference, 200)) invalid();
  if (input.action === 'ENABLE_TEST_MODE') { if (!has(PROVIDERS, input.provider) || !text(input.testTaxReference, 200)) invalid(); }
  else if (input.action === 'DISABLE') { if (input.provider !== null || input.testTaxReference !== null) invalid(); }
  else invalid();
  return input as unknown as SaasPaymentProgramInput;
}
export function validateSaasSchoolCheckoutInput(value: unknown): SaasSchoolCheckoutInput {
  const input = record(value, invalid); exactKeys(input, ['offerId'], invalid);
  return { offerId: saasUuid(input.offerId) };
}
export function validateSaasHqCheckoutInput(value: unknown): SaasHqCheckoutInput {
  const input = record(value, invalid); exactKeys(input, ['organizationId','offerId'], invalid);
  return { organizationId: saasUuid(input.organizationId), offerId: saasUuid(input.offerId) };
}
export function validateSaasCheckoutCancelInput(value: unknown): SaasCheckoutCancelInput {
  const input = record(value, invalid); exactKeys(input, ['expectedVersion'], invalid);
  if (!isInt(input.expectedVersion, 1, 999_999_999)) invalid();
  return { expectedVersion: input.expectedVersion as number };
}
export function validateSaasPaymentRecoveryInput(value: unknown): SaasPaymentRecoveryInput {
  const input = record(value, invalid); exactKeys(input, ['sinceHours'], invalid);
  if (!isInt(input.sinceHours, 1, 72)) invalid();
  return { sinceHours: input.sinceHours as number };
}

// ---------- response validators (closed; any drift fails) ----------
function validateProgram(value: unknown): void {
  const p = record(value, drift);
  exactKeys(p, ['status','provider','mode','liveMode','testTaxReference','authorizationReference','version','changedAt','cardDataStored','refundExecution'], drift);
  const on = p.status === 'TEST_MODE';
  if (!has(['DISABLED','TEST_MODE'], p.status) || (on ? !has(PROVIDERS, p.provider) || p.mode !== 'TEST' || !text(p.testTaxReference, 200) || !text(p.authorizationReference, 200)
      : p.provider !== null || p.mode !== null || p.testTaxReference !== null)
    || !nullable(p.authorizationReference, (v): v is string => text(v, 200)) || p.liveMode !== 'UNAVAILABLE' || !isInt(p.version, 1, 2147483647)
    || !isTimestamp(p.changedAt) || p.cardDataStored !== false || p.refundExecution !== 'UNAVAILABLE') drift();
}
function validateCheckout(value: unknown): void {
  const c = record(value, drift);
  exactKeys(c, ['checkoutId','organizationId','schoolId','offerId','planCode','offerKind','billingInterval','amountMinor','currency','founderReservationId',
    'requesterKind','provider','mode','providerSessionId','checkoutUrl','status','statusReason','subscriptionId','invoiceId','expiresAt','version','createdAt','completedAt'], drift);
  if (!isUuid(c.checkoutId) || !isUuid(c.organizationId) || !nullable(c.schoolId, isUuid) || !isUuid(c.offerId) || !has(['CORE','COMPLETE'], c.planCode)
    || !has(OFFER_KINDS, c.offerKind) || c.billingInterval !== (c.offerKind === 'FOUNDER_LIFETIME' ? 'LIFETIME' : 'MONTHLY')
    || !isInt(c.amountMinor, 100, 10_000_000) || c.currency !== 'USD' || !nullable(c.founderReservationId, isUuid)
    || (c.founderReservationId === null) !== (c.offerKind === 'REGULAR_MONTHLY') || !has(['SCHOOL_OWNER','HQ'], c.requesterKind)
    || (c.requesterKind === 'SCHOOL_OWNER') !== (c.schoolId !== null) || !has(PROVIDERS, c.provider) || c.mode !== 'TEST'
    || !nullable(c.providerSessionId, (v): v is string => typeof v === 'string' && SESSION.test(v))
    || !nullable(c.checkoutUrl, (v): v is string => typeof v === 'string' && URL_RE.test(v)) || (c.checkoutUrl !== null) !== (c.status === 'OPEN')
    || !has(STATUSES, c.status) || !has(REASONS, c.statusReason) || !nullable(c.subscriptionId, isUuid) || !nullable(c.invoiceId, isUuid)
    || (c.status === 'COMPLETED') !== (c.subscriptionId !== null && c.invoiceId !== null && c.completedAt !== null)
    || !isTimestamp(c.expiresAt) || !isInt(c.version, 1, 2147483647) || !isTimestamp(c.createdAt) || !nts(c.completedAt)) drift();
}
function validateEventResult(value: unknown): void {
  const e = record(value, drift);
  exactKeys(e, ['eventId','providerEventId','type','outcome','detail','organizationId','checkoutId','subscriptionId'], drift);
  if (!isUuid(e.eventId) || typeof e.providerEventId !== 'string' || !/^evt_[A-Za-z0-9_]{1,200}$/.test(e.providerEventId) || typeof e.type !== 'string'
    || !has(OUTCOMES, e.outcome) || typeof e.detail !== 'string' || !/^[A-Z_]{3,60}$/.test(e.detail)
    || !nullable(e.organizationId, isUuid) || !nullable(e.checkoutId, isUuid) || !nullable(e.subscriptionId, isUuid)) drift();
}
export function validateSaasPaymentsView(value: unknown): SaasPaymentsView {
  const r = record(value, drift); exactKeys(r, ['program','checkouts','events','reconciliation','asOf'], drift);
  validateProgram(r.program);
  if (!Array.isArray(r.checkouts) || r.checkouts.length > 100 || !Array.isArray(r.events) || r.events.length > 100 || !isTimestamp(r.asOf)) drift();
  (r.checkouts as unknown[]).forEach(validateCheckout);
  (r.events as unknown[]).forEach(v => {
    const e = record(v, drift);
    exactKeys(e, ['eventId','provider','providerEventId','type','organizationId','checkoutId','subscriptionId','outcome','detail','providerCreatedAt','receivedAt'], drift);
    if (!isUuid(e.eventId) || !has(PROVIDERS, e.provider) || typeof e.providerEventId !== 'string' || typeof e.type !== 'string'
      || !nullable(e.organizationId, isUuid) || !nullable(e.checkoutId, isUuid) || !nullable(e.subscriptionId, isUuid) || !has(OUTCOMES, e.outcome)
      || typeof e.detail !== 'string' || !isTimestamp(e.providerCreatedAt) || !isTimestamp(e.receivedAt)) drift();
  });
  const k = record(r.reconciliation, drift);
  exactKeys(k, ['openPastExpiry','createdWithoutProviderSession','paidNeedsReview','eventsNeedingReview','awaitingAsyncPayment'], drift);
  if (!Object.values(k).every(count)) drift();
  return r as unknown as SaasPaymentsView;
}
export function validateSaasSchoolPlanOptions(value: unknown): SaasSchoolPlanOptions {
  const r = record(value, drift);
  exactKeys(r, ['schoolId','entitlementTier','payments','offers','subscription','paymentVerification','checkout','annualBilling','planChanges','cardDataStored'], drift);
  if (!isUuid(r.schoolId) || !nullable(r.entitlementTier, (v): v is string => has(['ESSENTIAL','CORE','COMPLETE'], v)) || !Array.isArray(r.offers)
    || r.annualBilling !== 'UNAVAILABLE' || r.planChanges !== 'UNAVAILABLE' || r.cardDataStored !== false) drift();
  const p = record(r.payments, drift); exactKeys(p, ['status','mode'], drift);
  if (!has(['DISABLED','TEST_MODE'], p.status) || p.mode !== (p.status === 'TEST_MODE' ? 'TEST' : null)) drift();
  (r.offers as unknown[]).forEach(v => {
    const o = record(v, drift);
    exactKeys(o, ['offerId','planCode','offerKind','billingInterval','priceMinor','currency','monthlyPremiumCredits','founderSlotsRemaining'], drift);
    // A null tier means no entitlement in effect for checkout, or awaiting a first payment: only Core or Complete offers.
    if (!isUuid(o.offerId) || (r.entitlementTier === null ? !has(['CORE','COMPLETE'], o.planCode) : o.planCode !== r.entitlementTier) || !has(OFFER_KINDS, o.offerKind)
      || o.billingInterval !== (o.offerKind === 'FOUNDER_LIFETIME' ? 'LIFETIME' : 'MONTHLY') || !isInt(o.priceMinor, 100, 10_000_000) || o.currency !== 'USD'
      || !nullable(o.monthlyPremiumCredits, (x): x is number => isInt(x, 1, 1_000_000))
      || (o.offerKind === 'REGULAR_MONTHLY' ? o.founderSlotsRemaining !== null : !nullable(o.founderSlotsRemaining, count))) drift();
  });
  if (r.subscription !== null) validateSaasSubscriptionForSchool(r.subscription);
  const sub = r.subscription as { paymentStatus?: string } | null;
  if (!has(['PROVIDER_VERIFIED','HQ_ATTESTED','NONE'], r.paymentVerification) || (sub?.paymentStatus === 'PAID') === (r.paymentVerification === 'NONE')) drift();
  if (r.checkout !== null) validateCheckout(r.checkout);
  return r as unknown as SaasSchoolPlanOptions;
}
export function validateSaasPaymentProgramReceipt(value: unknown): SaasPaymentProgramReceipt {
  const r = record(value, drift); exactKeys(r, ['program','replayed'], drift); validateProgram(r.program);
  if (typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasPaymentProgramReceipt;
}
export function validateSaasCheckoutReceipt(value: unknown): SaasCheckoutReceipt {
  const r = record(value, drift); exactKeys(r, ['checkout','replayed'], drift); validateCheckout(r.checkout);
  if (typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasCheckoutReceipt;
}
export function validateSaasProviderEventReceipt(value: unknown): SaasProviderEventReceipt {
  const r = record(value, drift); exactKeys(r, ['event','replayed'], drift); validateEventResult(r.event);
  if (typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasProviderEventReceipt;
}
export function validateSaasCheckoutSweepReceipt(value: unknown): SaasCheckoutSweepReceipt {
  const r = record(value, drift); exactKeys(r, ['expired','asOf','replayed'], drift);
  if (!count(r.expired) || !isTimestamp(r.asOf) || typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasCheckoutSweepReceipt;
}
