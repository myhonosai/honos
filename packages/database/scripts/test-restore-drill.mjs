// Automated backup -> total loss -> restore -> verify drill on a DISPOSABLE localhost fixture.
// It exercises the logical-backup procedure in docs/operations/BACKUP_RESTORE_AND_RECOVERY.md:
//   1. record a synthetic tenant, then fingerprint data, migration ledger and security posture;
//   2. pg_dump (custom format) to a private file;
//   3. DROP the database entirely (simulated loss), then pg_restore --create from the dump;
//   4. require identical fingerprints and re-run the full RLS / least-privilege verifiers.
// It proves the procedure and tooling, not any hosted provider's backups.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { verifiedDatabaseConnection } from '../dist/index.js';

const url = process.env.DATABASE_URL;
if (!url || !process.env.HON_RUNTIME_DATABASE_URL) throw new Error('Disposable fixture DATABASE_URL and HON_RUNTIME_DATABASE_URL required.');
const target = new URL(url);
if (target.hostname !== 'localhost' || target.port !== '5432') throw new Error('Restore drill runs only against localhost:5432.');
const database = target.pathname.slice(1);
if (!/^hon_[a-z0-9_]+_validation$/.test(database)) throw new Error('Restore drill requires a HON *_validation fixture database.');
const bin = process.env.HON_POSTGRES_BIN ?? '/usr/lib/postgresql/16/bin';
const safeEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', PAGER: 'cat' };
const asPostgres = (binary, args, input) => {
  const result = spawnSync('sudo', ['-u', 'postgres', binary, ...args], { encoding: 'utf8', env: safeEnv, ...(input === undefined ? {} : { input }) });
  if (result.status !== 0) throw new Error(`${binary.split('/').at(-1)} failed: ${result.stderr.slice(0, 400)}`);
  return result.stdout;
};
const expect = (condition, message) => { if (!condition) throw new Error(message); console.log(`PASS: ${message}`); };

async function withOwner(work) {
  const client = new pg.Client(verifiedDatabaseConnection(url));
  await client.connect();
  try { return await work(client); } finally { await client.end(); }
}

// Data, ledger and security-posture fingerprint. Table contents are hashed, never printed. ACLs are
// compared as EFFECTIVE privileges (NULL = the type's default), because pg_dump omits grants equal
// to the default and a restored object legitimately reports NULL where the original stored them.
async function fingerprint(client) {
  const tables = (await client.query("SELECT c.oid::regclass::text AS name FROM pg_class c WHERE c.relnamespace = 'hon'::regnamespace AND c.relkind IN ('r', 'p') ORDER BY 1")).rows.map((row) => row.name);
  const data = {};
  for (const table of tables) {
    const row = (await client.query(`SELECT count(*)::int AS n, coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS h FROM ${table} t`)).rows[0];
    data[table] = `${row.n}:${row.h}`;
  }
  const posture = (await client.query(`SELECT
    (SELECT string_agg(filename, ',' ORDER BY filename) FROM hon.schema_migrations) AS ledger,
    (SELECT (string_agg(c.oid::regclass::text || ':' || c.relrowsecurity::text || c.relforcerowsecurity::text || ':' || (SELECT coalesce(string_agg(pg_get_userbyid(a.grantor) || '>' || coalesce(nullif(pg_get_userbyid(a.grantee), '-'), 'PUBLIC') || '=' || a.privilege_type || a.is_grantable::text, ',' ORDER BY 1), '') FROM aclexplode(coalesce(c.relacl, acldefault((CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END)::"char", c.relowner))) a), '|' ORDER BY c.oid::regclass::text))
       FROM pg_class c WHERE c.relnamespace = 'hon'::regnamespace) AS relations,
    (SELECT (string_agg(p.oid::regprocedure::text || ':' || p.prosecdef::text || ':' || (SELECT coalesce(string_agg(pg_get_userbyid(a.grantor) || '>' || coalesce(nullif(pg_get_userbyid(a.grantee), '-'), 'PUBLIC') || '=' || a.privilege_type || a.is_grantable::text, ',' ORDER BY 1), '') FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a) || ':' || pg_get_userbyid(p.proowner) || ':' || coalesce(array_to_string(p.proconfig, ','), ''), '|' ORDER BY p.oid::regprocedure::text))
       FROM pg_proc p WHERE p.pronamespace = 'hon'::regnamespace) AS functions,
    (SELECT (string_agg(tablename || ':' || policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), '|' ORDER BY tablename, policyname))
       FROM pg_policies WHERE schemaname = 'hon') AS policies,
    (SELECT (string_agg(tgrelid::regclass::text || ':' || tgname || ':' || tgenabled::text, '|' ORDER BY tgrelid::regclass::text, tgname))
       FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'hon'::regnamespace)) AS triggers,
    (SELECT coalesce(nspacl::text, '') FROM pg_namespace WHERE nspname = 'hon') AS schema_acl,
    (SELECT coalesce(datacl::text, '') || ':' || coalesce(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = current_database()) AS database_acl`)).rows[0];
  return { tables: tables.length, data, posture };
}

// The dump lives in a private 0700 directory owned by the postgres OS user, which runs pg_dump.
const work = asPostgres('mktemp', ['-d', '/tmp/hon-restore-drill-XXXXXXXX']).trim();
if (!/^\/tmp\/hon-restore-drill-[A-Za-z0-9]{8}$/.test(work)) throw new Error('Unexpected drill directory.');
const dump = join(work, `${database}.dump`);
try {
  const marker = await withOwner(async (client) => (await client.query("SELECT shobj_description(oid, 'pg_database') AS m FROM pg_database WHERE datname = current_database()")).rows[0]?.m);
  if (!marker?.startsWith('HON disposable')) throw new Error('Refusing an unmarked database.');

  // A synthetic tenant written through the owner role so the drill proves tenant data survives.
  const organizationId = randomUUID();
  await withOwner((client) => client.query("INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, 'Restore Drill Synthetic Org LLC', 'Restore Drill Synthetic Org')", [organizationId]));
  const before = await withOwner(fingerprint);
  expect(Number(before.data['hon.organizations']?.split(':')[0]) >= 1, `fingerprinted ${before.tables} hon tables, ledger of ${before.posture.ledger.split(',').length} migrations and the security posture`);

  const started = Date.now();
  asPostgres(`${bin}/pg_dump`, ['-h', '/var/run/postgresql', '-p', '5432', '-d', database, '-Fc', '--no-password', '-f', dump]);
  const dumpBytes = Number(asPostgres('stat', ['-c', '%s', dump]).trim());
  expect(dumpBytes > 0, `logical backup written (${Math.round(dumpBytes / 1024)} KiB, custom format)`);

  asPostgres(`${bin}/psql`, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '/var/run/postgresql', '-p', '5432', '-d', 'postgres'], `DROP DATABASE ${database} WITH (FORCE);`);
  const gone = asPostgres(`${bin}/psql`, ['-X', '-At', '-h', '/var/run/postgresql', '-p', '5432', '-d', 'postgres', '-c', `SELECT count(*) FROM pg_database WHERE datname = '${database}'`]).trim();
  expect(gone === '0', 'database dropped entirely (simulated total loss)');

  asPostgres(`${bin}/pg_restore`, ['-h', '/var/run/postgresql', '-p', '5432', '-d', 'postgres', '--create', '--exit-on-error', '--no-password', dump]);
  const restoreSeconds = ((Date.now() - started) / 1000).toFixed(1);

  const after = await withOwner(fingerprint);
  const dataDiff = Object.keys({ ...before.data, ...after.data }).filter((table) => before.data[table] !== after.data[table]);
  expect(after.tables === before.tables && dataDiff.length === 0, `all ${after.tables} tables restored with identical row counts and content hashes`);
  for (const [key, value] of Object.entries(before.posture)) {
    // Posture strings hold object names, flags and ACLs only (no row data), so a difference is printable.
    const lost = value.split('|').filter((entry) => !after.posture[key].split('|').includes(entry));
    const gained = after.posture[key].split('|').filter((entry) => !value.split('|').includes(entry));
    if (lost.length || gained.length) console.error(`${key} differs. Before only: ${lost.slice(0, 5).join(' | ')}. After only: ${gained.slice(0, 5).join(' | ')}`);
    expect(after.posture[key] === value, `restored ${key.replace('_', ' ')} identical`);
  }
  const synthetic = await withOwner(async (client) => (await client.query('SELECT display_name FROM hon.organizations WHERE id = $1', [organizationId])).rows[0]?.display_name);
  expect(synthetic === 'Restore Drill Synthetic Org', 'synthetic tenant present after restore');

  const childEnv = { ...safeEnv, HOME: process.env.HOME ?? '/tmp', DATABASE_URL: url, HON_RUNTIME_DATABASE_URL: process.env.HON_RUNTIME_DATABASE_URL };
  for (const verifier of ['verify-rls.mjs', 'test-platform-least-privilege.mjs', 'migration-status.mjs']) {
    const result = spawnSync(process.execPath, [new URL(`./${verifier}`, import.meta.url).pathname, ...(verifier === 'migration-status.mjs' ? ['--require-current'] : [])], { encoding: 'utf8', env: childEnv });
    expect(result.status === 0, `${verifier} passes on the restored database`);
  }
  await withOwner((client) => client.query('DELETE FROM hon.organizations WHERE id = $1', [organizationId]));
  console.log(`PASS: backup/restore drill complete; dump-to-verified-restore in ${restoreSeconds}s on this fixture.`);
} finally {
  spawnSync('sudo', ['-u', 'postgres', 'rm', '-rf', work], { env: safeEnv });
}
