import pg from 'pg';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for (const key of ['DATABASE_URL','HON_RUNTIME_DATABASE_URL']) {
  if (!process.env[key]) throw new Error('Both explicit disposable local URLs required.');
  const u=new URL(process.env[key]);
  if(u.hostname!=='localhost'||u.pathname!=='/hon_revenue_validation') throw new Error('Only disposable localhost/hon_revenue_validation allowed.');
}
const runtimeRole=new URL(process.env.HON_RUNTIME_DATABASE_URL).username;
if(!['hon_runtime','hon_revenue_runtime'].includes(runtimeRole)) throw new Error('Known local restricted runtime role required.');
const admin=new pg.Client({connectionString:process.env.DATABASE_URL});
const canonical=(await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8')).replaceAll('hon_runtime',runtimeRole);
const verify=()=>spawnSync(process.execPath,[new URL('./verify-rls.mjs',import.meta.url).pathname],{env:process.env,encoding:'utf8'});
await admin.connect();
try {
  assert.equal(verify().status,0,'Fresh database JS verifier must pass.');
  await admin.query(canonical);
  for(const [name,apply,restore] of [
    ['PUBLIC command EXECUTE','GRANT EXECUTE ON FUNCTION hon.save_revenue_plan(text,uuid,jsonb,text,uuid,uuid) TO PUBLIC','REVOKE EXECUTE ON FUNCTION hon.save_revenue_plan(text,uuid,jsonb,text,uuid,uuid) FROM PUBLIC'],
    ['runtime helper EXECUTE',`GRANT EXECUTE ON FUNCTION hon.revenue_plan_snapshot(uuid) TO ${runtimeRole}`,`REVOKE EXECUTE ON FUNCTION hon.revenue_plan_snapshot(uuid) FROM ${runtimeRole}`],
    ['runtime command grant option',`GRANT EXECUTE ON FUNCTION hon.read_revenue_plan(text,text,uuid,integer) TO ${runtimeRole} WITH GRANT OPTION`,`REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION hon.read_revenue_plan(text,text,uuid,integer) FROM ${runtimeRole}`],
    ['runtime private column SELECT',`GRANT SELECT(input) ON hon.revenue_plans TO ${runtimeRole}`,`REVOKE SELECT(input) ON hon.revenue_plans FROM ${runtimeRole}`],
    ['PUBLIC private table SELECT','GRANT SELECT ON hon.revenue_plan_versions TO PUBLIC','REVOKE SELECT ON hon.revenue_plan_versions FROM PUBLIC'],
    ['unforced private RLS','ALTER TABLE hon.revenue_plan_requests NO FORCE ROW LEVEL SECURITY','ALTER TABLE hon.revenue_plan_requests FORCE ROW LEVEL SECURITY'],
    ['accidental private RLS policy','CREATE POLICY revenue_negative_policy ON hon.revenue_plan_requests USING(true)','DROP POLICY revenue_negative_policy ON hon.revenue_plan_requests'],
  ]) {
    await admin.query(apply);
    try {
      const probe=verify();assert.notEqual(probe.status,0,`${name}: JS verifier accepted unsafe drift`);assert.match(probe.stderr,/revenue|Revenue|RLS verification failed/);
      await assert.rejects(()=>admin.query(canonical),/Unsafe revenue|Forbidden runtime/);
      console.log(`Denied unsafe verifier drift: ${name}`);
    } finally {await admin.query('ROLLBACK');await admin.query(restore);}
  }
  const final=verify();assert.equal(final.status,0,final.stderr);await admin.query(canonical);
  console.log('Verified canonical 011 SQL, owner-only private ACL/RLS, exact two runtime functions and seven negative JS/SQL verifier probes; restored clean local posture.');
} finally {await admin.query('ROLLBACK');await admin.end();}
