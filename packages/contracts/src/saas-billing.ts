// HON Subscription Billing Milestone B1 closed contracts: HON billing schools (never school-to-family
// billing). Recordkeeping only: no contract here carries a charge, invoice, payment, refund,
// credit grant or balance. chargesEnabled/creditGrantsEnabled are always false (HON never initiates a
// charge). Since B5, paymentStatus/paidThroughAt are derived from B2 invoices and evidence; whether that
// evidence is provider-verified is reported by B2 payment standing (verified vs recorded).
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsNullable as nullable, championsRecord as record } from './champions-club.js';

export type SaasPlanCode = 'ESSENTIAL' | 'CORE' | 'COMPLETE';
export type SaasPublicPlanCode = 'CORE' | 'COMPLETE';
export type SaasOfferKind = 'REGULAR_MONTHLY' | 'FOUNDER_MONTHLY' | 'FOUNDER_LIFETIME';
/** Recognized but refused while ANNUAL_BILLING is undecided (422 SAAS_POLICY_UNDECIDED). */
export type SaasUndecidedOfferKind = 'REGULAR_ANNUAL' | 'FOUNDER_ANNUAL';
export type SaasCatalogStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';
export type SaasFounderEligibility = 'UNDECIDED' | 'NO_PRIOR_CATALOG_SUBSCRIPTION' | 'ANY_ACTIVE_ORGANIZATION';
export type SaasPolicyCode = 'ANNUAL_BILLING' | 'TAXES' | 'PRORATION' | 'PLAN_CHANGE_TIMING' | 'CANCELLATION_TIMING' | 'REFUND_EXECUTION'
  | 'PAYMENT_PROVIDER' | 'FOUNDER_SLOT_RETURN' | 'CREDIT_ROLLOVER' | 'TOP_UP_PRICING'
  | 'REFUND_GUARANTEE' | 'FOUNDER_PROGRAM' | 'FOUNDER_RESERVATION_HOLD' | 'FOUNDER_ALLOWANCE'
  | 'PLAN_ALLOWANCES' | 'PREMIUM_OPERATIONS' | 'SUSPENDED_ALLOWANCE' | 'PAYMENT_ATTESTATION'
  | 'ZERO_DOLLAR_INVOICE' | 'REWARD_CLAWBACK' | 'CHAMPIONS_REWARD_LADDER' | 'PAID_ACCESS';
/** PROPOSED and DECIDED record owner direction only; actionsEnabled stays false until a reviewed migration enables an action. */
export type SaasPolicyStatus = 'UNDECIDED' | 'PROPOSED' | 'DECIDED';
export type SaasReservationStatus = 'RESERVED' | 'ALLOCATED' | 'RELEASED' | 'EXPIRED';
export type SaasReservationReason = 'RESERVED' | 'SUBSCRIPTION_RECORDED' | 'OWNER_RELEASED' | 'SCHOOL_DECLINED' | 'NOT_ELIGIBLE' | 'HOLD_EXPIRED' | 'SUBSCRIPTION_VOIDED';
export type SaasSubscriptionStatus = 'PENDING_ACTIVATION' | 'IN_SERVICE' | 'SUSPENDED' | 'VOIDED';
export type SaasSubscriptionReason = 'RECORDED' | 'SERVICE_STARTED' | 'OWNER_HOLD' | 'ACCOUNT_REVIEW' | 'SCHOOL_REQUEST' | 'REVIEW_RESOLVED' | 'PERIOD_ELAPSED' | 'RECORDED_IN_ERROR';

export const SAAS_POLICY_CODES: readonly SaasPolicyCode[] = ['ANNUAL_BILLING','CANCELLATION_TIMING','CHAMPIONS_REWARD_LADDER','CREDIT_ROLLOVER',
  'FOUNDER_ALLOWANCE','FOUNDER_PROGRAM','FOUNDER_RESERVATION_HOLD','FOUNDER_SLOT_RETURN','PAID_ACCESS','PAYMENT_ATTESTATION','PAYMENT_PROVIDER','PLAN_ALLOWANCES',
  'PLAN_CHANGE_TIMING','PREMIUM_OPERATIONS','PRORATION','REFUND_EXECUTION','REFUND_GUARANTEE','REWARD_CLAWBACK','SUSPENDED_ALLOWANCE','TAXES',
  'TOP_UP_PRICING','ZERO_DOLLAR_INVOICE'];
export const SAAS_RESERVATION_STATUSES: readonly SaasReservationStatus[] = ['RESERVED','ALLOCATED','RELEASED','EXPIRED'];
export const SAAS_SUBSCRIPTION_STATUSES: readonly SaasSubscriptionStatus[] = ['PENDING_ACTIVATION','IN_SERVICE','SUSPENDED','VOIDED'];
const RESERVATION_REASONS: readonly SaasReservationReason[] = ['RESERVED','SUBSCRIPTION_RECORDED','OWNER_RELEASED','SCHOOL_DECLINED','NOT_ELIGIBLE','HOLD_EXPIRED','SUBSCRIPTION_VOIDED'];
const SUBSCRIPTION_REASONS: readonly SaasSubscriptionReason[] = ['RECORDED','SERVICE_STARTED','OWNER_HOLD','ACCOUNT_REVIEW','SCHOOL_REQUEST','REVIEW_RESOLVED','PERIOD_ELAPSED','RECORDED_IN_ERROR'];

/** Canonical functional entitlements (owner-approved). Mirrors hon.saas_plan_capabilities in 0154. */
export const SAAS_CORE_CAPABILITIES = ['crm.families_students_prospects','operations.classes_scheduling_attendance','operations.memberships_payments',
  'progression.testing_curriculum','marketing.connections_reporting','marketing.campaigns_manual_assisted','attribution.conversion',
  'assistant.ordinary','ai.premium_metered','presentation.all_modes','champions.participation'] as const;
export const SAAS_COMPLETE_ONLY_CAPABILITIES = ['marketing.campaigns_ai_managed','attribution.ai_insight','ai.workforce','ai.delegated_jobs','ai.orchestration'] as const;
export const SAAS_PLAN_CAPABILITIES: Record<SaasPlanCode, readonly string[]> = {
  ESSENTIAL: ['legacy.existing_entitlement'],
  CORE: SAAS_CORE_CAPABILITIES,
  COMPLETE: [...SAAS_CORE_CAPABILITIES, ...SAAS_COMPLETE_ONLY_CAPABILITIES],
};

/** Human-command header values, one per command route. */
export const SAAS_COMMANDS = {
  recordSubscriptionGeneration: 'saas-subscription-generation-record',
  recordPriceSchedule: 'saas-price-schedule-record',
  acceptPriceSchedule: 'saas-price-schedule-accept',
  proposeTrialPolicy: 'saas-trial-policy-propose',
  decideTrialPolicy: 'saas-trial-policy-decide',
  draftTrialCampaign: 'saas-trial-campaign-draft',
  publishTrialCampaign: 'saas-trial-campaign-publish',
  withdrawTrialCampaign: 'saas-trial-campaign-withdraw',
  createCatalogDraft: 'saas-catalog-draft',
  publishCatalog: 'saas-catalog-publish',
  reserveFounder: 'saas-founder-reserve',
  releaseFounder: 'saas-founder-release',
  recordSubscription: 'saas-subscription-record',
  subscriptionCommand: 'saas-subscription-command',
  createInvoiceDraft: 'saas-invoice-draft',
  invoiceCommand: 'saas-invoice-command',
  recordPaymentEvidence: 'saas-payment-evidence',
  setCreditProgram: 'saas-credit-program',
  recordCostEvidence: 'saas-cost-evidence',
  createPricingDraft: 'saas-pricing-draft',
  publishPricing: 'saas-pricing-publish',
  allowanceCommand: 'saas-credit-allowance',
  resolveCreditReservation: 'saas-credit-resolve',
  createRefundRequest: 'saas-refund-request',
  decideRefundRequest: 'saas-refund-decide',
  setRewardFulfillment: 'saas-reward-fulfillment',
  applyChampionsReward: 'saas-reward-apply',
  applyAccountCredit: 'saas-account-credit-apply',
  resolveReferralAlert: 'saas-referral-alert-resolve',
  setPaymentProgram: 'saas-payment-program',
  startCheckout: 'saas-checkout-start',
  cancelCheckout: 'saas-checkout-cancel',
  sweepCheckouts: 'saas-checkout-sweep',
  recoverPaymentEvents: 'saas-payment-recover',
  awaitFirstPayment: 'saas-access-await',
  retryFirstPaymentActivation: 'saas-access-retry',
  createOfferSetDraft: 'saas-offer-set-draft',
  reviseOfferSetDraft: 'saas-offer-set-revise',
  discardOfferSetDraft: 'saas-offer-set-discard',
  publishOfferSet: 'saas-offer-set-publish',
  stopOfferSales: 'saas-offer-sales-stop',
  startHonOsCheckout: 'saas-hon-os-checkout-start',
  grantAccessException: 'saas-access-exception-grant',
  revokeAccessException: 'saas-access-exception-revoke',
  closeExpiredAccessExceptions: 'saas-access-exception-close',
  decideExceptionPolicy: 'saas-access-exception-policy-decision',
  aiSpendPause: 'ai-spend-pause',
  aiUnknownResolve: 'ai-unknown-resolve',
  aiLateProviderExpense: 'ai-late-provider-expense',
  setCreativeProgram: 'saas-creative-program',
  publishCreativeRates: 'saas-creative-rates-publish',
  grantCreativeCredits: 'saas-creative-grant',
  debitCreativeLot: 'saas-creative-debit',
  resolveCreativeReservation: 'saas-creative-resolve',
  recordCreativeCost: 'saas-creative-cost-record',
  openCreativeWindow: 'saas-creative-window-open',
  createCreativeTopupPurchase: 'saas-creative-topup-purchase',
} as const;
export type SaasCommand = typeof SAAS_COMMANDS[keyof typeof SAAS_COMMANDS];

// ---------- inputs ----------
export interface SaasPlanDraft { planCode: SaasPublicPlanCode; displayName: string; plannedMonthlyPremiumCredits: number | null }
export interface SaasOfferDraft { planCode: SaasPublicPlanCode; offerKind: SaasOfferKind | SaasUndecidedOfferKind; priceMinor: number }
export interface SaasFounderProgram {
  totalLimit: number | null; lifetimeLimit: number | null; monthlyLimit: number | null; eligibility: SaasFounderEligibility;
  reservationHoldDays: number | null; opensAt: string | null; closesAt: string | null;
}
export interface SaasCatalogDraftInput { termsReference: string | null; plans: SaasPlanDraft[]; offers: SaasOfferDraft[]; founderProgram: SaasFounderProgram }

/**
 * Owner-approved plan intent as a starting draft for HQ. The 1-day hold is the owner's recommendation
 * (FOUNDER_RESERVATION_HOLD, PROPOSED). Eligibility, window and terms stay undecided (null / UNDECIDED),
 * so founder offers cannot be published until the owner sets them.
 * The monthly founder limit is explicit: unused lifetime slots are not silently treated as monthly.
 */
export const SAAS_OWNER_APPROVED_DRAFT: SaasCatalogDraftInput = {
  termsReference: null,
  plans: [
    { planCode: 'CORE', displayName: 'HON Core', plannedMonthlyPremiumCredits: 5000 },
    { planCode: 'COMPLETE', displayName: 'HON Complete', plannedMonthlyPremiumCredits: 12000 },
  ],
  offers: [
    { planCode: 'CORE', offerKind: 'REGULAR_MONTHLY', priceMinor: 14900 },
    { planCode: 'CORE', offerKind: 'FOUNDER_MONTHLY', priceMinor: 7900 },
    { planCode: 'CORE', offerKind: 'FOUNDER_LIFETIME', priceMinor: 189600 },
    { planCode: 'COMPLETE', offerKind: 'REGULAR_MONTHLY', priceMinor: 24900 },
    { planCode: 'COMPLETE', offerKind: 'FOUNDER_MONTHLY', priceMinor: 14900 },
    { planCode: 'COMPLETE', offerKind: 'FOUNDER_LIFETIME', priceMinor: 357600 },
  ],
  founderProgram: { totalLimit: 50, lifetimeLimit: 20, monthlyLimit: 30, eligibility: 'UNDECIDED', reservationHoldDays: 1, opensAt: null, closesAt: null },
};

export interface SaasFounderReserveInput { organizationId: string; offerId: string }
export interface SaasFounderReleaseInput { expectedVersion: number; reasonCode: 'OWNER_RELEASED' | 'SCHOOL_DECLINED' | 'NOT_ELIGIBLE' | 'HOLD_EXPIRED' }
export type SaasSubscriptionRecordInput =
  | { source: 'CATALOG_OFFER'; organizationId: string; offerId: string; founderReservationId: string | null }
  | { source: 'LEGACY_ENTITLEMENT'; organizationId: string };
export type SaasSubscriptionCommand =
  | { action: 'START_SERVICE'; expectedVersion: number; reasonCode: 'SERVICE_STARTED' }
  | { action: 'SUSPEND'; expectedVersion: number; reasonCode: 'OWNER_HOLD' | 'ACCOUNT_REVIEW' | 'SCHOOL_REQUEST' }
  | { action: 'RESUME'; expectedVersion: number; reasonCode: 'REVIEW_RESOLVED' }
  | { action: 'ADVANCE_PERIOD'; expectedVersion: number; reasonCode: 'PERIOD_ELAPSED' }
  | { action: 'VOID'; expectedVersion: number; reasonCode: 'RECORDED_IN_ERROR' }
  /** Refused while PLAN_CHANGE_TIMING / PRORATION are undecided. */
  | { action: 'CHANGE_OFFER'; expectedVersion: number; reasonCode: 'SCHOOL_REQUEST'; offerId: string }
  /** Refused while CANCELLATION_TIMING / REFUND_EXECUTION are undecided. */
  | { action: 'CANCEL'; expectedVersion: number; reasonCode: 'SCHOOL_REQUEST' };

// ---------- responses ----------
export interface SaasPlan {
  planCode: SaasPlanCode; entitlementTier: SaasPlanCode; availability: 'PUBLIC' | 'LEGACY_ONLY'; displayName: string;
  plannedMonthlyPremiumCredits: number | null; capabilities: string[]; ordinaryUseConsumesCredits: false;
}
export interface SaasOffer {
  offerId: string; planCode: SaasPublicPlanCode; offerKind: SaasOfferKind; billingInterval: 'MONTHLY' | 'LIFETIME'; priceMinor: number;
  founder: boolean; allowance: 'FULL_MONTHLY_PLAN_ALLOWANCE';
}
export interface SaasCatalog {
  catalogId: string; catalogVersion: number; status: SaasCatalogStatus; currency: 'USD'; termsReference: string | null;
  plans: SaasPlan[]; offers: SaasOffer[]; founderProgram: SaasFounderProgram;
  chargesEnabled: false; creditGrantsEnabled: false; createdAt: string; publishedAt: string | null; retiredAt: string | null;
}
export interface SaasPolicy {
  policyCode: SaasPolicyCode; status: SaasPolicyStatus; decision: string | null; summary: string | null; blocks: string;
  actionsEnabled: false; version: number;
}
export interface SaasFounderInventory {
  status: 'NOT_PUBLISHED' | 'UNDECIDED' | 'CONFIGURED';
  totalLimit: number | null; lifetimeLimit: number | null; monthlyLimit: number | null;
  lifetime: { allocated: number; held: number }; monthly: { allocated: number; held: number };
  remaining: { total: number | null; lifetime: number | null; monthly: number | null };
}
export interface SaasCatalogView {
  published: SaasCatalog | null; drafts: SaasCatalog[]; policies: SaasPolicy[]; founderInventory: SaasFounderInventory;
  chargesEnabled: false; creditGrantsEnabled: false; paymentProvider: 'NOT_CONFIGURED';
}
export interface SaasCatalogDraftReceipt { catalog: SaasCatalog; replayed: boolean }
export interface SaasCatalogPublishReceipt { catalog: SaasCatalog; retiredCatalogId: string | null; replayed: boolean }
export interface SaasFounderReservation {
  reservationId: string; organizationId: string; organizationName: string; offerId: string; planCode: SaasPublicPlanCode;
  offerKind: 'FOUNDER_MONTHLY' | 'FOUNDER_LIFETIME'; pool: 'LIFETIME' | 'MONTHLY'; status: SaasReservationStatus; statusReason: SaasReservationReason;
  version: number; holdExpiresAt: string; holdExpired: boolean; subscriptionId: string | null; reservedAt: string; decidedAt: string | null;
}
export interface SaasFounderReservationList { reservations: SaasFounderReservation[]; inventory: SaasFounderInventory; limit: 200 }
export interface SaasFounderReservationReceipt { reservation: SaasFounderReservation; inventory: SaasFounderInventory; replayed: boolean }
/**
 * Offer kinds a sold record (checkout, subscription, invoice, refund) can carry: the legacy catalog kinds plus the HON OS
 * kinds (0182). A HON OS record has source HON_OS_OFFER, no catalog version and no legacy founder reservation.
 */
export const SAAS_SOLD_OFFER_KINDS = ['REGULAR_MONTHLY','FOUNDER_MONTHLY','FOUNDER_LIFETIME','REGULAR_ANNUAL','FOUNDER_ANNUAL','LIFETIME'] as const;
export type SaasSoldOfferKind = typeof SAAS_SOLD_OFFER_KINDS[number];
export type SaasSoldBillingInterval = 'MONTHLY' | 'ANNUAL' | 'LIFETIME';
/** The billing interval the server derives from a sold offer kind. */
export function saasSoldInterval(kind: unknown): SaasSoldBillingInterval {
  return kind === 'LIFETIME' || kind === 'FOUNDER_LIFETIME' ? 'LIFETIME' : kind === 'REGULAR_ANNUAL' || kind === 'FOUNDER_ANNUAL' ? 'ANNUAL' : 'MONTHLY';
}
export interface SaasSubscription {
  subscriptionId: string; organizationId: string; organizationName: string; source: 'CATALOG_OFFER' | 'LEGACY_ENTITLEMENT' | 'HON_OS_OFFER';
  catalogVersion: number | null; offerId: string | null; planCode: SaasPlanCode; entitlementTier: SaasPlanCode; offerKind: SaasSoldOfferKind | null;
  billingInterval: SaasSoldBillingInterval | 'NONE'; priceMinor: number | null; currency: 'USD'; founderReservationId: string | null;
  status: SaasSubscriptionStatus; statusReason: SaasSubscriptionReason; version: number; serviceStartedAt: string | null;
  currentPeriod: { index: number | null; startsAt: string; endsAt: string | null } | null;
  paymentStatus: SaasSubscriptionPaymentStatus; paidThroughAt: string | null; chargesEnabled: false;
  premiumCredits: { plannedMonthlyAllowance: number | null; status: 'NOT_GRANTED' };
  createdAt: string; updatedAt: string;
}
export type SaasSubscriptionPaymentStatus = 'NOT_BILLED' | 'PAID' | 'DUE' | 'PAST_DUE' | 'REFUNDED' | 'DISPUTED';
export const SAAS_SUBSCRIPTION_PAYMENT_STATUSES: readonly SaasSubscriptionPaymentStatus[] = ['NOT_BILLED','PAID','DUE','PAST_DUE','REFUNDED','DISPUTED'];
export interface SaasSubscriptionList { subscriptions: SaasSubscription[]; limit: 200; chargesEnabled: false }
export interface SaasSubscriptionHistoryEntry {
  subscriptionId: string; version: number; status: SaasSubscriptionStatus; statusReason: SaasSubscriptionReason;
  periodIndex: number | null; periodStartsAt: string | null; periodEndsAt: string | null; occurredAt: string;
}
export interface SaasOrganizationSubscription {
  organizationId: string; organizationName: string; organizationStatus: string;
  entitlement: { tier: SaasPlanCode; status: string; version: number; effectiveFrom: string; effectiveUntil: string | null } | null;
  current: SaasSubscription | null; alignment: 'ALIGNED' | 'MISMATCH' | 'NO_SUBSCRIPTION' | 'NO_ENTITLEMENT';
  history: SaasSubscriptionHistoryEntry[]; founderReservations: SaasFounderReservation[]; chargesEnabled: false;
}
export interface SaasSubscriptionReceipt { subscription: SaasSubscription; replayed: boolean }
export interface SaasSubscriptionCommandReceipt { subscription: SaasSubscription; action: SaasSubscriptionCommand['action']; replayed: boolean }

// ---------- helpers ----------
const ISO_INPUT = /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PLAN_CODES = ['ESSENTIAL','CORE','COMPLETE'] as const;
const PUBLIC_PLANS = ['CORE','COMPLETE'] as const;
const OFFER_KINDS = ['REGULAR_MONTHLY','FOUNDER_MONTHLY','FOUNDER_LIFETIME'] as const;
const has = (list: readonly unknown[], value: unknown) => list.includes(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max && value.trim() === value;
const count = (v: unknown): v is number => isInt(v, 0, Number.MAX_SAFE_INTEGER);
const ts = (v: unknown) => isTimestamp(v);
const nts = (v: unknown) => v === null || isTimestamp(v);

export function saasUuid(value: unknown): string {
  if (!isUuid(value)) invalid();
  return value.toLowerCase();
}
export function validateSaasReservationStatusFilter(value: unknown): SaasReservationStatus | null {
  if (value === undefined) return null;
  if (!has(SAAS_RESERVATION_STATUSES, value)) invalid();
  return value as SaasReservationStatus;
}
export function validateSaasSubscriptionStatusFilter(value: unknown): SaasSubscriptionStatus | null {
  if (value === undefined) return null;
  if (!has(SAAS_SUBSCRIPTION_STATUSES, value)) invalid();
  return value as SaasSubscriptionStatus;
}

export function validateSaasCatalogDraftInput(value: unknown): SaasCatalogDraftInput {
  const input = record(value, invalid); exactKeys(input, ['termsReference','plans','offers','founderProgram'], invalid);
  if (input.termsReference !== null && !text(input.termsReference, 500)) invalid();
  if (!Array.isArray(input.plans) || input.plans.length !== 2 || !Array.isArray(input.offers) || input.offers.length < 1 || input.offers.length > 6) invalid();
  const plans = input.plans.map(p => {
    const r = record(p, invalid); exactKeys(r, ['planCode','displayName','plannedMonthlyPremiumCredits'], invalid);
    if (!has(PUBLIC_PLANS, r.planCode) || !text(r.displayName, 80) || (r.plannedMonthlyPremiumCredits !== null && !isInt(r.plannedMonthlyPremiumCredits, 0, 1_000_000))) invalid();
    return { planCode: r.planCode, displayName: r.displayName, plannedMonthlyPremiumCredits: r.plannedMonthlyPremiumCredits } as SaasPlanDraft;
  });
  if (new Set(plans.map(p => p.planCode)).size !== 2) invalid();
  const offers = input.offers.map(o => {
    const r = record(o, invalid); exactKeys(r, ['planCode','offerKind','priceMinor'], invalid);
    if (!has(PUBLIC_PLANS, r.planCode) || !has([...OFFER_KINDS, 'REGULAR_ANNUAL', 'FOUNDER_ANNUAL'], r.offerKind) || !isInt(r.priceMinor, 100, 10_000_000)) invalid();
    return { planCode: r.planCode, offerKind: r.offerKind, priceMinor: r.priceMinor } as SaasOfferDraft;
  });
  if (new Set(offers.map(o => `${o.planCode}:${o.offerKind}`)).size !== offers.length) invalid();
  const f = record(input.founderProgram, invalid);
  exactKeys(f, ['totalLimit','lifetimeLimit','monthlyLimit','eligibility','reservationHoldDays','opensAt','closesAt'], invalid);
  for (const key of ['totalLimit','lifetimeLimit','monthlyLimit']) if (f[key] !== null && !isInt(f[key], 0, 1000)) invalid();
  if (f.reservationHoldDays !== null && !isInt(f.reservationHoldDays, 1, 90)) invalid();
  if (!has(['UNDECIDED','NO_PRIOR_CATALOG_SUBSCRIPTION','ANY_ACTIVE_ORGANIZATION'], f.eligibility)) invalid();
  for (const key of ['opensAt','closesAt']) if (f[key] !== null && (typeof f[key] !== 'string' || !ISO_INPUT.test(f[key] as string) || !isTimestamp(f[key]))) invalid();
  const total = f.totalLimit as number | null;
  if (total !== null && ((f.lifetimeLimit !== null && (f.lifetimeLimit as number) > total) || (f.monthlyLimit !== null && (f.monthlyLimit as number) > total))) invalid();
  if (f.opensAt !== null && f.closesAt !== null && Date.parse(f.closesAt as string) <= Date.parse(f.opensAt as string)) invalid();
  return { termsReference: input.termsReference as string | null, plans, offers,
    founderProgram: { totalLimit: f.totalLimit, lifetimeLimit: f.lifetimeLimit, monthlyLimit: f.monthlyLimit, eligibility: f.eligibility,
      reservationHoldDays: f.reservationHoldDays, opensAt: f.opensAt, closesAt: f.closesAt } as SaasFounderProgram };
}
export function validateSaasFounderReserveInput(value: unknown): SaasFounderReserveInput {
  const input = record(value, invalid); exactKeys(input, ['organizationId','offerId'], invalid);
  return { organizationId: saasUuid(input.organizationId), offerId: saasUuid(input.offerId) };
}
export function validateSaasFounderReleaseInput(value: unknown): SaasFounderReleaseInput {
  const input = record(value, invalid); exactKeys(input, ['expectedVersion','reasonCode'], invalid);
  if (!isInt(input.expectedVersion, 1, 999_999_999) || !has(['OWNER_RELEASED','SCHOOL_DECLINED','NOT_ELIGIBLE','HOLD_EXPIRED'], input.reasonCode)) invalid();
  return { expectedVersion: input.expectedVersion, reasonCode: input.reasonCode as SaasFounderReleaseInput['reasonCode'] };
}
export function validateSaasSubscriptionRecordInput(value: unknown): SaasSubscriptionRecordInput {
  const input = record(value, invalid);
  if (input.source === 'LEGACY_ENTITLEMENT') {
    exactKeys(input, ['source','organizationId'], invalid);
    return { source: 'LEGACY_ENTITLEMENT', organizationId: saasUuid(input.organizationId) };
  }
  if (input.source !== 'CATALOG_OFFER') invalid();
  exactKeys(input, ['source','organizationId','offerId','founderReservationId'], invalid);
  return { source: 'CATALOG_OFFER', organizationId: saasUuid(input.organizationId), offerId: saasUuid(input.offerId),
    founderReservationId: input.founderReservationId === null ? null : saasUuid(input.founderReservationId) };
}
const COMMAND_REASONS: Record<SaasSubscriptionCommand['action'], readonly string[]> = {
  START_SERVICE: ['SERVICE_STARTED'], SUSPEND: ['OWNER_HOLD','ACCOUNT_REVIEW','SCHOOL_REQUEST'], RESUME: ['REVIEW_RESOLVED'],
  ADVANCE_PERIOD: ['PERIOD_ELAPSED'], VOID: ['RECORDED_IN_ERROR'], CHANGE_OFFER: ['SCHOOL_REQUEST'], CANCEL: ['SCHOOL_REQUEST'],
};
export function validateSaasSubscriptionCommand(value: unknown): SaasSubscriptionCommand {
  const input = record(value, invalid);
  const action = input.action as SaasSubscriptionCommand['action'];
  if (typeof action !== 'string' || !Object.hasOwn(COMMAND_REASONS, action)) invalid();
  if (action === 'CHANGE_OFFER') {
    exactKeys(input, ['action','expectedVersion','reasonCode','offerId'], invalid);
  } else exactKeys(input, ['action','expectedVersion','reasonCode'], invalid);
  if (!isInt(input.expectedVersion, 1, 999_999_999) || !COMMAND_REASONS[action].includes(input.reasonCode as string)) invalid();
  const base = { action, expectedVersion: input.expectedVersion, reasonCode: input.reasonCode };
  return (action === 'CHANGE_OFFER' ? { ...base, offerId: saasUuid(input.offerId) } : base) as SaasSubscriptionCommand;
}

// ---------- response validators (closed; any drift fails) ----------
function validateFounderProgram(value: unknown): void {
  const f = record(value, drift); exactKeys(f, ['totalLimit','lifetimeLimit','monthlyLimit','eligibility','reservationHoldDays','opensAt','closesAt'], drift);
  for (const key of ['totalLimit','lifetimeLimit','monthlyLimit']) if (!nullable(f[key], (v): v is number => isInt(v, 0, 1000))) drift();
  if (!nullable(f.reservationHoldDays, (v): v is number => isInt(v, 1, 90)) || !has(['UNDECIDED','NO_PRIOR_CATALOG_SUBSCRIPTION','ANY_ACTIVE_ORGANIZATION'], f.eligibility)
    || !nts(f.opensAt) || !nts(f.closesAt)) drift();
}
function validateCatalog(value: unknown): void {
  const c = record(value, drift);
  exactKeys(c, ['catalogId','catalogVersion','status','currency','termsReference','plans','offers','founderProgram','chargesEnabled','creditGrantsEnabled',
    'createdAt','publishedAt','retiredAt'], drift);
  if (!isUuid(c.catalogId) || !isInt(c.catalogVersion, 1, 2147483647) || !has(['DRAFT','PUBLISHED','RETIRED'], c.status) || c.currency !== 'USD'
    || (c.termsReference !== null && !text(c.termsReference, 500)) || c.chargesEnabled !== false || c.creditGrantsEnabled !== false
    || !ts(c.createdAt) || !nts(c.publishedAt) || !nts(c.retiredAt) || (c.status === 'DRAFT') !== (c.publishedAt === null)
    || (c.status === 'RETIRED') !== (c.retiredAt !== null)) drift();
  if (!Array.isArray(c.plans) || c.plans.length !== 3) drift();
  for (const p of c.plans as unknown[]) {
    const r = record(p, drift);
    exactKeys(r, ['planCode','entitlementTier','availability','displayName','plannedMonthlyPremiumCredits','capabilities','ordinaryUseConsumesCredits'], drift);
    const code = r.planCode as SaasPlanCode;
    if (!has(PLAN_CODES, code) || r.entitlementTier !== code || r.availability !== (code === 'ESSENTIAL' ? 'LEGACY_ONLY' : 'PUBLIC') || !text(r.displayName, 80)
      || !nullable(r.plannedMonthlyPremiumCredits, (v): v is number => isInt(v, 0, 1_000_000)) || (code === 'ESSENTIAL' && r.plannedMonthlyPremiumCredits !== null)
      || !Array.isArray(r.capabilities) || r.capabilities.join(',') !== SAAS_PLAN_CAPABILITIES[code].join(',') || r.ordinaryUseConsumesCredits !== false) drift();
  }
  if (!Array.isArray(c.offers)) drift();
  for (const o of c.offers as unknown[]) {
    const r = record(o, drift); exactKeys(r, ['offerId','planCode','offerKind','billingInterval','priceMinor','founder','allowance'], drift);
    if (!isUuid(r.offerId) || !has(PUBLIC_PLANS, r.planCode) || !has(OFFER_KINDS, r.offerKind)
      || r.billingInterval !== (r.offerKind === 'FOUNDER_LIFETIME' ? 'LIFETIME' : 'MONTHLY') || !isInt(r.priceMinor, 100, 10_000_000)
      || r.founder !== (r.offerKind !== 'REGULAR_MONTHLY') || r.allowance !== 'FULL_MONTHLY_PLAN_ALLOWANCE') drift();
  }
  validateFounderProgram(c.founderProgram);
}
function validateInventory(value: unknown): void {
  const i = record(value, drift); exactKeys(i, ['status','totalLimit','lifetimeLimit','monthlyLimit','lifetime','monthly','remaining'], drift);
  if (!has(['NOT_PUBLISHED','UNDECIDED','CONFIGURED'], i.status)) drift();
  for (const key of ['totalLimit','lifetimeLimit','monthlyLimit']) if (!nullable(i[key], count)) drift();
  for (const key of ['lifetime','monthly']) { const p = record(i[key], drift); exactKeys(p, ['allocated','held'], drift); if (!count(p.allocated) || !count(p.held)) drift(); }
  const r = record(i.remaining, drift); exactKeys(r, ['total','lifetime','monthly'], drift);
  if (!nullable(r.total, count) || !nullable(r.lifetime, count) || !nullable(r.monthly, count)) drift();
  if (i.status !== 'CONFIGURED' && i.totalLimit === null && r.total !== null) drift();
}
function validateReservation(value: unknown): void {
  const r = record(value, drift);
  exactKeys(r, ['reservationId','organizationId','organizationName','offerId','planCode','offerKind','pool','status','statusReason','version',
    'holdExpiresAt','holdExpired','subscriptionId','reservedAt','decidedAt'], drift);
  if (!isUuid(r.reservationId) || !isUuid(r.organizationId) || !text(r.organizationName, 300) || !isUuid(r.offerId) || !has(PUBLIC_PLANS, r.planCode)
    || !has(['FOUNDER_MONTHLY','FOUNDER_LIFETIME'], r.offerKind) || r.pool !== (r.offerKind === 'FOUNDER_LIFETIME' ? 'LIFETIME' : 'MONTHLY')
    || !has(SAAS_RESERVATION_STATUSES, r.status) || !has(RESERVATION_REASONS, r.statusReason) || !isInt(r.version, 1, 2147483647)
    || !ts(r.holdExpiresAt) || typeof r.holdExpired !== 'boolean' || (r.holdExpired && r.status !== 'RESERVED')
    || !nullable(r.subscriptionId, isUuid) || (r.status === 'ALLOCATED' && r.subscriptionId === null)
    || !ts(r.reservedAt) || !nts(r.decidedAt) || (r.status === 'RESERVED') !== (r.decidedAt === null)) drift();
}
function validateSubscription(value: unknown, withName = true): void {
  const s = record(value, drift);
  exactKeys(s, ['subscriptionId','organizationId',...(withName ? ['organizationName'] : []),'source','catalogVersion','offerId','planCode','entitlementTier','offerKind',
    'billingInterval','priceMinor','currency','founderReservationId','status','statusReason','version','serviceStartedAt','currentPeriod',
    'paymentStatus','paidThroughAt','chargesEnabled','premiumCredits','createdAt','updatedAt'], drift);
  const catalog = s.source === 'CATALOG_OFFER', honOs = s.source === 'HON_OS_OFFER', periodic = s.billingInterval === 'MONTHLY' || s.billingInterval === 'ANNUAL';
  if (!isUuid(s.subscriptionId) || !isUuid(s.organizationId) || (withName && !text(s.organizationName, 300))
    || !has(['CATALOG_OFFER','LEGACY_ENTITLEMENT','HON_OS_OFFER'], s.source)
    || !has(PLAN_CODES, s.planCode) || s.entitlementTier !== s.planCode || s.currency !== 'USD'
    || (catalog ? !isInt(s.catalogVersion, 1, 2147483647) || !isUuid(s.offerId) || !has(OFFER_KINDS, s.offerKind) || !isInt(s.priceMinor, 100, 10_000_000)
        || s.billingInterval !== (s.offerKind === 'FOUNDER_LIFETIME' ? 'LIFETIME' : 'MONTHLY') || s.planCode === 'ESSENTIAL'
        || (s.founderReservationId === null) !== (s.offerKind === 'REGULAR_MONTHLY')
      : honOs ? s.catalogVersion !== null || !isUuid(s.offerId) || !has(SAAS_SOLD_OFFER_KINDS, s.offerKind) || !isInt(s.priceMinor, 100, 10_000_000)
        || s.billingInterval !== saasSoldInterval(s.offerKind) || s.planCode !== 'COMPLETE' || s.founderReservationId !== null
      : s.catalogVersion !== null || s.offerId !== null || s.offerKind !== null || s.priceMinor !== null || s.billingInterval !== 'NONE' || s.founderReservationId !== null)
    || !nullable(s.founderReservationId, isUuid)
    || !has(SAAS_SUBSCRIPTION_STATUSES, s.status) || !has(SUBSCRIPTION_REASONS, s.statusReason) || !isInt(s.version, 1, 2147483647)
    || !nts(s.serviceStartedAt) || (s.serviceStartedAt !== null) !== (s.status === 'IN_SERVICE' || s.status === 'SUSPENDED')
    || !has(SAAS_SUBSCRIPTION_PAYMENT_STATUSES, s.paymentStatus) || !nts(s.paidThroughAt) || (!periodic && s.paidThroughAt !== null)
    || (!catalog && !honOs && s.paymentStatus !== 'NOT_BILLED')
    || s.chargesEnabled !== false || !ts(s.createdAt) || !ts(s.updatedAt)) drift();
  if (s.currentPeriod === null) {
    if (s.serviceStartedAt !== null && s.billingInterval !== 'NONE') drift();
  } else {
    const p = record(s.currentPeriod, drift); exactKeys(p, ['index','startsAt','endsAt'], drift);
    if (s.serviceStartedAt === null || s.billingInterval === 'NONE' || !ts(p.startsAt)
      || (periodic ? !count(p.index) || !ts(p.endsAt) : p.index !== null || p.endsAt !== null)) drift();
  }
  const c = record(s.premiumCredits, drift); exactKeys(c, ['plannedMonthlyAllowance','status'], drift);
  if (!nullable(c.plannedMonthlyAllowance, count) || c.status !== 'NOT_GRANTED') drift();
}

export function validateSaasCatalogView(value: unknown): SaasCatalogView {
  const r = record(value, drift);
  exactKeys(r, ['published','drafts','policies','founderInventory','chargesEnabled','creditGrantsEnabled','paymentProvider'], drift);
  if (r.published !== null) { validateCatalog(r.published); if ((r.published as SaasCatalog).status !== 'PUBLISHED') drift(); }
  if (!Array.isArray(r.drafts) || r.drafts.length > 10) drift();
  for (const d of r.drafts as unknown[]) { validateCatalog(d); if ((d as SaasCatalog).status !== 'DRAFT') drift(); }
  if (!Array.isArray(r.policies) || r.policies.length !== SAAS_POLICY_CODES.length) drift();
  (r.policies as unknown[]).forEach((p, i) => {
    const q = record(p, drift); exactKeys(q, ['policyCode','status','decision','summary','blocks','actionsEnabled','version'], drift);
    if (q.policyCode !== SAAS_POLICY_CODES[i] || !has(['UNDECIDED','PROPOSED','DECIDED'], q.status)
      || (q.status === 'UNDECIDED' ? q.decision !== null : typeof q.decision !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(q.decision))
      || !nullable(q.summary, (v): v is string => text(v, 500)) || !text(q.blocks, 300) || q.actionsEnabled !== false || !isInt(q.version, 1, 2147483647)) drift();
  });
  validateInventory(r.founderInventory);
  if (r.chargesEnabled !== false || r.creditGrantsEnabled !== false || r.paymentProvider !== 'NOT_CONFIGURED') drift();
  return r as unknown as SaasCatalogView;
}
export function validateSaasCatalogDraftReceipt(value: unknown): SaasCatalogDraftReceipt {
  const r = record(value, drift); exactKeys(r, ['catalog','replayed'], drift);
  validateCatalog(r.catalog);
  if ((r.catalog as SaasCatalog).status !== 'DRAFT' || typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasCatalogDraftReceipt;
}
export function validateSaasCatalogPublishReceipt(value: unknown): SaasCatalogPublishReceipt {
  const r = record(value, drift); exactKeys(r, ['catalog','retiredCatalogId','replayed'], drift);
  validateCatalog(r.catalog);
  if ((r.catalog as SaasCatalog).status === 'DRAFT' || !nullable(r.retiredCatalogId, isUuid) || typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasCatalogPublishReceipt;
}
export function validateSaasFounderReservationList(value: unknown): SaasFounderReservationList {
  const r = record(value, drift); exactKeys(r, ['reservations','inventory','limit'], drift);
  if (!Array.isArray(r.reservations) || r.reservations.length > 200 || r.limit !== 200) drift();
  (r.reservations as unknown[]).forEach(validateReservation); validateInventory(r.inventory);
  return r as unknown as SaasFounderReservationList;
}
export function validateSaasFounderReservationReceipt(value: unknown): SaasFounderReservationReceipt {
  const r = record(value, drift); exactKeys(r, ['reservation','inventory','replayed'], drift);
  validateReservation(r.reservation); validateInventory(r.inventory);
  if (typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasFounderReservationReceipt;
}
export function validateSaasSubscriptionList(value: unknown): SaasSubscriptionList {
  const r = record(value, drift); exactKeys(r, ['subscriptions','limit','chargesEnabled'], drift);
  if (!Array.isArray(r.subscriptions) || r.subscriptions.length > 200 || r.limit !== 200 || r.chargesEnabled !== false) drift();
  (r.subscriptions as unknown[]).forEach(v => validateSubscription(v));
  return r as unknown as SaasSubscriptionList;
}
export function validateSaasOrganizationSubscription(value: unknown): SaasOrganizationSubscription {
  const r = record(value, drift);
  exactKeys(r, ['organizationId','organizationName','organizationStatus','entitlement','current','alignment','history','founderReservations','chargesEnabled'], drift);
  if (!isUuid(r.organizationId) || !text(r.organizationName, 300) || !text(r.organizationStatus, 40)
    || !has(['ALIGNED','MISMATCH','NO_SUBSCRIPTION','NO_ENTITLEMENT'], r.alignment) || r.chargesEnabled !== false) drift();
  if (r.entitlement !== null) {
    const e = record(r.entitlement, drift); exactKeys(e, ['tier','status','version','effectiveFrom','effectiveUntil'], drift);
    if (!has(PLAN_CODES, e.tier) || !text(e.status, 40) || !isInt(e.version, 1, 2147483647) || !ts(e.effectiveFrom) || !nts(e.effectiveUntil)) drift();
  }
  if (r.current !== null) { validateSubscription(r.current); if ((r.current as SaasSubscription).status === 'VOIDED') drift(); }
  if ((r.entitlement === null) !== (r.alignment === 'NO_ENTITLEMENT') || (r.entitlement !== null && (r.current === null) !== (r.alignment === 'NO_SUBSCRIPTION'))) drift();
  if (!Array.isArray(r.history) || r.history.length > 50 || !Array.isArray(r.founderReservations) || r.founderReservations.length > 20) drift();
  for (const h of r.history as unknown[]) {
    const e = record(h, drift); exactKeys(e, ['subscriptionId','version','status','statusReason','periodIndex','periodStartsAt','periodEndsAt','occurredAt'], drift);
    if (!isUuid(e.subscriptionId) || !isInt(e.version, 1, 2147483647) || !has(SAAS_SUBSCRIPTION_STATUSES, e.status) || !has(SUBSCRIPTION_REASONS, e.statusReason)
      || !nullable(e.periodIndex, count) || !nts(e.periodStartsAt) || !nts(e.periodEndsAt) || !ts(e.occurredAt)) drift();
  }
  (r.founderReservations as unknown[]).forEach(validateReservation);
  return r as unknown as SaasOrganizationSubscription;
}
export function validateSaasSubscriptionReceipt(value: unknown): SaasSubscriptionReceipt {
  const r = record(value, drift); exactKeys(r, ['subscription','replayed'], drift);
  validateSubscription(r.subscription);
  if (typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasSubscriptionReceipt;
}
export function validateSaasSubscriptionCommandReceipt(value: unknown): SaasSubscriptionCommandReceipt {
  const r = record(value, drift); exactKeys(r, ['subscription','action','replayed'], drift);
  validateSubscription(r.subscription);
  if (!has(['START_SERVICE','SUSPEND','RESUME','ADVANCE_PERIOD','VOID'], r.action) || typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasSubscriptionCommandReceipt;
}
/** The school's own view of its HON subscription (B5 plan options): the same record without the organization name. */
export function validateSaasSubscriptionForSchool(value: unknown): void { validateSubscription(value, false); }
