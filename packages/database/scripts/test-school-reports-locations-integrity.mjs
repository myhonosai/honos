/**
 * School reports across locations proof (R2, 0332) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guard + global
 * ValidationPipe + HonExceptionFilter -> SchoolReportsController -> one protected definer function on the restricted runtime
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
const { SchoolReportsController } = await load('reports/school-reports.controller.js');
const { SchoolReportsService } = await load('reports/school-reports.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-school-reports-locations', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'schoolC', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [SchoolReportsController],
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

function call(actor, query = '', { headers = {}, school = actor.school, organization = actor.org, method = 'GET', path = 'reports/monthly/locations' } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/${path}${query ? `?${query}` : ''}`);
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
    await sql('DELETE FROM hon.hq_operator_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`locs-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`locs-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`locs-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`locs-${ids.organization}-%`]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `locs-${ids.organization}-${label}`;
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


let OWN, ONLY_A, NONE, BIG, VIEWER;
const extraSchools = [];
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Locations Org','Locations Org'),($2,'Locations Other Org','Locations Other Org')", orgs());
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", orgs());
  for (const [school, org, name, tz] of [[ids.schoolA, ids.organization, 'Westside Dojo', 'America/Los_Angeles'], [ids.schoolB, ids.organization, 'Eastside Dojo', 'America/New_York'],
    [ids.schoolC, ids.organization, 'Northside Dojo', 'America/Chicago'], [ids.otherSchool, ids.otherOrganization, 'Other Org Dojo', 'America/Los_Angeles']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, name, `locs-${school.slice(0, 8)}`, tz]);
  }
  const viewer = await role(ids.organization, ['reporting.view']); VIEWER = viewer;
  const other = await role(ids.otherOrganization, ['reporting.view']);
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  await grant(OWN, ids.organization, ids.schoolB, viewer);
  await grant(OWN, ids.otherOrganization, ids.otherSchool, other);
  await grant(OWN, ids.organization, ids.schoolC, await role(ids.organization, ['people.read', 'attendance.record']));
  ONLY_A = await staff('only-a', [viewer]);
  NONE = await staff('none', [await role(ids.organization, ['people.read'])]);
  BIG = await staff('big', [viewer]);
  // BIG reports at school A (its staff grant) and at 20 branches: 21 locations.
  for (let i = 0; i < 20; i += 1) {
    const id = randomUUID(); extraSchools.push(id);
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [id, ids.organization, `Branch ${i}`, `locs-${id.slice(0, 8)}`, 'America/Los_Angeles']);
    await grant(BIG, ids.organization, id, viewer);
  }
}
async function grant(actor, org, school, roleId) {
  const id = randomUUID();
  await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [id, org, school, actor.principal, roleId]);
  return id;
}
// A few records per school, different at each, so each location and the totals can be told apart.
async function records(org, school, n) {
  const program = randomUUID();
  await sql("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Adult Karate','SCHEDULED')", [program, org, school]);
  const tz = (await sql('SELECT timezone FROM hon.schools WHERE id=$1', [school])).rows[0].timezone;
  const start = (await sql("SELECT (date_trunc('month', clock_timestamp() AT TIME ZONE $1) - interval '1 month' + interval '3 days 10 hours') AT TIME ZONE $1 t", [tz])).rows[0].t;
  const session = randomUUID();
  await raw('class_sessions', `INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status)
    VALUES($1,$2,$3,$4,'Adult Karate',$5,$5::timestamptz+interval '1 hour',20,'WALK_IN','COMPLETED')`, [session, org, school, program, start]);
  const payer = randomUUID(), account = randomUUID();
  await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Payer','Locations')", [payer, org, school]);
  await sql('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id) VALUES($1,$2,$3,$4)', [account, org, school, payer]);
  for (let i = 0; i < n; i += 1) {
    const person = randomUUID(), student = randomUUID();
    await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Student','Locations')", [person, org, school]);
    await sql('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)', [student, org, school, person]);
    await raw('attendance_records', `INSERT INTO hon.attendance_records(organization_id,school_id,class_session_id,student_profile_id,status,progression_enabled,progression_weight_milli,progression_credit_milli)
      VALUES($1,$2,$3,$4,'PRESENT',false,0,0)`, [org, school, session, student]);
    await raw('memberships', `INSERT INTO hon.memberships(organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at)
      VALUES($1,$2,$3,$4,'MONTHLY','ACTIVE',$5)`, [org, school, account, person, start]);
  }
  await raw('invoices', `INSERT INTO hon.invoices(organization_id,school_id,billing_account_id,status,currency,subtotal_minor,total_minor,created_at)
    VALUES($1,$2,$3,'ISSUED','USD',$4,$4,$5)`, [org, school, account, n * 1000, start]);
}

try {
  await cleanup();
  await seed();
  await records(ids.organization, ids.schoolA, 2);
  await records(ids.organization, ids.schoolB, 3);
  await records(ids.organization, ids.schoolC, 5);
  await records(ids.otherOrganization, ids.otherSchool, 7);
  await startApp();

  // 1. The owner sees the two locations where they may see reports, from either one, and never the third or another organization.
  const fromA = await success(() => call(OWN, 'months=3'), 'owner from school A');
  const L = fromA.data;
  ok(L.organizationId === ids.organization && L.months === 3 && L.locations.length === 2, 'two locations');
  ok(L.locations.map((l) => l.schoolName).join() === 'Eastside Dojo,Westside Dojo', 'sorted by name: Eastside, Westside');
  ok(!JSON.stringify(L).includes(ids.schoolC) && !JSON.stringify(L).includes('Northside') && !JSON.stringify(L).includes(ids.otherSchool) && !JSON.stringify(L).includes('Other Org'),
    'no location without reporting.view and nothing from another organization');
  const east = L.locations.find((l) => l.schoolId === ids.schoolB), west = L.locations.find((l) => l.schoolId === ids.schoolA);
  ok(east.timezone === 'America/New_York' && west.timezone === 'America/Los_Angeles', 'each location in its own school time');
  ok(west.periods[1].attendance.checkIns === 2 && east.periods[1].attendance.checkIns === 3 && west.periods[1].enrollment.newMemberships === 2
    && east.periods[1].revenue[0].billedMinor === 3000 && west.periods[1].revenue[0].billedMinor === 2000, 'each location has its own totals');
  ok(east.periods[1].from !== west.periods[1].from, 'month starts follow each school time zone');
  const fromB = await success(() => call(OWN, 'months=3', { school: ids.schoolB }), 'owner from school B');
  ok(JSON.stringify(fromB.data.locations.map((l) => l.schoolId)) === JSON.stringify(L.locations.map((l) => l.schoolId)), 'the same locations from school B');
  // Each location matches that school's own 0331 report.
  const single = await success(() => call(OWN, 'months=3', { path: 'reports/monthly' }), 'owner single report at A');
  const strip = (periods) => periods.map(({ to, ...rest }) => rest);
  ok(JSON.stringify(strip(single.data.periods)) === JSON.stringify(strip(west.periods)), 'location A equals the school A report');

  // 2. Someone with reports at one school sees one location; refusals as in 0331.
  const one = await success(() => call(ONLY_A, 'months=3'), 'one-school reporter');
  ok(one.data.locations.length === 1 && one.data.locations[0].schoolId === ids.schoolA, 'one location');
  await refused(() => call(NONE, 'months=3'), 403, undefined, 'no reporting.view');
  await refused(() => call(OWN, 'months=3', { school: ids.schoolC }), 403, undefined, 'from a school where the owner may not see reports');
  await refused(() => call(OWN, 'months=3', { school: ids.otherSchool }), 403, undefined, 'the other organization route with the wrong organization id');
  await refused(() => call(OWN, 'months=13'), 400, undefined, 'months out of range');
  await refused(() => call(OWN, 'months=3', { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'with an idempotency key');
  await refused(() => call(OWN, 'months=3', { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'a source selector');

  // 3. More than 20 locations is refused, never shown in part.
  await refused(() => call(BIG, 'months=3', { school: extraSchools[0] }), 422, 'SCHOOL_REPORTS_TOO_MANY_LOCATIONS', '21 locations (school A and 20 branches)');

  // 4. Live: a revoked grant at B removes B at once.
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE principal_id=$1 AND school_id=$3', [OWN.principal, OWN.principal, ids.schoolB]);
  const after = await success(() => call(OWN, 'months=3'), 'after revoking B');
  ok(after.data.locations.length === 1 && after.data.locations[0].schoolId === ids.schoolA, 'B is gone once its grant is revoked');

  // 4b. Every other way reporting.view at B can be not live leaves B out, after a positive control that a live grant lists it.
  const listsB = async (label) => (await success(() => call(OWN, 'months=3'), label)).data.locations.some((l) => l.schoolId === ids.schoolB);
  const grantAtB = async (roleId, from = "clock_timestamp()-interval '1 day'", until = 'NULL') => {
    const id = randomUUID();
    await sql(`INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from,effective_until)
      VALUES($1,$2,$3,$4,$5,$4,${from},${until})`, [id, ids.organization, ids.schoolB, OWN.principal, roleId]);
    return id;
  };
  const dropGrant = (id) => sql('DELETE FROM hon.principal_role_grants WHERE id=$1', [id]);
  let live = await grantAtB(VIEWER);
  ok(await listsB('a live grant at B again'), 'positive control: a live reporting.view grant at B lists B');
  await sql("UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1", [ids.schoolB]);
  ok(!(await listsB('B suspended')), 'a suspended school B is not listed');
  await sql("UPDATE hon.schools SET status='ARCHIVED' WHERE id=$1", [ids.schoolB]);
  ok(!(await listsB('B archived')), 'an archived school B is not listed');
  await sql("UPDATE hon.schools SET status='ACTIVE' WHERE id=$1", [ids.schoolB]);
  // Not eligible staff (here an HQ operator): refused outright, and B is not allowed by the private check either.
  await sql("INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_SUPPORT')", [OWN.principal]);
  await refused(() => call(OWN, 'months=3'), 403, undefined, 'an HQ operator is not school staff');
  ok((await sql('SELECT hon.school_reports_location_allowed($1,$2,$3) allowed', [OWN.principal, ids.organization, ids.schoolB])).rows[0].allowed === false,
    'an HQ operator is not allowed at B');
  await sql('DELETE FROM hon.hq_operator_grants WHERE principal_id=$1', [OWN.principal]);
  ok(await listsB('after the HQ grant is removed'), 'B is listed again once the person is eligible staff');
  await dropGrant(live);
  for (const [label, make] of [
    ['an expired grant', () => grantAtB(VIEWER, "clock_timestamp()-interval '2 days'", "clock_timestamp()-interval '1 minute'")],
    ['a grant that starts tomorrow', () => grantAtB(VIEWER, "clock_timestamp()+interval '1 day'")],
    ['a PARENT role with reporting.view', async () => grantAtB(await role(ids.organization, ['reporting.view'], `PARENT_${randomUUID().slice(0, 8)}`))],
    ['a FAMILY role with reporting.view', async () => grantAtB(await role(ids.organization, ['reporting.view'], `FAMILY_${randomUUID().slice(0, 8)}`))],
    ['a role managed by school A granted at B', async () => {
      const managed = await role(ids.organization, ['reporting.view']);
      await raw('roles', 'UPDATE hon.roles SET management_school_id=$2 WHERE id=$1', [managed, ids.schoolA]);
      return grantAtB(managed);
    }],
  ]) {
    const id = await make();
    if (/PARENT|FAMILY/.test(label)) {
      // A family role anywhere makes the person not school staff: the whole read is refused, not just B.
      await refused(() => call(OWN, 'months=3'), 403, 'SCHOOL_REPORTS_FORBIDDEN', `${label} at B`);
    } else ok(!(await listsB(label)), `${label} at B does not list B`);
    ok((await sql('SELECT hon.school_reports_location_allowed($1,$2,$3) allowed', [OWN.principal, ids.organization, ids.schoolB])).rows[0].allowed === false,
      `${label}: B is not allowed by the private check`);
    await dropGrant(id);
  }
  ok(!(await listsB('every negative grant removed')), 'with none of those grants B stays out, and the read works again');

  // 5. Database boundary.
  const fns = (await sql(`SELECT p.oid::regprocedure::text sig, has_function_privilege($1,p.oid,'EXECUTE') runtime,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public, p.prosecdef definer
    FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace AND p.proname IN ('school_reports_location_allowed','read_school_reports_locations') ORDER BY 1`,
  [CRM_CLOSE_RUNTIME_ROLE])).rows;
  ok(fns.length === 2 && fns.every((f) => f.definer && !f.public), 'two definer functions, none public');
  ok(fns.filter((f) => f.runtime).map((f) => f.sig).join() === 'hon.read_school_reports_locations(text,jsonb)', 'the runtime may run only the locations read');
  await assert.rejects(runtime.query('SELECT hon.school_reports_location_allowed($1,$2,$3)', [OWN.principal, ids.organization, ids.schoolA]), /permission denied/); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const startMark = '-- School reports locations exact verification (R2 0332)', endMark = '-- End school reports locations exact verification.';
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: school reports across locations (0332): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
