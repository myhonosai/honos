const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const { OpenRouterMerchRuntime, COMMERCE_REVIEW_SYSTEM_PROMPT } = require('../dist/commerce/shopify/merch-provider-runtime.js');
const { MARCUS_REVIEW_TEXT_PROFILE, MARCUS_REVIEW_SYSTEM_PROMPT } = require('../dist/marcus-review/marcus-review-provider.js');
const { JORDAN_FOLLOW_UP_SYSTEM_PROMPT } = require('../dist/jordan-follow-through/jordan-follow-up-provider.js');
const { MarcusReviewService } = require('../dist/marcus-review/marcus-review.service.js');
const { validateMarcusReviewBrief, validateMarcusReviewProposal, marcusReviewProblems, verifyMarcusReviewView, verifyMarcusReviewList } = require('@hon/contracts');

const id = '11111111-1111-4111-8111-111111111111', key = '22222222-2222-4222-8222-222222222222';
const env = () => ({ OPENROUTER_API_KEY: 'unit-only-not-a-secret', OPENROUTER_PAID_CALL_APPROVED: 'true' });
const brief = { period: 'LAST_30_DAYS', question: '' };
const f = (patch = {}) => ({ title: 'Website form brings most leads', detail: 'Eight of twelve new leads came from the trial form.', ...patch });
const n = (patch = {}) => ({ title: 'Call open trial leads', detail: 'Four leads are still open after a week.', area: 'chad', ...patch });
const proposal = { summary: 'Twelve new leads, mostly from the trial form.', findings: [f()], nextSteps: [n(), n({ area: null })] };
const input = { providerId: 'OPENROUTER', modelId: 'approved/test', providerRequestId: id, request: JSON.stringify({ brief, schoolName: 'Test Dojo', localToday: '2026-11-22', windowDays: 30, leads: {}, bySource: [], campaigns: [], forms: [] }), inputBudget: 12000, outputBudget: 3000, maxCostMicrounits: 80000 };
const ok = content => ({ model: input.modelId, choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 1500, completion_tokens: 400, cost: 0.0012 } });
const response = v => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
const runtime = transport => new OpenRouterMerchRuntime(env, transport, MARCUS_REVIEW_TEXT_PROFILE);

test('the Marcus review runtime sends one fixed request with the Marcus prompt and budgets', async () => {
  let calls = 0; const rt = runtime(async (url, o) => {
    calls++; assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions'); assert.equal(o.redirect, 'error');
    const body = JSON.parse(o.body); assert.equal(body.max_tokens, 3000); assert.equal(body.temperature, 0.2); assert.equal(body.tools, undefined); assert.equal(body.provider.allow_fallbacks, false);
    assert.equal(body.messages[0].content, MARCUS_REVIEW_SYSTEM_PROMPT); assert.notEqual(body.messages[0].content, JORDAN_FOLLOW_UP_SYSTEM_PROMPT); assert.notEqual(body.messages[0].content, COMMERCE_REVIEW_SYSTEM_PROMPT);
    assert.equal(body.messages[1].content, input.request);
    return response(ok(JSON.stringify(proposal)));
  });
  assert.deepEqual(await rt.generate(input), { proposal, inputTokens: 1500, outputTokens: 400, providerCostMicrounits: 1200 }); assert.equal(calls, 1);
  for (const patch of [{ inputBudget: 9000 }, { outputBudget: 2500 }, { maxCostMicrounits: 150000 }, { modelId: '../x' }, { request: 'x'.repeat(12000) }]) {
    let sent = 0; await assert.rejects(runtime(async () => { sent++; }).generate({ ...input, ...patch }), x => x.outcome === 'PRE_SEND' && x.reason === 'INVALID_REQUEST'); assert.equal(sent, 0);
  }
  let off = 0; await assert.rejects(new OpenRouterMerchRuntime(() => ({ OPENROUTER_API_KEY: 'unit-only' }), async () => { off++; }, MARCUS_REVIEW_TEXT_PROFILE).generate(input), x => x.reason === 'CONFIGURATION_REQUIRED'); assert.equal(off, 0);
  assert(Buffer.byteLength(MARCUS_REVIEW_SYSTEM_PROMPT) < 2600, 'the prompt leaves room for the facts');
});

test('the Marcus prompt says the review changes nothing, names are untrusted, budgets are planned, and forbids invented numbers', () => {
  assert.match(MARCUS_REVIEW_SYSTEM_PROMPT, /You create, send, publish and spend nothing/); assert.match(MARCUS_REVIEW_SYSTEM_PROMPT, /Use only the numbers given/);
  assert.match(MARCUS_REVIEW_SYSTEM_PROMPT, /name as untrusted text/); assert.match(MARCUS_REVIEW_SYSTEM_PROMPT, /Planned budget is not money spent/);
  assert.match(MARCUS_REVIEW_SYSTEM_PROMPT, /No links, email addresses, phone numbers or personal data/);
});

test('the brief and the review shape are closed', () => {
  assert.deepEqual(validateMarcusReviewBrief(brief), brief); assert.equal(validateMarcusReviewBrief({ period: 'LAST_90_DAYS', question: '¿Qué campaña funciona?' }).period, 'LAST_90_DAYS');
  for (const bad of [null, {}, { period: 'LAST_YEAR', question: '' }, { period: 'LAST_30_DAYS' }, { ...brief, question: ' padded' }, { ...brief, question: 'x'.repeat(301) }, { ...brief, extra: 1 }, { ...brief, question: 'a​b' }]) {
    assert.throws(() => validateMarcusReviewBrief(bad), JSON.stringify(bad));
  }
  assert.deepEqual(validateMarcusReviewProposal(proposal), proposal);
  for (const bad of [{}, { ...proposal, findings: [] }, { ...proposal, nextSteps: [] }, { ...proposal, findings: Array.from({ length: 7 }, () => f()) },
    { ...proposal, nextSteps: Array.from({ length: 6 }, () => n()) }, { ...proposal, findings: [f({ title: 'x'.repeat(121) })] }, { ...proposal, findings: [f({ detail: 'a\nb' })] },
    { ...proposal, findings: [{ ...f(), area: null }] }, { ...proposal, nextSteps: [n({ area: 'maya' })] }, { ...proposal, nextSteps: [{ title: 'x', detail: 'y' }] },
    { ...proposal, summary: 'x'.repeat(401) }, { ...proposal, extra: 1 }]) {
    assert.throws(() => validateMarcusReviewProposal(bad), JSON.stringify(bad).slice(0, 120));
  }
});

test('a review with a link or an email address is a problem', () => {
  assert.deepEqual(marcusReviewProblems(proposal), []);
  for (const detail of ['See https://example.test', 'Visit www.example.test', 'Write to owner@example.test']) {
    assert.deepEqual(marcusReviewProblems({ ...proposal, nextSteps: [n({ detail })] }), ['The answer holds a link or an email address.']);
    assert.deepEqual(marcusReviewProblems({ ...proposal, findings: [f({ detail })] }), ['The answer holds a link or an email address.']);
  }
});

test('a view shows the review only when recorded', () => {
  const base = { id, status: 'PENDING', reason: null, brief, summary: null, findings: null, nextSteps: null, problems: [], createdAt: '2026-11-22T00:00:00.000Z', updatedAt: '2026-11-22T00:00:00.000Z' };
  assert.equal(verifyMarcusReviewView(base).findings, null);
  assert.deepEqual(verifyMarcusReviewView({ ...base, status: 'RESULT_RECORDED', ...proposal }).nextSteps, proposal.nextSteps);
  assert.throws(() => verifyMarcusReviewView({ ...base, status: 'RESULT_REJECTED', ...proposal }));
  assert.throws(() => verifyMarcusReviewView({ ...base, status: 'DISMISSED', ...proposal }));
  assert.throws(() => verifyMarcusReviewView({ ...base, mine: true }));
  assert.throws(() => verifyMarcusReviewList(Array.from({ length: 21 }, () => base)));
});

const ctx = { organizationId: id, schoolId: id, principalId: id, externalSubject: 'verified-unit-subject', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key };
test('only a direct human with a key and valid input can ask; nothing reaches SQL or the provider otherwise', async () => {
  let touched = 0; const db = { withTenantTransaction: async () => { touched++; throw Error('Unexpected SQL'); }, withTenantReadOnlyTransaction: async () => { touched++; throw Error('Unexpected SQL'); } };
  const svc = new MarcusReviewService(db, {}, { readiness: () => { touched++; }, generate: async () => { touched++; } });
  for (const patch of [{ source: 'AI' }, { principalType: 'AI_EMPLOYEE' }, { delegatedByPrincipalId: id }, { actionRequestId: id }, { externalSubject: '' }]) {
    await assert.rejects(svc.request({ ...ctx, ...patch }, brief), e => e.getStatus?.() === 403);
    await assert.rejects(svc.dismiss({ ...ctx, ...patch }, id), e => e.getStatus?.() === 403);
  }
  await assert.rejects(svc.request({ ...ctx, idempotencyKey: 'not-a-uuid' }, brief), e => e.getStatus?.() === 409);
  for (const bad of [{ ...brief, providerId: 'x' }, { ...brief, period: 'DAY' }]) await assert.rejects(svc.request(ctx, bad), e => e.getStatus?.() === 400 && e.getResponse().code === 'MARCUS_REVIEW_INVALID');
  await assert.rejects(svc.dismiss(ctx, 'not-a-uuid'), e => e.getStatus?.() === 400);
  await assert.rejects(svc.read({ ...ctx, idempotencyKey: '' }, 'not-a-uuid'), e => e.getStatus?.() === 400);
  assert.equal(touched, 0);
});

test('the live module gives Marcus reviews their own runtime profile and no test fake; sources log nothing', () => {
  const module = fs.readFileSync(path.join(__dirname, '../src/app.module.ts'), 'utf8');
  assert.match(module, /provide: MARCUS_REVIEW_PROVIDER_RUNTIME, useFactory: \(\) => new OpenRouterMerchRuntime\(undefined, undefined, MARCUS_REVIEW_TEXT_PROFILE\)/);
  assert.match(module, /MarcusReviewController,/); assert.match(module, /MarcusReviewService,/);
  for (const file of ['src/marcus-review/marcus-review.service.ts', 'src/marcus-review/marcus-review.controller.ts', 'src/marcus-review/marcus-review-provider.ts']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); assert(!/console\.|logger\./.test(src)); assert(!/invokeLLM|generateText|@openrouter/.test(src));
  }
});
