/**
 * School booking types proof (0286) over signed HTTP for staff (HON session cookie -> HonIdentityGuard + human UI guards ->
 * BookingTypeController -> protected definer functions on the restricted runtime role with forced RLS) and over the strict
 * public transport for families (no session -> PublicBookingTypeController -> fixed public functions), on the guarded
 * disposable CRM-close fixture only. Synthetic names and example.test contacts only; nothing is sent.
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
const { BookingTypeController, PublicBookingTypeController } = await load('schedule/booking-type.controller.js');
const { BookingTypeService } = await load('schedule/booking-type.service.js');
const { publicBookingTypeTransport } = await load('schedule/public-booking-type-transport.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-booking-types', secret: randomBytes(32).toString('hex') };
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
    controllers: [BookingTypeController, PublicBookingTypeController],
    providers: [HonIdentityGuard, HonIdentityService, BookingTypeService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false, bodyParser: false });
  app.use(publicBookingTypeTransport());
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
const COMMAND = { read: 'schedule.booking_type.read', save: 'schedule.booking_type.save', status: 'schedule.booking_type.status', booking: 'schedule.booking_type.booking_status' };
function call(actor, method, path, { body, key = randomUUID(), command, headers = {}, school = actor.school, organization = actor.org } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/settings/booking-types${path}`);
  const sent = {
    Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`,
    Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json',
    ...(method === 'POST' ? { 'Content-Type': 'application/json', ...(command ? { 'X-Hon-Human-Command': command } : {}), ...(key ? { 'Idempotency-Key': key } : {}) } : {}),
    ...headers,
  };
  for (const [name, value] of Object.entries(sent)) if (value === undefined) delete sent[name];
  return send(target, method, sent, body === undefined ? undefined : JSON.stringify(body));
}
const list = (actor, options = {}) => call(actor, 'GET', '', options);
const detail = (actor, id, options = {}) => call(actor, 'GET', `/${id}`, options);
const create = (actor, body, options = {}) => call(actor, 'POST', '', { body, command: COMMAND.save, ...options });
const edit = (actor, id, body, options = {}) => call(actor, 'POST', `/${id}/edit`, { body, command: COMMAND.save, ...options });
const setStatus = (actor, id, body, options = {}) => call(actor, 'POST', `/${id}/status`, { body, command: COMMAND.status, ...options });
const bookingStatus = (actor, id, body, options = {}) => call(actor, 'POST', `/bookings/${id}/status`, { body, command: COMMAND.booking, ...options });

function pub(method, path, { body, raw, key = randomUUID().replaceAll('-', ''), headers = {} } = {}) {
  const sent = { Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) } : {}), ...headers };
  for (const [name, value] of Object.entries(sent)) if (value === undefined) delete sent[name];
  return send(new URL(`${origin}/v1/public/booking-types/${path}`), method, sent, raw ?? (body === undefined ? undefined : JSON.stringify(body)));
}
const publicRead = (publicId) => pub('GET', publicId);
const book = (publicId, body, options = {}) => pub('POST', `${publicId}/bookings`, { body, ...options });
const cancelBooking = (publicId, body, options = {}) => pub('POST', `${publicId}/cancellations`, { body, ...options });

async function success(read, label, expectedStatus = 200) {
  const { status, body, headers } = await read();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  ok(/no-store/.test(headers['cache-control'] ?? ''), `${label}: never cached`);
  return body;
}
async function refused(read, expectedStatus, expectedCode, label) {
  const { status, body } = await read();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  if (expectedCode) assert.equal(body.code ?? body.result, expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(body).slice(0, 400)}`);
  ok(!('data' in body) && !('code' in body && /^[A-F0-9]{12}$/.test(body.code)), `${label}: a refusal returns no data`);
}
async function rejectsSql(run, pattern, label) {
  await sql('SAVEPOINT expected_failure');
  try { await run(); } catch (error) { await sql('ROLLBACK TO SAVEPOINT expected_failure'); ok(pattern.test(error.message), `${label}: ${error.message}`); return; }
  await sql('ROLLBACK TO SAVEPOINT expected_failure');
  assert.fail(`${label}: expected a refusal`);
}

// Disposable-fixture cleanup only (as in the 0239 proof).
async function cleanup() {
  const tables = (await sql(`SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
    WHERE c.relnamespace='hon'::regnamespace AND c.relkind='r' ORDER BY 1`)).rows.map((row) => row.relname);
  await sql('BEGIN');
  try {
    await sql('ALTER TABLE hon.school_booking_type_rates DISABLE TRIGGER USER');
    await sql('DELETE FROM hon.school_booking_type_rates WHERE type_id IN (SELECT id FROM hon.school_booking_types WHERE organization_id = ANY($1::uuid[]))', [[ids.organization, ids.otherOrganization]]);
    await sql('ALTER TABLE hon.school_booking_type_rates ENABLE TRIGGER USER');
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
    const left = (await sql('SELECT count(*)::int n FROM hon.school_booking_types WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]])).rows[0].n;
    if (left) throw new Error('fixture cleanup left booking types behind');
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`btypes-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`btypes-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`btypes-${ids.organization}-%`]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `btypes-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Booking Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Booking Staff')", [principal, user]);
  for (const roleId of roles) {
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [randomUUID(), org, school, principal, roleId]);
  }
  return { subject, principal, org, school };
}
let MANAGER, READER, NONE, MIXED, OTHER_SCHOOL, today;
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Booking Org','Booking Org'),($2,'Booking Other Org','Booking Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Booking Dojo ${slug}`, `btypes-${slug}-${school.slice(0, 8)}`, LA]);
  }
  today = (await sql('SELECT (clock_timestamp() AT TIME ZONE $1)::date::text d', [LA])).rows[0].d;
  MANAGER = await staff('manager', [await role(ids.organization, ['schedule.session.manage'])]);
  READER = await staff('reader', [await role(ids.organization, ['schedule.session.read'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read', 'crm.lead.read', 'attendance.record'])]);
  MIXED = await staff('mixed', [await role(ids.organization, ['schedule.session.manage']), await role(ids.organization, ['people.read'], 'PARENT_PORTAL')]);
  OTHER_SCHOOL = await staff('other-school', [await role(ids.organization, allPermissions)], { school: ids.schoolB });
}
const ALL_WEEK = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '09:00', end: '12:00' }));
const QUESTIONS = [{ label: 'Student name', kind: 'TEXT', required: true }, { label: 'First time here?', kind: 'YES_NO', required: false }];
const WAIVER = 'I agree to the dojo rules.\nA parent stays on site.';
const good = { expectedVersion: 0, name: 'Belt test reservation', description: 'Reserve a spot for the belt test.\nBring your uniform.', template: 'TEST_RESERVATION',
  durationMinutes: 30, spotsPerTime: 2, weeklyHours: ALL_WEEK, horizonDays: 7, noticeHours: 0, audience: 'OPEN', questions: QUESTIONS, waiver: WAIVER, thankYou: 'See you on the mat!' };
const family = (startsAt, patch = {}) => ({ startsAt, name: 'Test Family', email: '', mobile: '', answers: ['Sam', null], waiverAccepted: true, website: '', ...patch });
const plusMinutes = (iso, m) => new Date(Date.parse(iso) + m * 60000).toISOString();
const versionOf = async (id) => (await success(() => detail(MANAGER, id), 'detail for version')).data.bookingType.version;

try {
  await cleanup();
  await seed();
  await startApp();

  // 1. Reads need schedule.session.manage at the exact school (bookings carry family contact details and answers).
  const empty = await success(() => list(MANAGER), 'type list by a manager');
  ok(empty.data.bookingTypes.length === 0 && empty.data.localToday === today && empty.data.timezone === LA, 'empty list with the school clock');
  for (const actor of [READER, NONE, MIXED]) await refused(() => list(actor), 403, undefined, `type list refused for ${actor.subject.split('-').pop()}`);
  await refused(() => list(OTHER_SCHOOL, { school: ids.schoolA }), 403, undefined, 'school-B staff at the school-A route');
  await refused(() => list(MANAGER, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'read with an idempotency key');
  await refused(() => call(MANAGER, 'GET', '?x=1'), 400, 'VALIDATION_FAILED', 'list with a query');

  // 2. Create a DRAFT: closed validation, exact replay, audit and outbox.
  for (const actor of [READER, NONE, MIXED]) await refused(() => create(actor, good), 403, undefined, `create refused for ${actor.subject.split('-').pop()}`);
  for (const [label, patch] of [['empty name', { name: '' }], ['padded name', { name: ' Test' }], ['formula name', { name: '=SUM(A1)' }], ['name too long', { name: 'x'.repeat(81) }],
    ['control in description', { description: 'Bring\u0007' }], ['trailing line break', { thankYou: 'Thanks\n' }], ['hidden character', { waiver: 'Agree​' }],
    ['waiver too long', { waiver: 'x'.repeat(4001) }], ['unknown template', { template: 'PARTY' }], ['short length', { durationMinutes: 5 }], ['long length', { durationMinutes: 241 }],
    ['no spots', { spotsPerTime: 0 }], ['too many spots', { spotsPerTime: 51 }], ['no hours', { weeklyHours: [] }], ['too many windows', { weeklyHours: Array.from({ length: 15 }, (_, i) => ({ day: 1, start: `0${i % 9}:00`, end: `0${i % 9}:40` })) }],
    ['overlapping windows', { weeklyHours: [{ day: 2, start: '09:00', end: '11:00' }, { day: 2, start: '10:30', end: '12:00' }] }], ['window shorter than the length', { weeklyHours: [{ day: 2, start: '09:00', end: '09:20' }] }],
    ['day 0', { weeklyHours: [{ day: 0, start: '09:00', end: '12:00' }] }], ['bad clock', { weeklyHours: [{ day: 2, start: '9:00', end: '12:00' }] }], ['extra window key', { weeklyHours: [{ day: 2, start: '09:00', end: '12:00', room: 1 }] }],
    ['horizon 0', { horizonDays: 0 }], ['horizon 91', { horizonDays: 91 }], ['notice 169', { noticeHours: 169 }], ['unknown audience', { audience: 'EVERYONE' }],
    ['six questions', { questions: Array.from({ length: 6 }, () => QUESTIONS[0]) }], ['question without label', { questions: [{ label: '', kind: 'TEXT', required: true }] }],
    ['unknown question kind', { questions: [{ label: 'Age', kind: 'NUMBER', required: true }] }], ['required not boolean', { questions: [{ label: 'Age', kind: 'TEXT', required: 'yes' }] }],
    ['extra key', { automation: true }], ['version on create', { expectedVersion: 1 }]]) {
    await refused(() => create(MANAGER, { ...good, ...patch }), 400, undefined, `create validation: ${label}`);
  }
  await refused(() => create(MANAGER, good, { key: null }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'create without a key');
  await refused(() => create(MANAGER, good, { command: COMMAND.status }), 403, undefined, 'create under another command header');
  const createKey = randomUUID();
  const made = await success(() => create(MANAGER, { ...good, weeklyHours: [...ALL_WEEK].reverse() }, { key: createKey }), 'create the type');
  const T = made.data.bookingType;
  ok(made.meta.replayed === false && T.version === 1 && T.status === 'DRAFT' && T.upcomingCount === 0 && /^[a-f0-9]{48}$/.test(T.publicId), 'type v1 DRAFT');
  ok(JSON.stringify(T.weeklyHours) === JSON.stringify(ALL_WEEK) && T.waiver === WAIVER && T.questions.length === 2, 'weekly hours stored in day order; text with line breaks kept');
  const replay = await success(() => create(MANAGER, { ...good, weeklyHours: [...ALL_WEEK].reverse() }, { key: createKey }), 'create replay');
  ok(replay.meta.replayed === true && JSON.stringify(replay.data) === JSON.stringify(made.data), 'exact replay');
  await refused(() => create(MANAGER, { ...good, spotsPerTime: 3 }, { key: createKey }), 409, 'IDEMPOTENCY_KEY_REUSED', 'key reused for another body');
  ok((await sql('SELECT count(*)::int n FROM hon.school_booking_types WHERE school_id=$1', [ids.schoolA])).rows[0].n === 1, 'one type after the replay');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='schedule.booking_type.save' AND source='HUMAN_UI' AND actor_principal_id=$2", [T.typeId, MANAGER.principal])).rows[0].n === 1
    && (await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='schedule.booking_type.saved' AND payload::text NOT LIKE '%Belt%'", [T.typeId])).rows[0].n === 1, 'one audit row and one inert outbox event with ids only');

  // 3. A draft is invisible to the public; edits move the version by one.
  await refused(() => publicRead(T.publicId), 404, 'INVALID', 'public read of a draft');
  await refused(() => book(T.publicId, family(plusMinutes(new Date().toISOString().slice(0, 14) + '00:00.000Z', 1440), { email: 'a@example.test' })), 400, 'INVALID', 'booking a draft');
  const edited = await success(() => edit(MANAGER, T.typeId, { ...good, expectedVersion: 1, name: 'Belt test' }), 'edit the draft');
  ok(edited.data.bookingType.version === 2 && edited.data.bookingType.name === 'Belt test', 'draft edited');
  await refused(() => edit(MANAGER, T.typeId, { ...good, expectedVersion: 1 }), 409, 'VERSION_CONFLICT', 'edit at a stale version');
  await refused(() => edit(OTHER_SCHOOL, T.typeId, { ...good, expectedVersion: 2 }), 404, 'SCHOOL_BOOKING_TYPE_NOT_FOUND', 'a school-A type from school B');
  await refused(() => detail(OTHER_SCHOOL, T.typeId), 404, 'SCHOOL_BOOKING_TYPE_NOT_FOUND', 'school-A type detail from school B');

  // 4. Activate; a type whose hours give no time inside the horizon cannot.
  await refused(() => setStatus(MANAGER, T.typeId, { expectedVersion: 2, status: 'PAUSED' }), 409, 'SCHOOL_BOOKING_TYPE_STATUS_INVALID', 'pausing a draft');
  await refused(() => setStatus(READER, T.typeId, { expectedVersion: 2, status: 'ACTIVE' }), 403, undefined, 'activate refused for a reader');
  const none = (await success(() => create(MANAGER, { ...good, name: 'Never', noticeHours: 168, horizonDays: 1 }), 'create a type with no times')).data.bookingType;
  await refused(() => setStatus(MANAGER, none.typeId, { expectedVersion: 1, status: 'ACTIVE' }), 422, 'SCHOOL_BOOKING_TYPE_NO_TIMES', 'activating with no bookable time');
  const active = await success(() => setStatus(MANAGER, T.typeId, { expectedVersion: 2, status: 'ACTIVE' }), 'activate');
  ok(active.data.bookingType.status === 'ACTIVE' && active.data.bookingType.version === 3, 'active');

  // 5. Public read: branding, open spots only, times in school time from now to the horizon.
  const seen = await success(() => publicRead(T.publicId), 'public read');
  ok(Object.keys(seen.data).sort().join() === 'audience,branding,description,durationMinutes,name,publicId,questions,schoolName,status,template,times,timezone,waiver', 'whitelisted public fields only');
  ok(seen.data.status === 'OPEN' && seen.data.schoolName === 'Booking Dojo a' && Object.keys(seen.data.branding).sort().join() === 'accentColor,contactLine,coverUrl,logoUrl'
    && Object.values(seen.data.branding).every((v) => v === null), 'school name and (empty) branding');
  const times = seen.data.times;
  ok(times.length > 40 && times.length <= 48 && times.every((t) => t.spotsLeft === 2 && Object.keys(t).sort().join() === 'localDate,localEnd,localStart,spotsLeft,startsAt'), `open times with two spots, no names (${times.length})`);
  ok(times.every((t) => ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30'].includes(t.localStart) && t.localDate >= today && t.localDate <= addDays(today, 7)
    && Date.parse(t.startsAt) >= Date.now() - 60000), 'times in the weekly window, inside the horizon, none in the past');
  const laOf = (iso) => (new Intl.DateTimeFormat('en-GB', { timeZone: LA, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })).format(new Date(iso));
  ok(times.every((t) => laOf(t.startsAt) === t.localStart), 'each instant is the local time in the school time zone');
  ok(times.every((t, i) => i === 0 || t.startsAt > times[i - 1].startsAt), 'times in order');
  await refused(() => publicRead('f'.repeat(48)), 404, 'INVALID', 'unknown public id');
  await sql("INSERT INTO hon.school_page_branding(organization_id,school_id,accent_color,contact_line,created_by_principal_id,updated_by_principal_id) VALUES($1,$2,'#1d4ed8','Call us at the front desk',$3,$3)", [ids.organization, ids.schoolA, MANAGER.principal]);
  const branded = (await success(() => publicRead(T.publicId), 'public read with branding')).data.branding;
  ok(branded.accentColor === '#1d4ed8' && branded.contactLine === 'Call us at the front desk' && branded.logoUrl === null, 'the 0285 branding shows on the page');

  // 6. Booking: validation, answers and waiver, offered times only, one future booking per contact, spots, exact retry.
  const later = times.filter((t) => t.localDate > today);
  const [t0, t1, t2, t3, t4] = later.map((t) => t.startsAt);
  for (const [label, body] of [['no contact', family(t0)], ['bad mobile', family(t0, { mobile: '5551234' })], ['bad email', family(t0, { email: 'not-an-email' })],
    ['honeypot filled', family(t0, { email: 'h@example.test', website: 'spam' })], ['extra key', { ...family(t0, { email: 'x@example.test' }), note: 'hi' }],
    ['empty name', family(t0, { name: '', email: 'x@example.test' })], ['seconds in the time', family(t0.replace(':00.000Z', ':30.000Z'), { email: 'x@example.test' })],
    ['required answer missing', family(t0, { email: 'x@example.test', answers: ['', null] })], ['wrong answer kind', family(t0, { email: 'x@example.test', answers: ['Sam', 'yes'] })],
    ['too few answers', family(t0, { email: 'x@example.test', answers: ['Sam'] })], ['waiver not ticked', family(t0, { email: 'x@example.test', waiverAccepted: false })],
    ['answer too long', family(t0, { email: 'x@example.test', answers: ['x'.repeat(301), null] })]]) {
    await refused(() => book(T.publicId, body), 400, 'INVALID', `booking validation: ${label}`);
  }
  await refused(() => book(T.publicId, family(t0, { email: 'x@example.test' }), { key: 'short' }), 400, 'INVALID', 'booking with a short key');
  for (const [label, at] of [['off the grid', plusMinutes(t0, 10)], ['outside the hours', plusMinutes(t0, -180)], ['in the past', plusMinutes(t0, -7 * 1440)], ['past the horizon', plusMinutes(t0, 14 * 1440)]]) {
    await refused(() => book(T.publicId, family(at, { email: 'x@example.test' })), 409, 'TIME_NOT_OFFERED', `a time not offered: ${label}`);
  }
  const keyA = randomUUID().replaceAll('-', '');
  const A = await success(() => book(T.publicId, family(t0, { name: 'Kim Family', email: 'Kim@Example.test', answers: ['Min-jun', true] }), { key: keyA }), 'family A books', 201);
  ok(A.result === 'BOOKED' && /^[A-F0-9]{12}$/.test(A.code) && A.startsAt === t0 && A.thankYou === 'See you on the mat!' && A.status === 'BOOKED', 'booked with a code and the thank-you message');
  const A2 = await success(() => book(T.publicId, family(t0, { name: 'Kim Family', email: 'Kim@Example.test', answers: ['Min-jun', true] }), { key: keyA }), 'family A retries', 201);
  ok(JSON.stringify(A2) === JSON.stringify(A), 'an exact retry returns the same code');
  await refused(() => book(T.publicId, family(t1, { name: 'Kim Family', email: 'kim@example.test' }), { key: keyA }), 400, 'INVALID', 'same key, other request');
  await refused(() => book(T.publicId, family(t1, { name: 'Kim again', email: 'KIM@example.test' })), 409, 'ALREADY_BOOKED', 'same email (any case) at another time');
  const B = await success(() => book(T.publicId, family(t0, { name: 'Lee Family', mobile: '+15555550101' })), 'family B books by mobile', 201);
  await refused(() => book(T.publicId, family(t1, { name: 'Lee again', mobile: '+15555550101', email: 'lee@example.test' })), 409, 'ALREADY_BOOKED', 'same mobile with a new email');
  await refused(() => book(T.publicId, family(t0, { name: 'Park Family', email: 'park@example.test' })), 409, 'FULL', 'a third family at a two-spot time');
  const stored = (await sql('SELECT email,mobile,answers,questions,waiver_hash,waiver_accepted_at FROM hon.school_booking_type_bookings WHERE type_id=$1 ORDER BY created_at', [T.typeId])).rows;
  ok(stored.length === 2 && stored[0].email === 'kim@example.test' && stored[0].mobile === null && stored[1].mobile === '+15555550101', 'email stored lower-case');
  ok(JSON.stringify(stored[0].answers) === '["Min-jun",true]' && stored[0].questions.length === 2 && stored[0].waiver_accepted_at
    && stored[0].waiver_hash === (await sql("SELECT encode(sha256(convert_to($1,'UTF8')),'hex') h", [WAIVER])).rows[0].h, 'answers, the questions as asked and the waiver hash are kept');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE action_code='schedule.booking_type.booking.create' AND source='PUBLIC_API' AND actor_principal_id='00000000-0000-4000-8000-000000000286' AND organization_id=$1", [ids.organization])).rows[0].n === 2
    && (await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE event_type='schedule.booking_type.booking_created' AND organization_id=$1 AND NOT payload::text ILIKE '%example.test%' AND NOT payload::text LIKE '%+1555%'", [ids.organization])).rows[0].n === 2
    && (await sql("SELECT count(*)::int n FROM hon.audit_events WHERE organization_id=$1 AND (next_state::text ILIKE '%example.test%' OR next_state::text LIKE '%+1555%' OR next_state::text LIKE '%Min-jun%')", [ids.organization])).rows[0].n === 0,
    'bookings audited as the public intake with ids only; no contact or answers in audit or outbox');
  const afterTwo = (await success(() => publicRead(T.publicId), 'public read after two bookings')).data.times;
  ok(afterTwo.find((t) => t.startsAt === t0).spotsLeft === 0 && afterTwo.find((t) => t.startsAt === t1).spotsLeft === 2, 'the full time shows no spots');

  // 7. One concurrent winner per spot, and one booking per family even concurrently.
  const race = await Promise.all([0, 1, 2, 3, 4].map((i) => book(T.publicId, family(t2, { name: `Race ${i}`, email: `race${i}@example.test` }))));
  ok(race.filter((r) => r.status === 201).length === 2 && race.filter((r) => r.status === 409 && r.body.result === 'FULL').length === 3, `two winners, three FULL: ${race.map((r) => r.body.result).join()}`);
  const sameFamily = await Promise.all([t1, t3, t4].map((at) => book(T.publicId, family(at, { name: 'Twin', email: 'twin@example.test' }))));
  ok(sameFamily.filter((r) => r.status === 201).length === 1 && sameFamily.filter((r) => r.body.result === 'ALREADY_BOOKED').length === 2, `one family books once even concurrently: ${sameFamily.map((r) => r.body.result).join()}`);

  // 8. Staff see bookings with contact, answers and waiver time, and manage them.
  const D = (await success(() => detail(MANAGER, T.typeId), 'type detail')).data;
  ok(D.bookings.length === 5 && D.bookingType.upcomingCount === 5 && D.bookings[0].name === 'Kim Family' && D.bookings[0].email === 'kim@example.test'
    && JSON.stringify(D.bookings[0].answers) === '["Min-jun",true]' && D.bookings[0].questions[0].label === 'Student name' && D.bookings[0].waiverAcceptedAt, 'staff see names, contacts, answers and the waiver time');
  ok(D.bookings.every((b, i) => i === 0 || b.startsAt >= D.bookings[i - 1].startsAt), 'bookings soonest first');
  await refused(() => detail(READER, T.typeId), 403, undefined, 'detail refused for a reader');
  await refused(() => edit(MANAGER, T.typeId, { ...good, expectedVersion: 3, spotsPerTime: 1 }), 409, 'SCHOOL_BOOKING_TYPE_SPOTS_BELOW_BOOKED', 'spots below a booked time');
  const reworded = await success(() => edit(MANAGER, T.typeId, { ...good, expectedVersion: 3, spotsPerTime: 3, waiver: 'New rules.' }), 'raise spots and change the waiver');
  ok(reworded.data.bookingType.spotsPerTime === 3 && (await success(() => publicRead(T.publicId), 'read after raise')).data.times.find((t) => t.startsAt === t0).spotsLeft === 1, 'raising spots opens one more place');
  ok((await sql('SELECT waiver_hash FROM hon.school_booking_type_bookings WHERE id=$1', [D.bookings[0].bookingId])).rows[0].waiver_hash === stored[0].waiver_hash, 'a waiver edit never changes what a family accepted');
  const kim = D.bookings.find((b) => b.name === 'Kim Family'), lee = D.bookings.find((b) => b.name === 'Lee Family');
  const arrived = await success(() => bookingStatus(MANAGER, kim.bookingId, { expectedVersion: 1, status: 'ARRIVED' }), 'mark arrived');
  ok(arrived.data.booking.status === 'ARRIVED' && arrived.data.booking.version === 2, 'arrived');
  await refused(() => bookingStatus(MANAGER, kim.bookingId, { expectedVersion: 1, status: 'BOOKED' }), 409, 'VERSION_CONFLICT', 'booking change at a stale version');
  await refused(() => bookingStatus(MANAGER, kim.bookingId, { expectedVersion: 2, status: 'CANCELLED' }), 409, 'SCHOOL_BOOKING_TYPE_BOOKING_STATUS_INVALID', 'cancel an arrived family');
  ok((await success(() => bookingStatus(MANAGER, kim.bookingId, { expectedVersion: 2, status: 'BOOKED' }), 'undo arrived')).data.booking.version === 3, 'undo arrived');
  await refused(() => bookingStatus(OTHER_SCHOOL, lee.bookingId, { expectedVersion: 1, status: 'CANCELLED' }), 404, 'SCHOOL_BOOKING_TYPE_BOOKING_NOT_FOUND', 'school-A booking from school B');
  await refused(() => bookingStatus(MIXED, lee.bookingId, { expectedVersion: 1, status: 'CANCELLED' }), 403, undefined, 'family-type role refused');
  const staffCancel = await success(() => bookingStatus(MANAGER, lee.bookingId, { expectedVersion: 1, status: 'CANCELLED' }), 'staff cancel');
  ok(staffCancel.data.booking.status === 'CANCELLED' && staffCancel.data.booking.cancelledBy === 'STAFF', 'staff cancelled');
  await refused(() => bookingStatus(MANAGER, lee.bookingId, { expectedVersion: 2, status: 'BOOKED' }), 409, 'SCHOOL_BOOKING_TYPE_BOOKING_STATUS_INVALID', 'a cancelled booking stays cancelled');
  const W = { waiverAccepted: true };
  const leeAgain = await success(() => book(T.publicId, family(t1, { name: 'Lee Family', mobile: '+15555550101', ...W })), 'a cancelled family can book again', 201);
  ok(leeAgain.startsAt === t1, 'rebooked at another time');

  // 9. Families cancel with their code (any case, with or without dashes) before the time starts.
  await refused(() => cancelBooking(T.publicId, { code: 'ZZZZ-ZZZZ-ZZZZ' }), 400, 'INVALID', 'a malformed code');
  await refused(() => cancelBooking(T.publicId, { code: '0000-0000-0000' }), 400, 'INVALID', 'an unknown code');
  await refused(() => cancelBooking(T.publicId, { code: A.code, extra: 1 }), 400, 'INVALID', 'extra key');
  const dashed = `${A.code.slice(0, 4)}-${A.code.slice(4, 8)}-${A.code.slice(8)}`.toLowerCase();
  ok((await success(() => cancelBooking(T.publicId, { code: dashed }), 'family cancels')).result === 'CANCELLED', 'cancelled by the family');
  ok((await success(() => cancelBooking(T.publicId, { code: A.code }), 'cancel again')).result === 'CANCELLED', 'cancelling twice is safe');
  ok((await sql('SELECT cancelled_by FROM hon.school_booking_type_bookings WHERE id=$1', [kim.bookingId])).rows[0].cancelled_by === 'FAMILY', 'recorded as a family cancel');
  const past = (await sql(`INSERT INTO hon.school_booking_type_bookings(type_id,organization_id,school_id,starts_at,ends_at,local_date,local_start,family_name,email,questions,answers,key_hash,payload_hash,code_hash)
    SELECT id,organization_id,school_id,date_trunc('minute',clock_timestamp())-interval '1 hour',date_trunc('minute',clock_timestamp())-interval '30 minutes',$2::date,'08:00','Past Family','past@example.test','[]','[]',
      repeat('a',64),repeat('b',64),encode(sha256(convert_to(hash_secret||':code-check:'||'ABCDEF012345','UTF8')),'hex') FROM hon.school_booking_types WHERE id=$1 RETURNING id`, [T.typeId, today])).rows[0].id;
  await refused(() => cancelBooking(T.publicId, { code: 'ABCD-EF01-2345' }), 409, 'STARTED', 'a booking that has started cannot be cancelled by code');
  ok(past, 'past booking fixture');

  // 10. Per-contact rate limit: five attempts an hour.
  const spam = [];
  for (let i = 0; i < 6; i += 1) spam.push(await book(T.publicId, family(t4, { name: 'Spam', email: 'spam@example.test', waiverAccepted: true })));
  ok(spam[0].status === 201 && spam.slice(1, 5).every((r) => r.body.result === 'ALREADY_BOOKED') && spam[5].status === 429 && spam[5].headers['retry-after'] === '3600', `sixth attempt rate limited: ${spam.map((r) => r.body.result).join()}`);
  ok((await sql("SELECT count(*)::int n FROM hon.school_booking_type_rates WHERE type_id=$1 AND bucket ~ '^[a-f0-9]{64}$'", [T.typeId])).rows[0].n > 0, 'contact buckets are keyed hashes');

  // 11. Families only: the link shows the type with no times and refuses public booking.
  let v = await versionOf(T.typeId);
  await success(() => edit(MANAGER, T.typeId, { ...good, expectedVersion: v, spotsPerTime: 3, waiver: 'New rules.', audience: 'FAMILIES_ONLY' }), 'switch to families only');
  const fam = (await success(() => publicRead(T.publicId), 'read families-only')).data;
  ok(fam.audience === 'FAMILIES_ONLY' && fam.status === 'OPEN' && fam.times.length === 0, 'families-only shows no times');
  await refused(() => book(T.publicId, family(t3, { email: 'fam@example.test' })), 403, 'FAMILIES_ONLY', 'public booking of a families-only type');
  v = await versionOf(T.typeId);
  await success(() => edit(MANAGER, T.typeId, { ...good, expectedVersion: v, spotsPerTime: 3, waiver: 'New rules.' }), 'back to an open link');

  // 12. Pause, resume and archive.
  v = await versionOf(T.typeId);
  await success(() => setStatus(MANAGER, T.typeId, { expectedVersion: v, status: 'PAUSED' }), 'pause');
  const paused = (await success(() => publicRead(T.publicId), 'read paused')).data;
  ok(paused.status === 'PAUSED' && paused.times.length === 0, 'paused shows no times');
  await refused(() => book(T.publicId, family(t3, { email: 'late@example.test' })), 409, 'CLOSED', 'booking a paused type');
  ok((await success(() => cancelBooking(T.publicId, { code: leeAgain.code }), 'cancel while paused')).result === 'CANCELLED', 'families can still cancel while paused');
  await success(() => setStatus(MANAGER, T.typeId, { expectedVersion: v + 1, status: 'ACTIVE' }), 'resume');
  ok((await success(() => publicRead(T.publicId), 'read resumed')).data.status === 'OPEN', 'resumed');
  await success(() => setStatus(MANAGER, T.typeId, { expectedVersion: v + 2, status: 'ARCHIVED' }), 'archive');
  ok((await success(() => publicRead(T.publicId), 'read archived')).data.status === 'CLOSED', 'families see it is closed');
  await refused(() => setStatus(MANAGER, T.typeId, { expectedVersion: v + 3, status: 'ACTIVE' }), 409, 'SCHOOL_BOOKING_TYPE_ARCHIVED', 'an archived type is final');
  await refused(() => edit(MANAGER, T.typeId, { ...good, expectedVersion: v + 3 }), 409, 'SCHOOL_BOOKING_TYPE_ARCHIVED', 'editing an archived type');
  ok((await sql("SELECT count(*)::int n FROM hon.school_booking_type_bookings WHERE type_id=$1 AND status<>'CANCELLED'", [T.typeId])).rows[0].n > 0, 'archiving keeps the booking list for staff');

  // 13. At most 20 types that are not archived per school.
  let made20 = (await sql("SELECT count(*)::int n FROM hon.school_booking_types WHERE school_id=$1 AND status<>'ARCHIVED'", [ids.schoolA])).rows[0].n;
  while (made20 < 20) { await success(() => create(MANAGER, { ...good, name: `Type ${made20}` }), `create type ${made20}`); made20 += 1; }
  await refused(() => create(MANAGER, { ...good, name: 'One too many' }), 409, 'SCHOOL_BOOKING_TYPE_LIMIT', 'the 21st type');
  await success(() => setStatus(MANAGER, none.typeId, { expectedVersion: 1, status: 'ARCHIVED' }), 'archive one');
  const roomAgain = (await success(() => create(MANAGER, { ...good, name: 'Parent meeting', template: 'PARENT_MEETING', questions: [], waiver: '' }), 'create after archiving')).data.bookingType;
  ok(roomAgain.template === 'PARENT_MEETING', 'room again after archiving');
  ok((await success(() => list(MANAGER), 'list all')).data.bookingTypes.at(-1).status === 'ARCHIVED', 'archived types listed last');

  // 14. Live access loss: a lapsed entitlement hides the link and refuses staff.
  await success(() => setStatus(MANAGER, roomAgain.typeId, { expectedVersion: 1, status: 'ACTIVE' }), 'activate parent meeting');
  const liveTime = (await publicRead(roomAgain.publicId)).body.data.times.at(-1).startsAt;
  const noWaiver = (patch) => family(liveTime, { answers: [], waiverAccepted: false, ...patch });
  await sql('UPDATE hon.organization_entitlements SET effective_until=clock_timestamp() WHERE organization_id=$1', [ids.organization]);
  await refused(() => publicRead(roomAgain.publicId), 404, 'INVALID', 'public read after access lapses');
  await refused(() => book(roomAgain.publicId, noWaiver({ email: 'lapse@example.test' })), 400, 'INVALID', 'booking after access lapses');
  await refused(() => list(MANAGER), 403, undefined, 'staff refused after access lapses');
  await sql('UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1', [ids.organization]);
  ok((await success(() => publicRead(roomAgain.publicId), 'read after restore')).data.status === 'OPEN', 'the link works again once access is back');
  ok((await success(() => book(roomAgain.publicId, noWaiver({ email: 'meet@example.test' })), 'book a parent meeting with no questions', 201)).result === 'BOOKED', 'no questions and no waiver');

  // 15. Strict public transport.
  await refused(() => pub('GET', `${roomAgain.publicId}?x=1`), 400, 'INVALID', 'query string');
  await refused(() => pub('POST', `${roomAgain.publicId}/bookings`, { body: noWaiver({ email: 't@example.test' }), headers: { 'Content-Type': 'text/plain' } }), 400, 'INVALID', 'wrong content type');
  await refused(() => pub('POST', `${roomAgain.publicId}/bookings`, { raw: `{"startsAt":"${liveTime}","name":"A","name":"B","email":"t@example.test","mobile":"","answers":[],"waiverAccepted":false,"website":""}` }), 400, 'INVALID', 'duplicate JSON key');
  await refused(() => pub('POST', `${roomAgain.publicId}/other`, { body: {} }), 400, 'INVALID', 'unknown public path');
  await refused(() => pub('POST', `${roomAgain.publicId}/bookings`, { raw: JSON.stringify({ ...noWaiver({ email: 't@example.test' }), name: 'x'.repeat(9000) }) }), 400, 'INVALID', 'body over 8 KiB');

  // 16. Guards.
  await sql('BEGIN');
  await rejectsSql(() => sql("UPDATE hon.school_booking_types SET name='x' WHERE id=$1", [roomAgain.typeId]), /SCHOOL_BOOKING_TYPE_IMMUTABLE/, 'type change without a version step');
  await rejectsSql(() => sql("UPDATE hon.school_booking_types SET status='DRAFT',version=version+1 WHERE id=$1", [roomAgain.typeId]), /SCHOOL_BOOKING_TYPE_IMMUTABLE/, 'back to draft');
  await rejectsSql(() => sql('UPDATE hon.school_booking_types SET public_id=$2,version=version+1 WHERE id=$1', [roomAgain.typeId, 'a'.repeat(48)]), /SCHOOL_BOOKING_TYPE_IMMUTABLE/, 'public id rewritten');
  await rejectsSql(() => sql("UPDATE hon.school_booking_types SET name='y',version=version+1 WHERE id=$1", [T.typeId]), /SCHOOL_BOOKING_TYPE_IMMUTABLE/, 'archived type changed');
  await rejectsSql(() => sql('DELETE FROM hon.school_booking_types WHERE id=$1', [T.typeId]), /SCHOOL_BOOKING_TYPE_IMMUTABLE/, 'type deleted');
  await rejectsSql(() => sql("UPDATE hon.school_booking_type_bookings SET family_name='x',version=version+1 WHERE type_id=$1", [T.typeId]), /SCHOOL_BOOKING_TYPE_BOOKING_IMMUTABLE/, 'booking name rewritten');
  await rejectsSql(() => sql("UPDATE hon.school_booking_type_bookings SET answers='[\"x\",null]',version=version+1 WHERE id=$1", [kim.bookingId]), /SCHOOL_BOOKING_TYPE_BOOKING_IMMUTABLE/, 'answers rewritten');
  await rejectsSql(() => sql("UPDATE hon.school_booking_type_bookings SET starts_at=starts_at+interval '1 day',version=version+1 WHERE id=$1", [kim.bookingId]), /SCHOOL_BOOKING_TYPE_BOOKING_IMMUTABLE/, 'time moved');
  await rejectsSql(() => sql("UPDATE hon.school_booking_type_bookings SET status='BOOKED',cancelled_by=NULL,cancelled_at=NULL,version=version+1 WHERE id=$1", [lee.bookingId]), /SCHOOL_BOOKING_TYPE_BOOKING_IMMUTABLE/, 'cancelled booking revived');
  await rejectsSql(() => sql('DELETE FROM hon.school_booking_type_bookings WHERE type_id=$1', [T.typeId]), /SCHOOL_BOOKING_TYPE_BOOKING_IMMUTABLE/, 'booking deleted');
  await rejectsSql(() => sql('TRUNCATE hon.school_booking_type_bookings CASCADE'), /./, 'bookings truncated');
  await rejectsSql(() => sql('TRUNCATE hon.school_booking_types CASCADE'), /./, 'types truncated');
  await sql('ROLLBACK');

  // 17. Runtime ACL: EXECUTE on the eight entry points only; no table privilege; private helpers.
  const entry = ['save_school_booking_type(text,uuid,jsonb,text,uuid,uuid)', 'set_school_booking_type_status(text,uuid,jsonb,text,uuid,uuid)',
    'set_school_booking_type_booking_status(text,uuid,jsonb,text,uuid,uuid)', 'read_school_booking_types(text)', 'read_school_booking_type(text,uuid)',
    'read_public_school_booking_type(text)', 'book_public_school_booking_type(text,jsonb,text)', 'cancel_public_school_booking_type_booking(text,jsonb)'];
  const helpers = ['school_booking_text_ok(text,integer)', 'guard_school_booking_type()', 'guard_school_booking_type_booking()', 'school_booking_type_utc(timestamp with time zone)',
    'school_booking_type_taken(uuid,timestamp with time zone)', 'school_booking_type_times(hon.school_booking_types,text,integer)',
    'school_booking_type_time_ok(hon.school_booking_types,text,timestamp with time zone)', 'school_booking_type_json(hon.school_booking_types)',
    'school_booking_type_booking_json(hon.school_booking_type_bookings)', 'school_booking_type_input(jsonb)',
    'school_booking_type_command_finish(text,text,uuid,jsonb,text,text,uuid,jsonb,jsonb,text,integer,uuid,uuid)', 'take_school_booking_type_rate(uuid,text,integer)',
    'public_school_booking_type(text)', 'school_booking_type_booking_input(hon.school_booking_types,jsonb)'];
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
  for (const table of ['school_booking_types', 'school_booking_type_bookings', 'school_booking_type_rates']) {
    const row = (await sql(`SELECT c.relrowsecurity AND c.relforcerowsecurity forced, has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT')
      OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_any_column_privilege($1,c.oid,'SELECT') runtime FROM pg_class c WHERE c.oid=$2::regclass`,
      [CRM_CLOSE_RUNTIME_ROLE, `hon.${table}`])).rows[0];
    ok(row.forced && !row.runtime, `${table}: forced RLS, no runtime privilege`);
  }
  await assert.rejects(runtime.query('SELECT * FROM hon.school_booking_type_bookings LIMIT 1'), /permission denied/); checks += 1;
  ok((await sql("SELECT count(*)::int n FROM hon.principal_role_grants WHERE principal_id='00000000-0000-4000-8000-000000000286'")).rows[0].n === 0, 'the public intake principal holds no role');
  ok((await sql("SELECT count(*)::int n FROM hon.crm_leads WHERE organization_id=$1", [ids.organization])).rows[0].n === 0, 'no CRM lead was created');
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const startMark = '-- School booking types exact verification (0286)', endMark = '-- End school booking types exact verification.';
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: school booking types (0286): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
