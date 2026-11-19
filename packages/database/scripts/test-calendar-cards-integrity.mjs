/**
 * Calendar cards proof (0567) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guards + global ValidationPipe
 * + HonExceptionFilter -> CalendarCardsController / ClassSeriesController -> protected definer functions on the restricted runtime
 * role with forced RLS), on the guarded disposable CRM-close fixture only. Synthetic names only; nothing contacts anyone.
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
const { CalendarCardsController } = await load('schedule/calendar-cards.controller.js');
const { CalendarCardsService } = await load('schedule/calendar-cards.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-calendar-cards', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [ClassSeriesController, CalendarCardsController],
    providers: [HonIdentityGuard, HonIdentityService, ClassSeriesService, CalendarCardsService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}

const COMMAND = { create: 'schedule.calendar.create', move: 'schedule.calendar.move', revise: 'schedule.series.revise' };
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
const cards = (actor, from, to, options = {}) => call(actor, 'GET', `calendar/cards?from=${from}&to=${to}`, options);
const create = (actor, body, options = {}) => call(actor, 'POST', 'calendar/cards', { body, command: COMMAND.create, ...options });
const move = (actor, id, body, options = {}) => call(actor, 'POST', `calendar/cards/${id}/move`, { body, command: COMMAND.move, ...options });
const revise = (actor, id, body, options = {}) => call(actor, 'POST', `class-series/${id}/revise`, { body, command: COMMAND.revise, ...options });
const seriesList = (actor) => call(actor, 'GET', 'class-series');

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
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`cards-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`cards-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`cards-${ids.organization}-%`]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `cards-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Cards Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Cards Staff')", [principal, user]);
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
let OWN, MANAGER, READER, NONE, MIXED, OTHER_SCHOOL, PLANNER, COACH, today;
const programs = {};
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const isoDay = (date) => { const d = new Date(`${date}T00:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; };
const datesBetween = (from, to, weekdays) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) if (weekdays.includes(isoDay(d))) out.push(d); return out; };

async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Cards Org','Cards Org'),($2,'Cards Other Org','Cards Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Cards ${slug}`, `cards-${slug}-${school.slice(0, 8)}`, LA]);
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
  PLANNER = await staff('planner', [await role(ids.organization, ['schedule.session.manage', 'schedule.session.read'])]);
  COACH = await staff('coach', [await role(ids.organization, ['attendance.record'])]);
}

const at = (iso, minutes) => new Date(Date.parse(iso) + minutes * 60000).toISOString();
const sessionRow = async (id) => (await sql(`SELECT id, version, session_kind, status::text status, to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') starts_at,
  to_char(ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ends_at, to_char(starts_at AT TIME ZONE $2,'HH24:MI') local_start,
  (SELECT principal_id FROM hon.class_session_instructors i WHERE i.class_session_id=s.id AND i.assignment_role='LEAD') lead FROM hon.class_sessions s WHERE id=$1`, [id, LA])).rows[0];
const rosterSessions = async (seriesId) => (await sql(`SELECT o.local_date::text local_date, s.id, s.session_kind, s.status::text status, to_char(s.starts_at AT TIME ZONE $2,'HH24:MI') local_start,
  (SELECT principal_id FROM hon.class_session_instructors i WHERE i.class_session_id=s.id AND i.assignment_role='LEAD') lead
  FROM hon.class_series_occurrences o JOIN hon.class_sessions s ON s.id=o.class_session_id WHERE o.series_id=$1 ORDER BY o.local_date`, [seriesId, LA])).rows;

try {
  await cleanup();
  await seed();
  await startApp();

  // 1. Create one class: closed validation, own-school program and eligible instructor only, future only, exact replay.
  const day = addDays(today, 2);
  const one = { kind: 'PRIVATE_LESSON', programId: programs.a, name: 'Private lesson', capacity: 1, bookingPolicy: 'REQUIRED_BOOKING',
    instructorPrincipalId: COACH.principal, localDate: day, localStartTime: '10:00', durationMinutes: 45, roomName: 'Mat 2' };
  for (const actor of [READER, NONE, MIXED]) await refused(() => create(actor, one), 403, undefined, `create refused for ${actor.subject.split('-').pop()}`);
  await refused(() => create(OTHER_SCHOOL, one, { school: ids.schoolA }), 403, undefined, 'school-B staff at the school-A route');
  for (const [label, patch] of [['unknown kind', { kind: 'PARTY' }], ['lowercase kind', { kind: 'class' }], ['hour 24', { localStartTime: '24:00' }],
    ['too short', { durationMinutes: 4 }], ['too long', { durationMinutes: 601 }], ['zero capacity', { capacity: 0 }], ['padded name', { name: ' Lesson' }],
    ['extra key', { automation: true }], ['impossible date', { localDate: '2026-02-30' }], ['bad instructor id', { instructorPrincipalId: 'coach' }],
    ['until without repeat', { repeatUntil: addDays(day, 7) }], ['repeat missing its own weekday', { repeatWeekdays: [isoDay(day) === 7 ? 1 : isoDay(day) + 1] }],
    ['repeated weekday', { repeatWeekdays: [isoDay(day), isoDay(day)] }], ['until before the date', { repeatWeekdays: [isoDay(day)], repeatUntil: addDays(day, -1) }]]) {
    await refused(() => create(MANAGER, { ...one, ...patch }), 400, undefined, `create validation: ${label}`);
  }
  await refused(() => create(MANAGER, { ...one, programId: programs.b }), 404, 'PROGRAM_NOT_FOUND', 'a school-B program through school A');
  await refused(() => create(MANAGER, { ...one, programId: programs.o }), 404, 'PROGRAM_NOT_FOUND', 'another organization program');
  await refused(() => create(MANAGER, { ...one, instructorPrincipalId: OTHER_SCHOOL.principal }), 404, 'INSTRUCTOR_NOT_FOUND', 'an instructor of another school');
  await refused(() => create(MANAGER, { ...one, instructorPrincipalId: randomUUID() }), 404, 'INSTRUCTOR_NOT_FOUND', 'an unknown instructor');
  await refused(() => create(MANAGER, { ...one, localDate: addDays(today, -1) }), 400, 'CALENDAR_CARD_NOT_IN_FUTURE', 'a class in the past');
  await refused(() => create(MANAGER, { ...one, localDate: today, localStartTime: '00:00' }), 400, 'CALENDAR_CARD_NOT_IN_FUTURE', 'a class earlier today');
  const oneKey = randomUUID();
  const made = await success(() => create(MANAGER, one, { key: oneKey }), 'create one private lesson');
  ok(made.meta.replayed === false && made.data.repeats === false && made.data.sessionKind === 'PRIVATE_LESSON' && made.data.seriesId === null && made.data.created === 1, 'one class receipt');
  let row = await sessionRow(made.data.sessionId);
  ok(row.session_kind === 'PRIVATE_LESSON' && row.local_start === '10:00' && row.status === 'SCHEDULED' && row.version === 1 && row.lead === COACH.principal, 'kind, school-time start and lead instructor stored');
  const replay = await success(() => create(MANAGER, one, { key: oneKey }), 'create replay');
  ok(replay.meta.replayed === true && JSON.stringify(replay.data) === JSON.stringify(made.data), 'exact replay');
  await refused(() => create(MANAGER, { ...one, capacity: 2 }, { key: oneKey }), 409, 'IDEMPOTENCY_KEY_REUSED', 'key reused for another body');
  ok((await sql("SELECT count(*)::int n FROM hon.class_sessions WHERE school_id=$1 AND name='Private lesson'", [ids.schoolA])).rows[0].n === 1, 'one class after the replay');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='schedule.calendar.create' AND source='HUMAN_UI'", [made.data.sessionId])).rows[0].n === 1
    && (await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='class_session.created'", [made.data.sessionId])).rows[0].n === 1, 'one audit and one inert outbox event');
  const noInstructor = await success(() => create(MANAGER, { ...one, kind: 'EVENT', name: 'Open mat', instructorPrincipalId: null, capacity: 30, bookingPolicy: 'WALK_IN' }), 'an event with no instructor');
  ok((await sessionRow(noInstructor.data.sessionId)).lead === null, 'no instructor stored');

  // 2. Create a weekly roster: classes through 84 days ahead in the same command, each with the roster kind and instructor.
  const startDay = addDays(today, 1), weekdays = [...new Set([isoDay(startDay), isoDay(addDays(startDay, 2))])];
  const weekly = { kind: 'TRIAL', programId: programs.a, name: 'Trial class', capacity: 10, bookingPolicy: 'OPTIONAL_BOOKING', instructorPrincipalId: COACH.principal,
    localDate: startDay, localStartTime: '17:00', durationMinutes: 60, repeatWeekdays: weekdays };
  const roster = await success(() => create(MANAGER, weekly), 'create a weekly roster');
  const R = roster.data, expected = datesBetween(startDay, addDays(today, 84), weekdays);
  ok(R.repeats && R.seriesId && R.created === expected.length && R.skippedDates.length === 0 && R.sessionKind === 'TRIAL', `roster created ${expected.length} classes`);
  let rows = await rosterSessions(R.seriesId);
  ok(rows.length === expected.length && rows.every((r) => r.session_kind === 'TRIAL' && r.lead === COACH.principal && r.local_start === '17:00') && R.sessionId === rows[0].id, 'every roster class has the kind and the instructor');
  const listed = (await success(() => seriesList(MANAGER), 'the roster on the Roster page')).data.series.find((x) => x.seriesId === R.seriesId);
  ok(listed && listed.generatedThrough === addDays(today, 84) && listed.version === 2, 'the roster is filled through 84 days and at version 2');
  const ending = await success(() => create(MANAGER, { ...weekly, name: 'Short trial', repeatUntil: addDays(startDay, 7) }), 'a roster with a last date');
  ok(ending.data.created === datesBetween(startDay, addDays(startDay, 7), weekdays).length, 'a roster stops at its last date');

  // 3. Read: card details for readers; programs and instructors only for managers; school A only.
  const from = today, to = addDays(today, 42);
  await refused(() => cards(MANAGER, from, to), 403, 'CLASS_SESSIONS_READ_FORBIDDEN', 'card read without session read');
  for (const actor of [NONE]) await refused(() => cards(actor, from, to), 403, undefined, 'card read refused without any schedule permission');
  await refused(() => cards(READER, from, addDays(from, 43)), 400, 'VALIDATION_FAILED', 'more than 42 days');
  await refused(() => cards(READER, to, from), 400, 'VALIDATION_FAILED', 'reversed range');
  await refused(() => call(READER, 'GET', `calendar/cards?from=${from}&to=${to}&x=1`), 400, 'VALIDATION_FAILED', 'an extra query');
  await refused(() => call(READER, 'GET', `calendar/cards?from=${from}`), 400, 'VALIDATION_FAILED', 'a missing date');
  await refused(() => cards(READER, from, to, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'read with an idempotency key');
  const readerView = (await success(() => cards(READER, from, to), 'card read by a reader')).data;
  ok(readerView.canManage === false && readerView.programs.length === 0 && readerView.instructors.length === 0 && readerView.timezone === LA && readerView.localToday === today, 'a reader sees cards only');
  const lesson = readerView.cards.find((c) => c.sessionId === made.data.sessionId);
  ok(lesson && lesson.kind === 'PRIVATE_LESSON' && lesson.programId === programs.a && lesson.programName === 'Adult Karate' && lesson.seriesId === null
    && lesson.instructor?.principalId === COACH.principal && typeof lesson.instructor.displayName === 'string' && lesson.booked === 0 && lesson.attended === false, 'the lesson card details');
  ok(readerView.cards.filter((c) => c.seriesId === R.seriesId).every((c) => c.kind === 'TRIAL'), 'roster cards carry their roster');
  ok(!JSON.stringify(readerView).includes('@example.test'), 'no email in the read');
  const plannerView = (await success(() => cards(PLANNER, from, to), 'card read by a planner')).data;
  ok(plannerView.canManage === true && plannerView.programs.length === 1 && plannerView.programs[0].programId === programs.a
    && plannerView.instructors.some((i) => i.principalId === COACH.principal) && !plannerView.instructors.some((i) => i.principalId === OTHER_SCHOOL.principal)
    && plannerView.instructors.every((i) => Object.keys(i).sort().join() === 'displayName,principalId'), 'a planner also gets own programs and own eligible staff, id and name only');
  ok((await success(() => cards(OTHER_SCHOOL, from, to), 'school B read')).data.cards.every((c) => c.programId !== programs.a), 'school B sees none of school A');

  // 4. Move and resize one class.
  row = await sessionRow(made.data.sessionId);
  const moveBody = { expectedVersion: 1, startsAt: at(row.starts_at, 60), endsAt: at(row.ends_at, 60) };
  for (const actor of [READER, NONE, MIXED]) await refused(() => move(actor, row.id, moveBody), 403, undefined, `move refused for ${actor.subject.split('-').pop()}`);
  await refused(() => move(OTHER_SCHOOL, row.id, moveBody), 404, 'CALENDAR_CARD_NOT_FOUND', 'a school-A class from school B');
  await refused(() => move(MANAGER, randomUUID(), moveBody), 404, 'CALENDAR_CARD_NOT_FOUND', 'an unknown class');
  for (const [label, patch] of [['four minutes', { endsAt: at(moveBody.startsAt, 4) }], ['601 minutes', { endsAt: at(moveBody.startsAt, 601) }],
    ['end before start', { endsAt: at(moveBody.startsAt, -30) }], ['no milliseconds', { startsAt: moveBody.startsAt.replace('.000Z', 'Z') }], ['extra key', { notify: true }],
    ['zero version', { expectedVersion: 0 }]]) await refused(() => move(MANAGER, row.id, { ...moveBody, ...patch }), 400, undefined, `move validation: ${label}`);
  await refused(() => move(MANAGER, row.id, { ...moveBody, expectedVersion: 2 }), 409, 'VERSION_CONFLICT', 'a stale version');
  const past = new Date(Date.now() - 3600000); past.setUTCSeconds(0, 0);
  await refused(() => move(MANAGER, row.id, { expectedVersion: 1, startsAt: past.toISOString(), endsAt: at(past.toISOString(), 45) }), 400, 'CALENDAR_CARD_NOT_IN_FUTURE', 'a move into the past');
  const moveKey = randomUUID();
  const moved = await success(() => move(MANAGER, row.id, moveBody, { key: moveKey }), 'move the lesson an hour later');
  ok(moved.data.version === 2 && moved.data.startsAt === moveBody.startsAt && moved.data.endsAt === moveBody.endsAt && moved.data.detachedFromRoster === false, 'move receipt');
  row = await sessionRow(made.data.sessionId);
  ok(row.local_start === '11:00' && row.version === 2 && row.session_kind === 'PRIVATE_LESSON' && row.lead === COACH.principal, 'moved, kind and instructor kept');
  ok((await success(() => move(MANAGER, row.id, moveBody, { key: moveKey }), 'move replay')).meta.replayed === true, 'move replay');
  await refused(() => move(MANAGER, row.id, { ...moveBody, endsAt: at(moveBody.endsAt, 15) }, { key: moveKey }), 409, 'IDEMPOTENCY_KEY_REUSED', 'move key reused');
  const resized = await success(() => move(MANAGER, row.id, { expectedVersion: 2, startsAt: row.starts_at, endsAt: at(row.starts_at, 90) }), 'resize to 90 minutes');
  ok(resized.data.version === 3 && Date.parse(resized.data.endsAt) - Date.parse(resized.data.startsAt) === 90 * 60000, 'resized');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='schedule.calendar.move'", [row.id])).rows[0].n === 2
    && (await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='class_session.rescheduled'", [row.id])).rows[0].n === 2, 'one audit and one outbox event per move');
  const nextDay = await success(() => move(MANAGER, row.id, { expectedVersion: 3, startsAt: at(row.starts_at, 1440), endsAt: at(row.starts_at, 1440 + 90) }), 'move to the next day');
  ok(nextDay.data.version === 4, 'moved a day');

  // A booked class moves (the page asks first; nobody is contacted); an attended, cancelled or started one never does.
  const person = randomUUID(), student = randomUUID();
  await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Robin','Cards')", [person, ids.organization, ids.schoolA]);
  await sql('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)', [student, ids.organization, ids.schoolA, person]);
  const booked = await sessionRow(noInstructor.data.sessionId);
  await sql("INSERT INTO hon.class_bookings(organization_id,school_id,class_session_id,student_profile_id,booking_kind,status,source) VALUES($1,$2,$3,$4,'REGULAR','BOOKED','STAFF')",
    [ids.organization, ids.schoolA, booked.id, student]);
  const commsBefore = (await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE organization_id=$1 AND event_type NOT IN ('class_session.created','class_session.rescheduled','schedule.series.created','schedule.series.revised')", [ids.organization])).rows[0].n;
  const bookedMove = await success(() => move(MANAGER, booked.id, { expectedVersion: 1, startsAt: at(booked.starts_at, 30), endsAt: at(booked.ends_at, 30) }), 'move a booked class');
  ok(bookedMove.data.version === 2, 'a booked class moved');
  ok((await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE organization_id=$1 AND event_type NOT IN ('class_session.created','class_session.rescheduled','schedule.series.created','schedule.series.revised')", [ids.organization])).rows[0].n === commsBefore, 'no other event, nothing sent');
  ok((await success(() => cards(READER, from, to), 'read the booked count')).data.cards.find((c) => c.sessionId === booked.id).booked === 1, 'booked count shown');
  await sql('BEGIN');
  await sql(`SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),
    set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_external_subject',$4,true),set_config('app.hon_source','HUMAN_UI',true),
    set_config('app.hon_request_id',$5,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)`,
    [ids.organization, ids.schoolA, OWN.principal, OWN.subject, randomUUID()]);
  await sql("INSERT INTO hon.attendance_records(organization_id,school_id,class_session_id,student_profile_id,status,recorded_by_principal_id,note) VALUES($1,$2,$3,$4,'PRESENT',$5,'Synthetic attendance')",
    [ids.organization, ids.schoolA, booked.id, student, OWN.principal]);
  await sql('COMMIT');
  const attended = await sessionRow(booked.id);
  await refused(() => move(MANAGER, booked.id, { expectedVersion: attended.version, startsAt: at(attended.starts_at, 15), endsAt: at(attended.ends_at, 15) }), 409, 'CALENDAR_CARD_LOCKED', 'an attended class');
  ok((await success(() => cards(READER, from, to), 'read attended')).data.cards.find((c) => c.sessionId === booked.id).attended === true, 'attended flag shown');
  const started = randomUUID();
  await sql(`INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy)
    VALUES($1,$2,$3,$4,'Started class',clock_timestamp()-interval '10 minutes',clock_timestamp()+interval '50 minutes',20,'WALK_IN')`, [started, ids.organization, ids.schoolA, programs.a]);
  const future = new Date(Date.now() + 86400000); future.setUTCSeconds(0, 0);
  await refused(() => move(MANAGER, started, { expectedVersion: 1, startsAt: future.toISOString(), endsAt: at(future.toISOString(), 60) }), 409, 'CALENDAR_CARD_LOCKED', 'a started class');
  ok((await sql("SELECT session_kind FROM hon.class_sessions WHERE id=$1", [started])).rows[0].session_kind === 'CLASS', 'existing and directly created classes default to CLASS');

  // 5. Moving one roster class detaches it: a later roster revise never moves it back, the others follow the revise.
  rows = await rosterSessions(R.seriesId);
  const first = await sessionRow(rows[0].id);
  const detach = await success(() => move(MANAGER, first.id, { expectedVersion: first.version, startsAt: at(first.starts_at, 60), endsAt: at(first.ends_at, 60) }), 'move one roster class');
  ok(detach.data.detachedFromRoster === true, 'detached from the roster');
  ok((await sql('SELECT count(*)::int n FROM hon.class_session_roster_detachments WHERE class_session_id=$1 AND series_id=$2', [first.id, R.seriesId])).rows[0].n === 1, 'one detachment row');
  const v = (await success(() => seriesList(MANAGER), 'roster before revise')).data.series.find((x) => x.seriesId === R.seriesId).version;
  const revised = await success(() => revise(MANAGER, R.seriesId, { expectedVersion: v, name: 'Trial class', capacity: 10, bookingPolicy: 'OPTIONAL_BOOKING', weekdays,
    localStartTime: '16:00', durationMinutes: 60 }), 'revise the roster to 16:00');
  ok(revised.data.sessions.updated === rows.length - 1, `the revise updates every class but the moved one: ${JSON.stringify(revised.data.sessions)}`);
  rows = await rosterSessions(R.seriesId);
  ok(rows[0].local_start === '18:00' && rows.slice(1).every((r) => r.local_start === '16:00'), 'the moved class keeps its own time');
  await sql('BEGIN');
  await rejectsSql(() => sql('UPDATE hon.class_session_roster_detachments SET detached_at=clock_timestamp() WHERE class_session_id=$1', [first.id]), /./, 'detachments are immutable');
  await rejectsSql(() => sql('DELETE FROM hon.class_session_roster_detachments WHERE class_session_id=$1', [first.id]), /./, 'detachments cannot be deleted');
  await sql('ROLLBACK');

  // 6. Live authority: a revoked manager is refused; a stale version after someone else moved it is refused.
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE principal_id=$1', [MIXED.principal]);
  await refused(() => create(MIXED, one), 403, undefined, 'a revoked grant');
  const second = await sessionRow(rows[1].id);
  const racers = await Promise.all([30, 45].map((m) => move(MANAGER, second.id, { expectedVersion: second.version, startsAt: at(second.starts_at, m), endsAt: at(second.ends_at, m) })));
  ok(racers.filter((r) => r.status === 200).length === 1 && racers.filter((r) => r.status === 409).length === 1, 'two concurrent moves: one wins, the other is told it changed');

  // 7. Runtime ACL: EXECUTE on the three entry points only; no table privilege, no helper, no UPDATE on class sessions.
  for (const fn of ['create_calendar_card(text,jsonb,text,uuid,uuid)', 'move_calendar_card(text,uuid,jsonb,text,uuid,uuid)', 'read_school_calendar_cards(text,jsonb)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, p.prosecdef, EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(r.runtime && r.prosecdef && !r.public, `runtime may execute definer ${fn}; PUBLIC may not`);
  }
  for (const fn of ['calendar_instructor_ok(uuid,uuid,uuid)', 'class_series_occurrence_inherit()', 'class_series_apply_future(hon.class_series,text)',
    'calendar_card_command_finish(text,text,uuid,jsonb,text,text,uuid,jsonb,jsonb,text,integer,uuid,uuid)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!r.runtime && !r.public, `helper ${fn} is private`);
  }
  ok(!(await sql("SELECT has_any_column_privilege($1,'hon.class_sessions','UPDATE') u", [CRM_CLOSE_RUNTIME_ROLE])).rows[0].u, 'runtime still has no UPDATE on class sessions');
  await assert.rejects(runtime.query('SELECT * FROM hon.class_session_roster_detachments LIMIT 1'), /permission denied/); checks += 1;
  await assert.rejects(runtime.query("SELECT hon.calendar_instructor_ok($1,$2,$3)", [COACH.principal, ids.organization, ids.schoolA]), /permission denied/); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    for (const [startMark, endMark] of [['-- Calendar cards exact verification (0567)', '-- End calendar cards exact verification.'],
      ['-- Recurring class series exact verification (B-SCH-1 0239)', '-- End recurring class series exact verification.']]) {
      const section = verify.split(startMark)[1]?.split(endMark)[0];
      ok(section, startMark);
      await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1;
    } }

  console.log(`PASS: calendar cards (0567): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
