import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for communication message queue integrity tests.');
if (!process.env.HON_RUNTIME_DATABASE_URL) throw new Error('HON_RUNTIME_DATABASE_URL is required for communication message queue integrity tests.');

const connectionOptions = (connectionString) => ({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});

const { CommunicationMessageController } = await import('../../../apps/api/dist/communication/communication-message.controller.js');
const { CommunicationMessageService } = await import('../../../apps/api/dist/communication/communication-message.service.js');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');

const ids = Object.fromEntries([
  'organization', 'schoolA', 'schoolB', 'user', 'principal', 'ownerRole', 'personA', 'personB', 'foreignMessage',
].map((key) => [key, randomUUID()]));
const externalSubject = `communication-message-${randomUUID()}`;
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

function messageInput(overrides = {}) {
  return {
    recipientPersonId: ids.personA,
    channel: 'SMS',
    content: 'Your class is scheduled for tomorrow.',
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
    await administrator.query('DELETE FROM hon.communication_messages WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.communication_consents WHERE organization_id = $1', [ids.organization]);
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
const service = new CommunicationMessageService(database);
const controller = new CommunicationMessageController(database, service);

try {
  const permissions = await administrator.query(
    `SELECT code FROM hon.permissions
     WHERE code IN ('communication.message.create', 'communication.message.queue', 'communication.message.read')
     ORDER BY code`,
  );
  assert(permissions.rowCount === 3, 'Communication message create/queue/read permissions were not seeded.');

  const posture = await administrator.query(`
    SELECT relrowsecurity, relforcerowsecurity
    FROM pg_class WHERE oid = 'hon.communication_messages'::regclass
  `);
  assert(posture.rows[0]?.relrowsecurity && posture.rows[0]?.relforcerowsecurity,
    'communication_messages must enable and force row-level security.');

  const grants = (await runtime.query(`
    SELECT
      has_table_privilege(current_user, 'hon.communication_messages', 'SELECT') AS can_select,
      has_table_privilege(current_user, 'hon.communication_messages', 'INSERT') AS can_insert,
      has_table_privilege(current_user, 'hon.communication_messages', 'UPDATE') AS can_update,
      has_table_privilege(current_user, 'hon.communication_messages', 'DELETE') AS can_delete,
      has_type_privilege(current_user, 'hon.communication_message_channel', 'USAGE') AS channel_usage,
      has_type_privilege(current_user, 'hon.communication_message_lifecycle', 'USAGE') AS lifecycle_usage
  `)).rows[0];
  assert(grants?.can_select && grants?.can_insert && grants?.can_update && !grants?.can_delete,
    'hon_runtime communication message grants are not exact SELECT/INSERT/UPDATE and no-DELETE.');
  assert(grants?.channel_usage && grants?.lifecycle_usage,
    'hon_runtime lacks explicit communication message enum usage grants.');

  await administrator.query('BEGIN');
  try {
    await administrator.query(
      'INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, $2, $2)',
      [ids.organization, 'Communication Message Integrity Test'],
    );
    await administrator.query(
      `INSERT INTO hon.schools (id, organization_id, name, slug) VALUES
       ($1, $2, 'Message School A', $3),
       ($4, $2, 'Message School B', $5)`,
      [
        ids.schoolA, ids.organization, `message-a-${ids.schoolA.slice(0, 8)}`,
        ids.schoolB, `message-b-${ids.schoolB.slice(0, 8)}`,
      ],
    );
    await administrator.query(
      'INSERT INTO hon.users (id, external_subject, email, display_name) VALUES ($1, $2, $3, $4)',
      [ids.user, externalSubject, `message-${ids.user}@example.test`, 'Message Staff'],
    );
    await administrator.query(
      `INSERT INTO hon.principals (id, principal_type, user_id, display_name)
       VALUES ($1, 'HUMAN_USER', $2, 'Message Staff')`,
      [ids.principal, ids.user],
    );
    await administrator.query(
      `INSERT INTO hon.roles (id, organization_id, code, name, is_system_role)
       VALUES ($1, $2, 'OWNER', 'School Owner', true)`,
      [ids.ownerRole, ids.organization],
    );
    await administrator.query(
      `INSERT INTO hon.role_permissions (role_id, organization_id, permission_code) VALUES
       ($1, $2, 'communication.message.create'),
       ($1, $2, 'communication.message.queue'),
       ($1, $2, 'communication.message.read')`,
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
      `INSERT INTO hon.communication_messages (
         id, organization_id, school_id, recipient_person_id, channel, content, created_by_principal_id
       ) VALUES ($1, $2, $3, $4, 'EMAIL', 'Foreign-school message', $5)`,
      [ids.foreignMessage, ids.organization, ids.schoolB, ids.personB, ids.principal],
    );
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }

  await administrator.query('BEGIN');
  try {
    await administrator.query('SAVEPOINT foreign_recipient');
    await expectDatabaseError('23503', () => administrator.query(
      `INSERT INTO hon.communication_messages (
         organization_id, school_id, recipient_person_id, channel, content, created_by_principal_id
       ) VALUES ($1, $2, $3, 'SMS', 'Cannot cross school', $4)`,
      [ids.organization, ids.schoolA, ids.personB, ids.principal],
    ), 'Communication message storage accepted a recipient from another school.');
    await administrator.query('ROLLBACK TO SAVEPOINT foreign_recipient');
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }

  const request = { honIdentity: { externalSubject } };
  const createKey = `message-create-${randomUUID()}`;
  const firstResponse = responseCapture();
  const first = await controller.create(
    ids.organization, ids.schoolA, createKey,
    messageInput({ scheduledAt: '2030-05-01T09:15:30-07:00' }), request, firstResponse,
  );
  assert(firstResponse.statusCode === 201 && !first.meta.replayed,
    'The first communication message draft was not created with HTTP 201.');
  assert(first.data.lifecycle === 'DRAFT' && first.data.version === 1 && first.data.recipientPersonId === ids.personA,
    'Message creation did not produce the expected DRAFT-only state.');

  const replayResponse = responseCapture();
  const replay = await controller.create(
    ids.organization, ids.schoolA, createKey,
    messageInput({ scheduledAt: '2030-05-01T09:15:30-07:00' }), request, replayResponse,
  );
  assert(replayResponse.statusCode === 200 && replay.meta.replayed && replay.data.id === first.data.id,
    'A matching create idempotency request did not replay its original draft.');
  await expectStatus(409, () => controller.create(
    ids.organization, ids.schoolA, createKey, messageInput({ content: 'Different command' }), request, responseCapture(),
  ), 'A reused message-create idempotency key accepted a different command.');

  const listed = await controller.list(ids.organization, ids.schoolA, { recipientPersonId: ids.personA }, request);
  assert(listed.data.length === 1 && listed.data[0]?.id === first.data.id,
    'Narrow RLS-scoped message list did not return the local draft.');

  await expectStatus(403, () => controller.queue(
    ids.organization, ids.schoolA, first.data.id, `message-no-consent-${randomUUID()}`, { expectedVersion: 1 }, request,
  ), 'Queueing without a current consent record was accepted.');

  await administrator.query(
    `INSERT INTO hon.communication_consents (
       organization_id, school_id, person_id, channel, status, source, captured_at, updated_by_principal_id
     ) VALUES ($1, $2, $3, 'SMS', 'OPTED_OUT', 'STAFF', now(), $4)`,
    [ids.organization, ids.schoolA, ids.personA, ids.principal],
  );
  await expectStatus(403, () => controller.queue(
    ids.organization, ids.schoolA, first.data.id, `message-opted-out-${randomUUID()}`, { expectedVersion: 1 }, request,
  ), 'Queueing with OPTED_OUT consent was accepted.');

  await administrator.query(
    `UPDATE hon.communication_consents
     SET status = 'OPTED_IN', version = version + 1, updated_at = now(), updated_by_principal_id = $2
     WHERE organization_id = $1 AND person_id = $3`,
    [ids.organization, ids.principal, ids.personA],
  );
  const queueKey = `message-queue-${randomUUID()}`;
  const queued = await controller.queue(
    ids.organization, ids.schoolA, first.data.id, queueKey, { expectedVersion: 1 }, request,
  );
  assert(!queued.meta.replayed && queued.data.lifecycle === 'QUEUED' && queued.data.version === 2
    && queued.data.queuedByPrincipalId === ids.principal,
  'OPTED_IN consent did not allow a versioned DRAFT-to-QUEUED transition.');

  const queuedReplay = await controller.queue(
    ids.organization, ids.schoolA, first.data.id, queueKey, { expectedVersion: 1 }, request,
  );
  assert(queuedReplay.meta.replayed && queuedReplay.data.lifecycle === 'QUEUED' && queuedReplay.data.version === 2,
    'A matching queue idempotency request did not replay its original result.');
  await expectStatus(409, () => controller.queue(
    ids.organization, ids.schoolA, first.data.id, `message-stale-${randomUUID()}`, { expectedVersion: 1 }, request,
  ), 'Queueing accepted a stale expectedVersion.');
  await expectStatus(409, () => controller.queue(
    ids.organization, ids.schoolA, first.data.id, `message-terminal-${randomUUID()}`, { expectedVersion: 2 }, request,
  ), 'Queueing accepted a terminal QUEUED message.');
  await expectStatus(404, () => controller.create(
    ids.organization, ids.schoolA, `message-foreign-${randomUUID()}`, messageInput({ recipientPersonId: ids.personB }), request, responseCapture(),
  ), 'Message creation exposed or accepted a person in another school.');

  await runtime.query('BEGIN');
  try {
    await runtime.query(
      `SELECT set_config('app.hon_organization_id', $1, true), set_config('app.hon_school_id', $2, true)`,
      [ids.organization, ids.schoolA],
    );
    await runtime.query('SELECT hon.require_tenant_context()');
    const visible = await runtime.query('SELECT id FROM hon.communication_messages WHERE id = $1::uuid', [first.data.id]);
    const hidden = await runtime.query('SELECT id FROM hon.communication_messages WHERE id = $1::uuid', [ids.foreignMessage]);
    assert(visible.rowCount === 1 && hidden.rowCount === 0,
      'RLS exposed a communication message from another school.');
    await runtime.query('ROLLBACK');
  } catch (error) {
    await runtime.query('ROLLBACK');
    throw error;
  }

  const evidence = await administrator.query(`
    SELECT
      (SELECT count(*)::integer FROM hon.communication_messages WHERE organization_id = $1) AS messages,
      (SELECT count(*)::integer FROM hon.audit_events WHERE organization_id = $1 AND action_code IN ('communication.message.create', 'communication.message.queue')) AS audits,
      (SELECT count(*)::integer FROM hon.outbox_events WHERE organization_id = $1 AND event_type IN ('communication.message.drafted', 'communication.message.queued') AND schema_version = 1) AS outbox,
      (SELECT count(*)::integer FROM hon.outbox_delivery_attempts WHERE organization_id = $1) AS delivery_attempts,
      (SELECT lifecycle::text FROM hon.communication_messages WHERE id = $2::uuid) AS lifecycle
  `, [ids.organization, first.data.id]);
  assert(evidence.rows[0]?.messages === 2 && evidence.rows[0]?.audits === 2 && evidence.rows[0]?.outbox === 2
    && evidence.rows[0]?.delivery_attempts === 0 && evidence.rows[0]?.lifecycle === 'QUEUED',
  'Message queue commands did not preserve atomic audit/v1 outbox evidence and a no-delivery posture.');

  console.log('Verified provider-neutral communication message queue permissions, forced RLS, exact grants, recipient composite ownership, cross-school isolation, human-only draft/queue commands, no-consent and OPTED_OUT denial, OPTED_IN queue success, version/terminal/idempotent behavior, narrow list scope, atomic audit/outbox evidence, and no external delivery side effect.');
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
