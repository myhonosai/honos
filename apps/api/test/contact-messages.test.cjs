const { test } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('@hon/contracts');
const { ContactMessagesService } = require('../dist/conversations/contact-messages.service.js');
const { ContactMessagesController } = require('../dist/conversations/contact-messages.controller.js');
const { SendGridEmailProvider } = require('../dist/communication/delivery/sendgrid-email-provider.js');

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', P = '33333333-3333-4333-8333-333333333333', M = '44444444-4444-4444-8444-444444444444';
const T = '2026-11-20T17:00:00.000Z';
const refused = (fn) => { try { fn(); return false; } catch { return true; } };
const row = (patch = {}) => ({ messageId: M, source: 'QUEUE', channel: 'EMAIL', direction: 'SENT', origin: 'STAFF', subject: 'A message from Dojo', preview: 'Hi', at: T, by: null,
  delivery: 'QUEUED', failureCode: null, resentFrom: null, ...patch });

test('0424 history query and resend input are closed; rows are checked for shape', () => {
  assert.deepEqual(contracts.validateContactHistoryQuery({ range: 'TODAY', search: 'karate', before: { at: T, id: M } }), { range: 'TODAY', search: 'karate', before: { at: T, id: M } });
  for (const bad of [{ range: 'WEEK' }, { search: '' }, { search: ' a' }, { search: 'x'.repeat(61) }, { search: 'a\u0007' }, { before: { at: T } }, { before: { at: 'yesterday', id: M } }, { other: 1 }])
    assert.ok(refused(() => contracts.validateContactHistoryQuery(bad)), JSON.stringify(bad));
  assert.ok(refused(() => contracts.validateContactEmailResendInput({ personId: P, messageId: M, schoolId: B })));
  assert.equal(contracts.verifyContactHistoryRow(row()).origin, 'STAFF');
  assert.equal(contracts.verifyContactHistoryRow(row({ source: 'CONVERSATION', channel: 'SMS', direction: 'RECEIVED', origin: 'CONVERSATION', subject: null, delivery: null, preview: '' })).preview, '');
  for (const bad of [row({ delivery: null }), row({ subject: null }), row({ channel: 'SMS' }), row({ direction: 'RECEIVED' }), row({ origin: 'FAMILY' }),
    row({ source: 'FAMILY', channel: 'APP', origin: 'FAMILY', subject: null, delivery: null, failureCode: 'BOUNCED' }), row({ channel: 'APP', subject: null }),
    row({ source: 'CONVERSATION', channel: 'SMS', direction: 'RECEIVED', origin: 'CONVERSATION', subject: null, delivery: null, resentFrom: M }), row({ preview: 'x'.repeat(161) }), row({ extra: 1 })])
    assert.ok(refused(() => contracts.verifyContactHistoryRow(bad)), JSON.stringify(bad).slice(0, 120));
});

test('0424 email view and resend receipt are the email asked for', () => {
  const view = { message: { messageId: M, personId: P, origin: 'STAFF', subject: 'Hi', subjectStandard: false, body: 'Line 1\nLine 2', at: T, by: null },
    delivery: { status: 'QUEUED', failureCode: null, attempts: 0, acceptedAt: null, finalAt: null, events: [] }, savedAddress: 'a@example.invalid', emailConsent: 'OPTED_IN',
    resentFrom: null, resends: [], canResend: true, resendBlocked: null };
  assert.equal(contracts.verifyContactEmailView(view, { personId: P, messageId: M }).message.body, 'Line 1\nLine 2');
  assert.ok(refused(() => contracts.verifyContactEmailView(view, { personId: P, messageId: A })));
  assert.ok(refused(() => contracts.verifyContactEmailView({ ...view, canResend: true, resendBlocked: 'LIMIT_REACHED' }, { personId: P, messageId: M })));
  assert.ok(refused(() => contracts.verifyContactEmailView({ ...view, emailConsent: 'OPTED_OUT' }, { personId: P, messageId: M })), 'resend offered without consent');
  assert.ok(refused(() => contracts.verifyContactEmailView({ ...view, message: { ...view.message, origin: 'FAMILY' } }, { personId: P, messageId: M })));
  const receipt = { messageId: A, resentFrom: M, personId: P, channel: 'EMAIL', delivery: 'QUEUED', at: T };
  assert.equal(contracts.verifyContactEmailResendReceipt(receipt, { personId: P, messageId: M }).messageId, A);
  for (const bad of [{ ...receipt, messageId: M }, { ...receipt, resentFrom: A }, { ...receipt, channel: 'SMS' }, { ...receipt, delivery: 'SENT' }])
    assert.ok(refused(() => contracts.verifyContactEmailResendReceipt(bad, { personId: P, messageId: M })));
});

test('0424 service and controller refuse before any database call', async () => {
  let calls = 0;
  const database = { withTenantReadOnlyTransaction: async () => { calls++; }, withTenantTransaction: async () => { calls++; }, resolveAuthorizedScope: async () => { calls++; return null; } };
  const service = new ContactMessagesService(database);
  const staff = { organizationId: A, schoolId: B, principalId: P, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'subject', requestId: A, correlationId: A, idempotencyKey: '' };
  const cmd = { ...staff, idempotencyKey: 'k1' };
  await assert.rejects(() => service.history({ ...staff, source: 'AI_AGENT' }, P, {}), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(() => service.history({ ...staff, delegatedByPrincipalId: A }, P, {}), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(() => service.history({ ...staff, idempotencyKey: 'k' }, P, {}), (e) => e.response.code === 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
  await assert.rejects(() => service.history(staff, 'nope', {}), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.history(staff, P, { range: 'WEEK' }), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.email(staff, P, 'nope'), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.resend(staff, P, M, {}), (e) => e.response.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(() => service.resend(cmd, P, M, { personId: A }), (e) => e.response.code === 'VALIDATION_FAILED', 'the body never names a person');
  await assert.rejects(() => service.resend(cmd, P, M, []), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.resend({ ...cmd, actionRequestId: A }, P, M, {}), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  assert.equal(calls, 0);
  const controller = new ContactMessagesController(database, service);
  const req = (patch = {}) => ({ honIdentity: { externalSubject: 'subject' }, originalUrl: '/v1/x', ...patch });
  const res = { status() { return this; } };
  await assert.rejects(() => controller.history(A, B, P, {}, 'k', req()), (e) => e.response.code === 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
  await assert.rejects(() => controller.email(A, B, P, M, { x: '1' }, undefined, req({ originalUrl: '/v1/x?x=1' })), (e) => e.response.code === 'CONTACT_HISTORY_SELECTORS_NOT_ACCEPTED');
  await assert.rejects(() => controller.resend(A, B, P, M, {}, {}, undefined, req(), res), (e) => e.response.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(() => controller.history(A, B, P, {}, undefined, req({ honIdentity: undefined })), (e) => e.response.code === 'IDENTITY_REQUIRED');
  assert.equal(calls, 0);
  await assert.rejects(() => controller.history(A, B, P, { range: 'TODAY' }, undefined, req()), (e) => e.response.code === 'CONVERSATION_FORBIDDEN');
  assert.equal(calls, 1, 'the scope is resolved from the session, never taken from the route');
});

test('0424 database refusals map to plain HTTP answers', async () => {
  const fail = (code, message) => ({ withTenantReadOnlyTransaction: async () => { throw Object.assign(new Error(message), { code }); },
    withTenantTransaction: async () => { throw Object.assign(new Error(message), { code }); } });
  const staff = { organizationId: A, schoolId: B, principalId: P, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'subject', requestId: A, correlationId: A, idempotencyKey: '' };
  const cmd = { ...staff, idempotencyKey: 'k1' };
  const cases = [['55000', 'CONTACT_RESEND_CONSENT_REQUIRED', 422, 'CONTACT_RESEND_CONSENT_REQUIRED'], ['55000', 'CONTACT_RESEND_LIMIT_REACHED', 422, 'CONTACT_RESEND_LIMIT_REACHED'],
    ['42501', 'CONVERSATION_FORBIDDEN', 403, 'CONVERSATION_FORBIDDEN'], ['P0002', 'CONTACT_MESSAGE_NOT_FOUND', 404, 'CONTACT_MESSAGE_NOT_FOUND'],
    ['23505', 'IDEMPOTENCY_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED'], ['22023', 'VALIDATION_FAILED', 400, 'VALIDATION_FAILED'], ['XX000', 'boom', 503, 'CONTACT_HISTORY_UNAVAILABLE']];
  for (const [code, message, status, answer] of cases) {
    const error = await new ContactMessagesService(fail(code, message)).resend(cmd, P, M, {}).catch(e => e);
    assert.equal(error.getStatus(), status, message); assert.equal(error.response.code, answer);
  }
  const notFound = await new ContactMessagesService(fail('P0002', 'CONTACT_NOT_FOUND')).history(staff, P, {}).catch(e => e);
  assert.equal(notFound.getStatus(), 404);
});

test('0424 SendGrid uses the author subject for school mail, the standard subject otherwise, and never for HQ mail', () => {
  const adapter = new SendGridEmailProvider(() => ({ SENDGRID_API_KEY: 'SG.test', HON_EMAIL_FROM: 'notices@hon.example', HON_EMAIL_SEND_APPROVED: 'true' }));
  const request = (over = {}) => ({ deliveryId: A, messageId: M, organizationId: A, schoolId: B, channel: 'EMAIL', recipientAddress: 'a@example.invalid', content: 'Hi',
    schoolName: 'Sunrise Dojo', attempt: 1, ...over });
  assert.equal(adapter.requestBody(request({ subject: 'Trial reminder' })).subject, 'Trial reminder');
  assert.equal(adapter.requestBody(request()).subject, 'A message from Sunrise Dojo');
  for (const subject of [' padded', 'line\nbreak', 'x'.repeat(151), ''])
    assert.equal(adapter.requestBody(request({ subject })).subject, 'A message from Sunrise Dojo', JSON.stringify(subject));
  assert.equal(adapter.requestBody(request({ subject: 'Trial reminder', origin: 'HQ', senderEmail: 'support@hon.example', senderName: 'HON' })).subject, 'A message from HON');
});
