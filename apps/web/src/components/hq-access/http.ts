import { SAAS_COMMANDS, encodeSaasAccessOverviewCursor, saasUuid, validateSaasAccessExceptionGrantInput, validateSaasAccessExceptionGrantReceipt,
  validateSaasAccessExceptionRevokeInput, validateSaasAccessExceptionRevokeReceipt, validateSaasAccessOverview,
  type SaasAccessExceptionGrantInput, type SaasAccessExceptionGrantReceipt, type SaasAccessExceptionRevokeReceipt, type SaasAccessOverview,
  type SaasAccessOverviewCursor, type SaasAccessOverviewStatus } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * HQ access overview (B-HQ-1) and the existing D9 exception commands. The overview is advisory; the database decides
 * every grant and revoke again (HQ owner only, policy, eligibility, window, version).
 */
export type AccessErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not an HQ reader (overview) or not the HQ owner (commands). */ | 'DENIED'
  /** The row changed since it was read (version, exception already active, ended, entitlement in effect...). Re-read. */ | 'CHANGED'
  /** A rule refused it (window, length, policy). Nothing was granted or revoked. */ | 'REFUSED'
  /** The request was not accepted as sent. */ | 'INVALID'
  /** The outcome is not known. Retry only the identical request with the same key. */ | 'UNKNOWN';
export class AccessOverviewError extends Error {
  constructor(readonly kind: AccessErrorKind, readonly code: string | null = null) { super(kind); }
}
const RESPONSE_MAX = 2_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
/** Answers that mean the row is no longer what was read. Nothing was changed by this request. */
const CHANGED = new Set(['SAAS_VERSION_CONFLICT', 'SAAS_TRANSITION_NOT_ALLOWED', 'SAAS_ACCESS_EXCEPTION_ACTIVE', 'SAAS_ENTITLEMENT_IN_EFFECT',
  'SAAS_EXCEPTION_ENDED', 'SAAS_SUBSCRIPTION_EXISTS', 'SAAS_ENTITLEMENT_NOT_ACTIVE', 'SAAS_ENTITLEMENT_MISMATCH',
  /** 0186 grant: the school already has an access state, or a checkout is open. */ 'SAAS_ACCESS_STATE_EXISTS', 'SAAS_CHECKOUT_OPEN']);
/** Rule refusals raised before any write (0185/0186). The policy ones can change later, but this attempt is over. */
export const POLICY_REFUSALS = new Set(['SAAS_EXCEPTION_POLICY_REQUIRED', 'SAAS_POLICY_UNDECIDED']);
const REFUSED = new Set(['SAAS_EXCEPTION_WINDOW_INVALID', 'SAAS_EXCEPTION_TOO_LONG', ...POLICY_REFUSALS]);

/**
 * Whether the caller still stands behind this request (the same mounted view, not concealed since, and for a command the
 * same kept request). A 401 for a request that was retired must not end the newer session that replaced it.
 */
export type Owned = () => boolean;
async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ marker: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.marker, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new AccessOverviewError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new AccessOverviewError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'data')) throw new Error('shape');
  return (value as { data: unknown }).data;
}

/** What a refused command means. Only these exact answers are definitive; anything else is UNKNOWN. */
export function commandErrorFor(status: number, code: string | null): AccessOverviewError {
  if (status === 403) return new AccessOverviewError('DENIED', code);
  if (status === 400) return new AccessOverviewError('INVALID', code);
  if (status === 404 && code === 'SAAS_UNAVAILABLE') return new AccessOverviewError('CHANGED', code);
  if ((status === 409 || status === 422) && code !== null && CHANGED.has(code)) return new AccessOverviewError('CHANGED', code);
  if (status === 422 && code !== null && REFUSED.has(code)) return new AccessOverviewError('REFUSED', code);
  return new AccessOverviewError('UNKNOWN', code);
}

export type OverviewPageRequest = Readonly<{ status: SaasAccessOverviewStatus | null; cursor: SaasAccessOverviewCursor | null }>;
export const accessApi = {
  async overview(request: OverviewPageRequest, signal: AbortSignal, owned: Owned): Promise<SaasAccessOverview> {
    const q = new URLSearchParams();
    if (request.status) q.set('status', request.status);
    if (request.cursor) q.set('cursor', encodeSaasAccessOverviewCursor(request.cursor));
    q.set('limit', '25');
    const { status, value } = await exchange(`/api/v1/hq/saas/access-overview?${q}`, signal, owned);
    if (status === 403) throw new AccessOverviewError('DENIED', codeOf(value));
    if (status !== 200) throw new AccessOverviewError('UNKNOWN', codeOf(value));
    let view: SaasAccessOverview;
    try { view = validateSaasAccessOverview(data(value)); } catch { throw new AccessOverviewError('UNKNOWN'); }
    if (request.status && view.organizations.some(o => o.accessStatus !== request.status)) throw new AccessOverviewError('UNKNOWN');
    return view;
  },
  /** One grant attempt. The same key and body replay the saved answer; a second grant is refused by the database. */
  async grant(organizationId: string, input: SaasAccessExceptionGrantInput, key: string, signal: AbortSignal, owned: Owned): Promise<SaasAccessExceptionGrantReceipt> {
    const org = saasUuid(organizationId), body = validateSaasAccessExceptionGrantInput(input);
    const answer = await command(`/api/v1/hq/saas/organizations/${org}/access-exceptions`, SAAS_COMMANDS.grantAccessException, body, key, signal, owned);
    try {
      const receipt = validateSaasAccessExceptionGrantReceipt(answer), x = receipt.exception;
      if (x.organizationId.toLowerCase() !== org.toLowerCase() || x.schoolId.toLowerCase() !== body.schoolId.toLowerCase() || x.purpose !== body.purpose
        || x.scopeTier !== body.scopeTier || x.reason !== body.reason || Date.parse(x.startsAt) !== Date.parse(body.startsAt)
        || Date.parse(x.expiresAt) !== Date.parse(body.expiresAt)) throw new Error('mismatch');
      return receipt;
    } catch { throw new AccessOverviewError('UNKNOWN'); }
  },
  async revoke(exceptionId: string, reason: string, key: string, signal: AbortSignal, owned: Owned): Promise<SaasAccessExceptionRevokeReceipt> {
    const id = saasUuid(exceptionId), body = validateSaasAccessExceptionRevokeInput({ reason });
    const answer = await command(`/api/v1/hq/saas/access-exceptions/${id}/revoke`, SAAS_COMMANDS.revokeAccessException, body, key, signal, owned);
    try {
      const receipt = validateSaasAccessExceptionRevokeReceipt(answer);
      if (receipt.exception.exceptionId.toLowerCase() !== id.toLowerCase() || receipt.exception.endNote !== body.reason) throw new Error('mismatch');
      return receipt;
    } catch { throw new AccessOverviewError('UNKNOWN'); }
  },
};
async function command(path: string, marker: string, body: object, key: string, signal: AbortSignal, owned: Owned): Promise<unknown> {
  const k = saasUuid(key);
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned, { marker, body: JSON.stringify(body), key: k }); }
  catch (error) { if (error instanceof AccessOverviewError) throw error; throw new AccessOverviewError('UNKNOWN'); }
  if (answer.status !== 200) throw commandErrorFor(answer.status, codeOf(answer.value));
  try { return data(answer.value); } catch { throw new AccessOverviewError('UNKNOWN'); }
}
export type AccessApi = typeof accessApi;
