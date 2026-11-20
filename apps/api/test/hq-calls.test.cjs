const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, randomBytes } = require('node:crypto');
const voice = require('../dist/calls/twilio-voice.js');
const rest = require('../dist/calls/twilio-voice-rest.js');
const { HqCallWebhooksController } = require('../dist/calls/hq-call-webhooks.controller.js');
const { HqCallsService } = require('../dist/calls/hq-calls.service.js');
const { HqCallsController, hqCallListQuery } = require('../dist/calls/hq-calls.controller.js');
const { SchoolVoiceAppWorker, SchoolCallRecordingRetentionWorker, HQ_VOICE_APP_NAME } = require('../dist/calls/school-voice-workers.js');
const { COMMUNICATION_WEBHOOK_PATHS } = require('../dist/communication/delivery/communication-webhook.controller.js');
const { TwilioWebhookVerifier } = require('../dist/communication/delivery/twilio-text-provider.js');

// CL5 (0591): HQ calling on the HQ texting number, all on HON's parent account, behind the owner's voice switch.
const parent = `AC${'c'.repeat(32)}`, sub = `AC${'d'.repeat(32)}`;
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const claim = '44444444-4444-4444-8444-444444444444';
const hq = 'h' + 'a'.repeat(32), hq2 = 'h' + 'b'.repeat(32);
const callSid = `CA${'1'.repeat(32)}`, childSid = `CA${'2'.repeat(32)}`, recSid = `RE${'3'.repeat(32)}`;
const base = 'https://api.hon.example';
const HQ_NUMBER = '+15125550100';
const env = (over = {}) => ({ TWILIO_ACCOUNT_SID: parent, TWILIO_AUTH_TOKEN: 'tok', HON_PUBLIC_API_ORIGIN: base, HON_VOICE_CALLS_APPROVED: 'true', HON_DEPLOYMENT_ENVIRONMENT: 'test', ...over });
const NOW = 1_800_000_000_000;
function signed(path, fields, token = 'tok') {
  const params = new URLSearchParams(fields);
  const data = [...new Set(params.keys())].sort().reduce((acc, name) => acc + name + params.getAll(name).join(''), `${base}${path}`);
  return { body: Buffer.from(params.toString()), signature: createHmac('sha1', token).update(data).digest('base64') };
}
const req = (s) => ({ body: s.body });
function webhooks({ environment = env(), store: over = {} } = {}) {
  const seen = [];
  const store = {
    isConfigured: () => true,
    connectHqClientCall: async (...a) => { seen.push(['connect', ...a]); return { outcome: 'CONNECT', toE164: '+15125551001', callerIdE164: HQ_NUMBER }; },
    routeHqIncomingCall: async (...a) => { seen.push(['route', ...a]); return { outcome: 'RING', callId: A, identities: [hq, hq2], voicemailGreeting: null }; },
    recordHqCallStatus: async (...a) => { seen.push(['status', ...a]); return { outcome: 'RECORDED', status: a[1] }; },
    recordHqCallVoicemail: async (...a) => { seen.push(['voicemail', ...a]); return { outcome: 'RECORDED', callId: A }; },
    ...over,
  };
  const verifier = new TwilioWebhookVerifier(() => environment, () => NOW);
  return { seen, controller: new HqCallWebhooksController(store, verifier, () => environment, () => NOW) };
}

test('CL5 HQ webhooks: every HQ path goes through the raw signed transport', () => {
  assert.equal(voice.HQ_CALL_WEBHOOK_PATHS.length, 7);
  for (const path of voice.HQ_CALL_WEBHOOK_PATHS) {
    assert.match(path, /^\/v1\/communications\/webhooks\/twilio\/hq\//);
    assert.equal(COMMUNICATION_WEBHOOK_PATHS.has(path), true, `${path} is form-signed`);
  }
});

test('CL5 HQ client-voice: parent account only, dials the stored number from the HQ number, never recorded', async () => {
  const { seen, controller } = webhooks();
  const path = voice.HQ_CALL_PATHS.clientVoice;
  const fields = { AccountSid: parent, CallSid: callSid, From: `client:${hq}`, HonCallId: A.toUpperCase() };
  const s = signed(path, fields);
  const out = await controller.clientVoice(req(s), s.signature);
  assert.deepEqual(seen[0], ['connect', A, hq, callSid]);
  assert.match(out, /<Dial callerId="\+15125550100"/);
  assert.match(out, />\+15125551001<\/Number><\/Dial>/);
  assert.match(out, /action="https:\/\/api\.hon\.example\/v1\/communications\/webhooks\/twilio\/hq\/client-dial-result"/);
  assert.match(out, /statusCallback="https:\/\/api\.hon\.example\/v1\/communications\/webhooks\/twilio\/hq\/call-answered"/);
  assert.doesNotMatch(out, /record=|recording-notice/, 'HQ calls are never recorded');
  // A school subaccount, a bad signature, a school identity or a missing call id are refused before the database.
  const subS = signed(path, { ...fields, AccountSid: sub });
  await assert.rejects(() => controller.clientVoice(req(subS), subS.signature), (e) => e.response?.code === 'INVALID_WEBHOOK');
  await assert.rejects(() => controller.clientVoice(req(s), 'bad'));
  for (const bad of [{ From: `client:u${'a'.repeat(32)}` }, { HonCallId: 'x' }, { CallSid: 'CA1' }]) {
    const b = signed(path, { ...fields, ...bad });
    await assert.rejects(() => controller.clientVoice(req(b), b.signature), (e) => e.response?.code === 'INVALID_WEBHOOK');
  }
  assert.equal(seen.length, 1);
  // Not approved: refused TwiML, nothing asked of the database. A refused decision dials nothing.
  const off = webhooks({ environment: env({ HON_VOICE_CALLS_APPROVED: 'yes' }) });
  const o = signed(path, fields);
  assert.doesNotMatch(await off.controller.clientVoice(req(o), o.signature), /<Dial/);
  assert.equal(off.seen.length, 0);
  const refused = webhooks({ store: { connectHqClientCall: async () => ({ outcome: 'REFUSED', toE164: null, callerIdE164: null }) } });
  assert.doesNotMatch(await refused.controller.clientVoice(req(s), s.signature), /<Dial/);
});

test('CL5 HQ incoming: rings the Ring me HQ browsers, then voicemail on the HQ paths; rejected when off or not approved', async () => {
  const { seen, controller } = webhooks();
  const path = voice.HQ_CALL_PATHS.voice;
  const fields = { AccountSid: parent, CallSid: callSid, To: HQ_NUMBER, From: '+15125557777' };
  const s = signed(path, fields);
  const ring = await controller.voice(req(s), s.signature);
  assert.deepEqual(seen[0], ['route', HQ_NUMBER, '+15125557777', callSid]);
  assert.equal((ring.match(/<Client /g) ?? []).length, 2);
  assert.match(ring, /action="https:\/\/api\.hon\.example\/v1\/communications\/webhooks\/twilio\/hq\/incoming-dial-result"/);
  assert.doesNotMatch(ring, /record=/);
  const withheld = signed(path, { ...fields, From: 'anonymous' });
  await controller.voice(req(withheld), withheld.signature);
  assert.deepEqual(seen[1], ['route', HQ_NUMBER, null, callSid], 'a withheld caller is stored as unknown');
  for (const outcome of ['OFF', 'UNROUTED']) {
    const w = webhooks({ store: { routeHqIncomingCall: async () => ({ outcome, callId: null, identities: [], voicemailGreeting: null }) } });
    assert.equal(await w.controller.voice(req(s), s.signature), voice.REJECT_CALL_TWIML);
  }
  const off = webhooks({ environment: env({ HON_VOICE_CALLS_APPROVED: undefined }) });
  assert.equal(await off.controller.voice(req(s), s.signature), voice.REJECT_CALL_TWIML);
  assert.equal(off.seen.length, 0);
  // Nobody to ring: straight to the HQ voicemail paths with HON HQ's default greeting.
  const empty = webhooks({ store: { routeHqIncomingCall: async () => ({ outcome: 'RING', callId: A, identities: [], voicemailGreeting: null }) } });
  const vm = await empty.controller.voice(req(s), s.signature);
  assert.match(vm, /Thanks for calling HON HQ\./);
  assert.match(vm, /action="https:\/\/api\.hon\.example\/v1\/communications\/webhooks\/twilio\/hq\/voicemail-done"/);
  assert.match(vm, /recordingStatusCallback="https:\/\/api\.hon\.example\/v1\/communications\/webhooks\/twilio\/hq\/voicemail-status"/);
});

test('CL5 HQ dial results, answered leg and voicemail are recorded by Call SID only', async () => {
  const { seen, controller } = webhooks({ store: { routeHqIncomingCall: async (...a) => ({ outcome: 'REPLAYED', callId: A, identities: [hq], voicemailGreeting: 'Leave a message' }) } });
  const r = voice.HQ_CALL_PATHS.incomingDialResult;
  const answered = signed(r, { AccountSid: parent, CallSid: callSid, To: HQ_NUMBER, From: '+15125557777', DialCallStatus: 'completed', DialCallDuration: '65' });
  assert.equal(await controller.incomingDialResult(req(answered), answered.signature), voice.HANGUP_TWIML);
  assert.deepEqual(seen.at(-1).slice(0, 5), ['status', callSid, 'COMPLETED', null, 65]);
  const missed = signed(r, { AccountSid: parent, CallSid: callSid, To: HQ_NUMBER, From: '+15125557777', DialCallStatus: 'no-answer' });
  const vm = await controller.incomingDialResult(req(missed), missed.signature);
  assert.deepEqual(seen.find(x => x[2] === 'MISSED').slice(0, 5), ['status', callSid, 'MISSED', null, null]);
  assert.match(vm, /<Say language="en-US">Leave a message<\/Say><Record maxLength="120"/);
  const a = voice.HQ_CALL_PATHS.callAnswered;
  const leg = signed(a, { AccountSid: parent, CallSid: childSid, ParentCallSid: callSid, CallStatus: 'in-progress', To: `client:${hq2}` });
  await controller.callAnswered(req(leg), leg.signature);
  assert.deepEqual(seen.at(-1).slice(0, 4), ['status', callSid, 'IN_PROGRESS', hq2]);
  const v = voice.HQ_CALL_PATHS.voicemailStatus;
  const rec = signed(v, { AccountSid: parent, CallSid: callSid, RecordingSid: recSid, RecordingStatus: 'completed', RecordingDuration: '12' });
  await controller.voicemailStatus(req(rec), rec.signature);
  assert.deepEqual(seen.at(-1), ['voicemail', callSid, recSid, 12]);
  const bad = signed(v, { AccountSid: parent, CallSid: callSid, RecordingSid: recSid, RecordingStatus: 'completed' });
  await assert.rejects(() => controller.voicemailStatus(req(bad), bad.signature), (e) => e.response?.code === 'INVALID_WEBHOOK');
  // A database failure asks Twilio to retry (503), never a guessed success.
  const down = webhooks({ store: { recordHqCallVoicemail: async () => { throw new Error('db'); } } });
  await assert.rejects(() => down.controller.voicemailStatus(req(rec), rec.signature), (e) => e.response?.code === 'COMMUNICATION_WEBHOOK_RETRY');
});

function database(answers) {
  const calls = [];
  return { calls, db: { callHqCalls: async (op, params) => {
    calls.push([op, ...params]);
    const a = answers[op];
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a(params) : a;
  } } };
}
const pgError = (message, code) => Object.assign(new Error(message), { code });
const callRow = (over = {}) => ({ callId: A, direction: 'OUT', status: 'INITIATED', remoteE164: '+15125551001', contactUserId: null, contactName: null, contactSchools: [],
  staffName: 'Dana', startedAt: '2027-01-15T08:00:00.000Z', answeredAt: null, endedAt: null, durationSeconds: null, voicemail: false, recordingAvailable: false,
  recordingSeconds: null, heard: false, outcome: null, note: null, doNotCall: false, version: 1, ...over });

test('CL5 HQ calls service: fixed operations with the subject, verified answers, plain refusals', async () => {
  const { calls, db } = database({
    start: (p) => ({ ...callRow(), connectBy: '2027-01-15T08:02:00.000Z', replayed: false }),
    settings: { callingOn: true, voicemailGreeting: null, version: 1 },
    ringing: { ringMe: true, version: 1 },
    list: { calls: [callRow({ direction: 'IN', status: 'VOICEMAIL', remoteE164: null, voicemail: true, recordingAvailable: true, recordingSeconds: 12 })], nextCursor: null },
  });
  const service = new HqCallsService(db, undefined, null, () => env(), () => NOW, undefined);
  const key = '55555555-5555-4555-8555-555555555555';
  const started = await service.start('sub-1', { toE164: '+15125551001' }, key);
  assert.equal(started.call.callId, A);
  assert.deepEqual(calls[0], ['start', 'sub-1', JSON.stringify({ toE164: '+15125551001' }), key]);
  await assert.rejects(() => service.start('sub-1', { toE164: '+19005551234' }, key), (e) => e.response?.code === 'CALL_NUMBER_NOT_ALLOWED');
  await assert.rejects(() => service.start('sub-1', { toE164: '+15125551001' }, 'not-a-uuid'), (e) => e.response?.code === 'VALIDATION_FAILED');
  await assert.rejects(() => service.start('sub-1', { toE164: '+15125551001', schoolId: B }, key), (e) => e.response?.code === 'VALIDATION_FAILED');
  assert.equal(calls.length, 1, 'refused input never reaches the database');
  assert.deepEqual(await service.setSettings('sub-1', { callingOn: true, voicemailGreeting: null, expectedVersion: 0 }), { callingOn: true, voicemailGreeting: null, version: 1 });
  await assert.rejects(() => service.setSettings('sub-1', { callingOn: false, voicemailGreeting: null, expectedVersion: 0 }), (e) => e.response?.code === 'CALLING_UNAVAILABLE',
    'an answer that does not match what was asked is not shown as saved');
  assert.equal((await service.setRinging('sub-1', { ringMe: true })).ringMe, true);
  const list = await service.list('sub-1', { filter: 'VOICEMAIL' });
  assert.equal(list.calls[0].remoteE164, null, 'a withheld caller is listed');
  await assert.rejects(() => service.list('sub-1', { filter: 'OUTGOING' }), (e) => e.response?.code === 'CALLING_UNAVAILABLE');
  for (const [error, code, status] of [[pgError('SAAS_FORBIDDEN', '42501'), 'CALLING_FORBIDDEN', 403], [pgError('CALLING_OFF', '55000'), 'CALLING_OFF', 422],
    [pgError('CALL_RATE_LIMITED', '54000'), 'CALL_RATE_LIMITED', 429], [pgError('CALL_DO_NOT_CALL', '22023'), 'CALL_DO_NOT_CALL', 422], [new Error('boom'), 'CALLING_UNAVAILABLE', 503]]) {
    const svc = new HqCallsService(database({ overview: error }).db, undefined, null, () => env(), () => NOW, undefined);
    await assert.rejects(() => svc.overview('sub-1'), (e) => e.response?.code === code && e.getStatus() === status);
  }
  await assert.rejects(() => service.overview(''), (e) => e.response?.code === 'CALLING_FORBIDDEN');
});

test('CL5 HQ phone token: parent-account key bound to the HQ binding, only when ready and approved', async () => {
  const vault = new voice.TwilioVoiceKeyVault(randomBytes(32), 'k1');
  const apiKeySid = `SK${'e'.repeat(32)}`, twimlAppSid = `AP${'f'.repeat(32)}`;
  const sealed = vault.seal({ schoolId: voice.HQ_VOICE_BINDING_ID, accountSid: parent, apiKeySid }, 'Secret0123456789abcdef');
  const worker = { isConfigured: () => true, readHqVoiceApp: async () => ({ twimlAppSid, apiKeySid, sealedApiSecret: sealed, vaultKeyId: 'k1' }) };
  const decision = (over = {}) => ({ identity: hq, ready: true, callingOn: true, incoming: true, ...over });
  const token = await new HqCallsService(database({ phoneToken: decision() }).db, worker, vault, () => env(), () => NOW).phoneToken('sub-1');
  assert.deepEqual([token.ready, token.reason, token.identity, token.incoming], [true, 'READY', hq, true]);
  const payload = JSON.parse(Buffer.from(token.token.split('.')[1], 'base64url'));
  assert.deepEqual([payload.iss, payload.sub, payload.grants.identity, payload.grants.voice.outgoing.application_sid], [apiKeySid, parent, hq, twimlAppSid]);
  for (const [d, e, reason] of [[decision({ callingOn: false, ready: false, incoming: false }), env(), 'CALLING_OFF'], [decision({ ready: false, incoming: false }), env(), 'PHONE_NOT_SET_UP'],
    [decision(), env({ HON_VOICE_CALLS_APPROVED: 'false' }), 'VOICE_NOT_APPROVED']]) {
    const t = await new HqCallsService(database({ phoneToken: d }).db, worker, vault, () => e, () => NOW).phoneToken('sub-1');
    assert.deepEqual([t.ready, t.reason, t.token], [false, reason, null]);
  }
  // A school identity, or a key sealed for a school, never becomes an HQ token.
  await assert.rejects(() => new HqCallsService(database({ phoneToken: decision({ identity: 'u' + 'a'.repeat(32) }) }).db, worker, vault, () => env(), () => NOW).phoneToken('sub-1'),
    (e) => e.response?.code === 'CALLING_UNAVAILABLE');
  const schoolSealed = vault.seal({ schoolId: A, accountSid: parent, apiKeySid }, 'Secret0123456789abcdef');
  const moved = { ...worker, readHqVoiceApp: async () => ({ twimlAppSid, apiKeySid, sealedApiSecret: schoolSealed, vaultKeyId: 'k1' }) };
  await assert.rejects(() => new HqCallsService(database({ phoneToken: decision() }).db, moved, vault, () => env(), () => NOW).phoneToken('sub-1'),
    (e) => e.response?.code === 'CALLING_UNAVAILABLE');
});

test('CL5 HQ voicemail playback: database-authorized open, fetched from the parent account, gone is not found', async () => {
  const fake = new rest.FakeSchoolVoiceTwilioClient(env());
  fake.recordings.set(recSid, Buffer.from([9, 9]));
  const { calls, db } = database({ recording: { recordingSid: recSid, accountSid: null, seconds: 12 } });
  const service = new HqCallsService(db, undefined, null, () => env(), () => NOW, fake);
  assert.deepEqual([...(await service.recording('sub-1', A)).audio], [9, 9]);
  assert.deepEqual(calls[0], ['recording', 'sub-1', A]);
  const wrong = new HqCallsService(database({ recording: { recordingSid: recSid, accountSid: sub, seconds: 12 } }).db, undefined, null, () => env(), () => NOW, fake);
  await assert.rejects(() => wrong.recording('sub-1', A), (e) => e.response?.code === 'CALLING_UNAVAILABLE', 'an HQ voicemail is never on a school account');
  fake.deleted.push(recSid);
  await assert.rejects(() => service.recording('sub-1', A), (e) => e.response?.code === 'CALL_RECORDING_NOT_FOUND');
  const off = new HqCallsService(db, undefined, null, () => env({ HON_VOICE_CALLS_APPROVED: 'no' }), () => NOW, fake);
  await assert.rejects(() => off.recording('sub-1', A), (e) => e.response?.code === 'CALLING_UNAVAILABLE');
});

test('CL5 HQ controller: list filters as plain strings, a uuid start key, no stray keys', async () => {
  assert.deepEqual(hqCallListQuery({ filter: 'MISSED', contactUserId: A, beforeAt: '2027-01-15T08:00:00.000Z', beforeId: B }),
    { filter: 'MISSED', contactUserId: A, before: { at: '2027-01-15T08:00:00.000Z', id: B } });
  assert.throws(() => hqCallListQuery({ beforeAt: 'x' }));
  assert.throws(() => hqCallListQuery({ filter: ['ALL', 'MISSED'] }));
  assert.throws(() => hqCallListQuery({ schoolId: A }));
  const seen = [];
  const controller = new HqCallsController({ start: async (...a) => { seen.push(a); return {}; }, overview: async () => ({}) });
  const request = { honIdentity: { externalSubject: 'sub-1' } };
  await assert.rejects(() => controller.start(request, { toE164: '+15125551001' }, undefined), (e) => e.response?.code === 'IDEMPOTENCY_KEY_REQUIRED');
  await controller.start(request, { toE164: '+15125551001' }, A.toUpperCase());
  assert.deepEqual(seen[0], ['sub-1', { toE164: '+15125551001' }, A]);
  await assert.rejects(() => controller.overview(request, 'k'), (e) => e.response?.code === 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
  await assert.rejects(() => controller.overview({}, undefined), (e) => e.response?.code === 'CALLING_FORBIDDEN');
});

function hqAppStore(state = {}, needs = true) {
  const seen = [];
  return { seen, store: {
    isConfigured: () => true,
    readSchoolsNeedingVoiceApp: async () => [],
    beginSchoolVoiceApp: async () => { throw new Error('no school'); },
    recordSchoolVoiceAppTwiml: async () => true,
    completeSchoolVoiceApp: async () => true,
    hqNeedsVoiceApp: async () => needs,
    beginHqVoiceApp: async (lease) => { seen.push(['begin', lease]); return { state: 'CLAIMED', accountSid: null, twimlAppSid: null, claimToken: claim, ...state }; },
    recordHqVoiceAppTwiml: async (...a) => { seen.push(['twiml', ...a]); return true; },
    completeHqVoiceApp: async (...a) => { seen.push(['complete', ...a]); return true; },
  } };
}

test('CL5 HQ voice app worker: the HQ TwiML App and key on the parent account, sealed to the HQ binding', async () => {
  const vault = new voice.TwilioVoiceKeyVault(randomBytes(32), 'k1');
  const fake = new rest.FakeSchoolVoiceTwilioClient(env());
  const { seen, store } = hqAppStore();
  assert.deepEqual(await new SchoolVoiceAppWorker(store, fake, vault, () => env()).runOnce(), { skipped: false, outcomes: { hq: 'CREATED' } });
  const [appSid, app] = [...fake.apps.entries()][0];
  assert.deepEqual(app, { accountSid: parent, voiceUrl: `${base}/v1/communications/webhooks/twilio/hq/client-voice` });
  assert.equal(HQ_VOICE_APP_NAME, 'hon-voice-hq');
  assert.deepEqual(seen.find(s => s[0] === 'twiml'), ['twiml', claim, appSid]);
  const done = seen.find(s => s[0] === 'complete');
  assert.match(vault.open({ schoolId: voice.HQ_VOICE_BINDING_ID, accountSid: parent, apiKeySid: done[2] }, 'k1', done[3]), /^[0-9a-f]{32}$/);
  assert.throws(() => vault.open({ schoolId: A, accountSid: parent, apiKeySid: done[2] }, 'k1', done[3]), undefined, 'the HQ key never opens for a school');
  assert.deepEqual((await new SchoolVoiceAppWorker(hqAppStore({}, false).store, fake, vault, () => env()).runOnce()).outcomes, {}, 'nothing to do when HQ needs no app');
  for (const s of ['ACTIVE', 'BUSY', 'INELIGIBLE']) assert.deepEqual((await new SchoolVoiceAppWorker(hqAppStore({ state: s }).store, fake, vault, () => env()).runOnce()).outcomes, { hq: s });
  assert.deepEqual(await new SchoolVoiceAppWorker(hqAppStore().store, fake, vault, () => env({ HON_VOICE_CALLS_APPROVED: 'false' })).runOnce(), { skipped: true, outcomes: {} });
});

test('CL5 HQ voicemail retention: deleted at Twilio on the parent account first, then marked', async () => {
  const fake = new rest.FakeSchoolVoiceTwilioClient(env());
  const marked = [];
  const store = {
    isConfigured: () => true,
    readSchoolCallRecordingsDue: async () => [],
    markSchoolCallRecordingDeleted: async () => true,
    readHqCallRecordingsDue: async () => [{ callId: A, recordingSid: recSid }],
    markHqCallRecordingDeleted: async (...a) => { marked.push(a); return true; },
  };
  assert.deepEqual(await new SchoolCallRecordingRetentionWorker(store, fake).runOnce(), { skipped: false, deleted: 1, failed: 0 });
  assert.deepEqual([fake.deleted, marked], [[recSid], [[A, recSid]]]);
  const failing = { ...fake, readiness: () => 'READY', deleteRecording: async () => { throw new rest.TwilioVoiceError('RETRYABLE'); } };
  marked.length = 0;
  assert.deepEqual(await new SchoolCallRecordingRetentionWorker(store, failing).runOnce(), { skipped: false, deleted: 0, failed: 1 });
  assert.equal(marked.length, 0, 'a failed delete is never marked');
});
