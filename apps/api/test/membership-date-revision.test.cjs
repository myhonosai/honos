const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const { readFileSync } = require('node:fs');
const { MembershipDateRevisionService } = require('../dist/billing/membership-date-revision.service.js');
const { MembershipDateRevisionController } = require('../dist/billing/membership-date-revision.controller.js');
const { MembershipStatusReportController } = require('../dist/reports/membership-status-report.controller.js');
const { MembershipDateHistoryHumanUiGuard, MembershipDatePreviewHumanUiGuard, MembershipDateQueueHumanUiGuard, MembershipDateRevisionHumanUiGuard,
  MembershipStatusSummaryHumanUiGuard } = require('../dist/billing/membership-activation-human-ui.guard.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');

// Mocked boundary tests for the 0178 membership date revision API. The database behaviour itself (authority, locks,
// history, dates, idempotency, financial separation) is proven against PostgreSQL by test-membership-date-revision-integrity.mjs.
const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const id = randomUUID();
const subject = 'verified-human';
const context = (patch = {}) => ({ ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: 'revision-key',
  externalSubject: subject, ...patch });
const readContext = (patch = {}) => context({ idempotencyKey: '', ...patch });
const status = (value, code) => (error) => { assert.equal(error.getStatus(), value); if (code) assert.equal(error.getResponse().code, code); return true; };
const digest = 'b'.repeat(64);
const REQUIREMENTS = ['AGREEMENT', 'PAYMENT', 'RECURRING_PAYMENT_AUTHORIZATION', 'FINANCIAL_RESPONSIBILITY', 'SCHOOL_ACTIVATION_POLICY'];
const CONFIRMATION = 'I_CONFIRM_MEMBERSHIP_DATE_CHANGE_NO_PAYMENT_INVOICE_REFUND_OR_AGREEMENT_CHANGE';
const LA = 'America/Los_Angeles';
const period = (patch = {}) => ({ source: 'ACTIVATION', periodVersion: 1, changeKind: 'INITIAL', startDate: '2026-10-22', endDate: null, endDateInclusive: true, schoolTimezone: LA,
  termStartedAt: '2026-10-22T07:00:00.000Z', termEndsAt: null, ...patch });
const previewRow = (patch = {}) => ({ membershipId: id, state: 'ACTIVE', version: 2, participantPersonId: randomUUID(), participantDisplayName: 'Avery Local', planCode: 'KNOWN',
  plan: null, schoolTimezone: LA, localToday: '2026-10-22', changeKind: 'EARLY_END', currentPeriod: period(), legacyStoredTerm: null, suggestedDates: null,
  proposedDates: { startDate: '2026-10-22', endDate: '2026-12-31', dateSource: 'STAFF_ENTERED' }, projection: { termStartedAt: '2026-10-22T07:00:00.000Z', termEndsAt: '2027-01-01T08:00:00.000Z' },
  effectiveStatusNow: 'IN_EFFECT', effectiveStatusIfConfirmedNow: 'IN_EFFECT', retroactiveDays: { added: 0, removed: 0 },
  financialFacts: { schedules: [], schedulesTruncated: false, invoices: [{ invoiceId: randomUUID(), status: 'PAID', dueDate: '2026-10-22' }], invoicesTruncated: false },
  warnings: [{ code: 'PAID_INVOICE_NOT_REFUNDED_OR_CREDITED' }], blocks: [], requiredPermissions: ['billing.membership.dates.revise'], requirementsNotEvaluated: REQUIREMENTS,
  canConfirm: true, previewDigest: digest, confirmation: CONFIRMATION, ...patch });
const receiptRow = (patch = {}) => ({ membershipId: id, state: 'ACTIVE', version: 3, previousVersion: 2, revisionId: randomUUID(), changeKind: 'EARLY_END',
  decisionBasis: 'STAFF_REVISION_PRE_POLICY', authorizingPermission: 'billing.membership.dates.revise', retroactivePermission: null,
  previousPeriod: { periodVersion: 1, startDate: '2026-10-22', endDate: null, legacyTermStartedAt: null, legacyTermEndsAt: null },
  effectivePeriod: { periodVersion: 2, startDate: '2026-10-22', endDate: '2026-12-31', endDateInclusive: true, schoolTimezone: LA, dateSource: 'STAFF_ENTERED',
    termStartedAt: '2026-10-22T07:00:00.000Z', termEndsAt: '2027-01-01T08:00:00.000Z' }, effectiveStatusAtRevision: 'IN_EFFECT', retroactiveDays: { added: 0, removed: 0 },
  acknowledgedWarnings: ['PAID_INVOICE_NOT_REFUNDED_OR_CREDITED'], reasonCode: 'MEMBER_REQUESTED', financialEffects: [], followUps: [{ kind: 'BILLING_REVIEW', workItemId: randomUUID() }],
  requirementsNotEvaluated: REQUIREMENTS, approval: null, recordedAt: '2026-10-22T18:00:00.000Z', ...patch });
const historyRow = () => ({ membershipId: id, state: 'ACTIVE', version: 2, schoolTimezone: LA, localToday: '2026-10-22', effectiveStatus: 'IN_EFFECT', datesConfirmed: true,
  currentPeriod: period(), legacyStoredTerm: null, versions: [{ periodVersion: 1, changeKind: 'INITIAL', startDate: '2026-10-22', endDate: null, schoolTimezone: LA, dateSource: 'SUGGESTED',
    reasonCode: 'ROUTINE_ENROLLMENT', reasonText: null, actorDisplayName: 'Owner', recordedAt: '2026-10-22T18:00:00.000Z', retroactiveDays: null, acknowledgedWarnings: [] }] });
const summaryRow = (patch = {}) => ({ organizationId: scope.organizationId, schoolId: scope.schoolId, generatedAt: '2026-10-22T18:00:00.000Z', schoolTimezone: LA, localToday: '2026-10-22',
  windowEndDate: '2026-11-21', lifecycle: { DRAFT: 1, ACTIVE: 4, FROZEN: 0, CANCELLATION_PENDING: 0, CANCELLED: 1, EXPIRED: 0 },
  activeByEffectiveStatus: { SCHEDULED: 1, IN_EFFECT: 1, ENDED: 1, UNDATED: 1 }, undatedHints: { storedTermInEffect: 0, storedTermEnded: 0, storedTermFuture: 0, noStoredStart: 1 },
  confirmedStartingNext30Days: 1, confirmedEndingNext30Days: 1, ...patch });
const confirmation = (patch = {}) => ({ expectedVersion: 2, expectedPeriodVersion: 1, previewDigest: digest, changeKind: 'EARLY_END', startDate: '2026-10-22', endDate: '2026-12-31',
  dateSource: 'STAFF_ENTERED', acknowledgedWarnings: ['PAID_INVOICE_NOT_REFUNDED_OR_CREDITED'], reasonCode: 'MEMBER_REQUESTED', reasonText: 'Member is moving at year end.',
  confirmation: CONFIRMATION, ...patch });

function fixture(options = {}) {
  const queries = [];
  const db = {
    resolveAuthorizedScope: async (_subject, _school, permission) => {
      if (options.scopes) return options.scopes[permission] ?? undefined;
      return options.scope === undefined ? scope : options.scope;
    },
    async transaction(c, work, readOnly) {
      return work({ query: async (sql, args = []) => {
        queries.push({ sql, args, readOnly, context: c });
        // The service never touches memberships, money, agreements or providers itself: only the protected functions do.
        assert.doesNotMatch(sql, /(INSERT|UPDATE|DELETE)\s|hon\.(?:memberships|agreements|document_\w+|payment_\w+|membership_payment_schedules|invoices|communication_\w+|action_requests|ai_\w+|billing_accounts)\b/);
        if (/^SET LOCAL/.test(sql) || /set_config\('app\.hon_source','HUMAN_UI'/.test(sql)) return { rows: [] };
        if (options.error) throw options.error;
        if (/hon\.preview_membership_date_revision\(\$1,\$2::uuid,\$3::jsonb\)/.test(sql)) return { rows: [{ data: options.preview ?? previewRow() }] };
        if (/hon\.revise_membership_dates\(\$1,\$2::uuid,\$3::jsonb,\$4,\$5::uuid,\$6::uuid\)/.test(sql)) return { rows: [{ data: options.revision ?? { receipt: receiptRow(), replayed: false } }] };
        if (/hon\.read_membership_date_history\(\$1,\$2::uuid\)/.test(sql)) return { rows: [{ data: options.history ?? historyRow() }] };
        if (/hon\.read_membership_date_confirmation_queue\(\$1,\$2::jsonb\)/.test(sql)) return { rows: [{ data: options.queue ?? { items: [], next: null } }] };
        if (/hon\.read_school_membership_status_summary\(\$1\)/.test(sql)) return { rows: [{ data: options.summary ?? summaryRow() }] };
        throw new Error('Unexpected SQL: ' + sql);
      } });
    },
    withTenantTransaction(c, work) { return this.transaction(c, work, false); },
    withTenantReadOnlyTransaction(c, work) { return this.transaction(c, work, true); },
  };
  return { db, queries, calls: (name) => queries.filter((q) => q.sql.includes(name)) };
}

test('preview is one read-only protected call with the exact subject, membership and closed body; no idempotency key', async () => {
  const f = fixture(), svc = new MembershipDateRevisionService(f.db);
  const p = await svc.preview(readContext(), id, { changeKind: 'EARLY_END', startDate: '2026-10-22', endDate: '2026-12-31' });
  assert.equal(p.previewDigest, digest); assert.equal(p.canConfirm, true);
  const [call] = f.calls('preview_membership_date_revision');
  assert.equal(call.readOnly, true); assert.deepEqual(call.args, [subject, id, '{"changeKind":"EARLY_END","startDate":"2026-10-22","endDate":"2026-12-31"}']);
  assert.ok(f.queries.every((q) => q.readOnly)); assert.deepEqual(f.calls('set_config')[0].args, [subject]);
  await svc.preview(readContext(), id, { changeKind: 'EXTENSION' }); assert.equal(f.calls('preview_membership_date_revision')[1].args[2], '{"changeKind":"EXTENSION"}');
  await assert.rejects(() => svc.preview(context(), id, { changeKind: 'EXTENSION' }), status(409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED'));
  for (const value of [{}, { changeKind: 'RENEWAL' }, { changeKind: 'EXTENSION', startDate: '2026-10-22' }, { changeKind: 'EXTENSION', endDate: null },
    { changeKind: 'EXTENSION', startDate: '2026-02-30', endDate: null }, { changeKind: 'EXTENSION', startDate: '2026-10-22', endDate: '2026-10-21' },
    { changeKind: 'EXTENSION', startDate: '2026-10-22T00:00:00Z', endDate: null }, { changeKind: 'EXTENSION', membershipId: id }, []]) {
    await assert.rejects(() => svc.preview(readContext(), id, value), status(400, 'VALIDATION_FAILED'), JSON.stringify(value));
  }
  for (const patch of [{ principalType: 'SERVICE_ACCOUNT' }, { source: 'AI_AGENT' }, { actionRequestId: randomUUID() }, { delegatedByPrincipalId: randomUUID() }]) {
    await assert.rejects(() => svc.preview(readContext(patch), id, { changeKind: 'EXTENSION' }), status(403, 'HUMAN_COMMAND_REQUIRED'));
  }
  // Closed response verification: an extra key, a non-empty financial effect or a broken period fails closed (503), never success.
  for (const preview of [previewRow({ refundId: randomUUID() }), previewRow({ requiredPermissions: ['billing.membership.dates.retroactive'] }),
    previewRow({ currentPeriod: null }), previewRow({ warnings: [{ code: 'PAYMENT_COLLECTED' }] })]) {
    await assert.rejects(() => new MembershipDateRevisionService(fixture({ preview }).db).preview(readContext(), id, { changeKind: 'EXTENSION' }), status(503));
  }
});

test('confirmation is one protected call with the exact key, request and closed body; receipts are verified', async () => {
  const f = fixture(), svc = new MembershipDateRevisionService(f.db);
  const result = await svc.revise(context(), id, confirmation());
  assert.equal(result.replayed, false); assert.deepEqual(result.receipt.financialEffects, []); assert.equal(result.receipt.followUps[0].kind, 'BILLING_REVIEW');
  const [call] = f.calls('revise_membership_dates');
  assert.equal(call.readOnly, false); assert.equal(call.args[3], 'revision-key'); assert.deepEqual(JSON.parse(call.args[2]), confirmation());
  await assert.rejects(() => svc.revise(context({ idempotencyKey: '' }), id, confirmation()), status(409, 'IDEMPOTENCY_KEY_REQUIRED'));
  for (const patch of [{ reasonCode: 'SCHOOL_COURTESY' }, { reasonText: 'short' }, { reasonText: undefined }, { confirmation: 'YES' }, { expectedPeriodVersion: null },
    { changeKind: 'INITIAL_CONFIRMATION', reasonCode: 'LEGACY_RECORDS_REVIEWED' }, { dateSource: 'STAFF_ADJUSTED' }, { dateAdjustmentReason: 'Not adjusted.' },
    { acknowledgedWarnings: ['NOT_A_WARNING'] }, { acknowledgedWarnings: ['RETROACTIVE_CHANGE', 'RETROACTIVE_CHANGE'] }, { refund: true }, { paymentSchedule: {} },
    { expectedVersion: 0 }, { endDate: '2026-10-21' }, { previewDigest: 'X'.repeat(64) }]) {
    const body = confirmation(patch); if (patch.reasonText === undefined && 'reasonText' in patch) delete body.reasonText;
    await assert.rejects(() => svc.revise(context(), id, body), status(400, 'VALIDATION_FAILED'), JSON.stringify(patch));
  }
  for (const revision of [{ receipt: receiptRow({ financialEffects: [{ refund: 1 }] }), replayed: false }, { receipt: receiptRow({ approval: randomUUID() }), replayed: false },
    { receipt: receiptRow({ retroactiveDays: { added: 2, removed: 0 } }), replayed: false }, { receipt: receiptRow({ membershipId: randomUUID() }), replayed: false },
    { receipt: receiptRow(), replayed: false, extra: true }, { receipt: receiptRow({ effectivePeriod: { ...receiptRow().effectivePeriod, periodVersion: 5 } }), replayed: false }]) {
    await assert.rejects(() => new MembershipDateRevisionService(fixture({ revision }).db).revise(context(), id, confirmation()), status(503));
  }
});

test('database errors map to exact codes; unknown failures are unavailable, never success', async () => {
  const cases = [['VALIDATION_FAILED', '22023', 400], ['MEMBERSHIP_DATE_REVISION_FORBIDDEN', '42501', 403], ['MEMBERSHIP_RETROACTIVE_DATE_REVISION_FORBIDDEN', '42501', 403],
    ['BILLING_MEMBERSHIP_NOT_FOUND', 'P0002', 404], ['MEMBERSHIP_NOT_ACTIVE', '40001', 409], ['VERSION_CONFLICT', '40001', 409], ['PERIOD_VERSION_CONFLICT', '40001', 409],
    ['DATE_REVISION_PREVIEW_STALE', '40001', 409], ['IDEMPOTENCY_KEY_REUSED', '23505', 409], ['DATE_REVISION_BLOCKED', '22023', 422], ['DATE_SOURCE_MISMATCH', '22023', 422],
    ['DATE_REVISION_ACKNOWLEDGEMENT_REQUIRED', '22023', 422]];
  for (const [message, code, expected] of cases) {
    const error = Object.assign(new Error(message), { code });
    await assert.rejects(() => new MembershipDateRevisionService(fixture({ error }).db).revise(context(), id, confirmation()), status(expected, message));
  }
  await assert.rejects(() => new MembershipDateRevisionService(fixture({ error: Object.assign(new Error('x'), { code: '40P01' }) }).db).revise(context(), id, confirmation()), status(409, 'MEMBERSHIP_LIFECYCLE_CONFLICT'));
  await assert.rejects(() => new MembershipDateRevisionService(fixture({ error: Object.assign(new Error('boom'), { code: 'XX000' }) }).db).revise(context(), id, confirmation()), status(503));
  await assert.rejects(() => new MembershipDateRevisionService(fixture({ error: Object.assign(new Error('other'), { code: '42501' }) }).db).history(readContext(), id, {}), status(403, 'MEMBERSHIP_DATE_HISTORY_FORBIDDEN'));
});

test('history, queue and summary are read-only closed calls with verified responses', async () => {
  const f = fixture(), svc = new MembershipDateRevisionService(f.db);
  assert.equal((await svc.history(readContext(), id, {})).versions.length, 1);
  await assert.rejects(() => svc.history(readContext(), id, { versions: 'all' }), status(400));
  await svc.confirmationQueue(readContext(), { limit: 10, after: id });
  assert.deepEqual(JSON.parse(f.calls('read_membership_date_confirmation_queue')[0].args[1]), { after: id, limit: 10 });
  for (const value of [{ limit: 51 }, { limit: 0 }, { after: 'x' }, { bulk: true }]) await assert.rejects(() => svc.confirmationQueue(readContext(), value), status(400), JSON.stringify(value));
  assert.equal((await svc.statusSummary(readContext())).activeByEffectiveStatus.UNDATED, 1);
  assert.ok(f.queries.every((q) => q.readOnly));
  // Totals that do not add up, or another school's summary, fail closed.
  for (const summary of [summaryRow({ activeByEffectiveStatus: { SCHEDULED: 1, IN_EFFECT: 1, ENDED: 1, UNDATED: 2 } }), summaryRow({ schoolId: randomUUID() }), summaryRow({ revenueMinor: 1 })]) {
    await assert.rejects(() => new MembershipDateRevisionService(fixture({ summary }).db).statusSummary(readContext()), status(503));
  }
  await assert.rejects(() => new MembershipDateRevisionService(fixture({ queue: { items: [], next: randomUUID() } }).db).confirmationQueue(readContext(), {}), status(503));
});

test('controllers derive human attribution and exact scope; history accepts any of its read permissions; no cross-tenant fallback', async () => {
  const f = fixture(), c = new MembershipDateRevisionController(f.db, new MembershipDateRevisionService(f.db)), req = { honIdentity: { externalSubject: subject }, query: {} };
  assert.equal((await c.preview(scope.organizationId, scope.schoolId, id, undefined, { changeKind: 'EXTENSION' }, req)).data.previewDigest, digest);
  assert.equal(f.calls('preview_membership_date_revision')[0].context.idempotencyKey, '');
  await assert.rejects(() => c.preview(scope.organizationId, scope.schoolId, id, 'key', { changeKind: 'EXTENSION' }, req), status(409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED'));
  await assert.rejects(() => c.preview(randomUUID(), scope.schoolId, id, undefined, { changeKind: 'EXTENSION' }, req), status(403));
  await assert.rejects(() => c.preview(scope.organizationId, scope.schoolId, id, undefined, { changeKind: 'EXTENSION' }, { ...req, query: { all: '1' } }), status(400));
  const revised = await c.revise(scope.organizationId, scope.schoolId, id, ' retained ', confirmation(), req);
  assert.equal(revised.data.changeKind, 'EARLY_END'); assert.equal(f.calls('revise_membership_dates')[0].args[3], 'retained');
  await assert.rejects(() => c.revise(scope.organizationId, scope.schoolId, id, undefined, confirmation(), req), status(409, 'IDEMPOTENCY_KEY_REQUIRED'));
  const readOnly = fixture({ scopes: { 'billing.membership.read': scope } });
  const rc = new MembershipDateRevisionController(readOnly.db, new MembershipDateRevisionService(readOnly.db));
  assert.equal((await rc.history(scope.organizationId, scope.schoolId, id, undefined, {}, req)).data.versions.length, 1);
  await assert.rejects(() => rc.preview(scope.organizationId, scope.schoolId, id, undefined, { changeKind: 'EXTENSION' }, req), status(403));
  await assert.rejects(() => rc.queue(scope.organizationId, scope.schoolId, undefined, {}, req), status(403));
  const none = fixture({ scope: null }), nc = new MembershipDateRevisionController(none.db, new MembershipDateRevisionService(none.db));
  await assert.rejects(() => nc.history(scope.organizationId, scope.schoolId, id, undefined, {}, req), status(403));
  const report = new MembershipStatusReportController(none.db, new MembershipDateRevisionService(none.db));
  await assert.rejects(() => report.read(scope.organizationId, scope.schoolId, req), status(403));
  assert.equal(none.queries.length, 0);
  const ok = new MembershipStatusReportController(f.db, new MembershipDateRevisionService(f.db));
  assert.equal((await ok.read(scope.organizationId, scope.schoolId, req)).data.lifecycle.ACTIVE, 4);
});

test('real HTTP path: separate browser commands per call, closed bodies, GET summary, no financial endpoints', async () => {
  const oldOrigin = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
  const f = fixture();
  const module = await Test.createTestingModule({ controllers: [MembershipDateRevisionController, MembershipStatusReportController],
    providers: [MembershipDateRevisionService, MembershipDatePreviewHumanUiGuard, MembershipDateRevisionHumanUiGuard, MembershipDateHistoryHumanUiGuard, MembershipDateQueueHumanUiGuard,
      MembershipStatusSummaryHumanUiGuard, { provide: RuntimeDatabaseService, useValue: f.db }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(c) { c.switchToHttp().getRequest().honIdentity = { externalSubject: subject }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const root = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}`;
  const base = `${root}/billing/memberships`;
  const human = (command) => ({ origin: 'https://hon.test', 'Content-Type': 'application/json', 'X-HON-Human-Command': command, 'Sec-Fetch-Site': 'same-origin' });
  const reviseHeaders = { ...human('billing.membership.dates.revise'), 'Idempotency-Key': 'retained' };
  try {
    const preview = await fetch(`${base}/${id}/effective-period/preview`, { method: 'POST', headers: human('billing.membership.dates.preview'), body: '{"changeKind":"EXTENSION"}' });
    assert.equal(preview.status, 200); assert.equal(preview.headers.get('cache-control'), 'private, no-store');
    assert.equal((await fetch(`${base}/${id}/effective-period/history`, { method: 'POST', headers: human('billing.membership.dates.history'), body: '{}' })).status, 200);
    assert.equal((await fetch(`${base}/date-confirmation-queue`, { method: 'POST', headers: human('billing.membership.dates.queue'), body: '{"limit":5}' })).status, 200);
    // No call can be replayed as another browser command.
    for (const [path, command, body] of [[`${id}/effective-period/preview`, 'billing.membership.dates.revise', '{"changeKind":"EXTENSION"}'],
      [`${id}/effective-period/revisions`, 'billing.membership.dates.preview', JSON.stringify(confirmation())], [`${id}/effective-period/history`, 'billing.membership.dates.preview', '{}'],
      ['date-confirmation-queue', 'billing.membership.dates.history', '{}'], [`${id}/effective-period/revisions`, 'billing.membership.activate', JSON.stringify(confirmation())]]) {
      assert.equal((await fetch(`${base}/${path}`, { method: 'POST', headers: { ...human(command), 'Idempotency-Key': 'k' }, body })).status, 403, `${path} with ${command}`);
    }
    for (const patch of [{ origin: 'https://other.test' }, { 'Sec-Fetch-Site': 'same-site' }, { 'Content-Type': 'text/plain' }, { 'X-HON-Source': 'AI' },
      { 'X-HON-Action-Request-Id': randomUUID() }, { 'X-HON-Delegated-By-Principal-Id': randomUUID() }]) {
      assert.equal((await fetch(`${base}/${id}/effective-period/revisions`, { method: 'POST', headers: { ...reviseHeaders, ...patch }, body: JSON.stringify(confirmation()) })).status, 403, JSON.stringify(patch));
    }
    for (const patch of [{ refund: true }, { creditMinor: 100 }, { paymentSchedule: {} }, { invoiceId: randomUUID() }, { agreementId: randomUUID() }, { reasonCode: 'SCHOOL_COURTESY' }]) {
      assert.equal((await fetch(`${base}/${id}/effective-period/revisions`, { method: 'POST', headers: reviseHeaders, body: JSON.stringify(confirmation(patch)) })).status, 400, JSON.stringify(patch));
    }
    assert.equal((await fetch(`${base}/${id}/effective-period/history`, { method: 'POST', headers: human('billing.membership.dates.history'), body: '{"all":true}' })).status, 400);
    assert.equal((await fetch(`${base}/${id}/effective-period/revisions?source=AI`, { method: 'POST', headers: reviseHeaders, body: JSON.stringify(confirmation()) })).status, 400);
    for (const endpoint of ['effective-period/refund', 'effective-period/charge', 'effective-period/invoice', 'effective-period/bulk-confirm', 'effective-period/renew']) {
      assert.equal((await fetch(`${base}/${id}/${endpoint}`, { method: 'POST', headers: reviseHeaders, body: '{}' })).status, 404, endpoint);
    }
    const revised = await fetch(`${base}/${id}/effective-period/revisions`, { method: 'POST', headers: reviseHeaders, body: JSON.stringify(confirmation()) });
    assert.equal(revised.status, 200); const body = await revised.json();
    assert.equal(body.data.effectivePeriod.endDateInclusive, true); assert.deepEqual(body.data.financialEffects, []); assert.equal(body.meta.replayed, false);
    const summary = await fetch(`${root}/reports/membership-status`);
    assert.equal(summary.status, 200); assert.equal(summary.headers.get('cache-control'), 'private, no-store');
    assert.equal((await summary.json()).data.lifecycle.ACTIVE, 4);
    assert.equal((await fetch(`${root}/reports/membership-status?school=other`)).status, 400);
    assert.equal((await fetch(`${root}/reports/membership-status`, { headers: { 'X-HON-Source': 'AI' } })).status, 403);
  } finally { await app.close(); if (oldOrigin === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = oldOrigin; }
});

test('the service and controllers run no DML and expose no money, agreement, renewal or bulk shortcut', () => {
  const service = readFileSync('src/billing/membership-date-revision.service.ts', 'utf8');
  assert.doesNotMatch(service, /UPDATE hon\.|INSERT INTO hon\.|DELETE FROM hon\.|hon\.(?:memberships|document_\w+|agreements|payment_\w+|membership_payment_schedules|invoices|billing_accounts|communication_\w+|action_requests|ai_\w+)\b|fetch\(|invokeProvider/);
  for (const name of ['preview_membership_date_revision', 'revise_membership_dates', 'read_membership_date_history', 'read_membership_date_confirmation_queue', 'read_school_membership_status_summary']) {
    assert.match(service, new RegExp(`hon\\.${name}\\(`));
  }
  const controller = readFileSync('src/billing/membership-date-revision.controller.ts', 'utf8');
  assert.doesNotMatch(controller, /@(?:Put|Patch|Delete)\(/);
  assert.doesNotMatch(controller, /@(?:Post|Get)\('[^']*(?:refund|charge|bulk|renew|agreement)/i);
  assert.equal((controller.match(/@Post\(/g) ?? []).length, 4);
  // The existing membership, cancellation, operations-report and parent billing modules are untouched by E1b-1.
  assert.doesNotMatch(readFileSync('src/billing/membership.service.ts', 'utf8'), /dates\.revise|membership_date_revision/);
  assert.doesNotMatch(readFileSync('src/reports/operations-report.service.ts', 'utf8'), /membership_status_summary|UNDATED/);
});
