const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { AiSchoolCostLimitHqController, AiSchoolCostLimitService } = require('../dist/ai-spend/ai-school-cost-limit.controller.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

const U = () => randomUUID(), T = '2026-11-01T00:00:00.000Z', T2 = '2026-12-01T00:00:00.000Z';
const REASON = 'Synthetic school ceiling for a fixture';
const D = contracts.AI_SCHOOL_DEFAULT_CEILING_MICROS;
const input = (patch = {}) => ({ schoolId: U(), ceilingMicros: 10_000_000, paused: false, reason: REASON, expectedVersion: 0, ...patch });
const status = (patch = {}) => {
  const s = { schoolId: U(), organizationId: U(), schoolName: 'Synthetic Dojo', ceilingMicros: D, defaultCeiling: true, paused: false, reason: null,
    version: 0, recordedCostMicros: 1_000_000, committedCostMicros: 2_000_000, usedBasisPoints: 1333, level: 'NORMAL', windowStart: T, windowEnd: T2, ...patch };
  return s;
};

test('R2 contracts: level thresholds match the database; closed input; consistent status rows', () => {
  for (const [c, l] of [[0, 'NORMAL'], [11_249_999, 'NORMAL'], [11_250_000, 'WARNING_75'], [13_499_999, 'WARNING_75'], [13_500_000, 'WARNING_90'],
    [14_999_999, 'WARNING_90'], [15_000_000, 'CEILING_REACHED'], [99_000_000, 'CEILING_REACHED']])
    assert.equal(contracts.aiSchoolCostLevel(c, D), l, String(c));
  assert.equal(contracts.aiSchoolCostLevel(0, 0), 'CEILING_REACHED', 'a zero ceiling is reached at once');
  assert.equal(contracts.validateAiSchoolCostLimitInput(input()).ceilingMicros, 10_000_000);
  assert.equal(contracts.validateAiSchoolCostLimitInput(input({ ceilingMicros: 0, paused: true })).paused, true);
  for (const bad of [{ schoolId: 'school' }, { ceilingMicros: -1 }, { ceilingMicros: 1.5 }, { ceilingMicros: 1_000_000_001 }, { ceilingMicros: '15' },
    { paused: 'yes' }, { reason: 'short' }, { reason: ` ${REASON}` }, { reason: 'x'.repeat(501) }, { expectedVersion: -1 }, { organizationId: U() },
    { updatedBy: U() }, { level: 'NORMAL' }])
    assert.throws(() => contracts.validateAiSchoolCostLimitInput(input(bad)), JSON.stringify(bad));
  const { reason, ...missing } = input(); assert.throws(() => contracts.validateAiSchoolCostLimitInput(missing));
  const list = contracts.validateAiSchoolCostStatusList({ schools: [status(),
    status({ ceilingMicros: 10_000_000, defaultCeiling: false, paused: true, reason: REASON, version: 2, committedCostMicros: 9_000_000, level: 'WARNING_90' })],
    defaultCeilingMicros: D, asOf: T });
  assert.equal(list.schools.length, 2);
  for (const bad of [status({ level: 'WARNING_75' }), status({ defaultCeiling: true, version: 1 }), status({ defaultCeiling: true, paused: true }),
    status({ defaultCeiling: false, version: 1, reason: null }), status({ recordedCostMicros: 3_000_000 }), status({ windowEnd: T }),
    { ...status(), extra: 1 }, status({ level: 'OVER' })])
    assert.throws(() => contracts.validateAiSchoolCostStatusList({ schools: [bad], defaultCeilingMicros: D, asOf: T }), JSON.stringify(bad));
  const dup = status();
  assert.throws(() => contracts.validateAiSchoolCostStatusList({ schools: [dup, dup], defaultCeilingMicros: D, asOf: T }), 'duplicate school');
  assert.throws(() => contracts.validateAiSchoolCostStatusList({ schools: [], defaultCeilingMicros: 1, asOf: T }), 'default ceiling is fixed');
  assert.throws(() => contracts.validateAiSchoolCostStatusList({ schools: Array.from({ length: 501 }, () => status()), defaultCeilingMicros: D, asOf: T }));
  const receipt = { schoolId: U(), organizationId: U(), ceilingMicros: 0, paused: true, version: 1, replayed: false };
  assert.equal(contracts.validateAiSchoolCostLimitReceipt(receipt).version, 1);
  for (const bad of [{ version: 0 }, { replayed: undefined }, { extra: 1 }, { organizationId: null }])
    assert.throws(() => contracts.validateAiSchoolCostLimitReceipt({ ...receipt, ...bad }), JSON.stringify(bad));
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
async function appWith(callSaasBilling) {
  const module = await Test.createTestingModule({ controllers: [AiSchoolCostLimitHqController],
    providers: [AiSchoolCostLimitService, SaasBillingService, SaasReadGuard, SaasCommandGuard, { provide: RuntimeDatabaseService, useValue: { callSaasBilling } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication({ bodyParser: false });
  app.use(json({ strict: true })); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${app.getHttpServer().address().port}/v1` };
}

test('HTTP: school AI cost limit is an exact HQ human command; the database decides authority; refusals never reach it', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = [], school = U();
  const human = (command = contracts.SAAS_COMMANDS.aiSchoolCostLimit) => ({ 'content-type': 'application/json', origin: 'https://hon.example', 'x-hon-human-command': command,
    'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty', 'idempotency-key': randomUUID() });
  let next = null, drift = false;
  const { app, base } = await appWith(async (operation, params) => {
    calls.push([operation, params]);
    if (next) { const e = new Error(next.message); e.code = next.code; next = null; throw e; }
    if (operation === 'readAiSchoolCostLimits') return drift ? { schools: [status({ level: 'CEILING_REACHED' })], defaultCeilingMicros: D, asOf: T }
      : { schools: [status({ schoolId: school })], defaultCeilingMicros: D, asOf: T };
    if (operation === 'commandAiSchoolCostLimit') { const i = JSON.parse(params[1]); return { schoolId: i.schoolId, organizationId: U(), ceilingMicros: i.ceilingMicros, paused: i.paused, version: i.expectedVersion + 1, replayed: false }; }
    throw new Error('unexpected');
  });
  try {
    const read = await send(`${base}/hq/ai/school-cost-limits`);
    assert.equal(read.status, 200, read.body); assert.match(read.headers['cache-control'], /no-store/);
    assert.equal(JSON.parse(read.body).data.schools[0].schoolId, school);
    assert.deepEqual(calls.at(-1), ['readAiSchoolCostLimits', ['verified-human']]);
    drift = true;
    assert.equal((await send(`${base}/hq/ai/school-cost-limits`)).status, 503, 'a level that disagrees with the numbers is drift, never shown');
    drift = false;
    const body = JSON.stringify(input({ schoolId: school, paused: true }));
    const headers = human();
    const done = await send(`${base}/hq/ai/school-cost-limits`, { method: 'POST', headers, body });
    assert.equal(done.status, 200, done.body); assert.deepEqual([JSON.parse(done.body).data.paused, JSON.parse(done.body).data.version], [true, 1]);
    assert.deepEqual(calls.at(-1), ['commandAiSchoolCostLimit', ['verified-human', body, headers['idempotency-key']]]);
    for (const [message, code, status, expected] of [['SAAS_FORBIDDEN', '42501', 403, 'SAAS_FORBIDDEN'], ['AI_SCHOOL_COST_LIMIT_KEY_REUSED', '23505', 409, 'IDEMPOTENCY_KEY_REUSED'],
      ['SAAS_VERSION_CONFLICT', '40001', 409, 'SAAS_VERSION_CONFLICT'], ['AI_SCHOOL_NOT_FOUND', 'P0002', 404, 'SAAS_UNAVAILABLE'],
      ['AI_SCHOOL_COST_LIMIT_INVALID', '22023', 400, 'INVALID_SAAS_INPUT'], ['private detail', 'XX000', 503, 'SAAS_UNAVAILABLE']]) {
      next = { message, code };
      const r = await send(`${base}/hq/ai/school-cost-limits`, { method: 'POST', headers: human(), body });
      assert.deepEqual([r.status, JSON.parse(r.body).code], [status, expected], message);
      assert.doesNotMatch(r.body, /private detail/);
    }
    next = { message: 'SAAS_FORBIDDEN', code: '42501' };
    assert.equal((await send(`${base}/hq/ai/school-cost-limits`)).status, 403, 'a non-HQ reader is refused by the database');
    const n = calls.length;
    const { 'idempotency-key': _key, ...noKey } = human();
    for (const [h, payload, label] of [
      [human(contracts.SAAS_COMMANDS.aiSpendPause), body, 'wrong command header'],
      [{ ...human(), origin: 'https://evil.example' }, body, 'foreign origin'],
      [{ ...human(), 'sec-fetch-site': 'cross-site' }, body, 'cross-site'],
      [{ ...human(), 'x-hon-subject': 'someone-else' }, body, 'extra X-HON header'],
      [noKey, body, 'no idempotency key'],
      [human(), JSON.stringify({ ...input(), updatedBy: U() }), 'browser names the actor'],
      [human(), JSON.stringify(input({ organizationId: U() })), 'browser names the organization'],
      [human(), JSON.stringify(input({ reason: 'short' })), 'short reason'],
      [human(), JSON.stringify(input({ ceilingMicros: -5 })), 'negative ceiling'],
      [human(), JSON.stringify(input({ ceilingMicros: 2_000_000_000 })), 'ceiling above the hard maximum']])
      assert.ok([400, 403].includes((await send(`${base}/hq/ai/school-cost-limits`, { method: 'POST', headers: h, body: payload })).status), label);
    assert.equal((await send(`${base}/hq/ai/school-cost-limits?schoolId=${school}`)).status, 400, 'reads take no query');
    assert.equal((await send(`${base}/hq/ai/school-cost-limits?x=1`, { method: 'POST', headers: human(), body })).status, 400, 'commands take no query');
    for (const method of ['PATCH', 'DELETE', 'PUT'])
      assert.equal((await send(`${base}/hq/ai/school-cost-limits`, { method, headers: human(), body })).status, 404, method);
    assert.equal(calls.length, n, 'refused requests never reach the database');
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});
