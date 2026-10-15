import pg from 'pg';
import { execFileSync } from 'node:child_process';
const owner = new URL(process.env.DATABASE_URL ?? '');
const runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
if (
  process.env.HON_TESTING_SCORECARD_RESET !== 'LOCAL_DISPOSABLE_ONLY'
  || owner.hostname !== 'localhost' || owner.port !== '5432'
  || owner.pathname !== '/hon_testing_scorecard_validation'
  || owner.username !== 'hon_testing_scorecard_owner'
  || runtime.hostname !== owner.hostname || runtime.port !== owner.port
  || runtime.pathname !== owner.pathname || runtime.username !== 'hon_testing_scorecard_runtime'
) {
  throw new Error('Explicit LOCAL_DISPOSABLE_ONLY reset and exact localhost testing-scorecard owner/runtime aliases are required. No remote or other database is permitted.');
}
const maintenance = new URL(owner); maintenance.pathname = '/postgres';
const admin = new pg.Client({ connectionString: maintenance.toString(), ssl: false });
await admin.connect();
try {
  const roles = (await admin.query("SELECT rolname,rolsuper,rolbypassrls,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolcanlogin FROM pg_roles WHERE rolname IN('hon_testing_scorecard_owner','hon_testing_scorecard_runtime')")).rows;
  const migrationOwner = roles.find(role => role.rolname === owner.username);
  const restrictedRuntime = roles.find(role => role.rolname === runtime.username);
  if (!migrationOwner?.rolbypassrls || !migrationOwner.rolcanlogin || !restrictedRuntime?.rolcanlogin
    || ['rolsuper', 'rolbypassrls', 'rolinherit', 'rolcreatedb', 'rolcreaterole', 'rolreplication'].some(key => restrictedRuntime[key])) {
    throw new Error('Preprovisioned local BYPASSRLS migration owner and restricted runtime roles are required. No role posture will be modified.');
  }
  await admin.query('DROP DATABASE IF EXISTS hon_testing_scorecard_validation WITH (FORCE)');
  await admin.query('CREATE DATABASE hon_testing_scorecard_validation OWNER hon_testing_scorecard_owner');
} finally { await admin.end(); }
execFileSync('node', [new URL('./migrate.mjs', import.meta.url).pathname], { env: process.env, stdio: 'inherit' });
const client = new pg.Client({ connectionString: owner.toString(), ssl: false });
await client.connect();
try {
  await client.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
        REVOKE ALL ON FUNCTION hon.resolve_testing_scorecard_scope(text,uuid) FROM hon_runtime;
        REVOKE ALL ON FUNCTION hon.read_testing_scorecard(text,uuid,uuid) FROM hon_runtime;
        REVOKE ALL ON FUNCTION hon.record_testing_scorecard_evaluation(text,uuid,uuid,jsonb,text,uuid,uuid) FROM hon_runtime;
      END IF;
    END $$;
    GRANT USAGE ON SCHEMA hon TO hon_testing_scorecard_runtime;
    REVOKE ALL ON TABLE hon.testing_scorecards,hon.testing_scorecard_evaluations,hon.testing_scorecard_requests,hon.testing_scorecard_outbox FROM hon_testing_scorecard_runtime;
    REVOKE ALL ON FUNCTION hon.resolve_testing_scorecard_scope(text,uuid) FROM hon_testing_scorecard_runtime;
    REVOKE ALL ON FUNCTION hon.read_testing_scorecard(text,uuid,uuid) FROM hon_testing_scorecard_runtime;
    REVOKE ALL ON FUNCTION hon.record_testing_scorecard_evaluation(text,uuid,uuid,jsonb,text,uuid,uuid) FROM hon_testing_scorecard_runtime;
    GRANT EXECUTE ON FUNCTION hon.resolve_testing_scorecard_scope(text,uuid) TO hon_testing_scorecard_runtime;
    GRANT EXECUTE ON FUNCTION hon.read_testing_scorecard(text,uuid,uuid) TO hon_testing_scorecard_runtime;
    GRANT EXECUTE ON FUNCTION hon.record_testing_scorecard_evaluation(text,uuid,uuid,jsonb,text,uuid,uuid) TO hon_testing_scorecard_runtime;
  `);
} finally { await client.end(); }
console.log('Reset only hon_testing_scorecard_validation on localhost; migrated and applied canonical restricted ACLs.');
