import {
  validateEndWalkInDeviceInput, validateStartWalkInDeviceInput, validateWalkInDeskPaidInput, validateWalkInSettingsInput, verifyWalkInDeviceReceipt,
  verifyWalkInOverview, verifyWalkInSettingsRead, verifyWalkInSettingsReceipt, verifyWalkInTerminal, verifyWalkInVisitDetail, verifyWalkInVisitOutcome,
  verifyWalkInVisitReceipt, verifyWalkInCardOutcome, WALKIN_CARD_SURFACES, WALKIN_TOKEN,
  type StartWalkInDeviceInput, type WalkInDeskPaidInput, type WalkInDevice, type WalkInOverview, type WalkInSettings, type WalkInSettingsInput,
  type WalkInSettingsRead, type WalkInTerminal, type WalkInCardOutcome, type WalkInCardSurface, type WalkInVisit, type WalkInVisitDetail, type WalkInVisitInput, type WalkInVisitOutcome,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * Walk-in kiosk, web side (0396 WK2). Staff reads send no key; each staff command sends its own X-HON-Human-Command and an
 * Idempotency-Key. The tablet sends no cookie and no tenant id: the device token in the body is its only selector. The server
 * decides every permission, offer, price and rule again.
 */
export type WalkInErrorKind = 'SESSION' | 'DENIED' | 'GONE' | 'CHANGED' | 'REFUSED' | 'CARD_PENDING' | 'INVALID' | 'UNKNOWN';
export class WalkInError extends Error { constructor(readonly kind: WalkInErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;
export type WalkInScope = Readonly<{ organizationId: string; schoolId: string }>;
export const WALKIN_COMMANDS = {
  settings: 'walkin_kiosk.settings.save', start: 'walkin_kiosk.device.start', end: 'walkin_kiosk.device.end', deskPaid: 'walkin_kiosk.visit.desk_paid',
} as const;

const RESPONSE_MAX = 2_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{16,100}$/;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
  return (value as { data: unknown }).data;
}
function id(value: string): string { if (!UUID.test(value)) throw new WalkInError('INVALID'); return value.toLowerCase(); }
function base(scope: WalkInScope): string { return `/api/v1/organizations/${id(scope.organizationId)}/schools/${id(scope.schoolId)}/walk-in-kiosk`; }
function checked<T>(run: () => T): T { try { return run(); } catch { throw new WalkInError('INVALID'); } }

async function exchange(path: string, signal: AbortSignal, owned: Owned | null, command?: Readonly<{ name?: string; body: string; key?: string }>): Promise<{ status: number; value: unknown }> {
  const staff = owned !== null;
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: staff ? 'same-origin' : 'omit', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', ...(command.key ? { 'Idempotency-Key': command.key } : {}),
      ...(command.name ? { 'X-HON-Human-Command': command.name } : {}) } : {}) },
    ...(command ? { body: command.body } : {}) });
  signal.throwIfAborted();
  if (staff && r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new WalkInError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new WalkInError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}

/** What a refused staff answer means. Only these exact answers are definitive; anything else is UNKNOWN. */
export function walkInErrorFor(status: number, code: string | null): WalkInError {
  if (status === 403) return new WalkInError('DENIED', code);
  if (status === 404) return new WalkInError('GONE', code);
  if (status === 400 || status === 422) return new WalkInError('INVALID', code);
  if (status === 409) {
    if (code === 'VERSION_CONFLICT') return new WalkInError('CHANGED', code);
    if (code === 'IDEMPOTENCY_KEY_REUSED') return new WalkInError('INVALID', code);
    if (code && /^WALKIN_(KIOSK_OFF|KIOSK_DEVICE_LIMIT|KIOSK_DEVICE_ENDED|VISIT_NOT_DUE)$/.test(code)) return new WalkInError('REFUSED', code);
    if (code === 'WALKIN_CARD_PAYMENT_OPEN' || code === 'WALKIN_CARD_PAYMENT_IN_PROGRESS') return new WalkInError('CARD_PENDING', code);
  }
  return new WalkInError('UNKNOWN', code);
}

async function read<T>(path: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned); }
  catch (error) { if (error instanceof WalkInError || signal.aborted) throw error; throw new WalkInError('UNKNOWN'); }
  if (answer.status !== 200) throw walkInErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new WalkInError('UNKNOWN'); }
}
async function command<T>(path: string, name: string, body: unknown, key: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new WalkInError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof WalkInError) throw error; throw new WalkInError('UNKNOWN'); }
  if (answer.status !== 200) throw walkInErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new WalkInError('UNKNOWN'); }
}

/** The started tablet: the device and its token, which this browser keeps in memory only. A replay carries no token. */
export function verifyStartedWalkInDevice(value: unknown): { device: WalkInDevice; token: string | null } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'device,token') throw new Error('shape');
  const token = (value as { token: unknown }).token;
  if (token !== null && (typeof token !== 'string' || !WALKIN_TOKEN.test(token))) throw new Error('token');
  return { device: verifyWalkInDeviceReceipt({ device: (value as { device: unknown }).device }).device, token };
}

export const walkInApi = {
  overview(scope: WalkInScope, signal: AbortSignal, owned: Owned): Promise<WalkInOverview> {
    return Promise.resolve().then(() => read(base(scope), verifyWalkInOverview, signal, owned));
  },
  settings(scope: WalkInScope, signal: AbortSignal, owned: Owned): Promise<WalkInSettingsRead> {
    return Promise.resolve().then(() => read(`${base(scope)}/settings`, verifyWalkInSettingsRead, signal, owned));
  },
  visit(scope: WalkInScope, visitId: string, signal: AbortSignal, owned: Owned): Promise<WalkInVisitDetail> {
    return Promise.resolve().then(() => { const v = id(visitId); return read(`${base(scope)}/visits/${v}`, (x) => verifyWalkInVisitDetail(x, v), signal, owned); });
  },
  saveSettings(scope: WalkInScope, input: WalkInSettingsInput, key: string, signal: AbortSignal, owned: Owned): Promise<{ settings: WalkInSettings }> {
    return Promise.resolve().then(() => command(`${base(scope)}/settings`, WALKIN_COMMANDS.settings, checked(() => validateWalkInSettingsInput(input)), key, verifyWalkInSettingsReceipt, signal, owned));
  },
  start(scope: WalkInScope, input: StartWalkInDeviceInput, key: string, signal: AbortSignal, owned: Owned): Promise<{ device: WalkInDevice; token: string | null }> {
    return Promise.resolve().then(() => command(`${base(scope)}/devices`, WALKIN_COMMANDS.start, checked(() => validateStartWalkInDeviceInput(input)), key, verifyStartedWalkInDevice, signal, owned));
  },
  end(scope: WalkInScope, deviceId: string, expectedVersion: number, key: string, signal: AbortSignal, owned: Owned): Promise<{ device: WalkInDevice }> {
    return Promise.resolve().then(() => {
      const d = id(deviceId);
      return command(`${base(scope)}/devices/${d}/end`, WALKIN_COMMANDS.end, checked(() => validateEndWalkInDeviceInput({ expectedVersion })), key,
        (v) => verifyWalkInDeviceReceipt(v, { deviceId: d }), signal, owned);
    });
  },
  deskPaid(scope: WalkInScope, visitId: string, input: WalkInDeskPaidInput, key: string, signal: AbortSignal, owned: Owned): Promise<{ visit: WalkInVisit }> {
    return Promise.resolve().then(() => {
      const v = id(visitId);
      return command(`${base(scope)}/visits/${v}/desk-paid`, WALKIN_COMMANDS.deskPaid, checked(() => validateWalkInDeskPaidInput(input)), key,
        (x) => verifyWalkInVisitReceipt(x, { visitId: v }), signal, owned);
    });
  },
};
export type WalkInApi = typeof walkInApi;
export const keepWalkInForRetry = (error: unknown) => !(error instanceof WalkInError) || error.kind === 'UNKNOWN';

/** The tablet side. Answers are the server's closed words; anything else is UNAVAILABLE and may be sent again with the same key. */
export const walkInTabletApi = {
  async terminal(token: string, signal: AbortSignal): Promise<WalkInTerminal | 'CLOSED' | 'UNAVAILABLE'> {
    if (!WALKIN_TOKEN.test(token)) return 'CLOSED';
    try {
      const answer = await exchange('/api/v1/walk-in-kiosk/terminal', signal, null, { body: JSON.stringify({ device: token }) });
      if (answer.status === 404 || answer.status === 400) return 'CLOSED';
      if (answer.status !== 200 || !answer.value || typeof answer.value !== 'object' || Object.keys(answer.value).join() !== 'data') return 'UNAVAILABLE';
      return verifyWalkInTerminal((answer.value as { data: unknown }).data);
    } catch { return 'UNAVAILABLE'; }
  },
  async submit(token: string, visit: WalkInVisitInput, key: string, signal: AbortSignal): Promise<WalkInVisitOutcome> {
    if (!WALKIN_TOKEN.test(token) || !PUBLIC_KEY.test(key)) return { result: 'INVALID' };
    try {
      const answer = await exchange('/api/v1/walk-in-kiosk/visits', signal, null, { body: JSON.stringify({ device: token, visit }), key });
      return verifyWalkInVisitOutcome(answer.value);
    } catch { return { result: 'UNAVAILABLE' }; }
  },
  /**
   * 0533 card payment for the visit this tablet just recorded, named only by the key it was submitted with (never a payment
   * id). start shows it on `surface`; status asks where it stands; cancel ends it because the visitor pays at the desk.
   */
  async card(action: 'start' | 'status' | 'cancel', token: string, visitKey: string, signal: AbortSignal, surface?: WalkInCardSurface): Promise<WalkInCardOutcome> {
    if (!WALKIN_TOKEN.test(token) || !PUBLIC_KEY.test(visitKey) || (action === 'start') !== (surface !== undefined)
      || (surface !== undefined && !WALKIN_CARD_SURFACES.includes(surface))) return { result: 'INVALID' };
    try {
      const answer = await exchange(`/api/v1/walk-in-kiosk/card-payment/${action}`, signal, null,
        { body: JSON.stringify(surface ? { device: token, visit: visitKey, surface } : { device: token, visit: visitKey }) });
      return verifyWalkInCardOutcome(answer.value);
    } catch { return { result: 'UNAVAILABLE' }; }
  },
};
export type WalkInTabletApi = typeof walkInTabletApi;

/**
 * Ends the staff session in this browser before it becomes a visitor tablet, so nobody can leave the visitor screen into
 * staff pages. Resolves true only when the sign-out answered (the cookie is expired by the response).
 */
export async function signOutThisBrowser(): Promise<boolean> {
  try {
    const r = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', redirect: 'manual', cache: 'no-store', referrerPolicy: 'no-referrer' });
    return r.type === 'opaqueredirect' || (r.status >= 200 && r.status < 400);
  } catch { return false; }
}
