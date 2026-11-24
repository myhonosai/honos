/**
 * P3 (0641): Marcus marketing review on the shared AI text proposal table, through the real API service, the restricted runtime
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
const { MarcusReviewService } = await import('../../../apps/api/dist/marcus-review/marcus-review.service.js');
const { MerchProviderRuntimeError } = await import('../../../apps/api/dist/commerce/shopify/merch-provider-runtime.js');
const { validateAiSchoolUsageReport } = await import('../../contracts/dist/index.js');

const admin = new pg.Client({ connectionString: ownerUrl, ssl: false });
const row = async (sql, args = []) => (await admin.query(sql, args)).rows[0];
const rows = async (sql, args = []) => (await admin.query(sql, args)).rows;
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
const code = (r) => r.error?.getResponse?.().code;
let groups = 0; const pass = (name) => console.log(`PASS MR1 ${++groups} ${name}`);

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
const db = new RuntimeDatabaseService(), plans = new AiInvocationPlanService(db), marcus = new MarcusReviewService(db, plans, provider);
const catalog = K(), hq = { id: K(), user: K(), subject: `mr1-hq-owner-${K()}` };
const ctx = (o, patch = {}) => ({ organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: K(), correlationId: K(), idempotencyKey: K(), ...patch });
const readCtx = (o) => ctx(o, { idempotencyKey: '' });
const last30 = { period: 'LAST_30_DAYS', question: '' };
const last90 = { period: 'LAST_90_DAYS', question: 'Which campaign should we keep?' };
const answer = { summary: 'Twelve new leads, mostly from the trial form.', findings: [{ title: 'Trial campaign works', detail: 'Three of five leads came from it.' }],
  nextSteps: [{ title: 'Call open leads', detail: 'Three leads are still open.', area: 'chad' }, { title: 'Keep the trial offer', detail: 'It brings most leads.', area: null }] };

async function makeOrg(label) {
  const o = { label, id: K(), school: K(), user: K(), principal: K(), role: K(), subject: `mr1-${label}-${K()}`, policy: K() };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'MR1 synthetic organization','MR1 synthetic organization')", [o.id]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'Synthetic Dojo',$1::uuid::text,'America/New_York')", [o.school, o.id]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day')", [o.id]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','Avery Synthowner')", [o.user, o.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Avery Synthowner')", [o.principal, o.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','MR1 synthetic owner',true)", [o.role, o.id]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions', [o.role, o.id]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '3 days')", [o.id, o.school, o.principal, o.role]);
  await admin.query("INSERT INTO hon.hq_ai_routing_policies(policy_id,organization_id,school_id,capability,active,minimum_tier,max_cost_micros,effective_from) VALUES($1,$2,$3,'TEXT',true,'COMPLETE',150000,'2020-01-01')", [o.policy, o.id, o.school]);
  await admin.query('INSERT INTO hon.hq_ai_routing_candidates(policy_id,ordinal,catalog_id) VALUES($1,0,$2)', [o.policy, catalog]);
  await admin.query('COMMIT');
  return o;
}
async function addStaff(o, label, permissions, name, since = '2 days') {
  const st = { ...o, user: K(), principal: K(), role: K(), subject: `mr1-${label}-${K()}`, name };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test',$3)", [st.user, st.subject, name]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3)", [st.principal, st.user, name]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,'MR1 synthetic staff',false)", [st.role, o.id, 'MR1_' + label.toUpperCase()]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,unnest($3::text[])', [st.role, o.id, permissions]);
  await admin.query(`INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '${since}')`, [o.id, o.school, st.principal, st.role, o.principal]);
  await admin.query('COMMIT');
  return st;
}
// Synthetic marketing records for one school, written by the migration owner with user triggers paused (disposable fixture only).
const SEEDED = ['people', 'student_profiles', 'crm_leads', 'crm_lead_attributions', 'marketing_campaigns', 'marketing_campaign_versions', 'public_lead_forms', 'public_lead_form_receipts', 'crm_lead_registration_conversions'];
async function seed(o, leads, campaigns = [], forms = []) {
  await admin.query('BEGIN');
  for (const t of SEEDED) await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  const pipeline = K(), stage = K(), ids = {};
  await admin.query("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'Leads')", [pipeline, o.id, o.school]);
  await admin.query("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'New',1)", [stage, o.id, o.school, pipeline]);
  for (const c of campaigns) {
    ids[c.code] = K();
    await admin.query(`INSERT INTO hon.marketing_campaigns(id,organization_id,school_id,version,code,name,goal,offer_label,channel,status,starts_at,ends_at,planned_budget_minor,currency)
      VALUES($1,$2,$3,1,$4,$5,'Synthetic goal','Free class',$6,$7,clock_timestamp()-make_interval(days=>$8),clock_timestamp()+make_interval(days=>$9),$10,'USD')`,
      [ids[c.code], o.id, o.school, c.code, c.name, c.channel, c.status, c.startedDaysAgo, c.endsInDays, c.budgetMinor]);
    await admin.query("INSERT INTO hon.marketing_campaign_versions(campaign_id,organization_id,school_id,version,actor_principal_id,source,request_id,snapshot) VALUES($1,$2,$3,1,$4,'HUMAN_UI',$5,'{\"fixture\":true}')", [ids[c.code], o.id, o.school, o.principal, K()]);
  }
  for (const f of forms) {
    ids[f.title] = K();
    await admin.query("INSERT INTO hon.public_lead_forms(id,organization_id,school_id,status,title,description,optional_fields,pipeline_id,pipeline_stage_id,accepted_count,created_at) VALUES($1,$2,$3,$4,$5,'Synthetic form','[]',$6,$7,$8,clock_timestamp()-make_interval(days=>$9))",
      [ids[f.title], o.id, o.school, f.status, f.title, pipeline, stage, f.accepted, f.ageDays]);
  }
  for (const l of leads) {
    const person = K(), lead = K();
    await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email) VALUES($1,$2,$3,'Taylor','Synthlead',$1::uuid::text||'@example.test')", [person, o.id, o.school]);
    await admin.query("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status,source_code,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::hon.lead_status,$8,clock_timestamp()-make_interval(days=>$9))",
      [lead, o.id, o.school, person, pipeline, stage, l.status, l.leadSource ?? null, l.ageDays]);
    if (l.source !== undefined || l.campaign) {
      await admin.query("INSERT INTO hon.crm_lead_attributions(lead_id,organization_id,school_id,campaign_id,campaign_version,campaign_snapshot,source_code,source_facts) VALUES($1,$2,$3,$4,$5,$6,$7,'{}')",
        [lead, o.id, o.school, l.campaign ? ids[l.campaign] : null, l.campaign ? 1 : null, l.campaign ? { fixture: true } : null, l.source ?? null]);
    }
    if (l.form) {
      await admin.query("INSERT INTO hon.public_lead_form_receipts(form_id,organization_id,school_id,lead_id,key_hash,payload_hash,transaction_id,attribution,expires_at) VALUES($1,$2,$3,$4,$5,$5,txid_current(),'{}',clock_timestamp()+interval '1 day')",
        [ids[l.form], o.id, o.school, lead, 'f'.repeat(64)]);
    }
    if (l.registered) {
      const student = K();
      await admin.query("INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)", [student, o.id, o.school, person]);
      await admin.query("INSERT INTO hon.crm_lead_registration_conversions(organization_id,school_id,source_lead_id,original_contact_person_id,registration_path,resulting_student_profile_id,actor_principal_id,idempotency_key,fingerprint,response) VALUES($1,$2,$3,$4,'ADULT',$5,$6,$7,$8,'{}')",
        [o.id, o.school, lead, person, student, o.principal, K(), 'a'.repeat(64)]);
    }
  }
  await admin.query('SET CONSTRAINTS ALL IMMEDIATE');
  for (const t of SEEDED) await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  await admin.query('COMMIT');
}
const ledger = (id) => rows('SELECT customer_credits::int c, spend_class, school_id FROM hon.ai_usage_ledger WHERE source_invocation_id=$1', [id]);
const proposalRow = (id) => row('SELECT * FROM hon.ai_text_proposals WHERE id=$1', [id]);
const counts = () => row(`SELECT (SELECT count(*) FROM hon.crm_leads)::int leads, (SELECT count(*) FROM hon.marketing_campaigns)::int campaigns, (SELECT count(*) FROM hon.work_items)::int work,
  (SELECT count(*) FROM hon.communication_messages)::int messages,
  (SELECT count(*) FROM hon.outbox_events WHERE event_type !~ '^(ai|work)[._]')::int outbox`);

try {
  await admin.connect();
  assert.equal((await row('SELECT current_database() d')).d, database);

  // 1. Custody.
  const entry = ['begin_marcus_review', 'plan_marcus_review', 'prepare_marcus_review', 'fail_marcus_review', 'record_marcus_review', 'read_marcus_reviews', 'close_marcus_review'];
  const fns = await rows("SELECT p.oid, p.proname, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%marcus_review%'");
  assert.equal(fns.length, 13, fns.map((f) => f.proname).join(','));
  for (const f of fns) {
    assert.equal((await row("SELECT has_function_privilege($1,$2::oid,'EXECUTE') ok", [runtimeRole, f.oid])).ok, entry.includes(f.proname), f.proname);
    assert.equal((await row("SELECT coalesce(bool_or(a.grantee=0),false) pub FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1", [f.oid])).pub, false, f.proname);
    if (entry.includes(f.proname)) assert.equal(f.prosecdef, true, f.proname);
  }
  const kind = await row("SELECT * FROM hon.ai_text_kinds WHERE kind='MARCUS_MARKETING_REVIEW'");
  assert.deepEqual([kind.agent_key, kind.task_class, kind.input_budget, kind.output_budget, Number(kind.max_cost_microunits), kind.max_result_bytes, kind.caller, kind.subject_type, kind.usage_agent],
    ['marcus', 'DRAFT_MARKETING', 12000, 3000, 80000, 12288, 'HUMAN_UI', 'SCHOOL', 'MARKETING']);
  pass('custody: MARCUS_MARKETING_REVIEW kind fixed (marcus, DRAFT_MARKETING, 12,000/3,000, 80,000 micro-USD, MARKETING usage line), runtime executes exactly seven definer entry points, nothing to PUBLIC');

  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state,credential_secret_ref) VALUES('OPENROUTER','MR1 synthetic route','HEALTHY',$1) ON CONFLICT (provider_id) DO NOTHING", [`hon-secret:${K()}`]);
  await admin.query("INSERT INTO hon.hq_ai_model_catalog(catalog_id,provider_id,model_id,display_name,capabilities,modalities,active,minimum_tier,unit_cost_micros,cost_unit,effective_from) VALUES($1,'OPENROUTER','approved/mr1-synthetic','MR1 synthetic model',ARRAY['TEXT'],ARRAY['TEXT'],true,'COMPLETE',2,'TOKEN','2020-01-01')", [catalog]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','MR1 synthetic HQ owner')", [hq.user, hq.subject]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','MR1 synthetic HQ owner',true)", [hq.id, hq.user]);
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER','{}',clock_timestamp()-interval '2 days')", [hq.id]);
  await admin.query('COMMIT');

  // 2. Ask: aggregate counts only for the window; campaigns that ran in it (never drafts); forms that are not drafts.
  const a = await makeOrg('a'), b = await makeOrg('b');
  await seed(a, [
    { status: 'WON', source: 'FACEBOOK', campaign: 'SPRING-TRIAL', ageDays: 5, registered: true },
    { status: 'OPEN', source: 'FACEBOOK', campaign: 'SPRING-TRIAL', ageDays: 3 },
    { status: 'LOST', source: 'FACEBOOK', campaign: 'SPRING-TRIAL', ageDays: 10 },
    { status: 'OPEN', source: 'WEBSITE', ageDays: 2, form: 'Free trial class' },
    { status: 'OPEN', leadSource: 'WEBSITE', ageDays: 1 },
    { status: 'WON', source: 'WALK_IN', campaign: 'FALL-OPEN', ageDays: 45 },
    { status: 'OPEN', ageDays: 20 },
    { status: 'WON', source: 'FACEBOOK', ageDays: 200 },
  ], [
    { code: 'SPRING-TRIAL', name: 'Spring free trial', channel: 'SOCIAL', status: 'ACTIVE', startedDaysAgo: 20, endsInDays: 10, budgetMinor: 25000 },
    { code: 'FALL-OPEN', name: 'Fall open house', channel: 'EVENT', status: 'ARCHIVED', startedDaysAgo: 50, endsInDays: -40, budgetMinor: 0 },
    { code: 'OLD-FLYER', name: 'Old flyer', channel: 'PRINT', status: 'ARCHIVED', startedDaysAgo: 300, endsInDays: -200, budgetMinor: 5000 },
    { code: 'IDEA', name: 'Draft idea', channel: 'EMAIL', status: 'DRAFT', startedDaysAgo: 1, endsInDays: 30, budgetMinor: 1000 },
  ], [
    { title: 'Free trial class', status: 'PUBLISHED', accepted: 9, ageDays: 60 },
    { title: 'Summer form', status: 'DISABLED', accepted: 4, ageDays: 120 },
    { title: 'Unfinished form', status: 'DRAFT', accepted: 0, ageDays: 1 },
  ]);
  await seed(b, [{ status: 'OPEN', source: 'B-ONLY', ageDays: 1 }]);
  const before = await counts();
  fake.answer = answer;
  const v1 = await marcus.request(ctx(a), last30);
  assert.equal(v1.status, 'RESULT_RECORDED', JSON.stringify(v1)); assert.deepEqual([v1.summary, v1.findings, v1.nextSteps], [answer.summary, answer.findings, answer.nextSteps]);
  assert.equal(fake.calls, 1);
  const sent = JSON.parse(fake.inputs[0].request);
  assert.deepEqual(Object.keys(sent).sort(), ['brief', 'bySource', 'campaigns', 'forms', 'leads', 'localToday', 'schoolName', 'windowDays']);
  assert.deepEqual([sent.brief, sent.windowDays, sent.schoolName], [last30, 30, 'Synthetic Dojo']);
  assert.deepEqual(sent.leads, { total: 6, open: 4, won: 1, lost: 1, registered: 1 });
  assert.deepEqual(sent.bySource, [{ source: 'FACEBOOK', leads: 3, won: 1, registered: 1 }, { source: 'WEBSITE', leads: 2, won: 0, registered: 0 }, { source: 'UNKNOWN', leads: 1, won: 0, registered: 0 }]);
  assert.deepEqual(sent.campaigns, [{ code: 'SPRING-TRIAL', name: 'Spring free trial', channel: 'SOCIAL', status: 'ACTIVE', startedDaysAgo: 20, endsInDays: 10, plannedBudget: 250, currency: 'USD', leads: 3, won: 1, registered: 1 }]);
  assert.deepEqual(sent.forms, [{ name: 'Summer form', status: 'DISABLED', leads: 0, allTimeLeads: 4 }, { name: 'Free trial class', status: 'PUBLISHED', leads: 1, allTimeLeads: 9 }]);
  assert.equal(/Taylor|Synthlead|Synthowner|example\.test|\+1555|mr1-|B-ONLY|Draft idea|Unfinished form/.test(fake.inputs[0].request), false, 'no person, contact, subject, draft or other school is sent');
  assert.equal(Buffer.byteLength(fake.inputs[0].request) < 12000 - 128 - 2600, true);
  assert.deepEqual([fake.inputs[0].inputBudget, fake.inputs[0].outputBudget, fake.inputs[0].maxCostMicrounits], [12000, 3000, 80000]);
  const r1 = await proposalRow(v1.id);
  assert.deepEqual(await row('SELECT agent_key, task_class FROM hon.ai_invocation_plans WHERE id=$1', [r1.plan_id]), { agent_key: 'marcus', task_class: 'DRAFT_MARKETING' });
  const l1 = await ledger(v1.id); assert.equal(l1.length, 1); assert.deepEqual([l1[0].spend_class, l1[0].school_id], ['AGENT_INFERENCE', a.school]); assert.ok(l1[0].c > 0);
  // The 90-day window adds the archived campaign that ran in it and its lead; the 200-day-old lead stays out.
  const v90 = await marcus.request(ctx(a), last90);
  const sent90 = JSON.parse(fake.inputs[1].request);
  assert.equal(v90.status, 'RESULT_RECORDED'); assert.equal(sent90.windowDays, 90); assert.equal(sent90.brief.question, 'Which campaign should we keep?');
  assert.deepEqual(sent90.leads, { total: 7, open: 4, won: 2, lost: 1, registered: 1 });
  assert.deepEqual(sent90.bySource.map((x) => [x.source, x.leads]), [['FACEBOOK', 3], ['WEBSITE', 2], ['UNKNOWN', 1], ['WALK_IN', 1]]);
  assert.deepEqual(sent90.campaigns.map((c) => [c.code, c.leads, c.won]), [['SPRING-TRIAL', 3, 1], ['FALL-OPEN', 1, 1]]);
  const after = await counts(); assert.deepEqual({ ...after, work: before.work }, before, 'a review creates no lead, campaign, message or outbox event');
  pass('ask: aggregate lead, source, campaign and form counts for 30 or 90 days only (archived campaigns only inside the window, never drafts), no person, contact or other school; marcus DRAFT_MARKETING plan, one ledger row; nothing created or sent');

  // 3. A paid answer outside the shape or with a link is rejected; usage is kept; dismiss hides it.
  for (const bad of [{ summary: 'x', findings: [], nextSteps: answer.nextSteps }, { ...answer, nextSteps: [{ ...answer.nextSteps[0], area: 'maya' }] }, { ...answer, extra: 1 }]) {
    fake.answer = bad;
    const v = await marcus.request(ctx(a), last30);
    assert.equal(v.status, 'RESULT_REJECTED', JSON.stringify(bad)); assert.deepEqual(v.problems, ['The answer was not a marketing review.']); assert.equal(v.findings, null); assert.equal((await ledger(v.id)).length, 1);
  }
  fake.answer = { ...answer, findings: [{ title: 'See this', detail: 'Read https://example.test/report first.' }] };
  const linked = await marcus.request(ctx(a), last30);
  assert.deepEqual([linked.status, linked.problems], ['RESULT_REJECTED', ['The answer holds a link or an email address.']]);
  const gone = await marcus.dismiss(ctx(a), v1.id);
  assert.deepEqual([gone.status, gone.summary], ['DISMISSED', null]);
  assert.equal((await marcus.dismiss(ctx(a), v1.id)).status, 'DISMISSED', 'dismissing again is a no-op');
  pass('rejected: an answer outside the shape or with a link keeps its usage and shows its problems; a dismissed review hides its text, and dismissing again changes nothing');

  // 4. Unknown outcome and HQ usage.
  fake.mode = 'UNKNOWN'; fake.answer = answer;
  const lost = await marcus.request(ctx(a), last30);
  assert.equal(lost.status, 'UNKNOWN'); assert.equal((await proposalRow(lost.id)).reserved_credits > 0, true);
  const queue = (await row('SELECT hon.read_ai_unknown_invocations_from_hq($1) r', [hq.subject])).r;
  assert.equal(queue.open.find((q) => q.invocationId === lost.id)?.agent, 'TEXT_PROPOSAL');
  fake.mode = 'OK';
  const usage = (await row('SELECT hon.read_ai_school_usage_from_hq($1,$2::timestamptz,$3::timestamptz) r', [hq.subject, new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString()])).r;
  const by = usage.schools.find((x) => x.schoolId === a.school).byClass.AGENT_INFERENCE.byAgent;
  assert.ok(by.MARKETING?.credits > 0, JSON.stringify(by)); assert.equal(by.UNATTRIBUTED, undefined);
  validateAiSchoolUsageReport(usage); // the HQ per-school report must stay readable once a Marcus review exists
  pass('unknown and usage: a lost outcome keeps its hold and appears in the HQ queue; the HQ per-school read attributes Marcus reviews to MARKETING and the contracts verifier accepts the report');

  // 5. Gates: Marcus's capability, campaign reading, AI planning, Complete; readers see only their own reviews; isolation.
  const calls = fake.calls;
  const reader = await addStaff(a, 'reader', ['marketing.campaign.read', 'ai.invocation.plan'], 'Sam Synthviewer');
  assert.equal(code(await settle(marcus.request(ctx(reader), last30))), 'MARCUS_REVIEW_FORBIDDEN');
  assert.deepEqual(await marcus.list(readCtx(reader)), [], 'a reader sees only their own reviews');
  assert.equal((await settle(marcus.read(readCtx(reader), v90.id))).error?.getStatus(), 404);
  assert.equal((await settle(marcus.dismiss(ctx(reader), v90.id))).error?.getStatus(), 404);
  const blind = await addStaff(a, 'blind', ['marketing.assistant.use', 'ai.invocation.plan'], 'Pat Synthblind');
  assert.equal(code(await settle(marcus.request(ctx(blind), last30))), 'MARCUS_REVIEW_FORBIDDEN');
  assert.equal(code(await settle(marcus.list(readCtx(blind)))), 'MARCUS_REVIEW_FORBIDDEN');
  const noAi = await addStaff(a, 'noai', ['marketing.assistant.use', 'marketing.campaign.read'], 'Lee Synthnoai');
  assert.equal(code(await settle(marcus.request(ctx(noAi), last30))), 'MARCUS_REVIEW_FORBIDDEN');
  assert.ok((await marcus.list(readCtx(a))).length >= 6, 'the requester reads their own reviews');
  await admin.query("UPDATE hon.organization_entitlements SET tier='CORE' WHERE organization_id=$1", [b.id]);
  assert.equal(code(await settle(marcus.request(ctx(b), last30))), 'MARCUS_REVIEW_FORBIDDEN');
  await admin.query("UPDATE hon.organization_entitlements SET tier='COMPLETE' WHERE organization_id=$1", [b.id]);
  for (const badBrief of [{ period: 'LAST_YEAR', question: '' }, { period: 'LAST_30_DAYS' }, { ...last90, question: ' padded' }, { ...last90, question: 'api_key: abc' }, { ...last30, extra: 1 }]) {
    assert.equal(code(await settle(marcus.request(ctx(b), badBrief))), 'MARCUS_REVIEW_INVALID', JSON.stringify(badBrief));
  }
  assert.equal(code(await settle(marcus.request(ctx(b, { source: 'AI_AGENT' }), last30))), 'HUMAN_COMMAND_REQUIRED');
  assert.equal(fake.calls, calls);
  assert.equal((await settle(marcus.read(readCtx(b), v90.id))).error?.getStatus(), 404);
  fake.answer = answer;
  await marcus.request(ctx(b), last30);
  assert.deepEqual(JSON.parse(fake.inputs.at(-1).request).leads, { total: 1, open: 1, won: 0, lost: 0, registered: 0 });
  assert.equal(networkCalls, 0);
  pass('gates: no Marcus, no campaign reading, no AI planning or Core is refused before any call; readers see only their own reviews; bad briefs and non-human sources are refused; schools are isolated');

  { const verify = await (await import('node:fs/promises')).readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
    const section = verify.split('-- Marcus marketing review exact verification (0641)')[1]?.split('-- End Marcus marketing review exact verification.')[0];
    assert.ok(section, '0641 verify section present');
    await admin.query(section.slice(section.indexOf('\nDO $$')).replaceAll('hon_runtime', runtimeRole));
    await admin.query(verify.replaceAll('hon_runtime', runtimeRole)); }
  pass('011: the 0641 exact verification and the whole canonical 011 pass');
  console.log(`MR1 Marcus marketing review: ${groups} groups passed, ${fake.calls} fake provider calls, 0 network calls`);
} finally {
  await admin.end().catch(() => {});
  await db.onModuleDestroy?.().catch?.(() => {});
}
