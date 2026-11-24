const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const { OpenRouterMerchRuntime, COMMERCE_REVIEW_SYSTEM_PROMPT } = require('../dist/commerce/shopify/merch-provider-runtime.js');
const { ALEX_PLAN_TEXT_PROFILE, ALEX_PLAN_SYSTEM_PROMPT } = require('../dist/alex-delegation/alex-plan-provider.js');
const { AlexPlanService } = require('../dist/alex-delegation/alex-plan.service.js');
const { validateAlexPlanBrief, validateAlexPlanProposal, validateAlexPlanCreate, alexPlanProblems, verifyAlexPlanView, verifyAlexPlanList } = require('@hon/contracts');

const id = '11111111-1111-4111-8111-111111111111', key = '22222222-2222-4222-8222-222222222222';
const env = () => ({ OPENROUTER_API_KEY: 'unit-only-not-a-secret', OPENROUTER_PAID_CALL_APPROVED: 'true' });
const brief = { goal: 'Get ten more trial bookings this week', horizon: 'WEEK' };
const task = (patch = {}) => ({ title: 'Call trial leads', description: 'Phone each trial lead who did not book a second class.', priority: 'HIGH', assignee: 'S2', dueInDays: 2, area: 'chad', ...patch });
const proposal = { summary: 'Follow up on trials first.', tasks: [task(), task({ title: 'Check capacity', assignee: null, dueInDays: null, area: null, priority: 'LOW' })] };
const input = { providerId: 'OPENROUTER', modelId: 'approved/test', providerRequestId: id, request: JSON.stringify({ brief, schoolName: 'Test Dojo', localToday: '2026-11-22', school: {}, staff: [] }), inputBudget: 12000, outputBudget: 3000, maxCostMicrounits: 80000 };
const ok = content => ({ model: input.modelId, choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 1500, completion_tokens: 400, cost: 0.0012 } });
const response = v => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
const runtime = transport => new OpenRouterMerchRuntime(env, transport, ALEX_PLAN_TEXT_PROFILE);

test('the Alex runtime sends one fixed request with the Alex prompt and budgets', async () => {
  let calls = 0; const rt = runtime(async (url, o) => {
    calls++; assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions'); assert.equal(o.redirect, 'error');
    const body = JSON.parse(o.body); assert.equal(body.max_tokens, 3000); assert.equal(body.temperature, 0.3); assert.equal(body.tools, undefined); assert.equal(body.provider.allow_fallbacks, false);
    assert.equal(body.messages[0].content, ALEX_PLAN_SYSTEM_PROMPT); assert.notEqual(body.messages[0].content, COMMERCE_REVIEW_SYSTEM_PROMPT); assert.equal(body.messages[1].content, input.request);
    return response(ok(JSON.stringify(proposal)));
  });
  assert.deepEqual(await rt.generate(input), { proposal, inputTokens: 1500, outputTokens: 400, providerCostMicrounits: 1200 }); assert.equal(calls, 1);
  for (const patch of [{ inputBudget: 9000 }, { outputBudget: 2500 }, { maxCostMicrounits: 150000 }, { modelId: '../x' }, { request: 'x'.repeat(12000) }]) {
    let sent = 0; await assert.rejects(runtime(async () => { sent++; }).generate({ ...input, ...patch }), x => x.outcome === 'PRE_SEND' && x.reason === 'INVALID_REQUEST'); assert.equal(sent, 0);
  }
  // Without the paid-call switch nothing is sent.
  let off = 0; await assert.rejects(new OpenRouterMerchRuntime(() => ({ OPENROUTER_API_KEY: 'unit-only' }), async () => { off++; }, ALEX_PLAN_TEXT_PROFILE).generate(input), x => x.reason === 'CONFIGURATION_REQUIRED'); assert.equal(off, 0);
  assert(Buffer.byteLength(ALEX_PLAN_SYSTEM_PROMPT) < 2500, 'the prompt leaves room for the facts (the database proof holds the request under 12,000 - 128 - 2,500 bytes)');
});

test('the Alex prompt says plans change nothing and forbids invented numbers and personal data', () => {
  assert.match(ALEX_PLAN_SYSTEM_PROMPT, /You create, send, book and change nothing/); assert.match(ALEX_PLAN_SYSTEM_PROMPT, /Use only the numbers given/);
  assert.match(ALEX_PLAN_SYSTEM_PROMPT, /untrusted text/); assert.match(ALEX_PLAN_SYSTEM_PROMPT, /No links, email addresses, phone numbers or personal data/);
});

test('the brief, the plan shape and the create request are closed', () => {
  assert.deepEqual(validateAlexPlanBrief(brief), brief); assert.deepEqual(validateAlexPlanBrief({ goal: '한 달 안에 승급 심사 준비', horizon: 'MONTH' }).horizon, 'MONTH');
  for (const bad of [null, {}, { ...brief, horizon: 'YEAR' }, { goal: '', horizon: 'WEEK' }, { ...brief, goal: ' padded' }, { ...brief, goal: 'password: x' }, { ...brief, goal: 'x'.repeat(501) }, { ...brief, extra: 1 }, { ...brief, goal: 'a\u200Bb' }]) {
    assert.throws(() => validateAlexPlanBrief(bad), JSON.stringify(bad));
  }
  assert.deepEqual(validateAlexPlanProposal(proposal), proposal);
  for (const bad of [{}, { ...proposal, tasks: [] }, { ...proposal, tasks: Array.from({ length: 9 }, () => task()) }, { ...proposal, tasks: [task({ assignee: 'Alex' })] },
    { ...proposal, tasks: [task({ assignee: 'S31' })] }, { ...proposal, tasks: [task({ dueInDays: 32 })] }, { ...proposal, tasks: [task({ dueInDays: 1.5 })] }, { ...proposal, tasks: [task({ area: 'kai' })] },
    { ...proposal, tasks: [task({ priority: 'URGENT' })] }, { ...proposal, tasks: [{ ...task(), workItemId: id }] }, { ...proposal, tasks: [task({ title: 'x'.repeat(121) })] },
    { ...proposal, tasks: [task({ description: 'line one\nline two' })] }, { ...proposal, summary: 'x'.repeat(301) }]) {
    assert.throws(() => validateAlexPlanProposal(bad), JSON.stringify(bad).slice(0, 80));
  }
  assert.deepEqual(validateAlexPlanCreate({ tasks: [0, 2] }), { tasks: [0, 2] });
  for (const bad of [{}, { tasks: [] }, { tasks: [0, 0] }, { tasks: [8] }, { tasks: [-1] }, { tasks: ['0'] }, { tasks: [0], extra: 1 }]) assert.throws(() => validateAlexPlanCreate(bad), JSON.stringify(bad));
});

test('a plan with a link or an email address is a problem', () => {
  assert.deepEqual(alexPlanProblems(proposal), []);
  for (const description of ['See https://example.test', 'Visit www.example.test', 'Write to owner@example.test']) {
    assert.deepEqual(alexPlanProblems({ ...proposal, tasks: [task({ description })] }), ['The answer holds a link or an email address.']);
  }
});

test('a view shows the plan only when it was recorded or used, and created tasks only once used', () => {
  const base = { id, status: 'PENDING', reason: null, brief, mine: true, summary: null, tasks: null, staff: [], created: [], problems: [], createdAt: '2026-11-22T00:00:00.000Z', updatedAt: '2026-11-22T00:00:00.000Z' };
  assert.equal(verifyAlexPlanView(base).tasks, null);
  const staff = [{ ref: 'S2', principalId: key, name: 'Synthetic Coach' }];
  assert.deepEqual(verifyAlexPlanView({ ...base, status: 'RESULT_RECORDED', ...proposal, staff }).staff, staff);
  assert.deepEqual(verifyAlexPlanView({ ...base, status: 'APPLIED', ...proposal, created: [{ index: 0, workItemId: key }] }).created, [{ index: 0, workItemId: key }]);
  assert.throws(() => verifyAlexPlanView({ ...base, status: 'RESULT_RECORDED', ...proposal, created: [{ index: 0, workItemId: key }] }));
  assert.throws(() => verifyAlexPlanView({ ...base, status: 'RESULT_REJECTED', ...proposal }));
  assert.throws(() => verifyAlexPlanView({ ...base, staff: [{ ref: 'X1', principalId: key, name: 'x' }] }));
  assert.throws(() => verifyAlexPlanView({ ...base, extra: 1 }));
  assert.throws(() => verifyAlexPlanList(Array.from({ length: 21 }, () => base)));
});

const ctx = { organizationId: id, schoolId: id, principalId: id, externalSubject: 'verified-unit-subject', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key };
test('only a direct human with a key and valid input can ask or create; nothing reaches SQL or the provider otherwise', async () => {
  let touched = 0; const db = { withTenantTransaction: async () => { touched++; throw Error('Unexpected SQL'); }, withTenantReadOnlyTransaction: async () => { touched++; throw Error('Unexpected SQL'); } };
  const svc = new AlexPlanService(db, {}, { readiness: () => { touched++; }, generate: async () => { touched++; } });
  for (const patch of [{ source: 'AI' }, { principalType: 'AI_EMPLOYEE' }, { delegatedByPrincipalId: id }, { actionRequestId: id }, { externalSubject: '' }]) {
    await assert.rejects(svc.request({ ...ctx, ...patch }, brief), e => e.getStatus?.() === 403);
    await assert.rejects(svc.create({ ...ctx, ...patch }, id, { tasks: [0] }), e => e.getStatus?.() === 403);
  }
  await assert.rejects(svc.request({ ...ctx, idempotencyKey: 'not-a-uuid' }, brief), e => e.getStatus?.() === 409);
  await assert.rejects(svc.create({ ...ctx, idempotencyKey: '' }, id, { tasks: [0] }), e => e.getStatus?.() === 409);
  for (const bad of [{ ...brief, providerId: 'x' }, { ...brief, horizon: 'DAY' }]) await assert.rejects(svc.request(ctx, bad), e => e.getStatus?.() === 400 && e.getResponse().code === 'ALEX_PLAN_INVALID');
  await assert.rejects(svc.create(ctx, id, { tasks: [9] }), e => e.getStatus?.() === 400);
  await assert.rejects(svc.create(ctx, 'not-a-uuid', { tasks: [0] }), e => e.getStatus?.() === 400);
  await assert.rejects(svc.read({ ...ctx, idempotencyKey: '' }, 'not-a-uuid'), e => e.getStatus?.() === 400);
  assert.equal(touched, 0);
});

test('the live module gives Alex its own runtime profile and no test fake; sources log nothing', () => {
  const module = fs.readFileSync(path.join(__dirname, '../src/app.module.ts'), 'utf8');
  assert.match(module, /provide: ALEX_PLAN_PROVIDER_RUNTIME, useFactory: \(\) => new OpenRouterMerchRuntime\(undefined, undefined, ALEX_PLAN_TEXT_PROFILE\)/);
  assert.match(module, /AlexPlanController,/); assert.match(module, /AlexPlanService,/);
  for (const file of ['src/alex-delegation/alex-plan.service.ts', 'src/alex-delegation/alex-plan.controller.ts', 'src/alex-delegation/alex-plan-provider.ts']) {
    const s = fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); assert(!/console\.|logger\./.test(s)); assert(!/invokeLLM|generateText|@openrouter/.test(s));
  }
});
