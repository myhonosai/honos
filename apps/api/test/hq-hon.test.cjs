const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { HqHonController } = require('../dist/hq-hon/hq-hon.controller.js');
const { HqHonService } = require('../dist/hq-hon/hq-hon.service.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { HON_REPLY_PROVIDER_RUNTIME, HonReplyProviderRuntimeError, OpenRouterHonReplyRuntime, HQ_HON_SYSTEM_PROMPT, HQ_EXECUTIVE_PROMPTS, honReplySystemPrompt } = require('../dist/ai/hon-reply-provider-runtime.js');
const contracts = require('@hon/contracts');

// B1 HQ Ask HON (0263): closed inputs and responses; routes forward only the verified subject, the path id and the
// validated body; with no provider connected a question is refused (503) before the database is asked; one provider call.
const U = () => randomUUID(), T = '2026-11-01T00:00:00.000Z', T2 = '2026-11-02T00:00:00.000Z';
const person = (n = 'HQ Operator') => ({ principalId: U(), displayName: n });
const OWNER = { principalId: U(), displayName: 'HQ Owner' };
const budget = (patch = {}) => ({ periodStart: '2026-11-01', creditCap: 100, usedCredits: 20, heldCredits: 10, availableCredits: 70, inProgress: 1,
  version: 1, setBy: OWNER, setAt: T, ...patch });
const turn = (patch = {}) => ({ turnId: U(), agentKey: 'hon', replyMode: 'STANDARD', question: 'How many schools?', status: 'ANSWERING', failureReason: null,
  reply: null, truncated: null, concealed: false, reservedCredits: 10, chargedCredits: null, askedBy: person(), version: 1, createdAt: T, completedAt: null, ...patch });
const done = (t, patch = {}) => ({ ...t, status: 'ANSWERED', reply: 'Three schools.', truncated: false, chargedCredits: 3, version: 2, completedAt: T2, ...patch });
const invocation = (t, patch = {}) => ({ turnId: t.turnId, agentKey: 'hon', providerId: 'OPENROUTER', modelId: 'fixture/model', providerRequestId: t.turnId,
  replyMode: t.replyMode, question: t.question, facts: '{"hqOverview":{}}', inputBudget: 8000, outputBudget: 1500, maxCostMicrounits: 80000, ...patch });
const ask = (patch = {}) => ({ question: 'How many schools?', replyMode: 'STANDARD', agentKey: 'hon', ...patch });
const conv = (viewer = { ...person(), isOwner: false }, patch = {}) => ({ budget: budget(), turns: [turn({ askedBy: { principalId: viewer.principalId, displayName: viewer.displayName } })],
  budgetHistory: [], underReview: [], availableAgents: ['hon'], limit: 50, viewer, asOf: T2, ...patch });

class FakeRuntime {
  constructor(ready = 'READY') { this.ready = ready; this.calls = []; this.next = null; }
  readiness() { return this.ready; }
  async generate(i) { this.calls.push(i); const n = this.next; if (n instanceof Error) throw n;
    return n ?? { reply: 'Three schools.', inputTokens: 2000, outputTokens: 300, providerCostMicrounits: 900, truncated: false, suggestions: [], followUps: [], sources: [] }; }
}

test('contracts: HQ HON commands are in the SaaS command table; inputs are closed', () => {
  assert.deepEqual([contracts.SAAS_COMMANDS.askHqHon, contracts.SAAS_COMMANDS.setHqHonBudget, contracts.SAAS_COMMANDS.resolveHqHonTurn],
    ['hq-hon-ask', 'hq-hon-budget-set', 'hq-hon-turn-resolve']);
  assert.deepEqual(contracts.HQ_HON_AGENTS, ['hon', 'chase', 'mia', 'ethan', 'olivia', 'ryan', 'sophia']);
  assert.deepEqual(contracts.HQ_HON_MODE_CREDITS, { STANDARD: 10, DETAILED: 15 });
  assert.deepEqual(contracts.validateHqHonAskInput(ask()), ask());
  for (const bad of [ask({ question: '' }), ask({ question: ' x' }), ask({ question: 'x'.repeat(2001) }), ask({ question: 'a\u0007' }), ask({ agentKey: 'claire' }),
    ask({ agentKey: 'kai' }), ask({ agentKey: 'Chase' }), ask({ replyMode: 'LONG' }), { ...ask(), organizationId: U() }, { ...ask(), modelId: 'x' }, (({ agentKey, ...r }) => r)(ask())])
    assert.throws(() => contracts.validateHqHonAskInput(bad), JSON.stringify(bad));
  assert.equal(contracts.validateHqHonAskInput(ask({ question: 'Line one\nline two' })).question, 'Line one\nline two');
  const r = { expectedVersion: 2, resolution: 'CHARGED', chargedCredits: 4, providerCostMicrounits: null, evidenceReference: 'Invoice 42' };
  assert.deepEqual(contracts.validateHqHonResolveInput(r), r);
  for (const bad of [{ ...r, chargedCredits: null }, { ...r, resolution: 'NOT_CHARGED' }, { ...r, evidenceReference: '' }, { ...r, resolution: 'SUCCEEDED' }])
    assert.throws(() => contracts.validateHqHonResolveInput(bad), JSON.stringify(bad));
});

test('contracts: responses are closed and internally consistent; no provider, model or school ever appears', () => {
  const viewer = { ...person(), isOwner: false };
  assert.equal(contracts.validateHqHonConversationRecords(conv(viewer)).turns.length, 1);
  const t = turn();
  for (const bad of [conv(viewer, { turns: [turn()] }), conv(viewer, { underReview: [turn({ status: 'UNDER_REVIEW', failureReason: 'PROVIDER_UNKNOWN', completedAt: T2 })] }),
    conv(viewer, { limit: 10 }), conv(viewer, { turns: [{ ...done(t), askedBy: viewer, providerId: 'OPENROUTER' }] }),
    conv(viewer, { turns: [{ ...done(t), askedBy: viewer, schoolId: U() }] }), conv(viewer, { turns: [done(t, { askedBy: viewer, chargedCredits: 11 })] }),
    conv(viewer, { turns: [done(t, { askedBy: viewer, reply: null })] }), conv(viewer, { turns: [done(t, { askedBy: viewer, concealed: true })] }),
    conv(viewer, { turns: [turn({ askedBy: viewer, reservedCredits: 15 })] }), conv(viewer, { turns: [turn({ askedBy: viewer, status: 'FAILED', completedAt: T2, failureReason: 'PROVIDER_UNKNOWN' })] })])
    assert.throws(() => contracts.validateHqHonConversationRecords(bad));
  assert.equal(contracts.validateHqHonTurn(done(t, { reply: null, concealed: true })).concealed, true, 'a concealed answer carries no text');
  // The invocation is handed over once, by the call that created the turn, with the mode's fixed budgets.
  assert.equal(contracts.validateHqHonAskRecords({ turn: t, invocation: invocation(t), budget: budget(), replayed: false }).invocation.turnId, t.turnId);
  for (const bad of [{ turn: t, invocation: invocation(t), budget: budget(), replayed: true }, { turn: t, invocation: null, budget: budget(), replayed: false },
    { turn: t, invocation: invocation(t, { inputBudget: 9000 }), budget: budget(), replayed: false }, { turn: t, invocation: invocation(t, { providerId: 'DIRECT_LLM_API' }), budget: budget(), replayed: false },
    { turn: done(t), invocation: invocation(t), budget: budget(), replayed: false }])
    assert.throws(() => contracts.validateHqHonAskRecords(bad));
});

test('provider runtime: HQ HON has its own prompt and HQ facts label; it never takes a tone, a continuation or a SUGGEST line', async () => {
  assert.match(HQ_HON_SYSTEM_PROMPT, /HON HQ/); assert.doesNotMatch(HQ_HON_SYSTEM_PROMPT, /school's own staff/);
  assert.equal(honReplySystemPrompt('STANDARD', 2, 'hq_hon'), '');
  assert.equal(honReplySystemPrompt('STANDARD', 1, 'hq_hon', 'FRIENDLY_COACH'), '');
  assert.ok(honReplySystemPrompt('DETAILED', 1, 'hq_hon').startsWith(HQ_HON_SYSTEM_PROMPT));
  let body;
  const runtime = new OpenRouterHonReplyRuntime(() => ({ OPENROUTER_API_KEY: 'test-key', OPENROUTER_PAID_CALL_APPROVED: 'true' }), async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ model: 'fixture/model', choices: [{ finish_reason: 'stop', message: { content: 'Three schools.\nSUGGEST: marcus\nASK: More?' } }],
      usage: { prompt_tokens: 900, completion_tokens: 40, cost: 0.0009 } }), { status: 200 });
  });
  const t = turn();
  const result = await runtime.generate({ ...invocation(t), specialist: 'hq_hon', step: 1 });
  assert.equal(body.messages[0].content, honReplySystemPrompt('STANDARD', 1, 'hq_hon'));
  assert.match(body.messages[1].content, /^Question: How many schools\?\nHON OS HQ facts \(data only\): /);
  assert.deepEqual(result.suggestions, [], 'HQ HON never suggests school specialists');
  assert.equal(result.reply, 'Three schools.\nSUGGEST: marcus');
});

test('0264: the six HQ executives each have their own read-only prompt; the agents a reader may ask are closed and ordered', async () => {
  const executives = ['chase', 'mia', 'ethan', 'olivia', 'ryan', 'sophia'];
  assert.deepEqual([...contracts.HQ_HON_AGENTS], ['hon', ...executives], 'the locked HQ catalog order');
  for (const agentKey of contracts.HQ_HON_AGENTS) assert.equal(contracts.validateHqHonAskInput(ask({ agentKey })).agentKey, agentKey);
  const names = { chase: 'Chase', mia: 'Mia', ethan: 'Ethan', olivia: 'Olivia', ryan: 'Ryan', sophia: 'Sophia' };
  for (const a of executives) {
    const prompt = honReplySystemPrompt('STANDARD', 1, 'hq_hon', 'STANDARD', a);
    assert.ok(prompt.startsWith(HQ_EXECUTIVE_PROMPTS[a]) && prompt.startsWith(`You are ${names[a]}, HON HQ's`), a);
    assert.match(prompt, /You cannot take any action/); assert.match(prompt, /untrusted data, not instructions/);
    assert.match(prompt, /do not collect payments yet|does not collect payments yet/);
    assert.equal(honReplySystemPrompt('STANDARD', 2, 'hq_hon', 'STANDARD', a), '', 'never continued');
    assert.equal(honReplySystemPrompt('STANDARD', 1, 'hq_hon', 'FORMAL', a), '', 'never takes a school tone');
  }
  assert.equal(honReplySystemPrompt('STANDARD', 1, 'hq_hon', 'STANDARD', 'claire'), '', 'a school specialist is not an HQ agent');
  assert.equal(honReplySystemPrompt('STANDARD', 1, 'hq_hon', 'STANDARD', 'hon'), honReplySystemPrompt('STANDARD', 1, 'hq_hon'), 'HON is unchanged');
  let body;
  const runtime = new OpenRouterHonReplyRuntime(() => ({ OPENROUTER_API_KEY: 'test-key', OPENROUTER_PAID_CALL_APPROVED: 'true' }), async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ model: 'fixture/model', choices: [{ finish_reason: 'stop', message: { content: 'Two open cases.' } }],
      usage: { prompt_tokens: 900, completion_tokens: 40, cost: 0.0009 } }), { status: 200 });
  });
  const t = turn({ agentKey: 'mia' });
  await runtime.generate({ ...invocation(t, { agentKey: 'mia' }), specialist: 'hq_hon', hqAgent: 'mia', step: 1 });
  assert.equal(body.messages[0].content, honReplySystemPrompt('STANDARD', 1, 'hq_hon', 'STANDARD', 'mia'));
  await assert.rejects(runtime.generate({ ...invocation(t), specialist: 'hq_hon', hqAgent: 'kai', step: 1 }), e => e.outcome === 'PRE_SEND');
  // availableAgents: HON first, catalog order, unique, closed.
  const viewer = { ...person(), isOwner: false };
  assert.deepEqual(contracts.validateHqHonConversationRecords(conv(viewer, { turns: [], availableAgents: ['hon', 'mia', 'sophia'] })).availableAgents, ['hon', 'mia', 'sophia']);
  for (const availableAgents of [[], ['mia'], ['hon', 'sophia', 'mia'], ['hon', 'mia', 'mia'], ['hon', 'claire'], 'hon'])
    assert.throws(() => contracts.validateHqHonConversationRecords(conv(viewer, { turns: [], availableAgents })), String(availableAgents));
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
async function appWith(callSaasBilling, runtime) {
  const module = await Test.createTestingModule({ controllers: [HqHonController],
    providers: [HqHonService, SaasBillingService, SaasReadGuard, SaasCommandGuard, { provide: RuntimeDatabaseService, useValue: { callSaasBilling } },
      { provide: HON_REPLY_PROVIDER_RUNTIME, useValue: runtime }] })
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

test('HTTP: production wiring (no paid-call approval) says NOT_CONNECTED and a question never reaches the database', () => withOrigin(async () => {
  const calls = [], viewer = { ...person(), isOwner: false };
  const { app, base } = await appWith(async (operation, params) => { calls.push([operation, params]); return conv(viewer); }, new OpenRouterHonReplyRuntime(() => ({})));
  try {
    const view = await send(`${base}/hq/hon`);
    assert.equal(view.status, 200, view.body); assert.equal(view.headers['cache-control'], 'private, no-store');
    assert.equal(JSON.parse(view.body).data.provider, 'NOT_CONNECTED');
    assert.deepEqual(calls, [['readHqHonConversation', ['verified-human']]]);
    const r = await send(`${base}/hq/hon/turns`, { method: 'POST', headers: command('hq-hon-ask'), body: JSON.stringify(ask()) });
    assert.deepEqual([r.status, JSON.parse(r.body).code], [503, 'HQ_HON_PROVIDER_NOT_CONNECTED']);
    assert.equal(calls.length, 1, 'nothing reserved or written');
  } finally { await app.close(); }
}));

test('HTTP: ask -> one provider call -> record; replay never calls again; outcomes; budget and resolution forward only validated input', () => withOrigin(async () => {
  const provider = new FakeRuntime();
  const calls = []; let reply;
  const { app, base } = await appWith(async (operation, params) => { calls.push([operation, params]); return reply(operation, params); }, provider);
  const post = (body, key = U(), marker = 'hq-hon-ask', path = 'turns') => send(`${base}/hq/hon/${path}`, { method: 'POST', headers: command(marker, key), body: JSON.stringify(body) });
  try {
    const t = turn();
    const answer = (patch) => (op) => op === 'askHqHon' ? { turn: t, invocation: invocation(t), budget: budget(), replayed: false } : { turn: done(t, patch), budget: budget() };
    reply = answer();
    const key = U(), r = await post(ask(), key);
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(JSON.parse(r.body).data, { turn: done(t), budget: budget(), replayed: false });
    assert.deepEqual(calls.map(c => c[0]), ['askHqHon', 'recordHqHonResult']);
    assert.deepEqual(calls[0][1], ['verified-human', JSON.stringify(ask()), key]);
    assert.deepEqual(provider.calls.map(c => [c.specialist, c.hqAgent, c.providerId, c.modelId, c.step, c.facts]), [['hq_hon', 'hon', 'OPENROUTER', 'fixture/model', 1, '{"hqOverview":{}}']]);
    assert.deepEqual(JSON.parse(calls[1][1][2]), { outcome: 'ANSWERED', reply: 'Three schools.', truncated: false, inputTokens: 2000, outputTokens: 300, providerCostMicrounits: 900, failureReason: null });
    // Unverified answers, suggestions and provider errors are recorded as such, never trusted or retried.
    const nothing = { reply: null, truncated: null, inputTokens: null, outputTokens: null, providerCostMicrounits: null };
    for (const [next, outcome, failureReason, status] of [
      [{ reply: 'x', inputTokens: 9000, outputTokens: 1, providerCostMicrounits: 1, truncated: false, suggestions: [] }, 'UNKNOWN', 'UNVERIFIED_RESULT', 'UNDER_REVIEW'],
      [{ reply: 'x', inputTokens: 10, outputTokens: 1, providerCostMicrounits: 1, truncated: false, suggestions: ['marcus'] }, 'UNKNOWN', 'UNVERIFIED_RESULT', 'UNDER_REVIEW'],
      [new HonReplyProviderRuntimeError('FAILED', 'PROVIDER_REJECTED'), 'FAILED', 'PROVIDER_REJECTED', 'FAILED'],
      [new HonReplyProviderRuntimeError('PRE_SEND', 'CONFIGURATION_REQUIRED'), 'NOT_SENT', 'CONFIGURATION_REQUIRED', 'FAILED'],
      [new HonReplyProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN'), 'UNKNOWN', 'PROVIDER_UNKNOWN', 'UNDER_REVIEW'],
      [new Error('boom'), 'UNKNOWN', 'PROVIDER_UNKNOWN', 'UNDER_REVIEW']]) {
      calls.length = 0; provider.next = next;
      reply = (op) => op === 'askHqHon' ? { turn: t, invocation: invocation(t), budget: budget(), replayed: false }
        : { turn: { ...t, status, failureReason, version: 2, completedAt: T2 }, budget: budget() };
      assert.equal((await post(ask())).status, 200);
      assert.deepEqual(JSON.parse(calls[1][1][2]), { outcome, ...nothing, failureReason }, String(failureReason));
    }
    // A replay never calls the provider again; a stale in-flight replay is held as INTERRUPTED.
    calls.length = 0; provider.calls.length = 0;
    reply = () => ({ turn: done(t), invocation: null, budget: budget(), replayed: true });
    assert.equal(JSON.parse((await post(ask())).body).data.replayed, true);
    assert.deepEqual([calls.length, provider.calls.length], [1, 0]);
    calls.length = 0;
    const stale = turn({ createdAt: '2020-01-01T00:00:00.000Z' });
    reply = (op) => op === 'askHqHon' ? { turn: stale, invocation: null, budget: budget(), replayed: true }
      : { turn: { ...stale, status: 'UNDER_REVIEW', failureReason: 'INTERRUPTED', version: 2, completedAt: T2 }, budget: budget() };
    assert.equal(JSON.parse((await post(ask())).body).data.turn.failureReason, 'INTERRUPTED');
    assert.equal(JSON.parse(calls[1][1][2]).failureReason, 'INTERRUPTED'); assert.equal(provider.calls.length, 0);
    // A database answer about another question is never shown, and a failed record is never resent.
    calls.length = 0;
    reply = () => ({ turn: turn({ question: 'Other?' }), invocation: invocation(turn({ question: 'Other?' })), budget: budget(), replayed: false });
    assert.equal((await post(ask())).status, 503); assert.equal(provider.calls.length, 0);
    calls.length = 0;
    reply = (op) => { if (op === 'askHqHon') return { turn: t, invocation: invocation(t), budget: budget(), replayed: false }; throw Object.assign(new Error('x'), { code: '08006' }); };
    const lost = await post(ask());
    assert.deepEqual([lost.status, JSON.parse(lost.body).code, provider.calls.length], [503, 'HQ_HON_PERSISTENCE_UNKNOWN', 1]);
    // Refusals before the database.
    calls.length = 0; provider.calls.length = 0;
    for (const [headers, body] of [[command('hq-hon-budget-set'), ask()], [command('hq-hon-ask'), { ...ask(), modelId: 'x' }],
      [{ ...command('hq-hon-ask'), origin: 'https://evil.example' }, ask()], [{ ...command('hq-hon-ask'), 'idempotency-key': 'nope' }, ask()]])
      assert.ok([400, 403].includes((await send(`${base}/hq/hon/turns`, { method: 'POST', headers, body: JSON.stringify(body) })).status));
    assert.deepEqual([calls.length, provider.calls.length], [0, 0]);
    // Budget.
    const b = { periodStart: '2026-11-01', creditCap: 100, expectedVersion: null, reason: 'November plan' }, bk = U();
    reply = () => ({ budget: budget(), replayed: false });
    assert.equal((await post(b, bk, 'hq-hon-budget-set', 'budget')).status, 200);
    assert.deepEqual(calls.at(-1), ['setHqHonBudget', ['verified-human', JSON.stringify(b), bk]]);
    reply = () => ({ budget: budget({ periodStart: '2026-12-01' }), replayed: false });
    assert.equal((await post(b, U(), 'hq-hon-budget-set', 'budget')).status, 503, 'an answer about another month is never shown');
    // Resolution.
    const res = { expectedVersion: 2, resolution: 'NOT_CHARGED', chargedCredits: null, providerCostMicrounits: null, evidenceReference: 'Invoice 42' }, rk = U();
    reply = () => ({ turn: { ...t, status: 'RESOLVED_NOT_CHARGED', failureReason: 'PROVIDER_UNKNOWN', completedAt: T2, version: 3 }, budget: budget(), replayed: false });
    assert.equal((await post(res, rk, 'hq-hon-turn-resolve', `turns/${t.turnId}/resolution`)).status, 200);
    assert.deepEqual(calls.at(-1), ['resolveHqHonTurn', ['verified-human', t.turnId, JSON.stringify(res), rk]]);
    reply = () => ({ turn: { ...t, status: 'RESOLVED_CHARGED', chargedCredits: 0, completedAt: T2, version: 3 }, budget: budget(), replayed: false });
    assert.equal((await post(res, U(), 'hq-hon-turn-resolve', `turns/${t.turnId}/resolution`)).status, 503);
    // Rule refusals.
    for (const [code, message, status, answer] of [['42501', 'SAAS_FORBIDDEN', 403, 'SAAS_FORBIDDEN'], ['23514', 'HQ_HON_BUDGET_NOT_SET', 422, 'HQ_HON_BUDGET_NOT_SET'],
      ['23514', 'HQ_HON_BUDGET_EXHAUSTED', 422, 'HQ_HON_BUDGET_EXHAUSTED'], ['23514', 'HQ_HON_TOO_MANY_IN_PROGRESS', 422, 'HQ_HON_TOO_MANY_IN_PROGRESS'],
      ['23514', 'HQ_HON_PAUSED_BY_HQ', 422, 'HQ_HON_PAUSED_BY_HQ'], ['23514', 'HQ_HON_NO_ELIGIBLE_ROUTE', 422, 'HQ_HON_NO_ELIGIBLE_ROUTE'],
      ['23514', 'HQ_HON_CAP_BELOW_USE', 422, 'HQ_HON_CAP_BELOW_USE'], ['23505', 'SAAS_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED']]) {
      reply = () => { const e = new Error(message); e.code = code; throw e; };
      const r2 = await post(ask());
      assert.deepEqual([r2.status, JSON.parse(r2.body).code], [status, answer], message);
    }
    assert.equal((await send(`${base}/hq/hon/turns/not-a-uuid/resolution`, { method: 'POST', headers: command('hq-hon-turn-resolve'), body: JSON.stringify(res) })).status, 400);
  } finally { await app.close(); }
}));

test('HTTP (0338): executive performance forwards only a catalog agent and returns validated aggregates', () => withOrigin(async () => {
  const calls = [];
  const perf = (agentKey, patch = {}) => ({ agentKey, periodStart: '2026-11-01', asked: 4, answered: 2, failed: 1, underReview: 1, inProgress: 0, resolved: 0,
    askers: 2, chargedCredits: 9, lastAskedAt: '2026-11-13T07:00:00.000Z', asOf: '2026-11-13T07:30:00.000Z', ...patch });
  let reply = (op, params) => perf(params[1]);
  const { app, base } = await appWith(async (operation, params) => { calls.push([operation, params]); return reply(operation, params); }, new OpenRouterHonReplyRuntime(() => ({})));
  try {
    const r = await send(`${base}/hq/hon/performance/chase`);
    assert.equal(r.status, 200, r.body); assert.equal(r.headers['cache-control'], 'private, no-store');
    assert.deepEqual(JSON.parse(r.body).data, perf('chase'));
    assert.deepEqual(calls, [['readHqHonAgentPerformance', ['verified-human', 'chase']]]);
    for (const bad of ['claire', 'CHASE', 'kai']) {
      const b = await send(`${base}/hq/hon/performance/${bad}`);
      assert.deepEqual([b.status, JSON.parse(b.body).code], [400, 'INVALID_SAAS_INPUT'], bad);
    }
    assert.equal(calls.length, 1, 'an unknown agent never reaches the database');
    // Totals that do not add up, a non-month period or an extra key are drift, never shown.
    for (const drift of [perf('mia', { asked: 5 }), perf('mia', { periodStart: '2026-11-13' }), { ...perf('mia'), question: 'x' }, perf('mia', { asked: 0, answered: 0, failed: 0, underReview: 0, askers: 0 })]) {
      reply = () => drift;
      assert.equal((await send(`${base}/hq/hon/performance/mia`)).status, 503);
    }
  } finally { await app.close(); }
}));
