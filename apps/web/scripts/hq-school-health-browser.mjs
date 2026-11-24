/** Mounted Next/Chromium proof of the HQ school health pages (B-HQ-2b) with signed synthetic sessions and a fixture API.
 * No database or provider is used. Database authority, counts and signals are proven by test-hq-school-health.mjs.
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
import { HQ_OVERVIEW_UNAVAILABLE_REASONS, validateHqSchoolDetail, validateHqSchoolHealth, validateHqSchoolsNeedingAttention, validateMyLanguagePreferenceView } from '@hon/contracts';
import { DEFAULT_LOCALE, localeCookieName } from '@hon/design-system';

assert(process.env.HON_HQ_BROWSER_LOCAL === '1' || process.env.GITHUB_ACTIONS === 'true', 'Explicit isolated browser verification required.');
for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_SECRET_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) assert(!process.env[key], 'Database/provider credentials are forbidden.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireWeb = createRequire(join(root, 'package.json'));
const ts = requireWeb('typescript');
const copyCode = ts.transpileModule(await readFile(join(root, 'src/components/hq-school-health/copy.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { healthText } = await import('data:text/javascript;base64,' + Buffer.from(copyCode).toString('base64'));
assert(process.env.HON_HQ_BROWSER_TOOLS && process.env.HON_HQ_BROWSER_RESULTS && process.env.HON_HQ_CHROME_BIN);
const requireTools = createRequire(join(process.env.HON_HQ_BROWSER_TOOLS, 'runner.cjs'));
const { chromium } = requireTools('playwright-core');
const axe = await readFile(requireTools.resolve('axe-core/axe.min.js'), 'utf8');
const results = join(process.env.HON_HQ_BROWSER_RESULTS, 'hq-school-health');
await mkdir(results, { recursive: true });
const report = { sourceSha: process.env.HON_HQ_SOURCE_SHA, fixtureOnly: true, completed: false, checks: [], screenshots: [], accessibility: [], pageErrors: [] };
const session = { mode: 'OIDC', audience: 'hon-hq-health-synthetic', secret: randomBytes(32).toString('hex') };
const T0 = '2026-11-09T00:00:00.000Z';
const ORG = '20000000-0000-4000-8000-000000000001', SCHOOL = '30000000-0000-4000-8000-000000000001';
const overview = { asOf: T0, callerHqRole: 'OWNER', organizationCount: 0, schoolCount: 0,
  onboarding: { availability: 'AVAILABLE', requestCount: 0, inProgressRequestCount: 0, completedRequestCount: 0 }, configuredProviderStates: { disabled: 0, configured: 0, healthy: 0, degraded: 0, unavailable: 0 }, taskProfileCount: 0,
  financialMetrics: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.financialMetrics }, aiUsage: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.aiUsage }, durableHqWork: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.durableHqWork } };

const id = n => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const facts = (patch = {}) => ({ attendance: { last30Days: 3, previous30Days: 12, lastRecordedAt: T0 }, classes: { heldLast30Days: 4, scheduledNext14Days: 1 }, bookingsLast30Days: 6,
  leads: { newLast30Days: 1, newPrevious30Days: 2, wonLast30Days: 1, open: 2 }, activeStudents: 9, openSupportCases: 0, signals: ['ATTENDANCE_DOWN'], ...patch });
const quiet = () => facts({ attendance: { last30Days: 0, previous30Days: 0, lastRecordedAt: null }, classes: { heldLast30Days: 0, scheduledNext14Days: 0 },
  leads: { newLast30Days: 0, newPrevious30Days: 0, wonLast30Days: 0, open: 0 }, activeStudents: 0, openSupportCases: 1,
  signals: ['NO_ACTIVE_STUDENTS', 'NO_CLASSES_NEXT_14_DAYS', 'NO_NEW_LEADS_30_DAYS', 'OPEN_SUPPORT_CASES'] });
const lapsed = () => facts({ attendance: { last30Days: 1, previous30Days: 2, lastRecordedAt: '2026-10-20T00:00:00.000Z' }, classes: { heldLast30Days: 1, scheduledNext14Days: 0 },
  leads: { newLast30Days: 0, newPrevious30Days: 1, wonLast30Days: 0, open: 1 }, activeStudents: 4, signals: ['NO_ATTENDANCE_14_DAYS', 'NO_CLASSES_NEXT_14_DAYS', 'NO_NEW_LEADS_30_DAYS'] });
/** Sixty flagged schools: the first page shows 50, "Show up to 200" shows all. */
const flagged = Array.from({ length: 60 }, (_, i) => ({ schoolId: id(i + 1), schoolDisplayName: `Synthetic School ${String(i + 1).padStart(2, '0')}`,
  organizationId: ORG, organizationDisplayName: 'Synthetic Dojo', health: i === 0 ? quiet() : i < 20 ? lapsed() : facts() }));
const attention = limit => validateHqSchoolsNeedingAttention({ schools: flagged.slice(0, limit), checked: 75, flagged: flagged.length, truncated: flagged.length > limit, limit, asOf: T0 });
const zero = { pending: 0, expired: 0, accepted: 0, revoked: 0, ended: 0 };
const detail = schoolId => validateHqSchoolDetail({ school: { schoolId, schoolDisplayName: 'Synthetic School 01', slug: 'synthetic-01', timezone: 'America/Chicago', schoolStatus: 'ACTIVE', createdAt: T0 },
  organization: { organizationId: ORG, organizationDisplayName: 'Synthetic Dojo', organizationStatus: 'ACTIVE', createdAt: T0, schools: [{ schoolId, schoolDisplayName: 'Synthetic School 01', schoolStatus: 'ACTIVE' }], schoolCount: 1,
    entitlement: null, accessState: 'PROVISIONED', accessStatus: 'NO_ACCESS', currentException: null, subscription: null, openCheckout: false,
    ownerOnboarding: { status: 'NOT_INVITED', invitedAt: null, expiresAt: null, acceptedAt: null }, exceptionGrant: { eligible: false, blockers: ['NO_ENTITLEMENT'], expectedEntitlementVersion: null } },
  exceptionPolicyReady: true, ownership: { ownerCount: 0, primaryOwnerGrantId: null, primaryNeeded: false, hqSeatCount: 1 },
  invitations: { owner: zero, staff: zero, family: zero }, people: { staffWithAccess: 0, familyMembersWithAccess: 0, activeStudents: 0 },
  viewer: { canGrantAndRevokeExceptions: true, canManageOwnership: true }, asOf: T0 });

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
    else if (path.startsWith('/v1/hq/saas/schools/')) {
      f.reads.push(req.url);
      if (f.denied) { send(403, { code: 'SAAS_FORBIDDEN' }); return; }
      const m = /^\/v1\/hq\/saas\/schools\/([0-9a-f-]{36})(\/health)?$/.exec(path);
      if (path === '/v1/hq/saas/schools/needing-attention') send(200, { data: attention(Number(url.searchParams.get('limit') ?? 50)) });
      else if (m && m[2]) send(200, { data: validateHqSchoolHealth({ schoolId: m[1], health: quiet(), asOf: T0 }) });
      else if (m) send(200, { data: detail(m[1]) });
      else send(404, { code: 'SAAS_UNAVAILABLE' });
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
const t = (key, language = 'en', vars) => healthText(language, key, vars);
async function open(name, viewport, configure = () => {}, language = 'en', path = '/hq/schools/attention') {
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
const ready = s => s.page.locator('[data-hq-attention="ready"]').waitFor();
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

  await check('the attention list shows flagged schools most signals first, with signals in words (desktop and 390px)', async () => {
    for (const [name, viewport] of [['attention-desktop', { width: 1280, height: 900 }], ['attention-mobile', { width: 390, height: 844 }]]) {
      const s = await open(name, viewport); await ready(s);
      assert.equal(s.f.reads[0], '/v1/hq/saas/schools/needing-attention?limit=50');
      const root = s.page.locator('[data-hq-attention]');
      assert.equal(await root.locator('[data-attention-school]').count(), 50);
      const text = await root.innerText();
      for (const expected of [t('summary', 'en', { flagged: '60', checked: '75' }), t('NO_ACTIVE_STUDENTS'), t('OPEN_SUPPORT_CASES'), t('truncated', 'en', { limit: '50' })]) assert(text.includes(expected), expected);
      assert.equal(await root.locator('[data-attention-school]').first().getAttribute('data-attention-school'), id(1));
      assert(!text.includes('Synthetic Student'));
      await capture(s, name, '[data-hq-attention]'); await s.context.close();
    }
  });
  await check('Show up to 200 reads again with the larger limit and lists every flagged school', async () => {
    const s = await open('attention-more', { width: 1280, height: 900 }); await ready(s);
    await s.page.getByRole('button', { name: t('showMore', 'en', { limit: '200' }), exact: true }).click();
    await s.page.locator('[data-attention-school]').nth(59).waitFor();
    assert.equal(s.f.reads.at(-1), '/v1/hq/saas/schools/needing-attention?limit=200');
    assert.equal(await s.page.getByRole('button', { name: t('showMore', 'en', { limit: '200' }), exact: true }).count(), 0);
    await s.page.locator('[data-attention-school]').first().locator('summary').click();
    await s.page.locator('[data-attention-school]').first().getByText(t('visits'), { exact: true }).waitFor();
    await s.context.close();
  });
  await check('the school detail page shows the activity health card from its own read', async () => {
    const s = await open('detail-health', { width: 390, height: 844 }, () => {}, 'en', `/hq/schools/${id(1)}`);
    await s.page.locator('[data-hq-school-health="ready"]').waitFor();
    assert(s.f.reads.includes(`/v1/hq/saas/schools/${id(1)}/health`));
    const text = await s.page.locator('[data-hq-school-health]').innerText();
    for (const expected of [t('cardTitle'), t('NO_ACTIVE_STUDENTS'), t('never')]) assert(text.includes(expected), expected);
    await capture(s, 'detail-health-mobile', '[data-hq-school-health]'); await s.context.close();
  });
  await check('leaving the tab hides every school; Show again reads fresh', async () => {
    const s = await open('attention-conceal', { width: 1280, height: 900 }); await ready(s);
    const reads = s.f.reads.length;
    await s.page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await s.page.locator('[data-hq-attention="concealed"]').waitFor();
    assert(!(await s.page.locator('body').innerText()).includes('Synthetic School'));
    await s.page.getByRole('button', { name: t('reveal'), exact: true }).click(); await ready(s);
    assert(s.f.reads.length > reads); await s.context.close();
  });
  await check('a person without HQ health access sees nothing', async () => {
    const s = await open('attention-denied', { width: 390, height: 844 }, f => { f.denied = true; });
    await s.page.locator('[data-hq-attention="denied"]').waitFor();
    assert(!(await s.page.locator('body').innerText()).includes('Synthetic School')); await s.context.close();
  });
  await check('the Korean attention list renders without overflow', async () => {
    const s = await open('attention-ko', { width: 390, height: 844 }, () => {}, 'ko'); await ready(s);
    await s.page.locator('[data-hq-attention]').getByRole('heading', { name: t('title', 'ko'), exact: true }).waitFor();
    await capture(s, 'attention-ko-mobile', '[data-hq-attention]'); await s.context.close();
  });
  assert.deepEqual(report.pageErrors, []);
  report.completed = true;
} finally {
  await writeFile(join(results, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close(); app.kill('SIGTERM'); api.closeAllConnections(); await new Promise(done => api.close(done));
}
