// Actual built Next server checks. Synthetic identities/config only; no provider or database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const req = createRequire(join(root, 'package.json'));
const { issueSession, HON_SESSION_COOKIE } = await import(req.resolve('@hon/auth'));
const origin = 'http://127.0.0.1:3147';
const base = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' };
const oidc = {
  HON_AUTH_MODE: 'OIDC', HON_SESSION_JWT_SECRET: 'TEST_ONLY_STARTUP_KEY_1234567890123456789012', HON_SESSION_AUDIENCE: 'startup-test',
  HON_PUBLIC_ORIGIN: 'https://hon.example.invalid', HON_OIDC_ISSUER: 'https://identity.example.invalid',
  HON_OIDC_AUTHORIZATION_ENDPOINT: 'https://identity.example.invalid/authorize', HON_OIDC_TOKEN_ENDPOINT: 'https://identity.example.invalid/token',
  HON_OIDC_JWKS_URI: 'https://identity.example.invalid/keys', HON_OIDC_CLIENT_ID: 'synthetic-client', HON_OIDC_SCOPES: 'openid email',
  HON_OIDC_REDIRECT_URI: 'https://hon.example.invalid/auth/callback', HON_OIDC_TOKEN_ENDPOINT_AUTH_METHOD: 'none',
};
const report = { scope: 'Built Next startup + synthetic signed sessions; no provider/database', checks: [], accessibility: [], screenshots: [] };
let app;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function stop() {
  if (!app || app.exitCode !== null) { app = undefined; return; }
  const child = app;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, delay(5000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); })]);
  if (child.exitCode === null) await exited;
  app = undefined;
}
async function start(env, expectedFailure) {
  let log = '';
  app = spawn(process.execPath, [req.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', '3147'], {
    cwd: root, env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout.on('data', b => { log = (log + b).slice(-32000); });
  app.stderr.on('data', b => { log = (log + b).slice(-32000); });
  let ready = false;
  for (let i = 0; i < 100 && app.exitCode === null; i++) {
    if (!expectedFailure) {
      try { await fetch(origin + '/api/identity/readiness', { redirect: 'manual', signal: AbortSignal.timeout(500) }); ready = true; break; }
      catch { /* bounded local startup wait */ }
    }
    await delay(100);
  }
  if (expectedFailure) {
    assert.notEqual(app.exitCode, null, 'Unsafe server did not exit');
    assert.notEqual(app.exitCode, 0, 'Unsafe server exited successfully');
    assert(log.includes(expectedFailure), 'Expected sanitized startup failure code');
    assert(!/SECRET_MARKER|user:password/.test(log), 'Startup error exposed input');
    report.checks.push('refused: ' + expectedFailure);
    await stop();
  } else assert(ready, 'Expected safe server to become ready');
}
async function status(path, expected, headers = {}) {
  const response = await fetch(origin + path, { redirect: 'manual', headers, signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, expected, path);
  return response;
}
try {
  for (const [env, code] of [
    [{}, 'DEPLOYMENT_ENVIRONMENT_REQUIRED'],
    [{ HON_DEPLOYMENT_ENVIRONMENT: 'SECRET_MARKER' }, 'DEPLOYMENT_ENVIRONMENT_INVALID'],
    [{ HON_DEPLOYMENT_ENVIRONMENT: 'development' }, 'DEVELOPMENT_DEPLOYMENT_IN_PRODUCTION_SERVER'],
    [{ HON_DEPLOYMENT_ENVIRONMENT: 'production', HON_AUTH_MODE: 'MANUS_DEVELOPMENT' }, 'OIDC_AUTH_REQUIRED'],
    [{ ...oidc, HON_DEPLOYMENT_ENVIRONMENT: 'production', HON_OIDC_TOKEN_ENDPOINT: 'https://user:password@bad.example.invalid/#SECRET_MARKER' }, 'OIDC_CONFIGURATION_INVALID'],
    [{ ...oidc, HON_DEPLOYMENT_ENVIRONMENT: 'staging', HON_SESSION_JWT_SECRET: '' }, 'OIDC_CONFIGURATION_INVALID'],
  ]) await start(env, code);
  for (const deployment of ['production', 'staging']) {
    await start({ ...oidc, HON_DEPLOYMENT_ENVIRONMENT: deployment });
    const readiness = await status('/api/identity/readiness', 200);
    assert.deepEqual(await readiness.json(), { data: { mode: 'OIDC', ready: true, code: 'AUTH_READY' } });
    const login = await status('/auth/login', 307);
    assert(new URL(login.headers.get('location')).origin === 'https://identity.example.invalid');
    assert(login.headers.get('set-cookie').includes('Secure'));
    await status('/api/identity/me', 401);
    for (const route of ['/hq', '/staff/crm/leads']) {
      const gated = await status(route, 307); assert(gated.headers.get('location').endsWith('/auth/login'));
    }
    const session = { mode: 'OIDC', secret: oidc.HON_SESSION_JWT_SECRET, audience: oidc.HON_SESSION_AUDIENCE };
    const identity = { externalSubject: 'oidc:synthetic:owner', displayName: 'Synthetic owner' };
    const cookie = token => ({ cookie: `${HON_SESSION_COOKIE}=${token}` });
    const current = await status('/api/identity/me', 200, cookie(issueSession(identity, session)));
    assert.deepEqual((await current.json()).data, identity);
    await status('/api/identity/me', 401, cookie(issueSession(identity, session, Math.floor(Date.now() / 1000) - 43201)));
    await status('/api/identity/me', 401, cookie(issueSession(identity, { ...session, audience: 'other-deployment' })));
    report.checks.push(deployment + ': readiness/login without provider calls; protected routes; valid/expired/cross-audience signed sessions');
    await stop();
  }
  await start({ HON_DEPLOYMENT_ENVIRONMENT: 'preview' });
  await status('/', 200); await status('/auth/login', 503); await status('/api/identity/readiness', 503); await status('/api/identity/me', 503);
  report.checks.push('explicit unconfigured preview: references work; authentication stays unavailable');
  await stop();
  await start({ HON_DEPLOYMENT_ENVIRONMENT: 'preview', HON_AUTH_MODE: 'MANUS_DEVELOPMENT', HON_SESSION_JWT_SECRET: oidc.HON_SESSION_JWT_SECRET, HON_SESSION_AUDIENCE: 'preview-only', MANUS_PROJECT_ID: 'synthetic', MANUS_JWT_SECRET: 'TEST_ONLY_OTHER_KEY_12345678901234567890', MANUS_OAUTH_API_URL: 'https://development.example.invalid', MANUS_OAUTH_PORTAL_URL: 'https://portal.example.invalid' });
  await status('/api/identity/readiness', 200);
  assert(new URL((await status('/auth/login', 307)).headers.get('location')).origin === 'https://portal.example.invalid');
  report.checks.push('explicit development-adapter preview preserved; redirect inspected without contacting portal');
  await stop();
  // Existing mounted invitation checks cover privileged UI/retry/privacy. This adds startup-aware
  // desktop/mobile checks on the actual idle account interface, with all external browser traffic blocked.
  await start({ ...oidc, HON_DEPLOYMENT_ENVIRONMENT: 'production' });
  if (!process.env.HON_HQ_BROWSER_TOOLS || !process.env.HON_HQ_CHROME_BIN) throw new Error('Browser tools required for complete verification');
  const tools = createRequire(join(process.env.HON_HQ_BROWSER_TOOLS, 'package.json'));
  const { chromium } = tools('playwright-core');
  const axe = await readFile(tools.resolve('axe-core/axe.min.js'), 'utf8');
  const browser = await chromium.launch({ executablePath: process.env.HON_HQ_CHROME_BIN, headless: true, args: ['--no-sandbox'] });
  const results = process.env.HON_HQ_BROWSER_RESULTS;
  assert(results); await mkdir(results, { recursive: true });
  try {
    for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
      const context = await browser.newContext({ viewport, reducedMotion: 'reduce', serviceWorkers: 'block' });
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      // The page's real server session gate must pass before mounting the idle workbench.
      // This identity confers no HQ/school authority and we never click its protected-read control.
      await context.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession(
        { externalSubject: 'oidc:synthetic:startup-browser' },
        { mode: 'OIDC', secret: oidc.HON_SESSION_JWT_SECRET, audience: oidc.HON_SESSION_AUDIENCE },
      ), url: origin, httpOnly: true, sameSite: 'Lax' }]);
      const page = await context.newPage();
      await page.goto(origin + '/account/owner-invitation');
      assert.equal(page.url(), origin + '/account/owner-invitation');
      const verify = page.getByRole('button', { name: 'Verify access', exact: true });
      await verify.focus(); assert(await verify.evaluate(el => el === document.activeElement));
      assert.equal(await page.getByRole('textbox').count(), 0);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.addScriptTag({ content: axe });
      const scan = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
      assert.equal(scan.violations.length, 0, JSON.stringify(scan.violations.map(v => v.id)));
      report.accessibility.push({ name, violations: 0 });
      const screenshot = `web-startup-${name}.png`; await page.screenshot({ path: join(results, screenshot), fullPage: true }); report.screenshots.push(screenshot);
      await context.close();
    }
  } finally { await browser.close(); }
  console.log(`PASS web startup: ${report.checks.length} scenario groups; ${report.accessibility.length} zero-violation axe scans`);
} finally {
  await stop();
  if (process.env.HON_HQ_BROWSER_RESULTS) {
    await mkdir(process.env.HON_HQ_BROWSER_RESULTS, { recursive: true });
    await writeFile(join(process.env.HON_HQ_BROWSER_RESULTS, 'web-startup-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
}
