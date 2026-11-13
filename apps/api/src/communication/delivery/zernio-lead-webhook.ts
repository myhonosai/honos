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
