import { saasUuid, validateHqSchoolDetail, type HqSchoolDetail } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * HQ school detail (C-HQ-3, 0225). One read through the SaaS read guard: same origin, GET, no query string, no-store.
 * The database decides HQ authority on every read (HQ owner, or an HQ operator with hq.billing.manage). The page never
 * infers access, ownership or counts; it shows only what the verified answer says.
 */
export type SchoolDetailErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not an HQ reader. Nothing is shown. */ | 'DENIED'
  /** No such school. */ | 'GONE'
  /** The school id in the link is not valid. */ | 'INVALID'
  /** Could not be read or checked. Nothing is shown. */ | 'UNKNOWN';
export class SchoolDetailError extends Error {
  constructor(readonly kind: SchoolDetailErrorKind) { super(kind); }
}
export type Owned = () => boolean;
const RESPONSE_MAX = 1_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;

/** Lower-case school id for the path, or null when the link is not a school id. */
export function schoolDetailId(value: unknown): string | null {
  try { return saasUuid(value); } catch { return null; }
}

export const schoolDetailApi = {
  async read(schoolId: string, signal: AbortSignal, owned: Owned): Promise<HqSchoolDetail> {
    const id = schoolDetailId(schoolId);
    if (!id) throw new SchoolDetailError('INVALID');
    let r: Response;
    try {
      r = await fetch(`/api/v1/hq/saas/schools/${id}`, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
        referrerPolicy: 'no-referrer', signal, headers: { Accept: 'application/json' } });
    } catch (error) { if (signal.aborted) throw error; throw new SchoolDetailError('UNKNOWN'); }
    signal.throwIfAborted();
    if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new SchoolDetailError('SESSION'); }
    if (r.status === 403) throw new SchoolDetailError('DENIED');
    if (r.status === 404) throw new SchoolDetailError('GONE');
    if (r.status === 400) throw new SchoolDetailError('INVALID');
    if (r.status !== 200 || r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) throw new SchoolDetailError('UNKNOWN');
    const text = await r.text();
    if (text.length > RESPONSE_MAX) throw new SchoolDetailError('UNKNOWN');
    let view: HqSchoolDetail;
    try {
      const value = JSON.parse(text) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'data')) throw new Error('shape');
      view = validateHqSchoolDetail((value as { data: unknown }).data);
    } catch { throw new SchoolDetailError('UNKNOWN'); }
    // The answer must be about the school that was asked for.
    if (view.school.schoolId.toLowerCase() !== id) throw new SchoolDetailError('UNKNOWN');
    return view;
  },
};
export type SchoolDetailApi = typeof schoolDetailApi;
