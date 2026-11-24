/**
 * Parent invoice payment (0530). A signed-in guardian pays the open balance of one of their family's ISSUED invoices
 * from the HON Family app on the school's own processor page (the shared one-time payment, 0529). TEST mode only; HON
 * adds no fee. The app names an invoice it read here and nothing else: no payment, school, family, amount or provider.
 */

/** What the parent sees about a family payment of an invoice: none yet, open on the processor page, still clearing, paid. */
export const PARENT_INVOICE_PAY_STATES = ['NONE', 'OPEN', 'PROCESSING', 'SUCCEEDED'] as const;
export type ParentInvoicePayState = (typeof PARENT_INVOICE_PAY_STATES)[number];
/** The answer after the processor page closes (the processor's own answer, recorded by HON). */
export const PARENT_INVOICE_PAY_OUTCOMES = ['NONE', 'OPEN', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELED'] as const;
export type ParentInvoicePayOutcome = (typeof PARENT_INVOICE_PAY_OUTCOMES)[number];

export interface ParentPayableInvoice {
  invoiceId: string;
  childName: string;
  currency: string;
  totalMinor: number;
  balanceMinor: number;
  dueAt: string | null;
  payState: ParentInvoicePayState;
  /** The parent can press Pay now (school takes card payments here, balance due, nothing else in progress). */
  payable: boolean;
}
export interface ParentInvoicePayments {
  /** The school can take a card payment through the app now. */
  canPay: boolean;
  /** Always true until live payments are approved: the app says no real money moves. */
  testMode: true;
  invoices: ParentPayableInvoice[];
}
/** Start: the processor's own hosted page to open, or the payment's state when it no longer needs a page. */
export type ParentInvoicePayStart =
  | { state: 'OPEN'; url: string; expiresAt: string; amountMinor: number; currency: string }
  | { state: 'PROCESSING' | 'SUCCEEDED'; url: null; expiresAt: null; amountMinor: number; currency: string };
export interface ParentInvoicePayResult { state: ParentInvoicePayOutcome }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function invalid(): never { throw new Error('Invalid parent invoice payment data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
function oneOf<const T extends readonly string[]>(value: unknown, options: T): T[number] {
  if (typeof value !== 'string' || !options.includes(value)) invalid();
  return value as T[number];
}
function minor(value: unknown, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > 5_000_000_000) invalid();
  return value as number;
}
function instant(value: unknown): string {
  if (typeof value !== 'string' || !INSTANT.test(value) || !Number.isFinite(Date.parse(value))) invalid();
  return value;
}
function currency(value: unknown): string { if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) invalid(); return value; }

export function validateParentInvoiceId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
  return value;
}

export function verifyParentInvoicePayments(value: unknown): ParentInvoicePayments {
  const row = record(value, ['canPay', 'testMode', 'invoices']);
  if (typeof row.canPay !== 'boolean' || row.testMode !== true || !Array.isArray(row.invoices) || row.invoices.length > 50) invalid();
  const seen = new Set<string>();
  const invoices = row.invoices.map((item): ParentPayableInvoice => {
    const x = record(item, ['invoiceId', 'childName', 'currency', 'totalMinor', 'balanceMinor', 'dueAt', 'payState', 'payable']);
    const invoiceId = validateParentInvoiceId(x.invoiceId);
    if (seen.has(invoiceId)) invalid();
    seen.add(invoiceId);
    if (typeof x.childName !== 'string' || !x.childName.trim() || x.childName.length > 200 || CONTROL.test(x.childName) || typeof x.payable !== 'boolean') invalid();
    const totalMinor = minor(x.totalMinor), balanceMinor = minor(x.balanceMinor);
    const payState = oneOf(x.payState, PARENT_INVOICE_PAY_STATES);
    if (balanceMinor > totalMinor || (x.payable && (!row.canPay || balanceMinor < 1 || !['NONE', 'OPEN'].includes(payState)))) invalid();
    return { invoiceId, childName: x.childName, currency: currency(x.currency), totalMinor, balanceMinor,
      dueAt: x.dueAt === null ? null : instant(x.dueAt), payState, payable: x.payable };
  });
  return { canPay: row.canPay, testMode: true, invoices };
}

export function verifyParentInvoicePayStart(value: unknown): ParentInvoicePayStart {
  const row = record(value, ['state', 'url', 'expiresAt', 'amountMinor', 'currency']);
  const state = oneOf(row.state, ['OPEN', 'PROCESSING', 'SUCCEEDED'] as const);
  const amountMinor = minor(row.amountMinor, 1), cur = currency(row.currency);
  if (state === 'OPEN') {
    if (typeof row.url !== 'string' || row.url.length > 2000 || !/^https:\/\/[^\s]+$/.test(row.url)) invalid();
    return { state, url: row.url, expiresAt: instant(row.expiresAt), amountMinor, currency: cur };
  }
  if (row.url !== null || row.expiresAt !== null) invalid();
  return { state, url: null, expiresAt: null, amountMinor, currency: cur };
}

export function verifyParentInvoicePayResult(value: unknown): ParentInvoicePayResult {
  const row = record(value, ['state']);
  return { state: oneOf(row.state, PARENT_INVOICE_PAY_OUTCOMES) };
}
