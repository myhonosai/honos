const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MonthlyGoalPlanController } = require('../dist/planning/monthly-goal-plan.controller.js');
const { MonthlyGoalPlanService } = require('../dist/planning/monthly-goal-plan.service.js');
const { validateMonthlyGoalPlanQuery, verifyMonthlyGoalPlan } = require('@hon/contracts');

// G1 (0686): the controller's closed query, the contract's validation and verification, and the service's error mapping.
const ORG = '11111111-1111-4111-8111-111111111111';
const SCHOOL = '22222222-2222-4222-8222-222222222222';
const request = { honIdentity: { externalSubject: 'staff-subject' } };
const scopeDatabase = (scope = { organizationId: ORG, schoolId: SCHOOL, principalId: '33333333-3333-4333-8333-333333333333' }) => ({
  calls: [],
  async resolveAuthorizedScope(subject, schoolId, permission) { this.calls.push([subject, schoolId, permission]); return scope; },
});
const recordingPlans = () => ({ inputs: [], async read(context, input) { this.inputs.push([context, input]); return { ok: true }; } });
const code = async (promise) => { try { await promise; return null; } catch (error) { return error.getResponse().code; } };

test('monthly goal plan controller: only the named string keys pass; reporting.view is resolved from the session', async () => {
  const database = scopeDatabase(), plans = recordingPlans();
  const controller = new MonthlyGoalPlanController(database, plans);
  await controller.read(ORG, SCHOOL, undefined, {}, request);
  await controller.read(ORG, SCHOOL, undefined, { month: '2026-12', goalMinor: '100', currency: 'USD', bookRate: '0.5' }, request);
  assert.deepEqual(plans.inputs.map((entry) => entry[1]), [{}, { month: '2026-12', goalMinor: '100', currency: 'USD', bookRate: '0.5' }]);
  assert.deepEqual(database.calls[0], ['staff-subject', SCHOOL, 'reporting.view']);
  assert.equal(plans.inputs[0][0].source, 'HUMAN_UI');
  for (const query of [{ school: SCHOOL }, { month: ['2026-01', '2026-02'] }, { programId: 'x' }]) {
    assert.equal(await code(controller.read(ORG, SCHOOL, undefined, query, request)), 'VALIDATION_FAILED', JSON.stringify(query));
  }
  assert.equal(await code(controller.read(ORG, SCHOOL, 'key-1', {}, request)), 'IDEMPOTENCY_KEY_NOT_ACCEPTED');
  const other = new MonthlyGoalPlanController(scopeDatabase({ organizationId: '44444444-4444-4444-8444-444444444444', schoolId: SCHOOL, principalId: 'p' }), recordingPlans());
  assert.equal(await code(other.read(ORG, SCHOOL, undefined, {}, request)), 'MONTHLY_GOAL_PLAN_FORBIDDEN');
  const none = new MonthlyGoalPlanController({ async resolveAuthorizedScope() { return undefined; } }, recordingPlans());
  assert.equal(await code(none.read(ORG, SCHOOL, undefined, {}, request)), 'MONTHLY_GOAL_PLAN_FORBIDDEN');
});

test('monthly goal plan query: typed values, paired keys, closed ranges', () => {
  assert.deepEqual(validateMonthlyGoalPlanQuery({ month: '2026-12', goalMinor: '500000', currency: 'USD', historyMonths: '12', showRate: '0.8333',
    renewalRate: '1', avgNewMinor: '15000', plannedUpgrades: '4', upgradeValueMinor: '5000' }),
  { month: '2026-12', goalMinor: 500000, currency: 'USD', historyMonths: 12, showRate: 0.8333, renewalRate: 1, avgNewMinor: 15000, plannedUpgrades: 4, upgradeValueMinor: 5000 });
  for (const value of [{ goalMinor: '1' }, { currency: 'USD' }, { plannedUpgrades: '1' }, { goalMinor: '01', currency: 'USD' }, { goalMinor: '1.5', currency: 'USD' },
    { month: '2026-13' }, { month: '1999-01' }, { historyMonths: '2' }, { bookRate: '0' }, { bookRate: '1.01' }, { bookRate: '0.12345' }, { bookRate: '.5' },
    { avgNewMinor: '0' }, { currency: 'usd', goalMinor: '1' }, { other: '1' }, { month: 202612 }]) {
    assert.throws(() => validateMonthlyGoalPlanQuery(value), /VALIDATION_FAILED/, JSON.stringify(value));
  }
});

const rate = (numerator, denominator, value = numerator / denominator, source = 'RECORDS') => ({ numerator, denominator, minimumRecords: 10, recordValue: value, value, source });
const pace = (actual, needed, status) => ({ actual, needed, expectedByNow: needed, remaining: needed === null ? null : Math.max(needed - actual, 0), perWeek: needed === null ? null : 1, status });
const plan = () => ({
  schemaVersion: 'MONTHLY_GOAL_PLAN_V1', schoolId: SCHOOL, timezone: 'America/Los_Angeles', month: '2026-11', currentMonth: '2026-11',
  from: '2026-11-01T07:00:00.000Z', to: '2026-12-01T08:00:00.000Z', generatedAt: '2026-11-15T08:00:00.000Z', elapsedShare: 0.48, weeksLeft: 3,
  history: { months: 6, from: '2026-05-01T07:00:00.000Z', to: '2026-11-01T07:00:00.000Z' },
  suggestedGoals: [{ currency: 'USD', monthlyMinor: 10000, months: 3 }], goal: { currency: 'USD', goalMinor: 500000 },
  rates: { renewal: rate(6, 10), book: rate(12, 20), show: rate(10, 12, 0.8333), close: rate(5, 10) },
  renewals: { due: 6, renewed: 2, cancelled: 1, lapsed: 0, open: 3, openPriced: 3, openValueMinor: 60000, expectedRenewals: 2, expectedValueMinor: 36000 },
  averageNewMembership: { records: 5, minimumRecords: 5, recordValueMinor: 15000, valueMinor: 15000, source: 'RECORDS' },
  sources: { collectedMinor: 5000, scheduled: { schedules: 2, valueMinor: 22500 }, renewalsMinor: 36000, upgrades: { planned: 0, valueEachMinor: null, valueMinor: 0 }, gapMinor: 436500 },
  needed: { renewals: 4, upgrades: 0, newEnrollments: 30, shows: 60, appointments: 73, leads: 122 },
  pace: { collected: pace(5000, 500000, 'BEHIND'), renewals: pace(2, 4, 'ON_PACE'), newEnrollments: pace(1, 30, 'BEHIND'), shows: pace(0, 60, 'BEHIND'),
    appointments: pace(1, 73, 'BEHIND'), leads: pace(2, 122, 'BEHIND') },
});
const query = { goalMinor: 500000, currency: 'USD' };

test('monthly goal plan verifier: accepts the exact shape and refuses inconsistent plans', () => {
  assert.equal(verifyMonthlyGoalPlan(plan(), SCHOOL, query).needed.leads, 122);
  const broken = [
    (p) => { p.schoolId = ORG; },
    (p) => { p.extra = 1; },
    (p) => { p.renewals.open = 4; },
    (p) => { p.rates.book.numerator = 21; },
    (p) => { p.rates.book.source = 'OWNER'; },
    (p) => { p.rates.close.value = null; },
    (p) => { p.goal.goalMinor = 1; },
    (p) => { p.month = '2026-12'; },
    (p) => { p.pace.leads.status = 'GREAT'; },
    (p) => { p.pace.leads.needed = null; },
    (p) => { p.needed.leads = -1; },
    (p) => { p.elapsedShare = 1.5; },
    (p) => { p.sources.upgrades.planned = 2; },
    (p) => { p.history.months = 7; },
  ];
  for (const change of broken) {
    const value = plan(); change(value);
    assert.throws(() => verifyMonthlyGoalPlan(value, SCHOOL, query), /Unverified/, change.toString());
  }
  const owner = plan(); owner.rates.book = rate(12, 20, 0.25, 'OWNER'); owner.rates.book.recordValue = 0.6;
  assert.equal(verifyMonthlyGoalPlan(owner, SCHOOL, { ...query, bookRate: 0.25 }).rates.book.value, 0.25);
  assert.throws(() => verifyMonthlyGoalPlan(owner, SCHOOL, { ...query, bookRate: 0.3 }), /Unverified/);
  const bare = plan(); Object.assign(bare, { goal: null, needed: null, sources: null, pace: null, averageNewMembership: null });
  bare.renewals.openValueMinor = null; bare.renewals.expectedValueMinor = null;
  assert.equal(verifyMonthlyGoalPlan(bare, SCHOOL, {}).goal, null);
  const leaked = plan(); leaked.goal = null;
  assert.throws(() => verifyMonthlyGoalPlan(leaked, SCHOOL, query), /Unverified/);
});

const context = { organizationId: ORG, schoolId: SCHOOL, principalId: 'p', principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: 'staff-subject',
  requestId: 'r', correlationId: 'r', idempotencyKey: '' };
const pgError = (sqlState, message) => Object.assign(new Error(message), { code: sqlState });
test('monthly goal plan service: fixed error codes, query refused before the database', async () => {
  const failing = (error) => ({ async withTenantReadOnlyTransaction(_c, work) { return work({ async query(text) { if (/read_monthly_goal_plan/.test(text)) throw error; return { rows: [] }; } }); } });
  for (const [error, status, expected] of [[pgError('22023', 'SCHOOL_TIMEZONE_INVALID'), 409, 'SCHOOL_TIMEZONE_INVALID'], [pgError('42501', 'SCHOOL_REPORTS_FORBIDDEN'), 403, 'MONTHLY_GOAL_PLAN_FORBIDDEN'],
    [pgError('22023', 'VALIDATION_FAILED'), 400, 'VALIDATION_FAILED'], [new Error('connection lost'), 503, 'MONTHLY_GOAL_PLAN_UNAVAILABLE']]) {
    await assert.rejects(new MonthlyGoalPlanService(failing(error)).read(context, {}),
      (refusal) => refusal.getStatus() === status && refusal.getResponse().code === expected && !/connection/.test(JSON.stringify(refusal.getResponse())));
  }
  const unverified = { async withTenantReadOnlyTransaction(_c, work) { return work({ async query(text) { return { rows: /read_monthly_goal_plan/.test(text) ? [{ data: { schemaVersion: 'X' } }] : [] }; } }); } };
  await assert.rejects(new MonthlyGoalPlanService(unverified).read(context, {}), (refusal) => refusal.getStatus() === 503);
  let touched = false;
  const service = new MonthlyGoalPlanService({ async withTenantReadOnlyTransaction() { touched = true; } });
  await assert.rejects(service.read(context, { goalMinor: '1' }), (error) => error.getStatus() === 400);
  await assert.rejects(service.read({ ...context, source: 'AI_AGENT' }, {}), (error) => error.getStatus() === 403);
  assert.equal(touched, false);
});
