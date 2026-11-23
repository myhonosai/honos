// Native app hand-off single use proof (0655, GitHub security review 2026-11-22).
// Builds one private, throwaway PostgreSQL 16 cluster (no DATABASE_URL is read or accepted, nothing else is touched),
// creates the hon schema and the platform/HON roles, applies migration 0655 verbatim, then the 0655 block of the
// canonical runtime grants (010) and verifier (011), and checks:
//   - hon_runtime redeems a code exactly once (true, then false), per app; malformed or expired input is refused;
//   - two concurrent redemptions of one code: exactly one wins;
//   - expired rows are pruned; the ledger holds no token or identity text;
//   - no platform or HON role can read or write the ledger; only hon_runtime can EXECUTE the function;
//   - the 011 exact verification passes, and fails if the function body drifts or a table grant appears.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
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
const file = (url) => readFileSync(new URL(url, import.meta.url), 'utf8');
const migration = file('../migrations/0655_mobile_handoff_single_use.sql');
const block = (sql, start, end) => {
  const from = sql.indexOf(start); const to = sql.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`Block not found: ${start}`);
  return sql.slice(from, to + end.length);
};
const grants = block(file('../../../infra/postgres/010_supabase_hon_runtime.sql'), '-- 0655 native app sign-in codes are single use', 'END $$;');
const verifier = block(file('../../../infra/postgres/011_verify_supabase_hon_runtime.sql'), '-- Mobile hand-off single use exact verification (0655)', '-- End mobile hand-off single use exact verification.');

const others = ['anon', 'authenticated', 'service_role', 'authenticator', 'hon_outbox_worker', 'hon_communication_worker', 'hon_automation_worker'];
const work = mkdtempSync(join(tmpdir(), 'hon-mobile-handoff-'));
chmodSync(work, 0o700);
const port = '55447';
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
  const connect = async () => { const c = new pg.Client({ host: socket, port: Number(port), user: 'postgres', database: 'postgres' }); await c.connect(); return c; };
  const client = await connect();
  try {
    await client.query(`CREATE SCHEMA hon; CREATE ROLE hon_runtime NOLOGIN; ${others.map((r) => `CREATE ROLE ${r} NOLOGIN;`).join(' ')}
      GRANT USAGE ON SCHEMA hon TO PUBLIC;`);
    await client.query(migration);
    await client.query(grants);
    const md5 = (await client.query("SELECT md5(prosrc) m FROM pg_proc WHERE oid='hon.redeem_mobile_handoff(text,uuid,timestamptz)'::regprocedure")).rows[0].m;
    const pinned = /md5\(p\.prosrc\)='([0-9a-f]{32})'/.exec(verifier)?.[1];
    expect(pinned === md5, `011 pins the exact function body (md5 ${md5})`);
    await client.query(verifier);
    expect(true, '011 exact verification passes on the migrated cluster');

    const as = async (role, sql, args = []) => {
      await client.query('BEGIN');
      try { await client.query(`SET LOCAL ROLE ${role}`); const r = await client.query(sql, args); await client.query('COMMIT'); return r.rows; }
      catch (error) { await client.query('ROLLBACK'); return error.code; }
    };
    const soon = () => new Date(Date.now() + 60_000).toISOString();
    const redeem = (role, app, jti, exp = soon()) => as(role, 'SELECT hon.redeem_mobile_handoff($1,$2,$3) AS fresh', [app, jti, exp]);

    const jti = randomUUID();
    expect((await redeem('hon_runtime', 'family', jti))[0]?.fresh === true, 'hon_runtime: first redemption of a code is true');
    expect((await redeem('hon_runtime', 'family', jti))[0]?.fresh === false, 'hon_runtime: the same code again is false (single use)');
    expect((await redeem('hon_runtime', 'staff', jti))[0]?.fresh === true, 'the ledger is per app: the staff app is a separate key');
    expect((await redeem('hon_runtime', 'staff', jti))[0]?.fresh === false, 'and is single use too');
    for (const [label, args] of [
      ['an unknown app', ['web', randomUUID(), soon()]],
      ['a null app', [null, randomUUID(), soon()]],
      ['a null jti', ['family', null, soon()]],
      ['a null expiry', ['family', randomUUID(), null]],
      ['an expired code', ['family', randomUUID(), new Date(Date.now() - 1000).toISOString()]],
      ['an expiry beyond two minutes', ['family', randomUUID(), new Date(Date.now() + 10 * 60_000).toISOString()]],
    ]) expect(await redeem('hon_runtime', ...args) === '22023', `refuses ${label}`);

    const race = randomUUID();
    const [a, b] = [await connect(), await connect()];
    try {
      const go = (c) => c.query('SET ROLE hon_runtime').then(() => c.query('SELECT hon.redeem_mobile_handoff($1,$2,$3) AS fresh', ['family', race, soon()]));
      const results = await Promise.all([go(a), go(b)]);
      expect(results.map((r) => r.rows[0].fresh).sort().join() === 'false,true', 'two concurrent redemptions of one code: exactly one wins');
    } finally { await a.end(); await b.end(); }

    await client.query("INSERT INTO hon.mobile_handoff_redemptions(app,jti,expires_at) VALUES('family',$1,clock_timestamp()-interval '10 minutes')", [randomUUID()]);
    await redeem('hon_runtime', 'family', randomUUID());
    expect((await client.query("SELECT count(*)::int n FROM hon.mobile_handoff_redemptions WHERE expires_at < clock_timestamp()-interval '5 minutes'")).rows[0].n === 0, 'expired rows are pruned on redemption');
    const columns = (await client.query("SELECT array_agg(attname::text ORDER BY attnum) c FROM pg_attribute WHERE attrelid='hon.mobile_handoff_redemptions'::regclass AND attnum>0 AND NOT attisdropped")).rows[0].c;
    expect(columns.join() === 'app,jti,expires_at,redeemed_at', 'the ledger holds only app, jti and times: no token, identity or tenant');

    for (const role of ['hon_runtime', ...others]) {
      for (const sql of ['SELECT * FROM hon.mobile_handoff_redemptions', "INSERT INTO hon.mobile_handoff_redemptions(app,jti,expires_at) VALUES('family',gen_random_uuid(),now())", 'DELETE FROM hon.mobile_handoff_redemptions']) {
        expect(await as(role, sql) === '42501', `${role} has no table access: ${sql.split(' ').slice(0, 3).join(' ')}`);
      }
    }
    for (const role of others) expect(await redeem(role, 'family', randomUUID()) === '42501', `${role} cannot EXECUTE hon.redeem_mobile_handoff`);

    await client.query('GRANT SELECT ON hon.mobile_handoff_redemptions TO service_role');
    let refused = false; try { await client.query(verifier); } catch { refused = true; }
    expect(refused, '011 refuses a table grant on the ledger'); await client.query('REVOKE SELECT ON hon.mobile_handoff_redemptions FROM service_role');
    const body = (await client.query("SELECT pg_get_functiondef('hon.redeem_mobile_handoff(text,uuid,timestamptz)'::regprocedure) d")).rows[0].d;
    await client.query(body.replace("interval '120 seconds'", "interval '1 day'"));
    refused = false; try { await client.query(verifier); } catch { refused = true; }
    expect(refused, '011 refuses a drifted function body');
  } finally { await client.end(); }
  console.log(`Mobile hand-off single use (0655): ${passes} checks passed.`);
} finally {
  if (started) spawnSync(`${bin}/pg_ctl`, ['-D', data, '-m', 'fast', '-w', 'stop'], { env: safeEnv, stdio: 'ignore' });
  rmSync(work, { recursive: true, force: true });
}
