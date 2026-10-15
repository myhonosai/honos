import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
export async function verifyStaffAvailabilityDrift(admin) {
  for (const [key,role] of [['DATABASE_URL','hon_staff_owner'],['HON_RUNTIME_DATABASE_URL','hon_staff_runtime']]) {
    const u=new URL(process.env[key]??'');if(u.hostname!=='localhost'||u.port!=='5432'||u.pathname!=='/hon_staff_validation'||u.username!==role)throw new Error('Verifier probes require exact disposable localhost staff database.');
  }
  const canonical=(await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8')).replaceAll('hon_runtime','hon_staff_runtime');
  const js=()=>execFileSync('node',['scripts/verify-rls.mjs'],{cwd:new URL('../',import.meta.url),env:process.env,stdio:'pipe'});
  const canonicalCheck=()=>execFileSync('sudo',['-u','postgres','psql','-d','hon_staff_validation','-v','ON_ERROR_STOP=1'],{input:canonical,stdio:['pipe','pipe','pipe']});
  js();canonicalCheck();
  const cases=[
    ['table grant','GRANT SELECT ON hon.staff_profiles TO hon_staff_runtime','REVOKE SELECT ON hon.staff_profiles FROM hon_staff_runtime'],
    ['column grant','GRANT SELECT(payload) ON hon.staff_planning_revisions TO hon_staff_runtime','REVOKE SELECT(payload) ON hon.staff_planning_revisions FROM hon_staff_runtime'],
    ['PUBLIC execute','GRANT EXECUTE ON FUNCTION hon.read_staff_availability(text,uuid,text,integer) TO PUBLIC','REVOKE EXECUTE ON FUNCTION hon.read_staff_availability(text,uuid,text,integer) FROM PUBLIC'],
    ['private helper execute','GRANT EXECUTE ON FUNCTION hon.staff_member_eligible(uuid,uuid,uuid) TO hon_staff_runtime','REVOKE EXECUTE ON FUNCTION hon.staff_member_eligible(uuid,uuid,uuid) FROM hon_staff_runtime'],
    ['grant option','GRANT EXECUTE ON FUNCTION hon.read_staff_availability(text,uuid,text,integer) TO hon_staff_runtime WITH GRANT OPTION','REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION hon.read_staff_availability(text,uuid,text,integer) FROM hon_staff_runtime'],
    ['search path','ALTER FUNCTION hon.read_staff_availability(text,uuid,text,integer) SET search_path=public,hon','ALTER FUNCTION hon.read_staff_availability(text,uuid,text,integer) SET search_path=pg_catalog,hon'],
    ['definer','ALTER FUNCTION hon.read_staff_availability(text,uuid,text,integer) SECURITY INVOKER','ALTER FUNCTION hon.read_staff_availability(text,uuid,text,integer) SECURITY DEFINER'],
    ['forced RLS','ALTER TABLE hon.staff_planning_revisions NO FORCE ROW LEVEL SECURITY','ALTER TABLE hon.staff_planning_revisions FORCE ROW LEVEL SECURITY'],
    ['permissive policy','CREATE POLICY staff_probe ON hon.staff_profiles USING(true)','DROP POLICY staff_probe ON hon.staff_profiles'],
    ['immutable trigger','ALTER TABLE hon.staff_planning_requests DISABLE TRIGGER staff_requests_immutable','ALTER TABLE hon.staff_planning_requests ENABLE TRIGGER staff_requests_immutable'],
    ['eligibility trigger','ALTER TABLE hon.staff_profiles DISABLE TRIGGER staff_profile_insert_guard','ALTER TABLE hon.staff_profiles ENABLE TRIGGER staff_profile_insert_guard'],
    ['version trigger','ALTER TABLE hon.staff_planning_revisions DISABLE TRIGGER staff_revision_insert_guard','ALTER TABLE hon.staff_planning_revisions ENABLE TRIGGER staff_revision_insert_guard'],
  ];
  for(const [name,drift,restore] of cases){await admin.query(drift);try{assert.throws(js,`${name}: JS verifier accepted drift`);assert.throws(canonicalCheck,`${name}: canonical accepted drift`);console.log(`Denied staff verifier drift: ${name}`);}finally{await admin.query('ROLLBACK');await admin.query(restore);}}
  // Actual rows must remain hidden to a non-bypass TABLE OWNER, even with forged
  // valid school context; row_security=off must raise, never leak. Peer-admin only,
  // rollback-only probe cannot grant runtime bypass or touch the remote database.
  for(const table of ['staff_profiles','staff_planning_revisions','staff_planning_requests']){
    assert(Number((await admin.query(`SELECT count(*) n FROM hon.${table}`)).rows[0].n)>0,'Seed real records before RLS proof.');
    const proof=`BEGIN; CREATE ROLE hon_staff_rls_probe NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; GRANT USAGE,CREATE ON SCHEMA hon TO hon_staff_rls_probe; ALTER TABLE hon.${table} OWNER TO hon_staff_rls_probe; SET LOCAL ROLE hon_staff_rls_probe; SELECT set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_source','HUMAN_UI',true); DO $$ BEGIN IF (SELECT count(*) FROM hon.${table})<>0 THEN RAISE EXCEPTION 'RLS_LEAK'; END IF; BEGIN SET LOCAL row_security=off; PERFORM 1 FROM hon.${table}; RAISE EXCEPTION 'RLS_OFF_LEAK'; EXCEPTION WHEN insufficient_privilege THEN NULL; END; END $$; RESET ROLE; ROLLBACK;`;
    execFileSync('sudo',['-u','postgres','psql','-d','hon_staff_validation','-v','ON_ERROR_STOP=1'],{input:proof,stdio:['pipe','pipe','pipe']});
  }
  js();canonicalCheck();
  console.log('Canonical/JS staff drift verifiers and actual-row non-bypass owner FORCE-RLS proofs passed.');
}
