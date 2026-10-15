import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for billing invoice draft integrity tests.');
if (!process.env.HON_RUNTIME_DATABASE_URL) throw new Error('HON_RUNTIME_DATABASE_URL is required for billing invoice draft integrity tests.');
const connectionOptions = (connectionString) => ({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});
const { InvoiceController } = await import('../../../apps/api/dist/billing/invoice.controller.js');
const { InvoiceService } = await import('../../../apps/api/dist/billing/invoice.service.js');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');

const ids = Object.fromEntries([
  'organization', 'schoolA', 'schoolB', 'user', 'principal', 'ownerRole',
  'personA', 'personB', 'accountA', 'accountB', 'membershipA', 'membershipB',
].map((key) => [key, randomUUID()]));
const externalSubject = `invoice-draft-${randomUUID()}`;
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
function invoiceInput(overrides = {}) {
  return {
    billingAccountId: ids.accountA,
    membershipId: ids.membershipA,
    dueAt: '2030-05-01T09:15:30-07:00',
    currency: 'USD',
    subtotalMinor: 1250,
    ...overrides,
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
async function expectDatabaseError(expectedCode, operation, message) {
  try {
    await operation();
    throw new Error(message);
  } catch (error) {
    if (error instanceof Error && error.message === message) throw error;
    if (error?.code !== expectedCode) throw error;
  }
}
async function cleanupFixtures() {
  await administrator.query('BEGIN');
  try {
    await administrator.query('DELETE FROM hon.outbox_delivery_attempts WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.outbox_events WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.audit_events WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.idempotency_records WHERE organization_id = $1', [ids.organization]);
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
  const permissions = await administrator.query(
    "SELECT code FROM hon.permissions WHERE code = 'billing.invoice.create'",
  );
  assert(permissions.rowCount === 1, 'billing.invoice.create permission was not seeded.');
  const posture = await administrator.query(`
    SELECT relrowsecurity, relforcerowsecurity
    FROM pg_class WHERE oid = 'hon.invoices'::regclass
  `);
  assert(posture.rows[0]?.relrowsecurity && posture.rows[0]?.relforcerowsecurity,
    'invoices must retain enabled and forced row-level security.');
  const grants = (await runtime.query(`
    SELECT
      has_table_privilege(current_user, 'hon.invoices', 'SELECT') AS can_select,
      has_table_privilege(current_user, 'hon.invoices', 'INSERT') AS can_insert,
      has_table_privilege(current_user, 'hon.invoices', 'UPDATE') AS can_update,
      has_table_privilege(current_user, 'hon.invoices', 'DELETE') AS can_delete
  `)).rows[0];
  assert(grants?.can_select && grants?.can_insert && grants?.can_update && !grants?.can_delete,
    'hon_runtime invoice grants are not exact SELECT/INSERT/UPDATE with no DELETE.');

  await administrator.query('BEGIN');
  try {
    await administrator.query(
      'INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, $2, $2)',
      [ids.organization, 'Billing Invoice Draft Integrity Test'],
    );
    await administrator.query(
      `INSERT INTO hon.schools (id, organization_id, name, slug) VALUES
       ($1, $2, 'Invoice School A', $3),
       ($4, $2, 'Invoice School B', $5)`,
      [
        ids.schoolA, ids.organization, `invoice-a-${ids.schoolA.slice(0, 8)}`,
        ids.schoolB, `invoice-b-${ids.schoolB.slice(0, 8)}`,
      ],
    );
    await administrator.query(
      'INSERT INTO hon.users (id, external_subject, email, display_name) VALUES ($1, $2, $3, $4)',
      [ids.user, externalSubject, `invoice-${ids.user}@example.test`, 'Invoice Staff'],
    );
    await administrator.query(
      `INSERT INTO hon.principals (id, principal_type, user_id, display_name)
       VALUES ($1, 'HUMAN_USER', $2, 'Invoice Staff')`,
      [ids.principal, ids.user],
    );
    await administrator.query(
      `INSERT INTO hon.roles (id, organization_id, code, name, is_system_role)
       VALUES ($1, $2, 'OWNER', 'School Owner', true)`,
      [ids.ownerRole, ids.organization],
    );
    await administrator.query(
      `INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
       VALUES ($1, $2, 'billing.invoice.create')`,
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
       ($1, $2, $3, 'Avery', 'Local'),
       ($4, $2, $5, 'Bailey', 'Foreign')`,
      [ids.personA, ids.organization, ids.schoolA, ids.personB, ids.schoolB],
    );
    await administrator.query(
      `INSERT INTO hon.billing_accounts (id, organization_id, school_id, responsible_person_id, currency) VALUES
       ($1, $2, $3, $4, 'USD'),
       ($5, $2, $6, $7, 'USD')`,
      [ids.accountA, ids.organization, ids.schoolA, ids.personA, ids.accountB, ids.schoolB, ids.personB],
    );
    await administrator.query(
      `INSERT INTO hon.memberships (
         id, organization_id, school_id, billing_account_id, participant_person_id, plan_code
       ) VALUES
       ($1, $2, $3, $4, $5, 'LOCAL_PLAN'),
       ($6, $2, $7, $8, $9, 'FOREIGN_PLAN')`,
      [
        ids.membershipA, ids.organization, ids.schoolA, ids.accountA, ids.personA,
        ids.membershipB, ids.schoolB, ids.accountB, ids.personB,
      ],
    );
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }

  await administrator.query('BEGIN');
  try {
    await administrator.query('SAVEPOINT foreign_invoice_account');
    await expectDatabaseError('23503', () => administrator.query(
      `INSERT INTO hon.invoices (
         organization_id, school_id, billing_account_id, currency, subtotal_minor, total_minor, due_at
       ) VALUES ($1, $2, $3, 'USD', 1, 1, now())`,
      [ids.organization, ids.schoolA, ids.accountB],
    ), 'Invoice storage accepted a billing account from another school.');
    await administrator.query('ROLLBACK TO SAVEPOINT foreign_invoice_account');
    await administrator.query('SAVEPOINT foreign_invoice_membership');
    await expectDatabaseError('23503', () => administrator.query(
      `INSERT INTO hon.invoices (
         organization_id, school_id, billing_account_id, membership_id, currency, subtotal_minor, total_minor, due_at
       ) VALUES ($1, $2, $3, $4, 'USD', 1, 1, now())`,
      [ids.organization, ids.schoolA, ids.accountA, ids.membershipB],
    ), 'Invoice storage accepted a membership from another school.');
    await administrator.query('ROLLBACK TO SAVEPOINT foreign_invoice_membership');
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }

  const request = { honIdentity: { externalSubject } };
  const createKey = `invoice-create-${randomUUID()}`;
  const firstResponse = responseCapture();
  const first = await controller.createDraft(
    ids.organization, ids.schoolA, createKey, invoiceInput(), request, firstResponse,
  );
  assert(firstResponse.statusCode === 201 && !first.meta.replayed,
    'The first invoice draft was not created with HTTP 201.');
  assert(first.data.status === 'DRAFT' && first.data.discountMinor === 0
    && first.data.subtotalMinor === 1250 && first.data.totalMinor === 1250
    && first.data.membershipId === ids.membershipA,
  'Invoice creation did not produce the required exact DRAFT/no-discount derived state.');

  const replayResponse = responseCapture();
  const replay = await controller.createDraft(
    ids.organization, ids.schoolA, createKey, invoiceInput(), request, replayResponse,
  );
  assert(replayResponse.statusCode === 200 && replay.meta.replayed && replay.data.id === first.data.id,
    'A matching invoice idempotency request did not replay the original draft.');
  await expectStatus(409, () => controller.createDraft(
    ids.organization, ids.schoolA, createKey, invoiceInput({ subtotalMinor: 1251 }), request, responseCapture(),
  ), 'An invoice idempotency key was reused for a different draft.');

  await expectStatus(404, () => controller.createDraft(
    ids.organization, ids.schoolA, `foreign-account-${randomUUID()}`,
    invoiceInput({ billingAccountId: ids.accountB, membershipId: undefined }), request, responseCapture(),
  ), 'Invoice creation exposed or accepted a billing account in another school.');
  await expectStatus(404, () => controller.createDraft(
    ids.organization, ids.schoolA, `foreign-membership-${randomUUID()}`,
    invoiceInput({ membershipId: ids.membershipB }), request, responseCapture(),
  ), 'Invoice creation exposed or accepted a membership in another school.');
  await expectStatus(403, () => controller.createDraft(
    randomUUID(), ids.schoolA, `wrong-organization-${randomUUID()}`, invoiceInput(), request, responseCapture(),
  ), 'Invoice creation accepted a route organization that did not exactly match the resolved scope.');
  await expectStatus(400, () => controller.createDraft(
    ids.organization, ids.schoolA, `negative-total-${randomUUID()}`,
    invoiceInput({ subtotalMinor: -1 }), request, responseCapture(),
  ), 'Invoice creation accepted a negative amount.');
  await expectStatus(403, () => service.createDraft({
    organizationId: ids.organization,
    schoolId: ids.schoolA,
    principalId: ids.principal,
    principalType: 'HUMAN_USER',
    requestId: randomUUID(),
    correlationId: randomUUID(),
    idempotencyKey: `non-human-source-${randomUUID()}`,
    source: 'AI',
  }, invoiceInput()), 'Invoice draft creation accepted a non-HUMAN_UI source.');

  const zeroResponse = responseCapture();
  const zero = await controller.createDraft(
    ids.organization, ids.schoolA, `zero-total-${randomUUID()}`,
    invoiceInput({ membershipId: undefined, subtotalMinor: 0 }), request, zeroResponse,
  );
  assert(zeroResponse.statusCode === 201 && zero.data.status === 'DRAFT'
    && zero.data.subtotalMinor === 0 && zero.data.discountMinor === 0 && zero.data.totalMinor === 0,
  'Invoice creation did not preserve an allowed zero-value DRAFT sum.');

  await runtime.query('BEGIN');
  try {
    await runtime.query(
      `SELECT set_config('app.hon_organization_id', $1, true), set_config('app.hon_school_id', $2, true)`,
      [ids.organization, ids.schoolA],
    );
    await runtime.query('SELECT hon.require_tenant_context()');
    const visible = await runtime.query('SELECT id FROM hon.billing_accounts WHERE id = $1::uuid', [ids.accountA]);
    const hidden = await runtime.query('SELECT id FROM hon.billing_accounts WHERE id = $1::uuid', [ids.accountB]);
    assert(visible.rowCount === 1 && hidden.rowCount === 0,
      'RLS exposed a billing account from another school during invoice draft authorization.');
    await runtime.query('ROLLBACK');
  } catch (error) {
    await runtime.query('ROLLBACK');
    throw error;
  }

  const evidence = await administrator.query(`
    SELECT
      (SELECT count(*)::integer FROM hon.invoices WHERE organization_id = $1) AS invoices,
      (SELECT count(*)::integer FROM hon.audit_events WHERE organization_id = $1 AND action_code = 'billing.invoice.create') AS audits,
      (SELECT count(*)::integer FROM hon.outbox_events WHERE organization_id = $1 AND event_type = 'billing.invoice.created' AND schema_version = 1) AS outbox,
      (SELECT count(*)::integer FROM hon.payment_attempts WHERE organization_id = $1) AS payment_attempts,
      (SELECT count(*)::integer FROM hon.action_requests WHERE organization_id = $1) AS action_requests,
      (SELECT state::text FROM hon.memberships WHERE id = $2::uuid) AS membership_state,
      (SELECT version FROM hon.memberships WHERE id = $2::uuid) AS membership_version,
      (SELECT status::text FROM hon.invoices WHERE id = $3::uuid) AS invoice_state
  `, [ids.organization, ids.membershipA, first.data.id]);
  assert(evidence.rows[0]?.invoices === 2 && evidence.rows[0]?.audits === 2 && evidence.rows[0]?.outbox === 2
    && evidence.rows[0]?.payment_attempts === 0 && evidence.rows[0]?.action_requests === 0
    && evidence.rows[0]?.membership_state === 'DRAFT' && evidence.rows[0]?.membership_version === 1
    && evidence.rows[0]?.invoice_state === 'DRAFT',
  'Invoice draft command did not retain exact DRAFT state, atomic audit/outbox evidence, or its no-payment/no-membership-side-effect boundary.');

  console.log('Verified invoice DRAFT-only permission/grants, exact scope and RLS reference checks, human-only origin, positive/zero sums, idempotent replay, atomic billing.invoice.create/billing.invoice.created v1 evidence, and no payment, Action Engine, or membership side effect.');
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
