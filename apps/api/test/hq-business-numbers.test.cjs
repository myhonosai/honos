const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { HqBusinessNumbersController } = require('../dist/school-billing/saas-school-billing.controller.js');
const { SaasSchoolBillingService } = require('../dist/school-billing/saas-school-billing.service.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

// B-HQ-3 HQ business numbers (0326): a closed count-and-sum answer whose totals must agree with each other, and one read
// that forwards only the verified subject and the declared month count.
const T = '2026-11-13T00:00:00.000Z';
const current = (patch = {}) => ({ mrrMinor: 39800, arrMinor: 477600, payingSchools: 2, payingByInterval: { MONTHLY: 1, ANNUAL: 1 },
  payingBySource: { SCHEDULE_BINDING: 1, V1_SUBSCRIPTION: 1 }, unpricedActiveRecords: 0, lifetimeSchools: 1, bindingsNeedingReview: 0,
  suspendedSubscriptions: 0, activeTrials: 3, ...patch });
const month = (m, last, patch = {}) => ({ month: m, monthToDate: last, newSchools: 2, publicSignups: 1, trialsStarted: 1, newPayingSchools: 1,
  trialConversions: 1, stoppedPayingSchools: 0, ...patch });
const months = n => Array.from({ length: n }, (_, i) => month(new Date(Date.UTC(2026, 10 - (n - 1) + i, 1)).toISOString().slice(0, 7), i === n - 1));
const view = (patch = {}) => ({ current: current(), months: months(2), monthsRequested: 2, currency: 'USD', chargesEnabled: false,
  churnRateAvailable: false, asOf: T, ...patch });

test('contracts: totals agree, months ascend, only the last month is to date, nothing is collected money', () => {
  assert.equal(contracts.validateHqBusinessNumbers(view()).current.mrrMinor, 39800);
  assert.equal(contracts.validateHqBusinessNumbers(view({ current: current({ mrrMinor: 0, arrMinor: 0, payingSchools: 0,
    payingByInterval: { MONTHLY: 0, ANNUAL: 0 }, payingBySource: { SCHEDULE_BINDING: 0, V1_SUBSCRIPTION: 0 } }) })).current.payingSchools, 0);
  for (const bad of [
    view({ current: current({ arrMinor: 1 }) }),
    view({ current: current({ payingByInterval: { MONTHLY: 2, ANNUAL: 1 } }) }),
    view({ current: current({ payingBySource: { SCHEDULE_BINDING: 0, V1_SUBSCRIPTION: 1 } }) }),
    view({ current: current({ payingSchools: 0, payingByInterval: { MONTHLY: 0, ANNUAL: 0 }, payingBySource: { SCHEDULE_BINDING: 0, V1_SUBSCRIPTION: 0 } }) }),
    view({ current: current({ activeTrials: -1 }) }), view({ current: current({ mrrMinor: 1.5, arrMinor: 18 }) }),
    view({ current: current({ collectedMinor: 100 }) }), view({ current: current({ payingByInterval: { MONTHLY: 1, ANNUAL: 1, LIFETIME: 0 } }) }),
    view({ chargesEnabled: true }), view({ churnRateAvailable: true }), view({ churnRate: 0.1 }), view({ currency: 'EUR' }), view({ asOf: 'now' }),
    view({ monthsRequested: 3 }), view({ monthsRequested: 13, months: months(13) }),
    view({ months: [months(2)[1], months(2)[0]] }), view({ months: [month('2026-10', true), month('2026-11', true)] }),
    view({ months: [month('2026-10', false), month('2026-10', true)] }), view({ months: [month('2026-10', false), month('2026-13', true)] }),
    view({ months: [month('2026-10', false), month('2026-11', true, { trialConversions: 2 })] }),
    view({ months: [month('2026-10', false), month('2026-11', true, { schoolNames: [] })] }),
  ]) assert.throws(() => contracts.validateHqBusinessNumbers(bad), JSON.stringify(bad).slice(0, 200));
  assert.deepEqual(contracts.validateHqBusinessQuery({}), { months: 6 });
  assert.deepEqual(contracts.validateHqBusinessQuery({ months: '12' }), { months: 12 });
  assert.deepEqual(contracts.validateHqBusinessQuery({ months: '1' }), { months: 1 });
  for (const bad of [{ months: '0' }, { months: '13' }, { months: '06' }, { months: '1.5' }, { months: 6 }, { months: ['6'] }, { schoolId: 'x' }])
    assert.throws(() => contracts.validateHqBusinessQuery(bad), JSON.stringify(bad));
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
async function appWith(callSaasBilling) {
  const module = await Test.createTestingModule({ controllers: [HqBusinessNumbersController],
    providers: [SaasSchoolBillingService, SaasBillingService, SaasReadGuard, SaasCommandGuard, { provide: RuntimeDatabaseService, useValue: { callSaasBilling } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication({ bodyParser: false });
  app.use(json({ strict: true })); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${app.getHttpServer().address().port}/v1` };
}

test('HTTP: business numbers forward only the subject and month count; drifted answers are never shown', async () => {
  const calls = []; let reply = (params) => view({ monthsRequested: Number(params[1]), months: months(Number(params[1])) });
  const { app, base } = await appWith(async (operation, params) => { calls.push([operation, params]); return reply(params); });
  const url = `${base}/hq/saas/business-numbers`;
  try {
    const ok = await send(url);
    assert.equal(ok.status, 200, ok.body); assert.equal(ok.headers['cache-control'], 'private, no-store');
    assert.deepEqual(calls.at(-1), ['readHqBusinessNumbers', ['verified-human', '6']]);
    assert.equal(JSON.parse(ok.body).data.months.length, 6);
    assert.equal((await send(`${url}?months=12`)).status, 200);
    assert.deepEqual(calls.at(-1), ['readHqBusinessNumbers', ['verified-human', '12']]);
    const n = calls.length;
    for (const q of ['months=0', 'months=13', 'months=abc', 'months=6&months=7', 'schoolId=x', 'subject=other'])
      assert.equal((await send(`${url}?${q}`)).status, 400, q);
    assert.equal((await send(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
    assert.equal(calls.length, n, 'refused requests never reach the database');
    reply = () => view({ monthsRequested: 2, months: months(2) });
    assert.equal((await send(`${url}?months=3`)).status, 503, 'an answer for another month count');
    reply = () => view({ current: current({ arrMinor: 5 }) });
    assert.equal((await send(`${url}?months=2`)).status, 503, 'ARR that disagrees with MRR');
    reply = () => { const e = new Error('SAAS_FORBIDDEN'); e.code = '42501'; throw e; };
    const denied = await send(url);
    assert.deepEqual([denied.status, JSON.parse(denied.body).code], [403, 'SAAS_FORBIDDEN']);
  } finally { await app.close(); }
});
