import { HQ_SUPPORT_COMMANDS, encodeHqSupportCursor, saasUuid, validateHqSupportCaseDetail, validateHqSupportCaseList, validateHqSupportChangeInput,
  validateHqSupportNoteInput, validateHqSupportOpenInput, validateHqSupportReceipt, validateHqSupportSchools,
  type HqSupportCaseDetail, type HqSupportCaseList, type HqSupportChangeInput, type HqSupportCursor, type HqSupportListFilter, type HqSupportNoteInput,
  type HqSupportOpenInput, type HqSupportReceipt, type HqSupportSchools } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * HQ support records (B-HQ-2, 0232). Reads go through the SaaS read guard (same origin, GET, declared query only, no-store);
 * commands through the SaaS command guard (same origin, human-command marker, JSON, Idempotency-Key). The database decides
 * every time who may read or write (HQ owner, or HQ staff holding hq.support.manage). Nothing here sends a message to a school.
 */
export type SupportErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not HQ support staff. Nothing is shown. */ | 'DENIED'
  /** No such case, organization or school. */ | 'GONE'
  /** The request was not accepted as sent. */ | 'INVALID'
  /** The case changed since it was read, or it is closed. Nothing was saved by this request. Re-read. */ | 'CHANGED'
  /** A rule refused it (assignee cannot take cases, nothing changed). Nothing was saved. */ | 'REFUSED'
  /** The same key was already used for a different request. Nothing was saved by this one. */ | 'KEY_REUSED'
  /** The outcome is not known. Retry only the identical request with the same key. */ | 'UNKNOWN';
export class SupportError extends Error {
  constructor(readonly kind: SupportErrorKind, readonly code: string | null = null) { super(kind); }
}
/** Whether the caller still stands behind this request. A 401 for a retired request must not end a newer session. */
export type Owned = () => boolean;
const RESPONSE_MAX = 2_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const CHANGED = new Set(['SAAS_VERSION_CONFLICT', 'SUPPORT_CASE_CLOSED']);
const REFUSED = new Set(['SUPPORT_ASSIGNEE_NOT_ELIGIBLE', 'SUPPORT_NO_CHANGE']);

/** Lower-case case id for a path, or null when the value is not a case id. */
export function supportCaseId(value: unknown): string | null {
  try { return saasUuid(value); } catch { return null; }
}

async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ marker: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  let r: Response;
  try {
    r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.marker, 'Idempotency-Key': command.key } : {}) },
      ...(command ? { body: command.body } : {}) });
  } catch (error) { if (signal.aborted && !command) throw error; throw new SupportError('UNKNOWN'); }
  if (signal.aborted) { if (command) throw new SupportError('UNKNOWN'); signal.throwIfAborted(); }
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new SupportError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new SupportError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'data')) throw new Error('shape');
  return (value as { data: unknown }).data;
}
function readError(status: number, code: string | null): SupportError {
  if (status === 403) return new SupportError('DENIED', code);
  if (status === 404 && code === 'SAAS_UNAVAILABLE') return new SupportError('GONE', code);
  if (status === 400) return new SupportError('INVALID', code);
  return new SupportError('UNKNOWN', code);
}
/** What a refused command means. Only these exact answers are definitive; anything else is UNKNOWN. */
export function supportCommandError(status: number, code: string | null): SupportError {
  if (status === 403) return new SupportError('DENIED', code);
  if (status === 400) return new SupportError('INVALID', code);
  if (status === 404 && code === 'SAAS_UNAVAILABLE') return new SupportError('GONE', code);
  if ((status === 409 || status === 422) && code !== null && CHANGED.has(code)) return new SupportError('CHANGED', code);
  if (status === 422 && code !== null && REFUSED.has(code)) return new SupportError('REFUSED', code);
  if (status === 409 && code === 'IDEMPOTENCY_KEY_REUSED') return new SupportError('KEY_REUSED', code);
  return new SupportError('UNKNOWN', code);
}
async function read<T>(path: string, signal: AbortSignal, owned: Owned, validate: (v: unknown) => T): Promise<T> {
  const { status, value } = await exchange(path, signal, owned);
  if (status !== 200) throw readError(status, codeOf(value));
  try { return validate(data(value)); } catch { throw new SupportError('UNKNOWN'); }
}
async function command(path: string, marker: string, body: object, key: string, signal: AbortSignal, owned: Owned): Promise<HqSupportReceipt> {
  const k = saasUuid(key);
  const answer = await exchange(path, signal, owned, { marker, body: JSON.stringify(body), key: k });
  if (answer.status !== 200) throw supportCommandError(answer.status, codeOf(answer.value));
  try { return validateHqSupportReceipt(data(answer.value)); } catch { throw new SupportError('UNKNOWN'); }
}
const sameId = (a: string | null, b: string | null) => (a === null || b === null) ? a === b : a.toLowerCase() === b.toLowerCase();

export type SupportListRequest = Readonly<{ status: HqSupportListFilter | null; organizationId: string | null; cursor: HqSupportCursor | null }>;
export const SUPPORT_PAGE_SIZE = 25;
export const supportApi = {
  async list(request: SupportListRequest, signal: AbortSignal, owned: Owned): Promise<HqSupportCaseList> {
    const q = new URLSearchParams();
    if (request.status) q.set('status', request.status);
    if (request.organizationId) q.set('organizationId', saasUuid(request.organizationId));
    if (request.cursor) q.set('cursor', encodeHqSupportCursor(request.cursor));
    q.set('limit', String(SUPPORT_PAGE_SIZE));
    const view = await read(`/api/v1/hq/support/cases?${q}`, signal, owned, validateHqSupportCaseList);
    // The answer must match what was asked: a filtered page holds only that filter's cases.
    const fits = (s: string) => !request.status || (request.status === 'ACTIVE' ? s === 'OPEN' || s === 'WAITING_ON_SCHOOL' : s === request.status);
    if (view.cases.some(c => !fits(c.status) || (request.organizationId !== null && !sameId(c.organizationId, request.organizationId)))) throw new SupportError('UNKNOWN');
    return view;
  },
  async schools(signal: AbortSignal, owned: Owned): Promise<HqSupportSchools> {
    return read('/api/v1/hq/support/cases/schools', signal, owned, validateHqSupportSchools);
  },
  async read(caseId: string, signal: AbortSignal, owned: Owned): Promise<HqSupportCaseDetail> {
    const id = supportCaseId(caseId);
    if (!id) throw new SupportError('INVALID');
    const view = await read(`/api/v1/hq/support/cases/${id}`, signal, owned, validateHqSupportCaseDetail);
    if (!sameId(view.case.caseId, id)) throw new SupportError('UNKNOWN');
    return view;
  },
  /** One open attempt. The same key and body replay the saved answer. */
  async open(input: HqSupportOpenInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqSupportReceipt> {
    let body: HqSupportOpenInput;
    try { body = validateHqSupportOpenInput(input); } catch { throw new SupportError('INVALID'); }
    const receipt = await command('/api/v1/hq/support/cases', HQ_SUPPORT_COMMANDS.open, body, key, signal, owned), c = receipt.case;
    if (receipt.operation !== 'OPEN' || !sameId(c.organizationId, body.organizationId) || !sameId(c.schoolId, body.schoolId) || c.subject !== body.subject
      || c.category !== body.category || c.priority !== body.priority) throw new SupportError('UNKNOWN');
    return receipt;
  },
  async note(caseId: string, input: HqSupportNoteInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqSupportReceipt> {
    const id = supportCaseId(caseId);
    let body: HqSupportNoteInput;
    try { if (!id) throw new Error('id'); body = validateHqSupportNoteInput(input); } catch { throw new SupportError('INVALID'); }
    const receipt = await command(`/api/v1/hq/support/cases/${id}/notes`, HQ_SUPPORT_COMMANDS.note, body, key, signal, owned);
    if (receipt.operation !== 'NOTE' || !sameId(receipt.case.caseId, id) || receipt.case.version !== body.expectedVersion + 1) throw new SupportError('UNKNOWN');
    return receipt;
  },
  async change(caseId: string, input: HqSupportChangeInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqSupportReceipt> {
    const id = supportCaseId(caseId);
    let body: HqSupportChangeInput;
    try { if (!id) throw new Error('id'); body = validateHqSupportChangeInput(input); } catch { throw new SupportError('INVALID'); }
    const receipt = await command(`/api/v1/hq/support/cases/${id}/changes`, HQ_SUPPORT_COMMANDS.change, body, key, signal, owned), c = receipt.case;
    if (receipt.operation !== 'CHANGE' || !sameId(c.caseId, id) || c.version !== body.expectedVersion + 1
      || (body.status !== undefined && c.status !== body.status) || (body.priority !== undefined && c.priority !== body.priority)
      || (body.assigneePrincipalId !== undefined && !sameId(c.assignee?.principalId ?? null, body.assigneePrincipalId))) throw new SupportError('UNKNOWN');
    return receipt;
  },
};
export type SupportApi = typeof supportApi;
