/**
 * School email and text blasts proof (BL1, 0500) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guards
 * + global ValidationPipe + HonExceptionFilter -> SchoolBlastController -> protected definer functions on the restricted
 * runtime role with forced RLS), on the guarded disposable CRM-close fixture only. Synthetic contacts only. Messages are
 * only QUEUED for the 0243 worker; no provider is called and nothing is paid.
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
import { membershipFixtureStatement } from './membership-activation-test-support.mjs';

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
const { SchoolBlastController } = await load('school-blasts/school-blast.controller.js');
const { SchoolBlastService } = await load('school-blasts/school-blast.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-school-blasts', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };

let app, origin;
const database = new RuntimeDatabaseService();
async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [SchoolBlastController],
    providers: [HonIdentityGuard, HonIdentityService, SchoolBlastService, { provide: RuntimeDatabaseService, useValue: database }],
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
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/marketing/blasts${path}${query}`);
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
const list = (actor, options = {}) => call(actor, 'GET', options);
const read = (actor, id, options = {}) => call(actor, 'GET', { path: `/${id}`, ...options });
const audience = (actor, id, options = {}) => call(actor, 'GET', { path: `/${id}/audience`, ...options });
const save = (actor, body, options = {}) => call(actor, 'POST', { command: 'marketing_blast.save', body, ...options });
const send = (actor, body, options = {}) => call(actor, 'POST', { path: '/send', command: 'marketing_blast.send', body, ...options });
const cancel = (actor, body, options = {}) => call(actor, 'POST', { path: '/cancel', command: 'marketing_blast.cancel', body, ...options });
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
  await sql('BEGIN');
  try { await run(); } catch (error) { await sql('ROLLBACK'); ok(pattern.test(error.message), `${label}: ${error.message}`); return; }
  await sql('ROLLBACK');
  assert.fail(`${label}: expected a refusal`);
}

// Disposable-fixture cleanup only (as in the 0478 proof).
async function cleanup(orgs = [ids.organization, ids.otherOrganization], subjects = `%blast-${ids.organization}-%`) {
  const tables = (await sql(`SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
    WHERE c.relnamespace='hon'::regnamespace AND c.relkind='r' ORDER BY 1`)).rows.map((row) => row.relname);
  await sql('BEGIN');
  await sql('SET CONSTRAINTS ALL IMMEDIATE'); // crm_leads carries deferred checks; fire them now so its triggers can be switched off
  try {
    for (let pass = 0; pass < 10; pass += 1) {
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
    const left = (await sql('SELECT count(*)::int n FROM hon.school_blasts WHERE organization_id = ANY($1::uuid[])', [orgs])).rows[0].n;
    if (left) throw new Error('fixture cleanup left a blast behind');
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [subjects]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [subjects]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [subjects]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [orgs]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [orgs]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `blast-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Blast Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3)", [principal, user, `Coach ${label}`]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  return { subject, principal, grants, org, school, label };
}
async function person(given, family, { email = null, phone = null, consent = [], school = ids.schoolA, org = ids.organization, first = null } = {}) {
  const id = first ? first + randomUUID().slice(1) : randomUUID();
  await sql('INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email,phone_e164) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, org, school, given, family, email, phone]);
  for (const channel of consent) {
    await sql("INSERT INTO hon.communication_consents(organization_id,school_id,person_id,channel,status,source,captured_at,updated_by_principal_id) VALUES($1,$2,$3,$4,'OPTED_IN','STAFF',clock_timestamp(),$5)", [org, school, id, channel, OWN.principal]);
  }
  return id;
}
async function membership(personId, state, { school = ids.schoolA, org = ids.organization } = {}) {
  const billing = randomUUID();
  await sql('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id) VALUES($1,$2,$3,$4)', [billing, org, school, personId]);
  await sql('BEGIN');
  await membershipFixtureStatement(admin, "INSERT INTO hon.memberships(organization_id,school_id,billing_account_id,participant_person_id,plan_code,state) VALUES($1,$2,$3,$4,'FIXTURE',$5)", [org, school, billing, personId, state]);
  await sql('COMMIT');
}
const tag = (personId, value, actor) => sql("INSERT INTO hon.contact_tags(organization_id,school_id,person_id,tag,tag_key,added_by_principal_id,added_source) VALUES($1,$2,$3,$4,lower($4),$5,'HUMAN_UI')",
  [ids.organization, ids.schoolA, personId, value, actor.principal]);
const messages = async (where = '') => (await sql(`SELECT count(*)::int n FROM hon.communication_messages WHERE organization_id=$1 ${where}`, [ids.organization])).rows[0].n;
const draft = (patch = {}) => ({ blastId: null, expectedVersion: 0, name: 'Spring open house', channel: 'EMAIL', subject: 'Hi {{first_name}}, open house at {{school_name}}',
  body: 'Hello {{first_name}} {{last_name}},\n\nJoin us Saturday. See you soon,\n{{staff_name}}', audience: { groups: ['ACTIVE_STUDENTS'], tags: [] }, ...patch });

let OWN, SENDER, READER, NONE, PARENTISH, OWN_B, OTHER_ORG, P = {};
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Blast Org','Blast Org'),($2,'Blast Other Org','Blast Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'CORE','ACTIVE',clock_timestamp()-interval '1 day'),($2,'CORE','ACTIVE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug, name] of [[ids.schoolA, ids.organization, 'a', 'Tiger Dojo'], [ids.schoolB, ids.organization, 'b', 'Crane Dojo'], [ids.otherSchool, ids.otherOrganization, 'o', 'Other Dojo']]) {
    await sql("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,'America/Los_Angeles')", [school, org, name, `blast-${slug}-${school.slice(0, 8)}`]);
  }
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  SENDER = await staff('sender', [await role(ids.organization, ['marketing.blast.send', 'marketing.blast.read'])]);
  READER = await staff('reader', [await role(ids.organization, ['marketing.blast.read'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read'])]);
  PARENTISH = await staff('parentish', [await role(ids.organization, ['marketing.blast.send', 'marketing.blast.read'], 'PARENT_PORTAL')]);
  OWN_B = await staff('owner-b', [await role(ids.organization, ['marketing.blast.send', 'marketing.blast.read'])], { school: ids.schoolB });
  OTHER_ORG = await staff('other-org', [await role(ids.otherOrganization, allPermissions, 'OWNER')], { org: ids.otherOrganization, school: ids.otherSchool });

  // School A contacts.
  P.adult = await person('Ana', 'Lee', { email: 'ana@example.test', phone: '+15550000001', consent: ['EMAIL', 'SMS'] });
  P.child = await person('Ben', 'Park');                                   // a child: no address of his own
  P.mom = await person('Cara', 'Park', { email: 'park.family@example.test', phone: '+15550000002', consent: ['EMAIL', 'SMS'], first: '0' });
  P.dad = await person('Dan', 'Park', { email: 'PARK.family@example.test', consent: ['EMAIL'], first: 'f' }); // same household email; ties go to the lowest id, so mom
  P.noConsent = await person('Eve', 'Kim', { email: 'eve@example.test', phone: '+15550000003' });
  P.lonely = await person('Finn', 'Cho');                                  // no address, no guardian
  P.former = await person('Gia', 'Ng', { email: 'gia@example.test', consent: ['EMAIL'] });
  P.prospect = await person('Hal', 'Oh', { email: 'hal@example.test', phone: '+15550000004', consent: ['EMAIL', 'SMS'] });
  P.trial = await person('Ivy', 'Yu', { email: 'ivy@example.test', consent: ['EMAIL'] });
  P.demo = await person('Demo', 'Student', { email: 'demo@example.test', consent: ['EMAIL'] });
  P.blankName = await person(' ', 'Ro', { email: 'ro@example.test', consent: ['EMAIL'] });
  for (const id of [P.adult, P.child, P.noConsent, P.lonely, P.demo, P.blankName]) await membership(id, 'ACTIVE');
  await membership(P.former, 'CANCELLED');
  const family = randomUUID();
  await sql("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'Park family')", [family, ids.organization, ids.schoolA]);
  for (const [pid, roleName] of [[P.child, 'STUDENT'], [P.mom, 'GUARDIAN'], [P.dad, 'GUARDIAN']]) {
    await sql('INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,$5)', [ids.organization, ids.schoolA, family, pid, roleName]);
  }
  const pipeline = randomUUID(), stage = randomUUID();
  await sql("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'Blast pipeline')", [pipeline, ids.organization, ids.schoolA]);
  await sql("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'New',1)", [stage, ids.organization, ids.schoolA, pipeline]);
  for (const pid of [P.prospect, P.trial]) {
    const lead = randomUUID();
    await sql("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status,source_code) VALUES($1,$2,$3,$4,$5,$6,'OPEN','BL1')", [lead, ids.organization, ids.schoolA, pid, pipeline, stage]);
    if (pid === P.trial) await sql("INSERT INTO hon.crm_appointments(organization_id,school_id,crm_lead_id,appointment_type,starts_at,ends_at,created_by_principal_id) VALUES($1,$2,$3,'TRIAL',now()+interval '1 day',now()+interval '25 hours',$4)", [ids.organization, ids.schoolA, lead, OWN.principal]);
  }
  const set = randomUUID();
  await sql("INSERT INTO hon.school_demo_data_sets(id,organization_id,school_id,status,counts,loaded_by_principal_id) VALUES($1,$2,$3,'LOADED','{}',$4)", [set, ids.organization, ids.schoolA, OWN.principal]);
  await sql("INSERT INTO hon.school_demo_data_rows(table_name,row_id,set_id,organization_id,school_id,origin) VALUES('people',$1,$2,$3,$4,'LOADED')", [P.demo, set, ids.organization, ids.schoolA]);
  await tag(P.adult, 'Adults', OWN); await tag(P.prospect, 'adults', OWN).catch(() => tag(P.prospect, 'Adults', OWN));
  // Minors are always reached through guardians and also at their own opted-in address (owner decision 2026-11-18); a student
  // whose birth date shows 18 or over is reached directly only. Archived or merged contacts never get blasts.
  P.teen = await person('Tia', 'Park', { email: 'tia@example.test', consent: ['EMAIL'] });
  P.grown = await person('Gus', 'Park', { email: 'gus@example.test', consent: ['EMAIL'] });
  for (const pid of [P.teen, P.grown]) await sql("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,'STUDENT')", [ids.organization, ids.schoolA, family, pid]);
  await sql("INSERT INTO hon.student_profiles(organization_id,school_id,person_id,primary_family_id,birth_date) VALUES($1,$2,$3,$4,current_date-interval '15 years'),($1,$2,$5,$4,current_date-interval '19 years')",
    [ids.organization, ids.schoolA, P.teen, family, P.grown]);
  P.archived = await person('Arlo', 'Gone', { email: 'arlo@example.test', consent: ['EMAIL'] });
  await membership(P.archived, 'ACTIVE');
  await sql("INSERT INTO hon.school_contact_archives(organization_id,school_id,person_id,kind,archived_by_principal_id) VALUES($1,$2,$3,'ARCHIVED',$4)", [ids.organization, ids.schoolA, P.archived, OWN.principal]);
  for (const pid of [P.teen, P.grown, P.archived]) await tag(pid, 'Teens', OWN);
  // Other schools: same names and groups, never reached from school A.
  P.otherB = await person('Ana', 'Lee', { email: 'ana@example.test', consent: ['EMAIL'], school: ids.schoolB });
  await membership(P.otherB, 'ACTIVE', { school: ids.schoolB });
  P.otherOrg = await person('Zed', 'Q', { email: 'zed@example.test', consent: ['EMAIL'], school: ids.otherSchool, org: ids.otherOrganization });
  await membership(P.otherOrg, 'ACTIVE', { school: ids.otherSchool, org: ids.otherOrganization });
}

try {
  await cleanup();
  await seed();
  await startApp();

  // 0. Permissions and OWNER grants.
  ok((await sql("SELECT count(*)::int n FROM hon.permissions WHERE (code='marketing.blast.read' AND NOT is_sensitive AND is_staff_assignable) OR (code='marketing.blast.send' AND is_sensitive AND is_staff_assignable)")).rows[0].n === 2, 'two staff-assignable permissions');
  ok((await sql(`SELECT count(*)::int n FROM hon.roles r CROSS JOIN unnest(ARRAY['marketing.blast.read','marketing.blast.send']) c WHERE r.is_system_role AND r.code='OWNER'
    AND NOT EXISTS(SELECT 1 FROM hon.role_permissions rp WHERE rp.role_id=r.id AND rp.organization_id=r.organization_id AND rp.permission_code=c)`)).rows[0].n === 0, 'every system OWNER role holds both');

  // 1. Reads at exactly this school with marketing.blast.read.
  ok((await success(() => list(READER), 'empty list')).data.length === 0, 'no blasts yet');
  for (const actor of [NONE, PARENTISH]) await refused(() => list(actor), 403, undefined, `list refused for ${actor.label}`);
  await refused(() => list(OWN_B, { school: ids.schoolA }), 403, undefined, 'school-B sender at the school-A route');
  await refused(() => list(OTHER_ORG, { school: ids.schoolA, organization: ids.organization }), 403, undefined, 'other-organization owner at the school-A route');
  await refused(() => list(READER, { query: '?school=x' }), 400, 'VALIDATION_FAILED', 'read with a query');
  await refused(() => list(READER, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'read with a key');
  await refused(() => list(READER, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-site read');
  await refused(() => read(READER, randomUUID()), 404, 'BLAST_NOT_FOUND', 'unknown blast');

  // 2. Save: closed shape, merge tags, channel rules; create, replay, key reuse, edit by version.
  for (const actor of [READER, NONE, PARENTISH]) await refused(() => save(actor, draft()), 403, undefined, `save refused for ${actor.label}`);
  await refused(() => save(SENDER, draft(), { key: '' }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'no key');
  await refused(() => save(SENDER, draft(), { command: 'marketing_blast.send' }), 403, 'HUMAN_UI_REQUIRED', 'another command header');
  for (const [bad, label] of [[draft({ body: 'Hi {{first_name}} {{favorite_color}}' }), 'unknown merge tag'], [draft({ body: 'Hi {{ first_name }}' }), 'spaced merge tag'],
    [draft({ body: 'Hi {first_name}}' }), 'stray brace'], [draft({ channel: 'SMS' }), 'subject on a text'], [draft({ subject: null }), 'email without subject'],
    [draft({ body: 'x'.repeat(3501) }), 'email body too long'], [draft({ channel: 'SMS', subject: null, body: 'x'.repeat(1001) }), 'text body too long'],
    [draft({ body: ' padded' }), 'padded body'], [draft({ body: 'bell\u0007' }), 'control character'], [draft({ name: 'two\nlines' }), 'name on two lines'],
    [draft({ audience: { groups: [], tags: [] } }), 'no group'], [draft({ audience: { groups: ['VIP'], tags: [] } }), 'unknown group'],
    [draft({ audience: { groups: ['PROSPECTS', 'PROSPECTS'], tags: [] } }), 'repeated group'], [draft({ audience: { groups: ['PROSPECTS'], tags: ['a', 'A'] } }), 'repeated tag'],
    [draft({ audience: { groups: ['PROSPECTS'], tags: ['bad!'] } }), 'bad tag'], [draft({ audience: { groups: ['PROSPECTS'] } }), 'audience without tags'],
    [draft({ expectedVersion: 1 }), 'new blast at version 1'], [{ ...draft(), extra: 1 }, 'extra field'], [(({ name, ...rest }) => rest)(draft()), 'missing name']]) {
    await refused(() => save(SENDER, bad), 400, undefined, label);
  }
  // The database itself refuses what the contract refuses (direct definer call past the API).
  for (const [bad, label] of [[draft({ body: 'Hi {{favorite_color}}' }), 'db: unknown tag'], [draft({ channel: 'SMS' }), 'db: subject on a text'], [draft({ body: '\nlead' }), 'db: leading line break']]) {
    await rejectsSql(async () => {
      await sql("SELECT set_config('app.hon_principal_id',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_source','HUMAN_UI',true),set_config('app.current_organization_id',$3,true),set_config('app.current_school_id',$4,true),set_config('app.hon_request_id',$5,true)",
        [SENDER.principal, SENDER.subject, ids.organization, ids.schoolA, ids.organization]);
      await sql('SELECT hon.save_school_blast($1,$2::jsonb,$3,$4::uuid,$4::uuid)', [SENDER.subject, JSON.stringify(bad), randomUUID(), ids.organization]);
    }, /VALIDATION_FAILED/, label);
  }
  ok(await messages() === 0 && (await sql('SELECT count(*)::int n FROM hon.school_blasts WHERE organization_id=$1', [ids.organization])).rows[0].n === 0, 'no refusal wrote anything');
  const k1 = randomUUID();
  const created = await success(() => save(SENDER, draft(), { key: k1 }), 'create draft');
  const b1 = created.data;
  ok(b1.status === 'DRAFT' && b1.version === 1 && b1.recipientCount === null && b1.outcomes === null && b1.channel === 'EMAIL' && created.meta.replayed === false, `draft ${JSON.stringify(b1)}`);
  const again = await success(() => save(SENDER, draft(), { key: k1 }), 'replay');
  ok(again.meta.replayed === true && JSON.stringify(again.data) === JSON.stringify(b1), 'exact replay returns the first receipt');
  await refused(() => save(SENDER, draft({ name: 'Other' }), { key: k1 }), 409, 'IDEMPOTENCY_KEY_REUSED', 'same key, other body');
  const edited = (await success(() => save(SENDER, draft({ blastId: b1.blastId, expectedVersion: 1, audience: { groups: ['ACTIVE_STUDENTS', 'FORMER_STUDENTS', 'PROSPECTS', 'TRIAL'], tags: [] } })), 'edit')).data;
  ok(edited.version === 2 && edited.blastId === b1.blastId && edited.audience.groups.length === 4, 'edited by exact version');
  await refused(() => save(SENDER, draft({ blastId: b1.blastId, expectedVersion: 1 })), 409, 'VERSION_CONFLICT', 'stale version');
  await refused(() => save(OWN_B, draft({ blastId: b1.blastId, expectedVersion: 2 }), { school: ids.schoolB }), 404, 'BLAST_NOT_FOUND', 'school B cannot edit school A blast');
  await refused(() => read(OWN_B, b1.blastId, { school: ids.schoolB }), 404, 'BLAST_NOT_FOUND', 'school B cannot read school A blast');

  // 3. Audience: groups, guardians for a child, one per household address, consent, no-address, demo excluded, other schools never.
  const a1 = (await success(() => audience(READER, b1.blastId), 'audience email')).data;
  // Matched: adult, child (-> mom, dad), noConsent, lonely, blankName, former, prospect, trial; demo excluded.
  // Recipients: adult Q, mom Q (dad DUPLICATE: same email), noConsent NO_CONSENT, lonely NO_ADDRESS, blankName Q, former Q, prospect Q, trial Q.
  ok(JSON.stringify(a1.outcomes) === JSON.stringify({ QUEUED: 6, NO_CONSENT: 1, NO_ADDRESS: 1, DUPLICATE_ADDRESS: 1 }) && a1.matched === 9, `email audience counts ${JSON.stringify(a1)}`);
  ok(a1.channel === 'EMAIL' && a1.sample && typeof a1.sample.subject === 'string' && !JSON.stringify(a1).includes('@example.test'), 'preview carries no address');
  ok(!JSON.stringify(a1).includes(P.demo) && !JSON.stringify(a1).includes('Demo'), 'demo people never in an audience');
  const sms = (await success(() => save(SENDER, draft({ channel: 'SMS', subject: null, name: 'Text', body: 'Hi {{first_name}}! Class is cancelled today. {{school_name}}', audience: { groups: ['ALL_CONTACTS'], tags: [] } })), 'sms draft')).data;
  const a2 = (await success(() => audience(READER, sms.blastId), 'audience sms')).data;
  // Phones: adult Q, mom Q (also the child's guardian), noConsent NO_CONSENT, prospect Q. No phone: dad, lonely, former, trial, blankName (and child, whose guardian mom is already counted).
  ok(a2.outcomes.QUEUED === 3 && a2.outcomes.NO_CONSENT === 1 && a2.outcomes.DUPLICATE_ADDRESS === 0 && a2.outcomes.NO_ADDRESS === 5 && a2.sample.subject === null, `sms audience ${JSON.stringify(a2)}`);
  const tagged = (await success(() => save(SENDER, draft({ name: 'Adults only', audience: { groups: ['ALL_CONTACTS'], tags: ['ADULTS'] } })), 'tag draft')).data;
  const a3 = (await success(() => audience(READER, tagged.blastId), 'audience tags')).data;
  ok(a3.outcomes.QUEUED === 2 && a3.matched === 2, `tags narrow the audience case-insensitively ${JSON.stringify(a3)}`);
  const teens = (await success(() => save(SENDER, draft({ name: 'Teens', audience: { groups: ['ALL_CONTACTS'], tags: ['Teens'] } })), 'teens draft')).data;
  const a4 = (await success(() => audience(READER, teens.blastId), 'audience teens')).data;
  // Teen -> Tia QUEUED at her own opted-in email AND mom QUEUED, dad DUPLICATE; Gus (19) QUEUED at his own; Arlo archived: not counted.
  ok(JSON.stringify(a4.outcomes) === JSON.stringify({ QUEUED: 3, NO_CONSENT: 0, NO_ADDRESS: 0, DUPLICATE_ADDRESS: 1 }) && a4.matched === 4, `minors via guardians and own address, archived excluded ${JSON.stringify(a4)}`);
  const teenRows = (await sql('SELECT person_id::text p FROM hon.school_blast_resolve($1,$2,$3,$4::jsonb)', [ids.organization, ids.schoolA, 'EMAIL', JSON.stringify({ groups: ['ALL_CONTACTS'], tags: ['Teens'] })])).rows.map((r) => r.p);
  ok(teenRows.includes(P.teen) && teenRows.includes(P.mom) && !teenRows.includes(P.archived) && teenRows.includes(P.grown), 'a minor is reached at their own opted-in address and through guardians; an archived contact never at all');

  // 4. Send now: one QUEUED 0243 message per reachable recipient with merge tags filled; final after that.
  for (const actor of [READER, NONE, PARENTISH]) await refused(() => send(actor, { blastId: b1.blastId, expectedVersion: 2, sendAt: null }), 403, undefined, `send refused for ${actor.label}`);
  await refused(() => send(SENDER, { blastId: b1.blastId, expectedVersion: 1, sendAt: null }), 409, 'VERSION_CONFLICT', 'send at a stale version');
  for (const at of [new Date(Date.now() + 30_000).toISOString(), new Date(Date.now() + 61 * 86_400_000).toISOString(), '2026-13-01T00:00:00.000Z', 'tomorrow'])
    await refused(() => send(SENDER, { blastId: b1.blastId, expectedVersion: 2, sendAt: at }), 400, undefined, `send at ${at}`);
  const ks = randomUUID();
  const sent = await success(() => send(SENDER, { blastId: b1.blastId, expectedVersion: 2, sendAt: null }, { key: ks }), 'send now');
  const s1 = sent.data;
  ok(s1.status === 'QUEUED' && s1.version === 3 && s1.recipientCount === 6 && s1.sendAt === null && s1.queuedAt
    && JSON.stringify(s1.outcomes) === JSON.stringify(a1.outcomes) && s1.deliveries.WAITING === 6, `sent ${JSON.stringify(s1)}`);
  ok((await success(() => send(SENDER, { blastId: b1.blastId, expectedVersion: 2, sendAt: null }, { key: ks }), 'send replay')).meta.replayed === true, 'send replays');
  ok(await messages() === 6, 'exactly six messages');
  const rows = (await sql(`SELECT m.recipient_person_id::text p,m.channel::text c,m.lifecycle::text l,m.origin_kind o,m.origin_id::text oid,m.email_subject s,m.content b,m.scheduled_at,m.created_by_principal_id::text by
    FROM hon.communication_messages m WHERE m.organization_id=$1 ORDER BY 1`, [ids.organization])).rows;
  ok(rows.every((r) => r.c === 'EMAIL' && r.l === 'QUEUED' && r.o === 'CAMPAIGN' && r.oid === b1.blastId && r.scheduled_at === null && r.by === SENDER.principal), 'queued campaign messages from the sender');
  ok(new Set(rows.map((r) => r.p)).size === 6 && !rows.some((r) => [P.dad, P.child, P.noConsent, P.lonely, P.demo].includes(r.p)), 'only reachable recipients');
  const mom = rows.find((r) => r.p === P.mom), blank = rows.find((r) => r.p === P.blankName);
  ok(mom.s === 'Hi Cara, open house at Tiger Dojo' && mom.b === 'Hello Cara Park,\n\nJoin us Saturday. See you soon,\nCoach sender', `merge tags filled ${JSON.stringify(mom)}`);
  ok(blank.b.startsWith('Hello there Ro,'), 'an empty first name is "there"');
  ok((await sql('SELECT count(*)::int n FROM hon.school_blast_recipients WHERE blast_id=$1', [b1.blastId])).rows[0].n === 9, 'every matched person recorded once with an outcome');
  await refused(() => send(SENDER, { blastId: b1.blastId, expectedVersion: 3, sendAt: null }), 409, 'BLAST_NOT_DRAFT', 'sent once only');
  await refused(() => save(SENDER, draft({ blastId: b1.blastId, expectedVersion: 3 })), 409, 'BLAST_NOT_DRAFT', 'a sent blast is final');
  await refused(() => cancel(SENDER, { blastId: b1.blastId, expectedVersion: 3 }), 409, 'BLAST_NOT_CANCELLABLE', 'a send-now blast cannot be cancelled');
  const fromList = (await success(() => list(READER), 'list after send')).data;
  ok(fromList.length === 4 && fromList.find((b) => b.blastId === b1.blastId).recipientCount === 6, 'list shows the sent blast');
  // The 0243 worker picks the messages up: results move from WAITING to the delivery state.
  await sql("SELECT * FROM hon.claim_communication_deliveries(ARRAY['EMAIL'],100,60)");
  const after = (await success(() => read(READER, b1.blastId), 'read after claim')).data;
  ok(after.deliveries.WAITING === 0 && Object.values(after.deliveries).reduce((x, y) => x + y, 0) === 6, `results follow 0243 deliveries ${JSON.stringify(after.deliveries)}`);

  // 5. Schedule and cancel before its time.
  const later = new Date(Date.now() + 3 * 86_400_000); later.setUTCMilliseconds(0);
  const sched = (await success(() => send(SENDER, { blastId: sms.blastId, expectedVersion: 1, sendAt: later.toISOString() }), 'schedule')).data;
  ok(sched.status === 'QUEUED' && sched.sendAt === later.toISOString() && sched.recipientCount === 3, 'scheduled');
  ok(await messages(`AND origin_id='${sms.blastId}' AND scheduled_at='${later.toISOString()}' AND channel='SMS'`) === 3, 'scheduled messages wait for their time');
  await sql("SELECT * FROM hon.claim_communication_deliveries(ARRAY['SMS'],100,60)");
  ok((await sql('SELECT count(*)::int n FROM hon.communication_deliveries d JOIN hon.communication_messages m ON m.id=d.message_id WHERE m.origin_id=$1', [sms.blastId])).rows[0].n === 0, 'the worker does not touch a scheduled blast early');
  await refused(() => cancel(READER, { blastId: sms.blastId, expectedVersion: 2 }), 403, undefined, 'reader cannot cancel');
  const kc = randomUUID();
  const cancelled = (await success(() => cancel(SENDER, { blastId: sms.blastId, expectedVersion: 2 }, { key: kc }), 'cancel')).data;
  ok(cancelled.status === 'CANCELLED' && cancelled.cancelledAt && cancelled.deliveries.CANCELLED === 3, `cancelled ${JSON.stringify(cancelled.deliveries)}`);
  ok(await messages(`AND origin_id='${sms.blastId}' AND lifecycle='CANCELLED'`) === 3, 'its messages are cancelled');
  ok((await success(() => cancel(SENDER, { blastId: sms.blastId, expectedVersion: 2 }, { key: kc }), 'cancel replay')).meta.replayed === true, 'cancel replays');
  await refused(() => cancel(SENDER, { blastId: sms.blastId, expectedVersion: 3 }), 409, 'BLAST_NOT_CANCELLABLE', 'cancel once');

  // 6. Caps: nobody reachable, more than 2,000 reachable, 10 hand-overs per school per day.
  const empty = (await success(() => save(SENDER, draft({ name: 'Nobody', audience: { groups: ['ALL_CONTACTS'], tags: ['NoSuchTag'] } })), 'empty draft')).data;
  await refused(() => send(SENDER, { blastId: empty.blastId, expectedVersion: 1, sendAt: null }), 409, 'BLAST_NO_RECIPIENTS', 'nobody reachable');
  await sql(`WITH p AS (INSERT INTO hon.people(organization_id,school_id,given_name,family_name,email)
      SELECT $1,$2,'Bulk',g::text,'bulk'||g||'@example.test' FROM generate_series(1,2001) g RETURNING id)
    INSERT INTO hon.communication_consents(organization_id,school_id,person_id,channel,status,source,captured_at,updated_by_principal_id) SELECT $1,$2,id,'EMAIL','OPTED_IN','STAFF',clock_timestamp(),$3 FROM p`, [ids.organization, ids.schoolA, OWN.principal]);
  const huge = (await success(() => save(SENDER, draft({ name: 'Everyone', audience: { groups: ['ALL_CONTACTS'], tags: [] } })), 'huge draft')).data;
  await refused(() => send(SENDER, { blastId: huge.blastId, expectedVersion: 1, sendAt: null }), 409, 'BLAST_AUDIENCE_TOO_LARGE', 'over 2,000 reachable');
  ok(await messages() === 6 + 3, 'refused sends queued nothing');
  // Two hand-overs so far (b1 and the cancelled one). Eight more fit; the eleventh is refused.
  for (let n = 0; n < 8; n += 1) {
    const d = (await success(() => save(SENDER, draft({ name: `Daily ${n}`, audience: { groups: ['ALL_CONTACTS'], tags: ['Adults'] } })), `daily draft ${n}`)).data;
    await success(() => send(SENDER, { blastId: d.blastId, expectedVersion: 1, sendAt: null }), `daily send ${n}`);
  }
  const eleventh = (await success(() => save(SENDER, draft({ name: 'One too many', audience: { groups: ['ALL_CONTACTS'], tags: ['Adults'] } })), 'eleventh draft')).data;
  await refused(() => send(SENDER, { blastId: eleventh.blastId, expectedVersion: 1, sendAt: null }), 409, 'BLAST_DAILY_LIMIT', '10 per school per day');
  const race = (await success(() => save(OWN_B, draft({ name: 'B race', audience: { groups: ['ACTIVE_STUDENTS'], tags: [] } }), { school: ids.schoolB }), 'school-B draft')).data;
  ok((await success(() => audience(OWN_B, race.blastId, { school: ids.schoolB }), 'school-B audience')).data.outcomes.QUEUED === 1, 'school B reaches only its own contact');
  const twice = await Promise.all([send(OWN_B, { blastId: race.blastId, expectedVersion: 1, sendAt: null }, { school: ids.schoolB }), send(OWN_B, { blastId: race.blastId, expectedVersion: 1, sendAt: null }, { school: ids.schoolB })]);
  ok(twice.map((r) => r.status).sort().join() === '200,409', `two racing sends of one blast: one wins ${twice.map((r) => `${r.status}:${r.body.code}`)}`);
  ok((await sql('SELECT count(*)::int n FROM hon.communication_messages WHERE school_id=$1', [ids.schoolB])).rows[0].n === 1, 'one message from the race');

  // 7. Live authority: revoked grant, suspended school, lapsed access.
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=principal_id WHERE id=$1', [SENDER.grants[0]]);
  await refused(() => save(SENDER, draft()), 403, undefined, 'revoked grant');
  await sql('UPDATE hon.principal_role_grants SET revoked_at=NULL, revoked_by_principal_id=NULL WHERE id=$1', [SENDER.grants[0]]);
  await sql("UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1", [ids.schoolA]);
  await refused(() => list(READER), 403, undefined, 'suspended school');
  await sql("UPDATE hon.schools SET status='ACTIVE' WHERE id=$1", [ids.schoolA]);
  await sql("UPDATE hon.organization_entitlements SET status='EXPIRED' WHERE organization_id=$1", [ids.organization]).catch(async () =>
    sql("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp() WHERE organization_id=$1", [ids.organization]));
  await refused(() => list(READER), 403, undefined, 'lapsed access');
  await refused(() => send(OWN, { blastId: eleventh.blastId, expectedVersion: 1, sendAt: null }), 403, undefined, 'lapsed access cannot send');

  // 8. Guards: blasts and recipients change only through the functions.
  await rejectsSql(() => sql("UPDATE hon.school_blasts SET body='changed',version=version+1 WHERE id=$1", [b1.blastId]), /SCHOOL_BLAST_IMMUTABLE/, 'a sent blast body is final');
  await rejectsSql(() => sql('UPDATE hon.school_blasts SET status=$2,version=version+1 WHERE id=$1', [b1.blastId, 'DRAFT']), /SCHOOL_BLAST_IMMUTABLE/, 'no going back to draft');
  await rejectsSql(() => sql('DELETE FROM hon.school_blasts WHERE id=$1', [empty.blastId]), /SCHOOL_BLAST_IMMUTABLE/, 'no delete');
  await rejectsSql(() => sql("UPDATE hon.school_blast_recipients SET outcome='NO_CONSENT',message_id=NULL WHERE blast_id=$1", [b1.blastId]), /SCHOOL_BLAST_IMMUTABLE/, 'recipients are append-only');
  await rejectsSql(() => sql('TRUNCATE hon.school_blast_recipients'), /SCHOOL_BLAST_IMMUTABLE/, 'no truncate');

  // 9. Evidence without addresses or text; runtime ACL; 011 section.
  const audits = (await sql("SELECT action_code,next_state::text s FROM hon.audit_events WHERE organization_id=$1 AND entity_type='SCHOOL_BLAST'", [ids.organization])).rows;
  const outbox = (await sql("SELECT event_type,payload::text s FROM hon.outbox_events WHERE organization_id=$1 AND aggregate_type='SCHOOL_BLAST'", [ids.organization])).rows;
  ok(audits.some((a) => a.action_code === 'school_blast.queued') && audits.some((a) => a.action_code === 'school_blast.cancelled') && outbox.length === audits.length, 'audit and outbox per command');
  ok(![...audits, ...outbox].some((r) => /@|\+1555|Hello|open house/i.test(r.s)), 'no address or text in audit or outbox');
  for (const fn of ['save_school_blast(text,jsonb,text,uuid,uuid)', 'send_school_blast(text,jsonb,text,uuid,uuid)', 'cancel_school_blast(text,jsonb,text,uuid,uuid)',
    'read_school_blasts(text)', 'read_school_blast(text,uuid)', 'read_school_blast_audience(text,uuid)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, p.prosecdef, EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(r.runtime && r.prosecdef && !r.public, `runtime may execute definer ${fn}; PUBLIC may not`);
  }
  for (const fn of ['school_blast_text_ok(jsonb,integer,integer)', 'school_blast_line_ok(jsonb,integer)', 'school_blast_audience_ok(jsonb)', 'guard_school_blast()',
    'require_school_blast_actor(text,text)', 'school_blast_address(text,text,text)', 'school_blast_resolve(uuid,uuid,text,jsonb)', 'school_blast_render(text,text,text,text,text)',
    'school_blast_json(hon.school_blasts)', 'school_blast_summary_json(hon.school_blasts)', 'school_blast_begin(text,text,jsonb,text,uuid)',
    'school_blast_finish(text,text,uuid,text,hon.school_blasts,jsonb,uuid,uuid)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!r.runtime && !r.public, `helper ${fn} is private`);
  }
  for (const table of ['school_blasts', 'school_blast_recipients']) {
    const t = (await sql(`SELECT c.relrowsecurity AND c.relforcerowsecurity forced, has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT')
      OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_any_column_privilege($1,c.oid,'SELECT') runtime FROM pg_class c WHERE c.oid=$2::regclass`,
      [CRM_CLOSE_RUNTIME_ROLE, `hon.${table}`])).rows[0];
    ok(t.forced && !t.runtime, `${table}: forced RLS, no runtime privilege`);
    await assert.rejects(runtime.query(`SELECT * FROM hon.${table} LIMIT 1`), /permission denied/); checks += 1;
  }
  await assert.rejects(runtime.query("SELECT hon.read_school_blasts('x')"), /SCHOOL_BLAST_FORBIDDEN/); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const begin = '-- School blasts exact verification (0500)', end = '-- End school blasts exact verification.';
    const section = verify.split(begin)[1]?.split(end)[0];
    ok(section, begin);
    await sql(section.replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  // 10. Nothing paid and no other school touched.
  ok((await sql("SELECT (SELECT count(*) FROM hon.payment_attempts WHERE organization_id=ANY($1::uuid[])) + (SELECT count(*) FROM hon.invoices WHERE organization_id=ANY($1::uuid[])) n",
    [[ids.organization, ids.otherOrganization]])).rows[0].n === '0', 'no payment attempt or invoice');
  ok((await sql('SELECT count(*)::int n FROM hon.communication_messages WHERE organization_id=$1', [ids.otherOrganization])).rows[0].n === 0, 'the other organization received nothing');

  console.log(`PASS: school blasts (0500): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
