const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { countTextPieces } = require('@hon/contracts');
const { TwilioTextProvider, TwilioWebhookVerifier, TwilioWebhookError } = require('../dist/communication/delivery/twilio-text-provider.js');
const { FakeCommunicationProvider } = require('../dist/communication/delivery/fake-communication-provider.js');
const { CommunicationProviderError } = require('../dist/communication/delivery/communication-provider.js');
const {
  MissedCallTextBackDispatcher, missedCallTextBackBody, voiceForwardTwiml, validateMissedCallSettingsInput,
} = require('../dist/communication/delivery/missed-call-text-back.js');

const account = `AC${'c'.repeat(32)}`;
const env = (over = {}) => ({ TWILIO_ACCOUNT_SID: account, TWILIO_AUTH_TOKEN: 'tok', HON_PUBLIC_API_ORIGIN: 'https://api.hon.example', HON_SMS_SEND_APPROVED: 'true', ...over });
const callSid = `CA${'a'.repeat(32)}`;

function signed(path, fields, token = 'tok') {
  const params = new URLSearchParams(fields);
  const data = [...new Set(params.keys())].sort().reduce((acc, name) => acc + name + params.get(name), `https://api.hon.example${path}`);
  return { body: Buffer.from(params.toString()), signature: createHmac('sha1', token).update(data).digest('base64') };
}
const reason = (fn) => { try { fn(); return 'OK'; } catch (error) { return error instanceof TwilioWebhookError ? error.reason : error.message; } };

test('text-back wording: short, one piece in English and Spanish, names the school, always carries STOP', () => {
  for (const language of ['en', 'ko', 'es']) {
    const body = missedCallTextBackBody(language, 'Dragon Martial Arts');
    assert.match(body, /^Dragon Martial Arts: /);
    assert.match(body, /STOP/);
    assert.ok(countTextPieces(body).pieces <= 2, `${language}: ${body}`);
  }
  assert.equal(countTextPieces(missedCallTextBackBody('en', 'Dragon Martial Arts')).encoding, 'GSM7');
  assert.equal(countTextPieces(missedCallTextBackBody('es', 'Dragon Martial Arts')).encoding, 'GSM7');
  assert.equal(countTextPieces(missedCallTextBackBody('en', 'Dragon Martial Arts')).pieces, 1);
  assert.equal(missedCallTextBackBody('fr', 'Day'), missedCallTextBackBody('en', 'Day'));
  const long = missedCallTextBackBody('en', 'A'.repeat(200));
  assert.ok(long.startsWith(`${'A'.repeat(40)}: `));
  assert.equal(missedCallTextBackBody('en', '  <b>Day</b>\n Dojo '), missedCallTextBackBody('en', 'bDay/b Dojo'));
});

test('voice webhooks: signed calls only; forward TwiML dials the school phone with the fixed result URL; nothing is forwarded for an unrouted number', () => {
  const verifier = new TwilioWebhookVerifier(() => env(), () => 1_800_000_000_000);
  const incoming = signed('/v1/communications/webhooks/twilio/voice', { AccountSid: account, CallSid: callSid, From: '+15555550101', To: '+15555559001', CallStatus: 'ringing' });
  assert.deepEqual(verifier.voice(incoming.body, incoming.signature), { callSid, from: '+15555550101', to: '+15555559001' });
  assert.equal(reason(() => verifier.voice(incoming.body, 'bad')), 'SIGNATURE_INVALID');
  const statusPath = signed('/v1/communications/webhooks/twilio/status', { AccountSid: account, CallSid: callSid, From: '+15555550101', To: '+15555559001' });
  assert.equal(reason(() => verifier.voice(statusPath.body, statusPath.signature)), 'SIGNATURE_INVALID');
  const anonymous = signed('/v1/communications/webhooks/twilio/voice', { AccountSid: account, CallSid: callSid, From: 'anonymous', To: '+15555559001' });
  assert.deepEqual(verifier.voice(anonymous.body, anonymous.signature), { callSid, from: null, to: '+15555559001' });

  const twiml = voiceForwardTwiml('+15555550199', 'https://api.hon.example');
  assert.equal(twiml, '<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="20" action="https://api.hon.example/v1/communications/webhooks/twilio/voice-result" method="POST"><Number>+15555550199</Number></Dial></Response>');
  assert.equal(voiceForwardTwiml(null, 'https://api.hon.example'), '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  assert.throws(() => voiceForwardTwiml('+1555<x>', 'https://api.hon.example'));

  const result = (status) => {
    const s = signed('/v1/communications/webhooks/twilio/voice-result', { AccountSid: account, CallSid: callSid, From: '+15555550101', To: '+15555559001', DialCallStatus: status });
    return verifier.voiceResult(s.body, s.signature);
  };
  assert.deepEqual(result('no-answer'), { callSid, from: '+15555550101', to: '+15555559001', dialStatus: 'no-answer', receivedAt: new Date(1_800_000_000_000).toISOString() });
  assert.equal(result('busy').dialStatus, 'busy');
  assert.equal(result('failed').dialStatus, 'failed');
  assert.equal(result('canceled').dialStatus, 'canceled');
  assert.equal(result('completed'), null);
  assert.equal(result('answered'), null);
  const other = signed('/v1/communications/webhooks/twilio/voice-result', { AccountSid: `AC${'e'.repeat(32)}`, CallSid: callSid, From: '+15555550101', To: '+15555559001', DialCallStatus: 'busy' });
  assert.equal(reason(() => verifier.voiceResult(other.body, other.signature)), 'SIGNATURE_INVALID');
  const badSid = signed('/v1/communications/webhooks/twilio/voice-result', { AccountSid: account, CallSid: 'CA1', From: '+15555550101', To: '+15555559001', DialCallStatus: 'busy' });
  assert.equal(reason(() => verifier.voiceResult(badSid.body, badSid.signature)), 'MALFORMED');
});

function store(claims, results = []) {
  return {
    results,
    isConfigured: () => true,
    claimMissedCallTextBacks: async (limit, lease) => { assert.ok(limit <= 2); assert.equal(lease, 60); return claims.splice(0, limit); },
    recordMissedCallTextBackResult: async (id, token, outcome, providerMessageId) => {
      results.push({ id, token, outcome, providerMessageId });
      return { textBackStatus: outcome === 'ACCEPTED' ? 'ACCEPTED' : outcome === 'RETRYABLE' ? 'PENDING' : outcome, accepted: true };
    },
  };
}
const claim = (over = {}) => ({ missedCallId: '11111111-1111-4111-8111-111111111111', leaseToken: '22222222-2222-4222-8222-222222222222',
  organizationId: '33333333-3333-4333-8333-333333333333', schoolId: '44444444-4444-4444-8444-444444444444', callerE164: '+15555550101',
  schoolName: 'Day Dojo', language: 'ko', senderServiceId: `MG${'a'.repeat(32)}`, attempt: 1, ...over });

test('text-back dispatcher: sends through the READY SMS adapter with no status callback, records each outcome, does nothing when no adapter is READY', async () => {
  let seen;
  const twilio = new TwilioTextProvider(() => env(), async (url, init) => { seen = new URLSearchParams(init.body); return { status: 201, json: async () => ({ sid: `SM${'d'.repeat(32)}` }) }; });
  const s = store([claim()]);
  const summary = await new MissedCallTextBackDispatcher(s, [twilio]).runOnce();
  assert.deepEqual(summary, { claimed: 1, accepted: 1, retrying: 0, failed: 0, unknown: 0, lateResults: 0 });
  assert.equal(seen.get('To'), '+15555550101');
  assert.equal(seen.get('MessagingServiceSid'), `MG${'a'.repeat(32)}`);
  assert.equal(seen.get('Body'), missedCallTextBackBody('ko', 'Day Dojo'));
  assert.equal(seen.get('StatusCallback'), null);
  assert.deepEqual(s.results, [{ id: claim().missedCallId, token: claim().leaseToken, outcome: 'ACCEPTED', providerMessageId: `SM${'d'.repeat(32)}` }]);

  let claimed = 0;
  const idle = { isConfigured: () => true, claimMissedCallTextBacks: async () => { claimed += 1; return []; } };
  const notReady = new TwilioTextProvider(() => env({ HON_SMS_SEND_APPROVED: 'no' }));
  assert.equal((await new MissedCallTextBackDispatcher(idle, [notReady]).runOnce()).claimed, 0);
  assert.equal((await new MissedCallTextBackDispatcher(idle, [new FakeCommunicationProvider('EMAIL', () => ({ HON_COMMUNICATION_FAKE_PROVIDER: '1' }))]).runOnce()).claimed, 0);
  assert.equal(claimed, 0);

  const fake = new FakeCommunicationProvider('SMS', () => ({ HON_COMMUNICATION_FAKE_PROVIDER: '1' }));
  const f = store([claim({ attempt: 2 })]);
  await new MissedCallTextBackDispatcher(f, [fake]).runOnce();
  assert.deepEqual(f.results.map((r) => [r.outcome, r.providerMessageId]), [['ACCEPTED', `fake-${claim().missedCallId}-2`]]);

  const e = store([claim(), claim(), claim(), claim()]);
  let i = 0;
  const errors = [new CommunicationProviderError('RETRYABLE', 'PROVIDER_FAILED'), new CommunicationProviderError('FAILED', 'INVALID_ADDRESS'), new CommunicationProviderError('UNKNOWN'), new Error('boom')];
  const rotating = { provider: 'TWILIO', channel: 'SMS', readiness: () => 'READY', send: async () => { throw errors[i++]; } };
  const out = await new MissedCallTextBackDispatcher(e, [rotating]).runOnce();
  assert.deepEqual(e.results.map((r) => r.outcome), ['RETRYABLE', 'FAILED', 'UNKNOWN', 'UNKNOWN']);
  assert.deepEqual(out, { claimed: 4, accepted: 0, retrying: 1, failed: 1, unknown: 2, lateResults: 0 });
});

test('HQ missed-call settings input is strict', () => {
  assert.deepEqual(validateMissedCallSettingsInput({ forwardPhoneE164: '+15555550199', textBack: true, expectedVersion: 1 }), { forwardPhoneE164: '+15555550199', textBack: true, expectedVersion: 1 });
  assert.deepEqual(validateMissedCallSettingsInput({ forwardPhoneE164: null, textBack: false, expectedVersion: 3 }), { forwardPhoneE164: null, textBack: false, expectedVersion: 3 });
  for (const body of [null, [], { forwardPhoneE164: '5555550199', textBack: true, expectedVersion: 1 }, { forwardPhoneE164: '+15555550199', textBack: 'yes', expectedVersion: 1 },
    { forwardPhoneE164: '+15555550199', textBack: true }, { forwardPhoneE164: '+15555550199', textBack: true, expectedVersion: 0 },
    { forwardPhoneE164: '+15555550199', textBack: true, expectedVersion: 1, extra: 1 }]) {
    assert.throws(() => validateMissedCallSettingsInput(body), (e) => e.getStatus() === 400);
  }
});
