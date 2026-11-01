/** Actual Next/React + signed synthetic sessions and contract fixtures. Not API/database/IAM proof. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { issueSession, verifySession, cookieValue, HON_SESSION_COOKIE } from '@hon/auth';
import { HQ_OVERVIEW_UNAVAILABLE_REASONS } from '@hon/contracts';
assert(process.env.GITHUB_ACTIONS === 'true' || process.env.HON_FOUNDER_BROWSER_LOCAL === '1');
for (const key of ['DATABASE_URL','HON_RUNTIME_DATABASE_URL','ZERNIO_API_KEY','STRIPE_SECRET_KEY','OPENAI_API_KEY']) assert(!process.env[key]);
const root = resolve('.'), req = createRequire(join(root, 'package.json')), tools = createRequire(join(process.env.HON_HQ_BROWSER_TOOLS, 'runner.cjs'));
const { chromium } = tools('playwright-core'), { transform } = tools('esbuild');
const compiled = await transform(await readFile(join(root, 'src/components/founder-setup/catalog.ts'), 'utf8'), { loader: 'ts', format: 'esm' });
const { founderText: t } = await import('data:text/javascript;base64,' + Buffer.from(compiled.code).toString('base64'));
const axe = await readFile(tools.resolve('axe-core/axe.min.js'), 'utf8'), results = process.env.HON_HQ_BROWSER_RESULTS;
await mkdir(results, { recursive: true });
const report = { sourceSha: process.env.HON_HQ_SOURCE_SHA, syntheticBrowserOnly: true, realApiDatabaseVerification: false, externalProviderCalls: 0, screenshots: [], accessibility: [], stageChecks: [], stageAnnouncements: [], hqAffordances: [], focusChecks: [], checks: [] };
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const session = { mode: 'OIDC', audience: 'founder-browser-synthetic', secret: randomBytes(32).toString('hex') };
const state = { language: 'en', ownerReads: 0, hqReads: 0, mutations: 0, status: 200, hold: false, settle: null, schoolName: 'SYNTHETIC SCHOOL A' };
const projection = () => ({ organizationId: id(1), schoolId: id(2), schoolName: state.schoolName, tier: 'COMPLETE', program: { id: id(3), version: 1, status: 'DRAFT' }, classSession: null, registration: null, guardianChildRegistration: null });
const directory = { schools: [{ schoolId: id(2), organizationDisplayName: 'SYNTHETIC ORGANIZATION', schoolDisplayName: 'SYNTHETIC HQ SCHOOL', organizationOperationalStatus: 'ACTIVE', schoolOperationalStatus: 'ACTIVE', entitlementTier: null, createdAt: '2026-10-30T12:00:00.000Z' }] };
const overview = { asOf: '2026-10-30T12:00:00.000Z', callerHqRole: 'OWNER', organizationCount: 0, schoolCount: 0, onboarding: { availability: 'AVAILABLE', requestCount: 0, inProgressRequestCount: 0, completedRequestCount: 0 }, configuredProviderStates: { disabled: 0, configured: 0, healthy: 0, degraded: 0, unavailable: 0 }, taskProfileCount: 0, financialMetrics: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.financialMetrics }, aiUsage: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.aiUsage }, durableHqWork: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.durableHqWork } };
const api = createServer(async (r, s) => {
  const send = (status, data) => { if (s.destroyed) return; s.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }); s.end(JSON.stringify(status === 200 ? { data } : { code: 'SYNTHETIC_DENIED' })); };
  try { verifySession(cookieValue(r.headers.cookie, HON_SESSION_COOKIE) ?? '', session); } catch { send(401); return; }
  if (r.url === '/v1/me/language-preference') {
    if (r.method === 'PUT') { let text = ''; for await (const c of r) text += c; state.language = JSON.parse(text).language; send(200, { preference: { language: state.language, version: 2, updatedAt: '2026-10-30T12:00:00.000Z' }, replayed: false }); return; }
    send(200, { preference: { language: state.language, version: 2, updatedAt: '2026-10-30T12:00:00.000Z' }, schoolDefault: null, effective: { language: state.language, source: 'PERSONAL' }, supportedLanguages: ['en','ko','es'] }); return;
  }
  if (r.method !== 'GET') { state.mutations++; send(405); return; }
  if (r.url === '/v1/hq/session') { send(200, { principalId: id(9), hqRole: 'HON_HQ_OWNER' }); return; }
  if (r.url === '/v1/hq/overview') { send(200, { overview }); return; }
  if (r.url === '/v1/hq/schools') { state.hqReads++; if (state.hold) { state.settle = () => send(200, { directory }); return; } send(state.status, { directory }); return; }
  if (r.url === '/v1/owner-launch') {
    state.ownerReads++;
    const data = projection();
    if (state.hold) { state.settle = () => send(200, data); return; }
    send(state.status, data); return;
  }
  send(404);
});
let app, browser; let log = ''; const origin = 'http://127.0.0.1:3100';
async function open(language, viewport, plane = 'school', expired = false) {
  state.language = language;
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: 'oidc:synthetic:founder' }, session, Math.floor(Date.now() / 1000) - (expired ? 43201 : 0)), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  await page.goto(origin + (plane === 'hq' ? '/hq/founder-setup' : '/staff/founder-setup'));
  if (!expired) await page.waitForFunction(lang => document.documentElement.lang === lang, language);
  return { context, page };
}
async function audit(page, name) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Horizontal overflow');
  if (!await page.evaluate(() => Boolean(window.axe))) await page.addScriptTag({ content: axe });
  const scan = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21aa'] } }));
  report.accessibility.push({ name, violations: scan.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })) });
  assert.equal(scan.violations.length, 0, JSON.stringify(scan.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))));
}
async function capture(page, name, scan = true) {
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0); });
  if (scan) await audit(page, name);
  await page.screenshot({ path: join(results, name + '.png'), fullPage: true }); report.screenshots.push(name + '.png');
}
async function announcement(page, guide, originalNode, language, width, mode, stage, method) {
  const region = guide.locator('[data-founder-stage-status]'), title = t(language, `step${stage}Title`);
  const expected = `${t(language, 'guide')}: ${stage + 1} / 8 · ${title}`;
  await page.waitForFunction(expected => document.querySelector('[data-founder-stage-status]')?.textContent === expected, expected);
  assert.equal(await region.getAttribute('role'), 'status'); assert.equal(await region.getAttribute('aria-live'), 'polite'); assert.equal(await region.getAttribute('aria-atomic'), 'true');
  assert(await page.evaluate(node => node === document.querySelector('[data-founder-stage-status]'), originalNode), 'The live region must remain mounted');
  assert((await region.ariaSnapshot()).includes(title), 'The stage announcement must remain in the accessibility tree');
  assert(!(await region.textContent()).includes(state.schoolName), 'Announcements contain no protected facts');
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
  report.stageAnnouncements.push({ language, width, mode, stage: stage + 1, title, method });
}
try {
  await new Promise((done, reject) => { api.once('error', reject); api.listen(3001, '127.0.0.1', done); });
  app = spawn(process.execPath, [req.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', '3100'], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'production', HON_DEPLOYMENT_ENVIRONMENT: 'preview', NEXT_TELEMETRY_DISABLED: '1', HON_AUTH_MODE: 'OIDC', HON_SESSION_AUDIENCE: session.audience, HON_SESSION_JWT_SECRET: session.secret }, stdio: ['ignore','pipe','pipe'] });
  app.stdout.on('data', b => { log = (log + b).slice(-10000); }); app.stderr.on('data', b => { log = (log + b).slice(-10000); });
  let ready = false; for (let i = 0; i < 100; i++) { try { await fetch(origin, { redirect: 'manual' }); ready = true; break; } catch {} await new Promise(r => setTimeout(r, 200)); } assert(ready, 'Synthetic server did not start');
  browser = await chromium.launch({ executablePath: process.env.HON_HQ_CHROME_BIN, headless: true, args: ['--no-sandbox'] });
  for (const language of ['en','ko','es']) for (const width of [390,834,1440]) {
    const { context, page } = await open(language, { width, height: 1000 });
    const rootGuide = page.locator('[data-founder-plane=school]');
    const announcementNode = await rootGuide.locator('[data-founder-stage-status]').elementHandle(); assert(announcementNode); assert.equal(await announcementNode.textContent(), '');
    const before = state.ownerReads; await page.waitForTimeout(100); assert.equal(state.ownerReads, before);
    const load = rootGuide.getByRole('button', { name: t(language, 'load'), exact: true });
    await load.focus(); assert(await load.evaluate(el => el === document.activeElement));
    await load.click(); await page.getByText(state.schoolName, { exact: true }).first().waitFor(); assert.equal(state.ownerReads, before + 1);
    const captureMode = width === 390 ? 'big-button' : width === 834 ? 'classic' : 'modern';
    for (const mode of ['modern','classic','big-button']) {
      await rootGuide.getByRole('button', { name: t(language, mode), exact: true }).click(); assert.equal(await rootGuide.getAttribute('data-guide-mode'), mode);
      for (let stage = 0; stage < 8; stage++) {
        const title = t(language, `step${stage}Title`);
        const stageButton = rootGuide.getByRole('navigation', { name: t(language, 'steps'), exact: true }).getByRole('button').nth(stage);
        await stageButton.focus(); await page.keyboard.press(stage % 2 ? 'Space' : 'Enter');
        await page.getByRole('heading', { name: title, exact: true }).waitFor();
        await announcement(page, rootGuide, announcementNode, language, width, mode, stage, 'step-navigation');
        assert(await stageButton.evaluate(el => el === document.activeElement), 'Live feedback must not steal focus');
        assert.equal(await stageButton.getAttribute('aria-current'), 'step');
        const card = rootGuide.locator('section[aria-labelledby="founder-current-step"]');
        const destinations = { 2: [['openRoles','/staff/roles']], 3: [['openLaunch','/staff/launch'],['openSchedule','/staff/schedule/sessions']], 4: [['openCrm','/staff/crm/leads'],['openPlans','/staff/billing/membership-plans'],['openImport','/staff/migration/leads']], 5: [['openHon','/staff/hon']], 6: [['openSubscription','/staff/subscription']] };
        for (const [key, href] of destinations[stage] ?? []) assert.equal(await card.getByRole('link', { name: t(language, key) + ' →', exact: true }).getAttribute('href'), href);
        if (stage === 1 || stage === 2) assert(await card.getByRole('button', { name: t(language, 'unsupported'), exact: true }).isDisabled());
        if (stage === 6) assert(await card.getByText(t(language, 'reviewNote'), { exact: true }).isVisible());
        if (stage === 7) assert(await rootGuide.getByRole('button', { name: t(language, 'submit'), exact: true }).isDisabled());
        assert.equal(await rootGuide.locator('[data-founder-status]').getAttribute('role'), 'status');
        assert.equal(await rootGuide.getByRole('button', { name: t(language, 'previous'), exact: true }).isDisabled(), stage === 0);
        assert.equal(await rootGuide.getByRole('button', { name: t(language, 'next'), exact: true }).isDisabled(), stage === 7);
        assert(await rootGuide.locator('header').getByText(t(language, 'boundary'), { exact: true }).isVisible());
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Stage overflow');
        assert.equal(state.ownerReads, before + 1); assert.equal(state.mutations, 0);
        report.stageChecks.push({ language, width, mode, stage: stage + 1, title });
        if (stage === 0) { const focus = await stageButton.evaluate(el => ({ active: el === document.activeElement, visible: el.matches(':focus-visible'), outline: Number.parseFloat(getComputedStyle(el).outlineWidth) })); assert(focus.active && focus.visible && focus.outline >= 2, 'Visible keyboard focus'); report.focusChecks.push({ language, width, mode, ...focus }); }
        if (mode === captureMode) {
          await audit(page, `${language}-${width}-${mode}-stage-${stage + 1}`);
          if (stage === 0) await capture(page, `${language}-${width}-setup`, false);
          if ((language === 'en' && width === 1440 && stage === 6) || (language === 'ko' && width === 390 && stage === 4) || (language === 'es' && width === 834 && stage === 7)) await capture(page, `${language}-${width}-stage-${stage + 1}`, false);
        }
      }
      for (let stage = 6; stage >= 0; stage--) {
        const previous = rootGuide.getByRole('button', { name: t(language, 'previous'), exact: true });
        await previous.focus(); if (stage % 2) await previous.click(); else await page.keyboard.press('Enter');
        await announcement(page, rootGuide, announcementNode, language, width, mode, stage, 'previous');
      }
      for (let stage = 1; stage < 8; stage++) {
        const next = rootGuide.getByRole('button', { name: t(language, 'next'), exact: true });
        await next.focus(); if (stage % 2) await page.keyboard.press('Space'); else await next.click();
        await announcement(page, rootGuide, announcementNode, language, width, mode, stage, 'next');
      }
      await rootGuide.getByRole('navigation', { name: t(language, 'steps'), exact: true }).getByRole('button').first().click();
      await announcement(page, rootGuide, announcementNode, language, width, mode, 0, 'support-shortcut-preparation');
      const supportShortcut = rootGuide.locator('aside').getByRole('button', { name: t(language, 'help'), exact: true });
      await supportShortcut.focus(); if (mode === 'modern') await supportShortcut.click(); else await page.keyboard.press('Enter');
      await announcement(page, rootGuide, announcementNode, language, width, mode, 7, 'support-shortcut');
      assert(await supportShortcut.evaluate(el => el === document.activeElement));
    }
    assert.equal(state.ownerReads, before + 1);
    await rootGuide.getByRole('button', { name: t(language, captureMode), exact: true }).click();
    await rootGuide.getByLabel(t(language, 'search'), { exact: true }).fill(language === 'ko' ? '계정' : language === 'es' ? 'cuenta' : 'account');
    assert(await rootGuide.getByRole('button', { name: t(language, 'submit'), exact: true }).isDisabled());
    assert.equal(state.ownerReads, before + 1); assert.equal(state.mutations, 0);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert.equal(await page.getByText(state.schoolName, { exact: true }).count(), 0);
    await rootGuide.getByText(t(language, 'hidden'), { exact: true }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); assert.equal(state.ownerReads, before + 1);
    await rootGuide.getByRole('button', { name: t(language, 'load'), exact: true }).click(); await page.getByText(state.schoolName, { exact: true }).first().waitFor();
    report.checks.push(`${language}/${width}: all eight stages, all three modes, persistent localized announcements for stage/Previous/Next/support controls, native Enter/Space and pointer, no extra reads, help, privacy, explicit resume`);
    await context.close();
  }
  // Late and old-school responses cannot restore concealed facts. The second explicit read is independent.
  let { context, page } = await open('en', { width: 390, height: 1000 });
  const guide = page.locator('[data-founder-plane=school]');
  state.hold = true; await guide.getByRole('button', { name: t('en','load'), exact: true }).click(); await page.waitForFunction(() => document.querySelector('[data-founder-status]').textContent.includes('Verifying'));
  for (let i = 0; !state.settle && i < 30; i++) await page.waitForTimeout(50); assert(state.settle);
  await page.evaluate(() => window.dispatchEvent(new Event('hon:school-context-changed')));
  state.hold = false; state.schoolName = 'SYNTHETIC SCHOOL B';
  await guide.getByRole('button', { name: t('en','load'), exact: true }).click(); await page.getByText(state.schoolName, { exact: true }).first().waitFor(); state.settle(); state.settle = null; await page.waitForTimeout(100);
  assert.equal(await page.getByText('SYNTHETIC SCHOOL A', { exact: true }).count(), 0);
  state.status = 403; await guide.getByRole('button', { name: t('en','load'), exact: true }).click(); await guide.getByText(t('en','denied'), { exact: true }).waitFor(); assert.equal(await page.getByText(state.schoolName, { exact: true }).count(), 0);
  state.status = 200; await guide.getByRole('button', { name: t('en','load'), exact: true }).click(); await page.getByText(state.schoolName, { exact: true }).first().waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('hon:session-invalidated'))); assert.equal(await page.getByText(state.schoolName, { exact: true }).count(), 0);
  await context.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: 'oidc:synthetic:founder' }, session, Math.floor(Date.now() / 1000) - 43201), url: origin }]);
  await guide.getByRole('button', { name: t('en','load'), exact: true }).click(); await guide.getByText(t('en','signedout'), { exact: true }).waitFor();
  report.checks.push('mounted: late old-school response, revoked permission, session invalidation and actual expired signed session fail closed'); await context.close();
  for (const [language, width] of [['en',1440],['ko',834],['es',390]]) {
    ({ context, page } = await open(language, { width, height: 1000 }, 'hq'));
    const hq = page.locator('[data-founder-plane=hq]'), before = state.ownerReads;
    await hq.getByRole('button', { name: t(language,'hqLoad'), exact: true }).click(); await hq.getByText('SYNTHETIC HQ SCHOOL', { exact: true }).waitFor();
    assert.equal(state.ownerReads, before); await hq.getByText(t(language,'hqUnknown'), { exact: true }).waitFor();
    await hq.getByText(t(language,'hqLoaded'), { exact: true }).waitFor(); assert.equal(await hq.getByText(t(language,'loaded'), { exact: true }).count(), 0);
    await hq.getByRole('button', { name: t(language,'sample'), exact: true }).click(); await hq.getByText(t(language,'sampleBanner'), { exact: true }).waitFor();
    const directoryReads = state.hqReads;
    for (const mode of ['modern','classic','big-button']) {
      await hq.getByRole('button', { name: t(language, mode), exact: true }).click();
      assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1, 'HQ shell owns the only h1');
      assert.equal(await hq.getByRole('heading', { level: 2, name: t(language, 'hqTitle'), exact: true }).count(), 1);
      for (const key of ['evidence','help','sampleBanner']) assert.equal(await hq.getByRole('heading', { level: 3, name: t(language, key), exact: true }).count(), 1);
      for (const key of ['support','sampleSchool']) assert.equal(await hq.getByRole('heading', { level: 4, name: t(language, key), exact: true }).count(), 1);
      const invite = hq.getByRole('link', { name: t(language, 'hqInvites') + ' →', exact: true });
      await invite.evaluate(el => el.blur()); await page.mouse.move(0, 0);
      const normal = await invite.evaluate(el => getComputedStyle(el).textDecorationLine);
      await invite.hover(); const hover = await invite.evaluate(el => getComputedStyle(el).textDecorationLine);
      await invite.focus(); await page.keyboard.press('Shift'); const focused = await invite.evaluate(el => getComputedStyle(el).textDecorationLine);
      for (const value of [normal,hover,focused]) assert(value.includes('underline'), 'Invitations need a persistent non-color affordance');
      assert(await invite.evaluate(el => el === document.activeElement && el.matches(':focus-visible')));
      assert.equal(state.hqReads, directoryReads); assert.equal(state.ownerReads, before);
      report.hqAffordances.push({ language, width, mode, normal, hover, focused, hierarchy: 'shell h1 / founder h2 / sections h3 / subsections h4' });
    }
    await hq.getByRole('button', { name: t(language, 'modern'), exact: true }).click();
    await capture(page, `${language}-${width}-hq-proposal`); await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); assert.equal(await hq.getByText('SYNTHETIC HQ SCHOOL', { exact: true }).count(), 0);
    report.checks.push(`${language}/${width}: HQ directory separate from synthetic proposal, no staff fanout, unknown progress, pagehide`); await context.close();
  }
  ({ context, page } = await open('en', { width: 834, height: 1000 }, 'hq'));
  const hq = page.locator('[data-founder-plane=hq]');
  await page.evaluate(() => { window.__founderInvalidations = 0; window.addEventListener('hon:session-invalidated', () => window.__founderInvalidations++); });
  await hq.getByRole('button', { name: t('en','hqLoad'), exact: true }).click(); await hq.getByText('SYNTHETIC HQ SCHOOL', { exact: true }).waitFor();
  state.status = 403; await hq.getByRole('button', { name: t('en','hqLoad'), exact: true }).click(); await hq.getByText(t('en','hqDenied'), { exact: true }).waitFor();
  assert.equal(await hq.getByText('SYNTHETIC HQ SCHOOL', { exact: true }).count(), 0); assert.equal(await page.evaluate(() => window.__founderInvalidations), 0);
  state.status = 200; state.hold = true;
  await hq.getByRole('button', { name: t('en','hqLoad'), exact: true }).click();
  for (let i = 0; !state.settle && i < 30; i++) await page.waitForTimeout(50); assert(state.settle);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); const readsAfterHide = state.hqReads;
  state.hold = false; state.settle(); state.settle = null; await page.waitForTimeout(100);
  assert.equal(await hq.getByText('SYNTHETIC HQ SCHOOL', { exact: true }).count(), 0);
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); assert.equal(state.hqReads, readsAfterHide);
  await hq.getByRole('button', { name: t('en','hqLoad'), exact: true }).click(); await hq.getByText('SYNTHETIC HQ SCHOOL', { exact: true }).waitFor();
  await hq.getByRole('button', { name: t('en','sample'), exact: true }).click(); await hq.getByText(t('en','sampleBanner'), { exact: true }).waitFor();
  state.status = 401; await hq.getByRole('button', { name: t('en','hqLoad'), exact: true }).click(); await hq.getByText(t('en','signedout'), { exact: true }).waitFor();
  assert.equal(await hq.getByText('SYNTHETIC HQ SCHOOL', { exact: true }).count(), 0); assert.equal(await page.evaluate(() => window.__founderInvalidations), 1);
  // A synthetic design example may remain labelled as such after a denied read; it can never substitute for directory facts or progress.
  assert(await hq.getByText(t('en','hqGap'), { exact: true }).isVisible());
  await context.close(); state.status = 200;
  report.checks.push('HQ: local 403 versus global 401, pending pagehide/late response rejection, no focus auto-read, explicit fresh restoration, unknown real progress');
  assert.equal(report.stageChecks.length, 216); assert.equal(report.focusChecks.length, 27); assert.equal(report.stageAnnouncements.length, 648); assert.equal(report.hqAffordances.length, 9);
  assert.equal(state.mutations, 0); console.log(`PASS Founder Setup: ${report.checks.length} browser groups, ${report.stageChecks.length} stage/mode checks, ${report.stageAnnouncements.length} persistent stage announcements, ${report.hqAffordances.length} HQ hierarchy/link checks, ${report.focusChecks.length} keyboard focus checks, ${report.accessibility.length} zero-violation axe scans, ${report.screenshots.length} screenshots, zero consequential commands`);
} finally {
  await browser?.close(); app?.kill('SIGTERM'); api.closeAllConnections(); await new Promise(done => api.close(done));
  await writeFile(join(results, 'founder-browser-report.json'), JSON.stringify(report, null, 2) + '\n');
}
