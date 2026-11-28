/**
 * Design AI draft (0705) on the shared AI text proposal table, through the real API services, the restricted runtime
 * role and the S4 spend controls on a fresh disposable AI-0 fixture. The provider is a counted in-process fake: nothing
 * leaves the machine, and fetch is refused. Synthetic names only.
 */
import assert from 'node:assert/strict';
import { randomUUID as K } from 'node:crypto';
import pg from 'pg';
import { AI0_DATABASE as database, AI0_OWNER_ROLE as ownerRole, AI0_RUNTIME_ROLE as runtimeRole, assertDisposableTarget, assertNoLibpqOverrides } from './ai-spend-baseline-target.mjs';

assertNoLibpqOverrides(process.env);
const ownerUrl = assertDisposableTarget(process.env.DATABASE_URL, ownerRole);
process.env.HON_RUNTIME_DATABASE_URL = assertDisposableTarget(process.env.HON_RUNTIME_DATABASE_URL, runtimeRole);
const forbidden = Object.keys(process.env).filter((k) => /^(?:OPENAI|ANTHROPIC|OPENROUTER|STRIPE|TWILIO|SUPABASE|AWS|SHOPIFY|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER|SHOPIFY))(?:_|$)/i.test(k));
if (forbidden.length) throw new Error(`Refusing provider or execution variables (${forbidden.join(', ')}).`);
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls += 1; throw new Error('EXTERNAL_NETWORK_FORBIDDEN'); };

const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { AiInvocationPlanService } = await import('../../../apps/api/dist/ai/ai-invocation-plan.service.js');
const { DesignDraftService } = await import('../../../apps/api/dist/creative-studio/design-draft.service.js');
const { MerchProviderRuntimeError, DESIGN_DRAFT_SYSTEM_PROMPT } = await import('../../../apps/api/dist/commerce/shopify/merch-provider-runtime.js');

const admin = new pg.Client({ connectionString: ownerUrl, ssl: false });
const row = async (sql, args = []) => (await admin.query(sql, args)).rows[0];
const rows = async (sql, args = []) => (await admin.query(sql, args)).rows;
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
const code = (r) => r.error?.getResponse?.().code;
let groups = 0; const pass = (name) => console.log(`PASS DD1 ${++groups} ${name}`);

const fake = { calls: 0, inputs: [], mode: 'OK', answer: null, ready: true };
const provider = {
  readiness: () => (fake.ready ? 'READY' : 'CONFIGURATION_REQUIRED'),
  generate: async (input) => {
    fake.calls += 1; fake.inputs.push(input);
    if (fake.mode === 'UNKNOWN') throw new MerchProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    if (fake.mode === 'FAILED') throw new MerchProviderRuntimeError('FAILED', 'PROVIDER_REJECTED');
    return { proposal: fake.answer, inputTokens: 700, outputTokens: 500, providerCostMicrounits: 900 };
  },
};
const db = new RuntimeDatabaseService(), plans = new AiInvocationPlanService(db), ai = new DesignDraftService(db, plans, provider);
const catalog = K(), hq = { id: K(), user: K(), subject: `dd1-hq-owner-${K()}` };
const ctx = (o, patch = {}) => ({ organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: K(), correlationId: K(), idempotencyKey: K(), ...patch });
const readCtx = (o) => ctx(o, { idempotencyKey: '' });
const brief = { brief: 'Summer camp, kids 5 to 12, July 7 to 11, $199 a week, sign up by June 20', size: 'FLYER_LETTER', language: 'en' };
const words = { kicker: 'AGES 5 TO 12', head: 'SUMMER\nCAMP', sub: 'July 7 to 11 · $199 a week', details: 'Martial arts · Games · Friends', cta: 'Sign up by June 20' };
const option = (style, patch = {}) => ({ theme: 'camp', style, words, schedule: null, ...patch });
const goodAnswer = { options: [option('bold'), option('fun'), option('clean')] };

async function makeOrg(label) {
  const o = { label, id: K(), school: K(), user: K(), principal: K(), role: K(), subject: `dd1-${label}-${K()}`, policy: K() };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'DD1 synthetic organization','DD1 synthetic organization')", [o.id]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'Synthetic Dojo',$1::uuid::text,'UTC')", [o.school, o.id]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day')", [o.id]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','DD1 synthetic owner')", [o.user, o.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'DD1 synthetic owner')", [o.principal, o.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','DD1 synthetic owner',true)", [o.role, o.id]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions', [o.role, o.id]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')", [o.id, o.school, o.principal, o.role]);
  await admin.query("INSERT INTO hon.hq_ai_routing_policies(policy_id,organization_id,school_id,capability,active,minimum_tier,max_cost_micros,effective_from) VALUES($1,$2,$3,'TEXT',true,'COMPLETE',150000,'2020-01-01')", [o.policy, o.id, o.school]);
  await admin.query('INSERT INTO hon.hq_ai_routing_candidates(policy_id,ordinal,catalog_id) VALUES($1,0,$2)', [o.policy, catalog]);
  await admin.query('COMMIT');
  return o;
}
async function addStaff(o, label, permissions) {
  const s = { ...o, user: K(), principal: K(), role: K(), subject: `dd1-${label}-${K()}` };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','DD1 synthetic staff')", [s.user, s.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'DD1 synthetic staff')", [s.principal, s.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,'DD1 synthetic staff',false)", [s.role, o.id, 'DD1_' + label.toUpperCase()]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,unnest($3::text[])', [s.role, o.id, permissions]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day')", [o.id, o.school, s.principal, s.role, o.principal]);
  await admin.query('COMMIT');
  return s;
}
const ledger = (id) => rows('SELECT customer_credits::int c, provider_cost_microunits::bigint cost, spend_class, school_id FROM hon.ai_usage_ledger WHERE source_invocation_id=$1', [id]);
const proposalRow = (id) => row('SELECT * FROM hon.ai_text_proposals WHERE id=$1', [id]);
const designs = (o) => row('SELECT (SELECT count(*) FROM hon.school_creative_designs WHERE school_id=$1)::int designs, (SELECT count(*) FROM hon.school_creative_design_photos WHERE school_id=$1)::int photos', [o.school]);

try {
  await admin.connect();
  assert.equal((await row('SELECT current_database() d')).d, database);

  // 1. Custody: the DESIGN_DRAFT kind is fixed; the runtime executes exactly the seven entry points; nothing to PUBLIC.
  const entry = ['begin_design_draft', 'plan_design_draft', 'prepare_design_draft', 'fail_design_draft', 'record_design_draft', 'read_design_drafts', 'close_design_draft'];
  const fns = await rows("SELECT p.oid, p.proname, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%design_draft%' AND p.proname <> 'read_design_draft_price'");
  assert.equal(fns.length, 13, fns.map((f) => f.proname).join(','));
  for (const f of fns) {
    assert.equal((await row("SELECT has_function_privilege($1,$2::oid,'EXECUTE') ok", [runtimeRole, f.oid])).ok, entry.includes(f.proname), f.proname);
    assert.equal((await row("SELECT coalesce(bool_or(a.grantee=0),false) pub FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1", [f.oid])).pub, false, f.proname);
    if (entry.includes(f.proname)) assert.equal(f.prosecdef, true, f.proname);
  }
  const kind = await row("SELECT * FROM hon.ai_text_kinds WHERE kind='DESIGN_DRAFT'");
  assert.deepEqual([kind.agent_key, kind.task_class, kind.input_budget, kind.output_budget, Number(kind.max_cost_microunits), kind.max_result_bytes, kind.caller, kind.subject_type, kind.usage_agent],
    ['marcus', 'DRAFT_MARKETING', 6000, 3000, 40000, 8192, 'HUMAN_UI', 'SCHOOL', 'DESIGN_DRAFT']);
  await assert.rejects(admin.query("UPDATE hon.ai_text_kinds SET output_budget=9000 WHERE kind='DESIGN_DRAFT'"));
  pass('custody: DESIGN_DRAFT kind fixed (marcus, DRAFT_MARKETING, 6,000/3,000, 40,000 micro-USD), runtime executes exactly seven definer entry points, nothing to PUBLIC');

  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state,credential_secret_ref) VALUES('OPENROUTER','DD1 synthetic route','HEALTHY',$1)", [`hon-secret:${K()}`]);
  await admin.query("INSERT INTO hon.hq_ai_model_catalog(catalog_id,provider_id,model_id,display_name,capabilities,modalities,active,minimum_tier,unit_cost_micros,cost_unit,effective_from) VALUES($1,'OPENROUTER','approved/dd1-synthetic','DD1 synthetic model',ARRAY['TEXT'],ARRAY['TEXT'],true,'COMPLETE',2,'TOKEN','2020-01-01')", [catalog]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','DD1 synthetic HQ owner')", [hq.user, hq.subject]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','DD1 synthetic HQ owner',true)", [hq.id, hq.user]);
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER','{}',clock_timestamp()-interval '2 days')", [hq.id]);
  await admin.query('COMMIT');

  // 2. Ask: one plan, one provider call with the brief, size, language and school name only, one ledger row, the draft
  //    recorded; no design or photo is created.
  const a = await makeOrg('a');
  const before = await designs(a);
  fake.answer = goodAnswer;
  const c1 = ctx(a);
  const v1 = await ai.request(c1, brief);
  assert.equal(v1.status, 'RESULT_RECORDED', JSON.stringify(v1)); assert.deepEqual(v1.draft, goodAnswer); assert.deepEqual(v1.problems, []); assert.equal(v1.mine, true); assert.deepEqual(v1.brief, brief);
  assert.equal(fake.calls, 1);
  assert.deepEqual(JSON.parse(fake.inputs[0].request), { ...brief, schoolName: 'Synthetic Dojo' });
  assert.equal(/example\.test|DD1/.test(fake.inputs[0].request), false, 'no person or staff detail is sent');
  assert.deepEqual([fake.inputs[0].inputBudget, fake.inputs[0].outputBudget, fake.inputs[0].maxCostMicrounits, fake.inputs[0].modelId], [6000, 3000, 40000, 'approved/dd1-synthetic']);
  const r1 = await proposalRow(v1.id);
  assert.deepEqual([r1.status, r1.reserved_credits, r1.kind, r1.school_id, r1.subject_id], ['RESULT_RECORDED', 0, 'DESIGN_DRAFT', a.school, a.school]);
  const plan = await row('SELECT agent_key, task_class, input_budget, output_budget FROM hon.ai_invocation_plans WHERE id=$1', [r1.plan_id]);
  assert.deepEqual(plan, { agent_key: 'marcus', task_class: 'DRAFT_MARKETING', input_budget: 6000, output_budget: 3000 });
  const used = await ledger(v1.id);
  assert.equal(used.length, 1); assert.deepEqual([used[0].cost, used[0].spend_class, used[0].school_id], ['900', 'AGENT_INFERENCE', a.school]);
  assert.deepEqual(await designs(a), before, 'a draft creates nothing');
  const replay = await ai.request({ ...c1, requestId: K(), correlationId: K() }, brief);
  assert.equal(replay.id, v1.id); assert.equal(fake.calls, 1);
  assert.equal(code(await settle(ai.request({ ...c1, requestId: K(), correlationId: K() }, { ...brief, brief: 'Something else entirely' }))), 'IDEMPOTENCY_KEY_REUSED');
  pass('ask: one plan (marcus, DRAFT_MARKETING, 6,000/3,000), one call with the brief, size, language and school name only, one ledger row, the draft recorded, nothing created, key replay safe');

  // 3. Close: only the requester marks it used or dismissed; closed stays closed.
  const coOwner = await addStaff(a, 'coowner', (await rows('SELECT code FROM hon.permissions')).map((p) => p.code));
  assert.equal((await ai.read(readCtx(coOwner), v1.id)).mine, false);
  assert.equal((await settle(ai.close(ctx(coOwner), v1.id, 'APPLIED'))).error?.getStatus(), 404);
  assert.equal((await ai.close(ctx(a), v1.id, 'APPLIED')).status, 'APPLIED');
  assert.equal((await ai.close(ctx(a), v1.id, 'APPLIED')).status, 'APPLIED', 'replay');
  assert.equal(code(await settle(ai.close(ctx(a), v1.id, 'DISMISSED'))), 'DESIGN_DRAFT_NOT_OPEN');
  pass('close: only the requester marks a draft used or dismissed; a replay is a no-op; closed stays closed');

  // 4. A paid answer outside the shape is RESULT_REJECTED with its usage kept and its problem shown. The database refuses
  //    the same shapes even when a caller skipped the API check.
  const rejected = async (answer) => {
    fake.answer = answer; const v = await ai.request(ctx(a), brief);
    assert.equal(v.status, 'RESULT_REJECTED', JSON.stringify(answer).slice(0, 120)); assert.deepEqual(v.problems, ['The answer was not a design.']); assert.equal(v.draft, null); assert.equal((await ledger(v.id)).length, 1);
    return v;
  };
  const rowsSchedule = [['Mon & Wed', '4:30 PM', 'Little Dragons'], ['Saturday', '10:00 AM', 'Open mat']];
  const badShapes = [{ options: [] }, { options: [option('bold'), option('fun'), option('clean'), option('elegant')] }, { options: [option('neon')] },
    { options: [option('bold', { theme: 'wedding' })] }, { options: [option('bold', { schedule: rowsSchedule })] },
    { options: [option('bold', { theme: 'schedule', schedule: Array.from({ length: 7 }, () => rowsSchedule[0]) })] },
    { options: [option('bold', { words: { ...words, head: 'ONE\nTWO\nTHREE' } })] }, { options: [option('bold', { words: { ...words, cta: '<b>Now</b>' } })] },
    { options: [option('bold', { words: { ...words, kicker: '' } })] }, { options: [option('bold', { words: { ...words, sub: 'x'.repeat(141) } })] },
    { options: [option('bold', { words: { ...words, cta: 'Go‮now' } })] }, { options: [option('bold', { words: { ...words, price: '$1' } })] }, { options: [option('bold')], summary: 'x' }];
  const bad = await rejected(badShapes[0]);
  for (const shape of badShapes.slice(1, 4)) await rejected(shape);
  await rejected(null);
  for (const shape of badShapes) assert.equal((await row('SELECT hon.design_draft_ok($1::jsonb) ok', [JSON.stringify(shape)])).ok, false, JSON.stringify(shape).slice(0, 100));
  assert.equal((await row('SELECT hon.design_draft_ok($1::jsonb) ok', [JSON.stringify(goodAnswer)])).ok, true);
  assert.equal(code(await settle(ai.close(ctx(a), bad.id, 'APPLIED'))), 'DESIGN_DRAFT_NOT_OPEN');
  // A schedule with its own rows, Korean words and an empty details line are accepted; padded words are tidied.
  fake.answer = { options: [option('elegant', { theme: 'schedule', schedule: rowsSchedule, words: { ...words, details: '' } }),
    { theme: 'camp', style: ' Fun ', words: { kicker: '6세 ~ 12세', head: ' 여름 \n 캠프 ', sub: '주간 프로그램 · 반일 또는 종일', details: '무술 · 게임', cta: '지금 신청하세요!' } }] };
  const sched = await ai.request(ctx(a), { ...brief, language: 'ko' });
  assert.equal(sched.status, 'RESULT_RECORDED', JSON.stringify(sched)); assert.deepEqual(sched.draft.options[0].schedule, rowsSchedule);
  assert.deepEqual([sched.draft.options[1].style, sched.draft.options[1].words.head], ['fun', '여름\n캠프']);
  pass('rejected: an answer outside the design shape (no option, four options, an unknown look or theme, rows off the schedule theme, seven rows, a third line, markup, an empty kicker, a long line, a direction character, an extra field, not JSON) keeps its usage, shows its problem and can never be marked used; the database refuses the same shapes; schedule rows, Korean words and an empty details line fit');

  // 5. Unknown outcome: the hold stays and appears in the HQ queue as TEXT_PROPOSAL; a refusal releases it.
  fake.mode = 'UNKNOWN'; fake.answer = goodAnswer;
  const lost = await ai.request(ctx(a), brief);
  assert.equal(lost.status, 'UNKNOWN');
  const lostRow = await proposalRow(lost.id);
  assert.equal(lostRow.reserved_credits > 0, true); assert(lostRow.held_at); assert.equal((await ledger(lost.id)).length, 0);
  const queue = (await row('SELECT hon.read_ai_unknown_invocations_from_hq($1) r', [hq.subject])).r;
  const item = queue.open.find((q) => q.invocationId === lost.id);
  assert.deepEqual([item?.agent, item?.schoolId], ['TEXT_PROPOSAL', a.school]);
  fake.mode = 'FAILED';
  const refused = await ai.request(ctx(a), brief);
  assert.deepEqual([refused.status, refused.reason], ['FAILED', 'PROVIDER_REJECTED']); assert.equal((await proposalRow(refused.id)).reserved_credits, 0);
  fake.mode = 'OK';
  fake.ready = false;
  const off = await ai.request(ctx(a), brief);
  assert.deepEqual([off.status, off.reason], ['CONFIGURATION_REQUIRED', 'CONFIGURATION_REQUIRED']); assert.equal((await proposalRow(off.id)).reserved_credits, 0);
  fake.ready = true;
  pass('unknown: a lost outcome keeps its hold and appears in the HQ queue as TEXT_PROPOSAL; a provider refusal or an unconfigured route holds nothing and sends nothing');

  // 6. HQ usage: design drafts count under their own agent.
  const usage = (await row('SELECT hon.read_ai_school_usage_from_hq($1,$2::timestamptz,$3::timestamptz) r', [hq.subject, new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString()])).r;
  const by = usage.schools.find((s) => s.schoolId === a.school).byClass.AGENT_INFERENCE.byAgent;
  assert.equal(by.DESIGN_DRAFT.credits > 0, true, JSON.stringify(by)); assert.equal(by.MARKETING, undefined);
  pass('usage: the HQ per-school read attributes design drafts to DESIGN_DRAFT');

  // 6b. Size: 600 four-byte characters and a long school name fit the input budget with the prompt; the name is cut by bytes.
  {
    const k = await makeOrg('k');
    await admin.query("UPDATE hon.schools SET name=$2 WHERE id=$1", [k.school, '가'.repeat(100)]);
    fake.answer = goodAnswer; const n = fake.calls;
    const vk = await ai.request(ctx(k), { brief: '\u{1F94B}'.repeat(600), size: 'POSTER_18X24', language: 'ko' });
    assert.equal(vk.status, 'RESULT_RECORDED', JSON.stringify(vk).slice(0, 300)); assert.equal(fake.calls, n + 1);
    const req = fake.inputs.at(-1).request;
    assert.equal(Buffer.byteLength(JSON.parse(req).schoolName) <= 120, true); assert.equal(req.includes('�'), false, 'no name is cut inside a character');
    assert.equal(Buffer.byteLength(DESIGN_DRAFT_SYSTEM_PROMPT + req, 'utf8') + 128 <= 6000, true, String(Buffer.byteLength(DESIGN_DRAFT_SYSTEM_PROMPT + req, 'utf8')));
    pass(`size: 600 four-byte characters and a long school name are ${Buffer.byteLength(req)} bytes; with the prompt they fit the 6,000 input budget; the name is cut by bytes, never inside a character`);
  }

  // 7. Gates: Complete, Marcus, design permission, an HQ pause, school isolation, bad briefs.
  const calls = fake.calls;
  const b = await makeOrg('b');
  await admin.query("UPDATE hon.organization_entitlements SET tier='CORE' WHERE organization_id=$1", [b.id]);
  assert.equal(code(await settle(ai.request(ctx(b), brief))), 'DESIGN_DRAFT_FORBIDDEN');
  await admin.query("UPDATE hon.organization_entitlements SET tier='COMPLETE' WHERE organization_id=$1", [b.id]);
  const marcusOff = await addStaff(b, 'marcusoff', ['creative.design.read', 'creative.design.manage', 'ai.invocation.plan']);
  assert.equal(code(await settle(ai.request(ctx(marcusOff), brief))), 'DESIGN_DRAFT_FORBIDDEN');
  const noPlan = await addStaff(b, 'noplan', ['creative.design.read', 'creative.design.manage', 'ai.agent.marcus.use']);
  assert.equal(code(await settle(ai.request(ctx(noPlan), brief))), 'DESIGN_DRAFT_FORBIDDEN');
  const readOnly = await addStaff(b, 'readonly', ['creative.design.read', 'ai.invocation.plan', 'ai.agent.marcus.use']);
  assert.equal((await settle(ai.request(ctx(readOnly), brief))).error?.getStatus(), 403);
  assert.equal((await settle(ai.list(readCtx(readOnly)))).error?.getStatus(), 403);
  assert.equal((await ai.list(readCtx(marcusOff))).length, 0, 'anyone who may make designs may read the list');
  assert.equal((await row('SELECT count(*)::int n FROM hon.ai_text_proposals WHERE organization_id=$1', [b.id])).n, 0);
  for (const badBrief of [{ ...brief, brief: '' }, { ...brief, brief: ' padded ' }, { ...brief, brief: 'x'.repeat(601) }, { ...brief, brief: 'api_key: abc' }, { ...brief, size: 'A4' },
    { ...brief, language: 'fr' }, { ...brief, extra: 1 }, {}, null, 'text'])
    assert.equal(code(await settle(ai.request(ctx(b), badBrief))), 'DESIGN_DRAFT_INVALID', JSON.stringify(badBrief));
  for (const badBrief of [{ ...brief, size: 'A4' }, { ...brief, language: 'fr' }, { ...brief, extra: 1 }, { brief: brief.brief, size: brief.size }])
    assert.equal((await row('SELECT hon.design_draft_brief_ok($1::jsonb) ok', [JSON.stringify(badBrief)])).ok, false);
  assert.equal(code(await settle(ai.request(ctx(b, { principalType: 'AI_EMPLOYEE' }), brief))), 'HUMAN_COMMAND_REQUIRED');
  const tenant = (o, work) => db.withTenantTransaction(ctx(o), async (c) => { await c.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [o.subject]); return work(c); });
  assert.equal((await settle(ai.read(readCtx(b), v1.id))).error?.getStatus(), 404);
  assert.equal((await settle(tenant(b, async (c) => c.query('SELECT hon.plan_design_draft($1,$2::uuid)', [b.subject, lost.id])))).error?.message, 'AI_TEXT_PROPOSAL_NOT_FOUND');
  assert.equal((await settle(ai.close(ctx(b), refused.id, 'DISMISSED'))).error?.getStatus(), 404);
  assert(!(await ai.list(readCtx(b))).some((x) => x.id === v1.id));
  assert.equal((await ai.list(readCtx(a))).length, 5, 'the list holds the newest five');
  const pause = await settle(admin.query('SELECT hon.command_ai_spend_pause($1,$2::jsonb,$3::uuid) r', [hq.subject, JSON.stringify({ action: 'PAUSE', organizationId: b.id, spendClass: 'AGENT_INFERENCE', reason: 'DD1 synthetic pause for this proof' }), K()]));
  assert.equal(pause.value?.rows[0].r.status, 'ACTIVE', pause.error?.message);
  const paused = await settle(ai.request(ctx(b), brief));
  assert.deepEqual([code(paused), paused.error?.getResponse().reason], ['DESIGN_DRAFT_SPEND_STOPPED', 'AI_PAUSED_BY_HQ']); assert.equal(fake.calls, calls);
  assert.equal(networkCalls, 0);
  pass('gates: Core plan, staff with Marcus switched off, without AI planning or without design changes are refused before any row; bad briefs and non-human callers are refused; an HQ pause refuses with no call; schools are isolated');

  { const verify = await (await import('node:fs/promises')).readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
    const section = verify.split('-- Design AI draft exact verification (0705)')[1]?.split('-- End design AI draft exact verification.')[0];
    assert.ok(section, '0705 verify section present');
    await admin.query(section.slice(section.indexOf('\nDO $$')).replaceAll('hon_runtime', runtimeRole));
    await admin.query(verify.replaceAll('hon_runtime', runtimeRole)); }
  pass('011: the 0705 exact verification (bodies, definer, ACLs, kind row) and the whole canonical 011 pass');
  console.log(`DD1 design AI draft: ${groups} groups passed, ${fake.calls} fake provider calls, 0 network calls`);
} finally {
  await admin.end().catch(() => {});
  await db.onModuleDestroy?.().catch?.(() => {});
}
