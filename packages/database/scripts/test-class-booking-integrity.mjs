import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for class-booking integrity tests.');
if (!process.env.HON_RUNTIME_DATABASE_URL) throw new Error('HON_RUNTIME_DATABASE_URL is required for class-booking integrity tests.');

const connectionOptions = (connectionString) => ({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});

const { ClassBookingService } = await import('../../../apps/api/dist/schedule/class-booking.service.js');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');

const administrator = new Client(connectionOptions(process.env.DATABASE_URL));
const ids = Object.fromEntries(
  [
    'organizationA', 'schoolA', 'organizationB', 'schoolB', 'principal', 'user',
    'role', 'grant',
    'person1', 'person2', 'person3', 'person4', 'personB',
    'student1', 'student2', 'student3', 'student4', 'studentB',
    'programA', 'programB', 'requiredSession', 'walkInSession', 'cancelledSession', 'sessionB',
  ].map((key) => [key, randomUUID()]),
);

function commandContext(idempotencyKey) {
  const requestId = randomUUID();
  return {
    organizationId: ids.organizationA,
    schoolId: ids.schoolA,
    principalId: ids.principal,
    externalSubject: `booking-test-${ids.user}`,
    principalType: 'HUMAN_USER',
    requestId,
    correlationId: requestId,
    idempotencyKey,
    source: 'HUMAN_UI',
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function cleanupFixtures() {
  await administrator.query('BEGIN');
  try {
    await administrator.query('DELETE FROM hon.outbox_events WHERE organization_id IN ($1, $2)', [ids.organizationA, ids.organizationB]);
    await administrator.query('DELETE FROM hon.audit_events WHERE organization_id IN ($1, $2)', [ids.organizationA, ids.organizationB]);
    await administrator.query('DELETE FROM hon.idempotency_records WHERE organization_id IN ($1, $2)', [ids.organizationA, ids.organizationB]);
    await administrator.query('DELETE FROM hon.class_bookings WHERE organization_id IN ($1, $2)', [ids.organizationA, ids.organizationB]);
    assert((await administrator.query('SELECT count(*)::integer n FROM hon.class_bookings WHERE organization_id IN ($1,$2)', [ids.organizationA,ids.organizationB])).rows[0].n === 0, 'Generic bookings were silently suppressed by a DELETE guard.');
    await administrator.query('DELETE FROM hon.class_sessions WHERE organization_id IN ($1, $2)', [ids.organizationA, ids.organizationB]);
    await administrator.query('DELETE FROM hon.programs WHERE organization_id IN ($1, $2)', [ids.organizationA, ids.organizationB]);
    await administrator.query('DELETE FROM hon.student_profiles WHERE id = ANY($1::uuid[])', [[ids.student1, ids.student2, ids.student3, ids.student4, ids.studentB]]);
    await administrator.query('DELETE FROM hon.people WHERE id = ANY($1::uuid[])', [[ids.person1, ids.person2, ids.person3, ids.person4, ids.personB]]);
    await administrator.query('DELETE FROM hon.principal_role_grants WHERE id = $1', [ids.grant]);
    await administrator.query('DELETE FROM hon.roles WHERE id = $1', [ids.role]);
    await administrator.query('DELETE FROM hon.organization_entitlements WHERE organization_id IN ($1, $2)', [ids.organizationA, ids.organizationB]);
    await administrator.query('DELETE FROM hon.principals WHERE id = $1', [ids.principal]);
    await administrator.query('DELETE FROM hon.users WHERE id = $1', [ids.user]);
    await administrator.query('DELETE FROM hon.schools WHERE id IN ($1, $2)', [ids.schoolA, ids.schoolB]);
    await administrator.query('DELETE FROM hon.organizations WHERE id IN ($1, $2)', [ids.organizationA, ids.organizationB]);
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }
}

await administrator.connect();
const database = new RuntimeDatabaseService();
const bookings = new ClassBookingService(database);
try {
  await administrator.query('BEGIN');
  try {
    await administrator.query(
      'INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, $2, $2), ($3, $4, $4)',
      [ids.organizationA, 'Booking Test A', ids.organizationB, 'Booking Test B'],
    );
    await administrator.query(
      'INSERT INTO hon.schools (id, organization_id, name, slug) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)',
      [ids.schoolA, ids.organizationA, 'Booking A', `booking-a-${ids.schoolA.slice(0, 8)}`, ids.schoolB, ids.organizationB, 'Booking B', `booking-b-${ids.schoolB.slice(0, 8)}`],
    );
    await administrator.query(
      'INSERT INTO hon.users (id, external_subject, email, display_name) VALUES ($1, $2, $3, $4)',
      [ids.user, `booking-test-${ids.user}`, `booking-${ids.user}@example.test`, 'Booking Test Staff'],
    );
    await administrator.query(
      `INSERT INTO hon.principals (id, principal_type, user_id, display_name)
       VALUES ($1, 'HUMAN_USER', $2, 'Booking Test Staff')`,
      [ids.principal, ids.user],
    );
    await administrator.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status) VALUES($1,'ESSENTIAL','ACTIVE')", [ids.organizationA]);
    await administrator.query("INSERT INTO hon.roles(id,organization_id,code,name,management_school_id) VALUES($1,$2,$1::uuid::text,'Booking staff',$3)", [ids.role,ids.organizationA,ids.schoolA]);
    await administrator.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'schedule.booking.manage')", [ids.role,ids.organizationA]);
    await administrator.query('INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,$4)', [ids.grant,ids.organizationA,ids.schoolA,ids.principal,ids.role]);
    const people = [
      [ids.person1, ids.organizationA, ids.schoolA, 'Student', 'One'],
      [ids.person2, ids.organizationA, ids.schoolA, 'Student', 'Two'],
      [ids.person3, ids.organizationA, ids.schoolA, 'Student', 'Three'],
      [ids.person4, ids.organizationA, ids.schoolA, 'Student', 'Four'],
      [ids.personB, ids.organizationB, ids.schoolB, 'Student', 'Foreign'],
    ];
    for (const [id, organizationId, schoolId, givenName, familyName] of people) {
      await administrator.query(
        'INSERT INTO hon.people (id, organization_id, school_id, given_name, family_name) VALUES ($1, $2, $3, $4, $5)',
        [id, organizationId, schoolId, givenName, familyName],
      );
    }
    const students = [
      [ids.student1, ids.organizationA, ids.schoolA, ids.person1],
      [ids.student2, ids.organizationA, ids.schoolA, ids.person2],
      [ids.student3, ids.organizationA, ids.schoolA, ids.person3],
      [ids.student4, ids.organizationA, ids.schoolA, ids.person4],
      [ids.studentB, ids.organizationB, ids.schoolB, ids.personB],
    ];
    for (const [id, organizationId, schoolId, personId] of students) {
      await administrator.query(
        'INSERT INTO hon.student_profiles (id, organization_id, school_id, person_id) VALUES ($1, $2, $3, $4)',
        [id, organizationId, schoolId, personId],
      );
    }
    await administrator.query(
      `INSERT INTO hon.programs (id, organization_id, school_id, name, status)
       VALUES ($1, $2, $3, 'Booking Program A', 'SCHEDULED'), ($4, $5, $6, 'Booking Program B', 'SCHEDULED')`,
      [ids.programA, ids.organizationA, ids.schoolA, ids.programB, ids.organizationB, ids.schoolB],
    );
    await administrator.query(
      `INSERT INTO hon.class_sessions (
         id, organization_id, school_id, program_id, name, starts_at, ends_at, capacity, booking_policy, status, cancellation_reason
       ) VALUES
         ($1, $2, $3, $4, 'Required capacity one', now() + interval '1 day', now() + interval '2 day', 1, 'REQUIRED_BOOKING', 'SCHEDULED', NULL),
         ($5, $2, $3, $4, 'Walk-in capacity one', now() + interval '3 day', now() + interval '4 day', 1, 'WALK_IN', 'SCHEDULED', NULL),
         ($6, $2, $3, $4, 'Cancelled', now() + interval '5 day', now() + interval '6 day', 1, 'OPTIONAL_BOOKING', 'CANCELLED', 'Weather'),
         ($7, $8, $9, $10, 'Foreign session', now() + interval '1 day', now() + interval '2 day', 1, 'REQUIRED_BOOKING', 'SCHEDULED', NULL)`,
      [
        ids.requiredSession, ids.organizationA, ids.schoolA, ids.programA,
        ids.walkInSession, ids.cancelledSession,
        ids.sessionB, ids.organizationB, ids.schoolB, ids.programB,
      ],
    );
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }

  const firstKey = `required-${randomUUID()}`;
  const first = await bookings.create(commandContext(firstKey), ids.requiredSession, {
    studentProfileId: ids.student1,
    bookingKind: 'REGULAR',
  });
  assert(first.created && !first.replayed, 'The first capacity-controlled booking was not created.');
  assert(first.booking.status === 'BOOKED' && first.booking.activeSeatCount === 1 && first.booking.sessionCapacity === 1, 'The first capacity-controlled booking did not preserve the expected seat metadata.');
  assert(first.booking.source === 'STAFF', 'The stored booking source was not derived as STAFF.');

  const exactReplay = await bookings.create(commandContext(firstKey), ids.requiredSession, {
    studentProfileId: ids.student1,
    bookingKind: 'REGULAR',
  });
  assert(exactReplay.replayed && !exactReplay.created && exactReplay.booking.id === first.booking.id, 'The matching idempotency request did not replay the original booking.');

  const semanticReplay = await bookings.create(commandContext(`duplicate-${randomUUID()}`), ids.requiredSession, {
    studentProfileId: ids.student1,
    bookingKind: 'REGULAR',
  });
  assert(semanticReplay.replayed && !semanticReplay.created && semanticReplay.booking.id === first.booking.id, 'A duplicate session/student command did not safely reuse the existing booking.');
  const duplicateCount = await administrator.query(
    'SELECT count(*)::integer AS count FROM hon.class_bookings WHERE class_session_id = $1 AND student_profile_id = $2',
    [ids.requiredSession, ids.student1],
  );
  assert(duplicateCount.rows[0]?.count === 1, 'More than one booking exists for one session/student pair.');

  const waitlisted = await bookings.create(commandContext(`waitlist-${randomUUID()}`), ids.requiredSession, {
    studentProfileId: ids.student2,
    bookingKind: 'TRIAL',
  });
  assert(waitlisted.created && waitlisted.booking.status === 'WAITLISTED' && waitlisted.booking.activeSeatCount === 1, 'A full REQUIRED_BOOKING session did not create a waitlist entry.');

  const walkInFirst = await bookings.create(commandContext(`walk-one-${randomUUID()}`), ids.walkInSession, {
    studentProfileId: ids.student3,
    bookingKind: 'MAKEUP',
  });
  const walkInOverflow = await bookings.create(commandContext(`walk-two-${randomUUID()}`), ids.walkInSession, {
    studentProfileId: ids.student4,
    bookingKind: 'EVENT',
  });
  assert(walkInFirst.booking.status === 'BOOKED', 'The first WALK_IN booking was not BOOKED.');
  assert(walkInOverflow.booking.status === 'BOOKED' && walkInOverflow.booking.activeSeatCount === 2 && walkInOverflow.booking.sessionCapacity === 1, 'WALK_IN overflow was not BOOKED with visible capacity metadata.');

  let cancelledRejected = false;
  try {
    await bookings.create(commandContext(`cancelled-${randomUUID()}`), ids.cancelledSession, {
      studentProfileId: ids.student1,
      bookingKind: 'REGULAR',
    });
  } catch (error) {
    cancelledRejected = typeof error?.getStatus === 'function' && error.getStatus() === 409;
  }
  assert(cancelledRejected, 'A cancelled session accepted a booking.');

  let crossScopeRejected = false;
  try {
    await bookings.create(commandContext(`cross-scope-${randomUUID()}`), ids.sessionB, {
      studentProfileId: ids.student1,
      bookingKind: 'REGULAR',
    });
  } catch (error) {
    crossScopeRejected = typeof error?.getStatus === 'function' && error.getStatus() === 404;
  }
  assert(crossScopeRejected, 'RLS allowed a class booking command to reach a foreign-school session.');

  const evidence = await administrator.query(
    `SELECT
       (SELECT count(*)::integer FROM hon.audit_events WHERE organization_id = $1 AND action_code = 'schedule.booking.create') AS audits,
       (SELECT count(*)::integer FROM hon.outbox_events WHERE organization_id = $1 AND event_type = 'class.booking.created' AND schema_version = 1) AS outbox`,
    [ids.organizationA],
  );
  assert(evidence.rows[0]?.audits === 4 && evidence.rows[0]?.outbox === 4, 'Created bookings did not atomically emit exactly one audit and v1 outbox event each.');

  console.log('Verified class booking capacity/waitlist policy, WALK_IN metadata, cancelled-session rejection, RLS cross-scope protection, idempotent duplicate suppression, and atomic audit/outbox evidence.');
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
