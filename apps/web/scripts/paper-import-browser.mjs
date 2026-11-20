/**
 * Disposable local browser proof for Import from photos (0388). Synthetic fixtures only: every /api request is answered in
 * the browser by this script, which keeps one in-memory photo set the way the server does (versions, one reading, save,
 * send, delete). No database, AI provider, payment or production backend is used. Requires `pnpm build` first.
 *
 *   HON_PAPER_BROWSER_LOCAL=1 HON_PAPER_BROWSER_RESULTS=<dir> node apps/web/scripts/paper-import-browser.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { issueSession, HON_SESSION_COOKIE } from '@hon/auth';

if (process.env.HON_PAPER_BROWSER_LOCAL !== '1') throw new Error('Opt in with HON_PAPER_BROWSER_LOCAL=1.');
for (const key of ['DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY']) {
  if (process.env[key]) throw new Error('Browser verification refuses inherited database/provider credentials.');
}
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = process.env.HON_PAPER_BROWSER_RESULTS;
assert(results, 'HON_PAPER_BROWSER_RESULTS is required.');
const { chromium } = createRequire(import.meta.url)(process.env.HON_SHELL_PLAYWRIGHT ?? 'playwright');
await mkdir(results, { recursive: true });

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const school = { organizationId: id(1), schoolId: id(2) }, prefix = `/api/v1/organizations/${school.organizationId}/schools/${school.schoolId}/paper-imports`;
const report = { syntheticFixturesOnly: true, databaseAccess: false, providerCalls: false, checks: [], failures: [], screenshots: [], pageErrors: [], commands: [] };
const COLUMNS = ['studentGivenName', 'studentFamilyName', 'birthDate', 'studentEmail', 'studentMobile', 'guardianGivenName', 'guardianFamilyName', 'guardianEmail', 'guardianMobile', 'familyKey'];
const READ_ROW = ['Mina', 'Park', '2017-03-14', '', '', 'Grace', 'Park', 'grace.park@example.com', '+12135550142', ''];
let sets = [], aiBlocked = false, notSetUp = false, seen = new Map();
const now = () => new Date().toISOString();
const summary = (s) => ({ id: s.id, kind: s.kind, target: 'STUDENTS', version: s.version, status: s.status, pageCount: s.pages.length, reader: s.readAt ? s.reader : null,
  readOutcome: s.readAt ? s.outcome : null, sentBatchId: s.sentAt ? id(900) : null, createdAt: s.createdAt, expiresAt: new Date(Date.parse(s.createdAt) + 30 * 86_400_000).toISOString(),
  readAt: s.readAt, sentAt: s.sentAt, deletedAt: s.deletedAt, deleteReason: s.deletedAt ? 'STAFF' : null });
const detail = (s) => ({ set: summary(s), columns: COLUMNS, rows: s.rows, unsure: s.unsure,
  pages: s.pages.map((p, i) => ({ pageNo: i + 1, mediaType: p.mediaType, bytes: Buffer.from(p.data, 'base64').length, checksum: p.checksum })), aiReading: s.aiReading ?? null });
const snapshot = () => ({
  ...school, generatedAt: '2026-11-06T09:00:00.000Z', from: '2026-10-07T09:00:00.000Z', to: '2026-11-06T09:00:00.000Z',
  studentProfiles: { total: 0 }, leads: { byStatus: { OPEN: 0, WON: 0, LOST: 0, ARCHIVED: 0 } },
  classSessions: { inRange: { scheduled: 0, completed: 0, cancelled: 0 } },
  attendance: { inRangeByStatus: { PRESENT: 0, LATE: 0, EXCUSED_ABSENCE: 0, UNEXCUSED_ABSENCE: 0, MAKEUP: 0 } },
  memberships: { byState: { DRAFT: 0, ACTIVE: 0, FROZEN: 0, CANCELLATION_PENDING: 0, CANCELLED: 0, EXPIRED: 0 } },
  invoices: { inRangeByStatus: { DRAFT: 0, ISSUED: 0, PAID: 0, VOID: 0, UNCOLLECTIBLE: 0 } },
  paymentAttempts: { inRangeByState: { PENDING: 0, PROCESSING: 0, SUCCEEDED: 0, FAILED: 0, REQUIRES_ACTION: 0, UNKNOWN: 0, REFUNDED: 0 } },
});
const meta = { requestId: id(5), correlationId: id(5) };
const json = (route, status, body) => route.fulfill({ status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }, body: JSON.stringify(body) });
const ok = (route, data) => json(route, 200, { data, meta });

const seenPaths = [];
function api(route) {
  seenPaths.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
  const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
  if (path === '/api/identity/me') return json(route, 200, { data: { externalSubject: 'paper-synthetic-staff', displayName: 'Synthetic Staff' } });
  if (path === '/api/v1/staff/current-reporting-school') return json(route, 200, { data: { state: 'RESOLVED', ...school } });
  if (path === '/api/v1/staff/reporting-schools') return json(route, 200, { data: { state: 'MANUAL_ENTRY_REQUIRED' } });
  if (path.endsWith('/interface-theme')) return json(route, 200, { data: { interfaceTheme: 'modern', selectedVia: 'SETTINGS', updatedAt: now() }, meta: {} });
  if (path.endsWith('/reports/operations')) return json(route, 200, { data: { operationalSnapshot: snapshot() }, meta: {} });
  if (!path.startsWith(prefix)) return json(route, 403, { code: 'FORBIDDEN' });
  const headers = request.headers(), key = headers['idempotency-key'] ?? null, body = request.postData() ? JSON.parse(request.postData()) : null;
  if (method === 'POST') {
    report.commands.push({ path: path.slice(prefix.length) || '/', command: headers['x-hon-human-command'], key: key !== null });
    if (key && seen.has(key)) return ok(route, seen.get(key));
  }
  const parts = path.slice(prefix.length).split('/').filter(Boolean), s = parts[0] ? sets.find((x) => x.id === parts[0]) : null;
  const answer = (data) => { if (key) seen.set(key, data); return ok(route, data); };
  if (method === 'GET' && parts.length === 0) return ok(route, { sets: sets.map(summary), maxPages: 10, maxPageBytes: 1400000, maxRows: 200, retentionDays: 30 });
  if (method === 'POST' && parts.length === 0) {
    const created = { id: id(100 + sets.length), kind: body.kind, version: 1, status: 'OPEN', pages: [], rows: [], unsure: [], createdAt: now(), readAt: null, sentAt: null, deletedAt: null };
    sets.unshift(created); return answer(summary(created));
  }
  if (!s) return json(route, 404, { code: 'PAPER_IMPORT_NOT_FOUND' });
  if (method === 'GET' && parts.length === 1) return ok(route, detail(s));
  if (method === 'GET' && parts[1] === 'pages') { const p = s.pages[Number(parts[2]) - 1]; return p ? ok(route, { pageNo: Number(parts[2]), mediaType: p.mediaType, data: p.data }) : json(route, 404, { code: 'PAPER_IMPORT_NOT_FOUND' }); }
  if (body?.expectedVersion !== undefined && body.expectedVersion !== s.version) return json(route, 409, { code: 'VERSION_CONFLICT' });
  if (parts[1] === 'pages') {
    const checksum = createHash('sha256').update(Buffer.from(body.data, 'base64')).digest('hex');
    if (s.pages.some((p) => p.checksum === checksum)) return json(route, 409, { code: 'PAPER_IMPORT_PAGE_DUPLICATE' });
    s.pages.push({ mediaType: body.mediaType, data: body.data, checksum }); s.version++; return answer(summary(s));
  }
  if (parts[1] === 'reading') {
    if (aiBlocked) return json(route, 403, { code: 'PAPER_IMPORT_AI_BLOCKED', reason: 'AI_SPEND_PAUSED' });
    // 0594: with no photo-reading route the reading is refused before anything is sent; the set stays open.
    if (notSetUp && s.status === 'OPEN') { s.aiReading = { status: 'BLOCKED', reason: 'NO_ELIGIBLE_ROUTE' }; s.version++; return ok(route, detail(s)); }
    if (s.status === 'OPEN') { s.status = 'READ'; s.reader = 'SYNTHETIC'; s.outcome = 'SAMPLE_READ'; s.readAt = now(); s.version++; s.rows = [READ_ROW]; s.unsure = [READ_ROW.map((_, i) => i === 8)]; }
    return ok(route, detail(s));
  }
  if (parts[1] === 'typed') {
    if (s.status === 'OPEN') { s.status = 'READ'; s.reader = 'NONE'; s.outcome = 'TYPED'; s.readAt = now(); s.version++; s.rows = []; s.unsure = []; }
    return ok(route, detail(s));
  }
  if (parts[1] === 'table') { s.rows = body.rows; s.unsure = body.unsure; s.version++; return answer(summary(s)); }
  if (parts[1] === 'send') { s.status = 'SENT'; s.sentAt = now(); s.version++; return answer(summary(s)); }
  if (parts[1] === 'delete') { s.status = 'DELETED'; s.deletedAt = now(); s.pages = []; s.rows = []; s.unsure = []; s.version++; return answer(summary(s)); }
  return json(route, 400, { code: 'PAPER_IMPORT_INVALID' });
}

const probe = createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const session = { mode: 'OIDC', audience: 'paper-import-browser-synthetic', secret: randomBytes(32).toString('hex') };
const server = spawn(join(webRoot, 'node_modules/.bin/next'), ['start', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: webRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'production', HON_DEPLOYMENT_ENVIRONMENT: 'preview', NEXT_TELEMETRY_DISABLED: '1', HON_API_BASE_URL: 'http://127.0.0.1:9', HON_AUTH_MODE: session.mode, HON_SESSION_AUDIENCE: session.audience, HON_SESSION_JWT_SECRET: session.secret }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; i < 240; i += 1) { try { const r = await fetch(`${origin}/auth/login`); if (r.status < 500) break; } catch { /* starting */ } await new Promise((done) => setTimeout(done, 500)); }

const browser = await chromium.launch();
async function open(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await ctx.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: 'paper-synthetic-staff' }, session), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/api/')) return api(route);
    return route.continue();
  });
  const page = await ctx.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(`${origin}/staff/migration/photos`);
  current = page;
  await page.getByRole('heading', { name: 'Import from photos', level: 1 }).waitFor();
  return { ctx, page };
}
let current = null;
async function check(name, work) { try { await work(); report.checks.push(name); } catch (error) { if (current) await current.screenshot({ path: join(results, `failure-${report.failures.length}.png`), fullPage: true }).catch(() => {}); report.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); } }
async function shot(page, name, fullPage = false) { await page.screenshot({ path: join(results, `${name}.png`), fullPage }); report.screenshots.push(`${name}.png`); }

await check('start a set, add the sample page twice (duplicate refused), read it, fix a cell, save, send', async () => {
  sets = []; seen = new Map(); aiBlocked = false; notSetUp = false;
  const { ctx, page } = await open({ width: 1440, height: 900 });
  await page.getByText('What are you photographing?').waitFor();
  await page.getByText('HON reads your own photos when your school has the AI team').waitFor();
  await shot(page, 'paper-import-start-desktop');
  await page.getByTestId('paper-import-create').click();
  await page.getByTestId('paper-import-photos').waitFor();
  await page.getByTestId('paper-import-sample').click();
  await page.getByText('1 of 10 photos').waitFor();
  await page.getByTestId('paper-import-image').waitFor();
  await page.getByTestId('paper-import-sample').click();
  await page.getByText('That photo is already in this set.').waitFor();
  assert.equal(await page.getByText('1 of 10 photos').count(), 1);
  await shot(page, 'paper-import-photos-desktop');
  await page.getByRole('button', { name: 'Read with HON', exact: true }).click();
  await page.getByTestId('paper-import-table').waitFor();
  await page.getByText('HON read the sample page.').waitFor();
  const mobile = page.getByLabel('Parent mobile (+1…) 1', { exact: true });
  assert.equal(await mobile.inputValue(), '+12135550142');
  assert.equal(await page.locator('td[data-unsure="true"]').count(), 1);
  await shot(page, 'paper-import-table-desktop', true);
  await mobile.fill('+12135550143');
  assert.equal(await page.locator('td[data-unsure="true"]').count(), 0, 'editing a cell clears its check mark');
  await page.getByText('You have changes that are not saved.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Send to review', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Add row', exact: true }).click();
  await page.getByLabel('Student first name 2', { exact: true }).fill('  Leo ');
  await page.getByLabel('Student last name 2', { exact: true }).fill('Santos');
  await page.getByTestId('paper-import-save').click();
  await page.getByText('Table saved.').waitFor();
  assert.deepEqual(sets[0].rows.map((r) => [r[0], r[8]]), [['Mina', '+12135550143'], ['Leo', '']], 'saved cells are trimmed');
  await page.getByRole('button', { name: 'Send to review', exact: true }).click();
  await page.getByTestId('paper-import-sent').waitFor();
  await page.getByText('Sent 2 rows to the student import review.').waitFor();
  assert.equal(await page.getByRole('link', { name: 'Open Import students' }).getAttribute('href'), '/staff/migration/students');
  await shot(page, 'paper-import-sent-desktop');
  const commands = report.commands.map((c) => `${c.command}:${c.key}`);
  assert.deepEqual([...new Set(commands)], ['students.paper_import.create:true', 'students.paper_import.page:true', 'students.paper_import.reading:false', 'students.paper_import.save:true', 'students.paper_import.send:true']);
  await ctx.close();
});

await check('an AI pause stops the reading and says nothing was read', async () => {
  sets = []; seen = new Map(); aiBlocked = true;
  const { ctx, page } = await open({ width: 1440, height: 900 });
  await page.getByTestId('paper-import-create').click();
  await page.getByTestId('paper-import-sample').click();
  await page.getByText('1 of 10 photos').waitFor();
  await page.getByRole('button', { name: 'Read with HON', exact: true }).click();
  await page.getByText('Nothing was read. You can type the rows yourself, or try later.').waitFor();
  assert.equal(sets[0].status, 'OPEN');
  await ctx.close();
});

await check('with photo reading not set up, HON says so and staff type the rows themselves (no key, no AI)', async () => {
  sets = []; seen = new Map(); aiBlocked = false; notSetUp = true; report.commands = [];
  const { ctx, page } = await open({ width: 1440, height: 900 });
  await page.getByTestId('paper-import-create').click();
  await page.getByTestId('paper-import-sample').click();
  await page.getByText('1 of 10 photos').waitFor();
  await page.getByRole('button', { name: 'Read with HON', exact: true }).click();
  await page.getByText('Photo reading is not set up for this school yet.').waitFor();
  assert.equal(sets[0].status, 'OPEN');
  await shot(page, 'paper-import-not-set-up-desktop');
  await page.getByRole('button', { name: 'Type the rows myself', exact: true }).click();
  await page.getByTestId('paper-import-table').waitFor();
  await page.getByText('Type the rows from the photo into the table.').waitFor();
  assert.equal(sets[0].outcome, 'TYPED');
  await page.getByLabel('Student first name 1', { exact: true }).fill('Ava');
  await page.getByTestId('paper-import-save').click();
  await page.getByText('Table saved.').waitFor();
  const typed = report.commands.find((c) => c.path.endsWith('/typed'));
  assert.deepEqual({ command: typed?.command, key: typed?.key }, { command: 'students.paper_import.typed', key: false });
  await ctx.close();
});

await check('delete asks first, then erases the photos and the table; works at phone width without sideways scroll', async () => {
  sets = []; seen = new Map(); aiBlocked = false; notSetUp = false;
  const { ctx, page } = await open({ width: 390, height: 844 });
  await page.getByTestId('paper-import-create').click();
  await page.getByTestId('paper-import-sample').click();
  await page.getByText('1 of 10 photos').waitFor();
  await page.getByRole('button', { name: 'Read with HON', exact: true }).click();
  await page.getByTestId('paper-import-table').waitFor();
  await page.waitForTimeout(150);
  await shot(page, 'paper-import-table-phone', true);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(sideways, false, 'page scrolls sideways at phone width');
  await page.getByRole('button', { name: 'Delete photos', exact: true }).click();
  await page.getByText('Delete these photos and the table now?').waitFor();
  await page.getByRole('button', { name: 'Yes, delete', exact: true }).click();
  await page.getByTestId('paper-import-deleted').waitFor();
  assert.equal(sets[0].pages.length, 0); assert.equal(await page.getByTestId('paper-import-image').count(), 0);
  await ctx.close();
});

await browser.close(); server.kill();
await writeFile(join(results, 'paper-import-browser-report.json'), JSON.stringify(report, null, 2));
if (report.pageErrors.length) report.failures.push(`page errors: ${report.pageErrors.join(' | ')}`);
console.log(JSON.stringify({ checks: report.checks.length, failures: report.failures, screenshots: report.screenshots.length }, null, 2));
if (report.failures.length) { console.error(seenPaths.slice(0, 30).join('\n')); console.error(serverLog.slice(-2000)); process.exit(1); }
