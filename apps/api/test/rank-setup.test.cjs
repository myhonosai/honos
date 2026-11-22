const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { RankSetupService, rankSetupDatabaseError } = require('../dist/curriculum/rank-setup.service.js');
const { RankSetupHumanUiGuard } = require('../dist/curriculum/rank-setup.controller.js');
const { isValidRankSetupInput, verifyStaffRankSetup, verifyRankSetupProgram } = require('@hon/contracts');

const c = () => ({ organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID(), requestId: randomUUID(), correlationId: randomUUID(),
  externalSubject: 'synthetic-human', principalType: 'HUMAN_USER', source: 'HUMAN_UI', idempotencyKey: randomUUID() });
const rank = (patch = {}) => ({ id: randomUUID(), name: 'White', color: '#FFFFFF', order: 1, version: 1, classes: 0, days: 0, students: 0, requirements: [], ...patch });
const program = (patch = {}) => ({ id: randomUUID(), name: 'Kids Taekwondo', version: 1, ranks: [rank(), rank({ name: 'Yellow', color: null, order: 2 })], ...patch });

test('closed command inputs per operation', () => {
  for (const [op, input] of [['PROGRAM_CREATE', { name: 'Kids Taekwondo' }], ['PROGRAM_RENAME', { expectedVersion: 1, name: 'Little Dragons' }],
    ['RANK_ADD', { name: 'White', color: '#ffffff', classes: 0, days: 0 }], ['RANK_ADD', { name: 'Green', color: null, classes: 2000, days: 3650 }],
    ['RANK_UPDATE', { expectedVersion: 2, name: 'Orange', color: '#F97316', classes: 48, days: 90 }], ['RANK_REMOVE', { expectedVersion: 3 }],
    ['PROGRAM_SETUP', { name: 'Adult BJJ', ranks: [{ name: 'White', color: '#FFFFFF', classes: 40, days: 120 }, { name: 'Blue', color: null, classes: 0, days: 0 }] }],
    ['PROGRAM_SETUP', { name: 'Big', ranks: Array.from({ length: 60 }, (_, i) => ({ name: `Belt ${i}`, color: null, classes: 0, days: 0 })) }],
    ['RANK_MOVE', { expectedVersion: 1, direction: 'UP' }], ['RANK_MOVE', { expectedVersion: 1, direction: 'DOWN' }]]) assert.ok(isValidRankSetupInput(op, input), `${op} ${JSON.stringify(input)}`);
  for (const [op, input] of [['PROGRAM_CREATE', { name: '' }], ['PROGRAM_CREATE', { name: ' padded' }], ['PROGRAM_CREATE', { name: 'a<b' }], ['PROGRAM_CREATE', { name: 'x'.repeat(121) }],
    ['PROGRAM_CREATE', { name: 'A', modelCode: 'LINEAR' }], ['PROGRAM_RENAME', { name: 'A' }], ['PROGRAM_RENAME', { expectedVersion: 0, name: 'A' }],
    ['RANK_ADD', { name: 'White' }], ['RANK_ADD', { name: 'White', color: 'white', classes: 0, days: 0 }], ['RANK_ADD', { name: 'White', color: '#fff', classes: 0, days: 0 }],
    ['RANK_ADD', { name: 'White', color: null }], ['RANK_ADD', { name: 'White', color: null, classes: 2001, days: 0 }], ['RANK_ADD', { name: 'White', color: null, classes: 0, days: 3651 }],
    ['RANK_ADD', { name: 'White', color: null, classes: 1.5, days: 0 }], ['RANK_ADD', { name: 'White', color: null, classes: -1, days: 0 }], ['RANK_ADD', { name: 'White', color: null, classes: '4', days: 0 }],
    ['RANK_UPDATE', { name: 'White', color: null, classes: 0, days: 0 }], ['RANK_REMOVE', {}], ['RANK_REMOVE', { expectedVersion: 1, name: 'White' }],
    ['PROGRAM_SETUP', { name: 'A' }], ['PROGRAM_SETUP', { name: 'A', ranks: [] }], ['PROGRAM_SETUP', { name: 'A', ranks: [{ name: 'White', color: null }] }],
    ['PROGRAM_SETUP', { name: 'A', ranks: [{ name: 'White', color: null, classes: 0, days: 0, fee: 5 }] }],
    ['PROGRAM_SETUP', { name: 'A', ranks: [{ name: 'White', color: null, classes: 0, days: 0 }, { name: 'WHITE', color: null, classes: 0, days: 0 }] }],
    ['PROGRAM_SETUP', { name: 'A', ranks: Array.from({ length: 61 }, (_, i) => ({ name: `Belt ${i}`, color: null, classes: 0, days: 0 })) }], ['RANK_MOVE', { expectedVersion: 1, direction: 'LEFT' }], ['RANK_MOVE', { expectedVersion: '1', direction: 'UP' }],
    ['UNKNOWN', {}], ['RANK_ADD', null], ['RANK_ADD', []]]) assert.equal(isValidRankSetupInput(op, input), false, `${op} ${JSON.stringify(input)}`);
});

test('service refuses non-human contexts, wrong targets and missing keys before database access', async () => {
  let calls = 0; const service = new RankSetupService({ withTenantTransaction: () => { calls += 1; throw new Error('unexpected'); } });
  for (const patch of [{ principalType: 'AI_EMPLOYEE' }, { source: 'AI' }, { actionRequestId: randomUUID() }, { delegatedByPrincipalId: randomUUID() }, { schoolId: 'school' }]) {
    await assert.rejects(() => service.command({ ...c(), ...patch }, 'PROGRAM_CREATE', null, null, { name: 'A' }), (e) => e.getStatus() === 403);
    await assert.rejects(() => service.read({ ...c(), ...patch }), (e) => e.getStatus() === 403);
  }
  await assert.rejects(() => service.command({ ...c(), idempotencyKey: '' }, 'PROGRAM_CREATE', null, null, { name: 'A' }), (e) => e.getStatus() === 400);
  await assert.rejects(() => service.command(c(), 'PROGRAM_CREATE', randomUUID(), null, { name: 'A' }), (e) => e.getStatus() === 400);
  await assert.rejects(() => service.command(c(), 'RANK_ADD', null, null, { name: 'A', color: null, classes: 0, days: 0 }), (e) => e.getStatus() === 400);
  await assert.rejects(() => service.command(c(), 'RANK_UPDATE', randomUUID(), null, { expectedVersion: 1, name: 'A', color: null, classes: 0, days: 0 }), (e) => e.getStatus() === 400);
  await assert.rejects(() => service.command(c(), 'RANK_ADD', randomUUID(), randomUUID(), { name: 'A', color: null, classes: 0, days: 0 }), (e) => e.getStatus() === 400);
  await assert.rejects(() => service.command(c(), 'RANK_MOVE', 'program', randomUUID(), { expectedVersion: 1, direction: 'UP' }), (e) => e.getStatus() === 400);
  await assert.rejects(() => service.command(c(), 'PROGRAM_SETUP', randomUUID(), null, { name: 'A', ranks: [{ name: 'White', color: null, classes: 0, days: 0 }] }), (e) => e.getStatus() === 400);
  await assert.rejects(() => service.command(c(), 'RANK_REMOVE', randomUUID(), null, { expectedVersion: 1 }), (e) => e.getStatus() === 400);
  assert.equal(calls, 0);
});

test('a receipt for another program is refused', async () => {
  const other = program();
  const service = new RankSetupService({ withTenantTransaction: (_c, work) => work({ query: async (text) => text.startsWith('SELECT hon.mutate_rank_setup') ? { rows: [{ data: { record: other, replayed: false } }] } : { rows: [] } }) });
  await assert.rejects(() => service.command(c(), 'RANK_ADD', randomUUID(), null, { name: 'Blue', color: null, classes: 0, days: 0 }), /another program/);
  const ok = await service.command(c(), 'PROGRAM_CREATE', null, null, { name: 'Kids Taekwondo' });
  assert.equal(ok.record.id, other.id);
});

test('database errors map to exact codes', () => {
  const code = (e) => { try { rankSetupDatabaseError(e); } catch (x) { return [x.getStatus(), x.getResponse().code]; } };
  assert.deepEqual(code({ code: '23505', message: 'PROGRAM_NAME_TAKEN' }), [409, 'PROGRAM_NAME_TAKEN']);
  assert.deepEqual(code({ code: '23505', message: 'RANK_NAME_TAKEN' }), [409, 'RANK_NAME_TAKEN']);
  assert.deepEqual(code({ code: '55000', message: 'RANK_AT_END' }), [409, 'RANK_AT_END']);
  assert.deepEqual(code({ code: '55000', message: 'RANK_IN_USE' }), [409, 'RANK_IN_USE']);
  assert.deepEqual(code({ code: '22023', message: 'RANK_LIMIT' }), [400, 'RANK_LIMIT']);
  assert.deepEqual(code({ code: '22023', message: 'PROGRAM_LIMIT' }), [400, 'PROGRAM_LIMIT']);
  assert.deepEqual(code({ code: '23505', message: 'IDEMPOTENCY_KEY_REUSED' }), [409, 'IDEMPOTENCY_KEY_REUSED']);
  assert.deepEqual(code({ code: '40001', message: 'VERSION_CONFLICT' }), [409, 'VERSION_CONFLICT']);
  assert.deepEqual(code({ code: '42501', message: 'CURRICULUM_FORBIDDEN' }), [403, 'RANK_SETUP_FORBIDDEN']);
  assert.deepEqual(code({ code: 'P0002', message: 'RANK_NOT_FOUND' }), [404, 'RANK_SETUP_TARGET_NOT_FOUND']);
  assert.deepEqual(code({ code: '22023', message: 'VALIDATION_FAILED' }), [400, 'VALIDATION_FAILED']);
  assert.throws(() => rankSetupDatabaseError(new Error('boom')), /boom/);
});

test('read verifier: closed shape, ordered belts, safe colors, students tied to a listed program', () => {
  const p = program();
  const view = verifyStaffRankSetup({ programs: [p], students: [{ enrollmentId: randomUUID(), programId: p.id, studentProfileId: randomUUID(), givenName: 'Ana', familyName: 'Sample', currentRankId: p.ranks[0].id, version: 1 }] });
  assert.equal(view.programs[0].ranks.length, 2);
  assert.equal(verifyStaffRankSetup({ programs: [], students: null }).students, null);
  for (const bad of [{ programs: [p] }, { programs: [p], students: null, extra: 1 }, { programs: [program({ ranks: [rank({ order: 2 }), rank({ order: 1 })] })], students: null },
    { programs: [program({ ranks: [rank({ color: 'red' })] })], students: null }, { programs: [program({ name: '<script>' })], students: null },
    { programs: [p], students: [{ enrollmentId: randomUUID(), programId: randomUUID(), studentProfileId: randomUUID(), givenName: 'Ana', familyName: 'S', currentRankId: null, version: 1 }] },
    { programs: [program({ ranks: [rank({ requirements: [{ id: randomUUID(), code: 'kick', kind: 'TECHNIQUE', label: 'Kick', description: '', required: true, version: 1 }] })] })], students: null }]) {
    assert.throws(() => verifyStaffRankSetup(bad), /could not be verified/, JSON.stringify(bad).slice(0, 120));
  }
  assert.throws(() => verifyRankSetupProgram({ ...p, extra: true }), /could not be verified/);
});

test('human UI guard: own command, same origin, no selectors or delegated headers', () => {
  const old = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://school.example';
  try {
    const guard = new RankSetupHumanUiGuard();
    const ctx = (r) => ({ switchToHttp: () => ({ getRequest: () => ({ method: 'POST', originalUrl: '/v1/staff/schools/x/rank-setup/programs', query: {},
      headers: { origin: 'https://school.example', 'x-hon-human-command': 'rank-setup', 'content-type': 'application/json', cookie: 'a=b', 'sec-fetch-site': 'same-origin', ...r.headers }, ...r }) }) });
    assert.equal(guard.canActivate(ctx({})), true);
    assert.throws(() => guard.canActivate(ctx({ headers: { 'x-hon-human-command': 'parent-app-curriculum' } })), (e) => e.getStatus() === 403);
    assert.throws(() => guard.canActivate(ctx({ headers: { origin: 'https://evil.example' } })), (e) => e.getStatus() === 403);
    assert.throws(() => guard.canActivate(ctx({ headers: { 'x-hon-action-request-id': randomUUID() } })), (e) => e.getStatus() === 403);
    assert.throws(() => guard.canActivate(ctx({ headers: { 'sec-fetch-site': 'cross-site' } })), (e) => e.getStatus() === 403);
    assert.throws(() => guard.canActivate(ctx({ originalUrl: '/v1/staff/schools/x/rank-setup?school=y', query: { school: 'y' } })), (e) => e.getStatus() === 400);
    assert.equal(guard.canActivate(ctx({ method: 'GET', body: {}, headers: { 'x-hon-human-command': undefined } })), true);
  } finally { process.env.HON_PUBLIC_ORIGIN = old; }
});
