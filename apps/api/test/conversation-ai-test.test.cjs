const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const { OpenRouterConversationTestRuntime, ConversationTestProviderRuntimeError, CONVERSATION_TEST_SYSTEM_PROMPT } = require('../dist/ai/conversation-test-provider-runtime.js');
const { ConversationAiTestService } = require('../dist/conversations/conversation-ai-test.service.js');
const { validateConversationAiTestAnswer, validateConversationAiTestAsk, verifyConversationAiTestState } = require('@hon/contracts');

const id = '11111111-1111-4111-8111-111111111111', key = '22222222-2222-4222-8222-222222222222';
const env = () => ({ OPENROUTER_API_KEY: 'unit-only-not-a-secret', OPENROUTER_PAID_CALL_APPROVED: 'true' });
const input = { providerId: 'OPENROUTER', modelId: 'approved/test', providerRequestId: id, request: JSON.stringify({ question: 'How much is a trial?', school: { school: 'Test Dojo', answers: [] } }), inputBudget: 12000, outputBudget: 600, maxCostMicrounits: 20000 };
const answer = { reply: 'Your first class is free. Want to book one?', needsStaff: false };
const ok = (content, extra = {}) => ({ model: input.modelId, choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 900, completion_tokens: 60, cost: 0.0004 }, ...extra });
const response = v => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('test runtime needs the key and the paid-call approval, and sends nothing otherwise', async () => {
  for (const e of [{}, { OPENROUTER_PAID_CALL_APPROVED: 'true' }, { OPENROUTER_API_KEY: 'unit-only-not-a-secret' }, { OPENROUTER_API_KEY: 'x', OPENROUTER_PAID_CALL_APPROVED: 'yes' }]) {
    let calls = 0; const rt = new OpenRouterConversationTestRuntime(() => e, async () => { calls++; throw Error('NO NETWORK'); });
    assert.equal(rt.readiness('OPENROUTER'), 'CONFIGURATION_REQUIRED');
    await assert.rejects(rt.generate(input), x => x.outcome === 'PRE_SEND' && x.reason === 'CONFIGURATION_REQUIRED'); assert.equal(calls, 0);
  }
  assert.equal(new OpenRouterConversationTestRuntime(env).readiness('OTHER'), 'UNSUPPORTED_PROVIDER');
});

test('test runtime sends one fixed request with the plan budgets and returns usage with the parsed answer', async () => {
  let calls = 0; const rt = new OpenRouterConversationTestRuntime(env, async (url, o) => {
    calls++; assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions'); assert.equal(o.redirect, 'error'); assert.equal(o.headers['Idempotency-Key'], id);
    const body = JSON.parse(o.body); assert.equal(body.max_tokens, 600); assert.equal(body.provider.allow_fallbacks, false); assert.equal(body.tools, undefined);
    assert.equal(body.messages[0].content, CONVERSATION_TEST_SYSTEM_PROMPT); assert.equal(body.messages[1].content, input.request);
    return response(ok(JSON.stringify(answer)));
  });
  assert.deepEqual(await rt.generate(input), { answer, inputTokens: 900, outputTokens: 60, providerCostMicrounits: 400 }); assert.equal(calls, 1);
  for (const patch of [{ inputBudget: 16000 }, { outputBudget: 4000 }, { maxCostMicrounits: 150000 }, { modelId: '../x' }, { request: 'x'.repeat(12000) }]) {
    let sent = 0; await assert.rejects(new OpenRouterConversationTestRuntime(env, async () => { sent++; }).generate({ ...input, ...patch }), x => x.outcome === 'PRE_SEND' && x.reason === 'INVALID_REQUEST'); assert.equal(sent, 0);
  }
});

test('a paid answer that is not JSON or was cut short keeps its usage (answer null); transport doubt is UNKNOWN; refusals are FAILED', async () => {
  for (const r of [ok('not json'), { ...ok(JSON.stringify(answer)), choices: [{ finish_reason: 'length', message: { content: '{"reply":' } }] }]) {
    const out = await new OpenRouterConversationTestRuntime(env, async () => response(r)).generate(input);
    assert.equal(out.answer, null); assert.equal(out.inputTokens, 900);
  }
  for (const t of [async () => { throw Error('socket'); }, async () => new Response('x', { status: 503 }), async () => response(ok('{}', { model: 'swapped' })), async () => response({ ...ok('{}'), usage: { prompt_tokens: 1, completion_tokens: 1 } }), async () => new Response('x'.repeat(40000))]) {
    let calls = 0; await assert.rejects(new OpenRouterConversationTestRuntime(env, async (...a) => { calls++; return t(...a); }).generate(input), x => x instanceof ConversationTestProviderRuntimeError && x.outcome === 'UNKNOWN'); assert.equal(calls, 1);
  }
  await assert.rejects(new OpenRouterConversationTestRuntime(env, async () => new Response('', { status: 429 })).generate(input), x => x.outcome === 'FAILED' && x.reason === 'PROVIDER_REJECTED');
});

test('the question and answer validators are closed; the state verifier ties mode to reason', () => {
  assert.deepEqual(validateConversationAiTestAsk({ question: '  How much is a trial?  ' }), { question: 'How much is a trial?' });
  for (const bad of [null, {}, { question: '' }, { question: 'x'.repeat(501) }, { question: 'x', schoolId: id }, { question: 'a\u0000b' }, { question: 3 }]) assert.throws(() => validateConversationAiTestAsk(bad));
  assert.deepEqual(validateConversationAiTestAnswer(answer), answer);
  for (const bad of [null, {}, { reply: '', needsStaff: false }, { reply: 'x', needsStaff: 'no' }, { reply: 'x'.repeat(1601), needsStaff: false }, { reply: 'x', needsStaff: false, send: true }]) assert.throws(() => validateConversationAiTestAnswer(bad));
  assert.throws(() => verifyConversationAiTestState({ mode: 'AI', reason: 'PAUSED', tests: [] }));
  assert.throws(() => verifyConversationAiTestState({ mode: 'UNAVAILABLE', reason: null, tests: [] }));
  assert.throws(() => verifyConversationAiTestState({ mode: 'AI', reason: null, tests: [view({ status: 'WORKING', reply: 'leak' })] }));
  assert.equal(verifyConversationAiTestState({ mode: 'AI', reason: null, tests: [view({ status: 'ANSWERED', reply: 'Hi', needsStaff: true })] }).tests[0].needsStaff, true);
});

const ctx = { organizationId: id, schoolId: id, principalId: id, externalSubject: 'verified-unit-subject', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key };
function view(patch = {}) { return { id, status: 'WORKING', reason: null, question: 'How much is a trial?', reply: null, needsStaff: null, askedAt: '2026-11-19T00:00:00.000Z', ...patch }; }
function fakeDb(answers) {
  const log = []; let tx = 0;
  const client = n => ({ query: async (sql, params) => { const fn = /hon\.([a-z_]+)\(/.exec(sql)?.[1]; if (fn) log.push({ tx: n, fn, params }); const a = fn ? answers[fn] : undefined; return { rows: [{ data: typeof a === 'function' ? a(params) : a }] }; } });
  return { log, db: { withTenantTransaction: async (c, work) => work(client(++tx)) } };
}
const prepared = { providerId: 'OPENROUTER', modelId: 'approved/test', providerRequestId: id, request: '{}', inputBudget: 12000, outputBudget: 600, maxCostMicrounits: 20000 };

test('a question runs begin, plan (chad, DRAFT_FOLLOW_UP), prepare, one provider call and one record', async () => {
  let recorded, planned, sent = 0;
  const { log, db } = fakeDb({ begin_conversation_ai_test: view(), conversation_ai_test_planning_reference: { planId: null, workItemId: id, workVersion: 1 },
    prepare_conversation_ai_test: prepared,
    record_conversation_ai_test: p => { recorded = JSON.parse(p[2]); return view({ status: 'ANSWERED', reply: answer.reply, needsStaff: false, recorded: 'RESULT_RECORDED' }); } });
  const plans = { plan: async (c, work, i) => { planned = i; assert.equal(c.idempotencyKey, id); return { status: 'PLANNED', plan: { id } }; } };
  const provider = { readiness: () => 'READY', generate: async () => { sent++; return { answer: { reply: '  Your first class is free.  ', needsStaff: false }, inputTokens: 900, outputTokens: 60, providerCostMicrounits: 400 }; } };
  const out = await new ConversationAiTestService(db, plans, provider).ask(ctx, { question: 'How much is a trial?' });
  assert.equal(out.status, 'ANSWERED'); assert.equal(sent, 1);
  assert.deepEqual(log.map(l => l.fn), ['begin_conversation_ai_test', 'conversation_ai_test_planning_reference', 'prepare_conversation_ai_test', 'record_conversation_ai_test']);
  assert.deepEqual({ agent: planned.agentKey, task: planned.taskClass, i: planned.inputBudget, o: planned.outputBudget, c: planned.maxProviderCostMicrounits }, { agent: 'chad', task: 'DRAFT_FOLLOW_UP', i: 12000, o: 600, c: 20000 });
  assert.deepEqual(recorded, { usage: { inputTokens: 900, outputTokens: 60, providerCostMicrounits: 400 }, answer: { reply: 'Your first class is free.', needsStaff: false } });
  assert.notEqual(log.find(l => l.fn === 'record_conversation_ai_test').tx, log.find(l => l.fn === 'prepare_conversation_ai_test').tx);
  assert.equal(log.find(l => l.fn === 'prepare_conversation_ai_test').params[3], true);
});

test('an answer outside the closed shape is recorded as null; a provider failure or bad usage records the outcome only; a replayed answer makes no call', async () => {
  let recorded;
  const base = { begin_conversation_ai_test: view(), conversation_ai_test_planning_reference: { planId: id, workItemId: id, workVersion: 2 }, prepare_conversation_ai_test: prepared,
    record_conversation_ai_test: p => { recorded = JSON.parse(p[2]); return view({ status: 'NOT_ANSWERED', reason: 'NOT_ANSWERED' }); },
    read_conversation_ai_test: { mode: 'AI', reason: null, tests: [view({ status: 'FAILED', reason: 'NOT_ANSWERED' })] } };
  const a = fakeDb(base);
  await new ConversationAiTestService(a.db, { plan: async () => assert.fail('already planned') }, { readiness: () => 'READY', generate: async () => ({ answer: { reply: 'hi', send: true }, inputTokens: 5, outputTokens: 5, providerCostMicrounits: 7 }) }).ask(ctx, { question: 'x' });
  assert.equal(recorded.answer, null);
  const b = fakeDb(base);
  const out = await new ConversationAiTestService(b.db, {}, { readiness: () => 'READY', generate: async () => { throw new ConversationTestProviderRuntimeError('FAILED', 'PROVIDER_REJECTED'); } }).ask(ctx, { question: 'x' });
  assert.equal(out.status, 'FAILED'); assert.deepEqual(b.log.find(l => l.fn === 'fail_conversation_ai_test').params.slice(2), ['FAILED', 'PROVIDER_REJECTED']);
  assert(!b.log.some(l => l.fn === 'record_conversation_ai_test'));
  const c = fakeDb(base);
  await new ConversationAiTestService(c.db, {}, { readiness: () => 'READY', generate: async () => ({ answer, inputTokens: 0, outputTokens: 5, providerCostMicrounits: 7 }) }).ask(ctx, { question: 'x' });
  assert.deepEqual(c.log.find(l => l.fn === 'fail_conversation_ai_test').params.slice(2), ['UNKNOWN', 'PROVIDER_UNKNOWN']);
  let calls = 0; const d = fakeDb({ begin_conversation_ai_test: view({ status: 'ANSWERED', reply: 'Hi', needsStaff: false }) });
  assert.equal((await new ConversationAiTestService(d.db, {}, { readiness: () => 'READY', generate: async () => { calls++; } }).ask(ctx, { question: 'x' })).status, 'ANSWERED');
  assert.equal(calls, 0); assert.deepEqual(d.log.map(l => l.fn), ['begin_conversation_ai_test']);
});

test('only a direct human with a UUID key can ask; reads take no key; nothing reaches SQL or the provider otherwise', async () => {
  let touched = 0; const db = { withTenantTransaction: async () => { touched++; throw Error('Unexpected SQL'); } };
  const svc = new ConversationAiTestService(db, {}, { readiness: () => 'READY', generate: async () => { touched++; } });
  for (const patch of [{ source: 'AI' }, { principalType: 'AI_EMPLOYEE' }, { delegatedByPrincipalId: id }, { actionRequestId: id }, { externalSubject: '' }]) await assert.rejects(svc.ask({ ...ctx, ...patch }, { question: 'x' }), e => e.getStatus?.() === 403);
  await assert.rejects(svc.ask({ ...ctx, idempotencyKey: 'not-a-uuid' }, { question: 'x' }), e => e.getStatus?.() === 409);
  for (const extra of ['schoolId', 'providerId', 'modelId', 'conversationId']) await assert.rejects(svc.ask(ctx, { question: 'x', [extra]: id }), e => e.getStatus?.() === 400);
  await assert.rejects(svc.state({ ...ctx }), e => e.getStatus?.() === 409);
  assert.equal(touched, 0);
});

test('database refusals map to plain answers', async () => {
  const fail = (code, message) => ({ withTenantTransaction: async () => { throw Object.assign(new Error(message), { code }); } });
  const svc = (db) => new ConversationAiTestService(db, {}, { readiness: () => 'READY' });
  await assert.rejects(svc(fail('54000', 'CONVERSATION_AI_TEST_BUSY')).ask(ctx, { question: 'x' }), e => e.getStatus() === 409 && e.getResponse().code === 'CONVERSATION_AI_TEST_BUSY');
  await assert.rejects(svc(fail('42501', 'CONVERSATION_AI_TEST_UNAVAILABLE')).ask(ctx, { question: 'x' }), e => e.getStatus() === 403 && e.getResponse().code === 'CONVERSATION_AI_TEST_UNAVAILABLE');
  await assert.rejects(svc(fail('42501', 'AI_PAUSED_BY_HQ')).ask(ctx, { question: 'x' }), e => e.getResponse().code === 'CONVERSATION_AI_TEST_SPEND_STOPPED' && e.getResponse().reason === 'AI_PAUSED_BY_HQ');
  await assert.rejects(svc(fail('23505', 'AI_TEXT_PROPOSAL_REPLAY_SWAP')).ask(ctx, { question: 'x' }), e => e.getResponse().code === 'IDEMPOTENCY_KEY_REUSED');
  await assert.rejects(svc(fail('XX000', 'boom')).ask(ctx, { question: 'x' }), e => e.getStatus() === 503);
});

test('the live module uses the OpenRouter test runtime and no test fake; sources log nothing', () => {
  const module = fs.readFileSync(path.join(__dirname, '../src/app.module.ts'), 'utf8');
  assert.match(module, /provide: CONVERSATION_TEST_PROVIDER_RUNTIME, useFactory: \(\) => new OpenRouterConversationTestRuntime\(\)/);
  for (const file of ['src/ai/conversation-test-provider-runtime.ts', 'src/conversations/conversation-ai-test.service.ts']) {
    const s = fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); assert(!/console\.|logger\./.test(s)); assert(!/invokeLLM|generateText|@openrouter/.test(s));
  }
});
