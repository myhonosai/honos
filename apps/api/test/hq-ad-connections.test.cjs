const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
require('reflect-metadata');
const contracts = require('@hon/contracts');
const { HqAdConnectionsService, HQ_ZERNIO_PROFILE_NAME } = require('../dist/hq-ad-connections/hq-ad-connections.service.js');
const { HqAdConnectionsController } = require('../dist/hq-ad-connections/hq-ad-connections.controller.js');
const adapterModule = require('../dist/marketing/social/zernio-social-adapter.js');
const { FakeZernioSocialAdapter, hqZernioAdapterFactory, hqZernioConnectApproved, hqZernioConnector, hqZernioEnvironment, SocialProviderError } = adapterModule;

// 0677 HQ ad account connections: the HQ switch is separate from the school switch, the HQ connector has no publish, reply or
// ad operation, and the service forwards only the verified subject, a hashed state and HON's own profile's accounts.
const KEY = 'sk_' + 'a'.repeat(64);
const U = () => randomUUID(), T = '2026-11-24T05:00:00.000Z';
const person = { principalId: U(), displayName: 'David' };
const account = (patch = {}) => ({ accountId: U(), provider: 'GOOGLE_ADS', displayName: 'HON Google Ads', status: 'CONNECTED', version: 1,
  connectedBy: person, connectedAt: T, updatedAt: T, disconnectedAt: null, ...patch });
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

function fakeDatabase(answers) {
  const calls = [];
  return { calls, callSaasBilling: async (operation, params) => {
    calls.push([operation, params]);
    const answer = answers[operation];
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer(params) : answer;
  } };
}
const sqlError = (code, message) => Object.assign(new Error(message), { code });
const withEnv = async (patch, fn) => {
  const saved = { ...process.env };
  Object.assign(process.env, patch);
  try { return await fn(); } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
};
const fakeEnv = { HON_ZERNIO_FAKE_PROVIDER: '1', HON_DEPLOYMENT_ENVIRONMENT: 'development', NODE_ENV: 'test' };

test('contracts: HQ ad commands match the SaaS command table; inputs are closed', () => {
  assert.deepEqual(contracts.HQ_AD_COMMANDS, { connect: contracts.SAAS_COMMANDS.connectHqAdAccount,
    complete: contracts.SAAS_COMMANDS.completeHqAdConnect, disconnect: contracts.SAAS_COMMANDS.disconnectHqAdAccount });
  assert.deepEqual(contracts.validateHqAdConnectInput({ provider: 'META_ADS' }), { provider: 'META_ADS' });
  for (const bad of [{}, { provider: 'TIKTOK' }, { provider: 'GOOGLE_ADS', extra: 1 }, null, []]) assert.throws(() => contracts.validateHqAdConnectInput(bad));
  for (const bad of [{ state: 'short' }, { state: 'a'.repeat(43), x: 1 }, { state: 'a'.repeat(42) + '!' }]) assert.throws(() => contracts.validateHqAdConnectCompleteInput(bad));
  assert.deepEqual(contracts.validateHqAdDisconnectInput({ expectedVersion: 3 }), { expectedVersion: 3 });
  for (const bad of [{ expectedVersion: 0 }, { expectedVersion: 1.5 }, { expectedVersion: '1' }, { expectedVersion: 1, disconnect: true }]) assert.throws(() => contracts.validateHqAdDisconnectInput(bad));
  assert.throws(() => contracts.verifyHqAdAccount(account({ status: 'DISCONNECTED' })), 'disconnected needs a time');
  assert.throws(() => contracts.verifyHqAdAccount({ ...account(), providerAccountId: 'x' }), 'no provider id leaves the API');
});

test('switches: HQ needs its own switch and a well-formed key; the school switch neither enables nor is enabled by it', () => {
  assert.equal(hqZernioConnectApproved({ ZERNIO_API_KEY: KEY, HON_HQ_ZERNIO_CONNECT_APPROVED: 'true' }), true);
  assert.equal(hqZernioConnectApproved({ ZERNIO_API_KEY: KEY, HON_ZERNIO_CONNECT_APPROVED: 'true' }), false);
  assert.equal(hqZernioConnectApproved({ ZERNIO_API_KEY: 'bad', HON_HQ_ZERNIO_CONNECT_APPROVED: 'true' }), false);
  assert.equal(hqZernioConnectApproved({ ZERNIO_API_KEY: KEY, HON_HQ_ZERNIO_CONNECT_APPROVED: '1' }), false);
  assert.equal(adapterModule.zernioConnectApproved({ ZERNIO_API_KEY: KEY, HON_HQ_ZERNIO_CONNECT_APPROVED: 'true' }), false, 'HQ switch never turns schools on');
  const view = hqZernioEnvironment({ ZERNIO_API_KEY: KEY, HON_ZERNIO_CONNECT_APPROVED: 'true', HON_ZERNIO_PUBLISH_APPROVED: 'true',
    HON_ZERNIO_INBOX_APPROVED: 'true', HON_ZERNIO_ADS_APPROVED: 'true' });
  assert.equal(view.HON_ZERNIO_CONNECT_APPROVED, undefined, 'school connect switch is not HQ\'s');
  for (const k of ['HON_ZERNIO_PUBLISH_APPROVED', 'HON_ZERNIO_INBOX_APPROVED', 'HON_ZERNIO_ADS_APPROVED']) assert.equal(k in view, false, k);
  const off = hqZernioAdapterFactory({ ZERNIO_API_KEY: KEY, HON_ZERNIO_CONNECT_APPROVED: 'true', HON_ZERNIO_ADS_APPROVED: 'true' });
  assert.deepEqual([off.kind, off.ready()], ['NONE', false]);
  const on = hqZernioAdapterFactory({ ZERNIO_API_KEY: KEY, HON_HQ_ZERNIO_CONNECT_APPROVED: 'true' });
  assert.deepEqual([on.kind, on.ready()], ['ZERNIO', true]);
  assert.deepEqual(Object.keys(on).sort(), ['connectUrl', 'findOrCreateProfile', 'kind', 'listAccounts', 'ready', 'removeAccount'], 'no publish, reply or ad operation');
  assert.deepEqual(hqZernioAdapterFactory({ ...fakeEnv }).kind, 'FAKE');
  assert.deepEqual(hqZernioAdapterFactory({ HON_ZERNIO_FAKE_PROVIDER: '1', HON_DEPLOYMENT_ENVIRONMENT: 'production' }).kind, 'NONE');
});

test('list reports connectEnabled only with the switch on and an https public origin', async () => {
  const listed = { profileLinked: false, accounts: [], viewer: { ...person, canConnect: true }, checkedAt: T };
  const db = fakeDatabase({ readHqAdAccounts: listed });
  const none = { kind: 'NONE', ready: () => false };
  await withEnv({ HON_PUBLIC_ORIGIN: 'https://app.example' }, async () => {
    assert.equal((await new HqAdConnectionsService(db, none).list('subj')).connectEnabled, false);
    const real = { kind: 'ZERNIO', ready: () => true };
    assert.equal((await new HqAdConnectionsService(db, real).list('subj')).connectEnabled, true);
  });
  await withEnv({ HON_PUBLIC_ORIGIN: 'http://localhost:3000' }, async () => {
    assert.equal((await new HqAdConnectionsService(db, { kind: 'ZERNIO', ready: () => true }).list('subj')).connectEnabled, false, 'real provider needs https');
  });
  assert.deepEqual(db.calls[0], ['readHqAdAccounts', ['subj']]);
});

test('connect: hashed state, HON profile by name, Meta maps to the Facebook account, fake returns to the HQ return page', async () => {
  await withEnv({ ...fakeEnv, HON_PUBLIC_ORIGIN: 'http://localhost:3000' }, async () => {
    const fake = new FakeZernioSocialAdapter(() => hqZernioEnvironment(process.env));
    const intentId = U(); let stateHash;
    const db = fakeDatabase({
      startHqAdConnect: (p) => { stateHash = p[2]; return { intentId, provider: 'META_ADS', expiresAt: T, providerProfileId: null }; },
      recordHqAdProfile: (p) => ({ providerProfileId: p[2], linked: true }),
      claimHqAdConnect: (p) => { assert.equal(p[1], stateHash); return { intentId, provider: 'META_ADS', providerProfileId: fake.profiles.get(HQ_ZERNIO_PROFILE_NAME) }; },
      recordHqAdAccounts: (p) => { const list = JSON.parse(p[2]); return { provider: 'META_ADS', connected: list.length, conflicts: 0,
        accounts: list.map(a => account({ provider: 'META_ADS', displayName: a.displayName })) }; },
    });
    const service = new HqAdConnectionsService(db, hqZernioConnector(fake));
    const started = await service.start('subj', { provider: 'META_ADS' });
    assert.deepEqual(db.calls[0][1].slice(0, 2), ['subj', JSON.stringify({ provider: 'META_ADS' })]);
    assert.match(stateHash, /^[a-f0-9]{64}$/);
    const url = new URL(started.authUrl);
    assert.equal(url.pathname, contracts.HQ_AD_CONNECT_RETURN_PATH);
    assert.equal(url.searchParams.get('connected'), 'facebook');
    const state = url.searchParams.get('state');
    assert.equal(sha(state), stateHash, 'only the hash reaches the database');
    assert.equal(db.calls[1][0], 'recordHqAdProfile');
    assert.ok(fake.profiles.has('hon-hq'));
    const done = await service.complete('subj', { state });
    assert.deepEqual([done.provider, done.connected, done.accounts[0].displayName], ['META_ADS', 1, 'Synthetic Dojo Page']);
    const recorded = JSON.parse(db.calls.at(-1)[1][2]);
    assert.deepEqual(Object.keys(recorded[0]).sort(), ['displayName', 'providerAccountId']);
  });
});

test('connect refuses when off, maps provider failures to fixed codes, and checks the consent host', async () => {
  await withEnv({ HON_PUBLIC_ORIGIN: 'https://app.example' }, async () => {
    const db = fakeDatabase({ startHqAdConnect: { intentId: U(), provider: 'GOOGLE_ADS', expiresAt: T, providerProfileId: 'prof_1' } });
    const status = (n, code) => (e) => { assert.equal(e.getStatus(), n); assert.equal(e.getResponse().code, code); return true; };
    await assert.rejects(new HqAdConnectionsService(db, { kind: 'NONE', ready: () => false }).start('s', { provider: 'GOOGLE_ADS' }), status(503, 'HQ_AD_CONNECT_NOT_ENABLED'));
    assert.equal(db.calls.length, 0, 'nothing written while off');
    await assert.rejects(new HqAdConnectionsService(db, { kind: 'ZERNIO', ready: () => true }).start('s', { provider: 'X' }), status(400, 'INVALID_SAAS_INPUT'));
    const evil = { kind: 'ZERNIO', ready: () => true, connectUrl: async () => 'https://evil.example/consent' };
    await assert.rejects(new HqAdConnectionsService(db, evil).start('s', { provider: 'GOOGLE_ADS' }), status(502, 'HQ_AD_PROVIDER_UNAVAILABLE'));
    const limited = { kind: 'ZERNIO', ready: () => true, connectUrl: async () => { throw new SocialProviderError('RATE_LIMITED'); } };
    await assert.rejects(new HqAdConnectionsService(db, limited).start('s', { provider: 'GOOGLE_ADS' }), status(429, 'HQ_AD_PROVIDER_RATE_LIMITED'));
    const good = { kind: 'ZERNIO', ready: () => true, connectUrl: async (i) => { assert.equal(i.platform, 'GOOGLE_ADS'); assert.equal(i.redirectUrl, 'https://app.example/hq/marketing/ads/return'); return 'https://accounts.google.com/o/oauth2/auth?x=1'; } };
    assert.equal((await new HqAdConnectionsService(db, good).start('s', { provider: 'GOOGLE_ADS' })).authUrl, 'https://accounts.google.com/o/oauth2/auth?x=1');
    for (const [err, n, code] of [[sqlError('42501', 'SAAS_FORBIDDEN'), 403, 'SAAS_FORBIDDEN'], [sqlError('54000', 'HQ_AD_RATE_LIMITED'), 429, 'HQ_AD_RATE_LIMITED'],
      [sqlError('22023', 'HQ_AD_CONNECT_STATE_EXPIRED'), 400, 'HQ_AD_CONNECT_STATE_EXPIRED'], [sqlError('23514', 'HQ_AD_PROFILE_CONFLICT'), 422, 'HQ_AD_PROFILE_CONFLICT'],
      [sqlError('XX000', 'boom select * from'), 503, 'SAAS_UNAVAILABLE']]) {
      await assert.rejects(new HqAdConnectionsService(fakeDatabase({ startHqAdConnect: err }), good).start('s', { provider: 'GOOGLE_ADS' }), status(n, code));
    }
  });
});

test('disconnect: provider id never leaves the API; removal attempted once and reported; replay does not call Zernio', async () => {
  const id = U(), key = U();
  const record = { ...account({ accountId: id, status: 'DISCONNECTED', version: 2, disconnectedAt: T }), providerAccountId: 'gads_1' };
  const removed = [];
  const adapter = { kind: 'ZERNIO', ready: () => true, removeAccount: async (x) => { removed.push(x); } };
  const out = await new HqAdConnectionsService(fakeDatabase({ disconnectHqAdAccount: { record, replayed: false } }), adapter).disconnect('s', id, { expectedVersion: 1 }, key);
  assert.deepEqual([out.providerRemoval, out.replayed, 'providerAccountId' in out.account, removed], ['REMOVED', false, false, ['gads_1']]);
  const again = await new HqAdConnectionsService(fakeDatabase({ disconnectHqAdAccount: { record, replayed: true } }), adapter).disconnect('s', id, { expectedVersion: 1 }, key);
  assert.deepEqual([again.providerRemoval, removed.length], ['NOT_ATTEMPTED', 1]);
  const failing = { kind: 'ZERNIO', ready: () => true, removeAccount: async () => { throw new SocialProviderError('UNAVAILABLE'); } };
  assert.equal((await new HqAdConnectionsService(fakeDatabase({ disconnectHqAdAccount: { record, replayed: false } }), failing).disconnect('s', id, { expectedVersion: 1 }, key)).providerRemoval, 'NOT_REMOVED');
  await assert.rejects(new HqAdConnectionsService(fakeDatabase({}), adapter).disconnect('s', id, { expectedVersion: 1 }, 'not-a-uuid'), e => e.getStatus() === 400);
  const other = { record: { ...record, accountId: U() }, replayed: false };
  await assert.rejects(new HqAdConnectionsService(fakeDatabase({ disconnectHqAdAccount: other }), adapter).disconnect('s', id, { expectedVersion: 1 }, key), e => e.getStatus() === 503);
});

test('controller routes carry the HQ ad command markers', () => {
  const { Reflector } = require('@nestjs/core');
  const r = new Reflector(), proto = HqAdConnectionsController.prototype;
  const marker = (m) => Reflect.getMetadataKeys(proto[m]).map(k => r.get(k, proto[m])).find(v => typeof v === 'string' && v.startsWith('hq-ad-'));
  assert.deepEqual([marker('connect'), marker('complete'), marker('disconnect')], ['hq-ad-connect', 'hq-ad-connect-complete', 'hq-ad-disconnect']);
  assert.equal(Reflect.getMetadata('path', HqAdConnectionsController), 'hq/marketing/ad-accounts');
});
