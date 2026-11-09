const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { HqSchoolDetailController } = require('../dist/school-billing/saas-school-billing.controller.js');
const { SaasSchoolBillingService } = require('../dist/school-billing/saas-school-billing.service.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

// B-HQ-2b HQ school health (0233): closed count-only facts whose signals must follow from the counts, and two reads that
// forward only the verified subject, the path id and the declared limit.
const U = () => randomUUID(), T = '2026-11-09T00:00:00.000Z';
const facts = (patch = {}) => ({
  attendance: { last30Days: 3, previous30Days: 12, lastRecordedAt: T },
  classes: { heldLast30Days: 4, scheduledNext14Days: 1 },
  bookingsLast30Days: 0,
  leads: { newLast30Days: 1, newPrevious30Days: 2, wonLast30Days: 1, open: 2 },
  activeStudents: 1, openSupportCases: 0, signals: ['ATTENDANCE_DOWN'], ...patch });
const quiet = () => facts({ attendance: { last30Days: 0, previous30Days: 0, lastRecordedAt: null }, classes: { heldLast30Days: 0, scheduledNext14Days: 0 },
  leads: { newLast30Days: 0, newPrevious30Days: 0, wonLast30Days: 0, open: 0 }, activeStudents: 0,
  signals: ['NO_ACTIVE_STUDENTS', 'NO_CLASSES_NEXT_14_DAYS', 'NO_NEW_LEADS_30_DAYS'] });
const row = (h = facts(), name = 'Fixture Dojo') => ({ schoolId: U(), schoolDisplayName: name, organizationId: U(), organizationDisplayName: 'Fixture Org', health: h });
const list = (rows, patch = {}) => ({ schools: rows, checked: 10, flagged: rows.length, truncated: false, limit: 50, asOf: T, ...patch });

test('contracts: facts are closed counts and every signal follows from them', () => {
  assert.deepEqual(contracts.validateHqSchoolHealthFacts(facts()).signals, ['ATTENDANCE_DOWN']);
  assert.equal(contracts.validateHqSchoolHealthFacts(quiet()).activeStudents, 0);
  assert.equal(contracts.validateHqSchoolHealthFacts(facts({ signals: ['ATTENDANCE_DOWN', 'NO_ATTENDANCE_14_DAYS'] })).signals.length, 2,
    'the 14-day signal depends on the read time, so only its precondition is checked');
  for (const bad of [
    facts({ signals: [] }), // attendance halved from at least 10 must be flagged
    facts({ signals: ['ATTENDANCE_DOWN', 'ATTENDANCE_DOWN'] }),
    facts({ signals: ['ATTENDANCE_DOWN', 'MADE_UP'] }),
    facts({ openSupportCases: 2 }), // needs OPEN_SUPPORT_CASES
    facts({ signals: ['ATTENDANCE_DOWN', 'NO_ACTIVE_STUDENTS'] }),
    { ...quiet(), signals: ['NO_ACTIVE_STUDENTS', 'NO_CLASSES_NEXT_14_DAYS', 'NO_NEW_LEADS_30_DAYS', 'NO_ATTENDANCE_14_DAYS'] },
    facts({ activeStudents: 1.5 }), facts({ bookingsLast30Days: -1 }), facts({ studentNames: ['A'] }),
    facts({ attendance: { last30Days: 3, previous30Days: 12, lastRecordedAt: 'yesterday' } }),
    facts({ leads: { newLast30Days: 1, newPrevious30Days: 2, wonLast30Days: 1, open: 2, revenue: 100 } }),
  ]) assert.throws(() => contracts.validateHqSchoolHealthFacts(bad), JSON.stringify(bad));
});

test('contracts: needing-attention is flagged-only, most signals first, and its totals agree', () => {
  const a = row(quiet(), 'A'), b = row(facts(), 'B');
  assert.equal(contracts.validateHqSchoolsNeedingAttention(list([a, b])).schools.length, 2);
  assert.equal(contracts.validateHqSchoolsNeedingAttention(list([a], { flagged: 3, limit: 1, truncated: true })).truncated, true);
  for (const bad of [list([b, a]), list([row(facts({ attendance: { last30Days: 9, previous30Days: 12, lastRecordedAt: T }, signals: [] }))]),
    list([a, a]), list([a, b], { flagged: 3 }), list([a], { flagged: 3, limit: 1 }), list([a, b], { checked: 1 }), list([a, b], { limit: 201 }),
    list([{ ...a, ownerEmail: 'owner@example.test' }]), list([a], { schoolNames: [] })])
    assert.throws(() => contracts.validateHqSchoolsNeedingAttention(bad));
  assert.deepEqual(contracts.validateHqAttentionQuery({}), { limit: 50 });
  assert.deepEqual(contracts.validateHqAttentionQuery({ limit: '200' }), { limit: 200 });
  for (const bad of [{ limit: '0' }, { limit: '201' }, { limit: '05' }, { limit: '1.5' }, { limit: 5 }, { schoolId: U() }])
    assert.throws(() => contracts.validateHqAttentionQuery(bad), JSON.stringify(bad));
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
async function appWith(callSaasBilling) {
  const module = await Test.createTestingModule({ controllers: [HqSchoolDetailController],
    providers: [SaasSchoolBillingService, SaasBillingService, SaasReadGuard, SaasCommandGuard, { provide: RuntimeDatabaseService, useValue: { callSaasBilling } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication({ bodyParser: false });
  app.use(json({ strict: true })); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${app.getHttpServer().address().port}/v1` };
}

test('HTTP: school health forwards only the subject and path id; a mismatched or drifted answer is never shown', async () => {
  const calls = []; const id = U(); let reply = () => ({ schoolId: id, health: facts(), asOf: T });
  const { app, base } = await appWith(async (operation, params) => { calls.push([operation, params]); return reply(); });
  try {
    const ok = await send(`${base}/hq/saas/schools/${id}/health`);
    assert.equal(ok.status, 200, ok.body); assert.equal(ok.headers['cache-control'], 'private, no-store');
    assert.deepEqual(calls.at(-1), ['readHqSchoolHealth', ['verified-human', id]]);
    assert.deepEqual(JSON.parse(ok.body).data.health.signals, ['ATTENDANCE_DOWN']);
    const n = calls.length;
    for (const url of ['/hq/saas/schools/not-a-uuid/health', `/hq/saas/schools/${id}/health?subject=x`, `/hq/saas/schools/${id}/health?limit=5`])
      assert.equal((await send(`${base}${url}`)).status, 400, url);
    assert.equal((await send(`${base}/hq/saas/schools/${id}/health`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
    assert.equal(calls.length, n, 'refused requests never reach the database');
    reply = () => ({ schoolId: U(), health: facts(), asOf: T });
    assert.equal((await send(`${base}/hq/saas/schools/${id}/health`)).status, 503, 'answer for another school');
    reply = () => ({ schoolId: id, health: facts({ signals: [] }), asOf: T });
    assert.equal((await send(`${base}/hq/saas/schools/${id}/health`)).status, 503, 'signals that disagree with the counts');
    reply = () => { const e = new Error('SAAS_FORBIDDEN'); e.code = '42501'; throw e; };
    const denied = await send(`${base}/hq/saas/schools/${id}/health`);
    assert.deepEqual([denied.status, JSON.parse(denied.body).code], [403, 'SAAS_FORBIDDEN']);
    reply = () => { const e = new Error('HQ_SCHOOL_NOT_FOUND'); e.code = 'P0002'; throw e; };
    assert.equal((await send(`${base}/hq/saas/schools/${id}/health`)).status, 404);
  } finally { await app.close(); }
});

test('HTTP: needing-attention forwards only the subject and the declared limit', async () => {
  const calls = []; let reply = () => list([row(quiet())]);
  const { app, base } = await appWith(async (operation, params) => { calls.push([operation, params]); return reply(); });
  try {
    const ok = await send(`${base}/hq/saas/schools/needing-attention`);
    assert.equal(ok.status, 200, ok.body); assert.equal(ok.headers['cache-control'], 'private, no-store');
    assert.deepEqual(calls.at(-1), ['readHqSchoolsNeedingAttention', ['verified-human', '50']]);
    assert.equal((await send(`${base}/hq/saas/schools/needing-attention?limit=200`)).status, 200);
    assert.deepEqual(calls.at(-1), ['readHqSchoolsNeedingAttention', ['verified-human', '200']]);
    const n = calls.length;
    for (const q of ['limit=0', 'limit=201', 'limit=abc', 'organizationId=' + U(), 'limit=5&limit=6'])
      assert.equal((await send(`${base}/hq/saas/schools/needing-attention?${q}`)).status, 400, q);
    assert.equal(calls.length, n, 'refused requests never reach the database');
    reply = () => list([row(facts()), row(quiet())]);
    assert.equal((await send(`${base}/hq/saas/schools/needing-attention`)).status, 503, 'out of order');
    reply = () => { const e = new Error('SAAS_FORBIDDEN'); e.code = '42501'; throw e; };
    assert.equal((await send(`${base}/hq/saas/schools/needing-attention`)).status, 403);
  } finally { await app.close(); }
});
