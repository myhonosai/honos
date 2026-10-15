import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for parent schedule security fixtures.');
if (!process.env.HON_RUNTIME_DATABASE_URL) throw new Error('HON_RUNTIME_DATABASE_URL is required for parent schedule security tests.');

const connectionOptions = (connectionString) => ({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});

const { ParentFamilyScheduleController } = await import('../../../apps/api/dist/families/parent-family-schedule.controller.js');
const { ParentFamilyScheduleService } = await import('../../../apps/api/dist/families/parent-family-schedule.service.js');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');

const administrator = new Client(connectionOptions(process.env.DATABASE_URL));
const ids = Object.fromEntries(
  [
    'organization', 'school', 'parentUser', 'parentPrincipal',
    'familyA', 'familyB', 'studentPersonA', 'studentPersonB',
    'studentProfileA', 'studentProfileB', 'program', 'sessionA', 'sessionB', 'sessionCancelledA',
  ].map((key) => [key, randomUUID()]),
);
const externalSubject = `parent-schedule-${randomUUID()}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function cleanupFixtures() {
  await administrator.query('BEGIN');
  try {
    await administrator.query('DELETE FROM hon.class_bookings WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.class_sessions WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.programs WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.family_access_grants WHERE principal_id = $1', [ids.parentPrincipal]);
    await administrator.query('DELETE FROM hon.student_profiles WHERE id IN ($1, $2)', [ids.studentProfileA, ids.studentProfileB]);
    await administrator.query('DELETE FROM hon.family_members WHERE family_id IN ($1, $2)', [ids.familyA, ids.familyB]);
    await administrator.query('DELETE FROM hon.families WHERE id IN ($1, $2)', [ids.familyA, ids.familyB]);
    await administrator.query('DELETE FROM hon.principals WHERE id = $1', [ids.parentPrincipal]);
    await administrator.query('DELETE FROM hon.users WHERE id = $1', [ids.parentUser]);
    await administrator.query('DELETE FROM hon.people WHERE id IN ($1, $2)', [ids.studentPersonA, ids.studentPersonB]);
    await administrator.query('DELETE FROM hon.schools WHERE id = $1', [ids.school]);
    await administrator.query('DELETE FROM hon.organizations WHERE id = $1', [ids.organization]);
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }
}

await administrator.connect();
const database = new RuntimeDatabaseService();
const schedules = new ParentFamilyScheduleService(database);
const controller = new ParentFamilyScheduleController(database, schedules);

try {
  const from = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const familyAStartsAt = new Date(from.getTime() + 60 * 60 * 1000);
  const familyACancelledStartsAt = new Date(from.getTime() + 90 * 60 * 1000);
  const familyBStartsAt = new Date(from.getTime() + 2 * 60 * 60 * 1000);
  const to = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);

  await administrator.query('BEGIN');
  try {
    await administrator.query(
      'INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, $2, $2)',
      [ids.organization, 'Parent Schedule Security Test'],
    );
    await administrator.query(
      'INSERT INTO hon.schools (id, organization_id, name, slug) VALUES ($1, $2, $3, $4)',
      [ids.school, ids.organization, 'Parent Schedule School', `parent-schedule-${ids.school.slice(0, 8)}`],
    );
    await administrator.query(
      'INSERT INTO hon.users (id, external_subject, email, display_name) VALUES ($1, $2, $3, $4)',
      [ids.parentUser, externalSubject, `parent-schedule-${ids.parentUser}@example.test`, 'Parent A'],
    );
    await administrator.query(
      `INSERT INTO hon.principals (id, principal_type, user_id, display_name)
       VALUES ($1, 'HUMAN_USER', $2, 'Parent A')`,
      [ids.parentPrincipal, ids.parentUser],
    );
    await administrator.query(
      `INSERT INTO hon.families (id, organization_id, school_id, display_name)
       VALUES ($1, $2, $3, 'Family A'), ($4, $2, $3, 'Family B')`,
      [ids.familyA, ids.organization, ids.school, ids.familyB],
    );
    await administrator.query(
      `INSERT INTO hon.people (id, organization_id, school_id, given_name, family_name)
       VALUES ($1, $2, $3, 'Avery', 'Allowed'), ($4, $2, $3, 'Bailey', 'Denied')`,
      [ids.studentPersonA, ids.organization, ids.school, ids.studentPersonB],
    );
    await administrator.query(
      `INSERT INTO hon.family_members (organization_id, school_id, family_id, person_id, member_role)
       VALUES ($1, $2, $3, $4, 'STUDENT'), ($1, $2, $5, $6, 'STUDENT')`,
      [ids.organization, ids.school, ids.familyA, ids.studentPersonA, ids.familyB, ids.studentPersonB],
    );
    await administrator.query(
      `INSERT INTO hon.student_profiles (id, organization_id, school_id, person_id, primary_family_id)
       VALUES ($1, $2, $3, $4, $5), ($6, $2, $3, $7, $8)`,
      [ids.studentProfileA, ids.organization, ids.school, ids.studentPersonA, ids.familyA, ids.studentProfileB, ids.studentPersonB, ids.familyB],
    );
    await administrator.query(
      `INSERT INTO hon.family_access_grants (
         organization_id, school_id, family_id, principal_id, access_level, granted_by_principal_id
       ) VALUES ($1, $2, $3, $4, 'PRIMARY_GUARDIAN', $4)`,
      [ids.organization, ids.school, ids.familyA, ids.parentPrincipal],
    );
    await administrator.query(
      `INSERT INTO hon.programs (id, organization_id, school_id, name, status)
       VALUES ($1, $2, $3, 'Parent Schedule Program', 'SCHEDULED')`,
      [ids.program, ids.organization, ids.school],
    );
    await administrator.query(
      `INSERT INTO hon.class_sessions (
         id, organization_id, school_id, program_id, name, room_name, starts_at, ends_at,
         capacity, booking_policy, status, cancellation_reason
       ) VALUES
         ($1, $2, $3, $4, 'Allowed session', 'Room A', $5, $6, 12, 'OPTIONAL_BOOKING', 'SCHEDULED', NULL),
         ($7, $2, $3, $4, 'Allowed cancelled session', 'Room A', $8, $9, 12, 'OPTIONAL_BOOKING', 'CANCELLED', 'Weather'),
         ($10, $2, $3, $4, 'Other family cancelled session', 'Room B', $11, $12, 12, 'OPTIONAL_BOOKING', 'CANCELLED', 'Weather')`,
      [
        ids.sessionA, ids.organization, ids.school, ids.program,
        familyAStartsAt.toISOString(), new Date(familyAStartsAt.getTime() + 60 * 60 * 1000).toISOString(),
        ids.sessionCancelledA, familyACancelledStartsAt.toISOString(), new Date(familyACancelledStartsAt.getTime() + 60 * 60 * 1000).toISOString(),
        ids.sessionB, familyBStartsAt.toISOString(), new Date(familyBStartsAt.getTime() + 60 * 60 * 1000).toISOString(),
      ],
    );
    await administrator.query(
      `INSERT INTO hon.class_bookings (
         organization_id, school_id, class_session_id, student_profile_id, booking_kind, status, source, cancelled_at
       ) VALUES
         ($1, $2, $3, $4, 'REGULAR', 'BOOKED', 'STAFF', NULL),
         ($1, $2, $5, $4, 'MAKEUP', 'CANCELLED', 'STAFF', now()),
         ($1, $2, $6, $7, 'TRIAL', 'CANCELLED', 'STAFF', now())`,
      [ids.organization, ids.school, ids.sessionA, ids.studentProfileA, ids.sessionCancelledA, ids.sessionB, ids.studentProfileB],
    );
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }

  const query = { from: from.toISOString(), to: to.toISOString() };
  const request = { honIdentity: { externalSubject } };
  const allowed = await controller.getSchedule(ids.school, ids.familyA, query, request);
  assert(Object.keys(allowed.data).length === 1 && Array.isArray(allowed.data.bookings), 'Parent schedule response exposed fields beyond bookings.');
  assert(allowed.data.bookings.length === 2, 'Authorized parent did not receive exactly its selected-family bookings.');
  const booking = allowed.data.bookings[0];
  assert(booking.student.displayName === 'Avery Allowed', 'Parent schedule returned the wrong student display name.');
  assert(booking.booking.kind === 'REGULAR' && booking.booking.status === 'BOOKED', 'Parent schedule did not preserve allowed booking status/kind.');
  assert(booking.session.name === 'Allowed session' && booking.session.status === 'SCHEDULED', 'Parent schedule did not preserve allowed session details.');
  assert(booking.program.name === 'Parent Schedule Program', 'Parent schedule did not return the selected booking program name.');
  const cancelledBooking = allowed.data.bookings.find((item) => item.session.name === 'Allowed cancelled session');
  assert(cancelledBooking?.booking.status === 'CANCELLED' && cancelledBooking.booking.kind === 'MAKEUP' && cancelledBooking.session.status === 'CANCELLED', 'Parent schedule did not return cancelled booking/session status as data.');
  assert(!JSON.stringify(allowed.data).includes('Bailey') && !JSON.stringify(allowed.data).includes('Other family cancelled'), 'Parent schedule leaked another same-school family booking.');
  assert(!('id' in booking.student) && !('capacity' in booking.session) && !('source' in booking.booking), 'Parent schedule returned prohibited identifiers or operational data.');

  let malformedRangeRejected = false;
  try {
    await controller.getSchedule(ids.school, ids.familyA, { from: '', to: '' }, request);
  } catch (error) {
    malformedRangeRejected = typeof error?.getStatus === 'function' && error.getStatus() === 400;
  }
  assert(malformedRangeRejected, 'A malformed parent schedule range was accepted.');

  let excessiveRangeRejected = false;
  try {
    await controller.getSchedule(
      ids.school,
      ids.familyA,
      { from: from.toISOString(), to: new Date(from.getTime() + 31 * 24 * 60 * 60 * 1000 + 1).toISOString() },
      request,
    );
  } catch (error) {
    excessiveRangeRejected = typeof error?.getStatus === 'function' && error.getStatus() === 400;
  }
  assert(excessiveRangeRejected, 'A parent schedule range over 31 days was accepted.');

  let crossFamilyDenied = false;
  try {
    await controller.getSchedule(ids.school, ids.familyB, query, request);
  } catch (error) {
    crossFamilyDenied = typeof error?.getStatus === 'function' && error.getStatus() === 403;
  }
  assert(crossFamilyDenied, 'A parent could query a different family’s booking in the same school.');

  console.log('Verified resolver-only parent schedule authorization, family-anchored booking projection, prohibited-field redaction, and same-school cross-family denial.');
} finally {
  try {
    await database.onModuleDestroy();
  } finally {
    try {
      await cleanupFixtures();
    } finally {
      await administrator.end();
    }
  }
}
