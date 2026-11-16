import {
  validateSaveCheckoutPageInput, validateSaveCheckoutSettingsInput, verifyCheckoutPageReceipt, verifyCheckoutSettingsReceipt, verifySchoolCheckoutPages,
  type CheckoutPageReceipt, type CheckoutSettingsReceipt, type SaveCheckoutPageInput, type SaveCheckoutSettingsInput, type SchoolCheckoutPages,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * The school's checkout pages (checkout CP2 over 0402). The read sends no Idempotency-Key; each save sends its own
 * X-HON-Human-Command and an Idempotency-Key. The server decides the permission, the plans and the version again. Nothing
 * here charges anyone or talks to a payment provider, and HON adds no fee.
 */
export type CheckoutErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed for this staff member at this school. Nothing changed. */ | 'DENIED'
  /** Someone saved this page since it was read. Nothing changed. */ | 'CHANGED'
  /** A chosen plan is not an available plan of this school. Nothing changed. */ | 'PLAN_UNAVAILABLE'
  /** A published page needs at least one pricing option. Nothing changed. */ | 'OPTIONS_REQUIRED'
  /** The page address is used by another page of this school. Nothing changed. */ | 'SLUG_TAKEN'
  /** The page group no longer exists. Nothing changed. */ | 'GROUP_UNKNOWN'
  /** A group still used by a page cannot be removed. Nothing changed. */ | 'GROUP_IN_USE'
  /** The page is not a page of this school (or the address changed). Nothing changed. */ | 'NOT_FOUND'
  /** The school already has the most pages allowed. Nothing changed. */ | 'LIMIT'
  /** The request was not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Too many requests. Nothing changed; the same request may be sent again later. */ | 'RATE'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class CheckoutError extends Error { constructor(readonly kind: CheckoutErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;
export type CheckoutScope = Readonly<{ organizationId: string; schoolId: string }>;
export const CHECKOUT_SAVE_COMMAND = 'school_checkout.page.save';
export const CHECKOUT_SETTINGS_COMMAND = 'school_checkout.settings.save';

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

async function exchange(url: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ body: string; key: string; name: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(url, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
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
  if (status === 422) {
    const kind = ({ CHECKOUT_OPTIONS_REQUIRED: 'OPTIONS_REQUIRED', CHECKOUT_SLUG_TAKEN: 'SLUG_TAKEN', CHECKOUT_SLUG_FIXED: 'NOT_FOUND', CHECKOUT_NOT_FOUND: 'NOT_FOUND',
      CHECKOUT_GROUP_UNKNOWN: 'GROUP_UNKNOWN', CHECKOUT_GROUP_IN_USE: 'GROUP_IN_USE', CHECKOUT_LIMIT_REACHED: 'LIMIT' } as const)[code ?? ''];
    if (kind) return new CheckoutError(kind as CheckoutErrorKind, code);
  }
  if (status === 409 && code === 'VERSION_CONFLICT') return new CheckoutError('CHANGED', code);
  if (status === 409 && code === 'IDEMPOTENCY_KEY_REUSED') return new CheckoutError('INVALID', code);
  // SCHOOL_CHECKOUT_CONFLICT (a lock wait), IDEMPOTENCY_IN_PROGRESS, 5xx: the same request may be sent again.
  return new CheckoutError('UNKNOWN', code);
}

async function command<T>(url: string, name: string, body: unknown, key: string, signal: AbortSignal, owned: Owned, verify: (data: unknown) => T): Promise<T> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new CheckoutError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(url, signal, owned, { body: JSON.stringify(body), key, name }); }
  catch (error) { if (error instanceof CheckoutError) throw error; throw new CheckoutError('UNKNOWN'); }
  if (answer.status !== 200) throw checkoutErrorFor(answer.status, codeOf(answer.value));
  try { return verify(envelope(answer.value).data); } catch { throw new CheckoutError('UNKNOWN'); }
}

export const checkoutApi = {
  /** The school's groups and staff order, every checkout page in that order, and the plans an option may name. */
  async pages(scope: CheckoutScope, signal: AbortSignal, owned: Owned): Promise<SchoolCheckoutPages> {
    const url = path(scope);
    let answer: { status: number; value: unknown };
    try { answer = await exchange(url, signal, owned); }
    catch (error) { if (error instanceof CheckoutError || signal.aborted) throw error; throw new CheckoutError('UNKNOWN'); }
    if (answer.status !== 200) throw checkoutErrorFor(answer.status, codeOf(answer.value));
    try { return verifySchoolCheckoutPages(envelope(answer.value).data); } catch { throw new CheckoutError('UNKNOWN'); }
  },
  /** Create (no page id, version 0) or replace one page. The receipt must be the next version of that page, with the status sent. */
  async save(scope: CheckoutScope, input: SaveCheckoutPageInput, key: string, signal: AbortSignal, owned: Owned): Promise<CheckoutPageReceipt> {
    let body: SaveCheckoutPageInput;
    try { body = validateSaveCheckoutPageInput(input); } catch { throw new CheckoutError('INVALID'); }
    return command(path(scope), CHECKOUT_SAVE_COMMAND, body, key, signal, owned, (data) => {
      const receipt = verifyCheckoutPageReceipt(data, { pageId: body.pageId, slug: body.slug, version: body.expectedVersion + 1 });
      if (receipt.page.status !== body.status || receipt.page.groupKey !== body.groupKey) throw new Error('drift');
      return receipt;
    });
  },
  /** Save the groups and the staff order of the page grid. */
  async saveSettings(scope: CheckoutScope, input: SaveCheckoutSettingsInput, key: string, signal: AbortSignal, owned: Owned): Promise<CheckoutSettingsReceipt> {
    let body: SaveCheckoutSettingsInput;
    try { body = validateSaveCheckoutSettingsInput(input); } catch { throw new CheckoutError('INVALID'); }
    return command(`${path(scope)}/settings`, CHECKOUT_SETTINGS_COMMAND, body, key, signal, owned,
      (data) => verifyCheckoutSettingsReceipt(data, { version: body.expectedVersion + 1 }));
  },
};
export type CheckoutApi = typeof checkoutApi;

/** Whether a failed save may be sent again with the same key: only when its outcome is not known, or nothing was sent (rate limit). */
export const keepForRetry = (error: unknown) => !(error instanceof CheckoutError) || error.kind === 'UNKNOWN' || error.kind === 'RATE';
