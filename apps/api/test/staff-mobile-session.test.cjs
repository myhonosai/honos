// S0 HON Staff app sign-in: staff bearer sessions are a separate token family and reach only an explicit allow-list
// of staff routes. The family app and web cookie behaviour must stay exactly as before.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { issueMobileHandoff, issueMobileSession, issueSession, issueStaffMobileHandoff, issueStaffMobileSession, pkceChallenge, sessionConfig } = require('@hon/auth');
const { HonIdentityService } = require('../dist/foundation/hon-identity.service.js');
const { MobileSessionController } = require('../dist/foundation/mobile-session.controller.js');

const env = { HON_AUTH_MODE: 'OIDC', HON_SESSION_JWT_SECRET: 'TEST_ONLY_HON_KEY_123456789012345678901234', HON_SESSION_AUDIENCE: 'hon-test-app', HON_PUBLIC_ORIGIN: 'https://hon.example' };
Object.assign(process.env, env);
const config = sessionConfig(env);
const identity = { externalSubject: 'oidc:iss:staff-1', displayName: 'Test Instructor' };
const staff = issueStaffMobileSession(identity, config);
const family = issueMobileSession(identity, config);
const service = new HonIdentityService();
const req = (headers, url, method = 'GET') => ({ headers, originalUrl: url, method });
const status = (fn) => { try { fn(); return 200; } catch (e) { return e.getStatus?.() ?? 'throw'; } };
const code = (fn) => { try { fn(); return null; } catch (e) { return e.getResponse?.().code ?? null; } };
const bearer = (token) => ({ authorization: `Bearer ${token}` });

const STAFF_ALLOWED = ['/v1/me/language-preference', '/v1/me/hq-contact', '/v1/auth/mobile/staff-session', '/v1/staff/current-reporting-school', '/v1/staff/reporting-schools', '/v1/staff/reporting-schools?x=1'];

test('a staff bearer session authenticates the S0 allow-list on the MOBILE channel as the STAFF app', () => {
  for (const url of STAFF_ALLOWED) {
    const r = req(bearer(staff), url);
    assert.equal(service.authenticate(r).externalSubject, identity.externalSubject, url);
    assert.equal(r.honChannel, 'MOBILE');
    assert.equal(r.honMobileApp, 'STAFF');
  }
});

test('a staff session is refused on family, organization, HQ, other staff and look-alike routes', () => {
  for (const url of ['/v1/parent/journey', '/v1/parent/families', '/v1/organizations/o/schools/s/staff/time/clock', '/v1/hq/session', '/v1/hq/schools',
    '/v1/staff/teaching-assistant/x', '/v1/staff/voice/s', '/v1/staff/reporting-schoolsx', '/v1/staff/reporting-schools/x', '/v1/staff/current-reporting-school/x',
    '/v1/staff', '/v1/me', '/v2/me/language-preference', '/v1//me/language-preference']) {
    assert.equal(status(() => service.authenticate(req(bearer(staff), url))), 403, url);
    assert.equal(code(() => service.authenticate(req(bearer(staff), url))), 'MOBILE_SESSION_SCOPE', url);
  }
});

test('family app sessions are unchanged: parent routes yes, staff routes no, marked FAMILY', () => {
  const r = req(bearer(family), '/v1/parent/journey');
  assert.equal(service.authenticate(r).externalSubject, identity.externalSubject);
  assert.equal(r.honMobileApp, 'FAMILY');
  for (const url of ['/v1/staff/current-reporting-school', '/v1/staff/reporting-schools', '/v1/organizations/o/schools/s/people']) {
    assert.equal(status(() => service.authenticate(req(bearer(family), url))), 403, url);
  }
});

test('web cookie sessions are unchanged and never marked as a mobile app; a web token is never a bearer', () => {
  const r = req({ cookie: `hon_session=${issueSession(identity, config)}`, ...bearer(staff) }, '/v1/organizations/x');
  assert.equal(service.authenticate(r).externalSubject, identity.externalSubject);
  assert.equal(r.honChannel, 'WEB');
  assert.equal(r.honMobileApp, undefined);
  assert.equal(status(() => service.authenticate(req(bearer(issueSession(identity, config)), '/v1/staff/reporting-schools'))), 401);
  assert.equal(status(() => service.authenticate(req({ cookie: `hon_session=${staff}` }, '/v1/staff/reporting-schools'))), 401);
});

test('staff hand-off exchange: native-only headers, verifier required, never crosses with the family exchange', () => {
  const verifier = 'v'.repeat(43);
  const challenge = pkceChallenge(verifier);
  const staffCode = issueStaffMobileHandoff(identity, challenge, config);
  const familyCode = issueMobileHandoff(identity, challenge, config);
  const controller = new MobileSessionController();
  const json = { 'content-type': 'application/json' };
  const result = controller.exchangeStaff({ code: staffCode, verifier }, { headers: json });
  const r = req(bearer(result.data.token), '/v1/staff/reporting-schools');
  service.authenticate(r);
  assert.equal(r.honMobileApp, 'STAFF');
  assert.equal(status(() => controller.exchangeStaff({ code: familyCode, verifier }, { headers: json })), 401);
  assert.equal(status(() => controller.exchange({ code: staffCode, verifier }, { headers: json })), 401);
  assert.equal(status(() => controller.exchangeStaff({ code: staffCode, verifier: 'w'.repeat(43) }, { headers: json })), 401);
  assert.equal(status(() => controller.exchangeStaff({ code: staffCode, verifier, extra: 1 }, { headers: json })), 400);
  for (const extra of [{ origin: 'https://hon.example' }, { 'sec-fetch-site': 'none' }, { cookie: 'a=b' }, { authorization: 'Bearer x' }, { 'content-type': 'text/plain' }]) {
    assert.equal(status(() => controller.exchangeStaff({ code: staffCode, verifier }, { headers: { ...json, ...extra } })), 403, JSON.stringify(extra));
  }
});

test('the school-choice read admits the Authorization header only as the verified staff app bearer', async () => {
  const { StaffReportingSchoolsController } = require('../dist/reports/staff-reporting-schools.controller.js');
  const school = { organizationId: '11111111-1111-4111-8111-111111111111', schoolId: '22222222-2222-4222-8222-222222222222', organizationName: 'Local Organization', schoolName: 'North School' };
  const schools = [school, { ...school, schoolId: '33333333-3333-4333-8333-333333333333', schoolName: 'South School' }];
  const controller = new StaffReportingSchoolsController({ readStaffReportingSchools: async () => schools });
  const res = { setHeader() {} };
  const base = { query: {}, honIdentity: { externalSubject: 'staff-1' }, headers: { authorization: `Bearer ${staff}` } };
  assert.deepEqual(await controller.read({ ...base, honChannel: 'MOBILE', honMobileApp: 'STAFF' }, res), { data: { state: 'SELECTION_REQUIRED', schools } });
  for (const context of [{}, { honChannel: 'WEB' }, { honChannel: 'MOBILE', honMobileApp: 'FAMILY' }, { honChannel: 'MOBILE' }]) {
    await assert.rejects(() => controller.read({ ...base, ...context }, res), (e) => e.getStatus() === 400, JSON.stringify(context));
  }
  // Every other authority header stays refused for the staff app too.
  for (const header of ['x-hon-subject', 'x-school-id', 'idempotency-key', 'x-role']) {
    await assert.rejects(() => controller.read({ ...base, honChannel: 'MOBILE', honMobileApp: 'STAFF', headers: { ...base.headers, [header]: '' } }, res), (e) => e.getStatus() === 400, header);
  }
});
