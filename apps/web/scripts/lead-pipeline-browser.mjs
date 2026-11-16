/**
 * Disposable local browser proof for the lead pipeline board (0400). Synthetic fixtures only: every /api request is
 * answered in the browser by this script, which keeps one in-memory pipeline the way the server does (versions, moves,
 * close, stage save). No database, provider, payment or production backend is used. Requires `pnpm build` first.
 *
 *   HON_PIPELINE_BROWSER_LOCAL=1 HON_PIPELINE_BROWSER_RESULTS=<dir> node apps/web/scripts/lead-pipeline-browser.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { issueSession, HON_SESSION_COOKIE } from '@hon/auth';

if (process.env.HON_PIPELINE_BROWSER_LOCAL !== '1') throw new Error('Opt in with HON_PIPELINE_BROWSER_LOCAL=1.');
for (const key of ['DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY']) {
  if (process.env[key]) throw new Error('Browser verification refuses inherited database/provider credentials.');
}
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = process.env.HON_PIPELINE_BROWSER_RESULTS;
assert(results, 'HON_PIPELINE_BROWSER_RESULTS is required.');
const { chromium } = createRequire(import.meta.url)(process.env.HON_SHELL_PLAYWRIGHT ?? 'playwright');
const design = await import('@hon/design-system');
await mkdir(results, { recursive: true });

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const school = { organizationId: id(1), schoolId: id(2) }, prefix = `/api/v1/organizations/${school.organizationId}/schools/${school.schoolId}`;
const report = { syntheticFixturesOnly: true, databaseAccess: false, providerCalls: false, checks: [], failures: [], screenshots: [], pageErrors: [], commands: [] };
const day = (d, h = 17) => `2026-11-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00.000Z`;
const PEOPLE = [['Mina', 'Park', 'KIDS_KARATE', 'WEBSITE_FORM'], ['Leo', 'Santos', 'ADULT_BJJ', 'INSTAGRAM'], ['Ava', 'Kim', 'KIDS_KARATE', 'WALK_IN'],
  ['Noah', 'Lee', 'TEEN_TAEKWONDO', 'REFERRAL'], ['Sofia', 'Garcia', 'ADULT_BJJ', 'GOOGLE'], ['Ethan', 'Cho', null, 'WEBSITE_FORM'], ['Olivia', 'Brown', 'KIDS_KARATE', 'FACEBOOK'],
  ['Lucas', 'Martinez', 'TEEN_TAEKWONDO', null], ['Emma', 'Jung', 'KIDS_KARATE', 'REFERRAL']];
let state;
function reset() {
  state = {
    version: 3, seen: new Map(),
    stages: [
      { id: id(31), name: 'New lead', position: 1, color: 'BLUE', hidden: false, terminalStatus: null },
      { id: id(32), name: 'Contacted', position: 2, color: 'SKY', hidden: false, terminalStatus: null },
      { id: id(33), name: 'Trial booked', position: 3, color: 'AMBER', hidden: false, terminalStatus: null },
      { id: id(34), name: 'Trial done', position: 4, color: 'VIOLET', hidden: false, terminalStatus: null },
      { id: id(35), name: 'Enrolled', position: 5, color: 'GREEN', hidden: false, terminalStatus: 'WON' },
      { id: id(36), name: 'Not now', position: 6, color: 'RED', hidden: false, terminalStatus: 'LOST' },
    ],
    leads: PEOPLE.map(([g, f, program, source], i) => ({ id: id(41 + i), version: 1, status: i === 7 ? 'WON' : i === 8 ? 'LOST' : 'OPEN',
      stageId: [id(31), id(31), id(32), id(33), id(33), id(34), id(31), id(35), id(36)][i], personId: id(61 + i), givenName: g, familyName: f,
      email: `${g.toLowerCase()}@example.invalid`, phoneE164: `+1555555${String(100 + i).padStart(4, '0')}`, programInterestCode: program, sourceCode: source,
      createdAt: day(1 + i, 15), closedAt: i >= 7 ? day(12) : null, nextTrialAt: i === 3 || i === 4 ? day(19 + i) : null, lastTrialAt: i === 5 ? day(10) : null })),
  };
}
const openCount = (s) => state.leads.filter((l) => l.stageId === s.id && l.status === 'OPEN').length;
const stagesJson = () => state.stages.map((s) => ({ ...s, openCount: openCount(s) }));
function board(status) {
  const allowed = status === 'CLOSED' ? ['WON', 'LOST'] : [status];
  const leads = state.leads.filter((l) => allowed.includes(l.status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const count = (st) => state.leads.filter((l) => l.status === st).length;
  return { pipelines: [{ id: id(20), name: 'Default', version: state.version }], pipeline: { id: id(20), name: 'Default', version: state.version }, stages: stagesJson(),
    totals: { open: count('OPEN'), won: count('WON'), lost: count('LOST') }, status, leads, truncated: false, limit: 500 };
}
let theme = 'modern';
const meta = { requestId: id(5), correlationId: id(5) };
const json = (route, status, body) => route.fulfill({ status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }, body: JSON.stringify(body) });
const ok = (route, data, replayed) => json(route, 200, { data, meta: replayed === undefined ? meta : { ...meta, replayed } });
const now = () => new Date().toISOString();
const snapshot = () => ({
  ...school, generatedAt: '2026-11-06T09:00:00.000Z', from: '2026-10-07T09:00:00.000Z', to: '2026-11-06T09:00:00.000Z',
  studentProfiles: { total: 0 }, leads: { byStatus: { OPEN: 0, WON: 0, LOST: 0, ARCHIVED: 0 } }, classSessions: { inRange: { scheduled: 0, completed: 0, cancelled: 0 } },
  attendance: { inRangeByStatus: { PRESENT: 0, LATE: 0, EXCUSED_ABSENCE: 0, UNEXCUSED_ABSENCE: 0, MAKEUP: 0 } },
  memberships: { byState: { DRAFT: 0, ACTIVE: 0, FROZEN: 0, CANCELLATION_PENDING: 0, CANCELLED: 0, EXPIRED: 0 } },
  invoices: { inRangeByStatus: { DRAFT: 0, ISSUED: 0, PAID: 0, VOID: 0, UNCOLLECTIBLE: 0 } },
  paymentAttempts: { inRangeByState: { PENDING: 0, PROCESSING: 0, SUCCEEDED: 0, FAILED: 0, REQUIRES_ACTION: 0, UNKNOWN: 0, REFUNDED: 0 } },
});

const seenPaths = [];
function api(route) {
  const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
  seenPaths.push(`${method} ${path}`);
  if (path === '/api/identity/me') return json(route, 200, { data: { externalSubject: 'pipeline-synthetic-staff', displayName: 'Synthetic Staff' } });
  if (path === '/api/v1/staff/current-reporting-school') return json(route, 200, { data: { state: 'RESOLVED', ...school } });
  if (path === '/api/v1/staff/reporting-schools') return json(route, 200, { data: { state: 'MANUAL_ENTRY_REQUIRED' } });
  if (path.endsWith('/interface-theme')) return json(route, 200, { data: { interfaceTheme: theme, selectedVia: 'SETTINGS', updatedAt: now() }, meta: {} });
  if (path.endsWith('/reports/operations')) return json(route, 200, { data: { operationalSnapshot: snapshot() }, meta: {} });
  if (!path.startsWith(`${prefix}/crm/`)) return json(route, 403, { code: 'FORBIDDEN' });
  const rest = path.slice(`${prefix}/crm/`.length).split('/');
  const headers = request.headers(), key = headers['idempotency-key'] ?? null, body = request.postData() ? JSON.parse(request.postData()) : null;
  if (method === 'GET' && rest[0] === 'pipeline-board') return ok(route, board(url.searchParams.get('status') ?? 'OPEN'));
  if (method === 'GET' && rest[0] === 'leads' && rest[2] === 'trials') {
    const lead = state.leads.find((l) => l.id === rest[1]);
    const trials = lead?.nextTrialAt || lead?.lastTrialAt ? [{ id: id(80), crmLeadId: lead.id, appointmentType: 'TRIAL', status: lead.nextTrialAt ? 'SCHEDULED' : 'COMPLETED',
      startsAt: lead.nextTrialAt ?? lead.lastTrialAt, endsAt: new Date(Date.parse(lead.nextTrialAt ?? lead.lastTrialAt) + 3600000).toISOString(), createdByPrincipalId: id(9), version: 1, createdAt: day(1), updatedAt: day(1), location: 'Main mat' }] : [];
    return ok(route, { activeTrial: trials.find((t) => t.status === 'SCHEDULED') ?? null, trials });
  }
  if (method !== 'POST') return json(route, 404, { code: 'NOT_FOUND' });
  report.commands.push({ path: rest.join('/').replace(/[0-9a-f-]{36}/g, ':id'), command: headers['x-hon-human-command'], key: key !== null, origin: headers.origin ?? null });
  if (key && state.seen.has(key)) return ok(route, state.seen.get(key), true);
  const answer = (data) => { if (key) state.seen.set(key, data); return ok(route, data, false); };
  if (rest[0] === 'leads' && rest[2] === 'stage') {
    const lead = state.leads.find((l) => l.id === rest[1]), target = state.stages.find((s) => s.id === body.stageId);
    if (!lead || lead.status !== 'OPEN') return json(route, 404, { code: 'CRM_LEAD_UNAVAILABLE' });
    if (lead.version !== body.expectedVersion) return json(route, 409, { code: 'VERSION_CONFLICT' });
    if (!target || target.terminalStatus || target.hidden || target.id === lead.stageId) return json(route, 400, { code: 'CRM_STAGE_NOT_ALLOWED' });
    const from = lead.stageId; lead.stageId = target.id; lead.version++;
    return answer({ ...school, leadId: lead.id, pipelineId: id(20), fromStageId: from, stageId: target.id, priorVersion: lead.version - 1, version: lead.version, movedAt: now() });
  }
  if (rest[0] === 'leads' && rest[2] === 'close') {
    const lead = state.leads.find((l) => l.id === rest[1]);
    if (!lead || lead.status !== 'OPEN') return json(route, 404, { code: 'CRM_LEAD_UNAVAILABLE' });
    if (lead.version !== body.expectedVersion) return json(route, 409, { code: 'VERSION_CONFLICT' });
    lead.status = body.status; lead.version++; lead.closedAt = now();
    return answer({ ...school, leadId: lead.id, status: lead.status, priorVersion: lead.version - 1, version: lead.version, closedAt: lead.closedAt, closeNote: body.closeNote ?? null, crmOnly: true });
  }
  if (rest[0] === 'pipelines' && rest[2] === 'stages') {
    if (body.expectedVersion !== state.version) return json(route, 409, { code: 'VERSION_CONFLICT' });
    const terminal = state.stages.filter((s) => s.terminalStatus);
    const moves = body.moves.map((m) => { const leads = state.leads.filter((l) => l.stageId === m.fromStageId && l.status === 'OPEN'); leads.forEach((l) => { l.stageId = m.toStageId; l.version++; }); return { ...m, count: leads.length }; });
    state.stages = [...body.stages.map((s, i) => ({ id: s.id ?? id(500 + i), name: s.name, position: i + 1, color: s.color, hidden: s.hidden, terminalStatus: null })),
      ...terminal.map((s, i) => ({ ...s, position: body.stages.length + 1 + i }))];
    state.version++;
    return answer({ ...school, pipelineId: id(20), priorVersion: state.version - 1, version: state.version, stages: stagesJson(), moves, savedAt: now() });
  }
  return json(route, 400, { code: 'VALIDATION_FAILED' });
}

const probe = createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const session = { mode: 'OIDC', audience: 'lead-pipeline-browser-synthetic', secret: randomBytes(32).toString('hex') };
const server = spawn(join(webRoot, 'node_modules/.bin/next'), ['start', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: webRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8',
  NODE_ENV: 'production', HON_DEPLOYMENT_ENVIRONMENT: 'preview', NEXT_TELEMETRY_DISABLED: '1', HON_API_BASE_URL: 'http://127.0.0.1:9', HON_AUTH_MODE: session.mode,
  HON_SESSION_AUDIENCE: session.audience, HON_SESSION_JWT_SECRET: session.secret }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; i < 240; i += 1) { try { const r = await fetch(`${origin}/auth/login`); if (r.status < 500) break; } catch { /* starting */ } await new Promise((done) => setTimeout(done, 500)); }
const browser = await chromium.launch();
const TITLES = { en: 'Leads', ko: '문의', es: 'Prospectos' };
let current = null;
async function open(viewport, { language = 'en', mode = 'modern' } = {}) {
  theme = mode;
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await ctx.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: 'pipeline-synthetic-staff' }, session), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  const localeScope = createHmac('sha256', session.secret).update(JSON.stringify(['hon-local-presentation-v1', session.mode, session.audience, 'pipeline-synthetic-staff'])).digest('hex');
  await ctx.addCookies([{ name: design.localeCookieName(localeScope), value: encodeURIComponent(JSON.stringify({ ...design.DEFAULT_LOCALE, language })), url: origin, sameSite: 'Lax' }]);
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/api/')) return api(route);
    return route.continue();
  });
  const page = await ctx.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(`${origin}/staff/crm`);
  current = page;
  await page.getByRole('heading', { name: TITLES[language], level: 1 }).waitFor();
  await page.getByTestId('pipeline-board').waitFor();
  return { ctx, page };
}
async function check(name, work) { try { await work(); report.checks.push(name); } catch (error) { if (current) await current.screenshot({ path: join(results, `failure-${report.failures.length}.png`), fullPage: true }).catch(() => {}); report.failures.push(`${name}: ${error?.stack ?? error}`); } }
async function shot(page, name, fullPage = false) { await page.waitForTimeout(150); await page.screenshot({ path: join(results, `${name}.png`), fullPage }); report.screenshots.push(`${name}.png`); }
const column = (page, name) => page.locator('section[aria-labelledby^="stage-"]', { has: page.getByRole('heading', { name, level: 2, exact: true }) });

await check('board: stats, columns and cards; drag a card to another stage; Move-to menu; panel; drop on Won asks first', async () => {
  reset();
  const { ctx, page } = await open({ width: 1440, height: 960 });
  await page.getByText('7 open · 50% win rate').waitFor();
  assert.equal(await column(page, 'New lead').getByTestId('lead-card').count(), 3);
  await shot(page, 'pipeline-board-modern-en', true);
  await column(page, 'New lead').getByTestId('lead-card').filter({ hasText: 'Leo Santos' }).dragTo(column(page, 'Contacted'));
  await page.getByText('Leo Santos moved to Contacted.').waitFor();
  assert.equal(state.leads.find((l) => l.givenName === 'Leo').stageId, id(32));
  const card = column(page, 'Contacted').getByTestId('lead-card').filter({ hasText: 'Ava Kim' });
  await card.getByText('Move to…').click();
  await card.getByRole('button', { name: 'Trial booked' }).click();
  await page.getByText('Ava Kim moved to Trial booked.').waitFor();
  await page.getByRole('button', { name: /Noah Lee/ }).click();
  await page.getByTestId('lead-panel').getByText('noah@example.invalid').waitFor();
  await page.getByTestId('lead-panel').getByText('Upcoming').waitFor();
  await shot(page, 'pipeline-panel-modern-en');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await column(page, 'New lead').getByTestId('lead-card').filter({ hasText: 'Mina Park' }).dragTo(page.getByTestId('drop-won'));
  await page.getByText('Mark Mina Park as won?').waitFor();
  assert.equal(state.leads[0].status, 'OPEN', 'nothing closes before the confirmation');
  await page.getByLabel('Note (optional)').fill('Signed up after the trial');
  await shot(page, 'pipeline-close-confirm-modern-en');
  await page.getByRole('button', { name: 'Yes, mark Won' }).click();
  await page.getByText('Mina Park is marked Won.').waitFor();
  assert.equal(state.leads[0].status, 'WON');
  await page.getByText('6 open · 67% win rate').waitFor();
  await page.getByRole('button', { name: /Won\s*2/ }).click();
  await page.getByTestId('pipeline-list').waitFor();
  await shot(page, 'pipeline-won-list-modern-en');
  const commands = [...new Set(report.commands.map((c) => `${c.command}:${c.key}:${c.origin === origin}`))];
  assert.deepEqual(commands, ['crm.lead.stage.move:true:true', 'crm-lead-close:true:true']);
  await ctx.close();
});

await check('edit pipeline: rename, add, reorder, hide a stage with leads only after choosing where they go', async () => {
  reset(); report.commands = [];
  const { ctx, page } = await open({ width: 1440, height: 960 });
  await page.getByRole('button', { name: 'Edit pipeline' }).click();
  const dialog = page.getByTestId('edit-dialog');
  await dialog.getByLabel('Stage name').nth(1).fill('Called back');
  await dialog.getByLabel('New stage name').fill('Waiting on parent');
  await dialog.getByRole('button', { name: 'Add stage' }).click();
  await dialog.getByRole('button', { name: 'Move Waiting on parent up' }).click();
  await dialog.getByRole('button', { name: 'Hide' }).nth(3).click();
  await dialog.getByText('Choose where the open leads of each hidden stage go.').waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Save pipeline' }).isDisabled(), true);
  await dialog.getByLabel('1 open leads in Trial done move to').selectOption({ label: 'Trial booked' });
  await shot(page, 'pipeline-edit-modern-en');
  await dialog.getByRole('button', { name: 'Save pipeline' }).click();
  await page.getByText('Pipeline saved.').waitFor();
  assert.deepEqual(state.stages.map((s) => [s.name, s.hidden]), [['New lead', false], ['Called back', false], ['Trial booked', false], ['Waiting on parent', false], ['Trial done', true], ['Enrolled', false], ['Not now', false]]);
  assert.equal(state.leads.find((l) => l.givenName === 'Ethan').stageId, id(33));
  assert.equal(await page.getByRole('heading', { name: 'Trial done', level: 2 }).count(), 0, 'an empty hidden stage is not a column');
  assert.deepEqual([...new Set(report.commands.map((c) => c.command))], ['crm.pipeline.stages.save']);
  await shot(page, 'pipeline-board-after-edit-modern-en', true);
  await ctx.close();
});

for (const [mode, language] of [['classic', 'ko'], ['big-button', 'es'], ['modern', 'ko'], ['classic', 'en']]) {
  await check(`${mode} theme in ${language}`, async () => {
    reset();
    const { ctx, page } = await open({ width: 1440, height: 960 }, { language, mode });
    await shot(page, `pipeline-board-${mode}-${language}`, true);
    await ctx.close();
  });
}

await check('phone width: no sideways page scroll; the board scrolls inside itself; Move-to works by touch', async () => {
  reset();
  const { ctx, page } = await open({ width: 390, height: 844 }, { mode: 'big-button' });
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(sideways, false, 'page scrolls sideways at phone width');
  await shot(page, 'pipeline-board-big-button-en-phone', true);
  const card = column(page, 'New lead').getByTestId('lead-card').filter({ hasText: 'Mina Park' });
  await card.getByText('Move to…').click();
  await card.getByRole('button', { name: 'Contacted' }).click();
  await page.getByText('Mina Park moved to Contacted.').waitFor();
  await ctx.close();
});

await browser.close(); server.kill();
if (report.pageErrors.length) report.failures.push(`page errors: ${report.pageErrors.join(' | ')}`);
await writeFile(join(results, 'lead-pipeline-browser-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ checks: report.checks, failures: report.failures, screenshots: report.screenshots.length }, null, 2));
if (report.failures.length) { console.error(seenPaths.slice(-30).join('\n')); console.error(serverLog.slice(-2000)); process.exit(1); }
