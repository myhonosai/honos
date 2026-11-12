import { validateMayaAtRiskQuery, verifyMayaAtRiskStudents, type MayaAtRiskStudents } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * Maya, students at risk (M1, 0259). One read-only GET with no Idempotency-Key and no x-hon header. The server decides
 * every permission (retention.review.read at the verified school) and whether tuition may be shown.
 */
export type MayaErrorKind = 'SESSION' | 'DENIED' | 'INVALID' | 'RATE' | 'UNKNOWN';
export class MayaError extends Error { constructor(readonly kind: MayaErrorKind) { super(kind); } }
export type Owned = () => boolean;
export type MayaScope = Readonly<{ organizationId: string; schoolId: string }>;

const RESPONSE_MAX = 1_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(value: string): string { if (!UUID.test(value)) throw new MayaError('INVALID'); return value.toLowerCase(); }

export function mayaErrorFor(status: number): MayaError {
  if (status === 403) return new MayaError('DENIED');
  if (status === 400) return new MayaError('INVALID');
  if (status === 429) return new MayaError('RATE');
  return new MayaError('UNKNOWN');
}

export const mayaApi = {
  /** The school's students at risk, highest score first, 50 per page. */
  async atRisk(scope: MayaScope, after: string | null, signal: AbortSignal, owned: Owned): Promise<MayaAtRiskStudents> {
    let query;
    try { query = validateMayaAtRiskQuery(after === null ? {} : { after }); } catch { throw new MayaError('INVALID'); }
    const search = query.after ? `?${new URLSearchParams({ after: query.after }).toString()}` : '';
    const path = `/api/v1/organizations/${id(scope.organizationId)}/schools/${id(scope.schoolId)}/retention/at-risk${search}`;
    let response: Response;
    try {
      response = await fetch(path, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
        signal, headers: { Accept: 'application/json' } });
    } catch (error) { if (signal.aborted) throw error; throw new MayaError('UNKNOWN'); }
    // A retired request (aborted, or no longer the one shown) never ends a newer session.
    signal.throwIfAborted();
    if (response.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new MayaError('SESSION'); }
    if (response.status !== 200) throw mayaErrorFor(response.status);
    if (response.redirected || !JSON_TYPE.test(response.headers.get('content-type') ?? '')) throw new MayaError('UNKNOWN');
    const text = await response.text();
    if (text.length > RESPONSE_MAX) throw new MayaError('UNKNOWN');
    try {
      const value = JSON.parse(text) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
      return verifyMayaAtRiskStudents((value as { data: unknown }).data);
    } catch { throw new MayaError('UNKNOWN'); }
  },
};
export type MayaApi = typeof mayaApi;
