/**
 * P9 (0650): Chad lead next steps on the shared AI text proposal table, through the real API services, the restricted runtime
 * role and the S4 spend controls on a fresh disposable AI-0 fixture. Chad only suggests: each step is run by the ordinary human
 * command (the pipeline stage move, the trial booking) and then recorded, and the database checks the requester's own command
 * made that exact change after the list was written. The provider is a counted in-process fake: nothing leaves the machine,
 * and fetch is refused. Synthetic names only.
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
const { ChadLeadPlanService } = await import('../../../apps/api/dist/chad-lead-plan/chad-lead-plan.service.js');
const { CrmPipelineBoardService } = await import('../../../apps/api/dist/crm-pipeline-board/crm-pipeline-board.service.js');
const { TrialAppointmentService } = await import('../../../apps/api/dist/crm/trial-appointment.service.js');
const { MerchProviderRuntimeError } = await import('../../../apps/api/dist/commerce/shopify/merch-provider-runtime.js');

const admin = new pg.Client({ connectionString: ownerUrl, ssl: false });
const row = async (sql, args = []) => (await admin.query(sql, args)).rows[0];
const rows = async (sql, args = []) => (await admin.query(sql, args)).rows;
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
const code = (r) => r.error?.getResponse?.().code;
let groups = 0; const pass = (name) => console.log(`PASS CLP1 ${++groups} ${name}`);

const fake = { calls: 0, inputs: [], mode: 'OK', answer: null };
const provider = {
  readiness: () => 'READY',
  generate: async (input) => {
    fake.calls += 1; fake.inputs.push(input);
    if (fake.mode === 'UNKNOWN') throw new MerchProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    return { proposal: typeof fake.answer === 'function' ? fake.answer(JSON.parse(input.request)) : fake.answer, inputTokens: 1500, outputTokens: 600, providerCostMicrounits: 1200 };
  },
};
const db = new RuntimeDatabaseService(), plans = new AiInvocationPlanService(db), chad = new ChadLeadPlanService(db, plans, provider);
const board = new CrmPipelineBoardService(db), trials = new TrialAppointmentService(db);
const catalog = K();
const ctx = (o, patch = {}) => ({ organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: K(), correlationId: K(), idempotencyKey: K(), ...patch });
const readCtx = (o) => ctx(o, { idempotencyKey: '' });
const all = { focus: 'ALL_OPEN', note: '' };
const noTrial = { focus: 'NO_TRIAL_YET', note: 'Spring push' };
const CHAD = ['crm.lead.read', 'crm.assistant.follow_up_draft', 'ai.invocation.plan', 'ai.agent.chad.use', 'crm.lead.stage.move', 'crm.trial.schedule'];

async function makeOrg(label) {
  const o = { label, id: K(), school: K(), user: K(), principal: K(), role: K(), subject: `clp1-${label}-${K()}`, policy: K() };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'CLP1 synthetic organization','CLP1 synthetic organization')", [o.id]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'Synthetic Dojo',$1::uuid::text,'UTC')", [o.school, o.id]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day')", [o.id]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','Avery Synthowner')", [o.user, o.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Avery Synthowner')", [o.principal, o.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','CLP1 synthetic owner',true)", [o.role, o.id]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions', [o.role, o.id]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '3 days')", [o.id, o.school, o.principal, o.role]);
  await admin.query("INSERT INTO hon.hq_ai_routing_policies(policy_id,organization_id,school_id,capability,active,minimum_tier,max_cost_micros,effective_from) VALUES($1,$2,$3,'TEXT',true,'COMPLETE',150000,'2020-01-01')", [o.policy, o.id, o.school]);
  await admin.query('INSERT INTO hon.hq_ai_routing_candidates(policy_id,ordinal,catalog_id) VALUES($1,0,$2)', [o.policy, catalog]);
  await admin.query('COMMIT');
  return o;
}
async function addStaff(o, label, permissions) {
  const st = { ...o, user: K(), principal: K(), role: K(), subject: `clp1-${label}-${K()}` };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','CLP1 synthetic staff')", [st.user, st.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'CLP1 synthetic staff')", [st.principal, st.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,'CLP1 synthetic staff',false)", [st.role, o.id, 'CLP1_' + label.toUpperCase()]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions WHERE code=ANY($3::text[])', [st.role, o.id, permissions]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '2 days')", [o.id, o.school, st.principal, st.role, o.principal]);
  await admin.query('COMMIT');
  return st;
}
// Two pipelines (P sorts before Q), synthetic leads and classes, written by the migration owner with user triggers paused.
const SEEDED = ['people', 'crm_pipelines', 'crm_pipeline_stages', 'crm_leads', 'programs', 'class_sessions'];
const at = (hours) => `date_trunc('minute',clock_timestamp())+make_interval(mins=>${Math.round(hours * 60)})`;
async function seed(o) {
  const [P, Q] = [K(), K()].sort();
  const st = { New: K(), Contacted: K(), Booked: K(), Won: K(), QNew: K(), QCalled: K() };
  const leads = {}, classes = {};
  await admin.query('BEGIN');
  for (const t of SEEDED) await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  await admin.query("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'Kids'),($4,$2,$3,'Adults')", [P, o.id, o.school, Q]);
  for (const [name, id, pipeline, position, terminal] of [['New', st.New, P, 1, null], ['Contacted', st.Contacted, P, 2, null], ['Trial booked', st.Booked, P, 3, null], ['Won', st.Won, P, 4, 'WON'],
    ['Adult new', st.QNew, Q, 1, null], ['Adult called', st.QCalled, Q, 2, null]]) {
    await admin.query('INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position,terminal_status) VALUES($1,$2,$3,$4,$5,$6,$7::hon.lead_status)', [id, o.id, o.school, pipeline, name, position, terminal]);
  }
  for (const [name, pipeline, stage, status, created, follow, src] of [['Robin', P, st.New, 'OPEN', 10, 1, 'WEBSITE_FORM'], ['Taylor', P, st.New, 'OPEN', 1, null, 'walk-in desk'], ['Jamie', Q, st.QNew, 'OPEN', 2, null, null],
    ['Casey', P, st.New, 'OPEN', 3, null, 'REFERRAL'], ['Lost', P, st.New, 'LOST', 0.5, null, null]]) {
    const person = K(), id = K();
    await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email,phone_e164) VALUES($1,$2,$3,$4,'Synthlead',$1::uuid::text||'@example.test','+15555550123')", [person, o.id, o.school, name]);
    await admin.query(`INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status,source_code,next_follow_up_at,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7::hon.lead_status,$8,${follow === null ? 'NULL' : at(follow * 24)},${at(-created * 24)},${at(-created * 24)})`, [id, o.id, o.school, person, pipeline, stage, status, src]);
    leads[name] = id;
  }
  const program = K();
  await admin.query("INSERT INTO hon.programs(id,organization_id,school_id,name) VALUES($1,$2,$3,'Synthetic program '||$1::uuid::text)", [program, o.id, o.school]);
  for (const [name, hours, status] of [['Kids basics', 26, 'SCHEDULED'], ['Kids basics late', 74, 'SCHEDULED'], ['Too soon', 1, 'SCHEDULED'], ['Too far', 20 * 24, 'SCHEDULED'], ['Draft class', 30, 'DRAFT']]) {
    const id = K();
    await admin.query(`INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status) VALUES($1,$2,$3,$4,$5,${at(hours)},${at(hours + 1)},20,'WALK_IN',$6::hon.schedule_item_status)`, [id, o.id, o.school, program, name, status]);
    classes[name] = id;
  }
  await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
  for (const t of SEEDED) await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  await admin.query('COMMIT');
  return { P, Q, st, leads, classes };
}
const ledger = (id) => rows('SELECT customer_credits::int c, spend_class, school_id FROM hon.ai_usage_ledger WHERE source_invocation_id=$1', [id]);
const leadRow = (id) => row('SELECT version, pipeline_stage_id FROM hon.crm_leads WHERE id=$1', [id]);
const move = async (st, leadId, stageId) => board.move(ctx(st), leadId, { stageId, expectedVersion: (await leadRow(leadId)).version });
const book = async (st, leadId, slot) => (await trials.schedule(ctx(st), leadId, { startsAt: slot.startsAt, endsAt: slot.endsAt }, { externalSubject: st.subject })).appointment;
const sug = (patch) => ({ action: 'MOVE_STAGE', lead: 'L1', reason: 'They asked for a call back and have not been reached yet.', slot: null, stage: 'S2', ...patch });
const refOf = (view, kind, field, id) => view[kind].find((x) => x[field] === id)?.ref;

try {
  await admin.connect();
  assert.equal((await row('SELECT current_database() d')).d, database);

  // 1. Custody.
  const entry = ['begin_chad_lead_plan', 'plan_chad_lead_plan', 'prepare_chad_lead_plan', 'fail_chad_lead_plan', 'record_chad_lead_plan', 'read_chad_lead_plans', 'record_chad_lead_plan_step', 'close_chad_lead_plan'];
  const fns = await rows("SELECT p.oid, p.proname, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%chad_lead_plan%'");
  assert.equal(fns.length, 15, fns.map((f) => f.proname).join(','));
  for (const f of fns) {
    assert.equal((await row("SELECT has_function_privilege($1,$2::oid,'EXECUTE') ok", [runtimeRole, f.oid])).ok, entry.includes(f.proname), f.proname);
    assert.equal((await row("SELECT coalesce(bool_or(a.grantee=0),false) pub FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1", [f.oid])).pub, false, f.proname);
    if (entry.includes(f.proname)) assert.equal(f.prosecdef, true, f.proname);
  }
  for (const t of ['chad_lead_plan_refs', 'chad_lead_plan_applied']) {
    const c = await row("SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE oid=('hon.'||$1)::regclass", [t]);
    assert.deepEqual([c.r, c.f], [true, true], t);
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.equal((await row('SELECT has_table_privilege($1,$2,$3) ok', [runtimeRole, `hon.${t}`, priv])).ok, false, `${t} ${priv}`);
  }
  const kind = await row("SELECT * FROM hon.ai_text_kinds WHERE kind='CHAD_LEAD_PLAN'");
  assert.deepEqual([kind.agent_key, kind.task_class, kind.input_budget, kind.output_budget, Number(kind.max_cost_microunits), kind.max_result_bytes, kind.caller, kind.subject_type, kind.usage_agent],
    ['chad', 'DRAFT_FOLLOW_UP', 10000, 2500, 80000, 12288, 'HUMAN_UI', 'SCHOOL', 'CHAD_FOLLOW_UP']);
  pass('custody: CHAD_LEAD_PLAN kind fixed (chad, DRAFT_FOLLOW_UP, 10,000/2,500, 80,000 micro-USD, CHAD_FOLLOW_UP), runtime executes exactly eight definer entry points, nothing to PUBLIC, both tables forced RLS with no runtime access');

  await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state,credential_secret_ref) VALUES('OPENROUTER','CLP1 synthetic route','HEALTHY',$1) ON CONFLICT (provider_id) DO NOTHING", [`hon-secret:${K()}`]);
  await admin.query("INSERT INTO hon.hq_ai_model_catalog(catalog_id,provider_id,model_id,display_name,capabilities,modalities,active,minimum_tier,unit_cost_micros,cost_unit,effective_from) VALUES($1,'OPENROUTER','approved/clp1-synthetic','CLP1 synthetic model',ARRAY['TEXT'],ARRAY['TEXT'],true,'COMPLETE',2,'TOKEN','2020-01-01')", [catalog]);

  // 2. Ask: open leads only, open stages of their pipelines, scheduled classes 2h to 14 days out; Chad sees aliases and numbers.
  const a = await makeOrg('a');
  const w = await seed(a);
  const owner = a;
  const taylorTrial = await book(owner, w.leads.Taylor, { startsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), endsAt: new Date(Date.now() + 5 * 86_400_000 + 3_600_000).toISOString() });
  const staff = await addStaff(a, 'chad', CHAD);
  fake.answer = (sent) => {
    const contacted = sent.stages.find((x) => x.name === 'Contacted').ref;
    return { summary: 'Two quick wins today.', suggestions: [sug({ lead: 'L1', stage: contacted }), sug({ action: 'BOOK_TRIAL', lead: 'L4', stage: null, slot: 'C1', reason: 'Referred by a member and keen to try a kids class.' })] };
  };
  const v1 = await chad.request(ctx(staff), all);
  assert.equal(v1.status, 'RESULT_RECORDED', JSON.stringify(v1));
  assert.deepEqual(v1.leads.map((x) => [x.ref, x.leadId, x.name]), [['L1', w.leads.Robin, 'Robin Synthlead'], ['L2', w.leads.Taylor, 'Taylor Synthlead'], ['L3', w.leads.Jamie, 'Jamie Synthlead'], ['L4', w.leads.Casey, 'Casey Synthlead']]);
  assert.deepEqual(v1.stages.map((x) => [x.ref, x.stageId]), [['S1', w.st.New], ['S2', w.st.Contacted], ['S3', w.st.Booked], ['S4', w.st.QNew], ['S5', w.st.QCalled]]);
  assert.deepEqual(v1.classes.map((x) => [x.ref, x.classSessionId]), [['C1', w.classes['Kids basics']], ['C2', w.classes['Kids basics late']]]);
  assert.equal(fake.calls, 1);
  const sent = JSON.parse(fake.inputs[0].request);
  assert.deepEqual(Object.keys(sent).sort(), ['brief', 'classes', 'leadPipelines', 'leads', 'localToday', 'schoolName', 'stages']);
  assert.deepEqual(Object.keys(sent.leads[0]).sort(), ['daysSinceCreated', 'daysSinceUpdated', 'nextFollowUpInDays', 'noShows', 'pastTrials', 'programInterestCode', 'ref', 'sourceCode', 'stage', 'upcomingTrial']);
  assert.deepEqual(sent.leads.map((x) => [x.ref, x.stage, x.upcomingTrial, x.sourceCode]), [['L1', 'S1', false, 'WEBSITE_FORM'], ['L2', 'S1', true, null], ['L3', 'S4', false, null], ['L4', 'S1', false, 'REFERRAL']]);
  assert.deepEqual(sent.leadPipelines, { L1: 'P1', L2: 'P1', L3: 'P2', L4: 'P1' });
  assert.deepEqual(sent.stages.map((x) => [x.ref, x.name, x.pipeline]), [['S1', 'New', 'P1'], ['S2', 'Contacted', 'P1'], ['S3', 'Trial booked', 'P1'], ['S4', 'Adult new', 'P2'], ['S5', 'Adult called', 'P2']]);
  assert.deepEqual(sent.classes.map((x) => [x.ref, x.name, x.minutes]), [['C1', 'Kids basics', 60], ['C2', 'Kids basics late', 60]]);
  assert.equal(/Synthlead|Robin|Casey|Taylor|Jamie|example\.test|\+1555|clp1-|Avery|walk-in/.test(fake.inputs[0].request), false, 'no name, email, phone, subject or free-text source is sent');
  assert.deepEqual([fake.inputs[0].inputBudget, fake.inputs[0].outputBudget, fake.inputs[0].maxCostMicrounits], [10000, 2500, 80000]);
  const r1 = await row('SELECT plan_id FROM hon.ai_text_proposals WHERE id=$1', [v1.id]);
  assert.deepEqual(await row('SELECT agent_key, task_class FROM hon.ai_invocation_plans WHERE id=$1', [r1.plan_id]), { agent_key: 'chad', task_class: 'DRAFT_FOLLOW_UP' });
  assert.deepEqual(await ledger(v1.id), [{ c: 3, spend_class: 'AGENT_INFERENCE', school_id: a.school }]);
  assert.equal((await leadRow(w.leads.Robin)).pipeline_stage_id, w.st.New, 'a suggestion alone moves nothing');
  assert.equal((await row("SELECT count(*)::int n FROM hon.crm_appointments WHERE crm_lead_id=$1", [w.leads.Casey])).n, 0, 'a suggestion alone books nothing');
  pass('ask: only OPEN leads, the open stages of their pipelines and SCHEDULED classes 2 hours to 14 days out are aliased; Chad sees stage, days, codes and trial counts with no name, email, phone or free text; one ledger row; nothing moves or books');

  // 3. A stage move is recorded only after the requester's own move to that stage.
  assert.equal(code(await settle(chad.recordStep(ctx(staff), v1.id, 0, { appointmentId: null }))), 'CHAD_LEAD_PLAN_NOT_DONE', 'not moved yet');
  await move(owner, w.leads.Robin, w.st.Booked);
  await move(owner, w.leads.Robin, w.st.Contacted);
  assert.equal(code(await settle(chad.recordStep(ctx(staff), v1.id, 0, { appointmentId: null }))), 'CHAD_LEAD_PLAN_NOT_DONE', 'someone else\'s move is not this person\'s step');
  await move(staff, w.leads.Robin, w.st.New);
  assert.equal(code(await settle(chad.recordStep(ctx(staff), v1.id, 0, { appointmentId: null }))), 'CHAD_LEAD_PLAN_NOT_DONE', 'the lead is not at the suggested stage');
  await move(staff, w.leads.Robin, w.st.Contacted);
  assert.equal(code(await settle(chad.recordStep(ctx(staff), v1.id, 0, { appointmentId: K() }))), 'CHAD_LEAD_PLAN_INVALID', 'a stage move carries no appointment');
  const s0 = await chad.recordStep(ctx(staff), v1.id, 0, { appointmentId: null });
  assert.equal(s0.replayed, false); assert.equal(s0.leadPlan.status, 'RESULT_RECORDED');
  assert.deepEqual(s0.leadPlan.applied, [{ index: 0, action: 'MOVE_STAGE', leadId: w.leads.Robin, appointmentId: null }]);
  assert.equal((await chad.recordStep(ctx(staff), v1.id, 0, { appointmentId: null })).replayed, true);
  pass('move: recorded only when the lead is at the suggested stage and the requester\'s own stage move to it happened after the list; another person\'s move or a wrong stage is NOT_DONE; a retry replays');

  // 4. A trial is recorded only for the requester's own TRIAL for that lead at exactly the suggested class.
  const c1 = v1.classes[0], c2 = v1.classes[1];
  assert.equal(code(await settle(chad.recordStep(ctx(staff), v1.id, 1, { appointmentId: null }))), 'CHAD_LEAD_PLAN_INVALID', 'a booking needs its appointment');
  assert.equal(code(await settle(chad.recordStep(ctx(staff), v1.id, 1, { appointmentId: taylorTrial.id }))), 'CHAD_LEAD_PLAN_NOT_DONE', 'another lead\'s trial, made by someone else before the list');
  const jamieTrial = await book(staff, w.leads.Jamie, c1);
  assert.equal(code(await settle(chad.recordStep(ctx(staff), v1.id, 1, { appointmentId: jamieTrial.id }))), 'CHAD_LEAD_PLAN_NOT_DONE', 'a trial for another lead');
  const ownerCasey = await book(owner, w.leads.Casey, c1);
  assert.equal(code(await settle(chad.recordStep(ctx(staff), v1.id, 1, { appointmentId: ownerCasey.id }))), 'CHAD_LEAD_PLAN_NOT_DONE', 'a trial booked by someone else');
  await admin.query("UPDATE hon.crm_appointments SET status='CANCELLED' WHERE id=$1", [ownerCasey.id]);
  const wrongTime = await book(staff, w.leads.Casey, c2);
  assert.equal(code(await settle(chad.recordStep(ctx(staff), v1.id, 1, { appointmentId: wrongTime.id }))), 'CHAD_LEAD_PLAN_NOT_DONE', 'a trial at another class time');
  await admin.query("UPDATE hon.crm_appointments SET status='CANCELLED' WHERE id=$1", [wrongTime.id]);
  const caseyTrial = await book(staff, w.leads.Casey, c1);
  const s1 = await chad.recordStep(ctx(staff), v1.id, 1, { appointmentId: caseyTrial.id });
  assert.equal(s1.leadPlan.status, 'APPLIED', 'every suggestion recorded closes the list');
  assert.deepEqual(s1.leadPlan.applied.map((x) => [x.index, x.action, x.appointmentId]), [[0, 'MOVE_STAGE', null], [1, 'BOOK_TRIAL', caseyTrial.id]]);
  assert.equal((await chad.recordStep(ctx(staff), v1.id, 1, { appointmentId: caseyTrial.id })).replayed, true);
  assert.equal(code(await settle(chad.recordStep(ctx(staff), v1.id, 1, { appointmentId: jamieTrial.id }))), 'CHAD_LEAD_PLAN_NOT_OPEN');
  const audits = await rows("SELECT next_state FROM hon.audit_events WHERE action_code='chad.lead_plan.step_recorded' AND entity_id=$1 ORDER BY occurred_at", [v1.id]);
  assert.deepEqual(audits.map((x) => x.next_state.action), ['MOVE_STAGE', 'BOOK_TRIAL']);
  pass('trial: recorded only for the requester\'s own TRIAL for that lead at exactly the suggested class, made after the list; other leads, other bookers and other times are NOT_DONE; all steps close the list APPLIED; each step is audited');

  // 5. An appointment is linked to one step only; the NO_TRIAL_YET focus leaves out leads with any trial.
  fake.answer = { summary: 'Robin next.', suggestions: [sug({ action: 'BOOK_TRIAL', lead: 'L1', stage: null, slot: 'C1' })] };
  const v2 = await chad.request(ctx(staff), noTrial);
  assert.deepEqual(v2.leads.map((x) => x.leadId), [w.leads.Robin], 'Taylor, Jamie and Casey each have a trial');
  assert.equal(JSON.parse(fake.inputs.at(-1).request).brief.note, 'Spring push');
  assert.equal(code(await settle(chad.recordStep(ctx(staff), v2.id, 0, { appointmentId: caseyTrial.id }))), 'CHAD_LEAD_PLAN_NOT_DONE');
  assert.equal((await chad.dismiss(ctx(staff), v2.id)).status, 'DISMISSED');
  assert.equal(code(await settle(chad.recordStep(ctx(staff), v2.id, 0, { appointmentId: K() }))), 'CHAD_LEAD_PLAN_NOT_OPEN');
  pass('focus: NO_TRIAL_YET sends only leads with no trial at all; an appointment already linked, or one for another lead, never records; a dismissed list records nothing');

  // 6. A paid answer outside the shape or the facts is rejected and keeps its usage.
  for (const answer of [
    { summary: 'x', suggestions: [sug({ lead: 'L3', stage: 'S2' })] }, // a Kids stage for an Adults lead
    { summary: 'x', suggestions: [sug({ lead: 'L1', stage: 'S2' })] }, // Robin is already at Contacted
    { summary: 'x', suggestions: [sug({ action: 'BOOK_TRIAL', lead: 'L2', stage: null, slot: 'C1' })] }, // Taylor has a trial ahead
    { summary: 'x', suggestions: [sug({ lead: 'L9' })] },
    { summary: 'x', suggestions: [sug({ action: 'BOOK_TRIAL', lead: 'L4', stage: null, slot: 'C7' })] },
    { summary: 'x', suggestions: [sug({ lead: 'L1', stage: 'S3' }), sug({ lead: 'L1', stage: 'S1' })] },
    { summary: 'x', suggestions: [sug({ action: 'CALL' })] },
    { summary: 'x', suggestions: [sug({ action: 'BOOK_TRIAL', lead: 'L4', stage: 'S2', slot: 'C1' })] },
  ]) {
    fake.answer = answer;
    const bad = await chad.request(ctx(staff), all);
    assert.equal(bad.status, 'RESULT_REJECTED', JSON.stringify(answer)); assert.deepEqual(bad.problems, ['The answer was not a list of next steps for these leads.'], JSON.stringify(answer));
    assert.equal((await ledger(bad.id)).length, 1);
  }
  fake.answer = { summary: 'x', suggestions: [sug({ lead: 'L1', stage: 'S3', reason: 'Email them at someone@example.test today.' })] };
  const linked = await chad.request(ctx(staff), all);
  assert.deepEqual([linked.status, linked.problems], ['RESULT_REJECTED', ['The answer holds a link or an email address.']]);
  assert.equal(code(await settle(chad.recordStep(ctx(staff), linked.id, 0, { appointmentId: null }))), 'CHAD_LEAD_PLAN_NOT_OPEN');
  pass('rejected: a stage from another pipeline, the current stage, a trial for a lead with one ahead, unknown aliases, two steps for one lead, an unknown action, mixed fields or a link keep their usage, show their problems and record nothing');

  // 7. Unknown outcome and HQ usage attribution.
  fake.mode = 'UNKNOWN'; fake.answer = { summary: 'x', suggestions: [sug({ stage: 'S3' })] };
  const lost = await chad.request(ctx(staff), all);
  assert.equal(lost.status, 'UNKNOWN');
  fake.mode = 'OK';
  pass('unknown: a lost provider outcome is UNKNOWN and is never retried');

  // 8. Gates: Chad's follow-up assistant, lead read, AI planning, Complete; requester-only reading; isolation.
  const calls = fake.calls;
  for (const [label, missing] of [['nodraft', 'crm.assistant.follow_up_draft'], ['noplan', 'ai.invocation.plan'], ['noread', 'crm.lead.read']]) {
    const st = await addStaff(a, label, CHAD.filter((p) => p !== missing));
    assert.equal(code(await settle(chad.request(ctx(st), all))), 'CHAD_LEAD_PLAN_FORBIDDEN', missing);
  }
  const other = await addStaff(a, 'other', CHAD);
  assert.deepEqual(await chad.list(readCtx(other)), [], 'lists are the requester\'s own');
  assert.equal((await settle(chad.read(readCtx(other), v1.id))).error?.getStatus(), 404);
  assert.equal((await settle(chad.recordStep(ctx(other), v1.id, 0, { appointmentId: null }))).error?.getStatus(), 404);
  const b = await makeOrg('b');
  await admin.query("UPDATE hon.organization_entitlements SET tier='CORE' WHERE organization_id=$1", [b.id]);
  assert.equal(code(await settle(chad.request(ctx(b), all))), 'CHAD_LEAD_PLAN_FORBIDDEN', 'Complete is required');
  await admin.query("UPDATE hon.organization_entitlements SET tier='COMPLETE' WHERE organization_id=$1", [b.id]);
  for (const badBrief of [{ focus: 'HOT_ONLY', note: '' }, { focus: 'ALL_OPEN' }, { ...all, note: ' padded' }, { ...all, extra: 1 }]) {
    assert.equal(code(await settle(chad.request(ctx(b), badBrief))), 'CHAD_LEAD_PLAN_INVALID', JSON.stringify(badBrief));
  }
  assert.equal(code(await settle(chad.request(ctx(b, { source: 'AI_AGENT' }), all))), 'HUMAN_COMMAND_REQUIRED');
  assert.equal((await settle(chad.read(readCtx(b), v1.id))).error?.getStatus(), 404);
  assert.equal(fake.calls, calls); assert.equal(networkCalls, 0);
  pass('gates: missing Chad\'s follow-up assistant, lead read, AI planning or Complete is refused before any call; lists are the requester\'s own; bad briefs and non-human sources are refused; schools are isolated');

  // 9. Evidence rows cannot be changed.
  await assert.rejects(admin.query('UPDATE hon.chad_lead_plan_refs SET ref=ref WHERE proposal_id=$1', [v1.id]), /ALEX_PLAN_ROWS_IMMUTABLE/);
  await assert.rejects(admin.query('DELETE FROM hon.chad_lead_plan_applied WHERE proposal_id=$1', [v1.id]), /ALEX_PLAN_ROWS_IMMUTABLE/);
  pass('evidence: aliases and recorded steps are append-only');

  { const verify = await (await import('node:fs/promises')).readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
    const section = verify.split('-- Chad lead next steps exact verification (0650)')[1]?.split('-- End Chad lead next steps exact verification.')[0];
    assert.ok(section, '0650 verify section present');
    await admin.query(section.slice(section.indexOf('\nDO $$')).replaceAll('hon_runtime', runtimeRole));
    await admin.query(verify.replaceAll('hon_runtime', runtimeRole)); }
  pass('011: the 0650 exact verification and the whole canonical 011 pass');
  console.log(`CLP1 Chad lead next steps: ${groups} groups passed, ${fake.calls} fake provider calls, 0 network calls`);
} finally {
  await admin.end().catch(() => {});
  await db.onModuleDestroy?.().catch?.(() => {});
}
