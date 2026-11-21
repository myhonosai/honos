const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const { OpenRouterMerchRuntime, MerchProviderRuntimeError, MERCH_SYSTEM_PROMPT } = require('../dist/commerce/shopify/merch-provider-runtime.js');
const { MerchAiService } = require('../dist/commerce/shopify/merch-ai.service.js');
const { validateMerchAiBrief, validateMerchAiProposal, merchAiProblems, verifyMerchAiView, MERCH_AI_PRICE } = require('@hon/contracts');

const id = '11111111-1111-4111-8111-111111111111', key = '22222222-2222-4222-8222-222222222222';
const env = () => ({ OPENROUTER_API_KEY: 'unit-only-not-a-secret', OPENROUTER_PAID_CALL_APPROVED: 'true' });
const brief = { kind: 'HOODIE', styles: ['MINIMAL', 'ATHLETIC'], colors: ['black', 'red'], notes: 'For the spring tournament.' };
const idea = (style, patch = {}) => ({ style, title: `${style} hoodie`, description: 'A warm hoodie with the school mark.', productType: 'Hoodie', price: '50.00', printNotes: 'One-color front print.', ...patch });
const proposal = { summary: 'Two looks for the tournament.', ideas: [idea('MINIMAL'), idea('ATHLETIC', { price: null })] };
const input = { providerId: 'OPENROUTER', modelId: 'approved/test', providerRequestId: id, request: JSON.stringify({ brief, schoolName: 'Test Dojo', currency: 'USD', brandColor: null, existingProducts: [] }), inputBudget: 6000, outputBudget: 3000, maxCostMicrounits: 80000 };
const ok = (content, extra = {}) => ({ model: input.modelId, choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 700, completion_tokens: 300, cost: 0.0009 }, ...extra });
const response = v => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('merch runtime needs the key and the paid-call approval, and sends nothing otherwise', async () => {
  for (const e of [{}, { OPENROUTER_PAID_CALL_APPROVED: 'true' }, { OPENROUTER_API_KEY: 'unit-only-not-a-secret' }]) {
    let calls = 0; const rt = new OpenRouterMerchRuntime(() => e, async () => { calls++; throw Error('NO NETWORK'); });
    assert.equal(rt.readiness('OPENROUTER'), 'CONFIGURATION_REQUIRED');
    await assert.rejects(rt.generate(input), x => x.outcome === 'PRE_SEND' && x.reason === 'CONFIGURATION_REQUIRED'); assert.equal(calls, 0);
  }
  assert.equal(new OpenRouterMerchRuntime(env).readiness('OTHER'), 'UNSUPPORTED_PROVIDER');
});

test('merch runtime sends one fixed request with the MERCH_IDEAS budgets and returns usage with the parsed answer', async () => {
  let calls = 0; const rt = new OpenRouterMerchRuntime(env, async (url, o) => {
    calls++; assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions'); assert.equal(o.redirect, 'error'); assert.equal(o.headers['Idempotency-Key'], id);
    const body = JSON.parse(o.body); assert.equal(body.max_tokens, 3000); assert.equal(body.provider.allow_fallbacks, false); assert.equal(body.tools, undefined);
    assert.equal(body.messages[0].content, MERCH_SYSTEM_PROMPT); assert.equal(body.messages[1].content, input.request);
    return response(ok(JSON.stringify(proposal)));
  });
  assert.deepEqual(await rt.generate(input), { proposal, inputTokens: 700, outputTokens: 300, providerCostMicrounits: 900 }); assert.equal(calls, 1);
  for (const patch of [{ inputBudget: 16000 }, { outputBudget: 4000 }, { maxCostMicrounits: 150000 }, { modelId: '../x' }, { request: 'x'.repeat(6000) }]) {
    let sent = 0; await assert.rejects(new OpenRouterMerchRuntime(env, async () => { sent++; }).generate({ ...input, ...patch }), x => x.outcome === 'PRE_SEND' && x.reason === 'INVALID_REQUEST'); assert.equal(sent, 0);
  }
});

test('a paid merch answer that is not JSON keeps its usage (proposal null); transport doubt is UNKNOWN; refusals are FAILED', async () => {
  const out = await new OpenRouterMerchRuntime(env, async () => response(ok('not json'))).generate(input);
  assert.equal(out.proposal, null); assert.equal(out.inputTokens, 700);
  for (const t of [async () => { throw Error('socket'); }, async () => new Response('x', { status: 503 }), async () => response(ok('{}', { model: 'swapped' }))]) {
    await assert.rejects(new OpenRouterMerchRuntime(env, t).generate(input), x => x instanceof MerchProviderRuntimeError && x.outcome === 'UNKNOWN');
  }
  await assert.rejects(new OpenRouterMerchRuntime(env, async () => new Response('', { status: 429 })).generate(input), x => x.outcome === 'FAILED' && x.reason === 'PROVIDER_REJECTED');
});

test('the brief and the idea shape are closed, and the price is a plain Shopify amount', () => {
  assert.deepEqual(validateMerchAiBrief(brief), brief);
  for (const bad of [null, { ...brief, styles: [] }, { ...brief, styles: ['MINIMAL', 'MINIMAL'] }, { ...brief, styles: ['MINIMAL', 'ATHLETIC', 'CLASSIC', 'PREMIUM'] }, { ...brief, kind: 'CAR' },
    { ...brief, colors: ['Black', 'black'] }, { ...brief, colors: [' red'] }, { ...brief, notes: 'password: x' }, { ...brief, notes: 'x'.repeat(501) }, { ...brief, schoolId: id }]) assert.throws(() => validateMerchAiBrief(bad));
  assert.deepEqual(validateMerchAiProposal(proposal), proposal);
  for (const bad of [{}, { summary: 'x', ideas: [] }, { summary: 'x', ideas: [idea('MINIMAL'), idea('ATHLETIC'), idea('CLASSIC'), idea('PREMIUM')] }, { summary: 'x', ideas: [{ ...idea('MINIMAL'), imageUrl: 'https://x' }] },
    { summary: 'x', ideas: [idea('MINIMAL', { price: '$50' })] }, { summary: 'x', ideas: [idea('MINIMAL', { title: 'Bearer abc.def' })] }, { summary: 'x', ideas: [idea('NEON')] }]) assert.throws(() => validateMerchAiProposal(bad));
  for (const p of ['0', '5', '49.99', '999999']) assert.match(p, MERCH_AI_PRICE);
  for (const p of ['05', '1.5', '1000000', '-1', '1e3']) assert.doesNotMatch(p, MERCH_AI_PRICE);
});

test('problems name what does not fit the brief: a look not asked for, a repeated look, a count mismatch, a price outside a USD store', () => {
  assert.deepEqual(merchAiProblems(proposal, brief, 'USD'), []);
  assert.deepEqual(merchAiProblems(proposal, brief, 'CAD'), ['Idea 1 has a price, but the store does not use US dollars.']);
  assert.deepEqual(merchAiProblems({ summary: 's', ideas: [idea('STREETWEAR', { price: null }), idea('STREETWEAR', { price: null })] }, brief, 'USD'),
    ['Idea 1 uses a look that was not asked for.', 'Idea 2 uses a look that was not asked for.', 'Two ideas use the same look.']);
  assert.deepEqual(merchAiProblems({ summary: 's', ideas: [idea('MINIMAL')] }, brief, 'USD'), ['The answer has 1 ideas for 2 looks.']);
});

test('a view shows ideas only when they are open to use', () => {
  const base = { id, status: 'PENDING', reason: null, brief, mine: true, summary: null, ideas: null, problems: [], createdAt: '2026-11-18T00:00:00.000Z', updatedAt: '2026-11-18T00:00:00.000Z' };
  assert.equal(verifyMerchAiView(base).ideas, null);
  assert.deepEqual(verifyMerchAiView({ ...base, status: 'RESULT_RECORDED', ...proposal }).ideas, proposal.ideas);
  assert.throws(() => verifyMerchAiView({ ...base, status: 'RESULT_REJECTED', ...proposal }));
  assert.throws(() => verifyMerchAiView({ ...base, extra: 1 }));
});

const ctx = { organizationId: id, schoolId: id, principalId: id, externalSubject: 'verified-unit-subject', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key };
test('only a direct human with a UUID key and a valid brief can ask; nothing reaches SQL or the provider otherwise', async () => {
  let touched = 0; const db = { withTenantTransaction: async () => { touched++; throw Error('Unexpected SQL'); }, withTenantReadOnlyTransaction: async () => { touched++; throw Error('Unexpected SQL'); } };
  const svc = new MerchAiService(db, {}, { readiness: () => { touched++; }, generate: async () => { touched++; } });
  for (const patch of [{ source: 'AI' }, { principalType: 'AI_EMPLOYEE' }, { delegatedByPrincipalId: id }, { actionRequestId: id }, { externalSubject: '' }]) await assert.rejects(svc.request({ ...ctx, ...patch }, brief), e => e.getStatus?.() === 403);
  await assert.rejects(svc.request({ ...ctx, idempotencyKey: 'not-a-uuid' }, brief), e => e.getStatus?.() === 409);
  for (const bad of [{ ...brief, providerId: 'x' }, { ...brief, styles: [] }]) await assert.rejects(svc.request(ctx, bad), e => e.getStatus?.() === 400 && e.getResponse().code === 'SHOPIFY_MERCH_AI_INVALID');
  await assert.rejects(svc.close(ctx, id, 'RESULT_RECORDED'), e => e.getStatus?.() === 400);
  await assert.rejects(svc.read(ctx, 'not-a-uuid'), e => e.getStatus?.() === 400 || e.getStatus?.() === 404);
  assert.equal(touched, 0);
});

test('the live module uses the OpenRouter merch runtime and no test fake; sources log nothing', () => {
  const module = fs.readFileSync(path.join(__dirname, '../src/app.module.ts'), 'utf8');
  assert.match(module, /provide: MERCH_PROVIDER_RUNTIME, useFactory: \(\) => new OpenRouterMerchRuntime\(\)/);
  for (const file of ['src/commerce/shopify/merch-provider-runtime.ts', 'src/commerce/shopify/merch-ai.service.ts', 'src/commerce/shopify/merch-ai.controller.ts']) {
    const s = fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); assert(!/console\.|logger\./.test(s)); assert(!/invokeLLM|generateText|@openrouter/.test(s));
  }
});
