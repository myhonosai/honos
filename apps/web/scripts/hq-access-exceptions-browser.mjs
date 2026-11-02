/** Actual Next UI; signed synthetic sessions and validated synthetic API fixtures. No database or provider evidence. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { issueSession, verifySession, cookieValue, HON_SESSION_COOKIE } from '@hon/auth';
import { HQ_OVERVIEW_UNAVAILABLE_REASONS, SAAS_COMMANDS, LANGUAGE_COMMANDS, validateLanguageUpdateInput,
  validateMyLanguagePreferenceView, validateMyLanguagePreferenceReceipt } from '@hon/contracts';
import { translate } from '@hon/design-system';
import { createExceptionFixture, target, ownerId, otherOwnerId } from './fixtures/hq-access-exceptions.mjs';

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run only on the disposable CI runner');
for (const key of Object.keys(process.env)) {
  if (/^(?:DATABASE_URL|HON_RUNTIME_DATABASE_URL|PGHOST|PGPORT|PGUSER|PGPASSWORD|PGDATABASE)$/.test(key)
    || /^(?:SUPABASE|STRIPE|SQUARE|OPENAI|ANTHROPIC|OPENROUTER|TWILIO|SENDGRID|HEYGEN|HIGGSFIELD|DIRECT_LLM_API)_.*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/.test(key)) assert(!process.env[key], 'No database/provider credentials allowed: ' + key);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), tools = process.env.HON_HQ_BROWSER_TOOLS, results = process.env.HON_HQ_BROWSER_RESULTS;
assert(tools && results && process.env.HON_HQ_CHROME_BIN); assert.match(process.env.HON_HQ_SOURCE_SHA ?? '', /^[0-9a-f]{40}$/);
const requireTools = createRequire(join(tools, 'runner.cjs')), requireWeb = createRequire(join(root, 'package.json'));
const { chromium } = requireTools('playwright-core'), axe = await readFile(requireTools.resolve('axe-core/axe.min.js'), 'utf8');
const catalog = requireWeb('typescript').transpileModule(await readFile(join(root, 'src/components/hq-access-exceptions/catalog.ts'), 'utf8'), { compilerOptions: { module: requireWeb('typescript').ModuleKind.ESNext } }).outputText;
const { exceptionText } = await import('data:text/javascript;base64,' + Buffer.from(catalog).toString('base64'));
await mkdir(results, { recursive: true });
const report = { sourceSha: process.env.HON_HQ_SOURCE_SHA, evidence: 'SYNTHETIC_BROWSER_CONTRACT_FIXTURE', fixtureOnly: true, apiMocked: true, databaseConnected: false,
  providerCalls: 0, policyApprovalRecorded: false, financialActions: false, checks: [], failures: [], screenshots: [], accessibility: [], requests: [], pageErrors: [], blockedExternalRequests: [] };
const session = { mode: 'OIDC', audience: 'hon-access-exceptions-browser-synthetic', secret: randomBytes(32).toString('hex') };
const probe = createServer(); await new Promise((yes, no) => { probe.once('error', no); probe.listen(0, '127.0.0.1', yes); });
const port = probe.address().port; await new Promise(done => probe.close(done)); const origin = `http://127.0.0.1:${port}`;
const subjects = new Map(); let sequence = 0, browser, app, log = '';
const overview = role => ({ asOf: new Date().toISOString(), callerHqRole: role, organizationCount: 0, schoolCount: 0,
  onboarding: { availability: 'AVAILABLE', requestCount: 0, inProgressRequestCount: 0, completedRequestCount: 0 }, configuredProviderStates: { disabled: 0, configured: 0, healthy: 0, degraded: 0, unavailable: 0 }, taskProfileCount: 0,
  financialMetrics: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.financialMetrics }, aiUsage: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.aiUsage },
  durableHqWork: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.durableHqWork } });
async function body(req) { let raw = ''; for await (const chunk of req) { raw += chunk; assert(raw.length <= 100000); } return raw; }
const api = createServer(async (req, res) => {
  const send = (status, data, error = false) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }); res.end(JSON.stringify(error ? { code: data } : { data })); };
  let subject;
  try { subject = verifySession(cookieValue(req.headers.cookie, HON_SESSION_COOKIE) ?? '', session).externalSubject; }
  catch { report.requests.push({ method: req.method, path: req.url, subject: null }); send(401, 'UNAUTHORIZED', true); return; }
  report.requests.push({ method: req.method, path: req.url, subject });
  const state = subjects.get(subject);
  try {
    if (!state) { send(403, 'FORBIDDEN', true); return; }
    if (req.url === '/v1/identity/me' && req.method === 'GET') { send(200, { externalSubject: subject }); return; }
    if (req.url === '/v1/me/language-preference') {
      if (state.languageStatus) { send(state.languageStatus, 'UNAUTHORIZED', true); return; }
      if (req.method === 'POST') {
        assert.equal(req.headers['x-hon-human-command'], LANGUAGE_COMMANDS.updateMyLanguage); assert(req.headers['idempotency-key']);
        const input = validateLanguageUpdateInput(JSON.parse(await body(req))); assert.equal(input.expectedVersion, state.preference.version);
        state.preference = { language: input.language, version: input.expectedVersion + 1, updatedAt: new Date().toISOString() };
        send(200, validateMyLanguagePreferenceReceipt({ preference: state.preference, replayed: false }));
      } else { assert.equal(req.method, 'GET'); send(200, validateMyLanguagePreferenceView({ preference: state.preference, schoolDefault: null,
        effective: { language: state.preference.language, source: 'PERSONAL' }, supportedLanguages: ['en', 'ko', 'es'] })); }
      return;
    }
    if (req.url === '/v1/hq/overview' && req.method === 'GET') { send(state.role === 'school' ? 403 : 200, state.role === 'school' ? 'FORBIDDEN' : { overview: overview(state.role === 'owner' ? 'OWNER' : 'OPERATOR') }, state.role === 'school'); return; }
    if (state.sessionStatus) { send(state.sessionStatus, 'FORBIDDEN', true); return; }
    if (req.url === '/v1/hq/session' && req.method === 'GET') { send(200, { principalId: state.principalId, hqRole: state.role === 'owner' ? 'HON_HQ_OWNER' : 'HON_HQ_OPERATOR' }); return; }
    if (state.role !== 'owner') { send(403, 'FORBIDDEN', true); return; }
    const base = `/v1/hq/saas/organizations/${target.organizationId}`;
    if (req.method === 'GET') {
      if (req.url === '/v1/hq/saas/access-exception-policy') send(200, state.fixture.policy());
      else if (req.url === base + '/access-exceptions') send(200, state.fixture.history());
      else if (req.url === base + '/subscription') send(200, state.fixture.subscription());
      else { report.failures.push({ name: 'API allowlist', message: req.method + ' ' + req.url }); send(404, 'UNAVAILABLE', true); }
      return;
    }
    const revoke = /^\/v1\/hq\/saas\/access-exceptions\/([a-f0-9-]+)\/revoke$/.exec(req.url);
    const kind = req.url === base + '/access-exceptions' ? 'grant' : revoke ? 'revoke' : null;
    assert(kind && req.method === 'POST', 'Unexpected mutation endpoint');
    assert.equal(req.headers['x-hon-human-command'], kind === 'grant' ? SAAS_COMMANDS.grantAccessException : SAAS_COMMANDS.revokeAccessException);
    assert.match(req.headers['content-type'] ?? '', /^application\/json/); assert(req.headers['idempotency-key']);
    send(200, state.fixture.command(kind, revoke?.[1] ?? null, JSON.parse(await body(req)), req.headers['idempotency-key'], state.principalId));
  } catch (error) { if (!error.status) report.failures.push({ name: 'Fixture contract', message: error.message }); send(error.status ?? 400, error.code ?? 'INVALID_SYNTHETIC_REQUEST', true); }
});
const domainRequests = subject => report.requests.filter(r => r.subject === subject && /^\/v1\/hq\/(?:session|saas\/)/.test(r.path));
const hqRequests = subject => report.requests.filter(r => r.subject === subject && r.path.startsWith('/v1/hq/'));
const idle = page => page.waitForFunction(() => document.querySelector('[data-access-exceptions]')?.getAttribute('data-access-exceptions-busy') === 'false');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function within(promise, label, milliseconds = 12000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
const token = subject => ({ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: subject }, session), url: origin, httpOnly: true, sameSite: 'Lax' });
async function check(name, work) { try { await work(); report.checks.push(name); console.log('PASS ' + name); } catch (error) { report.failures.push({ name, message: error.message }); console.error('FAIL ' + name + ': ' + error.stack); } }
async function open(width = 390, language = 'en', policy = 'ACTIVE', role = 'owner') {
  const subject = `access-${++sequence}-${language}`, fixture = createExceptionFixture(policy), state = { fixture, role, principalId: ownerId, preference: { language, version: 1, updatedAt: new Date().toISOString() } };
  subjects.set(subject, state);
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block', timezoneId: 'UTC' });
  await context.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin) return route.continue(); report.blockedExternalRequests.push(url.origin); return route.abort(); });
  await context.routeWebSocket('**/*', socket => socket.close()); await context.addCookies([token(subject)]);
  const page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('dialog', dialog => { if (dialog.type() === 'beforeunload') void dialog.accept(); else void dialog.dismiss(); });
  await page.goto(origin + '/hq/access-exceptions?organizationId=' + target.organizationId + '&schoolId=' + target.schoolId);
  await page.locator(`html[lang=${language}] [data-access-exceptions]`).waitFor(); await idle(page);
  const ui = page.locator('[data-access-exceptions]'), t = key => exceptionText(language, key), button = key => ui.getByRole('button', { name: t(key), exact: true });
  assert.equal(await ui.locator('input[name=organizationId]').inputValue(), '', 'Query selector cannot prefill or auto-read');
  assert.equal(await ui.locator('input[name=schoolId]').inputValue(), ''); assert.equal(domainRequests(subject).length, 0, 'Mount performs no domain/owner read');
  return { context, page, ui, subject, fixture, state, language, t, button };
}
async function load(x) { await x.ui.locator('input[name=organizationId]').fill(target.organizationId); await x.ui.locator('input[name=schoolId]').fill(target.schoolId); await x.button('load').click(); await x.ui.locator('#exception-current').waitFor(); await idle(x.page); }
async function prepare(x) { const form = x.ui.locator('section[aria-labelledby=exception-grant]'); await form.getByLabel(x.t('start'), { exact: true }).fill(x.fixture.startsAt); await form.getByLabel(x.t('expiry'), { exact: true }).fill(x.fixture.expiresAt); await form.getByLabel(x.t('reason'), { exact: true }).fill('Synthetic reviewed browser grant reason.'); await form.getByRole('checkbox').check(); }
async function receipt(x) { await x.ui.locator('#exception-receipt').waitFor(); await idle(x.page); }
async function hidden(x, event = 'blur') {
  const synchronous = await x.page.evaluate(event => { window.dispatchEvent(new Event(event)); const facts = document.querySelector('[data-access-exceptions-facts]'); return facts.hidden && facts.inert; }, event);
  assert(synchronous, 'Private DOM must synchronously become hidden and inert');
  await x.ui.getByRole('heading', { name: x.t('hidden'), exact: true }).waitFor();
  assert(!await x.ui.innerText().then(text => text.includes('Synthetic browser organization')));
}
async function capture(page, name) {
  await page.evaluate(async () => { await document.fonts.ready; window.scrollTo(0, 0); });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Horizontal page overflow');
  await page.addScriptTag({ content: axe });
  const scan = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  const violations = scan.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 10).map(n => ({ target: n.target, summary: n.failureSummary?.slice(0, 1200) })) })); report.accessibility.push({ name, violations });
  await page.screenshot({ path: join(results, name + '.png'), fullPage: true, animations: 'disabled' }); report.screenshots.push(name + '.png');
  assert.deepEqual(violations, []);
}
try {
  await new Promise((yes, no) => { api.once('error', no); api.listen(3001, '127.0.0.1', yes); });
  app = spawn(process.execPath, [requireWeb.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'production', HON_DEPLOYMENT_ENVIRONMENT: 'preview', NEXT_TELEMETRY_DISABLED: '1', HON_API_BASE_URL: 'http://127.0.0.1:3001', HON_AUTH_MODE: session.mode, HON_SESSION_AUDIENCE: session.audience, HON_SESSION_JWT_SECRET: session.secret }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout.on('data', data => { log += data; }); app.stderr.on('data', data => { log += data; });
  let started = false; for (let n = 0; n < 100; n++) { try { await fetch(origin, { signal: AbortSignal.timeout(1000) }); started = true; break; } catch {} await new Promise(done => setTimeout(done, 250)); } assert(started, log.slice(-1200));
  browser = await chromium.launch({ executablePath: process.env.HON_HQ_CHROME_BIN, headless: true });
  for (const language of ['en', 'ko', 'es']) for (const width of [390, 834, 1440]) for (const [mode, label] of [['modern', 'Modern'], ['classic', 'Classic'], ['big-button', 'Big Button']]) {
    await check(`${language}/${width}/${mode}: explicit selectors, scheduled grant, revoke, keyboard, axe`, async () => {
      const x = await open(width, language);
      try {
        const before = hqRequests(x.subject).length;
        await x.page.getByRole('group', { name: translate(language, 'Platform view'), exact: true }).getByRole('button', { name: translate(language, label), exact: true }).click();
        assert.equal(hqRequests(x.subject).length, before, 'Presentation cannot read domain state');
        const org = x.ui.locator('input[name=organizationId]'); await org.focus(); await x.page.keyboard.press('Tab'); assert(await x.ui.locator('input[name=schoolId]').evaluate(e => e === document.activeElement));
        await load(x); assert.equal(x.fixture.mutations, 0); assert(await x.button('grantButton').isDisabled());
        await capture(x.page, `${language}-${width}-${mode}-access-loaded`);
        await prepare(x); await x.button('grantButton').focus(); await x.page.keyboard.press('Enter'); await receipt(x); assert.equal(x.fixture.mutations, 1);
        assert.equal(x.fixture.history().exceptions[0].lifecycle, 'SCHEDULED'); assert.equal(x.fixture.history().access.entitlement.inEffect, false);
        assert.equal(x.fixture.history().exceptions[0].aiCredits, 'NONE');
        if (language === 'en' && width === 390 && mode === 'modern') await capture(x.page, 'en-390-modern-access-scheduled-receipt');
        await x.button('load').click(); await x.ui.locator('#exception-history').waitFor(); await idle(x.page);
        await x.button('revoke').click(); const revoke = x.ui.locator('section[aria-labelledby=exception-revoke]'); await revoke.getByLabel(x.t('reason'), { exact: true }).fill('Synthetic reviewed browser revocation reason.');
        await revoke.getByRole('checkbox').check(); await x.button('revokeButton').click(); await receipt(x);
        assert.equal(x.fixture.mutations, 2); assert.equal(x.fixture.history().exceptions[0].lifecycle, 'REVOKED');
        if (language === 'en' && width === 390 && mode === 'modern') await capture(x.page, 'en-390-modern-access-revoked-receipt');
      } finally { await x.context.close(); }
    });
  }
  for (const policy of ['ABSENT', 'PROPOSED']) await check(`${policy}: no approval invented and no grant available`, async () => {
    const x = await open(390, 'en', policy); try { await load(x); assert(await x.button('grantButton').isDisabled()); assert(await x.ui.getByLabel(x.t('start'), { exact: true }).isDisabled()); assert.equal(x.fixture.mutations, 0); await capture(x.page, 'en-390-policy-' + policy.toLowerCase()); } finally { await x.context.close(); }
  });
  await check('Lost committed response: one double-click dispatch, independent privacy lease, same-owner exact replay and no automatic retry', async () => {
    const x = await open(), gate = deferred(), arrived = deferred(); let calls = 0, original;
    try {
      await load(x); await prepare(x);
      await x.page.route('**/api/v1/hq/saas/organizations/*/access-exceptions', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        calls++; const current = { body: route.request().postData(), key: route.request().headers()['idempotency-key'] };
        if (calls === 1) { original = current; await route.fetch(); arrived.resolve(); await gate.promise; await route.abort().catch(() => {}); }
        else { assert.deepEqual(current, original); await route.continue(); }
      });
      await x.button('grantButton').evaluate(button => { button.click(); button.click(); }); await within(arrived.promise, 'first committed grant'); assert.equal(calls, 1); assert.equal(x.fixture.mutations, 1);
      await hidden(x); assert(await x.button('restore').isDisabled()); gate.resolve(); await idle(x.page); assert.equal(calls, 1);
      x.state.principalId = otherOwnerId; await x.button('restore').click(); await idle(x.page); assert(await x.ui.locator('[data-access-exceptions-facts]').evaluate(e => e.hidden)); assert.equal(calls, 1);
      x.state.principalId = ownerId; x.fixture.setPolicy('WITHDRAWN'); await x.button('restore').click(); await x.ui.locator('#exception-retry').waitFor(); await idle(x.page);
      assert.equal(calls, 1, 'Restore cannot resend'); assert(await x.ui.locator('input[name=organizationId]').isDisabled()); assert.equal(await x.button('grantButton').count(), 0);
      x.state.sessionStatus = 503;
      await x.ui.locator('section[aria-labelledby=exception-retry]').getByRole('checkbox').check(); await x.button('retryButton').click(); await idle(x.page);
      assert.equal(await x.ui.locator('#exception-retry').count(), 1, 'A failed retry authorization read cannot discard the original unknown command');
      assert.equal(calls, 1, 'Failed authorization preflight must not resend'); delete x.state.sessionStatus;
      await capture(x.page, 'en-390-access-retained-unknown'); await x.ui.locator('section[aria-labelledby=exception-retry]').getByRole('checkbox').check(); await x.button('retryButton').click(); await receipt(x);
      assert.equal(calls, 2); assert.equal(x.fixture.mutations, 1); assert.equal(x.fixture.attempts[0].key, x.fixture.attempts[1].key); await capture(x.page, 'en-390-access-exact-replay-receipt');
    } finally { gate.resolve(); await x.context.close(); }
  });
  await check('Blur, pagehide, shared session and school signals conceal synchronously; focus does not restore', async () => {
    const x = await open(); try {
      for (const event of ['blur', 'pagehide', 'hon:session-invalidated', 'hon:school-context-changed']) {
        await load(x); const count = domainRequests(x.subject).length; await hidden(x, event); await x.page.evaluate(() => window.dispatchEvent(new Event('focus'))); await idle(x.page);
        assert.equal(domainRequests(x.subject).length, count); await x.button('restore').click(); await idle(x.page); assert.equal(await x.ui.locator('input[name=organizationId]').inputValue(), '');
      }
      await load(x); const count = domainRequests(x.subject).length;
      assert(await x.page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); const node = document.querySelector('[data-access-exceptions-facts]'); const result = node.hidden && node.inert; delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); return result; }));
      await idle(x.page); assert.equal(domainRequests(x.subject).length, count); await capture(x.page, 'en-390-access-private-hidden');
    } finally { await x.context.close(); }
  });
  await check('Late read after concealment cannot reveal facts or issue a command', async () => {
    const x = await open(), arrived = deferred(), gate = deferred();
    try {
      await x.page.route('**/api/v1/hq/saas/access-exception-policy', async route => { arrived.resolve(); await gate.promise; await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }, body: JSON.stringify({ data: x.fixture.policy() }) }).catch(() => {}); });
      await x.ui.locator('input[name=organizationId]').fill(target.organizationId); await x.ui.locator('input[name=schoolId]').fill(target.schoolId); await x.button('load').click(); await within(arrived.promise, 'held policy read');
      await hidden(x); gate.resolve(); await idle(x.page); assert.equal(await x.ui.locator('#exception-current').count(), 0); assert.equal(x.fixture.mutations, 0);
    } finally { gate.resolve(); await x.context.close(); }
  });
  for (const status of [401, 403]) await check(`${status} owner denial conceals loaded facts`, async () => {
    const x = await open(); try { await load(x); x.state.sessionStatus = status; await x.button('load').click(); await idle(x.page); await x.ui.getByRole('heading', { name: x.t('hidden'), exact: true }).waitFor(); assert(!await x.ui.innerText().then(text => text.includes('Synthetic browser organization'))); assert.equal(x.fixture.mutations, 0); await capture(x.page, 'en-390-access-denied-' + status); } finally { await x.context.close(); }
  });
  await check('Language changes perform preference work only; a sibling authenticated 401 conceals the workspace', async () => {
    const x = await open(); try {
      await load(x); const before = hqRequests(x.subject).length;
      await x.page.getByRole('combobox', { name: translate('en', 'Display language'), exact: true }).selectOption('es'); await x.page.locator('html[lang=es]').waitFor();
      await x.page.getByText(translate('es', 'Language synchronized'), { exact: true }).waitFor(); assert.equal(hqRequests(x.subject).length, before);
      x.state.languageStatus = 401; await x.page.getByRole('combobox', { name: translate('es', 'Display language'), exact: true }).selectOption('ko');
      await x.page.locator('html[lang=ko]').waitFor(); await x.ui.getByRole('heading', { name: exceptionText('ko', 'hidden'), exact: true }).waitFor();
      assert(await x.ui.locator('[data-access-exceptions-facts]').evaluate(e => e.hidden && e.inert)); assert.equal(x.fixture.mutations, 0); await capture(x.page, 'ko-390-access-sibling-401');
    } finally { await x.context.close(); }
  });
  await check('HQ operator cannot load owner-only exception records', async () => {
    const x = await open(390, 'en', 'ACTIVE', 'operator'); try { await x.ui.locator('input[name=organizationId]').fill(target.organizationId); await x.ui.locator('input[name=schoolId]').fill(target.schoolId); await x.button('load').click(); await idle(x.page); await x.ui.getByRole('heading', { name: x.t('hidden'), exact: true }).waitFor(); assert.equal(x.fixture.mutations, 0); } finally { await x.context.close(); }
  });
  assert(!report.requests.some(r => /checkout|payment|credit|\/access-exception-policy$/.test(r.path) && r.method === 'POST'), 'No policy approval, money, credit or checkout command');
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.failures, []);
} catch (error) { console.error(error.stack ?? error); report.failures.push({ name: 'Harness', message: error.message }); process.exitCode = 1; }
finally {
  await browser?.close(); if (app && app.exitCode === null) {
    const exited = new Promise(done => app.once('exit', done)); app.kill('SIGTERM');
    try { await within(exited, 'Next process shutdown', 5000); } catch { app.kill('SIGKILL'); await within(exited, 'Next forced shutdown', 5000); }
  }
  api.closeAllConnections(); if (api.listening) await new Promise(done => api.close(done));
  await writeFile(join(results, 'access-exceptions-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: report.checks.length, failures: report.failures.length, screenshots: report.screenshots.length, axeScans: report.accessibility.length, evidence: report.evidence }));
}
