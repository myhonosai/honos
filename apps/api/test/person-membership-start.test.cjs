const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PersonMembershipStartController } = require('../dist/billing/person-membership-start.controller.js');
const { PersonMembershipStartService } = require('../dist/billing/person-membership-start.service.js');

// M-B (0398): the card membership start controller's closed requests and permission, and the service's input checks,
// verified receipts and error mapping (blockers are passed through as known codes only), without a database.
const ORG = '11111111-1111-4111-8111-111111111111';
const SCHOOL = '22222222-2222-4222-8222-222222222222';
const PERSON = '55555555-5555-4555-8555-555555555555';
const PLAN = '66666666-6666-4666-8666-666666666666';
const MEMBERSHIP = '88888888-8888-4888-8888-888888888888';
const ACCOUNT = '99999999-9999-4999-8999-999999999999';
const request = { honIdentity: { externalSubject: 'staff-subject' } };
const response = () => ({ statusCode: 0, status(code) { this.statusCode = code; return this; } });
const code = async (promise) => { try { await promise; return null; } catch (error) { return error.getResponse().code; } };
const body = async (promise) => { try { await promise; return null; } catch (error) { return error.getResponse(); } };
const context = { organizationId: ORG, schoolId: SCHOOL, principalId: 'p', principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'staff-subject',
  requestId: '77777777-7777-4777-8777-777777777777', correlationId: '77777777-7777-4777-8777-777777777777', idempotencyKey: 'key-1' };
const input = (patch = {}) => ({ membershipPlanId: PLAN, membershipPlanVersion: 2, kind: 'NEW', renewsMembershipId: null, startDate: '2026-12-01', payerPersonId: null,
  confirmation: 'I_CONFIRM_DIRECT_HUMAN_MEMBERSHIP_FROM_PLAN', ...patch });
const receipt = (patch = {}) => ({ membershipId: MEMBERSHIP, state: 'DRAFT', personId: PERSON, kind: 'NEW', renewsMembershipId: null, membershipPlanId: PLAN, membershipPlanVersion: 2,
  planCode: 'TKD-12', programId: null, payerPersonId: PERSON, billingAccountId: ACCOUNT, startDate: '2026-12-01', endDate: '2027-11-30',
  termStartedAt: '2026-12-01T08:00:00.000Z', termEndsAt: '2027-12-01T08:00:00.000Z', recordedAt: '2026-11-16T08:00:00.000Z', ...patch });
const options = (patch = {}) => ({ personId: PERSON, schoolToday: '2026-11-16', schoolTimezone: 'America/Los_Angeles', minor: false, blockers: [],
  payers: [{ personId: PERSON, givenName: 'Ada', familyName: 'Card', relation: 'SELF', billingContact: false }], defaultPayerPersonId: PERSON, payerProblem: null,
  memberships: [{ membershipId: MEMBERSHIP, state: 'ACTIVE', planCode: 'TKD-12', programId: null, startDate: '2025-12-01', endDate: '2026-11-30', renewable: true, renewStartDate: '2026-12-01' }], ...patch });
const db = (data) => {
  const calls = [];
  const client = { async query(text, values) { if (/hon\.(read_person_membership_start|start_person_membership)/.test(text)) { calls.push([text, values]); return { rows: [{ data }] }; } return { rows: [] }; } };
  return { calls, async withTenantReadOnlyTransaction(_c, work) { return work(client); }, async withTenantTransaction(_c, work) { return work(client); } };
};
const failing = (error) => ({ async withTenantReadOnlyTransaction() { throw error; }, async withTenantTransaction() { throw error; } });
const pgError = (sqlState, message, hint) => Object.assign(new Error(message), { code: sqlState, hint });

test('card membership start controller: billing.membership.create for both calls; keys and queries are closed', async () => {
  const scope = { calls: [], async resolveAuthorizedScope(_s, _school, permission) { this.calls.push(permission); return { organizationId: ORG, schoolId: SCHOOL, principalId: 'p' }; } };
  const starts = { calls: [], async options(...a) { this.calls.push(['options', ...a]); return {}; }, async start(...a) { this.calls.push(['start', ...a]); return { receipt: {}, replayed: false }; } };
  const controller = new PersonMembershipStartController(scope, starts);
  await controller.options(ORG, SCHOOL, PERSON.toUpperCase(), undefined, {}, request);
  const r = response();
  await controller.start(ORG, SCHOOL, PERSON, 'key-1', {}, input(), request, r);
  assert.equal(r.statusCode, 201);
  assert.deepEqual(scope.calls, ['billing.membership.create', 'billing.membership.create']);
  assert.equal(starts.calls[0][2], PERSON, 'the route person id is lower-cased');
  assert.equal(await code(controller.start(ORG, SCHOOL, PERSON, undefined, {}, input(), request, response())), 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal(await code(controller.options(ORG, SCHOOL, PERSON, 'key', {}, request)), 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
  assert.equal(await code(controller.options(ORG, SCHOOL, PERSON, undefined, { x: '1' }, request)), 'VALIDATION_FAILED');
  assert.equal(await code(controller.start(ORG, SCHOOL, PERSON, 'key-2', { a: '1' }, input(), request, response())), 'VALIDATION_FAILED');
  const other = new PersonMembershipStartController({ async resolveAuthorizedScope() { return { organizationId: ORG, schoolId: '33333333-3333-4333-8333-333333333333' }; } }, starts);
  assert.equal(await code(other.options(ORG, SCHOOL, PERSON, undefined, {}, request)), 'PERSON_MEMBERSHIP_FORBIDDEN', 'a scope for another school is refused');
});

test('card membership start service: closed bodies before the database; the route person; verified results; fixed error codes', async () => {
  const touched = db(null);
  const service = new PersonMembershipStartService(touched);
  for (const value of [{}, input({ personId: PERSON }), input({ extra: 1 }), input({ kind: 'RENEW' }), input({ renewsMembershipId: MEMBERSHIP }), input({ startDate: '2026-02-30' }),
    input({ membershipPlanVersion: '2' }), input({ confirmation: 'yes' }), [], null]) {
    assert.equal(await code(service.start(context, PERSON, value)), 'VALIDATION_FAILED', JSON.stringify(value));
  }
  assert.equal(await code(service.options(context, 'not-a-uuid')), 'VALIDATION_FAILED');
  assert.equal(await code(service.start({ ...context, source: 'AI_AGENT' }, PERSON, input())), 'HUMAN_COMMAND_REQUIRED');
  assert.equal(await code(service.options({ ...context, delegatedByPrincipalId: 'x' }, PERSON)), 'HUMAN_COMMAND_REQUIRED');
  assert.equal(touched.calls.length, 0);

  const ok = db({ receipt: receipt(), replayed: false });
  assert.deepEqual(await new PersonMembershipStartService(ok).start(context, PERSON, input()), { receipt: receipt(), replayed: false });
  assert.deepEqual(JSON.parse(ok.calls[0][1][1]), { personId: PERSON, ...input() });
  assert.equal(ok.calls[0][1][2], 'key-1');
  for (const bad of [receipt({ personId: MEMBERSHIP }), receipt({ state: 'ACTIVE' }), receipt({ startDate: '2026-12-02' }), receipt({ membershipPlanVersion: 3 }),
    receipt({ endDate: '2026-11-01' }), receipt({ termEndsAt: null }), { ...receipt(), extra: 1 }]) {
    assert.equal(await code(new PersonMembershipStartService(db({ receipt: bad, replayed: false })).start(context, PERSON, input())), 'PERSON_MEMBERSHIP_UNAVAILABLE', JSON.stringify(bad));
  }
  assert.equal(await code(new PersonMembershipStartService(db({ receipt: receipt(), replayed: false })).start(context, PERSON, input({ payerPersonId: ACCOUNT }))), 'PERSON_MEMBERSHIP_UNAVAILABLE',
    'a receipt for another payer than the chosen one is refused');
  assert.equal(await code(new PersonMembershipStartService(db({ receipt: receipt() })).start(context, PERSON, input())), 'PERSON_MEMBERSHIP_UNAVAILABLE', 'missing replayed flag');

  assert.equal((await new PersonMembershipStartService(db(options())).options(context, PERSON)).memberships[0].renewStartDate, '2026-12-01');
  for (const bad of [options({ personId: MEMBERSHIP }), options({ blockers: ['NOT_A_CODE'] }), options({ defaultPayerPersonId: ACCOUNT }),
    options({ payerProblem: 'NO_GUARDIAN' }), options({ payers: [{ personId: ACCOUNT, givenName: 'X', familyName: 'Y', relation: 'SELF', billingContact: false }], defaultPayerPersonId: null }),
    options({ memberships: [{ ...options().memberships[0], renewable: true, endDate: null, renewStartDate: null }] })]) {
    assert.equal(await code(new PersonMembershipStartService(db(bad)).options(context, PERSON)), 'PERSON_MEMBERSHIP_UNAVAILABLE', JSON.stringify(bad).slice(0, 120));
  }

  assert.deepEqual(await body(new PersonMembershipStartService(failing(pgError('55000', 'PERSON_MEMBERSHIP_BLOCKED', '["DRAFT_IN_PROGRAM", "OVERLAPS_CURRENT_MEMBERSHIP"]'))).start(context, PERSON, input())),
    { code: 'PERSON_MEMBERSHIP_BLOCKED', blockers: ['DRAFT_IN_PROGRAM', 'OVERLAPS_CURRENT_MEMBERSHIP'] });
  assert.deepEqual((await body(new PersonMembershipStartService(failing(pgError('55000', 'PERSON_MEMBERSHIP_BLOCKED', '["<script>"]'))).start(context, PERSON, input()))).blockers, []);
  for (const [error, expected] of [[pgError('42501', 'PERSON_MEMBERSHIP_FORBIDDEN'), 'PERSON_MEMBERSHIP_FORBIDDEN'], [pgError('P0002', 'PERSON_MEMBERSHIP_NOT_FOUND'), 'PERSON_MEMBERSHIP_NOT_FOUND'],
    [pgError('40001', 'MEMBERSHIP_PLAN_VERSION_STALE'), 'MEMBERSHIP_PLAN_VERSION_STALE'], [pgError('23505', 'IDEMPOTENCY_KEY_REUSED'), 'IDEMPOTENCY_KEY_REUSED'],
    [pgError('40001', 'PERSON_MEMBERSHIP_CONFLICT'), 'PERSON_MEMBERSHIP_CONFLICT'], [pgError('23P01', 'MEMBERSHIP_PROGRAM_OVERLAP'), 'PERSON_MEMBERSHIP_CONFLICT'],
    [pgError('22023', 'VALIDATION_FAILED'), 'VALIDATION_FAILED'], [pgError('XX000', 'boom'), 'PERSON_MEMBERSHIP_UNAVAILABLE']]) {
    assert.equal(await code(new PersonMembershipStartService(failing(error)).start(context, PERSON, input())), expected, error.message);
  }
});
