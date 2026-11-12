/**
 * B-TUI-2 piece 9a (0269): per-school customizable checkout page settings (enrollment and tuition). Plans shown and their
 * order, add-ons, custom questions, an optional waiver, receipt and thank-you text, each in English with optional Korean
 * and Spanish. Branding comes from the shared school branding (booking feature), not from here. HON adds no fee.
 * The database validates every rule here again.
 */
export const CHECKOUT_PAGE_KINDS = ['ENROLLMENT', 'TUITION'] as const;
export type CheckoutPageKind = (typeof CHECKOUT_PAGE_KINDS)[number];
export const CHECKOUT_PAGE_STATUSES = ['DRAFT', 'PUBLISHED'] as const;
export type CheckoutPageStatus = (typeof CHECKOUT_PAGE_STATUSES)[number];
export const CHECKOUT_LANGUAGES = ['en', 'ko', 'es'] as const;
export type CheckoutLanguage = (typeof CHECKOUT_LANGUAGES)[number];
export const CHECKOUT_FIELD_KINDS = ['TEXT', 'CHOICE', 'CHECKBOX'] as const;
export type CheckoutFieldKind = (typeof CHECKOUT_FIELD_KINDS)[number];
export const CHECKOUT_LIMITS = { plans: 20, addOns: 10, fields: 10, choiceOptions: 10, label: 80, question: 120, note: 1000, waiver: 5000 } as const;

/** English is required; Korean and Spanish are optional. */
export type CheckoutText = { en: string; ko?: string; es?: string };
export interface CheckoutAddOn { key: string; label: CheckoutText; amountMinor: number; currency: string; required: boolean }
export interface CheckoutField { key: string; label: CheckoutText; kind: CheckoutFieldKind; required: boolean; options: CheckoutText[] }
export interface CheckoutContent {
  planIds: string[]; addOns: CheckoutAddOn[]; customFields: CheckoutField[];
  waiver: { text: CheckoutText } | null; receiptNote: CheckoutText | null; thankYou: CheckoutText | null;
}
export interface CheckoutPage { pageId: string; kind: CheckoutPageKind; status: CheckoutPageStatus; content: CheckoutContent; version: number; updatedAt: string }
export interface CheckoutPlanChoice { planId: string; displayName: string; priceMinor: number; currency: string; billingFrequency: string; available: boolean }
export interface SchoolCheckoutPages { enrollment: CheckoutPage | null; tuition: CheckoutPage | null; plans: CheckoutPlanChoice[] }
export interface SaveCheckoutPageInput { kind: CheckoutPageKind; expectedVersion: number; status: CheckoutPageStatus; content: CheckoutContent }
export interface CheckoutPageReceipt { page: CheckoutPage }

export const EMPTY_CHECKOUT_CONTENT: CheckoutContent = Object.freeze({ planIds: [], addOns: [], customFields: [], waiver: null, receiptNote: null, thankYou: null }) as CheckoutContent;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const CURRENCY = /^[A-Z]{3}$/;
const ANGLE = /[<>]/;
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_BUT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/;

function invalid(): never { throw new Error('Invalid checkout page data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
function list(value: unknown, maximum: number): unknown[] { if (!Array.isArray(value) || value.length > maximum) invalid(); return value; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function matching(value: unknown, pattern: RegExp): string { if (typeof value !== 'string' || !pattern.test(value)) invalid(); return value; }
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(); return value as T; }
function count(value: unknown, minimum: number, maximum = 999_999_999): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function distinct(values: readonly string[]): void { if (new Set(values).size !== values.length) invalid(); }

/** One display text: trimmed, 1..maximum characters, no angle brackets, no control characters (line breaks only when multiline). */
export function checkoutTextOk(value: unknown, maximum: number, multiline = false): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum && value.trim() === value && !ANGLE.test(value)
    && !(multiline ? CONTROL_BUT_NEWLINE : CONTROL).test(value);
}
function translated(value: unknown, maximum: number, multiline = false): CheckoutText {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (!Object.hasOwn(row, 'en') || Object.keys(row).some(key => !(CHECKOUT_LANGUAGES as readonly string[]).includes(key))) invalid();
  const out: CheckoutText = { en: '' };
  for (const language of CHECKOUT_LANGUAGES) {
    if (!Object.hasOwn(row, language)) continue;
    if (!checkoutTextOk(row[language], maximum, multiline)) invalid();
    out[language] = row[language] as string;
  }
  return out;
}

export function validateCheckoutContent(value: unknown): CheckoutContent {
  const row = record(value, ['planIds', 'addOns', 'customFields', 'waiver', 'receiptNote', 'thankYou']);
  const planIds = list(row.planIds, CHECKOUT_LIMITS.plans).map(id => matching(id, UUID));
  distinct(planIds);
  const addOns = list(row.addOns, CHECKOUT_LIMITS.addOns).map(entry => {
    const a = record(entry, ['key', 'label', 'amountMinor', 'currency', 'required']);
    return { key: matching(a.key, KEY), label: translated(a.label, CHECKOUT_LIMITS.label), amountMinor: count(a.amountMinor, 1, 99_999_999),
      currency: matching(a.currency, CURRENCY), required: bool(a.required) };
  });
  distinct(addOns.map(a => a.key));
  const customFields = list(row.customFields, CHECKOUT_LIMITS.fields).map(entry => {
    const f = record(entry, ['key', 'label', 'kind', 'required', 'options']);
    const kind = oneOf(f.kind, CHECKOUT_FIELD_KINDS);
    const options = list(f.options, CHECKOUT_LIMITS.choiceOptions).map(option => translated(option, CHECKOUT_LIMITS.label));
    if (kind === 'CHOICE' ? options.length < 2 : options.length !== 0) invalid();
    return { key: matching(f.key, KEY), label: translated(f.label, CHECKOUT_LIMITS.question), kind, required: bool(f.required), options };
  });
  distinct(customFields.map(f => f.key));
  const waiver = row.waiver === null ? null : { text: translated(record(row.waiver, ['text']).text, CHECKOUT_LIMITS.waiver, true) };
  const receiptNote = row.receiptNote === null ? null : translated(row.receiptNote, CHECKOUT_LIMITS.note, true);
  const thankYou = row.thankYou === null ? null : translated(row.thankYou, CHECKOUT_LIMITS.note, true);
  return { planIds, addOns, customFields, waiver, receiptNote, thankYou };
}

export function validateSaveCheckoutPageInput(value: unknown): SaveCheckoutPageInput {
  const row = record(value, ['kind', 'expectedVersion', 'status', 'content']);
  const input: SaveCheckoutPageInput = { kind: oneOf(row.kind, CHECKOUT_PAGE_KINDS), expectedVersion: count(row.expectedVersion, 0),
    status: oneOf(row.status, CHECKOUT_PAGE_STATUSES), content: validateCheckoutContent(row.content) };
  if (input.kind === 'ENROLLMENT' && input.status === 'PUBLISHED' && input.content.planIds.length === 0) invalid();
  return input;
}

export function verifyCheckoutPage(value: unknown, kind?: CheckoutPageKind): CheckoutPage {
  const row = record(value, ['pageId', 'kind', 'status', 'content', 'version', 'updatedAt']);
  const page: CheckoutPage = { pageId: matching(row.pageId, UUID), kind: oneOf(row.kind, CHECKOUT_PAGE_KINDS), status: oneOf(row.status, CHECKOUT_PAGE_STATUSES),
    content: validateCheckoutContent(row.content), version: count(row.version, 1), updatedAt: matching(row.updatedAt, INSTANT) };
  if ((kind !== undefined && page.kind !== kind) || (page.kind === 'ENROLLMENT' && page.status === 'PUBLISHED' && page.content.planIds.length === 0)) invalid();
  return page;
}
export function verifyCheckoutPageReceipt(value: unknown, expect: { kind: CheckoutPageKind; version: number }): CheckoutPageReceipt {
  const page = verifyCheckoutPage(record(value, ['page']).page, expect.kind);
  if (page.version !== expect.version) invalid();
  return { page };
}
export function verifySchoolCheckoutPages(value: unknown): SchoolCheckoutPages {
  const row = record(value, ['enrollment', 'tuition', 'plans']);
  const plans = list(row.plans, 200).map(entry => {
    const p = record(entry, ['planId', 'displayName', 'priceMinor', 'currency', 'billingFrequency', 'available']);
    if (!checkoutTextOk(p.displayName, 120)) invalid();
    return { planId: matching(p.planId, UUID), displayName: p.displayName as string, priceMinor: count(p.priceMinor, 0, 100_000_000), currency: matching(p.currency, CURRENCY),
      billingFrequency: oneOf(p.billingFrequency, ['WEEKLY', 'MONTHLY', 'ANNUAL', 'PAID_IN_FULL'] as const), available: bool(p.available) };
  });
  distinct(plans.map(p => p.planId));
  return { enrollment: row.enrollment === null ? null : verifyCheckoutPage(row.enrollment, 'ENROLLMENT'),
    tuition: row.tuition === null ? null : verifyCheckoutPage(row.tuition, 'TUITION'), plans };
}
