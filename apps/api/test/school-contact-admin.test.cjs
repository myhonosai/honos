const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SchoolContactAdminController } = require('../dist/people/school-contact-admin.controller.js');
const { SchoolContactAdminService } = require('../dist/people/school-contact-admin.service.js');

// C3 (0483): the merge / archive controller's closed requests and permission per call, and the service's input checks and
// error mapping (blockers are passed through as known codes only), without a database.
const ORG = '11111111-1111-4111-8111-111111111111';
const SCHOOL = '22222222-2222-4222-8222-222222222222';
const KEEP = '55555555-5555-4555-8555-555555555555';
const DUP = '66666666-6666-4666-8666-666666666666';
const HASH = 'a'.repeat(64);
const request = { honIdentity: { externalSubject: 'staff-subject' } };
const response = () => ({ statusCode: 0, status(code) { this.statusCode = code; return this; } });
const scopeDatabase = () => ({
  calls: [],
  async resolveAuthorizedScope(subject, schoolId, permission) { this.calls.push(permission); return { organizationId: ORG, schoolId: SCHOOL, principalId: 'p' }; },
});
const code = async (promise) => { try { await promise; return null; } catch (error) { return error.getResponse().code; } };
const body = async (promise) => { try { await promise; return null; } catch (error) { return error.getResponse(); } };
const context = { organizationId: ORG, schoolId: SCHOOL, principalId: 'p', principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'staff-subject',
  requestId: '77777777-7777-4777-8777-777777777777', correlationId: '77777777-7777-4777-8777-777777777777', idempotencyKey: 'key-1' };
const person = (personId, version = 3) => ({ personId, version, givenName: 'Kim', familyName: 'Lee', email: null, phoneE164: null });
const db = (data) => {
  const calls = [];
  const client = { async query(text, values) { if (/hon\.(read_school_contact|archive_school|restore_school|merge_school)/.test(text)) { calls.push([text, values]); return { rows: [{ data }] }; } return { rows: [] }; } };
  return { calls, async withTenantReadOnlyTransaction(_c, work) { return work(client); }, async withTenantTransaction(_c, work) { return work(client); } };
};
const failing = (error) => ({ async withTenantReadOnlyTransaction() { throw error; }, async withTenantTransaction() { throw error; } });
const pgError = (sqlState, message, hint) => Object.assign(new Error(message), { code: sqlState, hint });

test('school contact admin controller: each call resolves its own permission; keys and queries are closed', async () => {
  const scope = scopeDatabase();
  const admin = { calls: [], async archiveState(...a) { this.calls.push(['state', ...a]); return {}; }, async archive(...a) { this.calls.push(['archive', ...a]); return { receipt: {}, replayed: false }; },
    async mergePreview(...a) { this.calls.push(['preview', ...a]); return {}; }, async merge(...a) { this.calls.push(['merge', ...a]); return { receipt: {}, replayed: true }; } };
  const controller = new SchoolContactAdminController(scope, admin);
  await controller.archiveState(ORG, SCHOOL, KEEP, undefined, {}, request);
  const r = response();
  await controller.archive(ORG, SCHOOL, KEEP, 'key-1', {}, { version: 1 }, request, r);
  assert.equal(r.statusCode, 201);
  await controller.mergePreview(ORG, SCHOOL, KEEP, undefined, { mergePersonId: DUP }, request);
  const m = response();
  await controller.merge(ORG, SCHOOL, KEEP, 'key-2', {}, {}, request, m);
  assert.equal(m.statusCode, 200);
  assert.deepEqual(scope.calls, ['people.archive', 'people.archive', 'people.merge', 'people.merge']);
  assert.equal(await code(controller.archive(ORG, SCHOOL, KEEP, undefined, {}, {}, request, response())), 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal(await code(controller.archiveState(ORG, SCHOOL, KEEP, 'key', {}, request)), 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
  assert.equal(await code(controller.mergePreview(ORG, SCHOOL, KEEP, undefined, { mergePersonId: DUP, x: '1' }, request)), 'VALIDATION_FAILED');
  assert.equal(await code(controller.restore(ORG, SCHOOL, KEEP, 'key-3', { a: '1' }, {}, request, response())), 'VALIDATION_FAILED');
});

test('school contact admin service: closed bodies before the database; verified receipts; fixed error codes', async () => {
  const touched = db(null);
  const service = new SchoolContactAdminService(touched);
  for (const value of [{}, { version: 0 }, { version: 1, extra: true }, { version: '1' }]) {
    assert.equal(await code(service.archive(context, KEEP, value, false)), 'VALIDATION_FAILED', JSON.stringify(value));
  }
  for (const value of [{ keepVersion: 1, mergePersonId: KEEP, mergeVersion: 1, planHash: HASH }, { keepVersion: 1, mergePersonId: DUP, mergeVersion: 1, planHash: 'x' },
    { keepVersion: 1, mergePersonId: DUP, mergeVersion: 1 }]) {
    assert.equal(await code(service.merge(context, KEEP, value)), 'VALIDATION_FAILED', JSON.stringify(value));
  }
  assert.equal(await code(service.mergePreview(context, KEEP, KEEP)), 'VALIDATION_FAILED');
  assert.equal(await code(service.archive({ ...context, source: 'AI_AGENT' }, KEEP, { version: 1 }, false)), 'HUMAN_COMMAND_REQUIRED');
  assert.equal(touched.calls.length, 0);

  const ok = db({ receipt: { personId: KEEP, version: 4, archived: true }, replayed: false });
  assert.deepEqual(await new SchoolContactAdminService(ok).archive(context, KEEP, { version: 3 }, false), { receipt: { personId: KEEP, version: 4, archived: true }, replayed: false });
  assert.deepEqual(JSON.parse(ok.calls[0][1][1]), { personId: KEEP, version: 3 });
  assert.equal(ok.calls[0][1][2], 'key-1');
  assert.equal(await code(new SchoolContactAdminService(ok).archive(context, KEEP, { version: 3 }, true)), 'SCHOOL_CONTACTS_UNAVAILABLE', 'a restore receipt must say archived false');

  const preview = { keep: person(KEEP), merge: person(DUP, 2), blockers: [], moves: { leads: 1, familyLinks: 0, billingAccounts: 0, consents: 1, conversations: 0 },
    stays: { consents: 0, messages: 2 }, planHash: HASH };
  assert.equal((await new SchoolContactAdminService(db(preview)).mergePreview(context, KEEP, DUP)).planHash, HASH);
  assert.equal(await code(new SchoolContactAdminService(db({ ...preview, blockers: ['NOT_A_CODE'] })).mergePreview(context, KEEP, DUP)), 'SCHOOL_CONTACTS_UNAVAILABLE');

  assert.deepEqual(await body(new SchoolContactAdminService(failing(pgError('55000', 'SCHOOL_CONTACT_BLOCKED', '["HAS_OPEN_LEAD", "HAS_OPEN_BALANCE"]'))).archive(context, KEEP, { version: 3 }, false)),
    { code: 'SCHOOL_CONTACT_BLOCKED', blockers: ['HAS_OPEN_LEAD', 'HAS_OPEN_BALANCE'] });
  assert.deepEqual((await body(new SchoolContactAdminService(failing(pgError('55000', 'SCHOOL_CONTACT_BLOCKED', '["<script>"]'))).archive(context, KEEP, { version: 3 }, false))).blockers, []);
  for (const [error, expected] of [[pgError('42501', 'SCHOOL_CONTACT_ADMIN_FORBIDDEN'), 'SCHOOL_CONTACT_ADMIN_FORBIDDEN'], [pgError('P0002', 'SCHOOL_CONTACT_NOT_FOUND'), 'SCHOOL_CONTACT_NOT_FOUND'],
    [pgError('40001', 'SCHOOL_CONTACT_VERSION_CONFLICT'), 'SCHOOL_CONTACT_VERSION_CONFLICT'], [pgError('40001', 'SCHOOL_CONTACT_PREVIEW_STALE'), 'SCHOOL_CONTACT_PREVIEW_STALE'],
    [pgError('23505', 'IDEMPOTENCY_KEY_REUSED'), 'IDEMPOTENCY_KEY_REUSED'], [pgError('40001', 'IDEMPOTENCY_IN_PROGRESS'), 'SCHOOL_CONTACT_CONFLICT'], [pgError('57014', 'timeout'), 'SCHOOL_CONTACTS_UNAVAILABLE']]) {
    assert.equal(await code(new SchoolContactAdminService(failing(error)).archive(context, KEEP, { version: 3 }, false)), expected, error.message);
  }
});
