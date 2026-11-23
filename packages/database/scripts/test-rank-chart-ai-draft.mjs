/**
 * Rank chart AI draft (0636) on the shared AI text proposal table, through the real API services, the restricted runtime
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
const { RankChartDraftService } = await import('../../../apps/api/dist/curriculum/rank-chart-draft.service.js');
const { RankSetupService } = await import('../../../apps/api/dist/curriculum/rank-setup.service.js');
const { MerchProviderRuntimeError, RANK_CHART_SYSTEM_PROMPT } = await import('../../../apps/api/dist/commerce/shopify/merch-provider-runtime.js');

const admin = new pg.Client({ connectionString: ownerUrl, ssl: false });
const row = async (sql, args = []) => (await admin.query(sql, args)).rows[0];
const rows = async (sql, args = []) => (await admin.query(sql, args)).rows;
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
const code = (r) => r.error?.getResponse?.().code;
let groups = 0; const pass = (name) => console.log(`PASS RC1 ${++groups} ${name}`);

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
const db = new RuntimeDatabaseService(), plans = new AiInvocationPlanService(db), ai = new RankChartDraftService(db, plans, provider), setup = new RankSetupService(db);
const catalog = K(), hq = { id: K(), user: K(), subject: `rc1-hq-owner-${K()}` };
const ctx = (o, patch = {}) => ({ organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: K(), correlationId: K(), idempotencyKey: K(), ...patch });
const readCtx = (o) => ctx(o, { idempotencyKey: '' });
const brief = { description: 'Kids Taekwondo with white, yellow and black belts, about 24 classes per belt.', current: null };
const belt = (name, color, classes = 24, days = 60) => ({ name, color, classes, days });
const goodAnswer = { name: 'Kids Taekwondo', summary: 'Three belts from white to black with 24 classes at each.', ranks: [belt('White belt', '#FFFFFF'), belt('Yellow belt', '#FACC15'), belt('Black belt', '#111111', 0, 0)] };

async function makeOrg(label) {
  const o = { label, id: K(), school: K(), user: K(), principal: K(), role: K(), subject: `rc1-${label}-${K()}`, policy: K() };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'RC1 synthetic organization','RC1 synthetic organization')", [o.id]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'Synthetic Dojo',$1::uuid::text,'UTC')", [o.school, o.id]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day')", [o.id]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','RC1 synthetic owner')", [o.user, o.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'RC1 synthetic owner')", [o.principal, o.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','RC1 synthetic owner',true)", [o.role, o.id]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions', [o.role, o.id]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')", [o.id, o.school, o.principal, o.role]);
  await admin.query("INSERT INTO hon.hq_ai_routing_policies(policy_id,organization_id,school_id,capability,active,minimum_tier,max_cost_micros,effective_from) VALUES($1,$2,$3,'TEXT',true,'COMPLETE',150000,'2020-01-01')", [o.policy, o.id, o.school]);
  await admin.query('INSERT INTO hon.hq_ai_routing_candidates(policy_id,ordinal,catalog_id) VALUES($1,0,$2)', [o.policy, catalog]);
  await admin.query('COMMIT');
  return o;
}
async function addStaff(o, label, permissions) {
  const s = { ...o, user: K(), principal: K(), role: K(), subject: `rc1-${label}-${K()}` };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','RC1 synthetic staff')", [s.user, s.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'RC1 synthetic staff')", [s.principal, s.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,'RC1 synthetic staff',false)", [s.role, o.id, 'RC1_' + label.toUpperCase()]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,unnest($3::text[])', [s.role, o.id, permissions]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day')", [o.id, o.school, s.principal, s.role, o.principal]);
  await admin.query('COMMIT');
  return s;
}
const ledger = (id) => rows('SELECT customer_credits::int c, provider_cost_microunits::bigint cost, spend_class, school_id FROM hon.ai_usage_ledger WHERE source_invocation_id=$1', [id]);
const proposalRow = (id) => row('SELECT * FROM hon.ai_text_proposals WHERE id=$1', [id]);
const curricula = (o) => row('SELECT (SELECT count(*) FROM hon.curricula WHERE school_id=$1)::int programs, (SELECT count(*) FROM hon.curriculum_ranks WHERE school_id=$1)::int belts', [o.school]);

try {
  await admin.connect();
  assert.equal((await row('SELECT current_database() d')).d, database);

  // 1. Custody: the RANK_CHART kind is fixed; the runtime executes exactly the seven entry points; nothing to PUBLIC.
  const entry = ['begin_rank_chart_draft', 'plan_rank_chart_draft', 'prepare_rank_chart_draft', 'fail_rank_chart_draft', 'record_rank_chart_draft', 'read_rank_chart_drafts', 'close_rank_chart_draft'];
  const fns = await rows("SELECT p.oid, p.proname, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%rank_chart%'");
  assert.equal(fns.length, 12, fns.map((f) => f.proname).join(','));
  for (const f of fns) {
    assert.equal((await row("SELECT has_function_privilege($1,$2::oid,'EXECUTE') ok", [runtimeRole, f.oid])).ok, entry.includes(f.proname), f.proname);
    assert.equal((await row("SELECT coalesce(bool_or(a.grantee=0),false) pub FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1", [f.oid])).pub, false, f.proname);
    if (entry.includes(f.proname)) assert.equal(f.prosecdef, true, f.proname);
  }
  const kind = await row("SELECT * FROM hon.ai_text_kinds WHERE kind='RANK_CHART'");
  assert.deepEqual([kind.agent_key, kind.task_class, kind.input_budget, kind.output_budget, Number(kind.max_cost_microunits), kind.max_result_bytes, kind.caller, kind.subject_type, kind.usage_agent],
    ['kai', 'DRAFT_TEACHING', 16000, 5000, 150000, 12288, 'HUMAN_UI', 'SCHOOL', 'RANK_CHART']);
  await assert.rejects(admin.query("UPDATE hon.ai_text_kinds SET output_budget=9000 WHERE kind='RANK_CHART'"));
  pass('custody: RANK_CHART kind fixed (kai, DRAFT_TEACHING, 16,000/5,000, 150,000 micro-USD), runtime executes exactly seven definer entry points, nothing to PUBLIC');

  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state,credential_secret_ref) VALUES('OPENROUTER','RC1 synthetic route','HEALTHY',$1)", [`hon-secret:${K()}`]);
  await admin.query("INSERT INTO hon.hq_ai_model_catalog(catalog_id,provider_id,model_id,display_name,capabilities,modalities,active,minimum_tier,unit_cost_micros,cost_unit,effective_from) VALUES($1,'OPENROUTER','approved/rc1-synthetic','RC1 synthetic model',ARRAY['TEXT'],ARRAY['TEXT'],true,'COMPLETE',2,'TOKEN','2020-01-01')", [catalog]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','RC1 synthetic HQ owner')", [hq.user, hq.subject]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','RC1 synthetic HQ owner',true)", [hq.id, hq.user]);
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER','{}',clock_timestamp()-interval '2 days')", [hq.id]);
  await admin.query('COMMIT');

  // 2. Ask: one plan, one provider call with the description and program names only, one ledger row, the draft recorded;
  //    no program or belt is created.
  const a = await makeOrg('a');
  await setup.command(ctx(a), 'PROGRAM_SETUP', null, null, { name: 'Adult Karate', ranks: [belt('White', '#FFFFFF', 0, 0)] });
  const before = await curricula(a);
  fake.answer = goodAnswer;
  const c1 = ctx(a);
  const v1 = await ai.request(c1, brief);
  assert.equal(v1.status, 'RESULT_RECORDED', JSON.stringify(v1)); assert.deepEqual(v1.draft, goodAnswer); assert.deepEqual(v1.problems, []); assert.equal(v1.mine, true); assert.deepEqual(v1.brief, brief);
  assert.equal(fake.calls, 1);
  const sent = JSON.parse(fake.inputs[0].request);
  assert.deepEqual(sent, { brief, existingPrograms: ['Adult Karate'] });
  assert.equal(/example\.test|Synthetic Dojo|RC1/.test(fake.inputs[0].request), false, 'no person, staff or school name is sent');
  assert.deepEqual([fake.inputs[0].inputBudget, fake.inputs[0].outputBudget, fake.inputs[0].maxCostMicrounits, fake.inputs[0].modelId], [16000, 5000, 150000, 'approved/rc1-synthetic']);
  const r1 = await proposalRow(v1.id);
  assert.deepEqual([r1.status, r1.reserved_credits, r1.kind, r1.school_id, r1.subject_id], ['RESULT_RECORDED', 0, 'RANK_CHART', a.school, a.school]);
  const plan = await row('SELECT agent_key, task_class, input_budget, output_budget FROM hon.ai_invocation_plans WHERE id=$1', [r1.plan_id]);
  assert.deepEqual(plan, { agent_key: 'kai', task_class: 'DRAFT_TEACHING', input_budget: 16000, output_budget: 5000 });
  const used = await ledger(v1.id);
  assert.equal(used.length, 1); assert.deepEqual([used[0].cost, used[0].spend_class, used[0].school_id], ['900', 'AGENT_INFERENCE', a.school]);
  assert.deepEqual(await curricula(a), before, 'a draft creates nothing');
  const replay = await ai.request({ ...c1, requestId: K(), correlationId: K() }, brief);
  assert.equal(replay.id, v1.id); assert.equal(fake.calls, 1);
  assert.equal(code(await settle(ai.request({ ...c1, requestId: K(), correlationId: K() }, { description: 'Something else entirely' }))), 'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await ai.request(ctx(a), { description: brief.description })).brief.current, null, 'a first turn without a list is stored with current null');
  pass('ask: one plan (kai, DRAFT_TEACHING, 16,000/5,000), one call with the description and program names only, one ledger row, the draft recorded, nothing created, key replay safe');

  // 2b. Conversation: a later turn sends the list on screen with what to change. It is its own request (plan, call, ledger
  //     row); Kai gets the words, that list and the program names; the answer is a whole chart and still creates nothing.
  {
    const n = fake.calls, current = { name: goodAnswer.name, ranks: goodAnswer.ranks };
    const changed = { name: goodAnswer.name, summary: 'Added a green belt before black.', ranks: [...goodAnswer.ranks.slice(0, -1), belt('Green belt', '#16A34A', 30, 90), goodAnswer.ranks.at(-1)] };
    fake.answer = changed;
    const turn = { description: 'Add a green belt before black.', current };
    const v2 = await ai.request(ctx(a), turn);
    assert.equal(v2.status, 'RESULT_RECORDED', JSON.stringify(v2)); assert.deepEqual(v2.draft, changed); assert.deepEqual(v2.brief, turn); assert.notEqual(v2.id, v1.id); assert.equal(fake.calls, n + 1);
    assert.deepEqual(JSON.parse(fake.inputs.at(-1).request), { brief: turn, existingPrograms: ['Adult Karate'] });
    const r2 = await proposalRow(v2.id); assert.notEqual(r2.plan_id, r1.plan_id); assert.equal((await ledger(v2.id)).length, 1);
    assert.deepEqual(await curricula(a), before, 'a conversation creates nothing');
    // The list must be the chart shape and short enough to send; anything else is refused before any row or call.
    const rowsBefore = (await row("SELECT count(*)::int n FROM hon.ai_text_proposals WHERE organization_id=$1", [a.id])).n;
    const long = { name: 'Long', ranks: Array.from({ length: 60 }, (_, i) => belt(`${'Rank '.repeat(20)}${i}`, '#FFFFFF', 10, 10)) };
    for (const bad of [{ ...current, summary: 'x' }, { name: current.name }, { ...current, ranks: [] }, { ...current, ranks: [belt('White', null, 0, 0), belt('WHITE', null, 0, 0)] }, { ...current, ranks: [belt('White', '#ffffff', 0, 0)] }, long, 'text', []])
      assert.equal(code(await settle(ai.request(ctx(a), { description: 'Change it.', current: bad }))), 'RANK_CHART_INVALID', JSON.stringify(bad).slice(0, 80));
    // The database refuses the same shapes even if a caller skipped the API check.
    for (const bad of [{ description: 'Change it.' }, { description: 'Change it.', current: long }, { description: 'Change it.', current: { ...current, summary: 'x' } }])
      assert.equal((await row('SELECT hon.rank_chart_brief_ok($1::jsonb) ok', [JSON.stringify(bad)])).ok, false);
    assert.equal((await row('SELECT hon.rank_chart_brief_ok($1::jsonb) ok', [JSON.stringify(turn)])).ok, true);
    assert.equal((await row("SELECT count(*)::int n FROM hon.ai_text_proposals WHERE organization_id=$1", [a.id])).n, rowsBefore); assert.equal(fake.calls, n + 1);
    pass('conversation: a later turn sends the words and the list on screen, is its own plan, call and ledger row, answers with a whole chart and creates nothing; a list that is not the chart shape or is over 8,000 bytes is refused before any row or call');
  }

  // 3. Save and close: the draft is exactly a quick setup input; saving is the person's ordinary 0622 command; then the
  //    requester marks the draft used. Closed stays closed; others cannot move it.
  const saved = await setup.command(ctx(a), 'PROGRAM_SETUP', null, null, { name: v1.draft.name, ranks: v1.draft.ranks });
  assert.deepEqual(saved.record.ranks.map((k) => [k.name, k.color, k.classes, k.days]), goodAnswer.ranks.map((k) => [k.name, k.color, k.classes, k.days]));
  const coOwner = await addStaff(a, 'coowner', (await rows('SELECT code FROM hon.permissions')).map((p) => p.code));
  assert.equal((await ai.read(readCtx(coOwner), v1.id)).mine, false);
  assert.equal((await settle(ai.close(ctx(coOwner), v1.id, 'APPLIED'))).error?.getStatus(), 404);
  assert.equal((await ai.close(ctx(a), v1.id, 'APPLIED')).status, 'APPLIED');
  assert.equal((await ai.close(ctx(a), v1.id, 'APPLIED')).status, 'APPLIED', 'replay');
  assert.equal(code(await settle(ai.close(ctx(a), v1.id, 'DISMISSED'))), 'RANK_CHART_NOT_OPEN');
  pass('save: a draft is accepted unchanged by the 0622 quick setup command; only the requester marks it used or dismissed; a replay is a no-op; closed stays closed');

  // 4. A paid answer outside the shape, or holding a link, is RESULT_REJECTED with its usage kept and its problems shown.
  const rejected = async (answer, problem = 'The answer was not a rank chart.') => {
    fake.answer = answer; const v = await ai.request(ctx(a), brief);
    assert.equal(v.status, 'RESULT_REJECTED', JSON.stringify(answer).slice(0, 120)); assert.deepEqual(v.problems, [problem]); assert.equal(v.draft, null); assert.equal((await ledger(v.id)).length, 1);
    return v;
  };
  const bad = await rejected({ name: 'Wrong', summary: 'Wrong shape', ranks: [{ name: 'White' }] });
  await rejected({ ...goodAnswer, ranks: [] });
  await rejected({ ...goodAnswer, ranks: [belt('White', '#FFFFFF'), belt('white', null)] });
  await rejected({ ...goodAnswer, ranks: [belt('White', 'red')] });
  await rejected({ ...goodAnswer, ranks: [belt('White', '#FFFFFF', 2001, 0)] });
  await rejected({ ...goodAnswer, ranks: [belt('White', '#FFFFFF', 1.5, 0)] });
  await rejected({ ...goodAnswer, ranks: [belt('<b>White</b>', '#FFFFFF')] });
  await rejected({ ...goodAnswer, ranks: [{ ...belt('White', '#FFFFFF'), fee: 40 }] });
  await rejected({ ...goodAnswer, ranks: Array.from({ length: 61 }, (_, i) => belt(`Belt ${i}`, null)) });
  await rejected(null);
  const linked = await rejected({ ...goodAnswer, summary: 'See https://example.test/ranks for the full chart.' }, 'The answer holds a link or an email address.');
  assert.equal((await ai.close(ctx(a), linked.id, 'DISMISSED')).status, 'DISMISSED');
  assert.equal(code(await settle(ai.close(ctx(a), bad.id, 'APPLIED'))), 'RANK_CHART_NOT_OPEN');
  // Lower-case colors and padded names are tidied; the largest chart (60 ranks) is accepted.
  fake.answer = { name: ' Judo ', summary: 'Two ranks.', ranks: [belt(' White ', '#ffffff'), belt('Black', null, 0, 0)] };
  const tidy = await ai.request(ctx(a), brief);
  assert.equal(tidy.status, 'RESULT_RECORDED'); assert.deepEqual([tidy.draft.name, tidy.draft.ranks[0].name, tidy.draft.ranks[0].color], ['Judo', 'White', '#FFFFFF']);
  fake.answer = { ...goodAnswer, ranks: Array.from({ length: 60 }, (_, i) => belt(`Belt number ${i + 1} with a long descriptive name`, '#2563EB', 2000, 3650)) };
  assert.equal((await ai.request(ctx(a), brief)).status, 'RESULT_RECORDED');
  pass('rejected: an answer outside the chart shape (missing fields, no rank, repeated names, a bad color or number, markup, an extra field, 61 ranks, not JSON) or holding a link keeps its usage, shows its problem and can never be marked used; small slips are tidied; 60 ranks fit');

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

  // 6. HQ usage: rank chart drafts count under their own agent.
  const usage = (await row('SELECT hon.read_ai_school_usage_from_hq($1,$2::timestamptz,$3::timestamptz) r', [hq.subject, new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString()])).r;
  const by = usage.schools.find((s) => s.schoolId === a.school).byClass.AGENT_INFERENCE.byAgent;
  assert.equal(by.RANK_CHART.credits > 0, true, JSON.stringify(by)); assert.equal(by.TEACHING, undefined); assert.equal(by.MARKETING, undefined);
  pass('usage: the HQ per-school read attributes rank chart drafts to RANK_CHART');

  // 6b. Size: the longest three-byte (Korean) words, the longest list that may be sent and 20 long program names fit the
  //     input budget with the prompt.
  {
    const k = await makeOrg('k');
    for (let i = 0; i < 22; i += 1) await setup.command(ctx(k), 'PROGRAM_CREATE', null, null, { name: `${'가'.repeat(110)} ${String(i).padStart(2, '0')}` });
    const ranks = []; const size = () => Buffer.byteLength(JSON.stringify({ name: 'x'.repeat(120), ranks }));
    while (size() < 7800) ranks.push(belt(`${'가'.repeat(40)} ${ranks.length}`, '#FFFFFF', 2000, 3650));
    fake.answer = goodAnswer; const n = fake.calls;
    const vk = await ai.request(ctx(k), { description: '가'.repeat(600), current: { name: 'x'.repeat(120), ranks } });
    assert.equal(vk.status, 'RESULT_RECORDED', JSON.stringify(vk).slice(0, 300)); assert.equal(fake.calls, n + 1);
    const req = fake.inputs.at(-1).request;
    assert.equal(JSON.parse(req).existingPrograms.length, 20);
    assert.equal(req.includes('\ufffd'), false, 'no name is cut inside a character');
    // The runtime sends only when prompt + request + 128 fits the 16,000 input budget.
    assert.equal(Buffer.byteLength(RANK_CHART_SYSTEM_PROMPT + req, 'utf8') + 128 <= 16000, true, String(Buffer.byteLength(RANK_CHART_SYSTEM_PROMPT + req, 'utf8')));
    pass(`size: 600 three-byte characters, a ${size()}-byte list and 20 long program names are ${Buffer.byteLength(req)} bytes; with the prompt they fit the 16,000 input budget; names are cut by bytes, never inside a character`);
  }

  // 7. Gates: Complete, Kai, rank setup permission, an HQ pause, school isolation, bad briefs.
  const calls = fake.calls;
  const b = await makeOrg('b');
  await admin.query("UPDATE hon.organization_entitlements SET tier='CORE' WHERE organization_id=$1", [b.id]);
  assert.equal(code(await settle(ai.request(ctx(b), brief))), 'RANK_CHART_FORBIDDEN');
  await admin.query("UPDATE hon.organization_entitlements SET tier='COMPLETE' WHERE organization_id=$1", [b.id]);
  const noKai = await addStaff(b, 'nokai', ['curriculum.manage', 'ai.invocation.plan', 'ai.agent.kai.use']);
  assert.equal(code(await settle(ai.request(ctx(noKai), brief))), 'RANK_CHART_FORBIDDEN');
  // 0635: Kai switched off for this staff member refuses, even with every other permission; switched on it is allowed.
  const kaiOff = await addStaff(b, 'kaioff', ['curriculum.manage', 'teaching.assistant.use', 'ai.invocation.plan']);
  assert.equal(code(await settle(ai.request(ctx(kaiOff), brief))), 'RANK_CHART_FORBIDDEN');
  const noPlan = await addStaff(b, 'noplan', ['curriculum.manage', 'teaching.assistant.use', 'ai.agent.kai.use']);
  assert.equal(code(await settle(ai.request(ctx(noPlan), brief))), 'RANK_CHART_FORBIDDEN');
  const noRanks = await addStaff(b, 'noranks', ['teaching.assistant.use', 'ai.invocation.plan', 'ai.agent.kai.use', 'curriculum.progress.record']);
  assert.equal((await settle(ai.request(ctx(noRanks), brief))).error?.getStatus(), 403);
  assert.equal((await settle(ai.list(readCtx(noRanks)))).error?.getStatus(), 403);
  assert.equal((await ai.list(readCtx(noKai))).length, 0, 'anyone who may set up ranks may read the list');
  assert.equal((await row('SELECT count(*)::int n FROM hon.ai_text_proposals WHERE organization_id=$1', [b.id])).n, 0);
  for (const badBrief of [{ description: '' }, { description: ' padded ' }, { description: 'x'.repeat(601) }, { description: 'api_key: abc' }, { description: 'ok', extra: 1 }, {}, null, 'text'])
    assert.equal(code(await settle(ai.request(ctx(b), badBrief))), 'RANK_CHART_INVALID', JSON.stringify(badBrief));
  assert.equal(code(await settle(ai.request(ctx(b, { principalType: 'AI_EMPLOYEE' }), brief))), 'HUMAN_COMMAND_REQUIRED');
  // The other school's draft is not reachable from here, by read, plan or close.
  const tenant = (o, work) => db.withTenantTransaction(ctx(o), async (c) => { await c.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [o.subject]); return work(c); });
  assert.equal((await settle(ai.read(readCtx(b), v1.id))).error?.getStatus(), 404);
  assert.equal((await settle(tenant(b, async (c) => c.query('SELECT hon.plan_rank_chart_draft($1,$2::uuid)', [b.subject, lost.id])))).error?.message, 'AI_TEXT_PROPOSAL_NOT_FOUND');
  assert.equal((await settle(ai.close(ctx(b), refused.id, 'DISMISSED'))).error?.getStatus(), 404);
  assert(!(await ai.list(readCtx(b))).some((x) => x.id === v1.id));
  assert.equal((await ai.list(readCtx(a))).length, 5, 'the list holds the newest five');
  const pause = await settle(admin.query('SELECT hon.command_ai_spend_pause($1,$2::jsonb,$3::uuid) r', [hq.subject, JSON.stringify({ action: 'PAUSE', organizationId: b.id, spendClass: 'AGENT_INFERENCE', reason: 'RC1 synthetic pause for this proof' }), K()]));
  assert.equal(pause.value?.rows[0].r.status, 'ACTIVE', pause.error?.message);
  const paused = await settle(ai.request(ctx(b), brief));
  assert.deepEqual([code(paused), paused.error?.getResponse().reason], ['RANK_CHART_SPEND_STOPPED', 'AI_PAUSED_BY_HQ']); assert.equal(fake.calls, calls);
  assert.equal(networkCalls, 0);
  pass('gates: Core plan, staff without Kai, without AI planning or without rank setup are refused before any row; bad briefs and non-human callers are refused; an HQ pause refuses with no call; schools are isolated');

  { const verify = await (await import('node:fs/promises')).readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
    const section = verify.split('-- Rank chart AI draft exact verification (0636)')[1]?.split('-- End rank chart AI draft exact verification.')[0];
    assert.ok(section, '0636 verify section present');
    await admin.query(section.slice(section.indexOf('\nDO $$')).replaceAll('hon_runtime', runtimeRole));
    await admin.query(verify.replaceAll('hon_runtime', runtimeRole)); }
  pass('011: the 0636 exact verification (bodies, definer, ACLs, kind row) and the whole canonical 011 pass');
  console.log(`RC1 rank chart AI draft: ${groups} groups passed, ${fake.calls} fake provider calls, 0 network calls`);
} finally {
  await admin.end().catch(() => {});
  await db.onModuleDestroy?.().catch?.(() => {});
}
