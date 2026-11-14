import {
  SOCIAL_ACCOUNT_CHANGE_COMMAND, SOCIAL_CONNECT_COMMAND, SOCIAL_CONNECT_COMPLETE_COMMAND, validateSocialAccountChangeInput, validateSocialConnectCompleteInput,
  validateSocialConnectInput, verifySocialAccountChange, verifySocialAccountList, verifySocialConnectResult, verifySocialConnectStart,
  type SocialAccountChange, type SocialAccountChangeInput, type SocialAccountList, type SocialConnectResult, type SocialConnectStart, type SocialPlatform,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * School social connections (0347). The list is a plain same-origin GET; connect, complete and change each send their
 * own X-HON-Human-Command and an Idempotency-Key. The server decides the permission and whether connecting is turned
 * on. Nothing here is authority.
 */
export type SocialErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed for this person at this school. Nothing changed. */ | 'DENIED'
  /** Connecting is not turned on for HON OS yet. Nothing changed. */ | 'NOT_ENABLED'
  /** The connection link was used, is someone else's, or expired. Nothing changed. */ | 'STATE'
  /** Someone changed this account first. Nothing changed. */ | 'STALE'
  /** The account is disconnected or gone. Nothing changed. */ | 'GONE'
  /** Too many attempts. Nothing changed. */ | 'LIMIT'
  /** Zernio did not answer. Nothing was connected. */ | 'PROVIDER'
  /** Not accepted as written. Nothing changed. */ | 'INVALID'
  /** Busy, or the outcome is not known. Only the identical change (same key) may be sent again. */ | 'UNKNOWN';
export class SocialError extends Error { constructor(readonly kind: SocialErrorKind, readonly code: string | null = null) { super(kind); } }
export type SocialScope = Readonly<{ organizationId: string; schoolId: string }>;
export type Owned = () => boolean;

const RESPONSE_MAX = 2_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function base(scope: SocialScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new SocialError('INVALID');
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/marketing/social`;
}
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
  return (value as { data: unknown }).data;
}
async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new SocialError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new SocialError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
/** Only these exact answers are definitive; anything else (busy, 5xx, drift) is UNKNOWN. */
export function socialErrorFor(status: number, code: string | null): SocialError {
  if (status === 403) return new SocialError('DENIED', code);
  if (status === 404) return new SocialError('GONE', code);
  if (status === 429) return new SocialError('LIMIT', code);
  if (status === 502 && code === 'SOCIAL_PROVIDER_UNAVAILABLE') return new SocialError('PROVIDER', code);
  if (status === 503 && code === 'SOCIAL_CONNECT_NOT_ENABLED') return new SocialError('NOT_ENABLED', code);
  if (status === 400 && (code === 'SOCIAL_CONNECT_STATE_INVALID' || code === 'SOCIAL_CONNECT_STATE_EXPIRED')) return new SocialError('STATE', code);
  if (status === 400) return new SocialError('INVALID', code);
  if (status === 409 && code === 'SOCIAL_VERSION_CONFLICT') return new SocialError('STALE', code);
  if (status === 409 && code === 'SOCIAL_ACCOUNT_DISCONNECTED') return new SocialError('GONE', code);
  if (status === 409 && (code === 'IDEMPOTENCY_KEY_REUSED' || code === 'IDEMPOTENCY_KEY_REQUIRED' || code === 'SOCIAL_PROFILE_CONFLICT')) return new SocialError('INVALID', code);
  return new SocialError('UNKNOWN', code);
}
async function command<T>(path: string, name: string, body: unknown, key: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new SocialError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof SocialError) throw error; throw new SocialError('UNKNOWN'); }
  if (answer.status !== 200) throw socialErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new SocialError('UNKNOWN'); }
}
function checked<T>(validate: () => T): T { try { return validate(); } catch { throw new SocialError('INVALID'); } }

export const socialApi = {
  async list(scope: SocialScope, signal: AbortSignal, owned: Owned): Promise<SocialAccountList> {
    const path = `${base(scope)}/accounts`;
    let answer: { status: number; value: unknown };
    try { answer = await exchange(path, signal, owned); }
    catch (error) { if (error instanceof SocialError || signal.aborted) throw error; throw new SocialError('UNKNOWN'); }
    if (answer.status !== 200) throw socialErrorFor(answer.status, codeOf(answer.value));
    try { return verifySocialAccountList(data(answer.value)); } catch { throw new SocialError('UNKNOWN'); }
  },
  /** Starts a connection and returns the consent page to open. The state stays only in that link. */
  async connect(scope: SocialScope, platform: SocialPlatform, key: string, signal: AbortSignal, owned: Owned): Promise<SocialConnectStart> {
    return command(`${base(scope)}/connect`, SOCIAL_CONNECT_COMMAND, checked(() => validateSocialConnectInput({ platform })), key, verifySocialConnectStart, signal, owned);
  },
  async complete(scope: SocialScope, state: string, key: string, signal: AbortSignal, owned: Owned): Promise<SocialConnectResult> {
    return command(`${base(scope)}/connect/complete`, SOCIAL_CONNECT_COMPLETE_COMMAND, checked(() => validateSocialConnectCompleteInput({ state })), key, verifySocialConnectResult, signal, owned);
  },
  async change(scope: SocialScope, accountId: string, input: SocialAccountChangeInput, key: string, signal: AbortSignal, owned: Owned): Promise<SocialAccountChange> {
    if (!UUID.test(accountId)) throw new SocialError('INVALID');
    return command(`${base(scope)}/accounts/${accountId.toLowerCase()}`, SOCIAL_ACCOUNT_CHANGE_COMMAND, checked(() => validateSocialAccountChangeInput(input)), key, (v) => {
      const r = verifySocialAccountChange(v);
      if (r.account.accountId.toLowerCase() !== accountId.toLowerCase()) throw new Error('account');
      return r;
    }, signal, owned);
  },
};
export type SocialApi = typeof socialApi;

/** A failed change may be sent again with the same key only when its outcome is not known. */
export const keepForRetry = (error: unknown) => !(error instanceof SocialError) || error.kind === 'UNKNOWN';
