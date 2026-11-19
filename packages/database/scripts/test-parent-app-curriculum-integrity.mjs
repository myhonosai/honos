/**
 * Parent app curriculum proof (0587) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guards + global ValidationPipe
 * + HonExceptionFilter -> StaffParentAppCurriculumController / StaffCurriculumLibraryController -> protected definer functions on the
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
const { StaffParentAppCurriculumController, ParentAppCurriculumHumanUiGuard } = await load('curriculum/parent-app-curriculum.controller.js');
const { ParentAppCurriculumService } = await load('curriculum/parent-app-curriculum.service.js');
const { StaffCurriculumLibraryController, CurriculumLibraryHumanUiGuard } = await load('curriculum/library.controller.js');
const { CurriculumLibraryService } = await load('curriculum/library.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-parent-app-curriculum', secret: randomBytes(32).toString('hex') };
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
    controllers: [StaffParentAppCurriculumController, StaffCurriculumLibraryController],
    providers: [HonIdentityGuard, HonIdentityService, ParentAppCurriculumService, ParentAppCurriculumHumanUiGuard, CurriculumLibraryService, CurriculumLibraryHumanUiGuard,
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

function call(actor, method, path, { body, key = randomUUID(), command = 'parent-app-curriculum', headers = {}, school = actor.school, base = 'parent-app/curriculum' } = {}) {
  const target = new URL(`${origin}/v1/staff/schools/${school}/${base}${path}`);
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
const read = (actor, options = {}) => call(actor, 'GET', '', options);
const post = (actor, path, body, options = {}) => call(actor, 'POST', path, { body, ...options });
const libraryCreate = (actor, body, options = {}) => call(actor, 'POST', '', { body, base: 'curriculum-library', command: 'curriculum-library', ...options });

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

// Disposable-fixture cleanup only (as in the 0567 proof).
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
    const left = (await sql('SELECT count(*)::int n FROM hon.curricula WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]])).rows[0].n;
    if (left) throw new Error('fixture cleanup left curricula behind');
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`pac-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`pac-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`pac-${ids.organization}-%`]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

async function role(org, permissions, code) {
  const id = randomUUID();
  await sql('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)', [id, org, code ?? `STAFF_${id.slice(0, 8)}`]);
  for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [id, org, permission]);
  return id;
}
async function staff(label, roles, { org = ids.organization, school = ids.schoolA } = {}) {
  const user = randomUUID(), principal = randomUUID(), subject = `pac-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Curriculum Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Curriculum Staff')", [principal, user]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  return { subject, principal, grants, org, school };
}
async function curriculum(school, org, name, model) {
  const id = randomUUID();
  await sql("INSERT INTO hon.curricula(id,organization_id,school_id,name,model_code,lifecycle) VALUES($1,$2,$3,$4,$5,'PUBLISHED')", [id, org, school, name, model]);
  return id;
}
async function rank(cur, school, org, name, order, color = null) {
  const id = randomUUID();
  await sql('INSERT INTO hon.curriculum_ranks(id,organization_id,school_id,curriculum_id,name,progression_order,display_color) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, org, school, cur, name, order, color]);
  return id;
}
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const settings = (patch = {}) => ({ expectedVersion: 0, displayMode: 'CYCLE', showInApp: true, rankShowEarlier: false, rankShowNext: false,
  cycleRotation: 'STAFF_PICK', cycleAnchorDate: null, cycleLengthWeeks: null, cycleShowNext: true, ...patch });

let MANAGER, NONE, OTHER_SCHOOL, LIB_ONLY, today, todayKiri;
const cur = {};
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PAC Org','PAC Org'),($2,'PAC Other Org','PAC Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug, zone] of [[ids.schoolA, ids.organization, 'a', LA], [ids.schoolB, ids.organization, 'b', KIRITIMATI], [ids.otherSchool, ids.otherOrganization, 'o', LA]]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `PAC ${slug}`, `pac-${slug}-${school.slice(0, 8)}`, zone]);
  }
  today = (await sql('SELECT (clock_timestamp() AT TIME ZONE $1)::date::text d', [LA])).rows[0].d;
  todayKiri = (await sql('SELECT (clock_timestamp() AT TIME ZONE $1)::date::text d', [KIRITIMATI])).rows[0].d;
  cur.kids = await curriculum(ids.schoolA, ids.organization, 'Kids Program', 'LINEAR');
  cur.white = await rank(cur.kids, ids.schoolA, ids.organization, 'White Belt', 1, '#ffffff');
  cur.yellow = await rank(cur.kids, ids.schoolA, ids.organization, 'Yellow Belt', 2, 'yellow');
  cur.adult = await curriculum(ids.schoolA, ids.organization, 'Adult Cycle', 'ROTATIONAL');
  cur.second = await curriculum(ids.schoolA, ids.organization, 'Second Cycle', 'ROTATIONAL');
  cur.b = await curriculum(ids.schoolB, ids.organization, 'Island Cycle', 'ROTATIONAL');
  cur.other = await curriculum(ids.otherSchool, ids.otherOrganization, 'Other Cycle', 'ROTATIONAL');
  MANAGER = await staff('manager', [await role(ids.organization, ['curriculum.manage'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read', 'curriculum.progress.record'])]);
  OTHER_SCHOOL = await staff('other-school', [await role(ids.organization, ['curriculum.manage'])], { school: ids.schoolB });
  LIB_ONLY = await staff('lib', [await role(ids.organization, ['curriculum.manage'])]);
}
const curriculumOf = (data, id) => data.curricula.find((c) => c.id === id);

try {
  await cleanup();
  await seed();
  await startApp();

  // 1. The staff read: every own-school curriculum with ranks, defaults (no settings row = the 0132 behavior) and no other school.
  let view = (await success(() => read(MANAGER), 'staff read')).data;
  ok(view.timeZone === LA && view.curricula.length === 3, 'own school only, with its time zone');
  ok(!view.curricula.some((c) => c.id === cur.b || c.id === cur.other), 'no school-B or other-organization curriculum');
  const kids = curriculumOf(view, cur.kids);
  ok(kids.app.settings.saved === false && kids.app.settings.version === 0 && kids.app.settings.displayMode === 'RANK' && kids.app.settings.showInApp === true, 'LINEAR defaults to rank-based, shown');
  ok(curriculumOf(view, cur.adult).app.settings.displayMode === 'CYCLE', 'ROTATIONAL defaults to cycle-based');
  ok(JSON.stringify(kids.ranks.map((r) => [r.name, r.color, r.order])) === JSON.stringify([['White Belt', '#ffffff', 1], ['Yellow Belt', null, 2]]), 'ranks in order, unsafe color dropped');
  ok(kids.app.cycleState.today === today && kids.app.cycleState.current === null, 'school-local today, nothing current');
  await refused(() => read(NONE), 403, undefined, 'read without curriculum.manage');
  await refused(() => read(OTHER_SCHOOL, { school: ids.schoolA }), 403, undefined, 'school-B staff at the school-A route');
  await refused(() => call(MANAGER, 'GET', '?school=x'), 400, undefined, 'a query selector');
  { const b = (await success(() => read(OTHER_SCHOOL), 'school-B read')).data;
    ok(b.timeZone === KIRITIMATI && b.curricula.length === 1 && curriculumOf(b, cur.b).app.cycleState.today === todayKiri, 'school-B today follows its own time zone'); }

  // 2. Cycles: create in order, closed names, case-insensitive duplicates refused, other-school curricula unknown.
  const cycles = [];
  for (const name of ['Cycle 1: Stances', 'Cycle 2: Kicks', 'Cycle 3: Forms']) {
    const made = await success(() => post(MANAGER, `/${cur.adult}/cycles`, { name }), `create ${name}`);
    cycles.push(made.data.cycles.at(-1));
  }
  ok(cycles.map((c) => c.position).join() === '1,2,3' && cycles.every((c) => c.version === 1), 'positions 1..3');
  await refused(() => post(MANAGER, `/${cur.adult}/cycles`, { name: 'cycle 2: KICKS' }), 409, 'CYCLE_NAME_TAKEN', 'duplicate name, other case');
  for (const [label, body] of [['angle brackets', { name: 'Cycle <b>' }], ['padded', { name: ' Cycle' }], ['empty', { name: '' }], ['too long', { name: 'x'.repeat(81) }], ['extra key', { name: 'Ok', position: 1 }], ['number', { name: 4 }]]) {
    await refused(() => post(MANAGER, `/${cur.adult}/cycles`, body), 400, undefined, `cycle name: ${label}`);
  }
  await refused(() => post(MANAGER, `/${cur.other}/cycles`, { name: 'Sneak' }), 404, undefined, 'another organization curriculum');
  await refused(() => post(MANAGER, `/${cur.b}/cycles`, { name: 'Sneak' }), 404, undefined, 'a school-B curriculum through school A');
  await refused(() => post(NONE, `/${cur.adult}/cycles`, { name: 'Nope' }), 403, undefined, 'create without curriculum.manage');
  await refused(() => post(MANAGER, `/${cur.adult}/cycles`, { name: 'Nope' }, { command: 'curriculum-library' }), 403, 'HUMAN_UI_REQUIRED', 'wrong human command');
  await refused(() => post(MANAGER, `/${cur.adult}/cycles`, { name: 'Nope' }, { headers: { Origin: 'https://attacker.invalid' } }), 403, 'HUMAN_UI_REQUIRED', 'foreign origin');
  await refused(() => post(MANAGER, `/${cur.adult}/cycles`, { name: 'Nope' }, { key: null }), 400, 'IDEMPOTENCY_KEY_REQUIRED', 'no idempotency key');

  // 3. Settings: closed validation, create at version 0, replay, key reuse, stale version, AUTO needs a start date and weeks.
  for (const [label, patch] of [['AUTO without date', { cycleRotation: 'AUTO', cycleLengthWeeks: 2 }], ['AUTO without weeks', { cycleRotation: 'AUTO', cycleAnchorDate: today }],
    ['impossible date', { cycleRotation: 'AUTO', cycleAnchorDate: '2026-02-30', cycleLengthWeeks: 2 }], ['27 weeks', { cycleLengthWeeks: 27 }], ['0 weeks', { cycleLengthWeeks: 0 }],
    ['unknown mode', { displayMode: 'BELT' }], ['string flag', { showInApp: 'yes' }], ['extra key', { cycleCurrentId: cycles[0].id }], ['negative version', { expectedVersion: -1 }]]) {
    await refused(() => post(MANAGER, `/${cur.adult}/settings`, settings(patch)), 400, undefined, `settings validation: ${label}`);
  }
  { const body = settings(); delete body.cycleShowNext; await refused(() => post(MANAGER, `/${cur.adult}/settings`, body), 400, undefined, 'settings missing a key'); }
  await refused(() => post(MANAGER, `/${cur.adult}/settings`, settings({ expectedVersion: 1 })), 409, undefined, 'first save must expect version 0');
  const firstKey = randomUUID();
  let state = (await success(() => post(MANAGER, `/${cur.adult}/settings`, settings(), { key: firstKey }), 'first settings save')).data;
  ok(state.settings.saved && state.settings.version === 1 && state.settings.cycleRotation === 'STAFF_PICK', 'saved at version 1');
  ok(state.cycleState.current?.id === cycles[0].id && state.cycleState.current.startsOn === today && state.cycleState.current.endsOn === null, 'staff pick starts on the first cycle today');
  ok(state.cycleState.next?.id === cycles[1].id && state.cycleState.next.startsOn === null, 'next is cycle 2 with no date');
  const replay = await success(() => post(MANAGER, `/${cur.adult}/settings`, settings(), { key: firstKey }), 'settings replay');
  ok(replay.meta.replayed === true && JSON.stringify(replay.data) === JSON.stringify(state), 'exact replay');
  await refused(() => post(MANAGER, `/${cur.adult}/settings`, settings({ showInApp: false }), { key: firstKey }), 409, undefined, 'key reused for another body');
  await refused(() => post(MANAGER, `/${cur.adult}/settings`, settings()), 409, undefined, 'stale version 0 after the first save');

  // 4. Staff pick: switch now (wraps to the first cycle as next), archive refuses the current cycle.
  state = (await success(() => post(MANAGER, `/${cur.adult}/cycles/${cycles[2].id}/switch`, { expectedVersion: 1 }), 'switch to cycle 3')).data;
  ok(state.settings.version === 2 && state.cycleState.current.id === cycles[2].id && state.cycleState.current.startsOn === today && state.cycleState.next.id === cycles[0].id, 'cycle 3 now, cycle 1 next');
  await refused(() => post(MANAGER, `/${cur.adult}/cycles/${cycles[1].id}/switch`, { expectedVersion: 1 }), 409, undefined, 'switch with a stale settings version');
  await refused(() => post(MANAGER, `/${cur.second}/cycles/${cycles[1].id}/switch`, { expectedVersion: 1 }), 404, undefined, 'a cycle of another curriculum');
  await refused(() => post(MANAGER, `/${cur.adult}/cycles/${cycles[2].id}/archive`, { expectedVersion: 1 }), 409, 'CYCLE_IS_CURRENT', 'archive the current staff-picked cycle');
  { const s2 = await success(() => post(MANAGER, `/${cur.second}/cycles`, { name: 'Only' }), 'cycle on a curriculum with no settings');
    await refused(() => post(MANAGER, `/${cur.second}/cycles/${s2.data.cycles[0].id}/switch`, { expectedVersion: 1 }), 409, 'SETTINGS_REQUIRED', 'switch before settings are saved'); }

  // 5. Rename and archive with versions; archived cycles leave the rotation and are final.
  state = (await success(() => post(MANAGER, `/${cur.adult}/cycles/${cycles[1].id}/versions`, { expectedVersion: 1, name: 'Cycle 2: Kicks and Blocks' }), 'rename cycle 2')).data;
  ok(state.cycles.find((c) => c.id === cycles[1].id).version === 2 && state.cycles.find((c) => c.id === cycles[1].id).name === 'Cycle 2: Kicks and Blocks', 'renamed at version 2');
  await refused(() => post(MANAGER, `/${cur.adult}/cycles/${cycles[1].id}/versions`, { expectedVersion: 1, name: 'Again' }), 409, undefined, 'rename with a stale version');
  await refused(() => post(MANAGER, `/${cur.adult}/cycles/${cycles[1].id}/versions`, { expectedVersion: 2, name: 'Cycle 1: stances' }), 409, 'CYCLE_NAME_TAKEN', 'rename onto another name');
  const fourth = (await success(() => post(MANAGER, `/${cur.adult}/cycles`, { name: 'Cycle 4: Sparring' }), 'cycle 4')).data.cycles.at(-1);
  ok(fourth.position === 4, 'cycle 4 at position 4');
  state = (await success(() => post(MANAGER, `/${cur.adult}/cycles/${fourth.id}/archive`, { expectedVersion: 1 }), 'archive cycle 4')).data;
  ok(state.cycles.length === 3 && !state.cycles.some((c) => c.id === fourth.id), 'archived cycle leaves the list');
  await refused(() => post(MANAGER, `/${cur.adult}/cycles/${fourth.id}/versions`, { expectedVersion: 2, name: 'Back' }), 409, undefined, 'an archived cycle is final');
  await assert.rejects(sql('UPDATE hon.curriculum_cycles SET status=$2 WHERE id=$1', [fourth.id, 'ACTIVE']), /IMMUTABLE_CYCLE/); checks += 1;
  await assert.rejects(sql('DELETE FROM hon.curriculum_cycles WHERE id=$1', [cycles[0].id]), /IMMUTABLE_CYCLE/); checks += 1;
  await assert.rejects(sql('UPDATE hon.curriculum_cycles SET curriculum_id=$2 WHERE id=$1', [cycles[0].id, cur.second]), /IMMUTABLE_CYCLE_IDENTITY/); checks += 1;

  // 6. Order: the exact active list only; reversed order is stored and the staff pick keeps its cycle.
  const reversed = [cycles[2].id, cycles[1].id, cycles[0].id];
  await refused(() => post(MANAGER, `/${cur.adult}/cycle-order`, { cycleIds: [...reversed, fourth.id] }), 409, undefined, 'order naming an archived cycle');
  await refused(() => post(MANAGER, `/${cur.adult}/cycle-order`, { cycleIds: reversed.slice(0, 2) }), 409, undefined, 'order missing a cycle');
  await refused(() => post(MANAGER, `/${cur.adult}/cycle-order`, { cycleIds: [reversed[0], reversed[0], reversed[1]] }), 400, undefined, 'order with a repeat');
  state = (await success(() => post(MANAGER, `/${cur.adult}/cycle-order`, { cycleIds: reversed }), 'reverse the order')).data;
  ok(state.cycles.map((c) => c.id).join() === reversed.join() && state.cycles.map((c) => c.position).join() === '1,2,3', 'reversed and renumbered');
  ok(state.cycleState.current.id === cycles[2].id && state.cycleState.next.id === cycles[1].id, 'staff pick kept; next follows the new order');

  // 7. Automatic rotation from the anchor date in school time: before the start, inside a cycle, wrap-around, switch now, back to staff pick.
  // Order is now [c3, c2, c1]. Weekly cycles anchored 15 days ago: k=2 -> the third (c1), from today-1 to today+5, next c3.
  state = (await success(() => post(MANAGER, `/${cur.adult}/settings`, settings({ expectedVersion: 2, cycleRotation: 'AUTO', cycleAnchorDate: addDays(today, -15), cycleLengthWeeks: 1 })), 'AUTO weekly')).data;
  ok(state.cycleState.current.id === cycles[0].id && state.cycleState.current.startsOn === addDays(today, -1) && state.cycleState.current.endsOn === addDays(today, 5), 'k=2: third cycle, its week');
  ok(state.cycleState.next.id === cycles[2].id && state.cycleState.next.startsOn === addDays(today, 6), 'wraps to the first cycle next week');
  state = (await success(() => post(MANAGER, `/${cur.adult}/settings`, settings({ expectedVersion: 3, cycleRotation: 'AUTO', cycleAnchorDate: addDays(today, -22), cycleLengthWeeks: 1 })), 'AUTO k=3')).data;
  ok(state.cycleState.current.id === cycles[2].id && state.cycleState.current.startsOn === addDays(today, -1), 'k=3 wraps to the first cycle');
  state = (await success(() => post(MANAGER, `/${cur.adult}/settings`, settings({ expectedVersion: 4, cycleRotation: 'AUTO', cycleAnchorDate: today, cycleLengthWeeks: 2 })), 'AUTO from today')).data;
  ok(state.cycleState.current.id === cycles[2].id && state.cycleState.current.startsOn === today && state.cycleState.current.endsOn === addDays(today, 13), 'first day of a two-week cycle');
  state = (await success(() => post(MANAGER, `/${cur.adult}/settings`, settings({ expectedVersion: 5, cycleRotation: 'AUTO', cycleAnchorDate: addDays(today, 3), cycleLengthWeeks: 2 })), 'AUTO starts later')).data;
  ok(state.cycleState.current === null && state.cycleState.next.id === cycles[2].id && state.cycleState.next.startsOn === addDays(today, 3), 'before the start nothing is current');
  state = (await success(() => post(MANAGER, `/${cur.adult}/settings`, settings({ expectedVersion: 6, cycleRotation: 'AUTO', cycleAnchorDate: addDays(today, -13), cycleLengthWeeks: 2 })), 'AUTO last day')).data;
  ok(state.cycleState.current.id === cycles[2].id && state.cycleState.current.endsOn === today, 'last day of the first cycle');
  state = (await success(() => post(MANAGER, `/${cur.adult}/cycles/${cycles[1].id}/switch`, { expectedVersion: 7 }), 'switch now while automatic')).data;
  ok(state.settings.cycleRotation === 'AUTO' && state.settings.cycleAnchorDate === addDays(today, -14), 're-anchored one cycle back');
  ok(state.cycleState.current.id === cycles[1].id && state.cycleState.current.startsOn === today && state.cycleState.current.endsOn === addDays(today, 13) && state.cycleState.next.id === cycles[0].id, 'picked cycle starts today and the rotation continues');
  state = (await success(() => post(MANAGER, `/${cur.adult}/cycles/${cycles[2].id}/archive`, { expectedVersion: 1 }), 'archive a cycle while automatic')).data;
  ok(state.cycles.length === 2 && state.cycleState.current !== null, 'automatic rotation continues over the remaining cycles');
  ok(state.cycles.map((x) => x.position).join() === '1,2', 'archive renumbers the remaining cycles 1..n');
  { let churn = state; // Many creates and archives keep positions small, so a reorder still fits the 1..2000 CHECK (review P3).
    for (let n = 0; n < 6; n += 1) {
      churn = (await success(() => post(MANAGER, `/${cur.adult}/cycles`, { name: `Churn ${n}` }), `churn create ${n}`)).data;
      const made = churn.cycles.at(-1);
      churn = (await success(() => post(MANAGER, `/${cur.adult}/cycles/${made.id}/archive`, { expectedVersion: 1 }), `churn archive ${n}`)).data;
    }
    ok(Math.max(...churn.cycles.map((x) => x.position)) === 2, 'positions never grow past the active count');
    churn = (await success(() => post(MANAGER, `/${cur.adult}/cycle-order`, { cycleIds: churn.cycles.map((x) => x.id).reverse() }), 'reorder after churn')).data;
    state = (await success(() => post(MANAGER, `/${cur.adult}/cycle-order`, { cycleIds: churn.cycles.map((x) => x.id).reverse() }), 'restore order')).data; }
  state = (await success(() => post(MANAGER, `/${cur.adult}/settings`, settings({ expectedVersion: 8, cycleAnchorDate: state.settings.cycleAnchorDate, cycleLengthWeeks: 2 })), 'back to staff pick')).data;
  const keptId = state.cycleState.current.id;
  ok(state.settings.cycleRotation === 'STAFF_PICK' && state.cycleState.current.startsOn === today && state.cycles.some((c) => c.id === keptId), 'leaving automatic keeps the cycle families see today');

  // 8. Concurrency: two saves on the same version, exactly one wins.
  const racers = await Promise.all([0, 1].map((n) => post(MANAGER, `/${cur.adult}/settings`, settings({ expectedVersion: 9, rankShowNext: n === 0 }))));
  ok(racers.filter((r) => r.status === 200).length === 1 && racers.filter((r) => r.status === 409).length === 1, 'one concurrent save wins');

  // 9. Material: DOCUMENT kind and a cycle through the library command; at most one of rank and cycle; same curriculum, active cycle only.
  const doc = { expectedVersion: 0, curriculumId: cur.adult, rankId: null, cycleId: cycles[1].id, kind: 'DOCUMENT', url: 'https://drive.google.com/file/d/abc/view', title: 'Kicks handout', description: 'Print and practice.', audience: 'PARENT' };
  const madeDoc = await success(() => libraryCreate(MANAGER, doc), 'document on a cycle');
  ok(madeDoc.data.kind === 'DOCUMENT' && madeDoc.data.cycleId === cycles[1].id && madeDoc.data.rankId === null, 'document stored on the cycle');
  const legacy = { expectedVersion: 0, curriculumId: cur.kids, rankId: cur.yellow, kind: 'VIDEO', url: 'https://www.youtube.com/watch?v=yellow', title: 'Yellow form', description: '', audience: 'PARENT' };
  ok((await success(() => libraryCreate(MANAGER, legacy), 'older client without cycleId')).data.cycleId === null, 'older clients still create rank material');
  await refused(() => libraryCreate(MANAGER, { ...doc, rankId: cur.yellow }), 400, undefined, 'rank and cycle together');
  await refused(() => libraryCreate(MANAGER, { ...doc, curriculumId: cur.second }), 400, undefined, 'a cycle of another curriculum');
  await refused(() => libraryCreate(MANAGER, { ...doc, cycleId: cycles[2].id }), 400, undefined, 'an archived cycle');
  await refused(() => libraryCreate(MANAGER, { ...doc, kind: 'PDF' }), 400, undefined, 'unknown kind');
  await assert.rejects(sql('UPDATE hon.curriculum_resources SET cycle_id=NULL,version=version+1 WHERE id=$1', [madeDoc.data.id]), /IMMUTABLE_RESOURCE_IDENTITY/); checks += 1;
  await assert.rejects(sql('INSERT INTO hon.curriculum_resources(organization_id,school_id,curriculum_id,rank_id,cycle_id,kind,url,title,description,audience) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [ids.organization, ids.schoolA, cur.kids, cur.yellow, cycles[1].id, 'LINK', 'https://www.myhonos.com/x', 'Both', '', 'PARENT']), /curriculum_resources_(rank_or_cycle|cycle_fk)/); checks += 1;
  view = (await success(() => read(MANAGER), 'staff read after material')).data;
  ok(curriculumOf(view, cur.adult).resources.some((r) => r.id === madeDoc.data.id && r.cycleId === cycles[1].id), 'staff read lists cycle material');
  ok(curriculumOf(view, cur.kids).resources.length === 1 && curriculumOf(view, cur.kids).resources[0].rankId === cur.yellow, 'rank material under its own curriculum');

  // 10. Live authority: a revoked grant refuses the next command; history, audit, receipts and private tables.
  await sql('UPDATE hon.principal_role_grants SET effective_until=clock_timestamp() WHERE id=$1', [LIB_ONLY.grants[0]]);
  await refused(() => post(LIB_ONLY, `/${cur.adult}/cycles`, { name: 'Late' }), 403, undefined, 'revoked grant');
  const events = (await sql('SELECT operation, count(*)::int n FROM hon.curriculum_app_events WHERE organization_id=$1 GROUP BY 1 ORDER BY 1', [ids.organization])).rows;
  ok(events.find((e) => e.operation === 'CYCLE_CREATE').n === 11 && events.find((e) => e.operation === 'SWITCH_CYCLE').n === 2 && events.find((e) => e.operation === 'CYCLE_ORDER').n === 3, 'one history row per command, none for refusals or replays');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE organization_id=$1 AND action_code LIKE 'curriculum.parent_app.%' AND source='HUMAN_UI' AND entity_type='CURRICULUM'", [ids.organization])).rows[0].n
    === (await sql('SELECT count(*)::int n FROM hon.curriculum_app_events WHERE organization_id=$1', [ids.organization])).rows[0].n, 'one audit row per command');
  await assert.rejects(sql('UPDATE hon.curriculum_app_events SET operation=operation WHERE organization_id=$1', [ids.organization]), /immutable|IMMUTABLE|42501/i); checks += 1;
  await assert.rejects(sql('DELETE FROM hon.curriculum_app_requests WHERE organization_id=$1', [ids.organization]), /immutable|IMMUTABLE|42501/i); checks += 1;
  await assert.rejects(sql('DELETE FROM hon.curriculum_app_settings WHERE curriculum_id=$1', [cur.adult]), /IMMUTABLE_APP_SETTINGS/); checks += 1;
  for (const table of ['curriculum_cycles', 'curriculum_app_settings', 'curriculum_app_events', 'curriculum_app_requests']) {
    await assert.rejects(runtime.query(`SELECT * FROM hon.${table} LIMIT 1`), /permission denied/); checks += 1;
  }
  await assert.rejects(runtime.query('SELECT cycle_id FROM hon.curriculum_resources LIMIT 1'), /permission denied/); checks += 1;
  for (const fn of ['curriculum_app_name_ok(text,integer)', 'guard_curriculum_cycle()', 'guard_curriculum_app_settings()', 'curriculum_app_cycle_state(uuid,uuid,uuid)', 'curriculum_app_projection(uuid,uuid,uuid)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!r.runtime && !r.public, `helper ${fn} is private`);
  }
  for (const fn of ['read_staff_parent_app_curriculum(text)', 'mutate_parent_app_curriculum(text,text,uuid,uuid,jsonb,text,uuid,uuid)']) {
    ok((await sql("SELECT has_function_privilege($1,$2,'EXECUTE') e", [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0].e, `runtime may execute ${fn}`);
  }
  await assert.rejects(runtime.query('SELECT hon.read_staff_parent_app_curriculum($1)', [MANAGER.subject]), /HUMAN_COMMAND_REQUIRED|FORBIDDEN|42501/); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    for (const [startMark, endMark] of [['-- Parent app curriculum exact verification (0587)', '-- End parent app curriculum exact verification.']]) {
      const section = verify.split(startMark)[1]?.split(endMark)[0];
      ok(section, startMark);
      await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1;
    } }

  console.log(`PASS: parent app curriculum (0587): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
