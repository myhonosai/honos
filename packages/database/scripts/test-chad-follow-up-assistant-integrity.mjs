import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const owner = new URL(process.env.DATABASE_URL ?? '');
const runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
const database = 'hon_chad_follow_up_validation';
const ownerRole = 'hon_chad_follow_up_owner';
const runtimeRole = 'hon_chad_follow_up_runtime';
const providerEnvironment = Object.keys(process.env).filter((key) => /^(?:OPENROUTER|DIRECT_LLM_API|HEYGEN|HIGGSFIELD|OPENAI|ANTHROPIC|GOOGLE_AI|GOOGLE_GENERATIVE)_(?:.*(?:API_)?KEY|.*TOKEN|.*SECRET|.*PASSWORD|.*PAID.*|.*APPROV.*|.*LIVE.*|.*EXECUT.*)$/i.test(key));
for (const [url, role] of [[owner, ownerRole], [runtime, runtimeRole]]) {
  if (url.hostname !== 'localhost' || url.port !== '5432' || url.pathname !== `/${database}` || url.username !== role) {
    throw new Error('Chad integration proof permits only exact disposable localhost owner/runtime aliases. Remote and arbitrary local targets are refused.');
  }
}
if (providerEnvironment.length) throw new Error(`Chad integration proof refuses provider credentials, paid-call gates, or execution switches (${providerEnvironment.join(', ')}).`);

const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { AiInvocationPlanService } = await import('../../../apps/api/dist/ai/ai-invocation-plan.service.js');
const { ActionEngineService } = await import('../../../apps/api/dist/action/action-engine.service.js');
const { ChadFollowUpAssistantService } = await import('../../../apps/api/dist/chad-follow-up-assistant/chad-follow-up-assistant.service.js');
const { ChadProviderRuntimeError } = await import('../../../apps/api/dist/ai/chad-provider-runtime.js');

const admin = new pg.Client({ connectionString: owner.toString(), ssl: false });
const restricted = new pg.Client({ connectionString: runtime.toString(), ssl: false });
const db = new RuntimeDatabaseService();
const plans = new AiInvocationPlanService(db);
const actions = new ActionEngineService(db);
const ids = Object.fromEntries(['org', 'foreignOrg', 'school', 'foreignSchool', 'person', 'lead', 'pipeline', 'stage', 'catalog', 'policy'].map((key) => [key, randomUUID()]));
const actors = Object.fromEntries(['requester', 'reviewer', 'parent', 'foreign'].map((name) => [name, {
  id: randomUUID(), user: randomUUID(), role: randomUUID(), subject: `chad-${name}-${randomUUID()}`,
  organizationId: name === 'foreign' ? ids.foreignOrg : ids.org,
  schoolId: name === 'foreign' ? ids.foreignSchool : ids.school,
}]));
const sourceCode = 'PRIVATE_LEAD_SOURCE_DO_NOT_AUDIT';
const draft = { subject: 'A friendly check-in', content: 'PRIVATE_DRAFT_CONTENT Please reply when a human team member can help with a trial class.' };
let fakeCalls = 0;
let providerMode = 'RESULT';
let networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { networkCalls += 1; throw new Error('EXTERNAL_NETWORK_FORBIDDEN'); };
const provider = {
  readiness: () => providerMode === 'NOT_READY' ? 'CONFIGURATION_REQUIRED' : 'READY',
  generate: async (invocation) => {
    fakeCalls += 1;
    assert.equal(invocation.providerId, 'OPENROUTER');
    assert.equal(invocation.modelId, 'approved/chad-local');
    assert.equal(invocation.inputBudget, 2048);
    assert.equal(invocation.outputBudget, 600);
    assert.equal(invocation.maxCostMicrounits, 60000);
    assert(invocation.request.startsWith('Approved non-identifying lead facts only: '));
    assert(!invocation.request.includes('PRIVATE_PERSON_NAME'));
    if (providerMode === 'UNKNOWN') throw new ChadProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    if (providerMode === 'FAILED') throw new ChadProviderRuntimeError('FAILED', 'PROVIDER_REJECTED');
    return { draft, inputTokens: 200, outputTokens: 100, providerCostMicrounits: 600 };
  },
};
const assistant = new ChadFollowUpAssistantService(db, plans, actions, provider);
const context = (who = 'requester', patch = {}) => ({
  organizationId: actors[who].organizationId, schoolId: actors[who].schoolId, principalId: actors[who].id,
  externalSubject: actors[who].subject, principalType: 'HUMAN_USER', source: 'HUMAN_UI',
  requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID(), ...patch,
});
const input = () => ({ leadId: ids.lead, expectedLeadVersion: 1, purpose: 'CHECK_IN' });
const denied = (operation, expected = 403) => assert.rejects(operation, (error) => {
  assert.equal(error?.getStatus?.(), expected, error?.stack ?? String(error)); return true;
});
const reviewBinding = (review) => ({
  actionRequestId: review.id, actionCode: review.actionCode, requestedByPrincipalId: review.requestedByPrincipalId,
  payloadHash: review.payloadHash, policyVersion: review.policyVersion, approvalExpiresAt: review.approvalExpiresAt,
  effectiveAuthorityMode: 'CONFIRM',
});
const decide = (review, decision = 'APPROVED') => ({ actionRequestId: review.id, decision, binding: reviewBinding(review) });
async function snapshot(tables) {
  const state = {};
  for (const table of tables) state[table] = (await admin.query(`SELECT to_jsonb(row) AS data FROM hon.${table} row ORDER BY to_jsonb(row)::text`)).rows;
  return state;
}

await Promise.all([admin.connect(), restricted.connect()]);
try {
  for (const table of ['chad_follow_up_invocations', 'chad_follow_up_drafts']) {
    const posture = (await admin.query(`SELECT relrowsecurity,relforcerowsecurity,has_table_privilege($1,$2::regclass,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') direct FROM pg_class WHERE oid=$2::regclass`, [runtimeRole, `hon.${table}`])).rows[0];
    assert.equal(posture.relrowsecurity, true); assert.equal(posture.relforcerowsecurity, true); assert.equal(posture.direct, false);
  }
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,'hon.require_chad_follow_up_actor(text)','EXECUTE') allowed")).rows[0].allowed, false);

  await admin.query('BEGIN');
  for (const organization of [ids.org, ids.foreignOrg]) {
    await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PRIVATE Chad organization','PRIVATE Chad organization')", [organization]);
    await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day')", [organization]);
  }
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2::uuid,'PRIVATE Chad school',$1::uuid::text,'UTC'),($3::uuid,$4::uuid,'PRIVATE foreign school',$3::uuid::text,'UTC')", [ids.school, ids.org, ids.foreignSchool, ids.foreignOrg]);
  for (const [name, actor] of Object.entries(actors)) {
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$2||'@private.example.test','PRIVATE_DIRECTORY')", [actor.user, actor.subject]);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY')", [actor.id, actor.user]);
    await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,'PRIVATE role',false)", [actor.role, actor.organizationId, name === 'parent' ? 'PARENT' : `CHAD_${name.toUpperCase()}`]);
    const permissions = name === 'requester' ? ['crm.lead.read', 'crm.assistant.follow_up_draft', 'ai.invocation.plan']
      : name === 'reviewer' ? ['action.approve']
        : name === 'parent' ? ['crm.lead.read', 'crm.assistant.follow_up_draft', 'ai.invocation.plan', 'action.approve']
          : ['crm.lead.read', 'crm.assistant.follow_up_draft', 'ai.invocation.plan'];
    for (const permission of permissions) await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [actor.role, actor.organizationId, permission]);
    await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')", [actor.organizationId, actor.schoolId, actor.id, actor.role]);
  }
  await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email) VALUES($1,$2,$3,'PRIVATE_PERSON_NAME','PRIVATE_PERSON_FAMILY','private@example.test')", [ids.person, ids.org, ids.school]);
  await admin.query("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'PRIVATE pipeline')", [ids.pipeline, ids.org, ids.school]);
  await admin.query("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'New',1)", [ids.stage, ids.org, ids.school, ids.pipeline]);
  await admin.query("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status,source_code) VALUES($1,$2,$3,$4,$5,$6,'OPEN',$7)", [ids.lead, ids.org, ids.school, ids.person, ids.pipeline, ids.stage, sourceCode]);
  await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state,credential_secret_ref) VALUES('OPENROUTER','Private local Chad route','HEALTHY',$1) ON CONFLICT(provider_id) DO UPDATE SET state='HEALTHY',credential_secret_ref=excluded.credential_secret_ref", [`hon-secret:${randomUUID()}`]);
  await admin.query("INSERT INTO hon.hq_ai_model_catalog(catalog_id,provider_id,model_id,display_name,capabilities,modalities,active,minimum_tier,unit_cost_micros,cost_unit,effective_from) VALUES($1,'OPENROUTER','approved/chad-local','Private local Chad model',ARRAY['TEXT'],ARRAY['TEXT'],true,'COMPLETE',2,'TOKEN','2020-01-01')", [ids.catalog]);
  await admin.query("INSERT INTO hon.hq_ai_routing_policies(policy_id,organization_id,school_id,capability,active,minimum_tier,max_cost_micros,effective_from) VALUES($1,$2,$3,'TEXT',true,'COMPLETE',100000,'2020-01-01')", [ids.policy, ids.org, ids.school]);
  await admin.query('INSERT INTO hon.hq_ai_routing_candidates(policy_id,ordinal,catalog_id) VALUES($1,0,$2)', [ids.policy, ids.catalog]);
  await admin.query("INSERT INTO hon.action_policies(organization_id,school_id,action_code,authority_mode,policy_version,effective_from) VALUES($1,$2,'crm.follow_up_draft.propose','CONFIRM',1,clock_timestamp()-interval '1 day')", [ids.org, ids.school]);
  await admin.query('COMMIT');

  const prohibited = ['crm_leads', 'people', 'crm_activities', 'crm_follow_ups', 'communication_messages', 'communication_consents', 'payment_attempts', 'invoices', 'memberships', 'membership_payment_schedules', 'billing_accounts'];
  const domainBefore = await snapshot(prohibited);
  assert.deepEqual(await db.resolveChadFollowUpAssistantScope(actors.requester.subject), { principalId: actors.requester.id, organizationId: ids.org, schoolId: ids.school });
  assert.equal(await db.resolveChadFollowUpAssistantScope(actors.parent.subject), undefined);
  await denied(() => assistant.submit(context('parent'), input()));
  await denied(() => assistant.submit(context('requester', { source: 'AI' }), input()));

  const firstContext = context();
  const first = await assistant.submit(firstContext, input());
  assert.equal(first.status, 'AWAITING_APPROVAL');
  assert.equal(first.delivery, 'NOT_CREATED_OR_SENT');
  assert.deepEqual(first.draft, draft);
  assert.equal(first.customerCredits, 1); assert.equal(first.providerCostMicrounits, 600);
  const lifecycle = (await admin.query(`SELECT i.status,i.reason,w.work_type,w.status work_status,p.agent_key,p.task_class,p.provider_id,p.model_id
    FROM hon.chad_follow_up_invocations i JOIN hon.work_items w ON w.id=i.work_item_id JOIN hon.ai_invocation_plans p ON p.id=i.plan_id WHERE i.id=$1`, [first.id])).rows[0];
  assert.deepEqual(lifecycle, { status: 'AWAITING_APPROVAL', reason: null, work_type: 'AI_DRAFT_FOLLOW_UP', work_status: 'WAITING_FOR_APPROVAL', agent_key: 'chad', task_class: 'DRAFT_FOLLOW_UP', provider_id: 'OPENROUTER', model_id: 'approved/chad-local' });
  assert.equal(fakeCalls, 1);
  assert.equal((await assistant.submit(firstContext, input())).id, first.id);
  assert.equal(fakeCalls, 1, 'Idempotent replay must not ask the fake provider again.');
  await denied(() => assistant.submit(firstContext, { ...input(), purpose: 'INTRODUCTION' }), 409);

  const firstReview = await actions.getForReview(context('reviewer'), first.actionRequestId);
  assert.equal(firstReview.reviewBlock, null); assert.equal(firstReview.effectiveAuthorityMode, 'CONFIRM');
  assert.equal(firstReview.normalizedPayload.delivery, 'NOT_CREATED_OR_SENT');
  await denied(() => actions.decide(context('requester'), decide(firstReview)), 403);
  const firstReceipt = await actions.decide(context('reviewer'), decide(firstReview));
  assert.equal(firstReceipt.status, 'APPROVED'); assert.equal(firstReceipt.executionTriggered, false);
  const approved = await assistant.read(context(), first.id);
  assert.equal(approved.status, 'APPROVED'); assert.equal(approved.delivery, 'NOT_CREATED_OR_SENT');
  assert.equal((await admin.query('SELECT status FROM hon.work_items WHERE id=$1', [first.workItemId])).rows[0].status, 'COMPLETED');
  await denied(() => actions.beginExecution(context(), first.actionRequestId));
  assert.equal((await admin.query('SELECT status FROM hon.action_requests WHERE id=$1', [first.actionRequestId])).rows[0].status, 'APPROVED');

  const rejected = await assistant.submit(context(), input());
  const rejectedReview = await actions.getForReview(context('reviewer'), rejected.actionRequestId);
  const rejectedReceipt = await actions.decide(context('reviewer'), decide(rejectedReview, 'DENIED'));
  assert.equal(rejectedReceipt.status, 'DENIED'); assert.equal(rejectedReceipt.executionTriggered, false);
  assert.equal((await assistant.read(context(), rejected.id)).status, 'REJECTED');
  assert.equal((await admin.query('SELECT status FROM hon.work_items WHERE id=$1', [rejected.workItemId])).rows[0].status, 'FAILED');

  providerMode = 'UNKNOWN';
  const unknown = await assistant.submit(context(), input());
  assert.equal(unknown.status, 'UNKNOWN'); assert.equal(unknown.reason, 'PROVIDER_UNKNOWN'); assert.equal(unknown.draft, null);
  const fakeCallsBeforeRetry = fakeCalls;
  assert.equal((await assistant.generate(context(), unknown.id)).status, 'UNKNOWN');
  assert.equal(fakeCalls, fakeCallsBeforeRetry, 'Unknown provider outcomes must be quarantined rather than resent.');
  assert.equal((await admin.query('SELECT reserved_credits FROM hon.chad_follow_up_invocations WHERE id=$1', [unknown.id])).rows[0].reserved_credits, 3);
  providerMode = 'FAILED';
  const failed = await assistant.submit(context(), input());
  assert.equal(failed.status, 'FAILED'); assert.equal(failed.reason, 'PROVIDER_REJECTED');
  providerMode = 'NOT_READY';
  const notReady = await assistant.submit(context(), input());
  assert.equal(notReady.status, 'CONFIGURATION_REQUIRED'); assert.equal(notReady.draft, null);
  providerMode = 'RESULT';

  const callsBeforeNoRoute = fakeCalls;
  await admin.query('UPDATE hon.hq_ai_routing_policies SET active=false WHERE policy_id=$1', [ids.policy]);
  const noRoute = await assistant.submit(context(), input());
  assert.equal(noRoute.status, 'BLOCKED'); assert.equal(noRoute.reason, 'NO_ELIGIBLE_ROUTE'); assert.equal(fakeCalls, callsBeforeNoRoute);
  await admin.query('UPDATE hon.hq_ai_routing_policies SET active=true WHERE policy_id=$1', [ids.policy]);

  await denied(() => assistant.read(context('foreign'), first.id), 404);
  await admin.query("UPDATE hon.organization_entitlements SET tier='CORE' WHERE organization_id=$1", [ids.org]);
  await denied(() => assistant.submit(context(), input()));
  await admin.query("UPDATE hon.organization_entitlements SET tier='COMPLETE' WHERE organization_id=$1", [ids.org]);
  await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='crm.assistant.follow_up_draft'", [actors.requester.role]);
  await denied(() => assistant.submit(context(), input()));
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'crm.assistant.follow_up_draft')", [actors.requester.role, ids.org]);

  const audit = JSON.stringify((await admin.query("SELECT next_state,result FROM hon.audit_events WHERE entity_type IN ('CHAD_FOLLOW_UP_INVOCATION','ACTION_REQUEST')")).rows);
  const outbox = JSON.stringify((await admin.query("SELECT payload FROM hon.outbox_events WHERE aggregate_type IN ('CHAD_FOLLOW_UP_INVOCATION','ACTION_REQUEST')")).rows);
  for (const forbidden of [draft.content, sourceCode, 'hon-secret:', 'PRIVATE_PERSON_NAME']) {
    assert.equal(audit.includes(forbidden), false, `Audit leaked ${forbidden}`);
    assert.equal(outbox.includes(forbidden), false, `Outbox leaked ${forbidden}`);
  }
  const usage = (await admin.query(`SELECT provider_code,model_code,input_units,output_units,provider_cost_microunits,customer_credits
    FROM hon.ai_usage_ledger WHERE work_item_id=$1`, [first.workItemId])).rows[0];
  assert.deepEqual(usage, { provider_code: 'OPENROUTER', model_code: 'approved/chad-local', input_units: '200', output_units: '100', provider_cost_microunits: '600', customer_credits: '1' });
  assert.deepEqual(await snapshot(prohibited), domainBefore, 'Chad must not mutate lead/contact/follow-up/communication/billing state.');
  assert.equal(networkCalls, 0, 'Only an injected fake provider is allowed; no external transport may run.');
  console.log(`Chad restricted-role integration proof passed: typed durable work/plan/usage evidence, HQ policy route only, CONFIRM separate review, approval/denial durability, UNKNOWN quarantine/no-resend, Complete/role/tenant denial, redacted audit/outbox, and explicit no-delivery Action Engine block. Fake provider calls=${fakeCalls}; external network calls=${networkCalls}.`);
} finally {
  globalThis.fetch = originalFetch;
  await Promise.allSettled([db.onModuleDestroy(), restricted.end(), admin.end()]);
}
