/** Read-only Account & Usage: signed synthetic HON session -> production Next ->
 * actual narrow Nest controllers/identity/IAM -> restricted marked disposable PostgreSQL.
 * No external OIDC/owner-device acceptance, response mocks, header repair, AppModule or workers. */
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHmac } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireAccountStatusRun } from './account-status-verification-support.mjs';
import { nativeTransportObservation } from './owner-workflow-support.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const config = requireAccountStatusRun(process.env, sourceSha, root);
execFileSync('git', ['diff', '--exit-code', 'HEAD', '--'], { cwd: root, stdio: 'pipe' });
assert(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }).trim() === '', 'Exact-head source checkout must be clean.');
// Reuse the actual fixture's strict text + pg-effective-destination guard.
const { championsProofTargets, verifyChampionsProofConnection, CHAMPIONS_OWNER_ROLE, CHAMPIONS_RUNTIME_ROLE } = await import('../../../packages/database/scripts/champions-proof-target.mjs');
const targets = championsProofTargets(process.env);
const descriptor = process.env.HON_CHAMPIONS_ENV_FILE;
assert(descriptor && resolve(descriptor) === descriptor && descriptor.startsWith('/home/ubuntu/jobs/'), 'Private Champions descriptor required.');
const directory = dirname(descriptor), jobs = await realpath('/home/ubuntu/jobs');
assert.equal(await realpath(directory), directory); assert(directory.startsWith(jobs + '/'));
const [directoryStat, descriptorStat] = await Promise.all([lstat(directory), lstat(descriptor)]);
assert(directoryStat.isDirectory() && !directoryStat.isSymbolicLink() && directoryStat.uid === process.getuid() && (directoryStat.mode & 0o777) === 0o700);
assert(descriptorStat.isFile() && !descriptorStat.isSymbolicLink() && descriptorStat.uid === process.getuid() && (descriptorStat.mode & 0o777) === 0o600 && descriptorStat.size < 4096);
assert((await readFile(descriptor, 'utf8')) === `export DATABASE_URL='${process.env.DATABASE_URL}'\nexport HON_RUNTIME_DATABASE_URL='${process.env.HON_RUNTIME_DATABASE_URL}'\n`, 'Descriptor must match fresh fixture output.');

await mkdir(config.results, { recursive: true });
const apiRequire = createRequire(join(root, 'apps/api/package.json')), webRequire = createRequire(join(root, 'apps/web/package.json'));
const toolRequire = createRequire(join(config.tools, 'runner.cjs'));
apiRequire('reflect-metadata');
const { Test } = apiRequire('@nestjs/testing'), { ValidationPipe } = apiRequire('@nestjs/common');
const { Client } = createRequire(join(root, 'packages/database/package.json'))('pg');
const { chromium } = toolRequire('playwright-core');
const axe = await readFile(toolRequire.resolve('axe-core/axe.min.js'), 'utf8');
const { issueSession, HON_SESSION_COOKIE } = await import('@hon/auth');
const contracts = await import('@hon/contracts'), design = await import('@hon/design-system');
const ts = webRequire('typescript');
const load = file => import(pathToFileURL(join(root, 'apps/api/dist', file + '.js')).href);
const classes = {};
for (const file of ['foundation/runtime-database.service', 'foundation/hon-identity.guard', 'foundation/hon-identity.service',
  'school-billing/saas-school-billing.controller', 'school-billing/saas-school-billing.service', 'saas-billing/saas-billing.service',
  'saas-billing/saas-creative-wallet.controller', 'saas-billing/saas-creative-wallet.service', 'saas-billing/saas-billing.guards', 'preferences/language-preferences.controller']) Object.assign(classes, await load(file));
const copyCode = ts.transpileModule(await readFile(join(root, 'apps/web/src/components/account-status/copy.ts'), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { accountText: t, accountValue: value } = await import('data:text/javascript;base64,' + Buffer.from(copyCode).toString('base64'));
const origin = 'http://127.0.0.1:3000', apiOrigin = 'http://127.0.0.1:3001';
const auth = { mode: 'OIDC', audience: 'hon-account-status-disposable', secret: randomBytes(32).toString('hex') };
Object.assign(process.env, { HON_AUTH_MODE: auth.mode, HON_SESSION_AUDIENCE: auth.audience, HON_SESSION_JWT_SECRET: auth.secret, HON_PUBLIC_ORIGIN: origin });
const owner = new Client(targets.owner), q = (sql, params = []) => owner.query(sql, params), actualFetch = globalThis.fetch;
const report = { sourceSha, evidence: 'NATIVE_BROWSER_NEXT_NEST_IAM_RESTRICTED_DISPOSABLE_POSTGRES', passed: false,
  signedSyntheticHonSession: true, externalOidcLogin: false, ownerDeviceAcceptance: false, apiResponsesMocked: false,
  browserHeadersModified: false, authorizationOrScopeOverridden: false, fullAppModule: false, workersStarted: false,
  providerExecutionConfigured: false, externalProviderCalls: null, localePreferenceSource: 'Actual MyLanguagePreferenceController and canonical synthetic EN/KO/ES preferences configured before read-only baseline',
  blockedExternalOrigins: [], nativeBrowserRequests: [], nativeBrowserResponses: [], localeReads: [], nestIngress: [], groups: [], cases: [], screenshots: [] };
let app, database, next, browser, ownerConnected = false, stage = 'verify-disposable-database', currentPage;
const pass = name => { report.groups.push(name); console.log('PASS ACCOUNT STATUS ' + name); };
const token = (who, expired = false) => issueSession({ externalSubject: who.subject, displayName: 'Synthetic account identity' }, auth, expired ? Math.floor(Date.now() / 1000) - 50000 : undefined);
const cookie = who => `${HON_SESSION_COOKIE}=${token(who)}`;
const domainPath = path => /^\/(?:api\/)?v1\/schools\/[a-f0-9-]+\/(?:hon-billing(?:\/access-standing)?|creative-credits)$/.test(path);
const accountPath = school => `/api/v1/schools/${school}/hon-billing`, walletPath = school => `/api/v1/schools/${school}/creative-credits`;
const scopeQuery = (who, pair = true) => `schoolId=${who.school}${pair ? `&organizationId=${who.org}` : ''}`;
async function seed(name, permissions, status = 'ACTIVE', roleCode = 'ACCOUNT_READER', hq = false) {
  const who = { user: randomUUID(), principal: randomUUID(), subject: `account-${name}-${randomUUID()}`, org: randomUUID(), school: randomUUID(), role: randomUUID() };
  await q("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Synthetic account identity')", [who.user, who.subject, `${who.user}@example.test`]);
  await q("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Synthetic account principal')", [who.principal, who.user]);
  if (hq) { await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.dashboard.view'],clock_timestamp()-interval '1 day')", [who.principal]); return who; }
  await q("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)", [who.org, `Synthetic account ${name}`]);
  await q("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,$3,$4)", [who.school, who.org, `Synthetic account ${name}`, `account-${who.school}`]);
  await q("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'CORE',$2,clock_timestamp()-interval '1 day')", [who.org, status]);
  await q('INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,$3,$4)', [who.role, who.org, roleCode, `Synthetic ${name} role`]);
  for (const permission of permissions) await q('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [who.role, who.org, permission]);
  await q("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')", [who.org, who.school, who.principal, who.role]);
  return who;
}
async function snapshot(tables) {
  const result = {};
  for (const table of tables) { assert.match(table, /^[a-z][a-z0-9_]*$/); result[table] = (await q(`SELECT count(*)::int n,md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) hash FROM hon.${table} t`)).rows[0]; }
  return result;
}
async function signedRead(who, path, status, validator) {
  const response = await actualFetch(origin + path, { method: 'GET', headers: { Cookie: cookie(who), Accept: 'application/json' }, redirect: 'error' });
  assert.equal(response.status, status, `Actual signed read ${path} must return ${status}.`);
  if (status === 200) { assert.match(response.headers.get('cache-control') ?? '', /no-store/); const json = await response.json(); assert.deepEqual(Object.keys(json), ['data']); return validator(json.data); }
  if (status === 403) assert.equal((await response.json()).code, 'SAAS_FORBIDDEN'); else await response.arrayBuffer();
}
async function setActor(context, who, expired = false) { await context.addCookies([{ name: HON_SESSION_COOKIE, value: token(who, expired), url: origin, httpOnly: true, sameSite: 'Lax' }]); }
async function open(who, { language = 'en', width = 1280, query = scopeQuery(who) } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
  await setActor(context, who);
  const localeScope = createHmac('sha256', auth.secret).update(JSON.stringify(['hon-local-presentation-v1', auth.mode, auth.audience, who.subject])).digest('hex');
  await context.addCookies([{ name: design.localeCookieName(localeScope), value: encodeURIComponent(JSON.stringify({ ...design.DEFAULT_LOCALE, language })), url: origin, sameSite: 'Lax' }]);
  const requests = [], errors = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { await route.abort(); assert(['https://fonts.googleapis.com', 'https://fonts.gstatic.com'].includes(url.origin), 'Unexpected external request blocked.'); report.blockedExternalOrigins.push(url.origin); return; }
    if (url.pathname.startsWith('/api/')) {
      assert.equal(request.method(), 'GET', 'Account page may only issue GETs.');
      assert(url.pathname === '/api/identity/me' || url.pathname === '/api/v1/me/language-preference' || domainPath(url.pathname), 'Unexpected account API path.');
      const observation = nativeTransportObservation(request.method(), request.url(), await request.allHeaders(), origin);
      requests.push(observation); report.nativeBrowserRequests.push(observation);
    }
    await route.continue(); // Original request, including all browser-generated metadata, is unchanged.
  });
  const page = await context.newPage(); currentPage = page; page.on('pageerror', error => errors.push(error.name));
  page.on('response', response => { const url = new URL(response.url()); if (domainPath(url.pathname)) report.nativeBrowserResponses.push({ method: response.request().method(), path: url.pathname, status: response.status() }); });
  const localeResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/me/language-preference' && response.request().method() === 'GET');
  await page.goto(`${origin}/staff/account-status${query ? '?' + query : ''}`); await page.bringToFront();
  const localeRead = await localeResponse; assert.equal(localeRead.status(), 200, 'Actual locale controller must be mounted.');
  const localeEnvelope = await localeRead.json(); assert.deepEqual(Object.keys(localeEnvelope), ['data']);
  const localeView = contracts.validateMyLanguagePreferenceView(localeEnvelope.data); assert.equal(localeView.effective.language, language);
  report.localeReads.push({ language, status: 200, preferencePresent: localeView.preference !== null });
  await page.getByRole('heading', { name: t(language, 'title'), exact: true }).waitFor();
  if (await page.getByTestId('account-restore').count()) {
    await page.getByTestId('account-restore').click(); await page.getByTestId('account-school').waitFor();
    assert.equal(await page.getByTestId('account-school').inputValue(), ''); assert.equal(await page.getByTestId('account-org').inputValue(), '');
    // A headless focus transition may conceal entry. Reenter only these known
    // test selectors explicitly; restoration itself must never restore them.
    const selectors = new URLSearchParams(query); await page.getByTestId('account-school').fill(selectors.get('schoolId') ?? ''); await page.getByTestId('account-org').fill(selectors.get('organizationId') ?? '');
  }
  await page.getByTestId('account-school').waitFor();
  return { context, page, requests, errors, language, reads: () => requests.filter(r => domainPath(r.path)).length };
}
async function billing(ui) {
  await ui.page.getByTestId('account-read-billing').click();
  await ui.page.getByTestId('account-card').getByText(t(ui.language, 'readyCard'), { exact: true }).waitFor();
  await ui.page.getByTestId('standing-card').getByText(t(ui.language, 'readyCard'), { exact: true }).waitFor();
}
async function refill(ui, who) { await ui.page.getByTestId('account-school').fill(who.school); await ui.page.getByTestId('account-org').fill(who.org); }
async function card(ui, name, phase) { await ui.page.getByTestId(`${name}-card`).getByText(t(ui.language, phase), { exact: true }).waitFor(); }
async function nativeRead(page, path) {
  return page.evaluate(async path => { const response = await fetch(path, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } });
    const json = await response.json(); return { status: response.status, noStore: response.headers.get('cache-control')?.includes('no-store'), json }; }, path);
}
/** Hold only delivery of an already-completed original native response. No route.fetch,
 * APIRequestContext, synthetic Response, replacement status/body or supplied browser header. */
async function responseGate(page, path, status, after = async () => {}) {
  let enter, release; const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  const binding = '__honAccountGate' + randomUUID().replaceAll('-', '');
  await page.exposeFunction(binding, async observed => { enter(observed); await after(observed); await held; });
  await page.evaluate(({ path, binding }) => {
    const native = window.fetch.bind(window); let armed = true;
    window.fetch = async (input, init) => {
      const response = await native(input, init);
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
      if (armed && url.pathname === path) { armed = false; await response.clone().arrayBuffer(); await window[binding]({ status: response.status, method: init?.method ?? 'GET', path: url.pathname }); }
      return response;
    };
  }, { path, binding });
  return { wait: async () => { let timer; try { const observed = await Promise.race([entered, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native response gate was not reached.')), 12000); })]); assert.equal(observed.status, status, 'Gate must observe the actual expected status.'); assert.equal(observed.method, 'GET'); return observed; } finally { clearTimeout(timer); } }, release };
}
async function stopNext() {
  if (!next || next.exitCode !== null || next.signalCode !== null) return;
  await new Promise(done => { const timer = setTimeout(() => next.kill('SIGKILL'), 5000); next.once('exit', () => { clearTimeout(timer); done(); }); next.kill('SIGTERM'); });
}
try {
  await owner.connect(); ownerConnected = true; await verifyChampionsProofConnection(owner, CHAMPIONS_OWNER_ROLE);
  const runtime = new Client(targets.runtime);
  try { await runtime.connect(); await verifyChampionsProofConnection(runtime, CHAMPIONS_RUNTIME_ROLE);
    assert.deepEqual((await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0], { rolsuper: false, rolbypassrls: false });
  } finally { await runtime.end(); }
  for (const signature of ['read_saas_school_billing_account(text,uuid)', 'read_saas_school_access_standing(text,uuid)', 'read_saas_creative_wallet(text,uuid)']) {
    const row = (await q("SELECT p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog, hon']::text[] AND has_function_privilege($2,p.oid,'EXECUTE') safe FROM pg_proc p WHERE p.oid=$1::regprocedure", ['hon.' + signature, CHAMPIONS_RUNTIME_ROLE])).rows[0]; assert.equal(row?.safe, true);
  }
  for (const table of ['saas_subscriptions', 'saas_access_transitions', 'saas_credit_allowances', 'saas_creative_wallets', 'saas_creative_lots', 'saas_creative_ledger', 'saas_creative_reservations']) {
    const row = (await q("SELECT c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner)<>$2 AND NOT has_table_privilege($2,c.oid,'SELECT,INSERT,UPDATE,DELETE') safe FROM pg_class c WHERE c.oid=$1::regclass", ['hon.' + table, CHAMPIONS_RUNTIME_ROLE])).rows[0]; assert.equal(row?.safe, true);
  }
  const a = await seed('billing-only', ['billing.hon.view']);
  const matrices = { en: a, ko: await seed('billing-only-ko', ['billing.hon.view']), es: await seed('billing-only-es', ['billing.hon.view']) };
  const b = await seed('foreign', ['billing.hon.view']);
  const suspended = await seed('suspended', ['billing.hon.view', 'ai.premium.request'], 'SUSPENDED');
  const creative = await seed('creative-empty', ['billing.hon.view', 'ai.premium.request']);
  const parent = await seed('parent', ['billing.hon.view', 'ai.premium.request'], 'ACTIVE', 'PARENT');
  const hq = await seed('HQ', [], 'ACTIVE', 'HQ', true);
  const siblingSchool = randomUUID(); await q("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'Synthetic ungranted sibling',$3)", [siblingSchool, a.org, `account-${siblingSchool}`]);
  stage = 'start-narrow-actual-api'; database = new classes.RuntimeDatabaseService();
  const controllers = ['SaasSchoolBillingController', 'SaasCreativeWalletSchoolController', 'MyLanguagePreferenceController'];
  const providers = ['HonIdentityGuard', 'HonIdentityService', 'SaasReadGuard', 'SaasCommandGuard', 'SaasSchoolBillingService', 'SaasBillingService',
    'SaasCreativeWalletService', 'LanguageReadGuard', 'LanguageCommandGuard', 'LanguagePreferencesService'];
  const module = await Test.createTestingModule({ controllers: controllers.map(name => { assert(classes[name], name); return classes[name]; }),
    providers: [...providers.map(name => { assert(classes[name], name); return classes[name]; }), { provide: classes.RuntimeDatabaseService, useValue: database }] }).compile();
  // Authorized synthetic fixture configuration only. These canonical locale
  // writes precede the baseline; no billing, credit or commercial row is seeded.
  for (const [language, who] of Object.entries(matrices)) { const receipt = await module.get(classes.LanguagePreferencesService).updateMine(who.subject, { language, expectedVersion: 0 }, randomUUID()); assert.equal(receipt.preference.language, language); }
  report.fixtureLocaleSetup = { languages: ['en', 'ko', 'es'], via: 'LanguagePreferencesService.updateMine', beforeReadOnlyBaseline: true };
  const tables = (await q("SELECT relname FROM pg_class WHERE relnamespace='hon'::regnamespace AND relkind='r' ORDER BY relname")).rows.map(row => row.relname);
  assert(tables.includes('saas_creative_ledger') && tables.includes('saas_access_transitions') && tables.includes('audit_events') && tables.includes('outbox_events'));
  const before = await snapshot(tables); report.before = before;
  app = module.createNestApplication({ logger: false }); app.setGlobalPrefix('v1'); app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.use((request, response, done) => { if (domainPath(request.url)) { const observed = nativeTransportObservation(request.method, request.url, request.headers, origin); response.once('finish', () => { report.nestIngress.push({ ...observed, status: response.statusCode }); }); } done(); });
  await app.listen(3001, '127.0.0.1');
  stage = 'start-production-next'; next = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3000'], {
    cwd: join(root, 'apps/web'), env: { PATH: process.env.PATH, NODE_ENV: 'production', HON_DEPLOYMENT_ENVIRONMENT: 'preview', NEXT_TELEMETRY_DISABLED: '1',
      HON_AUTH_MODE: auth.mode, HON_SESSION_AUDIENCE: auth.audience, HON_SESSION_JWT_SECRET: auth.secret, HON_PUBLIC_ORIGIN: origin, HON_API_BASE_URL: apiOrigin }, stdio: ['ignore', 'ignore', 'ignore'] });
  let ready = false; for (let i = 0; i < 120; i++) { try { await actualFetch(origin + '/api/identity/me'); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); } }
  assert(ready, 'Production Next did not start.');
  pass('exact-head production Next and actual narrow identity/billing/wallet controllers use the marked restricted disposable runtime');
  stage = 'actual-signed-api-reads';
  for (const who of [a, suspended, creative]) {
    const account = await signedRead(who, accountPath(who.school), 200, contracts.validateSaasSchoolBillingAccount);
    assert.equal(account.schoolId, who.school); assert.equal(account.organizationId, who.org); assert.equal(account.subscription, null); assert.equal(account.payment.status, 'NOT_BILLED');
    const standing = await signedRead(who, accountPath(who.school) + '/access-standing', 200, contracts.validateSaasSchoolAccessStanding);
    assert.equal(standing.schoolId, who.school); assert.equal(standing.organizationId, who.org); assert.equal(standing.billingRecoveryOpen, true); assert.equal(standing.policyStatus, 'PROPOSED');
    if (who === suspended) { assert.equal(account.entitlement.status, 'SUSPENDED'); assert.equal(account.entitlement.inEffect, false); assert.equal(standing.state, 'NO_ACCESS'); }
  }
  await signedRead(a, walletPath(a.school), 403); await signedRead(suspended, walletPath(suspended.school), 403);
  const wallet = await signedRead(creative, walletPath(creative.school), 200, contracts.validateSaasCreativeSchoolWallet);
  assert.equal(wallet.walletVersion, null); assert.equal(wallet.balance.availableCredits, 0); assert.equal(wallet.balance.heldCredits, 0); assert.equal(wallet.eligibility.reason, 'PROGRAM_INACTIVE');
  assert.equal(wallet.agentConversationsDeductCredits, false); assert.equal(wallet.paymentsActive, false); assert.deepEqual(wallet.lots, []); assert.deepEqual(wallet.history, []);
  for (const who of [a, parent, hq]) for (const path of [accountPath(b.school), accountPath(b.school) + '/access-standing', walletPath(b.school)]) await signedRead(who, path, 403);
  for (const school of [a.school, siblingSchool]) for (const path of [accountPath(school), accountPath(school) + '/access-standing', walletPath(school)]) await signedRead(school === a.school ? b : a, path, 403);
  for (const path of [accountPath(a.school), accountPath(a.school) + '/access-standing', walletPath(a.school)]) {
    const response = await actualFetch(origin + path, { headers: { Cookie: `${HON_SESSION_COOKIE}=FORGED` } }); assert.equal(response.status, 401); await response.arrayBuffer();
  }
  pass('real billing/standing200, independent permission and suspended-entitlement wallet403, empty-wallet200, foreign-school/parent/HQ403 and forged-session401');
  stage = 'mounted-native-matrix'; browser = await chromium.launch({ executablePath: config.chrome, headless: true, args: ['--no-sandbox'] });
  for (const language of ['en', 'ko', 'es']) for (const mode of ['modern', 'classic', 'big']) for (const width of [390, 834, 1440]) {
    const who = matrices[language], ui = await open(who, { language, width }); const { page } = ui; stage = `mounted-${language}-${mode}-${width}`;
    assert.equal(await page.getByTestId('account-school').inputValue(), who.school); assert.equal(await page.getByTestId('account-org').inputValue(), who.org); assert.equal(ui.reads(), 0, 'URL selectors are inert.');
    await page.getByRole('button', { name: t(language, mode), exact: true }).click(); assert.equal(await page.getByTestId('school-account-status').getAttribute('data-interface-theme'), mode); assert.equal(ui.reads(), 0);
    await page.getByTestId('account-school').focus(); await page.keyboard.press('Shift'); assert(await page.getByTestId('account-school').evaluate(element => element === document.activeElement && element.matches(':focus-visible')));
    await billing(ui); await page.getByTestId('account-read-wallet').click(); await card(ui, 'wallet', 'deniedCard'); await card(ui, 'account', 'readyCard');
    assert.equal(ui.reads(), 3); assert(await page.getByTestId('account-card').getByText(who.org, { exact: true }).count());
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.addScriptTag({ content: axe }); const scan = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
    assert.deepEqual(scan.violations.map(violation => ({ id: violation.id, targets: violation.nodes.map(node => node.target) })), []); assert.deepEqual(ui.errors, []);
    const screenshot = `account-status-${language}-${mode}-${width}.png`; await page.screenshot({ path: join(config.results, screenshot), fullPage: true }); report.screenshots.push(screenshot);
    const reads = ui.reads(), identities = ui.requests.filter(request => request.path === '/api/identity/me').length;
    assert(await page.evaluate(() => { const area = document.querySelector('[data-testid="account-private"]'); window.dispatchEvent(new Event('blur')); return area.hidden && area.inert; }));
    await page.getByTestId('account-status').filter({ hasText: t(language, 'CONCEALED') }).waitFor(); assert.equal(await page.getByTestId('account-school').count(), 0);
    await page.bringToFront(); await page.getByTestId('account-restore').click(); await page.getByTestId('account-school').waitFor();
    assert.equal(await page.getByTestId('account-school').inputValue(), ''); assert.equal(await page.getByTestId('account-org').inputValue(), '');
    assert.equal(ui.reads(), reads); assert.equal(ui.requests.filter(request => request.path === '/api/identity/me').length, identities + 1); assert.equal(await page.getByTestId('account-card').locator('dl').count(), 0);
    report.cases.push({ language, mode, width, actualApiAndDatabase: true, axeViolations: 0, pageErrors: 0, identityOnlyRestore: true }); await ui.context.close();
  }
  pass('27 native real-API/database language/view/viewport cases preserve explicit reads, wallet independence, keyboard, privacy, identity-only restoration and axe');
  stage = 'school-only-suspended-and-optional-organization';
  {
    const ui = await open(suspended, { query: scopeQuery(suspended, false) }); assert.equal(await ui.page.getByTestId('account-org').inputValue(), ''); assert.equal(ui.reads(), 0);
    await billing(ui); await ui.page.getByTestId('account-read-wallet').click(); await card(ui, 'wallet', 'deniedCard');
    assert(await ui.page.getByTestId('account-card').getByText(suspended.org, { exact: true }).count());
    await ui.page.getByTestId('account-org').fill(b.org); const reads = ui.reads(); assert.equal(await ui.page.getByTestId('account-card').locator('dl').count(), 0);
    await ui.page.getByTestId('account-read-billing').click(); await card(ui, 'account', 'unavailableCard'); await card(ui, 'standing', 'unavailableCard'); assert.equal(ui.reads(), reads + 2);
    assert.equal(await ui.page.getByTestId('account-card').locator('dl').count(), 0); await ui.context.close();
  }
  pass('known-school-only suspended billing recovery is explicit; a mismatching optional organization cannot expose actual returned facts');
  stage = 'mounted-native-denials-and-empty-wallet';
  {
    const ui = await open(creative); await billing(ui); await ui.page.getByTestId('account-read-wallet').click(); await card(ui, 'wallet', 'readyCard'); assert(await ui.page.getByTestId('wallet-card').getByText(value('en', 'PROGRAM_INACTIVE'), { exact: true }).count());
    for (const who of [parent, hq]) { await setActor(ui.context, who); const result = await nativeRead(ui.page, accountPath(creative.school)); assert.equal(result.status, 403); }
    await setActor(ui.context, a); assert.equal((await nativeRead(ui.page, accountPath(b.school))).status, 403);
    await setActor(ui.context, a, true); assert.equal((await nativeRead(ui.page, accountPath(a.school))).status, 401); await ui.context.close();
  }
  pass('original native Chromium GET metadata reaches actual guards for empty-wallet200, foreign/parent/HQ403 and expired-session401');
  stage = 'late-success-after-concealment';
  {
    const ui = await open(a); const gate = await responseGate(ui.page, accountPath(a.school), 200);
    await ui.page.getByTestId('account-read-billing').click(); await gate.wait();
    await ui.page.evaluate(() => window.dispatchEvent(new Event('blur'))); await ui.page.bringToFront(); await ui.page.getByTestId('account-restore').click(); await ui.page.getByTestId('account-school').waitFor();
    gate.release(); await ui.page.waitForTimeout(150); assert.equal(await ui.page.getByTestId('account-card').locator('dl').count(), 0); assert.equal(await ui.page.getByTestId('standing-card').locator('dl').count(), 0);
    await refill(ui, a); await billing(ui); await ui.context.close();
  }
  pass('late actual200 delivery after concealment cannot repopulate restored idle cards; an explicit new read succeeds');
  stage = 'silent-cookie-switch-after-wallet403';
  {
    const ui = await open(a); await billing(ui);
    const gate = await responseGate(ui.page, walletPath(a.school), 403, async () => { await setActor(ui.context, b); });
    await ui.page.getByTestId('account-read-wallet').click(); await gate.wait(); gate.release();
    await ui.page.getByTestId('account-status').filter({ hasText: t('en', 'IDENTITY') }).waitFor();
    assert.equal(await ui.page.getByTestId('account-card').count(), 0); assert.equal(await ui.page.getByTestId('account-school').count(), 0); await ui.context.close();
  }
  pass('silent actor switch after real wallet403 is caught by actual identity postcheck and conceals previously verified billing');
  stage = 'retired-real401-versus-current-session';
  {
    const ui = await open(a); await billing(ui);
    // Expire the cookie only after the original identity precheck completed, immediately before native wallet GET.
    let expired; const expiration = new Promise(resolve => { expired = resolve; });
    await ui.page.exposeFunction('__honExpireAccountCookie', async () => { await setActor(ui.context, a, true); expired(); });
    await ui.page.evaluate(() => { const native = window.fetch.bind(window); let armed = true; window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
      if (armed && url.pathname.endsWith('/creative-credits')) { armed = false; await window.__honExpireAccountCookie(); }
      return native(input, init);
    }; });
    const gate = await responseGate(ui.page, walletPath(a.school), 401); await ui.page.getByTestId('account-read-wallet').click(); await expiration; await gate.wait();
    await setActor(ui.context, a); await ui.page.evaluate(() => window.dispatchEvent(new Event('blur'))); await ui.page.bringToFront(); await ui.page.getByTestId('account-restore').click(); await ui.page.getByTestId('account-school').waitFor();
    await refill(ui, a); await billing(ui); gate.release(); await ui.page.waitForTimeout(150); await card(ui, 'account', 'readyCard'); await card(ui, 'standing', 'readyCard'); await ui.context.close();
  }
  pass('aborted retired actual401 cannot invalidate a newly verified current-session billing read');
  stage = 'current-real401';
  {
    const ui = await open(a); await billing(ui); await setActor(ui.context, a, true); await ui.page.getByTestId('account-read-wallet').click();
    await ui.page.getByTestId('account-status').filter({ hasText: t('en', 'SESSION') }).waitFor(); assert.equal(await ui.page.getByTestId('account-card').count(), 0); await ui.context.close();
  }
  pass('current actual401 broadcasts session invalidation and removes all account information');
  stage = 'verify-zero-writes'; report.after = await snapshot(tables); assert.deepEqual(report.after, before, 'All HON table row counts and complete-row hashes must remain unchanged after fixture setup.');
  assert(report.nativeBrowserRequests.some(request => domainPath(request.path))); assert(report.nestIngress.length > 0);
  assert(report.nativeBrowserRequests.every(request => request.method === 'GET'));
  report.zeroWritesVerified = true; report.passed = true;
  pass('all HON tables unchanged: zero business, billing, policy, access, wallet, AI-credit or audit/outbox writes; no provider or worker configured');
} catch (error) {
  report.failure = { stage, type: error.name, message: 'Guarded account verification failed; no header, response or authority repair.' };
  if (currentPage && !currentPage.isClosed()) await currentPage.screenshot({ path: join(config.results, 'account-status-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (ownerConnected && report.before && !report.after) report.after = await snapshot(Object.keys(report.before)).catch(() => null);
  report.blockedExternalOrigins = [...new Set(report.blockedExternalOrigins)];
  await writeFile(join(config.results, 'account-status-report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close().catch(() => {}); await stopNext(); await app?.close().catch(() => {}); await database?.onModuleDestroy().catch(() => {}); if (ownerConnected) await owner.end();
  console.log(JSON.stringify({ sourceSha, passed: report.passed, groups: report.groups.length, mountedCases: report.cases.length, nativeHeadersUnchanged: true, apiMocked: false, externalOidcOrOwnerDeviceAcceptance: false }));
}
