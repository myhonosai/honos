const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { countTextPieces, smartEncodeText, TEXT_MAX_CHARACTERS } = require('@hon/contracts');
const { TwilioTextProvider, TwilioWebhookVerifier, TwilioWebhookError } = require('../dist/communication/delivery/twilio-text-provider.js');
const { CommunicationProviderError } = require('../dist/communication/delivery/communication-provider.js');
const { validateSchoolTextSenderInput } = require('../dist/communication/delivery/school-text-sender.controller.js');

test('text pieces: GSM-7 160/153, UCS-2 70/67, extension characters count two, smart encoding keeps English GSM-7', () => {
  assert.deepEqual(countTextPieces('a'.repeat(160)), { encoding: 'GSM7', units: 160, pieces: 1, sendAs: 'SMS', tooLong: false });
  assert.equal(countTextPieces('a'.repeat(161)).pieces, 2);
  assert.equal(countTextPieces('a'.repeat(307)).pieces, 3);
  assert.equal(countTextPieces('a'.repeat(307)).sendAs, 'MMS');
  assert.equal(countTextPieces('{'.repeat(80)).units, 160);
  assert.equal(countTextPieces('{'.repeat(81)).pieces, 2);
  assert.deepEqual(countTextPieces('수업'.repeat(35)), { encoding: 'UCS2', units: 70, pieces: 1, sendAs: 'SMS', tooLong: false });
  assert.equal(countTextPieces('수'.repeat(71)).pieces, 2);
  assert.equal(countTextPieces('수'.repeat(400)).pieces, 6);
  assert.equal(countTextPieces('수'.repeat(400)).sendAs, 'MMS');
  assert.equal(countTextPieces('Clase mañana a las 5').encoding, 'GSM7');
  assert.equal(countTextPieces('Clase el sábado').encoding, 'UCS2');
  assert.equal(countTextPieces('See you 👋').encoding, 'UCS2');
  assert.equal(smartEncodeText('“Don’t forget” — class…'), '"Don\'t forget" - class...');
  assert.equal(countTextPieces('“Don’t forget” — class…').encoding, 'GSM7');
  assert.equal(countTextPieces('a'.repeat(TEXT_MAX_CHARACTERS + 1)).tooLong, true);
  assert.equal(countTextPieces('').pieces, 0);
});

const account = `AC${'c'.repeat(32)}`;
const approved = (over = {}) => ({ TWILIO_ACCOUNT_SID: account, TWILIO_AUTH_TOKEN: 'tok', HON_PUBLIC_API_ORIGIN: 'https://api.hon.example', HON_SMS_SEND_APPROVED: 'true', ...over });
const request = (over = {}) => ({ deliveryId: '11111111-1111-4111-8111-111111111111', messageId: '55555555-5555-4555-8555-555555555555',
  organizationId: '33333333-3333-4333-8333-333333333333', schoolId: '44444444-4444-4444-8444-444444444444', channel: 'SMS',
  recipientAddress: '+15555550101', content: 'Class at 5 — see you!', schoolName: 'Day', attempt: 1,
  senderAddress: '+15555559001', senderServiceId: `MG${'a'.repeat(32)}`, ...over });
const isErr = (outcome, code) => (e) => e instanceof CommunicationProviderError && e.outcome === outcome && e.failureCode === code;

test('Twilio adapter is READY only with account, token, https origin and the exact send approval', async () => {
  for (const env of [{}, approved({ TWILIO_ACCOUNT_SID: 'AC1' }), approved({ TWILIO_AUTH_TOKEN: ' ' }), approved({ HON_PUBLIC_API_ORIGIN: 'http://api.hon.example' }),
    approved({ HON_PUBLIC_API_ORIGIN: 'https://api.hon.example/api?x=1' }), approved({ HON_SMS_SEND_APPROVED: 'yes' })]) {
    let calls = 0;
    const adapter = new TwilioTextProvider(() => env, async () => { calls += 1; throw new Error('NETWORK_FORBIDDEN'); });
    assert.equal(adapter.readiness(), 'CONFIGURATION_REQUIRED');
    await assert.rejects(adapter.send(request()), isErr('RETRYABLE', 'PROVIDER_FAILED'));
    assert.equal(calls, 0);
  }
});

test('Twilio send: school Messaging Service, smart-encoded body, status callback, measured pieces; refusals before any call', async () => {
  let seen;
  const adapter = new TwilioTextProvider(() => approved(), async (url, init) => { seen = { url, init }; return { status: 201, json: async () => ({ sid: `SM${'d'.repeat(32)}`, num_segments: '1' }) }; });
  assert.deepEqual(await adapter.send(request()), { providerMessageId: `SM${'d'.repeat(32)}`, sentAs: 'SMS', encoding: 'GSM7', segments: 1 });
  assert.equal(seen.url, `https://api.twilio.com/2010-04-01/Accounts/${account}/Messages.json`);
  const form = new URLSearchParams(seen.init.body);
  assert.equal(form.get('MessagingServiceSid'), `MG${'a'.repeat(32)}`);
  assert.equal(form.get('Body'), 'Class at 5 - see you!');
  assert.equal(form.get('StatusCallback'), 'https://api.hon.example/v1/communications/webhooks/twilio/status');
  assert.equal(seen.init.headers.authorization, `Basic ${Buffer.from(`${account}:tok`).toString('base64')}`);
  const long = await adapter.send(request({ content: '수'.repeat(400) }));
  assert.equal(long.sentAs, 'MMS');
  let calls = 0;
  const counting = new TwilioTextProvider(() => approved(), async () => { calls += 1; return { status: 201, json: async () => ({}) }; });
  await assert.rejects(counting.send(request({ recipientAddress: '5555550101' })), isErr('FAILED', 'INVALID_ADDRESS'));
  await assert.rejects(counting.send(request({ content: 'a'.repeat(1601) })), isErr('FAILED', 'PROVIDER_REJECTED'));
  await assert.rejects(counting.send(request({ senderServiceId: undefined })), isErr('RETRYABLE', 'PROVIDER_FAILED'));
  assert.equal(calls, 0);
});

test('Twilio outcomes: invalid number, rejection, rate limit, auth, server error, missing sid, network', async () => {
  const run = (response) => new TwilioTextProvider(() => approved(), async () => { if (response instanceof Error) throw response; return response; }).send(request());
  const json = (status, body) => ({ status, json: async () => body });
  await assert.rejects(run(json(400, { code: 21211 })), isErr('FAILED', 'INVALID_ADDRESS'));
  await assert.rejects(run(json(400, { code: 21610 })), isErr('FAILED', 'PROVIDER_REJECTED'));
  await assert.rejects(run(json(429, {})), isErr('RETRYABLE', 'PROVIDER_FAILED'));
  await assert.rejects(run(json(401, {})), (e) => isErr('RETRYABLE', 'PROVIDER_FAILED')(e) && e.retryAfterSeconds === 900);
  await assert.rejects(run(json(500, {})), isErr('UNKNOWN', 'PROVIDER_UNKNOWN'));
  await assert.rejects(run(json(201, { sid: 'nope' })), isErr('UNKNOWN', 'PROVIDER_UNKNOWN'));
  await assert.rejects(run(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), isErr('RETRYABLE', 'PROVIDER_FAILED'));
  await assert.rejects(run(new Error('timeout')), isErr('UNKNOWN', 'PROVIDER_UNKNOWN'));
});

function signed(path, fields, token = 'tok') {
  const params = new URLSearchParams(fields);
  const data = [...new Set(params.keys())].sort().reduce((acc, name) => acc + name + params.get(name), `https://api.hon.example${path}`);
  return { body: Buffer.from(params.toString()), signature: createHmac('sha1', token).update(data).digest('base64') };
}
const reason = (fn) => { try { return fn(); } catch (error) { return error instanceof TwilioWebhookError ? error.reason : error.message; } };

test('Twilio signatures: status callbacks map to receipts; forged, other-account and unconfigured requests are refused', () => {
  const verifier = new TwilioWebhookVerifier(() => approved(), () => 1_800_000_000_000);
  const sid = `SM${'d'.repeat(32)}`;
  const ok = signed('/v1/communications/webhooks/twilio/status', { AccountSid: account, MessageSid: sid, MessageStatus: 'delivered', To: '+15555550101' });
  assert.deepEqual(verifier.status(ok.body, ok.signature), { provider: 'TWILIO', providerEventId: `${sid}:delivered`, providerMessageId: sid, eventType: 'DELIVERED', occurredAt: new Date(1_800_000_000_000).toISOString() });
  const queued = signed('/v1/communications/webhooks/twilio/status', { AccountSid: account, MessageSid: sid, MessageStatus: 'queued' });
  assert.equal(verifier.status(queued.body, queued.signature), null);
  assert.equal(reason(() => verifier.status(ok.body, signed('/v1/communications/webhooks/twilio/status', { AccountSid: account }, 'other').signature)), 'SIGNATURE_INVALID');
  assert.equal(reason(() => verifier.status(Buffer.from(ok.body.toString().replace('delivered', 'failed')), ok.signature)), 'SIGNATURE_INVALID');
  const otherAccount = signed('/v1/communications/webhooks/twilio/status', { AccountSid: `AC${'e'.repeat(32)}`, MessageSid: sid, MessageStatus: 'delivered' });
  assert.equal(reason(() => verifier.status(otherAccount.body, otherAccount.signature)), 'SIGNATURE_INVALID');
  const wrongPath = signed('/v1/communications/webhooks/twilio/inbound', { AccountSid: account, MessageSid: sid, MessageStatus: 'delivered' });
  assert.equal(reason(() => verifier.status(wrongPath.body, wrongPath.signature)), 'SIGNATURE_INVALID');
  assert.equal(reason(() => new TwilioWebhookVerifier(() => ({})).status(ok.body, ok.signature)), 'NOT_CONFIGURED');
});

test('Twilio HQ sends use the HQ status callback; HQ status callbacks are signed over their own path and come back scope HQ', async () => {
  let seen;
  const adapter = new TwilioTextProvider(() => approved(), async (_url, init) => { seen = new URLSearchParams(init.body); return { status: 201, json: async () => ({ sid: `SM${'d'.repeat(32)}`, num_segments: '1' }) }; });
  assert.equal(adapter.hqSender, true);
  await adapter.send(request({ origin: 'HQ', senderServiceId: `MG${'b'.repeat(32)}` }));
  assert.equal(seen.get('MessagingServiceSid'), `MG${'b'.repeat(32)}`);
  assert.equal(seen.get('StatusCallback'), 'https://api.hon.example/v1/communications/webhooks/twilio/hq-status');
  await adapter.send(request({ origin: 'HQ', statusCallback: false }));
  assert.equal(seen.get('StatusCallback'), null);
  const verifier = new TwilioWebhookVerifier(() => approved(), () => 1_800_000_000_000);
  const sid = `SM${'d'.repeat(32)}`;
  const fields = { AccountSid: account, MessageSid: sid, MessageStatus: 'undelivered' };
  const hq = signed('/v1/communications/webhooks/twilio/hq-status', fields);
  assert.deepEqual(verifier.hqStatus(hq.body, hq.signature), { provider: 'TWILIO', providerEventId: `${sid}:undelivered`, providerMessageId: sid, eventType: 'UNDELIVERED',
    occurredAt: new Date(1_800_000_000_000).toISOString(), scope: 'HQ' });
  // A school status callback cannot be replayed onto the HQ path, nor an HQ one onto the school path.
  const school = signed('/v1/communications/webhooks/twilio/status', fields);
  assert.equal(reason(() => verifier.hqStatus(school.body, school.signature)), 'SIGNATURE_INVALID');
  assert.equal(reason(() => verifier.status(hq.body, hq.signature)), 'SIGNATURE_INVALID');
  const queued = signed('/v1/communications/webhooks/twilio/hq-status', { ...fields, MessageStatus: 'queued' });
  assert.equal(verifier.hqStatus(queued.body, queued.signature), null);

  const { CommunicationWebhookController, COMMUNICATION_WEBHOOK_PATHS } = require('../dist/communication/delivery/communication-webhook.controller.js');
  const { SendGridEventWebhookVerifier } = require('../dist/communication/delivery/sendgrid-email-provider.js');
  assert.equal(COMMUNICATION_WEBHOOK_PATHS.has('/v1/communications/webhooks/twilio/hq-status'), true);
  const seenSchool = [];
  const seenHq = [];
  const schoolStore = { isConfigured: () => true, recordReceipt: async (r) => { seenSchool.push(r); return { outcome: 'RECORDED' }; } };
  const hqStore = { isConfigured: () => true, recordReceipt: async (r) => { seenHq.push(r); return { outcome: 'RECORDED', deliveryStatus: 'FAILED' }; } };
  const controller = new CommunicationWebhookController(schoolStore, new SendGridEventWebhookVerifier(() => ({})), verifier, undefined, hqStore);
  assert.deepEqual(await controller.twilioHqStatus({ body: hq.body }, hq.signature), { received: true, recorded: 1, replayed: 0, ignored: 0 });
  assert.deepEqual([seenSchool.length, seenHq.map((r) => r.providerEventId)], [0, [`${sid}:undelivered`]]);
  assert.deepEqual(await controller.twilioHqStatus({ body: queued.body }, queued.signature), { received: true, recorded: 0, replayed: 0, ignored: 1 });
  await assert.rejects(controller.twilioHqStatus({ body: school.body }, school.signature), (e) => e.getStatus() === 400);
  await assert.rejects(controller.twilioHqStatus({ body: 'not a buffer' }, hq.signature), (e) => e.getStatus() === 400);
  await assert.rejects(new CommunicationWebhookController(schoolStore, new SendGridEventWebhookVerifier(() => ({})), verifier).twilioHqStatus({ body: hq.body }, hq.signature),
    (e) => e.getStatus() === 503);
});

test('Twilio inbound: only exact STOP/START/HELP words are keywords', () => {
  const verifier = new TwilioWebhookVerifier(() => approved(), () => 1_800_000_000_000);
  const inbound = (body) => {
    const s = signed('/v1/communications/webhooks/twilio/inbound', { AccountSid: account, MessageSid: `SM${'f'.repeat(32)}`, From: '+15555550101', To: '+15555559001', Body: body });
    return verifier.inbound(s.body, s.signature);
  };
  assert.equal(inbound(' Stop. ').keyword, 'STOP');
  assert.equal(inbound('unsubscribe').keyword, 'STOP');
  assert.equal(inbound('UNSTOP').keyword, 'START');
  assert.equal(inbound('help').keyword, 'HELP');
  assert.equal(inbound('please stop texting me at night'), null);
  assert.equal(inbound('Can I come at 6?'), null);
  assert.deepEqual(Object.keys(inbound('STOP')).sort(), ['from', 'keyword', 'providerMessageId', 'receivedAt', 'to']);
});

test('HQ text sender input is strict', () => {
  const sid = `MG${'a'.repeat(32)}`;
  const ok = { phoneE164: '+15555559001', messagingServiceSid: sid, status: 'ACTIVE', mmsConverterConfirmed: true };
  assert.deepEqual(validateSchoolTextSenderInput(ok), ok);
  assert.deepEqual(validateSchoolTextSenderInput({ ...ok, status: 'DISABLED', mmsConverterConfirmed: false, expectedVersion: 2 }), { ...ok, status: 'DISABLED', mmsConverterConfirmed: false, expectedVersion: 2 });
  assert.throws(() => validateSchoolTextSenderInput({ ...ok, mmsConverterConfirmed: false }), (e) => e.getStatus() === 400 && e.getResponse().code === 'MMS_CONVERTER_NOT_CONFIRMED');
  assert.throws(() => validateSchoolTextSenderInput({ phoneE164: '+15555559001', messagingServiceSid: sid, status: 'ACTIVE' }), (e) => e.getStatus() === 400);
  for (const body of [null, [], { phoneE164: '5555559001', messagingServiceSid: sid, status: 'ACTIVE' }, { phoneE164: '+15555559001', messagingServiceSid: 'MG1', status: 'ACTIVE' },
    { phoneE164: '+15555559001', messagingServiceSid: sid, status: 'ON' }, { ...ok, extra: 1 }, { ...ok, mmsConverterConfirmed: 'yes' },
    { phoneE164: '+15555559001', messagingServiceSid: sid, status: 'ACTIVE', expectedVersion: 0 }]) {
    assert.throws(() => validateSchoolTextSenderInput(body), (e) => e.getStatus() === 400);
  }
});

test('Twilio inbound: texts to the HQ Messaging Service go to HQ first, NOT_HQ falls through, only code results get a reply', async () => {
  const { CommunicationWebhookController, hqInboundTwiml } = require('../dist/communication/delivery/communication-webhook.controller.js');
  const { SendGridEventWebhookVerifier } = require('../dist/communication/delivery/sendgrid-email-provider.js');
  const verifier = new TwilioWebhookVerifier(() => approved(), () => 1_800_000_000_000);
  const hqService = `MG${'c'.repeat(32)}`;
  const sid = `SM${'f'.repeat(32)}`;
  const text = (Body, extra = { MessagingServiceSid: hqService }) =>
    signed('/v1/communications/webhooks/twilio/inbound', { AccountSid: account, MessageSid: sid, From: '+15555550101', To: '+15555559001', Body, ...extra });
  const empty = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

  assert.deepEqual(verifier.inboundText(text('HON 123456').body, text('HON 123456').signature),
    { eventId: sid, from: '+15555550101', toService: hqService, body: 'HON 123456', receivedAt: new Date(1_800_000_000_000).toISOString() });
  const noService = text('STOP', {});
  assert.equal(verifier.inboundText(noService.body, noService.signature), null);
  const forged = text('HON 123456');
  assert.equal(reason(() => verifier.inboundText(forged.body, signed('/v1/communications/webhooks/twilio/inbound', { AccountSid: account }, 'other').signature)), 'SIGNATURE_INVALID');

  const make = (outcome, { configured = true, fail = false } = {}) => {
    const hqCalls = [];
    const schoolCalls = [];
    const school = { isConfigured: () => true, recordInboundKeyword: async (k) => { schoolCalls.push(k.keyword); } };
    const hq = { isConfigured: () => configured, recordInbound: async (t) => { hqCalls.push(t); if (fail) throw new Error('db'); return outcome; } };
    return { hqCalls, schoolCalls, controller: new CommunicationWebhookController(school, new SendGridEventWebhookVerifier(() => ({})), verifier, undefined, hq) };
  };
  const confirmed = { outcome: 'CONFIRMED', reply: 'CONFIRMED', replyText: 'HON OS: Your number is confirmed & ready.', replayed: false };

  // A confirmation code: recorded by HQ with the verified fields, answered with the escaped fixed reply, never the school path.
  let run = make(confirmed);
  const code = text('HON 123456');
  assert.equal(await run.controller.twilioInbound({ body: code.body }, code.signature),
    '<?xml version="1.0" encoding="UTF-8"?><Response><Message>HON OS: Your number is confirmed &amp; ready.</Message></Response>');
  assert.deepEqual(run.hqCalls, [{ provider: 'TWILIO', eventId: sid, from: '+15555550101', toService: hqService, body: 'HON 123456', receivedAt: new Date(1_800_000_000_000).toISOString() }]);
  assert.deepEqual(run.schoolCalls, []);

  // HQ STOP is recorded by HQ but answered by the Messaging Service's opt-out handling, not by HON (no double reply).
  run = make({ outcome: 'OPTED_OUT', reply: 'STOPPED', replyText: 'HON OS: stopped', replayed: false });
  const stop = text('STOP');
  assert.equal(await run.controller.twilioInbound({ body: stop.body }, stop.signature), empty);
  assert.deepEqual([run.hqCalls.length, run.schoolCalls], [1, []]);

  // NOT_HQ (a school's Messaging Service) falls through to the school keyword path unchanged.
  run = make({ outcome: 'NOT_HQ', reply: null, replyText: null, replayed: false });
  assert.equal(await run.controller.twilioInbound({ body: stop.body }, stop.signature), empty);
  assert.deepEqual([run.hqCalls.length, run.schoolCalls], [1, ['STOP']]);

  // No Messaging Service SID, or no HQ worker database: the school path only.
  run = make(confirmed);
  assert.equal(await run.controller.twilioInbound({ body: noService.body }, noService.signature), empty);
  assert.deepEqual([run.hqCalls.length, run.schoolCalls], [0, ['STOP']]);
  run = make(confirmed, { configured: false });
  await run.controller.twilioInbound({ body: stop.body }, stop.signature);
  assert.deepEqual([run.hqCalls.length, run.schoolCalls], [0, ['STOP']]);

  // HQ database trouble asks Twilio to retry and never falls through to the school path.
  run = make(confirmed, { fail: true });
  await assert.rejects(run.controller.twilioInbound({ body: code.body }, code.signature), (e) => e.getStatus() === 503);
  assert.deepEqual(run.schoolCalls, []);

  // Replies: only fresh CONFIRMED / CODE_WRONG; replays, keywords, NO_MATCH and unknown kinds stay empty.
  assert.equal(hqInboundTwiml({ ...confirmed, replayed: true }), empty);
  assert.match(hqInboundTwiml({ outcome: 'CODE_WRONG', reply: 'CODE_WRONG', replyText: 'no match', replayed: false }), /<Message>no match<\/Message>/);
  for (const reply of ['STOPPED', 'STARTED', 'HELP', null, 'SOMETHING']) assert.equal(hqInboundTwiml({ outcome: 'X', reply, replyText: 'x', replayed: false }), empty);
  assert.equal(hqInboundTwiml({ outcome: 'NO_MATCH', reply: null, replyText: null, replayed: false }), empty);
});

test('Twilio behind hon-web: an /api path prefix is part of every callback URL and every signature, and odd bases are refused', async () => {
  const { twilioPublicOrigin } = require('../dist/communication/delivery/twilio-text-provider.js');
  const { voiceForwardTwiml } = require('../dist/communication/delivery/missed-call-text-back.js');
  const base = (value) => twilioPublicOrigin({ HON_PUBLIC_API_ORIGIN: value });
  assert.equal(base('https://app.hon.example/api'), 'https://app.hon.example/api');
  assert.equal(base('https://app.hon.example/api/'), 'https://app.hon.example/api');
  assert.equal(base(' https://api.hon.example/ '), 'https://api.hon.example');
  for (const bad of ['http://app.hon.example/api', 'https://app.hon.example/api?x=1', 'https://app.hon.example/api#x', 'https://u:p@app.hon.example/api',
    'https://app.hon.example:8443/api', 'https://app.hon.example/a/../api', 'https://app.hon.example/%61pi', 'https://app.hon.example//api', 'https://APP.hon.example/api',
    'https://app.hon.example/api/v1 x', 'not a url', '']) {
    assert.equal(base(bad), undefined, bad);
  }

  const env = () => approved({ HON_PUBLIC_API_ORIGIN: 'https://app.hon.example/api' });
  let seen;
  const adapter = new TwilioTextProvider(env, async (_url, init) => { seen = new URLSearchParams(init.body); return { status: 201, json: async () => ({ sid: `SM${'d'.repeat(32)}`, num_segments: '1' }) }; });
  assert.equal(adapter.readiness(), 'READY');
  await adapter.send(request());
  assert.equal(seen.get('StatusCallback'), 'https://app.hon.example/api/v1/communications/webhooks/twilio/status');
  await adapter.send(request({ origin: 'HQ' }));
  assert.equal(seen.get('StatusCallback'), 'https://app.hon.example/api/v1/communications/webhooks/twilio/hq-status');
  assert.match(voiceForwardTwiml('+15555550199', twilioPublicOrigin(env())), /action="https:\/\/app\.hon\.example\/api\/v1\/communications\/webhooks\/twilio\/voice-result"/);

  // Twilio signs the public URL it called (with /api); the API receives /v1/... from the rewrite and must check the /api URL.
  const verifier = new TwilioWebhookVerifier(env, () => 1_800_000_000_000);
  const sid = `SM${'d'.repeat(32)}`;
  const signAt = (url, fields) => {
    const params = new URLSearchParams(fields);
    const data = [...new Set(params.keys())].sort().reduce((acc, name) => acc + name + params.get(name), url);
    return { body: Buffer.from(params.toString()), signature: createHmac('sha1', 'tok').update(data).digest('base64') };
  };
  const fields = { AccountSid: account, MessageSid: sid, MessageStatus: 'delivered' };
  const viaWeb = signAt('https://app.hon.example/api/v1/communications/webhooks/twilio/status', fields);
  assert.equal(verifier.status(viaWeb.body, viaWeb.signature).eventType, 'DELIVERED');
  const direct = signAt('https://app.hon.example/v1/communications/webhooks/twilio/status', fields);
  assert.equal(reason(() => verifier.status(direct.body, direct.signature)), 'SIGNATURE_INVALID');
  const inbound = signAt('https://app.hon.example/api/v1/communications/webhooks/twilio/inbound', { AccountSid: account, MessageSid: sid, From: '+15555550101', To: '+15555559001', Body: 'STOP' });
  assert.equal(verifier.inbound(inbound.body, inbound.signature).keyword, 'STOP');
  const voice = signAt('https://app.hon.example/api/v1/communications/webhooks/twilio/voice', { AccountSid: account, CallSid: `CA${'a'.repeat(32)}`, From: '+15555550101', To: '+15555559001' });
  assert.equal(verifier.voice(voice.body, voice.signature).to, '+15555559001');
});
