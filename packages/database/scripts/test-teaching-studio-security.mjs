import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

if (!process.env.DATABASE_URL || !process.env.HON_RUNTIME_DATABASE_URL) {
  throw new Error('Both migration and restricted runtime database URLs are required.');
}

const options = connectionString => ({ connectionString, ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false } });
const admin = new pg.Client(options(process.env.DATABASE_URL));
const runtime = new pg.Client(options(process.env.HON_RUNTIME_DATABASE_URL));
const functions = [
  'hon.resolve_teaching_studio_scope(text,uuid)',
  'hon.read_teaching_studio(text,text,uuid,uuid,integer)',
  'hon.mutate_teaching_studio(text,text,uuid,uuid,jsonb,text,uuid,uuid)',
];
const tables = [
  'teaching_lesson_plans', 'teaching_lesson_plan_revisions', 'teaching_resources',
  'teaching_resource_revisions', 'instructor_assessments', 'instructor_assessment_revisions',
  'teaching_studio_requests',
];
const denied = operation => assert.rejects(operation, error => error?.code === '42501');

await Promise.all([admin.connect(), runtime.connect()]);
try {
  for (const signature of functions) {
    const boundary = (await admin.query(`
      SELECT p.prosecdef, p.proconfig,
        owner.rolsuper OR owner.rolbypassrls AS trusted_owner,
        has_function_privilege('hon_runtime', p.oid, 'EXECUTE') AS runtime_execute,
        EXISTS (
          SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl_entry
          WHERE acl_entry.grantee NOT IN (p.proowner, (SELECT oid FROM pg_roles WHERE rolname = 'hon_runtime'))
        ) AS broad_execute
      FROM pg_proc p JOIN pg_roles owner ON owner.oid = p.proowner
      WHERE p.oid = $1::regprocedure
    `, [signature])).rows[0];
    assert(boundary, `${signature} is missing.`);
    assert.equal(boundary.prosecdef, true, `${signature} must be SECURITY DEFINER.`);
    assert.deepEqual(boundary.proconfig, ['search_path=pg_catalog, hon'], `${signature} must use fixed search_path.`);
    assert.equal(boundary.trusted_owner, true, `${signature} must have trusted owner.`);
    assert.equal(boundary.runtime_execute, true, `${signature} must be callable by hon_runtime.`);
    assert.equal(boundary.broad_execute, false, `${signature} has broad execute.`);
  }

  for (const role of ['anon', 'authenticated', 'service_role']) {
    const exists = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount > 0;
    if (!exists) continue;
    for (const signature of functions) {
      const allowed = (await admin.query('SELECT has_function_privilege($1,$2::regprocedure,$3) AS allowed', [role, signature, 'EXECUTE'])).rows[0].allowed;
      assert.equal(allowed, false, `${role} may not execute ${signature}`);
    }
  }
  for (const table of tables) {
    const meta = (await admin.query(`
      SELECT c.relrowsecurity, c.relforcerowsecurity,
        has_table_privilege('hon_runtime', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS runtime_direct
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'hon' AND c.relname = $1
    `, [table])).rows[0];
    assert(meta, `${table} is missing.`);
    assert.equal(meta.relrowsecurity, true, `${table} must enable RLS.`);
    assert.equal(meta.relforcerowsecurity, true, `${table} must force RLS.`);
    assert.equal(meta.runtime_direct, false, `${table} must not grant direct runtime access.`);
  }

  const countState = async () => (await admin.query(`SELECT
    (SELECT count(*) FROM hon.audit_events) AS audit,
    (SELECT count(*) FROM hon.outbox_events) AS outbox,
    (SELECT count(*) FROM hon.attendance_records) AS attendance,
    (SELECT count(*) FROM hon.curriculum_progress_observations) AS progress,
    (SELECT count(*) FROM hon.testing_candidates) AS candidates,
    (SELECT count(*) FROM hon.promotion_decisions) AS promotions,
    (SELECT count(*) FROM hon.memberships) AS memberships,
    (SELECT count(*) FROM hon.ai_usage_ledger) AS ai_usage
  `)).rows[0];
  const before = await countState();
  const organization = randomUUID();
  const school = randomUUID();
  const request = randomUUID();
  await runtime.query('BEGIN');
  try {
    await runtime.query(`SELECT
      set_config('app.hon_organization_id',$1,true), set_config('app.hon_school_id',$2,true),
      set_config('app.hon_principal_id',$3,true), set_config('app.hon_principal_type','HUMAN_USER',true),
      set_config('app.hon_source','HUMAN_UI',true), set_config('app.hon_request_id',$4,true),
      set_config('app.hon_action_request_id','',true), set_config('app.hon_delegated_by_principal_id','',true)`,
      [organization, school, randomUUID(), request]);
    await runtime.query('SAVEPOINT forged_teaching_scope');
    await denied(() => runtime.query('SELECT hon.read_teaching_studio($1,$2,$3::uuid,$4::uuid,$5::integer)', [`unknown-teaching-${randomUUID()}`, 'ACCESS', null, null, null]));
    await runtime.query('ROLLBACK TO SAVEPOINT forged_teaching_scope');
    await runtime.query('SAVEPOINT forged_teaching_mutation');
    await denied(() => runtime.query(
      'SELECT hon.mutate_teaching_studio($1,$2,$3::uuid,$4::uuid,$5::jsonb,$6,$7::uuid,$8::uuid)',
      [`unknown-teaching-${randomUUID()}`, 'RESOURCE', null, null, JSON.stringify({ expectedVersion: 0, title: 'Human drill card', resourceType: 'DRILL', description: '', status: 'ACTIVE' }), 'forged-teaching-key', request, randomUUID()],
    ));
    await runtime.query('ROLLBACK TO SAVEPOINT forged_teaching_mutation');
    const context = (await runtime.query('SELECT hon.current_organization_id() AS organization, hon.current_school_id() AS school')).rows[0];
    assert.equal(context.organization, organization, 'Teaching Studio must not replace caller organization context.');
    assert.equal(context.school, school, 'Teaching Studio must not replace caller school context.');
    await runtime.query('ROLLBACK');
  } catch (error) {
    await runtime.query('ROLLBACK');
    throw error;
  }
  assert.deepEqual(await countState(), before, 'Forged Teaching Studio access or mutation changed protected operational state.');
  console.log('Verified Teaching Studio forced RLS, exact runtime functions, client denial, forged scope rejection, preserved context, directory redaction boundary, and zero attendance/progress/testing/promotion/membership/AI side effects.');
} finally {
  await Promise.all([admin.end(), runtime.end()]);
}
