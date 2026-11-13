const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { AiSchoolCostAlertHqController, AiSchoolCostLimitHqController, AiSchoolCostLimitService } = require('../dist/ai-spend/ai-school-cost-limit.controller.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

const U = () => randomUUID(), T = '2026-11-01T00:00:00.000Z', T2 = '2026-12-01T00:00:00.000Z';
const REASON = 'Synthetic school ceiling for a fixture';
const TD = contracts.AI_SCHOOL_TRIAL_DEFAULT_CEILING_MICROS;
const input = (patch = {}) => ({ schoolId: U(), ceilingMicros: 10_000_000, paused: false, reason: REASON, expectedVersion: 0, ...patch });
// A paying school with no HQ record: no ceiling (owner 2026-11-12: conversations are not capped).
const status = (patch = {}) => {
  const s = { schoolId: U(), organizationId: U(), schoolName: 'Synthetic Dojo', ceilingMicros: null, defaultCeiling: true, trial: false, paused: false, reason: null,
    version: 0, recordedCostMicros: 1_000_000, committedCostMicros: 2_000_000, usedBasisPoints: null, level: 'NO_CEILING', windowStart: T, windowEnd: T2, ...patch };
  return s;
};
const list = (schools, patch = {}) => ({ schools, trialDefaultCeilingMicros: TD, asOf: T, ...patch });

test('R2 contracts: level thresholds match the database; closed input; consistent status rows', () => {
  // Owner 2026-11-12: $15 while on the free trial; a paying school has no default ceiling.
  assert.equal(TD, 15_000_000);
  assert.equal(contracts.AI_SCHOOL_DEFAULT_CEILING_MICROS, undefined, 'no paying default exists');
  for (const [c, l] of [[0, 'NORMAL'], [11_249_999, 'NORMAL'], [11_250_000, 'WARNING_75'], [13_499_999, 'WARNING_75'], [13_500_000, 'WARNING_90'],
    [14_999_999, 'WARNING_90'], [15_000_000, 'CEILING_REACHED'], [99_000_000, 'CEILING_REACHED']])
    assert.equal(contracts.aiSchoolCostLevel(c, TD), l, String(c));
  assert.equal(contracts.aiSchoolCostLevel(0, 0), 'CEILING_REACHED', 'a zero ceiling is reached at once');
  assert.equal(contracts.aiSchoolCostLevel(99_000_000_000, null), 'NO_CEILING', 'no ceiling never reaches a level');
  assert.equal(contracts.validateAiSchoolCostLimitInput(input()).ceilingMicros, 10_000_000);
  assert.equal(contracts.validateAiSchoolCostLimitInput(input({ ceilingMicros: 0, paused: true })).paused, true);
  for (const bad of [{ schoolId: 'school' }, { ceilingMicros: -1 }, { ceilingMicros: 1.5 }, { ceilingMicros: 1_000_000_001 }, { ceilingMicros: '15' },
    { ceilingMicros: null }, { paused: 'yes' }, { reason: 'short' }, { reason: ` ${REASON}` }, { reason: 'x'.repeat(501) }, { expectedVersion: -1 }, { organizationId: U() },
    { updatedBy: U() }, { level: 'NORMAL' }])
    assert.throws(() => contracts.validateAiSchoolCostLimitInput(input(bad)), JSON.stringify(bad));
  const { reason, ...missing } = input(); assert.throws(() => contracts.validateAiSchoolCostLimitInput(missing));
  const ok = contracts.validateAiSchoolCostStatusList(list([status(),
    status({ trial: true, ceilingMicros: TD, usedBasisPoints: 1333, level: 'NORMAL' }),
    status({ ceilingMicros: 10_000_000, defaultCeiling: false, paused: true, reason: REASON, version: 2, committedCostMicros: 9_000_000, usedBasisPoints: 9000, level: 'WARNING_90' })]));
  assert.equal(ok.schools.length, 3);
  for (const bad of [status({ level: 'NORMAL' }), status({ usedBasisPoints: 0 }), status({ ceilingMicros: TD }), status({ trial: true }),
    status({ trial: true, ceilingMicros: TD, usedBasisPoints: null, level: 'NORMAL' }), status({ trial: 'no' }),
    status({ defaultCeiling: true, version: 1 }), status({ defaultCeiling: true, paused: true }),
    status({ defaultCeiling: false, version: 1, reason: null }), status({ recordedCostMicros: 3_000_000 }), status({ windowEnd: T }),
    { ...status(), extra: 1 }, status({ level: 'OVER' })])
    assert.throws(() => contracts.validateAiSchoolCostStatusList(list([bad])), JSON.stringify(bad));
  const dup = status();
  assert.throws(() => contracts.validateAiSchoolCostStatusList(list([dup, dup])), 'duplicate school');
  assert.throws(() => contracts.validateAiSchoolCostStatusList(list([], { trialDefaultCeilingMicros: 1 })), 'trial default is fixed');
  assert.throws(() => contracts.validateAiSchoolCostStatusList(list([], { defaultCeilingMicros: 30_000_000 })), 'no paying default field');
  assert.throws(() => contracts.validateAiSchoolCostStatusList(list(Array.from({ length: 501 }, () => status()))));
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
  const module = await Test.createTestingModule({ controllers: [AiSchoolCostLimitHqController, AiSchoolCostAlertHqController],
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
    if (operation === 'readAiSchoolCostLimits') return drift ? list([status({ level: 'CEILING_REACHED' })])
      : list([status({ schoolId: school })]);
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

// ---------- 0343: HQ alerts at 75%, 90% and 100% of a school's ceiling ----------
const alert = (patch = {}) => ({ schoolId: U(), organizationId: U(), schoolName: 'Synthetic Dojo', trial: true, level: 'WARNING_90', ceilingMicros: 15_000_000,
  committedCostMicros: 13_600_000, usedBasisPoints: 9066, crossedAt: '2026-11-10T12:00:00.000Z', windowStart: T, acknowledgement: null, ...patch });
const alerts = (list, patch = {}) => ({ alerts: list, openCount: list.filter((a) => a.acknowledgement === null).length, asOf: T, ...patch });
const ackInput = (patch = {}) => ({ schoolId: U(), level: 'WARNING_75', windowStart: T, reason: 'Synthetic HQ alert acknowledgement', ...patch });

test('0343 contracts: an alert must be reached by its numbers; open alerts first; closed acknowledgement input', () => {
  const ok = alerts([alert(), alert({ level: 'WARNING_75', acknowledgement: { acknowledgedAt: T2, reason: REASON } })]);
  assert.equal(contracts.validateAiSchoolCostAlertList(ok).openCount, 1);
  for (const [bad, label] of [
    [alerts([alert({ level: 'CEILING_REACHED' })]), 'level not reached by the committed cost'],
    [alerts([alert({ usedBasisPoints: 9000 })]), 'basis points disagree'],
    [alerts([alert({ ceilingMicros: 0, usedBasisPoints: 0 })]), 'a $0 block is never an alert'],
    [alerts([alert({ crossedAt: '2026-10-31T23:59:59.000Z' })]), 'crossed before the window'],
    [alerts([alert({ level: 'NORMAL' })]), 'NORMAL is not an alert'],
    [alerts([alert({ acknowledgement: { acknowledgedAt: T2, reason: REASON } }), alert()]), 'acknowledged before open'],
    [{ ...ok, openCount: 2 }, 'openCount disagrees with a short list'],
    [alerts([alert({ providerCost: 1 })]), 'extra key'],
    [(() => { const a = alert(); return alerts([a, { ...a }]); })(), 'duplicate school and level']])
    assert.throws(() => contracts.validateAiSchoolCostAlertList(bad), label);
  assert.deepEqual(contracts.validateAiSchoolCostAlertAckInput(ackInput({ schoolId: T.length ? 'a0000000-0000-4000-8000-000000000000' : '' })).level, 'WARNING_75');
  for (const bad of [{ level: 'NORMAL' }, { reason: 'short' }, { windowStart: 'yesterday' }, { organizationId: U() }, { acknowledgedBy: U() }])
    assert.throws(() => contracts.validateAiSchoolCostAlertAckInput(ackInput(bad)), JSON.stringify(bad));
});

test('HTTP: school AI cost alerts are an HQ read and an exact HQ human acknowledgement; the database decides authority', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = [];
  const human = (command = contracts.SAAS_COMMANDS.aiSchoolCostAlertAck) => ({ 'content-type': 'application/json', origin: 'https://hon.example', 'x-hon-human-command': command,
    'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty', 'idempotency-key': randomUUID() });
  let next = null, drift = false;
  const { app, base } = await appWith(async (operation, params) => {
    calls.push([operation, params]);
    if (next) { const e = new Error(next.message); e.code = next.code; next = null; throw e; }
    if (operation === 'readAiSchoolCostAlerts') return drift ? alerts([alert({ level: 'CEILING_REACHED' })]) : alerts([alert()]);
    if (operation === 'commandAiSchoolCostAlertAck') { const i = JSON.parse(params[1]); return { schoolId: i.schoolId, organizationId: U(), level: i.level, windowStart: i.windowStart, acknowledgedAt: T2, replayed: false }; }
    throw new Error('unexpected');
  });
  try {
    const read = await send(`${base}/hq/ai/school-cost-alerts`);
    assert.equal(read.status, 200, read.body); assert.match(read.headers['cache-control'], /no-store/);
    assert.equal(JSON.parse(read.body).data.openCount, 1);
    assert.deepEqual(calls.at(-1), ['readAiSchoolCostAlerts', ['verified-human']]);
    drift = true;
    assert.equal((await send(`${base}/hq/ai/school-cost-alerts`)).status, 503, 'an alert its numbers do not reach is drift');
    drift = false;
    const body = JSON.stringify(ackInput());
    const headers = human();
    const done = await send(`${base}/hq/ai/school-cost-alerts/acknowledgements`, { method: 'POST', headers, body });
    assert.equal(done.status, 200, done.body); assert.equal(JSON.parse(done.body).data.level, 'WARNING_75');
    assert.deepEqual(calls.at(-1), ['commandAiSchoolCostAlertAck', ['verified-human', body, headers['idempotency-key']]]);
    for (const [message, code, status] of [['SAAS_FORBIDDEN', '42501', 403], ['AI_SCHOOL_COST_ALERT_ALREADY_ACKNOWLEDGED', '23505', 409],
      ['AI_SCHOOL_COST_ALERT_NOT_ACTIVE', '22023', 400], ['AI_SCHOOL_NOT_FOUND', 'P0002', 404]]) {
      next = { message, code };
      assert.equal((await send(`${base}/hq/ai/school-cost-alerts/acknowledgements`, { method: 'POST', headers: human(), body })).status, status, message);
    }
    const n = calls.length;
    const { 'idempotency-key': _key, ...noKey } = human();
    for (const [h, payload, label] of [
      [human(contracts.SAAS_COMMANDS.aiSchoolCostLimit), body, 'wrong command header'],
      [{ ...human(), origin: 'https://evil.example' }, body, 'foreign origin'],
      [noKey, body, 'no idempotency key'],
      [human(), JSON.stringify({ ...ackInput(), organizationId: U() }), 'browser names the organization'],
      [human(), JSON.stringify(ackInput({ level: 'NORMAL' })), 'not an alert level']])
      assert.ok([400, 403].includes((await send(`${base}/hq/ai/school-cost-alerts/acknowledgements`, { method: 'POST', headers: h, body: payload })).status), label);
    assert.equal((await send(`${base}/hq/ai/school-cost-alerts?schoolId=${U()}`)).status, 400, 'reads take no query');
    assert.equal(calls.length, n, 'refused requests never reach the database');
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});
