// M2 native parent app sign-in: bearer mobile sessions, the human-UI guard rule for native clients, and the
// hand-off code exchange. Web cookie behaviour must stay exactly as before.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { issueMobileHandoff, issueMobileSession, issueSession, pkceChallenge, sessionConfig } = require('@hon/auth');
const { HonIdentityService } = require('../dist/foundation/hon-identity.service.js');
const { CurriculumHumanUiGuard } = require('../dist/curriculum/curriculum-human-ui.guard.js');
const { MobileSessionController } = require('../dist/foundation/mobile-session.controller.js');

const env = { HON_AUTH_MODE: 'OIDC', HON_SESSION_JWT_SECRET: 'TEST_ONLY_HON_KEY_123456789012345678901234', HON_SESSION_AUDIENCE: 'hon-test-app', HON_PUBLIC_ORIGIN: 'https://hon.example' };
Object.assign(process.env, env);
const config = sessionConfig(env);
const identity = { externalSubject: 'oidc:iss:parent-1', displayName: 'Test Parent' };
const web = issueSession(identity, config);
const mobile = issueMobileSession(identity, config);
const service = new HonIdentityService();
const req = (headers, url = '/v1/parent/journey', method = 'GET') => ({ headers, originalUrl: url, method });
const ledger = () => { const seen = new Set(); const calls = []; return { calls, redeemMobileHandoff: async (app, jti, expiresAt) => { calls.push({ app, jti, expiresAt }); if (seen.has(`${app}:${jti}`)) return false; seen.add(`${app}:${jti}`); return true; } }; };
const astatus = async (fn) => { try { await fn(); return 200; } catch (e) { return e.getStatus?.() ?? 'throw'; } };
const acode = async (fn) => { try { await fn(); return null; } catch (e) { return e.getResponse?.().code ?? null; } };
const status = (fn) => { try { fn(); return 200; } catch (e) { return e.getStatus?.() ?? 'throw'; } };

test('web cookie sessions authenticate exactly as before, on the WEB channel', () => {
  const r = req({ cookie: `hon_session=${web}` }, '/v1/organizations/x');
  assert.equal(service.authenticate(r).externalSubject, identity.externalSubject);
  assert.equal(r.honChannel, 'WEB');
});

test('a mobile bearer session authenticates parent routes on the MOBILE channel', () => {
  const r = req({ authorization: `Bearer ${mobile}` });
  assert.equal(service.authenticate(r).externalSubject, identity.externalSubject);
  assert.equal(r.honChannel, 'MOBILE');
});

test('with a cookie, the browser path decides and any Authorization header is ignored (unchanged web behaviour)', () => {
  const r = req({ cookie: `hon_session=${web}`, authorization: `Bearer ${mobile}` }, '/v1/organizations/x');
  assert.equal(service.authenticate(r).externalSubject, identity.externalSubject);
  assert.equal(r.honChannel, 'WEB');
});

test('a web token as bearer, a mobile token as cookie, or a non-bearer header alone are refused', () => {
  assert.equal(status(() => service.authenticate(req({ authorization: `Bearer ${web}` }))), 401);
  assert.equal(status(() => service.authenticate(req({ cookie: `hon_session=${mobile}` }))), 401);
  assert.equal(status(() => service.authenticate(req({ authorization: 'Basic abc' }))), 401);
  assert.equal(status(() => service.authenticate(req({}))), 401);
});

test('mobile sessions reach only parent, me and mobile-auth routes', () => {
  for (const url of ['/v1/parent/journey', '/v1/parent/class-bookings', '/v1/me/language-preference', '/v1/parent/families']) {
    assert.equal(status(() => service.authenticate(req({ authorization: `Bearer ${mobile}` }, url))), 200, url);
  }
  for (const url of ['/v1/organizations/o/schools/s/families', '/v1/staff/testing/registrations', '/v1/hq/schools', '/v1/parentx', '/v1/parent']) {
    assert.equal(status(() => service.authenticate(req({ authorization: `Bearer ${mobile}` }, url))), 403, url);
  }
});

class Cmd extends CurriculumHumanUiGuard { command = 'parent.class_booking.book'; }
const guard = new Cmd();
const ctx = (r) => ({ switchToHttp: () => ({ getRequest: () => r }) });
const post = (headers, honChannel) => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-hon-human-command': 'parent.class_booking.book', ...headers }, honChannel });

test('native POSTs pass with the exact command and no browser headers', () => {
  assert.equal(guard.canActivate(ctx(post({ authorization: 'Bearer x' }, 'MOBILE'))), true);
  // Guard ordered before the identity guard: the bearer header alone selects the native rule; the identity guard still verifies it.
  assert.equal(guard.canActivate(ctx(post({ authorization: 'Bearer x' }, undefined))), true);
});

test('a browser POST behind a Basic-auth proxy keeps the browser rule', () => {
  const browser = post({ cookie: 'hon_session=x', authorization: 'Basic abc', origin: 'https://hon.example', 'sec-fetch-site': 'same-origin' }, undefined);
  assert.equal(guard.canActivate(ctx(browser)), true);
  assert.equal(status(() => guard.canActivate(ctx(post({ cookie: 'hon_session=x', authorization: 'Bearer x' }, undefined)))), 403);
});

test('native POSTs with an Origin, a Sec-Fetch-Site, the wrong command or a non-JSON body are refused', () => {
  for (const extra of [{ origin: 'https://hon.example' }, { 'sec-fetch-site': 'none' }, { 'x-hon-human-command': 'other' }, { 'content-type': 'text/plain' }]) {
    assert.equal(status(() => guard.canActivate(ctx(post({ authorization: 'Bearer x', ...extra }, 'MOBILE')))), 403, JSON.stringify(extra));
  }
  assert.equal(status(() => guard.canActivate(ctx({ ...post({ authorization: 'Bearer x' }, 'MOBILE'), method: 'PUT' }))), 403);
});

test('browser POSTs keep the same-origin rule: no Origin is still refused on the web channel', () => {
  assert.equal(status(() => guard.canActivate(ctx(post({}, 'WEB')))), 403);
  assert.equal(guard.canActivate(ctx(post({ origin: 'https://hon.example', 'sec-fetch-site': 'same-origin' }, 'WEB'))), true);
  assert.equal(status(() => guard.canActivate(ctx(post({ origin: 'https://evil.example' }, 'WEB')))), 403);
});

test('hand-off exchange returns a mobile session only for the verifier holder, and only once', async () => {
  const verifier = 'v'.repeat(43);
  const code = issueMobileHandoff(identity, pkceChallenge(verifier), config);
  const runtime = ledger();
  const controller = new MobileSessionController(runtime);
  const json = { 'content-type': 'application/json' };
  assert.equal(await astatus(() => controller.exchange({ code, verifier: 'w'.repeat(43) }, { headers: json })), 401);
  assert.equal(runtime.calls.length, 0, 'a wrong verifier never reaches the ledger');
  const result = await controller.exchange({ code, verifier }, { headers: json });
  assert.match(result.data.token, /^[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.equal(service.authenticate(req({ authorization: `Bearer ${result.data.token}` })).externalSubject, identity.externalSubject);
  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0].app, 'family');
  assert.match(runtime.calls[0].jti, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(runtime.calls[0].expiresAt instanceof Date);
  // The same code + verifier a second time is refused (security review 2026-11-22: single use).
  assert.equal(await astatus(() => controller.exchange({ code, verifier }, { headers: json })), 401);
  assert.equal(await acode(() => controller.exchange({ code, verifier }, { headers: json })), 'MOBILE_SIGN_IN_INVALID');
  assert.equal(await astatus(() => controller.exchange({ code, verifier, extra: 1 }, { headers: json })), 400);
  assert.equal(await astatus(() => controller.exchange({ code, verifier }, { headers: { ...json, origin: 'https://evil.example' } })), 403);
  assert.equal(await astatus(() => controller.exchange({ code, verifier }, { headers: { 'content-type': 'text/plain' } })), 403);
});

test('hand-off exchange issues nothing when the single-use ledger cannot answer', async () => {
  const verifier = 'v'.repeat(43);
  const code = issueMobileHandoff(identity, pkceChallenge(verifier), config);
  const controller = new MobileSessionController({ redeemMobileHandoff: async () => { throw new Error('db down'); } });
  const json = { 'content-type': 'application/json' };
  assert.equal(await astatus(() => controller.exchange({ code, verifier }, { headers: json })), 503);
  assert.equal(await acode(() => controller.exchange({ code, verifier }, { headers: json })), 'MOBILE_SIGN_IN_UNAVAILABLE');
});

// M3: the real parent class booking guards extend MembershipActivationHumanUiGuard, which adds its own browser rules
// before the base. A native POST must pass them unchanged, and every browser-shaped variant stays refused.
test('parent class booking guards admit the native app and keep the extra browser refusals', () => {
  const { ParentClassBookingBookGuard, ParentClassBookingCancelGuard } = require('../dist/families/parent-class-booking.controller.js');
  const book = new ParentClassBookingBookGuard();
  const cancel = new ParentClassBookingCancelGuard();
  const native = (command, extra = {}) => ({ method: 'POST', honChannel: 'MOBILE', headers: { 'content-type': 'application/json', 'x-hon-human-command': command, authorization: 'Bearer x', ...extra } });
  assert.equal(book.canActivate(ctx(native('parent.class_booking.book'))), true);
  assert.equal(cancel.canActivate(ctx(native('parent.class_booking.cancel'))), true);
  assert.equal(status(() => book.canActivate(ctx(native('parent.class_booking.cancel')))), 403);
  for (const extra of [{ origin: 'https://hon.example' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-origin' }, { 'x-hon-source': 'agent' }, { 'x-hon-action-request-id': 'a' }, { 'x-hon-delegated-by-principal-id': 'p' }]) {
    assert.equal(status(() => book.canActivate(ctx(native('parent.class_booking.book', extra)))), 403, JSON.stringify(extra));
  }
});
