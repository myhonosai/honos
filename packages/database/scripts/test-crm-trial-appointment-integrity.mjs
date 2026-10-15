import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for CRM trial appointment integrity tests.');
if (!process.env.HON_RUNTIME_DATABASE_URL) throw new Error('HON_RUNTIME_DATABASE_URL is required for CRM trial appointment integrity tests.');

const connectionOptions = (connectionString) => ({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});

const { TrialAppointmentController } = await import('../../../apps/api/dist/crm/trial-appointment.controller.js');
const { TrialAppointmentService } = await import('../../../apps/api/dist/crm/trial-appointment.service.js');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');

const ids = Object.fromEntries(
  [
    'organization', 'schoolA', 'schoolB', 'user', 'principal', 'ownerRole',
    'personA', 'personB', 'pipelineA', 'pipelineB', 'stageA', 'stageB', 'leadA', 'leadB',
    'foreignAppointment',
  ].map((key) => [key, randomUUID()]),
);
const externalSubject = `crm-trial-appointment-${randomUUID()}`;
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

function inputFor(startsAt, endsAt, overrides = {}) {
  return {
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    location: 'Studio A',
    notes: 'First visit; parent will attend.',
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
    await administrator.query('DELETE FROM hon.outbox_events WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.audit_events WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.idempotency_records WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.crm_appointments WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.principal_role_grants WHERE principal_id = $1', [ids.principal]);
    await administrator.query('DELETE FROM hon.roles WHERE id = $1', [ids.ownerRole]);
    await administrator.query('DELETE FROM hon.crm_leads WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.crm_pipeline_stages WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.crm_pipelines WHERE organization_id = $1', [ids.organization]);
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
const service = new TrialAppointmentService(database);
const controller = new TrialAppointmentController(database, service);

try {
  const permission = await administrator.query(
    "SELECT 1 FROM hon.permissions WHERE code = 'crm.trial.schedule'",
  );
  assert(permission.rowCount === 1, 'crm.trial.schedule permission migration was not applied.');

  const posture = await administrator.query(`
    SELECT relrowsecurity, relforcerowsecurity
    FROM pg_class
    WHERE oid = 'hon.crm_appointments'::regclass
  `);
  assert(posture.rows[0]?.relrowsecurity && posture.rows[0]?.relforcerowsecurity,
    'crm_appointments must enable and force row-level security.');

  const grants = (await runtime.query(`
    SELECT
      has_table_privilege(current_user, 'hon.crm_appointments', 'SELECT') AS can_select,
      has_table_privilege(current_user, 'hon.crm_appointments', 'INSERT') AS can_insert,
      has_table_privilege(current_user, 'hon.crm_appointments', 'UPDATE') AS can_update,
      has_table_privilege(current_user, 'hon.crm_appointments', 'DELETE') AS can_delete,
      has_type_privilege(current_user, 'hon.crm_appointment_type', 'USAGE') AS type_usage,
      has_type_privilege(current_user, 'hon.crm_appointment_status', 'USAGE') AS status_usage
  `)).rows[0];
  assert(grants?.can_select && grants?.can_insert && !grants?.can_update && !grants?.can_delete,
    'hon_runtime CRM appointment grants are not the exact SELECT/INSERT minimum.');
  assert(grants?.type_usage && grants?.status_usage,
    'hon_runtime lacks explicit CRM appointment enum usage grants.');

  const now = Date.now();
  const startsAt = new Date(now + 3 * 24 * 60 * 60 * 1000);
  const endsAt = new Date(now + 3 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000);

  await administrator.query('BEGIN');
  try {
    await administrator.query(
      'INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, $2, $2)',
      [ids.organization, 'CRM Trial Appointment Integrity Test'],
    );
    await administrator.query(
      `INSERT INTO hon.schools (id, organization_id, name, slug) VALUES
       ($1, $2, 'CRM Trial School A', $3),
       ($4, $2, 'CRM Trial School B', $5)`,
      [
        ids.schoolA, ids.organization, `crm-trial-a-${ids.schoolA.slice(0, 8)}`,
        ids.schoolB, `crm-trial-b-${ids.schoolB.slice(0, 8)}`,
      ],
    );
    await administrator.query(
      'INSERT INTO hon.users (id, external_subject, email, display_name) VALUES ($1, $2, $3, $4)',
      [ids.user, externalSubject, `crm-trial-${ids.user}@example.test`, 'CRM Trial Scheduler'],
    );
    await administrator.query(
      `INSERT INTO hon.principals (id, principal_type, user_id, display_name)
       VALUES ($1, 'HUMAN_USER', $2, 'CRM Trial Scheduler')`,
      [ids.principal, ids.user],
    );
    await administrator.query(
      `INSERT INTO hon.roles (id, organization_id, code, name, is_system_role)
       VALUES ($1, $2, 'OWNER', 'School Owner', true)`,
      [ids.ownerRole, ids.organization],
    );
    await administrator.query(
      `INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
       VALUES ($1, $2, 'crm.trial.schedule')`,
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
      `INSERT INTO hon.crm_pipelines (id, organization_id, school_id, name) VALUES
       ($1, $2, $3, 'Local Pipeline'),
       ($4, $2, $5, 'Foreign Pipeline')`,
      [ids.pipelineA, ids.organization, ids.schoolA, ids.pipelineB, ids.schoolB],
    );
    await administrator.query(
      `INSERT INTO hon.crm_pipeline_stages (
         id, organization_id, school_id, pipeline_id, name, position
       ) VALUES
       ($1, $2, $3, $4, 'New', 1),
       ($5, $2, $6, $7, 'New', 1)`,
      [ids.stageA, ids.organization, ids.schoolA, ids.pipelineA, ids.stageB, ids.schoolB, ids.pipelineB],
    );
    await administrator.query(
      `INSERT INTO hon.crm_leads (
         id, organization_id, school_id, primary_person_id, pipeline_id, pipeline_stage_id, status
       ) VALUES
       ($1, $2, $3, $4, $5, $6, 'OPEN'),
       ($7, $2, $8, $9, $10, $11, 'OPEN')`,
      [
        ids.leadA, ids.organization, ids.schoolA, ids.personA, ids.pipelineA, ids.stageA,
        ids.leadB, ids.schoolB, ids.personB, ids.pipelineB, ids.stageB,
      ],
    );
    await administrator.query(
      `INSERT INTO hon.crm_appointments (
         id, organization_id, school_id, crm_lead_id, appointment_type, status,
         starts_at, ends_at, created_by_principal_id
       ) VALUES (
         $1, $2, $3, $4, 'CONSULTATION', 'SCHEDULED', $5, $6, $7
       )`,
      [ids.foreignAppointment, ids.organization, ids.schoolB, ids.leadB, startsAt.toISOString(), endsAt.toISOString(), ids.principal],
    );
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }

  const request = { honIdentity: { externalSubject } };
  const firstKey = `crm-trial-${randomUUID()}`;
  const firstResponse = responseCapture();
  const first = await controller.schedule(
    ids.organization, ids.schoolA, ids.leadA, firstKey, inputFor(startsAt, endsAt), request, firstResponse,
  );
  assert(firstResponse.statusCode === 201 && !first.meta.replayed,
    'The first CRM trial appointment was not created with HTTP 201.');
  assert(first.data.crmLeadId === ids.leadA && first.data.appointmentType === 'TRIAL'
    && first.data.status === 'SCHEDULED' && first.data.createdByPrincipalId === ids.principal,
  'The endpoint did not create only a scheduled TRIAL appointment attributed to the authenticated principal.');
  assert(first.data.location === 'Studio A' && first.data.notes === 'First visit; parent will attend.',
    'Trial appointment scheduling did not retain normalized location and notes.');

  const replayResponse = responseCapture();
  const replay = await controller.schedule(
    ids.organization, ids.schoolA, ids.leadA, firstKey, inputFor(startsAt, endsAt), request, replayResponse,
  );
  assert(replayResponse.statusCode === 200 && replay.meta.replayed && replay.data.id === first.data.id,
    'A matching trial scheduling idempotency request did not replay its original response.');

  await expectStatus(409, () => controller.schedule(
    ids.organization, ids.schoolA, ids.leadA, firstKey,
    inputFor(new Date(startsAt.getTime() + 60 * 60 * 1000), new Date(endsAt.getTime() + 60 * 60 * 1000)),
    request, responseCapture(),
  ), 'A reused trial idempotency key accepted a different appointment.');
  await expectStatus(403, () => controller.schedule(
    randomUUID(), ids.schoolA, ids.leadA, `wrong-org-${randomUUID()}`, inputFor(startsAt, endsAt), request, responseCapture(),
  ), 'Trial scheduling accepted an organization route outside its resolved scope.');
  await expectStatus(404, () => controller.schedule(
    ids.organization, ids.schoolA, ids.leadB, `foreign-lead-${randomUUID()}`, inputFor(startsAt, endsAt), request, responseCapture(),
  ), 'RLS-scoped lead lookup exposed a lead from another school.');
  await expectStatus(400, () => controller.schedule(
    ids.organization, ids.schoolA, ids.leadA, `timezone-${randomUUID()}`,
    inputFor(startsAt, endsAt, { startsAt: '2030-05-01T09:00:00' }), request, responseCapture(),
  ), 'A timezone-free trial timestamp was accepted.');
  await expectStatus(400, () => controller.schedule(
    ids.organization, ids.schoolA, ids.leadA, `calendar-${randomUUID()}`,
    inputFor(startsAt, endsAt, { startsAt: '2030-02-30T09:00:00Z' }), request, responseCapture(),
  ), 'An invalid-calendar trial timestamp was accepted.');
  await expectStatus(400, () => controller.schedule(
    ids.organization, ids.schoolA, ids.leadA, `ordering-${randomUUID()}`,
    inputFor(endsAt, startsAt), request, responseCapture(),
  ), 'A non-increasing trial appointment range was accepted.');
  await expectStatus(400, () => controller.schedule(
    ids.organization, ids.schoolA, ids.leadA, `past-${randomUUID()}`,
    inputFor(new Date(now - 60 * 60 * 1000), endsAt), request, responseCapture(),
  ), 'A past trial appointment was accepted.');
  await expectStatus(400, () => controller.schedule(
    ids.organization, ids.schoolA, ids.leadA, `future-window-${randomUUID()}`,
    inputFor(new Date(now + 89 * 24 * 60 * 60 * 1000), new Date(now + 91 * 24 * 60 * 60 * 1000)), request, responseCapture(),
  ), 'A trial appointment outside the 90-day scheduling window was accepted.');
  await expectStatus(400, () => controller.schedule(
    ids.organization, ids.schoolA, ids.leadA, `notes-${randomUUID()}`,
    inputFor(startsAt, endsAt, { notes: 'x'.repeat(2001) }), request, responseCapture(),
  ), 'Trial appointment notes longer than 2000 characters were accepted.');
  await expectStatus(403, () => service.schedule({
    organizationId: ids.organization,
    schoolId: ids.schoolA,
    principalId: ids.principal,
    principalType: 'AUTOMATION',
    requestId: randomUUID(),
    correlationId: randomUUID(),
    idempotencyKey: `automation-${randomUUID()}`,
    source: 'AUTOMATION',
  }, ids.leadA, inputFor(startsAt, endsAt)), 'A non-human/non-UI context scheduled a trial appointment.');

  await administrator.query('BEGIN');
  try {
    await administrator.query('SAVEPOINT invalid_range');
    await expectDatabaseError('23514', () => administrator.query(
      `INSERT INTO hon.crm_appointments (
         organization_id, school_id, crm_lead_id, appointment_type, status,
         starts_at, ends_at, created_by_principal_id
       ) VALUES ($1, $2, $3, 'TRIAL', 'SCHEDULED', $4, $5, $6)`,
      [ids.organization, ids.schoolA, ids.leadA, endsAt.toISOString(), startsAt.toISOString(), ids.principal],
    ), 'CRM appointment storage accepted a non-increasing time range.');
    await administrator.query('ROLLBACK TO SAVEPOINT invalid_range');
    await administrator.query('SAVEPOINT cross_tenant_lead');
    await expectDatabaseError('23503', () => administrator.query(
      `INSERT INTO hon.crm_appointments (
         organization_id, school_id, crm_lead_id, appointment_type, status,
         starts_at, ends_at, created_by_principal_id
       ) VALUES ($1, $2, $3, 'TRIAL', 'SCHEDULED', $4, $5, $6)`,
      [ids.organization, ids.schoolA, ids.leadB, startsAt.toISOString(), endsAt.toISOString(), ids.principal],
    ), 'CRM appointment storage accepted a lead from another school.');
    await administrator.query('ROLLBACK TO SAVEPOINT cross_tenant_lead');
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }

  await runtime.query('BEGIN');
  try {
    await runtime.query(
      `SELECT set_config('app.hon_organization_id', $1, true),
              set_config('app.hon_school_id', $2, true)`,
      [ids.organization, ids.schoolA],
    );
    await runtime.query('SELECT hon.require_tenant_context()');
    const visible = await runtime.query('SELECT id FROM hon.crm_appointments WHERE id = $1::uuid', [first.data.id]);
    const hidden = await runtime.query('SELECT id FROM hon.crm_appointments WHERE id = $1::uuid', [ids.foreignAppointment]);
    assert(visible.rowCount === 1 && hidden.rowCount === 0,
      'RLS exposed a CRM appointment from another school.');
    await runtime.query('ROLLBACK');
  } catch (error) {
    await runtime.query('ROLLBACK');
    throw error;
  }

  const evidence = await administrator.query(`
    SELECT
      (SELECT count(*)::integer FROM hon.crm_appointments WHERE organization_id = $1) AS appointments,
      (SELECT count(*)::integer FROM hon.audit_events WHERE organization_id = $1 AND action_code = 'crm.trial.schedule') AS audits,
      (SELECT count(*)::integer FROM hon.outbox_events WHERE organization_id = $1 AND event_type = 'crm.trial.scheduled' AND schema_version = 1) AS outbox,
      (SELECT count(*)::integer FROM hon.class_bookings WHERE organization_id = $1) AS bookings,
      (SELECT count(*)::integer FROM hon.memberships WHERE organization_id = $1) AS memberships
  `, [ids.organization]);
  assert(evidence.rows[0]?.appointments === 2 && evidence.rows[0]?.audits === 1 && evidence.rows[0]?.outbox === 1,
    'Trial scheduling did not create exactly one appointment/audit/v1 outbox event under idempotent replay.');
  assert(evidence.rows[0]?.bookings === 0 && evidence.rows[0]?.memberships === 0,
    'Trial scheduling mutated booking or membership data.');

  console.log('Verified CRM trial appointment permission scope, forced RLS, exact grants, lead isolation, strict bounded dates, human-UI boundary, idempotent replay, composite storage integrity, atomic audit/outbox, and no booking or membership mutation.');
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
