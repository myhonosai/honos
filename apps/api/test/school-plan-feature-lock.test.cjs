const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
const { Controller, Get, Post, ForbiddenException, ServiceUnavailableException, UnauthorizedException } = require('@nestjs/common');
const { APP_INTERCEPTOR } = require('@nestjs/core');
const { PATH_METADATA } = require('@nestjs/common/constants');
const contracts = require('@hon/contracts');
const { SchoolPlanFeatureInterceptor } = require('../dist/saas-billing/school-plan-feature.interceptor.js');
const { AppModule } = require('../dist/app.module.js');

const paths = v => Array.isArray(v) ? v.map(String) : [typeof v === 'string' ? v : ''];
function inventory() {
  const out = [];
  for (const c of Reflect.getMetadata('controllers', AppModule) ?? []) {
    for (const base of paths(Reflect.getMetadata(PATH_METADATA, c))) {
      for (const name of Object.getOwnPropertyNames(c.prototype)) {
        const fn = c.prototype[name];
        if (name === 'constructor' || typeof fn !== 'function' || Reflect.getMetadata(PATH_METADATA, fn) === undefined) continue;
        for (const h of paths(Reflect.getMetadata(PATH_METADATA, fn))) {
          const route = `${base}/${h}`.replace(/\/+/g, '/').replace(/\/$/, '');
          out.push({ route, capability: contracts.schoolPlanFeatureForRoute(route) });
        }
      }
    }
  }
  return out;
}

test('every lockable area is a real school route, and the Upgrade path, settings and shared records are never locked', () => {
  const routes = inventory();
  assert(routes.length > 500, 'the whole app is inventoried');
  for (const [area, capability] of Object.entries(contracts.SCHOOL_PLAN_FEATURE_API_AREAS)) {
    assert(routes.some(r => new RegExp(`schools/:schoolId/${area}(/|$)`, 'i').test(r.route)), `area ${area} matches a route`);
    if (capability) assert(contracts.HON_OS_PLAN_CAPABILITIES.includes(capability));
  }
  const never = /schools\/:schoolId\/(hon-plan|hon-os-|hon-billing|plan-features|plan-promotions|settings|people|crm|schedule|billing|payments|reports|staff\/(shifts|time)|staff-roles|communications|conversations|marketing\/social\/inbox|creative-studio\/avatar-photos|language|interface)/;
  const lockedNever = routes.filter(r => r.capability && never.test(r.route));
  assert.deepEqual(lockedNever, []);
  for (const r of routes.filter(r => !/schools\/:schoolId\//.test(r.route))) assert.equal(r.capability, contracts.SCHOOL_PLAN_FEATURE_STAFF_ROUTES[r.route.replace(/^\//, '')] ?? null, r.route);
  assert.equal(contracts.schoolPlanFeatureForRoute('organizations/:organizationId/schools/:schoolId/ai/team/capabilities'), 'ai.workforce');
  assert.equal(contracts.schoolPlanFeatureForRoute('/organizations/:organizationId/schools/:schoolId/marketing/social/ads/'), 'marketing.connections_reporting');
  assert.equal(contracts.schoolPlanFeatureForRoute('organizations/:organizationId/schools/:schoolId/marketing/social/inbox'), null);
  assert.equal(contracts.schoolPlanFeatureForRoute('organizations/:organizationId/schools/:schoolId/marketing/social'), 'marketing.campaigns_manual_assisted');
  assert.equal(contracts.schoolPlanFeatureForRoute('organizations/:organizationId/schools/:schoolId/AI/Team'), 'ai.workforce');
  assert.equal(contracts.schoolPlanFeatureForRoute('organizations/:organizationId/schools/:schoolId/hon-plan'), null);
  assert(routes.filter(r => r.capability === 'ai.workforce').length >= 10);
  assert.equal(contracts.schoolPlanFeatureForRoute('/staff/action-center/approvals/:schoolId/:actionRequestId/chad-send/'), 'ai.workforce');
  assert.equal(contracts.schoolPlanFeatureForRoute('staff/action-center/approvals/:schoolId/:actionRequestId/decision'), null);
  for (const t of Object.keys(contracts.SCHOOL_PLAN_FEATURE_STAFF_ROUTES)) assert(routes.some(r => r.route === t), `staff route ${t} exists`);
  // Every route carrying :schoolId outside .../schools/:schoolId/ is reviewed here, so a new one fails until it is mapped.
  const outside = [...new Set(routes.filter(r => /:schoolId/.test(r.route) && !/schools\/:schoolId(\/|$)/.test(r.route)).map(r => r.route.replace(/^\//, '')))].sort();
  assert.deepEqual(outside, ['staff/action-center/approvals/:schoolId', 'staff/action-center/approvals/:schoolId/:actionRequestId',
    'staff/action-center/approvals/:schoolId/:actionRequestId/chad-send', 'staff/action-center/approvals/:schoolId/:actionRequestId/decision',
    'staff/voice/:schoolId', 'staff/voice/:schoolId/:sessionId', 'staff/voice/:schoolId/:sessionId/end',
    'staff/voice/:schoolId/:sessionId/mark-fallback', 'staff/voice/:schoolId/:sessionId/status']);
  // Not locked yet, on purpose (piece 4 "Not covered"): the school comes from the body or query, or the route serves HON and
  // the agents alike (staff voice picks its agent in the body). Pinned so this list only changes in review.
  const NOT_YET = /^\/?staff\/(voice|leads\/assistant|teaching-assistant|testing\/(certificates|scorecards|registrations))(\/|$)/;
  assert.deepEqual([...new Set(routes.filter(r => NOT_YET.test(r.route)).map(r => r.route.replace(/^\//, '').split('/').slice(0, 3).join('/')))].sort(),
    ['staff/leads/assistant', 'staff/teaching-assistant', 'staff/teaching-assistant/:invocationId', 'staff/teaching-assistant/curricula',
     'staff/teaching-assistant/mine', 'staff/testing/certificates', 'staff/testing/registrations', 'staff/testing/scorecards',
     'staff/voice/:schoolId']);
  assert(routes.filter(r => NOT_YET.test(r.route)).every(r => r.capability === null));
});

function decorate(path, methods) {
  class C {}
  for (const [name, verb, sub] of methods) { C.prototype[name] = function () {}; (verb === 'GET' ? Get : Post)(sub)(C.prototype, name, Object.getOwnPropertyDescriptor(C.prototype, name)); }
  Controller(path)(C);
  return C;
}
const SCHOOL = randomUUID(), ORG = randomUUID();
function features(locked) {
  const all = contracts.HON_OS_PLAN_CAPABILITIES;
  return { schoolId: SCHOOL, source: locked.length ? 'OFFER' : 'NONE', planName: locked.length ? 'HON OS Core' : null,
    included: all.filter(c => !locked.includes(c)), locked, asOf: '2026-11-28T05:00:00.000Z' };
}
function harness({ read, authenticate } = {}) {
  const calls = [];
  const billing = { readSchoolPlanFeatures: async (subject, school) => { calls.push([subject, school]); return read ? read(subject, school) : features([]); } };
  const identity = { authenticate: () => authenticate ? authenticate() : { externalSubject: 'cookie-subject' } };
  return { calls, interceptor: new SchoolPlanFeatureInterceptor(billing, identity) };
}
const AI = ['marketing.campaigns_ai_managed', 'attribution.ai_insight', 'ai.workforce', 'ai.delegated_jobs', 'ai.orchestration'];
async function run(h, cls, method, { params = { organizationId: ORG, schoolId: SCHOOL }, identity = { externalSubject: 'staff-subject' } } = {}) {
  let handled = 0;
  const req = { params, honIdentity: identity ?? undefined };
  const context = { getType: () => 'http', getClass: () => cls, getHandler: () => cls.prototype[method], switchToHttp: () => ({ getRequest: () => req }) };
  const result = await h.interceptor.intercept(context, { handle: () => { handled++; return 'handled'; } });
  return { result, handled };
}

test('a locked feature area answers 403 PLAN_FEATURE_LOCKED before the handler runs; everything else passes through', async () => {
  const Team = decorate('organizations/:organizationId/schools/:schoolId/ai/team', [['read', 'GET', undefined], ['cmd', 'POST', 'x']]);
  const Mixed = decorate('organizations/:organizationId/schools/:schoolId', [['people', 'GET', 'people'], ['hon', 'GET', 'hon'], ['ads', 'POST', 'marketing/social/ads/:id/pause']]);
  const Plan = decorate('organizations/:organizationId/schools/:schoolId/hon-plan', [['buy', 'POST', 'checkout']]);
  // AI team left out of the plan: both the read and a command are refused, the handler never runs.
  let h = harness({ read: () => features(AI) });
  for (const m of ['read', 'cmd']) {
    await assert.rejects(run(h, Team, m), e => e instanceof ForbiddenException && e.getResponse().code === 'PLAN_FEATURE_LOCKED' && e.getResponse().capability === 'ai.workforce');
  }
  assert.deepEqual(h.calls, [['staff-subject', SCHOOL], ['staff-subject', SCHOOL]]);
  // Areas the plan includes, shared records and the Upgrade (HON OS purchase) path pass, and only feature areas read the plan.
  for (const [cls, m] of [[Mixed, 'people'], [Mixed, 'hon'], [Mixed, 'ads'], [Plan, 'buy']]) assert.equal((await run(h, cls, m)).handled, 1);
  assert.equal(h.calls.length, 4, 'people and hon-plan never read the plan');
  // A feature route that carries the school outside .../schools/:schoolId/ (Chad send from the Action Center).
  const Approvals = decorate('staff/action-center/approvals/:schoolId', [['send', 'GET', ':actionRequestId/chad-send'], ['decide', 'POST', ':actionRequestId/decision']]);
  await assert.rejects(run(h, Approvals, 'send'), e => e.getResponse().code === 'PLAN_FEATURE_LOCKED' && e.getResponse().capability === 'ai.workforce');
  assert.equal((await run(h, Approvals, 'decide')).handled, 1);
  // HON's own speech belongs to HON, not the AI team: a plan without the AI team keeps HON's voice.
  const Speech = decorate('organizations/:organizationId/schools/:schoolId/agents/:agentKey/speech', [['status', 'GET', undefined]]);
  assert.equal((await run(h, Speech, 'status', { params: { organizationId: ORG, schoolId: SCHOOL, agentKey: 'hon' } })).handled, 1);
  await assert.rejects(run(h, Speech, 'status', { params: { organizationId: ORG, schoolId: SCHOOL, agentKey: 'maya' } }), e => e.getResponse().capability === 'ai.workforce');
  h = harness({ read: () => features(['assistant.ordinary']) });
  await assert.rejects(run(h, Speech, 'status', { params: { organizationId: ORG, schoolId: SCHOOL, agentKey: 'hon' } }), e => e.getResponse().capability === 'assistant.ordinary');
  h = harness({ read: () => features(AI) });
  // The handler's own path decides: a method under a broad controller is matched too.
  h = harness({ read: () => features(['marketing.connections_reporting']) });
  await assert.rejects(run(h, Mixed, 'ads'), e => e.getResponse().capability === 'marketing.connections_reporting');
  // No plan or a custom plan locks nothing.
  h = harness();
  assert.equal((await run(h, Team, 'read')).handled, 1);
  // Not this school's staff (parent, other school, unknown school): the route's own authorization decides.
  for (const status of [ForbiddenException, () => new (require('@nestjs/common').BadRequestException)(), () => new (require('@nestjs/common').NotFoundException)()]) {
    const make = status === ForbiddenException ? () => new ForbiddenException({ code: 'SAAS_FORBIDDEN' }) : status;
    h = harness({ read: () => { throw make(); } });
    assert.equal((await run(h, Team, 'read')).handled, 1);
  }
  // The plan read failing for any other reason refuses: a locked feature never slips through on an outage.
  h = harness({ read: () => { throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' }); } });
  await assert.rejects(run(h, Team, 'read'), e => e instanceof ServiceUnavailableException);
  h = harness({ read: () => { throw new Error('socket closed'); } });
  await assert.rejects(run(h, Team, 'read'), e => e instanceof ServiceUnavailableException);
  // A route without HonIdentityGuard: the session is read here; no session passes to the route, which refuses on its own.
  h = harness({ read: () => features(AI) });
  await assert.rejects(run(h, Team, 'read', { identity: null }), e => e.getResponse().code === 'PLAN_FEATURE_LOCKED');
  assert.equal(h.calls[0][0], 'cookie-subject');
  h = harness({ read: () => features(AI), authenticate: () => { throw new UnauthorizedException(); } });
  assert.equal((await run(h, Team, 'read', { identity: null })).handled, 1);
  assert.equal(h.calls.length, 0);
  // A malformed school id never reaches the plan read.
  h = harness({ read: () => features(AI) });
  assert.equal((await run(h, Team, 'read', { params: { schoolId: 'nope' } })).handled, 1);
  assert.equal(h.calls.length, 0);
});

test('the interceptor is registered app-wide', () => {
  const providers = Reflect.getMetadata('providers', AppModule) ?? [];
  assert(providers.some(p => p && p.provide === APP_INTERCEPTOR && p.useClass === SchoolPlanFeatureInterceptor));
});
