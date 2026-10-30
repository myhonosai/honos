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
const report = { sourceSha: process.env.HON_HQ_SOURCE_SHA, syntheticBrowserOnly: true, realApiDatabaseVerification: false, externalProviderCalls: 0, screenshots: [], accessibility: [], checks: [] };
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
  if (r.url === '/v1/hq/schools') { state.hqReads++; send(state.status, { directory }); return; }
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
async function capture(page, name) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Horizontal overflow');
  await page.addScriptTag({ content: axe });
  const scan = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21aa'] } }));
  report.accessibility.push({ name, violations: scan.violations.map(v => ({ id: v.id, impact: v.impact })) });
  assert.equal(scan.violations.length, 0, JSON.stringify(scan.violations.map(v => v.id)));
  await page.screenshot({ path: join(results, name + '.png'), fullPage: true }); report.screenshots.push(name + '.png');
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
    const before = state.ownerReads; await page.waitForTimeout(100); assert.equal(state.ownerReads, before);
    const load = rootGuide.getByRole('button', { name: t(language, 'load'), exact: true });
    await load.focus(); assert(await load.evaluate(el => el === document.activeElement));
    await load.click(); await page.getByText(state.schoolName, { exact: true }).first().waitFor(); assert.equal(state.ownerReads, before + 1);
    for (const mode of ['modern','classic','big-button']) { await rootGuide.getByRole('button', { name: t(language, mode), exact: true }).click(); assert.equal(await rootGuide.getAttribute('data-guide-mode'), mode); }
    assert.equal(state.ownerReads, before + 1);
    await rootGuide.getByRole('button', { name: t(language, width === 390 ? 'big-button' : width === 834 ? 'classic' : 'modern'), exact: true }).click();
    await capture(page, `${language}-${width}-setup`);
    await rootGuide.getByRole('button', { name: new RegExp(t(language, 'step7Title')) }).click();
    await rootGuide.getByLabel(t(language, 'search'), { exact: true }).fill(language === 'ko' ? '계정' : language === 'es' ? 'cuenta' : 'account');
    assert(await rootGuide.getByRole('button', { name: t(language, 'submit'), exact: true }).isDisabled());
    assert.equal(state.ownerReads, before + 1); assert.equal(state.mutations, 0);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert.equal(await page.getByText(state.schoolName, { exact: true }).count(), 0);
    await rootGuide.getByText(t(language, 'hidden'), { exact: true }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); assert.equal(state.ownerReads, before + 1);
    await rootGuide.getByRole('button', { name: t(language, 'load'), exact: true }).click(); await page.getByText(state.schoolName, { exact: true }).first().waitFor();
    report.checks.push(`${language}/${width}: explicit read, three modes without reads, saved facts, keyboard, help, privacy, explicit resume`);
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
    await hq.getByRole('button', { name: t(language,'sample'), exact: true }).click(); await hq.getByText(t(language,'sampleBanner'), { exact: true }).waitFor();
    await capture(page, `${language}-${width}-hq-proposal`); await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); assert.equal(await hq.getByText('SYNTHETIC HQ SCHOOL', { exact: true }).count(), 0);
    report.checks.push(`${language}/${width}: HQ directory separate from synthetic proposal, no staff fanout, unknown progress, pagehide`); await context.close();
  }
  assert.equal(state.mutations, 0); console.log(`PASS Founder Setup: ${report.checks.length} browser groups, ${report.accessibility.length} zero-violation axe scans, zero consequential commands`);
} finally {
  await browser?.close(); app?.kill('SIGTERM'); api.closeAllConnections(); await new Promise(done => api.close(done));
  await writeFile(join(results, 'founder-browser-report.json'), JSON.stringify(report, null, 2) + '\n');
}
