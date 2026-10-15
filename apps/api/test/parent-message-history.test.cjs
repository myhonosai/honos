const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { Test } = require('@nestjs/testing');
const { ParentMessageHistoryService } = require('../dist/families/parent-message-history.service.js');
const { ParentMessageHistoryController, ParentMessageHistoryReadGuard, rejectParentMessageHistoryInputs } = require('../dist/families/parent-message-history.controller.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');

const scope = { principalId: randomUUID(), organizationId: randomUUID(), schoolId: randomUUID(), familyId: randomUUID(), accessLevel: 'PRIMARY_GUARDIAN' };
const projection = { generatedAt: '2026-06-01T00:00:00.000Z', accessLevel: 'PRIMARY_GUARDIAN', messages: { status: 'UNAVAILABLE', reason: 'RECEIPT_EVIDENCE_UNAVAILABLE', items: [], limited: false } };
const status = code => error => { assert.equal(error.getStatus(), code); return true; };

test('parent message history derives one guardian current-family scope and calls only its fixed receipt-evidence projection', async () => {
  const calls = [];
  const db = { resolveParentJourneyScopes: async subject => { calls.push(['scope', subject]); return [scope]; }, readParentMessageHistory: async subject => { calls.push(['projection', subject]); return projection; } };
  const result = await new ParentMessageHistoryService(db).get('verified-guardian');
  assert.deepEqual(result.data, projection); assert.equal(result.meta.requestId, result.meta.correlationId);
  assert.deepEqual(calls, [['scope', 'verified-guardian'], ['scope', 'verified-guardian'], ['projection', 'verified-guardian'], ['scope', 'verified-guardian'], ['scope', 'verified-guardian']]);
  await assert.rejects(() => new ParentMessageHistoryService({ resolveParentJourneyScopes: async () => [{ ...scope, accessLevel: 'VIEWER' }] }).get('viewer'), status(403));
  await assert.rejects(() => new ParentMessageHistoryService({ resolveParentJourneyScopes: async () => [scope, { ...scope, familyId: randomUUID() }] }).get('ambiguous'), status(409));
});

test('message-history service and controller have no queue mutation, consent, staff, AI, provider, action, voice, automation or payment dependency', () => {
  for (const file of ['parent-message-history.service.ts', 'parent-message-history.controller.ts']) {
    const source = readFileSync(`src/families/${file}`, 'utf8');
    assert.doesNotMatch(source, /from\s+['"][^'"]*(?:action|ai|voice|payment|provider|communication|consent|automation)[^'"]*['"]|ActionEngineService|Ai\w*Service|Voice\w*Service|Payment\w*Service|CommunicationMessageService|CommunicationConsentService|fetch\(/);
    assert.doesNotMatch(source, /@Post\(|@Patch\(|@Put\(|@Delete\(|\.query\(/);
  }
  const migration = readFileSync('../../packages/database/migrations/0106_parent_message_history_read.sql', 'utf8');
  assert.match(migration, /read_parent_message_history\(p_subject text\)/); assert.match(migration, /SECURITY DEFINER/); assert.match(migration, /PRIMARY_GUARDIAN/); assert.match(migration, /SECONDARY_GUARDIAN/); assert.match(migration, /RECEIPT_EVIDENCE_UNAVAILABLE/);
  assert.doesNotMatch(migration, /(?:INSERT\s+INTO|UPDATE\s+hon\.|DELETE\s+FROM)\s+hon\.(?:audit_events|outbox_events|communication_messages|communication_consents|payment_attempts|action_requests|work_items|ai_usage_ledger)/i);
});

test('message-history controller rejects selectors, mutation-shaped headers, cross-site GETs, and missing identity', async () => {
  const controller = new ParentMessageHistoryController({ get: async subject => ({ data: projection, meta: { requestId: subject, correlationId: subject } }) });
  const request = { method: 'GET', headers: {}, body: undefined, originalUrl: '/parent/messages', honIdentity: { externalSubject: 'verified-guardian' } };
  await assert.deepEqual(await controller.read({}, request), { data: projection, meta: { requestId: 'verified-guardian', correlationId: 'verified-guardian' } });
  for (const candidate of [{ method: 'POST', headers: {}, body: undefined, originalUrl: request.originalUrl }, { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' }, body: undefined, originalUrl: request.originalUrl }, { method: 'GET', headers: { 'x-hon-family-id': randomUUID() }, body: undefined, originalUrl: request.originalUrl }, { method: 'GET', headers: {}, body: undefined, originalUrl: `${request.originalUrl}?recipientPersonId=${randomUUID()}` }]) assert.throws(() => rejectParentMessageHistoryInputs(candidate, candidate.originalUrl.includes('?') ? { recipientPersonId: 'x' } : {}));
  await assert.rejects(() => controller.read({}, { ...request, honIdentity: undefined }), status(403));
});

test('message-history real HTTP permits only fixed GET, exact private no-store, and no send/reply/queue/delivery endpoint', async () => {
  const db = { resolveParentJourneyScopes: async () => [scope], readParentMessageHistory: async () => projection };
  const module = await Test.createTestingModule({ controllers: [ParentMessageHistoryController], providers: [ParentMessageHistoryService, ParentMessageHistoryReadGuard, { provide: RuntimeDatabaseService, useValue: db }] }).overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-guardian' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1'); const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/parent/messages`;
  try {
    const good = await fetch(base, { headers: { Accept: 'application/json', 'Sec-Fetch-Site': 'same-origin' } }); assert.equal(good.status, 200); assert.equal(good.headers.get('cache-control'), 'private, no-store'); assert.equal(good.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal((await fetch(`${base}?familyId=${randomUUID()}`)).status, 400); assert.equal((await fetch(base, { method: 'POST' })).status, 404);
    for (const suffix of ['send', 'reply', 'draft', 'queue', 'cancel', 'consent', 'opt-out', 'recipient', 'delivery', 'provider', 'actions', 'voice']) assert.equal((await fetch(`${base}/${suffix}`, { method: 'POST' })).status, 404);
  } finally { await app.close(); }
});
