const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OpenRouterPaperVisionRuntime, PaperVisionRuntimeError, PAPER_READING_SYSTEM_PROMPT } = require('../dist/ai/paper-vision-runtime.js');
const { parsePaperReadingAnswer, paperImportColumns, verifyPaperImportDetail, PAPER_READING_AI_LIMITS } = require('@hon/contracts');

// 0389: the OpenRouter reader for paper import photos, against a fake transport only. The database flow (plan, claim,
// usage, one reading per set) is proven by packages/database/scripts/test-paper-import-ai-reader.mjs.
const id = '11111111-1111-4111-8111-111111111111';
const env = () => ({ OPENROUTER_API_KEY: 'unit-only-not-a-secret', OPENROUTER_PAID_CALL_APPROVED: 'true' });
const page = { mediaType: 'image/png', data: Buffer.from('synthetic page bytes').toString('base64') };
const input = { providerId: 'OPENROUTER', modelId: 'approved/vision', providerRequestId: id, inputBudget: 40000, outputBudget: 16000, maxCostMicrounits: 250000,
  kind: 'STUDENT_CARDS', columns: paperImportColumns('STUDENT_CARDS'), pages: [page, { mediaType: 'image/jpeg', data: page.data }] };
const table = { rows: [paperImportColumns('STUDENT_CARDS').map((c, i) => (i === 0 ? 'Aria' : ''))], unsure: [paperImportColumns('STUDENT_CARDS').map(() => false)] };
const ok = (content, extra = {}) => ({ model: input.modelId, choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 9000, completion_tokens: 600, cost: 0.021 }, ...extra });
const response = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('the paper reader needs the key and the paid-call approval, and sends nothing otherwise', async () => {
  for (const e of [{}, { OPENROUTER_PAID_CALL_APPROVED: 'true' }, { OPENROUTER_API_KEY: 'unit-only-not-a-secret' }, { OPENROUTER_API_KEY: 'k', OPENROUTER_PAID_CALL_APPROVED: 'yes' }]) {
    let calls = 0; const rt = new OpenRouterPaperVisionRuntime(() => e, async () => { calls++; throw Error('NO NETWORK'); });
    assert.equal(rt.readiness('OPENROUTER'), 'CONFIGURATION_REQUIRED');
    await assert.rejects(rt.read(input), (x) => x.outcome === 'PRE_SEND' && x.reason === 'CONFIGURATION_REQUIRED'); assert.equal(calls, 0);
  }
  assert.equal(new OpenRouterPaperVisionRuntime(env).readiness('OTHER'), 'UNSUPPORTED_PROVIDER');
  await assert.rejects(new OpenRouterPaperVisionRuntime(env, async () => { throw Error('x'); }).read({ ...input, providerId: 'OTHER' }), (x) => x.reason === 'UNSUPPORTED_PROVIDER');
});

test('one fixed request: the pages as image data URLs, the kind and columns as text, no tools, no fallbacks, the plan budgets', async () => {
  let calls = 0; const rt = new OpenRouterPaperVisionRuntime(env, async (url, o) => {
    calls++; assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions'); assert.equal(o.redirect, 'error'); assert.equal(o.headers['Idempotency-Key'], id);
    const body = JSON.parse(o.body);
    assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'provider', 'response_format', 'stream', 'temperature']);
    assert.equal(body.model, 'approved/vision'); assert.equal(body.max_tokens, 16000); assert.equal(body.temperature, 0); assert.equal(body.stream, false);
    assert.deepEqual(body.provider, { allow_fallbacks: false }); assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.messages.length, 2); assert.equal(body.messages[0].content, PAPER_READING_SYSTEM_PROMPT);
    const [text, ...images] = body.messages[1].content;
    assert.equal(text.type, 'text'); assert.deepEqual(JSON.parse(text.text).columns, input.columns); assert.match(JSON.parse(text.text).kind, /student cards/);
    assert.deepEqual(images, [{ type: 'image_url', image_url: { url: `data:image/png;base64,${page.data}` } }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${page.data}` } }]);
    return response(ok(JSON.stringify(table)));
  });
  assert.deepEqual(await rt.read(input), { answer: table, inputTokens: 9000, outputTokens: 600, providerCostMicrounits: 21000 }); assert.equal(calls, 1);
  assert.match(PAPER_READING_SYSTEM_PROMPT, /untrusted content/); assert.match(PAPER_READING_SYSTEM_PROMPT, /Never guess, complete or invent/);
  for (const patch of [{ inputBudget: 16000 }, { outputBudget: 8000 }, { maxCostMicrounits: 1000000 }, { modelId: '../x' }, { kind: 'PASSPORTS' }, { columns: [] }, { columns: ['a b'] },
    { pages: [] }, { pages: Array(11).fill(page) }, { pages: [{ mediaType: 'image/gif', data: page.data }] }, { pages: [{ mediaType: 'image/png', data: 'not base64!' }] }]) {
    let sent = 0; await assert.rejects(new OpenRouterPaperVisionRuntime(env, async () => { sent++; }).read({ ...input, ...patch }), (x) => x.outcome === 'PRE_SEND' && x.reason === 'INVALID_REQUEST'); assert.equal(sent, 0);
  }
  assert.deepEqual(PAPER_READING_AI_LIMITS, { inputTokens: 40000, outputTokens: 16000, maxProviderCostMicrounits: 250000 });
});

test('a paid answer that is not JSON or was cut short keeps its usage (answer null); transport doubt is UNKNOWN; refusals are FAILED', async () => {
  for (const r of [ok('not json'), { ...ok(JSON.stringify(table)), choices: [{ finish_reason: 'length', message: { content: '{"rows":' } }] }]) {
    const out = await new OpenRouterPaperVisionRuntime(env, async () => response(r)).read(input);
    assert.equal(out.answer, null); assert.equal(out.inputTokens, 9000);
  }
  for (const t of [async () => { throw Error('socket'); }, async () => new Response('x', { status: 503 }), async () => response(ok('{}', { model: 'swapped' })),
    async () => response({ ...ok('{}'), usage: { prompt_tokens: 1, completion_tokens: 1 } }), async () => new Response('x'.repeat(300000))]) {
    let calls = 0; await assert.rejects(new OpenRouterPaperVisionRuntime(env, async (...a) => { calls++; return t(...a); }).read(input), (x) => x instanceof PaperVisionRuntimeError && x.outcome === 'UNKNOWN'); assert.equal(calls, 1);
  }
  for (const s of [400, 402, 413, 429]) await assert.rejects(new OpenRouterPaperVisionRuntime(env, async () => new Response('', { status: s })).read(input), (x) => x.outcome === 'FAILED' && x.reason === 'PROVIDER_REJECTED');
});

test('the answer parser keeps exactly the import columns: trims, blanks what is not plain text, drops empty rows, never guesses', () => {
  const cols = paperImportColumns('ATTENDANCE_SHEETS');
  const blank = cols.map(() => ''), no = cols.map(() => false);
  assert.deepEqual(parsePaperReadingAnswer('ATTENDANCE_SHEETS', { rows: [[' Mina ', 'Park\n', '', '2026-11-02', '1', 'Kids  Class'], blank], unsure: [no, no] }),
    { rows: [['Mina', 'Park', '', '2026-11-02', '1', 'Kids Class']], unsure: [no] });
  const bad = parsePaperReadingAnswer('ATTENDANCE_SHEETS', { rows: [['x'.repeat(201), 'B‮', '', '', '', 'ok']], unsure: [no] });
  assert.deepEqual(bad, { rows: [['', '', '', '', '', 'ok']], unsure: [[true, true, false, false, false, false]] });
  for (const v of [null, 'text', [], {}, { rows: [], unsure: [], extra: 1 }, { rows: [['a']], unsure: [[false]] }, { rows: [cols.map(() => 1)], unsure: [no] },
    { rows: [blank], unsure: [cols.map(() => 'no')] }, { rows: Array(201).fill(cols.map(() => 'a')), unsure: Array(201).fill(no) }, { rows: [blank], unsure: [] }]) {
    assert.equal(parsePaperReadingAnswer('ATTENDANCE_SHEETS', v), null, JSON.stringify(v).slice(0, 80));
  }
});

test('the set detail carries HON\'s reading state, and reader and outcome come in closed pairs', () => {
  const set = (reader, readOutcome) => ({ id, kind: 'STUDENT_CARDS', target: 'STUDENTS', version: 3, status: 'READ', pageCount: 0, reader, readOutcome, sentBatchId: null,
    createdAt: '2026-11-16T00:00:00.000Z', expiresAt: '2026-12-16T00:00:00.000Z', readAt: '2026-11-16T00:00:00.000Z', sentAt: null, deletedAt: null, deleteReason: null });
  const detail = (s, aiReading = null) => ({ set: s, columns: [...paperImportColumns('STUDENT_CARDS')], rows: [], unsure: [], pages: [], aiReading });
  for (const [r, o] of [['AI_ROUTE', 'AI_READ'], ['AI_ROUTE', 'NOT_READABLE'], ['NONE', 'TYPED'], ['SYNTHETIC', 'SAMPLE_READ']]) assert.ok(verifyPaperImportDetail(detail(set(r, o))));
  for (const [r, o] of [['NONE', 'AI_READ'], ['SYNTHETIC', 'TYPED'], ['AI_ROUTE', 'SAMPLE_READ'], ['ROBOT', 'AI_READ']]) assert.throws(() => verifyPaperImportDetail(detail(set(r, o))));
  assert.ok(verifyPaperImportDetail(detail(set('AI_ROUTE', 'AI_READ'), { status: 'APPLIED', reason: null })));
  assert.ok(verifyPaperImportDetail(detail(set('NONE', 'TYPED'), { status: 'UNKNOWN', reason: 'PROVIDER_UNKNOWN' })));
  for (const bad of [{ status: 'DONE', reason: null }, { status: 'BLOCKED', reason: 'BECAUSE' }, { status: 'BLOCKED' }, { status: 'BLOCKED', reason: null, rows: [] }]) {
    assert.throws(() => verifyPaperImportDetail(detail(set('NONE', 'TYPED'), bad)));
  }
  const { aiReading, ...old } = detail(set('NONE', 'TYPED'));
  assert.throws(() => verifyPaperImportDetail(old), 'the reading state is always present');
});
