// School support requests (0335): a school asks HON for help, and the request lands in the HQ support queue as an OPEN
// case for that exact school. A school sees its requests' status and its own messages only, never HQ notes. A direct
// human with support.request asks; before trial or paid access starts (owner decision D3) a school may still ask.

export const SUPPORT_TOPICS = ['GETTING_STARTED', 'IMPORTING_DATA', 'BILLING', 'ACCOUNT_ACCESS', 'PROBLEM', 'IDEA', 'OTHER'] as const;
export const SUPPORT_STATUSES = ['OPEN', 'WAITING_ON_SCHOOL', 'RESOLVED', 'CLOSED'] as const;
export const SUPPORT_SUBMIT_COMMAND = 'support.request.submit';
export const SUPPORT_MESSAGE_COMMAND = 'support.request.message';
export const SUPPORT_SUBJECT_MAX = 200;
export const SUPPORT_MESSAGE_MAX = 4000;

export type SupportTopic = typeof SUPPORT_TOPICS[number];
export type SupportStatus = typeof SUPPORT_STATUSES[number];
export interface SupportSubmitInput { topic: SupportTopic; subject: string; message: string; pageHint: string | null }
export interface SupportMessageInput { message: string }
/** 0713: `from` HON for an HQ reply (author "HON support"), SCHOOL for the school's own message. */
export type SupportMessageFrom = 'SCHOOL' | 'HON';
export interface SupportMessage { seq: number; note: string; at: string; author: string; from: SupportMessageFrom }
export interface SupportRequest {
  requestId: string; topic: SupportTopic; subject: string; status: SupportStatus; pageHint: string | null;
  openedAt: string; updatedAt: string; closedAt: string | null; messages: SupportMessage[];
  /** 0713: HON support answered last and the request is still active. */
  awaitingSchool: boolean;
}
export interface SupportRequestList {
  requests: SupportRequest[]; limits: { requestsPerDay: number; messagesPerDay: number; subjectMax: number; messageMax: number }; checkedAt: string;
  /** 0713: active requests where HON support answered last (all of the school's, not only the 50 shown). */
  awaitingSchoolCount: number;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_HINT = /^\/[a-z0-9/_-]{0,119}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
function fail(what: string): never { throw new Error(`Unverified school support ${what}.`); }
function record(v: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(what);
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(',') !== [...keys].sort().join(',')) fail(what);
  return o;
}
function time(v: unknown, what: string, nullable = false): string | null {
  if (v === null && nullable) return null;
  if (typeof v !== 'string' || !ISO.test(v) || Number.isNaN(Date.parse(v))) fail(what);
  return v;
}
/** Text the server accepts: trimmed, min..max characters, no control characters except tab and line breaks. */
export function supportTextOk(v: unknown, min: number, max: number): v is string {
  return typeof v === 'string' && v === v.trim() && v.length >= min && v.length <= max && !CONTROL.test(v);
}
function text(v: unknown, min: number, max: number, what: string): string { if (!supportTextOk(v, min, max)) fail(what); return v; }
function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) fail(what);
  return v as T;
}

export function validateSupportSubmitInput(v: unknown): SupportSubmitInput {
  const o = record(v, ['topic', 'subject', 'message', 'pageHint'], 'submit input');
  if (o.pageHint !== null && (typeof o.pageHint !== 'string' || !PAGE_HINT.test(o.pageHint))) fail('page');
  return { topic: oneOf(o.topic, SUPPORT_TOPICS, 'topic'), subject: text(o.subject, 3, SUPPORT_SUBJECT_MAX, 'subject'),
    message: text(o.message, 1, SUPPORT_MESSAGE_MAX, 'message'), pageHint: o.pageHint as string | null };
}
export function validateSupportMessageInput(v: unknown): SupportMessageInput {
  const o = record(v, ['message'], 'message input');
  return { message: text(o.message, 1, SUPPORT_MESSAGE_MAX, 'message') };
}

const REQUEST_KEYS = ['requestId', 'topic', 'subject', 'status', 'pageHint', 'openedAt', 'updatedAt', 'closedAt', 'messages'] as const;
/** `legacy`: a saved command answer from before 0713 replays without `awaitingSchool` and message `from`; it reads as the school's own. */
export function verifySupportRequest(v: unknown, legacy = false): SupportRequest {
  const old = legacy && !!v && typeof v === 'object' && !Array.isArray(v) && !Object.hasOwn(v, 'awaitingSchool');
  const o = record(old ? { ...(v as object), awaitingSchool: false } : v, [...REQUEST_KEYS, 'awaitingSchool'], 'request');
  if (typeof o.awaitingSchool !== 'boolean') fail('awaiting');
  if (typeof o.requestId !== 'string' || !UUID.test(o.requestId)) fail('request id');
  if (o.pageHint !== null && (typeof o.pageHint !== 'string' || !PAGE_HINT.test(o.pageHint))) fail('page');
  const status = oneOf(o.status, SUPPORT_STATUSES, 'status'), closedAt = time(o.closedAt, 'closed time', true);
  if ((status === 'CLOSED') !== (closedAt !== null)) fail('closed');
  if (!Array.isArray(o.messages) || o.messages.length > 500) fail('messages');
  let last = 0;
  const messages = o.messages.map((m): SupportMessage => {
    const x = record(old && m && typeof m === 'object' && !Object.hasOwn(m, 'from') ? { ...(m as object), from: 'SCHOOL' } : m, ['seq', 'note', 'at', 'author', 'from'], 'message');
    if (typeof x.seq !== 'number' || !Number.isInteger(x.seq) || x.seq <= last) fail('message order');
    last = x.seq;
    return { seq: x.seq, note: text(x.note, 1, SUPPORT_MESSAGE_MAX, 'message'), at: time(x.at, 'message time')!, author: text(x.author, 1, 120, 'author'),
      from: oneOf(x.from, ['SCHOOL', 'HON'] as const, 'message from') };
  });
  const lastFrom = messages.at(-1)?.from ?? null;
  if (o.awaitingSchool !== ((status === 'OPEN' || status === 'WAITING_ON_SCHOOL') && lastFrom === 'HON')) fail('awaiting');
  return { requestId: o.requestId, topic: oneOf(o.topic, SUPPORT_TOPICS, 'topic'), subject: text(o.subject, 3, SUPPORT_SUBJECT_MAX, 'subject'), status,
    pageHint: o.pageHint as string | null, openedAt: time(o.openedAt, 'opened time')!, updatedAt: time(o.updatedAt, 'updated time')!, closedAt, messages,
    awaitingSchool: o.awaitingSchool as boolean };
}

export function verifySupportRequestList(v: unknown): SupportRequestList {
  const o = record(v, ['requests', 'limits', 'checkedAt', 'awaitingSchoolCount'], 'list');
  if (typeof o.awaitingSchoolCount !== 'number' || !Number.isInteger(o.awaitingSchoolCount) || o.awaitingSchoolCount < 0) fail('awaiting count');
  if (!Array.isArray(o.requests) || o.requests.length > 50) fail('requests');
  const l = record(o.limits, ['requestsPerDay', 'messagesPerDay', 'subjectMax', 'messageMax'], 'limits');
  for (const k of ['requestsPerDay', 'messagesPerDay', 'subjectMax', 'messageMax'] as const) if (typeof l[k] !== 'number' || !Number.isInteger(l[k]) || (l[k] as number) < 1) fail('limits');
  const requests = o.requests.map((r) => verifySupportRequest(r));
  if (new Set(requests.map((r) => r.requestId.toLowerCase())).size !== requests.length) fail('duplicate request');
  if ((o.awaitingSchoolCount as number) < requests.filter((r) => r.awaitingSchool).length) fail('awaiting count');
  return { requests, limits: l as SupportRequestList['limits'], checkedAt: time(o.checkedAt, 'checked time')!, awaitingSchoolCount: o.awaitingSchoolCount as number };
}
