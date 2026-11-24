import {
  SUPPORT_MESSAGE_COMMAND, SUPPORT_SUBMIT_COMMAND, validateSupportMessageInput, validateSupportSubmitInput, verifySupportRequest, verifySupportRequestList,
  type SupportMessageInput, type SupportRequest, type SupportRequestList, type SupportSubmitInput,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * School support requests (0335). The list is a plain same-origin GET; asking and writing back each send their own
 * X-HON-Human-Command and an Idempotency-Key, so an unknown outcome is sent again only with the same key. The server
 * decides the permission and what the school may see. Nothing here is authority.
 */
export type SupportErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed for this person at this school. Nothing was sent. */ | 'DENIED'
  /** The request is not available at this school. */ | 'GONE'
  /** The request is closed and takes no more messages. Nothing was sent. */ | 'CLOSED'
  /** Today's limit is reached. Nothing was sent. */ | 'LIMIT'
  /** The request was not accepted as written. Nothing was sent. */ | 'INVALID'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class SupportError extends Error { constructor(readonly kind: SupportErrorKind, readonly code: string | null = null) { super(kind); } }
export type SupportScope = Readonly<{ organizationId: string; schoolId: string }>;
export type Owned = () => boolean;

const RESPONSE_MAX = 2_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function base(scope: SupportScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new SupportError('INVALID');
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/support-requests`;
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
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new SupportError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new SupportError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
/** Only these exact answers are definitive; anything else (busy, 5xx, drift) is UNKNOWN. */
export function supportErrorFor(status: number, code: string | null): SupportError {
  if (status === 403) return new SupportError('DENIED', code);
  if (status === 404) return new SupportError('GONE', code);
  if (status === 429) return new SupportError('LIMIT', code);
  if (status === 400) return new SupportError('INVALID', code);
  if (status === 409 && code === 'SUPPORT_REQUEST_CLOSED') return new SupportError('CLOSED', code);
  if (status === 409 && (code === 'IDEMPOTENCY_KEY_REUSED' || code === 'IDEMPOTENCY_KEY_REQUIRED')) return new SupportError('INVALID', code);
  return new SupportError('UNKNOWN', code);
}
async function command<T>(path: string, name: string, body: unknown, key: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new SupportError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof SupportError) throw error; throw new SupportError('UNKNOWN'); }
  if (answer.status !== 200) throw supportErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new SupportError('UNKNOWN'); }
}
function checked<T>(validate: () => T): T { try { return validate(); } catch { throw new SupportError('INVALID'); } }

export const supportApi = {
  /** This school's 50 most recent requests, with status and the school's own messages. */
  async list(scope: SupportScope, signal: AbortSignal, owned: Owned): Promise<SupportRequestList> {
    const path = base(scope);
    let answer: { status: number; value: unknown };
    try { answer = await exchange(path, signal, owned); }
    catch (error) { if (error instanceof SupportError || signal.aborted) throw error; throw new SupportError('UNKNOWN'); }
    if (answer.status !== 200) throw supportErrorFor(answer.status, codeOf(answer.value));
    try { return verifySupportRequestList(data(answer.value)); } catch { throw new SupportError('UNKNOWN'); }
  },
  async submit(scope: SupportScope, input: SupportSubmitInput, key: string, signal: AbortSignal, owned: Owned): Promise<SupportRequest> {
    const path = base(scope), body = checked(() => validateSupportSubmitInput(input));
    return command(path, SUPPORT_SUBMIT_COMMAND, body, key, verifySupportRequest, signal, owned);
  },
  async message(scope: SupportScope, requestId: string, input: SupportMessageInput, key: string, signal: AbortSignal, owned: Owned): Promise<SupportRequest> {
    if (!UUID.test(requestId)) throw new SupportError('INVALID');
    const path = `${base(scope)}/${requestId.toLowerCase()}/messages`, body = checked(() => validateSupportMessageInput(input));
    return command(path, SUPPORT_MESSAGE_COMMAND, body, key, (v) => {
      const r = verifySupportRequest(v);
      if (r.requestId.toLowerCase() !== requestId.toLowerCase()) throw new Error('request');
      return r;
    }, signal, owned);
  },
};
export type SupportApi = typeof supportApi;

/** A failed command may be sent again with the same key only when its outcome is not known. */
export const keepForRetry = (error: unknown) => !(error instanceof SupportError) || error.kind === 'UNKNOWN';

const PAGE_HINT = /^\/[a-z0-9/_-]{0,119}$/;
/** The page someone asked from, carried in the link's fragment (never sent anywhere but in the request body). */
export function pageHintFrom(hash: string): string | null {
  const v = hash.startsWith('#') ? hash.slice(1) : hash;
  return PAGE_HINT.test(v) && (v === '/staff' || v.startsWith('/staff/')) ? v : null;
}
