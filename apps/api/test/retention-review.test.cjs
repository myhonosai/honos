const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
require('reflect-metadata');
const { GUARDS_METADATA, PATH_METADATA } = require('@nestjs/common/constants');
const { RetentionReviewController } = require('../dist/retention-review/retention-review.controller.js');
const { RetentionReviewService } = require('../dist/retention-review/retention-review.service.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RetentionReviewHumanUiGuard } = require('../dist/retention-review/retention-review.dto.js');

const schoolId = '11111111-1111-4111-8111-111111111111';
const membershipId = '22222222-2222-4222-8222-222222222222';
const principalId = '33333333-3333-4333-8333-333333333333';
const organizationId = '44444444-4444-4444-8444-444444444444';
const observedAt = '2026-10-15T20:00:00.000Z';
const expectStatus = (expected, code) => error => { assert.equal(error.getStatus(), expected); if (code) assert.equal(error.getResponse().code, code); return true; };
function raw() {
  return {
    schemaVersion: 'RETENTION_REVIEW_SIGNALS_V1', membershipId, observedAt,
    humanOnly: true, readOnly: true, evidenceOnly: true, predictionOrAutomaticAction: false,
    membershipTerm: { status: 'AVAILABLE', membershipState: 'ACTIVE', termStartedAt: '2026-01-01T00:00:00.000Z', termEndsAt: '2026-11-01T00:00:00.000Z', endingObservation: 'ENDING_WITHIN_30_DAYS', reason: null },
    renewalReview: { status: 'UNAVAILABLE', latestReviewState: null, recordedAt: null, reason: 'NO_EXPLICIT_RENEWAL_REVIEW_RECORDED' },
    followUp: { status: 'UNAVAILABLE', reason: 'NO_UNAMBIGUOUS_MEMBERSHIP_TO_FOLLOW_UP_RELATION' },
    attendance: { status: 'AVAILABLE', windowFrom: '2026-09-17T20:00:00.000Z', windowTo: observedAt, recordedAttendanceCount: 3, presentCount: 2, lateCount: 1, makeupCount: 0, excusedAbsenceCount: 0, unexcusedAbsenceCount: 0, reason: null },
    progression: { status: 'AVAILABLE', curriculumEnrollmentCount: 1, progressObservationCount: 0, testingRecordCount: 0, progressObservationAvailability: 'UNAVAILABLE', testingObservationAvailability: 'UNAVAILABLE', reason: null },
  };
}

test('Retention Review route is direct-human guarded, selector-only, and never accepts client authority', async () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, RetentionReviewController), 'staff/retention/review');
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, RetentionReviewController), [HonIdentityGuard, RetentionReviewHumanUiGuard]);
  const calls = []; const database = { resolveRetentionReviewScope: async (...args) => { calls.push(args); return { organizationId, schoolId, principalId }; } };
  const retention = { read: async context => { calls.push(['read', context]); return raw(); } };
  const controller = new RetentionReviewController(database, retention);
  const response = await controller.read({ schoolId, membershipId }, { honIdentity: { externalSubject: 'verified-subject' }, tier: 'COMPLETE', actionAuthority: 'AUTO' });
  assert.deepEqual(calls[0], ['verified-subject', schoolId]);
  assert.equal(calls[1][1].organizationId, organizationId); assert.equal(calls[1][1].schoolId, schoolId); assert.equal(calls[1][1].principalId, principalId);
  assert.equal(calls[1][1].source, 'HUMAN_UI'); assert.equal(calls[1][1].principalType, 'HUMAN_USER');
  assert.deepEqual(Object.keys(response.data), ['retentionReviewSignals']);
  await assert.rejects(() => controller.read({ schoolId, membershipId, tier: 'COMPLETE' }, { honIdentity: { externalSubject: 'verified-subject' } }), expectStatus(400, 'VALIDATION_FAILED'));
  const deniedController = new RetentionReviewController({ resolveRetentionReviewScope: async () => undefined }, retention);
  await assert.rejects(() => deniedController.read({ schoolId, membershipId }, { honIdentity: { externalSubject: 'verified-subject' } }), expectStatus(403, 'RETENTION_REVIEW_SCOPE_DENIED'));
});

test('Retention Review service calls exactly one fixed database read and rejects private/predictive-shaped output', async () => {
  const calls = []; const service = new RetentionReviewService({ readRetentionReviewSignals: async (...args) => { calls.push(args); return raw(); } });
  const context = { organizationId, schoolId, principalId, externalSubject: 'verified-subject', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: '55555555-5555-4555-8555-555555555555', correlationId: '55555555-5555-4555-8555-555555555555' };
  const result = await service.read(context, membershipId.toUpperCase());
  assert.deepEqual(calls, [[context, membershipId]]); assert.equal(result.predictionOrAutomaticAction, false);
  for (const mutate of [value => { value.personName = 'Private'; }, value => { value.attendance.score = 88; }, value => { value.membershipTerm.endingObservation = 'CHURN_RISK'; }, value => { value.followUp.status = 'AVAILABLE'; }]) {
    await assert.rejects(
      () => new RetentionReviewService({ readRetentionReviewSignals: async () => { const value = raw(); mutate(value); return value; } }).read(context, membershipId),
      expectStatus(503, 'RETENTION_REVIEW_UNAVAILABLE'),
    );
  }
  await assert.rejects(() => service.read({ ...context, source: 'AI_AGENT' }, membershipId), expectStatus(403, 'HUMAN_UI_REQUIRED'));
});

test('Retention Review source is read-only and contains no action, provider, payment, messaging, mutation, or prediction integration', () => {
  const source = [
    readFileSync('src/retention-review/retention-review.controller.ts', 'utf8'),
    readFileSync('src/retention-review/retention-review.service.ts', 'utf8'),
    readFileSync('src/retention-review/retention-review.dto.ts', 'utf8'),
  ].join('\n');
  assert.doesNotMatch(source, /@Post\(|@Patch\(|@Delete\(|executeAction|invokeLLM|sendMessage|provider|payment|refund|cancelMembership|forecast|predict/i);
  assert.match(source, /readRetentionReviewSignals/);
});
