const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { GUARDS_METADATA, PATH_METADATA } = require('@nestjs/common/constants');
const { OperationsReportController } = require('../dist/reports/operations-report.controller.js');
const { OperationsReportService } = require('../dist/reports/operations-report.service.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');

const organizationId = '11111111-1111-4111-8111-111111111111';
const schoolId = '22222222-2222-4222-8222-222222222222';
const from = '2026-06-01T00:00:00.000Z';
const to = '2026-06-02T00:00:00.000Z';
const counts = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));
const snapshot = () => ({
  organizationId, schoolId, generatedAt: to, from, to,
  studentProfiles: { total: 0 },
  leads: { byStatus: counts(['OPEN', 'WON', 'LOST', 'ARCHIVED']) },
  classSessions: { inRange: counts(['scheduled', 'completed', 'cancelled']) },
  attendance: { inRangeByStatus: counts(['PRESENT', 'LATE', 'EXCUSED_ABSENCE', 'UNEXCUSED_ABSENCE', 'MAKEUP']) },
  memberships: { byState: counts(['DRAFT', 'ACTIVE', 'FROZEN', 'CANCELLATION_PENDING', 'CANCELLED', 'EXPIRED']) },
  invoices: { inRangeByStatus: counts(['DRAFT', 'ISSUED', 'PAID', 'VOID', 'UNCOLLECTIBLE']) },
  paymentAttempts: { inRangeByState: counts(['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'REQUIRES_ACTION', 'UNKNOWN', 'REFUNDED']) },
});
const status = (expected) => (error) => { assert.equal(error.getStatus(), expected); return true; };

test('school operations report is human-guarded and does not treat route IDs as dashboard authority', async () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, OperationsReportController), 'organizations/:organizationId/schools/:schoolId/reports/operations');
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, OperationsReportController), [HonIdentityGuard]);
  const calls = [];
  const controller = new OperationsReportController({
    resolveAuthorizedScope: async (...args) => { calls.push(args); return { principalId: '33333333-3333-4333-8333-333333333333', organizationId, schoolId }; },
  }, { read: async (context, query) => { assert.equal(context.principalType, 'HUMAN_USER'); assert.deepEqual(query, { from, to }); return snapshot(); } });
  const result = await controller.read(organizationId, schoolId, { from, to }, { honIdentity: { externalSubject: 'verified-staff' }, principalId: 'forged', tier: 'COMPLETE' });
  assert.deepEqual(calls, [['verified-staff', schoolId, 'reporting.view']]);
  assert.deepEqual(Object.keys(result.data), ['operationalSnapshot']);
  assert.equal(result.meta.requestId, result.meta.correlationId);
});

test('HQ-only, parent-only, cross-organization, and unauthenticated identities are denied before a report read', async () => {
  const denied = new OperationsReportController({ resolveAuthorizedScope: async (subject) => {
    if (subject === 'cross-org') return { principalId: '33333333-3333-4333-8333-333333333333', organizationId: schoolId, schoolId };
    return undefined;
  } }, { read: async () => { throw new Error('report must not be read'); } });
  for (const subject of ['hq-only', 'parent-only', 'cross-org']) {
    await assert.rejects(() => denied.read(organizationId, schoolId, {}, { honIdentity: { externalSubject: subject } }), status(403));
  }
  await assert.rejects(() => denied.read(organizationId, schoolId, {}, {}), status(403));
});

test('operations snapshot service allowlists aggregate output and excludes injected PII/private evidence', async () => {
  const selected = { generatedAt: to, studentProfilesTotal: 3, leadOpen: 4, leadWon: 1, leadLost: 2, leadArchived: 0,
    sessionsScheduled: 5, sessionsCompleted: 6, sessionsCancelled: 7, attendancePresent: 8, attendanceLate: 9, attendanceExcusedAbsence: 10, attendanceUnexcusedAbsence: 11, attendanceMakeup: 12,
    membershipsDraft: 0, membershipsActive: 13, membershipsFrozen: 1, membershipsCancellationPending: 2, membershipsCancelled: 3, membershipsExpired: 4,
    invoicesDraft: 0, invoicesIssued: 5, invoicesPaid: 6, invoicesVoid: 7, invoicesUncollectible: 8,
    paymentsPending: 0, paymentsProcessing: 1, paymentsSucceeded: 2, paymentsFailed: 3, paymentsRequiresAction: 4, paymentsUnknown: 5, paymentsRefunded: 6,
    personName: 'PRIVATE_PERSON', rawNote: 'PRIVATE_NOTE', paymentMethodToken: 'PRIVATE_TOKEN', actionEvidence: { private: true } };
  let sql = '';
  const service = new OperationsReportService({ withTenantTransaction: async (_context, work) => work({ query: async (statement) => { sql = statement; return { rows: [selected] }; } }) });
  const output = await service.read({ organizationId, schoolId, principalId: '33333333-3333-4333-8333-333333333333', principalType: 'HUMAN_USER', requestId: '44444444-4444-4444-8444-444444444444' }, { from, to });
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE_|personName|rawNote|paymentMethodToken|actionEvidence/);
  assert.deepEqual(Object.keys(output), ['organizationId', 'schoolId', 'generatedAt', 'from', 'to', 'studentProfiles', 'leads', 'classSessions', 'attendance', 'memberships', 'invoices', 'paymentAttempts']);
  assert.doesNotMatch(sql, /notes|payment_method|provider|action_requests|action_approvals/i);
});
