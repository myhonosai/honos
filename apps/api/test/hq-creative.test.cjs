const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { HqCreativeController } = require('../dist/hq-creative/hq-creative.controller.js');
const { HqCreativeService } = require('../dist/hq-creative/hq-creative.service.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { CREATIVE_PROVIDER_RUNTIME, SyntheticCreativeProviderRuntime, UnconfiguredCreativeProviderRuntime } = require('../dist/creative-studio/creative-provider-runtime.js');
const contracts = require('@hon/contracts');

// M2 HQ Creative Studio (0253): closed inputs and responses; routes forward only the verified subject, the path id and the
// validated body; with no provider connected a request is refused (503) before the database is asked.
const U = () => randomUUID(), T = '2026-11-01T00:00:00.000Z', T2 = '2026-11-02T00:00:00.000Z';
const person = (n = 'HQ Marketer') => ({ principalId: U(), displayName: n });
const budget = (patch = {}) => ({ periodStart: '2026-11-01', creditCap: 100, usedCredits: 20, heldCredits: 10, availableCredits: 70, inProgress: 1,
  version: 1, setBy: person('HQ Owner'), setAt: T, ...patch });
const gen = (patch = {}) => ({ generationId: U(), periodStart: '2026-11-01', campaign: null, operationCode: 'image.generate', mediaKind: 'IMAGE', units: 2,
  format: 'SQUARE', prompt: 'Founder poster', status: 'GENERATING', failureReason: null, reservedCredits: 20, chargedCredits: null, requestedBy: person(),
  version: 1, createdAt: T, completedAt: null, assets: [], ...patch });
const asset = (o = 1) => ({ assetId: U(), ordinal: o, mediaType: 'image/png', width: 1024, height: 1024, durationSeconds: null, origin: 'SYNTHETIC' });
const rate = { operationCode: 'image.generate', mediaKind: 'IMAGE', displayName: 'Image', billingUnit: 'IMAGE', creditsPerUnit: 10, maxUnitsPerRequest: 4 };
const studio = (patch = {}) => ({ budget: budget(), budgetHistory: [], rates: [rate], generations: [gen()], limit: 50,
  viewer: { ...person(), canManage: true, isOwner: false }, asOf: T2, ...patch });
const ask = (patch = {}) => ({ operationCode: 'image.generate', units: 2, format: 'SQUARE', prompt: 'Founder poster', campaignId: null, ...patch });

test('contracts: HQ creative command values are in the SaaS command table', () => {
  assert.equal(contracts.SAAS_COMMANDS.createHqCreativeGeneration, 'hq-creative-generation-create');
  assert.equal(contracts.SAAS_COMMANDS.setHqCreativeBudget, 'hq-creative-budget-set');
  assert.equal(contracts.SAAS_COMMANDS.resolveHqCreativeGeneration, 'hq-creative-generation-resolve');
});

test('contracts: inputs are closed; clients never choose a provider, model or price', () => {
  assert.deepEqual(contracts.validateHqCreativeGenerationInput(ask()), ask());
  for (const bad of [ask({ units: 0 }), ask({ units: 1001 }), ask({ format: 'WIDE' }), ask({ prompt: ' padded' }), ask({ prompt: '' }), ask({ campaignId: 'x' }),
    { ...ask(), providerId: 'HIGGSFIELD' }, { ...ask(), creditsPerUnit: 1 }, (({ campaignId, ...r }) => r)(ask())])
    assert.throws(() => contracts.validateHqCreativeGenerationInput(bad), JSON.stringify(bad));
  const b = { periodStart: '2026-12-01', creditCap: 500, expectedVersion: null, reason: 'December plan' };
  assert.deepEqual(contracts.validateHqCreativeBudgetInput(b), b);
  for (const bad of [{ ...b, periodStart: '2026-12-02' }, { ...b, creditCap: -1 }, { ...b, creditCap: 10_000_001 }, { ...b, expectedVersion: 0 }, { ...b, reason: 'no' },
    { ...b, reason: 'line\nbreak' }, (({ reason, ...r }) => r)(b)])
    assert.throws(() => contracts.validateHqCreativeBudgetInput(bad), JSON.stringify(bad));
  const r = { expectedVersion: 2, resolution: 'SUCCEEDED', finalUnits: 1, providerCostMicrounits: null, evidenceReference: 'Invoice 42' };
  assert.deepEqual(contracts.validateHqCreativeResolveInput(r), r);
  for (const bad of [{ ...r, finalUnits: null }, { ...r, resolution: 'NOT_CHARGED' }, { ...r, evidenceReference: '' }, { ...r, providerCostMicrounits: -1 }, { ...r, resolution: 'MAYBE' }])
    assert.throws(() => contracts.validateHqCreativeResolveInput(bad), JSON.stringify(bad));
});

test('contracts: responses are closed and internally consistent', () => {
  assert.equal(contracts.validateHqCreativeStudioRecords(studio()).generations.length, 1);
  assert.equal(contracts.validateHqCreativeStudio({ provider: 'NOT_CONNECTED', ...studio() }).provider, 'NOT_CONNECTED');
  const unset = budget({ creditCap: null, usedCredits: 0, heldCredits: 0, availableCredits: 0, inProgress: 0, version: null, setBy: null, setAt: null });
  assert.equal(contracts.validateHqCreativeStudioRecords(studio({ budget: unset })).budget.creditCap, null);
  for (const bad of [studio({ budget: budget({ availableCredits: 71 }) }), studio({ budget: { ...unset, availableCredits: 5 } }), studio({ limit: 10 }),
    studio({ generations: [gen({ status: 'SUCCEEDED', chargedCredits: 20, completedAt: T2 })] }),
    studio({ generations: [gen({ status: 'SUCCEEDED', chargedCredits: 30, completedAt: T2, assets: [asset()] })] }),
    studio({ generations: [gen({ status: 'FAILED', completedAt: T2, failureReason: 'PROVIDER_UNKNOWN' })] }),
    studio({ generations: [gen({ status: 'UNDER_REVIEW', completedAt: T2, failureReason: 'PROVIDER_REJECTED' })] }),
    studio({ generations: [{ ...gen(), providerId: 'HIGGSFIELD' }] }), studio({ generations: [{ ...gen(), schoolId: U() }] }),
    studio({ viewer: { ...person(), canManage: false, isOwner: true } }), studio({ rates: [rate, rate] }),
    studio({ generations: [gen({ createdAt: T }), gen({ createdAt: T2 })] }),
    studio({ budgetHistory: [{ periodStart: '2026-11-01', version: 2, creditCap: 1, previousCap: null, reason: 'Trim', actor: person(), recordedAt: T }] })])
    assert.throws(() => contracts.validateHqCreativeStudioRecords(bad));
  const ok = gen({ status: 'SUCCEEDED', chargedCredits: 20, completedAt: T2, assets: [asset(), asset(2)] });
  assert.equal(contracts.validateHqCreativeGenerationReceipt({ generation: ok, budget: budget(), replayed: false }).generation.assets.length, 2);
  assert.throws(() => contracts.validateHqCreativeGenerationReceipt({ generation: ok, budget: budget({ periodStart: '2026-12-01' }), replayed: false }));
  assert.throws(() => contracts.validateHqCreativeBudgetReceipt({ budget: budget({ creditCap: null, version: null, setBy: null, setAt: null, availableCredits: 0 }), replayed: false }));
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
async function appWith(callSaasBilling, runtime) {
  const module = await Test.createTestingModule({ controllers: [HqCreativeController],
    providers: [HqCreativeService, SaasBillingService, SaasReadGuard, SaasCommandGuard, { provide: RuntimeDatabaseService, useValue: { callSaasBilling } },
      { provide: CREATIVE_PROVIDER_RUNTIME, useValue: runtime }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication({ bodyParser: false });
  app.use(json({ strict: true })); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${app.getHttpServer().address().port}/v1` };
}
const command = (marker, key = U()) => ({ origin: 'https://hon.example', 'x-hon-human-command': marker, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin',
  'sec-fetch-dest': 'empty', 'content-type': 'application/json', 'idempotency-key': key });
async function withOrigin(work) {
  const prior = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  try { await work(); } finally { if (prior === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = prior; }
}

test('HTTP: production wiring has no provider: the studio says NOT_CONNECTED and a request never reaches the database', () => withOrigin(async () => {
  const calls = [];
  const { app, base } = await appWith(async (operation, params) => { calls.push([operation, params]); return studio(); }, new UnconfiguredCreativeProviderRuntime());
  try {
    const view = await send(`${base}/hq/marketing/creative`);
    assert.equal(view.status, 200, view.body); assert.equal(view.headers['cache-control'], 'private, no-store');
    assert.equal(JSON.parse(view.body).data.provider, 'NOT_CONNECTED');
    assert.deepEqual(calls, [['readHqCreativeStudio', ['verified-human']]]);
    const r = await send(`${base}/hq/marketing/creative/generations`, { method: 'POST', headers: command('hq-creative-generation-create'), body: JSON.stringify(ask()) });
    assert.deepEqual([r.status, JSON.parse(r.body).code], [503, 'CREATIVE_PROVIDER_NOT_CONNECTED']);
    assert.equal(calls.length, 1, 'nothing reserved or written');
  } finally { await app.close(); }
}));

test('HTTP: reserve -> one provider call -> record; budget and resolution forward only validated input', () => withOrigin(async () => {
  const provider = new SyntheticCreativeProviderRuntime('SUCCEED');
  const calls = []; let reply;
  const { app, base } = await appWith(async (operation, params) => { calls.push([operation, params]); return reply(operation, params); }, provider);
  try {
    const g = gen();
    reply = (op, params) => op === 'createHqCreativeGeneration' ? { generation: g, budget: budget(), replayed: false }
      : { generation: { ...g, status: 'SUCCEEDED', chargedCredits: 20, completedAt: T2, version: 2, assets: [asset(), asset(2)] }, budget: budget(), replayed: false };
    const key = U();
    const r = await send(`${base}/hq/marketing/creative/generations`, { method: 'POST', headers: command('hq-creative-generation-create', key), body: JSON.stringify(ask()) });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(calls.map(c => c[0]), ['createHqCreativeGeneration', 'recordHqCreativeGenerationResult']);
    assert.deepEqual(calls[0][1], ['verified-human', JSON.stringify(ask()), JSON.stringify({ providerId: 'HIGGSFIELD', modelCode: 'synthetic-image-1' }), key]);
    assert.equal(JSON.parse(calls[1][1][2]).outcome, 'SUCCEEDED'); assert.equal(provider.calls.length, 1);
    // An unverified provider answer is recorded UNKNOWN (held for the HQ owner), never trusted.
    calls.length = 0; provider.behaviour = 'UNVERIFIED';
    reply = (op) => op === 'createHqCreativeGeneration' ? { generation: g, budget: budget(), replayed: false }
      : { generation: { ...g, status: 'UNDER_REVIEW', failureReason: 'UNVERIFIED_RESULT', completedAt: T2, version: 2 }, budget: budget(), replayed: false };
    await send(`${base}/hq/marketing/creative/generations`, { method: 'POST', headers: command('hq-creative-generation-create'), body: JSON.stringify(ask()) });
    assert.deepEqual(JSON.parse(calls[1][1][2]), { outcome: 'UNKNOWN', finalUnits: null, providerCostMicrounits: null, failureReason: 'UNVERIFIED_RESULT', assets: null });
    // A replay never calls the provider again.
    calls.length = 0; provider.calls.length = 0;
    reply = () => ({ generation: { ...g, status: 'SUCCEEDED', chargedCredits: 20, completedAt: T2, version: 2, assets: [asset()] }, budget: budget(), replayed: true });
    await send(`${base}/hq/marketing/creative/generations`, { method: 'POST', headers: command('hq-creative-generation-create'), body: JSON.stringify(ask()) });
    assert.deepEqual([calls.length, provider.calls.length], [1, 0]);
    // Refusals before the database.
    calls.length = 0;
    for (const [headers, body] of [[command('hq-creative-budget-set'), ask()], [command('hq-creative-generation-create'), { ...ask(), modelCode: 'x' }],
      [{ ...command('hq-creative-generation-create'), origin: 'https://evil.example' }, ask()], [{ ...command('hq-creative-generation-create'), 'idempotency-key': 'nope' }, ask()]])
      assert.ok([400, 403].includes((await send(`${base}/hq/marketing/creative/generations`, { method: 'POST', headers, body: JSON.stringify(body) })).status));
    assert.equal(calls.length, 0);
    // Budget.
    const b = { periodStart: '2026-11-01', creditCap: 100, expectedVersion: null, reason: 'November plan' }, bk = U();
    reply = () => ({ budget: budget(), replayed: false });
    assert.equal((await send(`${base}/hq/marketing/creative/budget`, { method: 'POST', headers: command('hq-creative-budget-set', bk), body: JSON.stringify(b) })).status, 200);
    assert.deepEqual(calls.at(-1), ['setHqCreativeBudget', ['verified-human', JSON.stringify(b), bk]]);
    reply = () => ({ budget: budget({ periodStart: '2026-12-01' }), replayed: false });
    assert.equal((await send(`${base}/hq/marketing/creative/budget`, { method: 'POST', headers: command('hq-creative-budget-set'), body: JSON.stringify(b) })).status, 503, 'an answer about another month is never shown');
    // Resolution.
    const res = { expectedVersion: 2, resolution: 'NOT_CHARGED', finalUnits: null, providerCostMicrounits: null, evidenceReference: 'Invoice 42' }, rk = U();
    reply = () => ({ generation: { ...g, status: 'RESOLVED_NOT_CHARGED', failureReason: 'PROVIDER_UNKNOWN', completedAt: T2, version: 3 }, budget: budget(), replayed: false });
    assert.equal((await send(`${base}/hq/marketing/creative/generations/${g.generationId}/resolution`, { method: 'POST', headers: command('hq-creative-generation-resolve', rk), body: JSON.stringify(res) })).status, 200);
    assert.deepEqual(calls.at(-1), ['resolveHqCreativeGeneration', ['verified-human', g.generationId, JSON.stringify(res), rk]]);
    reply = () => ({ generation: { ...g, status: 'RESOLVED_CHARGED', chargedCredits: 0, completedAt: T2, version: 3 }, budget: budget(), replayed: false });
    assert.equal((await send(`${base}/hq/marketing/creative/generations/${g.generationId}/resolution`, { method: 'POST', headers: command('hq-creative-generation-resolve'), body: JSON.stringify(res) })).status, 503);
    // Rule refusals.
    for (const [code, message, status, answer] of [['42501', 'SAAS_FORBIDDEN', 403, 'SAAS_FORBIDDEN'], ['23514', 'HQ_CREATIVE_BUDGET_NOT_SET', 422, 'HQ_CREATIVE_BUDGET_NOT_SET'],
      ['23514', 'HQ_CREATIVE_BUDGET_EXHAUSTED', 422, 'HQ_CREATIVE_BUDGET_EXHAUSTED'], ['23514', 'HQ_CREATIVE_TOO_MANY_IN_PROGRESS', 422, 'HQ_CREATIVE_TOO_MANY_IN_PROGRESS'],
      ['23514', 'HQ_CREATIVE_PAUSED_BY_HQ', 422, 'HQ_CREATIVE_PAUSED_BY_HQ'], ['23514', 'HQ_CREATIVE_CAP_BELOW_USE', 422, 'HQ_CREATIVE_CAP_BELOW_USE'],
      ['23514', 'HQ_CREATIVE_OPERATION_NOT_PRICED', 422, 'HQ_CREATIVE_OPERATION_NOT_PRICED'], ['23505', 'SAAS_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED']]) {
      reply = () => { const e = new Error(message); e.code = code; throw e; };
      const r2 = await send(`${base}/hq/marketing/creative/generations`, { method: 'POST', headers: command('hq-creative-generation-create'), body: JSON.stringify(ask()) });
      assert.deepEqual([r2.status, JSON.parse(r2.body).code], [status, answer], message);
    }
    assert.equal((await send(`${base}/hq/marketing/creative/generations/not-a-uuid`)).status, 400);
  } finally { await app.close(); }
}));
