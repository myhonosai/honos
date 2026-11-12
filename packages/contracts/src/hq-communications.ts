// HQ-COMM PR A (migration 0281): HQ texting and email to the current owners of one school. A human HQ person drafts,
// queues or cancels a message with the HQ permission of its purpose; only the HQ owner sets or retires the HQ sender.
// HQ reads never carry a recipient address, provider message id or cost. Nothing here sends a message by itself.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsInt as isInt,
  championsIsTimestamp as isTimestamp, championsIsUuid as isUuid, championsNullable as nullable, championsRecord as record } from './champions-club.js';

export const HQ_MESSAGE_PURPOSES = ['SUPPORT', 'BILLING', 'ONBOARDING', 'ACCOUNT'] as const;
export const HQ_MESSAGE_CHANNELS = ['EMAIL', 'SMS'] as const;
export const HQ_MESSAGE_STATUSES = ['DRAFT', 'QUEUED', 'CANCELLED'] as const;
export const HQ_SENDER_A2P_STATES = ['NOT_REGISTERED', 'PENDING', 'REGISTERED_SERVICE', 'REGISTERED_MARKETING'] as const;
export const HQ_MESSAGE_DELIVERY_STATUSES = ['PENDING', 'SENDING', 'ACCEPTED', 'DELIVERED', 'BOUNCED', 'FAILED', 'SUPPRESSED', 'UNKNOWN'] as const;
export const HQ_MESSAGE_HOLD_REASONS = ['QUIET_HOURS', 'NO_SENDER', 'RETRY_WAIT'] as const;
export const HQ_MESSAGE_FAILURE_CODES = ['CONSENT_MISSING', 'ADDRESS_MISSING', 'RECIPIENT_REMOVED', 'CANCELLED', 'LEASE_EXPIRED', 'PROVIDER_UNKNOWN',
  'PROVIDER_REJECTED', 'INVALID_ADDRESS', 'RETRIES_EXHAUSTED', 'BOUNCED', 'DROPPED', 'UNDELIVERED', 'PROVIDER_FAILED'] as const;
/** Twilio sends a long text whole, as one MMS, when the Messaging Service has MMS Converter on; it allows up to 1,600. */
export const HQ_MESSAGE_SMS_MAX = 1600;
export const HQ_MESSAGE_EMAIL_MAX = 4000;
/** Human-command header values, one per HQ communication command route. */
export const HQ_COMMUNICATION_COMMANDS = {
  setSender: 'hq-communication-sender-set', retireSender: 'hq-communication-sender-retire', createMessage: 'hq-message-create',
  queueMessage: 'hq-message-queue', cancelMessage: 'hq-message-cancel',
} as const;
export type HqMessagePurpose = typeof HQ_MESSAGE_PURPOSES[number];
export type HqMessageChannel = typeof HQ_MESSAGE_CHANNELS[number];
export type HqMessageStatus = typeof HQ_MESSAGE_STATUSES[number];
export type HqSenderA2pState = typeof HQ_SENDER_A2P_STATES[number];

const has = (list: readonly unknown[], value: unknown) => list.includes(value);
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const text = (v: unknown, min: number, max: number): v is string =>
  typeof v === 'string' && v === v.trim() && v.length >= min && v.length <= max && !CONTROL.test(v);
const label = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max;
const uuid = (v: unknown): string => (isUuid(v) ? (v as string).toLowerCase() : invalid());
const version = (v: unknown): number => (isInt(v, 1, 999_999_999) ? v as number : invalid());
const EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,180}\.[a-z]{2,24}$/;
const SERVICE_SID = /^MG[0-9a-f]{32}$/;

/** The longest content allowed for a channel. */
export function hqMessageMaxLength(channel: HqMessageChannel): number { return channel === 'SMS' ? HQ_MESSAGE_SMS_MAX : HQ_MESSAGE_EMAIL_MAX; }

// ---------- inputs ----------
export interface HqSenderSetInput {
  channel: HqMessageChannel; emailFrom: string | null; emailDisplayName: string | null; smsServiceSid: string | null;
  a2pState: HqSenderA2pState | null; mmsConverterConfirmed: true | null;
}
export interface HqMessageCreateInput {
  organizationId: string; schoolId: string; purpose: HqMessagePurpose; channel: HqMessageChannel; content: string; supportCaseId: string | null;
}
export interface HqMessageVersionInput { expectedVersion: number }

export function validateHqSenderSetInput(value: unknown): HqSenderSetInput {
  const r = record(value, invalid); exactKeys(r, ['channel', 'emailFrom', 'emailDisplayName', 'smsServiceSid', 'a2pState', 'mmsConverterConfirmed'], invalid);
  if (r.channel === 'EMAIL') {
    if (typeof r.emailFrom !== 'string' || !EMAIL.test(r.emailFrom) || !text(r.emailDisplayName, 1, 80) || /[<>]/.test(r.emailDisplayName)
      || r.smsServiceSid !== null || r.a2pState !== null || r.mmsConverterConfirmed !== null) invalid();
  } else if (r.channel === 'SMS') {
    // A bare phone number is never a sender: texts go through a Messaging Service with MMS Converter on.
    if (typeof r.smsServiceSid !== 'string' || !SERVICE_SID.test(r.smsServiceSid) || !has(HQ_SENDER_A2P_STATES, r.a2pState)
      || r.mmsConverterConfirmed !== true || r.emailFrom !== null || r.emailDisplayName !== null) invalid();
  } else invalid();
  return r as unknown as HqSenderSetInput;
}
export function validateHqMessageCreateInput(value: unknown): HqMessageCreateInput {
  const r = record(value, invalid); exactKeys(r, ['organizationId', 'schoolId', 'purpose', 'channel', 'content', 'supportCaseId'], invalid);
  if (!has(HQ_MESSAGE_PURPOSES, r.purpose) || !has(HQ_MESSAGE_CHANNELS, r.channel)
    || !text(r.content, 1, hqMessageMaxLength(r.channel as HqMessageChannel))) invalid();
  return { organizationId: uuid(r.organizationId), schoolId: uuid(r.schoolId), purpose: r.purpose as HqMessagePurpose,
    channel: r.channel as HqMessageChannel, content: r.content as string, supportCaseId: r.supportCaseId === null ? null : uuid(r.supportCaseId) };
}
export function validateHqMessageVersionInput(value: unknown): HqMessageVersionInput {
  const r = record(value, invalid); exactKeys(r, ['expectedVersion'], invalid);
  return { expectedVersion: version(r.expectedVersion) };
}

// ---------- list query ----------
export interface HqMessageCursor { createdAt: string; messageId: string }
export interface HqCommunicationsQuery { schoolId: string | null; cursor: HqMessageCursor | null; limit: number }
export function encodeHqMessageCursor(c: HqMessageCursor): string { return `${c.createdAt}~${c.messageId}`; }
export function validateHqCommunicationsQuery(value: unknown): HqCommunicationsQuery {
  const q = record(value ?? {}, invalid);
  if (Object.keys(q).some((k) => !['schoolId', 'cursor', 'limit'].includes(k))) invalid();
  const one = (v: unknown): string | null => (v === undefined ? null : typeof v === 'string' ? v : invalid());
  const school = one(q.schoolId), cursor = one(q.cursor), limit = one(q.limit);
  if (limit !== null && !/^(?:[1-9]\d?|100)$/.test(limit)) invalid();
  let decoded: HqMessageCursor | null = null;
  if (cursor !== null) {
    if (cursor.length > 80) invalid();
    const [createdAt, messageId, ...rest] = cursor.split('~');
    if (rest.length || !isTimestamp(createdAt) || !isUuid(messageId)) invalid();
    decoded = { createdAt: createdAt as string, messageId: (messageId as string).toLowerCase() };
  }
  return { schoolId: school === null ? null : uuid(school), cursor: decoded, limit: limit === null ? 50 : Number(limit) };
}

// ---------- responses ----------
export interface HqCommunicationPerson { principalId: string; displayName: string }
export interface HqCommunicationSender {
  senderId: string; channel: HqMessageChannel; status: 'ACTIVE' | 'RETIRED'; emailFrom: string | null; emailDisplayName: string | null;
  smsServiceSid: string | null; a2pState: HqSenderA2pState | null; mmsConverterConfirmed: boolean | null; createdBy: HqCommunicationPerson;
  createdAt: string; version: number;
}
export interface HqMessageDeliverySummary { pending: number; accepted: number; delivered: number; suppressed: number; failed: number; unknown: number }
export interface HqMessage {
  messageId: string; organizationId: string; organizationDisplayName: string; schoolId: string; schoolDisplayName: string;
  purpose: HqMessagePurpose; channel: HqMessageChannel; content: string; supportCaseId: string | null; status: HqMessageStatus;
  recipientCount: number; createdBy: HqCommunicationPerson; createdAt: string; queuedAt: string | null; cancelledAt: string | null;
  updatedAt: string; version: number; deliverySummary: HqMessageDeliverySummary;
}
export interface HqMessageDelivery {
  deliveryId: string; recipient: HqCommunicationPerson; status: typeof HQ_MESSAGE_DELIVERY_STATUSES[number];
  holdReason: typeof HQ_MESSAGE_HOLD_REASONS[number] | null; attempt: number; provider: 'FAKE' | 'SENDGRID' | 'TWILIO' | null;
  sentAs: 'EMAIL' | 'SMS' | 'MMS' | null; segments: number | null; failureCode: typeof HQ_MESSAGE_FAILURE_CODES[number] | null;
  acceptedAt: string | null; finalAt: string | null; updatedAt: string;
}
export interface HqCommunicationsViewer extends HqCommunicationPerson { purposes: HqMessagePurpose[]; canManageSenders: boolean }
export interface HqCommunicationsView {
  senders: { EMAIL: HqCommunicationSender | null; SMS: HqCommunicationSender | null }; messages: HqMessage[]; limit: number;
  nextCursor: HqMessageCursor | null; viewer: HqCommunicationsViewer; asOf: string;
}
export interface HqMessageDetail { message: HqMessage; deliveries: HqMessageDelivery[]; viewer: HqCommunicationPerson; asOf: string }
export interface HqSenderReceipt { operation: 'SENDER_SET' | 'SENDER_RETIRE'; sender: HqCommunicationSender; replayed: boolean }
export interface HqMessageReceipt { operation: 'CREATE' | 'QUEUE' | 'CANCEL'; message: HqMessage; replayed: boolean }

const COUNT_MAX = 100;
function person(value: unknown): HqCommunicationPerson {
  const p = record(value, drift); exactKeys(p, ['principalId', 'displayName'], drift);
  if (!isUuid(p.principalId) || !label(p.displayName, 120)) drift();
  return p as unknown as HqCommunicationPerson;
}
function sender(value: unknown): HqCommunicationSender {
  const s = record(value, drift);
  exactKeys(s, ['senderId', 'channel', 'status', 'emailFrom', 'emailDisplayName', 'smsServiceSid', 'a2pState', 'mmsConverterConfirmed', 'createdBy', 'createdAt', 'version'], drift);
  if (!isUuid(s.senderId) || !has(['ACTIVE', 'RETIRED'], s.status) || !isTimestamp(s.createdAt) || !isInt(s.version, 1, 999_999_999)) drift();
  if (s.channel === 'EMAIL') {
    if (typeof s.emailFrom !== 'string' || !EMAIL.test(s.emailFrom) || !label(s.emailDisplayName, 80) || s.smsServiceSid !== null
      || s.a2pState !== null || s.mmsConverterConfirmed !== null) drift();
  } else if (s.channel === 'SMS') {
    if (typeof s.smsServiceSid !== 'string' || !SERVICE_SID.test(s.smsServiceSid) || !has(HQ_SENDER_A2P_STATES, s.a2pState)
      || s.mmsConverterConfirmed !== true || s.emailFrom !== null || s.emailDisplayName !== null) drift();
  } else drift();
  person(s.createdBy);
  return s as unknown as HqCommunicationSender;
}
function message(value: unknown): HqMessage {
  const m = record(value, drift);
  exactKeys(m, ['messageId', 'organizationId', 'organizationDisplayName', 'schoolId', 'schoolDisplayName', 'purpose', 'channel', 'content',
    'supportCaseId', 'status', 'recipientCount', 'createdBy', 'createdAt', 'queuedAt', 'cancelledAt', 'updatedAt', 'version', 'deliverySummary'], drift);
  if (!isUuid(m.messageId) || !isUuid(m.organizationId) || !label(m.organizationDisplayName, 300) || !isUuid(m.schoolId) || !label(m.schoolDisplayName, 300)
    || !has(HQ_MESSAGE_PURPOSES, m.purpose) || !has(HQ_MESSAGE_CHANNELS, m.channel)
    || !text(m.content, 1, hqMessageMaxLength(m.channel as HqMessageChannel)) || !nullable(m.supportCaseId, isUuid)
    || !has(HQ_MESSAGE_STATUSES, m.status) || !isInt(m.recipientCount, 0, COUNT_MAX) || !isTimestamp(m.createdAt)
    || !nullable(m.queuedAt, isTimestamp) || !nullable(m.cancelledAt, isTimestamp) || !isTimestamp(m.updatedAt)
    || (m.status === 'CANCELLED') !== (m.cancelledAt !== null) || (m.status === 'QUEUED' && (m.queuedAt === null || (m.recipientCount as number) < 1))
    || (m.status === 'DRAFT' && (m.queuedAt !== null || m.recipientCount !== 0)) || !isInt(m.version, 1, 999_999_999)) drift();
  person(m.createdBy);
  const s = record(m.deliverySummary, drift); exactKeys(s, ['pending', 'accepted', 'delivered', 'suppressed', 'failed', 'unknown'], drift);
  if (Object.values(s).some((n) => !isInt(n, 0, COUNT_MAX))) drift();
  return m as unknown as HqMessage;
}
function delivery(value: unknown): HqMessageDelivery {
  const d = record(value, drift);
  exactKeys(d, ['deliveryId', 'recipient', 'status', 'holdReason', 'attempt', 'provider', 'sentAs', 'segments', 'failureCode', 'acceptedAt', 'finalAt', 'updatedAt'], drift);
  if (!isUuid(d.deliveryId) || !has(HQ_MESSAGE_DELIVERY_STATUSES, d.status) || (d.holdReason !== null && !has(HQ_MESSAGE_HOLD_REASONS, d.holdReason))
    || (d.holdReason !== null && d.status !== 'PENDING') || !isInt(d.attempt, 0, 5) || (d.provider !== null && !has(['FAKE', 'SENDGRID', 'TWILIO'], d.provider))
    || (d.sentAs !== null && !has(['EMAIL', 'SMS', 'MMS'], d.sentAs)) || !nullable(d.segments, (n: unknown) => isInt(n, 1, 100))
    || (d.failureCode !== null && !has(HQ_MESSAGE_FAILURE_CODES, d.failureCode)) || !nullable(d.acceptedAt, isTimestamp)
    || !nullable(d.finalAt, isTimestamp) || !isTimestamp(d.updatedAt)) drift();
  person(d.recipient);
  return d as unknown as HqMessageDelivery;
}
export function validateHqCommunicationsView(value: unknown): HqCommunicationsView {
  const r = record(value, drift); exactKeys(r, ['senders', 'messages', 'limit', 'nextCursor', 'viewer', 'asOf'], drift);
  const s = record(r.senders, drift); exactKeys(s, ['EMAIL', 'SMS'], drift);
  if (s.EMAIL !== null && sender(s.EMAIL).channel !== 'EMAIL') drift();
  if (s.SMS !== null && sender(s.SMS).channel !== 'SMS') drift();
  if (!Array.isArray(r.messages) || !isInt(r.limit, 1, 100) || r.messages.length > (r.limit as number) || !isTimestamp(r.asOf)) drift();
  const messages = (r.messages as unknown[]).map(message);
  for (let i = 1; i < messages.length; i++) {
    const a = messages[i - 1]!, b = messages[i]!;
    if (a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.messageId <= b.messageId)) drift();
  }
  const v = record(r.viewer, drift); exactKeys(v, ['principalId', 'displayName', 'purposes', 'canManageSenders'], drift);
  person({ principalId: v.principalId, displayName: v.displayName });
  if (!Array.isArray(v.purposes) || v.purposes.length < 1 || v.purposes.some((p) => !has(HQ_MESSAGE_PURPOSES, p)) || typeof v.canManageSenders !== 'boolean') drift();
  if (messages.some((m) => !(v.purposes as unknown[]).includes(m.purpose))) drift();
  if (r.nextCursor !== null) {
    const c = record(r.nextCursor, drift); exactKeys(c, ['createdAt', 'messageId'], drift);
    const last = messages.at(-1);
    if (!last || messages.length !== r.limit || c.createdAt !== last.createdAt || c.messageId !== last.messageId) drift();
  }
  return r as unknown as HqCommunicationsView;
}
export function validateHqMessageDetail(value: unknown): HqMessageDetail {
  const r = record(value, drift); exactKeys(r, ['message', 'deliveries', 'viewer', 'asOf'], drift);
  const m = message(r.message);
  if (!Array.isArray(r.deliveries) || r.deliveries.length > COUNT_MAX || !isTimestamp(r.asOf)) drift();
  (r.deliveries as unknown[]).forEach(delivery);
  if (m.status !== 'DRAFT' && m.status !== 'CANCELLED' && r.deliveries.length !== m.recipientCount) drift();
  person(r.viewer);
  return r as unknown as HqMessageDetail;
}
export function validateHqSenderReceipt(value: unknown): HqSenderReceipt {
  const r = record(value, drift); exactKeys(r, ['operation', 'sender', 'replayed'], drift);
  if (!has(['SENDER_SET', 'SENDER_RETIRE'], r.operation) || typeof r.replayed !== 'boolean') drift();
  const s = sender(r.sender);
  if ((r.operation === 'SENDER_SET') !== (s.status === 'ACTIVE')) drift();
  return r as unknown as HqSenderReceipt;
}
export function validateHqMessageReceipt(value: unknown): HqMessageReceipt {
  const r = record(value, drift); exactKeys(r, ['operation', 'message', 'replayed'], drift);
  if (!has(['CREATE', 'QUEUE', 'CANCEL'], r.operation) || typeof r.replayed !== 'boolean') drift();
  const m = message(r.message);
  const expected = { CREATE: 'DRAFT', QUEUE: 'QUEUED', CANCEL: 'CANCELLED' }[r.operation as 'CREATE' | 'QUEUE' | 'CANCEL'];
  if (m.status !== expected) drift();
  return r as unknown as HqMessageReceipt;
}
