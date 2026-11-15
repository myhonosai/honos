/**
 * Parent class booking proof (0329) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guards ->
 * ParentClassBookingController -> protected definer functions on the restricted runtime role with forced RLS), on the
 * guarded disposable CRM-close fixture only. Synthetic names only; nothing is sent.
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CRM_CLOSE_OWNER_ROLE, CRM_CLOSE_RUNTIME_ROLE, crmCloseProofTargets, verifyCrmCloseProofConnection } from './crm-close-proof-target.mjs';

await import('./test-crm-close-proof-target.mjs');
const targets = crmCloseProofTargets(process.env);

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const apiRequire = createRequire(resolve(repo, 'apps/api/package.json'));
apiRequire('reflect-metadata');
const { Test } = apiRequire('@nestjs/testing');
const { ValidationPipe } = apiRequire('@nestjs/common');
const { HttpAdapterHost } = apiRequire('@nestjs/core');
const { json } = apiRequire('express');
const { issueSession, HON_SESSION_COOKIE } = await import(pathToFileURL(apiRequire.resolve('@hon/auth')).href);
const load = (path) => import(pathToFileURL(resolve(repo, 'apps/api/dist', path)).href);
const { RuntimeDatabaseService } = await load('foundation/runtime-database.service.js');
const { HonIdentityGuard } = await load('foundation/hon-identity.guard.js');
const { HonIdentityService } = await load('foundation/hon-identity.service.js');
const { HonExceptionFilter } = await load('observability/http-telemetry.js');
const { ParentClassBookingController, ParentClassBookingReadGuard, ParentClassBookingBookGuard, ParentClassBookingCancelGuard } = await load('families/parent-class-booking.controller.js');
const { ParentClassBookingService } = await load('families/parent-class-booking.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-parent-class-booking', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'school', 'otherSchool', 'family', 'otherFamily', 'program', 'otherProgram', 'curriculum']
  .map((key) => [key, randomUUID()]));
const PREFIX = `pcbook-${ids.organization}`;
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [ParentClassBookingController],
    providers: [HonIdentityGuard, HonIdentityService, ParentClassBookingService, ParentClassBookingReadGuard, ParentClassBookingBookGuard, ParentClassBookingCancelGuard,
      { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false, bodyParser: false });
  app.use(json({ limit: '2mb', strict: true }));
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}
function send(target, method, headers, payload) {
  return new Promise((resolvePromise, reject) => {
    const request = http.request(target, { method, headers }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => { try { resolvePromise({ status: response.statusCode, headers: response.headers, body: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}
const COMMAND = { book: 'parent.class_booking.book', cancel: 'parent.class_booking.cancel' };
function call(actor, method, path, { body, key = randomUUID(), command, headers = {} } = {}) {
  const target = new URL(`${origin}/v1/parent/class-bookings${path}`);
  const sent = {
    Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`,
    Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json',
    ...(method === 'POST' ? { 'Content-Type': 'application/json', ...(command ? { 'X-Hon-Human-Command': command } : {}), ...(key ? { 'Idempotency-Key': key } : {}) } : {}),
    ...headers,
  };
  for (const [name, value] of Object.entries(sent)) if (value === undefined) delete sent[name];
  return send(target, method, sent, body === undefined ? undefined : JSON.stringify(body));
}
const choices = (actor, options = {}) => call(actor, 'GET', '', options);
const book = (actor, body, options = {}) => call(actor, 'POST', '', { body, command: COMMAND.book, ...options });
const cancel = (actor, bookingId, body, options = {}) => call(actor, 'POST', `/${bookingId}/cancel`, { body, command: COMMAND.cancel, ...options });

async function success(read, label, expectedStatus = 200) {
  const { status, body, headers } = await read();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  ok(/no-store/.test(headers['cache-control'] ?? ''), `${label}: never cached`);
  return body;
}
async function refused(read, expectedStatus, expectedCode, label) {
  const { status, body } = await read();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  if (expectedCode) assert.equal(body.code, expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(body).slice(0, 400)}`);
  ok(!('data' in body), `${label}: a refusal returns no data`);
}

// Disposable-fixture cleanup only (as in the 0239 and 0286 proofs).
async function cleanup() {
  const tables = (await sql(`SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
    WHERE c.relnamespace='hon'::regnamespace AND c.relkind='r' ORDER BY 1`)).rows.map((row) => row.relname);
  await sql('BEGIN');
  try {
    for (let pass = 0; pass < 8; pass += 1) {
      let failed = 0;
      for (const table of tables) {
        await sql('SAVEPOINT cleanup_table');
        try {
          await sql(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);
          await sql(`DELETE FROM hon.${table} WHERE organization_id = ANY($1::uuid[])`, [[ids.organization, ids.otherOrganization]]);
          await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);
          await sql('RELEASE SAVEPOINT cleanup_table');
        } catch { failed += 1; await sql('ROLLBACK TO SAVEPOINT cleanup_table'); }
      }
      if (!failed) break;
    }
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

async function person(label) {
  const user = randomUUID(), principal = randomUUID(), subject = `${PREFIX}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Parent')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Parent')", [principal, user]);
  return { subject, principal };
}
async function grant(actor, family, level, { school = ids.school, org = ids.organization } = {}) {
  const id = randomUUID();
  await sql("INSERT INTO hon.family_access_grants(id,organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()-interval '1 day',$5)",
    [id, org, school, family, actor.principal, level]);
  return id;
}
async function child(given, family, { status = 'ACTIVE', enroll = ids.program, school = ids.school, org = ids.organization } = {}) {
  const personId = randomUUID(), profile = randomUUID();
  await sql('INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4,$5)', [personId, org, school, given, 'Kim']);
  await sql("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,'STUDENT')", [org, school, family, personId]);
  await sql('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id,primary_family_id,status) VALUES($1,$2,$3,$4,$5,$6)', [profile, org, school, personId, family, status]);
  if (enroll) await sql('INSERT INTO hon.student_curriculum_enrollments(organization_id,school_id,student_profile_id,curriculum_id,program_id) VALUES($1,$2,$3,$4,$5)', [org, school, profile, ids.curriculum, enroll]);
  return profile;
}
async function classSession(name, { inHours = 48, capacity = 2, policy = 'REQUIRED_BOOKING', program = ids.program, status = 'SCHEDULED', school = ids.school, org = ids.organization } = {}) {
  const id = randomUUID();
  await sql(`INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,room_name,starts_at,ends_at,capacity,booking_policy,status,cancellation_reason)
    VALUES($1,$2,$3,$4,$5,'Mat 1',date_trunc('minute',clock_timestamp())+make_interval(hours=>$6),date_trunc('minute',clock_timestamp())+make_interval(hours=>$6)+interval '1 hour',$7,$8,$9::hon.schedule_item_status,$10)`,
    [id, org, school, program, name, inHours, capacity, policy, status, status === 'CANCELLED' ? 'Closed' : null]);
  return id;
}

let GUARDIAN, SECOND, VIEWER, OUTSIDER, TWO_FAMILIES, kid, sib, inactive, otherKid, S;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Parent Org','Parent Org'),($2,'Parent Other Org','Parent Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5),($6,$2,$7,$8,$5)',
    [ids.school, ids.organization, 'Parent Dojo', `pcbook-a-${ids.school.slice(0, 8)}`, LA, ids.otherSchool, 'Parent Dojo B', `pcbook-b-${ids.otherSchool.slice(0, 8)}`]);
  await sql("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'Kim Family'),($4,$2,$3,'Other Family')", [ids.family, ids.organization, ids.school, ids.otherFamily]);
  await sql("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Kids Karate','SCHEDULED'),($4,$2,$3,'Weapons','SCHEDULED')", [ids.program, ids.organization, ids.school, ids.otherProgram]);
  await sql("INSERT INTO hon.curricula(id,organization_id,school_id,name,model_code) VALUES($1,$2,$3,'Kids curriculum','LINEAR')", [ids.curriculum, ids.organization, ids.school]);
  GUARDIAN = await person('guardian'); SECOND = await person('second'); VIEWER = await person('viewer'); OUTSIDER = await person('outsider'); TWO_FAMILIES = await person('two');
  await grant(GUARDIAN, ids.family, 'PRIMARY_GUARDIAN'); await grant(SECOND, ids.family, 'SECONDARY_GUARDIAN'); await grant(VIEWER, ids.family, 'VIEWER');
  await grant(TWO_FAMILIES, ids.family, 'PRIMARY_GUARDIAN'); await grant(TWO_FAMILIES, ids.otherFamily, 'PRIMARY_GUARDIAN');
  kid = await child('Min-jun', ids.family); sib = await child('Ara', ids.family); inactive = await child('Past', ids.family, { status: 'SUSPENDED' });
  otherKid = await child('Other', ids.otherFamily);
  S = {
    open: await classSession('Kids Karate Tue', { inHours: 30, capacity: 2 }),
    optional: await classSession('Kids Karate Open Mat', { inHours: 50, policy: 'OPTIONAL_BOOKING' }),
    tiny: await classSession('Kids Karate Small', { inHours: 70, capacity: 1 }),
    walkIn: await classSession('Walk-in', { policy: 'WALK_IN' }),
    weapons: await classSession('Weapons', { program: ids.otherProgram }),
    past: await classSession('Earlier', { inHours: -3 }),
    far: await classSession('Far away', { inHours: 24 * 15 }),
    cancelled: await classSession('Cancelled', { status: 'CANCELLED' }),
  };
  // A session of the same program at another school of the organization is never offered.
  await sql("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Kids Karate','SCHEDULED')", [randomUUID(), ids.organization, ids.otherSchool]);
}

try {
  await cleanup();
  await seed();
  await startApp();

  // 1. Choices: the family's ACTIVE children, bookable sessions of their enrolled programs in the next 14 days, open spots only.
  const first = (await success(() => choices(GUARDIAN), 'choices by a guardian')).data;
  ok(first.canBook === true && first.timezone === LA && first.horizonDays === 14, 'guardian can book; school time zone; 14-day horizon');
  ok(first.children.length === 2 && first.children.map((c) => c.studentProfileId).sort().join() === [kid, sib].sort().join(), 'both ACTIVE children, never the suspended one or another family');
  const offered = first.children[0].sessions.map((s) => s.sessionId);
  ok(offered.length === 3 && [S.open, S.optional, S.tiny].every((id) => offered.includes(id)), 'only REQUIRED/OPTIONAL booking sessions of the enrolled program, upcoming, within 14 days');
  ok(![S.walkIn, S.weapons, S.past, S.far, S.cancelled].some((id) => offered.includes(id)), 'walk-in, other program, past, far and cancelled sessions are not offered');
  ok(first.children[0].sessions.every((s) => s.booking === null && s.programName === 'Kids Karate' && s.roomName === 'Mat 1') && first.children[0].sessions.find((s) => s.sessionId === S.tiny).spotsLeft === 1, 'open spots and no bookings yet');
  ok(!JSON.stringify(first).includes('Other') && !JSON.stringify(first).includes('Past'), 'no other student is visible');
  ok((await success(() => choices(VIEWER), 'choices by a viewer')).data.canBook === false, 'a viewer reads but cannot book');
  await refused(() => choices(OUTSIDER), 403, 'PARENT_CLASS_BOOKING_FORBIDDEN', 'no family grant');
  await refused(() => choices(TWO_FAMILIES), 403, 'PARENT_CLASS_BOOKING_FORBIDDEN', 'grants for two families are ambiguous');
  await refused(() => call(GUARDIAN, 'GET', '?schoolId=x'), 400, 'PARENT_CLASS_BOOKING_SELECTORS_NOT_ACCEPTED', 'no selector is accepted');

  // 2. Book: closed body, guardian only, child of this family, offered session, exact replay.
  for (const [label, body] of [['missing session', { studentProfileId: kid }], ['extra key', { studentProfileId: kid, sessionId: S.open, schoolId: ids.school }],
    ['bad id', { studentProfileId: 'x', sessionId: S.open }], ['upper-case id', { studentProfileId: kid.toUpperCase(), sessionId: S.open }]]) {
    await refused(() => book(GUARDIAN, body), 400, 'VALIDATION_FAILED', `book validation: ${label}`);
  }
  await refused(() => book(GUARDIAN, { studentProfileId: kid, sessionId: S.open }, { key: null }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'book without a key');
  await refused(() => book(GUARDIAN, { studentProfileId: kid, sessionId: S.open }, { command: COMMAND.cancel }), 403, 'HUMAN_UI_REQUIRED', 'book under the cancel command');
  await refused(() => book(GUARDIAN, { studentProfileId: kid, sessionId: S.open }, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-site book');
  await refused(() => book(VIEWER, { studentProfileId: kid, sessionId: S.open }), 403, 'PARENT_CLASS_BOOKING_FORBIDDEN', 'a viewer cannot book');
  await refused(() => book(GUARDIAN, { studentProfileId: otherKid, sessionId: S.open }), 404, 'PARENT_CLASS_BOOKING_CHILD_NOT_FOUND', 'another family\'s child');
  await refused(() => book(GUARDIAN, { studentProfileId: inactive, sessionId: S.open }), 404, 'PARENT_CLASS_BOOKING_CHILD_NOT_FOUND', 'a suspended child');
  for (const [label, id] of [['walk-in', S.walkIn], ['other program', S.weapons], ['started', S.past], ['beyond 14 days', S.far], ['cancelled', S.cancelled], ['unknown', randomUUID()]]) {
    await refused(() => book(GUARDIAN, { studentProfileId: kid, sessionId: id }), 409, 'PARENT_CLASS_BOOKING_NOT_OFFERED', `not offered: ${label}`);
  }
  const key = randomUUID();
  const made = await success(() => book(GUARDIAN, { studentProfileId: kid, sessionId: S.open }, { key }), 'guardian books', 201);
  const B = made.data.booking;
  ok(B.status === 'BOOKED' && B.source === 'PARENT_APP' && B.version === 1 && B.canCancel === true && B.sessionId === S.open && made.data.spotsLeft === 1 && made.meta.replayed === false, 'booked from the app');
  const replay = await success(() => book(GUARDIAN, { studentProfileId: kid, sessionId: S.open }, { key }), 'book replay');
  ok(replay.meta.replayed === true && JSON.stringify(replay.data) === JSON.stringify(made.data), 'exact replay returns the same receipt');
  await refused(() => book(GUARDIAN, { studentProfileId: sib, sessionId: S.open }, { key }), 409, 'IDEMPOTENCY_KEY_REUSED', 'key reused for another body');
  await refused(() => book(SECOND, { studentProfileId: kid, sessionId: S.open }), 409, 'PARENT_CLASS_BOOKING_ALREADY_BOOKED', 'the same child twice');
  const row = (await sql('SELECT booking_kind,source,status::text FROM hon.class_bookings WHERE id=$1', [B.bookingId])).rows[0];
  ok(row.booking_kind === 'REGULAR' && row.source === 'PARENT_APP' && row.status === 'BOOKED', 'stored as a REGULAR PARENT_APP booking');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='class_booking.parent_book' AND source='HUMAN_UI' AND actor_principal_id=$2", [B.bookingId, GUARDIAN.principal])).rows[0].n === 1
    && (await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='class_booking.parent_booked' AND payload::text NOT LIKE '%Min-jun%' AND payload::text NOT LIKE '%Kim%'", [B.bookingId])).rows[0].n === 1,
    'one audit row and one inert outbox event with ids only');
  const after = (await success(() => choices(GUARDIAN), 'choices after booking')).data;
  const mine = after.children.find((c) => c.studentProfileId === kid).sessions.find((s) => s.sessionId === S.open);
  ok(mine.booking?.bookingId === B.bookingId && mine.spotsLeft === 1 && after.children.find((c) => c.studentProfileId === sib).sessions.find((s) => s.sessionId === S.open).booking === null, 'the booking shows for that child only');
  const secondBooks = await success(() => book(SECOND, { studentProfileId: sib, sessionId: S.open }), 'a second guardian books the sibling', 201);
  ok(secondBooks.data.spotsLeft === 0, 'the class is now full');

  // 3. Capacity under the session lock: two guardians race for the last spot.
  const race = await Promise.all([book(GUARDIAN, { studentProfileId: kid, sessionId: S.tiny }), book(SECOND, { studentProfileId: sib, sessionId: S.tiny })]);
  ok(race.filter((r) => r.status === 201).length === 1 && race.filter((r) => r.status === 409 && r.body.code === 'PARENT_CLASS_BOOKING_FULL').length === 1, 'one winner for the last spot, the other is told it is full');
  ok((await sql("SELECT count(*)::int n FROM hon.class_bookings WHERE class_session_id=$1 AND status IN ('BOOKED','CHECKED_IN')", [S.tiny])).rows[0].n === 1, 'capacity never passed');
  // A staff booking counts against capacity too.
  await sql("INSERT INTO hon.class_bookings(organization_id,school_id,class_session_id,student_profile_id,booking_kind,status,source) VALUES($1,$2,$3,$4,'REGULAR','BOOKED','STAFF')", [ids.organization, ids.school, S.optional, sib]);
  const staffMade = (await sql('SELECT id FROM hon.class_bookings WHERE class_session_id=$1 AND student_profile_id=$2', [S.optional, sib])).rows[0].id;

  // 4. Cancel: guardian only, own app booking, exact version, until the session starts; booking again reuses the row.
  await refused(() => cancel(VIEWER, B.bookingId, { expectedVersion: 1 }), 403, 'PARENT_CLASS_BOOKING_FORBIDDEN', 'a viewer cannot cancel');
  await refused(() => cancel(GUARDIAN, B.bookingId, { expectedVersion: 1, reason: 'x' }), 400, 'VALIDATION_FAILED', 'cancel with an extra key');
  await refused(() => cancel(GUARDIAN, 'nope', { expectedVersion: 1 }), 400, 'VALIDATION_FAILED', 'cancel with a bad id');
  await refused(() => cancel(GUARDIAN, B.bookingId, { expectedVersion: 2 }), 409, 'VERSION_CONFLICT', 'cancel at a stale version');
  await refused(() => cancel(GUARDIAN, staffMade, { expectedVersion: 1 }), 409, 'PARENT_CLASS_BOOKING_NOT_CANCELLABLE', 'a staff booking stays with staff');
  const otherBooking = randomUUID();
  await sql("INSERT INTO hon.class_bookings(id,organization_id,school_id,class_session_id,student_profile_id,booking_kind,status,source) VALUES($1,$2,$3,$4,$5,'REGULAR','BOOKED','PARENT_APP')", [otherBooking, ids.organization, ids.school, S.optional, otherKid]);
  await refused(() => cancel(GUARDIAN, otherBooking, { expectedVersion: 1 }), 404, 'PARENT_CLASS_BOOKING_NOT_FOUND', 'another family\'s booking');
  const startedBooking = randomUUID();
  await sql("INSERT INTO hon.class_bookings(id,organization_id,school_id,class_session_id,student_profile_id,booking_kind,status,source) VALUES($1,$2,$3,$4,$5,'REGULAR','BOOKED','PARENT_APP')", [startedBooking, ids.organization, ids.school, S.past, kid]);
  await refused(() => cancel(GUARDIAN, startedBooking, { expectedVersion: 1 }), 409, 'PARENT_CLASS_BOOKING_NOT_CANCELLABLE', 'a started session cannot be cancelled');
  const cancelKey = randomUUID();
  const gone = await success(() => cancel(GUARDIAN, B.bookingId, { expectedVersion: 1 }, { key: cancelKey }), 'guardian cancels');
  ok(gone.data.booking.status === 'CANCELLED' && gone.data.booking.version === 2 && gone.data.booking.canCancel === false && gone.data.spotsLeft === 1, 'cancelled and the spot is free');
  ok((await success(() => cancel(GUARDIAN, B.bookingId, { expectedVersion: 1 }, { key: cancelKey }), 'cancel replay')).meta.replayed === true, 'cancel replay');
  ok((await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='class_booking.parent_cancelled'", [B.bookingId])).rows[0].n === 1, 'one cancel event');
  const again = await success(() => book(GUARDIAN, { studentProfileId: kid, sessionId: S.open }), 'book again after cancelling', 201);
  ok(again.data.booking.bookingId === B.bookingId && again.data.booking.version === 3 && again.data.booking.status === 'BOOKED', 'booking again reuses the same row');

  // 5. Live authority: grant end, suspended school and lapsed entitlement are refused.
  await sql("UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1", [ids.school]);
  await refused(() => choices(GUARDIAN), 403, 'PARENT_CLASS_BOOKING_FORBIDDEN', 'suspended school read');
  await refused(() => book(GUARDIAN, { studentProfileId: kid, sessionId: S.optional }), 403, 'PARENT_CLASS_BOOKING_FORBIDDEN', 'suspended school book');
  await sql("UPDATE hon.schools SET status='ACTIVE' WHERE id=$1", [ids.school]);
  await sql("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp()-interval '1 minute', effective_from=clock_timestamp()-interval '2 days' WHERE organization_id=$1", [ids.organization]);
  await refused(() => book(GUARDIAN, { studentProfileId: kid, sessionId: S.optional }), 403, 'PARENT_CLASS_BOOKING_FORBIDDEN', 'lapsed entitlement');
  await sql('UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1', [ids.organization]);
  await sql("UPDATE hon.family_access_grants SET effective_until=clock_timestamp()+interval '1 second' WHERE principal_id=$1", [SECOND.principal]);
  await new Promise((r) => setTimeout(r, 1200));
  await refused(() => book(SECOND, { studentProfileId: kid, sessionId: S.optional }), 403, 'PARENT_CLASS_BOOKING_FORBIDDEN', 'an ended grant');
  const fresh = await classSession('Kids Karate Thu', { inHours: 90 });
  ok((await success(() => book(GUARDIAN, { studentProfileId: kid, sessionId: fresh }), 'book after access returns', 201)).data.booking.status === 'BOOKED', 'booking works again once access is live');

  // 6. Database boundary: definer entry points only; helpers private; the runtime has no new table privilege.
  const entry = ['read_parent_class_booking_choices(text)', 'book_parent_class_session(text,jsonb,text,uuid,uuid)', 'cancel_parent_class_booking(text,jsonb,text,uuid,uuid)'];
  const helpers = ['parent_class_booking_scope(text,boolean)', 'parent_class_booking_child_ok(uuid,uuid)', 'parent_class_booking_session_ok(uuid,hon.class_sessions)',
    'parent_class_booking_seats(uuid)', 'parent_class_booking_json(hon.class_bookings,hon.class_sessions)', 'parent_class_booking_begin(text,text,text)',
    'parent_class_booking_finish(text,text,uuid,jsonb,text,uuid,jsonb,jsonb,text,integer,uuid,uuid)'];
  for (const fn of entry) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, p.prosecdef, EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(r.runtime && r.prosecdef && !r.public, `runtime may execute definer ${fn}; PUBLIC may not`);
  }
  for (const fn of helpers) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!r.runtime && !r.public, `helper ${fn} is private`);
  }
  await assert.rejects(runtime.query("SELECT hon.book_parent_class_session($1,'{}'::jsonb,'k',gen_random_uuid(),gen_random_uuid())", [GUARDIAN.subject])); checks += 1;
  ok((await sql("SELECT count(*)::int n FROM hon.class_bookings WHERE organization_id=$1 AND source='PARENT_APP' AND booking_kind<>'REGULAR'", [ids.organization])).rows[0].n === 0, 'parents only make REGULAR bookings');
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const startMark = '-- Parent class booking exact verification (0329)', endMark = '-- End parent class booking exact verification.';
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: parent class booking (0329): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch(() => {});
  await admin.end();
  await runtime.end();
}
