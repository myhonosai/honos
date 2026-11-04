const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { AiUnknownResolutionHqController, AiUnknownResolutionService } = require('../dist/ai-spend/ai-unknown-resolution.controller.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

const U = () => randomUUID(), T = '2026-11-01T00:00:00.000Z';
const REASON = 'Synthetic resolution from provider evidence';
const record = (patch = {}) => ({ decision: 'RECORD_PROVIDER_COST', reason: REASON,
  evidence: { providerGenerationId: 'gen-synthetic-1', inputTokens: 1200, outputTokens: 600, providerCostMicrounits: 2400 }, ...patch });
const receipt = (patch = {}) => ({ resolutionId: U(), agent: 'MARKETING', invocationId: U(), organizationId: U(), schoolId: U(), decision: 'RECORD_PROVIDER_COST',
  releasedCredits: 6, ledgerEntryId: U(), customerCredits: 2, resolvedAt: T, replayed: false, ...patch });
const open = (patch = {}) => ({ agent: 'TEACHING', invocationId: U(), organizationId: U(), schoolId: U(), status: 'UNKNOWN', reservedCredits: 6, heldAt: T,
  countsAgainstCurrentWindow: true, ...patch });

test('S4-d contracts: closed evidence per decision; consistent receipts and queue', () => {
  assert.equal(contracts.validateAiUnknownResolutionInput(record()).decision, 'RECORD_PROVIDER_COST');
  assert.equal(contracts.validateAiUnknownResolutionInput({ decision: 'NO_PROVIDER_CHARGE', reason: REASON, evidence: { providerLookupReference: 'lookup-1' } }).decision, 'NO_PROVIDER_CHARGE');
  assert.equal(contracts.validateAiUnknownResolutionInput({ decision: 'WRITE_OFF', reason: REASON, evidence: { estimatedProviderCostMicrounits: 0 } }).decision, 'WRITE_OFF');
  for (const bad of [record({ decision: 'REFUND' }), record({ reason: 'short' }), record({ extra: 1 }), record({ evidence: {} }),
    record({ evidence: { ...record().evidence, inputTokens: -1 } }), record({ evidence: { ...record().evidence, inputTokens: 1.5 } }),
    record({ evidence: { ...record().evidence, providerGenerationId: 'has space' } }), record({ evidence: { ...record().evidence, organizationId: U() } }),
    { decision: 'WRITE_OFF', reason: REASON, evidence: { providerLookupReference: 'x' } }, { decision: 'NO_PROVIDER_CHARGE', reason: REASON, evidence: {} }])
    assert.throws(() => contracts.validateAiUnknownResolutionInput(bad), JSON.stringify(bad));
  assert.throws(() => contracts.validateAiUnknownAgent('IMAGES'));
  assert.equal(contracts.validateAiUnknownResolutionReceipt(receipt()).customerCredits, 2);
  assert.equal(contracts.validateAiUnknownResolutionReceipt(receipt({ decision: 'NO_PROVIDER_CHARGE', ledgerEntryId: null, customerCredits: null })).ledgerEntryId, null);
  for (const bad of [receipt({ decision: 'NO_PROVIDER_CHARGE' }), receipt({ ledgerEntryId: null }), receipt({ decision: 'WRITE_OFF', customerCredits: 3 }),
    receipt({ releasedCredits: 0 }), { ...receipt(), money: 0 }])
    assert.throws(() => contracts.validateAiUnknownResolutionReceipt(bad), JSON.stringify(bad));
  const { replayed, ...resolved } = receipt();
  const q = contracts.validateAiUnknownQueue({ open: [open(), open({ status: 'SENDING', countsAgainstCurrentWindow: false })],
    resolved: [{ ...resolved, reason: REASON, evidence: record().evidence, resolvedByPrincipalId: U(), priorStatus: 'UNKNOWN', heldAt: T, lateProviderExpense: null }], staleAfterSeconds: 3600, asOf: T });
  assert.equal(q.open.length, 2);
  // No trustworthy origin: heldAt null is only valid while the hold still counts (fail closed).
  assert.equal(contracts.validateAiUnknownQueue({ open: [open({ heldAt: null })], resolved: [], staleAfterSeconds: 3600, asOf: T }).open[0].heldAt, null);
  assert.throws(() => contracts.validateAiUnknownQueue({ open: [open({ heldAt: null, countsAgainstCurrentWindow: false })], resolved: [], staleAfterSeconds: 3600, asOf: T }));
  // A resolution always carries its original hold time: a NULL-origin hold is never resolvable (fail closed).
  const noCharge = { ...resolved, decision: 'NO_PROVIDER_CHARGE', ledgerEntryId: null, customerCredits: null, reason: REASON, evidence: { providerLookupReference: 'lookup-1' }, resolvedByPrincipalId: U(), priorStatus: 'UNKNOWN', lateProviderExpense: null };
  assert.equal(contracts.validateAiUnknownQueue({ open: [], staleAfterSeconds: 3600, asOf: T, resolved: [{ ...noCharge, heldAt: T }] }).resolved.length, 1);
  assert.throws(() => contracts.validateAiUnknownQueue({ open: [], staleAfterSeconds: 3600, asOf: T, resolved: [{ ...noCharge, heldAt: null }] }));
  // A late provider expense may only sit on a WRITE_OFF and carries no ledger entry of its own.
  const writeOff = { ...resolved, decision: 'WRITE_OFF', customerCredits: 0, reason: REASON, evidence: { estimatedProviderCostMicrounits: 900 }, resolvedByPrincipalId: U(), priorStatus: 'UNKNOWN', heldAt: T };
  const lateSummary = { expenseId: U(), providerCostMicrounits: 1100, occurredAt: T, recordedAt: T };
  assert.equal(contracts.validateAiUnknownQueue({ open: [], resolved: [{ ...writeOff, lateProviderExpense: lateSummary }], staleAfterSeconds: 3600, asOf: T }).resolved[0].lateProviderExpense.providerCostMicrounits, 1100);
  for (const bad of [{ ...writeOff, decision: 'RECORD_PROVIDER_COST', customerCredits: 2, lateProviderExpense: lateSummary }, { ...writeOff, lateProviderExpense: { ...lateSummary, ledgerEntryId: U() } }])
    assert.throws(() => contracts.validateAiUnknownQueue({ open: [], resolved: [bad], staleAfterSeconds: 3600, asOf: T }), JSON.stringify(bad));
  const late = { reason: 'Provider usage export showed the actual charge', evidence: { providerGenerationId: 'gen-late-1', inputTokens: 10, outputTokens: 5, providerCostMicrounits: 1100 } };
  assert.equal(contracts.validateAiLateProviderExpenseInput(late).evidence.providerCostMicrounits, 1100);
  for (const bad of [{ ...late, extra: 1 }, { ...late, evidence: { ...late.evidence, customerCredits: 1 } }, { ...late, evidence: { ...late.evidence, providerCostMicrounits: -1 } }, { ...late, reason: 'short' }])
    assert.throws(() => contracts.validateAiLateProviderExpenseInput(bad), JSON.stringify(bad));
  const lateReceipt = { expenseId: U(), resolutionId: U(), agent: 'TEACHING', invocationId: U(), providerCostMicrounits: 1100, estimatedProviderCostMicrounits: 900, customerCredits: 0, occurredAt: T, recordedAt: T, replayed: false };
  assert.equal(contracts.validateAiLateProviderExpenseReceipt(lateReceipt).customerCredits, 0);
  for (const bad of [{ ...lateReceipt, customerCredits: 1 }, { ...lateReceipt, ledgerEntryId: U() }, { ...lateReceipt, occurredAt: null }])
    assert.throws(() => contracts.validateAiLateProviderExpenseReceipt(bad), JSON.stringify(bad));
  for (const bad of [open({ status: 'RESULT_RECORDED' }), open({ reservedCredits: 0 }), { ...open(), extra: 1 }])
    assert.throws(() => contracts.validateAiUnknownQueue({ open: [bad], resolved: [], staleAfterSeconds: 3600, asOf: T }), JSON.stringify(bad));
  assert.throws(() => contracts.validateAiUnknownQueue({ open: Array.from({ length: 201 }, () => open()), resolved: [], staleAfterSeconds: 3600, asOf: T }));
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
async function appWith(callSaasBilling) {
  const module = await Test.createTestingModule({ controllers: [AiUnknownResolutionHqController],
    providers: [AiUnknownResolutionService, SaasBillingService, SaasReadGuard, SaasCommandGuard, { provide: RuntimeDatabaseService, useValue: { callSaasBilling } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication({ bodyParser: false });
  app.use(json({ strict: true })); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${app.getHttpServer().address().port}/v1` };
}

test('HTTP: UNKNOWN resolution is an exact HQ human command bound to the verified subject; refusals never reach the database', async () => {
  const previous = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = [], id = U();
  const human = (command = contracts.SAAS_COMMANDS.aiUnknownResolve) => ({ 'content-type': 'application/json', origin: 'https://hon.example', 'x-hon-human-command': command,
    'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty', 'idempotency-key': randomUUID() });
  let next = null;
  const { app, base } = await appWith(async (operation, params) => {
    calls.push([operation, params]);
    if (next) { const e = new Error(next.message); e.code = next.code; next = null; throw e; }
    if (operation === 'readAiUnknownInvocations') return { open: [open()], resolved: [], staleAfterSeconds: 3600, asOf: T };
    if (operation === 'resolveAiUnknownInvocation') return receipt({ agent: params[1], invocationId: params[2] });
    if (operation === 'recordAiLateProviderExpense') return { expenseId: U(), resolutionId: U(), agent: params[1], invocationId: params[2], providerCostMicrounits: 1100,
      estimatedProviderCostMicrounits: 900, customerCredits: 0, occurredAt: T, recordedAt: T, replayed: false };
    throw new Error('unexpected');
  });
  const url = `${base}/hq/ai/unknown-invocations/MARKETING/${id}/resolve`;
  try {
    const q = await send(`${base}/hq/ai/unknown-invocations`);
    assert.equal(q.status, 200, q.body); assert.match(q.headers['cache-control'], /no-store/);
    assert.deepEqual(calls.at(-1), ['readAiUnknownInvocations', ['verified-human']]);
    const body = JSON.stringify(record()), headers = human();
    const ok = await send(url, { method: 'POST', headers, body });
    assert.equal(ok.status, 200, ok.body); assert.equal(JSON.parse(ok.body).data.invocationId, id);
    const [op, params] = calls.at(-1);
    assert.equal(op, 'resolveAiUnknownInvocation');
    assert.deepEqual(params.slice(0, 5), ['verified-human', 'MARKETING', id, body, headers['idempotency-key']]);
    assert.equal(params.length, 7);
    for (const [message, code, status, expected] of [['SAAS_FORBIDDEN', '42501', 403, 'SAAS_FORBIDDEN'], ['AI_UNKNOWN_KEY_REUSED', '23505', 409, 'IDEMPOTENCY_KEY_REUSED'],
      ['AI_UNKNOWN_NOT_RESOLVABLE', '23514', 422, 'AI_UNKNOWN_NOT_RESOLVABLE'], ['AI_UNKNOWN_INVOCATION_NOT_FOUND', 'P0002', 404, 'SAAS_UNAVAILABLE'],
      ['private detail', 'XX000', 503, 'SAAS_UNAVAILABLE']]) {
      next = { message, code };
      const r = await send(url, { method: 'POST', headers: human(), body });
      assert.deepEqual([r.status, JSON.parse(r.body).code], [status, expected], message);
    }
    const n = calls.length;
    const { 'idempotency-key': _key, ...noKey } = human();
    for (const [target, h, payload, label] of [
      [url, human(contracts.SAAS_COMMANDS.aiSpendPause), body, 'wrong command header'],
      [url, { ...human(), origin: 'https://evil.example' }, body, 'foreign origin'],
      [url, { ...human(), 'x-hon-subject': 'other' }, body, 'extra X-HON header'],
      [url, noKey, body, 'no idempotency key'],
      [`${base}/hq/ai/unknown-invocations/IMAGES/${id}/resolve`, human(), body, 'unknown agent'],
      [`${base}/hq/ai/unknown-invocations/MARKETING/not-a-uuid/resolve`, human(), body, 'bad invocation id'],
      [url, human(), JSON.stringify(record({ resolvedByPrincipalId: U() })), 'browser names the resolver'],
      [url, human(), JSON.stringify(record({ evidence: {} })), 'no evidence']])
      assert.ok([400, 403].includes((await send(target, { method: 'POST', headers: h, body: payload })).status), label);
    assert.equal((await send(`${base}/hq/ai/unknown-invocations?organizationId=${U()}`)).status, 400, 'reads take no query');
    assert.equal(calls.length, n, 'refused requests never reach the database');
    // Late provider expense after a WRITE_OFF: its own exact HQ human command.
    const lateUrl = `${base}/hq/ai/unknown-invocations/TEACHING/${id}/late-provider-expense`;
    const lateBody = JSON.stringify({ reason: 'Provider usage export showed the actual charge', evidence: { providerGenerationId: 'gen-late-1', inputTokens: 10, outputTokens: 5, providerCostMicrounits: 1100 } });
    const lateHeaders = human(contracts.SAAS_COMMANDS.aiLateProviderExpense);
    const lateOk = await send(lateUrl, { method: 'POST', headers: lateHeaders, body: lateBody });
    assert.equal(lateOk.status, 200, lateOk.body); assert.equal(JSON.parse(lateOk.body).data.customerCredits, 0);
    assert.deepEqual(calls.at(-1)[1].slice(0, 5), ['verified-human', 'TEACHING', id, lateBody, lateHeaders['idempotency-key']]);
    for (const message of ['AI_LATE_EXPENSE_NOT_WRITTEN_OFF', 'AI_LATE_EXPENSE_ALREADY_RECORDED', 'AI_LATE_EXPENSE_DUPLICATE_GENERATION']) {
      next = { message, code: '23514' };
      const r = await send(lateUrl, { method: 'POST', headers: human(contracts.SAAS_COMMANDS.aiLateProviderExpense), body: lateBody });
      assert.deepEqual([r.status, JSON.parse(r.body).code], [422, message]);
    }
    next = { message: 'AI_LATE_EXPENSE_KEY_REUSED', code: '23505' };
    assert.equal((await send(lateUrl, { method: 'POST', headers: human(contracts.SAAS_COMMANDS.aiLateProviderExpense), body: lateBody })).status, 409);
    const m = calls.length;
    for (const [h, payload, label] of [[human(), lateBody, 'resolve command header on the late route'],
      [human(contracts.SAAS_COMMANDS.aiLateProviderExpense), JSON.stringify({ ...JSON.parse(lateBody), customerCredits: 1 }), 'browser names credits']])
      assert.ok([400, 403].includes((await send(lateUrl, { method: 'POST', headers: h, body: payload })).status), label);
    assert.equal(calls.length, m, 'refused late-expense requests never reach the database');
  } finally { await app.close(); if (previous === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = previous; }
});
