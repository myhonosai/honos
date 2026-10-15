import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

if (!process.env.DATABASE_URL || !process.env.HON_RUNTIME_DATABASE_URL) throw new Error('Protected administrator and hon_runtime database URLs are required.');
const options = (connectionString) => ({ connectionString, ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false } });
const administrator = new pg.Client(options(process.env.DATABASE_URL));
const runtime = new pg.Client(options(process.env.HON_RUNTIME_DATABASE_URL));
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { HqAiProviderService } = await import('../../../apps/api/dist/hq/hq-ai-provider.service.js');
const { HqAiProviderController } = await import('../../../apps/api/dist/hq/hq-ai-provider.controller.js');
const tables = ['hq_ai_provider_connections', 'hq_ai_model_catalog', 'hq_ai_routing_policies', 'hq_ai_routing_candidates', 'hq_ai_control_requests', 'hq_ai_control_audit', 'hq_ai_control_outbox'];
const ids = Object.fromEntries(['organization', 'school', 'otherSchool', 'hqUser', 'hqPrincipal', 'tenantUser', 'tenantPrincipal', 'tenantRole', 'readerUser', 'readerPrincipal', 'aiPrincipal', 'catalog', 'fallback', 'policy'].map((key) => [key, randomUUID()]));
const hqSubject = `hq-ai-${randomUUID()}`;
const tenantSubject = `tenant-ai-${randomUUID()}`;
const readerSubject = `reader-ai-${randomUUID()}`;
const reference = `hon-secret:${randomUUID()}`;
const hqRequest = { honIdentity: { externalSubject: hqSubject } };
const tenantRequest = { honIdentity: { externalSubject: tenantSubject } };
const readerRequest = { honIdentity: { externalSubject: readerSubject } };
const database = new RuntimeDatabaseService();
// All fixtures and mutations stay in one rolled-back transaction. Real runtime
// methods execute with SET LOCAL ROLE hon_runtime, never privileged table DML.
// This avoids changing any existing global provider configuration at all.
database.getPool = () => administrator;
const service = new HqAiProviderService(database);
const controller = new HqAiProviderController(database, service);
let assertionGroups = 0;
const checked = () => { assertionGroups++; };

async function asAdministrator(work) {
  await administrator.query('RESET ROLE');
  try { return await work(); } finally { await administrator.query('SET LOCAL ROLE hon_runtime'); }
}
async function denied(operation, verify) {
  await administrator.query('SAVEPOINT denied_operation');
  try {
    await assert.rejects(operation, verify);
    checked();
  } finally {
    await administrator.query('ROLLBACK TO SAVEPOINT denied_operation');
    await administrator.query('RELEASE SAVEPOINT denied_operation');
  }
}
const status = (expected) => (error) => error?.getStatus?.() === expected;
const code = (expected) => (error) => error?.code === expected;
const directWrite = (kind, data, key = randomUUID(), subject = hqSubject) => administrator.query('SELECT hon.hq_ai_control_plane_write($1,$2,$3::jsonb,$4::uuid,$5::uuid) AS data', [subject, kind, JSON.stringify(data), key, randomUUID()]);
const connection = { providerId: 'OPENROUTER', displayName: 'HQ Approved Text', state: 'HEALTHY', credentialSecretRef: reference, expectedVersion: 0 };
const catalog = { catalogId: ids.catalog, providerId: 'OPENROUTER', modelId: 'approved/text-v1', displayName: 'HQ Approved Model', capabilities: ['TEXT', 'TOOL_EXECUTION'], modalities: ['TEXT'], active: true, minimumTier: 'CORE', unitCostMicros: 10, costUnit: 'TOKEN', effectiveFrom: '2020-01-01T00:00:00.000Z', effectiveUntil: null, expectedVersion: 0 };
const policy = { policyId: ids.policy, organizationId: ids.organization, schoolId: ids.school, capability: 'TEXT', active: true, minimumTier: 'CORE', maxCostMicros: 150, allowDegraded: false, catalogIds: [ids.catalog, ids.fallback], effectiveFrom: catalog.effectiveFrom, effectiveUntil: null, expectedVersion: 0 };
const route = { organizationId: ids.organization, schoolId: ids.school, policyId: ids.policy, capability: 'TEXT', requiredModalities: ['TEXT'], costUnit: 'TOKEN', estimatedUnits: 10, budgetMicros: 200 };
let networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { networkCalls++; throw new Error('External calls forbidden in control-plane tests'); };

await administrator.connect();
await runtime.connect();
try {
  for (const table of tables) {
    const posture = (await administrator.query('SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass', [`hon.${table}`])).rows[0];
    assert(posture?.relrowsecurity && posture?.relforcerowsecurity);
    const access = (await runtime.query("SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed", [`hon.${table}`])).rows[0];
    assert.equal(access.allowed, false);
    assert.equal((await administrator.query("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='hon' AND tablename=$1", [table])).rows[0].n, 0);
    checked();
  }
  for (const signature of ['hon.hq_ai_snapshot()', 'hon.hq_ai_validate_write(text,jsonb)', 'hon.hq_ai_safe_text(text,boolean)']) {
    assert.equal((await runtime.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed", [signature])).rows[0].allowed, false); checked();
  }
  const definers = (await administrator.query(`SELECT p.proname,p.prosecdef,p.proconfig,r.rolsuper,r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname IN ('hq_ai_control_plane_read','hq_ai_control_plane_write','hq_ai_routing_registry')`)).rows;
  assert.equal(definers.length, 3);
  for (const definer of definers) assert(definer.prosecdef && definer.proconfig.includes('search_path=pg_catalog, hon') && (definer.rolsuper || definer.rolbypassrls)); checked();

  await administrator.query('BEGIN');
  // Transactional membership is TO the administrator, not TO hon_runtime.
  // It grants runtime no new permission/role, and ROLLBACK removes it. Managed
  // PostgreSQL migration owners may have BYPASSRLS but not superuser/SET ROLE.
  await administrator.query('GRANT hon_runtime TO CURRENT_USER');
  await administrator.query('INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)', [ids.organization, 'AI Provider Test']);
  await administrator.query('INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1::uuid,$2,$3,$1::uuid::text),($4::uuid,$2,$3,$4::uuid::text)', [ids.school, ids.organization, 'AI Provider Test School', ids.otherSchool]);
  await administrator.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status) VALUES($1,'CORE','ACTIVE')", [ids.organization]);
  for (const [user, principal, subject] of [[ids.hqUser, ids.hqPrincipal, hqSubject], [ids.tenantUser, ids.tenantPrincipal, tenantSubject], [ids.readerUser, ids.readerPrincipal, readerSubject]]) {
    await administrator.query('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)', [user, subject, `${user}@example.test`, 'AI Control Test Human']);
    await administrator.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3)", [principal, user, 'AI Control Test Human']);
  }
  await administrator.query("INSERT INTO hon.principals(id,principal_type,display_name) VALUES($1,'AI_EMPLOYEE','AI Control Test Agent')", [ids.aiPrincipal]);
  await administrator.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes) VALUES($1,'HON_HQ_OWNER','{}'),($2,'HON_HQ_OPERATOR',ARRAY['hq.ai.providers.read']),($3,'HON_HQ_OWNER','{}')", [ids.hqPrincipal, ids.readerPrincipal, ids.aiPrincipal]);
  // A school OWNER with all school permissions still has no HQ access.
  await administrator.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','Test Owner',true)", [ids.tenantRole, ids.organization]);
  await administrator.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions', [ids.tenantRole, ids.organization]);
  await administrator.query('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5)', [ids.organization, ids.school, ids.tenantPrincipal, ids.tenantRole, ids.hqPrincipal]);
  const existing = (await administrator.query("SELECT provider_id,version FROM hon.hq_ai_provider_connections WHERE provider_id IN ('OPENROUTER','DIRECT_LLM_API')")).rows;
  connection.expectedVersion = existing.find((p) => p.provider_id === 'OPENROUTER')?.version ?? 0;
  await administrator.query('SET LOCAL ROLE hon_runtime');

  for (const table of tables) await denied(() => administrator.query(`SELECT * FROM hon.${table}`), code('42501'));
  await administrator.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_hq_role','HON_HQ_OWNER',true)", [ids.organization, ids.school]);
  await denied(() => controller.read(tenantRequest), status(403));
  await denied(() => service.read(tenantSubject), status(403));
  await denied(() => controller.writeConnection(tenantRequest, connection, randomUUID()), status(403));
  await denied(() => directWrite('PROVIDER', connection, randomUUID(), tenantSubject), code('42501'));
  await denied(() => administrator.query('SELECT hon.hq_ai_routing_registry($1,$2)', [tenantSubject, ids.policy]), code('42501'));
  await denied(() => controller.writeConnection(readerRequest, connection, randomUUID()), status(403));
  await denied(() => controller.read({}), status(403));
  assert.equal((await administrator.query("SELECT count(*)::int AS n FROM hon.resolve_hq_operator_scope($1,'hq.ai.providers.manage')", [`ai:${ids.aiPrincipal}`])).rows[0].n, 0); checked();

  for (const raw of ['sk-test-rejected', 'Bearer rejected', 'eyJhbGciOiJIUzI1NiJ9.example.signature', 'password=example', 'a'.repeat(48), 'hon-secret:sk-rejected', 'https://unapproved.example']) {
    await denied(() => controller.writeConnection(hqRequest, { ...connection, credentialSecretRef: raw }, randomUUID()), status(400));
    await denied(() => directWrite('PROVIDER', { ...connection, credentialSecretRef: raw }), code('22023'));
  }
  for (const key of ['apiKey', 'token', 'password', 'jwt', 'baseUrl', 'endpoint', 'metadata', 'tools', 'authorityMode', 'permissionCodes', 'actionRequestId', 'delegatedByPrincipalId']) {
    await denied(() => controller.writeConnection(hqRequest, { ...connection, [key]: 'rejected' }, randomUUID()), status(400));
    await denied(() => directWrite('PROVIDER', { ...connection, [key]: 'rejected' }), code('22023'));
  }
  await denied(() => directWrite('PROVIDER', { ...connection, providerId: 'ARBITRARY' }), code('22023'));
  await denied(() => controller.writeConnection(hqRequest, connection, 'raw-idempotency-value'), status(400));
  await denied(() => directWrite('PROVIDER', { ...connection, displayName: 'Bearer rejected' }), code('22023'));
  await denied(() => directWrite('CATALOG', { ...catalog, modelId: 'https://unapproved.example/model' }), code('22023'));
  await denied(() => directWrite('CATALOG', { ...catalog, capabilities: ['TEXT', 'TEXT'] }), code('22023'));
  await denied(() => directWrite('CATALOG', { ...catalog, capabilities: ['TEXT', null] }), code('22023'));
  await denied(() => directWrite('CATALOG', { ...catalog, unitCostMicros: 0.5 }), code('22023'));

  const key = randomUUID();
  const created = await controller.writeConnection(hqRequest, connection, key);
  assert.equal(created.data.version, connection.expectedVersion + 1); assert.equal(created.data.replayed, false); checked();
  const replay = await controller.writeConnection(hqRequest, connection, key);
  assert.equal(replay.data.replayed, true); assert.equal(replay.data.version, created.data.version); checked();
  await denied(() => controller.writeConnection(hqRequest, { ...connection, state: 'DISABLED' }, key), status(409));
  await denied(() => controller.writeConnection(hqRequest, connection, randomUUID()), status(409));
  await controller.writeConnection(hqRequest, { ...connection, providerId: 'DIRECT_LLM_API', displayName: 'HQ Fallback', expectedVersion: existing.find((p) => p.provider_id === 'DIRECT_LLM_API')?.version ?? 0 }, randomUUID());
  await controller.writeCatalog(hqRequest, catalog, randomUUID());
  await controller.writeCatalog(hqRequest, { ...catalog, catalogId: ids.fallback, providerId: 'DIRECT_LLM_API', modelId: 'approved/fallback-v1', unitCostMicros: 5 }, randomUUID());
  await denied(() => controller.writeCatalog(hqRequest, { ...catalog, modelId: 'unapproved/replacement', expectedVersion: 1 }, randomUUID()), status(400));
  await denied(() => controller.writePolicy(hqRequest, { ...policy, catalogIds: [randomUUID()] }, randomUUID()), status(400));
  await denied(() => controller.writePolicy(hqRequest, { ...policy, catalogIds: [ids.catalog, ids.catalog] }, randomUUID()), status(400));
  await denied(() => controller.writePolicy(hqRequest, { ...policy, capability: 'VIDEO' }, randomUUID()), status(400));
  await denied(() => controller.writePolicy(hqRequest, { ...policy, organizationId: randomUUID() }, randomUUID()), status(400));
  await controller.writePolicy(hqRequest, policy, randomUUID());
  await denied(() => controller.writePolicy(hqRequest, { ...policy, schoolId: ids.otherSchool, expectedVersion: 1 }, randomUUID()), status(400));

  const snapshot = (await controller.read(hqRequest)).data;
  assert(snapshot.providers.some((p) => p.providerId === 'OPENROUTER' && p.credentialConfigured));
  assert.equal(JSON.stringify(snapshot).includes(reference), false);
  assert.equal(JSON.stringify(snapshot).includes('credentialSecretRef'), false); checked();
  assert((await controller.read(readerRequest)).data.catalog.some((c) => c.catalogId === ids.catalog)); checked();
  assert.deepEqual((await controller.preview(hqRequest, route)).data.chosen, { catalogId: ids.catalog, providerId: 'OPENROUTER', modelId: 'approved/text-v1', estimatedCostMicros: 100, costUnit: 'TOKEN', state: 'HEALTHY' }); checked();

  let providerVersion = created.data.version;
  for (const state of ['DISABLED', 'CONFIGURED', 'DEGRADED', 'UNAVAILABLE']) {
    await controller.writeConnection(hqRequest, { ...connection, state, expectedVersion: providerVersion++ }, randomUUID());
    const result = (await controller.preview(hqRequest, route)).data;
    assert.equal(result.reason, 'FALLBACK'); assert.equal(result.chosen.catalogId, ids.fallback);
    assert.equal(result.authority, 'UNCHANGED'); assert.equal(result.execution, 'NOT_PERFORMED'); checked();
  }
  await controller.writeConnection(hqRequest, { ...connection, state: 'DEGRADED', expectedVersion: providerVersion++ }, randomUUID());
  await controller.writePolicy(hqRequest, { ...policy, allowDegraded: true, expectedVersion: 1 }, randomUUID());
  assert.equal((await controller.preview(hqRequest, route)).data.reason, 'DEGRADED_ALLOWED'); checked();
  await controller.writePolicy(hqRequest, { ...policy, allowDegraded: false, expectedVersion: 2 }, randomUUID());
  await asAdministrator(() => administrator.query("UPDATE hon.organization_entitlements SET tier='ESSENTIAL' WHERE organization_id=$1", [ids.organization]));
  assert.equal((await controller.preview(hqRequest, route)).data.reason, 'TIER_REQUIRED'); checked();
  await asAdministrator(() => administrator.query("UPDATE hon.organization_entitlements SET tier='CORE',status='SUSPENDED' WHERE organization_id=$1", [ids.organization]));
  assert.equal((await controller.preview(hqRequest, route)).data.reason, 'TIER_REQUIRED'); checked();
  await asAdministrator(() => administrator.query("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1", [ids.organization]));
  await controller.writeCatalog(hqRequest, { ...catalog, catalogId: ids.fallback, providerId: 'DIRECT_LLM_API', modelId: 'approved/fallback-v1', unitCostMicros: 5, minimumTier: 'COMPLETE', expectedVersion: 1 }, randomUUID());
  const blocked = (await controller.preview(hqRequest, route)).data;
  assert.equal(blocked.reason, 'NO_ELIGIBLE_CANDIDATE'); assert.equal(blocked.authority, 'UNCHANGED'); checked();
  await denied(() => controller.preview(hqRequest, { ...route, authorityMode: 'AUTO', tools: ['billing.invoice.issue'] }), status(400));
  await denied(() => controller.preview(tenantRequest, route), status(403));

  await asAdministrator(async () => {
    const evidence = (await administrator.query("SELECT (SELECT count(*)::int FROM hon.hq_ai_control_requests WHERE actor_principal_id=$1) AS requests,(SELECT count(*)::int FROM hon.hq_ai_control_audit WHERE actor_principal_id=$1) AS audits,(SELECT count(*)::int FROM hon.hq_ai_control_outbox o JOIN hon.hq_ai_control_audit a ON a.id=o.audit_id WHERE a.actor_principal_id=$1) AS outbox", [ids.hqPrincipal])).rows[0];
    assert.equal(evidence.requests, evidence.audits); assert.equal(evidence.audits, evidence.outbox);
    const providerEvidence = (await administrator.query("SELECT count(*)::int AS n FROM hon.hq_ai_control_audit WHERE actor_principal_id=$1 AND record_id='OPENROUTER'", [ids.hqPrincipal])).rows[0];
    assert.equal(providerEvidence.n, 6); // first write plus five health updates; replay appends nothing.
    const evidenceText = JSON.stringify((await administrator.query('SELECT prior_state,next_state FROM hon.hq_ai_control_audit WHERE actor_principal_id=$1', [ids.hqPrincipal])).rows);
    assert.equal(evidenceText.includes(reference), false); assert.equal(evidenceText.includes('credential_secret_ref'), false);
    assert.equal((await administrator.query('SELECT count(*)::int AS n FROM hon.audit_events WHERE organization_id=$1', [ids.organization])).rows[0].n, 0);
    assert.equal((await administrator.query('SELECT count(*)::int AS n FROM hon.outbox_events WHERE organization_id=$1', [ids.organization])).rows[0].n, 0);
    checked();
    await administrator.query('UPDATE hon.principals SET is_active=false WHERE id=$1', [ids.hqPrincipal]);
  });
  await denied(() => controller.read(hqRequest), status(403));
  await denied(() => directWrite('PROVIDER', connection), code('42501'));

  // Regression guard: new modules cannot acquire a provider SDK, network, env,
  // execution worker, or Action Engine dependency as an accidental shortcut.
  for (const path of ['apps/api/src/hq/hq-ai-provider.service.ts', 'apps/api/src/hq/hq-ai-provider.controller.ts', 'packages/domain/src/ai-provider-router.ts', 'packages/domain/src/ai-provider-validation.ts']) {
    const source = await readFile(new URL(`../../../${path}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bfetch\s*\(|\b(?:axios|https?|openai|anthropic|heygen|higgsfield)\.(?:request|post|get)\s*\(|process\.env|from ['"](?:node:https?|openai|@anthropic|axios)|ActionEngineService|setInterval\s*\(/);
  }
  assert.equal(networkCalls, 0); checked();
  console.log(`Verified HQ AI control-plane: ${assertionGroups} assertion groups; forced deny-all RLS, no runtime DML, human HQ gates, strict metadata/ref validation, approved identities, optimistic/idempotent writes with redacted HQ evidence, live-tier/health/budget routing and unchanged authority; zero provider side effects. All fixtures rolled back.`);
} finally {
  globalThis.fetch = originalFetch;
  await administrator.query('ROLLBACK').catch(() => {});
  await administrator.end();
  await runtime.end();
}
