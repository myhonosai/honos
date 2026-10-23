/** Actual Next app and signed synthetic sessions; presentation-only proof, no pricing backend simulation. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { issueSession, verifySession, cookieValue, HON_SESSION_COOKIE } from '@hon/auth';
import { HQ_OVERVIEW_UNAVAILABLE_REASONS, validateMyLanguagePreferenceView } from '@hon/contracts';
import { translate } from '@hon/design-system';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_SECRET_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) assert(!process.env[key], 'No database/provider credentials allowed.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), tools = process.env.HON_HQ_BROWSER_TOOLS, results = process.env.HON_HQ_BROWSER_RESULTS;
assert(tools && results && process.env.HON_HQ_CHROME_BIN);
const requireTools = createRequire(join(tools, 'runner.cjs')), requireWeb = createRequire(join(root, 'package.json'));
const { chromium } = requireTools('playwright-core'), axe = await readFile(requireTools.resolve('axe-core/axe.min.js'), 'utf8');
await mkdir(results, { recursive: true });
const report = { sourceSha: process.env.HON_HQ_SOURCE_SHA, fixtureOnly: true, pricingBackendConnected: false, financialActions: false, checks: [], failures: [], screenshots: [], accessibility: [], requests: [], pageErrors: [], koreanFonts: [], hitTests: [] };
const session = { mode: 'OIDC', audience: 'hon-pricing-ux-synthetic', secret: randomBytes(32).toString('hex') };
const probe = createServer(); await new Promise(done => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise(done => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const overview = role => ({ asOf: '2026-10-23T12:00:00.000Z', callerHqRole: role, organizationCount: 0, schoolCount: 0, onboarding: { availability: 'AVAILABLE', requestCount: 0, inProgressRequestCount: 0, completedRequestCount: 0 }, configuredProviderStates: { disabled: 0, configured: 0, healthy: 0, degraded: 0, unavailable: 0 }, taskProfileCount: 0,
  financialMetrics: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.financialMetrics }, aiUsage: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.aiUsage }, durableHqWork: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.durableHqWork } });
const api = createServer((req, res) => {
  report.requests.push({ method: req.method, path: req.url });
  const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }); res.end(JSON.stringify({ data })); };
  let subject; try { subject = verifySession(cookieValue(req.headers.cookie, HON_SESSION_COOKIE) ?? '', session).externalSubject; } catch { send(401, {}); return; }
  if (req.method !== 'GET') { send(405, {}); return; }
  const language = subject.split('-').at(-1); const lang = ['en', 'ko', 'es'].includes(language) ? language : 'en';
  if (req.url === '/v1/me/language-preference') { send(200, validateMyLanguagePreferenceView({ preference: { language: lang, version: 1, updatedAt: '2026-10-23T12:00:00.000Z' }, schoolDefault: null, effective: { language: lang, source: 'PERSONAL' }, supportedLanguages: ['en', 'ko', 'es'] })); return; }
  if (!/^pricing-(owner|operator)-(en|ko|es)$/.test(subject)) { send(403, {}); return; }
  if (req.url === '/v1/hq/overview') { send(200, { overview: overview(subject.includes('-owner-') ? 'OWNER' : 'OPERATOR') }); return; }
  send(404, {}); // No invented offer, publish, founder, checkout or billing endpoint.
});
await new Promise(done => api.listen(3001, '127.0.0.1', done));
const app = spawn(process.execPath, [requireWeb.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: root,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', HON_API_BASE_URL: 'http://127.0.0.1:3001', HON_AUTH_MODE: session.mode, HON_SESSION_AUDIENCE: session.audience, HON_SESSION_JWT_SECRET: session.secret }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; app.stdout.on('data', d => { log += d; }); app.stderr.on('data', d => { log += d; });
let browser;
async function check(name, work) { try { await work(); report.checks.push(name); console.log('PASS ' + name); } catch (e) { report.failures.push({ name, message: e.message }); console.error('FAIL ' + name + ': ' + e.message); } }
async function open(viewport, language = 'en', role = 'owner') {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.routeWebSocket('**/*', socket => socket.close());
  if (role) await context.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: `pricing-${role}-${language}` }, session), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage(); page.on('pageerror', e => report.pageErrors.push(e.message));
  await page.goto(origin + '/hq/pricing-offers');
  if (role === 'owner' || role === 'operator') await page.locator(`html[lang=${language}] [data-pricing-design]`).waitFor();
  return { context, page };
}
async function capture(page, name, { fullPage = true, resetScroll = true } = {}) {
  await page.evaluate(async reset => { await document.fonts.ready; if (reset) window.scrollTo(0, 0); }, resetScroll);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Horizontal overflow');
  await page.addScriptTag({ content: axe });
  const result = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  const violations = result.violations.map(v => ({ id: v.id, impact: v.impact })); report.accessibility.push({ name, violations }); assert.equal(violations.length, 0, JSON.stringify(violations));
  await page.screenshot({ path: join(results, name + '.png'), fullPage, animations: 'disabled' }); report.screenshots.push(name + '.png');
}
// A loaded CSS font name is not enough: inspect the font Chrome actually used for Hangul glyphs.
async function verifyKoreanFont(page, size) {
  await page.evaluate(() => document.fonts.ready);
  const heading = page.locator('[data-pricing-design] section h2').first();
  assert(/[가-힣]/u.test(await heading.innerText()), 'Actual translated heading must contain Hangul');
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-pricing-design] section h2' });
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    report.koreanFonts.push({ size, fonts });
    assert(fonts.some(font => /Noto Sans (CJK KR|KR)/i.test(font.familyName) && font.glyphCount > 0), 'Chrome must render real Korean glyphs with the provisioned fallback');
    console.log('KOREAN_FONT ' + JSON.stringify({ size, fonts }));
  } finally { await cdp.detach(); }
}
async function hitTest(page, locator, name) {
  const result = await locator.evaluate(element => {
    const r = element.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    return { visible: r.top >= 0 && r.bottom <= (window.visualViewport?.height ?? innerHeight), reachable: element.contains(document.elementFromPoint(x, y)), width: r.width, height: r.height };
  });
  report.hitTests.push({ name, ...result });
  assert(result.visible && result.reachable, `${name} obscured or outside the viewport: ${JSON.stringify(result)}`);
  assert(result.width >= 44 && result.height >= 44, `${name} touch target too small`);
}
async function dirtySwitches(page, ui, tx, language, size) {
  const layouts = page.getByLabel(tx('pricing.payment'), { exact: true });
  const amount = page.getByLabel(tx('pricing.amount'), { exact: true });
  await amount.fill('250.02'); await layouts.selectOption('annual');
  const dialog = ui.getByRole('dialog', { name: tx('pricing.unsaved-title'), exact: true });
  await dialog.waitFor();
  const keepEditing = dialog.getByRole('button', { name: tx('pricing.continue-editing'), exact: true });
  assert(await keepEditing.evaluate(e => e === document.activeElement), 'Safe default focus');
  // Tab stays inside the native modal, and Escape is nondestructive.
  await page.keyboard.press('Tab'); assert(await dialog.evaluate(e => e.contains(document.activeElement)));
  await page.keyboard.press('Shift+Tab'); assert(await keepEditing.evaluate(e => e === document.activeElement), 'Reverse tab wraps inside modal');
  await capture(page, `${language}-${size}-pricing-unsaved-changes`, { resetScroll: false });
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  assert.equal(await amount.inputValue(), '250.02'); assert.equal(await layouts.inputValue(), 'monthly');
  assert(await layouts.evaluate(e => e === document.activeElement), 'Restore focus to selector');
  await layouts.selectOption('annual'); await dialog.getByRole('button', { name: tx('pricing.continue-editing'), exact: true }).click(); assert.equal(await amount.inputValue(), '250.02');
  await layouts.selectOption('annual'); await dialog.getByRole('button', { name: tx('pricing.discard-changes'), exact: true }).click();
  await layouts.selectOption('monthly'); assert.equal(await amount.inputValue(), '249.01', 'Discard restores previous local copy');
  // Incomplete founder/annual/AI notes must also survive a local save and return.
  await layouts.selectOption('founder-annual');
  const fields = { 'pricing.amount': '31.', 'pricing.limit': '17', 'pricing.eligibility': 'Synthetic partial eligibility', 'pricing.discount': '7.25', 'pricing.renewal': 'Synthetic renewal', 'pricing.credits': '12345', 'pricing.limits': 'Synthetic AI limit' };
  for (const [key, value] of Object.entries(fields)) await page.getByLabel(tx(key), { exact: true }).fill(value);
  await layouts.selectOption('monthly'); await dialog.getByRole('button', { name: tx('pricing.save-local'), exact: true }).click();
  await layouts.selectOption('founder-annual');
  for (const [key, value] of Object.entries(fields)) assert.equal(await page.getByLabel(tx(key), { exact: true }).inputValue(), value, key);
  await layouts.selectOption('monthly'); // A retained copy has no unsaved changes.
  assert.equal(await dialog.count(), 0);
}
try {
  let started = false; for (let i = 0; i < 100; i++) { try { await fetch(origin); started = true; break; } catch {} await new Promise(done => setTimeout(done, 250)); } assert(started, log.slice(-1200));
  browser = await chromium.launch({ executablePath: process.env.HON_HQ_CHROME_BIN, headless: true });
  for (const language of ['en', 'ko', 'es']) for (const [size, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) await check(`${language}/${size}: owner design, local editor, one-product preview, publication disabled, modes, keyboard and axe`, async () => {
    const { context, page } = await open(viewport, language); const tx = key => translate(language, key), ui = page.locator('[data-pricing-design]');
    try {
      assert.equal(await ui.locator('article').count(), 6);
      if (language === 'ko') await verifyKoreanFont(page, size);
      // At the initial mobile viewport, all four local tabs precede the fixed HQ navigation.
      if (size === 'mobile') for (const key of ['overview', 'editor', 'preview', 'history']) await hitTest(page, ui.getByRole('button', { name: tx('pricing.' + key), exact: true }), `${language}/${size}/${key}/initial`);
      await capture(page, `${language}-${size}-pricing-overview`);
      if (size === 'mobile') await capture(page, `${language}-${size}-pricing-overview-viewport`, { fullPage: false });
      await ui.getByRole('button', { name: tx('pricing.editor'), exact: true }).focus(); await page.keyboard.press('Enter');
      await page.getByLabel(tx('pricing.amount'), { exact: true }).fill('249.01'); await page.getByLabel(tx('pricing.terms'), { exact: true }).fill('Synthetic draft terms for review only.'); await page.getByLabel(tx('pricing.renewal'), { exact: true }).fill('Synthetic monthly renewal terms.'); await page.getByLabel(tx('pricing.credits'), { exact: true }).fill('12000'); await page.getByLabel(tx('pricing.limits'), { exact: true }).fill('Synthetic proposed limits; no credits granted.');
      if (size === 'mobile') {
        await page.getByLabel(tx('pricing.limits'), { exact: true }).focus(); await page.keyboard.press('Tab');
        await hitTest(page, ui.getByRole('button', { name: tx('pricing.keep'), exact: true }), `${language}/${size}/keep/keyboard`);
        await capture(page, `${language}-${size}-pricing-editor-keyboard-viewport`, { fullPage: false, resetScroll: false });
      }
      await ui.getByRole('button', { name: tx('pricing.keep'), exact: true }).click(); await ui.getByText(tx('pricing.kept'), { exact: true }).waitFor(); await capture(page, `${language}-${size}-pricing-editor`);
      await ui.getByRole('button', { name: tx('pricing.review'), exact: true }).click(); await ui.getByRole('heading', { name: tx('pricing.publication'), exact: true }).waitFor(); assert(await ui.getByRole('heading', { name: tx('pricing.publication'), exact: true }).evaluate(e => e === document.activeElement));
      await ui.getByRole('checkbox', { name: tx('pricing.ack'), exact: true }).check(); assert(await ui.getByRole('button', { name: tx('pricing.publish-unavailable'), exact: true }).isDisabled()); await capture(page, `${language}-${size}-pricing-publication`);
      await dirtySwitches(page, ui, tx, language, size);
      await page.getByLabel(tx('pricing.payment'), { exact: true }).selectOption('founder-lifetime'); await page.getByLabel(tx('pricing.amount'), { exact: true }).fill('3576'); await page.getByLabel(tx('pricing.limit'), { exact: true }).fill('20'); assert.equal(await page.getByLabel(tx('pricing.service-terms'), { exact: true }).count(), 1); assert.equal(await page.getByLabel(tx('pricing.renewal'), { exact: true }).count(), 0); await capture(page, `${language}-${size}-pricing-founder-lifetime`);
      await ui.getByRole('button', { name: tx('pricing.preview'), exact: true }).click(); const preview = ui.locator('[data-customer-pricing-preview]'); assert.equal(await preview.locator('article').count(), 3); assert(!(await preview.innerText()).includes('3,576')); assert.equal(await preview.getByRole('button', { disabled: true }).count(), 3); await capture(page, `${language}-${size}-pricing-customer-preview`);
      for (const mode of ['Big Button', 'Modern', 'Classic']) { await page.getByRole('group', { name: tx('Platform view'), exact: true }).getByRole('button', { name: tx(mode), exact: true }).click(); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); }
      await page.getByRole('group', { name: tx('AI portrait style'), exact: true }).getByRole('button', { name: tx('Chibi'), exact: true }).click(); assert.equal(await page.locator('[data-art]').getAttribute('data-art'), 'chibi');
      await ui.getByRole('button', { name: tx('pricing.history'), exact: true }).click(); await ui.getByText(tx('pricing.history-note'), { exact: true }).waitFor(); await capture(page, `${language}-${size}-pricing-history-unavailable`);
      await page.reload(); await page.locator(`html[lang=${language}] [data-pricing-design]`).waitFor(); assert.equal(await ui.getByText(tx('pricing.local-draft'), { exact: true }).count(), 0, 'Local draft must not survive reload or become a saved offer');
    } finally { await context.close(); }
  });
  await check('Narrow mobile: all pricing tabs reachable in every view, keyboard controls clear fixed navigation', async () => {
    for (const width of [320, 390]) {
      const { context, page } = await open({ width, height: 740 }, 'ko'); const ui = page.locator('[data-pricing-design]');
      try {
        for (const mode of ['Big Button', 'Modern', 'Classic']) {
          await page.getByRole('group', { name: translate('ko', 'Platform view'), exact: true }).getByRole('button', { name: translate('ko', mode), exact: true }).click();
          for (const key of ['overview', 'editor', 'preview', 'history']) {
            const tab = ui.getByRole('button', { name: translate('ko', 'pricing.' + key), exact: true });
            await tab.scrollIntoViewIfNeeded(); await tab.focus(); await hitTest(page, tab, `ko/${width}/${mode}/${key}`);
          }
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        }
      } finally { await context.close(); }
    }
  });
  await check('HQ operator cannot edit or publish; school identity is denied and absent session redirects', async () => {
    const operator = await open({ width: 390, height: 844 }, 'en', 'operator'); try { const ui = operator.page.locator('[data-pricing-design]'); await ui.getByRole('button', { name: 'Offer editor', exact: true }).click(); assert(await operator.page.getByLabel('Price in selected currency', { exact: true }).isDisabled()); assert(await ui.getByRole('button', { name: 'Keep local design draft', exact: true }).isDisabled()); await capture(operator.page, 'operator-mobile-pricing-read-only'); } finally { await operator.context.close(); }
    const denied = await open({ width: 390, height: 844 }, 'en', 'school'); try { await denied.page.getByText('HQ access denied', { exact: true }).waitFor(); assert.equal(await denied.page.locator('[data-pricing-design]').count(), 0); } finally { await denied.context.close(); }
    const absent = await open({ width: 390, height: 844 }, 'en', null); try { assert(new URL(absent.page.url()).pathname.startsWith('/auth/')); assert.equal(await absent.page.locator('[data-pricing-design]').count(), 0); } finally { await absent.context.close(); }
  });
  assert(report.requests.every(r => r.method === 'GET' && ['/v1/me/language-preference', '/v1/hq/overview'].includes(r.path)), 'Unexpected API or mutation');
  assert.equal(report.pageErrors.length, 0, JSON.stringify(report.pageErrors));
  assert.equal(report.failures.length, 0, JSON.stringify(report.failures));
} catch (e) { console.error(e.stack ?? e); process.exitCode = 1; }
finally { await browser?.close(); app.kill('SIGTERM'); await new Promise(done => api.close(done)); await writeFile(join(results, 'pricing-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ checks: report.checks.length, screenshots: report.screenshots.length, axeScans: report.accessibility.length, failures: report.failures.length, jsErrors: report.pageErrors.length, pricingBackendConnected: false })); }
