const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { SchoolSocialAdsService } = require('../dist/marketing/social/school-social-ads.service.js');
const { SchoolSocialAdsController } = require('../dist/marketing/social/school-social-ads.controller.js');
const { FakeZernioSocialAdapter, ZernioHttpSocialAdapter, SocialProviderError, zernioAdsApproved, zernioAdsPauseReady, zernioSocialAdapterFactory } = require('../dist/marketing/social/zernio-social-adapter.js');

// Mocked boundary tests for the 0437 ads API and Zernio ad calls. The cap, authority, leases and evidence are proven
// against PostgreSQL by test-school-social-ads.mjs. Nothing reaches Zernio or Meta: the HTTP adapter gets a stub fetch
// and the service gets the deterministic fake or a stub. No money moves anywhere in this file.
const KEY = 'sk_' + 'd'.repeat(64);
const at = '2026-11-14T05:00:00.000Z';
const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const context = (patch = {}) => ({ ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: 'ads-key', externalSubject: 'verified-human', ...patch });
const readContext = () => context({ idempotencyKey: '' });
const status = (value, code) => (error) => { assert.equal(error.getStatus(), value, JSON.stringify(error.getResponse?.())); if (code) assert.equal(error.getResponse().code, code); return true; };
const adId = randomUUID(), accountId = randomUUID(), targetId = randomUUID(), postId = randomUUID(), leaseToken = randomUUID();
const ad = (patch = {}) => ({ adId, accountId, targetId, postId, accountName: 'Synthetic Dojo Page', budgetCents: 5000, currency: 'USD', startsOn: '2026-11-15', endsOn: '2026-11-21',
  status: 'DRAFT', operation: null, resolvedByPerson: false, createdAt: at, version: 1, ...patch });
const view = (patch = {}) => ({ budget: { monthlyCapCents: 20000, currency: 'USD', version: 1 }, committedThisMonthCents: 0, ads: [ad()], today: '2026-11-14', checkedAt: at, ...patch });
const adSend = (operation, patch = {}) => ({ adId, leaseToken, operation, providerAccountId: 'fb1', providerPostId: 'fbpost_1', providerAdId: operation === 'CREATE' ? null : 'ad_1',
  budgetCents: 5000, currency: 'USD', startsOn: '2026-11-15', endsOn: '2026-11-21', timezone: 'America/Los_Angeles', ...patch });
const nextStatus = { CREATE: ['CREATING', 'PAUSED'], ACTIVATE: ['ACTIVATING', 'ACTIVE'], PAUSE: ['PAUSING', 'PAUSED'] };

function fixture(options = {}) {
  const queries = [];
  const op = () => queries.find(q => /start_school_social_ad_operation/.test(q.sql)) ? JSON.parse(queries.find(q => /start_school_social_ad_operation/.test(q.sql)).args[2]).operation : 'CREATE';
  const answer = (name, fallback) => { const v = options[name] ?? fallback; if (v instanceof Error) throw v; return { rows: [{ data: typeof v === 'function' ? v() : v }] }; };
  const db = {
    async transaction(c, work, readOnly) {
      return work({ query: async (sql, args = []) => {
        queries.push({ sql, args, readOnly });
        if (/^SET LOCAL/.test(sql) || /set_config\('app\.hon_source','HUMAN_UI'/.test(sql)) return { rows: [] };
        if (options.error) throw options.error;
        if (/read_school_social_ads\(/.test(sql)) return answer('read', view());
        if (/set_school_social_ad_budget\(/.test(sql)) return answer('budget', { record: view({ budget: { monthlyCapCents: 30000, currency: 'USD', version: 2 } }), replayed: false });
        if (/create_school_social_ad\(/.test(sql)) return answer('create', { record: ad(), replayed: false });
        if (/cancel_school_social_ad\(/.test(sql)) return answer('cancel', { record: ad({ status: 'CANCELLED', version: 2 }), replayed: false });
        if (/resolve_school_social_ad\(/.test(sql)) return answer('resolve', { record: ad({ status: 'PAUSED', operation: 'CREATE', resolvedByPerson: true, version: 3 }), replayed: false });
        if (/start_school_social_ad_operation\(/.test(sql)) {
          const o = JSON.parse(args[2]).operation;
          return answer('start', () => ({ record: ad({ status: nextStatus[o][0], operation: o, version: 2 }), replayed: false, send: adSend(o) }));
        }
        if (/record_school_social_ad_result\(/.test(sql)) {
          const o = op(), outcome = args[3];
          return answer('record', () => ({ ad: ad({ status: outcome === 'DONE' ? nextStatus[o][1] : outcome === 'FAILED' ? (o === 'CREATE' ? 'FAILED' : o === 'ACTIVATE' ? 'PAUSED' : 'ACTIVE') : 'UNKNOWN', operation: o, version: 3 }), accepted: true }));
        }
        throw new Error('Unexpected SQL: ' + sql);
      } });
    },
    withTenantTransaction(c, work) { return this.transaction(c, work, false); },
    withTenantReadOnlyTransaction(c, work) { return this.transaction(c, work, true); },
  };
  return { db, queries };
}
const fake = () => new FakeZernioSocialAdapter(() => ({ HON_ZERNIO_FAKE_PROVIDER: '1', HON_DEPLOYMENT_ENVIRONMENT: 'development' }));
const off = { adsReady: () => false, adsPauseReady: () => false, createBoost: async () => { throw new Error('must not call'); }, setAdActive: async () => { throw new Error('must not call'); } };

test('switches: ads need a well-formed key AND the exact approval; the ads switch turns on nothing else and nothing else turns it on', () => {
  assert.equal(zernioAdsApproved({}), false);
  assert.equal(zernioAdsApproved({ ZERNIO_API_KEY: KEY }), false);
  assert.equal(zernioAdsApproved({ ZERNIO_API_KEY: KEY, HON_ZERNIO_ADS_APPROVED: 'TRUE' }), false);
  assert.equal(zernioAdsApproved({ ZERNIO_API_KEY: 'zrk_short', HON_ZERNIO_ADS_APPROVED: 'true' }), false);
  assert.equal(zernioAdsApproved({ ZERNIO_API_KEY: KEY, HON_ZERNIO_ADS_APPROVED: 'true' }), true);
  assert.equal(zernioSocialAdapterFactory({ ZERNIO_API_KEY: KEY, HON_ZERNIO_ADS_APPROVED: 'true' }).kind, 'ZERNIO');
  const adsOnly = new ZernioHttpSocialAdapter(() => ({ ZERNIO_API_KEY: KEY, HON_ZERNIO_ADS_APPROVED: 'true' }));
  assert.deepEqual([adsOnly.adsReady(), adsOnly.inboxReady(), adsOnly.publishReady(), adsOnly.ready()], [true, false, false, false]);
  const everythingElse = new ZernioHttpSocialAdapter(() => ({ ZERNIO_API_KEY: KEY, HON_ZERNIO_CONNECT_APPROVED: 'true', HON_ZERNIO_PUBLISH_APPROVED: 'true', HON_ZERNIO_INBOX_APPROVED: 'true' }));
  assert.equal(everythingElse.adsReady(), false);
  assert.equal(zernioSocialAdapterFactory({}).adsReady(), false);
  assert.equal(new FakeZernioSocialAdapter(() => ({ HON_ZERNIO_FAKE_PROVIDER: '1', HON_DEPLOYMENT_ENVIRONMENT: 'production' })).adsReady(), false);
});

test('reads: one read-only call; reports whether ads are on; a read answering with stray fields is refused; reads take no key', async () => {
  const { db, queries } = fixture();
  const out = await new SchoolSocialAdsService(db, off).read(readContext());
  assert.deepEqual([out.ads.length, out.adsEnabled, out.pauseEnabled, out.budget.monthlyCapCents], [1, false, false, 20000]);
  assert.deepEqual(queries.find(q => /read_school_social_ads/.test(q.sql)).args, ['verified-human']);
  assert.ok(queries.find(q => /read_school_social_ads/.test(q.sql)).readOnly);
  assert.equal((await new SchoolSocialAdsService(fixture().db, fake()).read(readContext())).adsEnabled, true);
  await assert.rejects(new SchoolSocialAdsService(fixture({ read: { ...view(), secret: 1 } }).db, off).read(readContext()), /Unverified|SOCIAL_UNAVAILABLE/);
  await assert.rejects(new SchoolSocialAdsService(fixture({ read: view({ ads: [ad({ budgetCents: 99 })] }) }).db, off).read(readContext()), /Unverified|SOCIAL_UNAVAILABLE/);
  await assert.rejects(new SchoolSocialAdsService(db, off).read(context()), status(403, 'SOCIAL_FORBIDDEN'));
  await assert.rejects(new SchoolSocialAdsService(db, off).read({ ...readContext(), source: 'AI_ACTION' }), status(403, 'SOCIAL_FORBIDDEN'));
  await assert.rejects(new SchoolSocialAdsService(db, off).read({ ...readContext(), principalType: 'SERVICE' }), status(403, 'SOCIAL_FORBIDDEN'));
});

test('cap, drafts, cancel and resolve: strict bodies, exact arguments, no provider call, ads switch not needed', async () => {
  const { db, queries } = fixture();
  const service = new SchoolSocialAdsService(db, off);
  const b = await service.budget(context(), { monthlyCapCents: 30000, currency: 'USD', expectedVersion: 1 });
  assert.deepEqual([b.view.budget.monthlyCapCents, b.view.adsEnabled, b.replayed], [30000, false, false]);
  assert.deepEqual(queries.find(q => /set_school_social_ad_budget/.test(q.sql)).args.slice(0, 3), ['verified-human', '{"monthlyCapCents":30000,"currency":"USD","expectedVersion":1}', 'ads-key']);
  const draft = { targetId, budgetCents: 5000, startsOn: '2026-11-15', endsOn: '2026-11-21' };
  const c = await service.create(context(), draft);
  assert.deepEqual([c.ad.status, c.ad.operation], ['DRAFT', null]);
  assert.deepEqual(queries.find(q => /create_school_social_ad\(/.test(q.sql)).args.slice(0, 3), ['verified-human', JSON.stringify(draft), 'ads-key']);
  assert.equal((await service.cancel(context(), adId, { expectedVersion: 1 })).ad.status, 'CANCELLED');
  assert.deepEqual(queries.find(q => /cancel_school_social_ad/.test(q.sql)).args.slice(0, 4), ['verified-human', adId, '{"expectedVersion":1}', 'ads-key']);
  assert.equal((await service.resolve(context(), adId, { state: 'PAUSED', expectedVersion: 2 })).ad.resolvedByPerson, true);
  for (const body of [{}, { monthlyCapCents: 1_000_001, currency: 'USD' }, { monthlyCapCents: -1, currency: 'USD' }, { monthlyCapCents: 100, currency: 'usd' },
    { monthlyCapCents: 100.5, currency: 'USD' }, { monthlyCapCents: 100, currency: 'USD', schoolId: randomUUID() }, null, []]) {
    await assert.rejects(service.budget(context(), body), status(400, 'SOCIAL_INVALID'), JSON.stringify(body));
  }
  for (const body of [{ ...draft, budgetCents: 99 }, { ...draft, endsOn: '2026-11-14' }, { ...draft, endsOn: '2026-12-16' }, { ...draft, startsOn: '2026-02-30' },
    { ...draft, targetId: 'post' }, { ...draft, status: 'ACTIVE' }, { ...draft, accountId }, { targetId }]) {
    await assert.rejects(service.create(context(), body), status(400, 'SOCIAL_INVALID'), JSON.stringify(body));
  }
  for (const body of [{ state: 'DONE', expectedVersion: 2 }, { state: 'ACTIVE' }, { state: 'PAUSED', expectedVersion: 0 }]) {
    await assert.rejects(service.resolve(context(), adId, body), status(400, 'SOCIAL_INVALID'), JSON.stringify(body));
  }
  await assert.rejects(service.cancel(context(), adId, { expectedVersion: 1, force: true }), status(400, 'SOCIAL_INVALID'));
  // An answer about another ad, or a draft for another post, is refused.
  await assert.rejects(new SchoolSocialAdsService(fixture({ create: { record: ad({ targetId: randomUUID() }), replayed: false } }).db, off).create(context(), draft), /Unverified|SOCIAL_UNAVAILABLE/);
  await assert.rejects(new SchoolSocialAdsService(fixture({ cancel: { record: ad({ adId: randomUUID() }), replayed: false } }).db, off).cancel(context(), adId, { expectedVersion: 1 }), /Unverified|SOCIAL_UNAVAILABLE/);
  // Commands need a key.
  await assert.rejects(service.create(readContext(), draft), status(403, 'SOCIAL_FORBIDDEN'));
});

test('operations: refused before anything is recorded while ads are off; created PAUSED once with the ad id as key; on/pause under the lease', async () => {
  const offFixture = fixture();
  for (const operation of ['CREATE', 'ACTIVATE', 'PAUSE']) {
    await assert.rejects(new SchoolSocialAdsService(offFixture.db, off).operation(context(), adId, { operation, expectedVersion: 1 }), status(503, 'SOCIAL_ADS_NOT_ENABLED'));
  }
  assert.equal(offFixture.queries.length, 0);
  const provider = fake(), { db, queries } = fixture();
  const out = await new SchoolSocialAdsService(db, provider).operation(context(), adId, { operation: 'CREATE', expectedVersion: 1 });
  assert.equal(provider.boosts.length, 1);
  assert.deepEqual({ ...provider.boosts[0], providerAdId: undefined }, { providerAccountId: 'fb1', providerPostId: 'fbpost_1', budgetCents: 5000, currency: 'USD',
    startsOn: '2026-11-15', endsOn: '2026-11-21', timezone: 'America/Los_Angeles', idempotencyKey: adId, providerAdId: undefined });
  const record = queries.find(q => /record_school_social_ad_result/.test(q.sql));
  assert.deepEqual(record.args.slice(0, 5), ['verified-human', adId, leaseToken, 'DONE', provider.boosts[0].providerAdId]);
  assert.deepEqual([out.ad.status, provider.adStatusChanges.length], ['PAUSED', 0]);
  for (const [operation, active] of [['ACTIVATE', true], ['PAUSE', false]]) {
    const p = fake(), f = fixture();
    const r = await new SchoolSocialAdsService(f.db, p).operation(context(), adId, { operation, expectedVersion: 2 });
    assert.deepEqual(p.adStatusChanges, [{ providerAdId: 'ad_1', active, idempotencyKey: `${adId}:${leaseToken}` }]);
    assert.equal(p.boosts.length, 0);
    assert.deepEqual(f.queries.find(q => /record_school_social_ad_result/.test(q.sql)).args.slice(3, 5), ['DONE', null]);
    assert.equal(r.ad.status, nextStatus[operation][1]);
  }
  // Only a definite refusal is FAILED; anything that may have reached Meta is UNKNOWN.
  for (const [failure, outcome] of [['REJECTED', 'FAILED'], ['RATE_LIMITED', 'FAILED'], ['UNKNOWN', 'UNKNOWN'], ['UNAVAILABLE', 'UNKNOWN']]) {
    for (const operation of ['CREATE', 'ACTIVATE']) {
      const p = fake(); p.failNext[operation === 'CREATE' ? 'createBoost' : 'setAdActive'] = failure;
      const f = fixture();
      const r = await new SchoolSocialAdsService(f.db, p).operation(context(), adId, { operation, expectedVersion: 1 });
      assert.deepEqual(f.queries.find(q => /record_school_social_ad_result/.test(q.sql)).args.slice(3, 5), [outcome, null], failure + operation);
      assert.equal(r.ad.status === 'UNKNOWN', outcome === 'UNKNOWN');
    }
  }
  // A thrown non-provider error is UNKNOWN too.
  const odd = { adsReady: () => true, adsPauseReady: () => true, createBoost: async () => { throw new TypeError('boom'); }, setAdActive: async () => {} }, oddFixture = fixture();
  await new SchoolSocialAdsService(oddFixture.db, odd).operation(context(), adId, { operation: 'CREATE', expectedVersion: 1 });
  assert.equal(oddFixture.queries.find(q => /record_school_social_ad_result/.test(q.sql)).args[3], 'UNKNOWN');
  // Recording fails after the call: the ad reads UNKNOWN and nothing is called again.
  const lost = fake(), lostFixture = fixture({ record: new Error('connection lost') });
  const r = await new SchoolSocialAdsService(lostFixture.db, lost).operation(context(), adId, { operation: 'ACTIVATE', expectedVersion: 2 });
  assert.deepEqual([r.ad.status, lost.adStatusChanges.length], ['UNKNOWN', 1]);
  // A replayed command calls nothing.
  const again = fake(), replay = fixture({ start: { record: ad({ status: 'ACTIVE', operation: 'ACTIVATE', version: 3 }), replayed: true } });
  const rr = await new SchoolSocialAdsService(replay.db, again).operation(context(), adId, { operation: 'ACTIVATE', expectedVersion: 2 });
  assert.deepEqual([rr.replayed, again.adStatusChanges.length, replay.queries.some(q => /record_school_social_ad_result/.test(q.sql))], [true, 0, false]);
});

test('pausing never needs the ads switch: a well-formed key alone lets PAUSE reach Zernio; CREATE and ACTIVATE still need the approval', async () => {
  assert.equal(zernioAdsPauseReady({}), false);
  assert.equal(zernioAdsPauseReady({ ZERNIO_API_KEY: 'zrk_short' }), false);
  assert.equal(zernioAdsPauseReady({ ZERNIO_API_KEY: KEY }), true);
  // A key with every switch off: the real adapter is chosen, but only pausing is ready.
  const keyOnly = zernioSocialAdapterFactory({ ZERNIO_API_KEY: KEY });
  assert.deepEqual([keyOnly.kind, keyOnly.adsPauseReady(), keyOnly.adsReady(), keyOnly.inboxReady(), keyOnly.publishReady(), keyOnly.ready()], ['ZERNIO', true, false, false, false, false]);
  assert.equal(zernioSocialAdapterFactory({}).adsPauseReady(), false);
  assert.equal(new FakeZernioSocialAdapter(() => ({ HON_ZERNIO_FAKE_PROVIDER: '1', HON_DEPLOYMENT_ENVIRONMENT: 'production' })).adsPauseReady(), false);
  // The HTTP adapter with only the key: pausing calls Zernio once with PAUSED; turning on and creating are refused without a call.
  const calls = [];
  const http = new ZernioHttpSocialAdapter(() => ({ ZERNIO_API_KEY: KEY }), async (url, init) => { calls.push({ url, body: init.body, key: init.headers['Idempotency-Key'] }); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); });
  await http.setAdActive({ providerAdId: 'ad_1', active: false, idempotencyKey: 'k1' });
  assert.deepEqual(calls.map(c => [c.url.endsWith('/ads/ad_1/status'), JSON.parse(c.body).status, c.key]), [[true, 'PAUSED', 'k1']]);
  await assert.rejects(http.setAdActive({ providerAdId: 'ad_1', active: true, idempotencyKey: 'k2' }), e => e instanceof SocialProviderError && e.failure === 'NOT_ENABLED');
  await assert.rejects(http.createBoost({ providerAccountId: 'fb1', providerPostId: 'fbpost_1', budgetCents: 5000, currency: 'USD', startsOn: '2026-11-15', endsOn: '2026-11-21', timezone: 'America/Los_Angeles', idempotencyKey: adId }),
    e => e instanceof SocialProviderError && e.failure === 'NOT_ENABLED');
  assert.equal(calls.length, 1);
  // The service: with pausing ready but ads off, PAUSE goes through under the lease; CREATE and ACTIVATE are refused with nothing recorded.
  const pauseOnly = { adsReady: () => false, adsPauseReady: () => true, createBoost: async () => { throw new Error('must not call'); }, changes: [],
    async setAdActive(input) { if (input.active) throw new Error('must not call'); this.changes.push(input); } };
  const refused = fixture();
  for (const operation of ['CREATE', 'ACTIVATE']) {
    await assert.rejects(new SchoolSocialAdsService(refused.db, pauseOnly).operation(context(), adId, { operation, expectedVersion: 1 }), status(503, 'SOCIAL_ADS_NOT_ENABLED'));
  }
  assert.equal(refused.queries.length, 0);
  const f = fixture();
  const r = await new SchoolSocialAdsService(f.db, pauseOnly).operation(context(), adId, { operation: 'PAUSE', expectedVersion: 2 });
  assert.deepEqual(pauseOnly.changes, [{ providerAdId: 'ad_1', active: false, idempotencyKey: `${adId}:${leaseToken}` }]);
  assert.deepEqual(f.queries.find(q => /record_school_social_ad_result/.test(q.sql)).args.slice(3, 5), ['DONE', null]);
  assert.equal(r.ad.status, 'PAUSED');
  const v = await new SchoolSocialAdsService(fixture().db, pauseOnly).read(readContext());
  assert.deepEqual([v.adsEnabled, v.pauseEnabled], [false, true]);
  // An invalid body is refused before the switch is consulted.
  await assert.rejects(new SchoolSocialAdsService(fixture().db, off).operation(context(), adId, { operation: 'STOP', expectedVersion: 1 }), status(400, 'SOCIAL_INVALID'));
});

test('operations: a send that disagrees with the recorded ad is refused before Zernio is called', async () => {
  const bad = [adSend('CREATE', { budgetCents: 999999 }), adSend('CREATE', { currency: 'EUR' }), adSend('CREATE', { endsOn: '2026-11-30' }), adSend('CREATE', { operation: 'ACTIVATE' }),
    adSend('CREATE', { providerAdId: 'ad_1' }), adSend('CREATE', { adId: randomUUID() }), { ...adSend('CREATE'), extra: 1 }, adSend('CREATE', { leaseToken: 'x' })];
  for (const send of bad) {
    const p = fake(), f = fixture({ start: { record: ad({ status: 'CREATING', operation: 'CREATE', version: 2 }), replayed: false, send } });
    await assert.rejects(new SchoolSocialAdsService(f.db, p).operation(context(), adId, { operation: 'CREATE', expectedVersion: 1 }), /Unverified|SOCIAL_UNAVAILABLE/, JSON.stringify(send));
    assert.equal(p.boosts.length, 0);
  }
  const p = fake(), f = fixture({ start: { record: ad({ status: 'ACTIVATING', operation: 'ACTIVATE', version: 2 }), replayed: false, send: adSend('ACTIVATE', { providerAdId: null }) } });
  await assert.rejects(new SchoolSocialAdsService(f.db, p).operation(context(), adId, { operation: 'ACTIVATE', expectedVersion: 1 }), /Unverified|SOCIAL_UNAVAILABLE/);
  assert.equal(p.adStatusChanges.length, 0);
  for (const body of [{ operation: 'DELETE', expectedVersion: 1 }, { operation: 'CREATE' }, { operation: 'CREATE', expectedVersion: 1, budgetCents: 100 }]) {
    await assert.rejects(new SchoolSocialAdsService(fixture().db, fake()).operation(context(), adId, body), status(400, 'SOCIAL_INVALID'), JSON.stringify(body));
  }
});

test('database refusals map to closed codes with no SQL text', async () => {
  const cases = [['SOCIAL_FORBIDDEN', '42501', 403], ['SOCIAL_AD_NOT_FOUND', 'P0002', 404], ['SOCIAL_POST_NOT_FOUND', 'P0002', 404], ['SOCIAL_AD_POST_NOT_PUBLISHED', '55000', 409],
    ['SOCIAL_ADS_OFF', '23514', 409], ['SOCIAL_AD_NO_BUDGET', '23514', 409], ['SOCIAL_AD_OVER_CAP', '23514', 409], ['SOCIAL_AD_STATE', '55000', 409],
    ['SOCIAL_AD_CURRENCY_FIXED', '55000', 409], ['SOCIAL_VERSION_CONFLICT', '40001', 409]];
  for (const [message, code, httpStatus] of cases) {
    const error = Object.assign(new Error(message), { code });
    await assert.rejects(new SchoolSocialAdsService(fixture({ error }).db, fake()).operation(context(), adId, { operation: 'ACTIVATE', expectedVersion: 1 }), status(httpStatus, message), message);
  }
  const leak = Object.assign(new Error('relation hon.school_social_ad_budgets does not exist'), { code: '42P01' });
  await assert.rejects(new SchoolSocialAdsService(fixture({ error: leak }).db, off).read(readContext()),
    (e) => e.getStatus() === 503 && !JSON.stringify(e.getResponse()).includes('school_social_ad_budgets'));
});

test('controller: the cap needs the budget permission, everything else the ads permission; route ids are never authority', async () => {
  const organizationId = scope.organizationId, schoolId = scope.schoolId, asked = [];
  const database = { resolveAuthorizedScope: async (subject, school, permission) => { asked.push(permission); return { organizationId, schoolId, principalId: scope.principalId }; } };
  const calls = [];
  const ads = new Proxy({}, { get: (_, name) => async (...args) => { calls.push([name, args]); return name === 'read' ? view() : name === 'budget' ? { view: view(), replayed: false } : { ad: ad(), replayed: false }; } });
  const controller = new SchoolSocialAdsController(database, ads);
  const request = (query = {}) => ({ honIdentity: { externalSubject: 'verified-human' }, query });
  await controller.view(organizationId, schoolId, undefined, request());
  await controller.budget(organizationId, schoolId, 'k1', { monthlyCapCents: 100, currency: 'USD' }, request());
  await controller.create(organizationId, schoolId, 'k2', {}, request());
  await controller.operation(organizationId, schoolId, adId, 'k3', {}, request());
  await controller.cancel(organizationId, schoolId, adId, 'k4', {}, request());
  await controller.resolve(organizationId, schoolId, adId, 'k5', {}, request());
  assert.deepEqual(asked, ['marketing.social.ads', 'marketing.social.ads.budget', 'marketing.social.ads', 'marketing.social.ads', 'marketing.social.ads', 'marketing.social.ads']);
  assert.deepEqual(calls.map(c => c[0]), ['read', 'budget', 'create', 'operation', 'cancel', 'resolve']);
  assert.equal(calls[3][1][0].idempotencyKey, 'k3');
  await assert.rejects(controller.view(organizationId, schoolId, 'k', request()), status(409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED'));
  await assert.rejects(controller.view(organizationId, schoolId, undefined, request({ x: '1' })), status(400, 'SOCIAL_INVALID'));
  await assert.rejects(controller.create(organizationId, schoolId, undefined, {}, request()), status(400, 'IDEMPOTENCY_KEY_REQUIRED'));
  await assert.rejects(controller.create(organizationId, schoolId, 'k', {}, request({ schoolId })), status(400, 'SOCIAL_INVALID'));
  await assert.rejects(controller.create(randomUUID(), schoolId, 'k', {}, request()), status(403, 'SOCIAL_FORBIDDEN'));
  const none = new SchoolSocialAdsController({ resolveAuthorizedScope: async () => null }, ads);
  await assert.rejects(none.budget(organizationId, schoolId, 'k', {}, request()), status(403, 'SOCIAL_FORBIDDEN'));
});

test('HTTP adapter ad calls: refuse unless ads are approved; created PAUSED with a lifetime budget; exact paths; idempotency key; 4xx rejected, 5xx unknown; no leaks', async () => {
  const calls = [], routes = [];
  const reply = (code, body, type = 'application/json') => new Response(body === undefined ? null : JSON.stringify(body), { status: code, headers: { 'content-type': type } });
  const send = async (url, init) => { calls.push({ url, init }); const r = routes.shift(); return typeof r === 'function' ? r() : r; };
  let env = { ZERNIO_API_KEY: KEY, HON_ZERNIO_CONNECT_APPROVED: 'true', HON_ZERNIO_PUBLISH_APPROVED: 'true', HON_ZERNIO_INBOX_APPROVED: 'true' };
  const adapter = new ZernioHttpSocialAdapter(() => env, send);
  const boost = { providerAccountId: 'fb1', providerPostId: 'fbpost_1', budgetCents: 5000, currency: 'USD', startsOn: '2026-11-15', endsOn: '2026-11-21', timezone: 'America/Los_Angeles', idempotencyKey: adId };
  await assert.rejects(adapter.createBoost(boost), e => e instanceof SocialProviderError && e.failure === 'NOT_ENABLED');
  await assert.rejects(adapter.setAdActive({ providerAdId: 'ad_1', active: true, idempotencyKey: adId }), e => e.failure === 'NOT_ENABLED');
  assert.equal(calls.length, 0);
  env = { ZERNIO_API_KEY: KEY, HON_ZERNIO_ADS_APPROVED: 'true' };
  routes.push(reply(201, { ad: { id: 'ad_1' } }));
  assert.deepEqual(await adapter.createBoost(boost), { providerAdId: 'ad_1' });
  let call = calls.at(-1);
  assert.equal(call.url, 'https://zernio.com/api/v1/ads/boost'); assert.equal(call.init.headers['Idempotency-Key'], adId); assert.equal(call.init.redirect, 'error');
  assert.deepEqual(JSON.parse(call.init.body), { accountId: 'fb1', postId: 'fbpost_1', status: 'PAUSED', budget: { type: 'lifetime', amount: 5000, currency: 'USD' },
    schedule: { startDate: '2026-11-15', endDate: '2026-11-21', timezone: 'America/Los_Angeles' } });
  routes.push(reply(200, {}));
  await adapter.setAdActive({ providerAdId: 'ad_1', active: true, idempotencyKey: `${adId}:${leaseToken}` });
  call = calls.at(-1);
  assert.equal(call.url, 'https://zernio.com/api/v1/ads/ad_1/status'); assert.deepEqual(JSON.parse(call.init.body), { status: 'ACTIVE' });
  assert.equal(call.init.headers['Idempotency-Key'], `${adId}:${leaseToken}`);
  routes.push(reply(204));
  await adapter.setAdActive({ providerAdId: 'ad_1', active: false, idempotencyKey: adId });
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { status: 'PAUSED' });
  const before = calls.length;
  for (const bad of [{ ...boost, providerPostId: '../accounts' }, { ...boost, budgetCents: 50 }, { ...boost, currency: 'usd' }, { ...boost, timezone: 'x; DROP' }, { ...boost, startsOn: 'soon' }]) {
    await assert.rejects(adapter.createBoost(bad), e => e.failure === 'REJECTED', JSON.stringify(bad));
  }
  await assert.rejects(adapter.setAdActive({ providerAdId: '../x', active: true, idempotencyKey: adId }), e => e.failure === 'REJECTED');
  assert.equal(calls.length, before);
  for (const [r, failure] of [[reply(400, { error: 'bad ' + KEY }), 'REJECTED'], [reply(403, {}), 'REJECTED'], [reply(429, {}), 'RATE_LIMITED'], [reply(409, {}), 'UNKNOWN'],
    [reply(500, {}), 'UNKNOWN'], [reply(201, {}), 'UNKNOWN'], [reply(204), 'UNKNOWN'], [reply(201, '<html>', 'text/html'), 'UNKNOWN'], [() => { throw new Error('socket ' + KEY); }, 'UNKNOWN']]) {
    routes.push(r);
    await assert.rejects(adapter.createBoost(boost), e => e instanceof SocialProviderError && e.failure === failure && !e.message.includes(KEY), failure);
  }
});
