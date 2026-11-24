/**
 * SI1 (0558): the simple staff invoice. Staff pick who pays, list items with prices, and the total is their sum. The
 * invoice shows who it is from, how to pay, and can be printed, emailed or texted (through the existing message
 * commands). Creating an invoice moves no money.
 */
import { verifyListedInvoice, type ListedInvoice } from './tuition-payments.js';

export const SIMPLE_INVOICE_MAX_ITEMS = 30;
export const SIMPLE_INVOICE_MAX_QUANTITY = 1000;
export const SIMPLE_INVOICE_MAX_UNIT_MINOR = 100_000_000;
export const SIMPLE_INVOICE_MAX_TOTAL_MINOR = 2_147_483_647;

export interface SimpleInvoiceItemInput { description: string; quantity: number; unitAmountMinor: number }
export interface CreateSimpleInvoiceInput {
  billingAccountId: string; dueDate: string; items: SimpleInvoiceItemInput[]; issue: boolean;
  payToPhone?: string; payToEmail?: string; otherWaysToPay?: string; note?: string;
}
export interface InvoiceDetailItem { position: number; description: string; quantity: number; unitAmountMinor: number; amountMinor: number }
export interface InvoiceDetail {
  invoice: ListedInvoice;
  /** A short reference people can read out: the first eight characters of the invoice id, upper case. */
  number: string;
  localToday: string; timezone: string; canIssue: boolean;
  /** Empty for invoices made before 0558 (one amount, no items). */
  items: InvoiceDetailItem[];
  note: string | null;
  billTo: { personId: string | null; name: string | null; email: string | null; phone: string | null };
  from: { schoolName: string; addressLines: string[]; phone: string | null; email: string | null };
  howToPay: { inApp: boolean; otherWays: string | null };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^(20[0-9]{2}|2100)-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{1,63}$/;
const PHONE = /^[0-9+()\-. ]{3,40}$/;

function invalid(): never { throw new Error('Invalid simple invoice data.'); }
function record(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !keys.includes(key) && !optional.includes(key)) || keys.some(key => !(key in row))) invalid();
  return row;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value; }
function int(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || value.trim() !== value || CONTROL.test(value)) invalid();
  return value;
}
/** Free text that may span lines (note, other ways to pay): only tab and newline are allowed among control characters. */
function prose(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || value.trim() !== value
    || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) invalid();
  return value;
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !DATE.test(value)) invalid();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid();
  return value;
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function nullable<T>(value: unknown, read: (value: unknown) => T): T | null { return value === null ? null : read(value); }
function email(value: unknown): string { const v = text(value, 200); if (!EMAIL.test(v)) invalid(); return v; }
function phone(value: unknown): string { const v = text(value, 40); if (!PHONE.test(v) || !/[0-9]/.test(v)) invalid(); return v; }

/** Local and server rules for the create command (the database checks the same again). */
export function validateCreateSimpleInvoiceInput(value: unknown): CreateSimpleInvoiceInput {
  const row = record(value, ['billingAccountId', 'dueDate', 'items', 'issue'], ['payToPhone', 'payToEmail', 'otherWaysToPay', 'note']);
  if (!Array.isArray(row.items) || row.items.length < 1 || row.items.length > SIMPLE_INVOICE_MAX_ITEMS) invalid();
  const items = row.items.map(entry => {
    const item = record(entry, ['description', 'quantity', 'unitAmountMinor']);
    return { description: text(item.description, 200), quantity: int(item.quantity, 1, SIMPLE_INVOICE_MAX_QUANTITY),
      unitAmountMinor: int(item.unitAmountMinor, 0, SIMPLE_INVOICE_MAX_UNIT_MINOR) };
  });
  const total = items.reduce((sum, item) => sum + item.quantity * item.unitAmountMinor, 0);
  if (total < 1 || total > SIMPLE_INVOICE_MAX_TOTAL_MINOR) invalid();
  const input: CreateSimpleInvoiceInput = { billingAccountId: uuid(row.billingAccountId).toLowerCase(), dueDate: date(row.dueDate), items, issue: bool(row.issue) };
  if ('payToPhone' in row) input.payToPhone = phone(row.payToPhone);
  if ('payToEmail' in row) input.payToEmail = email(row.payToEmail);
  if ('otherWaysToPay' in row) input.otherWaysToPay = prose(row.otherWaysToPay, 500);
  if ('note' in row) input.note = prose(row.note, 1000);
  return input;
}

/** The total the server will store for these items (sum of quantity x price), or null when out of range. */
export function simpleInvoiceTotal(items: readonly Pick<SimpleInvoiceItemInput, 'quantity' | 'unitAmountMinor'>[]): number | null {
  let total = 0;
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || !Number.isInteger(item.unitAmountMinor) || item.quantity < 1 || item.unitAmountMinor < 0) return null;
    total += item.quantity * item.unitAmountMinor;
  }
  return total > SIMPLE_INVOICE_MAX_TOTAL_MINOR ? null : total;
}

export function verifyInvoiceDetail(value: unknown, invoiceId?: string): InvoiceDetail {
  const row = record(value, ['invoice', 'number', 'localToday', 'timezone', 'canIssue', 'items', 'note', 'billTo', 'from', 'howToPay']);
  const invoice = verifyListedInvoice(row.invoice);
  if (invoiceId !== undefined && invoice.invoiceId.toLowerCase() !== invoiceId.toLowerCase()) invalid();
  if (!Array.isArray(row.items) || row.items.length > SIMPLE_INVOICE_MAX_ITEMS) invalid();
  const items = row.items.map((entry, n) => {
    const item = record(entry, ['position', 'description', 'quantity', 'unitAmountMinor', 'amountMinor']);
    const parsed: InvoiceDetailItem = { position: int(item.position, 1, SIMPLE_INVOICE_MAX_ITEMS), description: text(item.description, 200),
      quantity: int(item.quantity, 1, SIMPLE_INVOICE_MAX_QUANTITY), unitAmountMinor: int(item.unitAmountMinor, 0, SIMPLE_INVOICE_MAX_UNIT_MINOR),
      amountMinor: int(item.amountMinor, 0, SIMPLE_INVOICE_MAX_TOTAL_MINOR) };
    if (parsed.position !== n + 1 || parsed.amountMinor !== parsed.quantity * parsed.unitAmountMinor) invalid();
    return parsed;
  });
  if (items.length > 0 && items.reduce((sum, item) => sum + item.amountMinor, 0) !== invoice.totalMinor) invalid();
  const number = text(row.number, 8);
  if (!/^[0-9A-F]{8}$/.test(number) || number !== invoice.invoiceId.slice(0, 8).toUpperCase()) invalid();
  const billTo = record(row.billTo, ['personId', 'name', 'email', 'phone']);
  const from = record(row.from, ['schoolName', 'addressLines', 'phone', 'email']);
  if (!Array.isArray(from.addressLines) || from.addressLines.length > 4) invalid();
  const howToPay = record(row.howToPay, ['inApp', 'otherWays']);
  return {
    invoice, number, localToday: date(row.localToday), timezone: text(row.timezone, 100), canIssue: bool(row.canIssue), items,
    note: nullable(row.note, v => prose(v, 1000)),
    billTo: { personId: nullable(billTo.personId, uuid), name: nullable(billTo.name, v => text(v, 200)),
      email: nullable(billTo.email, v => text(v, 320)), phone: nullable(billTo.phone, v => text(v, 40)) },
    from: { schoolName: text(from.schoolName, 200), addressLines: from.addressLines.map(line => text(line, 300)),
      phone: nullable(from.phone, phone), email: nullable(from.email, email) },
    howToPay: { inApp: bool(howToPay.inApp), otherWays: nullable(howToPay.otherWays, v => prose(v, 500)) },
  };
}

/** The create answer: the new invoice, exactly as asked (DRAFT, or ISSUED when issue was asked). */
export function verifySimpleInvoiceReceipt(value: unknown, input: CreateSimpleInvoiceInput): InvoiceDetail {
  const detail = verifyInvoiceDetail(value);
  const expected = simpleInvoiceTotal(input.items);
  if (detail.invoice.status !== (input.issue ? 'ISSUED' : 'DRAFT') || detail.invoice.version !== (input.issue ? 2 : 1)
    || detail.invoice.billingAccountId.toLowerCase() !== input.billingAccountId.toLowerCase()
    || detail.invoice.totalMinor !== expected || detail.invoice.paidMinor !== 0 || detail.items.length !== input.items.length
    || detail.items.some((item, n) => item.description !== input.items[n]!.description || item.quantity !== input.items[n]!.quantity
      || item.unitAmountMinor !== input.items[n]!.unitAmountMinor)
    || detail.note !== (input.note ?? null) || detail.howToPay.otherWays !== (input.otherWaysToPay ?? null)
    || detail.from.phone !== (input.payToPhone ?? null) || detail.from.email !== (input.payToEmail ?? null)) invalid();
  return detail;
}
