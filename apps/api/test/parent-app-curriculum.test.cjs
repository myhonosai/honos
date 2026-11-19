const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { ParentAppCurriculumService, validateParentAppCurriculumInput, parentAppCurriculumDatabaseError } = require('../dist/curriculum/parent-app-curriculum.service.js');
const { ParentAppCurriculumHumanUiGuard } = require('../dist/curriculum/parent-app-curriculum.controller.js');
const { validateLibraryInput } = require('../dist/curriculum/library.dto.js');
const { verifyCurriculumAppState, verifyStaffParentAppCurriculum, verifyCurriculumResourceRecord, isCurriculumAppDate } = require('@hon/contracts');

const c = () => ({ organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID(), requestId: randomUUID(), correlationId: randomUUID(),
  externalSubject: 'synthetic-human', principalType: 'HUMAN_USER', source: 'HUMAN_UI', idempotencyKey: randomUUID() });
const settings = (patch = {}) => ({ expectedVersion: 0, displayMode: 'CYCLE', showInApp: true, rankShowEarlier: false, rankShowNext: false,
  cycleRotation: 'STAFF_PICK', cycleAnchorDate: null, cycleLengthWeeks: null, cycleShowNext: true, ...patch });
const state = (patch = {}) => ({ curriculumId: randomUUID(), settings: { saved: true, version: 2, ...settings(), expectedVersion: undefined },
  cycles: [{ id: randomUUID(), name: 'Cycle 1', position: 1, version: 1 }], cycleState: { today: '2026-11-19', current: null, next: null }, ...patch });
const clean = (s) => { const x = structuredClone(s); delete x.settings.expectedVersion; return x; };

test('closed command inputs per operation', () => {
  validateParentAppCurriculumInput('SAVE_SETTINGS', settings());
  validateParentAppCurriculumInput('SAVE_SETTINGS', settings({ cycleRotation: 'AUTO', cycleAnchorDate: '2026-01-05', cycleLengthWeeks: 4 }));
  validateParentAppCurriculumInput('CYCLE_CREATE', { name: 'Cycle 1: Stances' });
  validateParentAppCurriculumInput('CYCLE_RENAME', { expectedVersion: 1, name: 'Kicks' });
  validateParentAppCurriculumInput('CYCLE_ARCHIVE', { expectedVersion: 3 });
  validateParentAppCurriculumInput('SWITCH_CYCLE', { expectedVersion: 3 });
  validateParentAppCurriculumInput('CYCLE_ORDER', { cycleIds: [randomUUID(), randomUUID()] });
  const id = randomUUID();
  for (const [op, input] of [['SAVE_SETTINGS', settings({ cycleRotation: 'AUTO' })], ['SAVE_SETTINGS', settings({ cycleAnchorDate: '2026-02-30' })],
    ['SAVE_SETTINGS', settings({ cycleLengthWeeks: 27 })], ['SAVE_SETTINGS', settings({ displayMode: 'BELT' })], ['SAVE_SETTINGS', { ...settings(), extra: 1 }],
    ['SAVE_SETTINGS', settings({ showInApp: 'true' })], ['CYCLE_CREATE', { name: ' padded' }], ['CYCLE_CREATE', { name: 'a<b' }], ['CYCLE_CREATE', { name: 'x'.repeat(81) }],
    ['CYCLE_RENAME', { expectedVersion: 0, name: 'x' }], ['CYCLE_ARCHIVE', { expectedVersion: 1, name: 'x' }], ['SWITCH_CYCLE', {}],
    ['CYCLE_ORDER', { cycleIds: [] }], ['CYCLE_ORDER', { cycleIds: [id, id] }], ['CYCLE_ORDER', { cycleIds: ['nope'] }], ['UNKNOWN', {}]]) {
    assert.throws(() => validateParentAppCurriculumInput(op, input), (e) => e.getStatus() === 400, `${op} ${JSON.stringify(input)}`);
  }
});

test('service refuses non-human contexts, bad ids and missing keys before database access', async () => {
  let calls = 0; const service = new ParentAppCurriculumService({ withTenantTransaction: () => { calls += 1; throw new Error('unexpected'); } });
  for (const patch of [{ principalType: 'AI_EMPLOYEE' }, { source: 'AI' }, { actionRequestId: randomUUID() }, { delegatedByPrincipalId: randomUUID() }, { schoolId: 'school' }]) {
    await assert.rejects(() => service.command({ ...c(), ...patch }, 'CYCLE_CREATE', randomUUID(), null, { name: 'A' }), (e) => e.getStatus() === 403);
    await assert.rejects(() => service.read({ ...c(), ...patch }), (e) => e.getStatus() === 403);
  }
  await assert.rejects(() => service.command({ ...c(), idempotencyKey: '' }, 'CYCLE_CREATE', randomUUID(), null, { name: 'A' }), (e) => e.getStatus() === 400);
  await assert.rejects(() => service.command(c(), 'CYCLE_CREATE', 'curriculum', null, { name: 'A' }), (e) => e.getStatus() === 400);
  assert.equal(calls, 0);
});

test('database errors map to exact codes', () => {
  const code = (e) => { try { parentAppCurriculumDatabaseError(e); } catch (x) { return [x.getStatus(), x.getResponse().code]; } };
  assert.deepEqual(code({ code: '55000', message: 'CYCLE_IS_CURRENT' }), [409, 'CYCLE_IS_CURRENT']);
  assert.deepEqual(code({ code: '55000', message: 'SETTINGS_REQUIRED' }), [409, 'SETTINGS_REQUIRED']);
  assert.deepEqual(code({ code: '23505', message: 'CYCLE_NAME_TAKEN' }), [409, 'CYCLE_NAME_TAKEN']);
  assert.deepEqual(code({ code: '23505', message: 'IDEMPOTENCY_KEY_REUSED' }), [409, 'PARENT_APP_CURRICULUM_VERSION_OR_KEY_CONFLICT']);
  assert.deepEqual(code({ code: '22023', message: 'CYCLE_LIMIT' }), [400, 'CYCLE_LIMIT']);
  assert.deepEqual(code({ code: '42501', message: 'CURRICULUM_FORBIDDEN' }), [403, 'PARENT_APP_CURRICULUM_FORBIDDEN']);
  assert.deepEqual(code({ code: 'P0002', message: 'CYCLE_NOT_FOUND' }), [404, 'PARENT_APP_CURRICULUM_TARGET_NOT_FOUND']);
  assert.throws(() => parentAppCurriculumDatabaseError(new Error('boom')), /boom/);
});

test('human UI guard: own command, same origin, no selectors or delegated headers', () => {
  const old = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://school.example';
  const guard = new ParentAppCurriculumHumanUiGuard(); const run = (r) => guard.canActivate({ switchToHttp: () => ({ getRequest: () => r }) });
  try {
    const req = { method: 'POST', headers: { origin: 'https://school.example', 'x-hon-human-command': 'parent-app-curriculum', 'content-type': 'application/json' }, query: {}, originalUrl: '/v1/staff/schools/id/parent-app/curriculum/c/cycles' };
    assert.equal(run(req), true);
    for (const patch of [{ 'x-hon-human-command': 'curriculum-library' }, { origin: 'https://other.example' }, { 'x-hon-source': 'AI' }, { 'x-hon-action-request-id': randomUUID() }, { 'sec-fetch-site': 'cross-site' }])
      assert.throws(() => run({ ...req, headers: { ...req.headers, ...patch } }), (e) => e.getStatus() === 403);
    assert.throws(() => run({ ...req, originalUrl: `${req.originalUrl}?school=x`, query: { school: 'x' } }), (e) => e.getStatus() === 400);
    assert.equal(run({ method: 'GET', headers: {}, query: {}, originalUrl: '/v1/staff/schools/id/parent-app/curriculum' }), true);
  } finally { if (old === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = old; }
});

test('strict response verifiers', () => {
  const good = clean(state());
  assert.equal(verifyCurriculumAppState(good).settings.expectedVersion, 2);
  for (const bad of [{ ...good, extra: 1 }, { ...good, settings: { ...good.settings, saved: false } }, { ...good, cycles: [{ ...good.cycles[0], name: '<x>' }] },
    { ...good, cycleState: { today: '2026-13-01', current: null, next: null } }, { ...good, cycleState: { today: '2026-11-19', current: { id: randomUUID(), name: 'A', startsOn: null }, next: null } },
    { ...good, settings: { ...good.settings, cycleRotation: 'AUTO' } }]) assert.throws(() => verifyCurriculumAppState(bad));
  const curriculumId = good.curriculumId;
  const record = { id: randomUUID(), curriculumId, rankId: null, cycleId: good.cycles[0].id, kind: 'DOCUMENT', url: 'https://drive.google.com/file/d/x', title: 'Handout', description: '', audience: 'PARENT', status: 'ACTIVE', version: 1 };
  assert.equal(verifyCurriculumResourceRecord(record).cycleId, record.cycleId);
  assert.throws(() => verifyCurriculumResourceRecord({ ...record, rankId: randomUUID() }));
  const { cycleId: _drop, ...withoutCycle } = record; assert.throws(() => verifyCurriculumResourceRecord(withoutCycle));
  const page = { timeZone: 'America/Los_Angeles', curricula: [{ id: curriculumId, name: 'Kids', modelCode: 'ROTATIONAL', lifecycle: 'PUBLISHED', ranks: [{ id: randomUUID(), name: 'White', color: '#ffffff', order: 1 }], app: good, resources: [record] }] };
  assert.equal(verifyStaffParentAppCurriculum(page).curricula[0].resources[0].kind, 'DOCUMENT');
  assert.throws(() => verifyStaffParentAppCurriculum({ ...page, curricula: [{ ...page.curricula[0], resources: [{ ...record, curriculumId: randomUUID() }] }] }));
  assert.throws(() => verifyStaffParentAppCurriculum({ ...page, curricula: [{ ...page.curricula[0], app: { ...good, curriculumId: randomUUID() } }] }));
  assert.throws(() => verifyStaffParentAppCurriculum({ ...page, timeZone: '../etc' }));
  assert.equal(isCurriculumAppDate('2028-02-29'), true); assert.equal(isCurriculumAppDate('2027-02-29'), false);
});

test('library create keeps older clients and accepts a cycle or a rank, not both', () => {
  const base = { expectedVersion: 0, curriculumId: randomUUID(), rankId: null, kind: 'DOCUMENT', url: 'https://www.dropbox.com/s/abc/form.pdf', title: 'Form', description: '', audience: 'PARENT' };
  validateLibraryInput('CREATE', base); validateLibraryInput('CREATE', { ...base, cycleId: randomUUID() }); validateLibraryInput('CREATE', { ...base, cycleId: null });
  assert.throws(() => validateLibraryInput('CREATE', { ...base, rankId: randomUUID(), cycleId: randomUUID() }), (e) => e.getStatus() === 400);
  assert.throws(() => validateLibraryInput('CREATE', { ...base, cycleId: 'cycle' }), (e) => e.getStatus() === 400);
  assert.throws(() => validateLibraryInput('CREATE', { ...base, kind: 'PDF' }), (e) => e.getStatus() === 400);
});

test('source boundary: dedicated functions only, no network, AI, outbox or provider', () => {
  const service = readFileSync('src/curriculum/parent-app-curriculum.service.ts', 'utf8');
  assert.match(service, /hon\.read_staff_parent_app_curriculum/); assert.match(service, /hon\.mutate_parent_app_curriculum/);
  assert.doesNotMatch(service, /fetch\(|https?\.request|dns\.|invokeLLM|sendMessage|executeAction|FROM hon\./);
  const sql = readFileSync('../../packages/database/migrations/0587_parent_app_curriculum_cycles.sql', 'utf8');
  assert.doesNotMatch(sql, /INSERT INTO hon\.(outbox_events|action_requests|work_items|communication_messages|ai_invocation_plans)/);
});
