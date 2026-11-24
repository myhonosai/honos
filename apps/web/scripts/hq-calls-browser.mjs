/**
 * Disposable local browser proof for the HQ Calls page and the HQ top-bar phone (0674). Synthetic fixtures only: every /api
 * request is answered in the browser by this script and every other origin is blocked, so no database, Twilio or
 * production backend is reached. Requires `pnpm build` first.
 *
 *   HON_CALLS_BROWSER_LOCAL=1 HON_CALLS_BROWSER_RESULTS=<dir> node apps/web/scripts/hq-calls-browser.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { issueSession, HON_SESSION_COOKIE } from '@hon/auth';

if (process.env.HON_CALLS_BROWSER_LOCAL !== '1') throw new Error('Opt in with HON_CALLS_BROWSER_LOCAL=1.');
for (const key of ['DATABASE_URL', 'TWILIO_AUTH_TOKEN', 'TWILIO_ACCOUNT_SID', 'HON_VOICE_CALLS_APPROVED']) {
  if (process.env[key]) throw new Error('Browser verification refuses inherited database/provider credentials.');
}
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = process.env.HON_CALLS_BROWSER_RESULTS;
assert(results, 'HON_CALLS_BROWSER_RESULTS is required.');
const { chromium } = createRequire(import.meta.url)(process.env.HON_SHELL_PLAYWRIGHT ?? 'playwright');
await mkdir(results, { recursive: true });

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const prefix = '/api/v1/hq/calls';
const report = { syntheticFixturesOnly: true, databaseAccess: false, providerCalls: false, checks: [], failures: [], screenshots: [], pageErrors: [], apiRequests: [], blocked: [] };
const now = Date.parse('2026-11-19T18:00:00.000Z'), at = (minutes) => new Date(now - minutes * 60_000).toISOString();
let tokenState = 'VOICE_NOT_APPROVED', ringMe = false;
const call = (n, patch) => ({ callId: id(900 - n), direction: 'IN', status: 'COMPLETED', remoteE164: '+15125550101', contactUserId: null, contactName: null, contactSchools: [],
  staffName: null, startedAt: at(n * 41), answeredAt: null, endedAt: at(n * 41 - 2), durationSeconds: null, voicemail: false, recordingAvailable: false, recordingSeconds: null,
  heard: false, outcome: null, note: null, doNotCall: false, version: 1, ...patch });
const calls = [
  call(1, { status: 'VOICEMAIL', remoteE164: '+15125550142', contactName: 'Maria Lopez', contactUserId: id(401), contactSchools: ['Sunrise Martial Arts'], voicemail: true, recordingAvailable: true, recordingSeconds: 41 }),
  call(2, { status: 'COMPLETED', remoteE164: '+15125550188', contactName: 'Jordan Kim', contactUserId: id(402), contactSchools: ['Tiger Spirit Taekwondo'], staffName: 'Dana Wu', answeredAt: at(81), durationSeconds: 264, outcome: 'RESOLVED', note: 'Walked the owner through switching on missed-call text-back.' }),
  call(3, { direction: 'OUT', status: 'NO_ANSWER', remoteE164: '+15125550123', contactName: 'Priya Shah', contactUserId: id(403), contactSchools: ['Lotus Jiu-Jitsu'], staffName: 'Dana Wu', outcome: 'FOLLOW_UP' }),
  call(4, { status: 'MISSED', remoteE164: null }),
];
const overview = () => ({ callingOn: true, voicemailGreeting: 'Thanks for calling HON HQ. Leave a message and we will call you back today.', version: 2,
  hqNumber: '+15125550100', numberReady: true, ringMe, canManage: true, unheardVoicemails: 1, missedToday: 1,
  staff: [{ principalId: id(501), name: 'Dana Wu', ringMe: true }, { principalId: id(502), name: 'Sam Rivera', ringMe: false }] });
const token = () => tokenState === 'READY'
  ? { ready: true, reason: 'READY', identity: `h${'0'.repeat(31)}1`, token: 'synthetic.phone.token', expiresAt: new Date(now + 3_600_000).toISOString(), incoming: false }
  : { ready: false, reason: tokenState, identity: null, token: null, expiresAt: null, incoming: false };
const json = (route, status, body) => route.fulfill({ status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }, body: JSON.stringify(body) });
function api(route) {
  const url = new URL(route.request().url()), path = url.pathname, method = route.request().method();
  report.apiRequests.push(`${method} ${path}${url.search}`);
  if (path === '/api/identity/me') return json(route, 200, { data: { externalSubject: 'hq-calls-synthetic-owner', displayName: 'Synthetic HQ Owner' } });
  if (path === '/api/v1/hq/overview') return json(route, 200, { data: { overview: { asOf: at(0), callerHqRole: 'OWNER', organizationCount: 3, schoolCount: 3,
    onboarding: { availability: 'AVAILABLE', requestCount: 0, inProgressRequestCount: 0, completedRequestCount: 0 }, configuredProviderStates: { disabled: 0, configured: 0, healthy: 0, degraded: 0, unavailable: 0 }, taskProfileCount: 0,
    financialMetrics: { availability: 'UNAVAILABLE', reason: 'No authoritative HQ financial MRR, ARR, cash, or gross-margin projection is available.' },
    aiUsage: { availability: 'UNAVAILABLE', reason: 'No authoritative HQ AI usage or cost projection is available.' },
    durableHqWork: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: 'No durable HQ executive work is recorded or active in HQ-1.' } } } });
  if (path === `${prefix}/overview`) return json(route, 200, { data: overview() });
  if (path === `${prefix}/phone-token`) return json(route, 200, { data: token() });
  if (path === `${prefix}/ring-me`) { ringMe = JSON.parse(route.request().postData() ?? '{}').ringMe; return json(route, 200, { data: { ringMe, version: 1 } }); }
  if (path === prefix) {
    const filter = url.searchParams.get('filter');
    const rows = filter === 'VOICEMAIL' ? calls.filter(c => c.voicemail) : filter === 'MISSED' ? calls.filter(c => c.status === 'MISSED' || c.voicemail)
      : filter === 'OUTGOING' ? calls.filter(c => c.direction === 'OUT') : calls;
    return json(route, 200, { data: { calls: rows, nextCursor: null } });
  }
  return json(route, 403, { code: 'FORBIDDEN' });
}

const probe = createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const session = { mode: 'OIDC', audience: 'hq-calls-browser-synthetic', secret: randomBytes(32).toString('hex') };
const server = spawn(join(webRoot, 'node_modules/.bin/next'), ['start', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: webRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'production', HON_DEPLOYMENT_ENVIRONMENT: 'preview', NEXT_TELEMETRY_DISABLED: '1', HON_API_BASE_URL: 'http://127.0.0.1:9', HON_AUTH_MODE: session.mode, HON_SESSION_AUDIENCE: session.audience, HON_SESSION_JWT_SECRET: session.secret }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; i < 240; i += 1) { try { const r = await fetch(`${origin}/auth/login`); if (r.status < 500) break; } catch { /* starting */ } await new Promise((done) => setTimeout(done, 500)); }

const browser = await chromium.launch();
async function open(viewport, path) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, reducedMotion: 'reduce', timezoneId: 'America/Chicago' });
  await ctx.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: 'hq-calls-synthetic-owner' }, session), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { report.blocked.push(url.origin); return route.abort(); }
    if (url.pathname.startsWith('/api/')) return api(route);
    return route.continue();
  });
  const page = await ctx.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(`${origin}${path}`);
  return { ctx, page };
}
async function check(name, work) { try { await work(); report.checks.push(name); } catch (error) { report.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); } }
async function shot(page, name, full = false) { await page.screenshot({ path: join(results, `${name}.png`), fullPage: full }); report.screenshots.push(`${name}.png`); }
const desktop = { width: 1440, height: 900 }, phone = { width: 390, height: 844 };

await check('HQ calls page desktop: log, owner schools, after-call card, settings', async () => {
  const { ctx, page } = await open(desktop, '/hq/communications/calls');
  await page.getByRole('heading', { name: 'HQ calls', level: 1 }).waitFor();
  await page.getByText('HQ number: (512) 555-0100').waitFor();
  await page.getByRole('button', { name: 'Maria Lopez' }).waitFor();
  await page.getByText('Owner of Sunrise Martial Arts').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Unknown caller' }).count(), 1, 'a withheld caller is listed');
  await shot(page, 'hq-calls-page-desktop', true);
  await page.getByRole('button', { name: 'Jordan Kim' }).click();
  await page.getByRole('region', { name: 'Call with Jordan Kim' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Resolved' }).getAttribute('aria-pressed'), 'true');
  await page.getByText(/HQ calls are not recorded\./).first().waitFor();
  await page.getByRole('region', { name: 'Call with Jordan Kim' }).scrollIntoViewIfNeeded();
  await shot(page, 'hq-calls-after-call-card-desktop');
  await page.getByRole('button', { name: 'Maria Lopez' }).click();
  assert.equal(await page.locator('[data-call-recording]').getAttribute('src'), `${prefix}/${calls[0].callId}/recording`);
  assert(!report.apiRequests.some(r => r.includes('/recording')), 'the voicemail is not fetched before the person presses play');
  await page.getByRole('button', { name: 'Voicemail', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Call log"] li').length === 1);
  assert(report.apiRequests.some(r => r.endsWith('/hq/calls?filter=VOICEMAIL')));
  await ctx.close();
});
await check('HQ phone: explains the voice switch, then opens the dialer from a call without dialing', async () => {
  tokenState = 'VOICE_NOT_APPROVED';
  const { ctx, page } = await open(desktop, '/hq/communications/calls');
  await page.getByRole('button', { name: 'Phone' }).click();
  await page.getByText('HQ calling is built but switched off until HON approves voice calls.').waitFor();
  await shot(page, 'hq-phone-not-approved-desktop');
  await ctx.close();
  tokenState = 'READY';
  const second = await open(desktop, '/hq/communications/calls');
  await second.page.getByRole('button', { name: 'Priya Shah' }).click();
  await second.page.getByRole('button', { name: 'Call Priya Shah' }).click();
  await second.page.getByRole('region', { name: 'Call from the HQ number' }).waitFor();
  assert.equal(await second.page.locator('#hon-phone-number').inputValue(), '(512) 555-0123');
  await shot(second.page, 'hq-phone-dialer-desktop');
  assert(!report.apiRequests.some(r => r === 'POST /api/v1/hq/calls'), 'opening the dialer never starts a call');
  await second.ctx.close();
});
await check('HQ calls page phone width: no horizontal scroll', async () => {
  const { ctx, page } = await open(phone, '/hq/communications/calls');
  await page.getByRole('button', { name: 'Maria Lopez' }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
  await shot(page, 'hq-calls-page-phone', true);
  await ctx.close();
});

await browser.close(); server.kill('SIGTERM');
report.blocked = [...new Set(report.blocked)];
await writeFile(join(results, 'report.json'), JSON.stringify(report, null, 2));
if (report.failures.length || report.pageErrors.length) { console.error(JSON.stringify({ failures: report.failures, pageErrors: report.pageErrors }, null, 2)); console.error(serverLog.slice(-2000)); process.exit(1); }
console.log(`HQ calls browser: ${report.checks.length} checks passed, ${report.screenshots.length} screenshots, blocked origins: ${report.blocked.join(', ') || 'none'}`);
