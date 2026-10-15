const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
require('reflect-metadata');
const { GUARDS_METADATA, PATH_METADATA } = require('@nestjs/common/constants');
const { TestingScorecardController } = require('../dist/testing/testing-scorecard.controller.js');
const { TestingScorecardService } = require('../dist/testing/testing-scorecard.service.js');
const { TestingScorecardHumanUiGuard } = require('../dist/testing/testing-scorecard.dto.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');

const schoolId = '11111111-1111-4111-8111-111111111111';
const candidateId = '22222222-2222-4222-8222-222222222222';
const eventId = '33333333-3333-4333-8333-333333333333';
const scorecardId = '44444444-4444-4444-8444-444444444444';
const evaluationId = '55555555-5555-4555-8555-555555555555';
const organizationId = '66666666-6666-4666-8666-666666666666';
const principalId = '77777777-7777-4777-8777-777777777777';
const requestId = '88888888-8888-4888-8888-888888888888';
const evaluation = { id: evaluationId, criterionCode: 'TECHNIQUE.BALANCE', assessment: 'OBSERVED', recordedAt: '2026-10-15T20:00:00.000Z', version: 1, recordedByYou: true };
const rawView = { testingCandidateId: candidateId, testingEventId: eventId, candidateVersion: 2, testingEventVersion: 3, scorecardId: null, scorecardVersion: 0, evaluations: [], evaluationsLimited: false };
const rawReceipt = { scorecardId, scorecardVersion: 1, evaluation };
const context = { organizationId, schoolId, principalId, externalSubject: 'verified-human', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId, correlationId: requestId, idempotencyKey: 'scorecard-key' };
const expected = (status, code) => error => { assert.equal(error.getStatus(), status, error.stack); if (code) assert.equal(error.getResponse().code, code); return true; };

test('scorecard controller is identity and trusted-human guarded, derives scope, and accepts only closed known UUID selectors', async () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, TestingScorecardController), 'staff/testing/scorecards');
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, TestingScorecardController), [HonIdentityGuard, TestingScorecardHumanUiGuard]);
  const calls = [];
  const database = { resolveTestingScorecardScope: async (...args) => { calls.push(args); return { organizationId, schoolId, principalId }; } };
  const scorecards = { read: async value => { calls.push(['read', value]); return rawView; }, record: async value => { calls.push(['record', value]); return { ...rawReceipt, replayed: false }; } };
  const controller = new TestingScorecardController(database, scorecards);
  const request = { honIdentity: { externalSubject: 'verified-human' } };
  const read = await controller.read({ schoolId, testingCandidateId: candidateId, testingEventId: eventId }, request);
  assert.deepEqual(calls[0], ['verified-human', schoolId]); assert.equal(calls[1][1].organizationId, organizationId); assert.equal(calls[1][1].principalId, principalId); assert.equal(calls[1][1].source, 'HUMAN_UI');
  assert.deepEqual(Object.keys(read.data), ['scorecard']);
  const response = { status: value => { response.value = value; } };
  const recorded = await controller.record({ schoolId, testingCandidateId: candidateId, testingEventId: eventId, criterionCode: 'TECHNIQUE.BALANCE', assessment: 'OBSERVED', expectedCandidateVersion: 2, expectedTestingEventVersion: 3, expectedScorecardVersion: 0 }, 'key', request, response);
  assert.equal(response.value, 201); assert.equal(recorded.data.scorecard.evaluation.id, evaluationId); assert.equal(calls[3][1].idempotencyKey, 'key');
  await assert.rejects(() => controller.read({ schoolId, testingCandidateId: candidateId, testingEventId: eventId, organizationId }, request), expected(400, 'VALIDATION_FAILED'));
  await assert.rejects(() => controller.read({ schoolId, testingCandidateId: candidateId, testingEventId: eventId }, {}), expected(403, 'IDENTITY_REQUIRED'));
  const denied = new TestingScorecardController({ resolveTestingScorecardScope: async () => undefined }, scorecards);
  await assert.rejects(() => denied.read({ schoolId, testingCandidateId: candidateId, testingEventId: eventId }, request), expected(403, 'TESTING_SCORECARD_SCOPE_DENIED'));
});

test('scorecard service accepts fixed database boundaries only, rejects nonhuman/delegated contexts and private fields', async () => {
  const calls = [];
  const service = new TestingScorecardService({ readTestingScorecard: async (...args) => { calls.push(['read', ...args]); return rawView; }, recordTestingScorecardEvaluation: async (...args) => { calls.push(['record', ...args]); return { record: rawReceipt, replayed: false }; } });
  assert.deepEqual(await service.read(context, candidateId, eventId), rawView);
  assert.deepEqual(await service.record(context, { testingCandidateId: candidateId, testingEventId: eventId, criterionCode: 'TECHNIQUE.BALANCE', assessment: 'OBSERVED', expectedCandidateVersion: 2, expectedTestingEventVersion: 3, expectedScorecardVersion: 0 }), { ...rawReceipt, replayed: false });
  assert.equal(calls[0][0], 'read'); assert.equal(calls[1][0], 'record'); assert.equal(calls[1][2], candidateId); assert.equal(calls[1][3], eventId);
  await assert.rejects(() => service.read({ ...context, source: 'AI' }, candidateId, eventId), expected(403, 'HUMAN_UI_REQUIRED'));
  await assert.rejects(() => service.record({ ...context, delegatedByPrincipalId: principalId }, { testingCandidateId: candidateId, testingEventId: eventId, criterionCode: 'TECHNIQUE.BALANCE', assessment: 'OBSERVED', expectedCandidateVersion: 2, expectedTestingEventVersion: 3, expectedScorecardVersion: 0 }), expected(403, 'HUMAN_UI_REQUIRED'));
  await assert.rejects(() => service.record(context, { testingCandidateId: candidateId, testingEventId: eventId, criterionCode: 'TECHNIQUE.BALANCE', assessment: 'PASSED', expectedCandidateVersion: 2, expectedTestingEventVersion: 3, expectedScorecardVersion: 0 }), expected(400, 'VALIDATION_FAILED'));
  const privateField = new TestingScorecardService({ readTestingScorecard: async () => ({ ...rawView, evaluatorPrincipalId: principalId }) });
  await assert.rejects(() => privateField.read(context, candidateId, eventId), expected(503, 'TESTING_SCORECARD_UNAVAILABLE'));
});

test('scorecard API source has no raw controller SQL, outcome mutation, parent surface, or external integration', () => {
  const source = [
    readFileSync('src/testing/testing-scorecard.controller.ts', 'utf8'),
    readFileSync('src/testing/testing-scorecard.service.ts', 'utf8'),
    readFileSync('src/testing/testing-scorecard.dto.ts', 'utf8'),
  ].join('\n');
  assert.doesNotMatch(source, /client\.query|SELECT\s+\*|invokeLLM|executeAction|sendMessage|payment|attendance|promotion|grade\(/i);
  assert.match(source, /readTestingScorecard/); assert.match(source, /recordTestingScorecardEvaluation/);
  assert.doesNotMatch(source, /studentProfileId|familyId|evaluatorPrincipalId|rankId|certificateId|parent/i);
});
