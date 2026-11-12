const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const contracts = require('@hon/contracts');
const hon = require('../dist/ai/hon-reply-provider-runtime.js');
const kai = require('../dist/ai/claire-provider-runtime.js');

// 0256 HON tone per school: a closed key picks one fixed sentence; STANDARD is today's prompt byte for byte; Claire never
// changes; an unknown key is refused before anything is sent.

const T = '2026-11-11T09:00:00.000Z';
const { HON_REPLY_MODES } = contracts;

test('0256 tones are a closed set with labels; STANDARD is the default', () => {
  assert.deepEqual([...contracts.HON_AI_TONES], ['STANDARD', 'FRIENDLY_COACH', 'STRAIGHT_TO_THE_POINT', 'FORMAL']);
  assert.deepEqual(contracts.HON_AI_TONE_LABELS, { STANDARD: 'Standard', FRIENDLY_COACH: 'Friendly coach', STRAIGHT_TO_THE_POINT: 'Straight to the point', FORMAL: 'Formal' });
  assert.deepEqual(contracts.validateHonSchoolToneInput({ tone: 'FORMAL' }), { tone: 'FORMAL' });
  for (const bad of [{}, { tone: 'formal' }, { tone: 'PIRATE' }, { tone: 'FORMAL', extra: 1 }, null, 'FORMAL']) assert.throws(() => contracts.validateHonSchoolToneInput(bad), undefined, JSON.stringify(bad));
  const view = { tone: 'STANDARD', canManage: true, updatedAt: null };
  assert.deepEqual(contracts.validateHonSchoolTone(view), view);
  assert.deepEqual(contracts.validateHonSchoolTone({ ...view, tone: 'FORMAL', updatedAt: T }).updatedAt, T);
  for (const bad of [{ ...view, extra: 1 }, { ...view, tone: 'LOUD' }, { ...view, canManage: 1 }, { ...view, updatedAt: 'yesterday' }]) assert.throws(() => contracts.validateHonSchoolTone(bad), undefined, JSON.stringify(bad));
  assert.deepEqual(contracts.validateHonSchoolToneReceipt({ tone: 'FORMAL', previousTone: 'STANDARD', replayed: false }), { tone: 'FORMAL', previousTone: 'STANDARD', replayed: false });
  assert.throws(() => contracts.validateHonSchoolToneReceipt({ tone: 'FORMAL', replayed: false }));
});

test('0256 HON prompt: STANDARD is unchanged, each tone appends exactly its fixed sentence, Claire never changes', () => {
  const base = hon.honReplySystemPrompt('STANDARD', 1, 'hon');
  assert.equal(hon.honReplySystemPrompt('STANDARD', 1, 'hon', 'STANDARD'), base);
  const seen = new Set();
  for (const tone of ['FRIENDLY_COACH', 'STRAIGHT_TO_THE_POINT', 'FORMAL']) {
    const p = hon.honReplySystemPrompt('STANDARD', 1, 'hon', tone);
    assert.equal(p, `${base} ${hon.HON_TONE_GUIDANCE[tone]}`);
    assert.match(hon.HON_TONE_GUIDANCE[tone], /never changes the facts rules/);
    seen.add(p);
  }
  assert.equal(seen.size, 3);
  assert.equal(hon.HON_TONE_GUIDANCE.STANDARD, '');
  const claire = hon.honReplySystemPrompt('DETAILED', 1, 'claire');
  for (const tone of contracts.HON_AI_TONES) assert.equal(hon.honReplySystemPrompt('DETAILED', 1, 'claire', tone), claire);
  assert.equal(hon.honReplySystemPrompt('STANDARD', 1, 'hon', 'PIRATE'), '', 'unknown tone has no prompt');
});

test('0256 HON runtime sends the tone sentence and refuses an unknown tone before any send', async () => {
  const S = HON_REPLY_MODES.STANDARD;
  const input = { specialist: 'hon', providerId: 'OPENROUTER', modelId: 'approved/test', providerRequestId: '11111111-1111-4111-8111-111111111111', replyMode: 'STANDARD', step: 1,
    question: 'How are leads?', facts: '{}', inputBudget: S.inputTokens, outputBudget: S.outputTokens, maxCostMicrounits: S.maxProviderCostMicrounits };
  const sent = [];
  const runtime = new hon.OpenRouterHonReplyRuntime(() => ({ OPENROUTER_API_KEY: 'test-key', OPENROUTER_PAID_CALL_APPROVED: 'true' }), async (_url, init) => {
    sent.push(JSON.parse(init.body).messages[0].content);
    return { status: 200, ok: true, json: async () => ({ model: 'approved/test', choices: [{ finish_reason: 'stop', message: { content: 'Two leads.' } }], usage: { prompt_tokens: 300, completion_tokens: 20, cost: 0.0001 } }) };
  });
  await runtime.generate({ ...input, tone: 'FORMAL' });
  assert.ok(sent[0].endsWith(hon.HON_TONE_GUIDANCE.FORMAL));
  await runtime.generate(input);
  assert.equal(sent[1], hon.honReplySystemPrompt('STANDARD', 1, 'hon'), 'no tone means STANDARD');
  await assert.rejects(runtime.generate({ ...input, tone: 'PIRATE' }), (e) => e instanceof hon.HonReplyProviderRuntimeError && e.outcome === 'PRE_SEND');
  assert.equal(sent.length, 2, 'nothing sent for an unknown tone');
});

test('0256 Kai prompt: STANDARD is unchanged, tones add the same fixed sentence, unknown refused before send', async () => {
  assert.equal(kai.kaiSystemPrompt('STANDARD'), kai.KAI_SYSTEM_PROMPT);
  for (const tone of ['FRIENDLY_COACH', 'STRAIGHT_TO_THE_POINT', 'FORMAL']) assert.equal(kai.kaiSystemPrompt(tone), `${kai.KAI_SYSTEM_PROMPT} ${hon.HON_TONE_GUIDANCE[tone]}`);
  assert.equal(kai.kaiSystemPrompt('PIRATE'), '');
  const sent = [];
  const runtime = new kai.OpenRouterClaireRuntime(() => ({ OPENROUTER_API_KEY: 'test-key', OPENROUTER_PAID_CALL_APPROVED: 'true' }), async (_url, init) => {
    sent.push(JSON.parse(init.body).messages[0].content);
    throw new TypeError('network');
  });
  const input = { providerId: 'OPENROUTER', modelId: 'approved/test', providerRequestId: '11111111-1111-4111-8111-111111111111', request: '{}', inputBudget: 4096, outputBudget: 1024, maxCostMicrounits: 100000 };
  await assert.rejects(runtime.generate({ ...input, tone: 'FRIENDLY_COACH' }), (e) => e.outcome === 'UNKNOWN');
  assert.ok(sent[0].endsWith(hon.HON_TONE_GUIDANCE.FRIENDLY_COACH));
  await assert.rejects(runtime.generate({ ...input, tone: 'PIRATE' }), (e) => e.outcome === 'PRE_SEND' && e.reason === 'INVALID_REQUEST');
  assert.equal(sent.length, 1);
});

test('0256 services read the school tone in the prepare transaction; API has GET and POST /hon/tone', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.match(read('src/hon-conversation/hon-reply.service.ts'), /hon\.hon_ai_tone\(\)/);
  assert.match(read('src/teaching-assistant/teaching-assistant.service.ts'), /hon\.hon_ai_tone\(\)/);
  const controller = read('src/hon-conversation/hon-conversation.controller.ts');
  assert.match(controller, /@Get\('tone'\)/);
  assert.match(controller, /@Post\('tone'\)/);
  assert.match(controller, /hon\.read_hon_school_tone\(\$1\)/);
  assert.match(controller, /hon\.set_hon_school_tone\(\$1,\$2::jsonb,\$3,current_setting\('app\.hon_request_id'\)::uuid,/);
  assert.match(controller, /validateHonSchoolToneInput\(input\)/);
});
