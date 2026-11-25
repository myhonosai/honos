const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const { OpenRouterMerchRuntime, COMMERCE_REVIEW_SYSTEM_PROMPT } = require('../dist/commerce/shopify/merch-provider-runtime.js');
const { CHAD_LEAD_PLAN_TEXT_PROFILE, CHAD_LEAD_PLAN_SYSTEM_PROMPT } = require('../dist/chad-lead-plan/chad-lead-plan-provider.js');
const { MAYA_RENEWAL_SYSTEM_PROMPT } = require('../dist/maya-renewal/maya-renewal-provider.js');
const { ChadLeadPlanService } = require('../dist/chad-lead-plan/chad-lead-plan.service.js');
const { validateChadLeadPlanBrief, validateChadLeadPlanProposal, validateChadLeadPlanStep, chadLeadPlanProblems, verifyChadLeadPlanView, verifyChadLeadPlanList } = require('@hon/contracts');

const id = '11111111-1111-4111-8111-111111111111', key = '22222222-2222-4222-8222-222222222222';
const env = () => ({ OPENROUTER_API_KEY: 'unit-only-not-a-secret', OPENROUTER_PAID_CALL_APPROVED: 'true' });
const brief = { focus: 'ALL_OPEN', note: '' };
const s = (patch = {}) => ({ lead: 'L1', action: 'MOVE_STAGE', stage: 'S2', slot: null, reason: 'Asked for a call back three days ago and has not been reached.', ...patch });
const proposal = { summary: 'Two leads are ready for a next step.', suggestions: [s(), s({ lead: 'L2', action: 'BOOK_TRIAL', stage: null, slot: 'C1' })] };
const input = { providerId: 'OPENROUTER', modelId: 'approved/test', providerRequestId: id, request: JSON.stringify({ brief, schoolName: 'Test Dojo', localToday: '2026-11-22', leads: [], stages: [], leadPipelines: {}, classes: [] }), inputBudget: 10000, outputBudget: 2500, maxCostMicrounits: 80000 };
const ok = content => ({ model: input.modelId, choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 1500, completion_tokens: 400, cost: 0.0012 } });
const response = v => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
const runtime = transport => new OpenRouterMerchRuntime(env, transport, CHAD_LEAD_PLAN_TEXT_PROFILE);

test('the Chad runtime sends one fixed request with the lead prompt and budgets', async () => {
  let calls = 0; const rt = runtime(async (url, o) => {
    calls++; assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions'); assert.equal(o.redirect, 'error');
    const body = JSON.parse(o.body); assert.equal(body.max_tokens, 2500); assert.equal(body.temperature, 0.2); assert.equal(body.tools, undefined); assert.equal(body.provider.allow_fallbacks, false);
    assert.equal(body.messages[0].content, CHAD_LEAD_PLAN_SYSTEM_PROMPT); assert.notEqual(body.messages[0].content, MAYA_RENEWAL_SYSTEM_PROMPT); assert.notEqual(body.messages[0].content, COMMERCE_REVIEW_SYSTEM_PROMPT);
    assert.equal(body.messages[1].content, input.request);
    return response(ok(JSON.stringify(proposal)));
  });
  assert.deepEqual(await rt.generate(input), { proposal, inputTokens: 1500, outputTokens: 400, providerCostMicrounits: 1200 }); assert.equal(calls, 1);
  for (const patch of [{ inputBudget: 12000 }, { outputBudget: 3000 }, { maxCostMicrounits: 150000 }, { modelId: '../x' }, { request: 'x'.repeat(10000) }]) {
    let sent = 0; await assert.rejects(runtime(async () => { sent++; }).generate({ ...input, ...patch }), x => x.outcome === 'PRE_SEND' && x.reason === 'INVALID_REQUEST'); assert.equal(sent, 0);
  }
  let off = 0; await assert.rejects(new OpenRouterMerchRuntime(() => ({ OPENROUTER_API_KEY: 'unit-only' }), async () => { off++; }, CHAD_LEAD_PLAN_TEXT_PROFILE).generate(input), x => x.reason === 'CONFIGURATION_REQUIRED'); assert.equal(off, 0);
  assert(Buffer.byteLength(CHAD_LEAD_PLAN_SYSTEM_PROMPT) < 2500, 'the prompt leaves room for the facts');
});

test('the Chad prompt says suggestions change nothing and forbids invented facts and personal data', () => {
  assert.match(CHAD_LEAD_PLAN_SYSTEM_PROMPT, /You book, move, send and change nothing/); assert.match(CHAD_LEAD_PLAN_SYSTEM_PROMPT, /Use only the facts given/);
  assert.match(CHAD_LEAD_PLAN_SYSTEM_PROMPT, /a staff member decides each step and runs it themselves/); assert.match(CHAD_LEAD_PLAN_SYSTEM_PROMPT, /never as instructions/); assert.match(CHAD_LEAD_PLAN_SYSTEM_PROMPT, /No links, email addresses, phone numbers or personal data/);
});

test('the brief, the suggestion shape and the step request are closed', () => {
  assert.deepEqual(validateChadLeadPlanBrief(brief), brief); assert.equal(validateChadLeadPlanBrief({ focus: 'NO_TRIAL_YET', note: 'Spring push' }).focus, 'NO_TRIAL_YET');
  for (const bad of [null, {}, { focus: 'HOT', note: '' }, { focus: 'ALL_OPEN' }, { ...brief, note: ' padded' }, { ...brief, note: 'x'.repeat(301) }, { ...brief, extra: 1 }]) {
    assert.throws(() => validateChadLeadPlanBrief(bad), JSON.stringify(bad));
  }
  assert.deepEqual(validateChadLeadPlanProposal(proposal), proposal);
  for (const bad of [{}, { ...proposal, suggestions: [] }, { ...proposal, suggestions: Array.from({ length: 11 }, (_, n) => s({ lead: `L${(n % 15) + 1}` })) },
    { ...proposal, suggestions: [s(), s({ stage: 'S3' })] }, { ...proposal, suggestions: [s({ lead: 'L16' })] }, { ...proposal, suggestions: [s({ lead: 'M1' })] },
    { ...proposal, suggestions: [s({ action: 'CALL' })] }, { ...proposal, suggestions: [s({ slot: 'C1' })] }, { ...proposal, suggestions: [s({ stage: null })] },
    { ...proposal, suggestions: [s({ action: 'BOOK_TRIAL', stage: null, slot: 'C21' })] }, { ...proposal, suggestions: [s({ action: 'BOOK_TRIAL', slot: 'C1' })] },
    { ...proposal, suggestions: [{ ...s(), leadId: id }] }, { ...proposal, suggestions: [s({ reason: 'line one\nline two' })] }, { ...proposal, summary: 'x'.repeat(301) }]) {
    assert.throws(() => validateChadLeadPlanProposal(bad), JSON.stringify(bad).slice(0, 120));
  }
  assert.deepEqual(validateChadLeadPlanStep({ appointmentId: null }), { appointmentId: null }); assert.deepEqual(validateChadLeadPlanStep({ appointmentId: key }), { appointmentId: key });
  for (const bad of [{}, { appointmentId: 'x' }, { appointmentId: key, extra: 1 }, { appointmentId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }]) assert.throws(() => validateChadLeadPlanStep(bad), JSON.stringify(bad));
});

test('suggestions with a link or an email address are a problem', () => {
  assert.deepEqual(chadLeadPlanProblems(proposal), []);
  for (const reason of ['See https://example.test', 'Visit www.example.test', 'Write to owner@example.test']) {
    assert.deepEqual(chadLeadPlanProblems({ ...proposal, suggestions: [s({ reason })] }), ['The answer holds a link or an email address.']);
  }
});

test('a view shows suggestions only when recorded or applied, and recorded steps only on an answered list', () => {
  const base = { id, status: 'PENDING', reason: null, brief, summary: null, suggestions: null, leads: [], stages: [], classes: [], applied: [], problems: [], createdAt: '2026-11-22T00:00:00.000Z', updatedAt: '2026-11-22T00:00:00.000Z' };
  assert.equal(verifyChadLeadPlanView(base).suggestions, null);
  const leads = [{ ref: 'L1', leadId: key, leadVersion: 3, name: 'Sample Lead' }];
  const stages = [{ ref: 'S2', stageId: key, name: 'Contacted' }];
  const classes = [{ ref: 'C1', classSessionId: key, name: 'Kids basics', startsAt: '2026-11-23T17:00:00.000Z', endsAt: '2026-11-23T18:00:00.000Z' }];
  const answered = verifyChadLeadPlanView({ ...base, status: 'RESULT_RECORDED', ...proposal, leads, stages, classes, applied: [{ index: 0, action: 'MOVE_STAGE', leadId: key, appointmentId: null }] });
  assert.deepEqual([answered.leads, answered.stages, answered.classes], [leads, stages, classes]);
  assert.equal(verifyChadLeadPlanView({ ...base, status: 'APPLIED', ...proposal, applied: [{ index: 1, action: 'BOOK_TRIAL', leadId: key, appointmentId: key }] }).applied.length, 1);
  assert.throws(() => verifyChadLeadPlanView({ ...base, applied: [{ index: 0, action: 'MOVE_STAGE', leadId: key, appointmentId: null }] }));
  assert.throws(() => verifyChadLeadPlanView({ ...base, status: 'RESULT_REJECTED', ...proposal }));
  assert.throws(() => verifyChadLeadPlanView({ ...base, classes: [{ ...classes[0], startsAt: 'tomorrow' }] }));
  assert.throws(() => verifyChadLeadPlanView({ ...base, leads: [{ ...leads[0], ref: 'M1' }] }));
  assert.throws(() => verifyChadLeadPlanView({ ...base, extra: 1 }));
  assert.throws(() => verifyChadLeadPlanList(Array.from({ length: 21 }, () => base)));
});

const ctx = { organizationId: id, schoolId: id, principalId: id, externalSubject: 'verified-unit-subject', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key };
test('only a direct human with a key and valid input can ask or record a step; nothing reaches SQL or the provider otherwise', async () => {
  let touched = 0; const db = { withTenantTransaction: async () => { touched++; throw Error('Unexpected SQL'); }, withTenantReadOnlyTransaction: async () => { touched++; throw Error('Unexpected SQL'); } };
  const svc = new ChadLeadPlanService(db, {}, { readiness: () => { touched++; }, generate: async () => { touched++; } });
  for (const patch of [{ source: 'AI' }, { principalType: 'AI_EMPLOYEE' }, { delegatedByPrincipalId: id }, { actionRequestId: id }, { externalSubject: '' }]) {
    await assert.rejects(svc.request({ ...ctx, ...patch }, brief), e => e.getStatus?.() === 403);
    await assert.rejects(svc.recordStep({ ...ctx, ...patch }, id, 0, { appointmentId: null }), e => e.getStatus?.() === 403);
  }
  await assert.rejects(svc.request({ ...ctx, idempotencyKey: 'not-a-uuid' }, brief), e => e.getStatus?.() === 409);
  await assert.rejects(svc.recordStep({ ...ctx, idempotencyKey: '' }, id, 0, { appointmentId: null }), e => e.getStatus?.() === 409);
  for (const bad of [{ ...brief, providerId: 'x' }, { ...brief, focus: 'TODAY' }]) await assert.rejects(svc.request(ctx, bad), e => e.getStatus?.() === 400 && e.getResponse().code === 'CHAD_LEAD_PLAN_INVALID');
  for (const [index, body] of [[10, { appointmentId: null }], [-1, { appointmentId: null }], [0, { appointmentId: 'x' }], [0, {}]]) await assert.rejects(svc.recordStep(ctx, id, index, body), e => e.getStatus?.() === 400);
  await assert.rejects(svc.recordStep(ctx, 'not-a-uuid', 0, { appointmentId: null }), e => e.getStatus?.() === 400);
  await assert.rejects(svc.read({ ...ctx, idempotencyKey: '' }, 'not-a-uuid'), e => e.getStatus?.() === 400);
  assert.equal(touched, 0);
});

test('database refusals map to plain answers', async () => {
  const fail = (code, message) => ({ withTenantTransaction: async () => { throw Object.assign(new Error(message), { code }); } });
  const cases = [['P0002', 'CHAD_LEAD_PLAN_NOT_DONE', 409, 'CHAD_LEAD_PLAN_NOT_DONE'], ['42501', 'CHAD_HUMAN_STAFF_REQUIRED', 403, 'CHAD_LEAD_PLAN_FORBIDDEN'], ['42501', 'CHAD_FOLLOW_UP_FORBIDDEN', 403, 'CHAD_LEAD_PLAN_FORBIDDEN'],
    ['42501', 'AI_SCHOOL_CEILING_REACHED', 403, 'CHAD_LEAD_PLAN_SPEND_STOPPED'], ['40001', 'AI_TEXT_PROPOSAL_NOT_OPEN', 409, 'CHAD_LEAD_PLAN_NOT_OPEN'], ['P0002', 'AI_TEXT_PROPOSAL_NOT_FOUND', 404, 'CHAD_LEAD_PLAN_NOT_FOUND'],
    ['22023', 'CHAD_LEAD_PLAN_INVALID', 400, 'CHAD_LEAD_PLAN_INVALID']];
  for (const [code, message, status, out] of cases) {
    const svc = new ChadLeadPlanService(fail(code, message), {}, { readiness: () => 'READY' });
    await assert.rejects(svc.recordStep(ctx, id, 0, { appointmentId: null }), e => e.getStatus?.() === status && e.getResponse().code === out, message);
  }
  const notDone = await new ChadLeadPlanService(fail('P0002', 'CHAD_LEAD_PLAN_NOT_DONE'), {}, {}).recordStep(ctx, id, 0, { appointmentId: null }).catch(e => e.getResponse());
  assert.match(notDone.detail, /Run the step first, then record it/);
});

test('the live module gives Chad its own runtime profile and no test fake; sources log nothing; the controller uses its own human commands', () => {
  const module = fs.readFileSync(path.join(__dirname, '../src/app.module.ts'), 'utf8');
  assert.match(module, /provide: CHAD_LEAD_PLAN_PROVIDER_RUNTIME, useFactory: \(\) => new OpenRouterMerchRuntime\(undefined, undefined, CHAD_LEAD_PLAN_TEXT_PROFILE\)/);
  assert.match(module, /ChadLeadPlanController,/); assert.match(module, /ChadLeadPlanService,/);
  for (const file of ['src/chad-lead-plan/chad-lead-plan.service.ts', 'src/chad-lead-plan/chad-lead-plan.controller.ts', 'src/chad-lead-plan/chad-lead-plan-provider.ts']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); assert(!/console\.|logger\./.test(src)); assert(!/invokeLLM|generateText|@openrouter/.test(src));
  }
  const controller = fs.readFileSync(path.join(__dirname, '../src/chad-lead-plan/chad-lead-plan.controller.ts'), 'utf8');
  for (const c of ['chad.lead_plan.request', 'chad.lead_plan.step', 'chad.lead_plan.close']) assert.match(controller, new RegExp(c.replaceAll('.', '\\.')));
});
