/**
 * Calendar settings proof (0568) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guards + global ValidationPipe
 * + HonExceptionFilter -> CalendarSettingsController / PublicShareCalendarController -> protected definer functions on the
 * restricted runtime role with forced RLS), on the guarded disposable CRM-close fixture only. Synthetic names only.
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
const { CalendarSettingsController, PublicShareCalendarController } = await load('schedule/calendar-settings.controller.js');
const { CalendarSettingsService } = await load('schedule/calendar-settings.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-calendar-settings', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'lapsedOrganization', 'schoolA', 'schoolB', 'otherSchool', 'lapsedSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [CalendarSettingsController, PublicShareCalendarController],
    providers: [HonIdentityGuard, HonIdentityService, CalendarSettingsService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}

const COMMAND = { settings: 'schedule.calendar.settings.save', add: 'schedule.calendar.block_out.add', remove: 'schedule.calendar.block_out.remove',
  share: 'schedule.calendar.share.save', del: 'schedule.calendar.share.delete' };
function call(actor, method, path, { body, key = randomUUID(), command, headers = {}, school = actor.school, organization = actor.org } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/schedule/calendar/${path}`);
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
const readSettings = (actor, options = {}) => call(actor, 'GET', 'settings', options);
const readBlockOuts = (actor, from, to, options = {}) => call(actor, 'GET', `block-outs?from=${from}&to=${to}`, options);
const saveSettings = (actor, body, options = {}) => call(actor, 'POST', 'settings/profile', { body, command: COMMAND.settings, ...options });
const addBlockOut = (actor, body, options = {}) => call(actor, 'POST', 'settings/block-outs', { body, command: COMMAND.add, ...options });
const removeBlockOut = (actor, id, body, options = {}) => call(actor, 'POST', `settings/block-outs/${id}/remove`, { body, command: COMMAND.remove, ...options });
const createShare = (actor, body, options = {}) => call(actor, 'POST', 'settings/share-calendars', { body, command: COMMAND.share, ...options });
const editShare = (actor, id, body, options = {}) => call(actor, 'POST', `settings/share-calendars/${id}/edit`, { body, command: COMMAND.share, ...options });
const deleteShare = (actor, id, body, options = {}) => call(actor, 'POST', `settings/share-calendars/${id}/delete`, { body, command: COMMAND.del, ...options });
function publicRead(publicId) {
  return new Promise((resolvePromise, reject) => {
    http.get(`${origin}/v1/public/calendars/${publicId}`, { headers: { Accept: 'application/json' } }, (response) => {
      let text = ''; response.setEncoding('utf8'); response.on('data', (c) => { text += c; });
      response.on('end', () => { try { resolvePromise({ status: response.statusCode, headers: response.headers, body: JSON.parse(text) }); } catch (error) { reject(error); } });
    }).on('error', reject);
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
async function rejectsSql(run, pattern, label) {
  await sql('BEGIN');
  try { await rejectsSqlInside(run, pattern, label); } finally { await sql('ROLLBACK'); }
}
async function rejectsSqlInside(run, pattern, label) {
  await sql('SAVEPOINT expected_failure');
  try { await run(); } catch (error) { await sql('ROLLBACK TO SAVEPOINT expected_failure'); ok(pattern.test(error.message), `${label}: ${error.message}`); return; }
  await sql('ROLLBACK TO SAVEPOINT expected_failure');
  assert.fail(`${label}: expected a refusal`);
}

// Disposable-fixture cleanup only (as in the 0224 and 0240 proofs).
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
          await sql(`DELETE FROM hon.${table} WHERE organization_id = ANY($1::uuid[])`, [[ids.organization, ids.otherOrganization, ids.lapsedOrganization]]);
          await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);
          await sql('RELEASE SAVEPOINT cleanup_table');
        } catch { failed += 1; await sql('ROLLBACK TO SAVEPOINT cleanup_table'); }
      }
      if (!failed) break;
    }
    const left = (await sql('SELECT count(*)::int n FROM hon.class_sessions WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization, ids.lapsedOrganization]])).rows[0].n;
    if (left) throw new Error('fixture cleanup left class sessions behind');
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`settings-${ids.organization}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`settings-${ids.organization}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`settings-${ids.organization}-%`]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization, ids.lapsedOrganization]]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization, ids.lapsedOrganization]]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `settings-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Settings Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Settings Staff')", [principal, user]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  const context = (patch = {}) => { const requestId = randomUUID(); return { organizationId: org, schoolId: school, principalId: principal, principalType: 'HUMAN_USER', source: 'HUMAN_UI',
    externalSubject: subject, requestId, correlationId: requestId, idempotencyKey: randomUUID(), ...patch }; };
  return { subject, principal, grants, org, school, context, read: (patch = {}) => context({ idempotencyKey: '', ...patch }) };
}
let MANAGER, READER, NONE, OTHER_SCHOOL, today;
const programs = {};
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

async function seed() {
  await sql(`INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Settings Org','Settings Org'),($2,'Settings Other Org','Settings Other Org'),
    ($3,'Settings Lapsed Org','Settings Lapsed Org')`, [ids.organization, ids.otherOrganization, ids.lapsedOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o'], [ids.lapsedSchool, ids.lapsedOrganization, 'l']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Settings ${slug}`, `settings-${slug}-${school.slice(0, 8)}`, LA]);
    programs[slug] = randomUUID();
    await sql("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Kids Karate','SCHEDULED')", [programs[slug], org, school]);
  }
  programs.a2 = randomUUID();
  await sql("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Adult Kickboxing','SCHEDULED')", [programs.a2, ids.organization, ids.schoolA]);
  today = (await sql('SELECT (clock_timestamp() AT TIME ZONE $1)::date::text d', [LA])).rows[0].d;
  MANAGER = await staff('manager', [await role(ids.organization, ['schedule.session.manage', 'schedule.session.read'])]);
  READER = await staff('reader', [await role(ids.organization, ['schedule.session.read'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read', 'attendance.record', 'program.manage'])]);
  OTHER_SCHOOL = await staff('other-school', [await role(ids.organization, ['schedule.session.manage', 'schedule.session.read'])], { school: ids.schoolB });
}
async function classAt(program, name, day, time, { kind = 'CLASS', status = 'SCHEDULED', capacity = 12, school = ids.schoolA, org = ids.organization } = {}) {
  const id = randomUUID();
  await sql(`INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,room_name,starts_at,ends_at,capacity,booking_policy,status,session_kind,cancellation_reason)
    VALUES($1,$2,$3,$4,$5,'Main mat',($6::date+$7::time) AT TIME ZONE $8,($6::date+$7::time+interval '45 minutes') AT TIME ZONE $8,$9,'OPTIONAL_BOOKING',$10::hon.schedule_item_status,$11,
      CASE WHEN $10='CANCELLED' THEN 'Synthetic' END)`, [id, org, school, program, name, day, time, LA, capacity, status, kind]);
  return id;
}

try {
  await cleanup();
  await seed();
  await startApp();
  const versionOf = async (table, id) => (await sql(`SELECT version FROM hon.${table} WHERE ${table === 'calendar_share_settings' ? 'school_id' : 'id'}=$1`, [id])).rows[0].version;

  // 1. Authority: only managers of this school read or change settings; readers may read closed days only.
  for (const actor of [READER, NONE]) await refused(() => readSettings(actor), 403, undefined, `settings read refused for ${actor.subject.split('-').pop()}`);
  await refused(() => readSettings(OTHER_SCHOOL, { school: ids.schoolA }), 403, undefined, 'school-B staff at the school-A route');
  await refused(() => readBlockOuts(NONE, today, addDays(today, 6)), 403, undefined, 'block-out read refused without schedule read');
  await refused(() => readSettings(MANAGER, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'a read takes no key');
  let s = (await success(() => readSettings(MANAGER), 'manager reads settings')).data;
  ok(s.settings.version === null && s.settings.address === '' && s.blockOuts.length === 0 && s.shareCalendars.length === 0
    && s.programs.map((g) => g.name).join() === 'Adult Kickboxing,Kids Karate' && s.schoolName === 'Settings a', 'empty settings with this school\'s programs only');

  // 2. Address and phone: first save, versioned edit, stale version, validation, replay, audit.
  for (const [label, body] of [['missing version', { address: '1 Main St', phone: '' }], ['letters in phone', { expectedVersion: null, address: '', phone: 'call me' }],
    ['padded address', { expectedVersion: null, address: ' 1 Main St', phone: '' }], ['extra key', { expectedVersion: null, address: '', phone: '', website: 'x' }],
    ['long address', { expectedVersion: null, address: 'a'.repeat(201), phone: '' }]]) {
    await refused(() => saveSettings(MANAGER, body), 400, undefined, `settings validation: ${label}`);
  }
  for (const actor of [READER, NONE]) await refused(() => saveSettings(actor, { expectedVersion: null, address: '', phone: '' }), 403, undefined, `settings save refused for ${actor.subject.split('-').pop()}`);
  await refused(() => saveSettings(MANAGER, { expectedVersion: 1, address: '1 Main St', phone: '' }), 409, 'VERSION_CONFLICT', 'an edit before the first save');
  const profileKey = randomUUID(), profile = { expectedVersion: null, address: '100 Sample Road, Exampletown', phone: '(555) 010-0000' };
  const saved = await success(() => saveSettings(MANAGER, profile, { key: profileKey }), 'first settings save');
  ok(saved.data.version === 1 && saved.data.phone === '(555) 010-0000' && saved.meta.replayed === false, 'saved at version 1');
  const again = await success(() => saveSettings(MANAGER, profile, { key: profileKey }), 'settings replay');
  ok(again.meta.replayed === true && JSON.stringify(again.data) === JSON.stringify(saved.data), 'exact replay');
  await refused(() => saveSettings(MANAGER, { ...profile, phone: '' }, { key: profileKey }), 409, 'IDEMPOTENCY_KEY_REUSED', 'key reused for another body');
  await refused(() => saveSettings(MANAGER, profile), 409, 'VERSION_CONFLICT', 'a second first save');
  const edited = await success(() => saveSettings(MANAGER, { ...profile, expectedVersion: 1, phone: '+1 555 010 0001' }), 'edit settings');
  ok(edited.data.version === 2 && await versionOf('calendar_share_settings', ids.schoolA) === 2, 'version 2');
  await refused(() => saveSettings(MANAGER, { ...profile, expectedVersion: 1 }), 409, 'VERSION_CONFLICT', 'a stale settings edit');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='schedule.calendar.settings.save' AND source='HUMAN_UI'", [ids.schoolA])).rows[0].n === 2
    && (await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type='schedule.calendar.settings.saved'", [ids.schoolA])).rows[0].n === 2, 'two audits and two inert outbox events');

  // 3. Block-out dates.
  const thanksgiving = { label: 'Thanksgiving break', firstDate: addDays(today, 3), lastDate: addDays(today, 4) };
  for (const [label, body] of [['last before first', { ...thanksgiving, lastDate: addDays(today, 2) }], ['span over 62 days', { ...thanksgiving, lastDate: addDays(today, 66) }],
    ['empty label', { ...thanksgiving, label: '' }], ['impossible date', { ...thanksgiving, firstDate: '2026-02-30' }], ['extra key', { ...thanksgiving, closed: true }]]) {
    await refused(() => addBlockOut(MANAGER, body), 400, undefined, `block-out validation: ${label}`);
  }
  await refused(() => addBlockOut(MANAGER, { label: 'Old', firstDate: addDays(today, -9), lastDate: addDays(today, -8) }), 400, 'VALIDATION_FAILED', 'a block-out that already ended');
  await refused(() => addBlockOut(READER, thanksgiving), 403, undefined, 'a reader cannot add a block-out');
  const block = await success(() => addBlockOut(MANAGER, thanksgiving), 'add a block-out');
  ok(block.data.label === 'Thanksgiving break' && block.data.version === 1 && block.data.firstDate === thanksgiving.firstDate, 'block-out stored');
  const otherBlock = await success(() => addBlockOut(OTHER_SCHOOL, { label: 'School B closed', firstDate: addDays(today, 3), lastDate: addDays(today, 3) }, { school: ids.schoolB }), 'school B adds its own');
  let closed = (await success(() => readBlockOuts(READER, today, addDays(today, 6)), 'a reader sees closed days')).data.blockOuts;
  ok(closed.length === 1 && closed[0].blockOutId === block.data.blockOutId, 'only this school\'s block-out, inside the range');
  ok((await success(() => readBlockOuts(READER, addDays(today, 5), addDays(today, 11)), 'a range after the block-out')).data.blockOuts.length === 0, 'a range that misses it is empty');
  await refused(() => readBlockOuts(READER, today, addDays(today, 43)), 400, 'VALIDATION_FAILED', 'a block-out read over 42 days');
  await refused(() => removeBlockOut(MANAGER, otherBlock.data.blockOutId, { expectedVersion: 1 }), 404, 'CALENDAR_SETTINGS_NOT_FOUND', 'school B\'s block-out through school A');
  await refused(() => removeBlockOut(MANAGER, block.data.blockOutId, { expectedVersion: 2 }), 409, 'VERSION_CONFLICT', 'a stale remove');
  const removed = await success(() => removeBlockOut(MANAGER, block.data.blockOutId, { expectedVersion: 1 }), 'remove the block-out');
  ok(removed.data.status === 'REMOVED' && removed.data.version === 2, 'removed at version 2');
  await refused(() => removeBlockOut(MANAGER, block.data.blockOutId, { expectedVersion: 2 }), 404, 'CALENDAR_SETTINGS_NOT_FOUND', 'a removed block-out is final');
  ok((await success(() => readBlockOuts(READER, today, addDays(today, 6)), 'closed days after remove')).data.blockOuts.length === 0, 'removed days are open again');
  const block2 = (await success(() => addBlockOut(MANAGER, { label: 'Tournament day', firstDate: addDays(today, 3), lastDate: addDays(today, 3) }), 'add another block-out')).data;

  // 4. Share calendars: program calendars, a group, validation, isolation, versions.
  const kidsBody = { expectedVersion: null, kind: 'PROGRAM', name: 'Kids Karate', description: 'Ages 5 to 12', programId: programs.a, memberIds: [], ageMin: 5, ageMax: 12, enabled: true };
  for (const [label, patch] of [['program missing', { programId: null }], ['ages reversed', { ageMin: 12, ageMax: 5 }], ['age 100', { ageMax: 100 }],
    ['members on a program calendar', { memberIds: [randomUUID()] }], ['unknown kind', { kind: 'CLASS' }], ['empty name', { name: '' }], ['extra key', { color: 'red' }],
    ['version on create', { expectedVersion: 1 }]]) {
    await refused(() => createShare(MANAGER, { ...kidsBody, ...patch }), 400, undefined, `share validation: ${label}`);
  }
  await refused(() => createShare(MANAGER, { ...kidsBody, programId: programs.b }), 404, 'PROGRAM_NOT_FOUND', 'a school-B program through school A');
  await refused(() => createShare(MANAGER, { ...kidsBody, programId: programs.o }), 404, 'PROGRAM_NOT_FOUND', 'another organization program');
  await refused(() => createShare(READER, kidsBody), 403, undefined, 'a reader cannot make a share calendar');
  const kids = (await success(() => createShare(MANAGER, kidsBody), 'create the Kids Karate calendar')).data;
  ok(/^[a-f0-9]{48}$/.test(kids.publicId) && kids.version === 1 && kids.programName === 'Kids Karate' && kids.enabled, 'a program calendar with a public id');
  const adults = (await success(() => createShare(MANAGER, { ...kidsBody, name: 'Adult Kickboxing', description: '', programId: programs.a2, ageMin: 16, ageMax: null }), 'create the adult calendar')).data;
  const groupBody = { expectedVersion: null, kind: 'GROUP', name: 'All classes', description: 'Pick a program', programId: null, memberIds: [kids.shareCalendarId, adults.shareCalendarId], ageMin: null, ageMax: null, enabled: true };
  await refused(() => createShare(MANAGER, { ...groupBody, memberIds: [kids.shareCalendarId] }), 400, undefined, 'a group of one');
  await refused(() => createShare(MANAGER, { ...groupBody, memberIds: [kids.shareCalendarId, kids.shareCalendarId] }), 400, undefined, 'a repeated member');
  await refused(() => createShare(MANAGER, { ...groupBody, ageMin: 3 }), 400, undefined, 'an age range on a group');
  await refused(() => createShare(MANAGER, { ...groupBody, memberIds: [kids.shareCalendarId, randomUUID()] }), 404, 'CALENDAR_SETTINGS_NOT_FOUND', 'an unknown member');
  const otherCal = (await success(() => createShare(OTHER_SCHOOL, { ...kidsBody, programId: programs.b }, { school: ids.schoolB }), 'school B makes its own')).data;
  await refused(() => createShare(MANAGER, { ...groupBody, memberIds: [kids.shareCalendarId, otherCal.shareCalendarId] }), 404, 'CALENDAR_SETTINGS_NOT_FOUND', 'a member of another school');
  const group = (await success(() => createShare(MANAGER, groupBody), 'create the group')).data;
  await refused(() => createShare(MANAGER, { ...groupBody, memberIds: [kids.shareCalendarId, group.shareCalendarId] }), 404, 'CALENDAR_SETTINGS_NOT_FOUND', 'a group cannot hold a group');
  await refused(() => editShare(MANAGER, kids.shareCalendarId, { ...kidsBody, expectedVersion: 1, kind: 'GROUP', programId: null, memberIds: [adults.shareCalendarId, kids.shareCalendarId], ageMin: null, ageMax: null }), 400, undefined, 'kind never changes');
  await refused(() => editShare(MANAGER, kids.shareCalendarId, { ...kidsBody, expectedVersion: null }), 400, undefined, 'an edit needs a version');
  await refused(() => editShare(MANAGER, otherCal.shareCalendarId, { ...kidsBody, expectedVersion: 1 }), 404, 'CALENDAR_SETTINGS_NOT_FOUND', 'another school\'s calendar');
  const kidsOff = (await success(() => editShare(MANAGER, kids.shareCalendarId, { ...kidsBody, expectedVersion: 1, enabled: false }), 'switch Kids Karate off')).data;
  ok(kidsOff.version === 2 && kidsOff.enabled === false && kidsOff.publicId === kids.publicId, 'switched off, same link');
  await refused(() => editShare(MANAGER, kids.shareCalendarId, { ...kidsBody, expectedVersion: 1 }), 409, 'VERSION_CONFLICT', 'a stale share edit');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='schedule.calendar.share.save'", [kids.shareCalendarId])).rows[0].n === 2, 'every share save audited');
  await rejectsSql(() => sql("UPDATE hon.share_calendars SET public_id=encode(gen_random_bytes(24),'hex'),version=version+1 WHERE id=$1", [kids.shareCalendarId]), /CALENDAR_SETTINGS_IMMUTABLE/, 'the public id never changes');
  await rejectsSql(() => sql('UPDATE hon.share_calendars SET name=$2 WHERE id=$1', [kids.shareCalendarId, 'Same version']), /CALENDAR_SETTINGS_IMMUTABLE/, 'every change raises the version');
  await rejectsSql(() => sql('DELETE FROM hon.share_calendars WHERE id=$1', [kids.shareCalendarId]), /CALENDAR_SETTINGS_IMMUTABLE/, 'calendars are never deleted');
  await rejectsSql(() => sql('DELETE FROM hon.calendar_block_outs WHERE id=$1', [block.data.blockOutId]), /CALENDAR_SETTINGS_IMMUTABLE/, 'block-outs are never deleted');
  await rejectsSql(() => sql("UPDATE hon.calendar_block_outs SET status='ACTIVE',version=version+1 WHERE id=$1", [block.data.blockOutId]), /CALENDAR_SETTINGS_IMMUTABLE/, 'a removed block-out stays removed');

  // 5. The public read.
  const kidsMon = await classAt(programs.a, 'Little Tigers', addDays(today, 2), '16:30');
  await classAt(programs.a, 'Little Tigers', addDays(today, 3), '16:30');
  await classAt(programs.a, 'Private lesson', addDays(today, 2), '18:00', { kind: 'PRIVATE_LESSON' });
  await classAt(programs.a, 'Cancelled class', addDays(today, 5), '16:30', { status: 'CANCELLED' });
  await classAt(programs.a, 'Far away', addDays(today, 40), '16:30');
  await classAt(programs.a, 'Yesterday', addDays(today, -1), '16:30');
  await classAt(programs.a2, 'Kickboxing', addDays(today, 2), '19:00');
  let pub = await publicRead(kids.publicId);
  ok(pub.status === 404 && pub.body.result === 'INVALID' && !('data' in pub.body), 'a switched-off calendar answers 404');
  await success(() => editShare(MANAGER, kids.shareCalendarId, { ...kidsBody, expectedVersion: 2 }), 'switch Kids Karate back on');
  pub = await publicRead(kids.publicId);
  ok(pub.status === 200 && pub.headers['cache-control'] === 'no-store', 'public read 200, never cached');
  let P = pub.body.data;
  ok(P.kind === 'PROGRAM' && P.school.name === 'Settings a' && P.school.address === profile.address && P.school.phone === '+1 555 010 0001' && P.ageMin === 5 && P.ageMax === 12, 'school name, address, phone and ages');
  ok(P.times.length === 1 && P.times[0].name === 'Little Tigers' && P.times[0].localDate === addDays(today, 2) && P.times[0].localStart === '16:30'
    && P.times[0].localEnd === '17:15' && P.times[0].spotsLeft === 12 && P.times[0].room === 'Main mat', 'only scheduled, future, shared, open days within 28 days');
  ok(!JSON.stringify(P).includes(ids.schoolA) && !JSON.stringify(P).includes(ids.organization) && !JSON.stringify(P).includes(kidsMon) && !JSON.stringify(P).includes(MANAGER.principal), 'no internal ids in the public answer');
  await success(() => removeBlockOut(MANAGER, block2.blockOutId, { expectedVersion: 1 }), 'reopen the tournament day');
  P = (await publicRead(kids.publicId)).body.data;
  ok(P.times.length === 2, 'a removed block-out shows that day again');
  pub = await publicRead(group.publicId);
  P = pub.body.data;
  ok(pub.status === 200 && P.kind === 'GROUP' && P.times.length === 0 && P.calendars.map((c) => c.name).join() === 'Kids Karate,Adult Kickboxing'
    && P.calendars[0].upcomingCount === 2 && P.calendars[0].ageMin === 5 && P.calendars[1].upcomingCount === 1 && P.calendars[1].ageMax === null, 'group cards with ages and upcoming counts');
  ok(P.calendars[0].publicId === kids.publicId, 'a card links to its program calendar');
  await success(() => editShare(MANAGER, adults.shareCalendarId, { ...kidsBody, name: 'Adult Kickboxing', description: '', programId: programs.a2, ageMin: 16, ageMax: null, expectedVersion: 1, enabled: false }), 'switch the adult calendar off');
  ok((await publicRead(group.publicId)).body.data.calendars.length === 1, 'a switched-off member leaves the group');
  for (const [label, id] of [['unknown', 'a'.repeat(48)], ['uppercase', kids.publicId.toUpperCase()], ['short', kids.publicId.slice(0, 40)]]) {
    const r = await publicRead(id);
    ok(r.status === 404 && r.body.result === 'INVALID', `public read 404 for an ${label} id`);
  }
  // A cancelled program's calendar (and its group card) is hidden like a disabled one (review P3).
  await sql("UPDATE hon.programs SET status='CANCELLED' WHERE id=$1", [programs.a]);
  ok((await publicRead(kids.publicId)).status === 404, 'a cancelled program\'s calendar answers 404');
  ok((await publicRead(group.publicId)).body.data.calendars.length === 0, 'the group drops a cancelled program\'s card');
  await sql("UPDATE hon.programs SET status='SCHEDULED' WHERE id=$1", [programs.a]);
  ok((await publicRead(kids.publicId)).status === 200, 'the calendar answers again when the program runs again');
  const lapsedProgramCal = randomUUID();
  await sql(`INSERT INTO hon.share_calendars(id,organization_id,school_id,kind,name,program_id,created_by_principal_id,updated_by_principal_id)
    VALUES($1,$2,$3,'PROGRAM','Lapsed',$4,$5,$5)`, [lapsedProgramCal, ids.lapsedOrganization, ids.lapsedSchool, programs.l, MANAGER.principal]);
  const lapsedPublic = (await sql('SELECT public_id FROM hon.share_calendars WHERE id=$1', [lapsedProgramCal])).rows[0].public_id;
  ok((await publicRead(lapsedPublic)).status === 404, 'a school without a live entitlement has no public calendar');

  // 6. Delete is final.
  await refused(() => deleteShare(MANAGER, kids.shareCalendarId, { expectedVersion: 1 }), 409, 'VERSION_CONFLICT', 'a stale delete');
  const gone = (await success(() => deleteShare(MANAGER, kids.shareCalendarId, { expectedVersion: 3 }), 'delete Kids Karate')).data;
  ok(gone.status === 'DELETED' && gone.version === 4, 'deleted at version 4');
  ok((await publicRead(kids.publicId)).status === 404, 'a deleted calendar\'s link stops working');
  ok((await publicRead(group.publicId)).body.data.calendars.length === 0, 'the group drops a deleted member');
  await refused(() => editShare(MANAGER, kids.shareCalendarId, { ...kidsBody, expectedVersion: 4 }), 404, 'CALENDAR_SETTINGS_NOT_FOUND', 'a deleted calendar is final');
  s = (await success(() => readSettings(MANAGER), 'settings after the changes')).data;
  ok(s.shareCalendars.length === 2 && s.shareCalendars.every((c) => c.shareCalendarId !== kids.shareCalendarId)
    && s.shareCalendars.find((c) => c.kind === 'GROUP').memberIds.join() === adults.shareCalendarId, 'the staff list hides deleted calendars and members');
  ok(s.blockOuts.length === 0 && s.settings.version === 2, 'settings read shows live block-outs and the saved profile');

  // 7. Live authority: a revoked grant is refused at once.
  const revoked = await staff('revoked', [await role(ids.organization, ['schedule.session.manage'])]);
  await success(() => readSettings(revoked), 'a manager before revoke');
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=ANY($1::uuid[])', [revoked.grants]);
  await refused(() => readSettings(revoked), 403, undefined, 'a revoked manager cannot read');
  await refused(() => addBlockOut(revoked, { label: 'Late', firstDate: addDays(today, 7), lastDate: addDays(today, 7) }), 403, undefined, 'a revoked manager cannot write');

  // 8. ACL: the runtime has no table privilege and only the eight entry points.
  for (const table of ['calendar_share_settings', 'calendar_block_outs', 'share_calendars']) {
    ok(!(await sql(`SELECT has_table_privilege($1,'hon.${table}','SELECT,INSERT,UPDATE,DELETE') p`, [CRM_CLOSE_RUNTIME_ROLE])).rows[0].p, `runtime has no privilege on ${table}`);
  }
  for (const fn of ['hon.public_share_calendar(text)', 'hon.share_calendar_times(uuid,uuid,uuid,text,integer)', 'hon.calendar_day_blocked(uuid,uuid,date)', 'hon.guard_calendar_settings()']) {
    ok(!(await sql('SELECT has_function_privilege($1,$2,\'EXECUTE\') p', [CRM_CLOSE_RUNTIME_ROLE, fn])).rows[0].p, `runtime cannot run ${fn}`);
  }
  await rejectsSql(async () => { await runtime.query('SELECT * FROM hon.share_calendars'); }, /permission denied/, 'the runtime cannot read share calendars directly');
  console.log(`PASS: calendar settings (0568): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
