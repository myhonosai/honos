const { test } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('@hon/contracts');
const { ParentProShopService, translateParentProShopError } = require('../dist/pro-shop/parent-pro-shop.service.js');

// 0581 parent pro shop: the projection is verified exactly and the service refuses before any database call.
const item = (patch = {}) => ({ productId: '11', title: 'Sparring gloves', imageUrl: 'https://cdn.shopify.com/s/files/11.jpg', fromPrice: '19.50',
  url: 'https://dojo.myshopify.com/products/sparring-gloves', ...patch });

test('0581 projection is verified exactly', () => {
  const view = { schoolName: 'Dojo', available: true, currency: 'USD', products: [item(), item({ productId: '12', url: 'https://dojo.myshopify.com/products/belt' })] };
  assert.deepEqual(contracts.verifyParentProShop(view), view);
  assert.deepEqual(contracts.verifyParentProShop({ schoolName: 'Dojo', available: false, currency: null, products: [] }).available, false);
  for (const [label, bad] of [
    ['inventory', { ...view, products: [{ ...item(), inventoryQuantity: 3 }] }],
    ['another host', { ...view, products: [item({ url: 'https://evil.example/products/x' })] }],
    ['http link', { ...view, products: [item({ url: 'http://dojo.myshopify.com/products/x' })] }],
    ['two stores', { ...view, products: [item(), item({ productId: '12', url: 'https://other.myshopify.com/products/belt' })] }],
    ['image host', { ...view, products: [item({ imageUrl: 'https://evil.example/a.jpg' })] }],
    ['price', { ...view, products: [item({ fromPrice: '19.5' })] }],
    ['duplicate', { ...view, products: [item(), item()] }],
    ['unavailable with products', { ...view, available: false, currency: null }],
    ['no currency', { ...view, currency: null }],
  ]) assert.throws(() => contracts.verifyParentProShop(bad), undefined, label);
});

test('0581 service refuses before any database call and maps errors to closed codes', async () => {
  let calls = 0;
  const database = new Proxy({}, { get: () => () => { calls += 1; throw new Error('database must not be reached'); } });
  const service = new ParentProShopService(database);
  await assert.rejects(() => service.read(''), (e) => e.response.code === 'PARENT_PRO_SHOP_FORBIDDEN');
  await assert.rejects(() => service.read(' x'), (e) => e.response.code === 'PARENT_PRO_SHOP_FORBIDDEN');
  assert.equal(calls, 0);
  const code = (sqlState) => { try { translateParentProShopError(Object.assign(new Error('x'), { code: sqlState })); } catch (e) { return [e.getStatus(), e.response.code]; } };
  assert.deepEqual(code('42501'), [403, 'PARENT_PRO_SHOP_FORBIDDEN']);
  assert.deepEqual(code('08006'), [503, 'PARENT_PRO_SHOP_UNAVAILABLE']);
});
