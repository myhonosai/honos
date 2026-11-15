const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { SchoolSupportService } = require('../dist/support/school-support.service.js');

// Mocked boundary tests for the 0335 support API. Authority, the HQ case, privacy and limits are proven against PostgreSQL
// by test-school-support-integrity.mjs.
const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const context = (patch = {}) => ({ ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: 'sup-key', externalSubject: 'verified-human', ...patch });
const status = (value, code) => (error) => { assert.equal(error.getStatus(), value); if (code) assert.equal(error.getResponse().code, code); return true; };
const rid = randomUUID();
const request = (patch = {}) => ({ requestId: rid, topic: 'GETTING_STARTED', subject: 'How do I start?', status: 'OPEN', pageHint: null, openedAt: '2026-11-13T07:00:00.000Z',
  updatedAt: '2026-11-13T07:00:00.000Z', closedAt: null, messages: [{ seq: 1, note: 'Hello', at: '2026-11-13T07:00:00.000Z', author: 'Owner' }], ...patch });
const ask = { topic: 'GETTING_STARTED', subject: 'How do I start?', message: 'Hello', pageHint: null };
function fixture(options = {}) {
  const queries = [];
  const db = {
    async transaction(c, work, readOnly) {
      return work({ query: async (sql, args = []) => {
        queries.push({ sql, args, readOnly });
        if (/^SET LOCAL/.test(sql) || /set_config\('app\.hon_source','HUMAN_UI'/.test(sql)) return { rows: [] };
        if (options.error) throw options.error;
        if (/read_school_support_requests/.test(sql)) return { rows: [{ data: options.read ?? { requests: [request()], limits: { requestsPerDay: 10, messagesPerDay: 30, subjectMax: 200, messageMax: 4000 }, checkedAt: '2026-11-13T07:00:00.000Z' } }] };
        if (/submit_school_support_request|add_school_support_message/.test(sql)) return { rows: [{ data: options.save ?? { record: request(), replayed: false } }] };
        throw new Error('Unexpected SQL: ' + sql);
      } });
    },
    withTenantTransaction(c, work) { return this.transaction(c, work, false); },
    withTenantReadOnlyTransaction(c, work) { return this.transaction(c, work, true); },
  };
  return { db, queries };
}

test('list is one read-only call; submit and message send the exact body, key and request ids', async () => {
  const f = fixture(), svc = new SchoolSupportService(f.db);
  assert.equal((await svc.list(context({ idempotencyKey: '' }))).requests.length, 1);
  assert.equal(f.queries.find(q => q.sql.includes('read_school_support')).readOnly, true);
  const c = context(); await svc.submit(c, ask);
  const call = f.queries.find(q => q.sql.includes('submit_school_support'));
  assert.deepEqual(JSON.parse(call.args[1]), ask); assert.deepEqual(call.args.slice(2), ['sup-key', c.requestId, c.correlationId]);
  await svc.message(context(), rid, { message: 'More detail' });
  assert.equal(f.queries.find(q => q.sql.includes('add_school_support_message')).args[1], rid);
});

test('bad bodies and non-human or keyless contexts never reach the database', async () => {
  for (const bad of [null, [], { ...ask, topic: 'BOSS' }, { ...ask, subject: 'hi' }, { ...ask, message: '' }, { ...ask, extra: 1 }, { ...ask, pageHint: 'https://x' }]) {
    const f = fixture();
    await assert.rejects(new SchoolSupportService(f.db).submit(context(), bad), status(400, 'SUPPORT_INVALID')); assert.equal(f.queries.length, 0);
  }
  const f = fixture(), svc = new SchoolSupportService(f.db);
  await assert.rejects(svc.list(context({ idempotencyKey: '', principalType: 'AI_AGENT' })), status(403));
  await assert.rejects(svc.list(context()), status(403));
  await assert.rejects(svc.submit(context({ idempotencyKey: '' }), ask), status(403));
  await assert.rejects(svc.message(context(), rid, { message: '' }), status(400));
  assert.equal(f.queries.length, 0);
});

test('database refusals map to stable codes and unknown failures claim nothing', async () => {
  const cases = [[{ code: '42501', message: 'SUPPORT_FORBIDDEN' }, 403, 'SUPPORT_FORBIDDEN'], [{ code: '54000', message: 'SUPPORT_RATE_LIMITED' }, 429, 'SUPPORT_RATE_LIMITED'],
    [{ code: '23505', message: 'IDEMPOTENCY_KEY_REUSED' }, 409, 'IDEMPOTENCY_KEY_REUSED'], [{ code: '55P03', message: 'SUPPORT_BUSY' }, 409, 'SUPPORT_BUSY'],
    [{ code: 'P0002', message: 'SUPPORT_REQUEST_NOT_FOUND' }, 404, 'SUPPORT_REQUEST_NOT_FOUND'], [{ code: '23514', message: 'SUPPORT_REQUEST_CLOSED' }, 409, 'SUPPORT_REQUEST_CLOSED'],
    [{ code: 'XX000', message: 'boom' }, 503, 'SUPPORT_UNAVAILABLE']];
  for (const [error, http, code] of cases) await assert.rejects(new SchoolSupportService(fixture({ error }).db).submit(context(), ask), status(http, code));
});

test('unverifiable lists and receipts, or a receipt for another request, are refused', async () => {
  await assert.rejects(new SchoolSupportService(fixture({ read: { requests: [request({ status: 'CLOSED' })], limits: { requestsPerDay: 10, messagesPerDay: 30, subjectMax: 200, messageMax: 4000 }, checkedAt: '2026-11-13T07:00:00.000Z' } }).db).list(context({ idempotencyKey: '' })), status(503));
  await assert.rejects(new SchoolSupportService(fixture({ save: { record: request({ secret: 1 }), replayed: false } }).db).submit(context(), ask), status(503));
  await assert.rejects(new SchoolSupportService(fixture({ save: { record: request(), replayed: false } }).db).message(context(), randomUUID(), { message: 'x' }), status(503));
});
