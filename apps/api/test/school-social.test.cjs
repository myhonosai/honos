const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { SchoolSocialService } = require('../dist/marketing/social/school-social.service.js');
const {
  FakeZernioSocialAdapter, ZernioHttpSocialAdapter, SocialProviderError, allowedConnectUrl, zernioConnectApproved, zernioFakeEnabled, zernioSocialAdapterFactory,
} = require('../dist/marketing/social/zernio-social-adapter.js');
const { validateDeploymentConfiguration } = require('../dist/foundation/production-config.js');

// Mocked boundary tests for the 0347 social connection API. Authority, single-use state, conflicts and evidence are
// proven against PostgreSQL by test-school-social-connections.mjs. No test reaches Zernio: the HTTP adapter gets a stub fetch.
const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const context = (patch = {}) => ({ ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: 'soc-key', externalSubject: 'verified-human', ...patch });
const status = (value, code) => (error) => { assert.equal(error.getStatus(), value, JSON.stringify(error.getResponse?.())); if (code) assert.equal(error.getResponse().code, code); return true; };
const KEY = 'sk_' + 'a'.repeat(64);
const at = '2026-11-14T05:00:00.000Z';
const accountId = randomUUID();
const account = (patch = {}) => ({ accountId, platform: 'FACEBOOK', displayName: 'Synthetic Dojo Page', status: 'CONNECTED', publishEnabled: false, inboxEnabled: false,
  adsEnabled: false, version: 1, connectedAt: at, updatedAt: at, disconnectedAt: null, ...patch });
const withEnv = async (patch, work) => {
  const saved = {}; for (const k of Object.keys(patch)) { saved[k] = process.env[k]; if (patch[k] === undefined) delete process.env[k]; else process.env[k] = patch[k]; }
  try { return await work(); } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};
const fakeEnv = { HON_ZERNIO_FAKE_PROVIDER: '1', HON_DEPLOYMENT_ENVIRONMENT: 'development', HON_PUBLIC_ORIGIN: 'http://127.0.0.1:3000' };

function fixture(options = {}) {
  const queries = [];
  const db = {
    async transaction(c, work, readOnly) {
      return work({ query: async (sql, args = []) => {
        queries.push({ sql, args, readOnly });
        if (/^SET LOCAL/.test(sql) || /set_config\('app\.hon_source','HUMAN_UI'/.test(sql)) return { rows: [] };
        if (options.error) throw options.error;
        if (/read_school_social_accounts/.test(sql)) return { rows: [{ data: { profileLinked: false, accounts: [account()], checkedAt: at } }] };
        if (/start_school_social_connect/.test(sql)) return { rows: [{ data: { intentId: randomUUID(), platform: JSON.parse(args[1]).platform, expiresAt: at, providerProfileId: options.profile ?? null } }] };
        if (/record_school_social_profile/.test(sql)) return { rows: [{ data: { providerProfileId: args[2], linked: true } }] };
        if (/claim_school_social_connect/.test(sql)) return { rows: [{ data: { intentId: randomUUID(), platform: options.platform ?? 'FACEBOOK', providerProfileId: options.profile ?? 'prof_1' } }] };
        if (/record_school_social_accounts/.test(sql)) return { rows: [{ data: { platform: 'FACEBOOK', connected: JSON.parse(args[2]).length, conflicts: 0, accounts: [account()] } }] };
        if (/change_school_social_account/.test(sql)) return { rows: [{ data: options.change ?? { record: account(), replayed: false } }] };
        throw new Error('Unexpected SQL: ' + sql);
      } });
    },
    withTenantTransaction(c, work) { return this.transaction(c, work, false); },
    withTenantReadOnlyTransaction(c, work) { return this.transaction(c, work, true); },
  };
  return { db, queries };
}

test('switches: connecting needs a well-formed key AND the exact approval; the fake only outside production and staging', () => {
  assert.equal(zernioConnectApproved({}), false);
  assert.equal(zernioConnectApproved({ ZERNIO_API_KEY: KEY }), false);
  assert.equal(zernioConnectApproved({ ZERNIO_API_KEY: KEY, HON_ZERNIO_CONNECT_APPROVED: 'TRUE' }), false);
  assert.equal(zernioConnectApproved({ ZERNIO_API_KEY: 'sk_short', HON_ZERNIO_CONNECT_APPROVED: 'true' }), false);
  assert.equal(zernioConnectApproved({ ZERNIO_API_KEY: KEY, HON_ZERNIO_CONNECT_APPROVED: 'true' }), true);
  assert.equal(zernioFakeEnabled({ HON_ZERNIO_FAKE_PROVIDER: '1', HON_DEPLOYMENT_ENVIRONMENT: 'development' }), true);
  for (const env of [{ HON_ZERNIO_FAKE_PROVIDER: '1', HON_DEPLOYMENT_ENVIRONMENT: 'production' }, { HON_ZERNIO_FAKE_PROVIDER: '1', HON_DEPLOYMENT_ENVIRONMENT: 'staging' },
    { HON_ZERNIO_FAKE_PROVIDER: '1', NODE_ENV: 'production' }, { HON_ZERNIO_FAKE_PROVIDER: 'true' }]) assert.equal(zernioFakeEnabled(env), false, JSON.stringify(env));
  assert.equal(zernioSocialAdapterFactory({}).kind, 'NONE'); assert.equal(zernioSocialAdapterFactory({}).ready(), false);
  assert.equal(zernioSocialAdapterFactory({ ZERNIO_API_KEY: KEY, HON_ZERNIO_CONNECT_APPROVED: 'true' }).kind, 'ZERNIO');
  assert.equal(zernioSocialAdapterFactory({ HON_ZERNIO_FAKE_PROVIDER: '1', HON_DEPLOYMENT_ENVIRONMENT: 'development' }).kind, 'FAKE');
  const prod = validateDeploymentConfiguration({ HON_DEPLOYMENT_ENVIRONMENT: 'production', HON_ZERNIO_FAKE_PROVIDER: '1' });
  assert(prod.failures.includes('ZERNIO_FAKE_PROVIDER_FORBIDDEN'));
});

test('connect URLs: https on Zernio or Meta consent hosts only; the fake may only point at HON\'s own return page', () => {
  for (const ok of ['https://zernio.com/connect/abc', 'https://app.zernio.com/x', 'https://www.facebook.com/v20.0/dialog/oauth?x=1', 'https://instagram.com/oauth/authorize']) assert(allowedConnectUrl(ok), ok);
  for (const bad of ['http://zernio.com/x', 'https://zernio.com.evil.test/x', 'https://evil.test/?zernio.com', 'https://user:pw@zernio.com/', 'https://zernio.com:8443/',
    'javascript:alert(1)', 'not a url', 'https://facebook.com.evil.test/']) assert(!allowedConnectUrl(bad), bad);
  const back = 'http://127.0.0.1:3000/staff/marketing/social/return';
  assert(allowedConnectUrl(back + '?state=x', back));
  assert(!allowedConnectUrl('http://127.0.0.1:3000/other?state=x', back)); assert(!allowedConnectUrl('https://zernio.com/x', back));
});

test('read is one read-only call and reports connecting as off unless the adapter is ready and a return origin exists', async () => {
  const f = fixture();
  await withEnv({ HON_ZERNIO_FAKE_PROVIDER: undefined, HON_PUBLIC_ORIGIN: undefined }, async () => {
    const svc = new SchoolSocialService(f.db, zernioSocialAdapterFactory({}));
    const list = await svc.list(context({ idempotencyKey: '' }));
    assert.equal(list.connectEnabled, false); assert.equal(list.accounts.length, 1);
    assert.equal(f.queries.find(q => q.sql.includes('read_school_social')).readOnly, true);
  });
  await withEnv(fakeEnv, async () => {
    const svc = new SchoolSocialService(f.db, new FakeZernioSocialAdapter());
    assert.equal((await svc.list(context({ idempotencyKey: '' }))).connectEnabled, true);
  });
  await assert.rejects(new SchoolSocialService(f.db, new FakeZernioSocialAdapter()).list(context()), status(403, 'SOCIAL_FORBIDDEN'));
});

test('start: refused when not turned on, before any database write; with the fake it stores only a hash of the state and finds the profile by HON\'s name', async () => {
  let f = fixture();
  await withEnv({ HON_ZERNIO_FAKE_PROVIDER: undefined, HON_PUBLIC_ORIGIN: 'https://app.example.test' }, async () => {
    await assert.rejects(new SchoolSocialService(f.db, zernioSocialAdapterFactory({})).start(context(), { platform: 'FACEBOOK' }), status(503, 'SOCIAL_CONNECT_NOT_ENABLED'));
    assert.equal(f.queries.length, 0);
  });
  await withEnv(fakeEnv, async () => {
    const fake = new FakeZernioSocialAdapter(); f = fixture();
    const svc = new SchoolSocialService(f.db, fake);
    await assert.rejects(svc.start(context(), { platform: 'TIKTOK' }), status(400, 'SOCIAL_INVALID'));
    await assert.rejects(svc.start(context(), { platform: 'FACEBOOK', redirect: 'https://evil.test' }), status(400, 'SOCIAL_INVALID'));
    const c = context(); const r = await svc.start(c, { platform: 'FACEBOOK' });
    const url = new URL(r.authUrl); assert.equal(url.origin + url.pathname, 'http://127.0.0.1:3000/staff/marketing/social/return');
    const state = url.searchParams.get('state'); assert.match(state, /^[A-Za-z0-9_-]{43}$/);
    const start = f.queries.find(q => q.sql.includes('start_school_social_connect'));
    assert.equal(start.args[2], createHash('sha256').update(state).digest('hex')); assert(!JSON.stringify(f.queries).includes(state));
    assert.deepEqual([...fake.profiles.keys()], ['hon-school-' + scope.schoolId]);
    const linked = f.queries.find(q => q.sql.includes('record_school_social_profile')); assert.equal(linked.args[2], fake.profiles.get('hon-school-' + scope.schoolId));
    // A linked profile is reused without asking the provider for one.
    f = fixture({ profile: 'prof_existing' }); const fake2 = new FakeZernioSocialAdapter();
    await new SchoolSocialService(f.db, fake2).start(context(), { platform: 'INSTAGRAM' });
    assert.equal(fake2.profiles.size, 0); assert(!f.queries.some(q => q.sql.includes('record_school_social_profile')));
    // Provider failures say nothing was connected; an unexpected URL host is refused.
    f = fixture(); const fake3 = new FakeZernioSocialAdapter(); fake3.failNext.findOrCreateProfile = 'UNKNOWN';
    await assert.rejects(new SchoolSocialService(f.db, fake3).start(context(), { platform: 'FACEBOOK' }), status(502, 'SOCIAL_PROVIDER_UNAVAILABLE'));
    const fake4 = new FakeZernioSocialAdapter(); fake4.connectUrl = async () => 'https://evil.test/steal';
    await assert.rejects(new SchoolSocialService(fixture().db, fake4).start(context(), { platform: 'FACEBOOK' }), status(502, 'SOCIAL_PROVIDER_UNAVAILABLE'));
  });
});

test('complete: the claim uses the hash; only the claimed platform\'s accounts from the school\'s own profile are recorded, at most 25, no duplicates', async () => {
  await withEnv(fakeEnv, async () => {
    const fake = new FakeZernioSocialAdapter();
    fake.extra.set('prof_1', [
      { providerAccountId: 'ig_1', platform: 'INSTAGRAM', displayName: 'ig' },
      ...Array.from({ length: 30 }, (_, i) => ({ providerAccountId: 'fb_' + (i % 27), platform: 'FACEBOOK', displayName: 'Page ' + i })),
    ]);
    const f = fixture(); const svc = new SchoolSocialService(f.db, fake);
    await assert.rejects(svc.complete(context(), { state: 'short' }), status(400, 'SOCIAL_CONNECT_STATE_INVALID'));
    await assert.rejects(svc.complete(context(), { state: 'a'.repeat(43), accountId: 'fb_attacker' }), status(400, 'SOCIAL_CONNECT_STATE_INVALID'));
    const state = 'b'.repeat(43); const r = await svc.complete(context(), { state });
    assert.equal(r.connected, 25);
    const claim = f.queries.find(q => q.sql.includes('claim_school_social_connect')); assert.equal(claim.args[1], createHash('sha256').update(state).digest('hex'));
    const recorded = JSON.parse(f.queries.find(q => q.sql.includes('record_school_social_accounts')).args[2]);
    assert.equal(recorded.length, 25); assert(recorded.every(a => a.providerAccountId.startsWith('fb_') && Object.keys(a).sort().join() === 'displayName,providerAccountId'));
    assert.equal(new Set(recorded.map(a => a.providerAccountId)).size, 25);
    const failing = new FakeZernioSocialAdapter(); failing.failNext.listAccounts = 'UNAVAILABLE';
    const g = fixture();
    await assert.rejects(new SchoolSocialService(g.db, failing).complete(context(), { state }), status(502, 'SOCIAL_PROVIDER_UNAVAILABLE'));
    assert(!g.queries.some(q => q.sql.includes('record_school_social_accounts')));
  });
});

test('change: exact body and key; disconnect asks Zernio to remove the account once, reports the result, and never returns the provider id', async () => {
  await withEnv(fakeEnv, async () => {
    const fake = new FakeZernioSocialAdapter();
    let f = fixture(); let svc = new SchoolSocialService(f.db, fake);
    const body = { expectedVersion: 1, publishEnabled: true, inboxEnabled: false, adsEnabled: false };
    const c = context(); const r = await svc.change(c, accountId, body);
    assert.equal(r.providerRemoval, 'NOT_ATTEMPTED');
    const call = f.queries.find(q => q.sql.includes('change_school_social_account')); assert.deepEqual(JSON.parse(call.args[2]), body); assert.equal(call.args[3], 'soc-key');
    for (const bad of [{ expectedVersion: 1, disconnect: false }, { expectedVersion: 0, disconnect: true }, { expectedVersion: 1, publishEnabled: 'yes', inboxEnabled: false, adsEnabled: false },
      { expectedVersion: 1, publishEnabled: true, inboxEnabled: false }, { expectedVersion: 1, disconnect: true, publishEnabled: false }]) {
      await assert.rejects(svc.change(context(), accountId, bad), status(400, 'SOCIAL_INVALID'), JSON.stringify(bad));
    }
    const off = account({ status: 'DISCONNECTED', version: 2, disconnectedAt: at });
    f = fixture({ change: { record: { ...off, providerAccountId: 'fbpage_1' }, replayed: false } }); svc = new SchoolSocialService(f.db, fake);
    const d = await svc.change(context(), accountId, { expectedVersion: 1, disconnect: true });
    assert.equal(d.providerRemoval, 'REMOVED'); assert.deepEqual(fake.removed, ['fbpage_1']); assert(!JSON.stringify(d).includes('fbpage_1'));
    f = fixture({ change: { record: { ...off, providerAccountId: 'fbpage_1' }, replayed: true } }); svc = new SchoolSocialService(f.db, fake);
    assert.equal((await svc.change(context(), accountId, { expectedVersion: 1, disconnect: true })).providerRemoval, 'NOT_ATTEMPTED'); assert.equal(fake.removed.length, 1);
    fake.failNext.removeAccount = 'UNKNOWN';
    f = fixture({ change: { record: { ...off, providerAccountId: 'fbpage_1' }, replayed: false } }); svc = new SchoolSocialService(f.db, fake);
    assert.equal((await svc.change(context(), accountId, { expectedVersion: 1, disconnect: true })).providerRemoval, 'NOT_REMOVED');
    // A receipt for another account, or a disconnected account with a switch on, is not accepted.
    f = fixture({ change: { record: account({ accountId: randomUUID() }), replayed: false } });
    await assert.rejects(new SchoolSocialService(f.db, fake).change(context(), accountId, body));
    f = fixture({ change: { record: { ...off, adsEnabled: true }, replayed: false } });
    await assert.rejects(new SchoolSocialService(f.db, fake).change(context(), accountId, { expectedVersion: 1, disconnect: true }));
  });
});

test('database errors map to closed codes; unknown errors never claim a result', async () => {
  for (const [message, code, http] of [['SOCIAL_FORBIDDEN', '42501', 403], ['SOCIAL_CONNECT_STATE_EXPIRED', '22023', 400], ['SOCIAL_RATE_LIMITED', '54000', 429],
    ['SOCIAL_VERSION_CONFLICT', '40001', 409], ['SOCIAL_ACCOUNT_DISCONNECTED', '23514', 409], ['SOCIAL_ACCOUNT_NOT_FOUND', 'P0002', 404], ['SOCIAL_PROFILE_CONFLICT', '23505', 409]]) {
    const error = Object.assign(new Error(message), { code });
    await withEnv(fakeEnv, () => assert.rejects(new SchoolSocialService(fixture({ error }).db, new FakeZernioSocialAdapter()).change(context(), accountId, { expectedVersion: 1, disconnect: true }), status(http, message)));
  }
  await withEnv(fakeEnv, () => assert.rejects(new SchoolSocialService(fixture({ error: new Error('boom') }).db, new FakeZernioSocialAdapter()).list(context({ idempotencyKey: '' })), status(503, 'SOCIAL_UNAVAILABLE')));
});

test('HTTP adapter: refuses to call unless approved; fixed origin, no redirects, bearer key only; drops provider fields and never leaks bodies', async () => {
  const calls = [];
  const reply = (status, body, type = 'application/json') => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': type } });
  const routes = [];
  const send = async (url, init) => { calls.push({ url, init }); const r = routes.shift(); return typeof r === 'function' ? r(url, init) : r; };
  let env = {};
  const adapter = new ZernioHttpSocialAdapter(() => env, send);
  await assert.rejects(adapter.listAccounts('prof_1'), e => e instanceof SocialProviderError && e.failure === 'NOT_ENABLED'); assert.equal(calls.length, 0);
  env = { ZERNIO_API_KEY: KEY, HON_ZERNIO_CONNECT_APPROVED: 'true' };
  routes.push(reply(200, { profiles: [{ _id: 'other', name: 'hon-school-x' }] }), reply(201, { profile: { _id: 'prof_new', name: 'hon-school-y' } }));
  assert.equal(await adapter.findOrCreateProfile('hon-school-y'), 'prof_new');
  assert.equal(calls[0].url, 'https://zernio.com/api/v1/profiles'); assert.equal(calls[0].init.redirect, 'error'); assert.equal(calls[0].init.headers.Authorization, 'Bearer ' + KEY);
  assert.equal(calls[1].init.method, 'POST'); assert.deepEqual(JSON.parse(calls[1].init.body).name, 'hon-school-y');
  routes.push(reply(200, { profiles: [{ _id: 'p1', name: 'hon-school-y' }, { _id: 'p2', name: 'hon-school-y' }] }));
  await assert.rejects(adapter.findOrCreateProfile('hon-school-y'), e => e.failure === 'UNKNOWN');
  routes.push(reply(200, { authUrl: 'https://www.facebook.com/dialog/oauth?client_id=1' }));
  assert.equal(await adapter.connectUrl({ profileId: 'prof_1', platform: 'FACEBOOK', redirectUrl: 'https://app.example.test/staff/marketing/social/return', state: 's' }), 'https://www.facebook.com/dialog/oauth?client_id=1');
  const u = new URL(calls.at(-1).url); assert.equal(u.pathname, '/api/v1/connect/facebook'); assert.equal(u.searchParams.get('profileId'), 'prof_1'); assert.equal(u.searchParams.get('state'), 's');
  routes.push(reply(200, { authUrl: 'https://evil.test/x' }));
  await assert.rejects(adapter.connectUrl({ profileId: 'prof_1', platform: 'INSTAGRAM', redirectUrl: 'https://a.test/r', state: 's' }), e => e.failure === 'UNKNOWN');
  routes.push(reply(200, { accounts: [
    { _id: 'fb1', platform: 'facebook', displayName: 'Dojo\u0007 Page', profileId: 'prof_1', accessToken: 'secret' },
    { _id: 'fb2', platform: 'facebook', displayName: 'Other school', profileId: 'prof_OTHER' },
    { _id: 'tt1', platform: 'tiktok', displayName: 'nope' }, { _id: 'bad id!', platform: 'instagram', name: 'x' }, { _id: 'ig1', platform: 'instagram', username: 'dojo.ig', profileId: { _id: 'prof_1' } },
  ] }));
  assert.deepEqual(await adapter.listAccounts('prof_1'), [{ providerAccountId: 'fb1', platform: 'FACEBOOK', displayName: 'Dojo Page' }, { providerAccountId: 'ig1', platform: 'INSTAGRAM', displayName: 'dojo.ig' }]);
  for (const [r, failure] of [[reply(401, { error: 'bad key ' + KEY }), 'REJECTED'], [reply(429, {}), 'RATE_LIMITED'], [reply(500, {}), 'UNAVAILABLE'], [reply(200, '<html>', 'text/html'), 'UNKNOWN'],
    [() => { throw new Error('socket ' + KEY); }, 'UNKNOWN']]) {
    routes.push(r);
    await assert.rejects(adapter.listAccounts('prof_1'), e => e instanceof SocialProviderError && e.failure === failure && !e.message.includes(KEY));
  }
  routes.push(reply(500, {})); await assert.rejects(adapter.removeAccount('fb1'), e => e.failure === 'UNKNOWN');
  routes.push(reply(204)); await adapter.removeAccount('fb1'); assert.equal(calls.at(-1).init.method, 'DELETE'); assert.equal(new URL(calls.at(-1).url).pathname, '/api/v1/accounts/fb1');
  await assert.rejects(adapter.removeAccount('../x'), e => e.failure === 'UNKNOWN');
  env = { ZERNIO_API_KEY: KEY, HON_ZERNIO_CONNECT_APPROVED: 'false' }; const before = calls.length;
  await assert.rejects(adapter.removeAccount('fb1'), e => e.failure === 'NOT_ENABLED'); assert.equal(calls.length, before);
});
