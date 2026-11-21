/**
 * Walk-in kiosk trial class proof (WK4, 0537) over signed HTTP for staff and the strict tablet transport, on the guarded
 * disposable CRM-close fixture only: trial offers that name programs, the tablet's next classes with open spots, the class a
 * visit must pick, CLASS_FULL (nothing written) for a full, started, foreign or other-program class, the CRM trial the kiosk
 * books (0043 shape), seats held by kiosk trials, a race for the last spot, the staff visit read, the guards and the ACL.
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

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-walk-in-kiosk-trial', secret: randomBytes(32).toString('hex') };
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

try {
  await cleanup();
  await seed();
  await program('a', ids.schoolA); await program('b', ids.schoolA); await program('draft', ids.schoolA, 'DRAFT');
  await program('gone', ids.schoolA, 'CANCELLED'); await program('otherSchool', ids.schoolB);
  await classSession('soon', 'a', { hoursAhead: 26, capacity: 2 });
  await classSession('later', 'a', { hoursAhead: 50, capacity: 3 });
  await classSession('race', 'a', { hoursAhead: 74, capacity: 1 });
  await classSession('draftClass', 'draft', { hoursAhead: 30, capacity: 5 });
  await classSession('otherProgram', 'b', { hoursAhead: 28 });
  await classSession('started', 'a', { hoursAhead: -1 });
  await classSession('far', 'a', { hoursAhead: 24 * 15 });
  await classSession('cancelled', 'a', { hoursAhead: 40, status: 'CANCELLED' });
  await classSession('otherSchool', 'otherSchool', { hoursAhead: 30, school: ids.schoolB });
  await startApp();

  // 1. Settings: the programs a trial can name; closed validation (contract and database).
  const choices = await success(() => readSettings(OWNER), 'settings read with programs');
  ok(JSON.stringify(choices.data.programs.map(p => p.programId).sort()) === JSON.stringify([P.a, P.b, P.draft].sort())
    && choices.data.programs.every(p => p.name.startsWith('Trial ')), 'only this school\'s non-cancelled programs');
  await success(() => saveSettings(OWNER, trialSettings(0, null)), 'first save without programs');
  for (const [label, offers, status] of [
    ['programs on a day pass', [{ ...OFFERS[0], programIds: [P.a] }], 400], ['empty program list', [TRIAL([])], 400],
    ['eleven programs', [TRIAL(Array.from({ length: 11 }, () => randomUUID()))], 400], ['duplicate program', [TRIAL([P.a, P.a])], 400],
    ['not a uuid', [TRIAL(['abc'])], 400], ['a cancelled program', [TRIAL([P.gone])], 400], ['another school\'s program', [TRIAL([P.otherSchool])], 400],
    ['an unknown program', [TRIAL([randomUUID()])], 400]]) {
    await refused(() => saveSettings(OWNER, { ...goodSettings(), expectedVersion: 1, offers }), status, undefined, `trial settings: ${label}`);
  }
  const saved = await success(() => saveSettings(OWNER, trialSettings(1, [P.a, P.draft])), 'trial offer naming programs');
  ok(JSON.stringify(saved.data.settings.offers[1].programIds) === JSON.stringify([P.a, P.draft]) && saved.data.settings.offers[0].programIds === undefined, 'settings keep the programs');
  settingsVersion = 2;

  // 2. Tablet: the trial offer carries its next classes; the day pass carries none; no program ids.
  const started = await success(() => startDevice(DESK, { label: 'Front desk', hours: 8 }), 'start a tablet');
  const TOKEN = started.data.token;
  const read = await success(() => terminal(TOKEN), 'tablet read');
  const trial = offerOf(read, 'trial-class');
  ok(offerOf(read, 'day-pass').classes === null, 'a day pass has no classes');
  ok(JSON.stringify(trial.classes.map(c => c.sessionId)) === JSON.stringify([S.soon, S.draftClass, S.later, S.race]), 'scheduled, not started, within 14 days, offer programs only, in start order');
  ok(trial.classes[0].spotsOpen === 2 && trial.classes[0].name === 'Class soon' && /Z$/.test(trial.classes[0].startsAt), 'spots open and UTC times');
  ok(!JSON.stringify(read.data).includes(P.a) && !('programIds' in trial), 'no program ids on the tablet');

  // 3. Input rules: a programs-naming trial needs a class; other offers take none.
  const before = await counts();
  await refused(() => submit(TOKEN, visitInput({ offerKey: 'trial-class' })), 400, 'INVALID', 'trial without a class');
  await refused(() => submit(TOKEN, trialVisit(null)), 400, 'INVALID', 'trial with a null class');
  await refused(() => submit(TOKEN, trialVisit('abc')), 400, 'INVALID', 'class that is not a uuid');
  await refused(() => submit(TOKEN, visitInput({ offerKey: 'day-pass', trialSessionId: S.soon })), 400, 'INVALID', 'day pass with a class');
  for (const [label, id] of [['other program', S.otherProgram], ['started', S.started], ['beyond 14 days', S.far], ['cancelled', S.cancelled],
    ['another school', S.otherSchool], ['unknown', randomUUID()]]) {
    await refused(() => submit(TOKEN, trialVisit(id, uniqueContact())), 409, 'CLASS_FULL', `class refused: ${label}`);
  }
  ok(JSON.stringify(await counts()) === JSON.stringify(before), 'refusals write nothing');
  ok((await success(() => submit(TOKEN, visitInput({ offerKey: 'day-pass', trialSessionId: null, ...uniqueContact() })), 'day pass with a null class', 201)).trialClass === null, 'a day pass books no class');

  // 4. A parent books a child on a class: one CRM trial in the 0043 shape, by the kiosk principal.
  const key = randomBytes(18).toString('base64url');
  const body = trialVisit(S.soon, uniqueContact());
  const recorded = await success(() => submit(TOKEN, body, { key }), 'trial with a class', 201);
  ok(recorded.result === 'RECORDED' && recorded.trialClass.sessionId === S.soon && recorded.trialClass.name === 'Class soon' && recorded.trialClass.status === 'SCHEDULED', 'answer names the class');
  const visit = (await sql('SELECT * FROM hon.walkin_visits WHERE trial_session_id=$1', [S.soon])).rows[0];
  const appointment = (await sql('SELECT a.*, s.starts_at s_start, s.ends_at s_end FROM hon.crm_appointments a JOIN hon.class_sessions s ON s.id=$2 WHERE a.id=$1', [visit.trial_appointment_id, S.soon])).rows[0];
  ok(appointment.crm_lead_id === visit.lead_id && appointment.appointment_type === 'TRIAL' && appointment.status === 'SCHEDULED' && appointment.version === 1
    && appointment.starts_at.getTime() === appointment.s_start.getTime() && appointment.ends_at.getTime() === appointment.s_end.getTime()
    && appointment.location === 'Class soon' && appointment.notes === null && appointment.created_by_principal_id === '00000000-0000-4000-8000-000000000414'
    && appointment.school_id === ids.schoolA, 'one scheduled CRM trial at the class times');
  const audit = (await sql("SELECT * FROM hon.audit_events WHERE entity_id=$1 AND action_code='crm.trial.schedule'", [appointment.id])).rows;
  const event = (await sql("SELECT * FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='crm.trial.scheduled'", [appointment.id])).rows;
  ok(audit.length === 1 && audit[0].source === 'PUBLIC_API' && audit[0].entity_type === 'CRM_APPOINTMENT' && audit[0].actor_principal_id === '00000000-0000-4000-8000-000000000414', 'one trial audit row');
  ok(event.length === 1 && event[0].aggregate_type === 'CRM_APPOINTMENT' && event[0].schema_version === 1 && event[0].payload.crmLeadId === visit.lead_id
    && event[0].payload.classSessionId === S.soon && event[0].payload.walkInVisitId === visit.id && event[0].payload.appointmentType === 'TRIAL'
    && !JSON.stringify(event[0].payload).includes('example.test') && !JSON.stringify(event[0].payload).includes('Rivera'), 'one trial event, identifiers only');
  ok(event[0].correlation_id === audit[0].correlation_id, 'trial audit and event share the request');
  const replay = await success(() => submit(TOKEN, body, { key }), 'exact retry', 201);
  ok(JSON.stringify(replay) === JSON.stringify(recorded) && (await sql('SELECT count(*)::int n FROM hon.crm_appointments WHERE crm_lead_id=$1', [visit.lead_id])).rows[0].n === 1,
    'exact retry: same answer, one trial');
  await refused(() => submit(TOKEN, { ...body, trialSessionId: S.later }, { key }), 400, 'INVALID', 'same key, another class');
  const detail = await success(() => readVisit(DESK, visit.id), 'staff visit read');
  ok(detail.data.visit.trialClass.sessionId === S.soon && detail.data.visit.trialClass.status === 'SCHEDULED', 'staff see the class and its trial status');
  const noClass = (await success(() => overview(DESK), 'overview')).data.visits.find(v => v.offer.key === 'day-pass');
  ok(noClass.trialClass === null, 'a visit without a class reads null');

  // 5. Seats: bookings and kiosk trials count; a visit needs a seat for everyone on it.
  ok(offerOf(await success(() => terminal(TOKEN), 'read after one trial'), 'trial-class').classes[0].spotsOpen === 1, 'one kiosk trial takes a seat');
  await booking('soon', 'CANCELLED'); await booking('soon', 'WAITLISTED');
  ok(offerOf(await success(() => terminal(TOKEN), 'read after cancelled and waitlisted'), 'trial-class').classes[0].spotsOpen === 1, 'cancelled and waitlisted bookings hold no seat');
  await booking('soon', 'BOOKED');
  ok(offerOf(await success(() => terminal(TOKEN), 'read when full'), 'trial-class').classes[0].spotsOpen === 0, 'a booking takes the last seat');
  const full = await counts();
  await refused(() => submit(TOKEN, trialVisit(S.soon, uniqueContact())), 409, 'CLASS_FULL', 'full class');
  ok(JSON.stringify(await counts()) === JSON.stringify(full), 'a full class writes nothing');
  await sql("UPDATE hon.crm_appointments SET status='CANCELLED', version=version+1 WHERE id=$1", [appointment.id]);
  ok(offerOf(await success(() => terminal(TOKEN), 'read after the trial is cancelled'), 'trial-class').classes[0].spotsOpen === 1, 'a cancelled trial frees its seat');
  ok((await success(() => readVisit(DESK, visit.id), 'staff read after cancel')).data.visit.trialClass.status === 'CANCELLED', 'staff see the cancelled trial');
  // 'later' has 3 seats: an adult and three children (4) do not fit; an adult and two children (3) do.
  await refused(() => submit(TOKEN, trialVisit(S.later, adultAndKids(3))), 409, 'CLASS_FULL', 'four people for three seats');
  const family = await success(() => submit(TOKEN, trialVisit(S.later, adultAndKids(2))), 'three people for three seats', 201);
  ok(family.trialClass.sessionId === S.later && family.firstName === 'Pat', 'family booked');
  ok(offerOf(await success(() => terminal(TOKEN), 'read later'), 'trial-class').classes.find(c => c.sessionId === S.later).spotsOpen === 0, 'every participant holds a seat');
  ok((await sql('SELECT hon.walkin_session_taken($1) n', [S.later])).rows[0].n === 3, 'seats taken = participants');

  // 6. Two tablets race for the last spot: exactly one gets it.
  const second = await success(() => startDevice(DESK, { label: 'Side desk', hours: 8 }), 'second tablet');
  const race = await Promise.all([submit(TOKEN, trialVisit(S.race, uniqueContact())), submit(second.data.token, trialVisit(S.race, uniqueContact()))]);
  ok(race.map(r => r.body.result).sort().join() === 'CLASS_FULL,RECORDED' && race.map(r => r.status).sort().join() === '201,409', `one wins the last spot: ${race.map(r => r.body.result)}`);
  ok((await sql('SELECT count(*)::int n FROM hon.walkin_visits WHERE trial_session_id=$1', [S.race])).rows[0].n === 1, 'one visit for the last spot');

  // 7. Settings change: a removed program drops its classes; the old settings version is stale.
  await success(() => saveSettings(OWNER, trialSettings(2, [P.b])), 'trial now names program b');
  settingsVersion = 3;
  ok(JSON.stringify(offerOf(await success(() => terminal(TOKEN), 'read after change'), 'trial-class').classes.map(c => c.sessionId)) === JSON.stringify([S.otherProgram]), 'classes follow the programs');
  await refused(() => submit(TOKEN, trialVisit(S.later, uniqueContact())), 409, 'CLASS_FULL', 'a class of a removed program');
  await success(() => saveSettings(OWNER, trialSettings(3, null)), 'trial without programs again');
  settingsVersion = 4;
  ok(offerOf(await success(() => terminal(TOKEN), 'read plain trial'), 'trial-class').classes === null, 'a plain trial has no classes');
  ok((await success(() => submit(TOKEN, visitInput({ offerKey: 'trial-class', ...uniqueContact() })), 'plain trial', 201)).trialClass === null, 'a plain trial books no class');
  await refused(() => submit(TOKEN, trialVisit(S.otherProgram, uniqueContact())), 400, 'INVALID', 'a class on a plain trial');

  // 8. Guards: the class and trial of a visit never change; a trial only on a trial offer; both or neither.
  await sql('BEGIN');
  try {
    await rejectsSql(() => sql('UPDATE hon.walkin_visits SET trial_session_id=$2 WHERE id=$1', [visit.id, S.later]), /WALKIN_KIOSK_IMMUTABLE/, 'class fixed');
    await rejectsSql(() => sql('UPDATE hon.walkin_visits SET trial_appointment_id=NULL, trial_session_id=NULL WHERE id=$1', [visit.id]), /WALKIN_KIOSK_IMMUTABLE|walkin_visits_trial_check/, 'trial fixed');
    await sql('ALTER TABLE hon.walkin_visits DISABLE TRIGGER USER');
    await rejectsSql(() => sql('UPDATE hon.walkin_visits SET trial_appointment_id=NULL WHERE id=$1', [visit.id]), /walkin_visits_trial_check/, 'both or neither');
    await rejectsSql(() => sql("UPDATE hon.walkin_visits SET offer_kind='DAY_PASS' WHERE id=$1", [visit.id]), /walkin_visits_trial_check/, 'only on a trial offer');
    await rejectsSql(() => sql('UPDATE hon.walkin_visits SET trial_session_id=$2 WHERE id=$1', [visit.id, S.otherSchool]), /walkin_visits_trial_session_fk/, 'never another school\'s class');
  } finally { await sql('ROLLBACK'); }

  // 9. P3 (#492): the desk path's card-paid step keeps the staff correlation id; the tablet form keeps request for both.
  const desk = (await sql("SELECT prosrc FROM pg_proc WHERE oid='hon.set_walkin_visit_desk_paid(text,uuid,jsonb,text,uuid,uuid)'::regprocedure")).rows[0].prosrc;
  ok(desk.includes("hon.walkin_card_paid(v,s,actor,'HUMAN_UI',request,correlation)") && !desk.includes("'HUMAN_UI',request);"), 'desk passes its correlation id');
  const five = (await sql("SELECT prosrc FROM pg_proc WHERE oid='hon.walkin_card_paid(hon.walkin_visits,jsonb,uuid,text,uuid)'::regprocedure")).rows[0].prosrc;
  ok(five.includes('hon.walkin_card_paid(v,s,actor,source,request,request)'), 'the five-argument form delegates');

  // 10. ACL: helpers private, no runtime table privilege, 011 section.
  for (const fn of ['walkin_session_taken(uuid)', 'walkin_trial_session_open(hon.class_sessions,jsonb,integer)', 'walkin_trial_classes(uuid,uuid,jsonb)',
    'walkin_trial_class_json(hon.walkin_visits)', 'walkin_card_paid(hon.walkin_visits,jsonb,uuid,text,uuid,uuid)', 'walkin_card_paid(hon.walkin_visits,jsonb,uuid,text,uuid)']) {
    const row = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!row.runtime && !row.public, `helper ${fn} is private`);
  }
  await assert.rejects(runtime.query('SELECT hon.walkin_trial_classes($1,$2,$3::jsonb)', [ids.organization, ids.schoolA, JSON.stringify([P.a])]), /permission denied/); checks += 1;
  await assert.rejects(runtime.query('SELECT trial_session_id FROM hon.walkin_visits LIMIT 1'), /permission denied/); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const startMark = '-- Walk-in kiosk trial class exact verification (0537)', endMark = '-- End walk-in kiosk trial class exact verification.';
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: walk-in kiosk trial class (0537): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
