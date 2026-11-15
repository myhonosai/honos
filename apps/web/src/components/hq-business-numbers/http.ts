import { HQ_BUSINESS_MONTHS_MAX, validateHqBusinessNumbers, type HqBusinessNumbers } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * HQ business numbers (B-HQ-3, 0326). One read through the SaaS read guard: same origin, GET, declared query only,
 * no-store. The database decides who may read (HQ owner, or HQ operator with hq.billing.manage) on every read. Numbers are
 * shown only as the verified answer gives them.
 */
export type BusinessErrorKind = 'SESSION' | 'DENIED' | 'INVALID' | 'UNKNOWN';
export class BusinessError extends Error {
  constructor(readonly kind: BusinessErrorKind) { super(kind); }
}
export type Owned = () => boolean;
const RESPONSE_MAX = 200_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;

export const businessApi = {
  async numbers(months: number, signal: AbortSignal, owned: Owned): Promise<HqBusinessNumbers> {
    if (!Number.isInteger(months) || months < 1 || months > HQ_BUSINESS_MONTHS_MAX) throw new BusinessError('INVALID');
    let r: Response;
    try {
      r = await fetch(`/api/v1/hq/saas/business-numbers?months=${months}`, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store',
        redirect: 'error', referrerPolicy: 'no-referrer', signal, headers: { Accept: 'application/json' } });
    } catch (error) { if (signal.aborted) throw error; throw new BusinessError('UNKNOWN'); }
    signal.throwIfAborted();
    if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new BusinessError('SESSION'); }
    if (r.status === 403) throw new BusinessError('DENIED');
    if (r.status === 400) throw new BusinessError('INVALID');
    if (r.status !== 200 || r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) throw new BusinessError('UNKNOWN');
    const text = await r.text();
    if (text.length > RESPONSE_MAX) throw new BusinessError('UNKNOWN');
    let view: HqBusinessNumbers;
    try {
      const value = JSON.parse(text) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'data')) throw new Error('shape');
      view = validateHqBusinessNumbers((value as { data: unknown }).data);
    } catch { throw new BusinessError('UNKNOWN'); }
    // The answer must be for the month count that was asked for.
    if (view.monthsRequested !== months) throw new BusinessError('UNKNOWN');
    return view;
  },
};
export type BusinessApi = typeof businessApi;
