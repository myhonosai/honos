/**
 * Parent school and family picker proof (0471) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guards ->
 * ParentFamilyPickerController and ParentClassBookingController -> protected definer functions on the restricted runtime role
 * with forced RLS), on the guarded disposable CRM-close fixture only. Synthetic names only; nothing is sent.
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
const { ParentFamilyPickerController, ParentFamilyPickerReadGuard, ParentFamilyPickerSelectGuard } = await load('families/parent-family-picker.controller.js');
const { ParentFamilyPickerService } = await load('families/parent-family-picker.service.js');
const { ParentClassBookingController, ParentClassBookingReadGuard, ParentClassBookingBookGuard, ParentClassBookingCancelGuard } = await load('families/parent-class-booking.controller.js');
const { ParentClassBookingService } = await load('families/parent-class-booking.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-parent-family-picker', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles', NY = 'America/New_York';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'school', 'secondSchool', 'otherSchool', 'family', 'household', 'otherFamily', 'stranger']
  .map((key) => [key, randomUUID()]));
const PREFIX = `pfpick-${ids.organization}`;
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [ParentFamilyPickerController, ParentClassBookingController],
    providers: [HonIdentityGuard, HonIdentityService, ParentFamilyPickerService, ParentFamilyPickerReadGuard, ParentFamilyPickerSelectGuard,
      ParentClassBookingService, ParentClassBookingReadGuard, ParentClassBookingBookGuard, ParentClassBookingCancelGuard,
      { provide: RuntimeDatabaseService, useValue: database }],
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
const SELECT = 'parent.family.select';
function call(actor, method, path, { body, command, headers = {} } = {}) {
  const target = new URL(`${origin}/v1/parent/${path}`);
  const sent = {
    Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`,
    Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json',
    ...(method === 'POST' ? { 'Content-Type': 'application/json', ...(command ? { 'X-Hon-Human-Command': command } : {}) } : {}),
    ...headers,
  };
  for (const [name, value] of Object.entries(sent)) if (value === undefined) delete sent[name];
  return send(target, method, sent, body === undefined ? undefined : JSON.stringify(body));
}
const list = (actor, options = {}) => call(actor, 'GET', 'families', options);
const choose = (actor, body, options = {}) => call(actor, 'POST', 'families/current', { body, command: SELECT, ...options });
const bookings = (actor) => call(actor, 'GET', 'class-bookings');

async function success(read, label) {
  const { status, body, headers } = await read();
  assert.equal(status, 200, `${label}: expected 200, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  ok(/no-store/.test(headers['cache-control'] ?? ''), `${label}: never cached`);
  return body.data;
}
async function refused(read, expectedStatus, expectedCode, label) {
  const { status, body } = await read();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  if (expectedCode) assert.equal(body.code, expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(body).slice(0, 400)}`);
  ok(!('data' in body), `${label}: a refusal returns no data`);
}

// Disposable-fixture cleanup only (as in the 0329 proof).
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
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

async function person(label) {
  const user = randomUUID(), principal = randomUUID(), subject = `${PREFIX}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Parent')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Parent')", [principal, user]);
  return { subject, principal, user, email: `${user}@example.test` };
}
async function grant(actor, family, level, school, org) {
  const id = randomUUID();
  await sql("INSERT INTO hon.family_access_grants(id,organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()-interval '1 day',$5)",
    [id, org, school, family, actor.principal, level]);
  return id;
}
async function child(given, family, school, org) {
  const personId = randomUUID(), profile = randomUUID();
  await sql('INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4,$5)', [personId, org, school, given, 'Kim']);
  await sql("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,'STUDENT')", [org, school, family, personId]);
  await sql("INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id,primary_family_id,status) VALUES($1,$2,$3,$4,$5,'ACTIVE')", [profile, org, school, personId, family]);
  return profile;
}

let MULTI, SINGLE, OUTSIDER, G, kidA, kidHousehold, kidB;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Picker Org','Picker Org'),($2,'Picker Other Org','Picker Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5),($6,$2,$7,$8,$5),($9,$10,$11,$12,$13)',
    [ids.school, ids.organization, 'Alpha Dojo', `pfpick-a-${ids.school.slice(0, 8)}`, LA, ids.secondSchool, 'Alpha Dojo North', `pfpick-n-${ids.secondSchool.slice(0, 8)}`,
      ids.otherSchool, ids.otherOrganization, 'Beta Academy', `pfpick-b-${ids.otherSchool.slice(0, 8)}`, NY]);
  await sql("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'Kim Family'),($4,$2,$3,'Kim Household 2'),($5,$6,$7,'Kim Family B'),($8,$2,$3,'Stranger Family')",
    [ids.family, ids.organization, ids.school, ids.household, ids.otherFamily, ids.otherOrganization, ids.otherSchool, ids.stranger]);
  MULTI = await person('multi'); SINGLE = await person('single'); OUTSIDER = await person('outsider');
  G = {
    family: await grant(MULTI, ids.family, 'PRIMARY_GUARDIAN', ids.school, ids.organization),
    household: await grant(MULTI, ids.household, 'VIEWER', ids.school, ids.organization),
    other: await grant(MULTI, ids.otherFamily, 'SECONDARY_GUARDIAN', ids.otherSchool, ids.otherOrganization),
  };
  await grant(SINGLE, ids.family, 'SECONDARY_GUARDIAN', ids.school, ids.organization);
  kidA = await child('Min-jun', ids.family, ids.school, ids.organization);
  kidHousehold = await child('Seo-yeon', ids.household, ids.school, ids.organization);
  kidB = await child('Ji-ho', ids.otherFamily, ids.otherSchool, ids.otherOrganization);
}
const resolved = async (actor) => (await runtime.query('SELECT school_id::text, family_id::text FROM hon.resolve_parent_journey_scopes($1) ORDER BY 1,2', [actor.subject])).rows;
const children = (view) => view.children.map((c) => c.studentProfileId).sort().join();
async function faceScope(actor, org, school) {
  await sql('BEGIN');
  try {
    await sql(`SELECT set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),
      set_config('app.hon_principal_id',$2,true),set_config('app.hon_organization_id',$3,true),set_config('app.hon_school_id',$4,true),
      set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)`, [actor.subject, actor.principal, org, school]);
    return (await sql('SELECT family_id::text FROM hon.face_checkin_family_scope($1,false)', [actor.subject])).rows[0]?.family_id;
  } catch (error) { return error.message; } finally { await sql('ROLLBACK'); }
}

try {
  await cleanup();
  await seed();
  await startApp();

  // 1. One family: it is the current one and nothing needs choosing. No family: an empty list.
  const single = await success(() => list(SINGLE), 'one family');
  ok(single.needsChoice === false && single.choices.length === 1 && single.choices[0].current === true && single.choices[0].familyId === ids.family
    && single.choices[0].schoolName === 'Alpha Dojo' && single.choices[0].familyName === 'Kim Family' && single.choices[0].accessLevel === 'SECONDARY_GUARDIAN', 'one family is current');
  const none = await success(() => list(OUTSIDER), 'no family');
  ok(none.needsChoice === false && none.choices.length === 0, 'no grant lists nothing');

  // 2. Several families at two organizations: all listed, none current, a choice is needed, and every parent read still refuses.
  const many = await success(() => list(MULTI), 'several families');
  ok(many.needsChoice === true && many.choices.length === 3 && many.choices.every((c) => c.current === false), 'three families, none current, a choice is needed');
  ok(JSON.stringify(many.choices.map((c) => [c.schoolName, c.familyName, c.accessLevel])) === JSON.stringify([['Alpha Dojo', 'Kim Family', 'PRIMARY_GUARDIAN'],
    ['Alpha Dojo', 'Kim Household 2', 'VIEWER'], ['Beta Academy', 'Kim Family B', 'SECONDARY_GUARDIAN']]), 'sorted by school and family name with the parent\'s own access level');
  ok(!JSON.stringify(many).includes('Stranger') && !JSON.stringify(many).includes('North'), 'no other family or unlinked school is listed');
  ok((await resolved(MULTI)).length === 2, 'the resolver stays ambiguous until the parent chooses');
  await refused(() => bookings(MULTI), 403, 'PARENT_CLASS_BOOKING_FORBIDDEN', 'class booking refuses before a choice');
  ok(String(await faceScope(MULTI, ids.organization, ids.school)).includes('FACE_CHECKIN_FORBIDDEN'), 'face check-in refuses before a choice');

  // 3. The choose command: closed body, its own command header, same origin, no selectors in the URL.
  for (const [label, body] of [['missing family', { schoolId: ids.school }], ['extra key', { schoolId: ids.school, familyId: ids.family, principalId: MULTI.principal }],
    ['bad id', { schoolId: 'x', familyId: ids.family }], ['upper-case id', { schoolId: ids.school.toUpperCase(), familyId: ids.family }], ['array', [ids.school, ids.family]]]) {
    await refused(() => choose(MULTI, body), 400, 'VALIDATION_FAILED', `choose validation: ${label}`);
  }
  await refused(() => choose(MULTI, { schoolId: ids.school, familyId: ids.family }, { command: 'parent.class_booking.book' }), 403, 'HUMAN_UI_REQUIRED', 'choose under another command');
  await refused(() => choose(MULTI, { schoolId: ids.school, familyId: ids.family }, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-site choose');
  await refused(() => choose(MULTI, { schoolId: ids.school, familyId: ids.family }, { headers: { Origin: 'https://evil.example' } }), 403, 'HUMAN_UI_REQUIRED', 'another origin');
  await refused(() => call(MULTI, 'GET', 'families?familyId=x'), 400, 'PARENT_FAMILY_SELECTORS_NOT_ACCEPTED', 'no selector on the list');
  await refused(() => call(MULTI, 'POST', 'families/current?schoolId=x', { body: { schoolId: ids.school, familyId: ids.family }, command: SELECT }), 400, 'PARENT_FAMILY_SELECTORS_NOT_ACCEPTED', 'no selector on the command');
  await refused(() => choose(MULTI, { schoolId: ids.school, familyId: ids.stranger }), 404, 'PARENT_FAMILY_NOT_AVAILABLE', 'a family the parent is not linked to');
  await refused(() => choose(MULTI, { schoolId: ids.otherSchool, familyId: ids.family }), 404, 'PARENT_FAMILY_NOT_AVAILABLE', 'a linked family under the wrong school');
  await refused(() => choose(OUTSIDER, { schoolId: ids.school, familyId: ids.family }), 404, 'PARENT_FAMILY_NOT_AVAILABLE', 'a parent with no grant');
  ok((await sql('SELECT count(*)::int n FROM hon.parent_family_selections WHERE user_id=ANY($1::uuid[])', [[MULTI.user, OUTSIDER.user]])).rows[0].n === 0, 'refusals store nothing');

  // 4. Choose the first family: it becomes current, and every parent path follows it.
  const first = await success(() => choose(MULTI, { schoolId: ids.school, familyId: ids.family }), 'choose Kim Family');
  ok(first.needsChoice === false && first.choices.filter((c) => c.current).map((c) => c.familyId).join() === ids.family, 'the chosen family is current');
  ok(JSON.stringify(await resolved(MULTI)) === JSON.stringify([{ school_id: ids.school, family_id: ids.family }]), 'the resolver gives exactly the chosen family');
  const readA = await success(() => bookings(MULTI), 'class booking read for the chosen family');
  ok(readA.timezone === LA && children(readA) === kidA && readA.canBook === true, 'class booking shows only the chosen family\'s child at its school');
  ok(await faceScope(MULTI, ids.organization, ids.school) === ids.family, 'face check-in follows the choice');
  ok(String(await faceScope(MULTI, ids.otherOrganization, ids.otherSchool)).includes('FACE_CHECKIN_FORBIDDEN'), 'face check-in refuses another tenant than the choice');
  let row = (await sql('SELECT organization_id::text o, school_id::text s, family_id::text f, version FROM hon.parent_family_selections WHERE user_id=$1', [MULTI.user])).rows[0];
  ok(row.o === ids.organization && row.s === ids.school && row.f === ids.family && row.version === 1, 'one selection row, version 1');
  let audits = (await sql("SELECT organization_id::text o, school_id::text s, entity_id::text e, actor_principal_id::text a, prior_state, next_state FROM hon.audit_events WHERE action_code='PARENT_FAMILY_SELECTED' AND actor_principal_id=$1 ORDER BY occurred_at", [MULTI.principal])).rows;
  ok(audits.length === 1 && audits[0].o === ids.organization && audits[0].s === ids.school && audits[0].e === ids.family && audits[0].prior_state === null && audits[0].next_state.version === 1, 'one audit at the chosen school');
  ok((await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE organization_id=ANY($1::uuid[]) AND payload::text LIKE '%' || $2 || '%'", [[ids.organization, ids.otherOrganization], MULTI.principal])).rows[0].n === 0, 'no outbox event');
  // Choosing the same family again changes nothing.
  await success(() => choose(MULTI, { schoolId: ids.school, familyId: ids.family }), 'choose the same family again');
  ok((await sql('SELECT version FROM hon.parent_family_selections WHERE user_id=$1', [MULTI.user])).rows[0].version === 1
    && (await sql("SELECT count(*)::int n FROM hon.audit_events WHERE action_code='PARENT_FAMILY_SELECTED' AND actor_principal_id=$1", [MULTI.principal])).rows[0].n === 1, 'a repeat is a no-op');

  // 5. Switch to the family at the other organization, without signing out.
  const second = await success(() => choose(MULTI, { schoolId: ids.otherSchool, familyId: ids.otherFamily }), 'switch to Kim Family B');
  ok(second.choices.filter((c) => c.current).map((c) => c.familyId).join() === ids.otherFamily, 'the other family is now current');
  const readB = await success(() => bookings(MULTI), 'class booking read after switching');
  ok(readB.timezone === NY && children(readB) === kidB && !JSON.stringify(readB).includes(kidA), 'class booking now shows only the other family at the other school');
  ok(await faceScope(MULTI, ids.otherOrganization, ids.otherSchool) === ids.otherFamily, 'face check-in follows the switch');
  row = (await sql('SELECT organization_id::text o, version FROM hon.parent_family_selections WHERE user_id=$1', [MULTI.user])).rows[0];
  ok(row.o === ids.otherOrganization && row.version === 2, 'the same row, version 2');
  audits = (await sql("SELECT organization_id::text o, prior_state, next_state::text n FROM hon.audit_events WHERE action_code='PARENT_FAMILY_SELECTED' AND actor_principal_id=$1 ORDER BY occurred_at", [MULTI.principal])).rows;
  ok(audits.length === 2 && audits[1].o === ids.otherOrganization && audits[1].prior_state === null && !audits[1].n.includes(ids.family) && !audits[1].n.includes(ids.organization),
    'the switch audit at the other organization never names the earlier family or organization');
  // A viewer family can be chosen; viewers read only.
  await success(() => choose(MULTI, { schoolId: ids.school, familyId: ids.household }), 'choose the viewer household');
  const readHousehold = await success(() => bookings(MULTI), 'class booking read for the viewer household');
  ok(children(readHousehold) === kidHousehold && readHousehold.canBook === false, 'a viewer household reads only');
  // Two parallel switches: one ends current, both succeed, and the row stays single.
  const race = await Promise.all([choose(MULTI, { schoolId: ids.school, familyId: ids.family }), choose(MULTI, { schoolId: ids.otherSchool, familyId: ids.otherFamily })]);
  ok(race.every((r) => r.status === 200), 'two tabs switching at once both finish');
  ok((await sql('SELECT count(*)::int n FROM hon.parent_family_selections WHERE user_id=$1', [MULTI.user])).rows[0].n === 1 && (await resolved(MULTI)).length === 1, 'one current family afterwards');

  // 6. The choice is only a pointer to a live grant: ending or suspending it stops it counting.
  await success(() => choose(MULTI, { schoolId: ids.otherSchool, familyId: ids.otherFamily }), 'choose Kim Family B before it ends');
  await sql("UPDATE hon.family_access_grants SET effective_until=clock_timestamp() WHERE id=$1", [G.other]);
  const afterEnd = await success(() => list(MULTI), 'list after the chosen grant ends');
  ok(afterEnd.needsChoice === true && afterEnd.choices.length === 2 && !afterEnd.choices.some((c) => c.familyId === ids.otherFamily), 'an ended grant is no longer a choice and a choice is needed again');
  await refused(() => bookings(MULTI), 403, 'PARENT_CLASS_BOOKING_FORBIDDEN', 'parent reads refuse again until the parent chooses');
  await refused(() => choose(MULTI, { schoolId: ids.otherSchool, familyId: ids.otherFamily }), 404, 'PARENT_FAMILY_NOT_AVAILABLE', 'an ended grant cannot be chosen');
  await sql("UPDATE hon.families SET status='SUSPENDED' WHERE id=$1", [ids.household]);
  const onlyOne = await success(() => list(MULTI), 'list with one live family left');
  ok(onlyOne.needsChoice === false && onlyOne.choices.length === 1 && onlyOne.choices[0].familyId === ids.family && onlyOne.choices[0].current === true, 'the one live family is current with no choice needed');
  ok(children(await success(() => bookings(MULTI), 'class booking with one live family')) === kidA, 'class booking works for the one live family');
  await sql("UPDATE hon.families SET status='ACTIVE' WHERE id=$1", [ids.household]);

  // 7. Family invitations (0205): another organization is no longer a conflict; the same family, staff and HQ still are.
  const invitation = (org, school, family) => ({ id: randomUUID(), organization_id: org, school_id: school, family_id: family, access_level: 'VIEWER',
    email: MULTI.email, token_hash: '0'.repeat(64), created_by: SINGLE.principal, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600e3).toISOString(), status: 'PENDING' });
  const conflict = async (inv, actor = MULTI) => (await sql('SELECT hon.school_family_acceptor_conflict($1,$2,jsonb_populate_record(NULL::hon.school_family_access_invitations,$3::jsonb)) c',
    [actor.subject, actor.email, JSON.stringify(inv)])).rows[0].c;
  ok(await conflict(invitation(ids.otherOrganization, ids.otherSchool, ids.otherFamily)) === false, 'a family at another organization can be accepted');
  ok(await conflict(invitation(ids.organization, ids.school, ids.stranger)) === false, 'another family at the same organization can be accepted');
  ok(await conflict(invitation(ids.organization, ids.school, ids.family)) === true, 'the same family twice is still refused');
  const role = (await sql("INSERT INTO hon.roles(organization_id,code,name) VALUES($1,'PICKER_STAFF','Picker staff') RETURNING id", [ids.organization])).rows[0].id;
  await sql('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,clock_timestamp()-interval \'1 day\',$3)', [ids.organization, ids.school, SINGLE.principal, role]);
  ok(await conflict(invitation(ids.otherOrganization, ids.otherSchool, ids.otherFamily), SINGLE) === true, 'a staff account is still refused');

  // 8. Database boundary: two definer entry points; the helper and the table are private; forced RLS.
  for (const fn of ['read_parent_family_choices(text)', 'select_parent_family(text,jsonb,uuid)', 'resolve_parent_journey_scopes(text)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, p.prosecdef, EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(r.runtime && r.prosecdef && !r.public, `runtime may execute definer ${fn}; PUBLIC may not`);
  }
  for (const fn of ['parent_live_family_scopes(text)', 'parent_class_booking_scope(text,boolean)', 'face_checkin_family_scope(text,boolean)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!r.runtime && !r.public, `helper ${fn} is private`);
  }
  const table = (await sql(`SELECT c.relrowsecurity rls, c.relforcerowsecurity forced,
      has_any_column_privilege($1,'hon.parent_family_selections','SELECT,INSERT,UPDATE,REFERENCES') cols, has_table_privilege($1,'hon.parent_family_selections','DELETE,TRUNCATE') del
    FROM pg_class c WHERE c.oid='hon.parent_family_selections'::regclass`, [CRM_CLOSE_RUNTIME_ROLE])).rows[0];
  ok(table.rls && table.forced && !table.cols && !table.del, 'forced RLS and no runtime table privilege');
  await assert.rejects(runtime.query('SELECT * FROM hon.parent_family_selections')); checks += 1;
  await assert.rejects(runtime.query('SELECT * FROM hon.parent_live_family_scopes($1)', [MULTI.subject])); checks += 1;
  // The command needs the human browser settings the API sets; a bare runtime call refuses.
  await assert.rejects(runtime.query("SELECT hon.select_parent_family($1,$2::jsonb,gen_random_uuid())", [MULTI.subject, JSON.stringify({ schoolId: ids.school, familyId: ids.family })]),
    (error) => error.message === 'PARENT_FAMILY_FORBIDDEN'); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const startMark = '-- Parent family picker exact verification (0471)', endMark = '-- End parent family picker exact verification.';
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: parent family picker (0471): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch(() => {});
  await admin.end();
  await runtime.end();
}
