const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
require('reflect-metadata');
const { ValidationPipe, UnauthorizedException } = require('@nestjs/common');
const { Test } = require('@nestjs/testing');
const { PromotionDecisionController } = require('../dist/testing/promotion-decision.controller.js');
const { PromotionDecisionService } = require('../dist/testing/promotion-decision.service.js');
const { TestingHumanUiGuard } = require('../dist/testing/testing-human-ui.guard.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');

function fingerprint(candidateId, input) {
  return createHash('sha256').update(JSON.stringify({ candidateId, ...input })).digest('hex');
}

function fixture() {
  const [organizationId, schoolId, principalId, candidateId, enrollmentId, targetRankId, priorRankId] = Array.from({ length: 7 }, randomUUID);
  const ids = { organizationId, schoolId, principalId, candidateId, enrollmentId, targetRankId, priorRankId };
  const state = {
    allowed: true,
    transactionAllowed: true,
    recordAllowed: true,
    enrollmentRace: false,
    scopes: [],
    contexts: [],
    sql: [],
    effects: [],
    commands: new Map(),
    decision: null,
    candidate: { id: candidateId, studentCurriculumEnrollmentId: enrollmentId, targetRankId, result: 'PASSED', version: 3 },
    enrollment: { id: enrollmentId, curriculumId: 'curriculum-a', currentRankId: priorRankId, version: 5 },
    ranks: new Map([[targetRankId, { id: targetRankId, curriculumId: 'curriculum-a' }], [priorRankId, { id: priorRankId, curriculumId: 'curriculum-a' }]]),
  };
  const db = {
    resolveAuthorizedScope: async (...args) => {
      state.scopes.push(args);
      return state.allowed ? { organizationId, schoolId, principalId } : null;
    },
    withTenantTransaction: async (context, work) => {
      state.contexts.push(context);
      assert.equal(context.organizationId, organizationId);
      assert.equal(context.schoolId, schoolId);
      assert.equal(context.principalId, principalId);
      assert.equal(context.principalType, 'HUMAN_USER');
      assert.equal(context.source, 'HUMAN_UI');
      assert.equal(context.actionRequestId, undefined);
      assert.equal(context.delegatedByPrincipalId, undefined);
      assert.equal(context.requestId, context.correlationId);
      const commands = new Map(state.commands);
      const effects = [...state.effects];
      let decision = state.decision && { ...state.decision };
      let enrollment = state.enrollment && { ...state.enrollment };
      const result = await work({ query: async (sql, params = []) => {
        state.sql.push([sql, params]);
        if (sql.includes('set_config')) {
          assert.match(sql, /app\.hon_source','HUMAN_UI'/);
          assert.match(sql, /app\.hon_delegated_by_principal_id',''/);
          return { rows: [], rowCount: 0 };
        }
        if (sql.startsWith('SET LOCAL')) return { rows: [], rowCount: 0 };
        if (sql.includes('lock_human_testing_authority')) {
          assert.deepEqual(params, ['testing.promotion.decide']);
          if (!state.transactionAllowed) throw Object.assign(new Error('SQL_SECRET'), { code: '42501' });
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('lock_human_testing_record')) {
          assert.deepEqual(params, ['testing.promotion.decide', params[1], params[2]]);
          if (!state.recordAllowed) throw Object.assign(new Error('SQL_SECRET'), { code: '42501' });
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('FROM hon.testing_candidates')) {
          const candidate = state.candidate?.id === params[0] ? state.candidate : null;
          return { rows: candidate ? [candidate] : [], rowCount: candidate ? 1 : 0 };
        }
        if (sql.includes('FROM hon.student_curriculum_enrollments')) {
          const row = enrollment?.id === params[0] ? enrollment : null;
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }
        if (sql.includes('FROM hon.curriculum_ranks')) {
          const rank = state.ranks.get(params[0]);
          return { rows: rank ? [rank] : [], rowCount: rank ? 1 : 0 };
        }
        if (sql.includes('INSERT INTO hon.idempotency_records')) {
          assert.deepEqual(params.slice(0, 4), [organizationId, schoolId, principalId, context.idempotencyKey]);
          if (commands.has(context.idempotencyKey)) return { rows: [], rowCount: 0 };
          commands.set(context.idempotencyKey, { request_fingerprint: params[4], status: 'IN_PROGRESS', response_body: null });
          return { rows: [{ id: randomUUID() }], rowCount: 1 };
        }
        if (sql.includes('SELECT request_fingerprint')) {
          assert.deepEqual(params, [organizationId, schoolId, principalId, context.idempotencyKey]);
          return { rows: [commands.get(context.idempotencyKey)], rowCount: 1 };
        }
        if (sql.includes('FROM hon.promotion_decisions')) {
          return { rows: decision ? [{ id: decision.id }] : [], rowCount: decision ? 1 : 0 };
        }
        if (sql.includes('UPDATE hon.student_curriculum_enrollments')) {
          assert.match(sql, /version = version \+ 1/);
          assert.equal(params[0], enrollmentId);
          assert.equal(params[1], targetRankId);
          assert.equal(params[2], enrollment.version);
          if (state.enrollmentRace || !enrollment || enrollment.version !== params[2]) return { rows: [], rowCount: 0 };
          enrollment = { ...enrollment, currentRankId: params[1], version: enrollment.version + 1 };
          effects.push('enrollment');
          return { rows: [{ currentRankId: enrollment.currentRankId, version: enrollment.version }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO hon.promotion_decisions')) {
          assert.equal(params[2], candidateId);
          assert.equal(params[3], enrollmentId);
          assert.equal(params[4], priorRankId);
          assert.equal(params[5], targetRankId);
          assert.equal(params[6], 'PROMOTED');
          assert.equal(params[7], principalId);
          assert.equal(params[8], 'PRIVATE_RATIONALE');
          decision = {
            id: randomUUID(),
            testingCandidateId: candidateId,
            studentCurriculumEnrollmentId: enrollmentId,
            priorRankId: params[4],
            targetRankId,
            status: params[6],
            instructorPrincipalId: principalId,
            rationale: params[8],
            decidedAt: new Date('2026-10-17T00:00:00Z'),
            version: 1,
            createdAt: new Date('2026-10-17T00:00:00Z'),
          };
          effects.push('promotion-decision');
          return { rows: [decision], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO hon.audit_events')) {
          assert.match(sql, /'testing\.promotion\.decide', 'PROMOTION_DECISION'/);
          assert.equal(params[3], decision.id);
          const prior = JSON.parse(params[4]);
          const next = JSON.parse(params[5]);
          assert.equal(prior.candidateVersion, state.candidate.version);
          assert.equal(next.promotionDecisionId, decision.id);
          effects.push('audit');
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO hon.outbox_events')) {
          assert.match(sql, /'testing\.promotion\.decided'/);
          assert.equal(params[3], decision.id);
          assert.equal(JSON.parse(params[7]).promotionDecisionId, decision.id);
          effects.push('inert-outbox');
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('UPDATE hon.idempotency_records')) {
          const prior = commands.get(context.idempotencyKey);
          commands.set(context.idempotencyKey, { ...prior, status: 'COMPLETED', response_body: JSON.parse(params[4]) });
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected SQL outside promotion-decision boundary: ${sql}`);
      } });
      state.commands = commands;
      state.decision = decision;
      state.enrollment = enrollment;
      state.effects = effects;
      return result;
    },
  };
  const context = { organizationId, schoolId, principalId, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: '', idempotencyKey: randomUUID() };
  context.correlationId = context.requestId;
  return { ids, state, db, context, input: { expectedVersion: 3, status: 'PROMOTED', rationale: '  PRIVATE_RATIONALE  ' } };
}

const expected = (status, code) => error => {
  assert.equal(error.getStatus(), status, error.stack);
  if (code) assert.equal(error.getResponse().code, code);
  return true;
};

test('promotion-decision HTTP accepts the closed expectedVersion command, commits once, and replays only the exact fingerprint', async () => {
  const f = fixture();
  const { ids, state, db, input } = f;
  let authenticated = true;
  const previous = process.env.HON_PUBLIC_ORIGIN;
  process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
  const module = await Test.createTestingModule({
    controllers: [PromotionDecisionController],
    providers: [PromotionDecisionService, TestingHumanUiGuard, { provide: RuntimeDatabaseService, useValue: db }],
  }).overrideGuard(HonIdentityGuard).useValue({
    canActivate: context => {
      if (!authenticated) throw new UnauthorizedException();
      context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-subject' };
      return true;
    },
  }).compile();
  const app = module.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  try {
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}/organizations/${ids.organizationId}/schools/${ids.schoolId}/testing/candidates/${ids.candidateId}/promotion-decision`;
    const key = randomUUID();
    const headers = { Origin: 'https://hon.test', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'testing', 'Idempotency-Key': key };
    const post = (body = input, patch = {}, url = base) => fetch(url, { method: 'POST', headers: { ...headers, ...patch }, body: JSON.stringify(body) });
    const first = await post();
    assert.equal(first.status, 201);
    const firstReceipt = await first.json();
    assert.deepEqual(Object.keys(firstReceipt).sort(), ['data', 'meta']);
    assert.deepEqual(Object.keys(firstReceipt.meta).sort(), ['correlationId', 'replayed', 'requestId']);
    assert.equal(firstReceipt.meta.replayed, false);
    assert.equal(firstReceipt.data.testingCandidateId, ids.candidateId);
    assert.equal(firstReceipt.data.status, 'PROMOTED');
    assert.equal(firstReceipt.data.rationale, 'PRIVATE_RATIONALE');
    assert.equal(firstReceipt.data.version, 1);
    assert.deepEqual(state.effects, ['enrollment', 'promotion-decision', 'audit', 'inert-outbox']);
    assert.equal(state.commands.size, 1);
    const stored = state.commands.get(key);
    const normalized = { expectedVersion: 3, status: 'PROMOTED', rationale: 'PRIVATE_RATIONALE' };
    assert.equal(stored.request_fingerprint, fingerprint(ids.candidateId, normalized));
    assert.notEqual(stored.request_fingerprint, fingerprint(ids.candidateId, { status: normalized.status, rationale: normalized.rationale }));

    const replay = await post();
    assert.equal(replay.status, 200);
    const replayReceipt = await replay.json();
    assert.equal(replayReceipt.meta.replayed, true);
    assert.deepEqual(replayReceipt.data, firstReceipt.data);
    assert.deepEqual(state.effects, ['enrollment', 'promotion-decision', 'audit', 'inert-outbox']);
    assert.equal(state.candidate.version, 3);

    state.candidate.version = 4;
    const changedExpected = await post({ ...input, expectedVersion: 4 });
    assert.equal(changedExpected.status, 409);
    assert.equal((await changedExpected.json()).code, 'IDEMPOTENCY_KEY_REUSED');
    assert.deepEqual(state.effects, ['enrollment', 'promotion-decision', 'audit', 'inert-outbox']);
    assert.equal(state.commands.size, 1);

    const contextsBeforeRejection = state.contexts.length;
    for (const body of [
      { status: input.status, rationale: input.rationale },
      { ...input, expectedVersion: 0 },
      { ...input, expectedVersion: -1 },
      { ...input, expectedVersion: 1.1 },
      { ...input, expectedVersion: '3' },
      { ...input, expectedVersion: null },
      { ...input, expectedVersion: true },
      { ...input, expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
      { ...input, unexpectedExpectedVersion: 3 },
      { ...input, actor: ids.principalId },
    ]) assert.equal((await post(body, { 'Idempotency-Key': randomUUID() })).status, 400);
    assert.equal(state.contexts.length, contextsBeforeRejection);

    for (const patch of [{ Origin: 'https://evil.test' }, { 'X-HON-Human-Command': 'testing-registration' }, { 'Content-Type': 'text/plain' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await post(input, patch)).status, 403);
    for (const id of [ids.organizationId, ids.schoolId, ids.candidateId]) assert.equal((await post(input, {}, base.replace(id, 'Name'))).status, 400);
    authenticated = false;
    assert.equal((await post()).status, 401);
    authenticated = true;
    state.allowed = false;
    assert.equal((await post()).status, 403);
    state.allowed = true;
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN;
    else process.env.HON_PUBLIC_ORIGIN = previous;
  }
});

test('stale expected candidate version fails before enrollment, decision, idempotency, audit, or outbox mutation', async () => {
  const f = fixture();
  f.state.candidate.version = 4;
  await assert.rejects(
    new PromotionDecisionService(f.db).decide(f.context, f.ids.candidateId, f.input),
    expected(409, 'VERSION_CONFLICT'),
  );
  assert.equal(f.state.commands.size, 0);
  assert.deepEqual(f.state.effects, []);
  const sql = f.state.sql.map(([sql]) => sql).join('\n');
  assert.match(sql, /FROM hon\.testing_candidates/);
  assert.doesNotMatch(sql, /FROM hon\.student_curriculum_enrollments|FROM hon\.curriculum_ranks|INSERT INTO hon\.promotion_decisions|INSERT INTO hon\.idempotency_records|INSERT INTO hon\.audit_events|INSERT INTO hon\.outbox_events|UPDATE hon\.student_curriculum_enrollments/);
});

test('promotion decision rejects nonhuman/delegated contexts and invalid versions before tenant work', async () => {
  const f = fixture();
  const service = new PromotionDecisionService(f.db);
  for (const patch of [{ principalType: 'AI_AGENT' }, { principalType: 'SERVICE_ACCOUNT' }, { source: 'AI_ACTION' }, { source: 'API' }, { actionRequestId: randomUUID() }, { delegatedByPrincipalId: randomUUID() }]) {
    await assert.rejects(service.decide({ ...f.context, ...patch }, f.ids.candidateId, f.input), expected(403));
  }
  for (const patch of [{ expectedVersion: 0 }, { expectedVersion: -1 }, { expectedVersion: 1.1 }, { expectedVersion: '3' }, { expectedVersion: Infinity }, { expectedVersion: Number.MAX_SAFE_INTEGER + 1 }]) {
    await assert.rejects(service.decide(f.context, f.ids.candidateId, { ...f.input, ...patch }), expected(400, 'VALIDATION_FAILED'));
  }
  await assert.rejects(service.decide(f.context, 'Name', f.input), expected(400, 'VALIDATION_FAILED'));
  assert.equal(f.state.contexts.length, 0);
  assert.equal(f.state.scopes.length, 0);
});

test('canonical promotion-decision source retains expected candidate concurrency before dependent writes and has no alternative authority path', () => {
  const controller = readFileSync('src/testing/promotion-decision.controller.ts', 'utf8');
  const dto = readFileSync('src/testing/decide-promotion.dto.ts', 'utf8');
  const service = readFileSync('src/testing/promotion-decision.service.ts', 'utf8');
  const decide = service.slice(service.indexOf('  async decide('), service.indexOf('  private assertCandidateDecisionCoherency('));
  assert.match(dto, /@IsInt\(\)\s+@Min\(1\)\s+expectedVersion!:\s*number/);
  assert.match(controller, /expected[\s*]+candidate version, final decision, and instructor's rationale/);
  assert.match(decide, /JSON\.stringify\(\{ candidateId, \.\.\.normalized \}\)/);
  const versionCheck = decide.indexOf('candidate.version !== normalized.expectedVersion');
  assert(versionCheck > -1);
  for (const later of ['FROM hon.student_curriculum_enrollments', 'INSERT INTO hon.idempotency_records', 'INSERT INTO hon.promotion_decisions', 'INSERT INTO hon.audit_events', 'INSERT INTO hon.outbox_events']) assert(versionCheck < decide.indexOf(later), `${later} must follow the candidate version check`);
  assert.match(decide, /code: 'VERSION_CONFLICT'/);
  assert.match(decide, /lock_human_testing_record/);
  assert.doesNotMatch(controller, /client\.query|executeAction|invokeLLM|provider|payment|source:\s*input|principalId:\s*input/);
});
