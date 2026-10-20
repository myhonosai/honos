const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
const { Test } = require('@nestjs/testing');
const { UnauthorizedException, ValidationPipe } = require('@nestjs/common');
const { validateCreateBillingAccountInput } = require('@hon/contracts');
const { BillingAccountController } = require('../dist/billing/billing-account.controller.js');
const { BillingAccountService } = require('../dist/billing/billing-account.service.js');
const { BillingAccountHumanUiGuard } = require('../dist/billing/billing-account-human-ui.guard.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');

const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const person = randomUUID();
const input = (patch = {}) => ({ responsiblePersonId: person, currency: 'USD', ...patch });
const account = (patch = {}) => ({ id: randomUUID(), responsiblePersonId: person, currency: 'USD', classification: 'CANONICAL', version: 1, createdAt: '2026-10-18T01:02:03.000Z', reused: false, ...patch });
const status = code => error => { assert.equal(error.getStatus(), code); return true; };

function context(key = randomUUID()) { return { ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: key }; }

test('billing account input is closed: additional accounts require a bounded reason and normal requests forbid one', () => {
  validateCreateBillingAccountInput(input());
  validateCreateBillingAccountInput(input({ additionalReason: undefined }));
  validateCreateBillingAccountInput(input({ createAdditional: true, additionalReason: 'Separate authorized household arrangement.' }));
  for (const value of [null, [], {}, input({ createAdditional: 'true' }), input({ additionalReason: 'why' }), input({ createAdditional: true }), input({ createAdditional: true, additionalReason: '' }), input({ createAdditional: true, additionalReason: ' reason' }), input({ createAdditional: true, additionalReason: 'x'.repeat(501) }), input({ currency: 'usd' }), input({ organizationId: scope.organizationId }), input({ actionRequestId: randomUUID() })]) assert.throws(() => validateCreateBillingAccountInput(value));
});

test('billing account controller derives direct-human scope and returns only response-backed classification and reuse facts', async () => {
  const calls = []; const response = { status(code) { this.code = code; return this; } }; const reused = account({ reused: true });
  const controller = new BillingAccountController({ resolveAuthorizedScope: async (...args) => { calls.push(args); return scope; } }, { create: async (command, body) => { calls.push({ command, body }); return { account: reused, replayed: false }; } });
  const result = await controller.create(scope.organizationId, scope.schoolId, randomUUID(), input(), { honIdentity: { externalSubject: 'signed-subject' } }, response);
  assert.equal(response.code, 200); assert.deepEqual(result.data, reused); assert.equal(result.meta.replayed, false);
  assert.deepEqual(calls[0], ['signed-subject', scope.schoolId, 'billing.account.create']); assert.equal(calls[1].command.principalType, 'HUMAN_USER'); assert.equal(calls[1].command.source, 'HUMAN_UI');
  const denied = new BillingAccountController({ resolveAuthorizedScope: async () => ({ ...scope, organizationId: randomUUID() }) }, {});
  await assert.rejects(() => denied.create(scope.organizationId, scope.schoolId, randomUUID(), input(), { honIdentity: { externalSubject: 'signed-subject' } }, response), status(403));
});

test('canonical service reuses exact currency without outbox, creates audited additional accounts, and preserves exact replay', async () => {
  const canonical = account(); const calls = []; let replay = false; let fingerprint = '';
  const database = { withTenantTransaction: async (_context, work) => work({ query: async (sql, args = []) => {
    calls.push({ sql, args });
    if (sql.includes('require_current_direct_human_billing_account_actor') || sql.includes('FROM hon.principals')) return { rows: [{ authorized: true }], rowCount: 1 };
    if (sql.includes('read_current_organization_entitlement')) return { rows: [{ tier: 'CORE' }], rowCount: 1 };
    if (sql.includes('INSERT INTO hon.idempotency_records')) { fingerprint = args[4]; return { rows: replay ? [] : [{ id: randomUUID() }], rowCount: replay ? 0 : 1 }; }
    if (sql.includes('SELECT request_fingerprint')) return { rows: [{ request_fingerprint: fingerprint, status: 'COMPLETED', response_body: { ...canonical, reused: true } }], rowCount: 1 };
    if (sql.includes('FROM hon.people')) return { rows: [{ id: person }], rowCount: 1 };
    if (sql.includes('FROM hon.billing_accounts')) return { rows: [canonical], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  } }) };
  const service = new BillingAccountService(database);
  const first = await service.create(context(), input());
  assert.deepEqual(first, { account: { ...canonical, reused: true }, replayed: false });
  assert(calls.some(call => call.sql.includes('billing.account.reuse'))); assert(!calls.some(call => call.sql.includes('billing.account.created')));
  calls.length = 0; replay = true;
  const replayed = await service.create(context(), input());
  assert.deepEqual(replayed, { account: { ...canonical, reused: true }, replayed: true }); assert(!calls.some(call => call.sql.includes('audit_events')));

  const extra = account({ id: randomUUID(), classification: 'ADDITIONAL' }); calls.length = 0; replay = false;
  database.withTenantTransaction = async (_context, work) => work({ query: async (sql, args = []) => {
    calls.push({ sql, args });
    if (sql.includes('require_current_direct_human_billing_account_actor') || sql.includes('FROM hon.principals')) return { rows: [{ authorized: true }], rowCount: 1 };
    if (sql.includes('read_current_organization_entitlement')) return { rows: [{ tier: 'CORE' }], rowCount: 1 };
    if (sql.includes('INSERT INTO hon.idempotency_records')) return { rows: [{ id: randomUUID() }], rowCount: 1 };
    if (sql.includes('FROM hon.people')) return { rows: [{ id: person }], rowCount: 1 };
    if (sql.includes('FROM hon.billing_accounts')) return { rows: [canonical], rowCount: 1 };
    if (sql.includes('INSERT INTO hon.billing_accounts')) return { rows: [extra], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  } });
  const created = await service.create(context(), input({ createAdditional: true, additionalReason: 'Separate authorized household arrangement.' }));
  assert.deepEqual(created, { account: { ...extra, reused: false }, replayed: false });
  assert(calls.some(call => call.sql.includes('billing.account.create')) && calls.some(call => call.sql.includes('billing.account.created')));
  const audit = calls.find(call => call.sql.includes('audit_events')); assert.match(audit.args[5], /additionalReason/);
});

test('canonical service rejects a conflicting normal currency and non-direct-human context without mutation', async () => {
  const canonical = account(); const calls = [];
  const service = new BillingAccountService({ withTenantTransaction: async (_context, work) => work({ query: async (sql) => {
    calls.push(sql); if (sql.includes('require_current_direct_human_billing_account_actor') || sql.includes('FROM hon.principals')) return { rows: [{ authorized: true }], rowCount: 1 };
    if (sql.includes('read_current_organization_entitlement')) return { rows: [{ tier: 'CORE' }], rowCount: 1 };
    if (sql.includes('idempotency_records')) return { rows: [{ id: randomUUID() }], rowCount: 1 };
    if (sql.includes('FROM hon.people')) return { rows: [{ id: person }], rowCount: 1 };
    if (sql.includes('FROM hon.billing_accounts')) return { rows: [canonical], rowCount: 1 }; return { rows: [], rowCount: 1 };
  } }) });
  await assert.rejects(() => service.create(context(), input({ currency: 'EUR' })), status(409));
  assert(!calls.some(sql => sql.includes('INSERT INTO hon.billing_accounts')));
  await assert.rejects(() => service.create({ ...context(), source: 'AI' }, input()), status(403));
});

test('strict POST guard rejects cross-site, delegated, malformed and lookup-idempotency requests before scope resolution', async () => {
  const old = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
  let authenticated = true; let scopes = 0;
  const accounts = { create: async () => ({ account: account(), replayed: false }), lookupPayers: async () => [{ id: person, displayName: 'Ari Stone' }] };
  const database = { resolveAuthorizedScope: async () => { scopes++; return scope; } };
  const module = await Test.createTestingModule({ controllers: [BillingAccountController], providers: [BillingAccountHumanUiGuard, { provide: RuntimeDatabaseService, useValue: database }, { provide: BillingAccountService, useValue: accounts }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { if (!authenticated) throw new UnauthorizedException(); context.switchToHttp().getRequest().honIdentity = { externalSubject: 'signed-subject' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })); await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/billing/accounts`;
  const headers = { Origin: 'https://hon.test', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'billing.account.create', 'Idempotency-Key': randomUUID(), 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'empty' };
  const post = (path = '', payload = input(), patch = {}) => new Promise((resolve, reject) => { const target = new URL(base + path); const all = { ...headers, ...patch }; for (const key of Object.keys(all)) if (all[key] === undefined) delete all[key]; const req = httpRequest({ hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: 'POST', headers: all }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers }))); }); req.on('error', reject); req.end(JSON.stringify(payload)); });
  try {
    const first = await post(); assert.equal(first.status, 201, await first.text()); assert.equal(first.headers.get('cache-control'), 'private, no-store');
    for (const patch of [{ Origin: 'https://bad.test' }, { 'X-HON-Human-Command': 'billing.account.reuse' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Mode': 'cors' }, { 'Sec-Fetch-Dest': 'document' }, { 'X-HON-Delegated-By-Principal-Id': randomUUID() }, { 'Content-Type': 'text/plain' }]) assert.equal((await post('', input(), patch)).status, 403);
    for (const payload of [input({ additionalReason: 'not allowed' }), input({ createAdditional: true }), input({ createAdditional: true, additionalReason: '' }), input({ source: 'AI' })]) assert.equal((await post('', payload)).status, 400);
    assert.equal((await post('?x=1')).status, 400); assert.equal((await post('', input(), { 'Idempotency-Key': undefined })).status, 409);
    assert.equal((await post('/payer-lookup', { query: 'Ar' }, { 'Idempotency-Key': undefined })).status, 200);
    assert.equal((await post('/payer-lookup', { query: 'Ar' })).status, 400);
    authenticated = false; assert.equal((await post()).status, 401); assert.equal((await post()).headers?.get?.('cache-control'), null);
    assert(scopes >= 2 && scopes < 6, 'only valid command and valid payer lookup may resolve scope');
  } finally { await app.close(); if (old === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = old; }
});
