/** Temporary owner-authorized browser proof. No production backend or provider is used. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { issueSession, HON_SESSION_COOKIE } from '@hon/auth';
import { HQ_OVERVIEW_UNAVAILABLE_REASONS } from '@hon/contracts';

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
  if (request.method !== 'GET' || !['/v1/hq/overview', '/v1/hq/schools'].includes(path)) {
    response.writeHead(405); response.end('{}'); return;
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
  });
  await page.screenshot({ path: join(resultsRoot, `${name}.png`), fullPage, animations: 'disabled' });
  report.screenshots.push(`${name}.png`);
  // Private CI log previews let connected read-only review tools inspect synthetic screenshots
  // when the terminal cannot download File Service artifacts. No credentials or live data.
  if (name === 'desktop-dashboard-full' || name === 'mobile-dashboard-full' || name === 'mobile-dashboard-viewport') {
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
async function contextFor(viewport, authenticated = true, reducedMotion = 'reduce') {
  const context = await browser.newContext({ viewport, reducedMotion, serviceWorkers: 'block' });
  await context.grantPermissions([], { origin });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    report.blockedExternalHosts.push(url.hostname); return route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*', (socket) => socket.close());
  if (authenticated) await context.addCookies([{ name: HON_SESSION_COOKIE, value: cookie, url: origin, httpOnly: true, sameSite: 'Lax' }]);
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
      await noOverflow(page, label);
      await screenshot(page, `${label}-dashboard-viewport`, false);
    });
    await check(`${label}: appearance choices preserve the six HQ identities`, async () => {
      const motion = page.getByRole('button', { name: 'Ambient motion', exact: true });
      assert(await motion.isDisabled(), 'Reduced-motion preference must prevent ambient animation');
      assert.equal(await motion.getAttribute('aria-pressed'), 'false');
      assert.equal(await page.locator('[data-motion]').getAttribute('data-motion'), 'off');
      const views = page.getByRole('group', { name: 'Platform view' });
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
      await page.getByRole('button', { name: 'Ask HON anywhere', exact: true }).click();
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
    await context.close();
  }

  await check('Abstract HQ and decorative motion pause, keyboard restore and preference change', async () => {
    const moving = await contextFor({ width: 1440, height: 1000 }, true, 'no-preference');
    try {
      await moving.page.goto(`${origin}/hq`, { waitUntil: 'domcontentloaded' });
      await moving.page.getByRole('heading', { name: 'Your executive team', exact: true }).waitFor();
      const motion = moving.page.getByRole('button', { name: 'Ambient motion', exact: true });
      assert(await motion.isEnabled());
      assert.equal(await motion.getAttribute('aria-pressed'), 'true');
      const background = await moving.page.locator('[data-hq-background]').evaluate((node) => getComputedStyle(node).backgroundImage);
      assert(!background.includes('url('), 'HQ must use an abstract surface, not the architectural image');
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
    assert(report.apiRequests.every((request) => request.method === 'GET' && ['/v1/hq/overview', '/v1/hq/schools'].includes(request.path)));
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
