// S4 HON Staff app People and Texts (docs/architecture/STAFF_MOBILE_PEOPLE_TEXTS.md): a staff bearer session reaches
// exactly contact search, one contact card, the texts inbox, one conversation, marking it read and replying, each with
// exact methods. Archive, merge, restore, assign, tag, link and create-lead stay web-only. The existing guards admit a
// native staff request without loosening the browser rule.
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { issueMobileSession, issueStaffMobileSession, sessionConfig } = require('@hon/auth');
const { HonIdentityService } = require('../dist/foundation/hon-identity.service.js');
const { SchoolContactsHumanUiGuard } = require('../dist/people/school-contacts.controller.js');
const { ConversationReadGuard, ConversationReplyGuard, ConversationMarkReadGuard } = require('../dist/conversations/school-conversations.controller.js');

const env = { HON_AUTH_MODE: 'OIDC', HON_SESSION_JWT_SECRET: 'TEST_ONLY_HON_KEY_123456789012345678901234', HON_SESSION_AUDIENCE: 'hon-test-app', HON_PUBLIC_ORIGIN: 'https://hon.example' };
Object.assign(process.env, env);
const config = sessionConfig(env);
const identity = { externalSubject: 'oidc:iss:staff-1', displayName: 'Test Instructor' };
const staff = issueStaffMobileSession(identity, config);
const family = issueMobileSession(identity, config);
const service = new HonIdentityService();
const O = '11111111-1111-4111-8111-111111111111', S = '22222222-2222-4222-8222-222222222222', P = '33333333-3333-4333-8333-333333333333';
const SCHOOL = `/v1/organizations/${O}/schools/${S}`;
const req = (token, url, method = 'GET', headers = {}) => ({ headers: { authorization: `Bearer ${token}`, ...headers }, originalUrl: url, method });
const status = (fn) => { try { fn(); return 200; } catch (e) { return e.getStatus?.() ?? 'throw'; } };
const code = (fn) => { try { fn(); return null; } catch (e) { return e.getResponse?.().code ?? null; } };

const ALLOWED = [
  ['GET', `${SCHOOL}/contacts`], ['GET', `${SCHOOL}/contacts?query=ave`], ['GET', `${SCHOOL}/contacts/${P}`],
  ['GET', `${SCHOOL}/conversations`], ['GET', `${SCHOOL}/conversations/${P}`], ['GET', `${SCHOOL}/conversations/${P}?before=${P}`],
  ['POST', `${SCHOOL}/conversations/${P}/read`], ['POST', `${SCHOOL}/conversations/${P}/replies`],
];

test('a staff session reaches exactly the S4 People and Texts routes with their methods, marked STAFF', () => {
  for (const [method, url] of ALLOWED) {
    const r = req(staff, url, method);
    assert.equal(service.authenticate(r).externalSubject, identity.externalSubject, `${method} ${url}`);
    assert.equal(r.honMobileApp, 'STAFF');
  }
});

test('contact admin, conversation management, other methods and look-alike paths stay refused for the staff app', () => {
  const refused = [
    ['POST', `${SCHOOL}/contacts`], ['POST', `${SCHOOL}/contacts/${P}`], ['GET', `${SCHOOL}/contacts/${P}/archive`], ['POST', `${SCHOOL}/contacts/${P}/archive`],
    ['POST', `${SCHOOL}/contacts/${P}/restore`], ['GET', `${SCHOOL}/contacts/${P}/merge`], ['POST', `${SCHOOL}/contacts/${P}/merge`],
    ['POST', `${SCHOOL}/conversations`], ['POST', `${SCHOOL}/conversations/${P}`], ['GET', `${SCHOOL}/conversations/${P}/read`], ['GET', `${SCHOOL}/conversations/${P}/replies`],
    ['POST', `${SCHOOL}/conversations/${P}/update`], ['POST', `${SCHOOL}/conversations/${P}/link`], ['POST', `${SCHOOL}/conversations/${P}/lead`],
    ['PUT', `${SCHOOL}/conversations/${P}/replies`], ['DELETE', `${SCHOOL}/contacts/${P}`],
    ['GET', `${SCHOOL}/contacts/not-a-uuid`], ['GET', `${SCHOOL}/conversations/not-a-uuid`], ['POST', `${SCHOOL}/conversations/not-a-uuid/replies`],
    ['GET', `${SCHOOL}/contactsx`], ['GET', `${SCHOOL}/contacts/${P}/x`], ['POST', `${SCHOOL}/conversations/${P}/replies/x`], ['GET', `${SCHOOL}//contacts`],
    ['GET', `${SCHOOL}/people`], ['GET', `${SCHOOL}/staff/search`], ['GET', `/v1/staff/search`], ['GET', `${SCHOOL}/communications/messages`],
  ];
  for (const [method, url] of refused) {
    assert.equal(status(() => service.authenticate(req(staff, url, method))), 403, `${method} ${url}`);
    assert.equal(code(() => service.authenticate(req(staff, url, method))), 'MOBILE_SESSION_SCOPE', `${method} ${url}`);
  }
});

test('the family app never reaches the staff People and Texts routes', () => {
  for (const [method, url] of ALLOWED) assert.equal(status(() => service.authenticate(req(family, url, method))), 403, `${method} ${url}`);
});

const ctx = (request) => ({ switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ setHeader() {} }) }) });
const nativeGet = (patch = {}) => ({ method: 'GET', honChannel: 'MOBILE', honMobileApp: 'STAFF', headers: { authorization: `Bearer ${staff}`, ...patch } });
const nativePost = (command, patch = {}) => ({ method: 'POST', honChannel: 'MOBILE', honMobileApp: 'STAFF', body: {},
  headers: { authorization: `Bearer ${staff}`, 'content-type': 'application/json', 'x-hon-human-command': command, ...patch } });

test('reads: native staff GETs pass; delegation, automation or cross-site metadata stay refused', () => {
  for (const guard of [new SchoolContactsHumanUiGuard(), new ConversationReadGuard()]) {
    assert.equal(guard.canActivate(ctx(nativeGet())), true);
    for (const patch of [{ 'x-hon-source': 'AI' }, { 'x-hon-delegated-by-principal-id': P }, { 'x-hon-action-request-id': P }, { 'sec-fetch-site': 'cross-site' }]) {
      assert.equal(status(() => guard.canActivate(ctx(nativeGet(patch)))), 403, JSON.stringify(patch));
    }
  }
});

test('reply and mark read: the native rule needs the exact command, JSON and no browser metadata; the web rule is unchanged', () => {
  for (const [Guard, command] of [[ConversationReplyGuard, 'conversation.reply'], [ConversationMarkReadGuard, 'conversation.mark_read']]) {
    const guard = new Guard();
    assert.equal(guard.canActivate(ctx(nativePost(command))), true);
    for (const patch of [{ origin: 'https://hon.example' }, { 'sec-fetch-site': 'same-origin' }, { 'x-hon-human-command': 'conversation.update' }, { 'x-hon-human-command': undefined },
      { 'content-type': 'text/plain' }, { 'x-hon-source': 'AI' }]) {
      assert.equal(status(() => guard.canActivate(ctx(nativePost(command, patch)))), 403, `${command} ${JSON.stringify(patch)}`);
    }
    const web = (patch = {}) => ({ method: 'POST', honChannel: 'WEB', body: {}, headers: { cookie: 'hon_session=x', origin: 'https://hon.example', 'sec-fetch-site': 'same-origin',
      'content-type': 'application/json', 'x-hon-human-command': command, ...patch } });
    assert.equal(guard.canActivate(ctx(web())), true);
    for (const patch of [{ origin: undefined }, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
      assert.equal(status(() => guard.canActivate(ctx(web(patch)))), 403, `web ${command} ${JSON.stringify(patch)}`);
    }
  }
});
