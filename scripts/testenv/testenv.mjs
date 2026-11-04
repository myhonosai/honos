#!/usr/bin/env node
// HON OS private owner test environment launcher.
//
// Runs the ACTUAL repository application on this computer only:
//   private PostgreSQL cluster (all repository migrations, restricted hon_runtime role, forced RLS)
//   -> actual Nest API (HON session verification, IAM resolvers, tenant transactions)
//   -> actual Next.js web app (real OIDC login code path)
//   -> local HTTPS gateway on https://localhost:3443 that also serves the test identity provider.
//
// Safety boundaries (enforced here, not just documented):
//   - every listener binds to loopback only; nothing is reachable from another computer;
//   - child processes get a minimal, explicit environment: no inherited DATABASE_URL, provider
//     keys (AI, payments, messaging) or cloud credentials, so AI/provider/payment calls stay
//     unconfigured and refuse; no production database or account is ever contacted;
//   - dotenv files in the app folders are refused, because Next would otherwise load them;
//   - state lives in a private 0700 directory outside the repository and survives restarts;
//   - reset deletes only a directory carrying this tool's marker file, after explicit confirmation.
import { spawn, spawnSync } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_IDENTITIES, honExternalSubject } from './identities.mjs';
import { createTestIdentityProvider } from './test-identity-provider.mjs';
import { signIn } from './session-client.mjs';
import { createCleanupStack, STATE_MARKER, validateStateDirectory } from './state-safety.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MARKER = STATE_MARKER;
const PORTS = Object.freeze({ gateway: 3443, web: 3100, api: 3001, postgres: 55440 });
const ORIGIN = `https://localhost:${PORTS.gateway}`;
const ISSUER = `${ORIGIN}/__test-idp`;
const CLIENT_ID = 'hon-os-private-testenv';
const DATABASE = 'hon_testenv';

const FORBIDDEN_INHERITED = [
  'DATABASE_URL', 'HON_RUNTIME_DATABASE_URL', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'STRIPE_SECRET_KEY', 'STRIPE_TEST_SECRET_KEY', 'STRIPE_TEST_WEBHOOK_SECRET', 'ZERNIO_API_KEY', 'TWILIO_AUTH_TOKEN',
  'HON_OIDC_CLIENT_SECRET', 'MANUS_JWT_SECRET', 'SUPABASE_SERVICE_ROLE_KEY',
];

export function stateDirectory(env = process.env, { requireFresh = false } = {}) {
  if (requireFresh && !env.HON_TESTENV_HOME?.startsWith('/')) throw new Error('Fresh QA requires an explicit absolute HON_TESTENV_HOME.');
  const dir = env.HON_TESTENV_HOME ? resolve(env.HON_TESTENV_HOME) : join(homedir(), '.hon-testenv');
  return validateStateDirectory(dir, { root: repoRoot, requireFresh });
}

export function refuseUnsafeInvocation(env = process.env, root = repoRoot) {
  const problems = [];
  for (const key of FORBIDDEN_INHERITED) if (env[key]) problems.push(`Unset ${key}; the test environment never uses inherited database or provider credentials.`);
  for (const folder of ['apps/web', 'apps/api', '.']) {
    const dir = join(root, folder);
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      if (/^\.env(\..+)?$/.test(name) && name !== '.env.example') problems.push(`Move ${join(folder, name)} out of the repository; Next.js would load it into the test app.`);
    }
  }
  return problems;
}

function log(message) { process.stdout.write(`[testenv] ${message}\n`); }
function fail(message) { throw new Error(message); }

function postgresBinaries(env = process.env) {
  const candidates = [env.HON_TESTENV_PG_BIN];
  const pgConfig = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' });
  if (pgConfig.status === 0) candidates.push(pgConfig.stdout.trim());
  candidates.push('/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/17/bin', '/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/opt/postgresql@17/bin', '/usr/local/opt/postgresql@16/bin', '/Applications/Postgres.app/Contents/Versions/latest/bin');
  for (const dir of candidates.filter(Boolean)) {
    if (['initdb', 'pg_ctl', 'psql'].every((bin) => existsSync(join(dir, bin)))) return { initdb: join(dir, 'initdb'), pgctl: join(dir, 'pg_ctl'), psql: join(dir, 'psql') };
  }
  fail('PostgreSQL 16+ client and server binaries were not found. Install PostgreSQL 16 (for example `brew install postgresql@16`) or set HON_TESTENV_PG_BIN to its bin folder.');
}

function minimalEnv(extra) {
  const base = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? homedir(), LANG: 'C.UTF-8' };
  if (process.env.TMPDIR) base.TMPDIR = process.env.TMPDIR;
  return { ...base, ...extra };
}
function run(binary, args, { env = minimalEnv({}), input, cwd = repoRoot, quiet = false, redact = [] } = {}) {
  const result = spawnSync(binary, args, { cwd, env, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    let output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    for (const secret of redact) output = output.replaceAll(secret, '[REDACTED]');
    fail(`${binary.split('/').pop()} ${args[0] ?? ''} failed (exit ${result.status}).\n${output.slice(-4000)}`);
  }
  if (!quiet && result.stdout?.trim()) log(result.stdout.trim().split('\n').slice(-3).join('\n'));
  return result.stdout;
}

function writePrivate(path, content) { writeFileSync(path, content, { mode: 0o600 }); chmodSync(path, 0o600); }

function ensureState(dir, { requireFresh = false } = {}) {
  validateStateDirectory(dir, { root: repoRoot, requireFresh });
  if (!requireFresh && existsSync(dir)) {
    // The exact marker, ownership, private permissions and non-linked paths were checked above.
  } else {
    // Require an existing parent; never silently adopt a directory created by a racing caller.
    mkdirSync(dir, { mode: 0o700 });
    writePrivate(join(dir, 'MARKER'), `${MARKER}\n`);
  }
  validateStateDirectory(dir, { root: repoRoot });
  const secretsPath = join(dir, 'secrets.json');
  if (!existsSync(secretsPath)) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    writePrivate(secretsPath, `${JSON.stringify({
      createdAt: new Date().toISOString(),
      accessCode: randomBytes(12).toString('base64url'),
      sessionSecret: randomBytes(48).toString('base64url'),
      sessionAudience: `hon-testenv-${randomBytes(8).toString('hex')}`,
      postgresPassword: randomBytes(36).toString('base64url'),
      runtimePassword: randomBytes(36).toString('base64url'),
      idpKeyId: randomBytes(8).toString('hex'),
      idpPrivateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }, null, 2)}\n`);
    log(`Created private test secrets in ${secretsPath}`);
  }
  const secrets = JSON.parse(readFileSync(secretsPath, 'utf8'));
  createPrivateKey(secrets.idpPrivateKeyPem);
  return secrets;
}

function ensureTls(dir) {
  const tls = join(dir, 'tls');
  const files = { ca: join(tls, 'ca.pem'), cert: join(tls, 'localhost.pem'), key: join(tls, 'localhost-key.pem') };
  if (Object.values(files).every(existsSync)) return files;
  mkdirSync(tls, { mode: 0o700, recursive: true });
  const caKey = join(tls, 'ca-key.pem');
  const config = join(tls, 'leaf.cnf');
  writePrivate(config, ['[req]', 'distinguished_name=dn', 'prompt=no', '[dn]', 'CN=localhost', '[ext]', 'subjectAltName=DNS:localhost,IP:127.0.0.1', 'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth', ''].join('\n'));
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', files.ca, '-days', '825', '-subj', '/CN=HON OS private test environment local CA', '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], { quiet: true });
  run('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', files.key, '-out', join(tls, 'localhost.csr'), '-config', config], { quiet: true });
  run('openssl', ['x509', '-req', '-in', join(tls, 'localhost.csr'), '-CA', files.ca, '-CAkey', caKey, '-CAcreateserial', '-out', files.cert, '-days', '825', '-extfile', config, '-extensions', 'ext'], { quiet: true });
  for (const file of [caKey, files.key]) chmodSync(file, 0o600);
  log(`Created a local-only HTTPS certificate authority at ${files.ca}`);
  return files;
}

function portOpen(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('error', () => done(false));
  });
}
async function waitFor(check, label, attempts = 240) {
  for (let i = 0; i < attempts; i += 1) { if (await check()) return; await new Promise((r) => setTimeout(r, 250)); }
  fail(`${label} did not become ready.`);
}

function databaseUrls(secrets) {
  const host = `127.0.0.1:${PORTS.postgres}`;
  return {
    admin: `postgresql://postgres:${secrets.postgresPassword}@${host}/${DATABASE}`,
    adminBootstrap: `postgresql://postgres:${secrets.postgresPassword}@${host}/postgres`,
    runtime: `postgresql://hon_runtime:${secrets.runtimePassword}@${host}/${DATABASE}`,
  };
}

async function startDatabase(dir, secrets, pg) {
  const data = join(dir, 'pgdata');
  const fresh = !existsSync(join(data, 'PG_VERSION'));
  if (fresh) {
    const pwfile = join(dir, '.pwfile');
    writePrivate(pwfile, `${secrets.postgresPassword}\n`);
    run(pg.initdb, ['-D', data, '-U', 'postgres', '--pwfile', pwfile, '--auth-local=scram-sha-256', '--auth-host=scram-sha-256', '--no-locale', '--encoding=UTF8'], { quiet: true });
    rmSync(pwfile);
    mkdirSync(join(data, 'socket'), { mode: 0o700 });
    log('Initialised a private PostgreSQL cluster.');
  }
  if (await portOpen(PORTS.postgres)) fail(`Port ${PORTS.postgres} is already in use. Stop the other process (or a previous test environment) first.`);
  const stopDatabase = () => {
    const result = spawnSync(pg.pgctl, ['-D', data, '-m', 'fast', '-w', 'stop'], { env: minimalEnv({}), stdio: 'ignore' });
    if (result.status !== 0) throw new Error('Private PostgreSQL shutdown failed; operator inspection is required.');
  };
  // pg_ctl can report a readiness failure after launching the server; register first.
  cleanup.add(stopDatabase);
  run(pg.pgctl, ['-D', data, '-l', join(data, 'postgres.log'), '-o', `-p ${PORTS.postgres} -h 127.0.0.1 -k ${join(data, 'socket')}`, '-w', 'start'], { quiet: true });
  const urls = databaseUrls(secrets);
  const psqlEnv = minimalEnv({ PGPASSWORD: secrets.postgresPassword });
  const psql = (sql, database = DATABASE) => run(pg.psql, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(PORTS.postgres), '-U', 'postgres', '-d', database], { env: psqlEnv, input: sql, quiet: true, redact: [secrets.postgresPassword, secrets.runtimePassword] });
  if (fresh) {
    // hon_runtime must exist before migrations so their conditional grants apply, exactly as on Supabase.
    psql(`COMMENT ON DATABASE postgres IS '${MARKER}';
CREATE ROLE hon_runtime LOGIN PASSWORD '${secrets.runtimePassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 20;
CREATE DATABASE ${DATABASE}; COMMENT ON DATABASE ${DATABASE} IS '${MARKER}';
REVOKE ALL ON DATABASE ${DATABASE} FROM PUBLIC;`, 'postgres');
  }
  log('Applying repository migrations (only new ones run after the first start)...');
  run(process.execPath, [join(repoRoot, 'packages/database/scripts/migrate.mjs')], { env: minimalEnv({ DATABASE_URL: urls.admin }), quiet: true, redact: [secrets.postgresPassword] });
  const runtimeAcl = readFileSync(join(repoRoot, 'infra/postgres/010_supabase_hon_runtime.sql'), 'utf8').replaceAll('DATABASE postgres', `DATABASE ${DATABASE}`);
  psql(runtimeAcl);
  const count = run(pg.psql, ['-X', '-tA', '-h', '127.0.0.1', '-p', String(PORTS.postgres), '-U', 'postgres', '-d', DATABASE, '-c', "SELECT count(*) FROM hon.schema_migrations"], { env: psqlEnv, quiet: true }).trim();
  log(`Database ready: ${count} migrations applied; API connects as restricted hon_runtime.`);
  return { data, urls };
}

function bootstrapHqOwner(urls) {
  const hq = TEST_IDENTITIES.find((identity) => identity.key === 'hq-owner');
  run(process.execPath, [join(repoRoot, 'packages/database/scripts/bootstrap-hq-owner.mjs')], {
    env: minimalEnv({ DATABASE_URL: urls.admin, HON_HQ_OWNER_EXTERNAL_SUBJECT: honExternalSubject(ISSUER, hq.sub), HON_HQ_OWNER_EMAIL: hq.email, HON_HQ_OWNER_DISPLAY_NAME: hq.name }),
    quiet: true,
  });
  log(`HQ owner grant active for test identity "${hq.name}" only.`);
}

export function applicationEnvironment(secrets, urls, tls) {
  const session = {
    HON_AUTH_MODE: 'OIDC', HON_SESSION_JWT_SECRET: secrets.sessionSecret, HON_SESSION_AUDIENCE: secrets.sessionAudience,
    HON_SESSION_VERIFIED_EMAIL_ENABLED: 'true', HON_PUBLIC_ORIGIN: ORIGIN, NODE_ENV: 'production', HON_DEPLOYMENT_ENVIRONMENT: 'preview',
  };
  return {
    api: minimalEnv({ ...session, HON_RUNTIME_DATABASE_URL: urls.runtime, HON_API_PORT: String(PORTS.api), HON_API_LISTEN_HOST: '127.0.0.1' }),
    web: minimalEnv({
      ...session, NEXT_TELEMETRY_DISABLED: '1', HON_API_BASE_URL: `http://127.0.0.1:${PORTS.api}`, NODE_EXTRA_CA_CERTS: tls.ca,
      HON_OIDC_ISSUER: ISSUER, HON_OIDC_AUTHORIZATION_ENDPOINT: `${ISSUER}/authorize`, HON_OIDC_TOKEN_ENDPOINT: `${ISSUER}/token`, HON_OIDC_JWKS_URI: `${ISSUER}/jwks`,
      HON_OIDC_CLIENT_ID: CLIENT_ID, HON_OIDC_SCOPES: 'openid profile email', HON_OIDC_REDIRECT_URI: `${ORIGIN}/auth/callback`,
      HON_OIDC_TOKEN_ENDPOINT_AUTH_METHOD: 'none', HON_OIDC_ID_TOKEN_ALGORITHMS: 'RS256',
    }),
  };
}

function startChild(label, args, env, logDir, cwd = repoRoot) {
  const out = join(logDir, `${label}.log`);
  writePrivate(out, '');
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const append = (chunk) => { try { writeFileSync(out, chunk, { flag: 'a' }); } catch { /* best effort */ } };
  child.stdout.on('data', append); child.stderr.on('data', append);
  child.on('error', () => { if (!shuttingDown) { process.stderr.write(`[testenv] ${label} could not start.\n`); void shutdown(1); } });
  child.on('exit', (code, signal) => { if (!shuttingDown) { process.stderr.write(`[testenv] ${label} stopped unexpectedly (${code ?? signal}). See ${out}\n`); void shutdown(1); } });
  return child;
}

let shuttingDown = false;
const cleanup = createCleanupStack();
function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  return new Promise((done) => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(timeout); done(); });
    child.kill('SIGTERM');
  });
}
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('Stopping...');
  const errors = await cleanup.close();
  if (errors.length) process.stderr.write(`[testenv] ${errors.length} resource shutdown failure(s); inspect this private environment before restarting or deleting it.\n`);
  process.exit(errors.length ? 1 : code);
}

async function up(args) {
  if (typeof process.getuid === 'function' && process.getuid() === 0) fail('Run the test environment as your normal user, not as root (PostgreSQL refuses to run as root).');
  const problems = refuseUnsafeInvocation();
  if (problems.length) fail(problems.join('\n'));
  const dir = stateDirectory(process.env, { requireFresh: args.includes('--fresh') });
  if (!['apps/api/dist/main.js', 'apps/web/.next/BUILD_ID', 'packages/database/dist/index.js'].every((file) => existsSync(join(repoRoot, file))) || args.includes('--build')) {
    log('Building the application from this checkout (pnpm build)...');
    const build = spawnSync('pnpm', ['build'], { cwd: repoRoot, env: minimalEnv({ NEXT_TELEMETRY_DISABLED: '1' }), stdio: 'inherit' });
    if (build.status !== 0) fail('pnpm build failed.');
  }
  for (const port of [PORTS.gateway, PORTS.web, PORTS.api]) if (await portOpen(port)) fail(`Port ${port} is already in use. Stop the other process first.`);
  const secrets = ensureState(dir, { requireFresh: args.includes('--fresh') });
  const tls = ensureTls(dir);
  const logDir = join(dir, 'logs');
  mkdirSync(logDir, { mode: 0o700, recursive: true });
  const pg = postgresBinaries();
  process.on('SIGINT', () => shutdown(0)); process.on('SIGTERM', () => shutdown(0));
  const database = await startDatabase(dir, secrets, pg);
  bootstrapHqOwner(database.urls);

  const env = applicationEnvironment(secrets, database.urls, tls);
  const api = startChild('api', [join(repoRoot, 'apps/api/dist/main.js')], env.api, logDir);
  cleanup.add(() => stopChild(api));
  const nextBin = join(repoRoot, 'apps/web/node_modules/next/dist/bin/next');
  const web = startChild('web', [nextBin, 'start', '--hostname', '127.0.0.1', '--port', String(PORTS.web)], env.web, logDir, join(repoRoot, 'apps/web'));
  cleanup.add(() => stopChild(web));

  const idp = await createTestIdentityProvider({ issuer: ISSUER, clientId: CLIENT_ID, redirectUri: `${ORIGIN}/auth/callback`, accessCode: secrets.accessCode, privateKeyPem: secrets.idpPrivateKeyPem, keyId: secrets.idpKeyId });
  const gateway = createHttpsServer({ cert: readFileSync(tls.cert), key: readFileSync(tls.key) }, (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === idp.basePath || path.startsWith(`${idp.basePath}/`)) { idp.handler(req, res); return; }
    const upstream = httpRequest({ host: '127.0.0.1', port: PORTS.web, method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-host': `localhost:${PORTS.gateway}` } }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('HON OS web app is starting or unavailable. Retry in a few seconds.'); });
    req.pipe(upstream);
  });
  cleanup.add(() => new Promise((done) => { gateway.close(() => done()); gateway.closeAllConnections(); }));
  await new Promise((done, reject) => { gateway.once('error', reject); gateway.listen(PORTS.gateway, '127.0.0.1', done); });

  await waitFor(() => portOpen(PORTS.api), 'API');
  await waitFor(() => portOpen(PORTS.web), 'Web app');
  log('');
  log('HON OS private test environment is running on this computer only.');
  log(`  Open:          ${ORIGIN}/auth/login`);
  log(`  Access code:   ${secrets.accessCode}`);
  log('  Test people:   HQ Owner, School A Owner, School B Owner, Unprovisioned visitor');
  log(`  Built from:    ${spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim() || 'unknown commit'}`);
  log(`  Data kept in:  ${dir} (delete with: pnpm testenv:reset --confirm-delete-test-data)`);
  log(`  Browser warning: trust ${tls.ca} once, or accept the localhost certificate warning.`);
  log('  Press Ctrl+C to stop. Your test data is kept for next time.');
}

function reset(args) {
  if (!args.includes('--confirm-delete-test-data')) fail('This permanently deletes all test environment data. Re-run with --confirm-delete-test-data.');
  const dir = stateDirectory();
  if (!existsSync(dir)) { log('Nothing to delete.'); return; }
  if (readFileSync(join(dir, 'MARKER'), 'utf8').trim() !== MARKER) fail(`${dir} does not carry the test environment marker; refusing to delete it.`);
  if (existsSync(join(dir, 'pgdata', 'postmaster.pid'))) fail('The test database appears to be running. Stop the environment (Ctrl+C) first.');
  rmSync(dir, { recursive: true, force: true });
  log(`Deleted ${dir}. The next start creates a fresh empty environment.`);
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

// Create a NON-PRODUCTION school through the real HQ provisioning API, signed in as the test HQ
// owner. The HQ provisioning screen exists in the codebase but is not yet placed on an HQ page, so
// this is the owner's way to reach that same API. Authority is checked by the API, not here.
async function createSchool(args) {
  const dir = stateDirectory();
  if (!existsSync(join(dir, 'MARKER'))) fail('Start the environment first: pnpm testenv:up');
  const secrets = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'));
  const name = option(args, '--name') ?? 'Test Dojo A';
  const slug = (option(args, '--slug') ?? name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  const timezone = option(args, '--timezone') ?? 'America/Los_Angeles';
  const tier = option(args, '--tier') ?? 'CORE';
  const as = option(args, '--as') ?? 'hq-owner';
  const session = await signIn({ origin: ORIGIN, caFile: join(dir, 'tls', 'ca.pem'), identityKey: as, accessCode: secrets.accessCode });
  const response = await session.api('POST', '/api/v1/hq/organizations', {
    headers: { 'Idempotency-Key': `testenv-create-school-${slug}` },
    json: { legalName: `${name} (non-production test) LLC`, displayName: name, schoolName: `${name} — Main`, schoolSlug: slug, timezone, initialTier: tier },
  });
  if (response.status !== 200 && response.status !== 201) fail(`HQ provisioning was refused (HTTP ${response.status}): ${response.body.slice(0, 300)}`);
  const result = response.data?.data ?? {};
  log(`${response.status === 200 ? 'Already existed (same request replayed)' : 'Created'} non-production school "${name}" as ${as}.`);
  log(`  Organization: ${result.organizationId ?? 'see HQ > Schools'}   School: ${result.schoolId ?? 'see HQ > Schools'}`);
  log('  Next: in HQ > School owner invitations, invite one of the test school-owner emails, then sign in as that owner.');
}

function status() {
  const dir = stateDirectory();
  if (!existsSync(join(dir, 'MARKER'))) { log('No test environment has been created yet. Run: pnpm testenv:up'); return; }
  const secrets = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'));
  log(`State directory: ${dir}`);
  log(`Created: ${secrets.createdAt}`);
  log(`Open: ${ORIGIN}/auth/login   Access code: ${secrets.accessCode}`);
  log(`Database running: ${existsSync(join(dir, 'pgdata', 'postmaster.pid')) ? 'yes' : 'no'}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command = 'help', ...args] = process.argv.slice(2);
  try {
    if (command === 'up') await up(args);
    else if (command === 'reset') reset(args);
    else if (command === 'status') status();
    else if (command === 'create-school') await createSchool(args);
    else log('Usage: node scripts/testenv/testenv.mjs up [--build] [--fresh] | status | create-school [--name "Test Dojo A"] [--tier CORE] | reset --confirm-delete-test-data');
  } catch (error) {
    process.stderr.write(`[testenv] ${error.message}\n`);
    await shutdown(1);
  }
}

export const TESTENV = Object.freeze({ PORTS, ORIGIN, ISSUER, CLIENT_ID, DATABASE });
