const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const { OpenRouterMerchRuntime, COMMERCE_REVIEW_SYSTEM_PROMPT } = require('../dist/commerce/shopify/merch-provider-runtime.js');
const { MAYA_RENEWAL_TEXT_PROFILE, MAYA_RENEWAL_SYSTEM_PROMPT } = require('../dist/maya-renewal/maya-renewal-provider.js');
const { JORDAN_FOLLOW_UP_SYSTEM_PROMPT } = require('../dist/jordan-follow-through/jordan-follow-up-provider.js');
const { MayaRenewalService } = require('../dist/maya-renewal/maya-renewal.service.js');
const { validateMayaRenewalBrief, validateMayaRenewalProposal, validateMayaRenewalApply, mayaRenewalProblems, verifyMayaRenewalView, verifyMayaRenewalList } = require('@hon/contracts');

const id = '11111111-1111-4111-8111-111111111111', key = '22222222-2222-4222-8222-222222222222';
const env = () => ({ OPENROUTER_API_KEY: 'unit-only-not-a-secret', OPENROUTER_PAID_CALL_APPROVED: 'true' });
const brief = { window: 'NEXT_30_DAYS', note: '' };
const s = (patch = {}) => ({ membership: 'M1', priority: 'HIGH', talkingPoint: 'Ask how the new class time is working for them.', reason: 'Attendance halved in the last month and the term ends in 9 days.', ...patch });
const proposal = { summary: 'Three renewals need a talk this week.', suggestions: [s(), s({ membership: 'M2', priority: 'NORMAL' }), s({ membership: 'M3', priority: 'LOW' })] };
const input = { providerId: 'OPENROUTER', modelId: 'approved/test', providerRequestId: id, request: JSON.stringify({ brief, schoolName: 'Test Dojo', localToday: '2026-11-22', memberships: [] }), inputBudget: 12000, outputBudget: 3000, maxCostMicrounits: 80000 };
const ok = content => ({ model: input.modelId, choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 1500, completion_tokens: 400, cost: 0.0012 } });
const response = v => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
const runtime = transport => new OpenRouterMerchRuntime(env, transport, MAYA_RENEWAL_TEXT_PROFILE);

test('the Maya runtime sends one fixed request with the renewal prompt and budgets', async () => {
  let calls = 0; const rt = runtime(async (url, o) => {
    calls++; assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions'); assert.equal(o.redirect, 'error');
    const body = JSON.parse(o.body); assert.equal(body.max_tokens, 3000); assert.equal(body.temperature, 0.2); assert.equal(body.tools, undefined); assert.equal(body.provider.allow_fallbacks, false);
    assert.equal(body.messages[0].content, MAYA_RENEWAL_SYSTEM_PROMPT); assert.notEqual(body.messages[0].content, JORDAN_FOLLOW_UP_SYSTEM_PROMPT); assert.notEqual(body.messages[0].content, COMMERCE_REVIEW_SYSTEM_PROMPT);
    assert.equal(body.messages[1].content, input.request);
    return response(ok(JSON.stringify(proposal)));
  });
  assert.deepEqual(await rt.generate(input), { proposal, inputTokens: 1500, outputTokens: 400, providerCostMicrounits: 1200 }); assert.equal(calls, 1);
  for (const patch of [{ inputBudget: 9000 }, { outputBudget: 2500 }, { maxCostMicrounits: 150000 }, { modelId: '../x' }, { request: 'x'.repeat(12000) }]) {
    let sent = 0; await assert.rejects(runtime(async () => { sent++; }).generate({ ...input, ...patch }), x => x.outcome === 'PRE_SEND' && x.reason === 'INVALID_REQUEST'); assert.equal(sent, 0);
  }
  let off = 0; await assert.rejects(new OpenRouterMerchRuntime(() => ({ OPENROUTER_API_KEY: 'unit-only' }), async () => { off++; }, MAYA_RENEWAL_TEXT_PROFILE).generate(input), x => x.reason === 'CONFIGURATION_REQUIRED'); assert.equal(off, 0);
  assert(Buffer.byteLength(MAYA_RENEWAL_SYSTEM_PROMPT) < 2500, 'the prompt leaves room for the facts');
});

test('the Maya prompt says suggestions change nothing and forbids invented facts, promised prices and personal data', () => {
  assert.match(MAYA_RENEWAL_SYSTEM_PROMPT, /You create, send, book and change nothing/); assert.match(MAYA_RENEWAL_SYSTEM_PROMPT, /Use only the facts given/);
  assert.match(MAYA_RENEWAL_SYSTEM_PROMPT, /never promise a discount or a price/); assert.match(MAYA_RENEWAL_SYSTEM_PROMPT, /No links, email addresses, phone numbers or personal data/);
});

test('the brief, the suggestion shape and the apply request are closed', () => {
  assert.deepEqual(validateMayaRenewalBrief(brief), brief); assert.equal(validateMayaRenewalBrief({ window: 'NEXT_60_DAYS', note: '여름 방학 전' }).window, 'NEXT_60_DAYS');
  for (const bad of [null, {}, { window: 'NEXT_90_DAYS', note: '' }, { window: 'NEXT_30_DAYS' }, { ...brief, note: ' padded' }, { ...brief, note: 'x'.repeat(301) }, { ...brief, extra: 1 }, { ...brief, note: 'a​b' }]) {
    assert.throws(() => validateMayaRenewalBrief(bad), JSON.stringify(bad));
  }
  assert.deepEqual(validateMayaRenewalProposal(proposal), proposal);
  for (const bad of [{}, { ...proposal, suggestions: [] }, { ...proposal, suggestions: Array.from({ length: 11 }, (_, n) => s({ membership: `M${n + 1}` })) },
    { ...proposal, suggestions: [s(), s()] }, { ...proposal, suggestions: [s({ membership: 'M31' })] }, { ...proposal, suggestions: [s({ membership: 'W1' })] },
    { ...proposal, suggestions: [s({ priority: 'URGENT' })] }, { ...proposal, suggestions: [s({ talkingPoint: '' })] }, { ...proposal, suggestions: [s({ talkingPoint: 'x'.repeat(301) })] },
    { ...proposal, suggestions: [{ ...s(), membershipId: id }] }, { ...proposal, suggestions: [s({ reason: 'line one\nline two' })] }, { ...proposal, summary: 'x'.repeat(301) }]) {
    assert.throws(() => validateMayaRenewalProposal(bad), JSON.stringify(bad).slice(0, 120));
  }
  assert.deepEqual(validateMayaRenewalApply({ suggestions: [0, 9] }), { suggestions: [0, 9] });
  for (const bad of [{}, { suggestions: [] }, { suggestions: [0, 0] }, { suggestions: [10] }, { suggestions: [-1] }, { suggestions: ['0'] }, { suggestions: [0], extra: 1 }]) assert.throws(() => validateMayaRenewalApply(bad), JSON.stringify(bad));
});

test('suggestions with a link or an email address are a problem', () => {
  assert.deepEqual(mayaRenewalProblems(proposal), []);
  for (const talkingPoint of ['See https://example.test', 'Visit www.example.test', 'Write to owner@example.test']) {
    assert.deepEqual(mayaRenewalProblems({ ...proposal, suggestions: [s({ talkingPoint })] }), ['The answer holds a link or an email address.']);
  }
});

test('a view shows suggestions only when recorded or applied, and applied rows only once applied', () => {
  const base = { id, status: 'PENDING', reason: null, brief, summary: null, suggestions: null, memberships: [], applied: [], problems: [], createdAt: '2026-11-22T00:00:00.000Z', updatedAt: '2026-11-22T00:00:00.000Z' };
  assert.equal(verifyMayaRenewalView(base).suggestions, null);
  const memberships = [{ ref: 'M1', membershipId: key, name: 'Sample Student', termEndsOn: '2026-12-01' }];
  assert.deepEqual(verifyMayaRenewalView({ ...base, status: 'RESULT_RECORDED', ...proposal, memberships }).memberships, memberships);
  assert.deepEqual(verifyMayaRenewalView({ ...base, status: 'APPLIED', ...proposal, applied: [{ index: 0, renewalId: key }] }).applied, [{ index: 0, renewalId: key }]);
  assert.throws(() => verifyMayaRenewalView({ ...base, status: 'RESULT_RECORDED', ...proposal, applied: [{ index: 0, renewalId: key }] }));
  assert.throws(() => verifyMayaRenewalView({ ...base, status: 'RESULT_REJECTED', ...proposal }));
  assert.throws(() => verifyMayaRenewalView({ ...base, memberships: [{ ...memberships[0], termEndsOn: '1 Dec' }] }));
  assert.throws(() => verifyMayaRenewalView({ ...base, memberships: [{ ...memberships[0], ref: 'S1' }] }));
  assert.throws(() => verifyMayaRenewalView({ ...base, extra: 1 }));
  assert.throws(() => verifyMayaRenewalList(Array.from({ length: 21 }, () => base)));
});

const ctx = { organizationId: id, schoolId: id, principalId: id, externalSubject: 'verified-unit-subject', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key };
test('only a direct human with a key and valid input can ask or apply; nothing reaches SQL or the provider otherwise', async () => {
  let touched = 0; const db = { withTenantTransaction: async () => { touched++; throw Error('Unexpected SQL'); }, withTenantReadOnlyTransaction: async () => { touched++; throw Error('Unexpected SQL'); } };
  const svc = new MayaRenewalService(db, {}, { readiness: () => { touched++; }, generate: async () => { touched++; } });
  for (const patch of [{ source: 'AI' }, { principalType: 'AI_EMPLOYEE' }, { delegatedByPrincipalId: id }, { actionRequestId: id }, { externalSubject: '' }]) {
    await assert.rejects(svc.request({ ...ctx, ...patch }, brief), e => e.getStatus?.() === 403);
    await assert.rejects(svc.apply({ ...ctx, ...patch }, id, { suggestions: [0] }), e => e.getStatus?.() === 403);
  }
  await assert.rejects(svc.request({ ...ctx, idempotencyKey: 'not-a-uuid' }, brief), e => e.getStatus?.() === 409);
  await assert.rejects(svc.apply({ ...ctx, idempotencyKey: '' }, id, { suggestions: [0] }), e => e.getStatus?.() === 409);
  for (const bad of [{ ...brief, providerId: 'x' }, { ...brief, window: 'TODAY' }]) await assert.rejects(svc.request(ctx, bad), e => e.getStatus?.() === 400 && e.getResponse().code === 'MAYA_RENEWAL_INVALID');
  await assert.rejects(svc.apply(ctx, id, { suggestions: [10] }), e => e.getStatus?.() === 400);
  await assert.rejects(svc.apply(ctx, 'not-a-uuid', { suggestions: [0] }), e => e.getStatus?.() === 400);
  await assert.rejects(svc.read({ ...ctx, idempotencyKey: '' }, 'not-a-uuid'), e => e.getStatus?.() === 400);
  assert.equal(touched, 0);
});

test('database refusals map to plain answers that say nothing was applied', async () => {
  const fail = (code, message) => ({ withTenantTransaction: async () => { throw Object.assign(new Error(message), { code }); } });
  const cases = [['40001', 'VERSION_CONFLICT', 409, 'MAYA_RENEWAL_MEMBERSHIP_CHANGED'], ['P0002', 'MEMBERSHIP_UNAVAILABLE', 409, 'MAYA_RENEWAL_MEMBERSHIP_CHANGED'],
    ['40001', 'MAYA_RENEWAL_REVIEW_OPEN', 409, 'MAYA_RENEWAL_REVIEW_OPEN'], ['42501', 'MAYA_AT_RISK_FORBIDDEN', 403, 'MAYA_RENEWAL_FORBIDDEN'], ['42501', 'RENEWAL_FORBIDDEN', 403, 'MAYA_RENEWAL_FORBIDDEN'],
    ['42501', 'AI_SCHOOL_CEILING_REACHED', 403, 'MAYA_RENEWAL_SPEND_STOPPED'], ['40001', 'AI_TEXT_PROPOSAL_NOT_OPEN', 409, 'MAYA_RENEWAL_NOT_OPEN']];
  for (const [code, message, status, out] of cases) {
    const svc = new MayaRenewalService(fail(code, message), {}, { readiness: () => 'READY' });
    await assert.rejects(svc.apply(ctx, id, { suggestions: [0] }), e => e.getStatus?.() === status && e.getResponse().code === out, message);
  }
});

test('the live module gives Maya its own runtime profile and no test fake; sources log nothing', () => {
  const module = fs.readFileSync(path.join(__dirname, '../src/app.module.ts'), 'utf8');
  assert.match(module, /provide: MAYA_RENEWAL_PROVIDER_RUNTIME, useFactory: \(\) => new OpenRouterMerchRuntime\(undefined, undefined, MAYA_RENEWAL_TEXT_PROFILE\)/);
  assert.match(module, /MayaRenewalController,/); assert.match(module, /MayaRenewalService,/);
  for (const file of ['src/maya-renewal/maya-renewal.service.ts', 'src/maya-renewal/maya-renewal.controller.ts', 'src/maya-renewal/maya-renewal-provider.ts']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); assert(!/console\.|logger\./.test(src)); assert(!/invokeLLM|generateText|@openrouter/.test(src));
  }
});
