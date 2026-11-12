import {
  validateSaasFounderPoolHqView, validateSaasPaidReviewQueue,
  type SaasFounderPoolHqView, type SaasPaidReviewQueue,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * HQ founder billing reads (0237 paid review queue, 0279 founder pool). GET only, Accept header only. The database decides
 * who may read (HQ owner or billing operator). Nothing here resolves a review, refunds, charges or reserves a spot.
 */
export type FounderBillingErrorKind = 'SESSION' | 'DENIED' | 'UNAVAILABLE' | 'INVALID';
export class FounderBillingError extends Error { constructor(readonly kind: FounderBillingErrorKind) { super(kind); } }
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
};
export type FounderBillingApi = typeof founderBillingApi;
