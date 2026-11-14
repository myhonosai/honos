// School social inbox (0349, docs/architecture/SOCIAL_POSTING_INBOX_ADS.md §4B): Messenger conversations, Instagram DMs
// and comments on the school's own posts in one school inbox. Staff reply, hide comments, mark read, assign and link to a
// CRM lead or person. Receiving and sending need HON_ZERNIO_INBOX_APPROVED on the API server.
import { SOCIAL_PLATFORMS, type SocialPlatform } from './school-social.js';

export const SOCIAL_CONVERSATION_KINDS = ['DM', 'COMMENT'] as const;
export const SOCIAL_MESSAGE_STATUSES = ['RECEIVED', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN'] as const;
export const SOCIAL_INBOX_VIEWS = ['ALL', 'UNREAD', 'MINE'] as const;
export const SOCIAL_INBOX_CHANGE_COMMAND = 'marketing.social.inbox.change';
export const SOCIAL_INBOX_REPLY_COMMAND = 'marketing.social.inbox.reply';
export const SOCIAL_INBOX_RESOLVE_COMMAND = 'marketing.social.inbox.resolve';
export const SOCIAL_INBOX_COMMENT_COMMAND = 'marketing.social.inbox.comment';
export const SOCIAL_MESSAGE_TEXT_MAX = 2000;

export type SocialConversationKind = typeof SOCIAL_CONVERSATION_KINDS[number];
export type SocialMessageStatus = typeof SOCIAL_MESSAGE_STATUSES[number];
export type SocialInboxView = typeof SOCIAL_INBOX_VIEWS[number];
export interface SocialConversation {
  conversationId: string; accountId: string; platform: SocialPlatform; accountName: string; kind: SocialConversationKind; participantName: string;
  lastInboundAt: string | null; lastMessageAt: string; unread: number; assignedPrincipalId: string | null; linkedLeadId: string | null;
  linkedPersonId: string | null; commentHidden: boolean; inboxOn: boolean; replyWindowOpen: boolean; preview: string | null; version: number;
}
export interface SocialMessage {
  messageId: string; direction: 'INBOUND' | 'OUTBOUND'; text: string; status: SocialMessageStatus; sentByPerson: boolean; resolvedByPerson: boolean;
  occurredAt: string; version: number;
}
export interface SocialInboxList { conversations: SocialConversation[]; inboxEnabled: boolean; checkedAt: string }
export interface SocialConversationDetail { conversation: SocialConversation; messages: SocialMessage[]; inboxEnabled: boolean; checkedAt: string }
export interface SocialReplyResult { conversation: SocialConversation; message: SocialMessage }
export interface SocialCommentActionResult { conversation: SocialConversation; actionId: string; action: 'HIDE' | 'UNHIDE'; status: 'SENDING' | 'DONE' | 'FAILED' | 'UNKNOWN' }
export interface SocialConversationChangeInput {
  expectedVersion: number; read?: true; assignedPrincipalId?: string | null; linkedLeadId?: string | null; linkedPersonId?: string | null;
}
export interface SocialReplyInput { text: string }
export interface SocialMessageResolveInput { expectedVersion: number; outcome: 'SENT' | 'NOT_SENT' }
export interface SocialCommentActionInput { action: 'HIDE' | 'UNHIDE' }

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
function fail(what: string): never { throw new Error(`Unverified school social ${what}.`); }
function record(v: unknown, keys: readonly string[], what: string, optional: readonly string[] = []): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(what);
  const o = v as Record<string, unknown>, present = Object.keys(o);
  if (keys.some(k => !present.includes(k)) || present.some(k => !keys.includes(k) && !optional.includes(k))) fail(what);
  return o;
}
function time(v: unknown, what: string, nullable = false): string | null {
  if (v === null && nullable) return null;
  if (typeof v !== 'string' || !ISO.test(v) || Number.isNaN(Date.parse(v))) fail(what);
  return v;
}
function id(v: unknown, what: string, nullable = false): string | null {
  if (v === null && nullable) return null;
  if (typeof v !== 'string' || !UUID.test(v)) fail(what);
  return v.toLowerCase();
}
function version(v: unknown, what: string): number {
  if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > 999_999_999) fail(what);
  return v as number;
}
function name(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length < 1 || v.length > 120 || CONTROL.test(v)) fail(what);
  return v;
}
function text(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length < 1 || v.length > SOCIAL_MESSAGE_TEXT_MAX || v.trim() === '' || TEXT_CONTROL.test(v)) fail(what);
  return v;
}
function bool(v: unknown, what: string): boolean { if (typeof v !== 'boolean') fail(what); return v; }

export function verifySocialConversation(v: unknown): SocialConversation {
  const o = record(v, ['conversationId', 'accountId', 'platform', 'accountName', 'kind', 'participantName', 'lastInboundAt', 'lastMessageAt', 'unread',
    'assignedPrincipalId', 'linkedLeadId', 'linkedPersonId', 'commentHidden', 'inboxOn', 'replyWindowOpen', 'preview', 'version'], 'conversation');
  if (!SOCIAL_PLATFORMS.includes(o.platform as SocialPlatform) || !SOCIAL_CONVERSATION_KINDS.includes(o.kind as SocialConversationKind)
    || !Number.isSafeInteger(o.unread) || (o.unread as number) < 0 || (o.preview !== null && (typeof o.preview !== 'string' || o.preview.length > 140))) fail('conversation');
  const commentHidden = bool(o.commentHidden, 'conversation');
  if (o.kind === 'DM' && commentHidden) fail('conversation');
  return {
    conversationId: id(o.conversationId, 'conversation')!, accountId: id(o.accountId, 'conversation')!, platform: o.platform as SocialPlatform,
    accountName: name(o.accountName, 'conversation'), kind: o.kind as SocialConversationKind, participantName: name(o.participantName, 'conversation'),
    lastInboundAt: time(o.lastInboundAt, 'conversation', true), lastMessageAt: time(o.lastMessageAt, 'conversation')!, unread: o.unread as number,
    assignedPrincipalId: id(o.assignedPrincipalId, 'conversation', true), linkedLeadId: id(o.linkedLeadId, 'conversation', true),
    linkedPersonId: id(o.linkedPersonId, 'conversation', true), commentHidden, inboxOn: bool(o.inboxOn, 'conversation'),
    replyWindowOpen: bool(o.replyWindowOpen, 'conversation'), preview: o.preview as string | null, version: version(o.version, 'conversation'),
  };
}
export function verifySocialMessage(v: unknown): SocialMessage {
  const o = record(v, ['messageId', 'direction', 'text', 'status', 'sentByPerson', 'resolvedByPerson', 'occurredAt', 'version'], 'message');
  if (o.direction !== 'INBOUND' && o.direction !== 'OUTBOUND') fail('message');
  if (!SOCIAL_MESSAGE_STATUSES.includes(o.status as SocialMessageStatus) || (o.direction === 'INBOUND') !== (o.status === 'RECEIVED')) fail('message');
  const sentByPerson = bool(o.sentByPerson, 'message');
  if (sentByPerson !== (o.direction === 'OUTBOUND')) fail('message');
  return { messageId: id(o.messageId, 'message')!, direction: o.direction, text: text(o.text, 'message'), status: o.status as SocialMessageStatus,
    sentByPerson, resolvedByPerson: bool(o.resolvedByPerson, 'message'), occurredAt: time(o.occurredAt, 'message')!, version: version(o.version, 'message') };
}
export function verifySocialInboxList(v: unknown): SocialInboxList {
  const o = record(v, ['conversations', 'inboxEnabled', 'checkedAt'], 'inbox');
  if (!Array.isArray(o.conversations) || o.conversations.length > 50) fail('inbox');
  return { conversations: o.conversations.map(verifySocialConversation), inboxEnabled: bool(o.inboxEnabled, 'inbox'), checkedAt: time(o.checkedAt, 'inbox')! };
}
export function verifySocialConversationDetail(v: unknown): SocialConversationDetail {
  const o = record(v, ['conversation', 'messages', 'inboxEnabled', 'checkedAt'], 'conversation detail');
  if (!Array.isArray(o.messages) || o.messages.length > 200) fail('conversation detail');
  return { conversation: verifySocialConversation(o.conversation), messages: o.messages.map(verifySocialMessage), inboxEnabled: bool(o.inboxEnabled, 'conversation detail'),
    checkedAt: time(o.checkedAt, 'conversation detail')! };
}
export function verifySocialReplyResult(v: unknown): SocialReplyResult {
  const o = record(v, ['conversation', 'message'], 'reply');
  const message = verifySocialMessage(o.message);
  if (message.direction !== 'OUTBOUND') fail('reply');
  return { conversation: verifySocialConversation(o.conversation), message };
}
export function verifySocialCommentActionResult(v: unknown): SocialCommentActionResult {
  const o = record(v, ['conversation', 'actionId', 'action', 'status'], 'comment action');
  if (o.action !== 'HIDE' && o.action !== 'UNHIDE') fail('comment action');
  if (!['SENDING', 'DONE', 'FAILED', 'UNKNOWN'].includes(o.status as string)) fail('comment action');
  const conversation = verifySocialConversation(o.conversation);
  if (conversation.kind !== 'COMMENT') fail('comment action');
  return { conversation, actionId: id(o.actionId, 'comment action')!, action: o.action, status: o.status as SocialCommentActionResult['status'] };
}

export function validateSocialConversationChangeInput(v: unknown): SocialConversationChangeInput {
  const o = record(v, ['expectedVersion'], 'conversation change input', ['read', 'assignedPrincipalId', 'linkedLeadId', 'linkedPersonId']);
  if (Object.keys(o).length < 2 || (o.read !== undefined && o.read !== true)) fail('conversation change input');
  const out: SocialConversationChangeInput = { expectedVersion: version(o.expectedVersion, 'conversation change input') };
  if (o.read === true) out.read = true;
  for (const key of ['assignedPrincipalId', 'linkedLeadId', 'linkedPersonId'] as const) if (key in o) out[key] = id(o[key], 'conversation change input', true);
  return out;
}
export function validateSocialReplyInput(v: unknown): SocialReplyInput {
  const o = record(v, ['text'], 'reply input');
  return { text: text(o.text, 'reply input') };
}
export function validateSocialMessageResolveInput(v: unknown): SocialMessageResolveInput {
  const o = record(v, ['expectedVersion', 'outcome'], 'message resolve input');
  if (o.outcome !== 'SENT' && o.outcome !== 'NOT_SENT') fail('message resolve input');
  return { expectedVersion: version(o.expectedVersion, 'message resolve input'), outcome: o.outcome };
}
export function validateSocialCommentActionInput(v: unknown): SocialCommentActionInput {
  const o = record(v, ['action'], 'comment action input');
  if (o.action !== 'HIDE' && o.action !== 'UNHIDE') fail('comment action input');
  return { action: o.action };
}
