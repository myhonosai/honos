/**
 * Disposable local browser proof for the AI team chat on the school Dashboard (owner ask 2026-11-17). Synthetic
 * fixtures only: every /api request is answered in the browser by this script (the U1/U2 shell fixtures plus a fake HON
 * conversation API). Browser speech is replaced by fakes. No database, provider, payment or production backend is
 * used. Requires `pnpm build` first.
 *
 *   HON_TEAM_CHAT_BROWSER_LOCAL=1 HON_TEAM_CHAT_BROWSER_RESULTS=<dir> node apps/web/scripts/hon-team-chat-browser.mjs
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

if (process.env.HON_TEAM_CHAT_BROWSER_LOCAL !== '1') throw new Error('Opt in with HON_TEAM_CHAT_BROWSER_LOCAL=1.');
for (const key of ['DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY']) {
  if (process.env[key]) throw new Error('Browser verification refuses inherited database/provider credentials.');
}
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = process.env.HON_TEAM_CHAT_BROWSER_RESULTS;
assert(results, 'HON_TEAM_CHAT_BROWSER_RESULTS is required.');
const { chromium } = createRequire(import.meta.url)(process.env.HON_TEAM_CHAT_PLAYWRIGHT ?? 'playwright');
await mkdir(results, { recursive: true });
// Optional: path to axe-core's axe.min.js for a WCAG 2.1 AA scan of the shell and Home.
const axeSource = process.env.HON_TEAM_CHAT_AXE ? await (await import('node:fs/promises')).readFile(process.env.HON_TEAM_CHAT_AXE, 'utf8') : null;
async function axeScan(page, name) {
  if (!axeSource) return;
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  const violations = result.violations.map((v) => ({ id: v.id, impact: v.impact, targets: v.nodes.slice(0, 6).map((n) => n.target.join(' ')) }));
  report.accessibility = [...(report.accessibility ?? []), { name, violations }];
  assert.deepEqual(violations, [], `${name}: ${JSON.stringify(violations)}`);
}

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const schoolA = { organizationId: id(1), schoolId: id(2) }, schoolB = { organizationId: id(1), schoolId: id(3) };
const report = { syntheticFixturesOnly: true, databaseAccess: false, providerCalls: false, checks: [], failures: [], screenshots: [], pageErrors: [], apiRequests: [] };
let theme = 'modern', multi = false, readinessDenied = false, leadsGate = null, sessionEnded = false;
const iso = () => '2026-11-06T09:00:00.000Z';
const snapshot = (scope) => ({
  organizationId: scope.organizationId, schoolId: scope.schoolId, generatedAt: iso(), from: '2026-10-07T09:00:00.000Z', to: iso(),
  studentProfiles: { total: 148 }, leads: { byStatus: { OPEN: 23, WON: 9, LOST: 4, ARCHIVED: 2 } },
  classSessions: { inRange: { scheduled: 64, completed: 58, cancelled: 2 } },
  attendance: { inRangeByStatus: { PRESENT: 812, LATE: 31, EXCUSED_ABSENCE: 22, UNEXCUSED_ABSENCE: 15, MAKEUP: 6 } },
  memberships: { byState: { DRAFT: 3, ACTIVE: 131, FROZEN: 4, CANCELLATION_PENDING: 2, CANCELLED: 7, EXPIRED: 5 } },
  invoices: { inRangeByStatus: { DRAFT: 2, ISSUED: 6, PAID: 118, VOID: 1, UNCOLLECTIBLE: 0 } },
  paymentAttempts: { inRangeByState: { PENDING: 0, PROCESSING: 1, SUCCEEDED: 118, FAILED: 3, REQUIRES_ACTION: 0, UNKNOWN: 0, REFUNDED: 1 } },
});

const day = 86_400_000, at = (offset) => new Date(Date.parse(iso()) + offset).toISOString();
const win = (count, from, to) => ({ availability: 'AVAILABLE', windowFrom: at(from), windowTo: at(to), count });
const commandCenter = (scope) => ({
  organizationId: scope.organizationId, schoolId: scope.schoolId, entitlementTier: 'COMPLETE', generatedAt: iso(),
  metrics: { newLeads24h: win(5, -day, 0), upcomingTrials24h: win(2, 0, day), upcomingTestingEvents30d: win(1, 0, 30 * day),
    pendingActionApprovals: { availability: 'AVAILABLE', count: 3 }, outstandingWorkItems: { availability: 'AVAILABLE', count: 2 }, membershipTermsEnding30d: win(4, 0, 30 * day),
    paidInvoicesCreated30d: { ...win(2, -30 * day, 0), amountsByCurrency: [{ currency: 'USD', count: 2, totalMinor: 30000 }] },
    unansweredInquiries: { availability: 'UNAVAILABLE', reason: 'No approved inquiry response-state projection exists.' },
    attendanceDecline: { availability: 'INSUFFICIENT_DATA', reason: 'No approved attendance-decline policy or longitudinal projection exists.' },
    trialConversion: { availability: 'UNAVAILABLE', reason: 'No authoritative trial-to-enrollment linkage is available.' },
    revenue: { availability: 'UNAVAILABLE', reason: 'Current paid invoice state is not authoritative cash revenue or collection data.' } },
  dailyBriefing: 'Daily briefing: 5 new leads in the last 24 hours; 2 trial appointments scheduled in the next 24 hours; 1 testing event in the next 30 days; 4 membership terms ending in the next 30 days; 3 action approvals awaiting review; 2 outstanding durable work items.',
  recommendations: [
    { id: 'REVIEW_PENDING_APPROVALS', title: 'Review pending approvals', why: '3 current action requests are awaiting a qualified human review.', route: '/staff/action-center/approvals', action: 'NAVIGATE', automaticExecution: false },
    { id: 'REVIEW_OUTSTANDING_WORK', title: 'Review outstanding work', why: '2 durable work items remain in a nonterminal state.', route: '/staff/work', action: 'NAVIGATE', automaticExecution: false },
    { id: 'PREPARE_UPCOMING_TRIALS', title: 'Prepare upcoming trials', why: '2 scheduled trial appointments start within 24 hours.', route: '/staff/search', action: 'NAVIGATE', automaticExecution: false },
    { id: 'REVIEW_NEW_LEADS', title: 'Review new leads', why: '5 CRM leads were created in the last 24 hours.', route: '/staff/search', action: 'NAVIGATE', automaticExecution: false },
    { id: 'PREPARE_MEMBERSHIP_RENEWALS', title: 'Prepare membership reviews', why: '4 active or cancellation-pending membership terms end within 30 days.', route: '/staff/billing/renewals', action: 'NAVIGATE', automaticExecution: false },
  ],
});
const agent = (agentKey, name, credits) => ({ agentKey, agent: name, authorized: true, spendDecision: 'ALLOWED', route: 'CONFIGURED', requestCredits: credits,
  providerRuntime: 'CONFIGURATION_REQUIRED', available: false, blockedBy: 'PROVIDER_RUNTIME_NOT_CONFIGURED' });
const readiness = (scope) => ({ ...scope, completeEntitlement: true, agentBudget: null, asOf: iso(), honConversation: { contract: true },
  agents: [agent('marcus', 'MARKETING', 6), agent('claire', 'TEACHING', 6), agent('chad', 'CHAD_FOLLOW_UP', 3)] });
const today = new Date(); today.setHours(0, 0, 0, 0);
const todayAt = (hours) => new Date(today.getTime() + hours * 3_600_000).toISOString();
const sessions = () => [['Little Tigers', 16.5, 'Main mat'], ['Junior Black Belt Club', 17.5, 'Main mat'], ['Adult Sparring', 19, 'Studio B']]
  .map(([name, hour, room], i) => ({ sessionId: id(100 + i), name, startsAt: todayAt(hour), endsAt: todayAt(hour + 1), roomName: room, capacity: 20, bookingPolicy: 'WALK_IN', status: 'SCHEDULED', createdAt: iso() }));
const leads = () => [['Avery', 'Sample', 1], ['Rowan', 'Example', 2], ['Kim', 'Placeholder', 3]]
  .map(([givenName, familyName, n]) => ({ id: id(200 + n), status: 'OPEN', pipelineStageId: id(300), primaryPersonId: id(400 + n), version: 1, createdAt: at(-n * day), givenName, familyName }));
const work = (scope) => ({ schoolId: scope.schoolId, principalId: id(500), canManage: true, canCreate: true, humanOnly: true, executionAllowed: false, queue: 'mine', status: 'ACTIVE',
  items: [{ title: 'Call back trial family', workItemId: id(601), version: 1, status: 'READY', priority: 'HIGH', dueAt: at(day), assigneeId: id(500) },
    { title: 'Order new belts for testing', workItemId: id(602), version: 1, status: 'WAITING', priority: 'NORMAL', dueAt: null, assigneeId: id(500) }], nextAfter: null });
// 0460 voice choices (synthetic server copy of this person's saved voices).
let voiceChoices = { hon: 1, claire: 1, alex: 1, jordan: 1, lena: 1, marcus: 1, chad: 1, maya: 1, kai: 1 }, voiceFailNext = null;
const voicePuts = [];
const json = (route, status, body) => route.fulfill({ status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }, body: JSON.stringify(body) });
/* ---------------- fake HON conversation API (synthetic) ---------------- */
const ANALYSTS = ['claire', 'alex', 'jordan', 'lena'];
let teamReadiness = { contract: true, providerRoute: true, entitlement: true, authorization: true, availableAgentKeys: ['marcus', 'chad'], honReply: true,
  businessPerformance: true, availableAnalystKeys: ['claire', 'alex', 'jordan', 'lena'], asOf: iso() };
const conversations = []; let seq = 900; const seen = new Map(); let failNext = null;
const turnBodies = [];
const ANSWER = {
  hon: 'Let’s grow the kids program: fill the two open trial slots this week and invite last month’s trial families back.',
  claire: 'Recorded facts: 5 new leads in 24 hours, 2 trials tomorrow. My view: trial follow-up speed is the biggest lever right now.',
  alex: 'Focus this week: trials first, then the 4 memberships ending in 30 days. Keep approvals moving (3 waiting).',
  jordan: 'Next 7 days: 64 classes scheduled, Little Tigers is near capacity on Tuesday. Adding one more kids class would help.',
  lena: 'Run a “bring a buddy” week for the kids program with a simple flyer; one campaign is active and ends soon.',
};
const PLAN = '1. Call back both trial families today (Claire).\n2. Open a second Tuesday Little Tigers class (Jordan).\n3. Launch a “bring a buddy” week with a flyer (Lena).\n4. Review the 4 memberships ending this month (Alex).\nNext: Jordan can check instructor coverage; Lena can draft the flyer idea with Marcus.';
const detail = (analyst) => ({ mode: analyst ? 'DETAILED' : 'STANDARD', step: 1, maxSteps: 3, truncated: false, canContinue: false, continuesTurnId: null, suggestions: [], followUps: [], sources: [] });
const summaryOf = (c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, turnCount: c.turns.length / 2, status: 'COMPLETED' });
function honApi(route, path, method) {
  if (path === '/readiness') return json(route, 200, { data: teamReadiness, meta: {} });
  if (path === '/conversations' && method === 'GET') return json(route, 200, { data: { items: conversations.map(summaryOf).reverse(), nextCursor: null } });
  if (path === '/conversations' && method === 'POST') {
    const key = route.request().headers()['idempotency-key'];
    if (seen.has(key)) return json(route, 200, { data: seen.get(key) });
    const c = { id: id(seq++), title: JSON.parse(route.request().postData()).title, createdAt: iso(), updatedAt: iso(), turns: [] };
    conversations.push(c); const out = summaryOf(c); seen.set(key, out); return json(route, 200, { data: out });
  }
  const m = /^\/conversations\/([0-9a-f-]{36})(\/turns)?$/.exec(path);
  const c = m && conversations.find((x) => x.id === m[1]);
  if (c && !m[2] && method === 'GET') return json(route, 200, { data: { ...summaryOf(c), turns: c.turns } });
  if (c && m[2] && method === 'POST') {
    const key = route.request().headers()['idempotency-key'];
    if (seen.has(key)) return json(route, 200, { data: seen.get(key) });
    if (failNext) { const f = failNext; failNext = null; return json(route, f, { code: 'SYNTHETIC' }); }
    const body = JSON.parse(route.request().postData()); turnBodies.push(body);
    const who = body.delegation?.agentKey ?? 'hon'; const analyst = ANALYSTS.includes(who);
    const reply = body.text.startsWith('Make one plan') ? PLAN : ANSWER[who];
    const turnId = id(seq++);
    c.turns.push({ turnId, role: 'HUMAN', text: body.text, createdAt: iso(), status: 'COMPLETED', reason: null, references: { workItemId: null, actionRequestId: null, invocationId: null }, replyDetail: null });
    c.turns.push({ turnId, role: who, text: reply, createdAt: iso(), status: 'COMPLETED', reason: null, references: { workItemId: id(seq++), actionRequestId: null, invocationId: id(seq++) }, replyDetail: detail(analyst) });
    const receipt = { turnId, conversationId: c.id, status: 'COMPLETED', reason: null, delegatedAgentKeys: analyst ? [who] : [], actionRequestIds: [], workItemIds: [], invocationId: null, reply, replyDetail: detail(analyst) };
    seen.set(key, receipt); return json(route, 200, { data: receipt });
  }
  return json(route, 403, { code: 'FORBIDDEN' });
}

function api(route) {
  const url = new URL(route.request().url()), path = url.pathname, method = route.request().method();
  report.apiRequests.push(`${method} ${path}`);
  if (path.startsWith(`/api/v1/organizations/${schoolA.organizationId}/schools/${schoolA.schoolId}/hon/`)) return honApi(route, path.slice(`/api/v1/organizations/${schoolA.organizationId}/schools/${schoolA.schoolId}/hon`.length), method);
  if (path === '/api/identity/me' && sessionEnded) return json(route, 401, { error: { code: 'UNAUTHENTICATED' } });
  if (path === '/api/identity/me') return json(route, 200, { data: { externalSubject: 'shell-synthetic-owner', displayName: 'Synthetic Owner' } });
  if (path === '/api/v1/staff/current-reporting-school') return json(route, 200, { data: multi ? { state: 'MANUAL_ENTRY_REQUIRED' } : { state: 'RESOLVED', ...schoolA } });
  if (path === '/api/v1/staff/reporting-schools') return json(route, 200, { data: multi
    ? { state: 'SELECTION_REQUIRED', schools: [{ ...schoolA, organizationName: 'Synthetic Dojo Group', schoolName: 'Synthetic North Academy' }, { ...schoolB, organizationName: 'Synthetic Dojo Group', schoolName: 'Synthetic South Academy' }] }
    : { state: 'MANUAL_ENTRY_REQUIRED' } });
  if (path === '/api/v1/staff/work') return json(route, 200, { data: work(multi ? schoolB : schoolA) });
  for (const scope of [schoolA, schoolB]) {
    const prefix = `/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}`;
    if (path === `${prefix}/command-center`) return json(route, 200, { data: { commandCenter: commandCenter(scope) }, meta: {} });
    if (path === `${prefix}/ai/team/capabilities`) return readinessDenied ? json(route, 403, { code: 'AI_TEAM_READINESS_FORBIDDEN' }) : json(route, 200, { data: readiness(scope), meta: { requestId: 'r', correlationId: 'r' } });
    if (path === `${prefix}/crm/leads`) return leadsGate ? leadsGate.then(() => json(route, 200, { data: leads(), meta: {} })) : json(route, 200, { data: leads(), meta: {} });
    if (path === `${prefix}/schedule/sessions`) return json(route, 200, { data: sessions(), meta: { requestId: id(700), correlationId: id(700) } });
    if (path === `${prefix}/people`) return json(route, 200, { data: [['Avery', 'Sample', '+15555550101', 'avery@example.test'], ['Rowan', 'Example', null, 'rowan@example.test']]
      .map(([givenName, familyName, phoneE164, email], i) => ({ id: id(850 + i), givenName, familyName, email, phoneE164, version: 1, createdAt: iso() })), meta: { requestId: id(860), correlationId: id(860) } });
    if (path === `${prefix}/staff-roles/lists`) return json(route, 200, { data: { roles: [{ id: id(880), code: 'CUSTOM_FRONT_DESK', name: 'Front desk', version: 1, permissionCodes: ['school.view', 'crm.lead.read'] }], grants: [] }, meta: {} });
    if (path === `${prefix}/staff-roles/permissions`) return json(route, 200, { data: [['school.view', 'View the school', false], ['attendance.record', 'Record attendance', false], ['attendance.cards.manage', 'Choose how attendance cards look', true], ['crm.lead.read', 'Read leads', false], ['billing.refund.create', 'Create refunds', true]]
      .map(([code, description, sensitive]) => ({ code, description, sensitive })), meta: {} });
    if (path === `${prefix}/pickers/staff`) return json(route, 200, { data: [['Avery Sample', 870], ['Rowan Example', 871], ['Kim Placeholder', 872]]
      .map(([displayName, n]) => ({ principalId: id(n), displayName })), meta: { requestId: id(875), correlationId: id(875), limit: 200 } });
    if (path === `${prefix}/pickers/testing-candidates`) return json(route, 200, { data: [['Avery', 'Sample', 'PASSED'], ['Rowan', 'Example', 'PASSED'], ['Kim', 'Placeholder', 'DEFERRED']]
      .map(([givenName, familyName, result], i) => ({ candidateId: id(800 + i), version: 2, result, testingEventId: id(810), testingEventName: 'Synthetic spring test', startsAt: at(-day),
        studentProfileId: id(820 + i), givenName, familyName, curriculumName: 'Synthetic curriculum', targetRankId: id(830), targetRankName: 'Yellow belt' })), meta: { requestId: id(840), correlationId: id(840), limit: 50 } });
    if (path === `${prefix}/reports/operations`) return json(route, 200, { data: { operationalSnapshot: snapshot(scope) }, meta: {} });
    if (path === `${prefix}/agent-voices`) {
      if (method === 'PUT') {
        const b = JSON.parse(route.request().postData() ?? '{}'); voicePuts.push({ body: b, key: route.request().headers()['idempotency-key'] });
        if (voiceFailNext) { const f = voiceFailNext; voiceFailNext = null; return json(route, f, { code: 'SYNTHETIC' }); }
        voiceChoices = { ...voiceChoices, [b.agentKey]: b.voiceChoice };
      }
      return json(route, 200, { data: { choices: voiceChoices }, meta: { requestId: id(950), correlationId: id(950), replayed: false } });
    }
    if (path === `${prefix}/interface-theme`) {
      if (method === 'PUT') theme = JSON.parse(route.request().postData() ?? '{}').interfaceTheme ?? theme;
      return json(route, 200, { data: { interfaceTheme: theme, selectedVia: 'SETTINGS', updatedAt: iso() }, meta: {} });
    }
  }
  return json(route, 403, { code: 'FORBIDDEN' });
}

const probe = createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const session = { mode: 'OIDC', audience: 'team-chat-browser-synthetic', secret: randomBytes(32).toString('hex') };
const server = spawn(join(webRoot, 'node_modules/.bin/next'), ['start', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: webRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'production', HON_DEPLOYMENT_ENVIRONMENT: 'preview', NEXT_TELEMETRY_DISABLED: '1', HON_API_BASE_URL: 'http://127.0.0.1:9', HON_AUTH_MODE: session.mode, HON_SESSION_AUDIENCE: session.audience, HON_SESSION_JWT_SECRET: session.secret }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; i < 240; i += 1) { try { const r = await fetch(`${origin}/auth/login`); if (r.status < 500) break; } catch { /* starting */ } await new Promise((done) => setTimeout(done, 500)); }

const browser = await chromium.launch();
async function open(viewport, path, { language, clock } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  // Headless Chromium crashes on its real speech recognition: every page gets the fake browser speech below.
  await ctx.addInitScript(FAKE_SPEECH);
  await ctx.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: 'shell-synthetic-owner' }, session), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/api/')) return api(route);
    return route.continue();
  });
  const page = await ctx.newPage();
  if (clock) await page.clock.install();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(`${origin}${path}`);
  if (language) await page.evaluate((l) => { document.documentElement.lang = l; }, language);
  return { ctx, page };
}
async function check(name, work) { try { await work(); report.checks.push(name); } catch (error) { report.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); } }
async function shot(page, name) { await page.screenshot({ path: join(results, `${name}.png`) }); report.screenshots.push(`${name}.png`); }
async function noOverflow(page) {
  const offenders = await page.evaluate(() => [...document.querySelectorAll('[data-hon-ui] *')]
    .filter((e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.right > window.innerWidth + 1 && s.position !== 'fixed' && !e.closest('[data-drawer="closed"]') && !e.closest('nav[aria-label] a') ; })
    .slice(0, 5).map((e) => `${e.tagName}.${e.className}`));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `page scrolls horizontally: ${offenders.join(', ')}`);
}
const viewports = { desktop: { width: 1440, height: 900 }, tablet: { width: 834, height: 1112 }, phone: { width: 390, height: 844 } };

// Fake browser speech: recognition answers with window.__say; speech output records each utterance and its pitch.
const FAKE_SPEECH = () => {
  window.__spoken = [];
  class FakeRecognition {
    start() { const say = window.__say ?? ''; setTimeout(() => { this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: say }], { isFinal: true, 0: { transcript: say } })] }); this.onend?.(); }, 30); }
    stop() {} abort() {}
  }
  window.SpeechRecognition = FakeRecognition; window.webkitSpeechRecognition = FakeRecognition;
  class FakeUtterance { constructor(text) { this.text = text; this.pitch = 1; this.rate = 1; this.onend = null; this.onerror = null; } }
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, writable: true, value: FakeUtterance });
  const synth = { getVoices: () => [], cancel() {}, speak(u) { window.__spoken.push({ text: u.text, pitch: u.pitch, rate: u.rate }); setTimeout(() => u.onend?.(), 10); } };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => synth });
};

async function openChat(viewport, mode) {
  theme = mode; multi = false;
  const ctxPage = await open(viewport, '/staff/dashboard');
  try { await ctxPage.page.waitForSelector('#team-chat[data-team-chat="READY"]', { timeout: 15000 }); }
  catch (error) { const state = await ctxPage.page.evaluate(() => document.querySelector('#team-chat')?.getAttribute('data-team-chat') ?? 'absent'); throw new Error(`team chat ${state}; api: ${report.apiRequests.slice(-12).join(' | ')}; errors: ${report.pageErrors.slice(-2).join(' | ')}`); }
  return ctxPage;
}
const chat = (page) => page.locator('#team-chat');

for (const mode of ['modern', 'classic', 'big-button']) {
  await check(`team chat ${mode}: everyone answers in turn, then one plan together`, async () => {
    conversations.length = 0; turnBodies.length = 0;
    const { ctx, page } = await openChat(viewports.desktop, mode);
    assert.equal(await page.locator('a[href="#team-chat"]').count(), 1, 'Talk to the whole team link under Ask HON');
    for (const k of ['hon', 'claire', 'alex', 'jordan', 'lena']) assert.equal(await chat(page).locator(`[data-member="${k}"]`).getAttribute('data-member-state'), 'TALKS', k);
    for (const k of ['marcus', 'chad', 'maya', 'kai']) assert.equal(await chat(page).locator(`[data-member="${k}"]`).getAttribute('data-member-state'), 'THROUGH_HON', k);
    await shot(page.locator('#team-chat').page(), `team-chat-${mode}-desktop-empty`);
    await chat(page).locator('textarea').fill('How do we grow the kids program this month?');
    await chat(page).getByRole('button', { name: /^Send · Everyone/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('#team-chat [data-message]').length === 6);
    assert.deepEqual(turnBodies.map((b) => b.delegation?.agentKey ?? 'hon'), ['hon', 'claire', 'alex', 'jordan', 'lena'], 'one ordinary turn each, in order');
    assert.equal(await chat(page).locator('[data-message="you"]').count(), 1, 'the question is shown once');
    await chat(page).getByRole('button', { name: 'Make a plan together' }).click();
    await page.waitForSelector('#team-chat [data-plan="true"]');
    assert.deepEqual(turnBodies.at(-1), { text: turnBodies.at(-1).text, delegation: null, replyMode: 'DETAILED' });
    assert.match(turnBodies.at(-1).text, /^Make one plan from what the team said/);
    assert.equal(await chat(page).getByRole('button', { name: 'Make a plan together' }).isDisabled(), true, 'no second plan until the team answers again');
    // Take turns: "@Jordan" asks Jordan only and switches the chat to him.
    await chat(page).locator('textarea').fill('@Jordan can we add a Tuesday kids class?');
    await chat(page).locator('textarea').press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#team-chat [data-message]').length === 10);
    assert.deepEqual(turnBodies.at(-1), { text: 'can we add a Tuesday kids class?', delegation: { agentKey: 'jordan' } });
    assert.equal(await chat(page).locator('[data-member="jordan"]').getAttribute('aria-pressed'), 'true');
    await page.locator('#team-chat').scrollIntoViewIfNeeded(); await page.waitForTimeout(200);
    await noOverflow(page);
    await axeScan(page, `team-chat-${mode}-desktop`);
    await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: join(results, `team-chat-${mode}-desktop.png`), fullPage: true }); report.screenshots.push(`team-chat-${mode}-desktop.png`);
    // The chat comes back after a reload (the newest team chat).
    await page.reload(); await page.waitForSelector('#team-chat [data-plan="true"]');
    await ctx.close();
  });
  await check(`team chat ${mode} phone`, async () => {
    const { ctx, page } = await openChat(viewports.phone, mode);
    await page.waitForSelector('#team-chat [data-plan="true"]');
    await page.locator('#team-chat').scrollIntoViewIfNeeded(); await page.waitForTimeout(200);
    await noOverflow(page);
    await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: join(results, `team-chat-${mode}-phone.png`), fullPage: true }); report.screenshots.push(`team-chat-${mode}-phone.png`);
    await ctx.close();
  });
}

await check('voice: a spoken question goes to the whole team and each answer is read in its own voice', async () => {
  conversations.length = 0; turnBodies.length = 0;
  const { ctx, page } = await openChat(viewports.desktop, 'modern');
  await chat(page).getByRole('button', { name: 'Turn on voice' }).click();
  await page.evaluate(() => { window.__say = 'Everyone, what should we focus on this week?'; });
  await chat(page).getByRole('button', { name: 'Talk to the team' }).click();
  // The follow-up listen after the answers hears silence (the fake would otherwise repeat the question forever).
  await page.waitForFunction(() => window.__spoken.length >= 1, null, { timeout: 15000 }); await page.evaluate(() => { window.__say = ''; });
  await page.waitForFunction(() => window.__spoken.length >= 5, null, { timeout: 15000 });
  assert.deepEqual(turnBodies.map((b) => [b.delegation?.agentKey ?? 'hon', b.text]), ['hon', 'claire', 'alex', 'jordan', 'lena'].map((k) => [k, 'what should we focus on this week?']));
  const spoken = await page.evaluate(() => window.__spoken);
  assert.deepEqual(spoken.slice(0, 5).map((s) => s.text.split(' says:')[0]), ['HON', 'Claire', 'Alex', 'Jordan', 'Lena']);
  assert.equal(new Set(spoken.slice(0, 5).map((s) => s.pitch)).size, 5, 'a different voice for each teammate');
  // Speaking a name asks only that teammate.
  await page.evaluate(() => { window.__say = 'Lena, one flyer idea please'; window.__spoken = []; });
  await page.waitForFunction(() => !document.querySelector('#team-chat [data-voice="SPEAKING"]'));
  await chat(page).getByRole('button', { name: /Talk to the team|Stop listening/ }).first().click();
  await page.waitForFunction(() => window.__spoken.length >= 1, null, { timeout: 15000 }); await page.evaluate(() => { window.__say = ''; });
  assert.deepEqual(turnBodies.at(-1), { text: 'one flyer idea please', delegation: { agentKey: 'lena' } });
  assert.match((await page.evaluate(() => window.__spoken[0].text)), /^Lena says:/);
  await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: join(results, 'team-chat-voice-desktop.png'), fullPage: true }); report.screenshots.push('team-chat-voice-desktop.png');
  await ctx.close();
});

await check('voices: choose a voice per teammate, hear it first, saved to the account and used for answers', async () => {
  conversations.length = 0; turnBodies.length = 0; voicePuts.length = 0;
  const { ctx, page } = await openChat(viewports.desktop, 'modern');
  const picker = chat(page).locator('[data-voice-picker]');
  await picker.locator('summary').click();
  await page.waitForSelector('#team-chat [data-voice-picker][data-status="READY"]');
  assert.equal(await picker.locator('[data-voice-agent]').count(), 9, 'all nine teammates');
  assert.equal(await picker.locator('[data-voice-choice]').count(), 27, 'three voices each');
  const jordan = picker.locator('[data-voice-agent="jordan"]');
  // Hear it first: nothing is saved, the sample is spoken in that voice.
  await page.evaluate(() => { window.__spoken = []; });
  await jordan.locator('[data-voice-hear="2"]').click();
  await page.waitForFunction(() => window.__spoken.length === 1);
  const sample = await page.evaluate(() => window.__spoken[0]);
  assert.match(sample.text, /^Hi, I’m Jordan\./); assert.deepEqual([sample.pitch, sample.rate], [0.95, 0.9]);
  assert.equal(voicePuts.length, 0, 'hearing a voice saves nothing');
  // Choose Lively (3) for Jordan: shown at once, saved with a retry key.
  await jordan.locator('[data-voice-choice="3"]').click();
  await page.waitForFunction(() => document.querySelector('#team-chat [data-voice-agent="jordan"] [data-voice-choice="3"]')?.getAttribute('aria-pressed') === 'true');
  await page.waitForFunction(() => !document.querySelector('#team-chat [data-voice-agent="jordan"] [role="status"]'));
  assert.equal(voicePuts.length, 1); assert.deepEqual(voicePuts[0].body, { agentKey: 'jordan', voiceChoice: 3 }); assert.match(voicePuts[0].key, /^[0-9a-f-]{36}$/);
  await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: join(results, 'voice-picker-modern-desktop.png'), fullPage: true }); report.screenshots.push('voice-picker-modern-desktop.png');
  // A failed save brings the previous voice back and says so.
  voiceFailNext = 500;
  await picker.locator('[data-voice-agent="lena"] [data-voice-choice="2"]').click();
  await picker.locator('[data-voice-agent="lena"] [role="alert"]').waitFor();
  assert.equal(await picker.locator('[data-voice-agent="lena"] [data-voice-choice="1"]').getAttribute('aria-pressed'), 'true', 'Lena back on her usual voice');
  // The next spoken round uses Jordan's chosen voice.
  await chat(page).getByRole('button', { name: 'Turn on voice' }).click();
  await page.evaluate(() => { window.__say = 'Everyone, what should we focus on this week?'; window.__spoken = []; });
  await chat(page).getByRole('button', { name: 'Talk to the team' }).click();
  await page.waitForFunction(() => window.__spoken.length >= 1, null, { timeout: 15000 }); await page.evaluate(() => { window.__say = ''; });
  await page.waitForFunction(() => window.__spoken.length >= 5, null, { timeout: 15000 });
  assert.equal(turnBodies.length, 5, 'one round only');
  const spokenJordan = (await page.evaluate(() => window.__spoken)).find((x) => x.text.startsWith('Jordan says:'));
  assert.deepEqual([spokenJordan.pitch, spokenJordan.rate], [1, 1.15], 'Jordan answers in the Lively voice');
  await ctx.close();
  // Saved to the account: a new session on another device shows the same choice.
  const again = await openChat(viewports.phone, 'big-button');
  const p2 = chat(again.page).locator('[data-voice-picker]');
  await p2.locator('summary').click();
  await again.page.waitForFunction(() => document.querySelector('#team-chat [data-voice-agent="jordan"] [data-voice-choice="3"]')?.getAttribute('aria-pressed') === 'true');
  await noOverflow(again.page);
  await p2.locator('[data-voice-agent="alex"]').evaluate((el) => el.scrollIntoView({ block: 'start' })); await again.page.screenshot({ path: join(results, 'voice-picker-big-button-phone.png') }); report.screenshots.push('voice-picker-big-button-phone.png');
  await again.ctx.close();
  voiceChoices = { hon: 1, claire: 1, alex: 1, jordan: 1, lena: 1, marcus: 1, chad: 1, maya: 1, kai: 1 };
});

await check('an unknown outcome stops the round and Retry resends the exact same request', async () => {
  conversations.length = 0; turnBodies.length = 0;
  const { ctx, page } = await openChat(viewports.desktop, 'modern');
  await chat(page).locator('textarea').fill('Everyone, any quick wins?');
  failNext = 503; // HON's turn is answered with a 5xx: the outcome is unknown.
  await chat(page).getByRole('button', { name: /^Send/ }).click();
  await page.waitForSelector('#team-chat [data-stalled="UNKNOWN"]');
  assert.equal(await chat(page).locator('textarea').isDisabled(), true);
  await chat(page).getByRole('button', { name: 'Retry' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#team-chat [data-message]').length === 6);
  assert.deepEqual(turnBodies.map((b) => b.delegation?.agentKey ?? 'hon'), ['hon', 'claire', 'alex', 'jordan', 'lena']);
  await ctx.close();
});

await check('a role without analysts: HON only, others shown honestly; no AI: nothing to send', async () => {
  teamReadiness = { ...teamReadiness, businessPerformance: false, availableAnalystKeys: [] };
  const { ctx, page } = await openChat(viewports.desktop, 'modern');
  assert.equal(await chat(page).locator('[data-member="jordan"]').getAttribute('data-member-state'), 'NOT_AVAILABLE');
  await ctx.close();
  teamReadiness = { ...teamReadiness, honReply: false };
  const second = await openChat(viewports.desktop, 'modern');
  assert.equal(await chat(second.page).locator('textarea').count(), 0);
  await chat(second.page).locator('[data-phase="not-ready"]').waitFor();
  await second.ctx.close();
  teamReadiness = { ...teamReadiness, honReply: true, businessPerformance: true, availableAnalystKeys: ['claire', 'alex', 'jordan', 'lena'] };
});

await check('another school sees nothing of this chat', async () => {
  const before = report.apiRequests.length;
  multi = true;
  const { ctx, page } = await open(viewports.desktop, '/staff/dashboard');
  await page.waitForTimeout(800);
  assert.equal(report.apiRequests.slice(before).some((r) => r.includes(`/schools/${schoolA.schoolId}/hon/`)), false, 'no school A HON read for school B');
  await ctx.close(); multi = false;
});

await browser.close(); server.kill('SIGTERM');
await writeFile(join(results, 'report.json'), JSON.stringify({ ...report, apiRequests: report.apiRequests.length }, null, 2));
if (report.pageErrors.length) report.failures.push(...report.pageErrors.map((e) => `page error: ${e}`));
console.log(JSON.stringify({ checks: report.checks, failures: report.failures, screenshots: report.screenshots.length }, null, 2));
if (report.failures.length) { console.error(serverLog.slice(-3000)); process.exit(1); }
