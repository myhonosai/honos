const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { Test } = require('@nestjs/testing');
const { ParentBillingViewService } = require('../dist/families/parent-billing-view.service.js');
const { ParentBillingViewController, ParentBillingReadGuard } = require('../dist/families/parent-billing-view.controller.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const scope = { principalId: randomUUID(), organizationId: randomUUID(), schoolId: randomUUID(), familyId: randomUUID(), accessLevel: 'PRIMARY_GUARDIAN' };
const timestamp = '2026-01-01T00:00:00.000Z';
const projection = { generatedAt: timestamp, accessLevel: 'PRIMARY_GUARDIAN', memberships: { status: 'AVAILABLE', limited: false, items: [{ participant: { displayName: 'Current child', linkage: 'CURRENT_FAMILY_STUDENT' }, payerLinkage: 'CURRENT_FAMILY_DESIGNATED_BILLING_CONTACT', state: 'ACTIVE', termStartedAt: timestamp, termEndsAt: null }] }, invoices: { status: 'AVAILABLE', limited: false, items: [{ participant: { displayName: 'Current child', linkage: 'CURRENT_FAMILY_STUDENT' }, status: 'ISSUED', currency: 'USD', totalMinor: 1000, dueAt: null, paymentAttempts: { status: 'AVAILABLE', limited: false, items: [{ state: 'PENDING', amountMinor: 1000, currency: 'USD', initiatedAt: timestamp, reconciledAt: null }] } }] } };
const status = code => error => { assert.equal(error.getStatus(), code); return true; };

test('parent billing service derives a single guardian current-family scope and invokes only its fixed read projection', async () => {
  const calls = []; const db = {
    resolveParentJourneyScopes: async subject => { calls.push(['scope', subject]); return [scope]; },
    readParentBillingView: async subject => { calls.push(['projection', subject]); return projection; },
  };
  const service = new ParentBillingViewService(db); const result = await service.get('verified-guardian');
  assert.deepEqual(result.data, projection); assert.equal(result.meta.requestId, result.meta.correlationId);
  assert.deepEqual(calls, [['scope', 'verified-guardian'], ['scope', 'verified-guardian'], ['projection', 'verified-guardian'], ['scope', 'verified-guardian'], ['scope', 'verified-guardian']]);
  await assert.rejects(() => new ParentBillingViewService({ resolveParentJourneyScopes: async () => [{ ...scope, accessLevel: 'VIEWER' }] }).get('viewer'), status(403));
  await assert.rejects(() => new ParentBillingViewService({ resolveParentJourneyScopes: async () => [scope, { ...scope, familyId: randomUUID() }] }).get('ambiguous'), status(409));
});

test('parent billing has no staff, HQ, AI, provider, action, payment-method, or mutation dependency', () => {
  for (const file of ['parent-billing-view.service.ts', 'parent-billing-view.controller.ts']) {
    const source = readFileSync(`src/families/${file}`, 'utf8');
    assert.doesNotMatch(source, /from\s+['"][^'"]*(?:action|ai|voice|payment|provider|communication|work-items)[^'"]*['"]|ActionEngineService|Ai\w*Service|Voice\w*Service|Payment\w*Service|InvoiceService|MembershipService|fetch\(/);
  }
  const migration = readFileSync('../../packages/database/migrations/0102_parent_billing_read_foundation.sql', 'utf8');
  assert.match(migration, /read_parent_billing_view\(p_subject text\)/); assert.match(migration, /PAYER_LINK_UNVERIFIED/);
  assert.doesNotMatch(migration, /(?:INSERT\s+INTO|UPDATE\s+hon\.|DELETE\s+FROM)\s+hon\.(?:audit_events|outbox_events|memberships|invoices|payment_attempts|billing_accounts|communication_messages|action_requests|work_items|ai_usage_ledger)/i);
  assert.doesNotMatch(migration, /provider_(?:code|account|payment|idempotency)_reference/);
});

test('parent billing controller rejects all selectors, mutation-shaped headers and cross-site GETs', async () => {
  const controller = new ParentBillingViewController({ get: async subject => ({ data: projection, meta: { requestId: subject, correlationId: subject } }) });
  const request = { method: 'GET', headers: {}, body: undefined, originalUrl: '/parent/billing', honIdentity: { externalSubject: 'verified-guardian' } };
  await assert.deepEqual(await controller.read({}, request), { data: projection, meta: { requestId: 'verified-guardian', correlationId: 'verified-guardian' } });
  for (const candidate of [
    { method: 'POST', headers: {}, body: undefined, originalUrl: '/parent/billing' },
    { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' }, body: undefined, originalUrl: '/parent/billing' },
    { method: 'GET', headers: { 'x-hon-family-id': randomUUID() }, body: undefined, originalUrl: '/parent/billing' },
    { method: 'GET', headers: {}, body: undefined, originalUrl: '/parent/billing?familyId=x' },
  ]) await assert.throws(() => require('../dist/families/parent-billing-view.controller.js').rejectParentBillingInputs(candidate, candidate.originalUrl.includes('?') ? { familyId: 'x' } : {}));
  await assert.rejects(() => controller.read({}, { ...request, honIdentity: undefined }), status(403));
});

test('parent billing real HTTP permits only GET and leaves no mutation endpoint', async () => {
  const db = { resolveParentJourneyScopes: async () => [scope], readParentBillingView: async () => projection };
  const module = await Test.createTestingModule({ controllers: [ParentBillingViewController], providers: [ParentBillingViewService, ParentBillingReadGuard, { provide: RuntimeDatabaseService, useValue: db }] }).overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-guardian' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1'); const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/parent/billing`;
  try {
    const good = await fetch(base, { headers: { Accept: 'application/json', 'Sec-Fetch-Site': 'same-origin' } }); assert.equal(good.status, 200); assert.equal(good.headers.get('cache-control'), 'private, no-store'); assert.equal(good.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal((await fetch(`${base}?familyId=${randomUUID()}`)).status, 400); assert.equal((await fetch(base, { method: 'POST' })).status, 404);
    for (const suffix of ['payment-methods', 'collect', 'charge', 'refund', 'credit', 'discount', 'cancel', 'renew', 'actions', 'voice']) assert.equal((await fetch(`${base}/${suffix}`, { method: 'POST' })).status, 404);
  } finally { await app.close(); }
});
