/**
 * B-TUI-2 shared one-time payment (0458): one whole payment of a server-decided amount on the school's own processor
 * (Stripe Connect direct charge or Square), TEST/SANDBOX mode only, used by the family checkout page, the walk-in kiosk
 * tablet and the point of sale. A caller's own database function opens it; the API starts it at the processor and
 * records only what the processor itself answers on retrieval. HON takes no fee.
 */
import { SCHOOL_PAY_PROVIDER_CODES, type SchoolPayProviderCode } from './school-payments.js';

export const SCHOOL_PAY_ONCE_STATES = ['OPEN', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELED'] as const;
export type SchoolPayOnceState = (typeof SCHOOL_PAY_ONCE_STATES)[number];
/** States that are final: the payment never changes again. */
export const SCHOOL_PAY_ONCE_SETTLED_STATES: readonly SchoolPayOnceState[] = ['SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELED'];
export const SCHOOL_PAY_ONCE_SOURCES = ['CHECKOUT_PAGE', 'WALKIN_VISIT', 'POS_SALE'] as const;
export type SchoolPayOnceSource = (typeof SCHOOL_PAY_ONCE_SOURCES)[number];
/** EMBEDDED: the processor's form inside a HON page (Stripe embedded Checkout). HOSTED: the processor's own page (a QR or link). */
export const SCHOOL_PAY_ONCE_SURFACES = ['EMBEDDED', 'HOSTED'] as const;
export type SchoolPayOnceSurface = (typeof SCHOOL_PAY_ONCE_SURFACES)[number];
export const SCHOOL_PAY_ONCE_FAILURE_CLASSES = ['DECLINED', 'OTHER'] as const;
export type SchoolPayOnceFailureClass = (typeof SCHOOL_PAY_ONCE_FAILURE_CLASSES)[number];
/** What a processor can say about one session on retrieval (CANCELED is HON's name for a session it expired on request). */
export const SCHOOL_PAY_ONCE_OUTCOMES = ['OPEN', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'EXPIRED'] as const;
export type SchoolPayOnceOutcome = (typeof SCHOOL_PAY_ONCE_OUTCOMES)[number];

export interface SchoolPayOncePayment {
  paymentId: string; source: SchoolPayOnceSource; sourceId: string; providerCode: SchoolPayProviderCode; amountMinor: number; currency: string; label: string;
  state: SchoolPayOnceState; surface: SchoolPayOnceSurface | null; failureClass: SchoolPayOnceFailureClass | null; platformFee: 'NONE'; version: number;
  expiresAt: string; createdAt: string; updatedAt: string; settledAt: string | null;
}
/** API-internal: what the API needs to call the processor. Never sent to a browser. */
export interface SchoolPayOnceContext {
  payment: SchoolPayOncePayment;
  provider: { providerCode: SchoolPayProviderCode; accountRef: string; connectionState: string };
  payerEmail: string | null; returnUrl: string | null; sessionRef: string | null; providerExpiresAt: string | null;
}
/** What the processor said about one session (adapter output, checked before it is recorded). */
export interface SchoolPayOnceObservation {
  outcome: SchoolPayOnceOutcome; sessionRef: string; paymentRef: string | null; failureClass: SchoolPayOnceFailureClass | null; amountMinor: number; currency: string;
}
/**
 * What a caller hands its page to show the processor's form. EMBEDDED Stripe: `clientSecret` for embedded Checkout and
 * `accountRef` for Stripe.js (`stripeAccount`, a direct charge on the school's account). HOSTED: `url` of the processor's page.
 */
export interface SchoolPayOnceStart {
  paymentId: string; providerCode: SchoolPayProviderCode; surface: SchoolPayOnceSurface; clientSecret: string | null; url: string | null;
  accountRef: string | null; expiresAt: string;
}
/** What a caller learns after confirm or cancel: the recorded state only. */
export interface SchoolPayOnceResult { paymentId: string; state: SchoolPayOnceState; amountMinor: number; currency: string; settledAt: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CURRENCY = /^[A-Z]{3}$/;
const PROVIDER_REF = /^[A-Za-z0-9_:-]{3,100}$/;
const ACCOUNT_REF = /^[A-Za-z0-9_-]{3,100}$/;
const RETURN_URL = /^https?:\/\/[^\s\x00-\x1f\x7f]+$/;
const MAX_AMOUNT = 5_000_000_000;

function invalid(): never { throw new Error('Invalid school one-time payment data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (keys.some(key => !(key in row)) || Object.keys(row).some(key => !keys.includes(key))) invalid();
  return row;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value.toLowerCase(); }
function count(value: unknown, minimum: number, maximum = 999_999_999): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function instant(value: unknown): string {
  if (typeof value !== 'string' || !INSTANT.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
function matching(value: unknown, pattern: RegExp, maximum = 2000): string { if (typeof value !== 'string' || value.length > maximum || !pattern.test(value)) invalid(); return value; }
function nullable<T>(value: unknown, read: (value: unknown) => T): T | null { return value === null ? null : read(value); }
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(); return value as T; }
function label(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 120 || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) invalid();
  return value;
}

/** A payment id as a caller passes it. */
export function validateSchoolPayOnceId(value: unknown): string { return uuid(value); }

/** An observation as the record command accepts it: success carries the payment id, failure its class. */
export function verifySchoolPayOnceObservation(value: unknown, expect: { amountMinor?: number; currency?: string; sessionRef?: string } = {}): SchoolPayOnceObservation {
  const row = record(value, ['outcome', 'sessionRef', 'paymentRef', 'failureClass', 'amountMinor', 'currency']);
  const observation: SchoolPayOnceObservation = {
    outcome: oneOf(row.outcome, SCHOOL_PAY_ONCE_OUTCOMES), sessionRef: matching(row.sessionRef, PROVIDER_REF), paymentRef: nullable(row.paymentRef, v => matching(v, PROVIDER_REF)),
    failureClass: nullable(row.failureClass, v => oneOf(v, SCHOOL_PAY_ONCE_FAILURE_CLASSES)), amountMinor: count(row.amountMinor, 1, MAX_AMOUNT),
    currency: matching(row.currency, CURRENCY),
  };
  if ((observation.outcome === 'FAILED') !== (observation.failureClass !== null)) invalid();
  if ((observation.outcome === 'SUCCEEDED') !== (observation.paymentRef !== null)) invalid();
  if ((expect.amountMinor !== undefined && observation.amountMinor !== expect.amountMinor) || (expect.currency !== undefined && observation.currency !== expect.currency)
    || (expect.sessionRef !== undefined && observation.sessionRef !== expect.sessionRef)) invalid();
  return observation;
}

// Output verifiers: every database response is checked strictly before it is used or reaches a caller.
export function verifySchoolPayOncePayment(value: unknown, paymentId?: string): SchoolPayOncePayment {
  const row = record(value, ['paymentId', 'source', 'sourceId', 'providerCode', 'amountMinor', 'currency', 'label', 'state', 'surface', 'failureClass',
    'platformFee', 'version', 'expiresAt', 'createdAt', 'updatedAt', 'settledAt']);
  const payment: SchoolPayOncePayment = {
    paymentId: uuid(row.paymentId), source: oneOf(row.source, SCHOOL_PAY_ONCE_SOURCES), sourceId: uuid(row.sourceId),
    providerCode: oneOf(row.providerCode, SCHOOL_PAY_PROVIDER_CODES), amountMinor: count(row.amountMinor, 1, MAX_AMOUNT), currency: matching(row.currency, CURRENCY),
    label: label(row.label), state: oneOf(row.state, SCHOOL_PAY_ONCE_STATES), surface: nullable(row.surface, v => oneOf(v, SCHOOL_PAY_ONCE_SURFACES)),
    failureClass: nullable(row.failureClass, v => oneOf(v, SCHOOL_PAY_ONCE_FAILURE_CLASSES)), platformFee: oneOf(row.platformFee, ['NONE'] as const),
    version: count(row.version, 1), expiresAt: instant(row.expiresAt), createdAt: instant(row.createdAt), updatedAt: instant(row.updatedAt),
    settledAt: nullable(row.settledAt, instant),
  };
  if ((payment.state === 'FAILED') !== (payment.failureClass !== null)) invalid();
  if (SCHOOL_PAY_ONCE_SETTLED_STATES.includes(payment.state) !== (payment.settledAt !== null)) invalid();
  if ((payment.state === 'PROCESSING' || payment.state === 'SUCCEEDED') && payment.surface === null) invalid();
  if (paymentId !== undefined && payment.paymentId !== paymentId.toLowerCase()) invalid();
  return payment;
}
export function verifySchoolPayOnceContext(value: unknown, paymentId?: string): SchoolPayOnceContext {
  const row = record(value, ['payment', 'provider', 'payerEmail', 'returnUrl', 'sessionRef', 'providerExpiresAt']);
  const payment = verifySchoolPayOncePayment(row.payment, paymentId);
  const p = record(row.provider, ['providerCode', 'accountRef', 'connectionState']);
  const context: SchoolPayOnceContext = {
    payment,
    provider: { providerCode: oneOf(p.providerCode, SCHOOL_PAY_PROVIDER_CODES), accountRef: matching(p.accountRef, ACCOUNT_REF),
      connectionState: oneOf(p.connectionState, ['PENDING_ONBOARDING', 'CONNECTED_RESTRICTED', 'CONNECTED_ACTIVE', 'REAUTHORIZATION_REQUIRED', 'DISCONNECTED', 'ABANDONED'] as const) },
    payerEmail: nullable(row.payerEmail, v => matching(v, /^[^@\s\x00-\x1f\x7f]+@[^@\s\x00-\x1f\x7f]+\.[^@\s\x00-\x1f\x7f]+$/, 254)),
    returnUrl: nullable(row.returnUrl, v => matching(v, RETURN_URL)), sessionRef: nullable(row.sessionRef, v => matching(v, PROVIDER_REF)),
    providerExpiresAt: nullable(row.providerExpiresAt, instant),
  };
  if (context.provider.providerCode !== payment.providerCode) invalid();
  if ((payment.surface === null) !== (context.returnUrl === null) || (payment.surface === null) !== (context.providerExpiresAt === null)) invalid();
  if (context.sessionRef !== null && payment.surface === null) invalid();
  return context;
}
export function verifySchoolPayOnceReceipt(value: unknown, paymentId?: string): { payment: SchoolPayOncePayment } {
  const row = record(value, ['payment']);
  return { payment: verifySchoolPayOncePayment(row.payment, paymentId) };
}
export function verifySchoolPayOnceDue(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) invalid();
  const ids = value.map(uuid);
  if (new Set(ids).size !== ids.length) invalid();
  return ids;
}
