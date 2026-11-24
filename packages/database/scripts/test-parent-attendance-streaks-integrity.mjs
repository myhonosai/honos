/**
 * Weekly attendance streaks proof (0602) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guard ->
 * ParentAttendanceStreaksController -> a protected definer read on the restricted runtime role with forced RLS), on the
 * guarded disposable CRM-close fixture only. Synthetic names only; nothing is written by the read and nothing is sent anywhere.
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
const M = await load('attendance-streaks/parent-attendance-streaks.controller.js');
const { ParentAttendanceStreaksService } = await load('attendance-streaks/parent-attendance-streaks.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-attendance-streaks', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'school', 'otherSchool', 'family', 'otherFamily', 'busyFamily', 'program', 'otherProgram'].map((key) => [key, randomUUID()]));
const PREFIX = `pstreak-${ids.organization}`;
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [M.ParentAttendanceStreaksController],
    providers: [HonIdentityGuard, HonIdentityService, ParentAttendanceStreaksService, M.ParentAttendanceStreaksReadGuard, { provide: RuntimeDatabaseService, useValue: database }],
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
function call(actor, method, path, { body, key = randomUUID(), command, headers = {} } = {}) {
  const sent = {
    Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`,
    Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json',
    ...(method === 'POST' ? { 'Content-Type': 'application/json', ...(command ? { 'X-Hon-Human-Command': command } : {}), ...(key ? { 'Idempotency-Key': key } : {}) } : {}),
    ...headers,
  };
  for (const [name, value] of Object.entries(sent)) if (value === undefined) delete sent[name];
  return send(new URL(`${origin}/v1${path}`), method, sent, body === undefined ? undefined : JSON.stringify(body));
}
const streaks = (actor, options = {}) => call(actor, 'GET', '/parent/attendance-streaks', options);

async function success(read, label) {
  const { status, body, headers } = await read();
  assert.equal(status, 200, `${label}: expected 200, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  ok(/no-store/.test(headers['cache-control'] ?? ''), `${label}: never cached`);
  return body.data;
}
async function refused(read, expectedStatus, expectedCode, label) {
  const { status, body } = await read();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  if (expectedCode) assert.equal(body.code, expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(body).slice(0, 400)}`);
  ok(!('data' in body), `${label}: a refusal returns no data`);
}

// Disposable-fixture cleanup only (as in the 0286 and 0329 proofs).
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
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

async function person(label, name = 'Person') {
  const user = randomUUID(), principal = randomUUID(), subject = `${PREFIX}-${label}`;
  await sql('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)', [user, subject, `${user}@example.test`, name]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3)", [principal, user, name]);
  return { subject, principal, org: ids.organization, school: ids.school };
}
async function grant(actor, family, level, school = ids.school) {
  await sql("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day',$4)",
    [ids.organization, school, family, actor.principal, level]);
}
async function child(given, family, { status = 'ACTIVE', school = ids.school } = {}) {
  const personId = randomUUID(), profile = randomUUID();
  await sql('INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4,$5)', [personId, ids.organization, school, given, 'Kim']);
  await sql("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,'STUDENT')", [ids.organization, school, family, personId]);
  await sql('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id,primary_family_id,status) VALUES($1,$2,$3,$4,$5,$6)', [profile, ids.organization, school, personId, family, status]);
  return profile;
}
// One class in school-time-zone week `weeksAgo` (0 = this week), on its Wednesday at 10:00, or at an exact SQL instant.
async function attended(profile, weeksAgo, status = 'PRESENT', { at = null, school = ids.school, program = ids.program } = {}) {
  const id = randomUUID();
  const startsAt = at ?? `(date_trunc('week',clock_timestamp() AT TIME ZONE '${LA}')-make_interval(weeks=>${weeksAgo})+interval '2 days 10 hours') AT TIME ZONE '${LA}'`;
  await sql(`INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,room_name,starts_at,ends_at,capacity,booking_policy,status)
    VALUES($1,$2,$3,$4,'Kids Karate','Mat 1',${startsAt},${startsAt}+interval '1 hour',20,'WALK_IN','SCHEDULED')`, [id, ids.organization, school, program]);
  await sql('INSERT INTO hon.attendance_records(organization_id,school_id,class_session_id,student_profile_id,status,progression_enabled) VALUES($1,$2,$3,$4,$5::hon.attendance_status,false)',
    [ids.organization, school, id, profile, status]);
}
const NOW = "clock_timestamp()-interval '1 second'";

let GUARDIAN, VIEWER, OUTSIDER, TWO, OTHER_PARENT;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Streak Org','Streak Org'),($2,'Streak Other Org','Streak Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5),($6,$2,$7,$8,$5)',
    [ids.school, ids.organization, 'Streak Dojo', `pstreak-a-${ids.school.slice(0, 8)}`, LA, ids.otherSchool, 'Streak Dojo B', `pstreak-b-${ids.otherSchool.slice(0, 8)}`]);
  await sql("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$3,$4,'Kim Family'),($2,$3,$4,'Other Family')", [ids.family, ids.otherFamily, ids.organization, ids.school]);
  await sql("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'B Family')", [ids.busyFamily, ids.organization, ids.otherSchool]);
  await sql("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Kids Karate','SCHEDULED')", [ids.program, ids.organization, ids.school]);
  await sql("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Kids Karate','SCHEDULED')", [ids.otherProgram, ids.organization, ids.otherSchool]);
  GUARDIAN = await person('guardian'); VIEWER = await person('viewer'); OUTSIDER = await person('outsider'); TWO = await person('two'); OTHER_PARENT = await person('other-parent');
  await grant(GUARDIAN, ids.family, 'PRIMARY_GUARDIAN'); await grant(VIEWER, ids.family, 'VIEWER');
  await grant(TWO, ids.family, 'PRIMARY_GUARDIAN'); await grant(TWO, ids.otherFamily, 'PRIMARY_GUARDIAN');
  await grant(OTHER_PARENT, ids.busyFamily, 'PRIMARY_GUARDIAN', ids.otherSchool);
}

try {
  await cleanup();
  await seed();
  await startApp();

  // 1. Scope: one live grant decides the family; no grant, two families and selectors are refused; children listed by name.
  ok((await success(() => streaks(GUARDIAN), 'no children yet')).children.length === 0, 'an empty family reads an empty list');
  const ava = await child('Ava', ids.family), ben = await child('Ben', ids.family), cal = await child('Cal', ids.family), dee = await child('Dee', ids.family);
  const eli = await child('Eli', ids.family), fay = await child('Fay', ids.family), gus = await child('Gus', ids.family);
  const gone = await child('Hal', ids.family, { status: 'ARCHIVED' }), other = await child('Ivy', ids.otherFamily), away = await child('Jo', ids.busyFamily, { school: ids.otherSchool });
  await refused(() => streaks(OUTSIDER), 403, 'ATTENDANCE_STREAKS_FORBIDDEN', 'no family grant');
  await refused(() => streaks(TWO), 403, 'ATTENDANCE_STREAKS_FORBIDDEN', 'two families are ambiguous');
  await refused(() => call(GUARDIAN, 'GET', '/parent/attendance-streaks?family=x'), 400, 'ATTENDANCE_STREAKS_SELECTORS_NOT_ACCEPTED', 'no selector');
  await refused(() => streaks(GUARDIAN, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-site read');
  await refused(() => streaks(GUARDIAN, { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'a delegated source header');

  // Seeding only: attendance is normally recorded through the staff check-in commands (their triggers need a human command).
  await sql('ALTER TABLE hon.attendance_records DISABLE TRIGGER USER');
  // 2. Streak rules: consecutive weeks ending this week, or last week while this week has none yet; attended statuses only.
  await attended(ava, 0, 'PRESENT', { at: NOW }); await attended(ava, 1); await attended(ava, 1, 'LATE', { at: `(date_trunc('week',clock_timestamp() AT TIME ZONE '${LA}')-interval '1 week'+interval '4 days 17 hours') AT TIME ZONE '${LA}'` });
  await attended(ava, 2); await attended(ava, 4); // Ava: 0,1,1,2 then a gap -> 3
  await attended(ben, 1); await attended(ben, 2); // Ben: none yet this week -> 2 (still alive)
  await attended(cal, 2); await attended(cal, 3); // Cal: last two weeks missed -> 0
  await attended(dee, 0, 'PRESENT', { at: "clock_timestamp()+interval '2 minutes'" }); // Dee: a class that has not started yet -> 0
  await attended(eli, 0, 'LATE', { at: NOW }); await attended(eli, 1, 'MAKEUP'); await attended(eli, 2, 'UNEXCUSED_ABSENCE'); await attended(eli, 3, 'EXCUSED_ABSENCE'); // Eli -> 2
  // Fay: 110 straight weeks -> capped at 104.
  for (let w = 0; w < 110; w += 1) await attended(fay, w, 'PRESENT', w === 0 ? { at: NOW } : {});
  // Gus: this week plus Sunday 23:30 of the week before last in the school's time zone (Monday in UTC) -> 1, not 2.
  await attended(gus, 0, 'PRESENT', { at: NOW });
  await attended(gus, 0, 'PRESENT', { at: `(date_trunc('week',clock_timestamp() AT TIME ZONE '${LA}')-interval '1 week'-interval '30 minutes') AT TIME ZONE '${LA}'` });
  // Other family, inactive child and another school never appear; their attendance never counts for anyone else.
  await attended(gone, 0, 'PRESENT', { at: NOW }); await attended(other, 0, 'PRESENT', { at: NOW });
  await attended(away, 0, 'PRESENT', { at: NOW, school: ids.otherSchool, program: ids.otherProgram });

  await sql('ALTER TABLE hon.attendance_records ENABLE TRIGGER USER');
  const before = (await sql('SELECT (SELECT count(*) FROM hon.audit_events)::int a, (SELECT count(*) FROM hon.outbox_events)::int o')).rows[0];
  const read = await success(() => streaks(GUARDIAN), 'guardian reads streaks');
  const expected = [['Ava Kim', 3], ['Ben Kim', 2], ['Cal Kim', 0], ['Dee Kim', 0], ['Eli Kim', 2], ['Fay Kim', 104], ['Gus Kim', 1]];
  assert.deepEqual(read.children.map((c) => [c.name, c.weeks]), expected); checks += 1;
  ok(Object.keys(read).join() === 'children' && read.children.every((c) => Object.keys(c).sort().join() === 'name,weeks'), 'name and number only');
  ok(!JSON.stringify(read).match(/[0-9a-f]{8}-[0-9a-f]{4}-/), 'no identifier reaches the family');
  ok(!read.children.some((c) => ['Hal Kim', 'Ivy Kim', 'Jo Kim'].includes(c.name)), 'inactive child, other family and other school are not listed');
  const viewer = await success(() => streaks(VIEWER), 'viewer reads streaks');
  ok(JSON.stringify(viewer) === JSON.stringify(read), 'every family member sees the same streaks');
  const otherSchool = await success(() => streaks(OTHER_PARENT), 'other school parent');
  ok(otherSchool.children.length === 1 && otherSchool.children[0].name === 'Jo Kim' && otherSchool.children[0].weeks === 1, 'another school reads only its own child');
  const after = (await sql('SELECT (SELECT count(*) FROM hon.audit_events)::int a, (SELECT count(*) FROM hon.outbox_events)::int o')).rows[0];
  ok(before.a === after.a && before.o === after.o, 'the read writes no audit or outbox rows');

  // 3. Live authority: ended family grant, suspended school, inactive organization and lapsed entitlement are refused.
  await sql("UPDATE hon.family_access_grants SET effective_until=clock_timestamp()+interval '1 second' WHERE principal_id=$1", [VIEWER.principal]);
  await new Promise((r) => setTimeout(r, 1200));
  await refused(() => streaks(VIEWER), 403, 'ATTENDANCE_STREAKS_FORBIDDEN', 'an ended family grant');
  await sql("UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1", [ids.school]);
  await refused(() => streaks(GUARDIAN), 403, 'ATTENDANCE_STREAKS_FORBIDDEN', 'suspended school');
  await sql("UPDATE hon.schools SET status='ACTIVE' WHERE id=$1", [ids.school]);
  await sql("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp()-interval '1 minute', effective_from=clock_timestamp()-interval '2 days' WHERE organization_id=$1", [ids.organization]);
  await refused(() => streaks(GUARDIAN), 403, 'ATTENDANCE_STREAKS_FORBIDDEN', 'lapsed entitlement');
  await sql('UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1', [ids.organization]);
  ok((await success(() => streaks(GUARDIAN), 'access returns')).children.length === 7, 'works again once access is live');

  // 4. Direct database calls: without the verified human settings the read is refused, and the helper is private.
  await assert.rejects(runtime.query('SELECT hon.read_parent_attendance_streaks($1)', [GUARDIAN.subject]), (e) => e.code === '42501'); checks += 1;
  await assert.rejects(runtime.query('SELECT hon.parent_attendance_streak_weeks($1,$2,$3,$4)', [ids.organization, ids.school, ava, LA]), (e) => e.code === '42501'); checks += 1;
  // Forced RLS: the runtime role outside a tenant transaction sees no attendance rows at all.
  ok((await runtime.query('SELECT count(*)::int n FROM hon.attendance_records')).rows[0].n === 0, 'no attendance rows outside a tenant scope');

  // 5. Database boundary: one definer entry point; helpers private; 011 section.
  { const r = (await sql(`SELECT has_function_privilege($1,'hon.read_parent_attendance_streaks(text)','EXECUTE') runtime, p.prosecdef, p.provolatile,
      EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public FROM pg_proc p WHERE p.oid='hon.read_parent_attendance_streaks(text)'::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE])).rows[0];
    ok(r.runtime && r.prosecdef && !r.public, 'runtime may execute the definer read; PUBLIC may not'); }
  for (const fn of ['parent_attendance_streak_scope(text)', 'parent_attendance_streak_weeks(uuid,uuid,uuid,text)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!r.runtime && !r.public, `helper ${fn} is private`);
  }
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const startMark = '-- Parent attendance streaks exact verification (0602)', endMark = '-- End parent attendance streaks exact verification.';
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: parent attendance streaks (0602): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch(() => {});
  await admin.end();
  await runtime.end();
}
