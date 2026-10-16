const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const { InstructorQualificationsController } = require('../dist/instructor-qualifications/instructor-qualifications.controller.js');
const { InstructorQualificationsService } = require('../dist/instructor-qualifications/instructor-qualifications.service.js');
const { InstructorQualificationsHumanUiGuard } = require('../dist/instructor-qualifications/instructor-qualifications.dto.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { INSTRUCTOR_QUALIFICATION_COMMAND_REGISTRY, ACTION_CATALOG } = require('@hon/config');

const ids = { organizationId: '11111111-1111-4111-8111-111111111111', schoolId: '22222222-2222-4222-8222-222222222222', principalId: '33333333-3333-4333-8333-333333333333', staffId: '44444444-4444-4444-8444-444444444444', programId: '55555555-5555-4555-8555-555555555555', qualificationId: '66666666-6666-4666-8666-666666666666', evidenceId: '77777777-7777-4777-8777-777777777777' };
const scope = { organizationId: ids.organizationId, schoolId: ids.schoolId, principalId: ids.principalId };
const context = (patch = {}) => ({ ...scope, externalSubject: 'verified-human', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: 'retained-key', ...patch });
const definition = { id: ids.qualificationId, code: 'FIRST_AID', title: 'First aid training', kind: 'QUALIFICATION', courseProgramId: ids.programId, version: 1, status: 'ACTIVE', humanRecordedOnly: true, qualificationOnly: true };
const evidence = { id: ids.evidenceId, staffPrincipalId: ids.staffId, qualificationId: ids.qualificationId, qualificationVersion: 1, courseProgramId: ids.programId, kind: 'QUALIFICATION', attainedOn: '2026-01-10', expiresOn: '2028-01-10', evidenceRecordedAt: '2026-01-10T00:00:00.000Z', evidenceRecorded: true, reviewVersion: 1, reviewStatus: 'RECORDED', reviewedAt: '2026-01-10T00:00:00.000Z', expiredOnRead: false, humanRecordedOnly: true, qualificationOnly: true, notEligibility: true };
const create = (patch = {}) => ({ code: 'FIRST_AID', title: 'First aid training', kind: 'QUALIFICATION', courseProgramId: ids.programId, ...patch });
const record = (patch = {}) => ({ qualificationId: ids.qualificationId, expectedQualificationVersion: 1, attainedOn: '2026-01-10', expiresOn: '2028-01-10', evidenceReference: 'Internal human evidence', ...patch });
const review = (patch = {}) => ({ expectedReviewVersion: 1, status: 'REVIEWED', reviewNote: 'Human review', ...patch });
const expected = (http, code) => error => { assert.equal(error.getStatus?.(), http, error.stack); if (code) assert.equal(error.getResponse?.().code, code); return true; };

function mockDatabase(calls = []) {
  const transaction = async (_context, work) => work({ query: async (sql, args) => {
    calls.push([sql, args]);
    if (sql.startsWith('SELECT hon.read_instructor_qualification')) {
      if (sql.includes("'ACCESS'")) return { rows: [{ data: { canRead: true, canManage: true, humanRecordedOnly: true, qualificationOnly: true } }] };
      if (sql.includes("'QUALIFICATION'")) return { rows: [{ data: definition }] };
      return { rows: [{ data: evidence }] };
    }
    if (sql.startsWith('SELECT hon.mutate_instructor_qualification')) return { rows: [{ data: { record: args[1] === 'EVIDENCE_RECORD' || args[1] === 'EVIDENCE_REVIEW' ? evidence : definition, replayed: false } }] };
    return { rows: [] };
  } });
  return {
    resolveInstructorQualificationScope: async subject => { calls.push(['scope', subject]); return scope; },
    withTenantTransaction: transaction,
    withTenantReadOnlyTransaction: transaction,
  };
}

test('instructor qualification service admits exact redacted database boundaries only and rejects nonhuman/delegated/action contexts before SQL', async () => {
  const calls = [], service = new InstructorQualificationsService(mockDatabase(calls));
  assert.deepEqual(await service.access(context()), { canRead: true, canManage: true, humanRecordedOnly: true, qualificationOnly: true });
  assert.deepEqual((await service.create(context(), create())).record, definition);
  assert.deepEqual((await service.record(context(), ids.staffId, record())).record, evidence);
  assert.deepEqual((await service.review(context(), ids.staffId, ids.evidenceId, review())).record, evidence);
  assert.match(calls.find(call => String(call[0]).startsWith('SELECT hon.mutate'))[0], /^SELECT hon\.mutate_instructor_qualification/);
  for (const patch of [{ source: 'AI' }, { source: 'PARENT_APP' }, { source: 'HQ_SUPPORT' }, { principalType: 'AI_EMPLOYEE' }, { principalType: 'AUTOMATION' }, { actionRequestId: randomUUID() }, { delegatedByPrincipalId: randomUUID() }]) {
    const count = calls.length;
    await assert.rejects(() => service.access(context(patch)), expected(403, 'HUMAN_UI_REQUIRED'));
    await assert.rejects(() => service.create(context(patch), create()), expected(403, 'HUMAN_UI_REQUIRED'));
    assert.equal(calls.length, count, 'rejected direct-human context must not reach SQL');
  }
  for (const input of [create({ title: ' bad' }), create({ courseProgramId: 'not-a-uuid' }), create({ legalCredential: true }), record({ attainedOn: '2026-02-30' }), record({ expiresOn: '2025-01-01' }), review({ status: 'APPROVED' }), review({ reviewNote: '<private>' })]) {
    await assert.rejects(() => input.code ? service.create(context(), input) : input.qualificationId ? service.record(context(), ids.staffId, input) : service.review(context(), ids.staffId, ids.evidenceId, input), expected(400, 'VALIDATION_FAILED'));
  }
  for (const [code, http] of [['42501', 403], ['P0002', 404], ['40001', 409], ['23505', 409], ['22023', 400], ['57014', 503]]) {
    await assert.rejects(() => new InstructorQualificationsService({ withTenantReadOnlyTransaction: async () => { throw { code }; } }).access(context()), expected(http));
  }
  const unsafe = new InstructorQualificationsService({ withTenantReadOnlyTransaction: async (_c, work) => work({ query: async () => ({ rows: [{ data: { ...definition, actorPrincipalId: ids.principalId } }] }) }) });
  await assert.rejects(() => unsafe.qualification(context(), ids.qualificationId), /Unsafe qualification response/);
});

test('controller derives the one live direct-human scope, never accepts authority inputs, and has only fixed known-ID commands', async () => {
  const calls = [], controller = new InstructorQualificationsController(mockDatabase(calls), new InstructorQualificationsService(mockDatabase(calls)));
  const request = { honIdentity: { externalSubject: 'verified-human' }, body: { organizationId: randomUUID(), schoolId: randomUUID(), actorId: randomUUID() } };
  const access = await controller.access(request);
  assert.deepEqual(access.data, { canRead: true, canManage: true, humanRecordedOnly: true, qualificationOnly: true });
  const created = await controller.create(create(), 'controller-key', request, { status: value => { request.status = value; } });
  assert.equal(request.status, 201); assert.equal(created.data.id, ids.qualificationId);
  await assert.rejects(() => controller.access({}), expected(403, 'IDENTITY_REQUIRED'));
  const denied = new InstructorQualificationsController({ resolveInstructorQualificationScope: async () => undefined }, {});
  await assert.rejects(() => denied.access(request), expected(403, 'INSTRUCTOR_QUALIFICATION_SCOPE_DENIED'));
  assert(calls.filter(call => call[0] === 'scope').every(call => call[1] === 'verified-human'));
});

test('human UI guard and local HTTP routes require same-origin JSON/direct command, closed DTOs, known UUIDs, and retained idempotency keys', async () => {
  const old = process.env.HON_PUBLIC_ORIGIN;
  process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
  const guard = new InstructorQualificationsHumanUiGuard();
  const run = (method, headers) => guard.canActivate({ switchToHttp: () => ({ getRequest: () => ({ method, headers }) }) });
  const headers = { origin: 'https://hon.test', 'content-type': 'application/json', 'x-hon-human-command': 'instructor-qualifications', 'sec-fetch-site': 'same-origin' };
  try {
    assert(run('POST', headers)); assert(run('GET', {}));
    for (const patch of [{ origin: 'https://evil.test' }, { 'x-hon-human-command': 'staff-availability' }, { 'content-type': 'text/plain' }, { 'sec-fetch-site': 'cross-site' }]) assert.throws(() => run('POST', { ...headers, ...patch }), expected(403));
    for (const method of ['PUT', 'PATCH', 'DELETE']) assert.throws(() => run(method, headers), expected(403));
    const database = mockDatabase();
    const module = await Test.createTestingModule({ controllers: [InstructorQualificationsController], providers: [InstructorQualificationsService, InstructorQualificationsHumanUiGuard, { provide: RuntimeDatabaseService, useValue: database }] })
      .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
    const app = module.createNestApplication(); app.setGlobalPrefix('v1'); app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })); await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/staff/instructor-qualifications`;
    const postHeaders = { Origin: 'https://hon.test', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'instructor-qualifications', 'Idempotency-Key': 'http-retained-key' };
    try {
      assert.equal((await fetch(`${base}/access`)).status, 200);
      assert.equal((await fetch(`${base}/qualifications`, { method: 'POST', headers: postHeaders, body: JSON.stringify(create()) })).status, 201);
      assert.equal((await fetch(`${base}/staff/${ids.staffId}/evidence`, { method: 'POST', headers: postHeaders, body: JSON.stringify(record()) })).status, 201);
      assert.equal((await fetch(`${base}/staff/${ids.staffId}/evidence/${ids.evidenceId}/review`, { method: 'POST', headers: postHeaders, body: JSON.stringify(review()) })).status, 200);
      assert.equal((await fetch(`${base}/qualifications/${ids.qualificationId}/retire`, { method: 'POST', headers: postHeaders, body: JSON.stringify({ expectedVersion: 1 }) })).status, 200);
      for (const body of [create({ schoolId: ids.schoolId }), create({ code: 'bad' })]) assert.equal((await fetch(`${base}/qualifications`, { method: 'POST', headers: postHeaders, body: JSON.stringify(body) })).status, 400);
      assert.equal((await fetch(`${base}/qualifications/not-a-uuid`)).status, 400);
      assert.equal((await fetch(base)).status, 404);
      assert.equal((await fetch(`${base}/access`, { method: 'DELETE', headers: postHeaders })).status, 404);
      assert.equal((await fetch(`${base}/qualifications`, { method: 'POST', headers: { ...postHeaders, Origin: 'https://evil.test' }, body: JSON.stringify(create()) })).status, 403);
    } finally { await app.close(); }
  } finally { if (old === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = old; }
});

test('qualification source is human-only/inert and excludes scheduling, testing, payroll, provider, payment, message and Action Engine adapters', () => {
  assert.equal(INSTRUCTOR_QUALIFICATION_COMMAND_REGISTRY.length, 2);
  for (const command of INSTRUCTOR_QUALIFICATION_COMMAND_REGISTRY) {
    assert.equal(command.minimumTier, 'ESSENTIAL'); assert.equal(command.execution, 'HUMAN_ONLY'); assert.equal(command.source, 'HUMAN_UI'); assert.equal(command.inertEvidence, true); assert.equal(command.eligibilityDecision, false);
    assert(!ACTION_CATALOG.some(action => action.code === command.code));
  }
  const source = ['instructor-qualifications.controller.ts', 'instructor-qualifications.service.ts', 'instructor-qualifications.dto.ts'].map(file => readFileSync(`src/instructor-qualifications/${file}`, 'utf8')).join('\n');
  assert.doesNotMatch(source, /ActionEngineService|\bAi[A-Z]\w*Service|ProviderRuntime|PaymentService|MessagingService|sendMessage|fetch\(/i);
  assert.doesNotMatch(source, /actorPrincipalId|evidenceReference.*return|reviewNote.*return/i);
  const migration = readFileSync('../../packages/database/migrations/0109_human_instructor_qualifications.sql', 'utf8');
  assert.doesNotMatch(migration, /(?:INSERT INTO|UPDATE|DELETE FROM) hon\.(?:class_sessions|class_session_instructors|class_templates|class_bookings|testing_candidates|promotion_decisions|memberships|invoices|payment_attempts|communication_messages|action_requests|ai_usage_ledger|ai_invocation_plans)/);
  assert.match(migration, /execution_allowed boolean NOT NULL DEFAULT false CHECK\(NOT execution_allowed\)/);
});
