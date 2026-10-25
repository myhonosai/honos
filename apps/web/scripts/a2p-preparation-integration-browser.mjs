/**
 * A2P-2 integration rehearsal (disposable, local only).
 *
 * Real Next production build in Chromium -> same-origin /api/v1 rewrite ->
 * signed-session Nest controllers from PR #82 (A2P preparation, current
 * staff school, interface theme, language preference) -> restricted runtime
 * role -> guarded disposable PostgreSQL (Champions Club validation fixture).
 *
 * Synthetic organization, schools and staff only. Live website inspection is
 * the production UnavailableA2pWebsiteInspector; no website, provider, AI,
 * SMS or payment system is reached, and any non-local browser request fails
 * the run (Google Fonts excepted, as in every other HON browser proof).
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { issueSession, HON_SESSION_COOKIE } from '@hon/auth';
import { translate } from '@hon/design-system';

if (process.env.HON_A2P_INTEGRATION_LOCAL !== '1') throw new Error('Opt into disposable local integration with HON_A2P_INTEGRATION_LOCAL=1.');
const PROVIDER = /^(?:PG[A-Z_]*|NODE_OPTIONS|TWILIO|ZERNIO|STRIPE|SQUARE|OPENAI|ANTHROPIC|OPENROUTER|SENDGRID|SUPABASE|AWS|HEYGEN|HON_(?:AI|PROVIDER|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i;
assert(!Object.keys(process.env).some((key) => PROVIDER.test(key)), 'Refusing inherited provider or database credentials.');
assert(!process.env.DATABASE_URL && !process.env.HON_RUNTIME_DATABASE_URL, 'Pass disposable credentials only through HON_A2P_INTEGRATION_ENV_FILE.');

const envFile = process.env.HON_A2P_INTEGRATION_ENV_FILE;
assert(envFile && envFile.startsWith('/home/ubuntu/jobs/') && resolve(envFile) === envFile, 'HON_A2P_INTEGRATION_ENV_FILE must be a private job env file.');
assert(((await lstat(envFile)).mode & 0o077) === 0, 'Env file must be mode 0600.');
const env = Object.fromEntries((await readFile(envFile, 'utf8')).split('\n').filter(Boolean).map((line) => { const m = /^export ([A-Z_]+)='([^']*)'$/.exec(line); assert(m); return [m[1], m[2]]; }));
const ownerUrl = new URL(env.DATABASE_URL), runtimeUrl = new URL(env.HON_RUNTIME_DATABASE_URL);
for (const url of [ownerUrl, runtimeUrl]) assert(url.protocol === 'postgresql:' && url.hostname === 'localhost' && url.port === '5432' && url.pathname === '/hon_champions_validation' && !url.search && url.password);
assert(ownerUrl.username === 'hon_champions_owner' && runtimeUrl.username === 'hon_champions_runtime');

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'), repo = resolve(webRoot, '../..');
const tools = process.env.HON_A2P_BROWSER_TOOLS, results = process.env.HON_A2P_BROWSER_RESULTS, playwrightPath = process.env.HON_A2P_PLAYWRIGHT;
assert(tools && results && playwrightPath, 'HON_A2P_BROWSER_TOOLS (axe-core), HON_A2P_BROWSER_RESULTS and HON_A2P_PLAYWRIGHT are required.');
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const axeSource = await readFile(createRequire(join(tools, 'runner.cjs')).resolve('axe-core/axe.min.js'), 'utf8');
await mkdir(results, { recursive: true });

const apiRequire = createRequire(join(repo, 'apps/api/package.json')), dbRequire = createRequire(join(repo, 'packages/database/package.json'));
apiRequire('reflect-metadata');
const { Test } = apiRequire('@nestjs/testing'), { ValidationPipe } = apiRequire('@nestjs/common'), { json } = apiRequire('express'), pg = dbRequire('pg');
const load = (path) => import(pathToFileURL(join(repo, 'apps/api/dist', path)).href);
const { RuntimeDatabaseService } = await load('foundation/runtime-database.service.js');
const { HonIdentityService } = await load('foundation/hon-identity.service.js');
const { HonIdentityGuard } = await load('foundation/hon-identity.guard.js');
const { A2pPreparationController, A2pPreparationHumanGuard } = await load('a2p/a2p-preparation.controller.js');
const { A2pPreparationService } = await load('a2p/a2p-preparation.service.js');
const { A2P_WEBSITE_INSPECTOR, UnavailableA2pWebsiteInspector } = await load('a2p/a2p-inspector.js');
const { CurrentStaffReportingSchoolController, CurrentStaffReportingSchoolNoStoreGuard } = await load('reports/current-staff-reporting-school.controller.js');
const { InterfaceThemeController } = await load('preferences/interface-theme.controller.js');
const { InterfaceThemeService } = await load('preferences/interface-theme.service.js');
const { MyLanguagePreferenceController, LanguagePreferencesService, LanguageReadGuard, LanguageCommandGuard } = await load('preferences/language-preferences.controller.js');

const report = { realPostgreSQL: true, realSignedSession: true, mockedApi: false, inspection: 'UnavailableA2pWebsiteInspector', checks: [], failures: [], screenshots: [], accessibility: [], pageErrors: [], console: [], apiRequests: [], blockedRequests: [], httpErrors: [], failedRequests: [], postBodiesInUrls: 0, storageLeaks: 0 };
const owner = new pg.Client({ connectionString: env.DATABASE_URL, ssl: false });
await owner.connect();
const sql = (q, v = []) => owner.query(q, v);
assert.deepEqual((await sql("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0], { owner: 'hon_champions_owner', marker: 'HON disposable Champions Club validation' });

// ---------- synthetic tenant ----------
const ids = { org: randomUUID(), schoolA: randomUUID(), schoolB: randomUUID() };
await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'A2P-2 Synthetic Organization','A2P-2 Synthetic Organization')", [ids.org]);
await sql("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'Synthetic Dojo',$3),($4,$2,'Synthetic Dojo North',$5)", [ids.schoolA, ids.org, `a2p2-${ids.schoolA}`, ids.schoolB, `a2p2-${ids.schoolB}`]);
await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day')", [ids.org]);
async function role(code, permissions) {
  const id = randomUUID();
  await sql('INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,$3,$4)', [id, ids.org, code, `Synthetic ${code}`]);
  for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [id, ids.org, permission]);
  return id;
}
const BASE = ['reporting.view', 'settings.interface_theme.read'];
const roles = { owner: await role('OWNER', [...BASE, 'communication.a2p.prepare']), staff: await role('A2P_ASSISTANT', [...BASE, 'communication.a2p.prepare']), none: await role('FRONT_DESK', BASE) };
async function person(name, roleId, { language = null, theme = null, school = ids.schoolA } = {}) {
  const user = randomUUID(), principal = randomUUID(), grant = randomUUID(), subject = `a2p2-${name}-${randomUUID()}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)", [user, subject, `${user}@example.test`, `Synthetic ${name}`]);
  await sql("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER',$3)", [principal, user, `Synthetic ${name}`]);
  await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 hour')", [grant, ids.org, school, principal, roleId]);
  if (language) await sql('INSERT INTO hon.user_language_preferences(user_id,language,version,created_at,updated_at) VALUES($1,$2,1,clock_timestamp(),clock_timestamp())', [user, language]);
  if (theme) await sql("INSERT INTO hon.principal_interface_preferences(organization_id,school_id,principal_id,interface_theme,selected_via) VALUES($1,$2,$3,$4,'SETTINGS')", [ids.org, school, principal, theme]);
  return { subject, principal, grant, user };
}
const people = {
  owner: await person('owner', roles.owner), staff: await person('staff', roles.staff, { theme: 'classic' }), denied: await person('denied', roles.none),
  ko: await person('owner-ko', roles.owner, { language: 'ko', theme: 'classic' }), es: await person('owner-es', roles.owner, { language: 'es', theme: 'big-button' }),
  revoked: await person('revoked', roles.owner), switcher: await person('switcher', roles.owner), demoted: await person('demoted', roles.owner),
};
// A second, not-yet-effective grant for the school-switch scenario, so the switch is an UPDATE and table counts stay comparable.
const switchGrant = randomUUID();
await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()+interval '30 days')", [switchGrant, ids.org, ids.schoolB, people.switcher.principal, roles.owner]);

async function counts() { return (await sql("SELECT jsonb_object_agg(table_name,n) value FROM (SELECT table_name,(xpath('/row/n/text()',query_to_xml(format('SELECT count(*) n FROM hon.%I',table_name),false,true,'')))[1]::text::bigint n FROM information_schema.tables WHERE table_schema='hon' AND table_type='BASE TABLE') t")).rows[0].value; }
async function gates() { return (await sql('SELECT (SELECT status FROM hon.saas_access_program) paid,(SELECT status FROM hon.saas_credit_program) credits,(SELECT status FROM hon.saas_payment_program) payment')).rows[0]; }
const footprint = await counts(), posture = await gates();
assert.deepEqual(posture, { paid: 'INACTIVE', credits: 'INACTIVE', payment: 'DISABLED' });

// ---------- servers ----------
const freePort = async () => { const probe = createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const { port } = probe.address(); await new Promise((done) => probe.close(done)); return port; };
const webPort = await freePort(), origin = `http://127.0.0.1:${webPort}`;
const session = { mode: 'OIDC', audience: 'hon-a2p2-integration', secret: randomBytes(32).toString('hex') };
Object.assign(process.env, { HON_AUTH_MODE: session.mode, HON_SESSION_AUDIENCE: session.audience, HON_SESSION_JWT_SECRET: session.secret, HON_PUBLIC_ORIGIN: origin, HON_RUNTIME_DATABASE_URL: env.HON_RUNTIME_DATABASE_URL });
const database = new RuntimeDatabaseService();
const nest = await Test.createTestingModule({
  controllers: [A2pPreparationController, CurrentStaffReportingSchoolController, InterfaceThemeController, MyLanguagePreferenceController],
  providers: [A2pPreparationService, A2pPreparationHumanGuard, { provide: A2P_WEBSITE_INSPECTOR, useFactory: () => new UnavailableA2pWebsiteInspector() },
    CurrentStaffReportingSchoolNoStoreGuard, InterfaceThemeService, LanguagePreferencesService, LanguageReadGuard, LanguageCommandGuard,
    HonIdentityService, HonIdentityGuard, { provide: RuntimeDatabaseService, useValue: database }],
}).compile();
const app = nest.createNestApplication({ bodyParser: false, logger: false });
app.use(json({ limit: '2mb', strict: true }));
app.setGlobalPrefix('v1');
app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
// next.config.ts bakes its /api/v1 rewrite at build time (default http://127.0.0.1:3001), so the API listens there.
await app.listen(3001, '127.0.0.1');
const apiBase = 'http://127.0.0.1:3001';
const apiSeen = [];
app.getHttpServer().on('request', (req) => { apiSeen.push({ method: req.method, url: req.url, origin: req.headers.origin, site: req.headers['sec-fetch-site'], mode: req.headers['sec-fetch-mode'], dest: req.headers['sec-fetch-dest'], command: req.headers['x-hon-human-command'], idempotency: req.headers['idempotency-key'] }); });

const next = spawn(join(webRoot, 'node_modules/.bin/next'), ['start', '--port', String(webPort), '--hostname', '127.0.0.1'], { cwd: webRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', HON_API_BASE_URL: apiBase, HON_AUTH_MODE: session.mode, HON_SESSION_AUDIENCE: session.audience, HON_SESSION_JWT_SECRET: session.secret }, stdio: ['ignore', 'pipe', 'pipe'] });
let nextLog = ''; next.stdout.on('data', (d) => { nextLog += d; }); next.stderr.on('data', (d) => { nextLog += d; });
for (let i = 0; i < 240; i += 1) { try { const r = await fetch(`${origin}/auth/login`); if (r.status < 500) break; } catch { /* starting */ } await new Promise((done) => setTimeout(done, 500)); }

const ROUTE = '/settings/communications/business-texting/a2p-registration';
const FACTS = {
  businessName: 'Synthetic Dojo', websiteUrl: 'https://dojo.example.com/', privacyUrl: 'https://dojo.example.com/privacy', termsUrl: 'https://dojo.example.com/terms',
  optInUrl: 'https://dojo.example.com/trial', supportContact: 'support@dojo.example.com',
  messageFlow: 'Adults requesting a trial class use the public trial form and may tick a separate, optional, unticked SMS consent box.', messageFrequency: 'Up to four messages a month',
};
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, tablet: { width: 834, height: 1112 }, phone: { width: 390, height: 844 } };
const browser = await chromium.launch();

async function open(who, viewport, { expired = false } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce', acceptDownloads: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await context.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: who.subject }, session, expired ? Math.floor(Date.now() / 1000) - 43201 : undefined), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { if (!url.hostname.endsWith('fonts.googleapis.com') && !url.hostname.endsWith('fonts.gstatic.com')) report.blockedRequests.push(url.origin); return route.abort(); }
    if (url.pathname.startsWith('/api/v1/')) {
      report.apiRequests.push(`${route.request().method()} ${url.pathname}${url.search}`);
      if (Object.values(FACTS).some((value) => url.href.includes(encodeURIComponent(value)) || url.href.includes(value))) report.postBodiesInUrls += 1;
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') report.console.push(message.text()); });
  page.on('response', (response) => { if (response.status() >= 400) report.httpErrors.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')}`); });
  page.on('requestfailed', (request) => report.failedRequests.push(`${new URL(request.url()).host} ${request.failure()?.errorText}`));
  return { context, page };
}
async function check(name, work) {
  try { await work(); report.checks.push(name); console.log('PASS', name); } catch (error) { report.failures.push(`${name}: ${error instanceof Error ? error.stack : String(error)}`); console.log('FAIL', name, error); }
}
async function shot(page, name, fullPage = true) { await page.screenshot({ path: join(results, `${name}.png`), fullPage }); report.screenshots.push(`${name}.png`); }
async function axe(page, name) {
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => (await window.axe.run({ include: [['main[data-interface-theme]']] }, { runOnly: ['wcag2a', 'wcag2aa'] })).violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target })));
  report.accessibility.push({ name, violations });
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  assert.equal(serious.length, 0, `${name}: ${JSON.stringify(serious)}`);
}
const tr = (language, key, params) => translate(language, key, params);
async function step(page, index) { await page.locator('nav ol li button').nth(index).click(); }
async function ready(page, language = 'en', school = 'Synthetic Dojo') {
  await page.goto(origin + ROUTE);
  await page.getByTestId('a2p-prep-ready').waitFor();
  assert((await page.getByTestId('a2p-prep-ready').textContent()).includes(tr(language, 'a2p.prep.ready.title', { school })));
}
async function fill(page, facts = FACTS) { for (const [key, value] of Object.entries(facts)) await page.locator(`#a2p-fact-${key}`).fill(value); }
async function checklist(page, language = 'en') {
  await page.getByRole('button', { name: tr(language, 'a2p.prep.review.start') }).click();
  await page.getByTestId('a2p-prep-summary').waitFor();
}
const theme = (page) => page.locator('main').getAttribute('data-interface-theme');

try {
  for (const [size, viewport] of [['desktop', VIEWPORTS.desktop], ['phone', VIEWPORTS.phone]]) {
    await check(`${size} owner (modern, English): facts -> 13 unchecked items -> owner-confirmed draft -> validation -> copy text download`, async () => {
      const { context, page } = await open(people.owner, viewport);
      try {
        const before = apiSeen.length;
        await ready(page);
        assert.equal(await theme(page), 'modern');
        assert.equal(await page.getByTestId('a2p-prep-authority').textContent(), tr('en', 'a2p.prep.authority.owner'));
        assert.equal(await page.getByTestId('a2p-prep-inspection-off').isVisible(), true);
        await shot(page, `${size}-01-facts-empty`); await axe(page, `${size} facts empty`);
        await page.locator('#a2p-fact-websiteUrl').fill('https://dojo.test/');
        await page.getByRole('button', { name: tr('en', 'a2p.prep.review.start') }).click();
        await page.getByText(tr('en', 'a2p.prep.factError.URL_NOT_ALLOWED')).waitFor();
        assert(!apiSeen.slice(before).some((r) => r.url.endsWith('/website-review')), 'invalid URL must not reach the API');
        await fill(page);
        await shot(page, `${size}-02-facts-filled`);
        await checklist(page);
        assert.equal(await page.getByTestId('a2p-prep-inspection-disabled').isVisible(), true);
        assert.equal(await page.locator('[data-testid="a2p-prep-summary"] li[data-tone="planned"] strong').textContent(), '13');
        await shot(page, `${size}-03-checklist-summary`); await axe(page, `${size} checklist summary`);
        await step(page, 1);
        await page.getByTestId('a2p-prep-checks').waitFor();
        assert.equal(await page.locator('[data-testid="a2p-prep-checks"] article[data-outcome="UNAVAILABLE"]').count(), 13);
        assert.equal(await page.getByTestId('a2p-prep-no-evidence').count(), 13);
        assert.equal(await page.getByText(tr('en', 'a2p.prep.check.fixtureEvidence')).count(), 0);
        await page.locator('article[data-code="HELP"] button').click();
        await page.locator('article[data-code="HELP"]').getByText(tr('en', 'a2p.prep.check.detailsSame')).waitFor();
        await shot(page, `${size}-04-thirteen-checks`); await axe(page, `${size} checks`);
        await step(page, 2);
        await page.getByTestId('a2p-prep-attest').check();
        await page.getByRole('button', { name: tr('en', 'a2p.prep.draft.start') }).click();
        await page.getByTestId('a2p-prep-draft').waitFor();
        assert((await page.getByTestId('a2p-prep-draft').textContent()).includes(tr('en', 'a2p.prep.draftState.DRAFT_FOR_OWNER_REVIEW')));
        assert((await page.getByTestId('a2p-prep-draft').textContent()).includes('Synthetic Dojo: Your requested trial is scheduled'));
        await shot(page, `${size}-05-draft`); await axe(page, `${size} draft`);
        await step(page, 3);
        await page.getByRole('button', { name: tr('en', 'a2p.prep.final.check') }).click();
        await page.getByTestId('a2p-prep-validation-result').waitFor();
        assert((await page.getByTestId('a2p-prep-validation-result').textContent()).includes(tr('en', 'a2p.prep.final.readyForCopy')));
        await page.getByTestId('a2p-prep-copy-ack').check();
        await page.getByRole('button', { name: tr('en', 'a2p.prep.copy.prepare') }).click();
        await page.getByTestId('a2p-prep-copy-result').waitFor();
        const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download hon-a2p-draft\.txt/ }).click()]);
        assert.equal(download.suggestedFilename(), 'hon-a2p-draft.txt');
        const text = await readFile(await download.path(), 'utf8');
        assert.match(text, /external owner review required\. Not saved, submitted, legally approved or sent\./);
        assert.match(text, /Proposed STOP response \(not configured\)/);
        assert(await page.getByRole('button', { name: 'Submit registration' }).isDisabled());
        await shot(page, `${size}-06-final-review-copy`); await axe(page, `${size} final review`);
        const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.cookie]));
        if (/dojo\.example\.com|Synthetic Dojo|support@/.test(stored)) report.storageLeaks += 1;
        await step(page, 4);
        await page.getByTestId('a2p-status-unavailable').waitFor();
        await shot(page, `${size}-07-status-unavailable`, false);
        assert(await page.getByRole('button', { name: tr('en', 'a2p.hon.send') }).isDisabled());
        const posts = apiSeen.slice(before).filter((r) => r.method === 'POST');
        assert.deepEqual([...new Set(posts.map((r) => r.url.split('/a2p/')[1]))].sort(), ['copy-preparation', 'draft-validation', 'finding-details', 'registration-draft', 'website-review']);
        for (const r of posts) {
          assert.equal(r.url, `/v1/organizations/${ids.org}/schools/${ids.schoolA}/a2p/${r.url.split('/a2p/')[1]}`);
          assert.deepEqual([r.origin, r.site, r.mode, r.dest, r.command, r.idempotency], [origin, 'same-origin', 'same-origin', 'empty', 'a2p-prepare', undefined]);
        }
      } finally { await context.close(); }
    });
  }

  await check('tablet staff (classic): no owner attestation, draft lists owner confirmation as missing, copy stays locked', async () => {
    const { context, page } = await open(people.staff, VIEWPORTS.tablet);
    try {
      await ready(page);
      await page.waitForFunction(() => document.querySelector('main')?.getAttribute('data-interface-theme') === 'classic');
      assert.equal(await page.getByTestId('a2p-prep-authority').textContent(), tr('en', 'a2p.prep.authority.staff'));
      await fill(page); await checklist(page);
      await step(page, 2);
      assert(await page.getByTestId('a2p-prep-attest').isDisabled());
      await page.getByRole('button', { name: tr('en', 'a2p.prep.draft.start') }).click();
      await page.getByTestId('a2p-prep-missing').waitFor();
      assert((await page.getByTestId('a2p-prep-missing').textContent()).includes(tr('en', 'a2p.prep.missing.ownerConfirmation')));
      await shot(page, 'tablet-staff-draft-needs-owner'); await axe(page, 'staff draft');
      await step(page, 3);
      await page.getByRole('button', { name: tr('en', 'a2p.prep.final.check') }).click();
      await page.getByTestId('a2p-prep-validation-missing').waitFor();
      assert(await page.getByTestId('a2p-prep-copy-ack').isDisabled());
      assert.equal(await page.getByTestId('a2p-prep-copy-locked').isVisible(), true);
      await shot(page, 'tablet-staff-final-locked');
    } finally { await context.close(); }
  });

  await check('desktop staff without communication.a2p.prepare is denied and sees no school data', async () => {
    const { context, page } = await open(people.denied, VIEWPORTS.desktop);
    try {
      await page.goto(origin + ROUTE);
      await page.getByTestId('a2p-prep-DENIED').waitFor();
      assert.equal(await page.getByText('Synthetic Dojo').count(), 0);
      await shot(page, 'desktop-denied', false); await axe(page, 'denied');
    } finally { await context.close(); }
  });

  await check('Korean owner (classic): checks and English-only draft with Korean UI', async () => {
    const { context, page } = await open(people.ko, VIEWPORTS.desktop);
    try {
      await ready(page, 'ko');
      await page.waitForFunction(() => document.querySelector('main')?.getAttribute('data-interface-theme') === 'classic');
      await fill(page); await checklist(page, 'ko');
      await step(page, 1); await page.getByTestId('a2p-prep-checks').waitFor();
      assert.equal(await page.getByText(tr('ko', 'a2p.prep.code.CONSENT_OPTIONAL_UNCHECKED.title')).count(), 1);
      await shot(page, 'ko-classic-checks'); await axe(page, 'ko checks');
      await step(page, 2);
      await page.getByTestId('a2p-prep-attest').check();
      await page.getByRole('button', { name: tr('ko', 'a2p.prep.draft.start') }).click();
      await page.getByTestId('a2p-prep-draft').waitFor();
      assert.equal(await page.getByText(tr('ko', 'a2p.prep.englishOnly')).count(), 1);
      assert(await page.locator('[data-testid="a2p-prep-draft"] [lang="en"]').count() >= 7);
      await shot(page, 'ko-classic-draft'); await axe(page, 'ko draft');
    } finally { await context.close(); }
  });

  await check('Spanish owner (big-button, phone): mixed purpose needs separate marketing consent', async () => {
    const { context, page } = await open(people.es, VIEWPORTS.phone);
    try {
      await ready(page, 'es');
      await page.waitForFunction(() => document.querySelector('main')?.getAttribute('data-interface-theme') === 'big-button');
      await fill(page); await shot(page, 'es-big-button-facts');
      await step(page, 2);
      await page.getByLabel(tr('es', 'a2p.prep.purpose.MIXED'), { exact: false }).check();
      await page.getByTestId('a2p-prep-attest').check();
      await page.getByRole('button', { name: tr('es', 'a2p.prep.draft.start') }).click();
      await page.getByTestId('a2p-prep-missing').waitFor();
      assert((await page.getByTestId('a2p-prep-missing').textContent()).includes(tr('es', 'a2p.prep.missing.marketingConsent.separateConfirmation')));
      await page.getByLabel(tr('es', 'a2p.prep.consent.SEPARATE_CONFIRMED')).check();
      await page.getByTestId('a2p-prep-attest').check();
      await page.getByRole('button', { name: tr('es', 'a2p.prep.draft.start') }).click();
      await page.getByText(tr('es', 'a2p.prep.draftState.DRAFT_FOR_OWNER_REVIEW')).waitFor();
      await shot(page, 'es-big-button-draft-mixed'); await axe(page, 'es draft');
      await step(page, 3);
      await page.getByRole('button', { name: tr('es', 'a2p.prep.final.check') }).click();
      await page.getByTestId('a2p-prep-validation-result').waitFor();
      await shot(page, 'es-big-button-final'); await axe(page, 'es final');
    } finally { await context.close(); }
  });

  await check('grant revoked mid-session: the next request is denied and every fact and result is cleared', async () => {
    const { context, page } = await open(people.revoked, VIEWPORTS.desktop);
    try {
      await ready(page); await fill(page); await checklist(page);
      await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1', [people.revoked.grant]);
      await step(page, 2);
      await page.getByRole('button', { name: tr('en', 'a2p.prep.draft.start') }).click();
      await page.getByTestId(/a2p-prep-(DENIED|NO_SCHOOL)/).waitFor();
      await step(page, 0);
      assert.equal(await page.locator('#a2p-fact-businessName').inputValue(), '');
      assert.equal(await page.getByTestId('a2p-prep-summary').count(), 0);
      await shot(page, 'desktop-authorization-lost', false);
    } finally { await context.close(); }
  });

  await check('current school changes while hidden: results and facts from the old school are cleared', async () => {
    const { context, page } = await open(people.switcher, VIEWPORTS.desktop);
    try {
      await ready(page); await fill(page); await checklist(page);
      await sql('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1', [people.switcher.grant]);
      await sql("UPDATE hon.principal_role_grants SET effective_from=clock_timestamp()-interval '1 minute' WHERE id=$1", [switchGrant]);
      const hide = (state) => page.evaluate((value) => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value }); document.dispatchEvent(new Event('visibilitychange')); }, state);
      await hide('hidden');
      await page.getByTestId('a2p-prep-cleared').waitFor();
      assert.equal(await page.getByTestId('a2p-prep-summary').count(), 0);
      await hide('visible');
      await page.getByText(tr('en', 'a2p.prep.cleared.SCHOOL_CHANGED')).waitFor();
      await page.getByText(tr('en', 'a2p.prep.ready.title', { school: 'Synthetic Dojo North' })).waitFor();
      assert.equal(await page.locator('#a2p-fact-businessName').inputValue(), '');
      await shot(page, 'desktop-school-changed', false); await axe(page, 'school changed');
    } finally { await context.close(); }
  });

  await check('owner role changes mid-draft: the server refuses the attestation and the UI withdraws it', async () => {
    const { context, page } = await open(people.demoted, VIEWPORTS.desktop);
    try {
      await ready(page);
      assert.equal(await page.getByTestId('a2p-prep-authority').textContent(), tr('en', 'a2p.prep.authority.owner'));
      await fill(page);
      await step(page, 2);
      await page.getByTestId('a2p-prep-attest').check();
      // The same grant now points at the delegated A2P role: preparation stays allowed, owner confirmation does not.
      await sql('UPDATE hon.principal_role_grants SET role_id=$2 WHERE id=$1', [people.demoted.grant, roles.staff]);
      await page.getByRole('button', { name: tr('en', 'a2p.prep.draft.start') }).click();
      await page.getByText(tr('en', 'a2p.prep.error.OWNER_CONFIRMATION_REQUIRED')).waitFor();
      assert.equal(await page.getByTestId('a2p-prep-attest').isChecked(), false);
      assert(await page.getByTestId('a2p-prep-attest').isDisabled());
      await shot(page, 'desktop-owner-authority-withdrawn'); await axe(page, 'authority withdrawn');
    } finally { await context.close(); }
  });

  await check('expired session: the page shows sign-in, not results', async () => {
    const { context, page } = await open(people.owner, VIEWPORTS.desktop, { expired: true });
    try {
      const response = await page.goto(origin + ROUTE);
      const url = new URL(page.url());
      assert(url.pathname !== ROUTE || (await page.getByTestId('a2p-prep-UNAUTHORIZED').count()) === 1, `expected sign-in, got ${url.pathname} ${response?.status()}`);
      await shot(page, 'desktop-session-expired', false);
    } finally { await context.close(); }
  });

  await check('no database footprint: table counts and activation gates unchanged; no facts in URLs or browser storage', async () => {
    assert.deepEqual(await counts(), footprint);
    assert.deepEqual(await gates(), posture);
    assert.equal(report.blockedRequests.length, 0, JSON.stringify(report.blockedRequests));
    assert.equal(report.postBodiesInUrls, 0);
    assert.equal(report.storageLeaks, 0);
    const unexpected = report.apiRequests.filter((r) => !/^(GET \/api\/v1\/staff\/current-reporting-school|GET \/api\/v1\/organizations\/[0-9a-f-]+\/schools\/[0-9a-f-]+\/interface-theme|GET \/api\/v1\/me\/language-preference|POST \/api\/v1\/organizations\/[0-9a-f-]+\/schools\/[0-9a-f-]+\/a2p\/(website-review|finding-details|registration-draft|draft-validation|copy-preparation))$/.test(r));
    assert.deepEqual(unexpected, []);
  });
} finally {
  await browser.close();
  next.kill('SIGTERM');
  await app.close();
  await owner.end();
  report.pageErrors = [...new Set(report.pageErrors)];
  report.httpErrors = [...new Set(report.httpErrors)];
  report.failedRequests = [...new Set(report.failedRequests)];
  await writeFile(join(results, 'report.json'), JSON.stringify({ ...report, apiRequestCount: report.apiRequests.length, apiRequests: [...new Set(report.apiRequests.map((r) => r.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')))] }, null, 2));
  if (report.failures.length) console.log(nextLog.slice(-4000));
}
console.log(JSON.stringify({ checks: report.checks.length, failures: report.failures.length, screenshots: report.screenshots.length, pageErrors: report.pageErrors }, null, 2));
if (report.failures.length || report.pageErrors.length) process.exitCode = 1;
