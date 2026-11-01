/** Mounted Next/Chromium proof with signed synthetic sessions and an IDs-only fixture.
 * No database/provider is used. The fixture does not prove the missing backend human-origin guard.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { issueSession, verifySession, cookieValue, HON_SESSION_COOKIE } from '@hon/auth';
import { HQ_OVERVIEW_UNAVAILABLE_REASONS, validateMyLanguagePreferenceView } from '@hon/contracts';

assert(process.env.HON_HQ_BROWSER_LOCAL === '1' || process.env.GITHUB_ACTIONS === 'true', 'Explicit isolated browser verification required.');
for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_SECRET_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) assert(!process.env[key], 'Database/provider credentials are forbidden.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireWeb = createRequire(join(root, 'package.json'));
assert(process.env.HON_HQ_BROWSER_TOOLS && process.env.HON_HQ_BROWSER_RESULTS && process.env.HON_HQ_CHROME_BIN);
const requireTools = createRequire(join(process.env.HON_HQ_BROWSER_TOOLS, 'runner.cjs'));
const { chromium } = requireTools('playwright-core');
const axe = await (await import('node:fs/promises')).readFile(requireTools.resolve('axe-core/axe.min.js'), 'utf8');
const results = process.env.HON_HQ_BROWSER_RESULTS;
await mkdir(results, { recursive: true });
const report = { sourceSha: process.env.HON_HQ_SOURCE_SHA, fixtureOnly: true, completed: false, backendHumanGuardVerified: false, checks: [], screenshots: [], accessibility: [], pageErrors: [] };
const session = { mode: 'OIDC', audience: 'hon-hq-school-create-synthetic', secret: randomBytes(32).toString('hex') };
const principalId = '10000000-0000-4000-8000-000000000001';
const receipt = { organizationId: '20000000-0000-4000-8000-000000000001', schoolId: '30000000-0000-4000-8000-000000000001', ownerRoleId: '40000000-0000-4000-8000-000000000001', replayed: false };
const directory = { schools: [{ schoolId: receipt.schoolId, organizationDisplayName: 'Private Synthetic Organization', schoolDisplayName: 'Private Synthetic School', organizationOperationalStatus: 'ACTIVE', schoolOperationalStatus: 'ACTIVE', entitlementTier: 'COMPLETE', createdAt: '2026-11-01T00:00:00.000Z' }] };
const overview = { asOf: '2026-11-01T00:00:00.000Z', callerHqRole: 'OWNER', organizationCount: 0, schoolCount: 0,
  onboarding: { availability: 'AVAILABLE', requestCount: 0, inProgressRequestCount: 0, completedRequestCount: 0 }, configuredProviderStates: { disabled: 0, configured: 0, healthy: 0, degraded: 0, unavailable: 0 }, taskProfileCount: 0,
  financialMetrics: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.financialMetrics }, aiUsage: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.aiUsage }, durableHqWork: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.durableHqWork } };
const fixtures = new Map();
const api = createServer(async (req, res) => {
  const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  try {
    let subject; try { subject = verifySession(cookieValue(req.headers.cookie, HON_SESSION_COOKIE) ?? '', session).externalSubject; } catch { send(401, {}); return; }
    const f = fixtures.get(subject); if (!f) { send(403, {}); return; }
    if (req.method === 'GET') {
      if (req.url === '/v1/hq/overview') send(200, { data: { overview: { ...overview, callerHqRole: f.role === 'HON_HQ_OPERATOR' ? 'OPERATOR' : 'OWNER' } } });
      else if (req.url === '/v1/hq/schools') { f.directoryReads++; f.directoryStarted?.(); if (f.directoryGate) await f.directoryGate; send(200, { data: { directory } }); }
      else if (req.url === '/v1/hq/session') { f.reads++; send(200, { data: { principalId: f.principalId ?? principalId, hqRole: f.role ?? 'HON_HQ_OWNER' } }); }
      else if (req.url === '/v1/me/language-preference') send(200, { data: validateMyLanguagePreferenceView({ preference: { language: 'en', version: 1, updatedAt: '2026-11-01T00:00:00.000Z' }, schoolDefault: null, effective: { language: 'en', source: 'PERSONAL' }, supportedLanguages: ['en', 'ko', 'es'] }) });
      else send(503, {});
      return;
    }
    if (req.url !== '/v1/hq/organizations' || req.method !== 'POST') { send(405, {}); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const key = req.headers['idempotency-key'];
    f.commands.push({ key, body, marker: req.headers['x-hon-human-command'] });
    f.commandStarted?.();
    if (f.mode === '401' || f.mode === '403') { send(Number(f.mode), {}); return; }
    const prior = f.requests.get(key);
    if (prior && prior !== body) { send(409, {}); return; }
    f.requests.set(key, body);
    if (f.gate) await f.gate;
    if (f.mode === 'unknown') { f.mode = 'ready'; send(503, {}); return; }
    if (f.mode === 'malformed') { send(201, { data: { ...receipt, payment: 'PAID' }, meta: { replayed: false } }); return; }
    send(prior ? 200 : 201, { data: { ...receipt, replayed: !!prior }, meta: { replayed: !!prior } });
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
async function open(name, viewport, configure = () => {}) {
  const f = { mode: 'ready', reads: 0, directoryReads: 0, commands: [], requests: new Map() }; configure(f); fixtures.set(name, f);
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: name }, session), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.goto(origin + '/hq/schools'); await page.getByRole('button', { name: 'Verify HQ-owner access', exact: true }).waitFor();
  if (!f.directoryGate) await page.locator('[data-hq-directory-facts]').getByText('Private Synthetic School', { exact: true }).waitFor();
  const panel = page.locator('[data-school-create]');
  return { context, page, panel, f };
}
async function authorize(s) {
  await s.panel.getByRole('button', { name: 'Verify HQ-owner access', exact: true }).focus();
  await s.page.keyboard.press('Enter');
  await s.panel.getByLabel('Legal organization name', { exact: true }).waitFor();
}
async function fill(s) {
  for (const [label, value] of [['Legal organization name', 'Harbor Synthetic LLC'], ['School-facing organization name', 'Harbor Synthetic'], ['First school name', 'Harbor Synthetic Main'], ['School slug', 'harbor-synthetic-main']]) await s.panel.getByLabel(label, { exact: true }).fill(value);
}
async function submit(s) {
  await s.panel.getByRole('checkbox').focus(); await s.page.keyboard.press('Space');
  await s.panel.getByRole('button', { name: 'Create school', exact: true }).focus(); await s.page.keyboard.press('Enter');
}
async function idle(s) { await s.page.waitForFunction(() => document.querySelector('[data-school-create]')?.getAttribute('data-school-create-busy') === 'false'); }
async function capture(s, name) {
  assert(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal viewport overflow');
  await s.page.addScriptTag({ content: axe });
  const violations = await s.page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(v => ({ id: v.id, impact: v.impact })));
  report.accessibility.push({ name, violations });
  assert.equal(violations.length, 0, JSON.stringify(violations));
  await s.panel.screenshot({ path: join(results, name + '.png') }); report.screenshots.push(name + '.png');
}
try {
  await new Promise((done, reject) => { const deadline = setTimeout(() => reject(new Error('Local app startup timed out.')), 30000); app.stdout.on('data', data => { if (/Ready in/.test(String(data))) { clearTimeout(deadline); done(); } }); app.once('exit', () => { clearTimeout(deadline); reject(new Error('Local app exited before ready.')); }); });
  browser = await chromium.launch({ executablePath: process.env.HON_HQ_CHROME_BIN, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  await check('Modern, Classic and Big Button at mobile/tablet/desktop preserve one product and do not read on view changes', async () => {
    const s = await open('create-presentations', { width: 1440, height: 1000 });
    await authorize(s); await fill(s);
    const reads = s.f.reads, directoryReads = s.f.directoryReads;
    for (const width of [390, 834, 1440]) {
      await s.page.setViewportSize({ width, height: 1000 });
      for (const label of ['Modern', 'Classic', 'Big Button']) {
        await s.page.getByRole('group', { name: 'Platform view', exact: true }).getByRole('button', { name: label, exact: true }).click();
        await capture(s, `create-${width}-${label.toLowerCase().replaceAll(' ', '-')}`);
      }
    }
    assert.equal(s.f.reads, reads); assert.equal(s.f.directoryReads, directoryReads); assert.equal(s.f.commands.length, 0);
    await s.context.close();
  });
  for (const [size, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const s = await open('create-' + size, viewport, f => { f.mode = 'unknown'; });
    await check(size + ': mount performs only independent directory reads and offers no creation command or tier selector', async () => {
      assert.equal(s.f.reads, 2); assert.equal(s.f.directoryReads, 1); assert.equal(s.f.commands.length, 0); assert.equal(await s.panel.locator('form,select').count(), 0); await capture(s, size + '-idle');
    });
    await authorize(s); await fill(s);
    await check(size + ': form requires confirmation and clears confirmation after edited details', async () => {
      assert(await s.panel.getByRole('button', { name: 'Create school', exact: true }).isDisabled());
      await s.panel.getByRole('checkbox').check(); await s.panel.getByLabel('First school name', { exact: true }).fill('Harbor Synthetic Main Revised');
      assert(!(await s.panel.getByRole('checkbox').isChecked())); await capture(s, size + '-form');
    });
    await submit(s); await idle(s);
    await check(size + ': unknown outcome locks details and explicit retry preserves exact payload/key', async () => {
      assert.equal(s.f.commands.length, 1); assert(await s.panel.getByLabel('Legal organization name', { exact: true }).isDisabled());
      const original = s.f.commands[0]; assert.equal(original.marker, 'hq-school-provisioning'); assert.equal(JSON.parse(original.body).initialTier, 'COMPLETE');
      await s.page.evaluate(() => window.dispatchEvent(new Event('blur')));
      assert(await s.page.locator('[data-hq-directory-facts]').evaluate(node => node.hidden && node.inert));
      assert(!(await s.page.locator('body').innerText()).includes('Private Synthetic School'));
      const directoryReads = s.f.directoryReads; await s.page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await authorize(s); assert.equal(s.f.directoryReads, directoryReads);
      await s.page.getByRole('button', { name: 'Verify and read school directory', exact: true }).click();
      await s.page.locator('[data-hq-directory-facts]').getByText('Private Synthetic School', { exact: true }).waitFor();
      assert(await s.panel.getByRole('button', { name: 'Retry exact creation request', exact: true }).isVisible());
      await s.panel.getByRole('checkbox').check(); await s.panel.getByRole('button', { name: 'Retry exact creation request', exact: true }).click();
      await s.panel.getByRole('heading', { name: 'School creation receipt', exact: true }).waitFor();
      assert.equal(s.f.commands.length, 2); assert.deepEqual(s.f.commands[1], original); assert.equal(s.f.requests.size, 1);
      assert((await s.panel.innerText()).includes('original creation request was replayed')); assert(!(await s.panel.innerText()).includes('ONBOARDING COMPLETE'));
      await capture(s, size + '-receipt');
    });
    await check(size + ': session signal removes visible receipt and details', async () => {
      await s.page.evaluate(() => window.dispatchEvent(new Event('hon:session-invalidated')));
      assert(await s.page.locator('[data-hq-directory-facts]').evaluate(node => node.hidden && node.inert));
      assert(!(await s.page.locator('body').innerText()).includes('Private Synthetic Organization'));
      assert.equal(await s.panel.getByRole('heading', { name: 'School creation receipt', exact: true }).count(), 0);
      assert.equal(await s.panel.getByText(receipt.organizationId, { exact: true }).count(), 0); assert.equal(s.f.commands.length, 2);
    });
    await s.context.close();
  }
  await check('privacy during an in-flight command cannot restore/unlock early or reveal a late receipt', async () => {
    let release; const gate = new Promise(done => { release = done; });
    let started; const commandStarted = new Promise(done => { started = done; });
    const s = await open('create-inflight', { width: 390, height: 844 }, f => { f.gate = gate; f.commandStarted = started; });
    await authorize(s); await fill(s); await submit(s); await commandStarted;
    await s.page.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert(await s.panel.getByRole('button', { name: 'Verify HQ-owner access', exact: true }).isDisabled());
    release(); await idle(s); assert.equal(await s.panel.locator('input').count(), 0); assert.equal(await s.panel.getByRole('heading', { name: 'School creation receipt', exact: true }).count(), 0);
    await authorize(s); assert(await s.panel.getByRole('button', { name: 'Retry exact creation request', exact: true }).isVisible()); assert.equal(s.f.commands.length, 1);
    await s.context.close();
  });
  for (const status of ['401', '403']) await check(status + ' command refusal conceals all form data and blocks automatic retries', async () => {
    const s = await open('create-' + status, { width: 1440, height: 1000 }, f => { f.mode = status; });
    await authorize(s); await fill(s); await submit(s); await idle(s);
    assert.equal(await s.panel.locator('input').count(), 0); assert.equal(s.f.commands.length, 1);
    if (status === '401') { assert(await s.page.locator('[data-hq-directory-facts]').evaluate(node => node.hidden && node.inert)); assert(!(await s.page.locator('body').innerText()).includes('Private Synthetic School')); }
    await s.context.close();
  });
  await check('creation 401 aborts a pending directory read and its late response cannot reveal names', async () => {
    let release; const directoryGate = new Promise(done => { release = done; });
    let started; const directoryStarted = new Promise(done => { started = done; });
    const s = await open('create-pending-directory', { width: 390, height: 844 }, f => { f.mode = '401'; f.directoryGate = directoryGate; f.directoryStarted = started; });
    await directoryStarted;
    const failedRead = s.page.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).pathname === '/api/v1/hq/schools' });
    await authorize(s); await fill(s); await submit(s); await failedRead; release(); await idle(s);
    assert(await s.page.locator('[data-hq-directory-facts]').evaluate(node => node.hidden && node.inert));
    assert(!(await s.page.locator('body').innerText()).includes('Private Synthetic School'));
    await s.context.close();
  });
  await check('an operator cannot open the owner-only creation form', async () => {
    const s = await open('create-operator', { width: 390, height: 844 }, f => { f.role = 'HON_HQ_OPERATOR'; });
    await s.panel.getByRole('button', { name: 'Verify HQ-owner access', exact: true }).click(); await idle(s);
    assert.equal(await s.panel.locator('form').count(), 0); assert.equal(s.f.commands.length, 0); await s.context.close();
  });
  assert.deepEqual(report.pageErrors, []);
  report.completed = true;
} finally {
  await writeFile(join(results, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close(); app.kill('SIGTERM'); api.closeAllConnections(); await new Promise(done => api.close(done));
}
