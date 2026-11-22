const { test } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('@hon/contracts');
const { ShopifyService } = require('../dist/commerce/shopify/shopify.service.js');

// 0655 "Make my shop" requests. Nothing here calls Shopify: HON HQ creates the store by hand and records the outcome.
const SCHOOL = '44444444-4444-4444-8444-444444444444';
const REQUEST = '55555555-5555-4555-8555-555555555555';
const req = { honIdentity: { externalSubject: 'subject-1' } };
const row = over => ({ requestId: REQUEST, shopName: 'Synthetic Dojo Pro Shop', ownerEmail: 'owner@example.test', note: null, status: 'REQUESTED', shopDomain: null,
  requestedAt: '2026-11-22T20:00:00.000Z', settledAt: null, version: 1, ...over });
const hqRow = over => ({ ...row(over), schoolId: SCHOOL, schoolName: 'Synthetic Dojo' });
function service(answers) {
  const calls = [];
  const db = { async callShopify(op, params) { calls.push([op, params]); const a = answers[op]; if (a instanceof Error) throw a; return a; } };
  return { svc: new ShopifyService(db, null), calls };
}
const refused = (message, code) => Object.assign(new Error(message), { code });

test('0655 inputs: closed keys, a trimmed single-line shop name, a lower-case email, a bounded note', () => {
  const ask = o => contracts.validateShopifyStoreRequestInput({ schoolId: SCHOOL, shopName: 'Synthetic Dojo Pro Shop', ownerEmail: 'owner@example.test', note: null, ...o });
  assert.equal(ask({}).note, null); assert.equal(ask({ note: 'Uniforms first.\nThen belts.' }).note, 'Uniforms first.\nThen belts.');
  for (const [bad, why] of [[{ shopName: '' }, 'a name is required'], [{ shopName: ' x' }, 'trimmed'], [{ shopName: 'x'.repeat(61) }, 'at most 60'], [{ shopName: 'a\nb' }, 'one line'],
    [{ ownerEmail: 'Owner@example.test' }, 'lower-case email'], [{ ownerEmail: 'owner' }, 'an email'], [{ ownerEmail: null }, 'email required'],
    [{ note: 'x'.repeat(501) }, 'note at most 500'], [{ note: '' }, 'null, not empty'], [{ extra: 1 }, 'closed keys']])
    assert.throws(() => ask(bad), /SHOPIFY_INPUT_INVALID/, why);
  const settle = o => contracts.validateHqShopifyStoreRequestSettle({ requestId: REQUEST, expectedVersion: 1, outcome: 'CREATED', shopDomain: 'synthetic-dojo.myshopify.com', ...o });
  assert.equal(settle({}).shopDomain, 'synthetic-dojo.myshopify.com'); assert.equal(settle({ outcome: 'DECLINED', shopDomain: null }).shopDomain, null);
  for (const bad of [{ shopDomain: null }, { shopDomain: 'synthetic-dojo.com' }, { outcome: 'DECLINED' }, { outcome: 'CANCELLED', shopDomain: null }, { expectedVersion: 0 }])
    assert.throws(() => settle(bad), /SHOPIFY_INPUT_INVALID/);
});

test('0655 answers: a made store carries its address, an open request has no end time, the lists keep open and closed apart', () => {
  assert.equal(contracts.verifyShopifyStoreRequestView({ schoolId: SCHOOL, request: null }).request, null);
  assert.equal(contracts.verifyShopifyStoreRequestView({ schoolId: SCHOOL, request: row({}) }).request.status, 'REQUESTED');
  const made = { status: 'CREATED', shopDomain: 'synthetic-dojo.myshopify.com', settledAt: '2026-11-22T21:00:00.000Z', version: 2 };
  assert.equal(contracts.verifyHqShopifyStoreRequest(hqRow(made)).shopDomain, 'synthetic-dojo.myshopify.com');
  for (const bad of [row({ status: 'CREATED' }), row({ shopDomain: 'synthetic-dojo.myshopify.com' }), row({ settledAt: '2026-11-22T21:00:00.000Z' }),
    row({ status: 'DECLINED' }), row({ ownerEmail: 'Owner@example.test' }), { ...row({}), secret: 1 }])
    assert.throws(() => contracts.verifyShopifyStoreRequestView({ schoolId: SCHOOL, request: bad }), /SHOPIFY_RESPONSE_INVALID/);
  assert.equal(contracts.verifyHqShopifyStoreRequests({ open: [hqRow({})], settled: [hqRow(made)] }).open.length, 1);
  assert.throws(() => contracts.verifyHqShopifyStoreRequests({ open: [hqRow(made)], settled: [] }), /SHOPIFY_RESPONSE_INVALID/);
  assert.throws(() => contracts.verifyHqShopifyStoreRequests({ open: [], settled: [hqRow({})] }), /SHOPIFY_RESPONSE_INVALID/);
});

test('0655 service: the subject comes from the session, the input is checked first, and answers for another school or request are refused', async () => {
  let s = service({ storeRequest: { schoolId: SCHOOL, request: null }, requestStore: { schoolId: SCHOOL, request: row({}) } });
  assert.equal((await s.svc.storeRequest(req, SCHOOL)).request, null);
  assert.deepEqual(s.calls[0], ['storeRequest', ['subject-1', SCHOOL]]);
  const input = { schoolId: SCHOOL, shopName: 'Synthetic Dojo Pro Shop', ownerEmail: 'owner@example.test', note: null };
  assert.equal((await s.svc.requestStore(req, input)).request.requestId, REQUEST);
  assert.deepEqual(JSON.parse(s.calls[1][1][1]), input);
  await assert.rejects(s.svc.requestStore(req, { ...input, ownerEmail: 'OWNER@example.test' }), e => e.getStatus() === 400);
  assert.equal(s.calls.length, 2, 'a bad input never reaches the database');
  await assert.rejects(s.svc.requestStore({}, input), e => e.getStatus() === 403);
  s = service({ storeRequest: { schoolId: '66666666-6666-4666-8666-666666666666', request: null } });
  await assert.rejects(s.svc.storeRequest(req, SCHOOL), e => e.getStatus() === 503);
  for (const [message, code, status] of [['SHOPIFY_STORE_REQUEST_OPEN', '55006', 409], ['SHOPIFY_STORE_REQUEST_CONNECTED', '55000', 409],
    ['SHOPIFY_STORE_REQUEST_LIMIT', '54000', 429], ['SHOPIFY_FORBIDDEN', '42501', 403]]) {
    s = service({ requestStore: refused(message, code) });
    await assert.rejects(s.svc.requestStore(req, input), e => e.getStatus() === status && e.getResponse().code === message, message);
  }
});

test('0655 HQ: the list and the settle answer are verified; someone who is not HQ is refused; a settled request cannot be settled again', async () => {
  const made = hqRow({ status: 'CREATED', shopDomain: 'synthetic-dojo.myshopify.com', settledAt: '2026-11-22T21:00:00.000Z', version: 2 });
  const body = { requestId: REQUEST, expectedVersion: 1, outcome: 'CREATED', shopDomain: 'synthetic-dojo.myshopify.com' };
  let s = service({ hqStoreRequests: { open: [hqRow({})], settled: [] }, settleStoreRequest: made });
  assert.equal((await s.svc.hqStoreRequests(req)).open[0].schoolName, 'Synthetic Dojo');
  assert.deepEqual(s.calls[0], ['hqStoreRequests', ['subject-1']]);
  assert.equal((await s.svc.settleStoreRequest(req, body)).status, 'CREATED');
  await assert.rejects(s.svc.settleStoreRequest(req, { ...body, outcome: 'DECLINED', shopDomain: null }), e => e.getStatus() === 503, 'an answer for a different outcome is refused');
  s = service({ hqStoreRequests: refused('SAAS_FORBIDDEN', '42501'), settleStoreRequest: refused('SHOPIFY_STORE_REQUEST_SETTLED', '55000') });
  await assert.rejects(s.svc.hqStoreRequests(req), e => e.getStatus() === 403 && e.getResponse().code === 'SHOPIFY_FORBIDDEN');
  await assert.rejects(s.svc.settleStoreRequest(req, body), e => e.getStatus() === 409);
});
