import {
  SCHOOL_NUMBER_CANCEL_COMMAND, SCHOOL_NUMBER_ORDER_COMMAND, verifySchoolNumberOrder, verifySchoolNumberOrderList, verifySchoolNumberSearchResult,
  type SchoolNumberOrder, type SchoolNumberSearch, type SchoolNumberSearchResult,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * The school's own texting number (0352). Reads are plain same-origin GETs; ordering and cancelling each send their own
 * X-HON-Human-Command and an Idempotency-Key, so an order whose outcome is unknown is sent again only with the same key.
 * The server decides who may do this, quotes the price itself and buys nothing: HON HQ approves each order first.
 */
export type NumberErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed for this person at this school. Nothing was done. */ | 'DENIED'
  /** Buying numbers is not switched on yet. Nothing was done. */ | 'OFF'
  /** That number was just taken, or Twilio no longer offers it. Nothing was ordered. */ | 'TAKEN'
  /** The school already has a number or an order, or the order changed. Nothing was done; read again. */ | 'CONFLICT'
  /** The order is not available at this school. */ | 'GONE'
  /** Not accepted as written. Nothing was done. */ | 'INVALID'
  /** Twilio or HON did not answer, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class NumberError extends Error { constructor(readonly kind: NumberErrorKind, readonly code: string | null = null) { super(kind); } }
export type NumberScope = Readonly<{ organizationId: string; schoolId: string }>;
export type Owned = () => boolean;

const RESPONSE_MAX = 500_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NANP = /^\+1[2-9][0-9]{9}$/;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function base(scope: NumberScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new NumberError('INVALID');
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/communications/numbers`;
}
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
  return (value as { data: unknown }).data;
}
async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  let r: Response;
  try {
    r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
      ...(command ? { body: command.body } : {}) });
  } catch (error) { if (signal.aborted && !command) throw error; throw new NumberError('UNKNOWN'); }
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new NumberError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new NumberError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}

const CONFLICTS = new Set(['SCHOOL_NUMBER_EXISTS', 'NUMBER_ORDER_UNSETTLED', 'NUMBER_ORDER_OPEN', 'NUMBER_ORDER_NOT_CANCELLABLE', 'VERSION_CONFLICT']);
/** Only these exact answers are definitive; anything else (busy, 5xx, drift) is UNKNOWN. */
export function numberErrorFor(status: number, code: string | null): NumberError {
  if (status === 403) return new NumberError('DENIED', code);
  if (status === 404) return new NumberError('GONE', code);
  if (status === 400) return new NumberError('INVALID', code);
  if (status === 503 && code === 'NUMBER_PROVISIONING_OFF') return new NumberError('OFF', code);
  if (status === 409 && code === 'NUMBER_UNAVAILABLE') return new NumberError('TAKEN', code);
  if (status === 409 && code !== null && CONFLICTS.has(code)) return new NumberError('CONFLICT', code);
  if (status === 409 && code === 'IDEMPOTENCY_KEY_REUSED') return new NumberError('INVALID', code);
  return new NumberError('UNKNOWN', code);
}
async function read<T>(path: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  const answer = await exchange(path, signal, owned);
  if (answer.status !== 200) throw numberErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new NumberError('UNKNOWN'); }
}
async function command<T>(path: string, name: string, body: unknown, key: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new NumberError('INVALID');
  const answer = await exchange(path, signal, owned, { name, body: JSON.stringify(body), key });
  if (answer.status !== 200) throw numberErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new NumberError('UNKNOWN'); }
}

export type SearchDraft = Readonly<{ mode: 'AREA' | 'CITY'; areaCode: string; city: string; region: string }>;
/** A 3-digit area code, or a city and a 2-letter state, exactly as the server accepts them; null when not ready. */
export function searchQuery(input: SearchDraft): SchoolNumberSearch | null {
  if (input.mode === 'AREA') return /^[2-9][0-9]{2}$/.test(input.areaCode) ? { areaCode: input.areaCode } : null;
  const city = input.city.trim(), region = input.region.trim().toUpperCase();
  return /^[A-Za-z][A-Za-z .'-]{1,59}$/.test(city) && /^[A-Z]{2}$/.test(region) ? { city, region } : null;
}

export const numberApi = {
  /** This school's number orders, oldest first (up to 200). */
  async orders(scope: NumberScope, signal: AbortSignal, owned: Owned): Promise<SchoolNumberOrder[]> {
    return read(`${base(scope)}/orders`, (v) => {
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).join(',') !== 'orders') throw new Error('shape');
      return verifySchoolNumberOrderList((v as { orders: unknown }).orders);
    }, signal, owned);
  },
  /** Numbers Twilio offers now, with this school's open order and whether it already has its own number. */
  async search(scope: NumberScope, query: SchoolNumberSearch, signal: AbortSignal, owned: Owned): Promise<SchoolNumberSearchResult> {
    const params = new URLSearchParams('areaCode' in query ? { areaCode: query.areaCode } : { city: query.city, region: query.region });
    return read(`${base(scope)}/search?${params.toString()}`, verifySchoolNumberSearchResult, signal, owned);
  },
  /** Ask HON to buy this number. The server quotes the price itself; nothing is bought until HQ approves. */
  async order(scope: NumberScope, phoneE164: string, key: string, signal: AbortSignal, owned: Owned): Promise<SchoolNumberOrder> {
    if (!NANP.test(phoneE164)) throw new NumberError('INVALID');
    return command(`${base(scope)}/orders`, SCHOOL_NUMBER_ORDER_COMMAND, { phoneE164 }, key, (v) => {
      const o = verifySchoolNumberOrder(v);
      if (o.phoneE164 !== phoneE164 || o.schoolId.toLowerCase() !== scope.schoolId.toLowerCase()) throw new Error('order');
      return o;
    }, signal, owned);
  },
  /** Cancel an order HON has not started buying. */
  async cancel(scope: NumberScope, orderId: string, expectedVersion: number, key: string, signal: AbortSignal, owned: Owned): Promise<SchoolNumberOrder> {
    if (!UUID.test(orderId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new NumberError('INVALID');
    return command(`${base(scope)}/orders/${orderId.toLowerCase()}/cancel`, SCHOOL_NUMBER_CANCEL_COMMAND, { expectedVersion }, key, (v) => {
      const o = verifySchoolNumberOrder(v);
      if (o.orderId.toLowerCase() !== orderId.toLowerCase()) throw new Error('order');
      return o;
    }, signal, owned);
  },
};
export type NumberApi = typeof numberApi;

/** A failed command may be sent again with the same key only when its outcome is not known. */
export const keepForRetry = (error: unknown) => !(error instanceof NumberError) || error.kind === 'UNKNOWN';

/** The order that still holds this school: not finished, or failed with an outcome HQ has not settled. */
export function openOrderOf(orders: readonly SchoolNumberOrder[]): SchoolNumberOrder | null {
  return [...orders].reverse().find((o) => ['REQUESTED', 'APPROVED', 'PURCHASING'].includes(o.status) || (o.status === 'FAILED' && o.outcomeUnknown)) ?? null;
}
export const formatPhone = (e164: string) => NANP.test(e164) ? `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}` : e164;
export function formatMonthly(locale: string, micro: number): string {
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(micro / 1_000_000); } catch { return `$${(micro / 1_000_000).toFixed(2)}`; }
}
