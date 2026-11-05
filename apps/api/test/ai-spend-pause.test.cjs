const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { AiSpendPauseHqController, AiSpendPauseService } = require('../dist/ai-spend/ai-spend-pause.controller.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

const U = () => randomUUID(), T = '2026-11-01T00:00:00.000Z', T2 = '2026-11-01T01:00:00.000Z';
const REASON = 'Synthetic emergency pause for a fixture';
const input = (patch = {}) => ({ action: 'PAUSE', organizationId: U(), spendClass: 'AGENT_INFERENCE', reason: REASON, ...patch });
const pause = (patch = {}) => ({ pauseId: U(), organizationId: U(), spendClass: 'ALL', reason: REASON, pausedAt: T, pausedByPrincipalId: U(), status: 'ACTIVE',
  endReason: null, endedAt: null, endedByPrincipalId: null, ...patch });

test('S4-c contracts: closed pause input; consistent pause records; at most 200', () => {
  assert.equal(contracts.validateAiSpendPauseInput(input()).action, 'PAUSE');
  assert.equal(contracts.validateAiSpendPauseInput(input({ action: 'RESUME', organizationId: null, spendClass: 'ALL' })).organizationId, null);
  for (const bad of [{ action: 'DELETE' }, { organizationId: 'org' }, { spendClass: 'HQ_INTERNAL' }, { reason: 'short' }, { reason: ` ${REASON}` },
    { reason: 'x'.repeat(501) }, { pausedByPrincipalId: U() }, { until: T2 }])
    assert.throws(() => contracts.validateAiSpendPauseInput(input(bad)), JSON.stringify(bad));
  const { reason, ...missing } = input(); assert.throws(() => contracts.validateAiSpendPauseInput(missing));
  const list = contracts.validateAiSpendPauseList({ pauses: [pause(), pause({ organizationId: null, status: 'ENDED', endReason: REASON, endedAt: T2, endedByPrincipalId: U() })], asOf: T2 });
  assert.equal(list.pauses.length, 2);
  for (const bad of [pause({ status: 'ENDED' }), pause({ endedAt: T2 }), pause({ status: 'PAUSED' }), { ...pause(), extra: 1 }, pause({ pausedAt: 'yesterday' })])
    assert.throws(() => contracts.validateAiSpendPauseList({ pauses: [bad], asOf: T }), JSON.stringify(bad));
  assert.throws(() => contracts.validateAiSpendPauseList({ pauses: Array.from({ length: 201 }, () => pause()), asOf: T }));
  assert.equal(contracts.validateAiSpendPauseReceipt({ pauseId: U(), organizationId: null, spendClass: 'ALL', status: 'ENDED', replayed: true }).replayed, true);
  assert.throws(() => contracts.validateAiSpendPauseReceipt({ pauseId: U(), organizationId: null, spendClass: 'ALL', status: 'ENDED' }));
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
async function appWith(callSaasBilling) {
  const module = await Test.createTestingModule({ controllers: [AiSpendPauseHqController],
    providers: [AiSpendPauseService, SaasBillingService, SaasReadGuard, SaasCommandGuard, { provide: RuntimeDatabaseService, useValue: { callSaasBilling } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication({ bodyParser: false });
  app.use(json({ strict: true })); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${app.getHttpServer().address().port}/v1` };
}

test('HTTP: AI spend pause is an exact HQ human command; the database decides authority; refusals never reach it', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = [], org = U();
  const human = (command = contracts.SAAS_COMMANDS.aiSpendPause) => ({ 'content-type': 'application/json', origin: 'https://hon.example', 'x-hon-human-command': command,
    'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty', 'idempotency-key': randomUUID() });
  let next = null;
  const { app, base } = await appWith(async (operation, params) => {
    calls.push([operation, params]);
    if (next) { const e = new Error(next.message); e.code = next.code; next = null; throw e; }
    if (operation === 'readAiSpendPauses') return { pauses: [pause({ organizationId: org })], asOf: T };
    if (operation === 'commandAiSpendPause') { const i = JSON.parse(params[1]); return { pauseId: U(), organizationId: i.organizationId, spendClass: i.spendClass, status: i.action === 'PAUSE' ? 'ACTIVE' : 'ENDED', replayed: false }; }
    throw new Error('unexpected');
  });
  try {
    const read = await send(`${base}/hq/ai/spend-pauses`);
    assert.equal(read.status, 200, read.body); assert.match(read.headers['cache-control'], /no-store/);
    assert.deepEqual(calls.at(-1), ['readAiSpendPauses', ['verified-human']]);
    const body = JSON.stringify(input({ organizationId: org }));
    const headers = human();
    const paused = await send(`${base}/hq/ai/spend-pauses`, { method: 'POST', headers, body });
    assert.equal(paused.status, 200, paused.body); assert.equal(JSON.parse(paused.body).data.status, 'ACTIVE');
    assert.deepEqual(calls.at(-1), ['commandAiSpendPause', ['verified-human', body, headers['idempotency-key']]]);
    for (const [message, code, status, expected] of [['SAAS_FORBIDDEN', '42501', 403, 'SAAS_FORBIDDEN'], ['AI_SPEND_PAUSE_KEY_REUSED', '23505', 409, 'IDEMPOTENCY_KEY_REUSED'],
      ['AI_SPEND_PAUSE_ALREADY_ACTIVE', '23514', 422, 'AI_SPEND_PAUSE_ALREADY_ACTIVE'], ['AI_SPEND_PAUSE_NOT_ACTIVE', '23514', 422, 'AI_SPEND_PAUSE_NOT_ACTIVE'],
      ['AI_SPEND_PAUSE_ORGANIZATION_NOT_FOUND', 'P0002', 404, 'SAAS_UNAVAILABLE'], ['private detail', 'XX000', 503, 'SAAS_UNAVAILABLE']]) {
      next = { message, code };
      const r = await send(`${base}/hq/ai/spend-pauses`, { method: 'POST', headers: human(), body });
      assert.deepEqual([r.status, JSON.parse(r.body).code], [status, expected], message);
    }
    next = { message: 'SAAS_FORBIDDEN', code: '42501' };
    assert.equal((await send(`${base}/hq/ai/spend-pauses`)).status, 403, 'a non-HQ reader is refused by the database');
    const n = calls.length;
    const { 'idempotency-key': _key, ...noKey } = human();
    for (const [h, payload, label] of [
      [human(contracts.SAAS_COMMANDS.grantAccessException), body, 'wrong command header'],
      [{ ...human(), origin: 'https://evil.example' }, body, 'foreign origin'],
      [{ ...human(), 'sec-fetch-site': 'cross-site' }, body, 'cross-site'],
      [{ ...human(), 'x-hon-subject': 'someone-else' }, body, 'extra X-HON header'],
      [noKey, body, 'no idempotency key'],
      [human(), JSON.stringify(input({ pausedByPrincipalId: U() })), 'browser names the actor'],
      [human(), JSON.stringify(input({ reason: 'short' })), 'short reason'],
      [human(), JSON.stringify(input({ spendClass: 'HQ_INTERNAL' })), 'unknown class']])
      assert.ok([400, 403].includes((await send(`${base}/hq/ai/spend-pauses`, { method: 'POST', headers: h, body: payload })).status), label);
    assert.equal((await send(`${base}/hq/ai/spend-pauses?organizationId=${org}`)).status, 400, 'reads take no query');
    assert.equal((await send(`${base}/hq/ai/spend-pauses?x=1`, { method: 'POST', headers: human(), body })).status, 400, 'commands take no query');
    for (const method of ['PATCH', 'DELETE', 'PUT'])
      assert.equal((await send(`${base}/hq/ai/spend-pauses`, { method, headers: human(), body })).status, 404, method);
    assert.equal(calls.length, n, 'refused requests never reach the database');
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});
