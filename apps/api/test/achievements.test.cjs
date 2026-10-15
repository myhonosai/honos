const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync, readdirSync } = require('node:fs');
const { Test } = require('@nestjs/testing');
const { ValidationPipe, ForbiddenException } = require('@nestjs/common');
const contracts = require('@hon/contracts');
const { AchievementsService } = require('../dist/achievements/achievements.service.js');
const { AchievementsController, ParentAchievementsController } = require('../dist/achievements/achievements.controller.js');
const { AchievementHumanUiGuard } = require('../dist/achievements/achievements.dto.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const student = randomUUID(), family = randomUUID();
const context = (patch = {}) => ({ ...scope, externalSubject: 'verified-human', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID(), ...patch });
const input = (patch = {}) => ({ expectedVersion: 0, name: 'Careful practice', description: 'Recognition of effort.', category: 'EFFORT', ageBand: 'CHILD', visualToken: 'STAR', status: 'ACTIVE', ...patch });
const definition = (patch = {}) => { const { expectedVersion, ...fields } = input(); return { id: randomUUID(), version: 1, ...fields, ...patch }; };
const awardInput = (d, patch = {}) => ({ expectedVersion: 0, definitionId: d.id, definitionVersion: 1, reason: null, awardedOn: '2026-01-10', visibleToFamily: true, status: 'AWARDED', ...patch });
const award = (d, patch = {}) => { const { expectedVersion, ...fields } = awardInput(d); return { id: randomUUID(), version: 1, studentProfileId: student, definition: d, awardedByPrincipalId: scope.principalId, recordedByPrincipalId: scope.principalId, recordedAt: '2026-01-10T12:00:00.000Z', ...fields, ...patch }; };
const denied = (work, status) => assert.rejects(async () => work(), e => e.getStatus() === status);
test('achievement contracts are closed bounded metadata and explicit human decisions, not opaque rules/scoring/readiness', () => {
  contracts.validateAchievementDefinition(input()); contracts.validateAchievementDefinition(input({ visualToken: null, description: '' }));
  for (const patch of [{ name: '' }, { name: ' ' }, { name: 'a'.repeat(101) }, { name: 'Test ready' }, { name: 'Guaranteed promotion' }, { description: 'a'.repeat(601) }, { name: '<script>' }, { name: 'Hidden\u200bname' }, { category: 'POINTS' }, { ageBand: 'ALL_AGES' }, { visualToken: 'https://evil.test' }, { visualToken: {} }, { status: 'ARCHIVED' }, { expectedVersion: 999999998 }, { rules: {} }, { score: 80 }, { readiness: true }, { script: 'x' }, { providerId: randomUUID() }]) assert.throws(() => contracts.validateAchievementDefinition(input(patch)), JSON.stringify(patch));
  const d = definition(), a = award(d); contracts.validateAchievementAward(awardInput(d)); contracts.verifyAchievementAward(a);
  for (const patch of [{ awardedOn: '2026-02-30' }, { awardedOn: '2026-01-10T00:00:00Z' }, { reason: '' }, { reason: 'x'.repeat(1001) }, { visibleToFamily: 'true' }, { status: 'WITHDRAWN' }, { points: 1 }, { studentProfileId: student }, { actionId: randomUUID() }]) assert.throws(() => contracts.validateAchievementAward(awardInput(d, patch)));
  for (const patch of [{ recordedAt: 'not a date' }, { awardedByPrincipalId: 'not an id' }, { recordedByPrincipalId: 'not an id' }, { definitionVersion: 2 }, { definition: { ...d, id: randomUUID() } }, { actorEmail: 'PRIVATE' }, { score: 80 }]) assert.throws(() => contracts.verifyAchievementAward({ ...a, ...patch }));
  const safe = { id: a.id, awardedOn: a.awardedOn, definition: d }; contracts.verifyParentAchievementAward(safe);
  for (const patch of [{ reason: 'PRIVATE' }, { studentProfileId: randomUUID() }, { history: [a] }, { actorPrincipalId: scope.principalId }, { visibleToFamily: false }, { definition: { ...d, privateNote: 'PRIVATE' } }]) assert.throws(() => contracts.verifyParentAchievementAward({ ...safe, ...patch }));
  assert.throws(() => contracts.verifyParentAchievements({ studentProfileId: randomUUID(), items: [safe], nextAfter: null }, student));
  assert.throws(() => contracts.verifyAchievementHistory({ id: a.id, items: [a, a], nextBefore: null }, contracts.verifyAchievementAward));
});
test('achievement service rejects prohibited contexts before any SQL and verifies exact response scope, intent and redaction', async () => {
  let calls = 0, response; const db = { withTenantTransaction: async (c, work) => { calls++; return work({ query: async () => ({ rows: [{ data: response }] }) }); } }; const svc = new AchievementsService(db);
  for (const patch of [{ source: 'AI_TOOL' }, { source: 'PUBLIC_API' }, { principalType: 'AI_EMPLOYEE' }, { principalType: 'AUTOMATION' }, { actionRequestId: randomUUID() }, { delegatedByPrincipalId: randomUUID() }]) await denied(() => svc.access(context(patch)), 403);
  await denied(() => svc.saveDefinition(context(), null, input({ rules: {} })), 400); assert.equal(calls, 0);
  await denied(() => svc.saveDefinition(context({ idempotencyKey: '' }), null, input()), 409);
  const d = definition(), a = award(d); response = { result: d, replayed: false }; assert.deepEqual((await svc.saveDefinition(context(), null, input())).result, d);
  for (const patch of [{ name: 'Changed intent' }, { version: 2 }, { schoolId: scope.schoolId }]) { response = { result: { ...d, ...patch }, replayed: false }; await denied(() => svc.saveDefinition(context(), null, input()), 503); }
  response = { result: a, replayed: false }; assert.deepEqual((await svc.saveAward(context(), student, null, awardInput(d))).result, a);
  response = { items: [{ ...a, studentProfileId: randomUUID() }], nextAfter: null }; await denied(() => svc.awards(context(), student), 503);
  response = { studentProfileId: student, items: [{ id: a.id, awardedOn: a.awardedOn, definition: d, reason: 'PRIVATE' }], nextAfter: null }; await denied(() => svc.parent(context(), family, student), 503);
  db.withTenantTransaction = async () => { throw Object.assign(new Error('PRIVATE DATABASE_URL secret'), { code: 'XX000' }); };
  await assert.rejects(() => svc.access(context()), e => e.getStatus() === 503 && !JSON.stringify(e.getResponse()).includes('PRIVATE'));
  for (const [code, status] of [['42501', 403], ['P0002', 404], ['40001', 409], ['23505', 409], ['55P03', 409], ['22008', 400], ['23514', 400]]) { db.withTenantTransaction = async () => { throw Object.assign(new Error(), { code }); }; await denied(() => svc.access(context()), status); }
});
test('authenticated staff exact-school and parent exact-child HTTP boundaries reject forged authority and all execution routes', async () => {
  let writes = 0, granted = true, parentGranted = true, lastArgs; const d = definition(), a = award(d);
  const flags = { canReadDefinitions: true, canManageDefinitions: true, canReadAwards: true, canRecordAwards: true };
  const db = { resolveAchievementScope: async (subject, school) => granted && subject === 'verified-human' && school === scope.schoolId ? scope : undefined,
    resolveParentFamilyScopes: async () => parentGranted ? [{ ...scope, familyId: family, accessLevel: 'PRIMARY_GUARDIAN' }] : [],
    withTenantTransaction: async (c, work) => work({ query: async (sql, args) => {
      if (sql.includes('mutate_achievements')) { writes++; lastArgs = args; return { rows: [{ data: { result: args[1] === 'DEFINITION' ? d : a, replayed: false } }] }; }
      if (sql.includes('read_parent_achievements')) { lastArgs = args; return { rows: [{ data: { studentProfileId: args[2], items: [{ id: a.id, awardedOn: a.awardedOn, definition: d }], nextAfter: null } }] }; }
      if (sql.includes('read_achievements')) return { rows: [{ data: flags }] }; return { rows: [] };
    } }) };
  const old = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const mod = await Test.createTestingModule({ controllers: [AchievementsController, ParentAchievementsController], providers: [AchievementsService, AchievementHumanUiGuard, { provide: RuntimeDatabaseService, useValue: db }] }).overrideGuard(HonIdentityGuard).useValue({ canActivate(c) { const r = c.switchToHttp().getRequest(); if (r.headers['x-test-human'] !== 'verified') throw new ForbiddenException(); r.honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = mod.createNestApplication(); app.setGlobalPrefix('v1'); app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })); await app.listen(0, '127.0.0.1');
  const root = `http://127.0.0.1:${app.getHttpServer().address().port}/v1`, base = root + '/staff/students/achievements', q = `?schoolId=${scope.schoolId}`;
  const h = { 'x-test-human': 'verified', origin: 'https://hon.example', 'content-type': 'application/json', 'x-hon-human-command': 'student-achievements', 'idempotency-key': randomUUID() };
  try {
    assert.equal((await fetch(base + '/access' + q)).status, 403);
    const good = await fetch(base + '/definitions' + q, { method: 'POST', headers: h, body: JSON.stringify(input()) }); assert.equal(good.status, 200); assert.equal(good.headers.get('cache-control'), 'private, no-store'); assert.equal(writes, 1);
    assert.equal(lastArgs[0], 'verified-human'); assert.equal(lastArgs[2], null);
    for (const patch of [{ origin: 'https://evil.test' }, { 'x-hon-human-command': 'execute' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { 'content-type': 'text/plain' }]) assert.equal((await fetch(base + '/definitions' + q, { method: 'POST', headers: { ...h, ...patch }, body: JSON.stringify(input()) })).status, 403);
    for (const patch of [{ rules: {} }, { organizationId: scope.organizationId }, { actorPrincipalId: scope.principalId }, { name: 'Test ready' }, { provider: {} }]) assert.equal((await fetch(base + '/definitions' + q, { method: 'POST', headers: h, body: JSON.stringify(input(patch)) })).status, 400);
    assert.equal(writes, 1); assert.equal((await fetch(base + '/access' + q + '&organizationId=' + scope.organizationId, { headers: h })).status, 400);
    assert.equal((await fetch(base + `/students/${student}/awards` + q, { method: 'POST', headers: h, body: JSON.stringify(awardInput(d)) })).status, 200); assert.equal(lastArgs[2], student);
    for (const effect of ['execute', 'promote', 'testing-eligibility', 'send', 'pay', 'ai', 'provider', 'feed']) assert.equal((await fetch(base + '/' + effect + q, { method: 'POST', headers: h, body: '{}' })).status, 404);
    const parentUrl = root + `/parent/students/${student}/achievements` + q + '&familyId=' + family;
    const parent = await fetch(parentUrl, { headers: h }); assert.equal(parent.status, 200); assert.equal(parent.headers.get('cache-control'), 'private, no-store'); assert.equal(lastArgs[1], family); assert.equal(lastArgs[2], student); assert(!JSON.stringify(await parent.json()).includes('reason'));
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await fetch(parentUrl, { method, headers: h, body: '{}' })).status, 404);
    assert.equal((await fetch(parentUrl + '&includeReasons=true', { headers: h })).status, 400);
    assert.equal((await fetch(root + `/parent/students/${student}/achievements` + q + '&familyId=' + randomUUID(), { headers: h })).status, 403);
    parentGranted = false; assert.equal((await fetch(parentUrl, { headers: h })).status, 403); granted = false; assert.equal((await fetch(base + '/access' + q, { headers: h })).status, 403);
  } finally { await app.close(); if (old === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = old; }
});
test('achievement code has no provider, AI, action, communications, payments, directory or progression writes', () => {
  const dir = require('node:path').join(__dirname, '../src/achievements'); const code = readdirSync(dir).map(x => readFileSync(require('node:path').join(dir, x), 'utf8')).join('\n');
  for (const pattern of [/fetch\(/, /invokeLLM/, /ActionEngineService/, /executeAction/, /stripe/i, /sendMessage/, /CommunicationMessageService/, /child_process/, /SELECT \* FROM hon\.people/, /UPDATE hon\./]) assert(!pattern.test(code), String(pattern));
  const sql = readFileSync(require('node:path').join(__dirname, '../../../packages/database/migrations/0086_human_student_achievements.sql'), 'utf8');
  const targets = [...sql.matchAll(/(?:INSERT INTO|UPDATE|DELETE FROM) hon\.([a-z_]+)/g)].map(x => x[1]); assert(targets.every(x => x.startsWith('achievement_') || ['permissions', 'role_permissions'].includes(x)), targets.join(','));
  assert(!sql.includes("tier IN")); assert(!sql.includes('INSERT INTO hon.outbox_events')); assert(sql.includes("CHECK(status='INERT')"));
});
