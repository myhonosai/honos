const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { ValidationPipe } = require('@nestjs/common');
const { GUARDS_METADATA, PATH_METADATA } = require('@nestjs/common/constants');
const { OperationsSummaryController } = require('../dist/reports/operations-summary.controller.js');
const { OperationsSummaryService } = require('../dist/reports/operations-summary.service.js');
const { OperationsReportQueryDto } = require('../dist/reports/operations-report.dto.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const org = '11111111-1111-4111-8111-111111111111';
const school = '22222222-2222-4222-8222-222222222222';
const from = '2026-06-01T00:00:00.000Z';
const to = '2026-06-02T00:00:00.000Z';
const states = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));
const metrics = () => ({
  studentProfiles: { total: 0, active: 0 }, leads: { byStatus: states(['OPEN', 'WON', 'LOST', 'ARCHIVED']) },
  classSessions: { inRange: { draft: 0, scheduled: 0, completed: 0, cancelled: 0 }, scheduledDueInRange: 0 },
  attendance: { inRangeByStatus: states(['PRESENT', 'LATE', 'EXCUSED_ABSENCE', 'UNEXCUSED_ABSENCE', 'MAKEUP']) },
  recentActivity: { crmActivitiesInRange: 0, attendanceEntriesRecordedInRange: 0 },
  invoices: { inRangeByStatus: states(['DRAFT', 'ISSUED', 'PAID', 'VOID', 'UNCOLLECTIBLE']), amountsByCurrency: [] },
});
const snapshot = () => ({ organizationId: org, entitlementTier: 'CORE', generatedAt: to, from, to,
  scope: 'AUTHORIZED_SCHOOLS_ONLY', schoolCount: 1, aggregate: metrics(), schools: [{ schoolId: school, metrics: metrics() }] });
const status = (expected, code) => (error) => { assert.equal(error.getStatus(), expected); if (code) assert.equal(error.getResponse().code, code); return true; };

test('organization route is human-guarded and forwards only the verified subject, organization and range', async () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, OperationsSummaryController), 'organizations/:organizationId/operations/summary');
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, OperationsSummaryController), [HonIdentityGuard]);
  const calls = [];
  const controller = new OperationsSummaryController({ read: async (...args) => { calls.push(args); return snapshot(); } });
  const response = await controller.read(org, { from, to }, { honIdentity: { externalSubject: 'verified' }, tier: 'COMPLETE', schoolId: 'evil', principalId: 'evil' });
  assert.deepEqual(calls, [['verified', org, { from, to }]]);
  assert.deepEqual(Object.keys(response.data), ['operationsSummary']);
  assert.equal(response.meta.requestId, response.meta.correlationId);
  await assert.rejects(() => controller.read(org, {}, {}), status(403));
});

test('global DTO validation rejects tier/school/principal injections and malformed dates', async () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  for (const value of [{ from, to, tier: 'COMPLETE' }, { from, to, schoolId: school }, { from, to, principalId: org }, { from: 'invalid', to }]) {
    await assert.rejects(() => pipe.transform(value, { type: 'query', metatype: OperationsReportQueryDto }), status(400));
  }
});

test('read service normalizes bounds and defaults, and allowlists all response fields', async () => {
  const calls = [];
  const row = snapshot(); row.rawInvoices = ['RAW']; row.schools[0].personId = 'RAW';
  row.aggregate.contacts = ['RAW']; row.aggregate.studentProfiles.principalId = 'RAW';
  const service = new OperationsSummaryService({ readOrganizationOperationsSummary: async (...args) => { calls.push(args); return row; } });
  const output = await service.read('verified', org, { from: '2026-06-01T01:00:00+01:00', to });
  assert.deepEqual(calls[0], ['verified', org, from, to]);
  assert.doesNotMatch(JSON.stringify(output), /RAW|personId|principalId|contacts|rawInvoices/);
  let defaultBounds;
  await new OperationsSummaryService({ readOrganizationOperationsSummary: async (subject, organizationId, start, end) => {
    defaultBounds = [start, end]; return { ...snapshot(), from: start, to: end };
  } }).read('verified', org, {});
  assert.equal(Date.parse(defaultBounds[1]) - Date.parse(defaultBounds[0]), 30 * 86400000);
});

test('uppercase route UUIDs are compared and returned in canonical database form', async () => {
  const mixedOrg = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
  const row = { ...snapshot(), organizationId: mixedOrg };
  const service = new OperationsSummaryService({ readOrganizationOperationsSummary: async (subject, organizationId) => {
    assert.equal(organizationId, mixedOrg); return row;
  } });
  assert.equal((await service.read('verified', mixedOrg.toUpperCase(), { from, to })).organizationId, mixedOrg);
});

test('range validation fails before any database read', async () => {
  const service = new OperationsSummaryService({ readOrganizationOperationsSummary: async () => { throw new Error('must not query'); } });
  for (const input of [{ from }, { from, to: from }, { from: '2026-06-01', to }, { from, to: '2026-10-01T00:00:00Z' }]) {
    await assert.rejects(() => service.read('verified', org, input), status(400, 'VALIDATION_FAILED'));
  }
});

test('live tier/permission database denials are sanitized and infrastructure errors are not misreported', async () => {
  for (const [message, expected] of [['TIER_ENTITLEMENT_REQUIRED', 'TIER_ENTITLEMENT_REQUIRED'], ['OPERATIONS_SUMMARY_FORBIDDEN', 'OPERATIONS_SUMMARY_FORBIDDEN'], ['RAW_DIRECTORY_DETAIL', 'OPERATIONS_SUMMARY_FORBIDDEN']]) {
    const service = new OperationsSummaryService({ readOrganizationOperationsSummary: async () => { throw Object.assign(new Error(message), { code: '42501' }); } });
    await assert.rejects(() => service.read('verified', org, { from, to }), (error) => { status(403, expected)(error); assert.doesNotMatch(JSON.stringify(error.getResponse()), /RAW_/); return true; });
  }
  const failure = Object.assign(new Error('database unavailable'), { code: '08006' });
  const service = new OperationsSummaryService({ readOrganizationOperationsSummary: async () => { throw failure; } });
  await assert.rejects(() => service.read('verified', org, { from, to }), (error) => error === failure);
});

test('response validation fails closed on scope, tier, duplicate school, or unsafe numeric totals', async () => {
  const cases = [
    (row) => { row.entitlementTier = 'ESSENTIAL'; }, (row) => { row.organizationId = school; },
    (row) => { row.schoolCount = 2; }, (row) => { row.scope = 'ALL_SCHOOLS'; },
    (row) => { row.schools.push(row.schools[0]); row.schoolCount = 2; },
    (row) => { row.aggregate.studentProfiles.active = Number.MAX_SAFE_INTEGER + 1; },
    (row) => { row.aggregate.invoices.amountsByCurrency = [{ currency: 'USD', totalMinorByStatus: { ...metrics().invoices.inRangeByStatus, ISSUED: Number.MAX_SAFE_INTEGER + 1 } }]; },
    (row) => { row.aggregate.studentProfiles.total = -1; },
  ];
  for (const mutate of cases) {
    const row = snapshot(); mutate(row);
    const service = new OperationsSummaryService({ readOrganizationOperationsSummary: async () => row });
    await assert.rejects(() => service.read('verified', org, { from, to }), /Invalid HON operations summary/);
  }
});
