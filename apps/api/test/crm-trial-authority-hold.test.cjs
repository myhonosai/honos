const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { TrialAppointmentService } = require('../dist/crm/trial-appointment.service.js');
const { TrialAppointmentOutcomeService } = require('../dist/crm/trial-appointment-outcome.service.js');

// Launch-readiness P1 (0629): trial schedule/outcome commands hold their authority rows after the command's own
// serialization lock and before the re-check, and re-check once more before returning, on new and replayed commands.
const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const context = () => ({ ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID() });
const leadId = randomUUID();
const appointmentId = randomUUID();
const start = new Date(Date.now() + 86_400_000);
const end = new Date(start.getTime() + 3_600_000);
const row = (status = 'SCHEDULED') => ({ id: appointmentId, crmLeadId: leadId, appointmentType: 'TRIAL', status, startsAt: start, endsAt: end,
  location: null, notes: null, createdByPrincipalId: scope.principalId, version: 1, createdAt: start, updatedAt: start });

function fakeDatabase({ replay = false, holdRefused = false, authorizedChecks = Infinity } = {}) {
  const calls = []; let fingerprint; let checks = 0;
  const client = { query: async (sql, args) => {
    calls.push(sql);
    if (sql.includes('hold_crm_trial_authority')) {
      if (holdRefused) throw Object.assign(new Error('CRM_TRIAL_FORBIDDEN'), { code: '42501' });
      return { rows: [{}] };
    }
    if (sql.includes('resolve_authorized_scope')) {
      checks += 1;
      return { rows: checks <= authorizedChecks ? [{ principal_id: scope.principalId, organization_id: scope.organizationId, school_id: scope.schoolId }] : [] };
    }
    if (sql.includes('SELECT tier')) return { rows: [{ tier: 'CORE' }] };
    if (sql.includes('SELECT id FROM hon.crm_leads')) return { rows: [{ id: leadId }], rowCount: 1 };
    if (sql.includes('INSERT INTO hon.idempotency_records')) { fingerprint ??= args[4]; return replay ? { rows: [], rowCount: 0 } : { rows: [{ id: randomUUID() }], rowCount: 1 }; }
    if (sql.includes('SELECT request_fingerprint')) return { rows: [{ request_fingerprint: fingerprint, status: 'COMPLETED', response_body: { id: appointmentId } }] };
    if (sql.includes('FROM hon.crm_appointments') && sql.includes('FOR UPDATE')) return { rows: [row()], rowCount: 1 };
    if (sql.includes('FROM hon.crm_appointments')) return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO hon.crm_appointments')) return { rows: [row()], rowCount: 1 };
    if (sql.includes('UPDATE hon.crm_appointments')) return { rows: [{ ...row('NO_SHOW'), version: 2 }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  } };
  return { calls, database: { withTenantTransaction: async (_c, work) => work(client) } };
}

const label = (sql) => sql.includes('pg_advisory_xact_lock') ? 'lead-lock'
  : sql.includes('hold_crm_trial_authority') ? 'hold'
    : sql.includes('resolve_authorized_scope') ? 'auth'
      : sql.includes('INSERT INTO hon.idempotency_records') ? 'reserve'
        : sql.includes('FROM hon.crm_appointments') && sql.includes('FOR UPDATE') ? 'row-lock'
          : sql.includes('UPDATE hon.idempotency_records') ? 'complete' : null;
const order = (calls) => calls.map(label).filter(Boolean);
const input = { startsAt: start.toISOString(), endsAt: end.toISOString() };
const authority = { externalSubject: 'signed-subject' };

test('trial scheduling: lead lock, then authority hold, then re-check, before the reservation; re-checked again before returning', async () => {
  const { calls, database } = fakeDatabase();
  const result = await new TrialAppointmentService(database).schedule(context(), leadId, input, authority);
  assert.equal(result.replayed, false);
  assert.deepEqual(order(calls), ['lead-lock', 'hold', 'auth', 'reserve', 'complete', 'auth']);
  assert.ok(calls.find((sql) => sql.includes('hold_crm_trial_authority')).includes('SELECT hon.hold_crm_trial_authority($1)'));
});

test('trial scheduling replay re-checks authority after the idempotency wait', async () => {
  const { calls, database } = fakeDatabase({ replay: true });
  const result = await new TrialAppointmentService(database).schedule(context(), leadId, input, authority);
  assert.equal(result.replayed, true);
  assert.deepEqual(order(calls), ['lead-lock', 'hold', 'auth', 'reserve', 'auth']);
});

test('trial scheduling: a refused hold or a failed final check is 403 and nothing is returned', async () => {
  await assert.rejects(() => new TrialAppointmentService(fakeDatabase({ holdRefused: true }).database).schedule(context(), leadId, input, authority),
    (error) => error.getStatus() === 403);
  const refusedLate = fakeDatabase({ authorizedChecks: 1 });
  await assert.rejects(() => new TrialAppointmentService(refusedLate.database).schedule(context(), leadId, input, authority),
    (error) => error.getStatus() === 403);
  assert.deepEqual(order(refusedLate.calls), ['lead-lock', 'hold', 'auth', 'reserve', 'complete', 'auth']);
});

test('trial outcome: row lock, then authority hold, then re-check, before the reservation; re-checked again before returning', async () => {
  const { calls, database } = fakeDatabase();
  const result = await new TrialAppointmentOutcomeService(database).record(context(), appointmentId, { status: 'NO_SHOW', expectedVersion: 1 }, authority);
  assert.equal(result.replayed, false);
  assert.deepEqual(order(calls), ['row-lock', 'hold', 'auth', 'reserve', 'complete', 'auth']);
  await assert.rejects(() => new TrialAppointmentOutcomeService(fakeDatabase({ holdRefused: true }).database)
    .record(context(), appointmentId, { status: 'NO_SHOW', expectedVersion: 1 }, authority), (error) => error.getStatus() === 403);
});
