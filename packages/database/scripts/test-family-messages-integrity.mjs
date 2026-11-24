/**
 * Family messages proof (0330) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guards ->
 * ParentFamilyMessagesController / FamilyMessagesInboxController -> protected definer functions on the restricted runtime
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
const M = await load('families/family-messages.controller.js');
const { FamilyMessagesService } = await load('families/family-messages.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-family-messages', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'school', 'otherSchool', 'family', 'otherFamily', 'busyFamily'].map((key) => [key, randomUUID()]));
const PREFIX = `fmsg-${ids.organization}`;
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [M.ParentFamilyMessagesController, M.FamilyMessagesInboxController],
    providers: [HonIdentityGuard, HonIdentityService, FamilyMessagesService, M.ParentFamilyMessagesReadGuard, M.ParentFamilyMessagesSendGuard,
      M.FamilyMessagesInboxReadGuard, M.FamilyMessagesMarkReadGuard, M.FamilyMessagesReplyGuard, { provide: RuntimeDatabaseService, useValue: database }],
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
const parentRead = (actor, options = {}) => call(actor, 'GET', '/parent/messages/school', options);
const parentSend = (actor, body, options = {}) => call(actor, 'POST', '/parent/messages/school', { body, command: 'parent.family_messages.send', ...options });
const base = (actor) => `/organizations/${actor.org}/schools/${actor.school}/family-messages`;
const inbox = (actor, options = {}) => call(actor, 'GET', base(actor), options);
const thread = (actor, id, options = {}) => call(actor, 'GET', `${base(actor)}/${id}`, options);
const markRead = (actor, id, through, options = {}) => call(actor, 'POST', `${base(actor)}/${id}/read`, { body: { throughMessageId: through }, key: null, command: 'family_messages.mark_read', ...options });
const reply = (actor, id, body, options = {}) => call(actor, 'POST', `${base(actor)}/${id}/replies`, { body, command: 'family_messages.reply', ...options });

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

let GUARDIAN, SECOND, VIEWER, OUTSIDER, TWO, BUSY, COACH, NOPE, COACH_B;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Msg Org','Msg Org'),($2,'Msg Other Org','Msg Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5),($6,$2,$7,$8,$5)',
    [ids.school, ids.organization, 'Message Dojo', `fmsg-a-${ids.school.slice(0, 8)}`, LA, ids.otherSchool, 'Message Dojo B', `fmsg-b-${ids.otherSchool.slice(0, 8)}`]);
  await sql("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$4,$5,'Kim Family'),($2,$4,$5,'Other Family'),($3,$4,$5,'Busy Family')",
    [ids.family, ids.otherFamily, ids.busyFamily, ids.organization, ids.school]);
  GUARDIAN = await person('guardian'); SECOND = await person('second'); VIEWER = await person('viewer'); OUTSIDER = await person('outsider'); TWO = await person('two'); BUSY = await person('busy');
  await grant(GUARDIAN, ids.family, 'PRIMARY_GUARDIAN'); await grant(SECOND, ids.family, 'SECONDARY_GUARDIAN'); await grant(VIEWER, ids.family, 'VIEWER');
  await grant(TWO, ids.family, 'PRIMARY_GUARDIAN'); await grant(TWO, ids.otherFamily, 'PRIMARY_GUARDIAN'); await grant(BUSY, ids.busyFamily, 'PRIMARY_GUARDIAN');
  COACH = await staff('coach', await role(ids.organization, ['family_messages.manage']));
  NOPE = await staff('nope', await role(ids.organization, ['people.read', 'schedule.session.manage']));
  COACH_B = await staff('coach-b', await role(ids.organization, ['family_messages.manage']), { school: ids.otherSchool });
}

try {
  await cleanup();
  await seed();
  await startApp();

  // 0. Permission: sensitive, staff-assignable, held by every system OWNER role.
  ok((await sql("SELECT count(*)::int n FROM hon.permissions WHERE code='family_messages.manage' AND is_sensitive AND is_staff_assignable")).rows[0].n === 1, 'family_messages.manage is sensitive and staff-assignable');
  ok((await sql(`SELECT count(*)::int n FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER' AND NOT EXISTS(SELECT 1 FROM hon.role_permissions rp
    WHERE rp.role_id=r.id AND rp.organization_id=r.organization_id AND rp.permission_code='family_messages.manage')`)).rows[0].n === 0, 'every system OWNER role holds it');

  // 1. Parent read before any message: empty, scoped by the one live family grant.
  const empty = (await success(() => parentRead(GUARDIAN), 'parent read, empty')).data;
  ok(empty.canWrite === true && empty.threadId === null && empty.messages.length === 0 && empty.schoolName === 'Message Dojo', 'empty thread, guardian can write');
  ok((await success(() => parentRead(VIEWER), 'viewer read')).data.canWrite === false, 'a viewer reads only');
  await refused(() => parentRead(OUTSIDER), 403, 'FAMILY_MESSAGES_FORBIDDEN', 'no family grant');
  await refused(() => parentRead(TWO), 403, 'FAMILY_MESSAGES_FORBIDDEN', 'two families are ambiguous');
  await refused(() => call(GUARDIAN, 'GET', '/parent/messages/school?familyId=x'), 400, 'FAMILY_MESSAGES_SELECTORS_NOT_ACCEPTED', 'no selector');

  // 2. Parent send: closed body, plain text 1-2,000, guardian only, exact replay.
  for (const [label, body] of [['empty', { body: '' }], ['blank', { body: ' \n\t ' }], ['too long', { body: 'x'.repeat(2001) }], ['control', { body: 'hi\u0007' }],
    ['extra key', { body: 'hi', familyId: ids.family }], ['not text', { body: 7 }], ['missing', {}]]) {
    await refused(() => parentSend(GUARDIAN, body), 400, 'VALIDATION_FAILED', `send validation: ${label}`);
  }
  await refused(() => parentSend(GUARDIAN, { body: 'Hello' }, { key: null }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'send without a key');
  await refused(() => parentSend(GUARDIAN, { body: 'Hello' }, { command: 'family_messages.reply' }), 403, 'HUMAN_UI_REQUIRED', 'send under another command');
  await refused(() => parentSend(GUARDIAN, { body: 'Hello' }, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-site send');
  await refused(() => parentSend(VIEWER, { body: 'Hello' }), 403, 'FAMILY_MESSAGES_FORBIDDEN', 'a viewer cannot write');
  const TEXT = 'Min-jun will be late on Tuesday.\nThank you!';
  const key = randomUUID();
  const sent = await success(() => parentSend(GUARDIAN, { body: TEXT }, { key }), 'guardian sends', 201);
  const T = sent.data.threadId;
  ok(sent.data.message.from === 'FAMILY' && sent.data.message.mine === true && sent.data.message.body === TEXT && sent.data.version === 2 && sent.meta.replayed === false, 'first message creates the thread');
  const again = await success(() => parentSend(GUARDIAN, { body: TEXT }, { key }), 'send replay');
  ok(again.meta.replayed === true && JSON.stringify(again.data) === JSON.stringify(sent.data), 'exact replay, one message');
  await refused(() => parentSend(GUARDIAN, { body: 'Other text' }, { key }), 409, 'IDEMPOTENCY_KEY_REUSED', 'key reused for another body');
  const second = await success(() => parentSend(SECOND, { body: 'Also: can we book a private lesson?' }), 'second guardian sends', 201);
  ok(second.data.threadId === T && second.data.version === 3, 'one thread per family and school');
  ok((await sql('SELECT count(*)::int n FROM hon.family_messages WHERE thread_id=$1', [T])).rows[0].n === 2, 'two stored messages');
  const seen = (await success(() => parentRead(VIEWER), 'viewer sees the thread')).data;
  ok(seen.threadId === T && seen.messages.length === 2 && seen.messages.every((m) => m.mine === false && m.from === 'FAMILY'), 'the family thread, oldest first');

  // 3. Staff inbox: permission, school scope, unread counts, no text in the inbox.
  await refused(() => inbox(NOPE), 403, 'FAMILY_MESSAGES_FORBIDDEN', 'staff without family_messages.manage');
  await refused(() => inbox(GUARDIAN), 403, 'FAMILY_MESSAGES_FORBIDDEN', 'a parent is not staff');
  await refused(() => inbox(COACH, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'a read takes no key');
  await refused(() => call(COACH, 'GET', `/organizations/${ids.organization}/schools/${ids.otherSchool}/family-messages`), 403, 'FAMILY_MESSAGES_FORBIDDEN', 'another school by URL');
  const box = (await success(() => inbox(COACH), 'staff inbox')).data;
  ok(box.threads.length === 1 && box.threads[0].threadId === T && box.threads[0].familyName === 'Kim Family' && box.threads[0].unreadCount === 2 && box.unreadThreads === 1
    && box.threads[0].lastFrom === 'FAMILY', 'one thread, two unread');
  ok(!JSON.stringify(box).includes('late on Tuesday'), 'the inbox carries no message text');
  ok((await success(() => inbox(COACH_B), 'other school inbox')).data.threads.length === 0, 'another school sees nothing');
  await refused(() => thread(COACH_B, T), 404, 'FAMILY_MESSAGES_NOT_FOUND', 'another school cannot open the thread');
  await refused(() => thread(COACH, 'nope'), 400, 'VALIDATION_FAILED', 'bad thread id');
  const open = (await success(() => thread(COACH, T), 'staff opens the thread')).data;
  ok(open.messages.length === 2 && open.messages[0].body === TEXT && open.unreadCount === 2, 'reading does not mark read');

  // 4. Mark read up to what was loaded, then reply; families never see staff names.
  const firstId = open.messages[0].messageId, loadedId = open.messages[1].messageId;
  await refused(() => markRead(COACH, T, undefined, { body: {} }), 400, 'VALIDATION_FAILED', 'mark read needs the loaded message');
  await refused(() => markRead(COACH, T, loadedId, { body: { throughMessageId: loadedId, at: 1 } }), 400, 'VALIDATION_FAILED', 'mark read takes no other field');
  await refused(() => markRead(COACH, T, loadedId, { key: 'k' }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'mark read takes no key');
  await refused(() => markRead(COACH_B, T, loadedId), 404, 'FAMILY_MESSAGES_NOT_FOUND', 'another school cannot mark it');
  await refused(() => markRead(COACH, T, randomUUID()), 404, 'FAMILY_MESSAGES_NOT_FOUND', 'a message outside the thread');
  const partly = (await success(() => markRead(COACH, T, firstId), 'mark read through the first message')).data;
  ok(partly.unreadCount === 1 && partly.version === 4, 'only what was loaded is marked read');
  ok((await success(() => markRead(COACH, T, firstId), 'mark the same again')).data.version === 4, 'marking again changes nothing');
  const marked = (await success(() => markRead(COACH, T, loadedId), 'mark read')).data;
  ok(marked.unreadCount === 0 && marked.version === 5, 'marked read');
  ok((await success(() => markRead(COACH, T, firstId), 'an older mark')).data.version === 5, 'the read mark never moves back');
  ok((await success(() => inbox(COACH), 'inbox after read')).data.unreadThreads === 0, 'no unread threads');
  // A family message that arrives after the staff member loaded the thread stays unread through a reply.
  const late = await success(() => parentSend(GUARDIAN, { body: 'One more thing about Tuesday.' }), 'family writes after the load', 201);
  ok(late.data.version === 6, 'late family message');
  await refused(() => reply(NOPE, T, { body: 'Hi', throughMessageId: loadedId }), 403, 'FAMILY_MESSAGES_FORBIDDEN', 'reply without permission');
  await refused(() => reply(COACH, T, { body: 'Hi', throughMessageId: loadedId }, { key: null }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'reply without a key');
  await refused(() => reply(COACH, T, { body: 'Hi', threadId: T, throughMessageId: loadedId }), 400, 'VALIDATION_FAILED', 'reply with an extra key');
  await refused(() => reply(COACH, T, { body: 'Hi' }), 400, 'VALIDATION_FAILED', 'reply needs the loaded message');
  await refused(() => reply(COACH, randomUUID(), { body: 'Hi', throughMessageId: loadedId }), 404, 'FAMILY_MESSAGES_NOT_FOUND', 'reply to an unknown thread');
  await refused(() => reply(COACH_B, T, { body: 'Hi', throughMessageId: loadedId }), 404, 'FAMILY_MESSAGES_NOT_FOUND', 'reply from another school');
  await refused(() => reply(COACH, T, { body: 'Hi', throughMessageId: randomUUID() }), 404, 'FAMILY_MESSAGES_NOT_FOUND', 'reply through a message outside the thread');
  const replyKey = randomUUID();
  const answered = await success(() => reply(COACH, T, { body: 'Thanks, see you Tuesday.', throughMessageId: loadedId }, { key: replyKey }), 'staff replies', 201);
  ok(answered.data.message.from === 'SCHOOL' && answered.data.message.mine && answered.data.version === 7 && answered.meta.replayed === false, 'reply stored');
  ok((await success(() => reply(COACH, T, { body: 'Thanks, see you Tuesday.', throughMessageId: late.data.message.messageId }, { key: replyKey }), 'reply replay')).meta.replayed === true, 'a retry after a refresh replays the reply');
  const after = (await success(() => thread(COACH, T), 'thread after the reply')).data;
  ok(after.unreadCount === 1 && after.version === 7, 'the late family message is still unread after the reply');
  ok((await success(() => markRead(COACH, T, after.messages.at(-1).messageId), 'mark read through the reply')).data.unreadCount === 0, 'marking through the reply reads the late message');
  const family = (await success(() => parentRead(GUARDIAN), 'parent sees the reply')).data;
  ok(family.messages.length === 4 && family.messages[3].from === 'SCHOOL' && family.messages[3].mine === false && family.messages[0].mine === true, 'the reply shows as from the school');
  ok(!JSON.stringify(family).includes('Secret-Staff-Name') && !JSON.stringify(family).includes(COACH.principal), 'no staff name or id reaches the family');
  ok((await success(() => inbox(COACH), 'inbox after reply')).data.threads[0].lastFrom === 'SCHOOL', 'the inbox shows the school answered');

  // 5. Audit and outbox carry ids only.
  ok((await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND entity_type='FAMILY_MESSAGE_THREAD' AND action_code IN ('family_message.family_send','family_message.staff_reply')", [T])).rows[0].n === 4, 'four audit rows');
  ok((await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE aggregate_id=$1 AND event_type IN ('family_message.family_sent','family_message.staff_replied')", [T])).rows[0].n === 4, 'four inert outbox events');
  ok((await sql("SELECT count(*)::int n FROM hon.outbox_events WHERE aggregate_id=$1 AND (payload::text LIKE '%Tuesday%' OR payload::text LIKE '%lesson%')", [T])).rows[0].n === 0
    && (await sql("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND (next_state::text LIKE '%Tuesday%' OR prior_state::text LIKE '%Tuesday%')", [T])).rows[0].n === 0, 'no message text in audit or outbox');

  // 6. Hourly limits: 30 family messages per family, 600 messages per school.
  const busy = await success(() => parentSend(BUSY, { body: 'First' }), 'busy family sends', 201);
  await sql("ALTER TABLE hon.family_message_threads DISABLE TRIGGER family_message_threads_guard");
  await sql(`INSERT INTO hon.family_messages(thread_id,organization_id,school_id,family_id,author_kind,author_principal_id,body)
    SELECT $1,$2,$3,$4,'FAMILY',$5,'filler' FROM generate_series(1,29)`, [busy.data.threadId, ids.organization, ids.school, ids.busyFamily, BUSY.principal]);
  await sql("ALTER TABLE hon.family_message_threads ENABLE TRIGGER family_message_threads_guard");
  await refused(() => parentSend(BUSY, { body: 'One more' }), 429, 'FAMILY_MESSAGES_RATE_LIMITED', '31st family message in an hour');
  ok((await success(() => parentSend(GUARDIAN, { body: 'Another family is not limited' }), 'other family still sends', 201)).data.threadId === T, 'the family limit is per family');
  await sql(`INSERT INTO hon.family_messages(thread_id,organization_id,school_id,family_id,author_kind,author_principal_id,body)
    SELECT $1,$2,$3,$4,'SCHOOL',$5,'filler' FROM generate_series(1,600-(SELECT count(*)::int FROM hon.family_messages WHERE school_id=$3))`,
    [busy.data.threadId, ids.organization, ids.school, ids.busyFamily, COACH.principal]);
  await refused(() => reply(COACH, T, { body: 'Over the school limit', throughMessageId: loadedId }), 429, 'FAMILY_MESSAGES_RATE_LIMITED', 'the 601st school message in an hour');
  await refused(() => parentSend(GUARDIAN, { body: 'Over the school limit' }), 429, 'FAMILY_MESSAGES_RATE_LIMITED', 'families share the school limit');
  await sql("ALTER TABLE hon.family_messages DISABLE TRIGGER family_messages_immutable");
  await sql("UPDATE hon.family_messages SET created_at=created_at-interval '2 hours' WHERE thread_id=$1", [busy.data.threadId]);
  await sql("ALTER TABLE hon.family_messages ENABLE TRIGGER family_messages_immutable");
  ok((await success(() => parentSend(BUSY, { body: 'An hour later' }), 'limits roll over after an hour', 201)).data.message.body === 'An hour later', 'limits are per hour');

  // 7. Messages are append-only; threads never move.
  await assert.rejects(sql("UPDATE hon.family_messages SET body='changed' WHERE thread_id=$1", [T])); checks += 1;
  await assert.rejects(sql('DELETE FROM hon.family_messages WHERE thread_id=$1', [T])); checks += 1;
  await assert.rejects(sql('UPDATE hon.family_message_threads SET family_id=$2, version=version+1 WHERE id=$1', [T, ids.otherFamily])); checks += 1;
  await assert.rejects(sql('DELETE FROM hon.family_message_threads WHERE id=$1', [T])); checks += 1;

  // 8. Live authority: ended grant, revoked staff role, suspended school and lapsed entitlement are refused.
  await sql("UPDATE hon.family_access_grants SET effective_until=clock_timestamp()+interval '1 second' WHERE principal_id=$1", [SECOND.principal]);
  await new Promise((r) => setTimeout(r, 1200));
  await refused(() => parentSend(SECOND, { body: 'Late' }), 403, 'FAMILY_MESSAGES_FORBIDDEN', 'an ended family grant');
  await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=principal_id WHERE id=$1', [COACH.grant]);
  await refused(() => inbox(COACH), 403, 'FAMILY_MESSAGES_FORBIDDEN', 'a revoked staff role');
  await sql('UPDATE hon.principal_role_grants SET revoked_at=NULL, revoked_by_principal_id=NULL WHERE id=$1', [COACH.grant]);
  await sql("UPDATE hon.families SET status='SUSPENDED' WHERE id=$1", [ids.family]);
  await refused(() => parentSend(GUARDIAN, { body: 'Inactive family' }), 403, 'FAMILY_MESSAGES_FORBIDDEN', 'an inactive family');
  await sql("UPDATE hon.families SET status='ACTIVE' WHERE id=$1", [ids.family]);
  await sql("UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1", [ids.school]);
  await refused(() => parentRead(GUARDIAN), 403, 'FAMILY_MESSAGES_FORBIDDEN', 'suspended school, parent');
  await refused(() => inbox(COACH), 403, 'FAMILY_MESSAGES_FORBIDDEN', 'suspended school, staff');
  await sql("UPDATE hon.schools SET status='ACTIVE' WHERE id=$1", [ids.school]);
  await sql("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp()-interval '1 minute', effective_from=clock_timestamp()-interval '2 days' WHERE organization_id=$1", [ids.organization]);
  await refused(() => parentRead(GUARDIAN), 403, 'FAMILY_MESSAGES_FORBIDDEN', 'lapsed entitlement, parent');
  await refused(() => thread(COACH, T), 403, 'FAMILY_MESSAGES_FORBIDDEN', 'lapsed entitlement, staff');
  await sql('UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1', [ids.organization]);
  ok((await success(() => thread(COACH, T), 'access returns')).data.threadId === T, 'works again once access is live');

  // 9. Database boundary: definer entry points only; helpers and tables private.
  const entry = ['read_parent_family_messages(text)', 'send_parent_family_message(text,jsonb,text,uuid,uuid)', 'read_family_message_inbox(text)',
    'read_family_message_thread(text,uuid)', 'mark_family_message_thread_read(text,jsonb,uuid,uuid)', 'reply_family_message(text,jsonb,text,uuid,uuid)'];
  const helpers = ['family_message_body_ok(text)', 'guard_family_message_thread()', 'family_message_parent_scope(text,boolean)', 'require_family_messages_actor(text)',
    'family_message_time(timestamp with time zone)', 'family_message_json(hon.family_messages,uuid)', 'family_message_list(uuid,uuid)',
    'family_message_unread(hon.family_message_threads)', 'family_message_read_through(hon.family_message_threads,uuid)', 'family_message_begin(uuid,text,text)', 'family_message_append(hon.family_message_threads,uuid,text,text,text,uuid,uuid)'];
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
  for (const table of ['family_message_threads', 'family_messages']) {
    const r = (await sql(`SELECT c.relrowsecurity, c.relforcerowsecurity, has_table_privilege($1,c.oid,'SELECT') sel, has_table_privilege($1,c.oid,'INSERT') ins
      FROM pg_class c WHERE c.oid=$2::regclass`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${table}`])).rows[0];
    ok(r.relrowsecurity && r.relforcerowsecurity && !r.sel && !r.ins, `${table}: forced RLS and no runtime table privilege`);
  }
  await assert.rejects(runtime.query('SELECT * FROM hon.family_messages')); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const startMark = '-- Family messages exact verification (0330)', endMark = '-- End family messages exact verification.';
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: family messages (0330): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch(() => {});
  await admin.end();
  await runtime.end();
}
