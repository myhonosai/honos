const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const { readFileSync } = require('node:fs');
const { MembershipService } = require('../dist/billing/membership.service.js');
const { MembershipController } = require('../dist/billing/membership.controller.js');
const { MembershipActivationHumanUiGuard, MembershipActivationPreviewHumanUiGuard, MembershipCancelHumanUiGuard } = require('../dist/billing/membership-activation-human-ui.guard.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');

// Mocked boundary tests for the 0177 two-step activation API. The database behaviour itself (authority, locks,
// evidence, dates, idempotency) is proven against PostgreSQL by test-membership-activation-gate-integrity.mjs.
const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const id = randomUUID();
const subject = 'verified-human';
const context = (patch = {}) => ({ ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: 'activation-key',
  externalSubject: subject, ...patch });
const readContext = (patch = {}) => context({ idempotencyKey: '', ...patch });
const status = (value, code) => (error) => { assert.equal(error.getStatus(), value); if (code) assert.equal(error.getResponse().code, code); return true; };
const response = () => ({ status() {} });
const digest = 'a'.repeat(64);
const REQUIREMENTS = ['AGREEMENT', 'PAYMENT', 'RECURRING_PAYMENT_AUTHORIZATION', 'FINANCIAL_RESPONSIBILITY', 'SCHOOL_ACTIVATION_POLICY'];
const CONFIRMATION = 'I_CONFIRM_MEMBERSHIP_ACTIVATION_AND_DATES_NO_AGREEMENT_CONSENT_OR_PAYMENT_RECORDED';
const previewRow = (patch = {}) => ({ membershipId: id, state: 'DRAFT', version: 1, billingAccountId: randomUUID(), participantPersonId: randomUUID(), participantDisplayName: 'Avery Local',
  planCode: 'KNOWN_DRAFT', source: 'GENERIC_LEGACY', plan: null, existingTerm: { termStartedAt: null, termEndsAt: null }, schoolTimezone: 'America/Los_Angeles', localToday: '2026-10-22',
  birthDateRecorded: true, knownMinor: false, suggestedDates: { startDate: '2026-10-22', endDate: null, startBasis: 'TODAY_IN_SCHOOL_TIMEZONE', endBasis: 'NO_END_DATE' },
  proposedDates: { startDate: '2026-10-22', endDate: null, dateSource: 'SUGGESTED' }, projection: { termStartedAt: '2026-10-22T07:00:00.000Z', termEndsAt: null },
  effectiveStatusIfConfirmedNow: 'IN_EFFECT', warnings: [{ code: 'LEGACY_FREE_TEXT_PLAN' }], overridableWarnings: [], availableOverrides: [], blocks: [], canConfirm: true,
  requirementsNotEvaluated: REQUIREMENTS, previewDigest: digest, confirmation: CONFIRMATION, ...patch });
const receiptRow = (patch = {}) => ({ membershipId: id, state: 'ACTIVE', version: 2, previousVersion: 1, decisionId: randomUUID(), decisionBasis: 'STAFF_ACTIVATION_PRE_POLICY',
  membershipSource: 'GENERIC_LEGACY', authorizingPermission: 'billing.membership.activate', overridePermission: null,
  effectivePeriod: { periodVersion: 1, startDate: '2026-10-22', endDate: null, endDateInclusive: true, schoolTimezone: 'America/Los_Angeles', dateSource: 'SUGGESTED',
    termStartedAt: '2026-10-22T07:00:00.000Z', termEndsAt: null }, effectiveStatusAtActivation: 'IN_EFFECT', acknowledgedWarnings: ['LEGACY_FREE_TEXT_PLAN'], overridesUsed: [],
  followUps: [], adultVerification: null, reasonCode: 'ROUTINE_ENROLLMENT', requirementsNotEvaluated: REQUIREMENTS, recordedAt: '2026-10-22T18:00:00.000Z', ...patch });
const confirmation = (patch = {}) => ({ expectedVersion: 1, previewDigest: digest, startDate: '2026-10-22', endDate: null, dateSource: 'SUGGESTED', acknowledgedWarnings: ['LEGACY_FREE_TEXT_PLAN'],
  overrides: [], reasonCode: 'ROUTINE_ENROLLMENT', confirmation: CONFIRMATION, ...patch });

function fixture(options = {}) {
  const queries = [];
  const db = {
    resolveAuthorizedScope: async () => (options.scope === undefined ? scope : options.scope),
    async transaction(c, work, readOnly) {
      return work({ query: async (sql, args = []) => {
        queries.push({ sql, args, readOnly, context: c });
        // The service never writes or reads memberships, payments, agreements or providers itself: only the protected functions do.
        assert.doesNotMatch(sql, /(INSERT|UPDATE|DELETE)\s|hon\.(?:agreements|document_\w+|payment_\w+|membership_payment_schedules|invoices|communication_\w+|action_requests|ai_\w+|billing_accounts)\b/);
        if (/^SET LOCAL/.test(sql) || /set_config\('app\.hon_source','HUMAN_UI'/.test(sql)) return { rows: [] };
        if (options.error) throw options.error;
        if (/hon\.preview_school_membership_activation\(\$1,\$2::uuid,\$3::jsonb\)/.test(sql)) return { rows: [{ data: options.preview ?? previewRow() }] };
        if (/hon\.activate_school_membership\(\$1,\$2::uuid,\$3::jsonb,\$4,\$5::uuid,\$6::uuid\)/.test(sql)) return { rows: [{ data: options.activation ?? { receipt: receiptRow(), replayed: false } }] };
        if (/hon\.cancel_school_membership\(\$1,\$2::uuid,\$3::jsonb,\$4,\$5::uuid,\$6::uuid\)/.test(sql)) {
          const input = JSON.parse(args[2]);
          return { rows: [{ data: options.cancellation ?? { membership: { id, billingAccountId: randomUUID(), participantPersonId: randomUUID(), planCode: 'KNOWN', state: 'CANCELLED',
            version: input.expectedVersion + 1, cancellationReason: input.cancellationReason, createdAt: '2026-10-16T00:00:00.000Z' }, replayed: false } }] };
        }
        throw new Error('Unexpected SQL: ' + sql);
      } });
    },
    withTenantTransaction(c, work) { return this.transaction(c, work, false); },
    withTenantReadOnlyTransaction(c, work) { return this.transaction(c, work, true); },
  };
  return { db, queries, calls: (name) => queries.filter((q) => q.sql.includes(name)) };
}

test('preview is one read-only protected call with the exact subject, membership and proposal; it accepts no idempotency key', async () => {
  const f = fixture(), svc = new MembershipService(f.db);
  const preview = await svc.previewActivation(readContext(), id, { startDate: '2027-03-14', endDate: null });
  assert.equal(preview.previewDigest, digest); assert.equal(preview.canConfirm, true);
  const [call] = f.calls('preview_school_membership_activation');
  assert.equal(call.readOnly, true); assert.deepEqual(call.args, [subject, id, '{"startDate":"2027-03-14","endDate":null}']);
  assert.ok(f.queries.every((q) => q.readOnly));
  assert.deepEqual(f.calls('set_config')[0].args, [subject]);
  await svc.previewActivation(readContext(), id, {}); assert.equal(f.calls('preview_school_membership_activation')[1].args[2], '{}');
  await assert.rejects(() => svc.previewActivation(context(), id, {}), status(409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED'));
  for (const value of [{ startDate: '2027-02-30', endDate: null }, { startDate: '2027-03-14' }, { endDate: null }, { startDate: '2027-03-14', endDate: null, extra: 1 },
    { startDate: '2027-03-14T00:00:00Z', endDate: null }, { startDate: 20270314, endDate: null }, []]) {
    await assert.rejects(() => svc.previewActivation(readContext(), id, value), status(400, 'VALIDATION_FAILED'), JSON.stringify(value));
  }
  await assert.rejects(() => svc.previewActivation(readContext(), 'not-a-uuid', {}), status(400));
  assert.equal(f.calls('preview_school_membership_activation').length, 2);
});

test('an unverifiable preview or receipt from the database fails closed', async () => {
  for (const preview of [previewRow({ extra: true }), previewRow({ previewDigest: 'x' }), previewRow({ requirementsNotEvaluated: [] }), previewRow({ warnings: [{ code: 'MADE_UP' }] }),
    previewRow({ projection: { termStartedAt: '2026-10-22', termEndsAt: null } }), previewRow({ confirmation: 'YES' })]) {
    await assert.rejects(() => new MembershipService(fixture({ preview }).db).previewActivation(readContext(), id, {}), status(503, 'MEMBERSHIP_LIFECYCLE_UNAVAILABLE'));
  }
  for (const activation of [{ receipt: receiptRow({ membershipId: randomUUID() }), replayed: false }, { receipt: receiptRow({ overridesUsed: [{ code: 'CRM_IDENTITY_REVIEW_PENDING', resolved: true }] }), replayed: false },
    { receipt: receiptRow({ overridePermission: 'billing.membership.activation.override' }), replayed: false }, { receipt: receiptRow({ state: 'DRAFT' }), replayed: false },
    { receipt: receiptRow(), replayed: false, extra: 1 }, { receipt: receiptRow({ effectivePeriod: { ...receiptRow().effectivePeriod, endDateInclusive: false } }), replayed: false }]) {
    await assert.rejects(() => new MembershipService(fixture({ activation }).db).activate(context(), id, confirmation()), status(503, 'MEMBERSHIP_LIFECYCLE_UNAVAILABLE'));
  }
});

test('the pre-0177 body fails closed with a dedicated code before any SQL; confirmation input is closed and exact', async () => {
  const f = fixture(), svc = new MembershipService(f.db);
  await assert.rejects(() => svc.activate(context(), id, { expectedVersion: 1 }), status(400, 'ACTIVATION_TWO_STEP_CONFIRMATION_REQUIRED'));
  for (const patch of [{ confirmation: 'I_CONFIRM' }, { previewDigest: 'A'.repeat(64) }, { expectedVersion: 0 }, { expectedVersion: '1' }, { startDate: '2027-02-29' }, { endDate: '2026-10-21' },
    { dateSource: 'STAFF_ADJUSTED' }, { dateAdjustmentReason: 'not adjusted' }, { acknowledgedWarnings: ['LEGACY_FREE_TEXT_PLAN', 'LEGACY_FREE_TEXT_PLAN'] }, { acknowledgedWarnings: ['MADE_UP'] },
    { overrides: [{ code: 'CRM_IDENTITY_REVIEW_PENDING', reason: 'short', confirmation: 'I_ACKNOWLEDGE_THE_REVIEW_REMAINS_UNRESOLVED' }] },
    { overrides: [{ code: 'CRM_IDENTITY_REVIEW_PENDING', reason: 'A long enough reason.' }] }, { reasonCode: 'OTHER' }, { reasonCode: 'BECAUSE' }, { reasonText: ' padded ' },
    { adultVerification: { method: 'GUESSED', attestation: 'I_ATTEST_STAFF_VERIFIED_THE_PARTICIPANT_IS_AN_ADULT' } }, { birthDate: '2000-01-01' },
    { paymentSchedule: {} }, { agreementId: randomUUID() }, { autoRenew: true }, { invoice: true }, { source: 'AI' }, { principalId: randomUUID() }]) {
    await assert.rejects(() => svc.activate(context(), id, confirmation(patch)), status(400), JSON.stringify(patch));
  }
  await assert.rejects(() => svc.activate(context({ idempotencyKey: '' }), id, confirmation()), status(409));
  assert.equal(f.queries.length, 0);
  const result = await svc.activate(context(), id, confirmation({ dateSource: 'STAFF_ADJUSTED', startDate: '2027-03-14', dateAdjustmentReason: 'Member starts after the holiday.',
    overrides: [{ code: 'CRM_IDENTITY_REVIEW_PENDING', reason: 'Owner reviewed identity.', confirmation: 'I_ACKNOWLEDGE_THE_REVIEW_REMAINS_UNRESOLVED' }] }));
  assert.equal(result.replayed, false); assert.equal(result.membership.state, 'ACTIVE');
  const [call] = f.calls('activate_school_membership'), c = call.context;
  assert.equal(call.readOnly, false);
  assert.deepEqual(call.args.slice(0, 2), [subject, id]); assert.deepEqual(call.args.slice(3), ['activation-key', c.requestId, c.correlationId]);
  assert.deepEqual(JSON.parse(call.args[2]), confirmation({ dateSource: 'STAFF_ADJUSTED', startDate: '2027-03-14', dateAdjustmentReason: 'Member starts after the holiday.',
    overrides: [{ code: 'CRM_IDENTITY_REVIEW_PENDING', reason: 'Owner reviewed identity.', confirmation: 'I_ACKNOWLEDGE_THE_REVIEW_REMAINS_UNRESOLVED' }] }));
});

test('database lifecycle errors map to exact public codes; unknown failures do not leak', async () => {
  for (const [message, sqlState, httpStatus] of [['MEMBERSHIP_ACTIVATION_FORBIDDEN', '42501', 403], ['ACTIVATION_OVERRIDE_FORBIDDEN', '42501', 403], ['BILLING_MEMBERSHIP_NOT_FOUND', 'P0002', 404],
    ['MEMBERSHIP_NOT_DRAFT', '40001', 409], ['VERSION_CONFLICT', '40001', 409], ['ACTIVATION_PREVIEW_STALE', '40001', 409], ['IDEMPOTENCY_KEY_REUSED', '23505', 409],
    ['IDEMPOTENCY_IN_PROGRESS', '40001', 409], ['SCHOOL_TIMEZONE_INVALID', '22023', 409], ['ACTIVATION_BLOCKED', '22023', 422], ['DATE_SOURCE_MISMATCH', '22023', 422],
    ['ACTIVATION_ACKNOWLEDGEMENT_REQUIRED', '22023', 422], ['ACTIVATION_OVERRIDE_REQUIRED', '22023', 422], ['ADULT_VERIFICATION_NOT_APPLICABLE', '22023', 422],
    ['ACTIVATION_REASON_TEXT_REQUIRED', '22023', 422], ['VALIDATION_FAILED', '22023', 400]]) {
    const error = Object.assign(new Error(message), { code: sqlState });
    await assert.rejects(() => new MembershipService(fixture({ error }).db).activate(context(), id, confirmation()), status(httpStatus, message), message);
  }
  // A message that is not a known lifecycle code (or arrives with an unexpected SQLSTATE) is generic.
  await assert.rejects(() => new MembershipService(fixture({ error: Object.assign(new Error('MEMBERSHIP_NOT_DRAFT'), { code: '42P01' }) }).db).activate(context(), id, confirmation()), status(503));
  await assert.rejects(() => new MembershipService(fixture({ error: Object.assign(new Error('private detail'), { code: '42501' }) }).db).previewActivation(readContext(), id, {}),
    status(403, 'MEMBERSHIP_ACTIVATION_FORBIDDEN'));
  await assert.rejects(() => new MembershipService(fixture({ error: Object.assign(new Error('deadlock'), { code: '40P01' }) }).db).activate(context(), id, confirmation()), status(409, 'MEMBERSHIP_LIFECYCLE_CONFLICT'));
});

test('nonhuman, delegated, automated and subject-less contexts are rejected before SQL for preview, activation and cancellation', async () => {
  const f = fixture(), svc = new MembershipService(f.db);
  for (const patch of [{ source: 'AI' }, { source: 'PUBLIC_API' }, { source: 'PARENT_APP' }, { principalType: 'AI_EMPLOYEE' }, { principalType: 'SYSTEM_SERVICE' },
    { actionRequestId: randomUUID() }, { delegatedByPrincipalId: randomUUID() }, { externalSubject: undefined }, { externalSubject: ' padded ' }, { externalSubject: '' }]) {
    await assert.rejects(() => svc.previewActivation(readContext(patch), id, {}), status(403), JSON.stringify(patch));
    await assert.rejects(() => svc.activate(context(patch), id, confirmation()), status(403), JSON.stringify(patch));
    await assert.rejects(() => svc.cancel(context(patch), id, { expectedVersion: 2, cancellationReason: 'Moved.' }), status(403), JSON.stringify(patch));
  }
  assert.equal(f.queries.length, 0);
});

test('cancellation keeps its public contract through the protected function and verifies the response', async () => {
  const f = fixture(), svc = new MembershipService(f.db);
  const result = await svc.cancel(context(), id, { expectedVersion: 2, cancellationReason: '  Moved away.  ' });
  assert.equal(result.membership.state, 'CANCELLED'); assert.equal(result.replayed, false);
  const [call] = f.calls('cancel_school_membership');
  assert.deepEqual(JSON.parse(call.args[2]), { expectedVersion: 2, cancellationReason: 'Moved away.' });
  assert.deepEqual(call.args.slice(0, 2), [subject, id]);
  for (const input of [{ expectedVersion: 0, cancellationReason: 'x' }, { expectedVersion: 2, cancellationReason: '' }, { expectedVersion: 2, cancellationReason: 'x', refund: true }]) {
    await assert.rejects(() => svc.cancel(context(), id, input), status(400));
  }
  const bad = fixture({ cancellation: { membership: { id: randomUUID(), state: 'CANCELLED', version: 3 }, replayed: false } });
  await assert.rejects(() => new MembershipService(bad.db).cancel(context(), id, { expectedVersion: 2, cancellationReason: 'Moved.' }), status(503));
  const extra = fixture({ cancellation: { membership: { id, state: 'CANCELLED', version: 3, refundId: randomUUID() }, replayed: false } });
  await assert.rejects(() => new MembershipService(extra.db).cancel(context(), id, { expectedVersion: 2, cancellationReason: 'Moved.' }), status(503));
});

test('controller derives human attribution and exact scope for preview and activation, with no cross-tenant fallback', async () => {
  const f = fixture(), c = new MembershipController(f.db, new MembershipService(f.db)), req = { honIdentity: { externalSubject: subject }, query: {} };
  const preview = await c.activationPreview(scope.organizationId, scope.schoolId, id, undefined, {}, req);
  assert.equal(preview.data.previewDigest, digest); assert.equal(preview.meta.replayed, false);
  assert.equal(f.calls('preview_school_membership_activation')[0].context.idempotencyKey, '');
  await assert.rejects(() => c.activationPreview(scope.organizationId, scope.schoolId, id, 'key', {}, req), status(409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED'));
  await assert.rejects(() => c.activationPreview(randomUUID(), scope.schoolId, id, undefined, {}, req), status(403));
  await assert.rejects(() => c.activationPreview(scope.organizationId, scope.schoolId, id, undefined, {}, { ...req, query: { list: 'all' } }), status(400));
  const activated = await c.activate(scope.organizationId, scope.schoolId, id, 'retained', confirmation(), req, response());
  assert.equal(activated.data.state, 'ACTIVE');
  assert.equal(f.calls('activate_school_membership')[0].context.externalSubject, subject);
  await assert.rejects(() => c.activate(randomUUID(), scope.schoolId, id, 'key', confirmation(), req, response()), status(403));
  const none = fixture({ scope: null }), controller = new MembershipController(none.db, new MembershipService(none.db));
  await assert.rejects(() => controller.activationPreview(scope.organizationId, scope.schoolId, id, undefined, {}, req), status(403));
  await assert.rejects(() => controller.activate(scope.organizationId, scope.schoolId, id, 'key', confirmation(), req, response()), status(403));
  assert.equal(none.queries.length, 0);
});

test('real HTTP path: separate preview and confirm commands, same-origin human marker, closed bodies and no financial endpoints', async () => {
  const oldOrigin = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
  const f = fixture();
  const module = await Test.createTestingModule({ controllers: [MembershipController],
    providers: [MembershipService, MembershipActivationHumanUiGuard, MembershipActivationPreviewHumanUiGuard, MembershipCancelHumanUiGuard, { provide: RuntimeDatabaseService, useValue: f.db }] })
    .overrideGuard(HonIdentityGuard).useValue({ canActivate(c) { c.switchToHttp().getRequest().honIdentity = { externalSubject: subject }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1'); app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/billing/memberships`;
  const human = (command) => ({ origin: 'https://hon.test', 'Content-Type': 'application/json', 'X-HON-Human-Command': command, 'Sec-Fetch-Site': 'same-origin' });
  const previewHeaders = human('billing.membership.activation.preview'), activateHeaders = { ...human('billing.membership.activate'), 'Idempotency-Key': 'retained' };
  try {
    const preview = await fetch(`${base}/${id}/activation-preview`, { method: 'POST', headers: previewHeaders, body: '{}' });
    assert.equal(preview.status, 200); assert.equal(preview.headers.get('cache-control'), 'private, no-store');
    assert.equal((await preview.json()).data.previewDigest, digest);
    assert.equal((await fetch(`${base}/${id}/activation-preview`, { method: 'POST', headers: previewHeaders, body: '{"startDate":"2027-03-14","endDate":null}' })).status, 200);
    // The preview command cannot be replayed as a confirmation and vice versa.
    assert.equal((await fetch(`${base}/${id}/activation-preview`, { method: 'POST', headers: human('billing.membership.activate'), body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}/${id}/activate`, { method: 'POST', headers: { ...previewHeaders, 'Idempotency-Key': 'k' }, body: JSON.stringify(confirmation()) })).status, 403);
    assert.equal((await fetch(`${base}/${id}/activation-preview`, { method: 'POST', headers: { ...previewHeaders, 'Idempotency-Key': 'k' }, body: '{}' })).status, 409);
    for (const body of ['{"startDate":"2027-02-30","endDate":null}', '{"membershipId":"x"}', '{"startDate":"2027-03-14"}']) {
      assert.equal((await fetch(`${base}/${id}/activation-preview`, { method: 'POST', headers: previewHeaders, body })).status, 400, body);
    }
    for (const patch of [{ origin: 'https://other.test' }, { 'X-HON-Human-Command': '' }, { 'Sec-Fetch-Site': 'same-site' }, { 'Content-Type': 'text/plain' }, { 'X-HON-Source': 'AI' },
      { 'X-HON-Action-Request-Id': randomUUID() }, { 'X-HON-Delegated-By-Principal-Id': randomUUID() }]) {
      assert.equal((await fetch(`${base}/${id}/activate`, { method: 'POST', headers: { ...activateHeaders, ...patch }, body: JSON.stringify(confirmation()) })).status, 403, JSON.stringify(patch));
    }
    const legacy = await fetch(`${base}/${id}/activate`, { method: 'POST', headers: activateHeaders, body: '{"expectedVersion":1}' });
    assert.equal(legacy.status, 400); assert.equal((await legacy.json()).code, 'ACTIVATION_TWO_STEP_CONFIRMATION_REQUIRED');
    for (const patch of [{ signature: 'SIGNED' }, { paymentSchedule: {} }, { initiatePayment: true }, { expectedVersion: 0 }]) {
      assert.equal((await fetch(`${base}/${id}/activate`, { method: 'POST', headers: activateHeaders, body: JSON.stringify(confirmation(patch)) })).status, 400, JSON.stringify(patch));
    }
    assert.equal((await fetch(`${base}/${id}/activate?source=AI`, { method: 'POST', headers: activateHeaders, body: JSON.stringify(confirmation()) })).status, 400);
    for (const endpoint of ['charge', 'invoice', 'send-agreement', 'schedule', 'authorize', 'override', 'approve']) {
      assert.equal((await fetch(`${base}/${id}/${endpoint}`, { method: 'POST', headers: activateHeaders, body: '{}' })).status, 404, endpoint);
    }
    const activated = await fetch(`${base}/${id}/activate`, { method: 'POST', headers: activateHeaders, body: JSON.stringify(confirmation()) });
    assert.equal(activated.status, 200); assert.equal(activated.headers.get('cache-control'), 'private, no-store');
    const body = await activated.json();
    assert.equal(body.data.state, 'ACTIVE'); assert.equal(body.data.effectivePeriod.endDateInclusive, true); assert.equal(body.meta.replayed, false);
    // Cancellation is its own same-origin browser command: no other command, origin, source or delegation reaches it.
    const cancelHeaders = { ...human('billing.membership.cancel'), 'Idempotency-Key': 'cancel-1' }, cancelBody = '{"expectedVersion":2,"cancellationReason":"Moved."}';
    for (const patch of [{ 'X-HON-Human-Command': 'billing.membership.activate' }, { 'X-HON-Human-Command': '' }, { origin: 'https://other.test' }, { 'Sec-Fetch-Site': 'cross-site' },
      { 'X-HON-Source': 'AI' }, { 'X-HON-Delegated-By-Principal-Id': randomUUID() }]) {
      assert.equal((await fetch(`${base}/${id}/cancel`, { method: 'POST', headers: { ...cancelHeaders, ...patch }, body: cancelBody })).status, 403, JSON.stringify(patch));
    }
    const cancelled = await fetch(`${base}/${id}/cancel`, { method: 'POST', headers: cancelHeaders, body: cancelBody });
    assert.equal(cancelled.status, 200); assert.equal((await cancelled.json()).data.state, 'CANCELLED');
  } finally { await app.close(); if (oldOrigin === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = oldOrigin; }
});

test('the service runs no lifecycle DML of its own and no agreement, payment, provider or owner-launch shortcut exists', () => {
  const source = readFileSync('src/billing/membership.service.ts', 'utf8');
  const lifecycle = source.split('async previewActivation(')[1].split('private assertHumanCancellationContext(')[0];
  assert.doesNotMatch(lifecycle, /UPDATE hon\.memberships|INSERT INTO hon\.(?:audit_events|outbox_events|idempotency_records)|hon\.(?:document_\w+|agreements|payment_\w+|membership_payment_schedules|invoices|billing_accounts|communication_\w+|action_requests|ai_\w+)|fetch\(|invokeProvider|sendAgreement/);
  assert.match(lifecycle, /hon\.preview_school_membership_activation/); assert.match(lifecycle, /hon\.activate_school_membership/); assert.match(lifecycle, /hon\.cancel_school_membership/);
  assert.doesNotMatch(source.split('async createDraft(')[1].split('async readActivationContext(')[0], /INSERT INTO hon\.memberships \([^)]*\bstate\b/, 'DRAFT insert names no state column');
  assert.doesNotMatch(readFileSync('src/owner-launch/owner-launch.controller.ts', 'utf8'), /memberships\.activate|MembershipService|membership.*\/activate/);
});
