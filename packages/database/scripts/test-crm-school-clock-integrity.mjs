/**
 * B-CRM-3 CRM school clock proof (0236): GET /v1/organizations/:org/schools/:school/crm/school-clock over signed HTTP
 * (HON session cookie -> HonIdentityGuard + global ValidationPipe + HonExceptionFilter -> controller ->
 * hon.read_crm_school_clock on the restricted runtime role), on the guarded disposable CRM-close fixture only.
 * Synthetic data only. The read writes nothing; every CRM command keeps receiving offset-qualified instants.
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
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
const { CrmSchoolClockController, CrmSchoolClockHumanUiGuard } = await load('crm/crm-school-clock.controller.js');
const { CrmSchoolClockService } = await load('crm/crm-school-clock.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-crm-school-clock', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const ZONES = { [ids.schoolA]: 'America/Los_Angeles', [ids.schoolB]: 'Asia/Seoul', [ids.otherSchool]: 'Europe/Madrid' };
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();
const PREFIX = `crm-clock-${ids.organization}`;

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [CrmSchoolClockController],
    providers: [HonIdentityGuard, HonIdentityService, CrmSchoolClockHumanUiGuard, CrmSchoolClockService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}
function read(actor, { school = actor.school, organization = actor.org, headers = {}, query = '', method = 'GET' } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/crm/school-clock${query}`);
  return new Promise((resolvePromise, reject) => {
    const request = http.request(target, { method, headers: {
      Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`,
      Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json', ...headers,
    } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => { try { resolvePromise({ status: response.statusCode, headers: response.headers, body: text ? JSON.parse(text) : null }); } catch (error) { reject(error); } });
    });
    request.on('error', reject);
    request.end();
  });
}
const localDate = async (zone) => (await sql('SELECT (clock_timestamp() AT TIME ZONE $1)::date::text d', [zone])).rows[0].d;
async function clock(actor, label, options = {}) {
  const school = options.school ?? actor.school;
  const before = Date.now();
  const { status, body, headers } = await read(actor, options);
  assert.equal(status, 200, `${label}: expected 200, got ${status} ${JSON.stringify(body).slice(0, 300)}`);
  ok(headers['cache-control'] === 'private, no-store', `${label}: never cached`);
  ok(Object.keys(body).sort().join(',') === 'data,meta' && Object.keys(body.meta).sort().join(',') === 'correlationId,requestId', `${label}: closed envelope`);
  ok(Object.keys(body.data).sort().join(',') === 'asOf,localToday,schoolId,schoolTimezone', `${label}: closed clock`);
  ok(body.data.schoolId === school && body.data.schoolTimezone === ZONES[school], `${label}: this school and its zone`);
  ok(body.data.localToday === await localDate(ZONES[school]), `${label}: the school's local today`);
  ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(body.data.asOf) && Math.abs(Date.parse(body.data.asOf) - before) < 60_000, `${label}: current UTC read instant`);
  return body.data;
}
async function refused(actor, expectedStatus, expectedCode, label, options = {}) {
  const { status, body } = await read(actor, options);
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 300)}`);
  if (expectedCode) assert.equal(body?.code, expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(body).slice(0, 300)}`);
  ok(!body || !('data' in body), `${label}: a refusal returns no clock`);
}

async function cleanup() {
  await sql('BEGIN');
  try {
    for (const table of ['principal_role_grants', 'role_permissions', 'roles', 'organization_entitlements']) {
      await sql(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);
      await sql(`DELETE FROM hon.${table} WHERE organization_id = ANY($1::uuid[])`, [[ids.organization, ids.otherOrganization]]);
      await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);
    }
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}
async function role(org, permissions, code) {
  const id = randomUUID();
  await sql('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)', [id, org, code ?? `STAFF_${id.slice(0, 8)}`]);
  for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [id, org, permission]);
  return id;
}
async function staff(label, roles, { org = ids.organization, school = ids.schoolA } = {}) {
  const user = randomUUID(), principal = randomUUID(), subject = `${PREFIX}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'CRM Clock Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'CRM Clock Staff')", [principal, user]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  return { subject, principal, grants, org, school };
}
const evidenceCount = async () => (await sql('SELECT (SELECT count(*) FROM hon.audit_events)::int + (SELECT count(*) FROM hon.outbox_events)::int n')).rows[0].n;

try {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'CRM Clock Org','CRM Clock Org'),($2,'CRM Clock Other Org','CRM Clock Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `CRM Clock ${slug}`, `crm-clock-${slug}-${school.slice(0, 8)}`, ZONES[school]]);
  }
  const SCHEDULER = await staff('scheduler', [await role(ids.organization, ['crm.trial.schedule'])]);
  const MANAGER = await staff('manager', [await role(ids.organization, ['crm.trial.manage'])]);
  const FOLLOW = await staff('follow', [await role(ids.organization, ['crm.follow_up.manage'])]);
  const SELF = await staff('self', [await role(ids.organization, ['crm.follow_up.self_manage'])]);
  const NONE = await staff('none', [await role(ids.organization, ['people.read', 'crm.lead.read', 'reporting.view'])]);
  const FAMILY = await staff('family', [await role(ids.organization, ['crm.trial.schedule'], 'PARENT_PORTAL')]);
  const SCHOOL_B = await staff('school-b', [await role(ids.organization, ['crm.trial.schedule'])], { school: ids.schoolB });
  const OTHER = await staff('other-org', [await role(ids.otherOrganization, ['crm.trial.schedule'])], { org: ids.otherOrganization, school: ids.otherSchool });
  await startApp();
  const evidence = await evidenceCount();

  // 1. Each CRM time permission reads its own school's clock.
  for (const [actor, label] of [[SCHEDULER, 'trial scheduler'], [MANAGER, 'trial manager'], [FOLLOW, 'follow-up manager'], [SELF, 'follow-up self-manager']]) await clock(actor, label);
  await clock(SCHOOL_B, 'school B in Seoul');
  await clock(OTHER, 'other organization in Madrid');
  { const upper = await read(SCHEDULER, { school: ids.schoolA.toUpperCase(), organization: ids.organization.toUpperCase() });
    ok(upper.status === 200 && upper.body.data.schoolId === ids.schoolA, 'uppercase route ids read the same lower-case school'); }

  // 2. Authority refusals.
  await refused(NONE, 403, 'CRM_SCHOOL_CLOCK_FORBIDDEN', 'no CRM time permission');
  await refused(FAMILY, 403, 'CRM_SCHOOL_CLOCK_FORBIDDEN', 'family-type role code never counts');
  await refused(SCHEDULER, 403, 'CRM_SCHOOL_CLOCK_FORBIDDEN', 'school-A staff at the school-B route', { school: ids.schoolB });
  await refused(SCHEDULER, 403, 'CRM_SCHOOL_CLOCK_FORBIDDEN', 'school-A staff at the other organization', { organization: ids.otherOrganization, school: ids.otherSchool });
  await refused(SCHEDULER, 403, 'CRM_SCHOOL_CLOCK_FORBIDDEN', 'mismatched organization in the route', { organization: ids.otherOrganization });
  await sql("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [ids.organization]);
  await refused(SCHEDULER, 403, 'CRM_SCHOOL_CLOCK_FORBIDDEN', 'paid access suspended');
  await sql("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1", [ids.organization]);
  await clock(SCHEDULER, 'paid access restored');
  await sql("UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1", [ids.schoolA]);
  await refused(SCHEDULER, 403, undefined, 'school suspended');
  await sql("UPDATE hon.schools SET status='ACTIVE' WHERE id=$1", [ids.schoolA]);
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1', [MANAGER.grants[0]]);
  await refused(MANAGER, 403, 'CRM_SCHOOL_CLOCK_FORBIDDEN', 'revoked grant');
  await sql("UPDATE hon.principal_role_grants SET effective_until=clock_timestamp()-interval '1 minute' WHERE id=$1", [FOLLOW.grants[0]]);
  await refused(FOLLOW, 403, 'CRM_SCHOOL_CLOCK_FORBIDDEN', 'expired grant');
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) SELECT $1,'HUMAN_USER',user_id,'CRM Clock Second' FROM hon.principals WHERE id=$2", [randomUUID(), SELF.principal]);
  await refused(SELF, 403, undefined, 'a second active human principal for the same user');
  // A management role scoped to school B never authorizes school A, and a role from another organization never counts,
  // checked on the private actor helper itself (the route resolver refuses both before the definer is reached).
  const scopedRole = await role(ids.organization, ['crm.trial.schedule']);
  await sql('UPDATE hon.roles SET management_school_id=$2 WHERE id=$1', [scopedRole, ids.schoolB]);
  const SCOPED = await staff('scoped-elsewhere', [scopedRole]);
  await refused(SCOPED, 403, undefined, 'management role scoped to another school');
  const helper = async (actor, org = ids.organization, school = ids.schoolA) => (await sql(
    "SELECT set_config('app.hon_principal_id',$2,true), hon.crm_school_clock_actor($1,$3::uuid,$4::uuid) a", [actor.subject, actor.principal, org, school])).rows[0].a;
  await sql('BEGIN'); try {
    ok(await helper(SCHEDULER) === SCHEDULER.principal, 'actor helper admits a live scheduler at its school');
    ok(await helper(SCOPED) === null, 'actor helper: management role scoped to another school never counts');
    // A grant of another organization's role cannot exist: the composite foreign key refuses it (the helper's
    // r.organization_id=g.organization_id clause is defence in depth).
    const foreign = await role(ids.otherOrganization, ['crm.trial.schedule']);
    await sql('SAVEPOINT cross_org');
    let refusedCode = '';
    try { await staff('cross-org-role', [foreign]); } catch (error) { refusedCode = error.code; }
    await sql('ROLLBACK TO SAVEPOINT cross_org');
    ok(refusedCode === '23503', `a grant of another organization's role is refused by the foreign key (${refusedCode})`);
  } finally { await sql('ROLLBACK'); }

  // 3. Browser transport refusals.
  await refused(SCHEDULER, 400, 'CRM_SCHOOL_CLOCK_SELECTORS_NOT_ACCEPTED', 'query selectors', { query: '?schoolId=x' });
  await refused(SCHEDULER, 403, 'HUMAN_UI_REQUIRED', 'caller-supplied source header', { headers: { 'X-HON-Source': 'HUMAN_UI' } });
  await refused(SCHEDULER, 403, 'HUMAN_UI_REQUIRED', 'delegation header', { headers: { 'X-HON-Delegated-By-Principal-Id': SCHEDULER.principal } });
  await refused(SCHEDULER, 403, 'HUMAN_UI_REQUIRED', 'cross-site fetch', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  { const post = await read(SCHEDULER, { method: 'POST' }); ok(post.status === 404 || post.status === 403, 'no POST route'); }
  { const anonymous = await new Promise((done, fail) => { const r = http.request(new URL(`${origin}/v1/organizations/${ids.organization}/schools/${ids.schoolA}/crm/school-clock`), { method: 'GET' }, (res) => { res.resume(); res.on('end', () => done(res.statusCode)); }); r.on('error', fail); r.end(); });
    ok(anonymous === 401, 'no session is 401'); }

  // 4. The read writes nothing.
  ok(await evidenceCount() === evidence, 'no audit or outbox evidence written by reads');

  // 5. Runtime ACL: EXECUTE on the read only; the helper and the schools table stay private; no session refuses.
  { const row = (await sql(`SELECT has_function_privilege($1,'hon.read_crm_school_clock(text)','EXECUTE') r, has_function_privilege($1,'hon.crm_school_clock_actor(text,uuid,uuid)','EXECUTE') h,
      has_table_privilege($1,'hon.schools','SELECT') OR has_any_column_privilege($1,'hon.schools','SELECT') s`, [CRM_CLOSE_RUNTIME_ROLE])).rows[0];
    ok(row.r && !row.h && !row.s, 'runtime may execute only the clock read'); }
  await assert.rejects(runtime.query('SELECT hon.crm_school_clock_actor($1,$2,$3)', [SCHEDULER.subject, ids.organization, ids.schoolA]), /permission denied/); checks += 1;
  await assert.rejects(runtime.query('SELECT hon.read_crm_school_clock($1)', [SCHEDULER.subject]), /CRM_SCHOOL_CLOCK_FORBIDDEN|permission denied/); checks += 1;
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const exists = (await sql('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount;
    if (exists) ok(!(await sql("SELECT has_function_privilege($1,'hon.read_crm_school_clock(text)','EXECUTE') x", [role])).rows[0].x, `${role} cannot execute the clock read`);
  }

  // 6. The deployment verifier's 0236 section (infra/postgres/011) passes against this database with its runtime role.
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const section = verify.split('-- CRM school clock exact verification (0236)')[1]?.split('-- End CRM school clock exact verification.')[0];
    ok(section, '011 has the 0236 section');
    await sql(section.replace(/^[^\n]*\n[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: CRM school clock (0236): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
