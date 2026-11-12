const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { HqCommunicationsController } = require('../dist/hq-communications/hq-communications.controller.js');
const { HqCommunicationsService } = require('../dist/hq-communications/hq-communications.service.js');
const { HqMessageDispatcher } = require('../dist/hq-communications/hq-message-dispatcher.js');
const { CommunicationProviderError } = require('../dist/communication/delivery/communication-provider.js');
const { FakeCommunicationProvider } = require('../dist/communication/delivery/fake-communication-provider.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasCommandGuard, SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

// HQ-COMM (0281) HQ texting and email: closed inputs and responses, routes that forward only the verified subject, the path
// id, the declared query and the validated body, and the HQ dispatcher that sends whole texts through the HQ Messaging Service.
const U = () => randomUUID(), T = '2026-11-01T00:00:00.000Z', T2 = '2026-11-02T00:00:00.000Z';
const SID = 'MG' + '0123456789abcdef'.repeat(2);
const person = (n = 'HQ Agent') => ({ principalId: U(), displayName: n });
const summary = (patch = {}) => ({ pending: 0, accepted: 0, delivered: 0, suppressed: 0, failed: 0, unknown: 0, ...patch });
const msg = (patch = {}) => ({ messageId: U(), organizationId: U(), organizationDisplayName: 'Fixture Dojo', schoolId: U(), schoolDisplayName: 'Main',
  purpose: 'SUPPORT', channel: 'EMAIL', content: 'Your link was reset.', supportCaseId: null, status: 'DRAFT', recipientCount: 0, createdBy: person(),
  createdAt: T, queuedAt: null, cancelledAt: null, updatedAt: T, version: 1, deliverySummary: summary(), ...patch });
const sender = (patch = {}) => ({ senderId: U(), channel: 'EMAIL', status: 'ACTIVE', emailFrom: 'hello@hon.example', emailDisplayName: 'HON OS', smsServiceSid: null,
  a2pState: null, mmsConverterConfirmed: null, createdBy: person(), createdAt: T, version: 1, ...patch });
const smsSender = (patch = {}) => sender({ channel: 'SMS', emailFrom: null, emailDisplayName: null, smsServiceSid: SID, a2pState: 'PENDING', mmsConverterConfirmed: true, ...patch });
const view = (patch = {}) => ({ senders: { EMAIL: sender(), SMS: null }, messages: [msg()], limit: 50, nextCursor: null,
  viewer: { ...person(), purposes: ['ACCOUNT', 'SUPPORT'], canManageSenders: false }, asOf: T2, ...patch });
const delivery = (patch = {}) => ({ deliveryId: U(), recipient: person('Owner'), status: 'PENDING', holdReason: null, attempt: 0, provider: null, sentAs: null,
  segments: null, failureCode: null, acceptedAt: null, finalAt: null, updatedAt: T, ...patch });

test('contracts: HQ communication command values match the SaaS command table', () => {
  assert.deepEqual(contracts.HQ_COMMUNICATION_COMMANDS, { setSender: contracts.SAAS_COMMANDS.setHqCommunicationSender,
    retireSender: contracts.SAAS_COMMANDS.retireHqCommunicationSender, createMessage: contracts.SAAS_COMMANDS.createHqMessage,
    queueMessage: contracts.SAAS_COMMANDS.queueHqMessage, cancelMessage: contracts.SAAS_COMMANDS.cancelHqMessage });
});

test('contracts: a text sender is a Messaging Service with MMS Converter confirmed, never a bare phone number', () => {
  const sms = { channel: 'SMS', emailFrom: null, emailDisplayName: null, smsServiceSid: SID, a2pState: 'PENDING', mmsConverterConfirmed: true };
  assert.deepEqual(contracts.validateHqSenderSetInput(sms), sms);
  for (const bad of [{ ...sms, mmsConverterConfirmed: false }, { ...sms, mmsConverterConfirmed: null }, { ...sms, smsServiceSid: '+15555550100' },
    { ...sms, smsServiceSid: 'PN' + '0'.repeat(32) }, { ...sms, a2pState: 'DONE' }, { ...sms, emailFrom: 'a@b.co' }, { ...sms, extra: 1 }])
    assert.throws(() => contracts.validateHqSenderSetInput(bad), JSON.stringify(bad));
  const email = { channel: 'EMAIL', emailFrom: 'hello@hon.example', emailDisplayName: 'HON OS', smsServiceSid: null, a2pState: null, mmsConverterConfirmed: null };
  assert.deepEqual(contracts.validateHqSenderSetInput(email), email);
  for (const bad of [{ ...email, emailFrom: 'Hello@HON.example' }, { ...email, emailFrom: 'nope' }, { ...email, emailDisplayName: ' HON' },
    { ...email, emailDisplayName: 'HON <x>' }, { ...email, smsServiceSid: SID }, { ...email, channel: 'VOICE' }])
    assert.throws(() => contracts.validateHqSenderSetInput(bad), JSON.stringify(bad));
});

test('contracts: message content is whole, trimmed and bounded per channel; nothing is cut short', () => {
  const ok = { organizationId: U().toUpperCase(), schoolId: U(), purpose: 'BILLING', channel: 'SMS', content: '수업 안내입니다. '.repeat(100).trim(), supportCaseId: null };
  assert.ok(ok.content.length > 160 * 3 && ok.content.length <= 1600, 'a long Korean text');
  const parsed = contracts.validateHqMessageCreateInput(ok);
  assert.equal(parsed.content, ok.content); assert.equal(parsed.organizationId, ok.organizationId.toLowerCase());
  assert.equal(contracts.hqMessageMaxLength('SMS'), 1600); assert.equal(contracts.hqMessageMaxLength('EMAIL'), 4000);
  assert.equal(contracts.validateHqMessageCreateInput({ ...ok, channel: 'EMAIL', content: 'x'.repeat(4000) }).content.length, 4000);
  for (const bad of [{ ...ok, content: 'x'.repeat(1601) }, { ...ok, channel: 'EMAIL', content: 'x'.repeat(4001) }, { ...ok, content: ' padded' },
    { ...ok, content: '' }, { ...ok, content: 'bell\u0007' }, { ...ok, purpose: 'MARKETING' }, { ...ok, channel: 'VOICE' }, { ...ok, supportCaseId: 'x' }, { ...ok, extra: 1 }])
    assert.throws(() => contracts.validateHqMessageCreateInput(bad), JSON.stringify(bad).slice(0, 80));
  assert.deepEqual(contracts.validateHqMessageVersionInput({ expectedVersion: 2 }), { expectedVersion: 2 });
  for (const bad of [{}, { expectedVersion: 0 }, { expectedVersion: '2' }, { expectedVersion: 2, x: 1 }]) assert.throws(() => contracts.validateHqMessageVersionInput(bad));
  assert.deepEqual(contracts.validateHqCommunicationsQuery({}), { schoolId: null, cursor: null, limit: 50 });
  for (const bad of [{ limit: '0' }, { cursor: 'x' }, { status: 'QUEUED' }, { schoolId: 'x' }]) assert.throws(() => contracts.validateHqCommunicationsQuery(bad));
});

test('contracts: responses are closed, never carry an address, and stay consistent', () => {
  assert.equal(contracts.validateHqCommunicationsView(view()).messages.length, 1);
  for (const bad of [view({ messages: [{ ...msg(), recipientAddress: 'a@example.test' }] }), view({ messages: [msg({ purpose: 'BILLING' })] }),
    view({ senders: { EMAIL: smsSender(), SMS: null } }), view({ senders: { EMAIL: null, SMS: smsSender({ mmsConverterConfirmed: false }) } }),
    view({ messages: [msg({ status: 'QUEUED' })] }), view({ messages: [msg({ status: 'CANCELLED' })] }),
    view({ messages: [msg({ createdAt: T }), msg({ createdAt: T2 })], limit: 2 }), view({ viewer: { ...person(), purposes: [], canManageSenders: true } })])
    assert.throws(() => contracts.validateHqCommunicationsView(bad));
  const queued = msg({ status: 'QUEUED', queuedAt: T, recipientCount: 2, version: 2 });
  assert.equal(contracts.validateHqMessageDetail({ message: queued, deliveries: [delivery(), delivery()], viewer: person(), asOf: T2 }).deliveries.length, 2);
  for (const deliveries of [[delivery()], [delivery(), delivery({ address: 'x' })], [delivery(), delivery({ holdReason: 'NO_SENDER', status: 'SENDING' })],
    [delivery(), delivery({ providerMessageId: 'p' })]])
    assert.throws(() => contracts.validateHqMessageDetail({ message: queued, deliveries, viewer: person(), asOf: T2 }));
  assert.equal(contracts.validateHqMessageReceipt({ operation: 'QUEUE', message: queued, replayed: false }).operation, 'QUEUE');
  assert.throws(() => contracts.validateHqMessageReceipt({ operation: 'CANCEL', message: queued, replayed: false }));
  assert.throws(() => contracts.validateHqSenderReceipt({ operation: 'SENDER_RETIRE', sender: sender(), replayed: false }));
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end(body);
});
async function appWith(callSaasBilling) {
  const module = await Test.createTestingModule({ controllers: [HqCommunicationsController],
    providers: [HqCommunicationsService, SaasBillingService, SaasReadGuard, SaasCommandGuard, { provide: RuntimeDatabaseService, useValue: { callSaasBilling } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication({ bodyParser: false });
  app.use(json({ strict: true })); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${app.getHttpServer().address().port}/v1` };
}
const command = (marker, key = U()) => ({ origin: 'https://hon.example', 'x-hon-human-command': marker, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin',
  'sec-fetch-dest': 'empty', 'content-type': 'application/json', 'idempotency-key': key });

test('HTTP: reads and commands forward only the verified subject, the path id, the declared query and the validated body', async () => {
  const prior = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.example';
  const calls = []; let reply = () => view();
  const { app, base } = await appWith(async (operation, params) => { calls.push([operation, params]); return reply(); });
  try {
    const school = U();
    const ok = await send(`${base}/hq/communications?schoolId=${school}&limit=10`);
    assert.equal(ok.status, 200, ok.body); assert.equal(ok.headers['cache-control'], 'private, no-store');
    assert.deepEqual(calls.at(-1), ['readHqCommunications', ['verified-human', school, null, null, '10']]);
    const n = calls.length;
    for (const url of ['?status=QUEUED', '?limit=500', '?schoolId=nope']) assert.equal((await send(`${base}/hq/communications${url}`)).status, 400, url);
    assert.equal(calls.length, n, 'refused requests never reach the database');
    const m = msg({ status: 'QUEUED', queuedAt: T, recipientCount: 1, version: 2 });
    reply = () => ({ message: m, deliveries: [delivery()], viewer: person(), asOf: T2 });
    assert.equal((await send(`${base}/hq/communications/messages/${m.messageId}`)).status, 200);
    assert.equal((await send(`${base}/hq/communications/messages/${U()}`)).status, 503, 'an answer about another message is never shown');

    const input = { organizationId: U(), schoolId: U(), purpose: 'SUPPORT', channel: 'SMS', content: 'Long text '.repeat(150).trim(), supportCaseId: null }, key = U();
    reply = () => ({ operation: 'CREATE', message: msg({ channel: 'SMS', content: input.content }), replayed: false });
    const created = await send(`${base}/hq/communications/messages`, { method: 'POST', headers: command('hq-message-create', key), body: JSON.stringify(input) });
    assert.equal(created.status, 200, created.body);
    assert.deepEqual(calls.at(-1), ['createHqMessage', ['verified-human', JSON.stringify(input), key]]);
    const k = calls.length;
    assert.equal((await send(`${base}/hq/communications/messages`, { method: 'POST', headers: command('hq-message-queue'), body: JSON.stringify(input) })).status, 403, 'wrong marker');
    assert.equal((await send(`${base}/hq/communications/messages`, { method: 'POST', headers: { ...command('hq-message-create'), origin: 'https://evil.example' }, body: JSON.stringify(input) })).status, 403);
    assert.equal((await send(`${base}/hq/communications/messages`, { method: 'POST', headers: command('hq-message-create'), body: JSON.stringify({ ...input, content: 'x'.repeat(1601) }) })).status, 400);
    assert.equal((await send(`${base}/hq/communications/senders/${U()}/retire`, { method: 'POST', headers: command('hq-communication-sender-retire'), body: JSON.stringify({ x: 1 }) })).status, 400);
    assert.equal(calls.length, k);

    reply = () => ({ operation: 'QUEUE', message: m, replayed: false });
    assert.equal((await send(`${base}/hq/communications/messages/${m.messageId}/queue`, { method: 'POST', headers: command('hq-message-queue', key), body: JSON.stringify({ expectedVersion: 1 }) })).status, 200);
    assert.deepEqual(calls.at(-1), ['queueHqMessage', ['verified-human', m.messageId, JSON.stringify({ expectedVersion: 1 }), key]]);
    const smsIn = { channel: 'SMS', emailFrom: null, emailDisplayName: null, smsServiceSid: SID, a2pState: 'PENDING', mmsConverterConfirmed: true };
    reply = () => ({ operation: 'SENDER_SET', sender: smsSender(), replayed: false });
    assert.equal((await send(`${base}/hq/communications/senders`, { method: 'POST', headers: command('hq-communication-sender-set', key), body: JSON.stringify(smsIn) })).status, 200);
    assert.deepEqual(calls.at(-1), ['setHqCommunicationSender', ['verified-human', JSON.stringify(smsIn), key]]);
    const sid = U(); reply = () => ({ operation: 'SENDER_RETIRE', sender: smsSender({ status: 'RETIRED' }), replayed: false });
    assert.equal((await send(`${base}/hq/communications/senders/${sid}/retire`, { method: 'POST', headers: command('hq-communication-sender-retire', key), body: '{}' })).status, 200);
    assert.deepEqual(calls.at(-1), ['retireHqCommunicationSender', ['verified-human', sid, key]]);

    for (const [code, message, status, answer] of [['42501', 'SAAS_FORBIDDEN', 403, 'SAAS_FORBIDDEN'], ['40001', 'SAAS_VERSION_CONFLICT', 409, 'SAAS_VERSION_CONFLICT'],
      ['23514', 'HQ_MESSAGE_NO_RECIPIENTS', 422, 'HQ_MESSAGE_NO_RECIPIENTS'], ['23514', 'HQ_MESSAGE_NOT_DRAFT', 422, 'HQ_MESSAGE_NOT_DRAFT'],
      ['23514', 'HQ_MESSAGE_NOT_CANCELLABLE', 422, 'HQ_MESSAGE_NOT_CANCELLABLE'], ['23514', 'HQ_SENDER_EXISTS', 422, 'HQ_SENDER_EXISTS'],
      ['P0002', 'SAAS_UNAVAILABLE', 404, 'SAAS_UNAVAILABLE'], ['23505', 'SAAS_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED']]) {
      reply = () => { const e = new Error(message); e.code = code; throw e; };
      const r = await send(`${base}/hq/communications/messages/${m.messageId}/cancel`, { method: 'POST', headers: command('hq-message-cancel'), body: JSON.stringify({ expectedVersion: 2 }) });
      assert.deepEqual([r.status, JSON.parse(r.body).code], [status, answer], message);
    }
  } finally { await app.close(); if (prior === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = prior; }
});

const lease = (over = {}) => ({ deliveryId: U(), leaseToken: U(), organizationId: U(), schoolId: U(), messageId: U(), channel: 'SMS',
  recipientAddress: '+15555550101', content: '안녕하세요 '.repeat(200).trim(), senderRef: SID, senderName: 'HON OS', attempt: 1, ...over });
function store(claims) {
  const calls = { claim: [], results: [] };
  return { calls, isConfigured: () => true,
    claim: async (channels, limit, leaseSeconds) => { calls.claim.push({ channels, limit, leaseSeconds }); return claims; },
    recordResult: async (id, token, result) => { calls.results.push({ id, token, result }); return { status: { ACCEPTED: 'ACCEPTED', RETRYABLE: 'PENDING', FAILED: 'FAILED', UNKNOWN: 'UNKNOWN' }[result.outcome], accepted: true }; } };
}

test('HQ dispatcher: a long text goes whole through the HQ Messaging Service; email carries the HQ from-address', async () => {
  const s = store([lease(), lease({ channel: 'EMAIL', recipientAddress: 'owner@example.test', content: 'Invoice ready', senderRef: 'hello@hon.example' })]);
  const seen = [];
  const adapter = (channel) => ({ provider: 'TWILIO', channel, readiness: () => 'READY', send: async (r) => { seen.push(r); return { providerMessageId: `p-${seen.length}`, sentAs: channel === 'SMS' ? 'MMS' : 'EMAIL' }; } });
  const summary = await new HqMessageDispatcher(s, [adapter('SMS'), adapter('EMAIL')]).runOnce(10);
  assert.deepEqual(s.calls.claim, [{ channels: ['EMAIL', 'SMS'], limit: 10, leaseSeconds: 60 }]);
  assert.equal(summary.accepted, 2);
  const [sms, email] = seen;
  assert.equal(sms.content, lease().content, 'the whole text is handed over; nothing is cut short');
  assert.deepEqual([sms.origin, sms.senderServiceId, sms.senderEmail, sms.schoolName], ['HQ', SID, undefined, 'HON OS']);
  assert.deepEqual([email.senderEmail, email.senderServiceId], ['hello@hon.example', undefined]);
  assert.equal(s.calls.results[0].result.sentAs, 'MMS');
});

test('HQ dispatcher: never claims without a READY adapter; maps provider errors; unexpected errors are UNKNOWN', async () => {
  const none = store([lease()]);
  await new HqMessageDispatcher(none, [new FakeCommunicationProvider('SMS', () => ({}))]).runOnce();
  assert.equal(none.calls.claim.length, 0, 'the fake provider is not READY without its flag');
  for (const [error, expected] of [[new CommunicationProviderError('RETRYABLE', 'PROVIDER_FAILED', 5), { outcome: 'RETRYABLE', provider: 'FAKE', retryAfterSeconds: 30 }],
    [new CommunicationProviderError('FAILED', 'INVALID_ADDRESS'), { outcome: 'FAILED', provider: 'FAKE', failureCode: 'INVALID_ADDRESS' }],
    [new Error('socket hang up'), { outcome: 'UNKNOWN', provider: 'FAKE' }]]) {
    const s = store([lease()]);
    await new HqMessageDispatcher(s, [{ provider: 'FAKE', channel: 'SMS', readiness: () => 'READY', send: async () => { throw error; } }]).runOnce();
    assert.deepEqual(s.calls.results[0].result, expected);
  }
  const fake = new FakeCommunicationProvider('EMAIL', () => ({ HON_COMMUNICATION_FAKE_PROVIDER: '1' }));
  const s = store([lease({ channel: 'EMAIL', recipientAddress: 'owner@example.test', senderRef: 'hello@hon.example' })]);
  await new HqMessageDispatcher(s, [fake]).runOnce();
  assert.equal(fake.sent.length, 1); assert.equal(JSON.stringify(fake.sent).includes('owner@example.test'), false, 'the fake keeps no address');
});
