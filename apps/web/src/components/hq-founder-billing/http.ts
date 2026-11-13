import {
  SAAS_COMMANDS, SAAS_PAID_REVIEW_RESOLVE_CONFIRMATION, SAAS_PAID_REVIEW_VERIFY_CONFIRMATION, saasUuid,
  validateSaasFounderPoolHqView, validateSaasPaidReviewCursor, validateSaasPaidReviewQueue, validateSaasPaidReviewResolveInput,
  validateSaasPaidReviewResolveReceipt, validateSaasPaidReviewVerifyInput, validateSaasPaidReviewVerifyReceipt,
  type SaasFounderPoolHqView, type SaasPaidReviewItem, type SaasPaidReviewQueue, type SaasPaidReviewResolveReceipt, type SaasPaidReviewVerifyReceipt,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * HQ founder billing (0237 paid review queue, 0279 founder pool). Reads send only Accept; the database decides who may read
 * (HQ owner or billing operator). The two HQ owner commands record a refund owed and verify the provider refund evidence
 * HON already stored. Neither executes a provider refund, charges or reserves a spot (`providerActionExecuted: false`).
 */
export type FounderBillingErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed (only the HQ owner may decide). Nothing changed. */ | 'DENIED'
  /** Read failed. Nothing is assumed. */ | 'UNAVAILABLE'
  /** A response that did not match the contract. */ | 'INVALID'
  /** The item changed since it was read. Nothing changed. */ | 'CHANGED'
  /** Refused by a billing rule (for example the refund evidence is not stored yet). Nothing changed. */ | 'REFUSED'
  /** The outcome is not known. Only the identical request with the same key may be sent again. */ | 'UNKNOWN';
export class FounderBillingError extends Error { constructor(readonly kind: FounderBillingErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;

const RESPONSE_MAX = 2_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;

async function read<T>(path: string, validate: (value: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', signal, headers: { Accept: 'application/json' } });
  } catch (error) { if (signal.aborted) throw error; throw new FounderBillingError('UNAVAILABLE'); }
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new FounderBillingError('SESSION'); }
  if (r.status === 403) throw new FounderBillingError('DENIED');
  if (r.status !== 200 || r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) throw new FounderBillingError('UNAVAILABLE');
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new FounderBillingError('INVALID');
  try {
    const envelope: unknown = JSON.parse(text);
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).length !== 1 || !Object.hasOwn(envelope, 'data')) throw Error();
    return validate((envelope as { data: unknown }).data);
  } catch { throw new FounderBillingError('INVALID'); }
}

/** Definite answers given before any write. Anything else (busy, 5xx, an unknown code) is UNKNOWN. */
export function commandErrorFor(status: number, code: string | null): FounderBillingError {
  if (status === 403) return new FounderBillingError('DENIED', code);
  if (status === 400) return new FounderBillingError('INVALID', code);
  // The database refused before any write (every error rolls back): the item or resolution is no longer there.
  if (status === 404) return new FounderBillingError('CHANGED', code);
  if (status === 409 && code === 'SAAS_VERSION_CONFLICT') return new FounderBillingError('CHANGED', code);
  if (status === 409 && code === 'IDEMPOTENCY_KEY_REUSED') return new FounderBillingError('INVALID', code);
  if (status === 422 && code !== null) return new FounderBillingError('REFUSED', code);
  return new FounderBillingError('UNKNOWN', code);
}
/** Keep the idempotency key only when the same request may be sent again. */
export const keepForRetry = (error: unknown) => !(error instanceof FounderBillingError) || error.kind === 'UNKNOWN';

async function command<T>(path: string, marker: string, body: unknown, key: string, validate: (value: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, { method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': marker, 'Idempotency-Key': key }, body: JSON.stringify(body) });
  } catch (error) { if (signal.aborted) throw error; throw new FounderBillingError('UNKNOWN'); }
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new FounderBillingError('SESSION'); }
  const text = await r.text().catch(() => '');
  if (r.status !== 200) {
    let code: string | null = null;
    try { if (text.length < 4000) { const v: unknown = JSON.parse(text); if (v && typeof v === 'object' && typeof (v as { code?: unknown }).code === 'string') code = (v as { code: string }).code; } } catch { /* never show private bodies */ }
    throw commandErrorFor(r.status, code);
  }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '') || text.length > RESPONSE_MAX) throw new FounderBillingError('UNKNOWN');
  try {
    const envelope: unknown = JSON.parse(text);
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).length !== 1 || !Object.hasOwn(envelope, 'data')) throw Error();
    return validate((envelope as { data: unknown }).data);
  } catch { throw new FounderBillingError('UNKNOWN'); }
}

export type FounderBillingView = { pool: SaasFounderPoolHqView; reviews: SaasPaidReviewQueue };
export const founderBillingApi = {
  /** The 50-spot pool and the first page of money HON holds for review. Two separate reads, not one snapshot. */
  async load(signal: AbortSignal, owned: Owned): Promise<FounderBillingView> {
    const [pool, reviews] = await Promise.all([
      read('/api/v1/hq/saas/founder-pool', validateSaasFounderPoolHqView, signal, owned),
      read('/api/v1/hq/saas/paid-reviews', validateSaasPaidReviewQueue, signal, owned),
    ]);
    return { pool, reviews };
  },
  /** The next page of the review queue, after the cursor the server returned. */
  async more(cursor: string, signal: AbortSignal, owned: Owned): Promise<SaasPaidReviewQueue> {
    let c: string | null;
    try { c = validateSaasPaidReviewCursor(cursor); } catch { throw new FounderBillingError('INVALID'); }
    if (c === null) throw new FounderBillingError('INVALID');
    return read(`/api/v1/hq/saas/paid-reviews?cursor=${encodeURIComponent(c)}`, validateSaasPaidReviewQueue, signal, owned);
  },
  /** HQ owner: record that the held money is owed back. The receipt must be for exactly this item. */
  async recordRefundOwed(item: SaasPaidReviewItem, reason: string, key: string, signal: AbortSignal, owned: Owned): Promise<SaasPaidReviewResolveReceipt> {
    let body;
    try {
      body = validateSaasPaidReviewResolveInput({ subjectKind: item.subjectKind, subjectId: item.subjectId, expectedVersion: item.subjectVersion,
        decision: 'REFUND_OWED', reason: reason.trim(), confirmation: SAAS_PAID_REVIEW_RESOLVE_CONFIRMATION });
      saasUuid(key);
    } catch { throw new FounderBillingError('INVALID'); }
    const receipt = await command('/api/v1/hq/saas/paid-reviews/resolve', SAAS_COMMANDS.resolvePaidReview, body, key, validateSaasPaidReviewResolveReceipt, signal, owned);
    if (receipt.resolution.subjectId !== item.subjectId || receipt.resolution.subjectKind !== item.subjectKind || receipt.resolution.organizationId !== item.organizationId)
      throw new FounderBillingError('UNKNOWN');
    return receipt;
  },
  /** HQ owner: check the provider refund evidence HON already stored. Executes nothing at the provider. */
  async verifyRefund(item: SaasPaidReviewItem, key: string, signal: AbortSignal, owned: Owned): Promise<SaasPaidReviewVerifyReceipt> {
    const r = item.openResolution;
    if (!r || r.status !== 'AWAITING_REFUND_EVIDENCE') throw new FounderBillingError('INVALID');
    let body;
    try { body = validateSaasPaidReviewVerifyInput({ expectedVersion: r.version, confirmation: SAAS_PAID_REVIEW_VERIFY_CONFIRMATION }); saasUuid(key); saasUuid(r.resolutionId); }
    catch { throw new FounderBillingError('INVALID'); }
    const receipt = await command(`/api/v1/hq/saas/paid-reviews/${r.resolutionId}/verify-refund`, SAAS_COMMANDS.verifyPaidReviewRefund, body, key, validateSaasPaidReviewVerifyReceipt, signal, owned);
    if (receipt.resolution.resolutionId !== r.resolutionId) throw new FounderBillingError('UNKNOWN');
    return receipt;
  },
};
export type FounderBillingApi = typeof founderBillingApi;
