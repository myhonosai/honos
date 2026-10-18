/** Temporary owner-authorized browser proof. No production backend or provider is used. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { issueSession, verifySession, cookieValue, HON_SESSION_COOKIE } from '@hon/auth';
import { HQ_OVERVIEW_UNAVAILABLE_REASONS, validateChampionsLeaderboardQuery, validateChampionsHqLeaderboard, validateChampionsOverview, validateChampionsProgram } from '@hon/contracts';
import { leaderboardFixture } from './fixtures/hq-champions-leaderboard.mjs';
import { championsManagementFixture } from './fixtures/hq-champions-management.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' && process.env.HON_HQ_BROWSER_LOCAL !== '1') throw new Error('Use the temporary CI workflow or explicitly opt into disposable local browser verification.');
for (const key of ['DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY']) {
  if (process.env[key]) throw new Error('Browser verification refuses inherited database/provider credentials.');
}
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toolsRoot = process.env.HON_HQ_BROWSER_TOOLS;
const resultsRoot = process.env.HON_HQ_BROWSER_RESULTS;
const chromeBin = process.env.HON_HQ_CHROME_BIN;
assert(toolsRoot && resultsRoot && chromeBin, 'Pinned browser tools, result folder and hosted Chrome must be configured.');
const toolsRequire = createRequire(join(toolsRoot, 'runner.cjs'));
const webRequire = createRequire(join(webRoot, 'package.json'));
const { chromium } = toolsRequire('playwright-core');
const axeSource = await readFile(toolsRequire.resolve('axe-core/axe.min.js'), 'utf8');
await mkdir(resultsRoot, { recursive: true });

const report = {
  sourceSha: process.env.HON_HQ_SOURCE_SHA ?? 'local',
  fixtureOnly: true,
  productionDataUsed: false,
  checks: [],
  failures: [],
  screenshots: [],
  accessibility: [],
  blockedExternalHosts: [],
  pageErrors: [],
  apiRequests: [],
};
let apiMode = 'ready';
let leaderboardMode = 'ready';
let leaderboardUpdated = false;
let leaderboardDelay = 0;
let managementMode = 'ready';
let managementUpdated = false;
let managementDelay = 0;
const overview = {
  asOf: '2026-10-17T12:00:00.000Z', callerHqRole: 'OWNER', organizationCount: 2, schoolCount: 3,
  onboarding: { availability: 'AVAILABLE', requestCount: 4, inProgressRequestCount: 1, completedRequestCount: 3 },
  configuredProviderStates: { disabled: 1, configured: 2, healthy: 0, degraded: 0, unavailable: 1 }, taskProfileCount: 5,
  financialMetrics: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.financialMetrics },
  aiUsage: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.aiUsage },
  durableHqWork: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.durableHqWork },
};
const api = createServer((request, response) => {
  const path = request.url;
  report.apiRequests.push({ method: request.method, path });
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  let identity;
  try { identity = verifySession(cookieValue(request.headers.cookie, HON_SESSION_COOKIE) ?? '', session); }
  catch { response.writeHead(401); response.end('{}'); return; }
  // This local double models the API's independent authority check, never a production bypass.
  if (!['hon-hq-browser-fixture', 'hon-hq-operator-fixture'].includes(identity.externalSubject)) {
    response.writeHead(403); response.end('{}'); return;
  }
  const url = new URL(path, 'http://127.0.0.1');
  if (request.method !== 'GET' || !['/v1/hq/overview', '/v1/hq/schools', '/v1/hq/champions/leaderboard', '/v1/hq/champions/overview', '/v1/hq/champions/program'].includes(url.pathname)) {
    response.writeHead(405); response.end('{}'); return;
  }
  if (['/v1/hq/champions/overview', '/v1/hq/champions/program'].includes(url.pathname)) {
    if (url.search || request.headers['content-length'] && request.headers['content-length'] !== '0') { response.writeHead(400); response.end('{}'); return; }
    const isProgram = url.pathname.endsWith('/program');
    if (['401', '403', '503'].includes(managementMode) || managementMode === 'program-denied' && isProgram) {
      response.writeHead(managementMode === 'program-denied' ? 403 : Number(managementMode)); response.end('{"private":"private-overview-note"}'); return;
    }
    const fixture = championsManagementFixture({ empty: managementMode === 'empty', updated: managementUpdated });
    const data = isProgram ? validateChampionsProgram(fixture.program) : validateChampionsOverview(fixture.overview);
    const body = managementMode === 'invalid-json' ? 'unreadable'
      : JSON.stringify({ data: managementMode === 'malformed' ? { ...data, privateSchool: 'private-overview-note' }
        : managementMode === 'mismatch' && isProgram ? { ...data, published: { ...data.published, policyVersion: 2 } } : data });
    const finish = () => { if (!response.destroyed) response.end(body); };
    if (managementDelay) setTimeout(finish, managementDelay); else finish();
    return;
  }
  if (url.pathname === '/v1/hq/champions/leaderboard') {
    if (['401', '403', '503'].includes(leaderboardMode)) { response.writeHead(Number(leaderboardMode)); response.end('{}'); return; }
    let selection;
    try {
      if (new Set(url.searchParams.keys()).size !== [...url.searchParams.keys()].length) throw Error();
      selection = validateChampionsLeaderboardQuery(Object.fromEntries(url.searchParams));
      if (selection.month !== null && (selection.month < '2026-01' || selection.month > new Date().toISOString().slice(0, 7))) throw Error();
    } catch { response.writeHead(400); response.end('{}'); return; }
    const data = validateChampionsHqLeaderboard(leaderboardFixture({ ...selection, updated: leaderboardUpdated, empty: leaderboardMode === 'empty' }));
    const body = leaderboardMode === 'invalid-json' ? 'unreadable'
      : JSON.stringify({ data: leaderboardMode === 'malformed' ? { ...data, ownerEmail: 'private@example.test' }
        : leaderboardMode === 'mismatch' ? leaderboardFixture({ period: 'MONTH', month: '2026-01' }) : data });
    const finish = () => { if (!response.destroyed) response.end(body); };
    if (leaderboardDelay) setTimeout(finish, leaderboardDelay); else finish();
    return;
  }
  if (path === '/v1/hq/overview' && ['401', '403', '503'].includes(apiMode)) {
    response.writeHead(Number(apiMode)); response.end('{}'); return;
  }
  const body = path === '/v1/hq/schools'
    ? { data: { directory: { schools: [] } } }
    : { data: { overview: apiMode === 'malformed' ? { ...overview, mrr: 999 } : overview } };
  response.end(JSON.stringify(body));
});
// Next freezes rewrites at build time; use the workflow's explicit localhost destination.
const apiPort = 3001;
await new Promise((done, reject) => { api.once('error', reject); api.listen(apiPort, '127.0.0.1', done); });
const portProbe = createServer();
await new Promise((done) => portProbe.listen(0, '127.0.0.1', done));
const webPort = portProbe.address().port;
await new Promise((done) => portProbe.close(done));
const origin = `http://127.0.0.1:${webPort}`;
const session = { mode: 'OIDC', audience: 'hon-hq-browser-local', secret: randomBytes(32).toString('hex') };
const cookie = issueSession({ externalSubject: 'hon-hq-browser-fixture' }, session);
// Whitelisted environment: no inherited cloud, database, provider or application credentials.
const childEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'production',
  NEXT_TELEMETRY_DISABLED: '1', HON_AUTH_MODE: session.mode,
  HON_SESSION_AUDIENCE: session.audience, HON_SESSION_JWT_SECRET: session.secret,
  HON_API_BASE_URL: `http://127.0.0.1:${apiPort}`,
};
const app = spawn(process.execPath, [webRequire.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(webPort)], { cwd: webRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
// Consume output without uploading application logs or ephemeral session material.
app.stdout.on('data', () => {}); app.stderr.on('data', () => {});
let browser;
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
async function check(name, operation) {
  try { await operation(); report.checks.push(name); console.log(`PASS ${name}`); }
  catch (error) { report.failures.push({ name, message: String(error.message).slice(0, 1600) }); console.log(`FAIL ${name}: ${String(error.message).slice(0, 1600)}`); }
}
async function screenshot(page, name, fullPage = true) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const sources = new Set();
    for (const element of document.querySelectorAll('[role="img"], [data-hq-background]')) {
      for (const match of getComputedStyle(element).backgroundImage.matchAll(/url\(["']?([^"')]+)["']?\)/g)) sources.add(match[1]);
    }
    await Promise.all([...sources].map(async (source) => {
      const image = new Image(); image.src = source; await image.decode();
    }));
    // Captures start at the top after interactions, keeping fixed navigation/fixture labels in place.
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    await new Promise((done) => requestAnimationFrame(done));
  });
  await page.waitForFunction(() => scrollX === 0 && scrollY === 0);
  await page.screenshot({ path: join(resultsRoot, `${name}.png`), fullPage, animations: 'disabled' });
  report.screenshots.push(`${name}.png`);
  // Private CI log previews let connected read-only review tools inspect synthetic screenshots
  // when the terminal cannot download File Service artifacts. No credentials or live data.
  if (['desktop-champions-overview', 'mobile-champions-overview', 'mobile-champions-viewport', 'desktop-dashboard-full', 'mobile-dashboard-full', 'mobile-dashboard-viewport', 'desktop-leaderboard-all-time', 'desktop-leaderboard-monthly', 'mobile-leaderboard-all-time', 'mobile-leaderboard-monthly', 'mobile-leaderboard-viewport'].includes(name)) {
    const preview = await page.screenshot({ type: 'jpeg', quality: 72, fullPage, animations: 'disabled' });
    await writeFile(join(resultsRoot, `${name}.jpg`), preview);
    const encoded = preview.toString('base64');
    const total = Math.ceil(encoded.length / 8000);
    for (let index = 0; index < total; index++) console.log(`HQ_REVIEW_IMAGE ${name} ${index + 1}/${total} ${encoded.slice(index * 8000, (index + 1) * 8000)}`);
  }
}
async function noOverflow(page, label) {
  const metrics = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert(metrics.document <= metrics.viewport + 1 && metrics.body <= metrics.viewport + 1, `${label}: ${JSON.stringify(metrics)}`);
  const workspaces = await page.getByRole('link', { name: /^View .* workspace$/ }).evaluateAll((nodes) => nodes.map((node) => ({ label: node.getAttribute('aria-label'), width: node.clientWidth, content: node.scrollWidth })));
  assert(workspaces.every((node) => node.content <= node.width + 1), `${label}: executive controls must fit their cards: ${JSON.stringify(workspaces)}`);
}
async function accessibility(page, label) {
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
  report.accessibility.push({ label, violations: result.violations, incompleteCount: result.incomplete.length });
  assert.equal(result.violations.length, 0, `${label}: ${result.violations.map((item) => item.id).join(', ')}`);
}
async function contextFor(viewport, authenticated = true, reducedMotion = 'reduce', subject = 'hon-hq-browser-fixture') {
  const context = await browser.newContext({ viewport, reducedMotion, serviceWorkers: 'block' });
  await context.grantPermissions([], { origin });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    report.blockedExternalHosts.push(url.hostname); return route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*', (socket) => socket.close());
  if (authenticated) await context.addCookies([{ name: HON_SESSION_COOKIE, value: subject === 'hon-hq-browser-fixture' ? cookie : issueSession({ externalSubject: subject }, session), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await context.addInitScript(() => {
    addEventListener('DOMContentLoaded', () => {
      const badge = document.createElement('div'); badge.textContent = 'LOCAL TEST FIXTURE · NO LIVE DATA';
      badge.setAttribute('data-browser-fixture', 'true');
      badge.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:1000;text-align:center;background:#10273c;color:#bcefff;font:9px/18px system-ui;pointer-events:none';
      document.body.append(badge);
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(20000);
  page.on('pageerror', (error) => report.pageErrors.push(String(error.message).slice(0, 1000)));
  return { context, page };
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (app.exitCode !== null) throw new Error('Production web server exited before readiness.');
    try { await fetch(`${origin}/hq`, { redirect: 'manual' }); ready = true; break; } catch {}
    await delay(500);
  }
  assert(ready, 'Local production server did not become ready within 30 seconds.');
  browser = await chromium.launch({ executablePath: chromeBin, headless: true, args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'] });

  for (const [label, width, height] of [['desktop', 1440, 1000], ['tablet', 834, 1112], ['mobile', 390, 844], ['mobile-narrow', 320, 800]]) {
    const { context, page } = await contextFor({ width, height });
    await check(`${label}: dashboard, responsive layout and screenshots`, async () => {
      await page.goto(`${origin}/hq`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Your executive team', exact: true }).waitFor({ timeout: 20000 });
      await screenshot(page, `${label}-dashboard-full`);
      assert.equal(await page.getByRole('link', { name: /^View .* workspace$/ }).count(), 6);
      if (width > 1250) {
        const dock = await page.locator('[data-hq-conversation-dock]').evaluate((node) => {
          const panel = node.getBoundingClientRect();
          const orb = node.previousElementSibling.getBoundingClientRect();
          return { overlaps: panel.top < orb.bottom && panel.bottom > orb.top, centered: Math.abs((panel.left + panel.right) / 2 - (orb.left + orb.right) / 2) < 2 };
        });
        assert(dock.overlaps && dock.centered, 'HON speaking dock must overlap the front of the orb and remain centered');
      }
      await noOverflow(page, label);
      await screenshot(page, `${label}-dashboard-viewport`, false);
    });
    await check(`${label}: appearance choices preserve the six HQ identities`, async () => {
      const motion = page.getByRole('button', { name: 'Ambient motion', exact: true });
      assert(await motion.isDisabled(), 'Reduced-motion preference must prevent ambient animation');
      assert.equal(await motion.getAttribute('aria-pressed'), 'false');
      assert.equal(await page.locator('[data-motion]').getAttribute('data-motion'), 'off');
      const views = page.getByRole('group', { name: 'Platform view' });
      const boundaries = await page.locator('[aria-label="HQ appearance"] [role="group"]').evaluateAll((nodes) => nodes.map((node) => {
        const box = node.getBoundingClientRect(), style = getComputedStyle(node);
        return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, border: parseFloat(style.borderTopWidth), radius: parseFloat(style.borderTopLeftRadius) };
      }));
      assert.equal(boundaries.length, 2);
      assert(boundaries.every((box) => box.border >= 1 && box.radius >= 8), 'Each appearance group needs its own visible rounded boundary');
      assert(boundaries[0].right <= boundaries[1].x || boundaries[0].bottom <= boundaries[1].y, 'View and AI Style groups must not overlap');
      for (const [name, key] of [['Big Button', 'big-button'], ['Classic', 'classic'], ['Modern', 'modern']]) {
        await views.getByRole('button', { name, exact: true }).click();
        assert.equal(await views.getByRole('button', { name, exact: true }).getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('[data-view]').getAttribute('data-view'), key);
        await noOverflow(page, `${label} ${name}`);
      }
      const art = page.getByRole('group', { name: 'AI portrait style' });
      await art.getByRole('button', { name: 'Chibi', exact: true }).click();
      assert.equal(await page.getByRole('img', { name: /chibi portrait$/ }).count(), 6);
      if (label === 'desktop') await screenshot(page, 'desktop-chibi');
      await art.getByRole('button', { name: 'Anime', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Anime portraits are awaiting approved artwork' }).waitFor();
      assert.equal(await page.getByRole('img', { name: /Anime artwork pending$/ }).count(), 6);
      await art.getByRole('button', { name: 'Realistic', exact: true }).click();
    });
    await check(`${label}: dashboard accessibility`, () => accessibility(page, `${label}-dashboard`));
    await check(`${label}: assistant expand, draft continuity, disabled services and keyboard restore`, async () => {
      const dashboardDraft = page.getByRole('textbox', { name: 'Unsent message draft for HON' });
      await dashboardDraft.fill('Local verification draft — not sent');
      const expand = page.getByRole('button', { name: 'Expand HON conversation', exact: true });
      await expand.click();
      const assistant = page.getByRole(width <= 800 ? 'dialog' : 'complementary', { name: 'HON assistant', exact: true });
      await assistant.waitFor();
      assert.equal(await assistant.getByRole('textbox').inputValue(), 'Local verification draft — not sent');
      assert(await assistant.getByRole('button', { name: /^Send unavailable/ }).isDisabled());
      assert(await assistant.getByRole('button', { name: 'Talk to HON', exact: true }).isDisabled());
      await noOverflow(page, `${label} assistant`);
      await screenshot(page, `${label}-assistant-expanded`, false);
      await check(`${label}: expanded assistant accessibility`, () => accessibility(page, `${label}-assistant`));
      if (width <= 800) {
        const minimize = assistant.getByRole('button', { name: 'Minimize HON assistant' });
        await minimize.focus(); await page.keyboard.press('Shift+Tab');
        assert(await assistant.evaluate((node) => node.contains(document.activeElement)), 'Focus escaped mobile assistant');
      }
      await page.keyboard.press('Escape');
      await assistant.waitFor({ state: 'detached' });
      assert.equal(await dashboardDraft.inputValue(), 'Local verification draft — not sent');
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Expand HON conversation');
      assert(await expand.evaluate((node) => document.activeElement === node), 'Focus did not return to opener');
      await dashboardDraft.fill('');
    });
    await check(`${label}: executive workspace, unavailable tabs and persistent subpage assistant`, async () => {
      // Fresh page makes this proof independent of a prior interaction assertion failure.
      await page.goto(`${origin}/hq`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Your executive team', exact: true }).waitFor();
      await page.locator('a[href="/hq/executives/chase"]').first().click();
      await page.waitForURL('**/hq/executives/chase');
      await page.getByRole('heading', { name: 'Chase', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Performance', exact: true }).click();
      await page.getByRole('heading', { name: 'Performance unavailable', exact: true }).waitFor();
      await page.getByRole('button', { name: width <= 600 ? 'Expand HON assistant' : 'Ask HON anywhere', exact: true }).click();
      const assistant = page.getByRole(width <= 800 ? 'dialog' : 'complementary', { name: 'HON assistant', exact: true });
      await assistant.getByText('Current page: Chase workspace', { exact: true }).waitFor();
      assert.equal(await assistant.getByRole('textbox').inputValue(), '');
      if (label === 'desktop' || label === 'mobile') await screenshot(page, `${label}-workspace-assistant`, false);
      await assistant.getByRole('button', { name: 'Minimize HON assistant' }).click();
      await noOverflow(page, `${label} workspace`);
    });
    await check(`${label}: navigation, menu focus and non-executing contest lifecycle`, async () => {
      await page.goto(`${origin}/hq/executives/chase`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Chase', exact: true }).waitFor();
      if (width < 1100) {
        const menu = page.getByRole('button', { name: 'Open HQ navigation', exact: true });
        await menu.click();
        const drawer = page.getByRole('dialog', { name: 'HQ navigation menu', exact: true });
        await drawer.waitFor();
        for (const name of ['Champions Club', 'Referral Leaderboard', 'Referral Contests', 'Reward Management', 'Founder Campaigns']) assert(await drawer.getByRole('link', { name, exact: true }).isVisible());
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Open HQ navigation');
        assert(await menu.evaluate((node) => document.activeElement === node), 'Menu did not restore opener focus');
        await menu.click();
        await drawer.getByRole('link', { name: 'Referral Contests', exact: true }).click();
      } else await page.getByRole('navigation', { name: 'HQ navigation', exact: true }).getByRole('link', { name: 'Referral Contests', exact: true }).click();
      await page.waitForURL('**/hq/growth/contests');
      await page.getByRole('group', { name: 'Contest lifecycle preview' }).getByRole('button', { name: 'Launch', exact: true }).click();
      await page.getByRole('heading', { name: 'Launch — planned', exact: true }).waitFor();
      assert(await page.getByRole('button', { name: 'Launch competition — unavailable', exact: true }).isDisabled());
      await noOverflow(page, `${label} growth`);
      if (label === 'desktop' || label === 'mobile') await screenshot(page, `${label}-growth-contests`);
    });
    await check(`${label}: official leaderboard periods, confidential reviews and responsive bounds`, async () => {
      leaderboardMode = 'ready'; leaderboardUpdated = false;
      await page.goto(`${origin}/hq/growth/leaderboard`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'All-time standings', exact: true }).waitFor();
      const rows = page.locator('tbody tr');
      assert.equal(await rows.count(), 3);
      assert((await rows.nth(0).innerText()).includes('Zeta School'));
      assert((await rows.nth(1).innerText()).includes('Alpha School'));
      assert.equal(await rows.nth(0).locator('th').textContent(), 'Rank 1');
      assert.equal(await rows.nth(1).locator('th').textContent(), 'Rank 1');
      const heldSchool = page.getByText('Hold Review School · fixture', { exact: true });
      assert(!(await heldSchool.isVisible()), 'Confidential review must be collapsed initially');
      await page.getByText('Confidential HQ reviews', { exact: true }).click();
      await heldSchool.waitFor();
      assert.equal(await page.locator('tbody').getByText('Hold Review School · fixture').count(), 0);
      await page.getByText('Confidential HQ reviews', { exact: true }).click();
      if (width <= 600) {
        assert(!(await page.getByRole('button', { name: 'Ask HON anywhere', exact: true }).isVisible()), 'A second mobile launcher must not cover filters');
        assert(await page.getByRole('button', { name: 'Expand HON assistant', exact: true }).isVisible());
      }
      await noOverflow(page, `${label} leaderboard`);
      await screenshot(page, `${label}-leaderboard-all-time`);
      if (label === 'mobile') await screenshot(page, 'mobile-leaderboard-viewport', false);
      await accessibility(page, `${label}-leaderboard`);
      const filters = page.getByRole('group', { name: 'Ranking period' });
      await filters.getByRole('button', { name: 'Monthly', exact: true }).click();
      const month = new Date().toISOString().slice(0, 7);
      await page.getByRole('heading', { name: `Monthly standings · ${month}`, exact: true }).waitFor();
      assert.equal(await rows.count(), 2);
      assert((await rows.nth(0).innerText()).includes('Cedar School'));
      await page.getByRole('combobox', { name: 'UTC ranking month' }).selectOption('2026-01');
      await page.getByRole('heading', { name: 'Monthly standings · 2026-01', exact: true }).waitFor();
      if (label === 'desktop' || label === 'mobile') await screenshot(page, `${label}-leaderboard-monthly`);
      for (const name of ['Big Button', 'Classic', 'Modern']) {
        await page.getByRole('group', { name: 'Platform view' }).getByRole('button', { name, exact: true }).click();
        await noOverflow(page, `${label} leaderboard ${name}`);
      }
      await filters.getByRole('button', { name: 'All time', exact: true }).click();
      await page.getByRole('heading', { name: 'All-time standings', exact: true }).waitFor();
    });
    await check(`${label}: Champions overview aggregates, configuration, liabilities, views and assistant`, async () => {
      managementMode = 'ready'; managementUpdated = false;
      await page.goto(`${origin}/hq/growth?schoolId=untrusted&role=OWNER`, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-champions-total]').waitFor();
      assert.equal(await page.locator('[data-champions-total]').textContent(), '22');
      await page.getByRole('heading', { name: 'Program configuration', exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Outstanding reward liabilities', exact: true }).waitFor();
      await page.getByText('USD 2,000.00', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: /issue|approve|pay|publish|reconcile/i }).count(), 0);
      assert(!(await page.getByText('Active leaderboard holds', { exact: true }).isVisible()));
      const review = page.getByText('Confidential HQ review and contest liabilities', { exact: true });
      await review.focus(); await page.keyboard.press('Enter');
      await page.getByText('Active leaderboard holds', { exact: true }).waitFor();
      await page.getByText('USD 250.00', { exact: true }).waitFor();
      await page.keyboard.press('Enter');
      for (const name of ['Big Button', 'Classic', 'Modern']) {
        await page.getByRole('group', { name: 'Platform view' }).getByRole('button', { name, exact: true }).click();
        await noOverflow(page, `${label} Champions ${name}`);
      }
      await screenshot(page, `${label}-champions-overview`);
      if (label === 'mobile') await screenshot(page, 'mobile-champions-viewport', false);
      await accessibility(page, `${label}-champions-overview`);
      await page.getByRole('button', { name: width <= 600 ? 'Expand HON assistant' : 'Ask HON anywhere', exact: true }).click();
      const assistant = page.getByRole(width <= 800 ? 'dialog' : 'complementary', { name: 'HON assistant', exact: true });
      await assistant.getByText('Current page: Growth & Referrals', { exact: true }).waitFor();
      assert(await assistant.getByRole('button', { name: /^Send unavailable/ }).isDisabled());
      await noOverflow(page, `${label} Champions assistant`);
      await page.keyboard.press('Escape');
      await assistant.waitFor({ state: 'detached' });
    });
    await context.close();
  }

  const management = await contextFor({ width: 390, height: 844 });
  try {
    const page = management.page;
    const open = async () => {
      await page.goto(`${origin}/hq/growth/champions-club`, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-champions-total]').waitFor();
    };
    await check('Champions refresh clears old facts, retrieves updated aggregates and restores keyboard control', async () => {
      managementMode = 'ready'; managementUpdated = false; await open();
      managementDelay = 500; managementUpdated = true;
      const refresh = page.getByRole('button', { name: 'Refresh Champions Club', exact: true });
      await refresh.focus(); await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: 'Loading authorized Champions Club…', exact: true }).waitFor();
      assert.equal(await page.locator('[data-champions-total]').count(), 0);
      assert.equal(await page.getByText('USD 2,000.00', { exact: true }).count(), 0);
      await page.waitForFunction(() => document.querySelector('[data-champions-total]')?.textContent === '23');
      assert(await refresh.isEnabled()); managementDelay = 0;
    });
    await check('Champions empty, unpublished, denied and malformed responses never retain old referral or liability facts', async () => {
      for (const [mode, heading] of [['empty', 'No referrals recorded'], ['401', 'Sign in to view Champions Club'], ['403', 'Champions Club access denied'], ['program-denied', 'Champions Club access denied'], ['503', 'Champions Club overview unavailable'], ['malformed', 'Champions Club overview could not be verified'], ['invalid-json', 'Champions Club overview could not be verified'], ['mismatch', 'Champions Club overview could not be verified']]) {
        managementMode = 'ready'; await open(); managementMode = mode;
        await page.getByRole('button', { name: 'Refresh Champions Club', exact: true }).click();
        await page.getByRole('heading', { name: heading, exact: true }).waitFor();
        if (mode !== 'empty') assert.equal(await page.locator('[data-champions-total]').count(), 0);
        else { assert.equal(await page.locator('[data-champions-total]').textContent(), '0'); await page.getByText('No published qualification policy was returned.', { exact: false }).waitFor(); }
        assert.equal(await page.getByText('USD 2,000.00', { exact: true }).count(), 0);
        assert.equal(await page.getByText('private-overview-note', { exact: false }).count(), 0);
        await noOverflow(page, `Champions ${mode}`);
        if (['empty', 'program-denied', '503'].includes(mode)) await screenshot(page, `mobile-champions-${mode}`);
      }
    });
    await check('Champions obsolete delayed refresh cannot restore facts after overview navigation', async () => {
      managementMode = 'ready'; managementUpdated = false; await open();
      managementDelay = 600;
      const start = report.apiRequests.length;
      await page.getByRole('button', { name: 'Refresh Champions Club', exact: true }).click();
      await page.getByRole('heading', { name: 'Loading authorized Champions Club…', exact: true }).waitFor();
      for (let attempt = 0; attempt < 30 && report.apiRequests.slice(start).filter((r) => ['/v1/hq/champions/overview', '/v1/hq/champions/program'].includes(r.path)).length < 2; attempt++) await delay(20);
      assert.equal(report.apiRequests.slice(start).filter((r) => ['/v1/hq/champions/overview', '/v1/hq/champions/program'].includes(r.path)).length, 2);
      managementDelay = 0; managementUpdated = true;
      await page.getByRole('navigation', { name: 'Growth modules', exact: true }).getByRole('link', { name: 'Growth overview', exact: true }).click();
      await page.waitForURL('**/hq/growth');
      await page.waitForFunction(() => document.querySelector('[data-champions-total]')?.textContent === '23');
      await delay(700);
      assert.equal(await page.locator('[data-champions-total]').textContent(), '23');
    });
    await check('Champions overview and program independently deny non-HQ identities and reject selectors', async () => {
      managementMode = 'ready';
      for (const subject of ['hon-school-fixture', 'hon-family-fixture', 'hon-hq-support-fixture', null]) {
        const denied = await contextFor({ width: 390, height: 844 }, subject !== null, 'reduce', subject ?? '');
        try {
          for (const resource of ['overview', 'program']) {
            const response = await denied.context.request.get(`${origin}/api/v1/hq/champions/${resource}`);
            assert.equal(response.status(), subject === null ? 401 : 403);
            assert.equal(await response.text(), '{}');
          }
          await denied.page.goto(`${origin}/hq/growth`, { waitUntil: 'domcontentloaded' });
          if (subject === null) assert.equal(new URL(denied.page.url()).pathname, '/auth/login');
          else await denied.page.getByRole('heading', { name: 'This account has no current HQ authority.', exact: true }).waitFor();
          assert.equal(await denied.page.locator('[data-champions-total]').count(), 0);
        } finally { await denied.context.close(); }
      }
      const operator = await contextFor({ width: 390, height: 844 }, true, 'reduce', 'hon-hq-operator-fixture');
      try {
        await operator.page.goto(`${origin}/hq/growth/champions-club`, { waitUntil: 'domcontentloaded' });
        await operator.page.locator('[data-champions-total]').waitFor();
        for (const resource of ['overview', 'program']) assert.equal((await operator.context.request.get(`${origin}/api/v1/hq/champions/${resource}?schoolId=untrusted`)).status(), 400);
      } finally { await operator.context.close(); }
    });
  } finally { managementMode = 'ready'; managementDelay = 0; managementUpdated = false; await management.context.close(); }

  const integration = await contextFor({ width: 1440, height: 1000 });
  try {
    const page = integration.page;
    const open = async () => {
      await page.goto(`${origin}/hq/growth/leaderboard?schoolId=untrusted&role=OWNER`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'All-time standings', exact: true }).waitFor();
    };
    await check('Leaderboard refresh clears facts, shows loading and retrieves changed official data', async () => {
      leaderboardMode = 'ready'; leaderboardUpdated = false; await open();
      leaderboardDelay = 400; leaderboardUpdated = true;
      await page.getByText('Confidential HQ reviews', { exact: true }).click();
      await page.getByRole('button', { name: 'Refresh standings', exact: true }).click();
      await page.getByRole('heading', { name: 'Loading authorized standings…', exact: true }).waitFor();
      assert.equal(await page.getByText('Hold Review School · fixture', { exact: true }).count(), 0);
      await page.getByRole('heading', { name: 'All-time standings', exact: true }).waitFor();
      assert((await page.locator('tbody tr').nth(0).innerText()).includes('9'));
      assert.equal(await page.locator('tbody tr').nth(1).locator('th').textContent(), 'Rank 2');
      leaderboardDelay = 0;
    });
    await check('Leaderboard discards an obsolete delayed response after a filter change', async () => {
      leaderboardDelay = 600;
      const startRequests = report.apiRequests.length;
      await page.getByRole('button', { name: 'Refresh standings', exact: true }).click();
      await page.getByRole('heading', { name: 'Loading authorized standings…', exact: true }).waitFor();
      for (let attempt = 0; attempt < 30 && !report.apiRequests.slice(startRequests).some((item) => item.path === '/v1/hq/champions/leaderboard?period=ALL_TIME'); attempt++) await delay(20);
      assert(report.apiRequests.slice(startRequests).some((item) => item.path === '/v1/hq/champions/leaderboard?period=ALL_TIME'), 'Delayed request did not reach the fixture');
      leaderboardDelay = 0;
      await page.getByRole('group', { name: 'Ranking period' }).getByRole('button', { name: 'Monthly', exact: true }).click();
      const title = `Monthly standings · ${new Date().toISOString().slice(0, 7)}`;
      await page.getByRole('heading', { name: title, exact: true }).waitFor();
      await delay(700);
      assert.equal(await page.locator('tbody tr').count(), 2);
      assert.equal(await page.getByRole('heading', { name: 'All-time standings', exact: true }).count(), 0);
    });
    await check('Leaderboard empty, denied, unavailable and invalid responses reveal no stale rankings or holds', async () => {
      for (const [mode, heading] of [['empty', 'All-time standings'], ['401', 'Sign in to view referral standings'], ['403', 'Champions Club access denied'], ['503', 'Referral standings unavailable'], ['malformed', 'Referral standings could not be verified'], ['invalid-json', 'Referral standings could not be verified'], ['mismatch', 'Referral standings could not be verified']]) {
        leaderboardMode = 'ready'; await open();
        await page.getByText('Confidential HQ reviews', { exact: true }).click();
        await page.getByText('Hold Review School · fixture', { exact: true }).waitFor();
        leaderboardMode = mode;
        await page.getByRole('button', { name: 'Refresh standings', exact: true }).click();
        await page.getByRole('heading', { name: heading, exact: true }).waitFor();
        assert.equal(await page.locator('tbody tr').count(), 0);
        assert.equal(await page.getByText('Hold Review School · fixture', { exact: true }).count(), 0);
        if (mode === 'empty') await page.getByText('No ranked schools for this period.', { exact: false }).waitFor();
      }
    });
    await check('HQ leaderboard independently denies school, family, support and unsigned identities', async () => {
      leaderboardMode = 'ready';
      for (const subject of ['hon-school-fixture', 'hon-family-fixture', 'hon-hq-support-fixture']) {
        const denied = await contextFor({ width: 390, height: 844 }, true, 'reduce', subject);
        try {
          const response = await denied.context.request.get(`${origin}/api/v1/hq/champions/leaderboard?period=ALL_TIME`);
          assert.equal(response.status(), 403); assert.equal(await response.text(), '{}');
          await denied.page.goto(`${origin}/hq/growth/leaderboard`, { waitUntil: 'domcontentloaded' });
          await denied.page.getByRole('heading', { name: 'This account has no current HQ authority.', exact: true }).waitFor();
          assert.equal(await denied.page.getByText('Hold Review School · fixture', { exact: true }).count(), 0);
        } finally { await denied.context.close(); }
      }
      const anonymous = await contextFor({ width: 390, height: 844 }, false);
      try { assert.equal((await anonymous.context.request.get(`${origin}/api/v1/hq/champions/leaderboard?period=ALL_TIME`)).status(), 401); }
      finally { await anonymous.context.close(); }
      const operator = await contextFor({ width: 390, height: 844 }, true, 'reduce', 'hon-hq-operator-fixture');
      try {
        await operator.page.goto(`${origin}/hq/growth/leaderboard`, { waitUntil: 'domcontentloaded' });
        await operator.page.getByRole('heading', { name: 'All-time standings', exact: true }).waitFor();
      } finally { await operator.context.close(); }
    });
  } finally { leaderboardMode = 'ready'; leaderboardDelay = 0; await integration.context.close(); }

  await check('HQ command backdrop and decorative motion pause, keyboard restore and preference change', async () => {
    const moving = await contextFor({ width: 1440, height: 1000 }, true, 'no-preference');
    try {
      await moving.page.goto(`${origin}/hq`, { waitUntil: 'domcontentloaded' });
      await moving.page.getByRole('heading', { name: 'Your executive team', exact: true }).waitFor();
      const motion = moving.page.getByRole('button', { name: 'Ambient motion', exact: true });
      assert(await motion.isEnabled());
      assert.equal(await motion.getAttribute('aria-pressed'), 'true');
      const background = await moving.page.locator('[data-hq-background]').evaluate((node) => getComputedStyle(node).backgroundImage);
      assert(background.includes('/hq-assets/reference-refinement/command-room.png'), 'HQ must render the owner-requested command-center backdrop');
      const orbit = moving.page.locator('[data-hq-orbits] > i').first();
      assert.notEqual(await orbit.evaluate((node) => getComputedStyle(node).animationName), 'none');
      await motion.press('Space');
      await moving.page.waitForFunction(() => document.querySelector('[data-motion]')?.getAttribute('data-motion') === 'off');
      assert.equal(await orbit.evaluate((node) => getComputedStyle(node).animationName), 'none');
      await motion.press('Enter');
      await moving.page.waitForFunction(() => document.querySelector('[data-motion]')?.getAttribute('data-motion') === 'on');
      await moving.page.emulateMedia({ reducedMotion: 'reduce' });
      await moving.page.waitForFunction(() => document.querySelector('[data-motion]')?.getAttribute('data-motion') === 'off');
      assert(await motion.isDisabled());
      assert.equal(await orbit.evaluate((node) => getComputedStyle(node).animationName), 'none');
    } finally { await moving.context.close(); }
  });

  const { context, page } = await contextFor({ width: 1440, height: 1000 });
  await check('Existing independent school directory transport', async () => {
    await page.goto(`${origin}/hq/schools`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'No schools are available in this directory.', exact: true }).waitFor();
    assert(report.apiRequests.some((request) => request.path === '/v1/hq/schools'));
  });
  for (const [mode, heading] of [['403', 'This account has no current HQ authority.'], ['401', 'Sign in to verify HQ access.'], ['503', 'The HQ overview could not be verified.'], ['malformed', 'The HQ overview could not be verified.']]) {
    await check(`Fail-closed HQ overview ${mode}`, async () => {
      apiMode = mode;
      await page.goto(`${origin}/hq`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: heading, exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: 'Your executive team', exact: true }).count(), 0);
      if (mode === '403') await screenshot(page, 'desktop-hq-access-denied');
    });
  }
  await context.close(); apiMode = 'ready';
  await check('Unsigned browser session cannot render HQ content', async () => {
    const anonymous = await contextFor({ width: 390, height: 844 }, false);
    try {
      await anonymous.page.goto(`${origin}/hq`, { waitUntil: 'domcontentloaded' });
      assert(new URL(anonymous.page.url()).pathname === '/auth/login');
      assert.equal(await anonymous.page.getByRole('heading', { name: 'Your executive team', exact: true }).count(), 0);
    } finally { await anonymous.context.close(); }
  });
  await check('No browser JavaScript errors', async () => assert.deepEqual(report.pageErrors, []));
  await check('No mutation, provider or arbitrary API request', async () => {
    assert(report.apiRequests.every((request) => {
      const url = new URL(request.path, 'http://127.0.0.1');
      return request.method === 'GET' && (['/v1/hq/overview', '/v1/hq/schools', '/v1/hq/champions/overview', '/v1/hq/champions/program'].includes(request.path)
        || (['/v1/hq/champions/overview', '/v1/hq/champions/program'].includes(url.pathname) && url.search === '?schoolId=untrusted')
        || (url.pathname === '/v1/hq/champions/leaderboard' && [...url.searchParams.keys()].every((key) => ['period', 'month'].includes(key))));
    }));
  });
} catch (error) {
  report.failures.push({ name: 'Browser harness', message: String(error.message).slice(0, 1600) });
} finally {
  await browser?.close(); app.kill('SIGTERM');
  await new Promise((done) => api.close(done));
  report.blockedExternalHosts = [...new Set(report.blockedExternalHosts)];
  await writeFile(join(resultsRoot, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`HQ_BROWSER_REPORT ${JSON.stringify(report)}`);
  const summary = `# HON HQ browser verification\n\nSource: \`${report.sourceSha}\`\n\n**Synthetic localhost fixtures only. No live data, AI, microphone or business actions.**\n\nPassed checks: ${report.checks.length}\n\nFailures: ${report.failures.length}\n\nScreenshots: ${report.screenshots.length}\n\n${report.failures.map((failure) => `- ${failure.name}: ${failure.message.replaceAll('\n', ' ').slice(0, 400)}`).join('\n')}\n\nArtifacts expire after three days. Automated accessibility checks supplement manual review; they do not establish complete WCAG conformance.\n`;
  await writeFile(join(resultsRoot, 'SUMMARY.md'), summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
}
if (report.failures.length) process.exitCode = 1;
