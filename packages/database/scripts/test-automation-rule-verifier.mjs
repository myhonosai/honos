import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
export async function verifyAutomationRuleDrift(admin) {
 for (const [key,role] of [['DATABASE_URL','hon_automation_owner'],['HON_RUNTIME_DATABASE_URL','hon_automation_runtime']]) { const u=new URL(process.env[key]??''); if(u.hostname!=='localhost'||u.port!=='5432'||u.pathname!=='/hon_automation_validation'||u.username!==role) throw new Error('Verifier probes require exact disposable localhost automation database.'); }
 const canonical=(await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8')).replaceAll('hon_runtime','hon_automation_runtime');
 const js=()=>execFileSync('node',['scripts/verify-rls.mjs'],{cwd:new URL('../',import.meta.url),env:process.env,stdio:'pipe'});
 const canonicalCheck=()=>execFileSync('sudo',['-u','postgres','psql','-d','hon_automation_validation','-v','ON_ERROR_STOP=1'],{input:canonical,stdio:['pipe','pipe','pipe']});
 js(); canonicalCheck();
 const cases=[
  ['table grant','GRANT SELECT ON hon.automation_rules TO hon_automation_runtime','REVOKE SELECT ON hon.automation_rules FROM hon_automation_runtime'],
  ['column grant','GRANT SELECT(payload) ON hon.automation_rule_versions TO hon_automation_runtime','REVOKE SELECT(payload) ON hon.automation_rule_versions FROM hon_automation_runtime'],
  ['PUBLIC execute','GRANT EXECUTE ON FUNCTION hon.dry_run_automation_rule(text,uuid,jsonb) TO PUBLIC','REVOKE EXECUTE ON FUNCTION hon.dry_run_automation_rule(text,uuid,jsonb) FROM PUBLIC'],
  ['private planner execute','GRANT EXECUTE ON FUNCTION hon.plan_automation_descriptor(jsonb,jsonb) TO hon_automation_runtime','REVOKE EXECUTE ON FUNCTION hon.plan_automation_descriptor(jsonb,jsonb) FROM hon_automation_runtime'],
  ['grant option','GRANT EXECUTE ON FUNCTION hon.read_automation_rules(text,uuid,integer) TO hon_automation_runtime WITH GRANT OPTION','REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION hon.read_automation_rules(text,uuid,integer) FROM hon_automation_runtime'],
  ['search path','ALTER FUNCTION hon.dry_run_automation_rule(text,uuid,jsonb) SET search_path=public,hon','ALTER FUNCTION hon.dry_run_automation_rule(text,uuid,jsonb) SET search_path=pg_catalog,hon'],
  ['definer','ALTER FUNCTION hon.dry_run_automation_rule(text,uuid,jsonb) SECURITY INVOKER','ALTER FUNCTION hon.dry_run_automation_rule(text,uuid,jsonb) SECURITY DEFINER'],
  ['forced RLS','ALTER TABLE hon.automation_rule_versions NO FORCE ROW LEVEL SECURITY','ALTER TABLE hon.automation_rule_versions FORCE ROW LEVEL SECURITY'],
  ['permissive policy','CREATE POLICY automation_probe ON hon.automation_rules USING(true)','DROP POLICY automation_probe ON hon.automation_rules'],
  ['immutable trigger','ALTER TABLE hon.automation_rule_requests DISABLE TRIGGER automation_requests_immutable','ALTER TABLE hon.automation_rule_requests ENABLE TRIGGER automation_requests_immutable'],
  ['insert trigger','ALTER TABLE hon.automation_rules DISABLE TRIGGER automation_rule_insert_guard','ALTER TABLE hon.automation_rules ENABLE TRIGGER automation_rule_insert_guard'],
  ['version trigger','ALTER TABLE hon.automation_rule_versions DISABLE TRIGGER automation_version_insert_guard','ALTER TABLE hon.automation_rule_versions ENABLE TRIGGER automation_version_insert_guard'],
 ];
 for(const [name,drift,restore] of cases) { await admin.query(drift); try { assert.throws(js,`${name}: JS accepted drift`); assert.throws(canonicalCheck,`${name}: canonical accepted drift`); console.log(`Denied automation verifier drift: ${name}`); } finally { await admin.query('ROLLBACK'); await admin.query(restore); } }
 for(const table of ['automation_rules','automation_rule_versions','automation_rule_requests']) {
  assert(Number((await admin.query(`SELECT count(*) n FROM hon.${table}`)).rows[0].n)>0,'Seed actual records before proof');
  const proof=`BEGIN; CREATE ROLE hon_automation_rls_probe NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; GRANT USAGE,CREATE ON SCHEMA hon TO hon_automation_rls_probe; ALTER TABLE hon.${table} OWNER TO hon_automation_rls_probe; SET LOCAL ROLE hon_automation_rls_probe; SELECT set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_source','HUMAN_UI',true); DO $$ BEGIN IF (SELECT count(*) FROM hon.${table})<>0 THEN RAISE EXCEPTION 'RLS_LEAK'; END IF; BEGIN SET LOCAL row_security=off; PERFORM 1 FROM hon.${table}; RAISE EXCEPTION 'RLS_OFF_LEAK'; EXCEPTION WHEN insufficient_privilege THEN NULL; END; END $$; RESET ROLE; ROLLBACK;`;
  execFileSync('sudo',['-u','postgres','psql','-d','hon_automation_validation','-v','ON_ERROR_STOP=1'],{input:proof,stdio:['pipe','pipe','pipe']});
 }
 js(); canonicalCheck(); console.log('Automation canonical/JS drift and actual-row non-bypass owner FORCE-RLS passed.');
}
