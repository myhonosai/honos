/**
 * Recurring weekly classes proof (B-SCH-1, 0239) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guards
 * + global ValidationPipe + HonExceptionFilter -> ClassSeriesController -> protected definer functions on the restricted
 * runtime role with forced RLS), on the guarded disposable CRM-close fixture only. Synthetic names only; no automation runs.
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
const { issueSession, HON_SESSION_COOKIE } = await import(pathToFileURL(apiRequire.resolve('@hon/auth')).href);
const load = (path) => import(pathToFileURL(resolve(repo, 'apps/api/dist', path)).href);
const { RuntimeDatabaseService } = await load('foundation/runtime-database.service.js');
const { HonIdentityGuard } = await load('foundation/hon-identity.guard.js');
const { HonIdentityService } = await load('foundation/hon-identity.service.js');
const { HonExceptionFilter } = await load('observability/http-telemetry.js');
const { ClassSeriesController } = await load('schedule/class-series.controller.js');
const { ClassSeriesService } = await load('schedule/class-series.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-class-series', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();
const service = new ClassSeriesService(database);

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [ClassSeriesController],
    providers: [HonIdentityGuard, HonIdentityService, ClassSeriesService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}

const COMMAND = { create: 'schedule.series.create', revise: 'schedule.series.revise', end: 'schedule.series.end', fill: 'schedule.series.fill' };
function call(actor, method, path, { body, key = randomUUID(), command, headers = {}, school = actor.school, organization = actor.org } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/schedule/${path}`);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const sent = {
    Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`,
    Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json',
    ...(method === 'POST' ? { 'Content-Type': 'application/json', ...(command ? { 'X-Hon-Human-Command': command } : {}), ...(key ? { 'Idempotency-Key': key } : {}) } : {}),
    ...headers,
  };
  for (const [name, value] of Object.entries(sent)) if (value === undefined) delete sent[name];
  return new Promise((resolvePromise, reject) => {
    const request = http.request(target, { method, headers: sent }, (response) => {
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
const list = (actor, options = {}) => call(actor, 'GET', 'class-series', options);
const timetable = (actor, query = '', options = {}) => call(actor, 'GET', `timetable${query ? `?${query}` : ''}`, options);
const create = (actor, body, options = {}) => call(actor, 'POST', 'class-series', { body, command: COMMAND.create, ...options });
const revise = (actor, id, body, options = {}) => call(actor, 'POST', `class-series/${id}/revise`, { body, command: COMMAND.revise, ...options });
const end = (actor, id, body, options = {}) => call(actor, 'POST', `class-series/${id}/end`, { body, command: COMMAND.end, ...options });
const fill = (actor, id, body, options = {}) => call(actor, 'POST', `class-series/${id}/fill`, { body, command: COMMAND.fill, ...options });

async function success(read, label) {
  const { status, body, headers } = await read();
  assert.equal(status, 200, `${label}: expected 200, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  ok(headers['cache-control'] === 'private, no-store', `${label}: never cached`);
  return body;
}
async function refused(read, expectedStatus, expectedCode, label) {
  const { status, body } = await read();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  if (expectedCode) assert.equal(body.code, expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(body).slice(0, 400)}`);
  ok(!('data' in body), `${label}: a refusal returns no data`);
}
async function rejectsSql(run, pattern, label) {
  await sql('SAVEPOINT expected_failure');
  try { await run(); } catch (error) { await sql('ROLLBACK TO SAVEPOINT expected_failure'); ok(pattern.test(error.message), `${label}: ${error.message}`); return; }
  await sql('ROLLBACK TO SAVEPOINT expected_failure');
  assert.fail(`${label}: expected a refusal`);
}

// Disposable-fixture cleanup only (as in the 0224 and 0240 proofs).
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
    const left = (await sql('SELECT count(*)::int n FROM hon.class_sessions WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]])).rows[0].n;
    if (left) throw new Error('fixture cleanup left class sessions behind');
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`series-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`series-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`series-${ids.organization}-%`]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

const allPermissions = (await sql('SELECT code FROM hon.permissions ORDER BY code')).rows.map((row) => row.code);
async function role(org, permissions, code) {
  const id = randomUUID();
  await sql('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)', [id, org, code ?? `STAFF_${id.slice(0, 8)}`]);
  for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [id, org, permission]);
  return id;
}
async function staff(label, roles, { org = ids.organization, school = ids.schoolA } = {}) {
  const user = randomUUID(), principal = randomUUID(), subject = `series-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Series Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Series Staff')", [principal, user]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  const context = (patch = {}) => { const requestId = randomUUID(); return { organizationId: org, schoolId: school, principalId: principal, principalType: 'HUMAN_USER', source: 'HUMAN_UI',
    externalSubject: subject, requestId, correlationId: requestId, idempotencyKey: randomUUID(), ...patch }; };
  return { subject, principal, grants, org, school, context, read: (patch = {}) => context({ idempotencyKey: '', ...patch }) };
}
let OWN, MANAGER, READER, NONE, MIXED, OTHER_SCHOOL, today;
const programs = {};
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const isoDay = (date) => { const d = new Date(`${date}T00:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; };
const datesBetween = (from, to, weekdays) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) if (weekdays.includes(isoDay(d))) out.push(d); return out; };

async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Series Org','Series Org'),($2,'Series Other Org','Series Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Series ${slug}`, `series-${slug}-${school.slice(0, 8)}`, LA]);
    programs[slug] = randomUUID();
    await sql("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Adult Karate','SCHEDULED')", [programs[slug], org, school]);
  }
  today = (await sql('SELECT (clock_timestamp() AT TIME ZONE $1)::date::text d', [LA])).rows[0].d;
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  MANAGER = await staff('manager', [await role(ids.organization, ['schedule.session.manage'])]);
  READER = await staff('reader', [await role(ids.organization, ['schedule.session.read'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read', 'crm.lead.read', 'attendance.record', 'program.manage'])]);
  MIXED = await staff('mixed', [await role(ids.organization, ['schedule.session.manage']), await role(ids.organization, ['people.read'], 'PARENT_PORTAL')]);
  OTHER_SCHOOL = await staff('other-school', [await role(ids.organization, allPermissions)], { school: ids.schoolB });
}
const sessionsOf = async (seriesId) => (await sql(`SELECT o.local_date::text local_date, s.id, s.status::text status, s.name, s.capacity, s.cancellation_reason,
  to_char(s.starts_at AT TIME ZONE $2,'HH24:MI') local_start, to_char(s.ends_at AT TIME ZONE $2,'HH24:MI') local_end, (s.starts_at AT TIME ZONE $2)::date::text starts_local_date
  FROM hon.class_series_occurrences o JOIN hon.class_sessions s ON s.id=o.class_session_id WHERE o.series_id=$1 ORDER BY o.local_date`, [seriesId, LA])).rows;
const untouched = async () => (await sql(`SELECT md5(string_agg(s::text,'|' ORDER BY s.id)) h, count(*)::int n FROM hon.class_sessions s
  WHERE NOT EXISTS(SELECT 1 FROM hon.class_series_occurrences o WHERE o.class_session_id=s.id)`)).rows[0];

try {
  await cleanup();
  await seed();
  await startApp();
  // A one-off session created outside any series must never be touched by series commands.
  const oneOff = randomUUID();
  await sql(`INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy)
    VALUES($1,$2,$3,$4,'One-off seminar',clock_timestamp()+interval '3 days',clock_timestamp()+interval '3 days 1 hour',20,'WALK_IN')`, [oneOff, ids.organization, ids.schoolA, programs.a]);
  const before = await untouched();

  // 1. Reads: the series list needs session manage; the timetable needs session read.
  const empty = await success(() => list(MANAGER), 'series list by a manager');
  ok(empty.data.series.length === 0 && empty.data.localToday === today && empty.data.timezone === LA && empty.data.fillLimit === addDays(today, 84)
    && empty.data.programs.length === 1 && empty.data.programs[0].programId === programs.a, 'empty list with the school clock, fill limit and its own program only');
  for (const actor of [READER, NONE, MIXED]) await refused(() => list(actor), 403, undefined, `series list refused for ${actor.subject.split('-').pop()}`);
  await refused(() => list(OTHER_SCHOOL, { school: ids.schoolA }), 403, undefined, 'school-B staff at the school-A route');
  await refused(() => list(MANAGER, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'read with an idempotency key');
  await refused(() => call(MANAGER, 'GET', 'class-series?x=1'), 400, 'VALIDATION_FAILED', 'list with a query');
  for (const actor of [NONE, MIXED]) await refused(() => timetable(actor), 403, undefined, `timetable refused for ${actor.subject.split('-').pop()}`);

  // 2. Create: closed validation, own-school program only, no session yet, exact replay.
  const start = addDays(today, 1);
  const good = { programId: programs.a, name: 'Adult Karate', roomName: 'Main mat', capacity: 24, bookingPolicy: 'OPTIONAL_BOOKING', weekdays: [3, 1],
    localStartTime: '18:00', durationMinutes: 60, startsOn: start };
  for (const actor of [READER, NONE, MIXED]) await refused(() => create(actor, good), 403, undefined, `create refused for ${actor.subject.split('-').pop()}`);
  for (const [label, patch] of [['weekday zero', { weekdays: [0] }], ['weekday eight', { weekdays: [8] }], ['repeated weekday', { weekdays: [1, 1] }], ['no weekday', { weekdays: [] }],
    ['hour 24', { localStartTime: '24:00' }], ['seconds', { localStartTime: '18:00:30' }], ['too short', { durationMinutes: 4 }], ['too long', { durationMinutes: 601 }],
    ['zero capacity', { capacity: 0 }], ['unknown policy', { bookingPolicy: 'MAYBE' }], ['padded name', { name: ' Karate' }], ['extra key', { automation: true }],
    ['impossible date', { startsOn: '2026-02-30' }], ['last date first', { endsOn: addDays(start, -1) }], ['started long ago', { startsOn: addDays(today, -8) }]]) {
    await refused(() => create(MANAGER, { ...good, ...patch }), 400, undefined, `create validation: ${label}`);
  }
  await refused(() => create(MANAGER, { ...good, programId: programs.b }), 404, 'PROGRAM_NOT_FOUND', 'a school-B program through school A');
  await refused(() => create(MANAGER, { ...good, programId: programs.o }), 404, 'PROGRAM_NOT_FOUND', 'another organization program');
  const createKey = randomUUID();
  const made = await success(() => create(MANAGER, good, { key: createKey }), 'create the series');
  const S = made.data.series;
  ok(made.meta.replayed === false && S.version === 1 && S.status === 'ACTIVE' && JSON.stringify(S.weekdays) === '[1,3]' && S.localStartTime === '18:00'
    && S.startsOn === start && S.endsOn === null && S.generatedThrough === null && S.futureSessions === 0 && made.data.sessions.created === 0, 'series v1, sorted weekdays, no session yet');
  const replay = await success(() => create(MANAGER, good, { key: createKey }), 'create replay');
  ok(replay.meta.replayed === true && JSON.stringify(replay.data) === JSON.stringify(made.data), 'exact replay');
  await refused(() => create(MANAGER, { ...good, capacity: 25 }, { key: createKey }), 409, 'IDEMPOTENCY_KEY_REUSED', 'key reused for another body');
  ok((await sql('SELECT count(*)::int n FROM hon.class_series WHERE school_id=$1', [ids.schoolA])).rows[0].n === 1, 'one series after the replay');
  const audit = (await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='schedule.series.create' AND source='HUMAN_UI'", [S.seriesId])).rows[0].n;
  const outbox = (await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='schedule.series.created'", [S.seriesId])).rows[0].n;
  ok(audit === 1 && outbox === 1, 'one audit event and one inert outbox event');

  // 3. Fill: only by a staff command, at most 84 days ahead, one session per series date, safe to repeat.
  await refused(() => fill(MANAGER, S.seriesId, { expectedVersion: 1, throughDate: addDays(today, 85) }), 422, 'CLASS_SERIES_FILL_TOO_FAR', 'fill past 12 weeks');
  await refused(() => fill(MANAGER, S.seriesId, { expectedVersion: 1, throughDate: addDays(today, -1) }), 422, 'CLASS_SERIES_FILL_TOO_FAR', 'fill into the past');
  await refused(() => fill(MANAGER, S.seriesId, { expectedVersion: 2, throughDate: addDays(today, 28) }), 409, 'VERSION_CONFLICT', 'fill at a stale version');
  await refused(() => fill(READER, S.seriesId, { expectedVersion: 1, throughDate: addDays(today, 28) }), 403, undefined, 'fill refused for a reader');
  await refused(() => fill(OTHER_SCHOOL, S.seriesId, { expectedVersion: 1, throughDate: addDays(today, 28) }), 404, 'CLASS_SERIES_NOT_FOUND', 'a school-A series from school B');
  const through = addDays(today, 28), expected = datesBetween(start, through, [1, 3]);
  const fillKey = randomUUID();
  const filled = await success(() => fill(MANAGER, S.seriesId, { expectedVersion: 1, throughDate: through }, { key: fillKey }), 'fill four weeks');
  ok(filled.data.sessions.created === expected.length && filled.data.series.version === 2 && filled.data.series.generatedThrough === through
    && filled.data.series.futureSessions === expected.length && filled.data.sessions.skippedDates.length === 0, `fill created ${expected.length} sessions`);
  let rows = await sessionsOf(S.seriesId);
  ok(JSON.stringify(rows.map((r) => r.local_date)) === JSON.stringify(expected) && rows.every((r) => r.local_start === '18:00' && r.local_end === '19:00'
    && r.starts_local_date === r.local_date && r.status === 'SCHEDULED' && r.capacity === 24), 'each session starts 18:00 school time on its own date');
  ok((await success(() => fill(MANAGER, S.seriesId, { expectedVersion: 1, throughDate: through }, { key: fillKey }), 'fill replay')).meta.replayed === true, 'fill replay');
  const again = await success(() => fill(MANAGER, S.seriesId, { expectedVersion: 2, throughDate: through }), 'fill the same range again');
  ok(again.data.sessions.created === 0 && (await sessionsOf(S.seriesId)).length === expected.length, 'a repeated fill creates nothing');
  const twoFills = await Promise.all([1, 2].map(() => fill(MANAGER, S.seriesId, { expectedVersion: 3, throughDate: addDays(today, 42) })));
  ok(twoFills.filter((r) => r.status === 200).length === 1 && twoFills.filter((r) => r.status === 409).length === 1, 'two concurrent fills: one wins');
  const expected6 = datesBetween(start, addDays(today, 42), [1, 3]);
  ok((await sessionsOf(S.seriesId)).length === expected6.length, 'six weeks of sessions, no duplicate date');
  // A local start time that does not exist (spring-forward gap) is detected by the same round-trip test the fill uses.
  ok((await sql("SELECT (((DATE '2027-03-14'+TIME '02:30') AT TIME ZONE $1) AT TIME ZONE $1)::time<>TIME '02:30' gap", [LA])).rows[0].gap, 'gap round-trip detects a skipped local time');

  // 4. Weekly timetable in school time.
  const weekOf = addDays(today, 7);
  const week = await success(() => timetable(READER, `weekOf=${weekOf}`), 'timetable by a reader');
  const weekStart = addDays(weekOf, 1 - isoDay(weekOf));
  ok(week.data.weekStart === weekStart && week.data.weekEnd === addDays(weekStart, 6) && week.data.timezone === LA && week.data.truncated === false, 'Monday-to-Sunday school week');
  const inWeek = expected6.filter((d) => d >= weekStart && d <= addDays(weekStart, 6));
  const seriesRows = week.data.sessions.filter((s) => s.seriesId === S.seriesId);
  ok(seriesRows.length === inWeek.length && seriesRows.every((s) => s.localStart === '18:00' && s.localEnd === '19:00' && s.booked === 0 && s.roomName === 'Main mat'), 'the week shows its series sessions');
  await refused(() => timetable(MANAGER, ''), 403, 'CLASS_SESSIONS_READ_FORBIDDEN', 'timetable by a manager without session read');
  await refused(() => timetable(NONE, ''), 403, 'CLASS_SESSIONS_READ_FORBIDDEN', 'timetable without session read');
  await refused(() => timetable(READER, 'weekOf=2026-13-01'), 400, undefined, 'timetable with an impossible date');
  await refused(() => timetable(READER, 'weekOf=2026-11-09&x=1'), 400, 'VALIDATION_FAILED', 'timetable with an extra query');
  ok((await success(() => timetable(OTHER_SCHOOL), 'school B timetable')).data.sessions.every((s) => s.seriesId !== S.seriesId), 'school B sees none of school A');

  // 5. A booked session is never moved: book the first Wednesday, then change the pattern to Mondays at 19:00.
  rows = await sessionsOf(S.seriesId);
  const wednesday = rows.find((r) => isoDay(r.local_date) === 3), otherWednesdays = rows.filter((r) => isoDay(r.local_date) === 3 && r.id !== wednesday.id);
  const person = randomUUID(), student = randomUUID();
  await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Robin','Series')", [person, ids.organization, ids.schoolA]);
  await sql('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)', [student, ids.organization, ids.schoolA, person]);
  await sql("INSERT INTO hon.class_bookings(organization_id,school_id,class_session_id,student_profile_id,booking_kind,status,source) VALUES($1,$2,$3,$4,'REGULAR','BOOKED','STAFF')",
    [ids.organization, ids.schoolA, wednesday.id, student]);
  const v = (await success(() => list(MANAGER), 'list before revise')).data.series[0].version;
  const revised = { expectedVersion: v, name: 'Adult Karate (evening)', roomName: 'Main mat', capacity: 20, bookingPolicy: 'REQUIRED_BOOKING', weekdays: [1],
    localStartTime: '19:00', durationMinutes: 75 };
  await refused(() => revise(MANAGER, S.seriesId, { ...revised, expectedVersion: v + 1 }), 409, 'VERSION_CONFLICT', 'revise at a stale version');
  await refused(() => revise(MANAGER, S.seriesId, { ...revised, programId: programs.a }), 400, undefined, 'revise cannot change the program');
  await refused(() => revise(MANAGER, S.seriesId, { ...revised, endsOn: addDays(today, -1) }), 400, undefined, 'revise with a past last date');
  const changed = await success(() => revise(MANAGER, S.seriesId, revised), 'revise to Mondays 19:00');
  const mondays = expected6.filter((d) => isoDay(d) === 1);
  ok(changed.data.sessions.keptBooked === 1 && changed.data.sessions.cancelled === otherWednesdays.length && changed.data.sessions.updated === mondays.length, 'booked kept, other Wednesdays cancelled, Mondays updated');
  rows = await sessionsOf(S.seriesId);
  const kept = rows.find((r) => r.id === wednesday.id);
  ok(kept.status === 'SCHEDULED' && kept.local_start === '18:00' && kept.name === 'Adult Karate' && kept.capacity === 24, 'the booked Wednesday is exactly as it was');
  ok(rows.filter((r) => otherWednesdays.some((w) => w.id === r.id)).every((r) => r.status === 'CANCELLED' && r.cancellation_reason === 'The class series changed'), 'unbooked Wednesdays cancelled with a reason');
  ok(rows.filter((r) => isoDay(r.local_date) === 1).every((r) => r.status === 'SCHEDULED' && r.local_start === '19:00' && r.local_end === '20:15' && r.name === 'Adult Karate (evening)' && r.capacity === 20),
    'Mondays now 19:00-20:15 with the new name and capacity');

  // 6. End the series after two weeks: later untouched sessions cancelled, the booked one kept, no further change.
  const v2 = changed.data.series.version, lastDate = addDays(today, 14);
  await refused(() => end(MANAGER, S.seriesId, { expectedVersion: v2, lastDate: addDays(today, -2), reason: 'Moving' }), 400, undefined, 'end long before today');
  await refused(() => end(MANAGER, S.seriesId, { expectedVersion: v2, lastDate }), 400, undefined, 'end without a reason');
  const ended = await success(() => end(MANAGER, S.seriesId, { expectedVersion: v2, lastDate, reason: 'Term ends' }), 'end the series');
  rows = await sessionsOf(S.seriesId);
  const lateMondays = rows.filter((r) => isoDay(r.local_date) === 1 && r.local_date > lastDate);
  ok(ended.data.series.status === 'ENDED' && ended.data.series.endsOn === lastDate && ended.data.series.endReason === 'Term ends' && ended.data.sessions.cancelled === lateMondays.length, 'ended with its last date');
  ok(lateMondays.every((r) => r.status === 'CANCELLED' && r.cancellation_reason === 'The class series ended')
    && rows.filter((r) => isoDay(r.local_date) === 1 && r.local_date <= lastDate).every((r) => r.status === 'SCHEDULED'), 'sessions up to the last date stay');
  ok(rows.find((r) => r.id === wednesday.id).status === 'SCHEDULED' || wednesday.local_date <= lastDate, 'the booked session is never cancelled by the end');
  const v3 = ended.data.series.version;
  await refused(() => fill(MANAGER, S.seriesId, { expectedVersion: v3, throughDate: addDays(today, 50) }), 409, 'CLASS_SERIES_ENDED', 'fill an ended series');
  await refused(() => revise(MANAGER, S.seriesId, { ...revised, expectedVersion: v3 }), 409, 'CLASS_SERIES_ENDED', 'revise an ended series');
  await refused(() => end(MANAGER, S.seriesId, { expectedVersion: v3, lastDate, reason: 'Again' }), 409, 'CLASS_SERIES_ENDED', 'end twice');

  // 7. Transport and live access.
  const second = { ...good, name: 'Kids Karate', weekdays: [2], localStartTime: '16:00' };
  await refused(() => create(MANAGER, second, { command: null }), 403, 'HUMAN_UI_REQUIRED', 'missing command header');
  await refused(() => create(MANAGER, second, { command: COMMAND.fill }), 403, 'HUMAN_UI_REQUIRED', 'another command header');
  await refused(() => create(MANAGER, second, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-site');
  await refused(() => create(MANAGER, second, { headers: { 'X-Hon-Source': 'AUTOMATION' } }), 403, 'HUMAN_UI_REQUIRED', 'source header');
  await refused(() => create(MANAGER, second, { headers: { 'X-Hon-Delegated-By-Principal-Id': OWN.principal } }), 403, 'HUMAN_UI_REQUIRED', 'delegation header');
  await refused(() => create(MANAGER, second, { key: null }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'missing idempotency key');
  await assert.rejects(service.create(MANAGER.context({ principalType: 'SERVICE' }), second), (error) => error?.response?.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(service.create(MANAGER.context({ actionRequestId: randomUUID() }), second), (error) => error?.response?.code === 'HUMAN_COMMAND_REQUIRED');
  await assert.rejects(service.create(READER.context(), second), (error) => error?.status === 403);
  checks += 3;
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=$2 WHERE id=$1', [MANAGER.grants[0], OWN.principal]);
  await refused(() => create(MANAGER, second), 403, undefined, 'create after the grant is revoked');
  await sql('UPDATE hon.principal_role_grants SET revoked_at=NULL, revoked_by_principal_id=NULL WHERE id=$1', [MANAGER.grants[0]]);
  for (const [label, off, on] of [['school suspended', "UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1", "UPDATE hon.schools SET status='ACTIVE' WHERE id=$1"],
    ['entitlement suspended', "UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=(SELECT organization_id FROM hon.schools WHERE id=$1)",
      "UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=(SELECT organization_id FROM hon.schools WHERE id=$1)"]]) {
    await sql(off, [ids.schoolA]);
    await refused(() => create(MANAGER, second), 403, undefined, `create refused: ${label}`);
    await sql(on, [ids.schoolA]);
  }
  const secondMade = await success(() => create(MANAGER, second), 'create after access is restored');
  ok(secondMade.data.series.status === 'ACTIVE', 'second series created');

  // 7b. A booking or attendance that commits while a change waits on the session lock is seen after the lock: the session is kept.
  // Bookings (0118) lock the session FOR UPDATE and insert; attendance (0115) locks it FOR SHARE and inserts. Neither updates the row.
  const K = secondMade.data.series.seriesId;
  const kFilled = await success(() => fill(MANAGER, K, { expectedVersion: 1, throughDate: addDays(today, 21) }), 'fill the second series');
  const kRows = (await sessionsOf(K)).filter((r) => r.status === 'SCHEDULED');
  ok(kRows.length >= 2, 'the second series has two upcoming Tuesdays');
  const racer = new pg.Client(targets.owner);
  await racer.connect();
  await verifyCrmCloseProofConnection(racer, CRM_CLOSE_OWNER_ROLE);
  const racerPid = (await racer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const waitingOn = async () => {
    for (let i = 0; i < 200; i += 1) {
      // The runtime's query text is not visible to the owner role; a lock the racer holds that another backend waits for is.
      const n = (await sql('SELECT count(*)::int n FROM pg_locks w WHERE NOT w.granted AND $1 = ANY(pg_blocking_pids(w.pid))', [racerPid])).rows[0].n;
      if (n > 0) return true;
      await new Promise((done) => setTimeout(done, 25));
    }
    return false;
  };
  const race = async (session, write, run, fn) => {
    await racer.query('BEGIN');
    await racer.query(`SELECT id FROM hon.class_sessions WHERE id=$1 ${write === 'booking' ? 'FOR UPDATE' : 'FOR SHARE'}`, [session.id]);
    if (write === 'booking') await racer.query("INSERT INTO hon.class_bookings(organization_id,school_id,class_session_id,student_profile_id,booking_kind,status,source) VALUES($1,$2,$3,$4,'REGULAR','BOOKED','STAFF')",
      [ids.organization, ids.schoolA, session.id, student]);
    else await racer.query(`SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),
      set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_external_subject',$4,true),set_config('app.hon_source','HUMAN_UI',true),
      set_config('app.hon_request_id',$5,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)`,
      [ids.organization, ids.schoolA, OWN.principal, OWN.subject, randomUUID()]);
    if (write !== 'booking') await racer.query("INSERT INTO hon.attendance_records(organization_id,school_id,class_session_id,student_profile_id,status,recorded_by_principal_id,note) VALUES($1,$2,$3,$4,'PRESENT',$5,'Synthetic attendance')",
      [ids.organization, ids.schoolA, session.id, student, OWN.principal]);
    const pendingCommand = run();
    const blocked = await waitingOn(fn);
    await racer.query('COMMIT');
    return { blocked, answer: await pendingCommand };
  };
  const [bookedTuesday, attendedTuesday] = kRows;
  const moved = await race(bookedTuesday, 'booking', () => revise(MANAGER, K, { expectedVersion: kFilled.data.series.version, name: second.name, roomName: second.roomName, capacity: second.capacity, bookingPolicy: second.bookingPolicy, weekdays: second.weekdays, localStartTime: '16:30', durationMinutes: second.durationMinutes }), 'revise_class_series');
  ok(moved.blocked && moved.answer.status === 200 && moved.answer.body.data.sessions.keptBooked === 1 && moved.answer.body.data.sessions.updated === kRows.length - 1, `revise waited on the booking and kept it: ${moved.blocked} ${moved.answer.status} ${JSON.stringify(moved.answer.body).slice(0, 300)}`);
  let after = (await sessionsOf(K)).find((r) => r.id === bookedTuesday.id);
  ok(after.status === 'SCHEDULED' && after.local_start === '16:00' && isoDay(after.local_date) === 2, 'the session booked during the change is exactly as it was');
  const stopped = await race(attendedTuesday, 'attendance', () => end(MANAGER, K, { expectedVersion: moved.answer.body.data.series.version, lastDate: today, reason: 'Room closed' }), 'end_class_series');
  ok(stopped.blocked && stopped.answer.status === 200 && stopped.answer.body.data.sessions.keptBooked >= 1, `end waited on the attendance and kept it: ${stopped.blocked} ${stopped.answer.status} ${JSON.stringify(stopped.answer.body).slice(0, 300)}`);
  after = (await sessionsOf(K)).find((r) => r.id === attendedTuesday.id);
  ok(after.status === 'SCHEDULED' && after.local_start === '16:30', 'the session attended during the end is not cancelled');
  await racer.end();


  // 8. Settings-free guards: no owner write can rewrite a series outside the version rule or touch an occurrence.
  await sql('BEGIN');
  await rejectsSql(() => sql("UPDATE hon.class_series SET name='x' WHERE name='Kids Karate'"), /CLASS_SERIES_IMMUTABLE/, 'series change without a version step');
  await rejectsSql(() => sql("UPDATE hon.class_series SET name='x',version=version+1 WHERE id=$1", [S.seriesId]), /CLASS_SERIES_IMMUTABLE/, 'changing an ended series');
  const otherProgram = randomUUID();
  await sql("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Weapons','SCHEDULED')", [otherProgram, ids.organization, ids.schoolA]);
  await rejectsSql(() => sql("UPDATE hon.class_series SET program_id=$1,version=version+1 WHERE name='Kids Karate'", [otherProgram]), /CLASS_SERIES_IMMUTABLE/, 'program change (identity)');
  await rejectsSql(() => sql("UPDATE hon.class_series SET starts_on=starts_on+1,version=version+1 WHERE name='Kids Karate'"), /CLASS_SERIES_IMMUTABLE/, 'first date change');
  await rejectsSql(() => sql('DELETE FROM hon.class_series WHERE id=$1', [S.seriesId]), /CLASS_SERIES_IMMUTABLE/, 'series deleted');
  await rejectsSql(() => sql('UPDATE hon.class_series_occurrences SET local_date=local_date+1 WHERE series_id=$1', [S.seriesId]), /./, 'occurrence rewritten');
  await rejectsSql(() => sql('DELETE FROM hon.class_series_occurrences WHERE series_id=$1', [S.seriesId]), /./, 'occurrence deleted');
  await rejectsSql(() => sql('TRUNCATE hon.class_series_occurrences'), /./, 'occurrences truncated');
  await rejectsSql(() => sql(`INSERT INTO hon.class_series(organization_id,school_id,program_id,name,capacity,booking_policy,weekdays,local_start_time,duration_minutes,starts_on,actor_principal_id,version)
    VALUES($1,$2,$3,'x',1,'WALK_IN','{1}','10:00',30,current_date,$4,2)`, [ids.organization, ids.schoolA, programs.a, OWN.principal]), /CLASS_SERIES_IMMUTABLE/, 'series inserted at version 2');
  await rejectsSql(() => sql(`INSERT INTO hon.class_series(organization_id,school_id,program_id,name,capacity,booking_policy,weekdays,local_start_time,duration_minutes,starts_on,actor_principal_id)
    VALUES($1,$2,$3,'x',1,'WALK_IN','{1,1}','10:00',30,current_date,$4)`, [ids.organization, ids.schoolA, programs.a, OWN.principal]), /CLASS_SERIES_IMMUTABLE/, 'repeated weekday');
  await sql('ROLLBACK');

  // 9. Nothing outside the series changed: one-off and other-school sessions.
  ok(JSON.stringify(await untouched()) === JSON.stringify(before), 'no session outside a series changed');

  // 10. Runtime ACL: EXECUTE on the six entry points only; no table privilege, no helper, no UPDATE on class sessions.
  const entry = ['create_class_series(text,jsonb,text,uuid,uuid)', 'revise_class_series(text,uuid,jsonb,text,uuid,uuid)', 'end_class_series(text,uuid,jsonb,text,uuid,uuid)',
    'fill_class_series(text,uuid,jsonb,text,uuid,uuid)', 'read_school_class_series(text)', 'read_school_weekly_timetable(text,jsonb)'];
  const helpers = ['guard_class_series()', 'require_class_series_actor(text)', 'class_series_json(hon.class_series)', 'class_series_pattern(jsonb,boolean)',
    'class_series_command_begin(text,text,text)', 'class_series_command_finish(text,text,uuid,jsonb,text,uuid,jsonb,jsonb,text,integer,uuid,uuid)', 'class_series_apply_future(hon.class_series,text)'];
  for (const fn of entry) {
    const row = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, p.prosecdef, EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(row.runtime && row.prosecdef && !row.public, `runtime may execute definer ${fn}; PUBLIC may not`);
  }
  for (const fn of helpers) {
    const row = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!row.runtime && !row.public, `helper ${fn} is private`);
  }
  for (const table of ['class_series', 'class_series_occurrences']) {
    const row = (await sql(`SELECT c.relrowsecurity AND c.relforcerowsecurity forced, has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT')
      OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_any_column_privilege($1,c.oid,'SELECT') runtime FROM pg_class c WHERE c.oid=$2::regclass`,
      [CRM_CLOSE_RUNTIME_ROLE, `hon.${table}`])).rows[0];
    ok(row.forced && !row.runtime, `${table}: forced RLS, no runtime privilege`);
  }
  ok(!(await sql("SELECT has_any_column_privilege($1,'hon.class_sessions','UPDATE') u", [CRM_CLOSE_RUNTIME_ROLE])).rows[0].u, 'runtime still has no UPDATE on class sessions');
  await assert.rejects(runtime.query('SELECT * FROM hon.class_series LIMIT 1'), /permission denied/); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const startMark = '-- Recurring class series exact verification (B-SCH-1 0239)', endMark = '-- End recurring class series exact verification.';
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: recurring class series (0239): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
