/**
 * School conversations (0364, Conversation AI piece CA1; docs/architecture/CONVERSATION_AI.md §4). Texts a contact sends
 * to the school's number land in one inbox. Staff with conversation.read see it; staff with conversation.manage reply
 * (a consent-gated SMS through the 0047 queue and 0243 worker), assign, tag, open/close, link a person/lead or create a
 * lead from a conversation. No AI in this piece.
 */

export const CONVERSATION_LIMITS = { bodyMax: 1600, tags: 10, tagMax: 32, page: 50, messages: 100, searchMax: 60, nameMax: 100 } as const;
export const CONVERSATION_CHANNELS = ['SMS', 'EMAIL', 'WEB_CHAT'] as const;
export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number];
export const CONVERSATION_STATUSES = ['OPEN', 'CLOSED'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];
export const CONVERSATION_DELIVERY_STATES = ['QUEUED', 'CANCELLED', 'PENDING', 'SENDING', 'ACCEPTED', 'DELIVERED', 'BOUNCED', 'FAILED', 'SUPPRESSED', 'UNKNOWN'] as const;
export type ConversationDeliveryState = (typeof CONVERSATION_DELIVERY_STATES)[number];

/** Same-origin browser command names (the X-HON-Human-Command header), one per call. */
export const CONVERSATION_READ_COMMAND = 'conversation.read';
export const CONVERSATION_REPLY_COMMAND = 'conversation.reply';
export const CONVERSATION_UPDATE_COMMAND = 'conversation.update';
export const CONVERSATION_MARK_READ_COMMAND = 'conversation.mark_read';
export const CONVERSATION_LINK_COMMAND = 'conversation.link';
export const CONVERSATION_CREATE_LEAD_COMMAND = 'conversation.create_lead';

export interface ConversationLastMessage { direction: 'INBOUND' | 'OUTBOUND'; preview: string; mediaCount: number; at: string }
export interface ConversationRow {
  conversationId: string; channel: ConversationChannel; contactAddress: string; contactName: string | null;
  personId: string | null; leadId: string | null; leadStatus: string | null; leadStage: string | null;
  status: ConversationStatus; unread: number; tags: string[]; assignedTo: { principalId: string; name: string } | null;
  lastMessage: ConversationLastMessage | null; lastMessageAt: string; lastInboundAt: string | null; version: number;
}
export interface ConversationList { conversations: ConversationRow[]; nextCursor: { at: string; id: string } | null; unreadConversations: number; canManage: boolean }
export interface ConversationMessage {
  messageId: string; direction: 'INBOUND' | 'OUTBOUND'; author: 'CONTACT' | 'STAFF'; staffName: string | null; body: string; mediaCount: number;
  at: string; delivery: ConversationDeliveryState | null;
}
export interface ConversationContact {
  person: { personId: string; givenName: string; familyName: string; phone: string | null; email: string | null; smsConsent: 'OPTED_IN' | 'OPTED_OUT' | 'NONE' } | null;
  lead: { leadId: string; status: string; pipeline: string; stage: string; source: string | null; createdAt: string } | null;
  nextAppointment: { appointmentId: string; type: string; startsAt: string } | null;
  peopleWithNumber: number; schoolCanText: boolean;
}
export interface ConversationDetail { conversation: ConversationRow; contact: ConversationContact; messages: ConversationMessage[]; hasOlder: boolean; canManage: boolean }
export interface ConversationListQuery {
  status?: 'OPEN' | 'CLOSED' | 'ALL'; assigned?: 'ANY' | 'ME' | 'NONE'; unreadOnly?: boolean; tag?: string; search?: string; before?: { at: string; id: string };
  /** 0401: only this person's conversations (the contact card's Texts). */
  personId?: string;
}
export interface ReplyConversationInput { conversationId: string; expectedVersion: number; body: string }
export interface UpdateConversationInput { conversationId: string; expectedVersion: number; status?: ConversationStatus; assignedPrincipalId?: string | null; tags?: string[] }
export interface MarkConversationReadInput { conversationId: string; throughMessageId: string }
export interface LinkConversationInput { conversationId: string; expectedVersion: number; personId: string; leadId: string | null }
export interface CreateConversationLeadInput { conversationId: string; expectedVersion: number; givenName: string; familyName: string; pipelineId: string; stageId: string }
export interface ConversationReplyReceipt { conversation: ConversationRow; message: ConversationMessage }
export interface ConversationUpdateReceipt { conversation: ConversationRow }
export interface ConversationLinkReceipt { conversation: ConversationRow; contact: ConversationContact }
export interface ConversationReadMark { conversationId: string; unread: number; version: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const E164 = /^\+[1-9]\d{7,14}$/;
const CONTROL = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const TAG = /^[\p{L}\p{N}](?:[\p{L}\p{N} -]{0,30}[\p{L}\p{N}])?$/u;

function invalid(): never { throw new Error('Invalid conversation data.'); }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (required.some(key => !(key in row)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  return row;
}
function count(value: unknown, minimum = 0, maximum = 999_999_999): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value; }
function nullableUuid(value: unknown): string | null { return value === null ? null : uuid(value); }
function instant(value: unknown): string { if (typeof value !== 'string' || !INSTANT.test(value) || new Date(value).toISOString() !== value) invalid(); return value; }
function nullableInstant(value: unknown): string | null { return value === null ? null : instant(value); }
function text(value: unknown, max = 300): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}
function nullableText(value: unknown, max = 300): string | null { return value === null ? null : text(value, max); }
function oneOf<T extends string>(value: unknown, list: readonly T[]): T {
  if (typeof value !== 'string' || !(list as readonly string[]).includes(value)) invalid();
  return value as T;
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }

/** True when the database will store this text: 1-1,600 characters, not blank, no control characters but line breaks and tabs. */
export function conversationBodyOk(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= CONVERSATION_LIMITS.bodyMax && value.trim() !== '' && !CONTROL.test(value) && !value.includes('\u0000');
}
export function conversationTagOk(value: unknown): value is string { return typeof value === 'string' && TAG.test(value); }
export function conversationTagsOk(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= CONVERSATION_LIMITS.tags && value.every(conversationTagOk)
    && new Set(value.map(t => (t as string).toLowerCase())).size === value.length;
}
function nameOk(value: unknown, min: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= CONVERSATION_LIMITS.nameMax && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

export function validateConversationListQuery(value: unknown): ConversationListQuery {
  const row = record(value, [], ['status', 'assigned', 'unreadOnly', 'tag', 'search', 'before', 'personId']);
  const out: ConversationListQuery = {};
  if ('status' in row) out.status = oneOf(row.status, ['OPEN', 'CLOSED', 'ALL'] as const);
  if ('assigned' in row) out.assigned = oneOf(row.assigned, ['ANY', 'ME', 'NONE'] as const);
  if ('unreadOnly' in row) out.unreadOnly = bool(row.unreadOnly);
  if ('tag' in row) { if (!conversationTagOk(row.tag)) invalid(); out.tag = row.tag; }
  if ('search' in row) {
    const s = row.search;
    if (typeof s !== 'string' || s.length < 1 || s.length > CONVERSATION_LIMITS.searchMax || s.trim() !== s || /[\u0000-\u001f\u007f]/.test(s)) invalid();
    out.search = s;
  }
  if ('personId' in row) out.personId = uuid(row.personId);
  if ('before' in row) { const b = record(row.before, ['at', 'id']); out.before = { at: instant(b.at), id: uuid(b.id) }; }
  return out;
}
export function validateReplyConversationInput(value: unknown): ReplyConversationInput {
  const row = record(value, ['conversationId', 'expectedVersion', 'body']);
  if (!conversationBodyOk(row.body)) invalid();
  return { conversationId: uuid(row.conversationId), expectedVersion: count(row.expectedVersion, 1), body: row.body };
}
export function validateUpdateConversationInput(value: unknown): UpdateConversationInput {
  const row = record(value, ['conversationId', 'expectedVersion'], ['status', 'assignedPrincipalId', 'tags']);
  if (!('status' in row) && !('assignedPrincipalId' in row) && !('tags' in row)) invalid();
  const out: UpdateConversationInput = { conversationId: uuid(row.conversationId), expectedVersion: count(row.expectedVersion, 1) };
  if ('status' in row) out.status = oneOf(row.status, CONVERSATION_STATUSES);
  if ('assignedPrincipalId' in row) out.assignedPrincipalId = nullableUuid(row.assignedPrincipalId);
  if ('tags' in row) { if (!conversationTagsOk(row.tags)) invalid(); out.tags = [...row.tags]; }
  return out;
}
export function validateMarkConversationReadInput(value: unknown): MarkConversationReadInput {
  const row = record(value, ['conversationId', 'throughMessageId']);
  return { conversationId: uuid(row.conversationId), throughMessageId: uuid(row.throughMessageId) };
}
export function validateLinkConversationInput(value: unknown): LinkConversationInput {
  const row = record(value, ['conversationId', 'expectedVersion', 'personId', 'leadId']);
  return { conversationId: uuid(row.conversationId), expectedVersion: count(row.expectedVersion, 1), personId: uuid(row.personId), leadId: nullableUuid(row.leadId) };
}
export function validateCreateConversationLeadInput(value: unknown): CreateConversationLeadInput {
  const row = record(value, ['conversationId', 'expectedVersion', 'givenName', 'familyName', 'pipelineId', 'stageId']);
  if (!nameOk(row.givenName, 1) || !nameOk(row.familyName, 0)) invalid();
  return { conversationId: uuid(row.conversationId), expectedVersion: count(row.expectedVersion, 1), givenName: row.givenName, familyName: row.familyName,
    pipelineId: uuid(row.pipelineId), stageId: uuid(row.stageId) };
}

export function verifyConversationRow(value: unknown): ConversationRow {
  const row = record(value, ['conversationId', 'channel', 'contactAddress', 'contactName', 'personId', 'leadId', 'leadStatus', 'leadStage', 'status', 'unread',
    'tags', 'assignedTo', 'lastMessage', 'lastMessageAt', 'lastInboundAt', 'version']);
  const channel = oneOf(row.channel, CONVERSATION_CHANNELS);
  const address = text(row.contactAddress, 320);
  if (channel === 'SMS' && !E164.test(address)) invalid();
  if (!conversationTagsOk(row.tags)) invalid();
  let assignedTo = null;
  if (row.assignedTo !== null) { const a = record(row.assignedTo, ['principalId', 'name']); assignedTo = { principalId: uuid(a.principalId), name: text(a.name) }; }
  let lastMessage = null;
  if (row.lastMessage !== null) {
    const m = record(row.lastMessage, ['direction', 'preview', 'mediaCount', 'at']);
    if (typeof m.preview !== 'string' || m.preview.length > 120) invalid();
    lastMessage = { direction: oneOf(m.direction, ['INBOUND', 'OUTBOUND'] as const), preview: m.preview, mediaCount: count(m.mediaCount, 0, 10), at: instant(m.at) };
  }
  const out: ConversationRow = { conversationId: uuid(row.conversationId), channel, contactAddress: address, contactName: nullableText(row.contactName, 201),
    personId: nullableUuid(row.personId), leadId: nullableUuid(row.leadId), leadStatus: nullableText(row.leadStatus, 40), leadStage: nullableText(row.leadStage),
    status: oneOf(row.status, CONVERSATION_STATUSES), unread: count(row.unread, 0, 100000), tags: [...(row.tags as string[])], assignedTo, lastMessage,
    lastMessageAt: instant(row.lastMessageAt), lastInboundAt: nullableInstant(row.lastInboundAt), version: count(row.version, 1) };
  if (out.leadId && !out.personId) invalid();
  return out;
}
export function verifyConversationList(value: unknown): ConversationList {
  const row = record(value, ['conversations', 'nextCursor', 'unreadConversations', 'canManage']);
  if (!Array.isArray(row.conversations) || row.conversations.length > CONVERSATION_LIMITS.page) invalid();
  const conversations = row.conversations.map(verifyConversationRow);
  if (new Set(conversations.map(c => c.conversationId)).size !== conversations.length) invalid();
  if (conversations.some((c, i) => i > 0 && c.lastMessageAt > conversations[i - 1]!.lastMessageAt)) invalid();
  let nextCursor = null;
  if (row.nextCursor !== null) { const n = record(row.nextCursor, ['at', 'id']); nextCursor = { at: instant(n.at), id: uuid(n.id) }; }
  return { conversations, nextCursor, unreadConversations: count(row.unreadConversations), canManage: bool(row.canManage) };
}
export function verifyConversationMessage(value: unknown): ConversationMessage {
  const row = record(value, ['messageId', 'direction', 'author', 'staffName', 'body', 'mediaCount', 'at', 'delivery']);
  const direction = oneOf(row.direction, ['INBOUND', 'OUTBOUND'] as const);
  const author = oneOf(row.author, ['CONTACT', 'STAFF'] as const);
  const mediaCount = count(row.mediaCount, 0, 10);
  if (!(conversationBodyOk(row.body) || (row.body === '' && mediaCount > 0))) invalid();
  const delivery = row.delivery === null ? null : oneOf(row.delivery, CONVERSATION_DELIVERY_STATES);
  if ((direction === 'INBOUND') !== (author === 'CONTACT') || (direction === 'OUTBOUND') !== (delivery !== null)) invalid();
  return { messageId: uuid(row.messageId), direction, author, staffName: nullableText(row.staffName), body: row.body as string, mediaCount, at: instant(row.at), delivery };
}
export function verifyConversationContact(value: unknown): ConversationContact {
  const row = record(value, ['person', 'lead', 'nextAppointment', 'peopleWithNumber', 'schoolCanText']);
  let person = null;
  if (row.person !== null) {
    const p = record(row.person, ['personId', 'givenName', 'familyName', 'phone', 'email', 'smsConsent']);
    person = { personId: uuid(p.personId), givenName: text(p.givenName), familyName: text(p.familyName), phone: nullableText(p.phone, 16), email: nullableText(p.email, 320),
      smsConsent: oneOf(p.smsConsent, ['OPTED_IN', 'OPTED_OUT', 'NONE'] as const) };
  }
  let lead = null;
  if (row.lead !== null) {
    const l = record(row.lead, ['leadId', 'status', 'pipeline', 'stage', 'source', 'createdAt']);
    lead = { leadId: uuid(l.leadId), status: text(l.status, 40), pipeline: text(l.pipeline), stage: text(l.stage), source: nullableText(l.source, 100), createdAt: instant(l.createdAt) };
  }
  let nextAppointment = null;
  if (row.nextAppointment !== null) {
    const a = record(row.nextAppointment, ['appointmentId', 'type', 'startsAt']);
    nextAppointment = { appointmentId: uuid(a.appointmentId), type: text(a.type, 40), startsAt: instant(a.startsAt) };
  }
  return { person, lead, nextAppointment, peopleWithNumber: count(row.peopleWithNumber), schoolCanText: bool(row.schoolCanText) };
}
export function verifyConversationDetail(value: unknown, conversationId: string): ConversationDetail {
  const row = record(value, ['conversation', 'contact', 'messages', 'hasOlder', 'canManage']);
  const conversation = verifyConversationRow(row.conversation);
  if (conversation.conversationId !== conversationId) invalid();
  if (!Array.isArray(row.messages) || row.messages.length > CONVERSATION_LIMITS.messages) invalid();
  const messages = row.messages.map(verifyConversationMessage);
  if (messages.some((m, i) => i > 0 && m.at < messages[i - 1]!.at)) invalid();
  if (new Set(messages.map(m => m.messageId)).size !== messages.length) invalid();
  return { conversation, contact: verifyConversationContact(row.contact), messages, hasOlder: bool(row.hasOlder), canManage: bool(row.canManage) };
}
export function verifyConversationReplyReceipt(value: unknown, expected: { conversationId: string; body: string }): ConversationReplyReceipt {
  const row = record(value, ['conversation', 'message']);
  const conversation = verifyConversationRow(row.conversation);
  const message = verifyConversationMessage(row.message);
  if (conversation.conversationId !== expected.conversationId || message.direction !== 'OUTBOUND' || message.body !== expected.body) invalid();
  return { conversation, message };
}
export function verifyConversationUpdateReceipt(value: unknown, conversationId: string): ConversationUpdateReceipt {
  const row = record(value, ['conversation']);
  const conversation = verifyConversationRow(row.conversation);
  if (conversation.conversationId !== conversationId) invalid();
  return { conversation };
}
export function verifyConversationLinkReceipt(value: unknown, conversationId: string): ConversationLinkReceipt {
  const row = record(value, ['conversation', 'contact']);
  const conversation = verifyConversationRow(row.conversation);
  if (conversation.conversationId !== conversationId || !conversation.personId) invalid();
  return { conversation, contact: verifyConversationContact(row.contact) };
}
export function verifyConversationReadMark(value: unknown, conversationId: string): ConversationReadMark {
  const row = record(value, ['conversationId', 'unread', 'version']);
  const out = { conversationId: uuid(row.conversationId), unread: count(row.unread, 0, 100000), version: count(row.version, 1) };
  if (out.conversationId !== conversationId) invalid();
  return out;
}
