/**
 * U5 class-session roster proof: the read-only roster of one exact class session of the verified school, over signed
 * HTTP (HON session cookie -> HonIdentityGuard + global ValidationPipe + HonExceptionFilter -> controller -> restricted
 * runtime role with forced RLS), on the guarded disposable CRM-close fixture only. Synthetic names.
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
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
const { issueSession, HON_SESSION_COOKIE } = await import(pathToFileURL(apiRequire.resolve('@hon/auth')).href);
const load = (path) => import(pathToFileURL(resolve(repo, 'apps/api/dist', path)).href);
const { RuntimeDatabaseService } = await load('foundation/runtime-database.service.js');
const { HonIdentityGuard } = await load('foundation/hon-identity.guard.js');
const { HonIdentityService } = await load('foundation/hon-identity.service.js');
const { HonExceptionFilter } = await load('observability/http-telemetry.js');
const { ClassSessionRosterController } = await load('schedule/class-session-roster.controller.js');
const { ClassSessionRosterService } = await load('schedule/class-session-roster.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
{ const probe = new pg.Client(targets.runtime); await probe.connect(); try { await verifyCrmCloseProofConnection(probe, CRM_CLOSE_RUNTIME_ROLE); } finally { await probe.end(); } }

const session = { mode: 'OIDC', audience: 'hon-class-session-roster', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const ids = Object.fromEntries(['organization', 'schoolA', 'schoolB', 'user', 'principal', 'role', 'readerUser', 'readerPrincipal', 'readerRole',
  'programA', 'programB', 'sessionA', 'sessionA2', 'sessionB'].map((key) => [key, randomUUID()]));
const subject = `class-roster-${randomUUID()}`, readerSubject = `class-roster-reader-${randomUUID()}`;
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;

async function startApp() {
  const database = new RuntimeDatabaseService();
  const module = await Test.createTestingModule({
    controllers: [ClassSessionRosterController],
    providers: [HonIdentityGuard, HonIdentityService, ClassSessionRosterService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}
function roster(school, sessionId, query = {}, who = subject) {
  const target = new URL(`${origin}/v1/organizations/${ids.organization}/schools/${school}/schedule/sessions/${sessionId}/roster`);
  for (const [key, value] of Object.entries(query)) if (value !== undefined) target.searchParams.set(key, String(value));
  return new Promise((resolvePromise, reject) => {
    const request = http.request(target, { method: 'GET', headers: {
      Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: who }, session)}`,
      Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json',
    } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => { try { resolvePromise({ status: response.statusCode, headers: response.headers, body: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    request.on('error', reject);
    request.end();
  });
}
async function page(read, label) {
  const { status, body, headers } = await read();
  assert.equal(status, 200, `${label}: expected 200, got ${status} ${JSON.stringify(body).slice(0, 300)}`);
  ok(headers['cache-control'] === 'private, no-store', `${label}: roster is never cached`);
  return body;
}
async function refused(read, expectedStatus, expectedCode, label) {
  const { status, body } = await read();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 300)}`);
  if (expectedCode) assert.equal(body.code, expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(body).slice(0, 300)}`);
  ok(!('data' in body), `${label}: a refusal returns no rows`);
}
async function pageAll(read, label) {
  const seen = []; let cursor; let pages = 0;
  do {
    const body = await page(() => read(cursor), `${label} page ${pages + 1}`);
    ok(body.data.length <= body.meta.limit && (!body.meta.nextCursor || body.data.length === body.meta.limit), `${label}: page size`);
    seen.push(...body.data);
    cursor = body.meta.nextCursor ?? undefined; pages += 1;
    assert.ok(pages < 300, `${label}: pagination did not terminate`);
  } while (cursor);
  return seen;
}

async function cleanup() {
  await sql('BEGIN');
  try {
    for (const table of ['outbox_events', 'audit_events', 'idempotency_records']) await sql(`DELETE FROM hon.${table} WHERE organization_id = $1`, [ids.organization]);
    // Disposable-fixture cleanup only, inside this transaction, on the guarded fixture.
    await sql('ALTER TABLE hon.attendance_records DISABLE TRIGGER USER');
    await sql('DELETE FROM hon.attendance_records WHERE organization_id = $1', [ids.organization]);
    await sql('ALTER TABLE hon.attendance_records ENABLE TRIGGER USER');
    await sql('ALTER TABLE hon.class_bookings DISABLE TRIGGER USER');
    await sql('DELETE FROM hon.class_bookings WHERE organization_id = $1', [ids.organization]);
    await sql('ALTER TABLE hon.class_bookings ENABLE TRIGGER USER');
    await sql('DELETE FROM hon.class_sessions WHERE organization_id = $1', [ids.organization]);
    await sql('DELETE FROM hon.programs WHERE organization_id = $1', [ids.organization]);
    await sql('DELETE FROM hon.student_profiles WHERE organization_id = $1', [ids.organization]);
    await sql('ALTER TABLE hon.saas_access_transitions DISABLE TRIGGER USER');
    await sql('DELETE FROM hon.saas_access_transitions WHERE organization_id = $1', [ids.organization]);
    await sql('ALTER TABLE hon.saas_access_transitions ENABLE TRIGGER USER');
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN ($1, $2)', [ids.principal, ids.readerPrincipal]);
    await sql('DELETE FROM hon.role_permissions WHERE role_id IN ($1, $2)', [ids.role, ids.readerRole]);
    await sql('DELETE FROM hon.roles WHERE id IN ($1, $2)', [ids.role, ids.readerRole]);
    await sql('DELETE FROM hon.principals WHERE id IN ($1, $2)', [ids.principal, ids.readerPrincipal]);
    await sql('DELETE FROM hon.users WHERE id IN ($1, $2)', [ids.user, ids.readerUser]);
    await sql('DELETE FROM hon.people WHERE organization_id = $1', [ids.organization]);
    await sql('DELETE FROM hon.schools WHERE id IN ($1, $2)', [ids.schoolA, ids.schoolB]);
    await sql('DELETE FROM hon.organization_entitlements WHERE organization_id = $1', [ids.organization]);
    await sql('DELETE FROM hon.organizations WHERE id = $1', [ids.organization]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

const expected = new Map(); // studentProfileId -> { booking, attendance }
const crossSession = new Map(); // roster students also on session A2 -> their A2 booking and attendance
async function student(school, givenName, familyName) {
  const person = randomUUID(), profile = randomUUID();
  await sql('INSERT INTO hon.people (id, organization_id, school_id, given_name, family_name) VALUES ($1, $2, $3, $4, $5)', [person, ids.organization, school, givenName, familyName]);
  await sql('INSERT INTO hon.student_profiles (id, organization_id, school_id, person_id) VALUES ($1, $2, $3, $4)', [profile, ids.organization, school, person]);
  return profile;
}
async function book(school, sessionId, profile, status = 'BOOKED') {
  const id = randomUUID();
  await sql(`INSERT INTO hon.class_bookings (id, organization_id, school_id, class_session_id, student_profile_id, booking_kind, status, source, cancelled_at)
    VALUES ($1, $2, $3, $4, $5, 'REGULAR', $6, 'STAFF', $7)`, [id, ids.organization, school, sessionId, profile, status, status === 'CANCELLED' ? new Date().toISOString() : null]);
  return id;
}
async function attend(school, sessionId, profile, bookingId, status = 'PRESENT') {
  const id = randomUUID();
  await sql(`INSERT INTO hon.attendance_records (id, organization_id, school_id, class_session_id, student_profile_id, class_booking_id, status, category, progression_credit_milli)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'REGULAR_PARTICIPANT', 1000)`, [id, ids.organization, school, sessionId, profile, bookingId, status]);
  return id;
}

// School A session A: 70 booked students (one cancelled, 25 with attendance), 6 walk-ins with attendance and no booking,
// 30 of them sharing one name so only the student profile id orders them, and 4 Korean names of 120 characters.
// Session A2 (same school) and session B (school B) hold other students who must never appear.
async function seed() {
  await sql('BEGIN');
  try {
    await sql('INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, $2, $2)', [ids.organization, 'Class Roster Test']);
    await sql("INSERT INTO hon.organization_entitlements (organization_id, tier, effective_from) VALUES ($1, 'CORE', clock_timestamp() - interval '1 day')", [ids.organization]);
    await sql(`INSERT INTO hon.schools (id, organization_id, name, slug) VALUES ($1, $2, 'Roster School A', $3), ($4, $2, 'Roster School B', $5)`,
      [ids.schoolA, ids.organization, `roster-a-${ids.schoolA.slice(0, 8)}`, ids.schoolB, `roster-b-${ids.schoolB.slice(0, 8)}`]);
    for (const [user, principal, who, name] of [[ids.user, ids.principal, subject, 'Roster Staff'], [ids.readerUser, ids.readerPrincipal, readerSubject, 'Roster Reader']]) {
      await sql('INSERT INTO hon.users (id, external_subject, email, display_name) VALUES ($1, $2, $3, $4)', [user, who, `roster-${user}@example.test`, name]);
      await sql(`INSERT INTO hon.principals (id, principal_type, user_id, display_name) VALUES ($1, 'HUMAN_USER', $2, $3)`, [principal, user, name]);
    }
    await sql(`INSERT INTO hon.roles (id, organization_id, code, name, is_system_role) VALUES ($1, $3, 'FRONT_DESK', 'Front Desk', false), ($2, $3, 'VIEWER', 'Viewer', false)`, [ids.role, ids.readerRole, ids.organization]);
    await sql(`INSERT INTO hon.role_permissions (role_id, organization_id, permission_code) VALUES ($1, $3, 'attendance.record'), ($2, $3, 'schedule.session.read'), ($2, $3, 'people.read')`, [ids.role, ids.readerRole, ids.organization]);
    await sql(`INSERT INTO hon.principal_role_grants (organization_id, school_id, principal_id, role_id, granted_by_principal_id)
      VALUES ($1, $2, $4, $5, $4), ($1, $3, $4, $5, $4), ($1, $2, $6, $7, $4)`, [ids.organization, ids.schoolA, ids.schoolB, ids.principal, ids.role, ids.readerPrincipal, ids.readerRole]);
    await sql(`INSERT INTO hon.programs (id, organization_id, school_id, name) VALUES ($1, $2, $3, 'Kids'), ($4, $2, $5, 'Kids B')`, [ids.programA, ids.organization, ids.schoolA, ids.programB, ids.schoolB]);
    await sql(`INSERT INTO hon.class_sessions (id, organization_id, school_id, program_id, name, starts_at, ends_at, capacity, booking_policy) VALUES
      ($1, $2, $3, $4, 'Little Dragons', now() + interval '1 day', now() + interval '1 day 45 minutes', 120, 'WALK_IN'),
      ($5, $2, $3, $4, 'Teens', now() + interval '2 days', now() + interval '2 days 45 minutes', 20, 'WALK_IN'),
      ($6, $2, $7, $8, 'Other school', now() + interval '1 day', now() + interval '1 day 45 minutes', 20, 'WALK_IN')`,
      [ids.sessionA, ids.organization, ids.schoolA, ids.programA, ids.sessionA2, ids.sessionB, ids.schoolB, ids.programB]);
    // Fixture seed only: the attendance credit/command triggers guard the human command path, which this read-only proof
    // does not exercise; they are re-enabled before COMMIT.
    await sql('ALTER TABLE hon.attendance_records DISABLE TRIGGER USER');
    await sql('ALTER TABLE hon.class_bookings DISABLE TRIGGER USER');
    for (let index = 0; index < 70; index += 1) {
      const korean = index >= 66;
      const profile = await student(ids.schoolA, korean ? '가'.repeat(120) : index < 30 ? 'Sam' : `Kid${String(index).padStart(2, '0')}`, korean ? `김${'나'.repeat(119 - index + 66)}` : index < 30 ? 'Same' : `Family${index % 7}`);
      const status = index === 5 ? 'CANCELLED' : 'BOOKED';
      const bookingId = await book(ids.schoolA, ids.sessionA, profile, status);
      const attendanceId = index % 3 === 0 && index !== 5 ? await attend(ids.schoolA, ids.sessionA, profile, bookingId, index % 2 ? 'LATE' : 'PRESENT') : null;
      expected.set(profile, { bookingId, bookingStatus: status, attendanceId });
    }
    for (let index = 0; index < 6; index += 1) {
      const profile = await student(ids.schoolA, `Walk${index}`, 'In');
      expected.set(profile, { bookingId: null, bookingStatus: null, attendanceId: await attend(ids.schoolA, ids.sessionA, profile, null, 'PRESENT') });
    }
    for (let index = 0; index < 5; index += 1) await book(ids.schoolA, ids.sessionA2, await student(ids.schoolA, `Teen${index}`, 'Other'));
    // Four roster students (two with and two without session A attendance) also hold a booking and attendance in session
    // A2: those must never leak into their session A row.
    for (const profile of [...expected.keys()].slice(0, 4)) {
      const bookingId = await book(ids.schoolA, ids.sessionA2, profile);
      crossSession.set(profile, { bookingId, attendanceId: await attend(ids.schoolA, ids.sessionA2, profile, bookingId, 'LATE') });
    }
    for (let index = 0; index < 5; index += 1) await book(ids.schoolB, ids.sessionB, await student(ids.schoolB, `Foreign${index}`, 'School'));
    await sql('ALTER TABLE hon.attendance_records ENABLE TRIGGER USER');
    await sql('ALTER TABLE hon.class_bookings ENABLE TRIGGER USER');
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

const tamper = (cursor, change) => {
  const [payload, signature] = cursor.split('.');
  return `${Buffer.from(JSON.stringify(change(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))), 'utf8').toString('base64url')}.${signature}`;
};

try {
  await cleanup();
  await seed();
  await startApp();

  // 1. Every roster entry exactly once in (family, given, student profile id) order at several page sizes, with the
  // booking and attendance of this session only.
  const order = (await sql(`SELECT sp.id FROM hon.student_profiles sp JOIN hon.people p ON p.id = sp.person_id
    WHERE sp.id = ANY($1::uuid[]) ORDER BY p.family_name, p.given_name, sp.id`, [[...expected.keys()]])).rows.map((row) => row.id);
  ok(order.length === 76, 'fixture roster holds 76 students');
  for (const limit of [100, 50, 9, 1]) {
    const rows = await pageAll((cursor) => roster(ids.schoolA, ids.sessionA, { limit, cursor }), `roster limit ${limit}`);
    ok(JSON.stringify(rows.map((row) => row.studentProfileId)) === JSON.stringify(order), `roster limit ${limit}: every student once, in order`);
    for (const row of rows) {
      const want = expected.get(row.studentProfileId);
      ok(Object.keys(row).sort().join(',') === 'attendance,booking,familyName,givenName,personId,studentProfileId,studentStatus', `closed row shape ${Object.keys(row)}`);
      ok((row.booking?.id ?? null) === want.bookingId && (row.booking?.status ?? null) === want.bookingStatus, `booking for ${row.studentProfileId}`);
      ok((row.attendance?.id ?? null) === want.attendanceId, `attendance for ${row.studentProfileId}`);
    }
  }
  const first = await page(() => roster(ids.schoolA, ids.sessionA), 'default roster page');
  ok(first.data.length === 50 && first.meta.limit === 50 && typeof first.meta.nextCursor === 'string' && first.meta.nextCursor.length <= 512, 'default page is 50 rows with a bounded cursor');
  ok(first.meta.session.id === ids.sessionA && first.meta.session.name === 'Little Dragons' && first.meta.session.capacity === 120, 'meta carries the exact session');
  ok(!Buffer.from(first.meta.nextCursor.split('.')[0], 'base64url').toString('utf8').match(/Same|Sam|김/), 'no names travel in a cursor');
  const cursor = first.meta.nextCursor;

  // 2. Exact session and exact school only.
  const teens = await page(() => roster(ids.schoolA, ids.sessionA2), 'session A2');
  ok(teens.data.length === 9 && teens.data.filter((row) => row.familyName === 'Other').length === 5, 'another session lists only its own students');
  for (const row of teens.data.filter((entry) => crossSession.has(entry.studentProfileId))) {
    const want = crossSession.get(row.studentProfileId);
    ok(row.booking?.id === want.bookingId && row.attendance?.id === want.attendanceId && row.attendance.status === 'LATE', `session A2 row carries its own session records for ${row.studentProfileId}`);
  }
  ok(teens.data.filter((entry) => crossSession.has(entry.studentProfileId)).length === 4, 'the four students on both sessions appear on A2 too');
  await refused(() => roster(ids.schoolA, ids.sessionB), 404, 'CLASS_SESSION_NOT_FOUND', 'school-B session read through school A');
  await refused(() => roster(ids.schoolA, randomUUID()), 404, 'CLASS_SESSION_NOT_FOUND', 'unknown session');
  await refused(() => roster(ids.schoolA, ids.sessionA2, { cursor }), 400, 'INVALID_CURSOR', 'session-A cursor on session A2');
  await refused(() => roster(ids.schoolB, ids.sessionB, { cursor }), 400, 'INVALID_CURSOR', 'school-A cursor at school B');
  await refused(() => roster(ids.schoolA, ids.sessionA, { cursor: tamper(cursor, (b) => ({ ...b, k: [order[70], b.k[1]] })) }), 400, 'INVALID_CURSOR', 'cursor retargeted to another student');
  await refused(() => roster(ids.schoolA, ids.sessionA, { cursor: `${cursor.split('.')[0]}.${randomBytes(32).toString('base64url')}` }), 400, 'INVALID_CURSOR', 'client-minted signature');
  await refused(() => roster(ids.schoolA, ids.sessionA, { limit: 0 }), 400, undefined, 'limit 0 (ValidationPipe)');
  await refused(() => roster(ids.schoolA, ids.sessionA, { other: 'x' }), 400, undefined, 'unknown query (ValidationPipe)');

  // 3. Authority: attendance.record is required; a schedule/people reader without it is refused.
  await refused(() => roster(ids.schoolA, ids.sessionA, {}, readerSubject), 403, undefined, 'reader without attendance.record');
  await refused(() => roster(ids.schoolA, ids.sessionA, {}, `unknown-${randomUUID()}`), 403, undefined, 'unknown subject');

  // 4. A changed anchor refuses the stale position.
  const anchorId = first.data.at(-1).studentProfileId;
  await sql('UPDATE hon.people SET version = version + 1 WHERE id = (SELECT person_id FROM hon.student_profiles WHERE id = $1)', [anchorId]);
  await refused(() => roster(ids.schoolA, ids.sessionA, { cursor }), 400, 'INVALID_CURSOR', 'edited anchor');
  const fresh = (await page(() => roster(ids.schoolA, ids.sessionA), 'reloaded first page')).meta.nextCursor;

  // 5. Page two re-decides authority live: permission removed, school or organization suspended, entitlement suspended.
  await sql("DELETE FROM hon.role_permissions WHERE role_id = $1 AND permission_code = 'attendance.record'", [ids.role]);
  await refused(() => roster(ids.schoolA, ids.sessionA, { cursor: fresh }), 403, undefined, 'page two after attendance.record removed');
  await sql("INSERT INTO hon.role_permissions (role_id, organization_id, permission_code) VALUES ($1, $2, 'attendance.record')", [ids.role, ids.organization]);
  for (const [label, statement, id] of [['school', 'UPDATE hon.schools SET status = $2 WHERE id = $1', ids.schoolA], ['organization', 'UPDATE hon.organizations SET status = $2 WHERE id = $1', ids.organization]]) {
    await sql(statement, [id, 'SUSPENDED']);
    await refused(() => roster(ids.schoolA, ids.sessionA, { cursor: fresh }), 403, undefined, `page two after ${label} suspension`);
    await sql(statement, [id, 'ACTIVE']);
  }
  await sql("UPDATE hon.organization_entitlements SET status = 'SUSPENDED' WHERE organization_id = $1", [ids.organization]);
  await refused(() => roster(ids.schoolA, ids.sessionA, { cursor: fresh }), 403, 'ATTENDANCE_FORBIDDEN', 'page two after entitlement suspension');
  await sql("UPDATE hon.organization_entitlements SET status = 'ACTIVE' WHERE organization_id = $1", [ids.organization]);
  ok((await page(() => roster(ids.schoolA, ids.sessionA, { cursor: fresh }), 'page two restored')).data.length === 26, 'restoration restores page two');

  // 6. Read-only.
  const effects = (await sql(`SELECT (SELECT count(*) FROM hon.audit_events WHERE organization_id = $1)::int AS audit,
      (SELECT count(*) FROM hon.outbox_events WHERE organization_id = $1)::int AS outbox,
      (SELECT count(*) FROM hon.idempotency_records WHERE organization_id = $1)::int AS idempotency,
      (SELECT count(*) FROM hon.attendance_records WHERE organization_id = $1)::int AS attendance,
      (SELECT count(*) FROM hon.class_bookings WHERE organization_id = $1)::int AS bookings`, [ids.organization])).rows[0];
  ok(effects.audit === 0 && effects.outbox === 0 && effects.idempotency === 0 && effects.attendance === 34 && effects.bookings === 84, `roster reads have no effects (${JSON.stringify(effects)})`);

  console.log(`Class-session roster integrity (signed HTTP): ${checks} checks passed. 76 students (walk-ins, a cancelled booking, 30 tied names, Korean names) at 4 page sizes, exact session and school, signed cursor refusals, attendance.record required, edited anchor refused, page two refused after permission loss and school/organization/entitlement suspension, zero effects.`);
} finally {
  try { await app?.close(); } finally { try { await cleanup(); } finally { await admin.end(); } }
}
