import pg from 'pg';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
if (process.env.HON_CAMPAIGN_VALIDATION_TARGET !== 'postgresql://localhost:5432/hon_campaign_validation') throw new Error('Explicit disposable validation target required.');
for (const [key, role] of [['DATABASE_URL','hon_campaign_owner'],['HON_RUNTIME_DATABASE_URL','hon_campaign_runtime']]) {
  const url = new URL(process.env[key] ?? 'https://invalid');
  if (url.hostname !== 'localhost' || url.port !== '5432' || url.pathname !== '/hon_campaign_validation' || url.username !== role) throw new Error('Only exact guarded disposable localhost roles/database allowed.');
}
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });
const canonical = (await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8')).replaceAll('hon_runtime','hon_campaign_runtime');
const verify = () => spawnSync(process.execPath,[new URL('./verify-rls.mjs',import.meta.url).pathname],{env:process.env,encoding:'utf8'});
const healthy = async () => { const result = verify(); assert.equal(result.status,0,result.stderr); assert.doesNotMatch(result.stderr,/DeprecationWarning|deprecated/i); await admin.query(canonical); };
await admin.connect();
try {
  await healthy();
  for (const [name,apply,restore] of [
    ['PUBLIC ingress EXECUTE','GRANT EXECUTE ON FUNCTION hon.submit_public_form(text,jsonb,text) TO PUBLIC','REVOKE EXECUTE ON FUNCTION hon.submit_public_form(text,jsonb,text) FROM PUBLIC'],
    ['runtime private CRM helper','GRANT EXECUTE ON FUNCTION hon.create_public_form_lead(uuid,uuid,jsonb,uuid) TO hon_campaign_runtime','REVOKE EXECUTE ON FUNCTION hon.create_public_form_lead(uuid,uuid,jsonb,uuid) FROM hon_campaign_runtime'],
    ['runtime ingress grant option','GRANT EXECUTE ON FUNCTION hon.read_published_form(text) TO hon_campaign_runtime WITH GRANT OPTION','REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION hon.read_published_form(text) FROM hon_campaign_runtime'],
    ['runtime private column','GRANT SELECT(hash_secret) ON hon.public_lead_forms TO hon_campaign_runtime','REVOKE SELECT(hash_secret) ON hon.public_lead_forms FROM hon_campaign_runtime'],
    ['PUBLIC receipts SELECT','GRANT SELECT ON hon.public_lead_form_receipts TO PUBLIC','REVOKE SELECT ON hon.public_lead_form_receipts FROM PUBLIC'],
    ['runtime directory column','GRANT SELECT(email) ON hon.users TO hon_campaign_runtime','REVOKE SELECT(email) ON hon.users FROM hon_campaign_runtime'],
    ['runtime HQ table','GRANT SELECT ON hon.hq_operator_grants TO hon_campaign_runtime','REVOKE SELECT ON hon.hq_operator_grants FROM hon_campaign_runtime'],
    ['disabled private RLS','ALTER TABLE hon.public_lead_form_rates DISABLE ROW LEVEL SECURITY','ALTER TABLE hon.public_lead_form_rates ENABLE ROW LEVEL SECURITY'],
    ['unforced private RLS','ALTER TABLE hon.public_lead_form_receipts NO FORCE ROW LEVEL SECURITY','ALTER TABLE hon.public_lead_form_receipts FORCE ROW LEVEL SECURITY'],
    ['accidental permissive policy','CREATE POLICY forms_negative_policy ON hon.public_lead_form_requests USING(true)','DROP POLICY forms_negative_policy ON hon.public_lead_form_requests'],
    ['unsafe ingress search path','ALTER FUNCTION hon.submit_public_form(text,jsonb,text) SET search_path=public,hon','ALTER FUNCTION hon.submit_public_form(text,jsonb,text) SET search_path=pg_catalog,hon'],
    ['disabled attribution guard','ALTER TABLE hon.crm_leads DISABLE TRIGGER lead_source_snapshot','ALTER TABLE hon.crm_leads ENABLE TRIGGER lead_source_snapshot'],
    ['disabled form identity guard','ALTER TABLE hon.public_lead_forms DISABLE TRIGGER public_form_identity_guard','ALTER TABLE hon.public_lead_forms ENABLE TRIGGER public_form_identity_guard'],
  ]) {
    await admin.query(apply);
    try {
      const result = verify(); assert.notEqual(result.status,0,`${name}: JS accepted drift`);
      await assert.rejects(() => admin.query(canonical), `${name}: canonical accepted drift`);
      console.log(`Denied form verifier drift: ${name}`);
    } finally { await admin.query('ROLLBACK'); await admin.query(restore); }
  }
  // Temporarily make a real private table's owner non-bypass. With SELECT granted,
  // FORCE RLS denies even that owner; row_security=off must error, not leak rows.
  const tables = ['public_lead_forms','public_lead_form_versions','public_lead_form_requests','public_lead_form_receipts','public_lead_form_rates'];
  assert(Number((await admin.query('SELECT count(*) n FROM hon.public_lead_forms')).rows[0].n) > 0, 'Integration must seed real rows before RLS proof.');
  for (const table of tables) {
    // Local peer admin creates an ephemeral NOLOGIN owner inside one rollback-only
    // transaction. The ordinary disposable owner remains NOCREATEROLE throughout.
    const proof = `BEGIN;
      CREATE ROLE hon_forms_rls_probe NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
      GRANT USAGE,CREATE ON SCHEMA hon TO hon_forms_rls_probe;
      ALTER TABLE hon.${table} OWNER TO hon_forms_rls_probe;
      SET LOCAL ROLE hon_forms_rls_probe;
      DO $$ DECLARE n bigint; BEGIN
        SELECT count(*) INTO n FROM hon.${table};
        IF n<>0 THEN RAISE EXCEPTION 'Forced RLS leaked owner rows'; END IF;
        PERFORM set_config('row_security','off',true);
        BEGIN PERFORM 1 FROM hon.${table}; RAISE EXCEPTION 'row_security off bypassed FORCE RLS';
        EXCEPTION WHEN insufficient_privilege THEN NULL; END;
      END $$;
      ROLLBACK;`;
    const result = spawnSync('sudo',['-u','postgres','psql','-X','-v','ON_ERROR_STOP=1','-d','hon_campaign_validation','-c',proof],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    console.log(`Proved forced deny-all RLS against non-bypass table owner: ${table}`);
  }
  await healthy(); await admin.query(canonical);
  console.log('Fresh canonical alias 011 and JS verifier passed; thirteen deliberate ACL/RLS/path/trigger drift probes denied and restored; five behavioral forced-RLS owner proofs passed.');
} finally { await admin.query('ROLLBACK'); await admin.end(); }
