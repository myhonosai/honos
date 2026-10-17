const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
require('reflect-metadata');
const { ValidationPipe, UnauthorizedException } = require('@nestjs/common');
const { Test } = require('@nestjs/testing');
const { TestingCandidateController } = require('../dist/testing/testing-candidate.controller.js');
const { TestingCandidateService } = require('../dist/testing/testing-candidate.service.js');
const { TestingHumanUiGuard } = require('../dist/testing/testing-human-ui.guard.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');

function fixture() {
  const [organizationId, schoolId, principalId, testingEventId, studentCurriculumEnrollmentId, targetRankId, curriculumId] = Array.from({ length: 7 }, randomUUID);
  const ids = { organizationId, schoolId, principalId, testingEventId, studentCurriculumEnrollmentId, targetRankId, curriculumId };
  const records = new Map([testingEventId, studentCurriculumEnrollmentId, targetRankId].map(id => [id, { id, curriculumId }]));
  const state = { allowed: true, transactionAllowed: true, scopes: [], contexts: [], sql: [], candidates: [], commands: new Map() };
  const db = {
    resolveAuthorizedScope: async (...args) => { state.scopes.push(args); return state.allowed ? { organizationId, schoolId, principalId } : null; },
    withTenantTransaction: async (context, work) => {
      state.contexts.push(context);
      assert.equal(context.organizationId, organizationId); assert.equal(context.schoolId, schoolId); assert.equal(context.principalId, principalId);
      assert.equal(context.principalType, 'HUMAN_USER'); assert.equal(context.source, 'HUMAN_UI'); assert.equal(context.actionRequestId, undefined); assert.equal(context.delegatedByPrincipalId, undefined); assert.equal(context.requestId, context.correlationId);
      // A failed command drops all reservations and effects like the real tenant transaction.
      const commands = new Map(state.commands); const candidates = [...state.candidates];
      const result = await work({ query: async (sql, params = []) => {
        state.sql.push([sql, params]);
        if (sql.includes('set_config') || sql.startsWith('SET LOCAL')) return { rows: [], rowCount: 0 };
        if (sql.includes('lock_human_testing_authority')) { assert.deepEqual(params, ['testing.manage']); if (!state.transactionAllowed) throw Object.assign(new Error('permission revoked'), { code: '42501' }); return { rows: [], rowCount: 0 }; }
        if (sql.includes('lock_human_testing_record')) { assert.equal(params[0], 'testing.manage'); assert(['EVENT', 'RANK'].includes(params[1])); return { rows: [], rowCount: 0 }; }
        if (sql.includes('curriculum_id AS "curriculumId"')) { const record = records.get(params[0]); return { rows: record ? [record] : [], rowCount: record ? 1 : 0 }; }
        if (sql.includes('INSERT INTO hon.idempotency_records')) {
          assert.deepEqual(params.slice(0, 4), [organizationId, schoolId, principalId, context.idempotencyKey]);
          if (commands.has(context.idempotencyKey)) return { rows: [], rowCount: 0 };
          commands.set(context.idempotencyKey, { request_fingerprint: params[4], status: 'IN_PROGRESS', response_body: null }); return { rows: [{ id: randomUUID() }], rowCount: 1 };
        }
        if (sql.includes('SELECT request_fingerprint')) { assert.deepEqual(params, [organizationId, schoolId, principalId, context.idempotencyKey]); return { rows: [commands.get(context.idempotencyKey)], rowCount: 1 }; }
        if (sql.includes('pg_advisory_xact_lock')) { assert.deepEqual(params, [testingEventId, studentCurriculumEnrollmentId]); return { rows: [], rowCount: 0 }; }
        if (sql.includes('SELECT id') && sql.includes('FROM hon.testing_candidates')) {
          const existing = candidates.find(c => c.testingEventId === params[0] && c.studentCurriculumEnrollmentId === params[1]); return { rows: existing ? [{ id: existing.id }] : [], rowCount: existing ? 1 : 0 };
        }
        if (sql.includes('INSERT INTO hon.testing_candidates')) {
          assert.match(sql, /'PENDING'::hon.testing_candidate_result/); assert.deepEqual(params.slice(0, 5), [organizationId, schoolId, testingEventId, studentCurriculumEnrollmentId, targetRankId]);
          const candidate = { id: randomUUID(), testingEventId, studentCurriculumEnrollmentId, targetRankId, result: 'PENDING', instructorNotes: params[5], version: 1, createdAt: new Date('2026-10-16T12:00:00Z') };
          candidates.push(candidate); return { rows: [candidate], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO hon.audit_events')) { assert.match(sql, /'testing.candidate.register', 'TESTING_CANDIDATE'/); assert.equal(params[3], 'HUMAN_UI'); assert.equal(params[8], null); return { rows: [], rowCount: 1 }; }
        if (sql.includes('INSERT INTO hon.outbox_events')) { assert.match(sql, /'testing.candidate.registered'/); assert.equal(JSON.parse(params[7]).result, 'PENDING'); return { rows: [], rowCount: 1 }; }
        if (sql.includes('UPDATE hon.idempotency_records')) { assert.equal(params[4], 201); const prior = commands.get(context.idempotencyKey); commands.set(context.idempotencyKey, { ...prior, status: 'COMPLETED', response_body: JSON.parse(params[5]) }); return { rows: [], rowCount: 1 }; }
        throw new Error(`Unexpected SQL: ${sql}`);
      } });
      state.commands = commands; state.candidates = candidates; return result;
    },
  };
  const context = { organizationId, schoolId, principalId, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: '', idempotencyKey: randomUUID() }; context.correlationId = context.requestId;
  return { ids, records, state, db, context, input: { studentCurriculumEnrollmentId, targetRankId, instructorNotes: '  PRIVATE_NOTE  ' } };
}

test('canonical register HTTP route preserves exact testing marker, closed DTO, live school scope, PENDING-only effects and authorized replay', async () => {
  const f = fixture(); const { ids, state, db, input } = f; let authenticated = true;
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
  const module = await Test.createTestingModule({ controllers: [TestingCandidateController], providers: [TestingCandidateService, TestingHumanUiGuard, { provide: RuntimeDatabaseService, useValue: db }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate: c => { if (!authenticated) throw new UnauthorizedException(); c.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-subject' }; return true; } }).compile();
  const app = module.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  try {
    await app.listen(0, '127.0.0.1'); const base = `http://127.0.0.1:${app.getHttpServer().address().port}/organizations/${ids.organizationId}/schools/${ids.schoolId}/testing/events/${ids.testingEventId}/candidates`;
    const headers = { Origin: 'https://hon.test', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'testing', 'Idempotency-Key': randomUUID() };
    const post = (body = input, patch = {}, url = base) => fetch(url, { method: 'POST', headers: { ...headers, ...patch }, body: JSON.stringify(body) });
    let first;
    for (const replayed of [false, true]) {
      const response = await post(); assert.equal(response.status, replayed ? 200 : 201); const receipt = await response.json();
      assert.deepEqual(Object.keys(receipt).sort(), ['data', 'meta']); assert.equal(receipt.meta.replayed, replayed); assert.equal(receipt.meta.requestId, receipt.meta.correlationId);
      assert.equal(receipt.data.result, 'PENDING'); assert.equal(receipt.data.version, 1); assert.equal(receipt.data.instructorNotes, 'PRIVATE_NOTE'); assert.equal(receipt.data.testingEventId, ids.testingEventId); assert.equal(receipt.data.studentCurriculumEnrollmentId, ids.studentCurriculumEnrollmentId); assert.equal(receipt.data.targetRankId, ids.targetRankId);
      assert.doesNotMatch(JSON.stringify(receipt), /actor|authority|audit|outbox|eligibility|capacity|promotion|certificate/); if (first) assert.deepEqual(receipt.data, first); first = receipt.data;
    }
    assert.equal(state.candidates.length, 1);
    for (const table of ['testing_candidates', 'audit_events', 'outbox_events']) assert.equal(state.sql.filter(([sql]) => sql.includes(`INSERT INTO hon.${table}`)).length, 1);
    const before = state.contexts.length;
    for (const field of ['organizationId', 'schoolId', 'principalId', 'source', 'principalType', 'actionRequestId', 'delegatedByPrincipalId', 'result', 'testingEventId', 'studentProfileId', 'expectedVersion', 'eligible']) assert.equal((await post({ ...input, [field]: ids.principalId })).status, 400);
    for (const patch of [{ targetRankId: 'Name' }, { studentCurriculumEnrollmentId: 'Name' }, { instructorNotes: 'x'.repeat(2001) }, { instructorNotes: 42 }]) assert.equal((await post({ ...input, ...patch })).status, 400);
    for (const patch of [{ Origin: 'https://evil.test' }, { Origin: '' }, { 'X-HON-Human-Command': 'testing-registration' }, { 'X-HON-Human-Command': '' }, { 'Content-Type': 'text/plain' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await post(input, patch)).status, 403);
    for (const key of ['', 'x'.repeat(201)]) assert.equal((await post(input, { 'Idempotency-Key': key })).status, 409);
    for (const id of [ids.organizationId, ids.schoolId, ids.testingEventId]) assert.equal((await post(input, {}, base.replace(id, 'Name'))).status, 400);
    assert.equal(state.contexts.length, before);
    assert.equal((await fetch(base)).status, 404); // No candidate read/list route was added.
    authenticated = false; assert.equal((await post()).status, 401); authenticated = true;
    state.allowed = false; assert.equal((await post()).status, 403); assert.equal(state.contexts.length, before); state.allowed = true;
    assert.equal((await post(input, {}, base.replace(ids.organizationId, randomUUID()))).status, 403); assert.equal(state.contexts.length, before);
    state.transactionAllowed = false; assert.equal((await post()).status, 403); state.transactionAllowed = true; // Locked live authority is checked even on replay.
    const rank = f.records.get(ids.targetRankId); f.records.delete(ids.targetRankId); assert.equal((await post()).status, 404); f.records.set(ids.targetRankId, rank);
    f.records.set(ids.targetRankId, { ...rank, curriculumId: randomUUID() }); assert.equal((await post()).status, 400); f.records.set(ids.targetRankId, rank);
    assert.equal((await post({ ...input, instructorNotes: 'Changed' })).status, 409); // Same key, changed fingerprint.
    const duplicate = await post(input, { 'Idempotency-Key': randomUUID() }); assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).code, 'TESTING_CANDIDATE_ALREADY_REGISTERED');
    assert.equal(state.candidates.length, 1); assert.equal(state.commands.size, 1);
    assert(state.scopes.every(args => JSON.stringify(args) === JSON.stringify(['verified-subject', ids.schoolId, 'testing.manage'])));
    const sql = state.sql.map(([sql]) => sql).join('\n');
    assert.match(sql, /FROM hon.student_curriculum_enrollments[\s\S]*FOR SHARE/); assert.match(sql, /FROM hon.testing_candidates[\s\S]*FOR KEY SHARE/); assert.match(sql, /pg_advisory_xact_lock/);
    assert.doesNotMatch(sql, /INSERT INTO hon\.(?:promotion|testing_candidate_grades|testing_scorecards|testing_certificates|class_bookings|attendance|invoices|payments|communication|action_requests)|UPDATE hon\.student_curriculum_enrollments/);
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});

test('unchanged canonical register rejects non-direct actors, invalid input and missing identity before mutation', async () => {
  const f = fixture(); const service = new TestingCandidateService(f.db);
  for (const patch of [{ principalType: 'AI_AGENT' }, { principalType: 'SERVICE_ACCOUNT' }, { source: 'AI_ACTION' }, { source: 'API' }, { actionRequestId: randomUUID() }, { delegatedByPrincipalId: randomUUID() }]) await assert.rejects(service.register({ ...f.context, ...patch }, f.ids.testingEventId, f.input), e => e.getStatus() === 403);
  for (const input of [{ ...f.input, targetRankId: 'Name' }, { ...f.input, studentCurriculumEnrollmentId: 'Name' }, { ...f.input, instructorNotes: 'x'.repeat(2001) }]) await assert.rejects(service.register(f.context, f.ids.testingEventId, input), e => e.getStatus() === 400);
  const controller = new TestingCandidateController(f.db, service); await assert.rejects(controller.register(f.ids.organizationId, f.ids.schoolId, f.ids.testingEventId, randomUUID(), f.input, {}, { status() {} }), e => e.getStatus() === 403);
  assert.equal(f.state.contexts.length, 0); assert.equal(f.state.scopes.length, 0);
});

test('canonical register rechecks each scoped dependency and same-curriculum integrity before reservations and returns only inert PENDING evidence', async () => {
  for (const field of ['testingEventId', 'studentCurriculumEnrollmentId', 'targetRankId']) {
    const f = fixture(); f.records.delete(f.ids[field]); await assert.rejects(new TestingCandidateService(f.db).register(f.context, f.ids.testingEventId, f.input), e => e.getStatus() === 404);
    assert.equal(f.state.commands.size, 0); assert.equal(f.state.candidates.length, 0); assert(!f.state.sql.some(([sql]) => /INSERT INTO/.test(sql)));
  }
  for (const field of ['testingEventId', 'studentCurriculumEnrollmentId', 'targetRankId']) {
    const f = fixture(); f.records.set(f.ids[field], { id: f.ids[field], curriculumId: randomUUID() }); await assert.rejects(new TestingCandidateService(f.db).register(f.context, f.ids.testingEventId, f.input), e => e.getStatus() === 400);
    assert.equal(f.state.commands.size, 0); assert.equal(f.state.candidates.length, 0);
  }
  const f = fixture(); const service = new TestingCandidateService(f.db);
  const receipt = await service.register(f.context, f.ids.testingEventId, { ...f.input, instructorNotes: ' \n\t ' }); assert.equal(receipt.candidate.result, 'PENDING'); assert.equal(receipt.candidate.version, 1); assert(!Object.hasOwn(receipt.candidate, 'instructorNotes'));
  const inserts = f.state.sql.filter(([sql]) => /INSERT INTO/.test(sql)).map(([sql]) => /INSERT INTO hon\.([a-z_]+)/.exec(sql)[1]); assert.deepEqual(inserts, ['idempotency_records', 'testing_candidates', 'audit_events', 'outbox_events']);
});

test('existing in-progress idempotency and mapped transaction errors never return a success receipt', async () => {
  const f = fixture(); const service = new TestingCandidateService(f.db); await service.register(f.context, f.ids.testingEventId, f.input);
  f.state.commands.set(f.context.idempotencyKey, { ...f.state.commands.get(f.context.idempotencyKey), status: 'IN_PROGRESS', response_body: null });
  await assert.rejects(service.register(f.context, f.ids.testingEventId, f.input), e => e.getStatus() === 409 && e.getResponse().code === 'IDEMPOTENCY_IN_PROGRESS');
  for (const [code, status] of [['42501', 403], ['23503', 400], ['23505', 409], ['40001', 409], ['40P01', 409], ['55P03', 409], ['57014', 503]]) {
    const fake = { withTenantTransaction: async () => { throw Object.assign(new Error('SQL_SECRET'), { code }); } };
    await assert.rejects(new TestingCandidateService(fake).register(f.context, f.ids.testingEventId, f.input), e => e.getStatus() === status && !JSON.stringify(e.getResponse()).includes('SQL_SECRET'));
  }
});

test('canonical source still owns testing.manage, direct human commands, tenant/RLS dependencies and unique rechecks with no eligibility or executor', () => {
  const controller = readFileSync('src/testing/testing-candidate.controller.ts', 'utf8'); const service = readFileSync('src/testing/testing-candidate.service.ts', 'utf8');
  const register = service.slice(service.indexOf('  async register('), service.indexOf('  async grade('));
  assert.match(controller, /@UseGuards\(HonIdentityGuard, TestingHumanUiGuard\)/); assert.match(controller, /'testing.manage'/); assert.match(service, /this\.database\.withTenantTransaction/); assert.match(service, /lock_human_testing_authority/); assert.match(service, /context\.actionRequestId \|\| context\.delegatedByPrincipalId/);
  assert.match(register, /testingEvent\.curriculumId !== enrollment\.curriculumId/); assert.match(register, /testingEvent\.curriculumId !== targetRank\.curriculumId/); assert.match(register, /TESTING_CANDIDATE_ALREADY_REGISTERED/); assert.match(register, /'PENDING'::hon.testing_candidate_result/);
  assert.doesNotMatch(register, /invokeLLM|executeAction|sendMessage|providerClient|fetch\(|\.grade\(|\.promote\(|\.issue\(/);
});
