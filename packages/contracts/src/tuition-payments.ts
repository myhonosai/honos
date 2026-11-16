/**
 * B-TUI-1 (0240): tuition payments the school received outside HON, recorded against issued invoices, and the school's
 * unpaid balances. HON moves no money: a record is evidence only, and a void is a correction, never a refund.
 */
export const TUITION_PAYMENT_METHODS = ['CASH', 'CHECK', 'CARD_TERMINAL', 'BANK_TRANSFER', 'OTHER'] as const;
export type TuitionPaymentMethod = (typeof TUITION_PAYMENT_METHODS)[number];
/** Methods a recorded payment can carry: the manual ones staff enter, plus PROVIDER (0337), written only by an autopay charge. */
export const TUITION_PAYMENT_RECORD_METHODS = [...TUITION_PAYMENT_METHODS, 'PROVIDER'] as const;
export type TuitionPaymentRecordMethod = (typeof TUITION_PAYMENT_RECORD_METHODS)[number];
export const RECEIVABLES_FILTERS = ['OPEN', 'OVERDUE'] as const;
export type ReceivablesFilter = (typeof RECEIVABLES_FILTERS)[number];
export const BALANCE_INVOICE_STATUSES = ['ISSUED', 'PAID', 'VOID', 'UNCOLLECTIBLE'] as const;
export type BalanceInvoiceStatus = (typeof BALANCE_INVOICE_STATUSES)[number];

export interface RecordTuitionPaymentInput {
  expectedInvoiceVersion: number; amountMinor: number; currency: string; receivedOn: string; method: TuitionPaymentMethod;
  reference?: string; note?: string;
}
export interface VoidTuitionPaymentInput { expectedInvoiceVersion: number; reason: string }
export interface ReceivablesQuery { filter: ReceivablesFilter; after?: string }

export interface TuitionPayment {
  paymentId: string; invoiceId: string; amountMinor: number; currency: string; receivedOn: string; method: TuitionPaymentRecordMethod;
  reference: string | null; note: string | null; recordedAt: string; void: { voidedAt: string; reason: string } | null;
}
export interface InvoiceBalance {
  invoiceId: string; billingAccountId: string; membershipId: string | null; payerName: string | null; status: BalanceInvoiceStatus;
  version: number; currency: string; totalMinor: number; paidMinor: number; balanceMinor: number; dueAt: string | null; overdue: boolean;
}
export interface TuitionPaymentReceipt { payment: TuitionPayment; invoice: InvoiceBalance }
export interface InvoicePayments { localToday: string; canRecord: boolean; invoice: InvoiceBalance; payments: TuitionPayment[] }
export interface ReceivablesTotal { currency: string; count: number; balanceMinor: number }
export interface SchoolReceivables {
  localToday: string; filter: ReceivablesFilter; canRecord: boolean; totals: ReceivablesTotal[]; items: InvoiceBalance[]; nextAfter: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^(20[0-9]{2}|2100)-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CURRENCY = /^[A-Z]{3}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_MINOR = 100_000_000;

function invalid(): never { throw new Error('Invalid tuition payment data.'); }
function record(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !keys.includes(key) && !optional.includes(key)) || keys.some(key => !(key in row))) invalid();
  return row;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value; }
function count(value: unknown, minimum: number, maximum = 999_999_999): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !DATE.test(value)) invalid();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid();
  return value;
}
function instant(value: unknown): string {
  if (typeof value !== 'string' || !INSTANT.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
function text(value: unknown, maximum = 1000): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || value.trim() !== value || CONTROL.test(value)) invalid();
  return value;
}
function currency(value: unknown): string { if (typeof value !== 'string' || !CURRENCY.test(value)) invalid(); return value; }
function nullable<T>(value: unknown, read: (value: unknown) => T): T | null { return value === null ? null : read(value); }
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(); return value as T; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }

// Input validators (the database validates the same rules again).
export function validateRecordTuitionPaymentInput(value: unknown): RecordTuitionPaymentInput {
  const row = record(value, ['expectedInvoiceVersion', 'amountMinor', 'currency', 'receivedOn', 'method'], ['reference', 'note']);
  const input: RecordTuitionPaymentInput = {
    expectedInvoiceVersion: count(row.expectedInvoiceVersion, 1), amountMinor: count(row.amountMinor, 1, MAX_MINOR), currency: currency(row.currency),
    receivedOn: date(row.receivedOn), method: oneOf(row.method, TUITION_PAYMENT_METHODS),
  };
  if ('reference' in row) input.reference = text(row.reference, 120);
  if ('note' in row) input.note = text(row.note);
  return input;
}
export function validateVoidTuitionPaymentInput(value: unknown): VoidTuitionPaymentInput {
  const row = record(value, ['expectedInvoiceVersion', 'reason']);
  return { expectedInvoiceVersion: count(row.expectedInvoiceVersion, 1), reason: text(row.reason) };
}
export function validateReceivablesQuery(value: unknown): ReceivablesQuery {
  const row = record(value, ['filter'], ['after']);
  const query: ReceivablesQuery = { filter: oneOf(row.filter, RECEIVABLES_FILTERS) };
  if ('after' in row) query.after = uuid(row.after).toLowerCase();
  return query;
}

// Output verifiers: every database response is checked strictly before it reaches a client.
export function verifyTuitionPayment(value: unknown, invoiceId?: string): TuitionPayment {
  const row = record(value, ['paymentId', 'invoiceId', 'amountMinor', 'currency', 'receivedOn', 'method', 'reference', 'note', 'recordedAt', 'void']);
  const payment: TuitionPayment = {
    paymentId: uuid(row.paymentId), invoiceId: uuid(row.invoiceId), amountMinor: count(row.amountMinor, 1, MAX_MINOR), currency: currency(row.currency),
    receivedOn: date(row.receivedOn), method: oneOf(row.method, TUITION_PAYMENT_RECORD_METHODS), reference: nullable(row.reference, v => text(v, 120)),
    note: nullable(row.note, v => text(v)), recordedAt: instant(row.recordedAt),
    void: nullable(row.void, v => { const x = record(v, ['voidedAt', 'reason']); return { voidedAt: instant(x.voidedAt), reason: text(x.reason) }; }),
  };
  if (invoiceId !== undefined && payment.invoiceId !== invoiceId.toLowerCase()) invalid();
  return payment;
}
export function verifyInvoiceBalance(value: unknown, invoiceId?: string): InvoiceBalance {
  const row = record(value, ['invoiceId', 'billingAccountId', 'membershipId', 'payerName', 'status', 'version', 'currency', 'totalMinor', 'paidMinor', 'balanceMinor', 'dueAt', 'overdue']);
  const balance: InvoiceBalance = {
    invoiceId: uuid(row.invoiceId), billingAccountId: uuid(row.billingAccountId), membershipId: nullable(row.membershipId, uuid),
    payerName: nullable(row.payerName, v => text(v, 200)), status: oneOf(row.status, BALANCE_INVOICE_STATUSES), version: count(row.version, 1),
    currency: currency(row.currency), totalMinor: count(row.totalMinor, 0, 2_147_483_647), paidMinor: count(row.paidMinor, 0, 2_147_483_647),
    balanceMinor: count(row.balanceMinor, 0, 2_147_483_647), dueAt: nullable(row.dueAt, instant), overdue: bool(row.overdue),
  };
  // A PAID invoice owes nothing (an invoice marked paid before 0240 has no recorded payments); otherwise the balance is
  // what the unvoided records leave unpaid.
  if (balance.paidMinor > balance.totalMinor || balance.balanceMinor !== (balance.status === 'PAID' ? 0 : balance.totalMinor - balance.paidMinor)
    || (balance.overdue && (balance.status !== 'ISSUED' || balance.dueAt === null || balance.balanceMinor === 0))) invalid();
  if (invoiceId !== undefined && balance.invoiceId !== invoiceId.toLowerCase()) invalid();
  return balance;
}
export function verifyTuitionPaymentReceipt(value: unknown, expect: { invoiceId?: string; paymentId?: string; voided: boolean }): TuitionPaymentReceipt {
  const row = record(value, ['payment', 'invoice']);
  const invoice = verifyInvoiceBalance(row.invoice, expect.invoiceId);
  const payment = verifyTuitionPayment(row.payment, invoice.invoiceId);
  if ((payment.void !== null) !== expect.voided || (expect.paymentId !== undefined && payment.paymentId !== expect.paymentId.toLowerCase())
    || payment.currency !== invoice.currency || !['ISSUED', 'PAID'].includes(invoice.status)) invalid();
  return { payment, invoice };
}
export function verifyInvoicePayments(value: unknown, invoiceId: string): InvoicePayments {
  const row = record(value, ['localToday', 'canRecord', 'invoice', 'payments']);
  if (!Array.isArray(row.payments) || row.payments.length > 100) invalid();
  const invoice = verifyInvoiceBalance(row.invoice, invoiceId);
  const payments = row.payments.map(entry => verifyTuitionPayment(entry, invoiceId));
  if (new Set(payments.map(p => p.paymentId.toLowerCase())).size !== payments.length) invalid();
  return { localToday: date(row.localToday), canRecord: bool(row.canRecord), invoice, payments };
}
export function verifySchoolReceivables(value: unknown, query: ReceivablesQuery): SchoolReceivables {
  const row = record(value, ['localToday', 'filter', 'canRecord', 'totals', 'items', 'nextAfter']);
  if (!Array.isArray(row.totals) || row.totals.length > 50 || !Array.isArray(row.items) || row.items.length > 50) invalid();
  const filter = oneOf(row.filter, RECEIVABLES_FILTERS);
  const items = row.items.map(entry => verifyInvoiceBalance(entry));
  const totals = row.totals.map(entry => { const t = record(entry, ['currency', 'count', 'balanceMinor']);
    return { currency: currency(t.currency), count: count(t.count, 1), balanceMinor: count(t.balanceMinor, 1, Number.MAX_SAFE_INTEGER) }; });
  const nextAfter = nullable(row.nextAfter, uuid);
  const ids = items.map(i => i.invoiceId.toLowerCase());
  if (filter !== query.filter || new Set(ids).size !== ids.length || ids.some((id, n) => n > 0 && id <= ids[n - 1]!)
    || (query.after !== undefined && ids.some(id => id <= query.after!))
    || items.some(i => i.status !== 'ISSUED' || i.balanceMinor === 0 || (filter === 'OVERDUE' && !i.overdue))
    || (nextAfter !== null && (items.length !== 50 || nextAfter.toLowerCase() !== ids[49]))
    || new Set(totals.map(t => t.currency)).size !== totals.length) invalid();
  return { localToday: date(row.localToday), filter, canRecord: bool(row.canRecord), totals, items, nextAfter };
}

/** B-TUI-1b (0280): the current school's invoice list, every status or one, newest first, 50 per page. */
export const SCHOOL_INVOICE_LIST_STATUSES = ['ALL', 'DRAFT', 'ISSUED', 'PAID', 'VOID', 'UNCOLLECTIBLE'] as const;
export type SchoolInvoiceListStatus = (typeof SCHOOL_INVOICE_LIST_STATUSES)[number];
export const LISTED_INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'PAID', 'VOID', 'UNCOLLECTIBLE'] as const;
export type ListedInvoiceStatus = (typeof LISTED_INVOICE_STATUSES)[number];
export interface SchoolInvoiceListQuery { status: SchoolInvoiceListStatus; after?: string }
export interface ListedInvoice extends Omit<InvoiceBalance, 'status'> { status: ListedInvoiceStatus; createdAt: string }
export interface SchoolInvoiceList {
  localToday: string; timezone: string; status: SchoolInvoiceListStatus; canIssue: boolean; canRecord: boolean; items: ListedInvoice[]; nextAfter: string | null;
}

export function validateSchoolInvoiceListQuery(value: unknown): SchoolInvoiceListQuery {
  const row = record(value, ['status'], ['after']);
  const query: SchoolInvoiceListQuery = { status: oneOf(row.status, SCHOOL_INVOICE_LIST_STATUSES) };
  if ('after' in row) query.after = uuid(row.after).toLowerCase();
  return query;
}
export function verifyListedInvoice(value: unknown): ListedInvoice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const { createdAt, status, ...rest } = value as Record<string, unknown>;
  const listed = oneOf(status, LISTED_INVOICE_STATUSES);
  // A DRAFT has no payments and nothing owed yet; every other status reads exactly like a balance row.
  const balance = verifyInvoiceBalance({ ...rest, status: listed === 'DRAFT' ? 'ISSUED' : listed });
  if (listed === 'DRAFT' && (balance.paidMinor !== 0 || balance.overdue)) invalid();
  return { ...balance, status: listed, createdAt: instant(createdAt) };
}
export function verifySchoolInvoiceList(value: unknown, query: SchoolInvoiceListQuery): SchoolInvoiceList {
  const row = record(value, ['localToday', 'timezone', 'status', 'canIssue', 'canRecord', 'items', 'nextAfter']);
  if (!Array.isArray(row.items) || row.items.length > 50) invalid();
  const status = oneOf(row.status, SCHOOL_INVOICE_LIST_STATUSES);
  const items = row.items.map(entry => verifyListedInvoice(entry));
  const nextAfter = nullable(row.nextAfter, uuid);
  const ids = items.map(i => i.invoiceId.toLowerCase());
  // createdAt is shown to the millisecond while the server orders by the full timestamp, so equal values may come in any id order.
  const newestFirst = items.every((item, n) => n === 0 || item.createdAt <= items[n - 1]!.createdAt);
  if (status !== query.status || new Set(ids).size !== ids.length || !newestFirst
    || (query.after !== undefined && ids.includes(query.after))
    || (status !== 'ALL' && items.some(i => i.status !== status))
    || (nextAfter !== null && (items.length !== 50 || nextAfter.toLowerCase() !== ids[49]))) invalid();
  return { localToday: date(row.localToday), timezone: text(row.timezone, 100), status, canIssue: bool(row.canIssue), canRecord: bool(row.canRecord), items, nextAfter };
}
