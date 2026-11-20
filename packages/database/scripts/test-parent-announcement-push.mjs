/**
 * Parent announcement push proof (0601) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guards ->
 * ParentPushController / SchoolAnnouncementsController -> protected definer functions on the restricted runtime role with
 * forced RLS), plus the 0601 worker functions and the API worker with a fake Expo transport, on the guarded disposable
 * CRM-close fixture only. Synthetic names and tokens only; nothing is sent anywhere.
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
const P = await load('parent-push/parent-push.controller.js');
const { ParentPushService } = await load('parent-push/parent-push.service.js');
const { ParentPushWorker } = await load('parent-push/parent-push-worker.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-parent-push', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'school', 'otherSchool', 'family', 'otherFamily', 'busyFamily'].map((key) => [key, randomUUID()]));
const PREFIX = `ppush-${ids.organization}`;
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [P.ParentPushController, M.SchoolAnnouncementsController],
    providers: [HonIdentityGuard, HonIdentityService, SchoolAnnouncementsService, ParentPushService, P.ParentPushRegisterGuard, P.ParentPushUnregisterGuard, P.ParentPushStatusGuard,
      M.SchoolAnnouncementsReadGuard, M.SchoolAnnouncementsPublishGuard, M.SchoolAnnouncementsWithdrawGuard, { provide: RuntimeDatabaseService, useValue: database }],
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
const base = (actor) => `/organizations/${actor.org}/schools/${actor.school}/announcements`;
const register = (actor, body, options = {}) => call(actor, 'POST', '/parent/push-devices', { body, command: 'parent.push_device.register', ...options });
const unregister = (actor, body, options = {}) => call(actor, 'POST', '/parent/push-devices/unregister', { body, command: 'parent.push_device.unregister', ...options });
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

let GUARDIAN, VIEWER, OUTSIDER, TWO, OTHER_PARENT, COACH, COACH_B, MANY;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Push Org','Push Org'),($2,'Push Other Org','Push Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5),($6,$2,$7,$8,$5)',
    [ids.school, ids.organization, 'Push Dojo', `ppush-a-${ids.school.slice(0, 8)}`, LA, ids.otherSchool, 'Push Dojo B', `ppush-b-${ids.otherSchool.slice(0, 8)}`]);
  await sql("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$3,$4,'Kim Family'),($2,$3,$4,'Other Family')",
    [ids.family, ids.otherFamily, ids.organization, ids.school]);
  await sql("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'B Family')", [ids.busyFamily, ids.organization, ids.otherSchool]);
  GUARDIAN = await person('guardian', 'Secret-Parent-Name'); VIEWER = await person('viewer'); OUTSIDER = await person('outsider'); TWO = await person('two');
  OTHER_PARENT = await person('other-parent'); MANY = await person('many');
  await grant(GUARDIAN, ids.family, 'PRIMARY_GUARDIAN'); await grant(VIEWER, ids.family, 'VIEWER'); await grant(MANY, ids.otherFamily, 'PRIMARY_GUARDIAN');
  await grant(TWO, ids.family, 'PRIMARY_GUARDIAN'); await grant(TWO, ids.otherFamily, 'PRIMARY_GUARDIAN');
  await sql("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',clock_timestamp()-interval '1 day',$4)",
    [ids.organization, ids.otherSchool, ids.busyFamily, OTHER_PARENT.principal]);
  OTHER_PARENT.school = ids.otherSchool;
  COACH = await staff('coach', await role(ids.organization, ['family_messages.manage']));
  COACH_B = await staff('coach-b', await role(ids.organization, ['family_messages.manage']), { school: ids.otherSchool });
}

const tokenOf = (label) => `ExponentPushToken[${(label + 'xxxxxxxxxxxxxxxx').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 22)}]`;
const devices = (principal) => sql('SELECT * FROM hon.parent_push_devices WHERE principal_id=$1 ORDER BY registered_at, id', [principal]).then((r) => r.rows);
const delivery = (id) => sql('SELECT * FROM hon.parent_push_deliveries WHERE id=$1', [id]).then((r) => r.rows[0]);
const claim = (limit = 100, lease = 60) => sql('SELECT * FROM hon.claim_parent_push_deliveries($1,$2)', [limit, lease]).then((r) => r.rows);
const recordSend = (d, outcome) => sql('SELECT hon.record_parent_push_send($1::uuid,$2::uuid,$3::jsonb) AS data', [d.delivery_id, d.lease_token, JSON.stringify(outcome)]).then((r) => r.rows[0].data);
const claimReceipts = (limit = 100, lease = 60) => sql('SELECT * FROM hon.claim_parent_push_receipts($1,$2)', [limit, lease]).then((r) => r.rows);
const recordReceipt = (d, outcome) => sql('SELECT hon.record_parent_push_receipt($1::uuid,$2::uuid,$3::jsonb) AS data', [d.delivery_id, d.lease_token, JSON.stringify(outcome)]).then((r) => r.rows[0].data);
async function backdate(sqlText, values) {
  await sql('ALTER TABLE hon.parent_push_deliveries DISABLE TRIGGER parent_push_deliveries_guard');
  try { await sql(sqlText, values); } finally { await sql('ALTER TABLE hon.parent_push_deliveries ENABLE TRIGGER parent_push_deliveries_guard'); }
}
async function post(actor, title) {
  return (await success(() => publish(actor, { title, body: `Secret body text for ${title}` }), `publish ${title}`, 201)).data.announcement;
}
const ours = (rows) => rows.filter((r) => r.title === 'Push Dojo' || r.title === 'Push Dojo B');

try {
  await cleanup();
  await seed();
  await startApp();
  // Other fixtures' leftovers would be claimed too; the fixture is disposable, so start from an empty queue.
  ok((await sql("SELECT count(*)::int n FROM hon.parent_push_deliveries WHERE status IN ('QUEUED','SENDING')")).rows[0].n === 0, 'empty queue to start');

  // 0. Status: whether the server sends at all (off here); signed in only, no selectors.
  delete process.env.HON_PARENT_PUSH_APPROVED;
  ok((await success(() => call(GUARDIAN, 'GET', '/parent/push-devices/status'), 'status')).data.sending === false, 'status: not sending');
  await refused(() => call(GUARDIAN, 'GET', '/parent/push-devices/status?schoolId=x'), 400, 'PARENT_PUSH_SELECTORS_NOT_ACCEPTED', 'status takes no selector');
  await refused(() => call(GUARDIAN, 'GET', '/parent/push-devices/status', { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'status refuses a delegated source');

  // 1. Register: closed body, Expo token shape, platform, key, command, one live grant.
  const T1 = tokenOf('guardian-phone');
  for (const [label, body] of [['no token', { platform: 'ios' }], ['bad token', { expoPushToken: 'abc', platform: 'ios' }],
    ['bad platform', { expoPushToken: T1, platform: 'web' }], ['extra key', { expoPushToken: T1, platform: 'ios', schoolId: ids.school }],
    ['not text', { expoPushToken: 1, platform: 'ios' }], ['short token', { expoPushToken: 'ExponentPushToken[abc]', platform: 'ios' }]]) {
    await refused(() => register(GUARDIAN, body), 400, 'VALIDATION_FAILED', `register validation: ${label}`);
  }
  await refused(() => register(GUARDIAN, { expoPushToken: T1, platform: 'ios' }, { key: null }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'register without a key');
  await refused(() => register(GUARDIAN, { expoPushToken: T1, platform: 'ios' }, { command: 'parent.push_device.unregister' }), 403, 'HUMAN_UI_REQUIRED', 'register under another command');
  await refused(() => register(GUARDIAN, { expoPushToken: T1, platform: 'ios' }, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-site register');
  await refused(() => register(OUTSIDER, { expoPushToken: T1, platform: 'ios' }), 403, 'PARENT_PUSH_FORBIDDEN', 'no family grant');
  await refused(() => register(TWO, { expoPushToken: T1, platform: 'ios' }), 403, 'PARENT_PUSH_FORBIDDEN', 'two families are ambiguous');
  await refused(() => register(COACH, { expoPushToken: T1, platform: 'ios' }), 403, 'PARENT_PUSH_FORBIDDEN', 'staff are not a family');
  await refused(() => call(GUARDIAN, 'POST', '/parent/push-devices?schoolId=x', { body: { expoPushToken: T1, platform: 'ios' }, command: 'parent.push_device.register' }), 400, 'PARENT_PUSH_SELECTORS_NOT_ACCEPTED', 'no selector');
  const first = (await success(() => register(GUARDIAN, { expoPushToken: T1, platform: 'ios' }), 'guardian registers')).data;
  ok(first.replayed === false && first.device.platform === 'ios', 'a new phone');
  const again = (await success(() => register(GUARDIAN, { expoPushToken: T1, platform: 'ios' }), 'guardian registers again')).data;
  ok(again.replayed === true && again.device.deviceId === first.device.deviceId, 'the same phone again is the same row');
  let rows = await devices(GUARDIAN.principal);
  ok(rows.length === 1 && rows[0].school_id === ids.school && rows[0].revoked_at === null && rows[0].last_seen_at >= rows[0].registered_at, 'one live phone at the grant school');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_type='PARENT_PUSH_DEVICE' AND entity_id=$1", [first.device.deviceId])).rows[0].n === 1, 'one audit row, no repeat for the same phone');
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_type='PARENT_PUSH_DEVICE' AND (next_state::text LIKE '%PushToken%' OR prior_state::text LIKE '%PushToken%')")).rows[0].n === 0, 'tokens never enter the audit log');

  // 2. The same phone signed in by someone else moves to them; the first person's row is let go.
  const TV = tokenOf('shared-phone');
  const g2 = (await success(() => register(GUARDIAN, { expoPushToken: TV, platform: 'android' }), 'guardian second phone')).data;
  const moved = (await success(() => register(VIEWER, { expoPushToken: TV, platform: 'android' }), 'viewer signs in on it')).data;
  ok(moved.replayed === false && moved.device.deviceId !== g2.device.deviceId, 'a new row for the new person');
  ok((await sql('SELECT revoke_reason FROM hon.parent_push_devices WHERE id=$1', [g2.device.deviceId])).rows[0].revoke_reason === 'REPLACED', 'the old row is let go as REPLACED');
  ok((await sql('SELECT count(*)::int n FROM hon.parent_push_devices WHERE expo_token=$1 AND revoked_at IS NULL', [TV])).rows[0].n === 1, 'one live owner per token');

  // 3. At most 10 live phones per person; the least recently seen goes first.
  const manyTokens = Array.from({ length: 11 }, (_, i) => tokenOf(`many-${i}`));
  for (const t of manyTokens) { await success(() => register(MANY, { expoPushToken: t, platform: 'android' }), 'many phones'); await new Promise((r) => setTimeout(r, 2)); }
  rows = await devices(MANY.principal);
  ok(rows.filter((r) => !r.revoked_at).length === 10 && rows.find((r) => r.expo_token === manyTokens[0]).revoke_reason === 'DEVICE_LIMIT', '10 live phones; the oldest let go');

  // 4. Unregister: only the person's own live token; nothing to let go is not an error.
  ok((await success(() => unregister(VIEWER, { expoPushToken: T1 }), 'viewer cannot let go of the guardian phone')).data.unregistered === false, 'not your phone');
  ok((await success(() => unregister(MANY, { expoPushToken: manyTokens[1] }), 'many signs out')).data.unregistered === true, 'signed out');
  ok((await success(() => unregister(MANY, { expoPushToken: manyTokens[1] }), 'twice')).data.unregistered === false, 'second sign out is a no-op');
  ok((await sql('SELECT revoke_reason FROM hon.parent_push_devices WHERE expo_token=$1', [manyTokens[1]])).rows[0].revoke_reason === 'SIGNED_OUT', 'SIGNED_OUT');
  await refused(() => unregister(GUARDIAN, { expoPushToken: 'nope' }), 400, 'VALIDATION_FAILED', 'unregister validation');
  await refused(() => unregister(OUTSIDER, { expoPushToken: T1 }), 403, 'PARENT_PUSH_FORBIDDEN', 'unregister without a grant');
  // Other school phone (to prove no cross-school fanout).
  const TB = tokenOf('other-school-phone');
  await success(() => register(OTHER_PARENT, { expoPushToken: TB, platform: 'ios' }), 'other school parent registers');

  // 5. Nothing is fanned out or sent while the worker is off: publishing alone writes no delivery.
  const A = await post(COACH, 'Closed Monday');
  ok((await sql('SELECT count(*)::int n FROM hon.parent_push_deliveries WHERE announcement_id=$1', [A.announcementId])).rows[0].n === 0, 'publishing queues nothing by itself');
  const offStore = { isConfigured: () => true, claim: async () => { throw new Error('must not claim'); } };
  const offWorker = new ParentPushWorker(offStore, { readiness: () => 'NOT_APPROVED' });
  ok((await offWorker.runOnce()).claimed === 0, 'the worker does nothing until sends are approved');
  ok((await sql('SELECT count(*)::int n FROM hon.parent_push_fanouts WHERE announcement_id=$1', [A.announcementId])).rows[0].n === 0, 'not fanned out while off');

  // 6. Claim: fan out once to the school's live phones only, then lease with the school name and the title only.
  const claimed = ours(await claim());
  const live = (await sql("SELECT d.id FROM hon.parent_push_devices d WHERE d.school_id=$1 AND d.revoked_at IS NULL", [ids.school])).rows.map((r) => r.id);
  ok(live.length === 11 && claimed.length === 11, `one delivery per live phone at the school (guardian, viewer, 9 of many), got ${claimed.length}/${live.length}`);
  ok(claimed.every((c) => c.title === 'Push Dojo' && c.body === 'Closed Monday' && c.announcement_id === A.announcementId && c.attempts === 1), 'school name and title only');
  ok(!JSON.stringify(claimed).includes('Secret body text') && !JSON.stringify(claimed).includes('Secret-Parent-Name'), 'no body text or names reach the worker');
  ok(!claimed.some((c) => c.expo_token === TB) && !claimed.some((c) => c.expo_token === manyTokens[0] || c.expo_token === manyTokens[1]), 'no other school and no let-go phones');
  ok(ours(await claim()).length === 0, 'fanned out exactly once');
  await assert.rejects(sql('SELECT * FROM hon.claim_parent_push_deliveries(0,60)')); checks += 1;
  await assert.rejects(sql('SELECT * FROM hon.claim_parent_push_deliveries(10,5)')); checks += 1;

  // 7. Recording a send: exact lease only; SENT, FAILED, UNKNOWN, RETRYABLE; DeviceNotRegistered lets the phone go.
  const byToken = Object.fromEntries(claimed.map((c) => [c.expo_token, c]));
  const g = byToken[T1], v = byToken[TV];
  const m = claimed.filter((c) => manyTokens.includes(c.expo_token));
  ok((await sql('SELECT hon.record_parent_push_send($1::uuid,$2::uuid,$3::jsonb) AS data', [g.delivery_id, randomUUID(), JSON.stringify({ outcome: 'SENT', ticketId: 'abc' })])).rows[0].data.recorded === false, 'a wrong lease records nothing');
  await assert.rejects(recordSend(g, { outcome: 'SENT' })); checks += 1;
  await assert.rejects(recordSend(g, { outcome: 'SENT', ticketId: 'bad ticket!' })); checks += 1;
  await assert.rejects(recordSend(g, { outcome: 'FAILED', failureCode: 'x', extra: 1 })); checks += 1;
  ok((await recordSend(g, { outcome: 'SENT', ticketId: 'ticket-guardian-1' })).status === 'SENT', 'sent with a ticket');
  ok((await recordSend(g, { outcome: 'FAILED', failureCode: 'Late' })).recorded === false, 'a recorded send cannot be recorded again');
  ok((await recordSend(v, { outcome: 'FAILED', failureCode: 'DeviceNotRegistered' })).status === 'FAILED', 'failed');
  ok((await sql('SELECT revoke_reason FROM hon.parent_push_devices WHERE expo_token=$1 AND principal_id=$2', [TV, VIEWER.principal])).rows[0].revoke_reason === 'DEVICE_NOT_REGISTERED', 'DeviceNotRegistered lets the phone go');
  ok((await recordSend(m[0], { outcome: 'UNKNOWN', failureCode: 'NO_ANSWER' })).status === 'UNKNOWN', 'no answer is UNKNOWN');
  ok((await recordSend(m[1], { outcome: 'RETRYABLE', failureCode: 'RATE_LIMITED' })).status === 'QUEUED', 'a definite refusal goes back to the queue');
  let retry = ours(await claim()).find((c) => c.delivery_id === m[1].delivery_id);
  ok(retry && retry.attempts === 2, 'claimed again as attempt 2');
  ok((await recordSend(retry, { outcome: 'RETRYABLE', failureCode: 'RATE_LIMITED' })).status === 'QUEUED', 'attempt 2 refused');
  retry = ours(await claim()).find((c) => c.delivery_id === m[1].delivery_id);
  ok(retry && retry.attempts === 3, 'attempt 3');
  const exhausted = await recordSend(retry, { outcome: 'RETRYABLE', failureCode: 'RATE_LIMITED' });
  ok(exhausted.status === 'FAILED' && (await delivery(m[1].delivery_id)).failure_code === 'RETRIES_EXHAUSTED', 'three attempts at most');

  // 8. A send lease that runs out is UNKNOWN on the next claim and is never sent again.
  await backdate("UPDATE hon.parent_push_deliveries SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [m[2].delivery_id]);
  ok(!ours(await claim()).some((c) => c.delivery_id === m[2].delivery_id), 'not claimed again');
  let row = await delivery(m[2].delivery_id);
  ok(row.status === 'UNKNOWN' && row.failure_code === 'LEASE_EXPIRED' && row.lease_token === null, 'lost lease is UNKNOWN');
  ok((await recordSend(m[2], { outcome: 'SENT', ticketId: 'late' })).recorded === false, 'a late answer after the lease records nothing');

  // 9. Re-checks: withdrawn before fanout is never fanned out; fanout takes live people only; at claim time a withdrawn
  // or stale announcement, a let-go phone or a person no longer live is SKIPPED.
  const B = await post(COACH, 'Belt test');
  await success(() => withdraw(COACH, B.announcementId, { expectedVersion: 1 }), 'take B down');
  await sql("UPDATE hon.family_access_grants SET effective_until=clock_timestamp()-interval '1 second' WHERE principal_id=$1", [MANY.principal]);
  const C = await post(COACH, 'Picture day');
  const cClaim = ours(await claim());
  ok((await sql('SELECT count(*)::int n FROM hon.parent_push_fanouts WHERE announcement_id=$1', [B.announcementId])).rows[0].n === 0, 'a withdrawn announcement is never fanned out');
  ok(cClaim.length === 1 && cClaim[0].expo_token === T1 && cClaim[0].body === 'Picture day', 'only the live guardian phone (MANY no longer live, VIEWER phone let go)');
  ok((await sql('SELECT count(*)::int n FROM hon.parent_push_deliveries WHERE announcement_id=$1', [C.announcementId])).rows[0].n === 1, 'one delivery for C');
  ok((await recordSend(cClaim[0], { outcome: 'SENT', ticketId: 'ticket-c' })).status === 'SENT', 'C sent');
  const queue = async (announcement, deviceId) => {
    await sql('INSERT INTO hon.parent_push_fanouts(announcement_id,organization_id,school_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [announcement.announcementId, ids.organization, ids.school]);
    return (await sql('INSERT INTO hon.parent_push_deliveries(organization_id,school_id,announcement_id,device_id) VALUES($1,$2,$3,$4) RETURNING id', [ids.organization, ids.school, announcement.announcementId, deviceId])).rows[0].id;
  };
  const t1Device = (await sql('SELECT id FROM hon.parent_push_devices WHERE expo_token=$1 AND revoked_at IS NULL', [T1])).rows[0].id;
  const T2 = tokenOf('guardian-phone-2');
  await success(() => register(GUARDIAN, { expoPushToken: T2, platform: 'ios' }), 'guardian second phone');
  const t2Device = (await sql('SELECT id FROM hon.parent_push_devices WHERE expo_token=$1 AND revoked_at IS NULL', [T2])).rows[0].id;
  const D = await post(COACH, 'Open mat'); const qD = await queue(D, t1Device);
  await success(() => withdraw(COACH, D.announcementId, { expectedVersion: 1 }), 'take D down after fanout');
  const G = await post(COACH, 'Seminar'); const qG = await queue(G, t2Device);
  await success(() => unregister(GUARDIAN, { expoPushToken: T2 }), 'guardian signs out the second phone');
  const St = await post(COACH, 'Yesterday'); const qSt = await queue(St, t1Device);
  await sql('ALTER TABLE hon.school_announcements DISABLE TRIGGER school_announcements_guard');
  await sql("UPDATE hon.school_announcements SET published_at=clock_timestamp()-interval '25 hours' WHERE id=$1", [St.announcementId]);
  await sql('ALTER TABLE hon.school_announcements ENABLE TRIGGER school_announcements_guard');
  ok(ours(await claim()).length === 0, 'nothing leased for withdrawn, stale or let-go');
  for (const [id, reason] of [[qD, 'WITHDRAWN'], [qG, 'DEVICE_REVOKED'], [qSt, 'STALE']]) {
    row = await delivery(id);
    ok(row.status === 'SKIPPED' && row.failure_code === reason && row.finished_at, `SKIPPED ${reason}`);
  }
  const H = await post(COACH, 'Camp'); const qH = await queue(H, t1Device);
  await sql("UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1", [ids.school]);
  ok(ours(await claim()).length === 0, 'nothing leased while the school is suspended');
  await sql("UPDATE hon.schools SET status='ACTIVE' WHERE id=$1", [ids.school]);
  row = await delivery(qH);
  ok(row.status === 'SKIPPED' && row.failure_code === 'NOT_LIVE', 'SKIPPED NOT_LIVE');
  const S = await post(COACH, 'Old news');
  await sql('ALTER TABLE hon.school_announcements DISABLE TRIGGER school_announcements_guard');
  await sql("UPDATE hon.school_announcements SET published_at=clock_timestamp()-interval '25 hours' WHERE id=$1", [S.announcementId]);
  await sql('ALTER TABLE hon.school_announcements ENABLE TRIGGER school_announcements_guard');
  ok(ours(await claim()).length === 0 && (await sql('SELECT count(*)::int n FROM hon.parent_push_fanouts WHERE announcement_id=$1', [S.announcementId])).rows[0].n === 0, 'older than 24 hours is never fanned out');

  // 10. Receipts: due after 15 minutes; DELIVERED, PENDING (check later), FAILED DeviceNotRegistered; 24 hours -> UNKNOWN.
  ok(!(await claimReceipts()).some((r) => r.delivery_id === g.delivery_id), 'not due before 15 minutes');
  await backdate("UPDATE hon.parent_push_deliveries SET next_check_at=clock_timestamp()-interval '1 second' WHERE id=ANY($1::uuid[])", [[g.delivery_id, cClaim[0].delivery_id]]);
  let due = await claimReceipts();
  const rg = due.find((r) => r.delivery_id === g.delivery_id);
  ok(rg && rg.ticket_id === 'ticket-guardian-1', 'receipt claimed with its ticket');
  ok((await recordReceipt(rg, { outcome: 'PENDING' })).status === 'SENT', 'no receipt yet: check again later');
  ok(!(await claimReceipts()).some((r) => r.delivery_id === g.delivery_id), 'not checked again at once');
  await backdate("UPDATE hon.parent_push_deliveries SET next_check_at=clock_timestamp()-interval '1 second' WHERE id=$1", [g.delivery_id]);
  const rg2 = (await claimReceipts()).find((r) => r.delivery_id === g.delivery_id);
  ok((await recordReceipt(rg2, { outcome: 'DELIVERED' })).status === 'DELIVERED' && (await delivery(g.delivery_id)).finished_at, 'handed to Apple or Google');
  ok((await recordReceipt(rg2, { outcome: 'DELIVERED' })).recorded === false, 'a closed receipt records nothing');
  const rs = due.find((r) => r.delivery_id === cClaim[0].delivery_id);
  ok(rs && (await recordReceipt(rs, { outcome: 'FAILED', failureCode: 'DeviceNotRegistered' })).status === 'FAILED', 'receipt failure');
  ok((await sql('SELECT revoke_reason FROM hon.parent_push_devices WHERE id=$1', [t1Device])).rows[0].revoke_reason === 'DEVICE_NOT_REGISTERED', 'a receipt DeviceNotRegistered lets the phone go');
  const T4 = tokenOf('guardian-phone-4');
  await success(() => register(GUARDIAN, { expoPushToken: T4, platform: 'ios' }), 'guardian registers again after the phone was let go');
  await assert.rejects(recordReceipt(rg2, { outcome: 'FAILED' })); checks += 1;
  // A lost receipt lease goes back to SENT; 24 hours without a receipt is UNKNOWN.
  const K = await post(COACH, 'Receipt timing');
  const k = ours(await claim());
  ok(k.length === 1 && k[0].body === 'Receipt timing', 'one phone for K');
  await recordSend(k[0], { outcome: 'SENT', ticketId: 'ticket-k' });
  await backdate("UPDATE hon.parent_push_deliveries SET next_check_at=clock_timestamp()-interval '1 second' WHERE id=$1", [k[0].delivery_id]);
  const rk = (await claimReceipts()).find((r) => r.delivery_id === k[0].delivery_id);
  await backdate("UPDATE hon.parent_push_deliveries SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [k[0].delivery_id]);
  ok((await recordReceipt(rk, { outcome: 'DELIVERED' })).recorded === false, 'an expired receipt lease records nothing');
  await claimReceipts();
  ok(['SENT', 'CHECKING'].includes((await delivery(k[0].delivery_id)).status), 'a lost receipt lease is checked again');
  await backdate("UPDATE hon.parent_push_deliveries SET status='SENT',lease_token=NULL,lease_until=NULL,sent_at=clock_timestamp()-interval '25 hours' WHERE id=$1", [k[0].delivery_id]);
  await claimReceipts();
  row = await delivery(k[0].delivery_id);
  ok(row.status === 'UNKNOWN' && row.failure_code === 'RECEIPT_EXPIRED', 'no receipt within 24 hours is UNKNOWN');

  // 11. The API worker end to end with a fake Expo transport (nothing leaves the machine).
  const L = await post(COACH, 'Worker run');
  const store = {
    isConfigured: () => true,
    claim: async (limit, lease) => (await claim(limit, lease)).filter((r) => r.title === 'Push Dojo').map((r) => ({ deliveryId: r.delivery_id, leaseToken: r.lease_token, expoToken: r.expo_token, title: r.title, body: r.body, announcementId: r.announcement_id, attempts: r.attempts })),
    recordSend: async (id, lease, outcome) => (await sql('SELECT hon.record_parent_push_send($1::uuid,$2::uuid,$3::jsonb) AS data', [id, lease, JSON.stringify(outcome)])).rows[0].data,
    claimReceipts: async () => [],
    recordReceipt: async () => ({ recorded: false }),
  };
  const sent = [];
  const fake = { readiness: () => 'READY', send: async (messages) => { sent.push(...messages); return messages.map((_, i) => ({ outcome: 'SENT', ticketId: `fake-${i}` })); }, receipts: async () => new Map() };
  const summary = await new ParentPushWorker(store, fake).runOnce();
  ok(summary.claimed === 1 && summary.sent === 1 && sent.length === 1, `worker sent one (${JSON.stringify(summary)})`);
  ok(sent[0].title === 'Push Dojo' && sent[0].body === 'Worker run' && JSON.stringify(sent[0].data) === JSON.stringify({ type: 'school_announcement', announcementId: L.announcementId }), 'message: school name, title, typed data only');
  ok(!JSON.stringify(sent).includes('Secret'), 'no body or names in the message');
  const lostStore = { ...store, recordSend: async () => { throw new Error('connection lost'); } };
  await post(COACH, 'Lost record');
  const lost = await new ParentPushWorker(lostStore, fake).runOnce(100, 30);
  ok(lost.claimed === 1 && lost.errors === 1, 'a lost record is counted, never retried by the worker');

  // 12. Rows never change except forward and are never deleted.
  const anyDevice = (await devices(GUARDIAN.principal))[0];
  await assert.rejects(sql('DELETE FROM hon.parent_push_devices WHERE id=$1', [anyDevice.id])); checks += 1;
  await assert.rejects(sql('UPDATE hon.parent_push_devices SET principal_id=$2 WHERE id=$1', [anyDevice.id, VIEWER.principal])); checks += 1;
  await assert.rejects(sql("UPDATE hon.parent_push_devices SET revoked_at=NULL, revoke_reason=NULL WHERE id=$1 AND revoked_at IS NOT NULL", [anyDevice.id]).then((r) => { if (!r.rowCount) throw new Error('no row'); })); checks += 1;
  await assert.rejects(sql("UPDATE hon.parent_push_deliveries SET status='QUEUED' WHERE id=$1", [g.delivery_id])); checks += 1;
  await assert.rejects(sql('DELETE FROM hon.parent_push_deliveries WHERE id=$1', [g.delivery_id])); checks += 1;
  await assert.rejects(sql("UPDATE hon.parent_push_deliveries SET status='SENDING', lease_token=gen_random_uuid(), lease_until=clock_timestamp() WHERE id=$1", [m[0].delivery_id])); checks += 1;
  await assert.rejects(sql('DELETE FROM hon.parent_push_fanouts WHERE announcement_id=$1', [A.announcementId])); checks += 1;
  await assert.rejects(sql("INSERT INTO hon.parent_push_deliveries(organization_id,school_id,announcement_id,device_id,status) VALUES($1,$2,$3,$4,'SENT')", [ids.organization, ids.school, A.announcementId, anyDevice.id])); checks += 1;

  // 13. Database boundary: runtime may run only the two parent commands; worker functions, helpers and tables are private.
  const entry = ['register_parent_push_device(text,jsonb,text,uuid,uuid)', 'unregister_parent_push_device(text,jsonb,text,uuid,uuid)'];
  const privateFns = ['parent_push_token_ok(text)', 'guard_parent_push_device()', 'guard_parent_push_delivery()', 'parent_push_principal_live_at(uuid,uuid,uuid)', 'parent_push_scope(text)',
    'claim_parent_push_deliveries(integer,integer)', 'record_parent_push_send(uuid,uuid,jsonb)', 'claim_parent_push_receipts(integer,integer)', 'record_parent_push_receipt(uuid,uuid,jsonb)'];
  for (const fn of entry) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, p.prosecdef, EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(r.runtime && r.prosecdef && !r.public, `runtime may execute definer ${fn}; PUBLIC may not`);
  }
  for (const fn of privateFns) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!r.runtime && !r.public, `${fn} is not the runtime's`);
    const w = (await sql("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_communication_worker') AND has_function_privilege('hon_communication_worker',$1,'EXECUTE') AS w", [`hon.${fn}`])).rows[0].w;
    const workerFn = fn.startsWith('claim_') || fn.startsWith('record_');
    const hasWorker = (await sql("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_communication_worker') e")).rows[0].e;
    if (hasWorker) ok(w === workerFn, `worker executes ${fn}: ${workerFn}`);
  }
  for (const table of ['parent_push_devices', 'parent_push_fanouts', 'parent_push_deliveries']) {
    const t = (await sql(`SELECT c.relrowsecurity, c.relforcerowsecurity, has_table_privilege($1,c.oid,'SELECT') sel, has_table_privilege($1,c.oid,'INSERT') ins
      FROM pg_class c WHERE c.oid=$2::regclass`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${table}`])).rows[0];
    ok(t.relrowsecurity && t.relforcerowsecurity && !t.sel && !t.ins, `${table}: forced RLS and no runtime table privilege`);
    await assert.rejects(runtime.query(`SELECT * FROM hon.${table}`)); checks += 1;
  }
  await assert.rejects(runtime.query('SELECT * FROM hon.claim_parent_push_deliveries(1,60)')); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const startMark = '-- Parent announcement push exact verification (0601)', endMark = '-- End parent announcement push exact verification.';
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: parent announcement push (0601): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch(() => {});
  await admin.end();
  await runtime.end();
}
