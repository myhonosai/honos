import { accountUuid, validateHqSchoolOwnership, validateSchoolOwnerOwnershipView, validateSchoolOwnershipReceipt, validateSetPrimaryOwnerInput,
  type HqSchoolOwnership, type SchoolOwnerOwnershipView, type SchoolOwnershipReceipt } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * School ownership (B-ID-4, 0223). Reads and the one command go through the owner-account guard: same origin, no query
 * string, and no x-hon-* header other than the command's own. The server decides every authority again (HQ owner for the HQ
 * read and command; a live owner of that school for the owner read). The UI never infers an owner, a primary or an HQ seat.
 */
export type OwnershipErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed (not the HQ owner, or not an owner of this school). Nothing is shown. */ | 'DENIED'
  /** The school is not available to this reader. */ | 'GONE'
  /** The chosen owner is no longer a live owner. Nothing changed. */ | 'NOT_LIVE'
  /** The request was not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Too many requests. Nothing was sent this time; the same request can be tried again later. */ | 'RATE'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be tried again. */ | 'UNKNOWN';
export class OwnershipError extends Error {
  constructor(readonly kind: OwnershipErrorKind, readonly code: string | null = null) { super(kind); }
}
/** Whether the caller still stands behind this request. A 401 for a retired request must not end the newer session. */
export type Owned = () => boolean;
const RESPONSE_MAX = 1_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;

async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(`/api/v1/${path}`, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': 'school-owner-account', 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new OwnershipError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new OwnershipError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'data')) throw new Error('shape');
  return (value as { data: unknown }).data;
}

/** What a refused answer means. Only these exact answers are definitive; anything else (409 busy, 5xx, drift) is UNKNOWN. */
export function ownershipErrorFor(status: number, code: string | null): OwnershipError {
  if (status === 403) return new OwnershipError('DENIED', code);
  if (status === 404 && code === 'OWNERSHIP_OWNER_NOT_LIVE') return new OwnershipError('NOT_LIVE', code);
  if (status === 404) return new OwnershipError('GONE', code);
  if (status === 400) return new OwnershipError('INVALID', code);
  if (status === 429) return new OwnershipError('RATE', code);
  return new OwnershipError('UNKNOWN', code);
}
const schoolPath = (schoolId: string) => { try { return accountUuid(schoolId).toLowerCase(); } catch { throw new OwnershipError('INVALID'); } };
async function read<T>(path: string, schoolId: string, verify: (v: unknown) => T & { schoolId: string }, signal: AbortSignal, owned: Owned): Promise<T> {
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned); }
  catch (error) { if (error instanceof OwnershipError || signal.aborted) throw error; throw new OwnershipError('UNKNOWN'); }
  if (answer.status !== 200) { const e = ownershipErrorFor(answer.status, codeOf(answer.value)); throw e.kind === 'NOT_LIVE' ? new OwnershipError('GONE', e.code) : e; }
  let view: T & { schoolId: string };
  try { view = verify(data(answer.value)); } catch { throw new OwnershipError('UNKNOWN'); }
  // The answer must be about the school that was asked for.
  if (view.schoolId.toLowerCase() !== schoolId) throw new OwnershipError('UNKNOWN');
  return view;
}

export const ownershipApi = {
  /** HQ owner: the school's owners, its primary, HQ seats and the 50 newest notices. */
  async hqRead(schoolId: string, signal: AbortSignal, owned: Owned): Promise<HqSchoolOwnership> {
    const id = schoolPath(schoolId);
    return read(`hq/schools/${id}/ownership`, id, validateHqSchoolOwnership, signal, owned);
  },
  /** A live owner of this school: its owners, which one is the reader, the primary and notices. */
  async ownerRead(schoolId: string, signal: AbortSignal, owned: Owned): Promise<SchoolOwnerOwnershipView> {
    const id = schoolPath(schoolId);
    return read(`account/schools/${id}/ownership`, id, validateSchoolOwnerOwnershipView, signal, owned);
  },
  /** HQ owner: make a live non-HQ owner the primary. The same key and body replay the first receipt. */
  async setPrimary(input: { schoolId: string; ownerGrantId: string }, key: string, signal: AbortSignal, owned: Owned): Promise<SchoolOwnershipReceipt> {
    let body: { schoolId: string; ownerGrantId: string }, k: string;
    try { body = validateSetPrimaryOwnerInput(input); k = accountUuid(key); } catch { throw new OwnershipError('INVALID'); }
    let answer: { status: number; value: unknown };
    try { answer = await exchange('hq/school-ownership/primary-owner', signal, owned, { body: JSON.stringify(body), key: k }); }
    catch (error) { if (error instanceof OwnershipError) throw error; throw new OwnershipError('UNKNOWN'); }
    if (answer.status !== 200) throw ownershipErrorFor(answer.status, codeOf(answer.value));
    try {
      const receipt = validateSchoolOwnershipReceipt(data(answer.value));
      if (receipt.schoolId.toLowerCase() !== body.schoolId.toLowerCase() || receipt.primaryOwnerGrantId.toLowerCase() !== body.ownerGrantId.toLowerCase()) throw new Error('mismatch');
      return receipt;
    } catch { throw new OwnershipError('UNKNOWN'); }
  },
};
export type OwnershipApi = typeof ownershipApi;

/** Whether a failed command may be retried with the same key: only when its outcome is not known or it was not sent (rate limit). */
export const keepForRetry = (error: unknown) => !(error instanceof OwnershipError) || error.kind === 'UNKNOWN' || error.kind === 'RATE';
