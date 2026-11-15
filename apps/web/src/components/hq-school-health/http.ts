import { saasUuid, validateHqSchoolHealth, validateHqSchoolsNeedingAttention, type HqSchoolHealth, type HqSchoolsNeedingAttention } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * HQ school health (B-HQ-2b, 0327). Two reads through the SaaS read guard: same origin, GET, declared query only, no-store.
 * The database decides who may read (HQ owner, HQ operator with hq.billing.manage, or HQ staff with hq.support.manage) on
 * every read. Counts and signals are shown only as the verified answer gives them.
 */
export type HealthErrorKind = 'SESSION' | 'DENIED' | 'GONE' | 'INVALID' | 'UNKNOWN';
export class HealthError extends Error {
  constructor(readonly kind: HealthErrorKind) { super(kind); }
}
export type Owned = () => boolean;
const RESPONSE_MAX = 2_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;

async function readJson<T>(url: string, signal: AbortSignal, owned: Owned, validate: (value: unknown) => T): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', signal, headers: { Accept: 'application/json' } });
  } catch (error) { if (signal.aborted) throw error; throw new HealthError('UNKNOWN'); }
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new HealthError('SESSION'); }
  if (r.status === 403) throw new HealthError('DENIED');
  if (r.status === 404) throw new HealthError('GONE');
  if (r.status === 400) throw new HealthError('INVALID');
  if (r.status !== 200 || r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) throw new HealthError('UNKNOWN');
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new HealthError('UNKNOWN');
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'data')) throw new Error('shape');
    return validate((value as { data: unknown }).data);
  } catch { throw new HealthError('UNKNOWN'); }
}

export const healthApi = {
  async school(schoolId: string, signal: AbortSignal, owned: Owned): Promise<HqSchoolHealth> {
    let id: string;
    try { id = saasUuid(schoolId); } catch { throw new HealthError('INVALID'); }
    const view = await readJson(`/api/v1/hq/saas/schools/${id}/health`, signal, owned, validateHqSchoolHealth);
    // The answer must be about the school that was asked for.
    if (view.schoolId.toLowerCase() !== id) throw new HealthError('UNKNOWN');
    return view;
  },
  async attention(limit: number, signal: AbortSignal, owned: Owned): Promise<HqSchoolsNeedingAttention> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HealthError('INVALID');
    const view = await readJson(`/api/v1/hq/saas/schools/needing-attention?limit=${limit}`, signal, owned, validateHqSchoolsNeedingAttention);
    if (view.limit !== limit) throw new HealthError('UNKNOWN');
    return view;
  },
};
export type HealthApi = typeof healthApi;
