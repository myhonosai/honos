// S1 HON Staff app Today (docs/architecture/STAFF_MOBILE_TODAY.md): a staff bearer session reaches exactly the class
// list, one class roster, marking attendance and the person's own time clock, each with exact methods, and the
// transport guards on those routes admit a native staff request without loosening the browser rules.
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { issueMobileSession, issueStaffMobileSession, sessionConfig } = require('@hon/auth');
const { HonIdentityService } = require('../dist/foundation/hon-identity.service.js');
const { ClassSessionPagesHumanUiGuard } = require('../dist/schedule/class-session-pages.controller.js');
const { ClassSessionsReadHumanUiGuard } = require('../dist/schedule/class-sessions-read-human-ui.guard.js');
const { AttendanceHumanUiGuard } = require('../dist/schedule/attendance-human-ui.guard.js');
const { StaffTimePunchHumanUiGuard, StaffTimeReadHumanUiGuard, StaffTimeEntrySaveHumanUiGuard } = require('../dist/staff-time/staff-time-human-ui.guard.js');

const env = { HON_AUTH_MODE: 'OIDC', HON_SESSION_JWT_SECRET: 'TEST_ONLY_HON_KEY_123456789012345678901234', HON_SESSION_AUDIENCE: 'hon-test-app', HON_PUBLIC_ORIGIN: 'https://hon.example' };
Object.assign(process.env, env);
const config = sessionConfig(env);
const identity = { externalSubject: 'oidc:iss:staff-1', displayName: 'Test Instructor' };
const staff = issueStaffMobileSession(identity, config);
const family = issueMobileSession(identity, config);
const service = new HonIdentityService();
const O = '11111111-1111-4111-8111-111111111111', S = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const SCHOOL = `/v1/organizations/${O}/schools/${S}`;
const req = (token, url, method = 'GET', headers = {}) => ({ headers: { authorization: `Bearer ${token}`, ...headers }, originalUrl: url, method });
const status = (fn) => { try { fn(); return 200; } catch (e) { return e.getStatus?.() ?? 'throw'; } };
const code = (fn) => { try { fn(); return null; } catch (e) { return e.getResponse?.().code ?? null; } };

const ALLOWED = [
  ['GET', `${SCHOOL}/schedule/sessions/list`],
  ['GET', `${SCHOOL}/schedule/sessions/list?from=2026-11-22&limit=50`],
  ['GET', `${SCHOOL}/schedule/sessions/${C}/roster`],
  ['GET', `${SCHOOL}/schedule/sessions/${C}/roster?limit=50`],
  ['GET', `${SCHOOL}/schedule/sessions/${C}/attendance?studentProfileId=${O}`],
  ['POST', `${SCHOOL}/schedule/sessions/${C}/attendance`],
  ['GET', `${SCHOOL}/staff/time/clock`],
  ['POST', `${SCHOOL}/staff/time/clock`],
];

test('a staff session reaches exactly the S1 Today routes with their methods, marked STAFF', () => {
  for (const [method, url] of ALLOWED) {
    const r = req(staff, url, method);
    assert.equal(service.authenticate(r).externalSubject, identity.externalSubject, `${method} ${url}`);
    assert.equal(r.honChannel, 'MOBILE');
    assert.equal(r.honMobileApp, 'STAFF');
  }
});

test('other methods, look-alike paths, non-UUID segments and neighbouring routes stay refused for the staff app', () => {
  const refused = [
    ['POST', `${SCHOOL}/schedule/sessions/list`], ['DELETE', `${SCHOOL}/schedule/sessions/${C}/attendance`], ['PUT', `${SCHOOL}/schedule/sessions/${C}/attendance`],
    ['POST', `${SCHOOL}/schedule/sessions/${C}/roster`], ['PATCH', `${SCHOOL}/staff/time/clock`], ['HEAD', `${SCHOOL}/staff/time/clock`],
    ['GET', `${SCHOOL}/schedule/sessions`], ['GET', `${SCHOOL}/schedule/sessions/listx`], ['GET', `${SCHOOL}/schedule/sessions/list/x`],
    ['GET', `${SCHOOL}/schedule/sessions/not-a-uuid/roster`], ['GET', `${SCHOOL}/schedule/sessions/${C}/rosterx`], ['GET', `${SCHOOL}/schedule/sessions/${C}/roster/x`],
    ['GET', `/v1/organizations/o/schools/s/staff/time/clock`], ['GET', `/v1/organizations/${O}/schools/${S}/x/staff/time/clock`], ['GET', `${SCHOOL}/staff/time/clock/x`],
    ['GET', `${SCHOOL}/staff/time/weeks/2026-11-16`], ['POST', `${SCHOOL}/staff/time/entries`], ['POST', `${SCHOOL}/staff/time/weeks`],
    ['GET', `${SCHOOL}/schedule/sessions/${C}%2Froster`], ['GET', `${SCHOOL}//schedule/sessions/list`], ['GET', `/v1/organizations/${O}/schools/${S}${SCHOOL}/staff/time/clock`],
    ['GET', `${SCHOOL}/people`], ['GET', `${SCHOOL}/schedule/sessions/${C}/bookings`], ['POST', `${SCHOOL}/schedule/sessions/${C}/bookings`],
    ['GET', `${SCHOOL.replace('/v1/', '/V1/')}/staff/time/clock`],
  ];
  for (const [method, url] of refused) {
    assert.equal(status(() => service.authenticate(req(staff, url, method))), 403, `${method} ${url}`);
    assert.equal(code(() => service.authenticate(req(staff, url, method))), 'MOBILE_SESSION_SCOPE', `${method} ${url}`);
  }
});

test('the family app never reaches the staff Today routes', () => {
  for (const [method, url] of ALLOWED) assert.equal(status(() => service.authenticate(req(family, url, method))), 403, `${method} ${url}`);
});

const ctx = (request) => ({ switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ setHeader() {} }) }) });
const read = (patch = {}, requestPatch = {}) => ({ method: 'GET', honChannel: 'MOBILE', honMobileApp: 'STAFF', query: {}, originalUrl: `${SCHOOL}/schedule/sessions/list`, body: undefined,
  headers: { authorization: `Bearer ${staff}`, 'x-hon-human-read': 'class-sessions', ...patch }, ...requestPatch });

test('class list read: a native staff request passes without browser metadata; every other browser rule still holds', () => {
  for (const Guard of [ClassSessionsReadHumanUiGuard, ClassSessionPagesHumanUiGuard]) {
    const guard = new Guard();
    assert.equal(guard.canActivate(ctx(read())), true, Guard.name);
    assert.equal(guard.canActivate(ctx(read({ 'x-forwarded-host': 'hon.example', 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' }))), true, Guard.name);
    for (const patch of [{ origin: 'https://hon.example' }, { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-mode': 'cors' }, { 'sec-fetch-dest': 'empty' },
      { 'x-hon-human-read': undefined }, { 'x-hon-human-read': 'class-bookings' }, { 'x-hon-source': 'AUTOMATION' }, { 'x-forwarded-host': 'evil.example' },
      { forwarded: 'host=evil.example' }, { 'x-principal-id': O }, { 'x-school-id': S }, { 'idempotency-key': 'k' }]) {
      assert.equal(status(() => guard.canActivate(ctx(read(patch)))), 403, `${Guard.name} ${JSON.stringify(patch)}`);
    }
    assert.equal(status(() => guard.canActivate(ctx(read({}, { method: 'POST' })))), 403, Guard.name);
    assert.equal(status(() => guard.canActivate(ctx(read({}, { body: {} })))), 400, Guard.name);
  }
  // Only the pages guard takes from/limit/cursor; the bounded read takes no selector.
  const withQuery = { query: { from: '2026-11-22', limit: '50' }, originalUrl: `${SCHOOL}/schedule/sessions/list?from=2026-11-22&limit=50` };
  assert.equal(new ClassSessionPagesHumanUiGuard().canActivate(ctx(read({}, withQuery))), true);
  assert.equal(status(() => new ClassSessionsReadHumanUiGuard().canActivate(ctx(read({}, withQuery)))), 400);
});

test('class list read: Authorization is admitted only for the verified staff app, never for web, family or unmarked requests', () => {
  const guard = new ClassSessionPagesHumanUiGuard();
  for (const patch of [{ honChannel: 'WEB', honMobileApp: undefined }, { honMobileApp: 'FAMILY' }, { honMobileApp: undefined }, { honChannel: undefined }]) {
    assert.equal(status(() => guard.canActivate(ctx(read({}, patch)))), 403, JSON.stringify(patch));
  }
  // The browser path is unchanged: same-origin metadata, no Authorization.
  const browser = { method: 'GET', honChannel: 'WEB', query: {}, originalUrl: `${SCHOOL}/schedule/sessions/list`, body: undefined,
    headers: { 'x-hon-human-read': 'class-sessions', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty' } };
  assert.equal(guard.canActivate(ctx(browser)), true);
  assert.equal(status(() => guard.canActivate(ctx({ ...browser, headers: { ...browser.headers, authorization: 'Bearer x' } }))), 403);
  assert.equal(status(() => guard.canActivate(ctx({ ...browser, headers: { ...browser.headers, 'sec-fetch-site': undefined } }))), 403);
});

const command = (name, patch = {}) => ({ method: 'POST', honChannel: 'MOBILE', honMobileApp: 'STAFF', body: {},
  headers: { authorization: `Bearer ${staff}`, 'content-type': 'application/json', 'x-hon-human-command': name, ...patch } });

test('attendance mark and clock punch: the existing native command rule admits the staff app, with the exact command name', () => {
  for (const [Guard, name] of [[AttendanceHumanUiGuard, 'attendance'], [StaffTimePunchHumanUiGuard, 'staff_time.punch']]) {
    const guard = new Guard();
    assert.equal(guard.canActivate(ctx(command(name))), true, Guard.name);
    for (const patch of [{ origin: 'https://hon.example' }, { 'sec-fetch-site': 'same-origin' }, { 'x-hon-human-command': 'other' }, { 'content-type': 'text/plain' }]) {
      assert.equal(status(() => guard.canActivate(ctx(command(name, patch)))), 403, `${Guard.name} ${JSON.stringify(patch)}`);
    }
  }
  // The time clock also refuses source and delegation headers (the attendance service never reads them: it sets HUMAN_UI).
  assert.equal(status(() => new StaffTimePunchHumanUiGuard().canActivate(ctx(command('staff_time.punch', { 'x-hon-source': 'AUTOMATION' })))), 403);
  // Reads are GETs; the clock read keeps refusing source and delegation headers.
  assert.equal(new AttendanceHumanUiGuard().canActivate(ctx({ method: 'GET', honChannel: 'MOBILE', headers: { authorization: `Bearer ${staff}` } })), true);
  assert.equal(new StaffTimeReadHumanUiGuard().canActivate(ctx({ method: 'GET', honChannel: 'MOBILE', headers: { authorization: `Bearer ${staff}` } })), true);
  assert.equal(status(() => new StaffTimeReadHumanUiGuard().canActivate(ctx({ method: 'GET', honChannel: 'MOBILE', headers: { authorization: `Bearer ${staff}`, 'x-hon-source': 'AUTOMATION' } }))), 403);
  // A punch is never accepted as a timesheet edit.
  assert.equal(status(() => new StaffTimeEntrySaveHumanUiGuard().canActivate(ctx(command('staff_time.punch')))), 403);
});
