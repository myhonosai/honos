import {
  SCHOOL_PAY_ONBOARDING_STATE, validateDisconnectSchoolPayInput, validateFinishSchoolPayOnboardingInput, validateSchoolPayVersionInput,
  validateStartSchoolPayConnectionInput, verifySchoolPayConnectionReceipt, verifySchoolPaymentProcessors,
  type DisconnectSchoolPayInput, type FinishSchoolPayOnboardingInput, type SchoolPayConnection, type SchoolPayConnectionReceipt, type SchoolPaymentProcessors,
  type SchoolPayProviderCode, type SchoolPayVersionInput,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * The school's own payment processors (B-TUI-2 piece 1, 0258), test mode only. The read sends no Idempotency-Key; each
 * command sends its own X-HON-Human-Command and an Idempotency-Key, so no command can be replayed as another. The server
 * decides every permission, version and state again, and derives the connection state from the provider itself. HON takes
 * no fee, and nothing here charges, refunds or stores a card.
 */
export type ProcessorErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed for this staff member at this school. Nothing changed. */ | 'DENIED'
  /** The connection is not available at this school. */ | 'GONE'
  /** The connection changed since it was read. Nothing changed. */ | 'CHANGED'
  /** The connection is not in a state that allows this (for example, it already finished connecting). Nothing changed. */ | 'STATE'
  /** This school already has an open connection to this provider. */ | 'EXISTS'
  /** The return link is not the latest one for this connection. */ | 'STATE_MISMATCH'
  /** The provider account is already connected to another organization. */ | 'LINKED_ELSEWHERE'
  /** The provider account does not match this connection. */ | 'ACCOUNT_MISMATCH'
  /** The provider is not set up in this environment. Nothing was sent to it. */ | 'NOT_CONFIGURED'
  /** The provider refused the request. */ | 'PROVIDER_REJECTED'
  /** The request was not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Too many requests. Nothing changed; the same request may be sent again later. */ | 'RATE'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class ProcessorError extends Error { constructor(readonly kind: ProcessorErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;
export type ProcessorScope = Readonly<{ organizationId: string; schoolId: string }>;
export type OnboardingLink = Readonly<{ connection: SchoolPayConnection; onboardingUrl: string | null }>;
export type DisconnectResult = Readonly<{ connection: SchoolPayConnection; providerRevoked: boolean }>;

const RESPONSE_MAX = 1_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PROCESSOR_COMMANDS = {
  start: 'school_pay.connection.start', link: 'school_pay.connection.onboarding_link', finish: 'school_pay.connection.finish',
  refresh: 'school_pay.connection.refresh', default: 'school_pay.connection.default', disconnect: 'school_pay.connection.disconnect',
} as const;
export type ProcessorCommand = keyof typeof PROCESSOR_COMMANDS;

const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function envelope(value: unknown): { data: unknown; meta: Record<string, unknown> } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
  const meta = (value as { meta: unknown }).meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('shape');
  return { data: (value as { data: unknown }).data, meta: meta as Record<string, unknown> };
}
function id(value: string): string { if (!UUID.test(value)) throw new ProcessorError('INVALID'); return value.toLowerCase(); }
function base(scope: ProcessorScope): string { return `/api/v1/organizations/${id(scope.organizationId)}/schools/${id(scope.schoolId)}/payments/processors`; }

/**
 * Where the browser may be sent to connect: the provider's hosted page over https, or (only for the local simulators) a
 * loopback address. Anything else, including credentials in the URL, is refused before the page leaves HON.
 */
export function safeOnboardingUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4000) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password) return null;
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return url.toString();
  return null;
}

async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  // A retired request (aborted, or no longer the one shown) never ends a newer session.
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new ProcessorError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new ProcessorError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}

/** What a refused answer means. Only these exact answers are definitive; anything else (busy, 5xx, drift) is UNKNOWN. */
export function processorErrorFor(status: number, code: string | null): ProcessorError {
  if (status === 403 && code === 'SCHOOL_PAY_ONBOARDING_STATE_MISMATCH') return new ProcessorError('STATE_MISMATCH', code);
  if (status === 403) return new ProcessorError('DENIED', code);
  if (status === 404) return new ProcessorError('GONE', code);
  if (status === 400) return new ProcessorError('INVALID', code);
  if (status === 429) return new ProcessorError('RATE', code);
  if (status === 422 && code === 'SCHOOL_PAY_ACCOUNT_MISMATCH') return new ProcessorError('ACCOUNT_MISMATCH', code);
  if (status === 422 && code === 'SCHOOL_PAY_PROVIDER_UNAVAILABLE') return new ProcessorError('NOT_CONFIGURED', code);
  if (status === 503 && code === 'SCHOOL_PAY_PROVIDER_NOT_CONFIGURED') return new ProcessorError('NOT_CONFIGURED', code);
  if (status === 502 && code === 'SCHOOL_PAY_PROVIDER_REJECTED') return new ProcessorError('PROVIDER_REJECTED', code);
  if (status === 409) {
    if (code === 'VERSION_CONFLICT') return new ProcessorError('CHANGED', code);
    if (code === 'SCHOOL_PAY_CONNECTION_STATE' || code === 'SCHOOL_PAY_ALREADY_DEFAULT') return new ProcessorError('STATE', code);
    if (code === 'SCHOOL_PAY_CONNECTION_EXISTS') return new ProcessorError('EXISTS', code);
    if (code === 'SCHOOL_PAY_ACCOUNT_LINKED_ELSEWHERE') return new ProcessorError('LINKED_ELSEWHERE', code);
    if (code === 'IDEMPOTENCY_KEY_REUSED') return new ProcessorError('INVALID', code);
  }
  // SCHOOL_PAY_CONFLICT (a lock wait), IDEMPOTENCY_IN_PROGRESS, SCHOOL_PAY_PROVIDER_UNKNOWN, 5xx: the same request may be sent again.
  return new ProcessorError('UNKNOWN', code);
}

async function read<T>(path: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned); }
  catch (error) { if (error instanceof ProcessorError || signal.aborted) throw error; throw new ProcessorError('UNKNOWN'); }
  if (answer.status !== 200) throw processorErrorFor(answer.status, codeOf(answer.value));
  try { return verify(envelope(answer.value).data); } catch { throw new ProcessorError('UNKNOWN'); }
}
async function command<T>(path: string, name: string, body: unknown, key: string, verify: (data: unknown, meta: Record<string, unknown>) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new ProcessorError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof ProcessorError) throw error; throw new ProcessorError('UNKNOWN'); }
  if (answer.status !== 200) throw processorErrorFor(answer.status, codeOf(answer.value));
  try { const { data, meta } = envelope(answer.value); return verify(data, meta); } catch { throw new ProcessorError('UNKNOWN'); }
}
function checked<T>(validate: () => T): T { try { return validate(); } catch { throw new ProcessorError('INVALID'); } }
const CONNECTED = ['CONNECTED_RESTRICTED', 'CONNECTED_ACTIVE', 'REAUTHORIZATION_REQUIRED'] as const;
const receipt = (connectionId: string, states?: readonly SchoolPayConnection['state'][]) => (data: unknown): SchoolPayConnectionReceipt =>
  verifySchoolPayConnectionReceipt(data, { connectionId, ...(states ? { states } : {}) });

export const processorsApi = {
  /** The providers HON offers, this school's connections, and whether this staff member may manage them. */
  processors(scope: ProcessorScope, signal: AbortSignal, owned: Owned): Promise<SchoolPaymentProcessors> {
    return Promise.resolve().then(() => read(base(scope), verifySchoolPaymentProcessors, signal, owned));
  },
  /** Start a connection to one provider (test mode). Nothing is sent to the provider yet. */
  async start(scope: ProcessorScope, providerCode: SchoolPayProviderCode, key: string, signal: AbortSignal, owned: Owned): Promise<SchoolPayConnectionReceipt> {
    const body = checked(() => validateStartSchoolPayConnectionInput({ providerCode }));
    return command(`${base(scope)}/connections`, PROCESSOR_COMMANDS.start, body, key,
      (data) => verifySchoolPayConnectionReceipt(data, { providerCode, states: ['PENDING_ONBOARDING'] }), signal, owned);
  },
  /** A fresh hosted onboarding link. A replay answers without a URL: the earlier link is not kept, so ask for a new one. */
  async onboardingLink(scope: ProcessorScope, connectionId: string, input: SchoolPayVersionInput, key: string, signal: AbortSignal, owned: Owned): Promise<OnboardingLink> {
    const path = `${base(scope)}/connections/${id(connectionId)}/onboarding-link`, body = checked(() => validateSchoolPayVersionInput(input));
    return command(path, PROCESSOR_COMMANDS.link, body, key, (data) => {
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).sort().join(',') !== 'connection,onboardingUrl') throw new Error('shape');
      const { connection, onboardingUrl } = data as { connection: unknown; onboardingUrl: unknown };
      const verified = verifySchoolPayConnectionReceipt({ connection }, { connectionId, states: ['PENDING_ONBOARDING'] }).connection;
      if (onboardingUrl === null) return { connection: verified, onboardingUrl: null };
      const url = safeOnboardingUrl(onboardingUrl);
      if (url === null) throw new Error('url');
      return { connection: verified, onboardingUrl: url };
    }, signal, owned);
  },
  /** The school came back from the provider: the server checks the one-time state and asks the provider for the real status. */
  async finish(scope: ProcessorScope, connectionId: string, input: FinishSchoolPayOnboardingInput, key: string, signal: AbortSignal, owned: Owned): Promise<SchoolPayConnectionReceipt> {
    const path = `${base(scope)}/connections/${id(connectionId)}/finish`, body = checked(() => validateFinishSchoolPayOnboardingInput(input));
    return command(path, PROCESSOR_COMMANDS.finish, body, key, receipt(connectionId, CONNECTED), signal, owned);
  },
  /** Ask the provider for the account's current status again. */
  async refresh(scope: ProcessorScope, connectionId: string, input: SchoolPayVersionInput, key: string, signal: AbortSignal, owned: Owned): Promise<SchoolPayConnectionReceipt> {
    const path = `${base(scope)}/connections/${id(connectionId)}/refresh`, body = checked(() => validateSchoolPayVersionInput(input));
    return command(path, PROCESSOR_COMMANDS.refresh, body, key, receipt(connectionId, CONNECTED), signal, owned);
  },
  /** Make an active connection the school's default processor. */
  async setDefault(scope: ProcessorScope, connectionId: string, input: SchoolPayVersionInput, key: string, signal: AbortSignal, owned: Owned): Promise<SchoolPayConnectionReceipt> {
    const path = `${base(scope)}/connections/${id(connectionId)}/default`, body = checked(() => validateSchoolPayVersionInput(input));
    return command(path, PROCESSOR_COMMANDS.default, body, key, (data) => {
      const verified = receipt(connectionId, ['CONNECTED_ACTIVE'])(data);
      if (!verified.connection.isDefault) throw new Error('not default');
      return verified;
    }, signal, owned);
  },
  /** End the connection in HON, then ask the provider to revoke access; whether it did is reported, never assumed. */
  async disconnect(scope: ProcessorScope, connectionId: string, input: DisconnectSchoolPayInput, key: string, signal: AbortSignal, owned: Owned): Promise<DisconnectResult> {
    const path = `${base(scope)}/connections/${id(connectionId)}/disconnect`, body = checked(() => validateDisconnectSchoolPayInput(input));
    return command(path, PROCESSOR_COMMANDS.disconnect, body, key, (data, meta) => {
      const { connection } = receipt(connectionId, ['DISCONNECTED', 'ABANDONED'])(data);
      return { connection, providerRevoked: meta.providerRevoked === true };
    }, signal, owned);
  },
};
export type ProcessorsApi = typeof processorsApi;

/** Whether a failed command may be sent again with the same key: only when its outcome is not known, or nothing was sent (rate limit). */
export const keepForRetry = (error: unknown) => !(error instanceof ProcessorError) || error.kind === 'UNKNOWN' || error.kind === 'RATE';

/** What the provider sent the school back with. It lives only in memory, never in storage, and the URL is cleaned at once. */
export type ProviderReturn = Readonly<{ connectionId: string; state: string; authorizationCode: string | null; providerError: boolean }>;

/**
 * Read the provider return from the page's query, if any. The caller removes the query from the address bar straight away,
 * so the one-time state is not kept in history, bookmarks or a shared link. Only a well-formed return is accepted.
 */
export function providerReturnFrom(search: string): ProviderReturn | null {
  const query = new URLSearchParams(search);
  const connectionId = query.get('connection'), state = query.get('state');
  if (!connectionId || !UUID.test(connectionId) || !state || !SCHOOL_PAY_ONBOARDING_STATE.test(state)) return null;
  const code = query.get('code');
  return { connectionId: connectionId.toLowerCase(), state, authorizationCode: code && /^[A-Za-z0-9_.-]{1,512}$/.test(code) ? code : null,
    providerError: query.has('error') };
}
