import assert from 'node:assert/strict';

export const curriculumEnrollmentPreparationReadTables = ['people', 'student_profiles', 'curricula', 'curriculum_ranks'];
const helper = 'hon.require_staff_curriculum_enrollment_preparation_actor(text)';
const projection = 'hon.read_staff_curriculum_enrollment_preparation(text,uuid)';

export async function verifyCurriculumEnrollmentPreparationSecurity(admin, runtimeRole) {
  for (const table of curriculumEnrollmentPreparationReadTables) {
    const relation = (await admin.query(`SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE oid=$1::regclass`, [`hon.${table}`])).rows[0];
    assert.deepEqual(relation, { enabled: true, forced: true }, `forced RLS ${table}`);
    const publicPrivilege = (await admin.query(`SELECT has_table_privilege('public',$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed`, [`hon.${table}`])).rows[0];
    assert.equal(publicPrivilege.allowed, false, `PUBLIC has no source-table privilege ${table}`);
  }
  for (const signature of [helper, projection]) {
    const row = (await admin.query(`SELECT p.prosecdef AS definer, p.proconfig AS config,
      (owner.rolsuper OR owner.rolbypassrls) AS trusted,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) AS acl
        WHERE acl.grantee NOT IN (p.proowner,(SELECT oid FROM pg_roles WHERE rolname=$2))) AS broad
      FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=$1::regprocedure`, [signature, runtimeRole])).rows[0];
    assert.equal(row.definer, true, `${signature} SECURITY DEFINER`);
    assert.equal(row.trusted, true, `${signature} trusted owner`);
    assert.deepEqual(row.config, ['search_path=pg_catalog, hon'], `${signature} fixed search_path`);
    assert.equal(row.broad, false, `${signature} no broad ACL`);
  }
  assert.equal((await admin.query(`SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed`, [runtimeRole, helper])).rows[0].allowed, false, 'helper must remain private');
  assert.equal((await admin.query(`SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed`, [runtimeRole, projection])).rows[0].allowed, true, 'runtime has only projection execute');
  assert.equal((await admin.query(`SELECT has_function_privilege('public',$1,'EXECUTE') AS allowed`, [helper])).rows[0].allowed, false, 'PUBLIC helper execute denied');
  assert.equal((await admin.query(`SELECT has_function_privilege('public',$1,'EXECUTE') AS allowed`, [projection])).rows[0].allowed, false, 'PUBLIC projection execute denied');
}
