/**
 * WB5 (0550): AI website edits on the shared AI text proposal table, through the real API services, the restricted runtime
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
const forbidden = Object.keys(process.env).filter((k) => /^(?:OPENAI|ANTHROPIC|OPENROUTER|STRIPE|TWILIO|SUPABASE|AWS|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(k));
if (forbidden.length) throw new Error(`Refusing provider or execution variables (${forbidden.join(', ')}).`);
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls += 1; throw new Error('EXTERNAL_NETWORK_FORBIDDEN'); };

const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { AiInvocationPlanService } = await import('../../../apps/api/dist/ai/ai-invocation-plan.service.js');
const { SchoolWebsiteService } = await import('../../../apps/api/dist/website/school-website.service.js');
const { WebsiteAiService } = await import('../../../apps/api/dist/website/website-ai.service.js');
const { WebsiteProviderRuntimeError } = await import('../../../apps/api/dist/ai/website-provider-runtime.js');
const { buildWebsiteFromTemplate } = await import('@hon/contracts');

const admin = new pg.Client({ connectionString: ownerUrl, ssl: false });
const row = async (sql, args = []) => (await admin.query(sql, args)).rows[0];
const rows = async (sql, args = []) => (await admin.query(sql, args)).rows;
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
let groups = 0; const pass = (name) => console.log(`PASS WB5 ${++groups} ${name}`);

const fake = { calls: 0, inputs: [], mode: 'OK', answer: null };
const provider = {
  readiness: () => 'READY',
  generate: async (input) => {
    fake.calls += 1; fake.inputs.push(input);
    if (fake.mode === 'UNKNOWN') throw new WebsiteProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    if (fake.mode === 'FAILED') throw new WebsiteProviderRuntimeError('FAILED', 'PROVIDER_REJECTED');
    return { proposal: fake.answer, inputTokens: 900, outputTokens: 200, providerCostMicrounits: 1100 };
  },
};
const db = new RuntimeDatabaseService(), plans = new AiInvocationPlanService(db);
const sites = new SchoolWebsiteService(db), ai = new WebsiteAiService(db, plans, provider);
const catalog = K(), hq = { id: K(), user: K(), subject: `wb5-hq-owner-${K()}` };
const ctx = (o, patch = {}) => ({ organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: K(), correlationId: K(), idempotencyKey: K(), ...patch });
const readCtx = (o) => ctx(o, { idempotencyKey: '' });
const goodAnswer = { summary: 'A warmer welcome.', edits: [{ op: 'setText', page: 'home', section: 'hero', prop: 'heading', value: 'Welcome to Synthetic Dojo' }] };

async function makeOrg(label) {
  const o = { label, id: K(), school: K(), user: K(), principal: K(), role: K(), subject: `wb5-${label}-${K()}`, policy: K() };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'WB5 synthetic organization','WB5 synthetic organization')", [o.id]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'WB5 synthetic school',$1::uuid::text,'UTC')", [o.school, o.id]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day')", [o.id]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','WB5 synthetic owner')", [o.user, o.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'WB5 synthetic owner')", [o.principal, o.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','WB5 synthetic owner',true)", [o.role, o.id]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions', [o.role, o.id]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')", [o.id, o.school, o.principal, o.role]);
  await admin.query("INSERT INTO hon.hq_ai_routing_policies(policy_id,organization_id,school_id,capability,active,minimum_tier,max_cost_micros,effective_from) VALUES($1,$2,$3,'TEXT',true,'COMPLETE',150000,'2020-01-01')", [o.policy, o.id, o.school]);
  await admin.query('INSERT INTO hon.hq_ai_routing_candidates(policy_id,ordinal,catalog_id) VALUES($1,0,$2)', [o.policy, catalog]);
  await admin.query('COMMIT');
  o.site = (await sites.mutate(ctx(o), 'create', { publicSlug: `wb5-${label}-${o.school.slice(0, 8)}`, name: 'Synthetic Dojo', document: buildWebsiteFromTemplate('MODERN_CLEAN', { schoolName: 'Synthetic Dojo' }) })).website;
  return o;
}
/** A second person at the same school with the listed permissions only. */
async function addStaff(o, label, permissions) {
  const s = { ...o, user: K(), principal: K(), role: K(), subject: `wb5-${label}-${K()}` };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','WB5 synthetic staff')", [s.user, s.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'WB5 synthetic staff')", [s.principal, s.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,'WB5 synthetic staff',false)", [s.role, o.id, 'WB5_' + label.toUpperCase()]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,unnest($3::text[])', [s.role, o.id, permissions]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day')", [o.id, o.school, s.principal, s.role, o.principal]);
  await admin.query('COMMIT');
  return s;
}
const draftOf = async (o) => (await sites.read(readCtx(o))).website;
const ledger = (id) => rows('SELECT customer_credits::int c, provider_cost_microunits::bigint cost, spend_class, school_id FROM hon.ai_usage_ledger WHERE source_invocation_id=$1', [id]);
const proposalRow = (id) => row('SELECT * FROM hon.ai_text_proposals WHERE id=$1', [id]);

try {
  await admin.connect();
  assert.equal((await row("SELECT current_database() d, shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).d, database);

  // 1. Custody: forced deny-all RLS, no runtime table privilege, exactly the seven entry points for the runtime role.
  for (const t of ['ai_text_kinds', 'ai_text_proposals']) {
    const c = await row('SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE oid=$1::regclass', ['hon.' + t]); assert(c.r && c.f, t);
    assert.equal((await row("SELECT count(*)::int n FROM pg_policies WHERE schemaname='hon' AND tablename=$1", [t])).n, 0);
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) assert.equal((await row('SELECT has_table_privilege($1,$2,$3) ok', [runtimeRole, 'hon.' + t, p])).ok, false, t + p);
  }
  const entry = ['begin_school_website_ai_edit', 'school_website_ai_edit_planning_reference', 'prepare_school_website_ai_edit', 'fail_school_website_ai_edit', 'record_school_website_ai_edit', 'read_school_website_ai_edits', 'close_school_website_ai_edit'];
  const fns = await rows("SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND (p.proname LIKE 'ai_text_%' OR p.proname LIKE '%website_ai%' OR p.proname='guard_ai_text_proposals')");
  assert.equal(fns.length, 20);
  for (const f of fns) {
    assert.equal((await row("SELECT has_function_privilege($1,$2::oid,'EXECUTE') ok", [runtimeRole, f.oid])).ok, entry.includes(f.proname), f.proname);
    assert.equal((await row("SELECT coalesce(bool_or(a.grantee=0),false) pub FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1", [f.oid])).pub, false, f.proname);
  }
  const kind = await row("SELECT * FROM hon.ai_text_kinds WHERE kind='WEBSITE_EDIT'");
  assert.deepEqual([kind.agent_key, kind.task_class, kind.input_budget, kind.output_budget, Number(kind.max_cost_microunits), kind.caller, kind.usage_agent], ['marcus', 'DRAFT_MARKETING', 16000, 4000, 150000, 'HUMAN_UI', 'WEBSITE_EDIT']);
  await assert.rejects(admin.query("UPDATE hon.ai_text_kinds SET output_budget=8000 WHERE kind='WEBSITE_EDIT'"));
  pass('custody: forced deny-all RLS on both tables, runtime executes exactly seven entry points, nothing to PUBLIC, the WEBSITE_EDIT kind is fixed');

  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state,credential_secret_ref) VALUES('OPENROUTER','WB5 synthetic route','HEALTHY',$1)", [`hon-secret:${K()}`]);
  await admin.query("INSERT INTO hon.hq_ai_model_catalog(catalog_id,provider_id,model_id,display_name,capabilities,modalities,active,minimum_tier,unit_cost_micros,cost_unit,effective_from) VALUES($1,'OPENROUTER','approved/wb5-synthetic','WB5 synthetic model',ARRAY['TEXT'],ARRAY['TEXT'],true,'COMPLETE',2,'TOKEN','2020-01-01')", [catalog]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','WB5 synthetic HQ owner')", [hq.user, hq.subject]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','WB5 synthetic HQ owner',true)", [hq.id, hq.user]);
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER','{}',clock_timestamp()-interval '2 days')", [hq.id]);
  await admin.query('COMMIT');

  // 2. The owner asks; Marcus answers once; usage is one ledger row; nothing changes until the owner applies.
  const a = await makeOrg('a');
  fake.answer = goodAnswer;
  const before = await draftOf(a);
  const c1 = ctx(a);
  const v1 = await ai.request(c1, { expectedRevision: before.draftRevision, request: 'Make the welcome warmer' });
  assert.equal(v1.status, 'RESULT_RECORDED', JSON.stringify(v1)); assert.deepEqual(v1.edits, goodAnswer.edits); assert.equal(v1.summary, goodAnswer.summary); assert.deepEqual(v1.problems, []); assert.equal(v1.mine, true);
  assert.equal(fake.calls, 1);
  const sent = JSON.parse(fake.inputs[0].request);
  assert.deepEqual(Object.keys(sent).sort(), ['ownerRequest', 'site']); assert.equal(sent.ownerRequest, 'Make the welcome warmer'); assert.equal(sent.site.name, 'Synthetic Dojo');
  assert(sent.site.pages.some((p) => p.slug === 'home' && p.sections.some((s) => s.id === 'hero')));
  assert.deepEqual([fake.inputs[0].inputBudget, fake.inputs[0].outputBudget, fake.inputs[0].maxCostMicrounits, fake.inputs[0].modelId], [16000, 4000, 150000, 'approved/wb5-synthetic']);
  const r1 = await proposalRow(v1.id);
  assert.deepEqual([r1.status, r1.reserved_credits, r1.kind, r1.school_id], ['RESULT_RECORDED', 0, 'WEBSITE_EDIT', a.school]);
  const plan = await row('SELECT agent_key, task_class, input_budget, output_budget FROM hon.ai_invocation_plans WHERE id=$1', [r1.plan_id]);
  assert.deepEqual(plan, { agent_key: 'marcus', task_class: 'DRAFT_MARKETING', input_budget: 16000, output_budget: 4000 });
  assert.deepEqual(await ledger(v1.id), [{ c: 2, cost: '1100', spend_class: 'AGENT_INFERENCE', school_id: a.school }]);
  assert.equal((await row('SELECT status FROM hon.work_items WHERE id=$1', [r1.work_item_id])).status, 'WAITING_FOR_APPROVAL');
  assert.equal((await draftOf(a)).draftRevision, before.draftRevision, 'nothing changed yet');
  const events = (await rows("SELECT event_type FROM hon.outbox_events WHERE aggregate_id=$1 ORDER BY occurred_at, event_type", [v1.id])).map((e) => e.event_type);
  assert.deepEqual([...events].sort(), ['ai.text_proposal.prepared', 'ai.text_proposal.requested', 'ai.text_proposal.result_recorded']);
  // Replays: the same key returns the same suggestion with no second call; a changed request on the same key is refused.
  const replay = await ai.request({ ...c1, requestId: K(), correlationId: K() }, { expectedRevision: before.draftRevision, request: 'Make the welcome warmer' });
  assert.equal(replay.id, v1.id); assert.equal(fake.calls, 1);
  assert.equal((await settle(ai.request({ ...c1, requestId: K(), correlationId: K() }, { expectedRevision: before.draftRevision, request: 'Something else' }))).error?.getResponse().code, 'IDEMPOTENCY_KEY_REUSED');
  pass('ask: one plan (marcus, DRAFT_MARKETING, 16,000/4,000), one provider call with the owner request and the draft outline only, one ledger row, result recorded for review, draft untouched, key replay safe');

  // 3. Apply = one draft save + APPLIED; replay is safe; a dismissed or applied suggestion cannot move again.
  const applyCtx = ctx(a);
  const applied = await ai.apply(applyCtx, v1.id, { expectedRevision: before.draftRevision });
  assert.equal(applied.suggestion.status, 'APPLIED'); assert.equal(applied.website.draftRevision, before.draftRevision + 1);
  assert.equal(applied.website.draft.pages.find((p) => p.slug === 'home').sections.find((s) => s.id === 'hero').props.heading, 'Welcome to Synthetic Dojo');
  assert.equal((await ai.apply({ ...applyCtx, requestId: K(), correlationId: K() }, v1.id, { expectedRevision: before.draftRevision })).replayed, true);
  assert.equal((await settle(ai.dismiss(ctx(a), v1.id))).error?.getResponse().code, 'SCHOOL_WEBSITE_AI_NOT_OPEN');
  assert.equal((await row("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='website.save'", [a.site.id])).n >= 1, true);
  pass('apply: the edits are saved as one ordinary draft save and the suggestion closes APPLIED in the same transaction; replay is safe; closed stays closed');

  // 4. Stale requests: a new request must name the current draft; a save between ask and send blocks SUBJECT_STALE.
  const stale = await settle(ai.request(ctx(a), { expectedRevision: before.draftRevision, request: 'Add a summer camp page' }));
  assert.equal(stale.error?.getResponse().code, 'SCHOOL_WEBSITE_AI_STALE'); assert.equal(fake.calls, 1);
  const rev = (await draftOf(a)).draftRevision;
  const tenant = (o, work) => db.withTenantTransaction(ctx(o), async (c) => { await c.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [o.subject]); return work(c); });
  const begun = await tenant(a, async (c) => (await c.query('SELECT hon.begin_school_website_ai_edit($1,$2::jsonb,$3::uuid) d', [a.subject, JSON.stringify({ expectedRevision: rev, request: 'Add a summer camp page' }), K()])).rows[0].d);
  const cur = await draftOf(a);
  await sites.mutate(ctx(a), 'save', { expectedRevision: cur.draftRevision, name: cur.name, document: cur.draft });
  const ref = await tenant(a, async (c) => (await c.query('SELECT hon.school_website_ai_edit_planning_reference($1,$2::uuid) d', [a.subject, begun.id])).rows[0].d);
  const planned = await plans.plan({ ...ctx(a), idempotencyKey: begun.id }, ref.workItemId, { expectedVersion: ref.workVersion, expectedState: 'READY', agentKey: 'marcus', modality: 'TEXT', taskClass: 'DRAFT_MARKETING', inputBudget: 16000, outputBudget: 4000, maxProviderCostMicrounits: 150000 });
  const prep = await tenant(a, async (c) => (await c.query('SELECT hon.prepare_school_website_ai_edit($1,$2::uuid,$3::uuid,true) d', [a.subject, begun.id, planned.plan.id])).rows[0].d);
  assert.equal(prep, null);
  assert.deepEqual([(await proposalRow(begun.id)).status, (await proposalRow(begun.id)).reason, (await proposalRow(begun.id)).reserved_credits], ['BLOCKED', 'SUBJECT_STALE', 0]);
  pass('stale: an old revision is refused before any row or call; a draft saved between ask and send blocks SUBJECT_STALE with nothing reserved');

  // 5. A paid answer that does not fit is RESULT_REJECTED with its usage kept; it can be dismissed, never applied.
  fake.answer = { summary: 'Delete everything', edits: [{ op: 'runSql', sql: 'DROP TABLE x' }] };
  const bad = await ai.request(ctx(a), { expectedRevision: (await draftOf(a)).draftRevision, request: 'Clean up the site' });
  assert.equal(bad.status, 'RESULT_REJECTED'); assert.deepEqual(bad.problems, ['The answer was not a website edit list.']); assert.equal(bad.edits, null);
  assert.equal((await ledger(bad.id)).length, 1);
  fake.answer = { summary: 'Two changes', edits: [goodAnswer.edits[0], { op: 'removeSection', page: 'home', section: 'no-such-section' }] };
  const partial = await ai.request(ctx(a), { expectedRevision: (await draftOf(a)).draftRevision, request: 'Two changes please' });
  assert.equal(partial.status, 'RESULT_REJECTED'); assert.match(partial.problems[0], /Change 2 \(removeSection\)/); assert.equal((await ledger(partial.id)).length, 1);
  assert.equal((await settle(ai.apply(ctx(a), bad.id, { expectedRevision: (await draftOf(a)).draftRevision }))).error?.getResponse().code, 'SCHOOL_WEBSITE_AI_NOT_OPEN');
  assert.equal((await ai.dismiss(ctx(a), bad.id)).status, 'DISMISSED');
  pass('rejected: an answer outside the edit list or that does not fit the draft keeps its usage, shows its problems, can be dismissed and never applied');

  // 6. Unknown outcome: the hold stays, counts against the school, and the HQ owner sees it as TEXT_PROPOSAL.
  fake.mode = 'UNKNOWN'; fake.answer = goodAnswer;
  const lost = await ai.request(ctx(a), { expectedRevision: (await draftOf(a)).draftRevision, request: 'Make the welcome warmer again' });
  assert.equal(lost.status, 'UNKNOWN');
  const lostRow = await proposalRow(lost.id);
  assert.equal(lostRow.reserved_credits, 20); assert(lostRow.held_at); assert.equal((await ledger(lost.id)).length, 0);
  const queue = (await row('SELECT hon.read_ai_unknown_invocations_from_hq($1) r', [hq.subject])).r;
  const item = queue.open.find((q) => q.invocationId === lost.id);
  assert.deepEqual([item?.agent, item?.reservedCredits, item?.schoolId], ['TEXT_PROPOSAL', 20, a.school]);
  fake.mode = 'FAILED';
  const refused = await ai.request(ctx(a), { expectedRevision: (await draftOf(a)).draftRevision, request: 'Try once more' });
  assert.deepEqual([refused.status, refused.reason], ['FAILED', 'PROVIDER_REJECTED']); assert.equal((await proposalRow(refused.id)).reserved_credits, 0);
  fake.mode = 'OK';
  pass('unknown: a lost outcome keeps its 20-credit hold and appears in the HQ queue as TEXT_PROPOSAL; a provider refusal releases its hold');

  // 7. HQ usage: website edits count under their own agent.
  const usage = (await row('SELECT hon.read_ai_school_usage_from_hq($1,$2::timestamptz,$3::timestamptz) r', [hq.subject, new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString()])).r;
  const by = usage.schools.find((s) => s.schoolId === a.school).byClass.AGENT_INFERENCE.byAgent;
  assert.equal(by.WEBSITE_EDIT.credits, 6, JSON.stringify(by)); assert.equal(by.MARKETING, undefined);
  pass('usage: the HQ per-school read attributes website edits to WEBSITE_EDIT');

  // 8. Gates: Complete plan, the Marcus capability, an AI spend pause, other schools and other people.
  const calls = fake.calls;
  const b = await makeOrg('b');
  await admin.query("UPDATE hon.organization_entitlements SET tier='CORE' WHERE organization_id=$1", [b.id]);
  assert.equal((await settle(ai.request(ctx(b), { expectedRevision: b.site.draftRevision, request: 'Hello' }))).error?.getResponse().code, 'SCHOOL_WEBSITE_AI_FORBIDDEN');
  await admin.query("UPDATE hon.organization_entitlements SET tier='COMPLETE' WHERE organization_id=$1", [b.id]);
  const editor = await addStaff(b, 'editor', ['website.read', 'website.edit']);
  assert.equal((await settle(ai.request(ctx(editor), { expectedRevision: b.site.draftRevision, request: 'Hello' }))).error?.getResponse().code, 'SCHOOL_WEBSITE_AI_FORBIDDEN');
  assert.equal((await row('SELECT count(*)::int n FROM hon.ai_text_proposals WHERE organization_id=$1', [b.id])).n, 0);
  const pause = await settle(admin.query('SELECT hon.command_ai_spend_pause($1,$2::jsonb,$3::uuid) r', [hq.subject, JSON.stringify({ action: 'PAUSE', organizationId: b.id, spendClass: 'AGENT_INFERENCE', reason: 'WB5 synthetic pause for this proof' }), K()]));
  assert.equal(pause.value?.rows[0].r.status, 'ACTIVE', pause.error?.message);
  const paused = await settle(ai.request(ctx(b), { expectedRevision: b.site.draftRevision, request: 'Hello' }));
  assert.deepEqual([paused.error?.getResponse().code, paused.error?.getResponse().reason], ['SCHOOL_WEBSITE_AI_SPEND_STOPPED', 'AI_PAUSED_BY_HQ']); assert.equal(fake.calls, calls);
  assert.equal((await row('SELECT count(*)::int n FROM hon.ai_text_proposals WHERE organization_id=$1', [b.id])).n, 0, 'a pause refuses the start itself');
  // Another school cannot see or move school A's suggestions; a co-owner sees them but cannot apply someone else's.
  assert.equal((await settle(ai.read(readCtx(b), v1.id))).error?.getStatus(), 404);
  assert.equal((await settle(ai.dismiss(ctx(b), partial.id))).error?.getStatus(), 404);
  assert(!(await ai.list(readCtx(b))).some((x) => x.id === v1.id));
  const coOwner = await addStaff(a, 'coowner', (await rows('SELECT code FROM hon.permissions')).map((p) => p.code));
  const seen = await ai.read(readCtx(coOwner), partial.id); assert.equal(seen.mine, false);
  assert.equal((await settle(ai.apply(ctx(coOwner), partial.id, { expectedRevision: (await draftOf(a)).draftRevision }))).error?.getResponse().code, 'SCHOOL_WEBSITE_AI_NOT_OPEN');
  assert.equal((await settle(ai.dismiss(ctx(coOwner), partial.id))).error?.getStatus(), 404);
  assert.equal(networkCalls, 0);
  pass('gates: a Core plan or a website editor without Marcus is refused before any row; an HQ AI spend pause refuses the start with no row and no call; schools are isolated; only the requester moves a suggestion');

  // 9. Row guard: only status fields move, once.
  await assert.rejects(admin.query("UPDATE hon.ai_text_proposals SET request='{}'::jsonb WHERE id=$1", [v1.id]));
  await assert.rejects(admin.query("UPDATE hon.ai_text_proposals SET status='RESULT_RECORDED' WHERE id=$1", [v1.id]));
  await admin.query('DELETE FROM hon.ai_text_proposals WHERE id=$1', [v1.id]).catch(() => {});
  assert.equal((await proposalRow(v1.id))?.status, 'APPLIED');
  pass('guard: identity and request columns are fixed and a closed suggestion cannot reopen');
  { const verify = await (await import('node:fs/promises')).readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
    const section = verify.split('-- Shared AI text proposals exact verification (0550)')[1]?.split('-- End shared AI text proposals exact verification.')[0];
    assert.ok(section, '0550 verify section present');
    const body = section.slice(section.indexOf('\n'));
    await admin.query(body.replaceAll('hon_runtime', runtimeRole)); }
  pass('011: the 0550 exact verification (bodies, ACLs, tables, triggers) passes, including the eight S4 shared functions that count EIAN and TEXT_PROPOSAL');
  console.log(`WB5 website AI edits: ${groups} groups passed, ${fake.calls} fake provider calls, 0 network calls`);
} finally {
  await admin.end().catch(() => {});
  await db.onModuleDestroy?.().catch?.(() => {});
}
