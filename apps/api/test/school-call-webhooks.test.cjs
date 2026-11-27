const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, randomBytes } = require('node:crypto');
const voice = require('../dist/calls/twilio-voice.js');
const { SchoolCallWebhooksController } = require('../dist/calls/school-call-webhooks.controller.js');
const { SchoolCallsService } = require('../dist/calls/school-calls.service.js');
const { CommunicationWebhookController, COMMUNICATION_WEBHOOK_PATHS } = require('../dist/communication/delivery/communication-webhook.controller.js');
const { TwilioWebhookVerifier } = require('../dist/communication/delivery/twilio-text-provider.js');
const { SendGridEventWebhookVerifier } = require('../dist/communication/delivery/sendgrid-email-provider.js');

const parent = `AC${'c'.repeat(32)}`, sub = `AC${'d'.repeat(32)}`;
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const ident = 'u' + 'a'.repeat(32), ident2 = 'u' + 'b'.repeat(32);
const callSid = `CA${'1'.repeat(32)}`, childSid = `CA${'2'.repeat(32)}`, recSid = `RE${'3'.repeat(32)}`;
const base = 'https://api.hon.example';
const env = (over = {}) => ({ TWILIO_ACCOUNT_SID: parent, TWILIO_AUTH_TOKEN: 'tok', HON_PUBLIC_API_ORIGIN: base, HON_VOICE_CALLS_APPROVED: 'true', ...over });
function signed(path, fields, token = 'tok') {
  const params = new URLSearchParams(fields);
  const data = [...new Set(params.keys())].sort().reduce((acc, name) => acc + name + params.getAll(name).join(''), `${base}${path}`);
  return { body: Buffer.from(params.toString()), signature: createHmac('sha1', token).update(data).digest('base64') };
}
function harness({ environment = env(), store: over = {}, subaccounts } = {}) {
  const seen = [];
  const store = {
    isConfigured: () => true,
    connectSchoolClientCall: async (...a) => { seen.push(['connect', ...a]); return { outcome: 'CONNECT', toE164: '+15125551001', callerIdE164: '+15125550000', recorded: false, language: 'en', schoolName: 'Tiger Dojo' }; },
    routeSchoolIncomingCall: async (...a) => { seen.push(['route', ...a]); return { outcome: 'REPLAYED', callId: A, identities: [ident], forwardPhoneE164: null, recorded: false, voicemailGreeting: null, language: 'en', schoolName: 'Tiger Dojo' }; },
    recordSchoolCallStatus: async (...a) => { seen.push(['status', ...a]); return { outcome: 'RECORDED', status: a[2] }; },
    recordSchoolCallRecording: async (...a) => { seen.push(['recording', ...a]); return { outcome: 'RECORDED', callId: A }; },
    recordMissedCall: async (m) => { seen.push(['missed', m.dialStatus]); return { outcome: 'RECORDED', textBackStatus: 'PENDING' }; },
    readMissedCallRoute: async () => { seen.push(['legacy']); return { routed: true, forwardPhoneE164: '+15125559999' }; },
    ...over,
  };
  const verifier = new TwilioWebhookVerifier(() => environment, () => 1_800_000_000_000);
  return { seen, store, verifier, controller: new SchoolCallWebhooksController(store, verifier, subaccounts, () => environment, () => 1_800_000_000_000) };
}
const req = (s) => ({ body: s.body });

test('CL3b phone token: HS256 Twilio Voice JWT for one identity, outgoing through the school TwiML App only, incoming only with Ring me', () => {
  const secret = 'S'.repeat(32);
  const input = { accountSid: sub, apiKeySid: `SK${'e'.repeat(32)}`, apiKeySecret: secret, twimlAppSid: `AP${'f'.repeat(32)}`, identity: ident, incoming: true, nowSeconds: 1_800_000_000 };
  const { token, expiresAt } = voice.mintPhoneToken(input);
  const [h, p, sig] = token.split('.');
  assert.equal(createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url'), sig);
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' });
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  assert.deepEqual([payload.iss, payload.sub, payload.exp - payload.iat], [input.apiKeySid, sub, 3600]);
  assert.deepEqual(payload.grants, { identity: ident, voice: { incoming: { allow: true }, outgoing: { application_sid: input.twimlAppSid } } });
  assert.equal(expiresAt, new Date((1_800_000_000 + 3600) * 1000).toISOString());
  assert.equal(JSON.parse(Buffer.from(voice.mintPhoneToken({ ...input, incoming: false }).token.split('.')[1], 'base64url')).grants.voice.incoming, undefined);
  for (const bad of [{ identity: 'client:x' }, { twimlAppSid: 'AP1' }, { apiKeySecret: 'short' }, { accountSid: 'AC' }]) assert.throws(() => voice.mintPhoneToken({ ...input, ...bad }));
  assert.equal(JSON.stringify(payload).includes('+1'), false, 'no number or school in the token');
});

test('CL3b voice key vault: sealed per school, account and key; a moved or relabelled secret never opens', () => {
  const vault = new voice.TwilioVoiceKeyVault(randomBytes(32), 'k1');
  const binding = { schoolId: A, accountSid: sub, apiKeySid: `SK${'e'.repeat(32)}` };
  const sealed = vault.seal(binding, 'Secret0123456789abcdef');
  assert.equal(vault.open(binding, 'k1', sealed), 'Secret0123456789abcdef');
  assert.throws(() => vault.open({ ...binding, schoolId: B }, 'k1', sealed));
  assert.throws(() => vault.open({ ...binding, accountSid: parent }, 'k1', sealed));
  assert.throws(() => vault.open({ ...binding, apiKeySid: `SK${'0'.repeat(32)}` }, 'k1', sealed));
  assert.throws(() => vault.open(binding, 'k2', sealed));
  assert.throws(() => new voice.TwilioVoiceKeyVault(randomBytes(32), 'k1').open(binding, 'k1', sealed), undefined, 'another key');
  assert.equal(voice.twilioVoiceKeyVaultFromEnvironment({}), null);
});

test('CL3b TwiML: the stored number from the school number, recording notice to the callee, ring browsers and forwarding phone, voicemail', () => {
  const out = voice.outgoingDialTwiml({ toE164: '+15125551001', callerIdE164: '+15125550000', recorded: true, language: 'es', publicBase: `${base}/api` });
  assert.match(out, /<Dial callerId="\+15125550000" answerOnBridge="true" timeLimit="14400" action="https:\/\/api\.hon\.example\/api\/v1\/communications\/webhooks\/twilio\/client-dial-result"/);
  assert.match(out, /record="record-from-answer-dual"/);
  assert.match(out, /url="https:\/\/api\.hon\.example\/api\/v1\/communications\/webhooks\/twilio\/recording-notice-es"/);
  assert.match(out, />\+15125551001<\/Number><\/Dial>/);
  assert.doesNotMatch(voice.outgoingDialTwiml({ toE164: '+15125551001', callerIdE164: '+15125550000', recorded: false, language: 'en', publicBase: base }), /record=|recording-notice/);
  assert.throws(() => voice.outgoingDialTwiml({ toE164: '+1512<Play>', callerIdE164: '+15125550000', recorded: false, language: 'en', publicBase: base }));
  const ring = voice.incomingRingTwiml({ identities: [ident, ident2], forwardPhoneE164: '+15125559999', recorded: true, voicemailGreeting: null, language: 'en', schoolName: 'Tiger', publicBase: base });
  assert.match(ring, /^<\?xml[^>]+><Response><Say language="en-US">This call may be recorded\.<\/Say><Dial timeout="20"/);
  assert.equal((ring.match(/<Client /g) ?? []).length, 2);
  assert.match(ring, /<Number [^>]+>\+15125559999<\/Number><\/Dial>/);
  assert.equal((voice.incomingRingTwiml({ identities: Array(12).fill(ident), forwardPhoneE164: null, recorded: false, voicemailGreeting: null, language: 'en', schoolName: 'x', publicBase: base })
    .match(/<Client /g) ?? []).length, 10, 'at most ten browsers ring');
  const none = voice.incomingRingTwiml({ identities: [], forwardPhoneE164: null, recorded: false, voicemailGreeting: 'Hi & welcome', language: 'ko', schoolName: 'x', publicBase: base });
  assert.match(none, /<Say language="ko-KR">Hi &amp; welcome<\/Say><Record maxLength="120"/, 'nobody to ring: straight to voicemail, greeting escaped');
  assert.match(voice.voicemailTwiml({ voicemailGreeting: null, language: 'en', schoolName: 'Tiger <Dojo>', publicBase: base }), /Thanks for calling Tiger Dojo\./);
  assert.throws(() => voice.incomingRingTwiml({ identities: ['client:x'], forwardPhoneE164: null, recorded: false, voicemailGreeting: null, language: 'en', schoolName: 'x', publicBase: base }));
  assert.equal(voice.dialCallStatus('no-answer'), 'NO_ANSWER');
  assert.equal(voice.dialCallStatus('constructor'), null);
  assert.deepEqual([voice.twilioSeconds('42'), voice.twilioSeconds('-1'), voice.twilioSeconds('99999'), voice.twilioSeconds(null)], [42, null, null, null]);
  for (const path of voice.SCHOOL_CALL_WEBHOOK_PATHS) assert.equal(COMMUNICATION_WEBHOOK_PATHS.has(path), true, `${path} goes through the raw signed transport`);
});

test('CL3b client-voice: signed, connects only through the database decision, refused or unapproved calls hang up', async () => {
  let h = harness();
  let s = signed(voice.TWILIO_CLIENT_VOICE_PATH, { AccountSid: parent, CallSid: callSid, From: `client:${ident}`, HonCallId: A });
  const out = await h.controller.clientVoice(req(s), s.signature);
  assert.match(out, />\+15125551001<\/Number>/);
  assert.deepEqual(h.seen[0], ['connect', A, ident, null, callSid], 'the parent account is passed as null');
  // A forged number field in the request is never dialled: the number comes from the decision.
  s = signed(voice.TWILIO_CLIENT_VOICE_PATH, { AccountSid: parent, CallSid: callSid, From: `client:${ident}`, HonCallId: A, To: '+18765551234' });
  assert.doesNotMatch(await h.controller.clientVoice(req(s), s.signature), /8765551234/);
  await assert.rejects(() => h.controller.clientVoice(req(s), 'bad'), (e) => e.getStatus() === 400);
  s = signed(voice.TWILIO_CLIENT_VOICE_PATH, { AccountSid: parent, CallSid: callSid, From: '+15125551001', HonCallId: A });
  await assert.rejects(() => h.controller.clientVoice(req(s), s.signature), (e) => e.getStatus() === 400, 'only a browser client places calls');
  h = harness({ store: { connectSchoolClientCall: async () => ({ outcome: 'REFUSED', toE164: null, callerIdE164: null, recorded: false, language: 'es', schoolName: null }) } });
  s = signed(voice.TWILIO_CLIENT_VOICE_PATH, { AccountSid: parent, CallSid: callSid, From: `client:${ident}`, HonCallId: A });
  assert.match(await h.controller.clientVoice(req(s), s.signature), /No se puede conectar.*<Hangup\/>/);
  h = harness({ environment: env({ HON_VOICE_CALLS_APPROVED: undefined }) });
  assert.match(await h.controller.clientVoice(req(s), s.signature), /<Hangup\/>/);
  assert.equal(h.seen.length, 0, 'without owner approval nothing is even decided');
  h = harness({ store: { connectSchoolClientCall: async () => { throw new Error('db +1512'); } } });
  await assert.rejects(() => h.controller.clientVoice(req(s), s.signature), (e) => e.getStatus() === 503 && !JSON.stringify(e.response).includes('+1512'));
});

test('CL3b subaccount calls: signed with that subaccount token, account passed to every database decision', async () => {
  const subaccounts = { webhookCredential: async (sid) => (sid === sub ? { accountSid: sub, authToken: 'subtok' } : null), numberInAccount: async (sid, phone) => sid === sub && phone === '+15125550000' };
  const h = harness({ subaccounts });
  let s = signed(voice.TWILIO_CLIENT_VOICE_PATH, { AccountSid: sub, CallSid: callSid, From: `client:${ident}`, HonCallId: A }, 'subtok');
  await h.controller.clientVoice(req(s), s.signature);
  assert.equal(h.seen[0][3], sub);
  s = signed(voice.TWILIO_CLIENT_VOICE_PATH, { AccountSid: sub, CallSid: callSid, From: `client:${ident}`, HonCallId: A }, 'tok');
  await assert.rejects(() => h.controller.clientVoice(req(s), s.signature), (e) => e.getStatus() === 400, 'parent token on a subaccount body');
  s = signed(voice.TWILIO_INCOMING_DIAL_RESULT_PATH, { AccountSid: sub, CallSid: callSid, From: '+15125551001', To: '+15125558888', DialCallStatus: 'completed' }, 'subtok');
  await assert.rejects(() => h.controller.incomingDialResult(req(s), s.signature), (e) => e.getStatus() === 400, 'another school\'s number');
  s = signed(voice.TWILIO_RECORDING_STATUS_PATH, { AccountSid: sub, CallSid: callSid, RecordingSid: recSid, RecordingDuration: '30', RecordingStatus: 'completed' }, 'subtok');
  await h.controller.recordingStatus(req(s), s.signature);
  assert.deepEqual(h.seen.at(-1), ['recording', sub, callSid, recSid, 30, false]);
});

test('CL3b call progress: answered legs, dial results, missed call text-back and voicemail, recordings', async () => {
  let h = harness();
  let s = signed(voice.TWILIO_CALL_ANSWERED_PATH, { AccountSid: parent, CallSid: childSid, ParentCallSid: callSid, CallStatus: 'in-progress', To: `client:${ident}` });
  await h.controller.callAnswered(req(s), s.signature);
  assert.deepEqual(h.seen.at(-1).slice(0, 6), ['status', null, callSid, 'IN_PROGRESS', ident, null]);
  s = signed(voice.TWILIO_CALL_ANSWERED_PATH, { AccountSid: parent, CallSid: childSid, ParentCallSid: callSid, CallStatus: 'in-progress', To: '+15125559999' });
  await h.controller.callAnswered(req(s), s.signature);
  assert.equal(h.seen.at(-1)[4], null, 'the forwarding phone answers without a staff identity');
  s = signed(voice.TWILIO_CLIENT_DIAL_RESULT_PATH, { AccountSid: parent, CallSid: callSid, DialCallStatus: 'busy', DialCallDuration: '0' });
  assert.match(await h.controller.clientDialResult(req(s), s.signature), /<Hangup\/>/);
  assert.deepEqual(h.seen.at(-1).slice(0, 6), ['status', null, callSid, 'BUSY', null, 0]);

  h = harness();
  s = signed(voice.TWILIO_INCOMING_DIAL_RESULT_PATH, { AccountSid: parent, CallSid: callSid, From: '+15125551001', To: '+15125550000', DialCallStatus: 'completed', DialCallDuration: '75' });
  assert.match(await h.controller.incomingDialResult(req(s), s.signature), /<Hangup\/>/);
  assert.deepEqual(h.seen.map((x) => x.slice(0, 6)), [['status', null, callSid, 'COMPLETED', null, 75]]);
  h = harness();
  s = signed(voice.TWILIO_INCOMING_DIAL_RESULT_PATH, { AccountSid: parent, CallSid: callSid, From: '+15125551001', To: '+15125550000', DialCallStatus: 'no-answer' });
  const vm = await h.controller.incomingDialResult(req(s), s.signature);
  assert.match(vm, /<Record maxLength="120"/);
  assert.deepEqual(h.seen.map((x) => x[0] === 'status' ? x.slice(0, 4) : x.slice(0, 2)), [['status', null, callSid, 'MISSED'], ['missed', 'no-answer'], ['route', '+15125550000']]);
  h = harness({ store: { recordMissedCall: async () => { throw new Error('down'); } } });
  assert.match(await h.controller.incomingDialResult(req(s), s.signature), /<Record /, 'text-back trouble never blocks voicemail');
  s = signed(voice.TWILIO_VOICEMAIL_STATUS_PATH, { AccountSid: parent, CallSid: callSid, RecordingSid: recSid, RecordingDuration: '12', RecordingStatus: 'completed' });
  await h.controller.voicemailStatus(req(s), s.signature);
  assert.deepEqual(h.seen.at(-1), ['recording', null, callSid, recSid, 12, true]);
  s = signed(voice.TWILIO_VOICEMAIL_STATUS_PATH, { AccountSid: parent, CallSid: callSid, RecordingSid: recSid, RecordingDuration: '12', RecordingStatus: 'absent' });
  const before = h.seen.length;
  await h.controller.voicemailStatus(req(s), s.signature);
  assert.equal(h.seen.length, before, 'only a completed recording is stored');
  s = signed(voice.TWILIO_RECORDING_NOTICE_PATHS.ko, { AccountSid: parent, CallSid: childSid });
  assert.match(await h.controller.noticeKo(req(s), s.signature), /이 통화는 녹음될 수 있습니다/);
  await assert.rejects(() => h.controller.noticeEn(req(s), s.signature), (e) => e.getStatus() === 400, 'each notice path is signed on its own');
  h = harness({ store: { recordSchoolCallStatus: async () => { throw new Error('down'); } } });
  s = signed(voice.TWILIO_CLIENT_DIAL_RESULT_PATH, { AccountSid: parent, CallSid: callSid, DialCallStatus: 'completed', DialCallDuration: '9' });
  await assert.rejects(() => h.controller.clientDialResult(req(s), s.signature), (e) => e.getStatus() === 503, 'database trouble asks Twilio to retry');
});

test('CL3b incoming call on the 0249 voice webhook: browsers ring only when approved and calling is on; otherwise the old path', async () => {
  const make = (environment, store) => {
    const h = harness({ environment, store });
    const old = process.env;
    return { h, run: async (s) => { process.env = { ...old, ...environment }; try { return await new CommunicationWebhookController(h.store, new SendGridEventWebhookVerifier(() => ({})), h.verifier).twilioVoice(req(s), s.signature); } finally { process.env = old; } } };
  };
  const s = signed('/v1/communications/webhooks/twilio/voice', { AccountSid: parent, CallSid: callSid, From: '+15125551001', To: '+15125550000' });
  let m = make(env(), { routeSchoolIncomingCall: async () => ({ outcome: 'RING', callId: A, identities: [ident], forwardPhoneE164: '+15125559999', recorded: false, voicemailGreeting: null, language: 'en', schoolName: 'T' }) });
  let twiml = await m.run(s);
  assert.match(twiml, new RegExp(`<Identity>${ident}</Identity>`));
  assert.match(twiml, /incoming-dial-result/);
  m = make(env(), { routeSchoolIncomingCall: async () => ({ outcome: 'OFF', callId: null, identities: [], forwardPhoneE164: null, recorded: false, voicemailGreeting: null, language: null, schoolName: null }) });
  assert.match(await m.run(s), /voice-result/, 'calling off: the 0249 forward');
  assert.deepEqual(m.h.seen.map((x) => x[0]), ['legacy']);
  m = make(env({ HON_VOICE_CALLS_APPROVED: 'yes' }), {});
  assert.match(await m.run(s), /voice-result/, 'not approved: the 0249 forward, no routing call');
  assert.deepEqual(m.h.seen.map((x) => x[0]), ['legacy']);
  m = make(env(), { routeSchoolIncomingCall: async () => ({ outcome: 'UNROUTED', callId: null, identities: [], forwardPhoneE164: null, recorded: false, voicemailGreeting: null, language: null, schoolName: null }) });
  assert.match(await m.run(s), /<Reject\/>/);
});

test('CL3b phone token service: runtime decision first, then approval, then the sealed key; never a token for a school that is not ready', async () => {
  const staff = { organizationId: A, schoolId: B, principalId: C, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'subject', requestId: A, correlationId: A, idempotencyKey: '' };
  const vault = new voice.TwilioVoiceKeyVault(randomBytes(32), 'k1');
  const key = { accountSid: sub, twimlAppSid: `AP${'f'.repeat(32)}`, apiKeySid: `SK${'e'.repeat(32)}`, vaultKeyId: 'k1' };
  key.sealedApiSecret = vault.seal({ schoolId: B, accountSid: sub, apiKeySid: key.apiKeySid }, 'Secret0123456789abcdef');
  const db = (decision) => ({ withTenantTransaction: async (_c, fn) => fn({ query: async (sql) => (/^SELECT hon\./.test(sql) ? { rows: [{ data: decision }] } : { rows: [] }) }) });
  const ready = { schoolId: B, identity: ident, ready: true, callingOn: true, incoming: true };
  let reads = 0;
  const worker = { isConfigured: () => true, readSchoolVoiceApp: async (school) => { reads += 1; return school === B ? key : null; } };
  const make = (decision, environment = env(), w = worker, v = vault) => new SchoolCallsService(db(decision), w, v, () => environment, () => 1_800_000_000_000);
  const token = await make(ready).phoneToken(staff);
  assert.deepEqual([token.ready, token.reason, token.identity, token.incoming], [true, 'READY', ident, true]);
  const [h, p, sig] = token.token.split('.');
  assert.equal(createHmac('sha256', 'Secret0123456789abcdef').update(`${h}.${p}`).digest('base64url'), sig);
  reads = 0;
  assert.equal((await make({ ...ready, callingOn: false, ready: false, incoming: false }).phoneToken(staff)).reason, 'CALLING_OFF');
  assert.equal((await make({ ...ready, ready: false, incoming: false }).phoneToken(staff)).reason, 'PHONE_NOT_SET_UP');
  assert.equal((await make(ready, env({ HON_VOICE_CALLS_APPROVED: undefined })).phoneToken(staff)).reason, 'VOICE_NOT_APPROVED');
  assert.equal(reads, 0, 'the sealed key is read only for a ready school with calling approved');
  await assert.rejects(() => make({ ...ready, schoolId: A }).phoneToken(staff), (e) => e.getStatus() === 503, 'a decision for another school is not trusted');
  await assert.rejects(() => make({ ...ready, ready: false }).phoneToken(staff), (e) => e.getStatus() === 503, 'incoming without ready is not trusted');
  await assert.rejects(() => make(ready, env(), worker, new voice.TwilioVoiceKeyVault(randomBytes(32), 'k1')).phoneToken(staff), (e) => e.getStatus() === 503, 'a key that does not open');
  await assert.rejects(() => make(ready, env(), worker, null).phoneToken(staff), (e) => e.getStatus() === 503);
  await assert.rejects(() => make(ready).phoneToken({ ...staff, source: 'AI_AGENT' }), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
});
