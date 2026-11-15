/**
 * School contact card proof (C2, 0374) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guard + global
 * ValidationPipe + HonExceptionFilter -> SchoolContactsController -> one protected definer function on the restricted runtime
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
const { SchoolContactsController } = await load('people/school-contacts.controller.js');
const { SchoolContactsService } = await load('people/school-contacts.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-school-contact-card', secret: randomBytes(32).toString('hex') };
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
    controllers: [SchoolContactsController],
    providers: [HonIdentityGuard, HonIdentityService, SchoolContactsService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}

function call(actor, person, { headers = {}, school = actor.school, organization = actor.org, method = 'GET', query = '' } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/contacts/${person}${query ? `?${query}` : ''}`);
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
    const result = await runtime.query("SELECT hon.read_school_contact_card($1,'{}'::jsonb) AS data", [actor.subject]);
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
    await sql('DELETE FROM hon.hq_operator_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`card-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`card-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`card-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`card-${ids.organization}-%`]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `card-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Contacts Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Contacts Staff')", [principal, user]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  return { subject, principal, grants, org, school };
}

let OWN, READER, CARD, NONE, MIXED, OTHER_SCHOOL, HQ;
const seeded = {};
const CARD_PERMISSIONS = ['people.read', 'family.read', 'crm.lead.read', 'billing.membership.read', 'communication.message.read', 'attendance.record'];

async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Card Org','Card Org'),($2,'Card Other Org','Card Other Org')", orgs());
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", orgs());
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Card ${slug}`, `card-${slug}-${school.slice(0, 8)}`, LA]);
  }
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  READER = await staff('reader', [await role(ids.organization, ['people.read'])]);
  CARD = await staff('card', [await role(ids.organization, CARD_PERMISSIONS)]);
  NONE = await staff('none', [await role(ids.organization, CARD_PERMISSIONS.filter((p) => p !== 'people.read'))]);
  MIXED = await staff('mixed', [await role(ids.organization, CARD_PERMISSIONS), await role(ids.organization, ['people.read'], 'PARENT_PORTAL')]);
  OTHER_SCHOOL = await staff('other-school', [await role(ids.organization, allPermissions)], { school: ids.schoolB });
  HQ = await staff('hq', [await role(ids.organization, CARD_PERMISSIONS)]);
  await sql("INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_OWNER')", [HQ.principal]);
}

// One student (Avery) with a guardian (Gale), a won lead with a trial and follow-ups, a membership, an invoice with a payment,
// a direct message, a family thread and an attendance mark; the same in school B and the other organization.
async function records(org, school, tag) {
  const person = async (given, family, email = null) => { const id = randomUUID(); await sql('INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email) VALUES($1,$2,$3,$4,$5,$6)', [id, org, school, given, family, email]); return id; };
  const avery = await person('Avery', 'Able', `avery.${tag}@example.test`), gale = await person('Gale', 'Able'), stranger = await person('Sam', 'Stranger');
  const familyId = randomUUID();
  await sql("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'Able family')", [familyId, org, school]);
  await raw('family_members', "INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role,is_billing_contact) VALUES($1,$2,$3,$4,'STUDENT',false),($1,$2,$3,$5,'GUARDIAN',true)", [org, school, familyId, avery, gale]);
  await raw('family_message_threads', 'INSERT INTO hon.family_message_threads(organization_id,school_id,family_id,message_count) VALUES($1,$2,$3,3)', [org, school, familyId]);
  await raw('communication_messages', "INSERT INTO hon.communication_messages(organization_id,school_id,recipient_person_id,channel,content,created_by_principal_id) VALUES($1,$2,$3,'EMAIL','Private message text',$4)", [org, school, avery, OWN.principal]);

  const account = randomUUID(), membership = randomUUID();
  await sql('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id) VALUES($1,$2,$3,$4)', [account, org, school, gale]);
  await raw('memberships', `INSERT INTO hon.memberships(id,organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at)
    VALUES($1,$2,$3,$4,$5,'KIDS-MONTHLY','ACTIVE','2026-09-01T07:00:00Z','2027-09-01T07:00:00Z')`, [membership, org, school, account, avery]);
  const plan = randomUUID();
  await raw('membership_plans', "INSERT INTO hon.membership_plans(id,organization_id,school_id,plan_code,current_version,created_by_principal_id) VALUES($1,$2,$3,'KIDS-MONTHLY',1,$4)", [plan, org, school, OWN.principal]);
  await raw('membership_plan_versions', `INSERT INTO hon.membership_plan_versions(plan_id,version,organization_id,school_id,display_name,availability,currency,price_minor,billing_frequency,term_kind,actor_principal_id)
    VALUES($1,1,$2,$3,'Kids monthly','AVAILABLE','USD',12900,'MONTHLY','OPEN_ENDED',$4)`, [plan, org, school, OWN.principal]);
  await raw('membership_plan_selections', 'INSERT INTO hon.membership_plan_selections(membership_id,organization_id,school_id,plan_id,plan_version,actor_principal_id) VALUES($1,$2,$3,$4,1,$5)', [membership, org, school, plan, OWN.principal]);
  const invoice = async (status, total, created) => { const id = randomUUID(); await raw('invoices', `INSERT INTO hon.invoices(id,organization_id,school_id,billing_account_id,membership_id,status,currency,subtotal_minor,total_minor,created_at,due_at)
    VALUES($1,$2,$3,$4,$5,$6,'USD',$7,$7,$8,$8::timestamptz+interval '7 days')`, [id, org, school, account, membership, status, total, created]); return id; };
  const open = await invoice('ISSUED', 12900, '2026-10-01T16:00:00Z');
  await invoice('PAID', 12900, '2026-09-01T16:00:00Z'); await invoice('DRAFT', 500, '2026-10-02T16:00:00Z');
  const pay = (amount, voided) => raw('invoice_payment_records', `INSERT INTO hon.invoice_payment_records(organization_id,school_id,invoice_id,amount_minor,currency,received_on,method,actor_principal_id,voided_at,voided_by_principal_id,void_reason)
    VALUES($1,$2,$3,$4,'USD','2026-10-05','CASH',$5,$6,$7,$8)`, [org, school, open, amount, OWN.principal, voided ? new Date() : null, voided ? OWN.principal : null, voided ? 'Entered twice' : null]);
  await pay(5000, false); await pay(999, true);

  const pipeline = randomUUID(), stage = randomUUID(), lead = randomUUID();
  await sql("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'Card pipeline')", [pipeline, org, school]);
  await sql("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'New',1)", [stage, org, school, pipeline]);
  await raw('crm_leads', `INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status,created_at,won_at)
    VALUES($1,$2,$3,$4,$5,$6,'WON','2026-08-20T16:00:00Z','2026-08-30T16:00:00Z')`, [lead, org, school, avery, pipeline, stage]);
  await raw('crm_appointments', `INSERT INTO hon.crm_appointments(organization_id,school_id,crm_lead_id,appointment_type,status,starts_at,ends_at,notes,created_by_principal_id)
    VALUES($1,$2,$3,'TRIAL','COMPLETED','2026-08-25T23:00:00Z','2026-08-26T00:00:00Z','Private appointment note',$4)`, [org, school, lead, OWN.principal]);
  const followUp = async (subject, status, due) => {
    const id = randomUUID();
    await raw('crm_follow_ups', 'INSERT INTO hon.crm_follow_ups(id,organization_id,school_id,lead_id,created_by_principal_id) VALUES($1,$2,$3,$4,$5)', [id, org, school, lead, OWN.principal]);
    await raw('crm_follow_up_versions', `INSERT INTO hon.crm_follow_up_versions(follow_up_id,organization_id,school_id,version,assignee_id,subject,note,due_at,priority,status,operation,actor_principal_id,source,request_id)
      VALUES($1,$2,$3,1,$4,$5,'Private follow-up note',$6,'HIGH','OPEN','CREATE',$4,'HUMAN_UI',$7)`, [id, org, school, OWN.principal, subject, due, randomUUID()]);
    if (status !== 'OPEN') await raw('crm_follow_up_versions', `INSERT INTO hon.crm_follow_up_versions(follow_up_id,organization_id,school_id,version,assignee_id,subject,note,due_at,priority,status,operation,completed_at,actor_principal_id,source,request_id)
      VALUES($1,$2,$3,2,$4,$5,'',$6,'HIGH','COMPLETED','COMPLETE',clock_timestamp(),$4,'HUMAN_UI',$7)`, [id, org, school, OWN.principal, subject, due, randomUUID()]);
  };
  await followUp('Call about the belt test', 'OPEN', '2026-12-01T17:00:00Z'); await followUp('Send welcome pack', 'COMPLETED', '2026-09-02T17:00:00Z');

  const profile = randomUUID(), curriculum = randomUUID(), rank = randomUUID(), program = randomUUID(), session = randomUUID();
  await sql('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id,primary_family_id) VALUES($1,$2,$3,$4,$5)', [profile, org, school, avery, familyId]);
  await sql("INSERT INTO hon.curricula(id,organization_id,school_id,name,model_code) VALUES($1,$2,$3,'Karate','LINEAR')", [curriculum, org, school]);
  await raw('curriculum_ranks', "INSERT INTO hon.curriculum_ranks(id,organization_id,school_id,curriculum_id,name,display_color,progression_order) VALUES($1,$2,$3,$4,'White','#ffffff',1)", [rank, org, school, curriculum]);
  await raw('student_curriculum_enrollments', "INSERT INTO hon.student_curriculum_enrollments(organization_id,school_id,student_profile_id,curriculum_id,current_rank_id,status) VALUES($1,$2,$3,$4,$5,'ACTIVE')", [org, school, profile, curriculum, rank]);
  await sql("INSERT INTO hon.programs(id,organization_id,school_id,name) VALUES($1,$2,$3,'Little Tigers')", [program, org, school]);
  await raw('class_sessions', `INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy)
    VALUES($1,$2,$3,$4,'Little Tigers','2026-10-10T23:00:00Z','2026-10-10T23:45:00Z',20,'OPTIONAL_BOOKING')`, [session, org, school, program]);
  await raw('attendance_records', `INSERT INTO hon.attendance_records(organization_id,school_id,class_session_id,student_profile_id,status,recorded_by_principal_id,recorded_at,note,progression_enabled,progression_weight_milli,progression_credit_milli)
    VALUES($1,$2,$3,$4,'PRESENT',$5,'2026-10-10T23:50:00Z','Private attendance note',false,0,0)`, [org, school, session, profile, OWN.principal]);
  return { avery, gale, stranger, familyId, membership };
}

// jsonb orders keys by length, so compare with sorted keys.
const sorted = (v) => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;
const json = (v) => JSON.stringify(sorted(v));
try {
  await cleanup();
  await seed();
  seeded.A = await records(ids.organization, ids.schoolA, 'a');
  seeded.B = await records(ids.organization, ids.schoolB, 'b');
  await records(ids.otherOrganization, ids.otherSchool, 'o');
  await startApp();
  const A = seeded.A;

  // 1. Authority: people.read at this school, a direct human; no HQ, family or other-school borrowing; closed request.
  const full = await success(async () => {
    const started = Date.now(), response = await call(CARD, A.avery);
    if (response.status !== 200) await diagnose(CARD, Date.now() - started);
    return response;
  }, 'a staff member with every card permission');
  for (const [actor, label] of [[NONE, 'no people.read'], [MIXED, 'a mixed parent role'], [HQ, 'an HQ operator']]) await refused(() => call(actor, A.avery), 403, undefined, `refused for ${label}`);
  await refused(() => call(OTHER_SCHOOL, A.avery, { school: ids.schoolA }), 403, undefined, 'school-B staff at the school-A route');
  await refused(() => call(CARD, A.avery, { organization: ids.otherOrganization }), 403, undefined, 'a wrong organization in the route');
  await refused(() => call(CARD, seeded.B.avery), 404, 'SCHOOL_CONTACT_NOT_FOUND', 'a school-B person at the school-A route');
  await refused(() => call(CARD, randomUUID()), 404, 'SCHOOL_CONTACT_NOT_FOUND', 'an unknown person');
  await refused(() => call(CARD, 'not-a-uuid'), 400, undefined, 'a malformed person id');
  await refused(() => call(CARD, A.avery, { query: 'x=1' }), 400, undefined, 'any query string');
  await refused(() => call(CARD, A.avery, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'a read with an idempotency key');
  await refused(() => call(CARD, A.avery, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'a cross-site read');

  // 2. Every section for a viewer who may read it.
  const C = full.data;
  ok(C.person.personId === A.avery && C.person.givenName === 'Avery' && C.person.email === 'avery.a@example.test', 'the person');
  ok(json(C.overview) === json({ segment: 'STUDENT', planName: 'Kids monthly', programName: null, membershipEndsAt: '2027-09-01T07:00:00.000Z',
    ranks: [{ curriculum: 'Karate', rank: 'White', color: '#ffffff' }], openLead: false }), `overview ${json(C.overview)}`);
  ok(C.family.allowed && C.family.families.length === 1 && C.family.families[0].name === 'Able family'
    && json(C.family.families[0].members.map((m) => [m.givenName, m.role, m.billingContact])) === json([['Gale', 'GUARDIAN', true], ['Avery', 'STUDENT', false]]), `family ${json(C.family)}`);
  ok(json(C.appointments) === json({ allowed: true, items: [{ type: 'TRIAL', status: 'COMPLETED', startsAt: '2026-08-25T23:00:00.000Z', endsAt: '2026-08-26T00:00:00.000Z' }] }), 'appointments');
  ok(json(C.tasks) === json({ allowed: true, items: [{ title: 'Call about the belt test', status: 'OPEN', priority: 'HIGH', dueAt: '2026-12-01T17:00:00.000Z' }] }), `open follow-ups only ${json(C.tasks)}`);
  ok(C.membership.allowed && C.membership.items.length === 1 && C.membership.items[0].membershipId === A.membership && C.membership.items[0].planName === 'Kids monthly', 'membership');
  ok(C.billing.allowed && json(C.billing.open) === json([{ currency: 'USD', dueMinor: 7900 }])
    && json(C.billing.invoices.map((i) => [i.status, i.totalMinor, i.paidMinor])) === json([['ISSUED', 12900, 5000], ['PAID', 12900, 0]]), `billing: voided payments and drafts left out ${json(C.billing)}`);
  ok(json(C.messages) === json({ allowed: true, direct: 1, family: 3 }), 'message counts');
  ok(json(C.timeline.map((e) => e.kind)) === json(['PERSON_ADDED', 'ATTENDANCE', 'PAYMENT', 'MEMBERSHIP_STARTED', 'LEAD_WON', 'APPOINTMENT', 'LEAD_OPENED']), `timeline: past events only, newest first ${json(C.timeline)}`);
  ok(!/Private|Entered twice/.test(json(C)), 'no notes, message text or void reasons');

  // 3. Each section follows its own permission: people.read alone sees the person, overview and only the person-added event.
  const R = (await success(() => call(READER, A.avery), 'people.read only')).data;
  ok(['family', 'appointments', 'tasks', 'membership', 'billing', 'messages'].every((k) => json(R[k]) === '{"allowed":false}'), 'every other section says not allowed');
  ok(R.overview.segment === 'STUDENT' && json(R.timeline.map((e) => e.kind)) === json(['PERSON_ADDED']), 'overview and person-added only');
  const own = (await success(() => call(OWN, A.avery), 'owner')).data;
  ok(json({ ...own, generatedAt: 0 }) === json({ ...C, generatedAt: 0 }), 'the owner sees the same card');
  const b = (await success(() => call(OTHER_SCHOOL, seeded.B.avery), 'school B')).data;
  ok(b.person.email === 'avery.b@example.test' && !json(b).includes(A.avery) && !json(C).includes(seeded.B.avery), 'schools never mix');
  const stranger = (await success(() => call(CARD, A.stranger), 'a contact with no records')).data;
  ok(stranger.overview.segment === 'OTHER' && stranger.family.families.length === 0 && stranger.billing.invoices.length === 0 && stranger.timeline.length === 1, 'an empty card');

  // 4. Live authority: a revoked grant and a lapsed entitlement are refused at once.
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE id=$1', [CARD.grants[0], OWN.principal]);
  await refused(() => call(CARD, A.avery), 403, undefined, 'refused after the grant is revoked');
  await raw('organization_entitlements', 'UPDATE hon.organization_entitlements SET effective_until=clock_timestamp() WHERE organization_id=$1', [ids.organization]);
  await refused(() => call(OWN, A.avery), 403, undefined, 'refused without an active entitlement');
  await raw('organization_entitlements', 'UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1', [ids.organization]);
  ok((await call(OWN, A.avery)).status === 200, 'allowed again once the entitlement is active');

  // 5. Database boundary.
  const fns = (await sql(`SELECT p.oid::regprocedure::text sig, has_function_privilege($1,p.oid,'EXECUTE') runtime,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public, p.prosecdef definer, p.proconfig config
    FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace AND p.proname IN ('school_contact_card_can','school_contact_card_time','read_school_contact_card') ORDER BY 1`,
  [CRM_CLOSE_RUNTIME_ROLE])).rows;
  ok(fns.length === 3 && fns.every((f) => f.definer && !f.public && JSON.stringify(f.config) === '["search_path=pg_catalog, hon"]'), 'three definer functions, none public, fixed search path');
  ok(fns.filter((f) => f.runtime).map((f) => f.sig).join() === 'hon.read_school_contact_card(text,jsonb)', 'the runtime may run only the card read');
  await assert.rejects(runtime.query('SELECT hon.school_contact_card_can($1,$2,$3,$4)', [OWN.principal, ids.organization, ids.schoolA, 'family.read']), /permission denied/); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const startMark = '-- School contact card exact verification (C2 0374)', endMark = '-- End school contact card exact verification.';
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: school contact card (0374): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
