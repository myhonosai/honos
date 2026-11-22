/**
 * Attendance report proof (AR1, 0633) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guard + global
 * ValidationPipe + HonExceptionFilter -> AttendanceReportController -> one protected definer function on the restricted runtime
 * role with forced RLS), on the guarded disposable CRM-close fixture only. Synthetic names only; nothing is sent or charged.
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
const { AttendanceReportController } = await load('reports/school-reports.controller.js');
const { SchoolReportsService } = await load('reports/school-reports.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-attendance-report', secret: randomBytes(32).toString('hex') };
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
    controllers: [AttendanceReportController],
    providers: [HonIdentityGuard, HonIdentityService, SchoolReportsService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}

function call(actor, query = '', { headers = {}, school = actor.school, organization = actor.org, method = 'GET' } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/reports/attendance${query ? `?${query}` : ''}`);
  const sent = {
    Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`,
    Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json', ...headers,
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
    request.end();
  });
}
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

const orgs = () => [ids.organization, ids.otherOrganization];
// Disposable fixture only: when the first read is not 200, repeat it on the runtime role and print the database error
// and any waiting or busy sessions, so an intermittent CI failure carries its cause. Synthetic data, no secrets.
async function diagnose(actor, elapsed) {
  console.log(`DIAGNOSE first read failed after ${elapsed}ms`);
  const busy = await sql(`SELECT a.pid, a.usename, a.state, a.wait_event_type, a.wait_event, round(extract(epoch from clock_timestamp()-a.xact_start)::numeric,1) AS xact_s,
      left(regexp_replace(a.query,'\\s+',' ','g'),90) AS query FROM pg_stat_activity a
    WHERE a.datname=current_database() AND a.pid<>pg_backend_pid() AND a.state IS DISTINCT FROM 'idle'`);
  console.log('DIAGNOSE sessions', JSON.stringify(busy.rows));
  const waiting = await sql(`SELECT l.pid, l.locktype, l.mode, l.relation::regclass::text AS relation FROM pg_locks l WHERE NOT l.granted`);
  console.log('DIAGNOSE waiting locks', JSON.stringify(waiting.rows));
  const started = Date.now();
  try {
    await runtime.query('BEGIN READ ONLY');
    await runtime.query(`SELECT set_config('app.hon_organization_id',$1,true), set_config('app.hon_school_id',$2,true), set_config('app.hon_principal_id',$3,true),
      set_config('app.hon_principal_type','HUMAN_USER',true), set_config('app.hon_request_id',$4,true)`, [actor.org, actor.school, actor.principal, randomUUID()]);
    await runtime.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='3s'");
    await runtime.query("SELECT set_config('app.hon_source','HUMAN_UI',true), set_config('app.hon_external_subject',$1,true), set_config('app.hon_action_request_id','',true), set_config('app.hon_delegated_by_principal_id','',true)", [actor.subject]);
    const result = await runtime.query("SELECT hon.read_attendance_report($1,'{}'::jsonb) AS data", [actor.subject]);
    console.log(`DIAGNOSE direct read ok in ${Date.now() - started}ms`, JSON.stringify(result.rows[0].data).slice(0, 300));
  } catch (error) {
    console.log(`DIAGNOSE direct read failed in ${Date.now() - started}ms: ${error.code} ${error.message}`);
  } finally { await runtime.query('ROLLBACK').catch(() => {}); }
}
// Disposable-fixture cleanup only (as in the 0239 proof).
async function cleanup() {
  const tables = (await sql(`SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
    WHERE c.relnamespace='hon'::regnamespace AND c.relkind='r' ORDER BY 1`)).rows.map((row) => row.relname);
  await sql('BEGIN');
  try {
    // Deferred lead triggers would otherwise leave pending events that block re-enabling the guards.
    await sql('SET CONSTRAINTS ALL IMMEDIATE');
    for (let pass = 0; pass < 8; pass += 1) {
      let failed = 0;
      for (const table of tables) {
        await sql('SAVEPOINT cleanup_table');
        try {
          await sql(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);
          await sql(`DELETE FROM hon.${table} WHERE organization_id = ANY($1::uuid[])`, [orgs()]);
          await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);
          await sql('RELEASE SAVEPOINT cleanup_table');
        } catch { failed += 1; await sql('ROLLBACK TO SAVEPOINT cleanup_table'); }
      }
      if (!failed) break;
    }
    await sql('DELETE FROM hon.hq_operator_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`attrep-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`attrep-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`attrep-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`attrep-${ids.organization}-%`]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [orgs()]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [orgs()]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}
// Seed rows directly as the fixture owner; record guards are switched off only around each synthetic insert.
async function raw(table, text, values) {
  await sql(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);
  try { return await sql(text, values); } finally { await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`); }
}

const allPermissions = (await sql('SELECT code FROM hon.permissions ORDER BY code')).rows.map((row) => row.code);
async function role(org, permissions, code) {
  const id = randomUUID();
  await sql('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)', [id, org, code ?? `STAFF_${id.slice(0, 8)}`]);
  for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [id, org, permission]);
  return id;
}
async function staff(label, roles, { org = ids.organization, school = ids.schoolA } = {}) {
  const user = randomUUID(), principal = randomUUID(), subject = `attrep-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Reports Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Reports Staff')", [principal, user]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  return { subject, principal, grants, org, school };
}

let OWN, REPORTER, NONE, MIXED, OTHER_SCHOOL, HQ;
const local = async (text) => (await sql('SELECT ($1::timestamp AT TIME ZONE $2) t', [text, LA])).rows[0].t;

async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Attrep Org','Attrep Org'),($2,'Attrep Other Org','Attrep Other Org')", orgs());
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", orgs());
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Attrep ${slug}`, `attrep-${slug}-${school.slice(0, 8)}`, LA]);
  }
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  REPORTER = await staff('reporter', [await role(ids.organization, ['reporting.view'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read', 'crm.lead.read', 'attendance.record', 'billing.membership.read'])]);
  MIXED = await staff('mixed', [await role(ids.organization, ['reporting.view']), await role(ids.organization, ['people.read'], 'PARENT_PORTAL')]);
  OTHER_SCHOOL = await staff('other-school', [await role(ids.organization, allPermissions)], { school: ids.schoolB });
  HQ = await staff('hq', [await role(ids.organization, ['reporting.view'])]);
  await sql("INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_OWNER')", [HQ.principal]);
}

// Days in school time relative to today: day(-1) is yesterday.
let today;
const day = (offset) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
const isodow = (date) => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
const monday = (date) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - (isodow(date) - 1)); return d.toISOString().slice(0, 10); };

// Every school holds the same records; school B and the other organization must never reach school A's report.
async function records(org, school, tag) {
  const person = async (given) => { const id = randomUUID(); await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4,$5)", [id, org, school, given, `Fam${tag}`]); return id; };
  const payer = await person('Payer'), account = randomUUID();
  await sql('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id) VALUES($1,$2,$3,$4)', [account, org, school, payer]);
  const membership = async (given, state, started) => {
    const id = randomUUID(), participant = await person(given);
    await raw('memberships', `INSERT INTO hon.memberships(id,organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at)
      VALUES($1,$2,$3,$4,$5,'MONTHLY',$6,$7)`, [id, org, school, account, participant, state, started ? await local(`${day(-90)} 00:00`) : null]);
    return { id, participant };
  };
  const profile = async (participant) => { const id = randomUUID(); await sql('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)', [id, org, school, participant]); return id; };
  const recent = await membership('Recent', 'ACTIVE', true), month = await membership('Month', 'ACTIVE', true), paused = await membership('Paused', 'FROZEN', true);
  const never = await membership('Never', 'ACTIVE', true), left = await membership('Left', 'CANCELLED', true);
  await membership('NoProfile', 'ACTIVE', true); await membership('Draft', 'DRAFT', false);
  await raw('audit_events', `INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,result,request_id,correlation_id,occurred_at)
    VALUES($1,$2,$3,'HUMAN_UI','billing.membership.cancel','MEMBERSHIP',$4,'SUCCEEDED',$5,$5,clock_timestamp()-interval '2 hours')`, [org, school, OWN.principal, left.id, randomUUID()]);
  const recentP = await profile(recent.participant), monthP = await profile(month.participant), pausedP = await profile(paused.participant),
    neverP = await profile(never.participant), leftP = await profile(left.participant);

  const kids = randomUUID(), adults = randomUUID(), karate = randomUUID();
  await sql("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Kids','SCHEDULED'),($4,$2,$3,'Adults','SCHEDULED')", [kids, org, school, adults]);
  await sql("INSERT INTO hon.curricula(id,organization_id,school_id,name,model_code) VALUES($1,$2,$3,'Karate','LINEAR')", [karate, org, school]);
  const rank = async (name, order) => { const id = randomUUID(); await raw('curriculum_ranks', 'INSERT INTO hon.curriculum_ranks(id,organization_id,school_id,curriculum_id,name,progression_order) VALUES($1,$2,$3,$4,$5,$6)', [id, org, school, karate, name, order]); return id; };
  const white = await rank('White', 1), yellow = await rank('Yellow', 2);
  const enroll = (student, r, program) => raw('student_curriculum_enrollments', "INSERT INTO hon.student_curriculum_enrollments(organization_id,school_id,student_profile_id,curriculum_id,current_rank_id,program_id,status) VALUES($1,$2,$3,$4,$5,$6,'ACTIVE')", [org, school, student, karate, r, program]);
  await enroll(recentP, white, kids); await enroll(monthP, yellow, kids); await enroll(pausedP, white, adults); await enroll(leftP, yellow, kids);

  const session = async (program, name, date, time, cancelled = false) => {
    const id = randomUUID();
    await raw('class_sessions', `INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status,cancellation_reason)
      VALUES($1,$2,$3,$4,$5,$6,$6::timestamptz+interval '45 minutes',30,'WALK_IN',$7,$8)`, [id, org, school, program, name, await local(`${date} ${time}`), cancelled ? 'CANCELLED' : 'SCHEDULED', cancelled ? 'Closed' : null]);
    return id;
  };
  const mark = (sessionId, student, status) => raw('attendance_records', 'INSERT INTO hon.attendance_records(organization_id,school_id,class_session_id,student_profile_id,status,progression_enabled,progression_weight_milli,progression_credit_milli) VALUES($1,$2,$3,$4,$5,false,0,0)',
    [org, school, sessionId, student, status]);
  const yesterday = await session(kids, 'Kids class', day(-1), '16:00');
  await mark(yesterday, recentP, 'PRESENT'); await mark(yesterday, leftP, 'LATE'); await mark(yesterday, neverP, 'UNEXCUSED_ABSENCE');
  const tenAgo = await session(kids, 'Kids class', day(-10), '17:00'); await mark(tenAgo, monthP, 'MAKEUP');
  const fortyAgo = await session(adults, 'Adult class', day(-40), '18:00'); await mark(fortyAgo, pausedP, 'PRESENT');
  const closed = await session(kids, 'Closed class', day(-1), '18:00', true); await mark(closed, neverP, 'PRESENT');
  const tomorrow = await session(kids, 'Kids class', day(1), '16:00'); await mark(tomorrow, neverP, 'PRESENT');
  await session(adults, 'Empty class', day(-1), '19:00');
  return { recentP, monthP, pausedP, neverP, leftP, kids, adults, people: { recent: recent.participant, month: month.participant, paused: paused.participant, never: never.participant } };
}

try {
  await cleanup();
  await seed();
  today = (await sql("SELECT to_char(clock_timestamp() AT TIME ZONE $1,'YYYY-MM-DD') d", [LA])).rows[0].d;
  const A = await records(ids.organization, ids.schoolA, 'A');
  await records(ids.organization, ids.schoolB, 'B');
  await records(ids.otherOrganization, ids.otherSchool, 'O');
  await startApp();
  const j = (v) => JSON.stringify(v);

  // 1. Authority: reporting.view at this school, a direct human, no HQ, family or other-school borrowing.
  const first = await success(async () => {
    const started = Date.now(), response = await call(REPORTER, `week=${day(-1)}&month=ALL`);
    if (response.status !== 200) await diagnose(REPORTER, Date.now() - started);
    return response;
  }, 'a reporting.view staff member');
  for (const [actor, label] of [[NONE, 'attendance.record without reporting.view'], [MIXED, 'a mixed parent role'], [HQ, 'an HQ operator']]) {
    await refused(() => call(actor), 403, undefined, `refused for ${label}`);
  }
  await refused(() => call(OTHER_SCHOOL, '', { school: ids.schoolA }), 403, undefined, 'school-B staff at the school-A route');
  await refused(() => call(REPORTER, '', { organization: ids.otherOrganization }), 403, undefined, 'a wrong organization in the route');
  await refused(() => call(REPORTER, '', { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'a read with an idempotency key');
  await refused(() => call(REPORTER, '', { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'a cross-site read');
  await refused(() => call(REPORTER, '', { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'a source selector');
  for (const query of ['week=2026-13-01', 'week=2026-02-30', 'week=', 'week=1999-12-27', `week=${day(8)}`, 'month=all', 'month=2026-13', 'month=1999-12', `month=${day(40).slice(0, 7)}`,
    'month=ALL&x=1', 'month=ALL&month=ALL', 'range=D30']) {
    await refused(() => call(REPORTER, query), 400, undefined, `query ${query}`);
  }

  // 2. Exact numbers for school A.
  const R = first.data;
  ok(R.schoolId === ids.schoolA && R.schoolName === 'Attrep a' && R.timezone === LA && R.localToday === today, 'school A, school-time today');
  ok(j(R.participation) === j({ activeStudents: 4, attended7Days: 1, attended30Days: 2 }), `participation ${j(R.participation)}`);
  ok(R.savedCheckIns === 4, `saved check-ins: absences, cancelled and future sessions never count (${R.savedCheckIns})`);
  ok(R.week.start === monday(day(-1)) && j(R.week.sessions.filter((x) => x.date === day(-1))) === j([{ date: day(-1), time: '16:00', checkIns: 2 }, { date: day(-1), time: '19:00', checkIns: 0 }])
    && R.week.sessions.every((x) => x.date <= today) && !R.week.sessions.some((x) => x.time === '18:00'), `week of yesterday ${j(R.week)}`);
  const cls = (name, time) => R.classes.rows.filter((x) => x.name === name && x.time === time);
  ok(R.classes.month === 'ALL' && R.classes.truncated === false && R.classes.rows.length === 4
    && j(cls('Kids class', '16:00')) === j([{ weekday: isodow(day(-1)), time: '16:00', name: 'Kids class', program: 'Kids', sessions: 1, sessionsWithCheckIns: 1, checkIns: 2 }])
    && j(cls('Kids class', '17:00')) === j([{ weekday: isodow(day(-10)), time: '17:00', name: 'Kids class', program: 'Kids', sessions: 1, sessionsWithCheckIns: 1, checkIns: 1 }])
    && j(cls('Adult class', '18:00')) === j([{ weekday: isodow(day(-40)), time: '18:00', name: 'Adult class', program: 'Adults', sessions: 1, sessionsWithCheckIns: 1, checkIns: 1 }])
    && j(cls('Empty class', '19:00').map((x) => [x.sessions, x.sessionsWithCheckIns, x.checkIns])) === j([[1, 0, 0]]), `classes all time ${j(R.classes)}`);
  ok(j(R.programs) === j([{ programId: A.kids, name: 'Kids', activeStudents: 2, attended30Days: 2 }, { programId: A.adults, name: 'Adults', activeStudents: 1, attended30Days: 0 },
    { programId: null, name: null, activeStudents: 1, attended30Days: 0 }]), `programs ${j(R.programs)}`);
  ok(R.students.truncated === false && j(R.students.items) === j([
    { studentProfileId: A.neverP, personId: A.people.never, givenName: 'Never', familyName: 'FamA', program: null, rank: null, lastCheckIn: null, attended7Days: false, attended30Days: false },
    { studentProfileId: A.pausedP, personId: A.people.paused, givenName: 'Paused', familyName: 'FamA', program: 'Adults', rank: 'White', lastCheckIn: day(-40), attended7Days: false, attended30Days: false },
    { studentProfileId: A.monthP, personId: A.people.month, givenName: 'Month', familyName: 'FamA', program: 'Kids', rank: 'Yellow', lastCheckIn: day(-10), attended7Days: false, attended30Days: true },
    { studentProfileId: A.recentP, personId: A.people.recent, givenName: 'Recent', familyName: 'FamA', program: 'Kids', rank: 'White', lastCheckIn: day(-1), attended7Days: true, attended30Days: true },
  ]), `students: longest absent first; cancelled, draft and profile-less members left out ${j(R.students.items)}`);
  ok(!/FamB|FamO|Left|NoProfile|Draft|Payer|Closed/.test(j(R)), 'no other school, former member, payer or cancelled class');

  // 3. Defaults, another month, another school.
  const def = await success(() => call(OWN), 'defaults');
  ok(def.data.week.start === monday(today) && def.data.classes.month === today.slice(0, 7) && j(def.data.participation) === j(R.participation), 'this week and this month by default');
  const old = await success(() => call(OWN, `month=${day(-40).slice(0, 7)}&week=${day(-40)}`), 'the month and week of 40 days ago');
  ok(old.data.classes.rows.some((x) => x.name === 'Adult class' && x.checkIns === 1) && j(old.data.week.sessions.filter((x) => x.date === day(-40))) === j([{ date: day(-40), time: '18:00', checkIns: 1 }]),
    `an earlier month and week ${j(old.data.classes)} ${j(old.data.week)}`);
  const b = await success(() => call(OTHER_SCHOOL, `week=${day(-1)}&month=ALL`), 'school B');
  const strip = (d) => j({ p: d.participation, n: d.savedCheckIns, w: d.week, c: d.classes, pr: d.programs.map((x) => [x.name, x.activeStudents, x.attended30Days]), s: d.students.items.map((x) => [x.givenName, x.lastCheckIn]) });
  ok(b.data.schoolId === ids.schoolB && strip(b.data) === strip(R) && b.data.students.items.every((x) => x.familyName === 'FamB'), 'school B: the same totals from its own rows only');

  // 4. Live authority: a revoked grant and a lapsed entitlement are refused at once.
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE id=$1', [REPORTER.grants[0], OWN.principal]);
  await refused(() => call(REPORTER), 403, undefined, 'refused after the grant is revoked');
  await raw('organization_entitlements', 'UPDATE hon.organization_entitlements SET effective_until=clock_timestamp() WHERE organization_id=$1', [ids.organization]);
  await refused(() => call(OWN), 403, undefined, 'refused without an active entitlement');
  await raw('organization_entitlements', 'UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1', [ids.organization]);
  ok((await call(OWN)).status === 200, 'allowed again once the entitlement is active');

  // 5. Database boundary: one stable definer read on the runtime role; nothing written; the 011 section passes.
  const fns = (await sql(`SELECT p.oid::regprocedure::text sig, has_function_privilege($1,p.oid,'EXECUTE') runtime,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public, p.prosecdef definer, p.proconfig config, p.provolatile
    FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace AND p.proname='read_attendance_report'`, [CRM_CLOSE_RUNTIME_ROLE])).rows;
  ok(fns.length === 1 && fns[0].definer && !fns[0].public && fns[0].runtime && fns[0].provolatile === 's' && j(fns[0].config) === '["search_path=pg_catalog, hon"]', 'one stable definer read, not public, fixed search path');
  await assert.rejects(runtime.query('SELECT hon.read_attendance_report($1,$2::jsonb)', [OWN.subject, '{}']), /SCHOOL_REPORTS_FORBIDDEN|tenant|permission/i); checks += 1;
  await assert.rejects(runtime.query('SELECT * FROM hon.school_dashboard_members($1,$2)', [ids.organization, ids.schoolA]), /permission denied/); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const startMark = '-- Attendance report exact verification (AR1 0633)', endMark = '-- End attendance report exact verification.';
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: attendance report (0633): ${checks} checks.`);

} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
