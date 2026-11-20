/**
 * Family checkout orders (0598, CP3 first slice). A signed-in guardian buys one ONE_TIME option of a PUBLISHED checkout
 * page (0402) of their school, for one or more of their own children, on the school's own processor page (the shared
 * one-time payment, 0529). TEST mode only; HON adds no fee. The app names a page, its version, an option, children it
 * read here, answers and add-ons; who, what and how much are decided by the database. The app never names a payment.
 */
export const FAMILY_CHECKOUT_ORDER_STATUSES = ['OPEN', 'PAID', 'CANCELED', 'REVIEW', 'UNPAID'] as const;
export type FamilyCheckoutOrderStatus = (typeof FAMILY_CHECKOUT_ORDER_STATUSES)[number];
export const FAMILY_CHECKOUT_PAY_STATES = ['NONE', 'OPEN', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELED'] as const;
export type FamilyCheckoutPayState = (typeof FAMILY_CHECKOUT_PAY_STATES)[number];
export const FAMILY_CHECKOUT_LIMITS = { pages: 50, orders: 20, staffOrders: 200, children: 20, participants: 10, addOns: 10, answer: 500 } as const;

export interface FamilyCheckoutOption {
  key: string; label: string; description: string | null; priceMinor: number; additionalParticipantMinor: number | null; mostPopular: boolean;
  /** Places left, or null when the option has no limit. */
  placesLeft: number | null;
}
export interface FamilyCheckoutAddOn { key: string; label: string; amountMinor: number; required: boolean }
export interface FamilyCheckoutQuestion { key: string; label: string; kind: 'TEXT' | 'CHOICE' | 'CHECKBOX'; required: boolean; options: string[] }
export interface FamilyCheckoutPage {
  checkoutId: string; version: number; group: string; title: string; description: string | null; currency: string; maxParticipants: number;
  blocks: { position: 'ABOVE' | 'BELOW'; text: string }[]; options: FamilyCheckoutOption[]; addOns: FamilyCheckoutAddOn[];
  questions: FamilyCheckoutQuestion[]; waiver: string | null; thankYou: string | null;
}
export interface FamilyCheckoutOrder {
  orderId: string; checkoutId: string; title: string; optionKey: string; participantCount: number; amountMinor: number; currency: string;
  status: FamilyCheckoutOrderStatus; createdAt: string;
}
export interface FamilyCheckoutChild { studentProfileId: string; displayName: string }
export interface ParentCheckoutPages {
  schoolName: string;
  /** The signed-in person is a guardian (a VIEWER grant sees the pages but cannot buy). */
  canBuy: boolean;
  /** The school can take a card payment through the app now (free options can be ordered without it). */
  canPay: boolean;
  /** Always true until live payments are approved: the app says no real money moves. */
  testMode: true;
  pages: FamilyCheckoutPage[]; children: FamilyCheckoutChild[]; orders: FamilyCheckoutOrder[];
}
export type FamilyCheckoutAnswer = string | boolean;
export interface OpenParentCheckoutOrderInput {
  checkoutId: string; expectedVersion: number; optionKey: string; waiverAccepted: boolean; addOns: string[];
  participants: { studentProfileId: string; answers: Record<string, FamilyCheckoutAnswer> }[];
}
/** After ordering: the processor page to open (url), or none when the order is free or no longer needs paying. */
export interface ParentCheckoutOrderStart {
  orderId: string; status: FamilyCheckoutOrderStatus; payState: FamilyCheckoutPayState; amountMinor: number; currency: string;
  url: string | null; expiresAt: string | null;
}
export interface ParentCheckoutOrderResult { order: FamilyCheckoutOrder; payState: FamilyCheckoutPayState }
export interface SchoolCheckoutOrder {
  orderId: string; checkoutId: string; title: string; optionKey: string; familyName: string | null;
  participants: { name: string | null; answers: Record<string, FamilyCheckoutAnswer> }[]; addOnKeys: string[]; waiverAccepted: boolean;
  amountMinor: number; currency: string; status: FamilyCheckoutOrderStatus; createdAt: string; settledAt: string | null;
}
export interface SchoolCheckoutOrders { orders: SchoolCheckoutOrder[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const CURRENCY = /^[A-Z]{3}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const ANSWER_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function invalid(): never { throw new Error('Invalid family checkout data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
function list(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) invalid(); return value; }
function oneOf<const T extends readonly string[]>(value: unknown, options: T): T[number] {
  if (typeof value !== 'string' || !options.includes(value)) invalid();
  return value as T[number];
}
function matching(value: unknown, pattern: RegExp): string { if (typeof value !== 'string' || !pattern.test(value)) invalid(); return value; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function count(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) invalid();
  return value as number;
}
const minor = (value: unknown) => count(value, 0, 5_000_000_000);
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) invalid();
  return value;
}
function nullableText(value: unknown, max: number): string | null { return value === null ? null : text(value, max); }
function instant(value: unknown): string {
  if (typeof value !== 'string' || !INSTANT.test(value) || !Number.isFinite(Date.parse(value))) invalid();
  return value;
}
function distinct<T>(items: T[], by: (x: T) => string): T[] { if (new Set(items.map(by)).size !== items.length) invalid(); return items; }
function answers(value: unknown): Record<string, FamilyCheckoutAnswer> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const out: Record<string, FamilyCheckoutAnswer> = {};
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length > 10) invalid();
  for (let i = 0; i < keys.length; i += 1) {
    const key = matching(keys[i], KEY), answer = row[key];
    if (typeof answer === 'boolean') out[key] = answer;
    else if (typeof answer === 'string' && answer.length <= FAMILY_CHECKOUT_LIMITS.answer && answer.trim() !== '' && !ANSWER_CONTROL.test(answer)) out[key] = answer;
    else invalid();
  }
  return out;
}

export function validateFamilyCheckoutOrderId(value: unknown): string { return matching(value, UUID); }
export function validateOpenParentCheckoutOrderInput(value: unknown): OpenParentCheckoutOrderInput {
  const row = record(value, ['checkoutId', 'expectedVersion', 'optionKey', 'waiverAccepted', 'addOns', 'participants']);
  const addOns = distinct(list(row.addOns, FAMILY_CHECKOUT_LIMITS.addOns).map(k => matching(k, KEY)), k => k);
  const participants = list(row.participants, FAMILY_CHECKOUT_LIMITS.participants).map(entry => {
    const p = record(entry, ['studentProfileId', 'answers']);
    return { studentProfileId: matching(p.studentProfileId, UUID), answers: answers(p.answers) };
  });
  if (participants.length < 1) invalid();
  return {
    checkoutId: matching(row.checkoutId, UUID), expectedVersion: count(row.expectedVersion, 1, 999_999_999), optionKey: matching(row.optionKey, KEY),
    waiverAccepted: bool(row.waiverAccepted), addOns, participants: distinct(participants, p => p.studentProfileId),
  };
}

function option(value: unknown): FamilyCheckoutOption {
  const o = record(value, ['key', 'label', 'description', 'priceMinor', 'additionalParticipantMinor', 'mostPopular', 'placesLeft']);
  return { key: matching(o.key, KEY), label: text(o.label, 80), description: nullableText(o.description, 2000), priceMinor: minor(o.priceMinor),
    additionalParticipantMinor: o.additionalParticipantMinor === null ? null : minor(o.additionalParticipantMinor), mostPopular: bool(o.mostPopular),
    placesLeft: o.placesLeft === null ? null : count(o.placesLeft, 0, 1_000_000) };
}
function page(value: unknown): FamilyCheckoutPage {
  const p = record(value, ['checkoutId', 'version', 'group', 'title', 'description', 'currency', 'maxParticipants', 'blocks', 'options', 'addOns', 'questions', 'waiver', 'thankYou']);
  const options = distinct(list(p.options, 10).map(option), o => o.key);
  if (options.length < 1) invalid();
  return {
    checkoutId: matching(p.checkoutId, UUID), version: count(p.version, 1, 999_999_999), group: matching(p.group, KEY), title: text(p.title, 120),
    description: nullableText(p.description, 2000), currency: matching(p.currency, CURRENCY), maxParticipants: count(p.maxParticipants, 1, FAMILY_CHECKOUT_LIMITS.participants),
    blocks: list(p.blocks, 10).map(entry => { const b = record(entry, ['position', 'text']); return { position: oneOf(b.position, ['ABOVE', 'BELOW'] as const), text: text(b.text, 2000) }; }),
    options,
    addOns: distinct(list(p.addOns, 10).map(entry => {
      const a = record(entry, ['key', 'label', 'amountMinor', 'required']);
      return { key: matching(a.key, KEY), label: text(a.label, 80), amountMinor: minor(a.amountMinor), required: bool(a.required) };
    }), a => a.key),
    questions: distinct(list(p.questions, 10).map(entry => {
      const q = record(entry, ['key', 'label', 'kind', 'required', 'options']);
      return { key: matching(q.key, KEY), label: text(q.label, 120), kind: oneOf(q.kind, ['TEXT', 'CHOICE', 'CHECKBOX'] as const), required: bool(q.required),
        options: list(q.options, 10).map(x => text(x, 80)) };
    }), q => q.key),
    waiver: nullableText(p.waiver, 5000), thankYou: nullableText(p.thankYou, 1000),
  };
}
export function verifyFamilyCheckoutOrder(value: unknown): FamilyCheckoutOrder {
  const o = record(value, ['orderId', 'checkoutId', 'title', 'optionKey', 'participantCount', 'amountMinor', 'currency', 'status', 'createdAt']);
  return { orderId: matching(o.orderId, UUID), checkoutId: matching(o.checkoutId, UUID), title: text(o.title, 120), optionKey: matching(o.optionKey, KEY),
    participantCount: count(o.participantCount, 1, FAMILY_CHECKOUT_LIMITS.participants), amountMinor: minor(o.amountMinor), currency: matching(o.currency, CURRENCY),
    status: oneOf(o.status, FAMILY_CHECKOUT_ORDER_STATUSES), createdAt: instant(o.createdAt) };
}
export function verifyParentCheckoutPages(value: unknown): ParentCheckoutPages {
  const row = record(value, ['schoolName', 'canBuy', 'canPay', 'testMode', 'pages', 'children', 'orders']);
  if (row.testMode !== true) invalid();
  return {
    schoolName: text(row.schoolName, 200), canBuy: bool(row.canBuy), canPay: bool(row.canPay), testMode: true,
    pages: distinct(list(row.pages, FAMILY_CHECKOUT_LIMITS.pages).map(page), p => p.checkoutId),
    children: distinct(list(row.children, FAMILY_CHECKOUT_LIMITS.children).map(entry => {
      const c = record(entry, ['studentProfileId', 'displayName']);
      return { studentProfileId: matching(c.studentProfileId, UUID), displayName: text(c.displayName, 200) };
    }), c => c.studentProfileId),
    orders: distinct(list(row.orders, FAMILY_CHECKOUT_LIMITS.orders).map(verifyFamilyCheckoutOrder), o => o.orderId),
  };
}
export function verifyParentCheckoutOrderStart(value: unknown): ParentCheckoutOrderStart {
  const row = record(value, ['orderId', 'status', 'payState', 'amountMinor', 'currency', 'url', 'expiresAt']);
  const url = row.url === null ? null : matching(row.url, /^https:\/\/[^\s]{1,2040}$/);
  const expiresAt = row.expiresAt === null ? null : instant(row.expiresAt);
  const payState = oneOf(row.payState, FAMILY_CHECKOUT_PAY_STATES);
  if ((url === null) !== (expiresAt === null) || (url !== null && payState !== 'OPEN')) invalid();
  return { orderId: matching(row.orderId, UUID), status: oneOf(row.status, FAMILY_CHECKOUT_ORDER_STATUSES), payState, amountMinor: minor(row.amountMinor),
    currency: matching(row.currency, CURRENCY), url, expiresAt };
}
export function verifyParentCheckoutOrderResult(value: unknown): ParentCheckoutOrderResult {
  const row = record(value, ['order', 'payState']);
  return { order: verifyFamilyCheckoutOrder(row.order), payState: oneOf(row.payState, FAMILY_CHECKOUT_PAY_STATES) };
}
export function verifySchoolCheckoutOrders(value: unknown): SchoolCheckoutOrders {
  const row = record(value, ['orders']);
  return { orders: distinct(list(row.orders, FAMILY_CHECKOUT_LIMITS.staffOrders).map(entry => {
    const o = record(entry, ['orderId', 'checkoutId', 'title', 'optionKey', 'familyName', 'participants', 'addOnKeys', 'waiverAccepted', 'amountMinor', 'currency', 'status', 'createdAt', 'settledAt']);
    return {
      orderId: matching(o.orderId, UUID), checkoutId: matching(o.checkoutId, UUID), title: text(o.title, 120), optionKey: matching(o.optionKey, KEY),
      familyName: nullableText(o.familyName, 200),
      participants: list(o.participants, FAMILY_CHECKOUT_LIMITS.participants).map(entry2 => {
        const p = record(entry2, ['name', 'answers']);
        return { name: nullableText(p.name, 200), answers: answers(p.answers) };
      }),
      addOnKeys: list(o.addOnKeys, FAMILY_CHECKOUT_LIMITS.addOns).map(k => matching(k, KEY)), waiverAccepted: bool(o.waiverAccepted),
      amountMinor: minor(o.amountMinor), currency: matching(o.currency, CURRENCY), status: oneOf(o.status, FAMILY_CHECKOUT_ORDER_STATUSES),
      createdAt: instant(o.createdAt), settledAt: o.settledAt === null ? null : instant(o.settledAt),
    };
  }), o => o.orderId) };
}
