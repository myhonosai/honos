const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { CreativeStudioAvatarVideosController } = require('../dist/creative-studio/creative-studio-avatars.controller.js');
const { CreativeStudioService } = require('../dist/creative-studio/creative-studio.service.js');
const { CREATIVE_PROVIDER_RUNTIME, SyntheticCreativeProviderRuntime, UnconfiguredCreativeProviderRuntime } = require('../dist/creative-studio/creative-provider-runtime.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

// Creative Studio avatar videos (A2, migration 0277): a READY avatar speaks a script as one CS1 generation of avatar.video.
const T = '2026-11-12T12:00:00.000Z', T2 = '2026-11-12T12:00:05.000Z', U = () => randomUUID();
const kinds = ['INCLUDED_MONTHLY', 'ADJUSTMENT', 'PROMOTIONAL', 'PURCHASED_TOPUP'];
const balance = () => ({ availableCredits: 11250, heldCredits: 0, byKind: kinds.map((kind, i) => ({ kind, grantedCredits: i ? 0 : 12000,
  availableCredits: i ? 0 : 11250, heldCredits: 0, consumedCredits: i ? 0 : 750, expiredCredits: 0, debitedCredits: 0 })) });
const SCRIPT = 'Hi, I am Master Kim. Join our free trial class this Saturday!', DESCRIPTION = 'Friendly taekwondo master in a black dobok';
const STATUS = { GENERATING: 'CREATING', SUCCEEDED: 'READY', UNDER_REVIEW: 'UNDER_REVIEW', FAILED: 'NOT_CREATED', RESOLVED_CHARGED: 'NOT_CREATED', RESOLVED_NOT_CHARGED: 'NOT_CREATED' };
const videoInput = (patch = {}) => ({ avatarId: '7f9d1c1e-3b7a-4c1b-9d55-0c6a1f2e8a10', script: SCRIPT, seconds: 15, format: 'PORTRAIT', ...patch });
const generation = (school, patch = {}) => ({ generationId: U(), schoolId: school, operationCode: 'avatar.video', mediaKind: 'VIDEO', units: 15, format: 'PORTRAIT',
  prompt: SCRIPT, status: 'GENERATING', failureReason: null, reservedCredits: 750, chargedCredits: null, createdAt: T, completedAt: null, assets: [], ...patch });
const video = (school, g = generation(school), patch = {}) => ({ videoId: U(), schoolId: school, avatarId: videoInput().avatarId, script: g.prompt, seconds: g.units,
  format: g.format, status: STATUS[g.status], createdAt: g.createdAt, generation: g, ...patch });
const avatarOf = (school, avatarId) => ({ avatarId, schoolId: school, name: 'Master Kim', style: 'REALISTIC', description: DESCRIPTION, status: 'READY', createdAt: T,
  generation: { generationId: U(), schoolId: school, operationCode: 'avatar.create', mediaKind: 'IMAGE', units: 1, format: 'PORTRAIT', prompt: DESCRIPTION,
    status: 'SUCCEEDED', failureReason: null, reservedCredits: 100, chargedCredits: 100, createdAt: T, completedAt: T2,
    assets: [{ assetId: U(), ordinal: 1, mediaType: 'image/png', width: 1080, height: 1920, durationSeconds: null, origin: 'SYNTHETIC' }] } });

test('A2 avatar video input is closed: avatar, script, 5..60 seconds and a format; no operation, units, provider or price from the client', () => {
  assert.deepEqual(contracts.validateCreativeAvatarVideoInput(videoInput()), videoInput());
  assert.equal(contracts.SAAS_COMMANDS.createCreativeAvatarVideo, 'saas-creative-avatar-video-create');
  assert.equal(contracts.CREATIVE_AVATAR_VIDEO_OPERATION, 'avatar.video');
  for (const seconds of [5, 60]) assert.doesNotThrow(() => contracts.validateCreativeAvatarVideoInput(videoInput({ seconds })));
  for (const bad of [videoInput({ operationCode: 'avatar.video' }), videoInput({ units: 15 }), videoInput({ providerId: 'HEYGEN' }), videoInput({ schoolId: U() }),
    videoInput({ seconds: 4 }), videoInput({ seconds: 61 }), videoInput({ seconds: 10.5 }), videoInput({ seconds: '15' }), videoInput({ avatarId: 'nope' }),
    videoInput({ format: 'WIDE' }), videoInput({ script: '' }), videoInput({ script: 'x'.repeat(1001) }), videoInput({ script: ' padded' }),
    (({ format, ...rest }) => rest)(videoInput()), null, []])
    assert.throws(() => contracts.validateCreativeAvatarVideoInput(bad), JSON.stringify(bad));
});

test('A2 avatar video view fails closed on drift: per-second VIDEO of avatar.video, status follows the generation, exact school', () => {
  const school = U();
  const done = generation(school, { status: 'SUCCEEDED', chargedCredits: 750, completedAt: T2,
    assets: [{ assetId: U(), ordinal: 1, mediaType: 'video/mp4', width: 1080, height: 1920, durationSeconds: 15, origin: 'SYNTHETIC' }] });
  for (const g of [generation(school), done, generation(school, { status: 'UNDER_REVIEW', failureReason: 'PROVIDER_UNKNOWN', completedAt: T2 })])
    assert.doesNotThrow(() => contracts.validateCreativeAvatarVideo(video(school, g)), g.status);
  for (const bad of [video(school, done, { status: 'CREATING' }), video(school, done, { schoolId: U() }), video(school, { ...done, operationCode: 'avatar.create' }),
    video(school, { ...done, mediaKind: 'IMAGE' }), video(school, done, { seconds: 16 }), video(school, done, { format: 'SQUARE' }), video(school, done, { script: 'Other' }),
    video(school, done, { createdAt: T2 }), { ...video(school, done), providerId: 'HEYGEN' }, video(school, done, { avatarId: 'nope' })])
    assert.throws(() => contracts.validateCreativeAvatarVideo(bad), JSON.stringify(bad).slice(0, 120));
  const a = video(school, generation(school, { createdAt: T2 }), { createdAt: T2 }), b = video(school);
  assert.doesNotThrow(() => contracts.validateCreativeAvatarVideoRecords({ videos: [a, b], limit: 50 }));
  for (const bad of [{ videos: [b, a], limit: 50 }, { videos: [a, video(U())], limit: 50 }, { videos: [a, a], limit: 50 }, { videos: [], limit: 12 }])
    assert.throws(() => contracts.validateCreativeAvatarVideoRecords(bad));
  assert.doesNotThrow(() => contracts.validateCreativeAvatarVideoReceipt({ video: b, balance: balance(), replayed: false }));
});

/** A fake database that answers like 0277 (+ 0276 avatar read and the unchanged 0216 record) and records every call. */
function fakeDatabase({ replayed = false, status = 'GENERATING', createdAt = T } = {}) {
  const calls = [];
  const db = { calls, callSaasBilling: async (operation, params) => {
    calls.push([operation, params]);
    if (operation === 'readCreativeAvatar') return avatarOf(params[1], params[2]);
    if (operation === 'createCreativeAvatarVideo') {
      const body = JSON.parse(params[2]), school = params[1];
      const g = generation(school, { prompt: body.script, units: body.seconds, format: body.format, createdAt, reservedCredits: body.seconds * 50,
        ...(status === 'SUCCEEDED' ? { status: 'SUCCEEDED', chargedCredits: body.seconds * 50, completedAt: new Date(Date.parse(createdAt) + 5000).toISOString(),
          assets: [{ assetId: U(), ordinal: 1, mediaType: 'video/mp4', width: 1080, height: 1920, durationSeconds: body.seconds, origin: 'SYNTHETIC' }] } : {}) });
      db.video = video(school, g, { avatarId: body.avatarId });
      return { video: db.video, balance: balance(), replayed };
    }
    if (operation === 'recordCreativeGenerationResult') {
      const outcome = JSON.parse(params[2]), g = db.video.generation;
      const next = { SUCCEEDED: 'SUCCEEDED', FAILED: 'FAILED', NOT_SENT: 'FAILED', UNKNOWN: 'UNDER_REVIEW' }[outcome.outcome];
      db.video = { ...db.video, status: STATUS[next], generation: { ...g, status: next, failureReason: outcome.failureReason,
        completedAt: new Date(Date.parse(g.createdAt) + 5000).toISOString(), chargedCredits: next === 'SUCCEEDED' ? g.units * 50 : null,
        assets: next === 'SUCCEEDED' ? outcome.assets.map((a, i) => ({ assetId: U(), ordinal: i + 1, mediaType: a.mediaType, width: a.width, height: a.height,
          durationSeconds: a.durationSeconds, origin: 'SYNTHETIC' })) : [] } };
      return { generation: db.video.generation, balance: balance(), replayed: false };
    }
    if (operation === 'readCreativeAvatarVideo') return db.video ?? video(params[1]);
    if (operation === 'readCreativeAvatarVideos') return { videos: [], limit: 50 };
    throw new Error(`unexpected ${operation}`);
  } };
  return db;
}
const service = (db, runtime) => new CreativeStudioService(new SaasBillingService(db), runtime);
const outcomeOf = db => JSON.parse(db.calls.find(([op]) => op === 'recordCreativeGenerationResult')[1][2]);

test('A2 not connected: nothing is read or reserved', async () => {
  const db = fakeDatabase();
  await assert.rejects(service(db, new UnconfiguredCreativeProviderRuntime()).createAvatarVideo('verified-human', U(), videoInput(), U()),
    e => e.getStatus() === 503 && e.getResponse().code === 'CREATIVE_PROVIDER_NOT_CONNECTED');
  assert.equal(db.calls.length, 0);
});

test('A2 create: the avatar look is read first, then one avatar.video create, one provider call with the look and the script, one record, then the video is read back', async () => {
  const db = fakeDatabase(), runtime = new SyntheticCreativeProviderRuntime('SUCCEED'), school = U(), key = U();
  const out = await service(db, runtime).createAvatarVideo('verified-human', school, videoInput(), key);
  assert.deepEqual([out.video.status, out.video.generation.status, out.video.generation.assets[0].durationSeconds, out.replayed], ['READY', 'SUCCEEDED', 15, false]);
  assert.deepEqual(db.calls.map(([op]) => op), ['readCreativeAvatar', 'createCreativeAvatarVideo', 'recordCreativeGenerationResult', 'readCreativeAvatarVideo']);
  assert.deepEqual(db.calls[0][1], ['verified-human', school, videoInput().avatarId]);
  const [subject, s, body, provider, k] = db.calls[1][1];
  assert.deepEqual([subject, s, JSON.parse(body), JSON.parse(provider), k], ['verified-human', school, videoInput(), { providerId: 'HIGGSFIELD', modelCode: 'synthetic-avatar-video-1' }, key]);
  assert.equal(runtime.calls.length, 1);
  const call = runtime.calls[0];
  assert.deepEqual([call.operationCode, call.mediaKind, call.units, call.format, call.prompt, call.providerRequestId],
    ['avatar.video', 'VIDEO', 15, 'PORTRAIT', SCRIPT, out.video.generation.generationId]);
  assert.deepEqual(call.avatar, { name: 'Master Kim', style: 'REALISTIC', description: DESCRIPTION });
  assert.equal(outcomeOf(db).outcome, 'SUCCEEDED');
});

test('A2 provider outcomes are recorded once; replays never call the provider again; a stale replay is held as interrupted', async () => {
  for (const [behaviour, expected] of [['REJECT', ['FAILED', 'NOT_CREATED']], ['UNKNOWN', ['UNKNOWN', 'UNDER_REVIEW']], ['PRE_SEND', ['NOT_SENT', 'NOT_CREATED']]]) {
    const db = fakeDatabase(), runtime = new SyntheticCreativeProviderRuntime(behaviour);
    const out = await service(db, runtime).createAvatarVideo('verified-human', U(), videoInput(), U());
    assert.deepEqual([outcomeOf(db).outcome, out.video.status], expected, behaviour);
  }
  const terminal = fakeDatabase({ replayed: true, status: 'SUCCEEDED' }), r1 = new SyntheticCreativeProviderRuntime();
  const again = await service(terminal, r1).createAvatarVideo('verified-human', U(), videoInput(), U());
  assert.deepEqual([again.replayed, again.video.status, r1.calls.length], [true, 'READY', 0]);
  const stale = fakeDatabase({ replayed: true, createdAt: new Date(Date.now() - 600_000).toISOString() }), r2 = new SyntheticCreativeProviderRuntime();
  const held = await service(stale, r2).createAvatarVideo('verified-human', U(), videoInput(), U());
  assert.deepEqual([held.replayed, held.video.status, r2.calls.length, outcomeOf(stale).failureReason], [true, 'UNDER_REVIEW', 0, 'INTERRUPTED']);
});

test('A2 refusals map to stable codes and bad input never reaches the database', async () => {
  for (const [code, sqlstate, status] of [['SAAS_OPERATION_NOT_PRICED', '23514', 422], ['CREATIVE_AVATAR_NOT_READY', '23514', 422], ['CREATIVE_AVATAR_RATE_INVALID', '23514', 422],
    ['SAAS_UNAVAILABLE', 'P0002', 404], ['IDEMPOTENCY_KEY_REUSED', '23505', 409], ['SAAS_FORBIDDEN', '42501', 403]]) {
    const s = service({ callSaasBilling: async op => { if (op === 'readCreativeAvatar') return avatarOf(U(), videoInput().avatarId); throw Object.assign(new Error(code), { code: sqlstate }); } },
      new SyntheticCreativeProviderRuntime());
    await assert.rejects(s.createAvatarVideo('verified-human', U(), videoInput(), U()), e => e.getStatus() === status && e.getResponse().code === code, code);
  }
  const db = fakeDatabase(), s = service(db, new SyntheticCreativeProviderRuntime());
  await assert.rejects(s.createAvatarVideo('verified-human', U(), videoInput({ seconds: 90 }), U()), e => e.getStatus() === 400);
  await assert.rejects(s.createAvatarVideo('verified-human', U(), videoInput(), 'nope'), e => e.getStatus() === 400);
  await assert.rejects(s.readAvatarVideo('verified-human', U(), 'nope'), e => e.getStatus() === 400);
  await assert.rejects(s.create('verified-human', U(), { operationCode: 'avatar.video', units: 15, format: 'PORTRAIT', prompt: SCRIPT }, U()), e => e.getStatus() === 400);
  assert.equal(db.calls.length, 0);
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
const human = command => ({ 'content-type': 'application/json', origin: 'https://hon.example', 'x-hon-human-command': command, 'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty', 'idempotency-key': randomUUID() });

test('A2 HTTP: list/read/create avatar videos with the exact command header; no settle or provider route', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const db = fakeDatabase(), runtime = new SyntheticCreativeProviderRuntime(), school = U();
  const module = await Test.createTestingModule({ controllers: [CreativeStudioAvatarVideosController],
    providers: [CreativeStudioService, SaasBillingService, SaasCommandGuard, SaasReadGuard, { provide: RuntimeDatabaseService, useValue: db },
      { provide: CREATIVE_PROVIDER_RUNTIME, useValue: runtime }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/schools/${school}/creative-studio/avatar-videos`;
  try {
    const list = await send(base); assert.equal(list.status, 200, list.body); assert.match(list.headers['cache-control'], /no-store/);
    assert.deepEqual(JSON.parse(list.body).data, { videos: [], limit: 50 });
    assert.deepEqual(db.calls.at(-1), ['readCreativeAvatarVideos', ['verified-human', school]]);
    const vid = U(), one = await send(`${base}/${vid}`); assert.equal(one.status, 200, one.body);
    assert.deepEqual(db.calls.at(-1), ['readCreativeAvatarVideo', ['verified-human', school, vid]]);
    const n = db.calls.length;
    assert.equal((await send(base, { method: 'POST', headers: human('saas-creative-avatar-create'), body: JSON.stringify(videoInput()) })).status, 403, 'wrong command header');
    assert.equal((await send(base, { method: 'POST', headers: { ...human('saas-creative-avatar-video-create'), origin: 'https://evil.example' }, body: JSON.stringify(videoInput()) })).status, 403);
    assert.equal((await send(`${base}/${vid}/settle`, { method: 'POST', headers: human('saas-creative-avatar-video-create'), body: '{}' })).status, 404);
    assert.equal(db.calls.length, n); assert.equal(runtime.calls.length, 0);
    const made = await send(base, { method: 'POST', headers: human('saas-creative-avatar-video-create'), body: JSON.stringify(videoInput()) });
    assert.equal(made.status, 200, made.body);
    const data = JSON.parse(made.body).data;
    assert.deepEqual([data.video.status, data.replayed], ['READY', false]);
    assert.ok(!/providerId|modelCode|providerCost|synthetic:/.test(made.body), 'no provider identity, cost or reference reaches the school');
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});
