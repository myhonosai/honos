const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
require('reflect-metadata');
const { GUARDS_METADATA, PATH_METADATA } = require('@nestjs/common/constants');
const { HealthScoreController } = require('../dist/reports/health-score.controller.js');
const { HealthScoreService } = require('../dist/reports/health-score.service.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');

const organizationId = '11111111-1111-4111-8111-111111111111';
const schoolId = '22222222-2222-4222-8222-222222222222';
const generatedAt = '2026-06-02T00:00:00.000Z';
const day = 86_400_000;
const status = (expected, code) => error => { assert.equal(error.getStatus(), expected); if (code) assert.equal(error.getResponse().code, code); return true; };
const window = days => ({ windowFrom: new Date(Date.parse(generatedAt) - days * day).toISOString(), windowTo: generatedAt });
function raw() {
  return {
    organizationId, schoolId, entitlementTier: 'ESSENTIAL', formulaVersion: 'SCHOOL_HEALTH_SCORE_V1', generatedAt,
    weights: { attendanceEngagement: 35, pipelineTrial: 25, retention: 25, operations: 15 },
    categories: {
      attendanceEngagement: { status: 'AVAILABLE', ...window(28), evidence: { completedSessions: 4, recordedAttendanceObservations: 20, engagedAttendanceObservations: 15 }, reasons: [], score: 75 },
      pipelineTrial: { status: 'AVAILABLE', ...window(56), evidence: { leadsCreated: 5, trialAppointments: 4, trialOutcomesRecorded: 3 }, reasons: [], score: 75 },
      retention: { status: 'AVAILABLE', ...window(90), evidence: { membershipTermsEnded: 5, renewalReviewsRecorded: 4 }, reasons: [], score: 80 },
      operations: { status: 'AVAILABLE', ...window(28), evidence: { pendingApprovals: 1, outstandingWorkItems: 2 }, reasons: [], score: 80 },
    },
    overall: { status: 'AVAILABLE', reasons: [], score: 77 },
  };
}

test('Health Score route is identity-guarded, has fixed selector-only scope, and forwards no client tier/principal/action authority', async () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, HealthScoreController), 'organizations/:organizationId/schools/:schoolId/health-score');
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, HealthScoreController), [HonIdentityGuard]);
  const calls = []; const controller = new HealthScoreController({ read: async (...args) => { calls.push(args); return { ...raw(), indicatorStatement: 'Operational indicator only. It is not a forecast, cancellation/churn certainty, cash-revenue measure, or recommendation for consequential changes.' }; } });
  const response = await controller.read(organizationId, schoolId, {}, { honIdentity: { externalSubject: 'verified' }, tier: 'COMPLETE', principalId: 'forged', actionAuthority: 'AUTO' });
  assert.deepEqual(calls, [['verified', organizationId, schoolId]]);
  assert.deepEqual(Object.keys(response.data), ['healthScore']); assert.equal(response.meta.requestId, response.meta.correlationId);
  await assert.rejects(() => controller.read(organizationId, schoolId, { tier: 'COMPLETE' }, { honIdentity: { externalSubject: 'verified' } }), status(400, 'VALIDATION_FAILED'));
  await assert.rejects(() => controller.read(organizationId, schoolId, {}, {}), status(403, 'SCHOOL_HEALTH_SCORE_FORBIDDEN'));
});

test('service calls one fixed aggregate projection and rebuilds formula composition from only approved facts', async () => {
  const calls = []; const service = new HealthScoreService({ readSchoolHealthScore: async (...args) => { calls.push(args); return raw(); } });
  const result = await service.read('verified', organizationId.toUpperCase(), schoolId.toUpperCase());
  assert.deepEqual(calls, [['verified', organizationId, schoolId]]);
  assert.deepEqual(Object.keys(result), ['organizationId', 'schoolId', 'entitlementTier', 'formulaVersion', 'generatedAt', 'weights', 'categories', 'overall', 'indicatorStatement']);
  assert.equal(result.overall.status, 'AVAILABLE'); assert.equal(result.overall.score, 77);
  assert.equal(result.categories.attendanceEngagement.score, 75); assert.equal(result.categories.operations.score, 80);
  assert.match(result.indicatorStatement, /not a forecast/i);
  assert.doesNotMatch(JSON.stringify(result), /email|personId|contact|notes|invoice|payment|actionRequestId|workItemId|provider|model|directory/i);
});

test('insufficient categories block the overall score with exact sample-gate reasons rather than a fabricated zero or risk claim', async () => {
  const source = raw();
  source.categories.attendanceEngagement = { status: 'INSUFFICIENT_DATA', ...window(28), evidence: { completedSessions: 2, recordedAttendanceObservations: 3, engagedAttendanceObservations: 2 }, reasons: ['MIN_COMPLETED_SESSIONS', 'MIN_RECORDED_ATTENDANCE_OBSERVATIONS'] };
  source.overall = { status: 'INSUFFICIENT_DATA', reasons: [{ category: 'ATTENDANCE_ENGAGEMENT', reasons: ['MIN_COMPLETED_SESSIONS', 'MIN_RECORDED_ATTENDANCE_OBSERVATIONS'] }] };
  const result = await new HealthScoreService({ readSchoolHealthScore: async () => source }).read('verified', organizationId, schoolId);
  assert.equal(result.overall.status, 'INSUFFICIENT_DATA'); assert.equal('score' in result.overall, false);
  assert.deepEqual(result.overall.reasons, [{ category: 'ATTENDANCE_ENGAGEMENT', reasons: ['MIN_COMPLETED_SESSIONS', 'MIN_RECORDED_ATTENDANCE_OBSERVATIONS'] }]);
});

test('strict output rejects PII/unknown fields, formula/window/reason/score manipulation, unavailable status, and mismatched scope', async () => {
  const cases = [
    value => { value.rawPii = 'PRIVATE_EMAIL'; },
    value => { value.organizationId = schoolId; },
    value => { value.categories.attendanceEngagement.personName = 'PRIVATE_PERSON'; },
    value => { value.categories.pipelineTrial.windowTo = value.categories.pipelineTrial.windowFrom; },
    value => { value.categories.attendanceEngagement.score = 74; },
    value => { value.categories.operations.status = 'UNAVAILABLE'; },
    value => { value.categories.retention.reasons = ['invented']; },
    value => { value.overall.score = 0; },
    value => { value.formulaVersion = 'AI_HEALTH_V9'; },
    value => { value.weights.operations = 100; },
  ];
  for (const mutate of cases) { const source = raw(); mutate(source); await assert.rejects(() => new HealthScoreService({ readSchoolHealthScore: async () => source }).read('verified', organizationId, schoolId), /Invalid HON School Health Score/); }
});

test('identity, inaccessible scope, and tier failures fail closed without exposing SQL state; no mutation/provider imports exist', async () => {
  for (const [message, code] of [['TIER_ENTITLEMENT_REQUIRED', 'TIER_ENTITLEMENT_REQUIRED'], ['SCHOOL_HEALTH_SCORE_FORBIDDEN', 'SCHOOL_HEALTH_SCORE_FORBIDDEN'], ['PRIVATE_DIRECTORY', 'SCHOOL_HEALTH_SCORE_FORBIDDEN']]) {
    await assert.rejects(() => new HealthScoreService({ readSchoolHealthScore: async () => { throw Object.assign(new Error(message), { code: '42501' }); } }).read('verified', organizationId, schoolId), error => { status(403, code)(error); assert.doesNotMatch(JSON.stringify(error.getResponse()), /PRIVATE_/); return true; });
  }
  const controller = readFileSync('src/reports/health-score.controller.ts', 'utf8'); const service = readFileSync('src/reports/health-score.service.ts', 'utf8');
  expectNoMutation(`${controller}\n${service}`);
});
function expectNoMutation(source) { assert.doesNotMatch(source, /@Post\(|@Patch\(|@Delete\(|invokeLLM|executeAction|sendMessage|provider|payment|mutation/i); }
