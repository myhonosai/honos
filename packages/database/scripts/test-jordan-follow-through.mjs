/**
 * P2 (0640): Jordan follow-through on the shared AI text proposal table, through the real API service, the restricted runtime
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
const { JordanFollowUpService } = await import('../../../apps/api/dist/jordan-follow-through/jordan-follow-up.service.js');
const { MerchProviderRuntimeError } = await import('../../../apps/api/dist/commerce/shopify/merch-provider-runtime.js');

const admin = new pg.Client({ connectionString: ownerUrl, ssl: false });
const row = async (sql, args = []) => (await admin.query(sql, args)).rows[0];
const rows = async (sql, args = []) => (await admin.query(sql, args)).rows;
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
const code = (r) => r.error?.getResponse?.().code;
let groups = 0; const pass = (name) => console.log(`PASS JF1 ${++groups} ${name}`);

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
const db = new RuntimeDatabaseService(), plans = new AiInvocationPlanService(db), jordan = new JordanFollowUpService(db, plans, provider);
const catalog = K(), hq = { id: K(), user: K(), subject: `jf1-hq-owner-${K()}` };
const ctx = (o, patch = {}) => ({ organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: K(), correlationId: K(), idempotencyKey: K(), ...patch });
const readCtx = (o) => ctx(o, { idempotencyKey: '' });
const overdue = { focus: 'OVERDUE', note: '' };
const open = { focus: 'OPEN', note: 'Belt test is Saturday' };
const s = (patch = {}) => ({ item: 'W1', action: 'RESCHEDULE', reason: 'The coach is out until Thursday.', dueInDays: 3, assignee: null, priority: null, ...patch });

async function makeOrg(label) {
  const o = { label, id: K(), school: K(), user: K(), principal: K(), role: K(), subject: `jf1-${label}-${K()}`, policy: K() };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'JF1 synthetic organization','JF1 synthetic organization')", [o.id]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'Synthetic Dojo',$1::uuid::text,'America/New_York')", [o.school, o.id]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day')", [o.id]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','Avery Synthowner')", [o.user, o.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Avery Synthowner')", [o.principal, o.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','JF1 synthetic owner',true)", [o.role, o.id]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions', [o.role, o.id]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '3 days')", [o.id, o.school, o.principal, o.role]);
  await admin.query("INSERT INTO hon.hq_ai_routing_policies(policy_id,organization_id,school_id,capability,active,minimum_tier,max_cost_micros,effective_from) VALUES($1,$2,$3,'TEXT',true,'COMPLETE',150000,'2020-01-01')", [o.policy, o.id, o.school]);
  await admin.query('INSERT INTO hon.hq_ai_routing_candidates(policy_id,ordinal,catalog_id) VALUES($1,0,$2)', [o.policy, catalog]);
  await admin.query('COMMIT');
  return o;
}
async function addStaff(o, label, permissions, name, since = '2 days') {
  const st = { ...o, user: K(), principal: K(), role: K(), subject: `jf1-${label}-${K()}`, name };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test',$3)", [st.user, st.subject, name]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3)", [st.principal, st.user, name]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,'JF1 synthetic staff',false)", [st.role, o.id, 'JF1_' + label.toUpperCase()]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,unnest($3::text[])', [st.role, o.id, permissions]);
  await admin.query(`INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '${since}')`, [o.id, o.school, st.principal, st.role, o.principal]);
  await admin.query('COMMIT');
  return st;
}
// A human task made through the real 0084 path, as the owner, then optionally aged by the migration owner.
async function work(o, title, { assignee = null, dueDays = null, priority = 'NORMAL' } = {}) {
  const c = ctx(o);
  const made = await db.withTenantTransaction(c, async (q) => {
    await q.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [o.subject]);
    const due = dueDays === null ? null : new Date(Date.now() + dueDays * 86_400_000).toISOString();
    return (await q.query("SELECT hon.mutate_human_work($1,'CREATE',NULL,$2::jsonb,$3,$4::uuid,$5::uuid) d",
      [o.subject, JSON.stringify({ expectedVersion: 0, title, description: 'Synthetic task for JF1.', priority, dueAt: due, assigneeId: assignee }), K(), c.requestId, c.correlationId])).rows[0].d;
  });
  return made.workItem.workItemId;
}
async function transition(o, id, version, targetStatus) {
  const c = ctx(o);
  await db.withTenantTransaction(c, async (q) => {
    await q.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [o.subject]);
    await q.query("SELECT hon.mutate_human_work($1,'TRANSITION',$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid)", [o.subject, id, JSON.stringify({ expectedVersion: version, targetStatus }), K(), c.requestId, c.correlationId]);
  });
}
const item = (id) => row('SELECT title, description, priority, due_at, assigned_principal_id, version, status, created_by_principal_id FROM hon.work_items WHERE id=$1', [id]);
const ledger = (id) => rows('SELECT customer_credits::int c, spend_class, school_id FROM hon.ai_usage_ledger WHERE source_invocation_id=$1', [id]);
const proposalRow = (id) => row('SELECT * FROM hon.ai_text_proposals WHERE id=$1', [id]);
const humanCount = (o) => row("SELECT count(*)::int n FROM hon.work_items WHERE organization_id=$1 AND school_id=$2 AND work_origin='HUMAN_UI'", [o.id, o.school]).then((r) => r.n);

try {
  await admin.connect();
  assert.equal((await row('SELECT current_database() d')).d, database);

  // 1. Custody.
  const entry = ['begin_jordan_follow_up', 'plan_jordan_follow_up', 'prepare_jordan_follow_up', 'fail_jordan_follow_up', 'record_jordan_follow_up', 'read_jordan_follow_ups', 'apply_jordan_follow_ups', 'close_jordan_follow_up'];
  const fns = await rows("SELECT p.oid, p.proname, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%jordan_follow_up%'");
  assert.equal(fns.length, 15, fns.map((f) => f.proname).join(','));
  for (const f of fns) {
    assert.equal((await row("SELECT has_function_privilege($1,$2::oid,'EXECUTE') ok", [runtimeRole, f.oid])).ok, entry.includes(f.proname), f.proname);
    assert.equal((await row("SELECT coalesce(bool_or(a.grantee=0),false) pub FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1", [f.oid])).pub, false, f.proname);
    if (entry.includes(f.proname)) assert.equal(f.prosecdef, true, f.proname);
  }
  for (const t of ['jordan_follow_up_refs', 'jordan_follow_up_applied']) {
    const c = await row("SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE oid=('hon.'||$1)::regclass", [t]);
    assert.deepEqual([c.r, c.f], [true, true], t);
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.equal((await row('SELECT has_table_privilege($1,$2,$3) ok', [runtimeRole, `hon.${t}`, priv])).ok, false, `${t} ${priv}`);
  }
  const kind = await row("SELECT * FROM hon.ai_text_kinds WHERE kind='JORDAN_FOLLOW_UP'");
  assert.deepEqual([kind.agent_key, kind.task_class, kind.input_budget, kind.output_budget, Number(kind.max_cost_microunits), kind.max_result_bytes, kind.caller, kind.subject_type, kind.usage_agent],
    ['jordan', 'ANALYZE', 12000, 3000, 80000, 12288, 'HUMAN_UI', 'SCHOOL', 'OPERATIONS']);
  pass('custody: JORDAN_FOLLOW_UP kind fixed (jordan, ANALYZE, 12,000/3,000, 80,000 micro-USD, OPERATIONS), runtime executes exactly eight definer entry points, nothing to PUBLIC, both tables forced RLS with no runtime access');

  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state,credential_secret_ref) VALUES('OPENROUTER','JF1 synthetic route','HEALTHY',$1) ON CONFLICT (provider_id) DO NOTHING", [`hon-secret:${K()}`]);
  await admin.query("INSERT INTO hon.hq_ai_model_catalog(catalog_id,provider_id,model_id,display_name,capabilities,modalities,active,minimum_tier,unit_cost_micros,cost_unit,effective_from) VALUES($1,'OPENROUTER','approved/jf1-synthetic','JF1 synthetic model',ARRAY['TEXT'],ARRAY['TEXT'],true,'COMPLETE',2,'TOKEN','2020-01-01')", [catalog]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','JF1 synthetic HQ owner')", [hq.user, hq.subject]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','JF1 synthetic HQ owner',true)", [hq.id, hq.user]);
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER','{}',clock_timestamp()-interval '2 days')", [hq.id]);
  await admin.query('COMMIT');

  // 2. Ask (OVERDUE): only overdue open tasks are sent as W aliases with title, status, priority, assignee alias and day counts.
  const a = await makeOrg('a');
  const coach = await addStaff(a, 'coach', ['work_item.self_manage'], 'Jordan Synthcoach', '2 days');
  const desk = await addStaff(a, 'desk', ['work_item.self_manage'], 'Riley Synthdesk', '1 day');
  const late1 = await work(a, 'Order new belts for the test', { assignee: coach.principal, dueDays: -2, priority: 'NORMAL' });
  const late2 = await work(a, 'Fix the front door lock', { dueDays: -1, priority: 'LOW' });
  const later = await work(a, 'Plan the spring camp', { assignee: desk.principal, dueDays: 5 });
  const noDue = await work(a, 'Tidy the storage room');
  const done = await work(a, 'Print attendance cards', { dueDays: -3 });
  await transition(a, done, 1, 'WORKING'); await transition(a, done, 2, 'COMPLETED');
  assert.equal((await item(done)).status, 'COMPLETED');
  fake.answer = { summary: 'Two tasks are late.', suggestions: [s({ item: 'W1', action: 'REASSIGN', dueInDays: null, assignee: 'S3' }), s({ item: 'W2', action: 'RESCHEDULE', dueInDays: 1 })] };
  const c1 = ctx(a);
  const v1 = await jordan.request(c1, overdue);
  assert.equal(v1.status, 'RESULT_RECORDED', JSON.stringify(v1)); assert.deepEqual(v1.suggestions, fake.answer.suggestions);
  assert.deepEqual(v1.items.map((i) => [i.ref, i.title]), [['W1', 'Order new belts for the test'], ['W2', 'Fix the front door lock']]);
  assert.deepEqual(v1.staff.map((x) => [x.ref, x.name]), [['S1', 'Avery Synthowner'], ['S2', 'Jordan Synthcoach'], ['S3', 'Riley Synthdesk']]);
  assert.equal(fake.calls, 1);
  const sent = JSON.parse(fake.inputs[0].request);
  assert.deepEqual(Object.keys(sent).sort(), ['brief', 'localToday', 'school', 'schoolName', 'staff', 'tasks']);
  assert.deepEqual(sent.tasks.map((t) => [t.ref, t.title, t.status, t.priority, t.assignee, t.dueInDays < 0, t.daysSinceChange]),
    [['W1', 'Order new belts for the test', 'READY', 'NORMAL', 'S2', true, 0], ['W2', 'Fix the front door lock', 'READY', 'LOW', null, true, 0]]);
  assert.deepEqual(Object.keys(sent.tasks[0]).sort(), ['assignee', 'dueInDays', 'daysSinceChange', 'priority', 'ref', 'status', 'title']);
  assert.deepEqual(sent.staff.map((x) => [x.ref, x.openTasks]), [['S1', 2], ['S2', 1], ['S3', 1]]);
  assert.equal(/Synth(owner|coach|desk)|example\.test|jf1-|Synthetic task for JF1/.test(fake.inputs[0].request), false, 'no staff name, email, subject or task description is sent');
  assert.equal(Buffer.byteLength(fake.inputs[0].request) < 12000 - 128 - 2500, true);
  assert.deepEqual([fake.inputs[0].inputBudget, fake.inputs[0].outputBudget, fake.inputs[0].maxCostMicrounits], [12000, 3000, 80000]);
  const r1 = await proposalRow(v1.id);
  assert.deepEqual(await row('SELECT agent_key, task_class FROM hon.ai_invocation_plans WHERE id=$1', [r1.plan_id]), { agent_key: 'jordan', task_class: 'ANALYZE' });
  assert.deepEqual(await ledger(v1.id), [{ c: 3, spend_class: 'AGENT_INFERENCE', school_id: a.school }]);
  assert.equal((await item(late1)).version, 1, 'a suggestion alone changes nothing');
  // OPEN sends every open task (due first, undated last), never a finished one.
  fake.answer = { summary: 'Fine.', suggestions: [s({ item: 'W4', action: 'FOLLOW_UP', dueInDays: null })] };
  const vOpen = await jordan.request(ctx(a), open);
  assert.deepEqual(vOpen.items.map((i) => i.title), ['Order new belts for the test', 'Fix the front door lock', 'Plan the spring camp', 'Tidy the storage room']);
  assert.equal(JSON.parse(fake.inputs[1].request).brief.note, 'Belt test is Saturday');
  pass('ask: OVERDUE sends only overdue open tasks, OPEN every open task (never a finished one), as W aliases with title, status, priority, assignee alias and day counts; staff as S aliases only; no name, email or description; one ledger row; nothing changes');

  // 3. Apply: each ticked suggestion runs through 0084 as the requester; only the named field changes; replay is exact.
  const ck = ctx(a);
  const applied = await jordan.apply(ck, v1.id, { suggestions: [1, 0] });
  assert.equal(applied.replayed, false); assert.equal(applied.followUp.status, 'APPLIED'); assert.deepEqual(applied.followUp.applied.map((x) => x.index), [0, 1]);
  const w1 = await item(late1), w2 = await item(late2);
  assert.deepEqual([w1.assigned_principal_id, w1.version, w1.title, w1.priority, w1.description], [desk.principal, 2, 'Order new belts for the test', 'NORMAL', 'Synthetic task for JF1.']);
  assert.equal(w2.version, 2); assert.equal(w2.assigned_principal_id, null);
  const due = await row("SELECT to_char(($1::timestamptz) AT TIME ZONE 'America/New_York','HH24:MI') h, (($1::timestamptz) AT TIME ZONE 'America/New_York')::date - (clock_timestamp() AT TIME ZONE 'America/New_York')::date d", [w2.due_at]);
  assert.deepEqual([due.h, due.d], ['17:00', 1]);
  const hist = await rows('SELECT operation, actor_id FROM hon.human_work_history WHERE work_item_id=$1 ORDER BY version', [late1]);
  assert.deepEqual(hist.map((h) => [h.operation, h.actor_id]), [['CREATE', a.principal], ['UPDATE', a.principal]]);
  const again = await jordan.apply({ ...ck, requestId: K(), correlationId: K() }, v1.id, { suggestions: [0, 1] });
  assert.equal(again.replayed, true); assert.equal((await item(late1)).version, 2);
  assert.equal(code(await settle(jordan.apply(ctx(a), v1.id, { suggestions: [0] }))), 'JORDAN_FOLLOW_UP_NOT_OPEN');
  // FOLLOW_UP creates a check-in task for the requester and leaves the original alone.
  const before = await humanCount(a);
  const fu = await jordan.apply(ctx(a), vOpen.id, { suggestions: [0] });
  assert.equal(await humanCount(a), before + 1);
  const made = await item(fu.followUp.applied[0].workItemId);
  assert.deepEqual([made.title, made.description, made.priority, made.assigned_principal_id, made.created_by_principal_id, made.due_at],
    ['Follow up: Tidy the storage room', 'The coach is out until Thursday. Suggested by Jordan.', 'NORMAL', a.principal, a.principal, null]);
  assert.equal((await item(noDue)).version, 1);
  pass('apply: a reassignment and a new due date (17:00 school time) change only that field through 0084 as the requester, recorded in task history; an exact retry replays; a follow-up adds a check-in task for the requester and leaves the task alone');

  // 4. A task changed after Jordan read it refuses the whole apply; nothing partial is left.
  fake.answer = { summary: 'Two moves.', suggestions: [s({ item: 'W1', action: 'REPRIORITIZE', dueInDays: null, priority: 'HIGH' }), s({ item: 'W2', action: 'RESCHEDULE', dueInDays: 4 })] };
  const v2 = await jordan.request(ctx(a), open);
  const w2Before = await item(late2);
  await transition(a, late2, 2, 'WORKING');
  const w1Before = await item(late1);
  assert.equal(code(await settle(jordan.apply(ctx(a), v2.id, { suggestions: [0, 1] }))), 'JORDAN_FOLLOW_UP_TASK_CHANGED');
  assert.equal((await item(late1)).version, w1Before.version, 'all or nothing'); assert.equal((await item(late2)).due_at?.toISOString(), w2Before.due_at?.toISOString());
  assert.equal((await proposalRow(v2.id)).status, 'RESULT_RECORDED');
  assert.equal((await jordan.apply(ctx(a), v2.id, { suggestions: [0] })).followUp.status, 'APPLIED');
  assert.equal((await item(late1)).priority, 'HIGH');
  pass('changed: a task changed after Jordan read it refuses the whole apply with nothing partial; the unchanged suggestion still applies');

  // 5. A paid answer outside the shape, naming an unknown task or person, two suggestions for one task, or a link is rejected.
  for (const answer of [{ summary: 'x', suggestions: [{ item: 'W1' }] }, { summary: 'x', suggestions: [s({ item: 'W9' })] },
    { summary: 'x', suggestions: [s({ action: 'REASSIGN', dueInDays: null, assignee: 'S9' })] }, { summary: 'x', suggestions: [s(), s({ action: 'FOLLOW_UP', dueInDays: null })] }]) {
    fake.answer = answer;
    const bad = await jordan.request(ctx(a), open);
    assert.equal(bad.status, 'RESULT_REJECTED', JSON.stringify(answer)); assert.deepEqual(bad.problems, ['The answer was not a follow-up list for these tasks.']); assert.equal((await ledger(bad.id)).length, 1);
  }
  fake.answer = { summary: 'x', suggestions: [s({ reason: 'Email owner@example.test about it.' })] };
  const linked = await jordan.request(ctx(a), open);
  assert.deepEqual([linked.status, linked.problems], ['RESULT_REJECTED', ['The answer holds a link or an email address.']]);
  assert.equal(code(await settle(jordan.apply(ctx(a), linked.id, { suggestions: [0] }))), 'JORDAN_FOLLOW_UP_NOT_OPEN');
  assert.equal((await jordan.dismiss(ctx(a), linked.id)).status, 'DISMISSED');
  pass('rejected: an answer outside the shape, with an unknown task or person alias, two suggestions for one task, or a link keeps its usage, shows its problems and never changes a task');

  // 6. Unknown outcome and HQ usage.
  fake.mode = 'UNKNOWN'; fake.answer = { summary: 'x', suggestions: [s()] };
  const lost = await jordan.request(ctx(a), open);
  assert.equal(lost.status, 'UNKNOWN'); assert.equal((await proposalRow(lost.id)).reserved_credits > 0, true);
  const queue = (await row('SELECT hon.read_ai_unknown_invocations_from_hq($1) r', [hq.subject])).r;
  assert.equal(queue.open.find((q) => q.invocationId === lost.id)?.agent, 'TEXT_PROPOSAL');
  fake.mode = 'OK';
  const usage = (await row('SELECT hon.read_ai_school_usage_from_hq($1,$2::timestamptz,$3::timestamptz) r', [hq.subject, new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString()])).r;
  const by = usage.schools.find((x) => x.schoolId === a.school).byClass.AGENT_INFERENCE.byAgent;
  assert.ok(by.OPERATIONS?.credits > 0, JSON.stringify(by)); assert.equal(by.UNATTRIBUTED, undefined);
  pass('unknown and usage: a lost outcome keeps its hold and appears in the HQ queue; the HQ per-school read attributes Jordan to OPERATIONS');

  // 7. Gates: team task management, Jordan's capability, AI planning, Complete; readers need team task management; isolation.
  const calls = fake.calls;
  const selfOnly = await addStaff(a, 'selfonly', ['schedule.session.manage', 'ai.invocation.plan', 'work_item.create', 'work_item.self_manage'], 'Morgan Synthlead');
  assert.equal(code(await settle(jordan.request(ctx(selfOnly), open))), 'JORDAN_FOLLOW_UP_FORBIDDEN');
  assert.equal(code(await settle(jordan.list(readCtx(selfOnly)))), 'JORDAN_FOLLOW_UP_FORBIDDEN', 'task titles need team task management');
  const reporter = await addStaff(a, 'reporter', ['reporting.view', 'schedule.session.manage'], 'Sam Synthviewer');
  assert.equal(code(await settle(jordan.list(readCtx(reporter)))), 'JORDAN_FOLLOW_UP_FORBIDDEN');
  const noAi = await addStaff(a, 'noai', ['schedule.session.manage', 'work_item.create', 'work_item.manage'], 'Pat Synthnoai');
  assert.equal(code(await settle(jordan.request(ctx(noAi), open))), 'JORDAN_FOLLOW_UP_FORBIDDEN');
  assert.ok((await jordan.list(readCtx(noAi))).length > 0, 'a team task manager with the schedule may read');
  const b = await makeOrg('b');
  await admin.query("UPDATE hon.organization_entitlements SET tier='CORE' WHERE organization_id=$1", [b.id]);
  assert.equal(code(await settle(jordan.request(ctx(b), open))), 'JORDAN_FOLLOW_UP_FORBIDDEN');
  await admin.query("UPDATE hon.organization_entitlements SET tier='COMPLETE' WHERE organization_id=$1", [b.id]);
  for (const badBrief of [{ focus: 'ALL', note: '' }, { focus: 'OPEN' }, { ...open, note: ' padded' }, { ...open, note: 'api_key: abc' }, { ...open, extra: 1 }]) {
    assert.equal(code(await settle(jordan.request(ctx(b), badBrief))), 'JORDAN_FOLLOW_UP_INVALID', JSON.stringify(badBrief));
  }
  assert.equal(code(await settle(jordan.request(ctx(b, { source: 'AI_AGENT' }), open))), 'HUMAN_COMMAND_REQUIRED');
  assert.equal((await settle(jordan.read(readCtx(b), v1.id))).error?.getStatus(), 404);
  assert.equal((await settle(jordan.apply(ctx(b), v2.id, { suggestions: [1] }))).error?.getStatus(), 404);
  assert.equal(fake.calls, calls); assert.equal(networkCalls, 0);
  pass('gates: no team task management, no AI planning or Core is refused before any row; readers need the schedule and team task management; bad briefs and non-human sources are refused; schools are isolated');

  // 8. Evidence rows cannot be changed.
  await assert.rejects(admin.query('UPDATE hon.jordan_follow_up_refs SET ref=ref WHERE proposal_id=$1', [v1.id]), /ALEX_PLAN_ROWS_IMMUTABLE/);
  await assert.rejects(admin.query('DELETE FROM hon.jordan_follow_up_applied WHERE proposal_id=$1', [v1.id]), /ALEX_PLAN_ROWS_IMMUTABLE/);
  pass('evidence: aliases and applied links are append-only');

  { const verify = await (await import('node:fs/promises')).readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
    const section = verify.split('-- Jordan follow-through exact verification (0640)')[1]?.split('-- End Jordan follow-through exact verification.')[0];
    assert.ok(section, '0640 verify section present');
    await admin.query(section.slice(section.indexOf('\nDO $$')).replaceAll('hon_runtime', runtimeRole));
    await admin.query(verify.replaceAll('hon_runtime', runtimeRole)); }
  pass('011: the 0640 exact verification and the whole canonical 011 pass');
  console.log(`JF1 Jordan follow-through: ${groups} groups passed, ${fake.calls} fake provider calls, 0 network calls`);
} finally {
  await admin.end().catch(() => {});
  await db.onModuleDestroy?.().catch?.(() => {});
}
