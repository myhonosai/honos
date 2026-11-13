const { test } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('@hon/contracts');
const { FamilyMessagesService } = require('../dist/families/family-messages.service.js');

// 0330 family messages: closed inputs, verified projections, and the service refuses before any database call.
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const T1 = '2026-11-20T17:00:00.000Z', T2 = '2026-11-20T18:00:00.000Z';
const message = (patch = {}) => ({ messageId: A, from: 'FAMILY', mine: true, body: 'Hello\nthere', sentAt: T1, ...patch });

test('0330 message text and inputs are closed', () => {
  assert.deepEqual(contracts.validateSendFamilyMessageInput({ body: 'Hi\tthere\r\nthanks' }), { body: 'Hi\tthere\r\nthanks' });
  for (const value of [{ body: '' }, { body: ' \n ' }, { body: 'x'.repeat(2001) }, { body: 'bell\u0007' }, { body: 'del\u007f' }, { body: 3 }, { body: 'hi', familyId: A }, {}, null, []]) {
    assert.throws(() => contracts.validateSendFamilyMessageInput(value), undefined, JSON.stringify(value));
  }
  assert.equal(contracts.familyMessageBodyOk('x'.repeat(2000)), true);
  assert.deepEqual(contracts.validateReplyFamilyMessageInput({ threadId: B, body: 'Thanks' }), { threadId: B, body: 'Thanks' });
  assert.throws(() => contracts.validateReplyFamilyMessageInput({ threadId: 'nope', body: 'Thanks' }));
});

test('0330 projections are verified exactly', () => {
  const view = { canWrite: true, schoolName: 'Dojo', threadId: B, messages: [message(), message({ messageId: C, from: 'SCHOOL', mine: false, sentAt: T2 })] };
  assert.deepEqual(contracts.verifyParentFamilyMessages(view), view);
  assert.throws(() => contracts.verifyParentFamilyMessages({ ...view, messages: [message({ staffName: 'Coach' })] }), undefined, 'no staff name');
  assert.throws(() => contracts.verifyParentFamilyMessages({ ...view, messages: [...view.messages].reverse() }), undefined, 'oldest first');
  assert.throws(() => contracts.verifyParentFamilyMessages({ ...view, threadId: null }), undefined, 'messages need a thread');
  const receipt = { threadId: B, version: 2, message: message() };
  assert.equal(contracts.verifyFamilyMessageReceipt(receipt, { from: 'FAMILY', body: 'Hello\nthere' }).threadId, B);
  assert.throws(() => contracts.verifyFamilyMessageReceipt(receipt, { from: 'FAMILY', body: 'Other' }), undefined, 'bound to the sent text');
  assert.throws(() => contracts.verifyFamilyMessageReceipt(receipt, { from: 'SCHOOL', body: 'Hello\nthere', threadId: B }), undefined, 'bound to the author');
  const row = { threadId: B, familyId: C, familyName: 'Kim Family', lastMessageAt: T2, lastFrom: 'FAMILY', messageCount: 2, unreadCount: 1, version: 3 };
  assert.deepEqual(contracts.verifyFamilyMessageInbox({ threads: [row], unreadThreads: 1 }), { threads: [row], unreadThreads: 1 });
  assert.throws(() => contracts.verifyFamilyMessageInbox({ threads: [row], unreadThreads: 0 }), undefined, 'unread thread count matches');
  assert.throws(() => contracts.verifyFamilyMessageInbox({ threads: [{ ...row, body: 'x' }], unreadThreads: 1 }), undefined, 'no text in the inbox');
  assert.throws(() => contracts.verifyFamilyMessageInbox({ threads: [{ ...row, lastMessageAt: T1 }, row], unreadThreads: 2 }), undefined, 'newest first');
  assert.throws(() => contracts.verifyFamilyMessageReadMark({ threadId: B, version: 3, unreadCount: 1 }, B), undefined, 'read means nothing unread');
});

test('0330 service refuses before any database call', async () => {
  let calls = 0;
  const database = new Proxy({}, { get: () => () => { calls += 1; throw new Error('database must not be reached'); } });
  const service = new FamilyMessagesService(database);
  const staff = { organizationId: A, schoolId: B, principalId: C, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'subject', requestId: A, correlationId: A, idempotencyKey: '' };
  await assert.rejects(() => service.parentRead(''), (e) => e.response.code === 'FAMILY_MESSAGES_FORBIDDEN');
  await assert.rejects(() => service.parentSend('subject', { body: '' }, 'key'), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.parentSend('subject', { body: 'Hi' }, ''), (e) => e.response.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(() => service.inbox({ ...staff, source: 'AI_AGENT' }), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(() => service.inbox({ ...staff, actionRequestId: A }), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(() => service.inbox({ ...staff, idempotencyKey: 'k' }), (e) => e.response.code === 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
  await assert.rejects(() => service.thread(staff, 'nope'), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.markRead(staff, 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB'), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.reply(staff, B, { body: 'Hi' }), (e) => e.response.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(() => service.reply({ ...staff, idempotencyKey: 'k' }, B, { body: 'Hi', threadId: B }), (e) => e.response.code === 'VALIDATION_FAILED');
  assert.equal(calls, 0);
  const failing = new FamilyMessagesService({ resolveParentJourneyScopes: async () => { throw Object.assign(new Error('boom kim@example.test'), { code: 'XX000' }); } });
  await assert.rejects(() => failing.parentRead('subject'), (e) => e.response.code === 'FAMILY_MESSAGES_UNAVAILABLE' && !JSON.stringify(e.response).includes('kim'));
});
