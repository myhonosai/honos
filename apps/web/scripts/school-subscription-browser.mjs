/** Actual production Next frontend; ephemeral signed synthetic sessions, no backend or provider. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { issueSession, HON_SESSION_COOKIE } from '@hon/auth';

assert(process.env.GITHUB_ACTIONS === 'true' || process.env.HON_SUBSCRIPTION_LOCAL === '1', 'Disposable browser verification only.');
for (const key of ['DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_TEST_SECRET_KEY', 'STRIPE_SECRET_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) assert(!process.env[key], 'Refusing inherited database/provider credentials.');
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toolsRoot = process.env.HON_SUBSCRIPTION_TOOLS, results = process.env.HON_SUBSCRIPTION_RESULTS, chrome = process.env.HON_SUBSCRIPTION_CHROME;
assert(toolsRoot && results && chrome);
const requireTools = createRequire(join(toolsRoot, 'runner.cjs')), requireWeb = createRequire(join(webRoot, 'package.json'));
const { chromium } = requireTools('playwright-core');
const axe = await readFile(requireTools.resolve('axe-core/axe.min.js'), 'utf8');
await mkdir(results, { recursive: true });
const probe = createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done));
const port = probe.address().port; await new Promise((done) => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const config = { mode: 'OIDC', audience: 'hon-school-subscription-local', secret: randomBytes(32).toString('hex') };
const app = spawn(process.execPath, [requireWeb.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: webRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', HON_AUTH_MODE: config.mode, HON_SESSION_AUDIENCE: config.audience, HON_SESSION_JWT_SECRET: config.secret }, stdio: ['ignore', 'pipe', 'pipe'] });
app.stdout.on('data', () => {}); app.stderr.on('data', () => {});
const report = { sourceSha: process.env.HON_SUBSCRIPTION_SOURCE_SHA ?? 'local', syntheticSessionsOnly: true, backendConnected: false, checkoutOperational: false, customerDataUsed: false, checks: [], failures: [], screenshots: [], accessibility: [], apiRequests: [], mutations: [], externalHostsBlocked: [], pageErrors: [] };
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function check(name, operation) { try { await operation(); report.checks.push(name); console.log(`PASS ${name}`); } catch (e) { report.failures.push({ name, message: String(e.message).slice(0, 1200) }); console.log(`FAIL ${name}: ${String(e.message).slice(0, 1200)}`); } }
async function overflow(page) { assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.body.scrollWidth <= innerWidth + 1), 'No horizontal overflow'); }
async function scan(page, label) { await page.addScriptTag({ content: axe }); const result = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })); report.accessibility.push({ label, violations: result.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target) })), incompleteCount: result.incomplete.length }); assert.equal(result.violations.length, 0, `axe ${label}: ${result.violations.map((v) => v.id).join(',')}`); }
async function capture(page, name, fullPage = true) {
  await page.evaluate(async () => { await document.fonts.ready; window.scrollTo(0, 0); });
  await page.screenshot({ path: join(results, `${name}.png`), fullPage, animations: 'disabled' });
  const jpg = await page.screenshot({ type: 'jpeg', quality: 76, fullPage, animations: 'disabled' }); await writeFile(join(results, `${name}.jpg`), jpg);
  report.screenshots.push(`${name}.png`);
  const text = jpg.toString('base64'), total = Math.ceil(text.length / 8000);
  for (let i = 0; i < total; i++) console.log(`SCHOOL_REVIEW_IMAGE ${name} ${i + 1}/${total} ${text.slice(i * 8000, (i + 1) * 8000)}`);
}
let browser;
async function context(viewport, subject = 'school-owner-synthetic', tokenOverride) {
  const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  await ctx.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { report.externalHostsBlocked.push(url.hostname); await route.abort(); return; }
    if (url.pathname.startsWith('/api/')) { report.apiRequests.push({ method: request.method(), path: url.pathname }); await route.abort(); return; }
    if (!['GET', 'HEAD'].includes(request.method())) { report.mutations.push({ method: request.method(), path: url.pathname }); await route.abort(); return; }
    await route.continue();
  });
  if (subject !== null) await ctx.addCookies([{ name: HON_SESSION_COOKIE, value: tokenOverride ?? issueSession({ externalSubject: subject }, config), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  ctx.on('page', (page) => page.on('pageerror', (error) => report.pageErrors.push(String(error.message).slice(0, 600))));
  return ctx;
}
try {
  let ready = false;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${origin}/auth/login`, { redirect: 'manual' })).status < 500) { ready = true; break; } } catch {} await delay(500); }
  assert(ready, 'Production Next server did not start');
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['tablet', { width: 834, height: 1112 }], ['mobile', { width: 390, height: 844 }], ['narrow', { width: 320, height: 800 }]]) {
    const ctx = await context(viewport), page = await ctx.newPage();
    await page.goto(`${origin}/staff/subscription`); await page.getByRole('heading', { name: /More time to teach/ }).waitFor();
    // Verification-only label, never a production fixture mode or authorization bypass.
    await page.evaluate(() => { const label = document.createElement('div'); label.textContent = 'SYNTHETIC SIGNED SESSION · DISPLAY TERMS ONLY · CHECKOUT DISABLED'; label.style.cssText = 'position:relative;z-index:100;padding:7px;background:#19374b;color:#d4faff;font:10px system-ui;text-align:center'; document.body.prepend(label); });
    await check(`${name}: initial layout, honest account state and accessible comparison`, async () => { await overflow(page); assert(await page.getByRole('heading', { name: 'Current subscription unavailable' }).isVisible()); assert.equal(await page.getByRole('radio').count(), 3); await scan(page, `${name}-selection`); });
    if (['desktop', 'mobile'].includes(name)) { await capture(page, `${name}-plans`); await capture(page, `${name}-viewport`, false); }
    await check(`${name}: all price combinations and view compatibility`, async () => {
      for (const [offer, amounts] of [['Founder monthly', ['$79', '$149']], ['Founder lifetime', ['$1,896', '$3,576']], ['Regular monthly', ['$149', '$249']]]) {
        await page.getByRole('radio', { name: new RegExp(`^${offer}`) }).check();
        const cards = page.getByRole('group', { name: 'Compare and select a HON plan' });
        for (const amount of amounts) assert(await cards.getByText(amount, { exact: true }).isVisible());
      }
      for (const mode of ['Big Button', 'Classic', 'Modern']) { await page.getByRole('button', { name: mode, exact: true }).click(); assert.equal(await page.getByRole('button', { name: mode, exact: true }).getAttribute('aria-pressed'), 'true'); await overflow(page); }
    });
    await check(`${name}: explicit review and acknowledgement never enables checkout`, async () => {
      await page.getByRole('button', { name: 'Select HON Complete' }).click(); await page.getByRole('radio', { name: /^Founder lifetime/ }).check();
      await page.getByRole('button', { name: 'Review selection' }).click();
      assert(await page.getByRole('heading', { name: 'Your subscription summary' }).evaluate((e) => e === document.activeElement));
      const ack = page.getByRole('checkbox'); await ack.check(); assert(await page.getByRole('button', { name: 'Secure checkout unavailable' }).isDisabled()); await overflow(page); await scan(page, `${name}-review`);
    });
    if (['desktop', 'mobile'].includes(name)) await capture(page, `${name}-review`);
    await check(`${name}: changing selection clears confirmation and edit restores keyboard focus`, async () => {
      await page.getByRole('radio', { name: /^Founder monthly/ }).check(); assert.equal(await page.getByRole('checkbox').count(), 0);
      await page.getByRole('button', { name: 'Review selection' }).click(); assert(!(await page.getByRole('checkbox').isChecked()));
      await page.getByRole('button', { name: 'Edit selection' }).click(); assert(await page.getByRole('button', { name: 'Review selection' }).evaluate((e) => e === document.activeElement));
    });
    await check(`${name}: HON expand, answer, Escape and restore keyboard behavior`, async () => {
      const toggle = page.getByRole('button', { name: 'HON plan guide', exact: true }); await toggle.focus(); await page.keyboard.press('Enter');
      const guide = page.getByRole('complementary', { name: 'A little guidance?' });
      assert(await guide.getByRole('heading').evaluate((e) => e === document.activeElement));
      await guide.getByRole('button', { name: 'How do founder offers work?' }).click(); assert(await guide.getByText(/program limits, not remaining slots/).isVisible());
      await scan(page, `${name}-guide`); await overflow(page);
      if (['desktop', 'mobile'].includes(name)) await capture(page, `${name}-guide`, false);
      await page.keyboard.press('Escape'); assert.equal(await guide.count(), 0); assert(await page.getByRole('button', { name: 'HON plan guide', exact: true }).evaluate((e) => e === document.activeElement));
      await page.keyboard.press('Enter'); await page.getByRole('button', { name: 'Minimize HON plan guide', exact: true }).click(); assert.equal(await guide.count(), 0);
    });
    await check(`${name}: reload and forged return URL cannot create payment or authority`, async () => {
      await page.goto(`${origin}/staff/subscription?success=true&checkout=PAID&schoolId=unauthorized&plan=COMPLETE`);
      await page.getByRole('heading', { name: /More time to teach/ }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Selected HON Core' }).getAttribute('aria-pressed'), 'true');
      assert(await page.getByRole('heading', { name: 'Current subscription unavailable' }).isVisible()); assert.equal(await page.getByRole('checkbox').count(), 0);
      assert.equal(await page.locator('input[type=password],input[autocomplete=cc-number],iframe').count(), 0);
    });
    await ctx.close();
  }
  for (const [label, subject, token] of [['unsigned', null, undefined], ['tampered', 'school-owner-synthetic', 'invalid-signed-token'], ['expired', 'school-owner-synthetic', issueSession({ externalSubject: 'school-owner-synthetic' }, config, 1)]]) {
    await check(`${label}: existing signed staff gate refuses route`, async () => { const ctx = await context({ width: 390, height: 844 }, subject, token); try { const page = await ctx.newPage(); await page.goto(`${origin}/staff/subscription`); await page.waitForURL(`${origin}/auth/login`); assert.equal(await page.getByRole('heading', { name: /More time to teach/ }).count(), 0); } finally { await ctx.close(); } });
  }
  for (const subject of ['school-staff-without-purchase-synthetic', 'other-school-synthetic', 'family-synthetic', 'hq-synthetic', 'support-synthetic']) {
    await check(`${subject}: sign-in alone exposes no private data or billing action`, async () => { const ctx = await context({ width: 390, height: 844 }, subject); try { const page = await ctx.newPage(); await page.goto(`${origin}/staff/subscription`); await page.getByRole('button', { name: 'Review selection' }).click(); await page.getByRole('checkbox').check(); assert(await page.getByRole('button', { name: 'Secure checkout unavailable' }).isDisabled()); assert(await page.getByRole('heading', { name: 'Current subscription unavailable' }).isVisible()); } finally { await ctx.close(); } });
  }
  await check('No billing API request, mutation, provider operation or JavaScript error', async () => { assert.deepEqual(report.apiRequests, []); assert.deepEqual(report.mutations, []); assert.deepEqual(report.pageErrors, []); });
} catch (error) { report.failures.push({ name: 'harness', message: String(error.message).slice(0, 1200) }); }
finally { if (browser) await browser.close(); app.kill('SIGTERM'); await Promise.race([new Promise((done) => app.once('exit', done)), delay(3000)]); if (app.exitCode === null) app.kill('SIGKILL'); report.externalHostsBlocked = [...new Set(report.externalHostsBlocked)]; await writeFile(join(results, 'report.json'), JSON.stringify(report, null, 2)); console.log(`SCHOOL_BROWSER_REPORT ${JSON.stringify(report)}`); }
if (report.failures.length) process.exitCode = 1;
