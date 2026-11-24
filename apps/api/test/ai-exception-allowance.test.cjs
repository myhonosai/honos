const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { AiExceptionAllowanceHqController, AiExceptionAllowanceService } = require('../dist/ai-spend/ai-exception-allowance.controller.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

const U = () => randomUUID(), T = '2026-11-01T00:00:00.000Z', T2 = '2026-12-01T00:00:00.000Z';
const REASON = 'Synthetic exception AI limit for a fixture';
const D = contracts.AI_EXCEPTION_DEFAULT_ALLOWANCE_MICROS;
const input = (patch = {}) => ({ schoolId: U(), ceilingMicros: D, reason: REASON, expectedVersion: 0, ...patch });
const status = (patch = {}) => ({ organizationId: U(), schoolId: U(), exceptionId: U(), schoolName: 'Synthetic Dojo', exceptionStartsAt: T, exceptionExpiresAt: T2,
  exceptionLive: true, ceilingMicros: null, aiAllowed: false, version: 0, reason: null, updatedAt: null, committedCostMicros: 0, level: 'NO_CEILING',
  windowStart: T, windowEnd: T2, ...patch });
const on = (patch = {}) => status({ ceilingMicros: D, aiAllowed: true, version: 1, reason: REASON, updatedAt: T, committedCostMicros: 1_000_000, level: 'NORMAL', ...patch });
const list = (schools, patch = {}) => ({ schools, defaultCeilingMicros: D, asOf: T, ...patch });

test('0353 contracts: $25 suggestion, $1-$1,000 limits or null to clear; consistent status rows', () => {
  assert.equal(D, 25_000_000);
  assert.equal(contracts.validateAiExceptionAllowanceInput(input()).ceilingMicros, D);
  assert.equal(contracts.validateAiExceptionAllowanceInput(input({ ceilingMicros: null, expectedVersion: 2 })).ceilingMicros, null);
  for (const v of [1_000_000, 1_000_000_000]) assert.equal(contracts.validateAiExceptionAllowanceInput(input({ ceilingMicros: v })).ceilingMicros, v);
  for (const bad of [{ schoolId: 'school' }, { ceilingMicros: 0 }, { ceilingMicros: 999_999 }, { ceilingMicros: 1_000_000_001 }, { ceilingMicros: 1.5e6 + 0.5 },
    { ceilingMicros: '25' }, { reason: 'short' }, { reason: ` ${REASON}` }, { expectedVersion: -1 }, { organizationId: U() }, { exceptionId: U() }, { paused: false }])
    assert.throws(() => contracts.validateAiExceptionAllowanceInput(input(bad)), JSON.stringify(bad));
  const { reason, ...missing } = input(); assert.throws(() => contracts.validateAiExceptionAllowanceInput(missing));
  const ok = contracts.validateAiExceptionAllowanceList(list([status(), on(), on({ committedCostMicros: D, level: 'CEILING_REACHED' }),
    status({ ceilingMicros: D, version: 2, reason: REASON, updatedAt: T }), status({ version: 3, reason: REASON, updatedAt: T })]));
  assert.equal(ok.schools.length, 5);
  for (const bad of [status({ aiAllowed: true }), status({ level: 'NORMAL' }), on({ level: 'NO_CEILING' }), on({ level: 'WARNING_90' }),
    status({ version: 1 }), status({ reason: REASON }), status({ ceilingMicros: D }), on({ ceilingMicros: 5 }), status({ exceptionExpiresAt: T }),
    status({ windowEnd: T }), { ...status(), extra: 1 }, status({ schoolName: '' })])
    assert.throws(() => contracts.validateAiExceptionAllowanceList(list([bad])), JSON.stringify(bad));
  const dup = status();
  assert.throws(() => contracts.validateAiExceptionAllowanceList(list([dup, dup])), 'duplicate exception');
  assert.throws(() => contracts.validateAiExceptionAllowanceList(list([], { defaultCeilingMicros: 30_000_000 })), 'default is fixed');
  assert.throws(() => contracts.validateAiExceptionAllowanceList(list(Array.from({ length: 501 }, () => status()))));
  const receipt = { schoolId: U(), organizationId: U(), exceptionId: U(), ceilingMicros: null, version: 2, replayed: false };
  assert.equal(contracts.validateAiExceptionAllowanceReceipt(receipt).version, 2);
  for (const bad of [{ version: 0 }, { replayed: undefined }, { extra: 1 }, { exceptionId: null }, { ceilingMicros: 0 }])
    assert.throws(() => contracts.validateAiExceptionAllowanceReceipt({ ...receipt, ...bad }), JSON.stringify(bad));
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
async function appWith(callSaasBilling) {
  const module = await Test.createTestingModule({ controllers: [AiExceptionAllowanceHqController],
    providers: [AiExceptionAllowanceService, SaasBillingService, SaasReadGuard, SaasCommandGuard, { provide: RuntimeDatabaseService, useValue: { callSaasBilling } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication({ bodyParser: false });
  app.use(json({ strict: true })); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${app.getHttpServer().address().port}/v1` };
}

test('HTTP: exception AI limit is an exact HQ human command; the database decides authority; refusals never reach it', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = [], school = U(), path = '/hq/ai/exception-allowances';
  const human = (command = contracts.SAAS_COMMANDS.aiExceptionAllowance) => ({ 'content-type': 'application/json', origin: 'https://hon.example', 'x-hon-human-command': command,
    'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty', 'idempotency-key': randomUUID() });
  let next = null, drift = false;
  const { app, base } = await appWith(async (operation, params) => {
    calls.push([operation, params]);
    if (next) { const e = new Error(next.message); e.code = next.code; next = null; throw e; }
    if (operation === 'readAiExceptionAllowances') return drift ? list([status({ aiAllowed: true })]) : list([status({ schoolId: school })]);
    if (operation === 'commandAiExceptionAllowance') { const i = JSON.parse(params[1]); return { schoolId: i.schoolId, organizationId: U(), exceptionId: U(), ceilingMicros: i.ceilingMicros, version: i.expectedVersion + 1, replayed: false }; }
    throw new Error('unexpected');
  });
  try {
    const read = await send(`${base}${path}`);
    assert.equal(read.status, 200, read.body); assert.match(read.headers['cache-control'], /no-store/);
    assert.equal(JSON.parse(read.body).data.schools[0].schoolId, school);
    assert.deepEqual(calls.at(-1), ['readAiExceptionAllowances', ['verified-human']]);
    drift = true;
    assert.equal((await send(`${base}${path}`)).status, 503, 'AI allowed without a limit is drift, never shown');
    drift = false;
    const body = JSON.stringify(input({ schoolId: school }));
    const headers = human();
    const done = await send(`${base}${path}`, { method: 'POST', headers, body });
    assert.equal(done.status, 200, done.body); assert.deepEqual([JSON.parse(done.body).data.ceilingMicros, JSON.parse(done.body).data.version], [D, 1]);
    assert.deepEqual(calls.at(-1), ['commandAiExceptionAllowance', ['verified-human', body, headers['idempotency-key']]]);
    const clear = JSON.stringify(input({ schoolId: school, ceilingMicros: null, expectedVersion: 1 }));
    assert.equal(JSON.parse((await send(`${base}${path}`, { method: 'POST', headers: human(), body: clear })).body).data.ceilingMicros, null);
    for (const [message, code, status, expected] of [['SAAS_FORBIDDEN', '42501', 403, 'SAAS_FORBIDDEN'], ['AI_EXCEPTION_ALLOWANCE_KEY_REUSED', '23505', 409, 'IDEMPOTENCY_KEY_REUSED'],
      ['SAAS_VERSION_CONFLICT', '40001', 409, 'SAAS_VERSION_CONFLICT'], ['AI_SCHOOL_NOT_FOUND', 'P0002', 404, 'SAAS_UNAVAILABLE'],
      ['AI_EXCEPTION_NOT_LIVE', '23514', 422, 'AI_EXCEPTION_NOT_LIVE'], ['AI_EXCEPTION_ALLOWANCE_NOT_SET', '23514', 422, 'AI_EXCEPTION_ALLOWANCE_NOT_SET'],
      ['INVALID_AI_EXCEPTION_ALLOWANCE', '22023', 400, 'INVALID_SAAS_INPUT'], ['private detail', 'XX000', 503, 'SAAS_UNAVAILABLE']]) {
      next = { message, code };
      const r = await send(`${base}${path}`, { method: 'POST', headers: human(), body });
      assert.deepEqual([r.status, JSON.parse(r.body).code], [status, expected], message);
      assert.doesNotMatch(r.body, /private detail/);
    }
    next = { message: 'SAAS_FORBIDDEN', code: '42501' };
    assert.equal((await send(`${base}${path}`)).status, 403, 'a non-HQ reader is refused by the database');
    const n = calls.length;
    const { 'idempotency-key': _key, ...noKey } = human();
    for (const [h, payload, label] of [
      [human(contracts.SAAS_COMMANDS.aiSchoolCostLimit), body, 'wrong command header'],
      [{ ...human(), origin: 'https://evil.example' }, body, 'foreign origin'],
      [{ ...human(), 'sec-fetch-site': 'cross-site' }, body, 'cross-site'],
      [{ ...human(), 'x-hon-subject': 'someone-else' }, body, 'extra X-HON header'],
      [noKey, body, 'no idempotency key'],
      [human(), JSON.stringify({ ...input(), updatedBy: U() }), 'browser names the actor'],
      [human(), JSON.stringify(input({ organizationId: U() })), 'browser names the organization'],
      [human(), JSON.stringify(input({ reason: 'short' })), 'short reason'],
      [human(), JSON.stringify(input({ ceilingMicros: 0 })), 'zero limit'],
      [human(), JSON.stringify(input({ ceilingMicros: 2_000_000_000 })), 'limit above $1,000']])
      assert.ok([400, 403].includes((await send(`${base}${path}`, { method: 'POST', headers: h, body: payload })).status), label);
    assert.equal((await send(`${base}${path}?schoolId=${school}`)).status, 400, 'reads take no query');
    assert.equal((await send(`${base}${path}?x=1`, { method: 'POST', headers: human(), body })).status, 400, 'commands take no query');
    for (const method of ['PATCH', 'DELETE', 'PUT'])
      assert.equal((await send(`${base}${path}`, { method, headers: human(), body })).status, 404, method);
    assert.equal(calls.length, n, 'refused requests never reach the database');
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});
