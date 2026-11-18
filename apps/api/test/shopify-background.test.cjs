const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const http = require('node:http');
const express = require('express');
const adapter = require('../dist/commerce/shopify/shopify-adapter.js');
const webhook = require('../dist/commerce/shopify/shopify-webhook.js');
const worker = require('../dist/commerce/shopify/shopify-worker.js');
const { ShopifyWebhookController } = require('../dist/commerce/shopify/shopify-webhook.controller.js');
const { ShopifyService } = require('../dist/commerce/shopify/shopify.service.js');

// 0449 SH1b: signed webhooks and background sync. Local only: the fake store and stub stores. Nothing calls Shopify.
const SHOP = 'ima-test.myshopify.com';
const SCHOOL = '11111111-1111-4111-8111-111111111111';
const CONN = '22222222-2222-4222-8222-222222222222';
const SECRET = 's'.repeat(40);

test('0449 webhook signature: Shopify rule (base64 HMAC-SHA256 of the raw body), every refusal', () => {
  const fake = new adapter.FakeShopify('app', SECRET);
  const d = fake.webhook('products/update', SHOP, 'b54557e4-bdd9-4b37-8a5f-bf7d70bcd043', Date.UTC(2026, 10, 16, 12));
  assert.equal(d.headers['x-shopify-hmac-sha256'], createHmac('sha256', SECRET).update(d.body).digest('base64'));
  assert.deepEqual(webhook.verifyShopifyWebhook(d.body, d.headers, SECRET), { kind: 'VERIFIED', webhook: {
    webhookId: 'b54557e4-bdd9-4b37-8a5f-bf7d70bcd043', topic: 'products/update', shopDomain: SHOP, triggeredAt: '2026-11-16T12:00:00.000Z' } });
  const h = change => ({ ...d.headers, ...change });
  for (const [why, body, headers, secret] of [
    ['wrong secret', d.body, d.headers, 'x'.repeat(40)],
    ['changed body', Buffer.concat([d.body, Buffer.from(' ')]), d.headers, SECRET],
    ['empty secret', d.body, d.headers, ''],
    ['empty body', Buffer.alloc(0), d.headers, SECRET],
    ['no signature', d.body, h({ 'x-shopify-hmac-sha256': undefined }), SECRET],
    ['hex signature', d.body, h({ 'x-shopify-hmac-sha256': createHmac('sha256', SECRET).update(d.body).digest('hex') }), SECRET],
    ['no delivery id', d.body, h({ 'x-shopify-webhook-id': undefined }), SECRET],
    ['bad delivery id', d.body, h({ 'x-shopify-webhook-id': 'a b' }), SECRET],
    ['custom domain', d.body, h({ 'x-shopify-shop-domain': 'shop.example.com' }), SECRET],
    ['no topic', d.body, h({ 'x-shopify-topic': undefined }), SECRET],
    ['repeated header', d.body, h({ 'x-shopify-topic': ['products/update', 'app/uninstalled'] }), SECRET],
  ]) assert.deepEqual(webhook.verifyShopifyWebhook(body, headers, secret), { kind: 'REFUSED' }, why);
  assert.deepEqual(webhook.verifyShopifyWebhook(d.body, h({ 'x-shopify-topic': 'themes/publish' }), SECRET), { kind: 'UNKNOWN_TOPIC' });
  const noTime = webhook.verifyShopifyWebhook(d.body, h({ 'x-shopify-triggered-at': 'yesterday' }), SECRET);
  assert.equal(noTime.webhook.triggeredAt, null);
  assert.deepEqual([...webhook.SHOPIFY_WEBHOOK_TOPICS].filter(t => /redact|data_request/.test(t)), ['shop/redact', 'customers/redact', 'customers/data_request']);
});

function serve(handler) {
  const app = express();
  app.use(webhook.shopifyWebhookTransport());
  app.post('/v1/commerce/webhooks/shopify', (req, res) => res.json({ bytes: Buffer.isBuffer(req.body) ? req.body.length : -1 }));
  app.use(handler ?? ((req, res) => res.status(404).json({ next: true })));
  return new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
}
function send(server, { method = 'POST', path = '/v1/commerce/webhooks/shopify', headers = { 'content-type': 'application/json' }, body = '{"a":1}' } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => { let t = ''; res.on('data', c => t += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(t || '{}'), headers: res.headers })); });
    req.on('error', reject); req.end(body);
  });
}

test('0449 webhook transport keeps the exact bytes and refuses anything but a plain JSON POST to the one path', async () => {
  const server = await serve();
  try {
    const ok = await send(server);
    assert.deepEqual([ok.status, ok.body.bytes, ok.headers['cache-control']], [200, 7, 'no-store']);
    for (const [why, r] of [
      ['GET', { method: 'GET', body: undefined }],
      ['query', { path: '/v1/commerce/webhooks/shopify?x=1' }],
      ['other path', { path: '/v1/commerce/webhooks/other' }],
      ['cookie', { headers: { 'content-type': 'application/json', cookie: 'a=b' } }],
      ['authorization', { headers: { 'content-type': 'application/json', authorization: 'Bearer x' } }],
      ['form', { headers: { 'content-type': 'application/x-www-form-urlencoded' } }],
      ['compressed', { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }],
      ['empty', { body: '' }],
    ]) assert.equal((await send(server, r)).status, 400, why);
    assert.deepEqual((await send(server, { path: '/v1/payments/webhooks/stripe' })).body, { next: true }, 'other paths pass through untouched');
  } finally { server.close(); }
});

function store(over = {}) {
  const calls = [];
  return { calls, configured: true, isConfigured() { return this.configured; },
    async recordWebhook(input) { calls.push(['recordWebhook', input]); if (over.recordWebhook) return over.recordWebhook(input); return { outcome: 'SYNC_REQUESTED', replayed: false }; },
    async claim() { calls.push(['claim']); return over.claim ? over.claim() : null; },
    async rotate(input) { calls.push(['rotate', input]); return over.rotate ? over.rotate(input) : { version: 2 }; },
    async page(input) { calls.push(['page', input]); return {}; },
    async finish(input) { calls.push(['finish', input]); return over.finish ? over.finish(input)
      : { syncId: input.syncId, source: 'SCHEDULED', outcome: input.outcome, failureCode: input.failureCode, connectionStatus: input.outcome === 'NEEDS_RECONNECT' ? 'NEEDS_RECONNECT' : 'CONNECTED' }; },
    async purgeExpiredOrders() { calls.push(['purge']); return over.purge ? over.purge() : { orders: 0, lines: 0, more: false }; },
  };
}
const fakeApp = () => { const app = adapter.shopifyAppFromEnvironment({ HON_SHOPIFY_FAKE: '1' }); return app; };

test('0449 webhook endpoint: 401 on a bad signature, 200 after recording, 503 to be delivered again; only verified fields reach the database', async () => {
  const app = fakeApp(), s = store(), c = new ShopifyWebhookController(s, app);
  const d = app.fake.webhook('orders/create', SHOP, 'w-1');
  assert.deepEqual(await c.receive({ body: d.body, headers: d.headers }), { received: true, outcome: 'SYNC_REQUESTED', replayed: false });
  assert.deepEqual(s.calls, [['recordWebhook', { webhookId: 'w-1', topic: 'orders/create', shopDomain: SHOP, triggeredAt: d.headers['x-shopify-triggered-at'] }]]);
  await assert.rejects(c.receive({ body: d.body, headers: { ...d.headers, 'x-shopify-hmac-sha256': 'A'.repeat(43) + '=' } }), e => e.getStatus() === 401);
  assert.equal(s.calls.length, 1, 'a bad signature never reaches the database');
  const other = app.fake.webhook('themes/publish', SHOP);
  assert.deepEqual(await c.receive({ body: other.body, headers: other.headers }), { received: true, outcome: 'IGNORED', replayed: false });
  assert.equal(s.calls.length, 1);
  await assert.rejects(new ShopifyWebhookController(s, null).receive({ body: d.body, headers: d.headers }), e => e.getStatus() === 503);
  s.configured = false;
  await assert.rejects(c.receive({ body: d.body, headers: d.headers }), e => e.getStatus() === 503);
  const bad = Object.assign(new Error('SHOPIFY_INVALID'), { code: '22023' }), down = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
  assert.deepEqual(await new ShopifyWebhookController(store({ recordWebhook: () => { throw bad; } }), app).receive({ body: d.body, headers: d.headers }),
    { received: true, outcome: 'IGNORED', replayed: false });
  await assert.rejects(new ShopifyWebhookController(store({ recordWebhook: () => { throw down; } }), app).receive({ body: d.body, headers: d.headers }),
    e => e.getStatus() === 503 && e.response.code === 'SHOPIFY_WEBHOOK_RETRY' && !JSON.stringify(e.response).includes('refused'));
});

async function claimFor(app, now, { expiresInMs = 3600_000 } = {}) {
  // A sealed pair as the connect step would have stored it, issued by the fake for this shop.
  const tokens = await app.adapter.exchangeCode(SHOP, new URLSearchParams(app.fake.approve(SHOP, 'A'.repeat(43), now)).get('code'));
  const pair = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, accessExpiresAt: new Date(now + expiresInMs).toISOString(), refreshExpiresAt: tokens.refreshExpiresAt };
  return { syncId: 'y1', leaseToken: 'l1', source: 'WEBHOOK', schoolId: SCHOOL, connectionId: CONN, shopDomain: SHOP,
    credential: { keyId: app.vault.keyId, sealed: app.vault.seal({ connectionId: CONN, shopDomain: SHOP }, pair), version: 1, accessExpiresAt: pair.accessExpiresAt, refreshExpiresAt: pair.refreshExpiresAt } };
}

test('0449 background sync: claims due stores, writes every page under the lease, refreshes near expiry, stops when nothing is due', async () => {
  let now = Date.UTC(2026, 10, 16, 12);
  const app = fakeApp(); app.fake.now = () => now;
  const first = await claimFor(app, now, { expiresInMs: 60_000 });
  let claims = [first];
  const s = store({ claim: () => claims.shift() ?? null });
  const sync = new worker.ShopifyBackgroundSync(s, app, () => now);
  assert.deepEqual(await sync.runOnce(), { claimed: 1, succeeded: 1, failed: 0, needsReconnect: 0, errors: 0, purgedOrders: 0 });
  assert.deepEqual(s.calls.map(c => c[0]), ['purge', 'claim', 'rotate', 'page', 'page', 'finish', 'claim']);
  for (const [op, input] of s.calls.slice(2, 6)) { assert.equal(input.syncId, 'y1', op); assert.equal(input.leaseToken, 'l1', op); assert.equal('schoolId' in input, false, op); }
  assert.equal(s.calls[2][1].expectedVersion, 1);
  assert.equal(/fake_(at|rt)_/.test(JSON.stringify(s.calls)), false, 'no token value ever reaches the database in clear');
  assert.deepEqual(s.calls[5][1], { syncId: 'y1', leaseToken: 'l1', outcome: 'SUCCEEDED', failureCode: null });

  // Shopify refusing the token ends as Needs reconnect; a broken answer counts as an error and never throws.
  app.fake.rejectTokens(SHOP);
  claims = [await claimFor(app, now)];
  assert.deepEqual(await sync.runOnce(), { claimed: 1, succeeded: 0, failed: 0, needsReconnect: 1, errors: 0, purgedOrders: 0 });
  claims = [{ syncId: 'y2' }];
  assert.deepEqual(await sync.runOnce(), { claimed: 1, succeeded: 0, failed: 0, needsReconnect: 0, errors: 1, purgedOrders: 0 });
  app.fake.rejectTokens(SHOP, false);
  const lying = new worker.ShopifyBackgroundSync(store({ claim: (() => { let n = 0; return () => (n++ ? null : first); })(), finish: () => ({ syncId: 'other', outcome: 'SUCCEEDED' }) }), app, () => now);
  assert.equal((await lying.runOnce()).errors, 1);
  // At most `limit` stores per run.
  const many = store({ claim: () => ({ syncId: 'y', leaseToken: 'l' }) });
  assert.equal((await new worker.ShopifyBackgroundSync(many, app, () => now).runOnce(3)).claimed, 3);
  // Off without the app or the worker login.
  const off = store({ claim: () => { throw new Error('never'); } });
  assert.equal((await new worker.ShopifyBackgroundSync(off, null).runOnce()).claimed, 0);
  off.configured = false;
  assert.equal((await new worker.ShopifyBackgroundSync(off, app).runOnce()).claimed, 0);
});

test('0470 background run deletes expired orders first, in at most five batches, and a failure never stops the syncs', async () => {
  const app = fakeApp();
  let left = 3;
  const s = store({ purge: () => { left -= 1; return { orders: 2000, lines: 4000, more: left > 0 }; } });
  assert.deepEqual(await new worker.ShopifyBackgroundSync(s, app).runOnce(), { claimed: 0, succeeded: 0, failed: 0, needsReconnect: 0, errors: 0, purgedOrders: 6000 });
  assert.deepEqual(s.calls.map(c => c[0]), ['purge', 'purge', 'purge', 'claim']);
  const endless = store({ purge: () => ({ orders: 2000, lines: 0, more: true }) });
  assert.equal((await new worker.ShopifyBackgroundSync(endless, app).runOnce()).purgedOrders, 10000);
  assert.equal(endless.calls.filter(c => c[0] === 'purge').length, 5);
  const broken = store({ purge: () => { throw new Error('down'); }, claim: (() => { let n = 0; return () => (n++ ? null : { syncId: 'y9' }); })() });
  const r = await new worker.ShopifyBackgroundSync(broken, app).runOnce();
  assert.deepEqual([r.errors, r.claimed], [2, 1], 'the purge error and the bad claim are both counted; the claim still ran');
  // The SQL store refuses a malformed answer.
  const sql = new worker.ShopifyWorkerSql(async () => [{ data: { orders: '1', lines: 0, more: false } }]);
  await assert.rejects(sql.purgeExpiredOrders(), /SHOPIFY_WORKER_ANSWER_INVALID/);
  assert.deepEqual(await new worker.ShopifyWorkerSql(async (q) => { assert.equal(q, 'SELECT hon.purge_expired_shopify_orders() AS data'); return [{ data: { orders: 1, lines: 2, more: false } }]; }).purgeExpiredOrders(),
    { orders: 1, lines: 2, more: false });
});

test('0449 background sync is on only with the worker login and a valid poll interval; the page says so', async () => {
  const on = { HON_COMMUNICATION_WORKER_DATABASE_URL: 'postgresql://w@db/x', HON_SHOPIFY_SYNC_POLL_SECONDS: '60' };
  assert.equal(worker.shopifyBackgroundEnabled(on), true);
  for (const bad of [{}, { ...on, HON_COMMUNICATION_WORKER_DATABASE_URL: '' }, { ...on, HON_SHOPIFY_SYNC_POLL_SECONDS: '10' },
    { ...on, HON_SHOPIFY_SYNC_POLL_SECONDS: '4000' }, { ...on, HON_SHOPIFY_SYNC_POLL_SECONDS: 'soon' }]) assert.equal(worker.shopifyBackgroundEnabled(bad), false);
  const read = { schoolId: SCHOOL, canManage: true, connection: null, counts: null, summary: null };
  const db = { async callShopify() { return { ...read }; } };
  const saved = { ...process.env };
  try {
    Object.assign(process.env, on);
    assert.equal((await new ShopifyService(db, fakeApp()).overview({ honIdentity: { externalSubject: 'x' } }, SCHOOL)).autoSync, true);
    assert.equal((await new ShopifyService(db, null).overview({ honIdentity: { externalSubject: 'x' } }, SCHOOL)).autoSync, false, 'never without the app');
    delete process.env.HON_SHOPIFY_SYNC_POLL_SECONDS;
    assert.equal((await new ShopifyService(db, fakeApp()).overview({ honIdentity: { externalSubject: 'x' } }, SCHOOL)).autoSync, false);
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});
