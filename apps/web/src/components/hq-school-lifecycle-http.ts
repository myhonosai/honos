import { HQ_SCHOOL_LIFECYCLE_COMMAND, validateHqSchoolArchiveDates, validateHqSchoolLifecycleReceipt,
  type HqSchoolArchiveDates, type HqSchoolLifecycleInput, type HqSchoolLifecycleReceipt } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from './session-invalidation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const options = { credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' } as const;

export type HqSchoolLifecycleFailure = 'signedOut' | 'forbidden' | 'nameMismatch' | 'changed' | 'billingActive' | 'unknown' | 'unavailable';
export class HqSchoolLifecycleError extends Error {
  constructor(readonly reason: HqSchoolLifecycleFailure) { super(reason); }
}

/** Archived schools with their erase dates. Any failure returns no dates; the list still works. */
export async function loadHqSchoolArchiveDates(signal: AbortSignal): Promise<HqSchoolArchiveDates> {
  const response = await fetch('/api/v1/hq/school-archives', { ...options, method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  if (!response.ok) throw new HqSchoolLifecycleError('unavailable');
  const root = await response.json() as { data?: unknown };
  if (!root || typeof root !== 'object' || Object.keys(root).join() !== 'data') throw new HqSchoolLifecycleError('unavailable');
  return validateHqSchoolArchiveDates(root.data);
}

/** One HQ command. The same key is reused when the person retries an unknown outcome. */
export async function sendHqSchoolLifecycle(schoolId: string, input: HqSchoolLifecycleInput, key: string): Promise<HqSchoolLifecycleReceipt> {
  if (!UUID.test(schoolId) || !UUID.test(key)) throw new HqSchoolLifecycleError('unavailable');
  let response: Response;
  try {
    response = await fetch(`/api/v1/hq/schools/${encodeURIComponent(schoolId)}/lifecycle`, { ...options, method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': HQ_SCHOOL_LIFECYCLE_COMMAND, 'Idempotency-Key': key },
      body: JSON.stringify(input), signal: AbortSignal.timeout(15000) });
  } catch { throw new HqSchoolLifecycleError('unknown'); }
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new HqSchoolLifecycleError('signedOut'); }
  if (!response.ok) {
    let code = '';
    try { code = String(((await response.json()) as { code?: unknown }).code ?? ''); } catch { /* keep generic */ }
    if (response.status === 403) throw new HqSchoolLifecycleError('forbidden');
    if (code === 'HQ_SCHOOL_LIFECYCLE_NAME_MISMATCH') throw new HqSchoolLifecycleError('nameMismatch');
    if (code === 'HQ_SCHOOL_LIFECYCLE_BILLING_ACTIVE') throw new HqSchoolLifecycleError('billingActive');
    if (code === 'HQ_SCHOOL_LIFECYCLE_STATUS_CONFLICT' || response.status === 404) throw new HqSchoolLifecycleError('changed');
    if (code === 'HQ_SCHOOL_LIFECYCLE_OUTCOME_UNKNOWN' || response.status >= 500) throw new HqSchoolLifecycleError('unknown');
    throw new HqSchoolLifecycleError('unavailable');
  }
  try {
    const root = await response.json() as { data?: unknown };
    const receipt = validateHqSchoolLifecycleReceipt(root.data);
    if (receipt.schoolId !== schoolId.toLowerCase() || receipt.action !== input.action) throw new Error('mismatch');
    return receipt;
  } catch { throw new HqSchoolLifecycleError('unknown'); }
}
