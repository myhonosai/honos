// HON Subscription Billing Milestone B2 closed contracts: HON-to-school invoices and payment evidence
// (never school-to-family billing). Recordkeeping only: invoices are never delivered or collected,
// and every evidence entry is an HQ attestation; providerVerified is always false until a provider
// milestone is approved. Unverified evidence must never be presented as processor-confirmed payment.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsNullable as nullable, championsRecord as record } from './champions-club.js';
import { saasUuid } from './saas-billing.js';

export type SaasInvoiceKind = 'SUBSCRIPTION_PERIOD' | 'LIFETIME_PURCHASE';
export type SaasInvoiceStatus = 'DRAFT' | 'ISSUED' | 'VOID';
export type SaasTaxStatus = 'UNRESOLVED' | 'NO_TAX_APPLICABLE' | 'TAX_LINES';
export type SaasSettlementState = 'NOT_ISSUED' | 'VOID' | 'UNPAID' | 'PARTIALLY_PAID' | 'PAID_ATTESTED' | 'PAID_VERIFIED' | 'REVERSED';
export type SaasEvidenceKind = 'PAYMENT_RECEIVED' | 'REFUND' | 'CHARGEBACK';
export type SaasInvoiceLineKind = 'PLAN_FEE' | 'DISCOUNT' | 'CORRECTION' | 'TAX';
export const SAAS_INVOICE_STATUSES: readonly SaasInvoiceStatus[] = ['DRAFT','ISSUED','VOID'];

// ---------- inputs ----------
/** periodIndex is required for monthly subscriptions and must be null for a paid lifetime purchase. */
export interface SaasInvoiceDraftInput { subscriptionId: string; periodIndex: number | null }
export type SaasInvoiceCommand =
  | { action: 'ADD_ADJUSTMENT'; expectedVersion: number;
      adjustment: { kind: 'DISCOUNT' | 'CORRECTION'; amountMinor: number; description: string; reference: string | null } }
  /** Owner-recorded, verified tax treatment. There is no default: an invoice stays UNRESOLVED until this is recorded. */
  | { action: 'SET_TAX'; expectedVersion: number; treatment: 'NO_TAX_APPLICABLE' | 'TAX_LINES';
      taxLines: { jurisdiction: string; amountMinor: number }[]; verificationReference: string }
  | { action: 'ISSUE'; expectedVersion: number }
  | { action: 'VOID'; expectedVersion: number; reasonCode: 'ISSUED_IN_ERROR' | 'DUPLICATE' | 'SUPERSEDED' };
/** There is deliberately no `source` field: every entry recorded through HQ is HQ_ATTESTATION. */
export interface SaasPaymentEvidenceInput {
  kind: SaasEvidenceKind; amountMinor: number; occurredAt: string; reference: string;
  relatedEvidenceId: string | null; note: string | null;
}

// ---------- responses ----------
export interface SaasInvoiceSettlement {
  receivedMinor: number; refundedMinor: number; chargedBackMinor: number; netMinor: number; verifiedNetMinor: number;
  balanceMinor: number | null; state: SaasSettlementState;
}
export interface SaasInvoiceSummary {
  invoiceId: string; invoiceNumber: string | null; organizationId: string; organizationName: string; subscriptionId: string;
  kind: SaasInvoiceKind; periodIndex: number | null; servicePeriod: { startsAt: string; endsAt: string | null };
  planCode: 'CORE' | 'COMPLETE'; offerKind: 'REGULAR_MONTHLY' | 'FOUNDER_MONTHLY' | 'FOUNDER_LIFETIME'; description: string; currency: 'USD';
  status: SaasInvoiceStatus; version: number; subtotalMinor: number; taxStatus: SaasTaxStatus; taxMinor: number | null;
  taxVerificationReference: string | null; totalMinor: number | null; settlement: SaasInvoiceSettlement;
  delivery: 'NOT_SENT'; collection: 'DISABLED'; createdAt: string; issuedAt: string | null; voidedAt: string | null;
  voidReason: 'ISSUED_IN_ERROR' | 'DUPLICATE' | 'SUPERSEDED' | null; updatedAt: string;
}
export interface SaasInvoiceLine { lineNumber: number; lineKind: SaasInvoiceLineKind; description: string; amountMinor: number; reference: string | null }
export interface SaasPaymentEvidence {
  evidenceId: string; invoiceId: string; kind: SaasEvidenceKind; source: 'HQ_ATTESTATION'; providerVerified: false;
  amountMinor: number; currency: 'USD'; occurredAt: string; reference: string; relatedEvidenceId: string | null; note: string | null; recordedAt: string;
}
export interface SaasInvoiceDetail extends SaasInvoiceSummary { lines: SaasInvoiceLine[]; evidence: SaasPaymentEvidence[] }
export interface SaasInvoiceList { invoices: SaasInvoiceSummary[]; limit: 200; collection: 'DISABLED' }
export interface SaasInvoiceReceipt { invoice: SaasInvoiceDetail; replayed: boolean }
export interface SaasInvoiceCommandReceipt { invoice: SaasInvoiceDetail; action: SaasInvoiceCommand['action']; replayed: boolean }
export interface SaasPaymentEvidenceReceipt { evidence: SaasPaymentEvidence; invoice: SaasInvoiceSummary; replayed: boolean }
export interface SaasPaymentStandingFacts {
  firstPaidAt: string | null; paidThroughAt: string | null; lifetimePaid: boolean;
  paidInvoiceCount: number; refundedInvoiceCount: number; chargebackInvoiceCount: number;
}
/**
 * `verified` counts only provider-verified evidence (always empty until a provider exists) and is the only
 * strength Champions Club may ever consume. `recorded` adds HQ attestations and is for HQ bookkeeping only.
 */
export interface SaasPaymentStanding {
  organizationId: string; subscriptionId: string | null; verified: SaasPaymentStandingFacts; recorded: SaasPaymentStandingFacts;
  evidence: { hqAttested: number; providerVerified: number };
  championsPaymentSource: 'NOT_CONNECTED'; providerVerification: 'NOT_CONFIGURED';
}

// ---------- input validators ----------
const ISO_INPUT = /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const has = (list: readonly unknown[], value: unknown) => list.includes(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max && value.trim() === value;
const count = (v: unknown): v is number => isInt(v, 0, Number.MAX_SAFE_INTEGER);
const nts = (v: unknown) => v === null || isTimestamp(v);

export function validateSaasInvoiceStatusFilter(value: unknown): SaasInvoiceStatus | null {
  if (value === undefined) return null;
  if (!has(SAAS_INVOICE_STATUSES, value)) invalid();
  return value as SaasInvoiceStatus;
}
export function validateSaasInvoiceDraftInput(value: unknown): SaasInvoiceDraftInput {
  const input = record(value, invalid); exactKeys(input, ['subscriptionId','periodIndex'], invalid);
  if (input.periodIndex !== null && !isInt(input.periodIndex, 0, 9999)) invalid();
  return { subscriptionId: saasUuid(input.subscriptionId), periodIndex: input.periodIndex as number | null };
}
export function validateSaasInvoiceCommand(value: unknown): SaasInvoiceCommand {
  const input = record(value, invalid);
  if (!isInt(input.expectedVersion, 1, 999_999_999)) invalid();
  const expectedVersion = input.expectedVersion;
  switch (input.action) {
    case 'ADD_ADJUSTMENT': {
      exactKeys(input, ['action','expectedVersion','adjustment'], invalid);
      const a = record(input.adjustment, invalid); exactKeys(a, ['kind','amountMinor','description','reference'], invalid);
      if (!has(['DISCOUNT','CORRECTION'], a.kind) || !isInt(a.amountMinor, -100_000_000, 100_000_000) || a.amountMinor === 0
        || (a.kind === 'DISCOUNT' && (a.amountMinor as number) > 0) || !text(a.description, 300) || (a.reference !== null && !text(a.reference, 200))) invalid();
      return { action: 'ADD_ADJUSTMENT', expectedVersion,
        adjustment: { kind: a.kind as 'DISCOUNT' | 'CORRECTION', amountMinor: a.amountMinor as number, description: a.description as string, reference: a.reference as string | null } };
    }
    case 'SET_TAX': {
      exactKeys(input, ['action','expectedVersion','treatment','taxLines','verificationReference'], invalid);
      if (!has(['NO_TAX_APPLICABLE','TAX_LINES'], input.treatment) || !Array.isArray(input.taxLines) || !text(input.verificationReference, 200)) invalid();
      const lines = (input.taxLines as unknown[]).map(l => {
        const r = record(l, invalid); exactKeys(r, ['jurisdiction','amountMinor'], invalid);
        if (!text(r.jurisdiction, 120) || !isInt(r.amountMinor, 1, 99_999_999)) invalid();
        return { jurisdiction: r.jurisdiction as string, amountMinor: r.amountMinor as number };
      });
      if (input.treatment === 'NO_TAX_APPLICABLE' ? lines.length !== 0 : lines.length < 1 || lines.length > 5) invalid();
      return { action: 'SET_TAX', expectedVersion, treatment: input.treatment as 'NO_TAX_APPLICABLE' | 'TAX_LINES', taxLines: lines,
        verificationReference: input.verificationReference as string };
    }
    case 'ISSUE':
      exactKeys(input, ['action','expectedVersion'], invalid);
      return { action: 'ISSUE', expectedVersion };
    case 'VOID':
      exactKeys(input, ['action','expectedVersion','reasonCode'], invalid);
      if (!has(['ISSUED_IN_ERROR','DUPLICATE','SUPERSEDED'], input.reasonCode)) invalid();
      return { action: 'VOID', expectedVersion, reasonCode: input.reasonCode as 'ISSUED_IN_ERROR' | 'DUPLICATE' | 'SUPERSEDED' };
    default:
      return invalid();
  }
}
export function validateSaasPaymentEvidenceInput(value: unknown): SaasPaymentEvidenceInput {
  const input = record(value, invalid); exactKeys(input, ['kind','amountMinor','occurredAt','reference','relatedEvidenceId','note'], invalid);
  if (!has(['PAYMENT_RECEIVED','REFUND','CHARGEBACK'], input.kind) || !isInt(input.amountMinor, 1, 200_000_000)
    || typeof input.occurredAt !== 'string' || !ISO_INPUT.test(input.occurredAt) || !isTimestamp(input.occurredAt)
    || !text(input.reference, 200) || (input.note !== null && !text(input.note, 500))
    || (input.kind === 'PAYMENT_RECEIVED') !== (input.relatedEvidenceId === null)) invalid();
  return { kind: input.kind as SaasEvidenceKind, amountMinor: input.amountMinor as number, occurredAt: input.occurredAt, reference: input.reference as string,
    relatedEvidenceId: input.relatedEvidenceId === null ? null : saasUuid(input.relatedEvidenceId), note: input.note as string | null };
}

// ---------- response validators (closed; any drift fails) ----------
function validateSettlement(value: unknown, status: unknown, total: unknown): void {
  const s = record(value, drift);
  exactKeys(s, ['receivedMinor','refundedMinor','chargedBackMinor','netMinor','verifiedNetMinor','balanceMinor','state'], drift);
  if (!count(s.receivedMinor) || !count(s.refundedMinor) || !count(s.chargedBackMinor) || !isInt(s.netMinor, 0, Number.MAX_SAFE_INTEGER)
    || s.verifiedNetMinor !== 0 || s.state === 'PAID_VERIFIED'
    || !has(['NOT_ISSUED','VOID','UNPAID','PARTIALLY_PAID','PAID_ATTESTED','REVERSED'], s.state)
    || (status === 'ISSUED' ? !count(s.balanceMinor) || (s.balanceMinor as number) > (total as number) : s.balanceMinor !== null)
    || (status === 'DRAFT') !== (s.state === 'NOT_ISSUED') || (status === 'VOID') !== (s.state === 'VOID')) drift();
}
function validateEvidence(value: unknown): void {
  const e = record(value, drift);
  exactKeys(e, ['evidenceId','invoiceId','kind','source','providerVerified','amountMinor','currency','occurredAt','reference','relatedEvidenceId','note','recordedAt'], drift);
  if (!isUuid(e.evidenceId) || !isUuid(e.invoiceId) || !has(['PAYMENT_RECEIVED','REFUND','CHARGEBACK'], e.kind) || e.source !== 'HQ_ATTESTATION'
    || e.providerVerified !== false || !isInt(e.amountMinor, 1, 200_000_000) || e.currency !== 'USD' || !isTimestamp(e.occurredAt)
    || !text(e.reference, 200) || !nullable(e.relatedEvidenceId, isUuid) || (e.kind === 'PAYMENT_RECEIVED') !== (e.relatedEvidenceId === null)
    || !nullable(e.note, (v): v is string => text(v, 500)) || !isTimestamp(e.recordedAt)) drift();
}
const SUMMARY_KEYS = ['invoiceId','invoiceNumber','organizationId','organizationName','subscriptionId','kind','periodIndex','servicePeriod','planCode','offerKind',
  'description','currency','status','version','subtotalMinor','taxStatus','taxMinor','taxVerificationReference','totalMinor','settlement','delivery','collection',
  'createdAt','issuedAt','voidedAt','voidReason','updatedAt'];
function validateInvoice(value: unknown, detail: boolean): void {
  const i = record(value, drift); exactKeys(i, detail ? [...SUMMARY_KEYS, 'lines', 'evidence'] : SUMMARY_KEYS, drift);
  const period = i.kind === 'SUBSCRIPTION_PERIOD';
  if (!isUuid(i.invoiceId) || (i.invoiceNumber !== null && (typeof i.invoiceNumber !== 'string' || !/^HON-20\d{2}-\d{6}$/.test(i.invoiceNumber)))
    || !isUuid(i.organizationId) || !text(i.organizationName, 300) || !isUuid(i.subscriptionId) || !has(['SUBSCRIPTION_PERIOD','LIFETIME_PURCHASE'], i.kind)
    || (period ? !count(i.periodIndex) : i.periodIndex !== null) || !has(['CORE','COMPLETE'], i.planCode)
    || !has(['REGULAR_MONTHLY','FOUNDER_MONTHLY','FOUNDER_LIFETIME'], i.offerKind) || (i.offerKind === 'FOUNDER_LIFETIME') === period
    || !text(i.description, 300) || i.currency !== 'USD' || !has(SAAS_INVOICE_STATUSES, i.status) || !isInt(i.version, 1, 2147483647)
    || !isInt(i.subtotalMinor, 0, 100_000_000) || !has(['UNRESOLVED','NO_TAX_APPLICABLE','TAX_LINES'], i.taxStatus)
    || (i.taxStatus === 'UNRESOLVED' ? i.taxMinor !== null || i.totalMinor !== null || i.taxVerificationReference !== null
      : !isInt(i.taxMinor, 0, 100_000_000) || !text(i.taxVerificationReference, 200) || i.totalMinor !== (i.subtotalMinor as number) + (i.taxMinor as number)
        || (i.taxStatus === 'NO_TAX_APPLICABLE') !== (i.taxMinor === 0))
    || (i.status === 'ISSUED' && (i.invoiceNumber === null || i.taxStatus === 'UNRESOLVED' || !((i.totalMinor as number) > 0)))
    || (i.invoiceNumber === null) !== (i.issuedAt === null) || i.delivery !== 'NOT_SENT' || i.collection !== 'DISABLED'
    || !isTimestamp(i.createdAt) || !nts(i.issuedAt) || !nts(i.voidedAt) || (i.status === 'VOID') !== (i.voidedAt !== null)
    || (i.voidReason !== null && !has(['ISSUED_IN_ERROR','DUPLICATE','SUPERSEDED'], i.voidReason)) || (i.voidReason === null) !== (i.voidedAt === null)
    || !isTimestamp(i.updatedAt)) drift();
  const p = record(i.servicePeriod, drift); exactKeys(p, ['startsAt','endsAt'], drift);
  if (!isTimestamp(p.startsAt) || (period ? !isTimestamp(p.endsAt) : p.endsAt !== null)) drift();
  validateSettlement(i.settlement, i.status, i.totalMinor);
  if (detail) {
    if (!Array.isArray(i.lines) || i.lines.length < 1 || i.lines.length > 30 || !Array.isArray(i.evidence)) drift();
    (i.lines as unknown[]).forEach((l, n) => {
      const r = record(l, drift); exactKeys(r, ['lineNumber','lineKind','description','amountMinor','reference'], drift);
      if (r.lineNumber !== n + 1 || !has(['PLAN_FEE','DISCOUNT','CORRECTION','TAX'], r.lineKind) || (n === 0) !== (r.lineKind === 'PLAN_FEE')
        || !text(r.description, 300) || !isInt(r.amountMinor, -100_000_000, 100_000_000) || r.amountMinor === 0
        || !nullable(r.reference, (v): v is string => text(v, 200))) drift();
    });
    const lines = i.lines as SaasInvoiceLine[];
    if (lines.filter(l => l.lineKind !== 'TAX').reduce((t, l) => t + l.amountMinor, 0) !== i.subtotalMinor
      || lines.filter(l => l.lineKind === 'TAX').reduce((t, l) => t + l.amountMinor, 0) !== (i.taxMinor ?? 0)) drift();
    (i.evidence as unknown[]).forEach(validateEvidence);
  }
}
function validateFacts(value: unknown): void {
  const f = record(value, drift);
  exactKeys(f, ['firstPaidAt','paidThroughAt','lifetimePaid','paidInvoiceCount','refundedInvoiceCount','chargebackInvoiceCount'], drift);
  if (!nts(f.firstPaidAt) || !nts(f.paidThroughAt) || typeof f.lifetimePaid !== 'boolean' || !count(f.paidInvoiceCount)
    || !count(f.refundedInvoiceCount) || !count(f.chargebackInvoiceCount) || (f.paidInvoiceCount === 0) !== (f.firstPaidAt === null)) drift();
}

export function validateSaasInvoiceList(value: unknown): SaasInvoiceList {
  const r = record(value, drift); exactKeys(r, ['invoices','limit','collection'], drift);
  if (!Array.isArray(r.invoices) || r.invoices.length > 200 || r.limit !== 200 || r.collection !== 'DISABLED') drift();
  (r.invoices as unknown[]).forEach(i => validateInvoice(i, false));
  return r as unknown as SaasInvoiceList;
}
export function validateSaasInvoiceDetail(value: unknown): SaasInvoiceDetail {
  validateInvoice(value, true);
  return value as SaasInvoiceDetail;
}
export function validateSaasInvoiceReceipt(value: unknown): SaasInvoiceReceipt {
  const r = record(value, drift); exactKeys(r, ['invoice','replayed'], drift);
  validateInvoice(r.invoice, true);
  if ((r.invoice as SaasInvoiceDetail).status !== 'DRAFT' || typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasInvoiceReceipt;
}
export function validateSaasInvoiceCommandReceipt(value: unknown): SaasInvoiceCommandReceipt {
  const r = record(value, drift); exactKeys(r, ['invoice','action','replayed'], drift);
  validateInvoice(r.invoice, true);
  if (!has(['ADD_ADJUSTMENT','SET_TAX','ISSUE','VOID'], r.action) || typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasInvoiceCommandReceipt;
}
export function validateSaasPaymentEvidenceReceipt(value: unknown): SaasPaymentEvidenceReceipt {
  const r = record(value, drift); exactKeys(r, ['evidence','invoice','replayed'], drift);
  validateEvidence(r.evidence); validateInvoice(r.invoice, false);
  if ((r.invoice as SaasInvoiceSummary).status !== 'ISSUED' || typeof r.replayed !== 'boolean') drift();
  return r as unknown as SaasPaymentEvidenceReceipt;
}
export function validateSaasPaymentStanding(value: unknown): SaasPaymentStanding {
  const r = record(value, drift);
  exactKeys(r, ['organizationId','subscriptionId','verified','recorded','evidence','championsPaymentSource','providerVerification'], drift);
  if (!isUuid(r.organizationId) || !nullable(r.subscriptionId, isUuid) || r.championsPaymentSource !== 'NOT_CONNECTED'
    || r.providerVerification !== 'NOT_CONFIGURED') drift();
  validateFacts(r.verified); validateFacts(r.recorded);
  const v = r.verified as SaasPaymentStandingFacts;
  // Nothing can be provider-verified yet.
  if (v.paidInvoiceCount !== 0 || v.lifetimePaid || v.paidThroughAt !== null || v.refundedInvoiceCount !== 0 || v.chargebackInvoiceCount !== 0) drift();
  const e = record(r.evidence, drift); exactKeys(e, ['hqAttested','providerVerified'], drift);
  if (!count(e.hqAttested) || e.providerVerified !== 0) drift();
  return r as unknown as SaasPaymentStanding;
}
