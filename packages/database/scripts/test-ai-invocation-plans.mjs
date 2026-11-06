import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL || !process.env.HON_RUNTIME_DATABASE_URL) throw new Error('Administrator and hon_runtime URLs required.');
const options = (connectionString) => ({ connectionString, ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false } });
const admin = new pg.Client(options(process.env.DATABASE_URL));
const runtime = new pg.Client(options(process.env.HON_RUNTIME_DATABASE_URL));
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { AiInvocationPlanService } = await import('../../../apps/api/dist/ai/ai-invocation-plan.service.js');
const { AiInvocationPlanController } = await import('../../../apps/api/dist/ai/ai-invocation-plan.controller.js');
const { ActionEngineService } = await import('../../../apps/api/dist/action/action-engine.service.js');
const ids = Object.fromEntries(['org','otherOrg','school','otherSchool','foreignSchool','user','actor','role','ai','work','otherWork','foreignWork','analysisWork','wrongWork','catalog','fallback','policy','otherPolicy'].map((key) => [key, randomUUID()]));
const subject = `plan-${randomUUID()}`;
const context = { organizationId: ids.org, schoolId: ids.school, principalId: ids.actor, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID() };
const input = { expectedVersion: 1, expectedState: 'READY', agentKey: 'hon', modality: 'TEXT', taskClass: 'SUMMARIZE', inputBudget: 1000, outputBudget: 500, maxProviderCostMicrounits: 100000 };
const database = new RuntimeDatabaseService();
let groups = 0;
const checked = () => { groups++; };
const status = (n) => (e) => e?.getStatus?.() === n;
const code = (c) => (e) => e?.code === c;
const service = new AiInvocationPlanService(database);
const controller = new AiInvocationPlanController(database, service);
let network = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { network++; throw new Error('No network in planning'); };

async function asAdmin(fn) { await admin.query('SAVEPOINT admin_work'); await admin.query('RESET ROLE'); try { const result = await fn(); await admin.query('SET LOCAL ROLE hon_runtime'); await admin.query('RELEASE SAVEPOINT admin_work'); return result; } catch (e) { await admin.query('ROLLBACK TO SAVEPOINT admin_work'); await admin.query('RELEASE SAVEPOINT admin_work'); throw e; } }
async function denied(fn, matcher) {
  await admin.query('SAVEPOINT denied');
  try { await assert.rejects(fn, matcher); checked(); }
  finally { await admin.query('ROLLBACK TO SAVEPOINT denied'); await admin.query('RELEASE SAVEPOINT denied'); }
}
async function setContext(ctx) {
  await admin.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),set_config('app.hon_principal_type',$4,true),set_config('app.hon_request_id',$5,true)", [ctx.organizationId,ctx.schoolId,ctx.principalId,ctx.principalType,ctx.requestId]);
}
// Real scoped hon_runtime DML and definer execution; transaction/savepoint shell
// only is adapted to keep even global provider fixtures entirely rollback-only.
database.withTenantTransaction = async (ctx, fn) => {
  await admin.query('SAVEPOINT scoped');
  try { await setContext(ctx); const result = await fn(admin); await admin.query('RELEASE SAVEPOINT scoped'); return result; }
  catch (e) { await admin.query('ROLLBACK TO SAVEPOINT scoped'); await admin.query('RELEASE SAVEPOINT scoped'); throw e; }
};
database.resolveAuthorizedScope = async (externalSubject, school, permission) => {
  const r = await admin.query('SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_authorized_scope($1,$2,$3)', [externalSubject, school, permission]);
  return r.rows[0];
};
const fresh = (patch = {}) => ({ ...context, idempotencyKey: randomUUID(), requestId: randomUUID(), ...patch });
const plan = (patch = {}, ctx = fresh(), work = ids.work) => service.plan(ctx, work, { ...input, ...patch });
const direct = (data, work = ids.work, key = randomUUID()) => admin.query('SELECT hon.plan_ai_invocation($1,$2::jsonb,$3,$4,$5) AS data', [work, JSON.stringify(data), key, context.requestId, context.correlationId]);
async function counts() {
  return asAdmin(async () => (await admin.query(`SELECT
    (SELECT count(*)::int FROM hon.ai_invocation_plans WHERE organization_id=$1) AS plans,
    (SELECT count(*)::int FROM hon.audit_events WHERE organization_id=$1 AND action_code='ai.invocation.plan') AS audit,
    (SELECT count(*)::int FROM hon.outbox_events WHERE organization_id=$1 AND event_type='ai.invocation.planned') AS outbox,
    (SELECT count(*)::int FROM hon.idempotency_records WHERE organization_id=$1) AS replay`, [ids.org])).rows[0]);
}

await admin.connect(); await runtime.connect();
try {
  const flags = (await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert(!flags.rolsuper && !flags.rolbypassrls);
  const posture = (await admin.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='hon.ai_invocation_plans'::regclass")).rows[0];
  assert(posture.relrowsecurity && posture.relforcerowsecurity);
  const access = (await runtime.query("SELECT has_table_privilege(current_user,'hon.ai_invocation_plans','SELECT') AS read,has_table_privilege(current_user,'hon.ai_invocation_plans','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS mutate")).rows[0];
  assert(access.read && !access.mutate);
  const columns = (await admin.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='hon' AND table_name='ai_invocation_plans'")).rows;
  assert(columns.every((c) => !['json','jsonb'].includes(c.data_type) && !/prompt|output_text|secret|credential|config|authority|permission/.test(c.column_name))); checked();
  for (const table of ['hq_ai_provider_connections','hq_ai_model_catalog','hq_ai_routing_policies','hq_ai_routing_candidates','hq_ai_control_requests','hq_ai_control_audit','hq_ai_control_outbox']) {
    assert.equal((await runtime.query("SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed", [`hon.${table}`])).rows[0].allowed, false);
  }
  for (const signature of ['hon.validate_ai_invocation_plan_input(jsonb)','hon.ai_invocation_plan_summary(uuid)','hon.reject_ai_invocation_plan_mutation()']) {
    assert.equal((await runtime.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed", [signature])).rows[0].allowed, false);
  }
  const definers = (await admin.query("SELECT p.proname,p.prosecdef,p.proconfig,r.rolsuper,r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid IN ('hon.plan_ai_invocation(uuid,jsonb,uuid,uuid,uuid)'::regprocedure,'hon.require_ai_invocation_plan_access()'::regprocedure)")).rows;
  assert.equal(definers.length,2); for (const f of definers) assert(f.prosecdef && f.proconfig.includes('search_path=pg_catalog, hon') && (f.rolsuper || f.rolbypassrls)); checked();
  await runtime.query('BEGIN');
  assert.equal((await runtime.query('SELECT count(*)::int AS n FROM hon.ai_invocation_plans')).rows[0].n,0);
  await runtime.query('ROLLBACK'); checked();

  await admin.query('BEGIN');
  await admin.query('GRANT hon_runtime TO CURRENT_USER');
  await admin.query('INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$3,$3),($2,$3,$3)', [ids.org,ids.otherOrg,'Invocation Plan Test']);
  await admin.query('INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$4,$6,$1::uuid::text),($2,$4,$6,$2::uuid::text),($3,$5,$6,$3::uuid::text)', [ids.school,ids.otherSchool,ids.foreignSchool,ids.org,ids.otherOrg,'Plan School']);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status) VALUES($1,'COMPLETE','ACTIVE'),($2,'COMPLETE','ACTIVE')", [ids.org,ids.otherOrg]);
  await admin.query('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)',[ids.user,subject,`${ids.user}@example.test`,'Plan Human']);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Plan Human'),($3,'AI_EMPLOYEE',NULL,'Plan AI')",[ids.actor,ids.user,ids.ai]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','Plan Owner',true)",[ids.role,ids.org]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'ai.invocation.plan')",[ids.role,ids.org]);
  await admin.query('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$4,$5,$4),($1,$3,$4,$5,$4),($1,$2,$6,$5,$4)',[ids.org,ids.school,ids.otherSchool,ids.actor,ids.role,ids.ai]);
  for (const [work,org,school,type] of [[ids.work,ids.org,ids.school,'AI_SUMMARIZE'],[ids.otherWork,ids.org,ids.otherSchool,'AI_SUMMARIZE'],[ids.foreignWork,ids.otherOrg,ids.foreignSchool,'AI_SUMMARIZE'],[ids.analysisWork,ids.org,ids.school,'AI_ANALYZE'],[ids.wrongWork,ids.org,ids.school,'billing.payment.initiate']]) {
    await admin.query("INSERT INTO hon.work_items(id,organization_id,school_id,work_type,status,payload,correlation_id) VALUES($1,$2,$3,$4,'READY',$5::jsonb,$6)",[work,org,school,type,JSON.stringify({ fixtureContent: 'CONTENT_MUST_NOT_ENTER_PLAN_HASH_OR_EVIDENCE' }),randomUUID()]);
  }
  const reference = `hon-secret:${randomUUID()}`;
  await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state,credential_secret_ref) VALUES('OPENROUTER','Plan Primary','HEALTHY',$1),('DIRECT_LLM_API','Plan Fallback','HEALTHY',$1) ON CONFLICT(provider_id) DO UPDATE SET state='HEALTHY',credential_secret_ref=$1",[reference]);
  await admin.query("INSERT INTO hon.hq_ai_model_catalog(catalog_id,provider_id,model_id,display_name,capabilities,modalities,active,minimum_tier,unit_cost_micros,cost_unit,effective_from) VALUES($1,'OPENROUTER','approved/plan-v1','Plan Model',ARRAY['TEXT'],ARRAY['TEXT'],true,'COMPLETE',10,'TOKEN','2020-01-01'),($2,'DIRECT_LLM_API','approved/fallback-v1','Plan Fallback',ARRAY['TEXT'],ARRAY['TEXT'],true,'CORE',5,'TOKEN','2020-01-01')",[ids.catalog,ids.fallback]);
  await admin.query("INSERT INTO hon.hq_ai_routing_policies(policy_id,organization_id,school_id,capability,active,minimum_tier,max_cost_micros,allow_degraded,effective_from) VALUES($1,$2,$3,'TEXT',true,'COMPLETE',20000,true,'2020-01-01')",[ids.policy,ids.org,ids.school]);
  await admin.query('INSERT INTO hon.hq_ai_routing_candidates(policy_id,ordinal,catalog_id) VALUES($1,0,$2),($1,1,$3)',[ids.policy,ids.catalog,ids.fallback]);
  const before = JSON.stringify((await admin.query('SELECT (SELECT jsonb_agg(p ORDER BY p.provider_id) FROM hon.hq_ai_provider_connections p) AS providers,(SELECT jsonb_agg(p ORDER BY p.catalog_id) FROM hon.hq_ai_model_catalog p) AS catalog,(SELECT jsonb_agg(p) FROM hon.action_policies p WHERE organization_id=$1) AS authority',( [ids.org]))).rows);
  await admin.query('SET LOCAL ROLE hon_runtime'); await setContext(context);
  for (const field of ['prompt','messages','output','apiKey','credentialSecretRef','providerId','modelId','routingPolicyId','authorityMode','riskClass','tier','tools','actionRequestId','payload']) {
    await denied(() => plan({ [field]: 'secret-or-prompt' }),status(400));
    await setContext(context); await denied(() => direct({ ...input,[field]:'secret-or-prompt' }),code('22023'));
  }
  for (const patch of [{ modality:'VOICE_OUTPUT' },{ modality:'IMAGE' },{ taskClass:'TOOL_EXECUTION' },{ agentKey:'sk-secret' },{ inputBudget:128001 },{ outputBudget:16001 },{ expectedVersion:0 },{ inputBudget:0.5 },{ maxProviderCostMicrounits:1000001 }]) {
    await denied(() => plan(patch),status(400)); await setContext(context); await denied(() => direct({ ...input,...patch }),code('22023'));
  }
  for (const ctx of [fresh({ principalType:'AI_EMPLOYEE' }),fresh({ source:'PUBLIC_API' }),fresh({ source:'AI' }),fresh({ delegatedByPrincipalId:ids.actor }),fresh({ actionRequestId:randomUUID() })]) await denied(() => plan({},ctx),status(403));
  await denied(() => plan({},fresh({ principalId:ids.ai })),status(403));
  await denied(() => plan({},fresh({ idempotencyKey:'raw-prompt-key' })),status(400));
  await denied(() => plan({},fresh(),ids.otherWork),status(404));
  await denied(() => plan({},fresh(),ids.foreignWork),status(404));
  await denied(() => plan({},fresh(),ids.wrongWork),status(400));
  for (const tier of ['ESSENTIAL','CORE']) {
    await asAdmin(() => admin.query('UPDATE hon.organization_entitlements SET tier=$2 WHERE organization_id=$1',[ids.org,tier]));
    await denied(() => plan(),status(403));
  }
  await asAdmin(() => admin.query("UPDATE hon.organization_entitlements SET tier='COMPLETE',status='SUSPENDED' WHERE organization_id=$1",[ids.org]));
  await denied(() => plan(),status(403));
  await asAdmin(() => admin.query("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from='2020-01-01',effective_until=now()-interval '1 second' WHERE organization_id=$1",[ids.org]));
  await denied(() => plan(),status(403));
  await asAdmin(() => admin.query('UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1',[ids.org]));
  await asAdmin(() => admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='ai.invocation.plan'",[ids.role]));
  await denied(() => plan(),status(403));
  await asAdmin(() => admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'ai.invocation.plan')",[ids.role,ids.org]));
  for (const [table,id] of [['schools',ids.school],['organizations',ids.org]]) {
    await asAdmin(() => admin.query(`UPDATE hon.${table} SET status='SUSPENDED' WHERE id=$1`,[id]));
    await denied(() => plan(),status(403));
    await asAdmin(() => admin.query(`UPDATE hon.${table} SET status='ACTIVE' WHERE id=$1`,[id]));
  }
  await denied(() => plan({ expectedVersion:2 }),status(409));
  await denied(() => plan({ expectedState:'THINKING' }),status(409));
  assert.deepEqual(await counts(),{ plans:0,audit:0,outbox:0,replay:0 }); checked();

  const first = await plan({},context);
  assert.equal(first.status,'PLANNED'); assert.equal(first.plan.status,'PLANNED');
  assert.equal(first.plan.providerId,'OPENROUTER'); assert.equal(first.plan.estimatedProviderCostMicrounits,15000);
  assert.equal(first.plan.customerCreditEstimate,2); assert.equal(first.plan.riskClass,'LOW');
  assert.equal(first.authority,'UNCHANGED'); assert.equal(first.execution,'NOT_PERFORMED');
  assert.match(first.plan.requestHash,/^[0-9a-f]{64}$/); checked();
  assert.deepEqual((await service.plan(context,ids.work,{ ...input })).plan,first.plan); checked();
  const reorder = Object.fromEntries(Object.entries(input).reverse());
  assert.equal((await service.plan(context,ids.work,reorder)).replayed,true); checked();
  await denied(() => plan({ outputBudget:501 },context),status(409));
  assert.deepEqual(await service.read(fresh(),first.plan.id),first.plan);
  const request = { honIdentity: { externalSubject:subject } };
  assert.deepEqual((await controller.read(ids.org,ids.school,first.plan.id,request)).data,first.plan);
  await denied(() => controller.read(ids.otherOrg,ids.school,first.plan.id,request),status(403));
  await denied(() => controller.read(ids.org,ids.otherSchool,first.plan.id,request),status(404));
  await denied(() => controller.read(ids.org,ids.foreignSchool,first.plan.id,request),status(403));
  await denied(() => controller.read(ids.org,ids.school,first.plan.id,{}),status(403));
  const clean = JSON.stringify(first);
  for (const forbidden of [reference,'credential','configuration','fixtureContent','CONTENT_MUST_NOT_ENTER_PLAN_HASH_OR_EVIDENCE','prompt','outputText']) assert.equal(clean.includes(forbidden),false); checked();
  await setContext(context);
  await denied(() => admin.query('UPDATE hon.ai_invocation_plans SET agent_key=\'chad\' WHERE id=$1',[first.plan.id]),code('42501'));
  await denied(() => admin.query('INSERT INTO hon.ai_invocation_plans SELECT * FROM hon.ai_invocation_plans WHERE id=$1',[first.plan.id]),code('42501'));
  await asAdmin(async () => {
    await denied(() => admin.query("UPDATE hon.ai_invocation_plans SET status='PLANNED' WHERE id=$1",[first.plan.id]),code('55000'));
  });
  assert.deepEqual(await counts(),{ plans:1,audit:1,outbox:1,replay:1 }); checked();
  await asAdmin(async () => {
    await denied(() => admin.query("INSERT INTO hon.ai_invocation_plans SELECT (jsonb_populate_record(NULL::hon.ai_invocation_plans,to_jsonb(p) || jsonb_build_object('id',gen_random_uuid(),'school_id',$2::uuid))).* FROM hon.ai_invocation_plans p WHERE p.id=$1",[first.plan.id,ids.otherSchool]),code('23503'));
  });
  // The general replay table is runtime-writable for existing commands. The
  // hardened planner must never echo arbitrary content from that table.
  await setContext(context);
  await admin.query('UPDATE hon.idempotency_records SET response_body=$2::jsonb WHERE idempotency_key=$1',[context.idempotencyKey,JSON.stringify({ plan:{ id:first.plan.id },prompt:'FORBIDDEN_REPLAY_CONTENT',credentialSecretRef:reference,authority:'AUTO',execution:'SUCCEEDED' })]);
  const projected = await service.plan(context,ids.work,input);
  assert.deepEqual(projected.plan,first.plan); assert.equal(projected.authority,'UNCHANGED'); assert.equal(projected.execution,'NOT_PERFORMED');
  assert.equal(JSON.stringify(projected).includes('FORBIDDEN_REPLAY_CONTENT'),false); assert.equal(JSON.stringify(projected).includes(reference),false); checked();
  await admin.query('UPDATE hon.idempotency_records SET response_body=$2::jsonb WHERE idempotency_key=$1',[context.idempotencyKey,JSON.stringify({ plan:{ id:randomUUID() } })]);
  await denied(() => service.plan(context,ids.work,input),status(409));
  await admin.query('UPDATE hon.idempotency_records SET response_body=$2::jsonb WHERE idempotency_key=$1',[context.idempotencyKey,JSON.stringify(first)]);

  const analysis = await plan({ taskClass:'ANALYZE' },fresh(),ids.analysisWork); assert.equal(analysis.plan.riskClass,'MODERATE'); checked();

  for (const state of ['DISABLED','CONFIGURED','DEGRADED','UNAVAILABLE']) {
    await asAdmin(() => admin.query('UPDATE hon.hq_ai_provider_connections SET state=$1 WHERE provider_id IN (\'OPENROUTER\',\'DIRECT_LLM_API\')',[state]));
    const oldCounts = await counts(); const noChoice = await plan();
    assert.deepEqual(noChoice,{ status:'NO_CHOICE',reason:'NO_ELIGIBLE_ROUTE',plan:null,replayed:false,authority:'UNCHANGED',execution:'NOT_PERFORMED' });
    assert.deepEqual(await counts(),oldCounts); checked();
  }
  await asAdmin(() => admin.query("UPDATE hon.hq_ai_provider_connections SET state='HEALTHY' WHERE provider_id='DIRECT_LLM_API'"));
  const fallback = await plan(); assert.equal(fallback.plan.catalogId,ids.fallback); assert.equal(fallback.authority,'UNCHANGED'); assert.equal(fallback.plan.riskClass,'LOW'); checked();
  await asAdmin(() => admin.query("UPDATE hon.hq_ai_provider_connections SET state='HEALTHY' WHERE provider_id='OPENROUTER'"));
  const limited = await plan({ maxProviderCostMicrounits:10000 }); assert.equal(limited.plan.catalogId,ids.fallback); assert.equal(limited.plan.estimatedProviderCostMicrounits,7500); checked();
  assert.equal((await plan({ maxProviderCostMicrounits:7499 })).status,'NO_CHOICE'); checked();
  await asAdmin(() => admin.query('UPDATE hon.hq_ai_routing_policies SET max_cost_micros=7499 WHERE policy_id=$1',[ids.policy]));
  assert.equal((await plan()).status,'NO_CHOICE'); checked();
  await asAdmin(() => admin.query('UPDATE hon.hq_ai_routing_policies SET max_cost_micros=20000,active=false WHERE policy_id=$1',[ids.policy]));
  assert.equal((await plan()).status,'NO_CHOICE'); checked();
  await asAdmin(() => admin.query("UPDATE hon.hq_ai_routing_policies SET active=true,effective_from=now()+interval '1 hour' WHERE policy_id=$1",[ids.policy]));
  assert.equal((await plan()).status,'NO_CHOICE'); checked();
  await asAdmin(() => admin.query("UPDATE hon.hq_ai_routing_policies SET effective_from='2020-01-01',effective_until=now()-interval '1 second' WHERE policy_id=$1",[ids.policy]));
  assert.equal((await plan()).status,'NO_CHOICE'); checked();
  await asAdmin(() => admin.query('UPDATE hon.hq_ai_routing_policies SET effective_until=NULL WHERE policy_id=$1',[ids.policy]));
  await asAdmin(() => admin.query('UPDATE hon.hq_ai_model_catalog SET active=false WHERE catalog_id IN ($1,$2)',[ids.catalog,ids.fallback]));
  assert.equal((await plan()).status,'NO_CHOICE'); checked();
  await asAdmin(() => admin.query("UPDATE hon.hq_ai_model_catalog SET active=true,cost_unit='REQUEST' WHERE catalog_id IN ($1,$2)",[ids.catalog,ids.fallback]));
  assert.equal((await plan()).status,'NO_CHOICE'); checked();
  await asAdmin(() => admin.query("UPDATE hon.hq_ai_model_catalog SET cost_unit='TOKEN',modalities=ARRAY['IMAGE'] WHERE catalog_id IN ($1,$2)",[ids.catalog,ids.fallback]));
  assert.equal((await plan()).status,'NO_CHOICE'); checked();
  await asAdmin(() => admin.query("UPDATE hon.hq_ai_model_catalog SET modalities=ARRAY['TEXT'],effective_from=now()+interval '1 hour' WHERE catalog_id IN ($1,$2)",[ids.catalog,ids.fallback]));
  assert.equal((await plan()).status,'NO_CHOICE'); checked();
  await asAdmin(() => admin.query("UPDATE hon.hq_ai_model_catalog SET effective_from='2020-01-01' WHERE catalog_id IN ($1,$2)",[ids.catalog,ids.fallback]));
  await asAdmin(() => admin.query("INSERT INTO hon.hq_ai_routing_policies SELECT $2,organization_id,school_id,capability,active,minimum_tier,max_cost_micros,allow_degraded,effective_from,effective_until,version,updated_at FROM hon.hq_ai_routing_policies WHERE policy_id=$1",[ids.policy,ids.otherPolicy]));
  assert.equal((await plan()).status,'NO_CHOICE'); checked();
  await asAdmin(() => admin.query('DELETE FROM hon.hq_ai_routing_policies WHERE policy_id=$1',[ids.otherPolicy]));
  // Org-wide credit eligibility includes another school's actual ledger, but no
  // amount or other-school usage detail is exposed to the caller.
  await asAdmin(() => admin.query("INSERT INTO hon.ai_usage_ledger(organization_id,school_id,provider_code,model_code,modality,customer_credits,correlation_id) VALUES($1,$2,'TEST','test','TEXT',12000,$3)",[ids.org,ids.otherSchool,randomUUID()]));
  assert.equal((await plan()).reason,'CUSTOMER_BUDGET_EXCEEDED'); checked();
  await asAdmin(() => admin.query('DELETE FROM hon.ai_usage_ledger WHERE organization_id=$1',[ids.org]));

  // An evidence failure must roll back the newly inserted plan, audit and replay
  // record together. Only this rollback-only fixture's outbox event is blocked.
  const priorCounts = await counts();
  await asAdmin(async () => {
    await admin.query(`CREATE FUNCTION pg_temp.reject_plan_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id='${ids.org}'::uuid AND NEW.event_type='ai.invocation.planned' THEN RAISE EXCEPTION 'test evidence failure' USING ERRCODE='23514'; END IF; RETURN NEW; END $$`);
    await admin.query('CREATE TRIGGER test_plan_outbox_failure BEFORE INSERT ON hon.outbox_events FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_plan_outbox()');
  });
  await denied(() => plan(),code('23514'));
  assert.deepEqual(await counts(),priorCounts); checked();
  await asAdmin(() => admin.query('DROP TRIGGER test_plan_outbox_failure ON hon.outbox_events'));
  await asAdmin(() => admin.query("UPDATE hon.work_items SET version=version+1,status='WORKING' WHERE id=$1",[ids.work]));
  const historicReplay = await service.plan(context,ids.work,input); assert.equal(historicReplay.replayed,true); assert.deepEqual(historicReplay.plan,first.plan); checked();
  await denied(() => plan(),status(409));
  await asAdmin(() => admin.query("UPDATE hon.organization_entitlements SET tier='CORE' WHERE organization_id=$1",[ids.org]));
  await denied(() => service.plan(context,ids.work,input),status(403));
  await denied(() => service.read(fresh(),first.plan.id),status(403));
  await asAdmin(() => admin.query("UPDATE hon.organization_entitlements SET tier='COMPLETE' WHERE organization_id=$1",[ids.org]));
  await asAdmin(() => admin.query('UPDATE hon.principals SET is_active=false WHERE id=$1',[ids.actor]));
  await denied(() => service.read(fresh(),first.plan.id),status(403));
  await asAdmin(() => admin.query('UPDATE hon.principals SET is_active=true WHERE id=$1',[ids.actor]));

  await asAdmin(async () => {
    const after = JSON.stringify((await admin.query('SELECT (SELECT jsonb_agg(p ORDER BY p.provider_id) FROM hon.hq_ai_provider_connections p) AS providers,(SELECT jsonb_agg(p ORDER BY p.catalog_id) FROM hon.hq_ai_model_catalog p) AS catalog,(SELECT jsonb_agg(p) FROM hon.action_policies p WHERE organization_id=$1) AS authority',[ids.org])).rows);
    assert.equal(after,before); // all fixture state changes were restored; planner never changes them.
    const evidence = JSON.stringify((await admin.query('SELECT next_state FROM hon.audit_events WHERE organization_id=$1',[ids.org])).rows);
    assert.equal(evidence.includes(reference),false); assert.equal(evidence.includes('CONTENT_MUST_NOT_ENTER_PLAN_HASH_OR_EVIDENCE'),false);
    const c = await admin.query('SELECT (SELECT count(*)::int FROM hon.ai_usage_ledger WHERE organization_id=$1) AS ledger,(SELECT count(*)::int FROM hon.action_requests WHERE organization_id=$1) AS actions,(SELECT count(*)::int FROM hon.action_approvals WHERE organization_id=$1) AS approvals',[ids.org]);
    assert.deepEqual(c.rows[0],{ ledger:0,actions:0,approvals:0 });
    const untouched = (await admin.query('SELECT status,version,assigned_principal_id,result FROM hon.work_items WHERE id=$1',[ids.analysisWork])).rows[0];
    assert.deepEqual(untouched,{ status:'READY',version:1,assigned_principal_id:null,result:null });
    const events = (await admin.query('SELECT status,attempt_count FROM hon.outbox_events WHERE organization_id=$1',[ids.org])).rows;
    assert(events.every((e) => e.status==='PENDING' && e.attempt_count===0)); checked();
  });
  // No registered planning tool or Action Engine call path can execute plans.
  for (const ctx of [fresh(),fresh({ principalId:ids.ai,principalType:'AI_EMPLOYEE',source:'AI' })]) {
    await denied(() => new ActionEngineService(database).propose(ctx,{ actionCode:'ai.invocation.plan',normalizedPayload:{ planId:first.plan.id } }),status(403));
  }
  for (const file of ['apps/api/src/ai/ai-invocation-plan.service.ts','apps/api/src/ai/ai-invocation-plan.controller.ts','packages/domain/src/ai-invocation-planning.ts']) {
    const source = await readFile(new URL(`../../../${file}`,import.meta.url),'utf8');
    assert.doesNotMatch(source,/\bfetch\s*\(|process\.env|from ['"](?:node:https?|openai|@anthropic|axios)|ActionEngineService|setInterval\s*\(/);
    if (file.endsWith('controller.ts')) assert.doesNotMatch(source,/@(?:Post|Patch|Put|Delete)\b/);
  }
  assert.equal(network,0); checked();
  console.log(`Verified AI invocation plans: ${groups} groups; Complete/human/permission gates, forced tenant RLS, metadata-only immutable plans, safe HQ decision/no-choice, live health/window/risk/token/customer/provider-budget limits, scoped work locks, deterministic replay, version/state guard, atomic audit/outbox/idempotency, no ledger/credit/action/provider/work execution effects. All fixtures rolled back.`);
} finally {
  globalThis.fetch = originalFetch;
  await admin.query('ROLLBACK').catch(() => {});
  await admin.end(); await runtime.end();
}
