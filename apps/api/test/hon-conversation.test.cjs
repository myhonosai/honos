const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { ForbiddenException, BadRequestException, ServiceUnavailableException } = require('@nestjs/common');
const { Test } = require('@nestjs/testing');
const { HonConversationController, HonConversationService, HonConversationHumanUiGuard } = require('../dist/hon-conversation/hon-conversation.controller.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { MarketingAssistantService } = require('../dist/marketing/marketing-assistant.service.js');
const { TeachingAssistantService } = require('../dist/teaching-assistant/teaching-assistant.service.js');
const { ChadFollowUpAssistantService } = require('../dist/chad-follow-up-assistant/chad-follow-up-assistant.service.js');
const { AiTeamReadinessService } = require('../dist/ai-team/ai-team-readiness.controller.js');
const contracts = require('@hon/contracts');

const ORG = randomUUID(), SCHOOL = randomUUID(), PRINCIPAL = randomUUID(), T = '2026-11-02T00:00:00.000Z';
const ID = () => randomUUID();

test('C1 contracts: one named specialist with its own target; receipts and threads are closed and consistent', () => {
  const campaignId = ID(), curriculumId = ID(), leadId = ID();
  assert.deepEqual(contracts.validateHonTurnRequest({ text: 'Spring promo', delegation: { agentKey: 'marcus', campaignId } }).delegation, { agentKey: 'marcus', campaignId });
  // K2: the legacy 'claire' teaching alias is retired; 'claire' is the Business Performance analyst (question text only).
  assert.throws(() => contracts.validateHonTurnRequest({ text: 'Outline', delegation: { agentKey: 'claire', curriculumId } }), /INVALID_HON_CONVERSATION_INPUT/);
  assert.deepEqual(contracts.validateHonTurnRequest({ text: 'How is retention?', delegation: { agentKey: 'claire' } }), { text: 'How is retention?', delegation: { agentKey: 'claire' } });
  for (const bad of [{ text: ' ', delegation: { agentKey: 'claire' } }, { text: 'x'.repeat(2001), delegation: { agentKey: 'claire' } },
    { text: 'Why?', delegation: { agentKey: 'claire' }, fromSuggestionTurnId: 'not-a-uuid' }, { text: 'Why?', delegation: { agentKey: 'claire' }, replyMode: 'DETAILED' }]) {
    assert.throws(() => contracts.validateHonTurnRequest(bad), /INVALID_HON_CONVERSATION_INPUT/, JSON.stringify(bad).slice(0, 80));
  }
  // K2c: a Claire question may confirm HON's suggestion of Claire.
  const fromId = ID();
  assert.deepEqual(contracts.validateHonTurnRequest({ text: 'Why?', delegation: { agentKey: 'claire' }, fromSuggestionTurnId: fromId }), { text: 'Why?', delegation: { agentKey: 'claire' }, fromSuggestionTurnId: fromId });
  assert.equal(contracts.validateHonTurnRequest({ text: 'Outline', delegation: { agentKey: 'kai', curriculumId } }).delegation.agentKey, 'kai', 'Kai is the teaching delegate');
  assert.deepEqual(contracts.HON_DELEGATE_AGENTS, ['marcus', 'kai', 'chad'], 'clients see Kai, never claire, as the teaching delegate');
  assert.throws(() => contracts.validateHonTurnRequest({ text: 'x'.repeat(1201), delegation: { agentKey: 'kai', curriculumId } }));
  assert.throws(() => contracts.validateHonTurnRequest({ text: 'Outline', delegation: { agentKey: 'kai', curriculumId, campaignId: curriculumId } }));
  assert.throws(() => contracts.validateHonTurnRequest({ text: 'Outline', delegation: { agentKey: 'alex' } }), 'profile-only specialists are not delegates');
  assert.equal(contracts.validateHonTurnRequest({ text: 'Note', delegation: { agentKey: 'chad', leadId, expectedLeadVersion: 2, purpose: 'CHECK_IN' } }).delegation.purpose, 'CHECK_IN');
  for (const bad of [{ text: 'hi' }, { text: 'hi', delegation: { agentKey: 'hon' } }, { text: 'hi', delegation: { agentKey: 'marcus', campaignId, extra: 1 } },
    { text: 'x'.repeat(1201), delegation: { agentKey: 'kai', curriculumId } }, { text: 'hi', delegation: { agentKey: 'chad', leadId, expectedLeadVersion: 0, purpose: 'CHECK_IN' } },
    { text: 'hi', delegation: { agentKey: 'chad', leadId, expectedLeadVersion: 1, purpose: 'SEND_NOW' } }, { text: 'password: hunter2', delegation: { agentKey: 'marcus', campaignId } },
    { text: '', delegation: { agentKey: 'marcus', campaignId } }, { text: 'hi', delegation: { agentKey: 'marcus', campaignId }, providerId: 'x' }]) {
    assert.throws(() => contracts.validateHonTurnRequest(bad), /INVALID_HON_CONVERSATION_INPUT/, JSON.stringify(bad).slice(0, 80));
  }
  const receipt = { turnId: ID(), conversationId: ID(), status: 'AWAITING_APPROVAL', reason: null, delegatedAgentKeys: ['marcus'], actionRequestIds: [ID()], workItemIds: [ID()], invocationId: ID(), reply: null, replyDetail: null };
  assert.equal(contracts.validateHonTurnReceipt(receipt).status, 'AWAITING_APPROVAL');
  for (const bad of [{ ...receipt, actionRequestIds: [] }, { ...receipt, status: 'READY' }, { ...receipt, status: 'DONE' }, { ...receipt, delegatedAgentKeys: ['marcus', 'chad'] }, { ...receipt, extra: 1 },
    { ...receipt, reply: 'A specialist draft never rides on the receipt' }, (({ reply, ...rest }) => rest)(receipt),
    { ...receipt, replyDetail: { mode: 'STANDARD', step: 1, maxSteps: 3, truncated: false, canContinue: false, continuesTurnId: null, suggestions: [], followUps: [], sources: [] } }]) {
    assert.throws(() => contracts.validateHonTurnReceipt(bad), /INVALID_HON_CONVERSATION_RESPONSE/);
  }
  const turnId = ID();
  const thread = { id: ID(), title: 'Spring', createdAt: T, updatedAt: T, turnCount: 1, status: 'DELEGATING', turns: [
    { turnId, role: 'HUMAN', text: 'Spring promo', createdAt: T, status: 'DELEGATING', reason: null, references: { workItemId: null, actionRequestId: null, invocationId: null }, replyDetail: null },
    { turnId, role: 'marcus', text: null, createdAt: T, status: 'DELEGATING', reason: null, references: { workItemId: ID(), actionRequestId: null, invocationId: ID() }, replyDetail: null }] };
  assert.equal(contracts.validateHonConversationThread(thread).turns.length, 2);
  assert.throws(() => contracts.validateHonConversationThread({ ...thread, turns: [thread.turns[0], { ...thread.turns[1], text: 'AI says hello' }] }), 'specialist text is never copied into the thread');
  assert.throws(() => contracts.validateHonConversationThread({ ...thread, turns: [thread.turns[0]] }));
  const a = (agentKey, patch = {}) => ({ agentKey, authorized: true, spendDecision: 'ALLOWED', route: 'CONFIGURED', providerRuntime: 'READY', available: true, ...patch });
  assert.deepEqual(contracts.composeHonConversationReadiness({ completeEntitlement: true, asOf: T, agents: [a('marcus'), a('kai', { authorized: false, available: false }), a('chad', { providerRuntime: 'CONFIGURATION_REQUIRED', available: false })] }),
    { contract: true, authorization: true, entitlement: true, providerRoute: true, availableAgentKeys: ['marcus'], honReply: false, businessPerformance: false, asOf: T });
  assert.equal(contracts.composeHonConversationReadiness({ completeEntitlement: true, asOf: T, agents: [a('marcus'), a('hon')] }).honReply, true, 'HON reply readiness comes from its own row');
  assert.deepEqual(contracts.composeHonConversationReadiness({ completeEntitlement: true, asOf: T, agents: [a('marcus'), a('hon')] }).availableAgentKeys, ['marcus'], 'HON is not a delegate');
  const paused = contracts.composeHonConversationReadiness({ completeEntitlement: true, asOf: T, agents: ['marcus', 'kai', 'chad'].map((k) => a(k, { spendDecision: 'AI_PAUSED_BY_HQ', available: false })) });
  assert.equal(paused.entitlement, false); assert.deepEqual(paused.availableAgentKeys, []);
});

test('C2 contracts: a question is delegation null with safe text; HON reply text only when COMPLETED; receipts stay consistent', () => {
  assert.deepEqual(contracts.validateHonTurnRequest({ text: 'What should I focus on this week?', delegation: null }), { text: 'What should I focus on this week?', delegation: null });
  for (const bad of [{ text: '', delegation: null }, { text: '   ', delegation: null }, { text: 'x'.repeat(2001), delegation: null }, { text: 'password: hunter2', delegation: null },
    { text: 'hi' }, { text: 'hi', delegation: null, model: 'any' }, { text: 'hi', delegation: { agentKey: 'hon' } },
    { text: 'hi', delegation: null, replyMode: 'UNLIMITED' }, { text: 'hi', delegation: null, continueTurnId: 'nope' },
    { text: 'hi', delegation: { agentKey: 'marcus', campaignId: ID() }, replyMode: 'DETAILED' }, { text: 'hi', delegation: { agentKey: 'marcus', campaignId: ID() }, continueTurnId: ID() }]) {
    assert.throws(() => contracts.validateHonTurnRequest(bad), /INVALID_HON_CONVERSATION_INPUT/, JSON.stringify(bad).slice(0, 80));
  }
  const cont = ID();
  assert.deepEqual(contracts.validateHonTurnRequest({ text: 'Continue', delegation: null, replyMode: 'DETAILED', continueTurnId: cont }), { text: 'Continue', delegation: null, replyMode: 'DETAILED', continueTurnId: cont });
  // Owner 2026-11-06 16:10Z: same $0.08 ceiling per call; the reservation is the worst case and settles to measured use.
  for (const [mode, m] of Object.entries(contracts.HON_REPLY_MODES)) {
    assert.equal(m.maxProviderCostMicrounits, 80000, mode);
    assert.equal(m.reservedCredits, Math.ceil((m.inputTokens + m.outputTokens) / 1000), mode);
  }
  assert.deepEqual([contracts.HON_REPLY_MODES.STANDARD.taskClass, contracts.HON_REPLY_MODES.STANDARD.outputTokens, contracts.HON_REPLY_MODES.DETAILED.taskClass, contracts.HON_REPLY_MODES.DETAILED.outputTokens, contracts.HON_REPLY_MAX_STEPS], ['SUMMARIZE', 1500, 'ANALYZE', 4000, 3]);
  const detail = { mode: 'STANDARD', step: 1, maxSteps: 3, truncated: false, canContinue: false, continuesTurnId: null, suggestions: [], followUps: [], sources: [] };
  const q = { turnId: ID(), conversationId: ID(), status: 'COMPLETED', reason: null, delegatedAgentKeys: [], actionRequestIds: [], workItemIds: [ID()], invocationId: ID(), reply: 'You have two trials tomorrow.', replyDetail: detail };
  assert.equal(contracts.validateHonTurnReceipt({ ...q, replyDetail: { ...detail, mode: 'DETAILED', step: 2, truncated: true, canContinue: true, continuesTurnId: ID() } }).replyDetail.canContinue, true);
  // A completed answer whose source authority lapsed is concealed: no text and never continuable.
  assert.equal(contracts.validateHonTurnReceipt({ ...q, reason: 'RESULT_CONCEALED', reply: null }).reply, null);
  for (const bad of [{ ...q, reason: 'RESULT_CONCEALED' }, { ...q, reason: 'RESULT_CONCEALED', reply: null, replyDetail: { ...detail, truncated: true, canContinue: true } }, { ...q, reason: 'OTHER', reply: null }]) {
    assert.throws(() => contracts.validateHonTurnReceipt(bad), /INVALID_HON_CONVERSATION_RESPONSE/, JSON.stringify(bad).slice(0, 120));
  }
  assert.equal(contracts.validateHonTurnReceipt(q).reply, 'You have two trials tomorrow.');
  assert.deepEqual(contracts.validateHonTurnReceipt({ ...q, replyDetail: { ...detail, suggestions: ['marcus', 'kai', 'chad'] } }).replyDetail.suggestions, ['marcus', 'kai', 'chad']);
  assert.equal(contracts.HON_REPLY_MAX_SUGGESTIONS, 3);
  assert.equal(contracts.validateHonTurnReceipt({ ...q, status: 'PROCESSING', reply: null }).reply, null);
  for (const bad of [{ ...q, reply: null }, { ...q, reply: '' }, { ...q, status: 'FAILED' }, { ...q, actionRequestIds: [ID()] }, { ...q, status: 'AWAITING_APPROVAL', actionRequestIds: [ID()] }, { ...q, reply: 'x'.repeat(24001) },
    { ...q, replyDetail: null }, { ...q, replyDetail: { ...detail, step: 4 } }, { ...q, replyDetail: { ...detail, step: 3, truncated: true, canContinue: true, continuesTurnId: ID() } },
    { ...q, replyDetail: { ...detail, step: 2 } }, { ...q, replyDetail: { ...detail, canContinue: true } }, { ...q, replyDetail: { ...detail, mode: 'MAX' } },
    { ...q, status: 'PROCESSING', reply: null, replyDetail: { ...detail, truncated: true } }, { ...q, replyDetail: { ...detail, extra: 1 } },
    // C3a suggestions: closed set (delegates and, since K2c, Claire), unique, at most three, only on a whole COMPLETED answer, never when concealed.
    { ...q, replyDetail: { ...detail, suggestions: undefined } }, { ...q, replyDetail: { ...detail, suggestions: ['maya'] } }, { ...q, replyDetail: { ...detail, suggestions: ['hon'] } },
    { ...q, replyDetail: { ...detail, suggestions: ['kai', 'kai'] } }, { ...q, replyDetail: { ...detail, suggestions: ['kai', 'chad', 'marcus', 'kai'] } }, { ...q, replyDetail: { ...detail, suggestions: 'kai' } },
    { ...q, status: 'PROCESSING', reply: null, replyDetail: { ...detail, suggestions: ['kai'] } }, { ...q, replyDetail: { ...detail, mode: 'DETAILED', truncated: true, canContinue: true, suggestions: ['kai'] } },
    { ...q, reason: 'RESULT_CONCEALED', reply: null, replyDetail: { ...detail, suggestions: ['marcus'] } }]) {
    assert.throws(() => contracts.validateHonTurnReceipt(bad), /INVALID_HON_CONVERSATION_RESPONSE/, JSON.stringify(bad).slice(0, 120));
  }
  assert.deepEqual(contracts.validateHonTurnReceipt({ ...q, replyDetail: { ...detail, suggestions: ['claire', 'marcus'] } }).replyDetail.suggestions, ['claire', 'marcus'], 'K2c: HON may suggest Claire');
  const turnId = ID(), refs = { workItemId: ID(), actionRequestId: null, invocationId: ID() };
  const human = { turnId, role: 'HUMAN', text: 'What should I focus on?', createdAt: T, status: 'COMPLETED', reason: null, references: { workItemId: null, actionRequestId: null, invocationId: null }, replyDetail: null };
  const thread = (honTurn) => ({ id: ID(), title: 'Ask', createdAt: T, updatedAt: T, turnCount: 1, status: honTurn.status, turns: [{ ...human, status: honTurn.status }, honTurn] });
  assert.equal(contracts.validateHonConversationThread(thread({ turnId, role: 'hon', text: 'Review the two new leads.', createdAt: T, status: 'COMPLETED', reason: null, references: refs, replyDetail: detail })).turns[1].text, 'Review the two new leads.');
  assert.equal(contracts.validateHonConversationThread(thread({ turnId, role: 'hon', text: null, createdAt: T, status: 'UNKNOWN', reason: 'PROVIDER_UNKNOWN', references: refs, replyDetail: detail })).turns[1].text, null);
  for (const bad of [{ turnId, role: 'hon', text: null, createdAt: T, status: 'COMPLETED', reason: null, references: refs, replyDetail: detail },
    { turnId, role: 'hon', text: 'A held reply is never shown', createdAt: T, status: 'PROCESSING', reason: 'RESULT_HELD', references: refs, replyDetail: detail },
    { turnId, role: 'hon', text: 'ok', createdAt: T, status: 'COMPLETED', reason: null, references: { ...refs, actionRequestId: ID() }, replyDetail: detail },
    { turnId, role: 'hon', text: 'ok', createdAt: T, status: 'COMPLETED', reason: null, references: refs, replyDetail: null },
    { turnId, role: 'hon', text: 'ok', createdAt: T, status: 'COMPLETED', reason: null, references: refs }]) {
    assert.throws(() => contracts.validateHonConversationThread(thread(bad)), JSON.stringify(bad).slice(0, 100));
  }
});

function harness({ begun, agentScope = { organizationId: ORG, schoolId: SCHOOL, principalId: PRINCIPAL }, agentError = null, replyError = null } = {}) {
  const calls = [];
  const turnId = begun?.turnId ?? ID();
  const receipt = { turnId, conversationId: ID(), status: 'DELEGATING', reason: null, delegatedAgentKeys: ['marcus'], actionRequestIds: [], workItemIds: [], invocationId: null, reply: null, replyDetail: null,
    ...(begun?.agentKey === 'claire' ? { status: 'COMPLETED', delegatedAgentKeys: ['claire'], workItemIds: [ID()], invocationId: ID(), reply: 'Recorded facts: 12 active students.',
      replyDetail: { mode: 'DETAILED', step: 1, maxSteps: 3, truncated: false, canContinue: false, continuesTurnId: null, suggestions: [], followUps: [], sources: [] } } : {}),
    ...(begun?.agentKey === 'hon' ? { status: 'COMPLETED', delegatedAgentKeys: [], workItemIds: [ID()], invocationId: ID(), reply: 'Two trials are booked tomorrow.',
      replyDetail: { mode: 'STANDARD', step: 1, maxSteps: 3, truncated: false, canContinue: false, continuesTurnId: null, suggestions: [], followUps: [], sources: [] } } : {}) };
  const database = {
    async resolveCampaignScope(subject, permission) { calls.push(['scope:marcus', subject, permission]); return agentScope; },
    async resolveTeachingAssistantScope(subject) { calls.push(['scope:claire', subject]); return agentScope; },
    async resolveChadFollowUpAssistantScope(subject) { calls.push(['scope:chad', subject]); return agentScope; },
    async withTenantTransaction(context, work) { return work(client(context)); },
    async withTenantReadOnlyTransaction(context, work) { return work(client(context)); },
  };
  const client = (context) => ({ async query(sql, params) {
    calls.push(['sql', sql.replace(/\s+/g, ' ').slice(0, 60), params, context.principalType]);
    if (/begin_hon_turn/.test(sql)) return { rows: [{ data: begun ?? { turnId, agentKey: 'marcus', delegation: { campaignId: ID(), request: 'Spring promo' }, handOff: true } }] };
    if (/read_hon_turn_receipt/.test(sql)) return { rows: [{ data: receipt }] };
    return { rows: [{ data: null }] };
  } });
  const agent = (key) => ({ async submit(context, input) { calls.push(['submit:' + key, context, input]); if (agentError) throw agentError; return { status: 'AWAITING_APPROVAL' }; } });
  const reply = { async run(s, id) { calls.push(['reply:run', s, id]); if (replyError) throw replyError; }, async releaseHeld(s, id) { calls.push(['reply:release', s, id]); } };
  const service = new HonConversationService(database, agent('marcus'), agent('claire'), agent('chad'), { read: async () => { throw new Error('unused'); } }, reply);
  return { service, calls, turnId };
}
const scope = { organizationId: ORG, schoolId: SCHOOL, principalId: PRINCIPAL, externalSubject: 'verified-human' };
const turn = { text: 'Spring promo', delegation: { agentKey: 'marcus', campaignId: ID() } };

test('C1 service: hands the turn to the specialist with the turn id as its idempotency key; refusals are recorded, timeouts are not', async () => {
  let h = harness();
  const out = await h.service.sendTurn(scope, ID(), turn, ID());
  assert.equal(out.status, 'DELEGATING');
  const submit = h.calls.find((c) => c[0] === 'submit:marcus');
  assert.equal(submit[1].idempotencyKey, h.turnId, 'specialist key = turn id, so a resend never creates a second request or provider call');
  assert.equal(submit[1].principalType, 'HUMAN_USER'); assert.equal(submit[1].source, 'HUMAN_UI'); assert.equal(submit[1].externalSubject, 'verified-human');
  assert.equal(submit[1].actionRequestId, undefined); assert.equal(submit[1].delegatedByPrincipalId, undefined);
  assert.ok(!h.calls.some((c) => c[0] === 'sql' && /fail_hon_turn/.test(c[1])));

  h = harness({ begun: { turnId: ID(), agentKey: 'marcus', delegation: {}, handOff: false } });
  await h.service.sendTurn(scope, ID(), turn, ID());
  assert.ok(!h.calls.some((c) => c[0].startsWith('submit')), 'a replayed or already-handed-over turn is never resubmitted');

  for (const [agentScope, why] of [[null, 'no specialist scope'], [{ organizationId: ORG, schoolId: ID(), principalId: PRINCIPAL }, 'specialist resolves a different school'], [{ organizationId: ORG, schoolId: SCHOOL, principalId: ID() }, 'different principal']]) {
    h = harness({ agentScope });
    await h.service.sendTurn(scope, ID(), turn, ID());
    assert.ok(!h.calls.some((c) => c[0].startsWith('submit')), why);
    assert.deepEqual(h.calls.find((c) => c[0] === 'sql' && /fail_hon_turn/.test(c[1]))[2].slice(2), ['AGENT_NOT_AUTHORIZED'], why);
  }
  for (const [error, reason] of [[new ForbiddenException({ code: 'MARKETING_FORBIDDEN' }), 'AGENT_NOT_AUTHORIZED'], [new BadRequestException({ code: 'INVALID_MARKETING_REQUEST' }), 'AGENT_REQUEST_INVALID']]) {
    h = harness({ agentError: error });
    await h.service.sendTurn(scope, ID(), turn, ID());
    assert.deepEqual(h.calls.find((c) => c[0] === 'sql' && /fail_hon_turn/.test(c[1]))[2].slice(2), [reason]);
  }
  h = harness({ agentError: new ServiceUnavailableException({ code: 'MARKETING_PERSISTENCE_UNKNOWN' }) });
  await h.service.sendTurn(scope, ID(), turn, ID());
  assert.ok(!h.calls.some((c) => c[0] === 'sql' && /fail_hon_turn/.test(c[1])), 'an unknown outcome is never recorded as a failure');

  h = harness();
  await assert.rejects(h.service.sendTurn(scope, ID(), turn, undefined), (e) => e.getResponse().code === 'IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(h.service.sendTurn(scope, ID(), { text: 'Just chat with me' }, ID()), (e) => e.getResponse().code === 'INVALID_HON_TURN');
  assert.ok(!h.calls.some((c) => c[0] === 'sql'), 'invalid input never opens a transaction');
});

test('C2 service: a question goes to the reply service with the turn id, never to a specialist; a resend only releases a held reply', async () => {
  const turnId = ID();
  let h = harness({ begun: { turnId, agentKey: 'hon', delegation: null, handOff: true } });
  const out = await h.service.sendTurn(scope, ID(), { text: 'What should I focus on today?', delegation: null }, ID());
  assert.deepEqual([out.status, out.reply, out.delegatedAgentKeys], ['COMPLETED', 'Two trials are booked tomorrow.', []]);
  const run = h.calls.find((c) => c[0] === 'reply:run');
  assert.equal(run[2], turnId); assert.equal(run[1].externalSubject, 'verified-human'); assert.equal(run[1].schoolId, SCHOOL);
  assert.ok(!h.calls.some((c) => c[0].startsWith('submit') || c[0].startsWith('scope:')), 'no specialist is involved in a question');
  assert.ok(!h.calls.some((c) => c[0] === 'sql' && /fail_hon_turn/.test(c[1])));
  h = harness({ begun: { turnId, agentKey: 'hon', delegation: null, handOff: false } });
  await h.service.sendTurn(scope, ID(), { text: 'What should I focus on today?', delegation: null }, ID());
  assert.deepEqual(h.calls.filter((c) => c[0].startsWith('reply:')).map((c) => c[0]), ['reply:release'], 'a resend never plans or calls a provider again');
  h = harness({ begun: { turnId, agentKey: 'hon', delegation: null, handOff: true }, replyError: Object.assign(new Error('AI_PAUSED_BY_HQ'), { code: '42501' }) });
  await assert.rejects(h.service.sendTurn(scope, ID(), { text: 'Anything?', delegation: null }, ID()), (e) => e.getResponse().code === 'HON_AI_SPEND_REFUSED' && e.getResponse().reason === 'AI_PAUSED_BY_HQ');
  h = harness({ begun: { turnId, agentKey: 'hon', delegation: null, handOff: true }, replyError: new ServiceUnavailableException({ code: 'HON_REPLY_PERSISTENCE_UNKNOWN' }) });
  await assert.rejects(h.service.sendTurn(scope, ID(), { text: 'Anything?', delegation: null }, ID()), (e) => e.getResponse().code === 'HON_REPLY_PERSISTENCE_UNKNOWN');
});

const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, (res) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString() })); });
  req.on('error', reject); if (body) req.write(body); req.end();
});

test('HTTP: scope from the live resolver, human-UI command headers on POST, no-store, cursor validation', async () => {
  process.env.HON_PUBLIC_ORIGIN = process.env.HON_PUBLIC_ORIGIN || 'https://app.example.test';
  const { configuredPublicOrigin } = require('@hon/auth');
  const origin = configuredPublicOrigin(process.env);
  const seen = []; let resolved = { organizationId: ORG, schoolId: SCHOOL, principalId: PRINCIPAL };
  const service = {
    list: async (s, q) => { seen.push(['list', s, q]); return { items: [], nextCursor: null }; },
    create: async (s, input, key) => { seen.push(['create', s, input, key]); return { id: ID() }; },
    sendTurn: async (s, id, input, key) => { seen.push(['send', s, id, input, key]); return { turnId: ID() }; },
    read: async () => ({}), readiness: async () => ({ data: {} }),
  };
  const database = { async resolveAuthorizedScope(subject, schoolId, permission) { seen.push(['scope', subject, schoolId, permission]); return resolved; } };
  const module = await Test.createTestingModule({ controllers: [HonConversationController],
    providers: [{ provide: HonConversationService, useValue: service }, { provide: RuntimeDatabaseService, useValue: database }, HonConversationHumanUiGuard] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/organizations/${ORG}/schools/${SCHOOL}/hon`;
  const human = { origin, 'x-hon-human-command': 'hon-conversation', 'content-type': 'application/json', 'idempotency-key': ID() };
  try {
    const list = await send(`${base}/conversations`);
    assert.equal(list.status, 200, list.body); assert.match(list.headers['cache-control'], /no-store/);
    assert.deepEqual(seen[0], ['scope', 'verified-human', SCHOOL, 'ai.invocation.plan']);
    assert.equal(seen[1][1].externalSubject, 'verified-human');
    const conv = ID();
    assert.equal((await send(`${base}/conversations/${conv}/turns`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(turn) })).status, 403, 'POST needs human-UI command headers');
    assert.equal((await send(`${base}/conversations/${conv}/turns`, { method: 'POST', headers: { ...human, 'x-hon-human-command': 'marketing-assistant' }, body: JSON.stringify(turn) })).status, 403, 'command header is per-surface');
    const ok = await send(`${base}/conversations/${conv}/turns`, { method: 'POST', headers: human, body: JSON.stringify(turn) });
    assert.equal(ok.status, 200, ok.body);
    const s = seen.find((x) => x[0] === 'send'); assert.equal(s[2], conv); assert.equal(s[4], human['idempotency-key']);
    assert.equal((await send(`${base}/conversations/${conv}/turns?schoolId=${ID()}`, { method: 'POST', headers: human, body: JSON.stringify(turn) })).status, 400);
    resolved = { ...resolved, schoolId: ID() };
    assert.equal((await send(`${base}/conversations`)).status, 403, 'resolver scope must match the path');
    resolved = null; assert.equal((await send(`${base}/readiness`)).status, 403);
  } finally { await app.close(); }
});

test('C3a grouped confirmation contract: fromSuggestionTurnId on delegations only; groups carry a status derived from their members', () => {
  const contracts = require('@hon/contracts');
  const ID = () => require('node:crypto').randomUUID();
  const from = ID();
  const d = { text: 'Draft a post.', delegation: { agentKey: 'marcus', campaignId: ID() }, fromSuggestionTurnId: from };
  assert.equal(contracts.validateHonTurnRequest(d).fromSuggestionTurnId, from);
  assert.equal('fromSuggestionTurnId' in contracts.validateHonTurnRequest({ text: 'x', delegation: d.delegation }), false);
  for (const bad of [{ ...d, fromSuggestionTurnId: 'nope' }, { text: 'A question', delegation: null, fromSuggestionTurnId: from }]) {
    assert.throws(() => contracts.validateHonTurnRequest(bad), /INVALID_HON_CONVERSATION_INPUT/);
  }
  const derive = contracts.deriveHonOrchestrationStatus;
  assert.deepEqual([derive(['COMPLETED', 'UNKNOWN']), derive(['COMPLETED', 'DELEGATING']), derive(['AWAITING_APPROVAL', 'COMPLETED']), derive(['COMPLETED']), derive(['FAILED', 'FAILED']), derive(['COMPLETED', 'FAILED']), derive([])],
    ['UNKNOWN', 'PENDING', 'NEEDS_REVIEW', 'COMPLETED', 'FAILED', 'PARTIAL', 'UNKNOWN']);
  const src = ID(), t1 = ID(), t2 = ID();
  const group = { sourceTurnId: src, status: 'PARTIAL', members: [{ agentKey: 'marcus', turnId: t1, status: 'COMPLETED' }, { agentKey: 'kai', turnId: t2, status: 'FAILED' }] };
  assert.equal(contracts.validateHonOrchestrationList({ items: [{ sourceTurnId: src, status: 'COMPLETED', members: [{ agentKey: 'claire', turnId: t1, status: 'COMPLETED' }] }] }).items[0].members[0].agentKey, 'claire', 'K2c: Claire can be a group member');
  assert.equal(contracts.validateHonOrchestrationList({ items: [group] }).items[0].status, 'PARTIAL');
  assert.deepEqual(contracts.validateHonOrchestrationList({ items: [] }), { items: [] });
  for (const bad of [{ items: [{ ...group, status: 'COMPLETED' }] }, { items: [{ ...group, members: [] }] }, { items: [group, group] },
    { items: [{ ...group, members: [group.members[0], { ...group.members[1], agentKey: 'marcus' }] }] }, { items: [{ ...group, members: [{ ...group.members[0], agentKey: 'maya' }] , status: 'COMPLETED' }] },
    { items: [{ ...group, members: [{ ...group.members[0], turnId: src }], status: 'COMPLETED' }] }, { items: [{ ...group, extra: 1 }] }, { items: [group], more: 1 }]) {
    assert.throws(() => contracts.validateHonOrchestrationList(bad), /INVALID_HON_CONVERSATION_RESPONSE/, JSON.stringify(bad).slice(0, 100));
  }
});

test('C3b group summary contract: summarizeTurnId on fresh questions only', () => {
  const contracts = require('@hon/contracts');
  const ID = () => require('node:crypto').randomUUID();
  const src = ID();
  const q = { text: 'Summarize what the team did.', delegation: null, summarizeTurnId: src };
  assert.deepEqual(contracts.validateHonTurnRequest(q), q);
  assert.deepEqual(contracts.validateHonTurnRequest({ ...q, replyMode: 'DETAILED' }), { ...q, replyMode: 'DETAILED' });
  assert.equal('summarizeTurnId' in contracts.validateHonTurnRequest({ text: 'x', delegation: null }), false);
  for (const bad of [{ ...q, summarizeTurnId: 'nope' }, { ...q, continueTurnId: ID() },
    { text: 'Draft.', delegation: { agentKey: 'marcus', campaignId: ID() }, summarizeTurnId: src }]) {
    assert.throws(() => contracts.validateHonTurnRequest(bad), /INVALID_HON_CONVERSATION_INPUT/, JSON.stringify(bad));
  }
});

test('K2 Claire contract and service: an analyst turn is answered like HON, never as a draft, and goes to the reply service', async () => {
  const detail = { mode: 'DETAILED', step: 1, maxSteps: 3, truncated: false, canContinue: false, continuesTurnId: null, suggestions: [], followUps: [], sources: [] };
  const q = { turnId: ID(), conversationId: ID(), status: 'COMPLETED', reason: null, delegatedAgentKeys: ['claire'], actionRequestIds: [], workItemIds: [ID()], invocationId: ID(), reply: 'Recorded facts: 12.', replyDetail: detail };
  assert.equal(contracts.validateHonTurnReceipt(q).reply, 'Recorded facts: 12.');
  assert.equal(contracts.validateHonTurnReceipt({ ...q, reason: 'RESULT_CONCEALED', reply: null }).reply, null, 'a lapsed reporting.view conceals the analysis');
  for (const bad of [{ ...q, replyDetail: null }, { ...q, replyDetail: { ...detail, mode: 'STANDARD' } }, { ...q, replyDetail: { ...detail, suggestions: ['marcus'] } },
    { ...q, replyDetail: { ...detail, truncated: true, canContinue: true } }, { ...q, replyDetail: { ...detail, step: 2, continuesTurnId: ID() } },
    { ...q, actionRequestIds: [ID()] }, { ...q, status: 'AWAITING_APPROVAL', actionRequestIds: [ID()] }, { ...q, reply: null }, { ...q, status: 'PROCESSING' }]) {
    assert.throws(() => contracts.validateHonTurnReceipt(bad), /INVALID_HON_CONVERSATION_RESPONSE/, JSON.stringify(bad).slice(0, 120));
  }
  const turnId = ID(), refs = { workItemId: ID(), actionRequestId: null, invocationId: ID() };
  const thread = (t) => ({ id: ID(), title: 'Numbers', createdAt: T, updatedAt: T, turnCount: 1, status: t.status, turns: [
    { turnId, role: 'HUMAN', text: 'How is retention?', createdAt: T, status: t.status, reason: null, references: { workItemId: null, actionRequestId: null, invocationId: null }, replyDetail: null }, t] });
  assert.equal(contracts.validateHonConversationThread(thread({ turnId, role: 'claire', text: 'Recorded facts: 12.', createdAt: T, status: 'COMPLETED', reason: null, references: refs, replyDetail: detail })).turns[1].role, 'claire');
  assert.throws(() => contracts.validateHonConversationThread(thread({ turnId, role: 'claire', text: 'x', createdAt: T, status: 'COMPLETED', reason: null, references: refs, replyDetail: null })));
  assert.equal(contracts.composeHonConversationReadiness({ completeEntitlement: true, asOf: T, agents: [{ agentKey: 'claire', authorized: true, spendDecision: 'ALLOWED', route: 'CONFIGURED', providerRuntime: 'READY', available: true }] }).businessPerformance, true);
  assert.deepEqual(contracts.AI_TEAM_READY_AGENTS.at(-1), ['claire', 'BUSINESS_PERFORMANCE', 15]);
  const h = harness({ begun: { turnId, agentKey: 'claire', delegation: null, handOff: true } });
  const out = await h.service.sendTurn(scope, ID(), { text: 'How is retention?', delegation: { agentKey: 'claire' } }, ID());
  assert.deepEqual([out.status, out.delegatedAgentKeys], ['COMPLETED', ['claire']]);
  assert.equal(h.calls.find((c) => c[0] === 'reply:run')[2], turnId);
  assert.ok(!h.calls.some((c) => c[0].startsWith('submit') || c[0].startsWith('scope:')), 'Claire is not a draft specialist');
});
