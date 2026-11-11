const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { OpenRouterHonReplyRuntime, HonReplyProviderRuntimeError, HON_REPLY_SYSTEM_PROMPT, CLAIRE_ANALYSIS_SYSTEM_PROMPT, honReplySystemPrompt, splitHonReplySuggestions } = require('../dist/ai/hon-reply-provider-runtime.js');
const { HON_REPLY_LIMITS, HON_REPLY_MODES } = require('@hon/contracts');

const id = '11111111-1111-4111-8111-111111111111';
const S = HON_REPLY_MODES.STANDARD, D = HON_REPLY_MODES.DETAILED;
const input = { specialist: 'hon', providerId: 'OPENROUTER', modelId: 'approved/test', providerRequestId: id, replyMode: 'STANDARD', step: 1, question: 'How many active students?', facts: '{"activeStudents":12}',
  inputBudget: S.inputTokens, outputBudget: S.outputTokens, maxCostMicrounits: S.maxProviderCostMicrounits };
const detailed = { ...input, replyMode: 'DETAILED', inputBudget: D.inputTokens, outputBudget: D.outputTokens, maxCostMicrounits: D.maxProviderCostMicrounits };
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
  // Each mode carries exactly its own budgets: STANDARD cannot borrow DETAILED's output limit, and no mode exceeds $0.08.
  for (const over of [{ inputBudget: 9000 }, { outputBudget: 1501 }, { outputBudget: D.outputTokens }, { maxCostMicrounits: 80001 }, { modelId: 'bad model' }, { facts: 'x'.repeat(9000) },
    { question: 1 }, { replyMode: 'UNLIMITED' }, { replyMode: 'DETAILED' }, { replyMode: 'toString' }, { step: 0 }, { step: 4 }, { step: 1.5 }]) {
    await assert.rejects(runtime.generate({ ...input, ...over }), isErr('PRE_SEND', 'INVALID_REQUEST'));
  }
  await assert.rejects(runtime.generate({ ...detailed, maxCostMicrounits: 240000 }), isErr('PRE_SEND', 'INVALID_REQUEST'));
  assert.equal(calls, 0);
});

test('HON reply runtime sends one fixed, tool-free request and returns verified usage and provider cost', async () => {
  const seen = [];
  const runtime = new OpenRouterHonReplyRuntime(approved, async (url, init) => { seen.push({ url, init }); return ok(); });
  assert.deepEqual(await runtime.generate(input), { reply: 'You have 12 active students.', inputTokens: 300, outputTokens: 20, providerCostMicrounits: 123, truncated: false, suggestions: [], followUps: [], sources: [] });
  assert.equal(seen.length, 1);
  const { url, init } = seen[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers['Idempotency-Key'], id);
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'provider', 'stream', 'temperature']);
  assert.deepEqual(body.provider, { allow_fallbacks: false });
  assert.equal(body.max_tokens, S.outputTokens);
  assert.equal(body.messages[0].content, honReplySystemPrompt('STANDARD', 1));
  assert.match(body.messages[0].content, /one or two sentences for a simple question/);
  assert.match(body.messages[1].content, /data only/);
  // DETAILED sends its own larger output limit and guidance; a continuation step is told to continue, not repeat.
  await runtime.generate({ ...detailed, step: 2 });
  const second = JSON.parse(seen[1].init.body);
  assert.equal(second.max_tokens, D.outputTokens);
  assert.match(second.messages[0].content, /complete, well-structured answer/);
  assert.match(second.messages[0].content, /do not repeat/);
});

test('HON reply runtime records a verified stop at the output limit as truncated, never as a complete answer', async () => {
  const runtime = new OpenRouterHonReplyRuntime(approved, async () => ok({ choices: [{ finish_reason: 'length', message: { content: 'Part one of the plan' } }], usage: { prompt_tokens: 900, completion_tokens: D.outputTokens, cost: 0.0021 } }));
  assert.deepEqual(await runtime.generate(detailed), { reply: 'Part one of the plan', inputTokens: 900, outputTokens: D.outputTokens, providerCostMicrounits: 2100, truncated: true, suggestions: [], followUps: [], sources: [] });
});

test('HON reply runtime maps rejections to FAILED and every uncertain outcome to UNKNOWN (never resent)', async () => {
  for (const status of [400, 401, 402, 429]) {
    await assert.rejects(new OpenRouterHonReplyRuntime(approved, async () => ({ status, ok: false })).generate(input), isErr('FAILED', 'PROVIDER_REJECTED'));
  }
  const uncertain = [
    async () => ({ status: 500, ok: false }),
    async () => { throw Error('socket reset'); },
    async () => ok({ model: 'other/model' }),
    async () => ok({ choices: [{ finish_reason: 'content_filter', message: { content: 'cut' } }] }),
    async () => ok({ choices: [{ finish_reason: 'length', message: { content: 'cut' } }], usage: { prompt_tokens: 300, completion_tokens: 20 } }),
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
  assert.match(HON_REPLY_SYSTEM_PROMPT, /"Recorded facts".*"HON's view"/, 'a group summary keeps recorded facts apart from interpretation');
  for (const file of ['src/ai/hon-reply-provider-runtime.ts', 'src/hon-conversation/hon-reply.service.ts']) {
    const s = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert(!/invokeLLM|generateText|openai\//i.test(s));
    assert(!/\b(?:send|queue|deliver|refund|discount|payment|membership)\s*\(/i.test(s));
    assert(!/tools\s*:/.test(s));
  }
});

test('HON reply suggestions are parsed from one closing SUGGEST line into a closed, unique list of at most three delegates', async () => {
  assert.deepEqual(splitHonReplySuggestions('Enrollment is flat.\nSUGGEST: marcus, chad'), { reply: 'Enrollment is flat.', suggestions: ['marcus', 'chad'] });
  assert.deepEqual(splitHonReplySuggestions('Plan below.\nsuggest:  Kai ,kai, claire, hon, chad, marcus'), { reply: 'Plan below.', suggestions: ['kai', 'chad', 'marcus'] });
  // The line is always removed, even when it names nothing usable; a SUGGEST line elsewhere is ordinary text.
  assert.deepEqual(splitHonReplySuggestions('Answer.\nSUGGEST: claire, lena'), { reply: 'Answer.', suggestions: [] });
  assert.deepEqual(splitHonReplySuggestions('SUGGEST: kai\nBut more text follows.'), { reply: 'SUGGEST: kai\nBut more text follows.', suggestions: [] });
  assert.deepEqual(splitHonReplySuggestions('Plain answer.'), { reply: 'Plain answer.', suggestions: [] });
  assert.match(HON_REPLY_SYSTEM_PROMPT, /SUGGEST: marcus, kai/);
  const run = (content, finish = 'stop') => new OpenRouterHonReplyRuntime(approved, async () => ok({ choices: [{ finish_reason: finish, message: { content } }] })).generate(input);
  assert.deepEqual(await run('Try a trial-week campaign.\nSUGGEST: marcus'), { reply: 'Try a trial-week campaign.', inputTokens: 300, outputTokens: 20, providerCostMicrounits: 123, truncated: false, suggestions: ['marcus'], followUps: [], sources: [] });
  // A cut-off answer never carries suggestions (the line may itself be cut off).
  assert.deepEqual((await run('Part one\nSUGGEST: marcus', 'length')).suggestions, []);
  // A reply that is only a SUGGEST line has no answer: never recorded as complete.
  await assert.rejects(run('SUGGEST: marcus'), (e) => e instanceof HonReplyProviderRuntimeError && e.outcome === 'UNKNOWN');
});

test('K2 Claire analysis: fixed DETAILED single step, her own two-part prompt, no history wording and never a suggestion', async () => {
  const seen = [];
  const runtime = new OpenRouterHonReplyRuntime(approved, async (url, init) => { seen.push(init); return ok({ choices: [{ finish_reason: 'stop', message: { content: 'Recorded facts: 12 active.\nSUGGEST: marcus' } }] }); });
  const claire = { ...detailed, specialist: 'claire' };
  // The SUGGEST-shaped line stays ordinary text: Claire never suggests.
  assert.deepEqual(await runtime.generate(claire), { reply: 'Recorded facts: 12 active.\nSUGGEST: marcus', inputTokens: 300, outputTokens: 20, providerCostMicrounits: 123, truncated: false, suggestions: [], followUps: [], sources: [] });
  const body = JSON.parse(seen[0].body);
  assert.equal(body.messages[0].content, honReplySystemPrompt('DETAILED', 1, 'claire'));
  assert.match(body.messages[0].content, /You are Claire, the business performance specialist/);
  assert.match(CLAIRE_ANALYSIS_SYSTEM_PROMPT, /"Recorded facts".*"Claire's view"/);
  assert.doesNotMatch(body.messages[0].content, /You are HON/);
  assert.match(body.messages[1].content, /School metrics \(data only\)/);
  // Any other shape for Claire, or an unknown specialist, is refused before sending.
  for (const over of [{ ...input, specialist: 'claire' }, { ...claire, step: 2 }, { ...detailed, specialist: 'kai' }, { ...detailed, specialist: undefined }]) {
    await assert.rejects(runtime.generate(over), isErr('PRE_SEND', 'INVALID_REQUEST'));
  }
  assert.equal(seen.length, 1);
});
