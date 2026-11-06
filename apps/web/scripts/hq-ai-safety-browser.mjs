/**
 * Disposable local browser proof for the HQ AI safety screen (S4-c pauses, S4-d lost outcomes). Synthetic fixtures
 * only: every /api request is answered in the browser by this script. No database, provider or payment is used.
 * Requires `pnpm build` first.
 *
 *   HON_HQ_AI_SAFETY_BROWSER_LOCAL=1 HON_HQ_AI_SAFETY_RESULTS=<dir> [HON_HQ_AI_SAFETY_AXE=<axe.min.js>] node apps/web/scripts/hq-ai-safety-browser.mjs
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
import { HQ_OVERVIEW_UNAVAILABLE_REASONS } from '@hon/contracts';

if (process.env.HON_HQ_AI_SAFETY_BROWSER_LOCAL !== '1') throw new Error('Opt in with HON_HQ_AI_SAFETY_BROWSER_LOCAL=1.');
for (const key of ['DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY']) {
  if (process.env[key]) throw new Error('Browser verification refuses inherited database/provider credentials.');
}
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = process.env.HON_HQ_AI_SAFETY_RESULTS; assert(results, 'HON_HQ_AI_SAFETY_RESULTS is required.');
const { chromium } = createRequire(import.meta.url)(process.env.HON_HQ_AI_SAFETY_PLAYWRIGHT ?? 'playwright');
await mkdir(results, { recursive: true });
const axeSource = process.env.HON_HQ_AI_SAFETY_AXE ? await readFile(process.env.HON_HQ_AI_SAFETY_AXE, 'utf8') : null;
const report = { syntheticFixturesOnly: true, databaseAccess: false, providerCalls: false, checks: [], failures: [], screenshots: [], pageErrors: [], commands: [] };
async function axeScan(page, name) {
  if (!axeSource) return;
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  const violations = result.violations.map((v) => ({ id: v.id, impact: v.impact, targets: v.nodes.slice(0, 6).map((n) => n.target.join(' ')) }));
  assert.deepEqual(violations, [], `${name}: ${JSON.stringify(violations)}`);
}

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const asOf = '2026-11-06T18:00:00.000Z';
let active = true, commandMode = 'ok', role = 'owner', reads = 0, held = null;
// Per-POST behaviours, consumed in order: 'lost' | 'timeout' (409 SAAS_OUTCOME_UNKNOWN) | 'refuse:<CODE>' (422) | 'hold' (deferred until released).
let commandQueue = [];
const pauses = () => ({ asOf, pauses: [
  ...(active ? [{ pauseId: id(11), organizationId: null, spendClass: 'CREATIVE_MEDIA', reason: 'Provider incident under review', pausedAt: asOf, pausedByPrincipalId: id(2), status: 'ACTIVE', endReason: null, endedAt: null, endedByPrincipalId: null }] : []),
  { pauseId: id(12), organizationId: id(4), spendClass: 'ALL', reason: 'Suspected abuse being checked', pausedAt: asOf, pausedByPrincipalId: id(2), status: 'ENDED', endReason: 'Checked and cleared by owner', endedAt: asOf, endedByPrincipalId: id(2) },
] });
const queue = () => ({ asOf, staleAfterSeconds: 900, resolved: [], open: [
  { agent: 'MARKETING', invocationId: id(21), organizationId: id(4), schoolId: id(6), status: 'UNKNOWN', reservedCredits: 12, heldAt: asOf, countsAgainstCurrentWindow: true },
  { agent: 'TEACHING', invocationId: id(22), organizationId: id(4), schoolId: id(6), status: 'SENDING', reservedCredits: 8, heldAt: null, countsAgainstCurrentWindow: true },
] });
// The HQ shell's own access read: a synthetic owner with no company data, so the page-level reads decide what shows.
const overview = { asOf, callerHqRole: 'OWNER', organizationCount: 0, schoolCount: 0, onboarding: { availability: 'AVAILABLE', requestCount: 0, inProgressRequestCount: 0, completedRequestCount: 0 }, configuredProviderStates: { disabled: 0, configured: 0, healthy: 0, degraded: 0, unavailable: 0 }, taskProfileCount: 0, financialMetrics: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.financialMetrics }, aiUsage: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.aiUsage }, durableHqWork: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.durableHqWork } };
const json = (route, status, body) => route.fulfill({ status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }, body: JSON.stringify(body) });
async function api(route) {
  const request = route.request(), path = new URL(request.url()).pathname;
  if (path === '/api/v1/hq/overview' && request.method() === 'GET') return json(route, 200, { data: { overview } });
  if (path.startsWith('/api/v1/hq/ai/') && request.method() === 'GET') reads += 1;
  if (path === '/api/v1/hq/ai/spend-pauses' && request.method() === 'GET') return role === 'none' ? json(route, 403, { code: 'SAAS_FORBIDDEN' }) : json(route, 200, { data: pauses() });
  if (path === '/api/v1/hq/ai/unknown-invocations' && request.method() === 'GET') return role === 'none' ? json(route, 403, { code: 'SAAS_FORBIDDEN' }) : json(route, 200, { data: queue() });
  if (request.method() === 'POST' && path.startsWith('/api/v1/hq/ai/')) {
    const headers = request.headers();
    report.commands.push({ path, command: headers['x-hon-human-command'], key: headers['idempotency-key'], body: request.postData() });
    if (commandMode === 'lost') { commandMode = 'ok'; return route.abort('failed'); }
    const next = commandQueue.shift() ?? 'ok';
    if (next === 'lost') return route.abort('failed');
    if (next === 'timeout') return json(route, 409, { code: 'SAAS_OUTCOME_UNKNOWN', detail: 'Retry the identical request with the same key; do not assume the command took effect.' });
    if (next.startsWith('refuse:')) return json(route, 422, { code: next.slice(7) });
    if (next.startsWith('hold')) { const outcome = await new Promise((release) => { held = release; }); held = null;
      if (outcome === 'timeout') return json(route, 409, { code: 'SAAS_OUTCOME_UNKNOWN' }); }
    if (role === 'reader') return json(route, 403, { code: 'SAAS_FORBIDDEN' });
    if (path === '/api/v1/hq/ai/spend-pauses') {
      const body = JSON.parse(request.postData() ?? '{}'); active = body.action === 'PAUSE';
      return json(route, 200, { data: { pauseId: id(11), organizationId: body.organizationId, spendClass: body.spendClass, status: active ? 'ACTIVE' : 'ENDED', replayed: false } });
    }
  }
  return json(route, 403, { code: 'FORBIDDEN' });
}

const probe = createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const session = { mode: 'OIDC', audience: 'hq-ai-safety-browser-synthetic', secret: randomBytes(32).toString('hex') };
const server = spawn(join(webRoot, 'node_modules/.bin/next'), ['start', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: webRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'production', HON_DEPLOYMENT_ENVIRONMENT: 'preview', NEXT_TELEMETRY_DISABLED: '1', HON_API_BASE_URL: 'http://127.0.0.1:9', HON_AUTH_MODE: session.mode, HON_SESSION_AUDIENCE: session.audience, HON_SESSION_JWT_SECRET: session.secret }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; i < 240; i += 1) { try { const r = await fetch(`${origin}/auth/login`); if (r.status < 500) break; } catch { /* starting */ } await new Promise((done) => setTimeout(done, 500)); }

const browser = await chromium.launch();
async function open(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await ctx.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: 'hq-synthetic-owner' }, session), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await ctx.route('**/*', (route) => { const url = new URL(route.request().url()); if (url.origin !== origin) return route.abort(); if (url.pathname.startsWith('/api/')) return api(route); return route.continue(); });
  const page = await ctx.newPage(); page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(`${origin}/hq/ai-safety`); return { ctx, page };
}
async function check(name, work) { try { await work(); report.checks.push(name); } catch (error) { report.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); } }
async function shot(page, name, fullPage = false) { await page.screenshot({ path: join(results, `${name}.png`), fullPage }); report.screenshots.push(`${name}.png`); }
const ready = async (page) => { try { await page.waitForSelector('[data-ai-safety="READY"] [data-ai-safety-records]', { timeout: 15000 }); } catch (error) { if (process.env.HON_HQ_AI_SAFETY_DEBUG) console.error(page.url(), await page.evaluate(() => (document.querySelector('[data-ai-safety]')?.outerHTML ?? document.querySelector('main')?.outerHTML ?? 'none').slice(0, 2500))); throw error; } };

for (const [size, viewport] of Object.entries({ desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } })) {
  await check(`records render with axe (${size})`, async () => {
    active = true; role = 'owner'; const { ctx, page } = await open(viewport); await ready(page);
    assert.equal(await page.locator('[data-pause]').count(), 1); assert.equal(await page.locator('[data-unknown]').count(), 2);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, 'no sideways scroll');
    await axeScan(page, `ai-safety-${size}`); await shot(page, `hq-ai-safety-${size}`, true); await ctx.close();
  });
}
await check('pause requires confirmation and sends one contract-shaped command, then re-reads', async () => {
  active = false; role = 'owner'; report.commands = []; const { ctx, page } = await open({ width: 1440, height: 900 }); await ready(page);
  const pause = page.getByRole('group', { name: 'Pause new AI work' });
  await pause.getByLabel('Reason (10–500 characters)').fill('Provider incident in progress');
  assert.equal(await pause.getByRole('button', { name: 'Pause' }).isDisabled(), true, 'pause needs explicit confirmation');
  await pause.getByRole('checkbox').check(); await pause.getByRole('button', { name: 'Pause' }).click();
  await page.waitForSelector('[data-pause]');
  assert.equal(report.commands.length, 1);
  assert.deepEqual(JSON.parse(report.commands[0].body), { action: 'PAUSE', organizationId: null, spendClass: 'ALL', reason: 'Provider incident in progress' });
  assert.equal(report.commands[0].command, 'ai-spend-pause'); await ctx.close();
});
await check('a lost response keeps the exact request; retry resends the same body and key', async () => {
  active = true; role = 'owner'; report.commands = []; commandMode = 'lost'; const { ctx, page } = await open({ width: 1440, height: 900 }); await ready(page);
  await page.locator('[data-pause] textarea').fill('Provider incident resolved');
  await page.locator('[data-pause]').getByRole('button', { name: 'Resume' }).click();
  await page.waitForSelector('[data-pending="UNKNOWN"]'); await shot(page, 'hq-ai-safety-unknown-outcome');
  assert.equal(await page.locator('[data-ai-safety-records] fieldset[disabled]').count() > 0, true, 'controls lock while the outcome is unknown');
  await page.getByRole('button', { name: 'Retry the same request' }).click(); await page.waitForSelector('[data-pending]', { state: 'detached' });
  assert.equal(report.commands.length, 2);
  assert.equal(report.commands[0].key, report.commands[1].key); assert.equal(report.commands[0].body, report.commands[1].body); await ctx.close();
});
const hideTab = (page) => page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange'));
  return [...document.querySelectorAll('[data-ai-safety-records],[data-ai-safety-private]')].every((node) => node.hidden && node.inert); });
const showTab = (page) => page.evaluate(() => { delete document.visibilityState; });
const waitHeld = async () => { for (let i = 0; i < 100 && !held; i += 1) await new Promise((done) => setTimeout(done, 50)); assert(held, 'command reached the fixture'); };
for (const outcome of ['success', 'timeout']) {
  await check(`a pending command settling (${outcome}) after concealment never repaints records; only an explicit refresh does`, async () => {
    active = true; role = 'owner'; report.commands = []; commandQueue = ['hold']; const { ctx, page } = await open({ width: 1440, height: 900 }); await ready(page);
    await page.locator('[data-pause] textarea').fill('Provider incident resolved');
    await page.locator('[data-pause]').getByRole('button', { name: 'Resume' }).click(); await page.waitForSelector('[data-pending="SENDING"]'); await waitHeld();
    assert.equal(await hideTab(page), true, 'records and request label hidden in the event handler'); await page.waitForSelector('[data-ai-safety="CONCEALED"]');
    const before = reads; held(outcome === 'success' ? 'ok' : 'timeout');
    await page.waitForTimeout(800);
    assert.equal(await page.locator('[data-ai-safety]').getAttribute('data-ai-safety'), 'CONCEALED');
    assert.equal(reads, before, 'no re-read after the command settled'); assert.equal(await page.locator('[data-ai-safety-records]').count(), 0);
    assert.equal(await page.getByText('Provider incident under review').count(), 0); assert.equal(await page.getByText(/Resume creative studio media/i).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Retry the same request' }).count(), 0);
    await showTab(page);
    await page.locator('[data-ai-safety] section[role="status"]').getByRole('button', { name: 'Refresh', exact: true }).click(); await ready(page);
    if (outcome === 'success') { assert.equal(await page.locator('[data-pending]').count(), 0); assert.match(await page.locator('[role="status"]').first().textContent(), /recorded/); }
    else { await page.waitForSelector('[data-pending="UNKNOWN"]'); await page.getByRole('button', { name: 'Retry the same request' }).click(); await page.waitForSelector('[data-pending]', { state: 'detached' });
      assert.equal(report.commands.length, 2); assert.equal(report.commands[0].key, report.commands[1].key); assert.equal(report.commands[0].body, report.commands[1].body); }
    await ctx.close();
  });
}
await check('lost success, then a 409 outcome-unknown timeout, then recovery all reuse the exact request', async () => {
  active = true; role = 'owner'; report.commands = []; commandQueue = ['lost', 'timeout', 'ok']; const { ctx, page } = await open({ width: 1440, height: 900 }); await ready(page);
  await page.locator('[data-pause] textarea').fill('Provider incident resolved');
  await page.locator('[data-pause]').getByRole('button', { name: 'Resume' }).click(); await page.waitForSelector('[data-pending="UNKNOWN"]');
  await page.getByRole('button', { name: 'Retry the same request' }).click(); await page.waitForSelector('[data-pending="SENDING"]', { state: 'detached' }); await page.waitForSelector('[data-pending="UNKNOWN"]');
  await page.getByRole('button', { name: 'Retry the same request' }).click(); await page.waitForSelector('[data-pending]', { state: 'detached' });
  assert.equal(report.commands.length, 3); assert.equal(new Set(report.commands.map((c) => c.key)).size, 1); assert.equal(new Set(report.commands.map((c) => c.body)).size, 1); await ctx.close();
});
await check('a 422 rule refusal is definitive: no outcome-recovery retry, only a refresh', async () => {
  active = true; role = 'owner'; report.commands = []; commandQueue = ['refuse:AI_SPEND_PAUSE_NOT_ACTIVE']; const { ctx, page } = await open({ width: 1440, height: 900 }); await ready(page);
  await page.locator('[data-pause] textarea').fill('Provider incident resolved');
  await page.locator('[data-pause]').getByRole('button', { name: 'Resume' }).click(); await page.waitForSelector('[data-pending="REFUSED"]');
  assert.equal(await page.getByRole('button', { name: 'Retry the same request' }).count(), 0); assert.match(await page.locator('[data-pending]').textContent(), /no longer active/);
  const before = reads; await page.getByRole('button', { name: 'Refresh records' }).click(); await ready(page); assert.equal(reads > before, true); assert.equal(report.commands.length, 1); await ctx.close();
});
await check('a billing reader is told only an HQ owner may act', async () => {
  active = true; role = 'reader'; const { ctx, page } = await open({ width: 1440, height: 900 }); await ready(page);
  await page.locator('[data-unknown]').first().getByRole('button', { name: 'Resolve' }).click();
  await page.getByLabel('Provider lookup reference').fill('lookup-123'); await page.getByLabel('Reason (10–500 characters)').last().fill('Checked the provider usage page');
  await page.getByRole('button', { name: 'Record resolution' }).click();
  await page.waitForSelector('[data-pending="FORBIDDEN"]'); assert.match(await page.locator('[data-pending]').textContent(), /Only a human HQ owner/); await ctx.close();
});
await check('blur and a hidden tab conceal the records at once; refresh re-reads', async () => {
  active = true; role = 'owner'; const { ctx, page } = await open({ width: 1440, height: 900 }); await ready(page);
  const hiddenNow = await page.evaluate(() => { window.dispatchEvent(new Event('blur')); return [...document.querySelectorAll('[data-ai-safety-records]')].every((node) => node.hidden && node.inert); });
  assert.equal(hiddenNow, true); await page.waitForSelector('[data-ai-safety="CONCEALED"]');
  assert.equal(await page.getByText('Provider incident under review').count(), 0);
  await page.locator('[data-ai-safety] section[role="status"]').getByRole('button', { name: 'Refresh', exact: true }).click(); await ready(page);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); delete document.visibilityState; });
  await page.waitForSelector('[data-ai-safety="CONCEALED"]'); await ctx.close();
});
await check('no HQ billing access shows nothing in place of the records', async () => {
  role = 'none'; const { ctx, page } = await open({ width: 1440, height: 900 }); await page.waitForSelector('[data-ai-safety="FORBIDDEN"]');
  assert.equal(await page.locator('[data-ai-safety-records]').count(), 0); role = 'owner'; await ctx.close();
});

await browser.close(); server.kill('SIGTERM');
report.pageErrors = [...new Set(report.pageErrors)];
await writeFile(join(results, 'hq-ai-safety-browser-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ checks: report.checks.length, failures: report.failures, pageErrors: report.pageErrors.slice(0, 5) }, null, 2));
if (report.failures.length || report.pageErrors.length) { console.error(serverLog.slice(-3000)); process.exitCode = 1; }
