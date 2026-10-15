const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
require('reflect-metadata');
const { ParentJourneyViewService } = require('../dist/families/parent-journey-view.service.js');
const { ParentJourneyViewController, ParentJourneyReadGuard, rejectJourneyInputs } = require('../dist/families/parent-journey-view.controller.js');
const { ForbiddenException, ServiceUnavailableException } = require('@nestjs/common');
const ids = Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(8, '0')}-1111-4111-8111-111111111111`);
const scope = { principalId: ids[0], organizationId: ids[1], schoolId: ids[2], familyId: ids[3], accessLevel: 'VIEWER' };
const student = (name = 'Avery', profile = ids[4]) => ({ familyMemberId: profile, person: { id: profile, givenName: name, familyName: 'Allowed' }, studentProfile: { id: profile, status: 'ACTIVE' }, curriculumEnrollments: [{ id: ids[6], status: 'ACTIVE', curriculum: { id: ids[7], name: 'Current curriculum' }, currentRank: { id: ids[8], name: 'Current rank', progressionOrder: 1 }, testingCandidates: [{ privateReason: 'PRIVATE_HISTORY' }], requirementProgress: [{ enrollmentId: ids[6], requirementId: ids[9], label: 'Practice form', kind: 'TECHNIQUE', required: true, status: null, recordedAt: null, notes: 'PRIVATE_STAFF_NOTE' }] }, { status: 'ARCHIVED', curriculum: { name: 'PRIVATE_OLD_PROGRAM' } }] });
function fixture(options = {}) {
  const calls = [];
  const journey = { familyId: scope.familyId, accessLevel: scope.accessLevel, students: [student(), student('Blair', ids[5]), { ...student('Inactive', ids[10]), studentProfile: { id: ids[10], status: 'SUSPENDED' } }] };
  const db = { resolveParentJourneyScopes: async subject => { calls.push(['discover', subject]); return options.discovered ?? [scope]; }, resolveParentFamilyScopes: async (subject, school) => { calls.push(['exact', subject, school]); return options.exact ?? [scope]; } };
  let reads = 0;
  const journeys = { get: async (...args) => { calls.push(['journey', ...args]); if (++reads > 1 && options.revoked) throw new ForbiddenException(); return reads > 1 && options.current ? options.current : journey; } };
  const schedules = { get: async (...args) => { calls.push(['schedule', ...args]); if (options.scheduleError) throw options.scheduleError; const { from } = args[2]; return { bookings: ['Avery Allowed', 'Blair Allowed', 'OUTSIDE FAMILY'].map(displayName => ({ student: { displayName }, booking: { kind: 'REGULAR', status: 'BOOKED' }, session: { name: `${displayName} class`, startsAt: from, endsAt: new Date(Date.parse(from) + 3600000).toISOString(), status: 'SCHEDULED', instructorNotes: 'PRIVATE_INSTRUCTOR' }, program: { name: 'Program' }, invoice: 'PRIVATE_INVOICE' })) }; } };
  const achievements = { parent: async (...args) => { calls.push(['awards', ...args]); if (options.achievementError) throw options.achievementError; return { studentProfileId: options.awardStudent ?? args[2], items: [{ definition: { name: 'Shared recognition', description: 'Human-recorded description', creator: 'PRIVATE_ACTOR' }, awardedOn: '2026-01-02', reason: 'PRIVATE_REASON', history: 'PRIVATE_AWARD_HISTORY' }], nextAfter: null }; } };
  const documents = { read: async (...args) => { calls.push(['documents', ...args]); return [{ audience: 'PARENT', current: true, title: 'Family shared document', publishedAt: '2026-01-02T00:00:00.000Z', content: 'PRIVATE_DOCUMENT_BODY', signer: 'PRIVATE_CO_PARENT' }]; } };
  return { service: new ParentJourneyViewService(db, journeys, schedules, achievements, documents), calls, journey };
}
const request = () => ({ method: 'GET', headers: {}, originalUrl: '/v1/parent/journey', body: undefined, honIdentity: { externalSubject: 'verified-parent' } });
test('fixed controller rejects IDs/query/body/header authority and unauthenticated calls before any read', async () => {
  let reads = 0; const c = new ParentJourneyViewController({ get: async () => { ++reads; return {}; } });
  for (const key of ['familyId', 'schoolId', 'organizationId', 'studentProfileId', 'childId', 'principalId', 'source', 'after', 'actionRequestId', 'familyId[schoolId]', '__proto__']) {
    await assert.rejects(c.read(JSON.parse(`{"${key}":"${ids[1]}"}`), request()), e => e.getStatus() === 400);
  }
  for (const originalUrl of ['/v1/parent/journey?', '/v1/parent/journey?schoolId=a&schoolId=b', '/v1/parent/journey?%66amilyId=a']) await assert.rejects(c.read({}, { ...request(), originalUrl }), e => e.getStatus() === 400);
  for (const body of [{}, [], { familyId: ids[3] }, [ids[4]], 'query']) await assert.rejects(c.read({}, { ...request(), body }), e => e.getStatus() === 400);
  for (const headers of [{ 'x-hon-source': 'AI_TOOL' }, { 'x-hon-family-id': ids[3] }, { 'x-hon-delegated-by': ids[0] }, { 'sec-fetch-site': 'cross-site' }]) await assert.rejects(c.read({}, { ...request(), headers }), e => e.getStatus() === 403);
  await assert.rejects(c.read({}, { ...request(), honIdentity: undefined }), e => e.getStatus() === 403);
  assert.equal(reads, 0);
  assert.equal(new ParentJourneyReadGuard().canActivate({ switchToHttp: () => ({ getRequest: () => ({ ...request(), query: {} }) }) }), true);
  assert.throws(() => rejectJourneyInputs({ ...request(), method: 'POST' }, {}));
});
test('exact current parent scope only, no school/family directory or staff/HQ fallback', async () => {
  for (const options of [{ discovered: [] }, { discovered: [scope, { ...scope, familyId: ids[11] }] }, { exact: [] }, { exact: [{ ...scope, principalId: ids[11] }] }, { exact: [{ ...scope, organizationId: ids[11] }] }, { exact: [{ ...scope, schoolId: ids[11] }] }]) {
    const f = fixture(options); await assert.rejects(f.service.get('verified-parent')); assert(!f.calls.some(c => c[0] === 'journey'));
  }
});
test('whitelists current authorized child data and drops history/notes/actors/content/payments', async () => {
  const f = fixture(); const r = await f.service.get('verified-parent'); const encoded = JSON.stringify(r.data);
  assert.equal(r.data.accessLevel, 'VIEWER'); assert.equal(r.data.children[0].name, 'Avery Allowed'); assert.equal(r.data.children[0].programs.length, 1);
  assert.equal(r.data.children[0].programs[0].requirements.items[0].status, null);
  assert.equal(r.data.children[0].schedule.items.length, 1); assert.equal(r.data.children[1].schedule.items[0].name, 'Blair Allowed class');
  assert.equal(r.data.children[2].profileAvailable, false); assert.equal(r.data.children[2].programs.length, 0);
  assert.equal(r.data.plannedAbsences.status, 'UNAVAILABLE'); assert.equal(r.data.documentReceipts.status, 'UNAVAILABLE');
  assert(!/PRIVATE_|OUTSIDE FAMILY|principalId|organizationId|schoolId|familyId|studentProfileId|requirementId|testingCandidates|invoice|receiptId/.test(encoded));
  assert(f.calls.filter(c => c[0] === 'discover').length >= 2); assert(f.calls.filter(c => c[0] === 'exact').length >= 2);
  assert.equal(f.calls.filter(c => c[0] === 'awards').length, 2); assert.equal(f.calls.find(c => c[0] === 'documents')[2], 'LIST');
});
test('revocation, child movement/rename, access denial and foreign achievement binding clear the entire result', async () => {
  const original = fixture().journey;
  for (const options of [{ revoked: true }, { current: { ...original, students: [student('Renamed')] } }, { scheduleError: new ForbiddenException() }, { achievementError: new ForbiddenException() }, { awardStudent: ids[11] }]) await assert.rejects(fixture(options).service.get('verified-parent'));
});
test('optional read failure is unavailable, never an invented empty result; duplicate child names fail closed', async () => {
  const f = fixture({ scheduleError: new ServiceUnavailableException(), achievementError: new ServiceUnavailableException() });
  const r = await f.service.get('verified-parent'); assert.equal(r.data.children[0].schedule.status, 'UNAVAILABLE'); assert.equal(r.data.children[0].achievements.status, 'UNAVAILABLE');
  const duplicate = fixture(); duplicate.journey.students[1].person.givenName = 'Avery';
  const d = await duplicate.service.get('verified-parent'); assert.equal(d.data.children[0].schedule.reason, 'CHILD_MATCH_UNAVAILABLE'); assert.equal(d.data.children[1].schedule.reason, 'CHILD_MATCH_UNAVAILABLE');
});
test('effect isolation: no mutation, action, AI/provider/voice/payment/communication service dependency', () => {
  const code = ['parent-journey-view.service.ts', 'parent-journey-view.controller.ts'].map(f => readFileSync(path.join(__dirname, '../src/families', f), 'utf8')).join('\n');
  for (const regex of [/@Post\(/, /\.query\(/, /\.request\(/, /\.acknowledge\(/, /\.mutate\(/, /ActionEngineService|AiUsageService|VoiceService|InvoiceService|CommunicationMessageService/, /fetch\(|child_process|invokeLLM|executeAction|sendMessage/]) assert(!regex.test(code), String(regex));
  const sql = readFileSync(path.join(__dirname, '../../../packages/database/migrations/0087_parent_journey_read_scope.sql'), 'utf8');
  assert(sql.includes('hon.resolve_parent_family_scope(subject,c.school_id)')); assert(sql.includes('LIMIT 2')); assert(sql.includes('search_path=pg_catalog,hon'));
  assert(!/INSERT INTO|UPDATE hon\.|DELETE FROM|ALTER TABLE|GRANT SELECT/i.test(sql));
  assert(sql.includes('REVOKE ALL ON FUNCTION hon.resolve_parent_journey_scopes(text) FROM PUBLIC'));
});
