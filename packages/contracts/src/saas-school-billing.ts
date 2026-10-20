// HON Subscription Billing B5.1 closed contracts: a school's own read-only view of its organization's HON
// subscription billing (never school-to-family membership billing), and the HQ dry run of the PROPOSED
// paid-access terms. School staff need billing.hon.view at the exact school; HQ financial permissions never
// apply. Drafts, HQ notes and internal references are never present. Access is read from the entitlement
// and is never inferred from a payment: `access.paymentActivated` is true only after the B6A transition, which
// requires the paid-access program to be ACTIVE (it is INACTIVE until the owner approves).
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsNullable as nullable, championsRecord as record } from './champions-club.js';
import { SAAS_SUBSCRIPTION_PAYMENT_STATUSES, validateSaasSubscriptionForSchool, type SaasSubscription,
  type SaasSubscriptionPaymentStatus } from './saas-billing.js';
import type { SaasEvidenceKind, SaasInvoiceKind, SaasInvoiceLineKind, SaasPaymentStandingFacts, SaasSettlementState, SaasTaxStatus } from './saas-invoicing.js';

const has = (list: readonly unknown[], value: unknown) => list.includes(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max && value.trim() === value;
const count = (v: unknown): v is number => isInt(v, 0, Number.MAX_SAFE_INTEGER);
const nts = (v: unknown) => v === null || isTimestamp(v);
const code = (v: unknown): v is string => typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,59}$/.test(v);
const PLAN_CODES = ['CORE','COMPLETE'] as const;
const OFFER_KINDS = ['REGULAR_MONTHLY','FOUNDER_MONTHLY','FOUNDER_LIFETIME'] as const;

// ---------- query ----------
export interface SaasSchoolInvoiceCursor { issuedAt: string; invoiceId: string }
export interface SaasSchoolInvoiceQuery {
  status: 'ISSUED' | 'VOID' | null; kind: SaasInvoiceKind | null; cursor: SaasSchoolInvoiceCursor | null; limit: number;
}
/** `?cursor=` value for the next page: `<issuedAt>~<invoiceId>` from the previous page's `nextCursor`. */
export function encodeSaasSchoolInvoiceCursor(cursor: SaasSchoolInvoiceCursor): string {
  return `${cursor.issuedAt}~${cursor.invoiceId}`;
}
export function validateSaasSchoolInvoiceQuery(value: unknown): SaasSchoolInvoiceQuery {
  const q = record(value ?? {}, invalid);
  if (Object.keys(q).some(k => !['status','kind','cursor','limit'].includes(k))) invalid();
  const one = (v: unknown): string | null => (v === undefined ? null : typeof v === 'string' ? v : invalid());
  const status = one(q.status), kind = one(q.kind), cursor = one(q.cursor), limit = one(q.limit);
  if ((status !== null && !has(['ISSUED','VOID'], status)) || (kind !== null && !has(['SUBSCRIPTION_PERIOD','LIFETIME_PURCHASE'], kind))
    || (limit !== null && !/^(?:[1-9]\d?|100)$/.test(limit))) invalid();
  let decoded: SaasSchoolInvoiceCursor | null = null;
  if (cursor !== null) {
    if (cursor.length > 80) invalid();
    const [issuedAt, invoiceId, ...rest] = cursor.split('~');
    if (rest.length || !isTimestamp(issuedAt) || !isUuid(invoiceId)) invalid();
    decoded = { issuedAt: issuedAt as string, invoiceId: invoiceId as string };
  }
  return { status: status as SaasSchoolInvoiceQuery['status'], kind: kind as SaasInvoiceKind | null, cursor: decoded, limit: limit === null ? 25 : Number(limit) };
}

// ---------- responses ----------
export interface SaasSchoolInvoiceSettlement {
  receivedMinor: number; refundedMinor: number; chargedBackMinor: number; netMinor: number; verifiedNetMinor: number;
  balanceMinor: number | null; state: Exclude<SaasSettlementState, 'NOT_ISSUED'>;
}
export interface SaasSchoolInvoiceSummary {
  invoiceId: string; invoiceNumber: string; subscriptionId: string; kind: SaasInvoiceKind; periodIndex: number | null;
  servicePeriod: { startsAt: string; endsAt: string | null }; planCode: typeof PLAN_CODES[number]; offerKind: typeof OFFER_KINDS[number];
  description: string; currency: 'USD'; status: 'ISSUED' | 'VOID'; subtotalMinor: number; taxStatus: Exclude<SaasTaxStatus, 'UNRESOLVED'>;
  taxMinor: number; totalMinor: number; settlement: SaasSchoolInvoiceSettlement;
  /** PROVIDER_VERIFIED only when provider-verified (test-mode) evidence covers the total; HQ_RECORDED when HQ attestation does. */
  paymentVerification: 'PROVIDER_VERIFIED' | 'HQ_RECORDED' | 'NONE';
  collection: 'DISABLED'; issuedAt: string; voidedAt: string | null; voidReason: 'ISSUED_IN_ERROR' | 'DUPLICATE' | 'SUPERSEDED' | null;
}
export interface SaasSchoolInvoiceLine { lineNumber: number; lineKind: SaasInvoiceLineKind; description: string; amountMinor: number }
export interface SaasSchoolPaymentEvidence {
  evidenceId: string; kind: SaasEvidenceKind; source: 'HQ_ATTESTATION' | 'PROVIDER_VERIFIED'; providerVerified: boolean; providerMode: 'TEST' | null;
  amountMinor: number; currency: 'USD'; occurredAt: string; relatedEvidenceId: string | null; recordedAt: string;
}
export interface SaasSchoolRefund {
  refundRequestId: string; invoiceId: string; invoiceNumber: string | null; offerKind: typeof OFFER_KINDS[number];
  firstPaidAt: string; windowEndsAt: string; requestReceivedAt: string; requestedAmountMinor: number; approvedAmountMinor: number | null;
  evidenceStrength: 'HQ_ATTESTED' | 'PROVIDER_VERIFIED'; status: 'REQUESTED' | 'APPROVED' | 'DENIED' | 'REFUND_EVIDENCED'; statusReason: string;
  execution: 'UNAVAILABLE'; refundEvidencedMinor: number; createdAt: string; decidedAt: string | null;
}
export interface SaasSchoolInvoiceDetail extends SaasSchoolInvoiceSummary {
  schoolId: string; organizationId: string; lines: SaasSchoolInvoiceLine[]; evidence: SaasSchoolPaymentEvidence[]; refunds: SaasSchoolRefund[];
}
export interface SaasSchoolInvoicePage {
  schoolId: string; organizationId: string; billingScope: 'ORGANIZATION'; invoices: SaasSchoolInvoiceSummary[]; limit: number;
  nextCursor: SaasSchoolInvoiceCursor | null;
}
/** B6A access state: provisioned (existing schools), awaiting a first payment, or activated by a verified payment. */
export type SaasOrganizationAccessState = 'PROVISIONED' | 'AWAITING_FIRST_PAYMENT' | 'PAYMENT_ACTIVE' | 'NONE';
export const SAAS_ORGANIZATION_ACCESS_STATES: readonly SaasOrganizationAccessState[] = ['PROVISIONED','AWAITING_FIRST_PAYMENT','PAYMENT_ACTIVE','NONE'];
const ACCESS_STATES = SAAS_ORGANIZATION_ACCESS_STATES;
export type SaasAccountActivation = 'READY' | 'PENDING_ACCOUNT_ACTIVATION' | 'UNAVAILABLE';
export type SaasAccessAlignment = 'ALIGNED' | 'NO_SUBSCRIPTION' | 'PLAN_MISMATCH' | 'SUBSCRIPTION_NOT_IN_SERVICE';
export type SaasAllowanceState = 'AVAILABLE' | 'EXHAUSTED' | 'NOT_YET_OPENED' | 'PERIOD_CLOSED' | 'PROGRAM_INACTIVE' | 'SUSPENDED'
  | 'SUBSCRIPTION_NOT_IN_SERVICE' | 'NO_SUBSCRIPTION' | 'ACCESS_NOT_ACTIVE';
export interface SaasEntitlementView {
  tier: 'ESSENTIAL' | 'CORE' | 'COMPLETE'; status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED'; effectiveFrom: string; effectiveUntil: string | null;
  version: number; inEffect: boolean;
}
export interface SaasSchoolBillingAccount {
  schoolId: string; organizationId: string; organizationName: string; billingScope: 'ORGANIZATION'; schoolCount: number;
  entitlement: SaasEntitlementView | null;
  access: { source: 'PROVISIONED' | 'PAYMENT_ACTIVATED' | 'NONE'; paymentActivated: boolean; state: SaasOrganizationAccessState;
    paidAccessProgram: 'INACTIVE' | 'ACTIVE'; activation: SaasAccountActivation; alignment: SaasAccessAlignment };
  subscription: Omit<SaasSubscription, 'organizationName'> | null;
  subscriptionHistory: { version: number; status: string; statusReason: string; periodIndex: number | null; periodStart: string | null; periodEnd: string | null; occurredAt: string }[];
  subscriptions: { subscriptionId: string; source: 'CATALOG_OFFER' | 'LEGACY_ENTITLEMENT'; catalogVersion: number | null; planCode: 'ESSENTIAL' | 'CORE' | 'COMPLETE';
    offerKind: typeof OFFER_KINDS[number] | null; billingInterval: 'MONTHLY' | 'LIFETIME' | 'NONE'; priceMinor: number | null; currency: 'USD';
    status: string; statusReason: string; serviceStartedAt: string | null; createdAt: string }[];
  payment: { status: SaasSubscriptionPaymentStatus; verification: 'PROVIDER_VERIFIED' | 'HQ_ATTESTED' | 'NONE'; paidThroughAt: string | null; unpaidSince: string | null;
    verified: SaasPaymentStandingFacts; recorded: SaasPaymentStandingFacts; evidenceCounts: { hqAttested: number; providerVerified: number };
    providerVerification: 'NOT_CONFIGURED' | 'TEST_MODE' };
  allowance: { state: SaasAllowanceState; programStatus: 'INACTIVE' | 'ACTIVE'; plannedMonthlyCredits: number | null;
    period: { index: number; startsAt: string; endsAt: string } | null; basis: 'REGULAR' | 'FOUNDER' | 'LIFETIME' | 'LEGACY' | null;
    grantedCredits: number | null; consumedCredits: number | null; reservedCredits: number | null; remainingCredits: number | null; usedPercent: number | null;
    suspensionPolicy: 'UNDECIDED'; topUps: 'UNAVAILABLE' };
  refunds: SaasSchoolRefund[]; cardDataStored: false; asOf: string;
}
export type SaasShadowAccessState = 'ACTIVE' | 'AWAITING_FIRST_PAYMENT' | 'PAST_DUE_GRACE' | 'RESTRICTED' | 'SUSPENDED' | 'ENDED' | 'NO_ACCESS';
export interface SaasAccessReadiness {
  organizationId: string;
  program: { status: 'INACTIVE'; mutationsEnabled: false; activation: 'REVIEWED_MIGRATION_AFTER_OWNER_APPROVAL' };
  proposedTerms: { policyVersion: number; status: 'PROPOSED'; newSchoolAccess: string; firstPayment: string; graceDays: number; restrictAfterDays: number;
    suspendAfterDays: number; restrictedEffect: string; suspendedEffect: string; reactivation: string; cancellationTiming: string; refundEffect: string;
    disputeEffect: string; founderPriceRule: string; lifetimeRule: string; exceptionMaxDays: number; exceptionAuthority: 'HQ_OWNER'; dataDeletion: 'NEVER' };
  dryRun: { policyVersion: number; policyStatus: 'PROPOSED'; wouldBeState: SaasShadowAccessState; reason: string; daysUnpaid: number | null;
    graceDays: number; restrictAfterDays: number; suspendAfterDays: number; premiumAiWouldBeSuspended: boolean;
    condition: { entitlement: SaasEntitlementView | null; subscriptionStatus: string | null; paymentStatus: SaasSubscriptionPaymentStatus;
      paymentVerification: 'PROVIDER_VERIFIED' | 'HQ_ATTESTED' | 'NONE'; paidThroughAt: string | null; unpaidSince: string | null;
      billingInterval: 'MONTHLY' | 'LIFETIME' | 'NONE' | null; planMatchesEntitlement: boolean | null };
    enforcement: 'NONE' };
  asOf: string;
}

// ---------- response validators ----------
function settlement(value: unknown, status: unknown, total: number): void {
  const s = record(value, drift);
  exactKeys(s, ['receivedMinor','refundedMinor','chargedBackMinor','netMinor','verifiedNetMinor','balanceMinor','state'], drift);
  if (!count(s.receivedMinor) || !count(s.refundedMinor) || !count(s.chargedBackMinor) || !count(s.netMinor) || !count(s.verifiedNetMinor)
    || (s.verifiedNetMinor as number) > (s.netMinor as number) || !has(['VOID','UNPAID','PARTIALLY_PAID','PAID_VERIFIED','PAID_ATTESTED','REVERSED'], s.state)
    || (status === 'VOID') !== (s.state === 'VOID')
    || (status === 'ISSUED' && (s.state === 'PAID_VERIFIED') !== ((s.verifiedNetMinor as number) >= total))
    || (status === 'ISSUED' ? !count(s.balanceMinor) || (s.balanceMinor as number) > total : s.balanceMinor !== null)) drift();
}
const SUMMARY = ['invoiceId','invoiceNumber','subscriptionId','kind','periodIndex','servicePeriod','planCode','offerKind','description','currency','status',
  'subtotalMinor','taxStatus','taxMinor','totalMinor','settlement','paymentVerification','collection','issuedAt','voidedAt','voidReason'];
function invoice(value: unknown, detail: boolean): void {
  const i = record(value, drift);
  exactKeys(i, detail ? ['schoolId','organizationId',...SUMMARY,'lines','evidence','refunds'] : SUMMARY, drift);
  const period = i.kind === 'SUBSCRIPTION_PERIOD';
  if (!isUuid(i.invoiceId) || typeof i.invoiceNumber !== 'string' || !/^HON-20\d{2}-\d{6}$/.test(i.invoiceNumber) || !isUuid(i.subscriptionId)
    || !has(['SUBSCRIPTION_PERIOD','LIFETIME_PURCHASE'], i.kind) || (period ? !count(i.periodIndex) : i.periodIndex !== null)
    || !has(PLAN_CODES, i.planCode) || !has(OFFER_KINDS, i.offerKind) || (i.offerKind === 'FOUNDER_LIFETIME') === period
    || !text(i.description, 300) || i.currency !== 'USD' || !has(['ISSUED','VOID'], i.status) || !isInt(i.subtotalMinor, 0, 100_000_000)
    || !has(['NO_TAX_APPLICABLE','TAX_LINES'], i.taxStatus) || !isInt(i.taxMinor, 0, 100_000_000) || (i.taxStatus === 'NO_TAX_APPLICABLE') !== (i.taxMinor === 0)
    || i.totalMinor !== (i.subtotalMinor as number) + (i.taxMinor as number) || !((i.totalMinor as number) > 0)
    || !has(['PROVIDER_VERIFIED','HQ_RECORDED','NONE'], i.paymentVerification) || i.collection !== 'DISABLED' || !isTimestamp(i.issuedAt)
    || !nts(i.voidedAt) || (i.status === 'VOID') !== (i.voidedAt !== null)
    || !nullable(i.voidReason, (v): v is string => has(['ISSUED_IN_ERROR','DUPLICATE','SUPERSEDED'], v)) || (i.voidReason === null) !== (i.voidedAt === null)) drift();
  const p = record(i.servicePeriod, drift); exactKeys(p, ['startsAt','endsAt'], drift);
  if (!isTimestamp(p.startsAt) || (period ? !isTimestamp(p.endsAt) : p.endsAt !== null)) drift();
  settlement(i.settlement, i.status, i.totalMinor as number);
  const st = (i.settlement as SaasSchoolInvoiceSettlement).state;
  if ((i.paymentVerification === 'PROVIDER_VERIFIED') !== (st === 'PAID_VERIFIED') || (i.paymentVerification === 'HQ_RECORDED') !== (st === 'PAID_ATTESTED')) drift();
  if (!detail) return;
  if (!isUuid(i.schoolId) || !isUuid(i.organizationId) || !Array.isArray(i.lines) || i.lines.length < 1 || i.lines.length > 30
    || !Array.isArray(i.evidence) || !Array.isArray(i.refunds)) drift();
  (i.lines as unknown[]).forEach((l, n) => {
    const r = record(l, drift); exactKeys(r, ['lineNumber','lineKind','description','amountMinor'], drift);
    if (r.lineNumber !== n + 1 || !has(['PLAN_FEE','DISCOUNT','CORRECTION','TAX','ACCOUNT_CREDIT'], r.lineKind) || (n === 0) !== (r.lineKind === 'PLAN_FEE')
      || !text(r.description, 300) || !isInt(r.amountMinor, -100_000_000, 100_000_000) || r.amountMinor === 0
      || (r.lineKind === 'ACCOUNT_CREDIT' && (r.amountMinor as number) >= 0)) drift();
  });
  const lines = i.lines as SaasSchoolInvoiceLine[];
  if (lines.filter(l => l.lineKind !== 'TAX').reduce((t, l) => t + l.amountMinor, 0) !== i.subtotalMinor
    || lines.filter(l => l.lineKind === 'TAX').reduce((t, l) => t + l.amountMinor, 0) !== i.taxMinor) drift();
  (i.evidence as unknown[]).forEach(v => {
    const e = record(v, drift);
    exactKeys(e, ['evidenceId','kind','source','providerVerified','providerMode','amountMinor','currency','occurredAt','relatedEvidenceId','recordedAt'], drift);
    if (!isUuid(e.evidenceId) || !has(['PAYMENT_RECEIVED','REFUND','CHARGEBACK'], e.kind) || !has(['HQ_ATTESTATION','PROVIDER_VERIFIED'], e.source)
      || e.providerVerified !== (e.source === 'PROVIDER_VERIFIED') || e.providerMode !== (e.source === 'PROVIDER_VERIFIED' ? 'TEST' : null)
      || !isInt(e.amountMinor, 1, 200_000_000) || e.currency !== 'USD' || !isTimestamp(e.occurredAt) || !nullable(e.relatedEvidenceId, isUuid)
      || (e.kind === 'PAYMENT_RECEIVED') !== (e.relatedEvidenceId === null) || !isTimestamp(e.recordedAt)) drift();
  });
  (i.refunds as unknown[]).forEach(r => { refund(r); if ((r as SaasSchoolRefund).invoiceId !== i.invoiceId) drift(); });
}
function refund(value: unknown): void {
  const r = record(value, drift);
  exactKeys(r, ['refundRequestId','invoiceId','invoiceNumber','offerKind','firstPaidAt','windowEndsAt','requestReceivedAt','requestedAmountMinor',
    'approvedAmountMinor','evidenceStrength','status','statusReason','execution','refundEvidencedMinor','createdAt','decidedAt'], drift);
  if (!isUuid(r.refundRequestId) || !isUuid(r.invoiceId) || !nullable(r.invoiceNumber, (v): v is string => typeof v === 'string' && /^HON-20\d{2}-\d{6}$/.test(v))
    || !has(OFFER_KINDS, r.offerKind) || !isTimestamp(r.firstPaidAt) || !isTimestamp(r.windowEndsAt) || !isTimestamp(r.requestReceivedAt)
    || !isInt(r.requestedAmountMinor, 1, 200_000_000) || !nullable(r.approvedAmountMinor, (v): v is number => isInt(v, 1, 200_000_000))
    || !has(['HQ_ATTESTED','PROVIDER_VERIFIED'], r.evidenceStrength) || !has(['REQUESTED','APPROVED','DENIED','REFUND_EVIDENCED'], r.status)
    || !code(r.statusReason) || r.execution !== 'UNAVAILABLE' || !count(r.refundEvidencedMinor) || !isTimestamp(r.createdAt) || !nts(r.decidedAt)
    || (r.status === 'REQUESTED') !== (r.decidedAt === null)) drift();
}
function facts(value: unknown): void {
  const f = record(value, drift);
  exactKeys(f, ['firstPaidAt','paidThroughAt','lifetimePaid','paidInvoiceCount','refundedInvoiceCount','chargebackInvoiceCount'], drift);
  if (!nts(f.firstPaidAt) || !nts(f.paidThroughAt) || typeof f.lifetimePaid !== 'boolean' || !count(f.paidInvoiceCount)
    || !count(f.refundedInvoiceCount) || !count(f.chargebackInvoiceCount) || (f.paidInvoiceCount === 0) !== (f.firstPaidAt === null)) drift();
}
/** Validates one canonical entitlement view (or null). */
export function validateSaasEntitlementView(value: unknown): void {
  if (value === null) return;
  const e = record(value, drift); exactKeys(e, ['tier','status','effectiveFrom','effectiveUntil','version','inEffect'], drift);
  if (!has(['ESSENTIAL','CORE','COMPLETE'], e.tier) || !has(['ACTIVE','SUSPENDED','ARCHIVED'], e.status) || !isTimestamp(e.effectiveFrom)
    || !nts(e.effectiveUntil) || !isInt(e.version, 1, 2147483647) || typeof e.inEffect !== 'boolean' || (e.inEffect && e.status !== 'ACTIVE')) drift();
}
const PAYMENT_VERIFICATIONS = ['PROVIDER_VERIFIED','HQ_ATTESTED','NONE'];
const ALLOWANCE_STATES: readonly SaasAllowanceState[] = ['AVAILABLE','EXHAUSTED','NOT_YET_OPENED','PERIOD_CLOSED','PROGRAM_INACTIVE','SUSPENDED',
  'SUBSCRIPTION_NOT_IN_SERVICE','NO_SUBSCRIPTION','ACCESS_NOT_ACTIVE'];

export function validateSaasSchoolInvoicePage(value: unknown): SaasSchoolInvoicePage {
  const r = record(value, drift); exactKeys(r, ['schoolId','organizationId','billingScope','invoices','limit','nextCursor'], drift);
  if (!isUuid(r.schoolId) || !isUuid(r.organizationId) || r.billingScope !== 'ORGANIZATION' || !Array.isArray(r.invoices) || !isInt(r.limit, 1, 100)
    || r.invoices.length > (r.limit as number)) drift();
  (r.invoices as unknown[]).forEach(v => invoice(v, false));
  const list = r.invoices as SaasSchoolInvoiceSummary[];
  // Newest issued first, strictly ordered (the keyset the cursor continues from).
  for (let n = 1; n < list.length; n++) {
    const a = list[n - 1]!, b = list[n]!;
    if (a.issuedAt < b.issuedAt || (a.issuedAt === b.issuedAt && a.invoiceId <= b.invoiceId)) drift();
  }
  if (r.nextCursor !== null) {
    const c = record(r.nextCursor, drift); exactKeys(c, ['issuedAt','invoiceId'], drift);
    const last = list.at(-1);
    if (list.length !== r.limit || !last || c.issuedAt !== last.issuedAt || c.invoiceId !== last.invoiceId) drift();
  }
  return r as unknown as SaasSchoolInvoicePage;
}
export function validateSaasSchoolInvoiceDetail(value: unknown): SaasSchoolInvoiceDetail {
  invoice(value, true);
  return value as SaasSchoolInvoiceDetail;
}
export function validateSaasSchoolBillingAccount(value: unknown): SaasSchoolBillingAccount {
  const r = record(value, drift);
  exactKeys(r, ['schoolId','organizationId','organizationName','billingScope','schoolCount','entitlement','access','subscription','subscriptionHistory',
    'subscriptions','payment','allowance','refunds','cardDataStored','asOf'], drift);
  if (!isUuid(r.schoolId) || !isUuid(r.organizationId) || !text(r.organizationName, 300) || r.billingScope !== 'ORGANIZATION' || !isInt(r.schoolCount, 0, 100_000)
    || r.cardDataStored !== false || !isTimestamp(r.asOf) || !Array.isArray(r.subscriptionHistory) || !Array.isArray(r.subscriptions)
    || !Array.isArray(r.refunds) || r.subscriptions.length > 20 || r.refunds.length > 50) drift();
  validateSaasEntitlementView(r.entitlement);
  const ent = r.entitlement as SaasEntitlementView | null;
  const a = record(r.access, drift); exactKeys(a, ['source','paymentActivated','state','paidAccessProgram','activation','alignment'], drift);
  // Payment-activated only through the B6A transition (its access state), never from a payment alone.
  if (a.source !== (ent === null ? 'NONE' : a.state === 'PAYMENT_ACTIVE' ? 'PAYMENT_ACTIVATED' : 'PROVISIONED')
    || a.paymentActivated !== (a.state === 'PAYMENT_ACTIVE') || !has(ACCESS_STATES, a.state) || (ent === null) !== (a.state === 'NONE')
    || !has(['INACTIVE','ACTIVE'], a.paidAccessProgram)
    || !has(['READY','PENDING_ACCOUNT_ACTIVATION','UNAVAILABLE'], a.activation)
    || !has(['ALIGNED','NO_SUBSCRIPTION','PLAN_MISMATCH','SUBSCRIPTION_NOT_IN_SERVICE'], a.alignment)
    // Ready only when the entitlement itself is in effect: never from payment alone.
    || (a.activation === 'READY') !== (ent?.inEffect === true && (a.alignment === 'ALIGNED' || a.alignment === 'NO_SUBSCRIPTION'))
    || (r.subscription === null) !== (a.alignment === 'NO_SUBSCRIPTION')) drift();
  if (r.subscription !== null) validateSaasSubscriptionForSchool(r.subscription);
  (r.subscriptionHistory as unknown[]).forEach(v => {
    const h = record(v, drift); exactKeys(h, ['version','status','statusReason','periodIndex','periodStart','periodEnd','occurredAt'], drift);
    if (!isInt(h.version, 1, 2147483647) || !code(h.status) || !code(h.statusReason) || !nullable(h.periodIndex, count) || !nts(h.periodStart)
      || !nts(h.periodEnd) || !isTimestamp(h.occurredAt)) drift();
  });
  (r.subscriptions as unknown[]).forEach(v => {
    const s = record(v, drift);
    exactKeys(s, ['subscriptionId','source','catalogVersion','planCode','offerKind','billingInterval','priceMinor','currency','status','statusReason',
      'serviceStartedAt','createdAt'], drift);
    if (!isUuid(s.subscriptionId) || !has(['CATALOG_OFFER','LEGACY_ENTITLEMENT'], s.source) || !nullable(s.catalogVersion, (x): x is number => isInt(x, 1, 2147483647))
      || !has(['ESSENTIAL','CORE','COMPLETE'], s.planCode) || !nullable(s.offerKind, (x): x is string => has(OFFER_KINDS, x))
      || !has(['MONTHLY','LIFETIME','NONE'], s.billingInterval) || !nullable(s.priceMinor, (x): x is number => isInt(x, 100, 10_000_000)) || s.currency !== 'USD'
      || !code(s.status) || !code(s.statusReason) || !nts(s.serviceStartedAt) || !isTimestamp(s.createdAt)) drift();
  });
  const p = record(r.payment, drift);
  exactKeys(p, ['status','verification','paidThroughAt','unpaidSince','verified','recorded','evidenceCounts','providerVerification'], drift);
  if (!has(SAAS_SUBSCRIPTION_PAYMENT_STATUSES, p.status) || !has(PAYMENT_VERIFICATIONS, p.verification) || (p.status === 'PAID') === (p.verification === 'NONE')
    || !nts(p.paidThroughAt) || !nts(p.unpaidSince) || (p.unpaidSince !== null) !== (p.status === 'DUE' || p.status === 'PAST_DUE')
    || !has(['NOT_CONFIGURED','TEST_MODE'], p.providerVerification)) drift();
  facts(p.verified); facts(p.recorded);
  const ec = record(p.evidenceCounts, drift); exactKeys(ec, ['hqAttested','providerVerified'], drift);
  if (!count(ec.hqAttested) || !count(ec.providerVerified)) drift();
  const w = record(r.allowance, drift);
  exactKeys(w, ['state','programStatus','plannedMonthlyCredits','period','basis','grantedCredits','consumedCredits','reservedCredits','remainingCredits',
    'usedPercent','suspensionPolicy','topUps'], drift);
  const opened = w.period !== null;
  const n = (x: unknown) => (opened ? count(x) : x === null);
  if (!has(ALLOWANCE_STATES, w.state) || !has(['INACTIVE','ACTIVE'], w.programStatus) || !nullable(w.plannedMonthlyCredits, count)
    || !nullable(w.basis, (x): x is string => has(['REGULAR','FOUNDER','LIFETIME','LEGACY'], x)) || (w.basis === null) === opened
    || !n(w.grantedCredits) || !n(w.consumedCredits) || !n(w.reservedCredits) || !n(w.remainingCredits)
    || !(opened ? isInt(w.usedPercent, 0, 100) : w.usedPercent === null) || w.suspensionPolicy !== 'UNDECIDED' || w.topUps !== 'UNAVAILABLE'
    || (opened && (w.remainingCredits as number) > (w.grantedCredits as number))
    || ((w.state === 'AVAILABLE' || w.state === 'EXHAUSTED' || w.state === 'PERIOD_CLOSED') && !opened)
    || (w.state === 'AVAILABLE' && !((w.remainingCredits as number) > 0)) || (w.state === 'EXHAUSTED' && w.remainingCredits !== 0)
    || (w.state === 'ACCESS_NOT_ACTIVE') !== (ent?.inEffect !== true)) drift();
  if (opened) {
    const q = record(w.period, drift); exactKeys(q, ['index','startsAt','endsAt'], drift);
    if (!count(q.index) || !isTimestamp(q.startsAt) || !isTimestamp(q.endsAt)) drift();
  }
  (r.refunds as unknown[]).forEach(refund);
  return r as unknown as SaasSchoolBillingAccount;
}
export function validateSaasAccessReadiness(value: unknown): SaasAccessReadiness {
  const r = record(value, drift); exactKeys(r, ['organizationId','program','proposedTerms','dryRun','asOf'], drift);
  if (!isUuid(r.organizationId) || !isTimestamp(r.asOf)) drift();
  const p = record(r.program, drift); exactKeys(p, ['status','mutationsEnabled','activation'], drift);
  if (p.status !== 'INACTIVE' || p.mutationsEnabled !== false || p.activation !== 'REVIEWED_MIGRATION_AFTER_OWNER_APPROVAL') drift();
  const t = record(r.proposedTerms, drift);
  exactKeys(t, ['policyVersion','status','newSchoolAccess','firstPayment','graceDays','restrictAfterDays','suspendAfterDays','restrictedEffect','suspendedEffect',
    'reactivation','cancellationTiming','refundEffect','disputeEffect','founderPriceRule','lifetimeRule','exceptionMaxDays','exceptionAuthority','dataDeletion'], drift);
  if (!isInt(t.policyVersion, 1, 1000) || t.status !== 'PROPOSED' || !isInt(t.graceDays, 0, 30) || !isInt(t.restrictAfterDays, 0, 90)
    || !isInt(t.suspendAfterDays, 1, 90) || (t.restrictAfterDays as number) < (t.graceDays as number) || (t.suspendAfterDays as number) <= (t.restrictAfterDays as number)
    || !isInt(t.exceptionMaxDays, 1, 90) || t.exceptionAuthority !== 'HQ_OWNER' || t.dataDeletion !== 'NEVER'
    || ![t.newSchoolAccess, t.firstPayment, t.restrictedEffect, t.suspendedEffect, t.reactivation, t.cancellationTiming, t.refundEffect, t.disputeEffect,
      t.founderPriceRule, t.lifetimeRule].every(code)) drift();
  const d = record(r.dryRun, drift);
  exactKeys(d, ['policyVersion','policyStatus','wouldBeState','reason','daysUnpaid','graceDays','restrictAfterDays','suspendAfterDays',
    'premiumAiWouldBeSuspended','condition','enforcement'], drift);
  if (d.policyVersion !== t.policyVersion || d.policyStatus !== 'PROPOSED'
    || !has(['ACTIVE','AWAITING_FIRST_PAYMENT','PAST_DUE_GRACE','RESTRICTED','SUSPENDED','ENDED','NO_ACCESS'], d.wouldBeState) || !code(d.reason)
    || !nullable(d.daysUnpaid, count) || d.graceDays !== t.graceDays || d.restrictAfterDays !== t.restrictAfterDays || d.suspendAfterDays !== t.suspendAfterDays
    || typeof d.premiumAiWouldBeSuspended !== 'boolean' || d.enforcement !== 'NONE') drift();
  const c = record(d.condition, drift);
  exactKeys(c, ['entitlement','subscriptionStatus','paymentStatus','paymentVerification','paidThroughAt','unpaidSince','billingInterval','planMatchesEntitlement'], drift);
  validateSaasEntitlementView(c.entitlement);
  if (!nullable(c.subscriptionStatus, code) || !has(SAAS_SUBSCRIPTION_PAYMENT_STATUSES, c.paymentStatus) || !has(PAYMENT_VERIFICATIONS, c.paymentVerification)
    || !nts(c.paidThroughAt) || !nts(c.unpaidSince) || !nullable(c.billingInterval, (x): x is string => has(['MONTHLY','LIFETIME','NONE'], x))
    || !nullable(c.planMatchesEntitlement, (x): x is boolean => typeof x === 'boolean')) drift();
  return r as unknown as SaasAccessReadiness;
}
