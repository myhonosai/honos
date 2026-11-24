// Invoice INSERT status guard role proof (0644 H3, launch-readiness P3 carry from 0630).
// The guard lets only a trusted writer (superuser or BYPASSRLS) INSERT an invoice in a state other than DRAFT. Supabase's
// service_role has BYPASSRLS, so 0630 trusted it. Proving that needs a role named service_role with BYPASSRLS, which no
// shared proof fixture can create, so this script builds one private, throwaway PostgreSQL 16 cluster of its own (no
// DATABASE_URL is read or accepted, nothing else is touched), installs the guard function verbatim from the migration
// file and a minimal hon.invoices stand-in, and checks every platform and HON role:
//   - 0644: service_role, anon, authenticated, authenticator, hon_runtime and the three HON workers are refused a PAID
//     insert even with BYPASSRLS, and may still insert a DRAFT; the BYPASSRLS migration owner, the superuser and a
//     SECURITY DEFINER function owned by the migration owner (called by service_role) are unchanged.
//   - The same checks against the 0630 body show the old guard let a BYPASSRLS service_role insert PAID.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

if (process.env.DATABASE_URL || process.env.HON_RUNTIME_DATABASE_URL) throw new Error('Refusing: this proof builds its own private cluster; unset DATABASE_URL/HON_RUNTIME_DATABASE_URL.');
if (process.getuid?.() === 0) throw new Error('Run as an unprivileged OS user: initdb refuses root.');
const bin = process.env.HON_POSTGRES_BIN ?? '/usr/lib/postgresql/16/bin';
const safeEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', PAGER: 'cat' };
const run = (binary, args, { input } = {}) => {
  const result = spawnSync(binary, args, { encoding: 'utf8', env: safeEnv, stdio: ['pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }) });
  if (result.status !== 0) throw new Error(`${binary.split('/').at(-1)} failed: ${(result.stderr || result.stdout).slice(0, 600)}`);
  return result;
};
let passes = 0;
const expect = (condition, message) => { if (!condition) throw new Error(`FAIL: ${message}`); passes += 1; console.log(`PASS: ${message}`); };
const migration = (name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
const guardBody = (sql) => {
  const match = sql.match(/CREATE (?:OR REPLACE )?FUNCTION hon\.guard_invoice_insert_status\(\) RETURNS trigger[\s\S]*?END \$\$;/);
  if (!match) throw new Error('Guard function not found in migration');
  return match[0].replace(/^CREATE (?:OR REPLACE )?FUNCTION/, 'CREATE OR REPLACE FUNCTION');
};

const untrusted = ['service_role', 'anon', 'authenticated', 'authenticator', 'hon_runtime', 'hon_outbox_worker', 'hon_communication_worker', 'hon_automation_worker'];
const work = mkdtempSync(join(tmpdir(), 'hon-invoice-guard-'));
chmodSync(work, 0o700);
const port = '55443';
const data = join(work, 'data'); const socket = join(work, 'socket');
let started = false;
try {
  run('mkdir', ['-m', '700', socket]);
  const pwfile = join(work, 'pw');
  writeFileSync(pwfile, `${randomBytes(36).toString('base64url')}\n`, { mode: 0o600 });
  run(`${bin}/initdb`, ['-D', data, '-U', 'postgres', `--pwfile=${pwfile}`, '--auth-local=trust', '--auth-host=scram-sha-256', '--no-locale', '--encoding=UTF8']);
  rmSync(pwfile);
  run(`${bin}/pg_ctl`, ['-D', data, '-l', join(work, 'pg.log'), '-o', `-F -p ${port} -h 127.0.0.1 -k ${socket}`, '-w', 'start'], { input: '' });
  started = true;
  const client = new pg.Client({ host: socket, port: Number(port), user: 'postgres', database: 'postgres' });
  await client.connect();
  try {
    // Every role is BYPASSRLS here, the worst case: a platform or HON role that gained the attribute is still untrusted.
    await client.query(`CREATE SCHEMA hon;
      CREATE TABLE hon.invoices(id serial PRIMARY KEY, status text NOT NULL);
      CREATE ROLE hon_migration_owner NOLOGIN BYPASSRLS;
      ${untrusted.map((role) => `CREATE ROLE ${role} NOLOGIN BYPASSRLS;`).join('\n')}
      GRANT USAGE ON SCHEMA hon TO PUBLIC; GRANT INSERT ON hon.invoices TO PUBLIC; GRANT USAGE ON SEQUENCE hon.invoices_id_seq TO PUBLIC;
      ALTER SCHEMA hon OWNER TO hon_migration_owner; ALTER TABLE hon.invoices OWNER TO hon_migration_owner;`);
    const install = async (sql) => {
      await client.query(guardBody(sql));
      await client.query('ALTER FUNCTION hon.guard_invoice_insert_status() OWNER TO hon_migration_owner');
      await client.query('DROP TRIGGER IF EXISTS invoice_insert_status_guard ON hon.invoices');
      await client.query('CREATE TRIGGER invoice_insert_status_guard BEFORE INSERT ON hon.invoices FOR EACH ROW EXECUTE FUNCTION hon.guard_invoice_insert_status()');
      await client.query(`CREATE OR REPLACE FUNCTION hon.trusted_issue_invoice() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,hon
        AS $$ INSERT INTO hon.invoices(status) VALUES('ISSUED') $$`);
      await client.query('ALTER FUNCTION hon.trusted_issue_invoice() OWNER TO hon_migration_owner');
    };
    const insertAs = async (role, status) => {
      await client.query('BEGIN');
      try {
        if (role) await client.query(`SET LOCAL ROLE ${role}`);
        await client.query('INSERT INTO hon.invoices(status) VALUES($1)', [status]);
        return 'inserted';
      } catch (error) { return error.code; } finally { await client.query('ROLLBACK'); }
    };
    const definerAs = async (role) => {
      await client.query('BEGIN');
      try { await client.query(`SET LOCAL ROLE ${role}`); await client.query('SELECT hon.trusted_issue_invoice()'); return 'inserted'; }
      catch (error) { return error.code; } finally { await client.query('ROLLBACK'); }
    };

    await install(migration('0630_invoice_insert_status_guard.sql'));
    expect(await insertAs('service_role', 'PAID') === 'inserted', '0630 body: a BYPASSRLS service_role could INSERT a PAID invoice (the defect)');

    await install(migration('0644_booking_invoice_security_hygiene.sql'));
    for (const role of untrusted) {
      for (const status of ['PAID', 'ISSUED', 'VOID', 'UNCOLLECTIBLE']) {
        expect(await insertAs(role, status) === '55000', `0644: ${role} (BYPASSRLS) is refused an INSERT as ${status}`);
      }
      expect(await insertAs(role, 'DRAFT') === 'inserted', `0644: ${role} may still INSERT a DRAFT`);
    }
    expect(await insertAs('hon_migration_owner', 'PAID') === 'inserted', '0644: the BYPASSRLS migration owner is unchanged');
    expect(await insertAs(null, 'ISSUED') === 'inserted', '0644: the superuser is unchanged');
    expect(await definerAs('service_role') === 'inserted', '0644: a definer function owned by the migration owner still creates ISSUED invoices');
    expect((await client.query('SELECT count(*)::int AS n FROM hon.invoices')).rows[0].n === 0, 'every probe rolled back');
  } finally { await client.end(); }
  console.log(`Invoice INSERT guard roles (0644 H3): ${passes} checks passed.`);
} finally {
  if (started) spawnSync(`${bin}/pg_ctl`, ['-D', data, '-m', 'fast', '-w', 'stop'], { env: safeEnv, stdio: 'ignore' });
  rmSync(work, { recursive: true, force: true });
}
