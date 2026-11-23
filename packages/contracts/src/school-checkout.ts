/**
 * B-TUI-2 checkout pages CP1 (0402): many named checkout pages per school, modeled on the owner's current CRM (groups,
 * live/draft, pricing options with down payments and installments, multi-participant, per-participant questions). Each
 * text is English with optional Korean and Spanish. Branding comes from the shared school branding, not from here. HON
 * adds no fee. The database validates every rule here again. (0269's one-page-per-kind model was retired by 0402.)
 */
export const CHECKOUT_PAGE_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type CheckoutPageStatus = (typeof CHECKOUT_PAGE_STATUSES)[number];
export const CHECKOUT_LANGUAGES = ['en', 'ko', 'es'] as const;
export type CheckoutLanguage = (typeof CHECKOUT_LANGUAGES)[number];
export const CHECKOUT_FIELD_KINDS = ['TEXT', 'CHOICE', 'CHECKBOX'] as const;
export type CheckoutFieldKind = (typeof CHECKOUT_FIELD_KINDS)[number];
export const CHECKOUT_BILLING = ['ONE_TIME', 'MONTHLY'] as const;
export type CheckoutBilling = (typeof CHECKOUT_BILLING)[number];
/** AUTO_CHARGE is HON autopay (test mode only until live charging is approved); IN_HOUSE and REVIEW_REQUIRED bill nothing online. */
export const CHECKOUT_COLLECTION_METHODS = ['AUTO_CHARGE', 'IN_HOUSE', 'REVIEW_REQUIRED'] as const;
export type CheckoutCollectionMethod = (typeof CHECKOUT_COLLECTION_METHODS)[number];
export const CHECKOUT_BLOCK_POSITIONS = ['ABOVE', 'BELOW'] as const;
export type CheckoutBlockPosition = (typeof CHECKOUT_BLOCK_POSITIONS)[number];
export const CHECKOUT_LIMITS = {
  pages: 200, options: 10, addOns: 10, fields: 10, blocks: 10, groups: 20, choiceOptions: 10, participants: 10,
  title: 120, description: 2000, block: 2000, label: 80, groupLabel: 40, question: 120, note: 1000, waiver: 5000,
  amountMinor: 99_999_999, installments: 120, capacity: 100_000,
} as const;

/** English is required; Korean and Spanish are optional. */
export type CheckoutText = { en: string; ko?: string; es?: string };
export interface CheckoutAddOn { key: string; label: CheckoutText; amountMinor: number; currency: string; required: boolean }
export interface CheckoutField { key: string; label: CheckoutText; kind: CheckoutFieldKind; required: boolean; options: CheckoutText[] }
export interface CheckoutBlock { position: CheckoutBlockPosition; text: CheckoutText }
export interface CheckoutOption {
  key: string; label: CheckoutText; description: CheckoutText | null; planId: string | null; billing: CheckoutBilling;
  /** ONE_TIME: the price (0 allowed). MONTHLY: null; due today is the down payment, or the first month without one. */
  priceMinor: number | null;
  recurringMinor: number | null; installments: number | null; downPayment: { amountMinor: number; label: CheckoutText } | null;
  collectionMethod: CheckoutCollectionMethod | null;
  /** Null charges the full price for each extra participant. */
  additionalParticipantMinor: number | null;
  /** 0 means unlimited. */
  capacity: number; availableThrough: string | null; mostPopular: boolean; createsMembership: boolean;
}
export interface CheckoutContent {
  currency: string; title: CheckoutText; description: CheckoutText | null; blocks: CheckoutBlock[];
  multiParticipant: { enabled: boolean; maxPerOrder: number }; customFields: CheckoutField[]; addOns: CheckoutAddOn[];
  options: CheckoutOption[]; waiver: { text: CheckoutText } | null; receiptNote: CheckoutText | null; thankYou: CheckoutText | null;
}
export interface CheckoutPage { pageId: string; slug: string; groupKey: string; status: CheckoutPageStatus; content: CheckoutContent; version: number; updatedAt: string }
export interface CheckoutGroup { key: string; label: CheckoutText }
export interface CheckoutSettings { version: number; groups: CheckoutGroup[]; pageOrder: string[] }
export interface CheckoutPlanChoice { planId: string; displayName: string; priceMinor: number; currency: string; billingFrequency: string; available: boolean }
export interface SchoolCheckoutPages { settings: CheckoutSettings; pages: CheckoutPage[]; plans: CheckoutPlanChoice[] }
export interface SaveCheckoutPageInput { pageId: string | null; expectedVersion: number; slug: string; groupKey: string; status: CheckoutPageStatus; content: CheckoutContent }
export interface SaveCheckoutSettingsInput { expectedVersion: number; groups: CheckoutGroup[]; pageOrder: string[] }
export interface CheckoutPageReceipt { page: CheckoutPage }
export interface CheckoutSettingsReceipt { settings: CheckoutSettings }

export const DEFAULT_CHECKOUT_GROUPS: readonly CheckoutGroup[] = Object.freeze(
  ['Trial', 'Membership', 'Event', 'Tournament', 'Test', 'Equipment', 'Camp', 'Sales'].map(en => Object.freeze({ key: en.toLowerCase(), label: Object.freeze({ en }) })),
) as readonly CheckoutGroup[];
export function emptyCheckoutContent(title: string, currency = 'USD'): CheckoutContent {
  return { currency, title: { en: title }, description: null, blocks: [], multiParticipant: { enabled: false, maxPerOrder: 1 }, customFields: [], addOns: [],
    options: [], waiver: null, receiptNote: null, thankYou: null };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
export const CHECKOUT_SLUG = /^[a-z0-9][a-z0-9-]{1,59}$/;
const DATE = /^20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const CURRENCY = /^[A-Z]{3}$/;
const ANGLE = /[<>]/;
// eslint-disable-next-line no-control-regex
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
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function distinct(values: readonly string[]): void { if (new Set(values).size !== values.length) invalid(); }

/** A page address: lowercase letters, digits and single hyphens, 2-60 characters, not ending in a hyphen. */
export function checkoutSlugOk(value: unknown): value is string {
  return typeof value === 'string' && CHECKOUT_SLUG.test(value) && !value.includes('--') && !value.endsWith('-');
}
/** One display text: trimmed, 1..maximum characters, no angle brackets, no control characters (line breaks only when multiline). */
export function checkoutTextOk(value: unknown, maximum: number, multiline = false): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum && value.trim() === value && !ANGLE.test(value)
    && !(multiline ? CONTROL_BUT_NEWLINE : CONTROL).test(value);
}
/** A calendar date YYYY-MM-DD in 2000-2099 that exists. */
export function checkoutDateOk(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
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
const nullable = <T>(value: unknown, read: (value: unknown) => T): T | null => (value === null ? null : read(value));

const OPTION_KEYS = ['key', 'label', 'description', 'planId', 'billing', 'priceMinor', 'recurringMinor', 'installments', 'downPayment', 'collectionMethod',
  'additionalParticipantMinor', 'capacity', 'availableThrough', 'mostPopular', 'createsMembership'] as const;
export function validateCheckoutOption(value: unknown): CheckoutOption {
  const o = record(value, OPTION_KEYS);
  const billing = oneOf(o.billing, CHECKOUT_BILLING);
  const option: CheckoutOption = {
    key: matching(o.key, KEY), label: translated(o.label, CHECKOUT_LIMITS.label), description: nullable(o.description, v => translated(v, CHECKOUT_LIMITS.note, true)),
    planId: nullable(o.planId, v => matching(v, UUID)), billing, priceMinor: null, recurringMinor: null, installments: null, downPayment: null, collectionMethod: null,
    additionalParticipantMinor: nullable(o.additionalParticipantMinor, v => count(v, 0, CHECKOUT_LIMITS.amountMinor)),
    capacity: count(o.capacity, 0, CHECKOUT_LIMITS.capacity), availableThrough: nullable(o.availableThrough, v => { if (!checkoutDateOk(v)) invalid(); return v; }),
    mostPopular: bool(o.mostPopular), createsMembership: bool(o.createsMembership),
  };
  if (billing === 'ONE_TIME') {
    option.priceMinor = count(o.priceMinor, 0, CHECKOUT_LIMITS.amountMinor);
    if (o.recurringMinor !== null || o.installments !== null || o.downPayment !== null || o.collectionMethod !== null) invalid();
  } else {
    if (o.priceMinor !== null) invalid();
    option.recurringMinor = count(o.recurringMinor, 1, CHECKOUT_LIMITS.amountMinor);
    option.installments = count(o.installments, 0, CHECKOUT_LIMITS.installments);
    option.collectionMethod = oneOf(o.collectionMethod, CHECKOUT_COLLECTION_METHODS);
    option.downPayment = nullable(o.downPayment, v => {
      const d = record(v, ['amountMinor', 'label']);
      return { amountMinor: count(d.amountMinor, 1, CHECKOUT_LIMITS.amountMinor), label: translated(d.label, CHECKOUT_LIMITS.label) };
    });
  }
  if (option.createsMembership && option.planId === null) invalid();
  return option;
}

const CONTENT_KEYS = ['currency', 'title', 'description', 'blocks', 'multiParticipant', 'customFields', 'addOns', 'options', 'waiver', 'receiptNote', 'thankYou'] as const;
export function validateCheckoutContent(value: unknown): CheckoutContent {
  const row = record(value, CONTENT_KEYS);
  const currency = matching(row.currency, CURRENCY);
  const blocks = list(row.blocks, CHECKOUT_LIMITS.blocks).map(entry => {
    const b = record(entry, ['position', 'text']);
    return { position: oneOf(b.position, CHECKOUT_BLOCK_POSITIONS), text: translated(b.text, CHECKOUT_LIMITS.block, true) };
  });
  const m = record(row.multiParticipant, ['enabled', 'maxPerOrder']);
  const multiParticipant = { enabled: bool(m.enabled), maxPerOrder: count(m.maxPerOrder, 1, CHECKOUT_LIMITS.participants) };
  if (!multiParticipant.enabled && multiParticipant.maxPerOrder !== 1) invalid();
  const customFields = list(row.customFields, CHECKOUT_LIMITS.fields).map(entry => {
    const f = record(entry, ['key', 'label', 'kind', 'required', 'options']);
    const kind = oneOf(f.kind, CHECKOUT_FIELD_KINDS);
    const options = list(f.options, CHECKOUT_LIMITS.choiceOptions).map(option => translated(option, CHECKOUT_LIMITS.label));
    if (kind === 'CHOICE' ? options.length < 2 : options.length !== 0) invalid();
    return { key: matching(f.key, KEY), label: translated(f.label, CHECKOUT_LIMITS.question), kind, required: bool(f.required), options };
  });
  distinct(customFields.map(f => f.key));
  const addOns = list(row.addOns, CHECKOUT_LIMITS.addOns).map(entry => {
    const a = record(entry, ['key', 'label', 'amountMinor', 'currency', 'required']);
    const addOn = { key: matching(a.key, KEY), label: translated(a.label, CHECKOUT_LIMITS.label), amountMinor: count(a.amountMinor, 1, CHECKOUT_LIMITS.amountMinor),
      currency: matching(a.currency, CURRENCY), required: bool(a.required) };
    if (addOn.currency !== currency) invalid();
    return addOn;
  });
  distinct(addOns.map(a => a.key));
  const options = list(row.options, CHECKOUT_LIMITS.options).map(validateCheckoutOption);
  distinct(options.map(o => o.key));
  if (options.filter(o => o.mostPopular).length > 1) invalid();
  return {
    currency, title: translated(row.title, CHECKOUT_LIMITS.title), description: nullable(row.description, v => translated(v, CHECKOUT_LIMITS.description, true)),
    blocks, multiParticipant, customFields, addOns, options,
    waiver: nullable(row.waiver, v => ({ text: translated(record(v, ['text']).text, CHECKOUT_LIMITS.waiver, true) })),
    receiptNote: nullable(row.receiptNote, v => translated(v, CHECKOUT_LIMITS.note, true)), thankYou: nullable(row.thankYou, v => translated(v, CHECKOUT_LIMITS.note, true)),
  };
}

export function validateSaveCheckoutPageInput(value: unknown): SaveCheckoutPageInput {
  const row = record(value, ['pageId', 'expectedVersion', 'slug', 'groupKey', 'status', 'content']);
  const input: SaveCheckoutPageInput = { pageId: nullable(row.pageId, v => matching(v, UUID)), expectedVersion: count(row.expectedVersion, 0),
    slug: (() => { if (!checkoutSlugOk(row.slug)) invalid(); return row.slug; })(), groupKey: matching(row.groupKey, KEY),
    status: oneOf(row.status, CHECKOUT_PAGE_STATUSES), content: validateCheckoutContent(row.content) };
  if ((input.pageId === null) !== (input.expectedVersion === 0)) invalid();
  if (input.status === 'PUBLISHED' && input.content.options.length === 0) invalid();
  return input;
}
function groups(value: unknown): CheckoutGroup[] {
  const out = list(value, CHECKOUT_LIMITS.groups).map(entry => {
    const g = record(entry, ['key', 'label']);
    return { key: matching(g.key, KEY), label: translated(g.label, CHECKOUT_LIMITS.groupLabel) };
  });
  if (out.length < 1) invalid();
  distinct(out.map(g => g.key));
  return out;
}
function pageOrder(value: unknown): string[] {
  const out = list(value, 500).map(id => matching(id, UUID));
  distinct(out);
  return out;
}
export function validateSaveCheckoutSettingsInput(value: unknown): SaveCheckoutSettingsInput {
  const row = record(value, ['expectedVersion', 'groups', 'pageOrder']);
  return { expectedVersion: count(row.expectedVersion, 0), groups: groups(row.groups), pageOrder: pageOrder(row.pageOrder) };
}

export function verifyCheckoutPage(value: unknown): CheckoutPage {
  const row = record(value, ['pageId', 'slug', 'groupKey', 'status', 'content', 'version', 'updatedAt']);
  if (!checkoutSlugOk(row.slug)) invalid();
  const page: CheckoutPage = { pageId: matching(row.pageId, UUID), slug: row.slug, groupKey: matching(row.groupKey, KEY), status: oneOf(row.status, CHECKOUT_PAGE_STATUSES),
    content: validateCheckoutContent(row.content), version: count(row.version, 1), updatedAt: matching(row.updatedAt, INSTANT) };
  if (page.status === 'PUBLISHED' && page.content.options.length === 0) invalid();
  return page;
}
export function verifyCheckoutSettings(value: unknown): CheckoutSettings {
  const row = record(value, ['version', 'groups', 'pageOrder']);
  return { version: count(row.version, 0), groups: groups(row.groups), pageOrder: pageOrder(row.pageOrder) };
}
export function verifyCheckoutPageReceipt(value: unknown, expect: { pageId: string | null; slug: string; version: number }): CheckoutPageReceipt {
  const page = verifyCheckoutPage(record(value, ['page']).page);
  if (page.version !== expect.version || page.slug !== expect.slug || (expect.pageId !== null && page.pageId !== expect.pageId.toLowerCase())) invalid();
  return { page };
}
export function verifyCheckoutSettingsReceipt(value: unknown, expect: { version: number }): CheckoutSettingsReceipt {
  const settings = verifyCheckoutSettings(record(value, ['settings']).settings);
  if (settings.version !== expect.version) invalid();
  return { settings };
}
export function verifySchoolCheckoutPages(value: unknown): SchoolCheckoutPages {
  const row = record(value, ['settings', 'pages', 'plans']);
  const settings = verifyCheckoutSettings(row.settings);
  const pages = list(row.pages, CHECKOUT_LIMITS.pages).map(verifyCheckoutPage);
  distinct(pages.map(p => p.pageId));
  distinct(pages.map(p => p.slug));
  const plans = list(row.plans, 200).map(entry => {
    const p = record(entry, ['planId', 'displayName', 'priceMinor', 'currency', 'billingFrequency', 'available']);
    if (!checkoutTextOk(p.displayName, 120)) invalid();
    return { planId: matching(p.planId, UUID), displayName: p.displayName as string, priceMinor: count(p.priceMinor, 0, 100_000_000), currency: matching(p.currency, CURRENCY),
      billingFrequency: oneOf(p.billingFrequency, ['WEEKLY', 'MONTHLY', 'ANNUAL', 'PAID_IN_FULL'] as const), available: bool(p.available) };
  });
  distinct(plans.map(p => p.planId));
  return { settings, pages, plans };
}

/** What a family pays today for one participant on one option (before add-ons, discounts and extra participants). */
export function checkoutOptionDueTodayMinor(option: CheckoutOption): number {
  if (option.billing === 'ONE_TIME') return option.priceMinor ?? 0;
  return option.downPayment?.amountMinor ?? option.recurringMinor ?? 0;
}

// ---------- Share links and the public page (0620) ----------

export const CHECKOUT_PUBLIC_ID = /^[a-f0-9]{48}$/;
export interface CheckoutPageLink { pageId: string; publicId: string }
export interface SchoolCheckoutLinks { links: CheckoutPageLink[] }
/** Staff: every page's share link (0620 issue_school_checkout_links). */
export function verifySchoolCheckoutLinks(value: unknown): SchoolCheckoutLinks {
  const row = record(value, ['links']);
  const links = list(row.links, CHECKOUT_LIMITS.pages).map(entry => {
    const l = record(entry, ['pageId', 'publicId']);
    return { pageId: matching(l.pageId, UUID), publicId: matching(l.publicId, CHECKOUT_PUBLIC_ID) };
  });
  distinct(links.map(l => l.pageId));
  distinct(links.map(l => l.publicId));
  return { links };
}

export interface PublicCheckoutOption {
  key: string; label: CheckoutText; description: CheckoutText | null; billing: CheckoutBilling;
  priceMinor: number | null; recurringMinor: number | null; installments: number | null;
  downPayment: { amountMinor: number; label: CheckoutText } | null; additionalParticipantMinor: number | null;
  mostPopular: boolean; placesLeft: number | null; inFamilyApp: boolean;
}
export interface PublicCheckoutQuestion { key: string; label: CheckoutText; kind: CheckoutFieldKind; required: boolean; options: CheckoutText[] }
export interface PublicCheckoutPage {
  publicId: string; schoolName: string; version: number; title: CheckoutText; description: CheckoutText | null; currency: string; maxParticipants: number;
  blocks: CheckoutBlock[]; options: PublicCheckoutOption[]; addOns: { key: string; label: CheckoutText; amountMinor: number; required: boolean }[];
  /** 0627: the page's questions, asked once per participant. */
  questions: PublicCheckoutQuestion[];
  hasWaiver: boolean; waiver: CheckoutText | null; thankYou: CheckoutText | null;
  /** 0627: the school can take a card payment on its processor's hosted page now (free orders need none). */
  canPay: boolean;
  /** Always true until live payments are approved: the page says no real money moves. */
  testMode: true;
}
const MINOR = 99_999_999;
/** Public: what one share link shows (0620 read_public_school_checkout). The link id must be the one asked for. */
export function verifyPublicCheckoutPage(value: unknown, publicId: string): PublicCheckoutPage {
  const row = record(value, ['publicId', 'schoolName', 'version', 'title', 'description', 'currency', 'maxParticipants', 'blocks', 'options', 'addOns',
    'questions', 'hasWaiver', 'waiver', 'thankYou', 'canPay', 'testMode']);
  if (row.publicId !== publicId || !CHECKOUT_PUBLIC_ID.test(publicId) || row.testMode !== true) invalid();
  if (typeof row.schoolName !== 'string' || row.schoolName.length < 1 || row.schoolName.length > 200 || CONTROL.test(row.schoolName)) invalid();
  const currency = matching(row.currency, CURRENCY);
  const blocks = list(row.blocks, CHECKOUT_LIMITS.blocks).map(entry => {
    const b = record(entry, ['position', 'text']);
    return { position: oneOf(b.position, CHECKOUT_BLOCK_POSITIONS), text: translated(b.text, 2000, true) };
  });
  const options = list(row.options, CHECKOUT_LIMITS.options).map(entry => {
    const o = record(entry, ['key', 'label', 'description', 'billing', 'priceMinor', 'recurringMinor', 'installments', 'downPayment',
      'additionalParticipantMinor', 'mostPopular', 'placesLeft', 'inFamilyApp']);
    const billing = oneOf(o.billing, CHECKOUT_BILLING);
    const option: PublicCheckoutOption = {
      key: matching(o.key, KEY), label: translated(o.label, 80), description: nullable(o.description, v => translated(v, 1000, true)), billing,
      priceMinor: nullable(o.priceMinor, v => count(v, 0, MINOR)), recurringMinor: nullable(o.recurringMinor, v => count(v, 1, MINOR)),
      installments: nullable(o.installments, v => count(v, 0, 120)),
      downPayment: nullable(o.downPayment, v => { const d = record(v, ['amountMinor', 'label']); return { amountMinor: count(d.amountMinor, 1, MINOR), label: translated(d.label, 80) }; }),
      additionalParticipantMinor: nullable(o.additionalParticipantMinor, v => count(v, 0, MINOR)), mostPopular: bool(o.mostPopular),
      placesLeft: nullable(o.placesLeft, v => count(v, 0, 100_000)), inFamilyApp: bool(o.inFamilyApp),
    };
    if (billing === 'ONE_TIME' ? option.priceMinor === null || option.recurringMinor !== null || option.installments !== null || option.downPayment !== null
      : option.priceMinor !== null || option.recurringMinor === null || option.installments === null) invalid();
    if (billing === 'MONTHLY' && option.inFamilyApp) invalid();
    return option;
  });
  distinct(options.map(o => o.key));
  const addOns = list(row.addOns, CHECKOUT_LIMITS.addOns).map(entry => {
    const a = record(entry, ['key', 'label', 'amountMinor', 'required']);
    return { key: matching(a.key, KEY), label: translated(a.label, 80), amountMinor: count(a.amountMinor, 1, MINOR), required: bool(a.required) };
  });
  distinct(addOns.map(a => a.key));
  const questions = list(row.questions, CHECKOUT_LIMITS.fields).map(entry => {
    const q = record(entry, ['key', 'label', 'kind', 'required', 'options']);
    const kind = oneOf(q.kind, CHECKOUT_FIELD_KINDS);
    const choices = list(q.options, CHECKOUT_LIMITS.choiceOptions).map(option => translated(option, CHECKOUT_LIMITS.label));
    if (kind === 'CHOICE' ? choices.length < 2 : choices.length !== 0) invalid();
    return { key: matching(q.key, KEY), label: translated(q.label, CHECKOUT_LIMITS.question), kind, required: bool(q.required), options: choices };
  });
  distinct(questions.map(q => q.key));
  const hasWaiver = bool(row.hasWaiver);
  const waiver = nullable(row.waiver, v => translated(v, CHECKOUT_LIMITS.waiver, true));
  if (hasWaiver !== (waiver !== null)) invalid();
  return { publicId, schoolName: row.schoolName, version: count(row.version, 1, 999_999_999), title: translated(row.title, 120),
    description: nullable(row.description, v => translated(v, 2000, true)), currency, maxParticipants: count(row.maxParticipants, 1, CHECKOUT_LIMITS.participants),
    blocks, options, addOns, questions, hasWaiver, waiver, thankYou: nullable(row.thankYou, v => translated(v, CHECKOUT_LIMITS.note, true)),
    canPay: bool(row.canPay), testMode: true };
}
