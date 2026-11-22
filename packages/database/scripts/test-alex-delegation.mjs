/**
 * P1 (0639): Alex delegation plans on the shared AI text proposal table, through the real API service, the restricted runtime
 * role and the S4 spend controls on a fresh disposable AI-0 fixture. The provider is a counted in-process fake: nothing leaves
 * the machine, and fetch is refused. Synthetic names only.
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
const { AlexPlanService } = await import('../../../apps/api/dist/alex-delegation/alex-plan.service.js');
const { MerchProviderRuntimeError } = await import('../../../apps/api/dist/commerce/shopify/merch-provider-runtime.js');

const admin = new pg.Client({ connectionString: ownerUrl, ssl: false });
const row = async (sql, args = []) => (await admin.query(sql, args)).rows[0];
const rows = async (sql, args = []) => (await admin.query(sql, args)).rows;
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
const code = (r) => r.error?.getResponse?.().code;
let groups = 0; const pass = (name) => console.log(`PASS AX1 ${++groups} ${name}`);

const fake = { calls: 0, inputs: [], mode: 'OK', answer: null, ready: true };
const provider = {
  readiness: () => (fake.ready ? 'READY' : 'CONFIGURATION_REQUIRED'),
  generate: async (input) => {
    fake.calls += 1; fake.inputs.push(input);
    if (fake.mode === 'UNKNOWN') throw new MerchProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    if (fake.mode === 'FAILED') throw new MerchProviderRuntimeError('FAILED', 'PROVIDER_REJECTED');
    return { proposal: typeof fake.answer === 'function' ? fake.answer(JSON.parse(input.request)) : fake.answer, inputTokens: 1500, outputTokens: 600, providerCostMicrounits: 1200 };
  },
};
const db = new RuntimeDatabaseService(), plans = new AiInvocationPlanService(db), alex = new AlexPlanService(db, plans, provider);
const catalog = K(), hq = { id: K(), user: K(), subject: `ax1-hq-owner-${K()}` };
const ctx = (o, patch = {}) => ({ organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: K(), correlationId: K(), idempotencyKey: K(), ...patch });
const readCtx = (o) => ctx(o, { idempotencyKey: '' });
const brief = { goal: 'Get ten more trial bookings before the spring belt test', horizon: 'WEEK' };
const task = (patch = {}) => ({ title: 'Call last month’s trial leads', description: 'Phone each trial lead who did not book a second class and offer a time.', priority: 'HIGH', assignee: null, dueInDays: 2, area: 'chad', ...patch });
const goodAnswer = { summary: 'Focus on follow-up and one bring-a-friend week.', tasks: [task({ assignee: 'S2' }), task({ title: 'Plan a bring-a-friend week', area: 'marcus', priority: 'NORMAL', dueInDays: null }), task({ title: 'Check class capacity', area: 'jordan', assignee: 'S1', dueInDays: 0 })] };

async function makeOrg(label) {
  const o = { label, id: K(), school: K(), user: K(), principal: K(), role: K(), subject: `ax1-${label}-${K()}`, policy: K() };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'AX1 synthetic organization','AX1 synthetic organization')", [o.id]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'Synthetic Dojo',$1::uuid::text,'America/New_York')", [o.school, o.id]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day')", [o.id]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','Avery Synthowner')", [o.user, o.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Avery Synthowner')", [o.principal, o.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','AX1 synthetic owner',true)", [o.role, o.id]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions', [o.role, o.id]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '3 days')", [o.id, o.school, o.principal, o.role]);
  await admin.query("INSERT INTO hon.hq_ai_routing_policies(policy_id,organization_id,school_id,capability,active,minimum_tier,max_cost_micros,effective_from) VALUES($1,$2,$3,'TEXT',true,'COMPLETE',150000,'2020-01-01')", [o.policy, o.id, o.school]);
  await admin.query('INSERT INTO hon.hq_ai_routing_candidates(policy_id,ordinal,catalog_id) VALUES($1,0,$2)', [o.policy, catalog]);
  await admin.query('COMMIT');
  return o;
}
async function addStaff(o, label, permissions, name, since = '2 days') {
  const s = { ...o, user: K(), principal: K(), role: K(), subject: `ax1-${label}-${K()}`, name };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test',$3)", [s.user, s.subject, name]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3)", [s.principal, s.user, name]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,'AX1 synthetic staff',false)", [s.role, o.id, 'AX1_' + label.toUpperCase()]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,unnest($3::text[])', [s.role, o.id, permissions]);
  await admin.query(`INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '${since}')`, [o.id, o.school, s.principal, s.role, o.principal]);
  await admin.query('COMMIT');
  return s;
}
const ledger = (id) => rows('SELECT customer_credits::int c, provider_cost_microunits::bigint cost, spend_class, school_id FROM hon.ai_usage_ledger WHERE source_invocation_id=$1', [id]);
const proposalRow = (id) => row('SELECT * FROM hon.ai_text_proposals WHERE id=$1', [id]);
const madeTasks = (o) => rows("SELECT title, description, priority, due_at, assigned_principal_id, created_by_principal_id, work_origin FROM hon.work_items WHERE organization_id=$1 AND school_id=$2 AND work_origin='HUMAN_UI' ORDER BY created_at, title", [o.id, o.school]);

try {
  await admin.connect();
  assert.equal((await row('SELECT current_database() d')).d, database);

  // 1. Custody: the kind is fixed; the runtime executes exactly the eight entry points; nothing to PUBLIC; the tables are closed.
  const entry = ['begin_alex_plan', 'plan_alex_plan', 'prepare_alex_plan', 'fail_alex_plan', 'record_alex_plan', 'read_alex_plans', 'create_alex_plan_tasks', 'close_alex_plan'];
  const fns = await rows("SELECT p.oid, p.proname, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%alex_plan%'");
  assert.equal(fns.length, 19, fns.map((f) => f.proname).join(','));
  for (const f of fns) {
    assert.equal((await row("SELECT has_function_privilege($1,$2::oid,'EXECUTE') ok", [runtimeRole, f.oid])).ok, entry.includes(f.proname), f.proname);
    assert.equal((await row("SELECT coalesce(bool_or(a.grantee=0),false) pub FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1", [f.oid])).pub, false, f.proname);
    if (entry.includes(f.proname)) assert.equal(f.prosecdef, true, f.proname);
  }
  for (const t of ['alex_plan_staff_refs', 'alex_plan_created_tasks']) {
    const c = await row("SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE oid=('hon.'||$1)::regclass", [t]);
    assert.deepEqual([c.r, c.f], [true, true], t);
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.equal((await row('SELECT has_table_privilege($1,$2,$3) ok', [runtimeRole, `hon.${t}`, priv])).ok, false, `${t} ${priv}`);
  }
  const kind = await row("SELECT * FROM hon.ai_text_kinds WHERE kind='ALEX_DELEGATION_PLAN'");
  assert.deepEqual([kind.agent_key, kind.task_class, kind.input_budget, kind.output_budget, Number(kind.max_cost_microunits), kind.max_result_bytes, kind.caller, kind.subject_type, kind.usage_agent],
    ['alex', 'ANALYZE', 12000, 3000, 80000, 12288, 'HUMAN_UI', 'SCHOOL', 'GENERAL_MANAGEMENT']);
  await assert.rejects(admin.query("UPDATE hon.ai_text_kinds SET output_budget=9000 WHERE kind='ALEX_DELEGATION_PLAN'"));
  pass('custody: ALEX_DELEGATION_PLAN kind fixed (alex, ANALYZE, 12,000/3,000, 80,000 micro-USD, GENERAL_MANAGEMENT), runtime executes exactly eight definer entry points, nothing to PUBLIC, both tables forced RLS with no runtime access');

  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state,credential_secret_ref) VALUES('OPENROUTER','AX1 synthetic route','HEALTHY',$1) ON CONFLICT (provider_id) DO NOTHING", [`hon-secret:${K()}`]);
  await admin.query("INSERT INTO hon.hq_ai_model_catalog(catalog_id,provider_id,model_id,display_name,capabilities,modalities,active,minimum_tier,unit_cost_micros,cost_unit,effective_from) VALUES($1,'OPENROUTER','approved/ax1-synthetic','AX1 synthetic model',ARRAY['TEXT'],ARRAY['TEXT'],true,'COMPLETE',2,'TOKEN','2020-01-01')", [catalog]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','AX1 synthetic HQ owner')", [hq.user, hq.subject]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','AX1 synthetic HQ owner',true)", [hq.id, hq.user]);
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER','{}',clock_timestamp()-interval '2 days')", [hq.id]);
  await admin.query('COMMIT');

  // 2. Ask: one plan, one provider call with aliases only, one ledger row, the plan recorded; no work item is made yet.
  const a = await makeOrg('a');
  const coach = await addStaff(a, 'coach', ['work_item.self_manage'], 'Jordan Synthcoach', '2 days');
  const desk = await addStaff(a, 'desk', ['work_item.self_manage'], 'Riley Synthdesk', '1 day');
  const reporter = await addStaff(a, 'parentish', ['reporting.view'], 'Not Staff Synthperson', '1 day');
  fake.answer = goodAnswer;
  const c1 = ctx(a);
  const v1 = await alex.request(c1, brief);
  assert.equal(v1.status, 'RESULT_RECORDED', JSON.stringify(v1)); assert.deepEqual(v1.tasks, goodAnswer.tasks); assert.equal(v1.summary, goodAnswer.summary);
  assert.deepEqual(v1.problems, []); assert.equal(v1.mine, true); assert.deepEqual(v1.brief, brief); assert.deepEqual(v1.created, []);
  assert.deepEqual(v1.staff.map((s) => [s.ref, s.name]), [['S1', 'Avery Synthowner'], ['S2', 'Jordan Synthcoach'], ['S3', 'Riley Synthdesk']]);
  assert.equal(fake.calls, 1);
  const sent = JSON.parse(fake.inputs[0].request);
  assert.deepEqual(Object.keys(sent).sort(), ['brief', 'localToday', 'school', 'schoolName', 'staff']);
  assert.deepEqual(sent.brief, brief); assert.equal(sent.schoolName, 'Synthetic Dojo'); assert.match(sent.localToday, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(sent.staff, [{ ref: 'S1', role: 'Manager', openTasks: 0 }, { ref: 'S2', role: 'Staff', openTasks: 0 }, { ref: 'S3', role: 'Staff', openTasks: 0 }]);
  assert.ok(sent.school && typeof sent.school === 'object' && 'commandCenter' in sent.school, JSON.stringify(sent.school).slice(0, 200));
  assert.equal(/Synth(owner|coach|desk|person)|example\.test|ax1-/.test(fake.inputs[0].request), false, 'no staff name, email or subject is sent');
  assert.equal(Buffer.byteLength(fake.inputs[0].request) < 12000 - 128 - 2500, true, String(Buffer.byteLength(fake.inputs[0].request)));
  assert.deepEqual([fake.inputs[0].inputBudget, fake.inputs[0].outputBudget, fake.inputs[0].maxCostMicrounits, fake.inputs[0].modelId], [12000, 3000, 80000, 'approved/ax1-synthetic']);
  const r1 = await proposalRow(v1.id);
  assert.deepEqual([r1.status, r1.reserved_credits, r1.kind, r1.school_id, r1.subject_id], ['RESULT_RECORDED', 0, 'ALEX_DELEGATION_PLAN', a.school, a.school]);
  assert.deepEqual(await row('SELECT agent_key, task_class, input_budget, output_budget FROM hon.ai_invocation_plans WHERE id=$1', [r1.plan_id]), { agent_key: 'alex', task_class: 'ANALYZE', input_budget: 12000, output_budget: 3000 });
  assert.deepEqual(await ledger(v1.id), [{ c: 3, cost: '1200', spend_class: 'AGENT_INFERENCE', school_id: a.school }]);
  assert.deepEqual(await madeTasks(a), [], 'a plan alone creates nothing');
  const replay = await alex.request({ ...c1, requestId: K(), correlationId: K() }, brief);
  assert.equal(replay.id, v1.id); assert.equal(fake.calls, 1);
  assert.equal(code(await settle(alex.request({ ...c1, requestId: K(), correlationId: K() }, { ...brief, horizon: 'MONTH' }))), 'IDEMPOTENCY_KEY_REUSED');
  pass('ask: one plan (alex, ANALYZE, 12,000/3,000), one call with staff as S1..S3 aliases only (no name, email or non-staff person), one ledger row, the plan recorded, no task made, key replay safe');

  // 3. Create: only the ticked tasks become 0084 work items created by the requester; aliases map to people; replay is exact.
  const coOwner = await addStaff(a, 'coowner', (await rows('SELECT code FROM hon.permissions')).map((p) => p.code), 'Casey Synthpartner', '1 day');
  assert.equal((await alex.read(readCtx(coOwner), v1.id)).mine, false);
  // A reports-only reader never sees someone else's goal or the staff roster: not in the list, and not by id.
  assert.deepEqual(await alex.list(readCtx(reporter)), []);
  assert.equal((await settle(alex.read(readCtx(reporter), v1.id))).error?.getStatus(), 404);
  assert.deepEqual((await alex.list(readCtx(coOwner))).map((x) => x.id), [v1.id], 'a team task manager sees every plan');
  assert.equal((await settle(alex.create(ctx(coOwner), v1.id, { tasks: [0] }))).error?.getStatus(), 404, 'only the requester creates');
  assert.equal(code(await settle(alex.create(ctx(a), v1.id, { tasks: [0, 0] }))), 'ALEX_PLAN_INVALID');
  assert.equal(code(await settle(alex.create(ctx(a), v1.id, { tasks: [5] }))), 'ALEX_PLAN_INVALID');
  const ck = ctx(a);
  const made = await alex.create(ck, v1.id, { tasks: [2, 0] });
  assert.equal(made.replayed, false); assert.equal(made.plan.status, 'APPLIED'); assert.deepEqual(made.plan.created.map((x) => x.index), [0, 2]);
  const items = await madeTasks(a);
  assert.equal(items.length, 2);
  const byTitle = Object.fromEntries(items.map((i) => [i.title, i]));
  const first = byTitle['Call last month’s trial leads'], third = byTitle['Check class capacity'];
  assert.equal(first.assigned_principal_id, coach.principal); assert.equal(third.assigned_principal_id, a.principal);
  assert.equal(first.created_by_principal_id, a.principal); assert.equal(first.priority, 'HIGH');
  assert.equal(first.description, 'Phone each trial lead who did not book a second class and offer a time. Suggested by Alex.');
  // Due at 17:00 New York time, two days and zero days from the school's today.
  const due = await row("SELECT to_char(($1::timestamptz) AT TIME ZONE 'America/New_York','HH24:MI') h, (($1::timestamptz) AT TIME ZONE 'America/New_York')::date - (clock_timestamp() AT TIME ZONE 'America/New_York')::date d", [first.due_at]);
  assert.deepEqual([due.h, due.d], ['17:00', 2]);
  assert.equal((await row("SELECT (($1::timestamptz) AT TIME ZONE 'America/New_York')::date - (clock_timestamp() AT TIME ZONE 'America/New_York')::date d", [third.due_at])).d, 0);
  const again = await alex.create({ ...ck, requestId: K(), correlationId: K() }, v1.id, { tasks: [0, 2] });
  assert.equal(again.replayed, true); assert.equal((await madeTasks(a)).length, 2);
  assert.equal(code(await settle(alex.create(ctx(a), v1.id, { tasks: [1] }))), 'ALEX_PLAN_NOT_OPEN');
  assert.equal(code(await settle(alex.dismiss(ctx(a), v1.id))), 'ALEX_PLAN_NOT_OPEN');
  // The tasks are ordinary human work: the coach sees the one given to them in their own queue.
  const coachQueue = await db.withTenantTransaction(ctx(coach), async (c) => { await c.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)");
    return (await c.query("SELECT hon.read_human_work($1,NULL,'mine','ACTIVE',NULL,NULL) d", [coach.subject])).rows[0].d; });
  assert.deepEqual(coachQueue.items.map((i) => i.title), ['Call last month’s trial leads']);
  pass('create: a reports-only reader sees no one else\'s plan, a team task manager does; only the ticked tasks become human work items created by the requester, S2 is the coach, due 17:00 school time, "Suggested by Alex." appended, an exact retry replays, the plan is APPLIED and closed, the coach sees their task');

  // 4. Authority at create: a requester who may create tasks but not manage the team cannot give one to someone else; nothing is made.
  const lead = await addStaff(a, 'lead', ['reporting.view', 'ai.invocation.plan', 'work_item.create', 'work_item.self_manage'], 'Morgan Synthlead', '12 hours');
  const v2 = await alex.request(ctx(lead), brief);
  assert.equal(v2.status, 'RESULT_RECORDED', JSON.stringify(v2));
  const before = (await madeTasks(a)).length;
  assert.equal(code(await settle(alex.create(ctx(lead), v2.id, { tasks: [0, 1] }))), 'ALEX_PLAN_ASSIGN_FORBIDDEN');
  assert.equal((await madeTasks(a)).length, before, 'all or nothing'); assert.equal((await proposalRow(v2.id)).status, 'RESULT_RECORDED');
  assert.equal((await alex.create(ctx(lead), v2.id, { tasks: [1] })).plan.status, 'APPLIED', 'the unassigned task is fine');
  assert.equal((await madeTasks(a)).length, before + 1);
  // A person who lost task access after the plan was made refuses the whole create.
  const v3 = await alex.request(ctx(a), brief);
  await admin.query("UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=$2 WHERE principal_id=$1", [coach.principal, a.principal]);
  assert.equal(code(await settle(alex.create(ctx(a), v3.id, { tasks: [0] }))), 'ALEX_PLAN_ASSIGNEE_UNAVAILABLE');
  assert.equal((await madeTasks(a)).length, before + 1);
  assert.equal((await alex.dismiss(ctx(a), v3.id)).status, 'DISMISSED');
  pass('authority: giving a task to someone else without work_item.manage refuses the whole create; an assignee who lost access refuses it; nothing partial is left; a refused plan can still be used for own tasks or dismissed');

  // 5. A paid answer outside the shape, naming an alias Alex was not given, or holding a link, is RESULT_REJECTED with its usage kept.
  fake.answer = { summary: 'Wrong shape', tasks: [{ title: 'x' }] };
  const bad = await alex.request(ctx(a), brief);
  assert.equal(bad.status, 'RESULT_REJECTED'); assert.deepEqual(bad.problems, ['The answer was not a task plan for this school.']); assert.equal(bad.tasks, null);
  assert.equal((await ledger(bad.id)).length, 1);
  fake.answer = { ...goodAnswer, tasks: [task({ assignee: 'S9' })] };
  const ghost = await alex.request(ctx(a), brief);
  assert.equal(ghost.status, 'RESULT_REJECTED'); assert.deepEqual(ghost.problems, ['The answer was not a task plan for this school.']);
  fake.answer = { ...goodAnswer, tasks: [task({ description: 'Email trial leads at owner@example.test today.' })] };
  const linked = await alex.request(ctx(a), brief);
  assert.equal(linked.status, 'RESULT_REJECTED'); assert.deepEqual(linked.problems, ['The answer holds a link or an email address.']);
  fake.answer = { ...goodAnswer, tasks: Array.from({ length: 9 }, () => task()) };
  assert.equal((await alex.request(ctx(a), brief)).status, 'RESULT_REJECTED');
  assert.equal(code(await settle(alex.create(ctx(a), bad.id, { tasks: [0] }))), 'ALEX_PLAN_NOT_OPEN');
  assert.equal((await alex.dismiss(ctx(a), linked.id)).status, 'DISMISSED');
  pass('rejected: an answer outside the plan shape, with an unknown staff alias, nine tasks, or a link keeps its usage, shows its problems, can be dismissed and never creates tasks');

  // 6. Unknown outcome: the hold stays and appears in the HQ queue as TEXT_PROPOSAL; a refusal or an unconfigured route holds nothing.
  fake.mode = 'UNKNOWN'; fake.answer = goodAnswer;
  const lost = await alex.request(ctx(a), brief);
  assert.equal(lost.status, 'UNKNOWN');
  const lostRow = await proposalRow(lost.id);
  assert.equal(lostRow.reserved_credits > 0, true); assert(lostRow.held_at); assert.equal((await ledger(lost.id)).length, 0);
  const queue = (await row('SELECT hon.read_ai_unknown_invocations_from_hq($1) r', [hq.subject])).r;
  const item = queue.open.find((q) => q.invocationId === lost.id);
  assert.deepEqual([item?.agent, item?.schoolId], ['TEXT_PROPOSAL', a.school]);
  fake.mode = 'FAILED';
  const refused = await alex.request(ctx(a), brief);
  assert.deepEqual([refused.status, refused.reason], ['FAILED', 'PROVIDER_REJECTED']); assert.equal((await proposalRow(refused.id)).reserved_credits, 0);
  fake.mode = 'OK'; fake.ready = false;
  const off = await alex.request(ctx(a), brief);
  assert.deepEqual([off.status, off.reason], ['CONFIGURATION_REQUIRED', 'CONFIGURATION_REQUIRED']); assert.equal((await proposalRow(off.id)).reserved_credits, 0);
  fake.ready = true;
  pass('unknown: a lost outcome keeps its hold and appears in the HQ queue as TEXT_PROPOSAL; a provider refusal or an unconfigured route holds nothing');

  // 7. HQ usage: Alex plans count under Alex's existing GENERAL_MANAGEMENT line.
  const usage = (await row('SELECT hon.read_ai_school_usage_from_hq($1,$2::timestamptz,$3::timestamptz) r', [hq.subject, new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString()])).r;
  const by = usage.schools.find((s) => s.schoolId === a.school).byClass.AGENT_INFERENCE.byAgent;
  assert.ok(by.GENERAL_MANAGEMENT?.credits > 0, JSON.stringify(by)); assert.equal(by.UNATTRIBUTED, undefined);
  pass('usage: the HQ per-school read attributes Alex plans to GENERAL_MANAGEMENT');

  // 8. Gates: Complete, reports, task creation, AI planning, a bad brief, an HQ pause, school isolation.
  const calls = fake.calls;
  const b = await makeOrg('b');
  await admin.query("UPDATE hon.organization_entitlements SET tier='CORE' WHERE organization_id=$1", [b.id]);
  assert.equal(code(await settle(alex.request(ctx(b), brief))), 'ALEX_PLAN_FORBIDDEN');
  await admin.query("UPDATE hon.organization_entitlements SET tier='COMPLETE' WHERE organization_id=$1", [b.id]);
  const noTasks = await addStaff(b, 'notasks', ['reporting.view', 'ai.invocation.plan'], 'Sam Synthviewer');
  assert.equal(code(await settle(alex.request(ctx(noTasks), brief))), 'ALEX_PLAN_FORBIDDEN');
  const noAi = await addStaff(b, 'noai', ['reporting.view', 'work_item.create'], 'Pat Synthnoai');
  assert.equal(code(await settle(alex.request(ctx(noAi), brief))), 'ALEX_PLAN_FORBIDDEN');
  assert.equal((await alex.list(readCtx(noAi))).length, 0, 'a reports reader may read the list');
  assert.equal((await row('SELECT count(*)::int n FROM hon.ai_text_proposals WHERE organization_id=$1', [b.id])).n, 0);
  for (const badBrief of [{ ...brief, horizon: 'YEAR' }, { goal: '', horizon: 'WEEK' }, { ...brief, goal: ' padded' }, { ...brief, goal: 'api_key: abc' }, { ...brief, goal: 'x'.repeat(501) }, { ...brief, extra: 1 }]) {
    assert.equal(code(await settle(alex.request(ctx(b), badBrief))), 'ALEX_PLAN_INVALID', JSON.stringify(badBrief));
  }
  assert.equal(code(await settle(alex.request(ctx(b, { source: 'AI_AGENT' }), brief))), 'HUMAN_COMMAND_REQUIRED');
  assert.equal((await settle(alex.read(readCtx(b), v1.id))).error?.getStatus(), 404);
  assert.equal((await settle(alex.create(ctx(b), v2.id, { tasks: [0] }))).error?.getStatus(), 404);
  assert(!(await alex.list(readCtx(b))).some((x) => x.id === v1.id));
  const pause = await settle(admin.query('SELECT hon.command_ai_spend_pause($1,$2::jsonb,$3::uuid) r', [hq.subject, JSON.stringify({ action: 'PAUSE', organizationId: b.id, spendClass: 'AGENT_INFERENCE', reason: 'AX1 synthetic pause for this proof' }), K()]));
  assert.equal(pause.value?.rows[0].r.status, 'ACTIVE', pause.error?.message);
  const paused = await settle(alex.request(ctx(b), brief));
  assert.deepEqual([code(paused), paused.error?.getResponse().reason], ['ALEX_PLAN_SPEND_STOPPED', 'AI_PAUSED_BY_HQ']); assert.equal(fake.calls, calls);
  assert.equal(networkCalls, 0);
  pass('gates: Core plan, no task creation, or no AI planning is refused before any row; bad briefs and non-human sources are refused; an HQ pause refuses with no call; schools are isolated');

  // 9. Evidence rows cannot be changed.
  await assert.rejects(admin.query('UPDATE hon.alex_plan_staff_refs SET ref=ref WHERE proposal_id=$1', [v1.id]), /ALEX_PLAN_ROWS_IMMUTABLE/);
  await assert.rejects(admin.query('DELETE FROM hon.alex_plan_created_tasks WHERE proposal_id=$1', [v1.id]), /ALEX_PLAN_ROWS_IMMUTABLE/);
  pass('evidence: staff aliases and created-task links are append-only');

  { const verify = await (await import('node:fs/promises')).readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
    const section = verify.split('-- Alex delegation plans exact verification (0639)')[1]?.split('-- End Alex delegation plans exact verification.')[0];
    assert.ok(section, '0639 verify section present');
    await admin.query(section.slice(section.indexOf('\nDO $$')).replaceAll('hon_runtime', runtimeRole));
    await admin.query(verify.replaceAll('hon_runtime', runtimeRole)); }
  pass('011: the 0639 exact verification and the whole canonical 011 pass');
  console.log(`AX1 Alex delegation plans: ${groups} groups passed, ${fake.calls} fake provider calls, 0 network calls`);
} finally {
  await admin.end().catch(() => {});
  await db.onModuleDestroy?.().catch?.(() => {});
}
