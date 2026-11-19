const { test } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('@hon/contracts');
const { SchoolMessagesService } = require('../dist/communication/school-messages.service.js');
const { SchoolMessagesController, listQuery } = require('../dist/communication/school-messages.controller.js');

// 0572 (TE1) the school's History and Opted out lists: closed queries, rows checked for shape and filters, refusals before any database call.
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', P = '33333333-3333-4333-8333-333333333333';
const M = '44444444-4444-4444-8444-444444444444', N = '55555555-5555-4555-8555-555555555555';
const T = '2026-11-20T17:00:00.000Z', U = '2026-11-20T16:00:00.000Z';
const refused = (fn) => { try { fn(); return false; } catch { return true; } };
const row = (patch = {}) => ({ messageId: M, personId: P, personName: 'Ada Parent', address: 'ada@example.invalid', channel: 'EMAIL', subject: 'Hello',
  preview: 'Hi', at: T, origin: 'STAFF', delivery: 'DELIVERED', outcome: 'DELIVERED', by: 'Coach', ...patch });
const out = (patch = {}) => ({ consentId: M, personId: P, personName: 'Ada Parent', address: '+15125550100', channel: 'SMS', source: 'RECIPIENT', optedOutAt: T, at: T, ...patch });

test('queries are closed and checked', () => {
  assert.deepEqual(contracts.validateSchoolMessageHistoryQuery({ channel: 'SMS', outcome: 'FAILED', origin: 'CAMPAIGN', range: 'DAYS_7', search: 'ada', before: { at: T, id: M } }),
    { channel: 'SMS', outcome: 'FAILED', origin: 'CAMPAIGN', range: 'DAYS_7', search: 'ada', before: { at: T, id: M } });
  for (const bad of [{ channel: 'PUSH' }, { outcome: 'SENT' }, { origin: 'FAMILY' }, { range: 'WEEK' }, { search: '' }, { search: ' a' }, { search: 'x'.repeat(61) },
    { search: 'a\u0007' }, { before: { at: T } }, { before: { at: 'now', id: M } }, { schoolId: B }])
    assert.ok(refused(() => contracts.validateSchoolMessageHistoryQuery(bad)), JSON.stringify(bad));
  assert.deepEqual(contracts.validateSchoolOptedOutQuery({ channel: 'EMAIL', search: 'ada' }), { channel: 'EMAIL', search: 'ada' });
  for (const bad of [{ outcome: 'FAILED' }, { channel: 'APP' }, { range: 'ALL' }]) assert.ok(refused(() => contracts.validateSchoolOptedOutQuery(bad)), JSON.stringify(bad));
  assert.deepEqual(listQuery({ channel: 'SMS', beforeAt: T, beforeId: M }, ['channel']), { channel: 'SMS', before: { at: T, id: M } });
  for (const bad of [{ beforeAt: T }, { other: 'x' }, { channel: ['SMS', 'EMAIL'] }]) assert.throws(() => listQuery(bad, ['channel']), JSON.stringify(bad));
});

test('history rows: subject only on email, outcome matches the delivery state, filters and order are honoured', () => {
  assert.equal(contracts.verifySchoolMessageHistoryRow(row()).outcome, 'DELIVERED');
  assert.equal(contracts.verifySchoolMessageHistoryRow(row({ channel: 'SMS', subject: null, address: null, delivery: 'QUEUED', outcome: 'IN_PROGRESS' })).outcome, 'IN_PROGRESS');
  for (const [state, outcome] of [['ACCEPTED', 'DELIVERED'], ['BOUNCED', 'FAILED'], ['SUPPRESSED', 'FAILED'], ['CANCELLED', 'CANCELLED'], ['UNKNOWN', 'IN_PROGRESS'], ['SENDING', 'IN_PROGRESS']])
    assert.equal(contracts.schoolMessageOutcome(state), outcome);
  for (const bad of [row({ subject: null }), row({ channel: 'SMS' }), row({ outcome: 'FAILED' }), row({ delivery: 'DRAFT' }), row({ origin: 'FAMILY' }),
    row({ preview: 'x'.repeat(161) }), row({ personName: 'a\u0000' }), row({ extra: 1 })])
    assert.ok(refused(() => contracts.verifySchoolMessageHistoryRow(bad)), JSON.stringify(bad).slice(0, 100));
  const two = { messages: [row(), row({ messageId: N, at: U })], nextCursor: null };
  assert.equal(contracts.verifySchoolMessageHistory(two).messages.length, 2);
  assert.ok(refused(() => contracts.verifySchoolMessageHistory({ messages: [row({ at: U }), row({ messageId: N, at: T })], nextCursor: null })), 'out of order');
  assert.ok(refused(() => contracts.verifySchoolMessageHistory({ messages: [row(), row()], nextCursor: null })), 'duplicate');
  assert.ok(refused(() => contracts.verifySchoolMessageHistory(two, { channel: 'SMS' })), 'a row outside the channel asked for');
  assert.ok(refused(() => contracts.verifySchoolMessageHistory(two, { outcome: 'FAILED' })));
  assert.ok(refused(() => contracts.verifySchoolMessageHistory(two, { before: { at: T, id: M } })), 'a row at the cursor');
  assert.ok(refused(() => contracts.verifySchoolMessageHistory({ ...two, nextCursor: { at: U, id: N } })), 'a cursor on a short page');
  const page = Array.from({ length: 50 }, (_, i) => row({ messageId: `44444444-4444-4444-8444-${String(999999999999 - i).padStart(12, '0')}` }));
  assert.equal(contracts.verifySchoolMessageHistory({ messages: page, nextCursor: { at: T, id: page[49].messageId } }).nextCursor.id, page[49].messageId);
  assert.ok(refused(() => contracts.verifySchoolMessageHistory({ messages: [...page, row({ messageId: N, at: U })], nextCursor: null })), 'more than a page');
});

test('opted-out rows are checked for shape, order and channel', () => {
  assert.equal(contracts.verifySchoolOptedOut({ contacts: [out(), out({ consentId: N, at: U, channel: 'EMAIL' })], nextCursor: null }).contacts.length, 2);
  for (const bad of [out({ source: 'AI' }), out({ channel: 'APP' }), out({ optedOutAt: 'yesterday' }), out({ status: 'OPTED_OUT' })])
    assert.ok(refused(() => contracts.verifySchoolOptedOutRow(bad)), JSON.stringify(bad).slice(0, 100));
  assert.ok(refused(() => contracts.verifySchoolOptedOut({ contacts: [out()], nextCursor: null }, { channel: 'EMAIL' })));
});

test('service and controller refuse before any database call', async () => {
  let calls = 0;
  const database = { withTenantReadOnlyTransaction: async () => { calls++; }, resolveAuthorizedScope: async () => { calls++; return null; } };
  const service = new SchoolMessagesService(database);
  const staff = { organizationId: A, schoolId: B, principalId: P, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'subject', requestId: A, correlationId: A, idempotencyKey: '' };
  await assert.rejects(() => service.history({ ...staff, source: 'AI_AGENT' }, {}), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(() => service.history({ ...staff, delegatedByPrincipalId: A }, {}), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(() => service.history({ ...staff, actionRequestId: A }, {}), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(() => service.history({ ...staff, idempotencyKey: 'k' }, {}), (e) => e.response.code === 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
  await assert.rejects(() => service.history(staff, { range: 'WEEK' }), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.optedOut(staff, { outcome: 'FAILED' }), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.optedOut({ ...staff, externalSubject: ' x' }, {}), (e) => e.response.code === 'SCHOOL_MESSAGES_FORBIDDEN');
  assert.equal(calls, 0);
  const controller = new SchoolMessagesController(database, service);
  const req = { honIdentity: { externalSubject: 'subject' }, originalUrl: '/v1/x' };
  await assert.rejects(() => controller.history(A, B, {}, 'key', req), (e) => e.response.code === 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
  await assert.rejects(() => controller.history(A, B, { schoolId: B }, undefined, req), (e) => e.response.code === 'VALIDATION_FAILED');
  assert.equal(calls, 0);
  await assert.rejects(() => controller.optedOut(A, B, {}, undefined, req), (e) => e.response.code === 'SCHOOL_MESSAGES_FORBIDDEN');
  await assert.rejects(() => controller.history(A, B, {}, undefined, { originalUrl: '/v1/x' }), (e) => e.response.code === 'IDENTITY_REQUIRED');
});

test('TE1: a staff email draft may carry a subject; a text or a bad subject is refused before any database call', async () => {
  const { CommunicationMessageService } = require('../dist/communication/communication-message.service.js');
  const inserts = [], fingerprints = [];
  const client = { query: async (sql, values) => {
    if (/INSERT INTO hon\.idempotency_records/.test(sql)) { fingerprints.push(values[4]); return { rows: [{ id: A }], rowCount: 1 }; }
    if (/SELECT id FROM hon\.people/.test(sql)) return { rows: [{ id: P }], rowCount: 1 };
    if (/INSERT INTO hon\.communication_messages/.test(sql)) {
      inserts.push(values);
      return { rows: [{ id: M, recipientPersonId: P, channel: values[3], content: values[4], lifecycle: 'DRAFT', scheduledAt: null, createdByPrincipalId: P,
        queuedByPrincipalId: null, emailSubject: values[7], version: 1, createdAt: T, updatedAt: T }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  } };
  let calls = 0;
  const service = new CommunicationMessageService({ withTenantTransaction: async (_c, fn) => { calls++; return fn(client); } });
  const context = { organizationId: A, schoolId: B, principalId: P, principalType: 'HUMAN_USER', source: 'HUMAN_UI', idempotencyKey: 'k', requestId: A, correlationId: A };
  const made = await service.create(context, { recipientPersonId: P, channel: 'EMAIL', content: 'Hi', emailSubject: 'Belt test on Saturday' });
  assert.equal(made.message.emailSubject, 'Belt test on Saturday');
  assert.equal(inserts[0][7], 'Belt test on Saturday');
  const plain = await service.create(context, { recipientPersonId: P, channel: 'EMAIL', content: 'Hi' });
  assert.equal(inserts[1][7], null); assert.equal('emailSubject' in plain.message, false);
  assert.notEqual(fingerprints[0], fingerprints[1], 'the subject is part of the request');
  // A create without a subject keeps the fingerprint it had before TE1.
  assert.equal(fingerprints[1], require('node:crypto').createHash('sha256').update(JSON.stringify({ command: 'communication.message.create', recipientPersonId: P, channel: 'EMAIL', content: 'Hi', scheduledAt: null })).digest('hex'));
  const before = calls;
  for (const bad of [{ channel: 'SMS', emailSubject: 'Hi' }, { channel: 'EMAIL', emailSubject: '' }, { channel: 'EMAIL', emailSubject: ' Hi' }, { channel: 'EMAIL', emailSubject: 'a\nb' },
    { channel: 'EMAIL', emailSubject: 'x'.repeat(151) }, { channel: 'EMAIL', emailSubject: 5 }])
    await assert.rejects(() => service.create(context, { recipientPersonId: P, content: 'Hi', ...bad }), (e) => e.response?.code === 'VALIDATION_FAILED', JSON.stringify(bad));
  assert.equal(calls, before);
  assert.equal(contracts.COMMUNICATION_EMAIL_SUBJECT_MAX, 150);
});
