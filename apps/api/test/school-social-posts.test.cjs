const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHmac } = require('node:crypto');
const { SchoolSocialPostsService } = require('../dist/marketing/social/school-social-posts.service.js');
const { SocialPostDispatcher, SOCIAL_PUBLISH_BATCH_SIZE } = require('../dist/marketing/social/social-post-dispatcher.js');
const { FakeZernioSocialAdapter, ZernioHttpSocialAdapter, SocialProviderError, zernioPublishApproved, zernioSocialAdapterFactory } = require('../dist/marketing/social/zernio-social-adapter.js');
const { ZernioLeadWebhookVerifier, ZernioWebhookError, zernioSocialEventsReady } = require('../dist/communication/delivery/zernio-lead-webhook.js');
const { CommunicationWebhookController } = require('../dist/communication/delivery/communication-webhook.controller.js');
const { SendGridEventWebhookVerifier } = require('../dist/communication/delivery/sendgrid-email-provider.js');
const { TwilioWebhookVerifier } = require('../dist/communication/delivery/twilio-text-provider.js');

// Mocked boundary tests for the 0348 posts API, publish worker and receipts. Authority, state moves, leases and
// evidence are proven against PostgreSQL by test-school-social-posts.mjs. Nothing reaches Zernio: the HTTP adapter
// gets a stub fetch and the worker gets the deterministic fake.
const KEY = 'sk_' + 'b'.repeat(64);
const secret = 'w'.repeat(40);
const at = '2026-11-14T05:00:00.000Z';
const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const context = (patch = {}) => ({ ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: 'post-key', externalSubject: 'verified-human', ...patch });
const status = (value, code) => (error) => { assert.equal(error.getStatus(), value, JSON.stringify(error.getResponse?.())); if (code) assert.equal(error.getResponse().code, code); return true; };
const postId = randomUUID(), accountId = randomUUID(), targetId = randomUUID();
const target = (patch = {}) => ({ targetId, accountId, platform: 'FACEBOOK', displayName: 'Synthetic Dojo Page', status: 'PENDING', failureCode: null, skipReason: null,
  resolvedByPerson: false, settledAt: null, version: 1, ...patch });
const post = (patch = {}) => ({ postId, text: 'Free trial week!\nBring a friend.', linkUrl: null, status: 'DRAFT', publishAt: null, accountIds: [accountId], version: 1,
  createdAt: at, updatedAt: at, approvedAt: null, cancelledAt: null, targets: [], ...patch });

function fixture(options = {}) {
  const queries = [];
  const db = {
    async transaction(c, work, readOnly) {
      return work({ query: async (sql, args = []) => {
        queries.push({ sql, args, readOnly });
        if (/^SET LOCAL/.test(sql) || /set_config\('app\.hon_source','HUMAN_UI'/.test(sql)) return { rows: [] };
        if (options.error) throw options.error;
        if (/read_school_social_posts/.test(sql)) return { rows: [{ data: { posts: [post()], checkedAt: at } }] };
        if (/(create|edit|approve|cancel)_school_social_post\(|resolve_school_social_post_target/.test(sql)) return { rows: [{ data: options.receipt ?? { record: post(), replayed: false } }] };
        throw new Error('Unexpected SQL: ' + sql);
      } });
    },
    withTenantTransaction(c, work) { return this.transaction(c, work, false); },
    withTenantReadOnlyTransaction(c, work) { return this.transaction(c, work, true); },
  };
  return { db, queries };
}
const notReady = { publishReady: () => false };

test('switches: publishing needs a well-formed key AND the exact approval; either approval picks the real adapter', () => {
  assert.equal(zernioPublishApproved({}), false);
  assert.equal(zernioPublishApproved({ ZERNIO_API_KEY: KEY }), false);
  assert.equal(zernioPublishApproved({ ZERNIO_API_KEY: KEY, HON_ZERNIO_PUBLISH_APPROVED: '1' }), false);
  assert.equal(zernioPublishApproved({ ZERNIO_API_KEY: 'zrk_x', HON_ZERNIO_PUBLISH_APPROVED: 'true' }), false);
  assert.equal(zernioPublishApproved({ ZERNIO_API_KEY: KEY, HON_ZERNIO_PUBLISH_APPROVED: 'true' }), true);
  const publishOnly = zernioSocialAdapterFactory({ ZERNIO_API_KEY: KEY, HON_ZERNIO_PUBLISH_APPROVED: 'true' });
  assert.equal(publishOnly.kind, 'ZERNIO');
  // Publishing approval does not turn connecting on, and connecting approval does not turn publishing on.
  const real = new ZernioHttpSocialAdapter(() => ({ ZERNIO_API_KEY: KEY, HON_ZERNIO_PUBLISH_APPROVED: 'true' }));
  assert.deepEqual([real.publishReady(), real.ready()], [true, false]);
  const connectOnly = new ZernioHttpSocialAdapter(() => ({ ZERNIO_API_KEY: KEY, HON_ZERNIO_CONNECT_APPROVED: 'true' }));
  assert.deepEqual([connectOnly.publishReady(), connectOnly.ready()], [false, true]);
  const none = zernioSocialAdapterFactory({});
  assert.equal(none.publishReady(), false);
  assert.equal(new FakeZernioSocialAdapter(() => ({ HON_ZERNIO_FAKE_PROVIDER: '1', HON_DEPLOYMENT_ENVIRONMENT: 'production' })).publishReady(), false);
});

test('calendar read: exactly from and to, at most 100 days, one read-only call; reports whether publishing is on', async () => {
  const { db, queries } = fixture();
  const service = new SchoolSocialPostsService(db, notReady);
  const list = await service.list(context({ idempotencyKey: '' }), { from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' });
  assert.deepEqual([list.posts.length, list.publishEnabled], [1, false]);
  const call = queries.find(q => /read_school_social_posts/.test(q.sql));
  assert.equal(call.readOnly, true); assert.deepEqual(call.args, ['verified-human', '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z']);
  for (const query of [{}, { from: '2026-11-01T00:00:00Z' }, { from: '2026-11-01T00:00:00Z', to: '2026-11-01T00:00:00Z' },
    { from: '2026-11-01T00:00:00Z', to: '2027-03-01T00:00:00Z' }, { from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z', schoolId: randomUUID() },
    { from: 'yesterday', to: '2026-12-01T00:00:00Z' }]) {
    await assert.rejects(service.list(context({ idempotencyKey: '' }), query), status(400, 'SOCIAL_INVALID'), JSON.stringify(query));
  }
  const ready = new SchoolSocialPostsService(fixture().db, { publishReady: () => true });
  assert.equal((await ready.list(context({ idempotencyKey: '' }), { from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z' })).publishEnabled, true);
});

test('post commands: strict bodies, exact database arguments, a receipt for the same post, and no provider call', async () => {
  const { db, queries } = fixture();
  let provider = 0;
  const service = new SchoolSocialPostsService(db, { publishReady: () => { provider += 1; return true; }, publishPost: () => { throw new Error('never'); } });
  const created = await service.mutate(context(), 'create', null, { text: 'Free trial week!\nBring a friend.', accountIds: [accountId.toUpperCase()], linkUrl: 'https://dojo.example.test/trial' });
  assert.equal(created.post.postId, postId);
  const create = queries.find(q => /create_school_social_post/.test(q.sql));
  assert.deepEqual(JSON.parse(create.args[1]), { text: 'Free trial week!\nBring a friend.', accountIds: [accountId], linkUrl: 'https://dojo.example.test/trial' });
  assert.equal(create.args[2], 'post-key');
  for (const body of [{ text: '', accountIds: [accountId] }, { text: 'x'.repeat(2201), accountIds: [accountId] }, { text: 'bell\u0007', accountIds: [accountId] },
    { text: 'ok', accountIds: [] }, { text: 'ok', accountIds: [accountId, accountId] }, { text: 'ok', accountIds: [1, 2, 3, 4, 5].map(() => randomUUID()) },
    { text: 'ok', accountIds: [accountId], linkUrl: 'http://dojo.example.test' }, { text: 'ok', accountIds: [accountId], linkUrl: 'javascript:alert(1)' },
    { text: 'ok', accountIds: [accountId], schoolId: randomUUID() }, { text: 'ok', accountIds: [accountId], status: 'APPROVED' }]) {
    await assert.rejects(service.mutate(context(), 'create', null, body), status(400, 'SOCIAL_INVALID'), JSON.stringify(body).slice(0, 80));
  }
  await service.mutate(context(), 'approve', postId, { expectedVersion: 1, publishAt: '2026-11-20T15:00:00-06:00' });
  assert.deepEqual(JSON.parse(queries.find(q => /approve_school_social_post/.test(q.sql)).args[2]), { expectedVersion: 1, publishAt: '2026-11-20T15:00:00-06:00' });
  for (const body of [{}, { expectedVersion: 0 }, { expectedVersion: 1, publishAt: 'tomorrow' }, { expectedVersion: 1, publishAt: 5 }, { expectedVersion: 1, approvedBy: 'x' }]) {
    await assert.rejects(service.mutate(context(), 'approve', postId, body), status(400, 'SOCIAL_INVALID'), JSON.stringify(body));
  }
  await assert.rejects(service.mutate(context(), 'cancel', postId, { expectedVersion: 1, reason: 'x' }), status(400, 'SOCIAL_INVALID'));
  await assert.rejects(service.mutate(context(), 'resolve', targetId, { expectedVersion: 1, outcome: 'RETRY' }), status(400, 'SOCIAL_INVALID'));
  await assert.rejects(service.mutate(context(), 'edit', null, { text: 'ok', accountIds: [accountId], expectedVersion: 1 }), status(400, 'SOCIAL_INVALID'));
  // A receipt for a different post (or a resolve answer without the target) is never passed on.
  const other = new SchoolSocialPostsService(fixture({ receipt: { record: post({ postId: randomUUID() }), replayed: false } }).db, notReady);
  await assert.rejects(other.mutate(context(), 'approve', postId, { expectedVersion: 1 }), /Unverified/);
  await assert.rejects(new SchoolSocialPostsService(fixture().db, notReady).mutate(context(), 'resolve', targetId, { expectedVersion: 1, outcome: 'PUBLISHED' }), /Unverified/);
  // Commands need a person, the browser command source and a key; reads need no key.
  await assert.rejects(service.mutate(context({ idempotencyKey: '' }), 'create', null, { text: 'ok', accountIds: [accountId] }), status(403, 'SOCIAL_FORBIDDEN'));
  await assert.rejects(service.mutate(context({ principalType: 'AGENT' }), 'create', null, { text: 'ok', accountIds: [accountId] }), status(403, 'SOCIAL_FORBIDDEN'));
  await assert.rejects(service.list(context(), { from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z' }), status(403, 'SOCIAL_FORBIDDEN'));
  assert.equal(provider, 0, 'post commands never look at the provider');
});

test('database refusals map to closed codes', async () => {
  const cases = [['SOCIAL_MEDIA_REQUIRED', '0A000', 422], ['SOCIAL_POST_NOT_FOUND', 'P0002', 404], ['SOCIAL_POST_STATE', '55000', 409], ['SOCIAL_PUBLISH_OFF', '23514', 409],
    ['SOCIAL_ACCOUNT_DISCONNECTED', '23514', 409], ['SOCIAL_VERSION_CONFLICT', '40001', 409], ['SOCIAL_FORBIDDEN', '42501', 403], ['SOCIAL_INVALID', '22023', 400],
    ['IDEMPOTENCY_KEY_REUSED', '23505', 409], ['SOCIAL_BUSY', '55P03', 409], ['SOCIAL_ACCOUNT_NOT_FOUND', 'P0002', 404]];
  for (const [message, code, http] of cases) {
    const service = new SchoolSocialPostsService(fixture({ error: Object.assign(new Error(message), { code }) }).db, notReady);
    await assert.rejects(service.mutate(context(), 'approve', postId, { expectedVersion: 1 }), status(http, message), message);
  }
  const service = new SchoolSocialPostsService(fixture({ error: Object.assign(new Error('relation "hon.secret" does not exist'), { code: '42P01' }) }).db, notReady);
  await assert.rejects(service.mutate(context(), 'approve', postId, { expectedVersion: 1 }), (e) => e.getStatus() === 503 && !JSON.stringify(e.getResponse()).includes('secret'));
});

function workerStore(targets, outcomes = []) {
  const recorded = [];
  let calls = 0;
  return {
    recorded,
    isConfigured: () => true,
    async claimSocialPostTargets(limit, lease) { calls += 1; assert.equal(lease, 60); assert(limit <= SOCIAL_PUBLISH_BATCH_SIZE); return calls === 1 ? targets.slice(0, limit) : calls === 2 ? targets.slice(limit) : []; },
    async recordSocialPostResult(id, token, outcome, providerPostId) { recorded.push({ id, token, outcome, providerPostId }); const late = outcomes.shift(); return late ?? { status: outcome, accepted: true }; },
  };
}
const claimed = (patch = {}) => ({ targetId: randomUUID(), leaseToken: randomUUID(), organizationId: scope.organizationId, schoolId: scope.schoolId, platform: 'FACEBOOK',
  providerAccountId: 'fbpage_1', providerProfileId: 'prof_1', text: 'Free trial week!', linkUrl: null, ...patch });

test('publish worker: claims nothing unless publishing is ready; each target is sent once; only a clear refusal is FAILED, anything unclear is UNKNOWN', async () => {
  const env = {};
  const fake = new FakeZernioSocialAdapter(() => env);
  let store = workerStore([claimed()]);
  let summary = await new SocialPostDispatcher(store, fake).runOnce();
  assert.deepEqual(summary, { claimed: 0, published: 0, failed: 0, unknown: 0, lateResults: 0, ready: false });
  assert.equal(store.recorded.length, 0);
  Object.assign(env, { HON_ZERNIO_FAKE_PROVIDER: '1', HON_DEPLOYMENT_ENVIRONMENT: 'development' });
  const a = claimed(), b = claimed({ text: 'Second', linkUrl: 'https://dojo.example.test' }), c = claimed();
  store = workerStore([a, b, c]);
  fake.failNext.publishPost = undefined;
  summary = await new SocialPostDispatcher(store, fake).runOnce();
  assert.deepEqual([summary.claimed, summary.published], [3, 3]);
  assert.deepEqual(store.recorded.map(r => [r.id, r.token, r.outcome]), [a, b, c].map(t => [t.targetId, t.leaseToken, 'PUBLISHED']));
  assert.deepEqual(fake.published.map(p => p.idempotencyKey), [a.targetId, b.targetId, c.targetId]);
  assert.equal(fake.published[1].linkUrl, 'https://dojo.example.test');
  for (const [failure, outcome] of [['REJECTED', 'FAILED'], ['RATE_LIMITED', 'FAILED'], ['UNKNOWN', 'UNKNOWN'], ['UNAVAILABLE', 'UNKNOWN']]) {
    const t = claimed(); store = workerStore([t]); fake.failNext.publishPost = failure;
    await new SocialPostDispatcher(store, fake).runOnce();
    assert.deepEqual(store.recorded.map(r => [r.outcome, r.providerPostId]), [[outcome, null]], failure);
  }
  // A thrown non-provider error (a bug, a socket error) is UNKNOWN, never success and never a resend.
  const broken = { kind: 'FAKE', publishReady: () => true, publishPost: async () => { throw new TypeError('boom'); } };
  store = workerStore([claimed()]);
  await new SocialPostDispatcher(store, broken).runOnce();
  assert.equal(store.recorded[0].outcome, 'UNKNOWN');
  // A result the database no longer takes (the lease ran out and a person settled it) is counted, not retried.
  store = workerStore([claimed()], [{ status: 'FAILED', accepted: false }]);
  summary = await new SocialPostDispatcher(store, fake).runOnce();
  assert.deepEqual([summary.lateResults, summary.failed, fake.published.length], [1, 1, 4]);
  // A store without the worker database configured claims nothing.
  summary = await new SocialPostDispatcher({ isConfigured: () => false }, fake).runOnce();
  assert.equal(summary.claimed, 0);
});

test('HTTP adapter publish: refuses unless publishing is approved; Facebook only; idempotency key; 4xx is rejected, 5xx and odd answers unknown; no leaks', async () => {
  const calls = [], routes = [];
  const reply = (code, body, type = 'application/json') => new Response(body === undefined ? null : JSON.stringify(body), { status: code, headers: { 'content-type': type } });
  const send = async (url, init) => { calls.push({ url, init }); const r = routes.shift(); return typeof r === 'function' ? r() : r; };
  let env = { ZERNIO_API_KEY: KEY, HON_ZERNIO_CONNECT_APPROVED: 'true' };
  const adapter = new ZernioHttpSocialAdapter(() => env, send);
  const input = { profileId: 'prof_1', providerAccountId: 'fb1', platform: 'FACEBOOK', text: 'Hello', linkUrl: 'https://dojo.example.test', idempotencyKey: targetId };
  await assert.rejects(adapter.publishPost(input), e => e instanceof SocialProviderError && e.failure === 'NOT_ENABLED'); assert.equal(calls.length, 0);
  env = { ZERNIO_API_KEY: KEY, HON_ZERNIO_PUBLISH_APPROVED: 'true' };
  await assert.rejects(adapter.publishPost({ ...input, platform: 'INSTAGRAM' }), e => e.failure === 'REJECTED'); assert.equal(calls.length, 0);
  routes.push(reply(201, { post: { _id: 'zpost_1', status: 'published', platforms: [{ platformPostId: 'meta_1' }] } }));
  assert.deepEqual(await adapter.publishPost(input), { providerPostId: 'zpost_1' });
  const call = calls.at(-1);
  assert.equal(call.url, 'https://zernio.com/api/v1/posts'); assert.equal(call.init.method, 'POST'); assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.headers['Idempotency-Key'], targetId); assert.equal(call.init.headers.Authorization, 'Bearer ' + KEY);
  assert.deepEqual(JSON.parse(call.init.body), { content: 'Hello\n\nhttps://dojo.example.test', publishNow: true, platforms: [{ platform: 'facebook', accountId: 'fb1' }] });
  // Connecting being off does not stop publishing, and vice versa (checked above).
  for (const [r, failure] of [[reply(400, { error: 'bad ' + KEY }), 'REJECTED'], [reply(401, {}), 'REJECTED'], [reply(422, {}), 'REJECTED'], [reply(429, {}), 'RATE_LIMITED'],
    [reply(409, {}), 'UNKNOWN'], [reply(408, {}), 'UNKNOWN'], [reply(500, {}), 'UNKNOWN'], [reply(502, {}), 'UNKNOWN'], [reply(201, { post: {} }), 'UNKNOWN'],
    [reply(201, { post: { _id: 'bad id!' } }), 'UNKNOWN'], [reply(201, '<html>', 'text/html'), 'UNKNOWN'], [() => { throw new Error('socket ' + KEY); }, 'UNKNOWN']]) {
    routes.push(r);
    await assert.rejects(adapter.publishPost(input), e => e instanceof SocialProviderError && e.failure === failure && !e.message.includes(KEY), failure);
  }
});

const sign = (body, key = secret) => createHmac('sha256', key).update(body).digest('hex');
const raw = (value) => Buffer.from(JSON.stringify(value));
const reason = (fn) => { try { fn(); return 'OK'; } catch (error) { return error instanceof ZernioWebhookError ? error.reason : error.message; } };
const publishEnv = (over = {}) => ({ ZERNIO_WEBHOOK_SECRET: secret, ZERNIO_API_KEY: KEY, HON_ZERNIO_PUBLISH_APPROVED: 'true', ...over });

test('receipts: post and account events only when publishing is on; signed; identifiers only; the lead path is unchanged', () => {
  assert.equal(zernioSocialEventsReady({}), false);
  assert.equal(zernioSocialEventsReady(publishEnv({ ZERNIO_WEBHOOK_SECRET: 'short' })), false);
  assert.equal(zernioSocialEventsReady(publishEnv({ HON_ZERNIO_PUBLISH_APPROVED: 'false' })), false);
  assert.equal(zernioSocialEventsReady(publishEnv()), true);
  assert.equal(zernioSocialEventsReady({ ZERNIO_WEBHOOK_SECRET: secret, HON_ZERNIO_FAKE_PROVIDER: '1', HON_DEPLOYMENT_ENVIRONMENT: 'production' }), false);
  const published = { id: 'evt_p1', event: 'post.published', post: { _id: 'zpost_1', content: 'IGNORED TEXT', error: 'ignored' }, account: { _id: 'fb1', platform: 'facebook', accessToken: 'x' } };
  const verifier = new ZernioLeadWebhookVerifier(() => publishEnv());
  let body = raw(published);
  assert.deepEqual(verifier.receive(body, sign(body)), { kind: 'SOCIAL', event: { eventId: 'evt_p1', eventType: 'post.published', platform: 'FACEBOOK', providerAccountId: 'fb1', providerPostId: 'zpost_1' } });
  body = raw({ id: 'evt_d1', event: 'account.disconnected', account: { id: 'ig9', platform: 'instagram' } });
  assert.deepEqual(verifier.receive(body, sign(body)).event, { eventId: 'evt_d1', eventType: 'account.disconnected', platform: 'INSTAGRAM', providerAccountId: 'ig9', providerPostId: null });
  assert.equal(reason(() => verifier.receive(body, sign(body, 'z'.repeat(40)))), 'SIGNATURE_INVALID');
  for (const bad of [{ ...published, id: 'bad id!' }, { ...published, post: {} }, { ...published, account: { _id: 'fb1', platform: 'tiktok' } }, { ...published, account: undefined }]) {
    const b = raw(bad); assert.equal(reason(() => verifier.receive(b, sign(b))), 'MALFORMED', JSON.stringify(bad));
  }
  for (const ignored of [{ ...published, test: true }, { ...published, event: 'message.received' }]) { const b = raw(ignored); assert.equal(verifier.receive(b, sign(b)), null); }
  // A lead while lead intake is off is still NOT_CONFIGURED (Zernio retries later), as before.
  const lead = raw({ id: 'evt_l', event: 'lead.received', lead: {}, account: { id: '1', platform: 'facebook' } });
  assert.equal(reason(() => verifier.receive(lead, sign(lead))), 'NOT_CONFIGURED');
  // Neither piece on: refused before the signature is even read.
  assert.equal(reason(() => new ZernioLeadWebhookVerifier(() => ({ ZERNIO_WEBHOOK_SECRET: secret })).receive(body, sign(body))), 'NOT_CONFIGURED');
  // Lead intake on, publishing off: post events are acknowledged and ignored, exactly as before 0348.
  const leadsOnly = new ZernioLeadWebhookVerifier(() => ({ ZERNIO_WEBHOOK_SECRET: secret, HON_ZERNIO_LEAD_INTAKE_APPROVED: 'true' }));
  const p = raw(published); assert.equal(leadsOnly.receive(p, sign(p)), null);
});

test('webhook controller: post receipts go to the worker store once; bad input 422; database trouble 503', async () => {
  const events = [];
  const store = (result) => ({ isConfigured: () => true, recordZernioLead: async () => { throw new Error('not a lead'); },
    recordSocialPostEvent: async (event) => { events.push(event); if (result instanceof Error) throw result; return { outcome: result }; } });
  const run = async (result, value) => {
    const controller = new CommunicationWebhookController(store(result), new SendGridEventWebhookVerifier(() => ({})), new TwilioWebhookVerifier(() => ({})), new ZernioLeadWebhookVerifier(() => publishEnv()));
    const body = raw(value);
    try { return { status: 200, body: await controller.zernioLead({ body }, sign(body)) }; } catch (error) { return { status: error.getStatus() }; }
  };
  const value = { id: 'evt_f1', event: 'post.failed', post: { id: 'zpost_2' }, account: { id: 'fb1', platform: 'facebook' } };
  for (const outcome of ['APPLIED', 'IGNORED', 'UNMATCHED', 'REPLAYED']) assert.deepEqual(await run(outcome, value), { status: 200, body: { received: true } });
  assert.equal((await run(new Error('connection lost'), value)).status, 503);
  assert.equal((await run(Object.assign(new Error('bad'), { code: '22023' }), value)).status, 422);
  assert.deepEqual(events[0], { eventId: 'evt_f1', eventType: 'post.failed', platform: 'FACEBOOK', providerAccountId: 'fb1', providerPostId: 'zpost_2' });
  const unconfigured = new CommunicationWebhookController({ isConfigured: () => false }, new SendGridEventWebhookVerifier(() => ({})), new TwilioWebhookVerifier(() => ({})), new ZernioLeadWebhookVerifier(() => publishEnv()));
  const body = raw(value);
  await assert.rejects(unconfigured.zernioLead({ body }, sign(body)), (e) => e.getStatus() === 503);
});
