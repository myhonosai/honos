const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { HqSchoolVisitController, HqSchoolVisitHumanGuard, HqSchoolVisitService } = require('../dist/hq/hq-school-visit.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { validateHqSchoolVisitEnterInput, validateHqSchoolVisitLeaveInput, validateHqSchoolVisitEnterReceipt, validateHqSchoolVisitLeaveReceipt, validateHqSchoolVisits } = require('@hon/contracts');

const school = randomUUID(), org = randomUUID(), visit = randomUUID();
const at = '2026-11-25T16:00:00.000Z', until = '2026-11-25T20:00:00.000Z';
const entered = (over = {}) => ({ visitId: visit, organizationId: org, schoolId: school, action: 'ENTER', startedAt: at, endsAt: until, replayed: false, ...over });
const left = (over = {}) => ({ visitId: visit, schoolId: school, left: true, leftAt: at, replayed: false, ...over });
const status = expected => error => error.getStatus?.() === expected;

test('visit contract: optional short reason, empty leave body, closed receipts', () => {
  assert.deepEqual(validateHqSchoolVisitEnterInput({}), {});
  assert.deepEqual(validateHqSchoolVisitEnterInput({ reason: '  Help with billing setup  ' }), { reason: 'Help with billing setup' });
  assert.deepEqual(validateHqSchoolVisitEnterInput({ reason: '   ' }), {});
  for (const body of [{ reason: 'x'.repeat(301) }, { reason: 'a\nb' }, { reason: 5 }, { schoolId: school }, null, [], 'go']) assert.throws(() => validateHqSchoolVisitEnterInput(body));
  assert.deepEqual(validateHqSchoolVisitLeaveInput({}), {});
  for (const body of [{ reason: 'x' }, null, []]) assert.throws(() => validateHqSchoolVisitLeaveInput(body));
  assert.deepEqual(validateHqSchoolVisitEnterReceipt(entered()), entered());
  assert.deepEqual(validateHqSchoolVisitEnterReceipt(entered({ action: 'EXTEND' })).action, 'EXTEND');
  for (const bad of [entered({ action: 'LEAVE' }), { ...entered(), email: 'private' }, entered({ endsAt: 'soon' })]) assert.throws(() => validateHqSchoolVisitEnterReceipt(bad));
  assert.deepEqual(validateHqSchoolVisitLeaveReceipt(left()), left());
  assert.deepEqual(validateHqSchoolVisitLeaveReceipt({ schoolId: school, left: false, replayed: false }), { schoolId: school, left: false, replayed: false });
  for (const bad of [{ schoolId: school, left: false, replayed: false, visitId: visit }, left({ leftAt: null }), { ...left(), note: 'x' }]) assert.throws(() => validateHqSchoolVisitLeaveReceipt(bad));
  const row = { visitId: visit, organizationId: org, schoolId: school, schoolName: 'Harbor North', startedAt: at, endsAt: until };
  assert.deepEqual(validateHqSchoolVisits({ visits: [row] }), { visits: [row] });
  for (const bad of [{ visits: [{ ...row, email: 'x' }] }, { visits: [{ ...row, schoolName: '' }] }, { visits: {} }, { visits: [], extra: 1 }]) assert.throws(() => validateHqSchoolVisits(bad));
});

test('service passes only validated input and redacts database failures', async () => {
  const calls = []; const key = randomUUID();
  const service = new HqSchoolVisitService({
    enterSchoolAsHq: async (...args) => { calls.push(['enter', ...args]); return entered(); },
    leaveSchoolAsHq: async (...args) => { calls.push(['leave', ...args]); return left(); },
  });
  assert.deepEqual(await service.enter('verified-human', school.toUpperCase(), { reason: ' Setup ' }, key), entered());
  assert.deepEqual(calls[0].slice(0, 5), ['enter', 'verified-human', school, 'Setup', key]);
  assert.deepEqual(await service.enter('verified-human', school, {}, key), entered());
  assert.equal(calls[1][3], null);
  assert.deepEqual(await service.leave('verified-human', school, {}, key), left());
  assert.deepEqual(calls[2].slice(0, 4), ['leave', 'verified-human', school, key]);
  await assert.rejects(() => service.enter('verified-human', school, {}, 'not-a-key'), status(400));
  await assert.rejects(() => service.leave('verified-human', school, { reason: 'x' }, key), status(400));
  for (const [code, http, expected] of [['42501', 403, 'HQ_SCHOOL_VISIT_FORBIDDEN'], ['P0002', 404, 'HQ_SCHOOL_VISIT_UNAVAILABLE'], ['23505', 409, 'IDEMPOTENCY_KEY_REUSED'],
    ['55P03', 409, 'HQ_SCHOOL_VISIT_OUTCOME_UNKNOWN'], ['22023', 400, 'INVALID_HQ_SCHOOL_VISIT_INPUT'], ['XX000', 503, 'HQ_SCHOOL_VISIT_UNAVAILABLE']]) {
    const failing = new HqSchoolVisitService({ enterSchoolAsHq: async () => { throw Object.assign(new Error('private-school-SQL'), { code }); } });
    await assert.rejects(() => failing.enter('verified-human', school, {}, key),
      error => status(http)(error) && error.getResponse().code === expected && !JSON.stringify(error.getResponse()).includes('private-school'));
  }
  const drift = new HqSchoolVisitService({ enterSchoolAsHq: async () => ({ ...entered(), email: 'private' }), readMyHqSchoolVisits: async () => ({ visits: [{ email: 'x' }] }) });
  await assert.rejects(() => drift.enter('verified-human', school, {}, key), status(503));
  await assert.rejects(() => drift.mine('verified-human'), status(503));
});

test('POST enter/leave routes require identity and a same-origin human JSON command with key; GET reads own visits only', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = [];
  const module = await Test.createTestingModule({ controllers: [HqSchoolVisitController], providers: [HqSchoolVisitService, HqSchoolVisitHumanGuard,
    { provide: RuntimeDatabaseService, useValue: {
      enterSchoolAsHq: async (...args) => { calls.push(['enter', ...args]); return entered(); },
      leaveSchoolAsHq: async (...args) => { calls.push(['leave', ...args]); return left(); },
      readMyHqSchoolVisits: async subject => { calls.push(['mine', subject]); return { visits: [] }; } } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  const root = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/hq`;
  const enterUrl = `${root}/schools/${school}/enter`, leaveUrl = `${root}/schools/${school}/leave`;
  const headers = { 'content-type': 'application/json', origin: 'https://hon.example', 'x-hon-human-command': 'hq-school-visit', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty', 'idempotency-key': randomUUID() };
  const command = (url, extra = {}, body = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', headers: { ...headers, ...extra } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.end(JSON.stringify(body));
  });
  try {
    const ok = await command(enterUrl, {}, { reason: 'Setup' }); assert.equal(ok.status, 200); assert.match(ok.headers['cache-control'], /no-store/); assert.deepEqual(JSON.parse(ok.body), { data: entered() });
    const out = await command(leaveUrl); assert.equal(out.status, 200); assert.deepEqual(JSON.parse(out.body), { data: left() });
    for (const extra of [{ origin: 'https://attacker.example' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-user': '?1' }, { 'x-hon-human-command': 'hq-school-lifecycle' }, { 'x-hon-school-id': school }, { 'content-type': 'text/plain' }, { authorization: 'Bearer x' }]) {
      assert.equal((await command(enterUrl, extra)).status, 403, JSON.stringify(extra));
    }
    assert.equal((await command(enterUrl, { 'idempotency-key': 'nope' })).status, 409);
    assert.equal((await command(enterUrl, {}, { reason: 'x', schoolId: school })).status, 400);
    assert.equal((await command(leaveUrl, {}, { reason: 'x' })).status, 400);
    assert.equal((await command(enterUrl + '?as=owner')).status, 400);
    assert.equal((await command(enterUrl.replace(school, 'not-a-uuid'))).status, 400);
    assert.deepEqual(calls.map(c => c[0]), ['enter', 'leave']);
    const mine = await fetch(`${root}/school-visits`); assert.equal(mine.status, 200); assert.deepEqual(await mine.json(), { data: { visits: [] } });
    assert.deepEqual(calls.at(-1), ['mine', 'verified-human']);
    assert.equal((await fetch(`${root}/school-visits?principal=${visit}`)).status, 400);
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});

test('database path calls one fixed function per command in a transaction and rolls back on failure', async () => {
  const database = new RuntimeDatabaseService(); database.assertRuntimePosture = async () => {};
  let fail = false; const seen = [];
  database.getPool = () => ({ connect: async () => ({ query: async (sql, args) => { seen.push([sql, args]); if (sql.startsWith('SELECT hon.')) { if (fail) throw Object.assign(new Error('x'), { code: '42501' }); return { rows: [{ data: sql.includes('enter') ? entered() : sql.includes('leave') ? left() : { visits: [] } }] }; } return { rows: [] }; }, release() { seen.push(['release']); } }) });
  const key = randomUUID();
  await database.enterSchoolAsHq('verified-human', school, 'Setup', key, randomUUID(), randomUUID());
  assert.equal(seen[0][0], 'BEGIN'); assert.match(seen[2][0], /^SELECT hon\.enter_school_as_hq\(/); assert.deepEqual(seen[2][1].slice(0, 4), ['verified-human', school, 'Setup', key]); assert.equal(seen[3][0], 'COMMIT');
  seen.length = 0;
  await database.leaveSchoolAsHq('verified-human', school, key, randomUUID(), randomUUID());
  assert.match(seen[2][0], /^SELECT hon\.leave_school_as_hq\(/);
  seen.length = 0;
  await database.readMyHqSchoolVisits('verified-human');
  assert.match(seen[0][0], /READ ONLY/); assert.match(seen[2][0], /^SELECT hon\.read_my_hq_school_visits\(\$1\)/);
  assert(seen.every(([sql]) => !/(set_config|UPDATE |INSERT )/.test(sql ?? '')));
  seen.length = 0; fail = true;
  await assert.rejects(() => database.enterSchoolAsHq('verified-human', school, null, key, randomUUID(), randomUUID()), e => e.code === '42501');
  assert.deepEqual(seen.slice(-2).map(([sql]) => sql), ['ROLLBACK', 'release']);
});
