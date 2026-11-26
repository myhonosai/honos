/**
 * Disposable local browser proof for the Conversation AI easy setup page (CE1, over the 0420 API). Synthetic fixtures only:
 * every /api request is answered in the browser by this script, which keeps one in-memory settings row and training library the
 * way the server does (versions, idempotency keys). No database, AI provider or production backend is used. Requires `pnpm build` first.
 *
 *   HON_CAI_BROWSER_LOCAL=1 HON_CAI_BROWSER_RESULTS=<dir> node apps/web/scripts/conversation-ai-browser.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { issueSession, HON_SESSION_COOKIE } from '@hon/auth';

if (process.env.HON_CAI_BROWSER_LOCAL !== '1') throw new Error('Opt in with HON_CAI_BROWSER_LOCAL=1.');
for (const key of ['DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY']) {
  if (process.env[key]) throw new Error('Browser verification refuses inherited database/provider credentials.');
}
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = process.env.HON_CAI_BROWSER_RESULTS;
assert(results, 'HON_CAI_BROWSER_RESULTS is required.');
const { chromium } = createRequire(import.meta.url)(process.env.HON_SHELL_PLAYWRIGHT ?? 'playwright');
const design = await import('@hon/design-system');
await mkdir(results, { recursive: true });

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const school = { organizationId: id(1), schoolId: id(2) }, prefix = `/api/v1/organizations/${school.organizationId}/schools/${school.schoolId}`;
const report = { syntheticFixturesOnly: true, databaseAccess: false, providerCalls: false, checks: [], failures: [], screenshots: [], pageErrors: [], commands: [] };
const T = '2026-11-18T17:00:00.000Z';
let state, theme = 'modern', canConfigure = true, program = 'OFF';
function reset({ items = true } = {}) {
  const faq = (n, title, question, body, status = 'ACTIVE') => ({ itemId: id(100 + n), kind: 'FAQ', title, question, body, staffNote: null, summary: null, status, version: 1,
    updatedAt: T, updatedBy: 'Coach Kim', file: null });
  state = {
    seen: new Map(), tests: [], testMode: 'AI', testReason: null,
    settings: { enabled: false, modes: { SMS: 'OFF', WEB_CHAT: 'OFF', EMAIL: 'OFF' }, handoffWords: ['human', 'manager', 'cancel', 'refund', 'billing'], afterHoursText: null,
      smsMaxChars: 320, chatMaxChars: 640, languages: ['en'], enabledAt: null, enabledBy: null, version: 1 },
    items: items ? [
      faq(1, 'Do you offer a free trial class?', 'Do you offer a free trial class?', 'Yes! Your first class is free. Reply with your child’s age and we’ll find a good time.'),
      faq(2, 'Where do I park?', 'Where do I park?', 'Free parking behind the building. Use the back door by the blue sign.'),
      { itemId: id(110), kind: 'INSTRUCTION', title: 'Always invite new families to a free trial class.', question: null, body: 'Always invite new families to a free trial class.',
        staffNote: null, summary: null, status: 'ACTIVE', version: 1, updatedAt: T, updatedBy: 'Coach Kim', file: null },
    ] : [],
  };
}
const meta = { requestId: id(5), correlationId: id(5) };
const json = (route, status, body) => route.fulfill({ status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }, body: JSON.stringify(body) });
const ok = (route, data, replayed) => json(route, 200, { data, meta: replayed === undefined ? meta : { ...meta, replayed } });
const now = () => new Date().toISOString();
const knowledge = () => ({ school: { name: 'Sunrise Martial Arts' }, tone: 'Warm and encouraging', languages: state.settings.languages,
  instructions: state.items.filter((i) => i.kind === 'INSTRUCTION' && i.status === 'ACTIVE').map((i) => ({ source: `TRAINING:${i.itemId}`, text: i.body })),
  faqs: state.items.filter((i) => i.kind === 'FAQ' && i.status === 'ACTIVE').map((i) => ({ source: `TRAINING:${i.itemId}`, kind: 'FAQ', question: i.question, answer: i.body })),
  documents: [], articles: [{ source: 'ARTICLE:00000000-0000-4000-8000-000000000201', title: 'Our belt system', text: 'White, yellow, orange, green, blue, brown, black.' }],
  plans: [{ source: 'PLAN:00000000-0000-4000-8000-000000000202:1', name: 'Kids Karate 2x week', description: null, currency: 'USD', priceMinor: 14900, billing: 'MONTHLY', termMonths: null }],
  bookingTypes: [{ source: 'BOOKING_TYPE:00000000-0000-4000-8000-000000000203', name: 'Free trial class', description: null, template: 'TRIAL', durationMinutes: 45 }] });

const snapshot = () => ({
  ...school, generatedAt: '2026-11-06T09:00:00.000Z', from: '2026-10-07T09:00:00.000Z', to: '2026-11-06T09:00:00.000Z',
  studentProfiles: { total: 0 }, leads: { byStatus: { OPEN: 0, WON: 0, LOST: 0, ARCHIVED: 0 } }, classSessions: { inRange: { scheduled: 0, completed: 0, cancelled: 0 } },
  attendance: { inRangeByStatus: { PRESENT: 0, LATE: 0, EXCUSED_ABSENCE: 0, UNEXCUSED_ABSENCE: 0, MAKEUP: 0 } },
  memberships: { byState: { DRAFT: 0, ACTIVE: 0, FROZEN: 0, CANCELLATION_PENDING: 0, CANCELLED: 0, EXPIRED: 0 } },
  invoices: { inRangeByStatus: { DRAFT: 0, ISSUED: 0, PAID: 0, VOID: 0, UNCOLLECTIBLE: 0 } },
  paymentAttempts: { inRangeByState: { PENDING: 0, PROCESSING: 0, SUCCEEDED: 0, FAILED: 0, REQUIRES_ACTION: 0, UNKNOWN: 0, REFUNDED: 0 } },
});

function api(route) {
  const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
  if (path === '/api/identity/me') return json(route, 200, { data: { externalSubject: 'cai-synthetic-staff', displayName: 'Synthetic Staff' } });
  if (path === '/api/v1/staff/current-reporting-school') return json(route, 200, { data: { state: 'RESOLVED', ...school } });
  if (path === '/api/v1/staff/reporting-schools') return json(route, 200, { data: { state: 'MANUAL_ENTRY_REQUIRED' } });
  if (path.endsWith('/interface-theme')) return json(route, 200, { data: { interfaceTheme: theme, selectedVia: 'SETTINGS', updatedAt: now() }, meta: {} });
  if (path.endsWith('/reports/operations')) return json(route, 200, { data: { operationalSnapshot: snapshot() }, meta: {} });
  if (!path.startsWith(`${prefix}/conversation-ai`)) return json(route, 403, { code: 'FORBIDDEN' });
  const rest = path.slice(`${prefix}/conversation-ai`.length);
  if (method === 'GET' && rest === '') return ok(route, { program, settings: state.settings, items: [...state.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), canConfigure });
  if (method === 'GET' && rest === '/knowledge') return ok(route, knowledge());
  // CE2 test chat: a canned synthetic answer from the fixture FAQs. No AI is called anywhere in this proof.
  if (method === 'GET' && rest === '/test') return ok(route, { mode: state.testMode, reason: state.testReason, tests: state.tests });
  if (method !== 'POST') return json(route, 404, { code: 'NOT_FOUND' });
  const headers = request.headers(), key = headers['idempotency-key'] ?? null, body = JSON.parse(request.postData() ?? 'null');
  report.commands.push({ path: rest, command: headers['x-hon-human-command'], key: key !== null });
  if (key && state.seen.has(key)) return ok(route, state.seen.get(key), true);
  const answer = (data) => { if (key) state.seen.set(key, data); return ok(route, data, false); };
  if (rest === '/test') {
    if (state.testMode !== 'AI') return json(route, 403, { code: 'CONVERSATION_AI_TEST_UNAVAILABLE' });
    if (!body || Object.keys(body).join(',') !== 'question' || typeof body.question !== 'string') return json(route, 400, { code: 'CONVERSATION_AI_TEST_INVALID' });
    const faq = state.items.find((i) => i.kind !== 'INSTRUCTION' && i.question && body.question.toLowerCase().includes(i.question.toLowerCase().split(' ').slice(-2).join(' ').replace('?', '')));
    const needsStaff = /refund|cancel|manager/i.test(body.question);
    const view = { id: randomUUID(), status: 'ANSWERED', reason: null, question: body.question,
      reply: needsStaff ? 'Thanks for letting us know. A team member will reach out to you today.' : faq ? faq.body : 'Great question! A team member will follow up with the details shortly.',
      needsStaff, askedAt: now() };
    state.tests = [view, ...state.tests].slice(0, 10);
    if (key) state.seen.set(key, view);
    return json(route, 200, { data: view, meta });
  }
  if (rest === '/settings') {
    if (body.expectedVersion !== state.settings.version) return json(route, 409, { code: 'CONVERSATION_VERSION_CONFLICT' });
    const { expectedVersion, ...input } = body;
    state.settings = { ...state.settings, ...input, enabledAt: input.enabled ? (state.settings.enabledAt ?? now()) : null, enabledBy: input.enabled ? 'Synthetic Staff' : null, version: state.settings.version + 1 };
    return answer({ settings: state.settings });
  }
  if (rest === '/items') {
    const { expectedVersion, itemId, ...input } = body;
    if (itemId) {
      const row = state.items.find((i) => i.itemId === itemId);
      if (!row || row.version !== expectedVersion) return json(route, 409, { code: 'CONVERSATION_VERSION_CONFLICT' });
      Object.assign(row, { question: null, staffNote: null, summary: null, ...input, version: row.version + 1, updatedAt: now() });
      return answer({ item: row });
    }
    const row = { itemId: randomUUID(), question: null, staffNote: null, summary: null, file: null, ...input, status: 'ACTIVE', version: 1, updatedAt: now(), updatedBy: 'Synthetic Staff' };
    state.items.push(row);
    return answer({ item: row });
  }
  if (rest === '/items/status') {
    const row = state.items.find((i) => i.itemId === body.itemId);
    if (!row || row.version !== body.expectedVersion) return json(route, 409, { code: 'CONVERSATION_VERSION_CONFLICT' });
    if (body.status === 'DELETED') { state.items = state.items.filter((i) => i !== row); return answer({ item: { itemId: row.itemId, status: 'DELETED', version: row.version + 1 } }); }
    Object.assign(row, { status: body.status, version: row.version + 1, updatedAt: now() });
    return answer({ item: row });
  }
  return json(route, 400, { code: 'VALIDATION_FAILED' });
}

const session = { mode: 'OIDC', audience: 'conversation-ai-browser-synthetic', secret: randomBytes(32).toString('hex') };

const probe = createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(join(webRoot, 'node_modules/.bin/next'), ['start', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: webRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8',
  NODE_ENV: 'production', HON_DEPLOYMENT_ENVIRONMENT: 'preview', NEXT_TELEMETRY_DISABLED: '1', HON_API_BASE_URL: 'http://127.0.0.1:9', HON_AUTH_MODE: session.mode,
  HON_SESSION_AUDIENCE: session.audience, HON_SESSION_JWT_SECRET: session.secret }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; i < 240; i += 1) { try { const r = await fetch(`${origin}/auth/login`); if (r.status < 500) break; } catch { /* starting */ } await new Promise((done) => setTimeout(done, 500)); }
const browser = await chromium.launch();
const TITLES = { en: 'Conversation AI', ko: '대화 AI', es: 'IA de conversaciones' };
let current = null;
async function open(viewport, { language = 'en', mode = 'modern' } = {}) {
  theme = mode;
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await ctx.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: 'cai-synthetic-staff' }, session), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  const localeScope = createHmac('sha256', session.secret).update(JSON.stringify(['hon-local-presentation-v1', session.mode, session.audience, 'cai-synthetic-staff'])).digest('hex');
  await ctx.addCookies([{ name: design.localeCookieName(localeScope), value: encodeURIComponent(JSON.stringify({ ...design.DEFAULT_LOCALE, language })), url: origin, sameSite: 'Lax' }]);
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/api/')) return api(route);
    return route.continue();
  });
  const page = await ctx.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(`${origin}/staff/conversations/train-ai`);
  current = page;
  await page.getByRole('heading', { name: TITLES[language], level: 1 }).waitFor();
  await page.getByRole('tablist').waitFor();
  return { ctx, page };
}
async function check(name, work) { try { await work(); report.checks.push(name); } catch (error) { if (current) await current.screenshot({ path: join(results, `failure-${report.failures.length}.png`), fullPage: true }).catch(() => {}); report.failures.push(`${name}: ${error?.stack ?? error}`); } }
async function shot(page, name, fullPage = false) { await page.waitForTimeout(150); await page.screenshot({ path: join(results, `${name}.png`), fullPage }); report.screenshots.push(`${name}.png`); }

await check('choose Suggest replies for every channel, save once, status updates', async () => {
  reset(); program = 'OFF'; canConfigure = true;
  const { ctx, page } = await open({ width: 1440, height: 960 });
  await page.getByText('The AI is off. Families only hear from your staff.').waitFor();
  await shot(page, 'cai-how-off-modern-en', true);
  await page.getByRole('button', { name: /Suggest replies/ }).click();
  await page.getByText('You have unsaved changes.').waitFor();
  await shot(page, 'cai-how-suggest-unsaved-modern-en', true);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('The AI writes suggested replies. Your staff check them and tap send.').waitFor();
  assert.deepEqual(state.settings.modes, { SMS: 'ASSIST', WEB_CHAT: 'ASSIST', EMAIL: 'ASSIST' });
  assert.equal(state.settings.enabled, true);
  await page.getByRole('button', { name: 'Choose per channel' }).click();
  await page.getByRole('group', { name: 'Email' }).getByRole('button', { name: 'Off' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('The AI helps differently on each channel.').waitFor();
  assert.equal(state.settings.modes.EMAIL, 'OFF');
  await shot(page, 'cai-how-per-channel-modern-en', true);
  await ctx.close();
});

await check('quick start: tap a question, type the answer, it is saved and leaves the quick start', async () => {
  reset(); program = 'TEST_MODE';
  const { ctx, page } = await open({ width: 1440, height: 960 });
  await page.getByRole('tab', { name: 'What it knows' }).click();
  await page.getByText('It also reads these automatically: membership plans (1), booking types (1), school articles (1).').waitFor();
  await page.getByRole('button', { name: 'What ages do you teach?' }).click();
  await page.getByLabel('Your answer to “What ages do you teach?”').fill('Kids from 4, teens, and adults. Little Dragons is ages 4 to 6.');
  await shot(page, 'cai-knows-quickstart-modern-en', true);
  await page.getByRole('button', { name: 'Add answer' }).click();
  await page.getByText('Kids from 4, teens, and adults.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'What ages do you teach?', exact: true }).count(), 0);
  await page.getByRole('switch', { name: 'Use “Where do I park?”' }).click();
  await page.getByText('Switched off. The AI no longer uses it.').waitFor();
  await page.getByPlaceholder('For example: Always invite new families to a free trial class.').fill('Never quote prices for private lessons; ask them to call.');
  await page.getByRole('button', { name: 'Add rule' }).click();
  await page.getByText('Never quote prices for private lessons; ask them to call.').first().waitFor();
  await shot(page, 'cai-knows-after-modern-en', true);
  await ctx.close();
});

await check('hand-off: add and remove a word chip, pick a length preset', async () => {
  reset(); program = 'LIVE';
  const { ctx, page } = await open({ width: 1440, height: 960 });
  await page.getByRole('tab', { name: 'When to hand off' }).click();
  await page.getByRole('button', { name: 'Remove billing' }).click();
  await page.getByPlaceholder('Add a word, e.g. injury').fill('Injury');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByPlaceholder('Add a word, e.g. injury').fill('no!');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByText('Use letters, numbers, spaces or dashes', { exact: false }).waitFor();
  await page.getByRole('group', { name: 'Texts' }).getByRole('button', { name: /Short/ }).click();
  await shot(page, 'cai-handoff-modern-en', true);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('Settings saved.').waitFor();
  assert.deepEqual(state.settings.handoffWords, ['human', 'manager', 'cancel', 'refund', 'injury']);
  assert.equal(state.settings.smsMaxChars, 160);
  await ctx.close();
});

await check('try it: ask a sample question, see the answer, hand-off badge, save a better answer as coaching', async () => {
  reset(); program = 'LIVE';
  const { ctx, page } = await open({ width: 1440, height: 960 });
  await page.getByRole('tab', { name: 'Try it' }).click();
  await page.getByText('Nothing is sent to anyone', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Do you offer a free trial class?' }).click();
  await page.getByText('Your first class is free.', { exact: false }).waitFor();
  await page.getByLabel('Your test question').fill('I want to cancel and get a refund');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await page.getByText('Would hand off to staff').waitFor();
  assert.equal(state.tests.length, 2);
  await shot(page, 'cai-tryit-modern-en', true);
  await page.getByRole('button', { name: 'Use a better answer' }).nth(1).click();
  await page.getByLabel('The answer it should give').fill('Yes! The first class is free and you can come to any beginner class this week.');
  await page.getByRole('button', { name: 'Save so the AI learns it' }).click();
  await page.getByText('Saved. The AI will use this answer from now on.').waitFor();
  const coaching = state.items.find((i) => i.kind === 'COACHING');
  assert.equal(coaching?.question, 'Do you offer a free trial class?');
  assert.match(coaching?.body ?? '', /any beginner class/);
  // The last checklist step is now ticked.
  assert.equal(await page.locator('li[data-done="true"]', { hasText: 'Try it with a question' }).count(), 1);
  await ctx.close();
});

await check('try it: not configured yet says so and asks nothing', async () => {
  reset(); program = 'OFF'; state.testMode = 'UNAVAILABLE'; state.testReason = 'NOT_CONFIGURED';
  const { ctx, page } = await open({ width: 390, height: 844 }, { mode: 'big-button' });
  await page.getByRole('tab', { name: 'Try it' }).click();
  await page.getByText('HON hasn’t connected the AI service yet.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Ask', exact: true }).isDisabled(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, 'try it tab scrolls sideways');
  await shot(page, 'cai-tryit-not-configured-big-button-en-phone', true);
  await ctx.close();
});

await check('read-only staff see everything disabled', async () => {
  reset(); program = 'LIVE'; canConfigure = false;
  const { ctx, page } = await open({ width: 1440, height: 960 });
  await page.getByText('Only the school owner can change these settings.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: /Reply for me/ }).isDisabled(), true);
  await ctx.close(); canConfigure = true;
});

for (const [mode, language] of [['classic', 'ko'], ['big-button', 'es'], ['classic', 'en']]) {
  await check(`${mode} theme in ${language}`, async () => {
    reset({ items: false }); program = 'OFF';
    const { ctx, page } = await open({ width: 1440, height: 960 }, { language, mode });
    await shot(page, `cai-how-${mode}-${language}`, true);
    await page.getByRole('tab').nth(1).click();
    await page.waitForTimeout(300);
    await shot(page, `cai-knows-${mode}-${language}`, true);
    await ctx.close();
  });
}

await check('phone width: no sideways page scroll', async () => {
  reset(); program = 'OFF';
  const { ctx, page } = await open({ width: 390, height: 844 }, { mode: 'big-button' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, 'page scrolls sideways at phone width');
  await shot(page, 'cai-how-big-button-en-phone', true);
  await page.getByRole('tab', { name: 'What it knows' }).click();
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, 'knows tab scrolls sideways');
  await shot(page, 'cai-knows-big-button-en-phone', true);
  await ctx.close();
});

await browser.close(); server.kill();
if (report.pageErrors.length) report.failures.push(`page errors: ${report.pageErrors.join(' | ')}`);
if (report.commands.some((c) => !c.key || !c.command)) report.failures.push('a command went out without a key or command name');
await writeFile(join(results, 'conversation-ai-browser-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ checks: report.checks, failures: report.failures, screenshots: report.screenshots.length }, null, 2));
if (report.failures.length) { console.error(serverLog.slice(-3000)); process.exit(1); }
