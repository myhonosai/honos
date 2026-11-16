/**
 * Disposable local browser proof for the U1 school shell and the U2 school Home. Synthetic fixtures only:
 * every /api request is answered in the browser by this script. No database,
 * provider, payment or production backend is used. Requires `pnpm build` first.
 *
 *   HON_SHELL_BROWSER_LOCAL=1 HON_SHELL_BROWSER_RESULTS=<dir> node apps/web/scripts/school-shell-browser.mjs
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

if (process.env.HON_SHELL_BROWSER_LOCAL !== '1') throw new Error('Opt in with HON_SHELL_BROWSER_LOCAL=1.');
for (const key of ['DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY']) {
  if (process.env[key]) throw new Error('Browser verification refuses inherited database/provider credentials.');
}
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = process.env.HON_SHELL_BROWSER_RESULTS;
assert(results, 'HON_SHELL_BROWSER_RESULTS is required.');
const { chromium } = createRequire(import.meta.url)(process.env.HON_SHELL_PLAYWRIGHT ?? 'playwright');
await mkdir(results, { recursive: true });
// Optional: path to axe-core's axe.min.js for a WCAG 2.1 AA scan of the shell and Home.
const axeSource = process.env.HON_SHELL_AXE ? await (await import('node:fs/promises')).readFile(process.env.HON_SHELL_AXE, 'utf8') : null;
async function axeScan(page, name) {
  if (!axeSource) return;
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  const violations = result.violations.map((v) => ({ id: v.id, impact: v.impact, targets: v.nodes.slice(0, 6).map((n) => n.target.join(' ')) }));
  report.accessibility = [...(report.accessibility ?? []), { name, violations }];
  assert.deepEqual(violations, [], `${name}: ${JSON.stringify(violations)}`);
}

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const schoolA = { organizationId: id(1), schoolId: id(2) }, schoolB = { organizationId: id(1), schoolId: id(3) };
const report = { syntheticFixturesOnly: true, databaseAccess: false, providerCalls: false, checks: [], failures: [], screenshots: [], pageErrors: [], apiRequests: [] };
let theme = 'modern', multi = false, readinessDenied = false, leadsGate = null, sessionEnded = false;
const iso = () => '2026-11-06T09:00:00.000Z';
const snapshot = (scope) => ({
  organizationId: scope.organizationId, schoolId: scope.schoolId, generatedAt: iso(), from: '2026-10-07T09:00:00.000Z', to: iso(),
  studentProfiles: { total: 148 }, leads: { byStatus: { OPEN: 23, WON: 9, LOST: 4, ARCHIVED: 2 } },
  classSessions: { inRange: { scheduled: 64, completed: 58, cancelled: 2 } },
  attendance: { inRangeByStatus: { PRESENT: 812, LATE: 31, EXCUSED_ABSENCE: 22, UNEXCUSED_ABSENCE: 15, MAKEUP: 6 } },
  memberships: { byState: { DRAFT: 3, ACTIVE: 131, FROZEN: 4, CANCELLATION_PENDING: 2, CANCELLED: 7, EXPIRED: 5 } },
  invoices: { inRangeByStatus: { DRAFT: 2, ISSUED: 6, PAID: 118, VOID: 1, UNCOLLECTIBLE: 0 } },
  paymentAttempts: { inRangeByState: { PENDING: 0, PROCESSING: 1, SUCCEEDED: 118, FAILED: 3, REQUIRES_ACTION: 0, UNKNOWN: 0, REFUNDED: 1 } },
});

const day = 86_400_000, at = (offset) => new Date(Date.parse(iso()) + offset).toISOString();
const win = (count, from, to) => ({ availability: 'AVAILABLE', windowFrom: at(from), windowTo: at(to), count });
const commandCenter = (scope) => ({
  organizationId: scope.organizationId, schoolId: scope.schoolId, entitlementTier: 'COMPLETE', generatedAt: iso(),
  metrics: { newLeads24h: win(5, -day, 0), upcomingTrials24h: win(2, 0, day), upcomingTestingEvents30d: win(1, 0, 30 * day),
    pendingActionApprovals: { availability: 'AVAILABLE', count: 3 }, outstandingWorkItems: { availability: 'AVAILABLE', count: 2 }, membershipTermsEnding30d: win(4, 0, 30 * day),
    paidInvoicesCreated30d: { ...win(2, -30 * day, 0), amountsByCurrency: [{ currency: 'USD', count: 2, totalMinor: 30000 }] },
    unansweredInquiries: { availability: 'UNAVAILABLE', reason: 'No approved inquiry response-state projection exists.' },
    attendanceDecline: { availability: 'INSUFFICIENT_DATA', reason: 'No approved attendance-decline policy or longitudinal projection exists.' },
    trialConversion: { availability: 'UNAVAILABLE', reason: 'No authoritative trial-to-enrollment linkage is available.' },
    revenue: { availability: 'UNAVAILABLE', reason: 'Current paid invoice state is not authoritative cash revenue or collection data.' } },
  dailyBriefing: 'Daily briefing: 5 new leads in the last 24 hours; 2 trial appointments scheduled in the next 24 hours; 1 testing event in the next 30 days; 4 membership terms ending in the next 30 days; 3 action approvals awaiting review; 2 outstanding durable work items.',
  recommendations: [
    { id: 'REVIEW_PENDING_APPROVALS', title: 'Review pending approvals', why: '3 current action requests are awaiting a qualified human review.', route: '/staff/action-center/approvals', action: 'NAVIGATE', automaticExecution: false },
    { id: 'REVIEW_OUTSTANDING_WORK', title: 'Review outstanding work', why: '2 durable work items remain in a nonterminal state.', route: '/staff/work', action: 'NAVIGATE', automaticExecution: false },
    { id: 'PREPARE_UPCOMING_TRIALS', title: 'Prepare upcoming trials', why: '2 scheduled trial appointments start within 24 hours.', route: '/staff/search', action: 'NAVIGATE', automaticExecution: false },
    { id: 'REVIEW_NEW_LEADS', title: 'Review new leads', why: '5 CRM leads were created in the last 24 hours.', route: '/staff/search', action: 'NAVIGATE', automaticExecution: false },
    { id: 'PREPARE_MEMBERSHIP_RENEWALS', title: 'Prepare membership reviews', why: '4 active or cancellation-pending membership terms end within 30 days.', route: '/staff/billing/renewals', action: 'NAVIGATE', automaticExecution: false },
  ],
});
const agent = (agentKey, name, credits) => ({ agentKey, agent: name, authorized: true, spendDecision: 'ALLOWED', route: 'CONFIGURED', requestCredits: credits,
  providerRuntime: 'CONFIGURATION_REQUIRED', available: false, blockedBy: 'PROVIDER_RUNTIME_NOT_CONFIGURED' });
const readiness = (scope) => ({ ...scope, completeEntitlement: true, agentBudget: null, asOf: iso(), honConversation: { contract: true },
  agents: [agent('marcus', 'MARKETING', 6), agent('claire', 'TEACHING', 6), agent('chad', 'CHAD_FOLLOW_UP', 3)] });
const today = new Date(); today.setHours(0, 0, 0, 0);
const todayAt = (hours) => new Date(today.getTime() + hours * 3_600_000).toISOString();
const sessions = () => [['Little Tigers', 16.5, 'Main mat'], ['Junior Black Belt Club', 17.5, 'Main mat'], ['Adult Sparring', 19, 'Studio B']]
  .map(([name, hour, room], i) => ({ sessionId: id(100 + i), name, startsAt: todayAt(hour), endsAt: todayAt(hour + 1), roomName: room, capacity: 20, bookingPolicy: 'WALK_IN', status: 'SCHEDULED', createdAt: iso() }));
const leads = () => [['Avery', 'Sample', 1], ['Rowan', 'Example', 2], ['Kim', 'Placeholder', 3]]
  .map(([givenName, familyName, n]) => ({ id: id(200 + n), status: 'OPEN', pipelineStageId: id(300), primaryPersonId: id(400 + n), version: 1, createdAt: at(-n * day), givenName, familyName }));
const work = (scope) => ({ schoolId: scope.schoolId, principalId: id(500), canManage: true, canCreate: true, humanOnly: true, executionAllowed: false, queue: 'mine', status: 'ACTIVE',
  items: [{ title: 'Call back trial family', workItemId: id(601), version: 1, status: 'READY', priority: 'HIGH', dueAt: at(day), assigneeId: id(500) },
    { title: 'Order new belts for testing', workItemId: id(602), version: 1, status: 'WAITING', priority: 'NORMAL', dueAt: null, assigneeId: id(500) }], nextAfter: null });
const json = (route, status, body) => route.fulfill({ status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }, body: JSON.stringify(body) });
function api(route) {
  const url = new URL(route.request().url()), path = url.pathname, method = route.request().method();
  report.apiRequests.push(`${method} ${path}`);
  if (path === '/api/identity/me' && sessionEnded) return json(route, 401, { error: { code: 'UNAUTHENTICATED' } });
  if (path === '/api/identity/me') return json(route, 200, { data: { externalSubject: 'shell-synthetic-owner', displayName: 'Synthetic Owner' } });
  if (path === '/api/v1/staff/current-reporting-school') return json(route, 200, { data: multi ? { state: 'MANUAL_ENTRY_REQUIRED' } : { state: 'RESOLVED', ...schoolA } });
  if (path === '/api/v1/staff/reporting-schools') return json(route, 200, { data: multi
    ? { state: 'SELECTION_REQUIRED', schools: [{ ...schoolA, organizationName: 'Synthetic Dojo Group', schoolName: 'Synthetic North Academy' }, { ...schoolB, organizationName: 'Synthetic Dojo Group', schoolName: 'Synthetic South Academy' }] }
    : { state: 'MANUAL_ENTRY_REQUIRED' } });
  if (path === '/api/v1/staff/work') return json(route, 200, { data: work(multi ? schoolB : schoolA) });
  for (const scope of [schoolA, schoolB]) {
    const prefix = `/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}`;
    if (path === `${prefix}/command-center`) return json(route, 200, { data: { commandCenter: commandCenter(scope) }, meta: {} });
    if (path === `${prefix}/ai/team/capabilities`) return readinessDenied ? json(route, 403, { code: 'AI_TEAM_READINESS_FORBIDDEN' }) : json(route, 200, { data: readiness(scope), meta: { requestId: 'r', correlationId: 'r' } });
    if (path === `${prefix}/crm/leads`) return leadsGate ? leadsGate.then(() => json(route, 200, { data: leads(), meta: {} })) : json(route, 200, { data: leads(), meta: {} });
    if (path === `${prefix}/schedule/sessions`) return json(route, 200, { data: sessions(), meta: { requestId: id(700), correlationId: id(700) } });
    if (path === `${prefix}/pickers/testing-candidates`) return json(route, 200, { data: [['Avery', 'Sample', 'PASSED'], ['Rowan', 'Example', 'PASSED'], ['Kim', 'Placeholder', 'DEFERRED']]
      .map(([givenName, familyName, result], i) => ({ candidateId: id(800 + i), version: 2, result, testingEventId: id(810), testingEventName: 'Synthetic spring test', startsAt: at(-day),
        studentProfileId: id(820 + i), givenName, familyName, curriculumName: 'Synthetic curriculum', targetRankId: id(830), targetRankName: 'Yellow belt' })), meta: { requestId: id(840), correlationId: id(840), limit: 50 } });
    if (path === `${prefix}/reports/operations`) return json(route, 200, { data: { operationalSnapshot: snapshot(scope) }, meta: {} });
    if (path === `${prefix}/interface-theme`) {
      if (method === 'PUT') theme = JSON.parse(route.request().postData() ?? '{}').interfaceTheme ?? theme;
      return json(route, 200, { data: { interfaceTheme: theme, selectedVia: 'SETTINGS', updatedAt: iso() }, meta: {} });
    }
  }
  return json(route, 403, { code: 'FORBIDDEN' });
}

const probe = createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const session = { mode: 'OIDC', audience: 'school-shell-browser-synthetic', secret: randomBytes(32).toString('hex') };
const server = spawn(join(webRoot, 'node_modules/.bin/next'), ['start', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: webRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'production', HON_DEPLOYMENT_ENVIRONMENT: 'preview', NEXT_TELEMETRY_DISABLED: '1', HON_API_BASE_URL: 'http://127.0.0.1:9', HON_AUTH_MODE: session.mode, HON_SESSION_AUDIENCE: session.audience, HON_SESSION_JWT_SECRET: session.secret }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; i < 240; i += 1) { try { const r = await fetch(`${origin}/auth/login`); if (r.status < 500) break; } catch { /* starting */ } await new Promise((done) => setTimeout(done, 500)); }

const browser = await chromium.launch();
async function open(viewport, path, { language, clock } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await ctx.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: 'shell-synthetic-owner' }, session), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/api/')) return api(route);
    return route.continue();
  });
  const page = await ctx.newPage();
  if (clock) await page.clock.install();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(`${origin}${path}`);
  if (language) await page.evaluate((l) => { document.documentElement.lang = l; }, language);
  return { ctx, page };
}
async function check(name, work) { try { await work(); report.checks.push(name); } catch (error) { report.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); } }
async function shot(page, name) { await page.screenshot({ path: join(results, `${name}.png`) }); report.screenshots.push(`${name}.png`); }
async function noOverflow(page) {
  const offenders = await page.evaluate(() => [...document.querySelectorAll('[data-hon-ui] *')]
    .filter((e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.right > window.innerWidth + 1 && s.position !== 'fixed' && !e.closest('[data-drawer="closed"]') && !e.closest('nav[aria-label] a') ; })
    .slice(0, 5).map((e) => `${e.tagName}.${e.className}`));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `page scrolls horizontally: ${offenders.join(', ')}`);
}
const viewports = { desktop: { width: 1440, height: 900 }, tablet: { width: 834, height: 1112 }, phone: { width: 390, height: 844 } };

for (const mode of ['modern', 'classic', 'big-button']) for (const [size, viewport] of Object.entries(viewports)) {
  await check(`dashboard ${mode} ${size}`, async () => {
    theme = mode; multi = false;
    const { ctx, page } = await open(viewport, '/staff/dashboard');
    await page.waitForFunction((value) => document.querySelector('[data-hon-ui="school"]')?.getAttribute('data-hon-mode') === value, mode);
    await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
    const href = await page.locator('nav[aria-label="School navigation"] a[data-nav="home"]').getAttribute('href');
    assert.equal(href, `/staff/dashboard?organizationId=${schoolA.organizationId}&schoolId=${schoolA.schoolId}`);
    await page.waitForSelector('[data-kpi="activeMemberships"][data-state="VALUE"]');
    await page.waitForSelector('[data-agent="kai"][data-status="PROVIDER_OFF"]');
    await page.getByText('Little Tigers').waitFor(); await page.getByText('Call back trial family').waitFor(); await page.getByText('Rowan Example').waitFor();
    assert.equal(await page.locator('[data-kpi="activeMemberships"] strong').textContent(), '131');
    assert.equal(await page.locator('[data-locale-utility] select').count(), 1, 'exactly one language selector');
    assert.equal(await page.locator('[data-locale-utility] select').isVisible(), true, 'language selector reachable at every width');
    assert.equal(await page.locator('[data-kpi="revenue"]').getAttribute('data-state'), 'NOT_CONNECTED');
    assert.equal(await page.locator('[data-agent="claire"]').getAttribute('data-status'), 'UNKNOWN');
    await page.waitForTimeout(150);
    await noOverflow(page);
    await axeScan(page, `home-${mode}-${size}`);
    await shot(page, `u2-home-${mode}-${size}`);
    if (size === 'desktop') { await page.screenshot({ path: join(results, `u2-home-${mode}-desktop-full.png`), fullPage: true }); report.screenshots.push(`u2-home-${mode}-desktop-full.png`); }
    await ctx.close();
  });
}
await check('art style chip redraws the team without changing availability, and is remembered on this device', async () => {
  theme = 'modern'; multi = false; const { ctx, page } = await open(viewports.desktop, '/staff/dashboard');
  await page.waitForSelector('[data-agent="kai"][data-status="PROVIDER_OFF"]');
  assert.equal(await page.locator('[data-agent="chad"] img').getAttribute('src'), '/ai/chad.webp');
  for (const [label, style] of [['Illustrated', 'illustrated'], ['Chibi', 'chibi']]) {
    await page.getByRole('group', { name: 'Team art style' }).getByRole('button', { name: label, exact: true }).click();
    await page.waitForSelector(`[data-art="${style}"]`);
    assert.equal(await page.locator('[data-agent="chad"] img').getAttribute('src'), `/ai/chad-${style}.webp`);
    assert.equal(await page.locator('[data-agent="kai"]').getAttribute('data-status'), 'PROVIDER_OFF');
    assert.equal(await page.locator('[data-agent="claire"]').getAttribute('data-status'), 'UNKNOWN');
    await page.waitForTimeout(300); await shot(page, `u2-home-art-${style}-desktop`);
  }
  await page.reload(); await page.waitForSelector('[data-art="chibi"]');
  assert.equal(await page.locator('a[href="/staff/hon"][class*="honLauncher"]').count(), 0, 'no corner HON on the dashboard');
  // The HON workspace follows the same chosen style and shows the HON core orb.
  await page.goto(origin + '/staff/hon');
  await page.waitForSelector('img[src="/ai/chad-chibi.webp"]');
  assert.equal(await page.locator('img[src="/ai/hon-core.webp"]').count() > 0, true, 'HON workspace shows the HON core');
  assert.equal(await page.locator('img[src="/ai/kai-chibi.webp"]').count() > 0, true, 'Kai follows the chosen style');
  await page.waitForTimeout(400); await shot(page, 'u3-hon-workspace-chibi-desktop');
  await ctx.close();
});
await check('HON waits in the corner on other pages', async () => {
  theme = 'classic'; multi = false; const { ctx, page } = await open(viewports.desktop, '/staff/work');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  assert.equal(await page.locator('a[href="/staff/hon"][class*="honLauncher"]').isVisible(), true);
  await page.waitForTimeout(500); await shot(page, 'u2-hon-corner-classic-desktop'); await ctx.close();
});
await check('classic sidebar shows the owner menu headings with their pages, and the current page', async () => {
  theme = 'classic'; multi = false; const { ctx, page } = await open(viewports.desktop, '/staff/billing/invoices');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  const nav = page.locator('nav[aria-label="School navigation"]');
  assert.equal(await nav.locator('[data-nav-section]').count(), 12);
  assert.equal(await nav.locator('a[data-nav="invoices"]').getAttribute('aria-current'), 'page');
  assert.equal(await page.locator('[data-shell-groups]').count(), 0, 'no third level');
  await page.waitForTimeout(250); await axeScan(page, 'sidebar-classic'); await shot(page, 'l1-sidebar-classic-desktop');
  await page.setViewportSize({ width: 1440, height: 1600 }); await page.waitForTimeout(150); await shot(page, 'l1-sidebar-classic-desktop-tall');
  await ctx.close();
});
await check('modern top bar shows the everyday pages and More', async () => {
  theme = 'modern'; multi = false; const { ctx, page } = await open(viewports.desktop, '/staff/crm/follow-ups');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  const visible = await page.locator('nav[aria-label="School navigation"] a[data-nav]').evaluateAll((links) => links.filter((a) => a.offsetParent !== null).map((a) => a.dataset.nav));
  assert.deepEqual(visible, ['home', 'conversationAi', 'classes', 'attendance', 'students', 'crm']);
  await noOverflow(page); await shot(page, 'l1-topbar-modern-desktop'); await ctx.close();
});
for (const mode of ['modern', 'big-button']) await check(`${mode} menu panel lists every area`, async () => {
  theme = mode; multi = false; const { ctx, page } = await open(viewports.desktop, '/staff/work');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const panel = page.getByRole('dialog', { name: 'Menu' }); await panel.waitFor();
  // Owner menu (2026-11-16): eleven headings plus Settings; one card per page (24 pages).
  assert.equal(await panel.locator('[data-menu-section]').count(), 12);
  assert.equal(await panel.locator('[data-menu]').count(), 24);
  await page.waitForTimeout(250); await axeScan(page, `menu-${mode}`); await shot(page, `u2-menu-${mode}-desktop`);
  await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached' }); await ctx.close();
});
const privateNow = (page, trigger) => page.evaluate((how) => {
  if (how === 'hidden') { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); }
  else window.dispatchEvent(new Event(how));
  // Read in the same task as the event: concealment must not wait for a re-render.
  const nodes = [...document.querySelectorAll('[data-shell-private]')];
  if (how === 'hidden') delete document.visibilityState;
  return { count: nodes.length, concealed: nodes.every((node) => node.hidden && node.inert) };
}, trigger);
const phaseIs = (page, phase) => page.waitForFunction((value) => document.querySelector('[data-phase]')?.getAttribute('data-phase') === value, phase);
const saverNow = (page, how) => page.evaluate((how) => {
  if (how === 'hidden' || how === 'visible') {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => how });
    document.dispatchEvent(new Event('visibilitychange')); delete document.visibilityState;
  } else window.dispatchEvent(new Event(how));
  // Read in the same task as the event: the screensaver must not wait for a later render.
  return { saver: Boolean(document.querySelector('[data-screensaver]')), phase: document.querySelector('[data-phase]')?.getAttribute('data-phase') };
}, how);
await check('away shows a screensaver instead of hiding the school; tapping returns to the same page and school with a quiet re-check', async () => {
  theme = 'modern'; multi = false;
  const { ctx, page } = await open(viewports.desktop, '/staff/dashboard', { clock: true });
  await phaseIs(page, 'READY'); await page.waitForSelector('[data-kpi="students"][data-state="VALUE"]');
  const url = page.url(), identities = () => report.apiRequests.filter((line) => line === 'GET /api/identity/me').length;
  // Blur (another window, the address bar) does nothing at all.
  assert.deepEqual(await saverNow(page, 'blur'), { saver: false, phase: 'READY' });
  await page.evaluate(() => { window.__saverShown = 0; window.addEventListener('hon:screensaver-shown', () => { window.__saverShown += 1; }); });
  // Hidden (phone backgrounded, tab switched): screensaver at once, school kept.
  assert.deepEqual(await saverNow(page, 'hidden'), { saver: true, phase: 'READY' }, 'screensaver covers the app synchronously');
  assert.equal(await page.locator('[data-home="ready"]').count(), 1, 'the page stays mounted under the screensaver');
  assert.equal(await page.evaluate(() => window.__saverShown), 1, 'the shell announces the screensaver so hands-free voice turns off');
  // Back within 30 seconds: lifts by itself, quietly re-checks, nothing to re-choose.
  let before = identities();
  assert.deepEqual(await saverNow(page, 'visible'), { saver: true, phase: 'READY' });
  await page.waitForSelector('[data-screensaver]', { state: 'detached' });
  await page.waitForTimeout(300);
  assert.equal(identities() > before, true, 'returning re-checks the signed-in identity');
  assert.equal(page.url(), url); await phaseIs(page, 'READY'); assert.equal(await page.locator('[data-home="ready"]').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Show school', exact: true }).count(), 0, 'no Show school step any more');
  // Five idle minutes: screensaver; a tap returns to the same page and school.
  await page.clock.fastForward('05:01');
  await page.waitForSelector('[data-screensaver]');
  assert.equal(await page.evaluate(() => window.__saverShown), 2, 'idle also announces the screensaver');
  await page.waitForTimeout(400); await axeScan(page, 'screensaver'); await shot(page, 'screensaver-modern-desktop');
  before = identities();
  await page.getByRole('dialog', { name: 'Screensaver' }).click({ position: { x: 40, y: 40 } });
  await page.waitForSelector('[data-screensaver]', { state: 'detached' }); await page.waitForTimeout(300);
  assert.equal(identities() > before, true, 'a tap re-checks the signed-in identity');
  await phaseIs(page, 'READY'); assert.equal(page.url(), url); assert.equal(await page.locator('[data-home="ready"]').count(), 1);
  // Any key lifts it too.
  await saverNow(page, 'hidden'); await page.clock.fastForward('01:00'); await saverNow(page, 'visible');
  assert.equal(await page.locator('[data-screensaver]').count(), 1, 'a long absence waits for a tap');
  await page.keyboard.press('Enter'); await page.waitForSelector('[data-screensaver]', { state: 'detached' });
  // Session end still clears everything and asks for sign-in.
  await saverNow(page, 'hon:session-invalidated'); await phaseIs(page, 'SESSION');
  assert.equal(await page.locator('[data-home="ready"]').count(), 0, 'session end still hides the dashboard');
  assert.equal(await page.getByRole('button', { name: 'Show school', exact: true }).count(), 0, 'an ended session cannot be restored in place');
  await saverNow(page, 'blur'); await page.waitForTimeout(200);
  assert.equal(await page.locator('[data-phase]').getAttribute('data-phase'), 'SESSION', 'a later blur never downgrades an ended session');
  await ctx.close();
});
await check('quiet re-check after the screensaver moves an ended session to sign in again', async () => {
  theme = 'modern'; multi = false;
  const { ctx, page } = await open(viewports.desktop, '/staff/dashboard');
  await phaseIs(page, 'READY'); await page.waitForSelector('[data-home="ready"]');
  await saverNow(page, 'hidden'); sessionEnded = true; await saverNow(page, 'visible');
  await phaseIs(page, 'SESSION'); sessionEnded = false;
  assert.equal(await page.locator('[data-home="ready"]').count(), 0); await ctx.close();
});
for (const mode of ['modern', 'big-button', 'classic']) await check(`screensaver on a phone (${mode})`, async () => {
  theme = mode; multi = false; const { ctx, page } = await open(viewports.phone, '/staff/dashboard');
  await phaseIs(page, 'READY'); await saverNow(page, 'hidden');
  await page.waitForTimeout(400); await noOverflow(page); await shot(page, `screensaver-${mode}-phone`); await ctx.close();
});
await check('menu panel keeps keyboard focus inside and returns it to the opener', async () => {
  theme = 'modern'; multi = false; const { ctx, page } = await open(viewports.desktop, '/staff/work');
  await phaseIs(page, 'READY');
  const opener = page.getByRole('button', { name: 'Open navigation' }); await opener.focus(); await page.keyboard.press('Enter');
  const panel = page.getByRole('dialog', { name: 'Menu' }); await panel.waitFor();
  for (let i = 0; i < 70; i += 1) {
    await page.keyboard.press(i % 3 === 0 ? 'Shift+Tab' : 'Tab');
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), true, 'focus left the open menu');
  }
  assert.equal(await page.evaluate(() => Boolean(document.getElementById('hon-main')?.closest('[inert]'))), true, 'the page behind the menu is inert');
  await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Open navigation', 'focus returns to the menu button');
  await ctx.close();
});
await check('home shows a refused AI readiness as hidden, never as available', async () => {
  theme = 'modern'; multi = false; readinessDenied = true; const { ctx, page } = await open(viewports.desktop, '/staff/dashboard');
  await page.waitForSelector('[data-agent="chad"][data-status="HIDDEN"]');
  assert.equal(await page.locator('[data-status="READY"]').count(), 0);
  await page.waitForSelector('[data-kpi="students"][data-state="VALUE"]');
  readinessDenied = false; await ctx.close();
});
await check('operations report keeps the previous dashboard on its own route', async () => {
  theme = 'modern'; multi = false; const { ctx, page } = await open(viewports.desktop, `/staff/operations?organizationId=${schoolA.organizationId}&schoolId=${schoolA.schoolId}`);
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  assert.equal(await page.locator('nav[aria-label="Pages in this section"] a[aria-current="page"]').textContent(), 'Operations report');
  await page.waitForTimeout(800); await shot(page, 'u2-operations-report-desktop'); await ctx.close();
});
for (const path of ['/staff/crm/lead-memberships', '/staff/account-status', '/staff/work', '/staff/crm/follow-ups']) {
  await check(`axe on ${path} inside the shell`, async () => {
    theme = 'modern'; multi = false; const { ctx, page } = await open(viewports.desktop, path);
    await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
    await page.waitForTimeout(600); await axeScan(page, path); await ctx.close();
  });
}
await check('school entry renders without the shell', async () => {
  const { ctx, page } = await open(viewports.desktop, '/staff/entry');
  await page.waitForTimeout(500);
  assert.equal(await page.locator('[data-hon-ui="school"]').count(), 0); await ctx.close();
});
await check('section tabs on follow-ups (desktop)', async () => {
  theme = 'modern'; const { ctx, page } = await open(viewports.desktop, '/staff/crm/follow-ups');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  assert.equal(await page.locator('nav[aria-label="Pages in this section"] a[aria-current="page"]').textContent(), 'Follow-ups');
  assert.equal(await page.locator('a[data-nav="crm"]').getAttribute('aria-current'), 'page');
  await shot(page, 'u1-follow-ups-tabs-desktop'); await ctx.close();
});
for (const mode of ['modern', 'classic', 'big-button']) for (const size of ['desktop', 'phone']) await check(`Tests shows six numbered steps, not tabs (${mode} ${size})`, async () => {
  theme = mode; const { ctx, page } = await open(viewports[size], '/staff/testing/candidates/grade');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  assert.deepEqual(await page.locator('nav[data-shell-steps] a').evaluateAll(links => links.map(a => a.textContent)),
    ['1Who is ready', '2Sign-ups', '3Register', '4Grade', '5Scorecards', '6Certificates']);
  assert.equal(await page.locator('nav[data-shell-steps] a[aria-current="step"]').textContent(), '4Grade');
  assert.equal(await page.locator('[data-shell-tabs]').count(), 0);
  await noOverflow(page); await shot(page, `l3-test-steps-${mode}-${size}`); await ctx.close();
});
await check('Mass rank promotion opens on the graded students with one decision for a picked group', async () => {
  theme = 'modern'; const { ctx, page } = await open(viewports.desktop, '/staff/testing/promotion-decisions');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.getByText('Rowan Example', { exact: false }).first().waitFor();
  await page.getByRole('button', { name: 'Pick everyone who passed' }).click();
  assert.equal(await page.locator('[data-mass-promotion] input[type="checkbox"][name^="pick-"]:checked').count(), 2);
  await page.locator('textarea[name="massRationale"]').fill('Synthetic reason');
  assert.equal(await page.getByRole('button', { name: 'Record decision for 2 students' }).isDisabled(), true, 'needs the confirm first');
  assert.equal(report.apiRequests.some(r => r.startsWith('POST') && r.includes('promotion-decision')), false);
  await shot(page, 'l3-mass-promotion-desktop'); await ctx.close();
});
await check('Classic drawer opens and closes with Escape (phone)', async () => {
  theme = 'classic'; const { ctx, page } = await open(viewports.phone, '/staff/crm/leads');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.waitForSelector('[data-drawer="open"]'); await page.waitForTimeout(250);
  await shot(page, 'u1-drawer-open-phone');
  await page.keyboard.press('Escape'); await page.waitForSelector('[data-drawer="closed"]', { state: 'attached' });
  await ctx.close();
});
await check('multi-school staff choose a named school; the dashboard reloads for that school', async () => {
  theme = 'modern'; multi = true; const { ctx, page } = await open(viewports.desktop, '/staff/work');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'CHOICE');
  await shot(page, 'u1-school-choice-desktop');
  await Promise.all([page.waitForURL(/\/staff\/dashboard\?organizationId=/), page.getByRole('button', { name: /Synthetic South Academy/ }).click()]);
  assert.ok(page.url().endsWith(`organizationId=${schoolB.organizationId}&schoolId=${schoolB.schoolId}`));
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.waitForFunction(() => document.querySelector('[data-phase] strong')?.textContent === 'Synthetic South Academy');
  await shot(page, 'u1-school-chosen-desktop'); await ctx.close();
});
await check('view switch saves the personal preference', async () => {
  theme = 'modern'; multi = false; const { ctx, page } = await open(viewports.desktop, '/staff/work');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.getByRole('button', { name: 'Platform view: Classic', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-hon-ui="school"]')?.getAttribute('data-hon-mode') === 'classic');
  await page.getByText('Saved for you at this school').waitFor();
  assert.equal(theme, 'classic'); await ctx.close();
});
await check('session invalidation conceals the school and removes prefill', async () => {
  theme = 'modern'; multi = false; const { ctx, page } = await open(viewports.desktop, '/staff/work');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.evaluate(() => window.dispatchEvent(new Event('hon:session-invalidated')));
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'SESSION');
  assert.equal(await page.locator('[data-hon-ui] a[href*="organizationId="]').count(), 0);
  await shot(page, 'u1-session-ended-desktop'); await ctx.close();
});

await browser.close(); server.kill('SIGTERM');
report.pageErrors = [...new Set(report.pageErrors)];
await writeFile(join(results, 'school-shell-browser-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ checks: report.checks.length, failures: report.failures, pageErrors: report.pageErrors.slice(0, 5) }, null, 2));
if (report.failures.length) { console.error(serverLog.slice(-3000)); process.exitCode = 1; }
