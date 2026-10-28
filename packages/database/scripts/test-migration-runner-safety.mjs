// Disposable-localhost proof for the production migration tooling:
//  1. migrate.mjs refuses to run while another session holds the migration lock;
//  2. it is a no-op on a current database, and db:status reports PASS;
//  3. db:status fails on ledger history unknown to this build (divergent database);
//  4. both tools refuse a non-local database without a CA, and URL TLS overrides, before connecting.
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { verifiedDatabaseConnection } from '../dist/index.js';

const url = process.env.DATABASE_URL;
if (!url || new URL(url).hostname !== 'localhost') throw new Error('Disposable localhost DATABASE_URL required.');
const scripts = new URL('./', import.meta.url).pathname;
const run = (script, env, args = []) => spawnSync(process.execPath, [`${scripts}${script}`, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
const expect = (condition, message) => { if (!condition) throw new Error(message); console.log(`PASS: ${message}`); };

const admin = new pg.Client(verifiedDatabaseConnection(url));
await admin.connect();
try {
  const marker = (await admin.query("SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = current_database()")).rows[0]?.marker;
  if (!marker?.startsWith('HON disposable')) throw new Error('Refusing an unmarked database.');

  await admin.query("SELECT pg_advisory_lock('5210469387739812417'::bigint)");
  const blocked = run('migrate.mjs', { DATABASE_URL: url });
  await admin.query("SELECT pg_advisory_unlock('5210469387739812417'::bigint)");
  expect(blocked.status !== 0 && /holds the migration lock/.test(blocked.stderr), 'migrate.mjs refuses to run concurrently with another migration session');

  const current = run('migrate.mjs', { DATABASE_URL: url });
  expect(current.status === 0 && /migrations are current/.test(current.stdout) && !/Applied /.test(current.stdout), 'migrate.mjs is a no-op on a current database and releases its lock');

  const status = run('migration-status.mjs', { DATABASE_URL: url }, ['--require-current']);
  expect(status.status === 0 && /PASS: database is at this build's migration level/.test(status.stdout), 'db:status reports PASS for a current database');
  expect(!status.stdout.includes(new URL(url).password), 'db:status output contains no credential');

  await admin.query("INSERT INTO hon.schema_migrations(filename) VALUES ('9999_p03_divergent_probe.sql')");
  try {
    const divergent = run('migration-status.mjs', { DATABASE_URL: url });
    expect(divergent.status === 1 && /Unknown applied:\s+1 \(9999_p03_divergent_probe\.sql\)/.test(divergent.stdout) && /FAIL: database history diverges/.test(divergent.stdout), 'db:status fails on ledger history this build does not contain');
  } finally {
    await admin.query("DELETE FROM hon.schema_migrations WHERE filename = '9999_p03_divergent_probe.sql'");
  }

  const remote = 'postgresql://probe:probe@db.p03-probe.invalid:5432/postgres';
  for (const script of ['migrate.mjs', 'migration-status.mjs']) {
    const refused = run(script, { DATABASE_URL: remote });
    expect(refused.status !== 0 && /requires HON_DATABASE_CA_CERT/.test(refused.stderr) && !/ENOTFOUND|getaddrinfo/.test(refused.stderr), `${script} refuses a non-local database without a CA before connecting`);
    const override = run(script, { DATABASE_URL: `${remote}?sslmode=no-verify`, HON_DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----' });
    expect(override.status !== 0 && /remove the "sslmode" URL parameter/.test(override.stderr), `${script} refuses a URL that would override TLS verification`);
  }
} finally {
  await admin.end();
}
