/**
 * Sign up and pay from a checkout page share link (0627). A person without an HON account names the page (by its link),
 * its version, one option, participants by name with the page's answers, add-ons, and their own name, email and optional
 * mobile. The browser makes a random key and keeps it: the key is the order's idempotency key and the only way back to it.
 * TEST mode only; HON adds no fee. Who pays what is decided by the database; the browser never names a payment.
 */
import { FAMILY_CHECKOUT_LIMITS, FAMILY_CHECKOUT_ORDER_STATUSES, FAMILY_CHECKOUT_PAY_STATES,
  type FamilyCheckoutAnswer, type FamilyCheckoutOrderStatus, type FamilyCheckoutPayState } from './family-checkout.js';

/** 32 to 100 URL-safe characters, made by the browser (crypto random) and kept by it. */
export const PUBLIC_CHECKOUT_ORDER_KEY = /^[A-Za-z0-9_-]{32,100}$/;
export const PUBLIC_CHECKOUT_RESULTS = ['ORDER', 'NOT_FOUND', 'INVALID', 'CHANGED', 'OPTION_UNAVAILABLE', 'FULL', 'WAIVER_REQUIRED', 'NOT_AVAILABLE', 'RATE_LIMITED'] as const;
export type PublicCheckoutResult = (typeof PUBLIC_CHECKOUT_RESULTS)[number];

export interface PublicCheckoutBuyer { name: string; email: string; mobile: string }
export interface PublicCheckoutOrderInput {
  expectedVersion: number; optionKey: string; waiverAccepted: boolean; addOns: string[];
  buyer: PublicCheckoutBuyer;
  participants: { name: string; answers: Record<string, FamilyCheckoutAnswer> }[];
  /** A field people never see; anything in it means a bot filled the form. */
  website: string;
}
export interface PublicCheckoutOrder {
  orderId: string; title: string; optionKey: string; participantCount: number; amountMinor: number; currency: string;
  status: FamilyCheckoutOrderStatus; createdAt: string;
}
/** What the page shows after any step: the order (when there is one), where its payment stands, and the processor page to open. */
export interface PublicCheckoutOutcome {
  result: PublicCheckoutResult; order: PublicCheckoutOrder | null; payState: FamilyCheckoutPayState;
  url: string | null; expiresAt: string | null;
}
export interface SchoolPublicCheckoutOrder {
  orderId: string; checkoutId: string; title: string; optionKey: string; buyer: { name: string; email: string; mobile: string | null };
  participants: { name: string; answers: Record<string, FamilyCheckoutAnswer> }[]; addOnKeys: string[]; waiverAccepted: boolean;
  amountMinor: number; currency: string; status: FamilyCheckoutOrderStatus; createdAt: string; settledAt: string | null;
}
export interface SchoolPublicCheckoutOrders { orders: SchoolPublicCheckoutOrder[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const CURRENCY = /^[A-Z]{3}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/;
const MOBILE = /^\+[1-9][0-9]{6,14}$/;
const ANSWER_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// The 0261 one-line text rule: trimmed, no control or invisible formatting characters, no spreadsheet-formula start.
const NAME_BAD = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;

function invalid(): never { throw new Error('Invalid public checkout data.'); }
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
function instant(value: unknown): string {
  if (typeof value !== 'string' || !INSTANT.test(value) || !Number.isFinite(Date.parse(value))) invalid();
  return value;
}
function distinct<T>(items: T[], by: (x: T) => string): T[] { if (new Set(items.map(by)).size !== items.length) invalid(); return items; }
/** A person's name as the database accepts it (1 to 120 characters, one line). */
export function publicCheckoutNameOk(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 120 && value === value.trim() && !NAME_BAD.test(value) && !/^[=+@-]/.test(value);
}
function name(value: unknown): string { if (!publicCheckoutNameOk(value)) invalid(); return value; }
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

export function validatePublicCheckoutOrderKey(value: unknown): string { return matching(value, PUBLIC_CHECKOUT_ORDER_KEY); }
/** The browser's order, checked for shape only (the database checks it against the page). Email is lower-cased. */
export function validatePublicCheckoutOrderInput(value: unknown): PublicCheckoutOrderInput {
  const row = record(value, ['expectedVersion', 'optionKey', 'waiverAccepted', 'addOns', 'buyer', 'participants', 'website']);
  if (row.website !== '') invalid();
  const b = record(row.buyer, ['name', 'email', 'mobile']);
  if (typeof b.email !== 'string' || b.email.length > 254 || !EMAIL.test(b.email.toLowerCase())) invalid();
  if (typeof b.mobile !== 'string' || (b.mobile !== '' && !MOBILE.test(b.mobile))) invalid();
  const participants = list(row.participants, FAMILY_CHECKOUT_LIMITS.participants).map(entry => {
    const p = record(entry, ['name', 'answers']);
    return { name: name(p.name), answers: answers(p.answers) };
  });
  if (participants.length < 1) invalid();
  return {
    expectedVersion: count(row.expectedVersion, 1, 999_999_999), optionKey: matching(row.optionKey, KEY), waiverAccepted: bool(row.waiverAccepted),
    addOns: distinct(list(row.addOns, FAMILY_CHECKOUT_LIMITS.addOns).map(k => matching(k, KEY)), k => k),
    buyer: { name: name(b.name), email: b.email.toLowerCase(), mobile: b.mobile }, participants, website: '',
  };
}
export function verifyPublicCheckoutOrder(value: unknown): PublicCheckoutOrder {
  const o = record(value, ['orderId', 'title', 'optionKey', 'participantCount', 'amountMinor', 'currency', 'status', 'createdAt']);
  return { orderId: matching(o.orderId, UUID), title: text(o.title, 120), optionKey: matching(o.optionKey, KEY),
    participantCount: count(o.participantCount, 1, FAMILY_CHECKOUT_LIMITS.participants), amountMinor: minor(o.amountMinor), currency: matching(o.currency, CURRENCY),
    status: oneOf(o.status, FAMILY_CHECKOUT_ORDER_STATUSES), createdAt: instant(o.createdAt) };
}
export function verifyPublicCheckoutOutcome(value: unknown): PublicCheckoutOutcome {
  const row = record(value, ['result', 'order', 'payState', 'url', 'expiresAt']);
  const result = oneOf(row.result, PUBLIC_CHECKOUT_RESULTS);
  const order = row.order === null ? null : verifyPublicCheckoutOrder(row.order);
  const payState = oneOf(row.payState, FAMILY_CHECKOUT_PAY_STATES);
  const url = row.url === null ? null : matching(row.url, /^https:\/\/[^\s]{1,2040}$/);
  const expiresAt = row.expiresAt === null ? null : instant(row.expiresAt);
  if ((result === 'ORDER') !== (order !== null) || (url === null) !== (expiresAt === null) || (url !== null && payState !== 'OPEN')
    || (order === null && payState !== 'NONE')) invalid();
  return { result, order, payState, url, expiresAt };
}
export function verifySchoolPublicCheckoutOrders(value: unknown): SchoolPublicCheckoutOrders {
  const row = record(value, ['orders']);
  return { orders: distinct(list(row.orders, FAMILY_CHECKOUT_LIMITS.staffOrders).map(entry => {
    const o = record(entry, ['orderId', 'checkoutId', 'title', 'optionKey', 'buyer', 'participants', 'addOnKeys', 'waiverAccepted', 'amountMinor', 'currency', 'status', 'createdAt', 'settledAt']);
    const b = record(o.buyer, ['name', 'email', 'mobile']);
    return {
      orderId: matching(o.orderId, UUID), checkoutId: matching(o.checkoutId, UUID), title: text(o.title, 120), optionKey: matching(o.optionKey, KEY),
      buyer: { name: text(b.name, 120), email: matching(b.email, EMAIL), mobile: b.mobile === null ? null : matching(b.mobile, MOBILE) },
      participants: list(o.participants, FAMILY_CHECKOUT_LIMITS.participants).map(entry2 => {
        const p = record(entry2, ['name', 'answers']);
        return { name: text(p.name, 120), answers: answers(p.answers) };
      }),
      addOnKeys: list(o.addOnKeys, FAMILY_CHECKOUT_LIMITS.addOns).map(k => matching(k, KEY)), waiverAccepted: bool(o.waiverAccepted),
      amountMinor: minor(o.amountMinor), currency: matching(o.currency, CURRENCY), status: oneOf(o.status, FAMILY_CHECKOUT_ORDER_STATUSES),
      createdAt: instant(o.createdAt), settledAt: o.settledAt === null ? null : instant(o.settledAt),
    };
  }), o => o.orderId) };
}
