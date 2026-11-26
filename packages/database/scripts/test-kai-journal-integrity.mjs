/**
 * Kai teaching journal proof (0685) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guards + global
 * ValidationPipe + HonExceptionFilter -> KaiJournalController -> protected definer functions on the restricted runtime role
 * with forced RLS), on the guarded disposable CRM-close fixture only. Synthetic staff and synthetic journal text only;
 * nothing messages anyone, pays anyone or calls a provider.
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
const { KaiJournalController } = await load('kai-journal/kai-journal.controller.js');
const { KaiJournalService } = await load('kai-journal/kai-journal.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-kai-journal', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };


let app, origin;
const database = new RuntimeDatabaseService();
async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [KaiJournalController],
    providers: [HonIdentityGuard, HonIdentityService, KaiJournalService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}
const SAVE = 'kai_journal.save';
function call(actor, method, { body, key = randomUUID(), command = SAVE, headers = {}, school = actor.school, organization = actor.org, query = '', path = '' } = {}) {
  const target = new URL(`${origin}/v1/organizations/${organization}/schools/${school}/staff/kai/journal${path}${query}`);
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
const read = (actor, from, to, options = {}) => call(actor, 'GET', { path: `/entries/${from}/${to}`, ...options });
const save = (actor, body, options = {}) => call(actor, 'POST', { path: '/entries', body, ...options });
const team = (actor, from, to, options = {}) => call(actor, 'GET', { path: `/team/${from}/${to}`, ...options });
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
async function rejectsSql(run, pattern, label) {
  await sql('SAVEPOINT expected_failure');
  try { await run(); } catch (error) { await sql('ROLLBACK TO SAVEPOINT expected_failure'); ok(pattern.test(error.message), `${label}: ${error.message}`); return; }
  await sql('ROLLBACK TO SAVEPOINT expected_failure');
  assert.fail(`${label}: expected a refusal`);
}

// Disposable-fixture cleanup only (as in the 0240 proof).
async function cleanup(orgs = [ids.organization, ids.otherOrganization], subjects = `%kaij-${ids.organization}-%`) {
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
          await sql(`DELETE FROM hon.${table} WHERE organization_id = ANY($1::uuid[])`, [orgs]);
          await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);
          await sql('RELEASE SAVEPOINT cleanup_table');
        } catch { failed += 1; await sql('ROLLBACK TO SAVEPOINT cleanup_table'); }
      }
      if (!failed) break;
    }
    const left = (await sql('SELECT count(*)::int n FROM hon.kai_journal_entries WHERE organization_id = ANY($1::uuid[])', [orgs])).rows[0].n;
    if (left) throw new Error('fixture cleanup left a journal entry behind');
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [subjects]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [subjects]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [subjects]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [orgs]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [orgs]);
    const roles = (await sql('SELECT count(*)::int n FROM hon.roles WHERE organization_id = ANY($1::uuid[])', [orgs])).rows[0].n;
    if (roles) throw new Error('fixture cleanup left a role behind');
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
  const user = randomUUID(), principal = randomUUID(), subject = `kaij-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Journal Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3)", [principal, user, `Staff ${label}`]);
  const grants = [];
  for (const roleId of roles) {
    const grant = randomUUID();
    await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [grant, org, school, principal, roleId]);
    grants.push(grant);
  }
  return { subject, principal, grants, org, school };
}


const today = (await sql(`SELECT to_char((clock_timestamp() AT TIME ZONE '${LA}')::date,'YYYY-MM-DD') d`)).rows[0].d;
const day = (offset) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
const entry = (patch = {}) => ({ entryId: null, expectedVersion: 0, taughtOn: day(-1), className: 'Kids 6-8',
  notes: 'Roundhouse kick drills on pads.\nPartner blocking, then a short forms review.', topics: ['Roundhouse kick', 'Blocking'], source: 'SPOKEN', status: 'ACTIVE', shared: false, ...patch });
const count = async (where = '') => (await sql(`SELECT count(*)::int n FROM hon.kai_journal_entries WHERE organization_id=$1 ${where}`, [ids.organization])).rows[0].n;

let OWN, COACH, COACH2, NONE, PARENTISH, COACH_B, OTHER_ORG, LOSER;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Journal Org','Journal Org'),($2,'Journal Other Org','Journal Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day'),($2,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Journal ${slug}`, `kaij-${slug}-${school.slice(0, 8)}`, LA]);
  }
  OWN = await staff('owner', [await role(ids.organization, allPermissions, 'OWNER')]);
  COACH = await staff('coach', [await role(ids.organization, ['teaching.journal.use', 'people.read'])]);
  COACH2 = await staff('coach2', [await role(ids.organization, ['teaching.journal.use'])]);
  NONE = await staff('none', [await role(ids.organization, ['people.read', 'teaching.assistant.use'])]);
  PARENTISH = await staff('parentish', [await role(ids.organization, ['teaching.journal.use'], 'PARENT_PORTAL')]);
  COACH_B = await staff('coach-b', [await role(ids.organization, ['teaching.journal.use'])], { school: ids.schoolB });
  OTHER_ORG = await staff('other-org', [await role(ids.otherOrganization, allPermissions, 'OWNER')], { org: ids.otherOrganization, school: ids.otherSchool });
  LOSER = await staff('loser', [await role(ids.organization, ['teaching.journal.use'])]);
}

try {
  await cleanup();
  await seed();
  await startApp();
  const WEEK_FROM = day(-6);

  // 0. Permission and OWNER grants.
  ok((await sql("SELECT count(*)::int n FROM hon.permissions WHERE code='teaching.journal.use' AND NOT is_sensitive AND is_staff_assignable")).rows[0].n === 1, 'one staff-assignable, non-sensitive permission');
  ok((await sql(`SELECT count(*)::int n FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER'
    AND NOT EXISTS(SELECT 1 FROM hon.role_permissions rp WHERE rp.role_id=r.id AND rp.organization_id=r.organization_id AND rp.permission_code='teaching.journal.use')`)).rows[0].n === 0, 'every system OWNER role holds it');

  // 1. Reads and their refusals.
  const empty = (await success(() => read(COACH, WEEK_FROM, today), 'coach read')).data;
  ok(empty.timezone === LA && empty.today === today && empty.from === WEEK_FROM && empty.to === today && empty.entries.length === 0, `empty journal ${JSON.stringify(empty)}`);
  for (const actor of [NONE, PARENTISH]) await refused(() => read(actor, WEEK_FROM, today), 403, 'KAI_JOURNAL_FORBIDDEN', `read refused for ${actor.subject.split('-').pop()}`);
  await refused(() => read(COACH_B, WEEK_FROM, today, { school: ids.schoolA }), 403, undefined, 'school-B coach at the school-A route');
  await refused(() => read(OTHER_ORG, WEEK_FROM, today, { school: ids.schoolA, organization: ids.organization }), 403, undefined, 'other-organization owner at the school-A route');
  await refused(() => read(COACH, day(-120), today), 400, 'VALIDATION_FAILED', '121 days');
  ok((await success(() => read(COACH, day(-119), today), '120 days')).data.entries.length === 0, 'exactly 120 days is allowed');
  await refused(() => read(COACH, today, day(-1)), 400, 'VALIDATION_FAILED', 'from after to');
  await refused(() => read(COACH, '2026-02-30', '2026-03-01'), 400, 'VALIDATION_FAILED', 'not a date');
  await refused(() => read(COACH, WEEK_FROM, today, { query: '?all=1' }), 400, 'VALIDATION_FAILED', 'read with a query');
  await refused(() => read(COACH, WEEK_FROM, today, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'read with a key');
  await refused(() => read(COACH, WEEK_FROM, today, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-site read');
  await refused(() => read(COACH, WEEK_FROM, today, { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'read with a source header');

  // 2. Save refusals before anything is written.
  for (const actor of [NONE, PARENTISH]) await refused(() => save(actor, entry()), 403, 'KAI_JOURNAL_FORBIDDEN', `save refused for ${actor.subject.split('-').pop()}`);
  await refused(() => save(COACH_B, entry(), { school: ids.schoolA }), 403, undefined, 'school-B coach saving at school A');
  await refused(() => save(COACH, entry(), { command: 'staff_shift.save' }), 403, 'HUMAN_UI_REQUIRED', 'another command header');
  await refused(() => save(COACH, entry(), { key: '' }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'no key');
  for (const [label, value] of [['tomorrow', { taughtOn: day(1) }], ['401 days ago', { taughtOn: day(-401) }], ['bad date', { taughtOn: '2026-02-30' }],
    ['empty notes', { notes: '' }], ['padded notes', { notes: ' x' }], ['markup notes', { notes: 'a <b>b</b>' }], ['tab in notes', { notes: 'a\tb' }],
    ['long notes', { notes: 'x'.repeat(2001) }], ['class with a line break', { className: 'a\nb' }], ['long class', { className: 'x'.repeat(81) }],
    ['duplicate topics', { topics: ['Blocking', 'blocking'] }], ['eleven topics', { topics: Array.from({ length: 11 }, (_, i) => `t${i}`) }],
    ['long topic', { topics: ['x'.repeat(41)] }], ['double space topic', { topics: ['a  b'] }], ['number topic', { topics: [1] }],
    ['AI source', { source: 'AI' }], ['shared not a boolean', { shared: 'yes' }], ['shared missing', { shared: undefined }], ['new entry removed', { status: 'REMOVED' }], ['new entry at version 1', { expectedVersion: 1 }], ['bad id', { entryId: 'x', expectedVersion: 1 }]]) {
    await refused(() => save(COACH, entry(value)), 400, undefined, label);
  }
  await refused(() => save(COACH, { ...entry(), extra: 1 }), 400, undefined, 'an extra field (the global pipe refuses it)');
  ok(await count() === 0, 'no refusal wrote an entry');
  // The database refuses the same shapes by itself (a direct definer call with the session settings).
  await sql('BEGIN');
  await sql(`SELECT set_config('app.hon_principal_id',$1,true),set_config('app.hon_organization_id',$2,true),set_config('app.hon_school_id',$3,true),
    set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$4,true)`,
    [COACH.principal, ids.organization, ids.schoolA, COACH.subject]);
  for (const [label, value] of [['db tab', { notes: 'a\tb' }], ['db dup topics', { topics: ['A', 'a'] }], ['db zero width', { notes: 'a​b' }], ['db tomorrow', { taughtOn: day(1) }],
    ['db bidi topic', { topics: ['a‮b'] }], ['db shared string', { shared: 'true' }], ['db shared missing', { shared: undefined }]]) {
    await rejectsSql(() => sql('SELECT hon.save_kai_journal_entry($1,$2::jsonb,$3,$4::uuid,$5::uuid)', [COACH.subject, JSON.stringify(entry(value)), randomUUID(), randomUUID(), randomUUID()]), /VALIDATION_FAILED/, label);
  }
  await sql('ROLLBACK');

  // 3. Create, replay, key reuse.
  const key1 = randomUUID();
  const created = await success(() => save(COACH, entry(), { key: key1 }), 'create');
  const first = created.data;
  ok(first.version === 1 && first.status === 'ACTIVE' && first.source === 'SPOKEN' && first.taughtOn === day(-1) && first.notes.includes('\n')
    && first.topics.join('|') === 'Roundhouse kick|Blocking' && created.meta.replayed === false, `created ${JSON.stringify(first)}`);
  const replay = await success(() => save(COACH, entry(), { key: key1 }), 'replay');
  ok(replay.meta.replayed === true && JSON.stringify(replay.data) === JSON.stringify(first), 'exact replay returns the same entry');
  await refused(() => save(COACH, entry({ notes: 'Something else' }), { key: key1 }), 409, 'IDEMPOTENCY_KEY_REUSED', 'same key, other body');
  const stored = (await sql('SELECT response_body FROM hon.idempotency_records WHERE organization_id=$1 AND principal_id=$2 AND idempotency_key=$3', [ids.organization, COACH.principal, key1])).rows[0].response_body;
  ok(Object.keys(stored).sort().join() === 'entryId,status,version', `the replay record holds no journal text ${JSON.stringify(stored)}`);

  // 4. Own journal only.
  const older = (await success(() => save(COACH, entry({ taughtOn: day(-5), source: 'TYPED', topics: [], className: null, notes: 'Forms only.' })), 'older')).data;
  const outside = (await success(() => save(COACH, entry({ taughtOn: day(-30), topics: ['Breakfalls'] })), 'outside the range')).data;
  const otherCoach = (await success(() => save(COACH2, entry({ notes: 'Coach two notes.' })), 'coach2 create')).data;
  const mine = (await success(() => read(COACH, WEEK_FROM, today), 'coach read')).data.entries;
  ok(mine.map((e) => e.entryId).join() === [first.entryId, older.entryId].join() && older.className === null && older.topics.length === 0, 'own entries in the range, newest first');
  ok(!mine.some((e) => e.entryId === outside.entryId || e.entryId === otherCoach.entryId), 'nothing outside the range or by another coach');
  ok((await success(() => read(COACH2, WEEK_FROM, today), 'coach2 read')).data.entries.map((e) => e.entryId).join() === otherCoach.entryId, 'coach2 sees only their own');
  ok((await success(() => read(OWN, WEEK_FROM, today), 'owner read')).data.entries.length === 0, 'the owner does not see instructors\' journals (O1)');

  // 5. Edit, stale version, another person's entry.
  const edit = entry({ entryId: first.entryId, expectedVersion: 1, notes: 'Roundhouse kick drills.', topics: ['Roundhouse kick'], source: 'TYPED' });
  const edited = (await success(() => save(COACH, edit), 'edit')).data;
  ok(edited.version === 2 && edited.notes === 'Roundhouse kick drills.' && edited.source === 'TYPED' && edited.createdAt === first.createdAt, 'edit is the next version');
  await refused(() => save(COACH, edit), 409, 'VERSION_CONFLICT', 'stale version');
  await refused(() => save(COACH2, { ...edit, expectedVersion: 2 }), 404, 'KAI_JOURNAL_ENTRY_NOT_FOUND', 'another coach editing');
  await refused(() => save(OWN, { ...edit, expectedVersion: 2 }), 404, 'KAI_JOURNAL_ENTRY_NOT_FOUND', 'the owner editing');
  await refused(() => save(COACH, entry(), { key: key1 }), 409, 'VERSION_CONFLICT', 'replaying the create after an edit never returns stale text');

  // 6. Remove erases the text, is final and replays.
  const removeKey = randomUUID();
  const removed = await success(() => save(COACH, { ...edit, expectedVersion: 2, status: 'REMOVED' }, { key: removeKey }), 'remove');
  ok(removed.data.status === 'REMOVED' && removed.data.version === 3 && removed.data.notes === null && removed.data.className === null && removed.data.topics.length === 0, 'removed receipt carries no text');
  const row = (await sql('SELECT notes,class_name,topics,status FROM hon.kai_journal_entries WHERE id=$1', [first.entryId])).rows[0];
  ok(row.status === 'REMOVED' && row.notes === null && row.class_name === null && row.topics.length === 0, 'the stored entry is erased');
  ok(!(await success(() => read(COACH, WEEK_FROM, today), 'read after remove')).data.entries.some((e) => e.entryId === first.entryId), 'removed entries are hidden');
  ok((await success(() => save(COACH, { ...edit, expectedVersion: 2, status: 'REMOVED' }, { key: removeKey }), 'remove replay')).meta.replayed === true, 'remove replays');
  await refused(() => save(COACH, { ...edit, expectedVersion: 3 }), 409, 'KAI_JOURNAL_ENTRY_REMOVED', 'a removed entry is final');

  // 6b. Sharing (owner decision O1): private by default, shared per entry by its author, read-only for the school's teaching team.
  ok(first.shared === false && older.shared === false && otherCoach.shared === false, 'entries are private by default');
  for (const actor of [COACH, COACH2, OWN]) ok((await success(() => team(actor, WEEK_FROM, today), 'team read')).data.entries.length === 0, 'nothing shared yet');
  const shareKey = randomUUID();
  const sharedNew = await success(() => save(COACH, entry({ notes: 'Sparring footwork ladder.', topics: ['Footwork'], shared: true }), { key: shareKey }), 'create shared');
  ok(sharedNew.data.shared === true && sharedNew.data.version === 1, 'the author shares an entry');
  ok((await success(() => save(COACH, entry({ notes: 'Sparring footwork ladder.', topics: ['Footwork'], shared: true }), { key: shareKey }), 'shared replay')).meta.replayed === true, 'a shared save replays');
  await refused(() => save(COACH, entry({ notes: 'Sparring footwork ladder.', topics: ['Footwork'], shared: false }), { key: shareKey }), 409, 'IDEMPOTENCY_KEY_REUSED', 'the share choice is part of the command');
  const seen = (await success(() => team(COACH2, WEEK_FROM, today), 'coach2 team read')).data;
  ok(seen.today === today && seen.from === WEEK_FROM && seen.to === today && Object.keys(seen).sort().join() === 'entries,from,to,today', `team read shape ${JSON.stringify(Object.keys(seen))}`);
  ok(seen.entries.length === 1 && seen.entries[0].entryId === sharedNew.data.entryId && seen.entries[0].authorName === 'Staff coach'
    && seen.entries[0].notes === 'Sparring footwork ladder.' && Object.keys(seen.entries[0]).sort().join() === 'authorName,className,entryId,notes,taughtOn,topics,updatedAt',
    `a colleague sees only what was taught, by display name ${JSON.stringify(seen.entries)}`);
  ok(!JSON.stringify(seen).includes(COACH.principal) && !JSON.stringify(seen).includes(COACH.subject) && !JSON.stringify(seen).includes('@example.test'), 'no author id, subject or email');
  ok((await success(() => team(OWN, WEEK_FROM, today), 'owner team read')).data.entries.length === 1, 'the owner sees shared entries too');
  ok((await success(() => team(COACH, WEEK_FROM, today), 'author team read')).data.entries.length === 0, 'the author\'s own entries are not in their team view');
  ok(!(await success(() => team(COACH, WEEK_FROM, today), 'coach team read')).data.entries.some((e) => e.entryId === otherCoach.entryId), 'unshared entries stay private');
  ok((await success(() => team(COACH_B, WEEK_FROM, today), 'school-B team read')).data.entries.length === 0, 'another school of the same organization sees nothing');
  for (const actor of [NONE, PARENTISH]) await refused(() => team(actor, WEEK_FROM, today), 403, 'KAI_JOURNAL_FORBIDDEN', `team read refused for ${actor.subject.split('-').pop()}`);
  await refused(() => team(COACH_B, WEEK_FROM, today, { school: ids.schoolA }), 403, undefined, 'school-B coach at the school-A team route');
  await refused(() => team(OTHER_ORG, WEEK_FROM, today, { school: ids.schoolA, organization: ids.organization }), 403, undefined, 'other-organization owner at the school-A team route');
  await refused(() => team(COACH2, day(-120), today), 400, 'VALIDATION_FAILED', 'team 121 days');
  await refused(() => team(COACH2, WEEK_FROM, today, { query: '?author=x' }), 400, 'VALIDATION_FAILED', 'team read with a query');
  await refused(() => team(COACH2, WEEK_FROM, today, { headers: { 'Idempotency-Key': 'x' } }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'team read with a key');
  await refused(() => team(COACH2, WEEK_FROM, today, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-site team read');
  { const { status } = await call(COACH2, 'POST', { path: `/team/${WEEK_FROM}/${today}`, body: {} }); ok(status === 404, `the team journal has no write path (${status})`); }
  await refused(() => save(COACH2, entry({ entryId: sharedNew.data.entryId, expectedVersion: 1, notes: 'Taken over.', shared: true })), 404, 'KAI_JOURNAL_ENTRY_NOT_FOUND', 'a colleague cannot edit a shared entry');
  // A display name never carries markup or invisible characters; an empty one falls back.
  await sql("UPDATE hon.principals SET display_name=$2 WHERE id=$1", [COACH.principal, 'Coach <i>\u200bLee']);
  ok((await success(() => team(COACH2, WEEK_FROM, today), 'sanitized name')).data.entries[0].authorName === 'Coach iLee', 'unsafe characters are dropped from the name');
  await sql("UPDATE hon.principals SET display_name='Staff coach' WHERE id=$1", [COACH.principal]);
  // Unsharing is the next version and disappears at once; removing a shared entry unshares and erases it.
  const unshared = (await success(() => save(COACH, entry({ entryId: sharedNew.data.entryId, expectedVersion: 1, notes: 'Sparring footwork ladder.', topics: ['Footwork'] })), 'unshare')).data;
  ok(unshared.shared === false && unshared.version === 2, 'unsharing is the next version');
  ok((await success(() => team(COACH2, WEEK_FROM, today), 'after unshare')).data.entries.length === 0, 'an unshared entry leaves the team view at once');
  const reshared = (await success(() => save(COACH, entry({ entryId: sharedNew.data.entryId, expectedVersion: 2, notes: 'Sparring footwork ladder.', topics: ['Footwork'], shared: true })), 'reshare')).data;
  ok(reshared.shared === true && reshared.version === 3 && (await success(() => team(COACH2, WEEK_FROM, today), 'after reshare')).data.entries.length === 1, 'sharing again shows it again');
  const gone = (await success(() => save(COACH, entry({ entryId: sharedNew.data.entryId, expectedVersion: 3, status: 'REMOVED', shared: true })), 'remove shared')).data;
  ok(gone.status === 'REMOVED' && gone.shared === false && gone.notes === null, 'removing a shared entry unshares and erases it');
  ok((await success(() => team(COACH2, WEEK_FROM, today), 'after remove')).data.entries.length === 0, 'a removed entry leaves the team view at once');
  ok((await sql('SELECT shared FROM hon.kai_journal_entries WHERE id=$1', [sharedNew.data.entryId])).rows[0].shared === false, 'the stored removed entry is not shared');
  { const stored = (await sql('SELECT response_body FROM hon.idempotency_records WHERE organization_id=$1 AND principal_id=$2 AND idempotency_key=$3', [ids.organization, COACH.principal, shareKey])).rows[0].response_body;
    ok(Object.keys(stored).sort().join() === 'entryId,status,version', 'the shared save replay record holds no journal text'); }
  // Sharing works both ways between colleagues.
  const sharedByCoach2 = (await success(() => save(COACH2, entry({ taughtOn: day(-2), notes: 'Kata review.', topics: [], shared: true })), 'coach2 shares')).data;
  ok((await success(() => team(COACH, WEEK_FROM, today), 'coach sees coach2')).data.entries.map((e) => e.entryId).join() === sharedByCoach2.entryId, 'each colleague sees the other\'s shared entry');

  // 7. Losing access refuses reads and saves; restoring it allows them again.
  await success(() => save(LOSER, entry()), 'loser create');
  for (const [label, take, restore] of [
    ['grant revoked', 'UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(), revoked_by_principal_id=principal_id WHERE id=$1', 'UPDATE hon.principal_role_grants SET revoked_at=NULL, revoked_by_principal_id=NULL WHERE id=$1'],
    ['school suspended', "UPDATE hon.schools SET status='SUSPENDED' WHERE id=(SELECT school_id FROM hon.principal_role_grants WHERE id=$1)", "UPDATE hon.schools SET status='ACTIVE' WHERE id=(SELECT school_id FROM hon.principal_role_grants WHERE id=$1)"],
    ['access lapsed', "UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=(SELECT organization_id FROM hon.principal_role_grants WHERE id=$1)",
      "UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=(SELECT organization_id FROM hon.principal_role_grants WHERE id=$1)"],
    ['not Complete', "UPDATE hon.organization_entitlements SET tier='CORE' WHERE organization_id=(SELECT organization_id FROM hon.principal_role_grants WHERE id=$1)",
      "UPDATE hon.organization_entitlements SET tier='COMPLETE' WHERE organization_id=(SELECT organization_id FROM hon.principal_role_grants WHERE id=$1)"]]) {
    await sql(take, [LOSER.grants[0]]);
    await refused(() => read(LOSER, WEEK_FROM, today), 403, undefined, `${label}: read`);
    await refused(() => team(LOSER, WEEK_FROM, today), 403, undefined, `${label}: team read`);
    await refused(() => save(LOSER, entry({ taughtOn: day(-2) })), 403, undefined, `${label}: save`);
    await sql(restore, [LOSER.grants[0]]);
  }
  ok((await success(() => read(LOSER, WEEK_FROM, today), 'loser restored')).data.entries.length === 1, 'restored access sees the same entry');

  // 8. Audit and inert outbox for every write, without free text.
  const writes = await count() + (await sql('SELECT coalesce(sum(version-1),0)::int n FROM hon.kai_journal_entries WHERE organization_id=$1', [ids.organization])).rows[0].n;
  const audit = (await sql(`SELECT count(*)::int n, bool_and(NOT (next_state ?| ARRAY['notes','className','topics']) AND NOT coalesce(prior_state ?| ARRAY['notes','className','topics'],false)
    AND next_state ? 'topicCount') shape FROM hon.audit_events WHERE organization_id=$1 AND entity_type='KAI_JOURNAL_ENTRY'`, [ids.organization])).rows[0];
  const outbox = (await sql(`SELECT count(*)::int n, bool_and(NOT (payload ?| ARRAY['notes','className','topics'])) shape FROM hon.outbox_events WHERE organization_id=$1 AND aggregate_type='KAI_JOURNAL_ENTRY' AND status='PENDING'`, [ids.organization])).rows[0];
  ok(audit.shape && outbox.shape && audit.n === writes && outbox.n === writes, `one audit and one pending outbox event (no journal text) per write (${writes}/${audit.n}/${outbox.n})`);

  // 9. Guards, whoever writes (inside one rolled-back transaction).
  await sql('BEGIN');
  await rejectsSql(() => sql('DELETE FROM hon.kai_journal_entries WHERE id=$1', [older.entryId]), /IMMUTABLE/, 'delete');
  await rejectsSql(() => sql('TRUNCATE hon.kai_journal_entries'), /IMMUTABLE/, 'truncate');
  await rejectsSql(() => sql("UPDATE hon.kai_journal_entries SET notes='x' WHERE id=$1", [older.entryId]), /IMMUTABLE/, 'no version bump');
  await rejectsSql(() => sql('UPDATE hon.kai_journal_entries SET author_principal_id=$2, version=version+1 WHERE id=$1', [older.entryId, COACH2.principal]), /IMMUTABLE/, 'author changed');
  await rejectsSql(() => sql("UPDATE hon.kai_journal_entries SET status='ACTIVE', notes='back', version=version+1 WHERE id=$1", [first.entryId]), /IMMUTABLE/, 'removed revived');
  await rejectsSql(() => sql("UPDATE hon.kai_journal_entries SET notes=' x', version=version+1 WHERE id=$1", [older.entryId]), /check constraint/, 'invalid text stored directly');
  await rejectsSql(() => sql("UPDATE hon.kai_journal_entries SET status='REMOVED', version=version+1 WHERE id=$1", [older.entryId]), /check constraint/, 'removed but not erased');
  await rejectsSql(() => sql("UPDATE hon.kai_journal_entries SET topics=ARRAY['A','a'], version=version+1 WHERE id=$1", [older.entryId]), /check constraint/, 'duplicate topics stored directly');
  await rejectsSql(() => sql("UPDATE hon.kai_journal_entries SET status='REMOVED', notes=NULL, class_name=NULL, topics='{}', shared=true, version=version+1 WHERE id=$1", [older.entryId]), /check constraint|IMMUTABLE/, 'removed but still shared');
  await sql('ROLLBACK');

  // 10. Runtime ACL: three definer entry points only; helpers and the table private.
  for (const fn of ['read_kai_journal(text,date,date)', 'read_kai_team_journal(text,date,date)', 'save_kai_journal_entry(text,jsonb,text,uuid,uuid)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, p.prosecdef, EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(r.runtime && r.prosecdef && !r.public, `runtime may execute definer ${fn}; PUBLIC may not`);
  }
  for (const fn of ['kai_journal_text_ok(text,integer,boolean)', 'kai_journal_topics_ok(text[])', 'guard_kai_journal_entry()', 'require_kai_journal_actor(text)', 'kai_journal_json(hon.kai_journal_entries)', 'kai_journal_display_name(uuid)']) {
    const r = (await sql(`SELECT has_function_privilege($1,$2,'EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid=$2::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).rows[0];
    ok(!r.runtime && !r.public, `helper ${fn} is private`);
  }
  { const t = (await sql(`SELECT c.relrowsecurity AND c.relforcerowsecurity forced, has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT')
      OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_any_column_privilege($1,c.oid,'SELECT') runtime FROM pg_class c WHERE c.oid='hon.kai_journal_entries'::regclass`,
      [CRM_CLOSE_RUNTIME_ROLE])).rows[0];
    ok(t.forced && !t.runtime, 'kai_journal_entries: forced RLS, no runtime privilege');
    await assert.rejects(runtime.query('SELECT * FROM hon.kai_journal_entries LIMIT 1'), /permission denied/); checks += 1; }
  await assert.rejects(runtime.query("SELECT hon.read_kai_journal('x','2026-11-01','2026-11-02')"), /KAI_JOURNAL_FORBIDDEN/); checks += 1;
  await assert.rejects(runtime.query("SELECT hon.read_kai_team_journal('x','2026-11-01','2026-11-02')"), /KAI_JOURNAL_FORBIDDEN/); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const begin = '-- Kai teaching journal exact verification (0685)', end = '-- End Kai teaching journal exact verification.';
    const section = verify.split(begin)[1]?.split(end)[0];
    ok(section, begin);
    await sql(section.replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  // 11. Journal only: no message, payment, invoice or AI invocation.
  ok((await sql(`SELECT (SELECT count(*) FROM hon.payment_attempts WHERE organization_id=ANY($1::uuid[])) + (SELECT count(*) FROM hon.invoices WHERE organization_id=ANY($1::uuid[]))
    + (SELECT count(*) FROM hon.communication_messages WHERE organization_id=ANY($1::uuid[])) + (SELECT count(*) FROM hon.ai_invocation_plans WHERE organization_id=ANY($1::uuid[])) n`,
    [[ids.organization, ids.otherOrganization]])).rows[0].n === '0', 'no message, payment attempt, invoice or AI plan was created');

  console.log(`PASS: Kai teaching journal (0685): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
