const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { MembershipPauseService } = require('../dist/billing/membership-pause.service.js');
const contracts = require('@hon/contracts');

// Mocked boundary tests for the 0224 membership pause API. The database behaviour itself (authority, locks, limits,
// transitions, idempotency, no money effects) is proven against PostgreSQL by test-membership-pause-integrity.mjs.
const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const id = randomUUID();
const context = (patch = {}) => ({ ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: 'pause-key',
  externalSubject: 'verified-human', ...patch });
const readContext = (patch = {}) => context({ idempotencyKey: '', ...patch });
const status = (value, code) => (error) => { assert.equal(error.getStatus(), value); if (code) assert.equal(error.getResponse().code, code); return true; };
const policy = (patch = {}) => ({ version: 1, pausesAllowed: true, maxPauseDays: 30, maxPausedDaysPerYear: 60, holdFee: { amountMinor: 1500, currency: 'USD' },
  createdAt: '2026-11-08T21:50:00.000Z', ...patch });
const pauseRow = (patch = {}) => ({ pauseId: randomUUID(), membershipId: id, policyVersion: 1, startsOn: '2026-11-08', plannedResumeOn: '2026-11-18', pauseReason: 'Travel',
  holdFee: null, pausedAt: '2026-11-08T21:50:00.000Z', endedKind: null, endedOn: null, endReason: null, endedAt: null, membershipState: 'FROZEN', membershipVersion: 3, ...patch });
const refundRow = (patch = {}) => ({ refundId: randomUUID(), membershipId: id, amountMinor: 4500, currency: 'USD', refundedOn: '2026-11-08', method: 'CASH', reason: 'Goodwill',
  recordedAt: '2026-11-08T21:50:00.000Z', ...patch });

function fixture(options = {}) {
  const queries = [];
  const db = {
    async transaction(c, work, readOnly) {
      return work({ query: async (sql, args = []) => {
        queries.push({ sql, args, readOnly });
        // The service never writes a table itself: only the protected functions do.
        assert.doesNotMatch(sql, /(INSERT|UPDATE|DELETE)\s|hon\.(?:memberships|membership_pauses|membership_refund_records|school_membership_pause_policies|invoices|payment_\w+)\b/);
        if (/^SET LOCAL/.test(sql) || /set_config\('app\.hon_source','HUMAN_UI'/.test(sql)) return { rows: [] };
        if (options.error) throw options.error;
        if (/hon\.read_school_membership_pause_policy\(\$1\)/.test(sql)) return { rows: [{ data: options.read ?? { policy: null, localToday: '2026-11-08' } }] };
        if (/hon\.set_school_membership_pause_policy\(/.test(sql)) return { rows: [{ data: options.set ?? { policy: policy(), replayed: false } }] };
        if (/hon\.pause_school_membership\(/.test(sql)) return { rows: [{ data: options.pause ?? { pause: pauseRow(), replayed: false } }] };
        if (/hon\.resume_school_membership\(/.test(sql)) return { rows: [{ data: options.resume ?? { pause: pauseRow({ endedKind: 'RESUMED', endedOn: '2026-11-09', endedAt: '2026-11-09T18:00:00.000Z', membershipState: 'ACTIVE', membershipVersion: 4 }), replayed: false } }] };
        if (/hon\.record_membership_refund\(/.test(sql)) return { rows: [{ data: options.refund ?? { refund: refundRow(), replayed: false } }] };
        if (/hon\.read_membership_pauses_and_refunds\(/.test(sql)) return { rows: [{ data: options.history ?? { membershipId: id, state: 'ACTIVE', version: 2, localToday: '2026-11-08', pauses: [], refunds: [] } }] };
        throw new Error('Unexpected SQL: ' + sql);
      } });
    },
    withTenantTransaction(c, work) { return this.transaction(c, work, false); },
    withTenantReadOnlyTransaction(c, work) { return this.transaction(c, work, true); },
  };
  return { db, queries, calls: (name) => queries.filter((q) => q.sql.includes(name)) };
}

test('pause is one protected write with the exact subject, membership, closed body, key, request and correlation', async () => {
  const f = fixture(), svc = new MembershipPauseService(f.db), c = context();
  const result = await svc.pause(c, id, { expectedVersion: 2, resumeOn: '2026-11-18', pauseReason: 'Travel' });
  assert.equal(result.pause.membershipState, 'FROZEN');
  assert.equal(result.replayed, false);
  const [call] = f.calls('pause_school_membership');
  assert.equal(call.readOnly, false);
  assert.deepEqual(call.args, [c.externalSubject, id, JSON.stringify({ expectedVersion: 2, resumeOn: '2026-11-18', pauseReason: 'Travel' }), c.idempotencyKey, c.requestId, c.correlationId]);
});

test('input is closed-validated before any database call', async () => {
  const f = fixture(), svc = new MembershipPauseService(f.db);
  for (const body of [{}, { expectedVersion: 2, resumeOn: '2026-02-30', pauseReason: 'x' }, { expectedVersion: 2, resumeOn: '2026-11-18', pauseReason: ' x' },
    { expectedVersion: 0, resumeOn: '2026-11-18', pauseReason: 'x' }, { expectedVersion: 2, resumeOn: '2026-11-18', pauseReason: 'x', fee: 1 }]) {
    await assert.rejects(svc.pause(context(), id, body), status(400, 'VALIDATION_FAILED'));
  }
  await assert.rejects(svc.setPolicy(context(), { expectedVersion: 0, pausesAllowed: false, maxPauseDays: 30, maxPausedDaysPerYear: 60, holdFee: null }), status(400));
  await assert.rejects(svc.setPolicy(context(), { expectedVersion: 0, pausesAllowed: true, maxPauseDays: 61, maxPausedDaysPerYear: 60, holdFee: null }), status(400));
  await assert.rejects(svc.recordRefund(context(), id, { amountMinor: 0, currency: 'USD', refundedOn: '2026-11-08', method: 'CASH', reason: 'x' }), status(400));
  await assert.rejects(svc.recordRefund(context(), id, { amountMinor: 1, currency: 'USD', refundedOn: '2026-11-08', method: 'STRIPE', reason: 'x' }), status(400));
  await assert.rejects(svc.pause(context(), 'not-a-uuid', { expectedVersion: 2, resumeOn: '2026-11-18', pauseReason: 'x' }), status(400));
  assert.equal(f.queries.length, 0);
});

test('only direct human contexts; writes need a key, reads refuse one', async () => {
  const f = fixture(), svc = new MembershipPauseService(f.db), body = { expectedVersion: 2, resumeOn: '2026-11-18', pauseReason: 'Travel' };
  await assert.rejects(svc.pause(context({ principalType: 'SERVICE' }), id, body), status(403, 'HUMAN_COMMAND_REQUIRED'));
  await assert.rejects(svc.pause(context({ source: 'AI_AGENT' }), id, body), status(403, 'HUMAN_COMMAND_REQUIRED'));
  await assert.rejects(svc.pause(context({ actionRequestId: randomUUID() }), id, body), status(403, 'HUMAN_COMMAND_REQUIRED'));
  await assert.rejects(svc.pause(context({ delegatedByPrincipalId: randomUUID() }), id, body), status(403, 'HUMAN_COMMAND_REQUIRED'));
  await assert.rejects(svc.pause(context({ idempotencyKey: '' }), id, body), status(409, 'IDEMPOTENCY_KEY_REQUIRED'));
  await assert.rejects(svc.readPolicy(context()), status(409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED'));
  assert.equal(f.queries.length, 0);
});

test('every database receipt is verified strictly; anything unverifiable is 503', async () => {
  for (const pause of [{ pause: pauseRow({ membershipState: 'ACTIVE' }), replayed: false }, { pause: pauseRow({ membershipId: randomUUID() }), replayed: false },
    { pause: pauseRow(), replayed: false, extra: 1 }, { pause: { ...pauseRow(), secret: 'x' }, replayed: false }, { pause: pauseRow({ plannedResumeOn: '2026-11-08' }), replayed: false }]) {
    const svc = new MembershipPauseService(fixture({ pause }).db);
    await assert.rejects(svc.pause(context(), id, { expectedVersion: 2, resumeOn: '2026-11-18', pauseReason: 'Travel' }), status(503, 'MEMBERSHIP_LIFECYCLE_UNAVAILABLE'));
  }
  const svc = new MembershipPauseService(fixture({ history: { membershipId: id, state: 'ACTIVE', version: 2, localToday: '2026-11-08', pauses: [pauseRow({ membershipState: undefined })], refunds: [] } }).db);
  await assert.rejects(svc.history(readContext(), id), status(503));
});

test('database refusals map to exact codes; unknown failures are unavailable', async () => {
  const cases = [['MEMBERSHIP_PAUSE_FORBIDDEN', '42501', 403], ['MEMBERSHIP_PAUSE_NOT_OFFERED', '40001', 409], ['MEMBERSHIP_PAUSE_TOO_LONG', '22023', 422],
    ['MEMBERSHIP_PAUSE_YEARLY_LIMIT', '22023', 422], ['MEMBERSHIP_PAUSE_REQUIRES_BILLING_ARRANGEMENT', '40001', 409], ['BILLING_MEMBERSHIP_NOT_FOUND', 'P0002', 404],
    ['IDEMPOTENCY_KEY_REUSED', '23505', 409], ['VERSION_CONFLICT', '40001', 409], ['MEMBERSHIP_PAUSE_EVIDENCE_MISSING', '40001', 409]];
  for (const [message, code, expected] of cases) {
    const error = Object.assign(new Error(message), { code });
    const svc = new MembershipPauseService(fixture({ error }).db);
    await assert.rejects(svc.pause(context(), id, { expectedVersion: 2, resumeOn: '2026-11-18', pauseReason: 'Travel' }), status(expected, message));
  }
  const svc = new MembershipPauseService(fixture({ error: Object.assign(new Error('boom'), { code: 'XX000' }) }).db);
  await assert.rejects(svc.recordRefund(context(), id, { amountMinor: 1, currency: 'USD', refundedOn: '2026-11-08', method: 'CASH', reason: 'x' }), status(503));
});

test('reads are read-only transactions and return verified data', async () => {
  const f = fixture({ read: { policy: policy(), localToday: '2026-11-08' } }), svc = new MembershipPauseService(f.db);
  const read = await svc.readPolicy(readContext());
  assert.equal(read.policy.maxPauseDays, 30);
  assert.equal(f.calls('read_school_membership_pause_policy')[0].readOnly, true);
  const history = await new MembershipPauseService(fixture({ history: { membershipId: id, state: 'FROZEN', version: 3, localToday: '2026-11-08',
    pauses: [{ ...pauseRow(), membershipState: undefined, membershipVersion: undefined }].map(({ membershipState, membershipVersion, ...rest }) => rest), refunds: [] } }).db).history(readContext(), id);
  assert.equal(history.pauses.length, 1);
  assert.equal(typeof contracts.verifyMembershipPausesAndRefunds, 'function');
});
