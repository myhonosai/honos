const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { HqSupportController } = require('../dist/hq-support/hq-support.controller.js');
const { HqSupportService } = require('../dist/hq-support/hq-support.service.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

// B-HQ-2 HQ support records (0232 proposed): closed inputs and responses, and routes that forward only the verified
// subject, the path id, the declared query and the validated body.
const U = () => randomUUID(), T = '2026-11-01T00:00:00.000Z', T2 = '2026-11-02T00:00:00.000Z';
const person = (n = 'HQ Agent') => ({ principalId: U(), displayName: n });
const kase = (patch = {}) => ({ caseId: U(), organizationId: U(), organizationDisplayName: 'Fixture Dojo', schoolId: null, schoolDisplayName: null,
  subject: 'Owner cannot sign in', category: 'ACCOUNT_ACCESS', priority: 'HIGH', status: 'OPEN', assignee: null, openedBy: person(),
  openedAt: T, updatedAt: T, closedAt: null, version: 1, noteCount: 1, ...patch });
const ev = (patch = {}) => ({ seq: 1, kind: 'OPENED', actor: person(), note: 'First note', statusFrom: null, statusTo: null, priorityFrom: null, priorityTo: null,
  assigneeChanged: false, assigneeTo: null, occurredAt: T, ...patch });
const summary = (patch = {}) => ({ OPEN: 1, WAITING_ON_SCHOOL: 0, RESOLVED: 0, CLOSED: 0, urgentActive: 0, unassignedActive: 1, ...patch });
const list = (patch = {}) => ({ cases: [kase()], limit: 50, nextCursor: null, summary: summary(), viewer: person(), asOf: T2, ...patch });

test('contracts: the HQ support command values match the SaaS command table', () => {
  assert.deepEqual(contracts.HQ_SUPPORT_COMMANDS, { open: contracts.SAAS_COMMANDS.openSupportCase, note: contracts.SAAS_COMMANDS.addSupportNote,
    change: contracts.SAAS_COMMANDS.changeSupportCase });
});

test('contracts: inputs are closed, trimmed and bounded', () => {
  const ok = { organizationId: U().toUpperCase(), schoolId: null, subject: 'Help', category: 'OTHER', priority: 'LOW', note: 'Line one\nLine two' };
  assert.equal(contracts.validateHqSupportOpenInput(ok).organizationId, ok.organizationId.toLowerCase());
  for (const bad of [{ ...ok, subject: 'ab' }, { ...ok, subject: ' Help' }, { ...ok, note: '' }, { ...ok, note: 'x'.repeat(4001) }, { ...ok, note: 'bad\u0007bell' },
    { ...ok, category: 'REFUND' }, { ...ok, extra: 1 }, { ...ok, schoolId: 'nope' }, (({ note, ...r }) => r)(ok)])
    assert.throws(() => contracts.validateHqSupportOpenInput(bad), JSON.stringify(bad).slice(0, 80));
  assert.deepEqual(contracts.validateHqSupportNoteInput({ expectedVersion: 3, note: 'ok' }), { expectedVersion: 3, note: 'ok' });
  for (const bad of [{ expectedVersion: 0, note: 'ok' }, { expectedVersion: '3', note: 'ok' }, { expectedVersion: 3 }, { expectedVersion: 3, note: 'ok', x: 1 }])
    assert.throws(() => contracts.validateHqSupportNoteInput(bad));
  assert.deepEqual(contracts.validateHqSupportChangeInput({ expectedVersion: 2, assigneePrincipalId: null }), { expectedVersion: 2, assigneePrincipalId: null });
  for (const bad of [{ expectedVersion: 2 }, { expectedVersion: 2, note: 'only a note' }, { expectedVersion: 2, status: 'DONE' }, { status: 'OPEN' },
    { expectedVersion: 2, priority: 'P1' }, { expectedVersion: 2, status: 'OPEN', organizationId: U() }])
    assert.throws(() => contracts.validateHqSupportChangeInput(bad), JSON.stringify(bad));
  assert.deepEqual(contracts.validateHqSupportListQuery({}), { status: null, organizationId: null, cursor: null, limit: 50 });
  for (const bad of [{ limit: '0' }, { limit: '101' }, { status: 'DONE' }, { cursor: 'x' }, { schoolId: U() }, { status: ['OPEN'] }])
    assert.throws(() => contracts.validateHqSupportListQuery(bad), JSON.stringify(bad));
});

test('contracts: responses are closed and internally consistent', () => {
  assert.equal(contracts.validateHqSupportCaseList(list()).cases.length, 1);
  for (const bad of [list({ cases: [{ ...kase(), email: 'a@example.test' }] }), list({ cases: [kase({ status: 'CLOSED' })] }),
    list({ cases: [kase({ schoolId: U() })] }), list({ summary: summary({ urgentActive: 2 }) }), list({ viewer: { ...person(), role: 'OWNER' } }),
    list({ cases: [kase({ openedAt: T }), kase({ openedAt: T2 })], limit: 2 }), list({ nextCursor: { openedAt: T, caseId: U() } })])
    assert.throws(() => contracts.validateHqSupportCaseList(bad));
  const c = kase({ noteCount: 2, version: 3 });
  const detail = { case: c, events: [ev(), ev({ seq: 2, kind: 'NOTE', note: 'Second' }), ev({ seq: 3, kind: 'CHANGED', note: null, statusFrom: 'OPEN', statusTo: 'RESOLVED' })],
    assignees: [person()], viewer: person(), asOf: T2 };
  assert.equal(contracts.validateHqSupportCaseDetail(detail).events.length, 3);
  for (const events of [[ev({ seq: 2 })], [ev(), ev({ seq: 3, kind: 'NOTE' })], [ev(), ev({ seq: 2, kind: 'CHANGED', note: null })],
    [ev(), ev({ seq: 2, kind: 'NOTE', statusFrom: 'OPEN', statusTo: 'CLOSED' })], [ev(), ev({ seq: 2, kind: 'OPENED' })]])
    assert.throws(() => contracts.validateHqSupportCaseDetail({ ...detail, case: kase({ noteCount: events.filter(e => e.note).length }), events }));
  assert.throws(() => contracts.validateHqSupportCaseDetail({ ...detail, case: kase({ noteCount: 5 }) }), 'note count must match');
  const pick = (patch = {}) => ({ schoolId: U(), schoolDisplayName: 'Main', organizationId: U(), organizationDisplayName: 'Fixture Dojo', ...patch });
  assert.equal(contracts.validateHqSupportSchools({ schools: [pick()], truncated: false, asOf: T2 }).schools.length, 1);
  for (const bad of [{ schools: [pick({ email: 'a@example.test' })], truncated: false, asOf: T2 }, { schools: [pick({ schoolId: 'x' })], truncated: false, asOf: T2 }, { schools: [pick({ schoolDisplayName: 'x'.repeat(301) })], truncated: false, asOf: T2 },
    { schools: [], truncated: 'no', asOf: T2 }, { schools: [], truncated: false }])
    assert.throws(() => contracts.validateHqSupportSchools(bad), JSON.stringify(bad).slice(0, 80));
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
async function appWith(callSaasBilling) {
  const module = await Test.createTestingModule({ controllers: [HqSupportController],
    providers: [HqSupportService, SaasBillingService, SaasReadGuard, SaasCommandGuard, { provide: RuntimeDatabaseService, useValue: { callSaasBilling } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication({ bodyParser: false });
  app.use(json({ strict: true })); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${app.getHttpServer().address().port}/v1` };
}
const command = (marker, key = U()) => ({ origin: 'https://hon.example', 'x-hon-human-command': marker, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin',
  'sec-fetch-dest': 'empty', 'content-type': 'application/json', 'idempotency-key': key });

test('HTTP: reads and commands forward only the verified subject, the path id, the declared query and the validated body', async () => {
  const prior = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = []; let reply = () => list();
  const { app, base } = await appWith(async (operation, params) => { calls.push([operation, params]); return reply(); });
  try {
    const ok = await send(`${base}/hq/support/cases?status=ACTIVE&limit=10`);
    assert.equal(ok.status, 200, ok.body); assert.equal(ok.headers['cache-control'], 'private, no-store');
    assert.deepEqual(calls.at(-1), ['readSupportCases', ['verified-human', 'ACTIVE', null, null, null, '10']]);
    const n = calls.length;
    for (const url of ['?schoolId=' + U(), '?status=DONE', '?limit=500', '?subject=other']) assert.equal((await send(`${base}/hq/support/cases${url}`)).status, 400, url);
    assert.equal(calls.length, n, 'refused requests never reach the database');
    reply = () => ({ schools: [], truncated: false, asOf: T2 });
    const picked = await send(`${base}/hq/support/cases/schools`);
    assert.equal(picked.status, 200, picked.body); assert.deepEqual(calls.at(-1), ['readSupportSchools', ['verified-human']]);
    assert.equal((await send(`${base}/hq/support/cases/schools?organizationId=${U()}`)).status, 400, 'the picker takes no query');
    const c = kase(); reply = () => ({ case: c, events: [ev()], assignees: [], viewer: person(), asOf: T2 });
    assert.equal((await send(`${base}/hq/support/cases/${c.caseId}`)).status, 200);
    reply = () => ({ case: kase(), events: [ev()], assignees: [], viewer: person(), asOf: T2 });
    assert.equal((await send(`${base}/hq/support/cases/${c.caseId}`)).status, 503, 'an answer about another case is never shown');
    const input = { organizationId: U(), schoolId: null, subject: 'Help', category: 'OTHER', priority: 'LOW', note: 'A note' }, key = U();
    reply = () => ({ operation: 'OPEN', case: kase(), replayed: false });
    const opened = await send(`${base}/hq/support/cases`, { method: 'POST', headers: command('hq-support-case-open', key), body: JSON.stringify(input) });
    assert.equal(opened.status, 200, opened.body);
    assert.deepEqual(calls.at(-1), ['openSupportCase', ['verified-human', JSON.stringify(input), key]]);
    const m = calls.length;
    assert.equal((await send(`${base}/hq/support/cases`, { method: 'POST', headers: command('hq-support-case-note'), body: JSON.stringify(input) })).status, 403, 'wrong marker');
    assert.equal((await send(`${base}/hq/support/cases`, { method: 'POST', headers: { ...command('hq-support-case-open'), origin: 'https://evil.example' }, body: JSON.stringify(input) })).status, 403);
    assert.equal((await send(`${base}/hq/support/cases`, { method: 'POST', headers: command('hq-support-case-open'), body: JSON.stringify({ ...input, extra: 1 }) })).status, 400);
    assert.equal((await send(`${base}/hq/support/cases/${c.caseId}/notes`, { method: 'POST', headers: command('hq-support-case-note'), body: JSON.stringify({ expectedVersion: 1 }) })).status, 400);
    assert.equal(calls.length, m);
    reply = () => ({ operation: 'NOTE', case: kase(), replayed: false });
    assert.equal((await send(`${base}/hq/support/cases/${c.caseId}/notes`, { method: 'POST', headers: command('hq-support-case-note', key), body: JSON.stringify({ expectedVersion: 1, note: 'Hi' }) })).status, 200);
    assert.deepEqual(calls.at(-1), ['addSupportNote', ['verified-human', c.caseId, JSON.stringify({ expectedVersion: 1, note: 'Hi' }), key]]);
    for (const [code, message, status, answer] of [['42501', 'SAAS_FORBIDDEN', 403, 'SAAS_FORBIDDEN'], ['40001', 'SAAS_VERSION_CONFLICT', 409, 'SAAS_VERSION_CONFLICT'],
      ['23514', 'SUPPORT_CASE_CLOSED', 422, 'SUPPORT_CASE_CLOSED'], ['23514', 'SUPPORT_ASSIGNEE_NOT_ELIGIBLE', 422, 'SUPPORT_ASSIGNEE_NOT_ELIGIBLE'],
      ['23514', 'SUPPORT_NO_CHANGE', 422, 'SUPPORT_NO_CHANGE'], ['23505', 'SAAS_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED']]) {
      reply = () => { const e = new Error(message); e.code = code; throw e; };
      const r = await send(`${base}/hq/support/cases/${c.caseId}/changes`, { method: 'POST', headers: command('hq-support-case-change'), body: JSON.stringify({ expectedVersion: 1, status: 'CLOSED' }) });
      assert.deepEqual([r.status, JSON.parse(r.body).code], [status, answer], message);
    }
  } finally { await app.close(); if (prior === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = prior; }
});
