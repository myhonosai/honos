const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { GUARDS_METADATA, PATH_METADATA } = require('@nestjs/common/constants');
const { verifyMayaAtRiskStudents, validateMayaAtRiskQuery } = require('@hon/contracts');
const { MayaAtRiskController, MayaAtRiskReadHumanUiGuard } = require('../dist/maya/maya-at-risk.controller.js');
const { MayaAtRiskService } = require('../dist/maya/maya-at-risk.service.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');

const organizationId = '44444444-4444-4444-8444-444444444444';
const schoolId = '11111111-1111-4111-8111-111111111111';
const principalId = '33333333-3333-4333-8333-333333333333';
const m1 = '22222222-2222-4222-8222-222222222222';
const m2 = '55555555-5555-4555-8555-555555555555';
const expectStatus = (expected, code) => error => { assert.equal(error.getStatus(), expected); if (code) assert.equal(error.getResponse().code, code); return true; };

function raw() {
  return {
    schemaVersion: 'MAYA_AT_RISK_V1', asOf: '2026-11-11T18:00:00.000Z', localToday: '2026-11-11', tuitionChecked: true,
    counts: { HIGH: 1, MEDIUM: 0, WATCH: 1 }, nextAfter: null,
    items: [
      { membershipId: m1, givenName: 'Avery', familyName: 'Synthetic', membershipState: 'ACTIVE', score: 70, level: 'HIGH', suggestedNextStep: 'CALL_TO_CHECK_IN',
        factors: [{ code: 'LONG_ABSENCE', points: 45, daysSinceLastAttendance: 35, neverAttended: false }, { code: 'ATTENDANCE_DROP', points: 25, last28Days: 0, previous28Days: 5 }] },
      { membershipId: m2, givenName: 'Blake', familyName: 'Synthetic', membershipState: 'ACTIVE', score: 20, level: 'WATCH', suggestedNextStep: 'REVIEW_TUITION_BALANCE',
        factors: [{ code: 'TUITION_OVERDUE', points: 20, overdueInvoiceCount: 1 }] },
    ],
  };
}

test('the at-risk list contract accepts only self-consistent, record-derived rows', () => {
  assert.equal(verifyMayaAtRiskStudents(raw()).items.length, 2);
  const broken = [
    x => { x.items[0].score = 60; },                                   // score is the sum of points
    x => { x.items[0].level = 'MEDIUM'; },                             // level follows the score
    x => { x.items[0].suggestedNextStep = 'PLAN_PROGRESS_TALK'; },     // step follows the first factor
    x => { x.items[0].factors.reverse(); },                            // most points first
    x => { x.items[0].factors[0].points = 30; },                       // 35 days absent is 45 points
    x => { x.items[0].factors[1].last28Days = 3; },                    // 3 of 5 is not a drop
    x => { x.tuitionChecked = false; },                                // tuition shown only when checked
    x => { x.items[1].factors[0].phone = '+15550000000'; },            // no extra data
    x => { x.items[0].membershipState = 'FROZEN'; },                   // frozen students have no attendance factors
    x => { x.items.reverse(); },                                       // highest score first
    x => { x.nextAfter = `20:${m2}`; },                                // a cursor only on a full page
    x => { x.items[0].email = 'x@example.test'; },
    x => { x.schemaVersion = 'V2'; },
  ];
  for (const change of broken) { const value = raw(); change(value); assert.throws(() => verifyMayaAtRiskStudents(value)); }
  const capped = raw(); capped.items[0].factors.push({ code: 'NO_RANK_PROGRESS', points: 15, daysSinceProgress: 200 }, { code: 'TERM_ENDING', points: 20, cancellationPending: true, termEndsOn: null });
  capped.items[0].factors = [capped.items[0].factors[0], capped.items[0].factors[1], capped.items[0].factors[3], capped.items[0].factors[2]];
  capped.items[0].score = 100; capped.items[0].membershipState = 'CANCELLATION_PENDING';
  assert.equal(verifyMayaAtRiskStudents(capped).items[0].score, 100);
});

test('the query accepts only an optional score:membership cursor', () => {
  assert.deepEqual(validateMayaAtRiskQuery({}), {});
  assert.deepEqual(validateMayaAtRiskQuery({ after: `45:${m1}` }), { after: `45:${m1}` });
  for (const bad of [{ after: 'x' }, { after: `101:${m1}` }, { other: '1' }, { after: 3 }, null]) assert.throws(() => validateMayaAtRiskQuery(bad));
});

test('the route is direct-human guarded and resolves scope from the session, not the URL', async () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, MayaAtRiskController), 'organizations/:organizationId/schools/:schoolId/retention');
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, MayaAtRiskController), [HonIdentityGuard]);
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, MayaAtRiskController.prototype.list), [MayaAtRiskReadHumanUiGuard]);
  const calls = [];
  const database = { resolveAuthorizedScope: async (...args) => { calls.push(args); return { organizationId, schoolId, principalId }; } };
  const maya = { list: async (context, query) => { calls.push(['list', context, query]); return raw(); } };
  const controller = new MayaAtRiskController(database, maya);
  const request = { honIdentity: { externalSubject: 'verified-subject' } };
  await controller.list(organizationId, schoolId, undefined, {}, request);
  assert.deepEqual(calls[0], ['verified-subject', schoolId, 'retention.review.read']);
  assert.equal(calls[1][1].source, 'HUMAN_UI'); assert.equal(calls[1][1].principalId, principalId); assert.equal(calls[1][1].idempotencyKey, '');
  await assert.rejects(controller.list(organizationId, schoolId, 'key', {}, request), expectStatus(409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED'));
  await assert.rejects(controller.list(organizationId, schoolId, undefined, { x: '1' }, request), expectStatus(400, 'VALIDATION_FAILED'));
  await assert.rejects(controller.list(organizationId, schoolId, undefined, { after: ['a', 'b'] }, request), expectStatus(400, 'VALIDATION_FAILED'));
  // Scope for another organization than the route names is refused.
  const other = new MayaAtRiskController({ resolveAuthorizedScope: async () => ({ organizationId: m1, schoolId, principalId }) }, maya);
  await assert.rejects(other.list(organizationId, schoolId, undefined, {}, request), expectStatus(403, 'MAYA_AT_RISK_FORBIDDEN'));
  const none = new MayaAtRiskController({ resolveAuthorizedScope: async () => undefined }, maya);
  await assert.rejects(none.list(organizationId, schoolId, undefined, {}, request), expectStatus(403, 'MAYA_AT_RISK_FORBIDDEN'));
});

test('the service refuses non-human contexts and never turns a database failure into an empty list', async () => {
  const context = { organizationId, schoolId, principalId, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'subject', requestId: m1, correlationId: m1, idempotencyKey: '' };
  const failing = code => new MayaAtRiskService({ withTenantReadOnlyTransaction: async () => { throw Object.assign(new Error('x'), { code }); } });
  await assert.rejects(failing('42501').list(context, {}), expectStatus(403, 'MAYA_AT_RISK_FORBIDDEN'));
  await assert.rejects(failing('XX000').list(context, {}), expectStatus(503, 'MAYA_AT_RISK_UNAVAILABLE'));
  const timezone = new MayaAtRiskService({ withTenantReadOnlyTransaction: async () => { throw Object.assign(new Error('SCHOOL_TIMEZONE_INVALID'), { code: '22023' }); } });
  await assert.rejects(timezone.list(context, {}), expectStatus(409, 'SCHOOL_TIMEZONE_INVALID'));
  await assert.rejects(failing('42501').list({ ...context, source: 'AI_AGENT' }, {}), expectStatus(403, 'HUMAN_UI_REQUIRED'));
  await assert.rejects(failing('42501').list({ ...context, actionRequestId: m2 }, {}), expectStatus(403, 'HUMAN_UI_REQUIRED'));
  await assert.rejects(failing('42501').list(context, { after: 'bad' }), expectStatus(400, 'VALIDATION_FAILED'));
  const bad = new MayaAtRiskService({ withTenantReadOnlyTransaction: async (_context, run) => run({ query: async text => (text.includes('read_maya') ? { rows: [{ data: { ...raw(), extra: 1 } }] } : { rows: [] }) }) });
  await assert.rejects(bad.list(context, {}), expectStatus(503, 'MAYA_AT_RISK_UNAVAILABLE'));
  const good = new MayaAtRiskService({ withTenantReadOnlyTransaction: async (_context, run) => run({ query: async text => (text.includes('read_maya') ? { rows: [{ data: raw() }] } : { rows: [] }) }) });
  assert.equal((await good.list(context, {})).items[0].givenName, 'Avery');
});
