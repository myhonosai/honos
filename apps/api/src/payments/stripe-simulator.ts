import { createHmac } from 'node:crypto';

/**
 * Deterministic stand-in for the Stripe test-mode API and its webhooks, for tests and disposable
 * proofs only. It is injected as the adapter's transport (provider STRIPE_SIMULATED) and is never
 * selected by environment. Results it produces are SIMULATED, not provider-verified by Stripe.
 */
type Json = Record<string, unknown>;
interface SimSession { id: string; checkoutId: string; mode: 'subscription' | 'payment'; amount: number; expiresAt: number; status: 'open' | 'complete' | 'expired' }
export interface SignedDelivery { raw: Buffer; signature: string; event: Json }

export class StripeSimulator {
  private n = 0;
  readonly sessions = new Map<string, SimSession>();
  readonly requests: { method: string; path: string; idempotencyKey: string | null; form: URLSearchParams | null }[] = [];
  readonly events: Json[] = [];
  private failNext: 'REJECT' | 'NETWORK' | null = null;
  constructor(readonly webhookSecret: string, private readonly now: () => number = Date.now) {}

  private id(prefix: string): string { this.n += 1; return `${prefix}_sim${String(this.n).padStart(6, '0')}`; }
  private seconds(): number { return Math.floor(this.now() / 1000); }
  failNextRequest(kind: 'REJECT' | 'NETWORK'): void { this.failNext = kind; }

  /** fetch-compatible transport for StripeTestModeAdapter. */
  readonly transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    if (url.origin !== 'https://api.stripe.com' || !/^Bearer (sk|rk)_test_/.test(headers.get('authorization') ?? '')) return new Response('{}', { status: 401 });
    const form = method === 'POST' ? new URLSearchParams(String(init?.body ?? '')) : null;
    const idempotencyKey = headers.get('idempotency-key');
    this.requests.push({ method, path: url.pathname, idempotencyKey, form });
    if (this.failNext) { const kind = this.failNext; this.failNext = null; if (kind === 'NETWORK') throw new TypeError('fetch failed'); return new Response('{"error":{}}', { status: 400 }); }
    if (method === 'POST' && url.pathname === '/v1/checkout/sessions') {
      const checkoutId = form!.get('client_reference_id')!;
      const existing = [...this.sessions.values()].find(s => s.checkoutId === checkoutId); // idempotency on the checkout id
      const s = existing ?? { id: this.id(`cs_test_${checkoutId.replaceAll('-', '').slice(0, 12)}`), checkoutId,
        mode: form!.get('mode') as 'subscription' | 'payment', amount: Number(form!.get('line_items[0][price_data][unit_amount]')),
        expiresAt: Number(form!.get('expires_at')), status: 'open' as const };
      this.sessions.set(s.id, s);
      return Response.json({ id: s.id, object: 'checkout.session', livemode: false, client_reference_id: checkoutId, url: `https://checkout.simulated.invalid/c/pay/${s.id}` });
    }
    const expire = /^\/v1\/checkout\/sessions\/(cs_test_[A-Za-z0-9_]+)\/expire$/.exec(url.pathname);
    if (method === 'POST' && expire) {
      const s = this.sessions.get(expire[1]!); if (!s || s.status !== 'open') return new Response('{"error":{}}', { status: 400 });
      s.status = 'expired'; return Response.json({ id: s.id, object: 'checkout.session', livemode: false, status: 'expired' });
    }
    if (method === 'GET' && url.pathname === '/v1/events') {
      const since = Number(url.searchParams.get('created[gte]') ?? 0);
      return Response.json({ object: 'list', data: this.events.filter(e => (e.created as number) >= since).slice().reverse(), has_more: false });
    }
    return new Response('{"error":{}}', { status: 404 });
  };

  /** Stripe-format signature over the exact payload bytes. */
  sign(event: Json, timestamp = this.seconds()): SignedDelivery {
    const raw = Buffer.from(JSON.stringify(event));
    const v1 = createHmac('sha256', this.webhookSecret).update(`${timestamp}.`).update(raw).digest('hex');
    return { raw, signature: `t=${timestamp},v1=${v1}`, event };
  }
  private emit(type: string, object: Json, extra: Json = {}): SignedDelivery {
    const event = { id: this.id('evt'), object: 'event', type, livemode: false, created: this.seconds(), api_version: '2024-06-20', data: { object }, ...extra };
    this.events.push(event);
    return this.sign(event);
  }
  private session(sessionId: string): SimSession {
    const s = this.sessions.get(sessionId); if (!s) throw new Error('UNKNOWN_SIM_SESSION'); return s;
  }

  /** Customer paid on the hosted page. Monthly also yields the first subscription invoice event. */
  completeCheckout(sessionId: string, options: { paid?: boolean; amount?: number } = {}) {
    const s = this.session(sessionId); s.status = 'complete';
    const customer = this.id('cus'), subscription = s.mode === 'subscription' ? this.id('sub') : null;
    const paymentIntent = this.id('pi'), invoice = s.mode === 'subscription' ? this.id('in') : null, charge = this.id('ch');
    const completed = this.emit(options.paid === false ? 'checkout.session.completed' : 'checkout.session.completed', {
      id: s.id, object: 'checkout.session', client_reference_id: s.checkoutId, metadata: { honCheckoutId: s.checkoutId }, mode: s.mode,
      amount_total: options.amount ?? s.amount, currency: 'usd', customer, subscription, invoice,
      payment_intent: s.mode === 'payment' ? paymentIntent : null, payment_status: options.paid === false ? 'unpaid' : 'paid', status: 'complete' });
    const firstInvoice = subscription ? this.emit('invoice.paid', this.invoiceObject(invoice!, subscription, 'subscription_create', options.amount ?? s.amount, paymentIntent,
      this.seconds(), this.seconds() + 30 * 86400)) : null;
    return { completed, firstInvoice, customer, subscription, paymentIntent: s.mode === 'payment' ? paymentIntent : paymentIntent, invoice, charge };
  }
  asyncPaymentSucceeded(sessionId: string) {
    const s = this.session(sessionId);
    return this.emit('checkout.session.async_payment_succeeded', { id: s.id, client_reference_id: s.checkoutId, amount_total: s.amount, currency: 'usd',
      customer: this.id('cus'), subscription: null, invoice: null, payment_intent: this.id('pi'), payment_status: 'paid' });
  }
  asyncPaymentFailed(sessionId: string) { const s = this.session(sessionId); return this.emit('checkout.session.async_payment_failed', { id: s.id, client_reference_id: s.checkoutId }); }
  expire(sessionId: string) { const s = this.session(sessionId); s.status = 'expired'; return this.emit('checkout.session.expired', { id: s.id, client_reference_id: s.checkoutId }); }

  private invoiceObject(id: string, subscription: string, reason: string, amount: number, paymentIntent: string | null, start: number, end: number): Json {
    return { id, object: 'invoice', subscription, billing_reason: reason, amount_paid: amount, amount_due: amount, currency: 'usd', payment_intent: paymentIntent,
      lines: { object: 'list', data: [{ object: 'line_item', period: { start, end } }] } };
  }
  renewal(subscription: string, periodStartSeconds: number, amount: number) {
    const invoice = this.id('in'), paymentIntent = this.id('pi');
    return { invoice, paymentIntent, delivery: this.emit('invoice.paid', this.invoiceObject(invoice, subscription, 'subscription_cycle', amount, paymentIntent, periodStartSeconds, periodStartSeconds + 30 * 86400)) };
  }
  renewalFailed(subscription: string, periodStartSeconds: number, amount: number) {
    return this.emit('invoice.payment_failed', this.invoiceObject(this.id('in'), subscription, 'subscription_cycle', amount, null, periodStartSeconds, periodStartSeconds + 30 * 86400));
  }
  refund(paymentIntent: string | null, invoice: string | null, cumulativeRefunded: number, charge = this.id('ch')) {
    return this.emit('charge.refunded', { id: charge, object: 'charge', payment_intent: paymentIntent, invoice, amount_refunded: cumulativeRefunded, currency: 'usd' });
  }
  dispute(paymentIntent: string | null, amount: number, charge = this.id('ch')) {
    return this.emit('charge.dispute.created', { id: this.id('dp'), object: 'dispute', charge, payment_intent: paymentIntent, amount, currency: 'usd' });
  }
  /** A live-mode event: always refused. */
  liveEvent() {
    const event = { id: this.id('evt'), object: 'event', type: 'checkout.session.completed', livemode: true, created: this.seconds(), data: { object: {} } };
    return this.sign(event);
  }
}
