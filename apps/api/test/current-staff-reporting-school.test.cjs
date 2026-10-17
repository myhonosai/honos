const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { GUARDS_METADATA, PATH_METADATA } = require('@nestjs/common/constants');
const { issueSession, sessionConfig, HON_SESSION_COOKIE } = require('@hon/auth');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { HonIdentityService } = require('../dist/foundation/hon-identity.service.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { CurrentStaffReportingSchoolController, CurrentStaffReportingSchoolNoStoreGuard } = require('../dist/reports/current-staff-reporting-school.controller.js');
const scope = { organizationId: '11111111-1111-4111-8111-111111111111', schoolId: '22222222-2222-4222-8222-222222222222' };
const request = (subject = 'verified-staff') => ({ headers: { 'sec-fetch-site': 'same-origin' }, query: {}, honIdentity: { externalSubject: subject } });
const response = () => ({ setHeader(key, value) { assert.equal(key, 'Cache-Control'); assert.equal(value, 'private, no-store'); } });
const status = (expected) => (error) => { assert.equal(error.getStatus(), expected); assert.doesNotMatch(JSON.stringify(error.getResponse()), /PRIVATE_|candidate|count|eyJ/); return true; };

test('current reporting school binds the identity guard and accepts only its verified external subject', async () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, CurrentStaffReportingSchoolController), 'staff/current-reporting-school');
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, CurrentStaffReportingSchoolController), [CurrentStaffReportingSchoolNoStoreGuard, HonIdentityGuard]);
  const calls = [];
  const controller = new CurrentStaffReportingSchoolController({ resolveCurrentStaffReportingScope: async (...args) => { calls.push(args); return { ...scope, principalId: 'PRIVATE_PRINCIPAL' }; } });
  assert.deepEqual(await controller.read({ ...request(), principalId: 'forged', tier: 'COMPLETE', organizationId: 'forged' }, response()), { data: { state: 'RESOLVED', ...scope } });
  assert.deepEqual(calls, [['verified-staff']]);
});

test('zero, multiple, mixed, owner without reporting, family/HQ and unauthorized contexts share one closed nonresolution', async () => {
  const controller = new CurrentStaffReportingSchoolController({ resolveCurrentStaffReportingScope: async () => undefined });
  for (const subject of ['zero', 'multiple-schools', 'multiple-principals', 'staff+hq', 'staff+family', 'parent', 'guardian', 'student', 'family', 'hq', 'platform', 'system', 'unauthorized', 'owner-without-reporting']) {
    assert.deepEqual(await controller.read(request(subject), response()), { data: { state: 'MANUAL_ENTRY_REQUIRED' } });
  }
});

test('eligible single staff and single owner use the same reporting resolver, never owner-launch authority', async () => {
  const calls = [];
  const controller = new CurrentStaffReportingSchoolController({ resolveCurrentStaffReportingScope: async (subject) => { calls.push(subject); return scope; }, resolveOwnerLaunchScope: async () => { throw new Error('owner launch must not be used'); } });
  for (const subject of ['single-staff', 'single-owner-with-existing-staff-reporting-permission']) assert.deepEqual(await controller.read(request(subject), response()), { data: { state: 'RESOLVED', ...scope } });
  assert.equal(calls.length, 2);
});

test('query/body/header selectors, roles, tiers, delegation and cross-origin reads are refused before resolution', async () => {
  let calls = 0;
  const controller = new CurrentStaffReportingSchoolController({ resolveCurrentStaffReportingScope: async () => { calls++; return scope; } });
  for (const field of ['subject', 'principalId', 'organizationId', 'schoolId', 'role', 'tier', 'delegatedByPrincipalId', 'actionRequestId']) {
    await assert.rejects(() => controller.read({ ...request(), query: { [field]: 'forged' } }, response()), status(400));
    await assert.rejects(() => controller.read({ ...request(), body: { [field]: 'forged' } }, response()), status(400));
  }
  for (const body of [{}, [], '', 0, false, null]) await assert.rejects(() => controller.read({ ...request(), body }, response()), status(400));
  for (const headers of [{ 'content-length': '4' }, { 'transfer-encoding': 'chunked' }]) await assert.rejects(() => controller.read({ ...request(), headers }, response()), status(400));
  for (const header of ['x-hon-subject', 'x-hon-principal-id', 'x-hon-role', 'x-hon-tier', 'x-hon-source', 'x-hon-delegated-by-principal-id', 'x-hon-action-request-id', 'x-hon-human-command', 'idempotency-key']) {
    await assert.rejects(() => controller.read({ ...request(), headers: { [header]: '' } }, response()), status(400));
  }
  for (const site of ['cross-site', 'same-site']) await assert.rejects(() => controller.read({ ...request(), headers: { 'sec-fetch-site': site } }, response()), status(403));
  await assert.rejects(() => controller.read({ headers: {}, query: {} }, response()), status(403));
  assert.equal(calls, 0);
});

test('anonymous and forged sessions are 401 at HonIdentityGuard; verified signed sessions derive the subject', async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { NODE_ENV: 'production', HON_AUTH_MODE: 'OIDC', HON_SESSION_JWT_SECRET: 'TEST_ONLY_STAFF_REPORTING_KEY_1234567890123456', HON_SESSION_AUDIENCE: 'hon-staff-reporting-test' });
    const guard = new HonIdentityGuard(new HonIdentityService());
    for (const headers of [{}, { authorization: 'Bearer PRIVATE_TOKEN' }, { cookie: 'hon_session=PRIVATE_TOKEN' }]) {
      let noStore = false;
      const context = { switchToHttp: () => ({ getRequest: () => ({ headers }), getResponse: () => ({ setHeader: (name, value) => { noStore = name === 'Cache-Control' && value === 'private, no-store'; } }) }) };
      assert.equal(new CurrentStaffReportingSchoolNoStoreGuard().canActivate(context), true);
      assert.throws(() => guard.canActivate(context), status(401));
      assert.equal(noStore, true);
    }
    const identity = { externalSubject: 'verified-staff', displayName: 'Test', email: 'test@example.invalid' };
    const req = { headers: { cookie: `${HON_SESSION_COOKIE}=${issueSession(identity, sessionConfig())}` }, query: {} };
    guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) });
    assert.deepEqual(await new CurrentStaffReportingSchoolController({ resolveCurrentStaffReportingScope: async (subject) => { assert.equal(subject, identity.externalSubject); return scope; } }).read(req, response()), { data: { state: 'RESOLVED', ...scope } });
  } finally { process.env = saved; }
});

test('database denial is 403 and persistence failures are sanitized 503, never nonresolution', async () => {
  for (const [code, expected] of [['42501', 403], ['XX000', 503], ['ECONNREFUSED', 503]]) {
    await assert.rejects(() => new CurrentStaffReportingSchoolController({ resolveCurrentStaffReportingScope: async () => { throw { code, detail: 'PRIVATE_DATABASE' }; } }).read(request(), response()), status(expected));
  }
});

test('runtime resolver checks posture and has only a subject parameter, no directory query or arbitrary-first-row fallback', async () => {
  const database = new RuntimeDatabaseService();
  let checked = 0;
  const calls = [];
  let rows = [scope];
  database.assertRuntimePosture = async () => { checked++; };
  database.getPool = () => ({ query: async (...args) => { calls.push(args); return { rows }; } });
  assert.deepEqual(await database.resolveCurrentStaffReportingScope('verified-staff'), scope);
  assert.deepEqual(calls[0], ['SELECT organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_current_staff_reporting_scope($1)', ['verified-staff']]);
  for (const result of [[], [scope, scope]]) { rows = result; assert.equal(await database.resolveCurrentStaffReportingScope('verified-staff'), undefined); }
  for (const malformed of [{ ...scope, candidates: [] }, { ...scope, schoolId: 'bad' }, { ...scope, organizationId: null }]) {
    rows = [malformed]; await assert.rejects(() => database.resolveCurrentStaffReportingScope('verified-staff'), status(503));
  }
  assert.equal(checked, 6);
});

test('unsafe runtime roles and missing runtime configuration are 503 without privileged fallback', async () => {
  for (const role of [{ rolsuper: true, rolbypassrls: false }, { rolsuper: false, rolbypassrls: true }]) {
    const database = new RuntimeDatabaseService();
    database.getPool = () => ({ query: async () => ({ rows: [role] }) });
    await assert.rejects(() => database.resolveCurrentStaffReportingScope('verified-staff'), status(503));
  }
  const saved = process.env.HON_RUNTIME_DATABASE_URL;
  try { delete process.env.HON_RUNTIME_DATABASE_URL; await assert.rejects(() => new RuntimeDatabaseService().resolveCurrentStaffReportingScope('verified-staff'), status(503)); }
  finally { if (saved === undefined) delete process.env.HON_RUNTIME_DATABASE_URL; else process.env.HON_RUNTIME_DATABASE_URL = saved; }
});
