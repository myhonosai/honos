import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import {
  CommunicationProviderError,
  type CommunicationProviderAdapter,
  type CommunicationSendAccepted,
  type CommunicationSendRequest,
} from './communication-provider.js';
import type { VerifiedProviderReceipt } from './communication-worker-database.js';

export const SENDGRID_MAIL_SEND_URL = 'https://api.sendgrid.com/v3/mail/send';
const ADDRESS = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;
const PROVIDER_ID = /^[A-Za-z0-9._:@<>+=-]{1,200}$/;

type Env = Record<string, string | undefined>;

/**
 * Twilio SendGrid email adapter (v3 Mail Send). INACTIVE unless SENDGRID_API_KEY and HON_EMAIL_FROM are set
 * AND HON_EMAIL_SEND_APPROVED is exactly 'true'. Sandbox mode (SendGrid validates the request and sends
 * nothing) stays on unless HON_EMAIL_SANDBOX_MODE is exactly 'false'. The HON delivery id travels as a
 * custom argument so receipts can be matched even when the send response was lost.
 */
export class SendGridEmailProvider implements CommunicationProviderAdapter {
  readonly provider = 'SENDGRID' as const;
  readonly channel = 'EMAIL' as const;
  /** 0281: HQ sends go from the HQ sender address and name, tagged hon_purpose HQ so receipts reach HQ deliveries. */
  readonly hqSender = true;
  constructor(private readonly environment: () => Env = () => process.env, private readonly transport: typeof fetch = fetch) {}

  readiness() {
    const env = this.environment();
    return env.SENDGRID_API_KEY?.trim() && ADDRESS.test(env.HON_EMAIL_FROM ?? '') && env.HON_EMAIL_SEND_APPROVED === 'true'
      ? 'READY' as const : 'CONFIGURATION_REQUIRED' as const;
  }

  sandbox(): boolean {
    return this.environment().HON_EMAIL_SANDBOX_MODE !== 'false';
  }

  /** The exact request body; exported for tests. The school name is the sender display name. */
  requestBody(request: CommunicationSendRequest): Record<string, unknown> {
    const hq = request.origin === 'HQ';
    const from = hq ? request.senderEmail ?? '' : this.environment().HON_EMAIL_FROM ?? '';
    const name = (hq ? request.senderName ?? '' : request.schoolName).replace(/[\r\n"<>]/g, ' ').trim().slice(0, 80) || (hq ? 'HON OS' : 'Your school');
    const purpose = hq ? 'HQ' : request.purpose && request.purpose !== 'SCHOOL' ? request.purpose : undefined;
    // HQ BILLING and ACCOUNT mail are required notices: HON already let them through an HQ email opt-out (0281), so
    // SendGrid must not drop them for an earlier unsubscribe. Spam reports and bounces still suppress.
    // NOT YET ACTIVE: the 0281 claim does not return the message purpose, so HqMessageDispatcher never sets hqPurpose
    // and every HQ email gets normal unsubscribe handling until 0282 (HQ-COMM PR C) passes it.
    const requiredNotice = hq && (request.hqPurpose === 'BILLING' || request.hqPurpose === 'ACCOUNT');
    return {
      personalizations: [{ to: [{ email: request.recipientAddress }], custom_args: {
        hon_delivery_id: request.deliveryId, ...(purpose ? { hon_purpose: purpose } : {}),
      } }],
      from: { email: from, name: hq ? name : `${name} via HON` },
      subject: `A message from ${name}`,
      content: [{ type: 'text/plain', value: request.content }],
      mail_settings: { sandbox_mode: { enable: this.sandbox() }, ...(requiredNotice ? { bypass_unsubscribe_management: { enable: true } } : {}) },
      tracking_settings: { subscription_tracking: { enable: true }, open_tracking: { enable: false }, click_tracking: { enable: false } },
    };
  }

  async send(request: CommunicationSendRequest): Promise<CommunicationSendAccepted> {
    const key = this.environment().SENDGRID_API_KEY?.trim();
    if (this.readiness() !== 'READY' || !key) throw new CommunicationProviderError('RETRYABLE', 'PROVIDER_FAILED', 300);
    // An HQ send never falls back to the school from-address: without a valid HQ sender nothing is sent.
    if (request.origin === 'HQ' && !ADDRESS.test(request.senderEmail ?? '')) throw new CommunicationProviderError('RETRYABLE', 'PROVIDER_FAILED', 900);
    if (!ADDRESS.test(request.recipientAddress)) throw new CommunicationProviderError('FAILED', 'INVALID_ADDRESS');
    let response: Response;
    try {
      response = await this.transport(SENDGRID_MAIL_SEND_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(this.requestBody(request)),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      // Refused before any byte reached SendGrid: safe to retry. Anything else (timeout, reset) may have been accepted.
      const code = (error as { cause?: { code?: string } })?.cause?.code;
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') throw new CommunicationProviderError('RETRYABLE', 'PROVIDER_FAILED');
      throw new CommunicationProviderError('UNKNOWN');
    }
    if (response.status === 202 || response.status === 200) {
      const messageId = response.headers.get('x-message-id')?.trim();
      if (messageId && PROVIDER_ID.test(messageId)) return { providerMessageId: messageId, sentAs: 'EMAIL' };
      // Sandbox mode validates without sending and returns no message id.
      if (this.sandbox()) return { providerMessageId: `sandbox-${request.deliveryId}-${request.attempt}`, sentAs: 'EMAIL' };
      throw new CommunicationProviderError('UNKNOWN');
    }
    if (response.status === 429) {
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      const wait = Number.isFinite(reset) && reset > 0 ? Math.ceil(reset - Date.now() / 1000) : 60;
      throw new CommunicationProviderError('RETRYABLE', 'PROVIDER_FAILED', wait);
    }
    if (response.status === 401 || response.status === 403) throw new CommunicationProviderError('RETRYABLE', 'PROVIDER_FAILED', 900);
    if (response.status >= 400 && response.status < 500) throw new CommunicationProviderError('FAILED', 'PROVIDER_REJECTED');
    throw new CommunicationProviderError('UNKNOWN');
  }
}

export class SendGridWebhookError extends Error {
  constructor(readonly reason: 'NOT_CONFIGURED' | 'SIGNATURE_INVALID' | 'TIMESTAMP_OUT_OF_RANGE' | 'MALFORMED') { super(reason); }
}

const EVENT_MAP: Readonly<Record<string, VerifiedProviderReceipt['eventType']>> = {
  processed: 'SENT', delivered: 'DELIVERED', deferred: 'DEFERRED', bounce: 'BOUNCED', blocked: 'BOUNCED', dropped: 'DROPPED',
  spamreport: 'SPAM_REPORT', unsubscribe: 'UNSUBSCRIBED', group_unsubscribe: 'UNSUBSCRIBED',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EVENTS = 1000;
const TOLERANCE_SECONDS = 600;

/**
 * SendGrid Signed Event Webhook: ECDSA P-256 / SHA-256 over timestamp header + exact raw body, verified with
 * SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY (base64 DER SPKI, as SendGrid shows it). Returns only HON-sent events
 * (those carrying hon_delivery_id) mapped to the closed receipt vocabulary; opens and clicks are dropped. Mail tagged
 * hon_purpose HQ comes back with scope HQ (an 0281 HQ delivery). Any other purpose (internal staff notices, or one this
 * build does not know) is acknowledged and ignored here, so it never makes SendGrid retry the whole batch.
 */
export class SendGridEventWebhookVerifier {
  private key: KeyObject | undefined;
  private keySource: string | undefined;
  constructor(private readonly environment: () => Env = () => process.env, private readonly now: () => number = Date.now) {}

  private publicKey(): KeyObject {
    const source = this.environment().SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY?.trim();
    if (!source) throw new SendGridWebhookError('NOT_CONFIGURED');
    if (this.key && this.keySource === source) return this.key;
    try {
      const key = createPublicKey({ key: Buffer.from(source, 'base64'), format: 'der', type: 'spki' });
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('curve');
      this.key = key; this.keySource = source;
      return key;
    } catch { throw new SendGridWebhookError('NOT_CONFIGURED'); }
  }

  verify(rawBody: Buffer, signature: string | undefined, timestamp: string | undefined): VerifiedProviderReceipt[] {
    const key = this.publicKey();
    if (!signature || !timestamp || !/^\d{9,11}$/.test(timestamp) || !/^[A-Za-z0-9+/=]{16,200}$/.test(signature)) throw new SendGridWebhookError('SIGNATURE_INVALID');
    if (Math.abs(this.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) throw new SendGridWebhookError('TIMESTAMP_OUT_OF_RANGE');
    const valid = verify('sha256', Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]), { key, dsaEncoding: 'der' }, Buffer.from(signature, 'base64'));
    if (!valid) throw new SendGridWebhookError('SIGNATURE_INVALID');
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)); } catch { throw new SendGridWebhookError('MALFORMED'); }
    if (!Array.isArray(parsed) || parsed.length > MAX_EVENTS) throw new SendGridWebhookError('MALFORMED');
    const receipts: VerifiedProviderReceipt[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const event = item as Record<string, unknown>;
      const hq = event.hon_purpose === 'HQ';
      if (event.hon_purpose !== undefined && event.hon_purpose !== 'SCHOOL' && !hq) continue;
      const eventType = typeof event.event === 'string' ? EVENT_MAP[event.event] : undefined;
      const delivery = typeof event.hon_delivery_id === 'string' && UUID.test(event.hon_delivery_id) ? event.hon_delivery_id.toLowerCase() : undefined;
      const eventId = typeof event.sg_event_id === 'string' && PROVIDER_ID.test(event.sg_event_id) ? event.sg_event_id : undefined;
      const messageId = typeof event.sg_message_id === 'string' ? event.sg_message_id.split('.')[0] : undefined;
      const seconds = typeof event.timestamp === 'number' && Number.isSafeInteger(event.timestamp) ? event.timestamp : undefined;
      if (!eventType || !delivery || !eventId || !messageId || !PROVIDER_ID.test(messageId) || seconds === undefined) continue;
      receipts.push({ provider: 'SENDGRID', providerEventId: eventId, providerMessageId: messageId, honDeliveryId: delivery, eventType,
        occurredAt: new Date(seconds * 1000).toISOString(), ...(hq ? { scope: 'HQ' as const } : {}) });
    }
    return receipts;
  }
}
