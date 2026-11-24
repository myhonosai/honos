const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const { SendGridEmailProvider, SendGridEventWebhookVerifier, SendGridWebhookError, SENDGRID_MAIL_SEND_URL } = require('../dist/communication/delivery/sendgrid-email-provider.js');
const { CommunicationProviderError } = require('../dist/communication/delivery/communication-provider.js');
const { communicationWebhookTransport, ingestReceipts } = require('../dist/communication/delivery/communication-webhook.controller.js');

const request = (over = {}) => ({
  deliveryId: '11111111-1111-4111-8111-111111111111', messageId: '55555555-5555-4555-8555-555555555555',
  organizationId: '33333333-3333-4333-8333-333333333333', schoolId: '44444444-4444-4444-8444-444444444444',
  channel: 'EMAIL', recipientAddress: 'ada@example.test', content: 'Class moves to 6pm.', schoolName: 'Day "School"\r\n', attempt: 1, ...over,
});
const approved = (over = {}) => ({ SENDGRID_API_KEY: 'SG.test', HON_EMAIL_FROM: 'notices@hon.example', HON_EMAIL_SEND_APPROVED: 'true', ...over });
const reply = (status, headers = {}) => ({ status, headers: new Headers(headers) });
const isErr = (outcome, code) => (error) => error instanceof CommunicationProviderError && error.outcome === outcome && error.failureCode === code;

test('SendGrid adapter is READY only with key, sender and the exact send approval, and never calls out otherwise', async () => {
  for (const env of [{}, approved({ SENDGRID_API_KEY: ' ' }), approved({ HON_EMAIL_FROM: 'not an address' }), approved({ HON_EMAIL_SEND_APPROVED: 'TRUE' }), approved({ HON_EMAIL_SEND_APPROVED: undefined })]) {
    let calls = 0;
    const adapter = new SendGridEmailProvider(() => env, async () => { calls += 1; throw new Error('NETWORK_FORBIDDEN'); });
    assert.equal(adapter.readiness(), 'CONFIGURATION_REQUIRED');
    await assert.rejects(adapter.send(request()), isErr('RETRYABLE', 'PROVIDER_FAILED'));
    assert.equal(calls, 0);
  }
  assert.equal(new SendGridEmailProvider(() => approved()).readiness(), 'READY');
});

test('SendGrid request: sandbox on by default, HON delivery id as custom argument, plain text, no open or click tracking', async () => {
  let seen;
  const adapter = new SendGridEmailProvider(() => approved(), async (url, init) => { seen = { url, init }; return reply(202, { 'x-message-id': 'abcDEF123' }); });
  assert.deepEqual(await adapter.send(request()), { providerMessageId: 'abcDEF123', sentAs: 'EMAIL' });
  assert.equal(seen.url, SENDGRID_MAIL_SEND_URL);
  assert.equal(seen.init.headers.authorization, 'Bearer SG.test');
  assert.equal(seen.init.redirect, 'error');
  const body = JSON.parse(seen.init.body);
  assert.deepEqual(body.personalizations, [{ to: [{ email: 'ada@example.test' }], custom_args: { hon_delivery_id: request().deliveryId } }]);
  assert.deepEqual(body.from, { email: 'notices@hon.example', name: 'Day  School via HON' });
  assert.deepEqual(body.content, [{ type: 'text/plain', value: 'Class moves to 6pm.' }]);
  assert.equal(body.mail_settings.sandbox_mode.enable, true);
  assert.deepEqual(body.tracking_settings, { subscription_tracking: { enable: true }, open_tracking: { enable: false }, click_tracking: { enable: false } });
  const live = new SendGridEmailProvider(() => approved({ HON_EMAIL_SANDBOX_MODE: 'false' }));
  assert.equal(live.requestBody(request()).mail_settings.sandbox_mode.enable, false);
  assert.equal(new SendGridEmailProvider(() => approved({ HON_EMAIL_SANDBOX_MODE: 'FALSE' })).sandbox(), true);
  assert.deepEqual(live.requestBody({ ...request(), purpose: 'INTERNAL' }).personalizations[0].custom_args, { hon_delivery_id: request().deliveryId, hon_purpose: 'INTERNAL' });
  assert.deepEqual(live.requestBody({ ...request(), purpose: 'HQ' }).personalizations[0].custom_args, { hon_delivery_id: request().deliveryId, hon_purpose: 'HQ' });
});

test('SendGrid outcomes: sandbox 200, rate limit, auth, rejection, server error and network failures', async () => {
  const run = (response, env = approved()) => new SendGridEmailProvider(() => env, async () => { if (response instanceof Error) throw response; return response; }).send(request());
  assert.deepEqual(await run(reply(200)), { providerMessageId: `sandbox-${request().deliveryId}-1`, sentAs: 'EMAIL' });
  await assert.rejects(run(reply(202), approved({ HON_EMAIL_SANDBOX_MODE: 'false' })), isErr('UNKNOWN', 'PROVIDER_UNKNOWN'));
  await assert.rejects(run(reply(429, { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 120) })), (e) => isErr('RETRYABLE', 'PROVIDER_FAILED')(e) && e.retryAfterSeconds >= 119);
  await assert.rejects(run(reply(401)), (e) => isErr('RETRYABLE', 'PROVIDER_FAILED')(e) && e.retryAfterSeconds === 900);
  await assert.rejects(run(reply(400)), isErr('FAILED', 'PROVIDER_REJECTED'));
  await assert.rejects(run(reply(500)), isErr('UNKNOWN', 'PROVIDER_UNKNOWN'));
  await assert.rejects(run(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), isErr('RETRYABLE', 'PROVIDER_FAILED'));
  await assert.rejects(run(Object.assign(new Error('aborted'), { name: 'TimeoutError' })), isErr('UNKNOWN', 'PROVIDER_UNKNOWN'));
  let calls = 0;
  await assert.rejects(new SendGridEmailProvider(() => approved(), async () => { calls += 1; return reply(202); }).send(request({ recipientAddress: 'bad address' })), isErr('FAILED', 'INVALID_ADDRESS'));
  assert.equal(calls, 0);
});

const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const now = 1_800_000_000_000;
function signed(events, { timestamp = String(Math.floor(now / 1000)), key = keys.privateKey } = {}) {
  const body = Buffer.from(JSON.stringify(events));
  return { body, timestamp, signature: sign('sha256', Buffer.concat([Buffer.from(timestamp), body]), { key, dsaEncoding: 'der' }).toString('base64') };
}
const verifier = (env = { SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: publicKey }) => new SendGridEventWebhookVerifier(() => env, () => now);
const delivery = '11111111-1111-4111-8111-111111111111';
const event = (over = {}) => ({ email: 'ada@example.test', timestamp: Math.floor(now / 1000) - 5, event: 'delivered', sg_event_id: 'evt-1', sg_message_id: 'abcDEF123.filterdrecv-1.2', hon_delivery_id: delivery, ...over });

test('SendGrid signed webhook: valid signature maps HON events, drops opens, clicks and mail HON did not send', () => {
  const batch = [event(), event({ event: 'open', sg_event_id: 'e2' }), event({ event: 'click', sg_event_id: 'e3' }), event({ hon_delivery_id: undefined, sg_event_id: 'e4' }),
    event({ event: 'bounce', sg_event_id: 'e5' }), event({ event: 'group_unsubscribe', sg_event_id: 'e6' }), event({ event: 'spamreport', sg_event_id: 'e7' }), event({ event: 'processed', sg_event_id: 'e8' })];
  const { body, signature, timestamp } = signed(batch);
  const receipts = verifier().verify(body, signature, timestamp);
  assert.deepEqual(receipts.map((r) => r.eventType), ['DELIVERED', 'BOUNCED', 'UNSUBSCRIBED', 'SPAM_REPORT', 'SENT']);
  assert.deepEqual(receipts[0], { provider: 'SENDGRID', providerEventId: 'evt-1', providerMessageId: 'abcDEF123', honDeliveryId: delivery, eventType: 'DELIVERED', occurredAt: new Date((Math.floor(now / 1000) - 5) * 1000).toISOString() });
  assert.equal(JSON.stringify(receipts).includes('ada@example.test'), false);
});

test('SendGrid signed webhook acknowledges and ignores internal and unknown-purpose mail; HQ mail comes back marked scope HQ', () => {
  const batch = [event({ hon_purpose: 'INTERNAL', sg_event_id: 'i1' }), event({ hon_purpose: 'HQ', sg_event_id: 'i2' }), event({ hon_purpose: 'SOMETHING_NEW', sg_event_id: 'i3' }),
    event({ hon_purpose: 'SCHOOL', sg_event_id: 'i4' }), event({ sg_event_id: 'i5' }), event({ hon_purpose: 'hq', sg_event_id: 'i6' })];
  const { body, signature, timestamp } = signed(batch);
  const receipts = verifier().verify(body, signature, timestamp);
  assert.deepEqual(receipts.map((r) => [r.providerEventId, r.scope]), [['i2', 'HQ'], ['i4', undefined], ['i5', undefined]]);
});

const hqRequest = (over = {}) => request({ origin: 'HQ', senderEmail: 'support@hon.example', senderName: 'HON "Support"\r\n', hqPurpose: 'SUPPORT', ...over });

test('SendGrid HQ send: HQ sender address and name, hon_purpose HQ, unsubscribe bypass only for billing and account notices', async () => {
  const adapter = new SendGridEmailProvider(() => approved());
  assert.equal(adapter.hqSender, true);
  const body = adapter.requestBody(hqRequest());
  assert.deepEqual(body.from, { email: 'support@hon.example', name: 'HON  Support' });
  assert.equal(body.subject, 'A message from HON  Support');
  assert.deepEqual(body.personalizations[0].custom_args, { hon_delivery_id: request().deliveryId, hon_purpose: 'HQ' });
  assert.deepEqual(body.mail_settings, { sandbox_mode: { enable: true } });
  assert.deepEqual(body.tracking_settings.subscription_tracking, { enable: true });
  for (const hqPurpose of ['BILLING', 'ACCOUNT']) {
    assert.deepEqual(adapter.requestBody(hqRequest({ hqPurpose })).mail_settings, { sandbox_mode: { enable: true }, bypass_unsubscribe_management: { enable: true } });
  }
  for (const hqPurpose of ['SUPPORT', 'ONBOARDING', undefined]) assert.equal(adapter.requestBody(hqRequest({ hqPurpose })).mail_settings.bypass_unsubscribe_management, undefined);
  // A school send never gets the bypass, whatever an hqPurpose field says.
  assert.equal(adapter.requestBody(request({ hqPurpose: 'BILLING' })).mail_settings.bypass_unsubscribe_management, undefined);
  assert.equal(adapter.requestBody(hqRequest({ senderName: '' })).from.name, 'HON OS');
  let calls = 0;
  const counting = new SendGridEmailProvider(() => approved(), async () => { calls += 1; return reply(202, { 'x-message-id': 'abc' }); });
  for (const senderEmail of [undefined, '', 'not an address']) {
    await assert.rejects(counting.send(hqRequest({ senderEmail })), (e) => isErr('RETRYABLE', 'PROVIDER_FAILED')(e) && e.retryAfterSeconds === 900);
  }
  assert.equal(calls, 0);
  let seen;
  await new SendGridEmailProvider(() => approved(), async (_url, init) => { seen = JSON.parse(init.body); return reply(202, { 'x-message-id': 'abc' }); }).send(hqRequest());
  assert.equal(seen.from.email, 'support@hon.example');
});

test('SendGrid webhook route: school receipts reach school deliveries, HQ receipts reach HQ deliveries', async () => {
  const { CommunicationWebhookController } = require('../dist/communication/delivery/communication-webhook.controller.js');
  const { TwilioWebhookVerifier } = require('../dist/communication/delivery/twilio-text-provider.js');
  const recorder = (outcome = 'RECORDED') => { const seen = []; return { seen, isConfigured: () => true, recordReceipt: async (r) => { seen.push(r.providerEventId); return { outcome }; } }; };
  const batch = [event({ sg_event_id: 's1' }), event({ hon_purpose: 'HQ', sg_event_id: 'h1' }), event({ hon_purpose: 'HQ', sg_event_id: 'h2', event: 'bounce' }), event({ event: 'open', sg_event_id: 'o1' })];
  const { body, signature, timestamp } = signed(batch);
  const school = recorder();
  const hq = recorder();
  const controller = new CommunicationWebhookController(school, verifier(), new TwilioWebhookVerifier(() => ({})), undefined, hq);
  assert.deepEqual(await controller.sendgridEvents({ body }, signature, timestamp), { received: true, recorded: 3, replayed: 0, ignored: 1 });
  assert.deepEqual(school.seen, ['s1']);
  assert.deepEqual(hq.seen, ['h1', 'h2']);
  // An HQ-only batch never touches the school store; a missing or unconfigured HQ store asks SendGrid to redeliver.
  const hqOnly = signed([event({ hon_purpose: 'HQ', sg_event_id: 'h3' })]);
  const untouched = recorder();
  const hq2 = recorder();
  await new CommunicationWebhookController(untouched, verifier(), new TwilioWebhookVerifier(() => ({})), undefined, hq2).sendgridEvents({ body: hqOnly.body }, hqOnly.signature, hqOnly.timestamp);
  assert.deepEqual([untouched.seen, hq2.seen], [[], ['h3']]);
  await assert.rejects(new CommunicationWebhookController(recorder(), verifier(), new TwilioWebhookVerifier(() => ({}))).sendgridEvents({ body: hqOnly.body }, hqOnly.signature, hqOnly.timestamp),
    (e) => e.getStatus() === 503);
  await assert.rejects(new CommunicationWebhookController(recorder(), verifier(), new TwilioWebhookVerifier(() => ({})), undefined, { isConfigured: () => true })
    .sendgridEvents({ body: hqOnly.body }, hqOnly.signature, hqOnly.timestamp), (e) => e.getStatus() === 503);
  // An HQ receipt whose send result is not committed yet is UNMATCHED: SendGrid retries the batch.
  await assert.rejects(new CommunicationWebhookController(recorder(), verifier(), new TwilioWebhookVerifier(() => ({})), undefined, recorder('UNMATCHED'))
    .sendgridEvents({ body: hqOnly.body }, hqOnly.signature, hqOnly.timestamp), (e) => e.getStatus() === 503);
  // A batch with nothing usable still answers through the school store, as before.
  const opens = signed([event({ event: 'open', sg_event_id: 'o2' })]);
  assert.deepEqual(await new CommunicationWebhookController(recorder(), verifier(), new TwilioWebhookVerifier(() => ({}))).sendgridEvents({ body: opens.body }, opens.signature, opens.timestamp),
    { received: true, recorded: 0, replayed: 0, ignored: 1 });
});

test('SendGrid signed webhook refuses a tampered body, another key, a stale timestamp, a missing key and malformed JSON', () => {
  const good = signed([event()]);
  const reason = (fn) => { try { fn(); } catch (error) { return error instanceof SendGridWebhookError ? error.reason : error.message; } return 'accepted'; };
  assert.equal(reason(() => verifier().verify(Buffer.from(good.body.toString().replace('delivered', 'bounce')), good.signature, good.timestamp)), 'SIGNATURE_INVALID');
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const forged = signed([event()], { key: other.privateKey });
  assert.equal(reason(() => verifier().verify(forged.body, forged.signature, forged.timestamp)), 'SIGNATURE_INVALID');
  const stale = signed([event()], { timestamp: String(Math.floor(now / 1000) - 3600) });
  assert.equal(reason(() => verifier().verify(stale.body, stale.signature, stale.timestamp)), 'TIMESTAMP_OUT_OF_RANGE');
  assert.equal(reason(() => verifier().verify(good.body, undefined, good.timestamp)), 'SIGNATURE_INVALID');
  assert.equal(reason(() => verifier({}).verify(good.body, good.signature, good.timestamp)), 'NOT_CONFIGURED');
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  assert.equal(reason(() => verifier({ SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: rsa }).verify(good.body, good.signature, good.timestamp)), 'NOT_CONFIGURED');
  const text = Buffer.from('{"not":"an array"}');
  const ts = String(Math.floor(now / 1000));
  const sig = sign('sha256', Buffer.concat([Buffer.from(ts), text]), { key: keys.privateKey, dsaEncoding: 'der' }).toString('base64');
  assert.equal(reason(() => verifier().verify(text, sig, ts)), 'MALFORMED');
});

test('receipt ingest: replays counted, invalid single events dropped, unmatched or database trouble asks for redelivery', async () => {
  const receipt = { provider: 'SENDGRID', providerEventId: 'e', providerMessageId: 'm', eventType: 'DELIVERED', occurredAt: new Date().toISOString() };
  const store = (results) => ({ isConfigured: () => true, recordReceipt: async () => { const next = results.shift(); if (next instanceof Error) throw next; return next; } });
  assert.deepEqual(await ingestReceipts(store([{ outcome: 'RECORDED' }, { outcome: 'REPLAYED' }, Object.assign(new Error('range'), { code: '22023' })]), [receipt, receipt, receipt], 2),
    { received: true, recorded: 1, replayed: 1, ignored: 3 });
  await assert.rejects(ingestReceipts(store([{ outcome: 'UNMATCHED' }]), [receipt], 0), (e) => e.getStatus() === 503);
  await assert.rejects(ingestReceipts(store([Object.assign(new Error('conn'), { code: '08006' })]), [receipt], 0), (e) => e.getStatus() === 503);
  await assert.rejects(ingestReceipts({ isConfigured: () => false }, [receipt], 0), (e) => e.getStatus() === 503);
});

test('webhook transport accepts only a bare JSON POST to a known provider path', async () => {
  const transport = communicationWebhookTransport();
  const call = (req) => new Promise((resolve) => {
    const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; }, json(body) { resolve({ status: this.statusCode, body }); } };
    transport({ path: '/v1/communications/webhooks/sendgrid', method: 'POST', originalUrl: '/v1/communications/webhooks/sendgrid', headers: { 'content-type': 'application/json' }, ...req }, res, () => resolve({ next: true }));
  });
  assert.deepEqual(await call({ path: '/v1/other' }), { next: true });
  for (const req of [{ method: 'GET' }, { originalUrl: '/v1/communications/webhooks/sendgrid?x=1' }, { headers: { 'content-type': 'application/json', cookie: 'a=b' } },
    { headers: { 'content-type': 'text/plain' } }, { path: '/v1/communications/webhooks/unknown' }, { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }]) {
    assert.equal((await call(req)).status, 400);
  }
});
