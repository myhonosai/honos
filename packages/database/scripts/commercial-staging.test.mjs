import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { proofs, validateEnvironment, parseArguments, assertEmptyInstance, parseFixtureCredentials, postgresTarget, readMigrationEvidence, validateMigrationEvidence } from './commercial-staging-safety.mjs';

test('credit-program simulation is restricted to the existing D7 zero-grant proof', () => {
  assert.deepEqual(proofs.filter(p => p[3] === true).map(p => p[0]), ['test-saas-hon-os-new-school-onboarding.mjs']);
  assert(proofs.find(p => p[3])?.[2].includes('zero AI grants'));
});

test('closed CLI requires explicit disposable acknowledgement and a report, never a target URL', () => {
  assert.equal(parseArguments(['--confirm-disposable-local', '--report', '/tmp/private/report.json']), '/tmp/private/report.json');
  for (const args of [[], ['--confirm-disposable-local'], ['--database-url', 'postgresql://remote/db'], ['--confirm-disposable-local', '--report', 'relative'], ['--confirm-disposable-local', '--report', '/tmp/r', '--force']]) assert.throws(() => parseArguments(args));
});
test('inherited targets, providers, execution switches and preloads are refused, even empty', () => {
  validateEnvironment({ PATH: '/usr/bin', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' });
  for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL', 'PGHOST', 'PGSERVICEFILE', 'NODE_OPTIONS', 'STRIPE_SECRET_KEY', 'OPENAI_API_KEY', 'SUPABASE_URL', 'AWS_PROFILE', 'HON_PAYMENT_MODE', 'HON_WORKER_ENABLED']) assert.throws(() => validateEnvironment({ [key]: '' }), key);
  assert.throws(() => validateEnvironment({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }));
});
test('even marked old fixtures and existing application databases/roles are refused at entry', () => {
  assertEmptyInstance({ databases: [], roles: [], honSchema: false, applicationObjects: false, listen: 'localhost' });
  for (const state of [{ databases: ['real_school'], roles: [], honSchema: false }, { databases: ['hon_champions_validation'], roles: [], honSchema: false }, { databases: [], roles: ['hon_champions_owner'], honSchema: false }, { databases: [], roles: [], honSchema: true }]) assert.throws(() => assertEmptyInstance(state));
  for (const patch of [{applicationObjects:true},{listen:'*'}]) assert.throws(() => assertEmptyInstance({databases:[],roles:[],honSchema:false,applicationObjects:false,listen:'localhost',...patch}));
  assert.throws(() => assertEmptyInstance({databases:['private_customer_name'],roles:[],honSchema:false}), error => !error.message.includes('private_customer_name'));
});
const descriptor = "export DATABASE_URL='postgresql://hon_champions_owner:synthetic@localhost:5432/hon_champions_validation'\nexport HON_RUNTIME_DATABASE_URL='postgresql://hon_champions_runtime:synthetic@localhost:5432/hon_champions_validation'\n";
test('fixture descriptors are parsed as data, with exact identity/host/port/database and no shell', () => {
  assert.equal(Object.keys(parseFixtureCredentials(descriptor)).length, 2);
  for (const value of [descriptor.replaceAll('localhost', 'remote.example'), descriptor.replaceAll('5432', '5433'), descriptor.replaceAll('hon_champions_validation', 'postgres'), descriptor.replace('hon_champions_owner', 'postgres'), descriptor + 'echo unsafe\n', descriptor.replace("validation'", "validation?host=remote'"), descriptor.replace('HON_RUNTIME_DATABASE_URL', 'DATABASE_URL')]) assert.throws(() => parseFixtureCredentials(value));
});
test('network target policy accepts only canonical loopback PostgreSQL, including Node normalized arguments', () => {
  for (const args of [[5432, 'localhost'], [{ port: 5432, host: '127.0.0.1' }], [[{ port: '5432', host: '::1' }]], ['/var/run/postgresql/.s.PGSQL.5432']]) assert(postgresTarget(args));
  for (const args of [[443, 'example.test'], [5432, 'database.internal'], [{ port: 5432, host: '127.0.0.2' }], [{ path: '/tmp/other.sock' }], [{ port: 3000, host: 'localhost' }]]) assert(!postgresTarget(args));
});
test('entire reviewed migration chain and every 0181–0229 checksum are pinned', async () => {
  const actual = await readMigrationEvidence(); assert.equal(actual.targets.length, 46); assert.equal(actual.entries.at(-1).file.slice(0, 4), '0229');
  assert.equal(actual.entries.length, 218);
  assert.deepEqual(actual.targets.slice(-2).map(t => t.file.slice(0, 4)), ['0228', '0229']);
  const changed = structuredClone(actual.entries); changed[0].sha256 = '0'.repeat(64);
  assert.throws(() => validateMigrationEvidence(changed, actual));
  assert.throws(() => validateMigrationEvidence([...actual.entries, { file: '0230_unreviewed.sql', sha256: 'x' }], actual));
  assert.throws(() => validateMigrationEvidence([...actual.entries.slice(0, -1), { file: '0179_reserved.sql', sha256: 'x' }], actual));
});

async function guarded(code, { symlinkAudit = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hon-staging-guard-')), audit = join(dir, 'audit.jsonl');
  try {
    await writeFile(audit, '', { mode: 0o600 });
    let target = audit;
    if (symlinkAudit) { target = join(dir, 'linked.jsonl'); await symlink(audit, target); }
    const result = spawnSync(process.execPath, ['--import', fileURLToPath(new URL('./commercial-staging-network-guard.mjs', import.meta.url)), '--input-type=module', '-e', code],
      { encoding: 'utf8', timeout: 15_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, HON_STAGING_NETWORK_AUDIT: target } });
    const raw = (await readFile(audit, 'utf8')).trim(); return { ...result, audit: raw ? JSON.parse(raw) : null };
  } finally { await rm(dir, { recursive: true }); }
}
test('guard records a clean process without credentials or destinations', async () => {
  const r = await guarded(''); assert.equal(r.status, 0); assert.deepEqual(r.audit, { allowedPostgresConnections: 0, blockedNetworkAttempts: 0, blockedProcessAttempts: 0 });
});
for (const [name, code] of [
  ['fetch', "try { await fetch('https://example.invalid'); } catch {}"],
  ['named HTTPS import', "import {get} from 'node:https'; try {get('https://example.invalid')} catch {}"],
  ['raw TCP', "import net from 'node:net'; try {new net.Socket().connect(443,'example.invalid')} catch {}"],
  ['UDP', "import dgram from 'node:dgram'; try {dgram.createSocket('udp4')} catch {}"],
  ['DNS', "import dns from 'node:dns'; try {await dns.promises.resolve('example.invalid')} catch {}"],
  ['child process', "import {spawnSync} from 'node:child_process'; try {spawnSync('curl',['https://example.invalid'])} catch {}"],
  ['worker', "import {Worker} from 'node:worker_threads'; try {new Worker('')} catch {}"],
]) test('caught ' + name + ' escape still fails the proof without sending traffic', async () => {
  const r = await guarded(code); assert.equal(r.status, 1); assert.equal(r.audit.blockedNetworkAttempts + r.audit.blockedProcessAttempts, 1);
});
test('symlinked network audit cannot be used to overwrite another file', async () => {
  const r = await guarded('', { symlinkAudit: true }); assert.notEqual(r.status, 0); assert.equal(r.audit, null);
});
