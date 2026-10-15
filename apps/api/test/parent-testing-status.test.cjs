const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { Test } = require('@nestjs/testing');
const { ParentTestingStatusService } = require('../dist/testing/parent-testing-status.service.js');
const { ParentTestingStatusController, ParentTestingStatusReadGuard, rejectParentTestingStatusInputs } = require('../dist/testing/parent-testing-status.controller.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');

const scope = { principalId: randomUUID(), organizationId: randomUUID(), schoolId: randomUUID(), familyId: randomUUID(), accessLevel: 'PRIMARY_GUARDIAN' };
const at = '2026-11-01T10:00:00.000Z';
const view = { generatedAt: at, accessLevel: 'PRIMARY_GUARDIAN', children: { status: 'AVAILABLE', limited: false, items: [{ displayName: 'Authorized child', upcomingEvent: { label: 'Existing event', startsAt: at, endsAt: null }, candidates: { status: 'AVAILABLE', limited: false, items: [{ event: { label: 'Existing event', startsAt: at, endsAt: null }, overallStatus: 'PENDING' }] }, registrationInterests: { status: 'AVAILABLE', limited: false, items: [{ event: { label: 'Existing event', startsAt: at, endsAt: null }, status: 'SUBMITTED', submittedAt: at, reviewedAt: null }] }, certificate: { status: 'ISSUED' } }] } };
const status = code => error => { assert.equal(error.getStatus(), code); return true; };

test('parent testing status derives and rechecks only one current family before one fixed read projection', async () => {
  const calls = []; const db = {
    resolveParentJourneyScopes: async subject => { calls.push(['scope', subject]); return [scope]; },
    readParentTestingStatus: async subject => { calls.push(['projection', subject]); return view; },
  };
  const service = new ParentTestingStatusService(db); const result = await service.get('verified-parent');
  assert.deepEqual(result.data, view); assert.equal(result.meta.requestId, result.meta.correlationId);
  assert.deepEqual(calls, [['scope', 'verified-parent'], ['scope', 'verified-parent'], ['projection', 'verified-parent'], ['scope', 'verified-parent'], ['scope', 'verified-parent']]);
  await assert.rejects(() => new ParentTestingStatusService({ resolveParentJourneyScopes: async () => [scope, { ...scope, familyId: randomUUID() }] }).get('ambiguous'), status(409));
  await assert.rejects(() => new ParentTestingStatusService({ resolveParentJourneyScopes: async () => [] }).get('denied'), status(403));
});

test('parent testing status has no registration/certificate/scorecard/payment/action/provider/AI/messaging mutation dependency or leaked DTO field', () => {
  for (const file of ['parent-testing-status.service.ts', 'parent-testing-status.controller.ts']) {
    const source = readFileSync(`src/testing/${file}`, 'utf8');
    assert.doesNotMatch(source, /from\s+['"][^'"]*(?:action|ai|voice|payment|provider|communication|certificate\.service|scorecard|registration\.service)[^'"]*['"]|ActionEngineService|Ai\w*Service|Voice\w*Service|Payment\w*Service|fetch\(/);
  }
  const contract = readFileSync('../../packages/contracts/src/parent-testing-status.ts', 'utf8');
  for (const forbidden of ['familyId', 'schoolId', 'organizationId', 'principalId', 'candidateId', 'evaluator', 'criterion', 'comment', 'rank', 'promotion', 'certificateId', 'download']) assert.doesNotMatch(contract, new RegExp(`\\b${forbidden}\\s*:`, 'i'));
  const migration = readFileSync('../../packages/database/migrations/0104_parent_testing_status_read.sql', 'utf8');
  assert.match(migration, /read_parent_testing_status\(p_subject text\)/); assert.match(migration, /PAYER_LINK_UNVERIFIED/);
  assert.doesNotMatch(migration, /testing_scorecard_evaluations|evaluator_principal_id|criterion_code|instructor_notes/i);
  assert.doesNotMatch(migration, /(?:INSERT\s+INTO|UPDATE\s+hon\.|DELETE\s+FROM)\s+hon\.(?:audit_events|outbox_events|testing_candidates|testing_registration_interests|testing_certificates|promotion_decisions|invoices|payment_attempts|communication_messages|action_requests|work_items|ai_usage_ledger)/i);
});

test('parent testing status controller rejects selectors, mutation-shaped headers, and cross-site reads', async () => {
  const controller = new ParentTestingStatusController({ get: async subject => ({ data: view, meta: { requestId: subject, correlationId: subject } }) });
  const request = { method: 'GET', headers: {}, body: undefined, originalUrl: '/parent/testing/status', honIdentity: { externalSubject: 'verified-parent' } };
  await assert.deepEqual(await controller.read({}, request), { data: view, meta: { requestId: 'verified-parent', correlationId: 'verified-parent' } });
  for (const candidate of [
    { method: 'POST', headers: {}, body: undefined, originalUrl: '/parent/testing/status' },
    { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' }, body: undefined, originalUrl: '/parent/testing/status' },
    { method: 'GET', headers: { 'x-hon-family-id': randomUUID() }, body: undefined, originalUrl: '/parent/testing/status' },
    { method: 'GET', headers: {}, body: undefined, originalUrl: '/parent/testing/status?familyId=x' },
  ]) assert.throws(() => rejectParentTestingStatusInputs(candidate, candidate.originalUrl.includes('?') ? { familyId: 'x' } : {}));
  await assert.rejects(() => controller.read({}, { ...request, honIdentity: undefined }), status(403));
});

test('parent testing status real HTTP permits only one GET and leaves no new mutation endpoint', async () => {
  const db = { resolveParentJourneyScopes: async () => [scope], readParentTestingStatus: async () => view };
  const module = await Test.createTestingModule({ controllers: [ParentTestingStatusController], providers: [ParentTestingStatusService, ParentTestingStatusReadGuard, { provide: RuntimeDatabaseService, useValue: db }] }).overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-parent' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1'); const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/parent/testing/status`;
  try {
    const good = await fetch(base, { headers: { Accept: 'application/json', 'Sec-Fetch-Site': 'same-origin' } }); assert.equal(good.status, 200); assert.equal(good.headers.get('cache-control'), 'private, no-store'); assert.equal(good.headers.get('x-robots-tag'), 'noindex, nofollow'); assert.equal(good.headers.get('referrer-policy'), 'no-referrer');
    assert.equal((await fetch(`${base}?familyId=${randomUUID()}`)).status, 400); assert.equal((await fetch(base, { method: 'POST' })).status, 404);
    for (const suffix of ['interests', 'register', 'payment', 'grade', 'promote', 'certificate', 'download', 'scorecard', 'message', 'actions', 'voice', 'automation']) assert.equal((await fetch(`${base}/${suffix}`, { method: 'POST' })).status, 404);
  } finally { await app.close(); }
});
