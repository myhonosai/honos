/**
 * Disposable local browser proof for the HON conversation interface (F3).
 * It exercises the env-gated /reference/hon-conversation design preview, whose
 * "server" is an in-memory synthetic fixture. Every /api request is refused and
 * recorded as a failure: no database, provider, payment or backend is used.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

if (process.env.HON_COMMAND_BROWSER_LOCAL !== '1') throw new Error('Explicitly opt into disposable local browser verification with HON_COMMAND_BROWSER_LOCAL=1.');
for (const key of ['DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY']) {
  if (process.env[key]) throw new Error('Browser verification refuses inherited database/provider credentials.');
}
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tools = process.env.HON_COMMAND_BROWSER_TOOLS;
const results = process.env.HON_COMMAND_BROWSER_RESULTS;
const playwrightPath = process.env.HON_COMMAND_PLAYWRIGHT;
assert(tools && results && playwrightPath, 'HON_COMMAND_BROWSER_TOOLS (axe-core), HON_COMMAND_BROWSER_RESULTS and HON_COMMAND_PLAYWRIGHT are required.');
const toolsRequire = createRequire(join(tools, 'runner.cjs'));
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const axeSource = await readFile(toolsRequire.resolve('axe-core/axe.min.js'), 'utf8');
await mkdir(results, { recursive: true });
const report = { syntheticFixturesOnly: true, databaseAccess: false, providerCalls: false, checks: [], failures: [], screenshots: [], accessibility: [], pageErrors: [], blockedRequests: [] };

// ---------- servers: one with the preview flag, one without ----------
async function freePort() {
  const probe = createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done));
  const port = probe.address().port; await new Promise((done) => probe.close(done)); return port;
}
let serverLog = '';
async function start(preview) {
  const port = await freePort();
  const command = process.env.HON_COMMAND_SERVER === 'start' ? ['start', '--port', String(port), '--hostname', '127.0.0.1'] : ['dev', '--port', String(port), '--hostname', '127.0.0.1'];
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: command[0] === 'start' ? 'production' : 'development', HON_DEPLOYMENT_ENVIRONMENT: 'preview', NEXT_TELEMETRY_DISABLED: '1', HON_API_BASE_URL: 'http://127.0.0.1:9' };
  if (preview) env.HON_REFERENCE_PREVIEW = '1';
  const child = spawn(join(webRoot, 'node_modules/.bin/next'), command, { cwd: webRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { serverLog += d; }); child.stderr.on('data', (d) => { serverLog += d; });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 240; i += 1) { try { const r = await fetch(`${origin}/manus-routes.json`, { signal: AbortSignal.timeout(5000) }); if (r.ok) break; } catch { /* starting */ } await new Promise((done) => setTimeout(done, 500)); }
  return { child, origin };
}
const previewServer = await start(true);
const plainServer = await start(false);
const origin = previewServer.origin;

const browser = await chromium.launch(process.env.HON_COMMAND_CHROME_BIN ? { executablePath: process.env.HON_COMMAND_CHROME_BIN } : {});
async function context(viewport) {
  const value = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await value.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/api/')) { report.blockedRequests.push(`${route.request().method()} ${url.pathname}`); return route.abort(); }
    return route.continue();
  });
  return value;
}
async function check(name, work) {
  const started = Date.now();
  try { await work(); report.checks.push(name); } catch (error) { report.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
  console.log(`${report.failures.at(-1)?.startsWith(name) ? 'FAIL' : 'ok'} ${name} (${Date.now() - started}ms)`);
}
async function shot(page, name, fullPage = false) { await page.screenshot({ path: join(results, `${name}.png`), fullPage }); report.screenshots.push(`${name}.png`); }
async function axe(page, name) {
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => (await window.axe.run({ include: [['main[data-preview]']] }, { runOnly: ['wcag2a', 'wcag2aa'] })).violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target })));
  report.accessibility.push({ name, violations });
  assert.deepEqual(violations, [], `${name}: accessibility violations`);
}
async function noOverflow(page) {
  const offenders = await page.evaluate(() => [...document.querySelectorAll('body *')]
    .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(e).position !== 'fixed')
    .map((e) => `${e.tagName}.${e.className}`));
  assert.deepEqual(offenders, [], 'horizontal overflow');
}
async function preview(viewport, query) {
  const ctx = await context(viewport); const page = await ctx.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(`${origin}/reference/hon-conversation?${new URLSearchParams(query)}`);
  await page.getByText('Design preview · synthetic fixtures · no school data, no AI, nothing is sent').waitFor();
  await page.waitForFunction(() => document.querySelector('section[data-connection]')?.getAttribute('data-connection') !== 'NOT_CONNECTED' || location.search.includes('not-connected'));
  await page.locator('img').evaluateAll((images) => Promise.all(images.map((img) => img.complete ? null : new Promise((done) => { img.onload = img.onerror = done; }))));
  return { ctx, page, conversation: page.locator('section[data-connection]') };
}
const VIEWPORTS = [['desktop-1440', { width: 1440, height: 900 }, 'full'], ['tablet-834', { width: 834, height: 1112 }, 'full'], ['phone-390', { width: 390, height: 844 }, 'panel']];
const MODES = ['modern', 'big-button', 'classic'];

// ---------- checks ----------
await check('preview is off without HON_REFERENCE_PREVIEW=1', async () => {
  const response = await fetch(`${plainServer.origin}/reference/hon-conversation`);
  assert.equal(response.status, 404);
  assert.ok(!(await response.text()).includes('Sample: Campaign'), 'no fixture content served');
});

for (const mode of MODES) {
  for (const [name, viewport, view] of VIEWPORTS) {
    await check(`${mode} ${name} history with delegation and approval`, async () => {
      const { ctx, page, conversation } = await preview(viewport, { mode, scenario: 'history', view });
      await conversation.getByText('Approval required. Nothing has run.').waitFor();
      assert.equal(await conversation.getAttribute('data-connection'), 'READY');
      assert.equal(await conversation.getByRole('link', { name: 'Review in Action Center →' }).first().getAttribute('href'), '/staff/action-center/approvals');
      assert.equal(await conversation.locator('img[src="/ai/marcus.webp"]').count(), 1);
      assert.equal(await conversation.locator('img[src*="kai"]').count(), 0, 'Kai is never a management delegate in the conversation');
      await noOverflow(page);
      await axe(page, `${mode}-${name}-history`);
      await conversation.scrollIntoViewIfNeeded();
      await shot(page, `${mode}-${name}-history`);
      await ctx.close();
    });
  }
  for (const scenario of ['not-connected', 'checking', 'not-ready', 'denied', 'error', 'empty']) {
    await check(`${mode} ${scenario} state`, async () => {
      const { ctx, page, conversation } = await preview({ width: 1440, height: 900 }, { mode, scenario, view: 'full' });
      const textarea = conversation.getByRole('textbox', { name: /Message HON/ });
      if (scenario === 'denied') assert.equal(await textarea.count(), 0, 'no composer when denied');
      else if (scenario === 'empty') { assert.equal(await textarea.isDisabled(), false); await conversation.getByText('A starter only fills the message box.').waitFor(); }
      else {
        assert.equal(await textarea.isDisabled(), true);
        assert.equal(await conversation.getByRole('button', { name: 'Send' }).isDisabled(), true);
        assert.equal(await conversation.getByRole('button', { name: 'New conversation' }).isDisabled(), true);
      }
      if (scenario === 'not-connected') {
        await conversation.getByText('Not connected', { exact: true }).waitFor();
        assert.ok(await conversation.getByRole('textbox', { name: 'Message HON (not connected)' }).isVisible());
        const text = await conversation.innerText();
        for (const forbidden of ['Processing', 'Delegating', 'Completed', 'Awaiting approval', 'Sample:']) assert.ok(!text.includes(forbidden), forbidden);
      }
      if (scenario === 'not-ready') await conversation.getByText('Governed provider route: not ready').waitFor();
      await noOverflow(page);
      await axe(page, `${mode}-${scenario}`);
      await shot(page, `${mode}-desktop-1440-${scenario}`);
      await ctx.close();
    });
  }
}

await check('keyboard: starter fills the composer, Ctrl+Enter sends, server record replaces the draft', async () => {
  const { ctx, page, conversation } = await preview({ width: 1440, height: 900 }, { mode: 'modern', scenario: 'empty', view: 'full' });
  const starter = conversation.getByRole('button', { name: 'Ask Chad to review enrollment follow-ups.' });
  await starter.focus(); await page.keyboard.press('Enter');
  const textarea = conversation.getByRole('textbox', { name: 'Message HON' });
  assert.equal(await textarea.inputValue(), 'Ask Chad to review enrollment follow-ups.');
  await textarea.focus(); await page.keyboard.press('Control+Enter');
  await conversation.getByRole('log').getByText('Ask Chad to review enrollment follow-ups.', { exact: true }).waitFor();
  await conversation.getByRole('log').locator('[data-turn-status="PROCESSING"]').waitFor();
  assert.equal(await textarea.inputValue(), '');
  await conversation.getByRole('button', { name: /Sample: Ask Chad/ }).waitFor();
  await shot(page, 'modern-desktop-1440-after-send');
  await ctx.close();
});

await check('keyboard: thread history is reachable and selectable', async () => {
  const { ctx, page, conversation } = await preview({ width: 834, height: 1112 }, { mode: 'classic', scenario: 'history', view: 'full' });
  const thread = conversation.getByRole('button', { name: /Sample: What needs approval/ });
  await thread.focus(); await page.keyboard.press('Enter');
  await conversation.getByRole('log').getByText('Proposal: review the two sample items waiting in Action Center.').waitFor();
  assert.equal(await thread.getAttribute('aria-current'), 'true');
  await conversation.getByRole('log').getByText('HON proposed a next step. Nothing has run.').waitFor();
  await shot(page, 'classic-tablet-834-proposed');
  await ctx.close();
});

for (const [scenario, expected] of [['sending', 'waiting for the server to confirm'], ['send-failed', 'Not sent.'], ['send-unknown', 'Outcome unknown.']]) {
  await check(`${scenario} recovery`, async () => {
    const { ctx, page, conversation } = await preview({ width: 834, height: 1112 }, { mode: 'big-button', scenario, view: 'full' });
    await conversation.getByRole('button', { name: 'New conversation' }).click();
    const textarea = conversation.getByRole('textbox', { name: 'Message HON' });
    await textarea.fill('Summarize attendance problems.');
    await conversation.getByRole('button', { name: 'Send' }).click();
    await conversation.getByText(expected).waitFor();
    if (scenario === 'sending') assert.equal(await textarea.isDisabled(), true);
    if (scenario === 'send-unknown') {
      assert.equal(await textarea.inputValue(), 'Summarize attendance problems.');
      await conversation.getByRole('button', { name: 'Retry' }).waitFor();
      await conversation.getByRole('button', { name: 'Check the conversation' }).waitFor();
    }
    await noOverflow(page);
    await axe(page, `big-button-${scenario}`);
    await shot(page, `big-button-tablet-834-${scenario}`);
    await ctx.close();
  });
}

await check('every turn status is shown distinctly from server data', async () => {
  const { ctx, conversation } = await preview({ width: 1440, height: 900 }, { mode: 'modern', scenario: 'history', view: 'full' });
  const seen = new Set();
  for (const title of ['How is my school', 'Enrollment follow-ups', 'Campaign for next week', 'What needs approval', 'Attendance problems']) {
    await conversation.getByRole('button', { name: new RegExp(`Sample: ${title}`) }).click();
    await conversation.getByRole('log').getByRole('heading', { name: new RegExp(title) }).waitFor();
    for (const status of await conversation.getByRole('log').locator('[data-turn-status]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-turn-status')))) seen.add(status);
  }
  assert.deepEqual([...seen].sort(), ['AWAITING_APPROVAL', 'COMPLETED', 'DELEGATING', 'FAILED', 'PROCESSING', 'PROPOSED', 'UNKNOWN']);
  await ctx.close();
});

await check('the preview made no API, provider or payment request', async () => {
  assert.deepEqual(report.blockedRequests, []);
});

await browser.close();
previewServer.child.kill('SIGTERM');
plainServer.child.kill('SIGTERM');
await writeFile(join(results, 'hon-conversation-browser-report.json'), `${JSON.stringify(report, null, 2)}\n`);
if (report.failures.length || report.pageErrors.length) {
  console.error(JSON.stringify({ failures: report.failures, pageErrors: report.pageErrors }, null, 2));
  if (report.failures.length) console.error(serverLog.slice(-4000));
  process.exitCode = 1;
}
console.log(`checks passed: ${report.checks.length}, failures: ${report.failures.length}, screenshots: ${report.screenshots.length}`);
