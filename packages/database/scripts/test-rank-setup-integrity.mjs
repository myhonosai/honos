/**
 * Rank setup proof (0622) over signed HTTP (HON session cookie -> HonIdentityGuard + RankSetupHumanUiGuard + global ValidationPipe
 * + HonExceptionFilter -> StaffRankSetupController -> protected definer functions on the restricted runtime role with forced RLS),
 * on the guarded disposable CRM-close fixture only. Synthetic names only; nothing contacts anyone.
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
const { StaffRankSetupController, RankSetupHumanUiGuard } = await load('curriculum/rank-setup.controller.js');
const { RankSetupService } = await load('curriculum/rank-setup.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-rank-setup', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool', 'family'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [StaffRankSetupController],
    providers: [HonIdentityGuard, HonIdentityService, RankSetupService, RankSetupHumanUiGuard, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}

function call(actor, method, path, { body, key = randomUUID(), command = 'rank-setup', headers = {}, school = actor.school, query = '' } = {}) {
  const target = new URL(`${origin}/v1/staff/schools/${school}/rank-setup${path}${query}`);
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

// Disposable-fixture cleanup only (as in the 0605 proof).
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
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`rks-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`rks-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`rks-${ids.organization}-%`]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

async function role(org, permissions) {
  const id = randomUUID();
  await sql('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)', [id, org, `STAFF_${id.slice(0, 8)}`]);
  for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [id, org, permission]);
  return id;
}
async function staff(label, roles, { org = ids.organization, school = ids.schoolA } = {}) {
  const user = randomUUID(), principal = randomUUID(), subject = `rks-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Rank Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Rank Staff')", [principal, user]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  return { subject, principal, grants, org, school };
}
async function student(given, family, status = 'ACTIVE') {
  const personId = randomUUID(), profile = randomUUID();
  await sql('INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4,$5)', [personId, ids.organization, ids.schoolA, given, family]);
  await sql("INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id,primary_family_id,status) VALUES($1,$2,$3,$4,$5,$6)", [profile, ids.organization, ids.schoolA, personId, ids.family, status]);
  return profile;
}
const enroll = async (profile, curriculum, rank = null) => (await sql('INSERT INTO hon.student_curriculum_enrollments(organization_id,school_id,student_profile_id,curriculum_id,current_rank_id) VALUES($1,$2,$3,$4,$5) RETURNING id', [ids.organization, ids.schoolA, profile, curriculum, rank])).rows[0].id;

let OWNER, MANAGER_ONLY, RECORDER_ONLY, OTHER_SCHOOL;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'RKS Org','RKS Org'),($2,'RKS Other Org','RKS Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,'America/Los_Angeles')", [school, org, `RKS ${slug}`, `rks-${slug}-${school.slice(0, 8)}`]);
  }
  await sql("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'Sample Family')", [ids.family, ids.organization, ids.schoolA]);
  OWNER = await staff('owner', [await role(ids.organization, ['curriculum.manage', 'curriculum.progress.record'])]);
  MANAGER_ONLY = await staff('manager', [await role(ids.organization, ['curriculum.manage'])]);
  RECORDER_ONLY = await staff('recorder', [await role(ids.organization, ['curriculum.progress.record'])]);
  OTHER_SCHOOL = await staff('other-school', [await role(ids.organization, ['curriculum.manage', 'curriculum.progress.record'])], { school: ids.schoolB });
}

try {
  await cleanup();
  await seed();
  await startApp();

  // 1. Empty school: no programs; the student list is present for someone who may record progress, null for a belt-setup-only person.
  let view = (await success(() => read(OWNER), 'empty read')).data;
  ok(view.programs.length === 0 && Array.isArray(view.students) && view.students.length === 0, 'empty school lists nothing');
  ok((await success(() => read(MANAGER_ONLY), 'manager read')).data.students === null, 'student names need curriculum.progress.record');
  await refused(() => read(RECORDER_ONLY), 403, undefined, 'progress-only person cannot open rank setup');

  // 2. Create a program; exact replay; key reuse; duplicate name (case-insensitive); bad names.
  const createKey = randomUUID();
  const kids = (await success(() => post(OWNER, '/programs', { name: 'Kids Taekwondo' }, { key: createKey }), 'create program')).data;
  ok(kids.name === 'Kids Taekwondo' && kids.version === 1 && kids.ranks.length === 0, 'new program has no belts');
  const replay = await success(() => post(OWNER, '/programs', { name: 'Kids Taekwondo' }, { key: createKey }), 'replay create');
  ok(replay.meta.replayed === true && replay.data.id === kids.id, 'exact replay returns the same program');
  await refused(() => post(OWNER, '/programs', { name: 'Adults' }, { key: createKey }), 409, 'IDEMPOTENCY_KEY_REUSED', 'key reuse with another body');
  await refused(() => post(OWNER, '/programs', { name: 'kids taekwondo' }), 409, 'PROGRAM_NAME_TAKEN', 'duplicate program name');
  for (const name of ['', ' Padded', '<b>x</b>', 'Tab\tName', 'x'.repeat(121)]) await refused(() => post(OWNER, '/programs', { name }), 400, 'VALIDATION_FAILED', `bad name ${JSON.stringify(name).slice(0, 20)}`);
  await refused(() => post(OWNER, '/programs', { name: 'Extra', modelCode: 'LINEAR' }), 400, undefined, 'unknown field');
  const row = (await sql('SELECT model_code, lifecycle::text FROM hon.curricula WHERE id=$1', [kids.id])).rows[0];
  ok(row.model_code === 'LINEAR' && row.lifecycle === 'PUBLISHED', 'program stored as a linear published curriculum');

  // 3. Belts: add in order with colors, duplicate names, bad colors.
  let program = kids;
  for (const [name, color] of [['White', '#ffffff'], ['Yellow', '#FACC15'], ['Green', null], ['Blue', '#2563eb']]) {
    program = (await success(() => post(OWNER, `/programs/${kids.id}/ranks`, { name, color }), `add ${name}`)).data;
  }
  ok(program.ranks.map((k) => k.name).join(',') === 'White,Yellow,Green,Blue', 'belts appended in order');
  ok(program.ranks.map((k) => k.order).join(',') === '1,2,3,4', 'orders 1..n');
  ok(program.ranks[0].color === '#FFFFFF' && program.ranks[2].color === null, 'colors stored as #RRGGBB or none');
  await refused(() => post(OWNER, `/programs/${kids.id}/ranks`, { name: 'WHITE', color: null }), 409, 'RANK_NAME_TAKEN', 'duplicate belt name');
  for (const color of ['white', '#fff', '#12345g', 'url(x)']) await refused(() => post(OWNER, `/programs/${kids.id}/ranks`, { name: 'Odd', color }), 400, 'VALIDATION_FAILED', `bad color ${color}`);
  await refused(() => post(OWNER, `/programs/${kids.id}/ranks`, { name: 'No color' }), 400, 'VALIDATION_FAILED', 'color is required (null allowed)');

  // 4. Edit a belt with its version; stale version conflicts.
  const [white, yellow, green, blue] = program.ranks;
  program = (await success(() => post(OWNER, `/programs/${kids.id}/ranks/${green.id}/versions`, { expectedVersion: 1, name: 'Orange', color: '#F97316' }), 'edit belt')).data;
  const orange = program.ranks.find((k) => k.id === green.id);
  ok(orange.name === 'Orange' && orange.color === '#F97316' && orange.version === 2, 'belt renamed and recolored');
  await refused(() => post(OWNER, `/programs/${kids.id}/ranks/${green.id}/versions`, { expectedVersion: 1, name: 'Green', color: null }), 409, 'VERSION_CONFLICT', 'stale belt version');
  await refused(() => post(OWNER, `/programs/${kids.id}/ranks/${green.id}/versions`, { expectedVersion: 2, name: 'Blue', color: null }), 409, 'RANK_NAME_TAKEN', 'rename to another belt name');

  // 5. Move belts; the first cannot move up, the last cannot move down; both moved belts bump their version.
  program = (await success(() => post(OWNER, `/programs/${kids.id}/ranks/${blue.id}/move`, { expectedVersion: 1, direction: 'UP' }), 'move up')).data;
  ok(program.ranks.map((k) => k.name).join(',') === 'White,Yellow,Blue,Orange', 'blue moved above orange');
  ok(program.ranks.map((k) => k.order).join(',') === '1,2,3,4', 'orders stay 1..n after a move');
  ok(program.ranks.find((k) => k.id === blue.id).version === 2 && program.ranks.find((k) => k.id === green.id).version === 3, 'both belts in a swap bump their version');
  await refused(() => post(OWNER, `/programs/${kids.id}/ranks/${white.id}/move`, { expectedVersion: 1, direction: 'UP' }), 409, 'RANK_AT_END', 'first belt cannot move up');
  await refused(() => post(OWNER, `/programs/${kids.id}/ranks/${green.id}/move`, { expectedVersion: 3, direction: 'DOWN' }), 409, 'RANK_AT_END', 'last belt cannot move down');
  await refused(() => post(OWNER, `/programs/${kids.id}/ranks/${blue.id}/move`, { expectedVersion: 1, direction: 'DOWN' }), 409, 'VERSION_CONFLICT', 'stale move');
  await refused(() => post(OWNER, `/programs/${kids.id}/ranks/${blue.id}/move`, { expectedVersion: 2, direction: 'LEFT' }), 400, 'VALIDATION_FAILED', 'bad direction');

  // 6. Rename the program with its version.
  program = (await success(() => post(OWNER, `/programs/${kids.id}/versions`, { expectedVersion: 1, name: 'Little Dragons' }), 'rename program')).data;
  ok(program.name === 'Little Dragons' && program.version === 2, 'program renamed');
  await refused(() => post(OWNER, `/programs/${kids.id}/versions`, { expectedVersion: 1, name: 'Again' }), 409, 'VERSION_CONFLICT', 'stale program version');

  // 7. Students: names and current belt for a person who records progress; counts per belt; inactive students hidden.
  const ana = await student('Ana', 'Sample'), ben = await student('Ben', 'Sample'), gone = await student('Gone', 'Sample', 'ARCHIVED');
  await enroll(ana, kids.id, white.id); await enroll(ben, kids.id, null); await enroll(gone, kids.id, white.id);
  view = (await success(() => read(OWNER), 'read with students')).data;
  const listed = view.students.filter((s) => s.programId === kids.id);
  ok(listed.length === 2 && listed.map((s) => s.givenName).join(',') === 'Ana,Ben', 'active students listed by name, inactive hidden');
  ok(listed.find((s) => s.givenName === 'Ana').currentRankId === white.id && listed.find((s) => s.givenName === 'Ben').currentRankId === null, 'current belt or none');
  ok(view.programs[0].ranks.find((k) => k.id === white.id).students === 1, 'belt count counts active students only');
  ok((await success(() => read(MANAGER_ONLY), 'manager read again')).data.students === null, 'still no names without curriculum.progress.record');

  // 8. Requirements made through the 0070 command appear under their belt.
  await sql("INSERT INTO hon.curriculum_requirements(organization_id,school_id,curriculum_rank_id,requirement_code,requirement_kind,definition,is_required) VALUES($1,$2,$3,'FRONT_KICK','TECHNIQUE','{\"label\":\"Front kick <b>\",\"description\":\"Both legs\"}',true)", [ids.organization, ids.schoolA, white.id]);
  const shown = (await success(() => read(OWNER), 'read requirements')).data.programs[0].ranks.find((k) => k.id === white.id).requirements;
  ok(shown.length === 1 && shown[0].label === 'Front kick b' && shown[0].kind === 'TECHNIQUE' && shown[0].required === true, 'requirements listed with label text only');

  // 9. Isolation: another school of the same organization and another organization see none of it; foreign ids are not found.
  const otherView = (await success(() => read(OTHER_SCHOOL), 'other school read')).data;
  ok(otherView.programs.length === 0 && otherView.students.length === 0, 'other school sees nothing');
  await refused(() => post(OTHER_SCHOOL, `/programs/${kids.id}/ranks`, { name: 'Sneaky', color: null }), 404, undefined, 'other school cannot add a belt');
  await refused(() => post(OTHER_SCHOOL, `/programs/${kids.id}/ranks/${white.id}/versions`, { expectedVersion: 1, name: 'Sneaky', color: null }), 404, undefined, 'other school cannot edit a belt');
  await refused(() => read(OWNER, { school: ids.otherSchool }), 403, undefined, 'a school the person has no role at');
  await refused(() => post(OWNER, `/programs/${kids.id}/ranks/${yellow.id}/move`, { expectedVersion: 1, direction: 'DOWN' }, { school: ids.schoolB }), 403, undefined, 'path school must be a granted school');

  // 10. Guards: selectors, missing command header, wrong command, missing key, cross-site.
  await refused(() => read(OWNER, { query: `?schoolId=${ids.schoolB}` }), 400, 'RANK_SETUP_SELECTORS_NOT_ACCEPTED', 'query selector');
  await refused(() => post(OWNER, '/programs', { name: 'No command' }, { command: null }), 403, 'HUMAN_UI_REQUIRED', 'missing command header');
  await refused(() => post(OWNER, '/programs', { name: 'Wrong command' }, { command: 'parent-app-curriculum' }), 403, 'HUMAN_UI_REQUIRED', 'wrong command header');
  await refused(() => post(OWNER, '/programs', { name: 'No key' }, { key: null }), 400, 'IDEMPOTENCY_KEY_REQUIRED', 'missing idempotency key');
  await refused(() => post(OWNER, '/programs', { name: 'Cross' }, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-site');
  await refused(() => post(OWNER, '/programs', { name: 'Extra header' }, { headers: { 'X-Hon-Action-Request-Id': randomUUID() } }), 403, 'HUMAN_UI_REQUIRED', 'action header');

  // 11. Live authority and entitlement: a lapsed school and a revoked grant are refused.
  await sql("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp() WHERE organization_id=$1", [ids.organization]);
  await refused(() => read(OWNER), 403, undefined, 'lapsed entitlement read');
  await refused(() => post(OWNER, '/programs', { name: 'Lapsed' }), 403, undefined, 'lapsed entitlement command');
  await sql("UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1", [ids.organization]);
  await sql('UPDATE hon.principal_role_grants SET effective_until=clock_timestamp() WHERE id=$1', [MANAGER_ONLY.grants[0]]);
  await refused(() => post(MANAGER_ONLY, '/programs', { name: 'Revoked' }), 403, undefined, 'revoked grant');

  // 12. Audit: one row per successful command, none for refusals or replays; receipts in the 0070 private table.
  const audits = (await sql("SELECT action_code, count(*)::int n FROM hon.audit_events WHERE organization_id=$1 AND action_code LIKE 'curriculum.rank_setup.%' AND source='HUMAN_UI' GROUP BY 1 ORDER BY 1", [ids.organization])).rows;
  const count = (code) => audits.find((a) => a.action_code === `curriculum.rank_setup.${code}`)?.n ?? 0;
  ok(count('program_create') === 1 && count('rank_add') === 4 && count('rank_update') === 1 && count('rank_move') === 1 && count('program_rename') === 1, `one audit row per command: ${JSON.stringify(audits)}`);
  ok((await sql('SELECT count(*)::int n FROM hon.curriculum_command_requests WHERE organization_id=$1', [ids.organization])).rows[0].n === 8, 'one receipt per command');
  ok((await sql('SELECT count(*)::int n FROM hon.curricula WHERE organization_id=$1', [ids.organization])).rows[0].n === 1, 'refused creates left nothing');

  // 13. Runtime ACL: the two entry points only; the projection helper is private; direct calls without the human session are refused.
  const helper = (await sql(`SELECT has_function_privilege($1,'hon.rank_setup_program(uuid,uuid,uuid)','EXECUTE') runtime,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) pub FROM pg_proc p WHERE p.oid='hon.rank_setup_program(uuid,uuid,uuid)'::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE])).rows[0];
  ok(!helper.runtime && !helper.pub, 'projection helper is private');
  for (const fn of ['read_staff_rank_setup(text)', 'mutate_rank_setup(text,text,uuid,uuid,jsonb,text,uuid,uuid)']) {
    ok((await sql("SELECT has_function_privilege($1,$2,'EXECUTE') e", [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0].e, `runtime may execute ${fn}`);
  }
  await assert.rejects(runtime.query('SELECT hon.read_staff_rank_setup($1)', [OWNER.subject]), /HUMAN_COMMAND_REQUIRED|FORBIDDEN|42501/); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const section = verify.split('-- Rank setup exact verification (0622)')[1]?.split('-- End rank setup exact verification.')[0];
    ok(section, '011 rank setup section present');
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: rank setup (0622): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
