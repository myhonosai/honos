const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { CreativeStudioAvatarsController } = require('../dist/creative-studio/creative-studio-avatars.controller.js');
const { CreativeStudioService } = require('../dist/creative-studio/creative-studio.service.js');
const { CREATIVE_PROVIDER_RUNTIME, SyntheticCreativeProviderRuntime, UnconfiguredCreativeProviderRuntime } = require('../dist/creative-studio/creative-provider-runtime.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

// Creative Studio avatars (A1, migration 0276): an avatar is one CS1 generation priced by the HQ rate avatar.create.
const T = '2026-11-12T12:00:00.000Z', T2 = '2026-11-12T12:00:05.000Z', U = () => randomUUID();
const kinds = ['INCLUDED_MONTHLY', 'ADJUSTMENT', 'PROMOTIONAL', 'PURCHASED_TOPUP'];
const balance = () => ({ availableCredits: 11900, heldCredits: 0, byKind: kinds.map((kind, i) => ({ kind, grantedCredits: i ? 0 : 12000,
  availableCredits: i ? 0 : 11900, heldCredits: 0, consumedCredits: i ? 0 : 100, expiredCredits: 0, debitedCredits: 0 })) });
const DESCRIPTION = 'Friendly taekwondo master in a black dobok, warm smile, studio lighting';
const avatarInput = (patch = {}) => ({ name: 'Master Kim', style: 'REALISTIC', description: DESCRIPTION, ...patch });
const generation = (school, patch = {}) => ({ generationId: U(), schoolId: school, operationCode: 'avatar.create', mediaKind: 'IMAGE', units: 1, format: 'PORTRAIT',
  prompt: DESCRIPTION, status: 'GENERATING', failureReason: null, reservedCredits: 100, chargedCredits: null, createdAt: T, completedAt: null, assets: [], ...patch });
const ready = school => generation(school, { status: 'SUCCEEDED', chargedCredits: 100, completedAt: T2,
  assets: [{ assetId: U(), ordinal: 1, mediaType: 'image/png', width: 1080, height: 1920, durationSeconds: null, origin: 'SYNTHETIC' }] });
const STATUS = { GENERATING: 'CREATING', SUCCEEDED: 'READY', UNDER_REVIEW: 'UNDER_REVIEW', FAILED: 'NOT_CREATED', RESOLVED_CHARGED: 'NOT_CREATED', RESOLVED_NOT_CHARGED: 'NOT_CREATED' };
const avatar = (school, g = generation(school), patch = {}) => ({ avatarId: U(), schoolId: school, name: 'Master Kim', style: 'REALISTIC', description: DESCRIPTION,
  status: STATUS[g.status], createdAt: g.createdAt, generation: g, ...patch });

test('A1 avatar input is closed: name, style and description only; no operation, units, provider or price from the client', () => {
  assert.deepEqual(contracts.validateCreativeAvatarInput(avatarInput()), avatarInput());
  assert.equal(contracts.SAAS_COMMANDS.createCreativeAvatar, 'saas-creative-avatar-create');
  assert.equal(contracts.CREATIVE_AVATAR_OPERATION, 'avatar.create');
  assert.deepEqual([...contracts.CREATIVE_AVATAR_STYLES], ['REALISTIC', 'ILLUSTRATED', 'CHIBI']);
  for (const style of contracts.CREATIVE_AVATAR_STYLES) assert.doesNotThrow(() => contracts.validateCreativeAvatarInput(avatarInput({ style })));
  for (const bad of [avatarInput({ operationCode: 'avatar.create' }), avatarInput({ units: 1 }), avatarInput({ providerId: 'HEYGEN' }), avatarInput({ schoolId: U() }),
    avatarInput({ name: '' }), avatarInput({ name: ' Kim' }), avatarInput({ name: 'x'.repeat(41) }), avatarInput({ name: 'Two\nlines' }), avatarInput({ name: 'rtl ‮' }),
    avatarInput({ style: 'ANIME' }), avatarInput({ description: '' }), avatarInput({ description: 'x'.repeat(1001) }), avatarInput({ description: 'bell\u0007' }),
    (({ style, ...rest }) => rest)(avatarInput()), null, []])
    assert.throws(() => contracts.validateCreativeAvatarInput(bad), JSON.stringify(bad));
  assert.doesNotThrow(() => contracts.validateCreativeAvatarInput(avatarInput({ name: '김 사범님', description: 'Line one\nLine two' })));
});

test('A1 the generic generation route refuses avatar operations (an avatar is only made through the avatar route)', () => {
  const generic = { operationCode: 'image.generate', units: 1, format: 'SQUARE', prompt: 'Poster' };
  assert.doesNotThrow(() => contracts.validateCreativeGenerationInput(generic));
  for (const operationCode of ['avatar.create', 'avatar.video', 'avatar.anything'])
    assert.throws(() => contracts.validateCreativeGenerationInput({ ...generic, operationCode }), operationCode);
  assert.equal(contracts.isCreativeAvatarOperation('avatar.video'), true);
  assert.equal(contracts.isCreativeAvatarOperation('image.generate'), false);
});

test('A1 avatar view fails closed on drift: status follows its creation generation; no provider data; exact school', () => {
  const school = U();
  for (const g of [generation(school), ready(school), generation(school, { status: 'FAILED', failureReason: 'PROVIDER_REJECTED', completedAt: T2 }),
    generation(school, { status: 'UNDER_REVIEW', failureReason: 'PROVIDER_UNKNOWN', completedAt: T2 }),
    generation(school, { status: 'RESOLVED_CHARGED', failureReason: 'INTERRUPTED', chargedCredits: 100, completedAt: T2 }),
    generation(school, { status: 'RESOLVED_NOT_CHARGED', completedAt: T2 })])
    assert.doesNotThrow(() => contracts.validateCreativeAvatar(avatar(school, g)), g.status);
  const g = ready(school);
  for (const bad of [avatar(school, g, { status: 'CREATING' }), avatar(school, g, { schoolId: U() }), avatar(school, { ...g, operationCode: 'image.generate' }),
    avatar(school, { ...g, format: 'SQUARE' }), avatar(school, { ...g, prompt: 'Something else' }), avatar(school, g, { description: 'Something else' }),
    avatar(school, g, { createdAt: T2 }), { ...avatar(school, g), providerId: 'HEYGEN' }, avatar(school, g, { style: 'ANIME' }), avatar(school, g, { name: '' }),
    avatar(school, { ...g, units: 2, chargedCredits: 100 })])
    assert.throws(() => contracts.validateCreativeAvatar(bad), JSON.stringify(bad).slice(0, 120));
  const a = avatar(school, generation(school, { createdAt: T2 }), { createdAt: T2 }), b = avatar(school);
  assert.doesNotThrow(() => contracts.validateCreativeStudioAvatarList({ provider: 'NOT_CONNECTED', avatars: [a, b], limit: 50 }));
  for (const bad of [{ provider: 'NOT_CONNECTED', avatars: [b, a], limit: 50 }, { provider: 'NOT_CONNECTED', avatars: [a, avatar(U())], limit: 50 },
    { provider: 'NOT_CONNECTED', avatars: [a, a], limit: 50 }, { provider: 'CONNECTED', avatars: [], limit: 12 }])
    assert.throws(() => contracts.validateCreativeStudioAvatarList(bad));
  assert.doesNotThrow(() => contracts.validateCreativeAvatarReceipt({ avatar: b, balance: balance(), replayed: false }));
});

/** A fake database that answers like 0276 (+ the unchanged 0216 record) and records every call. */
function fakeDatabase({ replayed = false, status = 'GENERATING', createdAt = T } = {}) {
  const calls = [];
  const db = { calls, callSaasBilling: async (operation, params) => {
    calls.push([operation, params]);
    if (operation === 'createCreativeAvatar') {
      const body = JSON.parse(params[2]), school = params[1];
      const g = status === 'SUCCEEDED' ? { ...ready(school), createdAt, completedAt: new Date(Date.parse(createdAt) + 5000).toISOString(), prompt: body.description }
        : generation(school, { prompt: body.description, createdAt });
      db.avatar = avatar(school, g, { name: body.name, style: body.style, description: body.description });
      return { avatar: db.avatar, balance: balance(), replayed };
    }
    if (operation === 'recordCreativeGenerationResult') {
      const outcome = JSON.parse(params[2]), g = db.avatar.generation;
      const next = { SUCCEEDED: 'SUCCEEDED', FAILED: 'FAILED', NOT_SENT: 'FAILED', UNKNOWN: 'UNDER_REVIEW' }[outcome.outcome];
      db.avatar = { ...db.avatar, status: STATUS[next], generation: { ...g, status: next, failureReason: outcome.failureReason,
        completedAt: new Date(Date.parse(g.createdAt) + 5000).toISOString(), chargedCredits: next === 'SUCCEEDED' ? 100 : null,
        assets: next === 'SUCCEEDED' ? outcome.assets.map((a, i) => ({ assetId: U(), ordinal: i + 1, mediaType: a.mediaType, width: a.width, height: a.height,
          durationSeconds: a.durationSeconds, origin: 'SYNTHETIC' })) : [] } };
      return { generation: db.avatar.generation, balance: balance(), replayed: false };
    }
    if (operation === 'readCreativeAvatar') return db.avatar ?? avatar(params[1]);
    if (operation === 'readCreativeAvatars') return { avatars: [], limit: 50 };
    throw new Error(`unexpected ${operation}`);
  } };
  return db;
}
const service = (db, runtime) => new CreativeStudioService(new SaasBillingService(db), runtime);
const outcomeOf = db => JSON.parse(db.calls.find(([op]) => op === 'recordCreativeGenerationResult')[1][2]);

test('A1 not connected: nothing is reserved; the list still answers', async () => {
  const db = fakeDatabase(), never = new UnconfiguredCreativeProviderRuntime();
  await assert.rejects(service(db, never).createAvatar('verified-human', U(), avatarInput(), U()), e => e.getStatus() === 503 && e.getResponse().code === 'CREATIVE_PROVIDER_NOT_CONNECTED');
  assert.equal(db.calls.length, 0);
  assert.deepEqual(await service(db, never).listAvatars('verified-human', U()), { provider: 'NOT_CONNECTED', avatars: [], limit: 50 });
});

test('A1 create: server route for avatar.create, one provider call with the avatar look, one record, then the avatar is read back', async () => {
  const db = fakeDatabase(), runtime = new SyntheticCreativeProviderRuntime('SUCCEED'), school = U(), key = U();
  const out = await service(db, runtime).createAvatar('verified-human', school, avatarInput(), key);
  assert.deepEqual([out.avatar.status, out.avatar.generation.status, out.replayed], ['READY', 'SUCCEEDED', false]);
  assert.deepEqual(db.calls.map(([op]) => op), ['createCreativeAvatar', 'recordCreativeGenerationResult', 'readCreativeAvatar']);
  const [subject, s, body, provider, k] = db.calls[0][1];
  assert.deepEqual([subject, s, JSON.parse(body), JSON.parse(provider), k], ['verified-human', school, avatarInput(), { providerId: 'HIGGSFIELD', modelCode: 'synthetic-avatar-1' }, key]);
  assert.equal(runtime.calls.length, 1);
  const call = runtime.calls[0];
  assert.deepEqual([call.operationCode, call.mediaKind, call.units, call.format, call.prompt, call.providerRequestId],
    ['avatar.create', 'IMAGE', 1, 'PORTRAIT', DESCRIPTION, out.avatar.generation.generationId]);
  assert.deepEqual(call.avatar, { name: 'Master Kim', style: 'REALISTIC' });
  assert.deepEqual(db.calls[2][1], ['verified-human', school, out.avatar.avatarId]);
  assert.equal(outcomeOf(db).outcome, 'SUCCEEDED');
});

test('A1 provider outcomes are recorded once; unverified results are held; replays never call the provider again', async () => {
  for (const [behaviour, expected] of [['REJECT', ['FAILED', 'NOT_CREATED']], ['UNKNOWN', ['UNKNOWN', 'UNDER_REVIEW']], ['UNVERIFIED', ['UNKNOWN', 'UNDER_REVIEW']],
    ['PRE_SEND', ['NOT_SENT', 'NOT_CREATED']]]) {
    const db = fakeDatabase(), runtime = new SyntheticCreativeProviderRuntime(behaviour);
    const out = await service(db, runtime).createAvatar('verified-human', U(), avatarInput(), U());
    assert.deepEqual([outcomeOf(db).outcome, out.avatar.status], expected, behaviour);
    assert.equal(db.calls.filter(([op]) => op === 'recordCreativeGenerationResult').length, 1);
  }
  const terminal = fakeDatabase({ replayed: true, status: 'SUCCEEDED' }), r1 = new SyntheticCreativeProviderRuntime();
  const again = await service(terminal, r1).createAvatar('verified-human', U(), avatarInput(), U());
  assert.deepEqual([again.replayed, again.avatar.status, r1.calls.length, terminal.calls.length], [true, 'READY', 0, 1]);
  const stale = fakeDatabase({ replayed: true, createdAt: new Date(Date.now() - 600_000).toISOString() }), r2 = new SyntheticCreativeProviderRuntime();
  const held = await service(stale, r2).createAvatar('verified-human', U(), avatarInput(), U());
  assert.deepEqual([held.replayed, held.avatar.status, r2.calls.length, outcomeOf(stale).failureReason], [true, 'UNDER_REVIEW', 0, 'INTERRUPTED']);
  const fresh = fakeDatabase({ replayed: true, createdAt: new Date(Date.now() - 10_000).toISOString() }), r3 = new SyntheticCreativeProviderRuntime();
  assert.equal((await service(fresh, r3).createAvatar('verified-human', U(), avatarInput(), U())).avatar.status, 'CREATING');
  assert.equal(r3.calls.length, 0);
});

test('A1 refusals map to stable codes and bad input never reaches the database', async () => {
  for (const [code, sqlstate, status] of [['SAAS_OPERATION_NOT_PRICED', '23514', 422], ['CREATIVE_AVATAR_LIMIT_REACHED', '23514', 422], ['CREATIVE_AVATAR_RATE_INVALID', '23514', 422],
    ['IDEMPOTENCY_KEY_REUSED', '23505', 409], ['SAAS_FORBIDDEN', '42501', 403]]) {
    const s = service({ callSaasBilling: async () => { throw Object.assign(new Error(code), { code: sqlstate }); } }, new SyntheticCreativeProviderRuntime());
    await assert.rejects(s.createAvatar('verified-human', U(), avatarInput(), U()), e => e.getStatus() === status && e.getResponse().code === code, code);
  }
  const db = fakeDatabase(), s = service(db, new SyntheticCreativeProviderRuntime());
  await assert.rejects(s.createAvatar('verified-human', U(), avatarInput({ operationCode: 'avatar.create' }), U()), e => e.getStatus() === 400);
  await assert.rejects(s.createAvatar('verified-human', U(), avatarInput(), 'nope'), e => e.getStatus() === 400);
  await assert.rejects(s.readAvatar('verified-human', U(), 'nope'), e => e.getStatus() === 400);
  // The generic route refuses an avatar operation before anything is reserved.
  await assert.rejects(s.create('verified-human', U(), { operationCode: 'avatar.create', units: 1, format: 'PORTRAIT', prompt: DESCRIPTION }, U()), e => e.getStatus() === 400);
  assert.equal(db.calls.length, 0);
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
const human = command => ({ 'content-type': 'application/json', origin: 'https://hon.example', 'x-hon-human-command': command, 'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty', 'idempotency-key': randomUUID() });

test('A1 HTTP: list/read/create avatars with the exact command header; no settle, edit or provider route', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const db = fakeDatabase(), runtime = new SyntheticCreativeProviderRuntime(), school = U();
  const module = await Test.createTestingModule({ controllers: [CreativeStudioAvatarsController],
    providers: [CreativeStudioService, SaasBillingService, SaasCommandGuard, SaasReadGuard, { provide: RuntimeDatabaseService, useValue: db },
      { provide: CREATIVE_PROVIDER_RUNTIME, useValue: runtime }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/schools/${school}/creative-studio/avatars`;
  try {
    const list = await send(base); assert.equal(list.status, 200, list.body); assert.match(list.headers['cache-control'], /no-store/);
    assert.deepEqual(JSON.parse(list.body).data, { provider: 'CONNECTED', avatars: [], limit: 50 });
    assert.deepEqual(db.calls.at(-1), ['readCreativeAvatars', ['verified-human', school]]);
    const aid = U(), one = await send(`${base}/${aid}`); assert.equal(one.status, 200, one.body);
    assert.deepEqual(db.calls.at(-1), ['readCreativeAvatar', ['verified-human', school, aid]]);
    const n = db.calls.length;
    assert.equal((await send(base, { method: 'POST', headers: human('saas-creative-generation-create'), body: JSON.stringify(avatarInput()) })).status, 403, 'wrong command header');
    assert.equal((await send(base, { method: 'POST', headers: { ...human('saas-creative-avatar-create'), origin: 'https://evil.example' }, body: JSON.stringify(avatarInput()) })).status, 403);
    for (const path of [`${base}/${aid}/settle`, `${base}/${aid}/edit`, `${base}/${aid}/video`])
      assert.equal((await send(path, { method: 'POST', headers: human('saas-creative-avatar-create'), body: '{}' })).status, 404, path);
    assert.equal(db.calls.length, n); assert.equal(runtime.calls.length, 0);
    const made = await send(base, { method: 'POST', headers: human('saas-creative-avatar-create'), body: JSON.stringify(avatarInput()) });
    assert.equal(made.status, 200, made.body);
    const data = JSON.parse(made.body).data;
    assert.deepEqual([data.avatar.status, data.replayed], ['READY', false]);
    assert.ok(!/providerId|modelCode|providerCost|synthetic:/.test(made.body), 'no provider identity, cost or reference reaches the school');
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});

test('C1 async provider for avatar.create: permit, one submit with the look, the job id recorded; the avatar is returned as it is, still generating', async () => {
  const { SyntheticAsyncCreativeProviderRuntime } = require('../dist/creative-studio/creative-provider-runtime.js');
  const db = fakeDatabase(), base = db.callSaasBilling, runtime = new SyntheticAsyncCreativeProviderRuntime();
  db.callSaasBilling = async (operation, params) => {
    if (operation === 'beginCreativeProviderSubmission' || operation === 'recordCreativeProviderSubmission') {
      db.calls.push([operation, params]);
      return { jobId: U(), generationId: params[1], status: operation === 'beginCreativeProviderSubmission' ? 'PERMITTED' : 'SUBMITTED',
        submitted: operation !== 'beginCreativeProviderSubmission', deadlineAt: new Date(Date.now() + 1_800_000).toISOString(), replayed: false };
    }
    return base(operation, params);
  };
  const out = await service(db, runtime).createAvatar('verified-human', U(), avatarInput(), U());
  assert.equal(out.avatar.generation.status, 'GENERATING'); assert.equal(out.replayed, false);
  assert.deepEqual(db.calls.map(([op]) => op), ['createCreativeAvatar', 'beginCreativeProviderSubmission', 'recordCreativeProviderSubmission']);
  assert.equal(runtime.submits.length, 1); assert.deepEqual(runtime.submits[0].avatar, { name: avatarInput().name, style: avatarInput().style });
  assert.equal(JSON.parse(db.calls[0][1][3]).providerId, 'HEYGEN');
});
