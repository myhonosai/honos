/**
 * CE2 (0667): the Conversation AI "Try it" test chat, one CONVERSATION_TEST kind on the shared AI text proposal table
 * (0550), through the real API services, the restricted runtime role and the S4 spend controls on a fresh disposable AI-0
 * fixture. The provider is a counted in-process fake: nothing leaves the machine, and fetch is refused. Synthetic names only.
 */
import assert from 'node:assert/strict';
import { randomUUID as K } from 'node:crypto';
import pg from 'pg';
import { AI0_DATABASE as database, AI0_OWNER_ROLE as ownerRole, AI0_RUNTIME_ROLE as runtimeRole, assertDisposableTarget, assertNoLibpqOverrides } from './ai-spend-baseline-target.mjs';

assertNoLibpqOverrides(process.env);
const ownerUrl = assertDisposableTarget(process.env.DATABASE_URL, ownerRole);
process.env.HON_RUNTIME_DATABASE_URL = assertDisposableTarget(process.env.HON_RUNTIME_DATABASE_URL, runtimeRole);
const forbidden = Object.keys(process.env).filter((k) => /^(?:OPENAI|ANTHROPIC|OPENROUTER|STRIPE|TWILIO|SUPABASE|AWS|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(k));
if (forbidden.length) throw new Error(`Refusing provider or execution variables (${forbidden.join(', ')}).`);
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls += 1; throw new Error('EXTERNAL_NETWORK_FORBIDDEN'); };

const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { AiInvocationPlanService } = await import('../../../apps/api/dist/ai/ai-invocation-plan.service.js');
const { ConversationAiService } = await import('../../../apps/api/dist/conversations/conversation-ai.service.js');
const { ConversationAiTestService } = await import('../../../apps/api/dist/conversations/conversation-ai-test.service.js');
const { ConversationTestProviderRuntimeError } = await import('../../../apps/api/dist/ai/conversation-test-provider-runtime.js');

const admin = new pg.Client({ connectionString: ownerUrl, ssl: false });
const row = async (sql, args = []) => (await admin.query(sql, args)).rows[0];
const rows = async (sql, args = []) => (await admin.query(sql, args)).rows;
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
let groups = 0; const pass = (name) => console.log(`PASS CE2 ${++groups} ${name}`);

const fake = { calls: 0, inputs: [], mode: 'OK', answer: null, ready: 'READY' };
const provider = {
  readiness: () => fake.ready,
  generate: async (input) => {
    fake.calls += 1; fake.inputs.push(input);
    if (fake.mode === 'UNKNOWN') throw new ConversationTestProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    if (fake.mode === 'FAILED') throw new ConversationTestProviderRuntimeError('FAILED', 'PROVIDER_REJECTED');
    return { answer: fake.answer, inputTokens: 900, outputTokens: 60, providerCostMicrounits: 400 };
  },
};
const db = new RuntimeDatabaseService(), plans = new AiInvocationPlanService(db);
const training = new ConversationAiService(db), chat = new ConversationAiTestService(db, plans, provider);
const catalog = K(), hq = { id: K(), user: K(), subject: `ce2-hq-owner-${K()}` };
const ctx = (o, patch = {}) => ({ organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: K(), correlationId: K(), idempotencyKey: K(), ...patch });
const readCtx = (o) => ctx(o, { idempotencyKey: '' });
const good = { reply: 'Your first class is free. Want to book one this week?', needsStaff: false };

async function makeOrg(label) {
  const o = { label, id: K(), school: K(), user: K(), principal: K(), role: K(), subject: `ce2-${label}-${K()}`, policy: K() };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'CE2 synthetic organization','CE2 synthetic organization')", [o.id]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'CE2 Synthetic Dojo',$1::uuid::text,'UTC')", [o.school, o.id]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day')", [o.id]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','CE2 synthetic owner')", [o.user, o.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'CE2 synthetic owner')", [o.principal, o.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','CE2 synthetic owner',true)", [o.role, o.id]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions', [o.role, o.id]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')", [o.id, o.school, o.principal, o.role]);
  await admin.query("INSERT INTO hon.hq_ai_routing_policies(policy_id,organization_id,school_id,capability,active,minimum_tier,max_cost_micros,effective_from) VALUES($1,$2,$3,'TEXT',true,'COMPLETE',150000,'2020-01-01')", [o.policy, o.id, o.school]);
  await admin.query('INSERT INTO hon.hq_ai_routing_candidates(policy_id,ordinal,catalog_id) VALUES($1,0,$2)', [o.policy, catalog]);
  await admin.query('COMMIT');
  return o;
}
async function addStaff(o, label, permissions) {
  const s = { ...o, user: K(), principal: K(), role: K(), subject: `ce2-${label}-${K()}` };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','CE2 synthetic staff')", [s.user, s.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'CE2 synthetic staff')", [s.principal, s.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,'CE2 synthetic staff',false)", [s.role, o.id, 'CE2_' + label.toUpperCase()]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,unnest($3::text[])', [s.role, o.id, permissions]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day')", [o.id, o.school, s.principal, s.role, o.principal]);
  await admin.query('COMMIT');
  return s;
}
const ledger = (id) => rows('SELECT customer_credits::int c, provider_cost_microunits::bigint cost, spend_class, school_id FROM hon.ai_usage_ledger WHERE source_invocation_id=$1', [id]);
const proposalRow = (id) => row('SELECT * FROM hon.ai_text_proposals WHERE id=$1', [id]);
const counts = async (o) => row(`SELECT (SELECT count(*)::int FROM hon.ai_text_proposals WHERE organization_id=$1) p,
  (SELECT count(*)::int FROM hon.outbox_events WHERE organization_id=$1 AND event_type NOT LIKE 'ai.%' AND event_type NOT LIKE 'conversation.ai.%') other_events`, [o.id]);

try {
  await admin.connect();
  assert.equal((await row("SELECT current_database() d FROM pg_database WHERE datname=current_database()")).d, database);

  // 1. Custody: the kind is fixed, the runtime executes exactly six CE2 entry points, nothing to PUBLIC.
  const entry = ['begin_conversation_ai_test', 'conversation_ai_test_planning_reference', 'prepare_conversation_ai_test', 'fail_conversation_ai_test', 'record_conversation_ai_test', 'read_conversation_ai_test'];
  const fns = await rows("SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%conversation_ai_test%'");
  assert.equal(fns.length, 12, fns.map((f) => f.proname).join(','));
  for (const f of fns) {
    assert.equal((await row("SELECT has_function_privilege($1,$2::oid,'EXECUTE') ok", [runtimeRole, f.oid])).ok, entry.includes(f.proname), f.proname);
    assert.equal((await row("SELECT coalesce(bool_or(a.grantee=0),false) pub FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1", [f.oid])).pub, false, f.proname);
  }
  const kind = await row("SELECT * FROM hon.ai_text_kinds WHERE kind='CONVERSATION_TEST'");
  assert.deepEqual([kind.agent_key, kind.task_class, kind.input_budget, kind.output_budget, Number(kind.max_cost_microunits), kind.max_result_bytes, kind.caller, kind.usage_agent],
    ['chad', 'DRAFT_FOLLOW_UP', 12000, 600, 20000, 4096, 'HUMAN_UI', 'CONVERSATION_TEST']);
  await assert.rejects(admin.query("UPDATE hon.ai_text_kinds SET output_budget=4000 WHERE kind='CONVERSATION_TEST'"));
  for (const p of ['SELECT', 'INSERT', 'UPDATE']) assert.equal((await row('SELECT has_table_privilege($1,$2,$3) ok', [runtimeRole, 'hon.ai_text_proposals', p])).ok, false);
  pass('custody: CONVERSATION_TEST kind fixed (chad, DRAFT_FOLLOW_UP, 12,000/600, 20,000 micro), runtime executes exactly six entry points, nothing to PUBLIC, no table privilege');

  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state,credential_secret_ref) VALUES('OPENROUTER','CE2 synthetic route','HEALTHY',$1) ON CONFLICT (provider_id) DO NOTHING", [`hon-secret:${K()}`]);
  await admin.query("INSERT INTO hon.hq_ai_model_catalog(catalog_id,provider_id,model_id,display_name,capabilities,modalities,active,minimum_tier,unit_cost_micros,cost_unit,effective_from) VALUES($1,'OPENROUTER','approved/ce2-synthetic','CE2 synthetic model',ARRAY['TEXT'],ARRAY['TEXT'],true,'COMPLETE',1,'TOKEN','2020-01-01')", [catalog]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','CE2 synthetic HQ owner')", [hq.user, hq.subject]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','CE2 synthetic HQ owner',true)", [hq.id, hq.user]);
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER','{}',clock_timestamp()-interval '2 days')", [hq.id]);
  await admin.query('COMMIT');

  // 2. A test question: one plan, one call with the question and the school's own facts, one ledger row, answer shown, nothing sent.
  const a = await makeOrg('a');
  await training.saveItem(ctx(a), { kind: 'FAQ', title: 'Free trial', question: 'Do you offer a free trial?', body: 'Yes, the first class is free for new students.' });
  await training.saveItem(ctx(a), { kind: 'INSTRUCTION', title: 'Tone', body: 'Always invite the family to book a trial class.' });
  const state0 = await chat.state(readCtx(a));
  assert.deepEqual([state0.mode, state0.reason, state0.tests.length], ['AI', null, 0]);
  const before = await counts(a);
  fake.answer = good;
  const c1 = ctx(a);
  const v1 = await chat.ask(c1, { question: 'How much is a trial class?' });
  assert.deepEqual([v1.status, v1.reply, v1.needsStaff, v1.question], ['ANSWERED', good.reply, false, 'How much is a trial class?'], JSON.stringify(v1));
  assert.equal(fake.calls, 1);
  const sent = JSON.parse(fake.inputs[0].request);
  assert.deepEqual(Object.keys(sent).sort(), ['question', 'school']); assert.equal(sent.question, 'How much is a trial class?');
  assert.equal(sent.school.school, 'CE2 Synthetic Dojo');
  assert.deepEqual(sent.school.answers, [{ q: 'Do you offer a free trial?', a: 'Yes, the first class is free for new students.' }]);
  assert.deepEqual(sent.school.rules, ['Always invite the family to book a trial class.']);
  assert.deepEqual(Object.keys(sent.school).sort(), ['answers', 'articles', 'bookingTypes', 'documents', 'handoffWords', 'languages', 'plans', 'replyMaxChars', 'rules', 'school', 'tone']);
  assert.deepEqual([fake.inputs[0].inputBudget, fake.inputs[0].outputBudget, fake.inputs[0].maxCostMicrounits, fake.inputs[0].modelId], [12000, 600, 20000, 'approved/ce2-synthetic']);
  const r1 = await proposalRow(v1.id);
  assert.deepEqual([r1.status, r1.reserved_credits, r1.kind, r1.school_id, r1.requested_by], ['APPLIED', 0, 'CONVERSATION_TEST', a.school, a.principal]);
  const plan = await row('SELECT agent_key, task_class, input_budget, output_budget FROM hon.ai_invocation_plans WHERE id=$1', [r1.plan_id]);
  assert.deepEqual(plan, { agent_key: 'chad', task_class: 'DRAFT_FOLLOW_UP', input_budget: 12000, output_budget: 600 });
  assert.deepEqual(await ledger(v1.id), [{ c: 1, cost: '400', spend_class: 'AGENT_INFERENCE', school_id: a.school }]);
  assert.equal((await row('SELECT status FROM hon.work_items WHERE id=$1', [r1.work_item_id])).status, 'COMPLETED');
  const after = await counts(a);
  assert.equal(after.other_events, before.other_events, 'no message, conversation or contact event');
  assert.equal((await row('SELECT count(*)::int n FROM hon.conversation_messages WHERE organization_id=$1', [a.id]).catch(() => ({ n: 0 }))).n, 0);
  // Replays: the same key returns the same answer with no second call; a changed question on the same key is refused.
  const replay = await chat.ask({ ...c1, requestId: K(), correlationId: K() }, { question: 'How much is a trial class?' });
  assert.equal(replay.id, v1.id); assert.equal(replay.reply, good.reply); assert.equal(fake.calls, 1);
  assert.equal((await settle(chat.ask({ ...c1, requestId: K(), correlationId: K() }, { question: 'Something else' }))).error?.getResponse().code, 'IDEMPOTENCY_KEY_REUSED');
  const st = await chat.state(readCtx(a));
  assert.deepEqual(st.tests.map((t) => t.id), [v1.id]);
  pass('ask: one plan (chad, DRAFT_FOLLOW_UP), one call with the question and the school\'s closed facts only, one ledger row, answer shown and closed, no message or contact touched, key replay safe');

  // 3. A paid answer outside the closed shape is NOT_ANSWERED with its usage kept, never shown.
  fake.answer = { reply: 'Booked you in!', needsStaff: false, sendNow: true };
  const bad = await chat.ask(ctx(a), { question: 'Book me for Tuesday' });
  assert.deepEqual([bad.status, bad.reply, bad.needsStaff], ['NOT_ANSWERED', null, null]);
  assert.equal((await proposalRow(bad.id)).status, 'RESULT_REJECTED'); assert.equal((await ledger(bad.id)).length, 1);
  fake.answer = { reply: 'A team member will call you about the refund.', needsStaff: true };
  const hand = await chat.ask(ctx(a), { question: 'I want a refund' });
  assert.deepEqual([hand.status, hand.needsStaff], ['ANSWERED', true]);
  pass('rejected: an answer outside {reply, needsStaff} keeps its usage and is never shown; a hand-off answer shows needsStaff');

  // 4. Unknown outcome: the hold stays and the HQ owner sees it; a provider refusal releases its hold.
  fake.mode = 'UNKNOWN';
  const lost = await chat.ask(ctx(a), { question: 'What should my child wear?' });
  assert.deepEqual([lost.status, lost.reason], ['UNKNOWN', 'OUTCOME_UNKNOWN']);
  const lostRow = await proposalRow(lost.id);
  assert.equal(lostRow.reserved_credits, 13); assert(lostRow.held_at); assert.equal((await ledger(lost.id)).length, 0);
  const queue = (await row('SELECT hon.read_ai_unknown_invocations_from_hq($1) r', [hq.subject])).r;
  const item = queue.open.find((q) => q.invocationId === lost.id);
  assert.deepEqual([item?.agent, item?.reservedCredits, item?.schoolId], ['TEXT_PROPOSAL', 13, a.school]);
  fake.mode = 'FAILED';
  const refused = await chat.ask(ctx(a), { question: 'Do you have parking?' });
  assert.deepEqual([refused.status, refused.reason], ['FAILED', 'NOT_ANSWERED']); assert.equal((await proposalRow(refused.id)).reserved_credits, 0);
  fake.mode = 'OK'; fake.answer = good;
  pass('unknown: a lost outcome keeps its 13-credit hold and appears in the HQ queue; a provider refusal releases its hold');

  // 5. HQ usage: tests count under their own agent label.
  const usage = (await row('SELECT hon.read_ai_school_usage_from_hq($1,$2::timestamptz,$3::timestamptz) r', [hq.subject, new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString()])).r;
  const by = usage.schools.find((s) => s.schoolId === a.school).byClass.AGENT_INFERENCE.byAgent;
  assert.equal(by.CONVERSATION_TEST.credits, 3, JSON.stringify(by)); assert.equal(by.CHAD_FOLLOW_UP, undefined);
  pass('usage: the HQ per-school read attributes test answers to CONVERSATION_TEST');

  // 6. Not configured: no approved provider key means no call and the page says so.
  fake.ready = 'CONFIGURATION_REQUIRED';
  assert.deepEqual([(await chat.state(readCtx(a))).mode, (await chat.state(readCtx(a))).reason], ['UNAVAILABLE', 'NOT_CONFIGURED']);
  const calls0 = fake.calls;
  const nc = await chat.ask(ctx(a), { question: 'Are you open on Sunday?' });
  assert.deepEqual([nc.status, nc.reason], ['CONFIGURATION_REQUIRED', 'NOT_CONFIGURED']); assert.equal(fake.calls, calls0); assert.equal((await proposalRow(nc.id)).reserved_credits, 0);
  fake.ready = 'READY';
  pass('configuration: without the approved provider setting the page reads NOT_CONFIGURED, a question is stored without a call or a hold');

  // 7. Gates: Complete plan, Chad's capability, the configure permission, an AI spend pause, the burst guard.
  const calls = fake.calls;
  const b = await makeOrg('b');
  await admin.query("UPDATE hon.organization_entitlements SET tier='CORE' WHERE organization_id=$1", [b.id]);
  assert.equal((await settle(chat.ask(ctx(b), { question: 'Hello' }))).error?.getResponse().code, 'CONVERSATION_AI_TEST_UNAVAILABLE');
  assert.deepEqual([(await chat.state(readCtx(b))).mode, (await chat.state(readCtx(b))).reason], ['UNAVAILABLE', 'NOT_INCLUDED']);
  await admin.query("UPDATE hon.organization_entitlements SET tier='COMPLETE' WHERE organization_id=$1", [b.id]);
  const configureOnly = await addStaff(b, 'configure', ['conversation.read', 'conversation.ai.configure']);
  assert.equal((await settle(chat.ask(ctx(configureOnly), { question: 'Hello' }))).error?.getResponse().code, 'CONVERSATION_AI_TEST_UNAVAILABLE');
  const reader = await addStaff(b, 'reader', ['conversation.read', 'ai.invocation.plan', 'crm.assistant.follow_up_draft']);
  assert.equal((await settle(chat.ask(ctx(reader), { question: 'Hello' }))).error?.getStatus(), 403);
  assert.equal((await settle(chat.state(readCtx(reader)))).error?.getStatus(), 403);
  assert.equal((await row('SELECT count(*)::int n FROM hon.ai_text_proposals WHERE organization_id=$1', [b.id])).n, 0);
  const pause = await settle(admin.query('SELECT hon.command_ai_spend_pause($1,$2::jsonb,$3::uuid) r', [hq.subject, JSON.stringify({ action: 'PAUSE', organizationId: b.id, spendClass: 'AGENT_INFERENCE', reason: 'CE2 synthetic pause for this proof' }), K()]));
  assert.equal(pause.value?.rows[0].r.status, 'ACTIVE', pause.error?.message);
  assert.equal((await chat.state(readCtx(b))).reason, 'PAUSED');
  const paused = await settle(chat.ask(ctx(b), { question: 'Hello' }));
  assert.deepEqual([paused.error?.getResponse().code, paused.error?.getResponse().reason], ['CONVERSATION_AI_TEST_SPEND_STOPPED', 'AI_PAUSED_BY_HQ']);
  assert.equal(fake.calls, calls);
  assert.equal((await row('SELECT count(*)::int n FROM hon.ai_text_proposals WHERE organization_id=$1', [b.id])).n, 0, 'a pause refuses the start itself');
  // Burst guard: 30 per staff member per 10 minutes (counted with the questions school A already asked).
  const c = await makeOrg('c');
  for (let i = 0; i < 30; i += 1) await chat.ask(ctx(c), { question: `Question ${i}` });
  assert.equal((await settle(chat.ask(ctx(c), { question: 'One more' }))).error?.getResponse().code, 'CONVERSATION_AI_TEST_BUSY');
  pass('gates: a Core plan, a configure-only staff member without Chad, or a read-only staff member is refused before any row; an HQ pause refuses the start; 30 tests per 10 minutes');

  // 8. Isolation: another school or another person never sees a test.
  assert(!(await chat.state(readCtx(b))).tests.some((t) => t.id === v1.id));
  const coOwner = await addStaff(a, 'coowner', (await rows('SELECT code FROM hon.permissions')).map((p) => p.code));
  assert.equal((await chat.state(readCtx(coOwner))).tests.length, 0, 'tests are private to the asker');
  const tenant = (o, work) => db.withTenantTransaction(ctx(o), async (cl) => { await cl.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [o.subject]); return work(cl); });
  assert.equal((await settle(tenant(coOwner, (cl) => cl.query('SELECT hon.conversation_ai_test_planning_reference($1,$2::uuid)', [coOwner.subject, nc.id])))).error?.code, 'P0002');
  assert.equal((await settle(tenant(b, (cl) => cl.query('SELECT hon.prepare_conversation_ai_test($1,$2::uuid,NULL,true)', [b.subject, nc.id])))).error?.code, 'P0002');
  assert.equal(networkCalls, 0);
  pass('isolation: another school cannot see or move a test; a co-owner at the same school sees none of the asker\'s tests and cannot move them');

  { const verify = await (await import('node:fs/promises')).readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
    const section = verify.split('-- Conversation AI test chat exact verification (0667)')[1]?.split('-- End Conversation AI test chat exact verification.')[0];
    assert.ok(section, '0667 verify section present');
    await admin.query(section.slice(section.indexOf('\n')).replaceAll('hon_runtime', runtimeRole)); }
  pass('011: the 0667 exact verification (bodies, ACLs, kind row) passes');
  console.log(`CE2 Conversation AI test chat: ${groups} groups passed, ${fake.calls} fake provider calls, 0 network calls`);
} finally {
  await admin.end().catch(() => {});
  await db.onModuleDestroy?.().catch?.(() => {});
}
