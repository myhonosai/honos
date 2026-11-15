const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const contracts = require('@hon/contracts');
const { TwilioWebhookVerifier, TwilioWebhookError } = require('../dist/communication/delivery/twilio-text-provider.js');
const { CommunicationWebhookController } = require('../dist/communication/delivery/communication-webhook.controller.js');
const { SendGridEventWebhookVerifier } = require('../dist/communication/delivery/sendgrid-email-provider.js');
const { SchoolConversationsService } = require('../dist/conversations/school-conversations.service.js');
const { SchoolConversationsController } = require('../dist/conversations/school-conversations.controller.js');

const account = `AC${'c'.repeat(32)}`;
const approved = () => ({ TWILIO_ACCOUNT_SID: account, TWILIO_AUTH_TOKEN: 'tok', HON_PUBLIC_API_ORIGIN: 'https://api.hon.example', HON_SMS_SEND_APPROVED: 'true' });
function signed(path, fields, token = 'tok') {
  const params = new URLSearchParams(fields);
  const data = [...new Set(params.keys())].sort().reduce((acc, name) => acc + name + params.get(name), `https://api.hon.example${path}`);
  return { body: Buffer.from(params.toString()), signature: createHmac('sha1', token).update(data).digest('base64') };
}
const reason = (fn) => { try { fn(); return 'OK'; } catch (error) { return error instanceof TwilioWebhookError ? error.reason : error.message; } };
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const sid = `SM${'e'.repeat(32)}`;
const empty = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const text = (Body, extra = {}) => signed('/v1/communications/webhooks/twilio/inbound', { AccountSid: account, MessageSid: sid, From: '+15555550101', To: '+15555559001', Body, ...extra });

test('0364 inbound conversation text: signed fields only, text capped at 1,600, media count capped at 10, forged or malformed refused', () => {
  const verifier = new TwilioWebhookVerifier(() => approved(), () => 1_800_000_000_000);
  const at = new Date(1_800_000_000_000).toISOString();
  let s = text('Do you have kids classes?', { NumMedia: '2' });
  assert.deepEqual(verifier.inboundMessage(s.body, s.signature), { to: '+15555559001', from: '+15555550101', body: 'Do you have kids classes?', mediaCount: 2, providerMessageId: sid, receivedAt: at });
  s = text('x'.repeat(2000), { NumMedia: '40' });
  const long = verifier.inboundMessage(s.body, s.signature);
  assert.deepEqual([long.body.length, long.mediaCount], [1600, 10]);
  for (const NumMedia of ['-1', 'abc', '']) { s = text('hi', { NumMedia }); assert.equal(verifier.inboundMessage(s.body, s.signature).mediaCount, 0); }
  s = text('hi');
  assert.equal(reason(() => verifier.inboundMessage(s.body, signed('/v1/communications/webhooks/twilio/inbound', { AccountSid: account }, 'other').signature)), 'SIGNATURE_INVALID');
  s = signed('/v1/communications/webhooks/twilio/inbound', { AccountSid: account, MessageSid: 'bad', From: '+15555550101', To: '+15555559001', Body: 'hi' });
  assert.equal(reason(() => verifier.inboundMessage(s.body, s.signature)), 'MALFORMED');
  s = signed('/v1/communications/webhooks/twilio/inbound', { AccountSid: account, MessageSid: sid, From: '5550101', To: '+15555559001', Body: 'hi' });
  assert.equal(reason(() => verifier.inboundMessage(s.body, s.signature)), 'MALFORMED');
});

test('0364 webhook: keywords stay keywords, other texts go to the conversations inbox once, answered empty; trouble asks Twilio to retry', async () => {
  const verifier = new TwilioWebhookVerifier(() => approved(), () => 1_800_000_000_000);
  const make = ({ configured = true, fail = false, intake = true } = {}) => {
    const keywords = [], texts = [];
    const store = { isConfigured: () => configured, recordInboundKeyword: async (k) => { keywords.push(k.keyword); } };
    if (intake) store.recordInboundConversationText = async (t) => { if (fail) throw new Error('db +15555550101'); texts.push(t); return { outcome: 'RECORDED', conversationId: A }; };
    return { keywords, texts, controller: new CommunicationWebhookController(store, new SendGridEventWebhookVerifier(() => ({})), verifier) };
  };
  let run = make();
  const stop = text('STOP');
  assert.equal(await run.controller.twilioInbound({ body: stop.body }, stop.signature), empty);
  assert.deepEqual([run.keywords, run.texts.length], [['STOP'], 0]);
  const question = text('What time is the adult class?');
  assert.equal(await run.controller.twilioInbound({ body: question.body }, question.signature), empty, 'no automatic answer from the webhook');
  assert.deepEqual(run.keywords, ['STOP']);
  assert.deepEqual(run.texts.map((t) => [t.to, t.from, t.body, t.providerMessageId]), [['+15555559001', '+15555550101', 'What time is the adult class?', sid]]);
  // A keyword with control characters in it is still the keyword (the intake drops them too), so an opt-out is never lost.
  const hidden = text('ST\u0001OP\u0000');
  assert.equal(await run.controller.twilioInbound({ body: hidden.body }, hidden.signature), empty);
  assert.deepEqual([run.keywords, run.texts.length], [['STOP', 'STOP'], 1]);
  const nul = text('Hi\u0000 there');
  await run.controller.twilioInbound({ body: nul.body }, nul.signature);
  assert.equal(run.texts.at(-1).body, 'Hi there', 'NUL never reaches the database');
  // An older store without the intake keeps the old behavior: empty answer, nothing recorded.
  run = make({ intake: false });
  assert.equal(await run.controller.twilioInbound({ body: question.body }, question.signature), empty);
  // An unconfigured database or a failed write is a retry, never a silent drop.
  run = make({ configured: false });
  await assert.rejects(run.controller.twilioInbound({ body: question.body }, question.signature), (e) => e.getStatus() === 503);
  run = make({ fail: true });
  await assert.rejects(run.controller.twilioInbound({ body: question.body }, question.signature), (e) => e.getStatus() === 503 && e.getResponse().code === 'COMMUNICATION_WEBHOOK_RETRY');
  // A forged request never reaches the store.
  run = make();
  await assert.rejects(run.controller.twilioInbound({ body: question.body }, signed('/x', {}, 'other').signature), (e) => e.getStatus() === 400 || e.getStatus() === 403);
  assert.equal(run.texts.length, 0);
});

test('0364 conversation inputs are closed', () => {
  assert.deepEqual(contracts.validateConversationListQuery({}), {});
  assert.throws(() => contracts.validateConversationListQuery({ status: 'DELETED' }));
  assert.throws(() => contracts.validateConversationListQuery({ extra: 1 }));
  assert.ok(contracts.validateReplyConversationInput({ conversationId: A, expectedVersion: 1, body: 'Hi' }));
  for (const body of ['', ' ', 'x'.repeat(1601), 'bad\u0007']) assert.throws(() => contracts.validateReplyConversationInput({ conversationId: A, expectedVersion: 1, body }));
  assert.throws(() => contracts.validateReplyConversationInput({ conversationId: A, expectedVersion: 0, body: 'Hi' }));
  assert.throws(() => contracts.validateReplyConversationInput({ conversationId: A, expectedVersion: 1, body: 'Hi', to: '+15555550101' }));
  assert.throws(() => contracts.validateUpdateConversationInput({ conversationId: A, expectedVersion: 1 }), undefined, 'an update changes something');
  assert.throws(() => contracts.validateUpdateConversationInput({ conversationId: A, expectedVersion: 1, tags: Array.from({ length: 11 }, (_, i) => 't' + i) }));
  assert.throws(() => contracts.validateUpdateConversationInput({ conversationId: A, expectedVersion: 1, tags: ['Trial', 'trial'] }));
  assert.throws(() => contracts.validateMarkConversationReadInput({ conversationId: A }));
  assert.throws(() => contracts.validateLinkConversationInput({ conversationId: A, expectedVersion: 1, personId: 'nope' }));
});

test('0364 service and controller refuse before any database call', async () => {
  let calls = 0;
  const database = new Proxy({}, { get: () => () => { calls += 1; throw new Error('database must not be reached'); } });
  const service = new SchoolConversationsService(database);
  const staff = { organizationId: A, schoolId: B, principalId: C, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'subject', requestId: A, correlationId: A, idempotencyKey: '' };
  const cmd = { ...staff, idempotencyKey: 'k1' };
  await assert.rejects(() => service.list({ ...staff, source: 'AI_AGENT' }, {}), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(() => service.list({ ...staff, delegatedByPrincipalId: A }, {}), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(() => service.list({ ...staff, idempotencyKey: 'k' }, {}), (e) => e.response.code === 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
  await assert.rejects(() => service.list(staff, { status: 'GONE' }), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.detail(staff, 'nope', null), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.detail(staff, A, 'nope'), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.reply(staff, A, { expectedVersion: 1, body: 'Hi' }), (e) => e.response.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(() => service.reply(cmd, A, { expectedVersion: 1, body: 'Hi', conversationId: B }), (e) => e.response.code === 'VALIDATION_FAILED', 'the body never names a conversation');
  await assert.rejects(() => service.reply(cmd, A, [1]), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.update({ ...cmd, actionRequestId: A }, A, { expectedVersion: 1, status: 'CLOSED' }), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(() => service.markRead(staff, A, {}), (e) => e.response.code === 'VALIDATION_FAILED');
  assert.equal(calls, 0);
  const failing = new SchoolConversationsService({ withTenantReadOnlyTransaction: async () => { throw Object.assign(new Error('boom +15555550101'), { code: 'XX000' }); } });
  await assert.rejects(() => failing.list(staff, {}), (e) => e.response.code === 'CONVERSATION_UNAVAILABLE' && !JSON.stringify(e.response).includes('+1555'));
  const state = new SchoolConversationsService({ withTenantTransaction: async () => { throw Object.assign(new Error('CONVERSATION_CONSENT_REQUIRED'), { code: '55000' }); } });
  await assert.rejects(() => state.reply(cmd, A, { expectedVersion: 1, body: 'Hi' }), (e) => e.getStatus() === 422 && e.response.code === 'CONVERSATION_CONSENT_REQUIRED' && /consent/.test(e.response.detail));

  // Controller: commands need an Idempotency-Key, reads and mark-read refuse one, and query selectors are refused.
  const controller = new SchoolConversationsController(database, service);
  const req = { honIdentity: { externalSubject: 'subject' }, originalUrl: '/x' };
  const res = { status: () => res };
  await assert.rejects(() => controller.list(A, B, {}, 'k', req), (e) => e.response.code === 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
  await assert.rejects(() => controller.detail(A, B, A, { page: '2' }, undefined, req), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => controller.reply(A, B, A, {}, { body: 'Hi' }, undefined, req, res), (e) => e.response.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(() => controller.reply(A, B, A, {}, { body: 'Hi' }, ' k', req, res), (e) => e.response.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(() => controller.reply(A, B, A, { to: 'x' }, { body: 'Hi' }, 'k', req, res), (e) => e.response.code === 'CONVERSATION_SELECTORS_NOT_ACCEPTED');
  await assert.rejects(() => controller.reply(A, B, A, {}, { body: 'Hi' }, 'k', { ...req, originalUrl: '/x?schoolId=1' }, res), (e) => e.response.code === 'CONVERSATION_SELECTORS_NOT_ACCEPTED');
  await assert.rejects(() => controller.markRead(A, B, A, {}, {}, 'k', req), (e) => e.response.code === 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
  await assert.rejects(() => controller.list(A, B, {}, undefined, { originalUrl: '/x' }), (e) => e.response.code === 'IDENTITY_REQUIRED');
  assert.equal(calls, 0);
  // With the scope proved, list filters arrive only as single strings, and a half keyset cursor is refused.
  const proved = new SchoolConversationsController({ resolveAuthorizedScope: async () => ({ organizationId: A, schoolId: B, principalId: C }) }, service);
  await assert.rejects(() => proved.list(A, B, { beforeAt: '2026-11-01T00:00:00.000Z' }, undefined, req), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => proved.list(A, B, { status: ['OPEN', 'CLOSED'] }, undefined, req), (e) => e.response.code === 'VALIDATION_FAILED');
  await assert.rejects(() => proved.list(A, B, { unreadOnly: 'yes' }, undefined, req), (e) => e.response.code === 'VALIDATION_FAILED');
  assert.equal(calls, 0);
  // A scope resolved for another school or organization is refused.
  const scoped = new SchoolConversationsController({ resolveAuthorizedScope: async () => ({ organizationId: A, schoolId: C, principalId: C }) }, service);
  await assert.rejects(() => scoped.list(A, B, {}, undefined, req), (e) => e.response.code === 'CONVERSATION_FORBIDDEN');
});
