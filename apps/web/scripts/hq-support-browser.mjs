/** Mounted Next/Chromium proof of the HQ Support pages (B-HQ-2) with signed synthetic sessions and an in-memory fixture API.
 * No database or provider is used. Database authority, idempotency and history rules are proven by test-hq-support-cases.mjs.
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
const copyCode = ts.transpileModule(await readFile(join(root, 'src/components/hq-support/copy.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { supportText } = await import('data:text/javascript;base64,' + Buffer.from(copyCode).toString('base64'));
assert(process.env.HON_HQ_BROWSER_TOOLS && process.env.HON_HQ_BROWSER_RESULTS && process.env.HON_HQ_CHROME_BIN);
const requireTools = createRequire(join(process.env.HON_HQ_BROWSER_TOOLS, 'runner.cjs'));
const { chromium } = requireTools('playwright-core');
const axe = await readFile(requireTools.resolve('axe-core/axe.min.js'), 'utf8');
const results = join(process.env.HON_HQ_BROWSER_RESULTS, 'hq-support');
await mkdir(results, { recursive: true });
const report = { sourceSha: process.env.HON_HQ_SOURCE_SHA, fixtureOnly: true, completed: false, checks: [], screenshots: [], accessibility: [], pageErrors: [] };
const session = { mode: 'OIDC', audience: 'hon-hq-support-synthetic', secret: randomBytes(32).toString('hex') };
const T0 = '2026-11-01T00:00:00.000Z';
const ORG = '20000000-0000-4000-8000-000000000001', SCHOOL = '30000000-0000-4000-8000-000000000001';
const people = { agent: { principalId: '10000000-0000-4000-8000-000000000001', displayName: 'Synthetic Agent' },
  lead: { principalId: '10000000-0000-4000-8000-000000000002', displayName: 'Synthetic Lead' } };
const overview = { asOf: T0, callerHqRole: 'OWNER', organizationCount: 0, schoolCount: 0,
  onboarding: { availability: 'AVAILABLE', requestCount: 0, inProgressRequestCount: 0, completedRequestCount: 0 }, configuredProviderStates: { disabled: 0, configured: 0, healthy: 0, degraded: 0, unavailable: 0 }, taskProfileCount: 0,
  financialMetrics: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.financialMetrics }, aiUsage: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.aiUsage }, durableHqWork: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.durableHqWork } };

/** A tiny in-memory stand-in for 0232: versions, closed is final, one saved answer per key. */
function store() {
  let clock = Date.parse(T0);
  const now = () => new Date(clock += 60_000).toISOString();
  const cases = new Map(), events = new Map(), answers = new Map();
  const json = c => ({ caseId: c.id, organizationId: ORG, organizationDisplayName: 'Synthetic Dojo', schoolId: c.schoolId, schoolDisplayName: c.schoolId ? 'Synthetic Academy' : null,
    subject: c.subject, category: c.category, priority: c.priority, status: c.status, assignee: c.assignee, openedBy: people.agent, openedAt: c.openedAt, updatedAt: c.updatedAt,
    closedAt: c.closedAt, version: c.version, noteCount: events.get(c.id).filter(e => e.note !== null).length });
  const add = (c, e) => { const list = events.get(c.id); list.push({ seq: list.length + 1, actor: people.agent, note: null, statusFrom: null, statusTo: null, priorityFrom: null, priorityTo: null,
    assigneeChanged: false, assigneeTo: null, occurredAt: c.updatedAt, ...e }); };
  const open = (input, at = now()) => {
    const c = { id: randomUUID(), schoolId: input.schoolId, subject: input.subject, category: input.category, priority: input.priority, status: 'OPEN', assignee: null,
      openedAt: at, updatedAt: at, closedAt: null, version: 1 };
    cases.set(c.id, c); events.set(c.id, []); add(c, { kind: 'OPENED', note: input.note }); return c;
  };
  open({ schoolId: SCHOOL, subject: 'Owner cannot sign in', category: 'ACCOUNT_ACCESS', priority: 'URGENT', note: 'The owner reports the sign-in link expired twice.' });
  open({ schoolId: null, subject: 'Invoice question for the organization', category: 'BILLING', priority: 'NORMAL', note: 'Asked which plan the invoice covers.' });
  return {
    cases, events, answers,
    list(status) {
      const all = [...cases.values()].sort((a, b) => b.openedAt.localeCompare(a.openedAt));
      const fits = c => !status || (status === 'ACTIVE' ? c.status === 'OPEN' || c.status === 'WAITING_ON_SCHOOL' : c.status === status);
      const active = all.filter(c => c.status === 'OPEN' || c.status === 'WAITING_ON_SCHOOL');
      const count = s => all.filter(c => c.status === s).length;
      return { cases: all.filter(fits).map(json), limit: 25, nextCursor: null, viewer: people.agent, asOf: now(),
        summary: { OPEN: count('OPEN'), WAITING_ON_SCHOOL: count('WAITING_ON_SCHOOL'), RESOLVED: count('RESOLVED'), CLOSED: count('CLOSED'),
          urgentActive: active.filter(c => c.priority === 'URGENT').length, unassignedActive: active.filter(c => !c.assignee).length } };
    },
    detail(id) { const c = cases.get(id); return c && { case: json(c), events: events.get(id), assignees: [people.agent, people.lead], viewer: people.agent, asOf: now() }; },
    /** Returns [status, body]. */
    command(kind, id, input) {
      if (kind === 'OPEN') return [200, { data: { operation: 'OPEN', case: json(open(input)), replayed: false } }];
      const c = cases.get(id); if (!c) return [404, { code: 'SAAS_UNAVAILABLE' }];
      if (c.status === 'CLOSED') return [422, { code: 'SUPPORT_CASE_CLOSED' }];
      if (input.expectedVersion !== c.version) return [409, { code: 'SAAS_VERSION_CONFLICT' }];
      c.updatedAt = now(); c.version++;
      if (kind === 'NOTE') add(c, { kind: 'NOTE', note: input.note });
      else {
        const e = { kind: 'CHANGED', note: input.note ?? null };
        if (input.status) { e.statusFrom = c.status; e.statusTo = input.status; c.status = input.status; c.closedAt = input.status === 'CLOSED' ? c.updatedAt : null; }
        if (input.priority) { e.priorityFrom = c.priority; e.priorityTo = input.priority; c.priority = input.priority; }
        if (input.assigneePrincipalId !== undefined) { c.assignee = Object.values(people).find(p => p.principalId === input.assigneePrincipalId) ?? null; e.assigneeChanged = true; e.assigneeTo = c.assignee; }
        add(c, e);
      }
      return [200, { data: { operation: kind === 'NOTE' ? 'NOTE' : 'CHANGE', case: json(c), replayed: false } }];
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
      else if (path.startsWith('/v1/hq/support/')) {
        f.reads.push(req.url);
        if (f.denied) { send(403, { code: 'SAAS_FORBIDDEN' }); return; }
        if (path === '/v1/hq/support/cases') send(200, { data: f.store.list(url.searchParams.get('status')) });
        else if (path === '/v1/hq/support/cases/schools') send(200, { data: { schools: [{ schoolId: SCHOOL, schoolDisplayName: 'Synthetic Academy', organizationId: ORG, organizationDisplayName: 'Synthetic Dojo' }], truncated: false, asOf: T0 } });
        else { const d = f.store.detail(path.split('/').at(-1)); if (d) send(200, { data: d }); else send(404, { code: 'SAAS_UNAVAILABLE' }); }
      } else send(503, {});
      return;
    }
    const m = /^\/v1\/hq\/support\/cases(?:\/([0-9a-f-]{36})\/(notes|changes))?$/.exec(path);
    if (req.method !== 'POST' || !m) { send(405, {}); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const key = req.headers['idempotency-key'], marker = req.headers['x-hon-human-command'];
    const kind = !m[1] ? 'OPEN' : m[2] === 'notes' ? 'NOTE' : 'CHANGE';
    f.commands.push({ kind, key, body, marker });
    assert.equal(marker, { OPEN: 'hq-support-case-open', NOTE: 'hq-support-case-note', CHANGE: 'hq-support-case-change' }[kind]);
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
const t = (key, language = 'en') => supportText(language, key);
async function open(name, viewport, configure = () => {}, language = 'en', path = '/hq/support') {
  const f = { language, reads: [], commands: [], store: store(), denied: false, unknownOnce: null }; configure(f); fixtures.set(name, f);
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const scope = createHmac('sha256', session.secret).update(JSON.stringify(['hon-local-presentation-v1', session.mode, session.audience, name])).digest('hex');
  await context.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: name }, session), url: origin, httpOnly: true, sameSite: 'Lax' },
    { name: localeCookieName(scope), value: encodeURIComponent(JSON.stringify({ ...DEFAULT_LOCALE, language })), url: origin, sameSite: 'Lax' }]);
  const page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.goto(origin + path);
  return { context, page, f, language };
}
const ready = s => s.page.locator('[data-hq-support="ready"]').waitFor();
const caseReady = s => s.page.locator('[data-hq-support-case="ready"]').waitFor();
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

  await check('the support list shows active cases with summary, filters and no planned placeholder (desktop and 390px)', async () => {
    for (const [name, viewport] of [['support-list-desktop', { width: 1280, height: 900 }], ['support-list-mobile', { width: 390, height: 844 }]]) {
      const s = await open(name, viewport); await ready(s);
      const text = await s.page.locator('[data-hq-support]').innerText();
      for (const expected of ['Owner cannot sign in', 'Invoice question for the organization', 'Synthetic Dojo', 'Synthetic Academy', t('wholeOrganization'), t('summaryUrgent')]) assert(text.includes(expected), expected);
      assert(!(await s.page.locator('body').innerText()).includes('No service is called'));
      assert.equal(s.f.reads[0], '/v1/hq/support/cases?status=ACTIVE&limit=25');
      await capture(s, name, '[data-hq-support]'); await s.context.close();
    }
  });
  await check('opening a case sends one human command, then the case page shows its history', async () => {
    const s = await open('support-open', { width: 390, height: 844 }); await ready(s);
    await s.page.getByRole('button', { name: t('openCase'), exact: true }).click();
    await s.page.getByLabel(t('schoolPick'), { exact: true }).waitFor();
    assert(s.f.reads.includes('/v1/hq/support/cases/schools'));
    await s.page.getByLabel(t('schoolPick'), { exact: true }).selectOption(`school:${SCHOOL}`);
    await s.page.getByLabel(t('subject'), { exact: true }).fill('Staff invitation never arrived');
    await s.page.getByLabel(t('category'), { exact: true }).selectOption('ONBOARDING');
    await s.page.getByLabel(t('priority'), { exact: true }).selectOption('HIGH');
    await s.page.getByLabel(t('firstNote'), { exact: true }).fill('The owner invited a coach yesterday; the coach saw no email.');
    await capture(s, 'support-open-form-mobile', '[data-hq-support]');
    await s.page.getByRole('button', { name: t('submitOpen'), exact: true }).click();
    await s.page.locator('[data-support-outcome="done"]').waitFor();
    assert.equal(s.f.commands.length, 1);
    assert.deepEqual(JSON.parse(s.f.commands[0].body), { organizationId: ORG, schoolId: SCHOOL, subject: 'Staff invitation never arrived', category: 'ONBOARDING', priority: 'HIGH',
      note: 'The owner invited a coach yesterday; the coach saw no email.' });
    await s.page.locator('[data-hq-support]').getByText('Staff invitation never arrived', { exact: true }).waitFor();
    await s.page.getByRole('link', { name: t('viewCase'), exact: true }).click();
    await caseReady(s);
    await s.page.getByText('The owner invited a coach yesterday; the coach saw no email.', { exact: true }).waitFor();
    await capture(s, 'support-case-mobile', '[data-hq-support-case]');
    await s.context.close();
  });
  await check('a note whose outcome is unknown is retried with the same key and body and saved once', async () => {
    const s = await open('support-note-unknown', { width: 1280, height: 900 }, f => { f.unknownOnce = 'NOTE'; }); await ready(s);
    await s.page.getByRole('link', { name: 'Owner cannot sign in', exact: true }).click(); await caseReady(s);
    await s.page.getByLabel(t('note'), { exact: true }).fill('Sent a fresh sign-in link.');
    await s.page.getByRole('button', { name: t('submitNote'), exact: true }).click();
    await s.page.locator('[data-support-outcome="unknown"]').waitFor();
    assert(await s.page.getByRole('button', { name: t('submitNote'), exact: true }).isDisabled(), 'no second command while one is in doubt');
    await s.page.getByRole('button', { name: t('tryAgain'), exact: true }).click();
    await s.page.locator('[data-support-outcome="done"]').waitFor();
    assert.equal(s.f.commands.length, 2); assert.deepEqual(s.f.commands[1], s.f.commands[0]);
    const [c] = [...s.f.store.cases.values()].filter(x => x.subject === 'Owner cannot sign in');
    assert.equal(s.f.store.events.get(c.id).filter(e => e.kind === 'NOTE').length, 1);
    await s.page.getByText('Sent a fresh sign-in link.', { exact: true }).waitFor();
    await s.context.close();
  });
  await check('assigning and closing a case records each step; a closed case offers no forms', async () => {
    const s = await open('support-close', { width: 390, height: 844 }); await ready(s);
    await s.page.getByRole('link', { name: 'Owner cannot sign in', exact: true }).click(); await caseReady(s);
    await s.page.getByLabel(t('assignee'), { exact: true }).selectOption(people.lead.principalId);
    await s.page.getByLabel(t('status'), { exact: true }).selectOption('WAITING_ON_SCHOOL');
    await s.page.getByRole('button', { name: t('submitChange'), exact: true }).click();
    await s.page.locator('[data-support-outcome="done"]').waitFor();
    await s.page.locator('[data-support-event="2"]').waitFor(); assert((await s.page.locator('[data-support-event="2"]').innerText()).includes('Assigned to Synthetic Lead'));
    // The change form only offers a real change; submitting nothing is refused locally and nothing is sent.
    const sent = s.f.commands.length;
    await s.page.getByRole('button', { name: t('submitChange'), exact: true }).click();
    await s.page.locator('[data-support-outcome="local_invalid"]').waitFor(); assert.equal(s.f.commands.length, sent);
    await s.page.getByLabel(t('status'), { exact: true }).selectOption('CLOSED');
    await s.page.getByLabel(t('changeNote'), { exact: true }).fill('School confirmed the owner can sign in.');
    await s.page.getByRole('button', { name: t('submitChange'), exact: true }).click();
    await s.page.getByText(t('closedFinal'), { exact: true }).waitFor();
    assert.equal(await s.page.locator('[data-support-form]').count(), 0);
    assert.equal(s.f.commands.filter(c => c.kind === 'CHANGE').length, 2);
    assert.deepEqual(JSON.parse(s.f.commands.at(-1).body), { expectedVersion: 2, status: 'CLOSED', note: 'School confirmed the owner can sign in.' });
    await capture(s, 'support-case-closed-mobile', '[data-hq-support-case]');
    await s.context.close();
  });
  await check('leaving the tab hides every case and the open form; Show again reads fresh', async () => {
    const s = await open('support-conceal', { width: 1280, height: 900 }); await ready(s);
    await s.page.getByRole('button', { name: t('openCase'), exact: true }).click();
    await s.page.getByLabel(t('subject'), { exact: true }).fill('Private draft subject');
    const reads = s.f.reads.length;
    await s.page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await s.page.locator('[data-hq-support="concealed"]').waitFor();
    const body = await s.page.locator('body').innerText();
    assert(!body.includes('Owner cannot sign in') && !body.includes('Synthetic Academy'));
    assert.equal(await s.page.locator('input[name="subject"]').count(), 0);
    await s.page.getByRole('button', { name: t('reveal'), exact: true }).click(); await ready(s);
    assert(s.f.reads.length > reads);
    assert.equal(await s.page.locator('input[name="subject"]').count(), 0, 'the draft is not restored');
    await s.context.close();
  });
  await check('a person without HQ support access sees nothing', async () => {
    const s = await open('support-denied', { width: 390, height: 844 }, f => { f.denied = true; });
    await s.page.locator('[data-hq-support="denied"]').waitFor();
    assert(!(await s.page.locator('body').innerText()).includes('Owner cannot sign in'));
    await s.context.close();
    const d = await open('support-denied-case', { width: 390, height: 844 }, f => { f.denied = true; }, 'en', `/hq/support/${randomUUID()}`);
    await d.page.locator('[data-hq-support-case="denied"]').waitFor(); await d.context.close();
  });
  await check('the Korean support list renders without overflow', async () => {
    const s = await open('support-list-ko', { width: 390, height: 844 }, () => {}, 'ko'); await ready(s);
    await s.page.locator('[data-hq-support]').getByRole('heading', { name: t('title', 'ko'), exact: true }).waitFor();
    await capture(s, 'support-list-ko-mobile', '[data-hq-support]'); await s.context.close();
  });
  assert.deepEqual(report.pageErrors, []);
  report.completed = true;
} finally {
  await writeFile(join(results, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close(); app.kill('SIGTERM'); api.closeAllConnections(); await new Promise(done => api.close(done));
}
