import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
export async function verifyFollowUpDrift(admin) {
 for (const [key,role] of [['DATABASE_URL','hon_followup_owner'],['HON_RUNTIME_DATABASE_URL','hon_followup_runtime']]) { const u=new URL(process.env[key]??''); if(u.hostname!=='localhost'||u.port!=='5432'||u.pathname!=='/hon_followup_validation'||u.username!==role) throw new Error('Verifier probes require exact disposable localhost followup database.'); }
 const canonical=(await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8')).replaceAll('hon_runtime','hon_followup_runtime');
 const js=()=>execFileSync('node',['scripts/verify-rls.mjs'],{cwd:new URL('../',import.meta.url),env:process.env,stdio:'pipe'});
 const canonicalCheck=()=>execFileSync('sudo',['-u','postgres','psql','-d','hon_followup_validation','-v','ON_ERROR_STOP=1'],{input:canonical,stdio:['pipe','pipe','pipe']});
 js(); canonicalCheck();
 const cases=[
  ['table grant','GRANT SELECT ON hon.crm_follow_ups TO hon_followup_runtime','REVOKE SELECT ON hon.crm_follow_ups FROM hon_followup_runtime'],
  ['column grant','GRANT SELECT(note) ON hon.crm_follow_up_versions TO hon_followup_runtime','REVOKE SELECT(note) ON hon.crm_follow_up_versions FROM hon_followup_runtime'],
  ['PUBLIC execute','GRANT EXECUTE ON FUNCTION hon.mutate_follow_up(text,text,uuid,jsonb,text,uuid,uuid) TO PUBLIC','REVOKE EXECUTE ON FUNCTION hon.mutate_follow_up(text,text,uuid,jsonb,text,uuid,uuid) FROM PUBLIC'],
  ['private projection execute','GRANT EXECUTE ON FUNCTION hon.follow_up_summary(uuid,integer) TO hon_followup_runtime','REVOKE EXECUTE ON FUNCTION hon.follow_up_summary(uuid,integer) FROM hon_followup_runtime'],
  ['grant option','GRANT EXECUTE ON FUNCTION hon.read_follow_ups(text,uuid,text,text,uuid) TO hon_followup_runtime WITH GRANT OPTION','REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION hon.read_follow_ups(text,uuid,text,text,uuid) FROM hon_followup_runtime'],
  ['search path','ALTER FUNCTION hon.mutate_follow_up(text,text,uuid,jsonb,text,uuid,uuid) SET search_path=public,hon','ALTER FUNCTION hon.mutate_follow_up(text,text,uuid,jsonb,text,uuid,uuid) SET search_path=pg_catalog,hon'],
  ['definer','ALTER FUNCTION hon.mutate_follow_up(text,text,uuid,jsonb,text,uuid,uuid) SECURITY INVOKER','ALTER FUNCTION hon.mutate_follow_up(text,text,uuid,jsonb,text,uuid,uuid) SECURITY DEFINER'],
  ['forced RLS','ALTER TABLE hon.crm_follow_up_versions NO FORCE ROW LEVEL SECURITY','ALTER TABLE hon.crm_follow_up_versions FORCE ROW LEVEL SECURITY'],
  ['permissive policy','CREATE POLICY followup_probe ON hon.crm_follow_ups USING(true)','DROP POLICY followup_probe ON hon.crm_follow_ups'],
  ['immutable trigger','ALTER TABLE hon.crm_follow_up_requests DISABLE TRIGGER follow_up_requests_immutable','ALTER TABLE hon.crm_follow_up_requests ENABLE TRIGGER follow_up_requests_immutable'],
  ['insert trigger','ALTER TABLE hon.crm_follow_ups DISABLE TRIGGER follow_up_insert_guard','ALTER TABLE hon.crm_follow_ups ENABLE TRIGGER follow_up_insert_guard'],
  ['version trigger','ALTER TABLE hon.crm_follow_up_versions DISABLE TRIGGER follow_up_version_insert_guard','ALTER TABLE hon.crm_follow_up_versions ENABLE TRIGGER follow_up_version_insert_guard'],
 ];
 for(const [name,drift,restore] of cases) { await admin.query(drift); try { assert.throws(js,`${name}: JS accepted drift`); assert.throws(canonicalCheck,`${name}: canonical accepted drift`); console.log(`Denied followup verifier drift: ${name}`); } finally { await admin.query('ROLLBACK'); await admin.query(restore); } }
 for(const table of ['crm_follow_ups','crm_follow_up_versions','crm_follow_up_requests']) {
  assert(Number((await admin.query(`SELECT count(*) n FROM hon.${table}`)).rows[0].n)>0,'Seed actual records before proof');
  const proof=`BEGIN; CREATE ROLE hon_followup_rls_probe NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; GRANT USAGE,CREATE ON SCHEMA hon TO hon_followup_rls_probe; ALTER TABLE hon.${table} OWNER TO hon_followup_rls_probe; SET LOCAL ROLE hon_followup_rls_probe; SELECT set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_source','HUMAN_UI',true); DO $$ BEGIN IF (SELECT count(*) FROM hon.${table})<>0 THEN RAISE EXCEPTION 'RLS_LEAK'; END IF; BEGIN SET LOCAL row_security=off; PERFORM 1 FROM hon.${table}; RAISE EXCEPTION 'RLS_OFF_LEAK'; EXCEPTION WHEN insufficient_privilege THEN NULL; END; END $$; RESET ROLE; ROLLBACK;`;
  execFileSync('sudo',['-u','postgres','psql','-d','hon_followup_validation','-v','ON_ERROR_STOP=1'],{input:proof,stdio:['pipe','pipe','pipe']});
 }
 js(); canonicalCheck(); console.log('CRM follow-up canonical/JS drift and actual-row non-bypass owner FORCE-RLS passed.');
}
