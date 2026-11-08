/**
 * Forward-paging class-session list proof (0221): the verified school's class sessions from a school-local date
 * (default local today) in published order (UTC millisecond startsAt, then id), over signed HTTP (HON session cookie ->
 * HonIdentityGuard + strict browser read guard + global ValidationPipe + HonExceptionFilter -> controller -> restricted
 * runtime role with forced RLS and no class_sessions SELECT), on the guarded disposable CRM-close fixture only.
 * Synthetic names.
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
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
const { ClassSessionPagesController, ClassSessionPagesHumanUiGuard } = await load('schedule/class-session-pages.controller.js');
const { ClassSessionPagesService } = await load('schedule/class-session-pages.service.js');
const { encodeListCursor } = await load('foundation/list-cursor.js');
const { ClassSessionsReadController } = await load('schedule/class-sessions-read.controller.js');
const { ClassSessionsReadHumanUiGuard } = await load('schedule/class-sessions-read-human-ui.guard.js');
const { ClassSessionsReadService } = await load('schedule/class-sessions-read.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
{ const probe = new pg.Client(targets.runtime); await probe.connect(); try { await verifyCrmCloseProofConnection(probe, CRM_CLOSE_RUNTIME_ROLE); } finally { await probe.end(); } }

const session = { mode: 'OIDC', audience: 'hon-class-session-pages', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const ids = Object.fromEntries(['organization', 'otherOrganization', 'schoolA', 'schoolB', 'otherSchool', 'programA', 'programB', 'programO'].map((key) => [key, randomUUID()]));
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();

// A school timezone whose local clock is far from midnight now, so the proof never crosses a local day.
const TZ = (await sql(`SELECT z FROM unnest(ARRAY['America/Los_Angeles','America/New_York','Europe/London','Asia/Tokyo','Pacific/Auckland','Asia/Kolkata']) z
  WHERE extract(hour FROM clock_timestamp() AT TIME ZONE z) BETWEEN 2 AND 20 LIMIT 1`)).rows[0].z;

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [ClassSessionPagesController, ClassSessionsReadController],
    providers: [HonIdentityGuard, HonIdentityService, ClassSessionPagesHumanUiGuard, ClassSessionPagesService, ClassSessionsReadHumanUiGuard, ClassSessionsReadService,
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
function get(path, actor, rawQuery = '', headers = {}) {
  const target = `${origin}/v1/organizations/${actor.routeOrg ?? actor.org}/schools/${actor.routeSchool ?? actor.school}/schedule/sessions${path}${rawQuery}`;
  return new Promise((resolvePromise, reject) => {
    const request = http.request(target, { method: 'GET', headers: {
      Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`,
      'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'empty', 'X-Hon-Human-Read': 'class-sessions', Accept: 'application/json', ...headers,
    } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => { try { resolvePromise({ status: response.statusCode, headers: response.headers, body: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    request.on('error', reject);
    request.end();
  });
}
function list(actor, query = {}, options = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  const text = params.toString();
  return get('/list', { ...actor, routeOrg: options.organization, routeSchool: options.school }, text ? `?${text}` : '', options.headers);
}
async function page(read, label) {
  const { status, body, headers } = await read();
  assert.equal(status, 200, `${label}: expected 200, got ${status} ${JSON.stringify(body).slice(0, 300)}`);
  ok(headers['cache-control'] === 'private, no-store' && headers['referrer-policy'] === 'no-referrer', `${label}: never cached or referred`);
  return body;
}
async function refused(read, expectedStatus, expectedCode, label) {
  const { status, body } = await read();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 300)}`);
  if (expectedCode) assert.equal(body.code, expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(body).slice(0, 300)}`);
  ok(!('data' in body), `${label}: a refusal returns no rows`);
}
async function pageAll(actor, query, label) {
  const seen = []; let cursor; let pages = 0; let meta;
  do {
    const body = await page(() => list(actor, { ...query, cursor }), `${label} page ${pages + 1}`);
    ok(Object.keys(body.meta).sort().join(',') === 'correlationId,fromDate,limit,localToday,nextCursor,requestId,schoolTimezone', `${label}: closed meta`);
    ok(body.data.length <= body.meta.limit && (!body.meta.nextCursor || body.data.length === body.meta.limit), `${label}: page size`);
    ok(!body.meta.nextCursor || body.meta.nextCursor.length <= 512, `${label}: bounded cursor`);
    meta ??= body.meta;
    ok(body.meta.fromDate === meta.fromDate && body.meta.schoolTimezone === meta.schoolTimezone, `${label}: stable meta across pages`);
    seen.push(...body.data);
    cursor = body.meta.nextCursor ?? undefined; pages += 1;
    assert.ok(pages < 400, `${label}: pagination did not terminate`);
  } while (cursor);
  return { rows: seen, meta, pages };
}

// Disposable-fixture cleanup only: every organization-scoped row of the two synthetic organizations.
async function cleanup() {
  const tables = (await sql(`SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
    WHERE c.relnamespace='hon'::regnamespace AND c.relkind='r' ORDER BY 1`)).rows.map((row) => row.relname);
  const orgs = [ids.organization, ids.otherOrganization];
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
    if ((await sql('SELECT count(*)::int n FROM hon.class_sessions WHERE organization_id = ANY($1::uuid[])', [orgs])).rows[0].n) throw new Error('fixture cleanup left sessions behind');
    const like = `session-pages-${ids.organization}-%`;
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [like]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [like]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [like]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [orgs]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [orgs]);
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
  const user = randomUUID(), principal = randomUUID(), subject = `session-pages-${ids.organization}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Session Pages Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Session Pages Staff')", [principal, user]);
  for (const roleId of roles) {
    await sql("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')", [org, school, principal, roleId]);
  }
  const read = (patch = {}) => { const requestId = randomUUID(); return { organizationId: org, schoolId: school, principalId: principal, principalType: 'HUMAN_USER', source: 'HUMAN_UI',
    externalSubject: subject, requestId, correlationId: requestId, idempotencyKey: '', ...patch }; };
  return { subject, principal, org, school, read };
}

let READER, NONE, MIXED, OTHER_SCHOOL, readerRole;
let localToday, localMidnight;
async function classSession(school, org, program, name, startsAt, minutes = 45) {
  const id = randomUUID();
  await sql(`INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,room_name)
    VALUES($1,$2,$3,$4,$5,$6::timestamptz,$6::timestamptz + make_interval(mins => $7),20,'WALK_IN',$8)`, [id, org, school, program, name, startsAt, minutes, name.length % 2 ? 'Mat 1' : null]);
  return id;
}

// School A: 8 past sessions (one exactly 1 microsecond before local midnight), one at local midnight, 30 in one
// published millisecond (different microseconds, so only the id orders them), 10 one millisecond apart, 12 spread
// over the next 300 days (beyond the bounded read's 91 days), and 4 cancelled or draft. School B and another
// organization hold sessions that must never appear.
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Session Pages Org','Session Pages Org'),($2,'Session Pages Other','Session Pages Other')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.schoolA, ids.organization, 'a'], [ids.schoolB, ids.organization, 'b'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5)', [school, org, `Session Pages ${slug}`, `session-pages-${slug}-${school.slice(0, 8)}`, TZ]);
  }
  await sql(`INSERT INTO hon.programs(id,organization_id,school_id,name) VALUES($1,$4,$5,'Kids'),($2,$4,$6,'Kids B'),($3,$7,$8,'Other')`,
    [ids.programA, ids.programB, ids.programO, ids.organization, ids.schoolA, ids.schoolB, ids.otherOrganization, ids.otherSchool]);
  readerRole = await role(ids.organization, ['schedule.session.read']);
  READER = await staff('reader', [readerRole]);
  NONE = await staff('none', [await role(ids.organization, ['attendance.record', 'people.read'])]);
  MIXED = await staff('mixed', [readerRole, await role(ids.organization, ['people.read'], 'PARENT_PORTAL')]);
  OTHER_SCHOOL = await staff('school-b', [readerRole], { school: ids.schoolB });

  const day = (await sql(`SELECT to_char((clock_timestamp() AT TIME ZONE $1)::date,'YYYY-MM-DD') d,
    to_char((clock_timestamp() AT TIME ZONE $1)::date::timestamp AT TIME ZONE $1 AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') m`, [TZ])).rows[0];
  localToday = day.d; localMidnight = day.m;
  const at = (offset) => sql(`SELECT to_char(($1::timestamptz + $2::interval) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') t`, [localMidnight, offset]).then((r) => r.rows[0].t);
  for (const offset of ['-40 days', '-10 days', '-3 days', '-1 day', '-5 hours', '-1 hour', '-1 millisecond']) await classSession(ids.schoolA, ids.organization, ids.programA, `Past ${offset}`, await at(offset));
  await classSession(ids.schoolA, ids.organization, ids.programA, 'Just before midnight', await at('-1 microsecond'));
  await classSession(ids.schoolA, ids.organization, ids.programA, 'Midnight', localMidnight);
  const tie = await at('15 hours 30 minutes 0.123 seconds');
  for (let index = 0; index < 30; index += 1) await classSession(ids.schoolA, ids.organization, ids.programA, `Tie ${String(index).padStart(2, '0')}`, tie.replace('.123000Z', `.123${String(index * 33).padStart(3, '0')}Z`));
  for (let index = 0; index < 10; index += 1) await classSession(ids.schoolA, ids.organization, ids.programA, `Step ${index}`, await at(`1 day ${index} milliseconds`));
  for (const days of [2, 5, 9, 20, 45, 80, 92, 120, 160, 200, 250, 300]) await classSession(ids.schoolA, ids.organization, ids.programA, `Later +${days}`, await at(`${days} days 10 hours`));
  for (const [status, name] of [['CANCELLED', 'Cancelled'], ['DRAFT', 'Draft'], ['COMPLETED', 'Completed'], ['CANCELLED', 'Cancelled 2']]) {
    const id = await classSession(ids.schoolA, ids.organization, ids.programA, name, await at('3 days 9 hours'));
    await sql("UPDATE hon.class_sessions SET status=$2::hon.schedule_item_status, cancellation_reason=CASE WHEN $2='CANCELLED' THEN 'Fixture cancellation' END WHERE id=$1", [id, status]);
  }
  for (let index = 0; index < 5; index += 1) await classSession(ids.schoolB, ids.organization, ids.programB, `School B ${index}`, await at(`${index + 1} hours`));
  for (let index = 0; index < 5; index += 1) await classSession(ids.otherSchool, ids.otherOrganization, ids.programO, `Other org ${index}`, await at(`${index + 1} hours`));
}

// The expected order is computed in JavaScript from admin-read facts, independently of the function.
async function expectedRows(school, fromInstant) {
  const rows = (await sql(`SELECT id, name, status::text, capacity, booking_policy, room_name,
      to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') starts_us,
      to_char(ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ends_us,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_us
    FROM hon.class_sessions WHERE school_id=$1`, [school])).rows;
  const ms = (us) => `${us.slice(0, 23)}Z`;
  return rows.filter((row) => row.starts_us >= fromInstant)
    .map((row) => ({ sessionId: row.id, name: row.name, startsAt: ms(row.starts_us), endsAt: ms(row.ends_us), roomName: row.room_name, capacity: row.capacity,
      bookingPolicy: row.booking_policy, status: row.status, createdAt: ms(row.created_us) }))
    .sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
}
const tamper = (cursor, change) => {
  const [payload, signature] = cursor.split('.');
  return `${Buffer.from(JSON.stringify(change(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))), 'utf8').toString('base64url')}.${signature}`;
};
const effects = async () => (await sql(`SELECT (SELECT count(*) FROM hon.audit_events WHERE organization_id=$1)::int audit, (SELECT count(*) FROM hon.outbox_events WHERE organization_id=$1)::int outbox,
  (SELECT count(*) FROM hon.idempotency_records WHERE organization_id=$1)::int idempotency, (SELECT count(*) FROM hon.class_sessions WHERE organization_id=$1)::int sessions,
  (SELECT md5(string_agg(id::text||status::text||starts_at::text, ',' ORDER BY id)) FROM hon.class_sessions WHERE organization_id=$1) digest`, [ids.organization])).rows[0];

// Production intent (0147): runtime reads sessions only through named projections. The crm-lead-close fixture grants
// SELECT, so this proof revokes it for its own run and restores it after.
const runtimeSessionSelect = (await sql("SELECT has_table_privilege($1, 'hon.class_sessions', 'SELECT') AS granted", [CRM_CLOSE_RUNTIME_ROLE])).rows[0].granted;
try {
  await cleanup();
  await sql('BEGIN'); try { await seed(); await sql('COMMIT'); } catch (error) { await sql('ROLLBACK'); throw error; }
  if (runtimeSessionSelect) await sql(`REVOKE SELECT ON TABLE hon.class_sessions FROM ${CRM_CLOSE_RUNTIME_ROLE}`);
  ok((await sql("SELECT has_table_privilege($1, 'hon.class_sessions', 'SELECT') AS granted", [CRM_CLOSE_RUNTIME_ROLE])).rows[0].granted === false,
    'runtime has no SELECT on hon.class_sessions for this run');
  await startApp();
  const before = await effects();

  // 1. Default: every school-A session from local midnight once, in published order, at four page sizes, exact facts.
  const fromToday = await expectedRows(ids.schoolA, localMidnight);
  ok(fromToday.length === 57 && fromToday[0].name === 'Midnight' && !fromToday.some((row) => row.name.startsWith('Past') || row.name === 'Just before midnight'),
    `fixture: 57 sessions from local midnight (${fromToday.length}), midnight first, nothing earlier`);
  for (const limit of [100, 50, 7, 1]) {
    const { rows, meta } = await pageAll(READER, { limit }, `default limit ${limit}`);
    ok(JSON.stringify(rows) === JSON.stringify(fromToday), `default limit ${limit}: every session once, in order, with exact facts`);
    ok(meta.fromDate === localToday && meta.localToday === localToday && meta.schoolTimezone === TZ && meta.limit === limit, `default limit ${limit}: meta ${JSON.stringify(meta)}`);
  }
  const first = await page(() => list(READER), 'default page');
  ok(first.data.length === 50 && first.meta.limit === 50 && typeof first.meta.nextCursor === 'string', 'default page is 50 rows with a cursor');
  const tieRows = first.data.filter((row) => row.name.startsWith('Tie'));
  ok(tieRows.length === 30 && new Set(tieRows.map((row) => row.startsAt)).size === 1, '30 sessions share one published millisecond');
  ok(fromToday.some((row) => row.name === 'Later +300'), 'no 91-day cap: a session 300 days out is listed');
  ok(fromToday.filter((row) => row.status !== 'SCHEDULED').length === 4, 'every lifecycle status is listed, as in the bounded read');

  // 2. The same rows and facts as the bounded current-school read where both list a session.
  const bounded = await page(() => get('', READER), 'bounded 0147 read');
  const byId = new Map(fromToday.map((row) => [row.sessionId, row]));
  const shared = bounded.data.filter((row) => byId.has(row.sessionId));
  ok(shared.length >= 40 && shared.every((row) => JSON.stringify(row) === JSON.stringify(byId.get(row.sessionId))), `bounded read and pages agree on ${shared.length} shared sessions`);

  // 3. An explicit from date: earlier dates include past sessions, later dates exclude earlier ones.
  for (const days of [-41, -4, 0, 1, 2, 100, 301]) {
    const date = (await sql(`SELECT to_char($1::date + $2::int,'YYYY-MM-DD') d, to_char(($1::date + $2::int)::timestamp AT TIME ZONE $3 AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') m`,
      [localToday, days, TZ])).rows[0];
    const want = await expectedRows(ids.schoolA, date.m);
    const { rows, meta } = await pageAll(READER, { from: date.d, limit: 9 }, `from ${date.d}`);
    ok(JSON.stringify(rows) === JSON.stringify(want) && meta.fromDate === date.d && meta.localToday === localToday, `from ${date.d}: exactly ${want.length} sessions from that local midnight`);
  }
  ok((await pageAll(READER, { from: localToday }, 'explicit today')).rows.length === fromToday.length, 'from=today equals the default');
  // A default-date list whose first page was read before the school's local midnight keeps paging from its position:
  // later pages carry no date bound, so yesterday's sessions after the position are not dropped. The cursor is minted
  // here exactly as the API mints it, at a session from yesterday.
  const everything = await expectedRows(ids.schoolA, '0000');
  const yesterday = everything.findIndex((row) => row.name === 'Past -1 day');
  const rolledCursor = encodeListCursor('schedule.session.list', ids.schoolA, { from: null }, ['instant', 'uuid'], [`${everything[yesterday].startsAt.slice(0, -1)}000Z`, everything[yesterday].sessionId]);
  const rolled = [];
  for (let next = rolledCursor, pages = 0; next; pages += 1) {
    assert.ok(pages < 100, 'rolled pagination did not terminate');
    const body = await page(() => list(READER, { limit: 4, cursor: next }), `rolled page ${pages + 1}`);
    rolled.push(...body.data); next = body.meta.nextCursor;
  }
  ok(JSON.stringify(rolled) === JSON.stringify(everything.slice(yesterday + 1)) && rolled.some((row) => row.name === 'Just before midnight'),
    `a page after local midnight continues from its position (${rolled.length} rows, including yesterday's later sessions)`);

  // 4. Exact school and organization only.
  const schoolB = await pageAll(OTHER_SCHOOL, {}, 'school B');
  ok(schoolB.rows.length === 5 && schoolB.rows.every((row) => row.name.startsWith('School B')), 'school B lists only its own five sessions');
  await refused(() => list(READER, {}, { school: ids.schoolB }), 403, 'CLASS_SESSIONS_READ_FORBIDDEN', 'school-A reader at school B');
  await refused(() => list(READER, {}, { organization: ids.otherOrganization }), 403, 'CLASS_SESSIONS_READ_FORBIDDEN', 'route organization mismatch');

  // 5. Cursors are signed and bound to the school and the from date; bad queries are refused.
  const cursor = first.meta.nextCursor;
  const fromCursor = (await page(() => list(READER, { from: localToday, limit: 5 }), 'from page')).meta.nextCursor;
  await refused(() => list(READER, { from: localToday, cursor }), 400, 'INVALID_CURSOR', 'default cursor with an explicit from');
  await refused(() => list(READER, { cursor: fromCursor }), 400, 'INVALID_CURSOR', 'from-bound cursor without its from');
  await refused(() => list(OTHER_SCHOOL, { cursor }), 400, 'INVALID_CURSOR', 'school-A cursor at school B');
  await refused(() => list(READER, { cursor: tamper(cursor, (b) => ({ ...b, k: [b.k[0], fromToday[3].sessionId] })) }), 400, 'INVALID_CURSOR', 'cursor retargeted to another session');
  await refused(() => list(READER, { cursor: `${cursor.split('.')[0]}.${randomBytes(32).toString('base64url')}` }), 400, 'INVALID_CURSOR', 'client-minted signature');
  await refused(() => list(READER, { cursor: cursor.slice(0, -4) }), 400, 'INVALID_CURSOR', 'truncated cursor');
  await refused(() => list(READER, { cursor: 'x'.repeat(513) }), 400, undefined, 'over-long cursor');
  for (const from of ['2026-02-30', '2026-13-01', '1999-12-31', '2101-01-01']) await refused(() => list(READER, { from }), 400, 'VALIDATION_FAILED', `impossible or out-of-range from ${from}`);
  for (const [query, label] of [[{ from: '20261108' }, 'from shape'], [{ limit: 0 }, 'limit 0'], [{ limit: 101 }, 'limit 101'], [{ limit: 'x' }, 'limit text']]) {
    await refused(() => list(READER, query), 400, undefined, label);
  }
  await refused(() => get('/list', READER, '?other=x'), 400, 'CLASS_SESSIONS_READ_SELECTORS_NOT_ACCEPTED', 'unknown query key');
  await refused(() => get('/list', READER, `?from=${localToday}&from=${localToday}`), 400, 'CLASS_SESSIONS_READ_SELECTORS_NOT_ACCEPTED', 'repeated from');
  await refused(() => get('', READER, '?limit=5'), 400, 'CLASS_SESSIONS_READ_SELECTORS_NOT_ACCEPTED', 'the bounded read still accepts no query');

  // 6. Authority: schedule.session.read live at the school; the definer function decides independently.
  await refused(() => list(NONE), 403, 'CLASS_SESSIONS_READ_FORBIDDEN', 'staff without schedule.session.read');
  await refused(() => list(MIXED), 403, 'CLASS_SESSIONS_READ_FORBIDDEN', 'reader mixed with a family-style role');
  await refused(() => list({ ...READER, subject: `unknown-${randomUUID()}` }), 403, undefined, 'unknown subject');
  const direct = new ClassSessionPagesService(database);
  for (const actor of [NONE, MIXED]) {
    await assert.rejects(direct.list(actor.read(), {}), (error) => error?.getStatus?.() === 403 && error.getResponse().code === 'CLASS_SESSIONS_READ_FORBIDDEN', `direct service call as ${actor.subject}`);
    checks += 1;
  }
  await assert.rejects(direct.list(READER.read({ schoolId: ids.schoolB }), {}), (error) => error?.getStatus?.() === 403, 'direct call with a forged school scope');
  checks += 1;
  for (const patch of [{ principalType: 'AI_AGENT' }, { source: 'AUTOMATION' }, { actionRequestId: randomUUID() }, { delegatedByPrincipalId: NONE.principal }]) {
    await assert.rejects(direct.list(READER.read(patch), {}), (error) => error?.getStatus?.() === 403 && error.getResponse().code === 'HUMAN_COMMAND_REQUIRED', `non-human context ${JSON.stringify(patch)}`);
    checks += 1;
  }

  // 7. Browser-only transport.
  for (const [headers, label] of [[{ 'X-Hon-Human-Read': 'other' }, 'wrong read header'], [{ 'Sec-Fetch-Site': 'cross-site' }, 'cross-site'], [{ 'X-Hon-Source': 'AI_AGENT' }, 'x-hon-source'],
    [{ Origin: 'https://evil.example' }, 'foreign origin'], [{ 'X-School-Id': ids.schoolB }, 'authority header']]) {
    await refused(() => list(READER, {}, { headers }), 403, 'HUMAN_UI_REQUIRED', label);
  }

  // 8. Page two re-decides authority live.
  const pageTwo = async (label, change, undo) => {
    const one = await page(() => list(READER, { limit: 10 }), `${label} page one`);
    await sql(change[0], change[1]);
    try { await refused(() => list(READER, { limit: 10, cursor: one.meta.nextCursor }), 403, undefined, `page two after ${label}`); }
    finally { await sql(undo[0], undo[1]); }
    ok((await page(() => list(READER, { limit: 10, cursor: one.meta.nextCursor }), `${label} restored`)).data.length === 10, `${label}: restoring access restores page two`);
  };
  await pageTwo('permission removed', ["DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='schedule.session.read'", [readerRole]],
    ["INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'schedule.session.read')", [readerRole, ids.organization]]);
  await pageTwo('school suspended', ["UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1", [ids.schoolA]], ["UPDATE hon.schools SET status='ACTIVE' WHERE id=$1", [ids.schoolA]]);
  await pageTwo('organization suspended', ["UPDATE hon.organizations SET status='SUSPENDED' WHERE id=$1", [ids.organization]], ["UPDATE hon.organizations SET status='ACTIVE' WHERE id=$1", [ids.organization]]);
  await pageTwo('entitlement suspended', ["UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [ids.organization]],
    ["UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1", [ids.organization]]);

  // 9. Runtime ACL and zero effects.
  const runtime = new pg.Client(targets.runtime); await runtime.connect();
  try {
    const acl = (await runtime.query(`SELECT has_function_privilege('hon.read_school_class_session_page(text,jsonb)','EXECUTE') pages,
      has_function_privilege('hon.require_current_school_class_sessions_read_actor(text)','EXECUTE') helper, has_table_privilege('hon.class_sessions','SELECT') sessions`)).rows[0];
    ok(acl.pages === true && acl.helper === false && acl.sessions === false, `runtime ACL ${JSON.stringify(acl)}`);
    await assert.rejects(runtime.query("SELECT hon.read_school_class_session_page('x','{}'::jsonb)"), (error) => error.code === '42501');
    checks += 1;
  } finally { await runtime.end(); }
  const publicAcl = (await sql(`SELECT count(*)::int n FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid='hon.read_school_class_session_page(text,jsonb)'::regprocedure AND a.grantee=0`)).rows[0].n;
  ok(publicAcl === 0, 'no PUBLIC EXECUTE');
  const after = await effects();
  ok(JSON.stringify(after) === JSON.stringify(before) && after.audit === 0 && after.outbox === 0 && after.idempotency === 0, `reads have no effects (${JSON.stringify(after)})`);

  console.log(`Class-session pages integrity (0221, signed HTTP, ${TZ}): ${checks} checks passed. 57 sessions from local midnight (30 in one published millisecond, millisecond steps, 300 days out, every status) at 4 page sizes in published order with exact facts, equal to the bounded read, explicit from dates, exact school and organization, signed cursors bound to school and from, invalid queries refused, schedule.session.read with an independent definer decision, browser-only transport, page two refused after permission loss or school/organization/entitlement suspension, function-only runtime ACL, zero effects.`);
} finally {
  try { await app?.close(); } finally {
    try { if (runtimeSessionSelect) await sql(`GRANT SELECT ON TABLE hon.class_sessions TO ${CRM_CLOSE_RUNTIME_ROLE}`); } finally {
      try { await database.close?.(); } finally { try { await cleanup(); } finally { await admin.end(); } } } }
}
