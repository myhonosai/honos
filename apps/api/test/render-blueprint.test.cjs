// Render Blueprint (render.yaml) guard. The Blueprint is deployment configuration David applies in
// his own Render account; nothing here contacts Render, Supabase or any provider. These tests pin
// the safety properties of that file and prove the values it fixes pass HON's own startup gates.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const yaml = require('js-yaml');
require('reflect-metadata');
const { oidcConfig, sessionConfig } = require('@hon/auth');
const { validateDeploymentConfiguration } = require('../dist/foundation/production-config.js');

const ROOT = join(__dirname, '..', '..', '..');
const blueprint = yaml.load(readFileSync(join(ROOT, 'render.yaml'), 'utf8'));
const service = (name) => blueprint.services.find((candidate) => candidate.name === name);
const api = service('hon-api');
const web = service('hon-web');
const group = (name) => (blueprint.envVarGroups ?? []).find((candidate) => candidate.name === name);

/** Every env var a service receives: its own plus the groups it references. */
function envVars(svc) {
  const own = svc.envVars ?? [];
  const grouped = own.filter((entry) => entry.fromGroup).flatMap((entry) => group(entry.fromGroup).envVars);
  return [...own.filter((entry) => entry.key), ...grouped];
}

// Synthetic stand-ins for values David enters in the dashboard (sync: false) or Render generates.
// Not real endpoints or credentials.
const CA = '-----BEGIN CERTIFICATE-----\nMIIBTESTONLYNOTAREALCERTIFICATE\n-----END CERTIFICATE-----\n';
const DASHBOARD = {
  HON_RUNTIME_DATABASE_URL: 'postgresql://hon_runtime.projectref:SYNTHETIC@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
  HON_DATABASE_CA_CERT: CA,
  HON_PUBLIC_ORIGIN: 'https://app.example.test',
  HON_API_BASE_URL: 'http://hon-api-internal:3001',
  HON_OIDC_ISSUER: 'https://id.example.test/',
  HON_OIDC_AUTHORIZATION_ENDPOINT: 'https://id.example.test/authorize',
  HON_OIDC_TOKEN_ENDPOINT: 'https://id.example.test/oauth/token',
  HON_OIDC_JWKS_URI: 'https://id.example.test/.well-known/jwks.json',
  HON_OIDC_CLIENT_ID: 'synthetic-client',
  HON_OIDC_CLIENT_SECRET: 'synthetic-client-secret-value',
  HON_OIDC_REDIRECT_URI: 'https://app.example.test/auth/callback',
  HON_OIDC_END_SESSION_ENDPOINT: 'https://id.example.test/v2/logout',
};
const GENERATED = 'c3ludGhldGljLWdlbmVyYXRlZC1zZXNzaW9uLXNlY3JldA==';

function resolvedEnv(svc, { withDashboard = true } = {}) {
  const env = {};
  for (const entry of envVars(svc)) {
    if (entry.value !== undefined) env[entry.key] = String(entry.value);
    else if (entry.generateValue) env[entry.key] = GENERATED;
    else if (entry.sync === false && withDashboard) {
      assert.ok(Object.hasOwn(DASHBOARD, entry.key), `test has no synthetic value for ${entry.key}`);
      env[entry.key] = DASHBOARD[entry.key];
    }
  }
  return env;
}

test('two services: a private API and the only public web service, in the Supabase region', () => {
  assert.equal(blueprint.services.length, 2);
  assert.equal(api.type, 'pserv', 'the API must not get a public onrender.com URL');
  assert.equal(web.type, 'web');
  for (const svc of [api, web]) {
    assert.equal(svc.runtime, 'node');
    assert.equal(svc.region, 'virginia', 'Supabase hon project is us-east-1');
    assert.equal(svc.branch, 'main');
  }
});

test('nothing deploys by itself: no auto-deploy, no previews, no pre-deploy migrations', () => {
  assert.equal(blueprint.previews?.generation, 'off');
  for (const svc of [api, web]) {
    assert.equal(svc.autoDeployTrigger, 'off', `${svc.name} must only deploy manually`);
    assert.notEqual(svc.autoDeploy, true);
    assert.equal(svc.preDeployCommand, undefined, 'migrations need the owner and the migration role, never a deploy hook');
    assert.doesNotMatch(`${svc.buildCommand} ${svc.startCommand}`, /db:migrate|migrate\.mjs|bootstrap/);
  }
});

test('builds use the CI Node pin, the locked pnpm and keep dev dependencies under NODE_ENV=production', () => {
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const pin = /node-version:\s*([0-9.]+)/.exec(ci)[1];
  const packageManager = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).packageManager;
  for (const svc of [api, web]) {
    const env = resolvedEnv(svc);
    assert.equal(env.NODE_VERSION, pin);
    assert.equal(env.NODE_ENV, 'production');
    assert.match(svc.buildCommand, /pnpm install --frozen-lockfile --prod=false/);
    assert.ok(svc.buildCommand.includes(packageManager), 'activate exactly the lockfile pnpm');
    assert.match(svc.buildCommand, /node \.github\/scripts\/verify-node-runtime\.mjs --expect /);
  }
  assert.match(api.buildCommand, /pnpm --filter @hon\/api build/);
  assert.equal(api.startCommand, 'pnpm --filter @hon/api start');
  assert.match(web.buildCommand, /pnpm --filter @hon\/web build/);
  assert.equal(web.startCommand, 'pnpm --filter @hon/web start');
  assert.equal(resolvedEnv(api).HON_API_PORT, resolvedEnv(api).PORT);
  assert.equal(resolvedEnv(web).PORT, '3000', 'next start listens on 3000');
});

test('the web health check is the side-effect-free sign-in readiness route', () => {
  assert.equal(web.healthCheckPath, '/api/identity/readiness');
  assert.ok(existsSync(join(ROOT, 'apps', 'web', 'src', 'app', 'api', 'identity', 'readiness', 'route.ts')));
});

test('no money, paid AI, messaging, development auth or migration credential is configured', () => {
  const forbidden = /^(DATABASE_URL|OPENROUTER_.*|STRIPE_.*|ZERNIO_.*|HON_ZERNIO_.*|MANUS_.*|HON_MIGRATION_.*)$/;
  for (const svc of [api, web]) {
    for (const entry of envVars(svc)) assert.doesNotMatch(entry.key, forbidden, `${svc.name} must not declare ${entry.key}`);
  }
});

test('secrets and account-specific values never have a literal value in Git', () => {
  const secretLike = /(SECRET|PASSWORD|TOKEN|_URL$|_URI$|CA_CERT|CLIENT_ID|ORIGIN|ISSUER|ENDPOINT)/;
  for (const svc of [api, web]) {
    for (const entry of envVars(svc)) {
      if (!secretLike.test(entry.key) || ['HON_OIDC_SCOPES', 'HON_OIDC_TOKEN_ENDPOINT_AUTH_METHOD'].includes(entry.key)) continue;
      assert.equal(entry.value, undefined, `${svc.name} ${entry.key} must be sync:false or generated`);
      assert.ok(entry.sync === false || entry.generateValue === true, `${svc.name} ${entry.key} needs sync:false or generateValue`);
    }
  }
  // Render ignores sync:false inside env groups, so groups may only hold generated or fixed values.
  for (const candidate of blueprint.envVarGroups ?? []) {
    for (const entry of candidate.envVars) assert.notEqual(entry.sync, false, `${candidate.name}.${entry.key}`);
  }
});

test('the deployment label is fixed to staging in Git, with OIDC sign-in, on both services', () => {
  for (const svc of [api, web]) {
    const env = resolvedEnv(svc);
    assert.equal(env.HON_DEPLOYMENT_ENVIRONMENT, 'staging', 'promoting to production is a reviewed change');
    assert.equal(env.HON_AUTH_MODE, 'OIDC');
  }
  const sharedSession = (svc) => (svc.envVars ?? []).some((entry) => entry.fromGroup === 'hon-session');
  assert.ok(sharedSession(api) && sharedSession(web), 'API and web must verify the same session key');
  const secret = group('hon-session').envVars.find((entry) => entry.key === 'HON_SESSION_JWT_SECRET');
  assert.equal(secret.generateValue, true);
});

test('the API environment from the Blueprint passes the production startup gate, and fails closed without dashboard values', () => {
  assert.deepEqual(validateDeploymentConfiguration(resolvedEnv(api)).failures, []);
  // Kiosk, public forms and Champions Club origin checks fail closed without the public origin.
  assert.equal(resolvedEnv(api).HON_PUBLIC_ORIGIN, DASHBOARD.HON_PUBLIC_ORIGIN);
  assert.equal(validateDeploymentConfiguration(resolvedEnv(api)).deployment, 'staging');
  const missing = validateDeploymentConfiguration(resolvedEnv(api, { withDashboard: false })).failures;
  assert.ok(missing.includes('RUNTIME_DATABASE_URL_REQUIRED'), missing.join(','));
  // The same file promoted to production still passes; a mislabel or a migration credential does not.
  assert.deepEqual(validateDeploymentConfiguration({ ...resolvedEnv(api), HON_DEPLOYMENT_ENVIRONMENT: 'production' }).failures, []);
  assert.ok(validateDeploymentConfiguration({ ...resolvedEnv(api), DATABASE_URL: 'postgresql://postgres.ref:x@db.example.test:5432/postgres' })
    .failures.includes('MIGRATION_CREDENTIAL_IN_API_PROCESS'));
});

test('the web environment from the Blueprint passes the shared OIDC and session validation', () => {
  const env = resolvedEnv(web);
  assert.doesNotThrow(() => sessionConfig(env));
  assert.doesNotThrow(() => oidcConfig(env));
  assert.throws(() => oidcConfig(resolvedEnv(web, { withDashboard: false })));
  // The web server only needs the API address; it never receives a database credential.
  assert.ok(!Object.keys(env).some((key) => /DATABASE/.test(key)));
});
