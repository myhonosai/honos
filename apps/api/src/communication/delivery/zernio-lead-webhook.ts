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
export type ZernioWebhookDelivery = { kind: 'LEAD'; lead: ZernioLeadEvent } | { kind: 'SOCIAL'; event: ZernioSocialEvent } | null;

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
    const leads = zernioLeadIntakeReady(env), social = zernioSocialEventsReady(env);
    if (!leads && !social) throw new ZernioWebhookError('NOT_CONFIGURED');
    const body = this.envelope(env, rawBody, signature);
    if (body.event === 'lead.received') {
      if (!leads) throw new ZernioWebhookError('NOT_CONFIGURED');
      const lead = this.lead(body);
      return lead ? { kind: 'LEAD', lead } : null;
    }
    if (!social || body.test === true || !['post.published', 'post.failed', 'account.disconnected'].includes(body.event as string)) return null;
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
