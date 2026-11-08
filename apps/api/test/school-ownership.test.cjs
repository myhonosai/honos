const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { SchoolOwnershipService } = require('../dist/accounts/school-ownership.service.js');
const { SchoolOwnershipController } = require('../dist/accounts/school-ownership.controller.js');
const { SchoolAccountHumanGuard } = require('../dist/accounts/school-owner-invitation.controller.js');
const c = require('@hon/contracts');

// B-ID-4 school ownership handoff (0223 proposed): closed inputs, closed responses whose derived fields agree with the
// facts, and a service that forwards only the verified subject and validated input.
const U = () => randomUUID(), T = '2026-11-08T21:00:00.000Z', T2 = '2026-11-08T22:00:00.000Z';
const sorted = (...a) => a.sort();
const owner = (patch = {}) => ({ ownerGrantId: U(), displayName: 'School owner', email: 'owner@example.invalid', since: T, primary: false, viaInvitation: true, ...patch });
const hqView = (patch = {}) => ({ schoolId: U(), organizationId: U(), owners: [], primaryOwnerGrantId: null, primaryNeeded: false, hqOwnerGrantIds: [],
  hqOwnerCleanup: { eligible: false, blocker: 'NONE_TO_END', expectedGrantIds: [] }, notices: [], asOf: T2, ...patch });
const notice = (patch = {}) => ({ noticeId: U(), kind: 'OWNER_INVITED', occurredAt: T, invitedEmail: 'new@example.invalid', endedGrantCount: null, ...patch });

test('contracts: HQ school ownership derives primary, primaryNeeded and the cleanup plan from the facts', () => {
  assert.equal(c.validateHqSchoolOwnership(hqView()).hqOwnerCleanup.blocker, 'NONE_TO_END');
  const a = owner({ primary: true }), b = owner();
  const ok = hqView({ owners: [a, b], primaryOwnerGrantId: a.ownerGrantId });
  assert.equal(c.validateHqSchoolOwnership(ok).owners.length, 2);
  const [g1, g2] = sorted(U(), U());
  const plan = hqView({ owners: [a], primaryOwnerGrantId: a.ownerGrantId, hqOwnerGrantIds: [g1, g2], hqOwnerCleanup: { eligible: true, blocker: null, expectedGrantIds: [g1, g2] } });
  assert.equal(c.validateHqSchoolOwnership(plan).hqOwnerCleanup.eligible, true);
  const noOwner = hqView({ hqOwnerGrantIds: [g1], hqOwnerCleanup: { eligible: false, blocker: 'SCHOOL_OWNER_REQUIRED', expectedGrantIds: [g1] } });
  assert.equal(c.validateHqSchoolOwnership(noOwner).hqOwnerCleanup.blocker, 'SCHOOL_OWNER_REQUIRED');
  for (const badView of [
    { ...ok, primaryOwnerGrantId: b.ownerGrantId },                                   // primary flag disagrees
    { ...ok, primaryOwnerGrantId: U() },                                              // primary not an owner
    { ...ok, owners: [owner(), owner()], primaryOwnerGrantId: null, primaryNeeded: false }, // owners but no primary => needed
    { ...plan, hqOwnerCleanup: { ...plan.hqOwnerCleanup, expectedGrantIds: [g1] } }, // plan differs from the facts
    { ...plan, hqOwnerGrantIds: [g2, g1], hqOwnerCleanup: { ...plan.hqOwnerCleanup, expectedGrantIds: [g2, g1] } }, // unsorted
    { ...noOwner, hqOwnerCleanup: { ...noOwner.hqOwnerCleanup, eligible: true, blocker: null } },
    { ...ok, extra: 1 }, { ...ok, owners: [{ ...a, token: 'x' }] }, { ...ok, asOf: '2026-11-08' },
    { ...ok, notices: [notice({ kind: 'OWNER_ADDED', invitedEmail: null })] },
    { ...ok, notices: [notice({ kind: 'HQ_OWNER_ACCESS_ENDED', invitedEmail: null, endedGrantCount: 0 })] },
    { ...ok, notices: [notice({ occurredAt: T }), notice({ occurredAt: T2 })] },    // not newest first
  ]) assert.throws(() => c.validateHqSchoolOwnership(badView), JSON.stringify(badView).slice(0, 120));
});

test('contracts: cleanup list, command inputs, receipts and the school owner view are closed', () => {
  const [g] = [U()];
  const s = { schoolId: U(), organizationId: U(), schoolDisplayName: 'Dojo', organizationDisplayName: 'Dojo Org', schoolOwnerCount: 1, hqOwnerGrantIds: [g], eligible: true, blocker: null };
  const list = { schools: [s, { ...s, schoolId: U(), schoolOwnerCount: 0, eligible: false, blocker: 'SCHOOL_OWNER_REQUIRED' }], total: 2, truncated: false, summary: { eligible: 1, needsOwner: 1 }, asOf: T };
  assert.equal(c.validateHqOwnerGrantCleanup(list).schools.length, 2);
  for (const bad of [{ ...list, summary: { eligible: 2, needsOwner: 0 } }, { ...list, total: 3 }, { ...list, schools: [{ ...s, eligible: false }], total: 1, summary: { eligible: 0, needsOwner: 1 } },
    { ...list, schools: [{ ...s, hqOwnerGrantIds: [] }], total: 1, summary: { eligible: 1, needsOwner: 0 } }])
    assert.throws(() => c.validateHqOwnerGrantCleanup(bad));
  const school = U();
  assert.deepEqual(c.validateSetPrimaryOwnerInput({ schoolId: school, ownerGrantId: g }), { schoolId: school, ownerGrantId: g });
  for (const bad of [{ schoolId: school }, { schoolId: school, ownerGrantId: g, organizationId: U() }, { schoolId: 'x', ownerGrantId: g }])
    assert.throws(() => c.validateSetPrimaryOwnerInput(bad));
  for (const bad of [{ schoolId: school, expectedGrantIds: [] }, { schoolId: school, expectedGrantIds: [g, g] }, { schoolId: school, expectedGrantIds: 'all' },
    { schoolId: school, expectedGrantIds: Array.from({ length: 51 }, U) }, { schoolId: school, expectedGrantIds: [g], force: true }])
    assert.throws(() => c.validateEndHqOwnerGrantsInput(bad));
  const r = { operation: 'END_HQ_OWNER_GRANTS', schoolId: school, organizationId: U(), primaryOwnerGrantId: null, changed: true, endedGrantIds: [g] };
  assert.deepEqual(c.validateSchoolOwnershipReceipt(r, 'END_HQ_OWNER_GRANTS'), r);
  assert.throws(() => c.validateSchoolOwnershipReceipt(r, 'SET_PRIMARY'));
  assert.throws(() => c.validateSchoolOwnershipReceipt({ ...r, endedGrantIds: [] }, 'END_HQ_OWNER_GRANTS'));
  assert.throws(() => c.validateSchoolOwnershipReceipt({ ...r, operation: 'SET_PRIMARY', primaryOwnerGrantId: null, endedGrantIds: [] }, 'SET_PRIMARY'));
  const me = owner({ primary: true });
  const v = { schoolId: school, owners: [me], yourOwnerGrantId: me.ownerGrantId, primaryOwnerGrantId: me.ownerGrantId, notices: [notice()], asOf: T2 };
  assert.equal(c.validateSchoolOwnerOwnershipView(v).yourOwnerGrantId, me.ownerGrantId);
  assert.throws(() => c.validateSchoolOwnerOwnershipView({ ...v, yourOwnerGrantId: U() }));
  assert.throws(() => c.validateSchoolOwnerOwnershipView({ ...v, organizationId: U() }));
});

test('service: forwards only the verified subject and validated input; maps database refusals; drift is 503', async () => {
  const calls = [], schoolId = U(), g = U();
  let reply = hqView({ schoolId });
  const service = new SchoolOwnershipService({ callSchoolOwnership: async (op, args) => { calls.push([op, args]); if (reply instanceof Error) throw reply; return reply; } });
  const req = { honIdentity: { externalSubject: 'verified-hq' }, res: { setHeader() {} } };
  assert.equal((await service.hqSchool(req, schoolId)).schoolId, schoolId);
  assert.deepEqual(calls.at(-1), ['hqRead', ['verified-hq', schoolId]]);
  await assert.rejects(() => service.hqSchool(req, 'not-a-uuid'), e => e.status === 400);
  const key = U();
  reply = { operation: 'SET_PRIMARY', schoolId, organizationId: U(), primaryOwnerGrantId: g, changed: true, endedGrantIds: [] };
  await service.command(req, 'SET_PRIMARY', { schoolId, ownerGrantId: g }, key);
  assert.deepEqual(calls.at(-1), ['setPrimary', ['verified-hq', JSON.stringify({ schoolId, ownerGrantId: g }), key]]);
  const before = calls.length;
  for (const [body, k] of [[{ schoolId, ownerGrantId: g, role: 'OWNER' }, key], [{ schoolId, ownerGrantId: g }, 'nope']])
    await assert.rejects(() => service.command(req, 'SET_PRIMARY', body, k), e => e.status === 400);
  assert.equal(calls.length, before, 'invalid input reaches no SQL');
  for (const [code, message, status, out] of [['42501', 'X', 403, 'ACCOUNT_FORBIDDEN'], ['P0002', 'OWNERSHIP_OWNER_NOT_LIVE', 404, 'OWNERSHIP_OWNER_NOT_LIVE'],
    ['P0002', 'ACCOUNT_UNAVAILABLE', 404, 'ACCOUNT_UNAVAILABLE'], ['23514', 'X', 409, 'OWNERSHIP_SCHOOL_OWNER_REQUIRED'], ['40001', 'X', 409, 'OWNERSHIP_PLAN_CHANGED'],
    ['23505', 'X', 409, 'ACCOUNT_CONFLICT'], ['22023', 'X', 400, 'ACCOUNT_INPUT_INVALID'], ['XX000', 'X', 503, 'ACCOUNT_UNAVAILABLE']]) {
    reply = Object.assign(new Error(message), { code });
    await assert.rejects(() => service.command(req, 'END_HQ_OWNER_GRANTS', { schoolId, expectedGrantIds: [g] }, U()), e => e.status === status && e.getResponse().code === out);
  }
  reply = { ...hqView({ schoolId }), extra: true };
  await assert.rejects(() => service.hqSchool(req, schoolId), e => e.status === 503);
  reply = { schools: [], total: 0, truncated: false, summary: { eligible: 0, needsOwner: 0 }, asOf: T };
  assert.equal((await service.cleanup(req)).total, 0);
  assert.deepEqual(calls.at(-1), ['cleanupRead', ['verified-hq']]);
});

test('controller: routes sit behind the human-only account guard (no-store, same-origin, no query)', () => {
  const guards = Reflect.getMetadata('__guards__', SchoolOwnershipController);
  assert(guards.includes(SchoolAccountHumanGuard));
  const paths = Object.getOwnPropertyNames(SchoolOwnershipController.prototype).filter(n => n !== 'constructor')
    .map(n => [Reflect.getMetadata('method', SchoolOwnershipController.prototype[n]), Reflect.getMetadata('path', SchoolOwnershipController.prototype[n])]);
  assert.deepEqual(paths, [[0, 'hq/schools/:schoolId/ownership'], [0, 'hq/school-ownership/hq-owner-grants'], [1, 'hq/school-ownership/primary-owner'],
    [1, 'hq/school-ownership/end-hq-owner-grants'], [0, 'account/schools/:schoolId/ownership']]);
  const guard = new SchoolAccountHumanGuard(), set = {};
  const r = { method: 'GET', headers: { 'sec-fetch-site': 'same-origin' }, query: { schoolId: U() }, originalUrl: '/v1/hq/school-ownership/hq-owner-grants?schoolId=x' };
  assert.throws(() => guard.canActivate({ switchToHttp: () => ({ getRequest: () => r, getResponse: () => ({ setHeader: (k, v) => set[k] = v }) }) }));
  assert.equal(set['Cache-Control'], 'private, no-store');
});
