const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { HqSchoolDetailController } = require('../dist/school-billing/saas-school-billing.controller.js');
const { SaasSchoolBillingService } = require('../dist/school-billing/saas-school-billing.service.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

// C-HQ-3 HQ school detail (0225 proposed): a closed response with counts only, and a read-only route that forwards only
// the verified subject and the school id from the path.
const U = () => randomUUID(), T = '2026-11-01T00:00:00.000Z', T2 = '2026-11-02T00:00:00.000Z';
const zero = () => ({ pending: 0, expired: 0, accepted: 0, revoked: 0, ended: 0 });
const detail = (patch = {}) => {
  const schoolId = patch.schoolId ?? U();
  return {
    school: { schoolId, schoolDisplayName: 'Fixture Dojo Main', slug: 'fixture-dojo', timezone: 'America/Chicago', schoolStatus: 'ACTIVE', createdAt: T },
    organization: { organizationId: U(), organizationDisplayName: 'Fixture Dojo', organizationStatus: 'ACTIVE', createdAt: T,
      schools: [{ schoolId, schoolDisplayName: 'Fixture Dojo Main', schoolStatus: 'ACTIVE' }], schoolCount: 1,
      entitlement: { tier: 'CORE', status: 'SUSPENDED', effectiveFrom: T, effectiveUntil: null, version: 1, inEffect: false },
      accessState: 'PROVISIONED', accessStatus: 'NO_ACCESS', currentException: null, subscription: null, openCheckout: false,
      ownerOnboarding: { status: 'NOT_INVITED', invitedAt: null, expiresAt: null, acceptedAt: null },
      exceptionGrant: { eligible: true, blockers: [], expectedEntitlementVersion: 1 } },
    exceptionPolicyReady: true,
    ownership: { ownerCount: 0, primaryOwnerGrantId: null, primaryNeeded: false, hqSeatCount: 1 },
    invitations: { owner: zero(), staff: zero(), family: zero() },
    people: { staffWithAccess: 0, familyMembersWithAccess: 0, activeStudents: 0 },
    viewer: { canGrantAndRevokeExceptions: true, canManageOwnership: true },
    asOf: T2, ...patch.root };
};
const v = x => contracts.validateHqSchoolDetail(x);

test('contracts: a freshly provisioned school is valid; ownership flags must agree', () => {
  assert.equal(v(detail()).ownership.hqSeatCount, 1);
  const own = o => { const d = detail(); d.ownership = { ...d.ownership, ...o }; return d; };
  assert.equal(v(own({ ownerCount: 2, primaryNeeded: true })).ownership.primaryNeeded, true);
  assert.equal(v(own({ ownerCount: 2, primaryOwnerGrantId: U() })).ownership.ownerCount, 2);
  for (const bad of [{ ownerCount: 2 }, { primaryNeeded: true }, { primaryOwnerGrantId: U() }, { ownerCount: -1 }, { hqSeatCount: 1.5 },
    { primaryOwnerGrantId: 'nope', ownerCount: 1 }])
    assert.throws(() => v(own(bad)), JSON.stringify(bad));
});

test('contracts: counts are closed integers; only family invitations can be ended', () => {
  const inv = (k, c) => { const d = detail(); d.invitations[k] = { ...zero(), ...c }; return d; };
  assert.equal(v(inv('family', { ended: 2 })).invitations.family.ended, 2);
  for (const [k, c] of [['owner', { ended: 1 }], ['staff', { ended: 1 }], ['owner', { pending: -1 }], ['staff', { pending: '1' }], ['family', { cancelled: 1 }]])
    assert.throws(() => v(inv(k, c)), `${k} ${JSON.stringify(c)}`);
  const d = detail(); d.people.activeStudents = 0.5; assert.throws(() => v(d));
});

test('contracts: no personal data or stray fields; the school must belong to its organization', () => {
  for (const [path, extra] of [['school', { ownerEmail: 'owner@example.test' }], ['people', { names: ['A'] }], ['ownership', { owners: [] }],
    ['invitations', { emails: [] }], ['viewer', { hqRole: 'HON_HQ_OWNER' }], ['root', { tokenHash: 'a'.repeat(64) }]]) {
    const d = detail(); if (path === 'root') Object.assign(d, extra); else Object.assign(d[path], extra);
    assert.throws(() => v(d), `${path} ${JSON.stringify(extra)}`);
  }
  const other = detail(); other.organization.schools = [{ schoolId: U(), schoolDisplayName: 'Other', schoolStatus: 'ACTIVE' }];
  assert.throws(() => v(other), 'school missing from its organization');
  const viewer = detail(); viewer.viewer = { canGrantAndRevokeExceptions: false, canManageOwnership: true };
  assert.throws(() => v(viewer), 'viewer flags disagree');
  const unready = detail(); unready.exceptionPolicyReady = false;
  assert.throws(() => v(unready), 'organization blockers must reflect the policy state');
  const long = detail(); long.school.schoolDisplayName = 'x'.repeat(301); assert.throws(() => v(long));
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
async function appWith(callSaasBilling) {
  const module = await Test.createTestingModule({ controllers: [HqSchoolDetailController],
    providers: [SaasSchoolBillingService, SaasBillingService, SaasReadGuard, SaasCommandGuard, { provide: RuntimeDatabaseService, useValue: { callSaasBilling } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication({ bodyParser: false });
  app.use(json({ strict: true })); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${app.getHttpServer().address().port}/v1` };
}

test('HTTP: the school detail is a no-store read that forwards only the verified subject and the path id', async () => {
  const calls = []; const id = U(); let reply = () => detail({ schoolId: id });
  const { app, base } = await appWith(async (operation, params) => { calls.push([operation, params]); return reply(); });
  try {
    const ok = await send(`${base}/hq/saas/schools/${id.toUpperCase()}`);
    assert.equal(ok.status, 200, ok.body); assert.equal(ok.headers['cache-control'], 'private, no-store');
    assert.deepEqual(calls.at(-1), ['readHqSchoolDetail', ['verified-human', id]]);
    assert.equal(JSON.parse(ok.body).data.school.schoolId, id);
    const n = calls.length;
    for (const url of [`/hq/saas/schools/not-a-uuid`, `/hq/saas/schools/${id}?subject=someone-else`, `/hq/saas/schools/${id}?schoolId=${U()}`])
      assert.equal((await send(`${base}${url}`)).status, 400, url);
    assert.equal((await send(`${base}/hq/saas/schools/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
    assert.equal(calls.length, n, 'refused requests never reach the database');
    reply = () => { const e = new Error('SAAS_FORBIDDEN'); e.code = '42501'; throw e; };
    const denied = await send(`${base}/hq/saas/schools/${id}`);
    assert.deepEqual([denied.status, JSON.parse(denied.body).code], [403, 'SAAS_FORBIDDEN']);
    reply = () => { const e = new Error('HQ_SCHOOL_NOT_FOUND'); e.code = 'P0002'; throw e; };
    const missing = await send(`${base}/hq/saas/schools/${id}`);
    assert.deepEqual([missing.status, JSON.parse(missing.body).code], [404, 'SAAS_UNAVAILABLE']);
    // A drifted database result is never shown.
    reply = () => { const d = detail({ schoolId: id }); d.people.emails = ['owner@example.test']; return d; };
    assert.equal((await send(`${base}/hq/saas/schools/${id}`)).status, 503);
  } finally { await app.close(); }
});
