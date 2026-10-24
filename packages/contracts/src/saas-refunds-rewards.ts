// HON Subscription Billing Milestone B4 closed contracts: 30-day refund guarantee records and Champions
// Club reward application to HON subscriptions. Nothing here moves money: refund execution is always
// UNAVAILABLE (executionStatus NOT_EXECUTED), subscription consequences stay BLOCKED_PENDING_TERMS,
// prizes are never issued and there are no cash payouts. A reward preview is never fulfillment.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsNullable as nullable, championsRecord as record } from './champions-club.js';
import { validateSaasInvoiceDetail, type SaasInvoiceDetail } from './saas-invoicing.js';

/** Legacy catalog kinds plus the HON OS kinds (0182); a HON OS purchase's refund window is its accepted offer's. */
export type SaasRefundOfferKind = 'REGULAR_MONTHLY' | 'FOUNDER_MONTHLY' | 'FOUNDER_LIFETIME' | 'REGULAR_ANNUAL' | 'FOUNDER_ANNUAL' | 'LIFETIME';
export type SaasRefundStatus = 'REQUESTED' | 'APPROVED' | 'DENIED' | 'REFUND_EVIDENCED';
export type SaasRefundStatusReason = 'REQUESTED' | 'GUARANTEE_APPROVED' | 'OWNER_DECLINED_TERMS' | 'FRAUD_SUSPECTED' | 'DUPLICATE_REQUEST'
  | 'REFUND_EVIDENCE_RECORDED';
export type SaasRefundDenyReason = 'OWNER_DECLINED_TERMS' | 'FRAUD_SUSPECTED' | 'DUPLICATE_REQUEST';
export type SaasRefundRefusal = 'SAAS_REFUND_NO_PAID_PURCHASE' | 'SAAS_REFUND_ALREADY_GRANTED' | 'SAAS_REFUND_REQUEST_OPEN'
  | 'SAAS_REFUND_BEFORE_PAYMENT' | 'SAAS_REFUND_WINDOW_EXPIRED' | 'SAAS_REFUND_NOTHING_TO_REFUND';
export type SaasRewardKind = 'REFERRER_CREDIT' | 'WELCOME_CREDIT' | 'FREE_MONTHS' | 'PRIZE' | 'LIFETIME_MEMBERSHIP';
export type SaasRewardApplicationKind = 'ACCOUNT_CREDIT' | 'FREE_PERIODS' | 'LIFETIME_CONVERSION';
export type SaasRewardState = 'APPLIED' | 'APPLIED_CONVERSION_BLOCKED' | 'VOIDED' | 'BLOCKED_REVIEW' | 'READY' | 'PENDING';
export type SaasRewardBlocker = 'SAAS_REWARD_VOIDED' | 'SAAS_REWARD_UNDER_REVIEW' | 'SAAS_REWARD_NOT_APPROVED' | 'SAAS_REWARD_PRIZE_MANUAL'
  | 'SAAS_REWARD_SUBSTITUTE_MANUAL' | 'SAAS_REWARD_PAYMENT_ALERT_OPEN' | 'SAAS_REWARD_NO_SUBSCRIPTION' | 'SAAS_REWARD_NOT_APPLICABLE'
  | 'SAAS_REWARD_NOTHING_TO_APPLY' | 'SAAS_REWARDS_NOT_ACTIVE';
export type SaasAlertResolution = 'ATTRIBUTION_DECIDED' | 'NO_QUALIFICATION_IMPACT';
const OFFERS: readonly SaasRefundOfferKind[] = ['REGULAR_MONTHLY','FOUNDER_MONTHLY','FOUNDER_LIFETIME','REGULAR_ANNUAL','FOUNDER_ANNUAL','LIFETIME'];
const REFUND_STATUSES: readonly SaasRefundStatus[] = ['REQUESTED','APPROVED','DENIED','REFUND_EVIDENCED'];
const REFUND_REASONS: readonly SaasRefundStatusReason[] = ['REQUESTED','GUARANTEE_APPROVED','OWNER_DECLINED_TERMS','FRAUD_SUSPECTED','DUPLICATE_REQUEST','REFUND_EVIDENCE_RECORDED'];
const DENY_REASONS: readonly SaasRefundDenyReason[] = ['OWNER_DECLINED_TERMS','FRAUD_SUSPECTED','DUPLICATE_REQUEST'];
const REFUND_REFUSALS: readonly SaasRefundRefusal[] = ['SAAS_REFUND_NO_PAID_PURCHASE','SAAS_REFUND_ALREADY_GRANTED','SAAS_REFUND_REQUEST_OPEN',
  'SAAS_REFUND_BEFORE_PAYMENT','SAAS_REFUND_WINDOW_EXPIRED','SAAS_REFUND_NOTHING_TO_REFUND'];
const REWARD_KINDS: readonly SaasRewardKind[] = ['REFERRER_CREDIT','WELCOME_CREDIT','FREE_MONTHS','PRIZE','LIFETIME_MEMBERSHIP'];
const APPLICATION_KINDS: readonly SaasRewardApplicationKind[] = ['ACCOUNT_CREDIT','FREE_PERIODS','LIFETIME_CONVERSION'];
const REWARD_STATES: readonly SaasRewardState[] = ['APPLIED','APPLIED_CONVERSION_BLOCKED','VOIDED','BLOCKED_REVIEW','READY','PENDING'];
const BLOCKERS: readonly SaasRewardBlocker[] = ['SAAS_REWARD_VOIDED','SAAS_REWARD_UNDER_REVIEW','SAAS_REWARD_NOT_APPROVED','SAAS_REWARD_PRIZE_MANUAL',
  'SAAS_REWARD_SUBSTITUTE_MANUAL','SAAS_REWARD_PAYMENT_ALERT_OPEN','SAAS_REWARD_NO_SUBSCRIPTION','SAAS_REWARD_NOT_APPLICABLE',
  'SAAS_REWARD_NOTHING_TO_APPLY','SAAS_REWARDS_NOT_ACTIVE'];
const TIERS = ['ESSENTIAL','CORE','COMPLETE'] as const;
/** Owner-approved Champions ladder (CHAMPIONS_REWARD_LADDER, DECIDED). Amounts live in the published Champions reward policy. */
export const SAAS_CHAMPIONS_LADDER = {
  referrerCreditMinor: 10000, referrerCreditMaxRank: 4, welcomeCreditMinor: 10000,
  firstFreeMonthsCount: 5, firstFreeMonthsTotal: 6, secondFreeMonthsCount: 10, secondFreeMonthsTotal: 12, prizeCount: 20, lifetimeCount: 30,
} as const;
export const SAAS_REFUND_WINDOW_DAYS = 30;
const windowDays = (ms: number) => Number.isInteger(ms / 86_400_000) && ms >= 0 && ms <= 365 * 86_400_000;

// ---------- inputs ----------
export interface SaasRefundRequestInput { organizationId: string; requestReceivedAt: string; customerReference: string; note: string | null }
export type SaasRefundDecisionInput =
  | { decision: 'APPROVE'; reasonCode: 'GUARANTEE_APPROVED'; expectedVersion: number; note: string | null }
  | { decision: 'DENY'; reasonCode: SaasRefundDenyReason; expectedVersion: number; note: string | null }
  | { decision: 'MARK_EVIDENCED'; reasonCode: 'REFUND_EVIDENCE_RECORDED'; expectedVersion: number; note: string | null };
export interface SaasRewardFulfillmentInput { action: 'ACTIVATE' | 'DEACTIVATE'; expectedVersion: number; authorizationReference: string }
/** firstPeriodIndex is required for FREE_MONTHS entries and must be null for every other reward. */
export interface SaasRewardApplyInput { expectedEntryVersion: number; firstPeriodIndex: number | null }
export interface SaasAccountCreditApplyInput { expectedVersion: number }
export interface SaasReferralAlertResolveInput { expectedVersion: number; resolution: SaasAlertResolution; reference: string }

// ---------- responses ----------
export interface SaasRefundEligibility {
  organizationId: string; eligible: boolean; refusal: SaasRefundRefusal | null; invoiceId: string | null; invoiceNumber: string | null;
  subscriptionId: string | null; offerKind: SaasRefundOfferKind | null; firstPaidAt: string | null; windowEndsAt: string | null;
  requestReceivedAt: string; refundableMinor: number; evidenceStrength: 'HQ_ATTESTED' | 'PROVIDER_VERIFIED' | null; execution: 'UNAVAILABLE';
}
export interface SaasRefundRequest {
  refundRequestId: string; organizationId: string; organizationName: string; subscriptionId: string; invoiceId: string; invoiceNumber: string;
  offerKind: SaasRefundOfferKind; firstPaidAt: string; windowEndsAt: string; requestReceivedAt: string; customerReference: string;
  requestedAmountMinor: number; approvedAmountMinor: number | null; evidenceStrength: 'HQ_ATTESTED' | 'PROVIDER_VERIFIED';
  status: SaasRefundStatus; statusReason: SaasRefundStatusReason; version: number; note: string | null;
  execution: 'UNAVAILABLE'; executionStatus: 'NOT_EXECUTED'; subscriptionConsequence: 'BLOCKED_PENDING_TERMS';
  refundEvidencedMinor: number; createdAt: string; decidedAt: string | null;
}
export interface SaasRefundRequestList { refundRequests: SaasRefundRequest[]; limit: 200; execution: 'UNAVAILABLE' }
export interface SaasRefundReserve {
  asOf: string;
  windowExposure: { organizations: number; totalMinor: number; paidLifetimeMinor: number; monthlyMinor: number; earliestWindowEndsAt: string | null };
  approvedNotEvidenced: { requests: number; totalMinor: number }; pendingRequests: { requests: number; totalMinor: number };
  recommendedReserveMinor: number; evidenceStrength: 'RECORDED'; currency: 'USD'; execution: 'UNAVAILABLE';
}
export interface SaasRewardFulfillment {
  status: 'INACTIVE' | 'ACTIVE'; version: number; authorizationReference: string | null; changedAt: string; prizes: 'NOT_ISSUED'; cashPayouts: 'DISABLED';
}
export interface SaasRewardApplication {
  applicationId: string; rewardEntryId: string; organizationId: string; subscriptionId: string; applicationKind: SaasRewardApplicationKind;
  creditMinor: number | null; freeMonths: number | null; firstPeriodIndex: number | null; lifetimeTier: typeof TIERS[number] | null;
  status: 'APPLIED' | 'CONVERSION_BLOCKED'; appliedAt: string;
}
export interface SaasRewardPreviewEntry {
  rewardEntryId: string; rewardKind: SaasRewardKind; beneficiaryRole: 'REFERRER' | 'REFERRED'; beneficiaryOrganizationId: string;
  milestoneCount: number | null; creditMinor: number | null; freeMonths: number | null; lifetimeTier: typeof TIERS[number] | null;
  aiAllowance: 'FULL_PLAN_ALLOWANCE' | null; entryStatus: 'ACCRUED' | 'APPROVED' | 'REVERSAL_REVIEW' | 'VOIDED'; entryVersion: number;
  fulfillmentForm: 'AS_EARNED' | 'OWNER_SUBSTITUTE' | null; applicationKind: SaasRewardApplicationKind | 'PRIZE_MANUAL'; subscriptionId: string | null;
  state: SaasRewardState; blocker: SaasRewardBlocker | null; application: SaasRewardApplication | null; fulfilledNotice: 'PREVIEW_IS_NOT_FULFILLMENT';
}
export interface SaasReferralAlert {
  alertId: string; attributionId: string; attributionState: 'PENDING' | 'QUALIFIED' | 'REJECTED' | 'REFUNDED' | 'REVERSED';
  referredOrganizationId: string; referredOrganizationName: string; referrerSchoolId: string; source: 'PAYMENT_EVIDENCE' | 'REFUND_REQUEST';
  paymentEvidenceId: string | null; refundRequestId: string | null; evidenceKind: 'REFUND' | 'CHARGEBACK' | 'REFUND_APPROVED';
  referredRecordedNetMinor: number; status: 'OPEN' | 'RESOLVED'; resolution: SaasAlertResolution | null; resolutionReference: string | null;
  version: number; raisedAt: string; resolvedAt: string | null; affectedApplications: string[]; automaticReversal: 'NONE'; debtCreated: false;
}
export interface SaasRewardPreview {
  organizationId: string; fulfillment: SaasRewardFulfillment; rewards: SaasRewardPreviewEntry[];
  accountCredit: { grantedMinor: number; appliedMinor: number; availableMinor: number; blockedMinor: number };
  freePeriods: { subscriptionId: string; periodIndex: number; applicationId: string }[]; alerts: SaasReferralAlert[]; currency: 'USD';
}
export interface SaasReferralAlertList { alerts: SaasReferralAlert[]; limit: 200 }
export interface SaasCreditApplicationPreview {
  invoiceId: string; invoiceStatus: 'DRAFT' | 'ISSUED' | 'VOID'; taxStatus: 'UNRESOLVED' | 'NO_TAX_APPLICABLE' | 'TAX_LINES'; subtotalMinor: number;
  availableCreditMinor: number; wouldApplyMinor: number; resultingSubtotalMinor: number; applicable: boolean; zeroTotalIssuable: false;
  fulfillment: 'INACTIVE' | 'ACTIVE'; previewOnly: true;
}
export interface SaasRefundRequestReceipt { refundRequest: SaasRefundRequest; replayed: boolean }
export interface SaasRefundDecisionReceipt { refundRequest: SaasRefundRequest; decision: SaasRefundDecisionInput['decision']; replayed: boolean }
export interface SaasRewardFulfillmentReceipt { fulfillment: SaasRewardFulfillment; replayed: boolean }
export interface SaasRewardApplyReceipt { application: SaasRewardApplication; reward: SaasRewardPreviewEntry; replayed: boolean }
export interface SaasAccountCreditApplyReceipt { invoice: SaasInvoiceDetail; appliedCreditMinor: number; replayed: boolean }
export interface SaasReferralAlertReceipt { alert: SaasReferralAlert; replayed: boolean }

// ---------- input validators ----------
const ISO_INPUT = /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const has = (list: readonly unknown[], value: unknown) => list.includes(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max && value.trim() === value;
const note = (v: unknown) => v === null || (typeof v === 'string' && v.length >= 1 && v.length <= 500);
const count = (v: unknown): v is number => isInt(v, 0, Number.MAX_SAFE_INTEGER);
const minor = (v: unknown): v is number => isInt(v, 0, 999_999_999_999);
const nts = (v: unknown) => v === null || isTimestamp(v);
const version = (v: unknown): v is number => isInt(v, 1, 999_999_999);

export function validateSaasRefundRequestInput(value: unknown): SaasRefundRequestInput {
  const input = record(value, invalid); exactKeys(input, ['organizationId','requestReceivedAt','customerReference','note'], invalid);
  if (!isUuid(input.organizationId) || typeof input.requestReceivedAt !== 'string' || !ISO_INPUT.test(input.requestReceivedAt)
    || !isTimestamp(input.requestReceivedAt) || !text(input.customerReference, 200) || !note(input.note)) invalid();
  return input as unknown as SaasRefundRequestInput;
}
export function validateSaasRefundDecisionInput(value: unknown): SaasRefundDecisionInput {
  const input = record(value, invalid); exactKeys(input, ['decision','reasonCode','expectedVersion','note'], invalid);
  if (!version(input.expectedVersion) || !note(input.note)) invalid();
  if (input.decision === 'APPROVE') { if (input.reasonCode !== 'GUARANTEE_APPROVED') invalid(); }
  else if (input.decision === 'DENY') { if (!has(DENY_REASONS, input.reasonCode)) invalid(); }
  else if (input.decision === 'MARK_EVIDENCED') { if (input.reasonCode !== 'REFUND_EVIDENCE_RECORDED') invalid(); }
  else invalid();
  return input as unknown as SaasRefundDecisionInput;
}
export function validateSaasRefundStatusFilter(value: unknown): SaasRefundStatus | null {
  if (value === undefined) return null;
  if (!has(REFUND_STATUSES, value)) invalid();
  return value as SaasRefundStatus;
}
export function validateSaasAlertStatusFilter(value: unknown): 'OPEN' | 'RESOLVED' | null {
  if (value === undefined) return null;
  if (value !== 'OPEN' && value !== 'RESOLVED') invalid();
  return value;
}
/** asOf is optional; HQ previews eligibility for a request received at that instant (never in the future). */
export function validateSaasRefundEligibilityQuery(value: unknown): { receivedAt: string | null } {
  const q = record(value ?? {}, invalid); exactKeys(q, Object.keys(q).length === 0 ? [] : ['receivedAt'], invalid);
  if (q.receivedAt === undefined) return { receivedAt: null };
  if (typeof q.receivedAt !== 'string' || !ISO_INPUT.test(q.receivedAt) || !isTimestamp(q.receivedAt)) invalid();
  return { receivedAt: q.receivedAt };
}
export function validateSaasRewardFulfillmentInput(value: unknown): SaasRewardFulfillmentInput {
  const input = record(value, invalid); exactKeys(input, ['action','expectedVersion','authorizationReference'], invalid);
  if (!has(['ACTIVATE','DEACTIVATE'], input.action) || !version(input.expectedVersion) || !text(input.authorizationReference, 200)) invalid();
  return input as unknown as SaasRewardFulfillmentInput;
}
export function validateSaasRewardApplyInput(value: unknown): SaasRewardApplyInput {
  const input = record(value, invalid); exactKeys(input, ['expectedEntryVersion','firstPeriodIndex'], invalid);
  if (!version(input.expectedEntryVersion) || !(input.firstPeriodIndex === null || isInt(input.firstPeriodIndex, 0, 9999))) invalid();
  return input as unknown as SaasRewardApplyInput;
}
export function validateSaasAccountCreditApplyInput(value: unknown): SaasAccountCreditApplyInput {
  const input = record(value, invalid); exactKeys(input, ['expectedVersion'], invalid);
  if (!version(input.expectedVersion)) invalid();
  return { expectedVersion: input.expectedVersion as number };
}
export function validateSaasReferralAlertResolveInput(value: unknown): SaasReferralAlertResolveInput {
  const input = record(value, invalid); exactKeys(input, ['expectedVersion','resolution','reference'], invalid);
  if (!version(input.expectedVersion) || !has(['ATTRIBUTION_DECIDED','NO_QUALIFICATION_IMPACT'], input.resolution) || !text(input.reference, 300)) invalid();
  return input as unknown as SaasReferralAlertResolveInput;
}

// ---------- response validators (closed; any drift fails) ----------
function validateRefund(value: unknown): void {
  const r = record(value, drift);
  exactKeys(r, ['refundRequestId','organizationId','organizationName','subscriptionId','invoiceId','invoiceNumber','offerKind','firstPaidAt','windowEndsAt',
    'requestReceivedAt','customerReference','requestedAmountMinor','approvedAmountMinor','evidenceStrength','status','statusReason','version','note',
    'execution','executionStatus','subscriptionConsequence','refundEvidencedMinor','createdAt','decidedAt'], drift);
  if (!isUuid(r.refundRequestId) || !isUuid(r.organizationId) || typeof r.organizationName !== 'string' || !isUuid(r.subscriptionId) || !isUuid(r.invoiceId)
    || typeof r.invoiceNumber !== 'string' || !/^HON-20\d{2}-\d{6}$/.test(r.invoiceNumber) || !has(OFFERS, r.offerKind)
    || !isTimestamp(r.firstPaidAt) || !isTimestamp(r.windowEndsAt) || !isTimestamp(r.requestReceivedAt)
    // Legacy purchases: SAAS_REFUND_WINDOW_DAYS. HON OS purchases (0182): the accepted offer's window, whole days, 0 to 365.
    || !windowDays(Date.parse(r.windowEndsAt as string) - Date.parse(r.firstPaidAt as string))
    || Date.parse(r.requestReceivedAt as string) < Date.parse(r.firstPaidAt as string) || Date.parse(r.requestReceivedAt as string) >= Date.parse(r.windowEndsAt as string)
    || !text(r.customerReference, 200) || !isInt(r.requestedAmountMinor, 1, 200_000_000) || !nullable(r.approvedAmountMinor, (v): v is number => isInt(v, 1, 200_000_000))
    || !has(['HQ_ATTESTED','PROVIDER_VERIFIED'], r.evidenceStrength) || !has(REFUND_STATUSES, r.status) || !has(REFUND_REASONS, r.statusReason)
    || !isInt(r.version, 1, 2147483647) || !note(r.note) || r.execution !== 'UNAVAILABLE' || r.executionStatus !== 'NOT_EXECUTED'
    || r.subscriptionConsequence !== 'BLOCKED_PENDING_TERMS' || !minor(r.refundEvidencedMinor) || !isTimestamp(r.createdAt) || !nts(r.decidedAt)
    || (r.status === 'REQUESTED') !== (r.decidedAt === null)
    || has(['APPROVED','REFUND_EVIDENCED'], r.status) !== (r.approvedAmountMinor !== null)
    || (r.status === 'REFUND_EVIDENCED' && (r.refundEvidencedMinor as number) < (r.approvedAmountMinor as number))) drift();
}
function validateFulfillment(value: unknown): void {
  const f = record(value, drift); exactKeys(f, ['status','version','authorizationReference','changedAt','prizes','cashPayouts'], drift);
  if (!has(['INACTIVE','ACTIVE'], f.status) || !isInt(f.version, 1, 2147483647) || !nullable(f.authorizationReference, (v): v is string => text(v, 200))
    || (f.status === 'ACTIVE' && f.authorizationReference === null) || !isTimestamp(f.changedAt) || f.prizes !== 'NOT_ISSUED' || f.cashPayouts !== 'DISABLED') drift();
}
function validateApplication(value: unknown): void {
  const a = record(value, drift);
  exactKeys(a, ['applicationId','rewardEntryId','organizationId','subscriptionId','applicationKind','creditMinor','freeMonths','firstPeriodIndex',
    'lifetimeTier','status','appliedAt'], drift);
  if (!isUuid(a.applicationId) || !isUuid(a.rewardEntryId) || !isUuid(a.organizationId) || !isUuid(a.subscriptionId) || !has(APPLICATION_KINDS, a.applicationKind)
    || !isTimestamp(a.appliedAt)) drift();
  const ok = a.applicationKind === 'ACCOUNT_CREDIT'
    ? isInt(a.creditMinor, 1, 100_000) && a.freeMonths === null && a.firstPeriodIndex === null && a.lifetimeTier === null && a.status === 'APPLIED'
    : a.applicationKind === 'FREE_PERIODS'
      ? a.creditMinor === null && isInt(a.freeMonths, 1, 60) && count(a.firstPeriodIndex) && a.lifetimeTier === null && a.status === 'APPLIED'
      : a.creditMinor === null && a.freeMonths === null && a.firstPeriodIndex === null && has(TIERS, a.lifetimeTier) && a.status === 'CONVERSION_BLOCKED';
  if (!ok) drift();
}
function validateEntry(value: unknown): void {
  const e = record(value, drift);
  exactKeys(e, ['rewardEntryId','rewardKind','beneficiaryRole','beneficiaryOrganizationId','milestoneCount','creditMinor','freeMonths','lifetimeTier',
    'aiAllowance','entryStatus','entryVersion','fulfillmentForm','applicationKind','subscriptionId','state','blocker','application','fulfilledNotice'], drift);
  if (!isUuid(e.rewardEntryId) || !has(REWARD_KINDS, e.rewardKind) || !has(['REFERRER','REFERRED'], e.beneficiaryRole) || !isUuid(e.beneficiaryOrganizationId)
    || !nullable(e.milestoneCount, (v): v is number => isInt(v, 1, 500)) || !nullable(e.creditMinor, (v): v is number => isInt(v, 0, 100_000))
    || !nullable(e.freeMonths, (v): v is number => isInt(v, 0, 60)) || !nullable(e.lifetimeTier, (v): v is string => has(TIERS, v))
    || !(e.aiAllowance === null || e.aiAllowance === 'FULL_PLAN_ALLOWANCE') || !has(['ACCRUED','APPROVED','REVERSAL_REVIEW','VOIDED'], e.entryStatus)
    || !isInt(e.entryVersion, 1, 2147483647) || !nullable(e.fulfillmentForm, (v): v is string => has(['AS_EARNED','OWNER_SUBSTITUTE'], v))
    || !has([...APPLICATION_KINDS, 'PRIZE_MANUAL'], e.applicationKind) || !nullable(e.subscriptionId, isUuid) || !has(REWARD_STATES, e.state)
    || !nullable(e.blocker, (v): v is string => has(BLOCKERS, v)) || e.fulfilledNotice !== 'PREVIEW_IS_NOT_FULFILLMENT') drift();
  // An entry is READY only with no blocker, and an applied entry always carries its application.
  if ((e.state === 'READY') !== (e.blocker === null && e.application === null)) drift();
  if (has(['APPLIED','APPLIED_CONVERSION_BLOCKED'], e.state) !== (e.application !== null)) drift();
  if (e.rewardKind === 'LIFETIME_MEMBERSHIP' && e.aiAllowance !== 'FULL_PLAN_ALLOWANCE') drift();
  if (e.application !== null) {
    validateApplication(e.application);
    const a = e.application as SaasRewardApplication;
    if (a.rewardEntryId !== e.rewardEntryId || a.applicationKind !== e.applicationKind
      || (e.state === 'APPLIED') !== (a.status === 'APPLIED')) drift();
  }
}
function validateAlert(value: unknown): void {
  const a = record(value, drift);
  exactKeys(a, ['alertId','attributionId','attributionState','referredOrganizationId','referredOrganizationName','referrerSchoolId','source','paymentEvidenceId',
    'refundRequestId','evidenceKind','referredRecordedNetMinor','status','resolution','resolutionReference','version','raisedAt','resolvedAt',
    'affectedApplications','automaticReversal','debtCreated'], drift);
  if (!isUuid(a.alertId) || !isUuid(a.attributionId) || !has(['PENDING','QUALIFIED','REJECTED','REFUNDED','REVERSED'], a.attributionState)
    || !isUuid(a.referredOrganizationId) || typeof a.referredOrganizationName !== 'string' || !isUuid(a.referrerSchoolId)
    || !has(['PAYMENT_EVIDENCE','REFUND_REQUEST'], a.source) || !nullable(a.paymentEvidenceId, isUuid) || !nullable(a.refundRequestId, isUuid)
    || (a.source === 'PAYMENT_EVIDENCE') !== (a.paymentEvidenceId !== null) || (a.source === 'REFUND_REQUEST') !== (a.refundRequestId !== null)
    || !has(['REFUND','CHARGEBACK','REFUND_APPROVED'], a.evidenceKind) || !isInt(a.referredRecordedNetMinor, -999_999_999_999, 999_999_999_999)
    || !has(['OPEN','RESOLVED'], a.status) || !nullable(a.resolution, (v): v is string => has(['ATTRIBUTION_DECIDED','NO_QUALIFICATION_IMPACT'], v))
    || !nullable(a.resolutionReference, (v): v is string => text(v, 300)) || !isInt(a.version, 1, 2147483647) || !isTimestamp(a.raisedAt) || !nts(a.resolvedAt)
    || (a.status === 'RESOLVED') !== (a.resolvedAt !== null) || (a.resolvedAt === null) !== (a.resolution === null)
    || !Array.isArray(a.affectedApplications) || !(a.affectedApplications as unknown[]).every(isUuid)
    || a.automaticReversal !== 'NONE' || a.debtCreated !== false) drift();
}
export function validateSaasRefundEligibility(value: unknown): SaasRefundEligibility {
  const r = record(value, drift);
  exactKeys(r, ['organizationId','eligible','refusal','invoiceId','invoiceNumber','subscriptionId','offerKind','firstPaidAt','windowEndsAt',
    'requestReceivedAt','refundableMinor','evidenceStrength','execution'], drift);
  if (!isUuid(r.organizationId) || typeof r.eligible !== 'boolean' || !nullable(r.refusal, (v): v is string => has(REFUND_REFUSALS, v))
    || r.eligible !== (r.refusal === null) || !nullable(r.invoiceId, isUuid) || !nullable(r.invoiceNumber, (v): v is string => typeof v === 'string')
    || !nullable(r.subscriptionId, isUuid) || !nullable(r.offerKind, (v): v is string => has(OFFERS, v)) || !nts(r.firstPaidAt) || !nts(r.windowEndsAt)
    || !isTimestamp(r.requestReceivedAt) || !minor(r.refundableMinor)
    || !nullable(r.evidenceStrength, (v): v is string => has(['HQ_ATTESTED','PROVIDER_VERIFIED'], v)) || r.execution !== 'UNAVAILABLE'
    || (r.invoiceId === null) !== (r.refusal === 'SAAS_REFUND_NO_PAID_PURCHASE') || (r.invoiceId === null) !== (r.firstPaidAt === null)
    || (r.eligible && (r.refundableMinor as number) < 1)) drift();
  return r as unknown as SaasRefundEligibility;
}
export function validateSaasRefundRequestList(value: unknown): SaasRefundRequestList {
  const r = record(value, drift); exactKeys(r, ['refundRequests','limit','execution'], drift);
  if (!Array.isArray(r.refundRequests) || r.refundRequests.length > 200 || r.limit !== 200 || r.execution !== 'UNAVAILABLE') drift();
  (r.refundRequests as unknown[]).forEach(validateRefund);
  return r as unknown as SaasRefundRequestList;
}
export function validateSaasRefundReserve(value: unknown): SaasRefundReserve {
  const r = record(value, drift);
  exactKeys(r, ['asOf','windowExposure','approvedNotEvidenced','pendingRequests','recommendedReserveMinor','evidenceStrength','currency','execution'], drift);
  const w = record(r.windowExposure, drift); exactKeys(w, ['organizations','totalMinor','paidLifetimeMinor','monthlyMinor','earliestWindowEndsAt'], drift);
  const a = record(r.approvedNotEvidenced, drift); exactKeys(a, ['requests','totalMinor'], drift);
  const p = record(r.pendingRequests, drift); exactKeys(p, ['requests','totalMinor'], drift);
  if (!isTimestamp(r.asOf) || !count(w.organizations) || !minor(w.totalMinor) || !minor(w.paidLifetimeMinor) || !minor(w.monthlyMinor)
    || (w.paidLifetimeMinor as number) + (w.monthlyMinor as number) !== w.totalMinor || !nts(w.earliestWindowEndsAt)
    || (w.organizations === 0) !== (w.earliestWindowEndsAt === null) || !count(a.requests) || !minor(a.totalMinor) || !count(p.requests) || !minor(p.totalMinor)
    || r.recommendedReserveMinor !== (w.totalMinor as number) + (a.totalMinor as number) + (p.totalMinor as number)
    || r.evidenceStrength !== 'RECORDED' || r.currency !== 'USD' || r.execution !== 'UNAVAILABLE') drift();
  return r as unknown as SaasRefundReserve;
}
export function validateSaasRewardPreview(value: unknown): SaasRewardPreview {
  const r = record(value, drift); exactKeys(r, ['organizationId','fulfillment','rewards','accountCredit','freePeriods','alerts','currency'], drift);
  if (!isUuid(r.organizationId) || !Array.isArray(r.rewards) || !Array.isArray(r.freePeriods) || !Array.isArray(r.alerts) || r.currency !== 'USD') drift();
  validateFulfillment(r.fulfillment);
  (r.rewards as unknown[]).forEach(e => { validateEntry(e); if ((e as SaasRewardPreviewEntry).beneficiaryOrganizationId !== r.organizationId) drift(); });
  const c = record(r.accountCredit, drift); exactKeys(c, ['grantedMinor','appliedMinor','availableMinor','blockedMinor'], drift);
  if (!minor(c.grantedMinor) || !minor(c.appliedMinor) || !minor(c.availableMinor) || !minor(c.blockedMinor)
    || (c.appliedMinor as number) + (c.availableMinor as number) + (c.blockedMinor as number) !== c.grantedMinor) drift();
  (r.freePeriods as unknown[]).forEach(f => {
    const x = record(f, drift); exactKeys(x, ['subscriptionId','periodIndex','applicationId'], drift);
    if (!isUuid(x.subscriptionId) || !count(x.periodIndex) || !isUuid(x.applicationId)) drift();
  });
  (r.alerts as unknown[]).forEach(validateAlert);
  return r as unknown as SaasRewardPreview;
}
export function validateSaasReferralAlertList(value: unknown): SaasReferralAlertList {
  const r = record(value, drift); exactKeys(r, ['alerts','limit'], drift);
  if (!Array.isArray(r.alerts) || r.alerts.length > 200 || r.limit !== 200) drift();
  (r.alerts as unknown[]).forEach(validateAlert);
  return r as unknown as SaasReferralAlertList;
}
export function validateSaasCreditApplicationPreview(value: unknown): SaasCreditApplicationPreview {
  const r = record(value, drift);
  exactKeys(r, ['invoiceId','invoiceStatus','taxStatus','subtotalMinor','availableCreditMinor','wouldApplyMinor','resultingSubtotalMinor','applicable',
    'zeroTotalIssuable','fulfillment','previewOnly'], drift);
  if (!isUuid(r.invoiceId) || !has(['DRAFT','ISSUED','VOID'], r.invoiceStatus) || !has(['UNRESOLVED','NO_TAX_APPLICABLE','TAX_LINES'], r.taxStatus)
    || !minor(r.subtotalMinor) || !minor(r.availableCreditMinor) || !minor(r.wouldApplyMinor)
    || (r.wouldApplyMinor as number) > Math.min(r.subtotalMinor as number, r.availableCreditMinor as number)
    || r.resultingSubtotalMinor !== (r.subtotalMinor as number) - (r.wouldApplyMinor as number) || typeof r.applicable !== 'boolean'
    || r.applicable !== ((r.wouldApplyMinor as number) > 0) || r.zeroTotalIssuable !== false || !has(['INACTIVE','ACTIVE'], r.fulfillment)
    || r.previewOnly !== true) drift();
  return r as unknown as SaasCreditApplicationPreview;
}
export function validateSaasRefundRequestReceipt(value: unknown): SaasRefundRequestReceipt {
  const r = record(value, drift); exactKeys(r, ['refundRequest','replayed'], drift); validateRefund(r.refundRequest);
  if ((r.refundRequest as SaasRefundRequest).status !== 'REQUESTED' || typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasRefundRequestReceipt;
}
export function validateSaasRefundDecisionReceipt(value: unknown): SaasRefundDecisionReceipt {
  const r = record(value, drift); exactKeys(r, ['refundRequest','decision','replayed'], drift); validateRefund(r.refundRequest);
  const expected = { APPROVE: 'APPROVED', DENY: 'DENIED', MARK_EVIDENCED: 'REFUND_EVIDENCED' } as Record<string, string>;
  if (!has(['APPROVE','DENY','MARK_EVIDENCED'], r.decision) || (r.refundRequest as SaasRefundRequest).status !== expected[r.decision as string]
    || typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasRefundDecisionReceipt;
}
export function validateSaasRewardFulfillmentReceipt(value: unknown): SaasRewardFulfillmentReceipt {
  const r = record(value, drift); exactKeys(r, ['fulfillment','replayed'], drift); validateFulfillment(r.fulfillment);
  if (typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasRewardFulfillmentReceipt;
}
export function validateSaasRewardApplyReceipt(value: unknown): SaasRewardApplyReceipt {
  const r = record(value, drift); exactKeys(r, ['application','reward','replayed'], drift);
  validateApplication(r.application); validateEntry(r.reward);
  const reward = r.reward as SaasRewardPreviewEntry;
  if (reward.application === null || reward.application.applicationId !== (r.application as SaasRewardApplication).applicationId
    || typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasRewardApplyReceipt;
}
export function validateSaasAccountCreditApplyReceipt(value: unknown): SaasAccountCreditApplyReceipt {
  const r = record(value, drift); exactKeys(r, ['invoice','appliedCreditMinor','replayed'], drift);
  const invoice = validateSaasInvoiceDetail(r.invoice);
  if (invoice.status !== 'DRAFT' || !isInt(r.appliedCreditMinor, 1, 100_000_000) || typeof r.replayed !== 'boolean'
    || !invoice.lines.some(l => l.lineKind === 'ACCOUNT_CREDIT' && l.amountMinor === -(r.appliedCreditMinor as number))) drift();
  return r as unknown as SaasAccountCreditApplyReceipt;
}
export function validateSaasReferralAlertReceipt(value: unknown): SaasReferralAlertReceipt {
  const r = record(value, drift); exactKeys(r, ['alert','replayed'], drift); validateAlert(r.alert);
  if ((r.alert as SaasReferralAlert).status !== 'RESOLVED' || typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasReferralAlertReceipt;
}
