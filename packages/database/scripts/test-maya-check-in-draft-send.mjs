/**
 * P8 (0649): Maya check-in drafts that send once approved (owner decision 2026-11-22, button or voice), through the real API
 * service, the restricted runtime role and the S4 spend controls on a fresh disposable AI-0 fixture. The provider is a counted
 * in-process fake and fetch is refused: nothing leaves the machine. The delivery worker's claim function is called directly to
 * show that a queued message still goes through its consent check at send time. Synthetic names only.
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
const { MayaCheckInService } = await import('../../../apps/api/dist/maya-check-in/maya-check-in.service.js');
const { MerchProviderRuntimeError } = await import('../../../apps/api/dist/commerce/shopify/merch-provider-runtime.js');

const admin = new pg.Client({ connectionString: ownerUrl, ssl: false });
const row = async (sql, args = []) => (await admin.query(sql, args)).rows[0];
const rows = async (sql, args = []) => (await admin.query(sql, args)).rows;
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
const code = (r) => r.error?.getResponse?.().code;
let groups = 0; const pass = (name) => console.log(`PASS MCI1 ${++groups} ${name}`);

const fake = { calls: 0, inputs: [], mode: 'OK', answer: null, ready: true };
const provider = {
  readiness: () => (fake.ready ? 'READY' : 'CONFIGURATION_REQUIRED'),
  generate: async (input) => {
    fake.calls += 1; fake.inputs.push(input);
    if (fake.mode === 'UNKNOWN') throw new MerchProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    if (fake.mode === 'FAILED') throw new MerchProviderRuntimeError('FAILED', 'PROVIDER_REJECTED');
    return { proposal: typeof fake.answer === 'function' ? fake.answer(JSON.parse(input.request)) : fake.answer, inputTokens: 900, outputTokens: 300, providerCostMicrounits: 800 };
  },
};
const db = new RuntimeDatabaseService(), plans = new AiInvocationPlanService(db), maya = new MayaCheckInService(db, plans, provider);
const catalog = K(), hq = { id: K(), user: K(), subject: `mci1-hq-owner-${K()}` };
const ctx = (o, patch = {}) => ({ organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: K(), correlationId: K(), idempotencyKey: K(), ...patch });
const readCtx = (o) => ctx(o, { idempotencyKey: '' });
const sms = (patch = {}) => ({ summary: 'Blake has not trained for five weeks; a warm hello may bring them back.', message: 'Hi [First name], we miss you on the mat!\nIs there a class time that would work better for you?', subject: '', ...patch });
const mail = (patch = {}) => ({ ...sms(), subject: 'We miss you at the dojo', ...patch });
const brief = (membershipId, channel = 'SMS', note = '') => ({ membershipId, channel, note });
const button = (message, patch = {}) => ({ recipient: 'STUDENT', message, subject: '', sendAt: null, approvalMethod: 'BUTTON', voiceTurnId: null, ...patch });
async function makeOrg(label) {
  const o = { label, id: K(), school: K(), user: K(), principal: K(), role: K(), subject: `mci1-${label}-${K()}`, policy: K() };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'MCI1 synthetic organization','MCI1 synthetic organization')", [o.id]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'Synthetic Dojo',$1::uuid::text,'America/New_York')", [o.school, o.id]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day')", [o.id]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','Avery Synthowner')", [o.user, o.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Avery Synthowner')", [o.principal, o.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','MCI1 synthetic owner',true)", [o.role, o.id]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions', [o.role, o.id]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '3 days')", [o.id, o.school, o.principal, o.role]);
  await admin.query("INSERT INTO hon.hq_ai_routing_policies(policy_id,organization_id,school_id,capability,active,minimum_tier,max_cost_micros,effective_from) VALUES($1,$2,$3,'TEXT',true,'COMPLETE',150000,'2020-01-01')", [o.policy, o.id, o.school]);
  await admin.query('INSERT INTO hon.hq_ai_routing_candidates(policy_id,ordinal,catalog_id) VALUES($1,0,$2)', [o.policy, catalog]);
  await admin.query('COMMIT');
  return o;
}
async function addStaff(o, label, permissions, name, since = '2 days') {
  const st = { ...o, user: K(), principal: K(), role: K(), subject: `mci1-${label}-${K()}`, name };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test',$3)", [st.user, st.subject, name]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3)", [st.principal, st.user, name]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,'MCI1 synthetic staff',false)", [st.role, o.id, 'MCI1_' + label.toUpperCase()]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,unnest($3::text[])', [st.role, o.id, permissions]);
  await admin.query(`INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '${since}')`, [o.id, o.school, st.principal, st.role, o.principal]);
  await admin.query('COMMIT');
  return st;
}
// Synthetic students, billing contacts and attendance, written by the migration owner with user triggers paused (disposable fixture only).
const SEEDED = ['people', 'student_profiles', 'billing_accounts', 'memberships', 'programs', 'class_sessions', 'attendance_records'];
const at = (days) => `clock_timestamp()+make_interval(mins=>${Math.round(days * 1440)})`;
async function seed(o, students) {
  const out = {};
  await admin.query('BEGIN');
  for (const t of SEEDED) await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  const program = K();
  await admin.query("INSERT INTO hon.programs(id,organization_id,school_id,name) VALUES($1,$2,$3,'Synthetic program '||$1::uuid::text)", [program, o.id, o.school]);
  for (const m of students) {
    const p = K(), account = K(), sp = K(), id = K(), parent = m.parent ? K() : null;
    await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email,phone_e164) VALUES($1,$2,$3,$4,'Synthperson',$1::uuid::text||'@example.test',$5)", [p, o.id, o.school, m.name, m.phone ?? null]);
    if (parent) await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email,phone_e164) VALUES($1,$2,$3,$4,'Synthparent',$1::uuid::text||'@example.test',NULL)", [parent, o.id, o.school, m.parent]);
    await admin.query('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)', [sp, o.id, o.school, p]);
    await admin.query('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id) VALUES($1,$2,$3,$4)', [account, o.id, o.school, parent ?? p]);
    await admin.query(`INSERT INTO hon.memberships(id,organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at)
      VALUES($1,$2,$3,$4,$5,'SYNTH_PLAN_CODE','ACTIVE',${at(-300)},NULL)`, [id, o.id, o.school, account, p]);
    for (const d of m.attended ?? []) {
      const session = K();
      await admin.query(`INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy) VALUES($1,$2,$3,$4,'Synthetic class',${at(-d)},${at(-d + 0.05)},20,'WALK_IN')`, [session, o.id, o.school, program]);
      await admin.query(`INSERT INTO hon.attendance_records(organization_id,school_id,class_session_id,student_profile_id,status,recorded_at,progression_enabled) VALUES($1,$2,$3,$4,'PRESENT',${at(-d)},false)`, [o.id, o.school, session, sp]);
    }
    out[m.name] = { membership: id, person: p, parent };
  }
  await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
  for (const t of SEEDED) await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  await admin.query('COMMIT');
  return out;
}
async function consent(o, person, channel, value) {
  await admin.query(`INSERT INTO hon.communication_consents(organization_id,school_id,person_id,channel,status,source,captured_at,updated_by_principal_id) VALUES($1,$2,$3,$4,$5,'STAFF',now(),$6)
    ON CONFLICT (person_id,channel) DO UPDATE SET status=EXCLUDED.status,version=hon.communication_consents.version+1,updated_at=now()`, [o.id, o.school, person, channel, value, o.principal]);
}
const ledger = (id) => rows('SELECT customer_credits::int c, spend_class, school_id FROM hon.ai_usage_ledger WHERE source_invocation_id=$1', [id]);
const proposalRow = (id) => row('SELECT * FROM hon.ai_text_proposals WHERE id=$1', [id]);
const sendRow = (id) => row('SELECT * FROM hon.maya_check_in_sends WHERE proposal_id=$1', [id]);
const messagesFor = (id) => rows("SELECT * FROM hon.communication_messages WHERE origin_kind='AI_APPROVED_DRAFT' AND origin_id=$1", [id]);
const allMessages = async (o) => Number((await row("SELECT count(*) n FROM hon.communication_messages WHERE organization_id=$1 AND origin_kind='AI_APPROVED_DRAFT'", [o.id])).n);
const draft = async (o, membership, channel = 'SMS', answer = channel === 'EMAIL' ? mail() : sms()) => {
  fake.answer = answer; const v = await maya.request(ctx(o), brief(membership, channel)); assert.equal(v.status, 'RESULT_RECORDED', JSON.stringify(v)); return v;
};

try {
  await admin.connect();
  assert.equal((await row('SELECT current_database() d')).d, database);

  // 1. Custody.
  const entry = ['begin_maya_check_in_draft', 'plan_maya_check_in_draft', 'prepare_maya_check_in_draft', 'fail_maya_check_in_draft', 'record_maya_check_in_draft',
    'read_maya_check_in_drafts', 'approve_maya_check_in_draft', 'cancel_maya_check_in_send', 'close_maya_check_in_draft'];
  const fns = await rows("SELECT p.oid, p.proname, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%maya_check_in%'");
  assert.equal(fns.length, 19, fns.map((f) => f.proname).join(','));
  for (const f of fns) {
    assert.equal((await row("SELECT has_function_privilege($1,$2::oid,'EXECUTE') ok", [runtimeRole, f.oid])).ok, entry.includes(f.proname), f.proname);
    assert.equal((await row("SELECT coalesce(bool_or(a.grantee=0),false) pub FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1", [f.oid])).pub, false, f.proname);
    if (entry.includes(f.proname)) assert.equal(f.prosecdef, true, f.proname);
  }
  for (const t of ['maya_check_in_targets', 'maya_check_in_sends']) {
    const c = await row("SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE oid=('hon.'||$1)::regclass", [t]);
    assert.deepEqual([c.r, c.f], [true, true], t);
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.equal((await row('SELECT has_table_privilege($1,$2,$3) ok', [runtimeRole, `hon.${t}`, priv])).ok, false, `${t} ${priv}`);
  }
  const kind = await row("SELECT * FROM hon.ai_text_kinds WHERE kind='MAYA_CHECK_IN_DRAFT'");
  assert.deepEqual([kind.agent_key, kind.task_class, kind.input_budget, kind.output_budget, Number(kind.max_cost_microunits), kind.max_result_bytes, kind.caller, kind.subject_type, kind.usage_agent],
    ['maya', 'ANALYZE', 6000, 2000, 60000, 8192, 'HUMAN_UI', 'SCHOOL', 'RETENTION']);
  pass('custody: MAYA_CHECK_IN_DRAFT kind fixed (maya, ANALYZE (0284 keeps Maya to ANALYZE), 6,000/2,000, 60,000 micro-USD, RETENTION), runtime executes exactly nine definer entry points, nothing to PUBLIC, both tables forced RLS with no runtime access');

  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state,credential_secret_ref) VALUES('OPENROUTER','MCI1 synthetic route','HEALTHY',$1) ON CONFLICT (provider_id) DO NOTHING", [`hon-secret:${K()}`]);
  await admin.query("INSERT INTO hon.hq_ai_model_catalog(catalog_id,provider_id,model_id,display_name,capabilities,modalities,active,minimum_tier,unit_cost_micros,cost_unit,effective_from) VALUES($1,'OPENROUTER','approved/mci1-synthetic','MCI1 synthetic model',ARRAY['TEXT'],ARRAY['TEXT'],true,'COMPLETE',2,'TOKEN','2020-01-01')", [catalog]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','MCI1 synthetic HQ owner')", [hq.user, hq.subject]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','MCI1 synthetic HQ owner',true)", [hq.id, hq.user]);
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER','{}',clock_timestamp()-interval '2 days')", [hq.id]);
  await admin.query('COMMIT');

  // 2. Ask: only a student on the at-risk list now; Maya sees verified numbers only.
  const a = await makeOrg('a');
  const st = await seed(a, [
    { name: 'Blake', phone: '+15555550101', parent: 'Jordan', attended: [35, 38, 41, 44, 50] },
    { name: 'Oakley', phone: '+15555550102', attended: [2, 5, 9] },
    { name: 'Casey', phone: null, attended: [40, 45] },
  ]);
  const blake = st.Blake;
  assert.equal(code(await settle(maya.request(ctx(a), brief(st.Oakley.membership)))), 'MAYA_CHECK_IN_NOT_AT_RISK');
  assert.equal(fake.calls, 0, 'nothing is sent for a student who is not at risk');
  const v1 = await draft(a, blake.membership);
  assert.equal(fake.calls, 1);
  const sent = JSON.parse(fake.inputs[0].request);
  assert.deepEqual(Object.keys(sent).sort(), ['brief', 'localToday', 'schoolName', 'student']);
  assert.deepEqual(sent.brief, { channel: 'SMS', note: '' });
  assert.deepEqual(Object.keys(sent.student).sort(), ['factors', 'level', 'membershipState', 'score', 'suggestedNextStep']);
  assert.ok(sent.student.factors.some((f) => f.code === 'LONG_ABSENCE'), JSON.stringify(sent.student));
  assert.equal(/Synthperson|Synthparent|Blake|Jordan|example\.test|mci1-|SYNTH_PLAN_CODE|\+1555|Avery/.test(fake.inputs[0].request), false, 'no name, email, phone, subject or plan code is sent');
  assert.deepEqual([fake.inputs[0].inputBudget, fake.inputs[0].outputBudget, fake.inputs[0].maxCostMicrounits], [6000, 2000, 60000]);
  const r1 = await proposalRow(v1.id);
  assert.deepEqual(await row('SELECT agent_key, task_class FROM hon.ai_invocation_plans WHERE id=$1', [r1.plan_id]), { agent_key: 'maya', task_class: 'ANALYZE' });
  assert.equal((await ledger(v1.id)).length, 1);
  assert.equal(v1.studentName, 'Blake Synthperson'); assert.equal(v1.message, sms().message);
  assert.deepEqual(v1.recipients, [{ recipient: 'STUDENT', name: 'Blake Synthperson', reachable: false }, { recipient: 'BILLING_CONTACT', name: 'Jordan Synthparent', reachable: false }]);
  assert.equal(await allMessages(a), 0, 'a draft alone queues nothing');
  pass('ask: only a student on the at-risk list gets a draft; Maya sees channel, note, school name, date and verified numbers only (no name, email, phone or plan code); one ledger row; the student and billing contact are offered; nothing is queued');

  // 3. Approve with the button: one QUEUED message with the first name filled in, recorded with who, when and how; an exact retry replays.
  assert.equal(code(await settle(maya.approve(ctx(a), v1.id, button(sms().message)))), 'MAYA_CHECK_IN_NO_CONSENT');
  await consent(a, blake.person, 'SMS', 'OPTED_IN');
  assert.equal((await maya.read(readCtx(a), v1.id)).recipients[0].reachable, true);
  const edited = 'Hi [First name], we miss you on the mat! Saturday open mat is a good way back.';
  const ck = ctx(a);
  const ok1 = await maya.approve(ck, v1.id, button(edited));
  assert.equal(ok1.replayed, false); assert.equal(ok1.checkIn.status, 'APPLIED');
  assert.deepEqual([ok1.checkIn.send.recipient, ok1.checkIn.send.channel, ok1.checkIn.send.approvalMethod, ok1.checkIn.send.edited, ok1.checkIn.send.cancelled, ok1.checkIn.send.delivery],
    ['STUDENT', 'SMS', 'BUTTON', true, false, null]);
  const [m1] = await messagesFor(v1.id);
  assert.deepEqual([m1.recipient_person_id, m1.channel, m1.lifecycle, m1.content, m1.queued_by_principal_id, m1.email_subject],
    [blake.person, 'SMS', 'QUEUED', 'Hi Blake, we miss you on the mat! Saturday open mat is a good way back.', a.principal, null]);
  const s1 = await sendRow(v1.id);
  assert.deepEqual([s1.approved_by, s1.approval_method, s1.voice_turn_id, s1.message_id], [a.principal, 'BUTTON', null, m1.id]);
  assert.ok(Math.abs(new Date(s1.approved_at) - Date.now()) < 60_000);
  const again = await maya.approve({ ...ck, requestId: K(), correlationId: K() }, v1.id, button(edited));
  assert.equal(again.replayed, true); assert.equal((await messagesFor(v1.id)).length, 1);
  assert.equal(code(await settle(maya.approve(ctx(a), v1.id, button(edited)))), 'MAYA_CHECK_IN_NOT_OPEN');
  const audit1 = await row("SELECT actor_principal_id, next_state FROM hon.audit_events WHERE entity_id=$1 AND action_code='maya.check_in_draft.send_queued'", [v1.id]);
  assert.equal(audit1.actor_principal_id, a.principal); assert.equal(audit1.next_state.approvalMethod, 'BUTTON');
  assert.equal(JSON.stringify(audit1.next_state).includes('mat'), false, 'the audit never holds the text');
  pass('button: approval re-checks consent, queues exactly one SMS with the first name filled in, records approver, time, method and whether staff edited it; an exact retry replays; a used draft is closed');

  // 4. Approve by voice: an email to the billing contact at a set time, with the voice turn kept.
  const v2 = await draft(a, blake.membership, 'EMAIL');
  await consent(a, blake.parent, 'EMAIL', 'OPTED_IN');
  const later = new Date(Math.ceil((Date.now() + 2 * 3_600_000) / 1000) * 1000).toISOString();
  const turn = K();
  assert.equal(code(await settle(maya.approve(ctx(a), v2.id, { ...button(mail().message), recipient: 'BILLING_CONTACT', subject: mail().subject, approvalMethod: 'VOICE' }))), 'MAYA_CHECK_IN_INVALID');
  const ok2 = await maya.approve(ctx(a), v2.id, { ...button(mail().message), recipient: 'BILLING_CONTACT', subject: 'A hello for [First name]', sendAt: later, approvalMethod: 'VOICE', voiceTurnId: turn });
  assert.deepEqual([ok2.checkIn.send.recipient, ok2.checkIn.send.channel, ok2.checkIn.send.approvalMethod, ok2.checkIn.send.scheduledAt], ['BILLING_CONTACT', 'EMAIL', 'VOICE', later]);
  const [m2] = await messagesFor(v2.id);
  assert.deepEqual([m2.recipient_person_id, m2.channel, m2.email_subject, m2.content.startsWith('Hi Jordan,')], [blake.parent, 'EMAIL', 'A hello for Jordan', true]);
  assert.equal(new Date(m2.scheduled_at).toISOString(), later);
  assert.equal((await sendRow(v2.id)).voice_turn_id, turn);
  pass('voice: a VOICE approval needs its turn id; it queues one email to the billing contact at the chosen time, with the name in body and subject, and keeps the voice turn');

  // 5. Refusals: no address, a link, a time too far out, the billing contact when it is the student, all before anything is queued.
  const casey = st.Casey;
  await consent(a, casey.person, 'SMS', 'OPTED_IN');
  const v3 = await draft(a, casey.membership);
  assert.equal(code(await settle(maya.approve(ctx(a), v3.id, button(sms().message)))), 'MAYA_CHECK_IN_NO_ADDRESS');
  assert.equal(code(await settle(maya.approve(ctx(a), v3.id, button('Book here: www.example.test')))), 'MAYA_CHECK_IN_INVALID');
  assert.equal(code(await settle(maya.approve(ctx(a), v3.id, button(sms().message, { sendAt: new Date(Date.now() + 40 * 86_400_000).toISOString() })))), 'MAYA_CHECK_IN_INVALID');
  assert.equal(code(await settle(maya.approve(ctx(a), v3.id, button(sms().message, { recipient: 'BILLING_CONTACT' })))), 'MAYA_CHECK_IN_INVALID');
  assert.equal((await maya.read(readCtx(a), v3.id)).recipients.length, 1, 'no billing contact is offered when the student pays');
  assert.equal((await messagesFor(v3.id)).length, 0); assert.equal((await proposalRow(v3.id)).status, 'RESULT_RECORDED');
  pass('refused: no phone number, a link, a time over 30 days out, or a billing contact who is the student refuses the approval and queues nothing');

  // 6. Daily cap: at most 3 approved AI-drafted messages per person per 24 hours (shared with Chad's approved drafts).
  for (let n = 0; n < 2; n++) { const v = await draft(a, blake.membership); await maya.approve(ctx(a), v.id, button(sms().message)); }
  const v4 = await draft(a, blake.membership);
  assert.equal(code(await settle(maya.approve(ctx(a), v4.id, button(sms().message)))), 'MAYA_CHECK_IN_DAILY_CAP');
  assert.equal((await messagesFor(v4.id)).length, 0); assert.equal((await proposalRow(v4.id)).status, 'RESULT_RECORDED');
  assert.equal(await allMessages(a), 4, 'three texts to Blake and one email to Jordan');
  pass('cap: the fourth approved draft to one person in 24 hours is refused and nothing is queued');

  // 7. Cancel before the worker claims it; the worker still checks consent at send time.
  const other = await addStaff(a, 'other', ['retention.review.read', 'communication.message.queue', 'ai.invocation.plan'], 'Morgan Synthother');
  assert.equal((await settle(maya.cancel(ctx(other), v2.id))).error?.getStatus(), 404, 'only the requester cancels');
  const c2 = await maya.cancel(ctx(a), v2.id);
  assert.equal(c2.send.cancelled, true);
  assert.equal((await maya.cancel(ctx(a), v2.id)).send.cancelled, true, 'a repeat cancel replays');
  assert.equal((await row('SELECT lifecycle FROM hon.communication_messages WHERE id=$1', [m2.id])).lifecycle, 'CANCELLED');
  assert.equal(code(await settle(maya.cancel(ctx(a), v3.id))), 'MAYA_CHECK_IN_NOT_CANCELLABLE');
  await consent(a, blake.person, 'SMS', 'OPTED_OUT');
  await admin.query("SELECT * FROM hon.claim_communication_deliveries(ARRAY['SMS','EMAIL'],100,60)");
  const d1 = await row('SELECT status::text, failure_code FROM hon.communication_deliveries WHERE message_id=$1', [m1.id]);
  assert.deepEqual([d1.status, d1.failure_code], ['SUPPRESSED', 'CONSENT_MISSING']);
  assert.equal((await row('SELECT count(*)::int n FROM hon.communication_deliveries WHERE message_id=$1', [m2.id])).n, 0, 'a cancelled message is never claimed');
  assert.equal(code(await settle(maya.cancel(ctx(a), v1.id))), 'MAYA_CHECK_IN_NOT_CANCELLABLE', 'once the worker has it, cancel is refused');
  assert.equal((await maya.read(readCtx(a), v1.id)).send.delivery, 'SUPPRESSED');
  pass('cancel and worker: the requester cancels before the worker claims it; the worker still checks consent at send time, so STOP after approval stops the message');

  // 8. A paid answer outside the shape, with a link, or offering money is rejected and can never be approved.
  for (const [answer, channel, problem] of [[mail(), 'SMS', 'The answer was not a check-in text (up to 480 characters, no links).'],
    [sms({ message: 'Visit www.example.test to book' }), 'SMS', 'The answer was not a check-in text (up to 480 characters, no links).'],
    [sms(), 'EMAIL', 'The answer was not a check-in email (up to 2,000 characters with a subject, no links).'],
    [sms({ message: 'Come back and get a free month on us!' }), 'SMS', 'The draft offers a discount or refund. Maya must not promise money.']]) {
    fake.answer = answer;
    const bad = await maya.request(ctx(a), brief(blake.membership, channel));
    assert.equal(bad.status, 'RESULT_REJECTED', JSON.stringify(answer)); assert.ok(bad.problems.includes(problem), JSON.stringify(bad.problems)); assert.equal((await ledger(bad.id)).length, 1);
    assert.equal(code(await settle(maya.approve(ctx(a), bad.id, button(sms().message, { subject: channel === 'EMAIL' ? 'Hello' : '' })))), 'MAYA_CHECK_IN_NOT_OPEN');
  }
  const gone = await draft(a, blake.membership);
  assert.equal((await maya.dismiss(ctx(a), gone.id)).status, 'DISMISSED');
  assert.equal(code(await settle(maya.approve(ctx(a), gone.id, button(sms().message)))), 'MAYA_CHECK_IN_NOT_OPEN');
  pass('rejected: an answer for the wrong channel, with a link, or offering a free month keeps its usage, shows its problems and can never be approved; a dismissed draft is closed');

  // 9. Unknown outcome and HQ usage.
  fake.mode = 'UNKNOWN';
  const lost = await maya.request(ctx(a), brief(blake.membership));
  assert.equal(lost.status, 'UNKNOWN'); assert.equal((await proposalRow(lost.id)).reserved_credits > 0, true);
  const queue = (await row('SELECT hon.read_ai_unknown_invocations_from_hq($1) r', [hq.subject])).r;
  assert.equal(queue.open.find((q) => q.invocationId === lost.id)?.agent, 'TEXT_PROPOSAL');
  fake.mode = 'OK';
  const usage = (await row('SELECT hon.read_ai_school_usage_from_hq($1,$2::timestamptz,$3::timestamptz) r', [hq.subject, new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString()])).r;
  const by = usage.schools.find((x) => x.schoolId === a.school).byClass.AGENT_INFERENCE.byAgent;
  assert.ok(by.RETENTION?.credits > 0, JSON.stringify(by)); assert.equal(by.UNATTRIBUTED, undefined);
  pass('unknown and usage: a lost outcome keeps its hold and appears in the HQ queue; the HQ per-school read attributes Maya to RETENTION');

  // 10. Gates: Maya, message queueing, AI planning, Complete; requester-only reading; isolation.
  const calls = fake.calls;
  const noQueue = await addStaff(a, 'noqueue', ['retention.review.read', 'ai.invocation.plan'], 'Sam Synthnoqueue');
  assert.equal(code(await settle(maya.request(ctx(noQueue), brief(blake.membership)))), 'MAYA_CHECK_IN_FORBIDDEN');
  assert.equal(code(await settle(maya.list(readCtx(noQueue)))), 'MAYA_CHECK_IN_FORBIDDEN', 'drafts and recipients need message queueing');
  const noMaya = await addStaff(a, 'nomaya', ['communication.message.queue', 'ai.invocation.plan'], 'Kim Synthnomaya');
  assert.equal(code(await settle(maya.request(ctx(noMaya), brief(blake.membership)))), 'MAYA_CHECK_IN_FORBIDDEN');
  const noAi = await addStaff(a, 'noai', ['retention.review.read', 'communication.message.queue'], 'Pat Synthnoai');
  assert.equal(code(await settle(maya.request(ctx(noAi), brief(blake.membership)))), 'MAYA_CHECK_IN_FORBIDDEN');
  assert.deepEqual(await maya.list(readCtx(noAi)), [], 'a reader sees only their own drafts');
  assert.equal((await settle(maya.read(readCtx(other), v1.id))).error?.getStatus(), 404);
  assert.equal((await settle(maya.approve(ctx(other), v3.id, button(sms().message)))).error?.getStatus(), 404, 'only the requester approves');
  assert.equal((await settle(maya.dismiss(ctx(other), v3.id))).error?.getStatus(), 404);
  const b = await makeOrg('b');
  await admin.query("UPDATE hon.organization_entitlements SET tier='CORE' WHERE organization_id=$1", [b.id]);
  assert.equal(code(await settle(maya.request(ctx(b), brief(blake.membership)))), 'MAYA_CHECK_IN_FORBIDDEN');
  await admin.query("UPDATE hon.organization_entitlements SET tier='COMPLETE' WHERE organization_id=$1", [b.id]);
  assert.equal(code(await settle(maya.request(ctx(b), brief(blake.membership)))), 'MAYA_CHECK_IN_NOT_AT_RISK', 'another school cannot reach this student');
  for (const bad of [brief(blake.membership, 'PUSH'), { ...brief(blake.membership), note: ' padded' }, { ...brief(blake.membership), extra: 1 }]) {
    assert.equal(code(await settle(maya.request(ctx(b), bad))), 'MAYA_CHECK_IN_INVALID', JSON.stringify(bad));
  }
  assert.equal(code(await settle(maya.request(ctx(b, { source: 'AI_AGENT' }), brief(blake.membership)))), 'HUMAN_COMMAND_REQUIRED');
  assert.equal((await settle(maya.read(readCtx(b), v1.id))).error?.getStatus(), 404);
  assert.equal((await settle(maya.cancel(ctx(b), v1.id))).error?.getStatus(), 404);
  assert.equal(fake.calls, calls); assert.equal(networkCalls, 0);
  pass('gates: missing Maya, message queueing, AI planning or Complete is refused before any row; drafts are the requester\'s own to read, approve, cancel or dismiss; bad briefs and non-human sources are refused; schools are isolated');

  // 11. Evidence rows cannot be changed, except one cancel.
  await assert.rejects(admin.query('UPDATE hon.maya_check_in_targets SET facts=facts WHERE proposal_id=$1', [v1.id]), /MAYA_CHECK_IN_ROWS_IMMUTABLE/);
  await assert.rejects(admin.query('UPDATE hon.maya_check_in_sends SET edited=NOT edited WHERE proposal_id=$1', [v1.id]), /MAYA_CHECK_IN_ROWS_IMMUTABLE/);
  await assert.rejects(admin.query('UPDATE hon.maya_check_in_sends SET cancelled_at=NULL WHERE proposal_id=$1', [v2.id]), /MAYA_CHECK_IN_ROWS_IMMUTABLE/);
  await assert.rejects(admin.query('DELETE FROM hon.maya_check_in_sends WHERE proposal_id=$1', [v1.id]), /MAYA_CHECK_IN_ROWS_IMMUTABLE/);
  assert.equal((await rows("SELECT 1 FROM hon.audit_events WHERE entity_id=$1 AND action_code='maya.check_in_draft.send_cancelled'", [v2.id])).length, 1);
  pass('evidence: targets never change; a send row changes only by one cancel, which is audited');

  { const verify = await (await import('node:fs/promises')).readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
    const section = verify.split('-- Maya check-in draft send exact verification (0649)')[1]?.split('-- End Maya check-in draft send exact verification.')[0];
    assert.ok(section, '0649 verify section present');
    await admin.query(section.slice(section.indexOf('\nDO $$')).replaceAll('hon_runtime', runtimeRole));
    await admin.query(verify.replaceAll('hon_runtime', runtimeRole)); }
  pass('011: the 0649 exact verification and the whole canonical 011 pass');
  console.log(`MCI1 Maya check-in draft send: ${groups} groups passed, ${fake.calls} fake provider calls, 0 network calls`);
} finally {
  await admin.end().catch(() => {});
  await db.onModuleDestroy?.().catch?.(() => {});
}
