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
  assert.equal(contracts.validateHonTurnRequest({ text: 'Outline', delegation: { agentKey: 'claire', curriculumId } }).delegation.agentKey, 'claire');
  assert.equal(contracts.validateHonTurnRequest({ text: 'Note', delegation: { agentKey: 'chad', leadId, expectedLeadVersion: 2, purpose: 'CHECK_IN' } }).delegation.purpose, 'CHECK_IN');
  for (const bad of [{ text: 'hi' }, { text: 'hi', delegation: { agentKey: 'hon' } }, { text: 'hi', delegation: { agentKey: 'marcus', campaignId, extra: 1 } },
    { text: 'x'.repeat(1201), delegation: { agentKey: 'claire', curriculumId } }, { text: 'hi', delegation: { agentKey: 'chad', leadId, expectedLeadVersion: 0, purpose: 'CHECK_IN' } },
    { text: 'hi', delegation: { agentKey: 'chad', leadId, expectedLeadVersion: 1, purpose: 'SEND_NOW' } }, { text: 'password: hunter2', delegation: { agentKey: 'marcus', campaignId } },
    { text: '', delegation: { agentKey: 'marcus', campaignId } }, { text: 'hi', delegation: { agentKey: 'marcus', campaignId }, providerId: 'x' }]) {
    assert.throws(() => contracts.validateHonTurnRequest(bad), /INVALID_HON_CONVERSATION_INPUT/, JSON.stringify(bad).slice(0, 80));
  }
  const receipt = { turnId: ID(), conversationId: ID(), status: 'AWAITING_APPROVAL', reason: null, delegatedAgentKeys: ['marcus'], actionRequestIds: [ID()], workItemIds: [ID()], invocationId: ID() };
  assert.equal(contracts.validateHonTurnReceipt(receipt).status, 'AWAITING_APPROVAL');
  for (const bad of [{ ...receipt, actionRequestIds: [] }, { ...receipt, status: 'READY' }, { ...receipt, status: 'DONE' }, { ...receipt, delegatedAgentKeys: ['marcus', 'chad'] }, { ...receipt, extra: 1 }]) {
    assert.throws(() => contracts.validateHonTurnReceipt(bad), /INVALID_HON_CONVERSATION_RESPONSE/);
  }
  const turnId = ID();
  const thread = { id: ID(), title: 'Spring', createdAt: T, updatedAt: T, turnCount: 1, status: 'DELEGATING', turns: [
    { turnId, role: 'HUMAN', text: 'Spring promo', createdAt: T, status: 'DELEGATING', reason: null, references: { workItemId: null, actionRequestId: null, invocationId: null } },
    { turnId, role: 'marcus', text: null, createdAt: T, status: 'DELEGATING', reason: null, references: { workItemId: ID(), actionRequestId: null, invocationId: ID() } }] };
  assert.equal(contracts.validateHonConversationThread(thread).turns.length, 2);
  assert.throws(() => contracts.validateHonConversationThread({ ...thread, turns: [thread.turns[0], { ...thread.turns[1], text: 'AI says hello' }] }), 'specialist text is never copied into the thread');
  assert.throws(() => contracts.validateHonConversationThread({ ...thread, turns: [thread.turns[0]] }));
  const a = (agentKey, patch = {}) => ({ agentKey, authorized: true, spendDecision: 'ALLOWED', route: 'CONFIGURED', providerRuntime: 'READY', available: true, ...patch });
  assert.deepEqual(contracts.composeHonConversationReadiness({ completeEntitlement: true, asOf: T, agents: [a('marcus'), a('claire', { authorized: false, available: false }), a('chad', { providerRuntime: 'CONFIGURATION_REQUIRED', available: false })] }),
    { contract: true, authorization: true, entitlement: true, providerRoute: true, availableAgentKeys: ['marcus'], asOf: T });
  const paused = contracts.composeHonConversationReadiness({ completeEntitlement: true, asOf: T, agents: ['marcus', 'claire', 'chad'].map((k) => a(k, { spendDecision: 'AI_PAUSED_BY_HQ', available: false })) });
  assert.equal(paused.entitlement, false); assert.deepEqual(paused.availableAgentKeys, []);
});

function harness({ begun, agentScope = { organizationId: ORG, schoolId: SCHOOL, principalId: PRINCIPAL }, agentError = null } = {}) {
  const calls = [];
  const turnId = begun?.turnId ?? ID();
  const receipt = { turnId, conversationId: ID(), status: 'DELEGATING', reason: null, delegatedAgentKeys: ['marcus'], actionRequestIds: [], workItemIds: [], invocationId: null };
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
  const service = new HonConversationService(database, agent('marcus'), agent('claire'), agent('chad'), { read: async () => { throw new Error('unused'); } });
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
