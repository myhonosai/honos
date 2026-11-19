/**
 * School message history and opted-out list (0572, Texts and Email pages piece TE1; docs/architecture/SCHOOL_TEXTS_AND_EMAIL_PAGES.md §4).
 * The History tab of the Texts and Email pages lists every sent (non-draft) text or email of the school, newest first, with who it went
 * to, the delivery state and where it came from (communication.message.read). The Opted out tab lists the people whose consent for a
 * channel is OPTED_OUT (communication.consent.read). Both are read only; one message's full email and resend stay on the 0424 reads.
 */
import { CONTACT_DELIVERY_STATES, type ContactDeliveryState } from './contact-message-history.js';

export const SCHOOL_MESSAGES_LIMITS = { page: 50, searchMax: 60, previewMax: 160 } as const;
export const SCHOOL_MESSAGE_CHANNELS = ['SMS', 'EMAIL'] as const;
export type SchoolMessageChannel = (typeof SCHOOL_MESSAGE_CHANNELS)[number];
export const SCHOOL_MESSAGE_OUTCOMES = ['DELIVERED', 'FAILED', 'IN_PROGRESS', 'CANCELLED'] as const;
export type SchoolMessageOutcome = (typeof SCHOOL_MESSAGE_OUTCOMES)[number];
export const SCHOOL_MESSAGE_ORIGINS = ['STAFF', 'CONVERSATION', 'CAMPAIGN', 'AUTOMATION'] as const;
export type SchoolMessageOrigin = (typeof SCHOOL_MESSAGE_ORIGINS)[number];
export const SCHOOL_MESSAGE_RANGES = ['ALL', 'TODAY', 'DAYS_7', 'DAYS_30'] as const;
export type SchoolMessageRange = (typeof SCHOOL_MESSAGE_RANGES)[number];
export const SCHOOL_OPT_OUT_SOURCES = ['STAFF', 'PARENT', 'IMPORT', 'RECIPIENT'] as const;
export type SchoolOptOutSource = (typeof SCHOOL_OPT_OUT_SOURCES)[number];

/** Same-origin browser command names (the X-HON-Human-Command header). */
export const SCHOOL_MESSAGE_HISTORY_READ_COMMAND = 'school.messages.history.read';
export const SCHOOL_OPTED_OUT_READ_COMMAND = 'school.messages.opted_out.read';

export interface SchoolMessageCursor { at: string; id: string }
export interface SchoolMessageHistoryQuery {
  channel?: SchoolMessageChannel; outcome?: SchoolMessageOutcome; origin?: SchoolMessageOrigin; range?: SchoolMessageRange; search?: string; before?: SchoolMessageCursor;
}
export interface SchoolMessageHistoryRow {
  messageId: string; personId: string; personName: string; address: string | null; channel: SchoolMessageChannel; subject: string | null;
  preview: string; at: string; origin: SchoolMessageOrigin; delivery: ContactDeliveryState; outcome: SchoolMessageOutcome; by: string | null;
}
export interface SchoolMessageHistory { messages: SchoolMessageHistoryRow[]; nextCursor: SchoolMessageCursor | null }
export interface SchoolOptedOutQuery { channel?: SchoolMessageChannel; search?: string; before?: SchoolMessageCursor }
export interface SchoolOptedOutRow {
  consentId: string; personId: string; personName: string; address: string | null; channel: SchoolMessageChannel; source: SchoolOptOutSource; optedOutAt: string; at: string;
}
export interface SchoolOptedOut { contacts: SchoolOptedOutRow[]; nextCursor: SchoolMessageCursor | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function invalid(): never { throw new Error('Invalid school message data.'); }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (required.some(key => !(key in row)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  return row;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value; }
function instant(value: unknown): string { if (typeof value !== 'string' || !INSTANT.test(value) || new Date(value).toISOString() !== value) invalid(); return value; }
function text(value: unknown, max: number, min = 0): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || CONTROL.test(value)) invalid();
  return value;
}
function nullableText(value: unknown, max: number): string | null { return value === null ? null : text(value, max, 1); }
function oneOf<T extends string>(value: unknown, list: readonly T[]): T {
  if (typeof value !== 'string' || !(list as readonly string[]).includes(value)) invalid();
  return value as T;
}
function cursor(value: unknown): SchoolMessageCursor {
  const row = record(value, ['at', 'id']);
  return { at: instant(row.at), id: uuid(row.id) };
}

/** The outcome group the database gives a delivery state; the verifiers check rows against it. */
export function schoolMessageOutcome(state: ContactDeliveryState): SchoolMessageOutcome {
  if (state === 'ACCEPTED' || state === 'DELIVERED') return 'DELIVERED';
  if (state === 'BOUNCED' || state === 'FAILED' || state === 'SUPPRESSED') return 'FAILED';
  if (state === 'CANCELLED') return 'CANCELLED';
  return 'IN_PROGRESS';
}
export function schoolMessagesSearchOk(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= SCHOOL_MESSAGES_LIMITS.searchMax && value.trim() === value && !CONTROL.test(value);
}
function search(value: unknown): string { if (!schoolMessagesSearchOk(value)) invalid(); return value; }

export function validateSchoolMessageHistoryQuery(value: unknown): SchoolMessageHistoryQuery {
  const row = record(value, [], ['channel', 'outcome', 'origin', 'range', 'search', 'before']);
  const out: SchoolMessageHistoryQuery = {};
  if ('channel' in row) out.channel = oneOf(row.channel, SCHOOL_MESSAGE_CHANNELS);
  if ('outcome' in row) out.outcome = oneOf(row.outcome, SCHOOL_MESSAGE_OUTCOMES);
  if ('origin' in row) out.origin = oneOf(row.origin, SCHOOL_MESSAGE_ORIGINS);
  if ('range' in row) out.range = oneOf(row.range, SCHOOL_MESSAGE_RANGES);
  if ('search' in row) out.search = search(row.search);
  if ('before' in row) out.before = cursor(row.before);
  return out;
}
export function validateSchoolOptedOutQuery(value: unknown): SchoolOptedOutQuery {
  const row = record(value, [], ['channel', 'search', 'before']);
  const out: SchoolOptedOutQuery = {};
  if ('channel' in row) out.channel = oneOf(row.channel, SCHOOL_MESSAGE_CHANNELS);
  if ('search' in row) out.search = search(row.search);
  if ('before' in row) out.before = cursor(row.before);
  return out;
}

function ordered<T>(rows: T[], at: (r: T) => string, id: (r: T) => string): void {
  if (new Set(rows.map(id)).size !== rows.length) invalid();
  if (rows.some((r, i) => i > 0 && (at(r) > at(rows[i - 1]!) || (at(r) === at(rows[i - 1]!) && id(r) > id(rows[i - 1]!))))) invalid();
}
function pageCursor<T>(value: unknown, rows: T[], at: (r: T) => string, id: (r: T) => string): SchoolMessageCursor | null {
  if (value === null) return null;
  const next = cursor(value);
  const last = rows.at(-1);
  if (rows.length !== SCHOOL_MESSAGES_LIMITS.page || !last || at(last) !== next.at || id(last) !== next.id) invalid();
  return next;
}

export function verifySchoolMessageHistoryRow(value: unknown): SchoolMessageHistoryRow {
  const row = record(value, ['messageId', 'personId', 'personName', 'address', 'channel', 'subject', 'preview', 'at', 'origin', 'delivery', 'outcome', 'by']);
  const channel = oneOf(row.channel, SCHOOL_MESSAGE_CHANNELS);
  const subject = nullableText(row.subject, 200);
  // Only emails carry a subject (the author's, or the standard one the email adapter uses), and every email has one.
  if ((channel === 'EMAIL') !== (subject !== null)) invalid();
  const delivery = oneOf(row.delivery, CONTACT_DELIVERY_STATES);
  const outcome = oneOf(row.outcome, SCHOOL_MESSAGE_OUTCOMES);
  if (outcome !== schoolMessageOutcome(delivery)) invalid();
  return { messageId: uuid(row.messageId), personId: uuid(row.personId), personName: text(row.personName, 300), address: nullableText(row.address, 320),
    channel, subject, preview: text(row.preview, SCHOOL_MESSAGES_LIMITS.previewMax), at: instant(row.at), origin: oneOf(row.origin, SCHOOL_MESSAGE_ORIGINS),
    delivery, outcome, by: nullableText(row.by, 300) };
}
export function verifySchoolMessageHistory(value: unknown, query: SchoolMessageHistoryQuery = {}): SchoolMessageHistory {
  const row = record(value, ['messages', 'nextCursor']);
  if (!Array.isArray(row.messages) || row.messages.length > SCHOOL_MESSAGES_LIMITS.page) invalid();
  const messages = row.messages.map(verifySchoolMessageHistoryRow);
  ordered(messages, m => m.at, m => m.messageId);
  // Each answered row matches the filters asked for, and a page never starts at or before its cursor.
  if (messages.some(m => (query.channel && m.channel !== query.channel) || (query.outcome && m.outcome !== query.outcome) || (query.origin && m.origin !== query.origin)
    || (query.before && (m.at > query.before.at || (m.at === query.before.at && m.messageId >= query.before.id))))) invalid();
  return { messages, nextCursor: pageCursor(row.nextCursor, messages, m => m.at, m => m.messageId) };
}

export function verifySchoolOptedOutRow(value: unknown): SchoolOptedOutRow {
  const row = record(value, ['consentId', 'personId', 'personName', 'address', 'channel', 'source', 'optedOutAt', 'at']);
  return { consentId: uuid(row.consentId), personId: uuid(row.personId), personName: text(row.personName, 300), address: nullableText(row.address, 320),
    channel: oneOf(row.channel, SCHOOL_MESSAGE_CHANNELS), source: oneOf(row.source, SCHOOL_OPT_OUT_SOURCES), optedOutAt: instant(row.optedOutAt), at: instant(row.at) };
}
export function verifySchoolOptedOut(value: unknown, query: SchoolOptedOutQuery = {}): SchoolOptedOut {
  const row = record(value, ['contacts', 'nextCursor']);
  if (!Array.isArray(row.contacts) || row.contacts.length > SCHOOL_MESSAGES_LIMITS.page) invalid();
  const contacts = row.contacts.map(verifySchoolOptedOutRow);
  ordered(contacts, c => c.at, c => c.consentId);
  if (contacts.some(c => (query.channel && c.channel !== query.channel)
    || (query.before && (c.at > query.before.at || (c.at === query.before.at && c.consentId >= query.before.id))))) invalid();
  return { contacts, nextCursor: pageCursor(row.nextCursor, contacts, c => c.at, c => c.consentId) };
}
