const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { HqSchoolLifecycleController, HqSchoolLifecycleHumanGuard, HqSchoolLifecycleService } = require('../dist/hq/hq-school-lifecycle.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { validateHqSchoolLifecycleInput, validateHqSchoolLifecycleReceipt, validateHqSchoolArchiveDates, hqSchoolLifecycleActionsFor } = require('@hon/contracts');

const school = randomUUID();
const receipt = (over = {}) => ({ schoolId: school, action: 'PAUSE', schoolStatus: 'SUSPENDED', organizationStatus: 'SUSPENDED', eraseAfter: null, replayed: false, ...over });
const status = expected => error => error.getStatus?.() === expected;

test('lifecycle contract: only allowed action/status pairs, typed name only for archive, closed fields', () => {
  assert.deepEqual(validateHqSchoolLifecycleInput({ action: 'PAUSE', expectedStatus: 'ACTIVE' }), { action: 'PAUSE', expectedStatus: 'ACTIVE' });
  assert.deepEqual(validateHqSchoolLifecycleInput({ action: 'ARCHIVE', expectedStatus: 'SUSPENDED', confirmName: 'Harbor' }), { action: 'ARCHIVE', expectedStatus: 'SUSPENDED', confirmName: 'Harbor' });
  for (const body of [
    { action: 'PAUSE', expectedStatus: 'SUSPENDED' }, { action: 'RESUME', expectedStatus: 'ACTIVE' }, { action: 'RESTORE', expectedStatus: 'ACTIVE' },
    { action: 'ARCHIVE', expectedStatus: 'ARCHIVED', confirmName: 'x' }, { action: 'ARCHIVE', expectedStatus: 'ACTIVE' }, { action: 'ARCHIVE', expectedStatus: 'ACTIVE', confirmName: '' },
    { action: 'PAUSE', expectedStatus: 'ACTIVE', confirmName: 'x' }, { action: 'DELETE', expectedStatus: 'ACTIVE' }, { action: 'PAUSE', expectedStatus: 'ACTIVE', organizationId: school },
    null, [], 'PAUSE',
  ]) assert.throws(() => validateHqSchoolLifecycleInput(body));
  assert.deepEqual(hqSchoolLifecycleActionsFor('ACTIVE'), ['PAUSE', 'ARCHIVE']);
  assert.deepEqual(hqSchoolLifecycleActionsFor('SUSPENDED'), ['RESUME', 'ARCHIVE']);
  assert.deepEqual(hqSchoolLifecycleActionsFor('ARCHIVED'), ['RESTORE']);
  assert.deepEqual(validateHqSchoolLifecycleReceipt(receipt()), receipt());
  assert.deepEqual(validateHqSchoolLifecycleReceipt(receipt({ action: 'ARCHIVE', schoolStatus: 'ARCHIVED', eraseAfter: '2026-12-24T05:00:00.000Z' })).eraseAfter, '2026-12-24T05:00:00.000Z');
  assert.throws(() => validateHqSchoolLifecycleReceipt(receipt({ action: 'ARCHIVE', schoolStatus: 'ARCHIVED' })));
  assert.throws(() => validateHqSchoolLifecycleReceipt({ ...receipt(), email: 'private' }));
  assert.deepEqual(validateHqSchoolArchiveDates({ archives: [] }), { archives: [] });
  assert.throws(() => validateHqSchoolArchiveDates({ archives: [{ schoolId: school, archivedAt: 'x', eraseAfter: 'y' }] }));
});

test('service passes only validated input and redacts database failures', async () => {
  const calls = []; const key = randomUUID();
  const service = new HqSchoolLifecycleService({ transitionSchoolLifecycleFromHq: async (...args) => { calls.push(args); return receipt(); } });
  assert.deepEqual(await service.transition('verified-human', school.toUpperCase(), { action: 'PAUSE', expectedStatus: 'ACTIVE' }, key), receipt());
  assert.deepEqual(calls[0].slice(0, 4), ['verified-human', school, { action: 'PAUSE', expectedStatus: 'ACTIVE' }, key]);
  await assert.rejects(() => service.transition('verified-human', school, { action: 'PAUSE', expectedStatus: 'ACTIVE' }, 'not-a-key'), status(400));
  for (const [code, message, http, expected] of [
    ['42501', 'x', 403, 'HQ_SCHOOL_LIFECYCLE_FORBIDDEN'], ['P0002', 'x', 404, 'HQ_SCHOOL_LIFECYCLE_UNAVAILABLE'],
    ['40001', 'HQ_SCHOOL_LIFECYCLE_STATUS_CONFLICT', 409, 'HQ_SCHOOL_LIFECYCLE_STATUS_CONFLICT'], ['40001', 'HQ_SCHOOL_LIFECYCLE_BILLING_ACTIVE', 409, 'HQ_SCHOOL_LIFECYCLE_BILLING_ACTIVE'],
    ['23505', 'x', 409, 'IDEMPOTENCY_KEY_REUSED'], ['55P03', 'x', 409, 'HQ_SCHOOL_LIFECYCLE_OUTCOME_UNKNOWN'],
    ['22023', 'HQ_SCHOOL_LIFECYCLE_NAME_MISMATCH', 400, 'HQ_SCHOOL_LIFECYCLE_NAME_MISMATCH'], ['22023', 'x', 400, 'INVALID_HQ_SCHOOL_LIFECYCLE_INPUT'], ['XX000', 'x', 503, 'HQ_SCHOOL_LIFECYCLE_UNAVAILABLE'],
  ]) {
    const failing = new HqSchoolLifecycleService({ transitionSchoolLifecycleFromHq: async () => { throw Object.assign(new Error(`${message} private-school-SQL`), { code }); } });
    await assert.rejects(() => failing.transition('verified-human', school, { action: 'PAUSE', expectedStatus: 'ACTIVE' }, key),
      error => status(http)(error) && error.getResponse().code === expected && !JSON.stringify(error.getResponse()).includes('private-school'));
  }
  const drift = new HqSchoolLifecycleService({ transitionSchoolLifecycleFromHq: async () => ({ ...receipt(), email: 'private' }) });
  await assert.rejects(() => drift.transition('verified-human', school, { action: 'PAUSE', expectedStatus: 'ACTIVE' }, key), status(503));
});

test('POST lifecycle route requires identity and a same-origin human JSON command with key', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = [];
  const module = await Test.createTestingModule({ controllers: [HqSchoolLifecycleController], providers: [HqSchoolLifecycleService, HqSchoolLifecycleHumanGuard,
    { provide: RuntimeDatabaseService, useValue: { transitionSchoolLifecycleFromHq: async (...args) => { calls.push(args); return receipt(); }, readHqSchoolArchiveDates: async () => ({ archives: [] }) } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  const root = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/hq`;
  const base = `${root}/schools/${school}/lifecycle`;
  const headers = { 'content-type': 'application/json', origin: 'https://hon.example', 'x-hon-human-command': 'hq-school-lifecycle', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty', 'idempotency-key': randomUUID() };
  const command = (extra = {}, body = { action: 'PAUSE', expectedStatus: 'ACTIVE' }, url = base) => new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', headers: { ...headers, ...extra } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.end(JSON.stringify(body));
  });
  try {
    const ok = await command(); assert.equal(ok.status, 200); assert.match(ok.headers['cache-control'], /no-store/); assert.deepEqual(JSON.parse(ok.body), { data: receipt() });
    for (const extra of [{ origin: 'https://attacker.example' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-user': '?1' }, { 'x-hon-human-command': 'hq-school-provisioning' }, { 'x-hon-principal-type': 'HUMAN_USER' }, { 'content-type': 'text/plain' }, { authorization: 'Bearer x' }]) {
      assert.equal((await command(extra)).status, 403, JSON.stringify(extra));
    }
    assert.equal((await command({ 'idempotency-key': 'nope' })).status, 409);
    for (const body of [{ action: 'ARCHIVE', expectedStatus: 'ACTIVE' }, { action: 'PAUSE', expectedStatus: 'ACTIVE', schoolId: school }]) assert.equal((await command({}, body)).status, 400);
    assert.equal((await command({}, undefined, base + '?as=owner')).status, 400);
    assert.equal((await command({}, undefined, base.replace(school, 'not-a-uuid'))).status, 400);
    assert.equal(calls.length, 1);
    const archives = await fetch(`${root}/school-archives`); assert.equal(archives.status, 200); assert.deepEqual(await archives.json(), { data: { archives: [] } });
    assert.equal((await fetch(`${root}/school-archives?school=${school}`)).status, 400);
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});

test('database path calls one fixed function in a transaction and rolls back on failure', async () => {
  const database = new RuntimeDatabaseService(); database.assertRuntimePosture = async () => {};
  let fail = false; const seen = [];
  database.getPool = () => ({ connect: async () => ({ query: async (sql, args) => { seen.push([sql, args]); if (sql.startsWith('SELECT hon.transition')) { if (fail) throw Object.assign(new Error('x'), { code: '40001' }); return { rows: [{ data: receipt() }] }; } return { rows: [] }; }, release() { seen.push(['release']); } }) });
  const key = randomUUID();
  await database.transitionSchoolLifecycleFromHq('verified-human', school, { action: 'ARCHIVE', expectedStatus: 'ACTIVE', confirmName: 'Harbor' }, key, randomUUID(), randomUUID());
  assert.equal(seen[0][0], 'BEGIN'); assert.match(seen[2][0], /^SELECT hon\.transition_school_lifecycle_from_hq/); assert.deepEqual(seen[2][1].slice(0, 6), ['verified-human', school, 'ARCHIVE', 'ACTIVE', 'Harbor', key]); assert.equal(seen[3][0], 'COMMIT');
  assert(seen.every(([sql]) => !/(set_config|UPDATE |INSERT )/.test(sql ?? '')));
  seen.length = 0; fail = true;
  await assert.rejects(() => database.transitionSchoolLifecycleFromHq('verified-human', school, { action: 'PAUSE', expectedStatus: 'ACTIVE' }, key, randomUUID(), randomUUID()), e => e.code === '40001');
  assert.deepEqual(seen.slice(-2).map(([sql]) => sql), ['ROLLBACK', 'release']);
  assert.equal(seen.find(([sql]) => sql?.startsWith('SELECT hon.transition'))[1][4], null);
});
