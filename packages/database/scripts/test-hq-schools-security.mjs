import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { requireHqSchoolsLocalUrls } from './hq-schools-local-guard.mjs';

requireHqSchoolsLocalUrls();
const owner = new URL(process.env.DATABASE_URL);
const runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL);
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { HqSchoolDirectoryService } = await import('../../../apps/api/dist/hq/hq-school-directory.service.js');
const admin = new pg.Client({ connectionString: owner.toString(), ssl: false });
const db = new RuntimeDatabaseService();
const service = new HqSchoolDirectoryService(db);
const ids = Object.fromEntries([
  'organizationOne', 'organizationTwo', 'schoolOne', 'schoolTwo', 'ownerUser', 'ownerPrincipal', 'operatorUser', 'operatorPrincipal',
  'supportUser', 'supportPrincipal', 'schoolUser', 'schoolPrincipal', 'parentUser', 'parentPrincipal', 'delegatedUser', 'delegatedPrincipal',
  'foreignUser', 'foreignPrincipal', 'aiPrincipal', 'revokedUser', 'revokedPrincipal', 'schoolRole', 'foreignRole',
].map((key) => [key, randomUUID()]));
const subjects = Object.fromEntries(['owner', 'operator', 'support', 'school', 'parent', 'delegated', 'foreign', 'ai', 'revoked'].map((key) => [key, `hq-schools-${key}-${randomUUID()}`]));

await admin.connect();
try {
  const snapshot = async () => (await admin.query(`SELECT coalesce(jsonb_object_agg(table_name, n), '{}'::jsonb) counts FROM (
    SELECT table_name, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) n FROM hon.%I', table_name), false, true, '')))[1]::text::bigint n
    FROM information_schema.tables WHERE table_schema='hon' AND table_type='BASE TABLE'
  ) rows`)).rows[0].counts;

  for (const key of ['owner', 'operator', 'support', 'school', 'parent', 'delegated', 'foreign', 'revoked']) {
    await admin.query('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)', [ids[`${key}User`], subjects[key], `${key}-${ids[`${key}User`]}@example.test`, `PRIVATE_${key.toUpperCase()}`]);
    await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3)", [ids[`${key}Principal`], ids[`${key}User`], `PRIVATE_${key.toUpperCase()}`]);
  }
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'AI_EMPLOYEE',NULL,$2)", [ids.aiPrincipal, 'PRIVATE_AI']);
  await admin.query("INSERT INTO hon.hq_operator_grants(id,principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,'HON_HQ_OWNER','{}',now()-interval '1 day'),($3,$4,'HON_HQ_OPERATOR',ARRAY['hq.dashboard.view'],now()-interval '1 day'),($5,$6,'HON_HQ_SUPPORT',ARRAY['hq.dashboard.view'],now()-interval '1 day')", [randomUUID(), ids.ownerPrincipal, randomUUID(), ids.operatorPrincipal, randomUUID(), ids.supportPrincipal]);
  await admin.query("INSERT INTO hon.hq_operator_grants(id,principal_id,hq_role,permission_codes,effective_from,effective_until) VALUES($1,$2,'HON_HQ_OWNER','{}',now()-interval '2 days',now()-interval '1 day')", [randomUUID(), ids.revokedPrincipal]);

  const emptyBefore = await snapshot();
  assert.deepEqual(await service.read(subjects.owner), { schools: [] }, 'The fixed projection must honestly return an empty directory.');
  assert.deepEqual(await snapshot(), emptyBefore, 'An empty directory read must create zero table effects.');

  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name,status,created_at,updated_at) VALUES($1,'PRIVATE_LEGAL_ONE','Harbor Organization','ACTIVE','2026-10-16T08:00:00.000Z','2026-10-16T08:00:00.000Z'),($2,'PRIVATE_LEGAL_TWO','Summit Organization','SUSPENDED','2026-10-16T08:01:00.000Z','2026-10-16T08:01:00.000Z')", [ids.organizationOne, ids.organizationTwo]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,status,created_at,updated_at) VALUES($1,$2,'Harbor School','harbor-school','ACTIVE','2026-10-16T08:02:00.000Z','2026-10-16T08:02:00.000Z'),($3,$4,'Summit School','summit-school','ARCHIVED','2026-10-16T08:03:00.000Z','2026-10-16T08:03:00.000Z')", [ids.schoolOne, ids.organizationOne, ids.schoolTwo, ids.organizationTwo]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'CORE','ACTIVE',now()-interval '1 day'),($2,'COMPLETE','ACTIVE',now()-interval '1 day')", [ids.organizationOne, ids.organizationTwo]);
  await admin.query('INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,$3,$4),($5,$6,$7,$8)', [ids.schoolRole, ids.organizationOne, 'ADMIN', 'PRIVATE_ADMIN', ids.foreignRole, ids.organizationTwo, 'ADMIN', 'PRIVATE_ADMIN']);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,now()-interval '1 day'),($6,$7,$8,$9,$10,now()-interval '1 day')", [ids.organizationOne, ids.schoolOne, ids.schoolPrincipal, ids.schoolRole, ids.schoolPrincipal, ids.organizationTwo, ids.schoolTwo, ids.foreignPrincipal, ids.foreignRole, ids.foreignPrincipal]);

  const before = await snapshot();
  const ownerDirectory = await service.read(subjects.owner);
  assert.deepEqual(await snapshot(), before, 'HQ directory must create zero table effects, including audit and outbox effects.');
  assert.deepEqual(ownerDirectory, {
    schools: [
      { schoolId: ids.schoolOne, organizationDisplayName: 'Harbor Organization', schoolDisplayName: 'Harbor School', organizationOperationalStatus: 'ACTIVE', schoolOperationalStatus: 'ACTIVE', entitlementTier: 'CORE', createdAt: '2026-10-16T08:02:00.000Z' },
      { schoolId: ids.schoolTwo, organizationDisplayName: 'Summit Organization', schoolDisplayName: 'Summit School', organizationOperationalStatus: 'SUSPENDED', schoolOperationalStatus: 'ARCHIVED', entitlementTier: 'COMPLETE', createdAt: '2026-10-16T08:03:00.000Z' },
    ],
  }, 'The directory must return two chronological minimized organization/school rows only.');
  const encoded = JSON.stringify(ownerDirectory);
  assert(!/PRIVATE_|legalName|organizationId|owner|user|email|student|family|attendance|curriculum|payment|invoice|provider|credential|usage|cost|support|impersonation|audit|outbox|action/i.test(encoded), 'Directory output must remain minimized and redacted.');
  assert.equal((await admin.query("SELECT count(*) n FROM hon.audit_events WHERE action_code ILIKE '%HQ_SCHOOL%' OR entity_type ILIKE '%HQ_SCHOOL%' ")).rows[0].n, '0');
  assert.equal((await admin.query("SELECT count(*) n FROM hon.outbox_events WHERE event_type ILIKE '%HQ_SCHOOL%' ")).rows[0].n, '0');

  const operatorDirectory = await service.read(subjects.operator);
  assert.deepEqual(operatorDirectory, ownerDirectory, 'Current HQ operator receives the same fixed projection.');
  for (const key of ['support', 'school', 'parent', 'delegated', 'foreign', 'ai', 'revoked']) {
    await assert.rejects(() => service.read(subjects[key]), (error) => error.getStatus?.() === 403, `${key} identity must not enter the HQ school directory`);
  }

  const direct = new pg.Client({ connectionString: runtime.toString(), ssl: false });
  await direct.connect();
  try {
    const projection = await direct.query('SELECT hon.read_hq_school_directory($1) data', [subjects.owner]);
    assert.equal(projection.rows[0].data.schools.length, 2);
    await direct.query('BEGIN READ ONLY');
    await direct.query("SELECT set_config('app.hon_principal_id',$1,true),set_config('app.hon_organization_id',$2,true),set_config('app.hon_school_id',$3,true),set_config('app.hon_source','AI',true),set_config('app.hon_delegated_by_principal_id',$1,true),set_config('app.hon_action_request_id',$1,true)", [ids.ownerPrincipal, ids.organizationOne, ids.schoolOne]);
    for (const subject of [subjects.school, subjects.support, subjects.delegated, subjects.ai, subjects.foreign]) {
      await direct.query('SAVEPOINT forged_context');
      await assert.rejects(() => direct.query('SELECT hon.read_hq_school_directory($1)', [subject]), (error) => error.code === '42501', 'Forged source, delegation, action, or tenant context cannot authorize the directory');
      await direct.query('ROLLBACK TO SAVEPOINT forged_context');
      await direct.query('RELEASE SAVEPOINT forged_context');
    }
    await direct.query('SAVEPOINT raw_entitlement');
    await assert.rejects(() => direct.query('SELECT tier FROM hon.organization_entitlements WHERE organization_id=$1', [ids.organizationOne]), (error) => error.code === '42501', 'A forged tenant GUC must not enable raw runtime entitlement SELECT');
    await direct.query('ROLLBACK TO SAVEPOINT raw_entitlement');
    await direct.query('RELEASE SAVEPOINT raw_entitlement');
    await direct.query('ROLLBACK');
    for (const table of ['organizations', 'schools', 'organization_entitlements', 'users', 'principals', 'hq_operator_grants', 'audit_events', 'outbox_events']) {
      await assert.rejects(() => direct.query(`SELECT * FROM hon.${table} LIMIT 1`), (error) => error.code === '42501', `Runtime direct access must be denied: ${table}`);
    }
  } finally { await direct.end(); }

  const posture = (await admin.query(`SELECT p.prosecdef,p.provolatile,p.proconfig,owner.rolsuper OR owner.rolbypassrls trusted_owner,
    has_function_privilege($1,p.oid,'EXECUTE') runtime_execute,
    has_function_privilege($1,p.oid,'EXECUTE WITH GRANT OPTION') runtime_grantable,
    NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee<>p.proowner AND acl.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$1)) closed
    FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid='hon.read_hq_school_directory(text)'::regprocedure`, [runtime.username])).rows[0];
  assert.deepEqual([posture.prosecdef, posture.provolatile, posture.proconfig, posture.trusted_owner, posture.runtime_execute, posture.runtime_grantable, posture.closed], [true, 's', ['search_path=pg_catalog, hon'], true, true, false, true]);
  for (const table of ['organizations', 'schools', 'organization_entitlements']) {
    const rls = (await admin.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass', [`hon.${table}`])).rows[0];
    assert(rls.relrowsecurity && rls.relforcerowsecurity, `Forced RLS required: ${table}`);
  }
  for (const role of (await admin.query("SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role')")).rows) {
    assert.equal((await admin.query("SELECT has_function_privilege($1,'hon.read_hq_school_directory(text)','EXECUTE') allowed", [role.rolname])).rows[0].allowed, false, `Client execute denied: ${role.rolname}`);
  }
  console.log('PASS: HQ School Management permits only current owner/operator through a fixed read-only projection; it returns ordered minimized rows or empty, denies support/school/family/AI/delegated/action/foreign/revoked paths, protects RLS/ACLs, and causes zero effects.');
} finally { await db.onModuleDestroy(); await admin.end(); }
