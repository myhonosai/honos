import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for communication consent integrity tests.');
if (!process.env.HON_RUNTIME_DATABASE_URL) throw new Error('HON_RUNTIME_DATABASE_URL is required for communication consent integrity tests.');

const connectionOptions = (connectionString) => ({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});

const { CommunicationConsentController } = await import('../../../apps/api/dist/communication/communication-consent.controller.js');
const { CommunicationConsentService } = await import('../../../apps/api/dist/communication/communication-consent.service.js');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');

const ids = Object.fromEntries([
  'organization', 'schoolA', 'schoolB', 'user', 'principal', 'ownerRole', 'personA', 'personB', 'foreignConsent',
].map((key) => [key, randomUUID()]));
const externalSubject = `communication-consent-${randomUUID()}`;
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

function inputFor(status, overrides = {}) {
  return {
    status,
    source: 'STAFF',
    capturedAt: '2030-05-01T09:15:30-07:00',
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
const service = new CommunicationConsentService(database);
const controller = new CommunicationConsentController(database, service);

try {
  const permissions = await administrator.query(
    "SELECT code FROM hon.permissions WHERE code IN ('communication.consent.manage', 'communication.consent.read') ORDER BY code",
  );
  assert(permissions.rowCount === 2, 'Communication consent manage/read permissions were not seeded.');

  const posture = await administrator.query(`
    SELECT relrowsecurity, relforcerowsecurity
    FROM pg_class WHERE oid = 'hon.communication_consents'::regclass
  `);
  assert(posture.rows[0]?.relrowsecurity && posture.rows[0]?.relforcerowsecurity,
    'communication_consents must enable and force row-level security.');

  const grants = (await runtime.query(`
    SELECT
      has_table_privilege(current_user, 'hon.communication_consents', 'SELECT') AS can_select,
      has_table_privilege(current_user, 'hon.communication_consents', 'INSERT') AS can_insert,
      has_table_privilege(current_user, 'hon.communication_consents', 'UPDATE') AS can_update,
      has_table_privilege(current_user, 'hon.communication_consents', 'DELETE') AS can_delete,
      has_type_privilege(current_user, 'hon.communication_consent_channel', 'USAGE') AS channel_usage,
      has_type_privilege(current_user, 'hon.communication_consent_status', 'USAGE') AS status_usage,
      has_type_privilege(current_user, 'hon.communication_consent_source', 'USAGE') AS source_usage
  `)).rows[0];
  assert(grants?.can_select && grants?.can_insert && grants?.can_update && !grants?.can_delete,
    'hon_runtime communication consent grants are not exact SELECT/INSERT/UPDATE and no-DELETE.');
  assert(grants?.channel_usage && grants?.status_usage && grants?.source_usage,
    'hon_runtime lacks explicit communication consent enum usage grants.');

  await administrator.query('BEGIN');
  try {
    await administrator.query(
      'INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, $2, $2)',
      [ids.organization, 'Communication Consent Integrity Test'],
    );
    await administrator.query(
      `INSERT INTO hon.schools (id, organization_id, name, slug) VALUES
       ($1, $2, 'Consent School A', $3),
       ($4, $2, 'Consent School B', $5)`,
      [
        ids.schoolA, ids.organization, `consent-a-${ids.schoolA.slice(0, 8)}`,
        ids.schoolB, `consent-b-${ids.schoolB.slice(0, 8)}`,
      ],
    );
    await administrator.query(
      'INSERT INTO hon.users (id, external_subject, email, display_name) VALUES ($1, $2, $3, $4)',
      [ids.user, externalSubject, `consent-${ids.user}@example.test`, 'Consent Staff'],
    );
    await administrator.query(
      `INSERT INTO hon.principals (id, principal_type, user_id, display_name)
       VALUES ($1, 'HUMAN_USER', $2, 'Consent Staff')`,
      [ids.principal, ids.user],
    );
    await administrator.query(
      `INSERT INTO hon.roles (id, organization_id, code, name, is_system_role)
       VALUES ($1, $2, 'OWNER', 'School Owner', true)`,
      [ids.ownerRole, ids.organization],
    );
    await administrator.query(
      `INSERT INTO hon.role_permissions (role_id, organization_id, permission_code) VALUES
       ($1, $2, 'communication.consent.manage'),
       ($1, $2, 'communication.consent.read')`,
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
      `INSERT INTO hon.communication_consents (
         id, organization_id, school_id, person_id, channel, status, source, captured_at, updated_by_principal_id
       ) VALUES ($1, $2, $3, $4, 'SMS', 'OPTED_OUT', 'IMPORT', now(), $5)`,
      [ids.foreignConsent, ids.organization, ids.schoolB, ids.personB, ids.principal],
    );
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }

  const request = { honIdentity: { externalSubject } };
  const firstKey = `consent-create-${randomUUID()}`;
  const firstResponse = responseCapture();
  const first = await controller.record(
    ids.organization, ids.schoolA, ids.personA, 'EMAIL', firstKey, inputFor('OPTED_IN'), request, firstResponse,
  );
  assert(firstResponse.statusCode === 201 && !first.meta.replayed,
    'The first communication consent record was not created with HTTP 201.');
  assert(first.data.channel === 'EMAIL' && first.data.status === 'OPTED_IN' && first.data.source === 'STAFF'
    && first.data.version === 1 && first.data.capturedAt === '2030-05-01T16:15:30.000Z',
  'First consent did not preserve narrow channel/status/source/capturedAt evidence at version 1.');

  const replayResponse = responseCapture();
  const replay = await controller.record(
    ids.organization, ids.schoolA, ids.personA, 'EMAIL', firstKey, inputFor('OPTED_IN'), request, replayResponse,
  );
  assert(replayResponse.statusCode === 200 && replay.meta.replayed && replay.data.version === 1,
    'A matching communication consent idempotency request did not replay its original response.');
  await expectStatus(409, () => controller.record(
    ids.organization, ids.schoolA, ids.personA, 'EMAIL', firstKey, inputFor('OPTED_OUT'), request, responseCapture(),
  ), 'A reused communication consent idempotency key accepted a different command.');

  const updateResponse = responseCapture();
  const update = await controller.record(
    ids.organization, ids.schoolA, ids.personA, 'EMAIL', `consent-update-${randomUUID()}`,
    inputFor('OPTED_OUT', { capturedAt: '2030-06-01T08:00:00Z', expectedVersion: 1 }), request, updateResponse,
  );
  assert(updateResponse.statusCode === 200 && !update.meta.replayed && update.data.status === 'OPTED_OUT'
    && update.data.version === 2 && update.data.capturedAt === '2030-06-01T08:00:00.000Z',
  'Version-checked consent update did not replace status/capture evidence or increment version.');

  const listed = await controller.list(ids.organization, ids.schoolA, ids.personA, request);
  assert(listed.data.length === 1 && listed.data[0]?.channel === 'EMAIL' && listed.data[0]?.version === 2
    && !Object.hasOwn(listed.data[0], 'personId') && !Object.hasOwn(listed.data[0], 'updatedByPrincipalId'),
  'Scoped consent GET did not return only the narrow consent projection.');

  await expectStatus(409, () => controller.record(
    ids.organization, ids.schoolA, ids.personA, 'EMAIL', `consent-no-version-${randomUUID()}`,
    inputFor('OPTED_IN'), request, responseCapture(),
  ), 'An existing communication consent accepted an update without expectedVersion.');
  await expectStatus(409, () => controller.record(
    ids.organization, ids.schoolA, ids.personA, 'EMAIL', `consent-stale-${randomUUID()}`,
    inputFor('OPTED_IN', { expectedVersion: 1 }), request, responseCapture(),
  ), 'A stale communication consent expectedVersion was accepted.');
  await expectStatus(409, () => controller.record(
    ids.organization, ids.schoolA, ids.personA, 'SMS', `consent-create-version-${randomUUID()}`,
    inputFor('OPTED_IN', { expectedVersion: 1 }), request, responseCapture(),
  ), 'A first communication consent accepted expectedVersion.');
  await expectStatus(404, () => controller.record(
    ids.organization, ids.schoolA, ids.personB, 'SMS', `consent-foreign-${randomUUID()}`,
    inputFor('OPTED_IN'), request, responseCapture(),
  ), 'RLS-scoped person lookup exposed a person from another school.');
  await expectStatus(404, () => controller.list(
    ids.organization, ids.schoolA, ids.personB, request,
  ), 'RLS-scoped consent GET exposed a person from another school.');
  await expectStatus(403, () => controller.record(
    randomUUID(), ids.schoolA, ids.personA, 'SMS', `consent-wrong-org-${randomUUID()}`,
    inputFor('OPTED_IN'), request, responseCapture(),
  ), 'Consent recording accepted an organization route outside its resolved scope.');
  await expectStatus(400, () => service.record({
    organizationId: ids.organization, schoolId: ids.schoolA, principalId: ids.principal,
    principalType: 'HUMAN_USER', requestId: randomUUID(), correlationId: randomUUID(),
    idempotencyKey: `consent-source-${randomUUID()}`, source: 'HUMAN_UI',
  }, ids.personA, 'SMS', inputFor('OPTED_IN', { source: 'PARENT' })),
  'The staff consent endpoint accepted a non-STAFF provenance.');
  await expectStatus(400, () => service.record({
    organizationId: ids.organization, schoolId: ids.schoolA, principalId: ids.principal,
    principalType: 'HUMAN_USER', requestId: randomUUID(), correlationId: randomUUID(),
    idempotencyKey: `consent-timezone-${randomUUID()}`, source: 'HUMAN_UI',
  }, ids.personA, 'SMS', inputFor('OPTED_IN', { capturedAt: '2030-05-01T09:00:00' })),
  'A timezone-free capturedAt value was accepted.');
  await expectStatus(400, () => service.record({
    organizationId: ids.organization, schoolId: ids.schoolA, principalId: ids.principal,
    principalType: 'HUMAN_USER', requestId: randomUUID(), correlationId: randomUUID(),
    idempotencyKey: `consent-calendar-${randomUUID()}`, source: 'HUMAN_UI',
  }, ids.personA, 'SMS', inputFor('OPTED_IN', { capturedAt: '2030-02-30T09:00:00Z' })),
  'An invalid-calendar capturedAt value was accepted.');
  await expectStatus(403, () => service.record({
    organizationId: ids.organization, schoolId: ids.schoolA, principalId: ids.principal,
    principalType: 'AUTOMATION', requestId: randomUUID(), correlationId: randomUUID(),
    idempotencyKey: `consent-automation-${randomUUID()}`, source: 'AUTOMATION',
  }, ids.personA, 'SMS', inputFor('OPTED_IN')),
  'A non-human/non-UI context recorded communication consent.');

  await administrator.query('BEGIN');
  try {
    await administrator.query('SAVEPOINT cross_tenant_person');
    await expectDatabaseError('23503', () => administrator.query(
      `INSERT INTO hon.communication_consents (
         organization_id, school_id, person_id, channel, status, source, captured_at, updated_by_principal_id
       ) VALUES ($1, $2, $3, 'PUSH', 'OPTED_IN', 'STAFF', now(), $4)`,
      [ids.organization, ids.schoolA, ids.personB, ids.principal],
    ), 'Communication consent storage accepted a person from another school.');
    await administrator.query('ROLLBACK TO SAVEPOINT cross_tenant_person');
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }

  await runtime.query('BEGIN');
  try {
    await runtime.query(
      `SELECT set_config('app.hon_organization_id', $1, true), set_config('app.hon_school_id', $2, true)`,
      [ids.organization, ids.schoolA],
    );
    await runtime.query('SELECT hon.require_tenant_context()');
    const visible = await runtime.query('SELECT person_id FROM hon.communication_consents WHERE person_id = $1::uuid', [ids.personA]);
    const hidden = await runtime.query('SELECT person_id FROM hon.communication_consents WHERE person_id = $1::uuid', [ids.personB]);
    assert(visible.rowCount === 1 && hidden.rowCount === 0,
      'RLS exposed a communication consent from another school.');
    await runtime.query('ROLLBACK');
  } catch (error) {
    await runtime.query('ROLLBACK');
    throw error;
  }

  const evidence = await administrator.query(`
    SELECT
      (SELECT count(*)::integer FROM hon.communication_consents WHERE organization_id = $1) AS consents,
      (SELECT count(*)::integer FROM hon.audit_events WHERE organization_id = $1 AND action_code = 'communication.consent.record') AS audits,
      (SELECT count(*)::integer FROM hon.outbox_events WHERE organization_id = $1 AND event_type = 'communication.consent.recorded' AND schema_version = 1) AS outbox,
      (SELECT count(*)::integer FROM hon.outbox_delivery_attempts WHERE organization_id = $1) AS delivery_attempts,
      (SELECT status::text FROM hon.outbox_events WHERE organization_id = $1 AND event_type = 'communication.consent.recorded' ORDER BY occurred_at ASC LIMIT 1) AS outbox_status,
      (SELECT status::text FROM hon.communication_consents WHERE person_id = $2::uuid AND channel = 'EMAIL') AS email_status,
      (SELECT version FROM hon.communication_consents WHERE person_id = $2::uuid AND channel = 'EMAIL') AS email_version,
      (SELECT captured_at::text FROM hon.communication_consents WHERE person_id = $2::uuid AND channel = 'EMAIL') AS email_captured_at
  `, [ids.organization, ids.personA]);
  assert(evidence.rows[0]?.consents === 2 && evidence.rows[0]?.audits === 2 && evidence.rows[0]?.outbox === 2
    && evidence.rows[0]?.delivery_attempts === 0 && evidence.rows[0]?.outbox_status === 'PENDING'
    && evidence.rows[0]?.email_status === 'OPTED_OUT' && evidence.rows[0]?.email_version === 2
    && String(evidence.rows[0]?.email_captured_at).startsWith('2030-06-01 08:00:00+00'),
  'Consent commands did not preserve exactly atomic audit/v1 outbox evidence, versioned state, and pending no-delivery posture.');

  console.log('Verified tenant-scoped communication consent permissions, forced RLS, precise runtime grants, composite person ownership, staff/human evidence boundary, strict capture timestamps, create/update version semantics, idempotent replay, narrow scoped reads, audit/v1 outbox evidence, and no delivery side effects.');
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
