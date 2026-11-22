import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { testClassBookingLockVerifier } from './class-booking-lock-security.mjs';
import { CRM_CLOSE_OWNER_ROLE, CRM_CLOSE_RUNTIME_ROLE, crmCloseProofTargets, verifyCrmCloseProofConnection } from './crm-close-proof-target.mjs';

// Launch-readiness P2 "booking authority and lifecycle" (0631): the staff booking command, through the real
// ClassBookingService and hon.lock_class_booking_session, refuses every identity plane 0147 discovery refuses, and
// a COMPLETED session takes no new booking while an exact replay into it still returns the stored receipt.
const { Client } = pg;
// Guarded disposable CRM-close fixture only; synthetic names; nothing is sent, charged or called.
const targets = crmCloseProofTargets(process.env);

const { ClassBookingService } = await import('../../../apps/api/dist/schedule/class-booking.service.js');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');

const ids = Object.fromEntries([
  'organization', 'school', 'otherSchool', 'user', 'principal', 'role', 'grant', 'parentRole', 'parentGrant', 'shapedRole', 'shapedGrant',
  'family', 'familyGrant', 'hqGrant', 'person1', 'person2', 'person3', 'student1', 'student2', 'student3', 'program', 'open', 'finished', 'replayed',
].map((key) => [key, randomUUID()]));
const subject = `booking-plane-${ids.user}`;
const administrator = new Client(targets.owner);
const runtime = new Client(targets.runtime);
const database = new RuntimeDatabaseService();
const bookings = new ClassBookingService(database);
let checks = 0;
function assert(condition, message) { if (!condition) throw new Error(message); checks += 1; }

const context = (idempotencyKey = randomUUID()) => {
  const requestId = randomUUID();
  return { organizationId: ids.organization, schoolId: ids.school, principalId: ids.principal, externalSubject: subject, principalType: 'HUMAN_USER',
    requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI' };
};
const book = (sessionId, studentProfileId, key) => bookings.create(context(key), sessionId, { studentProfileId, bookingKind: 'REGULAR' });
const bookingCount = async () => (await administrator.query('SELECT count(*)::int n FROM hon.class_bookings WHERE organization_id=$1', [ids.organization])).rows[0].n;
const evidenceCount = async () => (await administrator.query("SELECT (SELECT count(*)::int FROM hon.audit_events WHERE organization_id=$1 AND action_code='schedule.booking.create')+(SELECT count(*)::int FROM hon.outbox_events WHERE organization_id=$1 AND event_type='class.booking.created') n", [ids.organization])).rows[0].n;
async function refused(label, status, code) {
  const before = await bookingCount(); const evidenceBefore = await evidenceCount();
  let error;
  try { await book(ids.open, ids.student2); } catch (caught) { error = caught; }
  assert(error && typeof error.getStatus === 'function' && error.getStatus() === status, `${label}: expected ${status}, got ${error?.getStatus?.() ?? error?.message ?? 'a booking'}`);
  if (code) assert(error.getResponse().code === code, `${label}: expected ${code}`);
  assert(await bookingCount() === before && await evidenceCount() === evidenceBefore, `${label}: a booking or its evidence was written`);
}
async function newStudent() {
  const person = randomUUID(); const student = randomUUID();
  await administrator.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Plane','Extra')", [person, ids.organization, ids.school]);
  await administrator.query('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)', [student, ids.organization, ids.school, person]);
  return student;
}
async function allowedThenUndo(label) {
  const result = await book(ids.open, await newStudent());
  assert(result.created, `${label}: a plain staff identity could not book`);
}

async function cleanup() {
  const org = [ids.organization];
  for (const sql of [
    'DELETE FROM hon.outbox_events WHERE organization_id=$1', 'DELETE FROM hon.audit_events WHERE organization_id=$1',
    'DELETE FROM hon.idempotency_records WHERE organization_id=$1', 'DELETE FROM hon.class_bookings WHERE organization_id=$1',
    'DELETE FROM hon.class_sessions WHERE organization_id=$1', 'DELETE FROM hon.programs WHERE organization_id=$1',
    'DELETE FROM hon.student_profiles WHERE organization_id=$1', 'DELETE FROM hon.people WHERE organization_id=$1',
    'DELETE FROM hon.family_access_grants WHERE organization_id=$1', 'DELETE FROM hon.families WHERE organization_id=$1',
    'DELETE FROM hon.principal_role_grants WHERE organization_id=$1', 'DELETE FROM hon.role_permissions WHERE organization_id=$1',
    'DELETE FROM hon.roles WHERE organization_id=$1', 'DELETE FROM hon.organization_entitlements WHERE organization_id=$1',
  ]) await administrator.query(sql, org);
  await administrator.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=$1', [ids.principal]);
  await administrator.query('DELETE FROM hon.principals WHERE id=$1', [ids.principal]);
  await administrator.query('DELETE FROM hon.users WHERE id=$1', [ids.user]);
  await administrator.query('DELETE FROM hon.schools WHERE organization_id=$1', org);
  await administrator.query('DELETE FROM hon.organizations WHERE id=$1', org);
}

await administrator.connect();
await verifyCrmCloseProofConnection(administrator, CRM_CLOSE_OWNER_ROLE);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);
try {
  await administrator.query('BEGIN');
  await administrator.query('INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)', [ids.organization, 'Booking Plane Org']);
  await administrator.query('INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$3,$4,$5),($2,$3,$6,$7)',
    [ids.school, ids.otherSchool, ids.organization, 'Plane A', `plane-a-${ids.school.slice(0, 8)}`, 'Plane B', `plane-b-${ids.otherSchool.slice(0, 8)}`]);
  await administrator.query('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)', [ids.user, subject, `plane-${ids.user}@example.test`, 'Plane Staff']);
  await administrator.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Plane Staff')", [ids.principal, ids.user]);
  await administrator.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status) VALUES($1,'CORE','ACTIVE')", [ids.organization]);
  await administrator.query("INSERT INTO hon.roles(id,organization_id,code,name,management_school_id) VALUES($1,$2,$3,'Plane staff',$4)", [ids.role, ids.organization, `STAFF_${ids.role.slice(0, 8)}`, ids.school]);
  await administrator.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'schedule.booking.manage')", [ids.role, ids.organization]);
  await administrator.query('INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,$4)', [ids.grant, ids.organization, ids.school, ids.principal, ids.role]);
  await administrator.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'PARENT','Parent'),($3,$2,'PARENT_HELPER','Parent helper')", [ids.parentRole, ids.organization, ids.shapedRole]);
  await administrator.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'schedule.booking.manage')", [ids.shapedRole, ids.organization]);
  await administrator.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'Plane family')", [ids.family, ids.organization, ids.school]);
  for (const [person, student, name] of [[ids.person1, ids.student1, 'One'], [ids.person2, ids.student2, 'Two'], [ids.person3, ids.student3, 'Three']]) {
    await administrator.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Plane',$4)", [person, ids.organization, ids.school, name]);
    await administrator.query('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)', [student, ids.organization, ids.school, person]);
  }
  await administrator.query("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Plane program','SCHEDULED')", [ids.program, ids.organization, ids.school]);
  await administrator.query(`INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status) VALUES
    ($1,$4,$5,$6,'Open',now()+interval '1 day',now()+interval '1 day 1 hour',5,'OPTIONAL_BOOKING','SCHEDULED'),
    ($2,$4,$5,$6,'Finished',now()+interval '2 day',now()+interval '2 day 1 hour',5,'OPTIONAL_BOOKING','SCHEDULED'),
    ($3,$4,$5,$6,'Replayed',now()+interval '3 day',now()+interval '3 day 1 hour',5,'OPTIONAL_BOOKING','SCHEDULED')`,
  [ids.open, ids.finished, ids.replayed, ids.organization, ids.school, ids.program]);
  await administrator.query("UPDATE hon.class_sessions SET status='COMPLETED' WHERE id=$1", [ids.finished]);
  await administrator.query('COMMIT');

  // Baseline: a plain staff member with schedule.booking.manage books.
  await allowedThenUndo('baseline');

  // BL2 HQ operator.
  await administrator.query("INSERT INTO hon.hq_operator_grants(id,principal_id,hq_role,granted_by_principal_id) VALUES($1,$2,'HON_HQ_SUPPORT',$2)", [ids.hqGrant, ids.principal]);
  await refused('HQ operator grant', 403);
  await administrator.query('DELETE FROM hon.hq_operator_grants WHERE id=$1', [ids.hqGrant]);

  // BL2 active family access grant; an ended one does not count.
  await administrator.query("INSERT INTO hon.family_access_grants(id,organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,'PRIMARY_GUARDIAN',$5)",
    [ids.familyGrant, ids.organization, ids.school, ids.family, ids.principal]);
  await refused('active family access grant', 403);
  await administrator.query("UPDATE hon.family_access_grants SET effective_from=now()-interval '2 day', effective_until=now()-interval '1 day' WHERE id=$1", [ids.familyGrant]);
  await allowedThenUndo('ended family access grant');

  // BL2 a family-shaped role held anywhere (here: at another school of the organization); a revoked one does not count.
  await administrator.query('INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,$4)',
    [ids.parentGrant, ids.organization, ids.otherSchool, ids.principal, ids.parentRole]);
  await refused('PARENT role at another school', 403);
  await administrator.query('UPDATE hon.principal_role_grants SET revoked_at=now(),revoked_by_principal_id=principal_id WHERE id=$1', [ids.parentGrant]);
  await allowedThenUndo('revoked PARENT role');

  // BL2 the only role carrying schedule.booking.manage is itself family-shaped.
  await administrator.query('UPDATE hon.principal_role_grants SET revoked_at=now(),revoked_by_principal_id=principal_id WHERE id=$1', [ids.grant]);
  await administrator.query('INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,$4)',
    [ids.shapedGrant, ids.organization, ids.school, ids.principal, ids.shapedRole]);
  await refused('booking permission only through a PARENT-shaped role', 403);
  await administrator.query('UPDATE hon.principal_role_grants SET revoked_at=now(),revoked_by_principal_id=principal_id WHERE id=$1', [ids.shapedGrant]);
  await administrator.query('UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=$1', [ids.grant]);
  await allowedThenUndo('staff role restored');

  // Lifecycle: a COMPLETED session refuses a new booking with nothing written.
  {
    const before = await bookingCount(); const evidenceBefore = await evidenceCount();
    let error;
    try { await book(ids.finished, ids.student1); } catch (caught) { error = caught; }
    assert(error?.getStatus?.() === 409 && error.getResponse().code === 'SESSION_COMPLETED', 'A COMPLETED session accepted a new booking');
    assert(await bookingCount() === before, 'A refused COMPLETED booking wrote a row');
    const evidence = await evidenceCount();
    assert(evidence === evidenceBefore, 'A refused booking left audit or outbox evidence');
  }
  // Historical replay: booked while SCHEDULED, then the class finishes; the exact retry returns the stored receipt.
  {
    const key = randomUUID();
    const first = await book(ids.replayed, ids.student3, key);
    assert(first.created, 'Replay fixture booking was not created');
    await administrator.query("UPDATE hon.class_sessions SET status='COMPLETED' WHERE id=$1", [ids.replayed]);
    const again = await book(ids.replayed, ids.student3, key);
    assert(again.replayed && !again.created && again.booking.id === first.booking.id, 'An exact replay into a COMPLETED session did not return the stored receipt');
    let error;
    try { await book(ids.replayed, ids.student1); } catch (caught) { error = caught; }
    assert(error?.getResponse?.().code === 'SESSION_COMPLETED', 'A new key into the now COMPLETED session was not refused');
  }

  // Canonical posture: the lock verifier (with its negative mutations) and the 0631 011 section.
  const runtimeRole = (await runtime.query('SELECT current_user AS role')).rows[0].role;
  await testClassBookingLockVerifier(administrator, runtimeRole);
  checks += 1;
  const verify = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const section = verify.split('-- Class booking lock identity plane exact verification (0631')[1]?.split('-- End class booking lock identity plane exact verification.')[0];
  assert(section, 'Missing the 0631 011 section');
  await administrator.query(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', runtimeRole));
  checks += 1;
  console.log(`Class booking identity plane (0631): ${checks} checks passed.`);
} finally {
  try { await database.onModuleDestroy(); } finally {
    try { await cleanup(); } finally { await runtime.end(); await administrator.end(); }
  }
}
