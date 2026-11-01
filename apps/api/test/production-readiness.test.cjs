const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');
require('reflect-metadata');
const { verifiedDatabaseConnection, isLoopbackDatabaseUrl } = require('@hon/database');
const { runtimePoolOptions, runtimePoolMax } = require('../dist/foundation/runtime-pool-options.js');
const { apiListenHost, validateDeploymentConfiguration } = require('../dist/foundation/production-config.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { setTelemetryWriter, resetTelemetryRateLimit } = require('../dist/observability/telemetry.js');

const CA = '-----BEGIN CERTIFICATE-----\nMIIBTESTONLYNOTAREALCERTIFICATE\n-----END CERTIFICATE-----\n';
const REMOTE = 'postgresql://hon_runtime.projectref:RUNTIME_PASSWORD_DO_NOT_LEAK@aws-0-us-east-1.pooler.supabase.com:5432/postgres';
let saved;
afterEach(() => { if (saved) process.env = saved; saved = undefined; setTelemetryWriter(undefined); resetTelemetryRateLimit(); });

test('remote database connections always verify the certificate chain and host name', () => {
  assert.deepEqual(verifiedDatabaseConnection(REMOTE, { HON_DATABASE_CA_CERT: CA }), { connectionString: REMOTE, ssl: { ca: CA, rejectUnauthorized: true } });
  assert.equal(verifiedDatabaseConnection(REMOTE, { HON_DATABASE_CA_CERT: CA.replaceAll('\n', '\\n') }).ssl.ca, CA);
  for (const local of ['postgresql://u:p@localhost:5432/db', 'postgresql://u:p@127.0.0.1/db', 'postgresql://u:p@[::1]:5432/db']) {
    assert.deepEqual(verifiedDatabaseConnection(local, {}), { connectionString: local, ssl: false });
    assert.equal(isLoopbackDatabaseUrl(local), true);
  }
  assert.equal(isLoopbackDatabaseUrl(REMOTE), false);
});

test('a remote database without a CA, or with URL TLS/host overrides, is refused without leaking values', () => {
  const refused = (url, env, pattern) => assert.throws(() => verifiedDatabaseConnection(url, env), (error) => {
    assert.match(error.message, pattern);
    assert.doesNotMatch(error.message, /RUNTIME_PASSWORD|pooler\.supabase|BEGIN CERTIFICATE/);
    return true;
  });
  refused(REMOTE, {}, /requires HON_DATABASE_CA_CERT or HON_DATABASE_CA_CERT_FILE/);
  refused(REMOTE, { HON_DATABASE_CA_CERT: 'not a certificate' }, /PEM certificate/);
  refused(REMOTE, { HON_DATABASE_CA_CERT: `${CA}-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----` }, /PEM certificate/);
  refused(REMOTE, { HON_DATABASE_CA_CERT: CA, HON_DATABASE_CA_CERT_FILE: '/x' }, /only one/);
  refused(REMOTE, { HON_DATABASE_CA_CERT_FILE: '/nonexistent/hon-ca.pem' }, /cannot be read/);
  // node-postgres lets these URL parameters override the explicit ssl option or the host.
  for (const parameter of ['sslmode=disable', 'sslmode=no-verify', 'sslmode=require', 'ssl=false', 'SSLMODE=prefer', 'sslrootcert=/tmp/x', 'uselibpqcompat=true', 'host=evil.example', 'hostaddr=10.0.0.1']) {
    refused(`${REMOTE}?${parameter}`, { HON_DATABASE_CA_CERT: CA }, /URL parameter; HON configures and verifies TLS itself/);
  }
  // A loopback URL cannot be redirected to a remote host in plaintext.
  refused('postgresql://u:p@localhost/db?host=evil.example', {}, /"host" URL parameter/);
  refused('mysql://u:p@db.example/x', { HON_DATABASE_CA_CERT: CA }, /postgresql scheme/);
  refused('postgresql:///db', {}, /must name a host|cannot be parsed/);
});

test('runtime pool options verify TLS, bound the pool and recycle connections', () => {
  const options = runtimePoolOptions(REMOTE, { HON_DATABASE_CA_CERT: CA });
  assert.deepEqual(options.ssl, { ca: CA, rejectUnauthorized: true });
  assert.equal(options.max, 8);
  assert.equal(options.keepAlive, true);
  assert.equal(options.maxLifetimeSeconds, 1800);
  assert.equal(options.connectionTimeoutMillis, 5000);
  assert.equal(options.application_name, 'hon-api');
  assert.equal(runtimePoolMax({ HON_RUNTIME_DATABASE_POOL_MAX: '3' }), 3);
  for (const bad of ['0', '41', '-1', '1.5', 'eight', '']) assert.throws(() => runtimePoolMax({ HON_RUNTIME_DATABASE_POOL_MAX: bad }), /1 to 40/);
});

test('runtime database refuses an unverifiable remote database with the existing problem code and logs once', async () => {
  saved = { ...process.env };
  delete process.env.HON_DATABASE_CA_CERT; delete process.env.HON_DATABASE_CA_CERT_FILE;
  process.env.HON_RUNTIME_DATABASE_URL = REMOTE;
  const lines = [];
  setTelemetryWriter((line) => lines.push(line));
  const service = new RuntimeDatabaseService();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(service.probe(), (error) => {
      assert.equal(error.getStatus(), 503);
      assert.equal(error.getResponse().code, 'PERSISTENCE_NOT_CONFIGURED');
      assert.doesNotMatch(JSON.stringify(error.getResponse()), /RUNTIME_PASSWORD|pooler/);
      return true;
    });
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /"event":"database.configuration_invalid"/);
  assert.doesNotMatch(lines[0], /RUNTIME_PASSWORD|pooler\.supabase/);
  await service.onModuleDestroy();
});

const productionEnv = (patch = {}) => ({
  NODE_ENV: 'production', HON_DEPLOYMENT_ENVIRONMENT: 'production', HON_RUNTIME_DATABASE_URL: REMOTE, HON_DATABASE_CA_CERT: CA,
  HON_AUTH_MODE: 'OIDC', HON_SESSION_JWT_SECRET: 'TEST_ONLY_HON_KEY_123456789012345678901234', HON_SESSION_AUDIENCE: 'hon-api-test', ...patch,
});

test('a correctly configured production API starts', () => {
  assert.deepEqual(validateDeploymentConfiguration(productionEnv()), { deployment: 'production', failures: [] });
  assert.deepEqual(validateDeploymentConfiguration(productionEnv({ HON_DEPLOYMENT_ENVIRONMENT: 'staging' })), { deployment: 'staging', failures: [] });
  // Local development and the existing fixtures keep working unchanged.
  assert.deepEqual(validateDeploymentConfiguration({}), { deployment: 'development', failures: [] });
  assert.deepEqual(validateDeploymentConfiguration({ HON_RUNTIME_DATABASE_URL: 'postgresql://u:p@localhost:5432/db', DATABASE_URL: 'postgresql://o:p@localhost:5432/db' }).failures, []);
});

test('the API listen interface defaults to all interfaces and accepts only exact loopback or wildcard values', () => {
  assert.equal(apiListenHost({}), '0.0.0.0');
  for (const host of ['127.0.0.1', '::1', '0.0.0.0']) {
    assert.equal(apiListenHost({ HON_API_LISTEN_HOST: host }), host);
    assert.deepEqual(validateDeploymentConfiguration({ HON_API_LISTEN_HOST: host }).failures, []);
  }
  for (const host of ['', ' 127.0.0.1', 'localhost', '192.168.1.10', '127.0.0.1:3001', '::']) {
    assert.throws(() => apiListenHost({ HON_API_LISTEN_HOST: host }));
    assert.deepEqual(validateDeploymentConfiguration({ HON_API_LISTEN_HOST: host }).failures, ['API_LISTEN_HOST_INVALID']);
  }
});

test('production never silently falls back to development or unverified settings', () => {
  const failures = (env) => validateDeploymentConfiguration(env).failures;
  assert.deepEqual(failures(productionEnv({ HON_DEPLOYMENT_ENVIRONMENT: undefined })), ['DEPLOYMENT_ENVIRONMENT_REQUIRED']);
  assert.deepEqual(failures(productionEnv({ HON_DEPLOYMENT_ENVIRONMENT: 'prod' })), ['DEPLOYMENT_ENVIRONMENT_INVALID']);
  assert.deepEqual(failures(productionEnv({ HON_DEPLOYMENT_ENVIRONMENT: 'development' })), ['DEVELOPMENT_DEPLOYMENT_IN_PRODUCTION_BUILD']);
  assert.deepEqual(failures(productionEnv({ HON_DATABASE_CA_CERT: undefined })), ['RUNTIME_DATABASE_TLS_INVALID']);
  assert.deepEqual(failures(productionEnv({ HON_RUNTIME_DATABASE_URL: `${REMOTE}?sslmode=no-verify` })), ['RUNTIME_DATABASE_TLS_INVALID']);
  assert.deepEqual(failures(productionEnv({ HON_RUNTIME_DATABASE_URL: undefined })), ['RUNTIME_DATABASE_URL_REQUIRED']);
  assert.deepEqual(failures(productionEnv({ HON_RUNTIME_DATABASE_URL: 'postgresql://u:p@localhost:5432/db' })), ['RUNTIME_DATABASE_LOOPBACK_FORBIDDEN']);
  assert.deepEqual(failures(productionEnv({ DATABASE_URL: 'postgresql://postgres.projectref:x@db.projectref.supabase.co:5432/postgres' })), ['MIGRATION_CREDENTIAL_IN_API_PROCESS']);
  assert.deepEqual(failures(productionEnv({ DATABASE_URL: REMOTE })), ['MIGRATION_CREDENTIAL_IN_API_PROCESS', 'RUNTIME_USES_MIGRATION_ROLE']);
  assert.deepEqual(failures(productionEnv({ HON_AUTH_MODE: 'MANUS_DEVELOPMENT' })), ['OIDC_AUTH_REQUIRED']);
  assert.deepEqual(failures(productionEnv({ HON_SESSION_JWT_SECRET: 'short' })), ['SESSION_CONFIGURATION_INVALID']);
  assert.deepEqual(failures(productionEnv({ HON_RUNTIME_DATABASE_POOL_MAX: '500' })), ['RUNTIME_POOL_MAX_INVALID']);
  // Preview builds are labelled but still require verified TLS for any remote database.
  assert.deepEqual(failures(productionEnv({ HON_DEPLOYMENT_ENVIRONMENT: 'preview', HON_AUTH_MODE: 'MANUS_DEVELOPMENT', HON_DATABASE_CA_CERT: undefined })), ['RUNTIME_DATABASE_TLS_INVALID']);
  for (const code of failures(productionEnv({ HON_DATABASE_CA_CERT: undefined, DATABASE_URL: REMOTE }))) assert.match(code, /^[A-Z_]+$/);
});

function sourceFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (['node_modules', 'dist', '.next', 'test'].includes(name)) return [];
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx|mjs|cjs|js)$/.test(name) ? [path] : [];
  });
}

test('no runtime, migration, verifier or bootstrap path disables database certificate verification', () => {
  const root = join(__dirname, '..', '..', '..');
  const files = [...sourceFiles(join(root, 'apps')), ...sourceFiles(join(root, 'packages')), ...sourceFiles(join(root, 'scripts'))];
  const offenders = files
    // Disposable-database proof scripts connect only to localhost fixtures; the former
    // pattern there never applies TLS. Everything else must use verifiedDatabaseConnection.
    .filter((file) => !/packages\/database\/scripts\/test-[a-z0-9-]+\.mjs$/.test(file))
    .filter((file) => /rejectUnauthorized\s*:\s*false/.test(readFileSync(file, 'utf8')))
    .map((file) => relative(root, file));
  assert.deepEqual(offenders, []);
  for (const script of ['migrate.mjs', 'verify-rls.mjs', 'bootstrap-hq-owner.mjs', 'migration-status.mjs']) {
    assert.match(readFileSync(join(root, 'packages', 'database', 'scripts', script), 'utf8'), /verifiedDatabaseConnection\(/, script);
  }
});
