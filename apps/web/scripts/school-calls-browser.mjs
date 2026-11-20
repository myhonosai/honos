/**
 * Disposable local browser proof for the Calls page and the top-bar phone (0556). Synthetic fixtures only: every /api
 * request is answered in the browser by this script and every other origin is blocked, so no database, Twilio or
 * production backend is reached. Requires `pnpm build` first.
 *
 *   HON_CALLS_BROWSER_LOCAL=1 HON_CALLS_BROWSER_RESULTS=<dir> node apps/web/scripts/school-calls-browser.mjs
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
const school = { organizationId: id(1), schoolId: id(2) };
const prefix = `/api/v1/organizations/${school.organizationId}/schools/${school.schoolId}`;
const report = { syntheticFixturesOnly: true, databaseAccess: false, providerCalls: false, checks: [], failures: [], screenshots: [], pageErrors: [], apiRequests: [], blocked: [] };
const now = Date.parse('2026-11-19T18:00:00.000Z'), at = (minutes) => new Date(now - minutes * 60_000).toISOString();
let tokenState = 'VOICE_NOT_APPROVED', version = 3, ringMe = false, callingOn = true;
const call = (n, patch) => ({ callId: id(900 - n), direction: 'IN', status: 'COMPLETED', remoteE164: '+15125550101', personId: null, contactName: null, staffName: null,
  startedAt: at(n * 37), answeredAt: null, endedAt: at(n * 37 - 2), durationSeconds: null, recorded: false, voicemail: false, recordingAvailable: false, recordingSeconds: null,
  heard: false, outcome: null, note: null, doNotCall: false, version: 1, ...patch });
const calls = [
  call(1, { status: 'VOICEMAIL', remoteE164: '+15125550142', contactName: 'Maria Lopez', personId: id(401), voicemail: true, recordingAvailable: true, recordingSeconds: 34 }),
  call(2, { status: 'COMPLETED', remoteE164: '+15125550188', contactName: 'Jordan Kim', personId: id(402), staffName: 'Sam Rivera', answeredAt: at(73), durationSeconds: 312, outcome: 'TRIAL_BOOKED', note: 'Booked Saturday 10 AM Little Tigers trial for her son.' }),
  call(3, { direction: 'OUT', status: 'NO_ANSWER', remoteE164: '+15125550123', contactName: 'Priya Shah', personId: id(403), staffName: 'Sam Rivera', outcome: 'LEFT_VOICEMAIL' }),
  call(4, { status: 'MISSED', remoteE164: '+17375550199' }),
  call(5, { direction: 'OUT', status: 'COMPLETED', remoteE164: '+15125550177', contactName: 'Chris Park', personId: id(404), staffName: 'Alex Moore', answeredAt: at(183), durationSeconds: 95, outcome: 'CALL_BACK' }),
];
const overview = () => ({ callingOn, voicemailGreeting: 'Thanks for calling Sunrise Martial Arts. Leave a message and we will call you back today.', recordingOn: false, recordingConsentAt: null,
  version, schoolNumber: '+15125550100', numberReady: true, forwardingPhoneSet: true, missedCallTextBack: true, ringMe, canManage: true, unheardVoicemails: 1, missedToday: 1,
  staff: [{ principalId: id(501), name: 'Sam Rivera', ringMe: true }, { principalId: id(502), name: 'Alex Moore', ringMe: false }] });
const token = () => tokenState === 'READY'
  ? { ready: true, reason: 'READY', identity: `u${'0'.repeat(31)}1`, token: 'synthetic.phone.token', expiresAt: new Date(now + 3_600_000).toISOString(), incoming: false }
  : { ready: false, reason: tokenState, identity: null, token: null, expiresAt: null, incoming: false };
const json = (route, status, body) => route.fulfill({ status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }, body: JSON.stringify(body) });
function api(route) {
  const url = new URL(route.request().url()), path = url.pathname, method = route.request().method();
  report.apiRequests.push(`${method} ${path}${url.search}`);
  if (path === '/api/identity/me') return json(route, 200, { data: { externalSubject: 'calls-synthetic-owner', displayName: 'Synthetic Owner' } });
  if (path === '/api/v1/staff/current-reporting-school') return json(route, 200, { data: { state: 'RESOLVED', ...school } });
  if (path === '/api/v1/staff/reporting-schools') return json(route, 200, { data: { state: 'MANUAL_ENTRY_REQUIRED' } });
  if (path === `${prefix}/interface-theme`) return json(route, 200, { data: { interfaceTheme: 'modern', selectedVia: 'SETTINGS', updatedAt: at(0) }, meta: {} });
  // The shell verifies the school with the operations snapshot before any page loads.
  if (path === `${prefix}/reports/operations`) return json(route, 200, { data: { operationalSnapshot: { organizationId: school.organizationId, schoolId: school.schoolId,
    generatedAt: at(0), from: at(43_200), to: at(0), studentProfiles: { total: 148 }, leads: { byStatus: { OPEN: 23, WON: 9, LOST: 4, ARCHIVED: 2 } },
    classSessions: { inRange: { scheduled: 64, completed: 58, cancelled: 2 } }, attendance: { inRangeByStatus: { PRESENT: 812, LATE: 31, EXCUSED_ABSENCE: 22, UNEXCUSED_ABSENCE: 15, MAKEUP: 6 } },
    memberships: { byState: { DRAFT: 3, ACTIVE: 131, FROZEN: 4, CANCELLATION_PENDING: 2, CANCELLED: 7, EXPIRED: 5 } }, invoices: { inRangeByStatus: { DRAFT: 2, ISSUED: 6, PAID: 118, VOID: 1, UNCOLLECTIBLE: 0 } },
    paymentAttempts: { inRangeByState: { PENDING: 0, PROCESSING: 1, SUCCEEDED: 118, FAILED: 3, REQUIRES_ACTION: 0, UNKNOWN: 0, REFUNDED: 1 } } } }, meta: {} });
  if (path === `${prefix}/calls/overview`) return json(route, 200, { data: overview(), meta: {} });
  if (path === `${prefix}/calls/phone-token`) return json(route, 200, { data: token(), meta: {} });
  if (path === `${prefix}/calls/ring-me`) { ringMe = JSON.parse(route.request().postData() ?? '{}').ringMe; version += 1; return json(route, 200, { data: { ringMe, version: 1 }, meta: {} }); }
  if (path === `${prefix}/calls`) {
    const filter = url.searchParams.get('filter');
    const rows = filter === 'VOICEMAIL' ? calls.filter(c => c.voicemail) : filter === 'MISSED' ? calls.filter(c => c.status === 'MISSED' || c.voicemail)
      : filter === 'OUTGOING' ? calls.filter(c => c.direction === 'OUT') : calls;
    return json(route, 200, { data: { calls: rows, nextCursor: null }, meta: {} });
  }
  return json(route, 403, { code: 'FORBIDDEN' });
}

const probe = createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const session = { mode: 'OIDC', audience: 'school-calls-browser-synthetic', secret: randomBytes(32).toString('hex') };
const server = spawn(join(webRoot, 'node_modules/.bin/next'), ['start', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: webRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'production', HON_DEPLOYMENT_ENVIRONMENT: 'preview', NEXT_TELEMETRY_DISABLED: '1', HON_API_BASE_URL: 'http://127.0.0.1:9', HON_AUTH_MODE: session.mode, HON_SESSION_AUDIENCE: session.audience, HON_SESSION_JWT_SECRET: session.secret }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; i < 240; i += 1) { try { const r = await fetch(`${origin}/auth/login`); if (r.status < 500) break; } catch { /* starting */ } await new Promise((done) => setTimeout(done, 500)); }

const browser = await chromium.launch();
async function open(viewport, path) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, reducedMotion: 'reduce', timezoneId: 'America/Chicago' });
  await ctx.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: 'calls-synthetic-owner' }, session), url: origin, httpOnly: true, sameSite: 'Lax' }]);
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

await check('calls page desktop: log, after-call card, settings', async () => {
  const { ctx, page } = await open(desktop, '/staff/calls');
  await page.getByRole('heading', { name: 'Calls', level: 1 }).waitFor();
  await page.getByText('School number: (512) 555-0100').waitFor();
  await page.getByRole('button', { name: 'Maria Lopez' }).waitFor();
  assert.equal(await page.getByText('New voicemail', { exact: true }).count(), 1);
  await shot(page, 'calls-page-desktop', true);
  await page.getByRole('button', { name: 'Jordan Kim' }).click();
  await page.getByRole('region', { name: 'Call with Jordan Kim' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Trial booked' }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('region', { name: 'Call with Jordan Kim' }).scrollIntoViewIfNeeded();
  await shot(page, 'calls-after-call-card-desktop');
  await page.getByRole('button', { name: 'Maria Lopez' }).click();
  assert.equal(await page.locator('[data-call-recording]').getAttribute('src'), `${prefix}/calls/${calls[0].callId}/recording`);
  assert.equal(await page.locator('[data-call-recording]').getAttribute('preload'), 'none', 'nothing is fetched until play');
  assert(!report.apiRequests.some(r => r.includes('/recording')), 'the recording is not fetched before the person presses play');
  await page.getByRole('region', { name: 'Call with Maria Lopez' }).scrollIntoViewIfNeeded();
  await shot(page, 'calls-voicemail-card-desktop');
  await page.getByRole('button', { name: 'Voicemail', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Call log"] li').length === 1);
  assert(report.apiRequests.some(r => r.endsWith('/calls?filter=VOICEMAIL')));
  await ctx.close();
});
await check('phone: explains why calling is switched off, then dials only after the token is ready', async () => {
  tokenState = 'VOICE_NOT_APPROVED';
  const { ctx, page } = await open(desktop, '/staff/calls');
  await page.getByRole('button', { name: 'Phone' }).click();
  await page.getByText('Calling is built but switched off until HON approves voice calls for schools.').waitFor();
  await shot(page, 'phone-not-approved-desktop');
  await ctx.close();
  tokenState = 'READY';
  const second = await open(desktop, '/staff/calls');
  await second.page.getByRole('button', { name: 'Maria Lopez' }).click();
  await second.page.getByRole('button', { name: 'Call Maria Lopez' }).click();
  await second.page.getByRole('region', { name: 'Call from the school number' }).waitFor();
  assert.equal(await second.page.locator('#hon-phone-number').inputValue(), '(512) 555-0142');
  await shot(second.page, 'phone-dialer-desktop');
  assert(!report.apiRequests.some(r => r.startsWith('POST') && r.endsWith('/calls')), 'opening the dialer never starts a call');
  await second.ctx.close();
});
await check('calls page phone width: no horizontal scroll', async () => {
  tokenState = 'READY';
  const { ctx, page } = await open(phone, '/staff/calls');
  await page.getByRole('button', { name: 'Maria Lopez' }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
  await shot(page, 'calls-page-phone', true);
  await page.getByRole('button', { name: 'Phone' }).click();
  await page.getByRole('region', { name: 'Call from the school number' }).waitFor();
  await shot(page, 'phone-dialer-phone');
  await ctx.close();
});

await browser.close(); server.kill('SIGTERM');
report.blocked = [...new Set(report.blocked)];
await writeFile(join(results, 'report.json'), JSON.stringify(report, null, 2));
if (report.failures.length || report.pageErrors.length) { console.error(JSON.stringify({ failures: report.failures, pageErrors: report.pageErrors }, null, 2)); console.error(serverLog.slice(-2000)); process.exit(1); }
console.log(`school calls browser: ${report.checks.length} checks passed, ${report.screenshots.length} screenshots, blocked origins: ${report.blocked.join(', ') || 'none'}`);
