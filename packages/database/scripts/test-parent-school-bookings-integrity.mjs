/**
 * Parent school bookings proof (0431) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guards ->
 * ParentSchoolBookingController -> protected definer functions on the restricted runtime role with forced RLS), on the
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
const { ParentSchoolBookingController, ParentSchoolBookingReadGuard, ParentSchoolBookingBookGuard, ParentSchoolBookingCancelGuard } = await load('families/parent-school-bookings.controller.js');
const { ParentSchoolBookingService } = await load('families/parent-school-bookings.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-parent-school-bookings', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'school', 'otherSchool', 'family', 'otherFamily', 'staff']
  .map((key) => [key, randomUUID()]));
const PREFIX = `psbook-${ids.organization}`;
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [ParentSchoolBookingController],
    providers: [HonIdentityGuard, HonIdentityService, ParentSchoolBookingService, ParentSchoolBookingReadGuard, ParentSchoolBookingBookGuard, ParentSchoolBookingCancelGuard,
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
const COMMAND = { book: 'parent.school_booking.book', cancel: 'parent.school_booking.cancel' };
function call(actor, method, path, { body, key = randomUUID(), command, headers = {} } = {}) {
  const target = new URL(`${origin}/v1/parent/school-bookings${path}`);
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
const bookSlot = (actor, body, options = {}) => call(actor, 'POST', '/event-slots', { body, command: COMMAND.book, ...options });
const bookType = (actor, body, options = {}) => call(actor, 'POST', '/booking-types', { body, command: COMMAND.book, ...options });
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
    await sql('DELETE FROM hon.principals WHERE id=$1', [ids.staff]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

async function person(label, email) {
  const user = randomUUID(), principal = randomUUID(), subject = `${PREFIX}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Parent')", [user, subject, email ?? `${label}-${user.slice(0, 8)}@Example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Parent')", [principal, user]);
  const stored = (await sql('SELECT lower(email::text) e FROM hon.users WHERE id=$1', [user])).rows[0].e;
  return { subject, principal, email: stored };
}
async function grant(actor, family, level, { school = ids.school, org = ids.organization } = {}) {
  await sql("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day',$4)",
    [org, school, family, actor.principal, level]);
}
// Seeds follow the guarded lifecycles: created as DRAFT version 1, then published or activated as version 2.
async function event(title, slots, { spots = 2, publish = true, school = ids.school, org = ids.organization } = {}) {
  const id = randomUUID();
  await sql(`INSERT INTO hon.school_events(id,organization_id,school_id,title,local_date,opens_at,closes_at,slot_minutes,spots_per_slot,actor_principal_id)
    VALUES($1,$2,$3,$4,(clock_timestamp() AT TIME ZONE $5)::date+1,'09:00','12:00',30,$6,$7)`, [id, org, school, title, LA, spots, ids.staff]);
  const out = { id, slots: [] };
  for (const [position, hours] of slots.entries()) {
    const slot = randomUUID();
    await sql(`INSERT INTO hon.school_event_slots(id,event_id,organization_id,school_id,position,local_start,local_end,starts_at,ends_at)
      VALUES($1,$2,$3,$4,$7,make_time(9+$5/2,($5%2)*30,0),make_time(9+$5/2,($5%2)*30,0)+interval '30 minutes',
        date_trunc('minute',clock_timestamp())+make_interval(hours=>$6),date_trunc('minute',clock_timestamp())+make_interval(hours=>$6)+interval '30 minutes')`,
      [slot, id, org, school, position, hours, position]);
    out.slots.push(slot);
  }
  if (publish) await sql("UPDATE hon.school_events SET status='PUBLISHED',version=2 WHERE id=$1", [id]);
  return out;
}
const QUESTIONS = [{ label: 'Current belt', kind: 'TEXT', required: true }, { label: 'First test?', kind: 'YES_NO', required: false }];
async function bookingType(name, { audience = 'FAMILIES_ONLY', status = 'ACTIVE', spots = 1, waiver = 'I accept the testing rules.', questions = QUESTIONS } = {}) {
  const id = randomUUID();
  const hours = JSON.stringify([1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '00:00', end: '23:30' })));
  await sql(`INSERT INTO hon.school_booking_types(id,organization_id,school_id,name,template,duration_minutes,spots_per_time,weekly_hours,horizon_days,notice_hours,audience,questions,waiver,thank_you,actor_principal_id)
    VALUES($1,$2,$3,$4,'TEST_RESERVATION',30,$5,$6::jsonb,3,2,$7,$8::jsonb,$9,'See you there!',$10)`,
    [id, ids.organization, ids.school, name, spots, hours, audience, JSON.stringify(questions), waiver, ids.staff]);
  if (status !== 'DRAFT') await sql('UPDATE hon.school_booking_types SET status=$2,version=2 WHERE id=$1', [id, status]);
  return id;
}

let GUARDIAN, SECOND, VIEWER, OUTSIDER, OTHER, NOMAIL, E, T;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Parent Org','Parent Org'),($2,'Parent Other Org','Parent Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5),($6,$2,$7,$8,$5)',
    [ids.school, ids.organization, 'Parent Dojo', `psbook-a-${ids.school.slice(0, 8)}`, LA, ids.otherSchool, 'Parent Dojo B', `psbook-b-${ids.otherSchool.slice(0, 8)}`]);
  await sql("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'Kim Family'),($4,$2,$3,'Park Family')", [ids.family, ids.organization, ids.school, ids.otherFamily]);
  await sql("INSERT INTO hon.principals(id,principal_type,display_name) VALUES($1,'SYSTEM_SERVICE','Seed staff')", [ids.staff]);
  GUARDIAN = await person('guardian'); SECOND = await person('second'); VIEWER = await person('viewer'); OUTSIDER = await person('outsider');
  OTHER = await person('other'); NOMAIL = await person('nomail', 'not-an-email');
  await grant(GUARDIAN, ids.family, 'PRIMARY_GUARDIAN'); await grant(SECOND, ids.family, 'SECONDARY_GUARDIAN'); await grant(VIEWER, ids.family, 'VIEWER');
  await grant(OTHER, ids.otherFamily, 'PRIMARY_GUARDIAN'); await grant(NOMAIL, ids.otherFamily, 'SECONDARY_GUARDIAN');
  E = {
    sale: await event('Black Friday Sale', [-2, 30, 31]),
    tiny: await event('Open House', [40], { spots: 1 }),
    draft: await event('Draft Day', [50], { publish: false }),
    past: await event('Yesterday Sale', [-5]),
    elsewhere: await event('Other School Day', [30], { school: ids.otherSchool }),
  };
  T = {
    test: await bookingType('Belt test reservation'),
    open: await bookingType('Open trial', { audience: 'OPEN' }),
    paused: await bookingType('Paused meeting', { status: 'PAUSED' }),
    plain: await bookingType('Parent meeting', { questions: [], waiver: '', spots: 2 }),
  };
}

try {
  await cleanup();
  await seed();
  await startApp();

  // 1. Choices: published events with slots still to start, active families-only types with open times, the account's details.
  const first = (await success(() => choices(GUARDIAN), 'choices by a guardian')).data;
  ok(first.canBook === true && first.timezone === LA, 'guardian can book; school time zone');
  ok(first.contact?.name === 'Kim Family' && first.contact?.email === GUARDIAN.email, 'details come from the family and the sign-in email');
  ok(first.events.map((e) => e.eventId).sort().join() === [E.sale.id, E.tiny.id].sort().join(), 'only published events of this school with a slot still to start');
  const sale = first.events.find((e) => e.eventId === E.sale.id);
  ok(sale.slots.length === 2 && sale.slots.every((s) => s.spotsLeft === 2) && !sale.slots.some((s) => s.slotId === E.sale.slots[0]) && sale.bookingId === null, 'started slots are hidden; open spots only');
  ok(first.bookingTypes.map((t) => t.typeId).sort().join() === [T.test, T.plain].sort().join(), 'only active families-only booking types');
  const testType = first.bookingTypes.find((t) => t.typeId === T.test);
  ok(testType.times.length > 0 && testType.questions.length === 2 && testType.waiver !== '' && testType.times.every((t) => t.spotsLeft === 1), 'types carry their questions, waiver and open times');
  ok(first.bookings.length === 0, 'no bookings yet');
  const viewerRead = (await success(() => choices(VIEWER), 'choices by a viewer')).data;
  ok(viewerRead.canBook === false && viewerRead.events.length === 2, 'a viewer reads but cannot book');
  ok((await success(() => choices(NOMAIL), 'choices without a usable email')).data.canBook === false, 'no usable email means no booking from the account');
  await refused(() => choices(OUTSIDER), 403, 'PARENT_SCHOOL_BOOKING_FORBIDDEN', 'no family grant');
  await refused(() => call(GUARDIAN, 'GET', '?schoolId=x'), 400, 'PARENT_SCHOOL_BOOKING_SELECTORS_NOT_ACCEPTED', 'no selector is accepted');

  // 2. Book an event slot: closed body, guardian only, offered slot, exact replay, one per family per event.
  const slot = E.sale.slots[1];
  for (const [label, body] of [['missing slot', {}], ['extra key', { slotId: slot, name: 'Someone' }], ['bad id', { slotId: 'x' }], ['upper-case id', { slotId: slot.toUpperCase() }]]) {
    await refused(() => bookSlot(GUARDIAN, body), 400, 'VALIDATION_FAILED', `slot validation: ${label}`);
  }
  await refused(() => bookSlot(GUARDIAN, { slotId: slot }, { key: null }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'book without a key');
  await refused(() => bookSlot(GUARDIAN, { slotId: slot }, { command: COMMAND.cancel }), 403, 'HUMAN_UI_REQUIRED', 'book under the cancel command');
  await refused(() => bookSlot(GUARDIAN, { slotId: slot }, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-site book');
  await refused(() => bookSlot(VIEWER, { slotId: slot }), 403, 'PARENT_SCHOOL_BOOKING_FORBIDDEN', 'a viewer cannot book');
  await refused(() => bookSlot(NOMAIL, { slotId: slot }), 422, 'PARENT_SCHOOL_BOOKING_NO_CONTACT', 'no usable email');
  for (const [label, id] of [['started', E.sale.slots[0]], ['draft event', E.draft.slots[0]], ['other school', E.elsewhere.slots[0]], ['unknown', randomUUID()]]) {
    await refused(() => bookSlot(GUARDIAN, { slotId: id }), 409, 'PARENT_SCHOOL_BOOKING_NOT_OFFERED', `slot not offered: ${label}`);
  }
  const key = randomUUID();
  const made = await success(() => bookSlot(GUARDIAN, { slotId: slot }, { key }), 'guardian books a slot', 201);
  const B = made.data.booking;
  ok(B.kind === 'EVENT' && B.parentId === E.sale.id && B.title === 'Black Friday Sale' && B.status === 'BOOKED' && B.version === 1 && B.canCancel && made.data.spotsLeft === 1 && made.meta.replayed === false, 'slot booked from the account');
  const replay = await success(() => bookSlot(GUARDIAN, { slotId: slot }, { key }), 'slot replay');
  ok(replay.meta.replayed === true && JSON.stringify(replay.data) === JSON.stringify(made.data), 'exact replay returns the same receipt');
  await refused(() => bookSlot(GUARDIAN, { slotId: E.sale.slots[2] }, { key }), 409, 'IDEMPOTENCY_KEY_REUSED', 'key reused for another slot');
  await refused(() => bookSlot(SECOND, { slotId: E.sale.slots[2] }), 409, 'PARENT_SCHOOL_BOOKING_ALREADY_BOOKED', 'one live booking per family per event');
  const row = (await sql('SELECT family_name,email,mobile,status FROM hon.school_event_bookings WHERE id=$1', [B.bookingId])).rows[0];
  ok(row.family_name === 'Kim Family' && row.email === GUARDIAN.email && row.mobile === null && row.status === 'BOOKED', 'stored in the 0261 table with the account details');
  ok((await sql("SELECT count(*)::int n FROM hon.parent_school_bookings WHERE event_booking_id=$1 AND family_id=$2 AND principal_id=$3 AND kind='EVENT'", [B.bookingId, ids.family, GUARDIAN.principal])).rows[0].n === 1, 'the account link is recorded');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='schedule.event.booking.parent_create' AND source='HUMAN_UI' AND actor_principal_id=$2", [B.bookingId, GUARDIAN.principal])).rows[0].n === 1
    && (await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='schedule.event.booking_created' AND payload::text NOT LIKE '%Kim%' AND payload::text NOT LIKE '%@%' AND payload->>'internalOnly'='true'", [B.bookingId])).rows[0].n === 1,
    'one audit row and one inert outbox event with ids only');
  // The public one-booking-per-email rule applies too: a link booking with this email blocks the account booking.
  await sql(`INSERT INTO hon.school_event_bookings(event_id,slot_id,organization_id,school_id,family_name,email,key_hash,payload_hash,code_hash)
    VALUES($1,$2,$3,$4,'Kim Family',$5,repeat('a',64),repeat('b',64),repeat('c',64))`, [E.tiny.id, E.tiny.slots[0], ids.organization, ids.school, SECOND.email]);
  await refused(() => bookSlot(SECOND, { slotId: E.tiny.slots[0] }), 409, 'PARENT_SCHOOL_BOOKING_ALREADY_BOOKED', 'the same email already booked through the link');
  await sql("UPDATE hon.school_event_bookings SET status='CANCELLED',cancelled_by='STAFF',cancelled_at=clock_timestamp(),version=2 WHERE event_id=$1", [E.tiny.id]);

  // 3. The last spot under the slot lock: two families race.
  const race = await Promise.all([bookSlot(GUARDIAN, { slotId: E.tiny.slots[0] }), bookSlot(OTHER, { slotId: E.tiny.slots[0] })]);
  ok(race.filter((r) => r.status === 201).length === 1 && race.filter((r) => r.status === 409 && r.body.code === 'PARENT_SCHOOL_BOOKING_FULL').length === 1, 'one winner for the last spot');
  ok((await sql("SELECT count(*)::int n FROM hon.school_event_bookings WHERE slot_id=$1 AND status<>'CANCELLED'", [E.tiny.slots[0]])).rows[0].n === 1, 'spots never passed');
  // Two guardians of one family race for two slots of one event: the family lock lets one through.
  const pair = await event('Sparring Day', [60, 61], { spots: 5 });
  const twins = await Promise.all([bookSlot(GUARDIAN, { slotId: pair.slots[0] }), bookSlot(SECOND, { slotId: pair.slots[1] })]);
  ok(twins.filter((r) => r.status === 201).length === 1 && twins.filter((r) => r.status === 409 && r.body.code === 'PARENT_SCHOOL_BOOKING_ALREADY_BOOKED').length === 1, 'one booking per family per event under concurrency');

  // 4. Book a families-only type: answers and waiver by the 0286 rule, offered times only, one future booking per family per type.
  const time = testType.times[0].startsAt, other = testType.times[1].startsAt;
  const good = { typeId: T.test, startsAt: time, answers: ['Yellow', true], waiverAccepted: true };
  for (const [label, body] of [['missing answer', { ...good, answers: ['Yellow'] }], ['required text empty', { ...good, answers: ['', true] }],
    ['waiver not accepted', { ...good, waiverAccepted: false }], ['extra key', { ...good, email: 'x@example.test' }], ['seconds in time', { ...good, startsAt: time.replace(':00.000Z', ':30.000Z') }]]) {
    await refused(() => bookType(GUARDIAN, body), 400, 'VALIDATION_FAILED', `type validation: ${label}`);
  }
  await refused(() => bookType(GUARDIAN, { ...good, startsAt: new Date(Date.now() + 3600_000 * 24 * 10).toISOString().slice(0, 14) + '00:00.000Z' }), 409, 'PARENT_SCHOOL_BOOKING_NOT_OFFERED', 'a time beyond the horizon');
  await refused(() => bookType(GUARDIAN, { ...good, typeId: T.open }), 409, 'PARENT_SCHOOL_BOOKING_NOT_OFFERED', 'an open type books through its link');
  await refused(() => bookType(GUARDIAN, { ...good, typeId: T.paused }), 409, 'PARENT_SCHOOL_BOOKING_NOT_OFFERED', 'a paused type');
  const typeMade = await success(() => bookType(GUARDIAN, good), 'guardian books a type time', 201);
  const TB = typeMade.data.booking;
  ok(TB.kind === 'BOOKING_TYPE' && TB.parentId === T.test && TB.startsAt === time && TB.status === 'BOOKED' && typeMade.data.spotsLeft === 0, 'type time booked from the account');
  const typeRow = (await sql('SELECT family_name,email,answers,waiver_accepted_at IS NOT NULL w FROM hon.school_booking_type_bookings WHERE id=$1', [TB.bookingId])).rows[0];
  ok(typeRow.family_name === 'Kim Family' && typeRow.email === GUARDIAN.email && JSON.stringify(typeRow.answers) === '["Yellow",true]' && typeRow.w, 'answers and waiver time stored with the account details');
  await refused(() => bookType(SECOND, { ...good, startsAt: other }), 409, 'PARENT_SCHOOL_BOOKING_ALREADY_BOOKED', 'one future booking per family per type');
  await refused(() => bookType(OTHER, good), 409, 'PARENT_SCHOOL_BOOKING_FULL', 'the time is full');
  ok((await success(() => bookType(OTHER, { typeId: T.plain, startsAt: first.bookingTypes.find((t) => t.typeId === T.plain).times[0].startsAt, answers: [], waiverAccepted: false }), 'another family books a plain type', 201)).data.spotsLeft === 1, 'no questions and no waiver');
  const listed = (await success(() => choices(GUARDIAN), 'choices after booking')).data;
  ok([3, 4].includes(listed.bookings.length) && listed.bookings.some((b) => b.bookingId === B.bookingId) && listed.bookings.some((b) => b.bookingId === TB.bookingId), 'the family sees its own bookings');
  ok(listed.events.find((e) => e.eventId === E.sale.id).bookingId === B.bookingId && listed.bookingTypes.find((t) => t.typeId === T.test).bookingId === TB.bookingId, 'choices point at the family booking');
  ok(!JSON.stringify(listed).includes('Park Family') && !JSON.stringify(listed).includes(OTHER.email), 'no other family is visible');

  // 5. Cancel: guardian only, own account booking, exact version, before the start.
  await refused(() => cancel(VIEWER, B.bookingId, { expectedVersion: 1 }), 403, 'PARENT_SCHOOL_BOOKING_FORBIDDEN', 'a viewer cannot cancel');
  await refused(() => cancel(GUARDIAN, B.bookingId, { expectedVersion: 1, reason: 'x' }), 400, 'VALIDATION_FAILED', 'cancel with an extra key');
  await refused(() => cancel(GUARDIAN, B.bookingId, { expectedVersion: 2 }), 409, 'VERSION_CONFLICT', 'cancel at a stale version');
  const linkOnly = (await sql('SELECT id FROM hon.school_event_bookings WHERE event_id=$1 AND email=$2', [E.tiny.id, SECOND.email])).rows[0].id;
  await refused(() => cancel(GUARDIAN, linkOnly, { expectedVersion: 2 }), 404, 'PARENT_SCHOOL_BOOKING_NOT_FOUND', 'a booking made through the link is not the account\'s');
  const otherFamilyBooking = (await sql("SELECT type_booking_id id FROM hon.parent_school_bookings WHERE family_id=$1 AND kind='BOOKING_TYPE'", [ids.otherFamily])).rows[0].id;
  await refused(() => cancel(GUARDIAN, otherFamilyBooking, { expectedVersion: 1 }), 404, 'PARENT_SCHOOL_BOOKING_NOT_FOUND', 'another family\'s booking');
  const startedBooking = randomUUID();
  await sql(`INSERT INTO hon.school_event_bookings(id,event_id,slot_id,organization_id,school_id,family_name,email,key_hash,payload_hash,code_hash)
    VALUES($1,$2,$3,$4,$5,'Kim Family',$6,repeat('d',64),repeat('e',64),repeat('f',64))`, [startedBooking, E.past.id, E.past.slots[0], ids.organization, ids.school, GUARDIAN.email]);
  await sql("INSERT INTO hon.parent_school_bookings(organization_id,school_id,family_id,principal_id,kind,event_booking_id) VALUES($1,$2,$3,$4,'EVENT',$5)", [ids.organization, ids.school, ids.family, GUARDIAN.principal, startedBooking]);
  await refused(() => cancel(GUARDIAN, startedBooking, { expectedVersion: 1 }), 409, 'PARENT_SCHOOL_BOOKING_NOT_CANCELLABLE', 'a started booking cannot be cancelled');
  const cancelKey = randomUUID();
  const gone = await success(() => cancel(SECOND, B.bookingId, { expectedVersion: 1 }, { key: cancelKey }), 'the other guardian cancels');
  ok(gone.data.booking.status === 'CANCELLED' && gone.data.booking.version === 2 && !gone.data.booking.canCancel && gone.data.spotsLeft === 2, 'cancelled and the spot is free');
  ok((await success(() => cancel(SECOND, B.bookingId, { expectedVersion: 1 }, { key: cancelKey }), 'cancel replay')).meta.replayed === true, 'cancel replay');
  ok((await sql("SELECT cancelled_by FROM hon.school_event_bookings WHERE id=$1", [B.bookingId])).rows[0].cancelled_by === 'FAMILY', 'cancelled by the family');
  ok((await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='schedule.event.booking_cancelled'", [B.bookingId])).rows[0].n === 1, 'one cancel event');
  const typeGone = await success(() => cancel(GUARDIAN, TB.bookingId, { expectedVersion: 1 }), 'cancel the type booking');
  ok(typeGone.data.booking.status === 'CANCELLED' && typeGone.data.spotsLeft === 1, 'type booking cancelled');
  ok((await success(() => bookSlot(SECOND, { slotId: E.sale.slots[2] }), 'book the event again after cancelling', 201)).data.booking.status === 'BOOKED', 'the family can book the event again');

  // 6. Live authority and immutability.
  await sql("UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1", [ids.school]);
  await refused(() => choices(GUARDIAN), 403, 'PARENT_SCHOOL_BOOKING_FORBIDDEN', 'suspended school read');
  await refused(() => bookType(GUARDIAN, good), 403, 'PARENT_SCHOOL_BOOKING_FORBIDDEN', 'suspended school book');
  await sql("UPDATE hon.schools SET status='ACTIVE' WHERE id=$1", [ids.school]);
  await sql("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp()-interval '1 minute', effective_from=clock_timestamp()-interval '2 days' WHERE organization_id=$1", [ids.organization]);
  await refused(() => bookType(GUARDIAN, good), 403, 'PARENT_SCHOOL_BOOKING_FORBIDDEN', 'lapsed entitlement');
  await sql('UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1', [ids.organization]);
  await assert.rejects(sql("UPDATE hon.parent_school_bookings SET principal_id=$1 WHERE family_id=$2", [SECOND.principal, ids.family]), /PARENT_SCHOOL_BOOKING_IMMUTABLE/); checks += 1;
  await assert.rejects(sql('DELETE FROM hon.parent_school_bookings WHERE family_id=$1', [ids.family]), /PARENT_SCHOOL_BOOKING_IMMUTABLE/); checks += 1;
  await assert.rejects(sql("INSERT INTO hon.parent_school_bookings(organization_id,school_id,family_id,principal_id,kind,type_booking_id) VALUES($1,$2,$3,$4,'BOOKING_TYPE',$5)",
    [ids.organization, ids.otherSchool, ids.family, GUARDIAN.principal, TB.bookingId])); checks += 1;
  ok((await success(() => bookType(GUARDIAN, { ...good, startsAt: other }), 'book again once access is live', 201)).data.booking.status === 'BOOKED', 'booking works again once access is live');

  // 7. Database boundary: definer entry points only; helpers and the table private.
  const entry = ['read_parent_school_bookings(text)', 'book_parent_school_event_slot(text,jsonb,text,uuid,uuid)', 'book_parent_school_booking_type(text,jsonb,text,uuid,uuid)',
    'cancel_parent_school_booking(text,jsonb,text,uuid,uuid)'];
  const helpers = ['guard_parent_school_booking()', 'parent_school_booking_contact(uuid,uuid)', 'parent_school_booking_json(text,uuid)', 'parent_school_booking_live(uuid,text,uuid)',
    'parent_school_booking_finish(text,text,uuid,uuid,text,uuid,jsonb,text,text,jsonb,jsonb,integer,uuid,uuid)', 'parent_school_booking_lock(text)'];
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
  const table = (await sql(`SELECT c.relrowsecurity r, c.relforcerowsecurity f, has_table_privilege($1,'hon.parent_school_bookings','SELECT,INSERT,UPDATE,DELETE') t
    FROM pg_class c WHERE c.oid='hon.parent_school_bookings'::regclass`, [CRM_CLOSE_RUNTIME_ROLE])).rows[0];
  ok(table.r && table.f && !table.t, 'the link table is forced-RLS and private');
  await assert.rejects(runtime.query('SELECT 1 FROM hon.parent_school_bookings')); checks += 1;
  await assert.rejects(runtime.query("SELECT hon.book_parent_school_event_slot($1,'{}'::jsonb,'k',gen_random_uuid(),gen_random_uuid())", [GUARDIAN.subject])); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const startMark = '-- Parent school bookings exact verification (0431)', endMark = '-- End parent school bookings exact verification.';
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: parent school bookings (0431): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch(() => {});
  await admin.end();
  await runtime.end();
}
