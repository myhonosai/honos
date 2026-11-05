/**
 * Class Sessions: real native browser -> production Next.js rewrite -> Nest guards -> PostgreSQL.
 *
 * Regression for PR #143 run 42068818674: ordinary browser GETs to the current-school class-session
 * endpoint returned HTTP 403. Browsers omit `Origin` on same-origin GET (Fetch standard) and Next's
 * rewrite proxy always sets `X-Forwarded-Host`; the read guard demanded the first and refused the second.
 *
 * Nothing here adds an Origin or any forwarding header to the browser path: Chromium issues the exact
 * request init the production client uses (asserted against its source), Next proxies it unchanged, and
 * Nest runs the real HonIdentityGuard, transport guards, controllers, services and restricted runtime
 * role against the guarded disposable localhost fixture. Spoofing negatives go straight to Nest.
 * The POST leg is real through transport, identity and database scope resolution; only the final
 * session write is a recording stand-in, because this read fixture deliberately denies the runtime
 * role direct class_sessions table access (the write itself is unchanged and covered elsewhere).
 *
 * Requires: built apps/api (dist) and apps/web (.next, production build), Chromium. Optional:
 * HON_BROWSER_TOOLS (dir with playwright-core installed), HON_BROWSER_CHROME (executable path).
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireClassSessionsReadLocalUrls } from './class-sessions-read-local-guard.mjs';
import { verifyClassSessionsReadSecurity } from './class-sessions-read-security.mjs';

requireClassSessionsReadLocalUrls();
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const webDir = resolve(repo, 'apps/web');
assert(existsSync(join(webDir, '.next/BUILD_ID')), 'apps/web must be built (pnpm --filter @hon/web build) before this proof.');
const apiRequire = createRequire(resolve(repo, 'apps/api/package.json'));
apiRequire('reflect-metadata');
const { Test } = apiRequire('@nestjs/testing');
const { ValidationPipe } = apiRequire('@nestjs/common');
const { json } = apiRequire('express');
const { issueSession, HON_SESSION_COOKIE } = await import(pathToFileURL(apiRequire.resolve('@hon/auth')).href);
const load = (path) => import(pathToFileURL(resolve(repo, 'apps/api/dist', path)).href);
const { RuntimeDatabaseService } = await load('foundation/runtime-database.service.js');
const { HonIdentityGuard } = await load('foundation/hon-identity.guard.js');
const { HonIdentityService } = await load('foundation/hon-identity.service.js');
const { ClassSessionsReadController } = await load('schedule/class-sessions-read.controller.js');
const { ClassSessionsReadHumanUiGuard } = await load('schedule/class-sessions-read-human-ui.guard.js');
const { ClassSessionsReadService } = await load('schedule/class-sessions-read.service.js');
const { ClassSessionController } = await load('schedule/class-session.controller.js');
const { ClassSessionHumanUiGuard } = await load('schedule/class-session-human-ui.guard.js');
const { ClassSessionService } = await load('schedule/class-session.service.js');
/** Records the authorized command the real controller hands to the write service. */
const commands = [];
const recordingClassSessions = { async create(context, input) {
  commands.push({ context, input });
  return { replayed: false, classSession: { id: randomUUID(), programId: input.programId, name: input.name, startsAt: input.startsAt, endsAt: input.endsAt, capacity: input.capacity, bookingPolicy: input.bookingPolicy, status: 'SCHEDULED', version: 1, createdAt: new Date().toISOString() } };
} };

const toolsRequire = process.env.HON_BROWSER_TOOLS ? createRequire(join(process.env.HON_BROWSER_TOOLS, 'package.json')) : createRequire(import.meta.url);
let chromium;
try { ({ chromium } = toolsRequire('playwright-core')); } catch { ({ chromium } = toolsRequire('playwright')); }

// The browser must issue exactly what production issues; fail if the client source drifts.
const READ_INIT = { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json', 'X-HON-Human-Read': 'class-sessions' } };
const COMMAND_INIT = { method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' };
const readSource = readFileSync(join(webDir, 'src/components/class-sessions-read-http.ts'), 'utf8');
assert(readSource.includes("method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',")
  && readSource.includes("headers: { Accept: 'application/json', 'X-HON-Human-Read': 'class-sessions' },"), 'Production Class Sessions read init changed; update this proof.');
const commandSource = readFileSync(join(webDir, 'src/components/class-session-workbench-http.ts'), 'utf8');
assert(commandSource.includes("method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',")
  && commandSource.includes("headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': command.key, 'X-HON-Human-Command': 'class-session' },"), 'Production class-session command init changed; update this proof.');

const API_PORT = 3001; // the web build's rewrite destination (HON_API_BASE_URL default)
const WEB_PORT = 3000;
const publicOrigin = `http://127.0.0.1:${WEB_PORT}`;
const crossOrigin = `http://localhost:${WEB_PORT}`; // a different origin served by the same Next server
const apiOrigin = `http://127.0.0.1:${API_PORT}`;

const owner = new URL(process.env.DATABASE_URL ?? ''), runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
const admin = new pg.Client({ connectionString: owner.toString(), ssl: false });
// Disposable per-run signing material; never a real credential.
const session = { mode: 'OIDC', audience: 'hon-class-sessions-native-browser', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;
process.env.HON_PUBLIC_ORIGIN = publicOrigin;

const ids = Object.fromEntries(['org', 'school', 'otherSchool', 'user', 'staff', 'role', 'grant', 'program', 'seeded'].map((key) => [key, randomUUID()]));
const subject = `class-sessions-native-${randomUUID()}`;
const sql = (text, values = []) => admin.query(text, values);
const readPath = (schoolId = ids.school) => `/v1/organizations/${ids.org}/schools/${schoolId}/schedule/sessions`;
const cookieFor = (subjectValue = subject) => issueSession({ externalSubject: subjectValue }, session);

/** Every request Nest receives, with the status it answered. */
const received = [];
let app, next, browser;

async function startApi() {
  const module = await Test.createTestingModule({
    controllers: [ClassSessionsReadController, ClassSessionController],
    providers: [HonIdentityGuard, HonIdentityService, ClassSessionsReadHumanUiGuard, ClassSessionsReadService, ClassSessionHumanUiGuard, RuntimeDatabaseService,
      { provide: ClassSessionService, useValue: recordingClassSessions }],
  }).compile();
  // Same transport as apps/api/src/main.ts: no default body parser, strict JSON, global validation.
  app = module.createNestApplication({ logger: process.env.HON_PROOF_DEBUG ? ['error'] : false, bodyParser: false, cors: false });
  app.use(json({ limit: '2mb', strict: true }));
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.getHttpServer().prependListener('request', (request, response) => {
    const entry = { method: request.method, url: request.url, headers: { ...request.headers }, status: undefined };
    received.push(entry); response.on('finish', () => { entry.status = response.statusCode; });
  });
  await app.listen(API_PORT, '127.0.0.1');
}

async function startWeb() {
  const nextBin = createRequire(join(webDir, 'package.json')).resolve('next/dist/bin/next');
  // Only what the production web server needs; no database URL or other credential reaches Next.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    HON_DEPLOYMENT_ENVIRONMENT: 'preview', HON_AUTH_MODE: session.mode, HON_SESSION_AUDIENCE: session.audience,
    HON_SESSION_JWT_SECRET: session.secret, HON_API_BASE_URL: apiOrigin, HON_PUBLIC_ORIGIN: publicOrigin };
  let output = '';
  next = spawn(process.execPath, [nextBin, 'start', '--hostname', '127.0.0.1', '--port', String(WEB_PORT)], { cwd: webDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  next.stdout.on('data', (chunk) => { output += chunk; }); next.stderr.on('data', (chunk) => { output += chunk; });
  for (let i = 0; i < 200; i += 1) {
    try { await fetch(`${publicOrigin}/robots.txt`); return; } catch { await new Promise((r) => setTimeout(r, 150)); }
    if (next.exitCode !== null) break;
  }
  throw new Error(`Next did not start:\n${output.slice(-2000)}`);
}

/** Raw node:http straight to Nest (no browser, no Next) for spoofing negatives. */
function direct(method, path, headers, body) {
  return new Promise((resolvePromise, reject) => {
    const request = http.request(new URL(apiOrigin + path), { method, headers }, (response) => {
      let text = ''; response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolvePromise({ status: response.statusCode, text }));
    });
    request.on('error', reject); if (body) request.write(body); request.end();
  });
}
const browserLike = (patch = {}) => ({ Cookie: `${HON_SESSION_COOKIE}=${cookieFor()}`, 'X-HON-Human-Read': 'class-sessions', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'empty', ...patch });

async function nativeRead(page, path, init = READ_INIT) {
  return page.evaluate(async ([target, requestInit]) => {
    try { const response = await fetch(target, requestInit); return { status: response.status, body: await response.text() }; }
    catch (error) { return { blocked: String(error) }; }
  }, [path, init]);
}
function lastReceived(method, path) {
  const match = received.filter((entry) => entry.method === method && entry.url === path).at(-1);
  assert(match, `Nest never received ${method} ${path}`); return match;
}

await admin.connect();
try {
  const marker = (await sql("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.deepEqual(marker, { owner: 'hon_class_sessions_read_owner', marker: 'HON disposable class sessions read validation' });
  await verifyClassSessionsReadSecurity(admin, runtime.username);

  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PRIVATE_ORG','PRIVATE_ORG')", [ids.org]);
  await sql("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'PRIVATE_SCHOOL',$3),($4,$2,'PRIVATE_OTHER_SCHOOL',$5)", [ids.school, ids.org, `school-${ids.school}`, ids.otherSchool, `school-${ids.otherSchool}`]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',now()-interval '1 day')", [ids.org]);
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_PERSON')", [ids.user, subject, `${ids.user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'PRIVATE_STAFF')", [ids.staff, ids.user]);
  await sql("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'SESSION_NATIVE','PRIVATE_ROLE')", [ids.role, ids.org]);
  await sql("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'schedule.session.read'),($1,$2,'schedule.session.manage')", [ids.role, ids.org]);
  // Grant is scoped to ONE school; the other school in the same organization stays unauthorized.
  await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,now()-interval '1 day')", [ids.grant, ids.org, ids.school, ids.staff, ids.role]);
  await sql("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'PRIVATE_PROGRAM','SCHEDULED')", [ids.program, ids.org, ids.school]);
  await sql(`INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status)
    VALUES($1,$2,$3,$4,'Seeded native session',now()+interval '1 day',now()+interval '1 day 45 minutes',10,'WALK_IN','SCHEDULED')`, [ids.seeded, ids.org, ids.school, ids.program]);

  await startApi();
  await startWeb();
  browser = await chromium.launch({ headless: true, ...(process.env.HON_BROWSER_CHROME ? { executablePath: process.env.HON_BROWSER_CHROME } : {}) });
  const context = await browser.newContext();
  // The real session cookie, host-only for the public origin, exactly as the sign-in route sets it.
  await context.addCookies([{ name: HON_SESSION_COOKIE, value: cookieFor(), url: publicOrigin, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  await page.goto(`${publicOrigin}/robots.txt`);

  // 1. The failing case: the native production GET through Next now returns the verified list.
  const nativeGet = await nativeRead(page, `/api${readPath()}`);
  assert.equal(nativeGet.status, 200, `native browser GET via Next: expected 200, got ${JSON.stringify(nativeGet)}`);
  const listed = JSON.parse(nativeGet.body);
  assert.deepEqual(Object.keys(listed).sort(), ['data', 'meta']);
  assert(listed.data.some((item) => item.sessionId === ids.seeded), 'seeded session must be listed');
  const getSeen = lastReceived('GET', readPath());
  assert.equal(getSeen.headers.origin, undefined, 'Proof precondition: the browser sent no Origin on the same-origin GET.');
  assert.equal(getSeen.headers['x-forwarded-host'], `127.0.0.1:${WEB_PORT}`, 'Proof precondition: Next set X-Forwarded-Host to the browser Host.');
  assert.equal(getSeen.headers['sec-fetch-site'], 'same-origin'); assert.equal(getSeen.headers['sec-fetch-mode'], 'same-origin'); assert.equal(getSeen.headers['sec-fetch-dest'], 'empty');
  assert.equal(getSeen.headers['x-forwarded-for'], undefined, 'Next did not add X-Forwarded-For on this path.');

  // 2. The native production POST through Next (Origin present + X-Forwarded-Host) creates a session.
  const startsAt = new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 2 * 86_400_000).toISOString();
  const endsAt = new Date(Date.parse(startsAt) + 3_600_000).toISOString();
  const createBody = JSON.stringify({ programId: ids.program, name: 'Native browser session', startsAt, endsAt, capacity: 8, bookingPolicy: 'REQUIRED_BOOKING' });
  const created = await page.evaluate(async ([target, init, body, key]) => {
    const response = await fetch(target, { ...init, headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-HON-Human-Command': 'class-session' }, body });
    return { status: response.status, body: await response.text() };
  }, [`/api${readPath()}`, COMMAND_INIT, createBody, randomUUID()]);
  assert.equal(created.status, 201, `native browser POST via Next: expected 201, got ${JSON.stringify(created)}`);
  const postSeen = lastReceived('POST', readPath());
  assert.equal(postSeen.headers.origin, publicOrigin, 'The browser sends Origin on POST; the command guard still requires it.');
  assert.equal(postSeen.headers['x-forwarded-host'], `127.0.0.1:${WEB_PORT}`);
  assert.equal(commands.length, 1, 'Exactly one authorized command reached the write service.');
  assert.deepEqual({ organizationId: commands[0].context.organizationId, schoolId: commands[0].context.schoolId, principalId: commands[0].context.principalId, source: commands[0].context.source },
    { organizationId: ids.org, schoolId: ids.school, principalId: ids.staff, source: 'HUMAN_UI' }, 'Scope came from the database, not from headers.');

  // 3. Native browser negatives through the same Next path.
  const noMarker = await nativeRead(page, `/api${readPath()}`, { ...READ_INIT, headers: { Accept: 'application/json' } });
  assert.equal(noMarker.status, 403, 'GET without the human read header stays 403.');
  const otherSchool = await nativeRead(page, `/api${readPath(ids.otherSchool)}`);
  assert.equal(otherSchool.status, 403, 'Same organization, ungranted school stays 403 (tenant scope is enforced).');
  const getsBefore = received.filter((entry) => entry.method === 'GET').length;
  const crossPage = await context.newPage(); await crossPage.goto(`${crossOrigin}/robots.txt`);
  const cross = await nativeRead(crossPage, `${publicOrigin}/api${readPath()}`, { ...READ_INIT, mode: 'cors', credentials: 'include' });
  assert(cross.blocked, `Cross-origin browser read must be blocked by the browser, got ${JSON.stringify(cross)}`);
  assert.equal(received.filter((entry) => entry.method === 'GET').length, getsBefore, 'The cross-origin GET never reached Nest (preflight not granted).');
  await crossPage.close();
  await context.clearCookies();
  assert.equal((await nativeRead(page, `/api${readPath()}`)).status, 401, 'No session cookie stays 401.');
  await context.addCookies([{ name: HON_SESSION_COOKIE, value: cookieFor(`unknown-${randomUUID()}`), url: publicOrigin, httpOnly: true, sameSite: 'Lax' }]);
  assert.equal((await nativeRead(page, `/api${readPath()}`)).status, 403, 'Signed session for an unknown subject stays 403.');

  // 4. Spoofing negatives sent straight to Nest with a valid session (what a non-browser client could try).
  assert.equal((await direct('GET', readPath(), browserLike())).status, 200, 'Direct same-origin metadata without Origin or forwarding headers.');
  for (const [label, patch] of [
    ['wrong Origin', { Origin: 'https://evil.test' }], ['opaque Origin', { Origin: 'null' }],
    ['mismatched X-Forwarded-Host', { 'X-Forwarded-Host': 'evil.test' }], ['list X-Forwarded-Host', { 'X-Forwarded-Host': `127.0.0.1:${WEB_PORT}, evil.test` }],
    ['X-Forwarded-For', { 'X-Forwarded-For': '203.0.113.9' }], ['X-Forwarded-Proto', { 'X-Forwarded-Proto': 'https' }], ['Forwarded', { Forwarded: 'host=evil.test' }], ['X-Real-IP', { 'X-Real-IP': '203.0.113.9' }],
    ['cross-site metadata', { 'Sec-Fetch-Site': 'cross-site' }], ['navigation metadata', { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }],
    ['missing marker', { 'X-HON-Human-Read': undefined }], ['principal injection', { 'X-Principal-Id': ids.staff }], ['school injection', { 'X-School-Id': ids.otherSchool }],
  ]) {
    const headers = Object.fromEntries(Object.entries(browserLike(patch)).filter(([, value]) => value !== undefined));
    assert.equal((await direct('GET', readPath(), headers)).status, 403, `direct GET ${label} must be 403`);
  }
  const commandHeaders = (patch = {}) => Object.fromEntries(Object.entries({ Cookie: `${HON_SESSION_COOKIE}=${cookieFor()}`, Origin: publicOrigin, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'X-HON-Human-Command': 'class-session', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'empty', ...patch }).filter(([, value]) => value !== undefined));
  for (const [label, patch] of [['missing Origin', { Origin: undefined, 'X-Forwarded-Host': `127.0.0.1:${WEB_PORT}` }], ['mismatched X-Forwarded-Host', { 'X-Forwarded-Host': 'evil.test' }], ['X-Forwarded-For', { 'X-Forwarded-For': '203.0.113.9' }]]) {
    assert.equal((await direct('POST', readPath(), commandHeaders(patch), createBody)).status, 403, `direct POST ${label} must be 403`);
  }
  assert.equal(commands.length, 1, 'Rejected commands never reached the write service.');

  await verifyClassSessionsReadSecurity(admin, runtime.username);
  console.log('PASS: real Chromium -> production Next rewrite -> Nest -> PostgreSQL: native same-origin GET (no Origin, Next X-Forwarded-Host) returns 200 and the native POST passes transport, identity and database scope; missing marker, ungranted school, cross-origin, no session and unknown subject stay blocked; direct spoofed Origin/forwarding/metadata/authority headers stay 403.');
} finally {
  await browser?.close().catch(() => {});
  if (next && next.exitCode === null) { next.kill('SIGTERM'); await new Promise((r) => { next.once('exit', r); setTimeout(r, 5000); }); }
  await app?.close();
  await sql('DELETE FROM hon.class_sessions WHERE organization_id=$1', [ids.org]).catch(() => {});
  await admin.end();
}
