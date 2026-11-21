const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const { OpenRouterMerchRuntime, COMMERCE_REVIEW_TEXT_PROFILE, COMMERCE_REVIEW_SYSTEM_PROMPT, MERCH_SYSTEM_PROMPT } = require('../dist/commerce/shopify/merch-provider-runtime.js');
const { CommerceReviewService } = require('../dist/commerce/shopify/commerce-review.service.js');
const { validateCommerceReviewBrief, validateCommerceReviewProposal, commerceReviewProblems, verifyCommerceReviewView, verifyCommerceReviewList } = require('@hon/contracts');

const id = '11111111-1111-4111-8111-111111111111', key = '22222222-2222-4222-8222-222222222222';
const env = () => ({ OPENROUTER_API_KEY: 'unit-only-not-a-secret', OPENROUTER_PAID_CALL_APPROVED: 'true' });
const brief = { focus: 'PRICING', question: 'Which prices look too low?' };
const point = (area, patch = {}) => ({ area, title: `${area} point`, detail: 'Two orders in the last 30 days.', ...patch });
const proposal = { summary: 'A quiet month with thin margins on uniforms.', findings: [point('SALES'), point('PRICING')], recommendations: [point('PRICING', { title: 'Look at the uniform price' })] };
const input = { providerId: 'OPENROUTER', modelId: 'approved/test', providerRequestId: id, request: JSON.stringify({ brief, schoolName: 'Test Dojo', currency: 'USD', last30Days: {}, catalog: {}, frontDesk: {} }), inputBudget: 9000, outputBudget: 2500, maxCostMicrounits: 80000 };
const ok = content => ({ model: input.modelId, choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 900, completion_tokens: 300, cost: 0.0009 } });
const response = v => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
const runtime = transport => new OpenRouterMerchRuntime(env, transport, COMMERCE_REVIEW_TEXT_PROFILE);

test('the review runtime sends one fixed request with the COMMERCE_REVIEW prompt and budgets', async () => {
  let calls = 0; const rt = runtime(async (url, o) => {
    calls++; assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions'); assert.equal(o.redirect, 'error');
    const body = JSON.parse(o.body); assert.equal(body.max_tokens, 2500); assert.equal(body.temperature, 0.2); assert.equal(body.tools, undefined); assert.equal(body.provider.allow_fallbacks, false);
    assert.equal(body.messages[0].content, COMMERCE_REVIEW_SYSTEM_PROMPT); assert.notEqual(body.messages[0].content, MERCH_SYSTEM_PROMPT); assert.equal(body.messages[1].content, input.request);
    return response(ok(JSON.stringify(proposal)));
  });
  assert.deepEqual(await rt.generate(input), { proposal, inputTokens: 900, outputTokens: 300, providerCostMicrounits: 900 }); assert.equal(calls, 1);
  // The merch budgets, another model shape or a request that cannot fit are refused before anything is sent.
  for (const patch of [{ inputBudget: 6000 }, { outputBudget: 3000 }, { maxCostMicrounits: 150000 }, { modelId: '../x' }, { request: 'x'.repeat(9000) }]) {
    let sent = 0; await assert.rejects(runtime(async () => { sent++; }).generate({ ...input, ...patch }), x => x.outcome === 'PRE_SEND' && x.reason === 'INVALID_REQUEST'); assert.equal(sent, 0);
  }
  // The merch runtime keeps its own prompt and budgets.
  let merchSent = 0; await assert.rejects(new OpenRouterMerchRuntime(env, async () => { merchSent++; }).generate(input), x => x.reason === 'INVALID_REQUEST'); assert.equal(merchSent, 0);
  assert(Buffer.byteLength(COMMERCE_REVIEW_SYSTEM_PROMPT) < 2500, 'the prompt leaves room for about 6 KB of facts');
});

test('the review prompt forbids invented numbers and says the review changes nothing', () => {
  assert.match(COMMERCE_REVIEW_SYSTEM_PROMPT, /Use only the numbers given/); assert.match(COMMERCE_REVIEW_SYSTEM_PROMPT, /you change nothing/);
  assert.match(COMMERCE_REVIEW_SYSTEM_PROMPT, /untrusted text/); assert.match(COMMERCE_REVIEW_SYSTEM_PROMPT, /No links, email addresses, phone numbers or personal data/);
});

test('the brief and the review shape are closed', () => {
  assert.deepEqual(validateCommerceReviewBrief(brief), brief); assert.deepEqual(validateCommerceReviewBrief({ focus: 'OVERVIEW', question: '' }), { focus: 'OVERVIEW', question: '' });
  for (const bad of [null, { focus: 'CUSTOMERS', question: '' }, { focus: 'STOCK' }, { ...brief, question: ' padded' }, { ...brief, question: 'password: x' }, { ...brief, question: 'x'.repeat(301) }, { ...brief, schoolId: id }]) assert.throws(() => validateCommerceReviewBrief(bad));
  assert.deepEqual(validateCommerceReviewProposal(proposal), proposal);
  assert.deepEqual(validateCommerceReviewProposal({ ...proposal, recommendations: [] }).recommendations, []);
  const six = Array.from({ length: 6 }, () => point('SALES'));
  for (const bad of [{}, { ...proposal, findings: [] }, { ...proposal, findings: six }, { ...proposal, recommendations: six }, { ...proposal, findings: [point('CUSTOMERS')] },
    { ...proposal, findings: [{ ...point('SALES'), productId: 1 }] }, { ...proposal, findings: [point('SALES', { title: 'Bearer abc.def' })] }, { ...proposal, summary: 'x'.repeat(600) }, { ...proposal, action: 'SET_PRICE' }]) assert.throws(() => validateCommerceReviewProposal(bad));
});

test('a review with a link or an email address is a problem', () => {
  assert.deepEqual(commerceReviewProblems(proposal), []);
  for (const detail of ['See https://example.test', 'Visit www.example.test', 'Write to owner@example.test']) {
    assert.deepEqual(commerceReviewProblems({ ...proposal, recommendations: [point('PRODUCTS', { detail })] }), ['The answer holds a link or an email address.']);
  }
});

test('a view shows the review only when it was recorded or marked reviewed', () => {
  const base = { id, status: 'PENDING', reason: null, brief, mine: true, summary: null, findings: null, recommendations: null, problems: [], createdAt: '2026-11-21T00:00:00.000Z', updatedAt: '2026-11-21T00:00:00.000Z' };
  assert.equal(verifyCommerceReviewView(base).findings, null);
  assert.deepEqual(verifyCommerceReviewView({ ...base, status: 'APPLIED', ...proposal }).recommendations, proposal.recommendations);
  assert.throws(() => verifyCommerceReviewView({ ...base, status: 'RESULT_REJECTED', ...proposal }));
  assert.throws(() => verifyCommerceReviewView({ ...base, extra: 1 }));
  assert.throws(() => verifyCommerceReviewList(Array.from({ length: 11 }, () => base)));
});

const ctx = { organizationId: id, schoolId: id, principalId: id, externalSubject: 'verified-unit-subject', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key };
test('only a direct human with a UUID key and a valid brief can ask; nothing reaches SQL or the provider otherwise', async () => {
  let touched = 0; const db = { withTenantTransaction: async () => { touched++; throw Error('Unexpected SQL'); }, withTenantReadOnlyTransaction: async () => { touched++; throw Error('Unexpected SQL'); } };
  const svc = new CommerceReviewService(db, {}, { readiness: () => { touched++; }, generate: async () => { touched++; } });
  for (const patch of [{ source: 'AI' }, { principalType: 'AI_EMPLOYEE' }, { delegatedByPrincipalId: id }, { actionRequestId: id }, { externalSubject: '' }]) await assert.rejects(svc.request({ ...ctx, ...patch }, brief), e => e.getStatus?.() === 403);
  await assert.rejects(svc.request({ ...ctx, idempotencyKey: 'not-a-uuid' }, brief), e => e.getStatus?.() === 409);
  for (const bad of [{ ...brief, providerId: 'x' }, { ...brief, focus: 'CUSTOMERS' }]) await assert.rejects(svc.request(ctx, bad), e => e.getStatus?.() === 400 && e.getResponse().code === 'SHOPIFY_REVIEW_INVALID');
  await assert.rejects(svc.close(ctx, id, 'RESULT_RECORDED'), e => e.getStatus?.() === 400);
  await assert.rejects(svc.read(ctx, 'not-a-uuid'), e => e.getStatus?.() === 400 || e.getStatus?.() === 404);
  assert.equal(touched, 0);
});

test('the live module gives the review its own runtime profile and no test fake; sources log nothing', () => {
  const module = fs.readFileSync(path.join(__dirname, '../src/app.module.ts'), 'utf8');
  assert.match(module, /provide: COMMERCE_REVIEW_PROVIDER_RUNTIME, useFactory: \(\) => new OpenRouterMerchRuntime\(undefined, undefined, COMMERCE_REVIEW_TEXT_PROFILE\)/);
  assert.match(module, /provide: MERCH_PROVIDER_RUNTIME, useFactory: \(\) => new OpenRouterMerchRuntime\(\)/);
  for (const file of ['src/commerce/shopify/commerce-review.service.ts', 'src/commerce/shopify/commerce-review.controller.ts']) {
    const s = fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); assert(!/console\.|logger\./.test(s)); assert(!/invokeLLM|generateText|@openrouter/.test(s));
  }
});
