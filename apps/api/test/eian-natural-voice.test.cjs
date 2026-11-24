const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { OpenRouterEianSpeechRuntime, EIAN_SPEECH_INSTRUCTIONS, looksLikeMp3 } = require('../dist/eian/eian-speech-runtime.js');
const { EianProviderRuntimeError } = require('../dist/eian/eian-provider-runtime.js');
const { EIAN_VOICE_REFERENCE_MP3_BASE64, EIAN_VOICE_REFERENCE_TRANSCRIPT } = require('../dist/eian/eian-voice-reference.js');
const { spokenForProvider, DEFAULT_COST_DELAYS_MS } = require('../dist/eian/eian-speech.service.js');
const { EIAN_SPEECH_LIMITS, validateEianSpeechInput, verifyEianSpeechStatus, verifyEianSpeechClip } = require('@hon/contracts');

const READY = { OPENROUTER_API_KEY: 'test-key-not-real', OPENROUTER_PAID_CALL_APPROVED: 'true', HON_EIAN_NATURAL_VOICE_APPROVED: 'true' };
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(600, 7)]);
const INPUT = { providerId: 'OPENROUTER', modelId: 'fish-audio/drama-3', providerRequestId: '6f1f8f0a-51a7-4d0e-9c59-3a6b1c1f0a11', text: 'Maya has class today at four thirty.', maxCostMicrounits: 20000 };
const audioResponse = (body = MP3, headers = { 'content-type': 'audio/mpeg', 'x-generation-id': 'gen-1' }, status = 200) => new Response(body, { status, headers });
function runtime(reply, env = READY) {
  const calls = [];
  const transport = async (url, init) => { calls.push({ url: String(url), init }); return typeof reply === 'function' ? reply(url, init) : reply; };
  return { calls, runtime: new OpenRouterEianSpeechRuntime(() => env, transport) };
}
const rejectsWith = (promise, outcome, reason) => assert.rejects(promise, (e) => e instanceof EianProviderRuntimeError && e.outcome === outcome && e.reason === reason);

test('Eian voice: the reference clip is the one the owner picked and holds no family data', () => {
  const bytes = Buffer.from(EIAN_VOICE_REFERENCE_MP3_BASE64, 'base64');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'ff89e6b41a52908bf9cf8ae60c836a99c3e0660ee5ba78fa94cd7f3e1e3452e8');
  assert.ok(looksLikeMp3(bytes) && bytes.length < 120_000);
  assert.equal(EIAN_VOICE_REFERENCE_TRANSCRIPT, "Hi, I'm Ian! Maya has class today at four thirty. She has earned two stripes on her yellow belt, and her next test is in three weeks. Want me to remind you?");
});

test('Eian voice: inactive unless the key, the paid-call approval and the natural-voice approval are all set exactly', async () => {
  for (const env of [{}, { ...READY, OPENROUTER_API_KEY: ' ' }, { ...READY, OPENROUTER_PAID_CALL_APPROVED: 'TRUE' }, { ...READY, HON_EIAN_NATURAL_VOICE_APPROVED: undefined },
    { ...READY, HON_EIAN_NATURAL_VOICE_APPROVED: '1' }]) {
    const r = runtime(audioResponse(), env);
    assert.equal(r.runtime.readiness(), 'CONFIGURATION_REQUIRED');
    await rejectsWith(r.runtime.synthesize(INPUT), 'PRE_SEND', 'CONFIGURATION_REQUIRED');
    assert.equal(r.calls.length, 0);
  }
  assert.equal(runtime(audioResponse()).runtime.readiness(), 'READY');
});

test('Eian voice: one fixed request; the words are the input and nothing else is', async () => {
  const r = runtime(audioResponse());
  const made = await r.runtime.synthesize(INPUT);
  assert.ok(made.audio.equals(MP3)); assert.equal(made.generationId, 'gen-1');
  assert.equal(r.calls.length, 1);
  const { url, init } = r.calls[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/audio/speech');
  assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, 'Bearer test-key-not-real');
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body).sort(), ['input', 'input_references', 'instructions', 'model', 'provider', 'response_format']);
  assert.equal(body.model, 'fish-audio/drama-3'); assert.equal(body.response_format, 'mp3');
  // The delivery instruction has its own field; a provider may read instructions aloud when they are mixed into the text.
  assert.equal(body.input, INPUT.text); assert.equal(body.instructions, EIAN_SPEECH_INSTRUCTIONS); assert.ok(!body.input.includes(EIAN_SPEECH_INSTRUCTIONS));
  assert.deepEqual(body.provider, { allow_fallbacks: false, data_collection: 'deny' });
  assert.deepEqual(body.input_references, [{ type: 'input_audio', input_audio: { data: `data:audio/mp3;base64,${EIAN_VOICE_REFERENCE_MP3_BASE64}` } },
    { type: 'text', text: EIAN_VOICE_REFERENCE_TRANSCRIPT }]);
  assert.ok(!('voice' in body) && !('user' in body) && !('metadata' in body));
});

test('Eian voice: a request that does not match the fixed limits is refused before any call', async () => {
  for (const bad of [{ providerId: 'OTHER' }, { modelId: 'bad model' }, { maxCostMicrounits: 20001 }, { text: '' }, { text: 'x'.repeat(EIAN_SPEECH_LIMITS.maxCharacters + 1) }]) {
    const r = runtime(audioResponse());
    await assert.rejects(r.runtime.synthesize({ ...INPUT, ...bad }), (e) => e instanceof EianProviderRuntimeError && e.outcome === 'PRE_SEND');
    assert.equal(r.calls.length, 0);
  }
});

test('Eian voice: provider answers map to closed outcomes; anything unverified is UNKNOWN and never retried', async () => {
  for (const status of [404, 429]) await rejectsWith(runtime(audioResponse('no', {}, status)).runtime.synthesize(INPUT), 'FAILED', 'PROVIDER_UNAVAILABLE');
  for (const status of [400, 401, 402, 403, 422]) await rejectsWith(runtime(audioResponse('no', {}, status)).runtime.synthesize(INPUT), 'FAILED', 'PROVIDER_REJECTED');
  const unknown = [audioResponse('oops', {}, 500), audioResponse('oops', {}, 502),
    audioResponse(MP3, { 'content-type': 'application/json', 'x-generation-id': 'gen-1' }), audioResponse(MP3, { 'content-type': 'audio/mpeg' }),
    audioResponse(MP3, { 'content-type': 'audio/mpeg', 'x-generation-id': 'bad id with spaces' }),
    audioResponse(Buffer.from('{"error":"not audio"}'.padEnd(600, ' ')), { 'content-type': 'audio/mpeg', 'x-generation-id': 'gen-1' }),
    audioResponse(Buffer.from('ID3'), { 'content-type': 'audio/mpeg', 'x-generation-id': 'gen-1' })];
  for (const reply of unknown) {
    const r = runtime(reply);
    await rejectsWith(r.runtime.synthesize(INPUT), 'UNKNOWN', 'PROVIDER_UNKNOWN');
    assert.equal(r.calls.length, 1);
  }
  const thrown = runtime(() => { throw new Error('socket closed'); });
  await rejectsWith(thrown.runtime.synthesize(INPUT), 'UNKNOWN', 'PROVIDER_UNKNOWN');
  assert.equal(thrown.calls.length, 1);
});

test('Eian voice: the cost is the provider-reported amount for exactly this call, or nothing', async () => {
  const record = (data, status = 200) => new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json' } });
  const good = { id: 'gen-1', model: 'fish-audio/drama-3-20261013', api_type: 'tts', total_cost: 0.0009 };
  const r = runtime(record(good));
  assert.equal(await r.runtime.cost('gen-1', 'fish-audio/drama-3'), 900);
  assert.equal(r.calls[0].url, 'https://openrouter.ai/api/v1/generation?id=gen-1'); assert.equal(r.calls[0].init.method, 'GET'); assert.equal(r.calls[0].init.redirect, 'error');
  assert.equal(await runtime(record({ ...good, model: 'fish-audio/drama-3' })).runtime.cost('gen-1', 'fish-audio/drama-3'), 900);
  assert.equal(await runtime(record({ ...good, total_cost: 0.00000149 })).runtime.cost('gen-1', 'fish-audio/drama-3'), 2, 'rounded up to a whole microunit');
  assert.equal(await runtime(record({ ...good, total_cost: 0 })).runtime.cost('gen-1', 'fish-audio/drama-3'), 0);
  for (const bad of [{ ...good, id: 'gen-2' }, { ...good, api_type: 'chat' }, { ...good, model: 'fish-audio/drama-30' }, { ...good, model: 'other/model' }, { ...good, total_cost: '0.0009' },
    { ...good, total_cost: -1 }, { ...good, total_cost: 1001 }, { ...good, total_cost: undefined }, undefined]) {
    assert.equal(await runtime(record(bad)).runtime.cost('gen-1', 'fish-audio/drama-3'), null);
  }
  assert.equal(await runtime(record(good, 404)).runtime.cost('gen-1', 'fish-audio/drama-3'), null, 'not published yet');
  assert.equal(await runtime(() => { throw new Error('offline'); }).runtime.cost('gen-1', 'fish-audio/drama-3'), null);
  const none = runtime(record(good));
  assert.equal(await none.runtime.cost('bad id', 'fish-audio/drama-3'), null); assert.equal(none.calls.length, 0);
});

test('Eian voice: what is said: the name as the owner says it, never an email or an id', () => {
  assert.equal(spokenForProvider("Hi, I'm Eian! Eian's here."), "Hi, I'm Ian! Ian's here.");
  assert.equal(spokenForProvider('Write to coach.kim+dojo@example.test today.'), 'Write to an email address today.');
  assert.equal(spokenForProvider('Booking 6f1f8f0a-51a7-4d0e-9c59-3a6b1c1f0a11 is set.'), 'Booking an id is set.');
  assert.equal(spokenForProvider('Meian and Eiana are other words.'), 'Meian and Eiana are other words.');
  assert.equal(spokenForProvider('   '), null);
  assert.deepEqual([...DEFAULT_COST_DELAYS_MS], [6000, 12000, 24000]);
});

test('Eian voice contracts: closed input, status and clip', () => {
  assert.deepEqual(validateEianSpeechInput({ text: '  Class is at four.  ' }), { text: 'Class is at four.' });
  assert.deepEqual(validateEianSpeechInput({ text: 'Line one.\nLine two.' }), { text: 'Line one.\nLine two.' });
  for (const bad of [null, [], {}, { text: 5 }, { text: '' }, { text: 'x'.repeat(1501) }, { text: 'a\u0000b' }, { text: 'see http://example.test' }, { text: 'see WWW.example.test' },
    { text: 'ok', voice: 'x' }, { text: 'ok', instructions: 'Whisper.' }, { text: 'ok', familyId: '1' }]) assert.throws(() => validateEianSpeechInput(bad));
  assert.deepEqual(verifyEianSpeechStatus({ voice: 'NATURAL', reason: null }), { voice: 'NATURAL', reason: null });
  assert.deepEqual(verifyEianSpeechStatus({ voice: 'PHONE', reason: 'BUDGET_REACHED' }), { voice: 'PHONE', reason: 'BUDGET_REACHED' });
  for (const bad of [{ voice: 'NATURAL', reason: 'PAUSED' }, { voice: 'PHONE', reason: null }, { voice: 'PHONE', reason: 'CEILING_12000' }, { voice: 'ROBOT', reason: null },
    { voice: 'NATURAL', reason: null, model: 'x' }]) assert.throws(() => verifyEianSpeechStatus(bad));
  const audio = MP3.toString('base64');
  assert.deepEqual(verifyEianSpeechClip({ audio, mime: 'audio/mpeg' }), { audio, mime: 'audio/mpeg' });
  for (const bad of [{ audio, mime: 'audio/wav' }, { audio: 'not base64!!', mime: 'audio/mpeg' }, { audio: '', mime: 'audio/mpeg' }, { audio, mime: 'audio/mpeg', cost: 1 }, { audio }]) {
    assert.throws(() => verifyEianSpeechClip(bad));
  }
});

test('HQ knows both Eian agents: answers (EIAN) and the natural voice (EIAN_SPEECH)', () => {
  const { AI_UNKNOWN_AGENTS, AI_USAGE_AGENTS, validateAiUnknownAgent } = require('@hon/contracts');
  for (const agent of ['EIAN', 'EIAN_SPEECH']) {
    assert.equal(validateAiUnknownAgent(agent), agent);
    assert.ok(AI_UNKNOWN_AGENTS.includes(agent) && AI_USAGE_AGENTS.includes(agent));
  }
  assert.throws(() => validateAiUnknownAgent('EIAN_VIDEO'));
  const copy = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../../web/src/components/hq-ai-control/copy.ts'), 'utf8');
  assert.equal(copy.match(/a_EIAN: '/g).length, 3, 'a label in each of the three languages');
  assert.equal(copy.match(/a_EIAN_SPEECH: /g).length, 3);
});
