/** Actual Next entry -> signed HON session -> actual Nest IAM/RLS -> marked disposable PostgreSQL.
 * Test identities/ACTIVE entitlements below are fixtures, never an operating access-exception path. */
import assert from 'node:assert/strict';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { issueSession, HON_SESSION_COOKIE } from '@hon/auth';
import { flexibleBillingAccountsFixture, requireFlexibleBillingAccountsLocalUrls } from '../../../packages/database/scripts/flexible-billing-accounts-local-guard.mjs';
import { requireCanonicalEntryFixture, canonicalEntrySetup } from './owner-entry-canonical-fixture.mjs';

assert.equal(process.env.HON_OWNER_ENTRY_API_TEST, '1');
const urls = await requireFlexibleBillingAccountsLocalUrls();
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const apiRequire = createRequire(join(root, 'apps/api/package.json')), webRequire = createRequire(join(root, 'apps/web/package.json'));
apiRequire('reflect-metadata');
const { Test } = apiRequire('@nestjs/testing'), { ValidationPipe } = apiRequire('@nestjs/common');
const { Client } = createRequire(join(root, 'packages/database/package.json'))('pg');
const ts = webRequire('typescript');
const load = p => import(pathToFileURL(join(root, 'apps/api/dist', p)).href);
const { RuntimeDatabaseService } = await load('foundation/runtime-database.service.js');
const { HonIdentityGuard } = await load('foundation/hon-identity.guard.js'), { HonIdentityService } = await load('foundation/hon-identity.service.js');
const { HqController } = await load('hq/hq.controller.js'), { HqOverviewService } = await load('hq/hq-overview.service.js'), { HqSchoolDirectoryService } = await load('hq/hq-school-directory.service.js');
const { CurrentStaffReportingSchoolController, CurrentStaffReportingSchoolNoStoreGuard } = await load('reports/current-staff-reporting-school.controller.js');
const { StaffReportingSchoolsController } = await load('reports/staff-reporting-schools.controller.js');
const { OperationsReportController } = await load('reports/operations-report.controller.js'), { OperationsReportService } = await load('reports/operations-report.service.js');
let database, canonicalAttempted = false;
const fixture = new Client({ connectionString: urls.DATABASE_URL, ssl: false });
const q = (text, values = []) => fixture.query(text, values);
const auth = { mode: 'OIDC', audience: 'hon-owner-entry-disposable', secret: randomBytes(32).toString('hex') };
Object.assign(process.env, { HON_AUTH_MODE: auth.mode, HON_SESSION_AUDIENCE: auth.audience, HON_SESSION_JWT_SECRET: auth.secret });
const origin = 'http://127.0.0.1:3000', apiOrigin = 'http://127.0.0.1:3001';
const originalFetch = globalThis.fetch, groups = [], browserChecks = [], identityChecks = [], securityChecks = [];
const blockedStaticFontRequests = [];
const canonicalRoleMarker = `HON disposable owner-entry runtime ${randomUUID()}`;
let app, next, browser, actor, nextLog = '', frontendReads = 0;
const pass = name => { groups.push(name); console.log('PASS ' + name); };
const cookie = (who, expired = false) => `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: who.subject, displayName: 'Synthetic test identity' }, auth, expired ? Math.floor(Date.now() / 1000) - 50000 : undefined)}`;
const headers = who => ({ Cookie: cookie(who), 'Sec-Fetch-Site': 'same-origin' });
async function blockExternal(route) {
  const url = new URL(route.request().url());
  if (url.origin === origin) return false;
  // Existing shared CSS requests Google Fonts. Abort before any contact and
  // exercise the installed local fallbacks; no provider request is allowed.
  await route.abort();
  assert(['https://fonts.googleapis.com', 'https://fonts.gstatic.com'].includes(url.origin), 'Unexpected external operation was blocked.');
  blockedStaticFontRequests.push(url.origin); return true;
}
function canonicalAdmin(sql, stage, requireOwnedRole = false) {
  const guard = `DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND datname='${flexibleBillingAccountsFixture.database}'
      AND pg_get_userbyid(datdba)='${flexibleBillingAccountsFixture.owner}' AND shobj_description(oid,'pg_database')='HON disposable flexible billing accounts validation')
    THEN RAISE EXCEPTION 'Unrecognized disposable database'; END IF;
    ${requireOwnedRole ? `IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND shobj_description(oid,'pg_authid')='${canonicalRoleMarker}') THEN RAISE EXCEPTION 'Unrecognized runtime role'; END IF;` : ''}
  END $$;`;
  const result = spawnSync('sudo', ['-u', 'postgres', 'psql', '-X', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '-p', '5432', '-d', flexibleBillingAccountsFixture.database], {
    input: guard + '\n' + sql, encoding: 'utf8', env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Canonical disposable runtime ${stage} failed (credentials redacted).`);
}
async function compile(path, imports = {}) {
  let code = ts.transpileModule(await readFile(join(root, path), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [from, to] of Object.entries(imports)) for (const quote of ["'", '"']) code = code.replaceAll('from ' + quote + from + quote, 'from ' + JSON.stringify(to));
  return 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
}
async function setup(who, hq = false) {
  const a = { user: randomUUID(), principal: randomUUID(), subject: `entry-${who}-${randomUUID()}`, org: randomUUID(), school: randomUUID(), role: randomUUID() };
  await q("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Synthetic entry identity')", [a.user, a.subject, `${a.user}@example.test`]);
  await q("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Synthetic entry principal')", [a.principal, a.user]);
  if (hq) await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.dashboard.view'],clock_timestamp()-interval '1 day')", [a.principal]);
  else {
    await q("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)", [a.org, `Synthetic ${who} organization`]);
    await q("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,$3,$4)", [a.school, a.org, `Synthetic ${who} school`, `entry-${a.school}`]);
    await q("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day')", [a.org]);
    await q("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true)", [a.role, a.org]);
    await q("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'reporting.view')", [a.role, a.org]);
    await q("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')", [a.org, a.school, a.principal, a.role]);
  }
  return a;
}
try {
  await fixture.connect();
  const observed = (await q("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker,EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') AS \"canonicalRoleExists\" FROM pg_database WHERE datname=current_database()")).rows[0];
  requireCanonicalEntryFixture(process.env, urls, observed);
  // Preserve the production guard's alias denial rather than overriding its SQL.
  const alias = new RuntimeDatabaseService();
  try { await assert.rejects(alias.readStaffReportingSchools('synthetic-posture-probe'), error => error.getStatus?.() === 503); }
  finally { await alias.onModuleDestroy(); }
  // Retire the general fixture's alias ACLs, rather than tolerating an extra
  // grantee in the strict canonical verifier. It may own no schema objects;
  // DROP OWNED therefore revokes only this marked test role's privileges here.
  canonicalAdmin(`DO $$ DECLARE role_id oid; BEGIN
    SELECT oid INTO role_id FROM pg_roles WHERE rolname='${flexibleBillingAccountsFixture.runtime}'
      AND shobj_description(oid,'pg_authid')='HON disposable flexible billing accounts validation';
    IF role_id IS NULL OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=role_id)
      OR EXISTS(SELECT 1 FROM pg_proc WHERE proowner=role_id) OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=role_id)
      OR EXISTS(SELECT 1 FROM pg_type WHERE typowner=role_id) THEN RAISE EXCEPTION 'Unexpected fixture alias ownership'; END IF;
  END $$; DROP OWNED BY ${flexibleBillingAccountsFixture.runtime};`, 'marked alias retirement');
  const password = randomBytes(36).toString('base64url');
  canonicalAttempted = true;
  // Unconditional CREATE refuses a competing/pre-existing role, never adopts it.
  canonicalAdmin(`BEGIN; CREATE ROLE hon_runtime LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 20;
    COMMENT ON ROLE hon_runtime IS '${canonicalRoleMarker}'; COMMIT;`, 'fresh role creation');
  canonicalAdmin(canonicalEntrySetup(await readFile(join(root, 'infra/postgres/010_supabase_hon_runtime.sql'), 'utf8'), password), 'full ACL setup', true);
  canonicalAdmin(await readFile(join(root, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8'), 'full verifier', true);
  const runtimeUrl = new URL(urls.HON_RUNTIME_DATABASE_URL); runtimeUrl.username = 'hon_runtime'; runtimeUrl.password = password;
  process.env.HON_RUNTIME_DATABASE_URL = runtimeUrl.href; database = new RuntimeDatabaseService();
  pass('fixture alias remains refused; exact hon_runtime uses full canonical setup/verifier without named-function repair');
  const hq = await setup('HQ', true), a = await setup('A'), b = await setup('B'); actor = a;
  const module = await Test.createTestingModule({ controllers: [HqController, CurrentStaffReportingSchoolController, StaffReportingSchoolsController, OperationsReportController],
    providers: [HonIdentityGuard, HonIdentityService, CurrentStaffReportingSchoolNoStoreGuard, HqOverviewService, HqSchoolDirectoryService, OperationsReportService, { provide: RuntimeDatabaseService, useValue: database }] }).compile();
  app = module.createNestApplication({ logger: false }); app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  await app.listen(3001, '127.0.0.1');
  next = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3000'], { cwd: join(root, 'apps/web'),
    env: { PATH: process.env.PATH, NODE_ENV: 'production', HON_DEPLOYMENT_ENVIRONMENT: 'preview', NEXT_TELEMETRY_DISABLED: '1', HON_AUTH_MODE: auth.mode,
      HON_SESSION_AUDIENCE: auth.audience, HON_SESSION_JWT_SECRET: auth.secret, HON_API_BASE_URL: apiOrigin }, stdio: ['ignore', 'pipe', 'pipe'] });
  next.stdout.on('data', b => { nextLog = (nextLog + b).slice(-4000); }); next.stderr.on('data', b => { nextLog = (nextLog + b).slice(-4000); });
  let ready = false;
  for (let i = 0; i < 120; i++) { try { await originalFetch(`${origin}/auth/continue`, { redirect: 'manual' }); ready = true; break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  assert(ready, 'Production Next failed to start; no successful entry claim.');

  const protectedTables = (await q("SELECT relname FROM pg_class WHERE relnamespace='hon'::regnamespace AND relkind='r' AND relname ~ '^(saas_|ai_|payment|invoice|refund|membership|audit_events|outbox_events|idempotency_records|class_bookings|attendance_records|communication_)' ORDER BY relname")).rows.map(r => r.relname);
  const snapshot = async () => { const values = {}; for (const t of protectedTables) { assert.match(t, /^[a-z_]+$/); values[t] = (await q(`SELECT md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) hash FROM hon.${t} t`)).rows[0].hash; } return values; };
  const before = await snapshot();
  for (const who of [hq, a, b]) {
    const r = await originalFetch(`${origin}/auth/continue`, { headers: headers(who), redirect: 'manual' });
    assert.equal(r.status, 303); assert.equal(r.headers.get('location'), who === hq ? '/hq' : '/staff/dashboard');
    assert.equal(await r.text(), ''); assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  pass('real signed HQ/A/B sessions reach separate fixed authorized landing routes');
  for (const who of [a, b]) {
    const r = await originalFetch(`${apiOrigin}/v1/staff/current-reporting-school`, { headers: headers(who) }); assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { data: { state: 'RESOLVED', organizationId: who.org, schoolId: who.school } });
    assert.equal((await originalFetch(`${apiOrigin}/v1/hq/session`, { headers: headers(who) })).status, 403);
    const foreign = who === a ? b : a;
    assert.equal((await originalFetch(`${apiOrigin}/v1/organizations/${foreign.org}/schools/${foreign.school}/reports/operations`, { headers: headers(who) })).status, 403);
    assert.equal((await originalFetch(`${apiOrigin}/v1/organizations/${who.org}/schools/${foreign.school}/reports/operations`, { headers: headers(who) })).status, 403);
  }
  pass('actual IAM/RLS rejects HQ elevation and foreign-school/organization reporting in both directions');

  // Import the actual browser transport/controller; all its requests use real Next/Nest/DB handlers.
  const invalidation = await compile('apps/web/src/components/session-invalidation.ts');
  const dashboard = await compile('apps/web/src/components/staff-dashboard-http.ts', { '@hon/contracts': pathToFileURL(webRequire.resolve('@hon/contracts')).href });
  const current = await compile('apps/web/src/components/current-staff-reporting-school-http.ts', { './staff-dashboard-http': dashboard });
  const choices = await compile('apps/web/src/components/staff-reporting-schools-http.ts', { './staff-dashboard-http': dashboard });
  const httpUrl = await compile('apps/web/src/components/school-entry/http.ts', { '../current-staff-reporting-school-http': current, '../staff-reporting-schools-http': choices, '../staff-dashboard-http': dashboard, '../session-invalidation': invalidation });
  const navigation = await compile('apps/web/src/components/operational-navigation.ts');
  const { SchoolEntryController } = await import(await compile('apps/web/src/components/school-entry/controller.ts', { './http': httpUrl, '../operational-navigation': navigation }));
  globalThis.fetch = async (path, options = {}) => {
    assert.match(String(path), /^\/api\/(?:identity\/me|v1\/(?:staff\/(?:current-reporting-school|reporting-schools)|organizations\/[a-f0-9-]+\/schools\/[a-f0-9-]+\/reports\/operations))$/);
    assert.equal(options.method, 'GET'); frontendReads++;
    const r = await originalFetch(`${origin}${path}`, { ...options, headers: { ...options.headers, ...headers(actor) } });
    // Node has no browser location; preserve the real response body/headers/status without an artificial URL.
    return new Response(r.body, { status: r.status, headers: r.headers });
  };
  for (const who of [a, b]) {
    actor = who; const controller = new SchoolEntryController(who.subject); await controller.load();
    assert.equal(controller.snapshot().phase, 'READY'); assert.deepEqual(controller.snapshot().selection, { organizationId: who.org, schoolId: who.school }); controller.dispose();
  }
  pass('actual frontend transport verifies exact current-school reports through Next and restricted PostgreSQL');
  actor = a;
  await q("UPDATE hon.principal_role_grants SET effective_until=clock_timestamp()-interval '1 second' WHERE principal_id=$1", [a.principal]);
  let denied = new SchoolEntryController(a.subject); await denied.load(); assert.equal(denied.snapshot().phase, 'UNAVAILABLE'); assert.equal(denied.snapshot().selection, null); denied.dispose();
  await q('UPDATE hon.principal_role_grants SET effective_until=NULL WHERE principal_id=$1', [a.principal]);
  await q("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [a.org]);
  denied = new SchoolEntryController(a.subject); await denied.load(); assert.equal(denied.snapshot().phase, 'UNAVAILABLE'); denied.dispose();
  await q("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1", [a.org]);
  pass('revoked and suspended fixture authority stays unavailable; no access exception or policy approval is recorded');
  const extra = randomUUID();
  await q("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'Synthetic A second school',$3)", [extra, a.org, `entry-${extra}`]);
  await q("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')", [a.org, extra, a.principal, a.role]);
  const multi = new SchoolEntryController(a.subject); await multi.load(); assert.equal(multi.snapshot().phase, 'CHOICE');
  assert.deepEqual(new Set(multi.snapshot().choices.map(c => c.schoolId)), new Set([a.school, extra])); assert.equal(multi.snapshot().selection, null);
  await q("UPDATE hon.principal_role_grants SET effective_until=clock_timestamp()-interval '1 second' WHERE principal_id=$1 AND school_id=$2", [a.principal, extra]);
  await multi.choose(extra, multi.snapshot().revision); assert.equal(multi.snapshot().phase, 'DENIED'); assert.equal(multi.snapshot().selection, null); multi.dispose();
  pass('bounded authorized multi-school selection excludes B and denies authority revoked after the choice read');
  for (const token of ['FORGED', cookie(a, true).split('=')[1]]) {
    const r = await originalFetch(`${origin}/auth/continue`, { headers: { Cookie: `${HON_SESSION_COOKIE}=${token}` }, redirect: 'manual' }); assert.equal(r.headers.get('location'), '/auth/login');
  }
  const forged = await originalFetch(`${origin}/auth/continue?schoolId=${b.school}&role=HON_HQ_OWNER`, { headers: headers(a), redirect: 'manual' }); assert.equal(forged.headers.get('location'), '/auth/access');
  pass('expired/forged sessions and browser-provided school/role routing instructions fail closed');

  assert(process.env.HON_OWNER_ENTRY_TOOLS && process.env.HON_OWNER_ENTRY_CHROME && process.env.HON_OWNER_ENTRY_RESULTS, 'Mounted browser verification is required, not optional.');
  const toolRequire = createRequire(join(process.env.HON_OWNER_ENTRY_TOOLS, 'runner.cjs'));
  const { chromium } = toolRequire('playwright-core'), axe = await readFile(toolRequire.resolve('axe-core/axe.min.js'), 'utf8');
  const results = process.env.HON_OWNER_ENTRY_RESULTS; await mkdir(results, { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.HON_OWNER_ENTRY_CHROME, headless: true, args: ['--no-sandbox'] });
  const { entryText } = await import(await compile('apps/web/src/components/school-entry/copy.ts'));
  for (const [label, who] of [['HQ', hq], ['School A', a], ['School B', b]]) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addCookies([{ name: HON_SESSION_COOKIE, value: cookie(who).split('=')[1], url: origin, httpOnly: true, sameSite: 'Lax' }]);
    await context.route('**/*', async route => { if (!await blockExternal(route)) return route.continue(); });
    const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${origin}/auth/continue`);
    assert.equal(new URL(page.url()).pathname, who === hq ? '/hq' : '/staff/dashboard');
    if (who !== hq) {
      // A single verified school lands on its home; the school entry hub stays one click away.
      await page.goto(`${origin}/staff/entry`);
      await page.getByTestId('entry-crm').waitFor(); const own = new URL(await page.getByTestId('entry-crm').getAttribute('href'), origin);
      assert.equal(own.searchParams.get('schoolId'), who.school); assert.equal(own.searchParams.get('organizationId'), who.org);
      for (const [key, path] of [['team', '/staff/team/invitations'], ['family', '/staff/family-access'], ['dashboard', '/staff/dashboard']]) {
        const url = new URL(await page.getByTestId(`entry-${key}`).getAttribute('href'), origin);
        assert.equal(url.pathname, path); assert.deepEqual([...url.searchParams.entries()], [['organizationId', who.org], ['schoolId', who.school]]);
      }
      const other = who === a ? b : a;
      const denial = await page.evaluate(async path => (await fetch(path, { credentials: 'same-origin', cache: 'no-store' })).status, `/api/v1/organizations/${other.org}/schools/${other.school}/reports/operations`);
      assert.equal(denial, 403); assert(!(await page.getByTestId('entry-private').innerText()).includes(other.school));
    } else await page.getByRole('heading', { level: 1 }).first().waitFor();
    assert.equal(errors.length, 0); identityChecks.push({ label, expectedLanding: who === hq ? '/hq' : '/staff/dashboard', actualIamAndDatabase: true, crossSchoolDenied: who === hq ? 'HQ separate plane' : true }); await context.close();
  }
  pass('mounted HQ/School A/School B navigation and actual cross-school denial preserve separate identity contexts');
  {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addCookies([{ name: HON_SESSION_COOKIE, value: cookie(a).split('=')[1], url: origin, httpOnly: true, sameSite: 'Lax' }]);
    await context.route('**/*', async route => { if (!await blockExternal(route)) return route.continue(); });
    const page = await context.newPage();
    await q('UPDATE hon.principal_role_grants SET effective_until=NULL WHERE principal_id=$1 AND school_id=$2', [a.principal, extra]);
    await page.goto(`${origin}/auth/continue`); await page.getByTestId(`school-choice-${extra}`).waitFor();
    await page.evaluate(() => { window.__entrySessionSignals = 0; window.addEventListener('hon:session-invalidated', () => { window.__entrySessionSignals++; }); });
    await q("UPDATE hon.principal_role_grants SET effective_until=clock_timestamp()-interval '1 second' WHERE principal_id=$1 AND school_id=$2", [a.principal, extra]);
    await page.getByTestId(`school-choice-${extra}`).click();
    await page.getByTestId('entry-status').filter({ hasText: entryText('en', 'DENIED') }).waitFor();
    assert.equal(await page.evaluate(() => window.__entrySessionSignals), 0); assert(await page.getByTestId('entry-private').isHidden());
    assert(!(await page.getByTestId('verify-entry').isDisabled())); securityChecks.push('real post-choice permission revocation returns local 403 without session invalidation');
    await page.getByTestId('verify-entry').click(); await page.getByTestId('entry-crm').waitFor();
    await context.clearCookies(); await page.getByTestId('verify-entry').click();
    await page.getByTestId('entry-status').filter({ hasText: entryText('en', 'SESSION') }).waitFor();
    assert.equal(await page.evaluate(() => window.__entrySessionSignals), 1); assert(await page.getByTestId('entry-private').isHidden());
    assert(await page.getByTestId('verify-entry').isDisabled());
    // Real 401 must remain terminal even after later browser privacy events.
    await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('pagehide')); });
    await page.getByTestId('entry-status').filter({ hasText: entryText('en', 'SESSION') }).waitFor();
    assert(await page.getByTestId('verify-entry').isDisabled()); assert(await page.getByTestId('entry-private').isHidden());
    securityChecks.push('actual authenticated transport 401 stays terminal through blur/pagehide and requires a new signed-in document');
    await context.close();
  }
  pass('mounted real 403 revocation and real 401 loss have distinct local/global privacy outcomes');
  for (const language of ['en', 'ko', 'es']) for (const mode of ['modern', 'classic', 'big']) for (const width of [390, 834, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
    const { createHmac } = await import('node:crypto');
    const presentationScope = createHmac('sha256', auth.secret).update(JSON.stringify(['hon-local-presentation-v1', auth.mode, auth.audience, a.subject])).digest('hex');
    const { localeCookieName, DEFAULT_LOCALE } = await import(pathToFileURL(webRequire.resolve('@hon/design-system')).href);
    await context.addCookies([{ name: HON_SESSION_COOKIE, value: cookie(a).split('=')[1], url: origin, httpOnly: true, sameSite: 'Lax' },
      { name: localeCookieName(presentationScope), value: encodeURIComponent(JSON.stringify({ ...DEFAULT_LOCALE, language })), url: origin, sameSite: 'Lax' }]);
    const calls = [], errors = []; await context.route('**/*', async route => {
      if (await blockExternal(route)) return;
      const url = new URL(route.request().url());
      calls.push({ path: url.pathname, method: route.request().method() }); return route.continue();
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${origin}/staff/entry`); await page.getByTestId('entry-crm').waitFor();
    await page.getByRole('button', { name: entryText(language, mode), exact: true }).click();
    assert.equal(await page.getByTestId('school-entry').getAttribute('data-interface-theme'), mode);
    assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), entryText(language, 'title'));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const crm = page.getByTestId('entry-crm'); await crm.focus(); await page.keyboard.press('Shift'); assert(await crm.evaluate(el => el === document.activeElement && el.matches(':focus-visible')));
    const u = new URL(await crm.getAttribute('href'), origin); assert.equal(u.searchParams.get('schoolId'), a.school); assert.equal(u.searchParams.get('organizationId'), a.org);
    for (const key of ['team', 'family']) {
      const link = page.getByTestId(`entry-${key}`); await link.focus(); await page.keyboard.press('Shift');
      assert(await link.evaluate(el => el === document.activeElement && el.matches(':focus-visible')));
      assert.equal(await link.innerText().then(text => text.includes(entryText(language, key))), true);
      const url = new URL(await link.getAttribute('href'), origin); assert.deepEqual([...url.searchParams.entries()], [['organizationId', a.org], ['schoolId', a.school]]);
    }
    const beforeModeReads = calls.filter(r => /current-reporting-school|reporting-schools|reports\/operations/.test(r.path)).length;
    const otherMode = mode === 'modern' ? 'classic' : 'modern';
    await page.getByRole('button', { name: entryText(language, otherMode), exact: true }).click();
    await page.getByRole('button', { name: entryText(language, mode), exact: true }).click();
    // Exercise the real locale utility's unavailable-remote fallback. Persisted
    // language commands are covered separately; entry must not add domain reads.
    const languageControl = page.locator('[data-locale-utility] select');
    await languageControl.selectOption(language === 'en' ? 'es' : 'en');
    await languageControl.selectOption(language);
    assert.equal(calls.filter(r => /current-reporting-school|reporting-schools|reports\/operations/.test(r.path)).length, beforeModeReads);
    await page.addScriptTag({ content: axe }); const scan = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
    assert.deepEqual(scan.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []);
    await page.screenshot({ path: join(results, `owner-entry-${language}-${mode}-${width}.png`), fullPage: true });
    if (width === 390 && mode === 'modern') {
      assert(await page.evaluate(() => {
        const area = document.querySelector('[data-testid="entry-private"]');
        const link = document.querySelector('[data-testid="entry-crm"]');
        const before = location.href; window.dispatchEvent(new Event('blur'));
        // Check synchronous concealment and a retained anchor in the same JS turn.
        link.click(); return area.hidden && area.inert && location.href === before;
      }));
      assert(await page.getByTestId('entry-private').isHidden());
      await page.getByTestId('verify-entry').click(); await page.getByTestId('entry-crm').waitFor();
      await page.evaluate(() => window.dispatchEvent(new Event('hon:session-invalidated'))); assert(await page.getByTestId('entry-private').isHidden()); assert(await page.getByTestId('verify-entry').isDisabled());
      await page.goto(`${origin}/staff/entry`); await page.getByTestId('entry-crm').waitFor();
      await page.getByTestId('entry-crm').click(); assert.equal(new URL(page.url()).pathname, '/staff/crm/journey');
      assert.equal(await page.getByTestId('organization').inputValue(), a.org); assert.equal(await page.getByTestId('school').inputValue(), a.school);
    }
    assert.equal(errors.length, 0); assert.equal(calls.filter(r => r.method !== 'GET').length, 0, 'Entry navigation must not make business writes.');
    browserChecks.push({ language, mode, width, actualEntryApiAndDatabase: true, languagePersistence: 'unavailable-remote fallback; separately proven contract', axeViolations: 0, pageErrors: 0 }); await context.close();
  }
  pass('27 mounted actual-API/database browser combinations cover EN/KO/ES, all views, keyboard, mobile/tablet/desktop and privacy restoration');
  assert.deepEqual(await snapshot(), before, 'Read-only entry must not change business, audit, outbox, idempotency, payment or AI records.');
  pass(`read-only invariants: ${protectedTables.length} protected tables unchanged; zero business commands/provider calls`);
  await writeFile(join(results, 'owner-entry-report.json'), JSON.stringify({ sourceSha: process.env.HON_OWNER_ENTRY_SHA ?? null, groups, frontendReads, browserChecks, identityChecks, securityChecks,
    signedSyntheticIdentities: true, markedDisposableDatabase: true, actualNextAndNest: true, actualProviderOrOidcLogin: false, protectedTables: protectedTables.length,
    externalProviderCalls: 0, externalPageRequestsAllowed: 0, blockedStaticFontRequests, screenshotFonts: 'installed local fallbacks; external fonts blocked',
    businessCommands: 0, paidAiCalls: 0, screenshots: browserChecks.length, timestampOrderingEvidence: 'Accepted migration 0203; original microsecond HTTP 200 proof runs separately in the same exact-head workflow' }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, groups: groups.length, browserChecks: browserChecks.length, protectedTables: protectedTables.length, providerCalls: 0 }));
} finally {
  globalThis.fetch = originalFetch;
  await browser?.close();
  if (next && next.exitCode === null) { const stopped = new Promise(resolve => next.once('exit', resolve)); next.kill('SIGTERM'); await stopped; }
  // Nest owns the provided RuntimeDatabaseService once compiled; never double-end its pool.
  if (app) await app.close(); else await database?.onModuleDestroy();
  if (canonicalAttempted && (await q("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND shobj_description(oid,'pg_authid')=$1) present", [canonicalRoleMarker])).rows[0].present) {
    canonicalAdmin('DROP OWNED BY hon_runtime; DROP ROLE hon_runtime;', 'fresh-role cleanup', true);
  }
  await fixture.end();
}
