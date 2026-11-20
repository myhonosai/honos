/**
 * Journey recommendation responses proof (0608) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guards ->
 * ParentJourneyRecommendationsController respond / JourneyRecommendationsController interest -> protected definer functions on the restricted
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
const ids = Object.fromEntries(['organization', 'otherOrganization', 'school', 'otherSchool', 'family', 'otherFamily', 'busyFamily',
  'karate', 'otherCurriculum', 'white', 'yellow', 'orange', 'otherRank'].map((key) => [key, randomUUID()]));
const PREFIX = `jresp-${ids.organization}`;
const sql = (text, values = []) => admin.query(text, values);
const one = async (text, values = []) => (await sql(text, values)).rows[0];
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [M.ParentJourneyRecommendationsController, M.JourneyRecommendationsController],
    providers: [HonIdentityGuard, HonIdentityService, JourneyRecommendationsService, M.ParentJourneyRecommendationsReadGuard, M.ParentJourneyRecommendationsRespondGuard, M.JourneyRecommendationsReadGuard,
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
const respond = (actor, id, kind, options = {}) => call(actor, 'POST', `/parent/journey-recommendations/${id}/response`, { body: { kind }, command: 'parent.journey_recommendations.respond', ...options });
const interest = (actor, options = {}) => call(actor, 'GET', `${base(actor)}/interest`, options);

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
async function role(org, permissions) {
  const id = randomUUID();
  await sql('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)', [id, org, `STAFF_${id.slice(0, 8)}`]);
  for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [id, org, permission]);
  return id;
}
async function staff(label, roleId, { school = ids.school } = {}) {
  const actor = await person(label, 'Coach Secret-Staff-Name');
  await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')",
    [randomUUID(), ids.organization, school, actor.principal, roleId]);
  return { ...actor, school };
}
async function child(given, family, rank, { school = ids.school, curriculum = ids.karate, status = 'ACTIVE' } = {}) {
  const personId = randomUUID(), profile = randomUUID();
  await sql('INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4,$5)', [personId, ids.organization, school, given, 'Park']);
  await sql("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,'STUDENT')", [ids.organization, school, family, personId]);
  await sql('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id,primary_family_id,status) VALUES($1,$2,$3,$4,$5,$6)', [profile, ids.organization, school, personId, family, status]);
  await sql('ALTER TABLE hon.student_curriculum_enrollments DISABLE TRIGGER USER');
  try {
    await sql(`INSERT INTO hon.student_curriculum_enrollments(organization_id,school_id,student_profile_id,curriculum_id,current_rank_id,enrolled_at)
      VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '30 days')`, [ids.organization, school, profile, curriculum, rank]);
  } finally { await sql('ALTER TABLE hon.student_curriculum_enrollments ENABLE TRIGGER USER'); }
  return profile;
}
const rec = (patch = {}) => ({ recommendationId: null, expectedVersion: null, curriculumId: ids.karate, triggerKind: 'RANK_REACHED', rankId: ids.yellow, threshold: null,
  title: 'Join the sparring club', message: 'Sparring club is open to Yellow belts and up.', targetKind: 'ASK_SCHOOL',
  targetCheckoutId: null, targetEventId: null, skipEnrolled: false, ...patch });

let GUARDIAN, SECOND, VIEWER, OUTSIDER, TWO, NEIGHBOUR, OTHER_PARENT, COACH, NOPE, COACH_B;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Response Org','Response Org'),($2,'Response Other Org','Response Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5),($6,$2,$7,$8,$5)',
    [ids.school, ids.organization, 'Response Dojo', `jresp-a-${ids.school.slice(0, 8)}`, LA, ids.otherSchool, 'Response Dojo B', `jresp-b-${ids.otherSchool.slice(0, 8)}`]);
  await sql("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$3,$4,'Park Family'),($2,$3,$4,'Neighbour Family')", [ids.family, ids.otherFamily, ids.organization, ids.school]);
  await sql("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'B Family')", [ids.busyFamily, ids.organization, ids.otherSchool]);
  await sql("INSERT INTO hon.curricula(id,organization_id,school_id,name,model_code,lifecycle) VALUES($1,$3,$4,'Kids Karate','LINEAR','PUBLISHED'),($2,$3,$5,'Other Karate','LINEAR','PUBLISHED')",
    [ids.karate, ids.otherCurriculum, ids.organization, ids.school, ids.otherSchool]);
  for (const [id, cur, name, order, school] of [[ids.white, ids.karate, 'White Belt', 1, ids.school], [ids.yellow, ids.karate, 'Yellow Belt', 2, ids.school], [ids.orange, ids.karate, 'Orange Belt', 3, ids.school],
    [ids.otherRank, ids.otherCurriculum, 'Yellow Belt', 1, ids.otherSchool]]) {
    await sql('INSERT INTO hon.curriculum_ranks(id,organization_id,school_id,curriculum_id,name,progression_order) VALUES($1,$2,$3,$4,$5,$6)', [id, ids.organization, school, cur, name, order]);
  }
  GUARDIAN = await person('guardian'); SECOND = await person('second'); VIEWER = await person('viewer'); OUTSIDER = await person('outsider');
  TWO = await person('two'); NEIGHBOUR = await person('neighbour'); OTHER_PARENT = await person('other-parent');
  for (const [actor, family, level, school] of [[GUARDIAN, ids.family, 'PRIMARY_GUARDIAN', ids.school], [SECOND, ids.family, 'SECONDARY_GUARDIAN', ids.school],
    [VIEWER, ids.family, 'VIEWER', ids.school], [TWO, ids.family, 'PRIMARY_GUARDIAN', ids.school], [TWO, ids.otherFamily, 'PRIMARY_GUARDIAN', ids.school],
    [NEIGHBOUR, ids.otherFamily, 'PRIMARY_GUARDIAN', ids.school], [OTHER_PARENT, ids.busyFamily, 'PRIMARY_GUARDIAN', ids.otherSchool]]) {
    await sql("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day',$4)",
      [ids.organization, school, family, actor.principal, level]);
  }
  COACH = await staff('coach', await role(ids.organization, ['curriculum.manage']));
  NOPE = await staff('nope', await role(ids.organization, ['people.read', 'family_messages.manage']));
  COACH_B = await staff('coach-b', await role(ids.organization, ['curriculum.manage']), { school: ids.otherSchool });
  await child('Mia', ids.family, ids.yellow); await child('Leo', ids.family, ids.white); await child('Old', ids.family, ids.yellow, { status: 'ARCHIVED' });
  await child('Ivy', ids.otherFamily, ids.yellow);
  await child('Bo', ids.busyFamily, ids.otherRank, { school: ids.otherSchool, curriculum: ids.otherCurriculum });
}
const titles = (data) => Object.fromEntries(data.children.map((c) => [c.name, c.recommendations.map((r) => r.title).sort()]));

try {
  await cleanup();
  await seed();
  await startApp();

  const A = (await success(() => save(COACH, rec()), 'save A', 201)).data.recommendation;
  const B = (await success(() => save(COACH, rec({ title: 'Gear up for Yellow', targetKind: 'PRO_SHOP' })), 'save B', 201)).data.recommendation;
  const LATER = (await success(() => save(COACH, rec({ rankId: ids.orange, title: 'Orange belt club' })), 'save later', 201)).data.recommendation;
  const OTHER = (await success(() => save(COACH_B, rec({ curriculumId: ids.otherCurriculum, rankId: ids.otherRank, title: 'Other school club' })), 'save other school', 201)).data.recommendation;
  const before = (await success(() => parentRead(GUARDIAN), 'parent read before')).data;
  ok(JSON.stringify(titles(before)) === JSON.stringify({ 'Leo Park': [], 'Mia Park': ['Gear up for Yellow', 'Join the sparring club'] }), 'Mia sees A and B before any answer');

  // 1. Input, scope and command checks: nothing is recorded by a refusal.
  for (const [label, body] of [['no kind', {}], ['bad kind', { kind: 'LIKED' }], ['extra key', { kind: 'HIDDEN', familyId: ids.family }], ['lowercase kind', { kind: 'hidden' }]]) {
    await refused(() => call(GUARDIAN, 'POST', `/parent/journey-recommendations/${A.recommendationId}/response`, { body, command: 'parent.journey_recommendations.respond' }), 400, 'VALIDATION_FAILED', `respond validation: ${label}`);
  }
  await refused(() => respond(GUARDIAN, 'not-a-uuid', 'HIDDEN'), 400, 'VALIDATION_FAILED', 'respond: bad id');
  await refused(() => respond(GUARDIAN, A.recommendationId, 'HIDDEN', { command: 'journey_recommendations.save' }), 403, 'HUMAN_UI_REQUIRED', 'respond: wrong command');
  await refused(() => respond(GUARDIAN, A.recommendationId, 'HIDDEN', { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'respond: cross-site');
  await refused(() => call(GUARDIAN, 'POST', `/parent/journey-recommendations/${A.recommendationId}/response?family=${ids.family}`, { body: { kind: 'HIDDEN' }, command: 'parent.journey_recommendations.respond' }), 400, 'JOURNEY_RECOMMENDATIONS_SELECTORS_NOT_ACCEPTED', 'respond: no selector');
  await refused(() => respond(VIEWER, A.recommendationId, 'HIDDEN'), 403, 'JOURNEY_RECOMMENDATIONS_FORBIDDEN', 'a VIEWER cannot answer for the family');
  await refused(() => respond(OUTSIDER, A.recommendationId, 'HIDDEN'), 403, 'JOURNEY_RECOMMENDATIONS_FORBIDDEN', 'no family grant');
  await refused(() => respond(TWO, A.recommendationId, 'HIDDEN'), 403, 'JOURNEY_RECOMMENDATIONS_FORBIDDEN', 'two families are ambiguous');
  await refused(() => respond(GUARDIAN, LATER.recommendationId, 'INTERESTED'), 404, 'JOURNEY_RECOMMENDATIONS_NOT_FOUND', 'a rank not reached yet');
  await refused(() => respond(GUARDIAN, OTHER.recommendationId, 'INTERESTED'), 404, 'JOURNEY_RECOMMENDATIONS_NOT_FOUND', 'another school recommendation');
  await refused(() => respond(GUARDIAN, randomUUID(), 'INTERESTED'), 404, 'JOURNEY_RECOMMENDATIONS_NOT_FOUND', 'an unknown recommendation');
  await refused(() => respond(OTHER_PARENT, A.recommendationId, 'INTERESTED'), 404, 'JOURNEY_RECOMMENDATIONS_NOT_FOUND', 'a family of another school');
  ok(Number((await one('SELECT count(*) n FROM hon.journey_recommendation_responses WHERE organization_id=$1', [ids.organization])).n) === 0, 'refusals record nothing');

  // 2. INTERESTED: recorded once per family, replay returns the same row, staff see names and dates only.
  const interested = (await success(() => respond(GUARDIAN, A.recommendationId, 'INTERESTED'), 'guardian interested')).data;
  ok(interested.recommendationId === A.recommendationId && interested.kind === 'INTERESTED' && interested.replayed === false && /Z$/.test(interested.recordedAt), 'interest receipt');
  ok(Object.keys(interested).sort().join() === 'kind,recommendationId,recordedAt,replayed', 'receipt has display fields only');
  const replay = (await success(() => respond(SECOND, A.recommendationId, 'INTERESTED'), 'second guardian interested')).data;
  ok(replay.replayed === true && replay.recordedAt === interested.recordedAt, 'the other guardian of the same family replays the same row');
  ok(JSON.stringify(titles((await success(() => parentRead(GUARDIAN), 'read after interest')).data)) === JSON.stringify(titles(before)), 'interest does not hide the recommendation');
  await success(() => respond(NEIGHBOUR, A.recommendationId, 'INTERESTED'), 'neighbour interested');
  const list1 = (await success(() => interest(COACH), 'staff interest list')).data.interest;
  ok(list1.length === 2 && list1.every((i) => i.recommendationId === A.recommendationId), 'two families interested in A');
  ok(list1[0].familyName === 'Neighbour Family' && JSON.stringify(list1[0].children) === JSON.stringify(['Ivy Park']), 'newest first, with ACTIVE children names');
  ok(list1[1].familyName === 'Park Family' && JSON.stringify(list1[1].children) === JSON.stringify(['Leo Park', 'Mia Park']), 'inactive children left out');
  ok(Object.keys(list1[0]).sort().join() === 'children,familyId,familyName,recommendationId,recordedAt', 'staff get names and dates only');
  ok(!JSON.stringify(list1).includes('@example.test') && !JSON.stringify(list1).includes(GUARDIAN.principal), 'no contact details or principal ids');
  await refused(() => interest(NOPE), 403, 'JOURNEY_RECOMMENDATIONS_FORBIDDEN', 'staff without curriculum.manage');
  await refused(() => interest(GUARDIAN), 403, 'JOURNEY_RECOMMENDATIONS_FORBIDDEN', 'a parent is not staff');
  await refused(() => interest(COACH, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'a read takes no key');
  await refused(() => call(COACH, 'GET', `/organizations/${ids.organization}/schools/${ids.otherSchool}/journey-recommendations/interest`), 403, 'JOURNEY_RECOMMENDATIONS_FORBIDDEN', 'another school by URL');
  ok((await success(() => interest(COACH_B), 'other school interest')).data.interest.length === 0, 'another school sees none of these');

  // 3. HIDDEN: the family read leaves it out for every member of that family only; answering again is a replay.
  const hid = (await success(() => respond(GUARDIAN, B.recommendationId, 'HIDDEN'), 'guardian hides B')).data;
  ok(hid.kind === 'HIDDEN' && hid.replayed === false, 'hide receipt');
  const after = (await success(() => parentRead(VIEWER), 'viewer read after hide')).data;
  ok(JSON.stringify(titles(after)) === JSON.stringify({ 'Leo Park': [], 'Mia Park': ['Join the sparring club'] }), 'hidden for the whole family, viewer included');
  ok(titles((await success(() => parentRead(NEIGHBOUR), 'neighbour read')).data)['Ivy Park'].includes('Gear up for Yellow'), 'another family still sees B');
  ok((await success(() => respond(GUARDIAN, B.recommendationId, 'HIDDEN'), 'hide replay')).data.replayed === true, 'hiding again is a replay');
  await refused(() => respond(GUARDIAN, B.recommendationId, 'INTERESTED'), 404, 'JOURNEY_RECOMMENDATIONS_NOT_FOUND', 'a hidden recommendation cannot gain new interest');
  ok((await success(() => respond(GUARDIAN, A.recommendationId, 'HIDDEN'), 'hide A after interest')).data.replayed === false, 'interest and then Not now are two answers');
  ok((await success(() => interest(COACH), 'interest after hide')).data.interest.length === 2, 'hiding later keeps the interest the school already saw');

  // 4. OFF takes no new answers; REMOVED leaves the staff interest list.
  await success(() => setStatus(COACH, B.recommendationId, { expectedVersion: 1, status: 'OFF' }), 'B OFF');
  await refused(() => respond(NEIGHBOUR, B.recommendationId, 'INTERESTED'), 404, 'JOURNEY_RECOMMENDATIONS_NOT_FOUND', 'an OFF recommendation takes no answer');
  await success(() => setStatus(COACH, A.recommendationId, { expectedVersion: 1, status: 'REMOVED' }), 'remove A');
  ok((await success(() => interest(COACH), 'interest after remove')).data.interest.length === 0, 'a removed recommendation leaves the interest list');

  // 5. Audit with ids only; rows never change.
  const audits = (await sql("SELECT action_code, next_state::text s, actor_principal_id FROM hon.audit_events WHERE entity_type='JOURNEY_RECOMMENDATION' AND school_id=$1 AND action_code LIKE 'journey.recommendation.%' AND action_code IN ('journey.recommendation.hide','journey.recommendation.interest')", [ids.school])).rows;
  ok(audits.filter((a) => a.action_code === 'journey.recommendation.interest').length === 2 && audits.filter((a) => a.action_code === 'journey.recommendation.hide').length === 2, 'one audit per new answer, none for replays');
  ok(audits.every((a) => !/Park|Neighbour|Sparring|Gear/i.test(a.s)), 'audit carries ids only');
  await assert.rejects(sql("UPDATE hon.journey_recommendation_responses SET kind='HIDDEN' WHERE organization_id=$1", [ids.organization]), /JOURNEY_RECOMMENDATION_RESPONSE_IMMUTABLE/); checks += 1;
  await assert.rejects(sql('DELETE FROM hon.journey_recommendation_responses WHERE organization_id=$1', [ids.organization]), /JOURNEY_RECOMMENDATION_RESPONSE_IMMUTABLE/); checks += 1;
  await assert.rejects(sql('TRUNCATE hon.journey_recommendation_responses'), /JOURNEY_RECOMMENDATION_RESPONSE_IMMUTABLE/); checks += 1;

  // 6. Ended grant: refused.
  await sql("UPDATE hon.family_access_grants SET effective_until=clock_timestamp()+interval '1 second' WHERE principal_id=$1", [SECOND.principal]);
  await new Promise((r) => setTimeout(r, 1200));
  await refused(() => respond(SECOND, B.recommendationId, 'INTERESTED'), 403, 'JOURNEY_RECOMMENDATIONS_FORBIDDEN', 'an ended family grant');

  // 7. Runtime ACL: two EXECUTE-only entry points, private table and guard, 011 section.
  for (const fn of ['respond_parent_journey_recommendation(text,uuid,text)', 'read_journey_recommendation_interest(text)', 'read_parent_journey_recommendations(text)']) {
    const r = (await sql(`SELECT has_function_privilege($1,p.oid,'EXECUTE') runtime, p.prosecdef def FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(r.runtime && r.def, `${fn}: runtime EXECUTE, security definer`);
  }
  { const r = (await sql(`SELECT has_function_privilege($1,'hon.guard_journey_recommendation_response()'::regprocedure,'EXECUTE') runtime`, [CRM_CLOSE_RUNTIME_ROLE])).rows[0];
    ok(!r.runtime, 'the immutability guard is private'); }
  const t = (await sql(`SELECT c.relrowsecurity, c.relforcerowsecurity, has_table_privilege($1,c.oid,'SELECT') sel, has_table_privilege($1,c.oid,'INSERT') ins,
    has_table_privilege($1,c.oid,'UPDATE') upd, has_table_privilege($1,c.oid,'DELETE') del FROM pg_class c WHERE c.oid='hon.journey_recommendation_responses'::regclass`, [CRM_CLOSE_RUNTIME_ROLE])).rows[0];
  ok(t.relrowsecurity && t.relforcerowsecurity && !t.sel && !t.ins && !t.upd && !t.del, 'responses: forced RLS and no runtime table privilege');
  await assert.rejects(runtime.query('SELECT * FROM hon.journey_recommendation_responses')); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const startMark = '-- Journey recommendation responses exact verification (0608)', endMark = '-- End journey recommendation responses exact verification.';
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: journey recommendation responses (0608): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch(() => {});
  await admin.end();
  await runtime.end();
}
