const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { request: httpRequest } = require('node:http');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { AiSchoolUsageHqController, AiSchoolUsageService } = require('../dist/ai-spend/ai-school-usage.controller.js');
const { SaasBillingService } = require('../dist/saas-billing/saas-billing.service.js');
const { SaasReadGuard } = require('../dist/saas-billing/saas-billing.guards.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const contracts = require('@hon/contracts');

const U = () => randomUUID(), T = '2026-11-01T00:00:00.000Z';
// amt(credits, providerReported, entries, estimate = 0, writeOffs = 0)
// late(actual, lateEntries, superseded): a verified provider charge recorded after a WRITE_OFF, reported beside the totals.
const late = (actual = 0, n = 0, superseded = 0) => ({ lateProviderCostMicrounits: actual, lateProviderExpenseEntries: n, supersededWriteOffEstimateMicrounits: superseded });
const amt = (credits, cost, entries, estimate = 0, writeOffs = 0, l = late()) => ({ credits, providerReportedCostMicrounits: cost, estimatedWriteOffCostMicrounits: estimate, entries, writeOffEntries: writeOffs, ...l });
const totals = (cost, estimate, entries, writeOffs, l = late()) => ({ providerReportedCostMicrounits: cost, estimatedWriteOffCostMicrounits: estimate, entries, writeOffEntries: writeOffs, ...l });
// Mixed school: two Marcus rows (one an HQ write-off estimate of 900), one Chad row, one creative-media row.
const school = (org, patch = {}) => ({ organizationId: org, schoolId: U(), ...totals(9000, 900, 4, 1), unreconciledInvocations: 1,
  byClass: { AGENT_INFERENCE: { ...amt(7, 6000, 3, 900, 1), byAgent: { MARKETING: amt(4, 4000, 2, 900, 1), CHAD_FOLLOW_UP: amt(3, 2000, 1) } },
    CREATIVE_MEDIA: { ...amt(50, 3000, 1), byAgent: null } }, ...patch });
const org = (id, patch = {}) => ({ organizationId: id, agentWindowStart: T, agentWindowEnd: '2026-12-01T00:00:00.000Z', agentCommittedCredits: 7,
  agentCeilingCredits: 12000, openUnknownHolds: 0, aiPaused: false, ...patch });
const report = (patch = {}) => { const o = U(); return { from: T, to: '2026-11-02T00:00:00.000Z', asOf: T, truncated: false, schools: [school(o)], organizations: [org(o)],
  providerCostUnit: 'MICROUNITS_USD', ...patch }; };

test('S4-e contracts: per-school totals add up per class and per agent; credits never cross classes; estimates never count as provider charges', () => {
  assert.equal(contracts.validateAiSchoolUsageReport(report()).schools.length, 1);
  assert.equal(contracts.validateAiSchoolUsageReport(report({ schools: [], organizations: [] })).schools.length, 0);
  // 0238: Claire's analysis calls are their own agent, BUSINESS_PERFORMANCE, beside HON_REPLY.
  const withClaire = school(U(), { byClass: { AGENT_INFERENCE: { ...amt(7, 6000, 3, 900, 1), byAgent: { BUSINESS_PERFORMANCE: amt(4, 4000, 2, 900, 1), HON_REPLY: amt(3, 2000, 1) } },
    CREATIVE_MEDIA: { ...amt(50, 3000, 1), byAgent: null } } });
  assert.deepEqual(Object.keys(contracts.validateAiSchoolUsageReport(report({ schools: [withClaire], organizations: [org(withClaire.organizationId)] })).schools[0].byClass.AGENT_INFERENCE.byAgent).sort(), ['BUSINESS_PERFORMANCE', 'HON_REPLY']);
  const o = U();
  // Manus delta review P2: a school with only unresolved calls is listed with every amount zero and no class; it must
  // carry at least one unresolved call, and no amount may appear without a class (no invented cost).
  const unresolvedOnly = (patch = {}) => school(o, { ...totals(0, 0, 0, 0), unreconciledInvocations: 2, byClass: {}, ...patch });
  assert.equal(contracts.validateAiSchoolUsageReport(report({ schools: [unresolvedOnly()], organizations: [org(o, { openUnknownHolds: 2 })] })).schools[0].unreconciledInvocations, 2);
  for (const bad of [unresolvedOnly({ unreconciledInvocations: 0 }), unresolvedOnly({ providerReportedCostMicrounits: 1 }), unresolvedOnly({ entries: 1 }),
    unresolvedOnly({ estimatedWriteOffCostMicrounits: 1 }), unresolvedOnly({ lateProviderCostMicrounits: 1 }), unresolvedOnly({ entries: -1 })])
    assert.throws(() => contracts.validateAiSchoolUsageReport(report({ schools: [bad], organizations: [org(o)] })), JSON.stringify(bad).slice(0, 160));
  // The write-off estimate (900) now has a late actual (1100): reported beside, the three classified totals unchanged.
  const lateSchool = (patch = {}, l = late(1100, 1, 900)) => school(o, { ...totals(9000, 900, 4, 1, l),
    byClass: { AGENT_INFERENCE: { ...amt(7, 6000, 3, 900, 1, l), byAgent: { MARKETING: amt(4, 4000, 2, 900, 1, l), CHAD_FOLLOW_UP: amt(3, 2000, 1) } },
      CREATIVE_MEDIA: { ...amt(50, 3000, 1), byAgent: null } }, ...patch });
  assert.equal(contracts.validateAiSchoolUsageReport(report({ schools: [lateSchool()], organizations: [org(o)] })).schools[0].lateProviderCostMicrounits, 1100);
  for (const bad of [
    lateSchool({ lateProviderCostMicrounits: 0 }),                       // totals do not add up
    lateSchool({}, late(1100, 2, 900)),                                  // more late actuals than write-offs
    lateSchool({}, late(1100, 0, 0)),                                    // an amount with no late entry
    lateSchool({}, late(1100, 1, 1000)),                                 // superseded more than the estimate
    lateSchool({ ...totals(10100, 900, 4, 1, late(1100, 1, 900)) })])    // late actual folded into provider-reported
    assert.throws(() => contracts.validateAiSchoolUsageReport(report({ schools: [bad], organizations: [org(o)] })), JSON.stringify(bad).slice(0, 160));
  for (const bad of [
    report({ schools: [school(o, { entries: 5 })], organizations: [org(o)] }),
    report({ schools: [school(o, { providerReportedCostMicrounits: 9900 })], organizations: [org(o)] }),
    // An estimate folded into the provider-reported total, or an estimate with no write-off row, is drift.
    report({ schools: [school(o, { ...totals(9900, 0, 4, 1) })], organizations: [org(o)] }),
    report({ schools: [school(o, { byClass: { CREATIVE_MEDIA: { ...amt(1, 0, 1, 5, 0), byAgent: null } }, ...totals(0, 5, 1, 0) })], organizations: [org(o)] }),
    report({ schools: [school(o, { writeOffEntries: 5 })], organizations: [org(o)] }),
    report({ schools: [school(o, { unreconciledInvocations: -1 })], organizations: [org(o)] }),
    report({ schools: [school(o, { providerCostMicrounits: 9000 })], organizations: [org(o)] }),
    report({ schools: [school(o, { credits: 57 })], organizations: [org(o)] }),
    report({ schools: [school(o, { byClass: { IMAGES: { ...amt(1, 1, 1), byAgent: null } }, ...totals(1, 0, 1, 0) })], organizations: [org(o)] }),
    report({ schools: [school(o, { byClass: { AGENT_INFERENCE: { ...amt(1, 1, 1), byAgent: { KAI: amt(1, 1, 1) } } }, ...totals(1, 0, 1, 0) })], organizations: [org(o)] }),
    report({ schools: [school(o, { byClass: { AGENT_INFERENCE: { ...amt(1, 1, 2), byAgent: { MARKETING: amt(1, 1, 1) } } }, ...totals(1, 0, 2, 0) })], organizations: [org(o)] }),
    report({ schools: [school(o, { byClass: { CREATIVE_MEDIA: { ...amt(1, 1, 1), byAgent: {} } }, ...totals(1, 0, 1, 0) })], organizations: [org(o)] }),
    report({ schools: [school(U())] }),
    report({ providerCostUnit: 'USD' }), { ...report(), extra: 1 },
    report({ organizations: [org(o, { agentCommittedCredits: -1 })], schools: [] })])
    assert.throws(() => contracts.validateAiSchoolUsageReport(bad), JSON.stringify(bad).slice(0, 120));
  assert.deepEqual(contracts.validateAiSchoolUsageRange('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'), { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' });
  for (const [a, b] of [['2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z'], ['2026-11-02T00:00:00Z', '2026-11-01T00:00:00Z'], ['2026-01-01T00:00:00Z', '2026-11-01T00:00:00Z'],
    ['yesterday', '2026-11-01T00:00:00Z'], [undefined, '2026-11-01T00:00:00Z'], [['2026-10-01T00:00:00Z'], '2026-11-01T00:00:00Z']])
    assert.throws(() => contracts.validateAiSchoolUsageRange(a, b), `${a} ${b}`);
});

const send = (url, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); });
  req.on('error', reject); req.end();
});

test('HTTP: HQ school usage is a bounded read bound to the verified subject; bad ranges never reach the database', async () => {
  const calls = []; let next = null;
  const module = await Test.createTestingModule({ controllers: [AiSchoolUsageHqController],
    providers: [AiSchoolUsageService, SaasBillingService, SaasReadGuard, { provide: RuntimeDatabaseService, useValue: { async callSaasBilling(operation, params) {
      calls.push([operation, params]);
      if (next) { const e = new Error(next.message); e.code = next.code; next = null; throw e; }
      return report();
    } } }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(context) { context.switchToHttp().getRequest().honIdentity = { externalSubject: 'verified-human' }; return true; } }).compile();
  const app = module.createNestApplication({ bodyParser: false });
  app.use(json({ strict: true })); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/hq/ai/school-usage`;
  const h = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
  try {
    const ok = await send(`${base}?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z`, { headers: h });
    assert.equal(ok.status, 200, ok.body); assert.match(ok.headers['cache-control'], /no-store/);
    assert.deepEqual(calls.at(-1), ['readAiSchoolUsage', ['verified-human', '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z']]);
    for (const [code, status, expected] of [['42501', 403, 'SAAS_FORBIDDEN'], ['22023', 400, 'INVALID_SAAS_INPUT'], ['XX000', 503, 'SAAS_UNAVAILABLE']]) {
      next = { message: 'private detail', code };
      const r = await send(`${base}?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z`, { headers: h });
      assert.deepEqual([r.status, JSON.parse(r.body).code], [status, expected], code);
    }
    const n = calls.length;
    for (const [q, label] of [['', 'no range'], ['?from=2026-10-01T00:00:00Z', 'no end'], ['?from=2026-01-01T00:00:00Z&to=2026-11-01T00:00:00Z', 'over 92 days'],
      ['?from=2026-11-01T00:00:00Z&to=2026-10-01T00:00:00Z', 'reversed'], ['?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z&organizationId=x', 'extra query key'],
      ['?from=2026-10-01T00:00:00Z&from=2026-10-02T00:00:00Z&to=2026-11-01T00:00:00Z', 'repeated key']])
      assert.equal((await send(`${base}${q}`, { headers: h })).status, 400, label);
    assert.equal((await send(`${base}?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z`, { method: 'POST', headers: h })).status, 404, 'no write route');
    assert.equal(calls.length, n, 'refused requests never reach the database');
  } finally { await app.close(); }
});
