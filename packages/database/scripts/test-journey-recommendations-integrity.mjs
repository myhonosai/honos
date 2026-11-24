/**
 * Journey recommendations proof (0603) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guards ->
 * ParentJourneyRecommendationsController / JourneyRecommendationsController -> protected definer functions on the restricted
 * runtime role with forced RLS), on the guarded disposable CRM-close fixture only. Synthetic names only; nothing is sent.
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
const M = await load('journey-recommendations/journey-recommendations.controller.js');
const { JourneyRecommendationsService } = await load('journey-recommendations/journey-recommendations.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-journey-recommendations', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'school', 'otherSchool', 'family', 'otherFamily', 'busyFamily', 'program',
  'karate', 'weapons', 'otherCurriculum', 'white', 'yellow', 'orange', 'blade', 'otherRank', 'r1', 'r2', 'r3'].map((key) => [key, randomUUID()]));
const PREFIX = `jrec-${ids.organization}`;
const sql = (text, values = []) => admin.query(text, values);
const one = async (text, values = []) => (await sql(text, values)).rows[0];
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [M.ParentJourneyRecommendationsController, M.JourneyRecommendationsController],
    providers: [HonIdentityGuard, HonIdentityService, JourneyRecommendationsService, M.ParentJourneyRecommendationsReadGuard, M.JourneyRecommendationsReadGuard,
      M.JourneyRecommendationsSaveGuard, M.JourneyRecommendationsStatusGuard, { provide: RuntimeDatabaseService, useValue: database }],
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
const parentRead = (actor, options = {}) => call(actor, 'GET', '/parent/journey-recommendations', options);
const base = (actor) => `/organizations/${actor.org}/schools/${actor.school}/journey-recommendations`;
const list = (actor, options = {}) => call(actor, 'GET', base(actor), options);
const save = (actor, body, options = {}) => call(actor, 'POST', base(actor), { body, command: 'journey_recommendations.save', ...options });
const setStatus = (actor, id, body, options = {}) => call(actor, 'POST', `${base(actor)}/${id}/status`, { body, command: 'journey_recommendations.status', ...options });

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


async function child(given, family, { school = ids.school } = {}) {
  const personId = randomUUID(), profile = randomUUID();
  await sql('INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4,$5)', [personId, ids.organization, school, given, 'Kim']);
  await sql("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,'STUDENT')", [ids.organization, school, family, personId]);
  await sql("INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id,primary_family_id,status) VALUES($1,$2,$3,$4,$5,'ACTIVE')", [profile, ids.organization, school, personId, family]);
  return profile;
}
async function enroll(profile, curriculum, rank) {
  return (await one(`INSERT INTO hon.student_curriculum_enrollments(organization_id,school_id,student_profile_id,curriculum_id,current_rank_id,enrolled_at)
    VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '30 days') RETURNING id`, [ids.organization, ids.school, profile, curriculum, rank])).id;
}
async function observe(enrollment, requirement, status, version) {
  await sql(`INSERT INTO hon.curriculum_progress_observations(organization_id,school_id,enrollment_id,curriculum_id,curriculum_rank_id,requirement_id,requirement_version,
      enrollment_version,version,status,actor_principal_id,source,request_id) VALUES($1,$2,$3,$4,$5,$6,1,1,$7,$8,$9,'HUMAN_UI',$10)`,
    [ids.organization, ids.school, enrollment, ids.karate, ids.yellow, requirement, version, status, COACH.principal, randomUUID()]);
}
async function attended(profile, count) {
  for (let i = 0; i < count; i += 1) {
    const s = randomUUID();
    await sql(`INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,room_name,starts_at,ends_at,capacity,booking_policy,status)
      VALUES($1,$2,$3,$4,'Kids Karate','Mat 1',clock_timestamp()-make_interval(days=>$5+1),clock_timestamp()-make_interval(days=>$5+1)+interval '1 hour',20,'WALK_IN','SCHEDULED')`,
      [s, ids.organization, ids.school, ids.program, i]);
    await sql("INSERT INTO hon.attendance_records(organization_id,school_id,class_session_id,student_profile_id,status,progression_enabled) VALUES($1,$2,$3,$4,'PRESENT',false)",
      [ids.organization, ids.school, s, profile]);
  }
}
const en = (text) => ({ en: text });
const option = (key, priceMinor, extra = {}) => ({ key, label: en(`Option ${key}`), description: null, planId: null, billing: 'ONE_TIME', priceMinor,
  recurringMinor: null, installments: null, downPayment: null, collectionMethod: null, additionalParticipantMinor: null, capacity: 0,
  availableThrough: null, mostPopular: false, createsMembership: false, ...extra });
const CONTENT = { currency: 'USD', title: en('Summer camp'), description: en('A week of training.'), blocks: [], multiParticipant: { enabled: true, maxPerOrder: 3 },
  customFields: [], addOns: [], options: [option('week', 5000)], waiver: null, receiptNote: null, thankYou: null };
async function checkoutPage(slug, content, { status = 'PUBLISHED', school = ids.school } = {}) {
  return (await one(`INSERT INTO hon.school_checkouts(organization_id,school_id,slug,group_key,status,content,created_by_principal_id,updated_by_principal_id)
    VALUES($1,$2,$3,'camps',$4,$5,$6,$6) RETURNING id`, [ids.organization, school, slug, status, JSON.stringify(content), COACH.principal])).id;
}
async function schoolEvent(title, { publish = true, school = ids.school } = {}) {
  const id = randomUUID();
  await sql(`INSERT INTO hon.school_events(id,organization_id,school_id,title,local_date,opens_at,closes_at,slot_minutes,spots_per_slot,actor_principal_id)
    VALUES($1,$2,$3,$4,(clock_timestamp() AT TIME ZONE $5)::date+1,'09:00','12:00',30,10,$6)`, [id, ids.organization, school, title, LA, COACH.principal]);
  if (publish) await sql("UPDATE hon.school_events SET status='PUBLISHED',version=2 WHERE id=$1", [id]);
  return id;
}
const rec = (patch = {}) => ({ recommendationId: null, expectedVersion: null, curriculumId: ids.karate, triggerKind: 'RANK_REACHED', rankId: ids.yellow, threshold: null,
  title: 'Join the sparring club', message: 'Sparring club is open to Yellow belts and up.\nAsk us about it!', targetKind: 'ASK_SCHOOL',
  targetCheckoutId: null, targetEventId: null, skipEnrolled: false, ...patch });

let GUARDIAN, VIEWER, OUTSIDER, TWO, OTHER_PARENT, COACH, NOPE, COACH_B, CAMP, DRAFT_PAGE, OTHER_PAGE, OPEN_HOUSE, DRAFT_EVENT, mia, leo, zed, ava;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Journey Org','Journey Org'),($2,'Journey Other Org','Journey Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5),($6,$2,$7,$8,$5)',
    [ids.school, ids.organization, 'Journey Dojo', `jrec-a-${ids.school.slice(0, 8)}`, LA, ids.otherSchool, 'Journey Dojo B', `jrec-b-${ids.otherSchool.slice(0, 8)}`]);
  await sql("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$3,$4,'Kim Family'),($2,$3,$4,'Other Family')", [ids.family, ids.otherFamily, ids.organization, ids.school]);
  await sql("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'B Family')", [ids.busyFamily, ids.organization, ids.otherSchool]);
  await sql("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Kids Karate','SCHEDULED')", [ids.program, ids.organization, ids.school]);
  await sql("INSERT INTO hon.curricula(id,organization_id,school_id,name,model_code,lifecycle) VALUES($1,$4,$5,'Kids Karate','LINEAR','PUBLISHED'),($2,$4,$5,'Weapons','LINEAR','PUBLISHED'),($3,$4,$6,'Other Karate','LINEAR','PUBLISHED')",
    [ids.karate, ids.weapons, ids.otherCurriculum, ids.organization, ids.school, ids.otherSchool]);
  for (const [id, cur, name, order, school] of [[ids.white, ids.karate, 'White Belt', 1, ids.school], [ids.yellow, ids.karate, 'Yellow Belt', 2, ids.school], [ids.orange, ids.karate, 'Orange Belt', 3, ids.school],
    [ids.blade, ids.weapons, 'Blade 1', 1, ids.school], [ids.otherRank, ids.otherCurriculum, 'White Belt', 1, ids.otherSchool]]) {
    await sql('INSERT INTO hon.curriculum_ranks(id,organization_id,school_id,curriculum_id,name,progression_order) VALUES($1,$2,$3,$4,$5,$6)', [id, ids.organization, school, cur, name, order]);
  }
  for (const [id, code] of [[ids.r1, 'front-kick'], [ids.r2, 'kata-1'], [ids.r3, 'respect']]) {
    await sql("INSERT INTO hon.curriculum_requirements(id,organization_id,school_id,curriculum_rank_id,requirement_code,requirement_kind) VALUES($1,$2,$3,$4,$5,'TECHNIQUE')", [id, ids.organization, ids.school, ids.yellow, code]);
  }
  GUARDIAN = await person('guardian'); VIEWER = await person('viewer'); OUTSIDER = await person('outsider'); TWO = await person('two'); OTHER_PARENT = await person('other-parent');
  for (const [actor, family, level, school] of [[GUARDIAN, ids.family, 'PRIMARY_GUARDIAN', ids.school], [VIEWER, ids.family, 'VIEWER', ids.school], [TWO, ids.family, 'PRIMARY_GUARDIAN', ids.school],
    [TWO, ids.otherFamily, 'PRIMARY_GUARDIAN', ids.school], [OTHER_PARENT, ids.busyFamily, 'PRIMARY_GUARDIAN', ids.otherSchool]]) {
    await sql("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day',$4)",
      [ids.organization, school, family, actor.principal, level]);
  }
  COACH = await staff('coach', await role(ids.organization, ['curriculum.manage']));
  NOPE = await staff('nope', await role(ids.organization, ['people.read', 'family_messages.manage', 'curriculum.progress.record']));
  COACH_B = await staff('coach-b', await role(ids.organization, ['curriculum.manage']), { school: ids.otherSchool });
  CAMP = await checkoutPage('summer-camp', CONTENT);
  DRAFT_PAGE = await checkoutPage('draft-camp', CONTENT, { status: 'DRAFT' });
  OTHER_PAGE = await checkoutPage('other-camp', CONTENT, { school: ids.otherSchool });
  OPEN_HOUSE = await schoolEvent('Holiday open house');
  DRAFT_EVENT = await schoolEvent('Secret draft event', { publish: false });
  mia = await child('Mia', ids.family); leo = await child('Leo', ids.family); zed = await child('Zed', ids.family); ava = await child('Ava', ids.family);
  await child('Ivy', ids.otherFamily);
  // Seeding only: enrollment, progress, attendance, testing and order evidence normally come from their own human commands.
  for (const table of ['student_curriculum_enrollments', 'curriculum_progress_observations', 'attendance_records', 'testing_candidates', 'family_checkout_orders']) {
    await sql(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);
  }
  try {
    const miaK = await enroll(mia, ids.karate, ids.yellow); const leoK = await enroll(leo, ids.karate, ids.white); const zedK = await enroll(zed, ids.karate, ids.orange);
    await enroll(mia, ids.weapons, ids.blade);
    await observe(miaK, ids.r1, 'MET', 1); await observe(miaK, ids.r2, 'PRACTICING', 1); await observe(miaK, ids.r2, 'MET', 2); await observe(miaK, ids.r3, 'MET', 1); await observe(miaK, ids.r3, 'PRACTICING', 2);
    await attended(mia, 3); await attended(leo, 2); await attended(zed, 3);
    const test = randomUUID();
    await sql("INSERT INTO hon.testing_events(id,organization_id,school_id,curriculum_id,name,starts_at,status) VALUES($1,$2,$3,$4,'Belt test',clock_timestamp()+interval '3 days','OPEN')", [test, ids.organization, ids.school, ids.karate]);
    await sql("INSERT INTO hon.testing_candidates(organization_id,school_id,testing_event_id,student_curriculum_enrollment_id,target_rank_id,result) VALUES($1,$2,$3,$4,$5,'PENDING')", [ids.organization, ids.school, test, leoK, ids.yellow]);
    void zedK;
  } finally {
    for (const table of ['student_curriculum_enrollments', 'curriculum_progress_observations', 'attendance_records', 'testing_candidates', 'family_checkout_orders']) {
      await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);
    }
  }
}
const kids = (data) => Object.fromEntries(data.children.map((c) => [c.name, c.recommendations.map((r) => r.title).sort()]));

try {
  await cleanup();
  await seed();
  await startApp();

  // 1. Nothing pinned yet: families read every ACTIVE child with no recommendations; scope and selectors are enforced.
  const empty = (await success(() => parentRead(GUARDIAN), 'parent read, empty')).data;
  ok(JSON.stringify(empty.children.map((c) => [c.name, c.recommendations.length])) === JSON.stringify([['Ava Kim', 0], ['Leo Kim', 0], ['Mia Kim', 0], ['Zed Kim', 0]]), 'every ACTIVE child, by name, none yet');
  await refused(() => parentRead(OUTSIDER), 403, 'JOURNEY_RECOMMENDATIONS_FORBIDDEN', 'no family grant');
  await refused(() => parentRead(TWO), 403, 'JOURNEY_RECOMMENDATIONS_FORBIDDEN', 'two families are ambiguous');
  await refused(() => call(GUARDIAN, 'GET', '/parent/journey-recommendations?child=x'), 400, 'JOURNEY_RECOMMENDATIONS_SELECTORS_NOT_ACCEPTED', 'no selector');
  await refused(() => parentRead(GUARDIAN, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-site parent read');
  await refused(() => list(NOPE), 403, 'JOURNEY_RECOMMENDATIONS_FORBIDDEN', 'staff without curriculum.manage');
  await refused(() => list(GUARDIAN), 403, 'JOURNEY_RECOMMENDATIONS_FORBIDDEN', 'a parent is not staff');
  await refused(() => list(COACH, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'a read takes no key');
  await refused(() => call(COACH, 'GET', `/organizations/${ids.organization}/schools/${ids.otherSchool}/journey-recommendations`), 403, 'JOURNEY_RECOMMENDATIONS_FORBIDDEN', 'another school by URL');
  const choices = (await success(() => list(COACH), 'staff list, empty')).data;
  ok(choices.recommendations.length === 0, 'no recommendations yet');
  ok(JSON.stringify(choices.programs.map((p) => [p.name, p.ranks.map((k) => k.name)])) === JSON.stringify([['Kids Karate', ['White Belt', 'Yellow Belt', 'Orange Belt']], ['Weapons', ['Blade 1']]]), 'the school programs and ranks in order, no other school');
  ok(choices.checkouts.length === 1 && choices.checkouts[0].checkoutId === CAMP && choices.checkouts[0].title === 'Summer camp', 'only the published sign-up page with something on sale');
  ok(choices.events.length === 1 && choices.events[0].eventId === OPEN_HOUSE, 'only the published upcoming event');

  // 2. Save: closed body, trigger and target shapes, school-owned references, key, command, exact replay.
  for (const [label, body] of [['empty title', rec({ title: '' })], ['long title', rec({ title: 'x'.repeat(81) })], ['title newline', rec({ title: 'a\nb' })],
    ['blank message', rec({ message: ' \n ' })], ['long message', rec({ message: 'x'.repeat(401) })], ['control', rec({ message: 'hi\u0007' })],
    ['extra key', { ...rec(), schoolId: ids.school }], ['missing key', (({ title, ...r }) => r)(rec())], ['bad trigger', rec({ triggerKind: 'BIRTHDAY' })],
    ['rank trigger without rank', rec({ rankId: null })], ['rank trigger with threshold', rec({ threshold: 2 })], ['requirements without threshold', rec({ triggerKind: 'REQUIREMENTS_MET' })],
    ['too many requirements', rec({ triggerKind: 'REQUIREMENTS_MET', threshold: 101 })], ['classes without threshold', rec({ triggerKind: 'CLASSES_ATTENDED', rankId: null })],
    ['classes over 1000', rec({ triggerKind: 'CLASSES_ATTENDED', threshold: 1001 })], ['fraction', rec({ triggerKind: 'CLASSES_ATTENDED', threshold: 2.5 })],
    ['checkout without page', rec({ targetKind: 'CHECKOUT' })], ['event with page', rec({ targetKind: 'EVENT', targetEventId: OPEN_HOUSE, targetCheckoutId: CAMP })],
    ['pro shop with event', rec({ targetKind: 'PRO_SHOP', targetEventId: OPEN_HOUSE })], ['skip for an event', rec({ targetKind: 'EVENT', targetEventId: OPEN_HOUSE, skipEnrolled: true })],
    ['id without version', rec({ recommendationId: randomUUID() })], ['version without id', rec({ expectedVersion: 1 })], ['not a uuid', rec({ curriculumId: 'nope' })]]) {
    await refused(() => save(COACH, body), 400, 'VALIDATION_FAILED', `save validation: ${label}`);
  }
  for (const [label, body] of [['another school curriculum', rec({ curriculumId: ids.otherCurriculum, rankId: ids.otherRank })], ['rank of another curriculum', rec({ rankId: ids.blade })],
    ['unknown rank', rec({ rankId: randomUUID() })], ['draft page', rec({ targetKind: 'CHECKOUT', targetCheckoutId: DRAFT_PAGE })], ['another school page', rec({ targetKind: 'CHECKOUT', targetCheckoutId: OTHER_PAGE })],
    ['draft event', rec({ targetKind: 'EVENT', targetEventId: DRAFT_EVENT })]]) {
    await refused(() => save(COACH, body), 404, 'JOURNEY_RECOMMENDATIONS_NOT_FOUND', `save reference: ${label}`);
  }
  await refused(() => save(COACH, rec(), { key: null }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'save without a key');
  await refused(() => save(COACH, rec(), { command: 'journey_recommendations.status' }), 403, 'HUMAN_UI_REQUIRED', 'save under another command');
  await refused(() => save(COACH, rec(), { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'a delegated source header');
  await refused(() => save(NOPE, rec()), 403, 'JOURNEY_RECOMMENDATIONS_FORBIDDEN', 'save without permission');
  await refused(() => save(GUARDIAN, rec()), 403, 'JOURNEY_RECOMMENDATIONS_FORBIDDEN', 'a parent cannot save');
  const key = randomUUID();
  const created = await success(() => save(COACH, rec(), { key }), 'staff saves A', 201);
  const A = created.data.recommendation;
  ok(A.status === 'ON' && A.version === 1 && A.rank === 'Yellow Belt' && A.program === 'Kids Karate' && A.targetLive === true && created.meta.replayed === false, 'A is ON at version 1');
  const again = await success(() => save(COACH, rec(), { key }), 'save replay');
  ok(again.meta.replayed === true && JSON.stringify(again.data) === JSON.stringify(created.data), 'exact replay');
  await refused(() => save(COACH, rec({ title: 'Different' }), { key }), 409, 'IDEMPOTENCY_KEY_REUSED', 'key reused for another recommendation');
  const B = (await success(() => save(COACH, rec({ triggerKind: 'REQUIREMENTS_MET', threshold: 2, title: 'Summer camp for Yellow belts', targetKind: 'CHECKOUT', targetCheckoutId: CAMP, skipEnrolled: true })), 'save B', 201)).data.recommendation;
  const C = (await success(() => save(COACH, rec({ triggerKind: 'TEST_BOOKED', title: 'Gear up for your belt test', targetKind: 'PRO_SHOP' })), 'save C', 201)).data.recommendation;
  const D = (await success(() => save(COACH, rec({ triggerKind: 'CLASSES_ATTENDED', rankId: null, threshold: 3, title: 'Come to the open house', targetKind: 'EVENT', targetEventId: OPEN_HOUSE })), 'save D', 201)).data.recommendation;
  const E = (await success(() => save(COACH, rec({ triggerKind: 'CLASSES_ATTENDED', rankId: ids.orange, threshold: 3, title: 'Leadership team' })), 'save E', 201)).data.recommendation;
  const F = (await success(() => save(COACH, rec({ title: 'Turned off later' })), 'save F', 201)).data.recommendation;
  const G = (await success(() => save(COACH, rec({ curriculumId: ids.weapons, rankId: ids.blade, title: 'Weapons club' })), 'save G', 201)).data.recommendation;
  ok(B.targetLabel === 'Summer camp' && D.targetLabel === 'Holiday open house' && C.targetLabel === null, 'target labels for staff');

  // 3. Families see exactly the reached recommendations with a live target.
  let seen = (await success(() => parentRead(GUARDIAN), 'parent sees recommendations')).data;
  assert.deepEqual(kids(seen), {
    'Ava Kim': [],
    'Leo Kim': ['Gear up for your belt test'],
    'Mia Kim': ['Come to the open house', 'Join the sparring club', 'Summer camp for Yellow belts', 'Turned off later', 'Weapons club'],
    'Zed Kim': ['Come to the open house', 'Join the sparring club', 'Leadership team', 'Turned off later'],
  }); checks += 1;
  const miaB = seen.children.find((c) => c.name === 'Mia Kim').recommendations.find((r) => r.recommendationId === B.recommendationId);
  ok(miaB.targetKind === 'CHECKOUT' && miaB.checkoutId === CAMP && miaB.targetLabel === 'Summer camp' && miaB.rank === 'Yellow Belt' && miaB.threshold === 2, 'a sign-up target carries its page and label');
  ok(Object.keys(miaB).sort().join() === 'checkoutId,eventId,message,program,rank,recommendationId,targetKind,targetLabel,threshold,title,triggerKind', 'families get display fields only');
  ok(!JSON.stringify(seen).includes('Secret-Staff-Name') && !JSON.stringify(seen).includes(COACH.principal) && !JSON.stringify(seen).includes(mia), 'no staff or child id reaches the family');
  ok(JSON.stringify((await success(() => parentRead(VIEWER), 'viewer reads')).data) === JSON.stringify(seen), 'every family member sees the same');
  ok((await success(() => parentRead(OTHER_PARENT), 'other school parent')).data.children.length === 0, 'another school family sees nothing of this school');
  ok((await success(() => list(COACH_B), 'other school staff')).data.recommendations.length === 0, 'another school staff sees none');

  // 4. Edit at the exact version; OFF hides, ON shows again, REMOVED is final and leaves the staff list.
  const edited = (await success(() => save(COACH, rec({ recommendationId: F.recommendationId, expectedVersion: 1, title: 'Edited title' })), 'edit F')).data.recommendation;
  ok(edited.version === 2 && edited.title === 'Edited title', 'edited at version 2');
  await refused(() => save(COACH, rec({ recommendationId: F.recommendationId, expectedVersion: 1, title: 'Stale' })), 409, 'VERSION_CONFLICT', 'stale edit');
  await refused(() => save(COACH, rec({ recommendationId: F.recommendationId, expectedVersion: 2, curriculumId: ids.weapons, rankId: ids.blade })), 409, 'VERSION_CONFLICT', 'an edit cannot move curriculum');
  await refused(() => save(COACH_B, rec({ recommendationId: F.recommendationId, expectedVersion: 2, curriculumId: ids.otherCurriculum, rankId: ids.otherRank })), 404, 'JOURNEY_RECOMMENDATIONS_NOT_FOUND', 'another school cannot edit');
  await refused(() => setStatus(COACH, F.recommendationId, { expectedVersion: 2, status: 'ON' }), 409, 'VERSION_CONFLICT', 'already ON');
  await refused(() => setStatus(COACH, F.recommendationId, { expectedVersion: 2, status: 'GONE' }), 400, 'VALIDATION_FAILED', 'unknown status');
  await refused(() => setStatus(COACH, F.recommendationId, { expectedVersion: 2, status: 'OFF', extra: 1 }), 400, 'VALIDATION_FAILED', 'status with an extra key');
  await refused(() => setStatus(COACH, 'nope', { expectedVersion: 2, status: 'OFF' }), 400, 'VALIDATION_FAILED', 'bad id');
  await refused(() => setStatus(NOPE, F.recommendationId, { expectedVersion: 2, status: 'OFF' }), 403, 'JOURNEY_RECOMMENDATIONS_FORBIDDEN', 'status without permission');
  await refused(() => setStatus(COACH, F.recommendationId, { expectedVersion: 2, status: 'OFF' }, { command: 'journey_recommendations.save' }), 403, 'HUMAN_UI_REQUIRED', 'status under another command');
  const skey = randomUUID();
  const off = (await success(() => setStatus(COACH, F.recommendationId, { expectedVersion: 2, status: 'OFF' }, { key: skey }), 'turn F off'));
  ok(off.data.recommendation.status === 'OFF' && off.data.recommendation.version === 3, 'F is OFF at version 3');
  ok((await success(() => setStatus(COACH, F.recommendationId, { expectedVersion: 2, status: 'OFF' }, { key: skey }), 'status replay')).meta.replayed === true, 'status replays');
  seen = (await success(() => parentRead(GUARDIAN), 'parent after OFF')).data;
  ok(!JSON.stringify(seen).includes('Edited title') && !JSON.stringify(seen).includes('Turned off later'), 'an OFF recommendation is hidden from families');
  await success(() => setStatus(COACH, F.recommendationId, { expectedVersion: 3, status: 'ON' }), 'turn F on');
  ok(kids((await success(() => parentRead(GUARDIAN), 'parent after ON')).data)['Mia Kim'].includes('Edited title'), 'ON again shows it');
  await success(() => setStatus(COACH, F.recommendationId, { expectedVersion: 4, status: 'REMOVED' }), 'remove F');
  await refused(() => setStatus(COACH, F.recommendationId, { expectedVersion: 5, status: 'ON' }), 404, 'JOURNEY_RECOMMENDATIONS_NOT_FOUND', 'removed is final');
  await refused(() => save(COACH, rec({ recommendationId: F.recommendationId, expectedVersion: 5 })), 404, 'JOURNEY_RECOMMENDATIONS_NOT_FOUND', 'a removed one cannot be edited');
  const staffList = (await success(() => list(COACH), 'staff list')).data.recommendations;
  ok(staffList.length === 6 && !staffList.some((r) => r.recommendationId === F.recommendationId), 'the staff list leaves removed ones out');
  ok(!kids((await success(() => parentRead(GUARDIAN), 'parent after remove')).data)['Mia Kim'].includes('Edited title'), 'removed is hidden from families');

  // 5. Live state: a child signed up by a PAID order is skipped; a target that is no longer live hides the recommendation.
  await sql('ALTER TABLE hon.family_checkout_orders DISABLE TRIGGER USER');
  await sql(`INSERT INTO hon.family_checkout_orders(organization_id,school_id,checkout_id,checkout_version,family_id,principal_id,option_key,participants,add_on_keys,title,amount_minor,currency,status,request_key,request_sha256,settled_at)
    VALUES($1,$2,$3,1,$4,$5,'week',$6,'[]','Summer camp',5000,'USD','PAID','seed-key',$7,clock_timestamp())`,
    [ids.organization, ids.school, CAMP, ids.family, GUARDIAN.principal, JSON.stringify([{ studentProfileId: mia, answers: {} }]), 'a'.repeat(64)]);
  await sql('ALTER TABLE hon.family_checkout_orders ENABLE TRIGGER USER');
  ok(!kids((await success(() => parentRead(GUARDIAN), 'after a paid order')).data)['Mia Kim'].includes('Summer camp for Yellow belts'), 'a child already signed up is skipped');
  await sql("UPDATE hon.school_events SET status='CANCELLED',version=version+1 WHERE id=$1", [OPEN_HOUSE]);
  const afterCancel = (await success(() => parentRead(GUARDIAN), 'after the event is cancelled')).data;
  ok(!JSON.stringify(afterCancel).includes('Come to the open house'), 'a cancelled event hides its recommendation');
  ok((await success(() => list(COACH), 'staff sees the dead target')).data.recommendations.find((r) => r.recommendationId === D.recommendationId).targetLive === false, 'staff see the target is no longer live');
  // Progress moves: a new MET observation version for Mia's third requirement does not change B (already hidden), but Leo's test ending hides C.
  await sql("UPDATE hon.testing_events SET status='CANCELLED' WHERE curriculum_id=$1", [ids.karate]);
  ok(kids((await success(() => parentRead(GUARDIAN), 'after the test is cancelled')).data)['Leo Kim'].length === 0, 'a cancelled test hides TEST_BOOKED');
  void E; void G;

  // 6. Limits, audit and guards.
  await sql('ALTER TABLE hon.journey_recommendations DISABLE TRIGGER journey_recommendations_guard');
  await sql(`INSERT INTO hon.journey_recommendations(organization_id,school_id,curriculum_id,trigger_kind,rank_id,title,message,target_kind,created_by_principal_id,updated_by_principal_id)
    SELECT $1,$2,$3,'RANK_REACHED',$4,'Filler '||g,'x','ASK_SCHOOL',$5,$5 FROM generate_series(1,49) g`, [ids.organization, ids.school, ids.weapons, ids.blade, COACH.principal]);
  await sql('ALTER TABLE hon.journey_recommendations ENABLE TRIGGER journey_recommendations_guard');
  await refused(() => save(COACH, rec({ curriculumId: ids.weapons, rankId: ids.blade, title: 'One too many' })), 422, 'JOURNEY_RECOMMENDATIONS_LIMIT', 'the 51st live recommendation in a program');
  ok((await success(() => save(COACH, rec({ title: 'Other program still fine' })), 'other program', 201)).data.recommendation.status === 'ON', 'the limit is per program');
  const audits = (await sql("SELECT action_code, next_state::text s FROM hon.audit_events WHERE entity_type='JOURNEY_RECOMMENDATION' AND school_id=$1", [ids.school])).rows;
  ok(audits.length === 12 && audits.every((a) => !/sparring|Summer|Edited|Leadership/i.test(a.s)), 'every change audited with ids only');
  await assert.rejects(sql('DELETE FROM hon.journey_recommendations WHERE id=$1', [A.recommendationId])); checks += 1;
  await assert.rejects(sql("UPDATE hon.journey_recommendations SET status='ON',version=version+1 WHERE id=$1", [F.recommendationId])); checks += 1;
  await assert.rejects(sql('UPDATE hon.journey_recommendations SET curriculum_id=$2,version=version+1 WHERE id=$1', [A.recommendationId, ids.weapons])); checks += 1;
  await assert.rejects(sql("UPDATE hon.journey_recommendations SET title='x' WHERE id=$1", [A.recommendationId])); checks += 1;
  await assert.rejects(sql(`INSERT INTO hon.journey_recommendations(organization_id,school_id,curriculum_id,trigger_kind,rank_id,title,message,target_kind,status,created_by_principal_id,updated_by_principal_id)
    VALUES($1,$2,$3,'RANK_REACHED',$4,'T','x','ASK_SCHOOL','OFF',$5,$5)`, [ids.organization, ids.school, ids.karate, ids.yellow, COACH.principal])); checks += 1;

  // 7. Live authority: revoked staff role, ended family grant, suspended school and lapsed entitlement are refused.
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=principal_id WHERE id=$1', [COACH.grant]);
  await refused(() => list(COACH), 403, 'JOURNEY_RECOMMENDATIONS_FORBIDDEN', 'a revoked staff role');
  await sql('UPDATE hon.principal_role_grants SET revoked_at=NULL, revoked_by_principal_id=NULL WHERE id=$1', [COACH.grant]);
  await sql("UPDATE hon.family_access_grants SET effective_until=clock_timestamp()+interval '1 second' WHERE principal_id=$1", [VIEWER.principal]);
  await new Promise((r) => setTimeout(r, 1200));
  await refused(() => parentRead(VIEWER), 403, 'JOURNEY_RECOMMENDATIONS_FORBIDDEN', 'an ended family grant');
  await sql("UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1", [ids.school]);
  await refused(() => parentRead(GUARDIAN), 403, 'JOURNEY_RECOMMENDATIONS_FORBIDDEN', 'suspended school, parent');
  await refused(() => list(COACH), 403, 'JOURNEY_RECOMMENDATIONS_FORBIDDEN', 'suspended school, staff');
  await sql("UPDATE hon.schools SET status='ACTIVE' WHERE id=$1", [ids.school]);
  await sql("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp()-interval '1 minute', effective_from=clock_timestamp()-interval '2 days' WHERE organization_id=$1", [ids.organization]);
  await refused(() => parentRead(GUARDIAN), 403, 'JOURNEY_RECOMMENDATIONS_FORBIDDEN', 'lapsed entitlement, parent');
  await refused(() => save(COACH, rec({ title: 'While lapsed' })), 403, 'JOURNEY_RECOMMENDATIONS_FORBIDDEN', 'lapsed entitlement, staff');
  await sql('UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1', [ids.organization]);
  ok((await success(() => parentRead(GUARDIAN), 'access returns')).data.children.length === 4, 'works again once access is live');

  // 8. Database boundary: definer entry points only; helpers and the table private; 011 section.
  const entry = ['read_parent_journey_recommendations(text)', 'read_journey_recommendations(text)', 'save_journey_recommendation(text,jsonb,text,uuid,uuid)', 'set_journey_recommendation_status(text,jsonb,text,uuid,uuid)'];
  const helpers = ['journey_text_ok(text,integer,boolean)', 'guard_journey_recommendation()', 'require_journey_recommendations_actor(text)', 'journey_recommendation_parent_scope(text)',
    'journey_checkout_title(uuid,uuid,uuid)', 'journey_event_title(uuid,uuid,uuid)', 'journey_recommendation_reached(hon.journey_recommendations,hon.student_curriculum_enrollments)',
    'journey_child_signed_up(hon.journey_recommendations,uuid)', 'journey_recommendation_staff_json(hon.journey_recommendations)'];
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
    FROM pg_class c WHERE c.oid='hon.journey_recommendations'::regclass`, [CRM_CLOSE_RUNTIME_ROLE])).rows[0];
  ok(t.relrowsecurity && t.relforcerowsecurity && !t.sel && !t.ins, 'journey_recommendations: forced RLS and no runtime table privilege');
  await assert.rejects(runtime.query('SELECT * FROM hon.journey_recommendations')); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const startMark = '-- Journey recommendations exact verification (0603)', endMark = '-- End journey recommendations exact verification.';
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: journey recommendations (0603): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch(() => {});
  await admin.end();
  await runtime.end();
}
