/**
 * SI1 (0558) form math and message text for the simple staff invoice (docs/architecture/SIMPLE_INVOICES.md). Pure: no
 * requests. The server computes and stores the same total again; this only shows it while staff type.
 */
import { SIMPLE_INVOICE_MAX_ITEMS, simpleInvoiceTotal, validateCreateSimpleInvoiceInput, type CreateSimpleInvoiceInput, type InvoiceDetail } from '@hon/contracts';
import { amountToMinor, formatMinor } from '../invoice-pickers';
import { schoolDay } from '../invoice-list/invoice-list';

/** One item row as typed: quantity and price are the text in the boxes. */
export type ItemRow = Readonly<{ rowId: string; description: string; quantity: string; price: string }>;
export type InvoiceForm = Readonly<{
  items: readonly ItemRow[]; dueDate: string; payToPhone: string; payToEmail: string; otherWaysToPay: string; note: string;
}>;

let rowSeq = 0;
export function newItemRow(): ItemRow { rowSeq += 1; return { rowId: `item-${rowSeq}`, description: '', quantity: '1', price: '' }; }
export function emptyForm(dueDate: string): InvoiceForm {
  return { items: [newItemRow()], dueDate, payToPhone: '', payToEmail: '', otherWaysToPay: '', note: '' };
}
export function addItemRow(form: InvoiceForm): InvoiceForm {
  return form.items.length >= SIMPLE_INVOICE_MAX_ITEMS ? form : { ...form, items: [...form.items, newItemRow()] };
}
export function removeItemRow(form: InvoiceForm, rowId: string): InvoiceForm {
  return form.items.length <= 1 ? form : { ...form, items: form.items.filter((row) => row.rowId !== rowId) };
}
export function updateItemRow(form: InvoiceForm, rowId: string, change: Partial<Omit<ItemRow, 'rowId'>>): InvoiceForm {
  return { ...form, items: form.items.map((row) => (row.rowId === rowId ? { ...row, ...change } : row)) };
}

/** A whole number of 1 to 1000, or null. */
export function parseQuantity(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,4}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 1000 ? n : null;
}
/** The price in minor units (0 allowed, for a free item), or null when it is not an amount in this currency. */
export function parsePrice(text: string, currency: string): number | null {
  const t = text.trim().replace(/^\$/, '').replaceAll(',', '');
  if (!t) return null;
  const minor = amountToMinor(t, currency, 100_000_000);
  return minor === null ? null : Number(minor);
}
/** The line total, or null while the row is incomplete. */
export function lineTotal(row: ItemRow, currency: string): number | null {
  const q = parseQuantity(row.quantity), p = parsePrice(row.price, currency);
  return q === null || p === null ? null : q * p;
}
/** The invoice total from complete rows, or null when any row is incomplete or the sum is out of range. */
export function formTotal(form: InvoiceForm, currency: string): number | null {
  const items = form.items.map((row) => ({ quantity: parseQuantity(row.quantity), unitAmountMinor: parsePrice(row.price, currency) }));
  if (items.some((i) => i.quantity === null || i.unitAmountMinor === null)) return null;
  return simpleInvoiceTotal(items as { quantity: number; unitAmountMinor: number }[]);
}

export type FormProblem = 'ITEM_DESCRIPTION' | 'ITEM_QUANTITY' | 'ITEM_PRICE' | 'TOTAL' | 'DUE_DATE' | 'PHONE' | 'EMAIL' | 'TEXT';
export const FORM_PROBLEM_TEXT: Readonly<Record<FormProblem, string>> = {
  ITEM_DESCRIPTION: 'Every item needs a description (up to 200 characters).',
  ITEM_QUANTITY: 'Quantity must be a whole number from 1 to 1000.',
  ITEM_PRICE: 'Enter each price as an amount, for example 49.50.',
  TOTAL: 'The total must be more than zero and no more than the largest invoice amount.',
  DUE_DATE: 'Pick a due date.',
  PHONE: 'The pay-to phone can use digits, spaces, + ( ) - and dots.',
  EMAIL: 'The pay-to email does not look like an email address.',
  TEXT: 'Other ways to pay or the note is too long or has characters that cannot be saved.',
};

/** The create command for this form, or the first problem to fix. Blank optional boxes are left out. */
export function buildCreateInput(form: InvoiceForm, billingAccountId: string, currency: string, issue: boolean):
  { ok: true; input: CreateSimpleInvoiceInput } | { ok: false; problem: FormProblem } {
  const items = [];
  for (const row of form.items) {
    const description = row.description.trim();
    if (!description || description.length > 200) return { ok: false, problem: 'ITEM_DESCRIPTION' };
    const quantity = parseQuantity(row.quantity);
    if (quantity === null) return { ok: false, problem: 'ITEM_QUANTITY' };
    const unitAmountMinor = parsePrice(row.price, currency);
    if (unitAmountMinor === null) return { ok: false, problem: 'ITEM_PRICE' };
    items.push({ description, quantity, unitAmountMinor });
  }
  const total = simpleInvoiceTotal(items);
  if (total === null || total < 1) return { ok: false, problem: 'TOTAL' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.dueDate)) return { ok: false, problem: 'DUE_DATE' };
  const raw: Record<string, unknown> = { billingAccountId, dueDate: form.dueDate, items, issue };
  const phone = form.payToPhone.trim(), email = form.payToEmail.trim(), other = form.otherWaysToPay.trim(), note = form.note.trim();
  if (phone) raw.payToPhone = phone;
  if (email) raw.payToEmail = email;
  if (other) raw.otherWaysToPay = other;
  if (note) raw.note = note;
  try { return { ok: true, input: validateCreateSimpleInvoiceInput(raw) }; } catch {
    const without = (key: string) => { const copy = { ...raw }; delete copy[key]; return copy; };
    const passes = (value: Record<string, unknown>) => { try { validateCreateSimpleInvoiceInput(value); return true; } catch { return false; } };
    if (phone && passes(without('payToPhone'))) return { ok: false, problem: 'PHONE' };
    if (email && passes(without('payToEmail'))) return { ok: false, problem: 'EMAIL' };
    if (!passes({ billingAccountId, dueDate: form.dueDate, items, issue })) return { ok: false, problem: 'DUE_DATE' };
    return { ok: false, problem: 'TEXT' };
  }
}

/** The school calendar day of an instant as YYYY-MM-DD. */
export function schoolDate(instant: string, zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch { return instant.slice(0, 10); }
}
/** A school calendar day plus some days (for the default due date). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type InvoiceLine = Readonly<{ description: string; quantity: number; unitAmountMinor: number; amountMinor: number }>;
/** The lines to show: the saved items, or one "Invoice amount" line for an invoice made before 0558. */
export function invoiceLines(detail: InvoiceDetail): readonly InvoiceLine[] {
  if (detail.items.length > 0) return detail.items;
  return [{ description: 'Invoice amount', quantity: 1, unitAmountMinor: detail.invoice.totalMinor, amountMinor: detail.invoice.totalMinor }];
}

/**
 * The email or text to the payer. Plain text only; the server stores it as a message DRAFT and checks consent when it is
 * queued. A text keeps to the total, balance, due date and how to pay; an email also lists the items and the note.
 */
export function invoiceMessage(detail: InvoiceDetail, channel: 'SMS' | 'EMAIL', parentAppUrl: string | null): string {
  const { invoice, from, howToPay } = detail;
  const money = (minor: number) => formatMinor(minor, invoice.currency);
  const due = invoice.dueAt ? schoolDay(invoice.dueAt, detail.timezone) : null;
  const hello = detail.billTo.name ? `Hi ${detail.billTo.name.split(' ')[0]},` : 'Hello,';
  const pay: string[] = [];
  if (howToPay.inApp && parentAppUrl) pay.push(`Pay online in the HON parent app: ${parentAppUrl}`);
  if (howToPay.otherWays) pay.push(channel === 'SMS' ? `Other ways to pay: ${howToPay.otherWays.replace(/\s*\n\s*/g, '; ')}` : `Other ways to pay:\n${howToPay.otherWays}`);
  const contact = [from.phone, from.email].filter(Boolean).join(' · ');
  if (channel === 'SMS') {
    return [`${from.schoolName}: invoice ${detail.number} for ${money(invoice.totalMinor)}.`,
      `Balance due ${money(invoice.balanceMinor)}${due ? ` by ${due}` : ''}.`, ...pay, contact ? `Questions: ${contact}` : null]
      .filter(Boolean).join(' ').slice(0, 1000);
  }
  const lines = invoiceLines(detail).map((l) => `- ${l.description}${l.quantity > 1 ? ` (${l.quantity} x ${money(l.unitAmountMinor)})` : ''}: ${money(l.amountMinor)}`);
  return [hello, '', `Here is invoice ${detail.number} from ${from.schoolName}.`, '', ...lines, '',
    `Total: ${money(invoice.totalMinor)}`, ...(invoice.paidMinor > 0 ? [`Paid: ${money(invoice.paidMinor)}`] : []),
    `Balance due: ${money(invoice.balanceMinor)}${due ? ` by ${due}` : ''}`, '', ...(pay.length ? [...pay, ''] : []),
    ...(detail.note ? [detail.note, ''] : []), contact ? `Questions? ${contact}` : null, `Thank you,`, from.schoolName]
    .filter((line) => line !== null).join('\n').slice(0, 4000);
}
