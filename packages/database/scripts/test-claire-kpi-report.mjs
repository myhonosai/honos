/**
 * P4 (0643): Claire KPI report on the shared AI text proposal table, through the real API service, the restricted runtime
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
const { ClaireKpiService } = await import('../../../apps/api/dist/claire-kpi/claire-kpi.service.js');
const { MerchProviderRuntimeError } = await import('../../../apps/api/dist/commerce/shopify/merch-provider-runtime.js');

const admin = new pg.Client({ connectionString: ownerUrl, ssl: false });
const row = async (sql, args = []) => (await admin.query(sql, args)).rows[0];
const rows = async (sql, args = []) => (await admin.query(sql, args)).rows;
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
const code = (r) => r.error?.getResponse?.().code;
let groups = 0; const pass = (name) => console.log(`PASS CK1 ${++groups} ${name}`);

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
const db = new RuntimeDatabaseService(), plans = new AiInvocationPlanService(db), claire = new ClaireKpiService(db, plans, provider);
const catalog = K(), hq = { id: K(), user: K(), subject: `ck1-hq-owner-${K()}` };
const ctx = (o, patch = {}) => ({ organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: K(), correlationId: K(), idempotencyKey: K(), ...patch });
const readCtx = (o) => ctx(o, { idempotencyKey: '' });
const week = { period: 'LAST_7_DAYS', focus: '' };
const month = { period: 'LAST_30_DAYS', focus: 'How is retention?' };
const answer = { summary: 'More leads and steady attendance this week.', notes: [{ kpi: 'NEW_LEADS', note: 'Up from 2 to 3.' }, { kpi: 'ENDED_MEMBERSHIPS', note: 'One membership ended.' }],
  watch: [{ title: 'An ended membership', detail: 'One member left this week.' }], actions: [{ title: 'Call open leads', detail: 'One lead is still open.' }] };
const CODES = ['NEW_LEADS', 'WON_LEADS', 'LOST_LEADS', 'REGISTRATIONS', 'NEW_MEMBERSHIPS', 'ENDED_MEMBERSHIPS', 'CLASSES_ATTENDED', 'STUDENTS_ATTENDING', 'ACTIVE_MEMBERSHIPS'];
const numbers = (pairs) => CODES.map((kpi, n) => ({ kpi, current: pairs[n][0], previous: pairs[n][1] }));

async function makeOrg(label) {
  const o = { label, id: K(), school: K(), user: K(), principal: K(), role: K(), subject: `ck1-${label}-${K()}`, policy: K() };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'CK1 synthetic organization','CK1 synthetic organization')", [o.id]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'Synthetic Dojo',$1::uuid::text,'America/New_York')", [o.school, o.id]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day')", [o.id]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','Avery Synthowner')", [o.user, o.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Avery Synthowner')", [o.principal, o.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','CK1 synthetic owner',true)", [o.role, o.id]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions', [o.role, o.id]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '3 days')", [o.id, o.school, o.principal, o.role]);
  await admin.query("INSERT INTO hon.hq_ai_routing_policies(policy_id,organization_id,school_id,capability,active,minimum_tier,max_cost_micros,effective_from) VALUES($1,$2,$3,'TEXT',true,'COMPLETE',150000,'2020-01-01')", [o.policy, o.id, o.school]);
  await admin.query('INSERT INTO hon.hq_ai_routing_candidates(policy_id,ordinal,catalog_id) VALUES($1,0,$2)', [o.policy, catalog]);
  await admin.query('COMMIT');
  return o;
}
async function addStaff(o, label, permissions, name, since = '2 days') {
  const st = { ...o, user: K(), principal: K(), role: K(), subject: `ck1-${label}-${K()}`, name };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test',$3)", [st.user, st.subject, name]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3)", [st.principal, st.user, name]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,'CK1 synthetic staff',false)", [st.role, o.id, 'CK1_' + label.toUpperCase()]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,unnest($3::text[])', [st.role, o.id, permissions]);
  await admin.query(`INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '${since}')`, [o.id, o.school, st.principal, st.role, o.principal]);
  await admin.query('COMMIT');
  return st;
}
// Synthetic school records, written by the migration owner with user triggers paused (disposable fixture only).
const SEEDED = ['people', 'student_profiles', 'crm_leads', 'crm_lead_registration_conversions', 'billing_accounts', 'memberships', 'programs', 'class_sessions', 'attendance_records'];
const ago = (days) => `clock_timestamp()-make_interval(hours=>${Math.round(days * 24)})`;
async function seed(o, { leads = [], memberships = [], attendance = [] }) {
  await admin.query('BEGIN');
  for (const t of SEEDED) await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  const pipeline = K(), stage = K(), program = K(), students = {};
  await admin.query("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'Leads')", [pipeline, o.id, o.school]);
  await admin.query("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'New',1)", [stage, o.id, o.school, pipeline]);
  await admin.query("INSERT INTO hon.programs(id,organization_id,school_id,name) VALUES($1,$2,$3,'Synthetic program '||$1::uuid::text)", [program, o.id, o.school]);
  const person = async () => { const p = K(); await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email) VALUES($1,$2,$3,'Taylor','Synthperson',$1::uuid::text||'@example.test')", [p, o.id, o.school]); return p; };
  const student = async (key) => { if (students[key]) return students[key]; const p = await person(), s = K(); await admin.query('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)', [s, o.id, o.school, p]); return (students[key] = { p, s }); };
  for (const l of leads) {
    const p = await person(), lead = K();
    await admin.query(`INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status,source_code,created_at,won_at,lost_at)
      VALUES($1,$2,$3,$4,$5,$6,$7::hon.lead_status,'SYNTH',${ago(l.created)},${l.won === undefined ? 'NULL' : ago(l.won)},${l.lost === undefined ? 'NULL' : ago(l.lost)})`,
      [lead, o.id, o.school, p, pipeline, stage, l.won !== undefined ? 'WON' : l.lost !== undefined ? 'LOST' : 'OPEN']);
    if (l.registered !== undefined) {
      const st = await student(`lead-${lead}`);
      await admin.query(`INSERT INTO hon.crm_lead_registration_conversions(organization_id,school_id,source_lead_id,original_contact_person_id,registration_path,resulting_student_profile_id,actor_principal_id,idempotency_key,fingerprint,response,created_at)
        VALUES($1,$2,$3,$4,'ADULT',$5,$6,$7,$8,'{}',${ago(l.registered)})`, [o.id, o.school, lead, p, st.s, o.principal, K(), 'a'.repeat(64)]);
    }
  }
  for (const m of memberships) {
    const p = await person(), account = K();
    await admin.query('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id) VALUES($1,$2,$3,$4)', [account, o.id, o.school, p]);
    await admin.query(`INSERT INTO hon.memberships(organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at)
      VALUES($1,$2,$3,$4,'SYNTH',$5::hon.membership_state,${ago(m.started)},${m.ends === undefined ? 'NULL' : ago(m.ends)})`, [o.id, o.school, account, p, m.state]);
  }
  for (const a of attendance) {
    const st = await student(a.student), session = K();
    await admin.query(`INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy) VALUES($1,$2,$3,$4,'Synthetic class',${ago(a.at)},${ago(a.at - 0.05)},20,'WALK_IN')`, [session, o.id, o.school, program]);
    await admin.query(`INSERT INTO hon.attendance_records(organization_id,school_id,class_session_id,student_profile_id,status,recorded_at,progression_enabled) VALUES($1,$2,$3,$4,$5::hon.attendance_status,${ago(a.at)},false)`,
      [o.id, o.school, session, st.s, a.status]);
  }
  await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
  for (const t of SEEDED) await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  await admin.query('COMMIT');
}
const ledger = (id) => rows('SELECT customer_credits::int c, spend_class, school_id FROM hon.ai_usage_ledger WHERE source_invocation_id=$1', [id]);
const proposalRow = (id) => row('SELECT * FROM hon.ai_text_proposals WHERE id=$1', [id]);
const counts = () => row(`SELECT (SELECT count(*) FROM hon.crm_leads)::int leads, (SELECT count(*) FROM hon.memberships)::int memberships, (SELECT count(*) FROM hon.work_items)::int work,
  (SELECT count(*) FROM hon.communication_messages)::int messages, (SELECT count(*) FROM hon.outbox_events WHERE event_type !~ '^(ai|work)[._]')::int outbox`);

try {
  await admin.connect();
  assert.equal((await row('SELECT current_database() d')).d, database);

  // 1. Custody.
  const entry = ['begin_claire_kpi_report', 'plan_claire_kpi_report', 'prepare_claire_kpi_report', 'fail_claire_kpi_report', 'record_claire_kpi_report', 'read_claire_kpi_reports', 'close_claire_kpi_report'];
  const fns = await rows("SELECT p.oid, p.proname, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%claire_kpi%'");
  assert.equal(fns.length, 15, fns.map((f) => f.proname).join(','));
  for (const f of fns) {
    assert.equal((await row("SELECT has_function_privilege($1,$2::oid,'EXECUTE') ok", [runtimeRole, f.oid])).ok, entry.includes(f.proname), f.proname);
    assert.equal((await row("SELECT coalesce(bool_or(a.grantee=0),false) pub FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1", [f.oid])).pub, false, f.proname);
    if (entry.includes(f.proname)) assert.equal(f.prosecdef, true, f.proname);
  }
  const t = await row("SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE oid='hon.claire_kpi_report_numbers'::regclass");
  assert.deepEqual([t.r, t.f], [true, true]);
  for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.equal((await row('SELECT has_table_privilege($1,$2,$3) ok', [runtimeRole, 'hon.claire_kpi_report_numbers', priv])).ok, false, priv);
  const kind = await row("SELECT * FROM hon.ai_text_kinds WHERE kind='CLAIRE_KPI_REPORT'");
  assert.deepEqual([kind.agent_key, kind.task_class, kind.input_budget, kind.output_budget, Number(kind.max_cost_microunits), kind.max_result_bytes, kind.caller, kind.subject_type, kind.usage_agent],
    ['claire', 'ANALYZE', 12000, 3000, 80000, 12288, 'HUMAN_UI', 'SCHOOL', 'BUSINESS_PERFORMANCE']);
  pass('custody: CLAIRE_KPI_REPORT kind fixed (claire, ANALYZE, 12,000/3,000, 80,000 micro-USD, BUSINESS_PERFORMANCE), runtime executes exactly seven definer entry points, nothing to PUBLIC, numbers table forced RLS with no runtime access');

  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state,credential_secret_ref) VALUES('OPENROUTER','CK1 synthetic route','HEALTHY',$1) ON CONFLICT (provider_id) DO NOTHING", [`hon-secret:${K()}`]);
  await admin.query("INSERT INTO hon.hq_ai_model_catalog(catalog_id,provider_id,model_id,display_name,capabilities,modalities,active,minimum_tier,unit_cost_micros,cost_unit,effective_from) VALUES($1,'OPENROUTER','approved/ck1-synthetic','CK1 synthetic model',ARRAY['TEXT'],ARRAY['TEXT'],true,'COMPLETE',2,'TOKEN','2020-01-01')", [catalog]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','CK1 synthetic HQ owner')", [hq.user, hq.subject]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','CK1 synthetic HQ owner',true)", [hq.id, hq.user]);
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER','{}',clock_timestamp()-interval '2 days')", [hq.id]);
  await admin.query('COMMIT');

  // 2. Ask: nine KPIs for this week and the week before, counted by the database; only counts and Command Center metrics are sent.
  const a = await makeOrg('a'), b = await makeOrg('b');
  await seed(a, {
    leads: [{ created: 2, won: 1, registered: 1 }, { created: 3, lost: 2 }, { created: 5 }, { created: 9, won: 9 }, { created: 12 }, { created: 40 }],
    memberships: [{ state: 'ACTIVE', started: 2 }, { state: 'ACTIVE', started: 10 }, { state: 'CANCELLED', started: 100, ends: 3 }, { state: 'DRAFT', started: 1 }, { state: 'FROZEN', started: 200 }],
    attendance: [{ student: 's1', status: 'PRESENT', at: 1 }, { student: 's1', status: 'LATE', at: 2 }, { student: 's2', status: 'PRESENT', at: 3 }, { student: 's2', status: 'UNEXCUSED_ABSENCE', at: 4 }, { student: 's1', status: 'PRESENT', at: 9 }],
  });
  await seed(b, { leads: [{ created: 1 }], memberships: [{ state: 'ACTIVE', started: 1 }] });
  const before = await counts();
  fake.answer = answer;
  const v1 = await claire.request(ctx(a), week);
  assert.equal(v1.status, 'RESULT_RECORDED', JSON.stringify(v1)); assert.deepEqual([v1.summary, v1.notes, v1.watch, v1.actions], [answer.summary, answer.notes, answer.watch, answer.actions]);
  const expected = numbers([[3, 2], [1, 1], [1, 0], [1, 0], [1, 1], [1, 0], [3, 1], [2, 1], [2, null]]);
  assert.deepEqual(v1.kpis, expected);
  assert.equal(fake.calls, 1);
  const sent = JSON.parse(fake.inputs[0].request);
  assert.deepEqual(Object.keys(sent).sort(), ['brief', 'commandCenter', 'kpis', 'localToday', 'schoolName', 'windowDays']);
  assert.deepEqual([sent.brief, sent.windowDays, sent.schoolName, sent.kpis], [week, 7, 'Synthetic Dojo', expected]);
  assert.equal(sent.commandCenter.revenue.availability, 'UNAVAILABLE');
  assert.equal(/Taylor|Synthperson|Synthowner|example\.test|ck1-/.test(fake.inputs[0].request), false, 'no person, contact or subject is sent');
  assert.equal(Buffer.byteLength(fake.inputs[0].request) < 12000 - 128 - 2700, true);
  assert.deepEqual([fake.inputs[0].inputBudget, fake.inputs[0].outputBudget, fake.inputs[0].maxCostMicrounits], [12000, 3000, 80000]);
  const r1 = await proposalRow(v1.id);
  assert.deepEqual(await row('SELECT agent_key, task_class FROM hon.ai_invocation_plans WHERE id=$1', [r1.plan_id]), { agent_key: 'claire', task_class: 'ANALYZE' });
  const l1 = await ledger(v1.id); assert.equal(l1.length, 1); assert.deepEqual([l1[0].spend_class, l1[0].school_id], ['AGENT_INFERENCE', a.school]);
  const vm = await claire.request(ctx(a), month);
  assert.deepEqual(vm.kpis.map((k) => [k.kpi, k.current, k.previous]).slice(0, 2), [['NEW_LEADS', 5, 1], ['WON_LEADS', 2, 0]]);
  assert.equal(JSON.parse(fake.inputs[1].request).brief.focus, 'How is retention?');
  assert.deepEqual({ ...(await counts()), work: before.work }, before, 'a report creates no lead, membership, message or outbox event (only its own AI planning item)');
  // The numbers are fixed with the report: later records do not change it, and the evidence row cannot be changed.
  await seed(a, { leads: [{ created: 0.5 }] });
  assert.deepEqual((await claire.read(readCtx(a), v1.id)).kpis, expected);
  await assert.rejects(admin.query('UPDATE hon.claire_kpi_report_numbers SET window_days=window_days WHERE proposal_id=$1', [v1.id]), /ALEX_PLAN_ROWS_IMMUTABLE/);
  await assert.rejects(admin.query('DELETE FROM hon.claire_kpi_report_numbers WHERE proposal_id=$1', [v1.id]), /ALEX_PLAN_ROWS_IMMUTABLE/);
  pass('ask: nine KPIs for 7 or 30 days against the window before, counted once by the database and kept with the report (append-only); only counts and Command Center metrics are sent; claire ANALYZE plan, one ledger row; nothing created or sent');

  // 3. A paid answer outside the shape or with a link is rejected; usage is kept; the numbers still show; dismiss hides the text.
  for (const bad of [{ ...answer, notes: [] }, { ...answer, notes: [{ kpi: 'REVENUE', note: 'x' }] }, { ...answer, notes: [answer.notes[0], answer.notes[0]] }, { ...answer, extra: 1 }]) {
    fake.answer = bad;
    const v = await claire.request(ctx(a), week);
    assert.equal(v.status, 'RESULT_REJECTED', JSON.stringify(bad)); assert.deepEqual(v.problems, ['The answer was not a KPI report.']); assert.equal(v.notes, null);
    assert.equal(v.kpis.length, 9); assert.equal((await ledger(v.id)).length, 1);
  }
  fake.answer = { ...answer, actions: [{ title: 'Read this', detail: 'See https://example.test/report.' }] };
  const linked = await claire.request(ctx(a), week);
  assert.deepEqual([linked.status, linked.problems], ['RESULT_REJECTED', ['The answer holds a link or an email address.']]);
  const gone = await claire.dismiss(ctx(a), v1.id);
  assert.deepEqual([gone.status, gone.summary, gone.kpis.length], ['DISMISSED', null, 9]);
  pass('rejected: an answer outside the shape, with an unknown or repeated KPI, or with a link keeps its usage and its counted numbers and shows its problems; a dismissed report hides its text');

  // 4. Unknown outcome and HQ usage.
  fake.mode = 'UNKNOWN'; fake.answer = answer;
  const lost = await claire.request(ctx(a), week);
  assert.equal(lost.status, 'UNKNOWN'); assert.equal((await proposalRow(lost.id)).reserved_credits > 0, true);
  const queue = (await row('SELECT hon.read_ai_unknown_invocations_from_hq($1) r', [hq.subject])).r;
  assert.equal(queue.open.find((q) => q.invocationId === lost.id)?.agent, 'TEXT_PROPOSAL');
  fake.mode = 'OK';
  const usage = (await row('SELECT hon.read_ai_school_usage_from_hq($1,$2::timestamptz,$3::timestamptz) r', [hq.subject, new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString()])).r;
  const by = usage.schools.find((x) => x.schoolId === a.school).byClass.AGENT_INFERENCE.byAgent;
  assert.ok(by.BUSINESS_PERFORMANCE?.credits > 0, JSON.stringify(by)); assert.equal(by.UNATTRIBUTED, undefined);
  pass('unknown and usage: a lost outcome keeps its hold and appears in the HQ queue; the HQ per-school read attributes Claire reports to BUSINESS_PERFORMANCE');

  // 5. Gates: reporting, AI planning, Complete; readers see only their own reports; isolation.
  const calls = fake.calls;
  const reader = await addStaff(a, 'reader', ['reporting.view'], 'Sam Synthviewer');
  assert.equal(code(await settle(claire.request(ctx(reader), week))), 'CLAIRE_KPI_FORBIDDEN');
  assert.deepEqual(await claire.list(readCtx(reader)), [], 'a reader sees only their own reports');
  assert.equal((await settle(claire.read(readCtx(reader), vm.id))).error?.getStatus(), 404);
  assert.equal((await settle(claire.dismiss(ctx(reader), vm.id))).error?.getStatus(), 404);
  const blind = await addStaff(a, 'blind', ['ai.invocation.plan', 'marketing.campaign.read'], 'Pat Synthblind');
  assert.equal(code(await settle(claire.request(ctx(blind), week))), 'CLAIRE_KPI_FORBIDDEN');
  assert.equal(code(await settle(claire.list(readCtx(blind)))), 'CLAIRE_KPI_FORBIDDEN');
  assert.ok((await claire.list(readCtx(a))).length >= 7, 'the requester reads their own reports');
  await admin.query("UPDATE hon.organization_entitlements SET tier='CORE' WHERE organization_id=$1", [b.id]);
  assert.equal(code(await settle(claire.request(ctx(b), week))), 'CLAIRE_KPI_FORBIDDEN');
  await admin.query("UPDATE hon.organization_entitlements SET tier='COMPLETE' WHERE organization_id=$1", [b.id]);
  for (const badBrief of [{ period: 'LAST_90_DAYS', focus: '' }, { period: 'LAST_7_DAYS' }, { ...month, focus: ' padded' }, { ...month, focus: 'api_key: abc' }, { ...week, extra: 1 }]) {
    assert.equal(code(await settle(claire.request(ctx(b), badBrief))), 'CLAIRE_KPI_INVALID', JSON.stringify(badBrief));
  }
  assert.equal(code(await settle(claire.request(ctx(b, { source: 'AI_AGENT' }), week))), 'HUMAN_COMMAND_REQUIRED');
  assert.equal(fake.calls, calls);
  assert.equal((await settle(claire.read(readCtx(b), vm.id))).error?.getStatus(), 404);
  fake.answer = answer;
  const vb = await claire.request(ctx(b), week);
  assert.deepEqual(vb.kpis, numbers([[1, 0], [0, 0], [0, 0], [0, 0], [1, 0], [0, 0], [0, 0], [0, 0], [1, null]]));
  assert.equal(networkCalls, 0);
  pass('gates: no reporting, no AI planning or Core is refused before any call; readers see only their own reports; bad briefs and non-human sources are refused; schools are isolated');

  { const verify = await (await import('node:fs/promises')).readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
    const section = verify.split('-- Claire KPI report exact verification (0643)')[1]?.split('-- End Claire KPI report exact verification.')[0];
    assert.ok(section, '0643 verify section present');
    await admin.query(section.slice(section.indexOf('\nDO $$')).replaceAll('hon_runtime', runtimeRole));
    await admin.query(verify.replaceAll('hon_runtime', runtimeRole)); }
  pass('011: the 0643 exact verification and the whole canonical 011 pass');
  console.log(`CK1 Claire KPI report: ${groups} groups passed, ${fake.calls} fake provider calls, 0 network calls`);
} finally {
  await admin.end().catch(() => {});
  await db.onModuleDestroy?.().catch?.(() => {});
}
