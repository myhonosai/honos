const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
const { ValidationPipe } = require('@nestjs/common');
const { Test } = require('@nestjs/testing');
const { CurriculumProgressController } = require('../dist/curriculum/curriculum-progress.controller.js');
const { CurriculumProgressService } = require('../dist/curriculum/curriculum-progress.service.js');
const { CurriculumHumanUiGuard } = require('../dist/curriculum/curriculum-human-ui.guard.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');

test('existing enrollment GET / observation POST preserves live scope, server-derived actor, closed DTO, versions, marker and private no-store replay', async () => {
  const [organizationId, schoolId, principalId, curriculumId, enrollmentId, requirementId, rankId, studentProfileId] = Array.from({ length: 8 }, randomUUID);
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
  const input = { requirementId, expectedRequirementVersion: 2, expectedEnrollmentVersion: 3, expectedProgressVersion: 7, status: 'MET', instructorNote: 'PRIVATE_NOTE' };
  const enrollment = { enrollment: { id: enrollmentId, curriculumId, studentProfileId, currentRankId: rankId, version: 3, status: 'ACTIVE', enrolledAt: '2026-10-16T12:00:00+00:00' }, requirements: [{ id: requirementId, rankId, code: 'BASICS', kind: 'TECHNIQUE', definition: { label: 'Foundation' }, required: true, version: 2, progressVersion: 7, status: null, recordedAt: null }] };
  const observation = { id: randomUUID(), enrollmentId, requirementId, requirementVersion: 2, enrollmentVersion: 3, status: 'MET', version: 8, recordedAt: '2026-10-16T12:00:00+00:00' };
  let allowed = true, transactions = 0; const scopes = [], commands = new Map();
  const db = {
    resolveAuthorizedScope: async (...args) => { scopes.push(args); return allowed ? { organizationId, schoolId, principalId } : null; },
    withTenantTransaction: async (context, work) => {
      transactions++; assert.equal(context.principalId, principalId); assert.equal(context.externalSubject, 'verified-subject'); assert.equal(context.principalType, 'HUMAN_USER'); assert.equal(context.source, 'HUMAN_UI'); assert.equal(context.organizationId, organizationId); assert.equal(context.schoolId, schoolId);
      assert.equal(context.requestId, context.correlationId); assert.equal(context.actionRequestId, undefined); assert.equal(context.delegatedByPrincipalId, undefined);
      return work({ query: async (sql, params) => {
        if (sql.includes('read_staff_curriculum_progress')) { assert.deepEqual(params, ['verified-subject', 'ENROLLMENT', curriculumId, enrollmentId]); return { rows: [{ data: enrollment }] }; }
        if (sql.includes('mutate_curriculum_progress')) {
          assert.deepEqual(params.slice(0, 4), ['verified-subject', 'OBSERVE', curriculumId, enrollmentId]); assert.deepEqual(JSON.parse(params[4]), input); assert.equal(params[5], context.idempotencyKey);
          const replayed = commands.has(params[5]); commands.set(params[5], params[4]); return { rows: [{ data: { record: observation, replayed } }] };
        }
        return { rows: [] };
      } });
    },
  };
  const module = await Test.createTestingModule({ controllers: [CurriculumProgressController], providers: [CurriculumProgressService, CurriculumHumanUiGuard, { provide: RuntimeDatabaseService, useValue: db }] }).overrideGuard(HonIdentityGuard).useValue({ canActivate: c => { c.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-subject' }; return true; } }).compile();
  const app = module.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  try {
    await app.listen(0, '127.0.0.1'); const base = `http://127.0.0.1:${app.getHttpServer().address().port}/organizations/${organizationId}/schools/${schoolId}/curricula/${curriculumId}/enrollments/${enrollmentId}`;
    const headers = { Origin: 'https://hon.test', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'curriculum-progress', 'Idempotency-Key': randomUUID() };
    const get = await fetch(base); assert.equal(get.status, 200); assert.equal(get.headers.get('cache-control'), 'private, no-store'); const returned = await get.json(); assert.deepEqual(returned.data, enrollment); assert.equal(returned.meta.replayed, false);
    for (const replayed of [false, true]) {
      const post = await fetch(base + '/observations', { method: 'POST', headers, body: JSON.stringify(input) }); assert.equal(post.status, 200); assert.equal(post.headers.get('cache-control'), 'private, no-store');
      const result = await post.json(); assert.deepEqual(result.data, observation); assert.equal(result.meta.replayed, replayed); assert.equal(result.meta.requestId, result.meta.correlationId); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_NOTE|actor|authority|outbox|audit/);
    }
    const before = transactions;
    for (const field of ['organizationId', 'schoolId', 'principalId', 'source', 'actionRequestId', 'delegatedByPrincipalId', 'currentRankId', 'evidence', 'testingCandidateId']) {
      const post = await fetch(base + '/observations', { method: 'POST', headers, body: JSON.stringify({ ...input, [field]: principalId }) }); assert.equal(post.status, 400);
    }
    for (const patch of [{ status: 'PROMOTION' }, { expectedRequirementVersion: 0 }, { expectedEnrollmentVersion: '3' }, { expectedProgressVersion: -1 }, { instructorNote: 'x'.repeat(2001) }]) {
      const post = await fetch(base + '/observations', { method: 'POST', headers, body: JSON.stringify({ ...input, ...patch }) }); assert.equal(post.status, 400);
    }
    for (const patch of [{ Origin: 'https://evil.test' }, { 'X-HON-Human-Command': 'testing' }, { 'Content-Type': 'text/plain' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      const post = await fetch(base + '/observations', { method: 'POST', headers: { ...headers, ...patch }, body: JSON.stringify(input) }); assert.equal(post.status, 403);
    }
    assert.equal(transactions, before);
    allowed = false;
    assert.equal((await fetch(base)).status, 403);
    assert.equal((await fetch(base + '/observations', { method: 'POST', headers, body: JSON.stringify(input) })).status, 403); // retained replay rechecks live authority
    assert.equal(transactions, before); assert(scopes.every(args => JSON.stringify(args) === JSON.stringify(['verified-subject', schoolId, 'curriculum.progress.record'])));
    allowed = true;
    assert.equal((await fetch(base.replace(organizationId, randomUUID()))).status, 403); assert.equal(transactions, before);
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});
