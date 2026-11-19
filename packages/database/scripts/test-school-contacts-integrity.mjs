/**
 * School contacts list proof (C1, 0521) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guard + global
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

const session = { mode: 'OIDC', audience: 'hon-school-contacts', secret: randomBytes(32).toString('hex') };
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

function call(actor, query = '', { headers = {}, school = actor.school, organization = actor.org, method = 'GET' } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/contacts${query ? `?${query}` : ''}`);
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
    const result = await runtime.query("SELECT hon.read_school_contact_list($1,'{}'::jsonb) AS data", [actor.subject]);
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
    await sql('DELETE FROM hon.hq_operator_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`contacts-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`contacts-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`contacts-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`contacts-${ids.organization}-%`]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `contacts-${ids.organization}-${label}`;
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

let OWN, READER, NONE, MIXED, OTHER_SCHOOL, HQ;
const seeded = {};

async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Contacts Org','Contacts Org'),($2,'Contacts Other Org','Contacts Other Org')", orgs());
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", orgs());
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Contacts ${slug}`, `contacts-${slug}-${school.slice(0, 8)}`, LA]);
  }
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  READER = await staff('reader', [await role(ids.organization, ['people.read'])]);
  NONE = await staff('none', [await role(ids.organization, ['reporting.view', 'crm.lead.read', 'attendance.record'])]);
  MIXED = await staff('mixed', [await role(ids.organization, ['people.read']), await role(ids.organization, ['people.read'], 'PARENT_PORTAL')]);
  OTHER_SCHOOL = await staff('other-school', [await role(ids.organization, allPermissions)], { school: ids.schoolB });
  HQ = await staff('hq', [await role(ids.organization, ['people.read'])]);
  await sql("INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_OWNER')", [HQ.principal]);
}

// The same synthetic people in each school: two students, a trial, two prospects, a former member, a payer and 55 others.
async function records(org, school, tag) {
  const person = async (given, family, extra = {}) => {
    const id = randomUUID();
    await sql('INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email,phone_e164) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [id, org, school, given, family, extra.email ?? null, extra.phone ?? null]);
    return id;
  };
  const avery = await person('Avery', 'Able', { email: `avery.${tag.toLowerCase()}@example.test` });
  const blake = await person('Blake', 'Brown', { phone: '+15555550101' });
  const casey = await person('Casey', 'Cole'), drew = await person('Drew', 'Dunn'), eli = await person('Eli', 'East');
  const finn = await person('Finn', 'Ford'), gale = await person('Gale', 'Gray');
  for (let i = 0; i < 55; i += 1) await person(`Pat${String(i).padStart(2, '0')}`, 'Zulu');

  const account = randomUUID();
  await sql('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id) VALUES($1,$2,$3,$4)', [account, org, school, gale]);
  const membership = async (participant, state, ends) => {
    const id = randomUUID();
    await raw('memberships', `INSERT INTO hon.memberships(id,organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at)
      VALUES($1,$2,$3,$4,$5,'KIDS-MONTHLY',$6,clock_timestamp()-interval '60 days',$7)`, [id, org, school, account, participant, state, ends]);
    return id;
  };
  const averyMembership = await membership(avery, 'ACTIVE', new Date(Date.now() + 20 * 86400000));
  await membership(blake, 'ACTIVE', null);
  await membership(finn, 'EXPIRED', new Date(Date.now() - 5 * 86400000));
  await membership(gale, 'DRAFT', null);

  const program = randomUUID(), plan = randomUUID();
  await sql("INSERT INTO hon.programs(id,organization_id,school_id,name) VALUES($1,$2,$3,'Little Tigers')", [program, org, school]);
  await raw('membership_plans', "INSERT INTO hon.membership_plans(id,organization_id,school_id,plan_code,current_version,created_by_principal_id) VALUES($1,$2,$3,'KIDS-MONTHLY',1,$4)", [plan, org, school, OWN.principal]);
  await raw('membership_plan_versions', `INSERT INTO hon.membership_plan_versions(plan_id,version,organization_id,school_id,display_name,program_id,availability,currency,price_minor,billing_frequency,term_kind,actor_principal_id)
    VALUES($1,1,$2,$3,'Kids monthly',$4,'AVAILABLE','USD',12900,'MONTHLY','OPEN_ENDED',$5)`, [plan, org, school, program, OWN.principal]);
  await raw('membership_plan_selections', 'INSERT INTO hon.membership_plan_selections(membership_id,organization_id,school_id,plan_id,plan_version,actor_principal_id) VALUES($1,$2,$3,$4,1,$5)',
    [averyMembership, org, school, plan, OWN.principal]);

  const pipeline = randomUUID(), stage = randomUUID();
  await sql("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'Contacts pipeline')", [pipeline, org, school]);
  await sql("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'New',1)", [stage, org, school, pipeline]);
  const lead = async (personId, status = 'OPEN') => {
    const id = randomUUID();
    await raw('crm_leads', `INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status,lost_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, org, school, personId, pipeline, stage, status, status === 'LOST' ? new Date() : null]);
    return id;
  };
  const appointment = (leadId, status) => raw('crm_appointments', `INSERT INTO hon.crm_appointments(organization_id,school_id,crm_lead_id,appointment_type,status,starts_at,ends_at,created_by_principal_id)
    VALUES($1,$2,$3,'TRIAL',$4,clock_timestamp()+interval '2 days',clock_timestamp()+interval '2 days 1 hour',$5)`, [org, school, leadId, status, OWN.principal]);
  await lead(blake); // a student with an open lead is still a student
  await appointment(await lead(casey), 'SCHEDULED');
  await lead(drew);
  await appointment(await lead(eli), 'CANCELLED');
  await appointment(await lead(gale, 'LOST'), 'SCHEDULED'); // a closed lead never makes a trial

  const curriculum = randomUUID();
  await sql("INSERT INTO hon.curricula(id,organization_id,school_id,name,model_code) VALUES($1,$2,$3,'Karate','LINEAR')", [curriculum, org, school]);
  const rank = async (name, color, order) => { const id = randomUUID(); await raw('curriculum_ranks', 'INSERT INTO hon.curriculum_ranks(id,organization_id,school_id,curriculum_id,name,display_color,progression_order) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, org, school, curriculum, name, color, order]); return id; };
  const white = await rank('White', '#ffffff', 1), yellow = await rank('Yellow', 'url(x)', 2);
  const enroll = async (personId, rankId, status = 'ACTIVE') => {
    const profile = randomUUID();
    await sql('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id) VALUES($1,$2,$3,$4)', [profile, org, school, personId]);
    await raw('student_curriculum_enrollments', 'INSERT INTO hon.student_curriculum_enrollments(organization_id,school_id,student_profile_id,curriculum_id,current_rank_id,status) VALUES($1,$2,$3,$4,$5,$6)', [org, school, profile, curriculum, rankId, status]);
  };
  await enroll(avery, white); await enroll(blake, yellow); await enroll(finn, yellow, 'ARCHIVED');
  return { avery, blake, casey, drew, eli, finn, gale, program, plan, white, yellow };
}

const names = (body) => body.data.rows.map((row) => `${row.givenName} ${row.familyName}`);
const json = (v) => JSON.stringify(v);

try {
  await cleanup();
  await seed();
  seeded.A = await records(ids.organization, ids.schoolA, 'A');
  seeded.B = await records(ids.organization, ids.schoolB, 'B');
  await records(ids.otherOrganization, ids.otherSchool, 'O');
  await startApp();
  const A = seeded.A;

  // 1. Authority: people.read at this school, a direct human; no HQ, family or other-school borrowing.
  const first = await success(async () => {
    const started = Date.now(), response = await call(READER, 'options=true');
    if (response.status !== 200) await diagnose(READER, Date.now() - started);
    return response;
  }, 'a people.read staff member');
  for (const [actor, label] of [[NONE, 'no people.read'], [MIXED, 'a mixed parent role'], [HQ, 'an HQ operator']]) {
    await refused(() => call(actor), 403, undefined, `refused for ${label}`);
  }
  await refused(() => call(OTHER_SCHOOL, '', { school: ids.schoolA }), 403, undefined, 'school-B staff at the school-A route');
  await refused(() => call(READER, '', { organization: ids.otherOrganization }), 403, undefined, 'a wrong organization in the route');
  await refused(() => call(READER, '', { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'a read with an idempotency key');
  await refused(() => call(READER, '', { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'a cross-site read');
  await refused(() => call(READER, '', { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'a source selector');
  for (const query of ['segment=student', 'segment=OTHER', 'endsWithinDays=14', 'rankId=nope', 'query=', 'segment=ALL&segment=STUDENT', 'limit=5', 'afterId=' + A.avery, 'options=yes']) {
    await refused(() => call(READER, query), 400, undefined, `query ${query}`);
  }

  // 2. All contacts: counts per segment, name order, 50 per page, options for the filters.
  // 0523 adds the ARCHIVED count (archived and merged contacts, left out of ALL); the merge proof covers it.
  const F = first.data;
  ok(json(F.counts) === json({ ALL: 62, STUDENT: 2, TRIAL: 1, PROSPECT: 2, INACTIVE: 1, ARCHIVED: 0 }), `counts ${json(F.counts)}`);
  ok(F.segment === 'ALL' && F.rows.length === 50 && F.hasMore === true && typeof F.nextCursor === 'string', 'first page of 50 with a cursor');
  ok(json(names(first).slice(0, 7)) === json(['Avery Able', 'Blake Brown', 'Casey Cole', 'Drew Dunn', 'Eli East', 'Finn Ford', 'Gale Gray']), `name order ${names(first).slice(0, 7)}`);
  const row = (body, given) => body.data.rows.find((r) => r.givenName === given);
  const avery = row(first, 'Avery');
  ok(avery.segment === 'STUDENT' && avery.planName === 'Kids monthly' && avery.programName === 'Little Tigers' && avery.planCode === 'KIDS-MONTHLY'
    && avery.email === 'avery.a@example.test' && avery.personId === A.avery && json(avery.ranks) === json([{ rank: 'White', color: '#ffffff' }])
    && Math.abs(Date.parse(avery.membershipEndsAt) - Date.now() - 20 * 86400000) < 3600000, `student row ${json(avery)}`);
  const blake = row(first, 'Blake');
  ok(blake.segment === 'STUDENT' && blake.planName === null && blake.membershipEndsAt === null && blake.phoneE164 === '+15555550101'
    && json(blake.ranks) === json([{ rank: 'Yellow', color: null }]), 'a student with an open lead stays a student; an unsafe colour is dropped');
  ok(row(first, 'Casey').segment === 'TRIAL' && row(first, 'Drew').segment === 'PROSPECT' && row(first, 'Eli').segment === 'PROSPECT'
    && row(first, 'Finn').segment === 'INACTIVE' && json(row(first, 'Finn').ranks) === '[]' && row(first, 'Gale').segment === 'OTHER', 'segments: trial, prospect, cancelled trial, former member, payer');
  ok(json(F.options.programs) === json([{ programId: A.program, name: 'Little Tigers' }]) && json(F.options.plans) === json([{ planId: A.plan, name: 'Kids monthly' }])
    && json(F.options.ranks) === json([{ rankId: A.white, curriculum: 'Karate', rank: 'White' }, { rankId: A.yellow, curriculum: 'Karate', rank: 'Yellow' }]), 'filter options from this school only');
  const second = await success(() => call(READER, `cursor=${encodeURIComponent(F.nextCursor)}`), 'second page');
  ok(second.data.rows.length === 12 && second.data.hasMore === false && second.data.nextCursor === null && second.data.options === null
    && new Set([...names(first), ...names(second)]).size === 62, 'second page has the rest, no repeats');
  await refused(() => call(READER, `segment=STUDENT&cursor=${encodeURIComponent(F.nextCursor)}`), 400, 'INVALID_CURSOR', 'a cursor reused with another filter');

  // 3. Segments and filters.
  const read = async (query, label) => success(() => call(READER, query), label);
  ok(json(names(await read('segment=STUDENT', 'students'))) === json(['Avery Able', 'Blake Brown']), 'students');
  ok(json(names(await read('segment=TRIAL', 'trials'))) === json(['Casey Cole']), 'trials');
  ok(json(names(await read('segment=PROSPECT', 'prospects'))) === json(['Drew Dunn', 'Eli East']), 'prospects');
  ok(json(names(await read('segment=INACTIVE', 'inactive'))) === json(['Finn Ford']), 'inactive');
  const soon = await read('endsWithinDays=30', 'ends within 30 days');
  ok(json(names(soon)) === json(['Avery Able']) && json(soon.data.counts) === json({ ALL: 1, STUDENT: 1, TRIAL: 0, PROSPECT: 0, INACTIVE: 0, ARCHIVED: 0 }), 'ends within 30 days narrows the counts too');
  ok(json(names(await read('endsWithinDays=7', 'ends within 7 days'))) === '[]', 'nothing ends within 7 days');
  ok(json(names(await read(`planId=${A.plan}`, 'plan'))) === json(['Avery Able']) && json(names(await read(`programId=${A.program}`, 'program'))) === json(['Avery Able']), 'plan and program');
  ok(json(names(await read(`rankId=${A.yellow}`, 'rank'))) === json(['Blake Brown']), 'an archived enrollment never matches a rank');
  ok(json(names(await read('query=brown', 'name search'))) === json(['Blake Brown']) && json(names(await read('query=avery.a%40example', 'email search'))) === json(['Avery Able'])
    && json(names(await read('query=5550101', 'phone search'))) === json(['Blake Brown']), 'search by name, email or phone');
  ok(json(names(await read(`planId=${seeded.B.plan}`, 'another school plan'))) === '[]', 'another school plan matches nothing');

  // 4. Isolation: school B sees its own people only, and no school A data appears anywhere.
  const b = await success(() => call(OTHER_SCHOOL), 'school B');
  ok(json(b.data.counts) === json(F.counts) && !json(b.data).includes(A.avery) && row(b, 'Avery').email === 'avery.b@example.test', 'school B reads its own rows only');
  ok(!json(F).includes(seeded.B.avery) && !/\.b@example|\.o@example/.test(json(F) + json(second)), 'no school B or other-organization people in school A');

  // 5. Live authority: a revoked grant and a lapsed entitlement are refused at once.
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE id=$1', [READER.grants[0], OWN.principal]);
  await refused(() => call(READER), 403, undefined, 'refused after the grant is revoked');
  await raw('organization_entitlements', 'UPDATE hon.organization_entitlements SET effective_until=clock_timestamp() WHERE organization_id=$1', [ids.organization]);
  await refused(() => call(OWN), 403, undefined, 'refused without an active entitlement');
  await raw('organization_entitlements', 'UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1', [ids.organization]);
  ok((await call(OWN)).status === 200, 'allowed again once the entitlement is active');

  // 6. Database boundary: one runtime entry point; helpers private; fixed search path; the 011 section passes.
  const fns = (await sql(`SELECT p.oid::regprocedure::text sig, has_function_privilege($1,p.oid,'EXECUTE') runtime,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public, p.prosecdef definer, p.proconfig config, p.provolatile
    FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace AND p.proname IN ('require_school_contacts_actor','school_contact_facts','read_school_contact_list') ORDER BY 1`,
  [CRM_CLOSE_RUNTIME_ROLE])).rows;
  ok(fns.length === 3 && fns.every((f) => f.definer && !f.public && f.provolatile === 's' && JSON.stringify(f.config) === '["search_path=pg_catalog, hon"]'), 'three stable definer functions, none public, fixed search path');
  ok(fns.filter((f) => f.runtime).map((f) => f.sig).join() === 'hon.read_school_contact_list(text,jsonb)', 'the runtime may run only the contacts read');
  await assert.rejects(runtime.query('SELECT * FROM hon.school_contact_facts($1,$2,now())', [ids.organization, ids.schoolA]), /permission denied/); checks += 1;
  await assert.rejects(runtime.query('SELECT hon.require_school_contacts_actor($1)', [OWN.subject]), /permission denied/); checks += 1;
  await assert.rejects(runtime.query('SELECT hon.read_school_contact_list($1,$2::jsonb)', [OWN.subject, '{}']), /SCHOOL_CONTACTS_FORBIDDEN|tenant|permission/i); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const startMark = '-- School contacts list exact verification (C1 0521)', endMark = '-- End school contacts list exact verification.';
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: school contacts list (0521): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
