/**
 * Family messages (0330): a signed-in guardian writes to their school inside HON, and staff with family_messages.manage read
 * every family thread of the school and reply. VIEWER grants read only. Families never see staff names. Nothing is texted,
 * emailed or pushed, and no AI drafts anything.
 */

export const FAMILY_MESSAGE_LIMITS = { bodyMax: 2000, perThread: 200, inbox: 200, familyPerHour: 30, schoolPerHour: 600 } as const;
export const FAMILY_MESSAGE_FROM = ['FAMILY', 'SCHOOL'] as const;
export type FamilyMessageFrom = (typeof FAMILY_MESSAGE_FROM)[number];

export interface FamilyMessage { messageId: string; from: FamilyMessageFrom; mine: boolean; body: string; sentAt: string }
export interface ParentFamilyMessages { canWrite: boolean; schoolName: string; threadId: string | null; messages: FamilyMessage[] }
export interface FamilyMessageReceipt { threadId: string; version: number; message: FamilyMessage }
export interface FamilyMessageInboxThread {
  threadId: string; familyId: string; familyName: string; lastMessageAt: string; lastFrom: FamilyMessageFrom; messageCount: number;
  unreadCount: number; version: number;
}
export interface FamilyMessageInbox { threads: FamilyMessageInboxThread[]; unreadThreads: number }
export interface FamilyMessageThread { threadId: string; familyId: string; familyName: string; version: number; unreadCount: number; messages: FamilyMessage[] }
export interface FamilyMessageReadMark { threadId: string; version: number; unreadCount: number }
export interface SendFamilyMessageInput { body: string }
/** throughMessageId is the newest message the staff member loaded: the read mark moves up to it and never past it. */
export interface ReplyFamilyMessageInput { threadId: string; body: string; throughMessageId: string }
export interface MarkFamilyMessageReadInput { threadId: string; throughMessageId: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// Line breaks and tabs are allowed; every other control character is refused (the 0330 database rule).
const CONTROL = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function invalid(): never { throw new Error('Invalid family message data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !(key in row))) invalid();
  return row;
}
function count(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > 999_999_999) invalid();
  return value;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value; }
function instant(value: unknown): string { if (typeof value !== 'string' || !INSTANT.test(value) || new Date(value).toISOString() !== value) invalid(); return value; }
function from(value: unknown): FamilyMessageFrom { if (typeof value !== 'string' || !(FAMILY_MESSAGE_FROM as readonly string[]).includes(value)) invalid(); return value as FamilyMessageFrom; }
function name(value: unknown): string {
  if (typeof value !== 'string' || value.length > 300 || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}

/** True when the text is a message the database will store: 1-2,000 characters, not blank, no control characters. */
export function familyMessageBodyOk(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= FAMILY_MESSAGE_LIMITS.bodyMax && value.trim() !== '' && !CONTROL.test(value) && !value.includes('\u0000');
}
export function validateSendFamilyMessageInput(value: unknown): SendFamilyMessageInput {
  const row = record(value, ['body']);
  if (!familyMessageBodyOk(row.body)) invalid();
  return { body: row.body };
}
export function validateReplyFamilyMessageInput(value: unknown): ReplyFamilyMessageInput {
  const row = record(value, ['threadId', 'body', 'throughMessageId']);
  if (!familyMessageBodyOk(row.body)) invalid();
  return { threadId: uuid(row.threadId), body: row.body, throughMessageId: uuid(row.throughMessageId) };
}
export function validateMarkFamilyMessageReadInput(value: unknown): MarkFamilyMessageReadInput {
  const row = record(value, ['threadId', 'throughMessageId']);
  return { threadId: uuid(row.threadId), throughMessageId: uuid(row.throughMessageId) };
}

export function verifyFamilyMessage(value: unknown): FamilyMessage {
  const row = record(value, ['messageId', 'from', 'mine', 'body', 'sentAt']);
  if (typeof row.mine !== 'boolean' || !familyMessageBodyOk(row.body)) invalid();
  return { messageId: uuid(row.messageId), from: from(row.from), mine: row.mine, body: row.body, sentAt: instant(row.sentAt) };
}
function messages(value: unknown): FamilyMessage[] {
  if (!Array.isArray(value) || value.length > FAMILY_MESSAGE_LIMITS.perThread) invalid();
  const out = value.map(verifyFamilyMessage);
  if (out.some((m, i) => i > 0 && m.sentAt < out[i - 1]!.sentAt)) invalid();
  if (new Set(out.map(m => m.messageId)).size !== out.length) invalid();
  return out;
}
export function verifyParentFamilyMessages(value: unknown): ParentFamilyMessages {
  const row = record(value, ['canWrite', 'schoolName', 'threadId', 'messages']);
  if (typeof row.canWrite !== 'boolean') invalid();
  const threadId = row.threadId === null ? null : uuid(row.threadId);
  const list = messages(row.messages);
  if (threadId === null && list.length) invalid();
  return { canWrite: row.canWrite, schoolName: name(row.schoolName), threadId, messages: list };
}
export function verifyFamilyMessageReceipt(value: unknown, expected: { from: FamilyMessageFrom; body: string; threadId?: string }): FamilyMessageReceipt {
  const row = record(value, ['threadId', 'version', 'message']);
  const message = verifyFamilyMessage(row.message);
  const threadId = uuid(row.threadId);
  if (message.from !== expected.from || message.body !== expected.body || !message.mine || (expected.threadId && threadId !== expected.threadId)) invalid();
  return { threadId, version: count(row.version, 2), message };
}
export function verifyFamilyMessageInbox(value: unknown): FamilyMessageInbox {
  const row = record(value, ['threads', 'unreadThreads']);
  if (!Array.isArray(row.threads) || row.threads.length > FAMILY_MESSAGE_LIMITS.inbox) invalid();
  const threads = row.threads.map(item => {
    const t = record(item, ['threadId', 'familyId', 'familyName', 'lastMessageAt', 'lastFrom', 'messageCount', 'unreadCount', 'version']);
    const out: FamilyMessageInboxThread = { threadId: uuid(t.threadId), familyId: uuid(t.familyId), familyName: name(t.familyName),
      lastMessageAt: instant(t.lastMessageAt), lastFrom: from(t.lastFrom), messageCount: count(t.messageCount, 1), unreadCount: count(t.unreadCount, 0),
      version: count(t.version, 2) };
    if (out.unreadCount > out.messageCount) invalid();
    return out;
  });
  if (threads.some((t, i) => i > 0 && t.lastMessageAt > threads[i - 1]!.lastMessageAt)) invalid();
  if (new Set(threads.map(t => t.threadId)).size !== threads.length) invalid();
  const unreadThreads = count(row.unreadThreads, 0);
  if (unreadThreads !== threads.filter(t => t.unreadCount > 0).length) invalid();
  return { threads, unreadThreads };
}
export function verifyFamilyMessageThread(value: unknown, threadId: string): FamilyMessageThread {
  const row = record(value, ['threadId', 'familyId', 'familyName', 'version', 'unreadCount', 'messages']);
  const out: FamilyMessageThread = { threadId: uuid(row.threadId), familyId: uuid(row.familyId), familyName: name(row.familyName),
    version: count(row.version, 1), unreadCount: count(row.unreadCount, 0), messages: messages(row.messages) };
  if (out.threadId !== threadId) invalid();
  return out;
}
export function verifyFamilyMessageReadMark(value: unknown, threadId: string): FamilyMessageReadMark {
  const row = record(value, ['threadId', 'version', 'unreadCount']);
  const out = { threadId: uuid(row.threadId), version: count(row.version, 1), unreadCount: count(row.unreadCount, 0) };
  if (out.threadId !== threadId) invalid();
  return out;
}
