const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { OpenRouterAgentSpeechRuntime, SpeechProviderRuntimeError, pcmToWav, SAMPLE_RATE } = require('../dist/agent-speech/agent-speech-runtime.js');
const { AgentSpeechService, spokenForAgent, DEFAULT_AGENT_SPEECH_COST_DELAYS_MS } = require('../dist/agent-speech/agent-speech.service.js');
const { AGENT_SPEECH_AGENTS, AGENT_SPEECH_LIMITS, AGENT_SPEECH_VOICES, isAgentSpeechAgent, validateAgentSpeechInput, verifyAgentSpeechStatus, verifyAgentSpeechClip,
  AI_USAGE_AGENTS, AI_UNKNOWN_AGENTS } = require('@hon/contracts');

const READY = { OPENROUTER_API_KEY: 'test-key-not-real', OPENROUTER_PAID_CALL_APPROVED: 'true', HON_AGENT_NATURAL_VOICE_APPROVED: 'true' };
const PCM = Buffer.alloc(4800, 3);
const INPUT = { providerId: 'OPENROUTER', modelId: 'google/gemini-3.8-flash-lite-tts', voice: 'Leda', providerRequestId: '6f1f8f0a-51a7-4d0e-9c59-3a6b1c1f0a11', text: 'Two renewals this month.', maxCostMicrounits: 20000 };
const pcmResponse = (body = PCM, headers = { 'content-type': 'audio/pcm;rate=24000;channels=1', 'x-generation-id': 'gen-tts-1' }, status = 200) => new Response(body, { status, headers });
function runtime(reply, env = READY) {
  const calls = [];
  const transport = async (url, init) => { calls.push({ url: String(url), init }); return typeof reply === 'function' ? reply(url, init) : reply; };
  return { calls, runtime: new OpenRouterAgentSpeechRuntime(() => env, transport) };
}
const rejectsWith = (promise, outcome, reason) => assert.rejects(promise, (e) => e instanceof SpeechProviderRuntimeError && e.outcome === outcome && e.reason === reason);

test('agent voices: the nine school agents, each with the Gemini voice from the samples, mirrored in the migration', () => {
  assert.deepEqual([...AGENT_SPEECH_AGENTS].sort(), ['alex', 'chad', 'claire', 'hon', 'jordan', 'kai', 'lena', 'marcus', 'maya']);
  assert.deepEqual(AGENT_SPEECH_VOICES, { hon: 'Kore', maya: 'Leda', chad: 'Puck', kai: 'Charon', alex: 'Orus', jordan: 'Iapetus', marcus: 'Fenrir', claire: 'Despina', lena: 'Aoede' });
  const sql = readFileSync(join(__dirname, '../../../packages/database/migrations/0652_staff_agent_speech.sql'), 'utf8');
  for (const [agent, voice] of Object.entries(AGENT_SPEECH_VOICES)) assert.ok(sql.includes(`'${agent}','${voice}'`), agent);
  assert.ok(sql.includes("'maxCharacters',1000,'maxProviderCostMicrounits',20000,'burst',30,'dailyClips',200"));
  assert.deepEqual(AGENT_SPEECH_LIMITS, { maxCharacters: 1000, maxProviderCostMicrounits: 20000, burst: 30, dailyClips: 200 });
  assert.ok(AI_USAGE_AGENTS.includes('AGENT_SPEECH') && AI_UNKNOWN_AGENTS.includes('AGENT_SPEECH'));
  assert.ok(!isAgentSpeechAgent('eian') && !isAgentSpeechAgent('HON') && isAgentSpeechAgent('kai'));
});

test('agent voices: inactive unless the key, the paid-call approval and the agent voice approval are all set exactly', async () => {
  for (const env of [{}, { ...READY, OPENROUTER_API_KEY: ' ' }, { ...READY, OPENROUTER_PAID_CALL_APPROVED: 'TRUE' }, { ...READY, HON_AGENT_NATURAL_VOICE_APPROVED: undefined },
    { ...READY, HON_AGENT_NATURAL_VOICE_APPROVED: '1' }, { ...READY, HON_AGENT_NATURAL_VOICE_APPROVED: undefined, HON_EIAN_NATURAL_VOICE_APPROVED: 'true' }]) {
    const r = runtime(pcmResponse(), env);
    assert.equal(r.runtime.readiness(), 'CONFIGURATION_REQUIRED');
    await rejectsWith(r.runtime.synthesize(INPUT), 'PRE_SEND', 'CONFIGURATION_REQUIRED');
    assert.equal(r.calls.length, 0);
  }
  assert.equal(runtime(pcmResponse()).runtime.readiness(), 'READY');
});

test('agent voices: one fixed request, the words and the voice name only, and the PCM comes back as WAV', async () => {
  const r = runtime(pcmResponse());
  const made = await r.runtime.synthesize(INPUT);
  assert.equal(r.calls.length, 1);
  const { url, init } = r.calls[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/audio/speech'); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, 'Bearer test-key-not-real'); assert.equal(init.headers['Idempotency-Key'], INPUT.providerRequestId);
  assert.deepEqual(JSON.parse(init.body), { model: INPUT.modelId, input: INPUT.text, voice: 'Leda', response_format: 'pcm', provider: { allow_fallbacks: false, data_collection: 'deny' } });
  assert.equal(made.generationId, 'gen-tts-1');
  assert.equal(made.audio.length, 44 + PCM.length);
  assert.equal(made.audio.subarray(0, 4).toString('latin1'), 'RIFF'); assert.equal(made.audio.subarray(8, 12).toString('latin1'), 'WAVE');
  assert.equal(made.audio.readUInt32LE(24), SAMPLE_RATE); assert.equal(made.audio.readUInt16LE(22), 1); assert.equal(made.audio.readUInt16LE(34), 16); assert.equal(made.audio.readUInt32LE(40), PCM.length);
  assert.deepEqual(made.audio.subarray(44), PCM);
  assert.deepEqual(pcmToWav(Buffer.alloc(2)).subarray(0, 4), Buffer.from('RIFF'));
});

test('agent voices: bad input never calls; provider answers map to closed outcomes; unverified audio is UNKNOWN', async () => {
  for (const patch of [{ providerId: 'OTHER' }, { voice: 'leda' }, { voice: 'Leda; drop' }, { text: '' }, { text: 'x'.repeat(1001) }, { maxCostMicrounits: 1 }, { modelId: '../x' }]) {
    const r = runtime(pcmResponse());
    await assert.rejects(r.runtime.synthesize({ ...INPUT, ...patch }), (e) => e instanceof SpeechProviderRuntimeError && e.outcome === 'PRE_SEND');
    assert.equal(r.calls.length, 0, JSON.stringify(patch));
  }
  for (const [status, outcome, reason] of [[429, 'FAILED', 'PROVIDER_UNAVAILABLE'], [404, 'FAILED', 'PROVIDER_UNAVAILABLE'], [400, 'FAILED', 'PROVIDER_REJECTED'], [402, 'FAILED', 'PROVIDER_REJECTED'], [500, 'UNKNOWN', 'PROVIDER_UNKNOWN']]) {
    await rejectsWith(runtime(pcmResponse(Buffer.from('{}'), { 'content-type': 'application/json' }, status)).runtime.synthesize(INPUT), outcome, reason);
  }
  for (const headers of [{ 'content-type': 'audio/mpeg', 'x-generation-id': 'gen-1' }, { 'content-type': 'audio/pcm;rate=16000;channels=1', 'x-generation-id': 'gen-1' },
    { 'content-type': 'audio/pcm;rate=24000;channels=2', 'x-generation-id': 'gen-1' }, { 'content-type': 'audio/pcm;rate=24000;channels=1' }, { 'content-type': 'audio/pcm;rate=24000;channels=1', 'x-generation-id': 'bad id' }]) {
    await rejectsWith(runtime(pcmResponse(PCM, headers)).runtime.synthesize(INPUT), 'UNKNOWN', 'PROVIDER_UNKNOWN');
  }
  await rejectsWith(runtime(pcmResponse(Buffer.alloc(100))).runtime.synthesize(INPUT), 'UNKNOWN', 'PROVIDER_UNKNOWN');
  await rejectsWith(runtime(pcmResponse(Buffer.alloc(4801))).runtime.synthesize(INPUT), 'UNKNOWN', 'PROVIDER_UNKNOWN');
  await rejectsWith(runtime(async () => { throw new Error('reset'); }).runtime.synthesize(INPUT), 'UNKNOWN', 'PROVIDER_UNKNOWN');
});

test('agent voices: the cost is read by generation id, for this model only', async () => {
  const record = (data) => runtime(new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const good = { id: 'gen-tts-1', model: 'google/gemini-3.8-flash-lite-tts-20260922', api_type: 'tts', total_cost: 0.000231 };
  const r = record(good);
  assert.equal(await r.runtime.cost('gen-tts-1', INPUT.modelId), 231);
  assert.equal(r.calls[0].url, 'https://openrouter.ai/api/v1/generation?id=gen-tts-1'); assert.equal(r.calls[0].init.redirect, 'error');
  for (const bad of [{ ...good, id: 'other' }, { ...good, api_type: 'chat' }, { ...good, model: 'fish-audio/drama-3' }, { ...good, total_cost: -1 }, { ...good, total_cost: 'x' }]) {
    assert.equal(await record(bad).runtime.cost('gen-tts-1', INPUT.modelId), null);
  }
  assert.equal(await runtime(new Response('{}', { status: 404 })).runtime.cost('gen-tts-1', INPUT.modelId), null);
  assert.equal(await record(good).runtime.cost('bad id', INPUT.modelId), null);
});

test('agent voices: closed contract shapes and words that are never spoken', () => {
  assert.deepEqual(validateAgentSpeechInput({ text: '  Hi.  ' }), { text: 'Hi.' });
  for (const bad of [null, [], { text: 1 }, { text: '' }, { text: 'x'.repeat(1001) }, { text: 'see www.example.test' }, { text: 'bell \u0007' }, { text: 'a', voice: 'Kore' }]) {
    assert.throws(() => validateAgentSpeechInput(bad), JSON.stringify(bad));
  }
  assert.deepEqual(verifyAgentSpeechStatus({ voice: 'NATURAL', reason: null }), { voice: 'NATURAL', reason: null });
  for (const bad of [{ voice: 'NATURAL', reason: 'PAUSED' }, { voice: 'BROWSER', reason: null }, { voice: 'PHONE', reason: 'PAUSED' }, { voice: 'BROWSER', reason: 'MODEL' }]) assert.throws(() => verifyAgentSpeechStatus(bad));
  assert.ok(verifyAgentSpeechClip({ audio: 'UklGRiQAAABXQVZF', mime: 'audio/wav' }));
  assert.throws(() => verifyAgentSpeechClip({ audio: 'UklGRiQAAABXQVZF', mime: 'audio/mpeg' }));
  assert.equal(spokenForAgent('Mail coach@example.test about 0b6c9b4e-8f1a-4c38-9d8e-2b7a2d6f1a11'), 'Mail an email address about an id');
  assert.equal(spokenForAgent('   '), null);
  assert.deepEqual(DEFAULT_AGENT_SPEECH_COST_DELAYS_MS, [6000, 12000, 24000]);
});

test('agent voices: the service refuses before any database work for a bad agent, text or key, or a non-human caller', async () => {
  let touched = 0;
  const database = { withTenantTransaction: async () => { touched += 1; throw new Error('should not run'); } };
  const provider = { readiness: () => 'READY', synthesize: async () => { throw new Error('should not run'); }, cost: async () => null };
  const service = new AgentSpeechService(database, provider, [0]);
  const ctx = { organizationId: 'o', schoolId: 's', principalId: 'p', externalSubject: 'sub', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: 'r' };
  const code = async (p) => { try { await p; return 'OK'; } catch (e) { return e.getResponse?.().code; } };
  assert.equal(await code(service.speak(ctx, 'eian', { text: 'Hi.' }, 'k')), 'VALIDATION_FAILED');
  assert.equal(await code(service.speak(ctx, 'hon', { text: 'https://x.test' }, 'k')), 'VALIDATION_FAILED');
  assert.equal(await code(service.speak(ctx, 'hon', { text: 'Hi.' }, ' k')), 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal(await code(service.speak(ctx, 'hon', { text: 'Hi.' }, undefined)), 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal(await code(service.status(ctx, 'nobody')), 'VALIDATION_FAILED');
  assert.equal(await code(service.speak({ ...ctx, source: 'AUTOMATION' }, 'hon', { text: 'Hi.' }, 'k')), 'HUMAN_COMMAND_REQUIRED');
  assert.equal(touched, 0);
});
