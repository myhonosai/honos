/**
 * Class Sessions read: one deterministic ordering rule across SQL ordering, the 50-row
 * boundary, published millisecond timestamps and the closed response contract.
 *
 * Real path: signed HON session cookie -> Nest HonIdentityGuard + ClassSessionsReadHumanUiGuard
 * -> ClassSessionsReadController -> restricted runtime role -> SECURITY DEFINER projection on
 * the guarded disposable localhost fixture. Fixtures deliberately keep sub-millisecond
 * PostgreSQL precision; nothing is normalized to milliseconds to hide the defect.
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireClassSessionsReadLocalUrls } from './class-sessions-read-local-guard.mjs';
import { verifyClassSessionsReadSecurity } from './class-sessions-read-security.mjs';

requireClassSessionsReadLocalUrls();
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const apiRequire = createRequire(resolve(repo, 'apps/api/package.json'));
apiRequire('reflect-metadata');
const { Test } = apiRequire('@nestjs/testing');
const { issueSession, HON_SESSION_COOKIE } = await import(pathToFileURL(apiRequire.resolve('@hon/auth')).href);
const load = (path) => import(pathToFileURL(resolve(repo, 'apps/api/dist', path)).href);
const { RuntimeDatabaseService } = await load('foundation/runtime-database.service.js');
const { HonIdentityGuard } = await load('foundation/hon-identity.guard.js');
const { HonIdentityService } = await load('foundation/hon-identity.service.js');
const { ClassSessionsReadController } = await load('schedule/class-sessions-read.controller.js');
const { ClassSessionsReadHumanUiGuard } = await load('schedule/class-sessions-read-human-ui.guard.js');
const { ClassSessionsReadService } = await load('schedule/class-sessions-read.service.js');

const owner = new URL(process.env.DATABASE_URL ?? ''), runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
const admin = new pg.Client({ connectionString: owner.toString(), ssl: false });
// Disposable per-run signing material; never a real credential.
const session = { mode: 'OIDC', audience: 'hon-class-sessions-microsecond-order', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const ids = Object.fromEntries(['org', 'school', 'user', 'staff', 'role', 'grant', 'program'].map((key) => [key, randomUUID()]));
const subject = `class-sessions-us-${randomUUID()}`;
/** Valid v4 UUIDs whose leading byte forces a known PostgreSQL/lexicographic order. */
const uuidStarting = (prefix) => `${prefix}${randomUUID().slice(prefix.length)}`;
const low = (n = 0) => uuidStarting(`0${n.toString(16)}`), high = (n = 0) => uuidStarting(`f${n.toString(16)}`);
const sql = (text, values = []) => admin.query(text, values);
let app, database;

async function clearSessions() { await sql('DELETE FROM hon.class_sessions WHERE organization_id=$1', [ids.org]); }
/** `offsetMicros` is microseconds after 00:00 UTC on the given day offset; precision is preserved. */
let baseDay; // one UTC calendar day captured once, so a run crossing midnight cannot drift
async function insertSession(id, name, offsetMicros, dayOffset = 1) {
  await sql(`INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status,created_at)
    VALUES($1,$2,$3,$4,$5,
      ($6::date+$7::integer+$8::bigint*interval '1 microsecond') AT TIME ZONE 'UTC',
      ($6::date+$7::integer+$8::bigint*interval '1 microsecond'+interval '45 minutes') AT TIME ZONE 'UTC',
      10,'WALK_IN','SCHEDULED',
      ($6::date-2+interval '0.000777 seconds') AT TIME ZONE 'UTC')`,
  [id, ids.org, ids.school, ids.program, name, baseDay, dayOffset, offsetMicros]);
}
/** Expected UTC publication for a session, computed independently in JavaScript (truncation). */
function expectedIso(dayOffset, offsetMicros) {
  return new Date(Date.parse(`${baseDay}T00:00:00.000Z`) + dayOffset * 86_400_000 + Math.floor(offsetMicros / 1000)).toISOString();
}

let origin;
async function startApp() {
  database = new RuntimeDatabaseService();
  const module = await Test.createTestingModule({
    controllers: [ClassSessionsReadController],
    providers: [HonIdentityGuard, HonIdentityService, ClassSessionsReadHumanUiGuard, ClassSessionsReadService, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false }); app.setGlobalPrefix('v1'); await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`; process.env.HON_PUBLIC_ORIGIN = origin;
}
// Closing Nest runs RuntimeDatabaseService.onModuleDestroy, which ends its pool exactly once.
async function stopApp() { await app?.close(); app = undefined; database = undefined; }
/** node:http keeps the exact browser Sec-Fetch headers (fetch/undici rewrites Sec-Fetch-Mode). */
function httpRead(subjectValue = subject) {
  const target = new URL(`${origin}/v1/organizations/${ids.org}/schools/${ids.school}/schedule/sessions`);
  return new Promise((resolvePromise, reject) => {
    const request = http.request(target, { method: 'GET', headers: {
      Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: subjectValue }, session)}`,
      Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'empty',
      'X-HON-Human-Read': 'class-sessions',
    } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => { try { resolvePromise({ status: response.statusCode, body: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    request.on('error', reject);
    request.end();
  });
}
async function readOk(label) {
  const { status, body } = await httpRead();
  assert.equal(status, 200, `${label}: expected HTTP 200, got ${status} ${JSON.stringify(body)}`);
  assert(Array.isArray(body.data), `${label}: data array required`);
  return body.data;
}

await admin.connect();
try {
  const marker = (await sql("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.deepEqual(marker, { owner: 'hon_class_sessions_read_owner', marker: 'HON disposable class sessions read validation' });
  await verifyClassSessionsReadSecurity(admin, runtime.username);
  baseDay = (await sql("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') d")).rows[0].d;

  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PRIVATE_ORG','PRIVATE_ORG')", [ids.org]);
  await sql("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'PRIVATE_SCHOOL',$3)", [ids.school, ids.org, `school-${ids.school}`]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',now()-interval '1 day')", [ids.org]);
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_PERSON')", [ids.user, subject, `${ids.user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'PRIVATE_STAFF')", [ids.staff, ids.user]);
  await sql("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'SESSION_READER_US','PRIVATE_ROLE')", [ids.role, ids.org]);
  await sql("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'schedule.session.read')", [ids.role, ids.org]);
  await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,now()-interval '1 day')", [ids.grant, ids.org, ids.school, ids.staff, ids.role]);
  await sql("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'PRIVATE_PROGRAM','SCHEDULED')", [ids.program, ids.org, ids.school]);

  await startApp();

  // 1. Formerly failing case: distinct PostgreSQL microseconds inside one published millisecond,
  //    where the earlier microsecond has the larger UUID. Unfixed 0147 returns HTTP 500.
  const microLate = low(1), microEarly = high(1);
  await clearSessions();
  await insertSession(microEarly, 'Micro early, high UUID', 36_000_123_400);
  await insertSession(microLate, 'Micro late, low UUID', 36_000_123_900);
  const microsecond = await readOk('microsecond collision');
  assert.deepEqual(microsecond.map((item) => item.sessionId), [microLate, microEarly], 'Same published millisecond orders by UUID.');
  assert.deepEqual(microsecond.map((item) => item.startsAt), [expectedIso(1, 36_000_123_900), expectedIso(1, 36_000_123_400)]);
  assert.equal(microsecond[0].startsAt, microsecond[1].startsAt, 'Both publish the same truncated UTC millisecond.');
  assert.match(microsecond[0].startsAt, /\.123Z$/, 'Published timestamps truncate, never round, to milliseconds.');

  // 2. Exact PostgreSQL timestamp tie (identical microseconds): UUID ascending.
  const tieA = low(2), tieB = high(2);
  await clearSessions();
  await insertSession(tieB, 'Exact tie high UUID', 36_000_500_250);
  await insertSession(tieA, 'Exact tie low UUID', 36_000_500_250);
  assert.deepEqual((await readOk('exact tie')).map((item) => item.sessionId), [tieA, tieB]);

  // 3. Reverse UUID order across distinct milliseconds: time first, UUID never overrides it.
  const firstHigh = high(3), secondLow = low(3);
  await clearSessions();
  await insertSession(firstHigh, 'Earlier ms high UUID', 36_000_000_999);
  await insertSession(secondLow, 'Later ms low UUID', 36_000_001_000);
  const reverse = await readOk('reverse uuid');
  assert.deepEqual(reverse.map((item) => item.sessionId), [firstHigh, secondLow]);
  assert.deepEqual(reverse.map((item) => item.startsAt), [expectedIso(1, 36_000_000_999), expectedIso(1, 36_000_001_000)]);

  // 4. 50-row boundary: 49 earlier rows, then two rows sharing the 50th published millisecond.
  //    The single rule (published ms, UUID) must decide which one is included.
  await clearSessions();
  for (let i = 0; i < 49; i += 1) await insertSession(randomUUID(), `Boundary ${String(i).padStart(2, '0')}`, 30_000_000_000 + i * 60_000_000);
  const boundaryIncluded = low(4), boundaryExcluded = high(4);
  await insertSession(boundaryExcluded, 'Boundary early microsecond, high UUID', 40_000_042_100);
  await insertSession(boundaryIncluded, 'Boundary late microsecond, low UUID', 40_000_042_800);
  const boundary = await readOk('50-row boundary');
  assert.equal(boundary.length, 50);
  assert.equal(boundary[49].sessionId, boundaryIncluded, 'The 50th row follows the published (millisecond, UUID) rule.');
  assert(!boundary.some((item) => item.sessionId === boundaryExcluded), 'The 51st row by the published rule is excluded.');

  // 5. UTC formatting is independent of the runtime session TimeZone.
  await clearSessions();
  const zoned = randomUUID();
  await insertSession(zoned, 'Zoned', 82_800_000_001); // 23:00:00.000001 UTC: another calendar day in +05:45
  // Database-level default (owner-settable) applies to every new runtime connection.
  await stopApp();
  await sql("ALTER DATABASE hon_class_sessions_read_validation SET TimeZone='Asia/Kathmandu'");
  try {
    await startApp();
    assert.equal((await database.withTenantReadOnlyTransaction({ organizationId: ids.org, schoolId: ids.school, principalId: ids.staff, externalSubject: subject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: '' },
      async (client) => (await client.query('SHOW TimeZone')).rows[0].TimeZone)), 'Asia/Kathmandu', 'Runtime connection must really run under a non-UTC TimeZone.');
    const zonedRead = await readOk('non-UTC session TimeZone');
    assert.equal(zonedRead[0].startsAt, expectedIso(1, 82_800_000_001));
    assert.match(zonedRead[0].startsAt, /T23:00:00\.000Z$/);
    assert.match(zonedRead[0].createdAt, /\.000Z$/);
  } finally {
    await stopApp();
    await sql('ALTER DATABASE hon_class_sessions_read_validation RESET TimeZone');
    await startApp();
  }

  // 6. Repeat reads of the microsecond collision set are byte-identical and stable.
  await clearSessions();
  const repeatIds = [low(5), high(5), low(6), high(6)];
  await insertSession(repeatIds[1], 'Repeat A', 36_000_777_100);
  await insertSession(repeatIds[0], 'Repeat B', 36_000_777_900);
  await insertSession(repeatIds[3], 'Repeat C', 36_000_777_900);
  await insertSession(repeatIds[2], 'Repeat D', 36_000_777_100);
  const reads = [];
  for (let i = 0; i < 5; i += 1) reads.push(JSON.stringify(await readOk(`repeat ${i}`)));
  assert.equal(new Set(reads).size, 1, 'Repeat reads must be identical.');
  assert.deepEqual(JSON.parse(reads[0]).map((item) => item.sessionId), [...repeatIds].sort());

  // Authorization is unchanged by the ordering fix: an unknown signed subject is still 403.
  assert.equal((await httpRead(`unknown-${randomUUID()}`)).status, 403);
  await verifyClassSessionsReadSecurity(admin, runtime.username);
  await clearSessions();
  console.log('PASS: signed-session HTTP 200 for PostgreSQL microsecond collisions; SQL order, 50-row boundary, published UTC millisecond timestamps and the closed contract share one (published millisecond, UUID) rule; exact ties, reverse UUIDs, non-UTC session TimeZone and repeat reads verified.');
} finally {
  await stopApp();
  await admin.end();
}
