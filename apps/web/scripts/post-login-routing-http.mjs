import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { issueSession, verifySession, cookieValue, HON_SESSION_COOKIE } from '@hon/auth';

assert(process.env.GITHUB_ACTIONS === 'true' || process.env.HON_POST_LOGIN_HTTP_LOCAL === '1');
const root = process.cwd();
const config = { mode: 'OIDC', audience: 'post-login-local-synthetic', secret: randomBytes(32).toString('hex') };
const id = '00000000-0000-4000-8000-000000000001';
const requests = [];
const api = createServer((request, response) => {
  let identity;
  try { identity = verifySession(cookieValue(request.headers.cookie, HON_SESSION_COOKIE) ?? '', config); }
  catch { response.writeHead(401); response.end(); return; }
  assert(!request.headers['x-hon-role'] && !request.headers['x-school-id'], 'Do not forward request role/school headers.');
  assert(!request.headers.cookie.includes('unrelated'), 'Do not forward unrelated cookies.');
  requests.push({ path: request.url, subject: identity.externalSubject });
  let status = 200, data;
  if (request.url === '/v1/hq/session') {
    if (identity.externalSubject === 'hq') data = { principalId: id, hqRole: 'HON_HQ_OWNER' };
    else status = 403;
  } else if (request.url === '/v1/staff/current-reporting-school') {
    if (identity.externalSubject === 'staff') data = { state: 'RESOLVED', organizationId: id, schoolId: id };
    else if (identity.externalSubject === 'unavailable') status = 503;
    else data = { state: 'MANUAL_ENTRY_REQUIRED' };
  } else if (request.url === '/v1/staff/reporting-schools') { data = { state: 'MANUAL_ENTRY_REQUIRED' }; } else { status = 404; }
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
  response.end(JSON.stringify({ data }));
});
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
const apiOrigin = `http://127.0.0.1:${api.address().port}`;
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const appPort = probe.address().port; await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${appPort}`;
const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(appPort)], {
  cwd: root, env: { PATH: process.env.PATH, NODE_ENV: 'production', HON_DEPLOYMENT_ENVIRONMENT: 'preview', NEXT_TELEMETRY_DISABLED: '1', HON_AUTH_MODE: config.mode, HON_SESSION_AUDIENCE: config.audience, HON_SESSION_JWT_SECRET: config.secret, HON_API_BASE_URL: apiOrigin }, stdio: ['ignore','pipe','pipe'],
});
let log = ''; app.stdout.on('data', b => { log = (log + b).slice(-8000); }); app.stderr.on('data', b => { log = (log + b).slice(-8000); });
const cookie = subject => `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: subject, displayName: 'PRIVATE_LOCAL_CANARY' }, config)}; unrelated=PRIVATE_COOKIE_CANARY`;
let checks = 0, browser;
const browserChecks = [];
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${origin}/auth/continue`, { redirect: 'manual' }); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert(ready, 'Production Next server did not start.');
  for (const [subject, expected, count] of [['hq','/hq',1],['staff','/staff/entry',2],['guardian','/auth/access',3],['unknown','/auth/access',3],['unavailable','/auth/access',2]]) {
    const before = requests.length;
    const response = await fetch(`${origin}/auth/continue`, { headers: { Cookie: cookie(subject), 'x-hon-role': 'HON_HQ_OWNER', 'x-school-id': id }, redirect: 'manual' });
    assert.equal(response.status, 303); assert.equal(response.headers.get('location'), expected);
    assert.equal(await response.text(), ''); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(requests.length - before, count); checks++;
  }
  const before = requests.length;
  const invalid = await fetch(`${origin}/auth/continue`, { headers: { Cookie: 'hon_session=FORGED' }, redirect: 'manual' });
  assert.equal(invalid.headers.get('location'), '/auth/login');
  const selectors = await fetch(`${origin}/auth/continue?returnTo=https://evil.example&role=HON_HQ_OWNER`, { headers: { Cookie: cookie('hq') }, redirect: 'manual' });
  assert.equal(selectors.headers.get('location'), '/auth/access'); assert.equal(requests.length, before); checks += 2;
  const neutral = await fetch(`${origin}/auth/access`, { headers: { Cookie: cookie('guardian') }, redirect: 'manual' });
  assert.equal(neutral.status, 200);
  const html = await neutral.text(); assert(html.includes('Access not verified')); assert(!html.includes('PRIVATE_LOCAL_CANARY'));
  for (const path of ['/hq','/staff/entry','/parent','/auth/continue']) assert(html.includes(`href="${path}"`));
  assert.equal(requests.length, before); checks++;
  const signedout = await fetch(`${origin}/auth/access`, { redirect: 'manual' });
  assert.equal(signedout.status, 307); assert.equal(signedout.headers.get('location'), '/auth/login'); checks++;
  if (process.env.HON_POST_LOGIN_BROWSER_TOOLS) {
    const tools = createRequire(join(process.env.HON_POST_LOGIN_BROWSER_TOOLS, 'runner.cjs'));
    const { chromium } = tools('playwright-core');
    const axe = await readFile(tools.resolve('axe-core/axe.min.js'), 'utf8');
    const results = process.env.HON_POST_LOGIN_BROWSER_RESULTS;
    assert(results && process.env.HON_POST_LOGIN_CHROME_BIN, 'Browser tools require isolated output and Chrome.');
    await mkdir(results, { recursive: true });
    browser = await chromium.launch({ executablePath: process.env.HON_POST_LOGIN_CHROME_BIN, headless: true, args: ['--no-sandbox'] });
    for (const width of [390,834,1440]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
      await context.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: 'guardian' }, config), url: origin, httpOnly: true, sameSite: 'Lax' }]);
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      // Shared presentation preference only; no role/domain API response is replaced in the browser.
      await context.route('**/api/v1/me/language-preference', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { preference: { language: 'en', version: 1, updatedAt: '2026-11-01T00:00:00.000Z' }, schoolDefault: null, effective: { language: 'en', source: 'PERSONAL' }, supportedLanguages: ['en','ko','es'] } }) }));
      const page = await context.newPage(), before = requests.length;
      await page.goto(`${origin}/auth/access`);
      await page.getByRole('heading', { name: 'Access not verified', exact: true }).waitFor();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Neutral page must not overflow.');
      for (const path of ['/hq','/staff/entry','/parent','/auth/continue','/auth/login']) {
        const link = page.locator(`main a[href="${path}"]`);
        await link.focus(); await page.keyboard.press('Shift');
        assert(await link.evaluate(el => el === document.activeElement && el.matches(':focus-visible') && parseFloat(getComputedStyle(el).outlineWidth) >= 2), 'Workspace links need visible keyboard focus.');
        assert((await link.boundingBox()).height >= 44, 'Workspace links need touch targets.');
      }
      assert.equal(requests.length, before, 'Opening the neutral page must not probe role or parent-content APIs.');
      await page.addScriptTag({ content: axe });
      const scan = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21aa'] } }));
      await page.screenshot({ path: join(results, `access-not-verified-${width}.png`), fullPage: true });
      browserChecks.push({ width, keyboardLinks: 5, overflow: false, axeViolations: scan.violations.length, violations: scan.violations.map(v => ({ id: v.id, impact: v.impact, targets: v.nodes.map(n => n.target) })) });
      await writeFile(join(results, 'post-login-browser-report.json'), JSON.stringify({ sourceSha: process.env.HON_POST_LOGIN_SOURCE_SHA ?? null, syntheticApiOnly: true, realApiDatabaseProof: false, browserChecks }, null, 2) + '\n');
      assert.equal(scan.violations.length, 0, 'Neutral page accessibility scan must pass.');
      await context.close();
    }
  }
  assert(requests.every(r => ['/v1/hq/session','/v1/staff/current-reporting-school','/v1/staff/reporting-schools'].includes(r.path)), 'Only the three permitted APIs may be probed.');
  console.log(JSON.stringify({ sourceSha: process.env.HON_POST_LOGIN_SOURCE_SHA ?? null, passed: true, checks, protectedReads: requests.length, actualProductionNext: true, signedSyntheticSessions: true, syntheticApiOnly: true, realApiDatabaseProof: false, browserChecks, parentContentProbes: 0, providerCalls: 0 }));
} finally {
  await browser?.close();
  app.kill('SIGTERM'); api.closeAllConnections(); await new Promise(resolve => api.close(resolve));
}
