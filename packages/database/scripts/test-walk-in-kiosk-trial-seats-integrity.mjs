/**
 * Walk-in kiosk pre-pilot fixes proof (WK5, 0538) on the guarded disposable CRM-close fixture only:
 *   P1 seats: a kiosk trial visitor holds a class seat for the staff booking API (through the new scoped runtime read
 *      hon.read_class_session_seats_taken, null outside the current school), parent bookings, ClassPass and owner-launch
 *      bookings, and a cancelled kiosk trial frees it again.
 *   P2 demo data: a trial offer never names a demo program, the settings read and tablet never list demo programs or demo
 *      classes, a demo class is refused at submit, and the migration refuses to run over settings that already name one.
 * Synthetic names and example.test contacts only; nothing is sent or charged.
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
const { WalkInKioskController, PublicWalkInKioskController } = await load('walk-in-kiosk/walk-in-kiosk.controller.js');
const { WalkInKioskService } = await load('walk-in-kiosk/walk-in-kiosk.service.js');
const { walkInKioskTransport } = await load('walk-in-kiosk/walk-in-kiosk-transport.js');
const { SchoolPayOnceService } = await load('school-payments/school-pay-once.service.js');
const { ClassBookingService } = await load('schedule/class-booking.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-walk-in-kiosk-seats', secret: randomBytes(32).toString('hex') };
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
    controllers: [WalkInKioskController, PublicWalkInKioskController],
    providers: [HonIdentityGuard, HonIdentityService, WalkInKioskService, { provide: RuntimeDatabaseService, useValue: database },
      // No processor here (0533 card payment has its own proof): the tablet offers the desk only.
      { provide: SchoolPayOnceService, useValue: new SchoolPayOnceService(database, new Map()) }],
  }).compile();
  app = module.createNestApplication({ logger: false, bodyParser: false });
  app.use(walkInKioskTransport());
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
const COMMAND = { settings: 'walkin_kiosk.settings.save', start: 'walkin_kiosk.device.start', end: 'walkin_kiosk.device.end', paid: 'walkin_kiosk.visit.desk_paid' };
function call(actor, method, path, { body, key = randomUUID(), command, headers = {}, school = actor.school, organization = actor.org } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/walk-in-kiosk${path}`);
  const sent = {
    Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`,
    Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json',
    ...(method === 'POST' ? { 'Content-Type': 'application/json', ...(command ? { 'X-Hon-Human-Command': command } : {}), ...(key ? { 'Idempotency-Key': key } : {}) } : {}),
    ...headers,
  };
  for (const [name, value] of Object.entries(sent)) if (value === undefined) delete sent[name];
  return send(target, method, sent, body === undefined ? undefined : JSON.stringify(body));
}
const overview = (actor, options = {}) => call(actor, 'GET', '', options);
const readSettings = (actor, options = {}) => call(actor, 'GET', '/settings', options);
const saveSettings = (actor, body, options = {}) => call(actor, 'POST', '/settings', { body, command: COMMAND.settings, ...options });
const startDevice = (actor, body, options = {}) => call(actor, 'POST', '/devices', { body, command: COMMAND.start, ...options });
const endDevice = (actor, id, body, options = {}) => call(actor, 'POST', `/devices/${id}/end`, { body, command: COMMAND.end, ...options });
const readVisit = (actor, id, options = {}) => call(actor, 'GET', `/visits/${id}`, options);
const deskPaid = (actor, id, body, options = {}) => call(actor, 'POST', `/visits/${id}/desk-paid`, { body, command: COMMAND.paid, ...options });

function tablet(path, { body, raw, key = randomBytes(18).toString('base64url'), headers = {} } = {}) {
  const sent = { Accept: 'application/json', 'Content-Type': 'application/json', Origin: origin, 'Sec-Fetch-Site': 'same-origin', ...(key ? { 'Idempotency-Key': key } : {}), ...headers };
  for (const [name, value] of Object.entries(sent)) if (value === undefined) delete sent[name];
  return send(new URL(`${origin}/v1/walk-in-kiosk/${path}`), 'POST', sent, raw ?? (body === undefined ? undefined : JSON.stringify(body)));
}
const terminal = (token, options = {}) => tablet('terminal', { body: { device: token }, key: null, ...options });
const submit = (token, visit, options = {}) => tablet('visits', { body: { device: token, visit }, ...options });

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
  ok(!('data' in body) && !('firstName' in body), `${label}: a refusal returns no data`);
}
async function rejectsSql(run, pattern, label) {
  await sql('SAVEPOINT expected_failure');
  try { await run(); } catch (error) { await sql('ROLLBACK TO SAVEPOINT expected_failure'); ok(pattern.test(error.message), `${label}: ${error.message}`); return; }
  await sql('ROLLBACK TO SAVEPOINT expected_failure');
  assert.fail(`${label}: expected a refusal`);
}

// Disposable-fixture cleanup only (as in the 0286 proof).
async function cleanup() {
  const tables = (await sql(`SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
    WHERE c.relnamespace='hon'::regnamespace AND c.relkind='r' ORDER BY 1`)).rows.map((row) => row.relname);
  await sql('BEGIN');
  try {
    await sql('SET CONSTRAINTS ALL IMMEDIATE');
    for (const table of ['walkin_kiosk_rates', 'walkin_visit_participants']) {
      const column = table === 'walkin_kiosk_rates' ? 'device_id' : 'visit_id';
      const parent = table === 'walkin_kiosk_rates' ? 'walkin_kiosk_devices' : 'walkin_visits';
      await sql(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);
      await sql(`DELETE FROM hon.${table} WHERE ${column} IN (SELECT id FROM hon.${parent} WHERE organization_id = ANY($1::uuid[]))`, [[ids.organization, ids.otherOrganization]]);
      await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);
    }
    for (let pass = 0; pass < 10; pass += 1) {
      let failed = 0;
      for (const table of tables) {
        await sql('SAVEPOINT cleanup_table');
        try {
          await sql(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);
          await sql(`DELETE FROM hon.${table} WHERE organization_id = ANY($1::uuid[])`, [[ids.organization, ids.otherOrganization]]);
          await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);
          await sql('RELEASE SAVEPOINT cleanup_table');
        } catch (error) { failed += 1; if (pass === 9) console.error('cleanup', table, error.message); await sql('ROLLBACK TO SAVEPOINT cleanup_table'); }
      }
      if (!failed) break;
    }
    const left = (await sql('SELECT count(*)::int n FROM hon.walkin_visits WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]])).rows[0].n;
    if (left) throw new Error('fixture cleanup left walk-ins behind');
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`walkin-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`walkin-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`walkin-${ids.organization}-%`]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `walkin-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Desk Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Desk Staff')", [principal, user]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID(); grants.push(grant);
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
  }
  return { subject, principal, org, school, grants };
}
let OWNER, DESK, NONE, MIXED, OTHER_SCHOOL, today, pipeline, stage, otherPipeline, otherStage;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Walk-in Org','Walk-in Org'),($2,'Walk-in Other Org','Walk-in Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Walk-in Dojo ${slug}`, `walkin-${slug}-${school.slice(0, 8)}`, LA]);
  }
  today = (await sql('SELECT (clock_timestamp() AT TIME ZONE $1)::date::text d', [LA])).rows[0].d;
  pipeline = randomUUID(); stage = randomUUID(); otherPipeline = randomUUID(); otherStage = randomUUID();
  await sql("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'New leads'),($4,$2,$5,'School B leads')", [pipeline, ids.organization, ids.schoolA, otherPipeline, ids.schoolB]);
  await sql("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'New',1),($5,$2,$6,$7,'New',1)",
    [stage, ids.organization, ids.schoolA, pipeline, otherStage, ids.schoolB, otherPipeline]);
  OWNER = await staff('owner', [await role(ids.organization, ['walkin_kiosk.manage', 'walkin_kiosk.run'])]);
  DESK = await staff('desk', [await role(ids.organization, ['walkin_kiosk.run'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read', 'crm.lead.read', 'kiosk.terminal.manage', 'classpass.manage'])]);
  MIXED = await staff('mixed', [await role(ids.organization, ['walkin_kiosk.manage', 'walkin_kiosk.run']), await role(ids.organization, ['people.read'], 'PARENT_PORTAL')]);
  OTHER_SCHOOL = await staff('other-school', [await role(ids.organization, allPermissions)], { school: ids.schoolB });
}
const WAIVER = { en: 'I understand martial arts training has risks.\nI agree to follow the instructors.', ko: '무술 훈련에는 위험이 있음을 이해합니다.' };
const OFFERS = [
  { key: 'day-pass', kind: 'DAY_PASS', name: { en: 'Day pass', ko: '1일 이용권', es: 'Pase de un día' }, description: { en: 'Train with us today.' }, priceMinor: 2500 },
  { key: 'free-trial', kind: 'TRIAL', name: { en: 'Free trial class' }, description: { en: '' }, priceMinor: 0 },
];
const goodSettings = () => ({ expectedVersion: 0, enabled: true, waiver: WAIVER, emergencyRequired: true, pipelineId: pipeline, pipelineStageId: stage, offers: OFFERS,
  thankYou: { en: 'Welcome to the dojo!', es: '¡Bienvenidos!' } });
const yearsAgo = (years, days = 0) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() - years); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const SIGNATURE = [[[10, 10], [200, 120], [400, 90]], [[500, 500], [520, 530]]];
let settingsVersion = 1;
const visitInput = (patch = {}) => ({
  settingsVersion, language: 'en',
  contact: { givenName: 'Alex', familyName: 'Rivera', email: 'alex@example.test', mobile: '+15555550101', birthDate: null, isParticipant: false, adultConfirmed: true },
  children: [{ givenName: 'Sam', familyName: 'Rivera', birthDate: yearsAgo(9) }], relationship: 'PARENT', emergency: { name: 'Jo Rivera', phone: '+15555550102' },
  heardFrom: 'FRIEND', marketingOptIn: false, offerKey: 'free-trial', waiver: { accepted: true, signerName: 'Alex Rivera', strokes: SIGNATURE }, website: '', ...patch,
});
const digest = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

const P = {};
const S = {};
async function program(key, school, status = 'SCHEDULED', org = ids.organization) {
  P[key] = randomUUID();
  await sql('INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,$4,$5)', [P[key], org, school, `Trial ${key}`, status]);
}
async function classSession(key, programKey, { hoursAhead, capacity = 10, status = 'SCHEDULED', school = ids.schoolA, org = ids.organization }) {
  S[key] = randomUUID();
  await sql(`INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status,cancellation_reason)
    VALUES($1,$2,$3,$4,$5,clock_timestamp()+make_interval(hours=>$6),clock_timestamp()+make_interval(hours=>$6+1),$7,'OPTIONAL_BOOKING',$8,$9)`,
  [S[key], org, school, P[programKey], `Class ${key}`, hoursAhead, capacity, status, status === 'CANCELLED' ? 'Proof' : null]);
}
async function booking(sessionKey, status = 'BOOKED') {
  const person = randomUUID(), student = randomUUID();
  await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Booked','Student')", [person, ids.organization, ids.schoolA]);
  await sql('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)', [student, ids.organization, ids.schoolA, person]);
  await sql(`INSERT INTO hon.class_bookings(organization_id,school_id,class_session_id,student_profile_id,booking_kind,status,source,cancelled_at)
    VALUES($1,$2,$3,$4,'REGULAR',$5::hon.class_booking_status,'STAFF',CASE WHEN $5::text='CANCELLED' THEN clock_timestamp() END)`, [ids.organization, ids.schoolA, S[sessionKey], student, status]);
}
const counts = async () => (await sql(`SELECT (SELECT count(*) FROM hon.walkin_visits WHERE organization_id=$1)::int visits, (SELECT count(*) FROM hon.crm_leads WHERE organization_id=$1)::int leads,
  (SELECT count(*) FROM hon.crm_appointments WHERE organization_id=$1)::int appointments, (SELECT count(*) FROM hon.people WHERE organization_id=$1)::int people,
  (SELECT count(*) FROM hon.audit_events WHERE organization_id=$1)::int audits, (SELECT count(*) FROM hon.outbox_events WHERE organization_id=$1)::int events`, [ids.organization])).rows[0];
const TRIAL = (programIds) => ({ key: 'trial-class', kind: 'TRIAL', name: { en: 'Free trial class', ko: '무료 체험 수업' }, description: { en: 'Pick a class.' }, priceMinor: 0, ...(programIds ? { programIds } : {}) });
const trialSettings = (expectedVersion, programIds) => ({ ...goodSettings(), expectedVersion, offers: [OFFERS[0], TRIAL(programIds)] });
const trialVisit = (sessionId, patch = {}) => visitInput({ offerKey: 'trial-class', trialSessionId: sessionId, ...patch });
const offerOf = (terminalBody, key) => terminalBody.data.offers.find(o => o.key === key);
const adultAndKids = (kids) => ({ contact: { givenName: 'Pat', familyName: 'Lee', email: `pat${randomUUID().slice(0, 6)}@example.test`, mobile: '', birthDate: yearsAgo(40), isParticipant: true, adultConfirmed: true },
  children: Array.from({ length: kids }, (_, i) => ({ givenName: `Kid${i}`, familyName: 'Lee', birthDate: yearsAgo(8 + i) })), relationship: kids ? 'PARENT' : null,
  waiver: { accepted: true, signerName: 'Pat Lee', strokes: SIGNATURE } });
const uniqueContact = () => ({ contact: { ...visitInput().contact, email: `p${randomUUID().slice(0, 8)}@example.test`, mobile: '' } });


async function markDemo(table, rowId) {
  // Disposable fixture only: register a row as demo data the way 0459 does (one LOADED set per school).
  await sql('ALTER TABLE hon.school_demo_data_sets DISABLE TRIGGER USER'); await sql('ALTER TABLE hon.school_demo_data_rows DISABLE TRIGGER USER');
  try {
    let set = (await sql("SELECT id FROM hon.school_demo_data_sets WHERE school_id=$1 AND status='LOADED'", [ids.schoolA])).rows[0]?.id;
    if (!set) { set = randomUUID(); await sql("INSERT INTO hon.school_demo_data_sets(id,organization_id,school_id,status,counts,loaded_by_principal_id) VALUES($1,$2,$3,'LOADED','{}'::jsonb,$4)", [set, ids.organization, ids.schoolA, OWNER.principal]); }
    await sql("INSERT INTO hon.school_demo_data_rows(table_name,row_id,set_id,organization_id,school_id,origin) VALUES($1,$2,$3,$4,$5,'LOADED')", [table, rowId, set, ids.organization, ids.schoolA]);
  } finally { await sql('ALTER TABLE hon.school_demo_data_sets ENABLE TRIGGER USER'); await sql('ALTER TABLE hon.school_demo_data_rows ENABLE TRIGGER USER'); }
}
async function student(label) {
  const person = randomUUID(), id = randomUUID();
  await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4,'Student')", [person, ids.organization, ids.schoolA, label]);
  await sql('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)', [id, ids.organization, ids.schoolA, person]);
  return id;
}
async function seatsAs(org, school, sessionId) {
  await runtime.query('BEGIN');
  try {
    await runtime.query("SELECT set_config('app.hon_organization_id',$1,true), set_config('app.hon_school_id',$2,true)", [org, school]);
    return (await runtime.query('SELECT hon.read_class_session_seats_taken($1::uuid) n', [sessionId])).rows[0].n;
  } finally { await runtime.query('ROLLBACK'); }
}
const bookingContext = (actor) => { const id = randomUUID(); return { organizationId: actor.org, schoolId: actor.school, principalId: actor.principal, externalSubject: actor.subject,
  principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: randomUUID() }; };
const migration = await readFile(resolve(repo, 'packages/database/migrations/0538_walk_in_kiosk_trial_seats_and_demo.sql'), 'utf8');
const preflight = migration.slice(migration.indexOf('DO $$ BEGIN'), migration.indexOf('END $$;') + 'END $$;'.length);

try {
  await cleanup();
  await seed();
  const BOOKER = await staff('booker', [await role(ids.organization, ['schedule.booking.manage'])]);
  await program('a', ids.schoolA); await program('demo', ids.schoolA); await program('b', ids.schoolB);
  await classSession('one', 'a', { hoursAhead: 26, capacity: 1 });
  await classSession('two', 'a', { hoursAhead: 30, capacity: 2 });
  await classSession('demoClass', 'a', { hoursAhead: 28, capacity: 5 });
  await classSession('demoProgramClass', 'demo', { hoursAhead: 32, capacity: 5 });
  await classSession('otherSchool', 'b', { hoursAhead: 30, school: ids.schoolB });
  await markDemo('programs', P.demo); await markDemo('class_sessions', S.demoClass); await markDemo('class_sessions', S.demoProgramClass);
  ok(preflight.includes('names a demo program') && preflight.length < 4000, 'preflight block found');
  await startApp();

  // 1. P2 settings: demo programs are not choices and cannot be named on a trial offer.
  const choices = await success(() => readSettings(OWNER), 'settings read');
  ok(JSON.stringify(choices.data.programs.map(p => p.programId)) === JSON.stringify([P.a]), 'the settings read leaves demo programs out');
  await success(() => saveSettings(OWNER, trialSettings(0, null)), 'first save');
  for (const [label, programIds] of [['only a demo program', [P.demo]], ['a demo program beside a real one', [P.a, P.demo]]]) {
    await refused(() => saveSettings(OWNER, trialSettings(1, programIds)), 400, undefined, `trial settings: ${label}`);
  }
  await success(() => saveSettings(OWNER, trialSettings(1, [P.a])), 'trial naming a real program');
  settingsVersion = 2;

  // 2. P2 tablet: demo classes are never listed and are refused at submit, writing nothing.
  const TOKEN = (await success(() => startDevice(DESK, { label: 'Front desk', hours: 8 }), 'start a tablet')).data.token;
  const listed = offerOf(await success(() => terminal(TOKEN), 'tablet read'), 'trial-class').classes.map(c => c.sessionId);
  ok(JSON.stringify(listed) === JSON.stringify([S.one, S.two]), `demo classes are not listed: ${listed}`);
  const before = await counts();
  await refused(() => submit(TOKEN, trialVisit(S.demoClass, uniqueContact())), 409, 'CLASS_FULL', 'a demo class');
  ok(JSON.stringify(await counts()) === JSON.stringify(before), 'a demo class writes nothing');

  // 2b. Closed days (0575): a trial class on a school-local date inside an ACTIVE block-out of this school is not listed on the
  //     tablet and is refused at submit with nothing written; another school's block-out changes nothing; removing it lists it again.
  await classSession('holiday', 'a', { hoursAhead: 24 * 5, capacity: 5 });
  const holidayDay = (await sql('SELECT (starts_at AT TIME ZONE $2)::date::text d FROM hon.class_sessions WHERE id=$1', [S.holiday, LA])).rows[0].d;
  const blockOut = async (school) => { const id = randomUUID();
    await sql("INSERT INTO hon.calendar_block_outs(id,organization_id,school_id,label,first_day,last_day,created_by_principal_id,updated_by_principal_id) VALUES($1,$2,$3,'Holiday break',$4::date,$4::date,$5,$5)",
      [id, ids.organization, school, holidayDay, OWNER.principal]); return id; };
  const tabletClasses = async (label) => offerOf(await success(() => terminal(TOKEN), label), 'trial-class').classes.map(c => c.sessionId);
  await blockOut(ids.schoolB);
  ok(JSON.stringify(await tabletClasses('tablet with another school closed')) === JSON.stringify([S.one, S.two, S.holiday]), 'another school closing that day hides nothing');
  const closedDay = await blockOut(ids.schoolA);
  ok(JSON.stringify(await tabletClasses('tablet on a closed day')) === JSON.stringify([S.one, S.two]), 'a trial class on a closed day is not listed');
  const beforeClosed = await counts();
  await refused(() => submit(TOKEN, trialVisit(S.holiday, uniqueContact())), 409, 'CLASS_FULL', 'a trial class on a closed day');
  ok(JSON.stringify(await counts()) === JSON.stringify(beforeClosed), 'a closed-day trial writes nothing');
  await sql("UPDATE hon.calendar_block_outs SET status='REMOVED',version=version+1 WHERE id=$1", [closedDay]);
  ok(JSON.stringify(await tabletClasses('tablet after reopening')) === JSON.stringify([S.one, S.two, S.holiday]), 'removing the block-out lists the class again');
  await sql("UPDATE hon.class_sessions SET status='CANCELLED',cancellation_reason='Proof' WHERE id=$1", [S.holiday]);

  // 3. P2 preflight: the migration refuses settings that already name a demo program (as a pre-0538 save could have).
  await sql('BEGIN');
  try {
    await sql('ALTER TABLE hon.walkin_kiosk_settings DISABLE TRIGGER USER');
    await sql(`UPDATE hon.walkin_kiosk_settings SET offers=jsonb_set(offers,'{1,programIds}',$2::jsonb) WHERE school_id=$1`, [ids.schoolA, JSON.stringify([P.a, P.demo])]);
    await rejectsSql(() => sql(preflight), /names a demo program/, 'preflight refuses a demo program on a trial offer');
  } finally { await sql('ROLLBACK'); }
  await sql(preflight); checks += 1;

  // 4. P1: a kiosk trial holds the only seat of 'one' for every booking path.
  const recorded = await success(() => submit(TOKEN, trialVisit(S.one, uniqueContact())), 'kiosk trial on the one-seat class', 201);
  ok(recorded.trialClass.sessionId === S.one, 'kiosk trial booked');
  ok((await sql('SELECT hon.parent_class_booking_seats($1) n', [S.one])).rows[0].n === 1, 'parent booking seats count the kiosk trial');
  ok(await seatsAs(ids.organization, ids.schoolA, S.one) === 1, 'the runtime seat read counts the kiosk trial');
  for (const [label, org, school, sessionId] of [['another school', ids.organization, ids.schoolB, S.one], ['another organization', ids.otherOrganization, ids.otherSchool, S.one],
    ['no school context', '', '', S.one], ['an unknown class', ids.organization, ids.schoolA, randomUUID()], ['a class of another school', ids.organization, ids.schoolA, S.otherSchool]]) {
    ok(await seatsAs(org, school, sessionId) === null, `the runtime seat read answers null for ${label}`);
  }
  const bookings = new ClassBookingService(database);
  const staffFirst = await bookings.create(bookingContext(BOOKER), S.one, { studentProfileId: await student('Waitlisted'), bookingKind: 'REGULAR' });
  ok(staffFirst.booking.status === 'WAITLISTED' && staffFirst.booking.activeSeatCount === 1 && staffFirst.created, `staff booking waitlists behind the kiosk trial: ${staffFirst.booking.status}`);
  // ClassPass and owner launch decide seats with the same helper under the same session lock (body pins below).
  for (const fn of ['command_classpass(text,text,uuid,jsonb,text,uuid,uuid)', 'book_owner_launch_first_class(text,jsonb,text,uuid,uuid)']) {
    const src = (await sql('SELECT prosrc FROM pg_proc WHERE oid=$1::regprocedure', [`hon.${fn}`])).rows[0].prosrc;
    ok(/seats:=hon\.walkin_session_taken\((session\.id|receipt\.class_session_id)\);/.test(src) && !/seats FROM hon\.class_bookings|count\(\*\) INTO seats/i.test(src), `${fn} counts kiosk trials`);
  }
  ok((await sql("SELECT prosrc FROM pg_proc WHERE oid='hon.parent_class_booking_seats(uuid)'::regprocedure")).rows[0].prosrc.trim().endsWith('\n  SELECT hon.walkin_session_taken(session);'), 'parent seats delegate');

  // 5. P1: the kiosk trial is cancelled, its seat frees and the staff API books.
  const visit = (await sql('SELECT * FROM hon.walkin_visits WHERE trial_session_id=$1', [S.one])).rows[0];
  await sql("UPDATE hon.crm_appointments SET status='CANCELLED', version=version+1 WHERE id=$1", [visit.trial_appointment_id]);
  ok(await seatsAs(ids.organization, ids.schoolA, S.one) === 0, 'a cancelled kiosk trial frees its seat');
  const staffSecond = await bookings.create(bookingContext(BOOKER), S.one, { studentProfileId: await student('Booked'), bookingKind: 'REGULAR' });
  ok(staffSecond.booking.status === 'BOOKED' && staffSecond.booking.activeSeatCount === 1, 'staff booking takes the freed seat');
  ok(await seatsAs(ids.organization, ids.schoolA, S.one) === 1 && (await sql('SELECT hon.parent_class_booking_seats($1) n', [S.one])).rows[0].n === 1, 'staff booking counted once');
  await refused(() => submit(TOKEN, trialVisit(S.one, uniqueContact())), 409, 'CLASS_FULL', 'the kiosk sees the staff booking');

  // 6. P1 race: the kiosk and the staff API race for the last seat of 'two' (one already booked); exactly one wins.
  await booking('two', 'BOOKED');
  const raced = await Promise.allSettled([submit(TOKEN, trialVisit(S.two, uniqueContact())),
    bookings.create(bookingContext(BOOKER), S.two, { studentProfileId: await student('Racer'), bookingKind: 'REGULAR' })]);
  const kioskWon = raced[0].status === 'fulfilled' && raced[0].value.status === 201;
  const staffWon = raced[1].status === 'fulfilled' && raced[1].value.booking.status === 'BOOKED';
  ok(kioskWon !== staffWon && raced[1].status === 'fulfilled' && (kioskWon ? raced[1].value.booking.status === 'WAITLISTED' : raced[0].value.body.result === 'CLASS_FULL'),
    `one of the kiosk and staff wins the last seat: kiosk ${kioskWon}, staff ${staffWon}`);
  ok(await seatsAs(ids.organization, ids.schoolA, S.two) === 2, 'the class is exactly full');

  // 7. ACL: one new runtime read, every helper private, demo rows unreadable, 011 sections.
  { const row = (await sql(`SELECT has_function_privilege($1,p.oid,'EXECUTE') runtime, p.prosecdef definer, p.provolatile v,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid='hon.read_class_session_seats_taken(uuid)'::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE])).rows[0];
    ok(row.runtime && row.definer && row.v === 's' && !row.public, 'the seat read is a stable definer the runtime alone may call'); }
  for (const fn of ['walkin_session_taken(uuid)', 'parent_class_booking_seats(uuid)', 'walkin_trial_session_open(hon.class_sessions,jsonb,integer)', 'walkin_trial_classes(uuid,uuid,jsonb)', 'walkin_settings_input(jsonb)']) {
    ok(!(await sql("SELECT has_function_privilege($1,$2,'EXECUTE') r", [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0].r, `helper ${fn} is private`);
  }
  await assert.rejects(runtime.query('SELECT 1 FROM hon.school_demo_data_rows LIMIT 1'), /permission denied/); checks += 1;
  const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
  for (const [startMark, endMark] of [['-- Walk-in kiosk trial seats exact verification (0538)', '-- End walk-in kiosk trial seats exact verification.'],
    ['-- Walk-in kiosk trial class exact verification (0537)', '-- End walk-in kiosk trial class exact verification.'],
    ['-- Parent class booking exact verification (0329)', '-- End parent class booking exact verification.'],
    ['-- Closed days for families exact verification (0575)', '-- End closed days for families exact verification.']]) {
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1;
  }

  console.log(`PASS: walk-in kiosk trial seats and demo programs (0538): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
