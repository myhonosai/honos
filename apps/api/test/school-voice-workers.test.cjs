const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const voice = require('../dist/calls/twilio-voice.js');
const rest = require('../dist/calls/twilio-voice-rest.js');
const { SchoolVoiceAppWorker, SchoolCallRecordingRetentionWorker } = require('../dist/calls/school-voice-workers.js');
const { SchoolCallsService } = require('../dist/calls/school-calls.service.js');
const { SchoolCallsController } = require('../dist/calls/school-calls.controller.js');

// CL3c (0556 K2/K3, 0693 V1): voice app setup, recording playback and 90-day deletion, all behind the owner's voice switch.
const parent = `AC${'c'.repeat(32)}`, sub = `AC${'d'.repeat(32)}`;
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const claim = '44444444-4444-4444-8444-444444444444', recSid = `RE${'3'.repeat(32)}`;
const env = (over = {}) => ({ TWILIO_ACCOUNT_SID: parent, TWILIO_AUTH_TOKEN: 'tok', HON_PUBLIC_API_ORIGIN: 'https://api.hon.example', HON_VOICE_CALLS_APPROVED: 'true', HON_DEPLOYMENT_ENVIRONMENT: 'test', ...over });
const reply = (status, body, headers = {}) => new Response(body === undefined ? null : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body), { status, headers });

test('CL3c REST client: parent credentials on the school subaccount, only when voice is approved, closed answers', async () => {
  const calls = [];
  const queue = [];
  const transport = async (url, init) => { calls.push([url, init]); return queue.shift(); };
  const client = new rest.TwilioRestVoiceClient(() => env(), transport);
  assert.equal(new rest.TwilioRestVoiceClient(() => env({ HON_VOICE_CALLS_APPROVED: 'yes' }), transport).readiness(), 'CONFIGURATION_REQUIRED');
  await assert.rejects(() => new rest.TwilioRestVoiceClient(() => env({ HON_VOICE_CALLS_APPROVED: undefined }), transport).createApiKey(sub, 'x'), (e) => e.code === 'VOICE_NOT_APPROVED');
  assert.equal(calls.length, 0, 'nothing reaches Twilio without approval');
  queue.push(reply(201, { sid: `AP${'a'.repeat(32)}` }));
  assert.equal(await client.createTwimlApp(sub, rest.voiceAppFriendlyName(B), 'https://api.hon.example/v1/communications/webhooks/twilio/client-voice'), `AP${'a'.repeat(32)}`);
  const [url, init] = calls[0];
  assert.equal(url, `https://api.twilio.com/2010-04-01/Accounts/${sub}/Applications.json`);
  assert.equal(init.headers.authorization, `Basic ${Buffer.from(`${parent}:tok`).toString('base64')}`);
  assert.equal(new URLSearchParams(init.body).get('VoiceUrl'), 'https://api.hon.example/v1/communications/webhooks/twilio/client-voice');
  assert.equal(new URLSearchParams(init.body).get('FriendlyName'), `hon-voice-${B}`);
  queue.push(reply(200, { applications: [{ sid: `AP${'a'.repeat(32)}`, friendly_name: `hon-voice-${B}` }, { sid: `AP${'b'.repeat(32)}`, friendly_name: `hon-voice-${B}` }] }));
  await assert.rejects(() => client.findTwimlApp(sub, `hon-voice-${B}`), (e) => e.code === 'DUPLICATE_TWIML_APP');
  queue.push(reply(201, { sid: `SK${'e'.repeat(32)}`, secret: 'abcdefghijklmnop1234' }));
  assert.deepEqual(await client.createApiKey(sub, 'k'), { sid: `SK${'e'.repeat(32)}`, secret: 'abcdefghijklmnop1234' });
  queue.push(reply(201, { sid: `SK${'e'.repeat(32)}`, secret: 'short' }));
  await assert.rejects(() => client.createApiKey(sub, 'k'), (e) => e.outcome === 'UNKNOWN');
  queue.push(reply(500, {}));
  await assert.rejects(() => client.createApiKey(sub, 'k'), (e) => e.outcome === 'UNKNOWN', 'a 5xx while creating may have created it');
  queue.push(reply(200, new Uint8Array([1, 2, 3])));
  assert.deepEqual([...(await client.fetchRecording(sub, recSid)).audio], [1, 2, 3]);
  assert.equal(calls.at(-1)[0], `https://api.twilio.com/2010-04-01/Accounts/${sub}/Recordings/${recSid}.mp3`);
  queue.push(reply(404, {}));
  await assert.rejects(() => client.fetchRecording(sub, recSid), (e) => e.outcome === 'GONE');
  queue.push(reply(200, new Uint8Array([1]), { 'content-length': String(rest.RECORDING_MAX_BYTES + 1) }));
  await assert.rejects(() => client.fetchRecording(null, recSid), (e) => e.code === 'RECORDING_TOO_LARGE');
  assert.equal(calls.at(-1)[0], `https://api.twilio.com/2010-04-01/Accounts/${parent}/Recordings/${recSid}.mp3`, 'a school on the parent account uses the parent');
  queue.push(reply(204), reply(404, {}), reply(503, {}));
  assert.equal(await client.deleteRecording(sub, recSid), 'DELETED');
  assert.equal(await client.deleteRecording(sub, recSid), 'GONE');
  await assert.rejects(() => client.deleteRecording(sub, recSid), (e) => e.outcome === 'RETRYABLE');
  await assert.rejects(() => client.deleteRecording(sub, '../x'), (e) => e.code === 'INVALID_RECORDING');
  assert.throws(() => rest.voiceAppFriendlyName('Tiger Dojo'));
  assert.throws(() => new rest.FakeSchoolVoiceTwilioClient({ HON_DEPLOYMENT_ENVIRONMENT: 'production' }));
});

function appStore(state = {}) {
  const seen = [];
  return { seen, store: {
    isConfigured: () => true,
    readSchoolsNeedingVoiceApp: async (limit) => { seen.push(['needing', limit]); return [B]; },
    beginSchoolVoiceApp: async (school, lease) => { seen.push(['begin', school, lease]); return { state: 'CLAIMED', accountSid: sub, twimlAppSid: null, claimToken: claim, ...state }; },
    recordSchoolVoiceAppTwiml: async (...a) => { seen.push(['twiml', ...a]); return true; },
    completeSchoolVoiceApp: async (...a) => { seen.push(['complete', ...a]); return true; },
  } };
}

test('CL3c voice app worker: find-or-create the TwiML App, record it, then seal and record a new API key', async () => {
  const vault = new voice.TwilioVoiceKeyVault(randomBytes(32), 'k1');
  const fake = new rest.FakeSchoolVoiceTwilioClient(env());
  const { seen, store } = appStore();
  const out = await new SchoolVoiceAppWorker(store, fake, vault, () => env()).runOnce();
  assert.deepEqual(out, { skipped: false, outcomes: { [B]: 'CREATED' } });
  const [appSid, app] = [...fake.apps.entries()][0];
  assert.equal(app.voiceUrl, 'https://api.hon.example/v1/communications/webhooks/twilio/client-voice');
  assert.deepEqual(seen.find(s => s[0] === 'twiml'), ['twiml', B, claim, appSid]);
  const done = seen.find(s => s[0] === 'complete');
  assert.equal(done[3], fake.keys[0]); assert.equal(done[5], 'k1');
  assert.match(vault.open({ schoolId: B, accountSid: sub, apiKeySid: done[3] }, 'k1', done[4]), /^[0-9a-f]{32}$/, 'the sealed secret opens only for that school, account and key');
  assert.ok(!JSON.stringify(seen).includes(vault.open({ schoolId: B, accountSid: sub, apiKeySid: done[3] }, 'k1', done[4])), 'the plain secret never reaches the database');
  // An app recorded on an earlier claim is reused, never made twice.
  const again = appStore({ twimlAppSid: appSid });
  await new SchoolVoiceAppWorker(again.store, fake, vault, () => env()).runOnce();
  assert.equal(fake.apps.size, 1); assert.equal(again.seen.some(s => s[0] === 'twiml'), false);
  // A lost key answer leaves the claim to expire; nothing is completed.
  fake.loseNextKey = true;
  const lost = appStore({ twimlAppSid: appSid });
  assert.deepEqual((await new SchoolVoiceAppWorker(lost.store, fake, vault, () => env()).runOnce()).outcomes, { [B]: 'UNKNOWN' });
  assert.equal(lost.seen.some(s => s[0] === 'complete'), false);
  for (const s of ['ACTIVE', 'BUSY', 'INELIGIBLE']) assert.deepEqual((await new SchoolVoiceAppWorker(appStore({ state: s }).store, fake, vault, () => env()).runOnce()).outcomes, { [B]: s });
});

test('CL3c voice app worker does nothing without approval, a vault, a public origin or a configured store', async () => {
  const vault = new voice.TwilioVoiceKeyVault(randomBytes(32), 'k1');
  const fake = new rest.FakeSchoolVoiceTwilioClient(env());
  for (const [store, v, e] of [[appStore().store, vault, env({ HON_VOICE_CALLS_APPROVED: 'false' })], [appStore().store, null, env()],
    [appStore().store, vault, env({ HON_PUBLIC_API_ORIGIN: 'http://insecure.example' })], [{ ...appStore().store, isConfigured: () => false }, vault, env()]]) {
    const { seen } = { seen: [] };
    assert.deepEqual(await new SchoolVoiceAppWorker(store, fake, v, () => e).runOnce(), { skipped: true, outcomes: {} });
  }
  assert.equal(fake.apps.size + fake.keys.length, 0);
});

test('CL3c retention: delete at Twilio first, then mark only that exact recording; failures retry next run', async () => {
  const fake = new rest.FakeSchoolVoiceTwilioClient(env());
  const marked = [];
  const due = [{ callId: A, recordingSid: recSid, accountSid: sub }, { callId: C, recordingSid: `RE${'4'.repeat(32)}`, accountSid: null }];
  const store = { isConfigured: () => true, readSchoolCallRecordingsDue: async () => due, markSchoolCallRecordingDeleted: async (...a) => { marked.push(a); return true; } };
  assert.deepEqual(await new SchoolCallRecordingRetentionWorker(store, fake).runOnce(), { skipped: false, deleted: 2, failed: 0 });
  assert.deepEqual(marked, [[A, recSid], [C, `RE${'4'.repeat(32)}`]]);
  const failing = { readiness: () => 'READY', deleteRecording: async () => { throw new rest.TwilioVoiceError('RETRYABLE'); } };
  marked.length = 0;
  assert.deepEqual(await new SchoolCallRecordingRetentionWorker(store, failing).runOnce(), { skipped: false, deleted: 0, failed: 2 });
  assert.equal(marked.length, 0, 'never marked deleted unless Twilio confirmed');
  assert.deepEqual(await new SchoolCallRecordingRetentionWorker(store, { readiness: () => 'CONFIGURATION_REQUIRED' }).runOnce(), { skipped: true, deleted: 0, failed: 0 });
});

test('CL3c recording playback: database open (audited) first, then the school account audio; gone or unapproved is explained', async () => {
  const staff = { organizationId: A, schoolId: B, principalId: C, principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'subject', requestId: A, correlationId: A, idempotencyKey: '' };
  const sqls = [];
  const db = (data) => ({ withTenantTransaction: async (_c, fn) => fn({ query: async (sql, values) => { sqls.push([sql, values]); return /^SELECT hon\./.test(sql) ? { rows: [{ data }] } : { rows: [] }; } }) });
  const fake = new rest.FakeSchoolVoiceTwilioClient(env());
  fake.recordings.set(recSid, Buffer.from('ID3audio'));
  const make = (data, e = env(), client = fake) => new SchoolCallsService(db(data), undefined, null, () => e, () => 0, client);
  const opened = { recordingSid: recSid, accountSid: sub, seconds: 34 };
  assert.equal((await make(opened).recording(staff, C)).audio.toString(), 'ID3audio');
  assert.ok(sqls.some(([sql, values]) => sql === 'SELECT hon.open_school_call_recording($1,$2::uuid) AS data' && values[1] === C));
  await assert.rejects(() => make({ ...opened, recordingSid: `RE${'9'.repeat(32)}` }).recording(staff, C), (e) => e.getStatus() === 404 && e.response.code === 'CALL_RECORDING_NOT_FOUND');
  await assert.rejects(() => make(opened, env({ HON_VOICE_CALLS_APPROVED: undefined })).recording(staff, C), (e) => e.getStatus() === 503);
  await assert.rejects(() => make({ ...opened, extra: 1 }).recording(staff, C), (e) => e.getStatus() === 503, 'an unverified database answer is not trusted');
  await assert.rejects(() => make({ ...opened, accountSid: 'AC../' }).recording(staff, C), (e) => e.getStatus() === 503);
  await assert.rejects(() => make(opened).recording({ ...staff, source: 'AI_AGENT' }, C), (e) => e.response.code === 'HUMAN_COMMAND_REQUIRED');
  const missing = { withTenantTransaction: async () => { throw Object.assign(new Error('CALL_RECORDING_NOT_FOUND'), { code: 'P0002' }); } };
  await assert.rejects(() => new SchoolCallsService(missing, undefined, null, () => env(), () => 0, fake).recording(staff, C), (e) => e.getStatus() === 404);
});

test('CL3c recording route streams audio with no caching and refuses selectors and keys', async () => {
  const sent = {};
  const response = { status(code) { sent.status = code; return this; }, set(h) { sent.headers = h; return this; }, end(body) { sent.body = body; } };
  const database = { resolveAuthorizedScope: async () => ({ organizationId: A, schoolId: B, principalId: C }) };
  const calls = { recording: async (_ctx, callId) => { sent.callId = callId; return { audio: Buffer.from('mp3'), contentType: 'audio/mpeg' }; } };
  const controller = new SchoolCallsController(database, calls);
  const request = { honIdentity: { externalSubject: 'subject' }, originalUrl: '/x' };
  await controller.recording(A, B, C.toUpperCase(), {}, undefined, request, response);
  assert.equal(sent.status, 200); assert.equal(sent.callId, C); assert.equal(sent.body.toString(), 'mp3');
  assert.equal(sent.headers['Cache-Control'], 'private, no-store'); assert.equal(sent.headers['Content-Type'], 'audio/mpeg'); assert.equal(sent.headers['X-Content-Type-Options'], 'nosniff');
  await assert.rejects(() => controller.recording(A, B, C, { at: '1' }, undefined, request, response), (e) => e.response.code === 'CALL_SELECTORS_NOT_ACCEPTED');
  await assert.rejects(() => controller.recording(A, B, C, {}, 'key-123456', request, response), (e) => e.response.code === 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
});
