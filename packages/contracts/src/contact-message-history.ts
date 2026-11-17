/**
 * Contact message history (0424, Conversation AI piece CA1b; docs/architecture/CONVERSATION_AI.md §3.1 #2, #3). One person's
 * messages across texts, emails, conversations, campaigns, automations and (for staff who may read them) family app messages,
 * the exact email a person was sent, and "Resend to saved address". Reading needs conversation.read; resending needs
 * conversation.manage and communication.message.queue, the person's saved email address and their email consent.
 */

export const CONTACT_HISTORY_LIMITS = { page: 50, searchMax: 60, previewMax: 160, bodyMax: 4000, resendsPerMessage: 3, resendsPerPerson: 10 } as const;
export const CONTACT_HISTORY_RANGES = ['ALL', 'TODAY', 'DAYS_7', 'DAYS_30'] as const;
export type ContactHistoryRange = (typeof CONTACT_HISTORY_RANGES)[number];
export const CONTACT_HISTORY_ORIGINS = ['STAFF', 'CONVERSATION', 'CAMPAIGN', 'AUTOMATION', 'FAMILY'] as const;
export type ContactHistoryOrigin = (typeof CONTACT_HISTORY_ORIGINS)[number];
export const CONTACT_HISTORY_CHANNELS = ['SMS', 'EMAIL', 'PUSH', 'APP', 'WEB_CHAT'] as const;
export type ContactHistoryChannel = (typeof CONTACT_HISTORY_CHANNELS)[number];
export const CONTACT_DELIVERY_STATES = ['QUEUED', 'CANCELLED', 'PENDING', 'SENDING', 'ACCEPTED', 'DELIVERED', 'BOUNCED', 'FAILED', 'SUPPRESSED', 'UNKNOWN'] as const;
export type ContactDeliveryState = (typeof CONTACT_DELIVERY_STATES)[number];
export const CONTACT_DELIVERY_EVENTS = ['SENT', 'DELIVERED', 'DEFERRED', 'BOUNCED', 'DROPPED', 'UNDELIVERED', 'FAILED', 'UNSUBSCRIBED', 'SPAM_REPORT'] as const;
export const CONTACT_RESEND_BLOCKS = ['NOT_ALLOWED', 'NOT_SENT', 'EMAIL_MISSING', 'CONSENT_REQUIRED', 'LIMIT_REACHED'] as const;
export type ContactResendBlock = (typeof CONTACT_RESEND_BLOCKS)[number];

/** Same-origin browser command names (the X-HON-Human-Command header). */
export const CONTACT_HISTORY_READ_COMMAND = 'contact.history.read';
export const CONTACT_EMAIL_RESEND_COMMAND = 'contact.email.resend';

export interface ContactHistoryQuery { range?: ContactHistoryRange; search?: string; before?: { at: string; id: string } }
export interface ContactHistoryRow {
  messageId: string; source: 'QUEUE' | 'CONVERSATION' | 'FAMILY'; channel: ContactHistoryChannel; direction: 'SENT' | 'RECEIVED';
  origin: ContactHistoryOrigin; subject: string | null; preview: string; at: string; by: string | null;
  delivery: ContactDeliveryState | null; failureCode: string | null; resentFrom: string | null;
}
export interface ContactHistory { personId: string; total: number; messages: ContactHistoryRow[]; includesFamily: boolean; nextCursor: { at: string; id: string } | null }
export interface ContactEmailView {
  message: { messageId: string; personId: string; origin: ContactHistoryOrigin; subject: string; subjectStandard: boolean; body: string; at: string; by: string | null };
  delivery: { status: ContactDeliveryState; failureCode: string | null; attempts: number; acceptedAt: string | null; finalAt: string | null;
    events: { type: (typeof CONTACT_DELIVERY_EVENTS)[number]; at: string }[] };
  savedAddress: string | null; emailConsent: 'OPTED_IN' | 'OPTED_OUT' | 'NONE'; resentFrom: string | null;
  resends: { messageId: string; at: string; by: string | null }[]; canResend: boolean; resendBlocked: ContactResendBlock | null;
}
export interface ContactEmailResendReceipt { messageId: string; resentFrom: string; personId: string; channel: 'EMAIL'; delivery: 'QUEUED'; at: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function invalid(): never { throw new Error('Invalid contact message data.'); }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (required.some(key => !(key in row)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  return row;
}
function count(value: unknown, maximum = 999_999_999): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > maximum) invalid();
  return value;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value; }
function nullableUuid(value: unknown): string | null { return value === null ? null : uuid(value); }
function instant(value: unknown): string { if (typeof value !== 'string' || !INSTANT.test(value) || new Date(value).toISOString() !== value) invalid(); return value; }
function nullableInstant(value: unknown): string | null { return value === null ? null : instant(value); }
function text(value: unknown, max: number, min = 0): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || CONTROL.test(value)) invalid();
  return value;
}
function nullableText(value: unknown, max: number): string | null { return value === null ? null : text(value, max, 1); }
function oneOf<T extends string>(value: unknown, list: readonly T[]): T {
  if (typeof value !== 'string' || !(list as readonly string[]).includes(value)) invalid();
  return value as T;
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }

export function contactHistorySearchOk(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= CONTACT_HISTORY_LIMITS.searchMax && value.trim() === value && !CONTROL.test(value);
}
export function validateContactHistoryQuery(value: unknown): ContactHistoryQuery {
  const row = record(value, [], ['range', 'search', 'before']);
  const out: ContactHistoryQuery = {};
  if ('range' in row) out.range = oneOf(row.range, CONTACT_HISTORY_RANGES);
  if ('search' in row) { if (!contactHistorySearchOk(row.search)) invalid(); out.search = row.search; }
  if ('before' in row) { const b = record(row.before, ['at', 'id']); out.before = { at: instant(b.at), id: uuid(b.id) }; }
  return out;
}
export function validateContactEmailResendInput(value: unknown): { personId: string; messageId: string } {
  const row = record(value, ['personId', 'messageId']);
  return { personId: uuid(row.personId), messageId: uuid(row.messageId) };
}

export function verifyContactHistoryRow(value: unknown): ContactHistoryRow {
  const row = record(value, ['messageId', 'source', 'channel', 'direction', 'origin', 'subject', 'preview', 'at', 'by', 'delivery', 'failureCode', 'resentFrom']);
  const source = oneOf(row.source, ['QUEUE', 'CONVERSATION', 'FAMILY'] as const);
  const channel = oneOf(row.channel, CONTACT_HISTORY_CHANNELS);
  const direction = oneOf(row.direction, ['SENT', 'RECEIVED'] as const);
  const origin = oneOf(row.origin, CONTACT_HISTORY_ORIGINS);
  const delivery = row.delivery === null ? null : oneOf(row.delivery, CONTACT_DELIVERY_STATES);
  const subject = nullableText(row.subject, 200);
  // Only 0047 messages are sent through the queue and carry a delivery result; only emails carry a subject.
  if ((source === 'QUEUE') !== (delivery !== null) || (source === 'QUEUE' && direction !== 'SENT')
    || (source === 'CONVERSATION' && (direction !== 'RECEIVED' || origin !== 'CONVERSATION'))
    || (source === 'FAMILY' && (channel !== 'APP' || origin !== 'FAMILY')) || (source !== 'FAMILY' && channel === 'APP')
    || (source === 'QUEUE' ? (channel === 'EMAIL') !== (subject !== null) : subject !== null) || (origin === 'FAMILY') !== (source === 'FAMILY')) invalid();
  const resentFrom = nullableUuid(row.resentFrom);
  if (resentFrom !== null && (channel !== 'EMAIL' || source !== 'QUEUE')) invalid();
  const failureCode = row.failureCode === null ? null : text(row.failureCode, 40, 1);
  if (failureCode !== null && source !== 'QUEUE') invalid();
  return { messageId: uuid(row.messageId), source, channel, direction, origin, subject, preview: text(row.preview, CONTACT_HISTORY_LIMITS.previewMax),
    at: instant(row.at), by: nullableText(row.by, 300), delivery, failureCode, resentFrom };
}
export function verifyContactHistory(value: unknown, personId: string): ContactHistory {
  const row = record(value, ['personId', 'total', 'messages', 'includesFamily', 'nextCursor']);
  if (uuid(row.personId) !== personId || !Array.isArray(row.messages) || row.messages.length > CONTACT_HISTORY_LIMITS.page) invalid();
  const messages = row.messages.map(verifyContactHistoryRow);
  if (new Set(messages.map(m => m.messageId)).size !== messages.length) invalid();
  if (messages.some((m, i) => i > 0 && (m.at > messages[i - 1]!.at || (m.at === messages[i - 1]!.at && m.messageId > messages[i - 1]!.messageId)))) invalid();
  const total = count(row.total);
  if (total < messages.length) invalid();
  let nextCursor = null;
  if (row.nextCursor !== null) {
    const n = record(row.nextCursor, ['at', 'id']);
    nextCursor = { at: instant(n.at), id: uuid(n.id) };
    const last = messages.at(-1);
    if (messages.length !== CONTACT_HISTORY_LIMITS.page || !last || last.at !== nextCursor.at || last.messageId !== nextCursor.id) invalid();
  }
  const includesFamily = bool(row.includesFamily);
  if (!includesFamily && messages.some(m => m.source === 'FAMILY')) invalid();
  return { personId, total, messages, includesFamily, nextCursor };
}
export function verifyContactEmailView(value: unknown, expected: { personId: string; messageId: string }): ContactEmailView {
  const row = record(value, ['message', 'delivery', 'savedAddress', 'emailConsent', 'resentFrom', 'resends', 'canResend', 'resendBlocked']);
  const m = record(row.message, ['messageId', 'personId', 'origin', 'subject', 'subjectStandard', 'body', 'at', 'by']);
  if (uuid(m.messageId) !== expected.messageId || uuid(m.personId) !== expected.personId) invalid();
  // The body is shown exactly as stored (plain text), so line breaks and tabs are kept; it is never rendered as HTML.
  if (typeof m.body !== 'string' || m.body.length < 1 || m.body.length > CONTACT_HISTORY_LIMITS.bodyMax || m.body.includes('\u0000')) invalid();
  const origin = oneOf(m.origin, CONTACT_HISTORY_ORIGINS);
  if (origin === 'FAMILY') invalid();
  const d = record(row.delivery, ['status', 'failureCode', 'attempts', 'acceptedAt', 'finalAt', 'events']);
  if (!Array.isArray(d.events) || d.events.length > 50) invalid();
  const events = d.events.map(e => { const x = record(e, ['type', 'at']); return { type: oneOf(x.type, CONTACT_DELIVERY_EVENTS), at: instant(x.at) }; });
  if (!Array.isArray(row.resends) || row.resends.length > 500) invalid();
  const resends = row.resends.map(e => { const x = record(e, ['messageId', 'at', 'by']); return { messageId: uuid(x.messageId), at: instant(x.at), by: nullableText(x.by, 300) }; });
  const canResend = bool(row.canResend);
  const resendBlocked = row.resendBlocked === null ? null : oneOf(row.resendBlocked, CONTACT_RESEND_BLOCKS);
  if (canResend !== (resendBlocked === null)) invalid();
  const savedAddress = row.savedAddress === null ? null : text(row.savedAddress, 320, 3);
  const emailConsent = oneOf(row.emailConsent, ['OPTED_IN', 'OPTED_OUT', 'NONE'] as const);
  if (canResend && (savedAddress === null || emailConsent !== 'OPTED_IN')) invalid();
  return {
    message: { messageId: expected.messageId, personId: expected.personId, origin, subject: text(m.subject, 200, 1), subjectStandard: bool(m.subjectStandard),
      body: m.body, at: instant(m.at), by: nullableText(m.by, 300) },
    delivery: { status: oneOf(d.status, CONTACT_DELIVERY_STATES), failureCode: d.failureCode === null ? null : text(d.failureCode, 40, 1), attempts: count(d.attempts, 5),
      acceptedAt: nullableInstant(d.acceptedAt), finalAt: nullableInstant(d.finalAt), events },
    savedAddress, emailConsent, resentFrom: nullableUuid(row.resentFrom), resends, canResend, resendBlocked,
  };
}
export function verifyContactEmailResendReceipt(value: unknown, expected: { personId: string; messageId: string }): ContactEmailResendReceipt {
  const row = record(value, ['messageId', 'resentFrom', 'personId', 'channel', 'delivery', 'at']);
  const messageId = uuid(row.messageId);
  if (uuid(row.resentFrom) !== expected.messageId || uuid(row.personId) !== expected.personId || messageId === expected.messageId
    || row.channel !== 'EMAIL' || row.delivery !== 'QUEUED') invalid();
  return { messageId, resentFrom: expected.messageId, personId: expected.personId, channel: 'EMAIL', delivery: 'QUEUED', at: instant(row.at) };
}
