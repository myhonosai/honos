import {
  validateSaveCheckoutPageInput, verifyCheckoutPageReceipt, verifySchoolCheckoutPages,
  type CheckoutPageReceipt, type SaveCheckoutPageInput, type SchoolCheckoutPages,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * The school's checkout page settings (B-TUI-2 piece 9b over 0269). The read sends no Idempotency-Key; the save sends its own
 * X-HON-Human-Command and an Idempotency-Key. The server decides the permission, the plans and the version again. Nothing
 * here charges anyone or talks to a payment provider, and HON adds no fee.
 */
export type CheckoutErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed for this staff member at this school. Nothing changed. */ | 'DENIED'
  /** Someone saved this page since it was read. Nothing changed. */ | 'CHANGED'
  /** A chosen plan is not an available plan of this school. Nothing changed. */ | 'PLAN_UNAVAILABLE'
  /** A published enrollment page needs at least one plan. Nothing changed. */ | 'PLANS_REQUIRED'
  /** The request was not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Too many requests. Nothing changed; the same request may be sent again later. */ | 'RATE'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class CheckoutError extends Error { constructor(readonly kind: CheckoutErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;
export type CheckoutScope = Readonly<{ organizationId: string; schoolId: string }>;
export const CHECKOUT_SAVE_COMMAND = 'school_checkout.page.save';

const RESPONSE_MAX = 1_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function envelope(value: unknown): { data: unknown; meta: Record<string, unknown> } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
  const meta = (value as { meta: unknown }).meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('shape');
  return { data: (value as { data: unknown }).data, meta: meta as Record<string, unknown> };
}
function id(value: string): string { if (!UUID.test(value)) throw new CheckoutError('INVALID'); return value.toLowerCase(); }
function path(scope: CheckoutScope): string { return `/api/v1/organizations/${id(scope.organizationId)}/schools/${id(scope.schoolId)}/payments/checkout-pages`; }

async function exchange(url: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(url, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': CHECKOUT_SAVE_COMMAND, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  // A retired request (aborted, or no longer the one shown) never ends a newer session.
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new CheckoutError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new CheckoutError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}

/** What a refused answer means. Only these exact answers are definitive; anything else (busy, 5xx, drift) is UNKNOWN. */
export function checkoutErrorFor(status: number, code: string | null): CheckoutError {
  if (status === 403) return new CheckoutError('DENIED', code);
  if (status === 400) return new CheckoutError('INVALID', code);
  if (status === 429) return new CheckoutError('RATE', code);
  if (status === 422 && code === 'CHECKOUT_PLAN_UNAVAILABLE') return new CheckoutError('PLAN_UNAVAILABLE', code);
  if (status === 422 && code === 'CHECKOUT_PLANS_REQUIRED') return new CheckoutError('PLANS_REQUIRED', code);
  if (status === 409 && code === 'VERSION_CONFLICT') return new CheckoutError('CHANGED', code);
  if (status === 409 && code === 'IDEMPOTENCY_KEY_REUSED') return new CheckoutError('INVALID', code);
  // SCHOOL_CHECKOUT_CONFLICT (a lock wait), IDEMPOTENCY_IN_PROGRESS, 5xx: the same request may be sent again.
  return new CheckoutError('UNKNOWN', code);
}

export const checkoutApi = {
  /** Both checkout pages of this school (or null where none was saved yet) and the plans that may be shown. */
  async pages(scope: CheckoutScope, signal: AbortSignal, owned: Owned): Promise<SchoolCheckoutPages> {
    const url = path(scope);
    let answer: { status: number; value: unknown };
    try { answer = await exchange(url, signal, owned); }
    catch (error) { if (error instanceof CheckoutError || signal.aborted) throw error; throw new CheckoutError('UNKNOWN'); }
    if (answer.status !== 200) throw checkoutErrorFor(answer.status, codeOf(answer.value));
    try { return verifySchoolCheckoutPages(envelope(answer.value).data); } catch { throw new CheckoutError('UNKNOWN'); }
  },
  /** Save one page as a draft or published. The receipt must be the next version of that same kind. */
  async save(scope: CheckoutScope, input: SaveCheckoutPageInput, key: string, signal: AbortSignal, owned: Owned): Promise<CheckoutPageReceipt> {
    const url = path(scope);
    if (typeof key !== 'string' || !UUID.test(key)) throw new CheckoutError('INVALID');
    let body: SaveCheckoutPageInput;
    try { body = validateSaveCheckoutPageInput(input); } catch { throw new CheckoutError('INVALID'); }
    let answer: { status: number; value: unknown };
    try { answer = await exchange(url, signal, owned, { body: JSON.stringify(body), key }); }
    catch (error) { if (error instanceof CheckoutError) throw error; throw new CheckoutError('UNKNOWN'); }
    if (answer.status !== 200) throw checkoutErrorFor(answer.status, codeOf(answer.value));
    try {
      const receipt = verifyCheckoutPageReceipt(envelope(answer.value).data, { kind: body.kind, version: body.expectedVersion + 1 });
      if (receipt.page.status !== body.status) throw new Error('status');
      return receipt;
    } catch { throw new CheckoutError('UNKNOWN'); }
  },
};
export type CheckoutApi = typeof checkoutApi;

/** Whether a failed save may be sent again with the same key: only when its outcome is not known, or nothing was sent (rate limit). */
export const keepForRetry = (error: unknown) => !(error instanceof CheckoutError) || error.kind === 'UNKNOWN' || error.kind === 'RATE';
