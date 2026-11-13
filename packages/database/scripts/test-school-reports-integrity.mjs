/**
 * School reports proof (R1, 0331) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guard + global
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

const session = { mode: 'OIDC', audience: 'hon-school-reports', secret: randomBytes(32).toString('hex') };
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

function call(actor, query = '', { headers = {}, school = actor.school, organization = actor.org, method = 'GET' } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/reports/monthly${query ? `?${query}` : ''}`);
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
    await sql('DELETE FROM hon.hq_operator_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`reports-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`reports-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`reports-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`reports-${ids.organization}-%`]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `reports-${ids.organization}-${label}`;
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
// Month starts in school time: m[0] is the first month of a 3-month report, m[2] the current month.
let m;
const at = (month, day, hour = 10) => `${month}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:00`;
const local = async (text) => (await sql('SELECT ($1::timestamp AT TIME ZONE $2) t', [text, LA])).rows[0].t;

async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Reports Org','Reports Org'),($2,'Reports Other Org','Reports Other Org')", orgs());
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", orgs());
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Reports ${slug}`, `reports-${slug}-${school.slice(0, 8)}`, LA]);
  }
  m = (await sql(`SELECT to_char(date_trunc('month', clock_timestamp() AT TIME ZONE $1) - make_interval(months => g),'YYYY-MM') m
    FROM generate_series(2,0,-1) g`, [LA])).rows.map((row) => row.m);
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  REPORTER = await staff('reporter', [await role(ids.organization, ['reporting.view'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read', 'crm.lead.read', 'attendance.record', 'schedule.session.manage'])]);
  MIXED = await staff('mixed', [await role(ids.organization, ['reporting.view']), await role(ids.organization, ['people.read'], 'PARENT_PORTAL')]);
  OTHER_SCHOOL = await staff('other-school', [await role(ids.organization, allPermissions)], { school: ids.schoolB });
  HQ = await staff('hq', [await role(ids.organization, ['reporting.view'])]);
  await sql("INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_OWNER')", [HQ.principal]);
}

// The previous month (m[1]) holds every kind of record so its totals are exact; school B and the other organization
// hold records in the same month that must never reach school A's report.
async function records(org, school, tag) {
  const program = randomUUID();
  await sql("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Adult Karate','SCHEDULED')", [program, org, school]);
  const person = async (given) => { const id = randomUUID(); await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4,'Reports')", [id, org, school, `${given}${tag}`]); return id; };
  const students = [];
  for (const name of ['Ari', 'Bo', 'Cy', 'Di']) {
    const p = await person(name), id = randomUUID();
    await sql('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)', [id, org, school, p]);
    students.push(id);
  }
  const session = async (start, status = 'COMPLETED') => {
    const id = randomUUID(), s = await local(start);
    await raw('class_sessions', `INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status,cancellation_reason)
      VALUES($1,$2,$3,$4,'Adult Karate',$5,$5::timestamptz+interval '1 hour',20,'WALK_IN',$6,$7)`, [id, org, school, program, s, status, status === 'CANCELLED' ? 'Snow day' : null]);
    return id;
  };
  const mark = (sessionId, student, status) => raw('attendance_records', 'INSERT INTO hon.attendance_records(organization_id,school_id,class_session_id,student_profile_id,status,progression_enabled,progression_weight_milli,progression_credit_milli) VALUES($1,$2,$3,$4,$5,false,0,0)',
    [org, school, sessionId, student, status]);
  const s1 = await session(at(m[1], 3)), s2 = await session(at(m[1], 10, 18)), cancelled = await session(at(m[1], 12), 'CANCELLED');
  await mark(s1, students[0], 'PRESENT'); await mark(s1, students[1], 'PRESENT'); await mark(s1, students[2], 'LATE'); await mark(s1, students[3], 'UNEXCUSED_ABSENCE');
  await mark(s2, students[0], 'MAKEUP'); await mark(s2, students[1], 'EXCUSED_ABSENCE');
  await mark(cancelled, students[2], 'PRESENT');
  // A session in an earlier month, outside a 3-month report.
  const old = await session(at(m[0], 1, 0));
  await mark(old, students[0], 'PRESENT');

  const pipeline = randomUUID(), stage = randomUUID();
  await sql("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'Reports pipeline')", [pipeline, org, school]);
  await sql("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'New',1)", [stage, org, school, pipeline]);
  const lead = async (created, wonAt = null) => raw('crm_leads', `INSERT INTO hon.crm_leads(organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status,created_at,won_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [org, school, await person('Lead'), pipeline, stage, wonAt ? 'WON' : 'OPEN', await local(created), wonAt ? await local(wonAt) : null]);
  await lead(at(m[1], 2)); await lead(at(m[1], 4), at(m[1], 20)); await lead(at(m[0], 2));

  const payer = await person('Payer'), account = randomUUID();
  await sql('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id) VALUES($1,$2,$3,$4)', [account, org, school, payer]);
  const membership = async (state, started, ends = null) => {
    const id = randomUUID();
    await raw('memberships', `INSERT INTO hon.memberships(id,organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at)
      VALUES($1,$2,$3,$4,$5,'MONTHLY',$6,$7,$8)`, [id, org, school, account, await person('Member'), state, started ? await local(started) : null, ends ? await local(ends) : null]);
    return id;
  };
  const before = `${m[0]}-01 00:00`;
  const kept = await membership('ACTIVE', before);
  const joined = await membership('ACTIVE', at(m[1], 5));
  const cancelledM = await membership('CANCELLED', before);
  await raw('audit_events', `INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,result,request_id,correlation_id,occurred_at)
    VALUES($1,$2,$3,'HUMAN_UI','billing.membership.cancel','MEMBERSHIP',$4,'SUCCEEDED',$5,$5,$6)`, [org, school, OWN.principal, cancelledM, randomUUID(), await local(at(m[1], 10))]);
  // A refused cancellation attempt is not a cancellation.
  await raw('audit_events', `INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,result,request_id,correlation_id,occurred_at)
    VALUES($1,$2,$3,'HUMAN_UI','billing.membership.cancel','MEMBERSHIP',$4,'DENIED',$5,$5,$6)`, [org, school, OWN.principal, kept, randomUUID(), await local(at(m[1], 11))]);
  await membership('EXPIRED', before, at(m[1], 20));
  await membership('CANCELLED', before); // no recorded cancellation time
  await membership('DRAFT', null);
  await membership('FROZEN', at(m[0], 15));

  const invoice = async (status, currency, total, created) => {
    const id = randomUUID();
    await raw('invoices', `INSERT INTO hon.invoices(id,organization_id,school_id,billing_account_id,status,currency,subtotal_minor,total_minor,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8)`, [id, org, school, account, status, currency, total, await local(created)]);
    return id;
  };
  const open = await invoice('ISSUED', 'USD', 10000, at(m[1], 6));
  await invoice('PAID', 'USD', 2500, at(m[1], 7));
  await invoice('DRAFT', 'USD', 5000, at(m[1], 6));
  await invoice('VOID', 'USD', 4000, at(m[1], 6));
  await invoice('ISSUED', 'CAD', 700, at(m[1], 9));
  await invoice('ISSUED', 'USD', 900, at(m[0], 9));
  const pay = (amount, on, voided = false) => raw('invoice_payment_records', `INSERT INTO hon.invoice_payment_records(organization_id,school_id,invoice_id,amount_minor,currency,received_on,method,actor_principal_id,
      voided_at,voided_by_principal_id,void_reason) VALUES($1,$2,$3,$4,'USD',$5::date,'CASH',$6,$7,$8,$9)`,
    [org, school, open, amount, on, OWN.principal, voided ? new Date() : null, voided ? OWN.principal : null, voided ? 'Entered twice' : null]);
  await pay(6000, `${m[1]}-08`); await pay(999, `${m[1]}-08`, true); await pay(300, `${m[0]}-08`);
  const attempt = (state, amount, when) => raw('payment_attempts', `INSERT INTO hon.payment_attempts(organization_id,school_id,invoice_id,provider_code,provider_account_reference,
      provider_idempotency_reference,state,amount_minor,currency,initiated_at,reconciled_at) VALUES($1,$2,$3,'TEST','acct_test',$4,$5,$6,'USD',$7,$7)`,
    [org, school, open, randomUUID(), state, amount, when]);
  await attempt('SUCCEEDED', 2500, await local(at(m[1], 7))); await attempt('FAILED', 7777, await local(at(m[1], 7)));
  await raw('membership_refund_records', `INSERT INTO hon.membership_refund_records(organization_id,school_id,membership_id,amount_minor,currency,refunded_on,method,reason,actor_principal_id)
    VALUES($1,$2,$3,1500,'USD',$4::date,'CASH','Moved away',$5)`, [org, school, cancelledM, `${m[1]}-12`, OWN.principal]);
}

try {
  await cleanup();
  await seed();
  await records(ids.organization, ids.schoolA, 'A');
  await records(ids.organization, ids.schoolB, 'B');
  await records(ids.otherOrganization, ids.otherSchool, 'O');
  await startApp();

  // 1. Authority: reporting.view at this school, a direct human, no HQ, family or other-school borrowing.
  const report = await success(() => call(REPORTER, 'months=3'), 'a reporting.view staff member');
  for (const [actor, label] of [[NONE, 'no reporting.view'], [MIXED, 'a mixed parent role'], [HQ, 'an HQ operator']]) {
    await refused(() => call(actor, 'months=3'), 403, undefined, `refused for ${label}`);
  }
  await refused(() => call(OTHER_SCHOOL, 'months=3', { school: ids.schoolA }), 403, undefined, 'school-B staff at the school-A route');
  await refused(() => call(REPORTER, 'months=3', { organization: ids.otherOrganization }), 403, undefined, 'a wrong organization in the route');
  await refused(() => call(REPORTER, 'months=3', { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'a read with an idempotency key');
  await refused(() => call(REPORTER, 'months=3', { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'a cross-site read');
  await refused(() => call(REPORTER, 'months=3', { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'a source selector');
  for (const query of ['months=2', 'months=13', 'months=abc', 'months=6.5', 'months=3&x=1', 'months=3&months=4']) {
    await refused(() => call(REPORTER, query), 400, undefined, `query ${query}`);
  }

  // 2. Shape: three school-time months, oldest first, only the last one partial.
  const R = report.data;
  ok(R.schoolId === ids.schoolA && R.schoolName === 'Reports a' && R.timezone === LA && R.months === 3 && R.periods.length === 3, 'school A, three months');
  ok(JSON.stringify(R.periods.map((p) => p.month)) === JSON.stringify(m) && R.periods.map((p) => p.partial).join() === 'false,false,true', 'months in order; the current one partial');
  const startOf = await local(`${m[1]}-01 00:00`), endOf = await local(`${m[2]}-01 00:00`);
  ok(R.periods[1].from === startOf.toISOString() && R.periods[1].to === endOf.toISOString() && R.periods[0].to === R.periods[1].from, 'month bounds are school-time midnights');
  ok(R.cancelledWithoutDate === 1, 'one cancelled membership has no recorded cancellation time');
  const P = R.periods[1];
  ok(JSON.stringify(P.attendance) === JSON.stringify({ classesHeld: 2, checkIns: 4, absences: 2, studentsAttended: 3 }), `attendance ${JSON.stringify(P.attendance)}`);
  ok(JSON.stringify(P.enrollment) === JSON.stringify({ newLeads: 2, leadsWon: 1, newMemberships: 1 }), `enrollment ${JSON.stringify(P.enrollment)}`);
  // Members at the start: kept, cancelled, expiring, frozen = 4; at the end: kept, joined, frozen = 3.
  ok(JSON.stringify(P.retention) === JSON.stringify({ activeAtStart: 4, activeAtEnd: 3, ended: 2, retainedFromStart: 2 }), `retention ${JSON.stringify(P.retention)}`);
  ok(JSON.stringify(P.revenue) === JSON.stringify([
    { currency: 'CAD', billedMinor: 700, recordedPaymentsMinor: 0, onlinePaymentsMinor: 0, refundsMinor: 0 },
    { currency: 'USD', billedMinor: 12500, recordedPaymentsMinor: 6000, onlinePaymentsMinor: 2500, refundsMinor: 1500 }]), `revenue ${JSON.stringify(P.revenue)}`);
  const first = R.periods[0];
  ok(first.attendance.classesHeld === 1 && first.attendance.checkIns === 1 && first.enrollment.newLeads === 1 && first.enrollment.newMemberships === 4
    && JSON.stringify(first.revenue) === JSON.stringify([{ currency: 'USD', billedMinor: 900, recordedPaymentsMinor: 300, onlinePaymentsMinor: 0, refundsMinor: 0 }]),
    `the first month counts only its own records ${JSON.stringify(first)}`);
  ok(JSON.stringify(R.periods[2].attendance) === JSON.stringify({ classesHeld: 0, checkIns: 0, absences: 0, studentsAttended: 0 }) && R.periods[2].revenue.length === 0,
    'the current month has no seeded records');
  ok(!/AriA|BoA|CyA|DiA|LeadA|PayerA|MemberA|Snow day|Moved away|Entered twice/.test(JSON.stringify(R)), 'no names, reasons or notes in the report');
  ok(!JSON.stringify(R).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)?.some((id) => id !== ids.schoolA), 'no record ids except the school');

  // 3. Defaults and other schools: six months by default; school B sees only its own identical records.
  const six = await success(() => call(OWN), 'default months');
  ok(six.data.months === 6 && six.data.periods.length === 6 && six.data.periods.at(-1).month === m[2], 'six months by default');
  const b = await success(() => call(OTHER_SCHOOL, 'months=3'), 'school B report');
  ok(b.data.schoolId === ids.schoolB && JSON.stringify(b.data.periods.map(({ to, ...rest }) => rest)) === JSON.stringify(R.periods.map(({ to, ...rest }) => rest)), 'school B: same seeded totals, its own rows only');
  const twelve = await success(() => call(OWN, 'months=12'), 'twelve months');
  ok(twelve.data.periods.length === 12, 'twelve months');

  // 4. Live authority: a revoked grant is refused at once.
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE id=$1', [REPORTER.grants[0], OWN.principal]);
  await refused(() => call(REPORTER, 'months=3'), 403, undefined, 'refused after the grant is revoked');
  await raw('organization_entitlements', "UPDATE hon.organization_entitlements SET effective_until=clock_timestamp() WHERE organization_id=$1", [ids.organization]);
  await refused(() => call(OWN, 'months=3'), 403, undefined, 'refused without an active entitlement');
  await raw('organization_entitlements', 'UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1', [ids.organization]);
  ok((await call(OWN, 'months=3')).status === 200, 'allowed again once the entitlement is active');

  // 5. Database boundary: one runtime entry point; helpers private; no direct table reads; no caller settings.
  const fns = (await sql(`SELECT p.oid::regprocedure::text sig, has_function_privilege($1,p.oid,'EXECUTE') runtime,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public, p.prosecdef definer, p.proconfig config
    FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace AND p.proname IN ('require_school_reports_actor','school_report_periods','read_school_reports') ORDER BY 1`,
  [CRM_CLOSE_RUNTIME_ROLE])).rows;
  ok(fns.length === 3 && fns.every((f) => f.definer && !f.public && JSON.stringify(f.config) === '["search_path=pg_catalog, hon"]'), 'three definer functions, none public, fixed search path');
  ok(fns.filter((f) => f.runtime).map((f) => f.sig).join() === 'hon.read_school_reports(text,jsonb)', 'the runtime may run only the report read');
  await assert.rejects(runtime.query('SELECT hon.school_report_periods($1,$2,$3,3,now())', [ids.organization, ids.schoolA, LA]), /permission denied/); checks += 1;
  await assert.rejects(runtime.query('SELECT hon.read_school_reports($1,$2::jsonb)', [OWN.subject, '{}']), /SCHOOL_REPORTS_FORBIDDEN|tenant|permission/i); checks += 1;
  for (const table of ['invoice_payment_records', 'membership_refund_records']) {
    await assert.rejects(runtime.query(`SELECT 1 FROM hon.${table} LIMIT 1`), /permission denied/); checks += 1;
  }
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const startMark = '-- School reports exact verification (R1 0331)', endMark = '-- End school reports exact verification.';
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: school reports (0331): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
