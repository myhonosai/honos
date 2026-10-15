import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for membership cancellation integrity tests.');
if (!process.env.HON_RUNTIME_DATABASE_URL) throw new Error('HON_RUNTIME_DATABASE_URL is required for membership cancellation integrity tests.');
const connectionOptions = (connectionString) => ({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});
const { MembershipController } = await import('../../../apps/api/dist/billing/membership.controller.js');
const { MembershipService } = await import('../../../apps/api/dist/billing/membership.service.js');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');

const ids = Object.fromEntries([
  'organization', 'schoolA', 'schoolB', 'user', 'principal', 'ownerRole',
  'personA', 'personB', 'accountA', 'accountB', 'membershipA', 'membershipB',
  'staleMembership', 'terminalMembership', 'draftMembership', 'scheduleA', 'invoiceA',
].map((key) => [key, randomUUID()]));
const externalSubject = `membership-cancel-${randomUUID()}`;
const administrator = new Client(connectionOptions(process.env.DATABASE_URL));
const runtime = new Client(connectionOptions(process.env.HON_RUNTIME_DATABASE_URL));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function responseCapture() {
  return {
    statusCode: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
  };
}
async function expectStatus(expectedStatus, operation, message) {
  try {
    await operation();
    throw new Error(message);
  } catch (error) {
    if (error instanceof Error && error.message === message) throw error;
    if (typeof error?.getStatus !== 'function' || error.getStatus() !== expectedStatus) throw error;
  }
}
async function cleanupFixtures() {
  await administrator.query('BEGIN');
  try {
    await administrator.query('DELETE FROM hon.outbox_delivery_attempts WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.outbox_events WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.audit_events WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.idempotency_records WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.communication_messages WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.payment_attempts WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.invoices WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.membership_payment_schedules WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.memberships WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.billing_accounts WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.principal_role_grants WHERE principal_id = $1', [ids.principal]);
    await administrator.query('DELETE FROM hon.role_permissions WHERE role_id = $1', [ids.ownerRole]);
    await administrator.query('DELETE FROM hon.roles WHERE id = $1', [ids.ownerRole]);
    await administrator.query('DELETE FROM hon.principals WHERE id = $1', [ids.principal]);
    await administrator.query('DELETE FROM hon.users WHERE id = $1', [ids.user]);
    await administrator.query('DELETE FROM hon.people WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.schools WHERE id IN ($1, $2)', [ids.schoolA, ids.schoolB]);
    await administrator.query('DELETE FROM hon.organizations WHERE id = $1', [ids.organization]);
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }
}

await administrator.connect();
await runtime.connect();
const database = new RuntimeDatabaseService();
const service = new MembershipService(database);
const controller = new MembershipController(database, service);
try {
  const permission = await administrator.query(
    "SELECT is_sensitive FROM hon.permissions WHERE code = 'billing.membership.cancel'",
  );
  assert(permission.rowCount === 1 && permission.rows[0]?.is_sensitive,
    'billing.membership.cancel must be seeded as a sensitive permission.');
  const states = await administrator.query(
    'SELECT unnest(enum_range(NULL::hon.membership_state))::text AS state',
  );
  const stateSet = new Set(states.rows.map((row) => row.state));
  assert(stateSet.has('ACTIVE') && stateSet.has('CANCELLED') && stateSet.has('DRAFT')
    && stateSet.has('CANCELLATION_PENDING'),
  'Membership cancellation must use the canonical ACTIVE and CANCELLED states while leaving DRAFT and CANCELLATION_PENDING unsupported by this direct command.');
  const posture = await administrator.query(
    "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'hon.memberships'::regclass",
  );
  assert(posture.rows[0]?.relrowsecurity && posture.rows[0]?.relforcerowsecurity,
    'memberships must retain enabled and forced row-level security.');
  const grants = (await runtime.query(`
    SELECT
      has_table_privilege(current_user, 'hon.memberships', 'SELECT') AS can_select,
      has_table_privilege(current_user, 'hon.memberships', 'INSERT') AS can_insert,
      has_table_privilege(current_user, 'hon.memberships', 'UPDATE') AS can_update,
      has_table_privilege(current_user, 'hon.memberships', 'DELETE') AS can_delete,
      has_table_privilege(current_user, 'hon.membership_payment_schedules', 'UPDATE') AS can_update_schedule,
      has_table_privilege(current_user, 'hon.payment_attempts', 'INSERT') AS can_create_payment_attempt
  `)).rows[0];
  assert(grants?.can_select && grants?.can_insert && grants?.can_update && !grants?.can_delete
    && !grants?.can_update_schedule && !grants?.can_create_payment_attempt,
  'Cancellation must retain the reviewed membership privileges without payment-schedule or payment-attempt writes.');

  await administrator.query('BEGIN');
  try {
    await administrator.query(
      'INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, $2, $2)',
      [ids.organization, 'Billing Membership Cancellation Integrity Test'],
    );
    await administrator.query(
      `INSERT INTO hon.schools (id, organization_id, name, slug) VALUES
       ($1, $2, 'Membership Cancellation School A', $3), ($4, $2, 'Membership Cancellation School B', $5)`,
      [
        ids.schoolA, ids.organization, `membership-cancel-a-${ids.schoolA.slice(0, 8)}`,
        ids.schoolB, `membership-cancel-b-${ids.schoolB.slice(0, 8)}`,
      ],
    );
    await administrator.query(
      'INSERT INTO hon.users (id, external_subject, email, display_name) VALUES ($1, $2, $3, $4)',
      [ids.user, externalSubject, `membership-cancel-${ids.user}@example.test`, 'Membership Canceller'],
    );
    await administrator.query(
      `INSERT INTO hon.principals (id, principal_type, user_id, display_name)
       VALUES ($1, 'HUMAN_USER', $2, 'Membership Canceller')`,
      [ids.principal, ids.user],
    );
    await administrator.query(
      `INSERT INTO hon.roles (id, organization_id, code, name, is_system_role)
       VALUES ($1, $2, 'OWNER', 'School Owner', true)`,
      [ids.ownerRole, ids.organization],
    );
    await administrator.query(
      `INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
       VALUES ($1, $2, 'billing.membership.cancel')`,
      [ids.ownerRole, ids.organization],
    );
    await administrator.query(
      `INSERT INTO hon.principal_role_grants (
         organization_id, school_id, principal_id, role_id, granted_by_principal_id
       ) VALUES ($1, $2, $3, $4, $3)`,
      [ids.organization, ids.schoolA, ids.principal, ids.ownerRole],
    );
    await administrator.query(
      `INSERT INTO hon.people (id, organization_id, school_id, given_name, family_name) VALUES
       ($1, $2, $3, 'Avery', 'Local'), ($4, $2, $5, 'Bailey', 'Foreign')`,
      [ids.personA, ids.organization, ids.schoolA, ids.personB, ids.schoolB],
    );
    await administrator.query(
      `INSERT INTO hon.billing_accounts (id, organization_id, school_id, responsible_person_id, currency) VALUES
       ($1, $2, $3, $4, 'USD'), ($5, $2, $6, $7, 'USD')`,
      [ids.accountA, ids.organization, ids.schoolA, ids.personA, ids.accountB, ids.schoolB, ids.personB],
    );
    await administrator.query(
      `INSERT INTO hon.memberships (
         id, organization_id, school_id, billing_account_id, participant_person_id, plan_code, state
       ) VALUES
       ($1, $2, $3, $4, $5, 'LOCAL_ACTIVE', 'ACTIVE'),
       ($6, $2, $7, $8, $9, 'FOREIGN_ACTIVE', 'ACTIVE'),
       ($10, $2, $3, $4, $5, 'STALE_ACTIVE', 'ACTIVE'),
       ($11, $2, $3, $4, $5, 'TERMINAL_CANCELLED', 'CANCELLED'),
       ($12, $2, $3, $4, $5, 'DRAFT_UNSUPPORTED', 'DRAFT')`,
      [
        ids.membershipA, ids.organization, ids.schoolA, ids.accountA, ids.personA,
        ids.membershipB, ids.schoolB, ids.accountB, ids.personB,
        ids.staleMembership, ids.terminalMembership, ids.draftMembership,
      ],
    );
    await administrator.query(
      `INSERT INTO hon.membership_payment_schedules (
         id, organization_id, school_id, membership_id, frequency, amount_minor, currency, next_charge_at, auto_renew
       ) VALUES ($1, $2, $3, $4, 'MONTHLY', 1250, 'USD', '2030-02-01T00:00:00Z', true)`,
      [ids.scheduleA, ids.organization, ids.schoolA, ids.membershipA],
    );
    await administrator.query(
      `INSERT INTO hon.invoices (
         id, organization_id, school_id, billing_account_id, membership_id, status, currency,
         subtotal_minor, discount_minor, total_minor, due_at
       ) VALUES ($1, $2, $3, $4, $5, 'DRAFT', 'USD', 1250, 0, 1250, '2030-02-01T00:00:00Z')`,
      [ids.invoiceA, ids.organization, ids.schoolA, ids.accountA, ids.membershipA],
    );
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }

  const request = { honIdentity: { externalSubject } };
  const cancelKey = `membership-cancel-${randomUUID()}`;
  const effectiveAt = new Date(Date.now() + 60_000).toISOString();
  const input = {
    expectedVersion: 1,
    cancellationReason: 'Member requested cancellation',
    effectiveAt,
  };
  const firstResponse = responseCapture();
  const cancelled = await controller.cancel(
    ids.organization, ids.schoolA, ids.membershipA, cancelKey, input, request, firstResponse,
  );
  assert(firstResponse.statusCode === 200 && !cancelled.meta.replayed
    && cancelled.data.id === ids.membershipA && cancelled.data.state === 'CANCELLED'
    && cancelled.data.version === 2 && cancelled.data.cancellationReason === input.cancellationReason
    && cancelled.data.effectiveAt === input.effectiveAt,
  'An ACTIVE membership was not atomically cancelled with its version, reason, and effective timestamp evidence.');

  const replayResponse = responseCapture();
  const replay = await controller.cancel(
    ids.organization, ids.schoolA, ids.membershipA, cancelKey, input, request, replayResponse,
  );
  assert(replayResponse.statusCode === 200 && replay.meta.replayed
    && replay.data.state === 'CANCELLED' && replay.data.version === 2
    && replay.data.cancellationReason === input.cancellationReason,
  'A matching membership cancellation idempotency request did not replay the cancelled result.');
  await expectStatus(409, () => controller.cancel(
    ids.organization, ids.schoolA, ids.membershipA, cancelKey,
    { ...input, expectedVersion: 2 }, request, responseCapture(),
  ), 'A membership cancellation idempotency key was reused for a different request.');
  await expectStatus(409, () => controller.cancel(
    ids.organization, ids.schoolA, ids.membershipA, `already-cancelled-${randomUUID()}`,
    { ...input, expectedVersion: 2 }, request, responseCapture(),
  ), 'An already CANCELLED membership was cancelled a second time.');
  await expectStatus(409, () => controller.cancel(
    ids.organization, ids.schoolA, ids.terminalMembership, `terminal-${randomUUID()}`,
    input, request, responseCapture(),
  ), 'A terminal membership was cancelled.');
  await expectStatus(409, () => controller.cancel(
    ids.organization, ids.schoolA, ids.draftMembership, `draft-${randomUUID()}`,
    input, request, responseCapture(),
  ), 'A DRAFT membership was cancelled by the direct ACTIVE-only command.');
  await expectStatus(409, () => controller.cancel(
    ids.organization, ids.schoolA, ids.staleMembership, `stale-${randomUUID()}`,
    { ...input, expectedVersion: 2 }, request, responseCapture(),
  ), 'Membership cancellation accepted a stale expectedVersion.');
  await expectStatus(404, () => controller.cancel(
    ids.organization, ids.schoolA, ids.membershipB, `foreign-${randomUUID()}`,
    input, request, responseCapture(),
  ), 'Membership cancellation exposed or transitioned a membership outside the RLS school scope.');
  await expectStatus(403, () => controller.cancel(
    randomUUID(), ids.schoolA, ids.staleMembership, `wrong-org-${randomUUID()}`,
    input, request, responseCapture(),
  ), 'Membership cancellation accepted a route organization that did not exactly match the resolved scope.');
  await expectStatus(409, () => controller.cancel(
    ids.organization, ids.schoolA, ids.staleMembership, undefined, input, request, responseCapture(),
  ), 'Membership cancellation accepted a missing Idempotency-Key.');
  await expectStatus(400, () => service.cancel({
    organizationId: ids.organization, schoolId: ids.schoolA, principalId: ids.principal,
    principalType: 'HUMAN_USER', requestId: randomUUID(), correlationId: randomUUID(),
    idempotencyKey: `invalid-version-${randomUUID()}`, source: 'HUMAN_UI',
  }, ids.staleMembership, { ...input, expectedVersion: 0 }), 'Membership cancellation accepted a non-positive expectedVersion.');
  await expectStatus(400, () => service.cancel({
    organizationId: ids.organization, schoolId: ids.schoolA, principalId: ids.principal,
    principalType: 'HUMAN_USER', requestId: randomUUID(), correlationId: randomUUID(),
    idempotencyKey: `blank-reason-${randomUUID()}`, source: 'HUMAN_UI',
  }, ids.staleMembership, { ...input, cancellationReason: '   ' }), 'Membership cancellation accepted a blank reason.');
  await expectStatus(400, () => service.cancel({
    organizationId: ids.organization, schoolId: ids.schoolA, principalId: ids.principal,
    principalType: 'HUMAN_USER', requestId: randomUUID(), correlationId: randomUUID(),
    idempotencyKey: `bad-time-${randomUUID()}`, source: 'HUMAN_UI',
  }, ids.staleMembership, { ...input, effectiveAt: '2030-01-31T17:00:00' }), 'Membership cancellation accepted an unqualified effectiveAt.');
  await expectStatus(400, () => service.cancel({
    organizationId: ids.organization, schoolId: ids.schoolA, principalId: ids.principal,
    principalType: 'HUMAN_USER', requestId: randomUUID(), correlationId: randomUUID(),
    idempotencyKey: `past-time-${randomUUID()}`, source: 'HUMAN_UI',
  }, ids.staleMembership, { ...input, effectiveAt: '2000-01-01T00:00:00Z' }), 'Membership cancellation accepted an effectiveAt beyond the five-minute past tolerance.');
  await expectStatus(403, () => service.cancel({
    organizationId: ids.organization, schoolId: ids.schoolA, principalId: ids.principal,
    principalType: 'HUMAN_USER', requestId: randomUUID(), correlationId: randomUUID(),
    idempotencyKey: `ai-${randomUUID()}`, source: 'AI',
  }, ids.staleMembership, input), 'Membership cancellation accepted a non-HUMAN_UI source.');
  await expectStatus(403, () => service.cancel({
    organizationId: ids.organization, schoolId: ids.schoolA, principalId: ids.principal,
    principalType: 'HUMAN_USER', requestId: randomUUID(), correlationId: randomUUID(),
    idempotencyKey: `action-${randomUUID()}`, source: 'HUMAN_UI', actionRequestId: randomUUID(),
  }, ids.staleMembership, input), 'Membership cancellation accepted an Action Engine request context.');
  await expectStatus(403, () => service.cancel({
    organizationId: ids.organization, schoolId: ids.schoolA, principalId: ids.principal,
    principalType: 'HUMAN_USER', requestId: randomUUID(), correlationId: randomUUID(),
    idempotencyKey: `delegated-${randomUUID()}`, source: 'HUMAN_UI', delegatedByPrincipalId: randomUUID(),
  }, ids.staleMembership, input), 'Membership cancellation accepted a delegated command context.');

  await runtime.query('BEGIN');
  try {
    await runtime.query(
      `SELECT set_config('app.hon_organization_id', $1, true), set_config('app.hon_school_id', $2, true)`,
      [ids.organization, ids.schoolA],
    );
    await runtime.query('SELECT hon.require_tenant_context()');
    const visible = await runtime.query('SELECT id FROM hon.memberships WHERE id = $1::uuid FOR UPDATE', [ids.membershipA]);
    const hidden = await runtime.query('SELECT id FROM hon.memberships WHERE id = $1::uuid FOR UPDATE', [ids.membershipB]);
    assert(visible.rowCount === 1 && hidden.rowCount === 0,
      'RLS did not constrain the locked membership cancellation lookup to the resolved school.');
    await runtime.query('ROLLBACK');
  } catch (error) {
    await runtime.query('ROLLBACK');
    throw error;
  }

  const evidence = await administrator.query(`
    SELECT
      (SELECT count(*)::integer FROM hon.audit_events WHERE organization_id = $1 AND action_code = 'billing.membership.cancel') AS audits,
      (SELECT count(*)::integer FROM hon.outbox_events WHERE organization_id = $1 AND event_type = 'billing.membership.cancelled' AND schema_version = 1) AS outbox,
      (SELECT count(*)::integer FROM hon.invoices WHERE organization_id = $1) AS invoices,
      (SELECT count(*)::integer FROM hon.payment_attempts WHERE organization_id = $1) AS payment_attempts,
      (SELECT count(*)::integer FROM hon.action_requests WHERE organization_id = $1) AS action_requests,
      (SELECT count(*)::integer FROM hon.communication_messages WHERE organization_id = $1) AS communications,
      (SELECT count(*)::integer FROM hon.attendance_records WHERE organization_id = $1) AS attendance_records,
      (SELECT count(*)::integer FROM hon.class_bookings WHERE organization_id = $1) AS class_bookings,
      (SELECT count(*)::integer FROM hon.ai_usage_ledger WHERE organization_id = $1) AS ai_usage,
      (SELECT count(*)::integer FROM hon.ai_invocation_plans WHERE organization_id = $1) AS ai_plans,
      (SELECT count(*)::integer FROM hon.memberships WHERE organization_id = $1) AS membership_count,
      (SELECT state::text FROM hon.memberships WHERE id = $2::uuid) AS cancelled_state,
      (SELECT version FROM hon.memberships WHERE id = $2::uuid) AS cancelled_version,
      (SELECT state::text FROM hon.memberships WHERE id = $3::uuid) AS foreign_state,
      (SELECT version FROM hon.memberships WHERE id = $3::uuid) AS foreign_version,
      (SELECT state::text FROM hon.memberships WHERE id = $4::uuid) AS stale_state,
      (SELECT version FROM hon.memberships WHERE id = $4::uuid) AS stale_version,
      (SELECT state::text FROM hon.memberships WHERE id = $5::uuid) AS terminal_state,
      (SELECT state::text FROM hon.memberships WHERE id = $6::uuid) AS draft_state,
      (SELECT currency FROM hon.billing_accounts WHERE id = $9::uuid) AS account_currency,
      (SELECT version FROM hon.billing_accounts WHERE id = $9::uuid) AS account_version,
      (SELECT amount_minor FROM hon.membership_payment_schedules WHERE id = $7::uuid) AS schedule_amount_minor,
      (SELECT next_charge_at::text FROM hon.membership_payment_schedules WHERE id = $7::uuid) AS schedule_next_charge_at,
      (SELECT auto_renew FROM hon.membership_payment_schedules WHERE id = $7::uuid) AS schedule_auto_renew,
      (SELECT status FROM hon.membership_payment_schedules WHERE id = $7::uuid) AS schedule_status,
      (SELECT status::text FROM hon.invoices WHERE id = $8::uuid) AS invoice_status,
      (SELECT prior_state->>'state' FROM hon.audit_events WHERE organization_id = $1 AND action_code = 'billing.membership.cancel') AS prior_state,
      (SELECT next_state->>'state' FROM hon.audit_events WHERE organization_id = $1 AND action_code = 'billing.membership.cancel') AS next_state,
      (SELECT next_state->>'cancellationReason' FROM hon.audit_events WHERE organization_id = $1 AND action_code = 'billing.membership.cancel') AS audit_reason,
      (SELECT payload->>'effectiveAt' FROM hon.outbox_events WHERE organization_id = $1 AND event_type = 'billing.membership.cancelled') AS event_effective_at
  `, [ids.organization, ids.membershipA, ids.membershipB, ids.staleMembership, ids.terminalMembership, ids.draftMembership, ids.scheduleA, ids.invoiceA, ids.accountA]);
  const row = evidence.rows[0];
  assert(row?.audits === 1 && row?.outbox === 1 && row?.invoices === 1
    && row?.payment_attempts === 0 && row?.action_requests === 0 && row?.communications === 0
    && row?.attendance_records === 0 && row?.class_bookings === 0 && row?.ai_usage === 0 && row?.ai_plans === 0
    && row?.membership_count === 5
    && row?.cancelled_state === 'CANCELLED' && row?.cancelled_version === 2
    && row?.foreign_state === 'ACTIVE' && row?.foreign_version === 1
    && row?.stale_state === 'ACTIVE' && row?.stale_version === 1
    && row?.terminal_state === 'CANCELLED' && row?.draft_state === 'DRAFT'
    && row?.account_currency === 'USD' && row?.account_version === 1
    && row?.schedule_amount_minor === 1250 && row?.schedule_next_charge_at?.startsWith('2030-02-01') && row?.schedule_auto_renew === true && row?.schedule_status === 'ACTIVE'
    && row?.invoice_status === 'DRAFT' && row?.prior_state === 'ACTIVE' && row?.next_state === 'CANCELLED'
    && row?.audit_reason === input.cancellationReason && row?.event_effective_at === input.effectiveAt,
  'Membership cancellation did not retain atomic evidence, ACTIVE-to-CANCELLED-only semantics, or the no-payment/provider/schedule/invoice/attendance/booking/communication/Action-Engine/AI side-effect boundary.');

  console.log('Verified human-only tenant-scoped ACTIVE-to-CANCELLED membership cancellation, exact sensitive permission, forced RLS locked lookup, version/idempotency/terminal validation, atomic billing.membership.cancel/billing.membership.cancelled v1 evidence, and no prohibited side effects.');
} finally {
  try {
    await database.onModuleDestroy();
  } finally {
    try {
      await cleanupFixtures();
    } finally {
      await Promise.all([administrator.end(), runtime.end()]);
    }
  }
}
