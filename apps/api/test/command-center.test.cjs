const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { GUARDS_METADATA, PATH_METADATA } = require('@nestjs/common/constants');
const { CommandCenterController } = require('../dist/reports/command-center.controller.js');
const { CommandCenterService, commandCenterBriefing, commandCenterRecommendations } = require('../dist/reports/command-center.service.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');

const organizationId = '11111111-1111-4111-8111-111111111111';
const schoolId = '22222222-2222-4222-8222-222222222222';
const generatedAt = '2026-06-02T00:00:00.000Z';
const hour = 86_400_000;
const status = (expected, code) => (error) => { assert.equal(error.getStatus(), expected); if (code) assert.equal(error.getResponse().code, code); return true; };
const available = (count, from, to) => from ? { availability: 'AVAILABLE', windowFrom: from, windowTo: to, count } : { availability: 'AVAILABLE', count };
const raw = () => ({
  organizationId, schoolId, entitlementTier: 'ESSENTIAL', generatedAt,
  metrics: {
    newLeads24h: available(2, new Date(Date.parse(generatedAt) - hour).toISOString(), generatedAt),
    upcomingTrials24h: available(1, generatedAt, new Date(Date.parse(generatedAt) + hour).toISOString()),
    upcomingTestingEvents30d: available(1, generatedAt, new Date(Date.parse(generatedAt) + 30 * hour).toISOString()),
    pendingActionApprovals: available(3), outstandingWorkItems: available(4),
    membershipTermsEnding30d: available(5, generatedAt, new Date(Date.parse(generatedAt) + 30 * hour).toISOString()),
    paidInvoicesCreated30d: { availability: 'AVAILABLE', windowFrom: new Date(Date.parse(generatedAt) - 30 * hour).toISOString(), windowTo: generatedAt, count: 2, amountsByCurrency: [{ currency: 'USD', count: 2, totalMinor: 4500 }] },
    unansweredInquiries: { availability: 'UNAVAILABLE', reason: 'No approved inquiry response-state projection exists.' },
    attendanceDecline: { availability: 'INSUFFICIENT_DATA', reason: 'No approved attendance-decline policy or longitudinal projection exists.' },
    trialConversion: { availability: 'UNAVAILABLE', reason: 'No authoritative trial-to-enrollment linkage is available.' },
    revenue: { availability: 'UNAVAILABLE', reason: 'Current paid invoice state is not authoritative cash revenue or collection data.' },
  },
});

test('Command Center route is identity-guarded, has only known school selectors, and forwards no tier/principal/action authority', async () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, CommandCenterController), 'organizations/:organizationId/schools/:schoolId/command-center');
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, CommandCenterController), [HonIdentityGuard]);
  const calls = []; const controller = new CommandCenterController({ read: async (...args) => { calls.push(args); return { ...raw(), dailyBriefing: 'derived', recommendations: [] }; } });
  const response = await controller.read(organizationId, schoolId, {}, { honIdentity: { externalSubject: 'verified' }, tier: 'COMPLETE', principalId: 'evil', actionAuthority: 'AUTO' });
  assert.deepEqual(calls, [['verified', organizationId, schoolId]]);
  assert.deepEqual(Object.keys(response.data), ['commandCenter']); assert.equal(response.meta.requestId, response.meta.correlationId);
  await assert.rejects(() => controller.read(organizationId, schoolId, { tier: 'COMPLETE' }, { honIdentity: { externalSubject: 'verified' } }), status(400, 'VALIDATION_FAILED'));
  await assert.rejects(() => controller.read(organizationId, schoolId, {}, {}), status(403, 'COMMAND_CENTER_FORBIDDEN'));
});

test('service calls only the fixed fact projection and derives stable presentation from facts', async () => {
  const calls = []; const source = raw();
  const service = new CommandCenterService({ readSchoolCommandCenter: async (...args) => { calls.push(args); return source; } });
  const result = await service.read('verified', organizationId.toUpperCase(), schoolId.toUpperCase());
  assert.deepEqual(calls, [['verified', organizationId, schoolId]]);
  assert.deepEqual(Object.keys(result), ['organizationId', 'schoolId', 'entitlementTier', 'generatedAt', 'metrics', 'dailyBriefing', 'recommendations']);
  assert.equal(result.entitlementTier, 'ESSENTIAL');
  assert.equal(result.dailyBriefing, 'Daily briefing: 2 new leads in the last 24 hours; 1 trial appointment scheduled in the next 24 hours; 1 testing event in the next 30 days; 5 membership terms ending in the next 30 days; 3 action approvals awaiting review; 4 outstanding durable work items.');
  assert.deepEqual(result.recommendations.map(item => item.id), ['REVIEW_PENDING_APPROVALS', 'REVIEW_OUTSTANDING_WORK', 'PREPARE_UPCOMING_TRIALS', 'REVIEW_NEW_LEADS', 'PREPARE_MEMBERSHIP_RENEWALS']);
  assert(result.recommendations.every(item => item.automaticExecution === false && item.action === 'NAVIGATE' && item.route.startsWith('/staff/')));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|email|principalId|personId|provider|paymentAttempt|actionRequestId/i);
});

test('all-zero facts produce a stable empty briefing and no navigation recommendation', () => {
  const facts = raw().metrics;
  for (const key of ['newLeads24h', 'upcomingTrials24h', 'upcomingTestingEvents30d', 'pendingActionApprovals', 'outstandingWorkItems', 'membershipTermsEnding30d', 'paidInvoicesCreated30d']) facts[key].count = 0;
  facts.paidInvoicesCreated30d.amountsByCurrency = [];
  assert.equal(commandCenterBriefing(facts), 'Daily briefing: no counted priorities are currently recorded in the available Command Center metrics.');
  assert.deepEqual(commandCenterRecommendations(facts), []);
});

test('strict output rejects PII-shaped fields, unknown fields, invalid unavailable states, unsafe totals, bad windows, routes, and scope mismatch', async () => {
  const cases = [
    value => { value.organizationId = schoolId; },
    value => { value.rawPii = 'PRIVATE_EMAIL'; },
    value => { value.metrics.newLeads24h.personName = 'PRIVATE_PERSON'; },
    value => { value.metrics.rawProvider = 'PRIVATE_TOKEN'; },
    value => { value.metrics.pendingActionApprovals.count = -1; },
    value => { value.metrics.upcomingTrials24h.windowTo = value.metrics.upcomingTrials24h.windowFrom; },
    value => { value.metrics.paidInvoicesCreated30d.amountsByCurrency[0].currency = 'usd'; },
    value => { value.metrics.paidInvoicesCreated30d.amountsByCurrency[0].totalMinor = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.metrics.trialConversion.reason = 'invented'; },
    value => { value.metrics.unansweredInquiries.availability = 'INSUFFICIENT_DATA'; },
    value => { value.entitlementTier = 'HQ'; },
  ];
  for (const mutate of cases) {
    const source = raw(); mutate(source);
    await assert.rejects(() => new CommandCenterService({ readSchoolCommandCenter: async () => source }).read('verified', organizationId, schoolId), /Invalid HON Command Center/);
  }
});

test('live scope/tier denials fail closed and are sanitized; infrastructure errors are not relabeled', async () => {
  for (const [message, code] of [['TIER_ENTITLEMENT_REQUIRED', 'TIER_ENTITLEMENT_REQUIRED'], ['COMMAND_CENTER_FORBIDDEN', 'COMMAND_CENTER_FORBIDDEN'], ['PRIVATE_DIRECTORY', 'COMMAND_CENTER_FORBIDDEN']]) {
    const service = new CommandCenterService({ readSchoolCommandCenter: async () => { throw Object.assign(new Error(message), { code: '42501' }); } });
    await assert.rejects(() => service.read('verified', organizationId, schoolId), error => { status(403, code)(error); assert.doesNotMatch(JSON.stringify(error.getResponse()), /PRIVATE_/); return true; });
  }
  const failure = Object.assign(new Error('unavailable'), { code: '08006' });
  await assert.rejects(() => new CommandCenterService({ readSchoolCommandCenter: async () => { throw failure; } }).read('verified', organizationId, schoolId), error => error === failure);
});
