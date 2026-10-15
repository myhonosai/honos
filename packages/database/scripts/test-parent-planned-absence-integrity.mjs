import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for planned-absence integrity tests.');
if (!process.env.HON_RUNTIME_DATABASE_URL) throw new Error('HON_RUNTIME_DATABASE_URL is required for planned-absence integrity tests.');

const connectionOptions = (connectionString) => ({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});

const { ParentPlannedAbsenceController } = await import('../../../apps/api/dist/families/parent-planned-absence.controller.js');
const { ParentPlannedAbsenceService } = await import('../../../apps/api/dist/families/parent-planned-absence.service.js');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');

const administrator = new Client(connectionOptions(process.env.DATABASE_URL));
const runtime = new Client(connectionOptions(process.env.HON_RUNTIME_DATABASE_URL));
const ids = Object.fromEntries(
  [
    'organization', 'schoolA', 'schoolB', 'parentUser', 'parentPrincipal',
    'familyA', 'familyB', 'familyC',
    'studentPersonA', 'studentPersonB', 'studentPersonC',
    'studentProfileA', 'studentProfileB', 'studentProfileC', 'foreignRequest',
  ].map((key) => [key, randomUUID()]),
);
const externalSubject = `parent-planned-absence-${randomUUID()}`;

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
    studentProfileId: ids.studentProfileA,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    reason: 'Family travel',
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
    await administrator.query('DELETE FROM hon.planned_absence_requests WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.family_access_grants WHERE principal_id = $1', [ids.parentPrincipal]);
    await administrator.query('DELETE FROM hon.student_profiles WHERE id = ANY($1::uuid[])', [[ids.studentProfileA, ids.studentProfileB, ids.studentProfileC]]);
    await administrator.query('DELETE FROM hon.family_members WHERE family_id = ANY($1::uuid[])', [[ids.familyA, ids.familyB, ids.familyC]]);
    await administrator.query('DELETE FROM hon.families WHERE id = ANY($1::uuid[])', [[ids.familyA, ids.familyB, ids.familyC]]);
    await administrator.query('DELETE FROM hon.principals WHERE id = $1', [ids.parentPrincipal]);
    await administrator.query('DELETE FROM hon.users WHERE id = $1', [ids.parentUser]);
    await administrator.query('DELETE FROM hon.people WHERE id = ANY($1::uuid[])', [[ids.studentPersonA, ids.studentPersonB, ids.studentPersonC]]);
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
const plannedAbsences = new ParentPlannedAbsenceService(database);
const controller = new ParentPlannedAbsenceController(database, plannedAbsences);

try {
  const posture = await administrator.query(`
    SELECT relrowsecurity, relforcerowsecurity
    FROM pg_class
    WHERE oid = 'hon.planned_absence_requests'::regclass
  `);
  assert(posture.rows[0]?.relrowsecurity && posture.rows[0]?.relforcerowsecurity,
    'planned_absence_requests must enable and force row-level security.');

  const privileges = await runtime.query(`
    SELECT
      has_table_privilege(current_user, 'hon.planned_absence_requests', 'SELECT') AS can_select,
      has_table_privilege(current_user, 'hon.planned_absence_requests', 'INSERT') AS can_insert,
      has_table_privilege(current_user, 'hon.planned_absence_requests', 'UPDATE') AS can_update,
      has_table_privilege(current_user, 'hon.planned_absence_requests', 'DELETE') AS can_delete,
      has_type_privilege(current_user, 'hon.planned_absence_request_status', 'USAGE') AS status_type_usage
  `);
  const grants = privileges.rows[0];
  assert(grants?.can_select && grants?.can_insert && !grants?.can_update && !grants?.can_delete,
    'hon_runtime planned-absence table privileges are not the reviewed minimum.');
  assert(grants?.status_type_usage,
    'hon_runtime lacks the explicit planned-absence status enum usage grant.');

  const now = Date.now();
  const startsAt = new Date(now + 3 * 24 * 60 * 60 * 1000);
  const endsAt = new Date(now + 4 * 24 * 60 * 60 * 1000);

  await administrator.query('BEGIN');
  try {
    await administrator.query(
      'INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, $2, $2)',
      [ids.organization, 'Planned Absence Integrity Test'],
    );
    await administrator.query(
      `INSERT INTO hon.schools (id, organization_id, name, slug) VALUES
       ($1, $2, 'Planned Absence School A', $3),
       ($4, $2, 'Planned Absence School B', $5)`,
      [
        ids.schoolA, ids.organization, `planned-absence-a-${ids.schoolA.slice(0, 8)}`,
        ids.schoolB, `planned-absence-b-${ids.schoolB.slice(0, 8)}`,
      ],
    );
    await administrator.query(
      'INSERT INTO hon.users (id, external_subject, email, display_name) VALUES ($1, $2, $3, $4)',
      [ids.parentUser, externalSubject, `planned-absence-${ids.parentUser}@example.test`, 'Parent Requester'],
    );
    await administrator.query(
      `INSERT INTO hon.principals (id, principal_type, user_id, display_name)
       VALUES ($1, 'HUMAN_USER', $2, 'Parent Requester')`,
      [ids.parentPrincipal, ids.parentUser],
    );
    await administrator.query(
      `INSERT INTO hon.families (id, organization_id, school_id, display_name) VALUES
       ($1, $2, $3, 'Allowed Family'),
       ($4, $2, $3, 'Same-School Other Family'),
       ($5, $2, $6, 'Other-School Family')`,
      [ids.familyA, ids.organization, ids.schoolA, ids.familyB, ids.familyC, ids.schoolB],
    );
    await administrator.query(
      `INSERT INTO hon.people (id, organization_id, school_id, given_name, family_name) VALUES
       ($1, $2, $3, 'Avery', 'Allowed'),
       ($4, $2, $3, 'Bailey', 'Other'),
       ($5, $2, $6, 'Casey', 'Foreign')`,
      [
        ids.studentPersonA, ids.organization, ids.schoolA,
        ids.studentPersonB,
        ids.studentPersonC, ids.schoolB,
      ],
    );
    await administrator.query(
      `INSERT INTO hon.family_members (organization_id, school_id, family_id, person_id, member_role) VALUES
       ($1, $2, $3, $4, 'STUDENT'),
       ($1, $2, $5, $6, 'STUDENT'),
       ($1, $7, $8, $9, 'STUDENT')`,
      [
        ids.organization, ids.schoolA, ids.familyA, ids.studentPersonA,
        ids.familyB, ids.studentPersonB,
        ids.schoolB, ids.familyC, ids.studentPersonC,
      ],
    );
    await administrator.query(
      `INSERT INTO hon.student_profiles (id, organization_id, school_id, person_id, primary_family_id) VALUES
       ($1, $2, $3, $4, $5),
       ($6, $2, $3, $7, $8),
       ($9, $2, $10, $11, $12)`,
      [
        ids.studentProfileA, ids.organization, ids.schoolA, ids.studentPersonA, ids.familyA,
        ids.studentProfileB, ids.studentPersonB, ids.familyB,
        ids.studentProfileC, ids.schoolB, ids.studentPersonC, ids.familyC,
      ],
    );
    await administrator.query(
      `INSERT INTO hon.family_access_grants (
         organization_id, school_id, family_id, principal_id, access_level, granted_by_principal_id
       ) VALUES ($1, $2, $3, $4, 'PRIMARY_GUARDIAN', $4)`,
      [ids.organization, ids.schoolA, ids.familyA, ids.parentPrincipal],
    );
    // This foreign-school request is a fixture to prove runtime RLS does not
    // expose it under School A context; it is not a parent command fixture.
    await administrator.query(
      `INSERT INTO hon.planned_absence_requests (
         id, organization_id, school_id, family_id, student_profile_id,
         requested_by_principal_id, starts_at, ends_at, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'SUBMITTED')`,
      [
        ids.foreignRequest, ids.organization, ids.schoolB, ids.familyC, ids.studentProfileC,
        ids.parentPrincipal, startsAt.toISOString(), endsAt.toISOString(),
      ],
    );
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }

  const request = { honIdentity: { externalSubject } };
  const firstKey = `planned-absence-${randomUUID()}`;
  const firstResponse = responseCapture();
  const first = await controller.requestPlannedAbsence(
    ids.schoolA,
    ids.familyA,
    firstKey,
    inputFor(startsAt, endsAt),
    request,
    firstResponse,
  );
  assert(firstResponse.statusCode === 201 && !first.meta.replayed,
    'The first planned absence request was not created with HTTP 201.');
  assert(first.data.status === 'SUBMITTED' && first.data.studentProfileId === ids.studentProfileA,
    'The parent command did not create a submitted request for its selected student.');
  assert(!('familyId' in first.data) && !('requestedByPrincipalId' in first.data) && !('reviewedByPrincipalId' in first.data),
    'The parent command response exposed prohibited family or review metadata.');

  const replayResponse = responseCapture();
  const replay = await controller.requestPlannedAbsence(
    ids.schoolA,
    ids.familyA,
    firstKey,
    inputFor(startsAt, endsAt),
    request,
    replayResponse,
  );
  assert(replayResponse.statusCode === 200 && replay.meta.replayed && replay.data.id === first.data.id,
    'Matching planned-absence idempotency command did not replay its original response.');

  await expectStatus(409, () => controller.requestPlannedAbsence(
    ids.schoolA, ids.familyA, firstKey,
    inputFor(new Date(now + 7 * 24 * 60 * 60 * 1000), new Date(now + 8 * 24 * 60 * 60 * 1000)), request, responseCapture(),
  ), 'A reused planned-absence idempotency key accepted a different request.');

  await expectStatus(403, () => controller.requestPlannedAbsence(
    ids.schoolA, ids.familyB, `cross-family-${randomUUID()}`, inputFor(startsAt, endsAt), request, responseCapture(),
  ), 'A parent created a planned absence for another same-school family.');
  await expectStatus(404, () => controller.requestPlannedAbsence(
    ids.schoolA, ids.familyA, `wrong-student-${randomUUID()}`,
    inputFor(startsAt, endsAt, { studentProfileId: ids.studentProfileB }), request, responseCapture(),
  ), 'A parent created a planned absence for another same-school family student.');
  await expectStatus(400, () => controller.requestPlannedAbsence(
    ids.schoolA, ids.familyA, `timezone-${randomUUID()}`,
    inputFor(startsAt, endsAt, { startsAt: '2030-05-01T09:00:00' }), request, responseCapture(),
  ), 'A timezone-free planned absence timestamp was accepted.');
  await expectStatus(400, () => controller.requestPlannedAbsence(
    ids.schoolA, ids.familyA, `calendar-${randomUUID()}`,
    inputFor(startsAt, endsAt, { startsAt: '2030-02-30T09:00:00Z' }), request, responseCapture(),
  ), 'An invalid-calendar planned absence timestamp was accepted.');
  await expectStatus(400, () => controller.requestPlannedAbsence(
    ids.schoolA, ids.familyA, `ordering-${randomUUID()}`,
    inputFor(endsAt, startsAt), request, responseCapture(),
  ), 'A planned absence with a non-increasing range was accepted.');
  await expectStatus(400, () => controller.requestPlannedAbsence(
    ids.schoolA, ids.familyA, `future-window-${randomUUID()}`,
    inputFor(new Date(now + 89 * 24 * 60 * 60 * 1000), new Date(now + 91 * 24 * 60 * 60 * 1000)), request, responseCapture(),
  ), 'A planned absence outside the 90-day future window was accepted.');
  await expectStatus(400, () => controller.requestPlannedAbsence(
    ids.schoolA, ids.familyA, `reason-length-${randomUUID()}`,
    inputFor(startsAt, endsAt, { reason: 'x'.repeat(1001) }), request, responseCapture(),
  ), 'A planned absence reason longer than 1000 characters was accepted.');

  const created = await administrator.query(`
    SELECT status::text AS status, reviewed_by_principal_id, reviewed_at, review_note
    FROM hon.planned_absence_requests WHERE id = $1::uuid
  `, [first.data.id]);
  assert(created.rows[0]?.status === 'SUBMITTED'
    && created.rows[0]?.reviewed_by_principal_id === null
    && created.rows[0]?.reviewed_at === null
    && created.rows[0]?.review_note === null,
  'The parent command created review data or a non-submitted planned absence status.');

  await administrator.query('BEGIN');
  try {
    await administrator.query('SAVEPOINT initial_status');
    await expectDatabaseError('23514', () => administrator.query(
      `INSERT INTO hon.planned_absence_requests (
         organization_id, school_id, family_id, student_profile_id, requested_by_principal_id,
         starts_at, ends_at, status, reviewed_by_principal_id, reviewed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'APPROVED', $5, now())`,
      [ids.organization, ids.schoolA, ids.familyA, ids.studentProfileA, ids.parentPrincipal, startsAt.toISOString(), endsAt.toISOString()],
    ), 'A planned absence was inserted directly as approved.');
    await administrator.query('ROLLBACK TO SAVEPOINT initial_status');
    await administrator.query('SAVEPOINT cross_family_student');
    await expectDatabaseError('23514', () => administrator.query(
      `INSERT INTO hon.planned_absence_requests (
         organization_id, school_id, family_id, student_profile_id, requested_by_principal_id,
         starts_at, ends_at, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'SUBMITTED')`,
      [ids.organization, ids.schoolA, ids.familyA, ids.studentProfileB, ids.parentPrincipal, startsAt.toISOString(), endsAt.toISOString()],
    ), 'A planned absence accepted a student from another family.');
    await administrator.query('ROLLBACK TO SAVEPOINT cross_family_student');
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
    const visible = await runtime.query('SELECT id FROM hon.planned_absence_requests WHERE id = $1::uuid', [first.data.id]);
    const hidden = await runtime.query('SELECT id FROM hon.planned_absence_requests WHERE id = $1::uuid', [ids.foreignRequest]);
    assert(visible.rowCount === 1 && hidden.rowCount === 0,
      'RLS exposed a planned absence request from another school.');
    await runtime.query('ROLLBACK');
  } catch (error) {
    await runtime.query('ROLLBACK');
    throw error;
  }

  const evidence = await administrator.query(`
    SELECT
      (SELECT count(*)::integer FROM hon.audit_events WHERE organization_id = $1 AND action_code = 'parent.planned_absence.request') AS audits,
      (SELECT count(*)::integer FROM hon.outbox_events WHERE organization_id = $1 AND event_type = 'parent.planned_absence.requested' AND schema_version = 1) AS outbox,
      (SELECT count(*)::integer FROM hon.class_bookings WHERE organization_id = $1) AS bookings,
      (SELECT count(*)::integer FROM hon.attendance_records WHERE organization_id = $1) AS attendance
  `, [ids.organization]);
  assert(evidence.rows[0]?.audits === 1 && evidence.rows[0]?.outbox === 1,
    'Each created parent planned absence request did not atomically emit one audit and v1 outbox event.');
  assert(evidence.rows[0]?.bookings === 0 && evidence.rows[0]?.attendance === 0,
    'A planned-absence request mutated booking or attendance data.');

  console.log('Verified planned-absence request-only state, initial-state and family-student database integrity, forced RLS, minimum runtime grants, resolver-only parent scope, validation, idempotent replay, and atomic audit/outbox evidence.');
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
