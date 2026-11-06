const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { AiTeamReadinessController, AiTeamReadinessService } = require('../dist/ai-team/ai-team-readiness.controller.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { MARKETING_PROVIDER_RUNTIME } = require('../dist/ai/provider-runtime.js');
const { CLAIRE_PROVIDER_RUNTIME } = require('../dist/ai/claire-provider-runtime.js');
const { CHAD_PROVIDER_RUNTIME } = require('../dist/ai/chad-provider-runtime.js');
const { HON_REPLY_PROVIDER_RUNTIME } = require('../dist/ai/hon-reply-provider-runtime.js');
const contracts = require('@hon/contracts');

const ORG = randomUUID(), SCHOOL = randomUUID(), T = '2026-11-02T00:00:00.000Z';
const agent = (agentKey, agent, requestCredits, patch = {}) => ({ agentKey, agent, authorized: true, spendDecision: 'ALLOWED', route: 'CONFIGURED', requestCredits, available: true, blockedBy: null, ...patch });
const row = (patch = {}) => ({ organizationId: ORG, schoolId: SCHOOL, completeEntitlement: true, agentBudget: { committedCredits: 10, ceilingCredits: 12000 },
  agents: [agent('marcus', 'MARKETING', 6), agent('claire', 'TEACHING', 6), agent('chad', 'CHAD_FOLLOW_UP', 3), agent('hon', 'HON_REPLY', 10)], asOf: T, ...patch });

test('AI-R1 contracts: closed agent list and consistent blockers; runtime refusal only where the database allowed', () => {
  assert.equal(contracts.validateAiTeamReadinessRow(row()).agents.length, 4, 'three specialists and the C2 HON reply');
  // Organization-wide totals are hidden (null) without organization-wide authority; never a partial or school-only object.
  assert.equal(contracts.validateAiTeamReadinessRow(row({ agentBudget: null })).agentBudget, null);
  for (const bad of [row({ agentBudget: {} }), row({ agentBudget: { committedCredits: 10 } }), row({ agentBudget: { committedCredits: 10, ceilingCredits: 12000, schoolCommittedCredits: 1 } }),
    row({ agentBudget: { committedCredits: -1, ceilingCredits: 12000 } })])
    assert.throws(() => contracts.validateAiTeamReadinessRow(bad), JSON.stringify(bad.agentBudget));
  assert.equal(contracts.validateAiTeamReadiness(contracts.composeAiTeamReadiness(contracts.validateAiTeamReadinessRow(row({ agentBudget: null })), () => 'READY')).agentBudget, null);
  const blocked = row({ agents: [agent('marcus', 'MARKETING', 6, { authorized: false, available: false, blockedBy: 'NOT_AUTHORIZED' }), agent('claire', 'TEACHING', 6, { spendDecision: 'AI_PAUSED_BY_HQ', available: false, blockedBy: 'AI_PAUSED_BY_HQ' }), agent('chad', 'CHAD_FOLLOW_UP', 3, { route: 'NO_ELIGIBLE_ROUTE', available: false, blockedBy: 'NO_ELIGIBLE_ROUTE' }), agent('hon', 'HON_REPLY', 10)] });
  assert.equal(contracts.validateAiTeamReadinessRow(blocked).agents[0].blockedBy, 'NOT_AUTHORIZED');
  for (const bad of [row({ agents: row().agents.slice(0, 3) }), row({ agents: [...row().agents.slice(0, 3), agent('hon', 'HON_REPLY', 3)] }), row({ agents: [agent('kai', 'TEACHING', 6), ...row().agents.slice(1)] }),
    row({ agents: [agent('marcus', 'MARKETING', 6, { authorized: false }), ...row().agents.slice(1)] }),
    row({ agents: [agent('marcus', 'MARKETING', 6, { available: false, blockedBy: null }), ...row().agents.slice(1)] }),
    row({ agents: [agent('marcus', 'MARKETING', 6, { spendDecision: 'FREE' }), ...row().agents.slice(1)] }), { ...row(), extra: 1 }])
    assert.throws(() => contracts.validateAiTeamReadinessRow(bad), JSON.stringify(bad).slice(0, 100));
  const composed = contracts.composeAiTeamReadiness(contracts.validateAiTeamReadinessRow(row()), (k) => (k === 'chad' ? 'READY' : 'CONFIGURATION_REQUIRED'));
  assert.deepEqual(composed.agents.map((a) => [a.agentKey, a.available, a.blockedBy]), [['marcus', false, 'PROVIDER_RUNTIME_NOT_CONFIGURED'], ['claire', false, 'PROVIDER_RUNTIME_NOT_CONFIGURED'], ['chad', true, null], ['hon', false, 'PROVIDER_RUNTIME_NOT_CONFIGURED']]);
  assert.deepEqual(composed.honConversation, { contract: true });
  assert.equal(contracts.validateAiTeamReadiness(composed).agents.length, 4);
  const paused = contracts.composeAiTeamReadiness(contracts.validateAiTeamReadinessRow(blocked), () => 'CONFIGURATION_REQUIRED');
  assert.equal(paused.agents[1].blockedBy, 'AI_PAUSED_BY_HQ', 'a database blocker is kept, never replaced by the runtime');
  assert.throws(() => contracts.validateAiTeamReadiness({ ...composed, agents: composed.agents.map((a) => ({ ...a, providerRuntime: 'CONFIGURATION_REQUIRED', available: true, blockedBy: null })) }));
});

const send = (url) => new Promise((resolve, reject) => {
  const req = httpRequest(url, {}, (res) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString() })); });
  req.on('error', reject); req.end();
});

test('HTTP: readiness is scoped by the live resolver, bound to the verified subject, no-store, and never calls a provider', async () => {
  const queries = []; let scope = { organizationId: ORG, schoolId: SCHOOL, principalId: randomUUID() }; let next = null; let generated = 0;
  const runtime = (state) => ({ readiness: () => state, generate: async () => { generated += 1; throw new Error('no provider'); } });
  const database = {
    async resolveAuthorizedScope(subject, schoolId, permission) { queries.push(['scope', subject, schoolId, permission]); return scope; },
    async withTenantTransaction(context, work) {
      queries.push(['tx', context.organizationId, context.schoolId, context.principalId, context.principalType]);
      return work({ async query(sql, params) { queries.push(['sql', sql, params]); if (/read_ai_team_readiness/.test(sql)) { if (next) { const e = new Error('x'); e.code = next; next = null; throw e; } return { rows: [{ data: row() }] }; } return { rows: [] }; } });
    },
  };
  const module = await Test.createTestingModule({ controllers: [AiTeamReadinessController],
    providers: [AiTeamReadinessService, { provide: RuntimeDatabaseService, useValue: database }, { provide: MARKETING_PROVIDER_RUNTIME, useValue: runtime('READY') },
      { provide: CLAIRE_PROVIDER_RUNTIME, useValue: runtime('CONFIGURATION_REQUIRED') }, { provide: CHAD_PROVIDER_RUNTIME, useValue: runtime('READY') },
      { provide: HON_REPLY_PROVIDER_RUNTIME, useValue: runtime('CONFIGURATION_REQUIRED') }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/organizations/${ORG}/schools/${SCHOOL}/ai/team/capabilities`;
  try {
    const ok = await send(base);
    assert.equal(ok.status, 200, ok.body); assert.match(ok.headers['cache-control'], /no-store/);
    const data = JSON.parse(ok.body).data;
    assert.deepEqual(data.agents.map((a) => [a.agentKey, a.providerRuntime, a.available]), [['marcus', 'READY', true], ['claire', 'CONFIGURATION_REQUIRED', false], ['chad', 'READY', true], ['hon', 'CONFIGURATION_REQUIRED', false]]);
    assert.deepEqual(queries[0], ['scope', 'verified-human', SCHOOL, 'ai.invocation.plan']);
    assert.deepEqual(queries.find((q) => q[0] === 'sql' && /read_ai_team_readiness/.test(q[1]))[2], ['verified-human']);
    assert.equal(generated, 0, 'no provider call');
    next = '42501'; assert.equal((await send(base)).status, 403);
    next = 'XX000'; assert.equal(JSON.parse((await send(base)).body).code, 'AI_TEAM_READINESS_UNAVAILABLE');
    const n = queries.length;
    assert.equal((await send(`${base}?schoolId=${randomUUID()}`)).status, 403, 'no query parameters');
    scope = { ...scope, schoolId: randomUUID() }; assert.equal((await send(base)).status, 403, 'resolver scope must match the path');
    scope = null; assert.equal((await send(base)).status, 403, 'no scope');
    assert.equal(queries.filter((q) => q[0] === 'tx').length, queries.slice(0, n).filter((q) => q[0] === 'tx').length, 'refusals never open a tenant transaction');
    assert.equal((await send(`http://127.0.0.1:${app.getHttpServer().address().port}/v1/organizations/not-a-uuid/schools/${SCHOOL}/ai/team/capabilities`)).status, 400);
  } finally { await app.close(); }
});
