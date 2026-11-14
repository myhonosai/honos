import { createHmac, timingSafeEqual } from 'node:crypto';

type Env = Record<string, string | undefined>;
const ID = /^[0-9A-Za-z_-]{1,64}$/;
const EVENT_ID = /^[0-9A-Za-z_:.-]{1,128}$/;
const KEY = /^[0-9A-Za-z_.-]{1,64}$/;
export const ZERNIO_LEAD_PATH = '/v1/communications/webhooks/zernio';

export class ZernioWebhookError extends Error {
  constructor(readonly reason: 'NOT_CONFIGURED' | 'SIGNATURE_INVALID' | 'MALFORMED') { super(reason); }
}

export interface ZernioLeadEvent {
  eventId: string;
  leadgenId: string;
  accountId: string;
  formId: string;
  /** Answer key -> answer text. Only string answers (multiple choice joined), bounded; nothing else from the payload. */
  fields: Record<string, string>;
  ad: { adId?: string; adsetId?: string; campaignId?: string; isOrganic?: boolean };
}

/** INACTIVE unless ZERNIO_WEBHOOK_SECRET (at least 32 characters) is set AND HON_ZERNIO_LEAD_INTAKE_APPROVED is exactly 'true'. */
export function zernioLeadIntakeReady(env: Env): boolean {
  return (env.ZERNIO_WEBHOOK_SECRET?.trim().length ?? 0) >= 32 && env.HON_ZERNIO_LEAD_INTAKE_APPROVED === 'true';
}

const POST_ID = /^[0-9A-Za-z_:.-]{1,128}$/;
const API_KEY = /^(?:sk_|zrk_)[a-fA-F0-9]{64}$/;

/** 0348 post and account receipts. */
export interface ZernioSocialEvent {
  eventId: string;
  eventType: 'post.published' | 'post.failed' | 'account.disconnected';
  platform: 'FACEBOOK' | 'INSTAGRAM';
  providerAccountId: string;
  /** The Zernio post id HON recorded when it published; null for account.disconnected. */
  providerPostId: string | null;
}
/** 0349 inbound messages and comments. Text only; attachments, Meta user ids and other payload fields are dropped. */
export interface ZernioInboxEvent {
  eventId: string;
  eventType: 'message.received' | 'comment.received';
  platform: 'FACEBOOK' | 'INSTAGRAM';
  providerAccountId: string;
  /** The DM conversation id, or the top-level comment id for a comment. */
  providerConversationId: string;
  providerMessageId: string;
  /** The post commented on; null for a DM. */
  providerPostId: string | null;
  participantName: string;
  text: string;
  occurredAt: string;
}
export type ZernioWebhookDelivery = { kind: 'LEAD'; lead: ZernioLeadEvent } | { kind: 'SOCIAL'; event: ZernioSocialEvent } | { kind: 'INBOX'; event: ZernioInboxEvent } | null;

/**
 * 0348: post and account receipts are taken only when ZERNIO_WEBHOOK_SECRET (at least 32 characters) is set AND
 * publishing is approved (HON_ZERNIO_PUBLISH_APPROVED=true with a Zernio key), or the fake provider runs outside
 * production and staging.
 */
export function zernioSocialEventsReady(env: Env): boolean {
  if ((env.ZERNIO_WEBHOOK_SECRET?.trim().length ?? 0) < 32) return false;
  if (API_KEY.test(env.ZERNIO_API_KEY ?? '') && env.HON_ZERNIO_PUBLISH_APPROVED === 'true') return true;
  const deployment = env.HON_DEPLOYMENT_ENVIRONMENT;
  return env.HON_ZERNIO_FAKE_PROVIDER === '1' && deployment !== 'production' && deployment !== 'staging'
    && !(deployment === undefined && env.NODE_ENV === 'production');
}

/**
 * 0349: inbound messages and comments are taken only when ZERNIO_WEBHOOK_SECRET (at least 32 characters) is set AND the
 * inbox is approved (HON_ZERNIO_INBOX_APPROVED=true with a Zernio key), or the fake provider runs outside production.
 */
export function zernioInboxEventsReady(env: Env): boolean {
  if ((env.ZERNIO_WEBHOOK_SECRET?.trim().length ?? 0) < 32) return false;
  if (API_KEY.test(env.ZERNIO_API_KEY ?? '') && env.HON_ZERNIO_INBOX_APPROVED === 'true') return true;
  const deployment = env.HON_DEPLOYMENT_ENVIRONMENT;
  return env.HON_ZERNIO_FAKE_PROVIDER === '1' && deployment !== 'production' && deployment !== 'staging'
    && !(deployment === undefined && env.NODE_ENV === 'production');
}

/**
 * Zernio webhook signature: X-Zernio-Signature is the lowercase hex HMAC-SHA256 of the raw body with the secret HON
 * set on the webhook endpoint. Only `lead.received` for a Facebook account is a lead; every other event, and Zernio's
 * own test deliveries, are acknowledged and ignored. Redeliveries carry the same event id and are deduplicated in the
 * database by event id and Meta lead id.
 */
export class ZernioLeadWebhookVerifier {
  constructor(private readonly environment: () => Env = () => process.env) {}

  verify(rawBody: Buffer, signature: string | undefined): ZernioLeadEvent | null {
    const env = this.environment();
    if (!zernioLeadIntakeReady(env)) throw new ZernioWebhookError('NOT_CONFIGURED');
    return this.lead(this.envelope(env, rawBody, signature));
  }

  /**
   * One signed delivery to the shared endpoint. Refused as NOT_CONFIGURED when neither lead intake nor post receipts
   * are turned on, and a lead while lead intake is off (as before 0348). A post or account event while post receipts
   * are off, and every other event or test delivery, is acknowledged and ignored.
   */
  receive(rawBody: Buffer, signature: string | undefined): ZernioWebhookDelivery {
    const env = this.environment();
    const leads = zernioLeadIntakeReady(env), social = zernioSocialEventsReady(env), inbox = zernioInboxEventsReady(env);
    if (!leads && !social && !inbox) throw new ZernioWebhookError('NOT_CONFIGURED');
    const body = this.envelope(env, rawBody, signature);
    if (body.event === 'lead.received') {
      if (!leads) throw new ZernioWebhookError('NOT_CONFIGURED');
      const lead = this.lead(body);
      return lead ? { kind: 'LEAD', lead } : null;
    }
    if (body.test === true) return null;
    if (body.event === 'message.received' || body.event === 'comment.received') {
      if (!inbox) return null;
      const event = inboxEvent(body);
      return event ? { kind: 'INBOX', event } : null;
    }
    if (!social || !['post.published', 'post.failed', 'account.disconnected'].includes(body.event as string)) return null;
    return { kind: 'SOCIAL', event: socialEvent(body) };
  }

  private envelope(env: Env, rawBody: Buffer, signature: string | undefined): Record<string, unknown> {
    const secret = env.ZERNIO_WEBHOOK_SECRET!.trim();
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    const given = /^[0-9a-f]{64}$/.test(signature ?? '') ? Buffer.from(signature!, 'hex') : Buffer.alloc(0);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new ZernioWebhookError('SIGNATURE_INVALID');
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
      body = parsed as Record<string, unknown>;
    } catch { throw new ZernioWebhookError('MALFORMED'); }
    return body;
  }

  private lead(body: Record<string, unknown>): ZernioLeadEvent | null {
    if (body.event !== 'lead.received' || body.test === true) return null;
    const lead = body.lead as Record<string, unknown> | undefined;
    const account = body.account as Record<string, unknown> | undefined;
    if (typeof body.id !== 'string' || !EVENT_ID.test(body.id) || !lead || typeof lead !== 'object' || !account || typeof account !== 'object'
      || account.platform !== 'facebook' || typeof account.id !== 'string' || !ID.test(account.id)
      || typeof lead.leadgenId !== 'string' || !ID.test(lead.leadgenId) || typeof lead.formId !== 'string' || !ID.test(lead.formId)
      || !lead.fields || typeof lead.fields !== 'object' || Array.isArray(lead.fields)) {
      throw new ZernioWebhookError('MALFORMED');
    }
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(lead.fields as Record<string, unknown>).slice(0, 60)) {
      if (!KEY.test(key)) continue;
      const text = typeof value === 'string' ? value : Array.isArray(value) && value.every((v) => typeof v === 'string') ? value.join(', ') : undefined;
      if (text !== undefined) fields[key] = text.slice(0, 320);
    }
    const id = (value: unknown) => (typeof value === 'string' && ID.test(value) ? value : undefined);
    const ad: ZernioLeadEvent['ad'] = {};
    const adId = id(lead.adId); const adsetId = id(lead.adsetId); const campaignId = id(lead.campaignId);
    if (adId) ad.adId = adId;
    if (adsetId) ad.adsetId = adsetId;
    if (campaignId) ad.campaignId = campaignId;
    if (typeof lead.isOrganic === 'boolean') ad.isOrganic = lead.isOrganic;
    return { eventId: body.id, leadgenId: lead.leadgenId, accountId: account.id, formId: lead.formId, fields, ad };
  }
}

/**
 * Assumed Zernio shapes (SOCIAL_POSTING_INBOX_ADS.md §5, to confirm before activation): `{ id, event, account: { id|_id,
 * platform }, post: { id|_id } }`. Only these identifiers are read; text, errors and URLs in the payload are ignored.
 */
function socialEvent(body: Record<string, unknown>): ZernioSocialEvent {
  const account = body.account as Record<string, unknown> | undefined;
  const post = body.post as Record<string, unknown> | undefined;
  const accountId = account && typeof account === 'object' ? (account.id ?? account._id) : undefined;
  const platform = account?.platform === 'facebook' ? 'FACEBOOK' : account?.platform === 'instagram' ? 'INSTAGRAM' : null;
  const eventType = body.event as ZernioSocialEvent['eventType'];
  const postId = post && typeof post === 'object' ? (post.id ?? post._id) : undefined;
  if (typeof body.id !== 'string' || !EVENT_ID.test(body.id) || typeof accountId !== 'string' || !ID.test(accountId) || !platform
    || (eventType !== 'account.disconnected' && (typeof postId !== 'string' || !POST_ID.test(postId)))) throw new ZernioWebhookError('MALFORMED');
  return { eventId: body.id, eventType, platform, providerAccountId: accountId, providerPostId: eventType === 'account.disconnected' ? null : postId as string };
}

// eslint-disable-next-line no-control-regex
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
// eslint-disable-next-line no-control-regex
const NAME_CONTROL = /[\u0000-\u001f\u007f]/g;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Assumed Zernio shapes (SOCIAL_POSTING_INBOX_ADS.md §5, to confirm before activation):
 * message.received `{ id, event, account: { id|_id, platform }, conversation: { id|_id }, message: { id|_id, text, createdAt,
 * isEcho?, from: { name } } }`; comment.received `{ id, event, account, comment: { id|_id, text, createdAt, parentId?,
 * postId, from: { id?, name } } }`. Echoes of the school's own messages, and messages with no text (stickers, photos),
 * are acknowledged and not stored. Only these fields are read.
 */
function inboxEvent(body: Record<string, unknown>): ZernioInboxEvent | null {
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
  const idOf = (v: Record<string, unknown> | undefined) => (v ? (v.id ?? v._id) : undefined);
  const account = obj(body.account), comment = body.event === 'comment.received';
  const item = obj(comment ? body.comment : body.message), from = obj(item?.from);
  const accountId = idOf(account), platform = account?.platform === 'facebook' ? 'FACEBOOK' : account?.platform === 'instagram' ? 'INSTAGRAM' : null;
  const messageId = idOf(item);
  const conversationId = comment ? (typeof item?.parentId === 'string' ? item.parentId : messageId) : idOf(obj(body.conversation));
  const postId = comment ? item?.postId : null;
  if (typeof body.id !== 'string' || !EVENT_ID.test(body.id) || typeof accountId !== 'string' || !ID.test(accountId) || !platform || !item
    || typeof messageId !== 'string' || !POST_ID.test(messageId) || typeof conversationId !== 'string' || !POST_ID.test(conversationId)
    || (comment && (typeof postId !== 'string' || !POST_ID.test(postId)))) throw new ZernioWebhookError('MALFORMED');
  // The school's own messages and comments come back as echoes; they are already in HON (or were sent elsewhere).
  if (item.isEcho === true || item.direction === 'outgoing' || (comment && from && (from.id === accountId))) return null;
  const text = typeof item.text === 'string' ? item.text.replace(TEXT_CONTROL, '').trim().slice(0, 2000) : '';
  if (!text) return null;
  const rawName = typeof from?.name === 'string' ? from.name.replace(NAME_CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  const createdAt = typeof item.createdAt === 'string' && ISO_TIME.test(item.createdAt) && !Number.isNaN(Date.parse(item.createdAt))
    ? new Date(item.createdAt).toISOString() : new Date().toISOString();
  return { eventId: body.id, eventType: comment ? 'comment.received' : 'message.received', platform, providerAccountId: accountId,
    providerConversationId: conversationId, providerMessageId: messageId, providerPostId: comment ? postId as string : null,
    participantName: rawName || (platform === 'FACEBOOK' ? 'Facebook user' : 'Instagram user'), text, occurredAt: createdAt };
}

export interface ZernioLeadFormInput {
  accountId: string; formId: string; pipelineId: string; pipelineStageId: string; status: 'ACTIVE' | 'DISABLED';
  fieldMap?: Partial<Record<'fullName' | 'givenName' | 'familyName' | 'email' | 'phone', string>>; expectedVersion?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAP_KEYS = ['fullName', 'givenName', 'familyName', 'email', 'phone'];

/** Strict HQ input; returns null for an invalid body. */
export function parseZernioLeadFormInput(body: unknown): ZernioLeadFormInput | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['accountId', 'formId', 'pipelineId', 'pipelineStageId', 'status', 'fieldMap', 'expectedVersion'].includes(key))) return null;
  if (typeof input.accountId !== 'string' || !ID.test(input.accountId) || typeof input.formId !== 'string' || !ID.test(input.formId)
    || typeof input.pipelineId !== 'string' || !UUID.test(input.pipelineId) || typeof input.pipelineStageId !== 'string' || !UUID.test(input.pipelineStageId)
    || (input.status !== 'ACTIVE' && input.status !== 'DISABLED')
    || (input.expectedVersion !== undefined && (!Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 1))) return null;
  let fieldMap: ZernioLeadFormInput['fieldMap'];
  if (input.fieldMap !== undefined) {
    const map = input.fieldMap as Record<string, unknown>;
    if (!map || typeof map !== 'object' || Array.isArray(map) || Object.entries(map).some(([k, v]) => !MAP_KEYS.includes(k) || typeof v !== 'string' || !KEY.test(v))
      || (!('fullName' in map) && !('givenName' in map)) || (!('email' in map) && !('phone' in map))) return null;
    fieldMap = map as ZernioLeadFormInput['fieldMap'];
  }
  return { accountId: input.accountId, formId: input.formId, pipelineId: input.pipelineId, pipelineStageId: input.pipelineStageId, status: input.status,
    ...(fieldMap ? { fieldMap } : {}), ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion as number }) };
}
