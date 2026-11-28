const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { HqProspectsController } = require('../dist/hq-prospects/hq-prospects.controller.js');
const { HqProspectsService } = require('../dist/hq-prospects/hq-prospects.service.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

const U = () => randomUUID(), T = '2026-11-01T00:00:00.000Z', T2 = '2026-11-02T00:00:00.000Z';
const person = { principalId: U(), displayName: 'Synthetic Marketer' };
const empty = { EMAIL: { SERVICE: null, MARKETING: null }, SMS: { SERVICE: null, MARKETING: null } };
const PID = U(), CID = U();
const prospect = (patch = {}) => ({ prospectId: PID, fullName: 'Synthetic Prospect', schoolName: 'Synthetic Karate', email: 'p@example.test', phone: '+15550100101',
  source: 'HQ_ENTERED', campaign: null, status: 'ACTIVE', consent: empty, createdBy: person, createdAt: T, updatedAt: T, version: 1, ...patch });
const fields = { fullName: 'Synthetic Prospect', schoolName: 'Synthetic Karate', email: 'p@example.test', phone: '+15550100101', campaignId: null };

test('contracts: closed inputs, HQ consent rule, and answers that must be consistent', () => {
  assert.deepEqual(contracts.validateHqProspectCreateInput({ ...fields, source: 'IMPORT' }), { ...fields, source: 'IMPORT' });
  for (const bad of [{ ...fields, source: 'PUBLIC_SIGN_UP' }, { ...fields, email: 'P@Example.test', source: 'IMPORT' }, { ...fields, email: null, phone: null, source: 'IMPORT' },
    { ...fields, phone: '5550100101', source: 'IMPORT' }, { ...fields, fullName: 'A <b>', source: 'IMPORT' }, { ...fields, source: 'IMPORT', x: 1 }])
    assert.throws(() => contracts.validateHqProspectCreateInput(bad), JSON.stringify(bad));
  assert.throws(() => contracts.validateHqProspectUpdateInput({ ...fields, status: 'GONE', expectedVersion: 1 }));
  assert.throws(() => contracts.validateHqProspectConsentInput({ channel: 'SMS', purpose: 'MARKETING', status: 'OPTED_IN', note: 'x', expectedVersion: 1 }));
  assert.equal(contracts.hqMayRecordProspectConsent('EMAIL', 'SERVICE', 'OPTED_IN'), true);
  for (const [ch, pu] of [['EMAIL', 'MARKETING'], ['SMS', 'SERVICE'], ['SMS', 'MARKETING']]) {
    assert.equal(contracts.hqMayRecordProspectConsent(ch, pu, 'OPTED_IN'), false); assert.equal(contracts.hqMayRecordProspectConsent(ch, pu, 'OPTED_OUT'), true);
  }
  const q = contracts.validateHqProspectListQuery({ status: 'ACTIVE', cursor: `${T}~${PID.toUpperCase()}`, limit: '25' });
  assert.deepEqual(q, { status: 'ACTIVE', campaignId: null, cursor: { createdAt: T, prospectId: PID }, limit: 25 });
  assert.throws(() => contracts.validateHqProspectListQuery({ limit: '101' }));
  const now = { status: 'OPTED_IN', source: 'HQ_RECORDED', capturedAt: T };
  assert.equal(contracts.validateHqProspectReceipt({ operation: 'CREATE', prospect: prospect(), replayed: false }).prospect.version, 1);
  for (const bad of [prospect({ email: null, phone: null }), prospect({ createdBy: null }), prospect({ source: 'PUBLIC_SIGN_UP' }),
    prospect({ email: null, consent: { ...empty, EMAIL: { SERVICE: now, MARKETING: null } } }), prospect({ extra: 1 })])
    assert.throws(() => contracts.validateHqProspectReceipt({ operation: 'CREATE', prospect: bad, replayed: false }), JSON.stringify(bad));
  assert.deepEqual(Object.values(contracts.HQ_PROSPECT_COMMANDS),
    [contracts.SAAS_COMMANDS.createHqProspect, contracts.SAAS_COMMANDS.updateHqProspect, contracts.SAAS_COMMANDS.recordHqProspectConsent]);
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
const command = (marker, key = U()) => ({ origin: 'https://hon.example', 'x-hon-human-command': marker, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin',
  'sec-fetch-dest': 'empty', 'content-type': 'application/json', 'idempotency-key': key });
const read = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };

test('HTTP: the verified subject and the validated body reach the database; mismatched answers and refusals are handled', async () => {
  const prior = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = []; let reply = () => ({ prospects: [prospect()], limit: 50, nextCursor: null, viewer: person, asOf: T2 });
  const module = await Test.createTestingModule({ controllers: [HqProspectsController],
    providers: [HqProspectsService, SaasBillingService, SaasReadGuard, SaasCommandGuard,
      { provide: RuntimeDatabaseService, useValue: { callSaasBilling: async (op, params) => { calls.push([op, params]); return reply(); } } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication({ bodyParser: false });
  app.use(json({ strict: true })); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/hq/prospects`;
  try {
    const listed = await send(base, { headers: read });
    assert.equal(listed.status, 200, listed.body);
    assert.deepEqual(calls.at(-1), ['readHqProspects', ['verified-human', null, null, null, null, '50']]);
    reply = () => ({ prospects: [prospect({ status: 'ARCHIVED' })], limit: 50, nextCursor: null, viewer: person, asOf: T2 });
    assert.equal((await send(`${base}?status=ACTIVE`, { headers: read })).status, 503, 'a page that does not match the filter is never shown');
    reply = () => ({ prospects: [prospect()], limit: 50, nextCursor: null, viewer: person, asOf: T2 });
    assert.equal((await send(`${base}?campaignId=${CID}`, { headers: read })).status, 503, 'campaign filter must match');
    assert.equal((await send(`${base}?email=x`, { headers: read })).status, 400, 'undeclared query refused');
    reply = () => ({ prospect: prospect(), consentHistory: [], viewer: person, asOf: T2 });
    assert.equal((await send(`${base}/${PID}`, { headers: read })).status, 200);
    assert.equal((await send(`${base}/${U()}`, { headers: read })).status, 503, 'an answer about another prospect is never shown');
    const key = U(), input = { ...fields, source: 'HQ_ENTERED' };
    reply = () => ({ operation: 'CREATE', prospect: prospect(), replayed: false });
    const created = await send(base, { method: 'POST', headers: command('hq-prospect-create', key), body: JSON.stringify(input) });
    assert.equal(created.status, 200, created.body);
    assert.deepEqual(calls.at(-1), ['createHqProspect', ['verified-human', JSON.stringify(input), key]]);
    const n = calls.length;
    assert.equal((await send(base, { method: 'POST', headers: command('hq-prospect-update'), body: JSON.stringify(input) })).status, 403, 'wrong marker');
    assert.equal((await send(base, { method: 'POST', headers: command('hq-prospect-create'), body: JSON.stringify({ ...input, source: 'TRIAL' }) })).status, 400);
    assert.equal(calls.length, n);
    reply = () => ({ operation: 'CONSENT', prospect: prospect({ version: 2 }), replayed: false });
    const c = { channel: 'EMAIL', purpose: 'SERVICE', status: 'OPTED_IN', note: 'Asked by email.', expectedVersion: 1 };
    assert.equal((await send(`${base}/${PID}/consents`, { method: 'POST', headers: command('hq-prospect-consent'), body: JSON.stringify(c) })).status, 200);
    for (const [code, message, status, answer] of [['42501', 'SAAS_FORBIDDEN', 403, 'SAAS_FORBIDDEN'], ['40001', 'SAAS_VERSION_CONFLICT', 409, 'SAAS_VERSION_CONFLICT'],
      ['23514', 'HQ_CONSENT_NOT_ALLOWED', 422, 'HQ_CONSENT_NOT_ALLOWED'], ['23514', 'HQ_PROSPECT_EXISTS', 422, 'HQ_PROSPECT_EXISTS'],
      ['23514', 'HQ_PROSPECT_NO_ADDRESS', 422, 'HQ_PROSPECT_NO_ADDRESS'], ['P0002', 'SAAS_UNAVAILABLE', 404, 'SAAS_UNAVAILABLE'], ['23505', 'SAAS_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED']]) {
      reply = () => { const e = new Error(message); e.code = code; throw e; };
      const r = await send(`${base}/${PID}/consents`, { method: 'POST', headers: command('hq-prospect-consent'), body: JSON.stringify(c) });
      assert.deepEqual([r.status, JSON.parse(r.body).code], [status, answer], message);
    }
  } finally { await app.close(); if (prior === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = prior; }
});

// ---------- 0715 pipeline board ----------
const S1 = U(), S2 = U(), SCHOOL = U();
const stage = (id, name, position, patch = {}) => ({ stageId: id, name, color: 'BLUE', position, hidden: false, openCount: 0, ...patch });
const card = (patch = {}) => ({ prospectId: PID, fullName: 'Synthetic Prospect', schoolName: null, email: 'p@example.test', phone: null, source: 'IMPORT',
  stageId: S1, status: 'ACTIVE', closedOutcome: null, textOptedOut: false, createdAt: T, version: 1, ...patch });
const boardAnswer = (patch = {}) => ({ pipelineVersion: 1, stages: [stage(S1, 'Lead', 1, { openCount: 1 }), stage(S2, 'Contacted', 2)], prospects: [card()], truncated: false,
  closed: { won: 0, lost: 0 }, schools: [{ schoolId: SCHOOL, schoolName: 'Synthetic Dojo', organizationName: 'Synthetic Org', status: 'ACTIVE', tier: 'CORE', trialEndsAt: null, createdAt: T }],
  schoolsTruncated: false, asOf: T2, ...patch });

test('contracts: pipeline board answers and inputs', () => {
  assert.equal(contracts.verifyHqProspectBoard(boardAnswer()).prospects[0].stageId, S1);
  for (const bad of [boardAnswer({ prospects: [card({ stageId: U() })] }), boardAnswer({ prospects: [card({ status: 'ARCHIVED' })] }),
    boardAnswer({ stages: [stage(S1, 'Lead', 1, { hidden: true })] }), boardAnswer({ stages: [stage(S1, 'Lead', 1), stage(S2, 'lead', 2)] }),
    boardAnswer({ stages: [stage(S1, 'Lead', 2)] }), boardAnswer({ schools: [{ ...boardAnswer().schools[0], status: 'TRIAL' }] }), boardAnswer({ extra: 1 })])
    assert.throws(() => contracts.verifyHqProspectBoard(bad), JSON.stringify(bad).slice(0, 200));
  assert.deepEqual(contracts.validateHqProspectMoveInput({ expectedVersion: 1, stageId: S2.toUpperCase(), outcome: null }), { expectedVersion: 1, stageId: S2, outcome: null });
  for (const bad of [{ expectedVersion: 1, stageId: S2, outcome: 'WON' }, { expectedVersion: 1, stageId: null, outcome: null }, { expectedVersion: 1, stageId: null, outcome: 'MAYBE' }])
    assert.throws(() => contracts.validateHqProspectMoveInput(bad));
  const ok = { expectedVersion: 1, stages: [{ id: S1, name: 'Lead', color: 'BLUE', hidden: false }, { id: null, name: 'Demo', color: 'RED', hidden: false }], moves: [] };
  assert.equal(contracts.validateHqProspectStagesInput(ok).stages.length, 2);
  for (const bad of [{ ...ok, stages: [{ id: S1, name: 'Lead', color: 'BLUE', hidden: true }] }, { ...ok, stages: [...ok.stages, { id: null, name: 'lead', color: 'RED', hidden: false }] },
    { ...ok, stages: [{ id: S1, name: ' Lead', color: 'BLUE', hidden: false }] }, { ...ok, stages: [{ id: S1, name: 'Lead', color: 'PINK', hidden: false }] }])
    assert.throws(() => contracts.validateHqProspectStagesInput(bad), JSON.stringify(bad));
  assert.deepEqual(Object.values(contracts.HQ_PROSPECT_BOARD_COMMANDS), [contracts.SAAS_COMMANDS.moveHqProspectStage, contracts.SAAS_COMMANDS.saveHqProspectStages]);
});

test('HTTP: board read, move and stage save', async () => {
  const prior = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = []; let reply = () => boardAnswer();
  const module = await Test.createTestingModule({ controllers: [HqProspectsController],
    providers: [HqProspectsService, SaasBillingService, SaasReadGuard, SaasCommandGuard,
      { provide: RuntimeDatabaseService, useValue: { callSaasBilling: async (op, params) => { calls.push([op, params]); return reply(); } } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication({ bodyParser: false });
  app.use(json({ strict: true })); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/hq/prospects`;
  try {
    const b = await send(`${base}/board`, { headers: read });
    assert.equal(b.status, 200, b.body);
    assert.deepEqual(calls.at(-1), ['readHqProspectBoard', ['verified-human']]);
    assert.equal((await send(`${base}/board?x=1`, { headers: read })).status, 400, 'no query on the board');
    reply = () => boardAnswer({ prospects: [card({ stageId: U() })] });
    assert.equal((await send(`${base}/board`, { headers: read })).status, 503, 'a prospect in an unknown stage is never shown');
    const key = U(), move = { expectedVersion: 1, stageId: S2, outcome: null };
    reply = () => ({ operation: 'MOVE', prospect: card({ stageId: S2, version: 2 }), replayed: false });
    const moved = await send(`${base}/${PID}/stage`, { method: 'POST', headers: command('hq-prospect-stage-move', key), body: JSON.stringify(move) });
    assert.equal(moved.status, 200, moved.body);
    assert.deepEqual(calls.at(-1), ['moveHqProspectStage', ['verified-human', PID, JSON.stringify(move), key]]);
    reply = () => ({ operation: 'MOVE', prospect: card({ stageId: S1, version: 2 }), replayed: false });
    assert.equal((await send(`${base}/${PID}/stage`, { method: 'POST', headers: command('hq-prospect-stage-move'), body: JSON.stringify(move) })).status, 503, 'a receipt for another stage is never shown');
    const n = calls.length;
    assert.equal((await send(`${base}/${PID}/stage`, { method: 'POST', headers: command('hq-prospect-update'), body: JSON.stringify(move) })).status, 403, 'wrong marker');
    assert.equal(calls.length, n);
    const input = { expectedVersion: 1, stages: [{ id: S2, name: 'Contacted', color: 'AMBER', hidden: false }, { id: S1, name: 'Lead', color: 'BLUE', hidden: false }], moves: [] };
    reply = () => ({ operation: 'STAGES', pipelineVersion: 2, stages: [stage(S2, 'Contacted', 1, { color: 'AMBER' }), stage(S1, 'Lead', 2)], replayed: false });
    const saved = await send(`${base}/stages`, { method: 'POST', headers: command('hq-prospect-stages-save'), body: JSON.stringify(input) });
    assert.equal(saved.status, 200, saved.body);
    assert.equal(calls.at(-1)[0], 'saveHqProspectStages');
    reply = () => ({ operation: 'STAGES', pipelineVersion: 2, stages: [stage(S1, 'Lead', 1), stage(S2, 'Contacted', 2)], replayed: false });
    assert.equal((await send(`${base}/stages`, { method: 'POST', headers: command('hq-prospect-stages-save'), body: JSON.stringify(input) })).status, 503, 'out-of-order answer refused');
    for (const code of ['HQ_PROSPECT_STAGE_MOVE_REQUIRED', 'HQ_PROSPECT_STAGE_NAME_TAKEN', 'HQ_PROSPECT_STAGE_UNAVAILABLE']) {
      reply = () => { const e = new Error(code); e.code = '23514'; throw e; };
      const r = await send(`${base}/stages`, { method: 'POST', headers: command('hq-prospect-stages-save'), body: JSON.stringify(input) });
      assert.deepEqual([r.status, JSON.parse(r.body).code], [422, code], code);
    }
  } finally { await app.close(); if (prior === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = prior; }
});
