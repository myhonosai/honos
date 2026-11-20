const { test } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('@hon/contracts');
const adapter = require('../dist/commerce/shopify/shopify-adapter.js');
const recipes = require('../dist/commerce/shopify/shopify-theme-recipes.js');
const { begunThemeWork, draftName, runThemeWork } = require('../dist/commerce/shopify/shopify-theme-engine.js');

// TB1 (0595) Theme Builder: everything here runs against the in-memory fake store. Nothing calls Shopify.
const SHOP = 'ima-theme.myshopify.com';
const CONN = '33333333-3333-4333-8333-333333333333';
const SCHOOL = '44444444-4444-4444-8444-444444444444';
const LIVE = '140000000001';
const THEME_SCOPES = ['read_products', 'read_orders', 'read_themes', 'write_themes'];

async function store(scopes = THEME_SCOPES) {
  const app = adapter.shopifyAppFromEnvironment({ HON_SHOPIFY_FAKE: '1' });
  const tokens = await app.adapter.exchangeCode(SHOP, new URLSearchParams(app.fake.approve(SHOP, 'S', undefined, scopes)).get('code'));
  const pair = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, accessExpiresAt: tokens.accessExpiresAt, refreshExpiresAt: tokens.refreshExpiresAt };
  const credential = { keyId: app.vault.keyId, sealed: app.vault.seal({ connectionId: CONN, shopDomain: SHOP }, pair), version: 1 };
  return { app, credential, token: tokens.accessToken };
}
function begun(s, over) {
  return begunThemeWork({ purpose: 'APPLY', leaseToken: 'l', connectionId: CONN, shopDomain: SHOP, recipe: 'PICKUP_NOTE', inputs: { text: 'Pick up at the front desk.' },
    editId: 'e', restore: null, baseTheme: null, draftTheme: null, credential: s.credential, ...over });
}
async function run(s, w) {
  const finished = [];
  const out = await runThemeWork(s.app, Date.now, w, { rotate: async () => ({}), finish: async (f, p) => { finished.push({ f, p }); return { f, p }; } });
  return { out, finished };
}

test('TB1 commands: a recipe with closed inputs to preview or apply, or an undo of one edit', () => {
  const base = { schoolId: SCHOOL, undoOf: null };
  assert.equal(contracts.validateShopifyThemeCommand({ ...base, purpose: 'PREVIEW', recipe: 'SCHOOL_COLORS', inputs: { primary: '#C8102E', secondary: null } }).recipe, 'SCHOOL_COLORS');
  assert.equal(contracts.validateShopifyThemeCommand({ schoolId: SCHOOL, purpose: 'UNDO', recipe: null, inputs: null, undoOf: CONN }).undoOf, CONN);
  for (const [bad, why] of [
    [{ ...base, purpose: 'PUBLISH', recipe: 'SIZE_GUIDE', inputs: { text: 'x' } }, 'no publish'],
    [{ ...base, purpose: 'APPLY', recipe: 'SCHOOL_COLORS', inputs: { primary: '#c8102e', secondary: null } }, 'upper-case hex only'],
    [{ ...base, purpose: 'APPLY', recipe: 'SIZE_GUIDE', inputs: { text: 'x', html: '<b>' } }, 'closed inputs'],
    [{ ...base, purpose: 'APPLY', recipe: 'PICKUP_NOTE', inputs: { text: 'x'.repeat(501) } }, 'pickup note at most 500'],
    [{ ...base, purpose: 'APPLY', recipe: 'LAYOUT', inputs: { text: 'x' } }, 'unknown recipe'],
    [{ ...base, purpose: 'APPLY', recipe: 'SIZE_GUIDE', inputs: { text: 'x' }, filename: 'layout/theme.liquid' }, 'no free filenames'],
  ]) assert.throws(() => contracts.validateShopifyThemeCommand(bad), /SHOPIFY_INPUT_INVALID/, why);
  // Connecting: Allow theme editing is its own optional switch.
  assert.equal(contracts.validateShopifyConnectInput({ schoolId: SCHOOL, shopDomain: SHOP, allowThemes: true }).allowThemes, true);
  assert.deepEqual([...contracts.SHOPIFY_THEME_SCOPES], ['read_themes', 'write_themes']);
  assert.equal(draftName('A'.repeat(60)).length, 50);
});

test('TB1 recipes keep JSON valid, keep the theme comment header and are idempotent', async () => {
  const s = await store();
  for (const [recipe, inputs] of [['SCHOOL_COLORS', { primary: '#C8102E', secondary: '#FFD100' }], ['SIZE_GUIDE', { text: 'Size 0: 100-110 cm' }], ['PICKUP_NOTE', { text: 'Front desk' }]]) {
    const r = recipes.themeRecipe({ recipe, ...inputs });
    const files = await s.app.adapter.themeFiles(SHOP, s.token, LIVE, [...recipes.THEME_RECIPE_FILES[recipe]]);
    const once = recipes.applyThemeRecipe(r, files);
    assert.equal(once.ok, true, recipe);
    for (const f of once.files) {
      assert.notEqual(f.after, f.before, recipe + ' changes ' + f.filename);
      assert.ok(f.after.startsWith('/*'), 'keeps the header comment');
      JSON.parse(f.after.replace(/^\/\*[\s\S]*?\*\//, ''));
    }
    const twice = recipes.applyThemeRecipe(r, once.files.map(f => ({ filename: f.filename, content: f.after })));
    assert.ok(twice.files.every(f => f.before === f.after), recipe + ' twice changes nothing');
  }
  assert.equal(recipes.applyThemeRecipe(recipes.themeRecipe({ recipe: 'PICKUP_NOTE', text: 'x' }), []).problem, 'FILE_MISSING');
});

test('TB1 preview reads the live theme and writes nothing', async () => {
  const s = await store();
  const before = s.app.fake.themeFile(SHOP, LIVE, 'templates/cart.json');
  const { finished } = await run(s, begun(s, { purpose: 'PREVIEW', editId: null }));
  assert.equal(finished[0].f.outcome, 'DONE');
  assert.equal(finished[0].f.draftTheme, null);
  assert.deepEqual(finished[0].p.target, { id: LIVE, name: 'Dawn' });
  assert.equal(finished[0].p.files[0].changed, true);
  assert.equal(s.app.fake.themeFile(SHOP, LIVE, 'templates/cart.json'), before);
  assert.ok(s.app.fake.calls.every(c => !c.startsWith('themeDuplicate') && !c.startsWith('themeFilesUpsert')));
});

test('TB1 apply makes an UNPUBLISHED copy once, writes only there, and undo restores it', async () => {
  const s = await store();
  const live = s.app.fake.themeFile(SHOP, LIVE, 'templates/cart.json');
  const first = (await run(s, begun(s))).finished[0].f;
  assert.equal(first.outcome, 'APPLIED');
  assert.equal(first.baseTheme.id, LIVE);
  assert.equal(first.draftTheme.name, 'HON draft - Dawn');
  const draft = first.draftTheme;
  assert.equal(s.app.fake.themeFile(SHOP, LIVE, 'templates/cart.json'), live, 'the live theme is untouched');
  assert.equal(s.app.fake.themeFile(SHOP, draft.id, 'templates/cart.json'), first.files[0].after);
  const roles = await s.app.adapter.themes(SHOP, s.token);
  assert.equal(roles.find(t => t.id === draft.id).role, 'UNPUBLISHED');
  // A second edit reuses the copy.
  const second = (await run(s, begun(s, { recipe: 'SIZE_GUIDE', inputs: { text: 'Size 1: 110-120 cm' }, baseTheme: first.baseTheme, draftTheme: draft }))).finished[0].f;
  assert.equal(second.outcome, 'APPLIED');
  assert.equal(s.app.fake.calls.filter(c => c.startsWith('themeDuplicate')).length, 1);
  // Undo the first edit.
  const undo = (await run(s, begun(s, { purpose: 'UNDO', restore: first.files, baseTheme: first.baseTheme, draftTheme: draft }))).finished[0].f;
  assert.equal(undo.outcome, 'APPLIED');
  assert.equal(s.app.fake.themeFile(SHOP, draft.id, 'templates/cart.json'), first.files[0].before);
  // Undo again: the copy no longer has what that edit wrote.
  const again = (await run(s, begun(s, { purpose: 'UNDO', restore: first.files, baseTheme: first.baseTheme, draftTheme: draft }))).finished[0].f;
  assert.deepEqual([again.outcome, again.failureCode], ['FAILED', 'CHANGED_SINCE']);
});

test('TB1 a refused write is FAILED, a lost answer is UNKNOWN, and the live theme is refused outright', async () => {
  const s = await store();
  s.app.fake.writeFault = 'REJECT';
  assert.equal((await run(s, begun(s))).finished[0].f.outcome, 'FAILED');
  const s2 = await store();
  const first = (await run(s2, begun(s2))).finished[0].f;
  s2.app.fake.writeFault = 'LOSE_ANSWER';
  const lost = (await run(s2, begun(s2, { recipe: 'SIZE_GUIDE', inputs: { text: 'x' }, baseTheme: first.baseTheme, draftTheme: first.draftTheme }))).finished[0].f;
  assert.equal(lost.outcome, 'UNKNOWN');
  await assert.rejects(s2.app.adapter.upsertThemeFiles(SHOP, s2.token, LIVE, [{ filename: 'templates/cart.json', content: '{}' }]),
    e => e instanceof adapter.ShopifyProviderError);
  assert.equal(s2.app.fake.themeFile(SHOP, LIVE, 'templates/cart.json').includes('hon-pickup-note'), false);
  // A recorded copy that is gone (or was published) stops the work before any write.
  const gone = (await run(s2, begun(s2, { baseTheme: first.baseTheme, draftTheme: { id: LIVE, name: 'Dawn' } }))).finished[0].f;
  assert.deepEqual([gone.outcome, gone.failureCode], ['FAILED', 'DRAFT_THEME_MISSING']);
  // Without write_themes Shopify answers ACCESS_DENIED, which HON cannot tell apart from a bad answer: UNKNOWN, and no copy exists.
  const s3 = await store(['read_products', 'read_orders', 'read_themes']);
  assert.equal((await run(s3, begun(s3))).finished[0].f.outcome, 'UNKNOWN');
  assert.equal((await s3.app.adapter.themes(SHOP, s3.token)).length, 1);
});

test('TB1 begin answers of the wrong shape are refused', async () => {
  const s = await store();
  assert.equal(begun(s, { purpose: 'PREVIEW' }), null, 'preview has no edit');
  assert.equal(begun(s, { purpose: 'UNDO', restore: [] }), null, 'undo needs the copy');
  assert.equal(begun(s, { recipe: 'LAYOUT' }), null);
  assert.equal(begun(s, { draftTheme: { id: 'gid://x', name: 'y' } }), null);
});
