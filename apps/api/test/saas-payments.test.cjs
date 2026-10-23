const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { PaymentWebhookController, SaasHonOsCheckoutSchoolController, SaasPaymentsHqController, SaasPlanSchoolController } = require('../dist/payments/saas-payments.controller.js');
const { SaasPaymentsService } = require('../dist/payments/saas-payments.service.js');
const { PAYMENT_PROVIDER_ADAPTER, PaymentProviderError, UnconfiguredPaymentProvider } = require('../dist/payments/payment-provider.js');
const { StripeTestModeAdapter, normalizeStripeEvent, verifyStripeSignature, eventDigest, paymentProviderFromEnvironment, STRIPE_API_VERSION } = require('../dist/payments/stripe-test-mode-adapter.js');
const { StripeSimulator } = require('../dist/payments/stripe-simulator.js');
const { paymentWebhookTransport } = require('../dist/payments/payment-webhook-transport.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

const SECRET = 'whsec_fixtureSecretForTestsOnly0123456789';
const KEY = 'sk_test_fixtureKeyForTestsOnly0123456789';
const T = '2026-10-19T00:00:00.000Z', U = () => randomUUID();
const adapterWith = (sim) => new StripeTestModeAdapter({ secretKey: KEY, webhookSecret: SECRET, provider: 'STRIPE_SIMULATED', transport: sim.transport });
const checkout = (patch = {}) => ({ checkoutId: U(), organizationId: U(), schoolId: U(), offerId: U(), planCode: 'CORE', offerKind: 'REGULAR_MONTHLY',
  billingInterval: 'MONTHLY', amountMinor: 14900, currency: 'USD', founderReservationId: null, requesterKind: 'SCHOOL_OWNER', provider: 'STRIPE_SIMULATED',
  mode: 'TEST', providerSessionId: null, checkoutUrl: null, status: 'CREATED', statusReason: 'CREATED', subscriptionId: null, invoiceId: null,
  expiresAt: '2026-10-19T23:59:00.000Z', version: 1, createdAt: T, completedAt: null, ...patch });

test('adapter: live credentials and live events are refused; simulation needs an injected transport', () => {
  assert.throws(() => new StripeTestModeAdapter({ secretKey: 'sk_live_abcdefghijk12345', webhookSecret: SECRET, provider: 'STRIPE' }), e => e.reason === 'LIVE_MODE_REFUSED');
  assert.throws(() => new StripeTestModeAdapter({ secretKey: KEY, webhookSecret: 'not-a-secret', provider: 'STRIPE' }));
  assert.throws(() => new StripeTestModeAdapter({ secretKey: KEY, webhookSecret: SECRET, provider: 'STRIPE_SIMULATED' }));
  assert.equal(paymentProviderFromEnvironment({}), null);
  assert.throws(() => paymentProviderFromEnvironment({ STRIPE_TEST_SECRET_KEY: 'sk_live_abcdefghijk12345', STRIPE_TEST_WEBHOOK_SECRET: SECRET }));
  assert.equal(paymentProviderFromEnvironment({ STRIPE_TEST_SECRET_KEY: KEY, STRIPE_TEST_WEBHOOK_SECRET: SECRET }).provider, 'STRIPE');
  const sim = new StripeSimulator(SECRET);
  const live = sim.liveEvent();
  assert.throws(() => adapterWith(sim).verifyWebhook(live.raw, live.signature), e => e.reason === 'LIVE_MODE_REFUSED');
  assert.equal(new UnconfiguredPaymentProvider().readiness(), 'NOT_CONFIGURED');
});

test('webhook signature: exact raw body, tolerance window, rotation, constant-time comparison', () => {
  const sim = new StripeSimulator(SECRET), now = Math.floor(Date.now() / 1000);
  const d = sim.sign({ id: 'evt_x', object: 'event', api_version: '2024-06-20', type: 'customer.created', livemode: false, created: now, data: { object: {} } }, now);
  assert.doesNotThrow(() => verifyStripeSignature(d.raw, d.signature, SECRET, now));
  assert.throws(() => verifyStripeSignature(Buffer.concat([d.raw, Buffer.from(' ')]), d.signature, SECRET, now), e => e.reason === 'BAD_SIGNATURE');
  assert.throws(() => verifyStripeSignature(d.raw, d.signature, 'whsec_otherSecret0123456789', now), e => e.reason === 'BAD_SIGNATURE');
  assert.throws(() => verifyStripeSignature(d.raw, d.signature, SECRET, now + 301), e => e.reason === 'STALE_TIMESTAMP');
  assert.throws(() => verifyStripeSignature(d.raw, undefined, SECRET, now), e => e.reason === 'MISSING_SIGNATURE');
  assert.throws(() => verifyStripeSignature(d.raw, `t=${now}`, SECRET, now), e => e.reason === 'MISSING_SIGNATURE');
  const rotated = `t=${now},v1=${'0'.repeat(64)},${d.signature.split(',')[1]}`;
  assert.doesNotThrow(() => verifyStripeSignature(d.raw, rotated, SECRET, now));
});

test('normalizer keeps only applied fields, in a closed shape, with a stable digest', () => {
  const created = 1792368000;
  const session = normalizeStripeEvent({ id: 'evt_1', object: 'event', api_version: '2024-06-20', type: 'checkout.session.completed', livemode: false, created,
    data: { object: { id: 'cs_test_a1', client_reference_id: '0b6f0c8e-6f5c-4b8e-9d7a-1c2d3e4f5a6b', amount_total: 14900, currency: 'usd', customer: 'cus_1',
      subscription: 'sub_1', invoice: 'in_1', payment_intent: null, payment_status: 'paid', customer_details: { email: 'owner@example.test' } } } }, 'STRIPE');
  assert.deepEqual(Object.keys(session.object).sort(), ['amountTotal','checkoutId','currency','customerRef','invoiceRef','paymentIntentRef','paymentStatus','sessionId','subscriptionRef']);
  assert.equal(JSON.stringify(session).includes('owner@example.test'), false, 'no customer contact details are kept');
  assert.equal(session.createdAt, new Date(created * 1000).toISOString());
  const inv = normalizeStripeEvent({ id: 'evt_2', object: 'event', api_version: '2024-06-20', type: 'invoice.paid', livemode: false, created, data: { object: { id: 'in_2', billing_reason: 'subscription_cycle',
    amount_paid: 14900, currency: 'usd', parent: { subscription_details: { subscription: 'sub_9' } }, lines: { data: [{ period: { start: created, end: created + 2592000 } }] } } } }, 'STRIPE');
  assert.equal(inv.object.subscriptionRef, 'sub_9');
  assert.equal(eventDigest(inv), eventDigest(JSON.parse(JSON.stringify(inv))));
  assert.throws(() => normalizeStripeEvent({ id: 'evt_3', object: 'event', api_version: '2024-06-20', type: 'invoice.paid', livemode: false, created, data: { object: { id: 'in_3', amount_paid: -1 } } }, 'STRIPE'));
  assert.deepEqual(normalizeStripeEvent({ id: 'evt_4', object: 'event', api_version: '2024-06-20', type: 'customer.updated', livemode: false, created, data: { object: { email: 'x' } } }, 'STRIPE').object, {});
  // Payload versions: the pinned one and basil-or-later shapes are read; anything else is refused, never guessed at.
  const at = (api_version) => () => normalizeStripeEvent({ id: 'evt_5', object: 'event', api_version, type: 'customer.updated', livemode: false, created, data: { object: {} } }, 'STRIPE');
  for (const v of ['2024-06-20', '2025-03-31.basil', '2026-09-30.endive']) assert.doesNotThrow(at(v), v);
  for (const v of [undefined, null, '', '2024-04-10', '2024-09-30.acacia', '2023-10-16', 'latest', '2026-09-30.Endive']) assert.throws(at(v), e => e.reason === 'UNSUPPORTED_API_VERSION', String(v));
  const basil = normalizeStripeEvent({ id: 'evt_6', object: 'event', api_version: '2025-03-31.basil', type: 'invoice.paid', livemode: false, created, data: { object: { id: 'in_6', billing_reason: 'subscription_cycle',
    amount_paid: 14900, currency: 'usd', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_6' } }, lines: { data: [{ period: { start: created, end: created + 2592000 } }] } } } }, 'STRIPE');
  assert.deepEqual([basil.object.subscriptionRef, basil.object.paymentIntentRef], ['sub_6', null], 'basil invoices carry no payment link; refunds of them go to review');
});

test('hosted checkout request: test key, pinned API version, idempotent on the checkout id, no tax, no card data', async () => {
  const sim = new StripeSimulator(SECRET), adapter = adapterWith(sim), id = U();
  const input = { checkoutId: id, organizationId: U(), planCode: 'CORE', offerKind: 'FOUNDER_MONTHLY', billingInterval: 'MONTHLY', recurring: 'MONTH', amountMinor: 7900,
    productName: 'HON Core — founder monthly', expiresAt: new Date(Date.now() + 3600_000).toISOString(), successUrl: 'https://hon.example/ok', cancelUrl: 'https://hon.example/no' };
  const a = await adapter.createCheckoutSession(input), b = await adapter.createCheckoutSession(input);
  assert.equal(a.providerSessionId, b.providerSessionId, 'retry returns the same session');
  const r = sim.requests[0];
  assert.deepEqual([r.method, r.path, r.idempotencyKey, r.form.get('mode'), r.form.get('line_items[0][price_data][unit_amount]'),
    r.form.get('line_items[0][price_data][recurring][interval]'), r.form.get('client_reference_id'), r.form.has('automatic_tax[enabled]')],
    ['POST', '/v1/checkout/sessions', `hon-checkout-${id}`, 'subscription', '7900', 'month', id, false]);
  const lifetime = await adapterWith(sim).createCheckoutSession({ ...input, checkoutId: U(), offerKind: 'FOUNDER_LIFETIME', billingInterval: 'LIFETIME', recurring: 'NONE', amountMinor: 189600 });
  assert.match(lifetime.checkoutUrl, /^https:\/\/checkout\.simulated\.invalid\//);
  assert.equal(sim.requests.at(-1).form.get('mode'), 'payment');
  // HON OS (0182): the server decides recurring billing from the accepted offer; the adapter refuses any inconsistent request before sending.
  const hon = { ...input, planCode: 'COMPLETE', productName: 'HON OS — Annual' };
  const form = () => { const f = sim.requests.at(-1).form; return [f.get('mode'), f.get('line_items[0][price_data][unit_amount]'), f.get('line_items[0][price_data][recurring][interval]'),
    f.get('line_items[0][price_data][product_data][name]'), f.get('subscription_data[metadata][honCheckoutId]') !== null]; };
  await adapter.createCheckoutSession({ ...hon, checkoutId: U(), offerKind: 'REGULAR_ANNUAL', billingInterval: 'ANNUAL', recurring: 'YEAR', amountMinor: 317000 });
  assert.deepEqual(form(), ['subscription', '317000', 'year', 'HON OS — Annual', true]);
  await adapter.createCheckoutSession({ ...hon, checkoutId: U(), offerKind: 'FOUNDER_ANNUAL', billingInterval: 'ANNUAL', recurring: 'NONE', amountMinor: 183000 });
  assert.deepEqual(form(), ['payment', '183000', null, 'HON OS — Annual', false], 'an annual term without auto-renewal is a one-time payment');
  await adapter.createCheckoutSession({ ...hon, checkoutId: U(), offerKind: 'LIFETIME', billingInterval: 'LIFETIME', recurring: 'NONE', amountMinor: 950000 });
  assert.deepEqual(form(), ['payment', '950000', null, 'HON OS — Annual', false]);
  const sent = sim.requests.length;
  for (const bad of [{ offerKind: 'REGULAR_ANNUAL', billingInterval: 'ANNUAL', recurring: 'MONTH' }, { offerKind: 'LIFETIME', billingInterval: 'LIFETIME', recurring: 'YEAR' },
    { offerKind: 'REGULAR_MONTHLY', billingInterval: 'MONTHLY', recurring: 'NONE' }, { offerKind: 'REGULAR_MONTHLY', billingInterval: 'MONTHLY', recurring: 'YEAR' },
    { offerKind: 'REGULAR_MONTHLY', billingInterval: 'MONTHLY', recurring: undefined }, { offerKind: 'REGULAR_ANNUAL', billingInterval: 'ANNUAL', recurring: null }])
    await assert.rejects(adapter.createCheckoutSession({ ...hon, checkoutId: U(), amountMinor: 1000, ...bad }), e => e.outcome === 'PRE_SEND', JSON.stringify(bad));
  assert.equal(sim.requests.length, sent, 'refused requests never reach the provider');
  sim.failNextRequest('REJECT');
  await assert.rejects(adapter.createCheckoutSession({ ...input, checkoutId: U() }), e => e instanceof PaymentProviderError && e.outcome === 'FAILED');
  sim.failNextRequest('NETWORK');
  await assert.rejects(adapter.createCheckoutSession({ ...input, checkoutId: U() }), e => e.outcome === 'UNKNOWN');
  await assert.rejects(adapter.createCheckoutSession({ ...input, successUrl: 'http://insecure.example' }), e => e.outcome === 'PRE_SEND');
  let sawVersion = null; const spy = new StripeTestModeAdapter({ secretKey: KEY, webhookSecret: SECRET, provider: 'STRIPE_SIMULATED',
    transport: async (url, init) => { sawVersion = new Headers(init.headers).get('stripe-version'); return sim.transport(url, init); } });
  await spy.createCheckoutSession({ ...input, checkoutId: U() });
  assert.equal(sawVersion, STRIPE_API_VERSION);
});

test('contracts: closed shapes for checkout, program, plan options; live mode and card data never appear', () => {
  assert.doesNotThrow(() => contracts.validateSaasCheckoutReceipt({ checkout: checkout(), replayed: false }));
  for (const bad of [checkout({ mode: 'LIVE' }), checkout({ status: 'OPEN' }), checkout({ checkoutUrl: 'https://evil.example/pay', status: 'OPEN', providerSessionId: 'cs_test_1' }),
    checkout({ providerSessionId: 'cs_live_1' }), checkout({ offerKind: 'FOUNDER_MONTHLY' }), checkout({ offerKind: 'FOUNDER_LIFETIME' }), checkout({ status: 'COMPLETED' }), checkout({ cardNumber: '4242' }),
    checkout({ offerKind: 'REGULAR_ANNUAL', billingInterval: 'ANNUAL' }), checkout({ offerKind: 'LIFETIME', billingInterval: 'LIFETIME', planCode: 'COMPLETE', requesterKind: 'HQ', schoolId: null }),
    checkout({ offerKind: 'REGULAR_ANNUAL', billingInterval: 'MONTHLY', planCode: 'COMPLETE' }), checkout({ offerKind: 'LIFETIME', billingInterval: 'LIFETIME', planCode: 'COMPLETE', founderReservationId: U() })])
    assert.throws(() => contracts.validateSaasCheckoutReceipt({ checkout: bad, replayed: false }));
  const program = { status: 'TEST_MODE', provider: 'STRIPE', mode: 'TEST', liveMode: 'UNAVAILABLE', testTaxReference: 'Owner test-mode tax note', authorizationReference: 'Owner auth',
    version: 2, changedAt: T, cardDataStored: false, refundExecution: 'UNAVAILABLE' };
  assert.doesNotThrow(() => contracts.validateSaasPaymentProgramReceipt({ program, replayed: false }));
  for (const bad of [{ ...program, liveMode: 'AVAILABLE' }, { ...program, cardDataStored: true }, { ...program, refundExecution: 'AVAILABLE' }, { ...program, mode: null }])
    assert.throws(() => contracts.validateSaasPaymentProgramReceipt({ program: bad, replayed: false }));
  for (const bad of [{ action: 'ENABLE_LIVE_MODE', expectedVersion: 1, authorizationReference: 'x', provider: 'STRIPE', testTaxReference: 'x' },
    { action: 'ENABLE_TEST_MODE', expectedVersion: 1, authorizationReference: 'x', provider: 'PAYPAL', testTaxReference: 'x' },
    { action: 'ENABLE_TEST_MODE', expectedVersion: 1, authorizationReference: 'x', provider: 'STRIPE', testTaxReference: null }])
    assert.throws(() => contracts.validateSaasPaymentProgramInput(bad));
  assert.throws(() => contracts.validateSaasSchoolCheckoutInput({ offerId: U(), amountMinor: 100 }));
  assert.throws(() => contracts.validateSaasSchoolCheckoutInput({ offerId: U(), organizationId: U() }));
  assert.throws(() => contracts.validateSaasPaymentRecoveryInput({ sinceHours: 1000 }));
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
const human = command => ({ 'content-type': 'application/json', origin: 'https://hon.example', 'x-hon-human-command': command, 'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty', 'idempotency-key': randomUUID() });

async function appWith(callSaasBilling, adapter) {
  const module = await Test.createTestingModule({ controllers: [SaasPlanSchoolController, SaasHonOsCheckoutSchoolController, SaasPaymentsHqController, PaymentWebhookController],
    providers: [SaasPaymentsService, SaasBillingService, SaasCommandGuard, SaasReadGuard, { provide: PAYMENT_PROVIDER_ADAPTER, useValue: adapter },
      { provide: RuntimeDatabaseService, useValue: { callSaasBilling } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication({ bodyParser: false });
  app.use(paymentWebhookTransport()); app.use(json({ strict: true })); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${app.getHttpServer().address().port}/v1` };
}

test('HTTP: webhook needs a valid signature over the raw body; nothing else reaches the database', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const sim = new StripeSimulator(SECRET), calls = [];
  const { app, base } = await appWith(async (operation, params) => { calls.push([operation, params]);
    return { event: { eventId: U(), providerEventId: JSON.parse(params[0]).eventId, type: JSON.parse(params[0]).type, outcome: 'IGNORED', detail: 'EVENT_TYPE_NOT_USED',
      organizationId: null, checkoutId: null, subscriptionId: null }, replayed: false }; }, adapterWith(sim));
  try {
    const d = sim.sign({ id: 'evt_hook1', object: 'event', api_version: '2024-06-20', type: 'customer.created', livemode: false, created: Math.floor(Date.now() / 1000), data: { object: {} } });
    const ok = await send(`${base}/payments/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': d.signature }, body: d.raw });
    assert.equal(ok.status, 200, ok.body); assert.deepEqual(JSON.parse(ok.body), { received: true, outcome: 'IGNORED', replayed: false });
    assert.equal(calls.length, 1); assert.equal(calls[0][0], 'ingestProviderEvent'); assert.match(calls[0][1][1], /^[0-9a-f]{64}$/);
    const live = sim.liveEvent();
    const tampered = Buffer.from(d.raw.toString().replace('customer.created', 'checkout.session.completed'));
    for (const [headers, body, path] of [[{ 'content-type': 'application/json', 'stripe-signature': d.signature }, tampered, 'payments/webhooks/stripe'],
      [{ 'content-type': 'application/json' }, d.raw, 'payments/webhooks/stripe'],
      [{ 'content-type': 'text/plain', 'stripe-signature': d.signature }, d.raw, 'payments/webhooks/stripe'],
      [{ 'content-type': 'application/json', 'stripe-signature': d.signature, cookie: 'hon_session=x' }, d.raw, 'payments/webhooks/stripe'],
      [{ 'content-type': 'application/json', 'stripe-signature': d.signature }, d.raw, 'payments/webhooks/stripe?x=1'],
      [{ 'content-type': 'application/json', 'stripe-signature': live.signature }, live.raw, 'payments/webhooks/stripe'],
      [{ 'content-type': 'application/json', 'stripe-signature': d.signature }, d.raw, 'payments/webhooks/paypal']])
      assert.equal((await send(`${base}/${path}`, { method: 'POST', headers, body })).status, 400, path + JSON.stringify(headers));
    assert.equal(calls.length, 1, 'rejected deliveries never reach the database');
    // There is no charge, refund execution, live-mode or card route.
    for (const path of ['hq/saas/payments/charges', 'hq/saas/payments/refunds', 'hq/saas/payments/live-mode', `schools/${U()}/hon-plan/card`, `schools/${U()}/hon-plan/charge`])
      assert.equal((await send(`${base}/${path}`, { method: 'POST', headers: human('saas-checkout-start'), body: '{}' })).status, 404, path);
    // Commands require the exact human-command header.
    assert.equal((await send(`${base}/schools/${U()}/hon-plan/checkout`, { method: 'POST', headers: human('saas-payment-program'), body: JSON.stringify({ offerId: U() }) })).status, 403);
    assert.equal(calls.length, 1);
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});

test('HTTP: an initial invoice dependency returns 503 and the identical signed delivery can retry', async () => {
  const sim = new StripeSimulator(SECRET), calls = [];
  const identity = { organizationId: U(), checkoutId: U(), subscriptionId: U() };
  const { app, base } = await appWith(async (operation, params) => {
    assert.equal(operation, 'ingestProviderEvent'); calls.push(params);
    if (calls.length === 1) throw Object.assign(new Error('SAAS_PROVIDER_EVENT_NOT_READY'), { code: '55006' });
    return { event: { eventId: U(), providerEventId: JSON.parse(params[0]).eventId, type: 'invoice.paid',
      outcome: 'ALREADY_APPLIED', detail: 'FIRST_INVOICE_COVERED_BY_CHECKOUT', ...identity }, replayed: false };
  }, adapterWith(sim));
  try {
    const now = Math.floor(Date.now() / 1000);
    const delivery = sim.sign({ id: 'evt_invoice_dependency', object: 'event', api_version: '2026-09-30.endive',
      type: 'invoice.paid', livemode: false, created: now, data: { object: { id: 'in_dependency',
        parent: { subscription_details: { subscription: 'sub_dependency' } }, billing_reason: 'subscription_create',
        amount_paid: 14900, currency: 'usd', lines: { data: [{ period: { start: now, end: now + 2592000 } }] } } } });
    const request = { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': delivery.signature }, body: delivery.raw };
    const retry = await send(`${base}/payments/webhooks/stripe`, request);
    assert.equal(retry.status, 503); assert.equal(JSON.parse(retry.body).code, 'SAAS_PROVIDER_EVENT_RETRY');
    assert.equal(calls.length, 1, 'no automatic database retry');
    const applied = await send(`${base}/payments/webhooks/stripe`, request);
    assert.equal(applied.status, 200);
    assert.deepEqual(JSON.parse(applied.body), { received: true, outcome: 'ALREADY_APPLIED', replayed: false });
    assert.deepEqual(calls[0], calls[1], 'retry preserves the normalized event and digest');
  } finally { await app.close(); }
});

test('service: checkout opens through the adapter; failure and unknown outcomes are recorded safely', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  try {
    const sim = new StripeSimulator(SECRET), calls = [];
    let current = checkout();
    const db = { callSaasBilling: async (operation, params) => { calls.push([operation, params]);
      if (operation === 'createSchoolCheckout') return { checkout: current, replayed: false };
      if (operation === 'attachCheckoutSession') { const p = JSON.parse(params[2]);
        current = p.outcome === 'OPENED' ? { ...current, status: 'OPEN', statusReason: 'PROVIDER_SESSION_OPENED', providerSessionId: p.providerSessionId, checkoutUrl: p.checkoutUrl, version: 2 }
          : { ...current, status: 'FAILED', statusReason: 'PROVIDER_CREATE_FAILED', version: 2 };
        return { checkout: current, replayed: false }; }
      throw new Error('unexpected ' + operation); } };
    const billing = new SaasBillingService(db);
    const service = new SaasPaymentsService(billing, db, adapterWith(sim));
    const opened = await service.startSchoolCheckout('verified-human', current.schoolId, { offerId: current.offerId }, U());
    assert.deepEqual([opened.providerCall, opened.checkout.status], ['OPENED', 'OPEN']);
    assert.match(opened.checkout.checkoutUrl, /^https:\/\/checkout\.simulated\.invalid\//);
    assert.match(sim.requests[0].form.get('success_url'), /^https:\/\/hon\.example\/schools\/[0-9a-f-]+\/hon-plan\?checkout=/);
    current = checkout(); sim.failNextRequest('REJECT');
    await assert.rejects(service.startSchoolCheckout('verified-human', current.schoolId, { offerId: current.offerId }, U()), e => e.getStatus() === 502);
    assert.equal(current.status, 'FAILED');
    current = checkout(); sim.failNextRequest('NETWORK'); const n = calls.length;
    await assert.rejects(service.startSchoolCheckout('verified-human', current.schoolId, { offerId: current.offerId }, U()), e => e.getStatus() === 409 && e.getResponse().code === 'SAAS_OUTCOME_UNKNOWN');
    assert.equal(calls.slice(n).filter(c => c[0] === 'attachCheckoutSession').length, 0, 'an unknown outcome records nothing; retry with the same key');
    const never = new SaasPaymentsService(new SaasBillingService({ callSaasBilling: async () => { throw new Error('must not be called'); } }), {}, adapterWith(sim));
    await assert.rejects(never.startSchoolCheckout('verified-human', U(), { offerId: U(), priceMinor: 1 }, U()), e => e.getStatus() === 400);
    await assert.rejects(never.handleWebhook('not a buffer', 't=1,v1=00'), e => e.getStatus() === 400);
  } finally { if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});

test('HON OS checkout: the school sends only an offer ID; the provider session sells the accepted offer', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const sim = new StripeSimulator(SECRET), calls = [], digest = 'b'.repeat(64);
  let current = checkout({ planCode: 'COMPLETE', offerKind: 'REGULAR_ANNUAL', billingInterval: 'ANNUAL', amountMinor: 317000 });
  const purchase = (recurringBilling = 'YEAR') => ({ productName: 'HON OS — Annual', offerDisplayName: 'Annual', recurringBilling, offerSetVersion: 2,
    termsReference: 'Fixture HON OS terms', acceptedOfferDigest: digest });
  let recurringBilling = 'YEAR';
  const { app, base } = await appWith(async (operation, params) => { calls.push([operation, params]);
    if (operation === 'createSchoolHonOsCheckout') return { checkout: current, purchase: purchase(recurringBilling), replayed: false };
    if (operation === 'attachCheckoutSession') { const p = JSON.parse(params[2]);
      current = { ...current, status: 'OPEN', statusReason: 'PROVIDER_SESSION_OPENED', providerSessionId: p.providerSessionId, checkoutUrl: p.checkoutUrl, version: 2 };
      return { checkout: current, replayed: false }; }
    throw new Error('unexpected ' + operation); }, adapterWith(sim));
  try {
    const school = current.schoolId, url = `${base}/schools/${school}/hon-os-offers/checkout`, headers = human('saas-hon-os-checkout-start');
    const res = await send(url, { method: 'POST', headers, body: JSON.stringify({ offerId: current.offerId }) });
    assert.equal(res.status, 200, res.body);
    const data = JSON.parse(res.body).data;
    assert.deepEqual([data.providerCall, data.checkout.status, data.purchase.recurringBilling, data.purchase.acceptedOfferDigest], ['OPENED', 'OPEN', 'YEAR', digest]);
    assert.deepEqual(calls[0], ['createSchoolHonOsCheckout', ['verified-human', school, JSON.stringify({ offerId: current.offerId }), headers['idempotency-key'], calls[0][1][4], calls[0][1][5]]]);
    const f = sim.requests.at(-1).form;
    assert.deepEqual([f.get('mode'), f.get('line_items[0][price_data][unit_amount]'), f.get('line_items[0][price_data][recurring][interval]'), f.get('line_items[0][price_data][product_data][name]')],
      ['subscription', '317000', 'year', 'HON OS — Annual']);
    assert.match(f.get('success_url'), new RegExp(`^https://hon\\.example/schools/${school}/hon-plan\\?checkout=`));
    // A one-time annual term opens a payment session with no recurring price.
    current = checkout({ planCode: 'COMPLETE', offerKind: 'FOUNDER_ANNUAL', billingInterval: 'ANNUAL', amountMinor: 183000 }); recurringBilling = 'NONE';
    assert.equal((await send(`${base}/schools/${current.schoolId}/hon-os-offers/checkout`, { method: 'POST', headers: human('saas-hon-os-checkout-start'), body: JSON.stringify({ offerId: current.offerId }) })).status, 200);
    assert.deepEqual([sim.requests.at(-1).form.get('mode'), sim.requests.at(-1).form.get('line_items[0][price_data][recurring][interval]')], ['payment', null]);
    // A receipt whose recurring billing contradicts its interval never reaches the provider.
    current = checkout({ planCode: 'COMPLETE', offerKind: 'LIFETIME', billingInterval: 'LIFETIME', amountMinor: 950000 }); recurringBilling = 'YEAR';
    const sent = sim.requests.length;
    assert.equal((await send(`${base}/schools/${current.schoolId}/hon-os-offers/checkout`, { method: 'POST', headers: human('saas-hon-os-checkout-start'), body: JSON.stringify({ offerId: current.offerId }) })).status, 503);
    assert.equal(sim.requests.length, sent);
    const n = calls.length;
    for (const body of [{ offerId: current.offerId, priceMinor: 1 }, { offerId: current.offerId, offerKind: 'LIFETIME' }, { offerId: 'OS_MONTHLY' }, {}])
      assert.equal((await send(url, { method: 'POST', headers: human('saas-hon-os-checkout-start'), body: JSON.stringify(body) })).status, 400, JSON.stringify(body));
    for (const extra of [{ 'x-hon-human-command': 'saas-checkout-start' }, { origin: 'https://attacker.example' }, { 'sec-fetch-site': 'cross-site' }, { 'content-type': 'text/plain' }])
      assert.equal((await send(url, { method: 'POST', headers: { ...human('saas-hon-os-checkout-start'), ...extra }, body: JSON.stringify({ offerId: current.offerId }) })).status, 403, JSON.stringify(extra));
    assert.equal((await send(`${url}?price=1`, { method: 'POST', headers: human('saas-hon-os-checkout-start'), body: JSON.stringify({ offerId: current.offerId }) })).status, 400);
    assert.equal((await send(`${base}/schools/not-a-uuid/hon-os-offers/checkout`, { method: 'POST', headers: human('saas-hon-os-checkout-start'), body: JSON.stringify({ offerId: current.offerId }) })).status, 400);
    assert.equal(calls.length, n, 'refused requests never reach the database');
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});

test('HON OS checkout receipt: closed shape tied to the checkout interval', () => {
  const c = checkout({ planCode: 'COMPLETE', offerKind: 'LIFETIME', billingInterval: 'LIFETIME', amountMinor: 950000 });
  const purchase = { productName: 'HON OS — Lifetime', offerDisplayName: 'Lifetime', recurringBilling: 'NONE', offerSetVersion: 1, termsReference: 'Fixture terms', acceptedOfferDigest: 'c'.repeat(64) };
  assert.doesNotThrow(() => contracts.validateSaasHonOsCheckoutReceipt({ checkout: c, purchase, replayed: false }));
  for (const bad of [{ checkout: c, purchase: { ...purchase, recurringBilling: 'YEAR' }, replayed: false }, { checkout: c, purchase: { ...purchase, productName: 'HON Complete — lifetime' }, replayed: false },
    { checkout: c, purchase: { ...purchase, acceptedOfferDigest: 'C'.repeat(64) }, replayed: false }, { checkout: c, purchase: { ...purchase, priceMinor: 950000 }, replayed: false },
    { checkout: { ...c, planCode: 'CORE' }, purchase, replayed: false }, { checkout: { ...c, founderReservationId: U() }, purchase, replayed: false }, { checkout: c, replayed: false }])
    assert.throws(() => contracts.validateSaasHonOsCheckoutReceipt(bad), JSON.stringify(bad).slice(0, 120));
  assert.equal(contracts.SAAS_COMMANDS.startHonOsCheckout, 'saas-hon-os-checkout-start');
});

test('D8: a closed legacy sale is a 422 rule refusal before any provider call; held legacy checkouts keep a closed shape', async () => {
  const sim = new StripeSimulator(SECRET), calls = [];
  const closed = Object.assign(new Error('SAAS_LEGACY_SALES_CLOSED'), { code: '23514' });
  const db = { callSaasBilling: async (operation) => { calls.push(operation); throw closed; } };
  const service = new SaasPaymentsService(new SaasBillingService(db), db, adapterWith(sim));
  await assert.rejects(service.startSchoolCheckout('verified-human', U(), { offerId: U() }, U()),
    e => e.getStatus() === 422 && e.getResponse().code === 'SAAS_LEGACY_SALES_CLOSED');
  await assert.rejects(service.startHqCheckout('verified-human', { organizationId: U(), offerId: U() }, U()),
    e => e.getStatus() === 422 && e.getResponse().code === 'SAAS_LEGACY_SALES_CLOSED');
  assert.deepEqual(calls, ['createSchoolCheckout', 'createHqCheckout']);
  assert.equal(sim.requests.length, 0, 'no provider session is requested');
  const held = checkout({ status: 'PAID_NEEDS_REVIEW', statusReason: 'LEGACY_SALES_CLOSED', providerSessionId: 'cs_test_held', version: 3 });
  assert.equal(contracts.validateSaasCheckout(held), held);
  assert.throws(() => contracts.validateSaasCheckout({ ...held, statusReason: 'LEGACY_SALES_REOPENED' }));
});
