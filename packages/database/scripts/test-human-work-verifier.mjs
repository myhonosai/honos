import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
export async function verifyHumanWorkDrift(admin) {
 for(const [key,role]of [['DATABASE_URL','hon_work_owner'],['HON_RUNTIME_DATABASE_URL','hon_work_runtime']]){const u=new URL(process.env[key]??'');if(u.hostname!=='localhost'||u.port!=='5432'||u.pathname!=='/hon_work_validation'||u.username!==role)throw new Error('Verifier probes require exact disposable localhost work database.');}
 const canonical=(await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8')).replaceAll('hon_runtime','hon_work_runtime');
 const js=()=>execFileSync('node',['scripts/verify-rls.mjs'],{cwd:new URL('../',import.meta.url),env:process.env,stdio:'pipe'});
 const sql=()=>execFileSync('sudo',['-u','postgres','psql','-d','hon_work_validation','-v','ON_ERROR_STOP=1'],{input:canonical,stdio:['pipe','pipe','pipe']});
 js();sql();
 const cases=[
  ['table grant','GRANT SELECT ON hon.work_items TO hon_work_runtime','REVOKE SELECT ON hon.work_items FROM hon_work_runtime'],
  ['private column','GRANT SELECT(description) ON hon.work_items TO hon_work_runtime','REVOKE SELECT(description) ON hon.work_items FROM hon_work_runtime'],
  ['raw legacy column','GRANT SELECT(payload) ON hon.work_items TO hon_work_runtime','REVOKE SELECT(payload) ON hon.work_items FROM hon_work_runtime'],
  ['history grant','GRANT SELECT ON hon.human_work_history TO hon_work_runtime','REVOKE SELECT ON hon.human_work_history FROM hon_work_runtime'],
  ['PUBLIC execute','GRANT EXECUTE ON FUNCTION hon.mutate_human_work(text,text,uuid,jsonb,text,uuid,uuid) TO PUBLIC','REVOKE EXECUTE ON FUNCTION hon.mutate_human_work(text,text,uuid,jsonb,text,uuid,uuid) FROM PUBLIC'],
  ['helper execute','GRANT EXECUTE ON FUNCTION hon.human_work_snapshot(uuid,integer,uuid,integer) TO hon_work_runtime','REVOKE EXECUTE ON FUNCTION hon.human_work_snapshot(uuid,integer,uuid,integer) FROM hon_work_runtime'],
  ['grant option','GRANT EXECUTE ON FUNCTION hon.read_human_work(text,uuid,text,text,uuid,integer) TO hon_work_runtime WITH GRANT OPTION','REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION hon.read_human_work(text,uuid,text,text,uuid,integer) FROM hon_work_runtime'],
  ['search path','ALTER FUNCTION hon.mutate_human_work(text,text,uuid,jsonb,text,uuid,uuid) SET search_path=public,hon','ALTER FUNCTION hon.mutate_human_work(text,text,uuid,jsonb,text,uuid,uuid) SET search_path=pg_catalog,hon'],
  ['definer','ALTER FUNCTION hon.mutate_human_work(text,text,uuid,jsonb,text,uuid,uuid) SECURITY INVOKER','ALTER FUNCTION hon.mutate_human_work(text,text,uuid,jsonb,text,uuid,uuid) SECURITY DEFINER'],
  ['forced RLS','ALTER TABLE hon.work_items NO FORCE ROW LEVEL SECURITY','ALTER TABLE hon.work_items FORCE ROW LEVEL SECURITY'],
  ['permissive policy','CREATE POLICY human_work_probe ON hon.work_items USING(true)','DROP POLICY human_work_probe ON hon.work_items'],
  ['history immutability','ALTER TABLE hon.human_work_history DISABLE TRIGGER human_work_history_immutable','ALTER TABLE hon.human_work_history ENABLE TRIGGER human_work_history_immutable'],
  ['receipt immutability','ALTER TABLE hon.human_work_requests DISABLE TRIGGER human_work_requests_immutable','ALTER TABLE hon.human_work_requests ENABLE TRIGGER human_work_requests_immutable'],
  ['state guard','ALTER TABLE hon.work_items DISABLE TRIGGER human_work_row_guard','ALTER TABLE hon.work_items ENABLE TRIGGER human_work_row_guard'],
 ];
 for(const [name,apply,restore]of cases){await admin.query(apply);try{assert.throws(js,undefined,`JS must reject ${name}`);assert.throws(sql,undefined,`canonical SQL must reject ${name}`);}finally{await admin.query(restore);}}
 for(const table of ['work_items','human_work_history','human_work_requests']){
  assert(Number((await admin.query(`SELECT count(*) n FROM hon.${table}`)).rows[0].n)>0,'Use actual records for FORCE-RLS proof');
  const proof=`BEGIN; CREATE ROLE hon_work_rls_probe NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; GRANT USAGE,CREATE ON SCHEMA hon TO hon_work_rls_probe; ALTER TABLE hon.${table} OWNER TO hon_work_rls_probe; SET LOCAL ROLE hon_work_rls_probe; DO $$ BEGIN IF (SELECT count(*) FROM hon.${table})<>0 THEN RAISE EXCEPTION 'RLS_LEAK'; END IF; BEGIN SET LOCAL row_security=off; PERFORM 1 FROM hon.${table}; RAISE EXCEPTION 'RLS_OFF_LEAK'; EXCEPTION WHEN insufficient_privilege THEN NULL; END; END $$; RESET ROLE; ROLLBACK;`;
  execFileSync('sudo',['-u','postgres','psql','-d','hon_work_validation','-v','ON_ERROR_STOP=1'],{input:proof,stdio:['pipe','pipe','pipe']});
 }
 js();sql();console.log('Human work canonical/JS verifier: 14 deliberate drift denials and actual-row non-bypass-owner FORCE-RLS passed.');
}
