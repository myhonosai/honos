/**
 * Disposable local browser proof for the A2P registration assistant (A2P-1).
 * Synthetic fixtures only. The production route is exercised with its real
 * NOT_CONNECTED wiring; the only /api/v1 reads it may make (current school and
 * interface theme) are answered in the browser by this script. Any other
 * /api/v1 or external request fails the run. No database, provider, AI,
 * messaging or payment system is used.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { issueSession, HON_SESSION_COOKIE } from '@hon/auth';

if (process.env.HON_A2P_BROWSER_LOCAL !== '1') throw new Error('Explicitly opt into disposable local browser verification with HON_A2P_BROWSER_LOCAL=1.');
for (const key of ['DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY', 'TWILIO_AUTH_TOKEN', 'TWILIO_ACCOUNT_SID']) {
  if (process.env[key]) throw new Error('Browser verification refuses inherited database/provider credentials.');
}
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tools = process.env.HON_A2P_BROWSER_TOOLS;
const results = process.env.HON_A2P_BROWSER_RESULTS;
const playwrightPath = process.env.HON_A2P_PLAYWRIGHT;
assert(tools && results && playwrightPath, 'HON_A2P_BROWSER_TOOLS (axe-core), HON_A2P_BROWSER_RESULTS and HON_A2P_PLAYWRIGHT are required.');
const toolsRequire = createRequire(join(tools, 'runner.cjs'));
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const axeSource = await readFile(toolsRequire.resolve('axe-core/axe.min.js'), 'utf8');
await mkdir(results, { recursive: true });

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { organizationId: id(1), schoolId: id(2) };
const report = { console: [], syntheticFixturesOnly: true, databaseAccess: false, providerCalls: false, checks: [], failures: [], screenshots: [], accessibility: [], pageErrors: [], apiRequests: [], blockedRequests: [] };
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, tablet: { width: 834, height: 1112 }, phone: { width: 390, height: 844 } };
let theme = 'modern';
// Existing reads only: current school + theme (production entry) and the root layout's language preference.
const ALLOWED_API = new Set(['/api/v1/staff/current-reporting-school', `/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/interface-theme`, '/api/v1/me/language-preference']);
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });
function api(route) {
  const path = new URL(route.request().url()).pathname;
  report.apiRequests.push(`${route.request().method()} ${path}`);
  if (path === '/api/v1/staff/current-reporting-school') return json(route, 200, { data: { state: 'RESOLVED', ...scope } });
  if (path.endsWith('/interface-theme')) return json(route, 200, { data: { interfaceTheme: theme, selectedVia: 'SETTINGS', updatedAt: '2026-10-25T09:00:00.000Z' }, meta: {} });
  return json(route, 404, { code: 'NOT_FOUND' });
}

// ---------- server ----------
const probe = createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const session = { mode: 'OIDC', audience: 'hon-a2p-browser-synthetic', secret: randomBytes(32).toString('hex') };
const server = spawn(join(webRoot, 'node_modules/.bin/next'), ['start', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: webRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', HON_API_BASE_URL: 'http://127.0.0.1:9', HON_AUTH_MODE: session.mode, HON_SESSION_AUDIENCE: session.audience, HON_SESSION_JWT_SECRET: session.secret, HON_REFERENCE_PREVIEW: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; i < 240; i += 1) { try { const r = await fetch(`${origin}/auth/login`); if (r.status < 500) break; } catch { /* starting */ } await new Promise((done) => setTimeout(done, 500)); }

const browser = await chromium.launch();
async function context(viewport, { signedIn = true } = {}) {
  const value = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce', acceptDownloads: true });
  await value.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  if (signedIn) await value.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: 'hon-a2p-synthetic-owner' }, session), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await value.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { if (!url.hostname.endsWith('fonts.googleapis.com') && !url.hostname.endsWith('fonts.gstatic.com')) report.blockedRequests.push(url.origin); return route.abort(); }
    if (url.pathname.startsWith('/api/v1/')) return api(route);
    return route.continue();
  });
  return value;
}
async function check(name, work) {
  try { await work(); report.checks.push(name); } catch (error) { report.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
}
async function shot(page, name, fullPage = false) { await page.screenshot({ path: join(results, `${name}.png`), fullPage }); report.screenshots.push(`${name}.png`); }
async function axe(page, name) {
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => (await window.axe.run({ include: [['main[data-interface-theme]']], exclude: [['[aria-label="Reference preview controls"]']] }, { runOnly: ['wcag2a', 'wcag2aa'] })).violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target })));
  report.accessibility.push({ name, violations });
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  assert.equal(serious.length, 0, `${name}: ${JSON.stringify(serious)}`);
}
async function noOverflow(page) {
  const offenders = await page.evaluate(() => [...document.querySelectorAll('main *')]
    .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(e).position !== 'fixed' && !e.closest('[aria-label="Registration steps"] ol') && !e.closest('[aria-label="Reference preview controls"]'))
    .map((e) => `${e.tagName}.${e.className}`));
  assert.deepEqual(offenders, [], 'horizontal overflow');
}
async function minTargets(page, min) {
  const small = await page.evaluate((size) => [...document.querySelectorAll('main button:not([disabled]), main input:not([disabled])')]
    .filter((e) => e.offsetParent !== null).map((e) => ({ e: e.textContent?.trim().slice(0, 30) || e.tagName, h: e.getBoundingClientRect().height }))
    .filter((x) => x.h + 0.5 < size), min);
  assert.deepEqual(small, [], `targets smaller than ${min}px`);
}
const step = (page, name) => page.getByRole('navigation', { name: 'Registration steps' }).getByRole('button', { name: new RegExp(name) }).click();
const preview = (params) => `${origin}/reference/a2p-registration?${new URLSearchParams(params)}`;

// ---------- production route: real NOT_CONNECTED wiring, all three themes ----------
for (const [label, viewport, nextTheme] of [['modern-desktop-1440', VIEWPORTS.desktop, 'modern'], ['classic-desktop-1440', VIEWPORTS.desktop, 'classic'], ['big-button-phone-390', VIEWPORTS.phone, 'big-button']]) {
  await check(`production ${label} is not connected`, async () => {
    theme = nextTheme;
    const ctx = await context(viewport); const page = await ctx.newPage();
    page.on('pageerror', (error) => report.pageErrors.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') report.console.push(message.text()); });
    page.on('requestfailed', (request) => report.console.push(`failed ${request.url()} ${request.failure()?.errorText}`));
    await page.goto(`${origin}/settings/communications/business-texting/a2p-registration`);
    await page.getByTestId('a2p-not-connected').waitFor();
    await page.waitForFunction((value) => document.querySelector('main')?.getAttribute('data-interface-theme') === value, nextTheme);
    assert.equal(await page.getByTestId('a2p-synthetic').count(), 0);
    assert.equal(await page.getByRole('textbox', { name: 'Website address' }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Send' }).isDisabled(), true);
    assert.doesNotMatch(await page.locator('main').innerText(), /Sample Dojo|synthetic/i);
    await shot(page, `production-${label}-unavailable`);
    await axe(page, `production-${label}`);
    if (viewport === VIEWPORTS.phone) { await noOverflow(page); await minTargets(page, 56); }
    await step(page, 'Registration status');
    await page.getByTestId('a2p-status-unavailable').waitFor();
    await shot(page, `production-${label}-status-unavailable`);
    await step(page, 'My registration answers');
    await page.getByRole('textbox', { name: 'HELP reply' }).fill('My School: call (555) 010-0000 for help. Reply STOP to opt out.');
    await page.getByText('Not saved. Your wording stays on this page only').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Save my edits' }).count(), 0, 'no save without an authorized backend');
    await ctx.close();
  });
}
await check('production route requires a verified session', async () => {
  const ctx = await context(VIEWPORTS.desktop, { signedIn: false }); const page = await ctx.newPage();
  await page.goto(`${origin}/settings/communications/business-texting/a2p-registration`);
  assert.match(new URL(page.url()).pathname, /^\/auth\/login/);
  await ctx.close();
});

// ---------- synthetic preview: full flow ----------
await check('modern desktop synthetic flow', async () => {
  const ctx = await context(VIEWPORTS.desktop); const page = await ctx.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(preview({ theme: 'modern' }));
  await page.getByTestId('a2p-synthetic').waitFor();
  await page.getByRole('textbox', { name: 'Website address' }).fill('localhost');
  await page.getByRole('button', { name: 'Check my website', exact: true }).click();
  await page.getByText('Use a public website address').waitFor();
  await page.getByRole('textbox', { name: 'Website address' }).fill('sample-dojo.example');
  await page.getByRole('button', { name: 'Check my website', exact: true }).click();
  await page.getByText(/Checking your website|Waiting to start|Starting the check/).first().waitFor();
  await shot(page, 'modern-desktop-1440-website-checking');
  await page.getByText('Check finished').waitFor({ timeout: 15000 });
  await shot(page, 'modern-desktop-1440-website-check-results');
  await axe(page, 'modern website check');
  await page.getByRole('button', { name: /See what to fix/ }).click();
  await page.getByRole('heading', { name: 'Text-message checkbox is already ticked' }).waitFor();
  await shot(page, 'modern-desktop-1440-website-findings', true);
  await axe(page, 'modern findings');
  const card = page.locator('article', { has: page.getByRole('heading', { name: 'Text-message checkbox is already ticked' }) });
  await card.getByRole('button', { name: 'Compare wording' }).click();
  await card.getByText('Your current wording').waitFor();
  await card.getByRole('button', { name: /Copy suggested wording: Copy/ }).click();
  await card.getByText('Copied').first().waitFor();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(copied, /I agree to receive text messages from Sample Dojo/);
  await card.getByRole('button', { name: /Mark for review/ }).click();
  await card.getByText('Marked for review').first().waitFor();
  await card.scrollIntoViewIfNeeded();
  await shot(page, 'modern-desktop-1440-suggested-fix-compare');
  await page.getByRole('button', { name: /Unable to verify/ }).click();
  await shot(page, 'modern-desktop-1440-findings-unable-to-verify');
  await step(page, 'My registration answers');
  await page.getByRole('button', { name: 'Draft my answers' }).click();
  await page.getByRole('textbox', { name: 'Campaign description' }).waitFor();
  await page.waitForFunction(() => (document.querySelector('#a2p-answer-CAMPAIGN_DESCRIPTION')?.value ?? '').length > 20);
  await shot(page, 'modern-desktop-1440-sms-answers', true);
  await axe(page, 'modern answers');
  await page.getByRole('textbox', { name: 'STOP reply' }).fill('Sample Dojo: You are unsubscribed. No more texts will be sent.');
  await page.getByText('Edited · not saved').first().waitFor();
  await page.getByRole('button', { name: 'Save my edits' }).click();
  await page.getByText('Your edits were saved.').waitFor();
  await page.getByRole('button', { name: /Confirm: We only text people/ }).click();
  await page.getByRole('button', { name: /Withdraw: We only text people/ }).waitFor();
  await step(page, 'Final review');
  await page.getByText('Items still open').waitFor();
  await shot(page, 'modern-desktop-1440-final-review', true);
  await axe(page, 'modern final review');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download draft/ }).click()]);
  const text = await readFile(await download.path(), 'utf8');
  assert.match(text, /SYNTHETIC SAMPLE DATA/);
  assert.equal(await page.getByRole('button', { name: 'Submit registration' }).isDisabled(), true);
  await step(page, 'Registration status');
  await shot(page, 'modern-desktop-1440-status-synthetic-draft');
  await ctx.close();
});

await check('classic desktop answers and review', async () => {
  const ctx = await context(VIEWPORTS.desktop); const page = await ctx.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(preview({ theme: 'classic' }));
  await page.getByTestId('a2p-synthetic').waitFor();
  await page.getByRole('textbox', { name: 'Website address' }).fill('sample-dojo.example');
  await page.getByRole('button', { name: 'Check my website', exact: true }).click();
  await page.getByText('Check finished').waitFor({ timeout: 15000 });
  await shot(page, 'classic-desktop-1440-website-check-results');
  await step(page, 'Fix my website');
  await shot(page, 'classic-desktop-1440-website-findings', true);
  await axe(page, 'classic findings');
  await step(page, 'My registration answers');
  await page.getByRole('button', { name: 'Draft my answers' }).click();
  await page.waitForFunction(() => (document.querySelector('#a2p-answer-CAMPAIGN_DESCRIPTION')?.value ?? '').length > 20);
  await shot(page, 'classic-desktop-1440-sms-answers', true);
  await axe(page, 'classic answers');
  await step(page, 'Final review');
  await shot(page, 'classic-desktop-1440-final-review', true);
  await axe(page, 'classic review');
  await ctx.close();
});

await check('big-button phone flow with HON prompts', async () => {
  const ctx = await context(VIEWPORTS.phone); const page = await ctx.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(preview({ theme: 'big-button' }));
  await page.getByTestId('a2p-synthetic').waitFor();
  await shot(page, 'big-button-phone-390-start');
  await noOverflow(page); await minTargets(page, 56);
  await axe(page, 'big-button start');
  await page.getByRole('textbox', { name: 'Website address' }).fill('sample-dojo.example');
  await page.getByRole('button', { name: 'Check my website', exact: true }).click();
  await page.getByText('Check finished').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: /Help me fix my SMS checkbox/ }).click();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Text-message checkbox is already ticked');
  await shot(page, 'big-button-phone-390-website-findings');
  await noOverflow(page);
  await axe(page, 'big-button findings');
  await page.getByRole('button', { name: /Write my sample messages/ }).click();
  await page.waitForFunction(() => document.activeElement?.id === 'a2p-answer-SAMPLE_MESSAGE_1');
  await page.getByRole('button', { name: 'Draft my answers' }).click();
  await page.waitForFunction(() => (document.querySelector('#a2p-answer-SAMPLE_MESSAGE_1')?.value ?? '').length > 20);
  await shot(page, 'big-button-phone-390-sms-answers');
  await noOverflow(page); await minTargets(page, 56);
  await page.getByRole('button', { name: /Check my application before submitting/ }).click();
  await page.getByText('Items still open').waitFor();
  await shot(page, 'big-button-phone-390-final-review', true);
  await noOverflow(page);
  await axe(page, 'big-button review');
  await page.getByRole('heading', { name: 'Ask HON' }).scrollIntoViewIfNeeded();
  await shot(page, 'big-button-phone-390-hon-assistant');
  await ctx.close();
});

await check('tablet modern layout', async () => {
  const ctx = await context(VIEWPORTS.tablet); const page = await ctx.newPage();
  await page.goto(preview({ theme: 'modern', step: 'STATUS' }));
  await page.getByTestId('a2p-synthetic').waitFor();
  await page.getByText('What each status means').waitFor();
  await shot(page, 'modern-tablet-834-status-guide', true);
  await noOverflow(page);
  await ctx.close();
});

await check('loading and error states', async () => {
  const ctx = await context(VIEWPORTS.desktop); const page = await ctx.newPage();
  await page.goto(preview({ scenario: 'checking', theme: 'modern' }));
  await page.getByText('2 of 6 pages checked').first().waitFor();
  await shot(page, 'modern-desktop-1440-state-checking');
  await page.goto(preview({ scenario: 'check-failed', theme: 'modern' }));
  await page.getByTestId('a2p-synthetic').waitFor();
  await page.getByRole('textbox', { name: 'Website address' }).fill('sample-dojo.example');
  await page.getByRole('button', { name: 'Check my website', exact: true }).click();
  await page.getByText('The website check did not finish').waitFor();
  await shot(page, 'modern-desktop-1440-state-check-failed');
  await page.goto(preview({ scenario: 'error', theme: 'classic' }));
  await page.getByText('The registration assistant is unavailable right now').waitFor();
  await shot(page, 'classic-desktop-1440-state-error');
  await axe(page, 'error state');
  await page.goto(preview({ scenario: 'unavailable', theme: 'modern', step: 'REVIEW' }));
  await page.getByTestId('a2p-not-connected').waitFor();
  await shot(page, 'modern-desktop-1440-state-unavailable-review', true);
  await ctx.close();
});

await browser.close();
server.kill('SIGTERM');
report.unexpectedApi = report.apiRequests.filter((entry) => !ALLOWED_API.has(entry.split(' ')[1]));
if (report.unexpectedApi.length) report.failures.push(`unexpected API requests: ${report.unexpectedApi.join(', ')}`);
if (report.blockedRequests.length) report.failures.push(`external requests attempted: ${[...new Set(report.blockedRequests)].join(', ')}`);
if (report.pageErrors.length) report.failures.push(`page errors: ${report.pageErrors.join(' | ')}`);
await writeFile(join(results, 'a2p-registration-browser-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ checks: report.checks.length, failures: report.failures, screenshots: report.screenshots.length }, null, 2));
if (report.failures.length) { console.error(serverLog.slice(-4000)); process.exit(1); }
