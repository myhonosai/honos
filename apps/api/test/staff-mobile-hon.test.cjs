// S2 HON Staff app HON tab (docs/architecture/STAFF_MOBILE_HON.md): a staff bearer session reaches exactly the agent
// list (readiness), the person's own conversations, one conversation and sending a turn, each with exact methods. The
// HON transport guard admits a native staff POST without loosening the browser rule, and a switched-off agent (0635
// HON_AGENT_OFF) is reported as its own 403 code.
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { issueMobileSession, issueStaffMobileSession, sessionConfig } = require('@hon/auth');
const { HonIdentityService } = require('../dist/foundation/hon-identity.service.js');
const { HonConversationHumanUiGuard, HonConversationService } = require('../dist/hon-conversation/hon-conversation.controller.js');

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
  ['GET', `${SCHOOL}/hon/readiness`],
  ['GET', `${SCHOOL}/hon/conversations`],
  ['GET', `${SCHOOL}/hon/conversations?limit=20`],
  ['POST', `${SCHOOL}/hon/conversations`],
  ['GET', `${SCHOOL}/hon/conversations/${C}`],
  ['POST', `${SCHOOL}/hon/conversations/${C}/turns`],
];

test('a staff session reaches exactly the S2 HON routes with their methods, marked STAFF', () => {
  for (const [method, url] of ALLOWED) {
    const r = req(staff, url, method);
    assert.equal(service.authenticate(r).externalSubject, identity.externalSubject, `${method} ${url}`);
    assert.equal(r.honChannel, 'MOBILE');
    assert.equal(r.honMobileApp, 'STAFF');
  }
});

test('other methods, the web-only HON settings and look-alike paths stay refused for the staff app', () => {
  const refused = [
    ['POST', `${SCHOOL}/hon/readiness`], ['DELETE', `${SCHOOL}/hon/conversations`], ['PUT', `${SCHOOL}/hon/conversations`],
    ['POST', `${SCHOOL}/hon/conversations/${C}`], ['GET', `${SCHOOL}/hon/conversations/${C}/turns`], ['PATCH', `${SCHOOL}/hon/conversations/${C}/turns`],
    ['GET', `${SCHOOL}/hon/conversations/${C}/orchestrations`],
    ['GET', `${SCHOOL}/hon/tone`], ['POST', `${SCHOOL}/hon/tone`], ['GET', `${SCHOOL}/hon/briefing`], ['GET', `${SCHOOL}/hon/briefing/preview`],
    ['POST', `${SCHOOL}/hon/briefing/settings`], ['POST', `${SCHOOL}/hon/briefing/me`], ['GET', `${SCHOOL}/hon/school-notes`], ['POST', `${SCHOOL}/hon/school-notes`],
    ['POST', `${SCHOOL}/hon/school-notes/${C}/delete`],
    ['GET', `${SCHOOL}/hon`], ['GET', `${SCHOOL}/hon/readinessx`], ['GET', `${SCHOOL}/hon/readiness/x`], ['GET', `${SCHOOL}/hon/conversations/not-a-uuid`],
    ['POST', `${SCHOOL}/hon/conversations/not-a-uuid/turns`], ['POST', `${SCHOOL}/hon/conversations/${C}/turns/x`], ['GET', `${SCHOOL}/hon/conversations/${C}%2Fturns`],
    ['GET', `${SCHOOL.replace('/v1/', '/V1/')}/hon/readiness`], ['GET', `/v1/organizations/o/schools/s/hon/readiness`], ['GET', `${SCHOOL}//hon/readiness`],
    ['GET', `${SCHOOL}/ai-team/readiness`], ['POST', `${SCHOOL}/teaching-assistant/requests`], ['POST', `${SCHOOL}/marketing/assistant/requests`],
  ];
  for (const [method, url] of refused) {
    assert.equal(status(() => service.authenticate(req(staff, url, method))), 403, `${method} ${url}`);
    assert.equal(code(() => service.authenticate(req(staff, url, method))), 'MOBILE_SESSION_SCOPE', `${method} ${url}`);
  }
});

test('the family app never reaches the staff HON routes', () => {
  for (const [method, url] of ALLOWED) assert.equal(status(() => service.authenticate(req(family, url, method))), 403, `${method} ${url}`);
});

const ctx = (request) => ({ switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ setHeader() {} }) }) });
const command = (patch = {}, requestPatch = {}) => ({ method: 'POST', honChannel: 'MOBILE', honMobileApp: 'STAFF', body: {},
  headers: { authorization: `Bearer ${staff}`, 'content-type': 'application/json', 'x-hon-human-command': 'hon-conversation', ...patch }, ...requestPatch });

test('HON commands: the native rule admits the staff app with the exact command name; browser metadata or another command is refused', () => {
  const guard = new HonConversationHumanUiGuard();
  assert.equal(guard.canActivate(ctx(command())), true);
  for (const patch of [{ origin: 'https://hon.example' }, { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'cross-site' }, { 'x-hon-human-command': 'marketing-campaign' },
    { 'x-hon-human-command': undefined }, { 'content-type': 'text/plain' }, { 'content-type': undefined }]) {
    assert.equal(status(() => guard.canActivate(ctx(command(patch)))), 403, JSON.stringify(patch));
  }
  assert.equal(status(() => guard.canActivate(ctx(command({}, { method: 'PUT' })))), 403, 'PUT');
  // Reads are GETs and pass the guard; the route then resolves school and ai.invocation.plan itself.
  assert.equal(guard.canActivate(ctx({ method: 'GET', honChannel: 'MOBILE', honMobileApp: 'STAFF', headers: { authorization: `Bearer ${staff}` } })), true);
  // The browser rule is unchanged: exact Origin, same-origin fetch site, exact command.
  const web = (patch = {}) => ({ method: 'POST', honChannel: 'WEB', body: {}, headers: { cookie: 'hon_session=x', origin: 'https://hon.example', 'sec-fetch-site': 'same-origin',
    'content-type': 'application/json', 'x-hon-human-command': 'hon-conversation', ...patch } });
  assert.equal(guard.canActivate(ctx(web())), true);
  for (const patch of [{ origin: undefined }, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { 'x-hon-human-command': 'other' }]) {
    assert.equal(status(() => guard.canActivate(ctx(web(patch)))), 403, `web ${JSON.stringify(patch)}`);
  }
});

test('a turn for a switched-off agent is its own 403 (HON_AGENT_OFF); other refusals keep their codes', async () => {
  const scope = { organizationId: O, schoolId: S, principalId: C, externalSubject: identity.externalSubject };
  const failWith = (error) => ({
    withTenantTransaction: async () => { throw error; }, withTenantReadOnlyTransaction: async () => { throw error; },
  });
  const run = async (error) => {
    const conversations = new HonConversationService(failWith(error), {}, {}, {}, {}, {});
    try { await conversations.sendTurn(scope, C, { text: 'How many students came this week?', delegation: null }, '44444444-4444-4444-8444-444444444444'); return null; }
    catch (e) { return [e.getStatus?.(), e.getResponse?.().code]; }
  };
  assert.deepEqual(await run(Object.assign(new Error('HON_AGENT_OFF'), { code: '42501' })), [403, 'HON_AGENT_OFF']);
  assert.deepEqual(await run(Object.assign(new Error('permission denied'), { code: '42501' })), [403, 'HON_CONVERSATION_FORBIDDEN']);
  assert.deepEqual(await run(Object.assign(new Error('AI_HQ_PAUSED'), { code: '42501' })), [403, 'HON_AI_SPEND_REFUSED']);
});
