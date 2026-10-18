const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
const { UnauthorizedException, ValidationPipe } = require('@nestjs/common');
const { Test } = require('@nestjs/testing');
const { verifyCurriculumEnrollmentPreparation, validateCurriculumEnrollmentPreparationInput } = require('@hon/contracts');
const { CurriculumEnrollmentPreparationController } = require('../dist/curriculum/curriculum-enrollment-preparation.controller.js');
const { CurriculumEnrollmentPreparationService } = require('../dist/curriculum/curriculum-enrollment-preparation.service.js');
const { CurriculumEnrollmentPreparationGuard, CurriculumEnrollmentPreparationNoStoreGuard } = require('../dist/curriculum/curriculum-enrollment-preparation.guard.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');

const [organizationId, schoolId, principalId, studentProfileId, curriculumA, curriculumB, rankA, rankB] = Array.from({ length: 8 }, randomUUID);
const projection = {
  student: { id: studentProfileId, displayName: 'Ada Student' },
  curricula: [
    { id: curriculumA, name: 'Alpha Curriculum', ranks: [{ id: rankA, name: 'White', progressionOrder: 1 }] },
    { id: curriculumB, name: 'Beta Curriculum', ranks: [{ id: rankB, name: 'Blue', progressionOrder: 2 }] },
  ],
};
const input = { studentProfileId };
const headers = () => ({ Origin: 'https://hon.test', 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', 'X-HON-Human-Command': 'curriculum-enrollment-preparation' });

function guardRequest(patch = {}) {
  return { method: 'POST', headers: { origin: 'https://hon.test', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-hon-human-command': 'curriculum-enrollment-preparation' }, query: {}, originalUrl: '/organizations/id/schools/id/curricula/enrollment-preparation', body: input, ...patch };
}
function runGuard(request) {
  return new CurriculumEnrollmentPreparationGuard().canActivate({ switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ setHeader() {} }) }) });
}

test('closed preparation contract accepts only one UUID request and a deterministically ordered safe projection', () => {
  validateCurriculumEnrollmentPreparationInput(input);
  assert.deepEqual(verifyCurriculumEnrollmentPreparation(projection), projection);
  for (const value of [{}, { studentProfileId, source: 'AI' }, { studentProfileId: 'not-a-uuid' }]) assert.throws(() => validateCurriculumEnrollmentPreparationInput(value));
  for (const value of [
    { ...projection, organizationId },
    { ...projection, curricula: [projection.curricula[1], projection.curricula[0]] },
    { ...projection, student: { ...projection.student, email: 'private@example.test' } },
    { ...projection, curricula: [{ ...projection.curricula[0], ranks: [{ ...projection.curricula[0].ranks[0], progressionOrder: 0 }] }] },
  ]) assert.throws(() => verifyCurriculumEnrollmentPreparation(value));
});

test('identity guard fails before the preparation guard can disclose origin or body policy', async () => {
  let called = 0;
  const module = await Test.createTestingModule({
    controllers: [CurriculumEnrollmentPreparationController],
    providers: [CurriculumEnrollmentPreparationService, CurriculumEnrollmentPreparationNoStoreGuard, CurriculumEnrollmentPreparationGuard, { provide: RuntimeDatabaseService, useValue: { resolveAuthorizedScope: async () => { called += 1; } } }],
  }).overrideGuard(HonIdentityGuard).useValue({ canActivate: () => { throw new UnauthorizedException('identity first'); } }).compile();
  const app = module.createNestApplication();
  try {
    await app.listen(0, '127.0.0.1');
    const response = await fetch(`http://127.0.0.1:${app.getHttpServer().address().port}/organizations/${organizationId}/schools/${schoolId}/curricula/enrollment-preparation`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'forged' });
    assert.equal(response.status, 401); assert.equal(response.headers.get('cache-control'), 'private, no-store'); assert.equal(response.headers.get('referrer-policy'), 'no-referrer'); assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow'); assert.equal(called, 0);
  } finally { await app.close(); }
});

test('dedicated preparation guard requires the exact configured human browser request and rejects ambient command authority', () => {
  const previous = process.env.HON_PUBLIC_ORIGIN;
  process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
  try {
    assert.equal(runGuard(guardRequest()), true);
    for (const patch of [
      { method: 'GET' },
      { headers: { ...guardRequest().headers, origin: 'https://evil.test' } },
      { headers: { ...guardRequest().headers, 'x-hon-human-command': 'curriculum-progress' } },
      { headers: { ...guardRequest().headers, 'content-type': 'text/plain' } },
      { headers: { ...guardRequest().headers, 'sec-fetch-site': 'cross-site' } },
      { headers: { ...guardRequest().headers, 'x-hon-source': 'AI' } },
      { headers: { ...guardRequest().headers, 'idempotency-key': randomUUID() } },
      { body: { ...input, organizationId } },
      { body: { ...input, source: 'AI' } },
      { body: { ...input, delegatedByPrincipalId: principalId } },
      { body: { ...input, actionRequestId: randomUUID() } },
      { honContext: { principalId } },
      { query: { studentProfileId }, originalUrl: '/x?studentProfileId=forged' },
    ]) assert.throws(() => runGuard({ ...guardRequest(), ...patch }));
  } finally { if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});

test('HTTP preparation uses verified identity and exact live scope, has no idempotency write path, and emits only the private no-store envelope', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN;
  process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
  let allowed = true;
  const scopes = [], queries = [];
  const db = {
    resolveAuthorizedScope: async (...args) => { scopes.push(args); return allowed ? { organizationId, schoolId, principalId } : undefined; },
    withTenantReadOnlyTransaction: async (context, work) => {
      assert.equal(context.organizationId, organizationId); assert.equal(context.schoolId, schoolId); assert.equal(context.principalId, principalId);
      assert.equal(context.externalSubject, 'verified-subject'); assert.equal(context.principalType, 'HUMAN_USER'); assert.equal(context.source, 'HUMAN_UI');
      assert.equal(context.idempotencyKey, ''); assert.equal(context.requestId, context.correlationId); assert.equal(context.actionRequestId, undefined); assert.equal(context.delegatedByPrincipalId, undefined);
      return work({ query: async (sql, params) => {
        queries.push(sql);
        if (sql.includes('read_staff_curriculum_enrollment_preparation')) { assert.deepEqual(params, ['verified-subject', studentProfileId]); return { rows: [{ data: projection }] }; }
        return { rows: [] };
      } });
    },
  };
  const module = await Test.createTestingModule({ controllers: [CurriculumEnrollmentPreparationController], providers: [CurriculumEnrollmentPreparationService, CurriculumEnrollmentPreparationNoStoreGuard, CurriculumEnrollmentPreparationGuard, { provide: RuntimeDatabaseService, useValue: db }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate: (context) => { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-subject' }; return true; } }).compile();
  const app = module.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  try {
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}/organizations/${organizationId}/schools/${schoolId}/curricula/enrollment-preparation`;
    const okay = await fetch(base, { method: 'POST', headers: headers(), body: JSON.stringify(input) });
    assert.equal(okay.status, 200); assert.equal(okay.headers.get('cache-control'), 'private, no-store'); assert.equal(okay.headers.get('referrer-policy'), 'no-referrer');
    const response = await okay.json();
    assert.deepEqual(response, { data: projection, meta: { requestId: response.meta.requestId, correlationId: response.meta.correlationId, replayed: false } });
    assert.equal(response.meta.requestId, response.meta.correlationId); assert.match(response.meta.requestId, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(Object.keys(response.data).sort(), ['curricula','student']); assert.doesNotMatch(JSON.stringify(response), /principal|permission|school|organization|audit|outbox|idempotency|provider|billing/i);
    assert(queries.some((sql) => sql.includes('read_staff_curriculum_enrollment_preparation')));
    assert(queries.every((sql) => !/(INSERT|UPDATE|DELETE|idempotency_records|audit_events|outbox_events)/i.test(sql)));
    const before = queries.length;
    for (const patch of [{ source: 'AI' }, { principalId }, { organizationId }, { schoolId }, { permission: 'curriculum.manage' }, { delegatedByPrincipalId: principalId }, { actionRequestId: randomUUID() }]) {
      const rejected = await fetch(base, { method: 'POST', headers: headers(), body: JSON.stringify({ ...input, ...patch }) });
      assert.equal(rejected.status, 400);
    }
    for (const patch of [{ Origin: 'https://evil.test' }, { 'X-HON-Human-Command': 'curriculum-progress' }, { 'Content-Type': 'text/plain' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'X-HON-Source': 'AI' }]) {
      const rejected = await fetch(base, { method: 'POST', headers: { ...headers(), ...patch }, body: JSON.stringify(input) });
      assert.equal(rejected.status, 403);
    }
    assert.equal(queries.length, before, 'rejected input must not start a projection transaction');
    allowed = false;
    assert.equal((await fetch(base, { method: 'POST', headers: headers(), body: JSON.stringify(input) })).status, 403);
    allowed = true;
    assert.equal((await fetch(base.replace(organizationId, randomUUID()), { method: 'POST', headers: headers(), body: JSON.stringify(input) })).status, 403);
    assert.deepEqual(scopes, scopes.map(() => ['verified-subject', schoolId, 'curriculum.progress.record']));
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});
