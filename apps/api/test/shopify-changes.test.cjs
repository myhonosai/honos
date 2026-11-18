const { test } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('@hon/contracts');
const adapter = require('../dist/commerce/shopify/shopify-adapter.js');
const engine = require('../dist/commerce/shopify/shopify-change-engine.js');
const { ShopifyService } = require('../dist/commerce/shopify/shopify.service.js');

// 0496 SH4a product changes: the fake store and stub steps only. Nothing calls Shopify.
const SHOP = 'ima-test.myshopify.com';
const SCHOOL = '11111111-1111-4111-8111-111111111111';
const CONN = '22222222-2222-4222-8222-222222222222';
const CHANGE = '33333333-3333-4333-8333-333333333333';
const NOW = Date.UTC(2026, 10, 18, 12);

function world(scopes = 'write_products,write_inventory,read_orders') {
  const app = adapter.shopifyAppFromEnvironment({ HON_SHOPIFY_FAKE: '1' });
  app.fake.now = () => NOW;
  app.fake.grantScopes = scopes;
  // A token pair the fake issued, sealed as the database would hold it.
  const code = new URLSearchParams(app.fake.approve(SHOP, 'A'.repeat(43), NOW)).get('code');
  return app.adapter.exchangeCode(SHOP, code).then(t => {
    const sealed = app.vault.seal({ connectionId: CONN, shopDomain: SHOP },
      { accessToken: t.accessToken, refreshToken: t.refreshToken, accessExpiresAt: t.accessExpiresAt, refreshExpiresAt: t.refreshExpiresAt });
    return { app, credential: { keyId: app.vault.keyId, sealed, version: 1 } };
  });
}
function change(kind, changes, base = {}, extra = {}) {
  return { changeId: CHANGE, kind, productId: kind === 'UPDATE' ? '9100000001' : null, handle: kind === 'CREATE_DRAFT' ? 'rash-guard-33333333' : null,
    status: 'APPLYING', version: 2, changes, base, attempts: 1, failureCode: null, proposedAt: '2026-11-18T11:59:00.000Z', approvedAt: '2026-11-18T12:00:00.000Z',
    finishedAt: null, proposedByMe: true, ...extra };
}
async function run(w, c, mode = 'APPLY') {
  const records = [];
  const out = await engine.runShopifyChange(w.app, () => NOW, { change: c, mode, leaseToken: 'L', connectionId: CONN, shopDomain: SHOP, credential: w.credential }, {
    rotate: async () => ({ version: 2 }),
    record: async (outcome, failureCode, product) => { records.push({ outcome, failureCode, product }); return { outcome, failureCode, product }; },
  });
  assert.equal(records.length, 1, 'exactly one result is recorded');
  return out;
}
const update = (changes, base) => change('UPDATE', changes, base);
const UNIFORM_BASE = { title: 'Student uniform', variants: [{ variantId: '9200000011', price: '65.0000' }] };

test('0496 update: checked against the base, written, read back and recorded APPLIED with the product', async () => {
  const w = await world();
  const r = await run(w, update({ title: 'Student uniform (white)', variants: [{ variantId: '9200000011', price: '69.50' }] }, UNIFORM_BASE));
  assert.equal(r.outcome, 'APPLIED');
  assert.equal(r.product.title, 'Student uniform (white)');
  assert.equal(r.product.variants[0].price, '69.50');
  assert.deepEqual(w.app.fake.calls.filter(c => !c.startsWith('exchange')), ['product:' + SHOP, 'updateProduct:' + SHOP, 'updateVariants:' + SHOP, 'product:' + SHOP]);
});

test('0496 update: a product changed in Shopify since the proposal is not written', async () => {
  const w = await world();
  const r = await run(w, update({ title: 'New name' }, { title: 'Older name' }));
  assert.deepEqual([r.outcome, r.failureCode, r.product.title], ['FAILED', 'CHANGED_IN_SHOPIFY', 'Student uniform']);
  assert.equal(w.app.fake.calls.some(c => c.startsWith('update')), false);
  const gone = await run(w, change('UPDATE', { title: 'X' }, { title: 'Y' }, { productId: '9100009999' }));
  assert.deepEqual([gone.outcome, gone.failureCode], ['FAILED', 'PRODUCT_NOT_FOUND']);
});

test('0496 update: Shopify user errors are FAILED; a lost answer is UNKNOWN; checking finds it saved', async () => {
  const w = await world();
  w.app.fake.writeFault = 'REJECT';
  const rejected = await run(w, update({ title: 'Rejected' }, { title: 'Student uniform' }));
  assert.deepEqual([rejected.outcome, rejected.failureCode], ['FAILED', 'SHOPIFY_REJECTED']);
  w.app.fake.writeFault = 'LOSE_ANSWER';
  const c = update({ title: 'Saved quietly' }, { title: 'Student uniform' });
  const lost = await run(w, c);
  assert.deepEqual([lost.outcome, lost.failureCode, lost.product], ['UNKNOWN', 'SHOPIFY_UNAVAILABLE', null]);
  const before = w.app.fake.calls.length;
  const checked = await run(w, c, 'CHECK');
  assert.deepEqual([checked.outcome, checked.product.title], ['APPLIED', 'Saved quietly']);
  assert.deepEqual(w.app.fake.calls.slice(before), ['product:' + SHOP], 'CHECK only reads');
  const notSaved = await run(w, update({ title: 'Never sent' }, { title: 'Student uniform' }), 'CHECK');
  assert.deepEqual([notSaved.outcome, notSaved.failureCode], ['FAILED', 'NOT_APPLIED']);
});

test('0496 update: a second write refused after the first was saved is recorded as PARTLY_APPLIED with the product', async () => {
  const w = await world();
  const real = w.app.adapter.updateVariants.bind(w.app.adapter);
  w.app.adapter.updateVariants = async (...a) => { w.app.fake.writeFault = 'REJECT'; return real(...a); };
  const r = await run(w, update({ title: 'Half', variants: [{ variantId: '9200000011', price: '1' }] }, UNIFORM_BASE));
  assert.deepEqual([r.outcome, r.failureCode, r.product.title, r.product.variants[0].price], ['FAILED', 'PARTLY_APPLIED', 'Half', '65.00']);
});

test('0496 unit costs need write_inventory; without it Shopify refuses and nothing is guessed', async () => {
  const w = await world('write_products,read_orders');
  const r = await run(w, update({ variants: [{ variantId: '9200000011', unitCost: '30' }] }, { variants: [{ variantId: '9200000011', unitCost: '28.0000' }] }));
  assert.equal(r.outcome, 'UNKNOWN', 'an access error on a write is never assumed to have saved nothing');
});

test('0496 new draft: created as DRAFT under HON\'s handle, priced, read back; an earlier saved attempt is found by handle', async () => {
  const w = await world();
  const d = change('CREATE_DRAFT', { title: 'Rash guard', description: 'Long sleeve.\n\nFor <sparring> & drills.', productType: 'Apparel', vendor: null,
    price: '39.99', compareAtPrice: null, unitCost: '14', sku: 'RASH-1' });
  const r = await run(w, d);
  assert.equal(r.outcome, 'APPLIED');
  assert.deepEqual([r.product.status, r.product.handle, r.product.variants[0].price, r.product.variants[0].unitCost, r.product.variants[0].sku],
    ['DRAFT', 'rash-guard-33333333', '39.99', '14', 'RASH-1']);
  const again = await run(w, d);
  assert.equal(again.outcome, 'APPLIED', 'the same change never creates a second product');
  assert.equal(w.app.fake.calls.filter(c => c === 'createDraft:' + SHOP).length, 1);
  assert.equal(engine.descriptionHtml('Long sleeve.\n\nFor <sparring> & drills.\nLine'), '<p>Long sleeve.</p><p>For &lt;sparring&gt; &amp; drills.<br>Line</p>');
  assert.equal(engine.descriptionHtml(null), null);
});

test('0496 contracts: proposals are closed, trimmed and bounded', () => {
  const ok = contracts.validateShopifyProposeInput({ schoolId: SCHOOL, kind: 'UPDATE', productId: '9100000001',
    changes: { title: 'A', variants: [{ variantId: '9200000011', price: '1.5', compareAtPrice: null }] } });
  assert.equal(ok.changes.variants[0].compareAtPrice, null);
  const draft = { title: 'Rash guard', description: null, productType: null, vendor: null, price: '39.99', compareAtPrice: null, unitCost: null, sku: null };
  assert.equal(contracts.validateShopifyProposeInput({ schoolId: SCHOOL, kind: 'CREATE_DRAFT', productId: null, changes: draft }).kind, 'CREATE_DRAFT');
  for (const [why, bad] of [
    ['empty update', { kind: 'UPDATE', productId: '9100000001', changes: {} }],
    ['unknown field', { kind: 'UPDATE', productId: '9100000001', changes: { handle: 'x' } }],
    ['untrimmed', { kind: 'UPDATE', productId: '9100000001', changes: { title: ' A' } }],
    ['UNLISTED', { kind: 'UPDATE', productId: '9100000001', changes: { status: 'UNLISTED' } }],
    ['price as number', { kind: 'UPDATE', productId: '9100000001', changes: { variants: [{ variantId: '9200000011', price: 5 }] } }],
    ['negative', { kind: 'UPDATE', productId: '9100000001', changes: { variants: [{ variantId: '9200000011', price: '-1' }] } }],
    ['variant without a field', { kind: 'UPDATE', productId: '9100000001', changes: { variants: [{ variantId: '9200000011' }] } }],
    ['repeated variant', { kind: 'UPDATE', productId: '9100000001', changes: { variants: [{ variantId: '1', price: '1' }, { variantId: '1', price: '2' }] } }],
    ['draft with product', { kind: 'CREATE_DRAFT', productId: '9100000001', changes: draft }],
    ['draft missing key', { kind: 'CREATE_DRAFT', productId: null, changes: { ...draft, sku: undefined } }],
    ['tab in description', { kind: 'CREATE_DRAFT', productId: null, changes: { ...draft, description: 'a\tb' } }],
  ]) assert.throws(() => contracts.validateShopifyProposeInput({ schoolId: SCHOOL, ...bad }), undefined, why);
  assert.equal(contracts.validateShopifyConnectInput({ schoolId: SCHOOL, shopDomain: SHOP }).allowEditing, false);
  assert.equal(contracts.validateShopifyConnectInput({ schoolId: SCHOOL, shopDomain: SHOP, allowEditing: true }).allowEditing, true);
  assert.throws(() => contracts.validateShopifyConnectInput({ schoolId: SCHOOL, shopDomain: SHOP, allowEditing: 'yes' }));
});

test('0496 Allow editing asks Shopify for the edit scopes; plain connect stays read-only', async () => {
  process.env.HON_PUBLIC_ORIGIN = 'https://app.hon.test';
  const app = adapter.shopifyAppFromEnvironment({ HON_SHOPIFY_FAKE: '1' });
  const db = { calls: [], async callShopify(op, params) { this.calls.push(op); return { intentId: 'i', shopDomain: SHOP, expiresAt: '2026-11-18T12:10:00.000Z' }; } };
  const service = new ShopifyService(db, app, () => Date.now());
  const req = { honIdentity: { externalSubject: 'owner-1' } };
  const scopeOf = async allowEditing => {
    const started = await service.start(req, { schoolId: SCHOOL, shopDomain: SHOP, ...(allowEditing === undefined ? {} : { allowEditing }) });
    const code = new URL(started.authorizeUrl).searchParams.get('code');
    return (await app.adapter.exchangeCode(SHOP, code)).scope;
  };
  assert.equal(await scopeOf(undefined), 'read_products,read_inventory,read_orders');
  assert.equal(await scopeOf(true), 'read_products,read_inventory,read_orders,write_products,write_inventory');
});
