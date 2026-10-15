import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for work-item integrity tests.');
if (!process.env.HON_RUNTIME_DATABASE_URL) throw new Error('HON_RUNTIME_DATABASE_URL is required for work-item integrity tests.');

const connectionOptions = (connectionString) => ({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});

const { WorkItemController } = await import('../../../apps/api/dist/work-items/work-item.controller.js');
const { WorkItemService } = await import('../../../apps/api/dist/work-items/work-item.service.js');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');

const administrator = new Client(connectionOptions(process.env.DATABASE_URL));
const runtime = new Client(connectionOptions(process.env.HON_RUNTIME_DATABASE_URL));
const ids = Object.fromEntries(
  [
    'organization', 'schoolA', 'schoolB', 'user', 'principal', 'ownerRole',
    'foreignWorkItem', 'subject', 'foreignSubject',
  ].map((key) => [key, randomUUID()]),
);
const externalSubject = `work-item-${randomUUID()}`;

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
    await administrator.query('DELETE FROM hon.outbox_events WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.audit_events WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.idempotency_records WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.work_items WHERE organization_id = $1', [ids.organization]);
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
const workItems = new WorkItemService(database);
const controller = new WorkItemController(database, workItems);

try {
  const posture = await administrator.query(`
    SELECT relrowsecurity, relforcerowsecurity
    FROM pg_class
    WHERE oid = 'hon.work_items'::regclass
  `);
  assert(posture.rows[0]?.relrowsecurity && posture.rows[0]?.relforcerowsecurity,
    'work_items must enable and force row-level security.');
  const privileges = await runtime.query(`
    SELECT
      has_table_privilege(current_user, 'hon.work_items', 'SELECT') AS can_select,
      has_table_privilege(current_user, 'hon.work_items', 'INSERT') AS can_insert,
      has_table_privilege(current_user, 'hon.work_items', 'UPDATE') AS can_update,
      has_table_privilege(current_user, 'hon.work_items', 'DELETE') AS can_delete
  `);
  const grants = privileges.rows[0];
  assert(grants?.can_select && grants?.can_insert && grants?.can_update && !grants?.can_delete,
    'hon_runtime work_items privileges are not the reviewed SELECT/INSERT/UPDATE minimum.');

  await administrator.query('BEGIN');
  try {
    await administrator.query(
      'INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, $2, $2)',
      [ids.organization, 'Work Item Integrity Test'],
    );
    await administrator.query(
      `INSERT INTO hon.schools (id, organization_id, name, slug) VALUES
       ($1, $2, 'Work Item School A', $3),
       ($4, $2, 'Work Item School B', $5)`,
      [
        ids.schoolA, ids.organization, `work-item-a-${ids.schoolA.slice(0, 8)}`,
        ids.schoolB, `work-item-b-${ids.schoolB.slice(0, 8)}`,
      ],
    );
    await administrator.query(
      'INSERT INTO hon.users (id, external_subject, email, display_name) VALUES ($1, $2, $3, $4)',
      [ids.user, externalSubject, `work-item-${ids.user}@example.test`, 'Work Item Manager'],
    );
    await administrator.query(
      `INSERT INTO hon.principals (id, principal_type, user_id, display_name)
       VALUES ($1, 'HUMAN_USER', $2, 'Work Item Manager')`,
      [ids.principal, ids.user],
    );
    await administrator.query(
      `INSERT INTO hon.roles (id, organization_id, code, name, is_system_role)
       VALUES ($1, $2, 'OWNER', 'School Owner', true)`,
      [ids.ownerRole, ids.organization],
    );
    await administrator.query(
      `INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
       SELECT $1::uuid, $2::uuid, code
       FROM hon.permissions
       WHERE code IN ('work_item.create', 'work_item.read', 'work_item.manage')`,
      [ids.ownerRole, ids.organization],
    );
    await administrator.query(
      `INSERT INTO hon.principal_role_grants (
         organization_id, school_id, principal_id, role_id, granted_by_principal_id
       ) VALUES ($1, $2, $3, $4, $3)`,
      [ids.organization, ids.schoolA, ids.principal, ids.ownerRole],
    );
    await administrator.query(
      `INSERT INTO hon.work_items (
         id, organization_id, school_id, work_type, status, subject_type, subject_id, payload, correlation_id
       ) VALUES ($1, $2, $3, 'FOREIGN_FIXTURE', 'READY', 'FIXTURE', $4::uuid, '{}'::jsonb, $5::uuid)`,
      [ids.foreignWorkItem, ids.organization, ids.schoolB, ids.foreignSubject, randomUUID()],
    );
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }

  const request = { honIdentity: { externalSubject } };
  const createInput = {
    workType: 'SCHEDULE_RECONCILIATION',
    subjectType: 'CLASS_SESSION',
    subjectId: ids.subject,
    payload: { requestedBy: 'human-test', dryRun: true },
  };
  const createKey = `work-item-create-${randomUUID()}`;
  const firstResponse = responseCapture();
  const first = await controller.create(
    ids.organization, ids.schoolA, createKey, createInput, request, firstResponse,
  );
  assert(firstResponse.statusCode === 201 && !first.meta.replayed
    && first.data.status === 'READY' && first.data.version === 1,
  'The human create command did not create an initial READY work item.');
  assert(!('assignedPrincipalId' in first.data) && !('payload' in first.data) && !('result' in first.data),
    'The work-item command response exposed identity or arbitrary raw payload data.');

  const stored = await administrator.query(
    `SELECT status, version, assigned_principal_id, payload
     FROM hon.work_items WHERE id = $1::uuid`,
    [first.data.id],
  );
  assert(stored.rows[0]?.status === 'READY' && stored.rows[0]?.version === 1
    && stored.rows[0]?.assigned_principal_id === null,
  'Work-item creation did not preserve READY-only, unassigned initial state.');

  const replayResponse = responseCapture();
  const replay = await controller.create(
    ids.organization, ids.schoolA, createKey, createInput, request, replayResponse,
  );
  assert(replayResponse.statusCode === 200 && replay.meta.replayed && replay.data.id === first.data.id,
    'Matching work-item creation did not idempotently replay the original response.');
  await expectStatus(409, () => controller.create(
    ids.organization, ids.schoolA, createKey,
    { ...createInput, payload: { requestedBy: 'human-test', dryRun: false } }, request, responseCapture(),
  ), 'A reused work-item create idempotency key accepted a different command.');
  await expectStatus(403, () => controller.create(
    randomUUID(), ids.schoolA, `wrong-org-${randomUUID()}`, createInput, request, responseCapture(),
  ), 'Work-item creation accepted an organization route outside the resolved scope.');
  await expectStatus(400, () => workItems.create({
    organizationId: ids.organization,
    schoolId: ids.schoolA,
    principalId: ids.principal,
    principalType: 'HUMAN_USER',
    requestId: randomUUID(),
    correlationId: randomUUID(),
    idempotencyKey: `bad-payload-${randomUUID()}`,
    source: 'HUMAN_UI',
  }, { workType: 'BAD', payload: ['not-an-object'] }),
  'A non-object work-item payload was accepted.');

  const listed = await controller.list(ids.organization, ids.schoolA, { limit: 50 }, request);
  assert(listed.data.some((item) => item.id === first.data.id)
    && !listed.data.some((item) => item.id === ids.foreignWorkItem)
    && listed.data.every((item) => !('assignedPrincipalId' in item) && !('payload' in item) && !('result' in item)),
  'Limited work-item list leaked foreign-scope, principal, or raw payload data.');

  await runtime.query('BEGIN');
  try {
    await runtime.query(
      `SELECT set_config('app.hon_organization_id', $1, true),
              set_config('app.hon_school_id', $2, true)`,
      [ids.organization, ids.schoolA],
    );
    await runtime.query('SELECT hon.require_tenant_context()');
    const visible = await runtime.query('SELECT id FROM hon.work_items WHERE id = $1::uuid', [first.data.id]);
    const hidden = await runtime.query('SELECT id FROM hon.work_items WHERE id = $1::uuid', [ids.foreignWorkItem]);
    assert(visible.rowCount === 1 && hidden.rowCount === 0,
      'RLS exposed a work item from another school.');
    await runtime.query('ROLLBACK');
  } catch (error) {
    await runtime.query('ROLLBACK');
    throw error;
  }

  const workingKey = `work-item-working-${randomUUID()}`;
  const working = await controller.transition(
    ids.organization, ids.schoolA, first.data.id, workingKey,
    { targetStatus: 'WORKING', expectedVersion: 1, result: { started: true } }, request, responseCapture(),
  );
  assert(!working.meta.replayed && working.data.status === 'WORKING' && working.data.version === 2,
    'A version-matched READY to WORKING transition was not recorded.');
  const workingReplay = await controller.transition(
    ids.organization, ids.schoolA, first.data.id, workingKey,
    { targetStatus: 'WORKING', expectedVersion: 1, result: { started: true } }, request, responseCapture(),
  );
  assert(workingReplay.meta.replayed && workingReplay.data.id === first.data.id,
    'Matching work-item transition did not idempotently replay the original response.');
  await expectStatus(409, () => controller.transition(
    ids.organization, ids.schoolA, first.data.id, `stale-${randomUUID()}`,
    { targetStatus: 'WAITING', expectedVersion: 1 }, request, responseCapture(),
  ), 'A stale work-item expectedVersion was accepted.');

  const completed = await controller.transition(
    ids.organization, ids.schoolA, first.data.id, `complete-${randomUUID()}`,
    { targetStatus: 'COMPLETED', expectedVersion: 2, result: { reconciled: true } }, request, responseCapture(),
  );
  assert(completed.data.status === 'COMPLETED' && completed.data.version === 3,
    'A version-matched WORKING to COMPLETED transition was not recorded.');
  await expectStatus(409, () => controller.transition(
    ids.organization, ids.schoolA, first.data.id, `reopen-${randomUUID()}`,
    { targetStatus: 'READY', expectedVersion: 3 }, request, responseCapture(),
  ), 'A terminal work item was silently reopened.');
  await expectStatus(403, () => workItems.transition({
    organizationId: ids.organization,
    schoolId: ids.schoolA,
    principalId: ids.principal,
    principalType: 'AUTOMATION',
    requestId: randomUUID(),
    correlationId: randomUUID(),
    idempotencyKey: `automation-${randomUUID()}`,
    source: 'AUTOMATION',
  }, first.data.id, { targetStatus: 'READY', expectedVersion: 3 }),
  'A non-human work-item transition context was accepted.');

  const evidence = await administrator.query(`
    SELECT
      (SELECT count(*)::integer FROM hon.audit_events
       WHERE organization_id = $1 AND action_code = 'work_item.create') AS create_audits,
      (SELECT count(*)::integer FROM hon.outbox_events
       WHERE organization_id = $1 AND event_type = 'work_item.created' AND schema_version = 1) AS create_outbox,
      (SELECT count(*)::integer FROM hon.audit_events
       WHERE organization_id = $1 AND action_code = 'work_item.transition') AS transition_audits,
      (SELECT count(*)::integer FROM hon.outbox_events
       WHERE organization_id = $1 AND event_type = 'work_item.transitioned' AND schema_version = 1) AS transition_outbox
  `, [ids.organization]);
  assert(evidence.rows[0]?.create_audits === 1 && evidence.rows[0]?.create_outbox === 1
    && evidence.rows[0]?.transition_audits === 2 && evidence.rows[0]?.transition_outbox === 2,
  'Each successful work-item command did not atomically emit its required audit and v1 outbox event.');

  console.log('Verified durable work-item permission scope, forced RLS isolation, exact runtime grants, initial READY/unassigned creation, bounded input, limited list projection, idempotency, optimistic transitions, terminal non-reopening, human-only command context, and atomic audit/outbox evidence.');
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
