/**
 * School contact merge and archive proof (C3, 0483) over signed HTTP (HON session cookie -> HonIdentityGuard + per-command
 * human UI guard + global ValidationPipe + HonExceptionFilter -> SchoolContactAdminController / SchoolContactsController ->
 * protected definer functions on the restricted runtime role with forced RLS), on the guarded disposable CRM-close fixture
 * only. Synthetic names only; nothing is sent or charged.
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
const { SchoolContactAdminController } = await load('people/school-contact-admin.controller.js');
const { SchoolContactAdminService } = await load('people/school-contact-admin.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-school-contact-merge', secret: randomBytes(32).toString('hex') };
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
    controllers: [SchoolContactsController, SchoolContactAdminController],
    providers: [HonIdentityGuard, HonIdentityService, SchoolContactsService, SchoolContactAdminService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}

function call(actor, path, { headers = {}, school = actor.school, organization = actor.org, method = 'GET', body, command, key } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/contacts${path}`);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const sent = {
    Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`,
    Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json',
    ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
    ...(command ? { 'X-HON-Human-Command': command } : {}), ...(key ? { 'Idempotency-Key': key } : {}), ...headers,
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
async function success(read, label) {
  const { status, body, headers } = await read();
  assert.ok([200, 201].includes(status), `${label}: expected 200/201, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
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
    await sql('DELETE FROM hon.hq_operator_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`merge-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`merge-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`merge-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`merge-${ids.organization}-%`]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `merge-${ids.organization}-${label}`;
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

let OWN, ARCHIVER, READER, MIXED, HQ, OTHER_SCHOOL;

async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Merge Org','Merge Org'),($2,'Merge Other Org','Merge Other Org')", orgs());
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", orgs());
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Merge ${slug}`, `merge-${slug}-${school.slice(0, 8)}`, LA]);
  }
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  ARCHIVER = await staff('archiver', [await role(ids.organization, ['people.read', 'people.archive'])]);
  READER = await staff('reader', [await role(ids.organization, ['people.read'])]);
  MIXED = await staff('mixed', [await role(ids.organization, allPermissions), await role(ids.organization, ['people.read'], 'PARENT_PORTAL')]);
  OTHER_SCHOOL = await staff('other-school', [await role(ids.organization, allPermissions)], { school: ids.schoolB });
  HQ = await staff('hq', [await role(ids.organization, allPermissions)]);
  await sql("INSERT INTO hon.hq_operator_grants(principal_id,hq_role) VALUES($1,'HON_HQ_OWNER')", [HQ.principal]);
}

const person = async (org, school, given, family, email = null) => { const id = randomUUID(); await sql('INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email) VALUES($1,$2,$3,$4,$5,$6)', [id, org, school, given, family, email]); return id; };
const version = async (id) => (await sql('SELECT version FROM hon.people WHERE id=$1', [id])).rows[0].version;

// Kim (a student with a membership) and Kim's duplicate (an open lead with a trial, a family link, a billing account, email
// and SMS consents, a conversation and a message); Kim already has an email consent. Plus people for every blocker.
async function records(org, school) {
  const kim = await person(org, school, 'Kim', 'Lee', 'kim@example.test'), dup = await person(org, school, 'Kimberly', 'Lee', 'kimberly@example.test');
  const sam = await person(org, school, 'Sam', 'Plain'), leadOnly = await person(org, school, 'Lou', 'Lead'), owing = await person(org, school, 'Owen', 'Owing');
  const sib1 = await person(org, school, 'Pat', 'Same'), sib2 = await person(org, school, 'Pat', 'Same'), imported = await person(org, school, 'Ira', 'Imported');
  const fam = async (name, members) => { const f = randomUUID(); await sql('INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,$4)', [f, org, school, name]);
    for (const [p, r] of members) await raw('family_members', 'INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role,is_billing_contact) VALUES($1,$2,$3,$4,$5,false)', [org, school, f, p, r]); return f; };
  const kimFamily = await fam('Lee family', [[kim, 'STUDENT']]);
  await fam('Kimberly household', [[dup, 'GUARDIAN']]);
  await fam('Same family', [[sib1, 'GUARDIAN'], [sib2, 'GUARDIAN']]);
  const kimAccount = randomUUID(), dupAccount = randomUUID(), owingAccount = randomUUID();
  await sql('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id,account_classification) VALUES($1,$2,$3,$4,$5),($6,$2,$3,$7,$10),($8,$2,$3,$9,$5)',
    [kimAccount, org, school, kim, 'CANONICAL', dupAccount, dup, owingAccount, owing, 'ADDITIONAL']);
  const membership = randomUUID();
  await raw('memberships', `INSERT INTO hon.memberships(id,organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at)
    VALUES($1,$2,$3,$4,$5,'KIDS-MONTHLY','ACTIVE','2026-09-01T07:00:00Z','2027-09-01T07:00:00Z')`, [membership, org, school, kimAccount, kim]);
  await sql('INSERT INTO hon.student_profiles(organization_id,school_id,person_id,primary_family_id) VALUES($1,$2,$3,$4)', [org, school, kim, kimFamily]);
  await raw('invoices', `INSERT INTO hon.invoices(organization_id,school_id,billing_account_id,status,currency,subtotal_minor,total_minor,due_at)
    VALUES($1,$2,$3,'ISSUED','USD',4000,4000,clock_timestamp()+interval '7 days')`, [org, school, owingAccount]);

  const pipeline = randomUUID(), stage = randomUUID(), dupLead = randomUUID(), louLead = randomUUID();
  await sql("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'Merge pipeline')", [pipeline, org, school]);
  await sql("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'New',1)", [stage, org, school, pipeline]);
  for (const [lead, who] of [[dupLead, dup], [louLead, leadOnly]]) {
    await raw('crm_leads', "INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status) VALUES($1,$2,$3,$4,$5,$6,'OPEN')", [lead, org, school, who, pipeline, stage]);
  }
  await raw('crm_appointments', `INSERT INTO hon.crm_appointments(organization_id,school_id,crm_lead_id,appointment_type,status,starts_at,ends_at,created_by_principal_id)
    VALUES($1,$2,$3,'TRIAL','SCHEDULED',clock_timestamp()+interval '2 days',clock_timestamp()+interval '2 days 1 hour',$4)`, [org, school, dupLead, OWN.principal]);
  const consent = (who, channel, status = 'OPTED_IN') => raw('communication_consents', `INSERT INTO hon.communication_consents(organization_id,school_id,person_id,channel,status,source,captured_at,updated_by_principal_id)
    VALUES($1,$2,$3,$4,$6::hon.communication_consent_status,'STAFF',clock_timestamp(),$5)`, [org, school, who, channel, OWN.principal, status]);
  await consent(kim, 'EMAIL'); await consent(dup, 'EMAIL'); await consent(dup, 'SMS');
  // One replied STOP by text, the other opted in: a merge would leave the opt-out behind on the archived record.
  const optedIn = await person(org, school, 'Opal', 'Texts'), stopped = await person(org, school, 'Opal', 'Stopped');
  await consent(optedIn, 'SMS'); await consent(stopped, 'SMS', 'OPTED_OUT');
  const conversation = randomUUID();
  await raw('school_conversations', `INSERT INTO hon.school_conversations(id,organization_id,school_id,channel,contact_address,person_id,lead_id,last_message_at)
    VALUES($1,$2,$3,'SMS',$4,$5,$6,date_trunc('milliseconds',clock_timestamp()))`, [conversation, org, school, `+1555${school.slice(0, 7).replace(/\D/g, '7').padEnd(7, '7')}`, dup, dupLead]);
  await raw('communication_messages', "INSERT INTO hon.communication_messages(organization_id,school_id,recipient_person_id,channel,content,created_by_principal_id) VALUES($1,$2,$3,'EMAIL','Private message text',$4)", [org, school, dup, OWN.principal]);

  const batch = randomUUID();
  await raw('billing_import_batches', `INSERT INTO hon.billing_import_batches(id,organization_id,school_id,source_checksum,headers,mapping,row_count,valid_count,school_today,school_timezone,created_by_principal_id)
    VALUES($1,$2,$3,$4,'[]','{}',1,0,current_date,$5,$6)`, [batch, org, school, 'a'.repeat(64), LA, OWN.principal]);
  await raw('billing_import_rows', `INSERT INTO hon.billing_import_rows(batch_id,organization_id,school_id,row_index,source_row,normalized,validation_errors,payer_person_id)
    VALUES($1,$2,$3,1,'[]','{}','["UNMATCHED"]',$4)`, [batch, org, school, imported]);
  return { kim, dup, sam, leadOnly, owing, sib1, sib2, imported, optedIn, stopped, dupLead, conversation, dupAccount, kimAccount };
}

const sorted = (v) => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;
const json = (v) => JSON.stringify(sorted(v));
const key = () => `k-${randomUUID()}`;
const archiveState = (actor, p) => call(actor, `/${p}/archive`, { command: 'people.contact.archive.read' });
const archive = (actor, p, body, k = key(), extra = {}) => call(actor, `/${p}/archive`, { method: 'POST', command: 'people.contact.archive', key: k, body, ...extra });
const restore = (actor, p, body, k = key()) => call(actor, `/${p}/restore`, { method: 'POST', command: 'people.contact.restore', key: k, body });
const preview = (actor, keep, mrg) => call(actor, `/${keep}/merge?mergePersonId=${mrg}`, { command: 'people.contact.merge.preview' });
const merge = (actor, keep, body, k = key()) => call(actor, `/${keep}/merge`, { method: 'POST', command: 'people.contact.merge', key: k, body });
const list = async (actor, segment) => (await success(() => call(actor, segment ? `?segment=${segment}` : ''), `list ${segment ?? 'ALL'}`)).data;

try {
  await cleanup();
  await seed();
  const A = await records(ids.organization, ids.schoolA);
  const B = await records(ids.organization, ids.schoolB);
  await records(ids.otherOrganization, ids.otherSchool);
  await startApp();

  // 1. Authority: people.archive / people.merge live at this school, a direct human only, closed requests.
  for (const [actor, label] of [[READER, 'people.read only'], [MIXED, 'a mixed parent role'], [HQ, 'an HQ operator']]) {
    await refused(() => archiveState(actor, A.sam), 403, undefined, `archive read refused for ${label}`);
    await refused(() => preview(actor, A.kim, A.dup), 403, undefined, `merge preview refused for ${label}`);
  }
  await refused(() => preview(ARCHIVER, A.kim, A.dup), 403, undefined, 'people.archive alone cannot merge');
  await refused(() => archiveState(OWN, B.sam), 404, 'SCHOOL_CONTACT_NOT_FOUND', 'a person of another school is not found');
  await refused(() => archive(OWN, A.sam, { version: 1 }, undefined, { command: 'people.contact.restore' }), 403, 'HUMAN_UI_REQUIRED', 'the wrong command header');
  await refused(() => call(OWN, `/${A.sam}/archive`, { method: 'POST', command: 'people.contact.archive', body: { version: 1 } }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'no idempotency key');
  await refused(() => archive(OWN, A.sam, { version: 1, extra: true }), 400, 'VALIDATION_FAILED', 'an extra body key');
  await refused(() => call(OWN, `/${A.kim}/merge?mergePersonId=${A.dup}&x=1`, { command: 'people.contact.merge.preview' }), 400, 'VALIDATION_FAILED', 'an extra preview query key');
  await refused(() => archive(OWN, A.sam, { version: 1 }, key(), { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'a cross-site archive');

  // 2. Archive blockers: a current membership, an open lead, an open balance.
  for (const [p, code] of [[A.kim, 'HAS_CURRENT_MEMBERSHIP'], [A.leadOnly, 'HAS_OPEN_LEAD'], [A.owing, 'HAS_OPEN_BALANCE']]) {
    const s = (await success(() => archiveState(ARCHIVER, p), `archive state ${code}`)).data;
    ok(s.archiveBlockers.includes(code) && !s.archived && json(s.restoreBlockers) === '["NOT_ARCHIVED"]', `${code} shown before archiving`);
    const { status, body } = await archive(ARCHIVER, p, { version: s.person.version });
    ok(status === 409 && body.code === 'SCHOOL_CONTACT_BLOCKED' && body.blockers.includes(code), `${code} blocks the archive ${JSON.stringify(body)}`);
  }

  // 3. Archive, list, card, replay, stale version, restore.
  const samState = (await success(() => archiveState(ARCHIVER, A.sam), 'archive state Sam')).data;
  ok(json(samState.archiveBlockers) === '[]' && samState.mergedIntoPersonId === null, 'Sam can be archived');
  const before = await list(OWN);
  ok(before.rows.some((r) => r.personId === A.sam) && before.counts.ARCHIVED === 0, 'Sam is listed before');
  await refused(() => archive(ARCHIVER, A.sam, { version: samState.person.version + 1 }), 409, 'SCHOOL_CONTACT_VERSION_CONFLICT', 'a stale version');
  const k1 = key();
  const done = await archive(ARCHIVER, A.sam, { version: samState.person.version }, k1);
  ok(done.status === 201 && done.body.data.archived === true && done.body.data.version === samState.person.version + 1 && done.body.meta.replayed === false, `archived ${JSON.stringify(done.body)}`);
  const again = await archive(ARCHIVER, A.sam, { version: samState.person.version }, k1);
  ok(again.status === 200 && again.body.meta.replayed === true && json(again.body.data) === json(done.body.data), 'the same request replays');
  await refused(() => archive(ARCHIVER, A.sam, { version: samState.person.version + 1 }, k1), 409, 'IDEMPOTENCY_KEY_REUSED', 'a reused key with another body');
  const after = await list(OWN), archivedList = await list(OWN, 'ARCHIVED');
  ok(!after.rows.some((r) => r.personId === A.sam) && after.counts.ALL === before.counts.ALL - 1 && after.counts.ARCHIVED === 1, 'Sam left ALL and counts as archived');
  ok(archivedList.rows.map((r) => r.personId).join() === A.sam && archivedList.rows[0].segment === 'ARCHIVED', 'Sam is in the ARCHIVED segment');
  const samCard = (await success(() => call(OWN, `/${A.sam}`), 'Sam card')).data;
  ok(samCard.overview.segment === 'ARCHIVED', 'the card shows ARCHIVED');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='people.archive'", [A.sam])).rows[0].n === 1, 'one audit row');
  const outbox = (await sql("SELECT payload FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='people.archived'", [A.sam])).rows;
  ok(outbox.length === 1 && Object.keys(outbox[0].payload).sort().join() === 'archiveId,personId,version', 'the outbox carries ids only');
  const restored = await restore(ARCHIVER, A.sam, { version: samState.person.version + 1 });
  ok(restored.status === 201 && restored.body.data.archived === false, 'restored');
  ok((await list(OWN)).rows.some((r) => r.personId === A.sam), 'Sam is back in ALL');
  const r2 = await restore(ARCHIVER, A.sam, { version: samState.person.version + 2 });
  ok(r2.status === 409 && json(r2.body.blockers) === '["NOT_ARCHIVED"]', 'restoring twice is blocked');

  // 4. Merge blockers.
  const blocked = async (keep, mrg, codes, label) => {
    const p = (await success(() => preview(OWN, keep, mrg), label)).data;
    ok(codes.every((c) => p.blockers.includes(c)), `${label}: ${JSON.stringify(p.blockers)}`);
    const { status, body } = await merge(OWN, keep, { keepVersion: p.keep.version, mergePersonId: mrg, mergeVersion: p.merge.version, planHash: p.planHash });
    ok(status === 409 && body.code === 'SCHOOL_CONTACT_BLOCKED' && codes.every((c) => body.blockers.includes(c)), `${label}: the command is blocked too`);
  };
  await blocked(A.dup, A.kim, ['MERGED_HAS_STUDENT_RECORD', 'MERGED_HAS_MEMBERSHIPS'], 'merging the student away');
  await blocked(A.sib1, A.sib2, ['BOTH_IN_SAME_FAMILY'], 'two people of one family');
  await blocked(A.sam, A.imported, ['MERGED_HAS_REGISTRATION_HISTORY'], 'a person named by an import');
  await blocked(A.kim, A.owing, ['BOTH_HAVE_BILLING_ACCOUNTS'], 'two canonical billing accounts');
  await blocked(A.optedIn, A.stopped, ['CONSENT_CONFLICT'], 'an SMS opt-out (STOP) against an opt-in');
  await blocked(A.stopped, A.optedIn, ['CONSENT_CONFLICT'], 'the same conflict kept the other way');
  const kept = (await sql("SELECT person_id, status::text FROM hon.communication_consents WHERE person_id IN ($1,$2) AND channel='SMS'", [A.optedIn, A.stopped])).rows;
  ok(kept.length === 2 && kept.some((r) => r.person_id === A.stopped && r.status === 'OPTED_OUT'), 'the opt-out stays where it was after both refusals');
  await refused(() => preview(OWN, A.kim, B.dup), 404, 'SCHOOL_CONTACT_NOT_FOUND', 'a person of another school');
  await refused(() => preview(OWN, A.kim, A.kim), 400, 'VALIDATION_FAILED', 'the same person');

  // 5. The merge: preview, stale hash, stale version, merge, replay.
  const p = (await success(() => preview(OWN, A.kim, A.dup), 'merge preview')).data;
  ok(json(p.blockers) === '[]' && json(p.moves) === json({ leads: 1, familyLinks: 1, billingAccounts: 1, consents: 1, conversations: 1 })
    && json(p.stays) === json({ consents: 1, messages: 1 }), `the plan ${JSON.stringify(p)}`);
  const body = { keepVersion: p.keep.version, mergePersonId: A.dup, mergeVersion: p.merge.version, planHash: p.planHash };
  await refused(() => merge(OWN, A.kim, { ...body, planHash: '0'.repeat(64) }), 409, 'SCHOOL_CONTACT_PREVIEW_STALE', 'a stale plan hash');
  await refused(() => merge(OWN, A.kim, { ...body, mergeVersion: body.mergeVersion + 1 }), 409, 'SCHOOL_CONTACT_VERSION_CONFLICT', 'a stale version');
  const mk = key();
  const merged = await merge(OWN, A.kim, body, mk);
  ok(merged.status === 201 && merged.body.data.keepVersion === p.keep.version + 1 && merged.body.data.mergedVersion === p.merge.version + 1
    && json(merged.body.data.moved) === json(p.moves), `merged ${JSON.stringify(merged.body)}`);
  const replay = await merge(OWN, A.kim, body, mk);
  ok(replay.status === 200 && replay.body.meta.replayed === true, 'the merge replays');
  const one = async (q, v) => (await sql(q, v)).rows[0];
  ok((await one('SELECT primary_person_id p FROM hon.crm_leads WHERE id=$1', [A.dupLead])).p === A.kim, 'the lead moved');
  ok((await one('SELECT count(*)::int n FROM hon.family_members WHERE person_id=$1', [A.dup])).n === 0 && (await one('SELECT count(*)::int n FROM hon.family_members WHERE person_id=$1', [A.kim])).n === 2, 'the family link moved');
  ok((await one('SELECT responsible_person_id p FROM hon.billing_accounts WHERE id=$1', [A.dupAccount])).p === A.kim, 'the billing account moved');
  const consents = (await sql('SELECT person_id, channel::text FROM hon.communication_consents WHERE person_id IN ($1,$2)', [A.kim, A.dup])).rows
    .map((r) => `${r.person_id === A.kim ? 'kim' : 'dup'}:${r.channel}`).sort();
  ok(json(consents) === json(['dup:EMAIL', 'kim:EMAIL', 'kim:SMS']), `SMS consent moved, the duplicate email consent stayed ${json(consents)}`);
  ok((await one('SELECT person_id p, lead_id l FROM hon.school_conversations WHERE id=$1', [A.conversation])).p === A.kim, 'the conversation moved');
  ok((await one('SELECT count(*)::int n FROM hon.communication_messages WHERE recipient_person_id=$1', [A.dup])).n === 1, 'the message log stays as history');
  const arch = await one('SELECT kind, merged_into_person_id m FROM hon.school_contact_archives WHERE person_id=$1 AND restored_at IS NULL', [A.dup]);
  ok(arch.kind === 'MERGED' && arch.m === A.kim, 'the duplicate is archived as merged into Kim');
  const kimCard = (await success(() => call(OWN, `/${A.kim}`), 'Kim card')).data;
  ok(kimCard.overview.segment === 'STUDENT' && kimCard.overview.openLead === true, 'Kim now has the open lead');
  ok((await list(OWN, 'ARCHIVED')).rows.map((r) => r.personId).join() === A.dup, 'the duplicate is listed as archived');
  const dupState = (await success(() => archiveState(OWN, A.dup), 'duplicate archive state')).data;
  ok(dupState.archived && dupState.mergedIntoPersonId === A.kim && dupState.restoreBlockers.includes('WAS_MERGED'), 'a merged contact cannot be restored');
  ok((await success(() => preview(OWN, A.kim, A.dup), 'preview after')).data.blockers.includes('CONTACT_ARCHIVED'), 'merging again is blocked');
  const mOutbox = (await sql("SELECT payload FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='people.merged'", [A.dup])).rows;
  ok(mOutbox.length === 1 && !/Kim|Lee|example/.test(JSON.stringify(mOutbox[0].payload)), 'the merge outbox has ids and counts only');
  ok((await one('SELECT count(*)::int n FROM hon.crm_leads WHERE primary_person_id=$1', [B.dup])).n === 1, 'school B is untouched');

  // 6. Live authority: a revoked grant is refused at once.
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE id=$1', [ARCHIVER.grants[0], OWN.principal]);
  await refused(() => archiveState(ARCHIVER, A.leadOnly), 403, undefined, 'refused after the grant is revoked');

  // 7. Database boundary.
  const names = ['guard_school_contact_archive', 'require_school_contact_admin', 'school_contact_admin_begin', 'school_contact_archive_plan', 'school_contact_merge_plan',
    'school_contact_admin_person', 'school_contact_archive_command', 'read_school_contact_archive', 'archive_school_contact', 'restore_school_contact', 'read_school_contact_merge', 'merge_school_contacts'];
  const fns = (await sql(`SELECT p.proname, has_function_privilege($1,p.oid,'EXECUTE') runtime,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public, p.prosecdef definer, p.proconfig config
    FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace AND p.proname = ANY($2) ORDER BY 1`, [CRM_CLOSE_RUNTIME_ROLE, names])).rows;
  ok(fns.length === 12 && fns.every((f) => !f.public && JSON.stringify(f.config) === '["search_path=pg_catalog, hon"]') && fns.filter((f) => !f.definer).map((f) => f.proname).join() === 'guard_school_contact_archive', 'twelve functions, none public, fixed search path, only the trigger not definer');
  ok(fns.filter((f) => f.runtime).map((f) => f.proname).sort().join() === ['archive_school_contact', 'merge_school_contacts', 'read_school_contact_archive', 'read_school_contact_merge', 'restore_school_contact'].join(), 'the runtime may run only the five entry points');
  ok(!(await one("SELECT has_table_privilege($1,'hon.school_contact_archives','SELECT,INSERT,UPDATE,DELETE') x", [CRM_CLOSE_RUNTIME_ROLE])).x, 'the runtime cannot touch the archive table');
  await assert.rejects(runtime.query('SELECT hon.school_contact_merge_plan($1,$2,$3,$4)', [ids.organization, ids.schoolA, A.kim, A.dup]), /permission denied/); checks += 1;
  await assert.rejects(sql("UPDATE hon.school_contact_archives SET kind='ARCHIVED', merged_into_person_id=NULL WHERE person_id=$1", [A.dup]), /only records its restore/); checks += 1;
  await assert.rejects(sql('DELETE FROM hon.school_contact_archives WHERE person_id=$1', [A.dup]), /never deleted/); checks += 1;
  ok((await one("SELECT count(*)::int n FROM hon.role_permissions rp JOIN hon.roles r ON r.id=rp.role_id WHERE r.is_system_role AND r.code<>'OWNER' AND rp.permission_code IN ('people.merge','people.archive')", [])).n === 0, 'only system owner roles get the new permissions');
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const startMark = '-- School contact merge and archive exact verification (C3 0483)', endMark = '-- End school contact merge and archive exact verification.';
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: school contact merge and archive (0483): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
