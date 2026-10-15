import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for billing invoice issue integrity tests.');
if (!process.env.HON_RUNTIME_DATABASE_URL) throw new Error('HON_RUNTIME_DATABASE_URL is required for billing invoice issue integrity tests.');
const connectionOptions = (connectionString) => ({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});
const { InvoiceController } = await import('../../../apps/api/dist/billing/invoice.controller.js');
const { InvoiceService } = await import('../../../apps/api/dist/billing/invoice.service.js');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');

const ids = Object.fromEntries([
  'organization', 'schoolA', 'schoolB', 'user', 'principal', 'ownerRole',
  'personA', 'personB', 'accountA', 'accountB', 'membershipA',
  'invoiceA', 'invoiceB', 'staleInvoice',
].map((key) => [key, randomUUID()]));
const externalSubject = `invoice-issue-${randomUUID()}`;
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
const service = new InvoiceService(database);
const controller = new InvoiceController(database, service);
try {
  const permission = await administrator.query(
    "SELECT is_sensitive FROM hon.permissions WHERE code = 'billing.invoice.issue'",
  );
  assert(permission.rowCount === 1 && permission.rows[0]?.is_sensitive,
    'billing.invoice.issue must be seeded as a sensitive permission.');
  const statuses = await administrator.query(
    "SELECT unnest(enum_range(NULL::hon.invoice_status))::text AS status",
  );
  const statusSet = new Set(statuses.rows.map((row) => row.status));
  assert(statusSet.has('DRAFT') && statusSet.has('ISSUED') && !statusSet.has('OPEN'),
    'Invoice issuance must use only the schema-supported DRAFT to ISSUED lifecycle.');
  const posture = await administrator.query(
    "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'hon.invoices'::regclass",
  );
  assert(posture.rows[0]?.relrowsecurity && posture.rows[0]?.relforcerowsecurity,
    'invoices must retain enabled and forced row-level security.');
  const grants = (await runtime.query(`
    SELECT
      has_table_privilege(current_user, 'hon.invoices', 'SELECT') AS can_select,
      has_table_privilege(current_user, 'hon.invoices', 'INSERT') AS can_insert,
      has_table_privilege(current_user, 'hon.invoices', 'UPDATE') AS can_update,
      has_table_privilege(current_user, 'hon.invoices', 'DELETE') AS can_delete,
      has_table_privilege(current_user, 'hon.payment_attempts', 'INSERT') AS can_create_payment_attempt
  `)).rows[0];
  assert(grants?.can_select && grants?.can_insert && grants?.can_update && !grants?.can_delete
    && !grants?.can_create_payment_attempt,
  'hon_runtime invoice issuance grants must be exactly SELECT/INSERT/UPDATE with no DELETE or payment-attempt write.');

  await administrator.query('BEGIN');
  try {
    await administrator.query(
      'INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, $2, $2)',
      [ids.organization, 'Billing Invoice Issue Integrity Test'],
    );
    await administrator.query(
      `INSERT INTO hon.schools (id, organization_id, name, slug) VALUES
       ($1, $2, 'Invoice Issue School A', $3), ($4, $2, 'Invoice Issue School B', $5)`,
      [
        ids.schoolA, ids.organization, `invoice-issue-a-${ids.schoolA.slice(0, 8)}`,
        ids.schoolB, `invoice-issue-b-${ids.schoolB.slice(0, 8)}`,
      ],
    );
    await administrator.query(
      'INSERT INTO hon.users (id, external_subject, email, display_name) VALUES ($1, $2, $3, $4)',
      [ids.user, externalSubject, `invoice-issue-${ids.user}@example.test`, 'Invoice Issuer'],
    );
    await administrator.query(
      `INSERT INTO hon.principals (id, principal_type, user_id, display_name)
       VALUES ($1, 'HUMAN_USER', $2, 'Invoice Issuer')`,
      [ids.principal, ids.user],
    );
    await administrator.query(
      `INSERT INTO hon.roles (id, organization_id, code, name, is_system_role)
       VALUES ($1, $2, 'OWNER', 'School Owner', true)`,
      [ids.ownerRole, ids.organization],
    );
    await administrator.query(
      `INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
       VALUES ($1, $2, 'billing.invoice.issue')`,
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
         id, organization_id, school_id, billing_account_id, participant_person_id, plan_code
       ) VALUES ($1, $2, $3, $4, $5, 'ISSUE_TEST')`,
      [ids.membershipA, ids.organization, ids.schoolA, ids.accountA, ids.personA],
    );
    await administrator.query(
      `INSERT INTO hon.invoices (
         id, organization_id, school_id, billing_account_id, membership_id, status, currency,
         subtotal_minor, discount_minor, total_minor, due_at
       ) VALUES
       ($1, $2, $3, $4, $5, 'DRAFT', 'USD', 1250, 0, 1250, now()),
       ($6, $2, $7, $8, NULL, 'DRAFT', 'USD', 500, 0, 500, now()),
       ($9, $2, $3, $4, NULL, 'DRAFT', 'USD', 300, 0, 300, now())`,
      [
        ids.invoiceA, ids.organization, ids.schoolA, ids.accountA, ids.membershipA,
        ids.invoiceB, ids.schoolB, ids.accountB,
        ids.staleInvoice,
      ],
    );
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }

  const request = { honIdentity: { externalSubject } };
  const issueKey = `invoice-issue-${randomUUID()}`;
  const firstResponse = responseCapture();
  const issued = await controller.issue(
    ids.organization, ids.schoolA, ids.invoiceA, issueKey, { expectedVersion: 1 }, request, firstResponse,
  );
  assert(firstResponse.statusCode === 200 && !issued.meta.replayed
    && issued.data.id === ids.invoiceA && issued.data.status === 'ISSUED' && issued.data.version === 2,
  'A DRAFT invoice was not atomically issued with its version incremented.');

  const replayResponse = responseCapture();
  const replay = await controller.issue(
    ids.organization, ids.schoolA, ids.invoiceA, issueKey, { expectedVersion: 1 }, request, replayResponse,
  );
  assert(replayResponse.statusCode === 200 && replay.meta.replayed
    && replay.data.status === 'ISSUED' && replay.data.version === 2,
  'A matching invoice issue idempotency request did not replay the issued result.');
  await expectStatus(409, () => controller.issue(
    ids.organization, ids.schoolA, ids.invoiceA, issueKey, { expectedVersion: 2 }, request, responseCapture(),
  ), 'An invoice issue idempotency key was reused for a different request.');
  await expectStatus(409, () => controller.issue(
    ids.organization, ids.schoolA, ids.invoiceA, `terminal-${randomUUID()}`, { expectedVersion: 2 }, request, responseCapture(),
  ), 'An already issued invoice was issued a second time.');
  await expectStatus(409, () => controller.issue(
    ids.organization, ids.schoolA, ids.staleInvoice, `stale-${randomUUID()}`, { expectedVersion: 2 }, request, responseCapture(),
  ), 'Invoice issuance accepted a stale expectedVersion.');
  await expectStatus(404, () => controller.issue(
    ids.organization, ids.schoolA, ids.invoiceB, `foreign-${randomUUID()}`, { expectedVersion: 1 }, request, responseCapture(),
  ), 'Invoice issuance exposed or transitioned an invoice outside the RLS school scope.');
  await expectStatus(403, () => controller.issue(
    randomUUID(), ids.schoolA, ids.staleInvoice, `wrong-org-${randomUUID()}`, { expectedVersion: 1 }, request, responseCapture(),
  ), 'Invoice issuance accepted a route organization that did not exactly match the resolved scope.');
  await expectStatus(409, () => controller.issue(
    ids.organization, ids.schoolA, ids.staleInvoice, undefined, { expectedVersion: 1 }, request, responseCapture(),
  ), 'Invoice issuance accepted a missing Idempotency-Key.');
  await expectStatus(400, () => service.issue({
    organizationId: ids.organization,
    schoolId: ids.schoolA,
    principalId: ids.principal,
    principalType: 'HUMAN_USER',
    requestId: randomUUID(),
    correlationId: randomUUID(),
    idempotencyKey: `invalid-version-${randomUUID()}`,
    source: 'HUMAN_UI',
  }, ids.staleInvoice, { expectedVersion: 0 }), 'Invoice issuance accepted a non-positive expectedVersion.');
  await expectStatus(403, () => service.issue({
    organizationId: ids.organization,
    schoolId: ids.schoolA,
    principalId: ids.principal,
    principalType: 'HUMAN_USER',
    requestId: randomUUID(),
    correlationId: randomUUID(),
    idempotencyKey: `ai-${randomUUID()}`,
    source: 'AI',
  }, ids.staleInvoice, { expectedVersion: 1 }), 'Invoice issuance accepted a non-HUMAN_UI source.');
  await expectStatus(403, () => service.issue({
    organizationId: ids.organization,
    schoolId: ids.schoolA,
    principalId: ids.principal,
    principalType: 'HUMAN_USER',
    requestId: randomUUID(),
    correlationId: randomUUID(),
    idempotencyKey: `action-${randomUUID()}`,
    source: 'HUMAN_UI',
    actionRequestId: randomUUID(),
  }, ids.staleInvoice, { expectedVersion: 1 }), 'Invoice issuance accepted an Action Engine request context.');

  await runtime.query('BEGIN');
  try {
    await runtime.query(
      `SELECT set_config('app.hon_organization_id', $1, true), set_config('app.hon_school_id', $2, true)`,
      [ids.organization, ids.schoolA],
    );
    await runtime.query('SELECT hon.require_tenant_context()');
    const visible = await runtime.query('SELECT id FROM hon.invoices WHERE id = $1::uuid', [ids.invoiceA]);
    const hidden = await runtime.query('SELECT id FROM hon.invoices WHERE id = $1::uuid', [ids.invoiceB]);
    assert(visible.rowCount === 1 && hidden.rowCount === 0,
      'RLS did not constrain the invoice issuance lookup to the resolved school.');
    await runtime.query('ROLLBACK');
  } catch (error) {
    await runtime.query('ROLLBACK');
    throw error;
  }

  const evidence = await administrator.query(`
    SELECT
      (SELECT count(*)::integer FROM hon.audit_events WHERE organization_id = $1 AND action_code = 'billing.invoice.issue') AS audits,
      (SELECT count(*)::integer FROM hon.outbox_events WHERE organization_id = $1 AND event_type = 'billing.invoice.issued' AND schema_version = 1) AS outbox,
      (SELECT count(*)::integer FROM hon.payment_attempts WHERE organization_id = $1) AS payment_attempts,
      (SELECT count(*)::integer FROM hon.action_requests WHERE organization_id = $1) AS action_requests,
      (SELECT count(*)::integer FROM hon.communication_messages WHERE organization_id = $1) AS communications,
      (SELECT state::text FROM hon.memberships WHERE id = $2::uuid) AS membership_state,
      (SELECT version FROM hon.memberships WHERE id = $2::uuid) AS membership_version,
      (SELECT status::text FROM hon.invoices WHERE id = $3::uuid) AS issued_state,
      (SELECT version FROM hon.invoices WHERE id = $3::uuid) AS issued_version,
      (SELECT status::text FROM hon.invoices WHERE id = $4::uuid) AS stale_state,
      (SELECT version FROM hon.invoices WHERE id = $4::uuid) AS stale_version,
      (SELECT prior_state->>'status' FROM hon.audit_events WHERE organization_id = $1 AND action_code = 'billing.invoice.issue') AS prior_status,
      (SELECT next_state->>'status' FROM hon.audit_events WHERE organization_id = $1 AND action_code = 'billing.invoice.issue') AS next_status
  `, [ids.organization, ids.membershipA, ids.invoiceA, ids.staleInvoice]);
  const row = evidence.rows[0];
  assert(row?.audits === 1 && row?.outbox === 1 && row?.payment_attempts === 0
    && row?.action_requests === 0 && row?.communications === 0
    && row?.membership_state === 'DRAFT' && row?.membership_version === 1
    && row?.issued_state === 'ISSUED' && row?.issued_version === 2
    && row?.stale_state === 'DRAFT' && row?.stale_version === 1
    && row?.prior_status === 'DRAFT' && row?.next_status === 'ISSUED',
  'Invoice issuance did not preserve atomic evidence or its no-provider/no-payment/no-communication/no-membership/no-Action-Engine boundary.');

  console.log('Verified human-only tenant-scoped DRAFT-to-ISSUED invoice issuance, exact permission/grants, RLS lookup, version/idempotency conflicts, atomic audit/outbox v1 evidence, and no prohibited side effects.');
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
