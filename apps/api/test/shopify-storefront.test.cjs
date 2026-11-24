const { test } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('@hon/contracts');
const adapter = require('../dist/commerce/shopify/shopify-adapter.js');
const { begunStorefrontPublish, runStorefrontPublish } = require('../dist/commerce/shopify/shopify-storefront-engine.js');
const { storefrontLinks } = require('../dist/commerce/shopify/shopify.service.js');

// TB2 (0609) storefront blocks: everything here runs against the in-memory fake store or a stubbed fetch. Nothing calls Shopify.
const SHOP = 'ima-storefront.myshopify.com';
const CONN = '33333333-3333-4333-8333-333333333333';
const SCHOOL = '44444444-4444-4444-8444-444444444444';
const SETTINGS = { primaryColor: '#C8102E', accentColor: null, sizeGuideTitle: 'Uniform sizes', sizeGuideText: 'Size 0: 100-110 cm\nSize 1: 110-120 cm', pickupNote: 'Pick up at the front desk.' };
const settingsFrom = v => contracts.validateShopifyStorefrontSave({ schoolId: SCHOOL, expectedVersion: null, settings: v }).settings;

async function store(scopes = ['read_products', 'read_orders']) {
  const app = adapter.shopifyAppFromEnvironment({ HON_SHOPIFY_FAKE: '1' });
  const tokens = await app.adapter.exchangeCode(SHOP, new URLSearchParams(app.fake.approve(SHOP, 'S', undefined, scopes)).get('code'));
  const pair = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, accessExpiresAt: tokens.accessExpiresAt, refreshExpiresAt: tokens.refreshExpiresAt };
  const credential = { keyId: app.vault.keyId, sealed: app.vault.seal({ connectionId: CONN, shopDomain: SHOP }, pair), version: 1 };
  return { app, credential, token: tokens.accessToken };
}
function begun(s, over) {
  return begunStorefrontPublish({ leaseToken: 'l', connectionId: CONN, shopDomain: SHOP, settingsVersion: 3, settings: SETTINGS, credential: s.credential, ...over }, settingsFrom);
}
async function run(s, w, now = Date.now) {
  const finished = [], rotated = [];
  await runStorefrontPublish(s.app, now, w, { rotate: async b => { rotated.push(b); return {}; }, finish: async (o, f) => { finished.push([o, f]); return null; } });
  return { finished, rotated };
}
function storefront(over) {
  return { schoolId: SCHOOL, connected: true, shopDomain: SHOP, settings: SETTINGS, settingsVersion: 2, savedAt: '2026-11-20T10:00:00.000Z',
    publishedVersion: 1, publishedAt: '2026-11-20T09:00:00.000Z', publishStatus: 'PUBLISHED', failureCode: null, busy: false,
    links: storefrontLinks(SHOP, 'hon-fake-shopify-app'), ...over };
}

test('TB2 settings: closed keys, upper-case hex colors, bounded text, a title needs text', () => {
  const save = s => contracts.validateShopifyStorefrontSave({ schoolId: SCHOOL, expectedVersion: 1, settings: { ...SETTINGS, ...s } });
  assert.equal(save({}).settings.primaryColor, '#C8102E');
  assert.equal(save({ sizeGuideTitle: null, sizeGuideText: null, pickupNote: null, accentColor: '#FFD100' }).settings.accentColor, '#FFD100');
  assert.equal(contracts.validateShopifyStorefrontSave({ schoolId: SCHOOL, expectedVersion: null, settings: SETTINGS }).expectedVersion, null);
  for (const [bad, why] of [
    [{ primaryColor: '#c8102e' }, 'upper-case hex only'], [{ primaryColor: 'red' }, 'hex only'], [{ primaryColor: null }, 'a primary color is required'],
    [{ accentColor: '#FFF' }, 'six digits'], [{ sizeGuideTitle: 'x'.repeat(61) }, 'title at most 60'], [{ sizeGuideText: 'x'.repeat(2001) }, 'guide at most 2000'],
    [{ pickupNote: 'x'.repeat(501) }, 'pickup note at most 500'], [{ sizeGuideText: null }, 'a title needs text'], [{ html: '<b>' }, 'closed keys'],
  ]) assert.throws(() => save(bad), /SHOPIFY_INPUT_INVALID/, why);
  assert.throws(() => contracts.validateShopifyStorefrontPublish({ schoolId: SCHOOL, settingsVersion: 0 }), /SHOPIFY_INPUT_INVALID/);
  // Connecting has no theme switch any more: the storefront blocks need no scope.
  assert.throws(() => contracts.validateShopifyConnectInput({ schoolId: SCHOOL, shopDomain: SHOP, allowThemes: true }), /SHOPIFY_INPUT_INVALID/);
  assert.equal(contracts.SHOPIFY_THEME_SCOPES, undefined);
});

test('TB2 view: states must agree and links stay on the store\'s own admin', () => {
  const v = contracts.verifyShopifyStorefront(storefront());
  assert.match(v.links.sizeGuide, /\/admin\/themes\/current\/editor\?template=product&addAppBlockId=hon-fake-shopify-app\/size-guide&target=mainSection$/);
  assert.match(v.links.colors, /context=apps&template=index&activateAppId=hon-fake-shopify-app\/school-colors$/);
  assert.match(v.links.pickupNote, /template=cart&addAppBlockId=hon-fake-shopify-app\/pickup-note&target=newAppsSection$/);
  assert.match(v.links.pickupBanner, /context=apps&template=cart&activateAppId=hon-fake-shopify-app\/pickup-note-banner$/);
  contracts.verifyShopifyStorefront(storefront({ connected: false, shopDomain: null, settings: null, settingsVersion: null, savedAt: null, publishedVersion: null,
    publishedAt: null, publishStatus: 'NEVER', links: null }));
  for (const [bad, why] of [
    [{ links: storefrontLinks('other-store.myshopify.com', 'x') }, 'links on another store'],
    [{ links: { ...storefrontLinks(SHOP, 'x'), colors: 'https://evil.example/admin/themes/current/editor?x=1' } }, 'links off Shopify'],
    [{ publishStatus: 'PUBLISHING' }, 'busy must match PUBLISHING'], [{ publishStatus: 'FAILED' }, 'FAILED needs a code'],
    [{ publishedVersion: 3 }, 'cannot publish a version not saved yet'], [{ connected: false }, 'connected needs a store'],
    [{ settings: null }, 'settings, version and time come together'], [{ publishedAt: null }, 'published version and time come together'],
  ]) assert.throws(() => contracts.verifyShopifyStorefront(storefront(bad)), /SHOPIFY_RESPONSE_INVALID/, why);
});

test('TB2 publish writes only HON\'s settings metafield, with no theme scope, and is idempotent', async () => {
  const s = await store();
  assert.equal(s.app.fake.storefrontSettings(SHOP), null);
  assert.deepEqual((await run(s, begun(s))).finished, [['PUBLISHED', null]]);
  assert.deepEqual(JSON.parse(s.app.fake.storefrontSettings(SHOP)), SETTINGS);
  assert.deepEqual((await run(s, begun(s))).finished, [['PUBLISHED', null]]);
  assert.deepEqual(JSON.parse(s.app.fake.storefrontSettings(SHOP)), SETTINGS);
  assert.deepEqual(s.app.fake.calls.filter(c => !c.startsWith('exchange')), ['storefrontSettings:' + SHOP, 'storefrontSettings:' + SHOP]);
});

test('TB2 a refused write is FAILED, a lost answer is UNKNOWN and publishing again settles it', async () => {
  const s = await store();
  s.app.fake.writeFault = 'REJECT';
  assert.deepEqual((await run(s, begun(s))).finished, [['FAILED', 'SHOPIFY_REJECTED']]);
  assert.equal(s.app.fake.storefrontSettings(SHOP), null);
  s.app.fake.writeFault = 'LOSE_ANSWER';
  assert.equal((await run(s, begun(s))).finished[0][0], 'UNKNOWN');
  assert.deepEqual((await run(s, begun(s))).finished, [['PUBLISHED', null]]);
  s.app.fake.rejectTokens(SHOP);
  assert.equal((await run(s, begun(s))).finished[0][0], 'FAILED', 'a rejected token wrote nothing');
});

test('TB2 an unreadable credential or expired refresh fails before any write; a near-expiry token is refreshed and rotated', async () => {
  const s = await store();
  assert.deepEqual((await run(s, begun(s, { connectionId: '55555555-5555-4555-8555-555555555555' }))).finished, [['FAILED', 'CREDENTIAL_UNREADABLE']]);
  const later = () => Date.now() + 3600_000 - 1000;
  const r = await run(s, begun(s), later);
  assert.equal(r.rotated.length, 1);
  assert.equal(r.rotated[0].expectedVersion, 1);
  assert.equal(JSON.stringify(r.rotated).includes('fake_at_'), false, 'only sealed tokens leave the engine');
  assert.deepEqual(r.finished, [['PUBLISHED', null]]);
  assert.deepEqual((await run(s, begun(s), () => Date.now() + 91 * 86400_000)).finished, [['FAILED', 'REFRESH_EXPIRED']]);
  assert.equal(s.app.fake.calls.filter(c => c.startsWith('storefrontSettings')).length, 1);
});

test('TB2 begin answers of the wrong shape are refused', async () => {
  const s = await store();
  assert.equal(begun(s, { settings: { ...SETTINGS, primaryColor: 'red' } }), null);
  assert.equal(begun(s, { settings: { ...SETTINGS, script: '<script>' } }), null);
  assert.equal(begun(s, { settingsVersion: '3' }), null);
  assert.equal(begun(s, { credential: { keyId: 'k' } }), null);
});

test('TB2 GraphQL: metafieldsSet on the current app installation, user errors are REJECTED, odd answers are refused', async () => {
  const sent = [];
  const answer = data => async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ data: data(sent.length) }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  const ok = n => n % 2 === 1 ? { currentAppInstallation: { id: 'gid://shopify/AppInstallation/42' } }
    : { metafieldsSet: { metafields: [{ namespace: 'hon_storefront', key: 'settings' }], userErrors: [] } };
  await new adapter.GraphqlShopifyAdapter('client', 'secret', answer(ok), async () => {}).setStorefrontSettings(SHOP, 'tok', SETTINGS);
  assert.equal(sent.length, 2);
  assert.match(sent[0].url, /^https:\/\/ima-storefront\.myshopify\.com\/admin\/api\/[0-9-]+\/graphql\.json$/);
  assert.match(sent[1].body.query, /metafieldsSet/);
  assert.doesNotMatch(sent.map(x => x.body.query).join(), /theme|asset/i);
  assert.deepEqual(sent[1].body.variables.metafields, [{ ownerId: 'gid://shopify/AppInstallation/42', namespace: 'hon_storefront', key: 'settings', type: 'json', value: adapter.storefrontValue(SETTINGS) }]);
  const fails = async (data, failure) => {
    sent.length = 0;
    await assert.rejects(new adapter.GraphqlShopifyAdapter('client', 'secret', answer(data), async () => {}).setStorefrontSettings(SHOP, 'tok', SETTINGS),
      e => e instanceof adapter.ShopifyProviderError && e.failure === failure);
  };
  await fails(n => n === 1 ? ok(1) : { metafieldsSet: { metafields: [], userErrors: [{ field: ['value'], message: 'x' }] } }, 'REJECTED');
  await fails(() => ({ currentAppInstallation: { id: 'gid://shopify/Shop/1' } }), 'INVALID_RESPONSE');
  await fails(n => n === 1 ? ok(1) : { metafieldsSet: { metafields: [{ namespace: 'other', key: 'settings' }], userErrors: [] } }, 'INVALID_RESPONSE');
});
