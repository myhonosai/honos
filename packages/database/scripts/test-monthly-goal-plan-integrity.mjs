/**
 * Monthly goal plan proof (G1, 0686) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guard + global
 * ValidationPipe + HonExceptionFilter -> MonthlyGoalPlanController -> one protected definer function on the restricted runtime
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
const { MonthlyGoalPlanController } = await load('planning/monthly-goal-plan.controller.js');
const { MonthlyGoalPlanService } = await load('planning/monthly-goal-plan.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-monthly-goal', secret: randomBytes(32).toString('hex') };
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
    controllers: [MonthlyGoalPlanController],
    providers: [HonIdentityGuard, HonIdentityService, MonthlyGoalPlanService, { provide: RuntimeDatabaseService, useValue: database }],
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
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/planning/monthly-goal${query ? `?${query}` : ''}`);
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
    await sql('DELETE FROM hon.hq_operator_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`goals-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`goals-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`goals-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`goals-${ids.organization}-%`]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `goals-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Goals Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Goals Staff')", [principal, user]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  return { subject, principal, grants, org, school };
}


let OWN, REPORTER, NONE, MIXED, OTHER_SCHOOL, HQ, B_OWNER;
let cur, prev, next, today;
const at = (month, day, hour = 10) => `${month}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:00`;
const local = async (text) => (await sql('SELECT ($1::timestamp AT TIME ZONE $2) t', [text, LA])).rows[0].t;
const DAY = 86400000;
const plus = (date, days) => new Date(date.getTime() + days * DAY);

async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Goals Org','Goals Org'),($2,'Goals Other Org','Goals Other Org')", orgs());
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", orgs());
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Goals ${slug}`, `goals-${slug}-${school.slice(0, 8)}`, LA]);
  }
  ({ cur, prev, next, today } = (await sql(`SELECT to_char(m,'YYYY-MM') cur, to_char(m - interval '1 month','YYYY-MM') prev, to_char(m + interval '1 month','YYYY-MM') next,
      to_char(clock_timestamp() AT TIME ZONE $1,'YYYY-MM-DD') today FROM (SELECT date_trunc('month', clock_timestamp() AT TIME ZONE $1) m) x`, [LA])).rows[0]);
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  REPORTER = await staff('reporter', [await role(ids.organization, ['reporting.view'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read', 'crm.lead.read', 'planning.revenue.manage'])]);
  MIXED = await staff('mixed', [await role(ids.organization, ['reporting.view']), await role(ids.organization, ['people.read'], 'PARENT_PORTAL')]);
  OTHER_SCHOOL = await staff('other-school', [await role(ids.organization, allPermissions)], { school: ids.schoolB });
  B_OWNER = OTHER_SCHOOL;
  HQ = await staff('hq', [await role(ids.organization, ['reporting.view'])]);
  await sql("INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_OWNER')", [HQ.principal]);
}

// Synthetic school records. Every name carries the school tag so the privacy check can look for it.
function school(org, schoolId, tag) {
  const person = async (given = 'Member') => { const id = randomUUID(); await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4,'Goals')", [id, org, schoolId, `${given}${tag}`]); return id; };
  let account;
  const ensureAccount = async () => {
    if (account) return account;
    account = randomUUID();
    await sql('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id) VALUES($1,$2,$3,$4)', [account, org, schoolId, await person('Payer')]);
    return account;
  };
  const program = async (name) => { const id = randomUUID(); await sql("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,$4,'SCHEDULED')", [id, org, schoolId, `${name}${tag}`]); return id; };
  const plan = async (code, price, programId) => {
    const id = randomUUID();
    await raw('membership_plans', 'INSERT INTO hon.membership_plans(id,organization_id,school_id,plan_code,current_version,created_by_principal_id) VALUES($1,$2,$3,$4,1,$5)', [id, org, schoolId, code, OWN.principal]);
    await raw('membership_plan_versions', `INSERT INTO hon.membership_plan_versions(plan_id,version,organization_id,school_id,display_name,program_id,availability,currency,price_minor,billing_frequency,term_kind,term_months,actor_principal_id)
      VALUES($1,1,$2,$3,$4,$5,'AVAILABLE','USD',$6,'MONTHLY','FIXED_MONTHS',12,$7)`, [id, org, schoolId, `Plan ${code}`, programId, price, OWN.principal]);
    return id;
  };
  const membership = async ({ state = 'ACTIVE', start, end = null, who, planId = null }) => {
    const id = randomUUID();
    await raw('memberships', `INSERT INTO hon.memberships(id,organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at)
      VALUES($1,$2,$3,$4,$5,'GOALS',$6,$7,$8)`, [id, org, schoolId, await ensureAccount(), who ?? await person(), state, start, end]);
    if (planId) await raw('membership_plan_selections', 'INSERT INTO hon.membership_plan_selections(membership_id,organization_id,school_id,plan_id,plan_version,actor_principal_id) VALUES($1,$2,$3,$4,1,$5)', [id, org, schoolId, planId, OWN.principal]);
    return id;
  };
  const extension = (membershipId, priorStart, priorEnd, newEnd) => raw('membership_date_revisions', `INSERT INTO hon.membership_date_revisions(organization_id,school_id,membership_id,change_kind,period_version,
      prior_period_version,prior_start_date,prior_end_date,prior_term_started_at,prior_term_ends_at,start_date,end_date,school_timezone,term_started_at,term_ends_at,date_source,
      prior_membership_version,next_membership_version,decision_basis,actor_principal_id,authorizing_permission,reason_code,reason_text,acknowledged_warnings,retroactive_days,
      financial_facts,requirements_not_evaluated,preview_digest,evaluated_facts,idempotency_key,request_fingerprint,request_id,correlation_id,receipt)
    VALUES($1,$2,$3,'EXTENSION',2,1,$4::timestamptz::date,$5::timestamptz::date,$4,$5,$4::timestamptz::date,$6::timestamptz::date,$7,$4,$6,'STAFF_ENTERED',1,2,'STAFF_REVISION_PRE_POLICY',$8,
      'billing.membership.dates.revise','RENEWAL','Renewed for another year','[]','{"added":0,"removed":0}','{}',
      '["AGREEMENT","PAYMENT","RECURRING_PAYMENT_AUTHORIZATION","FINANCIAL_RESPONSIBILITY","SCHOOL_ACTIVATION_POLICY"]',$9,'{}',$10,$9,$11,$11,'{}')`,
    [org, schoolId, membershipId, priorStart, priorEnd, newEnd, LA, OWN.principal, 'a'.repeat(64), randomUUID(), randomUUID()]);
  const schedule = (membershipId, frequency, amount, nextCharge, status = 'ACTIVE') => raw('membership_payment_schedules',
    `INSERT INTO hon.membership_payment_schedules(organization_id,school_id,membership_id,frequency,amount_minor,currency,next_charge_at,auto_renew,status) VALUES($1,$2,$3,$4,$5,'USD',$6,true,$7)`,
    [org, schoolId, membershipId, frequency, amount, nextCharge, status]);
  let pipeline, stage;
  const lead = async (created, wonAt = null) => {
    if (!pipeline) {
      pipeline = randomUUID(); stage = randomUUID();
      await sql("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'Goals pipeline')", [pipeline, org, schoolId]);
      await sql("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'New',1)", [stage, org, schoolId, pipeline]);
    }
    const id = randomUUID();
    await raw('crm_leads', `INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status,created_at,won_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, org, schoolId, await person('Lead'), pipeline, stage, wonAt ? 'WON' : 'OPEN', created, wonAt]);
    return id;
  };
  const appointment = (leadId, status, starts, created) => raw('crm_appointments', `INSERT INTO hon.crm_appointments(organization_id,school_id,crm_lead_id,appointment_type,status,starts_at,ends_at,notes,created_by_principal_id,created_at)
    VALUES($1,$2,$3,'TRIAL',$4,$5,$5::timestamptz+interval '1 hour','Bring a water bottle',$6,$7)`, [org, schoolId, leadId, status, starts, OWN.principal, created]);
  const payment = async (amount, on) => {
    const invoice = randomUUID();
    await raw('invoices', `INSERT INTO hon.invoices(id,organization_id,school_id,billing_account_id,status,currency,subtotal_minor,total_minor) VALUES($1,$2,$3,$4,'ISSUED','USD',$5,$5)`, [invoice, org, schoolId, await ensureAccount(), amount]);
    await raw('invoice_payment_records', `INSERT INTO hon.invoice_payment_records(organization_id,school_id,invoice_id,amount_minor,currency,received_on,method,actor_principal_id)
      VALUES($1,$2,$3,$4,'USD',$5::date,'CASH',$6)`, [org, schoolId, invoice, amount, on, OWN.principal]);
  };
  return { person, program, plan, membership, extension, schedule, lead, appointment, payment };
}

let renewalIds, weeklyCharges;
async function seedSchoolA(s) {
  const made = {};
  const p1 = await s.program('Karate'), p2 = await s.program('Kickboxing');
  const renewPlan = await s.plan('RENEW', 20000, p1), otherProgramPlan = await s.plan('KICK', 20000, p2), newPlan = await s.plan('NEW', 15000, p1);
  // History: 10 terms ended last month, 6 renewed by a new membership of the same student -> renewal rate 0.6.
  const prevEnd = await local(at(prev, 5));
  for (let i = 0; i < 10; i += 1) {
    const who = await s.person();
    await s.membership({ state: 'EXPIRED', start: plus(prevEnd, -365), end: prevEnd, who, planId: renewPlan });
    if (i < 6) await s.membership({ start: prevEnd, who, planId: renewPlan });
  }
  // 5 new members last month at 15000 -> average new membership 15000 (the 6 renewals are not new).
  for (let i = 0; i < 5; i += 1) await s.membership({ start: await local(at(prev, 8)), planId: newPlan });
  // 20 leads last month: 12 booked (10 showed, 2 no-show), 1 only cancelled; 5 of the 10 who showed won.
  const created = await local(at(prev, 2)), leadAt = await local(at(prev, 3)), trialAt = await local(at(prev, 10)), wonAt = await local(at(prev, 12));
  for (let i = 0; i < 20; i += 1) {
    const id = await s.lead(leadAt, i < 5 ? wonAt : null);
    if (i < 12) await s.appointment(id, i < 10 ? 'COMPLETED' : 'NO_SHOW', trialAt, created);
    if (i === 12) await s.appointment(id, 'CANCELLED', trialAt, created);
  }
  await s.payment(30000, `${prev}-08`);

  // Next month's renewals.
  const N = await local(at(next, 1, 0)), start = plus(N, -330);
  const end = (day) => plus(N, day);
  made.open = await s.membership({ start, end: end(5), planId: renewPlan });
  const bWho = await s.person();
  made.renewedNew = await s.membership({ start, end: end(6), who: bWho, planId: renewPlan });
  made.successor = await s.membership({ start: end(6), who: bWho, planId: renewPlan });
  made.cancelled = await s.membership({ state: 'CANCELLATION_PENDING', start, end: end(7), planId: renewPlan });
  made.extended = await s.membership({ start, end: end(400), planId: renewPlan });
  await s.extension(made.extended, start, end(8), end(400));
  made.draft = await s.membership({ state: 'DRAFT', start, end: end(9), planId: renewPlan });
  const openEnded = await s.membership({ start });
  made.notSamePerson = await s.membership({ start, end: end(10), planId: renewPlan });
  await s.membership({ start: end(10), planId: renewPlan });
  const hWho = await s.person();
  made.otherProgram = await s.membership({ start, end: end(11), who: hWho, planId: renewPlan });
  await s.membership({ start: end(11), who: hWho, planId: otherProgramPlan });
  // Charges still to come next month: 10000 monthly + 2500 weekly; the rest are excluded.
  await s.schedule(openEnded, 'MONTHLY', 10000, await local(at(next, 3)));
  const weekly = await s.membership({ start });
  const weeklyFirst = await local(at(next, 1));
  await s.schedule(weekly, 'WEEKLY', 2500, weeklyFirst);
  const N1 = (await sql("SELECT ((date_trunc('month', $1::timestamptz AT TIME ZONE $2) + interval '1 month') AT TIME ZONE $2) t", [N, LA])).rows[0].t;
  weeklyCharges = Math.floor((N1.getTime() - weeklyFirst.getTime() - 1000) / (7 * DAY)) + 1;
  await s.schedule(made.open, 'MONTHLY', 9999, await local(at(next, 6)));
  await s.schedule(await s.membership({ start }), 'MONTHLY', 8888, await local(at(next, 3)), 'PAUSED');
  await s.schedule(made.cancelled, 'MONTHLY', 7777, await local(at(next, 3)));

  // This month so far: 5000 collected today, 2 leads, 1 appointment booked, 1 new member.
  await s.payment(5000, today);
  const justNow = (await sql("SELECT clock_timestamp() - interval '1 second' t")).rows[0].t;
  const l1 = await s.lead(justNow); await s.lead(justNow);
  await s.appointment(l1, 'SCHEDULED', plus(justNow, 1), justNow);
  await s.membership({ start: justNow, planId: newPlan });
  return made;
}

const q = (params) => new URLSearchParams(params).toString();
const ceilDiv = (a, b) => Math.ceil(a / b);

try {
  await cleanup();
  await seed();
  renewalIds = await seedSchoolA(school(ids.organization, ids.schoolA, 'A'));
  { const b = school(ids.organization, ids.schoolB, 'B'); for (let i = 0; i < 3; i += 1) await b.lead(await local(at(prev, 3))); }
  await seedSchoolA(school(ids.otherOrganization, ids.otherSchool, 'O'));
  await startApp();

  // 1. Shared renewals-due helper (owner session, exact outcomes).
  const N = await local(at(next, 1, 0));
  const N1 = (await sql("SELECT ((date_trunc('month', $1::timestamptz AT TIME ZONE $2) + interval '1 month') AT TIME ZONE $2) t", [N, LA])).rows[0].t;
  const due = async (asOf) => (await sql('SELECT * FROM hon.school_renewals_due($1,$2,$3,$4,$5) ORDER BY due_at', [ids.organization, ids.schoolA, N, N1, asOf])).rows;
  const rows = await due(new Date());
  const byId = Object.fromEntries(rows.map((r) => [r.membership_id, r]));
  ok(rows.length === 6, `six memberships fall due next month, got ${rows.length}`);
  ok(byId[renewalIds.open]?.outcome === 'OPEN' && byId[renewalIds.open].renewed_by === null, 'an unrenewed future term is OPEN');
  ok(byId[renewalIds.renewedNew]?.outcome === 'RENEWED' && byId[renewalIds.renewedNew].renewed_by === 'NEW_MEMBERSHIP'
    && byId[renewalIds.renewedNew].successor_membership_id === renewalIds.successor, 'a new membership of the same student renews it');
  ok(byId[renewalIds.cancelled]?.outcome === 'CANCELLED', 'cancellation pending is CANCELLED');
  ok(byId[renewalIds.extended]?.outcome === 'RENEWED' && byId[renewalIds.extended].renewed_by === 'EXTENSION'
    && byId[renewalIds.extended].due_at.getTime() === plus(N, 8).getTime(), 'an extension renews it, due at the end before the extension');
  ok(!byId[renewalIds.draft], 'drafts never fall due');
  ok(byId[renewalIds.notSamePerson]?.outcome === 'OPEN', 'another student starting is not a renewal');
  ok(byId[renewalIds.otherProgram]?.outcome === 'OPEN', 'a new membership in another program is not a renewal');
  ok(rows.every((r) => r.plan_code === 'GOALS' && r.price_minor === 20000 && r.currency === 'USD' && r.billing_frequency === 'MONTHLY' && r.term_months === 12 && r.plan_version === 1),
    'plan facts from the catalog selection');
  const later = await due(plus(N, 20));
  ok(later.find((r) => r.membership_id === renewalIds.open).outcome === 'LAPSED', 'past its end without a renewal it is LAPSED');

  // 2. Authority: reporting.view at this school, a direct human, no HQ, family or other-school borrowing.
  const goal = 1000000;
  const plan = await success(() => call(REPORTER, q({ month: next, goalMinor: String(goal), currency: 'USD' })), 'a reporting.view staff member');
  for (const [actor, label] of [[NONE, 'no reporting.view'], [MIXED, 'a mixed parent role'], [HQ, 'an HQ operator']]) {
    await refused(() => call(actor), 403, undefined, `refused for ${label}`);
  }
  await refused(() => call(OTHER_SCHOOL, '', { school: ids.schoolA }), 403, undefined, 'school-B staff at the school-A route');
  await refused(() => call(REPORTER, '', { organization: ids.otherOrganization }), 403, undefined, 'a wrong organization in the route');
  await refused(() => call(REPORTER, '', { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'a read with an idempotency key');
  await refused(() => call(REPORTER, '', { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'a cross-site read');
  await refused(() => call(REPORTER, '', { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'a source selector');
  const farMonth = (await sql("SELECT to_char(date_trunc('month', clock_timestamp() AT TIME ZONE $1) + interval '3 months','YYYY-MM') m", [LA])).rows[0].m;
  const oldMonth = (await sql("SELECT to_char(date_trunc('month', clock_timestamp() AT TIME ZONE $1) - interval '12 months','YYYY-MM') m", [LA])).rows[0].m;
  for (const query of ['goalMinor=100', 'currency=USD', 'goalMinor=-1&currency=USD', 'goalMinor=1.5&currency=USD', 'month=2026-13', `month=${farMonth}`, `month=${oldMonth}`,
    'bookRate=0', 'bookRate=1.5', 'bookRate=0.12345', 'historyMonths=2', 'plannedUpgrades=2', 'avgNewMinor=0', 'x=1', 'month=2026-01&month=2026-02', 'currency=usd&goalMinor=1']) {
    await refused(() => call(REPORTER, query), 400, undefined, `query ${query}`);
  }

  // 3. Next month, exact breakdown from school A's own records.
  const P = plan.data;
  ok(P.schemaVersion === 'MONTHLY_GOAL_PLAN_V1' && P.schoolId === ids.schoolA && P.month === next && P.currentMonth === cur && P.timezone === LA, 'next month, school A');
  ok(P.elapsedShare === 0 && P.pace === null && P.from === N.toISOString() && P.to === N1.toISOString(), 'a future month has no pace yet');
  ok(JSON.stringify(P.rates.renewal) === JSON.stringify({ numerator: 6, denominator: 10, minimumRecords: 10, recordValue: 0.6, value: 0.6, source: 'RECORDS' }), `renewal rate ${JSON.stringify(P.rates.renewal)}`);
  ok(JSON.stringify(P.rates.book) === JSON.stringify({ numerator: 12, denominator: 20, minimumRecords: 10, recordValue: 0.6, value: 0.6, source: 'RECORDS' }), `book rate ${JSON.stringify(P.rates.book)}`);
  ok(JSON.stringify(P.rates.show) === JSON.stringify({ numerator: 10, denominator: 12, minimumRecords: 10, recordValue: 0.8333, value: 0.8333, source: 'RECORDS' }), `show rate ${JSON.stringify(P.rates.show)}`);
  ok(JSON.stringify(P.rates.close) === JSON.stringify({ numerator: 5, denominator: 10, minimumRecords: 10, recordValue: 0.5, value: 0.5, source: 'RECORDS' }), `close rate ${JSON.stringify(P.rates.close)}`);
  ok(JSON.stringify(P.averageNewMembership) === JSON.stringify({ records: 5, minimumRecords: 5, recordValueMinor: 15000, valueMinor: 15000, source: 'RECORDS' }), `average new ${JSON.stringify(P.averageNewMembership)}`);
  ok(JSON.stringify(P.renewals) === JSON.stringify({ due: 6, renewed: 2, cancelled: 1, lapsed: 0, open: 3, openPriced: 3, openValueMinor: 60000, expectedRenewals: 2, expectedValueMinor: 36000 }),
    `renewals ${JSON.stringify(P.renewals)}`);
  const scheduled = 10000 + 2500 * weeklyCharges;
  ok(P.sources.collectedMinor === 0 && P.sources.scheduled.schedules === 2 && P.sources.scheduled.valueMinor === scheduled, `scheduled ${JSON.stringify(P.sources.scheduled)} (weekly x${weeklyCharges})`);
  const gap = goal - scheduled - 36000;
  ok(P.sources.renewalsMinor === 36000 && P.sources.upgrades.valueMinor === 0 && P.sources.gapMinor === gap, `gap ${P.sources.gapMinor} vs ${gap}`);
  const newNeeded = ceilDiv(gap, 15000), shows = ceilDiv(newNeeded, 0.5), appts = Math.ceil(shows * 10000 / 8333), leads = ceilDiv(appts * 10, 6);
  ok(JSON.stringify(P.needed) === JSON.stringify({ renewals: 4, upgrades: 0, newEnrollments: newNeeded, shows, appointments: appts, leads }), `needed ${JSON.stringify(P.needed)}`);
  ok(JSON.stringify(P.suggestedGoals) === JSON.stringify([{ currency: 'USD', monthlyMinor: 10000, months: 3 }]), `suggested ${JSON.stringify(P.suggestedGoals)}`);
  const text = JSON.stringify(P);
  ok(!/MemberA|LeadA|PayerA|KarateA|Bring a water bottle|Renewed for another year|Plan RENEW/.test(text), 'no names, notes or plan names in the plan');
  ok(!text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)?.some((id) => id !== ids.schoolA), 'no record ids except the school');

  // 4. Owner overrides and planned upgrades.
  const tuned = (await success(() => call(OWN, q({ month: next, goalMinor: String(goal), currency: 'USD', bookRate: '0.25', plannedUpgrades: '4', upgradeValueMinor: '5000' })), 'owner overrides')).data;
  ok(tuned.rates.book.source === 'OWNER' && tuned.rates.book.value === 0.25 && tuned.rates.book.recordValue === 0.6, 'the owner rate wins and the record rate stays visible');
  const tunedGap = gap - 20000, tunedNew = ceilDiv(tunedGap, 15000), tunedShows = ceilDiv(tunedNew, 0.5), tunedAppts = Math.ceil(tunedShows * 10000 / 8333);
  ok(tuned.sources.upgrades.planned === 4 && tuned.sources.upgrades.valueMinor === 20000 && tuned.sources.gapMinor === tunedGap, 'planned upgrades reduce the gap');
  ok(tuned.needed.upgrades === 4 && tuned.needed.newEnrollments === tunedNew && tuned.needed.leads === tunedAppts * 4, `tuned needed ${JSON.stringify(tuned.needed)}`);
  const met = (await success(() => call(OWN, q({ month: next, goalMinor: String(scheduled), currency: 'USD' })), 'a goal already covered')).data;
  ok(met.sources.gapMinor === 0 && met.needed.newEnrollments === 0 && met.needed.leads === 0, 'a goal covered by expected income needs no new enrollments');

  // 5. This month: pace against the goal.
  const now = (await success(() => call(OWN, q({ goalMinor: '500000', currency: 'USD' })), 'this month')).data;
  ok(now.month === cur && now.elapsedShare > 0 && now.elapsedShare <= 1 && now.weeksLeft >= 0, 'this month by default, partly elapsed');
  ok(now.sources.collectedMinor === 5000 && now.pace.collected.actual === 5000 && now.pace.collected.needed === 500000, `collected ${JSON.stringify(now.pace.collected)}`);
  ok(now.pace.leads.actual === 2 && now.pace.appointments.actual === 1 && now.pace.newEnrollments.actual === 1 && now.pace.shows.actual === 0, `pace ${JSON.stringify(now.pace)}`);
  ok(now.renewals.due === 0 && now.needed.renewals === 0 && now.pace.renewals.status === 'MET', 'no renewals due this month');
  for (const line of Object.values(now.pace)) {
    if (line.needed === null) continue;
    const spread = line.needed * now.elapsedShare;
    ok(line.remaining === Math.max(line.needed - line.actual, 0) && line.expectedByNow >= spread - 1e-6 && line.expectedByNow < spread + 1, `pace arithmetic ${JSON.stringify(line)}`);
    ok(line.status === (line.actual >= line.needed ? 'MET' : line.actual >= line.expectedByNow * 0.9 ? 'ON_PACE' : 'BEHIND'), `pace status ${JSON.stringify(line)}`);
  }
  const noGoal = (await success(() => call(REPORTER), 'no goal')).data;
  ok(noGoal.goal === null && noGoal.needed === null && noGoal.sources === null && noGoal.pace === null && noGoal.averageNewMembership === null
    && noGoal.renewals.openValueMinor === null && noGoal.suggestedGoals.length === 1, 'without a goal: rates, renewals and a suggestion only');

  // 6. School B: too few records, so counts are unknown until the owner sets the rates.
  const thin = (await success(() => call(B_OWNER, q({ goalMinor: '100000', currency: 'USD' }), { school: ids.schoolB }), 'school B')).data;
  ok(thin.schoolId === ids.schoolB && thin.rates.book.source === 'INSUFFICIENT' && thin.rates.book.denominator === 3 && thin.rates.book.value === null, 'three leads are too few');
  ok(thin.averageNewMembership.source === 'INSUFFICIENT' && thin.needed.newEnrollments === null && thin.needed.leads === null && thin.sources.gapMinor === null, 'unknown, never guessed');
  const set = (await success(() => call(B_OWNER, q({ month: next, goalMinor: '100000', currency: 'USD', renewalRate: '0.5', avgNewMinor: '10000', closeRate: '0.5', showRate: '0.5', bookRate: '0.5' }), { school: ids.schoolB }), 'school B with owner rates')).data;
  ok(JSON.stringify(set.needed) === JSON.stringify({ renewals: 0, upgrades: 0, newEnrollments: 10, shows: 20, appointments: 40, leads: 80 }), `owner-set needed ${JSON.stringify(set.needed)}`);

  // 7. Live authority: a revoked grant or a lapsed entitlement is refused at once.
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE id=$1', [REPORTER.grants[0], OWN.principal]);
  await refused(() => call(REPORTER), 403, undefined, 'refused after the grant is revoked');
  await raw('organization_entitlements', 'UPDATE hon.organization_entitlements SET effective_until=clock_timestamp() WHERE organization_id=$1', [ids.organization]);
  await refused(() => call(OWN), 403, undefined, 'refused without an active entitlement');
  await raw('organization_entitlements', 'UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1', [ids.organization]);
  ok((await call(OWN)).status === 200, 'allowed again once the entitlement is active');

  // 8. Database boundary: one runtime entry point; the helpers are private.
  const names = ['school_renewals_due', 'monthly_goal_rate', 'monthly_goal_pace', 'read_monthly_goal_plan'];
  const fns = (await sql(`SELECT p.oid::regprocedure::text sig, has_function_privilege($1,p.oid,'EXECUTE') runtime,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public, p.prosecdef definer, p.proconfig config
    FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace AND p.proname = ANY($2) ORDER BY 1`, [CRM_CLOSE_RUNTIME_ROLE, names])).rows;
  ok(fns.length === 4 && fns.every((f) => !f.public && JSON.stringify(f.config) === '["search_path=pg_catalog, hon"]'), 'four functions, none public, fixed search path');
  ok(fns.filter((f) => f.runtime).map((f) => f.sig).join() === 'hon.read_monthly_goal_plan(text,jsonb)', 'the runtime may run only the plan read');
  await assert.rejects(runtime.query('SELECT * FROM hon.school_renewals_due($1,$2,now(),now()+interval \'1 month\',now())', [ids.organization, ids.schoolA]), /permission denied/); checks += 1;
  await assert.rejects(runtime.query('SELECT hon.read_monthly_goal_plan($1,$2::jsonb)', [OWN.subject, '{}']), /SCHOOL_REPORTS_FORBIDDEN|tenant|permission/i); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const startMark = '-- Monthly goal plan exact verification (G1 0686)', endMark = '-- End monthly goal plan exact verification.';
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: monthly goal plan (0686): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
