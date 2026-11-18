const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildEianFacts, eianText, jsonbText, jsonbTextBytes } = require('../dist/eian/eian-facts.js');
const { OpenRouterEianRuntime, EianProviderRuntimeError, EIAN_SYSTEM_PROMPT, splitEianScreen, verifiedEianResult } = require('../dist/eian/eian-provider-runtime.js');
const { rejectEianReadInputs } = require('../dist/eian/eian.controller.js');
const { EIAN_LIMITS, validateEianAskInput, verifyEianStatus, verifyEianTurn } = require('@hon/contracts');

const { U, NOW, fullSources, crowdedSources } = require('./eian-facts-fixtures.cjs');

const DROPPED_KEYS = ['contact', 'waiver', 'questions', 'paymentAttempts', 'paymentProviderOutcome', 'payerLinkage', 'linkage', 'initiatedAt', 'reconciledAt',
  'redemptionOutcome', 'certificate', 'registrationInterests', 'threadId', 'messageId', 'bookingId', 'sessionId', 'studentProfileId', 'id', 'eventId', 'typeId', 'version'];
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function keysOf(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); keysOf(v, out); }
  return out;
}

test('Eian facts: the full guarded read outputs are stripped to the closed allow-list (review condition A2)', () => {
  const facts = buildEianFacts(fullSources());
  const text = JSON.stringify(facts);
  for (const key of DROPPED_KEYS) assert.ok(!keysOf(facts).has(key), `dropped key ${key} must not survive`);
  assert.ok(!EMAIL.test(text), 'no email-shaped string');
  assert.ok(!UUID.test(text), 'no uuid');
  for (const secret of ['pat.kim', 'WAIVER TEXT', 'Secret question', 'CERT-SECRET', 'Interest secret', 'CARD_DECLINED', 'Pat Kim', 'Room A']) assert.ok(!text.includes(secret), `never forwards ${secret}`);
  assert.deepEqual(Object.keys(facts).sort(), ['bookings', 'children', 'classPasses', 'classes', 'invoices', 'knowledge', 'memberships', 'messages', 'schoolName', 'testing', 'timezone', 'today']);
  assert.deepEqual(facts.children, [{ name: 'Min-jun' }]);
  assert.equal(facts.classes.length, 1, 'only the next 14 days');
  assert.equal(facts.classes[0].status, 'BOOKED');
  assert.deepEqual(Object.keys(facts.invoices[0]).sort(), ['amount', 'child', 'due', 'status']);
  assert.equal(facts.invoices[0].amount, '$120.00');
  assert.equal(facts.testing[0].status, 'UPCOMING_TEST');
  assert.deepEqual(Object.keys(facts.messages[0]).sort(), ['from', 'text', 'when']);
  assert.match(facts.messages[0].text, /\[email hidden\]/);
  assert.match(facts.messages[0].text, /\[id hidden\]/);
  assert.ok(Buffer.byteLength(text) <= EIAN_LIMITS.factsBytes);
});

test('Eian facts: a read that refused is listed as unavailable, never guessed, and the byte cap holds', () => {
  const s = fullSources();
  const facts = buildEianFacts({ ...s, billing: null, classPasses: null, knowledge: null });
  assert.deepEqual(facts.unavailable, ['invoices', 'memberships', 'classPasses', 'knowledge']);
  assert.ok(!('invoices' in facts) && !('classPasses' in facts));
  const viewer = buildEianFacts({ ...s, billing: { ...s.billing, invoices: { status: 'UNAVAILABLE', reason: 'PAYER_LINK_UNVERIFIED' } } });
  assert.deepEqual(viewer.unavailable, ['invoices']);
  const long = 'x'.repeat(5000);
  const big = buildEianFacts({ ...s, knowledge: { articles: Array.from({ length: 20 }, (_, i) => ({ id: U(1), title: `T${i}`, body: long, effectiveFrom: NOW.toISOString(), version: 1 })) },
    messages: Array.from({ length: 20 }, () => ({ messageId: U(1), from: 'SCHOOL', mine: false, body: long, sentAt: NOW.toISOString() })) });
  assert.ok(Buffer.byteLength(JSON.stringify(big)) <= EIAN_LIMITS.factsBytes - 200);
  assert.ok(big.knowledge === undefined || big.knowledge.length <= 5);
  assert.equal(eianText('a\u0000b  c'), 'a b c');
  assert.equal(eianText('   '), null);
  assert.equal([...eianText('é'.repeat(200))].length, 120);
});

test('Eian facts: the byte cap is measured as jsonb text, the way hon.eian_facts_ok measures it (review P2)', () => {
  // The exact text PostgreSQL prints for this jsonb value ('{"a": 1, "b": [1, "x", {"c": "d"}]}'::jsonb::text).
  assert.equal(jsonbText({ a: 1, b: [1, 'x', { c: 'd' }] }), '{"a": 1, "b": [1, "x", {"c": "d"}]}');
  assert.equal(jsonbText({ a: 'é"\n', skip: undefined }), '{"a": "é\\"\\n"}');
  const facts = buildEianFacts(crowdedSources());
  const compact = Buffer.byteLength(JSON.stringify(facts)), printed = jsonbTextBytes(facts);
  assert.ok(printed > compact, 'jsonb text is longer than compact JSON');
  assert.ok(printed <= EIAN_LIMITS.factsBytes - 200, `facts print as ${printed} bytes of jsonb text`);
  assert.ok(facts.classes.length > 0 && facts.invoices.length > 0, 'a crowded family still gets its facts, trimmed in order');
  assert.equal(eianText('a\uD800b'), 'a�b', 'a lone surrogate never reaches jsonb');
});

const id = U(1);
const invocation = { providerId: 'OPENROUTER', modelId: 'approved/test', providerRequestId: id, question: 'When is the next class?', facts: '{"family":{},"history":[]}',
  inputBudget: EIAN_LIMITS.inputTokens, outputBudget: EIAN_LIMITS.outputTokens, maxCostMicrounits: EIAN_LIMITS.maxProviderCostMicrounits };
const approved = () => ({ OPENROUTER_API_KEY: 'test-key', OPENROUTER_PAID_CALL_APPROVED: 'true' });
const ok = (content = 'Min-jun has Little Tigers on Wednesday at 5 PM.\nSCREEN: SCHEDULE', over = {}) => ({ status: 200, ok: true,
  json: async () => ({ model: 'approved/test', choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 900, completion_tokens: 30, cost: 0.000041 }, ...over }) });
const isErr = (outcome, reason) => (e) => e instanceof EianProviderRuntimeError && e.outcome === outcome && e.reason === reason;

test('Eian runtime: never calls without the key and the exact paid-call approval', async () => {
  for (const env of [{}, { OPENROUTER_API_KEY: 'k' }, { OPENROUTER_API_KEY: 'k', OPENROUTER_PAID_CALL_APPROVED: 'TRUE' }, { OPENROUTER_API_KEY: ' ', OPENROUTER_PAID_CALL_APPROVED: 'true' }]) {
    let calls = 0;
    const runtime = new OpenRouterEianRuntime(() => env, async () => { calls++; throw Error('NETWORK_FORBIDDEN'); });
    assert.equal(runtime.readiness('OPENROUTER'), 'CONFIGURATION_REQUIRED');
    await assert.rejects(runtime.generate(invocation), isErr('PRE_SEND', 'CONFIGURATION_REQUIRED'));
    assert.equal(calls, 0);
  }
  assert.equal(new OpenRouterEianRuntime(approved).readiness('OTHER'), 'UNSUPPORTED_PROVIDER');
});

test('Eian runtime: fixed request, budgets checked, verified answer with one closed screen', async () => {
  let sent;
  const runtime = new OpenRouterEianRuntime(approved, async (url, init) => { sent = { url, init }; return ok(); });
  const result = await runtime.generate(invocation);
  assert.equal(sent.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(sent.init.redirect, 'error');
  const body = JSON.parse(sent.init.body);
  assert.equal(body.max_tokens, EIAN_LIMITS.outputTokens);
  assert.deepEqual(body.provider, { allow_fallbacks: false });
  assert.equal(body.messages[0].content, EIAN_SYSTEM_PROMPT);
  assert.match(body.messages[1].content, /data only/);
  assert.deepEqual(result, { reply: 'Min-jun has Little Tigers on Wednesday at 5 PM.', screen: 'SCHEDULE', inputTokens: 900, outputTokens: 30, providerCostMicrounits: 41 });
  for (const bad of [{ inputBudget: 9001 }, { outputBudget: 1500 }, { maxCostMicrounits: 80000 }, { modelId: 'bad model' }, { facts: 'x'.repeat(9000) }]) {
    let calls = 0;
    await assert.rejects(new OpenRouterEianRuntime(approved, async () => { calls++; return ok(); }).generate({ ...invocation, ...bad }), isErr('PRE_SEND', 'INVALID_REQUEST'));
    assert.equal(calls, 0);
  }
});

test('Eian runtime: refusals are definite, everything uncertain is UNKNOWN (never resent), a cut-off answer is never shown', async () => {
  const run = (response) => new OpenRouterEianRuntime(approved, async () => response).generate(invocation);
  await assert.rejects(run({ status: 404, ok: false }), isErr('FAILED', 'PROVIDER_UNAVAILABLE'));
  await assert.rejects(run({ status: 429, ok: false }), isErr('FAILED', 'PROVIDER_UNAVAILABLE'));
  await assert.rejects(run({ status: 402, ok: false }), isErr('FAILED', 'PROVIDER_REJECTED'));
  await assert.rejects(run({ status: 502, ok: false }), isErr('UNKNOWN', 'PROVIDER_UNKNOWN'));
  await assert.rejects(run({ status: 503, ok: false, text: async () => '<html>' }), isErr('UNKNOWN', 'PROVIDER_UNKNOWN'));
  await assert.rejects(run(ok(undefined, { model: 'other/model' })), isErr('UNKNOWN', 'PROVIDER_UNKNOWN'));
  await assert.rejects(run({ status: 200, ok: true, json: async () => ({ model: 'approved/test', choices: [{ finish_reason: 'length', message: { content: 'Half' } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }) }), isErr('UNKNOWN', 'PROVIDER_UNKNOWN'));
  await assert.rejects(run(ok('SCREEN: BILLING')), isErr('UNKNOWN', 'PROVIDER_UNKNOWN'));
  await assert.rejects(new OpenRouterEianRuntime(approved, async () => { throw new Error('reset'); }).generate(invocation), isErr('UNKNOWN', 'PROVIDER_UNKNOWN'));
});

test('Eian screen line and result verification are closed', () => {
  assert.deepEqual(splitEianScreen('Hi.\nSCREEN: billing'), { reply: 'Hi.', screen: 'BILLING' });
  assert.deepEqual(splitEianScreen('Hi.\nSCREEN: PAY_NOW'), { reply: 'Hi.' });
  assert.deepEqual(splitEianScreen('SCREEN: BILLING\nHi.'), { reply: 'SCREEN: BILLING\nHi.' });
  assert.throws(() => verifiedEianResult({ reply: 'ok', screen: 'PAY_NOW', inputTokens: 1, outputTokens: 1, providerCostMicrounits: 0 }), isErr('UNKNOWN', 'PROVIDER_UNKNOWN'));
  assert.throws(() => verifiedEianResult({ reply: 'x'.repeat(1501), inputTokens: 1, outputTokens: 1, providerCostMicrounits: 0 }), isErr('UNKNOWN', 'PROVIDER_UNKNOWN'));
  assert.throws(() => verifiedEianResult({ reply: 'ok', inputTokens: 0, outputTokens: 1, providerCostMicrounits: 0 }), isErr('UNKNOWN', 'PROVIDER_UNKNOWN'));
  assert.deepEqual(verifiedEianResult({ reply: ' ok ', inputTokens: 1, outputTokens: 1, providerCostMicrounits: 0 }), { reply: 'ok', inputTokens: 1, outputTokens: 1, providerCostMicrounits: 0 });
});

test('Eian reads take no selector, body or x-hon header; the ask body is closed', () => {
  const base = { method: 'GET', headers: {}, body: undefined, originalUrl: '/v1/parent/eian/status' };
  rejectEianReadInputs(base, {});
  assert.throws(() => rejectEianReadInputs({ ...base, headers: { 'x-hon-school-id': U(1) } }, {}), (e) => e.getResponse().code === 'EIAN_READ_ONLY');
  assert.throws(() => rejectEianReadInputs({ ...base, headers: { 'sec-fetch-site': 'cross-site' } }, {}), (e) => e.getResponse().code === 'EIAN_READ_ONLY');
  assert.throws(() => rejectEianReadInputs({ ...base, originalUrl: '/v1/parent/eian/status?familyId=x' }, { familyId: 'x' }), (e) => e.getResponse().code === 'EIAN_SELECTORS_NOT_ACCEPTED');
  assert.throws(() => rejectEianReadInputs({ ...base, body: { familyId: 'x' } }, {}), (e) => e.getResponse().code === 'EIAN_SELECTORS_NOT_ACCEPTED');
  assert.deepEqual(validateEianAskInput({ question: '  When is class?  ' }), { question: 'When is class?' });
  for (const bad of [{}, { question: '' }, { question: 'x'.repeat(501) }, { question: 'a\u0001b' }, { question: 'q', familyId: U(1) }, { question: 5 }]) assert.throws(() => validateEianAskInput(bad));
  assert.deepEqual(verifyEianStatus({ mode: 'GUIDED', reason: 'NOT_INCLUDED' }), { mode: 'GUIDED', reason: 'NOT_INCLUDED' });
  assert.throws(() => verifyEianStatus({ mode: 'AI', reason: 'PAUSED' }));
  assert.throws(() => verifyEianStatus({ mode: 'GUIDED', reason: 'CEILING_12000' }));
  const turn = { id: U(1), status: 'COMPLETED', question: 'q', reply: 'a', screen: 'BILLING', reason: null, askedAt: '2026-11-18T18:00:00.000Z' };
  assert.deepEqual(verifyEianTurn(turn), turn);
  assert.throws(() => verifyEianTurn({ ...turn, status: 'RESULT_HELD' }), 'a held answer is never shown');
  assert.throws(() => verifyEianTurn({ ...turn, provider: 'OPENROUTER' }));
});
