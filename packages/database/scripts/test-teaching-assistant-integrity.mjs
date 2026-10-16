import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
const runtimeUrl = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
const validationTarget = process.env.HON_TEACHING_AI_VALIDATION_TARGET;
const database = 'hon_teaching_ai_validation';
const ownerRole = 'hon_teaching_ai_owner';
const runtimeRole = 'hon_teaching_ai_runtime';
const providerEnvironment = Object.keys(process.env).filter((key) => /^(?:OPENROUTER|DIRECT_LLM_API|HEYGEN|HIGGSFIELD|OPENAI|ANTHROPIC|GOOGLE_AI|GOOGLE_GENERATIVE)_(?:.*(?:API_)?KEY|.*TOKEN|.*SECRET|.*PASSWORD|.*PAID.*|.*APPROV.*|.*LIVE.*|.*EXECUT.*)$/i.test(key));

for (const [url, role] of [[databaseUrl, ownerRole], [runtimeUrl, runtimeRole]]) {
  if (url.hostname !== 'localhost' || url.port !== '5432' || url.pathname !== `/${database}` || url.username !== role) {
    throw new Error('Claire integration proof permits only exact disposable localhost owner/runtime aliases. Remote, Supabase, and arbitrary local targets are refused.');
  }
}
if (validationTarget) {
  const target = new URL(validationTarget);
  if (target.hostname !== 'localhost' || target.port !== '5432' || target.pathname !== `/${database}`) {
    throw new Error('HON_TEACHING_AI_VALIDATION_TARGET, when supplied, must name only the guarded disposable localhost Claire database.');
  }
}
if (providerEnvironment.length) {
  throw new Error(`Claire integration proof refuses provider credentials, paid-call gates, or execution switches (${providerEnvironment.join(', ')}).`);
}

const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { AiInvocationPlanService } = await import('../../../apps/api/dist/ai/ai-invocation-plan.service.js');
const { ActionEngineService } = await import('../../../apps/api/dist/action/action-engine.service.js');
const { TeachingAssistantService } = await import('../../../apps/api/dist/teaching-assistant/teaching-assistant.service.js');
const { ClaireProviderRuntimeError } = await import('../../../apps/api/dist/ai/claire-provider-runtime.js');

const admin = new pg.Client({ connectionString: databaseUrl.toString(), ssl: false });
const runtimeSql = new pg.Client({ connectionString: runtimeUrl.toString(), ssl: false });
const db = new RuntimeDatabaseService();
const plans = new AiInvocationPlanService(db);
const actions = new ActionEngineService(db);
const org = randomUUID();
const foreignOrg = randomUUID();
const school = randomUUID();
const siblingSchool = randomUUID();
const foreignSchool = randomUUID();
const curriculum = randomUUID();
const catalog = randomUUID();
const policy = randomUUID();
const actors = Object.fromEntries(['requester', 'reviewer', 'reviewer2', 'foreign', 'inactive', 'parent'].map((name) => [name, {
  id: randomUUID(), user: randomUUID(), role: randomUUID(), grant: randomUUID(), subject: `claire-${name}-${randomUUID()}`,
  organizationId: name === 'foreign' ? foreignOrg : org, schoolId: name === 'foreign' ? foreignSchool : school,
}]));
const draft = { title: 'Private curriculum practice outline', content: 'Warm up, demonstrate the sequence, then guide controlled practice.' };
const brief = 'PRIVATE_TEACHING_BRIEF_DO_NOT_LEAK';
let networkCalls = 0;
let generated = 0;
let providerReadiness = 'READY';
let providerMode = 'RESULT';
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { networkCalls += 1; throw new Error('EXTERNAL_NETWORK_FORBIDDEN'); };
const provider = {
  readiness: () => providerReadiness,
  generate: async (input) => {
    generated += 1;
    assert.equal(input.providerId, 'OPENROUTER');
    assert.equal(input.modelId, 'approved/claire-local');
    assert.equal(input.inputBudget, 4096);
    assert.equal(input.outputBudget, 1024);
    assert.equal(input.maxCostMicrounits, 100000);
    assert(input.request.startsWith('Approved curriculum facts only: '));
    if (providerMode === 'UNKNOWN') throw new ClaireProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    if (providerMode === 'OVER_BUDGET') return { draft, inputTokens: 4097, outputTokens: 10, providerCostMicrounits: 10 };
    return { draft, inputTokens: 200, outputTokens: 100, providerCostMicrounits: 600 };
  },
};
const assistant = new TeachingAssistantService(db, plans, actions, provider);

const context = (who = 'requester', patch = {}) => ({
  organizationId: actors[who].organizationId,
  schoolId: actors[who].schoolId,
  principalId: actors[who].id,
  externalSubject: actors[who].subject,
  principalType: 'HUMAN_USER',
  source: 'HUMAN_UI',
  requestId: randomUUID(),
  correlationId: randomUUID(),
  idempotencyKey: randomUUID(),
  ...patch,
});
const denied = (work, status = 403) => assert.rejects(work, (error) => {
  assert.equal(error?.getStatus?.(), status, error?.stack ?? String(error));
  return true;
});
const sqlDenied = (work, code = '42501') => assert.rejects(work, (error) => {
  assert.equal(error?.code, code, error?.stack ?? String(error));
  return true;
});
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const binding = (proposal) => ({
  actionRequestId: proposal.id,
  actionCode: proposal.actionCode,
  requestedByPrincipalId: proposal.requestedByPrincipalId,
  payloadHash: proposal.payloadHash,
  policyVersion: proposal.policyVersion,
  approvalExpiresAt: proposal.approvalExpiresAt,
  effectiveAuthorityMode: 'CONFIRM',
});
const decide = (proposal, decision = 'APPROVED', patch = {}) => ({ actionRequestId: proposal.id, decision, binding: binding(proposal), ...patch });
async function snapshot(tables) {
  const state = {};
  for (const table of tables) {
    state[table] = (await admin.query(`SELECT to_jsonb(row) AS data FROM hon.${table} row ORDER BY to_jsonb(row)::text`)).rows;
  }
  return state;
}
await Promise.all([admin.connect(), runtimeSql.connect()]);
try {
  const tables = ['teaching_ai_invocations', 'teaching_ai_drafts', 'teaching_studio_ai_drafts'];
  const allowedFunctions = new Set([
    'hon.resolve_teaching_assistant_scope(text)',
    'hon.list_my_teaching_invocations(text)',
    'hon.read_teaching_invocation(text,uuid)',
    'hon.begin_teaching_request(text,jsonb,uuid)',
    'hon.teaching_planning_reference(text,uuid)',
    'hon.prepare_teaching_invocation(text,uuid,uuid,boolean)',
    'hon.fail_teaching_invocation(text,uuid,text,text)',
    'hon.record_teaching_result(text,uuid,jsonb)',
    'hon.bind_teaching_proposal(text,uuid,uuid)',
    'hon.teaching_action_is_current(uuid,jsonb)',
    'hon.reject_teaching_draft(uuid)',
    'hon.save_approved_teaching_draft(text,uuid)',
  ]);
  const allFunctions = [
    'hon.teaching_assistant_safe_text(text,integer,boolean)',
    'hon.guard_teaching_assistant()',
    'hon.resolve_teaching_assistant_scope(text)',
    'hon.require_teaching_assistant_actor(text,boolean)',
    'hon.teaching_assistant_event(uuid,text)',
    'hon.list_my_teaching_invocations(text)',
    'hon.read_teaching_invocation(text,uuid)',
    'hon.begin_teaching_request(text,jsonb,uuid)',
    'hon.teaching_planning_reference(text,uuid)',
    'hon.prepare_teaching_invocation(text,uuid,uuid,boolean)',
    'hon.fail_teaching_invocation(text,uuid,text,text)',
    'hon.record_teaching_result(text,uuid,jsonb)',
    'hon.bind_teaching_proposal(text,uuid,uuid)',
    'hon.teaching_action_is_current(uuid,jsonb)',
    'hon.reject_teaching_draft(uuid)',
    'hon.save_approved_teaching_draft(text,uuid)',
  ];
  for (const table of tables) {
    const row = (await admin.query(`SELECT relrowsecurity, relforcerowsecurity,
      has_table_privilege($1, $2::regclass, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS direct_access
      FROM pg_class WHERE oid=$2::regclass`, [runtimeRole, `hon.${table}`])).rows[0];
    assert.equal(row?.relrowsecurity, true, `${table} must have RLS`);
    assert.equal(row?.relforcerowsecurity, true, `${table} must force RLS`);
    assert.equal(row?.direct_access, false, `${table} must not have direct restricted-runtime access`);
  }
  for (const signature of allFunctions) {
    const row = (await admin.query(`SELECT
      EXISTS(SELECT 1 FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
        WHERE p.oid=$1::regprocedure AND x.grantee=0 AND x.privilege_type='EXECUTE') AS public_execute,
      has_function_privilege($2,$1,'EXECUTE') AS runtime_execute,
      EXISTS(SELECT 1 FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
        WHERE p.oid=$1::regprocedure AND x.grantee=(SELECT oid FROM pg_roles WHERE rolname=$2) AND x.is_grantable) AS runtime_grantable`, [signature, runtimeRole])).rows[0];
    assert.equal(row?.public_execute, false, `${signature} must not be PUBLIC`);
    assert.equal(row?.runtime_execute, allowedFunctions.has(signature), `${signature} runtime ACL must be exact`);
    assert.equal(row?.runtime_grantable, false, `${signature} must not be grantable by runtime`);
  }
  const runtimePosture = (await admin.query(`SELECT rolsuper, rolbypassrls, rolinherit, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin
    FROM pg_roles WHERE rolname=$1`, [runtimeRole])).rows[0];
  assert(runtimePosture && !runtimePosture.rolsuper && !runtimePosture.rolbypassrls && !runtimePosture.rolinherit
    && !runtimePosture.rolcreatedb && !runtimePosture.rolcreaterole && !runtimePosture.rolreplication && runtimePosture.rolcanlogin,
  'Claire proof requires the restricted hon_runtime-equivalent posture');

  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PRIVATE Claire organization','PRIVATE Claire organization'),($2,'PRIVATE foreign organization','PRIVATE foreign organization')", [org, foreignOrg]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'PRIVATE Claire school',$1::uuid::text,'UTC'),($3,$2,'PRIVATE sibling school',$3::uuid::text,'UTC'),($4,$5,'PRIVATE foreign school',$4::uuid::text,'UTC')", [school, org, siblingSchool, foreignSchool, foreignOrg]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day'),($2,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day')", [org, foreignOrg]);
  for (const [name, actor] of Object.entries(actors)) {
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$2||'@example.test','PRIVATE human')", [actor.user, actor.subject]);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE human',$3)", [actor.id, actor.user, name !== 'inactive']);
    const roleCode = name === 'parent' ? 'PARENT' : `CLAIRE_${name.toUpperCase()}`;
    await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,'PRIVATE role',false)", [actor.role, actor.organizationId, roleCode]);
    const permissions = name === 'requester' ? ['teaching.studio.read', 'teaching.assistant.use', 'ai.invocation.plan', 'action.approve']
      : ['reviewer', 'reviewer2'].includes(name) ? ['teaching.studio.read', 'teaching.assistant.use', 'ai.invocation.plan', 'action.approve']
      : name === 'foreign' ? ['teaching.studio.read', 'teaching.assistant.use', 'ai.invocation.plan'] : [];
    for (const permission of permissions) await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [actor.role, actor.organizationId, permission]);
    await admin.query("INSERT INTO hon.principal_role_grants(id,principal_id,organization_id,school_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$2,clock_timestamp()-interval '1 day')", [actor.grant, actor.id, actor.organizationId, actor.schoolId, actor.role]);
  }
  await admin.query("INSERT INTO hon.curricula(id,organization_id,school_id,name,description,lifecycle,model_code) VALUES($1,$2,$3,'Published fixture curriculum','Private bounded curriculum facts only','PUBLISHED','LINEAR')", [curriculum, org, school]);
  await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state,credential_secret_ref) VALUES('OPENROUTER','Private local fake route','HEALTHY',$1)", [`hon-secret:${randomUUID()}`]);
  await admin.query("INSERT INTO hon.hq_ai_model_catalog(catalog_id,provider_id,model_id,display_name,capabilities,modalities,active,minimum_tier,unit_cost_micros,cost_unit,effective_from) VALUES($1,'OPENROUTER','approved/claire-local','Private local model',ARRAY['TEXT'],ARRAY['TEXT'],true,'COMPLETE',2,'TOKEN','2020-01-01')", [catalog]);
  await admin.query("INSERT INTO hon.hq_ai_routing_policies(policy_id,organization_id,school_id,capability,active,minimum_tier,max_cost_micros,effective_from) VALUES($1,$2,$3,'TEXT',true,'COMPLETE',100000,'2020-01-01')", [policy, org, school]);
  await admin.query('INSERT INTO hon.hq_ai_routing_candidates(policy_id,ordinal,catalog_id) VALUES($1,0,$2)', [policy, catalog]);
  await admin.query("INSERT INTO hon.action_policies(organization_id,school_id,action_code,authority_mode,policy_version,effective_from) VALUES($1,$2,'teaching.draft.save','CONFIRM',1,clock_timestamp()-interval '1 day')", [org, school]);
  await admin.query('COMMIT');

  const prohibited = ['teaching_lesson_plans', 'teaching_lesson_plan_revisions', 'teaching_resources', 'teaching_resource_revisions', 'instructor_assessments', 'instructor_assessment_revisions', 'teaching_studio_requests', 'student_profiles', 'attendance_records', 'testing_events', 'testing_candidates', 'promotion_decisions', 'billing_accounts', 'memberships', 'membership_payment_schedules', 'invoices', 'payment_attempts', 'communication_consents', 'communication_messages'];
  const prohibitedBefore = await snapshot(prohibited);
  assert.deepEqual(await db.resolveTeachingAssistantScope(actors.requester.subject), { principalId: actors.requester.id, organizationId: org, schoolId: school });
  assert.equal(await db.resolveTeachingAssistantScope(actors.parent.subject), undefined);
  await denied(() => assistant.submit(context('parent'), { curriculumId: curriculum, brief }));
  await denied(() => assistant.submit(context('requester', { source: 'AI' }), { curriculumId: curriculum, brief }));

  // Restricted direct table access fails; temporarily granting SELECT proves forced RLS has no policy escape even against a real stored row.
  await sqlDenied(() => runtimeSql.query('SELECT * FROM hon.teaching_ai_invocations'));
  await sqlDenied(() => runtimeSql.query("SELECT hon.require_teaching_assistant_actor('nope',true)"));

  const primaryKey = randomUUID();
	  const primary = await assistant.submit(context('requester', { idempotencyKey: primaryKey }), { curriculumId: curriculum, brief });
	  assert.equal(primary.status, 'AWAITING_APPROVAL');
	  assert.deepEqual(primary.draft, draft);
	  assert.equal(primary.customerCredits, 1);
	  assert.equal(generated, 1);
	  const mine = await assistant.listMine(context('requester'));
	  const mineItem = mine.find((item) => item.id === primary.id);
	  assert(mineItem, 'Current requester must see the durable Claire work pointer.');
	  assert.deepEqual(Object.keys(mineItem).sort(), ['actionRequestId', 'agentKey', 'id', 'reason', 'schoolId', 'sourceRecordId', 'status', 'updatedAt', 'workItemId']);
	  assert.equal(mineItem.agentKey, 'claire'); assert.equal(mineItem.schoolId, school); assert.equal(mineItem.sourceRecordId, curriculum); assert.equal(mineItem.workItemId, primary.workItemId); assert.equal(mineItem.status, 'AWAITING_APPROVAL'); assert.equal(mineItem.actionRequestId, primary.actionRequestId);
	  assert.equal(JSON.stringify(mineItem).includes(brief), false, 'Inbox pointer must not expose the private brief.');
	  assert.equal(JSON.stringify(mineItem).includes(draft.content), false, 'Inbox pointer must not expose draft text.');
	  assert.deepEqual(await assistant.listMine(context('reviewer')), [], 'Another qualified human must not see requester draft work.');
	  await denied(() => assistant.listMine(context('requester', { source: 'AI' })));
  assert(!JSON.stringify(primary).includes(brief), 'Read projection must redact the private brief.');
  await admin.query(`GRANT SELECT ON hon.teaching_ai_invocations TO ${runtimeRole}`);
  try { assert.equal((await runtimeSql.query('SELECT * FROM hon.teaching_ai_invocations')).rowCount, 0, 'Forced RLS must hide actual rows from the restricted role without a policy.'); }
  finally { await admin.query(`REVOKE SELECT ON hon.teaching_ai_invocations FROM ${runtimeRole}`); }
  const replay = await assistant.submit(context('requester', { idempotencyKey: primaryKey }), { curriculumId: curriculum, brief });
  assert.equal(replay.id, primary.id);
  assert.equal(generated, 1, 'Request replay must not invoke the local fake twice.');
  await denied(() => assistant.submit(context('requester', { idempotencyKey: primaryKey }), { curriculumId: curriculum, brief: 'Different safe teaching brief' }), 409);
  const review = await actions.getForReview(context('reviewer'), primary.actionRequestId);
  await denied(() => actions.decide(context('requester'), decide(review)), 409);
  assert.equal(review.reviewBlock, null);
  const approved = await actions.decide(context('reviewer', { idempotencyKey: randomUUID() }), decide(review));
  assert.equal(approved.status, 'APPROVED');
  assert.equal(approved.executionTriggered, false);
  const saved = await assistant.saveApproved(context(), primary.id);
  assert.equal(saved.status, 'SAVED');
  assert.equal((await assistant.saveApproved(context(), primary.id)).status, 'SAVED', 'Approved internal save must be idempotent.');
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM hon.teaching_studio_ai_drafts WHERE invocation_id=$1', [primary.id])).rows[0].n, 1);

  const deniedInvocation = await assistant.submit(context(), { curriculumId: curriculum, brief: 'A separate internal draft for denial.' });
  const deniedReview = await actions.getForReview(context('reviewer'), deniedInvocation.actionRequestId);
  const denialContext = context('reviewer', { idempotencyKey: randomUUID() });
  const deniedReceipt = await actions.decide(denialContext, decide(deniedReview, 'DENIED'));
  assert.equal(deniedReceipt.status, 'DENIED');
  assert.deepEqual(await actions.decide(denialContext, decide(deniedReview, 'DENIED')), deniedReceipt, 'Denied reviewer receipt replay must not decide twice.');
  assert.equal((await assistant.read(context(), deniedInvocation.id)).status, 'REJECTED');
  await denied(() => assistant.saveApproved(context(), deniedInvocation.id));
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM hon.teaching_studio_ai_drafts WHERE invocation_id=$1', [deniedInvocation.id])).rows[0].n, 0);

  const stale = await assistant.submit(context(), { curriculumId: curriculum, brief: 'A draft whose approval policy becomes stale.' });
  const staleReview = await actions.getForReview(context('reviewer'), stale.actionRequestId);
  await admin.query("INSERT INTO hon.action_policies(organization_id,school_id,action_code,authority_mode,policy_version,effective_from) VALUES($1,$2,'teaching.draft.save','CONFIRM',2,clock_timestamp()-interval '1 second')", [org, school]);
  assert.equal((await actions.getForReview(context('reviewer'), stale.actionRequestId)).reviewBlock, 'APPROVAL_POLICY_STALE');
  await denied(() => actions.decide(context('reviewer'), decide(staleReview)), 409);
  await admin.query('DELETE FROM hon.action_policies WHERE organization_id=$1 AND school_id=$2 AND action_code=$3 AND policy_version=2', [org, school, 'teaching.draft.save']);

  // A tiny injected construction window is used only to exercise real SQL expiry checks; it never alters clocks or data outside this disposable fixture.
  const originalNow = Date.now;
  let expiring;
  try {
    Date.now = () => originalNow() - 30 * 60 * 1000 + 1500;
    expiring = await assistant.submit(context(), { curriculumId: curriculum, brief: 'A draft that expires after human approval.' });
  } finally { Date.now = originalNow; }
  const expiryReview = await actions.getForReview(context('reviewer'), expiring.actionRequestId);
  await actions.decide(context('reviewer'), decide(expiryReview));
  await sleep(Math.max(0, Date.parse(expiryReview.approvalExpiresAt) - Date.now() + 100));
  await denied(() => assistant.saveApproved(context(), expiring.id));
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM hon.teaching_studio_ai_drafts WHERE invocation_id=$1', [expiring.id])).rows[0].n, 0, 'Expired approval cannot create a Teaching Studio draft.');

  const raceKey = randomUUID();
  const raced = await Promise.allSettled([
    assistant.submit(context('requester', { idempotencyKey: raceKey }), { curriculumId: curriculum, brief: 'Concurrent replay proof.' }),
    assistant.submit(context('requester', { idempotencyKey: raceKey }), { curriculumId: curriculum, brief: 'Concurrent replay proof.' }),
  ]);
  const racedSuccesses = raced.filter((result) => result.status === 'fulfilled').map((result) => result.value);
  assert.equal(racedSuccesses.length, 1, 'One concurrent request must persist while a deadlocked peer is safely rejected for retry.');
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM hon.teaching_ai_invocations WHERE requested_by=$1 AND idempotency_key=$2', [actors.requester.id, raceKey])).rows[0].n, 1);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM hon.action_requests WHERE id=$1', [racedSuccesses[0].actionRequestId])).rows[0].n, 1);
  const raceReview = await actions.getForReview(context('reviewer'), racedSuccesses[0].actionRequestId);
  const decisions = await Promise.allSettled([
    actions.decide(context('reviewer'), decide(raceReview, 'APPROVED')),
    actions.decide(context('reviewer2'), decide(raceReview, 'DENIED')),
  ]);
  assert.equal(decisions.filter((result) => result.status === 'fulfilled').length, 1, 'Exactly one concurrent human decision may resolve a proposal.');
  assert.equal(decisions.filter((result) => result.status === 'rejected').length, 1);

  providerMode = 'OVER_BUDGET';
  const overBudget = await assistant.submit(context(), { curriculumId: curriculum, brief: 'A result budget guard proof.' });
  assert.equal(overBudget.status, 'FAILED');
  assert.equal(overBudget.reason, 'RESULT_BUDGET_EXCEEDED');
  assert.equal(overBudget.draft, null);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM hon.action_requests WHERE id=$1', [(await admin.query('SELECT action_request_id FROM hon.teaching_ai_invocations WHERE id=$1', [overBudget.id])).rows[0].action_request_id])).rows[0].n, 0);
  providerMode = 'RESULT';

  providerReadiness = 'CONFIGURATION_REQUIRED';
  const quotaKey = randomUUID();
  const quotaPrepared = await assistant.submit(context('requester', { idempotencyKey: quotaKey }), { curriculumId: curriculum, brief: 'A quota reservation guard proof.' });
  assert.equal(quotaPrepared.status, 'CONFIGURATION_REQUIRED');
  const quotaCorrelation = randomUUID();
  await admin.query("INSERT INTO hon.ai_usage_ledger(organization_id,school_id,provider_code,model_code,modality,customer_credits,correlation_id) VALUES($1,$2,'OPENROUTER','quota-fixture','TEXT',12000,$3)", [org, school, quotaCorrelation]);
  providerReadiness = 'READY';
  const quotaBlocked = await assistant.generate(context(), quotaPrepared.id);
  assert.equal(quotaBlocked.status, 'BLOCKED');
  assert.equal(quotaBlocked.reason, 'CUSTOMER_BUDGET_EXCEEDED');
  assert.equal(generated, 6, 'Quota failure must stop before fake generation.');
  await admin.query('DELETE FROM hon.ai_usage_ledger WHERE correlation_id=$1', [quotaCorrelation]);

  providerMode = 'UNKNOWN';
  const unknown = await assistant.submit(context(), { curriculumId: curriculum, brief: 'An unknown provider outcome proof.' });
  assert.equal(unknown.status, 'UNKNOWN');
  assert.equal(unknown.reason, 'PROVIDER_UNKNOWN');
  assert.equal(unknown.draft, null);
  assert.equal((await admin.query('SELECT reserved_credits FROM hon.teaching_ai_invocations WHERE id=$1', [unknown.id])).rows[0].reserved_credits, 6);
  const generatedBeforeUnknownRetry = generated;
  assert.equal((await assistant.generate(context(), unknown.id)).status, 'UNKNOWN');
  assert.equal(generated, generatedBeforeUnknownRetry, 'Unknown outcomes are quarantined; retries do not resend.');
  providerMode = 'RESULT';

  await denied(() => assistant.read(context('foreign'), primary.id), 404);
  await admin.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=principal_id WHERE id=$1', [actors.requester.grant]);
  await denied(() => assistant.submit(context(), { curriculumId: curriculum, brief: 'Revoked requester proof.' }));
  await admin.query('UPDATE hon.principal_role_grants SET revoked_at=NULL, revoked_by_principal_id=NULL WHERE id=$1', [actors.requester.grant]);
  await admin.query("UPDATE hon.organization_entitlements SET tier='CORE' WHERE organization_id=$1", [org]);
  await denied(() => assistant.submit(context(), { curriculumId: curriculum, brief: 'Revoked tier proof.' }));
  await admin.query("UPDATE hon.organization_entitlements SET tier='COMPLETE' WHERE organization_id=$1", [org]);
  const reviewerRevoked = await assistant.submit(context(), { curriculumId: curriculum, brief: 'Reviewer revocation proof.' });
  const reviewerRevokedReview = await actions.getForReview(context('reviewer'), reviewerRevoked.actionRequestId);
  await actions.decide(context('reviewer'), decide(reviewerRevokedReview));
  await admin.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=principal_id WHERE id=$1', [actors.reviewer.grant]);
  await denied(() => assistant.saveApproved(context(), reviewerRevoked.id));
  await admin.query('UPDATE hon.principal_role_grants SET revoked_at=NULL, revoked_by_principal_id=NULL WHERE id=$1', [actors.reviewer.grant]);
  assert.equal(await db.resolveTeachingAssistantScope(actors.requester.subject).then((value) => value?.schoolId), school);
  const siblingGrant = (await admin.query('INSERT INTO hon.principal_role_grants(principal_id,organization_id,school_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$1) RETURNING id', [actors.requester.id, org, siblingSchool, actors.requester.role])).rows[0].id;
  try { assert.equal(await db.resolveTeachingAssistantScope(actors.requester.subject), undefined, 'Claire refuses ambiguous multi-school selection.'); }
  finally { await admin.query('DELETE FROM hon.principal_role_grants WHERE id=$1', [siblingGrant]); }

  const evidence = JSON.stringify((await admin.query("SELECT next_state,result FROM hon.audit_events WHERE entity_type IN ('TEACHING_AI_INVOCATION','ACTION_REQUEST') OR action_code LIKE 'teaching.%'")).rows);
  const outbox = JSON.stringify((await admin.query("SELECT payload FROM hon.outbox_events WHERE aggregate_type IN ('TEACHING_AI_INVOCATION','ACTION_REQUEST')")).rows);
  assert(!evidence.includes(brief) && !evidence.includes(draft.content), 'Audit evidence must retain IDs/statuses, not private briefs or draft text.');
  assert(!outbox.includes(brief) && !outbox.includes(draft.content), 'Outbox evidence must retain IDs/statuses, not private briefs or draft text.');
  assert.deepEqual(await snapshot(prohibited), prohibitedBefore, 'Claire must not mutate Teaching Studio plans/resources/assessments, students, attendance, testing, promotion, billing, or communications.');
  assert.equal(networkCalls, 0, 'No provider or external network transport was attempted.');
  console.log(`Claire restricted-role integration proof passed: real local SQL functions/RLS/ACLs; approval, denial, stale/expired policy, idempotency/concurrency, quota/result, UNKNOWN quarantine, redaction, revocation, and no unrelated domain effects. Fake provider calls=${generated}; external network calls=${networkCalls}.`);
} finally {
  globalThis.fetch = originalFetch;
  await db.onModuleDestroy();
  await Promise.allSettled([runtimeSql.end(), admin.end()]);
}
