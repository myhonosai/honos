const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { SchoolPosService } = require('../dist/pos/school-pos.service.js');
const { computePosTotals, validatePosSaleInput } = require('@hon/contracts');

// Mocked boundary tests for the 0612 Point of Sale API. Authority, school scope, pricing, stock and refunds are proven
// against PostgreSQL by test-pos-integrity.mjs.
const status = (value, code) => (error) => { assert.equal(error.getStatus(), value); if (code) assert.equal(error.getResponse().code, code); return true; };
const req = { honIdentity: { externalSubject: 'subject-1' } };
const school = randomUUID(), item = randomUUID();
function fakeDatabase(answer) {
  const calls = [];
  return { calls, async callSchoolPos(op, params) { calls.push({ op, params }); if (answer instanceof Error) throw answer; return typeof answer === 'function' ? answer(op, params) : answer; } };
}
const sqlError = (message, code) => Object.assign(new Error(message), { code });
const saleBody = (o = {}) => ({ schoolId: school, personId: null, walkInName: null, lines: [{ itemId: item, quantity: 1 }], discount: null, method: 'CASH', reference: null, note: null, expectedTotalMinor: 1000, ...o });

test('the register arithmetic matches the database rules: discount, taxable share, half-up rounding', () => {
  assert.deepEqual(computePosTotals([{ unitPriceMinor: 10000, quantity: 2, taxable: true }, { unitPriceMinor: 7500, quantity: 1, taxable: false }], { kind: 'PERCENT', value: 10 }, 825),
    { subtotalMinor: 27500, discountMinor: 2750, taxMinor: 1485, totalMinor: 26235 });
  assert.deepEqual(computePosTotals([{ unitPriceMinor: 999, quantity: 1, taxable: true }], null, 1000), { subtotalMinor: 999, discountMinor: 0, taxMinor: 100, totalMinor: 1099 });
  assert.deepEqual(computePosTotals([{ unitPriceMinor: 500, quantity: 1, taxable: false }], { kind: 'AMOUNT', value: 900 }, 0).totalMinor, 0);
});

test('a sale goes to the database with the session subject, the exact key and a closed body', async () => {
  const db = fakeDatabase(new Error('stop'));
  const service = new SchoolPosService(db);
  const key = randomUUID();
  await assert.rejects(() => service.command(req, 'record', saleBody(), key), status(503, 'POS_UNAVAILABLE'));
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].op, 'record');
  assert.equal(db.calls[0].params[0], 'subject-1');
  assert.deepEqual(JSON.parse(db.calls[0].params[1]), saleBody());
  assert.equal(db.calls[0].params[2], key);
});

test('bad input never reaches the database', async () => {
  const db = fakeDatabase({});
  const service = new SchoolPosService(db);
  for (const body of [saleBody({ extra: 1 }), saleBody({ lines: [] }), saleBody({ personId: randomUUID(), walkInName: 'Guest' }), saleBody({ method: 'CARD' }),
    saleBody({ discount: { kind: 'PERCENT', value: 101, reason: 'x' } }), saleBody({ lines: [{ description: ' padded', unitPriceMinor: 1, quantity: 1 }] })]) {
    await assert.rejects(() => service.command(req, 'record', body, randomUUID()), status(400, 'POS_INVALID'));
  }
  await assert.rejects(() => service.command(req, 'record', saleBody(), 'not-a-key'), status(400, 'POS_INVALID'));
  await assert.rejects(() => service.sales(req, school, '2026-01-01', '2027-06-01'), status(400, 'POS_INVALID'));
  assert.equal(db.calls.length, 0);
  assert.throws(() => validatePosSaleInput(saleBody({ lines: Array.from({ length: 51 }, () => ({ itemId: item, quantity: 1 })) })));
});

test('database refusals become plain, safe answers', async () => {
  const cases = [['POS_TOTAL_CHANGED', '40001', 409], ['POS_OUT_OF_STOCK', '22023', 409], ['POS_FORBIDDEN', '42501', 403], ['POS_NOT_FOUND', 'P0002', 404],
    ['POS_REFUND_TOO_LARGE', '22023', 400], ['POS_KEY_REUSED', '23505', 409], ['POS_BUSY', '55P03', 503]];
  for (const [message, code, http] of cases) {
    const service = new SchoolPosService(fakeDatabase(sqlError(message, code)));
    await assert.rejects(() => service.command(req, 'record', saleBody(), randomUUID()), (e) => {
      assert.equal(e.getStatus(), http); assert.equal(e.getResponse().code, message);
      assert(!JSON.stringify(e.getResponse()).match(/SQLSTATE|hon\.|subject/)); return true;
    });
  }
  const unknown = new SchoolPosService(fakeDatabase(sqlError('relation hon.pos_sales does not exist', '42P01')));
  await assert.rejects(() => unknown.read(req, school), status(503, 'POS_UNAVAILABLE'));
});

test('a malformed database answer is never passed to the screen', async () => {
  const service = new SchoolPosService(fakeDatabase({ schoolId: randomUUID(), timezone: 'UTC', today: '2026-11-16', canManage: false, settings: { currency: 'USD', taxRateBps: 0, version: null }, items: [], todaySales: { count: 0, totalMinor: 0 } }));
  await assert.rejects(() => service.read(req, school), status(503, 'POS_UNAVAILABLE'));
});

// 0613: Shopify stock follow-up after a sale or refund. The real path is proven by test-pos-shopify-integrity.mjs.
const { begunPosStock, sendPosStock, POS_STOCK_MAX_ATTEMPTS } = require('../dist/pos/pos-shopify-stock.js');
const { ShopifyProviderError, ownStockLocation } = require('../dist/commerce/shopify/shopify-adapter.js');
const { ShopifyVault } = require('../dist/commerce/shopify/shopify-vault.js');
const vault = new ShopifyVault(Buffer.alloc(32, 7), 'test-key');
const HOUR = 3600_000, T0 = Date.parse('2026-11-21T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
function begun(tasks, o = {}) {
  const connectionId = randomUUID(), shopDomain = 'proof-dojo.myshopify.com';
  const pair = { accessToken: 'access-1', refreshToken: 'refresh-1', accessExpiresAt: iso(T0 + (o.accessIn ?? HOUR)), refreshExpiresAt: iso(T0 + (o.refreshIn ?? 24 * HOUR)) };
  return { state: 'READY', connectionId, shopDomain, credential: { keyId: 'test-key', sealed: o.sealed ?? vault.seal({ connectionId, shopDomain }, pair), version: 3 },
    tasks: tasks.map((t) => ({ taskId: randomUUID(), saleId: randomUUID(), variantId: '4001', change: -1, attempts: 1, ...t })) };
}
function stockApp(answer) {
  const sent = [], refreshed = [];
  return { sent, refreshed, vault, adapter: {
    async adjustInventory(shop, token, input) { sent.push({ shop, token, ...input }); const r = typeof answer === 'function' ? answer(sent.length, input) : answer; if (r instanceof Error) throw r; return r; },
    async refresh(shop, token) { refreshed.push(token); if (answer instanceof Error && answer.refreshFails) throw answer;
      return { accessToken: 'access-2', refreshToken: 'refresh-2', accessExpiresAt: iso(T0 + HOUR), refreshExpiresAt: iso(T0 + 48 * HOUR), scope: 'write_inventory' }; },
  } };
}
function steps() { const finished = [], rotated = []; return { finished, rotated, rotate: async (b) => { rotated.push(b); }, finish: async (taskId, outcome, code) => { finished.push([taskId, outcome, code]); } }; }

test('only a READY answer with well-formed waiting changes is sent', () => {
  const w = begun([{}]);
  assert.equal(begunPosStock(w).tasks.length, 1);
  for (const bad of [null, { ...w, state: 'NEEDS_EDITING' }, { ...w, tasks: [] }, { ...w, credential: null }, { ...w, tasks: [{ ...w.tasks[0], change: 0 }] },
    { ...w, tasks: [{ ...w.tasks[0], variantId: 'gid://shopify/ProductVariant/1' }] }, { ...w, tasks: [{ ...w.tasks[0], taskId: 'x' }] },
    { ...w, tasks: Array.from({ length: 21 }, () => w.tasks[0]) }]) assert.equal(begunPosStock(bad), null);
});

test('each change is one Shopify call keyed by its task id; a refusal is FAILED with its reason', async () => {
  const w = begunPosStock(begun([{ change: -2 }, { variantId: '4002', change: 1 }]));
  const app = stockApp((n) => n === 1 ? { outcome: 'DONE' } : { outcome: 'REFUSED', reason: 'MULTIPLE_LOCATIONS' }), s = steps();
  await sendPosStock(app, () => T0, w, s);
  assert.deepEqual(app.sent.map((x) => [x.token, x.variantId, x.delta, x.idempotencyKey, x.reference]),
    w.tasks.map((t) => ['access-1', t.variantId, t.change, t.taskId, `honos://pos/sale/${t.saleId}`]));
  assert.deepEqual(s.finished, [[w.tasks[0].taskId, 'DONE', null], [w.tasks[1].taskId, 'FAILED', 'MULTIPLE_LOCATIONS']]);
  assert.equal(s.rotated.length, 0);
});

test('an uncertain answer waits until the attempt limit; a rejected token fails the rest without calling again', async () => {
  const slow = begunPosStock(begun([{ attempts: 1 }, { attempts: POS_STOCK_MAX_ATTEMPTS }]));
  const a = stockApp(new ShopifyProviderError('UNAVAILABLE')), s1 = steps();
  await sendPosStock(a, () => T0, slow, s1);
  assert.deepEqual(s1.finished.map((f) => f.slice(1)), [['RETRY', 'SHOPIFY_UNAVAILABLE'], ['FAILED', 'SHOPIFY_UNAVAILABLE']]);
  const auth = begunPosStock(begun([{}, {}, {}]));
  const b = stockApp((n) => n === 1 ? { outcome: 'DONE' } : new ShopifyProviderError('AUTH')), s2 = steps();
  await sendPosStock(b, () => T0, auth, s2);
  assert.equal(b.sent.length, 2);
  assert.deepEqual(s2.finished.map((f) => f.slice(1)), [['DONE', null], ['FAILED', 'TOKEN_REJECTED'], ['FAILED', 'TOKEN_REJECTED']]);
});

test('an expiring token is refreshed and rotated before sending; an unreadable or expired credential sends nothing', async () => {
  const w = begunPosStock(begun([{}], { accessIn: 60_000 }));
  const app = stockApp({ outcome: 'DONE' }), s = steps();
  await sendPosStock(app, () => T0, w, s);
  assert.deepEqual(app.refreshed, ['refresh-1']);
  assert.equal(s.rotated.length, 1);
  assert.equal(s.rotated[0].expectedVersion, 3);
  assert.equal(vault.open({ connectionId: w.connectionId, shopDomain: w.shopDomain }, 'test-key', s.rotated[0].credential.sealed).accessToken, 'access-2');
  assert(!JSON.stringify(s.rotated).includes('access-2'));
  assert.equal(app.sent[0].token, 'access-2');
  const copied = begunPosStock({ ...begun([{}]), sealed: undefined, credential: { keyId: 'test-key', sealed: begun([{}]).credential.sealed, version: 1 } });
  const c = stockApp({ outcome: 'DONE' }), s3 = steps();
  await sendPosStock(c, () => T0, copied, s3);
  assert.equal(c.sent.length, 0);
  assert.deepEqual(s3.finished.map((f) => f.slice(1)), [['FAILED', 'CREDENTIAL_UNREADABLE']]);
  const dead = begunPosStock(begun([{}], { accessIn: -HOUR, refreshIn: -1 }));
  const d = stockApp({ outcome: 'DONE' }), s4 = steps();
  await sendPosStock(d, () => T0, dead, s4);
  assert.equal(d.sent.length + d.refreshed.length, 0);
  assert.deepEqual(s4.finished.map((f) => f.slice(1)), [['FAILED', 'REFRESH_EXPIRED']]);
});

test('stock is changed only at the one active location the school runs itself', () => {
  const level = (id, o = {}) => ({ location: { id: `gid://shopify/Location/${id}`, isActive: true, fulfillmentService: null, ...o } });
  const variant = (levels, o = {}) => ({ inventoryItem: { id: 'gid://shopify/InventoryItem/77', tracked: true, inventoryLevels: { nodes: levels }, ...o } });
  assert.equal(typeof ownStockLocation(variant([level(1)])), 'object');
  assert.equal(ownStockLocation(null), 'VARIANT_GONE');
  assert.equal(ownStockLocation(variant([level(1)], { tracked: false })), 'NOT_TRACKED');
  assert.equal(ownStockLocation(variant([level(1), level(2)])), 'MULTIPLE_LOCATIONS');
  assert.equal(ownStockLocation(variant([])), 'NO_LOCATION');
});

test('a recorded sale stays recorded when Shopify cannot be reached, and with no Shopify app the change simply waits', async () => {
  const saleId = randomUUID();
  const sale = { note: null, lines: [{ sku: 'BELT-W', name: 'Dojo gear - White belt', itemId: null, lineId: randomUUID(), taxable: true, category: 'SHOPIFY', quantity: 1,
    stockTracked: true, lineTotalMinor: 1000, unitPriceMinor: 1000, shopifyVariantId: '4001', madeBy: null, restockedQuantity: 0 }], shopifyOrder: null, method: 'CASH', saleId, soldAt: '2026-11-21T02:44:35.351Z',
    soldBy: 'Cashier', status: 'PAID', refunds: [], currency: 'USD', customer: { name: null, personId: null }, discount: null, taxMinor: 0, firstItem: 'Dojo gear - White belt',
    itemCount: 1, localDate: '2026-11-20', reference: null, schoolName: 'POS school', taxRateBps: 0, totalMinor: 1000, shopifyStock: { done: 0, failed: 0, waiting: 1 },
    receiptNumber: 'POS-20261120-0002', refundedMinor: 0, subtotalMinor: 1000 };
  const body = saleBody({ lines: [{ shopifyVariantId: '4001', quantity: 1 }] });
  const db = fakeDatabase((op) => { if (op === 'record') return { sale, replayed: false }; throw new Error('database gone'); });
  const out = await new SchoolPosService(db, { vault, adapter: {} }).command(req, 'record', body, randomUUID());
  assert.equal(out.sale.saleId, saleId);
  assert.deepEqual(db.calls.map((c) => c.op), ['record', 'shopifyStockBegin', 'shopifyOrderBegin', 'sale']);
  const alone = fakeDatabase((op) => { if (op === 'record') return { sale, replayed: false }; throw new Error('database gone'); });
  await new SchoolPosService(alone).command(req, 'record', body, randomUUID());
  assert.deepEqual(alone.calls.map((c) => c.op), ['record', 'sale']);
  await assert.rejects(() => new SchoolPosService(alone).resendShopifyStock(req, { schoolId: school }), status(503, 'POS_SHOPIFY_UNAVAILABLE'));
});

test('Shopify gets one read and one idempotent inventoryAdjustQuantities per change; a provider location is never touched', async () => {
  const { GraphqlShopifyAdapter } = require('../dist/commerce/shopify/shopify-adapter.js');
  const sent = [];
  const answer = (data) => async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ data: data(sent.length) }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  const level = (id, service = null) => ({ location: { id: `gid://shopify/Location/${id}`, isActive: true, fulfillmentService: service } });
  const variant = (levels) => ({ productVariant: { id: 'gid://shopify/ProductVariant/4001', inventoryItem: { id: 'gid://shopify/InventoryItem/77', tracked: true, inventoryLevels: { nodes: levels } } } });
  const input = { variantId: '4001', delta: -2, idempotencyKey: randomUUID(), reference: `honos://pos/sale/${randomUUID()}` };
  const done = (n) => n === 1 ? variant([level(5), level(9, { type: 'THIRD_PARTY' })]) : { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: 'gid://shopify/InventoryAdjustmentGroup/1' }, userErrors: [] } };
  assert.deepEqual(await new GraphqlShopifyAdapter('client', 'secret', answer(done), async () => {}).adjustInventory('proof-dojo.myshopify.com', 'tok', input), { outcome: 'DONE' });
  assert.equal(sent.length, 2);
  assert.match(sent[1].body.query, /inventoryAdjustQuantities\(input: \$input\) @idempotent\(key: \$key\)/);
  assert.deepEqual(sent[1].body.variables, { key: input.idempotencyKey, input: { reason: 'correction', name: 'available', referenceDocumentUri: input.reference,
    changes: [{ delta: -2, inventoryItemId: 'gid://shopify/InventoryItem/77', locationId: 'gid://shopify/Location/5', changeFromQuantity: null }] } });
  for (const [data, reason] of [[() => ({ productVariant: null }), 'VARIANT_GONE'], [() => variant([level(9, { type: 'THIRD_PARTY' })]), 'NO_LOCATION'], [() => variant([level(5), level(6)]), 'MULTIPLE_LOCATIONS']]) {
    sent.length = 0;
    assert.deepEqual(await new GraphqlShopifyAdapter('client', 'secret', answer(data), async () => {}).adjustInventory('proof-dojo.myshopify.com', 'tok', input), { outcome: 'REFUSED', reason });
    assert.equal(sent.length, 1);
  }
  sent.length = 0;
  const refused = (n) => n === 1 ? variant([level(5)]) : { inventoryAdjustQuantities: { inventoryAdjustmentGroup: null, userErrors: [{ field: ['input'], message: 'x' }] } };
  assert.deepEqual(await new GraphqlShopifyAdapter('client', 'secret', answer(refused), async () => {}).adjustInventory('proof-dojo.myshopify.com', 'tok', input), { outcome: 'REFUSED', reason: 'SHOPIFY_REJECTED' });
  await assert.rejects(new GraphqlShopifyAdapter('client', 'secret', answer(done), async () => {}).adjustInventory('proof-dojo.myshopify.com', 'tok', { ...input, delta: 0 }));
});

// 0614: made-to-order items sold at the desk become one paid Shopify order.
const { begunPosOrders, sendPosOrders, posOrderPrice } = require('../dist/pos/pos-shopify-order.js');
const { posOrderVariables, posOrderTag } = require('../dist/commerce/shopify/shopify-adapter.js');
const HOME = { name: 'Sample Parent', address1: '12 Example Road', address2: null, city: 'Springfield', province: 'IL', zip: '62701', country: 'US' };
function begunOrders(orders, o = {}) {
  const { tasks: _t, ...w } = begun([], o);
  return { ...w, orders: orders.map((t) => ({ orderTaskId: randomUUID(), saleId: randomUUID(), attempts: 1, receiptNumber: 'POS-20261121-0001', currency: 'USD', shipTo: HOME,
    lines: [{ variantId: '4003', quantity: 2, unitPriceMinor: 4000 }], ...t })) };
}
function orderApp(answer) {
  const sent = [];
  return { sent, vault, adapter: {
    async createPosOrder(shop, token, input) { sent.push({ shop, token, ...input }); const r = typeof answer === 'function' ? answer(sent.length, input) : answer; if (r instanceof Error) throw r; return r; },
    async refresh() { throw new Error('not expected'); } } };
}
function orderSteps() { const finished = []; return { finished, rotate: async () => {}, finish: async (id, outcome, code, order) => { finished.push([id, outcome, code, order]); } }; }

test('only a READY answer with well-formed waiting orders is sent', () => {
  const w = begunOrders([{}]);
  assert.equal(begunPosOrders(w).orders.length, 1);
  for (const bad of [null, { ...w, state: 'NEEDS_ORDERS' }, { ...w, orders: [] }, { ...w, credential: null }, { ...w, orders: [{ ...w.orders[0], shipTo: null }] },
    { ...w, orders: [{ ...w.orders[0], shipTo: { ...HOME, country: 'usa' } }] }, { ...w, orders: [{ ...w.orders[0], lines: [] }] },
    { ...w, orders: [{ ...w.orders[0], lines: [{ variantId: '4003', quantity: 0, unitPriceMinor: 1 }] }] }, { ...w, orders: [{ ...w.orders[0], orderTaskId: 'x' }] },
    { ...w, orders: Array.from({ length: 6 }, () => w.orders[0]) }]) assert.equal(begunPosOrders(bad), null);
  assert.equal(posOrderPrice(4000, 'USD'), '40.00'); assert.equal(posOrderPrice(5, 'USD'), '0.05'); assert.equal(posOrderPrice(15000, 'KRW'), '15000');
});

test('each waiting order is one Shopify order keyed by its row; a refusal is FAILED, an uncertain answer waits until the limit', async () => {
  const w = begunPosOrders(begunOrders([{}, {}, { attempts: POS_STOCK_MAX_ATTEMPTS }]));
  const app = orderApp((n) => n === 1 ? { outcome: 'DONE', orderId: '900', orderName: '#1001' } : n === 2 ? { outcome: 'REFUSED', reason: 'SHOPIFY_REJECTED' } : new ShopifyProviderError('UNAVAILABLE')), s = orderSteps();
  await sendPosOrders(app, () => T0, w, s);
  assert.deepEqual(app.sent[0], { shop: w.shopDomain, token: 'access-1', key: w.orders[0].orderTaskId, currency: 'USD', shipTo: HOME,
    note: 'Paid at the front desk. HON receipt POS-20261121-0001.', lines: [{ variantId: '4003', quantity: 2, unitPrice: '40.00' }] });
  assert.deepEqual(s.finished, [[w.orders[0].orderTaskId, 'DONE', null, { orderId: '900', orderName: '#1001' }], [w.orders[1].orderTaskId, 'FAILED', 'SHOPIFY_REJECTED', null],
    [w.orders[2].orderTaskId, 'FAILED', 'SHOPIFY_UNAVAILABLE', null]]);
  const again = begunPosOrders(begunOrders([{}, {}])), b = orderApp(new ShopifyProviderError('AUTH')), s2 = orderSteps();
  await sendPosOrders(b, () => T0, again, s2);
  assert.equal(b.sent.length, 1);
  assert.deepEqual(s2.finished.map((f) => f.slice(1)), [['FAILED', 'TOKEN_REJECTED', null], ['FAILED', 'TOKEN_REJECTED', null]]);
  const one = begunPosOrders(begunOrders([{}])), c = orderApp(new ShopifyProviderError('RATE_LIMITED')), s3 = orderSteps();
  await sendPosOrders(c, () => T0, one, s3);
  assert.deepEqual(s3.finished.map((f) => f.slice(1)), [['RETRY', 'SHOPIFY_RATE_LIMITED', null]]);
  const broken = begunPosOrders(begunOrders([{}])), d = orderApp(new TypeError('bug')), s4 = orderSteps();
  await assert.rejects(() => sendPosOrders(d, () => T0, broken, s4), TypeError);
  assert.deepEqual(s4.finished.map((f) => f.slice(1)), [['RETRY', 'HON_SEND_FAILED', null]]);
});

test('Shopify is asked for the tag first and gets one paid orderCreate with no email and stock left alone', async () => {
  const { GraphqlShopifyAdapter } = require('../dist/commerce/shopify/shopify-adapter.js');
  const sent = [], key = randomUUID();
  const answer = (data) => async (url, init) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ data: data(sent.length) }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  const input = { key, currency: 'USD', note: 'Paid at the front desk. HON receipt POS-1.', shipTo: HOME, lines: [{ variantId: '4003', quantity: 2, unitPrice: '40.00' }] };
  const adapter = (data) => new GraphqlShopifyAdapter('client', 'secret', answer(data), async () => {});
  const made = (n) => n === 1 ? { orders: { nodes: [] } } : { orderCreate: { order: { id: 'gid://shopify/Order/900', name: '#1001' }, userErrors: [] } };
  assert.deepEqual(await adapter(made).createPosOrder('proof-dojo.myshopify.com', 'tok', input), { outcome: 'DONE', orderId: '900', orderName: '#1001' });
  assert.deepEqual(sent[0].variables, { query: `tag:'hon-pos-${key}'` });
  assert.match(sent[1].query, /orderCreate\(order: \$order, options: \$options\)/);
  assert.deepEqual(sent[1].variables, { order: { currency: 'USD', financialStatus: 'PAID', note: input.note, tags: ['hon-pos', posOrderTag(key)],
    lineItems: [{ variantId: 'gid://shopify/ProductVariant/4003', quantity: 2, priceSet: { shopMoney: { amount: '40.00', currencyCode: 'USD' } } }],
    shippingAddress: { lastName: 'Sample Parent', address1: '12 Example Road', city: 'Springfield', provinceCode: 'IL', zip: '62701', countryCode: 'US' } },
    options: { inventoryBehaviour: 'BYPASS', sendReceipt: false, sendFulfillmentReceipt: false } });
  assert(!JSON.stringify(sent[1].variables).match(/email|customer/i));
  sent.length = 0;
  assert.deepEqual(await adapter(() => ({ orders: { nodes: [{ id: 'gid://shopify/Order/900', name: '#1001' }] } })).createPosOrder('proof-dojo.myshopify.com', 'tok', input), { outcome: 'DONE', orderId: '900', orderName: '#1001' });
  assert.equal(sent.length, 1);
  sent.length = 0;
  const refused = (n) => n === 1 ? { orders: { nodes: [] } } : { orderCreate: { order: null, userErrors: [{ field: ['order'], message: 'x' }] } };
  assert.deepEqual(await adapter(refused).createPosOrder('proof-dojo.myshopify.com', 'tok', input), { outcome: 'REFUSED', reason: 'SHOPIFY_REJECTED' });
  for (const bad of [{ key: 'x' }, { currency: 'usd' }, { lines: [] }, { lines: [{ variantId: '4003', quantity: 1, unitPrice: '4.005' }] }]) assert.throws(() => posOrderVariables({ ...input, ...bad }));
});
