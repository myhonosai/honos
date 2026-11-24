/**
 * P5 (0646): Maya renewal prep on the shared AI text proposal table, through the real API service, the restricted runtime
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
const { MayaRenewalService } = await import('../../../apps/api/dist/maya-renewal/maya-renewal.service.js');
const { MerchProviderRuntimeError } = await import('../../../apps/api/dist/commerce/shopify/merch-provider-runtime.js');

const admin = new pg.Client({ connectionString: ownerUrl, ssl: false });
const row = async (sql, args = []) => (await admin.query(sql, args)).rows[0];
const rows = async (sql, args = []) => (await admin.query(sql, args)).rows;
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
const code = (r) => r.error?.getResponse?.().code;
let groups = 0; const pass = (name) => console.log(`PASS MRP1 ${++groups} ${name}`);

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
const db = new RuntimeDatabaseService(), plans = new AiInvocationPlanService(db), maya = new MayaRenewalService(db, plans, provider);
const catalog = K(), hq = { id: K(), user: K(), subject: `mrp1-hq-owner-${K()}` };
const ctx = (o, patch = {}) => ({ organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: K(), correlationId: K(), idempotencyKey: K(), ...patch });
const readCtx = (o) => ctx(o, { idempotencyKey: '' });
const next30 = { window: 'NEXT_30_DAYS', note: '' };
const next60 = { window: 'NEXT_60_DAYS', note: 'Summer break is coming' };
const s = (patch = {}) => ({ membership: 'M1', priority: 'HIGH', talkingPoint: 'Ask how the new class time is working for the family.', reason: 'Attendance dropped and the term ends soon.', ...patch });

async function makeOrg(label) {
  const o = { label, id: K(), school: K(), user: K(), principal: K(), role: K(), subject: `mrp1-${label}-${K()}`, policy: K() };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'MRP1 synthetic organization','MRP1 synthetic organization')", [o.id]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'Synthetic Dojo',$1::uuid::text,'America/New_York')", [o.school, o.id]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day')", [o.id]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','Avery Synthowner')", [o.user, o.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Avery Synthowner')", [o.principal, o.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','MRP1 synthetic owner',true)", [o.role, o.id]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions', [o.role, o.id]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '3 days')", [o.id, o.school, o.principal, o.role]);
  await admin.query("INSERT INTO hon.hq_ai_routing_policies(policy_id,organization_id,school_id,capability,active,minimum_tier,max_cost_micros,effective_from) VALUES($1,$2,$3,'TEXT',true,'COMPLETE',150000,'2020-01-01')", [o.policy, o.id, o.school]);
  await admin.query('INSERT INTO hon.hq_ai_routing_candidates(policy_id,ordinal,catalog_id) VALUES($1,0,$2)', [o.policy, catalog]);
  await admin.query('COMMIT');
  return o;
}
async function addStaff(o, label, permissions, name, since = '2 days') {
  const st = { ...o, user: K(), principal: K(), role: K(), subject: `mrp1-${label}-${K()}`, name };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test',$3)", [st.user, st.subject, name]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3)", [st.principal, st.user, name]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,'MRP1 synthetic staff',false)", [st.role, o.id, 'MRP1_' + label.toUpperCase()]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,unnest($3::text[])', [st.role, o.id, permissions]);
  await admin.query(`INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '${since}')`, [o.id, o.school, st.principal, st.role, o.principal]);
  await admin.query('COMMIT');
  return st;
}
// Synthetic memberships, students and attendance, written by the migration owner with user triggers paused (disposable fixture only).
const SEEDED = ['people', 'student_profiles', 'billing_accounts', 'memberships', 'programs', 'class_sessions', 'attendance_records'];
const at = (days) => `clock_timestamp()+make_interval(mins=>${Math.round(days * 1440)})`;
async function seed(o, memberships) {
  const out = {};
  await admin.query('BEGIN');
  for (const t of SEEDED) await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  const program = K();
  await admin.query("INSERT INTO hon.programs(id,organization_id,school_id,name) VALUES($1,$2,$3,'Synthetic program '||$1::uuid::text)", [program, o.id, o.school]);
  for (const m of memberships) {
    const p = K(), account = K(), sp = K(), id = K();
    await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email) VALUES($1,$2,$3,$4,'Synthperson',$1::uuid::text||'@example.test')", [p, o.id, o.school, m.name]);
    await admin.query('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)', [sp, o.id, o.school, p]);
    await admin.query('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id) VALUES($1,$2,$3,$4)', [account, o.id, o.school, p]);
    await admin.query(`INSERT INTO hon.memberships(id,organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at)
      VALUES($1,$2,$3,$4,$5,'SYNTH_PLAN_CODE',$6::hon.membership_state,${at(-m.started)},${m.ends === null ? 'NULL' : at(m.ends)})`, [id, o.id, o.school, account, p, m.state]);
    for (const d of m.attended ?? []) {
      const session = K();
      await admin.query(`INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy) VALUES($1,$2,$3,$4,'Synthetic class',${at(-d)},${at(-d + 0.05)},20,'WALK_IN')`, [session, o.id, o.school, program]);
      await admin.query(`INSERT INTO hon.attendance_records(organization_id,school_id,class_session_id,student_profile_id,status,recorded_at,progression_enabled) VALUES($1,$2,$3,$4,'PRESENT',${at(-d)},false)`, [o.id, o.school, session, sp]);
    }
    out[m.name] = id;
  }
  await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
  for (const t of SEEDED) await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  await admin.query('COMMIT');
  return out;
}
async function bumpMembership(id) {
  await admin.query('BEGIN'); await admin.query('ALTER TABLE hon.memberships DISABLE TRIGGER USER');
  await admin.query('UPDATE hon.memberships SET version=version+1 WHERE id=$1', [id]);
  await admin.query('ALTER TABLE hon.memberships ENABLE TRIGGER USER'); await admin.query('COMMIT');
}
const ledger = (id) => rows('SELECT customer_credits::int c, spend_class, school_id FROM hon.ai_usage_ledger WHERE source_invocation_id=$1', [id]);
const proposalRow = (id) => row('SELECT * FROM hon.ai_text_proposals WHERE id=$1', [id]);
const reviews = (o) => rows(`SELECT f.id, f.membership_id, f.created_by_principal_id, v.version, v.status, v.note, v.reason, v.reminder_needed, v.actor_principal_id,
  to_char(v.review_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS') review_to, v.review_from FROM hon.membership_renewal_reviews f JOIN hon.membership_renewal_versions v ON v.renewal_id=f.id
  WHERE f.organization_id=$1 AND f.school_id=$2 ORDER BY f.created_at, f.id`, [o.id, o.school]);

try {
  await admin.connect();
  assert.equal((await row('SELECT current_database() d')).d, database);

  // 1. Custody.
  const entry = ['begin_maya_renewal_prep', 'plan_maya_renewal_prep', 'prepare_maya_renewal_prep', 'fail_maya_renewal_prep', 'record_maya_renewal_prep', 'read_maya_renewal_preps', 'apply_maya_renewal_preps', 'close_maya_renewal_prep'];
  const fns = await rows("SELECT p.oid, p.proname, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%maya_renewal%'");
  assert.equal(fns.length, 16, fns.map((f) => f.proname).join(','));
  for (const f of fns) {
    assert.equal((await row("SELECT has_function_privilege($1,$2::oid,'EXECUTE') ok", [runtimeRole, f.oid])).ok, entry.includes(f.proname), f.proname);
    assert.equal((await row("SELECT coalesce(bool_or(a.grantee=0),false) pub FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1", [f.oid])).pub, false, f.proname);
    if (entry.includes(f.proname)) assert.equal(f.prosecdef, true, f.proname);
  }
  for (const t of ['maya_renewal_refs', 'maya_renewal_applied']) {
    const c = await row("SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE oid=('hon.'||$1)::regclass", [t]);
    assert.deepEqual([c.r, c.f], [true, true], t);
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.equal((await row('SELECT has_table_privilege($1,$2,$3) ok', [runtimeRole, `hon.${t}`, priv])).ok, false, `${t} ${priv}`);
  }
  const kind = await row("SELECT * FROM hon.ai_text_kinds WHERE kind='MAYA_RENEWAL_PREP'");
  assert.deepEqual([kind.agent_key, kind.task_class, kind.input_budget, kind.output_budget, Number(kind.max_cost_microunits), kind.max_result_bytes, kind.caller, kind.subject_type, kind.usage_agent],
    ['maya', 'ANALYZE', 12000, 3000, 80000, 12288, 'HUMAN_UI', 'SCHOOL', 'RETENTION']);
  pass('custody: MAYA_RENEWAL_PREP kind fixed (maya, ANALYZE, 12,000/3,000, 80,000 micro-USD, RETENTION), runtime executes exactly eight definer entry points, nothing to PUBLIC, both tables forced RLS with no runtime access');

  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state,credential_secret_ref) VALUES('OPENROUTER','MRP1 synthetic route','HEALTHY',$1) ON CONFLICT (provider_id) DO NOTHING", [`hon-secret:${K()}`]);
  await admin.query("INSERT INTO hon.hq_ai_model_catalog(catalog_id,provider_id,model_id,display_name,capabilities,modalities,active,minimum_tier,unit_cost_micros,cost_unit,effective_from) VALUES($1,'OPENROUTER','approved/mrp1-synthetic','MRP1 synthetic model',ARRAY['TEXT'],ARRAY['TEXT'],true,'COMPLETE',2,'TOKEN','2020-01-01')", [catalog]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','MRP1 synthetic HQ owner')", [hq.user, hq.subject]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','MRP1 synthetic HQ owner',true)", [hq.id, hq.user]);
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER','{}',clock_timestamp()-interval '2 days')", [hq.id]);
  await admin.query('COMMIT');

  // 2. Ask: only ACTIVE or CANCELLATION_PENDING memberships ending inside the window, soonest first, as M aliases with numbers only.
  const a = await makeOrg('a');
  const m = await seed(a, [
    { name: 'Robin', state: 'ACTIVE', started: 400, ends: 5, attended: [2, 9, 35, 38, 41, 44, 50] },
    { name: 'Casey', state: 'CANCELLATION_PENDING', started: 200, ends: 20, attended: [1] },
    { name: 'Jamie', state: 'ACTIVE', started: 90, ends: 45, attended: [] },
    { name: 'Quinn', state: 'CANCELLED', started: 300, ends: 4 },
    { name: 'Drew', state: 'ACTIVE', started: 60, ends: null },
    { name: 'Lee', state: 'ACTIVE', started: 380, ends: -2 },
    { name: 'Frozen', state: 'FROZEN', started: 100, ends: 6 },
  ]);
  fake.answer = { summary: 'Two renewals this month.', suggestions: [s({ membership: 'M1' }), s({ membership: 'M2', priority: 'NORMAL', talkingPoint: 'Ask what would make staying work.' })] };
  const v1 = await maya.request(ctx(a), next30);
  assert.equal(v1.status, 'RESULT_RECORDED', JSON.stringify(v1)); assert.deepEqual(v1.suggestions, fake.answer.suggestions);
  assert.deepEqual(v1.memberships.map((x) => [x.ref, x.membershipId, x.name]), [['M1', m.Robin, 'Robin Synthperson'], ['M2', m.Casey, 'Casey Synthperson']]);
  assert.equal(fake.calls, 1);
  const sent = JSON.parse(fake.inputs[0].request);
  assert.deepEqual(Object.keys(sent).sort(), ['brief', 'localToday', 'memberships', 'schoolName']);
  assert.deepEqual(Object.keys(sent.memberships[0]).sort(), ['classesLast30Days', 'classesPrevious30Days', 'daysSinceLastClass', 'daysUntilTermEnds', 'monthsAsMember', 'ref', 'renewalReviewOpen', 'state']);
  assert.deepEqual(sent.memberships.map((x) => [x.ref, x.state, x.classesLast30Days, x.classesPrevious30Days, x.daysSinceLastClass, x.monthsAsMember, x.renewalReviewOpen]),
    [['M1', 'ACTIVE', 2, 5, 2, 13, false], ['M2', 'CANCELLATION_PENDING', 1, 0, 1, 6, false]]);
  assert.ok(sent.memberships[0].daysUntilTermEnds >= 4 && sent.memberships[0].daysUntilTermEnds <= 6);
  assert.equal(/Synthperson|Robin|Casey|example\.test|mrp1-|SYNTH_PLAN_CODE|Avery/.test(fake.inputs[0].request), false, 'no name, email, subject or plan code is sent');
  assert.equal(Buffer.byteLength(fake.inputs[0].request) < 12000 - 128 - 2500, true);
  assert.deepEqual([fake.inputs[0].inputBudget, fake.inputs[0].outputBudget, fake.inputs[0].maxCostMicrounits], [12000, 3000, 80000]);
  const r1 = await proposalRow(v1.id);
  assert.deepEqual(await row('SELECT agent_key, task_class FROM hon.ai_invocation_plans WHERE id=$1', [r1.plan_id]), { agent_key: 'maya', task_class: 'ANALYZE' });
  assert.deepEqual(await ledger(v1.id), [{ c: 3, spend_class: 'AGENT_INFERENCE', school_id: a.school }]);
  assert.equal((await reviews(a)).length, 0, 'a suggestion alone opens no review');
  fake.answer = { summary: 'Three ahead.', suggestions: [s({ membership: 'M3' })] };
  const v60 = await maya.request(ctx(a), next60);
  assert.deepEqual(v60.memberships.map((x) => x.name), ['Robin Synthperson', 'Casey Synthperson', 'Jamie Synthperson']);
  assert.equal(JSON.parse(fake.inputs[1].request).brief.note, 'Summer break is coming');
  pass('ask: only ACTIVE or CANCELLATION_PENDING memberships ending inside the window are sent, soonest first, as M aliases with state, days, months and attendance counts; no name, email, plan code or amount; one ledger row; no review opens');

  // 3. Apply: each ticked suggestion opens an OPEN renewal review through 0080 as the requester; an exact retry replays.
  const ck = ctx(a);
  const applied = await maya.apply(ck, v1.id, { suggestions: [1, 0] });
  assert.equal(applied.replayed, false); assert.equal(applied.renewalPrep.status, 'APPLIED'); assert.deepEqual(applied.renewalPrep.applied.map((x) => x.index), [0, 1]);
  const made = await reviews(a);
  assert.equal(made.length, 2);
  const robin = made.find((x) => x.membership_id === m.Robin);
  const end = await row("SELECT to_char(date_trunc('milliseconds',term_ends_at) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS') e FROM hon.memberships WHERE id=$1", [m.Robin]);
  assert.deepEqual([robin.version, robin.status, robin.reminder_needed, robin.actor_principal_id, robin.created_by_principal_id, robin.review_to],
    [1, 'OPEN', true, a.principal, a.principal, end.e]);
  assert.equal(robin.note, 'Ask how the new class time is working for the family.\nWhy: Attendance dropped and the term ends soon.');
  assert.equal(robin.reason, 'Prepared with Maya (High priority)');
  assert.equal(made.find((x) => x.membership_id === m.Casey).reason, 'Prepared with Maya (Normal priority)');
  assert.deepEqual(applied.renewalPrep.applied.map((x) => x.renewalId).sort(), made.map((x) => x.id).sort());
  const events = await rows("SELECT count(*)::int n FROM hon.outbox_events WHERE organization_id=$1 AND event_type='billing.renewal.human_revised'", [a.id]);
  assert.equal(events[0].n, 2, 'the ordinary renewal event is written for each review');
  const again = await maya.apply({ ...ck, requestId: K(), correlationId: K() }, v1.id, { suggestions: [0, 1] });
  assert.equal(again.replayed, true); assert.equal((await reviews(a)).length, 2);
  assert.equal(code(await settle(maya.apply(ctx(a), v1.id, { suggestions: [0] }))), 'MAYA_RENEWAL_NOT_OPEN');
  pass('apply: each ticked suggestion opens an OPEN renewal review (now to the term end, talking point and why as the note, reminder on) through 0080 as the requester with its usual event; an exact retry replays; a used list is closed');

  // 4. Refusals: an open review already there, a changed membership, all or nothing.
  fake.answer = { summary: 'Again.', suggestions: [s({ membership: 'M1' }), s({ membership: 'M3', priority: 'LOW' })] };
  const v2 = await maya.request(ctx(a), next60);
  assert.equal(JSON.parse(fake.inputs.at(-1).request).memberships[0].renewalReviewOpen, true, 'Maya sees the review is already open');
  assert.equal(code(await settle(maya.apply(ctx(a), v2.id, { suggestions: [1, 0] }))), 'MAYA_RENEWAL_REVIEW_OPEN');
  assert.equal((await reviews(a)).length, 2, 'all or nothing');
  await bumpMembership(m.Jamie);
  assert.equal(code(await settle(maya.apply(ctx(a), v2.id, { suggestions: [1] }))), 'MAYA_RENEWAL_MEMBERSHIP_CHANGED');
  assert.equal((await reviews(a)).length, 2); assert.equal((await proposalRow(v2.id)).status, 'RESULT_RECORDED');
  fake.answer = { summary: 'Jamie.', suggestions: [s({ membership: 'M3', priority: 'LOW' })] };
  const v3 = await maya.request(ctx(a), next60);
  assert.equal((await maya.apply(ctx(a), v3.id, { suggestions: [0] })).renewalPrep.status, 'APPLIED');
  assert.equal((await reviews(a)).length, 3);
  pass('refused: a membership with an open review, or changed after Maya read it, refuses the whole apply with nothing partial; a fresh list applies');

  // 5. A paid answer outside the shape, naming an unknown membership, two suggestions for one membership, or a link is rejected.
  for (const answer of [{ summary: 'x', suggestions: [{ membership: 'M1' }] }, { summary: 'x', suggestions: [s({ membership: 'M9' })] },
    { summary: 'x', suggestions: [s(), s({ priority: 'LOW' })] }, { summary: 'x', suggestions: [s({ priority: 'URGENT' })] }]) {
    fake.answer = answer;
    const bad = await maya.request(ctx(a), next30);
    assert.equal(bad.status, 'RESULT_REJECTED', JSON.stringify(answer)); assert.deepEqual(bad.problems, ['The answer was not a renewal list for these memberships.']); assert.equal((await ledger(bad.id)).length, 1);
  }
  fake.answer = { summary: 'x', suggestions: [s({ talkingPoint: 'Send them www.example.test for the offer.' })] };
  const linked = await maya.request(ctx(a), next30);
  assert.deepEqual([linked.status, linked.problems], ['RESULT_REJECTED', ['The answer holds a link or an email address.']]);
  assert.equal(code(await settle(maya.apply(ctx(a), linked.id, { suggestions: [0] }))), 'MAYA_RENEWAL_NOT_OPEN');
  assert.equal((await maya.dismiss(ctx(a), linked.id)).status, 'DISMISSED');
  pass('rejected: an answer outside the shape, with an unknown membership alias, two suggestions for one membership, or a link keeps its usage, shows its problems and never opens a review');

  // 6. Unknown outcome and HQ usage.
  fake.mode = 'UNKNOWN'; fake.answer = { summary: 'x', suggestions: [s()] };
  const lost = await maya.request(ctx(a), next30);
  assert.equal(lost.status, 'UNKNOWN'); assert.equal((await proposalRow(lost.id)).reserved_credits > 0, true);
  const queue = (await row('SELECT hon.read_ai_unknown_invocations_from_hq($1) r', [hq.subject])).r;
  assert.equal(queue.open.find((q) => q.invocationId === lost.id)?.agent, 'TEXT_PROPOSAL');
  fake.mode = 'OK';
  const usage = (await row('SELECT hon.read_ai_school_usage_from_hq($1,$2::timestamptz,$3::timestamptz) r', [hq.subject, new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString()])).r;
  const by = usage.schools.find((x) => x.schoolId === a.school).byClass.AGENT_INFERENCE.byAgent;
  assert.ok(by.RETENTION?.credits > 0, JSON.stringify(by)); assert.equal(by.UNATTRIBUTED, undefined);
  pass('unknown and usage: a lost outcome keeps its hold and appears in the HQ queue; the HQ per-school read attributes Maya to RETENTION');

  // 7. Gates: Maya, membership read, renewal management, AI planning, Complete; requester-only reading; isolation.
  const calls = fake.calls;
  const retentionOnly = await addStaff(a, 'retention', ['retention.review.read', 'ai.invocation.plan'], 'Morgan Synthretain');
  assert.equal(code(await settle(maya.request(ctx(retentionOnly), next30))), 'MAYA_RENEWAL_FORBIDDEN');
  assert.equal(code(await settle(maya.list(readCtx(retentionOnly)))), 'MAYA_RENEWAL_FORBIDDEN', 'names and term dates need membership read');
  const billingOnly = await addStaff(a, 'billing', ['billing.membership.read', 'billing.renewal.manage', 'ai.invocation.plan'], 'Sam Synthbilling');
  assert.equal(code(await settle(maya.request(ctx(billingOnly), next30))), 'MAYA_RENEWAL_FORBIDDEN', 'Maya capability is required');
  const reader = await addStaff(a, 'reader', ['retention.review.read', 'billing.membership.read', 'ai.invocation.plan'], 'Pat Synthreader');
  assert.equal(code(await settle(maya.request(ctx(reader), next30))), 'MAYA_RENEWAL_FORBIDDEN', 'asking needs renewal review management');
  assert.deepEqual(await maya.list(readCtx(reader)), [], 'a reader sees only their own lists');
  assert.equal((await settle(maya.read(readCtx(reader), v1.id))).error?.getStatus(), 404);
  assert.equal((await settle(maya.dismiss(ctx(reader), v2.id))).error?.getStatus(), 404);
  const noAi = await addStaff(a, 'noai', ['retention.review.read', 'billing.membership.read', 'billing.renewal.manage'], 'Kim Synthnoai');
  assert.equal(code(await settle(maya.request(ctx(noAi), next30))), 'MAYA_RENEWAL_FORBIDDEN');
  const b = await makeOrg('b');
  await admin.query("UPDATE hon.organization_entitlements SET tier='CORE' WHERE organization_id=$1", [b.id]);
  assert.equal(code(await settle(maya.request(ctx(b), next30))), 'MAYA_RENEWAL_FORBIDDEN');
  await admin.query("UPDATE hon.organization_entitlements SET tier='COMPLETE' WHERE organization_id=$1", [b.id]);
  for (const badBrief of [{ window: 'NEXT_90_DAYS', note: '' }, { window: 'NEXT_30_DAYS' }, { ...next30, note: ' padded' }, { ...next30, note: 'api_key: abc' }, { ...next30, extra: 1 }]) {
    assert.equal(code(await settle(maya.request(ctx(b), badBrief))), 'MAYA_RENEWAL_INVALID', JSON.stringify(badBrief));
  }
  assert.equal(code(await settle(maya.request(ctx(b, { source: 'AI_AGENT' }), next30))), 'HUMAN_COMMAND_REQUIRED');
  assert.equal((await settle(maya.read(readCtx(b), v1.id))).error?.getStatus(), 404);
  assert.equal((await settle(maya.apply(ctx(b), v2.id, { suggestions: [1] }))).error?.getStatus(), 404);
  assert.equal(fake.calls, calls); assert.equal(networkCalls, 0);
  pass('gates: missing Maya, membership read, renewal management, AI planning or Complete is refused before any row; lists are the requester\'s own; bad briefs and non-human sources are refused; schools are isolated');

  // 8. Evidence rows cannot be changed.
  await assert.rejects(admin.query('UPDATE hon.maya_renewal_refs SET ref=ref WHERE proposal_id=$1', [v1.id]), /ALEX_PLAN_ROWS_IMMUTABLE/);
  await assert.rejects(admin.query('DELETE FROM hon.maya_renewal_applied WHERE proposal_id=$1', [v1.id]), /ALEX_PLAN_ROWS_IMMUTABLE/);
  pass('evidence: aliases and applied links are append-only');

  { const verify = await (await import('node:fs/promises')).readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
    const section = verify.split('-- Maya renewal prep exact verification (0646)')[1]?.split('-- End Maya renewal prep exact verification.')[0];
    assert.ok(section, '0646 verify section present');
    await admin.query(section.slice(section.indexOf('\nDO $$')).replaceAll('hon_runtime', runtimeRole));
    await admin.query(verify.replaceAll('hon_runtime', runtimeRole)); }
  pass('011: the 0646 exact verification and the whole canonical 011 pass');
  console.log(`MRP1 Maya renewal prep: ${groups} groups passed, ${fake.calls} fake provider calls, 0 network calls`);
} finally {
  await admin.end().catch(() => {});
  await db.onModuleDestroy?.().catch?.(() => {});
}
