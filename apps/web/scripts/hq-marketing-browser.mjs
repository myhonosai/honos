/** Mounted Next/Chromium proof of the HQ Marketing & Creative page (M1) with signed synthetic sessions and an in-memory fixture API.
 * No database or provider is used. Database authority, idempotency and history rules are proven by test-hq-marketing-campaigns.mjs.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, createHmac, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { issueSession, verifySession, cookieValue, HON_SESSION_COOKIE } from '@hon/auth';
import { HQ_OVERVIEW_UNAVAILABLE_REASONS, validateMyLanguagePreferenceView } from '@hon/contracts';
import { DEFAULT_LOCALE, localeCookieName } from '@hon/design-system';

assert(process.env.HON_HQ_BROWSER_LOCAL === '1' || process.env.GITHUB_ACTIONS === 'true', 'Explicit isolated browser verification required.');
for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_SECRET_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) assert(!process.env[key], 'Database/provider credentials are forbidden.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireWeb = createRequire(join(root, 'package.json'));
const ts = requireWeb('typescript');
const copyCode = ts.transpileModule(await readFile(join(root, 'src/components/hq-marketing/copy.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { marketingText } = await import('data:text/javascript;base64,' + Buffer.from(copyCode).toString('base64'));
assert(process.env.HON_HQ_BROWSER_TOOLS && process.env.HON_HQ_BROWSER_RESULTS && process.env.HON_HQ_CHROME_BIN);
const requireTools = createRequire(join(process.env.HON_HQ_BROWSER_TOOLS, 'runner.cjs'));
const { chromium } = requireTools('playwright-core');
const axe = await readFile(requireTools.resolve('axe-core/axe.min.js'), 'utf8');
const results = join(process.env.HON_HQ_BROWSER_RESULTS, 'hq-marketing');
await mkdir(results, { recursive: true });
const report = { sourceSha: process.env.HON_HQ_SOURCE_SHA, fixtureOnly: true, completed: false, checks: [], screenshots: [], accessibility: [], pageErrors: [] };
const session = { mode: 'OIDC', audience: 'hon-hq-marketing-synthetic', secret: randomBytes(32).toString('hex') };
const T0 = '2026-11-01T00:00:00.000Z';
const people = { agent: { principalId: '10000000-0000-4000-8000-000000000001', displayName: 'Synthetic Marketer' } };
const overview = { asOf: T0, callerHqRole: 'OWNER', organizationCount: 0, schoolCount: 0,
  onboarding: { availability: 'AVAILABLE', requestCount: 0, inProgressRequestCount: 0, completedRequestCount: 0 }, configuredProviderStates: { disabled: 0, configured: 0, healthy: 0, degraded: 0, unavailable: 0 }, taskProfileCount: 0,
  financialMetrics: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.financialMetrics }, aiUsage: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.aiUsage }, durableHqWork: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.durableHqWork } };

/** A tiny in-memory stand-in for 0252: versions, allowed status moves, archived is final, one saved answer per key. */
const TRANSITIONS = { DRAFT: ['ACTIVE', 'ARCHIVED'], ACTIVE: ['PAUSED', 'ARCHIVED'], PAUSED: ['ACTIVE', 'ARCHIVED'], ARCHIVED: [] };
const PLAN = ['name', 'goal', 'audience', 'offerLabel', 'channel', 'startsOn', 'endsOn', 'plannedBudgetMinor'];
function store(canManage) {
  let clock = Date.parse(T0);
  const now = () => new Date(clock += 60_000).toISOString();
  const campaigns = new Map(), answers = new Map();
  const json = c => ({ campaignId: c.id, code: c.code, ...Object.fromEntries(PLAN.map(k => [k, c[k]])), status: c.status, currency: 'USD', createdBy: people.agent,
    createdAt: c.createdAt, updatedAt: c.updatedAt, version: c.version });
  const create = (input) => { const at = now(); const c = { id: randomUUID(), ...input, status: 'DRAFT', createdAt: at, updatedAt: at, version: 1 }; campaigns.set(c.id, c); return c; };
  create({ code: 'SPRING-GOOGLE', name: 'Spring founder push', goal: 'Book 20 owner demos from Google search.', audience: 'NEW_SCHOOLS', offerLabel: 'Founder 50',
    channel: 'GOOGLE_ADS', startsOn: '2027-03-01', endsOn: '2027-03-31', plannedBudgetMinor: 250000 });
  const meta = create({ code: 'META-TRIALS', name: 'Trial nurture on Instagram', goal: 'Help trial schools finish setup.', audience: 'TRIAL_SCHOOLS', offerLabel: '14-day trial',
    channel: 'META_ADS', startsOn: '2027-02-01', endsOn: '2027-04-30', plannedBudgetMinor: 120050 });
  meta.status = 'ACTIVE'; meta.version = 2;
  return {
    campaigns, answers,
    list(status) {
      const all = [...campaigns.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const fits = c => !status || (status === 'OPEN' ? c.status !== 'ARCHIVED' : c.status === status);
      const count = s => all.filter(c => c.status === s).length;
      return { campaigns: all.filter(fits).map(json), limit: 25, nextCursor: null, viewer: { ...people.agent, canManage }, asOf: now(),
        summary: { DRAFT: count('DRAFT'), ACTIVE: count('ACTIVE'), PAUSED: count('PAUSED'), ARCHIVED: count('ARCHIVED'),
          plannedBudgetOpenMinor: all.filter(c => c.status !== 'ARCHIVED').reduce((n, c) => n + c.plannedBudgetMinor, 0) } };
    },
    /** Returns [status, body]. */
    command(kind, id, input) {
      if (kind === 'CREATE') {
        if ([...campaigns.values()].some(c => c.code === input.code)) return [422, { code: 'HQ_CAMPAIGN_CODE_TAKEN' }];
        return [200, { data: { operation: 'CREATE', campaign: json(create(input)), replayed: false } }];
      }
      const c = campaigns.get(id); if (!c) return [404, { code: 'SAAS_UNAVAILABLE' }];
      if (input.expectedVersion !== c.version) return [409, { code: 'SAAS_VERSION_CONFLICT' }];
      if (c.status === 'ARCHIVED') return [422, { code: 'HQ_CAMPAIGN_ARCHIVED' }];
      if (kind === 'STATUS') { if (!TRANSITIONS[c.status].includes(input.status)) return [422, { code: 'HQ_CAMPAIGN_STATUS_NOT_ALLOWED' }]; c.status = input.status; }
      else { if (PLAN.every(k => c[k] === input[k])) return [422, { code: 'HQ_CAMPAIGN_NO_CHANGE' }]; for (const k of PLAN) c[k] = input[k]; }
      c.updatedAt = now(); c.version++;
      return [200, { data: { operation: kind, campaign: json(c), replayed: false } }];
    },
  };
}

const fixtures = new Map();
const api = createServer(async (req, res) => {
  const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  try {
    let subject; try { subject = verifySession(cookieValue(req.headers.cookie, HON_SESSION_COOKIE) ?? '', session).externalSubject; } catch { send(401, {}); return; }
    const f = fixtures.get(subject); if (!f) { send(403, {}); return; }
    const url = new URL(req.url, 'http://fixture'), path = url.pathname;
    if (req.method === 'GET') {
      if (path === '/v1/hq/overview') send(200, { data: { overview } });
      else if (path === '/v1/hq/session') send(200, { data: { principalId: people.agent.principalId, hqRole: 'HON_HQ_OWNER' } });
      else if (path === '/v1/me/language-preference') send(200, { data: validateMyLanguagePreferenceView({ preference: { language: f.language, version: 1, updatedAt: T0 }, schoolDefault: null, effective: { language: f.language, source: 'PERSONAL' }, supportedLanguages: ['en', 'ko', 'es'] }) });
      else if (path === '/v1/hq/marketing/campaigns') {
        f.reads.push(req.url);
        if (f.denied) send(403, { code: 'SAAS_FORBIDDEN' }); else send(200, { data: f.store.list(url.searchParams.get('status')) });
      } else send(503, {});
      return;
    }
    const m = /^\/v1\/hq\/marketing\/campaigns(?:\/([0-9a-f-]{36})\/(versions|status))?$/.exec(path);
    if (req.method !== 'POST' || !m) { send(405, {}); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const key = req.headers['idempotency-key'], marker = req.headers['x-hon-human-command'];
    const kind = !m[1] ? 'CREATE' : m[2] === 'versions' ? 'UPDATE' : 'STATUS';
    f.commands.push({ kind, key, body, marker });
    assert.equal(marker, { CREATE: 'hq-marketing-campaign-create', UPDATE: 'hq-marketing-campaign-update', STATUS: 'hq-marketing-campaign-status' }[kind]);
    const prior = f.store.answers.get(key);
    if (prior) { if (prior.body !== body) { send(409, { code: 'IDEMPOTENCY_KEY_REUSED' }); return; } send(prior.status, { data: { ...prior.value.data, replayed: true } }); return; }
    const [status, value] = f.store.command(kind, m[1], JSON.parse(body));
    if (status === 200) f.store.answers.set(key, { body, status, value });
    if (f.unknownOnce === kind) { f.unknownOnce = null; send(503, {}); return; }
    send(status, value);
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
const t = (key, language = 'en') => marketingText(language, key);
async function open(name, viewport, configure = () => {}, language = 'en', path = '/hq/marketing') {
  const f = { language, reads: [], commands: [], store: store(true), denied: false, unknownOnce: null }; configure(f); fixtures.set(name, f);
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const scope = createHmac('sha256', session.secret).update(JSON.stringify(['hon-local-presentation-v1', session.mode, session.audience, name])).digest('hex');
  await context.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: name }, session), url: origin, httpOnly: true, sameSite: 'Lax' },
    { name: localeCookieName(scope), value: encodeURIComponent(JSON.stringify({ ...DEFAULT_LOCALE, language })), url: origin, sameSite: 'Lax' }]);
  const page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.goto(origin + path);
  return { context, page, f, language };
}
const ready = s => s.page.locator('[data-hq-marketing="ready"]').waitFor();
const ROOT = '[data-hq-marketing]';
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

  await check('the HQ marketing page shows campaigns, planned budget and both ad accounts as not connected (desktop and 390px)', async () => {
    for (const [name, viewport] of [['marketing-desktop', { width: 1280, height: 900 }], ['marketing-mobile', { width: 390, height: 844 }]]) {
      const s = await open(name, viewport); await ready(s);
      const text = await s.page.locator(ROOT).innerText();
      for (const expected of ['Spring founder push', 'Trial nurture on Instagram', 'SPRING-GOOGLE', '$3,700.50', t('plannedNote'), t('GOOGLE_ADS_ACCOUNT'), t('META_ADS_ACCOUNT'), t('adAccountsHelp')]) assert(text.includes(expected), expected);
      assert.equal(await s.page.locator('[data-ad-account]').count(), 2);
      assert.equal((text.match(new RegExp(t('notConnected'), 'g')) ?? []).length, 2);
      assert.equal(s.f.reads[0], '/v1/hq/marketing/campaigns?status=OPEN&limit=25');
      assert(await s.page.locator('a[href="/hq/marketing"]').count() > 0, 'HQ navigation links the page');
      await capture(s, name, ROOT); await s.context.close();
    }
  });
  await check('creating a campaign sends one human command and it appears as a draft', async () => {
    const s = await open('marketing-create', { width: 390, height: 844 }); await ready(s);
    await s.page.getByRole('button', { name: t('newCampaign'), exact: true }).click();
    await s.page.getByLabel(t('code'), { exact: true }).fill('summer-email');
    await s.page.getByLabel(t('name'), { exact: true }).fill('Summer owner newsletter');
    await s.page.getByLabel(t('goal'), { exact: true }).fill('Invite existing schools to refer a friend.');
    await s.page.getByLabel(t('channel'), { exact: true }).selectOption('EMAIL');
    await s.page.getByLabel(t('audience'), { exact: true }).selectOption('EXISTING_SCHOOLS');
    await s.page.getByLabel(t('offer'), { exact: true }).fill('Champions Club');
    await s.page.getByLabel(t('startsOn'), { exact: true }).fill('2027-06-01');
    await s.page.getByLabel(t('endsOn'), { exact: true }).fill('2027-06-30');
    await s.page.getByLabel(t('budget'), { exact: true }).fill('400.25');
    await capture(s, 'marketing-create-form-mobile', ROOT);
    await s.page.getByRole('button', { name: t('submitCreate'), exact: true }).click();
    await s.page.locator('[data-marketing-outcome="done"]').waitFor();
    assert.equal(s.f.commands.length, 1);
    assert.deepEqual(JSON.parse(s.f.commands[0].body), { code: 'SUMMER-EMAIL', name: 'Summer owner newsletter', goal: 'Invite existing schools to refer a friend.',
      audience: 'EXISTING_SCHOOLS', offerLabel: 'Champions Club', channel: 'EMAIL', startsOn: '2027-06-01', endsOn: '2027-06-30', plannedBudgetMinor: 40025 });
    await s.page.locator(ROOT).getByText('Summer owner newsletter', { exact: true }).waitFor();
    assert.equal(await s.page.locator('[data-marketing-form]').count(), 0, 'the form closes after saving');
    await s.context.close();
  });
  await check('a status change whose outcome is unknown is retried with the same key and body and saved once', async () => {
    const s = await open('marketing-status-unknown', { width: 1280, height: 900 }, f => { f.unknownOnce = 'STATUS'; }); await ready(s);
    const card = s.page.locator('[data-marketing-campaign]').filter({ hasText: 'Spring founder push' });
    await card.locator('[data-marketing-status="ACTIVE"]').click();
    await s.page.locator('[data-marketing-outcome="unknown"]').waitFor();
    // The fresh read after an unknown answer may already show the saved move; every control stays locked while one is in doubt.
    for (const b of await card.locator('button').all()) assert(await b.isDisabled(), 'no second command while one is in doubt');
    await s.page.getByRole('button', { name: t('tryAgain'), exact: true }).click();
    await s.page.locator('[data-marketing-outcome="done"]').waitFor();
    assert.equal(s.f.commands.length, 2); assert.deepEqual(s.f.commands[1], s.f.commands[0]);
    assert.deepEqual(JSON.parse(s.f.commands[0].body), { expectedVersion: 1, status: 'ACTIVE' });
    await card.locator('[data-marketing-status="PAUSED"]').waitFor();
    await s.context.close();
  });
  await check('editing a plan sends the current version; an unchanged plan is refused without a second write', async () => {
    const s = await open('marketing-edit', { width: 390, height: 844 }); await ready(s);
    const card = s.page.locator('[data-marketing-campaign]').filter({ hasText: 'Trial nurture on Instagram' });
    await card.getByRole('button', { name: t('edit'), exact: true }).click();
    await card.getByRole('button', { name: t('submitUpdate'), exact: true }).click();
    await s.page.locator('[data-marketing-outcome="refused"]').waitFor();
    await card.getByLabel(t('budget'), { exact: true }).fill('1500');
    await card.getByRole('button', { name: t('submitUpdate'), exact: true }).click();
    await s.page.locator('[data-marketing-outcome="done"]').waitFor();
    assert.deepEqual(JSON.parse(s.f.commands.at(-1).body).expectedVersion, 2);
    assert.equal(JSON.parse(s.f.commands.at(-1).body).plannedBudgetMinor, 150000);
    await s.page.locator(ROOT).getByText('$1,500', { exact: true }).waitFor();
    await s.context.close();
  });
  await check('a read-only marketer sees campaigns with no change controls', async () => {
    const s = await open('marketing-read-only', { width: 390, height: 844 }, f => { f.store = store(false); }); await ready(s);
    await s.page.getByText(t('readOnly'), { exact: false }).waitFor();
    assert.equal(await s.page.locator('[data-marketing-status]').count(), 0);
    assert.equal(await s.page.getByRole('button', { name: t('newCampaign'), exact: true }).count(), 0);
    await s.context.close();
  });
  await check('leaving the tab hides every campaign and the open form; Show again reads fresh', async () => {
    const s = await open('marketing-conceal', { width: 1280, height: 900 }); await ready(s);
    await s.page.getByRole('button', { name: t('newCampaign'), exact: true }).click();
    await s.page.getByLabel(t('name'), { exact: true }).fill('Private draft name');
    const reads = s.f.reads.length;
    await s.page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await s.page.locator('[data-hq-marketing="concealed"]').waitFor();
    const body = await s.page.locator('body').innerText();
    assert(!body.includes('Spring founder push') && !body.includes('Private draft name'));
    await s.page.getByRole('button', { name: t('reveal'), exact: true }).click(); await ready(s);
    assert(s.f.reads.length > reads);
    assert.equal(await s.page.locator('[data-marketing-form]').count(), 0, 'the draft is not restored');
    await s.context.close();
  });
  await check('a person without HQ marketing access sees nothing', async () => {
    const s = await open('marketing-denied', { width: 390, height: 844 }, f => { f.denied = true; });
    await s.page.locator('[data-hq-marketing="denied"]').waitFor();
    const body = await s.page.locator('body').innerText();
    assert(!body.includes('Spring founder push') && !body.includes(t('GOOGLE_ADS_ACCOUNT') + '\n'));
    await s.context.close();
  });
  await check('the Korean page renders without overflow', async () => {
    const s = await open('marketing-ko', { width: 390, height: 844 }, () => {}, 'ko'); await ready(s);
    await s.page.locator(ROOT).getByRole('heading', { name: t('title', 'ko'), exact: true }).waitFor();
    await capture(s, 'marketing-ko-mobile', ROOT); await s.context.close();
  });
  assert.deepEqual(report.pageErrors, []);
  report.completed = true;
} finally {
  await writeFile(join(results, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close(); app.kill('SIGTERM'); api.closeAllConnections(); await new Promise(done => api.close(done));
}
