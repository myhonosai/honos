import { SAAS_COMMANDS, SCHOOL_NUMBER_ORDER_STATUSES, verifyHqSchoolNumberOrder, verifyHqSchoolNumberOrderList, type HqSchoolNumberOrder, type SchoolNumberOrderStatus } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * HQ school number orders (0352, 0358). The list is a SaaS read (HQ owner or operator); approve, reject and settle are
 * SaaS human commands that only a human HQ owner may run. Every command carries the order version the person saw, so a
 * repeat after a lost answer is refused as a version conflict and can never act twice. Nothing here buys a number.
 */
export type HqNumberErrorKind = 'SESSION' | 'DENIED' | 'CONFLICT' | 'GONE' | 'INVALID' | 'UNKNOWN';
export class HqNumberError extends Error { constructor(readonly kind: HqNumberErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;

const ROOT = '/api/v1/hq/saas/school-number-orders';
const RESPONSE_MAX = 2_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HQ_NOTE_MAX = 500;
/** What the server accepts as a note: 1 to 500 characters with no leading or trailing spaces. */
export const noteOk = (v: string) => v.length >= 1 && v.length <= HQ_NOTE_MAX && v === v.trim();
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;

async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string }>): Promise<{ status: number; value: unknown }> {
  let r: Response;
  try {
    r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name } : {}) },
      ...(command ? { body: command.body } : {}) });
  } catch (error) { if (signal.aborted && !command) throw error; throw new HqNumberError('UNKNOWN'); }
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new HqNumberError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new HqNumberError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join(',') !== 'data') throw new Error('shape');
  return (value as { data: unknown }).data;
}
/** Only these exact answers are definitive; anything else is UNKNOWN. */
export function hqNumberErrorFor(status: number, code: string | null): HqNumberError {
  if (status === 403) return new HqNumberError('DENIED', code);
  if (status === 404) return new HqNumberError('GONE', code);
  if (status === 400) return new HqNumberError('INVALID', code);
  if (status === 409) return new HqNumberError('CONFLICT', code);
  return new HqNumberError('UNKNOWN', code);
}
async function command(orderId: string, verb: 'decision' | 'settle', name: string, body: unknown, signal: AbortSignal, owned: Owned): Promise<HqSchoolNumberOrder> {
  if (!UUID.test(orderId)) throw new HqNumberError('INVALID');
  const answer = await exchange(`${ROOT}/${orderId.toLowerCase()}/${verb}`, signal, owned, { name, body: JSON.stringify(body) });
  if (answer.status !== 200) throw hqNumberErrorFor(answer.status, codeOf(answer.value));
  try {
    const o = verifyHqSchoolNumberOrder(data(answer.value));
    if (o.orderId.toLowerCase() !== orderId.toLowerCase()) throw new Error('order');
    return o;
  } catch { throw new HqNumberError('UNKNOWN'); }
}
const version = (v: number) => { if (!Number.isSafeInteger(v) || v < 1) throw new HqNumberError('INVALID'); return v; };

export const hqNumberApi = {
  /** Up to 200 orders across all schools, oldest first, optionally one status only. */
  async list(status: SchoolNumberOrderStatus | null, signal: AbortSignal, owned: Owned): Promise<HqSchoolNumberOrder[]> {
    if (status !== null && !SCHOOL_NUMBER_ORDER_STATUSES.includes(status)) throw new HqNumberError('INVALID');
    const answer = await exchange(status ? `${ROOT}?status=${status}` : ROOT, signal, owned);
    if (answer.status !== 200) throw hqNumberErrorFor(answer.status, codeOf(answer.value));
    try {
      const v = data(answer.value);
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).join(',') !== 'orders') throw new Error('shape');
      const orders = verifyHqSchoolNumberOrderList((v as { orders: unknown }).orders);
      if (status && orders.some((o) => o.status !== status)) throw new Error('filter');
      return orders;
    } catch { throw new HqNumberError('UNKNOWN'); }
  },
  /** Approve (lets the purchase worker buy it once buying is switched on) or reject with a reason the school sees. */
  async decide(orderId: string, decision: 'APPROVE' | 'REJECT', note: string, expectedVersion: number, signal: AbortSignal, owned: Owned): Promise<HqSchoolNumberOrder> {
    if (decision === 'REJECT' ? !noteOk(note) : note !== '' && !noteOk(note)) throw new HqNumberError('INVALID');
    return command(orderId, 'decision', SAAS_COMMANDS.decideSchoolNumberOrder,
      { decision, expectedVersion: version(expectedVersion), ...(note === '' ? {} : { note }) }, signal, owned);
  },
  /** Record what the school's Twilio subaccount shows for an order whose purchase outcome is unknown. */
  async settle(orderId: string, finding: 'BOUGHT' | 'NOT_BOUGHT', note: string, expectedVersion: number, signal: AbortSignal, owned: Owned): Promise<HqSchoolNumberOrder> {
    if (!noteOk(note)) throw new HqNumberError('INVALID');
    return command(orderId, 'settle', SAAS_COMMANDS.settleSchoolNumberOrder, { expectedVersion: version(expectedVersion), finding, note }, signal, owned);
  },
};
export type HqNumberApi = typeof hqNumberApi;
