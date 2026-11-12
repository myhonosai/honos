/** Mounted Next/Chromium proof of the HQ Creative Studio page (M2) with signed synthetic sessions and an in-memory fixture API.
 * No database or provider is used. Database authority, the HQ cap, idempotency and outcome rules are proven by test-hq-creative-studio.mjs.
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
const copyCode = ts.transpileModule(await readFile(join(root, 'src/components/hq-creative/copy.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { creativeText } = await import('data:text/javascript;base64,' + Buffer.from(copyCode).toString('base64'));
assert(process.env.HON_HQ_BROWSER_TOOLS && process.env.HON_HQ_BROWSER_RESULTS && process.env.HON_HQ_CHROME_BIN);
const requireTools = createRequire(join(process.env.HON_HQ_BROWSER_TOOLS, 'runner.cjs'));
const { chromium } = requireTools('playwright-core');
const axe = await readFile(requireTools.resolve('axe-core/axe.min.js'), 'utf8');
const results = join(process.env.HON_HQ_BROWSER_RESULTS, 'hq-creative');
await mkdir(results, { recursive: true });
const report = { sourceSha: process.env.HON_HQ_SOURCE_SHA, fixtureOnly: true, completed: false, checks: [], screenshots: [], accessibility: [], pageErrors: [] };
const session = { mode: 'OIDC', audience: 'hon-hq-creative-synthetic', secret: randomBytes(32).toString('hex') };
const T0 = '2026-11-01T00:00:00.000Z';
const people = { agent: { principalId: '10000000-0000-4000-8000-000000000001', displayName: 'Synthetic Marketer' }, owner: { principalId: '10000000-0000-4000-8000-000000000002', displayName: 'Synthetic Owner' } };
const overview = { asOf: T0, callerHqRole: 'OWNER', organizationCount: 0, schoolCount: 0,
  onboarding: { availability: 'AVAILABLE', requestCount: 0, inProgressRequestCount: 0, completedRequestCount: 0 }, configuredProviderStates: { disabled: 0, configured: 0, healthy: 0, degraded: 0, unavailable: 0 }, taskProfileCount: 0,
  financialMetrics: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.financialMetrics }, aiUsage: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.aiUsage }, durableHqWork: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.durableHqWork } };

/** A tiny in-memory stand-in for 0253: the HQ cap, used/held credits, at most 3 in progress, one saved answer per key. */
const RATES = [{ operationCode: 'image.generate', mediaKind: 'IMAGE', displayName: 'Image', billingUnit: 'IMAGE', creditsPerUnit: 10, maxUnitsPerRequest: 4 },
  { operationCode: 'video.generate', mediaKind: 'VIDEO', displayName: 'Short video', billingUnit: 'VIDEO_SECOND', creditsPerUnit: 5, maxUnitsPerRequest: 30 }];
const CAMPAIGN = { campaignId: '20000000-0000-4000-8000-000000000001', code: 'SPRING-GOOGLE', name: 'Spring founder push', goal: 'Book owner demos.', audience: 'NEW_SCHOOLS',
  offerLabel: 'Founder 50', channel: 'GOOGLE_ADS', startsOn: '2027-03-01', endsOn: '2027-03-31', plannedBudgetMinor: 250000, status: 'ACTIVE', currency: 'USD',
  createdBy: people.agent, createdAt: T0, updatedAt: T0, version: 2 };
const PERIOD = new Date().toISOString().slice(0, 8) + '01';
function store({ canManage = true, isOwner = false, provider = 'CONNECTED', cap = 200 } = {}) {
  let clock = Date.now() - 3_600_000;
  const now = () => new Date(clock += 60_000).toISOString();
  const gens = [], answers = new Map(), history = [];
  const b = { cap, version: cap === null ? null : 1, setAt: cap === null ? null : now() };
  if (cap !== null) history.push({ periodStart: PERIOD, version: 1, creditCap: cap, previousCap: null, reason: 'November HQ creative plan', actor: people.owner, recordedAt: b.setAt });
  const totals = () => ({ used: gens.filter(g => ['SUCCEEDED', 'RESOLVED_CHARGED'].includes(g.status)).reduce((n, g) => n + g.chargedCredits, 0),
    held: gens.filter(g => ['GENERATING', 'UNDER_REVIEW'].includes(g.status)).reduce((n, g) => n + g.reservedCredits, 0),
    busy: gens.filter(g => g.status === 'GENERATING').length });
  const budget = () => { const t = totals(); return { periodStart: PERIOD, creditCap: b.cap, usedCredits: t.used, heldCredits: t.held,
    availableCredits: b.cap === null ? 0 : Math.max(b.cap - t.used - t.held, 0), inProgress: t.busy, version: b.version, setBy: b.cap === null ? null : people.owner, setAt: b.setAt }; };
  const add = (input, status, extra = {}) => { const rate = RATES.find(r => r.operationCode === input.operationCode);
    const g = { generationId: randomUUID(), periodStart: PERIOD, campaign: input.campaignId ? { campaignId: CAMPAIGN.campaignId, code: CAMPAIGN.code, name: CAMPAIGN.name } : null,
      operationCode: input.operationCode, mediaKind: rate.mediaKind, units: input.units, format: input.format, prompt: input.prompt, status, failureReason: null,
      reservedCredits: rate.creditsPerUnit * input.units, chargedCredits: null, requestedBy: people.agent, version: 1, createdAt: now(), completedAt: null, assets: [], ...extra };
    if (g.completedAt === true) g.completedAt = now();
    gens.unshift(g); return g; };
  const asset = (o) => ({ assetId: randomUUID(), ordinal: o, mediaType: 'image/png', width: 1024, height: 1024, durationSeconds: null, origin: 'SYNTHETIC' });
  add({ operationCode: 'image.generate', units: 2, format: 'SQUARE', prompt: 'Founder 50 poster: calm front desk at a busy dojo.', campaignId: CAMPAIGN.campaignId },
    'SUCCEEDED', { chargedCredits: 20, version: 2, completedAt: true, assets: [asset(1), asset(2)] });
  add({ operationCode: 'image.generate', units: 1, format: 'PORTRAIT', prompt: 'Instagram story: owner reviewing the trial dashboard.', campaignId: null },
    'UNDER_REVIEW', { failureReason: 'UNVERIFIED_RESULT', version: 2, completedAt: true });
  return {
    answers,
    view: () => ({ provider, budget: budget(), budgetHistory: [...history].reverse().slice(0, 12), rates: RATES, generations: gens.slice(0, 50), limit: 50,
      viewer: { ...(isOwner ? people.owner : people.agent), canManage, isOwner }, asOf: now() }),
    command(kind, id, input) {
      if (kind === 'CREATE') {
        if (provider !== 'CONNECTED') return [503, { code: 'CREATIVE_PROVIDER_NOT_CONNECTED' }];
        if (b.cap === null) return [422, { code: 'HQ_CREATIVE_BUDGET_NOT_SET' }];
        const rate = RATES.find(r => r.operationCode === input.operationCode);
        if (rate.creditsPerUnit * input.units > budget().availableCredits) return [422, { code: 'HQ_CREATIVE_BUDGET_EXHAUSTED' }];
        const g = add(input, 'SUCCEEDED', { version: 2, completedAt: true });
        g.chargedCredits = g.reservedCredits; g.assets = Array.from({ length: input.units }, (_, i) => asset(i + 1));
        return [200, { data: { generation: g, budget: budget(), replayed: false } }];
      }
      if (kind === 'BUDGET') {
        if (!isOwner) return [403, { code: 'SAAS_FORBIDDEN' }];
        if (input.expectedVersion !== b.version) return [409, { code: 'SAAS_VERSION_CONFLICT' }];
        const t = totals(); if (input.creditCap < t.used + t.held) return [422, { code: 'HQ_CREATIVE_CAP_BELOW_USE' }];
        history.push({ periodStart: PERIOD, version: (b.version ?? 0) + 1, creditCap: input.creditCap, previousCap: b.cap, reason: input.reason, actor: people.owner, recordedAt: now() });
        b.cap = input.creditCap; b.version = (b.version ?? 0) + 1; b.setAt = now();
        return [200, { data: { budget: budget(), replayed: false } }];
      }
      const g = gens.find(x => x.generationId === id); if (!g) return [404, { code: 'SAAS_UNAVAILABLE' }];
      if (g.version !== input.expectedVersion) return [409, { code: 'SAAS_VERSION_CONFLICT' }];
      if (input.resolution === 'SUCCEEDED') { g.status = 'RESOLVED_CHARGED'; g.chargedCredits = input.finalUnits * (g.reservedCredits / g.units); }
      else g.status = 'RESOLVED_NOT_CHARGED';
      g.version++;
      return [200, { data: { generation: g, budget: budget(), replayed: false } }];
    },
  };
}

const fixtures = new Map();
const MARKERS = { CREATE: 'hq-creative-generation-create', BUDGET: 'hq-creative-budget-set', RESOLVE: 'hq-creative-generation-resolve' };
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
      else if (path === '/v1/hq/marketing/creative') { f.reads.push(req.url); if (f.denied) send(403, { code: 'SAAS_FORBIDDEN' }); else send(200, { data: f.store.view() }); }
      else if (path === '/v1/hq/marketing/campaigns') send(200, { data: { campaigns: [CAMPAIGN], limit: 25, nextCursor: null, viewer: { ...people.agent, canManage: true }, asOf: T0,
        summary: { DRAFT: 0, ACTIVE: 1, PAUSED: 0, ARCHIVED: 0, plannedBudgetOpenMinor: 250000 } } });
      else send(503, {});
      return;
    }
    const m = /^\/v1\/hq\/marketing\/creative\/(?:(generations)(?:\/([0-9a-f-]{36})\/resolution)?|(budget))$/.exec(path);
    if (req.method !== 'POST' || !m) { send(405, {}); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const key = req.headers['idempotency-key'], marker = req.headers['x-hon-human-command'];
    const kind = m[3] ? 'BUDGET' : m[2] ? 'RESOLVE' : 'CREATE';
    f.commands.push({ kind, key, body, marker });
    assert.equal(marker, MARKERS[kind]);
    const prior = f.store.answers.get(key);
    if (prior) { if (prior.body !== body) { send(409, { code: 'IDEMPOTENCY_KEY_REUSED' }); return; } send(prior.status, { data: { ...prior.value.data, replayed: true } }); return; }
    const [status, value] = f.store.command(kind, m[2], JSON.parse(body));
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
const t = (key, language = 'en') => creativeText(language, key);
async function open(name, viewport, configure = () => {}, language = 'en') {
  const f = { language, reads: [], commands: [], store: store(), denied: false, unknownOnce: null }; configure(f); fixtures.set(name, f);
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const scope = createHmac('sha256', session.secret).update(JSON.stringify(['hon-local-presentation-v1', session.mode, session.audience, name])).digest('hex');
  await context.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: name }, session), url: origin, httpOnly: true, sameSite: 'Lax' },
    { name: localeCookieName(scope), value: encodeURIComponent(JSON.stringify({ ...DEFAULT_LOCALE, language })), url: origin, sameSite: 'Lax' }]);
  const page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.goto(origin + '/hq/marketing/creative');
  return { context, page, f, language };
}
const ready = s => s.page.locator('[data-hq-creative="ready"]').waitFor();
const ROOT = '[data-hq-creative]';
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

  await check('production state: no provider connected, requests are off, the HQ budget is shown separate from schools (desktop and 390px)', async () => {
    for (const [name, viewport] of [['creative-desktop', { width: 1280, height: 900 }], ['creative-mobile', { width: 390, height: 844 }]]) {
      const s = await open(name, viewport, f => { f.store = store({ provider: 'NOT_CONNECTED' }); }); await ready(s);
      const text = await s.page.locator(ROOT).innerText();
      for (const expected of [t('providerOff'), t('budgetSeparate'), t('requestsOff'), 'Founder 50 poster', t('UNDER_REVIEW'), '2 synthetic test result(s)']) assert(text.includes(expected), expected);
      assert(await s.page.getByRole('button', { name: t('submitRequest'), exact: true }).isDisabled(), 'no request can be sent without a provider');
      assert.equal(s.f.reads[0], '/v1/hq/marketing/creative');
      await capture(s, name, ROOT); await s.context.close();
    }
  });
  await check('Marketing & Creative links to the studio', async () => {
    const s = await open('creative-link', { width: 1280, height: 900 }); await ready(s);
    await s.page.goto(origin + '/hq/marketing');
    await s.page.locator('a[href="/hq/marketing/creative"]').first().waitFor();
    await s.context.close();
  });
  await check('a request (fixture provider) sends one human command with the chosen campaign and charges the HQ budget', async () => {
    const s = await open('creative-request', { width: 390, height: 844 }); await ready(s);
    await s.page.getByLabel(t('operation'), { exact: true }).selectOption('image.generate');
    await s.page.getByLabel(t('units'), { exact: true }).fill('3');
    await s.page.getByLabel(t('format'), { exact: true }).selectOption('LANDSCAPE');
    await s.page.getByLabel(t('campaign'), { exact: true }).selectOption(CAMPAIGN.campaignId);
    await s.page.getByLabel(t('prompt'), { exact: true }).fill('Google display banner: kids class in a bright dojo.');
    await capture(s, 'creative-request-form-mobile', ROOT);
    await s.page.getByRole('button', { name: t('submitRequest'), exact: true }).click();
    await s.page.locator('[data-creative-outcome="done"]').waitFor();
    assert.equal(s.f.commands.length, 1);
    assert.deepEqual(JSON.parse(s.f.commands[0].body), { operationCode: 'image.generate', units: 3, format: 'LANDSCAPE',
      prompt: 'Google display banner: kids class in a bright dojo.', campaignId: CAMPAIGN.campaignId });
    await s.page.locator(ROOT).getByText('Google display banner: kids class in a bright dojo.', { exact: true }).waitFor();
    const facts = await s.page.locator('[data-creative-budget="set"]').innerText();
    assert(facts.includes('50') && facts.includes('140'), facts);
    await s.context.close();
  });
  await check('a cap change whose outcome is unknown is retried with the same key and body and saved once', async () => {
    const s = await open('creative-budget-unknown', { width: 1280, height: 900 }, f => { f.store = store({ isOwner: true }); f.unknownOnce = 'BUDGET'; }); await ready(s);
    await s.page.getByLabel(t('capLabel'), { exact: true }).fill('300');
    await s.page.getByLabel(t('reason'), { exact: true }).fill('More posters for March');
    await s.page.getByRole('button', { name: t('saveBudget'), exact: true }).click();
    await s.page.locator('[data-creative-outcome="unknown"]').waitFor();
    assert(await s.page.getByRole('button', { name: t('saveBudget'), exact: true }).isDisabled(), 'locked while in doubt');
    await s.page.getByRole('button', { name: t('tryAgain'), exact: true }).click();
    await s.page.locator('[data-creative-outcome="done"]').waitFor();
    assert.equal(s.f.commands.length, 2); assert.deepEqual(s.f.commands[1], s.f.commands[0]);
    assert.deepEqual(JSON.parse(s.f.commands[0].body), { periodStart: PERIOD, creditCap: 300, expectedVersion: 1, reason: 'More posters for March' });
    await s.page.locator('[data-creative-history]').getByText('More posters for March', { exact: false }).waitFor();
    await s.context.close();
  });
  await check('the HQ owner resolves a held request with evidence', async () => {
    const s = await open('creative-resolve', { width: 390, height: 844 }, f => { f.store = store({ isOwner: true }); }); await ready(s);
    const card = s.page.locator('[data-creative-generation]').filter({ hasText: 'Instagram story' });
    await card.getByRole('button', { name: t('resolveTitle'), exact: true }).click();
    await card.getByLabel(t('evidence'), { exact: true }).fill('Provider export 2026-11');
    await capture(s, 'creative-resolve-mobile', ROOT);
    await card.getByRole('button', { name: t('saveResolve'), exact: true }).click();
    await s.page.locator('[data-creative-outcome="done"]').waitFor();
    assert.deepEqual(JSON.parse(s.f.commands.at(-1).body), { expectedVersion: 2, resolution: 'NOT_CHARGED', finalUnits: null, providerCostMicrounits: null, evidenceReference: 'Provider export 2026-11' });
    await card.locator('[data-creative-status="RESOLVED_NOT_CHARGED"]').waitFor();
    await s.context.close();
  });
  await check('a refusal is explained and nothing is shown as saved', async () => {
    const s = await open('creative-exhausted', { width: 1280, height: 900 }, f => { f.store = store({ cap: 30 }); }); await ready(s);
    await s.page.getByLabel(t('units'), { exact: true }).fill('4');
    await s.page.getByLabel(t('prompt'), { exact: true }).fill('Four posters');
    await s.page.getByRole('button', { name: t('submitRequest'), exact: true }).click();
    await s.page.locator('[data-creative-code="HQ_CREATIVE_BUDGET_EXHAUSTED"]').waitFor();
    await s.context.close();
  });
  await check('a read-only marketer sees no forms; leaving the tab hides everything; no access shows nothing', async () => {
    const r = await open('creative-read-only', { width: 390, height: 844 }, f => { f.store = store({ canManage: false }); }); await ready(r);
    assert.equal(await r.page.locator('[data-creative-request-form], [data-creative-budget-form]').count(), 0);
    await r.page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await r.page.locator('[data-hq-creative="concealed"]').waitFor();
    assert(!(await r.page.locator('body').innerText()).includes('Founder 50 poster'));
    await r.context.close();
    const d = await open('creative-denied', { width: 390, height: 844 }, f => { f.denied = true; });
    await d.page.locator('[data-hq-creative="denied"]').waitFor();
    assert(!(await d.page.locator('body').innerText()).includes('Founder 50 poster'));
    await d.context.close();
  });
  await check('the Korean page renders without overflow', async () => {
    const s = await open('creative-ko', { width: 390, height: 844 }, () => {}, 'ko'); await ready(s);
    await s.page.locator(ROOT).getByRole('heading', { name: t('title', 'ko'), exact: true }).waitFor();
    await capture(s, 'creative-ko-mobile', ROOT); await s.context.close();
  });
  assert.deepEqual(report.pageErrors, []);
  report.completed = true;
} finally {
  await writeFile(join(results, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close(); app.kill('SIGTERM'); api.closeAllConnections(); await new Promise(done => api.close(done));
}
