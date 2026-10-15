const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
require('reflect-metadata');
const { GUARDS_METADATA, PATH_METADATA } = require('@nestjs/common/constants');
const { TestingCertificateController } = require('../dist/testing/testing-certificate.controller.js');
const { TestingCertificateService } = require('../dist/testing/testing-certificate.service.js');
const { TestingCertificateHumanUiGuard } = require('../dist/testing/testing-certificate.dto.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');

const schoolId = '11111111-1111-4111-8111-111111111111';
const candidateId = '22222222-2222-4222-8222-222222222222';
const rankId = '33333333-3333-4333-8333-333333333333';
const certificateId = '44444444-4444-4444-8444-444444444444';
const organizationId = '55555555-5555-4555-8555-555555555555';
const principalId = '66666666-6666-4666-8666-666666666666';
const requestId = '77777777-7777-4777-8777-777777777777';
const rawCertificate = { id: certificateId, targetRankId: rankId, targetRankName: 'Blue Rank', title: 'School testing certificate', issuedAt: '2026-10-15T20:00:00.000Z', version: 1, status: 'ISSUED' };
const rawView = { testingCandidateId: candidateId, targetRankId: rankId, candidateVersion: 2, status: 'ELIGIBLE_TO_ISSUE', certificate: null };
const context = { organizationId, schoolId, principalId, externalSubject: 'verified-human', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId, correlationId: requestId, idempotencyKey: 'certificate-key' };
const expected = (status, code) => error => { assert.equal(error.getStatus(), status, error.stack); if (code) assert.equal(error.getResponse().code, code); return true; };

test('certificate controller is identity and trusted-human guarded, uses only derived current school scope, and accepts closed selectors', async () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, TestingCertificateController), 'staff/testing/certificates');
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, TestingCertificateController), [HonIdentityGuard, TestingCertificateHumanUiGuard]);
  const calls = [];
  const database = { resolveTestingCertificateScope: async (...args) => { calls.push(args); return { organizationId, schoolId, principalId }; } };
  const certificates = { read: async value => { calls.push(['read', value]); return rawView; }, issue: async value => { calls.push(['issue', value]); return { certificate: rawCertificate, replayed: false }; } };
  const controller = new TestingCertificateController(database, certificates);
  const request = { honIdentity: { externalSubject: 'verified-human' } };
  const read = await controller.read({ schoolId, testingCandidateId: candidateId }, request);
  assert.deepEqual(calls[0], ['verified-human', schoolId]); assert.equal(calls[1][1].organizationId, organizationId); assert.equal(calls[1][1].principalId, principalId); assert.equal(calls[1][1].source, 'HUMAN_UI');
  assert.deepEqual(Object.keys(read.data), ['certificate']);
  const response = { status: value => { response.value = value; } };
  const issued = await controller.issue({ schoolId, testingCandidateId: candidateId, expectedCandidateVersion: 2, expectedCertificateVersion: 0, title: 'School testing certificate' }, 'key', request, response);
  assert.equal(response.value, 201); assert.equal(issued.data.certificate.id, certificateId); assert.equal(calls[3][1].idempotencyKey, 'key');
  await assert.rejects(() => controller.read({ schoolId, testingCandidateId: candidateId, organizationId }, request), expected(400, 'VALIDATION_FAILED'));
  await assert.rejects(() => controller.read({ schoolId, testingCandidateId: candidateId }, {}), expected(403, 'IDENTITY_REQUIRED'));
  const denied = new TestingCertificateController({ resolveTestingCertificateScope: async () => undefined }, certificates);
  await assert.rejects(() => denied.read({ schoolId, testingCandidateId: candidateId }, request), expected(403, 'TESTING_CERTIFICATE_SCOPE_DENIED'));
});

test('certificate service accepts fixed database boundaries only, keeps strict redaction, and rejects nonhuman/delegated contexts and unknown fields', async () => {
  const calls = [];
  const service = new TestingCertificateService({
    readTestingCertificate: async (...args) => { calls.push(['read', ...args]); return rawView; },
    issueTestingCertificate: async (...args) => { calls.push(['issue', ...args]); return { certificate: rawCertificate, replayed: false }; },
  });
  assert.deepEqual(await service.read(context, candidateId), rawView);
  assert.deepEqual(await service.issue(context, { testingCandidateId: candidateId, expectedCandidateVersion: 2, expectedCertificateVersion: 0, title: 'School testing certificate' }), { certificate: rawCertificate, replayed: false });
  assert.equal(calls[0][0], 'read'); assert.equal(calls[1][0], 'issue'); assert.equal(calls[1][2], candidateId);
  await assert.rejects(() => service.read({ ...context, source: 'AI' }, candidateId), expected(403, 'HUMAN_UI_REQUIRED'));
  await assert.rejects(() => service.issue({ ...context, delegatedByPrincipalId: principalId }, { testingCandidateId: candidateId, expectedCandidateVersion: 2, expectedCertificateVersion: 0, title: 'School testing certificate' }), expected(403, 'HUMAN_UI_REQUIRED'));
  await assert.rejects(() => service.issue(context, { testingCandidateId: candidateId, expectedCandidateVersion: 2, expectedCertificateVersion: 0, title: 'School testing certificate', issuedByPrincipalId: principalId }), expected(400, 'VALIDATION_FAILED'));
  const privateField = new TestingCertificateService({ readTestingCertificate: async () => ({ ...rawView, certificate: { ...rawCertificate, issuedByPrincipalId: principalId } }) });
  await assert.rejects(() => privateField.read(context, candidateId), expected(503, 'TESTING_CERTIFICATE_UNAVAILABLE'));
});

test('certificate API source has no raw controller SQL, provider/action/AI integration, or unredacted response model', () => {
  const source = [
    readFileSync('src/testing/testing-certificate.controller.ts', 'utf8'),
    readFileSync('src/testing/testing-certificate.service.ts', 'utf8'),
    readFileSync('src/testing/testing-certificate.dto.ts', 'utf8'),
  ].join('\n');
  assert.doesNotMatch(source, /client\.query|SELECT\s+\*|provider|invokeLLM|executeAction|sendMessage|payment|attendance|promotion\.decide|grade\(/i);
  assert.match(source, /readTestingCertificate/); assert.match(source, /issueTestingCertificate/);
  assert.doesNotMatch(source, /studentProfileId|familyId|issuedByPrincipalId|rationale|instructorNotes/);
});
