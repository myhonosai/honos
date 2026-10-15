import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

if (!process.env.DATABASE_URL || !process.env.HON_RUNTIME_DATABASE_URL) {
  throw new Error('Both migration and restricted runtime database URLs are required.');
}

const options = (connectionString) => ({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});
const admin = new pg.Client(options(process.env.DATABASE_URL));
const runtime = new pg.Client(options(process.env.HON_RUNTIME_DATABASE_URL));
const signature = 'hon.read_school_command_center(text,uuid,uuid)';
const denied = async (operation, code = '42501') => assert.rejects(operation, (error) => error?.code === code);

await Promise.all([admin.connect(), runtime.connect()]);
try {
  const functionRow = (await admin.query(`
    SELECT p.prosecdef, p.provolatile, p.proconfig,
      owner.rolsuper OR owner.rolbypassrls AS trusted_owner,
      has_function_privilege('hon_runtime', p.oid, 'EXECUTE') AS runtime_execute,
      EXISTS (
        SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl_entry
        WHERE acl_entry.grantee NOT IN (p.proowner, (SELECT oid FROM pg_roles WHERE rolname = 'hon_runtime'))
      ) AS broad_execute,
      position('current_setting' IN pg_get_functiondef(p.oid)) = 0 AS no_caller_guc_authority
    FROM pg_proc AS p
    JOIN pg_roles AS owner ON owner.oid = p.proowner
    WHERE p.oid = $1::regprocedure
  `, [signature])).rows[0];
  assert(functionRow, 'Command Center function is missing.');
  assert.equal(functionRow.prosecdef, true);
  assert.equal(functionRow.provolatile, 's');
  assert.deepEqual(functionRow.proconfig, ['search_path=pg_catalog, hon']);
  assert.equal(functionRow.trusted_owner, true);
  assert.equal(functionRow.runtime_execute, true);
  assert.equal(functionRow.broad_execute, false);
  assert.equal(functionRow.no_caller_guc_authority, true);

  // `PUBLIC` has no pg_roles entry; the exact `broad_execute` ACL assertion
  // above covers its grantee OID. Check real client roles only when installed.
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const exists = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount > 0;
    if (exists) assert.equal((await admin.query('SELECT has_function_privilege($1, $2::regprocedure, $3) AS allowed', [role, signature, 'EXECUTE'])).rows[0].allowed, false, `${role} may not execute Command Center projection`);
  }

  const before = (await admin.query(`SELECT
    (SELECT count(*) FROM hon.audit_events) AS audit,
    (SELECT count(*) FROM hon.outbox_events) AS outbox,
    (SELECT count(*) FROM hon.action_requests) AS actions,
    (SELECT count(*) FROM hon.work_items) AS work_items,
    (SELECT count(*) FROM hon.ai_usage_ledger) AS ai_usage`)).rows[0];

  await runtime.query('BEGIN READ ONLY');
  try {
    const forgedOrganization = randomUUID();
    const forgedSchool = randomUUID();
    await runtime.query("SELECT set_config('app.hon_organization_id',$1,true), set_config('app.hon_school_id',$2,true), set_config('app.hon_principal_id',$3,true)", [forgedOrganization, forgedSchool, randomUUID()]);
    await runtime.query('SAVEPOINT forged_command_center_scope');
    await denied(() => runtime.query('SELECT hon.read_school_command_center($1,$2::uuid,$3::uuid)', [`unknown-command-center-${randomUUID()}`, forgedOrganization, forgedSchool]));
    await runtime.query('ROLLBACK TO SAVEPOINT forged_command_center_scope');
    const gucs = (await runtime.query("SELECT hon.current_organization_id() AS organization, hon.current_school_id() AS school")).rows[0];
    assert.equal(gucs.organization, forgedOrganization, 'Projection must not overwrite caller transaction context.');
    assert.equal(gucs.school, forgedSchool, 'Projection must not overwrite caller transaction context.');
    await runtime.query('ROLLBACK');
  } catch (error) {
    await runtime.query('ROLLBACK');
    throw error;
  }

  const after = (await admin.query(`SELECT
    (SELECT count(*) FROM hon.audit_events) AS audit,
    (SELECT count(*) FROM hon.outbox_events) AS outbox,
    (SELECT count(*) FROM hon.action_requests) AS actions,
    (SELECT count(*) FROM hon.work_items) AS work_items,
    (SELECT count(*) FROM hon.ai_usage_ledger) AS ai_usage`)).rows[0];
  assert.deepEqual(after, before, 'Command Center read/denial wrote consequential or AI state.');

  console.log('Verified School Command Center function posture, owner trust, least-privilege EXECUTE ACL, no broad/client execution, forged caller-GUC denial, preserved transaction context, and zero audit/outbox/action/work/AI usage side effects.');
} finally {
  await Promise.all([admin.end(), runtime.end()]);
}
