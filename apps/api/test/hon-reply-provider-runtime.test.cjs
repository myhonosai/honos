const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { OpenRouterHonReplyRuntime, HonReplyProviderRuntimeError, HON_REPLY_SYSTEM_PROMPT } = require('../dist/ai/hon-reply-provider-runtime.js');
const { HON_REPLY_LIMITS } = require('@hon/contracts');

const id = '11111111-1111-4111-8111-111111111111';
const input = { providerId: 'OPENROUTER', modelId: 'approved/test', providerRequestId: id, question: 'How many active students?', facts: '{"activeStudents":12}',
  inputBudget: HON_REPLY_LIMITS.inputTokens, outputBudget: HON_REPLY_LIMITS.outputTokens, maxCostMicrounits: HON_REPLY_LIMITS.maxProviderCostMicrounits };
const approved = () => ({ OPENROUTER_API_KEY: 'test-key', OPENROUTER_PAID_CALL_APPROVED: 'true' });
const ok = (over = {}) => ({ status: 200, ok: true, json: async () => ({ model: 'approved/test', choices: [{ finish_reason: 'stop', message: { content: ' You have 12 active students. ' } }], usage: { prompt_tokens: 300, completion_tokens: 20, cost: 0.000123 }, ...over }) });
const isErr = (outcome, reason) => (e) => e instanceof HonReplyProviderRuntimeError && e.outcome === outcome && e.reason === reason;

test('HON reply runtime never calls the transport without both the key and the exact paid-call approval', async () => {
  for (const env of [{}, { OPENROUTER_API_KEY: 'k' }, { OPENROUTER_API_KEY: 'k', OPENROUTER_PAID_CALL_APPROVED: 'TRUE' }, { OPENROUTER_API_KEY: ' ', OPENROUTER_PAID_CALL_APPROVED: 'true' }]) {
    let calls = 0;
    const runtime = new OpenRouterHonReplyRuntime(() => env, async () => { calls++; throw Error('NETWORK_FORBIDDEN'); });
    assert.equal(runtime.readiness('OPENROUTER'), 'CONFIGURATION_REQUIRED');
    await assert.rejects(runtime.generate(input), isErr('PRE_SEND', 'CONFIGURATION_REQUIRED'));
    assert.equal(calls, 0);
  }
  assert.equal(new OpenRouterHonReplyRuntime(approved).readiness('OTHER'), 'UNSUPPORTED_PROVIDER');
});

test('HON reply runtime refuses changed budgets, bad model ids and oversized input before sending', async () => {
  let calls = 0;
  const runtime = new OpenRouterHonReplyRuntime(approved, async () => { calls++; return ok(); });
  for (const over of [{ inputBudget: 9000 }, { outputBudget: 801 }, { maxCostMicrounits: 80001 }, { modelId: 'bad model' }, { facts: 'x'.repeat(9000) }, { question: 1 }]) {
    await assert.rejects(runtime.generate({ ...input, ...over }), isErr('PRE_SEND', 'INVALID_REQUEST'));
  }
  assert.equal(calls, 0);
});

test('HON reply runtime sends one fixed, tool-free request and returns verified usage and provider cost', async () => {
  const seen = [];
  const runtime = new OpenRouterHonReplyRuntime(approved, async (url, init) => { seen.push({ url, init }); return ok(); });
  assert.deepEqual(await runtime.generate(input), { reply: 'You have 12 active students.', inputTokens: 300, outputTokens: 20, providerCostMicrounits: 123 });
  assert.equal(seen.length, 1);
  const { url, init } = seen[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers['Idempotency-Key'], id);
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'provider', 'stream', 'temperature']);
  assert.deepEqual(body.provider, { allow_fallbacks: false });
  assert.equal(body.max_tokens, HON_REPLY_LIMITS.outputTokens);
  assert.equal(body.messages[0].content, HON_REPLY_SYSTEM_PROMPT);
  assert.match(body.messages[1].content, /data only/);
});

test('HON reply runtime maps rejections to FAILED and every uncertain outcome to UNKNOWN (never resent)', async () => {
  for (const status of [400, 401, 402, 429]) {
    await assert.rejects(new OpenRouterHonReplyRuntime(approved, async () => ({ status, ok: false })).generate(input), isErr('FAILED', 'PROVIDER_REJECTED'));
  }
  const uncertain = [
    async () => ({ status: 500, ok: false }),
    async () => { throw Error('socket reset'); },
    async () => ok({ model: 'other/model' }),
    async () => ok({ choices: [{ finish_reason: 'length', message: { content: 'cut' } }] }),
    async () => ok({ choices: [] }),
    async () => ok({ usage: { prompt_tokens: 300, completion_tokens: 20 } }),
    async () => ok({ usage: { prompt_tokens: 0, completion_tokens: 20, cost: 0.1 } }),
    async () => ok({ choices: [{ finish_reason: 'stop', message: { content: 'x'.repeat(HON_REPLY_LIMITS.replyCharacters + 1) } }] }),
  ];
  for (const transport of uncertain) {
    let calls = 0;
    await assert.rejects(new OpenRouterHonReplyRuntime(approved, async (...a) => { calls++; return transport(...a); }).generate(input), isErr('UNKNOWN', 'PROVIDER_UNKNOWN'));
    assert.equal(calls, 1);
  }
});

test('HON prompt keeps the owner identities: Kai teaches, Claire is business performance, no actions are claimed', () => {
  assert.match(HON_REPLY_SYSTEM_PROMPT, /Kai, the teaching and curriculum/);
  assert.match(HON_REPLY_SYSTEM_PROMPT, /never call Claire a teaching assistant/);
  assert.match(HON_REPLY_SYSTEM_PROMPT, /cannot take any action/);
  for (const file of ['src/ai/hon-reply-provider-runtime.ts', 'src/hon-conversation/hon-reply.service.ts']) {
    const s = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert(!/invokeLLM|generateText|openai\//i.test(s));
    assert(!/\b(?:send|queue|deliver|refund|discount|payment|membership)\s*\(/i.test(s));
    assert(!/tools\s*:/.test(s));
  }
});
