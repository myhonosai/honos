const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SchoolContactsController } = require('../dist/people/school-contacts.controller.js');
const { SchoolContactsService } = require('../dist/people/school-contacts.service.js');

// C1 (0521): the controller's closed query, the service's cursor binding and error mapping, without a database.
const ORG = '11111111-1111-4111-8111-111111111111';
const SCHOOL = '22222222-2222-4222-8222-222222222222';
const PERSON = '55555555-5555-4555-8555-555555555555';
const request = { honIdentity: { externalSubject: 'staff-subject' } };
const scopeDatabase = (scope = { organizationId: ORG, schoolId: SCHOOL, principalId: '33333333-3333-4333-8333-333333333333' }) => ({
  calls: [],
  async resolveAuthorizedScope(subject, schoolId, permission) { this.calls.push([subject, schoolId, permission]); return scope; },
});
const code = async (promise) => { try { await promise; return null; } catch (error) { return error.getResponse().code; } };
const context = { organizationId: ORG, schoolId: SCHOOL, principalId: 'p', principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'staff-subject',
  requestId: 'r', correlationId: 'r', idempotencyKey: '' };
const page = (segment = 'ALL', hasMore = true) => ({
  generatedAt: '2026-11-15T10:00:00.000Z', segment, counts: { ALL: 3, STUDENT: 1, TRIAL: 0, PROSPECT: 1, INACTIVE: 0, ARCHIVED: 0 }, hasMore, options: null,
  rows: [{ personId: PERSON, version: 1, givenName: 'Avery', familyName: 'Able', email: null, phoneE164: null, segment: 'STUDENT', planName: 'Kids monthly',
    planCode: 'KIDS', programName: null, membershipEndsAt: '2026-12-01T08:00:00.000Z', ranks: [{ rank: 'White', color: '#ffffff' }] }],
});
const database = (value) => ({
  inputs: [],
  async withTenantReadOnlyTransaction(_context, work) {
    const self = this;
    return work({ async query(text, values) { if (/read_school_contact_(list|card)/.test(text)) { if (/list/.test(text)) self.inputs.push(JSON.parse(values[1])); return { rows: [{ data: typeof value === 'function' ? value() : value }] }; } return { rows: [] }; } });
  },
});
const failingDatabase = (error) => ({ async withTenantReadOnlyTransaction() { throw error; } });
const pgError = (sqlState, message) => Object.assign(new Error(message), { code: sqlState });

test('school contacts controller: only the closed keys pass, as strings; people.read is resolved from the session', async () => {
  const db = scopeDatabase(), contacts = { calls: [], async list(ctx, filters, cursor) { this.calls.push([ctx, filters, cursor]); return { ok: true }; } };
  const controller = new SchoolContactsController(db, contacts);
  await controller.list(ORG, SCHOOL, undefined, { segment: 'STUDENT', endsWithinDays: '30', cursor: 'abc' }, request);
  assert.deepEqual(contacts.calls[0].slice(1), [{ segment: 'STUDENT', endsWithinDays: '30' }, 'abc']);
  assert.deepEqual(db.calls[0], ['staff-subject', SCHOOL, 'people.read']);
  assert.equal(contacts.calls[0][0].source, 'HUMAN_UI');
  for (const query of [{ limit: '5' }, { afterId: PERSON }, { segment: ['ALL', 'STUDENT'] }]) {
    assert.equal(await code(controller.list(ORG, SCHOOL, undefined, query, request)), 'VALIDATION_FAILED', JSON.stringify(query));
  }
  assert.equal(await code(controller.list(ORG, SCHOOL, 'key-1', {}, request)), 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
  const other = new SchoolContactsController(scopeDatabase({ organizationId: '44444444-4444-4444-8444-444444444444', schoolId: SCHOOL, principalId: 'p' }), contacts);
  assert.equal(await code(other.list(ORG, SCHOOL, undefined, {}, request)), 'SCHOOL_CONTACTS_FORBIDDEN');
});

test('school contacts service: the cursor continues after the last person and is bound to the school and filters', async () => {
  const db = database(page());
  const service = new SchoolContactsService(db);
  const first = await service.list(context, { endsWithinDays: '30' }, undefined);
  assert.equal(typeof first.nextCursor, 'string');
  assert.deepEqual(db.inputs[0], { endsWithinDays: 30 });
  await service.list(context, { endsWithinDays: '30' }, first.nextCursor);
  assert.deepEqual(db.inputs[1], { endsWithinDays: 30, afterId: PERSON });
  for (const [ctx, filters] of [[context, { endsWithinDays: '60' }], [context, { endsWithinDays: '30', segment: 'STUDENT' }], [{ ...context, schoolId: '66666666-6666-4666-8666-666666666666' }, { endsWithinDays: '30' }]]) {
    assert.equal(await code(service.list(ctx, filters, first.nextCursor)), 'INVALID_CURSOR');
  }
  assert.equal(db.inputs.length, 2);
  const last = await new SchoolContactsService(database(page('ALL', false))).list(context, {}, undefined);
  assert.equal(last.nextCursor, null);
});

test('school contacts service: bad input is refused before the database; errors and unverified rows map to fixed codes', async () => {
  let touched = false;
  const closed = new SchoolContactsService({ async withTenantReadOnlyTransaction() { touched = true; } });
  for (const value of [{ segment: 'OTHER' }, { endsWithinDays: '14' }, { rankId: 'nope' }, { query: '' }]) {
    assert.equal(await code(closed.list(context, value, undefined)), 'VALIDATION_FAILED', JSON.stringify(value));
  }
  assert.equal(await code(closed.list({ ...context, source: 'AI_AGENT' }, {}, undefined)), 'HUMAN_COMMAND_REQUIRED');
  assert.equal(touched, false);
  for (const [error, expected] of [[pgError('42501', 'SCHOOL_CONTACTS_FORBIDDEN'), 'SCHOOL_CONTACTS_FORBIDDEN'], [pgError('22023', 'SCHOOL_CONTACTS_STALE_CURSOR'), 'INVALID_CURSOR'],
    [pgError('22023', 'VALIDATION_FAILED'), 'VALIDATION_FAILED'], [pgError('57014', 'timeout'), 'SCHOOL_CONTACTS_UNAVAILABLE']]) {
    assert.equal(await code(new SchoolContactsService(failingDatabase(error)).list(context, {}, undefined)), expected, error.message);
  }
  const wrongSegment = new SchoolContactsService(database(page('ALL')));
  assert.equal(await code(wrongSegment.list(context, { segment: 'STUDENT' }, undefined)), 'SCHOOL_CONTACTS_UNAVAILABLE');
});

const card = () => ({ generatedAt: '2026-11-15T10:00:00.000Z',
  person: { personId: PERSON, version: 1, givenName: 'Avery', familyName: 'Able', email: null, phoneE164: null, createdAt: '2026-08-01T10:00:00.000Z' },
  overview: { segment: 'STUDENT', planName: null, programName: null, membershipEndsAt: null, ranks: [], openLead: false },
  family: { allowed: false }, appointments: { allowed: true, items: [] }, tasks: { allowed: false }, membership: { allowed: false },
  billing: { allowed: true, open: [{ currency: 'USD', dueMinor: 7900 }], invoices: [] }, messages: { allowed: false }, timeline: [{ kind: 'PERSON_ADDED', at: '2026-08-01T10:00:00.000Z', detail: null }] });

test('school contact card (0522): the person id comes from the path, no query is accepted, and the answer is verified', async () => {
  const db = scopeDatabase(), contacts = { calls: [], async card(ctx, personId) { this.calls.push([ctx, personId]); return { ok: true }; } };
  const controller = new SchoolContactsController(db, contacts);
  await controller.card(ORG, SCHOOL, PERSON, undefined, {}, request);
  assert.equal(contacts.calls[0][1], PERSON); assert.deepEqual(db.calls[0], ['staff-subject', SCHOOL, 'people.read']);
  assert.equal(await code(controller.card(ORG, SCHOOL, PERSON, undefined, { tab: 'billing' }, request)), 'VALIDATION_FAILED');
  assert.equal(await code(controller.card(ORG, SCHOOL, PERSON, 'key', {}, request)), 'IDEMPOTENCY_KEY_NOT_ACCEPTED');

  const db2 = database(card());
  const result = await new SchoolContactsService(db2).card(context, PERSON.toUpperCase());
  assert.equal(result.billing.allowed, true); assert.deepEqual(result.family, { allowed: false });
  assert.deepEqual(db2.inputs, []); // the card input is not a list input
  for (const [value, expected] of [[{ ...card(), person: { ...card().person, personId: '66666666-6666-4666-8666-666666666666' } }, 'SCHOOL_CONTACTS_UNAVAILABLE'],
    [{ ...card(), family: { allowed: false, families: [] } }, 'SCHOOL_CONTACTS_UNAVAILABLE'], [{ ...card(), timeline: [{ kind: 'NOTE', at: '2026-08-01T10:00:00.000Z', detail: 'x' }] }, 'SCHOOL_CONTACTS_UNAVAILABLE']]) {
    assert.equal(await code(new SchoolContactsService(database(value)).card(context, PERSON)), expected);
  }
  assert.equal(await code(new SchoolContactsService(failingDatabase(pgError('P0002', 'SCHOOL_CONTACT_NOT_FOUND'))).card(context, PERSON)), 'SCHOOL_CONTACT_NOT_FOUND');
  assert.equal(await code(new SchoolContactsService(failingDatabase(new Error('x'))).card(context, 'nope')), 'VALIDATION_FAILED');
});
