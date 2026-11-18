/**
 * CS-M2 (0502): Merch Studio AI ideas on the shared AI text proposal table, through the real API service, the restricted
 * runtime role and the S4 spend controls on a fresh disposable AI-0 fixture. The provider is a counted in-process fake:
 * nothing leaves the machine, and fetch is refused. Synthetic names only.
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
const { MerchAiService } = await import('../../../apps/api/dist/commerce/shopify/merch-ai.service.js');
const { MerchProviderRuntimeError } = await import('../../../apps/api/dist/commerce/shopify/merch-provider-runtime.js');

const admin = new pg.Client({ connectionString: ownerUrl, ssl: false });
const row = async (sql, args = []) => (await admin.query(sql, args)).rows[0];
const rows = async (sql, args = []) => (await admin.query(sql, args)).rows;
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
const code = (r) => r.error?.getResponse?.().code;
let groups = 0; const pass = (name) => console.log(`PASS CS-M2 ${++groups} ${name}`);

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
const db = new RuntimeDatabaseService(), plans = new AiInvocationPlanService(db), ai = new MerchAiService(db, plans, provider);
const catalog = K(), hq = { id: K(), user: K(), subject: `csm2-hq-owner-${K()}` };
const ctx = (o, patch = {}) => ({ organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: K(), correlationId: K(), idempotencyKey: K(), ...patch });
const readCtx = (o) => ctx(o, { idempotencyKey: '' });
const brief = { kind: 'HOODIE', styles: ['MINIMAL', 'ATHLETIC'], colors: ['Black', 'Navy'], notes: 'Winter season, kids and adults' };
const idea = (style, price = '50.00') => ({ style, title: `Synthetic Dojo ${style.toLowerCase()} hoodie`, description: 'A warm hoodie for training days.', productType: 'Hoodie', price, printNotes: 'Front chest logo, one color.' });
const goodAnswer = { summary: 'Two winter hoodies.', ideas: [idea('MINIMAL'), idea('ATHLETIC', '55.00')] };

async function makeOrg(label, currency = 'USD') {
  const o = { label, id: K(), school: K(), user: K(), principal: K(), role: K(), subject: `csm2-${label}-${K()}`, policy: K(), connection: K() };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'CS-M2 synthetic organization','CS-M2 synthetic organization')", [o.id]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'Synthetic Dojo',$1::uuid::text,'UTC')", [o.school, o.id]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day')", [o.id]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','CS-M2 synthetic owner')", [o.user, o.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'CS-M2 synthetic owner')", [o.principal, o.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','CS-M2 synthetic owner',true)", [o.role, o.id]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions', [o.role, o.id]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')", [o.id, o.school, o.principal, o.role]);
  await admin.query("INSERT INTO hon.hq_ai_routing_policies(policy_id,organization_id,school_id,capability,active,minimum_tier,max_cost_micros,effective_from) VALUES($1,$2,$3,'TEXT',true,'COMPLETE',150000,'2020-01-01')", [o.policy, o.id, o.school]);
  await admin.query('INSERT INTO hon.hq_ai_routing_candidates(policy_id,ordinal,catalog_id) VALUES($1,0,$2)', [o.policy, catalog]);
  await admin.query("INSERT INTO hon.shopify_connections(id,organization_id,school_id,shop_domain,shop_name,currency,scopes,status,connected_by_principal_id) VALUES($1,$2,$3,$4,'Synthetic Dojo Store',$5,'read_products,read_inventory,read_orders','CONNECTED',$6)",
    [o.connection, o.id, o.school, `csm2-${label}-${o.school.slice(0, 8)}.myshopify.com`, currency, o.principal]);
  // A synthetic sealed value (the shape only; nothing decrypts it): a CONNECTED store must hold a live credential at commit.
  await admin.query("INSERT INTO hon.shopify_credentials(connection_id,organization_id,school_id,key_id,sealed,access_expires_at,refresh_expires_at,stored_by_principal_id) VALUES($1,$2,$3,'csm2-synthetic','v1.AAAAAAAAAAAAAAAA.synthetic.AAAAAAAAAAAAAAAAAAAAAA',clock_timestamp()+interval '1 day',clock_timestamp()+interval '30 days',$4)", [o.connection, o.id, o.school, o.principal]);
  const sync = (await admin.query("INSERT INTO hon.shopify_syncs(connection_id,organization_id,school_id,started_by_principal_id,outcome,finished_at) VALUES($1,$2,$3,$4,'SUCCEEDED',clock_timestamp()) RETURNING id", [o.connection, o.id, o.school, o.principal])).rows[0].id;
  await admin.query("INSERT INTO hon.shopify_products(connection_id,shopify_id,organization_id,school_id,title,status,last_sync_id) VALUES($1,9100000001,$2,$3,'Student uniform','ACTIVE',$4),($1,9100000002,$2,$3,'Black belt display','ACTIVE',$4)", [o.connection, o.id, o.school, sync]);
  await admin.query("INSERT INTO hon.school_page_branding(organization_id,school_id,accent_color,created_by_principal_id,updated_by_principal_id) VALUES($1,$2,'#c81e1e',$3,$3)", [o.id, o.school, o.principal]);
  await admin.query('COMMIT');
  return o;
}
async function addStaff(o, label, permissions) {
  const s = { ...o, user: K(), principal: K(), role: K(), subject: `csm2-${label}-${K()}` };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','CS-M2 synthetic staff')", [s.user, s.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'CS-M2 synthetic staff')", [s.principal, s.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,'CS-M2 synthetic staff',false)", [s.role, o.id, 'CSM2_' + label.toUpperCase()]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,unnest($3::text[])', [s.role, o.id, permissions]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day')", [o.id, o.school, s.principal, s.role, o.principal]);
  await admin.query('COMMIT');
  return s;
}
// Disconnect or reconnect a synthetic store the way 0405 allows: a version step, the credential destroyed on leaving
// CONNECTED and re-sealed (synthetic shape) on return, all in one transaction so the commit-time credential check holds.
async function storeConnected(o, connected) {
  await admin.query('BEGIN');
  if (connected) await admin.query("UPDATE hon.shopify_credentials SET version=version+1,sealed='v1.AAAAAAAAAAAAAAAA.synthetic.AAAAAAAAAAAAAAAAAAAAAA',destroyed_at=NULL WHERE connection_id=$1", [o.connection]);
  await admin.query(connected ? "UPDATE hon.shopify_connections SET version=version+1,status='CONNECTED',ended_at=NULL WHERE id=$1"
    : "UPDATE hon.shopify_connections SET version=version+1,status='DISCONNECTED',ended_at=clock_timestamp() WHERE id=$1", [o.connection]);
  await admin.query('COMMIT');
}
const ledger = (id) => rows('SELECT customer_credits::int c, provider_cost_microunits::bigint cost, spend_class, school_id FROM hon.ai_usage_ledger WHERE source_invocation_id=$1', [id]);
const proposalRow = (id) => row('SELECT * FROM hon.ai_text_proposals WHERE id=$1', [id]);

try {
  await admin.connect();
  assert.equal((await row('SELECT current_database() d')).d, database);

  // 1. Custody: the MERCH_IDEAS kind is fixed; the runtime executes exactly the seven entry points; nothing to PUBLIC.
  const entry = ['begin_shopify_merch_ideas', 'shopify_merch_ideas_planning_reference', 'prepare_shopify_merch_ideas', 'fail_shopify_merch_ideas', 'record_shopify_merch_ideas', 'read_shopify_merch_ideas', 'close_shopify_merch_ideas'];
  const fns = await rows("SELECT p.oid, p.proname, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%shopify_merch%'");
  assert.equal(fns.length, 16, fns.map((f) => f.proname).join(','));
  for (const f of fns) {
    assert.equal((await row("SELECT has_function_privilege($1,$2::oid,'EXECUTE') ok", [runtimeRole, f.oid])).ok, entry.includes(f.proname), f.proname);
    assert.equal((await row("SELECT coalesce(bool_or(a.grantee=0),false) pub FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1", [f.oid])).pub, false, f.proname);
    if (entry.includes(f.proname)) assert.equal(f.prosecdef, true, f.proname);
  }
  const kind = await row("SELECT * FROM hon.ai_text_kinds WHERE kind='MERCH_IDEAS'");
  assert.deepEqual([kind.agent_key, kind.task_class, kind.input_budget, kind.output_budget, Number(kind.max_cost_microunits), kind.max_result_bytes, kind.caller, kind.subject_type, kind.usage_agent],
    ['marcus', 'DRAFT_MARKETING', 6000, 3000, 80000, 12288, 'HUMAN_UI', 'SHOPIFY_STORE', 'MERCH_IDEAS']);
  await assert.rejects(admin.query("UPDATE hon.ai_text_kinds SET output_budget=9000 WHERE kind='MERCH_IDEAS'"));
  pass('custody: MERCH_IDEAS kind fixed (marcus, DRAFT_MARKETING, 6,000/3,000, 80,000 micro-USD), runtime executes exactly seven definer entry points, nothing to PUBLIC');

  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state,credential_secret_ref) VALUES('OPENROUTER','CS-M2 synthetic route','HEALTHY',$1)", [`hon-secret:${K()}`]);
  await admin.query("INSERT INTO hon.hq_ai_model_catalog(catalog_id,provider_id,model_id,display_name,capabilities,modalities,active,minimum_tier,unit_cost_micros,cost_unit,effective_from) VALUES($1,'OPENROUTER','approved/csm2-synthetic','CS-M2 synthetic model',ARRAY['TEXT'],ARRAY['TEXT'],true,'COMPLETE',2,'TOKEN','2020-01-01')", [catalog]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','CS-M2 synthetic HQ owner')", [hq.user, hq.subject]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','CS-M2 synthetic HQ owner',true)", [hq.id, hq.user]);
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER','{}',clock_timestamp()-interval '2 days')", [hq.id]);
  await admin.query('COMMIT');

  // 2. Ask: one plan, one provider call with the brief and store facts only, one ledger row, ideas recorded; Shopify untouched.
  const a = await makeOrg('a');
  fake.answer = goodAnswer;
  const c1 = ctx(a);
  const v1 = await ai.request(c1, brief);
  assert.equal(v1.status, 'RESULT_RECORDED', JSON.stringify(v1)); assert.deepEqual(v1.ideas, goodAnswer.ideas); assert.equal(v1.summary, goodAnswer.summary);
  assert.deepEqual(v1.problems, []); assert.equal(v1.mine, true); assert.deepEqual(v1.brief, brief);
  assert.equal(fake.calls, 1);
  const sent = JSON.parse(fake.inputs[0].request);
  assert.deepEqual(Object.keys(sent).sort(), ['brandColor', 'brief', 'currency', 'existingProducts', 'schoolName']);
  assert.deepEqual(sent.brief, brief); assert.equal(sent.schoolName, 'Synthetic Dojo'); assert.equal(sent.currency, 'USD');
  assert.deepEqual(sent.existingProducts, ['Black belt display', 'Student uniform']);
  assert.equal(sent.brandColor, '#c81e1e');
  assert.deepEqual([fake.inputs[0].inputBudget, fake.inputs[0].outputBudget, fake.inputs[0].maxCostMicrounits, fake.inputs[0].modelId], [6000, 3000, 80000, 'approved/csm2-synthetic']);
  const r1 = await proposalRow(v1.id);
  assert.deepEqual([r1.status, r1.reserved_credits, r1.kind, r1.school_id, r1.subject_id], ['RESULT_RECORDED', 0, 'MERCH_IDEAS', a.school, a.connection]);
  const plan = await row('SELECT agent_key, task_class, input_budget, output_budget FROM hon.ai_invocation_plans WHERE id=$1', [r1.plan_id]);
  assert.deepEqual(plan, { agent_key: 'marcus', task_class: 'DRAFT_MARKETING', input_budget: 6000, output_budget: 3000 });
  assert.deepEqual(await ledger(v1.id), [{ c: 2, cost: '900', spend_class: 'AGENT_INFERENCE', school_id: a.school }]);
  assert.equal((await row('SELECT count(*)::int n FROM hon.shopify_product_changes WHERE school_id=$1', [a.school])).n, 0, 'an idea proposes no Shopify change');
  const replay = await ai.request({ ...c1, requestId: K(), correlationId: K() }, brief);
  assert.equal(replay.id, v1.id); assert.equal(fake.calls, 1);
  assert.equal(code(await settle(ai.request({ ...c1, requestId: K(), correlationId: K() }, { ...brief, notes: 'Something else' }))), 'IDEMPOTENCY_KEY_REUSED');
  pass('ask: one plan (marcus, DRAFT_MARKETING, 6,000/3,000), one call with only the brief, school name, currency, brand color and product titles, one ledger row, ideas recorded, no Shopify change, key replay safe');

  // 3. Close: the requester marks the ideas used (APPLIED) or dismissed; closed stays closed; others cannot move them.
  const coOwner = await addStaff(a, 'coowner', (await rows('SELECT code FROM hon.permissions')).map((p) => p.code));
  assert.equal((await ai.read(readCtx(coOwner), v1.id)).mine, false);
  assert.equal((await settle(ai.close(ctx(coOwner), v1.id, 'APPLIED'))).error?.getStatus(), 404);
  assert.equal((await ai.close(ctx(a), v1.id, 'APPLIED')).status, 'APPLIED');
  assert.equal((await ai.close(ctx(a), v1.id, 'APPLIED')).status, 'APPLIED', 'replay');
  assert.equal(code(await settle(ai.close(ctx(a), v1.id, 'DISMISSED'))), 'SHOPIFY_MERCH_AI_NOT_OPEN');
  pass('close: only the requester marks ideas used or dismissed; a replay is a no-op; closed stays closed');

  // 4. A paid answer that does not fit the brief is RESULT_REJECTED with its usage kept and its problems shown.
  fake.answer = { summary: 'Wrong shape', ideas: [{ style: 'MINIMAL', title: 'x' }] };
  const bad = await ai.request(ctx(a), brief);
  assert.equal(bad.status, 'RESULT_REJECTED'); assert.deepEqual(bad.problems, ['The answer was not a list of merch ideas.']); assert.equal(bad.ideas, null);
  assert.equal((await ledger(bad.id)).length, 1);
  fake.answer = { summary: 'Three looks', ideas: [idea('MINIMAL'), idea('PREMIUM'), idea('MINIMAL')] };
  const off = await ai.request(ctx(a), brief);
  assert.equal(off.status, 'RESULT_REJECTED');
  assert.deepEqual(off.problems, ['Idea 2 uses a look that was not asked for.', 'Two ideas use the same look.', 'The answer has 3 ideas for 2 looks.']);
  assert.equal((await ai.close(ctx(a), off.id, 'DISMISSED')).status, 'DISMISSED');
  assert.equal(code(await settle(ai.close(ctx(a), bad.id, 'APPLIED'))), 'SHOPIFY_MERCH_AI_NOT_OPEN');
  // In a store that does not use US dollars a suggested price is a problem: HON never converts or guesses a currency.
  const cad = await makeOrg('cad', 'CAD');
  fake.answer = goodAnswer;
  const priced = await ai.request(ctx(cad), brief);
  assert.equal(priced.status, 'RESULT_REJECTED'); assert.match(priced.problems[0], /does not use US dollars/);
  fake.answer = { summary: 'No prices', ideas: [idea('MINIMAL', null), idea('ATHLETIC', null)] };
  assert.equal((await ai.request(ctx(cad), brief)).status, 'RESULT_RECORDED');
  pass('rejected: an answer outside the idea shape, with looks not asked for, or with a price in a non-USD store keeps its usage, shows its problems, can be dismissed and never used');

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
  // Not configured on this server: nothing is sent and nothing is held.
  fake.ready = false;
  const off2 = await ai.request(ctx(a), brief);
  assert.deepEqual([off2.status, off2.reason], ['CONFIGURATION_REQUIRED', 'CONFIGURATION_REQUIRED']); assert.equal((await proposalRow(off2.id)).reserved_credits, 0);
  fake.ready = true;
  pass('unknown: a lost outcome keeps its hold and appears in the HQ queue as TEXT_PROPOSAL; a provider refusal or an unconfigured route holds nothing');

  // 6. HQ usage: merch ideas count under their own agent.
  const usage = (await row('SELECT hon.read_ai_school_usage_from_hq($1,$2::timestamptz,$3::timestamptz) r', [hq.subject, new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString()])).r;
  const by = usage.schools.find((s) => s.schoolId === a.school).byClass.AGENT_INFERENCE.byAgent;
  assert.equal(by.MERCH_IDEAS.credits, 6, JSON.stringify(by)); assert.equal(by.MARKETING, undefined);
  pass('usage: the HQ per-school read attributes merch ideas to MERCH_IDEAS');

  // 7. Gates: store connected (start and final claim), Complete, Marcus, Shopify manage, an HQ pause, school isolation.
  const calls = fake.calls;
  const b = await makeOrg('b');
  await admin.query("UPDATE hon.organization_entitlements SET tier='CORE' WHERE organization_id=$1", [b.id]);
  assert.equal(code(await settle(ai.request(ctx(b), brief))), 'SHOPIFY_MERCH_AI_FORBIDDEN');
  await admin.query("UPDATE hon.organization_entitlements SET tier='COMPLETE' WHERE organization_id=$1", [b.id]);
  const reader = await addStaff(b, 'reader', ['commerce.shopify.read', 'marketing.assistant.use', 'ai.invocation.plan']);
  assert.equal(code(await settle(ai.request(ctx(reader), brief))), 'SHOPIFY_MERCH_AI_FORBIDDEN');
  const manager = await addStaff(b, 'manager', ['commerce.shopify.read', 'commerce.shopify.manage']);
  assert.equal(code(await settle(ai.request(ctx(manager), brief))), 'SHOPIFY_MERCH_AI_FORBIDDEN');
  assert.equal((await ai.list(readCtx(reader))).length, 0, 'a store reader may read the list');
  assert.equal((await row('SELECT count(*)::int n FROM hon.ai_text_proposals WHERE organization_id=$1', [b.id])).n, 0);
  assert.equal(code(await settle(ai.request(ctx(b), { ...brief, styles: [] }))), 'SHOPIFY_MERCH_AI_INVALID');
  assert.equal(code(await settle(ai.request(ctx(b), { ...brief, notes: 'api_key: abc' }))), 'SHOPIFY_MERCH_AI_INVALID');
  // Disconnected before the start: refused with no row. Disconnected between start and send: GATE_CLOSED, nothing sent.
  await storeConnected(b, false);
  assert.equal(code(await settle(ai.request(ctx(b), brief))), 'SHOPIFY_MERCH_AI_NOT_CONNECTED');
  await storeConnected(b, true);
  const tenant = (o, work) => db.withTenantTransaction(ctx(o), async (c) => { await c.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [o.subject]); return work(c); });
  const begun = await tenant(b, async (c) => (await c.query('SELECT hon.begin_shopify_merch_ideas($1,$2::jsonb,$3::uuid) d', [b.subject, JSON.stringify(brief), K()])).rows[0].d);
  await storeConnected(b, false);
  const ref = await tenant(b, async (c) => (await c.query('SELECT hon.shopify_merch_ideas_planning_reference($1,$2::uuid) d', [b.subject, begun.id])).rows[0].d);
  const planned = await plans.plan({ ...ctx(b), idempotencyKey: begun.id }, ref.workItemId, { expectedVersion: ref.workVersion, expectedState: 'READY', agentKey: 'marcus', modality: 'TEXT', taskClass: 'DRAFT_MARKETING', inputBudget: 6000, outputBudget: 3000, maxProviderCostMicrounits: 80000 });
  assert.equal(await tenant(b, async (c) => (await c.query('SELECT hon.prepare_shopify_merch_ideas($1,$2::uuid,$3::uuid,true) d', [b.subject, begun.id, planned.plan.id])).rows[0].d), null);
  const gated = await proposalRow(begun.id);
  assert.deepEqual([gated.status, gated.reason, gated.reserved_credits], ['BLOCKED', 'GATE_CLOSED', 0]);
  await storeConnected(b, true);
  const pause = await settle(admin.query('SELECT hon.command_ai_spend_pause($1,$2::jsonb,$3::uuid) r', [hq.subject, JSON.stringify({ action: 'PAUSE', organizationId: b.id, spendClass: 'AGENT_INFERENCE', reason: 'CS-M2 synthetic pause for this proof' }), K()]));
  assert.equal(pause.value?.rows[0].r.status, 'ACTIVE', pause.error?.message);
  const paused = await settle(ai.request(ctx(b), brief));
  assert.deepEqual([code(paused), paused.error?.getResponse().reason], ['SHOPIFY_MERCH_AI_SPEND_STOPPED', 'AI_PAUSED_BY_HQ']); assert.equal(fake.calls, calls);
  assert.equal((await settle(ai.read(readCtx(b), v1.id))).error?.getStatus(), 404);
  assert.equal((await settle(ai.close(ctx(b), refused.id, 'DISMISSED'))).error?.getStatus(), 404);
  assert(!(await ai.list(readCtx(b))).some((x) => x.id === v1.id));
  assert.equal(networkCalls, 0);
  pass('gates: Core plan, a store reader, or a manager without Marcus is refused before any row; bad briefs are refused; a disconnected store refuses the start and blocks GATE_CLOSED at the final claim; an HQ pause refuses with no call; schools are isolated');

  { const verify = await (await import('node:fs/promises')).readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
    const section = verify.split('-- Shopify merch AI ideas exact verification (0502)')[1]?.split('-- End Shopify merch AI ideas exact verification.')[0];
    assert.ok(section, '0502 verify section present');
    await admin.query(section.slice(section.indexOf('\nDO $$')).replaceAll('hon_runtime', runtimeRole)); }
  pass('011: the 0502 exact verification (bodies, definer, ACLs, kind row) passes');
  console.log(`CS-M2 merch AI ideas: ${groups} groups passed, ${fake.calls} fake provider calls, 0 network calls`);
} finally {
  await admin.end().catch(() => {});
  await db.onModuleDestroy?.().catch?.(() => {});
}
