const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const { OpenRouterMerchRuntime } = require('../dist/commerce/shopify/merch-provider-runtime.js');
const { CLAIRE_KPI_TEXT_PROFILE, CLAIRE_KPI_SYSTEM_PROMPT } = require('../dist/claire-kpi/claire-kpi-provider.js');
const { MARCUS_REVIEW_SYSTEM_PROMPT } = require('../dist/marcus-review/marcus-review-provider.js');
const { ClaireKpiService } = require('../dist/claire-kpi/claire-kpi.service.js');
const { CLAIRE_KPI_CODES, validateClaireKpiBrief, validateClaireKpiProposal, claireKpiProblems, verifyClaireKpiView, verifyClaireKpiList, verifyClaireKpiNumbers } = require('@hon/contracts');

const id = '11111111-1111-4111-8111-111111111111', key = '22222222-2222-4222-8222-222222222222';
const env = () => ({ OPENROUTER_API_KEY: 'unit-only-not-a-secret', OPENROUTER_PAID_CALL_APPROVED: 'true' });
const brief = { period: 'LAST_7_DAYS', focus: '' };
const it = (patch = {}) => ({ title: 'Leads are up', detail: 'Twelve new leads against eight the week before.', ...patch });
const proposal = { summary: 'A busier week with more leads and steady attendance.', notes: [{ kpi: 'NEW_LEADS', note: 'Up from 8 to 12.' }, { kpi: 'CLASSES_ATTENDED', note: 'Flat.' }], watch: [it({ title: 'Two memberships ended' })], actions: [it({ title: 'Call new leads' })] };
const kpis = CLAIRE_KPI_CODES.map((kpi, n) => ({ kpi, current: n, previous: kpi === 'ACTIVE_MEMBERSHIPS' ? null : n + 1 }));
const input = { providerId: 'OPENROUTER', modelId: 'approved/test', providerRequestId: id, request: JSON.stringify({ brief, schoolName: 'Test Dojo', localToday: '2026-11-22', windowDays: 7, kpis, commandCenter: {} }), inputBudget: 12000, outputBudget: 3000, maxCostMicrounits: 80000 };
const ok = content => ({ model: input.modelId, choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 1500, completion_tokens: 400, cost: 0.0012 } });
const response = v => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
const runtime = transport => new OpenRouterMerchRuntime(env, transport, CLAIRE_KPI_TEXT_PROFILE);

test('the Claire KPI runtime sends one fixed request with the Claire prompt and budgets', async () => {
  let calls = 0; const rt = runtime(async (url, o) => {
    calls++; assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions'); assert.equal(o.redirect, 'error');
    const body = JSON.parse(o.body); assert.equal(body.max_tokens, 3000); assert.equal(body.temperature, 0.2); assert.equal(body.tools, undefined); assert.equal(body.provider.allow_fallbacks, false);
    assert.equal(body.messages[0].content, CLAIRE_KPI_SYSTEM_PROMPT); assert.notEqual(body.messages[0].content, MARCUS_REVIEW_SYSTEM_PROMPT);
    assert.equal(body.messages[1].content, input.request);
    return response(ok(JSON.stringify(proposal)));
  });
  assert.deepEqual(await rt.generate(input), { proposal, inputTokens: 1500, outputTokens: 400, providerCostMicrounits: 1200 }); assert.equal(calls, 1);
  for (const patch of [{ inputBudget: 9000 }, { outputBudget: 2500 }, { maxCostMicrounits: 150000 }, { modelId: '../x' }, { request: 'x'.repeat(12000) }]) {
    let sent = 0; await assert.rejects(runtime(async () => { sent++; }).generate({ ...input, ...patch }), x => x.outcome === 'PRE_SEND' && x.reason === 'INVALID_REQUEST'); assert.equal(sent, 0);
  }
  let off = 0; await assert.rejects(new OpenRouterMerchRuntime(() => ({ OPENROUTER_API_KEY: 'unit-only' }), async () => { off++; }, CLAIRE_KPI_TEXT_PROFILE).generate(input), x => x.reason === 'CONFIGURATION_REQUIRED'); assert.equal(off, 0);
  assert(Buffer.byteLength(CLAIRE_KPI_SYSTEM_PROMPT) < 2700, 'the prompt leaves room for the facts');
});

test('the Claire prompt says the report changes nothing, the focus is untrusted, and forbids invented numbers', () => {
  assert.match(CLAIRE_KPI_SYSTEM_PROMPT, /You create, send and change nothing/); assert.match(CLAIRE_KPI_SYSTEM_PROMPT, /Use only the numbers given/);
  assert.match(CLAIRE_KPI_SYSTEM_PROMPT, /untrusted text/); assert.match(CLAIRE_KPI_SYSTEM_PROMPT, /must not be guessed/);
  assert.match(CLAIRE_KPI_SYSTEM_PROMPT, /No links, email addresses, phone numbers or personal data/);
});

test('the brief, the report shape and the counted numbers are closed', () => {
  assert.deepEqual(validateClaireKpiBrief(brief), brief); assert.equal(validateClaireKpiBrief({ period: 'LAST_30_DAYS', focus: 'Retención' }).period, 'LAST_30_DAYS');
  for (const bad of [null, {}, { period: 'LAST_90_DAYS', focus: '' }, { period: 'LAST_7_DAYS' }, { ...brief, focus: ' padded' }, { ...brief, focus: 'x'.repeat(301) }, { ...brief, extra: 1 }]) {
    assert.throws(() => validateClaireKpiBrief(bad), JSON.stringify(bad));
  }
  assert.deepEqual(validateClaireKpiProposal(proposal), proposal);
  assert.deepEqual(validateClaireKpiProposal({ ...proposal, watch: [] }).watch, []);
  for (const bad of [{}, { ...proposal, notes: [] }, { ...proposal, actions: [] }, { ...proposal, notes: [{ kpi: 'REVENUE', note: 'x' }] },
    { ...proposal, notes: [{ kpi: 'NEW_LEADS', note: 'a' }, { kpi: 'NEW_LEADS', note: 'b' }] }, { ...proposal, watch: Array.from({ length: 5 }, () => it()) },
    { ...proposal, actions: [it({ detail: 'a\nb' })] }, { ...proposal, summary: 'x'.repeat(401) }, { ...proposal, extra: 1 }, { ...proposal, notes: [{ kpi: 'NEW_LEADS', note: 'x'.repeat(201) }] }]) {
    assert.throws(() => validateClaireKpiProposal(bad), JSON.stringify(bad).slice(0, 120));
  }
  assert.deepEqual(verifyClaireKpiNumbers(kpis), kpis); assert.deepEqual(verifyClaireKpiNumbers([]), []);
  assert.throws(() => verifyClaireKpiNumbers(kpis.slice(1))); assert.throws(() => verifyClaireKpiNumbers([...kpis].reverse()));
  assert.throws(() => verifyClaireKpiNumbers(kpis.map(k => ({ ...k, current: -1 })))); assert.throws(() => verifyClaireKpiNumbers(kpis.map(k => ({ ...k, previous: null }))));
});

test('a report with a link or an email address is a problem', () => {
  assert.deepEqual(claireKpiProblems(proposal), []);
  for (const detail of ['See https://example.test', 'Visit www.example.test', 'Write to owner@example.test']) {
    assert.deepEqual(claireKpiProblems({ ...proposal, actions: [it({ detail })] }), ['The answer holds a link or an email address.']);
    assert.deepEqual(claireKpiProblems({ ...proposal, notes: [{ kpi: 'NEW_LEADS', note: detail }] }), ['The answer holds a link or an email address.']);
  }
});

test('a view shows Claire’s text only when recorded, and always with its counted numbers', () => {
  const base = { id, status: 'PENDING', reason: null, brief, kpis: [], summary: null, notes: null, watch: null, actions: null, problems: [], createdAt: '2026-11-22T00:00:00.000Z', updatedAt: '2026-11-22T00:00:00.000Z' };
  assert.equal(verifyClaireKpiView(base).notes, null);
  assert.deepEqual(verifyClaireKpiView({ ...base, status: 'RESULT_RECORDED', kpis, ...proposal }).kpis, kpis);
  assert.throws(() => verifyClaireKpiView({ ...base, status: 'RESULT_RECORDED', ...proposal }), 'a recorded report has its numbers');
  assert.throws(() => verifyClaireKpiView({ ...base, status: 'RESULT_REJECTED', kpis, ...proposal }));
  assert.throws(() => verifyClaireKpiView({ ...base, mine: true }));
  assert.throws(() => verifyClaireKpiList(Array.from({ length: 21 }, () => base)));
});

const ctx = { organizationId: id, schoolId: id, principalId: id, externalSubject: 'verified-unit-subject', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key };
test('only a direct human with a key and valid input can ask; nothing reaches SQL or the provider otherwise', async () => {
  let touched = 0; const db = { withTenantTransaction: async () => { touched++; throw Error('Unexpected SQL'); }, withTenantReadOnlyTransaction: async () => { touched++; throw Error('Unexpected SQL'); } };
  const svc = new ClaireKpiService(db, {}, { readiness: () => { touched++; }, generate: async () => { touched++; } });
  for (const patch of [{ source: 'AI' }, { principalType: 'AI_EMPLOYEE' }, { delegatedByPrincipalId: id }, { actionRequestId: id }, { externalSubject: '' }]) {
    await assert.rejects(svc.request({ ...ctx, ...patch }, brief), e => e.getStatus?.() === 403);
    await assert.rejects(svc.dismiss({ ...ctx, ...patch }, id), e => e.getStatus?.() === 403);
  }
  await assert.rejects(svc.request({ ...ctx, idempotencyKey: 'not-a-uuid' }, brief), e => e.getStatus?.() === 409);
  for (const bad of [{ ...brief, providerId: 'x' }, { ...brief, period: 'DAY' }]) await assert.rejects(svc.request(ctx, bad), e => e.getStatus?.() === 400 && e.getResponse().code === 'CLAIRE_KPI_INVALID');
  await assert.rejects(svc.dismiss(ctx, 'not-a-uuid'), e => e.getStatus?.() === 400);
  await assert.rejects(svc.read({ ...ctx, idempotencyKey: '' }, 'not-a-uuid'), e => e.getStatus?.() === 400);
  assert.equal(touched, 0);
});

test('the live module gives Claire KPI reports their own runtime profile and no test fake; sources log nothing', () => {
  const module = fs.readFileSync(path.join(__dirname, '../src/app.module.ts'), 'utf8');
  assert.match(module, /provide: CLAIRE_KPI_PROVIDER_RUNTIME, useFactory: \(\) => new OpenRouterMerchRuntime\(undefined, undefined, CLAIRE_KPI_TEXT_PROFILE\)/);
  assert.match(module, /ClaireKpiController,/); assert.match(module, /ClaireKpiService,/);
  for (const file of ['src/claire-kpi/claire-kpi.service.ts', 'src/claire-kpi/claire-kpi.controller.ts', 'src/claire-kpi/claire-kpi-provider.ts']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); assert(!/console\.|logger\./.test(src)); assert(!/invokeLLM|generateText|@openrouter/.test(src));
  }
});
