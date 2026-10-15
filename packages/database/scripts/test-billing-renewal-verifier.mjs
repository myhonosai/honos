import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
export async function verifyRenewalDrift(admin) {
 for (const [key, role] of [['DATABASE_URL','hon_renewal_owner'],['HON_RUNTIME_DATABASE_URL','hon_renewal_runtime']]) {
  const u = new URL(process.env[key] ?? '');
  if (u.hostname !== 'localhost' || u.port !== '5432' || u.pathname !== '/hon_renewal_validation' || u.username !== role) throw new Error('Renewal probes require exact disposable localhost database and roles.');
 }
 const canonical = (await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8')).replaceAll('hon_runtime','hon_renewal_runtime');
 const js = () => execFileSync('node',['scripts/verify-rls.mjs'],{cwd:new URL('../',import.meta.url),env:process.env,stdio:'pipe'});
 const canonicalCheck = () => execFileSync('sudo',['-u','postgres','psql','-d','hon_renewal_validation','-v','ON_ERROR_STOP=1'],{input:canonical,stdio:['pipe','pipe','pipe']});
 js(); canonicalCheck();
 const cases = [
  ['table grant','GRANT SELECT ON hon.membership_renewal_reviews TO hon_renewal_runtime','REVOKE SELECT ON hon.membership_renewal_reviews FROM hon_renewal_runtime'],
  ['column grant','GRANT SELECT(note) ON hon.membership_renewal_versions TO hon_renewal_runtime','REVOKE SELECT(note) ON hon.membership_renewal_versions FROM hon_renewal_runtime'],
  ['PUBLIC execute','GRANT EXECUTE ON FUNCTION hon.mutate_renewal(text,text,uuid,jsonb,text,uuid,uuid) TO PUBLIC','REVOKE EXECUTE ON FUNCTION hon.mutate_renewal(text,text,uuid,jsonb,text,uuid,uuid) FROM PUBLIC'],
  ['private facts execute','GRANT EXECUTE ON FUNCTION hon.renewal_membership_facts(uuid) TO hon_renewal_runtime','REVOKE EXECUTE ON FUNCTION hon.renewal_membership_facts(uuid) FROM hon_renewal_runtime'],
  ['grant option','GRANT EXECUTE ON FUNCTION hon.read_renewals(text,uuid,text,uuid,integer) TO hon_renewal_runtime WITH GRANT OPTION','REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION hon.read_renewals(text,uuid,text,uuid,integer) FROM hon_renewal_runtime'],
  ['search path','ALTER FUNCTION hon.mutate_renewal(text,text,uuid,jsonb,text,uuid,uuid) SET search_path=public,hon','ALTER FUNCTION hon.mutate_renewal(text,text,uuid,jsonb,text,uuid,uuid) SET search_path=pg_catalog,hon'],
  ['definer','ALTER FUNCTION hon.mutate_renewal(text,text,uuid,jsonb,text,uuid,uuid) SECURITY INVOKER','ALTER FUNCTION hon.mutate_renewal(text,text,uuid,jsonb,text,uuid,uuid) SECURITY DEFINER'],
  ['forced RLS','ALTER TABLE hon.membership_renewal_versions NO FORCE ROW LEVEL SECURITY','ALTER TABLE hon.membership_renewal_versions FORCE ROW LEVEL SECURITY'],
  ['permissive policy','CREATE POLICY renewal_probe ON hon.membership_renewal_reviews USING(true)','DROP POLICY renewal_probe ON hon.membership_renewal_reviews'],
  ['immutable trigger','ALTER TABLE hon.membership_renewal_requests DISABLE TRIGGER renewal_requests_immutable','ALTER TABLE hon.membership_renewal_requests ENABLE TRIGGER renewal_requests_immutable'],
  ['root guard','ALTER TABLE hon.membership_renewal_reviews DISABLE TRIGGER renewal_review_insert_guard','ALTER TABLE hon.membership_renewal_reviews ENABLE TRIGGER renewal_review_insert_guard'],
  ['version guard','ALTER TABLE hon.membership_renewal_versions DISABLE TRIGGER renewal_version_insert_guard','ALTER TABLE hon.membership_renewal_versions ENABLE TRIGGER renewal_version_insert_guard'],
 ];
 for (const [name, drift, restore] of cases) {
  await admin.query(drift);
  try { assert.throws(js,`${name}: JS accepted drift`); assert.throws(canonicalCheck,`${name}: canonical accepted drift`); console.log(`Denied renewal verifier drift: ${name}`); }
  finally { await admin.query('ROLLBACK'); await admin.query(restore); }
 }
 for (const table of ['membership_renewal_reviews','membership_renewal_versions','membership_renewal_requests']) {
  assert(Number((await admin.query(`SELECT count(*) n FROM hon.${table}`)).rows[0].n)>0,'Actual seeded rows required for proof');
  const proof=`BEGIN; CREATE ROLE hon_renewal_rls_probe NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; GRANT USAGE,CREATE ON SCHEMA hon TO hon_renewal_rls_probe; ALTER TABLE hon.${table} OWNER TO hon_renewal_rls_probe; SET LOCAL ROLE hon_renewal_rls_probe; DO $$ BEGIN IF (SELECT count(*) FROM hon.${table})<>0 THEN RAISE EXCEPTION 'RLS_LEAK'; END IF; BEGIN SET LOCAL row_security=off; PERFORM 1 FROM hon.${table}; RAISE EXCEPTION 'RLS_OFF_LEAK'; EXCEPTION WHEN insufficient_privilege THEN NULL; END; END $$; RESET ROLE; ROLLBACK;`;
  execFileSync('sudo',['-u','postgres','psql','-d','hon_renewal_validation','-v','ON_ERROR_STOP=1'],{input:proof,stdio:['pipe','pipe','pipe']});
 }
 js(); canonicalCheck(); console.log('Renewal canonical/JS drift and actual-row non-bypass owner FORCE-RLS passed.');
}
