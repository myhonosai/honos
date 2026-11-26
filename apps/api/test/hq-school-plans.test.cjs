const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { HqSchoolPlansController } = require('../dist/hq-school-plans/hq-school-plans.controller.js');
const { HqSchoolPlansService } = require('../dist/hq-school-plans/hq-school-plans.service.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

// HQ school plan assignments (0676): closed inputs and responses; routes forward only the verified subject, the school id
// and the validated body. Records only: nothing here charges, opens a checkout or changes a subscription.
const U = () => randomUUID(), T = '2026-11-24T06:00:00.000Z';
const person = (n = 'HQ Owner') => ({ principalId: U(), displayName: n });
const custom = (patch = {}) => ({ source: 'CUSTOM', name: 'Dojo partner deal', billingInterval: 'MONTHLY', priceMinor: 15000, freeUntil: null, ...patch });
const offer = (patch = {}) => ({ offerId: U(), offerCode: 'FOUNDER_MONTHLY', offerKind: 'FOUNDER_MONTHLY', billingInterval: 'MONTHLY', founder: true,
  displayName: 'HON OS founder monthly', priceMinor: 19920, currency: 'USD', offerSetVersion: 1, ...patch });
const rec = (schoolId, patch = {}) => ({ revision: 1, action: 'ASSIGN', source: 'CUSTOM', offerId: null, offerKind: null, offerSetVersion: null,
  planName: 'Dojo partner deal', billingInterval: 'MONTHLY', priceMinor: 15000, currency: 'USD', founder: false, freeUntil: null, note: null,
  schoolId, recordedBy: person(), recordedAt: T, ...patch });
const removed = (schoolId, revision) => rec(schoolId, { revision, action: 'REMOVE', source: null, planName: null, billingInterval: null, priceMinor: null,
  currency: null, founder: null });
const view = (schoolId, patch = {}) => { const cur = rec(schoolId); return { schoolId, organizationId: U(), schoolName: 'Ideal Martial Arts',
  schoolStatus: 'ACTIVE', organizationStatus: 'ACTIVE', revision: 1, current: cur, history: [cur], onNow: 'NONE', offers: [offer()],
  viewer: { ...person(), canManage: true }, effect: 'RECORD_ONLY', charging: 'OFF', asOf: T, ...patch }; };
const receipt = (schoolId, patch = {}) => ({ operation: 'ASSIGN', schoolId, organizationId: U(), assignment: rec(schoolId), effect: 'RECORD_ONLY',
  charging: 'OFF', replayed: false, ...patch });

test('contracts: command values match the SaaS command table', () => {
  assert.deepEqual(contracts.HQ_SCHOOL_PLAN_COMMANDS, { assign: contracts.SAAS_COMMANDS.assignSchoolPlan, remove: contracts.SAAS_COMMANDS.removeSchoolPlan });
});

test('contracts: assign/remove inputs are closed; free may last forever; an end date only when free', () => {
  const ok = { expectedRevision: 0, plan: custom(), note: null };
  assert.deepEqual(contracts.validateHqSchoolPlanAssignInput(ok), ok);
  assert.equal(contracts.validateHqSchoolPlanAssignInput({ ...ok, plan: custom({ priceMinor: 0 }) }).plan.freeUntil, null);
  assert.equal(contracts.validateHqSchoolPlanAssignInput({ ...ok, plan: custom({ priceMinor: 0, freeUntil: '2027-01-31' }) }).plan.freeUntil, '2027-01-31');
  const id = U();
  assert.deepEqual(contracts.validateHqSchoolPlanAssignInput({ ...ok, plan: { source: 'OFFER', offerId: id.toUpperCase() } }).plan, { source: 'OFFER', offerId: id });
  for (const bad of [{ ...ok, extra: 1 }, { ...ok, expectedRevision: -1 }, { ...ok, note: ' x' }, { ...ok, plan: custom({ priceMinor: 15000, freeUntil: '2027-01-31' }) },
    { ...ok, plan: custom({ priceMinor: 0, freeUntil: '2027-02-30' }) }, { ...ok, plan: custom({ priceMinor: 10_000_001 }) }, { ...ok, plan: custom({ priceMinor: 1.5 }) },
    { ...ok, plan: custom({ billingInterval: 'ONE_TIME' }) }, { ...ok, plan: custom({ name: 'ab' }) }, { ...ok, plan: { source: 'OFFER', offerId: 'x' } },
    { ...ok, plan: { source: 'OFFER', offerId: id, priceMinor: 1 } }, { ...ok, plan: { source: 'FREE' } }])
    assert.throws(() => contracts.validateHqSchoolPlanAssignInput(bad), JSON.stringify(bad).slice(0, 80));
  assert.deepEqual(contracts.validateHqSchoolPlanRemoveInput({ expectedRevision: 3, note: 'Closed' }), { expectedRevision: 3, note: 'Closed' });
  for (const bad of [{ expectedRevision: 3 }, { expectedRevision: 3, note: null, plan: custom() }]) assert.throws(() => contracts.validateHqSchoolPlanRemoveInput(bad));
});

test('contracts: views and receipts are closed and consistent', () => {
  const S = U();
  assert.equal(contracts.validateHqSchoolPlanView(view(S)).current.planName, 'Dojo partner deal');
  assert.equal(contracts.validateHqSchoolPlanView(view(S, { revision: 0, current: null, history: [] })).current, null);
  const two = view(S, { revision: 2, current: null, history: [removed(S, 2), rec(S)] });
  assert.equal(contracts.validateHqSchoolPlanView(two).history.length, 2);
  for (const bad of [view(S, { charging: 'ON' }), view(S, { effect: 'CHARGED' }), view(S, { revision: 2 }), view(S, { current: null }),
    view(S, { history: [rec(S, { revision: 2 }), rec(S, { revision: 2 })], revision: 2 }), view(S, { onNow: 'PAID' }),
    view(S, { offers: [offer({ priceMinor: 50 })] }), view(S, { current: rec(S, { offerId: U() }) }),
    view(S, { history: [rec(S, { priceMinor: 5000, freeUntil: '2027-01-01' })], current: rec(S, { priceMinor: 5000, freeUntil: '2027-01-01' }) }),
    view(S, { history: [removed(S, 1)], current: null, revision: 1, extra: 1 })])
    assert.throws(() => contracts.validateHqSchoolPlanView(bad));
  assert.equal(contracts.validateHqSchoolPlanReceipt(receipt(S)).assignment.revision, 1);
  for (const bad of [receipt(S, { operation: 'REMOVE' }), receipt(S, { assignment: rec(U()) }), receipt(S, { charging: 'ON' })])
    assert.throws(() => contracts.validateHqSchoolPlanReceipt(bad));
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
async function appWith(callSaasBilling) {
  const module = await Test.createTestingModule({ controllers: [HqSchoolPlansController],
    providers: [HqSchoolPlansService, SaasBillingService, SaasReadGuard, SaasCommandGuard, { provide: RuntimeDatabaseService, useValue: { callSaasBilling } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication({ bodyParser: false });
  app.use(json({ strict: true })); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${app.getHttpServer().address().port}/v1` };
}
const command = (marker, key = U()) => ({ origin: 'https://hon.example', 'x-hon-human-command': marker, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin',
  'sec-fetch-dest': 'empty', 'content-type': 'application/json', 'idempotency-key': key });

test('HTTP: routes forward only the verified subject, the school id and the validated body; error mapping', async () => {
  const prior = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const school = U(), calls = []; let reply = () => view(school);
  const { app, base } = await appWith(async (operation, params) => { calls.push([operation, params]); return reply(); });
  try {
    const ok = await send(`${base}/hq/schools/${school}/plan`);
    assert.equal(ok.status, 200, ok.body); assert.equal(ok.headers['cache-control'], 'private, no-store');
    assert.deepEqual(calls.at(-1), ['readHqSchoolPlan', ['verified-human', school]]);
    reply = () => view(U());
    assert.equal((await send(`${base}/hq/schools/${school}/plan`)).status, 503, 'another school\'s answer is never shown');
    assert.equal((await send(`${base}/hq/schools/not-a-uuid/plan`)).status, 400);
    const input = { expectedRevision: 0, plan: custom(), note: null }, key = U();
    reply = () => receipt(school);
    const a = await send(`${base}/hq/schools/${school}/plan/assign`, { method: 'POST', headers: command('hq-school-plan-assign', key), body: JSON.stringify(input) });
    assert.equal(a.status, 200, a.body);
    assert.deepEqual(calls.at(-1), ['assignHqSchoolPlan', ['verified-human', school, JSON.stringify(input), key]]);
    reply = () => receipt(school, { assignment: rec(school, { revision: 5 }) });
    assert.equal((await send(`${base}/hq/schools/${school}/plan/assign`, { method: 'POST', headers: command('hq-school-plan-assign'), body: JSON.stringify(input) })).status, 503,
      'a receipt for another revision is never shown');
    const n = calls.length;
    assert.equal((await send(`${base}/hq/schools/${school}/plan/assign`, { method: 'POST', headers: command('hq-school-plan-remove'), body: JSON.stringify(input) })).status, 403);
    assert.equal((await send(`${base}/hq/schools/${school}/plan/assign`, { method: 'POST', headers: command('hq-school-plan-assign'), body: JSON.stringify({ ...input, priceMinor: 1 }) })).status, 400);
    assert.equal(calls.length, n);
    const rm = { expectedRevision: 1, note: null };
    reply = () => receipt(school, { operation: 'REMOVE', assignment: removed(school, 2) });
    assert.equal((await send(`${base}/hq/schools/${school}/plan/remove`, { method: 'POST', headers: command('hq-school-plan-remove', key), body: JSON.stringify(rm) })).status, 200);
    assert.deepEqual(calls.at(-1), ['removeHqSchoolPlan', ['verified-human', school, JSON.stringify(rm), key]]);
    for (const [code, message, http, answer] of [['42501', 'SAAS_FORBIDDEN', 403, 'SAAS_FORBIDDEN'], ['40001', 'SAAS_VERSION_CONFLICT', 409, 'SAAS_VERSION_CONFLICT'],
      ['23505', 'SAAS_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED'], ['P0002', 'SAAS_UNAVAILABLE', 404, 'SAAS_UNAVAILABLE'],
      ['23514', 'HQ_SCHOOL_PLAN_OFFER_NOT_AVAILABLE', 422, 'HQ_SCHOOL_PLAN_OFFER_NOT_AVAILABLE'], ['23514', 'HQ_SCHOOL_PLAN_NO_CHANGE', 422, 'HQ_SCHOOL_PLAN_NO_CHANGE'],
      ['23514', 'HQ_SCHOOL_PLAN_SCHOOL_ARCHIVED', 422, 'HQ_SCHOOL_PLAN_SCHOOL_ARCHIVED'], ['23514', 'HQ_SCHOOL_PLAN_FREE_END_INVALID', 422, 'HQ_SCHOOL_PLAN_FREE_END_INVALID'],
      ['23514', 'HQ_SCHOOL_PLAN_END_DATE_ONLY_WHEN_FREE', 422, 'HQ_SCHOOL_PLAN_END_DATE_ONLY_WHEN_FREE'], ['23514', 'HQ_SCHOOL_PLAN_NONE', 422, 'HQ_SCHOOL_PLAN_NONE']]) {
      reply = () => { const e = new Error(message); e.code = code; throw e; };
      const r = await send(`${base}/hq/schools/${school}/plan/assign`, { method: 'POST', headers: command('hq-school-plan-assign'), body: JSON.stringify(input) });
      assert.deepEqual([r.status, JSON.parse(r.body).code], [http, answer], message);
    }
  } finally { await app.close(); if (prior === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = prior; }
});
