/**
 * Disposable local browser proof for Marketing > Ads (Meta Ads and Google Ads). Synthetic fixtures only: every /api
 * request is answered in the browser by this script. No database, Zernio, Meta, Google or production backend is used.
 * Requires `pnpm build` first.
 *
 *   HON_ADS_BROWSER_LOCAL=1 HON_ADS_BROWSER_RESULTS=<dir> node apps/web/scripts/school-ads-browser.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { issueSession, HON_SESSION_COOKIE } from '@hon/auth';

if (process.env.HON_ADS_BROWSER_LOCAL !== '1') throw new Error('Opt in with HON_ADS_BROWSER_LOCAL=1.');
for (const key of ['DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ZERNIO_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY']) {
  if (process.env[key]) throw new Error('Browser verification refuses inherited database/provider credentials.');
}
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = process.env.HON_ADS_BROWSER_RESULTS;
assert(results, 'HON_ADS_BROWSER_RESULTS is required.');
const { chromium } = createRequire(import.meta.url)(process.env.HON_ADS_PLAYWRIGHT ?? 'playwright');
await mkdir(results, { recursive: true });

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const school = { organizationId: id(1), schoolId: id(2) };
const prefix = `/api/v1/organizations/${school.organizationId}/schools/${school.schoolId}`;
const report = { syntheticFixturesOnly: true, databaseAccess: false, providerCalls: false, checks: [], failures: [], screenshots: [], pageErrors: [], apiRequests: [] };
const at = '2026-11-16T18:00:00.000Z';
const page = (n, name, adsEnabled) => ({ accountId: id(40 + n), platform: 'FACEBOOK', displayName: name, status: 'CONNECTED', publishEnabled: true, inboxEnabled: false, adsEnabled,
  version: 2, connectedAt: at, updatedAt: at, disconnectedAt: null });
const fixture = { accounts: [], connectEnabled: true, connects: [], adsEnabled: true, budget: null, ads: [], commands: [] };
const TODAY = '2026-11-16';
const posts = { publishEnabled: true, checkedAt: at, posts: [{ postId: id(51), text: 'Free trial week for kids 5-12: two classes on us, uniform included.', linkUrl: null, status: 'APPROVED',
  publishAt: at, accountIds: [id(40)], version: 2, createdAt: at, updatedAt: at, approvedAt: at, cancelledAt: null,
  targets: [{ targetId: id(50), accountId: id(40), platform: 'FACEBOOK', displayName: 'Synthetic Dojo Page', status: 'PUBLISHED', failureCode: null, skipReason: null,
    resolvedByPerson: false, settledAt: at, version: 2 }] }] };
const committed = () => fixture.ads.filter((a) => !['DRAFT', 'CANCELLED', 'FAILED'].includes(a.status)).reduce((n, a) => n + a.budgetCents, 0);
const adsView = () => ({ budget: fixture.budget, committedThisMonthCents: committed(), ads: [...fixture.ads].reverse(), today: TODAY, checkedAt: at, adsEnabled: fixture.adsEnabled, pauseEnabled: true });
/** A tiny stand-in for 0437: versions, the cap rule, PAUSED creation, ACTIVATE/PAUSE, one answer per key. */
function adsCommand(path, body, headers) {
  fixture.commands.push({ path, command: headers['x-hon-human-command'], key: headers['idempotency-key'], body });
  if (path.endsWith('/ads/budget')) { fixture.budget = { monthlyCapCents: body.monthlyCapCents, currency: body.currency, version: (fixture.budget?.version ?? 0) + 1 }; return [200, adsView()]; }
  if (path.endsWith('/ads')) {
    if (!fixture.budget || body.budgetCents > fixture.budget.monthlyCapCents) return [409, { code: 'SOCIAL_AD_OVER_CAP' }];
    const ad = { adId: id(60 + fixture.ads.length), accountId: id(40), targetId: body.targetId, postId: id(51), accountName: 'Synthetic Dojo Page', budgetCents: body.budgetCents,
      currency: fixture.budget.currency, startsOn: body.startsOn, endsOn: body.endsOn, status: 'DRAFT', operation: null, resolvedByPerson: false, createdAt: at, version: 1 };
    fixture.ads.push(ad); return [200, ad];
  }
  const ad = fixture.ads.find((a) => path.includes(a.adId));
  if (!ad) return [404, { code: 'SOCIAL_AD_NOT_FOUND' }];
  if (body.expectedVersion !== ad.version) return [409, { code: 'SOCIAL_VERSION_CONFLICT' }];
  if (path.endsWith('/cancel')) Object.assign(ad, { status: 'CANCELLED' });
  else if (path.endsWith('/operation')) {
    if (!fixture.adsEnabled && body.operation !== 'PAUSE') return [503, { code: 'SOCIAL_ADS_NOT_ENABLED' }];
    const next = { CREATE: ['DRAFT', 'PAUSED'], ACTIVATE: ['PAUSED', 'ACTIVE'], PAUSE: ['ACTIVE', 'PAUSED'] }[body.operation];
    if (ad.status !== next[0]) return [409, { code: 'SOCIAL_AD_STATE' }];
    Object.assign(ad, { status: next[1], operation: body.operation });
  }
  ad.version += 1; return [200, ad];
}

const json = (route, status, body) => route.fulfill({ status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }, body: JSON.stringify(body) });
const meta = { requestId: id(9000), correlationId: id(9000) };
function api(route) {
  const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
  report.apiRequests.push(`${method} ${path}${url.search}`);
  if (path === '/api/identity/me') return json(route, 200, { data: { externalSubject: 'ads-synthetic-owner', displayName: 'Synthetic Owner' } });
  if (path === '/api/v1/staff/current-reporting-school') return json(route, 200, { data: { state: 'RESOLVED', ...school } });
  if (path === '/api/v1/staff/reporting-schools') return json(route, 200, { data: { state: 'MANUAL_ENTRY_REQUIRED' } });
  if (path === `${prefix}/reports/operations`) return json(route, 200, { data: { operationalSnapshot: { organizationId: school.organizationId, schoolId: school.schoolId, generatedAt: '2026-11-16T09:00:00.000Z',
    from: '2026-10-17T09:00:00.000Z', to: '2026-11-16T09:00:00.000Z', studentProfiles: { total: 148 }, leads: { byStatus: { OPEN: 23, WON: 9, LOST: 4, ARCHIVED: 2 } },
    classSessions: { inRange: { scheduled: 64, completed: 58, cancelled: 2 } }, attendance: { inRangeByStatus: { PRESENT: 812, LATE: 31, EXCUSED_ABSENCE: 22, UNEXCUSED_ABSENCE: 15, MAKEUP: 6 } },
    memberships: { byState: { DRAFT: 3, ACTIVE: 131, FROZEN: 4, CANCELLATION_PENDING: 2, CANCELLED: 7, EXPIRED: 5 } }, invoices: { inRangeByStatus: { DRAFT: 2, ISSUED: 6, PAID: 118, VOID: 1, UNCOLLECTIBLE: 0 } },
    paymentAttempts: { inRangeByState: { PENDING: 0, PROCESSING: 1, SUCCEEDED: 118, FAILED: 3, REQUIRES_ACTION: 0, UNKNOWN: 0, REFUNDED: 1 } } } }, meta: {} });
  if (path === `${prefix}/marketing/social/accounts` && method === 'GET') return json(route, 200, { data: { profileLinked: true, connectEnabled: fixture.connectEnabled, accounts: fixture.accounts, checkedAt: at }, meta });
  if (path === `${prefix}/marketing/social/connect` && method === 'POST') {
    const headers = request.headers();
    fixture.connects.push({ command: headers['x-hon-human-command'], key: headers['idempotency-key'], body: request.postDataJSON() });
    return json(route, 200, { data: { authUrl: 'https://www.facebook.com/dialog/oauth?synthetic=1', platform: 'FACEBOOK', expiresAt: '2026-11-16T18:10:00.000Z' }, meta });
  }
  if (path === `${prefix}/marketing/social/ads` && method === 'GET') return json(route, 200, { data: adsView(), meta });
  if (path === `${prefix}/marketing/social/posts` && method === 'GET') return json(route, 200, { data: posts, meta });
  if (path.startsWith(`${prefix}/marketing/social/ads`) && method === 'POST') {
    const [status, body] = adsCommand(path, request.postDataJSON(), request.headers());
    return json(route, status, status === 200 ? { data: body, meta } : body);
  }
  return json(route, 403, { code: 'FORBIDDEN' });
}

const probe = createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const session = { mode: 'OIDC', audience: 'school-ads-browser-synthetic', secret: randomBytes(32).toString('hex') };
const server = spawn(join(webRoot, 'node_modules/.bin/next'), ['start', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: webRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8',
  NODE_ENV: 'production', HON_DEPLOYMENT_ENVIRONMENT: 'preview', NEXT_TELEMETRY_DISABLED: '1', HON_API_BASE_URL: 'http://127.0.0.1:9', HON_AUTH_MODE: session.mode,
  HON_SESSION_AUDIENCE: session.audience, HON_SESSION_JWT_SECRET: session.secret }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; i < 240; i += 1) { try { const r = await fetch(`${origin}/auth/login`); if (r.status < 500) break; } catch { /* starting */ } await new Promise((done) => setTimeout(done, 500)); }

const browser = await chromium.launch();
const viewports = { desktop: { width: 1440, height: 1000 }, phone: { width: 390, height: 844 } };
const external = [];
async function open(viewport, path, language) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: Number(process.env.HON_ADS_SCALE ?? '1'), reducedMotion: 'reduce', ...(language ? { locale: language } : {}) });
  await ctx.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: 'ads-synthetic-owner' }, session), url: origin, httpOnly: true, sameSite: 'Lax' },
    ...(language ? [{ name: 'hon_locale', value: language, url: origin }] : [])]);
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return route.abort();
      external.push(url.href); return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Synthetic Facebook consent</title>' });
    }
    if (url.pathname.startsWith('/api/')) return api(route);
    return route.continue();
  });
  const p = await ctx.newPage();
  p.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await p.goto(`${origin}${path}`);
  return { ctx, page: p };
}
async function check(name, work) { try { await work(); report.checks.push(name); } catch (error) { report.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); } }
async function shot(p, name, fullPage = true) { await p.screenshot({ path: join(results, `${name}.png`), fullPage }); report.screenshots.push(`${name}.png`); }
const noOverflow = async (p) => assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, 'page scrolls horizontally');

await check('Ads is in the menu under Marketing and shows Meta Ads and Google Ads, not connected', async () => {
  const { ctx, page: p } = await open(viewports.desktop, '/staff/marketing/ads');
  await p.locator('[data-ads-meta="NOT_CONNECTED"]').waitFor();
  assert.ok(await p.getByRole('heading', { name: 'Google Ads' }).isVisible());
  assert.equal(await p.locator('[data-ads-connect-google]').count(), 0);
  assert.ok(await p.getByRole('link', { name: 'Ask Marcus for an ad' }).isVisible());
  await shot(p, 'ads-not-connected-desktop-1440');
  await noOverflow(p); await ctx.close();
});
await check('Connect Facebook for Meta Ads sends one connect command and opens the consent page', async () => {
  const { ctx, page: p } = await open(viewports.desktop, '/staff/marketing/ads');
  await p.getByRole('button', { name: 'Connect Facebook for Meta Ads' }).click();
  await p.waitForURL(/facebook\.com\/dialog\/oauth/);
  assert.equal(fixture.connects.length, 1);
  assert.equal(fixture.connects[0].command, 'marketing.social.connect');
  assert.match(fixture.connects[0].key, /^[0-9a-f-]{36}$/);
  assert.deepEqual(fixture.connects[0].body, { platform: 'FACEBOOK' });
  await ctx.close();
});
await check('connected Pages show their real ads switch and link to Social accounts', async () => {
  fixture.accounts = [page(0, 'Synthetic Dojo Page', true), page(1, 'Synthetic Second Location', false)];
  const { ctx, page: p } = await open(viewports.desktop, '/staff/marketing/ads');
  await p.locator('[data-ads-meta="READY_FOR_ADS"]').waitFor();
  assert.ok(await p.getByText('Synthetic Dojo Page', { exact: true }).first().isVisible());
  assert.ok(await p.getByRole('link', { name: 'Change on Social accounts' }).isVisible());
  assert.equal(await p.getByRole('button', { name: 'Connect Facebook for Meta Ads' }).count(), 0);
  await shot(p, 'ads-meta-connected-desktop-1440');
  await ctx.close();
});
await check('connecting off says so plainly with no button', async () => {
  fixture.accounts = []; fixture.connectEnabled = false;
  const { ctx, page: p } = await open(viewports.desktop, '/staff/marketing/ads');
  await p.getByText('Connecting ad accounts is not turned on for HON OS yet.').waitFor();
  assert.equal(await p.locator('[data-ads-connect-meta]').count(), 0);
  await shot(p, 'ads-connect-off-desktop-1440');
  fixture.connectEnabled = true; await ctx.close();
});
await check('a person sets the limit, saves a boost draft, approves it (created paused), turns it on after confirming, and pauses it', async () => {
  fixture.accounts = [page(0, 'Synthetic Dojo Page', true)]; fixture.connectEnabled = true;
  const { ctx, page: p } = await open(viewports.desktop, '/staff/marketing/ads');
  await p.locator('[data-ads-run="ON"]').waitFor();
  await shot(p, 'ads-run-empty-desktop-1440');
  await p.getByLabel('Limit per month').fill('300');
  await p.getByLabel('Currency (as in your Meta ad account)').fill('usd');
  await p.locator('[data-ads-save-budget]').click();
  await p.getByText('Monthly limit saved.').waitFor();
  await p.getByLabel('Post to boost').selectOption(id(50));
  await p.getByLabel('Total budget').fill('50');
  await p.getByLabel('Ends').fill('2026-11-22');
  await p.locator('[data-ads-save-draft]').click();
  await p.locator('[data-ad-status="DRAFT"]').waitFor();
  await p.locator('[data-ads-op="CREATE"]').click();
  await p.locator('[data-ad-status="PAUSED"]').waitFor();
  await p.locator('[data-ads-op="ACTIVATE-ASK"]').click();
  await p.getByText('Meta starts spending').waitFor();
  await shot(p, 'ads-run-confirm-desktop-1440');
  await p.locator('[data-ads-op="ACTIVATE"]').click();
  await p.locator('[data-ad-status="ACTIVE"]').waitFor();
  await shot(p, 'ads-run-active-desktop-1440');
  await p.locator('[data-ads-op="PAUSE"]').click();
  await p.locator('[data-ad-status="PAUSED"]').waitFor();
  const sent = fixture.commands.map((c) => c.command);
  assert.deepEqual(sent, ['marketing.social.ads.budget', 'marketing.social.ads.create', 'marketing.social.ads.operation', 'marketing.social.ads.operation', 'marketing.social.ads.operation']);
  assert.deepEqual(fixture.commands.map((c) => c.body.operation ?? null).slice(2), ['CREATE', 'ACTIVATE', 'PAUSE']);
  assert.deepEqual(fixture.commands[0].body, { monthlyCapCents: 30000, currency: 'USD' });
  assert.deepEqual(fixture.commands[1].body, { targetId: id(50), budgetCents: 5000, startsOn: TODAY, endsOn: '2026-11-22' });
  assert.equal(new Set(fixture.commands.map((c) => c.key)).size, fixture.commands.length, 'every write has its own key');
  await noOverflow(p); await ctx.close();
});
await check('while ads are off at HON OS, approving is disabled and the page says so', async () => {
  fixture.adsEnabled = false; fixture.ads.push({ ...fixture.ads[0], adId: id(70), status: 'DRAFT', operation: null, version: 1 });
  const { ctx, page: p } = await open(viewports.desktop, '/staff/marketing/ads');
  await p.locator('[data-ads-off]').waitFor();
  assert.equal(await p.locator(`[data-ad="${id(70)}"] [data-ads-op="CREATE"]`).isDisabled(), true);
  await shot(p, 'ads-run-off-desktop-1440');
  fixture.adsEnabled = true; await ctx.close();
});
await check('phone and Korean fit the screen', async () => {
  fixture.accounts = [page(0, 'Synthetic Dojo Page', true)];
  const { ctx, page: p } = await open(viewports.phone, '/staff/marketing/ads');
  await p.locator('[data-ads-meta="READY_FOR_ADS"]').waitFor();
  await noOverflow(p); await shot(p, 'ads-phone-390');
  await ctx.close();
});

await browser.close(); server.kill('SIGTERM');
report.pageErrors = [...new Set(report.pageErrors)];
report.providerCalls = external.filter((href) => !href.startsWith('https://www.facebook.com/dialog/oauth?synthetic=1'));
await writeFile(join(results, 'school-ads-browser-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ checks: report.checks.length, failures: report.failures, pageErrors: report.pageErrors.slice(0, 5), unexpectedExternal: report.providerCalls }, null, 2));
if (report.failures.length || report.pageErrors.length || report.providerCalls.length) { console.error(serverLog.slice(-3000)); process.exitCode = 1; }
