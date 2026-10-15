const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { Test } = require('@nestjs/testing');
const { ParentPlannedAbsenceHistoryService } = require('../dist/families/parent-planned-absence-history.service.js');
const { ParentPlannedAbsenceHistoryController, ParentPlannedAbsenceHistoryReadGuard, rejectParentPlannedAbsenceHistoryInputs } = require('../dist/families/parent-planned-absence-history.controller.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');

const scope = { principalId: randomUUID(), organizationId: randomUUID(), schoolId: randomUUID(), familyId: randomUUID(), accessLevel: 'PRIMARY_GUARDIAN' };
const from = '2026-01-01T00:00:00.000Z', to = new Date(Date.parse(from) + 271 * 86_400_000).toISOString(), generatedAt = '2026-06-01T00:00:00.000Z';
const projection = {
  generatedAt, from, to, accessLevel: 'PRIMARY_GUARDIAN', requests: { status: 'AVAILABLE', limited: false, items: [{
    child: { displayName: 'Authorized child' }, startsAt: '2026-02-01T09:00:00.000Z', endsAt: '2026-02-01T11:00:00.000Z', status: 'APPROVED', submittedAt: '2026-01-20T09:00:00.000Z', reviewedAt: '2026-01-21T09:00:00.000Z',
  }] },
};
const status = code => error => { assert.equal(error.getStatus(), code); return true; };

test('parent planned-absence history derives one guardian current-family scope and calls only its fixed projection', async () => {
  const calls = [];
  const db = {
    resolveParentJourneyScopes: async subject => { calls.push(['scope', subject]); return [scope]; },
    readParentPlannedAbsenceHistory: async subject => { calls.push(['projection', subject]); return projection; },
  };
  const service = new ParentPlannedAbsenceHistoryService(db);
  const result = await service.get('verified-guardian');
  assert.deepEqual(result.data, projection); assert.equal(result.meta.requestId, result.meta.correlationId);
  assert.deepEqual(calls, [['scope', 'verified-guardian'], ['scope', 'verified-guardian'], ['projection', 'verified-guardian'], ['scope', 'verified-guardian'], ['scope', 'verified-guardian']]);
  await assert.rejects(() => new ParentPlannedAbsenceHistoryService({ resolveParentJourneyScopes: async () => [{ ...scope, accessLevel: 'VIEWER' }] }).get('viewer'), status(403));
  await assert.rejects(() => new ParentPlannedAbsenceHistoryService({ resolveParentJourneyScopes: async () => [scope, { ...scope, familyId: randomUUID() }] }).get('ambiguous'), status(409));
});

test('history service and controller have no request/review/staff/AI/provider/action/payment/mutation dependency', () => {
  for (const file of ['parent-planned-absence-history.service.ts', 'parent-planned-absence-history.controller.ts']) {
    const source = readFileSync(`src/families/${file}`, 'utf8');
    assert.doesNotMatch(source, /from\s+['"][^'"]*(?:action|ai|voice|payment|provider|communication|schedule)[^'"]*['"]|ActionEngineService|Ai\w*Service|Voice\w*Service|Payment\w*Service|PlannedAbsenceReviewService|ParentPlannedAbsenceService|fetch\(/);
    assert.doesNotMatch(source, /@Post\(|@Patch\(|@Put\(|@Delete\(|\.query\(/);
  }
  const migration = readFileSync('../../packages/database/migrations/0105_parent_planned_absence_history_read.sql', 'utf8');
  assert.match(migration, /read_parent_planned_absence_history\(p_subject text\)/); assert.match(migration, /SECURITY DEFINER/); assert.match(migration, /PRIMARY_GUARDIAN/); assert.match(migration, /SECONDARY_GUARDIAN/);
  assert.doesNotMatch(migration, /(?:INSERT\s+INTO|UPDATE\s+hon\.|DELETE\s+FROM)\s+hon\.(?:audit_events|outbox_events|planned_absence_requests|class_bookings|attendance_records|communication_messages|payment_attempts|action_requests|work_items|ai_usage_ledger)/i);
  for (const forbidden of ['reviewed_by_principal_id AS', 'review_note AS', "'reason'", 'class_bookings', 'attendance_records']) assert.doesNotMatch(migration, new RegExp(forbidden, 'i'));
});

test('history controller rejects selectors, mutation-shaped headers, cross-site GETs, and missing identity', async () => {
  const controller = new ParentPlannedAbsenceHistoryController({ get: async subject => ({ data: projection, meta: { requestId: subject, correlationId: subject } }) });
  const request = { method: 'GET', headers: {}, body: undefined, originalUrl: '/parent/planned-absences/history', honIdentity: { externalSubject: 'verified-guardian' } };
  await assert.deepEqual(await controller.read({}, request), { data: projection, meta: { requestId: 'verified-guardian', correlationId: 'verified-guardian' } });
  for (const candidate of [
    { method: 'POST', headers: {}, body: undefined, originalUrl: request.originalUrl },
    { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' }, body: undefined, originalUrl: request.originalUrl },
    { method: 'GET', headers: { 'x-hon-family-id': randomUUID() }, body: undefined, originalUrl: request.originalUrl },
    { method: 'GET', headers: {}, body: undefined, originalUrl: `${request.originalUrl}?familyId=${randomUUID()}` },
  ]) assert.throws(() => rejectParentPlannedAbsenceHistoryInputs(candidate, candidate.originalUrl.includes('?') ? { familyId: 'x' } : {}));
  await assert.rejects(() => controller.read({}, { ...request, honIdentity: undefined }), status(403));
});

test('history real HTTP permits only fixed GET and leaves no request/review/approval/schedule/attendance action endpoint', async () => {
  const db = { resolveParentJourneyScopes: async () => [scope], readParentPlannedAbsenceHistory: async () => projection };
  const module = await Test.createTestingModule({ controllers: [ParentPlannedAbsenceHistoryController], providers: [ParentPlannedAbsenceHistoryService, ParentPlannedAbsenceHistoryReadGuard, { provide: RuntimeDatabaseService, useValue: db }] }).overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-guardian' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1'); const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/parent/planned-absences/history`;
  try {
    const good = await fetch(base, { headers: { Accept: 'application/json', 'Sec-Fetch-Site': 'same-origin' } }); assert.equal(good.status, 200); assert.equal(good.headers.get('cache-control'), 'private, no-store'); assert.equal(good.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal((await fetch(`${base}?familyId=${randomUUID()}`)).status, 400); assert.equal((await fetch(base, { method: 'POST' })).status, 404);
    for (const suffix of ['request', 'submit', 'cancel', 'review', 'approve', 'decline', 'schedule', 'bookings', 'attendance', 'makeup', 'messages', 'actions', 'voice']) assert.equal((await fetch(`${base}/${suffix}`, { method: 'POST' })).status, 404);
  } finally { await app.close(); }
});
