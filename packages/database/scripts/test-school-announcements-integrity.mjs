/**
 * School announcements proof (0576) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guards ->
 * ParentSchoolAnnouncementsController / SchoolAnnouncementsController -> protected definer functions on the restricted runtime
 * role with forced RLS), on the guarded disposable CRM-close fixture only. Synthetic names only; nothing is sent anywhere.
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
const { json } = apiRequire('express');
const { issueSession, HON_SESSION_COOKIE } = await import(pathToFileURL(apiRequire.resolve('@hon/auth')).href);
const load = (path) => import(pathToFileURL(resolve(repo, 'apps/api/dist', path)).href);
const { RuntimeDatabaseService } = await load('foundation/runtime-database.service.js');
const { HonIdentityGuard } = await load('foundation/hon-identity.guard.js');
const { HonIdentityService } = await load('foundation/hon-identity.service.js');
const { HonExceptionFilter } = await load('observability/http-telemetry.js');
const M = await load('announcements/school-announcements.controller.js');
const { SchoolAnnouncementsService } = await load('announcements/school-announcements.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-school-announcements', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'school', 'otherSchool', 'family', 'otherFamily', 'busyFamily'].map((key) => [key, randomUUID()]));
const PREFIX = `sann-${ids.organization}`;
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [M.ParentSchoolAnnouncementsController, M.SchoolAnnouncementsController],
    providers: [HonIdentityGuard, HonIdentityService, SchoolAnnouncementsService, M.ParentSchoolAnnouncementsReadGuard, M.SchoolAnnouncementsReadGuard,
      M.SchoolAnnouncementsPublishGuard, M.SchoolAnnouncementsWithdrawGuard, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false, bodyParser: false });
  app.use(json({ limit: '2mb', strict: true }));
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}
function send(target, method, headers, payload) {
  return new Promise((resolvePromise, reject) => {
    const request = http.request(target, { method, headers }, (response) => {
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
function call(actor, method, path, { body, key = randomUUID(), command, headers = {} } = {}) {
  const sent = {
    Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`,
    Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json',
    ...(method === 'POST' ? { 'Content-Type': 'application/json', ...(command ? { 'X-Hon-Human-Command': command } : {}), ...(key ? { 'Idempotency-Key': key } : {}) } : {}),
    ...headers,
  };
  for (const [name, value] of Object.entries(sent)) if (value === undefined) delete sent[name];
  return send(new URL(`${origin}/v1${path}`), method, sent, body === undefined ? undefined : JSON.stringify(body));
}
const parentRead = (actor, options = {}) => call(actor, 'GET', '/parent/announcements', options);
const base = (actor) => `/organizations/${actor.org}/schools/${actor.school}/announcements`;
const list = (actor, options = {}) => call(actor, 'GET', base(actor), options);
const publish = (actor, body, options = {}) => call(actor, 'POST', base(actor), { body, command: 'school_announcements.publish', ...options });
const withdraw = (actor, id, body, options = {}) => call(actor, 'POST', `${base(actor)}/${id}/withdraw`, { body, command: 'school_announcements.withdraw', ...options });

async function success(read, label, expectedStatus = 200) {
  const { status, body, headers } = await read();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  ok(/no-store/.test(headers['cache-control'] ?? ''), `${label}: never cached`);
  return body;
}
async function refused(read, expectedStatus, expectedCode, label) {
  const { status, body } = await read();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  if (expectedCode) assert.equal(body.code, expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(body).slice(0, 400)}`);
  ok(!('data' in body), `${label}: a refusal returns no data`);
}

// Disposable-fixture cleanup only (as in the 0286 and 0329 proofs).
async function cleanup() {
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
          await sql(`DELETE FROM hon.${table} WHERE organization_id = ANY($1::uuid[])`, [[ids.organization, ids.otherOrganization]]);
          await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);
          await sql('RELEASE SAVEPOINT cleanup_table');
        } catch { failed += 1; await sql('ROLLBACK TO SAVEPOINT cleanup_table'); }
      }
      if (!failed) break;
    }
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

async function person(label, name = 'Person') {
  const user = randomUUID(), principal = randomUUID(), subject = `${PREFIX}-${label}`;
  await sql('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)', [user, subject, `${user}@example.test`, name]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3)", [principal, user, name]);
  return { subject, principal, org: ids.organization, school: ids.school };
}
async function grant(actor, family, level) {
  await sql("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day',$4)",
    [ids.organization, ids.school, family, actor.principal, level]);
}
async function role(org, permissions, code) {
  const id = randomUUID();
  await sql('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)', [id, org, code ?? `STAFF_${id.slice(0, 8)}`]);
  for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [id, org, permission]);
  return id;
}
async function staff(label, roleId, { org = ids.organization, school = ids.school } = {}) {
  const actor = await person(label, 'Coach Secret-Staff-Name');
  const id = randomUUID();
  await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')",
    [id, org, school, actor.principal, roleId]);
  return { ...actor, org, school, grant: id };
}

let GUARDIAN, VIEWER, OUTSIDER, TWO, OTHER_PARENT, COACH, NOPE, COACH_B;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Ann Org','Ann Org'),($2,'Ann Other Org','Ann Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5),($6,$2,$7,$8,$5)',
    [ids.school, ids.organization, 'Announce Dojo', `sann-a-${ids.school.slice(0, 8)}`, LA, ids.otherSchool, 'Announce Dojo B', `sann-b-${ids.otherSchool.slice(0, 8)}`]);
  await sql("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$3,$4,'Kim Family'),($2,$3,$4,'Other Family')",
    [ids.family, ids.otherFamily, ids.organization, ids.school]);
  await sql("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'B Family')", [ids.busyFamily, ids.organization, ids.otherSchool]);
  GUARDIAN = await person('guardian'); VIEWER = await person('viewer'); OUTSIDER = await person('outsider'); TWO = await person('two'); OTHER_PARENT = await person('other-parent');
  await grant(GUARDIAN, ids.family, 'PRIMARY_GUARDIAN'); await grant(VIEWER, ids.family, 'VIEWER');
  await grant(TWO, ids.family, 'PRIMARY_GUARDIAN'); await grant(TWO, ids.otherFamily, 'PRIMARY_GUARDIAN');
  await sql("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',clock_timestamp()-interval '1 day',$4)",
    [ids.organization, ids.otherSchool, ids.busyFamily, OTHER_PARENT.principal]);
  COACH = await staff('coach', await role(ids.organization, ['family_messages.manage']));
  NOPE = await staff('nope', await role(ids.organization, ['people.read', 'schedule.session.manage']));
  COACH_B = await staff('coach-b', await role(ids.organization, ['family_messages.manage']), { school: ids.otherSchool });
}

try {
  await cleanup();
  await seed();
  await startApp();

  // 1. Before anything is posted: families see an empty list scoped by their one live grant; staff see nothing.
  const empty = (await success(() => parentRead(GUARDIAN), 'parent read, empty')).data;
  ok(empty.schoolName === 'Announce Dojo' && Array.isArray(empty.announcements) && empty.announcements.length === 0, 'empty list with the school name');
  ok((await success(() => parentRead(VIEWER), 'viewer read')).data.announcements.length === 0, 'a viewer can read');
  await refused(() => parentRead(OUTSIDER), 403, 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN', 'no family grant');
  await refused(() => parentRead(TWO), 403, 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN', 'two families are ambiguous');
  await refused(() => call(GUARDIAN, 'GET', '/parent/announcements?schoolId=x'), 400, 'SCHOOL_ANNOUNCEMENTS_SELECTORS_NOT_ACCEPTED', 'no selector');
  await refused(() => list(NOPE), 403, 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN', 'staff without family_messages.manage');
  await refused(() => list(GUARDIAN), 403, 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN', 'a parent is not staff');
  await refused(() => list(COACH, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'a read takes no key');
  await refused(() => call(COACH, 'GET', `/organizations/${ids.organization}/schools/${ids.otherSchool}/announcements`), 403, 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN', 'another school by URL');
  ok((await success(() => list(COACH), 'staff list, empty')).data.announcements.length === 0, 'staff list empty');

  // 2. Publish: closed body, title 1-120 on one line, body 1-2,000 plain text, permission, key, command, exact replay.
  for (const [label, body] of [['empty title', { title: '', body: 'x' }], ['blank title', { title: '   ', body: 'x' }], ['long title', { title: 'x'.repeat(121), body: 'x' }],
    ['title newline', { title: 'a\nb', body: 'x' }], ['empty body', { title: 'T', body: '' }], ['blank body', { title: 'T', body: ' \n ' }], ['long body', { title: 'T', body: 'x'.repeat(2001) }],
    ['control', { title: 'T', body: 'hi\u0007' }], ['extra key', { title: 'T', body: 'x', schoolId: ids.school }], ['missing', { title: 'T' }], ['not text', { title: 1, body: 'x' }]]) {
    await refused(() => publish(COACH, body), 400, 'VALIDATION_FAILED', `publish validation: ${label}`);
  }
  const NEWS = { title: 'Closed Monday for the holiday', body: 'No classes on Monday.\nSee you Tuesday!' };
  await refused(() => publish(COACH, NEWS, { key: null }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'publish without a key');
  await refused(() => publish(COACH, NEWS, { command: 'school_announcements.withdraw' }), 403, 'HUMAN_UI_REQUIRED', 'publish under another command');
  await refused(() => publish(COACH, NEWS, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-site publish');
  await refused(() => publish(COACH, NEWS, { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'a delegated source header');
  await refused(() => publish(NOPE, NEWS), 403, 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN', 'publish without permission');
  await refused(() => publish(GUARDIAN, NEWS), 403, 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN', 'a parent cannot publish');
  const key = randomUUID();
  const posted = await success(() => publish(COACH, NEWS, { key }), 'staff publishes', 201);
  const A = posted.data.announcement;
  ok(A.title === NEWS.title && A.body === NEWS.body && A.status === 'PUBLISHED' && A.version === 1 && A.withdrawnAt === null && posted.meta.replayed === false, 'published at version 1');
  const again = await success(() => publish(COACH, NEWS, { key }), 'publish replay');
  ok(again.meta.replayed === true && JSON.stringify(again.data) === JSON.stringify(posted.data), 'exact replay');
  await refused(() => publish(COACH, { ...NEWS, body: 'Different' }, { key }), 409, 'IDEMPOTENCY_KEY_REUSED', 'key reused for another announcement');
  ok((await sql('SELECT count(*)::int n FROM hon.school_announcements WHERE school_id=$1', [ids.school])).rows[0].n === 1, 'one stored announcement');
  await new Promise((r) => setTimeout(r, 5));
  const B = (await success(() => publish(COACH, { title: 'Belt test Saturday', body: 'Belt testing starts at 10am.' }), 'second publish', 201)).data.announcement;

  // 3. Families of the school see live announcements newest first, without author; other schools see none of them.
  const seen = (await success(() => parentRead(GUARDIAN), 'parent sees announcements')).data;
  ok(seen.announcements.length === 2 && seen.announcements[0].announcementId === B.announcementId && seen.announcements[1].announcementId === A.announcementId, 'newest first');
  ok(Object.keys(seen.announcements[0]).sort().join() === 'announcementId,body,publishedAt,title', 'families get title, body and time only');
  ok(!JSON.stringify(seen).includes('Secret-Staff-Name') && !JSON.stringify(seen).includes(COACH.principal), 'no staff name or id reaches the family');
  ok((await success(() => parentRead(VIEWER), 'viewer sees them')).data.announcements.length === 2, 'every family member sees them');
  ok((await success(() => parentRead(OTHER_PARENT), 'other school parent')).data.announcements.length === 0, 'another school family sees none');
  ok((await success(() => list(COACH_B), 'other school staff')).data.announcements.length === 0, 'another school staff sees none');
  const staffList = (await success(() => list(COACH), 'staff list')).data.announcements;
  ok(staffList.length === 2 && staffList[0].status === 'PUBLISHED' && staffList[0].version === 1, 'staff list shows status and version');

  // 4. Withdraw: exact version, once; families stop seeing it; staff still see it as taken down.
  await refused(() => withdraw(COACH, A.announcementId, { expectedVersion: 1 }, { key: null }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'withdraw without a key');
  await refused(() => withdraw(COACH, A.announcementId, { expectedVersion: 1, title: 'x' }), 400, 'VALIDATION_FAILED', 'withdraw with an extra key');
  await refused(() => withdraw(COACH, A.announcementId, {}), 400, 'VALIDATION_FAILED', 'withdraw needs the version');
  await refused(() => withdraw(COACH, 'nope', { expectedVersion: 1 }), 400, 'VALIDATION_FAILED', 'bad announcement id');
  await refused(() => withdraw(COACH, A.announcementId, { expectedVersion: 1 }, { command: 'school_announcements.publish' }), 403, 'HUMAN_UI_REQUIRED', 'withdraw under another command');
  await refused(() => withdraw(NOPE, A.announcementId, { expectedVersion: 1 }), 403, 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN', 'withdraw without permission');
  await refused(() => withdraw(COACH_B, A.announcementId, { expectedVersion: 1 }), 404, 'SCHOOL_ANNOUNCEMENTS_NOT_FOUND', 'another school cannot take it down');
  await refused(() => withdraw(COACH, randomUUID(), { expectedVersion: 1 }), 404, 'SCHOOL_ANNOUNCEMENTS_NOT_FOUND', 'unknown announcement');
  await refused(() => withdraw(COACH, A.announcementId, { expectedVersion: 2 }), 409, 'VERSION_CONFLICT', 'stale version');
  const wkey = randomUUID();
  const down = await success(() => withdraw(COACH, A.announcementId, { expectedVersion: 1 }, { key: wkey }), 'staff takes it down');
  ok(down.data.announcement.status === 'WITHDRAWN' && down.data.announcement.version === 2 && down.data.announcement.withdrawnAt && down.meta.replayed === false, 'withdrawn at version 2');
  ok((await success(() => withdraw(COACH, A.announcementId, { expectedVersion: 1 }, { key: wkey }), 'withdraw replay')).meta.replayed === true, 'withdraw replays');
  await refused(() => withdraw(COACH, A.announcementId, { expectedVersion: 2 }), 409, 'VERSION_CONFLICT', 'cannot take it down twice');
  const afterDown = (await success(() => parentRead(GUARDIAN), 'parent after withdraw')).data.announcements;
  ok(afterDown.length === 1 && afterDown[0].announcementId === B.announcementId, 'families no longer see a taken-down announcement');
  const staffAfter = (await success(() => list(COACH), 'staff after withdraw')).data.announcements;
  ok(staffAfter.find((x) => x.announcementId === A.announcementId)?.status === 'WITHDRAWN', 'staff still see it as taken down');

  // 5. Audit and outbox carry ids only.
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_type='SCHOOL_ANNOUNCEMENT' AND entity_id=ANY($1::uuid[])", [[A.announcementId, B.announcementId]])).rows[0].n === 3, 'three audit rows');
  ok((await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE aggregate_type='SCHOOL_ANNOUNCEMENT' AND aggregate_id=ANY($1::uuid[])", [[A.announcementId, B.announcementId]])).rows[0].n === 3, 'three inert outbox events');
  ok((await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE aggregate_id=ANY($1::uuid[]) AND (payload::text LIKE '%holiday%' OR payload::text LIKE '%Belt%')", [[A.announcementId, B.announcementId]])).rows[0].n === 0
    && (await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=ANY($1::uuid[]) AND (next_state::text LIKE '%holiday%' OR next_state::text LIKE '%Belt%')", [[A.announcementId, B.announcementId]])).rows[0].n === 0, 'no text in audit or outbox');

  // 6. Families see only the last 60 days and at most 20; the school may post 20 a day.
  await sql('ALTER TABLE hon.school_announcements DISABLE TRIGGER school_announcements_guard');
  await sql("UPDATE hon.school_announcements SET published_at=published_at-interval '61 days' WHERE id=$1", [B.announcementId]);
  await sql(`INSERT INTO hon.school_announcements(organization_id,school_id,title,body,author_principal_id,published_at)
    SELECT $1,$2,'Filler '||g,'filler',$3,clock_timestamp()-interval '2 days'-g*interval '1 minute' FROM generate_series(1,25) g`, [ids.organization, ids.school, COACH.principal]);
  await sql('ALTER TABLE hon.school_announcements ENABLE TRIGGER school_announcements_guard');
  const window = (await success(() => parentRead(GUARDIAN), 'parent window')).data.announcements;
  ok(window.length === 20 && !window.some((x) => x.announcementId === B.announcementId) && window[0].title === 'Filler 1', 'at most 20, none older than 60 days');
  for (let i = 0; i < 19; i += 1) await success(() => publish(COACH, { title: `Today ${i}`, body: 'x' }), `publish ${i}`, 201);
  await refused(() => publish(COACH, { title: 'One too many', body: 'x' }), 429, 'SCHOOL_ANNOUNCEMENTS_RATE_LIMITED', 'the 21st announcement in a day');
  ok((await success(() => publish(COACH_B, { title: 'Other school', body: 'x' }), 'other school still posts', 201)).data.announcement.status === 'PUBLISHED', 'the limit is per school');

  // 7. A posted announcement never changes or disappears.
  await assert.rejects(sql("UPDATE hon.school_announcements SET body='changed', version=version+1, status='WITHDRAWN', withdrawn_at=clock_timestamp(), withdrawn_by_principal_id=author_principal_id WHERE id=$1", [B.announcementId])); checks += 1;
  await assert.rejects(sql("UPDATE hon.school_announcements SET status='PUBLISHED', version=version+1, withdrawn_at=NULL, withdrawn_by_principal_id=NULL WHERE id=$1", [A.announcementId])); checks += 1;
  await assert.rejects(sql('DELETE FROM hon.school_announcements WHERE id=$1', [B.announcementId])); checks += 1;
  await assert.rejects(sql("INSERT INTO hon.school_announcements(organization_id,school_id,title,body,author_principal_id,status,withdrawn_at,withdrawn_by_principal_id,version) VALUES($1,$2,'T','x',$3,'WITHDRAWN',clock_timestamp(),$3,2)",
    [ids.organization, ids.school, COACH.principal])); checks += 1;

  // 8. Live authority: revoked staff role, ended family grant, suspended school and lapsed entitlement are refused.
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=principal_id WHERE id=$1', [COACH.grant]);
  await refused(() => list(COACH), 403, 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN', 'a revoked staff role');
  await sql('UPDATE hon.principal_role_grants SET revoked_at=NULL, revoked_by_principal_id=NULL WHERE id=$1', [COACH.grant]);
  await sql("UPDATE hon.family_access_grants SET effective_until=clock_timestamp()+interval '1 second' WHERE principal_id=$1", [VIEWER.principal]);
  await new Promise((r) => setTimeout(r, 1200));
  await refused(() => parentRead(VIEWER), 403, 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN', 'an ended family grant');
  await sql("UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1", [ids.school]);
  await refused(() => parentRead(GUARDIAN), 403, 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN', 'suspended school, parent');
  await refused(() => list(COACH), 403, 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN', 'suspended school, staff');
  await sql("UPDATE hon.schools SET status='ACTIVE' WHERE id=$1", [ids.school]);
  await sql("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp()-interval '1 minute', effective_from=clock_timestamp()-interval '2 days' WHERE organization_id=$1", [ids.organization]);
  await refused(() => parentRead(GUARDIAN), 403, 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN', 'lapsed entitlement, parent');
  await refused(() => list(COACH), 403, 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN', 'lapsed entitlement, staff');
  await sql('UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1', [ids.organization]);
  ok((await success(() => parentRead(GUARDIAN), 'access returns')).data.announcements.length === 20, 'works again once access is live');

  // 9. Database boundary: definer entry points only; helpers and the table private.
  const entry = ['read_parent_school_announcements(text)', 'read_school_announcements(text)', 'publish_school_announcement(text,jsonb,text,uuid,uuid)', 'withdraw_school_announcement(text,jsonb,text,uuid,uuid)'];
  const helpers = ['school_announcement_title_ok(text)', 'guard_school_announcement()', 'school_announcement_parent_scope(text)', 'require_school_announcements_actor(text)',
    'school_announcement_family_json(hon.school_announcements)', 'school_announcement_staff_json(hon.school_announcements)'];
  for (const fn of entry) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, p.prosecdef, EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(r.runtime && r.prosecdef && !r.public, `runtime may execute definer ${fn}; PUBLIC may not`);
  }
  for (const fn of helpers) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!r.runtime && !r.public, `helper ${fn} is private`);
  }
  const t = (await sql(`SELECT c.relrowsecurity, c.relforcerowsecurity, has_table_privilege($1,c.oid,'SELECT') sel, has_table_privilege($1,c.oid,'INSERT') ins
    FROM pg_class c WHERE c.oid='hon.school_announcements'::regclass`, [CRM_CLOSE_RUNTIME_ROLE])).rows[0];
  ok(t.relrowsecurity && t.relforcerowsecurity && !t.sel && !t.ins, 'school_announcements: forced RLS and no runtime table privilege');
  await assert.rejects(runtime.query('SELECT * FROM hon.school_announcements')); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const startMark = '-- School announcements exact verification (0576)', endMark = '-- End school announcements exact verification.';
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: school announcements (0576): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch(() => {});
  await admin.end();
  await runtime.end();
}
