import {
  SAAS_COMMANDS, saasUuid, validateSaasExceptionPolicyView, validateSaasAccessExceptionsView,
  validateSaasOrganizationSubscription, validateSaasAccessExceptionGrantInput, validateSaasAccessExceptionRevokeInput,
  validateSaasAccessExceptionGrantReceipt, validateSaasAccessExceptionRevokeReceipt,
  type SaasExceptionPolicyView, type SaasAccessExceptionsView, type SaasOrganizationSubscription,
  type SaasAccessExceptionGrantInput, type SaasAccessExceptionGrantReceipt, type SaasAccessExceptionRevokeReceipt,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

export type Target = Readonly<{ organizationId: string; schoolId: string }>;
export type Snapshot = Readonly<{ policy: SaasExceptionPolicyView; exceptions: SaasAccessExceptionsView; subscription: SaasOrganizationSubscription }>;
export type Capsule = Readonly<{ kind: 'grant' | 'revoke'; principalId: string; target: Target; exceptionId: string | null; path: string; body: string; key: string }>;
export type Receipt = { kind: 'grant'; data: SaasAccessExceptionGrantReceipt } | { kind: 'revoke'; data: SaasAccessExceptionRevokeReceipt };
export interface ExceptionApi { owner(signal: AbortSignal): Promise<string>; read(target: Target, signal: AbortSignal): Promise<Snapshot>; send(request: Capsule): Promise<Receipt> }
export class ExceptionError extends Error {
  constructor(readonly code: string, readonly status = 0) { super(code); }
}
const RULES = new Set(['SAAS_EXCEPTION_POLICY_REQUIRED','SAAS_EXCEPTION_WINDOW_INVALID','SAAS_EXCEPTION_TOO_LONG','SAAS_EXCEPTION_ENDED',
  'SAAS_ENTITLEMENT_IN_EFFECT','SAAS_ACCESS_STATE_EXISTS','SAAS_SUBSCRIPTION_EXISTS','SAAS_CHECKOUT_OPEN','SAAS_ACCESS_EXCEPTION_ACTIVE','SAAS_VERSION_CONFLICT','SAAS_UNAVAILABLE']);
export function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new ExceptionError('INVALID_RESPONSE');
  return value as Record<string, unknown>;
}
export function target(value: Target): Target {
  try { closed(value, ['organizationId','schoolId']); return Object.freeze({ organizationId: saasUuid(value.organizationId), schoolId: saasUuid(value.schoolId) }); }
  catch { throw new ExceptionError('INVALID_INPUT'); }
}
export function prepareGrant(principalId: string, selected: Target, input: SaasAccessExceptionGrantInput): Capsule {
  try {
    const t = target(selected); validateSaasAccessExceptionGrantInput(input);
    if (input.schoolId !== t.schoolId) throw Error();
    return Object.freeze({ kind: 'grant', principalId: saasUuid(principalId), target: t, exceptionId: null,
      path: `/api/v1/hq/saas/organizations/${t.organizationId}/access-exceptions`, body: JSON.stringify(input), key: crypto.randomUUID() });
  } catch { throw new ExceptionError('INVALID_INPUT'); }
}
export function prepareRevoke(principalId: string, selected: Target, exceptionId: string, reason: string): Capsule {
  try {
    const t = target(selected), input = validateSaasAccessExceptionRevokeInput({ reason });
    const id = saasUuid(exceptionId);
    return Object.freeze({ kind: 'revoke', principalId: saasUuid(principalId), target: t, exceptionId: id,
      path: `/api/v1/hq/saas/access-exceptions/${id}/revoke`, body: JSON.stringify(input), key: crypto.randomUUID() });
  } catch { throw new ExceptionError('INVALID_INPUT'); }
}
const options = { credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' } as const;
async function response(response: Response): Promise<unknown> {
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new ExceptionError('SIGNED_OUT', 401); }
  if (response.status === 403) throw new ExceptionError('FORBIDDEN', 403);
  if (!response.ok) {
    const error: unknown = await response.json().catch(() => null);
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && RULES.has(error.code) ? error.code : 'UNAVAILABLE';
    throw new ExceptionError(code, response.status);
  }
  if (response.status !== 200 || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')
    || !/\bno-store\b/i.test(response.headers.get('Cache-Control') ?? '')) throw new ExceptionError('INVALID_RESPONSE');
  const raw = await response.text(); if (raw.length > 1_000_000) throw new ExceptionError('INVALID_RESPONSE');
  return closed(JSON.parse(raw), ['data']).data;
}
async function read<T>(path: string, verify: (value: unknown) => T, signal: AbortSignal): Promise<T> {
  try {
    return verify(await response(await fetch(path, { ...options, method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) })));
  } catch (error) { if (error instanceof ExceptionError) throw error; throw new ExceptionError('UNAVAILABLE'); }
}
export const exceptionApi: ExceptionApi = {
  async owner(signal) {
    // The existing resolver reports principal and HQ role; it does not expose arbitrary capability claims.
    const result = await fetch('/api/v1/hq/session', { ...options, method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    if (result.status === 401) { reportConfirmedSessionInvalidation(); throw new ExceptionError('SIGNED_OUT', 401); }
    if (!result.ok) throw new ExceptionError(result.status === 403 ? 'FORBIDDEN' : 'UNAVAILABLE', result.status);
    try {
      const scope = closed(closed(await result.json(), ['data']).data, ['principalId','hqRole']);
      if (scope.hqRole !== 'HON_HQ_OWNER') throw new ExceptionError('FORBIDDEN', 403);
      return saasUuid(scope.principalId);
    } catch (error) { if (error instanceof ExceptionError) throw error; throw new ExceptionError('INVALID_RESPONSE'); }
  },
  async read(selected, signal) {
    const t = target(selected), base = `/api/v1/hq/saas/organizations/${t.organizationId}`;
    const [policy, exceptions, subscription] = await Promise.all([
      read('/api/v1/hq/saas/access-exception-policy', validateSaasExceptionPolicyView, signal),
      read(`${base}/access-exceptions`, validateSaasAccessExceptionsView, signal),
      read(`${base}/subscription`, validateSaasOrganizationSubscription, signal),
    ]);
    if (exceptions.organizationId !== t.organizationId || subscription.organizationId !== t.organizationId
      || subscription.current && subscription.current.organizationId !== t.organizationId) throw new ExceptionError('INVALID_RESPONSE');
    return { policy, exceptions, subscription };
  },
  async send(request) {
    // Reconstruct the closed immutable command before dispatch; no caller-supplied path or actor becomes authority.
    if (!['grant','revoke'].includes(request.kind)) throw new ExceptionError('INVALID_INPUT');
    const t = target(request.target), input: unknown = JSON.parse(request.body);
    let path: string;
    if (request.kind === 'grant') { validateSaasAccessExceptionGrantInput(input); if ((input as SaasAccessExceptionGrantInput).schoolId !== t.schoolId) throw new ExceptionError('INVALID_INPUT'); path = `/api/v1/hq/saas/organizations/${t.organizationId}/access-exceptions`; }
    else { validateSaasAccessExceptionRevokeInput(input); path = `/api/v1/hq/saas/access-exceptions/${saasUuid(request.exceptionId)}/revoke`; }
    if (request.path !== path) throw new ExceptionError('INVALID_INPUT');
    const value = await response(await fetch(path, { ...options, method: 'POST', body: request.body, signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': saasUuid(request.key),
        'X-HON-Human-Command': request.kind === 'grant' ? SAAS_COMMANDS.grantAccessException : SAAS_COMMANDS.revokeAccessException } }));
    const receipt: Receipt = request.kind === 'grant' ? { kind: 'grant', data: validateSaasAccessExceptionGrantReceipt(value) } : { kind: 'revoke', data: validateSaasAccessExceptionRevokeReceipt(value) };
    const x = receipt.data.exception;
    if (x.organizationId !== t.organizationId || x.schoolId !== t.schoolId || receipt.kind === 'revoke' && (x.exceptionId !== request.exceptionId || x.endedByPrincipalId !== request.principalId || x.endNote !== (input as { reason: string }).reason)
      || receipt.kind === 'grant' && (x.grantedByPrincipalId !== request.principalId || !x.governingPolicy
        || ['schoolId','purpose','reason','scopeTier','startsAt','expiresAt'].some(key => x[key as keyof typeof x] !== (input as Record<string, unknown>)[key]))) throw new ExceptionError('INVALID_RESPONSE');
    return receipt;
  },
};
