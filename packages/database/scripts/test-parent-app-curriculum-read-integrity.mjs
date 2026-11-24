/**
 * Parent app curriculum read proof (0610) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guards + global ValidationPipe
 * + HonExceptionFilter -> ParentCurriculumAppController / ParentCurriculumLibraryController / StaffParentAppCurriculumController -> protected definer functions on the
 * restricted runtime role with forced RLS), on the guarded disposable CRM-close fixture only. Synthetic names only; nothing contacts anyone.
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
const { StaffParentAppCurriculumController, ParentCurriculumAppController, ParentAppCurriculumHumanUiGuard } = await load('curriculum/parent-app-curriculum.controller.js');
const { ParentAppCurriculumService } = await load('curriculum/parent-app-curriculum.service.js');
const { ParentCurriculumLibraryController, ParentCurriculumLibraryReadGuard } = await load('curriculum/library.controller.js');
const { CurriculumLibraryService } = await load('curriculum/library.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-parent-app-curriculum-read', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles', KIRITIMATI = 'Pacific/Kiritimati';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [StaffParentAppCurriculumController, ParentCurriculumAppController, ParentCurriculumLibraryController],
    providers: [HonIdentityGuard, HonIdentityService, ParentAppCurriculumService, ParentAppCurriculumHumanUiGuard, CurriculumLibraryService, ParentCurriculumLibraryReadGuard,
      { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}

function call(actor, method, path, { headers = {} } = {}) {
  const target = new URL(`${origin}/v1/${path}`);
  const sent = { Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`, 'Sec-Fetch-Site': 'same-origin', Accept: 'application/json', ...headers };
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
const parentApp = (actor, options) => call(actor, 'GET', 'parent/curriculum-app', options);
const parentLibrary = (actor) => call(actor, 'GET', 'parent/curriculum-library');
const preview = (actor, student, school = actor.school) => call(actor, 'GET', `staff/schools/${school}/parent-app/curriculum/preview/${student}`);

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
    await sql('DELETE FROM hon.parent_family_selections WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`pacr-${ids.organization}-%`]).catch(() => {});
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`pacr-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`pacr-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`pacr-${ids.organization}-%`]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}
async function human(label) {
  const user = randomUUID(), principal = randomUUID(), subject = `pacr-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Person')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Person')", [principal, user]);
  return { subject, principal, school: ids.schoolA };
}
async function staffWith(label, permissions, school = ids.schoolA) {
  const actor = await human(label); const roleId = randomUUID();
  await sql('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)', [roleId, ids.organization, `R_${roleId.slice(0, 8)}`]);
  for (const p of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [roleId, ids.organization, p]);
  await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [randomUUID(), ids.organization, school, actor.principal, roleId]);
  return { ...actor, school };
}
async function grant(actor, family, school = ids.schoolA, org = ids.organization) {
  await sql("INSERT INTO hon.family_access_grants(id,organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,'PRIMARY_GUARDIAN',clock_timestamp()-interval '1 day',$5)", [randomUUID(), org, school, family, actor.principal]);
}
async function child(given, family, school = ids.schoolA) {
  const personId = randomUUID(), profile = randomUUID();
  await sql('INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4,$5)', [personId, ids.organization, school, given, 'Sample']);
  await sql("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,'STUDENT')", [ids.organization, school, family, personId]);
  await sql("INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id,primary_family_id,status) VALUES($1,$2,$3,$4,$5,'ACTIVE')", [profile, ids.organization, school, personId, family]);
  return profile;
}
const enroll = (student, curriculum, rank = null, school = ids.schoolA) => sql('INSERT INTO hon.student_curriculum_enrollments(organization_id,school_id,student_profile_id,curriculum_id,current_rank_id) VALUES($1,$2,$3,$4,$5)', [ids.organization, school, student, curriculum, rank]);
async function resource(curriculum, { rank = null, cycle = null, kind = 'VIDEO', title, audience = 'PARENT', status = 'ACTIVE', school = ids.schoolA }) {
  await sql('INSERT INTO hon.curriculum_resources(organization_id,school_id,curriculum_id,rank_id,cycle_id,kind,url,title,description,audience,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [ids.organization, school, curriculum, rank, cycle, kind, `https://www.myhonos.com/${randomUUID().slice(0, 8)}`, title, `About ${title}`, audience, status]);
}
async function cycle(curriculum, name, position) {
  const id = randomUUID();
  await sql('INSERT INTO hon.curriculum_cycles(id,organization_id,school_id,curriculum_id,name,position) VALUES($1,$2,$3,$4,$5,$6)', [id, ids.organization, ids.schoolA, curriculum, name, position]);
  return id;
}
async function saveSettings(curriculum, values) {
  const cols = { display_mode: 'RANK', show_in_app: true, rank_show_earlier: false, rank_show_next: false, cycle_rotation: 'STAFF_PICK', cycle_anchor_date: null, cycle_length_weeks: null, cycle_current_id: null, cycle_current_since: null, cycle_show_next: true, ...values };
  const keys = Object.keys(cols);
  const exists = (await sql('SELECT version FROM hon.curriculum_app_settings WHERE curriculum_id=$1', [curriculum])).rows[0];
  if (exists) await sql(`UPDATE hon.curriculum_app_settings SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')},version=version+1 WHERE curriculum_id=$1`, [curriculum, ...keys.map((k) => cols[k])]);
  else await sql(`INSERT INTO hon.curriculum_app_settings(curriculum_id,organization_id,school_id,${keys.join(',')}) VALUES($1,$2,$3,${keys.map((_, i) => `$${i + 4}`).join(',')})`, [curriculum, ids.organization, ids.schoolA, ...keys.map((k) => cols[k])]);
}
const titles = (section) => section ? section.items.map((i) => i.title) : null;
const sectionOf = (entry, label) => entry.sections.find((s) => s.label === label);
const childOf = (data, name) => data.children.find((c) => c.childDisplayName === `${name} Sample`);
const entryOf = (data, name, curriculumName) => childOf(data, name).curricula.find((e) => e.curriculumName === curriculumName);

let GUARDIAN, OUTSIDER, TWO, MANAGER, NONE, today, mia, leo, other, far;
const k = {}, c = {};
try {
  await cleanup();
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PACR Org','PACR Org'),($2,'PACR Other','PACR Other')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, slug] of [[ids.schoolA, 'a'], [ids.schoolB, 'b']]) await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, ids.organization, `PACR ${slug}`, `pacr-${slug}-${school.slice(0, 8)}`, LA]);
  today = (await sql('SELECT (clock_timestamp() AT TIME ZONE $1)::date::text d', [LA])).rows[0].d;
  const family = randomUUID(), otherFamily = randomUUID(), farFamily = randomUUID();
  await sql("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'Sample Family'),($4,$2,$3,'Other Family'),($5,$2,$6,'Far Family')", [family, ids.organization, ids.schoolA, otherFamily, farFamily, ids.schoolB]);
  k.id = randomUUID(); c.id = randomUUID(); const farCurriculum = randomUUID();
  await sql("INSERT INTO hon.curricula(id,organization_id,school_id,name,model_code,lifecycle) VALUES($1,$2,$3,'Kids Program','LINEAR','PUBLISHED'),($4,$2,$3,'Adult Cycle','ROTATIONAL','PUBLISHED'),($5,$2,$6,'Far Program','LINEAR','PUBLISHED')", [k.id, ids.organization, ids.schoolA, c.id, farCurriculum, ids.schoolB]);
  for (const [name, order, color] of [['White Belt', 1, '#ffffff'], ['Yellow Belt', 2, '#ffd400'], ['Orange Belt', 3, 'orange']]) {
    k[name] = randomUUID();
    await sql('INSERT INTO hon.curriculum_ranks(id,organization_id,school_id,curriculum_id,name,progression_order,display_color) VALUES($1,$2,$3,$4,$5,$6,$7)', [k[name], ids.organization, ids.schoolA, k.id, name, order, color]);
  }
  await resource(k.id, { rank: k['White Belt'], title: 'White form' });
  await resource(k.id, { rank: k['Yellow Belt'], title: 'Yellow form' });
  await resource(k.id, { rank: k['Yellow Belt'], title: 'Yellow staff notes', audience: 'STAFF' });
  await resource(k.id, { rank: k['Yellow Belt'], title: 'Yellow old', status: 'ARCHIVED' });
  await resource(k.id, { rank: k['Orange Belt'], kind: 'DOCUMENT', title: 'Orange handout' });
  await resource(k.id, { kind: 'LINK', title: 'Dojo etiquette' });
  c.c1 = await cycle(c.id, 'Cycle 1: Stances', 1); c.c2 = await cycle(c.id, 'Cycle 2: Kicks', 2); c.c3 = await cycle(c.id, 'Cycle 3: Forms', 3);
  await resource(c.id, { cycle: c.c1, kind: 'DOCUMENT', title: 'Stances sheet' });
  await resource(c.id, { cycle: c.c2, title: 'Kicks video' });
  await resource(c.id, { kind: 'LINK', title: 'Adult safety' });
  GUARDIAN = await human('guardian'); OUTSIDER = await human('outsider'); TWO = await human('two');
  await grant(GUARDIAN, family); await grant(TWO, family); await grant(TWO, otherFamily);
  mia = await child('Mia', family); leo = await child('Leo', family); other = await child('Ola', otherFamily); far = await child('Fay', farFamily, ids.schoolB);
  await enroll(mia, k.id, k['Yellow Belt']); await enroll(leo, c.id); await enroll(other, k.id, k['White Belt']); await enroll(far, farCurriculum, null, ids.schoolB);
  MANAGER = await staffWith('manager', ['curriculum.manage']); NONE = await staffWith('none', ['people.read']);
  await startApp();

  // 1. No settings rows: rank material follows the current rank, a ROTATIONAL curriculum is cycle-based with nothing current.
  let data = (await success(() => parentApp(GUARDIAN), 'parent read')).data;
  ok(data.children.map((x) => x.childDisplayName).join() === 'Leo Sample,Mia Sample', 'both children of the family, no other family');
  let kids = entryOf(data, 'Mia', 'Kids Program');
  ok(kids.mode === 'RANK' && kids.rank.name === 'Yellow Belt' && kids.rank.color === '#ffd400' && kids.cycle === null && kids.next === null, 'rank-based at Yellow');
  ok(JSON.stringify(titles(sectionOf(kids, 'CURRENT'))) === '["Yellow form"]' && JSON.stringify(titles(sectionOf(kids, 'ALL'))) === '["Dojo etiquette"]', 'current rank and whole-curriculum material only');
  ok(!sectionOf(kids, 'REVIEW') && !sectionOf(kids, 'NEXT'), 'no review or next without the switches');
  ok(!JSON.stringify(data).includes('staff notes') && !JSON.stringify(data).includes('Yellow old'), 'staff-only and archived material hidden');
  let adult = entryOf(data, 'Leo', 'Adult Cycle');
  ok(adult.mode === 'CYCLE' && adult.cycle === null && adult.rank === null && JSON.stringify(adult.sections.map((s) => s.label)) === '["ALL"]', 'cycle-based with no settings: whole-curriculum only');
  ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(JSON.stringify(data)), 'no ids anywhere in the parent read');

  // 2. Rank switches: earlier ranks for review and a preview of the next rank.
  await saveSettings(k.id, { rank_show_earlier: true, rank_show_next: true });
  kids = entryOf((await success(() => parentApp(GUARDIAN), 'with rank switches')).data, 'Mia', 'Kids Program');
  ok(JSON.stringify(titles(sectionOf(kids, 'REVIEW'))) === '["White form"]' && JSON.stringify(titles(sectionOf(kids, 'NEXT'))) === '["Orange handout"]' && kids.next.name === 'Orange Belt' && kids.next.startsOn === null, 'review and next rank');

  // 3. The rank changes: the next read shows the new rank's material with no other step.
  // Staff change ranks through the 0070 SET_RANK command (its own proofs); this fixture sets the column directly.
  await sql('BEGIN'); await sql('ALTER TABLE hon.student_curriculum_enrollments DISABLE TRIGGER enrollment_recorded_human_evidence');
  await sql('UPDATE hon.student_curriculum_enrollments SET current_rank_id=$2,version=version+1 WHERE student_profile_id=$1', [mia, k['Orange Belt']]);
  await sql('ALTER TABLE hon.student_curriculum_enrollments ENABLE TRIGGER enrollment_recorded_human_evidence'); await sql('COMMIT');
  kids = entryOf((await success(() => parentApp(GUARDIAN), 'after promotion')).data, 'Mia', 'Kids Program');
  ok(kids.rank.name === 'Orange Belt' && kids.rank.color === null && JSON.stringify(titles(sectionOf(kids, 'CURRENT'))) === '["Orange handout"]', 'new rank material is current');
  ok(JSON.stringify(titles(sectionOf(kids, 'REVIEW'))) === '["Yellow form","White form"]' && kids.next === null && !sectionOf(kids, 'NEXT'), 'review newest rank first; no rank after the last');
  ok(sectionOf(kids, 'CURRENT').items[0].kind === 'DOCUMENT', 'documents reach the app read');

  // 4. Staff pick: the picked cycle, its material, and the next cycle (with no material: name only).
  await saveSettings(c.id, { display_mode: 'CYCLE', cycle_current_id: c.c2, cycle_current_since: today });
  adult = entryOf((await success(() => parentApp(GUARDIAN), 'staff-picked cycle')).data, 'Leo', 'Adult Cycle');
  ok(adult.cycle.name === 'Cycle 2: Kicks' && adult.cycle.startsOn === today && adult.cycle.endsOn === null && adult.cycle.rotation === 'STAFF_PICK', 'current cycle 2 since today');
  ok(JSON.stringify(titles(sectionOf(adult, 'CURRENT'))) === '["Kicks video"]' && adult.next.name === 'Cycle 3: Forms' && !sectionOf(adult, 'NEXT'), 'cycle material; next named without a section');

  // 5. Automatic rotation in school time: anchored 7 days ago weekly -> cycle 2 this week, cycle 3 next week.
  await saveSettings(c.id, { display_mode: 'CYCLE', cycle_rotation: 'AUTO', cycle_anchor_date: (await sql("SELECT ($1::date - 7)::text d", [today])).rows[0].d, cycle_length_weeks: 1 });
  adult = entryOf((await success(() => parentApp(GUARDIAN), 'automatic cycle')).data, 'Leo', 'Adult Cycle');
  ok(adult.cycle.name === 'Cycle 2: Kicks' && adult.cycle.startsOn === today && adult.cycle.rotation === 'AUTO' && adult.next.name === 'Cycle 3: Forms', 'k=1 this week');
  await saveSettings(c.id, { display_mode: 'CYCLE', cycle_rotation: 'AUTO', cycle_anchor_date: (await sql("SELECT ($1::date - 14)::text d", [today])).rows[0].d, cycle_length_weeks: 1 });
  adult = entryOf((await success(() => parentApp(GUARDIAN), 'automatic cycle 3')).data, 'Leo', 'Adult Cycle');
  ok(adult.cycle.name === 'Cycle 3: Forms' && !sectionOf(adult, 'CURRENT') && adult.next.name === 'Cycle 1: Stances' && JSON.stringify(titles(sectionOf(adult, 'NEXT'))) === '["Stances sheet"]', 'wraps: next week is cycle 1 with its material');
  await saveSettings(c.id, { display_mode: 'CYCLE', cycle_rotation: 'AUTO', cycle_anchor_date: (await sql("SELECT ($1::date - 14)::text d", [today])).rows[0].d, cycle_length_weeks: 1, cycle_show_next: false });
  adult = entryOf((await success(() => parentApp(GUARDIAN), 'next hidden')).data, 'Leo', 'Adult Cycle');
  ok(adult.next === null && !sectionOf(adult, 'NEXT'), 'next cycle hidden when switched off');

  // 6. A curriculum hidden from the app disappears for every child in it.
  await saveSettings(k.id, { show_in_app: false });
  ok(childOf((await success(() => parentApp(GUARDIAN), 'hidden curriculum')).data, 'Mia').curricula.length === 0, 'hidden curriculum not shown');
  await saveSettings(k.id, { show_in_app: true });

  // 7. The 0132 library read keeps only rank and whole-curriculum videos and links.
  const legacy = (await success(() => parentLibrary(GUARDIAN), 'older library read')).data.resources.map((r) => r.title).sort();
  ok(JSON.stringify(legacy) === JSON.stringify(['Adult safety', 'Dojo etiquette']), `older read leaves documents and cycle material to the app read (${legacy})`);

  // 8. Staff preview equals what the family sees; boundaries.
  const familyView = (await success(() => parentApp(GUARDIAN), 'parent for comparison')).data;
  const pv = (await success(() => preview(MANAGER, mia), 'staff preview')).data;
  ok(JSON.stringify(pv) === JSON.stringify(childOf(familyView, 'Mia')), 'preview is the parent view of that child');
  await refused(() => preview(NONE, mia), 403, undefined, 'preview without curriculum.manage');
  await refused(() => preview(MANAGER, far), 404, undefined, 'a school-B student through school A');
  await refused(() => preview(MANAGER, randomUUID()), 404, undefined, 'an unknown student');
  await refused(() => parentApp(OUTSIDER), 403, undefined, 'no family grant');
  await refused(() => parentApp(TWO), 403, 'FAMILY_SCOPE_UNAVAILABLE', 'two families and no choice');
  await refused(() => call(GUARDIAN, 'GET', 'parent/curriculum-app?familyId=x'), 400, undefined, 'a family selector');
  await refused(() => call(GUARDIAN, 'GET', 'parent/curriculum-app', { headers: { 'X-Hon-Source': 'AI' } }), 403, undefined, 'an action header');
  await sql("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp() WHERE organization_id=$1", [ids.organization]);
  await refused(() => parentApp(GUARDIAN), 403, undefined, 'no active entitlement');
  await sql("UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1", [ids.organization]);

  // 8b. A long syllabus: every section is capped in SQL at the 200-item contract limit, so the read stays up.
  await sql(`INSERT INTO hon.curriculum_resources(organization_id,school_id,curriculum_id,rank_id,cycle_id,kind,url,title,description,audience,status)
    SELECT $1,$2,$3,$4,NULL,'LINK','https://www.myhonos.com/long-'||g,'White drill '||lpad(g::text,3,'0'),'About drill '||g,'PARENT','ACTIVE' FROM generate_series(1,205) g`,
    [ids.organization, ids.schoolA, k.id, k['White Belt']]);
  await saveSettings(k.id, { rank_show_earlier: true });
  const longKids = entryOf((await success(() => parentApp(GUARDIAN), 'more than 200 review items')).data, 'Mia', 'Kids Program');
  const review = sectionOf(longKids, 'REVIEW').items.map((x) => x.title);
  ok(review.length === 200 && review[0] === 'Yellow form' && review[1] === 'White drill 001' && !review.includes('White form'), `review capped at 200, newest rank first (${review.length})`);
  const longPreview = (await success(() => preview(MANAGER, mia), 'staff preview of a long syllabus')).data;
  ok(JSON.stringify(longPreview) === JSON.stringify(childOf((await success(() => parentApp(GUARDIAN), 'parent long view')).data, 'Mia')), 'long preview still equals the parent view');

  // 9. ACLs and the 011 section.
  const helper = (await sql(`SELECT has_function_privilege($1,'hon.curriculum_app_child_entries(uuid,uuid,uuid)','EXECUTE') r,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) pub FROM pg_proc p WHERE p.oid='hon.curriculum_app_child_entries(uuid,uuid,uuid)'::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE])).rows[0];
  ok(!helper.r && !helper.pub, 'child entries helper is private');
  for (const fn of ['read_parent_curriculum_app(text,uuid)', 'read_staff_parent_app_curriculum_preview(text,uuid)']) ok((await sql("SELECT has_function_privilege($1,$2,'EXECUTE') e", [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0].e, `runtime may execute ${fn}`);
  await assert.rejects(runtime.query('SELECT hon.read_parent_curriculum_app($1,$2)', [GUARDIAN.subject, family]), /FAMILY_FORBIDDEN|42501/); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const section = verify.split('-- Parent app curriculum read exact verification (0610)')[1]?.split('-- End parent app curriculum read exact verification.')[0];
    ok(section, '011 section present');
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: parent app curriculum read (0610): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
