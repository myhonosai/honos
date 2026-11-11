const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OpenRouterHonReplyRuntime, HonReplyProviderRuntimeError, HON_REPLY_SYSTEM_PROMPT, CLAIRE_ANALYSIS_SYSTEM_PROMPT, splitHonReplyTrailers } = require('../dist/ai/hon-reply-provider-runtime.js');
const contracts = require('@hon/contracts');
const { HON_REPLY_MODES, HON_REPLY_SOURCE_KEYS, HON_REPLY_SOURCE_LABELS, HON_REPLY_MAX_FOLLOW_UPS, HON_REPLY_MAX_SOURCES } = contracts;

// 0254: "Ask next" follow-up questions and "Based on" sources. Model output is presentation data only: closed trailer lines,
// strictly bounded, dropped when bad, never on a cut-off answer, and never able to run or cite anything by itself.

const id = '11111111-1111-4111-8111-111111111111';
const S = HON_REPLY_MODES.STANDARD, D = HON_REPLY_MODES.DETAILED;
const input = { specialist: 'hon', providerId: 'OPENROUTER', modelId: 'approved/test', providerRequestId: id, replyMode: 'STANDARD', step: 1, question: 'How are leads?', facts: '{}',
  inputBudget: S.inputTokens, outputBudget: S.outputTokens, maxCostMicrounits: S.maxProviderCostMicrounits };
const claire = { ...input, specialist: 'claire', replyMode: 'DETAILED', inputBudget: D.inputTokens, outputBudget: D.outputTokens, maxCostMicrounits: D.maxProviderCostMicrounits };
const approved = () => ({ OPENROUTER_API_KEY: 'test-key', OPENROUTER_PAID_CALL_APPROVED: 'true' });
const run = (content, over = {}, finish = 'stop') => new OpenRouterHonReplyRuntime(approved, async () => ({ status: 200, ok: true,
  json: async () => ({ model: 'approved/test', choices: [{ finish_reason: finish, message: { content } }], usage: { prompt_tokens: 300, completion_tokens: 20, cost: 0.000123 } }) })).generate({ ...input, ...over });

test('0254 source keys are a closed set: the Command Center metrics plus earlier conversation and specialist results, each with a label', () => {
  assert.deepEqual([...HON_REPLY_SOURCE_KEYS], ['newLeads24h', 'upcomingTrials24h', 'upcomingTestingEvents30d', 'pendingActionApprovals', 'outstandingWorkItems',
    'membershipTermsEnding30d', 'paidInvoicesCreated30d', 'unansweredInquiries', 'attendanceDecline', 'trialConversion', 'revenue', 'conversation', 'specialistResults', 'schoolNotes']);
  for (const key of HON_REPLY_SOURCE_KEYS) assert.match(HON_REPLY_SOURCE_LABELS[key], /^[A-Z][A-Za-z0-9 ()]+$/);
  assert.equal(HON_REPLY_MAX_FOLLOW_UPS, 3);
  assert.equal(HON_REPLY_MAX_SOURCES, 5);
});

test('0254 trailer lines are peeled from the end in any order, each kind at most once', () => {
  const text = 'Leads are up.\nSOURCES: newLeads24h, conversation\nASK: Which leads are new? | How many trials this week?\nSUGGEST: chad';
  assert.deepEqual(splitHonReplyTrailers(text, 'hon'), { reply: 'Leads are up.', suggestions: ['chad'], followUps: ['Which leads are new?', 'How many trials this week?'], sources: ['newLeads24h', 'conversation'] });
  assert.deepEqual(splitHonReplyTrailers('A.\nSUGGEST: kai\nask: What next?\nsources: revenue', 'hon'), { reply: 'A.', suggestions: ['kai'], followUps: ['What next?'], sources: ['revenue'] });
  // A repeated kind stops peeling: the earlier line stays ordinary text.
  assert.deepEqual(splitHonReplyTrailers('A.\nASK: One more?\nASK: Two more?', 'hon'), { reply: 'A.\nASK: One more?', suggestions: [], followUps: ['Two more?'], sources: [] });
  // Trailer-shaped text above ordinary text is ordinary text.
  assert.deepEqual(splitHonReplyTrailers('ASK: Hidden?\nThe answer.', 'hon'), { reply: 'ASK: Hidden?\nThe answer.', suggestions: [], followUps: [], sources: [] });
  assert.deepEqual(splitHonReplyTrailers('Plain.', 'hon'), { reply: 'Plain.', suggestions: [], followUps: [], sources: [] });
});

test('0254 follow-ups are bounded plain questions: bad items are dropped, never more than three, no repeats ignoring case', () => {
  const ask = (line) => splitHonReplyTrailers(`A.\nASK: ${line}`, 'hon').followUps;
  assert.deepEqual(ask('One? | two? | ONE? | Three? | Four?'), ['One?', 'two?', 'Three?']);
  assert.deepEqual(ask(`ok | ${'x'.repeat(151)} | Visit http://x.example? | See www.example.com | a://b | <b>bold</b> | Tab\there | Fine question?`), ['Fine question?']);
  assert.deepEqual(ask('  |  | '), []);
  assert.equal(ask(`${'y'.repeat(150)}`)[0].length, 150);
  // Counted as code points (as PostgreSQL does) and C1 controls refused, so the API never keeps what the database refuses.
  assert.deepEqual(ask('\u{1F600}? | \u{1F600}ok?'), ['\u{1F600}ok?'], 'an astral character counts once');
  assert.deepEqual(ask(`Next\u0085step? | Fine?`), ['Fine?'], 'U+0085 is a control character');
  assert.equal(contracts.isHonReplyFollowUp('\u{1F600}'.repeat(150)), true);
  assert.equal(contracts.isHonReplyFollowUp('\u{1F600}'.repeat(151)), false);
});

test('0254 sources keep only the closed set, unique, at most five, in order', () => {
  const src = (line) => splitHonReplyTrailers(`A.\nSOURCES: ${line}`, 'hon').sources;
  assert.deepEqual(src('revenue, Revenue, website, studentNames, newLeads24h'), ['revenue', 'newLeads24h']);
  assert.deepEqual(src('newLeads24h, upcomingTrials24h, revenue, trialConversion, conversation, specialistResults'), ['newLeads24h', 'upcomingTrials24h', 'revenue', 'trialConversion', 'conversation']);
});

test('0254 Claire may give follow-ups and sources but never suggestions; her SUGGEST-shaped line stays text', () => {
  assert.deepEqual(splitHonReplyTrailers('Recorded facts: 2 leads.\nSUGGEST: marcus', 'claire'), { reply: 'Recorded facts: 2 leads.\nSUGGEST: marcus', suggestions: [], followUps: [], sources: [] });
  assert.deepEqual(splitHonReplyTrailers('Recorded facts: 2 leads.\nSOURCES: newLeads24h\nASK: What changed?', 'claire'),
    { reply: 'Recorded facts: 2 leads.', suggestions: [], followUps: ['What changed?'], sources: ['newLeads24h'] });
});

test('0254 runtime returns follow-ups and sources for a whole answer and none for a cut-off one', async () => {
  assert.deepEqual(await run('Two new leads.\nSOURCES: newLeads24h\nASK: Who should call them?\nSUGGEST: chad'),
    { reply: 'Two new leads.', inputTokens: 300, outputTokens: 20, providerCostMicrounits: 123, truncated: false, suggestions: ['chad'], followUps: ['Who should call them?'], sources: ['newLeads24h'] });
  const cut = await run('Part one\nSOURCES: newLeads24h\nASK: More?', {}, 'length');
  assert.deepEqual([cut.reply, cut.followUps, cut.sources, cut.suggestions], ['Part one\nSOURCES: newLeads24h\nASK: More?', [], [], []]);
  assert.deepEqual((await run('Recorded facts: 1.\nASK: Why?', claire)).followUps, ['Why?']);
  // An answer that is only trailer lines has no answer: never recorded as complete.
  await assert.rejects(run('SOURCES: revenue\nASK: Why?'), (e) => e instanceof HonReplyProviderRuntimeError && e.outcome === 'UNKNOWN');
});

test('0254 prompts describe both optional lines with the closed source keys; facts rules are unchanged', () => {
  for (const prompt of [HON_REPLY_SYSTEM_PROMPT, CLAIRE_ANALYSIS_SYSTEM_PROMPT]) {
    assert.match(prompt, /SOURCES: /);
    assert.match(prompt, /ASK: /);
    for (const key of HON_REPLY_SOURCE_KEYS) assert.ok(prompt.includes(key), key);
    assert.match(prompt, /never invent numbers/);
  }
});

const ID = () => require('node:crypto').randomUUID();
const detail = { mode: 'STANDARD', step: 1, maxSteps: 3, truncated: false, canContinue: false, continuesTurnId: null, suggestions: [], followUps: [], sources: [] };
const q = { turnId: ID(), conversationId: ID(), status: 'COMPLETED', reason: null, delegatedAgentKeys: [], actionRequestIds: [], workItemIds: [ID()], invocationId: ID(), reply: 'Two leads.', replyDetail: detail };

test('0254 contract: replyDetail carries follow-ups and sources only on a whole, shown, completed answer', () => {
  const full = { ...detail, followUps: ['Who calls them?', 'What about trials?'], sources: ['newLeads24h', 'conversation'] };
  assert.deepEqual(contracts.validateHonTurnReceipt({ ...q, replyDetail: full }).replyDetail, full);
  for (const bad of [
    { ...detail, followUps: undefined }, { ...detail, sources: undefined },
    { ...detail, followUps: ['a', 'b', 'c', 'd'].map((x) => `${x} question?`) }, { ...detail, followUps: ['Hi'] }, { ...detail, followUps: ['x'.repeat(151)] },
    { ...detail, followUps: ['Line\nbreak?'] }, { ...detail, followUps: ['Same?', 'same?'] }, { ...detail, followUps: ['See http://x?'] }, { ...detail, followUps: 'Why?' },
    { ...detail, sources: ['website'] }, { ...detail, sources: ['revenue', 'revenue'] }, { ...detail, sources: ['newLeads24h', 'upcomingTrials24h', 'revenue', 'trialConversion', 'conversation', 'specialistResults'] },
    { ...detail, mode: 'DETAILED', truncated: true, canContinue: true, followUps: ['More?'] }, { ...detail, mode: 'DETAILED', truncated: true, canContinue: true, sources: ['revenue'] },
  ]) assert.throws(() => contracts.validateHonTurnReceipt({ ...q, replyDetail: bad }), undefined, JSON.stringify(bad));
  assert.throws(() => contracts.validateHonTurnReceipt({ ...q, reason: 'RESULT_CONCEALED', reply: null, replyDetail: { ...detail, followUps: ['Why?'] } }));
  assert.throws(() => contracts.validateHonTurnReceipt({ ...q, status: 'PROCESSING', reply: null, replyDetail: { ...detail, sources: ['revenue'] } }));
  // Claire's analysis may carry them too (never suggestions).
  const c = { ...q, delegatedAgentKeys: ['claire'], replyDetail: { ...detail, mode: 'DETAILED', followUps: ['Why?'], sources: ['revenue'] } };
  assert.deepEqual(contracts.validateHonTurnReceipt(c).replyDetail.followUps, ['Why?']);
});
