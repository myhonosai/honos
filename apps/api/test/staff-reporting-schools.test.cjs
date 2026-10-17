const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { GUARDS_METADATA, PATH_METADATA, METHOD_METADATA } = require('@nestjs/common/constants');
const { RequestMethod } = require('@nestjs/common');
const { issueSession, sessionConfig, HON_SESSION_COOKIE } = require('@hon/auth');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { HonIdentityService } = require('../dist/foundation/hon-identity.service.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { StaffReportingSchoolsController } = require('../dist/reports/staff-reporting-schools.controller.js');
const { CurrentStaffReportingSchoolNoStoreGuard } = require('../dist/reports/current-staff-reporting-school.controller.js');
const school = { organizationId: '11111111-1111-4111-8111-111111111111', schoolId: '22222222-2222-4222-8222-222222222222', organizationName: 'Local Organization', schoolName: 'North School' };
const schools = [school, { ...school, schoolId: '33333333-3333-4333-8333-333333333333', schoolName: 'South School' }];
const request = (externalSubject = 'verified-staff') => ({ headers: { 'sec-fetch-site': 'same-origin' }, query: {}, honIdentity: { externalSubject } });
const response = () => ({ setHeader(key, value) { assert.equal(key, 'Cache-Control'); assert.equal(value, 'private, no-store'); } });
const status = (expected) => (error) => { assert.equal(error.getStatus(), expected); assert.doesNotMatch(JSON.stringify(error.getResponse()), /PRIVATE_|eyJ/); return true; };

test('dashboard selector GET is no-store before the signed-session guard and uses only its subject', async () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, StaffReportingSchoolsController), 'staff/reporting-schools');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, StaffReportingSchoolsController.prototype.read), RequestMethod.GET);
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, StaffReportingSchoolsController), [CurrentStaffReportingSchoolNoStoreGuard, HonIdentityGuard]);
  const calls = [];
  const controller = new StaffReportingSchoolsController({ readStaffReportingSchools: async (...args) => { calls.push(args); return schools.map((row) => ({ ...row, principalId: 'PRIVATE_PRINCIPAL', permissions: ['PRIVATE_PERMISSION'] })); } });
  assert.deepEqual(await controller.read({ ...request(), organizationId: 'forged', schoolId: 'forged', principalId: 'forged', tier: 'COMPLETE' }, response()), { data: { state: 'SELECTION_REQUIRED', schools } });
  assert.deepEqual(calls, [['verified-staff']]);
});

test('zero, exact-one, second nonreporting, mixed, reserved, family/HQ and unauthorized contexts have one identifier-free result', async () => {
  const controller = new StaffReportingSchoolsController({ readStaffReportingSchools: async () => [] });
  for (const subject of ['zero', 'single-staff', 'single-owner', 'second-nonreporting', 'multiple-principals', 'staff+hq', 'staff+family', 'parent', 'guardian', 'student', 'family', 'hq', 'hon', 'platform', 'system', 'unauthorized', 'owner-without-reporting', 'over-cap']) {
    assert.deepEqual(await controller.read(request(subject), response()), { data: { state: 'MANUAL_ENTRY_REQUIRED' } });
  }
});

test('all queries/bodies/authority headers and cross-site reads are rejected before SQL resolution', async () => {
  let calls = 0;
  const controller = new StaffReportingSchoolsController({ readStaffReportingSchools: async () => { calls++; return schools; } });
  for (const field of ['subject', 'principalId', 'organizationId', 'schoolId', 'role', 'tier', 'delegatedByPrincipalId', 'actionRequestId', 'limit', 'cursor', 'q']) {
    await assert.rejects(() => controller.read({ ...request(), query: { [field]: 'forged' } }, response()), status(400));
    await assert.rejects(() => controller.read({ ...request(), body: { [field]: 'forged' } }, response()), status(400));
  }
  for (const body of [{}, [], '', 0, false, null]) await assert.rejects(() => controller.read({ ...request(), body }, response()), status(400));
  for (const headers of [{ 'content-length': '4' }, { 'transfer-encoding': 'chunked' }]) await assert.rejects(() => controller.read({ ...request(), headers }, response()), status(400));
  for (const header of ['authorization', 'x-hon-subject', 'x-hon-principal-id', 'x-hon-role', 'x-hon-tier', 'x-hon-source', 'x-hon-delegated-by-principal-id', 'x-hon-action-request-id', 'x-hon-human-command', 'idempotency-key', 'x-school-id', 'x-organization-id', 'x-principal-id', 'x-role', 'x-tier', 'x-delegated-by-principal-id']) {
    await assert.rejects(() => controller.read({ ...request(), headers: { [header]: '' } }, response()), status(400));
  }
  for (const site of ['cross-site', 'same-site']) await assert.rejects(() => controller.read({ ...request(), headers: { 'sec-fetch-site': site } }, response()), status(403));
  await assert.rejects(() => controller.read({ headers: {}, query: {} }, response()), status(403));
  assert.equal(calls, 0);
});

test('only a verified signed human session subject reaches the endpoint; invalid/anonymous responses cannot cache', async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { NODE_ENV: 'production', HON_AUTH_MODE: 'OIDC', HON_SESSION_JWT_SECRET: 'TEST_ONLY_STAFF_SELECTOR_KEY_1234567890123456', HON_SESSION_AUDIENCE: 'hon-staff-selector-test' });
    const guard = new HonIdentityGuard(new HonIdentityService());
    for (const headers of [{}, { authorization: 'Bearer PRIVATE_TOKEN' }, { cookie: 'hon_session=PRIVATE_TOKEN' }]) {
      let noStore = false;
      const context = { switchToHttp: () => ({ getRequest: () => ({ headers }), getResponse: () => ({ setHeader: (name, value) => { noStore = name === 'Cache-Control' && value === 'private, no-store'; } }) }) };
      new CurrentStaffReportingSchoolNoStoreGuard().canActivate(context);
      assert.throws(() => guard.canActivate(context), status(401)); assert.equal(noStore, true);
    }
    const identity = { externalSubject: 'verified-staff', displayName: 'Test', email: 'test@example.invalid' };
    const req = { headers: { cookie: `${HON_SESSION_COOKIE}=${issueSession(identity, sessionConfig())}` }, query: {} };
    guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) });
    const controller = new StaffReportingSchoolsController({ readStaffReportingSchools: async (subject) => { assert.equal(subject, identity.externalSubject); return schools; } });
    assert.deepEqual(await controller.read(req, response()), { data: { state: 'SELECTION_REQUIRED', schools } });
  } finally { process.env = saved; }
});

test('SQL denial/failure uses sanitized 403/503, not misleading successful nonresolution', async () => {
  for (const [code, expected] of [['42501', 403], ['XX000', 503], ['ECONNREFUSED', 503]]) {
    await assert.rejects(() => new StaffReportingSchoolsController({ readStaffReportingSchools: async () => { throw { code, detail: 'PRIVATE_DATABASE' }; } }).read(request(), response()), status(expected));
  }
});

function runtimeFixture(rows = schools, safe = true) {
  const database = new RuntimeDatabaseService(); const calls = []; let released = false; let checked = 0;
  database.assertRuntimePosture = async () => { checked++; };
  database.getPool = () => ({ connect: async () => ({
    query: async (sql, params) => { calls.push([sql, params]); return { rows: sql.includes('FROM pg_roles') ? [{ safe }] : sql.includes('hon.read_staff_reporting_schools') ? rows : [] }; },
    release: () => { released = true; },
  }) });
  return { database, calls, released: () => released, checked: () => checked };
}

test('runtime performs a bounded fixed subject-only read in READ ONLY with restricted role/membership checks', async () => {
  const fixture = runtimeFixture();
  assert.deepEqual(await fixture.database.readStaffReportingSchools('verified-staff'), schools);
  assert.equal(fixture.calls[0][0], 'BEGIN READ ONLY');
  assert.match(fixture.calls[2][0], /current_user = 'hon_runtime'/);
  assert.match(fixture.calls[2][0], /rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication/);
  assert.match(fixture.calls[2][0], /pg_auth_members/);
  assert.deepEqual(fixture.calls[3], ['SELECT organization_id AS "organizationId", school_id AS "schoolId", organization_name AS "organizationName", school_name AS "schoolName" FROM hon.read_staff_reporting_schools($1)', ['verified-staff']]);
  assert.equal(fixture.calls.at(-1)[0], 'COMMIT'); assert.equal(fixture.released(), true); assert.equal(fixture.checked(), 1);
  const empty = runtimeFixture([]); assert.deepEqual(await empty.database.readStaffReportingSchools('unknown'), []);
});

test('runtime fails closed and rolls back extra/duplicate/malformed/unsafe/over-bound output', async () => {
  for (const rows of [[school], [school, school], Array(21).fill(school), [{ ...school, schoolId: 'bad' }, schools[1]], [{ ...school, organizationName: '' }, schools[1]], [{ ...school, schoolName: 'PRIVATE\nNAME' }, schools[1]], [{ ...school, schoolName: '\u202eSpoof' }, schools[1]], [{ ...school, schoolName: 'x'.repeat(121) }, schools[1]], [{ ...school, schoolName: ' padded ' }, schools[1]], [{ ...school, extra: 'PRIVATE_DATA' }, schools[1]]]) {
    const fixture = runtimeFixture(rows);
    await assert.rejects(() => fixture.database.readStaffReportingSchools('verified-staff'), status(503));
    assert.equal(fixture.calls.at(-1)[0], 'ROLLBACK'); assert.equal(fixture.released(), true);
  }
  const unsafe = runtimeFixture(schools, false);
  await assert.rejects(() => unsafe.database.readStaffReportingSchools('verified-staff'), status(503));
  assert.equal(unsafe.calls.some(([sql]) => sql.includes('hon.read_staff_reporting_schools')), false);
});

test('unconfigured or bypass runtime cannot use privileged connections as fallback', async () => {
  for (const role of [{ rolsuper: true, rolbypassrls: false }, { rolsuper: false, rolbypassrls: true }]) {
    const database = new RuntimeDatabaseService(); database.getPool = () => ({ query: async () => ({ rows: [role] }) });
    await assert.rejects(() => database.readStaffReportingSchools('verified-staff'), status(503));
  }
  const saved = process.env.HON_RUNTIME_DATABASE_URL;
  try { delete process.env.HON_RUNTIME_DATABASE_URL; await assert.rejects(() => new RuntimeDatabaseService().readStaffReportingSchools('verified-staff'), status(503)); }
  finally { if (saved === undefined) delete process.env.HON_RUNTIME_DATABASE_URL; else process.env.HON_RUNTIME_DATABASE_URL = saved; }
});

test('endpoint cannot forward a one-row or over-cap result even if a runtime adapter drifts', async () => {
  for (const rows of [[school], Array(21).fill(school)]) {
    await assert.rejects(() => new StaffReportingSchoolsController({ readStaffReportingSchools: async () => rows }).read(request(), response()), status(503));
  }
});
