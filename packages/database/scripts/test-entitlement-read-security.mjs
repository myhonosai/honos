import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

// This focused suite must never run against a provider or shared/remote database.
// Prepare a disposable loopback-only cluster and apply migrations + canonical
// runtime grants first; the suite never creates roles or changes credentials.
const urls = ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL'].map((key) => {
  const url = new URL(process.env[key] ?? '');
  if (url.protocol !== 'postgresql:' || url.hostname !== 'localhost' || url.port !== '55432'
    || url.pathname !== '/hon_entitlement_validation'
    || url.username !== (key === 'DATABASE_URL' ? 'postgres' : 'hon_runtime')) {
    throw new Error('Entitlement security tests require the exact disposable localhost:55432 aliases.');
  }
  return url.toString();
});
const owner = new pg.Client({ connectionString: urls[0], ssl: false });
const runtime = new pg.Client({ connectionString: urls[1], ssl: false });
const ids = [randomUUID(), randomUUID()];
const canonical = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
const block = canonical.split('-- Current organization entitlement exact verification:')[1]?.split('-- End current organization entitlement exact verification.')[0];
if (!block) throw new Error('Missing canonical entitlement verifier.');
const verification = 'DO $$' + block.split('DO $$')[1];
const readTier = () => runtime.query('SELECT * FROM hon.read_current_organization_entitlement()');
await owner.connect();
try {
  const marker = (await owner.query("SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0].marker;
  assert.equal(marker, 'HON disposable entitlement boundary validation', 'Unmarked databases are refused before any fixture write');
  await runtime.connect();
  try {
    await owner.query(verification);
    await owner.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Entitlement fixture one','Entitlement fixture one'),($2,'Entitlement fixture two','Entitlement fixture two')", ids);
    await owner.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'ESSENTIAL','ACTIVE',now()-interval '1 day'),($2,'COMPLETE','ACTIVE',now()-interval '1 day')", ids);
    assert.deepEqual((await readTier()).rows, [], 'No context gives no entitlement row');
    await assert.rejects(() => runtime.query('SELECT tier FROM hon.organization_entitlements'), (error) => error.code === '42501');
    await runtime.query('BEGIN');
    await runtime.query("SELECT set_config('app.hon_organization_id',$1,true)", [ids[0]]);
    assert.deepEqual((await readTier()).rows, [{ tier: 'ESSENTIAL' }], 'Only the current organization tier crosses the boundary');
    for (const sql of [
      'SELECT * FROM hon.organization_entitlements',
      'SELECT tier FROM hon.organization_entitlements WHERE organization_id=$1',
      'SELECT count(*) FROM hon.organization_entitlements',
      "UPDATE hon.organization_entitlements SET tier='COMPLETE' WHERE organization_id=$1",
      'DELETE FROM hon.organization_entitlements WHERE organization_id=$1',
      "INSERT INTO hon.organization_entitlements(organization_id,tier) VALUES($1,'COMPLETE')",
      'SELECT * FROM hon.read_current_organization_entitlement($1::uuid)',
    ]) {
      await runtime.query('SAVEPOINT denied_raw');
      await assert.rejects(() => runtime.query(sql, sql.includes('$1') ? [ids[1]] : []), (error) => error.code === (sql.includes('read_current') ? '42883' : '42501'), `Forged tenant GUC cannot authorize raw source access or a selector: ${sql}`);
      await runtime.query('ROLLBACK TO SAVEPOINT denied_raw');
      await runtime.query('RELEASE SAVEPOINT denied_raw');
    }
    await runtime.query('COMMIT');
    assert.deepEqual((await readTier()).rows, [], 'Transaction-local organization context clears after commit');
    for (const tier of ['ESSENTIAL', 'CORE', 'COMPLETE']) {
      await owner.query("UPDATE hon.organization_entitlements SET tier=$2::hon.plan_tier,status='ACTIVE',effective_from=now()-interval '1 day',effective_until=NULL WHERE organization_id=$1", [ids[0], tier]);
      await runtime.query('BEGIN');
      await runtime.query("SELECT set_config('app.hon_organization_id',$1,true)", [ids[0]]);
      const result = await readTier();
      assert.deepEqual(result.fields.map((field) => field.name), ['tier']);
      assert.deepEqual(result.rows, [{ tier }]);
      await runtime.query('ROLLBACK');
    }
    for (const state of [
      "status='SUSPENDED',effective_from=now()-interval '1 day',effective_until=NULL",
      "status='ACTIVE',effective_from=now()+interval '1 day',effective_until=NULL",
      "status='ACTIVE',effective_from=now()-interval '2 days',effective_until=now()-interval '1 day'",
    ]) {
      await owner.query(`UPDATE hon.organization_entitlements SET ${state} WHERE organization_id=$1`, [ids[0]]);
      await runtime.query('BEGIN');
      await runtime.query("SELECT set_config('app.hon_organization_id',$1,true)", [ids[0]]);
      assert.deepEqual((await readTier()).rows, [], 'Inactive, future, and expired entitlements fail closed');
      await runtime.query('ROLLBACK');
    }
    await runtime.query('BEGIN');
    await runtime.query("SELECT set_config('app.hon_organization_id',$1,true)", [randomUUID()]);
    assert.deepEqual((await readTier()).rows, [], 'An organization with no entitlement has no row');
    await runtime.query("SELECT set_config('app.hon_organization_id',$1,true)", [ids[1]]);
    assert.deepEqual((await readTier()).rows, [{ tier: 'COMPLETE' }], 'The boundary has no independent organization selector');
    await runtime.query('ROLLBACK');

    // STABLE does not mean an expired tier may survive a wait across statements.
    await owner.query("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=now()-interval '1 day',effective_until=clock_timestamp()+interval '700 milliseconds' WHERE organization_id=$1", [ids[0]]);
    await runtime.query('BEGIN');
    await runtime.query("SELECT set_config('app.hon_organization_id',$1,true)", [ids[0]]);
    assert.equal((await readTier()).rowCount, 1);
    await runtime.query('SELECT pg_sleep(0.8)');
    assert.deepEqual((await readTier()).rows, [], 'Post-wait review must not reuse an expired tier');
    await runtime.query('ROLLBACK');

    for (const drift of [
      'GRANT SELECT ON hon.organization_entitlements TO hon_runtime',
      'GRANT SELECT(tier) ON hon.organization_entitlements TO hon_runtime',
      'GRANT UPDATE(tier) ON hon.organization_entitlements TO hon_runtime',
      'GRANT SELECT ON hon.organization_entitlements TO PUBLIC',
      'GRANT SELECT(tier) ON hon.organization_entitlements TO PUBLIC',
      'GRANT EXECUTE ON FUNCTION hon.read_current_organization_entitlement() TO PUBLIC',
      'GRANT EXECUTE ON FUNCTION hon.read_current_organization_entitlement() TO hon_runtime WITH GRANT OPTION',
      'REVOKE EXECUTE ON FUNCTION hon.read_current_organization_entitlement() FROM hon_runtime',
      'ALTER FUNCTION hon.read_current_organization_entitlement() SECURITY INVOKER',
      'ALTER FUNCTION hon.read_current_organization_entitlement() VOLATILE',
      'ALTER FUNCTION hon.read_current_organization_entitlement() SET search_path=public,hon',
      'ALTER ROLE hon_runtime BYPASSRLS',
      'ALTER TABLE hon.organization_entitlements NO FORCE ROW LEVEL SECURITY',
      'CREATE OR REPLACE FUNCTION hon.read_current_organization_entitlement() RETURNS TABLE(tier text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$ SELECT tier::text FROM hon.organization_entitlements $$',
      'CREATE FUNCTION hon.read_current_organization_entitlement(uuid) RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$',
    ]) {
      await owner.query('BEGIN');
      try {
        await owner.query(drift);
        await assert.rejects(() => owner.query(verification), (error) => error.code === 'P0001', `Canonical and JS-shared verifier must reject drift: ${drift}`);
      } finally { await owner.query('ROLLBACK'); }
    }
    await owner.query(verification);
    console.log('PASS: entitlement function-only boundary; no-context/active/all-tier/effective-period/expiry behavior; forged-GUC raw SELECT and mutation denial; selector denial; 15 canonical/JS-shared verifier drift rejections.');
  } finally {
    await runtime.query('ROLLBACK').catch(() => {});
    await runtime.end();
    await owner.query('DELETE FROM hon.organization_entitlements WHERE organization_id=ANY($1::uuid[])', [ids]);
    await owner.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])', [ids]);
  }
} finally { await owner.end(); }
