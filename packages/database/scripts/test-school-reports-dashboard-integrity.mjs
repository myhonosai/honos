/**
 * School reports dashboard proof (R3, 0371) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guard + global
 * ValidationPipe + HonExceptionFilter -> SchoolReportsDashboardController -> one protected definer function on the restricted runtime
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
const { SchoolReportsDashboardController } = await load('reports/school-reports.controller.js');
const { SchoolReportsService } = await load('reports/school-reports.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-school-reports-dashboard', secret: randomBytes(32).toString('hex') };
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
    controllers: [SchoolReportsDashboardController],
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
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/reports/dashboard${query ? `?${query}` : ''}`);
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
    const result = await runtime.query("SELECT hon.read_school_reports_dashboard($1,'{\"range\":\"LAST_MONTH\"}'::jsonb) AS data", [actor.subject]);
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
    await sql('DELETE FROM hon.hq_operator_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`dash-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`dash-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`dash-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`dash-${ids.organization}-%`]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `dash-${ids.organization}-${label}`;
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
// Month starts in school time: m[0] is the month before last, m[1] last month (LAST_MONTH), m[2] this month.
let m;
const at = (month, day, hour = 10) => `${month}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:00`;
const local = async (text) => (await sql('SELECT ($1::timestamp AT TIME ZONE $2) t', [text, LA])).rows[0].t;

async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Dash Org','Dash Org'),($2,'Dash Other Org','Dash Other Org')", orgs());
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", orgs());
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Dash ${slug}`, `dash-${slug}-${school.slice(0, 8)}`, LA]);
  }
  m = (await sql(`SELECT to_char(date_trunc('month', clock_timestamp() AT TIME ZONE $1) - make_interval(months => g),'YYYY-MM') m
    FROM generate_series(2,0,-1) g`, [LA])).rows.map((row) => row.m);
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  REPORTER = await staff('reporter', [await role(ids.organization, ['reporting.view'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read', 'crm.lead.read', 'attendance.record', 'billing.membership.read'])]);
  MIXED = await staff('mixed', [await role(ids.organization, ['reporting.view']), await role(ids.organization, ['people.read'], 'PARENT_PORTAL')]);
  OTHER_SCHOOL = await staff('other-school', [await role(ids.organization, allPermissions)], { school: ids.schoolB });
  HQ = await staff('hq', [await role(ids.organization, ['reporting.view'])]);
  await sql("INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_OWNER')", [HQ.principal]);
}

// Last month (m[1]) and the month before (m[0]) hold every kind of record so both ranges' totals are exact; school B and
// the other organization hold the same records, which must never reach school A's dashboard.
async function records(org, school, tag) {
  const person = async (given) => { const id = randomUUID(); await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4,'Dash')", [id, org, school, `${given}${tag}`]); return id; };
  const pipeline = randomUUID(), fresh = randomUUID(), trial = randomUUID(), won = randomUUID();
  await sql("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'Dash pipeline')", [pipeline, org, school]);
  await sql("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'New',1),($5,$2,$3,$4,'Trial booked',2)", [fresh, org, school, pipeline, trial]);
  await sql("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position,terminal_status) VALUES($1,$2,$3,$4,'Won',3,'WON')", [won, org, school, pipeline]);
  const lead = async (stage, status, created, closed = null) => {
    const id = randomUUID();
    await raw('crm_leads', `INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status,created_at,won_at,lost_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, org, school, await person('Lead'), pipeline, stage, status, await local(created),
      status === 'WON' ? await local(closed) : null, status === 'LOST' ? await local(closed) : null]);
    return id;
  };
  const openNew = await lead(fresh, 'OPEN', at(m[1], 2));
  await lead(won, 'WON', at(m[1], 4), at(m[1], 20));
  await lead(fresh, 'LOST', at(m[1], 4), at(m[1], 21));
  await lead(trial, 'OPEN', at(m[0], 2));
  await lead(fresh, 'LOST', at(m[0], 3), at(m[0], 9));
  const appointment = (status, start) => raw('crm_appointments', `INSERT INTO hon.crm_appointments(organization_id,school_id,crm_lead_id,appointment_type,status,starts_at,ends_at,created_by_principal_id)
    VALUES($1,$2,$3,'TRIAL',$4,$5,$5::timestamptz+interval '1 hour',$6)`, [org, school, openNew, status, start, OWN.principal]);
  await appointment('COMPLETED', await local(at(m[1], 6))); await appointment('NO_SHOW', await local(at(m[1], 7)));
  await appointment('CANCELLED', await local(at(m[1], 8))); await appointment('COMPLETED', await local(at(m[0], 6)));

  const payer = await person('Payer'), account = randomUUID();
  await sql('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id) VALUES($1,$2,$3,$4)', [account, org, school, payer]);
  const membership = async (state, started, ends = null) => {
    const id = randomUUID(), participant = await person('Member');
    await raw('memberships', `INSERT INTO hon.memberships(id,organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at)
      VALUES($1,$2,$3,$4,$5,'MONTHLY',$6,$7,$8)`, [id, org, school, account, participant, state, started ? await local(started) : null, ends ? await local(ends) : null]);
    return { id, participant };
  };
  const before = `${m[0]}-01 00:00`;
  const kept = await membership('ACTIVE', before);
  const joined = await membership('ACTIVE', at(m[1], 5));
  const cancelled = await membership('CANCELLED', before);
  await raw('audit_events', `INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,result,request_id,correlation_id,occurred_at)
    VALUES($1,$2,$3,'HUMAN_UI','billing.membership.cancel','MEMBERSHIP',$4,'SUCCEEDED',$5,$5,$6)`, [org, school, OWN.principal, cancelled.id, randomUUID(), await local(at(m[1], 10))]);
  await membership('EXPIRED', before, at(m[1], 20));
  await membership('CANCELLED', before); // no recorded cancellation time: never active, but still a first membership
  await membership('DRAFT', null);
  const frozen = await membership('FROZEN', at(m[0], 15));

  // Ranks: kept is a white belt, joined a yellow belt and also in a weapons curriculum, frozen has no enrollment,
  // cancelled holds a rank but is no longer a member.
  const curriculum = async (name) => { const id = randomUUID(); await sql("INSERT INTO hon.curricula(id,organization_id,school_id,name,model_code) VALUES($1,$2,$3,$4,'LINEAR')", [id, org, school, name]); return id; };
  const rank = async (cur, name, color, order) => { const id = randomUUID(); await raw('curriculum_ranks', 'INSERT INTO hon.curriculum_ranks(id,organization_id,school_id,curriculum_id,name,display_color,progression_order) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, org, school, cur, name, color, order]); return id; };
  const karate = await curriculum('Karate'), weapons = await curriculum('Weapons');
  const white = await rank(karate, 'White', '#ffffff', 1), yellow = await rank(karate, 'Yellow', '#f5d000', 2), staffRank = await rank(weapons, 'Bo staff', null, 1);
  const profile = async (participant) => { const id = randomUUID(); await sql('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)', [id, org, school, participant]); return id; };
  const enroll = (student, cur, r, status = 'ACTIVE') => raw('student_curriculum_enrollments', 'INSERT INTO hon.student_curriculum_enrollments(organization_id,school_id,student_profile_id,curriculum_id,current_rank_id,status) VALUES($1,$2,$3,$4,$5,$6)', [org, school, student, cur, r, status]);
  const keptP = await profile(kept.participant), joinedP = await profile(joined.participant), cancelledP = await profile(cancelled.participant);
  await profile(frozen.participant);
  await enroll(keptP, karate, white); await enroll(joinedP, karate, yellow); await enroll(joinedP, weapons, staffRank); await enroll(cancelledP, karate, yellow);

  const invoice = async (currency, total, created) => {
    const id = randomUUID();
    await raw('invoices', `INSERT INTO hon.invoices(id,organization_id,school_id,billing_account_id,status,currency,subtotal_minor,total_minor,created_at)
      VALUES($1,$2,$3,$4,'ISSUED',$5,$6,$6,$7)`, [id, org, school, account, currency, total, await local(created)]);
    return id;
  };
  const usd = await invoice('USD', 10000, at(m[1], 6)), cad = await invoice('CAD', 700, at(m[1], 9));
  const pay = (invoiceId, currency, amount, on, voided = false) => raw('invoice_payment_records', `INSERT INTO hon.invoice_payment_records(organization_id,school_id,invoice_id,amount_minor,currency,received_on,method,actor_principal_id,
      voided_at,voided_by_principal_id,void_reason) VALUES($1,$2,$3,$4,$5,$6::date,'CASH',$7,$8,$9,$10)`,
    [org, school, invoiceId, amount, currency, on, OWN.principal, voided ? new Date() : null, voided ? OWN.principal : null, voided ? 'Entered twice' : null]);
  await pay(usd, 'USD', 6000, `${m[1]}-08`); await pay(usd, 'USD', 999, `${m[1]}-08`, true); await pay(usd, 'USD', 300, `${m[0]}-08`); await pay(cad, 'CAD', 700, `${m[1]}-09`);
  const attempt = (state, amount, when) => raw('payment_attempts', `INSERT INTO hon.payment_attempts(organization_id,school_id,invoice_id,provider_code,provider_account_reference,
      provider_idempotency_reference,state,amount_minor,currency,initiated_at,reconciled_at) VALUES($1,$2,$3,'TEST','acct_test',$4,$5,$6,'USD',$7,$7)`,
    [org, school, usd, randomUUID(), state, amount, when]);
  await attempt('SUCCEEDED', 2500, await local(at(m[1], 7))); await attempt('FAILED', 7777, await local(at(m[1], 7)));
  await raw('membership_refund_records', `INSERT INTO hon.membership_refund_records(organization_id,school_id,membership_id,amount_minor,currency,refunded_on,method,reason,actor_principal_id)
    VALUES($1,$2,$3,1500,'USD',$4::date,'CASH','Moved away',$5)`, [org, school, cancelled.id, `${m[1]}-12`, OWN.principal]);
}

try {
  await cleanup();
  await seed();
  await records(ids.organization, ids.schoolA, 'A');
  await records(ids.organization, ids.schoolB, 'B');
  await records(ids.otherOrganization, ids.otherSchool, 'O');
  await startApp();

  // 1. Authority: reporting.view at this school, a direct human, no HQ, family or other-school borrowing.
  const last = await success(async () => {
    const started = Date.now(), response = await call(REPORTER, 'range=LAST_MONTH');
    if (response.status !== 200) await diagnose(REPORTER, Date.now() - started);
    return response;
  }, 'a reporting.view staff member');
  for (const [actor, label] of [[NONE, 'no reporting.view'], [MIXED, 'a mixed parent role'], [HQ, 'an HQ operator']]) {
    await refused(() => call(actor, 'range=LAST_MONTH'), 403, undefined, `refused for ${label}`);
  }
  await refused(() => call(OTHER_SCHOOL, 'range=LAST_MONTH', { school: ids.schoolA }), 403, undefined, 'school-B staff at the school-A route');
  await refused(() => call(REPORTER, 'range=LAST_MONTH', { organization: ids.otherOrganization }), 403, undefined, 'a wrong organization in the route');
  await refused(() => call(REPORTER, 'range=LAST_MONTH', { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'a read with an idempotency key');
  await refused(() => call(REPORTER, 'range=LAST_MONTH', { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'a cross-site read');
  await refused(() => call(REPORTER, 'range=LAST_MONTH', { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'a source selector');
  for (const query of ['range=last_month', 'range=D7', 'range=', 'range=ALL&x=1', 'range=ALL&range=M12', 'months=3']) {
    await refused(() => call(REPORTER, query), 400, undefined, `query ${query}`);
  }

  // 2. Last month: exact KPIs, the month before as the comparison, a daily income series, belts and pipeline now.
  const L = last.data;
  const startOf = async (month) => (await local(`${month}-01 00:00`)).toISOString();
  ok(L.schoolId === ids.schoolA && L.schoolName === 'Dash a' && L.timezone === LA && L.range === 'LAST_MONTH', 'school A, last month');
  ok(L.from === await startOf(m[1]) && L.to === await startOf(m[2]) && L.previous.from === await startOf(m[0]) && L.previous.to === L.from, 'school-time month bounds; previous is the month before');
  const kpis = (k) => JSON.stringify(k);
  ok(kpis(L.kpis) === kpis({ activeStudents: 3, newStudents: 1, appointments: 2, leadsWon: 1, leadsLost: 1,
    income: [{ currency: 'CAD', paymentsMinor: 700, refundsMinor: 0 }, { currency: 'USD', paymentsMinor: 8500, refundsMinor: 1500 }] }), `last month KPIs ${kpis(L.kpis)}`);
  // The month before: kept, cancelled, expiring and frozen were members at its end; five people's first membership started in it.
  ok(kpis(L.previous.kpis) === kpis({ activeStudents: 4, newStudents: 5, appointments: 1, leadsWon: 0, leadsLost: 1,
    income: [{ currency: 'USD', paymentsMinor: 300, refundsMinor: 0 }] }), `month-before KPIs ${kpis(L.previous.kpis)}`);
  const days = (await sql("SELECT extract(day FROM (($1||'-01')::date + interval '1 month' - interval '1 day'))::int n", [m[1]])).rows[0].n;
  ok(L.series.bucket === 'DAY' && L.series.truncated === false && L.series.points.length === days && L.series.points[0].start === `${m[1]}-01`, 'one point per day of last month');
  const point = (d) => L.series.points.find((p) => p.start === `${m[1]}-${String(d).padStart(2, '0')}`).income;
  ok(kpis(point(7)) === kpis([{ currency: 'USD', paymentsMinor: 2500, refundsMinor: 0 }]) && kpis(point(8)) === kpis([{ currency: 'USD', paymentsMinor: 6000, refundsMinor: 0 }])
    && kpis(point(9)) === kpis([{ currency: 'CAD', paymentsMinor: 700, refundsMinor: 0 }]) && kpis(point(12)) === kpis([{ currency: 'USD', paymentsMinor: 0, refundsMinor: 1500 }])
    && L.series.points.filter((p) => p.income.length).length === 4, 'income lands on its own school day; voided and failed payments never count');
  ok(L.belts.students === 3 && L.belts.unranked === 1 && L.belts.truncated === false
    && kpis(L.belts.ranks.map((r) => [r.curriculum, r.rank, r.color, r.order, r.students])) === kpis([['Karate', 'White', '#ffffff', 1, 1], ['Karate', 'Yellow', '#f5d000', 2, 1], ['Weapons', 'Bo staff', null, 1, 1]]),
    `belts now ${kpis(L.belts)}`);
  ok(L.pipeline.open === 2 && kpis(L.pipeline.stages.map((s) => [s.pipeline, s.stage, s.position, s.leads])) === kpis([['Dash pipeline', 'New', 1, 1], ['Dash pipeline', 'Trial booked', 2, 1]]),
    `open leads by stage ${kpis(L.pipeline)}`);
  ok(!/LeadA|PayerA|MemberA|Moved away|Entered twice/.test(JSON.stringify(L)), 'no names, reasons or notes');
  const allowedIds = new Set([ids.schoolA, ...L.belts.ranks.flatMap((r) => [r.curriculumId, r.rankId]), ...L.pipeline.stages.flatMap((s) => [s.pipelineId, s.stageId])]);
  ok(!JSON.stringify(L).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)?.some((id) => !allowedIds.has(id)), 'no person, lead, membership or payment ids');

  // 3. Other ranges and schools.
  const month = await success(() => call(OWN), 'default range');
  const today = (await sql("SELECT extract(day FROM clock_timestamp() AT TIME ZONE $1)::int d", [LA])).rows[0].d;
  ok(month.data.range === 'THIS_MONTH' && month.data.from === await startOf(m[2]) && month.data.series.points.length === today
    && Date.parse(month.data.previous.to) <= Date.parse(month.data.from) && month.data.previous.from === await startOf(m[1]), 'this month by default, compared with last month to the same point');
  const d30 = await success(() => call(OWN, 'range=D30'), 'D30'), d90 = await success(() => call(OWN, 'range=D90'), 'D90');
  ok(d30.data.series.bucket === 'DAY' && d30.data.series.points.length === 30 && d90.data.series.bucket === 'WEEK' && d90.data.series.points.length === 13, '30 daily or 13 weekly points');
  ok(Date.parse(d30.data.previous.to) === Date.parse(d30.data.from) && Date.parse(d30.data.from) - Date.parse(d30.data.previous.from) >= 29 * 86400000, 'D30 compares with the 30 days before');
  const m12 = await success(() => call(OWN, 'range=M12'), 'M12');
  ok(m12.data.series.bucket === 'MONTH' && m12.data.series.points.length === 12 && m12.data.series.points.at(-1).start === `${m[2]}-01` && m12.data.previous !== null, 'twelve months');
  ok(m12.data.kpis.newStudents === 6 && m12.data.kpis.appointments === 3 && m12.data.kpis.leadsLost === 2, `twelve-month counts ${kpis(m12.data.kpis)}`);
  const all = await success(() => call(OWN, 'range=ALL'), 'ALL');
  ok(all.data.from === null && all.data.previous === null && all.data.series.bucket === 'MONTH' && all.data.series.truncated === false
    && kpis(all.data.series.points.map((p) => p.start)) === kpis([`${m[0]}-01`, `${m[1]}-01`, `${m[2]}-01`]), 'all time: no comparison, months from the first income');
  ok(kpis(all.data.kpis.income) === kpis([{ currency: 'CAD', paymentsMinor: 700, refundsMinor: 0 }, { currency: 'USD', paymentsMinor: 8800, refundsMinor: 1500 }]), 'all-time income');
  const b = await success(() => call(OTHER_SCHOOL, 'range=LAST_MONTH'), 'school B');
  const strip = (d) => kpis({ k: d.kpis, p: d.previous.kpis, s: d.series.points, belts: d.belts.ranks.map((r) => [r.curriculum, r.rank, r.students]), open: d.pipeline.open });
  ok(b.data.schoolId === ids.schoolB && strip(b.data) === strip(L), 'school B: the same seeded totals from its own rows only');

  // 4. Live authority: a revoked grant and a lapsed entitlement are refused at once.
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE id=$1', [REPORTER.grants[0], OWN.principal]);
  await refused(() => call(REPORTER, 'range=LAST_MONTH'), 403, undefined, 'refused after the grant is revoked');
  await raw('organization_entitlements', 'UPDATE hon.organization_entitlements SET effective_until=clock_timestamp() WHERE organization_id=$1', [ids.organization]);
  await refused(() => call(OWN, 'range=LAST_MONTH'), 403, undefined, 'refused without an active entitlement');
  await raw('organization_entitlements', 'UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1', [ids.organization]);
  ok((await call(OWN, 'range=LAST_MONTH')).status === 200, 'allowed again once the entitlement is active');

  // 5. Database boundary: one runtime entry point; helpers private; fixed search path; the 011 section passes.
  const fns = (await sql(`SELECT p.oid::regprocedure::text sig, has_function_privilege($1,p.oid,'EXECUTE') runtime,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public, p.prosecdef definer, p.proconfig config, p.provolatile
    FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace AND p.proname IN ('school_dashboard_members','school_dashboard_income','school_dashboard_kpis','read_school_reports_dashboard') ORDER BY 1`,
  [CRM_CLOSE_RUNTIME_ROLE])).rows;
  ok(fns.length === 4 && fns.every((f) => f.definer && !f.public && f.provolatile === 's' && JSON.stringify(f.config) === '["search_path=pg_catalog, hon"]'), 'four stable definer functions, none public, fixed search path');
  ok(fns.filter((f) => f.runtime).map((f) => f.sig).join() === 'hon.read_school_reports_dashboard(text,jsonb)', 'the runtime may run only the dashboard read');
  await assert.rejects(runtime.query('SELECT hon.school_dashboard_kpis($1,$2,$3,now()-interval \'1 day\',now())', [ids.organization, ids.schoolA, LA]), /permission denied/); checks += 1;
  await assert.rejects(runtime.query('SELECT * FROM hon.school_dashboard_members($1,$2)', [ids.organization, ids.schoolA]), /permission denied/); checks += 1;
  await assert.rejects(runtime.query('SELECT hon.read_school_reports_dashboard($1,$2::jsonb)', [OWN.subject, '{}']), /SCHOOL_REPORTS_FORBIDDEN|tenant|permission/i); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const startMark = '-- School reports dashboard exact verification (R3 0371)', endMark = '-- End school reports dashboard exact verification.';
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: school reports dashboard (0371): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
