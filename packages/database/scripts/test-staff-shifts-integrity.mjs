/**
 * Staff shift schedule proof (0467) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guards + global
 * ValidationPipe + HonExceptionFilter -> StaffShiftController -> protected definer functions on the restricted runtime role
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
const { StaffShiftController } = await load('staff-shifts/staff-shifts.controller.js');
const { StaffShiftService } = await load('staff-shifts/staff-shifts.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-staff-shifts', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const WEEK = '2026-11-16';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };


let app, origin;
const database = new RuntimeDatabaseService();
async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [StaffShiftController],
    providers: [HonIdentityGuard, HonIdentityService, StaffShiftService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}
const SAVE = 'staff_shift.save';
function call(actor, method, { body, key = randomUUID(), command = SAVE, headers = {}, school = actor.school, organization = actor.org, query = '', path = '' } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/staff/shifts${path}${query}`);
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
const read = (actor, week = WEEK, options = {}) => call(actor, 'GET', { path: `/weeks/${week}`, ...options });
const save = (actor, body, options = {}) => call(actor, 'POST', { body, ...options });
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
async function cleanup(orgs = [ids.organization, ids.otherOrganization], subjects = `%shifts-${ids.organization}-%`) {
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
    const left = (await sql('SELECT count(*)::int n FROM hon.staff_shifts WHERE organization_id = ANY($1::uuid[])', [orgs])).rows[0].n;
    if (left) throw new Error('fixture cleanup left a shift behind');
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
async function role(org, permissions, code) {
  const id = randomUUID();
  await sql('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)', [id, org, code ?? `STAFF_${id.slice(0, 8)}`]);
  for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [id, org, permission]);
  return id;
}
async function staff(label, roles, { org = ids.organization, school = ids.schoolA } = {}) {
  const user = randomUUID(), principal = randomUUID(), subject = `shifts-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Shift Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3)", [principal, user, `Staff ${label}`]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  return { subject, principal, grants, org, school };
}


const shift = (actor, patch = {}) => ({ shiftId: null, expectedVersion: 0, staffPrincipalId: actor.principal, date: '2026-11-18', start: '09:00', end: '13:00',
  position: 'Front desk', note: null, status: 'SCHEDULED', ...patch });
const count = async (where = '') => (await sql(`SELECT count(*)::int n FROM hon.staff_shifts WHERE organization_id=$1 ${where}`, [ids.organization])).rows[0].n;

let OWN, MGR, SELF, NONE, PARENTISH, OWN_B, OTHER_ORG, LOSER;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Shift Org','Shift Org'),($2,'Shift Other Org','Shift Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'CORE','ACTIVE',clock_timestamp()-interval '1 day'),($2,'CORE','ACTIVE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Shifts ${slug}`, `shifts-${slug}-${school.slice(0, 8)}`, LA]);
  }
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  MGR = await staff('manager', [await role(ids.organization, ['staff.shift.manage'])]);
  SELF = await staff('instructor', [await role(ids.organization, ['staff.shift.view_own', 'people.read'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read'])]);
  PARENTISH = await staff('parentish', [await role(ids.organization, ['staff.shift.view_own'], 'PARENT_PORTAL')]);
  OWN_B = await staff('owner-b', [await role(ids.organization, ['staff.shift.manage', 'staff.shift.view_own'])], { school: ids.schoolB });
  OTHER_ORG = await staff('other-org', [await role(ids.otherOrganization, allPermissions, 'OWNER')], { org: ids.otherOrganization, school: ids.otherSchool });
  LOSER = await staff('loser', [await role(ids.organization, ['staff.shift.manage'])]);
}

try {
  await cleanup();
  await seed();
  await startApp();

  // 0. Permissions and OWNER grants.
  ok((await sql("SELECT count(*)::int n FROM hon.permissions WHERE (code='staff.shift.manage' AND is_sensitive AND is_staff_assignable) OR (code='staff.shift.view_own' AND NOT is_sensitive AND is_staff_assignable)")).rows[0].n === 2, 'two staff-assignable permissions');
  ok((await sql(`SELECT count(*)::int n FROM hon.roles r CROSS JOIN unnest(ARRAY['staff.shift.manage','staff.shift.view_own']) c WHERE r.is_system_role AND r.code='OWNER'
    AND NOT EXISTS(SELECT 1 FROM hon.role_permissions rp WHERE rp.role_id=r.id AND rp.organization_id=r.organization_id AND rp.permission_code=c)`)).rows[0].n === 0, 'every system OWNER role holds both');

  // 1. Reads: managers see every eligible staff member; view_own sees only themselves; others refused.
  const empty = (await success(() => read(MGR), 'manager read')).data;
  const names = empty.staff.map((s) => s.principalId);
  ok(empty.mode === 'MANAGE' && empty.weekStart === WEEK && empty.timezone === LA && empty.shifts.length === 0 && empty.availability.length === 0, 'empty managed week');
  ok([OWN, MGR, SELF, NONE, LOSER].every((a) => names.includes(a.principal)) && !names.includes(PARENTISH.principal) && !names.includes(OWN_B.principal) && !names.includes(OTHER_ORG.principal),
    'eligible school-A staff only (no family role, other school or organization)');
  ok(empty.staff.every((s) => Object.keys(s).sort().join() === 'displayName,principalId'), 'display name only');
  const own = (await success(() => read(SELF), 'own read')).data;
  ok(own.mode === 'OWN' && own.staff.length === 1 && own.staff[0].principalId === SELF.principal && own.availability.length === 0, 'own week shows only themselves');
  for (const actor of [NONE, PARENTISH]) await refused(() => read(actor), 403, undefined, `read refused for ${actor.subject.split('-').pop()}`);
  await refused(() => read(OWN_B, WEEK, { school: ids.schoolA }), 403, undefined, 'school-B manager at the school-A route');
  await refused(() => read(OTHER_ORG, WEEK, { school: ids.schoolA, organization: ids.organization }), 403, undefined, 'other-organization owner at the school-A route');
  await refused(() => read(MGR, '2026-11-17'), 400, 'VALIDATION_FAILED', 'a week starts on Monday');
  await refused(() => read(MGR, '2026-02-30'), 400, 'VALIDATION_FAILED', 'not a date');
  await refused(() => read(MGR, WEEK, { query: '?all=1' }), 400, 'VALIDATION_FAILED', 'read with a query');
  await refused(() => read(MGR, WEEK, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'read with a key');
  await refused(() => read(MGR, WEEK, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-site read');
  await refused(() => read(MGR, WEEK, { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'read with a source header');

  // 2. Save refusals before anything is written.
  for (const actor of [SELF, NONE, PARENTISH]) await refused(() => save(actor, shift(actor)), 403, undefined, `save refused for ${actor.subject.split('-').pop()}`);
  await refused(() => save(OWN_B, shift(SELF), { school: ids.schoolA }), 403, undefined, 'school-B manager saving at school A');
  await refused(() => save(MGR, shift(SELF), { command: 'school_location.save' }), 403, 'HUMAN_UI_REQUIRED', 'another command header');
  await refused(() => save(MGR, shift(SELF), { key: '' }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'no key');
  for (const [label, value] of [['end before start', { start: '13:00', end: '09:00' }], ['ten minutes', { end: '09:10' }], ['seventeen hours', { start: '06:00', end: '23:30' }],
    ['bad end', { end: '24:30' }], ['bad date', { date: '2026-02-30' }], ['far future', { date: '2030-01-07' }], ['padded position', { position: ' Desk' }],
    ['markup note', { note: '<b>x</b>' }], ['long position', { position: 'x'.repeat(41) }], ['new shift cancelled', { status: 'CANCELLED' }],
    ['new shift at version 1', { expectedVersion: 1 }], ['bad person', { staffPrincipalId: 'nobody' }], ['number start', { start: 900 }]]) {
    await refused(() => save(MGR, shift(SELF, value)), 400, 'VALIDATION_FAILED', label);
  }
  await refused(() => save(MGR, { ...shift(SELF), extra: 1 }), 400, undefined, 'an extra field (the global pipe refuses it)');
  await refused(() => save(MGR, shift(PARENTISH)), 403, 'STAFF_MEMBER_UNAVAILABLE', 'a family-role person');
  await refused(() => save(MGR, shift(OWN_B)), 403, 'STAFF_MEMBER_UNAVAILABLE', 'staff of another school');
  await refused(() => save(MGR, shift(OTHER_ORG)), 403, 'STAFF_MEMBER_UNAVAILABLE', 'staff of another organization');
  ok(await count() === 0, 'no refusal wrote a shift');

  // 3. Create, replay, key reuse; school-local times become instants in the school's zone.
  const key1 = randomUUID();
  const created = await success(() => save(MGR, shift(SELF), { key: key1 }), 'create');
  const first = created.data;
  ok(first.version === 1 && first.status === 'SCHEDULED' && first.startsAt === '2026-11-18T17:00:00.000Z' && first.endsAt === '2026-11-18T21:00:00.000Z'
    && first.date === '2026-11-18' && first.start === '09:00' && created.meta.replayed === false, `created in Los Angeles time ${JSON.stringify(first)}`);
  const replay = await success(() => save(MGR, shift(SELF), { key: key1 }), 'replay');
  ok(replay.meta.replayed === true && JSON.stringify(replay.data) === JSON.stringify(first), 'exact replay returns the first receipt');
  await refused(() => save(MGR, shift(SELF, { start: '10:00' }), { key: key1 }), 409, 'IDEMPOTENCY_KEY_REUSED', 'same key, other body');
  const spring = (await success(() => save(MGR, shift(SELF, { date: '2026-03-08', start: '01:00', end: '05:00' })), 'spring-forward day')).data;
  ok(spring.startsAt === '2026-03-08T09:00:00.000Z' && spring.endsAt === '2026-03-08T12:00:00.000Z', `spring forward: four local hours are three real hours ${spring.startsAt} ${spring.endsAt}`);
  const late = (await success(() => save(MGR, shift(OWN, { date: '2026-11-22', start: '20:00', end: '24:00' })), 'until midnight')).data;
  ok(late.endsAt === '2026-11-23T08:00:00.000Z' && late.end === '24:00', 'a shift may end at midnight');

  // 4. Overlap: refused for the same person, fine back-to-back or for someone else; one wins a race.
  await refused(() => save(MGR, shift(SELF, { start: '12:00', end: '15:00' })), 409, 'SHIFT_OVERLAP', 'overlapping shift');
  await refused(() => save(OWN, shift(SELF, { start: '08:00', end: '18:00' })), 409, 'SHIFT_OVERLAP', 'containing shift');
  const after = (await success(() => save(MGR, shift(SELF, { start: '13:00', end: '17:00', position: 'Instructor' })), 'back-to-back')).data;
  await success(() => save(MGR, shift(MGR, { start: '09:00', end: '13:00' })), 'same time, another person');
  // The same person may also work for another organization at the same time: that organization's shift neither blocks
  // nor reveals anything here (the overlap check is scoped to this organization).
  await sql("INSERT INTO hon.staff_shifts(organization_id,school_id,principal_id,local_date,start_time,end_time,timezone,starts_at,ends_at,status,created_by_principal_id,updated_by_principal_id) VALUES($1,$2,$3,'2026-11-18','15:00','16:00',$4,'2026-11-18T23:00:00Z','2026-11-19T00:00:00Z','SCHEDULED',$3,$3)",
    [ids.otherOrganization, ids.otherSchool, NONE.principal, LA]);
  await success(() => save(MGR, shift(NONE, { start: '15:00', end: '16:00' })), 'same person, same time, another organization');
  const race = await Promise.all([save(MGR, shift(NONE, { start: '10:00', end: '12:00' })), save(OWN, shift(NONE, { start: '11:00', end: '14:00' }))]);
  ok(race.map((r) => r.status).sort().join() === '200,409' && race.find((r) => r.status === 409).body.code === 'SHIFT_OVERLAP', `exactly one of two racing overlaps wins ${race.map((r) => r.status)}`);

  // 5. Change, stale version, person fixed, cancel, cancelled is final.
  const moved = (await success(() => save(MGR, shift(SELF, { shiftId: first.shiftId, expectedVersion: 1, start: '08:00', end: '12:00', note: 'Opening' })), 'move')).data;
  ok(moved.version === 2 && moved.shiftId === first.shiftId && moved.startsAt === '2026-11-18T16:00:00.000Z' && moved.note === 'Opening', 'moved to version 2');
  await refused(() => save(MGR, shift(SELF, { shiftId: first.shiftId, expectedVersion: 1 })), 409, 'VERSION_CONFLICT', 'stale version');
  await refused(() => save(MGR, shift(MGR, { shiftId: first.shiftId, expectedVersion: 2 })), 400, 'VALIDATION_FAILED', 'person changed on edit');
  await refused(() => save(MGR, shift(SELF, { shiftId: randomUUID(), expectedVersion: 1 })), 404, 'STAFF_SHIFT_NOT_FOUND', 'unknown shift');
  await refused(() => save(OWN_B, shift(SELF, { shiftId: first.shiftId, expectedVersion: 2 }), { school: ids.schoolB }), 404, 'STAFF_SHIFT_NOT_FOUND', 'school B cannot find a school-A shift by id');
  await refused(() => save(OWN_B, shift(OWN_B, { shiftId: first.shiftId, expectedVersion: 2 }), { school: ids.schoolB }), 404, 'STAFF_SHIFT_NOT_FOUND', 'school B cannot find a school-A shift');
  await refused(() => save(MGR, shift(SELF, { shiftId: first.shiftId, expectedVersion: 2, start: '12:30', end: '14:00' })), 409, 'SHIFT_OVERLAP', 'moving onto another shift');
  const cancelled = (await success(() => save(MGR, shift(SELF, { shiftId: after.shiftId, expectedVersion: 1, start: '13:00', end: '17:00', position: 'Instructor', status: 'CANCELLED' })), 'cancel')).data;
  ok(cancelled.status === 'CANCELLED' && cancelled.version === 2, 'cancelled at version 2');
  await refused(() => save(MGR, shift(SELF, { shiftId: after.shiftId, expectedVersion: 2, start: '13:00', end: '17:00' })), 409, 'STAFF_SHIFT_CANCELLED', 'a cancelled shift never comes back');
  await success(() => save(MGR, shift(SELF, { start: '13:00', end: '17:00' })), 'the cancelled slot is free again');

  // 6. The week read: shifts of the week in time order, own view, availability windows from 0077.
  const managed = (await success(() => read(MGR), 'managed week')).data;
  ok(managed.shifts.length === 7 && managed.shifts.every((s, i, a) => i === 0 || a[i - 1].startsAt <= s.startsAt) && !managed.shifts.some((s) => s.date === '2026-03-08')
    && managed.shifts.filter((s) => s.staffPrincipalId === NONE.principal && s.start === '15:00').length === 1, 'seven shifts this week, in time order, March and the other organization not included');
  const mine = (await success(() => read(SELF), 'own week')).data;
  ok(mine.shifts.length === 3 && mine.shifts.every((s) => s.staffPrincipalId === SELF.principal), 'own view: only own shifts (including the cancelled one)');
  ok((await success(() => read(SELF, '2026-03-02'), 'own March week')).data.shifts.length === 1, 'the spring-forward shift is in its own week');
  await sql('BEGIN');
  await sql('ALTER TABLE hon.staff_profiles DISABLE TRIGGER USER'); await sql('ALTER TABLE hon.staff_planning_revisions DISABLE TRIGGER USER');
  const profile = randomUUID();
  await sql('INSERT INTO hon.staff_profiles(id,organization_id,school_id,principal_id,created_by_principal_id) VALUES($1,$2,$3,$4,$4)', [profile, ids.organization, ids.schoolA, SELF.principal]);
  const windows = [{ weekday: 3, start: '08:00', end: '18:00' }];
  for (const [v, payload] of [[1, { expectedVersion: 0, status: 'ACTIVE', effectiveFrom: '2026-01-01', endsOn: null, windows: [{ weekday: 1, start: '08:00', end: '09:00' }] }],
    [2, { expectedVersion: 1, status: 'ACTIVE', effectiveFrom: '2026-01-01', endsOn: null, windows }]]) {
    await sql("INSERT INTO hon.staff_planning_revisions(profile_id,organization_id,school_id,kind,version,actor_principal_id,source,request_id,timezone,payload) VALUES($1,$2,$3,'AVAILABILITY',$4,$5,'HUMAN_UI',gen_random_uuid(),$6,$7)",
      [profile, ids.organization, ids.schoolA, v, SELF.principal, LA, JSON.stringify(payload)]);
  }
  await sql('ALTER TABLE hon.staff_profiles ENABLE TRIGGER USER'); await sql('ALTER TABLE hon.staff_planning_revisions ENABLE TRIGGER USER');
  await sql('COMMIT');
  const withAvailability = (await success(() => read(MGR), 'week with availability')).data;
  ok(withAvailability.availability.length === 1 && withAvailability.availability[0].principalId === SELF.principal
    && JSON.stringify(withAvailability.availability[0].windows) === JSON.stringify(windows), 'the latest saved availability of each person');
  ok((await success(() => read(SELF), 'own week again')).data.availability.length === 0, 'own view carries no availability');

  // 7. Live authority loss.
  await success(() => read(LOSER), 'loser before');
  for (const [label, take, restore] of [
    ['grant revoked', 'UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=principal_id WHERE id=$1', 'UPDATE hon.principal_role_grants SET revoked_at=NULL, revoked_by_principal_id=NULL WHERE id=$1'],
    ['school suspended', "UPDATE hon.schools SET status='SUSPENDED' WHERE id=(SELECT school_id FROM hon.principal_role_grants WHERE id=$1)", "UPDATE hon.schools SET status='ACTIVE' WHERE id=(SELECT school_id FROM hon.principal_role_grants WHERE id=$1)"],
    ['access lapsed', "UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=(SELECT organization_id FROM hon.principal_role_grants WHERE id=$1)",
      "UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=(SELECT organization_id FROM hon.principal_role_grants WHERE id=$1)"]]) {
    await sql(take, [LOSER.grants[0]]);
    await refused(() => read(LOSER), 403, undefined, `${label}: read`);
    await refused(() => save(LOSER, shift(LOSER, { date: '2026-11-20' })), 403, undefined, `${label}: save`);
    await sql(restore, [LOSER.grants[0]]);
  }
  await success(() => save(LOSER, shift(LOSER, { date: '2026-11-20' })), 'loser restored');

  // 8. Audit and inert outbox for every write.
  const writes = await count() + (await sql("SELECT coalesce(sum(version-1),0)::int n FROM hon.staff_shifts WHERE organization_id=$1", [ids.organization])).rows[0].n;
  const auditRow = (await sql("SELECT count(*)::int n, bool_and(NOT next_state ? 'note' AND NOT next_state ? 'position' AND NOT coalesce(prior_state ? 'note' OR prior_state ? 'position',false) AND next_state ? 'startsAt') shape FROM hon.audit_events WHERE organization_id=$1 AND entity_type='STAFF_SHIFT'", [ids.organization])).rows[0];
  const audit = auditRow.n;
  ok(auditRow.shape, 'the audit keeps times but never the free-text note or position');
  const outbox = (await sql("SELECT count(*)::int n, bool_and(NOT payload ? 'note' AND NOT payload ? 'position') shape FROM hon.outbox_events WHERE organization_id=$1 AND aggregate_type='STAFF_SHIFT' AND status='PENDING'", [ids.organization])).rows[0];
  ok(audit === writes && outbox.n === writes && outbox.shape, `one audit and one pending outbox event (no free text) per write (${writes}/${audit}/${outbox.n})`);

  // 9. Guards, whoever writes (inside one rolled-back transaction).
  await sql('BEGIN');
  await rejectsSql(() => sql('DELETE FROM hon.staff_shifts WHERE id=$1', [first.shiftId]), /IMMUTABLE/, 'delete');
  await rejectsSql(() => sql('TRUNCATE hon.staff_shifts'), /IMMUTABLE/, 'truncate');
  await rejectsSql(() => sql("UPDATE hon.staff_shifts SET note='x' WHERE id=$1", [first.shiftId]), /IMMUTABLE/, 'no version bump');
  await rejectsSql(() => sql('UPDATE hon.staff_shifts SET principal_id=$2, version=version+1 WHERE id=$1', [first.shiftId, MGR.principal]), /IMMUTABLE/, 'person changed');
  await rejectsSql(() => sql("UPDATE hon.staff_shifts SET status='SCHEDULED', version=version+1 WHERE id=$1", [after.shiftId]), /IMMUTABLE/, 'cancelled revived');
  await rejectsSql(() => sql("UPDATE hon.staff_shifts SET end_time='08:05', version=version+1 WHERE id=$1", [first.shiftId]), /check constraint/, 'invalid times stored directly');
  await rejectsSql(() => sql("UPDATE hon.staff_shifts SET position=' x', version=version+1 WHERE id=$1", [first.shiftId]), /check constraint/, 'invalid text stored directly');
  await sql('ROLLBACK');

  // 10. Runtime ACL: two definer entry points only; helpers and the table private.
  for (const fn of ['read_staff_shift_week(text,date)', 'save_staff_shift(text,jsonb,text,uuid,uuid)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, p.prosecdef, EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(r.runtime && r.prosecdef && !r.public, `runtime may execute definer ${fn}; PUBLIC may not`);
  }
  for (const fn of ['staff_shift_text_ok(jsonb,integer)', 'staff_shift_minutes(text,boolean)', 'staff_shift_date_ok(jsonb)', 'guard_staff_shift()',
    'require_staff_shift_actor(text,text)', 'staff_shift_json(hon.staff_shifts)', 'staff_shift_display_name(uuid)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!r.runtime && !r.public, `helper ${fn} is private`);
  }
  { const t = (await sql(`SELECT c.relrowsecurity AND c.relforcerowsecurity forced, has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT')
      OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_any_column_privilege($1,c.oid,'SELECT') runtime FROM pg_class c WHERE c.oid='hon.staff_shifts'::regclass`,
      [CRM_CLOSE_RUNTIME_ROLE])).rows[0];
    ok(t.forced && !t.runtime, 'staff_shifts: forced RLS, no runtime privilege');
    await assert.rejects(runtime.query('SELECT * FROM hon.staff_shifts LIMIT 1'), /permission denied/); checks += 1; }
  await assert.rejects(runtime.query("SELECT hon.read_staff_shift_week('x','2026-11-16')"), /STAFF_SHIFT_FORBIDDEN/); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const begin = '-- Staff shift schedule exact verification (0467)', end = '-- End staff shift exact verification.';
    const section = verify.split(begin)[1]?.split(end)[0];
    ok(section, begin);
    await sql(section.replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  // 11. Scheduling only: no message, payment or invoice.
  ok((await sql("SELECT (SELECT count(*) FROM hon.payment_attempts WHERE organization_id=ANY($1::uuid[])) + (SELECT count(*) FROM hon.invoices WHERE organization_id=ANY($1::uuid[])) + (SELECT count(*) FROM hon.communication_messages WHERE organization_id=ANY($1::uuid[])) n",
    [[ids.organization, ids.otherOrganization]])).rows[0].n === '0', 'no message, payment attempt or invoice was created');

  console.log(`PASS: staff shift schedule (0467): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
