import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { requireHqOverviewLocalUrls } from './hq-overview-local-guard.mjs';

requireHqOverviewLocalUrls();
const owner = new URL(process.env.DATABASE_URL);
const runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL);
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { HqOverviewService } = await import('../../../apps/api/dist/hq/hq-overview.service.js');
const admin = new pg.Client({ connectionString: owner.toString(), ssl: false });
const db = new RuntimeDatabaseService();
const service = new HqOverviewService(db);
const ids = Object.fromEntries(['organization','school','ownerUser','ownerPrincipal','operatorUser','operatorPrincipal','supportUser','supportPrincipal','schoolUser','schoolPrincipal','parentUser','parentPrincipal','delegatedUser','delegatedPrincipal','aiUser','aiPrincipal','revokedUser','revokedPrincipal','role','requestOne','requestTwo','provider'].map((key) => [key, randomUUID()]));
const subjects = Object.fromEntries(['owner','operator','support','school','parent','delegated','ai','revoked'].map((key) => [key, `hq-overview-${key}-${randomUUID()}`]));

await admin.connect();
try {
  await admin.query('INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)', [ids.organization, 'PRIVATE_HQ_ORGANIZATION_DO_NOT_LEAK']);
  await admin.query('INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,$3,$4)', [ids.school, ids.organization, 'PRIVATE_HQ_SCHOOL_DO_NOT_LEAK', `hq-overview-${ids.school}`]);
  const users = ['owner','operator','support','school','parent','delegated','ai','revoked'];
  for (const key of users) await admin.query('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)', [ids[`${key}User`], subjects[key], `${key}-${ids[`${key}User`]}@example.test`, `PRIVATE_${key.toUpperCase()}`]);
  for (const key of users.filter((item) => item !== 'ai')) await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3)", [ids[`${key}Principal`], ids[`${key}User`], `PRIVATE_${key.toUpperCase()}`]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'AI_EMPLOYEE',NULL,$2)", [ids.aiPrincipal, 'PRIVATE_AI']);
  await admin.query('INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,$3,$4)', [ids.role, ids.organization, 'ADMIN', 'PRIVATE_ADMIN']);
  await admin.query('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,now()-interval \'1 day\')', [ids.organization, ids.school, ids.schoolPrincipal, ids.role, ids.schoolPrincipal]);
  await admin.query("INSERT INTO hon.hq_operator_grants(id,principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,'HON_HQ_OWNER','{}',now()-interval '1 day'),($3,$4,'HON_HQ_OPERATOR',ARRAY['hq.dashboard.view'],now()-interval '1 day'),($5,$6,'HON_HQ_SUPPORT',ARRAY['hq.dashboard.view'],now()-interval '1 day')", [randomUUID(), ids.ownerPrincipal, randomUUID(), ids.operatorPrincipal, randomUUID(), ids.supportPrincipal]);
  await admin.query("INSERT INTO hon.hq_operator_grants(id,principal_id,hq_role,permission_codes,effective_from,effective_until) VALUES($1,$2,'HON_HQ_OWNER','{}',now()-interval '2 days',now()-interval '1 day')", [randomUUID(), ids.revokedPrincipal]);
  await admin.query("INSERT INTO hon.hq_onboarding_requests(id,actor_principal_id,idempotency_key,request_fingerprint,status,response_body) VALUES($1,$2,'private-hq-overview-one',repeat('a',64),'IN_PROGRESS','{\"organizationId\":\"PRIVATE\"}'::jsonb),($3,$2,'private-hq-overview-two',repeat('b',64),'COMPLETED','{\"schoolId\":\"PRIVATE\"}'::jsonb)", [ids.requestOne, ids.ownerPrincipal, ids.requestTwo]);
  await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state,credential_secret_ref) VALUES('OPENROUTER','Private Provider','CONFIGURED',$1)", [`hon-secret:${ids.provider}`]);

  const snapshot = async () => (await admin.query(`SELECT coalesce(jsonb_object_agg(table_name, n), '{}'::jsonb) counts FROM (
    SELECT table_name, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) n FROM hon.%I', table_name), false, true, '')))[1]::text::bigint n
    FROM information_schema.tables WHERE table_schema='hon' AND table_type='BASE TABLE'
  ) rows`)).rows[0].counts;
  const before = await snapshot();
  const ownerOverview = await service.read(subjects.owner);
  assert.deepEqual(await snapshot(), before, 'HQ overview must create zero table effects.');
  assert.equal(ownerOverview.callerHqRole, 'OWNER'); assert.equal(ownerOverview.organizationCount, 1); assert.equal(ownerOverview.schoolCount, 1);
  assert.deepEqual(ownerOverview.onboarding, { availability: 'AVAILABLE', requestCount: 2, inProgressRequestCount: 1, completedRequestCount: 1 });
  assert.deepEqual(ownerOverview.configuredProviderStates, { disabled: 0, configured: 1, healthy: 0, degraded: 0, unavailable: 0 }); assert.equal(ownerOverview.taskProfileCount, 0);
  assert.equal(ownerOverview.financialMetrics.availability, 'UNAVAILABLE'); assert.equal(ownerOverview.aiUsage.availability, 'UNAVAILABLE'); assert.equal(ownerOverview.durableHqWork.state, 'NO_RECORDED_WORK');
  const encoded = JSON.stringify(ownerOverview);
  assert(!/PRIVATE_/.test(encoded), 'HQ overview response must not include seeded private values.');
  assert(!/\"(?:organizationId|schoolId|principalId|email|providerId|credentialSecretRef|modelId|costMicros|prompt|output|workItems|action)\"\s*:/i.test(encoded), 'HQ overview response must remain closed/redacted.');
  const operatorOverview = await service.read(subjects.operator); assert.equal(operatorOverview.callerHqRole, 'OPERATOR');
  for (const key of ['support','school','parent','delegated','ai','revoked']) await assert.rejects(() => service.read(subjects[key]), (error) => error.getStatus?.() === 403, `${key} must not enter HQ overview`);

  const direct = new pg.Client({ connectionString: runtime.toString(), ssl: false }); await direct.connect();
  try {
    const projection = await direct.query('SELECT hon.read_hq_platform_overview($1) data', [subjects.owner]); assert.equal(projection.rows[0].data.callerHqRole, 'OWNER');
    await direct.query('BEGIN READ ONLY');
    await direct.query("SELECT set_config('app.hon_principal_id',$1,true),set_config('app.hon_organization_id',$2,true),set_config('app.hon_school_id',$3,true)", [ids.ownerPrincipal, ids.organization, ids.school]);
    for (const subject of [subjects.school, subjects.support, subjects.ai]) {
      await direct.query('SAVEPOINT forged_context');
      await assert.rejects(() => direct.query('SELECT hon.read_hq_platform_overview($1)', [subject]), (error) => error.code === '42501', 'Forged GUC context cannot authorize HQ overview');
      await direct.query('ROLLBACK TO SAVEPOINT forged_context');
      await direct.query('RELEASE SAVEPOINT forged_context');
    }
    await direct.query('ROLLBACK');
    for (const table of ['organizations','schools','users','hq_onboarding_requests','hq_ai_provider_connections','hq_ai_task_profiles','work_items']) await assert.rejects(() => direct.query(`SELECT * FROM hon.${table} LIMIT 1`), (error) => error.code === '42501', `Runtime direct access must be denied: ${table}`);
    // Billing and usage retain independently reviewed tenant-scoped SELECT grants
    // for conventional school projections. The HQ function adds neither a grant
    // nor a tenant GUC, so those existing tables must still expose no rows here.
    for (const table of ['billing_accounts','ai_usage_ledger']) assert.equal((await direct.query(`SELECT * FROM hon.${table} LIMIT 1`)).rowCount, 0, `HQ overview must not create a direct ${table} data path without tenant context`);
  } finally { await direct.end(); }

  const posture = (await admin.query(`SELECT p.prosecdef,p.provolatile,p.proconfig,owner.rolsuper OR owner.rolbypassrls trusted_owner,
    has_function_privilege($1,p.oid,'EXECUTE') runtime_execute,
    NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee<>p.proowner AND acl.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$1)) closed
    FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid='hon.read_hq_platform_overview(text)'::regprocedure`, [runtime.username])).rows[0];
  assert.deepEqual([posture.prosecdef, posture.provolatile, posture.proconfig, posture.trusted_owner, posture.runtime_execute, posture.closed], [true, 's', ['search_path=pg_catalog, hon'], true, true, true]);
  for (const table of ['organizations','schools','hq_onboarding_requests','hq_ai_provider_connections','hq_ai_task_profiles']) {
    const rls = (await admin.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass', [`hon.${table}`])).rows[0]; assert(rls.relrowsecurity && rls.relforcerowsecurity, `Forced RLS required: ${table}`);
  }
  for (const role of (await admin.query("SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role')")).rows) assert.equal((await admin.query("SELECT has_function_privilege($1,'hon.read_hq_platform_overview(text)','EXECUTE') allowed", [role.rolname])).rows[0].allowed, false, `Client execute denied: ${role.rolname}`);
  console.log('PASS: HQ-1 overview permits only owner/operator through a fixed read-only definer projection, returns closed aggregate state, rejects support/school/family/AI/delegated/revoked/forged context, and creates no effects.');
} finally { await db.onModuleDestroy(); await admin.end(); }
