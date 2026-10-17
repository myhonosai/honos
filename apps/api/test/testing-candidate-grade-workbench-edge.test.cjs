const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
require('reflect-metadata');
const { ValidationPipe, UnauthorizedException } = require('@nestjs/common');
const { Test } = require('@nestjs/testing');
const { TestingCandidateGradeController } = require('../dist/testing/testing-candidate-grade.controller.js');
const { TestingCandidateService } = require('../dist/testing/testing-candidate.service.js');
const { TestingHumanUiGuard } = require('../dist/testing/testing-human-ui.guard.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');

function fixture() {
  const [organizationId, schoolId, principalId, candidateId, testingEventId, studentCurriculumEnrollmentId, targetRankId] = Array.from({ length: 7 }, randomUUID);
  const ids = { organizationId, schoolId, principalId, candidateId, testingEventId, studentCurriculumEnrollmentId, targetRankId };
  const state = { allowed: true, transactionAllowed: true, recordAllowed: true, updateRace: false, scopes: [], contexts: [], sql: [], effects: [], commands: new Map(),
    candidate: { id: candidateId, testingEventId, studentCurriculumEnrollmentId, targetRankId, result: 'PENDING', instructorNotes: 'OLD_NOTE', version: 3, createdAt: new Date('2026-10-16T12:00:00Z') } };
  const db = {
    resolveAuthorizedScope: async (...args) => { state.scopes.push(args); return state.allowed ? { organizationId, schoolId, principalId } : null; },
    withTenantTransaction: async (context, work) => {
      state.contexts.push(context);
      assert.equal(context.organizationId, organizationId); assert.equal(context.schoolId, schoolId); assert.equal(context.principalId, principalId);
      assert.equal(context.principalType, 'HUMAN_USER'); assert.equal(context.source, 'HUMAN_UI'); assert.equal(context.actionRequestId, undefined); assert.equal(context.delegatedByPrincipalId, undefined); assert.equal(context.requestId, context.correlationId);
      // Effects/reservations commit only after the transaction callback succeeds.
      const commands = new Map(state.commands); const effects = [...state.effects]; let candidate = state.candidate && { ...state.candidate };
      const result = await work({ query: async (sql, params = []) => {
        state.sql.push([sql, params]);
        if (sql.includes('set_config')) { assert.match(sql, /app.hon_source','HUMAN_UI'/); assert.match(sql, /app.hon_delegated_by_principal_id',''/); return { rows: [], rowCount: 0 }; }
        if (sql.startsWith('SET LOCAL')) return { rows: [], rowCount: 0 };
        if (sql.includes('lock_human_testing_authority')) { assert.deepEqual(params, ['testing.manage']); if (!state.transactionAllowed) throw Object.assign(new Error('SQL_SECRET'), { code: '42501' }); return { rows: [], rowCount: 0 }; }
        if (sql.includes('lock_human_testing_record')) { assert.deepEqual(params, ['testing.manage', 'CANDIDATE', params[2]]); if (!state.recordAllowed) throw Object.assign(new Error('SQL_SECRET'), { code: '42501' }); return { rows: [], rowCount: 0 }; }
        if (sql.includes('FROM hon.testing_candidates')) { const found = candidate?.id === params[0] ? candidate : null; return { rows: found ? [found] : [], rowCount: found ? 1 : 0 }; }
        if (sql.includes('INSERT INTO hon.idempotency_records')) {
          assert.deepEqual(params.slice(0, 4), [organizationId, schoolId, principalId, context.idempotencyKey]);
          if (commands.has(context.idempotencyKey)) return { rows: [], rowCount: 0 };
          commands.set(context.idempotencyKey, { request_fingerprint: params[4], status: 'IN_PROGRESS', response_body: null }); return { rows: [{ id: randomUUID() }], rowCount: 1 };
        }
        if (sql.includes('SELECT request_fingerprint')) { assert.deepEqual(params, [organizationId, schoolId, principalId, context.idempotencyKey]); return { rows: [commands.get(context.idempotencyKey)], rowCount: 1 }; }
        if (sql.includes('UPDATE hon.testing_candidates')) {
          assert.match(sql, /version = version \+ 1/); assert.match(sql, /AND version = \$4/); assert.equal(params[0], candidateId);
          if (state.updateRace || !candidate || candidate.version !== params[3]) return { rows: [], rowCount: 0 };
          candidate = { ...candidate, result: params[1], instructorNotes: params[2], version: candidate.version + 1 }; effects.push('candidate'); return { rows: [candidate], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO hon.audit_events')) {
          assert.match(sql, /'testing.candidate.grade', 'TESTING_CANDIDATE'/); assert.match(sql, /NULL, now\(\)/); assert.equal(params[3], 'HUMAN_UI'); assert.equal(params[4], candidateId);
          const prior = JSON.parse(params[5]); const next = JSON.parse(params[6]); assert.equal(next.version, prior.version + 1); assert.equal(next.result, candidate.result); assert.equal(next.gradedByPrincipalId, principalId); effects.push('audit'); return { rows: [], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO hon.outbox_events')) { assert.match(sql, /'testing.candidate.graded'/); assert.equal(JSON.parse(params[7]).result, candidate.result); assert.equal(params[4], candidate.version); effects.push('inert-outbox'); return { rows: [], rowCount: 1 }; }
        if (sql.includes('UPDATE hon.idempotency_records')) { assert.equal(params[4], 200); const prior = commands.get(context.idempotencyKey); commands.set(context.idempotencyKey, { ...prior, status: 'COMPLETED', response_body: JSON.parse(params[5]) }); return { rows: [], rowCount: 1 }; }
        throw new Error(`Unexpected SQL outside candidate outcome boundary: ${sql}`);
      } });
      state.commands = commands; state.candidate = candidate; state.effects = effects; return result;
    },
  };
  const context = { organizationId, schoolId, principalId, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: '', idempotencyKey: randomUUID() }; context.correlationId = context.requestId;
  return { ids, state, db, context, input: { result: 'PASSED', instructorNotes: '  PRIVATE_NOTE  ', expectedVersion: 3 } };
}

test('existing grade HTTP controller preserves testing human guard, closed DTO, current exact school scope, 200 snapshots and no-effect replay', async () => {
  const f = fixture(); const { ids, state, db, input } = f; let authenticated = true;
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
  const module = await Test.createTestingModule({ controllers: [TestingCandidateGradeController], providers: [TestingCandidateService, TestingHumanUiGuard, { provide: RuntimeDatabaseService, useValue: db }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate: c => { if (!authenticated) throw new UnauthorizedException(); c.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-subject' }; return true; } }).compile();
  const app = module.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  try {
    await app.listen(0, '127.0.0.1'); const base = `http://127.0.0.1:${app.getHttpServer().address().port}/organizations/${ids.organizationId}/schools/${ids.schoolId}/testing/candidates/${ids.candidateId}/grade`;
    const headers = { Origin: 'https://hon.test', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'testing', 'Idempotency-Key': randomUUID() };
    const post = (body = input, patch = {}, url = base) => fetch(url, { method: 'POST', headers: { ...headers, ...patch }, body: JSON.stringify(body) });
    let first;
    for (const replayed of [false, true]) {
      const response = await post(); assert.equal(response.status, 200); const receipt = await response.json();
      assert.deepEqual(Object.keys(receipt).sort(), ['data', 'meta']); assert.deepEqual(Object.keys(receipt.meta).sort(), ['correlationId', 'replayed', 'requestId']); assert.equal(receipt.meta.replayed, replayed); assert.equal(receipt.meta.requestId, receipt.meta.correlationId);
      assert.deepEqual(Object.keys(receipt.data).sort(), ['createdAt', 'id', 'instructorNotes', 'result', 'studentCurriculumEnrollmentId', 'targetRankId', 'testingEventId', 'version']);
      assert.equal(receipt.data.id, ids.candidateId); assert.equal(receipt.data.result, 'PASSED'); assert.equal(receipt.data.version, 4); assert.equal(receipt.data.instructorNotes, 'PRIVATE_NOTE');
      assert.doesNotMatch(JSON.stringify(receipt), /actor|authority|audit|outbox|eligibility|promotion|certificate/); if (first) assert.deepEqual(receipt.data, first); first = receipt.data;
    }
    assert.deepEqual(state.effects, ['candidate', 'audit', 'inert-outbox']); assert.equal(state.commands.size, 1);
    const before = state.contexts.length;
    for (const field of ['organizationId', 'schoolId', 'principalId', 'source', 'principalType', 'actionRequestId', 'delegatedByPrincipalId', 'candidateId', 'testingEventId', 'scorecardId', 'score', 'eligible', 'promotionDecision']) assert.equal((await post({ ...input, [field]: ids.principalId })).status, 400);
    for (const patch of [{ result: 'PENDING' }, { result: 'passed' }, { result: 'READY' }, { result: null }, { expectedVersion: 0 }, { expectedVersion: -1 }, { expectedVersion: 1.1 }, { expectedVersion: '3' }, { expectedVersion: null }, { expectedVersion: true }, { instructorNotes: 'x'.repeat(2001) }, { instructorNotes: 42 }]) assert.equal((await post({ ...input, ...patch })).status, 400);
    for (const field of ['result', 'expectedVersion']) { const body = { ...input }; delete body[field]; assert.equal((await post(body)).status, 400); }
    for (const patch of [{ Origin: 'https://evil.test' }, { Origin: '' }, { 'X-HON-Human-Command': 'testing-registration' }, { 'X-HON-Human-Command': 'testing, testing' }, { 'X-HON-Human-Command': '' }, { 'Content-Type': 'text/plain' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await post(input, patch)).status, 403);
    for (const key of ['', 'x'.repeat(201)]) assert.equal((await post(input, { 'Idempotency-Key': key })).status, 409);
    for (const id of [ids.organizationId, ids.schoolId, ids.candidateId]) assert.equal((await post(input, {}, base.replace(id, 'Name'))).status, 400);
    assert.equal(state.contexts.length, before); assert.equal((await fetch(base)).status, 404); assert.equal((await fetch(base.replace('/grade', ''))).status, 404);
    delete process.env.HON_PUBLIC_ORIGIN; assert.equal((await post()).status, 503); process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
    authenticated = false; assert.equal((await post()).status, 401); authenticated = true;
    state.allowed = false; assert.equal((await post()).status, 403); state.allowed = true;
    for (const id of [ids.organizationId, ids.schoolId]) assert.equal((await post(input, {}, base.replace(id, randomUUID()))).status, 403);
    assert.equal(state.contexts.length, before);
    state.transactionAllowed = false; assert.equal((await post()).status, 403); state.transactionAllowed = true;
    state.recordAllowed = false; assert.equal((await post()).status, 403); state.recordAllowed = true;
    const saved = state.candidate; state.candidate = null; assert.equal((await post()).status, 404); state.candidate = saved;
    for (const patch of [{ result: 'DEFERRED' }, { instructorNotes: 'Changed' }, { expectedVersion: 4 }]) { const r = await post({ ...input, ...patch }); assert.equal(r.status, 409); assert.equal((await r.json()).code, 'IDEMPOTENCY_KEY_REUSED'); }
    const stale = await post(input, { 'Idempotency-Key': randomUUID() }); assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'VERSION_CONFLICT');
    const unsafe = await post({ ...input, expectedVersion: Number.MAX_SAFE_INTEGER + 1 }, { 'Idempotency-Key': randomUUID() }); assert.equal(unsafe.status, 400);
    const next = await post({ result: 'DEFERRED', expectedVersion: 4 }, { 'Idempotency-Key': randomUUID() }); assert.equal(next.status, 200); const nextReceipt = await next.json(); assert.equal(nextReceipt.data.version, 5); assert(!Object.hasOwn(nextReceipt.data, 'instructorNotes'));
    const replay = await post(); assert.equal(replay.status, 200); const replayReceipt = await replay.json(); assert.equal(replayReceipt.meta.replayed, true); assert.deepEqual(replayReceipt.data, first); assert.equal(state.candidate.version, 5);
    assert.deepEqual(state.effects, ['candidate', 'audit', 'inert-outbox', 'candidate', 'audit', 'inert-outbox']); assert.equal(state.commands.size, 2);
    assert(state.scopes.every(args => args[0] === 'verified-subject' && args[2] === 'testing.manage'));
    const sql = state.sql.map(([sql]) => sql).join('\n'); assert.doesNotMatch(sql, /INSERT INTO hon\.(?:promotion|testing_candidate_grades|testing_scorecards|testing_certificates|class_bookings|attendance|invoices|payments|communication|action_requests)|UPDATE hon\.student_curriculum_enrollments/);
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});

test('grade service rejects non-direct/delegated actors and invalid versions/results/candidate IDs before tenant work; controller requires identity', async () => {
  const f = fixture(); const service = new TestingCandidateService(f.db);
  for (const patch of [{ principalType: 'AI_AGENT' }, { principalType: 'SERVICE_ACCOUNT' }, { source: 'AI_ACTION' }, { source: 'API' }, { actionRequestId: randomUUID() }, { delegatedByPrincipalId: randomUUID() }]) await assert.rejects(service.grade({ ...f.context, ...patch }, f.ids.candidateId, f.input), e => e.getStatus() === 403);
  for (const patch of [{ result: 'PENDING' }, { result: 'passed' }, { result: null }, { expectedVersion: 0 }, { expectedVersion: -1 }, { expectedVersion: 1.1 }, { expectedVersion: '3' }, { expectedVersion: Infinity }, { expectedVersion: Number.MAX_SAFE_INTEGER + 1 }, { instructorNotes: 'x'.repeat(2001) }]) await assert.rejects(service.grade(f.context, f.ids.candidateId, { ...f.input, ...patch }), e => e.getStatus() === 400);
  await assert.rejects(service.grade(f.context, 'Name', f.input), e => e.getStatus() === 400);
  await assert.rejects(new TestingCandidateGradeController(f.db, service).grade(f.ids.organizationId, f.ids.schoolId, f.ids.candidateId, randomUUID(), f.input, {}, { status() {} }), e => e.getStatus() === 403);
  assert.equal(f.state.contexts.length, 0); assert.equal(f.state.scopes.length, 0);
});

test('all four grade results replace notes and increment only candidate evidence once; replay rechecks authority and candidate before idempotency', async () => {
  for (const result of ['PASSED', 'DEFERRED', 'NOT_PASSED', 'WITHDRAWN']) for (const note of ['  PRIVATE_NOTE  ', ' \n\t ', undefined]) {
    const f = fixture(); const service = new TestingCandidateService(f.db); const input = { result, expectedVersion: 3, ...(note === undefined ? {} : { instructorNotes: note }) };
    const first = await service.grade(f.context, f.ids.candidateId, input); assert.equal(first.replayed, false); assert.equal(first.candidate.result, result); assert.equal(first.candidate.version, 4);
    assert.equal(first.candidate.instructorNotes, note?.trim() || undefined); assert.deepEqual(f.state.effects, ['candidate', 'audit', 'inert-outbox']);
    const before = f.state.sql.length; const replay = await service.grade(f.context, f.ids.candidateId, input); assert.equal(replay.replayed, true); assert.deepEqual(replay.candidate, first.candidate); assert.deepEqual(f.state.effects, ['candidate', 'audit', 'inert-outbox']);
    const sql = f.state.sql.slice(before).map(([sql]) => sql).join('\n'); assert(sql.indexOf('lock_human_testing_authority') < sql.indexOf('lock_human_testing_record')); assert(sql.indexOf('FROM hon.testing_candidates') < sql.indexOf('INSERT INTO hon.idempotency_records')); assert.doesNotMatch(sql, /UPDATE hon.testing_candidates|INSERT INTO hon.audit_events|INSERT INTO hon.outbox_events/);
  }
});

test('stale versions, update races, absent tenant candidate, in-progress keys and mapped database failures never commit outcome/audit/outbox success', async () => {
  for (const [setup, status, code] of [[f => { f.state.candidate.version = 4; }, 409, 'VERSION_CONFLICT'], [f => { f.state.updateRace = true; }, 409, 'VERSION_CONFLICT'], [f => { f.state.candidate = null; }, 404, undefined], [f => { f.state.transactionAllowed = false; }, 403, 'TESTING_FORBIDDEN'], [f => { f.state.recordAllowed = false; }, 403, 'TESTING_FORBIDDEN']]) {
    const f = fixture(); setup(f); await assert.rejects(new TestingCandidateService(f.db).grade(f.context, f.ids.candidateId, f.input), e => e.getStatus() === status && (!code || e.getResponse().code === code)); assert.equal(f.state.commands.size, 0); assert.deepEqual(f.state.effects, []);
  }
  const f = fixture(); const service = new TestingCandidateService(f.db); await service.grade(f.context, f.ids.candidateId, f.input);
  f.state.commands.set(f.context.idempotencyKey, { ...f.state.commands.get(f.context.idempotencyKey), status: 'IN_PROGRESS', response_body: null });
  await assert.rejects(service.grade(f.context, f.ids.candidateId, f.input), e => e.getStatus() === 409 && e.getResponse().code === 'IDEMPOTENCY_IN_PROGRESS'); assert.deepEqual(f.state.effects, ['candidate', 'audit', 'inert-outbox']);
  for (const [code, status] of [['42501', 403], ['23503', 400], ['23505', 409], ['40001', 409], ['40P01', 409], ['55P03', 409], ['57014', 503]]) {
    const fake = { withTenantTransaction: async () => { throw Object.assign(new Error('SQL_SECRET'), { code }); } };
    await assert.rejects(new TestingCandidateService(fake).grade(f.context, f.ids.candidateId, f.input), e => e.getStatus() === status && !JSON.stringify(e.getResponse()).includes('SQL_SECRET'));
  }
});

test('canonical grade source retains direct human testing.manage, RLS/locked scope, conditional versions and only inert candidate outcome effects', () => {
  const controller = readFileSync('src/testing/testing-candidate-grade.controller.ts', 'utf8'); const service = readFileSync('src/testing/testing-candidate.service.ts', 'utf8');
  const grade = service.slice(service.indexOf('  async grade('), service.indexOf('  private requireHuman('));
  assert.match(controller, /@UseGuards\(HonIdentityGuard, TestingHumanUiGuard\)/); assert.match(controller, /'testing.manage'/); assert.match(controller, /scope.organizationId !== organizationId \|\| scope.schoolId !== schoolId/);
  assert.match(grade, /this\.database\.withTenantTransaction/); assert.match(grade, /this.requireAuthority/); assert.match(grade, /lock_human_testing_record/); assert.match(grade, /normalized.expectedVersion !== currentRow.version/); assert.match(grade, /AND version = \$4/); assert.match(service, /context.actionRequestId \|\| context.delegatedByPrincipalId/);
  assert.doesNotMatch(controller, /client.query|\.register\(|\.decide\(|\.promote\(|\.issue\(/); assert.doesNotMatch(grade, /invokeLLM|executeAction|sendMessage|providerClient|fetch\(|\.promote\(|\.issue\(|scorecard|promotion_decisions|testing_certificates/);
});
