const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const contracts = require('@hon/contracts');
const oauth = require('../dist/commerce/shopify/shopify-oauth.js');
const vaultModule = require('../dist/commerce/shopify/shopify-vault.js');
const adapter = require('../dist/commerce/shopify/shopify-adapter.js');
const { ShopifyService, translateShopifyError } = require('../dist/commerce/shopify/shopify.service.js');

// 0405 SH1 Shopify connection: everything here is local (the fake store and a stub database). Nothing calls Shopify.
const SHOP = 'ima-test.myshopify.com';
const SCHOOL = '11111111-1111-4111-8111-111111111111';
const CONN = '22222222-2222-4222-8222-222222222222';
const SECRET = 's'.repeat(40);

test('0405 callback signature: Shopify rule, every refusal', () => {
  const now = Date.UTC(2026, 10, 16, 12);
  const fake = new adapter.FakeShopify('app', SECRET);
  const state = 'A'.repeat(43);
  const query = fake.approve(SHOP, state, now);
  const ok = oauth.verifyShopifyCallback(query, SECRET, now);
  assert.equal(ok.shop, SHOP); assert.equal(ok.state, state); assert.match(ok.code, /^[0-9a-f]{32}$/);
  const params = new URLSearchParams(query);
  const variant = mutate => { const p = new URLSearchParams(params); mutate(p); return p.toString(); };
  for (const [why, bad] of [
    ['wrong secret', [query, 'x'.repeat(40), now]],
    ['too late', [query, SECRET, now + 601_000]],
    ['too early', [query, SECRET, now - 601_000]],
    ['changed shop', [variant(p => p.set('shop', 'other.myshopify.com')), SECRET, now]],
    ['changed state', [variant(p => p.set('state', 'B'.repeat(43))), SECRET, now]],
    ['duplicate', [query + '&shop=' + SHOP, SECRET, now]],
    ['unknown parameter', [variant(p => p.set('extra', '1')), SECRET, now]],
    ['no signature', [variant(p => p.delete('hmac')), SECRET, now]],
    ['custom domain', [variant(p => p.set('shop', 'shop.example.com')), SECRET, now]],
    ['empty secret', [query, '', now]],
  ]) assert.equal(oauth.verifyShopifyCallback(...bad), null, why);
  // The signature is Shopify's documented one: hex HMAC-SHA256 of the sorted name=value pairs without hmac.
  const sorted = [...params.entries()].filter(([k]) => k !== 'hmac').sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  assert.equal(params.get('hmac'), require('node:crypto').createHmac('sha256', SECRET).update(sorted).digest('hex'));
});

test('0405 authorize URL, scopes and shop names', () => {
  const url = new URL(oauth.shopifyAuthorizeUrl({ shop: SHOP, clientId: 'cid', scopes: contracts.SHOPIFY_SCOPES, redirectUri: 'https://app.hon.test/staff/billing/shopify/return', state: 'S' }));
  assert.equal(url.origin + url.pathname, `https://${SHOP}/admin/oauth/authorize`);
  assert.equal(url.searchParams.get('scope'), 'read_products,read_inventory,read_orders');
  assert.equal(url.searchParams.has('grant_options[]'), false, 'offline access only');
  assert.throws(() => oauth.shopifyAuthorizeUrl({ shop: 'evil.com', clientId: 'c', scopes: [], redirectUri: 'x', state: 's' }));
  assert.equal(oauth.scopesGranted(contracts.SHOPIFY_SCOPES, 'read_products,write_inventory,read_orders'), true);
  assert.equal(oauth.scopesGranted(contracts.SHOPIFY_SCOPES, 'read_products,read_orders'), false);
  assert.equal(contracts.normalizeShopDomain('IMA-Test'), SHOP);
  assert.equal(contracts.normalizeShopDomain('https://ima-test.myshopify.com/admin'), SHOP);
  for (const bad of ['', 'shop.example.com', 'a.myshopify.com.evil.com', 'https://x.myshopify.com@evil.com', '-bad', 7]) assert.equal(contracts.normalizeShopDomain(bad), null, String(bad));
});

test('0405 vault: sealed pair opens only for the same connection, shop and key', () => {
  const vault = vaultModule.ephemeralShopifyVault();
  const pair = { accessToken: 'shpat_x', refreshToken: 'shprt_y', accessExpiresAt: '2026-11-16T13:00:00.000Z', refreshExpiresAt: '2027-02-14T12:00:00.000Z' };
  const binding = { connectionId: CONN, shopDomain: SHOP };
  const sealed = vault.seal(binding, pair);
  assert.equal(sealed.includes('shpat_x'), false);
  assert.deepEqual(vault.open(binding, vault.keyId, sealed), pair);
  assert.notEqual(vault.seal(binding, pair), sealed, 'fresh IV each time');
  assert.throws(() => vault.open({ connectionId: '33333333-3333-4333-8333-333333333333', shopDomain: SHOP }, vault.keyId, sealed), /SHOPIFY_VAULT_REFUSED/);
  assert.throws(() => vault.open({ connectionId: CONN, shopDomain: 'other.myshopify.com' }, vault.keyId, sealed), /SHOPIFY_VAULT_REFUSED/);
  assert.throws(() => vault.open(binding, 'other-key', sealed), /SHOPIFY_VAULT_REFUSED/);
  assert.throws(() => vaultModule.ephemeralShopifyVault().open(binding, 'fake-ephemeral', sealed), /SHOPIFY_VAULT_REFUSED/);
  const parts = sealed.split('.'); parts[2] = parts[2].slice(0, -2) + (parts[2].endsWith('AA') ? 'AB' : 'AA');
  assert.throws(() => vault.open(binding, vault.keyId, parts.join('.')), /SHOPIFY_VAULT_REFUSED/);
  assert.throws(() => vault.seal(binding, { ...pair, extra: 1 }), /SHOPIFY_VAULT_REFUSED/);
  assert.equal(vaultModule.shopifyVaultFromEnvironment({ HON_SHOPIFY_VAULT_KEY: 'short', HON_SHOPIFY_VAULT_KEY_ID: 'k1' }), null);
  assert.ok(vaultModule.shopifyVaultFromEnvironment({ HON_SHOPIFY_VAULT_KEY: Buffer.alloc(32, 7).toString('base64'), HON_SHOPIFY_VAULT_KEY_ID: 'k1' }));
});

test('0405 the app is off unless approved; the fake never runs in production or staging', () => {
  assert.equal(adapter.shopifyAppFromEnvironment({}), null);
  const real = { SHOPIFY_API_KEY: 'a'.repeat(32), SHOPIFY_API_SECRET: 'b'.repeat(40), HON_SHOPIFY_VAULT_KEY: Buffer.alloc(32, 1).toString('base64'), HON_SHOPIFY_VAULT_KEY_ID: 'k1' };
  assert.equal(adapter.shopifyAppFromEnvironment(real), null, 'needs HON_SHOPIFY_CONNECT_APPROVED');
  assert.equal(adapter.shopifyAppFromEnvironment({ ...real, HON_SHOPIFY_CONNECT_APPROVED: 'true' }).adapter.kind, 'SHOPIFY');
  assert.equal(adapter.shopifyAppFromEnvironment({ ...real, HON_SHOPIFY_CONNECT_APPROVED: 'true', SHOPIFY_API_SECRET: 'short' }), null);
  assert.equal(adapter.shopifyAppFromEnvironment({ HON_SHOPIFY_FAKE: '1' }).adapter.kind, 'FAKE');
  for (const env of [{ HON_DEPLOYMENT_ENVIRONMENT: 'production' }, { HON_DEPLOYMENT_ENVIRONMENT: 'staging' }, { NODE_ENV: 'production' }]) {
    assert.equal(adapter.shopifyAppFromEnvironment({ HON_SHOPIFY_FAKE: '1', ...env }), null, JSON.stringify(env));
  }
});

test('0405 Shopify answers are parsed into bounded mirror rows', () => {
  const node = (id, pid, extra = {}) => ({ id: `gid://shopify/ProductVariant/${id}`, title: 'M', sku: ' SKU\u0007 ', barcode: null, price: '12.5', compareAtPrice: null,
    inventoryQuantity: 4, position: extra.position ?? 1, inventoryItem: { tracked: true, unitCost: { amount: '5.25' } },
    product: { id: `gid://shopify/Product/${pid}`, title: 'Gi', status: 'ACTIVE', vendor: null, productType: '', handle: 'gi',
      featuredMedia: { preview: { image: { url: extra.url ?? 'https://cdn.shopify.com/s/files/gi.png' } } } } });
  const products = adapter.productsFromVariantNodes([node(2, 1, { position: 2 }), node(1, 1, { position: 1 }), node(3, 9, { url: 'https://evil.example/x.png' })]);
  assert.equal(products.length, 2);
  assert.deepEqual(products[0].variants.map(v => v.id), ['1', '2']);
  assert.equal(products[0].variants[0].sku, 'SKU'); assert.equal(products[0].variants[0].price, '12.5'); assert.equal(products[0].variants[0].unitCost, '5.25');
  assert.equal(products[0].productType, null);
  assert.equal(products[1].imageUrl, null, 'only Shopify CDN images');
  assert.throws(() => adapter.productsFromVariantNodes([{ ...node(1, 1), id: 'gid://shopify/Order/1' }]), adapter.ShopifyProviderError);
  assert.throws(() => adapter.productsFromVariantNodes([{ ...node(1, 1), price: '-1' }]), adapter.ShopifyProviderError);
  const order = adapter.orderFromNode({ id: 'gid://shopify/Order/77', name: '#1001', createdAt: '2026-11-15T10:00:00Z', cancelledAt: null, displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'FULFILLED', sourceName: 'web', subtotalPriceSet: { shopMoney: { amount: '20.0', currencyCode: 'USD' } },
    totalDiscountsSet: { shopMoney: { amount: '0.0' } }, totalTaxSet: null, totalPriceSet: { shopMoney: { amount: '21.5', currencyCode: 'USD' } },
    lineItems: { nodes: [{ title: 'Gi', sku: null, quantity: 2, variant: null, originalUnitPriceSet: { shopMoney: { amount: '10.0' } } }] } });
  assert.deepEqual({ id: order.id, placedAt: order.placedAt, tax: order.tax, total: order.total, line: order.lines[0] },
    { id: '77', placedAt: '2026-11-15T10:00:00.000Z', tax: '0', total: '21.5', line: { title: 'Gi', sku: null, variantId: null, quantity: 2, unitPrice: '10.0' } });
});

test('0405 GraphQL adapter: token form, retries, and errors that never carry Shopify text', async () => {
  const sent = [];
  const replies = [];
  const send = async (url, init) => { sent.push({ url, init }); const r = replies.shift(); return new Response(r.body, { status: r.status }); };
  const a = new adapter.GraphqlShopifyAdapter('cid', 'csecret', send, async () => undefined);
  replies.push({ status: 200, body: JSON.stringify({ access_token: 'shpat_1', refresh_token: 'shprt_1', scope: 'read_products,read_inventory,read_orders', expires_in: 3600, refresh_token_expires_in: 7776000 }) });
  const t = await a.exchangeCode(SHOP, 'code1');
  assert.equal(sent[0].url, `https://${SHOP}/admin/oauth/access_token`);
  assert.equal(sent[0].init.redirect, 'error');
  const form = new URLSearchParams(sent[0].init.body);
  assert.deepEqual(Object.fromEntries(form), { client_id: 'cid', client_secret: 'csecret', code: 'code1', expiring: '1' });
  assert.equal(t.accessToken, 'shpat_1');
  replies.push({ status: 400, body: '{"error":"invalid_grant shprt_1"}' });
  await assert.rejects(a.refresh(SHOP, 'shprt_1'), e => e instanceof adapter.ShopifyProviderError && e.message === 'AUTH');
  assert.equal(new URLSearchParams(sent[1].init.body).get('grant_type'), 'refresh_token');
  // 429, then THROTTLED, then the answer.
  replies.push({ status: 429, body: '' }, { status: 200, body: JSON.stringify({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }) },
    { status: 200, body: JSON.stringify({ data: { shop: { name: 'IMA', currencyCode: 'USD' } } }) });
  assert.deepEqual(await a.shopInfo(SHOP, 'shpat_1'), { name: 'IMA', currency: 'USD' });
  assert.equal(sent.at(-1).url, `https://${SHOP}/admin/api/2026-10/graphql.json`);
  assert.equal(sent.at(-1).init.headers['X-Shopify-Access-Token'], 'shpat_1');
  replies.push({ status: 401, body: 'token shpat_1 bad' });
  await assert.rejects(a.shopInfo(SHOP, 'shpat_1'), e => e.message === 'AUTH' && !String(e.stack).includes('shpat_1'));
  replies.push({ status: 500, body: 'oops' });
  await assert.rejects(a.shopInfo(SHOP, 'shpat_1'), e => e.message === 'UNAVAILABLE');
  await assert.rejects(a.shopInfo('evil.com', 'shpat_1'), e => e.message === 'INVALID_RESPONSE');
});

test('catalog read: when Shopify refuses the stock-location part, the sync reads the catalog without it', async () => {
  const sent = [], replies = [];
  const send = async (url, init) => { sent.push(JSON.parse(init.body)); const r = replies.shift(); return new Response(JSON.stringify(r), { status: 200 }); };
  const a = new adapter.GraphqlShopifyAdapter('cid', 'csecret', send, async () => undefined);
  const node = (id, extra) => ({ id: `gid://shopify/ProductVariant/${id}`, title: 'Default Title', sku: null, barcode: null, price: '10.00', compareAtPrice: null,
    inventoryQuantity: 3, position: 1, inventoryItem: { tracked: true, unitCost: null, ...extra },
    product: { id: `gid://shopify/Product/${id}0`, title: 'Belt ' + id, status: 'ACTIVE', vendor: '', productType: '', handle: 'belt-' + id, featuredMedia: null } });
  const denied = { errors: [{ message: 'Access denied for location field.', extensions: { code: 'ACCESS_DENIED' } }], data: { productVariants: null } };
  // Page 1 refused, read again plain; page 2 stays plain.
  replies.push(denied, { data: { productVariants: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [node(1, {})] } } },
    { data: { productVariants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node(2, {})] } } });
  const r = await a.catalog(SHOP, 'shpat_1');
  assert.equal(r.complete, true);
  assert.deepEqual(r.products.map(p => p.title), ['Belt 1', 'Belt 2']);
  assert.equal('fulfilledBy' in r.products[0].variants[0], false, 'not asked, so the mirror keeps what it had');
  assert.deepEqual(sent.map(b => [b.query.includes('inventoryLevels'), b.variables.after]), [[true, null], [false, null], [false, 'c1']]);
  // The full read still names the fulfilment service when Shopify answers it.
  sent.length = 0;
  replies.push({ data: { productVariants: { pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [node(3, { inventoryLevels: { nodes: [{ location: { fulfillmentService: { serviceName: 'Sample Print Co', type: 'THIRD_PARTY' } } }] } })] } } });
  assert.equal((await a.catalog(SHOP, 'shpat_1')).products[0].variants[0].fulfilledBy, 'Sample Print Co');
  assert.equal(sent.length, 1);
  // A plain read that is refused too fails the sync as before, and throttling is never treated as a refusal.
  replies.push(denied, denied);
  await assert.rejects(a.catalog(SHOP, 'shpat_1'), e => e.message === 'INVALID_RESPONSE');
  const throttled = { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] };
  sent.length = 0; replies.push(throttled, throttled, throttled, throttled);
  await assert.rejects(a.catalog(SHOP, 'shpat_1'), e => e.message === 'RATE_LIMITED');
  assert.equal(sent.every(b => b.query.includes('inventoryLevels')), true);
});

// ---- Service with the fake store and a stub database that records what it was given ----

function stubDatabase() {
  const calls = [];
  const state = { intents: new Map(), credential: null, connection: null, sync: null, products: 0, orders: 0, refuse: null };
  const connectionJson = () => ({ connectionId: CONN, shopDomain: SHOP, shopName: 'Ima Test', currency: 'USD', status: state.connection.status,
    version: state.connection.version, connectedAt: '2026-11-16T12:00:00.000Z', endedAt: state.connection.status === 'CONNECTED' ? null : '2026-11-16T12:30:00.000Z',
    lastSyncAt: null, lastSyncOutcome: state.connection.lastOutcome ?? null, syncRunning: false });
  const db = {
    calls, state,
    async callShopify(op, params) {
      calls.push({ op, params });
      if (state.refuse && state.refuse.op === op) { const e = new Error(state.refuse.message); e.code = state.refuse.code; throw e; }
      const input = params[1] && params[1].startsWith('{') ? JSON.parse(params[1]) : null;
      switch (op) {
        case 'start': state.intents.set(params[2], { shop: input.shopDomain }); return { intentId: 'i1', shopDomain: input.shopDomain, expiresAt: '2026-11-16T12:10:00.000Z' };
        case 'claim': { const i = state.intents.get(input.stateHash); if (!i || i.shop !== input.shopDomain) { const e = new Error('SHOPIFY_CONNECT_STATE_INVALID'); e.code = '22023'; throw e; }
          state.intents.delete(input.stateHash); return { intentId: 'i1', connectionId: CONN, shopDomain: input.shopDomain }; }
        case 'record': state.credential = { ...input.credential, version: 1 }; state.connection = { status: 'CONNECTED', version: 1 }; return { connection: connectionJson() };
        case 'beginSync': state.sync = 's1'; return { syncId: 's1', connectionId: CONN, shopDomain: SHOP, credential: { ...state.credential } };
        case 'rotate': assert.equal(input.expectedVersion, state.credential.version); state.credential = { ...input.credential, version: state.credential.version + 1 }; return { version: state.credential.version };
        case 'page': if (input.kind === 'PRODUCTS') state.products += input.products.length; else state.orders += input.orders.length; return {};
        case 'finishSync': state.connection.version += 1; state.connection.lastOutcome = input.outcome;
          if (input.outcome === 'NEEDS_RECONNECT') { state.connection.status = 'NEEDS_RECONNECT'; state.credential = null; }
          return { syncId: input.syncId, outcome: input.outcome, failureCode: input.failureCode, productsSeen: state.products, variantsSeen: 0, ordersSeen: state.orders,
            removedProducts: 0, removedVariants: 0, connection: connectionJson() };
        default: throw new Error('unexpected ' + op);
      }
    },
  };
  return db;
}

function setup() {
  process.env.HON_PUBLIC_ORIGIN = 'https://app.hon.test';
  let now = Date.UTC(2026, 10, 16, 12);
  const app = adapter.shopifyAppFromEnvironment({ HON_SHOPIFY_FAKE: '1' });
  app.fake.now = () => now;
  const db = stubDatabase();
  const service = new ShopifyService(db, app, () => now);
  const req = { honIdentity: { externalSubject: 'owner-1' } };
  return { app, db, service, req, tick: ms => { now += ms; } };
}

async function connect(s) {
  const started = await s.service.start(s.req, { schoolId: SCHOOL, shopDomain: 'IMA-Test' });
  const url = new URL(started.authorizeUrl);
  assert.equal(url.origin + url.pathname, 'https://app.hon.test/staff/billing/shopify/return');
  return s.service.complete(s.req, { schoolId: SCHOOL, query: url.search.slice(1) });
}

test('0405 connect: only the state hash reaches the database, tokens only sealed, first sync runs', async () => {
  const s = setup();
  const result = await connect(s);
  const start = s.db.calls.find(c => c.op === 'start');
  assert.equal(start.params[0], 'owner-1');
  assert.match(start.params[2], /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(start.params[1]), { schoolId: SCHOOL, shopDomain: SHOP });
  const everything = JSON.stringify(s.db.calls);
  assert.equal(/fake_(at|rt)_/.test(everything), false, 'no token value ever reaches the database in clear');
  assert.equal(result.firstSync.outcome, 'SUCCEEDED');
  assert.equal(s.db.state.products, 3);
  assert.equal(s.db.state.orders, 3, 'the fake has 3 orders in the last 60 days');
  assert.deepEqual(s.db.calls.map(c => c.op), ['start', 'claim', 'record', 'beginSync', 'page', 'page', 'finishSync']);
  const opened = s.app.vault.open({ connectionId: CONN, shopDomain: SHOP }, s.db.state.credential.keyId, s.db.state.credential.sealed);
  assert.match(opened.accessToken, /^fake_at_/);
  // The same approval cannot be used twice.
  const url = new URL((await s.service.start(s.req, { schoolId: SCHOOL, shopDomain: SHOP })).authorizeUrl);
  const query = url.search.slice(1);
  await s.service.complete(s.req, { schoolId: SCHOOL, query });
  await assert.rejects(s.service.complete(s.req, { schoolId: SCHOOL, query }), e => e.response?.code === 'SHOPIFY_CONNECT_STATE_INVALID');
});

test('0405 connect refusals: tampered query, connect off, bad input', async () => {
  const s = setup();
  const url = new URL((await s.service.start(s.req, { schoolId: SCHOOL, shopDomain: SHOP })).authorizeUrl);
  const p = new URLSearchParams(url.search); p.set('shop', 'other.myshopify.com');
  await assert.rejects(s.service.complete(s.req, { schoolId: SCHOOL, query: p.toString() }), e => e.response?.code === 'SHOPIFY_CONNECT_STATE_INVALID');
  assert.equal(s.db.calls.filter(c => c.op === 'claim').length, 0, 'a bad signature never reaches the database');
  const off = new ShopifyService(stubDatabase(), null);
  await assert.rejects(off.start(s.req, { schoolId: SCHOOL, shopDomain: SHOP }), e => e.getStatus() === 503 && e.response.code === 'SHOPIFY_CONNECT_OFF');
  await assert.rejects(s.service.start(s.req, { schoolId: SCHOOL, shopDomain: 'shop.example.com' }), e => e.getStatus() === 400);
  await assert.rejects(s.service.start(s.req, { schoolId: SCHOOL, shopDomain: SHOP, extra: 1 }), e => e.getStatus() === 400);
  await assert.rejects(s.service.sync({}, { schoolId: SCHOOL }), e => e.getStatus() === 403);
});

test('0405 sync: refresh near expiry rotates under version; Shopify refusal needs reconnect; unreadable credential needs reconnect', async () => {
  const s = setup();
  await connect(s);
  s.tick(58 * 60_000);
  const second = await s.service.sync(s.req, { schoolId: SCHOOL });
  assert.equal(second.outcome, 'SUCCEEDED');
  assert.ok(s.db.calls.some(c => c.op === 'rotate'), 'the token was refreshed and rotated');
  assert.ok(s.app.fake.calls.includes('refresh:' + SHOP));
  assert.equal(s.db.state.credential.version, 2);
  s.app.fake.rejectTokens(SHOP);
  const third = await s.service.sync(s.req, { schoolId: SCHOOL });
  assert.deepEqual([third.outcome, third.failureCode, third.connection.status], ['NEEDS_RECONNECT', 'TOKEN_REJECTED', 'NEEDS_RECONNECT']);

  const t = setup();
  await connect(t);
  t.db.state.credential = { ...t.db.state.credential, sealed: vaultModule.ephemeralShopifyVault().seal({ connectionId: CONN, shopDomain: SHOP },
    { accessToken: 'x', refreshToken: 'y', accessExpiresAt: '2026-11-16T13:00:00.000Z', refreshExpiresAt: '2027-01-01T00:00:00.000Z' }) };
  const r = await t.service.sync(t.req, { schoolId: SCHOOL });
  assert.deepEqual([r.outcome, r.failureCode], ['NEEDS_RECONNECT', 'CREDENTIAL_UNREADABLE']);
});

test('0405 database refusals map to fixed answers without SQL text', () => {
  const err = (message, code) => Object.assign(new Error(message), { code });
  const status = e => { try { translateShopifyError(e); } catch (x) { return [x.getStatus(), x.response.code]; } };
  assert.deepEqual(status(err('SHOPIFY_FORBIDDEN', '42501')), [403, 'SHOPIFY_FORBIDDEN']);
  assert.deepEqual(status(err('SHOPIFY_SHOP_TAKEN', '23505')), [409, 'SHOPIFY_SHOP_TAKEN']);
  assert.deepEqual(status(err('SHOPIFY_SYNC_RUNNING', '55P03')), [409, 'SHOPIFY_SYNC_RUNNING']);
  assert.deepEqual(status(err('SHOPIFY_RATE_LIMITED', '54000')), [429, 'SHOPIFY_RATE_LIMITED']);
  assert.deepEqual(status(err('SHOPIFY_SHOP_TAKEN', 'XX000')), [503, 'SHOPIFY_UNAVAILABLE'], 'message alone is not trusted');
  assert.deepEqual(status(err('relation "hon.secret" does not exist', '42P01')), [503, 'SHOPIFY_UNAVAILABLE']);
  assert.deepEqual(status(err('permission denied for table', '42501')), [403, 'SHOPIFY_FORBIDDEN']);
});

test('0405 the state the browser carries is 32 random bytes and the database sees only its SHA-256', async () => {
  const s = setup();
  const url = new URL((await s.service.start(s.req, { schoolId: SCHOOL, shopDomain: SHOP })).authorizeUrl);
  const state = url.searchParams.get('state');
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(s.db.calls[0].params[2], createHash('sha256').update(state).digest('hex'));
});

test('PD1 (0611) who fulfils a variant: the first third-party service by name, null for the school, left out when not asked', () => {
  const node = levels => ({ id: 'gid://shopify/ProductVariant/1', title: 'M', sku: 'S', barcode: null, price: '12.5', compareAtPrice: null, inventoryQuantity: 0, position: 1,
    inventoryItem: { tracked: false, unitCost: null, ...(levels === undefined ? {} : { inventoryLevels: { nodes: levels } }) },
    product: { id: 'gid://shopify/Product/1', title: 'Hoodie', status: 'ACTIVE', vendor: null, productType: null, handle: 'hoodie', featuredMedia: null } });
  const by = levels => adapter.productsFromVariantNodes([node(levels)])[0].variants[0];
  const level = service => ({ location: { fulfillmentService: service } });
  assert.equal('fulfilledBy' in by(undefined), false, 'a read that did not ask leaves the key out, so the mirror keeps its value');
  assert.equal(by([]).fulfilledBy, null);
  assert.equal(by([level(null), { location: null }]).fulfilledBy, null, 'the school\'s own location');
  assert.equal(by([level({ serviceName: 'Manual', type: 'MANUAL' }), level({ serviceName: 'Gift cards', type: 'GIFT_CARD' })]).fulfilledBy, null);
  assert.equal(by([level(null), level({ serviceName: ' Printful\u0007 ', type: 'THIRD_PARTY' })]).fulfilledBy, 'Printful');
  assert.equal(by([level({ serviceName: 'x'.repeat(90), type: 'THIRD_PARTY' })]).fulfilledBy.length, 64);
  assert.equal(by([level({ serviceName: '  ', type: 'THIRD_PARTY' }), level({ serviceName: 'Second', type: 'THIRD_PARTY' })]).fulfilledBy, 'Second');
  assert.throws(() => by('nope'), adapter.ShopifyProviderError);
  assert.throws(() => by([level({ serviceName: 7, type: 'THIRD_PARTY' })]), adapter.ShopifyProviderError);
  // The catalog contract: a provider's variant is never low stock, and the name is bounded.
  const variant = over => ({ variantId: '9200000031', title: 'Black / M', sku: null, barcode: null, price: 45, compareAtPrice: null, unitCost: null, margin: null, marginPercent: null,
    tracked: true, inventoryQuantity: 0, lowStock: false, fulfilledBy: 'Sample Print Co', ...over });
  const catalog = over => contracts.verifyShopifyCatalog({ schoolId: '44444444-4444-4444-8444-444444444444', currency: 'USD', products: [{ productId: '9100000003', title: 'Hoodie', status: 'ACTIVE',
    vendor: null, productType: null, imageUrl: null, variants: [variant(over)] }] });
  assert.equal(catalog({}).products[0].variants[0].fulfilledBy, 'Sample Print Co');
  assert.equal(catalog({ fulfilledBy: null, lowStock: true }).products[0].variants[0].lowStock, true);
  for (const bad of [{ lowStock: true }, { fulfilledBy: 'x'.repeat(65) }, { fulfilledBy: undefined }]) assert.throws(() => catalog(bad), /SHOPIFY_RESPONSE_INVALID/);
});
