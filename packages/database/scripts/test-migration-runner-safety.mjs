// Disposable-localhost proof for the production migration tooling:
//  1. migrate.mjs refuses to run while another session holds the migration lock;
//  2. it is a no-op on a current database, and db:status reports PASS;
//  3. db:status fails on ledger history unknown to this build (divergent database);
//  4. both tools refuse a non-local database without a CA, and URL TLS overrides, before connecting;
//  5. a migration and its ledger row commit together: a crash or ledger failure after the migration body leaves neither.
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { verifiedDatabaseConnection } from '../dist/index.js';
import { applyMigrationAtomically } from './migration-chain.mjs';

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

  // 5. Atomic ledger (launch-readiness P2). The probe tables and trigger live only in this disposable database.
  {
    const probeSql = (table) => `BEGIN;\nCREATE TABLE hon.${table}(id integer);\nCOMMIT;\n`;
    const exists = async (table, file) => (await admin.query(
      'SELECT to_regclass($1) IS NOT NULL AS made, EXISTS(SELECT 1 FROM hon.schema_migrations WHERE filename = $2) AS recorded', [`hon.${table}`, file])).rows[0];
    await admin.query(`CREATE FUNCTION hon.p_ledger_probe_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.filename = '9997_ledger_probe_fail.sql' THEN RAISE EXCEPTION 'ledger probe refusal'; END IF;
        IF NEW.filename = '9996_ledger_probe_crash.sql' THEN PERFORM pg_sleep(30); END IF;
        RETURN NEW;
      END $$`);
    await admin.query('CREATE TRIGGER p_ledger_probe_guard BEFORE INSERT ON hon.schema_migrations FOR EACH ROW EXECUTE FUNCTION hon.p_ledger_probe_guard()');
    try {
      // (a) The ledger INSERT fails after the migration body ran: the body rolls back with it.
      let failed = false;
      try { await applyMigrationAtomically(admin, '9997_ledger_probe_fail.sql', probeSql('p_ledger_probe_fail')); } catch { failed = true; }
      const a = await exists('p_ledger_probe_fail', '9997_ledger_probe_fail.sql');
      expect(failed && !a.made && !a.recorded, 'a failed ledger INSERT rolls back the migration it records');

      // (b) The runner dies between the migration body and the ledger row (the old crash window): nothing is applied.
      const victim = new pg.Client(verifiedDatabaseConnection(url));
      await victim.connect();
      victim.on('error', () => {});
      const pid = (await victim.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pending = applyMigrationAtomically(victim, '9996_ledger_probe_crash.sql', probeSql('p_ledger_probe_crash')).then(() => 'applied', () => 'lost');
      const deadline = Date.now() + 20000;
      while ((await admin.query("SELECT count(*)::integer AS n FROM pg_stat_activity WHERE pid = $1 AND wait_event = 'PgSleep'", [pid])).rows[0].n === 0) {
        if (Date.now() > deadline) throw new Error('The probe migration never reached its ledger INSERT.');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      const outcome = await pending;
      await victim.end().catch(() => {});
      const b = await exists('p_ledger_probe_crash', '9996_ledger_probe_crash.sql');
      expect(outcome === 'lost' && !b.made && !b.recorded, 'a runner lost between the migration body and its ledger row leaves the migration unapplied, so a rerun is safe');

      // (c) The normal path commits both together.
      await applyMigrationAtomically(admin, '9995_ledger_probe_ok.sql', probeSql('p_ledger_probe_ok'));
      const c = await exists('p_ledger_probe_ok', '9995_ledger_probe_ok.sql');
      expect(c.made && c.recorded, 'a migration and its ledger row commit together');

      // (d) A file with a second transaction boundary is refused before anything runs.
      let refused = false;
      try { await applyMigrationAtomically(admin, '9994_ledger_probe_split.sql', 'BEGIN;\nCREATE TABLE hon.p_ledger_probe_split(id integer);\nCOMMIT;\nBEGIN;\nSELECT 1;\nCOMMIT;\n'); } catch (error) { refused = /more than one transaction boundary/.test(error.message); }
      const d = await exists('p_ledger_probe_split', '9994_ledger_probe_split.sql');
      expect(refused && !d.made && !d.recorded, 'a migration that would commit part of itself early is refused before it runs');
    } finally {
      await admin.query('DROP TRIGGER IF EXISTS p_ledger_probe_guard ON hon.schema_migrations');
      await admin.query('DROP FUNCTION IF EXISTS hon.p_ledger_probe_guard()');
      await admin.query('DROP TABLE IF EXISTS hon.p_ledger_probe_fail, hon.p_ledger_probe_crash, hon.p_ledger_probe_ok, hon.p_ledger_probe_split');
      await admin.query("DELETE FROM hon.schema_migrations WHERE filename LIKE '999%_ledger_probe_%'");
    }
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
