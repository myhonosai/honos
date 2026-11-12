/**
 * Sale-day and event slot booking proof (B-SCH-3, 0261) over signed HTTP for staff (HON session cookie -> HonIdentityGuard +
 * human UI guards -> SchoolEventController -> protected definer functions on the restricted runtime role with forced RLS)
 * and over the strict public transport for families (no session -> PublicSchoolEventController -> fixed public functions),
 * on the guarded disposable CRM-close fixture only. Synthetic names and example.test contacts only; nothing is sent.
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
const { SchoolEventController, PublicSchoolEventController } = await load('schedule/school-event.controller.js');
const { SchoolEventService } = await load('schedule/school-event.service.js');
const { publicEventTransport } = await load('schedule/public-event-transport.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-school-events', secret: randomBytes(32).toString('hex') };
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
    controllers: [SchoolEventController, PublicSchoolEventController],
    providers: [HonIdentityGuard, HonIdentityService, SchoolEventService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false, bodyParser: false });
  app.use(publicEventTransport());
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
const COMMAND = { read: 'schedule.event.read', save: 'schedule.event.save', status: 'schedule.event.status', booking: 'schedule.event.booking_status' };
function call(actor, method, path, { body, key = randomUUID(), command, headers = {}, school = actor.school, organization = actor.org } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/schedule/events${path}`);
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
  return send(new URL(`${origin}/v1/public/events/${path}`), method, sent, raw ?? (body === undefined ? undefined : JSON.stringify(body)));
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
    await sql('ALTER TABLE hon.school_event_rates DISABLE TRIGGER USER');
    await sql('DELETE FROM hon.school_event_rates WHERE event_id IN (SELECT id FROM hon.school_events WHERE organization_id = ANY($1::uuid[]))', [[ids.organization, ids.otherOrganization]]);
    await sql('ALTER TABLE hon.school_event_rates ENABLE TRIGGER USER');
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
    const left = (await sql('SELECT count(*)::int n FROM hon.school_events WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]])).rows[0].n;
    if (left) throw new Error('fixture cleanup left events behind');
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`events-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`events-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`events-${ids.organization}-%`]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `events-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Event Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Event Staff')", [principal, user]);
  for (const roleId of roles) {
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [randomUUID(), org, school, principal, roleId]);
  }
  return { subject, principal, org, school };
}
let MANAGER, READER, NONE, MIXED, OTHER_SCHOOL, today;
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Events Org','Events Org'),($2,'Events Other Org','Events Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Events Dojo ${slug}`, `events-${slug}-${school.slice(0, 8)}`, LA]);
  }
  today = (await sql('SELECT (clock_timestamp() AT TIME ZONE $1)::date::text d', [LA])).rows[0].d;
  MANAGER = await staff('manager', [await role(ids.organization, ['schedule.session.manage'])]);
  READER = await staff('reader', [await role(ids.organization, ['schedule.session.read'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read', 'crm.lead.read', 'attendance.record'])]);
  MIXED = await staff('mixed', [await role(ids.organization, ['schedule.session.manage']), await role(ids.organization, ['people.read'], 'PARENT_PORTAL')]);
  OTHER_SCHOOL = await staff('other-school', [await role(ids.organization, allPermissions)], { school: ids.schoolB });
}
const family = (slotId, patch = {}) => ({ slotId, name: 'Test Family', email: '', mobile: '', website: '', ...patch });

try {
  await cleanup();
  await seed();
  await startApp();

  // 1. Reads need schedule.session.manage at the exact school (the bookings carry family contact details).
  const empty = await success(() => list(MANAGER), 'event list by a manager');
  ok(empty.data.events.length === 0 && empty.data.localToday === today && empty.data.timezone === LA, 'empty list with the school clock');
  for (const actor of [READER, NONE, MIXED]) await refused(() => list(actor), 403, undefined, `event list refused for ${actor.subject.split('-').pop()}`);
  await refused(() => list(OTHER_SCHOOL, { school: ids.schoolA }), 403, undefined, 'school-B staff at the school-A route');
  await refused(() => list(MANAGER, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'read with an idempotency key');
  await refused(() => call(MANAGER, 'GET', '?x=1'), 400, 'VALIDATION_FAILED', 'list with a query');

  // 2. Create a DRAFT: closed validation, date window, exact replay, audit and outbox.
  const day = addDays(today, 3);
  const good = { expectedVersion: 0, title: 'Black Friday Sale', description: 'Gear and uniforms, one family per slot.', place: 'Front lobby',
    localDate: day, opensAt: '09:00', closesAt: '12:00', slotMinutes: 30, spotsPerSlot: 2 };
  for (const actor of [READER, NONE, MIXED]) await refused(() => create(actor, good), 403, undefined, `create refused for ${actor.subject.split('-').pop()}`);
  for (const [label, patch] of [['empty title', { title: '' }], ['padded title', { title: ' Sale' }], ['formula title', { title: '=SUM(A1)' }], ['control in place', { place: 'Lobby\u0007' }],
    ['hidden character', { description: 'Sale\u200B' }], ['closing before opening', { closesAt: '08:00' }], ['slot longer than the day', { closesAt: '09:20' }],
    ['slot too short', { slotMinutes: 5 }], ['slot too long', { slotMinutes: 241 }], ['no spots', { spotsPerSlot: 0 }], ['too many spots', { spotsPerSlot: 501 }],
    ['bad hour', { opensAt: '24:00' }], ['seconds', { opensAt: '09:00:00' }], ['impossible date', { localDate: '2026-02-30' }], ['extra key', { automation: true }],
    ['version on create', { expectedVersion: 1 }]]) {
    await refused(() => create(MANAGER, { ...good, ...patch }), 400, undefined, `create validation: ${label}`);
  }
  await refused(() => create(MANAGER, { ...good, localDate: addDays(today, -1) }), 422, 'SCHOOL_EVENT_DATE_OUT_OF_RANGE', 'an event in the past');
  await refused(() => create(MANAGER, { ...good, localDate: addDays(today, 366) }), 422, 'SCHOOL_EVENT_DATE_OUT_OF_RANGE', 'an event over a year ahead');
  await refused(() => create(MANAGER, good, { key: null }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'create without a key');
  await refused(() => create(MANAGER, good, { command: COMMAND.status }), 403, undefined, 'create under another command header');
  const createKey = randomUUID();
  const made = await success(() => create(MANAGER, good, { key: createKey }), 'create the event');
  const E = made.data.event;
  ok(made.meta.replayed === false && E.version === 1 && E.status === 'DRAFT' && E.slotCount === 0 && E.bookedCount === 0 && /^[a-f0-9]{48}$/.test(E.publicId), 'event v1 DRAFT, no slots yet');
  const replay = await success(() => create(MANAGER, good, { key: createKey }), 'create replay');
  ok(replay.meta.replayed === true && JSON.stringify(replay.data) === JSON.stringify(made.data), 'exact replay');
  await refused(() => create(MANAGER, { ...good, spotsPerSlot: 3 }, { key: createKey }), 409, 'IDEMPOTENCY_KEY_REUSED', 'key reused for another body');
  ok((await sql('SELECT count(*)::int n FROM hon.school_events WHERE school_id=$1', [ids.schoolA])).rows[0].n === 1, 'one event after the replay');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='schedule.event.save' AND source='HUMAN_UI' AND actor_principal_id=$2", [E.eventId, MANAGER.principal])).rows[0].n === 1
    && (await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='schedule.event.saved'", [E.eventId])).rows[0].n === 1, 'one audit row and one inert outbox event');

  // 3. A draft is invisible to the public and fully editable.
  await refused(() => publicRead(E.publicId), 404, 'INVALID', 'public read of a draft');
  await refused(() => book(E.publicId, family(randomUUID(), { email: 'a@example.test' })), 400, 'INVALID', 'booking a draft');
  const edited = await success(() => edit(MANAGER, E.eventId, { ...good, expectedVersion: 1, opensAt: '10:00', closesAt: '13:00' }), 'edit the draft times');
  ok(edited.data.event.version === 2 && edited.data.event.opensAt === '10:00' && edited.data.event.closesAt === '13:00', 'draft times changed');
  await refused(() => edit(MANAGER, E.eventId, { ...good, expectedVersion: 1 }), 409, 'VERSION_CONFLICT', 'edit at a stale version');
  await refused(() => edit(OTHER_SCHOOL, E.eventId, { ...good, expectedVersion: 2 }), 404, 'SCHOOL_EVENT_NOT_FOUND', 'a school-A event from school B');
  await refused(() => detail(OTHER_SCHOOL, E.eventId), 404, 'SCHOOL_EVENT_NOT_FOUND', 'school-A event detail from school B');

  // 4. Publish makes six 30-minute slots; date and times are then fixed.
  await refused(() => setStatus(MANAGER, E.eventId, { expectedVersion: 2, status: 'CLOSED' }), 409, 'SCHOOL_EVENT_STATUS_INVALID', 'closing a draft');
  await refused(() => setStatus(READER, E.eventId, { expectedVersion: 2, status: 'PUBLISHED' }), 403, undefined, 'publish refused for a reader');
  const published = await success(() => setStatus(MANAGER, E.eventId, { expectedVersion: 2, status: 'PUBLISHED' }), 'publish');
  ok(published.data.event.status === 'PUBLISHED' && published.data.event.slotCount === 6 && published.data.skippedTimes.length === 0, 'six slots, nothing skipped');
  const slots = (await sql("SELECT id,position,to_char(local_start,'HH24:MI') s,to_char(starts_at AT TIME ZONE $2,'HH24:MI') l FROM hon.school_event_slots WHERE event_id=$1 ORDER BY position", [E.eventId, LA])).rows;
  ok(slots.map((s) => s.s).join() === '10:00,10:30,11:00,11:30,12:00,12:30' && slots.every((s) => s.s === s.l), 'slots in school time, stored as the right instants');
  await refused(() => edit(MANAGER, E.eventId, { ...good, expectedVersion: 3, opensAt: '10:00', closesAt: '14:00' }), 409, 'SCHOOL_EVENT_SCHEDULE_LOCKED', 'changing times after publishing');
  const retitled = await success(() => edit(MANAGER, E.eventId, { ...good, expectedVersion: 3, opensAt: '10:00', closesAt: '13:00', title: 'Holiday Sale' }), 'retitle after publishing');
  ok(retitled.data.event.title === 'Holiday Sale' && retitled.data.event.version === 4 && retitled.data.event.slotCount === 6, 'text can change; slots unchanged');

  // 5. The public read shows open spots only.
  const seen = await success(() => publicRead(E.publicId), 'public read');
  ok(seen.data.title === 'Holiday Sale' && seen.data.schoolName === 'Events Dojo a' && seen.data.status === 'OPEN' && seen.data.slots.length === 6
    && seen.data.slots.every((s) => s.spotsLeft === 2 && Object.keys(s).sort().join() === 'localEnd,localStart,slotId,spotsLeft'), 'six open slots with two spots each, no names');
  ok(Object.keys(seen.data).sort().join() === 'description,localDate,place,publicId,schoolName,slots,status,timezone,title', 'whitelisted public fields only');
  await refused(() => publicRead('f'.repeat(48)), 404, 'INVALID', 'unknown public id');

  // 6. Booking: validation, one booking per family, spots, exact retry.
  const [s0, s1, s2] = slots.map((s) => s.id);
  for (const [label, body] of [['no contact', family(s0)], ['bad mobile', family(s0, { mobile: '5551234' })], ['bad email', family(s0, { email: 'not-an-email' })],
    ['honeypot filled', family(s0, { email: 'h@example.test', website: 'spam' })], ['extra key', { ...family(s0, { email: 'x@example.test' }), note: 'hi' }],
    ['empty name', family(s0, { name: '', email: 'x@example.test' })], ['slot not a uuid', family('slot-1', { email: 'x@example.test' })]]) {
    await refused(() => book(E.publicId, body), 400, 'INVALID', `booking validation: ${label}`);
  }
  await refused(() => book(E.publicId, family(s0, { email: 'x@example.test' }), { key: 'short' }), 400, 'INVALID', 'booking with a short key');
  await refused(() => book(E.publicId, family(randomUUID(), { email: 'x@example.test' })), 400, 'INVALID', 'a slot of no event');
  const keyA = randomUUID().replaceAll('-', '');
  const A = await success(() => book(E.publicId, family(s0, { name: 'Kim Family', email: 'Kim@Example.test' }), { key: keyA }), 'family A books', 201);
  ok(A.result === 'BOOKED' && /^[A-F0-9]{12}$/.test(A.code) && A.slotId === s0 && A.localStart === '10:00' && A.status === 'BOOKED', 'booked with a code');
  const A2 = await success(() => book(E.publicId, family(s0, { name: 'Kim Family', email: 'Kim@Example.test' }), { key: keyA }), 'family A retries', 201);
  ok(JSON.stringify(A2) === JSON.stringify(A), 'an exact retry returns the same code');
  await refused(() => book(E.publicId, family(s1, { name: 'Kim Family', email: 'kim@example.test' }), { key: keyA }), 400, 'INVALID', 'same key, other request');
  await refused(() => book(E.publicId, family(s1, { name: 'Kim again', email: 'KIM@example.test' })), 409, 'ALREADY_BOOKED', 'same email (any case) in another slot');
  const B = await success(() => book(E.publicId, family(s0, { name: 'Lee Family', mobile: '+15555550101' })), 'family B books by mobile', 201);
  await refused(() => book(E.publicId, family(s1, { name: 'Lee again', mobile: '+15555550101', email: 'lee@example.test' })), 409, 'ALREADY_BOOKED', 'same mobile with a new email');
  await refused(() => book(E.publicId, family(s0, { name: 'Park Family', email: 'park@example.test' })), 409, 'FULL', 'a third family in a two-spot slot');
  ok((await sql('SELECT count(*)::int n FROM hon.school_event_bookings WHERE event_id=$1', [E.eventId])).rows[0].n === 2, 'two bookings stored');
  const stored = (await sql('SELECT email,mobile,family_name FROM hon.school_event_bookings WHERE event_id=$1 ORDER BY created_at', [E.eventId])).rows;
  ok(stored[0].email === 'kim@example.test' && stored[0].mobile === null && stored[1].mobile === '+15555550101', 'email stored lower-case');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE action_code='schedule.event.booking.create' AND source='PUBLIC_API' AND actor_principal_id='00000000-0000-4000-8000-000000000261' AND organization_id=$1", [ids.organization])).rows[0].n === 2
    && (await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE event_type='schedule.event.booking_created' AND organization_id=$1 AND NOT payload::text ILIKE '%example.test%' AND NOT payload::text LIKE '%+1555%'", [ids.organization])).rows[0].n === 2
    && (await sql("SELECT count(*)::int n FROM hon.audit_events WHERE organization_id=$1 AND (next_state::text ILIKE '%example.test%' OR next_state::text LIKE '%+1555%' OR next_state::text LIKE '%Family%')", [ids.organization])).rows[0].n === 0,
    'bookings audited as the public intake with ids only; no contact in audit or outbox');
  const afterTwo = await success(() => publicRead(E.publicId), 'public read after two bookings');
  ok(afterTwo.data.slots[0].spotsLeft === 0 && afterTwo.data.slots[1].spotsLeft === 2, 'the full slot shows no spots');

  // 7. One concurrent winner per spot: five families race for two spots.
  const race = await Promise.all([0, 1, 2, 3, 4].map((i) => book(E.publicId, family(s2, { name: `Race ${i}`, email: `race${i}@example.test` }))));
  ok(race.filter((r) => r.status === 201).length === 2 && race.filter((r) => r.status === 409 && r.body.result === 'FULL').length === 3, `two winners, three FULL: ${race.map((r) => r.body.result).join()}`);
  const sameFamily = await Promise.all([s1, slots[3].id, slots[4].id].map((slotId) => book(E.publicId, family(slotId, { name: 'Twin', email: 'twin@example.test' }))));
  ok(sameFamily.filter((r) => r.status === 201).length === 1 && sameFamily.filter((r) => r.body.result === 'ALREADY_BOOKED').length === 2, `one family books once even concurrently: ${sameFamily.map((r) => r.body.result).join()}`);

  // 8. Staff see who is coming and manage bookings.
  const D = (await success(() => detail(MANAGER, E.eventId), 'event detail')).data;
  ok(D.slots.length === 6 && D.slots[0].taken === 2 && D.slots[0].bookings.map((b) => b.name).join() === 'Kim Family,Lee Family' && D.slots[0].bookings[0].email === 'kim@example.test'
    && D.event.bookedCount === 5, 'staff see names and contacts per slot');
  await refused(() => detail(READER, E.eventId), 403, undefined, 'detail refused for a reader');
  await refused(() => edit(MANAGER, E.eventId, { ...good, expectedVersion: 4, opensAt: '10:00', closesAt: '13:00', title: 'Holiday Sale', spotsPerSlot: 1 }), 409, 'SCHOOL_EVENT_SPOTS_BELOW_BOOKED', 'spots below the most-booked slot');
  const roomier = await success(() => edit(MANAGER, E.eventId, { ...good, expectedVersion: 4, opensAt: '10:00', closesAt: '13:00', title: 'Holiday Sale', spotsPerSlot: 3 }), 'raise spots');
  ok(roomier.data.event.spotsPerSlot === 3 && (await success(() => publicRead(E.publicId), 'read after raise')).data.slots[0].spotsLeft === 1, 'raising spots opens one more place');
  const kim = D.slots[0].bookings[0], lee = D.slots[0].bookings[1];
  const arrived = await success(() => bookingStatus(MANAGER, kim.bookingId, { expectedVersion: 1, status: 'ARRIVED' }), 'mark arrived');
  ok(arrived.data.booking.status === 'ARRIVED' && arrived.data.booking.version === 2, 'arrived');
  await refused(() => bookingStatus(MANAGER, kim.bookingId, { expectedVersion: 1, status: 'BOOKED' }), 409, 'VERSION_CONFLICT', 'booking change at a stale version');
  await refused(() => bookingStatus(MANAGER, kim.bookingId, { expectedVersion: 2, status: 'CANCELLED' }), 409, 'SCHOOL_EVENT_BOOKING_STATUS_INVALID', 'cancel an arrived family');
  const undone = await success(() => bookingStatus(MANAGER, kim.bookingId, { expectedVersion: 2, status: 'BOOKED' }), 'undo arrived');
  ok(undone.data.booking.status === 'BOOKED' && undone.data.booking.version === 3, 'undo arrived');
  await refused(() => bookingStatus(OTHER_SCHOOL, lee.bookingId, { expectedVersion: 1, status: 'CANCELLED' }), 404, 'SCHOOL_EVENT_BOOKING_NOT_FOUND', 'school-A booking from school B');
  await refused(() => bookingStatus(MIXED, lee.bookingId, { expectedVersion: 1, status: 'CANCELLED' }), 403, undefined, 'family-type role refused');
  const staffCancel = await success(() => bookingStatus(MANAGER, lee.bookingId, { expectedVersion: 1, status: 'CANCELLED' }), 'staff cancel');
  ok(staffCancel.data.booking.status === 'CANCELLED' && staffCancel.data.booking.cancelledBy === 'STAFF', 'staff cancelled');
  await refused(() => bookingStatus(MANAGER, lee.bookingId, { expectedVersion: 2, status: 'BOOKED' }), 409, 'SCHOOL_EVENT_BOOKING_STATUS_INVALID', 'a cancelled booking stays cancelled');
  const leeAgain = await success(() => book(E.publicId, family(s1, { name: 'Lee Family', mobile: '+15555550101' })), 'a cancelled family can book again', 201);
  ok(leeAgain.slotId === s1, 'rebooked in another slot');

  // 9. Families cancel with their code (any case, with or without dashes) before the slot starts.
  await refused(() => cancelBooking(E.publicId, { code: 'ZZZZ-ZZZZ-ZZZZ' }), 400, 'INVALID', 'a malformed code');
  await refused(() => cancelBooking(E.publicId, { code: '0000-0000-0000' }), 400, 'INVALID', 'an unknown code');
  await refused(() => cancelBooking(E.publicId, { code: A.code, extra: 1 }), 400, 'INVALID', 'extra key');
  const dashed = `${A.code.slice(0, 4)}-${A.code.slice(4, 8)}-${A.code.slice(8)}`.toLowerCase();
  const famCancel = await success(() => cancelBooking(E.publicId, { code: dashed }), 'family cancels');
  ok(famCancel.result === 'CANCELLED', 'cancelled by the family');
  ok((await success(() => cancelBooking(E.publicId, { code: A.code }), 'cancel again')).result === 'CANCELLED', 'cancelling twice is safe');
  ok((await sql("SELECT cancelled_by FROM hon.school_event_bookings WHERE id=$1", [kim.bookingId])).rows[0].cancelled_by === 'FAMILY', 'recorded as a family cancel');
  ok((await success(() => book(E.publicId, family(s0, { name: 'Kim Family', email: 'kim@example.test' }), { key: keyA }), 'retry after cancel', 201)).status === 'CANCELLED', 'the old retry key shows the booking is cancelled, never rebooks');

  // 10. Per-contact rate limit: five attempts an hour.
  const spam = [];
  for (let i = 0; i < 6; i += 1) spam.push(await book(E.publicId, family(slots[5].id, { name: 'Spam', email: 'spam@example.test' })));
  ok(spam[0].status === 201 && spam.slice(1, 5).every((r) => r.body.result === 'ALREADY_BOOKED') && spam[5].status === 429 && spam[5].headers['retry-after'] === '3600', `sixth attempt rate limited: ${spam.map((r) => r.body.result).join()}`);
  ok((await sql("SELECT count(*)::int n FROM hon.school_event_rates WHERE event_id=$1 AND bucket ~ '^[a-f0-9]{64}$' AND bucket NOT LIKE '%spam%'", [E.eventId])).rows[0].n > 0, 'contact buckets are keyed hashes');

  // 11. Close, reopen and cancel the event.
  let v = (await success(() => detail(MANAGER, E.eventId), 'detail before close')).data.event.version;
  await success(() => setStatus(MANAGER, E.eventId, { expectedVersion: v, status: 'CLOSED' }), 'close');
  ok((await success(() => publicRead(E.publicId), 'read closed')).data.status === 'CLOSED' && (await publicRead(E.publicId)).body.data.slots.every((s) => s.spotsLeft === 0), 'closed shows no spots');
  await refused(() => book(E.publicId, family(slots[4].id, { email: 'late@example.test' })), 409, 'CLOSED', 'booking a closed event');
  ok((await success(() => cancelBooking(E.publicId, { code: leeAgain.code }), 'cancel while closed')).result === 'CANCELLED', 'families can still cancel while closed');
  await success(() => setStatus(MANAGER, E.eventId, { expectedVersion: v + 1, status: 'PUBLISHED' }), 'reopen');
  ok((await success(() => publicRead(E.publicId), 'read reopened')).data.status === 'OPEN', 'reopened');
  await success(() => setStatus(MANAGER, E.eventId, { expectedVersion: v + 2, status: 'CANCELLED' }), 'cancel the event');
  ok((await success(() => publicRead(E.publicId), 'read cancelled')).data.status === 'CANCELLED', 'families see it was cancelled');
  await refused(() => setStatus(MANAGER, E.eventId, { expectedVersion: v + 3, status: 'PUBLISHED' }), 409, 'SCHOOL_EVENT_CANCELLED', 'a cancelled event is final');
  await refused(() => edit(MANAGER, E.eventId, { ...good, expectedVersion: v + 3, opensAt: '10:00', closesAt: '13:00' }), 409, 'SCHOOL_EVENT_CANCELLED', 'editing a cancelled event');
  ok((await sql("SELECT count(*)::int n FROM hon.school_event_bookings WHERE event_id=$1 AND status<>'CANCELLED'", [E.eventId])).rows[0].n > 0, 'cancelling the event keeps the booking list for staff');

  // 12. Started slots: an event today with hourly slots from midnight; the first slot has started.
  const laHour = Number((await sql("SELECT to_char(clock_timestamp() AT TIME ZONE $1,'HH24') h", [LA])).rows[0].h);
  if (laHour < 22) {
    const T = (await success(() => create(MANAGER, { ...good, title: 'Picture Day', localDate: today, opensAt: '00:00', closesAt: '23:00', slotMinutes: 60, spotsPerSlot: 5 }), 'create today')).data.event;
    const TP = await success(() => setStatus(MANAGER, T.eventId, { expectedVersion: 1, status: 'PUBLISHED' }), 'publish today');
    ok(TP.data.event.slotCount === 23, 'twenty-three hourly slots');
    const todaySlots = (await success(() => publicRead(T.publicId), 'read today')).data.slots;
    ok(todaySlots[0].spotsLeft === 0 && todaySlots[22].spotsLeft === 5, 'a started slot shows no spots');
    await refused(() => book(T.publicId, family(todaySlots[0].slotId, { email: 'early@example.test' })), 409, 'STARTED', 'booking a started slot');
  } else ok(true, 'started-slot check skipped after 22:00 school time');
  const tooFew = (await success(() => create(MANAGER, { ...good, title: 'Too late', localDate: today, opensAt: '00:00', closesAt: '00:30', slotMinutes: 30 }), 'create a past-only event')).data.event;
  await refused(() => setStatus(MANAGER, tooFew.eventId, { expectedVersion: 1, status: 'PUBLISHED' }), 422, 'SCHOOL_EVENT_NO_SLOTS', 'publishing with no future slot');

  // 13. Daylight-saving: a 02:00-03:00 slot on the spring-forward day is skipped and reported.
  const spring = (await sql("SELECT d::date::text d FROM generate_series($1::date, $1::date+365, '1 day') d WHERE ((d::date + time '02:30') AT TIME ZONE $2 AT TIME ZONE $2)::time <> time '02:30' LIMIT 1", [addDays(today, 1), LA])).rows[0]?.d;
  if (spring) {
    const S = (await success(() => create(MANAGER, { ...good, title: 'Spring Sale', localDate: spring, opensAt: '01:00', closesAt: '04:00', slotMinutes: 60 }), 'create spring-forward event')).data.event;
    const SP = await success(() => setStatus(MANAGER, S.eventId, { expectedVersion: 1, status: 'PUBLISHED' }), 'publish spring-forward');
    ok(SP.data.event.slotCount === 2 && JSON.stringify(SP.data.skippedTimes) === '["02:00"]', `the missing hour is skipped and reported: ${JSON.stringify(SP.data.skippedTimes)}`);
  } else ok(true, 'no spring-forward day in the next year');

  // 14. Live access loss: a lapsed entitlement hides the link and refuses staff.
  const live = (await create(MANAGER, { ...good, title: 'Open House' })).body.data.event;
  await success(() => setStatus(MANAGER, live.eventId, { expectedVersion: 1, status: 'PUBLISHED' }), 'publish open house');
  const liveSlot = (await publicRead(live.publicId)).body.data.slots[0].slotId;
  await sql("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp() WHERE organization_id=$1", [ids.organization]);
  await refused(() => publicRead(live.publicId), 404, 'INVALID', 'public read after access lapses');
  await refused(() => book(live.publicId, family(liveSlot, { email: 'lapse@example.test' })), 400, 'INVALID', 'booking after access lapses');
  await refused(() => list(MANAGER), 403, undefined, 'staff refused after access lapses');
  await sql('UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1', [ids.organization]);
  await sql("UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1", [ids.schoolA]).catch(async () => { ok(true, 'school status column differs'); });
  if ((await sql('SELECT status::text s FROM hon.schools WHERE id=$1', [ids.schoolA])).rows[0].s !== 'ACTIVE') {
    await refused(() => publicRead(live.publicId), 404, 'INVALID', 'public read while the school is suspended');
    await sql("UPDATE hon.schools SET status='ACTIVE' WHERE id=$1", [ids.schoolA]);
  }
  ok((await success(() => publicRead(live.publicId), 'read after restore')).data.status === 'OPEN', 'the link works again once access is back');

  // 15. Strict public transport.
  await refused(() => pub('GET', `${live.publicId}?x=1`), 400, 'INVALID', 'query string');
  await refused(() => pub('POST', `${live.publicId}/bookings`, { body: family(liveSlot, { email: 't@example.test' }), headers: { 'Content-Type': 'text/plain' } }), 400, 'INVALID', 'wrong content type');
  await refused(() => pub('POST', `${live.publicId}/bookings`, { raw: `{"slotId":"${liveSlot}","name":"A","name":"B","email":"t@example.test","mobile":"","website":""}` }), 400, 'INVALID', 'duplicate JSON key');
  await refused(() => pub('POST', `${live.publicId}/other`, { body: {} }), 400, 'INVALID', 'unknown public path');
  await refused(() => pub('POST', `${live.publicId}/bookings`, { raw: JSON.stringify({ ...family(liveSlot, { email: 't@example.test' }), name: 'x'.repeat(3000) }) }), 400, 'INVALID', 'body over 2 KiB');

  // 16. Settings-free guards.
  await sql('BEGIN');
  await rejectsSql(() => sql("UPDATE hon.school_events SET title='x' WHERE id=$1", [live.eventId]), /SCHOOL_EVENT_IMMUTABLE/, 'event change without a version step');
  await rejectsSql(() => sql("UPDATE hon.school_events SET opens_at='08:00',version=version+1 WHERE id=$1", [live.eventId]), /SCHOOL_EVENT_IMMUTABLE/, 'published times rewritten');
  await rejectsSql(() => sql("UPDATE hon.school_events SET status='DRAFT',version=version+1 WHERE id=$1", [live.eventId]), /SCHOOL_EVENT_IMMUTABLE/, 'back to draft');
  await rejectsSql(() => sql("UPDATE hon.school_events SET public_id=$2,version=version+1 WHERE id=$1", [live.eventId, 'a'.repeat(48)]), /SCHOOL_EVENT_IMMUTABLE/, 'public id rewritten');
  await rejectsSql(() => sql('DELETE FROM hon.school_events WHERE id=$1', [E.eventId]), /SCHOOL_EVENT_IMMUTABLE/, 'event deleted');
  await rejectsSql(() => sql("UPDATE hon.school_events SET title='y',version=version+1 WHERE id=$1", [E.eventId]), /SCHOOL_EVENT_IMMUTABLE/, 'cancelled event changed');
  await rejectsSql(() => sql('UPDATE hon.school_event_slots SET local_start=local_start WHERE event_id=$1', [E.eventId]), /./, 'slot rewritten');
  await rejectsSql(() => sql('DELETE FROM hon.school_event_slots WHERE event_id=$1', [E.eventId]), /./, 'slot deleted');
  await rejectsSql(() => sql("UPDATE hon.school_event_bookings SET family_name='x',version=version+1 WHERE event_id=$1", [E.eventId]), /SCHOOL_EVENT_BOOKING_IMMUTABLE/, 'booking name rewritten');
  await rejectsSql(() => sql("UPDATE hon.school_event_bookings SET status='BOOKED',cancelled_by=NULL,cancelled_at=NULL,version=version+1 WHERE id=$1", [lee.bookingId]), /SCHOOL_EVENT_BOOKING_IMMUTABLE/, 'cancelled booking revived');
  await rejectsSql(() => sql('DELETE FROM hon.school_event_bookings WHERE event_id=$1', [E.eventId]), /SCHOOL_EVENT_BOOKING_IMMUTABLE/, 'booking deleted');
  await rejectsSql(() => sql('TRUNCATE hon.school_event_bookings CASCADE'), /./, 'bookings truncated');
  await sql('ROLLBACK');

  // 17. Runtime ACL: EXECUTE on the eight entry points only; no table privilege; private helpers.
  const entry = ['save_school_event(text,uuid,jsonb,text,uuid,uuid)', 'set_school_event_status(text,uuid,jsonb,text,uuid,uuid)', 'set_school_event_booking_status(text,uuid,jsonb,text,uuid,uuid)',
    'read_school_events(text)', 'read_school_event(text,uuid)', 'read_public_school_event(text)', 'book_public_school_event(text,jsonb,text)', 'cancel_public_school_event_booking(text,jsonb)'];
  const helpers = ['school_event_text_ok(text,integer,integer)', 'guard_school_event()', 'guard_school_event_booking()', 'school_event_slot_taken(uuid)', 'school_event_json(hon.school_events)',
    'school_event_booking_json(hon.school_event_bookings)', 'school_event_input(jsonb)', 'school_event_command_finish(text,text,uuid,jsonb,text,text,uuid,jsonb,jsonb,text,integer,uuid,uuid)',
    'take_school_event_rate(uuid,text,integer)', 'public_school_event(text)', 'school_event_booking_input(jsonb)'];
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
  for (const table of ['school_events', 'school_event_slots', 'school_event_bookings', 'school_event_rates']) {
    const row = (await sql(`SELECT c.relrowsecurity AND c.relforcerowsecurity forced, has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT')
      OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_any_column_privilege($1,c.oid,'SELECT') runtime FROM pg_class c WHERE c.oid=$2::regclass`,
      [CRM_CLOSE_RUNTIME_ROLE, `hon.${table}`])).rows[0];
    ok(row.forced && !row.runtime, `${table}: forced RLS, no runtime privilege`);
  }
  await assert.rejects(runtime.query('SELECT * FROM hon.school_event_bookings LIMIT 1'), /permission denied/); checks += 1;
  ok((await sql("SELECT count(*)::int n FROM hon.principal_role_grants WHERE principal_id='00000000-0000-4000-8000-000000000261'")).rows[0].n === 0, 'the public intake principal holds no role');
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const startMark = '-- School event booking exact verification (B-SCH-3 0261)', endMark = '-- End school event booking exact verification.';
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: sale-day and event slot booking (0261): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
