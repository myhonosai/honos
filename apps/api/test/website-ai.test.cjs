const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const { OpenRouterWebsiteRuntime, WebsiteProviderRuntimeError, WEBSITE_SYSTEM_PROMPT } = require('../dist/ai/website-provider-runtime.js');
const { WebsiteAiService } = require('../dist/website/website-ai.service.js');
const { applyWebsiteAiEdits, buildWebsiteFromTemplate, validateWebsiteAiProposal, validateWebsiteAiEditRequest, WEBSITE_TEMPLATES } = require('@hon/contracts');

const id = '11111111-1111-4111-8111-111111111111', key = '22222222-2222-4222-8222-222222222222';
const env = () => ({ OPENROUTER_API_KEY: 'unit-only-not-a-secret', OPENROUTER_PAID_CALL_APPROVED: 'true' });
const input = { providerId: 'OPENROUTER', modelId: 'approved/test', providerRequestId: id, request: JSON.stringify({ ownerRequest: 'Make the hero friendlier', site: { name: 'Test Dojo', pages: [] } }), inputBudget: 16000, outputBudget: 4000, maxCostMicrounits: 150000 };
const proposal = { summary: 'A friendlier hero.', edits: [{ op: 'setText', page: 'home', section: 'hero', prop: 'heading', value: 'Welcome to Test Dojo' }] };
const ok = (content, extra = {}) => ({ model: input.modelId, choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 900, completion_tokens: 200, cost: 0.0011 }, ...extra });
const response = v => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
const doc = () => buildWebsiteFromTemplate('MODERN_CLEAN', { schoolName: 'Test Dojo' });

test('website runtime needs the key and the paid-call approval, and sends nothing otherwise', async () => {
  for (const e of [{}, { OPENROUTER_PAID_CALL_APPROVED: 'true' }, { OPENROUTER_API_KEY: 'unit-only-not-a-secret' }]) {
    let calls = 0; const rt = new OpenRouterWebsiteRuntime(() => e, async () => { calls++; throw Error('NO NETWORK'); });
    assert.equal(rt.readiness('OPENROUTER'), 'CONFIGURATION_REQUIRED');
    await assert.rejects(rt.generate(input), x => x.outcome === 'PRE_SEND' && x.reason === 'CONFIGURATION_REQUIRED'); assert.equal(calls, 0);
  }
  assert.equal(new OpenRouterWebsiteRuntime(env).readiness('OTHER'), 'UNSUPPORTED_PROVIDER');
});

test('website runtime sends one fixed request with the plan budgets and returns usage with the parsed answer', async () => {
  let calls = 0; const rt = new OpenRouterWebsiteRuntime(env, async (url, o) => {
    calls++; assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions'); assert.equal(o.redirect, 'error'); assert.equal(o.headers['Idempotency-Key'], id);
    const body = JSON.parse(o.body); assert.equal(body.max_tokens, 4000); assert.equal(body.provider.allow_fallbacks, false); assert.equal(body.tools, undefined);
    assert.equal(body.messages[0].content, WEBSITE_SYSTEM_PROMPT); assert.equal(body.messages[1].content, input.request);
    return response(ok(JSON.stringify(proposal)));
  });
  assert.deepEqual(await rt.generate(input), { proposal, inputTokens: 900, outputTokens: 200, providerCostMicrounits: 1100 }); assert.equal(calls, 1);
  for (const patch of [{ inputBudget: 4096 }, { outputBudget: 1024 }, { maxCostMicrounits: 100000 }, { modelId: '../x' }, { request: 'x'.repeat(16000) }]) {
    let sent = 0; await assert.rejects(new OpenRouterWebsiteRuntime(env, async () => { sent++; }).generate({ ...input, ...patch }), x => x.outcome === 'PRE_SEND' && x.reason === 'INVALID_REQUEST'); assert.equal(sent, 0);
  }
});

test('a paid answer that is not JSON or was cut short keeps its usage (proposal null); transport doubt is UNKNOWN; refusals are FAILED', async () => {
  for (const r of [ok('not json'), { ...ok(JSON.stringify(proposal)), choices: [{ finish_reason: 'length', message: { content: '{"summary":' } }] }]) {
    const out = await new OpenRouterWebsiteRuntime(env, async () => response(r)).generate(input);
    assert.equal(out.proposal, null); assert.equal(out.inputTokens, 900);
  }
  for (const t of [async () => { throw Error('socket'); }, async () => new Response('x', { status: 503 }), async () => response(ok('{}', { model: 'swapped' })), async () => response({ ...ok('{}'), usage: { prompt_tokens: 1, completion_tokens: 1 } }), async () => new Response('x'.repeat(70000))]) {
    let calls = 0; await assert.rejects(new OpenRouterWebsiteRuntime(env, async (...a) => { calls++; return t(...a); }).generate(input), x => x instanceof WebsiteProviderRuntimeError && x.outcome === 'UNKNOWN'); assert.equal(calls, 1);
  }
  await assert.rejects(new OpenRouterWebsiteRuntime(env, async () => new Response('', { status: 429 })).generate(input), x => x.outcome === 'FAILED' && x.reason === 'PROVIDER_REJECTED');
});

test('suggested edits apply to a draft one at a time; images, forms and outside links stay the owner\'s', () => {
  const d = doc();
  const r = applyWebsiteAiEdits(d, [
    { op: 'setText', page: 'home', section: 'hero', prop: 'heading', value: 'Welcome' },
    { op: 'setText', page: 'home', section: 'enquire', prop: 'formId', value: '' },
    { op: 'setText', page: 'home', section: 'hero', prop: 'ctaHref', value: 'https://elsewhere.example' },
    { op: 'setText', page: 'home', section: 'hero', prop: 'ctaHref', value: '/about' },
    { op: 'addPage', slug: 'summer-camp', title: 'Summer camp', kind: 'PROMOTION', sections: [{ type: 'HERO', props: { heading: 'Summer camp' } }, { type: 'TEXT', props: { heading: 'Dates', body: '[camp dates]' } }] },
    { op: 'addPage', slug: 'home-two', title: 'Home', kind: 'HOME' },
    { op: 'setTheme', palette: { primary: '#112233' } },
    { op: 'publish' },
  ]);
  assert.equal(r.applied, 4); assert.equal(r.problems.length, 4);
  const home = r.document.pages.find(p => p.slug === 'home'), hero = home.sections.find(s => s.id === 'hero');
  assert.equal(hero.props.heading, 'Welcome'); assert.equal(hero.props.ctaHref, '/about'); assert.equal(r.document.theme.palette.primary, '#112233');
  const camp = r.document.pages.find(p => p.slug === 'summer-camp'); assert.equal(camp.kind, 'PROMOTION'); assert.equal(camp.sections[0].props.heading, 'Summer camp'); assert.equal(camp.sections.length, 2);
  assert.match(r.problems.join(' '), /Change 2 \(setText\)/); assert.match(r.problems.join(' '), /Change 8 \(publish\)/);
  // Replacing a list keeps each existing image; a new image can never be chosen.
  const withImage = applyWebsiteAiEdits(d, [{ op: 'setText', page: 'home', section: 'programs', prop: 'items', value: [{ name: 'Tiny', ages: '3-5', description: 'Play', imageUrl: '' }] }]);
  assert.equal(withImage.applied, 1);
  assert.equal(applyWebsiteAiEdits(d, [{ op: 'setText', page: 'home', section: 'programs', prop: 'items', value: [{ name: 'Tiny', ages: '3-5', description: 'Play', imageUrl: 'https://img.example/x.png' }] }]).applied, 0);
  assert.equal(applyWebsiteAiEdits(d, [{ op: 'addSection', page: 'home', type: 'IMAGE', after: null, props: { imageUrl: 'https://img.example/x.png' } }]).applied, 0);
});

test('the proposal and request validators are closed', () => {
  assert.deepEqual(validateWebsiteAiProposal(proposal), proposal);
  for (const bad of [null, {}, { summary: '', edits: [] }, { summary: 'x', edits: [], extra: 1 }, { summary: 'x', edits: Array(26).fill({ op: 'removePage', page: 'about' }) }, { summary: 'x', edits: [{ op: 'runSql' }] }]) assert.throws(() => validateWebsiteAiProposal(bad));
  assert.deepEqual(validateWebsiteAiEditRequest({ expectedRevision: 3, request: 'Add a summer camp page' }), { expectedRevision: 3, request: 'Add a summer camp page' });
  for (const bad of [{ expectedRevision: 3, request: '' }, { expectedRevision: 0, request: 'x' }, { expectedRevision: 3, request: 'x'.repeat(1001) }, { expectedRevision: 3, request: 'x', schoolId: id }, { expectedRevision: 3, request: 'apiKey=abc' }]) assert.throws(() => validateWebsiteAiEditRequest(bad));
});

const ctx = { organizationId: id, schoolId: id, principalId: id, externalSubject: 'verified-unit-subject', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key };
const view = (patch = {}) => ({ id, status: 'PENDING', reason: null, request: 'Make the hero friendlier', baseRevision: 4, mine: true, summary: null, edits: null, problems: [], createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:00.000Z', ...patch });
const site = (rev = 4) => ({ id, publicSlug: 'test-dojo', name: 'Test Dojo', status: 'DRAFT', draftRevision: rev, publishedVersion: null, draft: doc(), versions: [], createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:00.000Z' });
function fakeDb(answers) {
  const log = []; let tx = 0;
  const client = n => ({ query: async (sql, params) => { const fn = /hon\.([a-z_]+)\(/.exec(sql)?.[1]; if (fn) log.push({ tx: n, fn, params }); const a = fn ? answers[fn] : undefined; return { rows: [{ data: typeof a === 'function' ? a(params) : a }] }; } });
  return { log, db: { withTenantTransaction: async (c, work) => work(client(++tx)), withTenantReadOnlyTransaction: async (c, work) => work(client(++tx)) } };
}

test('a request runs begin, plan, prepare, one provider call and one record, with problems found on the current draft', async () => {
  let recorded;
  const { log, db } = fakeDb({ begin_school_website_ai_edit: view(), school_website_ai_edit_planning_reference: { planId: null, workItemId: id, workVersion: 1 },
    read_school_website: { website: site(), templates: [...WEBSITE_TEMPLATES] },
    prepare_school_website_ai_edit: { providerId: 'OPENROUTER', modelId: 'approved/test', providerRequestId: id, request: '{}', inputBudget: 16000, outputBudget: 4000, maxCostMicrounits: 150000 },
    record_school_website_ai_edit: p => { recorded = JSON.parse(p[2]); return view({ status: 'RESULT_RECORDED', summary: 's', edits: [], recorded: 'RESULT_RECORDED' }); } });
  let planned, sent = 0;
  const plans = { plan: async (c, work, input) => { planned = input; assert.equal(c.idempotencyKey, id); return { status: 'PLANNED', plan: { id } }; } };
  const provider = { readiness: () => 'READY', generate: async () => { sent++; return { proposal: { summary: 'Two changes', edits: [proposal.edits[0], { op: 'removeSection', page: 'home', section: 'missing' }] }, inputTokens: 900, outputTokens: 200, providerCostMicrounits: 1100 }; } };
  const out = await new WebsiteAiService(db, plans, provider).request(ctx, { expectedRevision: 4, request: 'Make the hero friendlier' });
  assert.equal(out.status, 'RESULT_RECORDED'); assert.equal(sent, 1);
  assert.deepEqual(log.map(l => l.fn), ['begin_school_website_ai_edit', 'school_website_ai_edit_planning_reference', 'read_school_website', 'prepare_school_website_ai_edit', 'record_school_website_ai_edit']);
  assert.deepEqual({ agent: planned.agentKey, task: planned.taskClass, i: planned.inputBudget, o: planned.outputBudget, c: planned.maxProviderCostMicrounits }, { agent: 'marcus', task: 'DRAFT_MARKETING', i: 16000, o: 4000, c: 150000 });
  assert.deepEqual(recorded.usage, { inputTokens: 900, outputTokens: 200, providerCostMicrounits: 1100 });
  assert.equal(recorded.proposal.edits.length, 2); assert.equal(recorded.problems.length, 1); assert.match(recorded.problems[0], /Change 2 \(removeSection\)/);
  // The usage record and the begin are separate transactions.
  assert.notEqual(log.find(l => l.fn === 'record_school_website_ai_edit').tx, log.find(l => l.fn === 'prepare_school_website_ai_edit').tx);
});

test('an answer outside the edit list is recorded as null for the database to reject; a provider failure records the outcome only', async () => {
  let recorded;
  const base = { begin_school_website_ai_edit: view(), school_website_ai_edit_planning_reference: { planId: id, workItemId: id, workVersion: 2 }, read_school_website: { website: site(), templates: [...WEBSITE_TEMPLATES] },
    prepare_school_website_ai_edit: { providerId: 'OPENROUTER', modelId: 'm', providerRequestId: id, request: '{}', inputBudget: 16000, outputBudget: 4000, maxCostMicrounits: 150000 },
    record_school_website_ai_edit: p => { recorded = JSON.parse(p[2]); return view({ status: 'RESULT_REJECTED', summary: '', problems: ['The answer was not a website edit list.'] }); },
    read_school_website_ai_edits: view({ status: 'FAILED', reason: 'PROVIDER_REJECTED' }) };
  const a = fakeDb(base);
  await new WebsiteAiService(a.db, { plan: async () => assert.fail('already planned') }, { readiness: () => 'READY', generate: async () => ({ proposal: { summary: 'x', edits: [{ op: 'runSql' }] }, inputTokens: 5, outputTokens: 5, providerCostMicrounits: 7 }) }).request(ctx, { expectedRevision: 4, request: 'x' });
  assert.equal(recorded.proposal, null); assert.deepEqual(recorded.problems, []);
  const b = fakeDb(base);
  const out = await new WebsiteAiService(b.db, {}, { readiness: () => 'READY', generate: async () => { throw new WebsiteProviderRuntimeError('FAILED', 'PROVIDER_REJECTED'); } }).request(ctx, { expectedRevision: 4, request: 'x' });
  assert.equal(out.status, 'FAILED'); assert.deepEqual(b.log.find(l => l.fn === 'fail_school_website_ai_edit').params.slice(2), ['FAILED', 'PROVIDER_REJECTED']);
  assert(!b.log.some(l => l.fn === 'record_school_website_ai_edit'));
  const c = fakeDb(base);
  await new WebsiteAiService(c.db, {}, { readiness: () => 'READY', generate: async () => ({ proposal, inputTokens: 0, outputTokens: 5, providerCostMicrounits: 7 }) }).request(ctx, { expectedRevision: 4, request: 'x' });
  assert.deepEqual(c.log.find(l => l.fn === 'fail_school_website_ai_edit').params.slice(2), ['UNKNOWN', 'PROVIDER_UNKNOWN']);
});

test('only a direct human with a UUID key can ask; nothing reaches SQL or the provider otherwise', async () => {
  let touched = 0; const db = { withTenantTransaction: async () => { touched++; throw Error('Unexpected SQL'); }, withTenantReadOnlyTransaction: async () => { touched++; throw Error('Unexpected SQL'); } };
  const svc = new WebsiteAiService(db, {}, { readiness: () => { touched++; }, generate: async () => { touched++; } });
  for (const patch of [{ source: 'AI' }, { principalType: 'AI_EMPLOYEE' }, { delegatedByPrincipalId: id }, { actionRequestId: id }, { externalSubject: '' }]) await assert.rejects(svc.request({ ...ctx, ...patch }, { expectedRevision: 1, request: 'x' }), e => e.getStatus?.() === 403);
  await assert.rejects(svc.request({ ...ctx, idempotencyKey: 'not-a-uuid' }, { expectedRevision: 1, request: 'x' }), e => e.getStatus?.() === 409);
  for (const extra of ['schoolId', 'providerId', 'modelId']) await assert.rejects(svc.request(ctx, { expectedRevision: 1, request: 'x', [extra]: id }), e => e.getStatus?.() === 400);
  await assert.rejects(svc.list({ ...ctx }), e => e.getStatus?.() === 409);
  assert.equal(touched, 0);
});

test('apply saves the changed draft and closes the suggestion in one transaction, and refuses a moved draft', async () => {
  const recordedView = view({ status: 'RESULT_RECORDED', summary: 'Friendlier', edits: proposal.edits });
  const answers = { read_school_website_ai_edits: recordedView, read_school_website: { website: site(4), templates: [...WEBSITE_TEMPLATES] },
    mutate_school_website: p => ({ website: { ...site(5), draft: JSON.parse(p[2]).document }, replayed: false }), close_school_website_ai_edit: view({ status: 'APPLIED', summary: 'Friendlier', edits: proposal.edits }) };
  const a = fakeDb(answers);
  const out = await new WebsiteAiService(a.db, {}, {}).apply(ctx, id, { expectedRevision: 4 });
  assert.equal(out.suggestion.status, 'APPLIED'); assert.equal(out.website.draft.pages[0].sections.find(s => s.id === 'hero').props.heading, 'Welcome to Test Dojo');
  assert.deepEqual(a.log.map(l => l.fn), ['read_school_website_ai_edits', 'read_school_website', 'mutate_school_website', 'close_school_website_ai_edit']);
  assert.equal(new Set(a.log.map(l => l.tx)).size, 1); assert.equal(a.log[2].params[1], 'save'); assert.equal(a.log[3].params[2], 'APPLIED');
  const b = fakeDb(answers);
  await assert.rejects(new WebsiteAiService(b.db, {}, {}).apply(ctx, id, { expectedRevision: 3 }), e => e.getStatus?.() === 409 && e.getResponse().code === 'VERSION_CONFLICT');
  assert(!b.log.some(l => l.fn === 'mutate_school_website'));
  const c = fakeDb({ ...answers, read_school_website_ai_edits: view({ status: 'RESULT_RECORDED', summary: 'x', edits: [{ op: 'removeSection', page: 'home', section: 'missing' }] }) });
  await assert.rejects(new WebsiteAiService(c.db, {}, {}).apply(ctx, id, { expectedRevision: 4 }), e => e.getResponse().code === 'SCHOOL_WEBSITE_AI_DOES_NOT_FIT');
  const d = fakeDb({ ...answers, read_school_website_ai_edits: view({ status: 'RESULT_RECORDED', mine: false, summary: 'x', edits: [] }) });
  await assert.rejects(new WebsiteAiService(d.db, {}, {}).apply(ctx, id, { expectedRevision: 4 }), e => e.getResponse().code === 'SCHOOL_WEBSITE_AI_NOT_OPEN');
});

test('the live module uses the OpenRouter website runtime and no test fake; sources log nothing', () => {
  const module = fs.readFileSync(path.join(__dirname, '../src/app.module.ts'), 'utf8');
  assert.match(module, /provide: WEBSITE_PROVIDER_RUNTIME, useFactory: \(\) => new OpenRouterWebsiteRuntime\(\)/);
  for (const file of ['src/ai/website-provider-runtime.ts', 'src/website/website-ai.service.ts', 'src/website/website-ai.controller.ts']) {
    const s = fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); assert(!/console\.|logger\./.test(s)); assert(!/invokeLLM|generateText|@openrouter/.test(s));
  }
});
