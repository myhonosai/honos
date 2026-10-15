import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

if (!process.env.DATABASE_URL || !process.env.HON_RUNTIME_DATABASE_URL) {
  throw new Error('Both migration and restricted runtime database URLs are required.');
}
const options = (connectionString) => ({ connectionString, ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false } });
const admin = new pg.Client(options(process.env.DATABASE_URL));
const runtime = new pg.Client(options(process.env.HON_RUNTIME_DATABASE_URL));
const signature = 'hon.read_school_health_score(text,uuid,uuid)';
const denied = async (operation, code = '42501') => assert.rejects(operation, error => error?.code === code);

await Promise.all([admin.connect(), runtime.connect()]);
try {
  const boundary = (await admin.query(`
    SELECT p.prosecdef, p.provolatile, p.proconfig,
      owner.rolsuper OR owner.rolbypassrls AS trusted_owner,
      has_function_privilege('hon_runtime', p.oid, 'EXECUTE') AS runtime_execute,
      EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
        WHERE acl.grantee NOT IN (p.proowner, (SELECT oid FROM pg_roles WHERE rolname = 'hon_runtime'))
      ) AS broad_execute,
      position('current_setting' IN pg_get_functiondef(p.oid)) = 0 AS no_caller_guc_authority
    FROM pg_proc p JOIN pg_roles owner ON owner.oid = p.proowner
    WHERE p.oid = $1::regprocedure
  `, [signature])).rows[0];
  assert(boundary, 'School Health Score function is missing.');
  assert.equal(boundary.prosecdef, true);
  assert.equal(boundary.provolatile, 's');
  assert.deepEqual(boundary.proconfig, ['search_path=pg_catalog, hon']);
  assert.equal(boundary.trusted_owner, true);
  assert.equal(boundary.runtime_execute, true);
  assert.equal(boundary.broad_execute, false);
  assert.equal(boundary.no_caller_guc_authority, true);

  for (const role of ['anon', 'authenticated', 'service_role']) {
    const exists = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount > 0;
    if (exists) assert.equal((await admin.query('SELECT has_function_privilege($1, $2::regprocedure, $3) allowed', [role, signature, 'EXECUTE'])).rows[0].allowed, false, `${role} may not execute Health Score projection`);
  }
  for (const table of ['users', 'principals', 'roles', 'permissions', 'role_permissions', 'principal_role_grants', 'hq_operator_grants']) {
    assert.equal((await admin.query("SELECT has_table_privilege('hon_runtime', $1, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed", [`hon.${table}`])).rows[0].allowed, false, `runtime gained forbidden direct ${table} access`);
  }

  const countState = async () => (await admin.query(`SELECT
    (SELECT count(*) FROM hon.audit_events) AS audit,
    (SELECT count(*) FROM hon.outbox_events) AS outbox,
    (SELECT count(*) FROM hon.action_requests) AS actions,
    (SELECT count(*) FROM hon.work_items) AS work_items,
    (SELECT count(*) FROM hon.ai_usage_ledger) AS ai_usage`)).rows[0];
  const before = await countState();
  await runtime.query('BEGIN READ ONLY');
  try {
    const forgedOrganization = randomUUID(); const forgedSchool = randomUUID();
    await runtime.query("SELECT set_config('app.hon_organization_id',$1,true), set_config('app.hon_school_id',$2,true), set_config('app.hon_principal_id',$3,true)", [forgedOrganization, forgedSchool, randomUUID()]);
    await runtime.query('SAVEPOINT forged_health_score_scope');
    await denied(() => runtime.query('SELECT hon.read_school_health_score($1,$2::uuid,$3::uuid)', [`unknown-health-score-${randomUUID()}`, forgedOrganization, forgedSchool]));
    await runtime.query('ROLLBACK TO SAVEPOINT forged_health_score_scope');
    const context = (await runtime.query('SELECT hon.current_organization_id() organization, hon.current_school_id() school')).rows[0];
    assert.equal(context.organization, forgedOrganization, 'Projection must not overwrite forged caller context.');
    assert.equal(context.school, forgedSchool, 'Projection must not overwrite forged caller context.');
    await runtime.query('ROLLBACK');
  } catch (error) { await runtime.query('ROLLBACK'); throw error; }
  assert.deepEqual(await countState(), before, 'Health Score read/denial wrote audit, outbox, action, work, or AI state.');
  console.log('Verified School Health Score trusted stable definer posture, exact runtime-only EXECUTE, no client execution/new direct directory grants, forged caller-GUC denial, preserved context, and zero audit/outbox/action/work/AI writes without creating fixtures.');
} finally {
  await Promise.all([admin.end(), runtime.end()]);
}
