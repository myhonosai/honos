/** Dedicated disposable-local rehearsal only. No accepted database URL or remote target. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { readFile, writeFile, mkdtemp, lstat, realpath, open, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, proofs, parseArguments, validateEnvironment, assertEmptyInstance, parseFixtureCredentials, readMigrationEvidence } from './commercial-staging-safety.mjs';

const scripts = dirname(fileURLToPath(import.meta.url)), root = resolve(scripts, '../../..');
const jobs = '/home/ubuntu/jobs', lockPath = jobs + '/hon-commercial-staging.lock';
const safeEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', LANG: 'C.UTF-8', PAGER: 'cat' };
let activeChild, interrupted = false;
const redact = s => s.replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi, '[REDACTED_DATABASE_URL]').replace(/(?:sk_test_|whsec_)[a-zA-Z0-9]+/g, '[SIMULATOR_KEY]');

async function command(program, args, { env = safeEnv, input, timeout = 300_000 } = {}) {
  assert(!interrupted, 'Validation interrupted.');
  return new Promise((yes, no) => {
    const child = spawn(program, args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    activeChild = child; let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeout);
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-4_000_000); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4_000_000); });
    child.on('error', () => { clearTimeout(timer); activeChild = undefined; no(Error('Required local executable unavailable.')); });
    child.on('close', code => { clearTimeout(timer); activeChild = undefined;
      if (code !== 0 || timedOut) no(Error(redact((stdout + '\n' + stderr).slice(-5000)) || 'Local validation command failed.'));
      else yes(redact(stdout)); });
    child.stdin.end(input);
  });
}
const sql = (text, database = 'postgres') => command('sudo', ['-n', '-u', 'postgres', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '/var/run/postgresql', '-p', '5432', '-d', database], { input: text });
async function emptyInstance() {
  const data = JSON.parse(await sql(`SELECT json_build_object(
    'databases',(SELECT coalesce(json_agg(datname ORDER BY datname),'[]') FROM pg_database WHERE datname NOT IN ('postgres','template0','template1')),
    'roles',(SELECT coalesce(json_agg(rolname ORDER BY rolname),'[]') FROM pg_roles WHERE rolname<>'postgres' AND rolname !~ '^pg_'),
    'honSchema',EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='hon'),
    'applicationObjects',EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'),
    'listen',current_setting('listen_addresses'));`));
  assertEmptyInstance(data); return data;
}
async function destroyOwnedFixture() {
  // No FORCE/drop happens until the exact canonical database AND role markers match.
  await sql(`DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM pg_database WHERE datname='${fixture.database}' AND
      (pg_get_userbyid(datdba)<>'${fixture.owner}' OR shobj_description(oid,'pg_database') IS DISTINCT FROM '${fixture.marker}'))
      THEN RAISE EXCEPTION 'Unrecognized fixture database; cleanup refused'; END IF;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('${fixture.owner}','${fixture.runtime}') AND
      shobj_description(oid,'pg_authid') IS DISTINCT FROM '${fixture.marker}') THEN RAISE EXCEPTION 'Unrecognized fixture role; cleanup refused'; END IF;
    END $$;
    DROP DATABASE IF EXISTS ${fixture.database} WITH (FORCE);
    DROP ROLE IF EXISTS ${fixture.runtime}; DROP ROLE IF EXISTS ${fixture.owner};`);
  await emptyInstance();
}
async function privateDirectory(path) {
  const stat = await lstat(path);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'Private owned directory required.');
  assert.equal(await realpath(path), path, 'Symlinked directory refused.'); return stat;
}
async function setup(directory) {
  const file = directory + '/fixture.env';
  await command(process.execPath, [scripts + '/setup-champions-club-validation.mjs'], { env: { ...safeEnv,
    HON_CHAMPIONS_VALIDATION_TARGET: 'postgresql://localhost:5432/' + fixture.database, HON_CHAMPIONS_ENV_FILE: file } });
  const stat = await lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600);
  return parseFixtureCredentials(await readFile(file, 'utf8'));
}
async function run() {
  validateEnvironment(process.env);
  const reportPath = parseArguments(process.argv.slice(2));
  await privateDirectory(dirname(reportPath));
  const reportHandle = await open(reportPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const report = { sourceSha: null, baseline: '9c1e0ca6021aff86749a9f56ca212356e1d1b1c0', purpose: 'DISPOSABLE_LOCAL_ONLY',
    policyApprovalRecorded: false, syntheticExceptionPolicyDecisionsOnly: true, syntheticTrialGovernanceOnly: true, deployment: false, realProviderVerification: false, proofs: [], cleanup: false, success: false };
  let lock, lockStat, fixtureCreated = false, directory, failure;
  const signal = () => { interrupted = true; if (activeChild?.pid) try { process.kill(-activeChild.pid, 'SIGKILL'); } catch {} };
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, signal);
  try {
    assert.equal(process.platform, 'linux', 'Dedicated Linux/PostgreSQL instance required.');
    await privateDirectory(jobs);
    lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); lockStat = await lock.stat();
    report.sourceSha = (await command('git', ['rev-parse', 'HEAD'])).trim();
    assert.equal((await command('git', ['status', '--porcelain', '--untracked-files=no'])).trim(), '', 'Commit tracked changes before rehearsal.');
    report.migrations = await readMigrationEvidence();
    report.emptyInstanceBefore = await emptyInstance();
    const { default: pg } = await import('pg');
    const { installEffectTripwires, shippedPosture } = await import('./commercial-staging-fixtures.mjs');
    for (const [script, coverage, simulation, creditProgramSimulation = false] of proofs) {
      const item = { script, coverage, simulation, creditProgramSimulation, success: false, postureRestored: false, cleanup: false }; report.proofs.push(item);
      console.log('START ' + script);
      directory = await mkdtemp(jobs + '/commercial-staging-'); await privateDirectory(directory);
      fixtureCreated = true; // permits safe cleanup after a partially completed canonical setup
      const credentials = await setup(directory);
      const client = new pg.Client({ connectionString: credentials.DATABASE_URL, ssl: false });
      await client.connect();
      try {
        await installEffectTripwires(client, { creditProgramSimulation });
        const before = await shippedPosture(client, report.migrations);
        const auditPath = directory + '/network.jsonl'; await writeFile(auditPath, '', { flag: 'wx', mode: 0o600 });
        let output;
        try { output = await command(process.execPath, ['--import', scripts + '/commercial-staging-network-guard.mjs', scripts + '/' + script],
          { env: { ...safeEnv, ...credentials, HON_STAGING_NETWORK_AUDIT: auditPath } }); }
        finally {
          const raw = (await readFile(auditPath, 'utf8')).trim();
          const lines = raw ? raw.split('\n').map(JSON.parse) : [];
          if (lines.length === 1) item.network = lines[0];
        }
        assert(item.network, 'Missing network audit.');
        assert.equal(item.network.blockedNetworkAttempts, 0); assert.equal(item.network.blockedProcessAttempts, 0);
        assert(item.network.allowedPostgresConnections > 0);
        const after = await shippedPosture(client, report.migrations);
        assert.deepEqual(after, before, 'Simulation did not restore the shipped posture/policy records.');
        item.postureRestored = true; item.shippedPosture = after;
        item.evidence = output.split('\n').filter(line => /^PASS[: ]/.test(line)); assert(item.evidence.length);
        assert.deepEqual(await readMigrationEvidence(), report.migrations, 'Proof changed migration source.');
        item.success = true;
      } finally { await client.end(); }
      await destroyOwnedFixture(); fixtureCreated = false; item.cleanup = true;
      await rm(directory, { recursive: true }); directory = undefined;
      console.log('PASS ' + script + ' — shipped posture restored, zero AI grants, local-only network, fixture removed');
    }
    report.cleanup = true; report.emptyInstanceAfter = await emptyInstance();
    assert.equal((await command('git', ['status', '--porcelain', '--untracked-files=no'])).trim(), '');
    report.success = true;
  } catch (error) { failure = error; report.failure = redact(String(error.message)).slice(-5000); }
  finally {
    // Failure remains a failure. Rebuild/verify a fresh canonical fixture before destruction if a simulation failed.
    interrupted = false;
    if (fixtureCreated) try {
      await destroyOwnedFixture();
      if (directory) await rm(directory, { recursive: true });
      directory = await mkdtemp(jobs + '/commercial-staging-');
      const credentials = await setup(directory), { default: pg } = await import('pg');
      const { installEffectTripwires, shippedPosture } = await import('./commercial-staging-fixtures.mjs');
      const client = new pg.Client({ connectionString: credentials.DATABASE_URL, ssl: false }); await client.connect();
      try { await installEffectTripwires(client); await shippedPosture(client, report.migrations); report.failureRecovery = 'FRESH_CANONICAL_SHIPPED_POSTURE_VERIFIED'; }
      finally { await client.end(); }
      await destroyOwnedFixture(); report.cleanup = true;
    } catch (cleanupError) { report.cleanupFailure = redact(String(cleanupError.message)).slice(-3000); report.success = false; failure ??= cleanupError; }
    try {
      if (directory) await rm(directory, { recursive: true });
      if (lock) { await lock.close(); const current = await lstat(lockPath); if (current.ino === lockStat.ino && current.dev === lockStat.dev) await rm(lockPath); }
    } catch (cleanupError) { report.success = false; report.cleanup = false; report.cleanupFailure = redact(String(cleanupError.message)).slice(-3000); failure ??= cleanupError; }
    for (const s of ['SIGTERM', 'SIGINT']) process.off(s, signal);
    await reportHandle.writeFile(JSON.stringify(report, null, 2) + '\n'); await reportHandle.close();
  }
  console.log(JSON.stringify({ success: report.success, proofs: report.proofs.filter(p => p.success).length, cleanup: report.cleanup, report: reportPath }));
  if (failure) throw Error('Commercial staging rehearsal failed; inspect the private sanitized report.');
}
run().catch(error => { console.error(redact(String(error.message))); process.exitCode = 1; });
