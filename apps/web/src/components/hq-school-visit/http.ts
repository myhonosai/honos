import { HQ_SCHOOL_VISIT_COMMAND, validateHqSchoolVisitEnterReceipt, validateHqSchoolVisitLeaveReceipt, validateHqSchoolVisits,
  type HqSchoolVisitEnterReceipt, type HqSchoolVisitLeaveReceipt, type HqSchoolVisits } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const options = { credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' } as const;

export type HqSchoolVisitFailure = 'signedOut' | 'forbidden' | 'unavailable' | 'unknown';
export class HqSchoolVisitError extends Error {
  constructor(readonly reason: HqSchoolVisitFailure) { super(reason); }
}

async function command(schoolId: string, kind: 'enter' | 'leave', body: object, key: string): Promise<unknown> {
  if (!UUID.test(schoolId) || !UUID.test(key)) throw new HqSchoolVisitError('unavailable');
  let response: Response;
  try {
    response = await fetch(`/api/v1/hq/schools/${encodeURIComponent(schoolId)}/${kind}`, { ...options, method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': HQ_SCHOOL_VISIT_COMMAND, 'Idempotency-Key': key },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  } catch { throw new HqSchoolVisitError('unknown'); }
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new HqSchoolVisitError('signedOut'); }
  if (!response.ok) {
    let code = '';
    try { code = String(((await response.json()) as { code?: unknown }).code ?? ''); } catch { /* keep generic */ }
    if (response.status === 403) throw new HqSchoolVisitError('forbidden');
    if (code === 'HQ_SCHOOL_VISIT_OUTCOME_UNKNOWN' || response.status >= 500) throw new HqSchoolVisitError('unknown');
    throw new HqSchoolVisitError('unavailable');
  }
  try { return ((await response.json()) as { data?: unknown }).data; }
  catch { throw new HqSchoolVisitError('unknown'); }
}

/** Go inside a school for 4 hours. The same key is reused when the person retries an unknown outcome. */
export async function enterSchoolAsHq(schoolId: string, key: string, reason?: string): Promise<HqSchoolVisitEnterReceipt> {
  const data = await command(schoolId, 'enter', reason?.trim() ? { reason: reason.trim() } : {}, key);
  try {
    const receipt = validateHqSchoolVisitEnterReceipt(data);
    if (receipt.schoolId !== schoolId.toLowerCase()) throw new Error('mismatch');
    return receipt;
  } catch { throw new HqSchoolVisitError('unknown'); }
}

/** Leave the school now. */
export async function leaveSchoolAsHq(schoolId: string, key: string): Promise<HqSchoolVisitLeaveReceipt> {
  const data = await command(schoolId, 'leave', {}, key);
  try {
    const receipt = validateHqSchoolVisitLeaveReceipt(data);
    if (receipt.schoolId !== schoolId.toLowerCase()) throw new Error('mismatch');
    return receipt;
  } catch { throw new HqSchoolVisitError('unknown'); }
}

/** The signed-in person's own live visits. Any failure means "no banner". */
export async function readMyHqSchoolVisits(signal: AbortSignal): Promise<HqSchoolVisits> {
  const response = await fetch('/api/v1/hq/school-visits', { ...options, method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
  if (!response.ok) throw new HqSchoolVisitError('unavailable');
  const root = await response.json() as { data?: unknown };
  if (!root || typeof root !== 'object' || Object.keys(root).join() !== 'data') throw new HqSchoolVisitError('unavailable');
  return validateHqSchoolVisits(root.data);
}
