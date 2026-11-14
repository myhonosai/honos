const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { CreativeStudioService } = require('../dist/creative-studio/creative-studio.service.js');
const { CreativeJobWorker, CreativeJobScheduler, CreativeJobWorkerDatabase } = require('../dist/creative-studio/creative-job-worker.js');
const { CreativeLimitsHqController, CreativeLimitsService } = require('../dist/creative-studio/creative-limits.controller.js');
const {
  SyntheticAsyncCreativeProviderRuntime, SyntheticCreativeProviderRuntime, UnconfiguredCreativeProviderRuntime, isAsyncCreativeProviderRuntime,
} = require('../dist/creative-studio/creative-provider-runtime.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

const U = () => randomUUID();
const kinds = ['INCLUDED_MONTHLY', 'ADJUSTMENT', 'PROMOTIONAL', 'PURCHASED_TOPUP'];
const balance = (available = 11900, held = 100) => ({ availableCredits: available, heldCredits: held, byKind: kinds.map((kind, i) => ({ kind, grantedCredits: i ? 0 : 12000,
  availableCredits: i ? 0 : available, heldCredits: i ? 0 : held, consumedCredits: i ? 0 : 12000 - available - held, expiredCredits: 0, debitedCredits: 0 })) });
const input = (patch = {}) => ({ operationCode: 'image.generate', units: 2, format: 'SQUARE', prompt: 'A bright poster for our spring kids karate camp', ...patch });
const sqlError = (message, code) => Object.assign(new Error(message), { code });

/** A fake database that answers like 0216 + 0354 for the runtime role and records every call. */
function fakeDatabase({ createReplayed = false, begin, recordSubmission } = {}) {
  const calls = [];
  const db = { calls, callSaasBilling: async (operation, params) => {
    calls.push([operation, params]);
    if (operation === 'createCreativeGeneration') {
      const body = JSON.parse(params[2]);
      db.last = { generationId: U(), schoolId: params[1], operationCode: body.operationCode, mediaKind: body.operationCode.startsWith('video') ? 'VIDEO' : 'IMAGE',
        units: body.units, format: body.format, prompt: body.prompt, status: 'GENERATING', failureReason: null, reservedCredits: body.units * 50, chargedCredits: null,
        createdAt: new Date().toISOString(), completedAt: null, assets: [] };
      return { generation: db.last, balance: balance(), replayed: createReplayed };
    }
    if (operation === 'beginCreativeProviderSubmission') {
      if (begin) throw begin;
      return { jobId: (db.jobId = U()), generationId: params[1], status: 'PERMITTED', submitted: false, deadlineAt: new Date(Date.now() + 1_800_000).toISOString(), replayed: false };
    }
    if (operation === 'recordCreativeProviderSubmission') {
      if (recordSubmission) throw recordSubmission;
      return { jobId: db.jobId, generationId: params[1], status: 'SUBMITTED', submitted: true, deadlineAt: new Date(Date.now() + 1_800_000).toISOString(), replayed: false };
    }
    if (operation === 'recordCreativeGenerationResult') {
      const outcome = JSON.parse(params[2]), g = db.last;
      const status = { SUCCEEDED: 'SUCCEEDED', FAILED: 'FAILED', NOT_SENT: 'FAILED', UNKNOWN: 'UNDER_REVIEW' }[outcome.outcome];
      return { generation: { ...g, status, failureReason: outcome.failureReason, completedAt: new Date(Date.parse(g.createdAt) + 5_000).toISOString(), chargedCredits: null, assets: [] },
        balance: balance(12000, 0), replayed: false };
    }
    throw new Error(`unexpected ${operation}`);
  } };
  return db;
}
const service = (db, runtime) => new CreativeStudioService(new SaasBillingService(db), runtime);
const ops = db => db.calls.map(([op]) => op);
const outcomeOf = db => JSON.parse(db.calls.find(([op]) => op === 'recordCreativeGenerationResult')[1][2]);

test('C1 async runtime: permit -> one submit -> provider job id recorded; the generation stays GENERATING for the worker', async () => {
  const db = fakeDatabase(), runtime = new SyntheticAsyncCreativeProviderRuntime(), school = U();
  assert.equal(isAsyncCreativeProviderRuntime(runtime), true);
  assert.equal(isAsyncCreativeProviderRuntime(new SyntheticCreativeProviderRuntime()), false, 'the CS1 synchronous runtimes keep the synchronous path');
  const out = await service(db, runtime).create('verified-human', school, input(), U());
  assert.equal(out.generation.status, 'GENERATING'); assert.equal(out.replayed, false);
  assert.deepEqual(ops(db), ['createCreativeGeneration', 'beginCreativeProviderSubmission', 'recordCreativeProviderSubmission']);
  assert.deepEqual(db.calls[1][1], ['verified-human', db.last.generationId]);
  assert.deepEqual(db.calls[2][1], ['verified-human', db.last.generationId, `job-${db.last.generationId}`]);
  assert.equal(runtime.submits.length, 1); assert.equal(runtime.polls.length, 0);
  assert.equal(runtime.submits[0].providerRequestId, db.last.generationId);
  assert.deepEqual(JSON.parse(db.calls[0][1][3]), { providerId: 'HIGGSFIELD', modelCode: 'async-image-generate-1' });
});

test('C1 a refused permit sends nothing, records NOT_SENT (credits back) and answers with the refusal', async () => {
  for (const [message, sqlstate, status] of [['CREATIVE_PROVIDER_DAILY_LIMIT', '23514', 422], ['CREATIVE_PROVIDER_LIMIT_NOT_SET', '23514', 422],
    ['SAAS_CREATIVE_AI_PAUSED_BY_HQ', '23514', 422], ['CREATIVE_GENERATION_STALE', '40001', 409], ['SAAS_FORBIDDEN', '42501', 403], ['lost', '08006', 503]]) {
    const db = fakeDatabase({ begin: sqlError(message, sqlstate) }), runtime = new SyntheticAsyncCreativeProviderRuntime();
    await assert.rejects(service(db, runtime).create('verified-human', U(), input(), U()),
      e => e.getStatus() === status && (status === 503 || status === 403 || e.getResponse().code === message), message);
    assert.equal(runtime.submits.length, 0, message);
    assert.deepEqual(ops(db), ['createCreativeGeneration', 'beginCreativeProviderSubmission', 'recordCreativeGenerationResult'], message);
    assert.deepEqual([outcomeOf(db).outcome, outcomeOf(db).failureReason, outcomeOf(db).providerCostMicrounits], ['NOT_SENT', 'PROVIDER_NOT_CONNECTED', null], message);
  }
});

test('C1 submit outcomes are recorded once and never resent: PRE_SEND, FAILED, a lost answer, an unsafe job id', async () => {
  for (const [behaviour, expected] of [['PRE_SEND', ['NOT_SENT', 'INVALID_REQUEST']], ['REJECT', ['FAILED', 'PROVIDER_REJECTED']],
    ['UNKNOWN', ['UNKNOWN', 'PROVIDER_UNKNOWN']], ['BAD_ID', ['UNKNOWN', 'UNVERIFIED_RESULT']]]) {
    const db = fakeDatabase(), runtime = new SyntheticAsyncCreativeProviderRuntime(behaviour);
    const out = await service(db, runtime).create('verified-human', U(), input(), U());
    assert.equal(runtime.submits.length, 1, behaviour);
    assert.deepEqual(ops(db), ['createCreativeGeneration', 'beginCreativeProviderSubmission', 'recordCreativeGenerationResult'], behaviour);
    assert.deepEqual([outcomeOf(db).outcome, outcomeOf(db).failureReason], expected, behaviour);
    assert.notEqual(out.generation.status, 'GENERATING', behaviour);
  }
});

test('C1 a lost job-id record leaves the job PERMITTED for the deadline sweep; a replay never permits or submits again', async () => {
  const lost = fakeDatabase({ recordSubmission: sqlError('lost', '08006') }), r1 = new SyntheticAsyncCreativeProviderRuntime();
  const out = await service(lost, r1).create('verified-human', U(), input(), U());
  assert.equal(out.generation.status, 'GENERATING');
  assert.deepEqual(ops(lost), ['createCreativeGeneration', 'beginCreativeProviderSubmission', 'recordCreativeProviderSubmission'], 'no guessed outcome');
  const replay = fakeDatabase({ createReplayed: true }), r2 = new SyntheticAsyncCreativeProviderRuntime();
  assert.equal((await service(replay, r2).create('verified-human', U(), input(), U())).generation.status, 'GENERATING');
  assert.deepEqual([ops(replay), r2.submits.length], [['createCreativeGeneration'], 0]);
});

/** A fake worker store answering like the 0354 worker functions. */
function fakeStore(jobs, { recordStatus = 'RECORDED', recordError, configured = true } = {}) {
  const calls = [];
  return { calls, isConfigured: () => configured,
    claim: async (limit, lease) => { calls.push(['claim', limit, lease]); return jobs; },
    recordPoll: async (job, lease) => { calls.push(['poll', job, lease]); return { status: 'SUBMITTED', nextPollAt: new Date().toISOString() }; },
    recordResult: async (job, lease, outcome) => { calls.push(['result', job, lease, outcome]); if (recordError) throw recordError; return { status: recordStatus }; } };
}
const job = (patch = {}) => ({ jobId: U(), leaseToken: U(), providerId: 'HIGGSFIELD', providerJobId: `job-${U()}`, modelCode: 'async-image-generate-1',
  operationCode: 'image.generate', mediaKind: 'IMAGE', units: 2, format: 'SQUARE', pollCount: 0, deadlineAt: new Date(Date.now() + 600_000).toISOString(), ...patch });

test('C1 worker: claim -> poll -> record; PENDING and poll errors back off, final answers are verified, never guessed', async () => {
  const cases = [['PENDING', null], ['ERROR', null], ['SUCCEED', ['SUCCEEDED', null]], ['REJECT', ['FAILED', 'PROVIDER_REJECTED']],
    ['REJECT_WITH_COST', ['FAILED', 'PROVIDER_REJECTED']], ['UNKNOWN', ['UNKNOWN', 'PROVIDER_UNKNOWN']], ['UNVERIFIED', ['UNKNOWN', 'UNVERIFIED_RESULT']]];
  for (const [step, expected] of cases) {
    const j = job(), store = fakeStore([j]), runtime = new SyntheticAsyncCreativeProviderRuntime('ACCEPT', [step]);
    const summary = await new CreativeJobWorker(store, runtime).runOnce();
    assert.deepEqual(store.calls[0], ['claim', 10, 120], step);
    assert.equal(runtime.polls.length, 1, step);
    assert.deepEqual(Object.keys(runtime.polls[0]).sort(), ['format', 'mediaKind', 'modelCode', 'operationCode', 'providerId', 'providerJobId', 'units'], 'no prompt, school or lease');
    if (!expected) {
      assert.deepEqual(store.calls.slice(1), [['poll', j.jobId, j.leaseToken]], step);
      assert.deepEqual(summary, { claimed: 1, recorded: 0, heldForHq: 0, pending: 1, errors: 0 }, step);
      continue;
    }
    const [, id, lease, outcome] = store.calls[1];
    assert.deepEqual([id, lease, outcome.outcome, outcome.failureReason], [j.jobId, j.leaseToken, ...expected], step);
    if (step === 'SUCCEED') assert.deepEqual([outcome.finalUnits, outcome.providerCostMicrounits, outcome.assets.length], [2, 2000, 2]);
    if (step === 'REJECT_WITH_COST') assert.equal(outcome.providerCostMicrounits, 250);
    assert.deepEqual(summary, { claimed: 1, recorded: 1, heldForHq: 0, pending: 0, errors: 0 }, step);
  }
});

test('C1 worker: unusable jobs, no async provider, refused records and held answers never stop the run', async () => {
  const off = fakeStore([job()], { configured: false });
  assert.deepEqual(await new CreativeJobWorker(off, new SyntheticAsyncCreativeProviderRuntime()).runOnce(), { claimed: 0, recorded: 0, heldForHq: 0, pending: 0, errors: 0 });
  assert.equal(off.calls.length, 0, 'no worker login: nothing is claimed');
  // Production wiring (no provider connected): claimed jobs are only released, never answered, so the deadline sweep decides.
  const sync = fakeStore([job(), job()]);
  assert.equal((await new CreativeJobWorker(sync, new UnconfiguredCreativeProviderRuntime()).runOnce()).pending, 2);
  assert.deepEqual(sync.calls.slice(1).map(c => c[0]), ['poll', 'poll']);
  const bad = fakeStore([job({ providerJobId: '../x' }), job({ mediaKind: 'AUDIO' }), job({ format: 'BANNER' }), job({ units: 0 })]), r = new SyntheticAsyncCreativeProviderRuntime();
  assert.equal((await new CreativeJobWorker(bad, r).runOnce()).pending, 4); assert.equal(r.polls.length, 0, 'never asks the provider about an unsafe job');
  const refused = fakeStore([job(), job()], { recordError: sqlError('CREATIVE_JOB_LEASE_LOST', '40001') });
  assert.deepEqual(await new CreativeJobWorker(refused, new SyntheticAsyncCreativeProviderRuntime()).runOnce(), { claimed: 2, recorded: 0, heldForHq: 0, pending: 0, errors: 2 });
  const held = fakeStore([job()], { recordStatus: 'REQUESTER_UNAVAILABLE' });
  assert.equal((await new CreativeJobWorker(held, new SyntheticAsyncCreativeProviderRuntime()).runOnce()).heldForHq, 1);
});

test('C1 wiring: no provider is connected, the loop is off by default and the worker never uses the runtime login', async () => {
  const wiring = readFileSync(join(__dirname, '../src/app.module.ts'), 'utf8');
  assert.match(wiring, /provide: CREATIVE_PROVIDER_RUNTIME, useFactory: \(\) => new UnconfiguredCreativeProviderRuntime\(\)/);
  assert.doesNotMatch(wiring, /SyntheticAsyncCreativeProviderRuntime|SyntheticCreativeProviderRuntime/);
  assert.match(wiring, /provide: CREATIVE_JOB_WORKER_STORE, useExisting: CreativeJobWorkerDatabase/);
  const saved = { ...process.env };
  try {
    delete process.env.HON_CREATIVE_JOB_POLL_INTERVAL_SECONDS; process.env.HON_COMMUNICATION_WORKER_DATABASE_URL = 'postgresql://w@localhost/x';
    let runs = 0; const scheduler = new CreativeJobScheduler({ runOnce: async () => { runs += 1; return { claimed: 0 }; } });
    scheduler.onModuleInit(); assert.equal(scheduler.timer, undefined, 'off without an interval');
    process.env.HON_CREATIVE_JOB_POLL_INTERVAL_SECONDS = '5'; scheduler.onModuleInit(); assert.equal(scheduler.timer, undefined, 'out-of-range interval refused');
    await scheduler.tick(); assert.equal(runs, 1);
    process.env.HON_RUNTIME_DATABASE_URL = process.env.HON_COMMUNICATION_WORKER_DATABASE_URL;
    await assert.rejects(new CreativeJobWorkerDatabase().claim(1, 30), /COMMUNICATION_WORKER_ROLE_UNSAFE/);
    delete process.env.HON_COMMUNICATION_WORKER_DATABASE_URL;
    assert.equal(new CreativeJobWorkerDatabase().isConfigured(), false);
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});

const providers = () => [{ providerId: 'HEYGEN', dailyLimitMicros: null, version: 0, reason: null, committedTodayMicros: 0, openJobs: 0, overdueJobs: 0 },
  { providerId: 'HIGGSFIELD', dailyLimitMicros: 25_000_000, version: 1, reason: 'Owner default guard for launch', committedTodayMicros: 2_000_000, openJobs: 1, overdueJobs: 0 }];
const view = (patch = {}) => ({ providers: providers(), requesterUnavailable: [], defaultSchoolCaps: { images: 50, videos: 12, avatarVideos: 10 },
  schoolCaps: [], day: { start: '2026-11-14T00:00:00.000Z', end: '2026-11-15T00:00:00.000Z' }, ...patch });

test('C1 HQ limit contracts are closed and fail closed on drift', () => {
  const limit = { providerId: 'HEYGEN', dailyLimitMicros: 50_000_000, reason: 'Owner default guard for launch', expectedVersion: 0 };
  assert.deepEqual(contracts.validateCreativeProviderDailyLimitInput(limit), limit);
  for (const bad of [{ ...limit, providerId: 'OPENAI' }, { ...limit, dailyLimitMicros: 10_000_000_001 }, { ...limit, dailyLimitMicros: -1 }, { ...limit, reason: 'short' },
    { ...limit, reason: ' padded reason here' }, { ...limit, expectedVersion: 1.5 }, { ...limit, schoolId: U() }])
    assert.throws(() => contracts.validateCreativeProviderDailyLimitInput(bad), JSON.stringify(bad));
  const caps = { schoolId: U(), images: 20, videos: 5, avatarVideos: 0, reason: 'Pilot school, keep it small', expectedVersion: 0 };
  assert.deepEqual(contracts.validateCreativeSchoolDailyCapsInput(caps), caps);
  for (const bad of [{ ...caps, images: 1001 }, { ...caps, videos: -1 }, { ...caps, schoolId: 'x' }, (({ avatarVideos, ...rest }) => rest)(caps)])
    assert.throws(() => contracts.validateCreativeSchoolDailyCapsInput(bad), JSON.stringify(bad));
  assert.doesNotThrow(() => contracts.validateCreativeLimitsHqView(view()));
  assert.doesNotThrow(() => contracts.validateCreativeLimitsHqView(view({ requesterUnavailable: [{ jobId: U(), schoolId: U(), reservationId: U(), providerId: 'HEYGEN',
    closedAt: '2026-11-14T01:00:00.000Z', providerResult: { outcome: 'SUCCEEDED' } }] })));
  for (const bad of [view({ providers: providers().reverse() }), view({ providers: [providers()[0]] }), view({ defaultSchoolCaps: { images: 51, videos: 12, avatarVideos: 10 } }),
    view({ providers: [{ ...providers()[0], dailyLimitMicros: 1 }, providers()[1]] }), view({ providers: [providers()[0], { ...providers()[1], reason: null }] }),
    view({ day: { start: '2026-11-14T00:00:00.000Z', end: '2026-11-14T12:00:00.000Z' } }), { ...view(), extra: 1 }])
    assert.throws(() => contracts.validateCreativeLimitsHqView(bad), JSON.stringify(bad));
  const receipt = { jobId: U(), generationId: U(), status: 'SUBMITTED', submitted: true, deadlineAt: '2026-11-14T01:00:00.000Z', replayed: false };
  assert.doesNotThrow(() => contracts.validateCreativeProviderJobReceipt(receipt));
  assert.throws(() => contracts.validateCreativeProviderJobReceipt({ ...receipt, submitted: false }));
  assert.throws(() => contracts.validateCreativeProviderJobReceipt({ ...receipt, status: 'RECORDED' }));
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
const human = command => ({ 'content-type': 'application/json', origin: 'https://hon.example', 'x-hon-human-command': command, 'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty', 'idempotency-key': randomUUID() });

test('C1 HQ HTTP: read limits, set a provider limit and school caps with the exact command header; validation before the database', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = [];
  const db = { callSaasBilling: async (operation, params) => {
    calls.push([operation, params]);
    if (operation === 'readCreativeLimitsFromHq') return view();
    const body = JSON.parse(params[1]);
    if (operation === 'commandCreativeProviderDailyLimit') return { providerId: body.providerId, dailyLimitMicros: body.dailyLimitMicros, version: 1, replayed: false };
    if (operation === 'commandCreativeSchoolDailyCaps') return { schoolId: body.schoolId, images: body.images, videos: body.videos, avatarVideos: body.avatarVideos, version: 1, replayed: false };
    throw new Error(operation);
  } };
  const module = await Test.createTestingModule({ controllers: [CreativeLimitsHqController],
    providers: [CreativeLimitsService, SaasBillingService, SaasCommandGuard, SaasReadGuard, { provide: RuntimeDatabaseService, useValue: db }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'hq-owner' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/hq/creative/limits`;
  try {
    const read = await send(base); assert.equal(read.status, 200, read.body); assert.deepEqual(JSON.parse(read.body).data, view());
    assert.deepEqual(calls.at(-1), ['readCreativeLimitsFromHq', ['hq-owner']]);
    const limit = { providerId: 'HIGGSFIELD', dailyLimitMicros: 25_000_000, reason: 'Owner default guard for launch', expectedVersion: 0 };
    assert.equal((await send(`${base}/providers`, { method: 'POST', headers: human('saas-creative-school-daily-caps'), body: JSON.stringify(limit) })).status, 403, 'wrong command');
    const n = calls.length;
    assert.equal((await send(`${base}/providers`, { method: 'POST', headers: human('saas-creative-provider-daily-limit'), body: JSON.stringify({ ...limit, providerId: 'X' }) })).status, 400);
    assert.equal(calls.length, n, 'invalid input never reaches the database');
    const set = await send(`${base}/providers`, { method: 'POST', headers: human('saas-creative-provider-daily-limit'), body: JSON.stringify(limit) });
    assert.equal(set.status, 200, set.body); assert.equal(JSON.parse(set.body).data.version, 1);
    assert.deepEqual([calls.at(-1)[0], calls.at(-1)[1][0], JSON.parse(calls.at(-1)[1][1])], ['commandCreativeProviderDailyLimit', 'hq-owner', limit]);
    const caps = { schoolId: U(), images: 20, videos: 5, avatarVideos: 0, reason: 'Pilot school, keep it small', expectedVersion: 0 };
    const capped = await send(`${base}/schools`, { method: 'POST', headers: human('saas-creative-school-daily-caps'), body: JSON.stringify(caps) });
    assert.equal(capped.status, 200, capped.body); assert.equal(calls.at(-1)[0], 'commandCreativeSchoolDailyCaps');
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});
