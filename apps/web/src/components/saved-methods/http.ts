import {
  SCHOOL_PAY_SETUP_STATE, validateFinishSchoolPayMethodSetupInput, validateRemoveSchoolPayMethodInput, validateSchoolPayMethodVersionInput,
  validateStartSchoolPayMethodSetupInput, verifySchoolPayExpiringMethods, verifySchoolPayMethodReceipt, verifySchoolPayPayerMethodsView,
  verifySchoolPaySetupStartView,
  type FinishSchoolPayMethodSetupInput, type RemoveSchoolPayMethodInput, type SchoolPayExpiringMethods, type SchoolPayMethod,
  type SchoolPayMethodVersionInput, type SchoolPayPayerMethodsView, type SchoolPaySetupStartView, type StartSchoolPayMethodSetupInput,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';
import { safeOnboardingUrl } from '../payment-processors/http';

/**
 * A payer's saved cards and bank accounts (B-TUI-2 piece 3, 0290), test mode only. Reads send no Idempotency-Key; each
 * command sends its own X-HON-Human-Command and an Idempotency-Key. The server decides every permission, version and
 * state again, and gets the saved card from the provider itself. No card number ever passes through HON; HON takes no fee.
 */
export type MethodErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed for this staff member at this school. Nothing changed. */ | 'DENIED'
  /** The payer, setup or method is not available at this school. */ | 'GONE'
  /** It changed since it was read. Nothing changed. */ | 'CHANGED'
  /** Not in a state that allows this (already removed, already default, setup already finished). Nothing changed. */ | 'STATE'
  /** The card or account was not saved on the provider page yet. */ | 'INCOMPLETE'
  /** The return link is not the latest one for this setup. */ | 'STATE_MISMATCH'
  /** The setup expired. */ | 'EXPIRED'
  /** This connection cannot save this kind of method now. */ | 'UNAVAILABLE'
  /** The provider answered for another customer. Nothing was saved. */ | 'CUSTOMER_MISMATCH'
  /** The provider is not set up in this environment. Nothing was sent to it. */ | 'NOT_CONFIGURED'
  /** The provider refused the request. */ | 'PROVIDER_REJECTED'
  /** The request was not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Too many requests. Nothing changed. */ | 'RATE'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class MethodError extends Error { constructor(readonly kind: MethodErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;
export type MethodScope = Readonly<{ organizationId: string; schoolId: string }>;
export type RemoveResult = Readonly<{ method: SchoolPayMethod; providerDetached: boolean }>;

const RESPONSE_MAX = 1_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const METHOD_COMMANDS = { setup: 'school_pay.method.setup', finish: 'school_pay.method.finish', default: 'school_pay.method.default', remove: 'school_pay.method.remove' } as const;
export type MethodCommand = keyof typeof METHOD_COMMANDS;

const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function envelope(value: unknown): { data: unknown; meta: Record<string, unknown> } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
  const meta = (value as { meta: unknown }).meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('shape');
  return { data: (value as { data: unknown }).data, meta: meta as Record<string, unknown> };
}
function id(value: string): string { if (!UUID.test(value)) throw new MethodError('INVALID'); return value.toLowerCase(); }
function base(scope: MethodScope): string { return `/api/v1/organizations/${id(scope.organizationId)}/schools/${id(scope.schoolId)}/payments`; }

async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new MethodError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new MethodError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}

/** What a refused answer means. Only these exact answers are definitive; anything else is UNKNOWN. */
export function methodErrorFor(status: number, code: string | null): MethodError {
  if (status === 403 && code === 'SCHOOL_PAY_SETUP_STATE_MISMATCH') return new MethodError('STATE_MISMATCH', code);
  if (status === 403) return new MethodError('DENIED', code);
  if (status === 404) return new MethodError('GONE', code);
  if (status === 400) return new MethodError('INVALID', code);
  if (status === 429) return new MethodError('RATE', code);
  if (status === 422 && code === 'SCHOOL_PAY_SETUP_EXPIRED') return new MethodError('EXPIRED', code);
  if (status === 422 && code === 'SCHOOL_PAY_CUSTOMER_MISMATCH') return new MethodError('CUSTOMER_MISMATCH', code);
  if (status === 422 && code === 'SCHOOL_PAY_METHODS_UNAVAILABLE') return new MethodError('UNAVAILABLE', code);
  if (status === 503 && code === 'SCHOOL_PAY_PROVIDER_NOT_CONFIGURED') return new MethodError('NOT_CONFIGURED', code);
  if (status === 502 && code === 'SCHOOL_PAY_PROVIDER_REJECTED') return new MethodError('PROVIDER_REJECTED', code);
  if (status === 409) {
    if (code === 'VERSION_CONFLICT') return new MethodError('CHANGED', code);
    if (code === 'SCHOOL_PAY_SETUP_INCOMPLETE') return new MethodError('INCOMPLETE', code);
    if (code === 'SCHOOL_PAY_SETUP_STATE' || code === 'SCHOOL_PAY_METHOD_STATE' || code === 'SCHOOL_PAY_METHOD_ALREADY_DEFAULT' || code === 'SCHOOL_PAY_METHOD_EXISTS') return new MethodError('STATE', code);
    if (code === 'IDEMPOTENCY_KEY_REUSED') return new MethodError('INVALID', code);
  }
  return new MethodError('UNKNOWN', code);
}

async function read<T>(path: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned); }
  catch (error) { if (error instanceof MethodError || signal.aborted) throw error; throw new MethodError('UNKNOWN'); }
  if (answer.status !== 200) throw methodErrorFor(answer.status, codeOf(answer.value));
  try { return verify(envelope(answer.value).data); } catch { throw new MethodError('UNKNOWN'); }
}
async function command<T>(path: string, name: string, body: unknown, key: string, verify: (data: unknown, meta: Record<string, unknown>) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new MethodError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof MethodError) throw error; throw new MethodError('UNKNOWN'); }
  if (answer.status !== 200) throw methodErrorFor(answer.status, codeOf(answer.value));
  try { const { data, meta } = envelope(answer.value); return verify(data, meta); } catch { throw new MethodError('UNKNOWN'); }
}
function checked<T>(validate: () => T): T { try { return validate(); } catch { throw new MethodError('INVALID'); } }

export const savedMethodsApi = {
  /** One payer's saved methods, unfinished setups and the connections that can save one. */
  payer(scope: MethodScope, payerId: string, signal: AbortSignal, owned: Owned): Promise<SchoolPayPayerMethodsView> {
    return Promise.resolve().then(() => read(`${base(scope)}/payers/${id(payerId)}/methods`, (v) => verifySchoolPayPayerMethodsView(v, payerId), signal, owned));
  },
  /** Saved cards that expired or expire this month or next (school calendar). */
  expiring(scope: MethodScope, signal: AbortSignal, owned: Owned): Promise<SchoolPayExpiringMethods> {
    return Promise.resolve().then(() => read(`${base(scope)}/saved-methods/expiring`, verifySchoolPayExpiringMethods, signal, owned));
  },
  /** Start the provider's hosted page. A replay answers without a URL: start again for a fresh link. */
  async startSetup(scope: MethodScope, payerId: string, input: StartSchoolPayMethodSetupInput, key: string, signal: AbortSignal, owned: Owned): Promise<SchoolPaySetupStartView> {
    const body = checked(() => validateStartSchoolPayMethodSetupInput(input));
    return command(`${base(scope)}/payers/${id(payerId)}/method-setups`, METHOD_COMMANDS.setup, body, key, (data) => {
      const view = verifySchoolPaySetupStartView(data, { billingAccountId: payerId, connectionId: body.connectionId });
      if (view.setupUrl === null) return view;
      const url = safeOnboardingUrl(view.setupUrl);
      if (url === null) throw new Error('url');
      return { ...view, setupUrl: url };
    }, signal, owned);
  },
  /** The payer came back from the provider page: the server checks the one-time state and asks the provider what was saved. */
  async finishSetup(scope: MethodScope, payerId: string, setupId: string, input: FinishSchoolPayMethodSetupInput, key: string, signal: AbortSignal, owned: Owned): Promise<SchoolPayMethod> {
    const body = checked(() => validateFinishSchoolPayMethodSetupInput(input));
    return command(`${base(scope)}/payers/${id(payerId)}/method-setups/${id(setupId)}/finish`, METHOD_COMMANDS.finish, body, key,
      (data) => verifySchoolPayMethodReceipt(data, { billingAccountId: payerId, status: 'ACTIVE' }).method, signal, owned);
  },
  async setDefault(scope: MethodScope, payerId: string, methodId: string, input: SchoolPayMethodVersionInput, key: string, signal: AbortSignal, owned: Owned): Promise<SchoolPayMethod> {
    const body = checked(() => validateSchoolPayMethodVersionInput(input));
    return command(`${base(scope)}/payers/${id(payerId)}/methods/${id(methodId)}/default`, METHOD_COMMANDS.default, body, key, (data) => {
      const { method } = verifySchoolPayMethodReceipt(data, { methodId, billingAccountId: payerId, status: 'ACTIVE' });
      if (!method.isDefault) throw new Error('not default');
      return method;
    }, signal, owned);
  },
  /** Remove in HON, then the server asks the provider to detach it; whether it did is reported, never assumed. */
  async remove(scope: MethodScope, payerId: string, methodId: string, input: RemoveSchoolPayMethodInput, key: string, signal: AbortSignal, owned: Owned): Promise<RemoveResult> {
    const body = checked(() => validateRemoveSchoolPayMethodInput(input));
    return command(`${base(scope)}/payers/${id(payerId)}/methods/${id(methodId)}/remove`, METHOD_COMMANDS.remove, body, key, (data, meta) => {
      const { method } = verifySchoolPayMethodReceipt(data, { methodId, billingAccountId: payerId, status: 'REMOVED' });
      return { method, providerDetached: meta.providerDetached === true };
    }, signal, owned);
  },
};
export type SavedMethodsApi = typeof savedMethodsApi;

export const keepForRetry = (error: unknown) => !(error instanceof MethodError) || error.kind === 'UNKNOWN' || error.kind === 'RATE';

/** What the provider sent the staff member back with: in memory only, and the URL is cleaned at once. */
export type SetupReturn = Readonly<{ payerId: string; setupId: string; setupState: string }>;
/** A payer chosen by link (no one-time state), or a provider return. Only well-formed values are accepted. */
export function methodsQueryFrom(search: string): { payerId: string | null; returned: SetupReturn | null } {
  const query = new URLSearchParams(search);
  const payer = query.get('payer'), setup = query.get('setup'), state = query.get('state');
  const payerId = payer && UUID.test(payer) ? payer.toLowerCase() : null;
  const returned = payerId && setup && UUID.test(setup) && state && SCHOOL_PAY_SETUP_STATE.test(state) ? { payerId, setupId: setup.toLowerCase(), setupState: state } : null;
  return { payerId, returned };
}
