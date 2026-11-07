/**
 * Disposable local browser proof for the unified HON command experience.
 * Synthetic fixtures only: every /api/v1 request is answered in the browser by
 * this script. No database, provider, payment or production backend is used.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { issueSession, HON_SESSION_COOKIE } from '@hon/auth';

if (process.env.HON_COMMAND_BROWSER_LOCAL !== '1') throw new Error('Explicitly opt into disposable local browser verification with HON_COMMAND_BROWSER_LOCAL=1.');
for (const key of ['DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY']) {
  if (process.env[key]) throw new Error('Browser verification refuses inherited database/provider credentials.');
}
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tools = process.env.HON_COMMAND_BROWSER_TOOLS;
const results = process.env.HON_COMMAND_BROWSER_RESULTS;
const playwrightPath = process.env.HON_COMMAND_PLAYWRIGHT;
assert(tools && results && playwrightPath, 'HON_COMMAND_BROWSER_TOOLS (axe-core), HON_COMMAND_BROWSER_RESULTS and HON_COMMAND_PLAYWRIGHT are required.');
const toolsRequire = createRequire(join(tools, 'runner.cjs'));
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const axeSource = await readFile(toolsRequire.resolve('axe-core/axe.min.js'), 'utf8');
await mkdir(results, { recursive: true });

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { organizationId: id(1), schoolId: id(2) };
const now = Date.parse('2026-10-24T15:00:00.000Z');
const iso = (offsetHours) => new Date(now + offsetHours * 3_600_000).toISOString();
const report = { syntheticFixturesOnly: true, databaseAccess: false, providerCalls: false, checks: [], failures: [], screenshots: [], accessibility: [], pageErrors: [], apiRequests: [], preExistingFindings: [] };

// ---------- fixtures ----------
let theme = 'modern';
let mode = 'ready'; // ready | empty | denied | error | slow | multi
const snapshot = () => ({
  organizationId: scope.organizationId, schoolId: scope.schoolId, generatedAt: iso(0), from: iso(-720), to: iso(0),
  studentProfiles: { total: 148 },
  leads: { byStatus: { OPEN: 23, WON: 9, LOST: 4, ARCHIVED: 2 } },
  classSessions: { inRange: { scheduled: 64, completed: 58, cancelled: 2 } },
  attendance: { inRangeByStatus: { PRESENT: 812, LATE: 31, EXCUSED_ABSENCE: 22, UNEXCUSED_ABSENCE: 15, MAKEUP: 6 } },
  memberships: { byState: { DRAFT: 3, ACTIVE: 131, FROZEN: 4, CANCELLATION_PENDING: 2, CANCELLED: 7, EXPIRED: 5 } },
  invoices: { inRangeByStatus: { DRAFT: 2, ISSUED: 6, PAID: 118, VOID: 1, UNCOLLECTIBLE: 0 } },
  paymentAttempts: { inRangeByState: { PENDING: 0, PROCESSING: 1, SUCCEEDED: 118, FAILED: 3, REQUIRES_ACTION: 0, UNKNOWN: 0, REFUNDED: 1 } },
});
const DAY = 86_400_000;
const windowed = (count, days, forward = false) => ({ availability: 'AVAILABLE', windowFrom: new Date(forward ? now : now - days * DAY).toISOString(), windowTo: new Date(forward ? now + days * DAY : now).toISOString(), count });
function commandCenter(empty) {
  const m = empty
    ? { leads: 0, trials: 0, testing: 0, approvals: 0, work: 0, terms: 0 }
    : { leads: 3, trials: 2, testing: 1, approvals: 2, work: 1, terms: 4 };
  const values = [];
  if (m.leads) values.push(`${m.leads} new ${m.leads === 1 ? 'lead' : 'leads'} in the last 24 hours`);
  if (m.trials) values.push(`${m.trials} trial ${m.trials === 1 ? 'appointment' : 'appointments'} scheduled in the next 24 hours`);
  if (m.testing) values.push(`${m.testing} testing ${m.testing === 1 ? 'event' : 'events'} in the next 30 days`);
  if (m.terms) values.push(`${m.terms} membership ${m.terms === 1 ? 'term' : 'terms'} ending in the next 30 days`);
  if (m.approvals) values.push(`${m.approvals} action ${m.approvals === 1 ? 'approval' : 'approvals'} awaiting review`);
  if (m.work) values.push(`${m.work} outstanding durable ${m.work === 1 ? 'work item' : 'work items'}`);
  const recommendations = [];
  if (m.approvals) recommendations.push({ id: 'REVIEW_PENDING_APPROVALS', title: 'Review pending approvals', why: `${m.approvals} current action ${m.approvals === 1 ? 'request is' : 'requests are'} awaiting a qualified human review.`, route: '/staff/action-center/approvals', action: 'NAVIGATE', automaticExecution: false });
  if (m.work) recommendations.push({ id: 'REVIEW_OUTSTANDING_WORK', title: 'Review outstanding work', why: `${m.work} durable ${m.work === 1 ? 'work item remains' : 'work items remain'} in a nonterminal state.`, route: '/staff/work', action: 'NAVIGATE', automaticExecution: false });
  if (m.trials) recommendations.push({ id: 'PREPARE_UPCOMING_TRIALS', title: 'Prepare upcoming trials', why: `${m.trials} scheduled trial ${m.trials === 1 ? 'appointment starts' : 'appointments start'} within 24 hours.`, route: '/staff/search', action: 'NAVIGATE', automaticExecution: false });
  if (m.leads) recommendations.push({ id: 'REVIEW_NEW_LEADS', title: 'Review new leads', why: `${m.leads} CRM ${m.leads === 1 ? 'lead was' : 'leads were'} created in the last 24 hours.`, route: '/staff/search', action: 'NAVIGATE', automaticExecution: false });
  if (m.terms) recommendations.push({ id: 'PREPARE_MEMBERSHIP_RENEWALS', title: 'Prepare membership reviews', why: `${m.terms} active or cancellation-pending membership ${m.terms === 1 ? 'term ends' : 'terms end'} within 30 days.`, route: '/staff/billing/renewals', action: 'NAVIGATE', automaticExecution: false });
  return {
    organizationId: scope.organizationId, schoolId: scope.schoolId, entitlementTier: 'COMPLETE', generatedAt: iso(0),
    metrics: {
      newLeads24h: windowed(m.leads, 1), upcomingTrials24h: windowed(m.trials, 1, true), upcomingTestingEvents30d: windowed(m.testing, 30, true),
      pendingActionApprovals: { availability: 'AVAILABLE', count: m.approvals }, outstandingWorkItems: { availability: 'AVAILABLE', count: m.work },
      membershipTermsEnding30d: windowed(m.terms, 30, true),
      paidInvoicesCreated30d: { ...windowed(empty ? 0 : 2, 30), amountsByCurrency: empty ? [] : [{ currency: 'USD', count: 2, totalMinor: 29800 }] },
      unansweredInquiries: { availability: 'UNAVAILABLE', reason: 'No approved inquiry response-state projection exists.' },
      attendanceDecline: { availability: 'INSUFFICIENT_DATA', reason: 'No approved attendance-decline policy or longitudinal projection exists.' },
      trialConversion: { availability: 'UNAVAILABLE', reason: 'No authoritative trial-to-enrollment linkage is available.' },
      revenue: { availability: 'UNAVAILABLE', reason: 'Current paid invoice state is not authoritative cash revenue or collection data.' },
    },
    dailyBriefing: values.length ? `Daily briefing: ${values.join('; ')}.` : 'Daily briefing: no counted priorities are currently recorded in the available Command Center metrics.',
    recommendations,
  };
}
const work = (n, agentKey, status, hours, actionRequestId = null, reason = null) => ({ id: id(n), agentKey, schoolId: scope.schoolId, sourceRecordId: id(n + 100), workItemId: id(n + 200), status, reason, actionRequestId, updatedAt: iso(hours) });
const draftWork = {
  chad: [work(31, 'chad', 'AWAITING_APPROVAL', -2, id(51)), work(32, 'chad', 'CONFIGURATION_REQUIRED', -30, null, 'PROVIDER_NOT_CONFIGURED')],
  marcus: [work(33, 'marcus', 'SAVED', -5, id(52))],
  claire: [work(34, 'claire', 'SAVED', -50, id(53))],
};
const approval = (n, actionCode, hours) => ({ id: id(n), actionCode, status: 'AWAITING_APPROVAL', requestedByPrincipalId: id(60), effectiveAuthorityMode: 'CONFIRM', policyVersion: 1, approvalExpiresAt: iso(hours + 48), createdAt: iso(hours) });

// Ask HON conversation fixtures. Default: provider route not activated, so HON cannot answer (the real state today).
const hon = { reply: false, conversations: [], turns: new Map(), queue: [], posts: [], held: null, readinessReads: 0 };
const honReadiness = () => ({ contract: true, providerRoute: hon.reply, entitlement: true, authorization: true, availableAgentKeys: hon.reply ? ['marcus', 'claire', 'chad'] : [], honReply: hon.reply, asOf: iso(0) });
const replyDetail = (mode = 'STANDARD', over = {}) => ({ mode, step: 1, maxSteps: 3, truncated: false, canContinue: false, continuesTurnId: null, ...over });
let honSeq = 700;
async function honApi(route, path, method, prefix) {
  const base = `${prefix}/hon`;
  if (path === `${base}/readiness` && method === 'GET') { hon.readinessReads += 1; return json(route, 200, { data: honReadiness(), meta: { requestId: 'synthetic', correlationId: 'synthetic' } }); }
  if (path === `${base}/conversations` && method === 'GET') return json(route, 200, { data: { items: hon.conversations.map(({ turns, ...rest }) => rest), nextCursor: null } });
  const read = path.match(new RegExp(`^${base}/conversations/([0-9a-f-]{36})$`));
  if (read && method === 'GET') { const c = hon.conversations.find((x) => x.id === read[1]); return c ? json(route, 200, { data: c }) : json(route, 404, { code: 'HON_CONVERSATION_NOT_FOUND' }); }
  if (method !== 'POST') return json(route, 404, { code: 'NOT_FOUND' });
  const request = route.request();
  const headers = request.headers();
  const body = request.postData() ?? '';
  hon.posts.push({ path, key: headers['idempotency-key'], body, command: headers['x-hon-human-command'] });
  assert.equal(headers['x-hon-human-command'], 'hon-conversation');
  const step = hon.queue.shift();
  if (step === 'lost') return route.abort('connectionreset');
  if (step === 'timeout') return json(route, 503, { code: 'HON_CONVERSATION_TIMEOUT' });
  if (step === 'paused') return json(route, 403, { code: 'HON_AI_SPEND_REFUSED', reason: 'AI_SPEND_PAUSED' });
  if (step === 'hold') await new Promise((done) => { hon.held = done; });
  // Idempotent replay: the same key returns the first result.
  const prior = hon.turns.get(headers['idempotency-key']);
  if (prior) return json(route, 200, { data: prior });
  if (path === `${base}/conversations`) {
    const c = { id: id(honSeq += 1), title: JSON.parse(body).title, createdAt: iso(0), updatedAt: iso(0), turnCount: 0, status: 'READY', turns: [] };
    hon.conversations.unshift(c); const summary = { ...c }; delete summary.turns;
    hon.turns.set(headers['idempotency-key'], summary);
    return json(route, 200, { data: summary });
  }
  const turn = path.match(new RegExp(`^${base}/conversations/([0-9a-f-]{36})/turns$`));
  const c = turn && hon.conversations.find((x) => x.id === turn[1]);
  if (!c) return json(route, 404, { code: 'HON_CONVERSATION_NOT_FOUND' });
  const ask = JSON.parse(body); const turnId = id(honSeq += 1);
  const long = /long/i.test(ask.text);
  const text = ask.continueTurnId ? 'Second part: book the two trial follow-ups for Tuesday and confirm the testing date with parents.'
    : long ? 'Here is a detailed plan for this week. First, follow up the three new leads from the weekend…' : 'You have 3 new leads in the last 24 hours and 2 trial appointments tomorrow. I suggest following up the leads first.';
  const detail = ask.continueTurnId ? replyDetail('DETAILED', { step: 2, continuesTurnId: ask.continueTurnId }) : replyDetail(ask.replyMode ?? 'STANDARD', long ? { truncated: true, canContinue: true } : {});
  c.turns.push({ turnId, role: 'HUMAN', text: ask.text, createdAt: iso(0), status: 'COMPLETED', reason: null, references: { workItemId: null, actionRequestId: null, invocationId: null }, replyDetail: null });
  c.turns.push({ turnId, role: 'hon', text, createdAt: iso(0), status: 'COMPLETED', reason: null, references: { workItemId: id(honSeq += 1), actionRequestId: null, invocationId: id(honSeq += 1) }, replyDetail: detail });
  c.turnCount += 1; c.status = 'COMPLETED';
  const receipt = { turnId, conversationId: c.id, status: 'COMPLETED', reason: null, delegatedAgentKeys: [], actionRequestIds: [], workItemIds: [c.turns.at(-1).references.workItemId], invocationId: c.turns.at(-1).references.invocationId, reply: text, replyDetail: detail };
  hon.turns.set(headers['idempotency-key'], receipt);
  return json(route, 200, { data: receipt });
}

// Creative Studio: the school's own wallet read (synthetic). 'denied' answers 403.
let studio = 'ready';
const studioByKind = (available, held) => ['INCLUDED_MONTHLY', 'ADJUSTMENT', 'PROMOTIONAL', 'PURCHASED_TOPUP'].map((kind) => ({ kind,
  grantedCredits: kind === 'INCLUDED_MONTHLY' ? 12000 : 0, availableCredits: kind === 'INCLUDED_MONTHLY' ? available : 0, heldCredits: kind === 'INCLUDED_MONTHLY' ? held : 0,
  consumedCredits: kind === 'INCLUDED_MONTHLY' ? 12000 - available - held : 0, expiredCredits: 0, debitedCredits: 0 }));
const creativeWallet = () => ({ schoolId: scope.schoolId, walletVersion: 3, program: { status: 'ACTIVE', monthlyIncludedCredits: 12000 },
  eligibility: { eligible: true, reason: null, window: { index: 1, startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-11-01T00:00:00.000Z' } },
  balance: { availableCredits: 11640, heldCredits: 120, byKind: studioByKind(11640, 120) },
  lots: [], reservations: [], adjustments: [], purchases: [],
  history: [
    { entryId: id(301), lotId: id(300), lotKind: 'INCLUDED_MONTHLY', entryKind: 'GRANT', credits: 12000, reservationId: null, adjustmentId: null, occurredAt: '2026-10-01T00:00:00.000Z' },
    { entryId: id(302), lotId: id(300), lotKind: 'INCLUDED_MONTHLY', entryKind: 'FINALIZE', credits: 240, reservationId: null, adjustmentId: null, occurredAt: iso(-30) },
    { entryId: id(303), lotId: id(300), lotKind: 'INCLUDED_MONTHLY', entryKind: 'RESERVE', credits: 120, reservationId: null, adjustmentId: null, occurredAt: iso(-1) }],
  rates: { rateVersionId: id(310), rateVersion: 1, termsReference: 'synthetic-terms-v1', publishedAt: iso(-200), rates: [
    { operationCode: 'image.standard', mediaKind: 'IMAGE', displayName: 'Standard image', billingUnit: 'IMAGE', creditsPerUnit: 40, maxUnitsPerRequest: 4, rateBasis: 'PROVISIONAL' },
    { operationCode: 'video.short_clip', mediaKind: 'VIDEO', displayName: 'Short promo video', billingUnit: 'VIDEO_SECOND', creditsPerUnit: 60, maxUnitsPerRequest: 15, rateBasis: 'PROVISIONAL' }] },
  packages: [['STARTER', 3000, 0, 3000], ['GROWTH', 6000, 1200, 6000], ['CREATOR', 12000, 4800, 12000]].map(([packageCode, base, bonus, price]) => ({ packageCode, packageVersion: 1, baseCredits: base, bonusCredits: bonus, totalCredits: base + bonus, priceMinor: price, currency: 'usd' })),
  agentConversationsDeductCredits: false, paymentsActive: false });
function json(route, status, body, headers = {}) {
  return route.fulfill({ status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', ...headers }, body: JSON.stringify(body) });
}
async function api(route) {
  const url = new URL(route.request().url());
  const path = url.pathname;
  const method = route.request().method();
  report.apiRequests.push(`${method} ${path}${url.search}`);
  if (mode === 'slow' && /assistant\/mine|teaching-assistant\/mine|command-center|action-center/.test(path)) await new Promise((done) => setTimeout(done, 60_000));
  const prefix = `/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}`;
  if (path === '/api/v1/staff/current-reporting-school') return json(route, 200, { data: mode === 'multi' ? { state: 'MANUAL_ENTRY_REQUIRED' } : { state: 'RESOLVED', ...scope } });
  if (path === '/api/v1/staff/reporting-schools') return json(route, 200, { data: { state: 'SELECTION_REQUIRED', schools: [{ organizationId: scope.organizationId, organizationName: 'Synthetic Dojo Group', schoolId: scope.schoolId, schoolName: 'Synthetic Martial Arts Academy' }] } });
  if (path.startsWith(`${prefix}/hon/`)) return honApi(route, path, method, prefix);
  if (path === `/api/v1/schools/${scope.schoolId}/creative-credits`) {
    assert.equal(method, 'GET', 'Creative Studio only reads the wallet');
    return studio === 'denied' ? json(route, 403, { code: 'FORBIDDEN' }) : json(route, 200, { data: creativeWallet() });
  }
  if (path === `${prefix}/reports/operations`) return json(route, 200, { data: { operationalSnapshot: snapshot() }, meta: {} });
  if (path === `${prefix}/interface-theme`) {
    if (method === 'PUT') theme = JSON.parse(route.request().postData() ?? '{}').interfaceTheme ?? theme;
    return json(route, 200, { data: { interfaceTheme: theme, selectedVia: 'SETTINGS', updatedAt: iso(0) }, meta: {} });
  }
  if (path.startsWith('/api/v1/owner-launch')) return json(route, 403, { code: 'FORBIDDEN' });
  if (mode === 'error' && /\/mine$|command-center|action-center/.test(path)) return json(route, 503, { code: 'UNAVAILABLE' });
  if (mode === 'denied' && /\/mine$|command-center|action-center/.test(path)) return json(route, 403, { code: 'FORBIDDEN' });
  if (path === `${prefix}/command-center`) return json(route, 200, { data: { commandCenter: commandCenter(mode === 'empty') }, meta: {} });
  if (path === '/api/v1/staff/leads/assistant/mine') return json(route, 200, { data: mode === 'empty' ? [] : draftWork.chad });
  if (path === '/api/v1/marketing/assistant/mine') return json(route, 200, { data: mode === 'empty' ? [] : draftWork.marcus });
  if (path === '/api/v1/staff/teaching-assistant/mine') return json(route, 200, { data: mode === 'empty' ? [] : draftWork.claire });
  if (path === `/api/v1/staff/action-center/approvals/${scope.schoolId}`) {
    const items = mode === 'empty' ? [] : [approval(41, 'crm.follow_up_draft.propose', -2), approval(42, 'marketing.draft.save', -6)];
    return json(route, 200, { data: { organizationId: scope.organizationId, schoolId: scope.schoolId, reviewerPrincipalId: id(61), reviewerPermission: 'action.approve', status: 'AWAITING_APPROVAL', items, nextAfter: null, executionTriggered: false } });
  }
  return json(route, 404, { code: 'NOT_FOUND' });
}

// ---------- server ----------
const probe = createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const session = { mode: 'OIDC', audience: 'hon-command-browser-synthetic', secret: randomBytes(32).toString('hex') };
const command = process.env.HON_COMMAND_SERVER === 'start' ? ['start', '--port', String(port), '--hostname', '127.0.0.1'] : ['dev', '--port', String(port), '--hostname', '127.0.0.1'];
const server = spawn(join(webRoot, 'node_modules/.bin/next'), command, { cwd: webRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: command[0] === 'start' ? 'production' : 'development', HON_DEPLOYMENT_ENVIRONMENT: 'preview', NEXT_TELEMETRY_DISABLED: '1', HON_API_BASE_URL: 'http://127.0.0.1:9', HON_AUTH_MODE: session.mode, HON_SESSION_AUDIENCE: session.audience, HON_SESSION_JWT_SECRET: session.secret }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; i < 240; i += 1) { try { const r = await fetch(`${origin}/auth/login`); if (r.status < 500) break; } catch { /* starting */ } await new Promise((done) => setTimeout(done, 500)); }

const browser = await chromium.launch();
async function context(viewport) {
  const value = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await value.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: 'hon-command-synthetic-owner' }, session), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await value.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/api/v1/')) return api(route);
    return route.continue();
  });
  return value;
}
// HON_COMMAND_BROWSER_ONLY=<prefix> runs only the checks whose name starts with it (local iteration).
async function check(name, work) {
  if (process.env.HON_COMMAND_BROWSER_ONLY && !name.startsWith(process.env.HON_COMMAND_BROWSER_ONLY)) return;
  try { await work(); report.checks.push(name); } catch (error) { report.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
}
async function shot(page, name, fullPage = false) { await page.screenshot({ path: join(results, `${name}.png`), fullPage }); report.screenshots.push(`${name}.png`); }
// HON surfaces (panel, band, full workspace) must be clean. Whole-page results are
// also recorded so pre-existing dashboard findings stay visible without being hidden.
async function axe(page, name) {
  await page.addScriptTag({ content: axeSource });
  const run = (include) => page.evaluate(async (selectors) => (await window.axe.run(selectors ? { include: selectors.map((s) => [s]) } : document, { runOnly: ['wcag2a', 'wcag2aa'] })).violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target })), include);
  const selectors = await page.evaluate(() => ['[role="dialog"]', 'section[aria-labelledby="hon-band-title"]', 'main[data-variant]', 'section[aria-labelledby="creative-studio-title"]'].filter((s) => document.querySelector(s)));
  const result = await run(selectors);
  report.accessibility.push({ name, scope: selectors, violations: result, wholePage: await run(null) });
  const serious = result.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  assert.equal(serious.length, 0, `${name}: ${JSON.stringify(serious)}`);
}
// The existing Platform View picker (not part of this change) overflows in Classic at
// phone width; it is recorded as a pre-existing finding and excluded from this gate.
/**
 * Horizontal overflow, measured in the page. The document itself must fit the viewport. Only one container may
 * hold content past the edge: the shell's section tabs ([data-shell-tabs]), and only while that nav is itself a
 * scroll container inside the viewport and the item is laid out in its normal flow (so the nav clips it).
 * The existing Platform View picker is reported separately as a pre-existing finding.
 */
function overflowAudit() {
  const width = window.innerWidth;
  const clippedByShellTabs = (e) => {
    const nav = e.closest('[data-shell-tabs]');
    if (!nav || nav === e) return false;
    const style = getComputedStyle(nav), box = nav.getBoundingClientRect();
    if (!['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX) || box.left < -1 || box.right > width + 1) return false;
    for (let p = e; p && p !== nav; p = p.parentElement) if (['absolute', 'fixed'].includes(getComputedStyle(p).position)) return false;
    return true;
  };
  const offenders = [...document.querySelectorAll('body *')]
    .filter((e) => e.getBoundingClientRect().right > width + 1 && getComputedStyle(e).position !== 'fixed' && !clippedByShellTabs(e))
    .map((e) => ({ el: `${e.tagName}.${e.className}`, text: e.textContent?.slice(0, 40), parent: `${e.parentElement?.tagName}.${e.parentElement?.className}`, preExisting: !!e.closest('.view-picker') }));
  const documentWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  return { offenders, documentWidth, viewportWidth: width };
}
async function noOverflow(page, name) {
  const { offenders, documentWidth, viewportWidth } = await page.evaluate(overflowAudit);
  const preExisting = offenders.filter((o) => o.preExisting), current = offenders.filter((o) => !o.preExisting);
  if (preExisting.length) report.preExistingFindings.push(`${name ?? 'page'}: Platform View picker overflows (${preExisting.length} elements)`);
  assert.deepEqual(current, [], 'horizontal overflow');
  // The document must fit too, unless the only offenders are the known pre-existing picker.
  if (!preExisting.length) assert.ok(documentWidth <= viewportWidth + 1, `document is ${documentWidth}px wide in a ${viewportWidth}px viewport`);
}
async function dashboard(viewport, nextTheme) {
  theme = nextTheme; mode = 'ready';
  const ctx = await context(viewport); const page = await ctx.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(`${origin}/staff/dashboard`);
  await page.getByRole('heading', { name: 'HON', exact: true }).first().waitFor();
  await page.waitForFunction((value) => document.querySelector('main')?.getAttribute('data-interface-theme') === value, nextTheme);
  await page.locator('img').evaluateAll((images) => Promise.all(images.map((img) => img.complete ? null : new Promise((done) => { img.onload = img.onerror = done; }))));
  return { ctx, page };
}
async function openPanel(page) {
  await page.getByRole('button', { name: 'Open HON' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await dialog.getByText('Chad · Follow-up draft').first().waitFor({ state: 'attached' }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('[role="dialog"] [data-state="LOADING"]'));
  return dialog;
}

const KAI_STYLE = { modern: '/ai/kai.webp', classic: '/ai/kai-illustrated.webp', 'big-button': '/ai/kai-chibi.webp' };
const SEVEN_PORTRAITS = ['alex', 'chad', 'maya', 'marcus', 'jordan', 'claire', 'lena'].map((agent) => `/ai/${agent}.webp`);

// ---------- scenarios ----------
for (const [name, viewport, mode_] of [['desktop-1440', { width: 1440, height: 900 }, 'modern'], ['desktop-1440', { width: 1440, height: 900 }, 'big-button'], ['desktop-1440', { width: 1440, height: 900 }, 'classic'], ['phone-390', { width: 390, height: 844 }, 'modern'], ['phone-390', { width: 390, height: 844 }, 'big-button'], ['phone-390', { width: 390, height: 844 }, 'classic'], ['tablet-834', { width: 834, height: 1112 }, 'big-button']]) {
  await check(`${mode_} ${name} dashboard, panel and agents`, async () => {
    const { ctx, page } = await dashboard(viewport, mode_);
    const band = page.locator('section[aria-labelledby="hon-band-title"]');
    for (const agent of ['Alex', 'Chad', 'Maya', 'Marcus', 'Jordan', 'Claire', 'Lena']) await band.getByRole('button', { name: new RegExp(`^${agent},`) }).waitFor();
    assert.ok(await band.getByText('Business Performance Manager').isVisible());
    await noOverflow(page, `${mode_}-${name}`);
    await band.scrollIntoViewIfNeeded();
    await shot(page, `${mode_}-${name}-dashboard`);
    await shot(page, `${mode_}-${name}-dashboard-full`, true);
    const dialog = await openPanel(page);
    const panelOverflow = await page.evaluate(() => { const panel = document.querySelector('[role="dialog"]'); const edge = panel.getBoundingClientRect().right; return [...panel.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > edge + 1).map((e) => `${e.tagName}.${e.className}`).slice(0, 4); });
    assert.deepEqual(panelOverflow, [], 'HON panel content overflows');
    await shot(page, `${mode_}-${name}-hon-panel-team`);
    await dialog.getByRole('region', { name: /Kai/ }).scrollIntoViewIfNeeded();
    await page.waitForFunction((src) => { const img = document.querySelector(`[role="dialog"] img[src="${src}"]`); return img && img.complete && img.naturalWidth > 0; }, KAI_STYLE[mode_]);
    assert.equal(await dialog.locator('img[src^="/ai/kai"]').count(), 1, `${mode_} shows exactly one Kai style`);
    await shot(page, `${mode_}-${name}-hon-panel-kai`);
    await axe(page, `${mode_}-${name}-hon-panel`);
    await dialog.getByRole('button', { name: /^Chad,/ }).click();
    await dialog.getByRole('heading', { name: 'Chad' }).waitFor();
    await shot(page, `${mode_}-${name}-hon-agent-chad`);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await ctx.close();
  });
}

await check('modern desktop: every agent detail, Claire identity, suggested/work/approvals tabs', async () => {
  const { ctx, page } = await dashboard({ width: 1440, height: 900 }, 'modern');
  const dialog = await openPanel(page);
  for (const agent of ['alex', 'chad', 'maya', 'marcus', 'jordan', 'claire', 'lena']) {
    const name = agent[0].toUpperCase() + agent.slice(1);
    await dialog.getByRole('button', { name: new RegExp(`^${name},`) }).click();
    await dialog.getByRole('heading', { name }).waitFor();
    await shot(page, `agent-${agent}`);
    if (agent === 'claire') {
      assert.ok(await dialog.getByText('Business Performance Manager').first().isVisible());
      assert.equal(await dialog.getByText('Curriculum support').count(), 0);
      assert.ok(await dialog.getByText(/has no AI work contract yet/).isVisible());
    }
    assert.equal(await dialog.getByRole('link', { name: /draft workspace/ }).count(), ['chad', 'marcus'].includes(agent) ? 1 : 0, `${agent} draft workspace offer`);
    await dialog.getByRole('button', { name: '← All seven employees' }).click();
  }
  for (const [tab, file] of [['Suggested', 'tab-suggested'], ['AI work', 'tab-ai-work'], ['Approvals', 'tab-approvals']]) {
    await dialog.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
    await shot(page, `modern-desktop-1440-${file}`);
  }
  await dialog.getByRole('tab', { name: /^AI team/ }).click();
  const kai = dialog.getByRole('region', { name: /Kai/ });
  await kai.scrollIntoViewIfNeeded();
  assert.ok(await kai.getByText('Separate instructional AI · not part of the management team').isVisible(), 'Kai is separate from the seven');
  assert.ok(await kai.getByText(/never mark student proficiency/).isVisible(), 'Kai boundary shown');
  assert.ok(await kai.locator('img[src="/ai/kai.webp"]').evaluate((img) => img.complete && img.naturalWidth > 0), 'Kai portrait loads');
  assert.equal(await kai.getByRole('link').count(), 5, 'Kai links only to existing teaching tools');
  await shot(page, 'modern-desktop-1440-teaching-ai-card');
  await dialog.getByRole('tab', { name: /^AI work/ }).click();
  assert.ok(await dialog.getByText('Teaching draft assistant (legacy)').first().isVisible(), 'legacy teaching label');
  assert.equal(await dialog.getByText(/Kai/).count(), 0, 'legacy records are never attributed to Kai');
  assert.equal(await dialog.getByText(/Claire ·/).count(), 0, 'legacy records are never attributed to Claire');
  await ctx.close();
});

await check('keyboard: open from button, tab arrows, focus trap, Escape restores focus', async () => {
  const { ctx, page } = await dashboard({ width: 1440, height: 900 }, 'modern');
  const open = page.getByRole('button', { name: 'Open HON' });
  await open.focus(); await page.keyboard.press('Enter');
  await page.getByRole('dialog').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'H2');
  const team = page.getByRole('tab', { name: /^AI team/ });
  await team.focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.startsWith('Suggested')), true);
  assert.equal(await page.getByRole('tab', { name: /^Suggested/ }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('End'); assert.equal(await page.getByRole('tab', { name: /^Approvals/ }).getAttribute('aria-selected'), 'true');
  for (let i = 0; i < 40; i += 1) { await page.keyboard.press('Tab'); assert.ok(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), 'focus left the dialog'); }
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Open HON');
  // Context: the verified dashboard is still loaded after closing HON.
  assert.ok(await page.getByText('Verified current school', { exact: true }).isVisible());
  await ctx.close();
});

await check('persistent launcher on another staff page and full workspace round trip', async () => {
  theme = 'modern'; mode = 'ready';
  const ctx = await context({ width: 1440, height: 900 }); const page = await ctx.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(`${origin}/staff/crm/follow-ups`);
  await page.getByRole('button', { name: 'Ask HON' }).click();
  const dialog = page.getByRole('dialog'); await dialog.waitFor();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"] [data-state="LOADING"]'));
  await shot(page, 'launcher-staff-page-panel');
  const expand = dialog.getByRole('link', { name: 'Full workspace' });
  assert.equal(await expand.getAttribute('href'), '/staff/hon?return=%2Fstaff%2Fcrm%2Ffollow-ups');
  await expand.click();
  await page.waitForURL(/\/staff\/hon/);
  await page.waitForFunction(() => !document.querySelector('[data-state="LOADING"]'));
  await page.getByRole('heading', { name: 'HON', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Ask HON' }).count(), 0);
  await noOverflow(page);
  await shot(page, 'full-workspace-desktop');
  await axe(page, 'full-workspace');
  await page.getByRole('link', { name: 'Back to dashboard' }).click();
  await page.waitForURL(/\/staff\/crm\/follow-ups$/);
  await ctx.close();
});

await check('full workspace phone and preselected agent from URL is presentation only', async () => {
  theme = 'big-button'; mode = 'ready';
  const ctx = await context({ width: 390, height: 844 }); const page = await ctx.newPage();
  await page.goto(`${origin}/staff/hon?return=%2Fstaff%2Fdashboard&agent=marcus`);
  await page.getByRole('heading', { name: 'Marcus' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-state="LOADING"]'));
  await noOverflow(page);
  await shot(page, 'full-workspace-phone-marcus', true);
  await page.goto(`${origin}/staff/hon?return=https%3A%2F%2Fevil.example&agent=root`);
  await page.getByRole('heading', { name: 'HON', exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Back to dashboard' }).getAttribute('href'), '/staff/dashboard');
  await ctx.close();
});

for (const state of ['empty', 'denied', 'error', 'slow', 'multi']) {
  await check(`state: ${state}`, async () => {
    theme = 'modern'; mode = state;
    const ctx = await context({ width: 1440, height: 900 }); const page = await ctx.newPage();
    if (state === 'multi') {
      await page.goto(`${origin}/staff/crm/leads`);
      await page.getByRole('button', { name: 'Ask HON' }).click();
      await page.getByText('Choose a school first').waitFor();
      const dialog = page.getByRole('dialog');
      assert.equal(await dialog.getByRole('tablist').count(), 0, 'no workspace sections before a verified management scope');
      for (const name of ['Alex', 'Chad', 'Kai']) assert.equal(await dialog.getByText(name, { exact: true }).count(), 0, `${name} hidden before verification`);
    } else {
      await page.goto(`${origin}/staff/dashboard`);
      await page.getByRole('button', { name: 'Open HON' }).click();
      await page.getByRole('dialog').waitFor();
      const tab = state === 'empty' ? 'Approvals' : 'AI work';
      await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
      if (state !== 'slow') await page.waitForFunction(() => !document.querySelector('[role="dialog"] [data-state="LOADING"]'));
      else await page.locator('[role="dialog"] [data-state="LOADING"]').first().waitFor();
    }
    if (state === 'denied') await page.getByText(/not available for your access/).first().waitFor();
    if (state === 'error') await page.getByText(/unavailable/).first().waitFor();
    if (state === 'empty') await page.getByText('No proposals are awaiting review for this school.').waitFor();
    await shot(page, `state-${state}`);
    mode = 'ready';
    await ctx.close();
  });
}

await check('Kai style follows the Platform View switch; seven portraits unchanged; K fallback', async () => {
  const { ctx, page } = await dashboard({ width: 1440, height: 900 }, 'modern');
  let dialog = await openPanel(page);
  await dialog.locator(`img[src="${KAI_STYLE.modern}"]`).waitFor({ state: 'attached' });
  const seven = await dialog.locator('ul[aria-label="HON AI management team"] img').evaluateAll((images) => images.map((img) => img.getAttribute('src')));
  assert.deepEqual(seven, SEVEN_PORTRAITS, 'seven management portraits unchanged');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  for (const next of ['classic', 'big-button']) {
    await page.getByRole('button', { name: new RegExp(`^Select ${next === 'classic' ? 'Classic' : 'Big-Button'}`) }).first().click();
    await page.waitForFunction((value) => document.querySelector('main')?.getAttribute('data-interface-theme') === value, next);
    dialog = await openPanel(page);
    await page.waitForFunction((src) => { const img = document.querySelector(`[role="dialog"] img[src="${src}"]`); return img && img.complete && img.naturalWidth > 0; }, KAI_STYLE[next]);
    assert.equal(await dialog.locator('img[src^="/ai/kai"]').count(), 1);
    assert.deepEqual(await dialog.locator('ul[aria-label="HON AI management team"] img').evaluateAll((images) => images.map((img) => img.getAttribute('src'))), SEVEN_PORTRAITS);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  }
  await ctx.close();
  // Missing image: the card keeps Kai's identity with the K initial.
  const failing = await dashboard({ width: 834, height: 1112 }, 'big-button');
  await failing.ctx.route('**/ai/kai-chibi.webp', (route) => route.fulfill({ status: 404, body: '' }));
  const failingDialog = await openPanel(failing.page);
  const kai = failingDialog.getByRole('region', { name: /Kai/ });
  await kai.scrollIntoViewIfNeeded();
  await kai.locator('span[aria-hidden="true"] > span', { hasText: 'K' }).waitFor();
  assert.equal(await kai.locator('img').count(), 0, 'failed Kai image replaced by the initial');
  assert.ok(await kai.getByText('Teaching & Curriculum AI').isVisible());
  await shot(failing.page, 'big-button-tablet-834-kai-fallback');
  await failing.ctx.close();
});

await check('no unsupported capability presented as operational', async () => {
  const { ctx, page } = await dashboard({ width: 1440, height: 900 }, 'modern');
  const dialog = await openPanel(page);
  const textarea = dialog.getByRole('textbox', { name: /Message HON/ });
  assert.equal(await textarea.isDisabled(), true);
  assert.equal(await dialog.getByRole('button', { name: 'Send' }).isDisabled(), true);
  const text = await dialog.innerText();
  for (const forbidden of ['Working now', 'Thinking', 'Online', 'Completed today', 'Alex is ready']) assert.ok(!text.includes(forbidden), forbidden);
  assert.equal(await dialog.getByText('Planned · not yet available').count(), 6, 'five planned management employees plus the separate provisional Teaching AI');
  assert.equal(await dialog.getByText('Drafts · approval required').count(), 2);
  await ctx.close();
});

// ---------- Ask HON conversation ----------
function resetHon(reply) { hon.reply = reply; hon.conversations = []; hon.turns = new Map(); hon.queue = []; hon.posts = []; hon.held = null; hon.readinessReads = 0; }
async function fullHon(viewport, nextTheme = 'modern') {
  theme = nextTheme; mode = 'ready';
  const ctx = await context(viewport); const page = await ctx.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(`${origin}/staff/hon`);
  const ask = page.locator('section[data-hon-conversation]');
  await page.waitForFunction(() => document.querySelector('section[data-hon-conversation]')?.getAttribute('data-hon-conversation') === 'READY');
  return { ctx, page, ask };
}
const askBox = (ask) => ask.getByRole('textbox', { name: 'Message HON' });
const pageRefresh = (ask) => ask.locator(':scope > div').first().getByRole('button', { name: 'Refresh', exact: true });

await check('Ask HON: honest closed state while the AI provider is not activated', async () => {
  resetHon(false);
  const { ctx, page, ask } = await fullHon({ width: 1440, height: 900 });
  assert.equal(await askBox(ask).isDisabled(), true);
  assert.ok(await ask.getByText(/the AI provider is not activated yet/).isVisible());
  assert.ok(await ask.getByText('Not available', { exact: true }).isVisible());
  assert.equal(hon.posts.length, 0);
  await shot(page, 'ask-hon-not-activated');
  await ctx.close();
});

for (const [name, viewport, mode_] of [['desktop-1440', { width: 1440, height: 900 }, 'modern'], ['desktop-1440', { width: 1440, height: 900 }, 'classic'], ['phone-390', { width: 390, height: 844 }, 'big-button']]) {
  await check(`Ask HON ${mode_} ${name}: ask, reply, incomplete answer, continue`, async () => {
    resetHon(true);
    const { ctx, page, ask } = await fullHon(viewport, mode_);
    await askBox(ask).fill('Who should I follow up with today?');
    await ask.getByRole('button', { name: 'Send' }).click();
    await ask.getByText(/You have 3 new leads in the last 24 hours/).waitFor();
    assert.equal(hon.posts.length, 2, 'create then the first turn');
    assert.deepEqual(JSON.parse(hon.posts[1].body), { text: 'Who should I follow up with today?', delegation: null, replyMode: 'STANDARD' });
    assert.notEqual(hon.posts[0].key, hon.posts[1].key);
    await ask.getByText('Detailed', { exact: true }).click();
    await askBox(ask).fill('Give me a long plan for this week');
    await ask.getByRole('button', { name: 'Send' }).click();
    await ask.getByText(/This answer is incomplete/).waitFor();
    assert.equal(JSON.parse(hon.posts[2].body).replyMode, 'DETAILED');
    await noOverflow(page, `ask-hon-${mode_}-${name}`);
    await axe(page, `ask-hon-${mode_}-${name}`);
    await shot(page, `ask-hon-${mode_}-${name}-incomplete`);
    await ask.getByRole('button', { name: 'Continue this answer' }).click();
    await ask.getByText(/Second part: book the two trial follow-ups/).waitFor();
    const cont = JSON.parse(hon.posts[3].body);
    assert.equal(cont.continueTurnId, JSON.parse(JSON.stringify(hon.conversations[0].turns[2].turnId)));
    assert.equal('replyMode' in cont, false, 'a continuation keeps the mode of the answer it continues');
    await shot(page, `ask-hon-${mode_}-${name}-continued`, true);
    await ctx.close();
  });
}

await check('Ask HON from the school shell corner on another staff page', async () => {
  resetHon(true);
  theme = 'modern'; mode = 'ready';
  const ctx = await context({ width: 1440, height: 900 }); const page = await ctx.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(`${origin}/staff/crm/follow-ups`);
  await page.getByRole('link', { name: 'Ask HON' }).click();
  await page.waitForURL(/\/staff\/hon/);
  await page.waitForFunction(() => document.querySelector('section[data-hon-conversation]')?.getAttribute('data-hon-conversation') === 'READY');
  const ask = page.locator('section[data-hon-conversation]');
  await askBox(ask).fill('What needs my attention?');
  await ask.getByRole('button', { name: 'Send' }).click();
  await ask.getByText(/You have 3 new leads/).waitFor();
  await shot(page, 'ask-hon-from-shell-corner');
  await ctx.close();
});

await check('Ask HON: lost outcome keeps one exact request until it settles', async () => {
  resetHon(true);
  const { ctx, page, ask } = await fullHon({ width: 1440, height: 900 });
  hon.queue = ['lost', 'timeout'];
  await askBox(ask).fill('How many trials this week?');
  await ask.getByRole('button', { name: 'Send' }).click();
  await ask.getByRole('button', { name: 'Retry the same request' }).waitFor();
  assert.ok(await ask.getByText(/cannot create a second reply/).isVisible());
  assert.equal(await askBox(ask).isDisabled(), false);
  await ask.getByRole('button', { name: 'Retry the same request' }).click();
  await ask.getByRole('button', { name: 'Retry the same request' }).waitFor();
  await ask.getByRole('button', { name: 'Retry the same request' }).click();
  await ask.getByText(/You have 3 new leads/).waitFor();
  const creates = hon.posts.filter((p) => p.path.endsWith('/conversations'));
  assert.equal(creates.length, 3); assert.equal(new Set(creates.map((p) => p.key)).size, 1); assert.equal(new Set(creates.map((p) => p.body)).size, 1);
  assert.equal(hon.conversations.length, 1, 'exactly one conversation exists');
  await shot(page, 'ask-hon-recovered');
  await ctx.close();
});

await check('Ask HON: HQ pause is a definitive refusal; the question is kept, no retry', async () => {
  resetHon(true);
  const { ctx, page, ask } = await fullHon({ width: 1440, height: 900 });
  hon.queue = ['paused'];
  await askBox(ask).fill('Draft a reply for the Lee family');
  await ask.getByRole('button', { name: 'Send' }).click();
  await ask.getByText(/paused by HON HQ/).waitFor();
  assert.equal(await ask.getByRole('button', { name: 'Retry the same request' }).count(), 0);
  assert.equal(await askBox(ask).inputValue(), 'Draft a reply for the Lee family');
  await shot(page, 'ask-hon-paused');
  await ctx.close();
});

await check('Ask HON: leaving the page mid-reply conceals it; the late result stays hidden until Refresh', async () => {
  resetHon(true);
  const { ctx, page, ask } = await fullHon({ width: 1440, height: 900 });
  await askBox(ask).fill('First question');
  await ask.getByRole('button', { name: 'Send' }).click();
  await ask.getByText(/You have 3 new leads/).waitFor();
  hon.queue = ['hold'];
  await askBox(ask).fill('Private follow-up about Sam');
  await ask.getByRole('button', { name: 'Send' }).click();
  await ask.getByText('HON is working on it…').waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForFunction(() => document.querySelector('section[data-hon-conversation]')?.getAttribute('data-hon-conversation') === 'CONCEALED');
  const reads = hon.readinessReads;
  hon.held(); hon.held = null;
  await page.waitForTimeout(800);
  const hiddenText = await ask.innerText();
  for (const secret of ['Sam', 'You have 3 new leads', 'First question']) assert.ok(!hiddenText.includes(secret), `concealed view shows ${secret}`);
  assert.equal(hon.readinessReads, reads, 'no re-read while concealed');
  await shot(page, 'ask-hon-concealed');
  await pageRefresh(ask).click();
  await ask.getByText('Private follow-up about Sam').waitFor();
  await ctx.close();
});

await check('Overflow gate: clipped shell tabs pass; an escaping scroller or a wide document fails', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const page = await ctx.newPage();
  const layout = (body) => page.setContent(`<!doctype html><html><body style="margin:0">${body}</body></html>`);
  const tabs = '<nav data-shell-tabs style="display:flex;overflow-x:auto;width:390px">' + Array.from({ length: 6 }, (_, n) => `<a style="flex:none;width:120px">Tab ${n}</a>`).join('') + '</nav>';
  await layout(tabs);
  await noOverflow(page, 'gate-clipped-tabs');
  await layout('<div style="width:300px;overflow-x:auto"><div style="position:absolute;left:500px;width:200px;overflow-x:auto">escape</div></div>');
  await assert.rejects(noOverflow(page, 'gate-escaping-scroller'), /horizontal overflow/);
  await layout('<div style="width:300px;overflow-x:auto"><div style="width:900px">wide but clipped by a non-shell scroller</div></div>');
  await assert.rejects(noOverflow(page, 'gate-unlisted-scroller'), /horizontal overflow/);
  await layout('<nav data-shell-tabs style="display:flex;overflow-x:auto;width:390px"><a style="position:absolute;left:600px;width:100px">escaped tab</a></nav>');
  await assert.rejects(noOverflow(page, 'gate-escaped-tab'), /horizontal overflow/);
  await ctx.close();
});
async function creativeStudio(viewport, nextTheme = 'modern') {
  theme = nextTheme; mode = 'ready';
  const ctx = await context(viewport); const page = await ctx.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(`${origin}/staff/creative-studio`);
  await page.getByRole('heading', { name: 'Creative Studio', level: 1 }).waitFor();
  return { ctx, page };
}
for (const [name, viewport, mode_] of [['desktop-1440', { width: 1440, height: 900 }, 'modern'], ['desktop-1440', { width: 1440, height: 900 }, 'classic'], ['phone-390', { width: 390, height: 844 }, 'modern']]) {
  await check(`Creative Studio ${mode_} ${name}: real wallet, creation not connected`, async () => {
    studio = 'ready';
    const { ctx, page } = await creativeStudio(viewport, mode_);
    const section = page.locator('section[aria-labelledby="creative-studio-title"]');
    await section.getByTestId('creative-available').waitFor();
    assert.equal(await section.getByTestId('creative-available').innerText(), '11,640');
    assert.ok(await section.getByText('Not connected yet', { exact: true }).isVisible());
    assert.ok(await section.getByText('Standard image').isVisible());
    assert.ok(await section.getByText('Buying top-ups is not connected yet. No card is charged.').isVisible());
    assert.equal(await section.locator('textarea, input, select, form').count(), 0, 'no inert creation controls');
    await noOverflow(page, `creative-studio-${mode_}-${name}`);
    await axe(page, `creative-studio-${mode_}-${name}`);
    await shot(page, `creative-studio-${mode_}-${name}`, true);
    await ctx.close();
  });
}
await check('Creative Studio: a refused wallet read shows no numbers', async () => {
  studio = 'denied';
  const { ctx, page } = await creativeStudio({ width: 1440, height: 900 });
  const section = page.locator('section[aria-labelledby="creative-studio-title"]');
  await section.getByText(/does not include creative credits/).waitFor();
  assert.equal(await section.getByTestId('creative-available').count(), 0);
  assert.ok(await section.getByText('Not connected yet', { exact: true }).isVisible());
  await shot(page, 'creative-studio-denied');
  studio = 'ready';
  await ctx.close();
});
await check('Creative Studio: leaving the tab hides the wallet', async () => {
  studio = 'ready';
  const { ctx, page } = await creativeStudio({ width: 1440, height: 900 });
  const section = page.locator('section[aria-labelledby="creative-studio-title"]');
  await section.getByTestId('creative-available').waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForFunction(() => !document.querySelector('[data-testid="creative-available"]') || !!document.querySelector('[data-testid="creative-available"]')?.closest('[hidden],[inert]'));
  await ctx.close();
});

await browser.close();
server.kill('SIGTERM');
const writeReport = { ...report, apiRequests: [...new Set(report.apiRequests)].sort() };
await writeFile(join(results, 'hon-command-browser-report.json'), `${JSON.stringify(writeReport, null, 2)}\n`);
if (report.failures.length || report.pageErrors.length) {
  console.error(JSON.stringify({ failures: report.failures, pageErrors: report.pageErrors }, null, 2));
  if (report.failures.length) console.error(serverLog.slice(-4000));
  process.exitCode = 1;
}
console.log(`checks passed: ${report.checks.length}, failures: ${report.failures.length}, screenshots: ${report.screenshots.length}`);
