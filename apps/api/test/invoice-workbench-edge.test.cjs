const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
require('reflect-metadata');
const { ValidationPipe, UnauthorizedException } = require('@nestjs/common');
const { GUARDS_METADATA } = require('@nestjs/common/constants');
const { Test } = require('@nestjs/testing');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { InvoiceController } = require('../dist/billing/invoice.controller.js');
const { InvoiceService } = require('../dist/billing/invoice.service.js');
const { InvoiceHumanUiGuard } = require('../dist/billing/invoice-human-ui.guard.js');
const { CreateInvoiceDraftDto } = require('../dist/billing/create-invoice-draft.dto.js');
const { IssueInvoiceDto } = require('../dist/billing/issue-invoice.dto.js');
const organizationId = randomUUID(), schoolId = randomUUID(), billingAccountId = randomUUID(), membershipId = randomUUID(), invoiceId = randomUUID(), principalId = randomUUID();
const input = { billingAccountId, membershipId, currency: 'USD', subtotalMinor: 1250, dueAt: '2030-05-01T09:15:30-07:00' };
const status = n => e => e.getStatus?.() === n;

test('invoice controller retains identity first, canonical paths/DTOs/services and only adds the existing transport convention', () => {
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, InvoiceController), [HonIdentityGuard, InvoiceHumanUiGuard]);
  const module = readFileSync(join(__dirname, '../src/app.module.ts'), 'utf8');
  assert(module.includes("import { InvoiceHumanUiGuard } from './billing/invoice-human-ui.guard.js'"));
  assert(module.includes('    InvoiceHumanUiGuard,'));
  const controller = readFileSync(join(__dirname, '../src/billing/invoice.controller.ts'), 'utf8');
  assert.equal((controller.match(/@Post\(/g) || []).length, 2);
  assert.doesNotMatch(controller, /@Get|@Patch|@Delete|@Put|PaymentService|ActionEngineService|fetch\(/);
});

test('invoice human transport guard denies absent/malformed/cross-site origin, marker, method and non-JSON, fails closed without configured origin', () => {
  const before = process.env.HON_PUBLIC_ORIGIN, guard = new InvoiceHumanUiGuard();
  const run = (headers, method = 'POST') => guard.canActivate({ switchToHttp: () => ({ getRequest: () => ({ method, headers }) }) });
  try {
    process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
    const headers = { origin: 'https://hon.test', 'content-type': 'application/json', 'x-hon-human-command': 'billing-invoice', 'sec-fetch-site': 'same-origin' };
    assert.equal(run(headers), true); assert.equal(run({ ...headers, 'content-type': 'application/json; charset=utf-8' }), true);
    for (const patch of [{ origin: undefined }, { origin: 'null' }, { origin: 'https://evil.test' }, { origin: 'https://hon.test/path' }, { origin: ['https://hon.test'] }, { 'x-hon-human-command': undefined }, { 'x-hon-human-command': 'billing-membership' }, { 'x-hon-human-command': 'AUTOMATION' }, { 'sec-fetch-site': 'cross-site' }, { 'content-type': undefined }, { 'content-type': 'text/plain' }, { 'content-type': 'application/json-malformed' }]) assert.throws(() => run({ ...headers, ...patch }), status(403));
    for (const method of ['PATCH', 'PUT', 'DELETE']) assert.throws(() => run(headers, method), status(403));
    for (const origin of [undefined, '', 'https://hon.test/path', 'https://user:secret@hon.test']) {
      if (origin === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = origin;
      assert.throws(() => run(headers), status(503));
    }
  } finally { if (before === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = before; }
});

test('canonical invoice DTOs stay closed to authored financial/authority/version facts; issue accepts only expectedVersion', async () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  assert.deepEqual({ ...await pipe.transform(input, { type: 'body', metatype: CreateInvoiceDraftDto }) }, input);
  assert.deepEqual({ ...await pipe.transform({ expectedVersion: 1 }, { type: 'body', metatype: IssueInvoiceDto }) }, { expectedVersion: 1 });
  for (const patch of [{ currency: 'ZZZ' }, { currency: 'usd' }, { subtotalMinor: -1 }, { subtotalMinor: 2147483648 }, { subtotalMinor: '1250' }, { subtotalMinor: 1.5 }, { dueAt: '2030-05-01T09:15:30' }, { dueAt: '2030-02-30T09:15:30Z' }, { billingAccountId: 'name' }, { membershipId: 'name' }]) await assert.rejects(() => pipe.transform({ ...input, ...patch }, { type: 'body', metatype: CreateInvoiceDraftDto }), status(400));
  for (const name of ['organizationId', 'schoolId', 'invoiceId', 'version', 'expectedVersion', 'totalMinor', 'discountMinor', 'status', 'principalId', 'principalType', 'source', 'actionRequestId', 'delegatedByPrincipalId', 'audit', 'outbox']) await assert.rejects(() => pipe.transform({ ...input, [name]: principalId }, { type: 'body', metatype: CreateInvoiceDraftDto }), status(400));
  for (const name of [...Object.keys(input), 'organizationId', 'schoolId', 'invoiceId', 'status', 'totalMinor', 'discountMinor', 'version', 'actor', 'principalId', 'source', 'actionRequestId', 'delegatedByPrincipalId']) await assert.rejects(() => pipe.transform({ expectedVersion: 1, [name]: principalId }, { type: 'body', metatype: IssueInvoiceDto }), status(400));
  for (const expectedVersion of [0, -1, 1.5, '1', null]) await assert.rejects(() => pipe.transform({ expectedVersion }, { type: 'body', metatype: IssueInvoiceDto }), status(400));
});

test('existing service rejects nonhuman sources and delegated/action issue before any transaction; no downstream service added', async () => {
  let transactions = 0;
  const service = new InvoiceService({ withTenantTransaction() { transactions++; throw new Error('unexpected persistence'); } });
  const context = { organizationId, schoolId, principalId, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID() };
  for (const patch of [{ principalType: 'AI_EMPLOYEE' }, { principalType: 'AUTOMATION' }, { principalType: 'INTEGRATION' }, { source: 'AI' }, { source: 'AUTOMATION' }]) {
    await assert.rejects(() => service.createDraft({ ...context, ...patch }, input), status(403));
    await assert.rejects(() => service.issue({ ...context, ...patch }, invoiceId, { expectedVersion: 1 }), status(403));
  }
  for (const patch of [{ actionRequestId: randomUUID() }, { delegatedByPrincipalId: randomUUID() }]) await assert.rejects(() => service.issue({ ...context, ...patch }, invoiceId, { expectedVersion: 1 }), status(403));
  assert.equal(transactions, 0);
  assert.doesNotMatch(readFileSync(join(__dirname, '../src/billing/invoice.service.ts'), 'utf8'), /Payment\w*Service|Communication\w*Service|ActionEngineService|Provider\w*Service|fetch\(|invokeProvider/);
});

test('invoice draft and issue read active billing entitlement before idempotency or invoice locks; denial and Essential replay preserve that boundary', async () => {
  const context = { organizationId, schoolId, principalId, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID() };
  const draft = { id: invoiceId, billingAccountId, membershipId, status: 'DRAFT', currency: 'USD', subtotalMinor: 1250, discountMinor: 0, totalMinor: 1250, dueAt: '2030-05-01T16:15:30.000Z', version: 1, createdAt: '2026-10-17T00:00:00.000Z' };
  const issued = { ...draft, status: 'ISSUED', version: 2 };

  for (const [name, invoke, replay] of [
    ['draft', (service) => service.createDraft(context, input), draft],
    ['issue', (service) => service.issue(context, invoiceId, { expectedVersion: 1 }), issued],
  ]) {
    const deniedCalls = [];
    const denied = new InvoiceService({ withTenantTransaction: async (_context, work) => work({ query: async (sql, args = []) => {
      deniedCalls.push({ sql, args });
      assert.equal(deniedCalls.length, 1, 'a missing entitlement cannot reach invoice or idempotency work');
      assert.match(sql, /SELECT tier FROM hon\.read_current_organization_entitlement\(\)/);
      assert.deepEqual(args, []);
      assert.doesNotMatch(sql, /organization_entitlements/i);
      return { rows: [], rowCount: 0 };
    } }) });
    await assert.rejects(() => invoke(denied), (error) => error.getStatus?.() === 403 && error.getResponse().code === 'TIER_ENTITLEMENT_REQUIRED');
    assert.equal(deniedCalls.length, 1);

    const calls = [];
    let requestFingerprint;
    const service = new InvoiceService({ withTenantTransaction: async (_context, work) => work({ query: async (sql, args = []) => {
      calls.push({ sql, args });
      assert.doesNotMatch(sql, /organization_entitlements/i);
      if (sql.includes('hon.read_current_organization_entitlement()')) {
        assert.equal(calls.length, 1, 'the entitlement reader is the first tenant operation');
        assert.deepEqual(args, []);
        return { rows: [{ tier: 'ESSENTIAL' }], rowCount: 1 };
      }
      if (sql.includes('FROM hon.invoices') && sql.includes('FOR UPDATE')) {
        assert.equal(name, 'issue');
        return { rows: [draft], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO hon.idempotency_records')) {
        requestFingerprint = args[4];
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT request_fingerprint, status, response_body') && sql.includes('hon.idempotency_records')) {
        assert.equal(typeof requestFingerprint, 'string');
        return { rows: [{ request_fingerprint: requestFingerprint, status: 'COMPLETED', response_body: replay }], rowCount: 1 };
      }
      throw new Error(`Unexpected ${name} replay query: ${sql}`);
    } }) });
    const result = await invoke(service);
    assert.deepEqual(result, { invoice: replay, replayed: true });
    assert.match(calls[0].sql, /read_current_organization_entitlement/);
    if (name === 'issue') assert(calls.findIndex(({ sql }) => sql.includes('FROM hon.invoices')) < calls.findIndex(({ sql }) => sql.includes('INSERT INTO hon.idempotency_records')));
  }
});

test('real loopback HTTP runs identity, trusted-human transport and exact live permission/DTO before only canonical createDraft/issue; envelope/replays unchanged', async () => {
  const before = process.env.HON_PUBLIC_ORIGIN;
  const calls = [], resolutions = [];
  let authorized = true, replayed = false;
  const draft = { id: invoiceId, billingAccountId, membershipId, status: 'DRAFT', currency: 'USD', subtotalMinor: 1250, discountMinor: 0, totalMinor: 1250, dueAt: '2030-05-01T16:15:30.000Z', version: 1, createdAt: '2026-10-17T00:00:00.000Z' };
  const database = { resolveAuthorizedScope: async (...args) => { resolutions.push(args); return authorized ? { organizationId, schoolId, principalId } : undefined; } };
  const invoices = {
    createDraft: async (context, body) => { calls.push({ operation: 'CREATE', context, body }); return { invoice: draft, replayed }; },
    issue: async (context, id, body) => { calls.push({ operation: 'ISSUE', context, id, body }); return { invoice: { ...draft, status: 'ISSUED', version: 2 }, replayed }; },
  };
  const module = await Test.createTestingModule({ controllers: [InvoiceController], providers: [InvoiceHumanUiGuard, { provide: RuntimeDatabaseService, useValue: database }, { provide: InvoiceService, useValue: invoices }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate: context => {
      const request = context.switchToHttp().getRequest();
      if (request.headers.cookie !== 'test-human-session=verified') throw new UnauthorizedException();
      request.honIdentity = { externalSubject: 'verified-human-subject' }; return true;
    } }).compile();
  const app = module.createNestApplication({ logger: false }); app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  try {
    process.env.HON_PUBLIC_ORIGIN = 'https://hon.test'; await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl(), route = `/v1/organizations/${organizationId}/schools/${schoolId}/billing/invoices`, issueRoute = `${route}/${invoiceId}/issue`;
    const headers = { Cookie: 'test-human-session=verified', Origin: 'https://hon.test', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'billing-invoice', 'Idempotency-Key': randomUUID() };
    const post = (path = route, body = input, patch = {}) => fetch(origin + path, { method: 'POST', headers: { ...headers, ...patch }, body: JSON.stringify(body) });
    for (const [path, body] of [[route, input], [issueRoute, { expectedVersion: 1 }]]) {
      assert.equal((await post(path, body, { Cookie: '' })).status, 401);
      assert.equal((await post(path, body, { 'X-HON-Human-Command': '' })).status, 403);
      assert.equal((await post(path, body, { Origin: 'https://evil.test' })).status, 403);
      assert.equal((await post(path, body, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
      assert.equal((await post(path, { ...body, principalId })).status, 400);
      assert.equal((await post(path, body, { 'Idempotency-Key': '' })).status, 409);
      assert.equal((await post(path.replace(organizationId, randomUUID()), body)).status, 403);
      authorized = false; assert.equal((await post(path, body)).status, 403); authorized = true;
    }
    assert.equal((await post(route, { ...input, totalMinor: 0 })).status, 400);
    assert.equal((await post(issueRoute, { expectedVersion: 1, invoiceId })).status, 400);
    assert.equal((await post(issueRoute.replace(invoiceId, 'a-name'), { expectedVersion: 1 })).status, 400);
    assert.equal(calls.length, 0);
    const created = await post(); assert.equal(created.status, 201); const receipt = await created.json();
    assert.deepEqual(receipt.data, draft); assert.deepEqual(Object.keys(receipt), ['data', 'meta']); assert.equal(receipt.meta.replayed, false); assert.equal(receipt.meta.requestId, receipt.meta.correlationId);
    assert.deepEqual(resolutions.at(-1), ['verified-human-subject', schoolId, 'billing.invoice.create']);
    const issueKey = randomUUID(); const issued = await post(issueRoute, { expectedVersion: 1 }, { 'Idempotency-Key': issueKey });
    assert.equal(issued.status, 200); assert.equal((await issued.json()).data.status, 'ISSUED');
    assert.deepEqual(resolutions.at(-1), ['verified-human-subject', schoolId, 'billing.invoice.issue']);
    assert.deepEqual({ ...calls[0].body }, input); assert.deepEqual({ ...calls[1].body }, { expectedVersion: 1 }); assert.equal(calls[1].id, invoiceId);
    for (const call of calls) {
      assert.equal(call.context.source, 'HUMAN_UI'); assert.equal(call.context.principalType, 'HUMAN_USER'); assert.equal(call.context.principalId, principalId);
      assert.equal(call.context.organizationId, organizationId); assert.equal(call.context.schoolId, schoolId);
      assert(!call.context.actionRequestId && !call.context.delegatedByPrincipalId);
    }
    assert.equal(calls[1].context.idempotencyKey, issueKey);
    replayed = true; const replay = await post(); assert.equal(replay.status, 200); assert.equal((await replay.json()).meta.replayed, true);
    const issueReplay = await post(issueRoute, { expectedVersion: 1 }, { 'Idempotency-Key': issueKey }); assert.equal(issueReplay.status, 200); assert.equal((await issueReplay.json()).meta.replayed, true);
    for (const path of [route, `${route}/${invoiceId}`, issueRoute]) assert.equal((await fetch(origin + path, { headers })).status, 404);
    delete process.env.HON_PUBLIC_ORIGIN; assert.equal((await post()).status, 503); assert.equal(calls.length, 4);
  } finally { await app.close(); if (before === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = before; }
});
