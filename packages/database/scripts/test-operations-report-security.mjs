import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { membershipFixtureStatement } from './membership-activation-test-support.mjs';

const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for operations report security tests.');
if (!process.env.HON_RUNTIME_DATABASE_URL) throw new Error('HON_RUNTIME_DATABASE_URL is required for operations report security tests.');

const connectionOptions = (connectionString) => ({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});

const { OperationsReportController } = await import('../../../apps/api/dist/reports/operations-report.controller.js');
const {
  OperationsReportService,
  normalizeOperationsReportRange,
} = await import('../../../apps/api/dist/reports/operations-report.service.js');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');

const ids = Object.fromEntries(
  [
    'organization', 'schoolA', 'schoolB', 'user', 'principal', 'ownerRole',
    'personA1', 'personA2', 'personB', 'studentA1', 'studentA2', 'studentB',
    'pipelineA', 'stageA', 'pipelineB', 'stageB', 'leadAOpen', 'leadAWon', 'leadB',
    'programA', 'programB', 'sessionAScheduled', 'sessionACompleted', 'sessionACancelled',
    'sessionADraft', 'sessionAOutOfRange', 'sessionB', 'attendanceAPresent', 'attendanceALate',
    'attendanceB', 'billingAccountA', 'billingAccountB', 'membershipAActive', 'membershipAFrozen',
    'membershipB', 'invoiceAOpen', 'invoiceAPaid', 'invoiceAOutOfRange', 'invoiceB',
    'paymentAPending', 'paymentASucceeded', 'paymentAOutOfRange', 'paymentB',
  ].map((key) => [key, randomUUID()]),
);
const externalSubject = `operations-report-${randomUUID()}`;
const now = Date.now();
const from = new Date(now - (2 * 24 * 60 * 60 * 1000));
const to = new Date(now + (2 * 24 * 60 * 60 * 1000));
const inRange = new Date(now - (12 * 60 * 60 * 1000));
const outOfRange = new Date(now - (10 * 24 * 60 * 60 * 1000));

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

const administrator = new Client(connectionOptions(process.env.DATABASE_URL));
const runtime = new Client(connectionOptions(process.env.HON_RUNTIME_DATABASE_URL));

async function cleanupFixtures() {
  await administrator.query('BEGIN');
  try {
    await administrator.query('DELETE FROM hon.attendance_records WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.payment_attempts WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.invoices WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.memberships WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.billing_accounts WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.crm_leads WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.crm_pipeline_stages WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.crm_pipelines WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.student_profiles WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.class_sessions WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.programs WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.people WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.principal_role_grants WHERE principal_id = $1', [ids.principal]);
    await administrator.query('DELETE FROM hon.roles WHERE id = $1', [ids.ownerRole]);
    await administrator.query('DELETE FROM hon.principals WHERE id = $1', [ids.principal]);
    await administrator.query('DELETE FROM hon.users WHERE id = $1', [ids.user]);
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
const service = new OperationsReportService(database);
const controller = new OperationsReportController(database, service);

try {
  const reportingPermission = await administrator.query(
    "SELECT 1 FROM hon.permissions WHERE code = 'reporting.view'",
  );
  assert(reportingPermission.rowCount === 1, 'reporting.view permission migration was not applied.');

  const rlsPosture = await administrator.query(`
    SELECT relname, relrowsecurity, relforcerowsecurity
    FROM pg_class
    WHERE oid = ANY($1::regclass[])
  `, [[
    'hon.student_profiles', 'hon.crm_leads', 'hon.class_sessions', 'hon.attendance_records',
    'hon.memberships', 'hon.invoices', 'hon.payment_attempts',
  ]]);
  assert(rlsPosture.rowCount === 7 && rlsPosture.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
    'Operations report input tables must enable and force row-level security.');

  const billingGrants = (await runtime.query(`
    SELECT
      has_table_privilege(current_user, 'hon.invoices', 'SELECT') AS invoices_can_select,
      has_table_privilege(current_user, 'hon.invoices', 'INSERT') AS invoices_can_insert,
      has_table_privilege(current_user, 'hon.invoices', 'UPDATE') AS invoices_can_update,
      has_table_privilege(current_user, 'hon.invoices', 'DELETE') AS invoices_can_delete,
      has_table_privilege(current_user, 'hon.payment_attempts', 'SELECT') AS payments_can_select,
      has_table_privilege(current_user, 'hon.payment_attempts', 'INSERT') AS payments_can_insert,
      has_table_privilege(current_user, 'hon.payment_attempts', 'UPDATE') AS payments_can_update,
      has_table_privilege(current_user, 'hon.payment_attempts', 'DELETE') AS payments_can_delete
  `)).rows[0];
  assert(billingGrants?.invoices_can_select && billingGrants?.invoices_can_insert
    && billingGrants?.invoices_can_update && !billingGrants?.invoices_can_delete
    && billingGrants?.payments_can_select && !billingGrants?.payments_can_insert
    && !billingGrants?.payments_can_update && !billingGrants?.payments_can_delete,
  'hon_runtime billing grants are not exact invoice SELECT/INSERT/UPDATE and payment SELECT-only minima.');

  const defaultRange = normalizeOperationsReportRange({});
  assert(new Date(defaultRange.to).getTime() - new Date(defaultRange.from).getTime() === 30 * 24 * 60 * 60 * 1000,
    'Operations report default range must be exactly 30 days.');

  await administrator.query('BEGIN');
  try {
    await administrator.query(
      'INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, $2, $2)',
      [ids.organization, 'Operations Report Test'],
    );
    await administrator.query(
      `INSERT INTO hon.schools (id, organization_id, name, slug) VALUES
       ($1, $2, 'Operations School A', $3),
       ($4, $2, 'Operations School B', $5)`,
      [
        ids.schoolA, ids.organization, `operations-a-${ids.schoolA.slice(0, 8)}`,
        ids.schoolB, `operations-b-${ids.schoolB.slice(0, 8)}`,
      ],
    );
    await administrator.query(
      'INSERT INTO hon.users (id, external_subject, email, display_name) VALUES ($1, $2, $3, $4)',
      [ids.user, externalSubject, `operations-${ids.user}@example.test`, 'Operations Owner'],
    );
    await administrator.query(
      `INSERT INTO hon.principals (id, principal_type, user_id, display_name)
       VALUES ($1, 'HUMAN_USER', $2, 'Operations Owner')`,
      [ids.principal, ids.user],
    );
    await administrator.query(
      `INSERT INTO hon.roles (id, organization_id, code, name, is_system_role)
       VALUES ($1, $2, 'OWNER', 'School Owner', true)`,
      [ids.ownerRole, ids.organization],
    );
    await administrator.query(
      `INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
       VALUES ($1, $2, 'reporting.view')`,
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
       ($1, $2, $3, 'A', 'One'),
       ($4, $2, $3, 'A', 'Two'),
       ($5, $2, $6, 'B', 'One')`,
      [ids.personA1, ids.organization, ids.schoolA, ids.personA2, ids.personB, ids.schoolB],
    );
    await administrator.query(
      `INSERT INTO hon.student_profiles (id, organization_id, school_id, person_id) VALUES
       ($1, $2, $3, $4),
       ($5, $2, $3, $6),
       ($7, $2, $8, $9)`,
      [
        ids.studentA1, ids.organization, ids.schoolA, ids.personA1,
        ids.studentA2, ids.personA2,
        ids.studentB, ids.schoolB, ids.personB,
      ],
    );
    await administrator.query(
      `INSERT INTO hon.crm_pipelines (id, organization_id, school_id, name) VALUES
       ($1, $2, $3, 'A Pipeline'),
       ($4, $2, $5, 'B Pipeline')`,
      [ids.pipelineA, ids.organization, ids.schoolA, ids.pipelineB, ids.schoolB],
    );
    await administrator.query(
      `INSERT INTO hon.crm_pipeline_stages (id, organization_id, school_id, pipeline_id, name, position) VALUES
       ($1, $2, $3, $4, 'A Stage', 1),
       ($5, $2, $6, $7, 'B Stage', 1)`,
      [ids.stageA, ids.organization, ids.schoolA, ids.pipelineA, ids.stageB, ids.schoolB, ids.pipelineB],
    );
    await administrator.query(
      `INSERT INTO hon.crm_leads (
         id, organization_id, school_id, primary_person_id, pipeline_id, pipeline_stage_id, status
       ) VALUES
       ($1, $2, $3, $4, $5, $6, 'OPEN'),
       ($7, $2, $3, $8, $5, $6, 'WON'),
       ($9, $2, $10, $11, $12, $13, 'LOST')`,
      [
        ids.leadAOpen, ids.organization, ids.schoolA, ids.personA1, ids.pipelineA, ids.stageA,
        ids.leadAWon, ids.personA2,
        ids.leadB, ids.schoolB, ids.personB, ids.pipelineB, ids.stageB,
      ],
    );
    await administrator.query(
      `INSERT INTO hon.programs (id, organization_id, school_id, name) VALUES
       ($1, $2, $3, 'A Program'),
       ($4, $2, $5, 'B Program')`,
      [ids.programA, ids.organization, ids.schoolA, ids.programB, ids.schoolB],
    );
    await administrator.query(
      `INSERT INTO hon.class_sessions (
         id, organization_id, school_id, program_id, name, starts_at, ends_at, capacity, booking_policy, status, cancellation_reason
       ) VALUES
       ($1, $2, $3, $4, 'Scheduled', $5, $6, 10, 'OPTIONAL_BOOKING', 'SCHEDULED', NULL),
       ($7, $2, $3, $4, 'Completed', $5, $6, 10, 'OPTIONAL_BOOKING', 'COMPLETED', NULL),
       ($8, $2, $3, $4, 'Cancelled', $5, $6, 10, 'OPTIONAL_BOOKING', 'CANCELLED', 'Weather'),
       ($9, $2, $3, $4, 'Draft', $5, $6, 10, 'OPTIONAL_BOOKING', 'DRAFT', NULL),
       ($10, $2, $3, $4, 'Out of range', $11, $12, 10, 'OPTIONAL_BOOKING', 'SCHEDULED', NULL),
       ($13, $2, $14, $15, 'Foreign', $5, $6, 10, 'OPTIONAL_BOOKING', 'COMPLETED', NULL)`,
      [
        ids.sessionAScheduled, ids.organization, ids.schoolA, ids.programA,
        inRange.toISOString(), new Date(inRange.getTime() + 60 * 60 * 1000).toISOString(),
        ids.sessionACompleted, ids.sessionACancelled, ids.sessionADraft,
        ids.sessionAOutOfRange, outOfRange.toISOString(), new Date(outOfRange.getTime() + 60 * 60 * 1000).toISOString(),
        ids.sessionB, ids.schoolB, ids.programB,
      ],
    );
    await administrator.query(
      `INSERT INTO hon.attendance_records (
         id, organization_id, school_id, class_session_id, student_profile_id, status
       ) VALUES
       ($1, $2, $3, $4, $5, 'PRESENT'),
       ($6, $2, $3, $7, $8, 'LATE'),
       ($9, $2, $10, $11, $12, 'UNEXCUSED_ABSENCE')`,
      [
        ids.attendanceAPresent, ids.organization, ids.schoolA, ids.sessionAScheduled, ids.studentA1,
        ids.attendanceALate, ids.sessionACompleted, ids.studentA2,
        ids.attendanceB, ids.schoolB, ids.sessionB, ids.studentB,
      ],
    );
    await administrator.query(
      `INSERT INTO hon.billing_accounts (id, organization_id, school_id, responsible_person_id) VALUES
       ($1, $2, $3, $4),
       ($5, $2, $6, $7)`,
      [ids.billingAccountA, ids.organization, ids.schoolA, ids.personA1, ids.billingAccountB, ids.schoolB, ids.personB],
    );
    await membershipFixtureStatement(administrator,
      `INSERT INTO hon.memberships (
         id, organization_id, school_id, billing_account_id, participant_person_id, plan_code, state
       ) VALUES
       ($1, $2, $3, $4, $5, 'A-Active', 'ACTIVE'),
       ($6, $2, $3, $4, $7, 'A-Frozen', 'FROZEN'),
       ($8, $2, $9, $10, $11, 'B-Cancelled', 'CANCELLED')`,
      [
        ids.membershipAActive, ids.organization, ids.schoolA, ids.billingAccountA, ids.personA1,
        ids.membershipAFrozen, ids.personA2,
        ids.membershipB, ids.schoolB, ids.billingAccountB, ids.personB,
      ],
    );
    await administrator.query(
      `INSERT INTO hon.invoices (
         id, organization_id, school_id, billing_account_id, membership_id, status, currency,
         subtotal_minor, discount_minor, total_minor, created_at
       ) VALUES
       ($1, $2, $3, $4, $5, 'ISSUED', 'USD', 100, 0, 100, $6),
       ($7, $2, $3, $4, $8, 'PAID', 'USD', 100, 0, 100, $6),
       ($9, $2, $3, $4, $5, 'VOID', 'USD', 100, 0, 100, $10),
       ($11, $2, $12, $13, $14, 'UNCOLLECTIBLE', 'USD', 100, 0, 100, $6)`,
      [
        ids.invoiceAOpen, ids.organization, ids.schoolA, ids.billingAccountA, ids.membershipAActive, inRange.toISOString(),
        ids.invoiceAPaid, ids.membershipAFrozen,
        ids.invoiceAOutOfRange, outOfRange.toISOString(),
        ids.invoiceB, ids.schoolB, ids.billingAccountB, ids.membershipB,
      ],
    );
    await administrator.query(
      `INSERT INTO hon.payment_attempts (
         id, organization_id, school_id, invoice_id, provider_code, provider_account_reference,
         provider_idempotency_reference, state, amount_minor, currency, initiated_at
       ) VALUES
       ($1, $2, $3, $4, 'test', $5, $6, 'PENDING', 100, 'USD', $7),
       ($8, $2, $3, $9, 'test', $10, $11, 'SUCCEEDED', 100, 'USD', $7),
       ($12, $2, $3, $13, 'test', $14, $15, 'FAILED', 100, 'USD', $16),
       ($17, $2, $18, $19, 'test', $20, $21, 'REFUNDED', 100, 'USD', $7)`,
      [
        ids.paymentAPending, ids.organization, ids.schoolA, ids.invoiceAOpen, `account-${ids.paymentAPending}`, `key-${ids.paymentAPending}`, inRange.toISOString(),
        ids.paymentASucceeded, ids.invoiceAPaid, `account-${ids.paymentASucceeded}`, `key-${ids.paymentASucceeded}`,
        ids.paymentAOutOfRange, ids.invoiceAOutOfRange, `account-${ids.paymentAOutOfRange}`, `key-${ids.paymentAOutOfRange}`, outOfRange.toISOString(),
        ids.paymentB, ids.schoolB, ids.invoiceB, `account-${ids.paymentB}`, `key-${ids.paymentB}`,
      ],
    );
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }

  const request = { honIdentity: { externalSubject } };
  const response = await controller.read(
    ids.organization,
    ids.schoolA,
    { from: from.toISOString(), to: to.toISOString() },
    request,
  );
  const snapshot = response.data.operationalSnapshot;
  assert(snapshot.organizationId === ids.organization && snapshot.schoolId === ids.schoolA,
    'Operations report response did not retain the resolved organization/school scope.');
  assert(typeof snapshot.generatedAt === 'string' && snapshot.from === from.toISOString() && snapshot.to === to.toISOString(),
    'Operations report did not return server-derived generatedAt and normalized bounds.');
  assert(snapshot.studentProfiles.total === 2
    && snapshot.leads.byStatus.OPEN === 1 && snapshot.leads.byStatus.WON === 1
    && snapshot.leads.byStatus.LOST === 0 && snapshot.leads.byStatus.ARCHIVED === 0,
  'Operations report student or current CRM lead aggregates are incorrect or cross-school data leaked.');
  assert(snapshot.classSessions.inRange.scheduled === 1
    && snapshot.classSessions.inRange.completed === 1 && snapshot.classSessions.inRange.cancelled === 1,
  'Operations report did not derive only requested in-range class-session states.');
  assert(snapshot.attendance.inRangeByStatus.PRESENT === 1
    && snapshot.attendance.inRangeByStatus.LATE === 1
    && snapshot.attendance.inRangeByStatus.UNEXCUSED_ABSENCE === 0,
  'Operations report attendance outcomes were not bounded by the class-session range.');
  assert(snapshot.memberships.byState.ACTIVE === 1 && snapshot.memberships.byState.FROZEN === 1
    && snapshot.memberships.byState.CANCELLED === 0,
  'Operations report membership current-state counts are incorrect or cross-school data leaked.');
  assert(snapshot.invoices.inRangeByStatus.ISSUED === 1 && snapshot.invoices.inRangeByStatus.PAID === 1
    && snapshot.invoices.inRangeByStatus.VOID === 0 && snapshot.invoices.inRangeByStatus.UNCOLLECTIBLE === 0,
  'Operations report invoice state counts were not range-bounded and school-scoped.');
  assert(snapshot.paymentAttempts.inRangeByState.PENDING === 1 && snapshot.paymentAttempts.inRangeByState.SUCCEEDED === 1
    && snapshot.paymentAttempts.inRangeByState.FAILED === 0 && snapshot.paymentAttempts.inRangeByState.REFUNDED === 0,
  'Operations report payment-attempt state counts were not range-bounded and school-scoped.');
  assert(!('id' in snapshot) && !('people' in snapshot) && !('contacts' in snapshot)
    && !('amountMinor' in snapshot) && !('totalMinor' in snapshot) && !('providerCode' in snapshot),
  'Operations report exposed raw people/contact, billing amount, or provider data.');

  await expectStatus(403, () => controller.read(
    randomUUID(), ids.schoolA, { from: from.toISOString(), to: to.toISOString() }, request,
  ), 'Operations report accepted a path organization outside the resolved scope.');
  await expectStatus(400, () => controller.read(
    ids.organization,
    ids.schoolA,
    { from: from.toISOString(), to: new Date(from.getTime() + (93 * 24 * 60 * 60 * 1000)).toISOString() },
    request,
  ), 'Operations report accepted a range longer than 92 days.');
  await expectStatus(400, () => controller.read(
    ids.organization, ids.schoolA, { from: from.toISOString() }, request,
  ), 'Operations report accepted an unbounded one-sided date range.');

  await runtime.query('BEGIN');
  try {
    await runtime.query(
      `SELECT set_config('app.hon_organization_id', $1, true),
              set_config('app.hon_school_id', $2, true)`,
      [ids.organization, ids.schoolA],
    );
    await runtime.query('SELECT hon.require_tenant_context()');
    const foreign = (await runtime.query(`
      SELECT
        EXISTS (SELECT 1 FROM hon.student_profiles WHERE id = $1::uuid) AS student_profile_visible,
        EXISTS (SELECT 1 FROM hon.crm_leads WHERE id = $2::uuid) AS lead_visible,
        EXISTS (SELECT 1 FROM hon.class_sessions WHERE id = $3::uuid) AS session_visible,
        EXISTS (SELECT 1 FROM hon.attendance_records WHERE id = $4::uuid) AS attendance_visible,
        EXISTS (SELECT 1 FROM hon.memberships WHERE id = $5::uuid) AS membership_visible,
        EXISTS (SELECT 1 FROM hon.invoices WHERE id = $6::uuid) AS invoice_visible,
        EXISTS (SELECT 1 FROM hon.payment_attempts WHERE id = $7::uuid) AS payment_visible
    `, [
      ids.studentB, ids.leadB, ids.sessionB, ids.attendanceB, ids.membershipB, ids.invoiceB, ids.paymentB,
    ])).rows[0];
    assert(Object.values(foreign).every((visible) => !visible),
      'RLS exposed an operational-report input from another school.');
    await runtime.query('ROLLBACK');
  } catch (error) {
    await runtime.query('ROLLBACK');
    throw error;
  }
  const clearedContext = await runtime.query(
    'SELECT hon.current_organization_id() AS organization_id, hon.current_school_id() AS school_id',
  );
  assert(clearedContext.rows[0]?.organization_id === null && clearedContext.rows[0]?.school_id === null,
    'Operations reporting fixture left tenant context on a pooled runtime connection.');

  console.log('Verified reporting.view scope, forced RLS, invoice SELECT/INSERT plus payment SELECT-only runtime access, exact aggregate accuracy, bounded time semantics, cross-school invisibility, and no raw operational data exposure.');
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
