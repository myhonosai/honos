const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
require('reflect-metadata');
const { PATH_METADATA, GUARDS_METADATA } = require('@nestjs/common/constants');
const { TeachingStudioController } = require('../dist/teaching-studio/teaching-studio.controller.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { TeachingStudioHumanUiGuard } = require('../dist/teaching-studio/teaching-studio.dto.js');
const contracts = require('@hon/contracts');

const organizationId = '11111111-1111-4111-8111-111111111111';
const schoolId = '22222222-2222-4222-8222-222222222222';
const principalId = '33333333-3333-4333-8333-333333333333';
const studentId = '44444444-4444-4444-8444-444444444444';
const context = { organizationId, schoolId, principalId, externalSubject: 'verified-human', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: '55555555-5555-4555-8555-555555555555', correlationId: '55555555-5555-4555-8555-555555555555' };
const status = expected => error => { assert.equal(error.getStatus(), expected); return true; };

function lesson() { return { id: '66666666-6666-4666-8666-666666666666', version: 1, title: 'Footwork warm-up', instructionalObjective: 'Practice stance transitions.', sections: [{ heading: 'Opening', content: 'Demonstrate controlled transitions.' }], durationMinutes: 30, status: 'DRAFT', targetCurriculumId: null, targetRankId: null, recordedAt: '2026-10-15T12:00:00.000Z', humanAuthoredOnly: true }; }
function assessment() { return { id: '77777777-7777-4777-8777-777777777777', version: 1, studentProfileId: studentId, observation: 'Practiced a controlled stance transition.', assessedSkills: [{ skill: 'Stance transition', status: 'OBSERVED' }], instructorNote: null, assessedOn: '2026-10-15', status: 'RECORDED', targetCurriculumId: null, targetRankId: null, recordedAt: '2026-10-15T12:00:00.000Z', instructionalOnly: true }; }

test('Teaching Studio is guarded and derives context only from verified human identity plus fixed school selector', async () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, TeachingStudioController), 'staff/teaching-studio');
  const guards = Reflect.getMetadata(GUARDS_METADATA, TeachingStudioController);
  assert.deepEqual(guards, [HonIdentityGuard, TeachingStudioHumanUiGuard]);
  const scopes = [];
  const controller = new TeachingStudioController({ resolveTeachingStudioScope: async (...args) => { scopes.push(args); return context; } }, { access: async received => ({ canRead: true, canManageLessons: false, canManageResources: false, canRecordAssessments: false, received }) });
  const response = await controller.access({ schoolId }, { honIdentity: { externalSubject: 'verified-human' }, tier: 'COMPLETE', principalId: 'forged', source: 'AI' });
  assert.deepEqual(scopes, [['verified-human', schoolId]]);
  assert.equal(response.data.canRead, true);
  await assert.rejects(() => controller.access({ schoolId, organizationId }, { honIdentity: { externalSubject: 'verified-human' } }), status(400));
  await assert.rejects(() => controller.access({ schoolId }, {}), status(403));
});

test('Teaching Studio contracts reject directory identity fields, unsafe assessment claims, and unknown output keys', () => {
  assert.deepEqual(contracts.verifyTeachingLesson(lesson()), lesson());
  assert.deepEqual(contracts.verifyTeachingAssessment(assessment()), assessment());
  for (const mutate of [
    value => { value.createdByPrincipalId = principalId; },
    value => { value.recordedByPrincipalId = principalId; },
    value => { value.email = 'private@example.test'; },
  ]) { const value = lesson(); mutate(value); assert.throws(() => contracts.verifyTeachingLesson(value)); }
  assert.throws(() => contracts.validateTeachingAssessment({ expectedVersion: 0, observation: 'Student is ready for promotion', assessedSkills: [], instructorNote: null, assessedOn: '2026-10-15', status: 'RECORDED', targetCurriculumId: null, targetRankId: null }));
});

test('Teaching Studio implementation has no provider, Action Engine, attendance, progress, testing, promotion, membership, billing, or parent mutation path', () => {
  const controller = readFileSync('src/teaching-studio/teaching-studio.controller.ts', 'utf8');
  const service = readFileSync('src/teaching-studio/teaching-studio.service.ts', 'utf8');
  const migration = readFileSync('../../packages/database/migrations/0095_teaching_studio_foundation.sql', 'utf8');
  assert.match(service, /withTenantTransaction/);
  assert.match(migration, /noProgressTestingPromotionAttendanceMutation/);
  assert.doesNotMatch(`${controller}\n${service}`, /invokeLLM|executeAction|sendMessage|charge|refund|membership\.activate|promotion\.decide|testing\.grade|attendance\.record/i);
});
