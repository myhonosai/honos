/** Mounted Next/Chromium proof of the HQ business numbers page (B-HQ-3) with signed synthetic sessions and a fixture API.
 * No database or provider is used. Database authority and every count are proven by test-hq-business-numbers.mjs.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { issueSession, verifySession, cookieValue, HON_SESSION_COOKIE } from '@hon/auth';
import { HQ_OVERVIEW_UNAVAILABLE_REASONS, validateHqBusinessNumbers, validateMyLanguagePreferenceView } from '@hon/contracts';
import { DEFAULT_LOCALE, localeCookieName } from '@hon/design-system';

assert(process.env.HON_HQ_BROWSER_LOCAL === '1' || process.env.GITHUB_ACTIONS === 'true', 'Explicit isolated browser verification required.');
for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_SECRET_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) assert(!process.env[key], 'Database/provider credentials are forbidden.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireWeb = createRequire(join(root, 'package.json'));
const ts = requireWeb('typescript');
const copyCode = ts.transpileModule(await readFile(join(root, 'src/components/hq-business-numbers/copy.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { businessText } = await import('data:text/javascript;base64,' + Buffer.from(copyCode).toString('base64'));
assert(process.env.HON_HQ_BROWSER_TOOLS && process.env.HON_HQ_BROWSER_RESULTS && process.env.HON_HQ_CHROME_BIN);
const requireTools = createRequire(join(process.env.HON_HQ_BROWSER_TOOLS, 'runner.cjs'));
const { chromium } = requireTools('playwright-core');
const axe = await readFile(requireTools.resolve('axe-core/axe.min.js'), 'utf8');
const results = join(process.env.HON_HQ_BROWSER_RESULTS, 'hq-business-numbers');
await mkdir(results, { recursive: true });
const report = { sourceSha: process.env.HON_HQ_SOURCE_SHA, fixtureOnly: true, completed: false, checks: [], screenshots: [], accessibility: [], pageErrors: [] };
const session = { mode: 'OIDC', audience: 'hon-hq-business-synthetic', secret: randomBytes(32).toString('hex') };
const T0 = '2026-11-13T00:00:00.000Z';
const overview = { asOf: T0, callerHqRole: 'OWNER', organizationCount: 0, schoolCount: 0,
  onboarding: { availability: 'AVAILABLE', requestCount: 0, inProgressRequestCount: 0, completedRequestCount: 0 }, configuredProviderStates: { disabled: 0, configured: 0, healthy: 0, degraded: 0, unavailable: 0 }, taskProfileCount: 0,
  financialMetrics: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.financialMetrics }, aiUsage: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.aiUsage }, durableHqWork: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.durableHqWork } };

/** Synthetic totals that agree with each other, as the contract requires. Months end with November 2026 (to date). */
const numbers = n => validateHqBusinessNumbers({
  current: { mrrMinor: 1290300, arrMinor: 15483600, payingSchools: 61, payingByInterval: { MONTHLY: 49, ANNUAL: 12 }, payingBySource: { SCHEDULE_BINDING: 40, V1_SUBSCRIPTION: 21 },
    unpricedActiveRecords: 1, lifetimeSchools: 8, bindingsNeedingReview: 2, suspendedSubscriptions: 3, activeTrials: 14 },
  months: Array.from({ length: n }, (_, i) => ({ month: new Date(Date.UTC(2026, 10 - (n - 1) + i, 1)).toISOString().slice(0, 7), monthToDate: i === n - 1,
    newSchools: 10 + i, publicSignups: 8 + i, trialsStarted: 6 + i, newPayingSchools: 5 + i, trialConversions: 3 + (i % 3), stoppedPayingSchools: i % 2 })),
  monthsRequested: n, currency: 'USD', chargesEnabled: false, churnRateAvailable: false, asOf: T0 });

const fixtures = new Map();
const api = createServer(async (req, res) => {
  const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  try {
    let subject; try { subject = verifySession(cookieValue(req.headers.cookie, HON_SESSION_COOKIE) ?? '', session).externalSubject; } catch { send(401, {}); return; }
    const f = fixtures.get(subject); if (!f) { send(403, {}); return; }
    const url = new URL(req.url, 'http://fixture'), path = url.pathname;
    if (req.method !== 'GET') { send(405, {}); return; }
    if (path === '/v1/hq/overview') send(200, { data: { overview } });
    else if (path === '/v1/hq/session') send(200, { data: { principalId: '10000000-0000-4000-8000-000000000001', hqRole: 'HON_HQ_OWNER' } });
    else if (path === '/v1/me/language-preference') send(200, { data: validateMyLanguagePreferenceView({ preference: { language: f.language, version: 1, updatedAt: T0 }, schoolDefault: null, effective: { language: f.language, source: 'PERSONAL' }, supportedLanguages: ['en', 'ko', 'es'] }) });
    else if (path === '/v1/hq/saas/business-numbers') {
      f.reads.push(req.url);
      if (f.denied) { send(403, { code: 'SAAS_FORBIDDEN' }); return; }
      send(200, { data: numbers(Number(url.searchParams.get('months') ?? 6)) });
    } else send(503, {});
  } catch { if (!res.headersSent) send(503, {}); }
});
const listen = (server, port) => new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
await listen(api, 3001);
const probe = createServer(); await listen(probe, 0); const port = probe.address().port; await new Promise(done => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const app = spawn(process.execPath, [requireWeb.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'production', HON_DEPLOYMENT_ENVIRONMENT: 'preview', NEXT_TELEMETRY_DISABLED: '1', HON_API_BASE_URL: 'http://127.0.0.1:3001', HON_AUTH_MODE: session.mode, HON_SESSION_AUDIENCE: session.audience, HON_SESSION_JWT_SECRET: session.secret }, stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
const check = async (name, run) => { await run(); report.checks.push(name); console.log('PASS ' + name); };
const t = (key, language = 'en', vars) => businessText(language, key, vars);
async function open(name, viewport, configure = () => {}, language = 'en', path = '/hq/revenue/business-numbers') {
  const f = { language, reads: [], denied: false }; configure(f); fixtures.set(name, f);
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const scope = createHmac('sha256', session.secret).update(JSON.stringify(['hon-local-presentation-v1', session.mode, session.audience, name])).digest('hex');
  await context.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: name }, session), url: origin, httpOnly: true, sameSite: 'Lax' },
    { name: localeCookieName(scope), value: encodeURIComponent(JSON.stringify({ ...DEFAULT_LOCALE, language })), url: origin, sameSite: 'Lax' }]);
  const page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.goto(origin + path);
  return { context, page, f, language };
}
const ready = s => s.page.locator('[data-hq-business="ready"]').waitFor();
async function capture(s, name, selector) {
  assert(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal viewport overflow');
  await s.page.addScriptTag({ content: axe });
  const violations = await s.page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(v => ({ id: v.id, impact: v.impact, targets: v.nodes.map(n => n.target) })));
  report.accessibility.push({ name, violations });
  assert.equal(violations.length, 0, JSON.stringify(violations));
  await s.page.locator(selector).screenshot({ path: join(results, name + '.png') }); report.screenshots.push(name + '.png');
}

try {
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Next did not start')), 60000);
    app.stdout.on('data', chunk => { if (String(chunk).includes('Ready')) { clearTimeout(timer); done(); } });
    app.once('exit', code => reject(new Error('Next exited ' + code)));
  });
  browser = await chromium.launch({ executablePath: process.env.HON_HQ_CHROME_BIN, headless: true, args: ['--no-sandbox'] });

  await check('the page shows list-price MRR/ARR, paying schools, monthly flows and the test-mode and no-churn notes (desktop and 390px)', async () => {
    for (const [name, viewport] of [['business-desktop', { width: 1280, height: 900 }], ['business-mobile', { width: 390, height: 844 }]]) {
      const s = await open(name, viewport); await ready(s);
      assert.equal(s.f.reads[0], '/v1/hq/saas/business-numbers?months=6');
      const root = s.page.locator('[data-hq-business]');
      const text = await root.innerText();
      for (const expected of [t('testMode'), '$12,903.00', '$154,836.00', t('payingSplit', 'en', { monthly: '49', annual: '12' }), t('noChurn'), 'Nov 2026 (to date)']) assert(text.includes(expected), expected);
      assert.equal(await root.locator('[data-business-month]').count(), 6);
      assert.equal(await root.locator('[data-business-month]').first().getAttribute('data-business-month'), '2026-11');
      await capture(s, name, '[data-hq-business]'); await s.context.close();
    }
  });
  await check('choosing 12 months reads again with that count and shows twelve months', async () => {
    const s = await open('business-12', { width: 1280, height: 900 }); await ready(s);
    await s.page.getByRole('button', { name: t('months', 'en', { n: '12' }), exact: true }).click();
    await s.page.locator('[data-business-month]').nth(11).waitFor();
    assert.equal(s.f.reads.at(-1), '/v1/hq/saas/business-numbers?months=12');
    assert.equal(await s.page.getByRole('button', { name: t('months', 'en', { n: '12' }), exact: true }).getAttribute('aria-pressed'), 'true');
    await s.context.close();
  });
  await check('leaving the tab hides the numbers; Show again reads fresh', async () => {
    const s = await open('business-conceal', { width: 1280, height: 900 }); await ready(s);
    const reads = s.f.reads.length;
    await s.page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await s.page.locator('[data-hq-business="concealed"]').waitFor();
    assert(!(await s.page.locator('body').innerText()).includes('$12,903.00'));
    await s.page.getByRole('button', { name: t('reveal'), exact: true }).click(); await ready(s);
    assert(s.f.reads.length > reads); await s.context.close();
  });
  await check('a person without business-numbers access sees nothing', async () => {
    const s = await open('business-denied', { width: 390, height: 844 }, f => { f.denied = true; });
    await s.page.locator('[data-hq-business="denied"]').waitFor();
    assert(!(await s.page.locator('body').innerText()).includes('$12,903.00')); await s.context.close();
  });
  await check('the Korean and Spanish pages render without overflow', async () => {
    for (const language of ['ko', 'es']) {
      const s = await open('business-' + language, { width: 390, height: 844 }, () => {}, language); await ready(s);
      await s.page.locator('[data-hq-business]').getByRole('heading', { name: t('title', language), exact: true }).waitFor();
      await capture(s, `business-${language}-mobile`, '[data-hq-business]'); await s.context.close();
    }
  });
  assert.deepEqual(report.pageErrors, []);
  report.completed = true;
} finally {
  await writeFile(join(results, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close(); app.kill('SIGTERM'); api.closeAllConnections(); await new Promise(done => api.close(done));
}
