const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { SaasAccessOverviewHqController } = require('../dist/school-billing/saas-school-billing.controller.js');
const { SaasSchoolBillingService } = require('../dist/school-billing/saas-school-billing.service.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

// B-HQ-1 HQ access overview (0219 proposed): closed query, closed response whose derived fields must agree with the facts,
// and a read-only route that forwards only the verified subject and the three declared query values.
const U = () => randomUUID(), T = '2026-11-01T00:00:00.000Z', T2 = '2026-11-02T00:00:00.000Z', LATER = '2026-12-01T00:00:00.000Z';
const ALL = ['ORGANIZATION_NOT_ACTIVE','NO_ACTIVE_SCHOOL','NO_ENTITLEMENT','EXCEPTION_POLICY_REQUIRED','ACCESS_EXCEPTION_ACTIVE','ENTITLEMENT_IN_EFFECT',
  'ACCESS_STATE_EXISTS','SUBSCRIPTION_EXISTS','CHECKOUT_OPEN'];
const ent = (patch = {}) => ({ tier: 'CORE', status: 'SUSPENDED', effectiveFrom: T, effectiveUntil: null, version: 1, inEffect: false, ...patch });
// A newly provisioned school: suspended, no access, eligible for an exception once the policy is approved.
const org = (patch = {}) => {
  const id = patch.organizationId ?? U();
  return { organizationId: id, organizationDisplayName: 'Fixture Dojo', organizationStatus: 'ACTIVE', createdAt: T,
    schools: [{ schoolId: U(), schoolDisplayName: 'Fixture Dojo Main', schoolStatus: 'ACTIVE' }], schoolCount: 1,
    entitlement: ent(), accessState: 'PROVISIONED', accessStatus: 'NO_ACCESS', currentException: null, subscription: null, openCheckout: false,
    ownerOnboarding: { status: 'NOT_INVITED', invitedAt: null, expiresAt: null, acceptedAt: null },
    exceptionGrant: { eligible: true, blockers: [], expectedEntitlementVersion: 1 }, ...patch };
};
const summary = (patch = {}) => ({ AWAITING_FIRST_PAYMENT: 0, EXCEPTION_IN_EFFECT: 0, EXCEPTION_SCHEDULED: 0, PAID_ACCESS: 0, PROVISIONED_ACCESS: 0, NO_ACCESS: 1,
  total: 1, ...patch });
const view = (patch = {}) => ({ viewer: { canGrantAndRevokeExceptions: true }, paidAccessProgram: 'INACTIVE',
  exceptionPolicy: { ready: true, maxDays: 90, validUntil: LATER, maxScheduleAheadDays: 30 }, summary: summary(), organizations: [org()], limit: 50,
  nextCursor: null, asOf: T2, ...patch });
const exception = (patch = {}) => ({ exceptionId: U(), schoolId: U(), purpose: 'INTERNAL_TESTING', scopeTier: 'COMPLETE', startsAt: T, expiresAt: LATER,
  lifecycle: 'IN_EFFECT', revocable: true, ...patch });

test('contracts: overview query is closed; the cursor round-trips', () => {
  const id = U();
  assert.deepEqual(contracts.validateSaasAccessOverviewQuery({}), { status: null, cursor: null, limit: 50 });
  const cursor = contracts.encodeSaasAccessOverviewCursor({ createdAt: T, organizationId: id });
  assert.deepEqual(contracts.validateSaasAccessOverviewQuery({ cursor, limit: '100', status: 'NO_ACCESS' }),
    { status: 'NO_ACCESS', cursor: { createdAt: T, organizationId: id }, limit: 100 });
  for (const bad of [{ limit: '0' }, { limit: '101' }, { limit: '07' }, { status: 'SUSPENDED' }, { status: ['NO_ACCESS'] }, { cursor: 'x' },
    { cursor: `${T}~${id}~1` }, { cursor: T }, { organizationId: U() }, { schoolId: U() }, { tier: 'COMPLETE' }])
    assert.throws(() => contracts.validateSaasAccessOverviewQuery(bad), JSON.stringify(bad));
});

test('contracts: a new suspended school is NO_ACCESS and eligible; every status is derived from the facts shown', () => {
  assert.equal(contracts.validateSaasAccessOverview(view()).organizations[0].accessStatus, 'NO_ACCESS');
  const one = o => view({ organizations: [o], summary: summary({ NO_ACCESS: 0, [o.accessStatus]: 1 }) });
  // In effect from provisioning (legacy customer): never eligible.
  assert.equal(contracts.validateSaasAccessOverview(one(org({ entitlement: ent({ status: 'ACTIVE', inEffect: true }), accessStatus: 'PROVISIONED_ACCESS',
    exceptionGrant: { eligible: false, blockers: ['ENTITLEMENT_IN_EFFECT'], expectedEntitlementVersion: 1 } }))).organizations.length, 1);
  // An exception in effect.
  const live = org({ entitlement: ent({ status: 'ACTIVE', inEffect: true, effectiveUntil: LATER, version: 2 }), accessStatus: 'EXCEPTION_IN_EFFECT',
    currentException: exception(), exceptionGrant: { eligible: false, blockers: ['ACCESS_EXCEPTION_ACTIVE','ENTITLEMENT_IN_EFFECT'], expectedEntitlementVersion: 2 } });
  assert.equal(contracts.validateSaasAccessOverview(one(live)).organizations[0].currentException.revocable, true);
  // Awaiting the first payment.
  assert.equal(contracts.validateSaasAccessOverview(one(org({ accessState: 'AWAITING_FIRST_PAYMENT', accessStatus: 'AWAITING_FIRST_PAYMENT',
    exceptionGrant: { eligible: false, blockers: ['ACCESS_STATE_EXISTS'], expectedEntitlementVersion: 1 } }))).organizations.length, 1);
  // Mislabelled status, or an exception summary whose revocable flag disagrees with its lifecycle.
  for (const bad of [org({ accessStatus: 'PAID_ACCESS' }), { ...live, accessStatus: 'PROVISIONED_ACCESS' },
    { ...live, currentException: exception({ revocable: false }) }, { ...live, currentException: exception({ lifecycle: 'REVOKED', revocable: false }) },
    { ...live, currentException: exception({ lifecycle: 'EXPIRED', revocable: true }) }])
    assert.throws(() => contracts.validateSaasAccessOverview(one(bad)), JSON.stringify(bad.accessStatus));
});

test('contracts: grant eligibility must agree with the facts; it never hides a refusal the database would make', () => {
  const ok = o => contracts.validateSaasAccessOverview(view({ organizations: [o] }));
  const no = (o, why) => assert.throws(() => contracts.validateSaasAccessOverview(view({ organizations: [o] })), why);
  no(org({ exceptionGrant: { eligible: false, blockers: [], expectedEntitlementVersion: 1 } }), 'eligible must equal no blockers');
  no(org({ exceptionGrant: { eligible: true, blockers: ['CHECKOUT_OPEN'], expectedEntitlementVersion: 1 } }), 'eligible with a blocker');
  no(org({ openCheckout: true }), 'open checkout must block');
  no(org({ subscription: { subscriptionId: U(), status: 'IN_SERVICE', planCode: 'CORE', billingInterval: 'MONTHLY' } }), 'subscription must block');
  no(org({ subscription: { subscriptionId: U(), status: 'VOIDED', planCode: 'CORE', billingInterval: 'MONTHLY' },
    exceptionGrant: { eligible: false, blockers: ['SUBSCRIPTION_EXISTS'], expectedEntitlementVersion: 1 } }), 'voided subscriptions are never shown');
  no(org({ organizationStatus: 'SUSPENDED' }), 'inactive organization must block');
  no(org({ exceptionGrant: { eligible: true, blockers: [], expectedEntitlementVersion: 2 } }), 'version must be the entitlement version');
  no(org({ exceptionGrant: { eligible: false, blockers: ['CHECKOUT_OPEN','SUBSCRIPTION_EXISTS'], expectedEntitlementVersion: 1 },
    openCheckout: true, subscription: { subscriptionId: U(), status: 'IN_SERVICE', planCode: 'CORE', billingInterval: 'MONTHLY' } }), 'blockers in command order');
  no(org({ exceptionGrant: { eligible: false, blockers: ['NOT_A_BLOCKER'], expectedEntitlementVersion: 1 } }), 'closed blocker list');
  ok(org({ openCheckout: true, subscription: { subscriptionId: U(), status: 'IN_SERVICE', planCode: 'CORE', billingInterval: 'MONTHLY' },
    exceptionGrant: { eligible: false, blockers: ['SUBSCRIPTION_EXISTS','CHECKOUT_OPEN'], expectedEntitlementVersion: 1 } }));
  // Policy not ready: every row must carry EXCEPTION_POLICY_REQUIRED.
  const unready = { ready: false, maxDays: null, validUntil: null, maxScheduleAheadDays: 30 };
  assert.throws(() => contracts.validateSaasAccessOverview(view({ exceptionPolicy: unready })));
  assert.equal(contracts.validateSaasAccessOverview(view({ exceptionPolicy: unready,
    organizations: [org({ exceptionGrant: { eligible: false, blockers: ['EXCEPTION_POLICY_REQUIRED'], expectedEntitlementVersion: 1 } })] })).exceptionPolicy.ready, false);
  assert.throws(() => contracts.validateSaasAccessOverview(view({ exceptionPolicy: { ...unready, maxDays: 90 } })));
  assert.throws(() => contracts.validateSaasAccessOverview(view({ exceptionPolicy: { ready: true, maxDays: 91, validUntil: LATER, maxScheduleAheadDays: 30 } })));
  assert.throws(() => contracts.validateSaasAccessOverview(view({ exceptionPolicy: { ready: true, maxDays: 90, validUntil: LATER, maxScheduleAheadDays: 60 } })));
});

test('contracts: no email, token, credits or price fields; summary, order and cursor are consistent', () => {
  for (const [path, extra] of [['ownerOnboarding', { email: 'owner@example.test' }], ['ownerOnboarding', { tokenHash: 'a'.repeat(64) }],
    ['root', { aiCredits: 12000 }], ['root', { priceMinor: 24900 }], ['subscription', { priceMinor: 24900 }]]) {
    const o = org(path === 'subscription' ? { subscription: { subscriptionId: U(), status: 'IN_SERVICE', planCode: 'CORE', billingInterval: 'MONTHLY' },
      exceptionGrant: { eligible: false, blockers: ['SUBSCRIPTION_EXISTS'], expectedEntitlementVersion: 1 } } : {});
    const bad = path === 'root' ? { ...o, ...extra } : { ...o, [path]: { ...o[path], ...extra } };
    assert.throws(() => contracts.validateSaasAccessOverview(view({ organizations: [bad] })), JSON.stringify(extra));
  }
  assert.throws(() => contracts.validateSaasAccessOverview(view({ summary: summary({ total: 2 }) })), 'summary total');
  assert.throws(() => contracts.validateSaasAccessOverview(view({ viewer: { canGrantAndRevokeExceptions: true, hqRole: 'HON_HQ_OWNER' } })));
  const pending = org({ ownerOnboarding: { status: 'PENDING', invitedAt: T, expiresAt: T2, acceptedAt: null } });
  assert.equal(contracts.validateSaasAccessOverview(view({ organizations: [pending] })).organizations.length, 1);
  assert.throws(() => contracts.validateSaasAccessOverview(view({ organizations: [{ ...pending, ownerOnboarding: { ...pending.ownerOnboarding, status: 'ACCEPTED' } }] })));
  const a = org({ createdAt: T }), b = org({ createdAt: T2 });
  const two = summary({ NO_ACCESS: 2, total: 2 });
  assert.equal(contracts.validateSaasAccessOverview(view({ summary: two, organizations: [a, b], limit: 2,
    nextCursor: { createdAt: T2, organizationId: b.organizationId } })).organizations.length, 2);
  assert.throws(() => contracts.validateSaasAccessOverview(view({ summary: two, organizations: [b, a], limit: 2, nextCursor: null })), 'order');
  assert.throws(() => contracts.validateSaasAccessOverview(view({ summary: two, organizations: [a, b], limit: 2,
    nextCursor: { createdAt: T, organizationId: a.organizationId } })), 'cursor must be the last row');
  assert.throws(() => contracts.validateSaasAccessOverview(view({ summary: two, organizations: [a], limit: 2,
    nextCursor: { createdAt: T, organizationId: a.organizationId } })), 'a short page has no next cursor');
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
async function appWith(callSaasBilling) {
  const module = await Test.createTestingModule({ controllers: [SaasAccessOverviewHqController],
    providers: [SaasSchoolBillingService, SaasBillingService, SaasReadGuard, SaasCommandGuard, { provide: RuntimeDatabaseService, useValue: { callSaasBilling } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication({ bodyParser: false });
  app.use(json({ strict: true })); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${app.getHttpServer().address().port}/v1` };
}

test('HTTP: the overview is a no-store read that forwards only the verified subject and the declared query', async () => {
  const calls = []; let reply = () => view();
  const { app, base } = await appWith(async (operation, params) => { calls.push([operation, params]); return reply(); });
  try {
    const ok = await send(`${base}/hq/saas/access-overview`);
    assert.equal(ok.status, 200, ok.body); assert.equal(ok.headers['cache-control'], 'private, no-store');
    assert.deepEqual(calls.at(-1), ['readAccessOverview', ['verified-human', null, null, null, '50']]);
    const id = U();
    const paged = await send(`${base}/hq/saas/access-overview?status=NO_ACCESS&limit=10&cursor=${encodeURIComponent(`${T}~${id}`)}`);
    assert.equal(paged.status, 200, paged.body);
    assert.deepEqual(calls.at(-1), ['readAccessOverview', ['verified-human', 'NO_ACCESS', T, id, '10']]);
    const n = calls.length;
    for (const url of ['?organizationId=' + U(), '?status=SUSPENDED', '?limit=500', '?cursor=bad', '?subject=someone-else'])
      assert.equal((await send(`${base}/hq/saas/access-overview${url}`)).status, 400, url);
    assert.equal((await send(`${base}/hq/saas/access-overview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
    assert.equal(calls.length, n, 'refused requests never reach the database');
    // The database decides who may read; its refusal is a plain 403 with no detail.
    reply = () => { const e = new Error('SAAS_FORBIDDEN'); e.code = '42501'; throw e; };
    const denied = await send(`${base}/hq/saas/access-overview`);
    assert.deepEqual([denied.status, JSON.parse(denied.body).code], [403, 'SAAS_FORBIDDEN']);
    // A drifted database result is never shown.
    reply = () => ({ ...view(), organizations: [{ ...org(), email: 'owner@example.test' }] });
    assert.equal((await send(`${base}/hq/saas/access-overview`)).status, 503);
  } finally { await app.close(); }
});
