/**
 * Staff time clock proof (0478) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guards + global
 * ValidationPipe + HonExceptionFilter -> StaffTimeController -> protected definer functions on the restricted runtime role
 * with forced RLS), on the guarded disposable CRM-close fixture only. Synthetic staff only; nothing messages anyone, pays
 * anyone or calls a provider.
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
const { StaffTimeController } = await load('staff-time/staff-time.controller.js');
const { StaffTimeService } = await load('staff-time/staff-time.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-staff-time', secret: randomBytes(32).toString('hex') };
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
    controllers: [StaffTimeController],
    providers: [HonIdentityGuard, HonIdentityService, StaffTimeService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}
function call(actor, method, { body, key = randomUUID(), command, headers = {}, school = actor.school, organization = actor.org, query = '', path = '' } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/staff/time${path}${query}`);
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
const myClock = (actor, options = {}) => call(actor, 'GET', { path: '/clock', ...options });
const punch = (actor, action, expectedVersion, options = {}) => call(actor, 'POST', { path: '/clock', command: 'staff_time.punch', body: { action, expectedVersion }, ...options });
const sheet = (actor, week, options = {}) => call(actor, 'GET', { path: `/weeks/${week}`, ...options });
const fix = (actor, body, options = {}) => call(actor, 'POST', { path: '/entries', command: 'staff_time.entry.save', body, ...options });
const decide = (actor, body, options = {}) => call(actor, 'POST', { path: '/weeks', command: 'staff_timesheet.decide', body, ...options });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function success(run, label) {
  const { status, body, headers } = await run();
  assert.equal(status, 200, `${label}: expected 200, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  ok(headers['cache-control'] === 'private, no-store', `${label}: never cached`);
  return body;
}
async function refused(run, expectedStatus, expectedCode, label) {
  const { status, body } = await run();
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

// Disposable-fixture cleanup only (as in the 0240 proof).
async function cleanup(orgs = [ids.organization, ids.otherOrganization], subjects = `%time-${ids.organization}-%`) {
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
          await sql(`DELETE FROM hon.${table} WHERE organization_id = ANY($1::uuid[])`, [orgs]);
          await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);
          await sql('RELEASE SAVEPOINT cleanup_table');
        } catch { failed += 1; await sql('ROLLBACK TO SAVEPOINT cleanup_table'); }
      }
      if (!failed) break;
    }
    const left = (await sql('SELECT count(*)::int n FROM hon.staff_time_entries WHERE organization_id = ANY($1::uuid[])', [orgs])).rows[0].n;
    if (left) throw new Error('fixture cleanup left a time entry behind');
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [subjects]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [subjects]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [subjects]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [orgs]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [orgs]);
    const roles = (await sql('SELECT count(*)::int n FROM hon.roles WHERE organization_id = ANY($1::uuid[])', [orgs])).rows[0].n;
    if (roles) throw new Error('fixture cleanup left a role behind');
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

const allPermissions = (await sql('SELECT code FROM hon.permissions ORDER BY code')).rows.map((row) => row.code);
async function role(org, permissions, code, system = false) {
  const id = randomUUID();
  await sql('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,$4)', [id, org, code ?? `STAFF_${id.slice(0, 8)}`, system]);
  for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [id, org, permission]);
  return id;
}
async function staff(label, roles, { org = ids.organization, school = ids.schoolA } = {}) {
  const user = randomUUID(), principal = randomUUID(), subject = `time-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Time Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3)", [principal, user, `Staff ${label}`]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  return { subject, principal, grants, org, school };
}


const entries = async (where = '') => (await sql(`SELECT count(*)::int n FROM hon.staff_time_entries WHERE organization_id=$1 ${where}`, [ids.organization])).rows[0].n;
const entryFix = (actor, patch = {}) => ({ entryId: null, expectedVersion: 0, staffPrincipalId: actor.principal, clockIn: `${LAST}T09:00`, clockOut: `${LAST}T17:00`,
  reason: 'Forgot to clock in', ...patch });
let OWN, MGR, CLK, CLK2, NONE, PARENTISH, OWN_B, OTHER_ORG, LOSER, THIS, LAST, NEXT;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Time Org','Time Org'),($2,'Time Other Org','Time Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'CORE','ACTIVE',clock_timestamp()-interval '1 day'),($2,'CORE','ACTIVE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Time ${slug}`, `time-${slug}-${school.slice(0, 8)}`, LA]);
  }
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER', true)]);
  MGR = await staff('manager', [await role(ids.organization, ['staff.timesheet.manage'])]);
  CLK = await staff('instructor', [await role(ids.organization, ['staff.time.clock', 'people.read'])]);
  CLK2 = await staff('desk', [await role(ids.organization, ['staff.time.clock'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read'])]);
  PARENTISH = await staff('parentish', [await role(ids.organization, ['staff.time.clock'], 'PARENT_PORTAL')]);
  OWN_B = await staff('owner-b', [await role(ids.organization, ['staff.timesheet.manage', 'staff.time.clock'])], { school: ids.schoolB });
  OTHER_ORG = await staff('other-org', [await role(ids.otherOrganization, allPermissions, 'OWNER')], { org: ids.otherOrganization, school: ids.otherSchool });
  LOSER = await staff('loser', [await role(ids.organization, ['staff.time.clock'])]);
  const w = (await sql(`SELECT to_char(m,'YYYY-MM-DD') this, to_char(m-7,'YYYY-MM-DD') last, to_char(m+7,'YYYY-MM-DD') next
    FROM (SELECT d-(extract(isodow FROM d)::int-1) m FROM (SELECT (clock_timestamp() AT TIME ZONE $1)::date d) x) y`, [LA])).rows[0];
  THIS = w.this; LAST = w.last; NEXT = w.next;
}

try {
  await cleanup();
  await seed();
  await startApp();

  // 0. Permissions and OWNER grants.
  ok((await sql("SELECT count(*)::int n FROM hon.permissions WHERE (code='staff.time.clock' AND NOT is_sensitive AND is_staff_assignable) OR (code='staff.timesheet.manage' AND is_sensitive AND is_staff_assignable)")).rows[0].n === 2, 'two staff-assignable permissions');
  ok((await sql(`SELECT count(*)::int n FROM hon.roles r CROSS JOIN unnest(ARRAY['staff.time.clock','staff.timesheet.manage']) c WHERE r.is_system_role AND r.code='OWNER'
    AND NOT EXISTS(SELECT 1 FROM hon.role_permissions rp WHERE rp.role_id=r.id AND rp.organization_id=r.organization_id AND rp.permission_code=c)`)).rows[0].n === 0, 'every system OWNER role holds both');

  // 1. Reads: the clock needs staff.time.clock, the timesheet staff.timesheet.manage, at exactly this school.
  const empty = (await success(() => myClock(CLK), 'my clock')).data;
  ok(empty.open === null && empty.entries.length === 0 && empty.approval === null && empty.weekStart === THIS && empty.timezone === LA && Math.abs(Date.parse(empty.now) - Date.now()) < 60_000, 'empty clock this week');
  for (const actor of [MGR, NONE, PARENTISH]) await refused(() => myClock(actor), 403, undefined, `clock read refused for ${actor.subject.split('-').pop()}`);
  for (const actor of [CLK, NONE, PARENTISH]) await refused(() => sheet(actor, THIS), 403, undefined, `timesheet refused for ${actor.subject.split('-').pop()}`);
  await refused(() => sheet(OWN_B, THIS, { school: ids.schoolA }), 403, undefined, 'school-B manager at the school-A route');
  await refused(() => sheet(OTHER_ORG, THIS, { school: ids.schoolA, organization: ids.organization }), 403, undefined, 'other-organization owner at the school-A route');
  await refused(() => sheet(MGR, '2026-11-17'), 400, 'VALIDATION_FAILED', 'a week starts on Monday');
  await refused(() => myClock(CLK, { query: '?at=1' }), 400, 'VALIDATION_FAILED', 'read with a query');
  await refused(() => myClock(CLK, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'read with a key');
  await refused(() => myClock(CLK, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-site read');

  // 2. Punch refusals before anything is written; the body can never carry a time.
  for (const actor of [MGR, NONE, PARENTISH]) await refused(() => punch(actor, 'CLOCK_IN', 0), 403, undefined, `punch refused for ${actor.subject.split('-').pop()}`);
  await refused(() => punch(CLK, 'CLOCK_IN', 0, { key: '' }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'no key');
  await refused(() => punch(CLK, 'CLOCK_IN', 0, { command: 'staff_time.entry.save' }), 403, 'HUMAN_UI_REQUIRED', 'another command header');
  await refused(() => punch(CLK, 'CLOCK_IN', 1), 400, 'VALIDATION_FAILED', 'clock in at version 1');
  await refused(() => punch(CLK, 'NAP', 1), 400, 'VALIDATION_FAILED', 'unknown action');
  await refused(() => call(CLK, 'POST', { path: '/clock', command: 'staff_time.punch', body: { action: 'CLOCK_IN', expectedVersion: 0, at: '2026-01-01T09:00:00.000Z' } }), 400, undefined, 'a device time is refused');
  for (const act of ['BREAK_START', 'BREAK_END']) await refused(() => punch(CLK, act, 1), 400, 'VALIDATION_FAILED', `hours only: no ${act}`);
  await refused(() => punch(CLK, 'CLOCK_OUT', 1), 409, 'TIME_CLOCK_STATE_CHANGED', 'clock out while off the clock');
  ok(await entries() === 0, 'no refusal wrote an entry');

  // 3. Clock in at the database clock; exact replay; key reuse; only one open entry, even in a race.
  const key1 = randomUUID();
  const before = Date.now();
  const inn = await success(() => punch(CLK, 'CLOCK_IN', 0, { key: key1 }), 'clock in');
  const e1 = inn.data;
  ok(e1.version === 1 && e1.origin === 'CLOCK' && e1.clockOutAt === null && e1.workedMinutes === null && e1.staffPrincipalId === CLK.principal
    && Math.abs(Date.parse(e1.clockInAt) - before) < 60_000 && inn.meta.replayed === false, `clocked in at the server's time ${JSON.stringify(e1)}`);
  const replay = await success(() => punch(CLK, 'CLOCK_IN', 0, { key: key1 }), 'replay');
  ok(replay.meta.replayed === true && JSON.stringify(replay.data) === JSON.stringify(e1), 'exact replay returns the first receipt');
  await refused(() => punch(CLK, 'CLOCK_OUT', 1, { key: key1 }), 409, 'IDEMPOTENCY_KEY_REUSED', 'same key, other body');
  await refused(() => punch(CLK, 'CLOCK_IN', 0), 409, 'TIME_CLOCK_STATE_CHANGED', 'already clocked in');
  const race = await Promise.all([punch(CLK2, 'CLOCK_IN', 0), punch(CLK2, 'CLOCK_IN', 0)]);
  ok(race.map((r) => r.status).sort().join() === '200,409' && race.find((r) => r.status === 409).body.code === 'TIME_CLOCK_STATE_CHANGED', `exactly one of two racing clock-ins wins ${race.map((r) => r.status)}`);
  ok(await entries(`AND principal_id='${CLK2.principal}' AND clock_out_at IS NULL`) === 1, 'one open entry for the racer');
  await success(() => punch(OWN_B, 'CLOCK_IN', 0, { school: ids.schoolB }), 'a school-B clock-in is separate');

  // 4. Hours only: the entry carries no break fields; stale versions refused; clock out closes.
  ok(Object.keys(e1).sort().join() === 'clockInAt,clockOutAt,entryId,localDate,origin,staffPrincipalId,updatedAt,version,workedMinutes', `no break fields ${Object.keys(e1)}`);
  await pause(5);
  await refused(() => punch(CLK, 'CLOCK_OUT', 2), 409, 'VERSION_CONFLICT', 'stale version');
  const out = (await success(() => punch(CLK, 'CLOCK_OUT', 1), 'clock out')).data;
  ok(out.version === 2 && out.clockOutAt > out.clockInAt && out.workedMinutes === 0, `clock out closes the entry ${JSON.stringify(out)}`);
  await refused(() => punch(CLK, 'CLOCK_OUT', 2), 409, 'TIME_CLOCK_STATE_CHANGED', 'nothing open to clock out');
  const after = (await success(() => myClock(CLK), 'clock after')).data;
  ok(after.open === null && after.entries.length === 1 && after.entries[0].entryId === e1.entryId, 'own week shows the closed entry');
  const tooLong = (await sql("INSERT INTO hon.staff_time_entries(organization_id,school_id,principal_id,local_date,timezone,clock_in_at,origin,created_by_principal_id,updated_by_principal_id) VALUES($1,$2,$3,((date_trunc('milliseconds',clock_timestamp())-interval '25 hours') AT TIME ZONE $4)::date,$4,date_trunc('milliseconds',clock_timestamp())-interval '25 hours','CLOCK',$3,$3) RETURNING id",
    [ids.organization, ids.schoolA, LOSER.principal, LA])).rows[0].id;
  await refused(() => punch(LOSER, 'CLOCK_OUT', 1), 409, 'TIME_ENTRY_TOO_LONG', 'a clock-out after 24 hours needs a manager');

  // 5. Manager timesheet with scheduled minutes from the shift schedule (0467).
  await sql("INSERT INTO hon.staff_shifts(organization_id,school_id,principal_id,local_date,start_time,end_time,timezone,starts_at,ends_at,status,created_by_principal_id,updated_by_principal_id) VALUES($1,$2,$3,$4::date,'09:00','13:00',$5,($4::date+time '09:00') AT TIME ZONE $5,($4::date+time '13:00') AT TIME ZONE $5,'SCHEDULED',$3,$3)",
    [ids.organization, ids.schoolA, CLK.principal, THIS, LA]);
  const week = (await success(() => sheet(MGR, THIS), 'timesheet')).data;
  const mine = week.people.find((p) => p.principalId === CLK.principal);
  ok(week.weekStart === THIS && mine && mine.scheduledMinutes === 240 && mine.entries.length === 1 && mine.approval === null, 'timesheet shows entries and scheduled minutes');
  ok(!week.people.some((p) => [PARENTISH, OWN_B, OTHER_ORG].some((a) => a.principal === p.principalId)), 'school-A staff only');
  ok(week.people.every((p) => Object.keys(p).sort().join() === 'approval,displayName,entries,principalId,scheduledMinutes'), 'no email, subject or roles');

  // 6. Manager fixes with a reason, append-only revisions; refusals.
  for (const [label, patch] of [['no reason', { reason: '' }], ['short reason', { reason: 'ok' }], ['markup reason', { reason: '<b>x</b>' }], ['out before in', { clockOut: `${LAST}T08:00` }],
    ['over 24 hours', { clockOut: `${LAST.slice(0, 8)}${String(Number(LAST.slice(8)) + 1).padStart(2, '0')}T09:30` }],
    ['future', { clockIn: `${NEXT}T09:00`, clockOut: `${NEXT}T10:00` }], ['new at version 1', { expectedVersion: 1 }], ['bad date', { clockIn: '2026-02-30T09:00' }]]) {
    await refused(() => fix(MGR, entryFix(CLK, patch)), 400, 'VALIDATION_FAILED', label);
  }
  await refused(() => fix(MGR, entryFix(CLK, { breaks: [] })), 400, undefined, 'hours only: a breaks field is refused');
  await refused(() => fix(CLK, entryFix(CLK)), 403, undefined, 'a clocker cannot fix');
  await refused(() => fix(MGR, entryFix(OTHER_ORG)), 403, 'STAFF_MEMBER_UNAVAILABLE', 'staff of another organization');
  await refused(() => fix(MGR, entryFix(PARENTISH)), 403, 'STAFF_MEMBER_UNAVAILABLE', 'a family-role person');
  const add = (await success(() => fix(MGR, entryFix(CLK)), 'add missed entry')).data;
  ok(add.origin === 'MANAGER' && add.version === 1 && add.workedMinutes === 480 && !('breakMinutes' in add) && add.localDate === LAST, `missed entry added ${JSON.stringify(add)}`);
  await refused(() => fix(MGR, entryFix(CLK, { clockIn: `${LAST}T16:00`, clockOut: `${LAST}T18:00` })), 409, 'TIME_ENTRY_OVERLAP', 'overlapping entry');
  const moved = (await success(() => fix(OWN, entryFix(CLK, { entryId: add.entryId, expectedVersion: 1, clockIn: `${LAST}T08:00`, reason: 'Came in early' })), 'fix entry')).data;
  ok(moved.version === 2 && moved.entryId === add.entryId && moved.workedMinutes === 540 && moved.origin === 'MANAGER', 'fixed to version 2');
  await refused(() => fix(MGR, entryFix(CLK, { entryId: add.entryId, expectedVersion: 1 })), 409, 'VERSION_CONFLICT', 'stale fix');
  await refused(() => fix(OWN_B, entryFix(CLK, { entryId: add.entryId, expectedVersion: 2 }), { school: ids.schoolB }), 404, 'TIME_ENTRY_NOT_FOUND', 'school B cannot find a school-A entry');
  await refused(() => fix(MGR, entryFix(MGR, { entryId: add.entryId, expectedVersion: 2 })), 400, 'VALIDATION_FAILED', 'the person never changes');
  const longTimes = (await sql("SELECT to_char(clock_in_at AT TIME ZONE $2,'YYYY-MM-DD\"T\"HH24:MI') a, to_char((clock_in_at+interval '8 hours') AT TIME ZONE $2,'YYYY-MM-DD\"T\"HH24:MI') b FROM hon.staff_time_entries WHERE id=$1", [tooLong, LA])).rows[0];
  const closedLong = (await success(() => fix(MGR, { entryId: tooLong, expectedVersion: 1, staffPrincipalId: LOSER.principal, clockIn: longTimes.a, clockOut: longTimes.b,
    reason: 'Forgot to clock out' }), 'manager closes a forgotten entry')).data;
  ok(closedLong.clockOutAt !== null && closedLong.workedMinutes >= 479 && closedLong.workedMinutes <= 480 && closedLong.origin === 'CLOCK', 'a forgotten open entry is closed by a manager');
  const fallBack = (await success(() => fix(MGR, entryFix(CLK, { clockIn: '2026-11-01T00:00', clockOut: '2026-11-01T04:00', reason: 'Fall-back night' })), 'fall-back night')).data;
  ok(fallBack.workedMinutes === 300 && fallBack.clockInAt === '2026-11-01T07:00:00.000Z' && fallBack.clockOutAt === '2026-11-01T12:00:00.000Z', `fall back: four local hours are five real hours ${JSON.stringify(fallBack)}`);
  const revisions = (await sql('SELECT entry_id, entry_version, reason, before_state IS NULL fresh, actor_principal_id FROM hon.staff_time_entry_revisions WHERE organization_id=$1 ORDER BY recorded_at', [ids.organization])).rows;
  ok(revisions.length === 4 && revisions[0].fresh && revisions[0].reason === 'Forgot to clock in' && !revisions[1].fresh && revisions[1].entry_version === 2 && revisions[1].actor_principal_id === OWN.principal, 'each fix keeps a revision with the reason');

  // 7. Approve and reopen a week; an approved week is locked; an open entry blocks approval.
  const dec = (actor, patch = {}) => ({ staffPrincipalId: CLK.principal, weekStart: LAST, action: 'APPROVE', expectedVersion: 0, ...patch });
  await refused(() => decide(CLK, dec()), 403, undefined, 'a clocker cannot approve');
  await refused(() => decide(MGR, dec(CLK, { weekStart: '2026-11-17' })), 400, 'VALIDATION_FAILED', 'not a Monday');
  await refused(() => decide(MGR, dec(CLK, { action: 'REOPEN', expectedVersion: 0 })), 400, 'VALIDATION_FAILED', 'reopen what was never approved');
  await refused(() => decide(MGR, dec(CLK, { staffPrincipalId: OTHER_ORG.principal })), 403, 'STAFF_MEMBER_UNAVAILABLE', 'someone with no time here');
  const dkey = randomUUID();
  const approved = await success(() => decide(MGR, dec(), { key: dkey }), 'approve');
  ok(approved.data.status === 'APPROVED' && approved.data.version === 1, 'approved at version 1');
  ok((await success(() => decide(MGR, dec(), { key: dkey }), 'approve replay')).meta.replayed === true, 'approval replay');
  await refused(() => decide(MGR, dec(CLK, { expectedVersion: 1 })), 409, 'VERSION_CONFLICT', 'approve twice');
  await refused(() => fix(MGR, entryFix(CLK, { entryId: add.entryId, expectedVersion: 2, clockIn: `${LAST}T07:30` })), 409, 'TIMESHEET_APPROVED', 'fix inside an approved week');
  await refused(() => fix(MGR, entryFix(CLK, { clockIn: `${LAST}T18:00`, clockOut: `${LAST}T19:00` })), 409, 'TIMESHEET_APPROVED', 'add inside an approved week');
  ok((await success(() => sheet(MGR, LAST), 'last week')).data.people.find((p) => p.principalId === CLK.principal).approval.status === 'APPROVED', 'the timesheet shows the approval');
  const reopened = (await success(() => decide(OWN, dec(CLK, { action: 'REOPEN', expectedVersion: 1 })), 'reopen')).data;
  ok(reopened.status === 'OPEN' && reopened.version === 2, 'reopened at version 2');
  await success(() => fix(MGR, entryFix(CLK, { entryId: add.entryId, expectedVersion: 2, clockIn: `${LAST}T07:30`, reason: 'Opened the school' })), 'fix after reopen');
  const reIn = (await success(() => punch(CLK, 'CLOCK_IN', 0), 'clock in again')).data;
  await refused(() => decide(MGR, dec(CLK, { weekStart: THIS })), 409, 'TIMESHEET_HAS_OPEN_ENTRY', 'approval while clocked in');
  await pause(5);
  await success(() => punch(CLK, 'CLOCK_OUT', reIn.version), 'clock out again');
  await success(() => decide(MGR, dec(CLK, { weekStart: THIS })), 'approve this week');
  await refused(() => punch(CLK, 'CLOCK_IN', 0), 409, 'TIMESHEET_APPROVED', 'clock in to an approved week');
  ok((await success(() => myClock(CLK), 'clock in an approved week')).data.approval.status === 'APPROVED', 'my clock shows the approval');
  await success(() => decide(MGR, dec(CLK, { weekStart: THIS, action: 'REOPEN', expectedVersion: 1 })), 'reopen this week');
  // 0495: nobody approves their own week, except the school's system OWNER.
  const weekRows = async (who) => (await sql('SELECT count(*)::int n FROM hon.staff_timesheet_weeks WHERE principal_id=$1', [who.principal])).rows[0].n;
  await refused(() => decide(MGR, dec(MGR, { staffPrincipalId: MGR.principal, weekStart: LAST })), 403, 'TIMESHEET_SELF_APPROVAL', 'a manager cannot approve their own week');
  ok(await weekRows(MGR) === 0, 'a refused self-approval writes nothing');
  const ownWeek = (await success(() => decide(OWN, dec(OWN, { staffPrincipalId: OWN.principal, weekStart: LAST })), 'the owner approves their own week')).data;
  ok(ownWeek.status === 'APPROVED' && ownWeek.version === 1, 'owner self-approval is recorded');
  await success(() => decide(OWN, dec(OWN, { staffPrincipalId: OWN.principal, weekStart: LAST, action: 'REOPEN', expectedVersion: 1 })), 'the owner reopens their own week');
  const mgrOnOwner = await success(() => decide(MGR, dec(OWN, { staffPrincipalId: OWN.principal, weekStart: LAST, expectedVersion: 2 })), 'a manager approves someone else (the owner)');
  ok(mgrOnOwner.data.status === 'APPROVED', 'approving another person is unchanged');

  // 8. Access lost mid-way: grant revoked, school suspended, paid access lapsed.
  for (const [label, take, restore] of [
    ['grant revoked', 'UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=principal_id WHERE id=$1', 'UPDATE hon.principal_role_grants SET revoked_at=NULL, revoked_by_principal_id=NULL WHERE id=$1'],
    ['school suspended', "UPDATE hon.schools SET status='SUSPENDED' WHERE id=(SELECT school_id FROM hon.principal_role_grants WHERE id=$1)", "UPDATE hon.schools SET status='ACTIVE' WHERE id=(SELECT school_id FROM hon.principal_role_grants WHERE id=$1)"],
    ['access lapsed', "UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=(SELECT organization_id FROM hon.principal_role_grants WHERE id=$1)",
      "UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=(SELECT organization_id FROM hon.principal_role_grants WHERE id=$1)"]]) {
    await sql(take, [LOSER.grants[0]]);
    await refused(() => myClock(LOSER), 403, undefined, `${label}: read`);
    await refused(() => punch(LOSER, 'CLOCK_IN', 0), 403, undefined, `${label}: punch`);
    await sql(restore, [LOSER.grants[0]]);
  }
  await success(() => punch(LOSER, 'CLOCK_IN', 0), 'loser restored');

  // 9. Audit and inert outbox for every write; revisions for every fix.
  const entryWrites = (await sql('SELECT coalesce(sum(version),0)::int n FROM hon.staff_time_entries WHERE organization_id=$1 AND id<>$2', [ids.organization, tooLong])).rows[0].n
    + (await sql('SELECT version-1 n FROM hon.staff_time_entries WHERE id=$1', [tooLong])).rows[0].n;
  const weekWrites = (await sql('SELECT coalesce(sum(version),0)::int n FROM hon.staff_timesheet_weeks WHERE organization_id=$1', [ids.organization])).rows[0].n;
  const audit = (await sql("SELECT count(*) FILTER (WHERE entity_type='STAFF_TIME_ENTRY')::int e, count(*) FILTER (WHERE entity_type='STAFF_TIMESHEET_WEEK')::int w FROM hon.audit_events WHERE organization_id=$1", [ids.organization])).rows[0];
  const outbox = (await sql("SELECT count(*) FILTER (WHERE aggregate_type='STAFF_TIME_ENTRY')::int e, count(*) FILTER (WHERE aggregate_type='STAFF_TIMESHEET_WEEK')::int w, bool_and(NOT payload ? 'reason') shape FROM hon.outbox_events WHERE organization_id=$1 AND aggregate_type IN ('STAFF_TIME_ENTRY','STAFF_TIMESHEET_WEEK') AND status='PENDING'", [ids.organization])).rows[0];
  ok(audit.e === entryWrites && outbox.e === entryWrites && audit.w === weekWrites && outbox.w === weekWrites && outbox.shape, `one audit and one pending outbox event per write (${entryWrites}/${audit.e}/${outbox.e}, ${weekWrites}/${audit.w}/${outbox.w})`);

  // 10. Guards, whoever writes (inside one rolled-back transaction).
  await sql('BEGIN');
  await rejectsSql(() => sql('DELETE FROM hon.staff_time_entries WHERE id=$1', [e1.entryId]), /IMMUTABLE/, 'delete entry');
  await rejectsSql(() => sql('TRUNCATE hon.staff_time_entries CASCADE'), /IMMUTABLE/, 'truncate entries');
  await rejectsSql(() => sql("UPDATE hon.staff_time_entries SET timezone=timezone WHERE id=$1", [e1.entryId]), /IMMUTABLE/, 'no version bump');
  await rejectsSql(() => sql('UPDATE hon.staff_time_entries SET principal_id=$2, version=version+1 WHERE id=$1', [e1.entryId, MGR.principal]), /IMMUTABLE/, 'person changed');
  await rejectsSql(() => sql("UPDATE hon.staff_time_entries SET origin='MANAGER', version=version+1 WHERE id=$1", [e1.entryId]), /IMMUTABLE/, 'origin changed');
  await rejectsSql(() => sql("UPDATE hon.staff_time_entry_revisions SET reason='changed'"), /IMMUTABLE/, 'revision changed');
  await rejectsSql(() => sql('DELETE FROM hon.staff_time_entry_revisions WHERE organization_id=$1', [ids.organization]), /IMMUTABLE/, 'revision deleted');
  await rejectsSql(() => sql('DELETE FROM hon.staff_timesheet_weeks WHERE organization_id=$1', [ids.organization]), /IMMUTABLE/, 'week deleted');
  await rejectsSql(() => sql("UPDATE hon.staff_timesheet_weeks SET version=version+1 WHERE organization_id=$1", [ids.organization]), /IMMUTABLE/, 'week status unchanged');
  ok((await sql("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='hon' AND table_name='staff_time_entries' AND column_name='breaks'")).rows[0].n === 0, 'hours only: no breaks column');
  await rejectsSql(() => sql("UPDATE hon.staff_time_entries SET clock_out_at=clock_in_at+interval '25 hours', version=version+1 WHERE id=$1", [e1.entryId]), /check constraint/, 'over 24 hours stored directly');
  await rejectsSql(() => sql("INSERT INTO hon.staff_time_entries(organization_id,school_id,principal_id,local_date,timezone,clock_in_at,origin,created_by_principal_id,updated_by_principal_id) VALUES($1,$2,$3,(date_trunc('milliseconds',clock_timestamp()) AT TIME ZONE $4)::date,$4,date_trunc('milliseconds',clock_timestamp()),'CLOCK',$3,$3)",
    [ids.organization, ids.schoolA, LOSER.principal, LA]), /staff_time_entries_one_open/, 'a second open entry stored directly');
  await sql('ROLLBACK');

  // 11. Runtime ACL: five definer entry points only; helpers and tables private.
  for (const fn of ['staff_time_clock_punch(text,jsonb,text,uuid,uuid)', 'read_my_time_clock(text)', 'read_staff_timesheet_week(text,date)', 'save_staff_time_entry(text,jsonb,text,uuid,uuid)', 'set_staff_timesheet_week(text,jsonb,text,uuid,uuid)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, p.prosecdef, EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(r.runtime && r.prosecdef && !r.public, `runtime may execute definer ${fn}; PUBLIC may not`);
  }
  for (const fn of ['staff_time_local_ok(jsonb)', 'guard_staff_time()', 'require_staff_time_actor(text,text)',
    'staff_time_entry_json(hon.staff_time_entries)', 'staff_timesheet_week_json(uuid,uuid,uuid,date)', 'staff_time_week_of(date)', 'staff_time_week_approved(uuid,uuid,uuid,date)',
    'staff_time_begin(text,text,text,jsonb,text,uuid)', 'staff_time_finish(text,text,text,uuid,jsonb)', 'staff_time_record(text,uuid,jsonb,jsonb,integer,uuid,uuid,uuid,jsonb)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!r.runtime && !r.public, `helper ${fn} is private`);
  }
  for (const table of ['staff_time_entries', 'staff_time_entry_revisions', 'staff_timesheet_weeks']) {
    const t = (await sql(`SELECT c.relrowsecurity AND c.relforcerowsecurity forced, has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT')
      OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_any_column_privilege($1,c.oid,'SELECT') runtime FROM pg_class c WHERE c.oid=$2::regclass`,
      [CRM_CLOSE_RUNTIME_ROLE, `hon.${table}`])).rows[0];
    ok(t.forced && !t.runtime, `${table}: forced RLS, no runtime privilege`);
    await assert.rejects(runtime.query(`SELECT * FROM hon.${table} LIMIT 1`), /permission denied/); checks += 1;
  }
  await assert.rejects(runtime.query("SELECT hon.read_my_time_clock('x')"), /STAFF_TIME_FORBIDDEN/); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    for (const [begin, end] of [['-- Staff time clock exact verification (0478)', '-- End staff time clock exact verification.'],
      ['-- Staff timesheet no-self-approval exact verification (0495)', '-- End staff timesheet no-self-approval exact verification.']]) {
      const section = verify.split(begin)[1]?.split(end)[0];
      ok(section, begin);
      await sql(section.replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1;
    } }

  // 12. Time tracking only: no message, payment or invoice.
  ok((await sql("SELECT (SELECT count(*) FROM hon.payment_attempts WHERE organization_id=ANY($1::uuid[])) + (SELECT count(*) FROM hon.invoices WHERE organization_id=ANY($1::uuid[])) + (SELECT count(*) FROM hon.communication_messages WHERE organization_id=ANY($1::uuid[])) n",
    [[ids.organization, ids.otherOrganization]])).rows[0].n === '0', 'no message, payment attempt or invoice was created');

  console.log(`PASS: staff time clock (0478, 0495): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
