const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { CreativeStudioController } = require('../dist/creative-studio/creative-studio.controller.js');
const { CreativeStudioService } = require('../dist/creative-studio/creative-studio.service.js');
const { CREATIVE_PROVIDER_RUNTIME, SyntheticCreativeProviderRuntime, UnconfiguredCreativeProviderRuntime } = require('../dist/creative-studio/creative-provider-runtime.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

const T = '2026-11-07T12:00:00.000Z', T2 = '2026-11-07T12:00:05.000Z', U = () => randomUUID();
const kinds = ['INCLUDED_MONTHLY', 'ADJUSTMENT', 'PROMOTIONAL', 'PURCHASED_TOPUP'];
const balance = (available = 11950, held = 0) => ({ availableCredits: available, heldCredits: held, byKind: kinds.map((kind, i) => ({ kind, grantedCredits: i ? 0 : 12000,
  availableCredits: i ? 0 : available, heldCredits: i ? 0 : held, consumedCredits: i ? 0 : 12000 - available - held, expiredCredits: 0, debitedCredits: 0 })) });
const asset = (ordinal = 1, patch = {}) => ({ assetId: U(), ordinal, mediaType: 'image/png', width: 1024, height: 1024, durationSeconds: null, origin: 'SYNTHETIC', ...patch });
const generation = (patch = {}) => ({ generationId: U(), schoolId: U(), operationCode: 'image.generate', mediaKind: 'IMAGE', units: 2, format: 'SQUARE',
  prompt: 'A bright poster for our spring kids karate camp', status: 'GENERATING', failureReason: null, reservedCredits: 100, chargedCredits: null,
  createdAt: T, completedAt: null, assets: [], ...patch });
const succeeded = (patch = {}) => generation({ status: 'SUCCEEDED', chargedCredits: 100, completedAt: T2, assets: [asset(1), asset(2)], ...patch });
const input = (patch = {}) => ({ operationCode: 'image.generate', units: 2, format: 'SQUARE', prompt: 'A bright poster for our spring kids karate camp', ...patch });

test('CS1 input is closed: no provider, model, price or school from the client; bounded printable prompt; closed format', () => {
  assert.deepEqual(contracts.validateCreativeGenerationInput(input()), input());
  assert.equal(contracts.SAAS_COMMANDS.createCreativeGeneration, 'saas-creative-generation-create');
  for (const bad of [input({ providerId: 'HIGGSFIELD' }), input({ modelCode: 'm' }), input({ creditsPerUnit: 1 }), input({ schoolId: U() }), input({ units: 0 }),
    input({ units: 1001 }), input({ units: 1.5 }), input({ format: 'BANNER' }), input({ prompt: '' }), input({ prompt: ' padded' }), input({ prompt: 'x'.repeat(1001) }),
    input({ prompt: 'bell\u0007' }), input({ prompt: 'rtl ‮ override' }), input({ operationCode: 'Image' }), (({ format, ...rest }) => rest)(input())])
    assert.throws(() => contracts.validateCreativeGenerationInput(bad), JSON.stringify(bad));
  assert.doesNotThrow(() => contracts.validateCreativeGenerationInput(input({ prompt: 'Line one\nLine two\twith a tab', units: 1000 })));
});

test('CS1 school view fails closed on provider/cost leakage, inconsistent status, charges and assets', () => {
  for (const ok of [generation(), succeeded(), generation({ status: 'FAILED', failureReason: 'PROVIDER_REJECTED', completedAt: T2 }),
    generation({ status: 'UNDER_REVIEW', failureReason: 'PROVIDER_UNKNOWN', completedAt: T2 }), generation({ status: 'RESOLVED_CHARGED', chargedCredits: 50, completedAt: T2, failureReason: 'INTERRUPTED' }),
    generation({ status: 'RESOLVED_NOT_CHARGED', completedAt: T2 }),
    succeeded({ mediaKind: 'VIDEO', operationCode: 'video.generate', units: 10, chargedCredits: 100, assets: [asset(1, { mediaType: 'video/mp4', durationSeconds: 10 })] })])
    assert.doesNotThrow(() => contracts.validateCreativeGeneration(ok), JSON.stringify(ok));
  for (const bad of [{ ...succeeded(), providerId: 'HIGGSFIELD' }, { ...succeeded(), providerCostMicrounits: 1 }, { ...succeeded(), modelCode: 'm' },
    succeeded({ chargedCredits: 101 }), succeeded({ chargedCredits: null }), succeeded({ assets: [] }), succeeded({ failureReason: 'PROVIDER_UNKNOWN' }),
    succeeded({ completedAt: null }), generation({ completedAt: T2 }), generation({ chargedCredits: 0 }), generation({ assets: [asset()] }),
    generation({ status: 'FAILED', completedAt: T2 }), generation({ status: 'UNDER_REVIEW', completedAt: T2 }), generation({ status: 'FAILED', failureReason: 'PROVIDER_REJECTED', completedAt: T2, chargedCredits: 1 }),
    succeeded({ assets: [asset(2), asset(1)] }), succeeded({ assets: [asset(1, { origin: 'PROVIDER' })] }), succeeded({ assets: [asset(1, { mediaType: 'video/mp4', durationSeconds: 3 })] }),
    succeeded({ assets: [asset(1, { url: 'https://cdn.example/x.png' })] }), succeeded({ completedAt: '2026-11-07T11:00:00.000Z' }), generation({ status: 'QUEUED' })])
    assert.throws(() => contracts.validateCreativeGeneration(bad), JSON.stringify(bad));
  const school = U(), a = generation({ schoolId: school, createdAt: T2 }), b = generation({ schoolId: school });
  assert.doesNotThrow(() => contracts.validateCreativeStudioGenerationList({ provider: 'NOT_CONNECTED', generations: [a, b], limit: 50 }));
  for (const bad of [{ provider: 'NOT_CONNECTED', generations: [b, a], limit: 50 }, { provider: 'NOT_CONNECTED', generations: [a, generation()], limit: 50 },
    { provider: 'NOT_CONNECTED', generations: [a, a], limit: 50 }, { provider: 'LIVE', generations: [], limit: 50 }, { provider: 'CONNECTED', generations: [], limit: 51 }])
    assert.throws(() => contracts.validateCreativeStudioGenerationList(bad));
  assert.throws(() => contracts.validateCreativeGenerationReceipt({ generation: succeeded(), balance: { ...balance(), availableCredits: 1 }, replayed: false }));
});

/** A fake database that answers like 0216 and records every call. */
function fakeDatabase({ createReplayed = false, createStatus = 'GENERATING', createdAt = T, recordError } = {}) {
  const calls = [];
  const db = { calls, callSaasBilling: async (operation, params) => {
    calls.push([operation, params]);
    if (operation === 'createCreativeGeneration') {
      const body = JSON.parse(params[2]);
      const g = createStatus === 'SUCCEEDED' ? succeeded({ schoolId: params[1], createdAt }) : generation({ schoolId: params[1], units: body.units, operationCode: body.operationCode,
        mediaKind: body.operationCode.startsWith('video') ? 'VIDEO' : 'IMAGE', reservedCredits: body.units * 50, createdAt });
      db.last = g;
      return { generation: g, balance: balance(), replayed: createReplayed };
    }
    if (operation === 'recordCreativeGenerationResult') {
      if (recordError) throw recordError;
      const outcome = JSON.parse(params[2]), g = db.last;
      const status = { SUCCEEDED: 'SUCCEEDED', FAILED: 'FAILED', NOT_SENT: 'FAILED', UNKNOWN: 'UNDER_REVIEW' }[outcome.outcome];
      return { generation: { ...g, status, failureReason: outcome.failureReason, completedAt: T2, chargedCredits: status === 'SUCCEEDED' ? outcome.finalUnits * 50 : null,
        assets: status === 'SUCCEEDED' ? outcome.assets.map((a, i) => ({ assetId: U(), ordinal: i + 1, mediaType: a.mediaType, width: a.width, height: a.height,
          durationSeconds: a.durationSeconds, origin: 'SYNTHETIC' })) : [] }, balance: balance(), replayed: false };
    }
    if (operation === 'readCreativeGenerations') return { generations: [], limit: 50 };
    if (operation === 'readCreativeGeneration') return succeeded({ schoolId: params[1], generationId: params[2] });
    throw new Error(`unexpected ${operation}`);
  } };
  return db;
}
const service = (db, runtime) => new CreativeStudioService(new SaasBillingService(db), runtime);
const outcomeOf = db => JSON.parse(db.calls.find(([op]) => op === 'recordCreativeGenerationResult')[1][2]);

test('CS1 production wiring is NOT_CONNECTED: nothing is reserved and the synthetic runtime is never wired', async () => {
  const db = fakeDatabase(), never = new UnconfiguredCreativeProviderRuntime();
  assert.equal(never.readiness(), 'CONFIGURATION_REQUIRED'); assert.equal(never.route('image.generate'), null);
  await assert.rejects(service(db, never).create('verified-human', U(), input(), U()), e => e.getStatus() === 503 && e.getResponse().code === 'CREATIVE_PROVIDER_NOT_CONNECTED');
  assert.equal(db.calls.length, 0, 'no reservation without a connected provider');
  assert.equal((await service(db, never).list('verified-human', U())).provider, 'NOT_CONNECTED');
  const wiring = readFileSync(join(__dirname, '../src/app.module.ts'), 'utf8');
  assert.match(wiring, /provide: CREATIVE_PROVIDER_RUNTIME, useFactory: \(\) => new UnconfiguredCreativeProviderRuntime\(\)/);
  assert.doesNotMatch(wiring, /SyntheticCreativeProviderRuntime/);
});

test('CS1 create: server route, one provider call, one record; the provider sees only the recorded request', async () => {
  const db = fakeDatabase(), runtime = new SyntheticCreativeProviderRuntime('SUCCEED'), school = U(), key = U();
  const out = await service(db, runtime).create('verified-human', school, input(), key);
  assert.equal(out.generation.status, 'SUCCEEDED'); assert.equal(out.generation.assets.length, 2);
  assert.deepEqual(db.calls.map(([op]) => op), ['createCreativeGeneration', 'recordCreativeGenerationResult']);
  const [subject, s, body, provider, k] = db.calls[0][1];
  assert.deepEqual([subject, s, JSON.parse(body), JSON.parse(provider), k], ['verified-human', school, input(), { providerId: 'HIGGSFIELD', modelCode: 'synthetic-image-1' }, key]);
  assert.equal(runtime.calls.length, 1);
  assert.deepEqual(Object.keys(runtime.calls[0]).sort(), ['format', 'mediaKind', 'modelCode', 'operationCode', 'prompt', 'providerId', 'providerRequestId', 'units']);
  assert.equal(runtime.calls[0].providerRequestId, db.last.generationId);
  const o = outcomeOf(db);
  assert.deepEqual([o.outcome, o.finalUnits, o.providerCostMicrounits, o.failureReason, o.assets.length], ['SUCCEEDED', 2, 2000, null, 2]);
  assert.equal(db.calls[1][1][1], db.last.generationId);
});

test('CS1 provider outcomes map to exactly one record: NOT_SENT, FAILED (cost never guessed), UNKNOWN, unverified result', async () => {
  const cases = [
    ['PRE_SEND', { outcome: 'NOT_SENT', failureReason: 'INVALID_REQUEST', providerCostMicrounits: null }],
    ['REJECT', { outcome: 'FAILED', failureReason: 'PROVIDER_REJECTED', providerCostMicrounits: null }],
    ['REJECT_WITH_COST', { outcome: 'FAILED', failureReason: 'PROVIDER_REJECTED', providerCostMicrounits: 250 }],
    ['UNKNOWN', { outcome: 'UNKNOWN', failureReason: 'PROVIDER_UNKNOWN', providerCostMicrounits: null }],
    ['UNVERIFIED', { outcome: 'UNKNOWN', failureReason: 'UNVERIFIED_RESULT', providerCostMicrounits: null }],
  ];
  for (const [behaviour, expected] of cases) {
    const db = fakeDatabase(), runtime = new SyntheticCreativeProviderRuntime(behaviour);
    await service(db, runtime).create('verified-human', U(), input(), U());
    assert.equal(runtime.calls.length, 1, behaviour);
    assert.equal(db.calls.filter(([op]) => op === 'recordCreativeGenerationResult').length, 1, behaviour);
    const o = outcomeOf(db);
    assert.deepEqual({ outcome: o.outcome, failureReason: o.failureReason, providerCostMicrounits: o.providerCostMicrounits }, expected, behaviour);
    assert.equal(o.finalUnits, null); assert.equal(o.assets, null);
  }
  // Tampered results: wrong media type, too many assets, a URL field, unsafe cost -> never trusted.
  for (const tamper of [r => { r.assets[0].mediaType = 'video/mp4'; }, r => { r.assets.push(...Array(8).fill(r.assets[0])); }, r => { r.assets[0].url = 'https://x'; },
    r => { r.providerCostMicrounits = -1; }, r => { r.finalUnits = 0; }, r => { r.assets = []; }, r => { r.assets[0].providerAssetReference = '../etc'; }]) {
    const db = fakeDatabase(), runtime = new SyntheticCreativeProviderRuntime('SUCCEED'), original = runtime.generate.bind(runtime);
    runtime.generate = async i => { const r = await original(i); tamper(r); return r; };
    await service(db, runtime).create('verified-human', U(), input(), U());
    assert.deepEqual([outcomeOf(db).outcome, outcomeOf(db).failureReason], ['UNKNOWN', 'UNVERIFIED_RESULT'], tamper.toString());
  }
});

test('CS1 replay never calls the provider again; a stale in-flight replay is held for HQ as INTERRUPTED', async () => {
  const terminal = fakeDatabase({ createReplayed: true, createStatus: 'SUCCEEDED' }), r1 = new SyntheticCreativeProviderRuntime();
  assert.equal((await service(terminal, r1).create('verified-human', U(), input(), U())).replayed, true);
  assert.deepEqual([r1.calls.length, terminal.calls.length], [0, 1]);
  const fresh = fakeDatabase({ createReplayed: true, createdAt: new Date(Date.now() - 30_000).toISOString() }), r2 = new SyntheticCreativeProviderRuntime();
  const pending = await service(fresh, r2).create('verified-human', U(), input(), U());
  assert.deepEqual([pending.generation.status, r2.calls.length, fresh.calls.length], ['GENERATING', 0, 1], 'still in flight: returned unchanged');
  const stale = fakeDatabase({ createReplayed: true, createdAt: new Date(Date.now() - 600_000).toISOString() }), r3 = new SyntheticCreativeProviderRuntime();
  const held = await service(stale, r3).create('verified-human', U(), input(), U());
  assert.deepEqual([held.generation.status, held.replayed, r3.calls.length], ['UNDER_REVIEW', true, 0]);
  assert.deepEqual([outcomeOf(stale).outcome, outcomeOf(stale).failureReason], ['UNKNOWN', 'INTERRUPTED']);
  const raced = fakeDatabase({ createReplayed: true, createdAt: new Date(Date.now() - 600_000).toISOString(),
    recordError: Object.assign(new Error('SAAS_TRANSITION_NOT_ALLOWED'), { code: '40001' }) });
  assert.equal((await service(raced, new SyntheticCreativeProviderRuntime()).create('verified-human', U(), input(), U())).generation.status, 'GENERATING',
    'a concurrent record wins: the replay is answered, not an error');
});

test('CS1 refusals: stable codes, validation before the database', async () => {
  for (const [code, sqlstate, status] of [['SAAS_CREATIVE_AI_PAUSED_BY_HQ', '23514', 422], ['SAAS_CREDITS_EXHAUSTED', '23514', 422], ['CREATIVE_TOO_MANY_IN_PROGRESS', '23514', 422],
    ['SAAS_CREATIVE_PROGRAM_INACTIVE', '23514', 422], ['SAAS_OPERATION_NOT_PRICED', '23514', 422], ['IDEMPOTENCY_KEY_REUSED', '23505', 409], ['SAAS_FORBIDDEN', '42501', 403]]) {
    const s = service({ callSaasBilling: async () => { throw Object.assign(new Error(code), { code: sqlstate }); } }, new SyntheticCreativeProviderRuntime());
    await assert.rejects(s.create('verified-human', U(), input(), U()), e => e.getStatus() === status && e.getResponse().code === code, code);
  }
  const stillRunning = service({ callSaasBilling: async () => { throw Object.assign(new Error('CREATIVE_GENERATION_IN_PROGRESS'), { code: '40001' }); } }, new SyntheticCreativeProviderRuntime());
  await assert.rejects(stillRunning.create('verified-human', U(), input(), U()), e => e.getStatus() === 409 && e.getResponse().code === 'CREATIVE_GENERATION_IN_PROGRESS');
  const db = fakeDatabase(), s = service(db, new SyntheticCreativeProviderRuntime());
  await assert.rejects(s.create('verified-human', 'not-a-uuid', input(), U()), e => e.getStatus() === 400);
  await assert.rejects(s.create('verified-human', U(), input(), 'not-a-key'), e => e.getStatus() === 400);
  await assert.rejects(s.create('verified-human', U(), input({ providerId: 'X' }), U()), e => e.getStatus() === 400);
  await assert.rejects(s.read('verified-human', U(), 'nope'), e => e.getStatus() === 400);
  assert.equal(db.calls.length, 0);
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
const human = command => ({ 'content-type': 'application/json', origin: 'https://hon.example', 'x-hon-human-command': command, 'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty', 'idempotency-key': randomUUID() });

test('CS1 HTTP: school list/read/create with exact command header; no settle, resend, provider or price route', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const db = fakeDatabase(), runtime = new SyntheticCreativeProviderRuntime(), school = U();
  const module = await Test.createTestingModule({ controllers: [CreativeStudioController],
    providers: [CreativeStudioService, SaasBillingService, SaasCommandGuard, SaasReadGuard, { provide: RuntimeDatabaseService, useValue: db },
      { provide: CREATIVE_PROVIDER_RUNTIME, useValue: runtime }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/schools/${school}/creative-studio/generations`;
  try {
    const list = await send(base); assert.equal(list.status, 200, list.body); assert.match(list.headers['cache-control'], /no-store/);
    assert.deepEqual(JSON.parse(list.body).data, { provider: 'CONNECTED', generations: [], limit: 50 });
    assert.deepEqual(db.calls.at(-1), ['readCreativeGenerations', ['verified-human', school]]);
    assert.equal((await send(`${base}?schoolId=${U()}`)).status, 400);
    const gid = U(), one = await send(`${base}/${gid}`); assert.equal(one.status, 200, one.body);
    assert.deepEqual(db.calls.at(-1), ['readCreativeGeneration', ['verified-human', school, gid]]);
    const n = db.calls.length;
    assert.equal((await send(base, { method: 'POST', headers: human('saas-creative-grant'), body: JSON.stringify(input()) })).status, 403, 'wrong command header');
    assert.equal((await send(base, { method: 'POST', headers: { ...human('saas-creative-generation-create'), origin: 'https://evil.example' }, body: JSON.stringify(input()) })).status, 403);
    for (const path of [`${base}/${gid}/settle`, `${base}/${gid}/retry`, `${base}/${gid}/result`])
      assert.equal((await send(path, { method: 'POST', headers: human('saas-creative-generation-create'), body: '{}' })).status, 404, path);
    assert.equal(db.calls.length, n); assert.equal(runtime.calls.length, 0);
    const made = await send(base, { method: 'POST', headers: human('saas-creative-generation-create'), body: JSON.stringify(input()) });
    assert.equal(made.status, 200, made.body);
    const data = JSON.parse(made.body).data;
    assert.equal(data.generation.status, 'SUCCEEDED'); assert.equal(data.replayed, false);
    assert.ok(!/providerId|modelCode|providerCost|synthetic:/.test(made.body), 'no provider identity, cost or reference reaches the school');
    assert.equal(runtime.calls.length, 1);
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});
