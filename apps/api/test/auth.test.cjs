const { test, afterEach, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { issueSession, sessionConfig, HON_SESSION_COOKIE } = require('@hon/auth');
const { HonIdentityService } = require('../dist/foundation/hon-identity.service.js');
const { ManusIdentityService } = require('../dist/foundation/manus-identity.service.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { SessionContextController } = require('../dist/foundation/session-context.controller.js');
let saved;
beforeEach(() => {
  saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (/^(MANUS_|HON_AUTH_|HON_SESSION_)/.test(key)) delete process.env[key];
  Object.assign(process.env, { NODE_ENV: 'production', HON_AUTH_MODE: 'OIDC', HON_SESSION_JWT_SECRET: 'TEST_ONLY_HON_KEY_123456789012345678901234', HON_SESSION_AUDIENCE: 'hon-api-test' });
});
afterEach(() => { process.env = saved; });
const identity = { externalSubject: 'oidc:issuer:user', displayName: 'Test User', email: 'test@example.invalid' };
const request = (token) => ({ headers: { cookie: `${HON_SESSION_COOKIE}=${token}`, authorization: 'Bearer RAW_AUTHORIZATION_DO_NOT_LEAK' } });
const errorStatus = (status) => (error) => { assert.equal(error.getStatus(), status); assert.doesNotMatch(JSON.stringify(error.getResponse()), /RAW_|Bearer|Authorization|eyJ/); return true; };

test('OIDC API requires only HON session settings, no Manus environment or legacy token', () => {
  const config = sessionConfig();
  assert.deepEqual(new HonIdentityService().authenticate(request(issueSession(identity, config))), identity);
  assert.equal(ManusIdentityService, HonIdentityService);
  assert.throws(() => new HonIdentityService().authenticate({ headers: { cookie: 'webdev_app_session=RAW_LEGACY_TOKEN' } }), errorStatus(401));
  assert.throws(() => new HonIdentityService().authenticate({ headers: { authorization: 'Bearer RAW_TOKEN' } }), errorStatus(401));
});

test('guard attaches only normalized identity and existing scope resolver still controls tenant access', async () => {
  const req = request(issueSession(identity, sessionConfig()));
  const guard = new HonIdentityGuard(new HonIdentityService());
  assert.equal(guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) }), true);
  assert.deepEqual(req.honIdentity, identity);
  const calls = [];
  const controller = new SessionContextController({ resolveAuthorizedScope: async (...args) => {
    calls.push(args); return { principalId: 'iam-principal', organizationId: 'allowed-org', schoolId: 'allowed-school' };
  } });
  assert.deepEqual(await controller.sessionContext('allowed-org', 'allowed-school', req), { principalId: 'iam-principal', organizationId: 'allowed-org', schoolId: 'allowed-school' });
  assert.deepEqual(calls[0], [identity.externalSubject, 'allowed-school', 'school.view']);
  await assert.rejects(() => controller.sessionContext('cross-tenant-org', 'allowed-school', req), errorStatus(403));
  const denied = new SessionContextController({ resolveAuthorizedScope: async () => undefined });
  await assert.rejects(() => denied.sessionContext('allowed-org', 'allowed-school', req), errorStatus(403));
});

test('development HON session uses the identical guard/scope path, never raw Manus cookies', () => {
  Object.assign(process.env, { HON_AUTH_MODE: 'MANUS_DEVELOPMENT', MANUS_PROJECT_ID: 'dev-app' });
  const config = sessionConfig();
  assert.deepEqual(new HonIdentityService().authenticate(request(issueSession(identity, config))), identity);
  assert.throws(() => new HonIdentityService().authenticate({ headers: { cookie: 'webdev_app_session=RAW_TOKEN' } }), errorStatus(401));
});

test('forged, wrong-app, wrong-mode, expired and malformed sessions fail closed without leaks', () => {
  const config = sessionConfig();
  for (const token of [
    issueSession(identity, { ...config, secret: 'FORGED_KEY' }),
    issueSession(identity, { ...config, audience: 'other-app' }),
    issueSession(identity, { ...config, mode: 'MANUS_DEVELOPMENT' }),
    issueSession(identity, config, Math.floor(Date.now() / 1000) - 43_201), 'RAW_INVALID_TOKEN',
  ]) assert.throws(() => new HonIdentityService().authenticate(request(token)), errorStatus(401));
  assert.throws(() => new HonIdentityService().authenticate({ headers: { cookie: 'hon_session=%XX' } }), errorStatus(401));
});

test('invalid mode and missing HON configuration never fall back to Manus or bypass authentication', () => {
  for (const patch of [{ HON_AUTH_MODE: '' }, { HON_AUTH_MODE: 'oidc' }, { HON_AUTH_MODE: undefined }, { HON_SESSION_JWT_SECRET: undefined }, { HON_SESSION_AUDIENCE: undefined }]) {
    const old = { ...process.env };
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    assert.throws(() => new HonIdentityService().authenticate({ headers: { cookie: 'hon_session=RAW_SECRET_TOKEN' } }), errorStatus(503));
    process.env = old;
  }
});
