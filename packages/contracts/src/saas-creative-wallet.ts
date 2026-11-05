// CW1 HON OS creative credit wallet (migration 0202) closed contracts. Creative credits pay for image and
// video generation only; AI team conversations never deduct (agentConversationsDeductCredits is always
// false) and the wallet is separate from the internal AI-agent budget. Top-up purchases are recorded intents:
// no card is charged and payment collection is NOT_CONNECTED. School views never carry provider cost,
// provider identity or HQ notes; only HQ views do. Owner decision 2026-11-03: every wallet belongs to exactly one
// eligible paying school (never an organization pool); schools of one organization never share or see each other's
// credits, and HQ views and lists are per school. Creative provider expense is classified CREATIVE_MEDIA and an
// unknown provider cost stays UNKNOWN (never a guessed zero) until recorded once.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsNullable as nullable, championsRecord as record } from './champions-club.js';
import { saasUuid } from './saas-billing.js';

export type SaasCreativeLotKind = 'INCLUDED_MONTHLY' | 'PROMOTIONAL' | 'ADJUSTMENT' | 'PURCHASED_TOPUP';
export type SaasCreativeMediaKind = 'IMAGE' | 'VIDEO';
export type SaasCreativeBillingUnit = 'IMAGE' | 'VIDEO_SECOND' | 'REQUEST';
export type SaasCreativeRateBasis = 'PROVISIONAL' | 'VERIFIED_COST';
export type SaasCreativePackageCode = 'STARTER' | 'GROWTH' | 'CREATOR';
export type SaasCreativeEligibilityReason = 'PROGRAM_INACTIVE' | 'SCHOOL_NOT_ACTIVE' | 'PAID_ACCESS_REQUIRED' | 'ENTITLEMENT_NOT_IN_EFFECT'
  | 'HON_OS_SUBSCRIPTION_REQUIRED' | 'SUBSCRIPTION_NOT_IN_SERVICE' | 'VERIFIED_PAYMENT_REQUIRED' | 'WINDOW_UNAVAILABLE' | 'WINDOW_NOT_PAID';
const LOT_KINDS: readonly SaasCreativeLotKind[] = ['INCLUDED_MONTHLY','PROMOTIONAL','ADJUSTMENT','PURCHASED_TOPUP'];
const MEDIA: readonly SaasCreativeMediaKind[] = ['IMAGE','VIDEO'];
const UNITS: readonly SaasCreativeBillingUnit[] = ['IMAGE','VIDEO_SECOND','REQUEST'];
const BASES: readonly SaasCreativeRateBasis[] = ['PROVISIONAL','VERIFIED_COST'];
const PACKAGES: readonly SaasCreativePackageCode[] = ['STARTER','GROWTH','CREATOR'];
const REASONS: readonly SaasCreativeEligibilityReason[] = ['PROGRAM_INACTIVE','SCHOOL_NOT_ACTIVE','PAID_ACCESS_REQUIRED','ENTITLEMENT_NOT_IN_EFFECT',
  'HON_OS_SUBSCRIPTION_REQUIRED','SUBSCRIPTION_NOT_IN_SERVICE','VERIFIED_PAYMENT_REQUIRED','WINDOW_UNAVAILABLE','WINDOW_NOT_PAID'];
const RES_STATES = ['RESERVED','FINALIZED','RELEASED','OUTCOME_UNKNOWN'] as const;
const COST_STATES = ['PENDING','RECORDED','UNKNOWN'] as const;
export type SaasCreativeCostStatus = typeof COST_STATES[number];
const RES_REASONS = ['RESERVED','PROVIDER_SUCCEEDED','PROVIDER_FAILED','PROVIDER_OUTCOME_UNKNOWN','HQ_RESOLVED_SUCCEEDED','HQ_RESOLVED_NOT_CHARGED'] as const;
const GRANT_REASONS = ['PROMOTION','GOODWILL','SERVICE_RECOVERY','BILLING_CORRECTION','OTHER'] as const;
const DEBIT_REASONS = ['BILLING_CORRECTION','RECORDED_IN_ERROR','OTHER'] as const;
const ADJ_REASONS = ['PROMOTION','GOODWILL','SERVICE_RECOVERY','BILLING_CORRECTION','RECORDED_IN_ERROR','OTHER'] as const;
const ENTRY_KINDS = ['GRANT','RESERVE','FINALIZE','RELEASE','EXPIRE','DEBIT'] as const;
const PURCHASE_STATES = ['PENDING_PAYMENT','FULFILLED','NEEDS_REVIEW'] as const;
const PURCHASE_REASONS = ['AWAITING_VERIFIED_PAYMENT','PAYMENT_VERIFIED','AMOUNT_MISMATCH','CURRENCY_MISMATCH','DUPLICATE_PAYMENT'] as const;
const OPERATION = /^[a-z][a-z0-9_.]{2,59}$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const has = (list: readonly unknown[], value: unknown) => list.includes(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max && value.trim() === value;
const count = (v: unknown): v is number => isInt(v, 0, Number.MAX_SAFE_INTEGER);
const nts = (v: unknown) => v === null || isTimestamp(v);
const version = (v: unknown) => isInt(v, 1, 999_999_999);

/** Owner-approved monthly included creative credits for every paid HON OS school (program row is authoritative). */
export const SAAS_CREATIVE_MONTHLY_INCLUDED_CREDITS = 12000;
/** Owner-approved top-up packages (2026-10-31). The database package rows are authoritative. */
export const SAAS_CREATIVE_TOPUP_PACKAGES = {
  STARTER: { priceMinor: 3000, baseCredits: 3000, bonusCredits: 0 },
  GROWTH: { priceMinor: 6000, baseCredits: 6000, bonusCredits: 1200 },
  CREATOR: { priceMinor: 12000, baseCredits: 12000, bonusCredits: 4800 },
} as const;

// ---------- inputs ----------
export interface SaasCreativeProgramInput { action: 'ACTIVATE' | 'DEACTIVATE'; expectedVersion: number; authorizationReference: string }
export interface SaasCreativeRateDraft {
  operationCode: string; mediaKind: SaasCreativeMediaKind; displayName: string; billingUnit: SaasCreativeBillingUnit;
  creditsPerUnit: number; maxUnitsPerRequest: number; costEvidenceId: string | null;
}
export interface SaasCreativeRatesInput { termsReference: string; rates: SaasCreativeRateDraft[] }
export interface SaasCreativeGrantInput { kind: 'PROMOTIONAL' | 'ADJUSTMENT'; credits: number; reasonCode: typeof GRANT_REASONS[number]; note: string }
export interface SaasCreativeDebitInput { credits: number; reasonCode: typeof DEBIT_REASONS[number]; note: string }
export type SaasCreativeResolveInput =
  | { resolution: 'SUCCEEDED'; expectedVersion: number; finalUnits: number; providerCostMicrounits: number; evidenceReference: string }
  /** providerCostMicrounits null keeps the cost UNKNOWN for later reconciliation; it is never recorded as zero. */
  | { resolution: 'NOT_CHARGED'; expectedVersion: number; finalUnits: null; providerCostMicrounits: number | null; evidenceReference: string };
/** HQ owner records, once, the provider cost of a released generation whose cost is UNKNOWN. */
export interface SaasCreativeCostInput { expectedVersion: number; providerCostMicrounits: number; evidenceReference: string }
export interface SaasCreativeReserveInput { operationCode: string; units: number; providerId: string; modelCode: string }
export type SaasCreativeSettleInput =
  | { outcome: 'SUCCEEDED'; expectedVersion: number; finalUnits: number; providerCostMicrounits: number }
  | { outcome: 'FAILED'; expectedVersion: number; finalUnits: null; providerCostMicrounits: number | null }
  | { outcome: 'UNKNOWN'; expectedVersion: number; finalUnits: null; providerCostMicrounits: null };
export interface SaasCreativePurchaseInput { packageCode: SaasCreativePackageCode }

// ---------- responses ----------
export interface SaasCreativeLot {
  lotId: string; kind: SaasCreativeLotKind; credits: number; baseCredits: number | null; bonusCredits: number | null;
  window: { index: number; startsAt: string; endsAt: string } | null; purchaseId: string | null; adjustmentId: string | null;
  expiresAt: string | null; expired: boolean; availableCredits: number; heldCredits: number; consumedCredits: number;
  expiredCredits: number; debitedCredits: number; grantedAt: string;
}
export interface SaasCreativeKindBalance {
  kind: SaasCreativeLotKind; grantedCredits: number; availableCredits: number; heldCredits: number; consumedCredits: number;
  expiredCredits: number; debitedCredits: number;
}
export interface SaasCreativeBalance { availableCredits: number; heldCredits: number; byKind: SaasCreativeKindBalance[] }
export interface SaasCreativeReservation {
  reservationId: string; schoolId: string; operationCode: string; mediaKind: SaasCreativeMediaKind; rateBasis: SaasCreativeRateBasis;
  creditsPerUnit: number; units: number; reservedCredits: number; status: typeof RES_STATES[number]; statusReason: typeof RES_REASONS[number];
  version: number; finalUnits: number | null; finalCredits: number | null; lots: { lotId: string; reservedCredits: number }[];
  reservedAt: string; settledAt: string | null;
}
export interface SaasCreativeReservationInternal extends SaasCreativeReservation {
  organizationId: string; providerId: string; modelCode: string; costStatus: SaasCreativeCostStatus; providerCostMicrounits: number | null;
  costReference: string | null; costRecordedAt: string | null; usageId: string | null; resolutionReference: string | null;
}
export interface SaasCreativeRate {
  operationCode: string; mediaKind: SaasCreativeMediaKind; displayName: string; billingUnit: SaasCreativeBillingUnit;
  creditsPerUnit: number; maxUnitsPerRequest: number; rateBasis: SaasCreativeRateBasis;
}
export interface SaasCreativeRates<T = SaasCreativeRate> {
  rateVersionId: string; rateVersion: number; termsReference: string; publishedAt: string; rates: T[];
}
export interface SaasCreativePackage {
  packageCode: SaasCreativePackageCode; packageVersion: number; baseCredits: number; bonusCredits: number; totalCredits: number; priceMinor: number; currency: 'usd';
}
export interface SaasCreativePurchase {
  purchaseId: string; schoolId: string; packageCode: SaasCreativePackageCode; packageVersion: number; baseCredits: number; bonusCredits: number;
  priceMinor: number; currency: 'usd'; status: typeof PURCHASE_STATES[number]; statusReason: typeof PURCHASE_REASONS[number]; version: number;
  lotId: string | null; payment: 'NOT_CONNECTED'; createdAt: string; fulfilledAt: string | null;
}
export interface SaasCreativeEligibility {
  eligible: boolean; reason: SaasCreativeEligibilityReason | null; window: { index: number; startsAt: string; endsAt: string } | null;
}
export interface SaasCreativeHistoryEntry {
  entryId: string; lotId: string; lotKind: SaasCreativeLotKind; entryKind: typeof ENTRY_KINDS[number]; credits: number;
  reservationId: string | null; adjustmentId: string | null; occurredAt: string;
}
export interface SaasCreativeAdjustment {
  adjustmentId: string; kind: 'PROMOTIONAL_GRANT' | 'ADJUSTMENT_GRANT' | 'CORRECTION_DEBIT'; credits: number; lotId: string;
  reasonCode: typeof ADJ_REASONS[number]; occurredAt: string;
}
interface WalletBase {
  walletVersion: number | null; program: { status: 'INACTIVE' | 'ACTIVE'; monthlyIncludedCredits: 12000 }; eligibility: SaasCreativeEligibility;
  balance: SaasCreativeBalance; lots: SaasCreativeLot[]; history: SaasCreativeHistoryEntry[]; packages: SaasCreativePackage[];
  agentConversationsDeductCredits: false; paymentsActive: false;
}
export interface SaasCreativeSchoolWallet extends WalletBase {
  schoolId: string; reservations: SaasCreativeReservation[]; adjustments: SaasCreativeAdjustment[]; purchases: SaasCreativePurchase[];
  rates: SaasCreativeRates | null;
}
export interface SaasCreativeProviderExpense {
  actualProviderCostMicrounits: number; finalizedProviderCostMicrounits: number; failedOrNotChargedProviderCostMicrounits: number; consumedCredits: number;
  unknownCostGenerations: number; pendingCostGenerations: number; spendClass: 'CREATIVE_MEDIA';
  generations: { finalized: number; released: number; reserved: number; outcomeUnknown: number };
}
export interface SaasCreativeHqWallet extends WalletBase {
  schoolId: string; organizationId: string; reservations: SaasCreativeReservationInternal[];
  adjustments: (SaasCreativeAdjustment & { note: string; actorPrincipalId: string })[];
  purchases: (SaasCreativePurchase & { paymentProvider: string | null; providerPaymentRef: string | null; paidAmountMinor: number | null; paidCurrency: string | null })[];
  rates: SaasCreativeRates<SaasCreativeRate & { costEvidenceId: string | null }> | null; providerExpense: SaasCreativeProviderExpense;
}
export interface SaasCreativeHqWalletRow {
  schoolId: string; schoolName: string; organizationId: string; organizationName: string; availableCredits: number; heldCredits: number; consumedCredits: number;
  actualProviderCostMicrounits: number; outcomeUnknown: number; unknownCostGenerations: number; updatedAt: string;
}
export interface SaasCreativeHqWalletList {
  program: { status: 'INACTIVE' | 'ACTIVE'; version: number; monthlyIncludedCredits: 12000 };
  rates: SaasCreativeRates<SaasCreativeRate & { costEvidenceId: string | null }> | null; packages: SaasCreativePackage[]; wallets: SaasCreativeHqWalletRow[];
}
export interface SaasCreativeProgramReceipt {
  program: { status: 'INACTIVE' | 'ACTIVE'; version: number; monthlyIncludedCredits: 12000; authorizationReference: string; changedAt: string }; replayed: boolean;
}
export interface SaasCreativeRatesReceipt {
  rates: SaasCreativeRates<SaasCreativeRate & { costEvidenceId: string | null }>; retiredRateVersionId: string | null; replayed: boolean;
}
export interface SaasCreativeAdjustmentReceipt {
  adjustment: { adjustmentId: string; schoolId: string; lot: SaasCreativeLot; credits?: number; reasonCode: string; note: string }; balance: SaasCreativeBalance; replayed: boolean;
}
export interface SaasCreativeResolveReceipt { reservation: SaasCreativeReservationInternal; replayed: boolean }
export interface SaasCreativeCostReceipt { reservation: SaasCreativeReservationInternal; outcome: 'APPLIED'; replayed: boolean }
export interface SaasCreativeWindowReceipt { lot: SaasCreativeLot; balance: SaasCreativeBalance; replayed: boolean }
export interface SaasCreativeReservationReceipt { reservation: SaasCreativeReservation; balance: SaasCreativeBalance; replayed: boolean }
export interface SaasCreativePurchaseReceipt { purchase: SaasCreativePurchase; replayed: boolean }

// ---------- input validators (closed; anything else is refused) ----------
export function validateSaasCreativeProgramInput(value: unknown): SaasCreativeProgramInput {
  const input = record(value, invalid); exactKeys(input, ['action','expectedVersion','authorizationReference'], invalid);
  if (!has(['ACTIVATE','DEACTIVATE'], input.action) || !version(input.expectedVersion) || !text(input.authorizationReference, 200)) invalid();
  return input as unknown as SaasCreativeProgramInput;
}
export function validateSaasCreativeRatesInput(value: unknown): SaasCreativeRatesInput {
  const input = record(value, invalid); exactKeys(input, ['termsReference','rates'], invalid);
  if (!text(input.termsReference, 500) || !Array.isArray(input.rates) || input.rates.length < 1 || input.rates.length > 40) invalid();
  const rates = (input.rates as unknown[]).map(item => {
    const r = record(item, invalid);
    exactKeys(r, ['operationCode','mediaKind','displayName','billingUnit','creditsPerUnit','maxUnitsPerRequest','costEvidenceId'], invalid);
    if (typeof r.operationCode !== 'string' || !OPERATION.test(r.operationCode) || !has(MEDIA, r.mediaKind) || !text(r.displayName, 120)
      || !has(UNITS, r.billingUnit) || (r.mediaKind === 'IMAGE' && r.billingUnit === 'VIDEO_SECOND')
      || !isInt(r.creditsPerUnit, 1, 1_000_000) || !isInt(r.maxUnitsPerRequest, 1, 1000)) invalid();
    return { ...r, costEvidenceId: r.costEvidenceId === null ? null : saasUuid(r.costEvidenceId) } as unknown as SaasCreativeRateDraft;
  });
  if (new Set(rates.map(r => r.operationCode)).size !== rates.length) invalid();
  return { termsReference: input.termsReference as string, rates };
}
export function validateSaasCreativeGrantInput(value: unknown): SaasCreativeGrantInput {
  const input = record(value, invalid); exactKeys(input, ['kind','credits','reasonCode','note'], invalid);
  if (!has(['PROMOTIONAL','ADJUSTMENT'], input.kind) || !isInt(input.credits, 1, 1_000_000_000) || !has(GRANT_REASONS, input.reasonCode) || !text(input.note, 500)) invalid();
  return input as unknown as SaasCreativeGrantInput;
}
export function validateSaasCreativeDebitInput(value: unknown): SaasCreativeDebitInput {
  const input = record(value, invalid); exactKeys(input, ['credits','reasonCode','note'], invalid);
  if (!isInt(input.credits, 1, 1_000_000_000) || !has(DEBIT_REASONS, input.reasonCode) || !text(input.note, 500)) invalid();
  return input as unknown as SaasCreativeDebitInput;
}
export function validateSaasCreativeResolveInput(value: unknown): SaasCreativeResolveInput {
  const input = record(value, invalid); exactKeys(input, ['resolution','expectedVersion','finalUnits','providerCostMicrounits','evidenceReference'], invalid);
  const cost = (v: unknown) => isInt(v, 0, 999_999_999_999_999);
  if (!version(input.expectedVersion) || !text(input.evidenceReference, 200)) invalid();
  if (input.resolution === 'SUCCEEDED') { if (!isInt(input.finalUnits, 0, 1000) || !cost(input.providerCostMicrounits)) invalid(); }
  else if (input.resolution === 'NOT_CHARGED') { if (input.finalUnits !== null || !(input.providerCostMicrounits === null || cost(input.providerCostMicrounits))) invalid(); }
  else invalid();
  return input as unknown as SaasCreativeResolveInput;
}
export function validateSaasCreativeCostInput(value: unknown): SaasCreativeCostInput {
  const input = record(value, invalid); exactKeys(input, ['expectedVersion','providerCostMicrounits','evidenceReference'], invalid);
  if (!version(input.expectedVersion) || !isInt(input.providerCostMicrounits, 0, 999_999_999_999_999) || !text(input.evidenceReference, 200)) invalid();
  return input as unknown as SaasCreativeCostInput;
}
export function validateSaasCreativeReserveInput(value: unknown): SaasCreativeReserveInput {
  const input = record(value, invalid); exactKeys(input, ['operationCode','units','providerId','modelCode'], invalid);
  if (typeof input.operationCode !== 'string' || !OPERATION.test(input.operationCode) || !isInt(input.units, 1, 1000)
    || typeof input.providerId !== 'string' || !PROVIDER_ID.test(input.providerId) || typeof input.modelCode !== 'string' || !MODEL.test(input.modelCode)) invalid();
  return input as unknown as SaasCreativeReserveInput;
}
export function validateSaasCreativeSettleInput(value: unknown): SaasCreativeSettleInput {
  const input = record(value, invalid); exactKeys(input, ['outcome','expectedVersion','finalUnits','providerCostMicrounits'], invalid);
  const cost = (v: unknown) => isInt(v, 0, 999_999_999_999_999);
  if (!version(input.expectedVersion)) invalid();
  if (input.outcome === 'SUCCEEDED') { if (!isInt(input.finalUnits, 0, 1000) || !cost(input.providerCostMicrounits)) invalid(); }
  else if (input.outcome === 'FAILED') { if (input.finalUnits !== null || !(input.providerCostMicrounits === null || cost(input.providerCostMicrounits))) invalid(); }
  else if (input.outcome === 'UNKNOWN') { if (input.finalUnits !== null || input.providerCostMicrounits !== null) invalid(); }
  else invalid();
  return input as unknown as SaasCreativeSettleInput;
}
export function validateSaasCreativePurchaseInput(value: unknown): SaasCreativePurchaseInput {
  const input = record(value, invalid); exactKeys(input, ['packageCode'], invalid);
  if (!has(PACKAGES, input.packageCode)) invalid();
  return input as unknown as SaasCreativePurchaseInput;
}

// ---------- response validators (closed; any drift fails) ----------
function validateWindow(value: unknown): void {
  const w = record(value, drift); exactKeys(w, ['index','startsAt','endsAt'], drift);
  if (!count(w.index) || !isTimestamp(w.startsAt) || !isTimestamp(w.endsAt) || Date.parse(w.endsAt as string) <= Date.parse(w.startsAt as string)) drift();
}
function validateLot(value: unknown): void {
  const l = record(value, drift);
  exactKeys(l, ['lotId','kind','credits','baseCredits','bonusCredits','window','purchaseId','adjustmentId','expiresAt','expired','availableCredits',
    'heldCredits','consumedCredits','expiredCredits','debitedCredits','grantedAt'], drift);
  if (!isUuid(l.lotId) || !has(LOT_KINDS, l.kind) || !isInt(l.credits, 1, 1_000_000_000) || !nullable(l.baseCredits, count) || !nullable(l.bonusCredits, count)
    || !nullable(l.purchaseId, isUuid) || !nullable(l.adjustmentId, isUuid) || !nts(l.expiresAt) || typeof l.expired !== 'boolean'
    || !count(l.availableCredits) || !count(l.heldCredits) || !count(l.consumedCredits) || !count(l.expiredCredits) || !count(l.debitedCredits)
    || !isTimestamp(l.grantedAt) || (l.expired === true && l.availableCredits !== 0)
    || (l.availableCredits as number) + (l.heldCredits as number) + (l.consumedCredits as number) + (l.expiredCredits as number) + (l.debitedCredits as number) > (l.credits as number)
    || (l.kind === 'INCLUDED_MONTHLY') !== (l.window !== null) || (l.kind === 'PURCHASED_TOPUP') !== (l.purchaseId !== null)
    || (l.kind === 'PROMOTIONAL' || l.kind === 'ADJUSTMENT') !== (l.adjustmentId !== null)
    || (l.kind === 'PURCHASED_TOPUP' && l.credits !== (l.baseCredits as number) + (l.bonusCredits as number))) drift();
  if (l.window !== null) validateWindow(l.window);
}
function validateBalance(value: unknown): void {
  const b = record(value, drift); exactKeys(b, ['availableCredits','heldCredits','byKind'], drift);
  if (!count(b.availableCredits) || !count(b.heldCredits) || !Array.isArray(b.byKind) || b.byKind.length !== 4) drift();
  let available = 0, held = 0;
  (b.byKind as unknown[]).forEach((value, i) => {
    const k = record(value, drift);
    exactKeys(k, ['kind','grantedCredits','availableCredits','heldCredits','consumedCredits','expiredCredits','debitedCredits'], drift);
    if (k.kind !== ['INCLUDED_MONTHLY','ADJUSTMENT','PROMOTIONAL','PURCHASED_TOPUP'][i] || !count(k.grantedCredits) || !count(k.availableCredits) || !count(k.heldCredits)
      || !count(k.consumedCredits) || !count(k.expiredCredits) || !count(k.debitedCredits)) drift();
    available += k.availableCredits as number; held += k.heldCredits as number;
  });
  if (available !== b.availableCredits || held !== b.heldCredits) drift();
}
function validateReservation(value: unknown, internal: boolean): void {
  const r = record(value, drift);
  const keys = ['reservationId','schoolId','operationCode','mediaKind','rateBasis','creditsPerUnit','units','reservedCredits','status','statusReason',
    'version','finalUnits','finalCredits','lots','reservedAt','settledAt'];
  exactKeys(r, internal ? [...keys, 'organizationId','providerId','modelCode','costStatus','providerCostMicrounits','costReference','costRecordedAt','usageId',
    'resolutionReference'] : keys, drift);
  if (!isUuid(r.reservationId) || !isUuid(r.schoolId) || typeof r.operationCode !== 'string' || !OPERATION.test(r.operationCode) || !has(MEDIA, r.mediaKind)
    || !has(BASES, r.rateBasis) || !isInt(r.creditsPerUnit, 1, 1_000_000) || !isInt(r.units, 1, 1000)
    || r.reservedCredits !== (r.creditsPerUnit as number) * (r.units as number) || !has(RES_STATES, r.status) || !has(RES_REASONS, r.statusReason)
    || !isInt(r.version, 1, 2147483647) || !isTimestamp(r.reservedAt) || !nts(r.settledAt) || !Array.isArray(r.lots) || r.lots.length < 1) drift();
  let reserved = 0;
  (r.lots as unknown[]).forEach(value => {
    const x = record(value, drift); exactKeys(x, ['lotId','reservedCredits'], drift);
    if (!isUuid(x.lotId) || !isInt(x.reservedCredits, 1, 1_000_000_000)) drift();
    reserved += x.reservedCredits as number;
  });
  if (reserved !== r.reservedCredits) drift();
  const finalized = r.status === 'FINALIZED';
  if (finalized ? !count(r.finalUnits) || r.finalCredits !== (r.finalUnits as number) * (r.creditsPerUnit as number) || (r.finalCredits as number) > (r.reservedCredits as number)
    : r.finalCredits !== null || r.finalUnits !== null) drift();
  if ((r.status === 'RESERVED' || r.status === 'OUTCOME_UNKNOWN') !== (r.settledAt === null)) drift();
  if (internal && (!isUuid(r.organizationId) || typeof r.providerId !== 'string' || typeof r.modelCode !== 'string' || !has(COST_STATES, r.costStatus)
    || !nullable(r.providerCostMicrounits, count) || !nullable(r.usageId, isUuid) || !nullable(r.costReference, (v): v is string => text(v, 200)) || !nts(r.costRecordedAt)
    || (r.costStatus === 'RECORDED') !== (r.providerCostMicrounits !== null) || (r.costStatus === 'RECORDED') !== (r.costRecordedAt !== null)
    || (r.usageId !== null && r.costStatus !== 'RECORDED')
    || ((r.status === 'RESERVED' || r.status === 'OUTCOME_UNKNOWN') !== (r.costStatus === 'PENDING'))
    || (finalized && (r.usageId === null || r.costStatus !== 'RECORDED')) || !nullable(r.resolutionReference, (v): v is string => text(v, 200)))) drift();
}
function validateRates(value: unknown, internal: boolean): void {
  if (value === null) return;
  const v = record(value, drift); exactKeys(v, ['rateVersionId','rateVersion','termsReference','publishedAt','rates'], drift);
  if (!isUuid(v.rateVersionId) || !isInt(v.rateVersion, 1, 2147483647) || !text(v.termsReference, 500) || !isTimestamp(v.publishedAt)
    || !Array.isArray(v.rates) || v.rates.length < 1) drift();
  (v.rates as unknown[]).forEach(value => {
    const r = record(value, drift);
    const keys = ['operationCode','mediaKind','displayName','billingUnit','creditsPerUnit','maxUnitsPerRequest','rateBasis'];
    exactKeys(r, internal ? [...keys, 'costEvidenceId'] : keys, drift);
    if (typeof r.operationCode !== 'string' || !OPERATION.test(r.operationCode) || !has(MEDIA, r.mediaKind) || !text(r.displayName, 120)
      || !has(UNITS, r.billingUnit) || !isInt(r.creditsPerUnit, 1, 1_000_000) || !isInt(r.maxUnitsPerRequest, 1, 1000) || !has(BASES, r.rateBasis)
      || (internal && (!nullable(r.costEvidenceId, isUuid) || (r.rateBasis === 'VERIFIED_COST') !== (r.costEvidenceId !== null)))) drift();
  });
}
function validatePackages(value: unknown): void {
  if (!Array.isArray(value) || value.length !== 3) drift();
  (value as unknown[]).forEach(value => {
    const p = record(value, drift); exactKeys(p, ['packageCode','packageVersion','baseCredits','bonusCredits','totalCredits','priceMinor','currency'], drift);
    if (!has(PACKAGES, p.packageCode) || !isInt(p.packageVersion, 1, 2147483647) || !isInt(p.baseCredits, 1, 1_000_000_000) || !count(p.bonusCredits)
      || p.totalCredits !== (p.baseCredits as number) + (p.bonusCredits as number) || !isInt(p.priceMinor, 1, 1_000_000_000) || p.currency !== 'usd') drift();
  });
}
function validatePurchase(value: unknown, internal: boolean): void {
  const p = record(value, drift);
  const keys = ['purchaseId','schoolId','packageCode','packageVersion','baseCredits','bonusCredits','priceMinor','currency','status','statusReason','version',
    'lotId','payment','createdAt','fulfilledAt'];
  exactKeys(p, internal ? [...keys, 'paymentProvider','providerPaymentRef','paidAmountMinor','paidCurrency'] : keys, drift);
  if (!isUuid(p.purchaseId) || !isUuid(p.schoolId) || !has(PACKAGES, p.packageCode) || !isInt(p.packageVersion, 1, 2147483647)
    || !isInt(p.baseCredits, 1, 1_000_000_000) || !count(p.bonusCredits) || !isInt(p.priceMinor, 1, 1_000_000_000) || p.currency !== 'usd'
    || !has(PURCHASE_STATES, p.status) || !has(PURCHASE_REASONS, p.statusReason) || !isInt(p.version, 1, 2147483647) || !nullable(p.lotId, isUuid)
    || p.payment !== 'NOT_CONNECTED' || !isTimestamp(p.createdAt) || !nts(p.fulfilledAt)
    || (p.status === 'FULFILLED') !== (p.lotId !== null) || (p.status === 'FULFILLED') !== (p.fulfilledAt !== null)) drift();
  if (internal && (!nullable(p.paymentProvider, (v): v is string => has(['STRIPE','STRIPE_SIMULATED'], v)) || !nullable(p.providerPaymentRef, (v): v is string => text(v, 210))
    || !nullable(p.paidAmountMinor, count) || !nullable(p.paidCurrency, (v): v is string => typeof v === 'string' && v.length === 3)
    || (p.status === 'PENDING_PAYMENT') !== (p.providerPaymentRef === null))) drift();
}
function validateEligibility(value: unknown): void {
  const e = record(value, drift); exactKeys(e, ['eligible','reason','window'], drift);
  if (typeof e.eligible !== 'boolean' || !nullable(e.reason, (v): v is string => has(REASONS, v)) || e.eligible !== (e.reason === null) || e.eligible !== (e.window !== null)) drift();
  if (e.window !== null) validateWindow(e.window);
}
function validateHistory(value: unknown): void {
  if (!Array.isArray(value) || value.length > 100) drift();
  (value as unknown[]).forEach(value => {
    const h = record(value, drift); exactKeys(h, ['entryId','lotId','lotKind','entryKind','credits','reservationId','adjustmentId','occurredAt'], drift);
    if (!isUuid(h.entryId) || !isUuid(h.lotId) || !has(LOT_KINDS, h.lotKind) || !has(ENTRY_KINDS, h.entryKind) || !isInt(h.credits, 1, 1_000_000_000)
      || !nullable(h.reservationId, isUuid) || !nullable(h.adjustmentId, isUuid) || !isTimestamp(h.occurredAt)) drift();
  });
}
function validateAdjustment(value: unknown, internal: boolean): void {
  const a = record(value, drift);
  const keys = ['adjustmentId','kind','credits','lotId','reasonCode','occurredAt'];
  exactKeys(a, internal ? [...keys, 'note', 'actorPrincipalId'] : keys, drift);
  if (!isUuid(a.adjustmentId) || !has(['PROMOTIONAL_GRANT','ADJUSTMENT_GRANT','CORRECTION_DEBIT'], a.kind) || !isInt(a.credits, 1, 1_000_000_000)
    || !isUuid(a.lotId) || !has(ADJ_REASONS, a.reasonCode) || !isTimestamp(a.occurredAt) || (internal && (!text(a.note, 500) || !isUuid(a.actorPrincipalId)))) drift();
}
function validateWalletBase(w: Record<string, unknown>, internal: boolean): void {
  if (!nullable(w.walletVersion, (v): v is number => isInt(v, 1, 2147483647)) || w.agentConversationsDeductCredits !== false || w.paymentsActive !== false) drift();
  const p = record(w.program, drift); exactKeys(p, ['status','monthlyIncludedCredits'], drift);
  if (!has(['INACTIVE','ACTIVE'], p.status) || p.monthlyIncludedCredits !== SAAS_CREATIVE_MONTHLY_INCLUDED_CREDITS) drift();
  validateEligibility(w.eligibility); validateBalance(w.balance); validateHistory(w.history); validatePackages(w.packages); validateRates(w.rates, internal);
  for (const key of ['lots','reservations','adjustments','purchases']) if (!Array.isArray(w[key])) drift();
  (w.lots as unknown[]).forEach(validateLot);
  if ((w.reservations as unknown[]).length > 50 || (w.adjustments as unknown[]).length > 50 || (w.purchases as unknown[]).length > 50) drift();
  (w.reservations as unknown[]).forEach(r => validateReservation(r, internal));
  (w.adjustments as unknown[]).forEach(a => validateAdjustment(a, internal));
  (w.purchases as unknown[]).forEach(p => validatePurchase(p, internal));
}
const WALLET_KEYS = ['walletVersion','program','eligibility','balance','lots','history','reservations','adjustments','purchases','rates','packages',
  'agentConversationsDeductCredits','paymentsActive'];
export function validateSaasCreativeSchoolWallet(value: unknown): SaasCreativeSchoolWallet {
  const w = record(value, drift); exactKeys(w, [...WALLET_KEYS, 'schoolId'], drift);
  if (!isUuid(w.schoolId)) drift();
  validateWalletBase(w, false);
  if ((w.reservations as SaasCreativeReservation[]).some(r => r.schoolId !== w.schoolId)) drift();
  return w as unknown as SaasCreativeSchoolWallet;
}
export function validateSaasCreativeHqWallet(value: unknown): SaasCreativeHqWallet {
  const w = record(value, drift); exactKeys(w, [...WALLET_KEYS, 'schoolId', 'organizationId', 'providerExpense'], drift);
  if (!isUuid(w.schoolId) || !isUuid(w.organizationId)) drift();
  validateWalletBase(w, true);
  if ((w.reservations as SaasCreativeReservationInternal[]).some(r => r.schoolId !== w.schoolId || r.organizationId !== w.organizationId)) drift();
  if ((w.purchases as SaasCreativePurchase[]).some(p => p.schoolId !== w.schoolId)) drift();
  const e = record(w.providerExpense, drift);
  exactKeys(e, ['actualProviderCostMicrounits','finalizedProviderCostMicrounits','failedOrNotChargedProviderCostMicrounits','consumedCredits',
    'unknownCostGenerations','pendingCostGenerations','spendClass','generations'], drift);
  if (!count(e.actualProviderCostMicrounits) || !count(e.finalizedProviderCostMicrounits) || !count(e.failedOrNotChargedProviderCostMicrounits) || !count(e.consumedCredits)
    || !count(e.unknownCostGenerations) || !count(e.pendingCostGenerations) || e.spendClass !== 'CREATIVE_MEDIA'
    || (e.finalizedProviderCostMicrounits as number) + (e.failedOrNotChargedProviderCostMicrounits as number) !== e.actualProviderCostMicrounits) drift();
  const g = record(e.generations, drift); exactKeys(g, ['finalized','released','reserved','outcomeUnknown'], drift);
  if (!count(g.finalized) || !count(g.released) || !count(g.reserved) || !count(g.outcomeUnknown)) drift();
  return w as unknown as SaasCreativeHqWallet;
}
export function validateSaasCreativeHqWalletList(value: unknown): SaasCreativeHqWalletList {
  const r = record(value, drift); exactKeys(r, ['program','rates','packages','wallets'], drift);
  const p = record(r.program, drift); exactKeys(p, ['status','version','monthlyIncludedCredits'], drift);
  if (!has(['INACTIVE','ACTIVE'], p.status) || !isInt(p.version, 1, 2147483647) || p.monthlyIncludedCredits !== SAAS_CREATIVE_MONTHLY_INCLUDED_CREDITS) drift();
  validateRates(r.rates, true); validatePackages(r.packages);
  if (!Array.isArray(r.wallets) || r.wallets.length > 200) drift();
  (r.wallets as unknown[]).forEach(value => {
    const w = record(value, drift);
    exactKeys(w, ['schoolId','schoolName','organizationId','organizationName','availableCredits','heldCredits','consumedCredits','actualProviderCostMicrounits',
      'outcomeUnknown','unknownCostGenerations','updatedAt'], drift);
    if (!isUuid(w.schoolId) || typeof w.schoolName !== 'string' || !isUuid(w.organizationId) || typeof w.organizationName !== 'string' || !count(w.availableCredits)
      || !count(w.heldCredits) || !count(w.consumedCredits) || !count(w.actualProviderCostMicrounits) || !count(w.outcomeUnknown) || !count(w.unknownCostGenerations)
      || !isTimestamp(w.updatedAt)) drift();
  });
  if (new Set((r.wallets as SaasCreativeHqWalletRow[]).map(w => w.schoolId)).size !== (r.wallets as unknown[]).length) drift();
  return r as unknown as SaasCreativeHqWalletList;
}
const replayed = (r: Record<string, unknown>) => { if (typeof r.replayed !== 'boolean') drift(); };
export function validateSaasCreativeProgramReceipt(value: unknown): SaasCreativeProgramReceipt {
  const r = record(value, drift); exactKeys(r, ['program','replayed'], drift); replayed(r);
  const p = record(r.program, drift); exactKeys(p, ['status','version','monthlyIncludedCredits','authorizationReference','changedAt'], drift);
  if (!has(['INACTIVE','ACTIVE'], p.status) || !isInt(p.version, 2, 2147483647) || p.monthlyIncludedCredits !== SAAS_CREATIVE_MONTHLY_INCLUDED_CREDITS
    || !text(p.authorizationReference, 200) || !isTimestamp(p.changedAt)) drift();
  return r as unknown as SaasCreativeProgramReceipt;
}
export function validateSaasCreativeRatesReceipt(value: unknown): SaasCreativeRatesReceipt {
  const r = record(value, drift); exactKeys(r, ['rates','retiredRateVersionId','replayed'], drift); replayed(r);
  if (r.rates === null || !nullable(r.retiredRateVersionId, isUuid)) drift();
  validateRates(r.rates, true);
  return r as unknown as SaasCreativeRatesReceipt;
}
export function validateSaasCreativeAdjustmentReceipt(value: unknown): SaasCreativeAdjustmentReceipt {
  const r = record(value, drift); exactKeys(r, ['adjustment','balance','replayed'], drift); replayed(r); validateBalance(r.balance);
  const a = record(r.adjustment, drift);
  const debit = Object.prototype.hasOwnProperty.call(a, 'credits');
  exactKeys(a, debit ? ['adjustmentId','schoolId','lot','credits','reasonCode','note'] : ['adjustmentId','schoolId','lot','reasonCode','note'], drift);
  if (!isUuid(a.adjustmentId) || !isUuid(a.schoolId) || !has(ADJ_REASONS, a.reasonCode) || !text(a.note, 500) || (debit && !isInt(a.credits, 1, 1_000_000_000))) drift();
  validateLot(a.lot);
  return r as unknown as SaasCreativeAdjustmentReceipt;
}
export function validateSaasCreativeResolveReceipt(value: unknown): SaasCreativeResolveReceipt {
  const r = record(value, drift); exactKeys(r, ['reservation','replayed'], drift); replayed(r); validateReservation(r.reservation, true);
  return r as unknown as SaasCreativeResolveReceipt;
}
export function validateSaasCreativeCostReceipt(value: unknown): SaasCreativeCostReceipt {
  const r = record(value, drift); exactKeys(r, ['reservation','outcome','replayed'], drift); replayed(r); validateReservation(r.reservation, true);
  const x = r.reservation as SaasCreativeReservationInternal;
  if (r.outcome !== 'APPLIED' || x.status !== 'RELEASED' || x.costStatus !== 'RECORDED') drift();
  return r as unknown as SaasCreativeCostReceipt;
}
export function validateSaasCreativeWindowReceipt(value: unknown): SaasCreativeWindowReceipt {
  const r = record(value, drift); exactKeys(r, ['lot','balance','replayed'], drift); replayed(r); validateLot(r.lot); validateBalance(r.balance);
  if ((r.lot as SaasCreativeLot).kind !== 'INCLUDED_MONTHLY') drift();
  return r as unknown as SaasCreativeWindowReceipt;
}
export function validateSaasCreativeReservationReceipt(value: unknown): SaasCreativeReservationReceipt {
  const r = record(value, drift); exactKeys(r, ['reservation','balance','replayed'], drift); replayed(r);
  validateReservation(r.reservation, false); validateBalance(r.balance);
  return r as unknown as SaasCreativeReservationReceipt;
}
export function validateSaasCreativePurchaseReceipt(value: unknown): SaasCreativePurchaseReceipt {
  const r = record(value, drift); exactKeys(r, ['purchase','replayed'], drift); replayed(r); validatePurchase(r.purchase, false);
  return r as unknown as SaasCreativePurchaseReceipt;
}
