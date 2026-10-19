import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { SaasProviderCode, SaasProviderEvent } from '@hon/contracts';
import { PaymentProviderError, WebhookVerificationError, type HostedCheckoutRequest, type HostedCheckoutSession,
  type PaymentProviderAdapter, type VerifiedProviderEvent } from './payment-provider.js';

const API = 'https://api.stripe.com/v1';
/** Webhook endpoints must be created with this API version so payload shapes match the normalizer. */
export const STRIPE_API_VERSION = '2024-06-20';
const SIGNATURE_TOLERANCE_SECONDS = 300;
/**
 * Event payload versions the normalizer reads correctly: the pinned version, and basil (2025-03-31) or later, where
 * invoice.subscription moved under invoice.parent and invoice/charge payment links were removed (those refs read as
 * null, so an unlinked refund or dispute is held for review instead of applied). Any other version is refused.
 */
export function supportedEventApiVersion(version: unknown): boolean {
  return version === STRIPE_API_VERSION || (typeof version === 'string' && /^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$/.test(version) && version.slice(0, 10) >= '2025-03-31');
}

export interface StripeTestModeConfig {
  secretKey: string; webhookSecret: string;
  /** 'STRIPE_SIMULATED' only when a deterministic fake transport is injected (tests and local proofs). */
  provider: SaasProviderCode;
  transport?: typeof fetch; now?: () => number;
}

/** Stable JSON (sorted keys) so a webhook delivery and an API fetch of the same event share one digest. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
export function eventDigest(event: SaasProviderEvent): string { return createHash('sha256').update(canonicalJson(event)).digest('hex'); }

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const ref = (v: unknown): string | null => str(v) ?? str(obj(v).id);
const int = (v: unknown): number => { if (!Number.isSafeInteger(v) || (v as number) < 0) throw new WebhookVerificationError('MALFORMED_EVENT'); return v as number; };
const iso = (seconds: unknown): string => new Date(int(seconds) * 1000).toISOString();

/** Maps a Stripe event to HON's closed provider-event shape. Only fields HON applies are kept; no card data exists in them. */
export function normalizeStripeEvent(raw: unknown, provider: SaasProviderCode): SaasProviderEvent {
  const e = obj(raw), data = obj(obj(e.data).object), type = str(e.type), id = str(e.id);
  if (e.object !== 'event' || !type || !id || typeof e.livemode !== 'boolean') throw new WebhookVerificationError('MALFORMED_EVENT');
  if (e.livemode) throw new WebhookVerificationError('LIVE_MODE_REFUSED');
  if (!supportedEventApiVersion(e.api_version)) throw new WebhookVerificationError('UNSUPPORTED_API_VERSION');
  const base = { provider, eventId: id, type, livemode: false as const, createdAt: iso(e.created) };
  switch (type) {
    case 'checkout.session.completed': case 'checkout.session.async_payment_succeeded':
      return { ...base, object: { sessionId: str(data.id), checkoutId: str(data.client_reference_id) ?? str(obj(data.metadata).honCheckoutId),
        paymentStatus: str(data.payment_status), amountTotal: int(data.amount_total), currency: str(data.currency),
        customerRef: ref(data.customer), subscriptionRef: ref(data.subscription), paymentIntentRef: ref(data.payment_intent), invoiceRef: ref(data.invoice) } } as SaasProviderEvent;
    case 'checkout.session.expired': case 'checkout.session.async_payment_failed':
      return { ...base, object: { sessionId: str(data.id), checkoutId: str(data.client_reference_id) ?? str(obj(data.metadata).honCheckoutId) } } as SaasProviderEvent;
    case 'invoice.paid': case 'invoice.payment_failed': {
      const line = obj((obj(data.lines).data as unknown[] | undefined)?.[0]), period = obj(line.period);
      if (period.start === undefined) throw new WebhookVerificationError('MALFORMED_EVENT');
      return { ...base, object: { invoiceRef: str(data.id),
        subscriptionRef: ref(data.subscription) ?? ref(obj(obj(data.parent).subscription_details).subscription),
        billingReason: str(data.billing_reason), amount: int(type === 'invoice.paid' ? data.amount_paid : data.amount_due), currency: str(data.currency),
        paymentIntentRef: ref(data.payment_intent), periodStart: iso(period.start), periodEnd: iso(period.end) } } as SaasProviderEvent;
    }
    case 'charge.refunded':
      return { ...base, object: { chargeRef: str(data.id), paymentIntentRef: ref(data.payment_intent), invoiceRef: ref(data.invoice),
        amountRefunded: int(data.amount_refunded), currency: str(data.currency) } } as SaasProviderEvent;
    case 'charge.dispute.created':
      return { ...base, object: { disputeRef: str(data.id), chargeRef: ref(data.charge), paymentIntentRef: ref(data.payment_intent),
        amount: int(data.amount), currency: str(data.currency) } } as SaasProviderEvent;
    default:
      return { ...base, object: {} } as SaasProviderEvent;
  }
}

/** Stripe signature scheme: header `t=<unix>,v1=<hex>[,v1=...]`, HMAC-SHA256 over `${t}.${rawBody}`. */
export function verifyStripeSignature(rawBody: Buffer, header: string | undefined, secret: string, nowSeconds: number): void {
  if (!header || header.length > 2048) throw new WebhookVerificationError('MISSING_SIGNATURE');
  const parts = header.split(',').map(p => p.split('=', 2) as [string, string | undefined]);
  const t = parts.find(([k]) => k === 't')?.[1];
  const signatures = parts.filter(([k, v]) => k === 'v1' && typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)).map(([, v]) => Buffer.from(v!, 'hex'));
  if (!t || !/^[0-9]{1,12}$/.test(t) || signatures.length === 0) throw new WebhookVerificationError('MISSING_SIGNATURE');
  if (Math.abs(nowSeconds - Number(t)) > SIGNATURE_TOLERANCE_SECONDS) throw new WebhookVerificationError('STALE_TIMESTAMP');
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  if (!signatures.some(s => s.length === expected.length && timingSafeEqual(s, expected))) throw new WebhookVerificationError('BAD_SIGNATURE');
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.body) throw new Error('MISSING_BODY');
  const reader = response.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > limit) throw new Error('RESPONSE_TOO_LARGE'); chunks.push(part.value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export class StripeTestModeAdapter implements PaymentProviderAdapter {
  readonly provider: SaasProviderCode;
  private readonly transport: typeof fetch;
  private readonly now: () => number;
  constructor(private readonly config: StripeTestModeConfig) {
    // Live credentials are refused outright: B5 is test mode only.
    if (!/^(sk|rk)_test_[A-Za-z0-9]{8,}$/.test(config.secretKey)) throw new PaymentProviderError('PRE_SEND', 'LIVE_MODE_REFUSED');
    if (!/^whsec_[A-Za-z0-9+/=_-]{8,}$/.test(config.webhookSecret)) throw new PaymentProviderError('PRE_SEND', 'NOT_CONFIGURED');
    if (config.provider === 'STRIPE_SIMULATED' && !config.transport) throw new PaymentProviderError('PRE_SEND', 'NOT_CONFIGURED');
    this.provider = config.provider;
    this.transport = config.transport ?? fetch;
    this.now = config.now ?? Date.now;
  }
  readiness(): 'READY' { return 'READY'; }

  private async call(method: 'GET' | 'POST', path: string, form: URLSearchParams | null, idempotencyKey: string | null, limit = 65536): Promise<Obj> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
    try {
      // Fixed host, no redirects. Once a POST is attempted it is never retried automatically here:
      // the caller retries with the same idempotency key, which the provider deduplicates.
      const response = await this.transport(`${API}${path}${method === 'GET' && form ? `?${form}` : ''}`, {
        method, redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.config.secretKey}`, 'Stripe-Version': STRIPE_API_VERSION,
          ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
        ...(method === 'POST' ? { body: form?.toString() ?? '' } : {}),
      });
      if ([400, 401, 402, 403, 404, 409].includes(response.status)) { await response.body?.cancel().catch(() => {}); throw new PaymentProviderError('FAILED', 'PROVIDER_REJECTED'); }
      if (!response.ok) throw new Error('UNCERTAIN_RESPONSE');
      const body = obj(await boundedJson(response, limit));
      if (body.livemode === true) throw new PaymentProviderError('FAILED', 'LIVE_MODE_REFUSED');
      return body;
    } catch (error) {
      if (error instanceof PaymentProviderError) throw error;
      throw new PaymentProviderError(method === 'GET' ? 'FAILED' : 'UNKNOWN', 'PROVIDER_UNKNOWN');
    } finally { clearTimeout(timer); }
  }

  async createCheckoutSession(input: HostedCheckoutRequest): Promise<HostedCheckoutSession> {
    if (!/^[0-9a-f-]{36}$/.test(input.checkoutId) || !Number.isSafeInteger(input.amountMinor) || input.amountMinor < 100
      || !/^https:\/\//.test(input.successUrl) || !/^https:\/\//.test(input.cancelUrl)) throw new PaymentProviderError('PRE_SEND', 'INVALID_REQUEST');
    const f = new URLSearchParams();
    const monthly = input.billingInterval === 'MONTHLY';
    f.set('mode', monthly ? 'subscription' : 'payment');
    f.set('client_reference_id', input.checkoutId);
    f.set('metadata[honCheckoutId]', input.checkoutId); f.set('metadata[honOrganizationId]', input.organizationId); f.set('metadata[honMode]', 'test');
    f.set('line_items[0][quantity]', '1');
    f.set('line_items[0][price_data][currency]', 'usd');
    f.set('line_items[0][price_data][unit_amount]', String(input.amountMinor));
    f.set('line_items[0][price_data][product_data][name]', input.productName);
    if (monthly) { f.set('line_items[0][price_data][recurring][interval]', 'month'); f.set('subscription_data[metadata][honCheckoutId]', input.checkoutId); }
    else f.set('payment_intent_data[metadata][honCheckoutId]', input.checkoutId);
    f.set('success_url', input.successUrl); f.set('cancel_url', input.cancelUrl);
    f.set('expires_at', String(Math.floor(Date.parse(input.expiresAt) / 1000)));
    const session = await this.call('POST', '/checkout/sessions', f, `hon-checkout-${input.checkoutId}`);
    const id = str(session.id), url = str(session.url);
    if (!id || !/^cs_test_[A-Za-z0-9_]{1,200}$/.test(id) || !url || !/^https:\/\/(checkout\.stripe\.com|checkout\.simulated\.invalid)\//.test(url)
      || session.client_reference_id !== input.checkoutId) throw new PaymentProviderError('UNKNOWN', 'PROVIDER_UNKNOWN');
    return { providerSessionId: id, checkoutUrl: url };
  }

  async expireCheckoutSession(providerSessionId: string): Promise<void> {
    if (!/^cs_test_[A-Za-z0-9_]{1,200}$/.test(providerSessionId)) throw new PaymentProviderError('PRE_SEND', 'INVALID_REQUEST');
    await this.call('POST', `/checkout/sessions/${providerSessionId}/expire`, null, `hon-expire-${providerSessionId}`);
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined): VerifiedProviderEvent {
    verifyStripeSignature(rawBody, signatureHeader, this.config.webhookSecret, Math.floor(this.now() / 1000));
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)); } catch { throw new WebhookVerificationError('MALFORMED_EVENT'); }
    const event = normalizeStripeEvent(parsed, this.provider);
    return { event, digest: eventDigest(event) };
  }

  async listRecentEvents(sinceEpochSeconds: number): Promise<VerifiedProviderEvent[]> {
    const out: VerifiedProviderEvent[] = []; let after: string | null = null;
    for (let page = 0; page < 5; page++) {
      const q = new URLSearchParams({ 'created[gte]': String(sinceEpochSeconds), limit: '100' });
      if (after) q.set('starting_after', after);
      const list = await this.call('GET', '/events', q, null, 1_048_576);
      const data = Array.isArray(list.data) ? list.data : [];
      for (const item of data) out.push((() => { const event = normalizeStripeEvent(item, this.provider); return { event, digest: eventDigest(event) }; })());
      if (list.has_more !== true || data.length === 0) break;
      after = str(obj(data.at(-1)).id);
    }
    // Oldest first, so dependencies (checkout completion) apply before what follows them.
    return out.sort((a, b) => a.event.createdAt.localeCompare(b.event.createdAt));
  }
}

/** Environment selection: real Stripe test mode only when both test credentials are configured. */
export function paymentProviderFromEnvironment(env: Record<string, string | undefined> = process.env): PaymentProviderAdapter | null {
  const secretKey = env.STRIPE_TEST_SECRET_KEY?.trim(), webhookSecret = env.STRIPE_TEST_WEBHOOK_SECRET?.trim();
  if (!secretKey || !webhookSecret) return null;
  return new StripeTestModeAdapter({ secretKey, webhookSecret, provider: 'STRIPE' });
}
