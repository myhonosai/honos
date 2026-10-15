const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { TestingRegistrationService } = require('../dist/testing/testing-registration.service.js');
const { ParentTestingRegistrationController, StaffTestingRegistrationController } = require('../dist/testing/testing-registration.controller.js');
const { TestingRegistrationHumanUiGuard } = require('../dist/testing/testing-registration-human-ui.guard.js');
const ids = Array.from({ length: 8 }, (_, i) => `${String(i + 1).padStart(8, '0')}-1111-4111-8111-111111111111`);
const parentScope = { principalId: ids[0], organizationId: ids[1], schoolId: ids[2], familyId: ids[3], accessLevel: 'PRIMARY_GUARDIAN' };
const staffScope = { principalId: ids[4], organizationId: ids[1], schoolId: ids[2] };
const iso = '2026-11-01T10:00:00.000Z';
function db(overrides = {}) {
  const calls = [];
  return { calls,
    resolveParentJourneyScopes: async () => overrides.parentScopes ?? [parentScope],
    resolveParentFamilyScopes: async () => overrides.parentExact ?? [parentScope],
    resolveTestingRegistrationReviewScopes: async () => overrides.staffScopes ?? [staffScope],
    withTenantTransaction: async (context, work) => work({ query: async (sql, params) => {
      calls.push([sql, params]);
      if (sql.startsWith('SELECT set_config') || sql.startsWith('SET LOCAL')) return { rows: [] };
      if (sql.includes('read_parent_testing_registration_view')) return { rows: [{ data: { children: [{ studentProfileId: ids[5], displayName: 'Allowed Child' }], events: [{ testingEventId: ids[6], name: 'Existing event', startsAt: iso, endsAt: null }], registrations: [] } }] };
      if (sql.includes('mutate_parent_testing_registration_interest')) return { rows: [{ data: { record: { status: 'SUBMITTED', submittedAt: iso, version: 1 }, replayed: false } }] };
      if (sql.includes('read_staff_testing_registrations')) return { rows: [{ data: { registrations: [{ id: ids[7], childName: 'Allowed Child', eventName: 'Existing event', startsAt: iso, status: 'SUBMITTED', parentNote: null, submittedAt: iso, reviewedAt: null, version: 1 }], limited: false } }] };
      if (sql.includes('mutate_staff_testing_registration_decision')) return { rows: [{ data: { record: { id: ids[7], status: 'WAITLISTED', reviewedAt: iso, version: 2 }, replayed: false } }] };
      throw new Error(`unexpected SQL: ${sql}`);
    }}),
  };
}
test('parent and staff registrations use fixed procedures with only derived direct-human scope', async () => {
  const fake = db(), service = new TestingRegistrationService(fake);
  const parent = await service.parentView('verified-parent');
  assert.equal(parent.view.children[0].displayName, 'Allowed Child');
  const submitted = await service.submitInterest('verified-parent', 'parent-key', { studentProfileId: ids[5], testingEventId: ids[6], note: 'Please review.' });
  assert.equal(submitted.receipt.status, 'SUBMITTED');
  const staff = await service.staffView('verified-staff'); assert.equal(staff.view.registrations[0].status, 'SUBMITTED');
  const review = await service.review('verified-staff', ids[7], 'staff-key', { decision: 'WAITLIST', expectedVersion: 1 });
  assert.equal(review.receipt.status, 'WAITLISTED');
  const sql = fake.calls.map(c => c[0]).join('\n');
  for (const procedure of ['read_parent_testing_registration_view', 'mutate_parent_testing_registration_interest', 'read_staff_testing_registrations', 'mutate_staff_testing_registration_decision']) assert.match(sql, new RegExp(procedure));
  assert.doesNotMatch(sql, /testing_candidates\s+(?:INSERT|UPDATE)|promotion_decisions|payment|communication|action_requests/i);
});
test('closed inputs and ambiguous/current scope failures stop before a mutation procedure', async () => {
  const fake = db({ parentScopes: [parentScope, { ...parentScope, familyId: ids[5] }] }), service = new TestingRegistrationService(fake);
  await assert.rejects(service.parentView('verified-parent'), e => e.getStatus() === 409);
  await assert.rejects(new TestingRegistrationService(db()).submitInterest('verified-parent', 'key', { studentProfileId: ids[5], testingEventId: ids[6], note: 'x', familyId: ids[3] }), /Testing registration data/);
  await assert.rejects(new TestingRegistrationService(db({ staffScopes: [staffScope, { ...staffScope, schoolId: ids[6] }] })).staffView('verified-staff'), e => e.getStatus() === 403);
});
test('controllers accept no client authority and guards require same-origin JSON on mutations', async () => {
  const registrations = { parentView: async () => ({ view: {}, context: { requestId: ids[0], correlationId: ids[0] } }), submitInterest: async () => ({ receipt: {}, replayed: false, context: { requestId: ids[0], correlationId: ids[0] } }), staffView: async () => ({ view: {}, context: { requestId: ids[0], correlationId: ids[0] } }), review: async () => ({ receipt: {}, replayed: false, context: { requestId: ids[0], correlationId: ids[0] } }) };
  const parent = new ParentTestingRegistrationController(registrations), staff = new StaffTestingRegistrationController(registrations);
  await assert.rejects(parent.view({}), e => e.getStatus() === 403);
  await assert.rejects(staff.view({}), e => e.getStatus() === 403);
  const guard = new TestingRegistrationHumanUiGuard();
  const request = headers => ({ method: 'POST', headers });
  const prior = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
  try {
    assert.equal(guard.canActivate({ switchToHttp: () => ({ getRequest: () => request({ origin: 'https://hon.test', 'content-type': 'application/json', 'x-hon-human-command': 'testing-registration' }) }) }), true);
    assert.throws(() => guard.canActivate({ switchToHttp: () => ({ getRequest: () => request({ origin: 'https://evil.test', 'content-type': 'application/json', 'x-hon-human-command': 'testing-registration' }) }) }));
  } finally { if (prior === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = prior; }
});
