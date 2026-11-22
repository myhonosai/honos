// Fresh-target restore drill for docs/operations/BACKUP_RESTORE_AND_RECOVERY.md §2-§3 (launch-readiness review [23]).
// It follows the runbook's exact commands on two private, throwaway PostgreSQL 16 clusters that this script creates and
// destroys itself (nothing else is touched; no DATABASE_URL is read or accepted):
//   A (source) is production-shaped: every migration, then the canonical 010/012/013/014 provisioning with the real
//     HON role names, plus one synthetic organization. It is fingerprinted and dumped with `pg_dump --schema=hon -Fc`.
//   B (target) is a brand-new cluster. The drill first proves that the old runbook order cannot work there (010 before
//     the restore fails; a restore before the roles and the source's extensions fails), then follows the corrected
//     order: 009 roles, extensions as on the source, one-transaction pg_restore, 010 reconcile, read-only 011 verify.
//   The restored data, migration ledger, effective ACLs, RLS, policies, triggers, schema and database ACLs and the four
//   login roles' attributes must be identical to the source, and the restored runtime role must log in with its new
//   password and nothing more.
// It proves the procedure and tooling, not any hosted provider's backups.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';

if (process.env.DATABASE_URL || process.env.HON_RUNTIME_DATABASE_URL) throw new Error('Refusing: this drill builds its own private clusters; unset DATABASE_URL/HON_RUNTIME_DATABASE_URL.');
if (process.getuid?.() === 0) throw new Error('Run as an unprivileged OS user: initdb refuses root.');
const bin = process.env.HON_POSTGRES_BIN ?? '/usr/lib/postgresql/16/bin';
const safeEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', PAGER: 'cat' };
const run = (binary, args, { input, env = {}, allowFail = false } = {}) => {
  const result = spawnSync(binary, args, { encoding: 'utf8', env: { ...safeEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }) });
  if (result.status !== 0 && !allowFail) throw new Error(`${binary.split('/').at(-1)} failed: ${(result.stderr || result.stdout).slice(0, 600)}`);
  return result;
};
const expect = (condition, message) => { if (!condition) throw new Error(`FAIL: ${message}`); console.log(`PASS: ${message}`); };
const secret = () => randomBytes(36).toString('base64url');
const repo = new URL('../../../', import.meta.url);
const infra = (name) => readFileSync(new URL(`infra/postgres/${name}`, repo), 'utf8');
const roles = ['hon_runtime', 'hon_outbox_worker', 'hon_communication_worker', 'hon_automation_worker'];

const work = mkdtempSync(join(tmpdir(), 'hon-fresh-restore-'));
chmodSync(work, 0o700);
const clusters = { A: { port: '55441' }, B: { port: '55442' } };
const started = [];

function startCluster(name) {
  const c = clusters[name];
  c.data = join(work, `${name}-data`); c.socket = join(work, `${name}-socket`); c.password = secret();
  run('mkdir', ['-m', '700', c.socket]);
  const pwfile = join(work, `${name}.pw`);
  writeFileSync(pwfile, `${c.password}\n`, { mode: 0o600 });
  run(`${bin}/initdb`, ['-D', c.data, '-U', 'postgres', `--pwfile=${pwfile}`, '--auth-local=trust', '--auth-host=scram-sha-256', '--no-locale', '--encoding=UTF8']);
  rmSync(pwfile);
  // The daemon must not inherit this script's output pipe, so it logs to a private file.
  run(`${bin}/pg_ctl`, ['-D', c.data, '-l', join(work, `${name}.log`), '-o', `-F -p ${c.port} -h 127.0.0.1 -k ${c.socket}`, '-w', 'start'], { input: '' });
  started.push(c);
}
const psql = (name, sql, { readOnly = false, allowFail = false } = {}) => {
  const c = clusters[name];
  return run(`${bin}/psql`, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', c.socket, '-p', c.port, '-U', 'postgres', '-d', 'postgres'], { input: sql, allowFail, env: readOnly ? { PGOPTIONS: '-c default_transaction_read_only=on' } : {} });
};
async function withClient(name, work_, { user = 'postgres', password } = {}) {
  const c = clusters[name];
  const client = new pg.Client(password ? { host: '127.0.0.1', port: Number(c.port), user, password, database: 'postgres', ssl: false } : { host: c.socket, port: Number(c.port), user, database: 'postgres' });
  await client.connect();
  try { return await work_(client); } finally { await client.end(); }
}
const withPasswords = (sql, passwords) => sql.replace(/'<PASTE_FRESH_[A-Z_]*PASSWORD_HERE>'/g, (placeholder) => {
  const key = placeholder.includes('OUTBOX') ? 'hon_outbox_worker' : placeholder.includes('COMMUNICATION') ? 'hon_communication_worker' : placeholder.includes('AUTOMATION') ? 'hon_automation_worker' : 'hon_runtime';
  return `'${passwords[key]}'`;
});
const roleScript = (file, role, passwords) => infra(file).replace(/'<PASTE_FRESH_BASE64URL_PASSWORD_HERE>'/g, `'${passwords[role]}'`);

// Same data/posture fingerprint as test-restore-drill.mjs (ACLs compared as effective privileges), plus the attributes,
// memberships and settings of the four HON login roles and the target's extension inventory.
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
    (SELECT (string_agg(t.oid::regtype::text || ':' || (SELECT coalesce(string_agg(CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || '=' || a.privilege_type, ',' ORDER BY a.grantee, a.privilege_type), '') FROM aclexplode(coalesce(t.typacl, acldefault('T', t.typowner))) a), '|' ORDER BY t.oid::regtype::text))
       FROM pg_type t WHERE t.typnamespace = 'hon'::regnamespace AND t.typtype IN ('e', 'd', 'c') AND NOT EXISTS (SELECT 1 FROM pg_class r WHERE r.oid = t.typrelid AND r.relkind <> 'c')) AS types,
    (SELECT (string_agg(tablename || ':' || policyname || ':' || cmd || ':' || array_to_string(roles, ',') || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), '|' ORDER BY tablename, policyname))
       FROM pg_policies WHERE schemaname = 'hon') AS policies,
    (SELECT (string_agg(tgrelid::regclass::text || ':' || tgname || ':' || tgenabled::text, '|' ORDER BY tgrelid::regclass::text, tgname))
       FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'hon'::regnamespace)) AS triggers,
    (SELECT coalesce(nspacl::text, '') || ':' || pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'hon') AS schema_acl,
    (SELECT string_agg(e, ',' ORDER BY e) FROM (SELECT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || '=' || a.privilege_type || a.is_grantable::text AS e FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a WHERE d.datname = current_database()) x) AS database_acl,
    (SELECT string_agg(extname || '@' || extnamespace::regnamespace::text || '@' || extversion, '|' ORDER BY extname) FROM pg_extension) AS extensions,
    (SELECT string_agg(r.rolname || ':' || r.rolcanlogin::text || r.rolsuper::text || r.rolinherit::text || r.rolcreaterole::text || r.rolcreatedb::text || r.rolreplication::text || r.rolbypassrls::text
        || ':' || r.rolconnlimit || ':' || coalesce((SELECT array_to_string(s.setconfig, ',') FROM pg_db_role_setting s WHERE s.setrole = r.oid AND s.setdatabase = 0), '')
        || ':' || (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid)
        || ':' || has_schema_privilege(r.oid, 'public', 'USAGE')::text || has_schema_privilege(r.oid, 'public', 'CREATE')::text, '|' ORDER BY r.rolname)
       FROM pg_roles r WHERE r.rolname = ANY($1)) AS login_roles`, [roles])).rows[0];
  return { tables: tables.length, data, posture };
}
function compare(label, before, after) {
  const dataDiff = Object.keys({ ...before.data, ...after.data }).filter((table) => before.data[table] !== after.data[table]);
  if (dataDiff.length) console.error(`${label}: tables differing: ${dataDiff.slice(0, 10).join(', ')}`);
  expect(after.tables === before.tables && dataDiff.length === 0, `${label}: all ${after.tables} hon tables identical (row counts and content hashes)`);
  for (const [key, value] of Object.entries(before.posture)) {
    // Posture strings hold object names, flags and ACLs only (no row data), so a difference is printable.
    const a = (value ?? '').split('|'), b = (after.posture[key] ?? '').split('|');
    const lost = a.filter((entry) => !b.includes(entry)), gained = b.filter((entry) => !a.includes(entry));
    if (lost.length || gained.length) console.error(`${label}: ${key} differs. Source only: ${lost.slice(0, 5).join(' | ')}. Target only: ${gained.slice(0, 5).join(' | ')}`);
    expect(after.posture[key] === value, `${label}: ${key.replace('_', ' ')} identical`);
  }
}

try {
  // ---- A: production-shaped source -----------------------------------------------------------------------------
  startCluster('A');
  const sourcePasswords = Object.fromEntries(roles.map((role) => [role, secret()]));
  await withClient('A', async (client) => {
    const migrations = new URL('packages/database/migrations/', repo);
    await client.query('CREATE SCHEMA hon; CREATE TABLE hon.schema_migrations(filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const filename of readdirSync(migrations).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()) {
      await client.query(readFileSync(new URL(filename, migrations), 'utf8'));
      await client.query('INSERT INTO hon.schema_migrations(filename) VALUES ($1)', [filename]);
    }
  });
  psql('A', roleScript('010_supabase_hon_runtime.sql', 'hon_runtime', sourcePasswords));
  psql('A', roleScript('012_supabase_hon_outbox_worker.sql', 'hon_outbox_worker', sourcePasswords));
  psql('A', roleScript('013_supabase_hon_communication_worker.sql', 'hon_communication_worker', sourcePasswords));
  psql('A', roleScript('014_supabase_hon_automation_worker.sql', 'hon_automation_worker', sourcePasswords));
  psql('A', roleScript('010_supabase_hon_runtime.sql', 'hon_runtime', sourcePasswords));
  psql('A', infra('011_verify_supabase_hon_runtime.sql'), { readOnly: true });
  const organizationId = randomUUID();
  await withClient('A', (client) => client.query("INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, 'Fresh Restore Drill Synthetic Org LLC', 'Fresh Restore Drill Synthetic Org')", [organizationId]));
  const source = await withClient('A', fingerprint);
  expect(source.posture.login_roles?.split('|').length === 4, `source built: ${source.tables} hon tables, ${source.posture.ledger.split(',').length} migrations, canonical 010/012/013/014 provisioning, 011 passes read-only`);
  const extensions = (await withClient('A', (client) => client.query("SELECT extname, extnamespace::regnamespace::text AS schema FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY extname"))).rows;

  // ---- §2: the runbook's logical backup, schema hon only --------------------------------------------------------
  const dump = join(work, 'hon.dump');
  run(`${bin}/pg_dump`, ['--dbname', `host=${clusters.A.socket} port=${clusters.A.port} user=postgres dbname=postgres`, '--schema=hon', '--format=custom', '--no-password', '--file', dump]);
  const listing = run(`${bin}/pg_restore`, ['--list', dump]).stdout;
  expect(!/EXTENSION/.test(listing), 'a --schema=hon dump carries no extension, so the target must get the source extensions first');
  expect(!/\bROLE\b/.test(listing.replace(/ACL/g, '')), 'a --schema=hon dump carries no login role, so the target must get the roles first');

  // ---- B: a brand-new target ------------------------------------------------------------------------------------
  startCluster('B');
  const targetPasswords = Object.fromEntries(roles.map((role) => [role, secret()]));
  const freshTarget = async () => (await withClient('B', (client) => client.query("SELECT to_regnamespace('hon') IS NULL AS no_schema, NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname LIKE 'hon\\_%') AS no_roles"))).rows[0];
  const restore = () => run(`${bin}/pg_restore`, ['--dbname', `host=${clusters.B.socket} port=${clusters.B.port} user=postgres dbname=postgres`, '--exit-on-error', '--single-transaction', '--no-password', dump], { allowFail: true });

  // The old §3 step 2 (010/012 before the restore) cannot run on a fresh target; it changes nothing.
  const oldOrder = psql('B', roleScript('010_supabase_hon_runtime.sql', 'hon_runtime', targetPasswords), { allowFail: true });
  let fresh = await freshTarget();
  expect(oldOrder.status !== 0 && fresh.no_schema && fresh.no_roles, 'old order refused: 010 before the restore fails on a fresh target and leaves it untouched');
  const firstError = (result) => (result.stderr.match(/ERROR: [^\n]*/) ?? [''])[0];
  const bare = restore();
  fresh = await freshTarget();
  expect(bare.status !== 0 && fresh.no_schema, `restore into a bare target fails and, in one transaction, leaves nothing behind (${firstError(bare)})`);

  // §3 step 1: the source's extensions, in the same schema.
  psql('B', extensions.map(({ extname, schema }) => `CREATE EXTENSION IF NOT EXISTS ${JSON.stringify(extname)} WITH SCHEMA ${JSON.stringify(schema)};`).join('\n'));
  const noRoles = restore();
  fresh = await freshTarget();
  expect(noRoles.status !== 0 && /role "hon_[a-z_]+" does not exist/.test(noRoles.stderr) && fresh.no_schema, `with the extensions but no roles the restore still fails and leaves nothing behind (${firstError(noRoles)})`);

  // §3 step 2: roles, with the 010-014 attributes and no object privilege.
  psql('B', withPasswords(infra('009_restore_target_roles.sql'), targetPasswords));
  expect(psql('B', withPasswords(infra('009_restore_target_roles.sql'), targetPasswords), { allowFail: true }).status !== 0, '009 refuses to run twice (roles already exist)');

  // §3 step 3: one-transaction restore, owners and grants kept.
  const restored = restore();
  expect(restored.status === 0, 'restore into the prepared fresh target succeeds in one transaction');
  compare('after restore', source, await withClient('B', fingerprint));

  // §3 step 4: 010 reconcile is a no-op on a correct restore; 011 passes read-only.
  psql('B', roleScript('010_supabase_hon_runtime.sql', 'hon_runtime', targetPasswords));
  compare('after 010 reconcile', source, await withClient('B', fingerprint));
  psql('B', infra('011_verify_supabase_hon_runtime.sql'), { readOnly: true });
  expect(true, '011 verification passes on the restored target in a read-only session');

  const synthetic = await withClient('B', async (client) => (await client.query('SELECT display_name FROM hon.organizations WHERE id = $1', [organizationId])).rows[0]?.display_name);
  expect(synthetic === 'Fresh Restore Drill Synthetic Org', 'synthetic organization present on the target');
  const runtime = await withClient('B', async (client) => {
    const who = (await client.query("SELECT current_user AS u, current_setting('search_path') AS p")).rows[0];
    const direct = await client.query('SELECT 1 FROM hon.organizations LIMIT 1').then(() => 'read', (e) => e.code);
    return { ...who, direct };
  }, { user: 'hon_runtime', password: targetPasswords.hon_runtime });
  expect(runtime.u === 'hon_runtime' && runtime.p === 'hon, pg_catalog' && runtime.direct === '42501', 'restored runtime logs in with its NEW password, search_path hon, pg_catalog, and no direct table read (42501)');
  const oldPassword = await withClient('B', () => 'accepted', { user: 'hon_runtime', password: sourcePasswords.hon_runtime }).catch((e) => e.code);
  expect(oldPassword === '28P01', 'the source runtime password does not work on the target');
  console.log('PASS: fresh-target restore drill complete.');
} finally {
  for (const c of started) run(`${bin}/pg_ctl`, ['-D', c.data, '-m', 'immediate', '-w', 'stop'], { allowFail: true });
  rmSync(work, { recursive: true, force: true });
}
