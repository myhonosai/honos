/**
 * Disposable local browser proof for the U1 school shell. Synthetic fixtures only:
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

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const schoolA = { organizationId: id(1), schoolId: id(2) }, schoolB = { organizationId: id(1), schoolId: id(3) };
const report = { syntheticFixturesOnly: true, databaseAccess: false, providerCalls: false, checks: [], failures: [], screenshots: [], pageErrors: [], apiRequests: [] };
let theme = 'modern', multi = false;
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
const json = (route, status, body) => route.fulfill({ status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }, body: JSON.stringify(body) });
function api(route) {
  const url = new URL(route.request().url()), path = url.pathname, method = route.request().method();
  report.apiRequests.push(`${method} ${path}`);
  if (path === '/api/identity/me') return json(route, 200, { data: { externalSubject: 'shell-synthetic-owner', displayName: 'Synthetic Owner' } });
  if (path === '/api/v1/staff/current-reporting-school') return json(route, 200, { data: multi ? { state: 'MANUAL_ENTRY_REQUIRED' } : { state: 'RESOLVED', ...schoolA } });
  if (path === '/api/v1/staff/reporting-schools') return json(route, 200, { data: multi
    ? { state: 'SELECTION_REQUIRED', schools: [{ ...schoolA, organizationName: 'Synthetic Dojo Group', schoolName: 'Synthetic North Academy' }, { ...schoolB, organizationName: 'Synthetic Dojo Group', schoolName: 'Synthetic South Academy' }] }
    : { state: 'MANUAL_ENTRY_REQUIRED' } });
  for (const scope of [schoolA, schoolB]) {
    const prefix = `/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}`;
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
async function open(viewport, path, { language } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await ctx.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: 'shell-synthetic-owner' }, session), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/api/')) return api(route);
    return route.continue();
  });
  const page = await ctx.newPage();
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
    await noOverflow(page);
    await shot(page, `u1-dashboard-${mode}-${size}`);
    await ctx.close();
  });
}
await check('section tabs on follow-ups (desktop)', async () => {
  theme = 'modern'; const { ctx, page } = await open(viewports.desktop, '/staff/crm/follow-ups');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  assert.equal(await page.locator('nav[aria-label="Pages in this section"] a[aria-current="page"]').textContent(), 'Follow-ups');
  assert.equal(await page.locator('a[data-nav="crm"]').getAttribute('aria-current'), 'page');
  await shot(page, 'u1-follow-ups-tabs-desktop'); await ctx.close();
});
await check('drawer opens and closes with Escape (phone)', async () => {
  theme = 'modern'; const { ctx, page } = await open(viewports.phone, '/staff/crm/leads');
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
  await page.getByRole('button', { name: 'Classic', exact: true }).click();
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
