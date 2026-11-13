import { HQ_COMMUNICATION_COMMANDS, encodeHqMessageCursor, saasUuid, validateHqCommunicationsView, validateHqMessageCreateInput, validateHqMessageDetail,
  validateHqMessageReceipt, validateHqMessageVersionInput, validateHqSenderReceipt, validateHqSenderSetInput,
  type HqCommunicationsView, type HqMessageCreateInput, type HqMessageCursor, type HqMessageDetail, type HqMessageReceipt, type HqMessageVersionInput,
  type HqSenderReceipt, type HqSenderSetInput } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * HQ texting and email (HQ-COMM, 0281). Reads go through the SaaS read guard (same origin, GET, declared query only,
 * no-store); commands through the SaaS command guard (same origin, human-command marker, JSON, Idempotency-Key). The
 * database decides every time who may read or write, by message purpose. No answer here ever carries an address.
 */
export type CommsErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed for this HQ person or purpose. */ | 'DENIED'
  /** No such message, school, organization or sender. */ | 'GONE'
  /** The request was not accepted as sent. */ | 'INVALID'
  /** The message changed since it was read. Nothing was saved. */ | 'CHANGED'
  /** A rule refused it (already sent, no owners, sender exists...). Nothing was saved. */ | 'REFUSED'
  /** The same key was already used for a different request. */ | 'KEY_REUSED'
  /** The outcome is not known. Retry only the identical request with the same key. */ | 'UNKNOWN';
export class CommsError extends Error {
  constructor(readonly kind: CommsErrorKind, readonly code: string | null = null) { super(kind); }
}
export type Owned = () => boolean;
const RESPONSE_MAX = 2_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const REFUSED = new Set(['HQ_SENDER_EXISTS', 'HQ_SENDER_NOT_ACTIVE', 'HQ_MESSAGE_NOT_DRAFT', 'HQ_MESSAGE_NO_RECIPIENTS', 'HQ_MESSAGE_NOT_CANCELLABLE']);

/** Lower-case id for a path, or null when the value is not an id. */
export function commsId(value: unknown): string | null {
  try { return saasUuid(value); } catch { return null; }
}

async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ marker: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  let r: Response;
  try {
    r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.marker, 'Idempotency-Key': command.key } : {}) },
      ...(command ? { body: command.body } : {}) });
  } catch (error) { if (signal.aborted && !command) throw error; throw new CommsError('UNKNOWN'); }
  if (signal.aborted) { if (command) throw new CommsError('UNKNOWN'); signal.throwIfAborted(); }
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new CommsError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new CommsError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'data')) throw new Error('shape');
  return (value as { data: unknown }).data;
}
function readError(status: number, code: string | null): CommsError {
  if (status === 403) return new CommsError('DENIED', code);
  if (status === 404 && code === 'SAAS_UNAVAILABLE') return new CommsError('GONE', code);
  if (status === 400) return new CommsError('INVALID', code);
  return new CommsError('UNKNOWN', code);
}
/** What a refused command means. Only these exact answers are definitive; anything else is UNKNOWN. */
export function commsCommandError(status: number, code: string | null): CommsError {
  if (status === 403) return new CommsError('DENIED', code);
  if (status === 400) return new CommsError('INVALID', code);
  if (status === 404 && code === 'SAAS_UNAVAILABLE') return new CommsError('GONE', code);
  if (status === 409 && code === 'SAAS_VERSION_CONFLICT') return new CommsError('CHANGED', code);
  if (status === 422 && code !== null && REFUSED.has(code)) return new CommsError('REFUSED', code);
  if (status === 409 && code === 'IDEMPOTENCY_KEY_REUSED') return new CommsError('KEY_REUSED', code);
  return new CommsError('UNKNOWN', code);
}
async function read<T>(path: string, signal: AbortSignal, owned: Owned, validate: (v: unknown) => T): Promise<T> {
  const { status, value } = await exchange(path, signal, owned);
  if (status !== 200) throw readError(status, codeOf(value));
  try { return validate(data(value)); } catch { throw new CommsError('UNKNOWN'); }
}
async function command<T>(path: string, marker: string, body: object, key: string, signal: AbortSignal, owned: Owned, validate: (v: unknown) => T): Promise<T> {
  const k = saasUuid(key);
  const answer = await exchange(path, signal, owned, { marker, body: JSON.stringify(body), key: k });
  if (answer.status !== 200) throw commsCommandError(answer.status, codeOf(answer.value));
  try { return validate(data(answer.value)); } catch { throw new CommsError('UNKNOWN'); }
}
const same = (a: string | null, b: string | null) => (a === null || b === null) ? a === b : a.toLowerCase() === b.toLowerCase();
const BASE = '/api/v1/hq/communications';

export type CommsListRequest = Readonly<{ schoolId: string | null; cursor: HqMessageCursor | null }>;
export const COMMS_PAGE_SIZE = 25;
export type CommsReceipt = HqMessageReceipt | HqSenderReceipt;
export const commsApi = {
  async list(request: CommsListRequest, signal: AbortSignal, owned: Owned): Promise<HqCommunicationsView> {
    const q = new URLSearchParams();
    if (request.schoolId) q.set('schoolId', saasUuid(request.schoolId));
    if (request.cursor) q.set('cursor', encodeHqMessageCursor(request.cursor));
    q.set('limit', String(COMMS_PAGE_SIZE));
    const view = await read(`${BASE}?${q}`, signal, owned, validateHqCommunicationsView);
    // A school-filtered page holds only that school's messages, and only purposes the reader holds.
    if (view.messages.some((m) => (request.schoolId !== null && !same(m.schoolId, request.schoolId)) || !view.viewer.purposes.includes(m.purpose))) throw new CommsError('UNKNOWN');
    return view;
  },
  async read(messageId: string, signal: AbortSignal, owned: Owned): Promise<HqMessageDetail> {
    const id = commsId(messageId);
    if (!id) throw new CommsError('INVALID');
    const view = await read(`${BASE}/messages/${id}`, signal, owned, validateHqMessageDetail);
    if (!same(view.message.messageId, id)) throw new CommsError('UNKNOWN');
    return view;
  },
  async setSender(input: HqSenderSetInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqSenderReceipt> {
    let body: HqSenderSetInput;
    try { body = validateHqSenderSetInput(input); } catch { throw new CommsError('INVALID'); }
    const r = await command(`${BASE}/senders`, HQ_COMMUNICATION_COMMANDS.setSender, body, key, signal, owned, validateHqSenderReceipt);
    if (r.operation !== 'SENDER_SET' || r.sender.channel !== body.channel || r.sender.status !== 'ACTIVE') throw new CommsError('UNKNOWN');
    return r;
  },
  async retireSender(senderId: string, key: string, signal: AbortSignal, owned: Owned): Promise<HqSenderReceipt> {
    const id = commsId(senderId);
    if (!id) throw new CommsError('INVALID');
    const r = await command(`${BASE}/senders/${id}/retire`, HQ_COMMUNICATION_COMMANDS.retireSender, {}, key, signal, owned, validateHqSenderReceipt);
    if (r.operation !== 'SENDER_RETIRE' || !same(r.sender.senderId, id) || r.sender.status !== 'RETIRED') throw new CommsError('UNKNOWN');
    return r;
  },
  /** Saves a draft. Nothing is sent until it is queued. */
  async create(input: HqMessageCreateInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqMessageReceipt> {
    let body: HqMessageCreateInput;
    try { body = validateHqMessageCreateInput(input); } catch { throw new CommsError('INVALID'); }
    const r = await command(`${BASE}/messages`, HQ_COMMUNICATION_COMMANDS.createMessage, body, key, signal, owned, validateHqMessageReceipt), m = r.message;
    if (r.operation !== 'CREATE' || !same(m.organizationId, body.organizationId) || !same(m.schoolId, body.schoolId) || m.purpose !== body.purpose
      || m.channel !== body.channel || m.content !== body.content || !same(m.supportCaseId, body.supportCaseId)) throw new CommsError('UNKNOWN');
    return r;
  },
  async queue(messageId: string, input: HqMessageVersionInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqMessageReceipt> {
    return versioned('queue', 'QUEUE', HQ_COMMUNICATION_COMMANDS.queueMessage, messageId, input, key, signal, owned);
  },
  async cancel(messageId: string, input: HqMessageVersionInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqMessageReceipt> {
    return versioned('cancel', 'CANCEL', HQ_COMMUNICATION_COMMANDS.cancelMessage, messageId, input, key, signal, owned);
  },
};
async function versioned(path: 'queue' | 'cancel', operation: 'QUEUE' | 'CANCEL', marker: string, messageId: string, input: HqMessageVersionInput, key: string,
  signal: AbortSignal, owned: Owned): Promise<HqMessageReceipt> {
  const id = commsId(messageId);
  let body: HqMessageVersionInput;
  try { if (!id) throw new Error('id'); body = validateHqMessageVersionInput(input); } catch { throw new CommsError('INVALID'); }
  const r = await command(`${BASE}/messages/${id}/${path}`, marker, body, key, signal, owned, validateHqMessageReceipt);
  if (r.operation !== operation || !same(r.message.messageId, id) || r.message.version !== body.expectedVersion + 1) throw new CommsError('UNKNOWN');
  return r;
}
export type CommsApi = typeof commsApi;
