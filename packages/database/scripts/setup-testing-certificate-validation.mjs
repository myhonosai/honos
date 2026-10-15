import pg from 'pg';
import { execFileSync } from 'node:child_process';

const owner = new URL(process.env.DATABASE_URL ?? '');
const runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
if (
  process.env.HON_TESTING_CERTIFICATE_RESET !== 'LOCAL_DISPOSABLE_ONLY'
  || owner.hostname !== 'localhost' || owner.port !== '5432'
  || owner.pathname !== '/hon_testing_certificate_validation'
  || owner.username !== 'hon_testing_certificate_owner'
  || runtime.hostname !== owner.hostname || runtime.port !== owner.port
  || runtime.pathname !== owner.pathname || runtime.username !== 'hon_testing_certificate_runtime'
) {
  throw new Error('Explicit LOCAL_DISPOSABLE_ONLY reset and exact localhost testing-certificate owner/runtime aliases are required. No remote or other database is permitted.');
}

const maintenance = new URL(owner);
maintenance.pathname = '/postgres';
const admin = new pg.Client({ connectionString: maintenance.toString(), ssl: false });
await admin.connect();
try {
  const roles = (await admin.query("SELECT rolname,rolsuper,rolbypassrls,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolcanlogin FROM pg_roles WHERE rolname IN('hon_testing_certificate_owner','hon_testing_certificate_runtime')")).rows;
  const migrationOwner = roles.find(role => role.rolname === owner.username);
  const restrictedRuntime = roles.find(role => role.rolname === runtime.username);
  if (!migrationOwner?.rolbypassrls || !migrationOwner.rolcanlogin
    || !restrictedRuntime?.rolcanlogin
    || ['rolsuper', 'rolbypassrls', 'rolinherit', 'rolcreatedb', 'rolcreaterole', 'rolreplication'].some(key => restrictedRuntime[key])) {
    throw new Error('Preprovisioned local BYPASSRLS migration owner and restricted runtime roles are required. No role posture will be modified.');
  }
  await admin.query('DROP DATABASE IF EXISTS hon_testing_certificate_validation WITH (FORCE)');
  await admin.query('CREATE DATABASE hon_testing_certificate_validation OWNER hon_testing_certificate_owner');
} finally {
  await admin.end();
}

execFileSync('node', [new URL('./migrate.mjs', import.meta.url).pathname], { env: process.env, stdio: 'inherit' });
const client = new pg.Client({ connectionString: owner.toString(), ssl: false });
await client.connect();
try {
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
        REVOKE ALL ON FUNCTION hon.resolve_testing_certificate_scope(text, uuid) FROM hon_runtime;
        REVOKE ALL ON FUNCTION hon.read_testing_certificate(text, uuid) FROM hon_runtime;
        REVOKE ALL ON FUNCTION hon.issue_testing_certificate(text, uuid, jsonb, text, uuid, uuid) FROM hon_runtime;
      END IF;
    END;
    $$;
    GRANT USAGE ON SCHEMA hon TO hon_testing_certificate_runtime;
    REVOKE ALL ON TABLE hon.testing_certificates, hon.testing_certificate_requests, hon.testing_certificate_outbox FROM hon_testing_certificate_runtime;
    REVOKE ALL ON FUNCTION hon.resolve_testing_certificate_scope(text, uuid) FROM hon_testing_certificate_runtime;
    REVOKE ALL ON FUNCTION hon.read_testing_certificate(text, uuid) FROM hon_testing_certificate_runtime;
    REVOKE ALL ON FUNCTION hon.issue_testing_certificate(text, uuid, jsonb, text, uuid, uuid) FROM hon_testing_certificate_runtime;
    GRANT EXECUTE ON FUNCTION hon.resolve_testing_certificate_scope(text, uuid) TO hon_testing_certificate_runtime;
    GRANT EXECUTE ON FUNCTION hon.read_testing_certificate(text, uuid) TO hon_testing_certificate_runtime;
    GRANT EXECUTE ON FUNCTION hon.issue_testing_certificate(text, uuid, jsonb, text, uuid, uuid) TO hon_testing_certificate_runtime;
  `);
} finally {
  await client.end();
}
console.log('Reset only hon_testing_certificate_validation on localhost; migrated and applied canonical restricted ACLs.');
