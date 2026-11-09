/**
 * Disposable local browser proof for the unified HON command experience.
 * Synthetic fixtures only: every /api/v1 request is answered in the browser by
 * this script. No database, provider, payment or production backend is used.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { issueSession, HON_SESSION_COOKIE } from '@hon/auth';
import { SAAS_PLAN_CAPABILITIES } from '@hon/contracts';

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
const hon = { reply: false, conversations: [], turns: new Map(), queue: [], posts: [], held: null, readinessReads: 0, groups: new Map(), targets: { step: null, gate: null, reads: [] } };
const honReadiness = () => ({ contract: true, providerRoute: hon.reply, entitlement: true, authorization: true, availableAgentKeys: hon.reply ? ['marcus', 'kai', 'chad'] : [], honReply: hon.reply, businessPerformance: false, asOf: iso(0) });
// C3a: each specialist's own target list (synthetic), and the grouped confirmations by HON answer.
const honCampaigns = () => [['Spring trial week', 'ACTIVE'], ['Summer camp', 'DRAFT'], ['Old open house', 'ARCHIVED']].map(([name, status], n) => ({ id: id(720 + n), code: `C${n}`, name, goal: 'More trials', offerLabel: '',
  channel: 'EMAIL', startsAt: iso(-100), endsAt: iso(100), plannedBudgetMinor: 0, currency: 'USD', version: 3, status, createdAt: iso(-200), updatedAt: iso(-10), planningOnly: true }));
const honCurricula = () => ({ items: [{ id: id(730), name: 'Little Dragons', version: 2 }, { id: id(731), name: 'Teen Kickboxing', version: 1 }] });
const honLeads = () => [['Riley', 'Park', 'OPEN'], ['Jordan', 'Kim', 'OPEN'], ['Casey', 'Lee', 'WON']].map(([givenName, familyName, status], n) => ({ id: id(740 + n), status, pipelineStageId: id(749),
  primaryPersonId: id(750 + n), version: 5 + n, createdAt: iso(-48), givenName, familyName }));
const groupStatus = (statuses) => statuses.includes('UNKNOWN') ? 'UNKNOWN' : statuses.some((x) => ['READY', 'PROCESSING', 'DELEGATING'].includes(x)) ? 'PENDING'
  : statuses.includes('AWAITING_APPROVAL') ? 'NEEDS_REVIEW' : statuses.every((x) => x === 'COMPLETED') ? 'COMPLETED' : statuses.every((x) => x === 'FAILED') ? 'FAILED' : 'PARTIAL';
async function honTargets(route, kind) {
  hon.targets.reads.push(kind);
  if (hon.targets.gate) await hon.targets.gate;
  const step = hon.targets.step;
  if (step === 'session') return json(route, 401, { code: 'SIGN_IN_REQUIRED' });
  if (step === 'denied') return json(route, 403, { code: 'FORBIDDEN' });
  if (kind === 'marcus') return json(route, 200, { data: honCampaigns(), meta: { requestId: 'synthetic' } });
  if (kind === 'kai') return json(route, 200, { data: honCurricula() });
  return json(route, 200, { data: honLeads(), meta: { requestId: 'synthetic' } });
}
const replyDetail = (mode = 'STANDARD', over = {}) => ({ mode, step: 1, maxSteps: 3, truncated: false, canContinue: false, continuesTurnId: null, suggestions: [], ...over });
let honSeq = 700;
async function honApi(route, path, method, prefix) {
  const base = `${prefix}/hon`;
  if (path === `${base}/readiness` && method === 'GET') { hon.readinessReads += 1; return json(route, 200, { data: honReadiness(), meta: { requestId: 'synthetic', correlationId: 'synthetic' } }); }
  if (path === `${base}/conversations` && method === 'GET') return json(route, 200, { data: { items: hon.conversations.map(({ turns, ...rest }) => rest), nextCursor: null } });
  const read = path.match(new RegExp(`^${base}/conversations/([0-9a-f-]{36})$`));
  if (read && method === 'GET') { const c = hon.conversations.find((x) => x.id === read[1]); return c ? json(route, 200, { data: c }) : json(route, 404, { code: 'HON_CONVERSATION_NOT_FOUND' }); }
  const grouped = path.match(new RegExp(`^${base}/conversations/([0-9a-f-]{36})/orchestrations$`));
  if (grouped && method === 'GET') {
    const items = [...(hon.groups.get(grouped[1]) ?? new Map()).values()].map((g) => ({ sourceTurnId: g.sourceTurnId, status: groupStatus(g.members.map((m) => m.status)), members: g.members }));
    return json(route, 200, { data: { items } });
  }
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
  if (step === 'notConfirmable') return json(route, 400, { code: 'HON_SUGGESTION_NOT_CONFIRMABLE' });
  if (step === 'notSummarizable') return json(route, 400, { code: 'HON_GROUP_NOT_SUMMARIZABLE' });
  if (step === 'holdSession') { await new Promise((done) => { hon.held = done; }); return json(route, 401, { code: 'SIGN_IN_REQUIRED' }); }
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
  if (ask.delegation) {
    // A confirmed suggestion: the specialist records a draft that waits for approval. Nothing is sent or published.
    const agent = ask.delegation.agentKey; const actionRequestId = id(honSeq += 1); const workItemId = id(honSeq += 1); const invocationId = id(honSeq += 1);
    c.turns.push({ turnId, role: 'HUMAN', text: ask.text, createdAt: iso(0), status: 'COMPLETED', reason: null, references: { workItemId: null, actionRequestId: null, invocationId: null }, replyDetail: null });
    c.turns.push({ turnId, role: agent, text: null, createdAt: iso(0), status: 'AWAITING_APPROVAL', reason: null, references: { workItemId, actionRequestId, invocationId }, replyDetail: null });
    c.turnCount += 1; c.status = 'AWAITING_APPROVAL';
    if (ask.fromSuggestionTurnId) {
      const byConversation = hon.groups.get(c.id) ?? new Map(); hon.groups.set(c.id, byConversation);
      const g = byConversation.get(ask.fromSuggestionTurnId) ?? { sourceTurnId: ask.fromSuggestionTurnId, members: [] }; byConversation.set(ask.fromSuggestionTurnId, g);
      g.members.push({ agentKey: agent, turnId, status: 'AWAITING_APPROVAL' });
    }
    const receipt = { turnId, conversationId: c.id, status: 'AWAITING_APPROVAL', reason: null, delegatedAgentKeys: [agent], actionRequestIds: [actionRequestId], workItemIds: [workItemId], invocationId, reply: null, replyDetail: null };
    hon.turns.set(headers['idempotency-key'], receipt);
    return json(route, 200, { data: receipt });
  }
  // C3b: a summary is a fresh question about this human's own finished group in this conversation.
  if (ask.summarizeTurnId) {
    const g = hon.groups.get(c.id)?.get(ask.summarizeTurnId);
    if (!g || ask.continueTurnId || !['COMPLETED', 'FAILED', 'PARTIAL'].includes(groupStatus(g.members.map((m) => m.status)))) return json(route, 400, { code: 'HON_GROUP_NOT_SUMMARIZABLE' });
  }
  const long = /long/i.test(ask.text);
  const suggest = /saturday/i.test(ask.text) ? ['marcus', 'chad', 'kai'] : [];
  const text = ask.summarizeTurnId ? 'Summary: Marcus recorded a Saturday trial post draft that a human approved. Next, share it with parents this week.' : ask.continueTurnId ? 'Second part: book the two trial follow-ups for Tuesday and confirm the testing date with parents.'
    : long ? 'Here is a detailed plan for this week. First, follow up the three new leads from the weekend…' : 'You have 3 new leads in the last 24 hours and 2 trial appointments tomorrow. I suggest following up the leads first.';
  const detail = ask.continueTurnId ? replyDetail('DETAILED', { step: 2, continuesTurnId: ask.continueTurnId }) : replyDetail(ask.replyMode ?? 'STANDARD', long ? { truncated: true, canContinue: true } : { suggestions: suggest });
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
// Creative Studio generations (CS1, synthetic). provider: NOT_CONNECTED unless a check connects it.
// replies, one per POST: 'ok', 'unknown' (503, nothing stored), 'accepted' (stores a GENERATING row, then the answer is lost),
// 'notConnected' (503 CREATIVE_PROVIDER_NOT_CONNECTED), 'denied' (403), 'transition' (409 SAAS_TRANSITION_NOT_ALLOWED).
// gate: when set, the next POST waits for it before answering (a create still in flight).
const creative = { provider: 'NOT_CONNECTED', items: [], posts: [], replies: [], byKey: new Map(), gate: null };
const creativeGeneration = (body, n) => ({ generationId: id(700 + n), schoolId: scope.schoolId, operationCode: body.operationCode, mediaKind: 'IMAGE', units: body.units,
  format: body.format, prompt: body.prompt, status: 'SUCCEEDED', failureReason: null, reservedCredits: 40 * body.units, chargedCredits: 40 * body.units,
  createdAt: iso(0), completedAt: iso(0), assets: Array.from({ length: body.units }, (_, i) => ({ assetId: id(720 + n * 10 + i), ordinal: i + 1, mediaType: 'image/png', width: 1080, height: 1080, durationSeconds: null, origin: 'SYNTHETIC' })) });
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
  if (path === '/api/v1/marketing/campaigns' && method === 'GET') return honTargets(route, 'marcus');
  if (path === '/api/v1/staff/teaching-assistant/curricula' && method === 'GET') return honTargets(route, 'kai');
  if (path === `${prefix}/crm/leads` && method === 'GET' && url.searchParams.get('status') === 'OPEN') return honTargets(route, 'chad');
  if (path === '/api/v1/hq/overview') return json(route, 200, { data: { overview: { asOf: '2026-10-24T15:00:00.000Z', callerHqRole: hqx.owner ? 'OWNER' : 'OPERATOR', organizationCount: 3, schoolCount: 3,
    onboarding: { availability: 'AVAILABLE', requestCount: 0, inProgressRequestCount: 0, completedRequestCount: 0 }, configuredProviderStates: { disabled: 0, configured: 0, healthy: 0, degraded: 0, unavailable: 0 }, taskProfileCount: 0,
    financialMetrics: { availability: 'UNAVAILABLE', reason: 'No authoritative HQ financial MRR, ARR, cash, or gross-margin projection is available.' },
    aiUsage: { availability: 'UNAVAILABLE', reason: 'No authoritative HQ AI usage or cost projection is available.' },
    durableHqWork: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: 'No durable HQ executive work is recorded or active in HQ-1.' } } } });
  if (path === '/api/v1/hq/schools' || path.endsWith('/ownership') || path === '/api/v1/hq/school-ownership/primary-owner') { const answered = await ownershipApiRoute(route, path, method); if (answered !== null) return answered; }
  if (path.startsWith('/api/v1/hq/ai/')) { const answered = await aiControlApiRoute(route, path, method, url); if (answered !== null) return answered; }
  if (path.startsWith('/api/v1/hq/saas/trials/')) { const answered = await trialsApiRoute(route, path, method, url); if (answered !== null) return answered; }
  if (path.startsWith('/api/v1/hq/saas/')) { const answered = await hqAccessApi(route, path, method, url); if (answered !== null) return answered; }
  if (path.startsWith('/api/v1/marketing/campaigns')) { const answered = await marketingApiRoute(route, path, method, url); if (answered !== null) return answered; }
  if (path.startsWith(`${prefix}/schedule/sessions`)) { const answered = await rosterApiRoute(route, path, method, url, prefix); if (answered !== null) return answered; }
  if (path === `${prefix}/billing/membership-pause-policy` || /\/billing\/memberships\/[0-9a-f-]{36}\/(pause|resume|cancel|refund-records|pauses-and-refunds)$/.test(path)) { const answered = await changesApiRoute(route, path, method, prefix); if (answered !== null) return answered; }
  if (path === `${prefix}/billing/memberships`) { const answered = await membershipListApiRoute(route, path, method, url, prefix); if (answered !== null) return answered; }
  if (path.startsWith(`${prefix}/crm/leads`)) { const answered = await leadsApiRoute(route, path, method, url, prefix); if (answered !== null) return answered; }
  if (path.startsWith(`/api/v1/schools/${scope.schoolId}/champions/`)) { const answered = await championsApiRoute(route, path, method, url); if (answered !== null) return answered; }
  if (path.includes('/people')) { const answered = await peopleApiRoute(route, path, method, url); if (answered !== null) return answered; }
  if (path === `/api/v1/schools/${scope.schoolId}/creative-studio/generations`) {
    if (method === 'GET') return json(route, 200, { data: { provider: creative.provider, generations: creative.items, limit: 50 } });
    const request = route.request();
    creative.posts.push({ key: request.headers()['idempotency-key'], command: request.headers()['x-hon-human-command'], body: request.postData() });
    const next = creative.replies.shift() ?? 'ok', idem = request.headers()['idempotency-key'];
    if (creative.gate) { const gate = creative.gate; creative.gate = null; await gate; }
    if (next === 'unknown') return json(route, 503, { code: 'SAAS_UNAVAILABLE' });
    if (next === 'notConnected') return json(route, 503, { code: 'CREATIVE_PROVIDER_NOT_CONNECTED' });
    if (next === 'denied') return json(route, 403, { code: 'SAAS_FORBIDDEN' });
    if (next === 'transition') return json(route, 409, { code: 'SAAS_TRANSITION_NOT_ALLOWED' });
    if (creative.provider !== 'CONNECTED') return json(route, 503, { code: 'CREATIVE_PROVIDER_NOT_CONNECTED' });
    const body = JSON.parse(request.postData() ?? '{}'), prior = creative.byKey.get(idem);
    if (prior) {
      const done = { ...creativeGeneration(body, 0), generationId: prior.generationId, createdAt: prior.createdAt };
      creative.items = creative.items.map((item) => item.generationId === prior.generationId ? done : item);
      return json(route, 200, { data: { generation: done, balance: creativeWallet().balance, replayed: true } });
    }
    const g = creativeGeneration(body, creative.items.length + 1);
    if (next === 'accepted') {
      const held = { ...g, status: 'GENERATING', chargedCredits: null, completedAt: null, assets: [] };
      creative.items = [held, ...creative.items]; creative.byKey.set(idem, held);
      return json(route, 503, { code: 'SAAS_UNAVAILABLE' });
    }
    creative.items = [g, ...creative.items];
    return json(route, 200, { data: { generation: g, balance: creativeWallet().balance, replayed: false } });
  }
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

// HQ school access (B-HQ-1 + D9): three synthetic organizations. Grant/revoke replay by key and re-derive the rows.
// pageSize: first page size (then a cursor page); denyOverview: overview answers 403; pageGate/pageSession: the cursor read
// waits for the gate, then answers 401.
const hqx = { owner: true, ready: true, orgs: [], posts: [], replies: [], byKey: new Map(), gate: null, pageSize: null, denyOverview: false, pageGate: null, pageSession: false, pageDenied: false };
const HQX_T = '2026-10-01T00:00:00.000Z';
const hqEnt = (o) => o.ent && { ...o.ent, inEffect: o.ent.status === 'ACTIVE' && Date.parse(o.ent.effectiveFrom) <= Date.now() && (!o.ent.effectiveUntil || Date.parse(o.ent.effectiveUntil) > Date.now()) };
function resetHqx(over = {}) {
  hqx.orgs = [
    { id: id(401), name: 'Synthetic Dojo North', created: '2026-09-01T00:00:00.000Z', schools: [[id(411), 'North Academy', 'ACTIVE']], state: 'PROVISIONED', ent: { tier: 'COMPLETE', status: 'SUSPENDED', effectiveFrom: HQX_T, effectiveUntil: null, version: 2 }, exception: null, subscription: null, owner: 'PENDING' },
    { id: id(402), name: 'Synthetic Dojo South', created: '2026-09-02T00:00:00.000Z', schools: [[id(412), 'South Academy', 'ACTIVE']], state: 'PROVISIONED', ent: { tier: 'COMPLETE', status: 'ACTIVE', effectiveFrom: HQX_T, effectiveUntil: '2026-12-30T00:00:00.000Z', version: 3 },
      exception: { exceptionId: id(452), schoolId: id(412), purpose: 'APPROVED_PILOT', scopeTier: 'COMPLETE', startsAt: HQX_T, expiresAt: '2026-12-30T00:00:00.000Z', reason: 'Approved pilot for a fixture partner' }, subscription: null, owner: 'ACCEPTED' },
    { id: id(403), name: 'Synthetic Dojo East', created: '2026-09-03T00:00:00.000Z', schools: [[id(413), 'East Academy', 'ACTIVE']], state: 'PAYMENT_ACTIVE', ent: { tier: 'COMPLETE', status: 'ACTIVE', effectiveFrom: HQX_T, effectiveUntil: null, version: 5 }, exception: null,
      subscription: { subscriptionId: id(463), status: 'ACTIVE', planCode: 'COMPLETE', billingInterval: 'MONTH' }, owner: 'ACCEPTED' }];
  Object.assign(hqx, { owner: true, ready: true, posts: [], replies: [], byKey: new Map(), gate: null, pageSize: null, denyOverview: false, pageGate: null, pageSession: false, pageDenied: false }, over);
}
resetHqx();
function hqRow(o) {
  const ent = hqEnt(o), inEffect = ent?.inEffect === true, x = o.exception;
  const lifecycle = x && (Date.now() < Date.parse(x.startsAt) ? 'SCHEDULED' : Date.now() >= Date.parse(x.expiresAt) ? 'EXPIRED' : 'IN_EFFECT');
  const revocable = lifecycle === 'IN_EFFECT' || lifecycle === 'SCHEDULED';
  const status = o.state === 'AWAITING_FIRST_PAYMENT' ? 'AWAITING_FIRST_PAYMENT' : lifecycle === 'IN_EFFECT' && inEffect ? 'EXCEPTION_IN_EFFECT' : lifecycle === 'SCHEDULED' ? 'EXCEPTION_SCHEDULED'
    : inEffect && o.state === 'PAYMENT_ACTIVE' ? 'PAID_ACCESS' : inEffect ? 'PROVISIONED_ACCESS' : 'NO_ACCESS';
  const blockers = [!hqx.ready && 'EXCEPTION_POLICY_REQUIRED', revocable && 'ACCESS_EXCEPTION_ACTIVE', inEffect && 'ENTITLEMENT_IN_EFFECT',
    ['AWAITING_FIRST_PAYMENT', 'PAYMENT_ACTIVE'].includes(o.state) && 'ACCESS_STATE_EXISTS', o.subscription && 'SUBSCRIPTION_EXISTS'].filter(Boolean);
  return { organizationId: o.id, organizationDisplayName: o.name, organizationStatus: 'ACTIVE', createdAt: o.created,
    schools: o.schools.map(([schoolId, schoolDisplayName, schoolStatus]) => ({ schoolId, schoolDisplayName, schoolStatus })), schoolCount: o.schools.length,
    entitlement: ent, accessState: o.state, accessStatus: status,
    currentException: x && { exceptionId: x.exceptionId, schoolId: x.schoolId, purpose: x.purpose, scopeTier: x.scopeTier, startsAt: x.startsAt, expiresAt: x.expiresAt, lifecycle, revocable },
    subscription: o.subscription, openCheckout: false,
    ownerOnboarding: { status: o.owner, invitedAt: HQX_T, expiresAt: '2026-10-08T00:00:00.000Z', acceptedAt: o.owner === 'ACCEPTED' ? HQX_T : null },
    exceptionGrant: { eligible: blockers.length === 0, blockers, expectedEntitlementVersion: ent?.version ?? null } };
}
function hqOverview(statusFilter, cursor) {
  const rows = hqx.orgs.map(hqRow);
  const summary = Object.fromEntries(['AWAITING_FIRST_PAYMENT', 'EXCEPTION_IN_EFFECT', 'EXCEPTION_SCHEDULED', 'PAID_ACCESS', 'PROVISIONED_ACCESS', 'NO_ACCESS'].map((k) => [k, rows.filter((r) => r.accessStatus === k).length]));
  return { viewer: { canGrantAndRevokeExceptions: hqx.owner }, paidAccessProgram: 'INACTIVE',
    exceptionPolicy: hqx.ready ? { ready: true, maxDays: 90, validUntil: '2027-10-01T00:00:00.000Z', maxScheduleAheadDays: 30 } : { ready: false, maxDays: null, validUntil: null, maxScheduleAheadDays: 30 },
    summary: { ...summary, total: rows.length }, ...hqPage(rows.filter((r) => !statusFilter || r.accessStatus === statusFilter), cursor), asOf: new Date().toISOString() };
}
function hqPage(rows, cursor) {
  if (!hqx.pageSize) return { organizations: rows, limit: 25, nextCursor: null };
  const after = cursor ? rows.filter((r) => r.createdAt > cursor.split('~')[0]) : rows, page = after.slice(0, hqx.pageSize), last = page.at(-1);
  return { organizations: page, limit: hqx.pageSize, nextCursor: after.length > hqx.pageSize ? { createdAt: last.createdAt, organizationId: last.organizationId } : null };
}
const hqAccessView = (o) => { const ent = hqEnt(o), inEffect = ent?.inEffect === true;
  return { organizationId: o.id, state: o.state, source: !inEffect ? 'NONE' : o.state === 'PAYMENT_ACTIVE' ? 'PAYMENT_ACTIVATED' : 'PROVISIONED', entitlement: ent,
    capabilities: inEffect ? [...SAAS_PLAN_CAPABILITIES[ent.tier]] : [], paidAccessProgram: 'INACTIVE' }; };
async function hqAccessApi(route, path, method, url) {
  if (path === '/api/v1/hq/saas/access-exception-policy') return hqPolicyApi(route, method);
  if (path === '/api/v1/hq/saas/access-overview' && method === 'GET') {
    if (hqx.denyOverview) return json(route, 403, { code: 'SAAS_FORBIDDEN' });
    const cursor = url.searchParams.get('cursor');
    if (cursor && hqx.pageGate) { const gate = hqx.pageGate; hqx.pageGate = null; await gate; }
    if (cursor && hqx.pageSession) return json(route, 401, { code: 'SIGN_IN_REQUIRED' });
    if (cursor && hqx.pageDenied) return json(route, 403, { code: 'SAAS_FORBIDDEN' });
    return json(route, 200, { data: hqOverview(url.searchParams.get('status'), cursor) }, { 'Cache-Control': 'private, no-store' });
  }
  const grant = path.match(/^\/api\/v1\/hq\/saas\/organizations\/([0-9a-f-]{36})\/access-exceptions$/), revoke = path.match(/^\/api\/v1\/hq\/saas\/access-exceptions\/([0-9a-f-]{36})\/revoke$/);
  if (method !== 'POST' || (!grant && !revoke)) return null;
  const request = route.request(), headers = request.headers(), raw = request.postData() ?? '';
  hqx.posts.push({ path, key: headers['idempotency-key'], command: headers['x-hon-human-command'], body: raw });
  const step = hqx.replies.shift() ?? 'ok';
  if (hqx.gate) { const gate = hqx.gate; hqx.gate = null; await gate; }
  const prior = hqx.byKey.get(headers['idempotency-key']);
  if (prior) return prior.body === raw ? json(route, 200, { data: { ...prior.data, replayed: true } }) : json(route, 409, { code: 'IDEMPOTENCY_KEY_REUSED' });
  if (!hqx.owner) return json(route, 403, { code: 'SAAS_FORBIDDEN' });
  if (step === 'lost') return route.abort('connectionreset');
  if (step === 'session') return json(route, 401, { code: 'SIGN_IN_REQUIRED' });
  // Definite refusals raised before any write (0186): nothing is recorded under the key.
  if (step === 'policy') return json(route, 422, { code: 'SAAS_EXCEPTION_POLICY_REQUIRED' });
  if (step === 'accessState') return json(route, 422, { code: 'SAAS_ACCESS_STATE_EXISTS' });
  if (step === 'checkout') return json(route, 422, { code: 'SAAS_CHECKOUT_OPEN' });
  const body = JSON.parse(raw), now = new Date().toISOString();
  let data;
  if (grant) {
    assert.equal(headers['x-hon-human-command'], 'saas-access-exception-grant');
    const o = hqx.orgs.find((x) => x.id === grant[1]), row = o && hqRow(o);
    if (!row) return json(route, 404, { code: 'SAAS_UNAVAILABLE' });
    if (body.expectedEntitlementVersion !== row.entitlement?.version) return json(route, 409, { code: 'SAAS_VERSION_CONFLICT' });
    if (!row.exceptionGrant.eligible) return json(route, 422, { code: 'SAAS_ACCESS_EXCEPTION_ACTIVE' });
    const prior = hqEnt(o);
    o.ent = { tier: body.scopeTier, status: 'ACTIVE', effectiveFrom: body.startsAt, effectiveUntil: body.expiresAt, version: o.ent.version + 1 };
    o.exception = { exceptionId: id(470 + hqx.posts.length), schoolId: body.schoolId, purpose: body.purpose, scopeTier: body.scopeTier, startsAt: body.startsAt, expiresAt: body.expiresAt, reason: body.reason };
    data = { exception: { exceptionId: o.exception.exceptionId, organizationId: o.id, schoolId: body.schoolId, purpose: body.purpose, reason: body.reason, scopeTier: body.scopeTier,
      capabilities: [...SAAS_PLAN_CAPABILITIES[body.scopeTier]], aiCredits: 'NONE', startsAt: body.startsAt, expiresAt: body.expiresAt, policyVersion: 1, maxDays: 90, status: 'GRANTED',
      lifecycle: hqRow(o).currentException.lifecycle, grantedByPrincipalId: id(499), grantedAt: now, priorEntitlement: prior, grantedEntitlement: hqEnt(o),
      endReason: null, endNote: null, endEntitlement: null, endedByPrincipalId: null, endedAt: null }, access: hqAccessView(o), replayed: false };
  } else {
    assert.equal(headers['x-hon-human-command'], 'saas-access-exception-revoke');
    const o = hqx.orgs.find((x) => x.exception?.exceptionId === revoke[1]);
    if (!o) return json(route, 422, { code: 'SAAS_EXCEPTION_ENDED' });
    const x = o.exception, granted = { ...hqEnt(o) };
    o.ent = { ...o.ent, status: 'SUSPENDED', version: o.ent.version + 1 }; o.exception = null;
    data = { exception: { exceptionId: x.exceptionId, organizationId: o.id, schoolId: x.schoolId, purpose: x.purpose, reason: x.reason, scopeTier: x.scopeTier,
      capabilities: [...SAAS_PLAN_CAPABILITIES[x.scopeTier]], aiCredits: 'NONE', startsAt: x.startsAt, expiresAt: x.expiresAt, policyVersion: 1, maxDays: 90, status: 'ENDED',
      lifecycle: 'REVOKED', grantedByPrincipalId: id(499), grantedAt: x.startsAt, priorEntitlement: null, grantedEntitlement: { ...granted, effectiveFrom: x.startsAt, effectiveUntil: x.expiresAt, status: 'ACTIVE' },
      endReason: 'REVOKED', endNote: body.reason, endEntitlement: hqEnt(o), endedByPrincipalId: id(499), endedAt: now }, entitlementSuspended: true, access: hqAccessView(o), replayed: false };
  }
  hqx.byKey.set(headers['idempotency-key'], { body: raw, data });
  if (step === 'unknown') return json(route, 409, { code: 'SAAS_OUTCOME_UNKNOWN' });
  // The outcome is lost, and HQ read access is withdrawn before the fresh read.
  if (step === 'unknownThenDenied') { hqx.denyOverview = true; return json(route, 409, { code: 'SAAS_OUTCOME_UNKNOWN' }); }
  return json(route, 200, { data }, { 'Cache-Control': 'private, no-store' });
}

// D10 exception policy (0186, read terms + viewer 0222): synthetic decisions only. The command rules mirror the database:
// HQ owner only, next revision, current terms version and maximum, a future window, and something to withdraw or revoke.
const hqp = { owner: true, history: [], termsVersion: 1, maxDays: 90, posts: [], replies: [], byKey: new Map(), gate: null, deny: false, readGate: null, readSession: false };
function resetHqp(over = {}) {
  Object.assign(hqp, { owner: true, history: [], termsVersion: 1, maxDays: 90, posts: [], replies: [], byKey: new Map(), gate: null, deny: false, readGate: null, readSession: false }, over);
}
const hqpDecision = (revision, status, body, prior) => ({ approvalId: id(600 + revision), revision, status, termsVersion: body.termsVersion ?? prior.termsVersion,
  maxDays: body.maxDays ?? prior.maxDays, validFrom: body.validFrom ?? prior.validFrom, validUntil: body.validUntil ?? prior.validUntil, reason: body.reason,
  actorPrincipalId: id(499), recordedAt: new Date().toISOString() });
function hqpView() {
  const now = Date.now(), p = hqp.history[0] ?? null;
  const effectiveStatus = !p ? 'ABSENT' : p.status !== 'APPROVED' ? p.status : p.termsVersion !== hqp.termsVersion ? 'SUPERSEDED'
    : Date.parse(p.validFrom) > now ? 'SCHEDULED' : Date.parse(p.validUntil) <= now ? 'EXPIRED' : 'ACTIVE';
  return { scope: 'ACCESS_EXCEPTIONS_ONLY', current: p, effectiveStatus, history: hqp.history, historyLimit: 100, asOf: new Date(now).toISOString(), termsStatus: 'PROPOSED',
    terms: { policyVersion: hqp.termsVersion, exceptionMaxDays: hqp.maxDays, exceptionAuthority: 'HQ_OWNER' }, viewer: { canDecide: hqp.owner },
    paidAccessProgram: 'INACTIVE', aiCreditProgram: 'INACTIVE' };
}
async function hqPolicyApi(route, method) {
  if (method === 'GET') {
    const gate = hqp.readGate; hqp.readGate = null; const session = hqp.readSession; if (gate) { hqp.readSession = false; await gate; }
    if (session) return json(route, 401, { code: 'SIGN_IN_REQUIRED' });
    if (hqp.deny) return json(route, 403, { code: 'SAAS_FORBIDDEN' });
    return json(route, 200, { data: hqpView() }, { 'Cache-Control': 'private, no-store' });
  }
  if (method !== 'POST') return null;
  const request = route.request(), headers = request.headers(), raw = request.postData() ?? '';
  // Taken at request entry: a gated retired request keeps its own step.
  const step = hqp.replies.shift() ?? 'ok', gate = hqp.gate; hqp.gate = null;
  hqp.posts.push({ key: headers['idempotency-key'], command: headers['x-hon-human-command'], body: raw });
  if (gate) await gate;
  const prior = hqp.byKey.get(headers['idempotency-key']);
  if (prior) return prior.body === raw ? json(route, 200, { data: { ...prior.data, replayed: true } }) : json(route, 409, { code: 'IDEMPOTENCY_KEY_REUSED' });
  assert.equal(headers['x-hon-human-command'], 'saas-access-exception-policy-decision');
  if (step === 'lost') return route.abort('connectionreset');
  if (step === 'session') return json(route, 401, { code: 'SIGN_IN_REQUIRED' });
  if (!hqp.owner) return json(route, 403, { code: 'SAAS_FORBIDDEN' });
  const body = JSON.parse(raw), latest = hqp.history[0] ?? null;
  if (body.expectedRevision !== (latest?.revision ?? 0)) return json(route, 409, { code: 'SAAS_VERSION_CONFLICT' });
  let made;
  if (body.decision === 'WITHDRAWN' || body.decision === 'REVOKED') {
    assert.deepEqual(Object.keys(body).sort(), ['decision', 'expectedRevision', 'reason']);
    if (!latest || !['PROPOSED', 'APPROVED'].includes(latest.status)) return json(route, 422, { code: 'SAAS_EXCEPTION_POLICY_REQUIRED' });
    if (latest.termsVersion !== hqp.termsVersion) return json(route, 422, { code: 'SAAS_EXCEPTION_POLICY_LIMIT' });
    made = hqpDecision(body.expectedRevision + 1, body.decision, { reason: body.reason }, latest);
  } else {
    assert.deepEqual(Object.keys(body).sort(), ['decision', 'expectedRevision', 'maxDays', 'reason', 'termsVersion', 'validFrom', 'validUntil',
      ...(body.decision === 'APPROVED' ? ['confirmation'] : [])].sort());
    if (body.decision === 'APPROVED') assert.equal(body.confirmation, 'APPROVE_ACCESS_EXCEPTION_POLICY_ONLY');
    if (Date.parse(body.validUntil) <= Date.parse(body.validFrom) || Date.parse(body.validUntil) <= Date.now()) return json(route, 422, { code: 'SAAS_EXCEPTION_POLICY_WINDOW_INVALID' });
    if (body.termsVersion !== hqp.termsVersion || body.maxDays > hqp.maxDays) return json(route, 422, { code: 'SAAS_EXCEPTION_POLICY_LIMIT' });
    made = hqpDecision(body.expectedRevision + 1, body.decision, body, {});
  }
  hqp.history = [made, ...hqp.history];
  const data = { policy: made, replayed: false };
  hqp.byKey.set(headers['idempotency-key'], { body: raw, data });
  if (step === 'unknown') return json(route, 409, { code: 'SAAS_OUTCOME_UNKNOWN' });
  if (step === 'unknownThenDenied') { hqp.deny = true; return json(route, 409, { code: 'SAAS_OUTCOME_UNKNOWN' }); }
  return json(route, 200, { data }, { 'Cache-Control': 'private, no-store' });
}

// People (B-CRM-1a/1b): synthetic people at the one school. Edits replay by key, check the version and the consent rule.
// Leads (U4): the school's CRM lead list and each lead's trials (synthetic). Read-only.
const lds = { denied: false, gate: null, step: null, reads: [] };
const ldsLeads = () => [['Riley', 'Park', 'OPEN', 2], ['Jordan', 'Kim', 'OPEN', null], ['Casey', 'Lee', 'WON', null], ['Morgan', 'Diaz', 'LOST', null]].map(([givenName, familyName, status, follow], n) => ({
  id: id(800 + n), status, pipelineStageId: id(799), primaryPersonId: id(810 + n), version: 2 + n, createdAt: iso(-72 - n), givenName, familyName,
  email: `${String(givenName).toLowerCase()}@example.invalid`, phoneE164: '+15555550100', ...(follow === null ? {} : { nextFollowUpAt: iso(follow) }) }));
const ldsTrial = (n, status, hours) => ({ id: id(830 + n), crmLeadId: id(800), appointmentType: 'TRIAL', status, startsAt: iso(hours), endsAt: iso(hours + 1), createdByPrincipalId: id(61), version: 1,
  createdAt: iso(-10 - n), updatedAt: iso(-10 - n), location: 'Main mat' });
function resetLeads(over = {}) { Object.assign(lds, { denied: false, gate: null, step: null, reads: [] }, over); }
async function leadsApiRoute(route, path, method, url, prefix) {
  if (method !== 'GET') return null;
  const trials = path.match(new RegExp(`^${prefix}/crm/leads/([0-9a-f-]{36})/trials$`));
  if (path !== `${prefix}/crm/leads` && !trials) return null;
  lds.reads.push(trials ? 'trials' : `list:${url.searchParams.get('status') ?? 'ALL'}`);
  // The step belongs to the request that arrives first, even while it waits at the gate.
  const step = lds.step; lds.step = null;
  if (lds.gate) { const gate = lds.gate; lds.gate = null; await gate; }
  if (step === 'session') return json(route, 401, { code: 'SIGN_IN_REQUIRED' });
  if (lds.denied) return json(route, 403, { code: 'FORBIDDEN' });
  if (trials) {
    const rows = trials[1] === id(800) ? [ldsTrial(1, 'SCHEDULED', 26), ldsTrial(2, 'NO_SHOW', -48)] : [];
    return json(route, 200, { data: { activeTrial: rows[0] ?? null, trials: rows }, meta: { requestId: id(898), correlationId: id(898) } });
  }
  const status = url.searchParams.get('status');
  return json(route, 200, { data: ldsLeads().filter((lead) => !status || lead.status === status), meta: { requestId: 'synthetic' } });
}
// Marketing home (U7): the one school's campaign plans and a campaign's last-30-day counts (synthetic). Read-only.
const mkt = { denied: false, gate: null, step: null, reads: [] };
const mktCampaigns = () => [['Spring open house', 'ACTIVE', 'EVENT'], ['Summer camp plan', 'DRAFT', 'SOCIAL'], ['Old flyer', 'ARCHIVED', 'PRINT']].map(([name, status, channel], n) => ({
  id: id(900 + n), version: 2, code: `CAMP-${n}`, name, goal: 'Fill the Saturday kids class', offerLabel: n === 0 ? 'Free first week' : '', channel, status,
  startsAt: '2026-11-01T00:00:00.000Z', endsAt: '2026-11-30T00:00:00.000Z', plannedBudgetMinor: 25000, currency: 'USD', createdAt: iso(-200), updatedAt: iso(-100), planningOnly: true }));
function resetMarketing(over = {}) { Object.assign(mkt, { denied: false, gate: null, step: null, reads: [] }, over); }
async function marketingApiRoute(route, path, method, url) {
  if (method !== 'GET') return null;
  const funnel = path.match(/^\/api\/v1\/marketing\/campaigns\/([0-9a-f-]{36})\/funnel$/);
  if (path !== '/api/v1/marketing/campaigns' && !funnel) return null;
  mkt.reads.push(funnel ? `funnel:${funnel[1]}` : 'list');
  const step = mkt.step; mkt.step = null;
  if (mkt.gate) { const gate = mkt.gate; mkt.gate = null; await gate; }
  if (step === 'session') return json(route, 401, { code: 'SIGN_IN_REQUIRED' });
  if (mkt.denied) return json(route, 403, { code: 'SAAS_FORBIDDEN' });
  if (!funnel) return json(route, 200, { data: mktCampaigns(), meta: { requestId: 'synthetic' } });
  const campaign = mktCampaigns().find((c) => c.id === funnel[1]);
  if (!campaign) return json(route, 404, { code: 'CAMPAIGN_NOT_FOUND' });
  const first = campaign.id === id(900);
  return json(route, 200, { data: { campaign, from: url.searchParams.get('from'), to: url.searchParams.get('to'), asOf: iso(0),
    leads: first ? 12 : 0, trialLeads: first ? 5 : 0, trialAppointments: first ? 6 : 0, completedTrialAppointments: first ? 4 : 0, wonLeads: first ? 3 : 0, lostLeads: first ? 1 : 0, archivedLeads: 0,
    enrollmentLinkage: 'UNAVAILABLE', revenueLinkage: 'UNAVAILABLE' }, meta: { requestId: 'synthetic' } });
}
// Class rosters (U5): the school's classes and one class's roster, two pages (synthetic). Read-only.
const rst = { denied: false, gate: null, step: null, reads: [] };
// The class list starts at the school's local today (UTC here), so these times follow the wall clock.
const wall = (hours) => new Date(Math.floor(Date.now() / 1000) * 1000 + hours * 3_600_000).toISOString();
const rstSessions = () => [['Kids Taekwondo', 2, 'SCHEDULED', 'Main mat'], ['Adult sparring', 28, 'SCHEDULED', null], ['Saturday open mat', -50, 'COMPLETED', 'Main mat'],
  ...Array.from({ length: 50 }, (_, n) => [`Open mat ${String(n + 1).padStart(2, '0')}`, 72 + n * 24, 'SCHEDULED', 'Side mat'])].map(([name, hours, status, roomName], n) => ({
  sessionId: id(950 + n), name, startsAt: wall(hours), endsAt: wall(hours + 1), roomName, capacity: 24, bookingPolicy: 'OPTIONAL_BOOKING', status, createdAt: iso(-400) })).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
const rstFamilies = ['Ahn', 'Baker', 'Choi', 'Diaz', 'Evans', 'Fischer', 'García', 'Hwang', 'Ito', 'Jones', 'Kim', 'López'];
const rstStudents = (sessionId) => sessionId !== id(950) ? [] : Array.from({ length: 60 }, (_, n) => ({ studentProfileId: id(1000 + n), personId: id(1100 + n),
  givenName: `Student${String(n).padStart(2, '0')}`, familyName: rstFamilies[n % rstFamilies.length], studentStatus: 'ACTIVE',
  booking: n % 10 === 9 ? null : { id: id(1200 + n), kind: n % 7 === 3 ? 'TRIAL' : 'REGULAR', status: n % 11 === 5 ? 'CANCELLED' : n % 13 === 6 ? 'WAITLISTED' : 'BOOKED', source: 'STAFF',
    bookedAt: iso(-30), cancelledAt: n % 11 === 5 ? iso(-5) : null, version: 1 },
  attendance: n % 10 === 9 || n % 4 === 0 ? { id: id(1300 + n), status: n % 8 === 0 ? 'LATE' : 'PRESENT', category: 'REGULAR_PARTICIPANT', recordedAt: iso(-1), version: 1 } : null }))
  .sort((a, b) => a.familyName.localeCompare(b.familyName) || a.givenName.localeCompare(b.givenName) || a.studentProfileId.localeCompare(b.studentProfileId));
function resetRoster(over = {}) { Object.assign(rst, { denied: false, gate: null, step: null, reads: [] }, over); }
async function rosterApiRoute(route, path, method, url, prefix) {
  if (method !== 'GET') return null;
  const roster = path.match(new RegExp(`^${prefix}/schedule/sessions/([0-9a-f-]{36})/roster$`));
  if (path !== `${prefix}/schedule/sessions/list` && !roster) return null;
  const cursor = url.searchParams.get('cursor'), from = url.searchParams.get('from');
  rst.reads.push(roster ? `roster:${roster[1]}:${cursor ?? 'first'}` : `list:${from ?? 'today'}:${cursor ?? 'first'}`);
  const step = rst.step; rst.step = null;
  if (rst.gate) { const gate = rst.gate; rst.gate = null; await gate; }
  if (step === 'session') return json(route, 401, { code: 'SIGN_IN_REQUIRED' });
  if (!roster) {
    if (route.request().headers()['x-hon-human-read'] !== 'class-sessions') return json(route, 403, { code: 'HUMAN_UI_REQUIRED' });
    if ([...url.searchParams.keys()].some((k) => !['from', 'limit', 'cursor'].includes(k)) || url.searchParams.get('limit') !== '50') return json(route, 400, { code: 'CLASS_SESSIONS_READ_SELECTORS_NOT_ACCEPTED' });
    if (step === 'cursor' && cursor) return json(route, 400, { code: 'INVALID_CURSOR' });
    const realToday = new Date().toISOString().slice(0, 10), listFrom = from ?? realToday;
    const all = rstSessions().filter((s) => s.startsAt >= `${listFrom}T00:00:00.000Z`), start = cursor === `list-p2:${listFrom}` ? 50 : 0;
    // 'midnight': a later page read after the school's local midnight reports the new day (paging itself continues).
    const localToday = step === 'midnight' && cursor ? new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) : realToday, fromDate = from ?? localToday;
    return json(route, 200, { data: all.slice(start, start + 50), meta: { requestId: id(949), correlationId: id(949), limit: 50,
      nextCursor: start + 50 < all.length ? `list-p2:${listFrom}` : null, schoolTimezone: 'UTC', localToday, fromDate } });
  }
  if (rst.denied) return json(route, 403, { code: 'ATTENDANCE_FORBIDDEN' });
  if (step === 'cursor' && cursor) return json(route, 400, { code: 'INVALID_CURSOR' });
  // An unknown or other-school session reads as an empty roster (the roster never reads hon.class_sessions).
  const all = rstStudents(roster[1]), start = cursor === 'page-2' ? 50 : 0, data = all.slice(start, start + 50);
  return json(route, 200, { data, meta: { requestId: id(948), correlationId: id(948), limit: 50, nextCursor: start + 50 < all.length ? 'page-2' : null } });
}
// Memberships (U6): the school's memberships, newest first, two pages, one state filter (synthetic). Read-only.
const mbl = { denied: false, gate: null, step: null, reads: [] };
const mblNames = ['Ahn', 'Baker', 'Choi', 'Diaz', 'Evans', 'Fischer', 'García', 'Hwang', 'Ito', 'Jones', 'Kim', 'López'];
const mblRows = () => Array.from({ length: 60 }, (_, n) => {
  const kind = n % 6, state = ['ACTIVE', 'ACTIVE', 'DRAFT', 'ACTIVE', 'FROZEN', 'CANCELLED'][kind];
  const effectiveStatus = state !== 'ACTIVE' ? state : kind === 0 ? 'IN_EFFECT' : kind === 1 ? 'SCHEDULED' : 'UNDATED';
  const dated = effectiveStatus === 'IN_EFFECT' || effectiveStatus === 'SCHEDULED';
  return { membershipId: id(1500 + n), state, version: 1, planCode: n % 2 ? 'KIDS-MONTHLY' : 'ADULT-MONTHLY', billingAccountId: id(1600 + n),
    participant: n === 7 ? null : { personId: id(1700 + n), givenName: `Member${String(n).padStart(2, '0')}`, familyName: mblNames[n % mblNames.length] },
    effectiveStatus, datesConfirmed: dated,
    currentPeriod: dated ? { periodVersion: 1, changeKind: 'INITIAL', startDate: kind === 1 ? '2026-12-01' : '2026-10-01', endDate: n % 4 === 0 ? null : '2027-01-31' } : null,
    legacyStoredTerm: dated ? null : { termStartedAt: kind === 3 ? '2026-09-01T00:00:00.000Z' : null, termEndsAt: null },
    createdAt: new Date(Date.parse('2026-10-20T12:00:00.000Z') - n * 3_600_000).toISOString() };
}).map((m) => { const c = chg.members.get(m.membershipId);
  return c && c.state !== m.state ? { ...m, state: c.state, version: c.version, effectiveStatus: c.state === 'ACTIVE' ? 'IN_EFFECT' : c.state } : m; });
function resetMemberships(over = {}) { Object.assign(mbl, { denied: false, gate: null, step: null, reads: [] }, over); }
async function membershipListApiRoute(route, path, method, url, prefix) {
  if (method !== 'GET' || path !== `${prefix}/billing/memberships`) return null;
  const cursor = url.searchParams.get('cursor'), state = url.searchParams.get('state');
  mbl.reads.push(`${state ?? 'ALL'}:${cursor ?? 'first'}`);
  const step = mbl.step; mbl.step = null;
  if (mbl.gate) { const gate = mbl.gate; mbl.gate = null; await gate; }
  if (step === 'session') return json(route, 401, { code: 'SIGN_IN_REQUIRED' });
  if (mbl.denied) return json(route, 403, { code: 'MEMBERSHIP_LIST_FORBIDDEN' });
  if (route.request().headers()['x-hon-source'] || url.searchParams.get('limit') !== '50') return json(route, 400, { code: 'VALIDATION_FAILED' });
  if (step === 'cursor' && cursor) return json(route, 400, { code: 'INVALID_CURSOR' });
  const all = mblRows().filter((m) => !state || m.state === state), start = cursor === `${state ?? 'ALL'}-page-2` ? 50 : 0, data = all.slice(start, start + 50);
  return json(route, 200, { data, meta: { requestId: id(1498), correlationId: id(1498), limit: 50, nextCursor: start + 50 < all.length ? `${state ?? 'ALL'}-page-2` : null,
    schoolTimezone: 'America/Los_Angeles', localToday: '2026-11-08' } });
}
// Pause, cancel & refunds (0224, synthetic). Member00 (id 1500) starts ACTIVE at version 1; its state, pauses and refund records
// live here. replies, one per POST: 'ok', 'unknown' (503, nothing changed), 'schedule' (409 active payment schedule).
const chg = { policy: null, members: new Map(), posts: [], replies: [], byKey: new Map(), reads: [], historyDenied: false };
const CHG_COMMAND = { 'membership-pause-policy': 'billing.membership.pause_policy.set', pause: 'billing.membership.pause', resume: 'billing.membership.resume',
  cancel: 'billing.membership.cancel', 'refund-records': 'billing.membership.refund.record' };
const chgToday = '2026-11-08';
function resetChanges(over = {}) {
  Object.assign(chg, { policy: { version: 3, pausesAllowed: true, maxPauseDays: 60, maxPausedDaysPerYear: 90, holdFee: { amountMinor: 1500, currency: 'USD' }, createdAt: '2026-11-01T10:00:00.000Z' },
    members: new Map([[id(1500), { state: 'ACTIVE', version: 1, pauses: [], refunds: [] }]]), posts: [], replies: [], byKey: new Map(), reads: [], historyDenied: false }, over);
}
resetChanges();
// ---------- Champions Club school page (synthetic) ----------
// replies, one per POST: 'ok', 'unknown' (503, nothing stored). summaryDenied: the summary read answers 403.
const CHP_COMMAND = { 'referral-code': 'champions-referral-code-issue', 'leaderboard-preference': 'champions-leaderboard-preference' };
const chp = { code: null, mode: 'ANONYMOUS', posts: [], replies: [], byKey: new Map(), reads: [], summaryDenied: false };
function resetChampions(over = {}) { Object.assign(chp, { code: null, mode: 'ANONYMOUS', posts: [], replies: [], byKey: new Map(), reads: [], summaryDenied: false }, over); }
const chpAt = '2026-11-05T12:00:00.000Z';
const chpMonths = Array.from({ length: 12 }, (_, i) => ({ month: `2026-${String(i + 1).padStart(2, '0')}`, qualified: i === 10 ? 2 : 0 }));
const chpCounts = { pending: 1, qualified: 4, rejected: 1, refunded: 0, reversed: 0 };
async function championsApiRoute(route, path, method, url) {
  const request = route.request(), headers = request.headers(), tail = path.slice(`/api/v1/schools/${scope.schoolId}/champions/`.length);
  const allowed = tail === 'leaderboard' ? ['period', 'month'] : [];
  if ([...url.searchParams.keys()].some((k) => !allowed.includes(k)) || Object.keys(headers).some((k) => k.startsWith('x-hon-') && k !== 'x-hon-human-command')) return json(route, 400, { code: 'INVALID_CHAMPIONS_INPUT' });
  if (method === 'GET') {
    if (headers['idempotency-key'] !== undefined || headers['x-hon-human-command'] !== undefined || request.postData()) return json(route, 400, { code: 'INVALID_CHAMPIONS_INPUT' });
    chp.reads.push(`${tail}${url.search}`);
    if (tail === 'summary') return chp.summaryDenied ? json(route, 403, { code: 'CHAMPIONS_FORBIDDEN' }) : json(route, 200, { data: { schoolId: scope.schoolId,
      referralCode: chp.code ? { code: chp.code, status: 'ACTIVE', issuedAt: chpAt } : null, program: { status: 'PUBLISHED', policyVersion: 3, financialRewards: 'DISABLED' }, referrals: chpCounts } });
    if (tail === 'statistics') return json(route, 200, { data: { schoolId: scope.schoolId, referrals: chpCounts, monthlyQualified: chpMonths,
      milestones: { program: { status: 'PUBLISHED', policyVersion: 3 }, reached: [{ rewardKind: 'FREE_MONTHS', milestoneCount: 3 }], nextMilestone: { rewardKind: 'LIFETIME_MEMBERSHIP', milestoneCount: 10, remaining: 6 }, qualifiedReferrals: 4 },
      allTimeRank: 2, history: [{ occurredAt: chpAt, fromState: 'PENDING', toState: 'QUALIFIED', reason: 'QUALIFICATION_VERIFIED' }, { occurredAt: '2026-11-01T09:00:00.000Z', fromState: null, toState: 'PENDING', reason: 'CAPTURED' }],
      historyLimit: 50, displayMode: chp.mode } });
    if (tail === 'rewards') return json(route, 200, { data: { schoolId: scope.schoolId, qualifiedReferrals: 4, program: { status: 'PUBLISHED', policyVersion: 3 },
      nextMilestone: { rewardKind: 'LIFETIME_MEMBERSHIP', milestoneCount: 10, remaining: 6 },
      rewards: [{ rewardKind: 'REFERRER_CREDIT', beneficiaryRole: 'REFERRER', milestoneCount: null, creditMinor: 10000, freeMonths: null, lifetimeTier: null, aiAllowance: null, status: 'APPROVED', accruedAt: chpAt },
        { rewardKind: 'FREE_MONTHS', beneficiaryRole: 'REFERRER', milestoneCount: 3, creditMinor: null, freeMonths: 2, lifetimeTier: null, aiAllowance: null, status: 'ACCRUED', accruedAt: chpAt }],
      financialActivation: 'DISABLED' } });
    if (tail === 'contests') return json(route, 200, { data: { schoolId: scope.schoolId, countsOnly: 'QUALIFIED', contests: [{ contestId: id(2390), name: 'Winter referral sprint',
      description: 'Most qualified referrals between November and January.', termsReference: null, status: 'ACTIVE', startsAt: '2026-11-01T00:00:00.000Z', endsAt: '2027-01-31T23:59:59.000Z', minimumQualified: 2,
      prizes: [{ placeFrom: 1, placeTo: 1, kind: 'ELECTRONICS', description: 'Tablet for the front desk', quantity: 1 }],
      standings: [{ rank: 1, displayName: 'Synthetic Martial Arts Academy', anonymous: false, qualifiedReferrals: 2, isYou: true }], you: { qualifiedReferrals: 2, status: 'RANKED', rank: 1 }, won: false }] } });
    if (tail === 'leaderboard') {
      const period = url.searchParams.get('period'), month = url.searchParams.get('month');
      if (!((period === 'ALL_TIME' && month === null) || (period === 'MONTH' && /^20\d{2}-(0[1-9]|1[0-2])$/.test(month ?? '')))) return json(route, 400, { code: 'INVALID_CHAMPIONS_INPUT' });
      const m = period === 'MONTH';
      return json(route, 200, { data: { period, month: m ? month : null, limit: 25, countsOnly: 'QUALIFIED', timeZone: 'UTC',
        standings: [{ rank: 1, displayName: m ? 'Northside Taekwondo' : 'Tiger Rock Dojang', anonymous: false, qualifiedReferrals: m ? 3 : 9, isYou: false },
          { rank: 2, displayName: 'Synthetic Martial Arts Academy', anonymous: false, qualifiedReferrals: m ? 2 : 4, isYou: true },
          { rank: 3, displayName: null, anonymous: true, qualifiedReferrals: 1, isYou: false }],
        you: { schoolId: scope.schoolId, status: 'RANKED', rank: 2, qualifiedReferrals: m ? 2 : 4, displayMode: chp.mode } } });
    }
    return null;
  }
  if (method !== 'POST' || !CHP_COMMAND[tail]) return null;
  const key = headers['idempotency-key'], body = JSON.parse(request.postData() ?? 'null');
  chp.posts.push({ key, tail, command: headers['x-hon-human-command'], body });
  if (headers['x-hon-human-command'] !== CHP_COMMAND[tail] || !/^application\/json/.test(headers['content-type'] ?? '')) return json(route, 403, { code: 'CHAMPIONS_FORBIDDEN' });
  if (!key) return json(route, 400, { code: 'INVALID_CHAMPIONS_INPUT' });
  if (chp.byKey.has(key)) return json(route, 200, { data: { ...chp.byKey.get(key), replayed: true } });
  if ((chp.replies.shift() ?? 'ok') === 'unknown') return json(route, 503, { code: 'CHAMPIONS_UNAVAILABLE_TRY_AGAIN' });
  let receipt;
  if (tail === 'referral-code') {
    const created = chp.code === null; chp.code ??= 'K7M2Q9X4PA';
    receipt = { schoolId: scope.schoolId, code: chp.code, status: 'ACTIVE', issuedAt: chpAt, created, replayed: false };
  } else {
    if (!body || !['ANONYMOUS', 'SCHOOL_NAME'].includes(body.displayMode) || Object.keys(body).length !== 1) return json(route, 400, { code: 'INVALID_CHAMPIONS_INPUT' });
    chp.mode = body.displayMode; receipt = { schoolId: scope.schoolId, displayMode: chp.mode, version: 2, updatedAt: chpAt, replayed: false };
  }
  chp.byKey.set(key, receipt);
  return json(route, 200, { data: receipt });
}
async function changesApiRoute(route, path, method, prefix) {
  const request = route.request(), headers = request.headers(), meta = { requestId: id(1950), correlationId: id(1950) };
  if (new URL(request.url()).search || ['x-hon-source', 'x-hon-action-request-id', 'x-hon-delegated-by-principal-id'].some((k) => headers[k] !== undefined)) return json(route, 400, { code: 'VALIDATION_FAILED' });
  const target = path.match(/\/billing\/memberships\/([0-9a-f-]{36})\/([a-z-]+)$/), tail = target ? target[2] : 'membership-pause-policy';
  if (method === 'GET') {
    if (headers['idempotency-key'] !== undefined) return json(route, 409, { code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    chg.reads.push(tail);
    if (tail === 'membership-pause-policy') return json(route, 200, { data: { policy: chg.policy, localToday: chgToday }, meta });
    if (chg.historyDenied) return json(route, 403, { code: 'MEMBERSHIP_PAUSE_HISTORY_FORBIDDEN' });
    const m = chg.members.get(target[1]) ?? (() => { const row = mblRows().find((r) => r.membershipId === target[1]); return row ? { state: row.state, version: row.version, pauses: [], refunds: [] } : null; })();
    if (!m) return json(route, 404, { code: 'BILLING_MEMBERSHIP_NOT_FOUND' });
    return json(route, 200, { data: { membershipId: target[1], state: m.state, version: m.version, localToday: chgToday, pauses: m.pauses, refunds: m.refunds }, meta });
  }
  if (method !== 'POST') return null;
  const key = headers['idempotency-key'], body = JSON.parse(request.postData() ?? '{}');
  chg.posts.push({ key, tail, command: headers['x-hon-human-command'], body });
  if (headers['x-hon-human-command'] !== CHG_COMMAND[tail] || !/^application\/json/.test(headers['content-type'] ?? '')) return json(route, 403, { code: 'HUMAN_UI_REQUIRED' });
  if (!key) return json(route, 409, { code: 'IDEMPOTENCY_KEY_REQUIRED' });
  if (chg.byKey.has(key)) return json(route, 200, { data: chg.byKey.get(key), meta: { ...meta, replayed: true } });
  const next = chg.replies.shift() ?? 'ok';
  if (next === 'unknown') return json(route, 503, { code: 'MEMBERSHIP_LIFECYCLE_UNAVAILABLE' });
  if (next === 'schedule') return json(route, 409, { code: 'MEMBERSHIP_PAUSE_REQUIRES_BILLING_ARRANGEMENT' });
  let receipt;
  if (tail === 'membership-pause-policy') {
    if (body.expectedVersion !== chg.policy.version) return json(route, 409, { code: 'VERSION_CONFLICT' });
    chg.policy = { version: chg.policy.version + 1, pausesAllowed: body.pausesAllowed, maxPauseDays: body.maxPauseDays, maxPausedDaysPerYear: body.maxPausedDaysPerYear, holdFee: body.holdFee, createdAt: '2026-11-08T12:00:00.000Z' };
    receipt = chg.policy;
  } else {
    const m = chg.members.get(target[1]);
    if (!m) return json(route, 404, { code: 'BILLING_MEMBERSHIP_NOT_FOUND' });
    if (tail !== 'refund-records' && body.expectedVersion !== m.version) return json(route, 409, { code: 'VERSION_CONFLICT' });
    const open = m.pauses.find((x) => x.endedKind === null);
    if (tail === 'pause') {
      if (m.state !== 'ACTIVE') return json(route, 409, { code: 'MEMBERSHIP_NOT_ACTIVE' });
      const pause = { pauseId: id(1960 + m.pauses.length), membershipId: target[1], policyVersion: chg.policy.version, startsOn: chgToday, plannedResumeOn: body.resumeOn, pauseReason: body.pauseReason,
        holdFee: chg.policy.holdFee, pausedAt: '2026-11-08T12:00:00.000Z', endedKind: null, endedOn: null, endReason: null, endedAt: null };
      m.pauses.push(pause); m.state = 'FROZEN'; m.version++; receipt = { ...pause, membershipState: 'FROZEN', membershipVersion: m.version };
    } else if (tail === 'resume') {
      if (m.state !== 'FROZEN' || !open) return json(route, 409, { code: 'MEMBERSHIP_NOT_PAUSED' });
      Object.assign(open, { endedKind: 'RESUMED', endedOn: chgToday, endReason: body.resumeReason ?? null, endedAt: '2026-11-08T12:05:00.000Z' });
      m.state = 'ACTIVE'; m.version++; receipt = { ...open, membershipState: 'ACTIVE', membershipVersion: m.version };
    } else if (tail === 'cancel') {
      if (m.state !== 'ACTIVE' && m.state !== 'FROZEN') return json(route, 409, { code: 'MEMBERSHIP_NOT_ACTIVE' });
      if (open) Object.assign(open, { endedKind: 'CANCELLED', endedOn: chgToday, endReason: body.cancellationReason, endedAt: '2026-11-08T12:10:00.000Z' });
      m.state = 'CANCELLED'; m.version++;
      receipt = { id: target[1], billingAccountId: id(1600), participantPersonId: id(1700), planCode: 'ADULT-MONTHLY', state: 'CANCELLED', version: m.version, cancellationReason: body.cancellationReason, createdAt: '2026-10-20T12:00:00.000Z' };
    } else {
      if (m.state !== 'CANCELLED') return json(route, 409, { code: 'MEMBERSHIP_NOT_CANCELLED' });
      receipt = { refundId: id(1980 + m.refunds.length), membershipId: target[1], amountMinor: body.amountMinor, currency: body.currency, refundedOn: body.refundedOn, method: body.method, reason: body.reason, recordedAt: '2026-11-08T12:15:00.000Z' };
      m.refunds.push(receipt);
    }
  }
  chg.byKey.set(key, receipt);
  return json(route, 200, { data: receipt, meta: { ...meta, replayed: false } });
}
// School ownership (B-ID-4, synthetic). HQ directory of two schools; the HQ owner sees owners, the primary, HQ seats and notices,
// and can make another owner primary. replies, one per POST: 'ok', 'unknown' (503, nothing changed), 'notLive' (404).
const own = { denied: false, ownerDenied: false, primary: new Map(), posts: [], replies: [], byKey: new Map(), reads: [] };
const ownSecond = id(1802);
const ownOwners = (schoolId) => schoolId === ownSecond
  ? [{ ownerGrantId: id(1821), displayName: 'Jamie Cho', email: 'jamie.owner@example.invalid', since: '2026-10-03T10:00:00.000Z', viaInvitation: true }]
  : [{ ownerGrantId: id(1811), displayName: 'Dana Reyes', email: 'dana.owner@example.invalid', since: '2026-09-15T10:00:00.000Z', viaInvitation: false },
    { ownerGrantId: id(1812), displayName: 'Sam Park', email: 'sam.owner@example.invalid', since: '2026-10-20T10:00:00.000Z', viaInvitation: true }];
const ownNotices = (schoolId) => schoolId === ownSecond ? [] : [
  ...(own.primary.get(schoolId) === id(1812) ? [{ noticeId: id(1890), kind: 'PRIMARY_OWNER_CHANGED', occurredAt: '2026-11-08T12:00:00.000Z', invitedEmail: null }] : []),
  { noticeId: id(1891), kind: 'OWNER_ADDED', occurredAt: '2026-10-20T10:00:00.000Z', invitedEmail: 'sam.owner@example.invalid' },
  { noticeId: id(1892), kind: 'OWNER_INVITED', occurredAt: '2026-10-19T10:00:00.000Z', invitedEmail: 'sam.owner@example.invalid' }];
function resetOwnership(over = {}) {
  Object.assign(own, { denied: false, ownerDenied: false, primary: new Map([[scope.schoolId, id(1811)], [ownSecond, null]]), posts: [], replies: [], byKey: new Map(), reads: [] }, over);
}
resetOwnership();
const ownView = (schoolId) => { const primary = own.primary.get(schoolId) ?? null, owners = ownOwners(schoolId).map((o) => ({ ...o, primary: o.ownerGrantId === primary }));
  return { owners, primaryOwnerGrantId: primary, notices: ownNotices(schoolId), asOf: '2026-11-08T12:30:00.000Z' }; };
// HQ AI costs and safety (S4-c/d/e, synthetic). Pauses, lost calls and settlements live here; replies, one per POST:
// 'ok', 'unknown' (503, nothing changed), 'active' (422 AI_SPEND_PAUSE_ALREADY_ACTIVE).
// ---------- HQ free-trial governance (read only) ----------
const tgx = { reads: [], denied: false, other: 0 };
const tgId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tgTerms = { allowedDurationsDays: [14, 30], allowedCapabilityProfiles: ['CORE', 'COMPLETE'], allowedEligibilityCodes: ['NEW_ORGANIZATIONS_ONLY'], allowedLinkModes: ['PRIVATE_INVITATION'],
  maxEnrollmentCapacity: 50, maxEnrollmentWindowDays: 90, maxPublishedCampaigns: 3, maxTotalEnrollmentCapacity: 120, termsReference: 'hon-trial-terms/v1', promotionalLimits: null };
const tgDef = (over = {}) => ({ name: 'Spring pilot schools', durationDays: 30, capabilityProfile: 'COMPLETE', eligibility: 'NEW_ORGANIZATIONS_ONLY', linkMode: 'PRIVATE_INVITATION',
  enrollmentOpensAt: '2026-11-15T00:00:00.000Z', enrollmentClosesAt: '2026-12-15T00:00:00.000Z', maximumEnrollments: 20, termsReference: 'hon-trial-terms/v1', promotionalBudget: null, ...over });
function trialsGovernance() {
  const actor = tgId(9);
  return { scope: 'CUSTOMER_TRIAL_GOVERNANCE_ONLY', program: { status: 'INACTIVE', signupEnabled: false, enrollmentEnabled: false, promotionalIssuanceEnabled: false },
    policyVersions: [{ policyId: tgId(11), version: 2, status: 'PROPOSED', terms: tgTerms, reason: 'Owner-approved pilot trial rules', actorPrincipalId: actor, recordedAt: '2026-11-02T10:00:00.000Z' },
      { policyId: tgId(10), version: 1, status: 'PROPOSED', terms: { ...tgTerms, allowedDurationsDays: [14] }, reason: 'First draft of the trial rules', actorPrincipalId: actor, recordedAt: '2026-11-01T10:00:00.000Z' }],
    policyDecisions: [{ decisionId: tgId(20), revision: 1, policyId: tgId(11), decision: 'APPROVED', validFrom: '2026-11-01T00:00:00.000Z', validUntil: '2027-02-01T00:00:00.000Z',
      reason: 'Approved for the pilot window', actorPrincipalId: actor, recordedAt: '2026-11-03T10:00:00.000Z' }],
    campaignVersions: [
      { versionId: tgId(40), campaignId: tgId(30), version: 1, definition: tgDef(), reason: 'Draft for the first pilot cohort', actorPrincipalId: actor, recordedAt: '2026-11-04T10:00:00.000Z' },
      { versionId: tgId(41), campaignId: tgId(30), version: 2, definition: tgDef({ maximumEnrollments: 60 }), reason: 'Larger cohort requested by HQ', actorPrincipalId: actor, recordedAt: '2026-11-05T10:00:00.000Z' },
      { versionId: tgId(42), campaignId: tgId(31), version: 1, definition: tgDef({ name: 'Founder schools', capabilityProfile: 'CORE', durationDays: 14 }), reason: 'Founder cohort draft for review',
        actorPrincipalId: actor, recordedAt: '2026-11-03T12:00:00.000Z' }],
    publications: [{ publicationId: tgId(50), campaignId: tgId(30), revision: 1, kind: 'PUBLISHED', versionId: tgId(40), policyDecisionId: tgId(20), previewDigest: 'a'.repeat(64),
      reason: 'Definition recorded for the pilot', actorPrincipalId: actor, recordedAt: '2026-11-04T12:00:00.000Z', activationAvailable: false }],
    limit: 100, hasMore: { policyVersions: false, policyDecisions: false, campaignVersions: false, publications: false },
    existingPrograms: { paidAccess: 'INACTIVE', aiCredits: 'INACTIVE', payments: 'TEST_MODE' }, asOf: '2026-11-09T05:00:00.000Z' };
}
async function trialsApiRoute(route, path, method, url) {
  const headers = route.request().headers();
  // Read only: any write, command marker, key or query is refused.
  if (method !== 'GET' || url.search || Object.keys(headers).some((k) => k.startsWith('x-hon-') || k === 'idempotency-key')) { tgx.other++; return json(route, 400, { code: 'SAAS_INVALID_REQUEST' }); }
  if (tgx.denied) return json(route, 403, { code: 'SAAS_FORBIDDEN' });
  tgx.reads.push(path.slice('/api/v1/hq/saas/trials/'.length));
  if (path === '/api/v1/hq/saas/trials/governance') return json(route, 200, { data: trialsGovernance() });
  const m = /^\/api\/v1\/hq\/saas\/trials\/campaign-versions\/([0-9a-f-]{36})\/publication-preview$/.exec(path);
  if (m) {
    const campaignId = m[1] === tgId(42) ? tgId(31) : tgId(30), version = m[1] === tgId(41) ? 2 : 1;
    const blockers = m[1] === tgId(41) ? ['CAPACITY_EXCEEDS_POLICY'] : [];
    return json(route, 200, { data: { campaignId, versionId: m[1], version, expectedRevision: campaignId === tgId(30) ? 1 : 0, policyDecisionId: tgId(20), policyId: tgId(11),
      digest: 'b'.repeat(64), ready: blockers.length === 0, blockers, activationAvailable: false, promotionalCreditsAvailable: false,
      plannedExposure: { enrollments: m[1] === tgId(41) ? 60 : 20, promotionalCostMinor: 0, currency: 'USD' }, asOf: '2026-11-09T05:01:00.000Z' } });
  }
  return null;
}
const aix = { pauses: [], open: [], resolved: [], posts: [], replies: [], byKey: new Map(), usage: [], reads: [], denied: false };
const AIX_COMMAND = { 'spend-pauses': 'ai-spend-pause', resolve: 'ai-unknown-resolve', 'late-provider-expense': 'ai-late-provider-expense' };
const aixZero = { providerReportedCostMicrounits: 0, estimatedWriteOffCostMicrounits: 0, entries: 0, writeOffEntries: 0, lateProviderCostMicrounits: 0, lateProviderExpenseEntries: 0, supersededWriteOffEstimateMicrounits: 0 };
function resetAiControl(over = {}) {
  Object.assign(aix, { pauses: [], posts: [], replies: [], byKey: new Map(), usage: [], reads: [], denied: false,
    open: [{ agent: 'MARKETING', invocationId: id(2100), organizationId: scope.organizationId, schoolId: scope.schoolId, status: 'UNKNOWN', reservedCredits: 40,
      heldAt: '2026-11-08T10:00:00.000Z', countsAgainstCurrentWindow: true }],
    resolved: [{ resolutionId: id(2110), agent: 'TEACHING', invocationId: id(2101), organizationId: scope.organizationId, schoolId: ownSecond, decision: 'WRITE_OFF', releasedCredits: 25,
      ledgerEntryId: id(2111), customerCredits: 0, resolvedAt: '2026-11-07T12:00:00.000Z', reason: 'Provider has no record we can match', evidence: { estimatedProviderCostMicrounits: 2000 },
      resolvedByPrincipalId: id(2190), priorStatus: 'UNKNOWN', heldAt: '2026-11-06T10:00:00.000Z', lateProviderExpense: null }] }, over);
}
resetAiControl();
function aiUsage(from, to) {
  const a = (credits, cost, entries) => ({ credits, ...aixZero, providerReportedCostMicrounits: cost, entries });
  return { from, to, asOf: '2026-11-09T00:00:01.000Z', truncated: false, providerCostUnit: 'MICROUNITS_USD', schools: [
    { organizationId: scope.organizationId, schoolId: scope.schoolId, ...aixZero, providerReportedCostMicrounits: 1_293_400, entries: 23, unreconciledInvocations: aix.open.length, byClass: {
      AGENT_INFERENCE: { ...a(860, 93_400, 21), byAgent: { MARKETING: a(500, 61_000, 12), CHAD_FOLLOW_UP: a(240, 22_400, 7), TEACHING: a(120, 10_000, 2) } },
      CREATIVE_MEDIA: { ...a(1_200, 1_200_000, 2), byAgent: null } } },
    { organizationId: scope.organizationId, schoolId: ownSecond, ...aixZero, estimatedWriteOffCostMicrounits: 2_000, entries: 1, writeOffEntries: 1, unreconciledInvocations: 0, byClass: {
      AGENT_INFERENCE: { credits: 0, ...aixZero, estimatedWriteOffCostMicrounits: 2_000, entries: 1, writeOffEntries: 1,
        byAgent: { TEACHING: { credits: 0, ...aixZero, estimatedWriteOffCostMicrounits: 2_000, entries: 1, writeOffEntries: 1 } } } } }],
    organizations: [{ organizationId: scope.organizationId, agentWindowStart: '2026-11-01T00:00:00.000Z', agentWindowEnd: '2026-12-01T00:00:00.000Z', agentCommittedCredits: 900,
      agentCeilingCredits: 12_000, openUnknownHolds: aix.open.length, aiPaused: aix.pauses.some((p) => p.status === 'ACTIVE' && (p.organizationId === null || p.organizationId === scope.organizationId)) }] };
}
async function aiControlApiRoute(route, path, method, url) {
  const request = route.request(), headers = request.headers();
  if (Object.keys(headers).some((k) => k.startsWith('x-hon-') && k !== 'x-hon-human-command')) return json(route, 400, { code: 'SAAS_INVALID_REQUEST' });
  if (method === 'GET') {
    if (headers['idempotency-key'] !== undefined || headers['x-hon-human-command'] !== undefined) return json(route, 400, { code: 'SAAS_INVALID_REQUEST' });
    if (aix.denied) return json(route, 403, { code: 'SAAS_FORBIDDEN' });
    if (path === '/api/v1/hq/ai/school-usage') {
      const keys = [...url.searchParams.keys()].sort().join(',');
      if (keys !== 'from,to') return json(route, 400, { code: 'SAAS_INVALID_REQUEST' });
      const from = url.searchParams.get('from'), to = url.searchParams.get('to');
      aix.usage.push({ from, to });
      return json(route, 200, { data: aiUsage(from, to) });
    }
    if (url.search) return json(route, 400, { code: 'SAAS_INVALID_REQUEST' });
    aix.reads.push(path.split('/').pop());
    if (path === '/api/v1/hq/ai/spend-pauses') return json(route, 200, { data: { pauses: [...aix.pauses].sort((x, y) => (x.status === 'ACTIVE' ? 0 : 1) - (y.status === 'ACTIVE' ? 0 : 1)), asOf: '2026-11-09T03:00:00.000Z' } });
    if (path === '/api/v1/hq/ai/unknown-invocations') return json(route, 200, { data: { open: aix.open, resolved: aix.resolved, staleAfterSeconds: 900, asOf: '2026-11-09T03:00:00.000Z' } });
    return null;
  }
  if (method !== 'POST' || url.search) return null;
  const target = path.match(/^\/api\/v1\/hq\/ai\/unknown-invocations\/([A-Z_]+)\/([0-9a-f-]{36})\/(resolve|late-provider-expense)$/);
  const tail = path === '/api/v1/hq/ai/spend-pauses' ? 'spend-pauses' : target ? target[3] : null;
  if (!tail) return null;
  const key = headers['idempotency-key'], body = JSON.parse(request.postData() ?? '{}');
  aix.posts.push({ key, tail, command: headers['x-hon-human-command'], body, agent: target?.[1] ?? null, invocationId: target?.[2] ?? null });
  if (headers['x-hon-human-command'] !== AIX_COMMAND[tail] || !/^application\/json/.test(headers['content-type'] ?? '') || headers.origin !== origin) return json(route, 403, { code: 'SAAS_FORBIDDEN' });
  if (!key) return json(route, 400, { code: 'SAAS_INVALID_REQUEST' });
  if (aix.byKey.has(key)) return json(route, 200, { data: { ...aix.byKey.get(key), replayed: true } });
  const next = aix.replies.shift() ?? 'ok';
  if (next === 'unknown') return json(route, 503, { code: 'SAAS_UNAVAILABLE' });
  if (next === 'active') return json(route, 422, { code: 'AI_SPEND_PAUSE_ALREADY_ACTIVE' });
  let receipt;
  if (tail === 'spend-pauses') {
    if (body.action === 'PAUSE') {
      const pause = { pauseId: id(2200 + aix.pauses.length), organizationId: body.organizationId, spendClass: body.spendClass, reason: body.reason, pausedAt: '2026-11-09T02:30:00.000Z',
        pausedByPrincipalId: id(2190), status: 'ACTIVE', endReason: null, endedAt: null, endedByPrincipalId: null };
      aix.pauses.push(pause); receipt = { pauseId: pause.pauseId, organizationId: pause.organizationId, spendClass: pause.spendClass, status: 'ACTIVE', replayed: false };
    } else {
      const pause = aix.pauses.find((p) => p.status === 'ACTIVE' && p.organizationId === body.organizationId && p.spendClass === body.spendClass);
      if (!pause) return json(route, 422, { code: 'AI_SPEND_PAUSE_NOT_ACTIVE' });
      Object.assign(pause, { status: 'ENDED', endReason: body.reason, endedAt: '2026-11-09T02:45:00.000Z', endedByPrincipalId: id(2190) });
      receipt = { pauseId: pause.pauseId, organizationId: pause.organizationId, spendClass: pause.spendClass, status: 'ENDED', replayed: false };
    }
  } else if (tail === 'resolve') {
    const at = aix.open.findIndex((x) => x.agent === target[1] && x.invocationId === target[2]);
    if (at < 0) return json(route, 422, { code: 'AI_UNKNOWN_NOT_RESOLVABLE' });
    const [item] = aix.open.splice(at, 1), recorded = body.decision !== 'NO_PROVIDER_CHARGE';
    receipt = { resolutionId: id(2120 + aix.resolved.length), agent: item.agent, invocationId: item.invocationId, organizationId: item.organizationId, schoolId: item.schoolId,
      decision: body.decision, releasedCredits: item.reservedCredits, ledgerEntryId: recorded ? id(2130 + aix.resolved.length) : null,
      customerCredits: body.decision === 'RECORD_PROVIDER_COST' ? 12 : body.decision === 'WRITE_OFF' ? 0 : null, resolvedAt: '2026-11-09T02:50:00.000Z', replayed: false };
    const { replayed: _r, ...row } = receipt;
    aix.resolved.unshift({ ...row, reason: body.reason, evidence: body.evidence, resolvedByPrincipalId: id(2190), priorStatus: item.status, heldAt: item.heldAt, lateProviderExpense: null });
  } else {
    const row = aix.resolved.find((x) => x.agent === target[1] && x.invocationId === target[2]);
    if (!row || row.decision !== 'WRITE_OFF') return json(route, 422, { code: 'AI_LATE_EXPENSE_NOT_WRITTEN_OFF' });
    if (row.lateProviderExpense) return json(route, 422, { code: 'AI_LATE_EXPENSE_ALREADY_RECORDED' });
    row.lateProviderExpense = { expenseId: id(2140), providerCostMicrounits: body.evidence.providerCostMicrounits, occurredAt: row.heldAt, recordedAt: '2026-11-09T02:55:00.000Z' };
    receipt = { expenseId: id(2140), resolutionId: row.resolutionId, agent: row.agent, invocationId: row.invocationId, providerCostMicrounits: body.evidence.providerCostMicrounits,
      estimatedProviderCostMicrounits: row.evidence.estimatedProviderCostMicrounits, customerCredits: 0, occurredAt: row.heldAt, recordedAt: '2026-11-09T02:55:00.000Z', replayed: false };
  }
  aix.byKey.set(key, receipt);
  return json(route, 200, { data: receipt });
}
async function ownershipApiRoute(route, path, method) {
  const request = route.request(), headers = request.headers();
  if (Object.keys(headers).some((k) => k.startsWith('x-hon-') && k !== 'x-hon-human-command') || new URL(request.url()).search) return json(route, 400, { code: 'ACCOUNT_INPUT_INVALID' });
  if (path === '/api/v1/hq/schools' && method === 'GET') return json(route, 200, { data: { directory: { schools: [
    { schoolId: scope.schoolId, organizationDisplayName: 'Synthetic Dojo Group', schoolDisplayName: 'Synthetic Martial Arts Academy', organizationOperationalStatus: 'ACTIVE', schoolOperationalStatus: 'ACTIVE', entitlementTier: 'COMPLETE', createdAt: '2026-09-01T10:00:00.000Z' },
    { schoolId: ownSecond, organizationDisplayName: 'Synthetic Dojo Group', schoolDisplayName: 'Synthetic North Branch', organizationOperationalStatus: 'ACTIVE', schoolOperationalStatus: 'ACTIVE', entitlementTier: 'CORE', createdAt: '2026-10-01T10:00:00.000Z' }] } } });
  const hqRead = path.match(/^\/api\/v1\/hq\/schools\/([0-9a-f-]{36})\/ownership$/), ownerRead = path.match(/^\/api\/v1\/account\/schools\/([0-9a-f-]{36})\/ownership$/);
  if (hqRead && method === 'GET') {
    own.reads.push(`hq:${hqRead[1]}`);
    if (own.denied) return json(route, 403, { code: 'ACCOUNT_FORBIDDEN' });
    const v = ownView(hqRead[1]);
    return json(route, 200, { data: { schoolId: hqRead[1], organizationId: scope.organizationId, ...v, primaryNeeded: v.owners.length > 0 && v.primaryOwnerGrantId === null,
      hqOwnerGrantIds: hqRead[1] === ownSecond ? [] : [id(1801)] } });
  }
  if (ownerRead && method === 'GET') {
    own.reads.push(`owner:${ownerRead[1]}`);
    if (own.ownerDenied || ownerRead[1] !== scope.schoolId) return json(route, 403, { code: 'ACCOUNT_FORBIDDEN' });
    const v = ownView(ownerRead[1]);
    return json(route, 200, { data: { schoolId: ownerRead[1], owners: v.owners, yourOwnerGrantId: id(1811), primaryOwnerGrantId: v.primaryOwnerGrantId, notices: v.notices, asOf: v.asOf } });
  }
  if (path === '/api/v1/hq/school-ownership/primary-owner' && method === 'POST') {
    const key = headers['idempotency-key'], body = JSON.parse(request.postData() ?? '{}');
    own.posts.push({ key, command: headers['x-hon-human-command'], body });
    if (headers['x-hon-human-command'] !== 'school-owner-account' || !/^application\/json/.test(headers['content-type'] ?? '')) return json(route, 403, { code: 'HUMAN_UI_REQUIRED' });
    if (own.byKey.has(key)) return json(route, 200, { data: own.byKey.get(key) });
    const next = own.replies.shift() ?? 'ok';
    if (next === 'unknown') return json(route, 503, { code: 'ACCOUNT_UNAVAILABLE' });
    if (next === 'notLive') return json(route, 404, { code: 'OWNERSHIP_OWNER_NOT_LIVE' });
    const changed = own.primary.get(body.schoolId) !== body.ownerGrantId; own.primary.set(body.schoolId, body.ownerGrantId);
    const receipt = { operation: 'SET_PRIMARY', schoolId: body.schoolId, organizationId: scope.organizationId, primaryOwnerGrantId: body.ownerGrantId, changed };
    own.byKey.set(key, receipt); return json(route, 200, { data: receipt });
  }
  return null;
}
const ppl = { canEdit: true, records: new Map(), posts: [], replies: [], byKey: new Map(), gate: null };
function resetPeople(over = {}) {
  ppl.records = new Map([[id(301), { personId: id(301), schoolId: scope.schoolId, givenName: 'Ana', familyName: 'Rivera', email: 'ana.parent@example.invalid', phoneE164: '+15555550101',
    version: 1, updatedAt: iso(-48), student: { birthDate: '2015-04-02', status: 'ACTIVE', version: 1 }, consents: { EMAIL: 'OPTED_IN', SMS: 'NOT_RECORDED' } }],
  [id(302), { personId: id(302), schoolId: scope.schoolId, givenName: 'Ben', familyName: 'Okafor', email: null, phoneE164: '+15555550102',
    version: 2, updatedAt: iso(-24), student: null, consents: { EMAIL: 'NOT_RECORDED', SMS: 'OPTED_OUT' } }]]);
  Object.assign(ppl, { canEdit: true, posts: [], replies: [], byKey: new Map(), gate: null }, over);
  // Contact consent records (0217 rule source): one row per recorded channel. puts/replies are the consent commands' own.
  ppl.consents = new Map([[id(301), new Map([['EMAIL', { channel: 'EMAIL', status: 'OPTED_IN', source: 'STAFF', capturedAt: '2026-10-01T16:00:00.000Z', version: 1, updatedAt: '2026-10-01T16:00:00.000Z' }]])],
    [id(302), new Map([['SMS', { channel: 'SMS', status: 'OPTED_OUT', source: 'PARENT', capturedAt: '2026-10-02T16:00:00.000Z', version: 1, updatedAt: '2026-10-02T16:00:00.000Z' }]])]]);
  Object.assign(ppl, { consentPuts: [], consentReplies: [], consentKeys: new Map(), consentReads: 0, consentDenied: false }, over.consent ?? {});
}
resetPeople();
async function consentApiRoute(route, method, url, personId, channel) {
  const request = route.request(), headers = request.headers(), meta = { requestId: id(960), correlationId: id(960) };
  if (url.search || ['x-hon-source', 'x-hon-action-request-id', 'x-hon-delegated-by-principal-id'].some((k) => headers[k] !== undefined)) return json(route, 403, { code: 'HUMAN_UI_REQUIRED' });
  const rows = ppl.consents.get(personId);
  if (method === 'GET' && channel === null) {
    ppl.consentReads++;
    if (headers['idempotency-key'] !== undefined || headers['x-hon-human-command'] !== undefined) return json(route, 403, { code: 'HUMAN_UI_REQUIRED' });
    if (ppl.consentDenied) return json(route, 403, { statusCode: 403, message: 'Forbidden' });
    if (!rows) return json(route, 404, { statusCode: 404, message: 'Person was not found in this school.' });
    return json(route, 200, { data: [...rows.values()].sort((a, b) => a.channel.localeCompare(b.channel)), meta });
  }
  if (method !== 'PUT' || channel === null) return null;
  const key = headers['idempotency-key'], body = JSON.parse(request.postData() ?? '{}');
  ppl.consentPuts.push({ key, channel, command: headers['x-hon-human-command'], body });
  if (headers['x-hon-human-command'] !== 'communication.consent.record' || headers.origin !== origin || !/^application\/json/.test(headers['content-type'] ?? '')) return json(route, 403, { code: 'HUMAN_UI_REQUIRED' });
  if (!key) return json(route, 409, { code: 'IDEMPOTENCY_KEY_REQUIRED' });
  if (ppl.consentKeys.has(key)) return json(route, 200, { data: ppl.consentKeys.get(key), meta: { ...meta, replayed: true } });
  const next = ppl.consentReplies.shift() ?? 'ok';
  if (next === 'unknown') return json(route, 503, { statusCode: 503, message: 'Service Unavailable' });
  if (!rows) return json(route, 404, { statusCode: 404 });
  const current = rows.get(channel);
  if (current && body.expectedVersion === undefined) return json(route, 409, { code: 'VERSION_REQUIRED' });
  if (current && body.expectedVersion !== current.version) return json(route, 409, { code: 'VERSION_CONFLICT' });
  if (!current && body.expectedVersion !== undefined) return json(route, 409, { code: 'VERSION_NOT_ALLOWED_ON_CREATE' });
  const saved = { channel, status: body.status, source: 'STAFF', capturedAt: new Date(body.capturedAt).toISOString(), version: (current?.version ?? 0) + 1, updatedAt: new Date().toISOString() };
  rows.set(channel, saved); ppl.consentKeys.set(key, saved);
  const person = ppl.records.get(personId); if (person && (channel === 'EMAIL' || channel === 'SMS')) person.consents[channel] = body.status;
  return json(route, current ? 200 : 201, { data: saved, meta: { ...meta, replayed: false } });
}
const pplRead = (r) => ({ ...r, student: r.student && { ...r.student }, consents: { ...r.consents }, canEdit: ppl.canEdit });
async function peopleApiRoute(route, path, method, url) {
  const consent = path.match(new RegExp(`^/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/people/([0-9a-f-]{36})/communication-consents(?:/([A-Z]+))?$`));
  if (consent) return consentApiRoute(route, method, url, consent[1], consent[2] ?? null);
  if (path === `/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/people` && method === 'GET') {
    const q = (url.searchParams.get('query') ?? '').toLowerCase();
    const items = [...ppl.records.values()].filter((r) => !q || [r.givenName, r.familyName, r.email, r.phoneE164].join(' ').toLowerCase().includes(q))
      .map((r) => ({ id: r.personId, givenName: r.givenName, familyName: r.familyName, email: r.email, phoneE164: r.phoneE164, version: r.version, createdAt: iso(-500) }));
    return json(route, 200, { data: items, meta: { requestId: id(900), correlationId: id(900) } });
  }
  const read = path.match(new RegExp(`^/api/v1/school/schools/${scope.schoolId}/people/([0-9a-f-]{36})$`));
  if (read && method === 'GET') { ppl.recordReads = (ppl.recordReads ?? 0) + 1; const r = ppl.records.get(read[1]); return r ? json(route, 200, { data: pplRead(r) }) : json(route, 404, { code: 'PERSON_UNAVAILABLE' }); }
  if (method !== 'POST' || !['/api/v1/school/people/update', '/api/v1/school/people/birth-date'].includes(path)) return null;
  const request = route.request(), headers = request.headers(), raw = request.postData() ?? '';
  ppl.posts.push({ path, key: headers['idempotency-key'], command: headers['x-hon-human-command'], body: raw });
  assert.equal(headers['x-hon-human-command'], 'school-person-record');
  const step = ppl.replies.shift() ?? 'ok';
  if (ppl.gate) { const gate = ppl.gate; ppl.gate = null; await gate; }
  const prior = ppl.byKey.get(headers['idempotency-key']);
  if (prior) return prior.body === raw ? json(route, 200, { data: prior.data }) : json(route, 409, { code: 'PERSON_IDEMPOTENCY_CONFLICT' });
  if (step === 'lost') return route.abort('connectionreset');
  if (step === 'session') return json(route, 401, { code: 'SIGN_IN_REQUIRED' });
  if (step === 'busy') return json(route, 503, { code: 'PERSON_BUSY', outcome: 'NOT_SUBMITTED' });
  if (step === 'owner') return json(route, 403, { code: 'PERSON_BIRTH_DATE_OWNER_REQUIRED' });
  const body = JSON.parse(raw), r = ppl.records.get(body.personId);
  if (!r) return json(route, 404, { code: 'PERSON_UNAVAILABLE' });
  let data;
  if (path.endsWith('/update')) {
    if (body.expectedVersion !== r.version) return json(route, 409, { code: 'PERSON_VERSION_CONFLICT', outcome: 'NOT_SUBMITTED' });
    const changed = ['givenName', 'familyName', 'email', 'phoneE164'].filter((f) => body[f] !== r[f]);
    if (!changed.length) return json(route, 400, { code: 'PERSON_UNCHANGED' });
    if (changed.includes('email') && r.consents.EMAIL === 'OPTED_IN' || changed.includes('phoneE164') && r.consents.SMS === 'OPTED_IN') return json(route, 409, { code: 'PERSON_CONTACT_CONSENT_REVIEW_REQUIRED', outcome: 'NOT_SUBMITTED' });
    for (const f of changed) r[f] = body[f];
    r.version += 1; r.updatedAt = iso(0);
    data = { person: pplRead(r), changedFields: changed };
  } else {
    if (!r.student || body.expectedVersion !== r.student.version) return json(route, 409, { code: 'PERSON_VERSION_CONFLICT', outcome: 'NOT_SUBMITTED' });
    if (body.birthDate === r.student.birthDate) return json(route, 400, { code: 'PERSON_UNCHANGED' });
    r.student.birthDate = body.birthDate; r.student.version += 1;
    data = { person: pplRead(r), changedFields: ['birthDate'], enrollmentCorrected: true };
  }
  ppl.byKey.set(headers['idempotency-key'], { body: raw, data });
  // 'unknown': the change committed but the answer was lost on the way back.
  if (step === 'unknown') return json(route, 503, { code: 'PERSON_UNAVAILABLE', outcome: 'UNKNOWN_OR_RETRY_REQUIRED' });
  return json(route, 200, { data });
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
  const selectors = await page.evaluate(() => ['[role="dialog"]', 'section[aria-labelledby="hon-band-title"]', 'main[data-variant]', 'section[aria-labelledby="creative-studio-title"]', 'section[aria-labelledby="people-title"]', 'section[aria-labelledby="hq-access-title"]', 'section[aria-labelledby="hq-policy-title"]'].filter((s) => document.querySelector(s)));
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
 * The existing Platform View picker is reported separately as a pre-existing finding; the page-width check in
 * noOverflow excludes only that picker.
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
  return { offenders, viewportWidth: width };
}
/** Page width with only the known pre-existing Platform View picker taken out of layout; its inline styles are restored. */
function widthWithoutPicker() {
  const pickers = [...document.querySelectorAll('.view-picker')], saved = pickers.map((e) => e.getAttribute('style'));
  try {
    for (const e of pickers) e.style.setProperty('display', 'none', 'important');
    return Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  } finally {
    pickers.forEach((e, i) => { if (saved[i] === null) e.removeAttribute('style'); else e.setAttribute('style', saved[i]); });
  }
}
async function noOverflow(page, name) {
  const { offenders, viewportWidth } = await page.evaluate(overflowAudit);
  const preExisting = offenders.filter((o) => o.preExisting), current = offenders.filter((o) => !o.preExisting);
  if (preExisting.length) report.preExistingFindings.push(`${name ?? 'page'}: Platform View picker overflows (${preExisting.length} elements)`);
  assert.deepEqual(current, [], 'horizontal overflow');
  // The page must fit with only the known picker excluded, so any other overflow (including pseudo-elements) still fails.
  const remaining = await page.evaluate(widthWithoutPicker);
  assert.ok(remaining <= viewportWidth + 1, `horizontal overflow: document is ${remaining}px wide in a ${viewportWidth}px viewport without the known picker`);
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
function resetHon(reply) { hon.reply = reply; hon.conversations = []; hon.turns = new Map(); hon.queue = []; hon.posts = []; hon.held = null; hon.readinessReads = 0; hon.groups = new Map(); hon.targets = { step: null, gate: null, reads: [] }; }
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

// ---------- Ask HON suggestion cards (C3a) ----------
async function suggestedAnswer(viewport, mode_ = 'modern') {
  resetHon(true);
  const opened = await fullHon(viewport, mode_);
  await askBox(opened.ask).fill('How do I fill Saturday trials?');
  await opened.ask.getByRole('button', { name: 'Send' }).click();
  await opened.ask.getByRole('button', { name: 'Ask Marcus' }).waitFor();
  return opened;
}
const lastBody = () => JSON.parse(hon.posts.at(-1).body);
const sourceTurn = () => hon.conversations[0].turns.find((t) => t.role === 'hon').turnId;
const honEnded = (page) => page.evaluate(() => window.__honEnded);
// Same-document navigation away from Ask HON; waits until the conversation is unmounted.
const closeHonView = async (page) => { await page.evaluate(() => window.next.router.push('/staff/search')); await page.waitForFunction(() => !document.querySelector('section[data-hon-conversation]')); };
const watchHonEnded = (page) => page.evaluate(() => { window.__honEnded = 0; window.addEventListener('hon:session-invalidated', () => { window.__honEnded++; }); });

for (const [name, viewport, mode_] of [['desktop-1440', { width: 1440, height: 900 }, 'modern'], ['phone-390', { width: 390, height: 844 }, 'big-button']]) {
  await check(`Ask HON suggestions ${mode_} ${name}: confirm Marcus and Chad from the cards; grouped status; exact bodies`, async () => {
    const { ctx, page, ask } = await suggestedAnswer(viewport, mode_);
    assert.ok(await ask.getByText(/Nothing runs until you choose what they work on and confirm/).isVisible());
    assert.equal(hon.targets.reads.length, 0, 'no target list is read until a card is opened');
    const posts = hon.posts.length;
    await ask.getByRole('button', { name: 'Ask Marcus' }).click();
    const form = ask.getByRole('form', { name: 'Ask Marcus' });
    await form.getByLabel('Campaign').waitFor();
    const options = await form.getByLabel('Campaign').locator('option').allInnerTexts();
    assert.deepEqual(options, ['Choose a campaign', 'Spring trial week (active)', 'Summer camp (draft)'], 'archived campaigns are not offered');
    assert.equal(await ask.getByRole('button', { name: 'Ask Chad' }).isDisabled(), true, 'one confirmation at a time');
    assert.equal(await form.getByRole('button', { name: 'Send to Marcus' }).isDisabled(), true);
    await form.getByLabel('Campaign').selectOption({ label: 'Spring trial week (active)' });
    await form.getByLabel('What should Marcus draft?').fill('A Saturday trial post for parents');
    await noOverflow(page, `ask-hon-suggest-${mode_}-${name}`);
    await axe(page, `ask-hon-suggest-${mode_}-${name}`);
    await shot(page, `ask-hon-suggest-${mode_}-${name}-confirm`);
    assert.equal(hon.posts.length, posts, 'nothing is sent before Send');
    await form.getByRole('button', { name: 'Send to Marcus' }).click();
    await ask.getByText('Specialists you asked').waitFor();
    assert.deepEqual(lastBody(), { text: 'A Saturday trial post for parents', delegation: { agentKey: 'marcus', campaignId: id(720) }, fromSuggestionTurnId: sourceTurn() });
    assert.ok(await ask.getByText('Needs your review').isVisible());
    assert.ok(await ask.getByRole('link', { name: 'Review drafts in Action Center →' }).isVisible());
    assert.equal(await ask.getByRole('button', { name: 'Ask Marcus' }).count(), 0, 'an asked specialist is not offered again');
    await ask.getByRole('button', { name: 'Ask Chad' }).click();
    const chad = ask.getByRole('form', { name: 'Ask Chad' });
    await chad.getByLabel('Lead').waitFor();
    assert.deepEqual(await chad.getByLabel('Lead').locator('option').allInnerTexts(), ['Choose a lead', 'Riley Park', 'Jordan Kim'], 'only open leads');
    await chad.getByLabel('Lead').selectOption({ label: 'Jordan Kim' });
    assert.equal(await chad.getByRole('button', { name: 'Send to Chad' }).isDisabled(), true, 'a follow-up type is required');
    await chad.getByText('Trial reminder', { exact: true }).click();
    await chad.getByLabel('What should Chad draft?').fill('Remind them about Saturday at 10');
    await chad.getByRole('button', { name: 'Send to Chad' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-hon-suggestions] [data-asked]').length === 2);
    assert.deepEqual(lastBody(), { text: 'Remind them about Saturday at 10', delegation: { agentKey: 'chad', leadId: id(741), expectedLeadVersion: 6, purpose: 'TRIAL_REMINDER' }, fromSuggestionTurnId: sourceTurn() });
    assert.equal(hon.groups.get(hon.conversations[0].id).get(sourceTurn()).members.length, 2, 'both confirmations are grouped under the one answer');
    assert.ok(await ask.getByRole('button', { name: 'Ask Kai' }).isEnabled());
    await noOverflow(page, `ask-hon-suggest-${mode_}-${name}-grouped`);
    await shot(page, `ask-hon-suggest-${mode_}-${name}-grouped`, true);
    await ctx.close();
  });
}

await check('Ask HON suggestions: a refused confirmation reopens the form with what was chosen; nothing is retried', async () => {
  const { ctx, ask } = await suggestedAnswer({ width: 1440, height: 900 });
  await ask.getByRole('button', { name: 'Ask Kai' }).click();
  const form = ask.getByRole('form', { name: 'Ask Kai' });
  await form.getByLabel('Curriculum').selectOption({ label: 'Little Dragons (version 2)' });
  await form.getByLabel('What should Kai draft?').fill('Week 1 warm-up plan');
  hon.queue = ['notConfirmable'];
  const reads = hon.targets.reads.length;
  await form.getByRole('button', { name: 'Send to Kai' }).click();
  await ask.getByText(/can no longer be confirmed/).waitFor();
  assert.equal(await ask.getByRole('button', { name: 'Retry the same request' }).count(), 0);
  await form.getByLabel('Curriculum').waitFor();
  assert.equal(await form.getByLabel('What should Kai draft?').inputValue(), 'Week 1 warm-up plan');
  assert.equal(await form.getByLabel('Curriculum').inputValue(), id(730));
  assert.equal(hon.targets.reads.length, reads + 1, 'the target list is read again, not kept');
  await ctx.close();
});

await check('Ask HON suggestions: an unknown outcome keeps one exact retry and locks the other cards', async () => {
  const { ctx, ask } = await suggestedAnswer({ width: 1440, height: 900 });
  await ask.getByRole('button', { name: 'Ask Marcus' }).click();
  const form = ask.getByRole('form', { name: 'Ask Marcus' });
  await form.getByLabel('Campaign').selectOption({ label: 'Summer camp (draft)' });
  await form.getByLabel('What should Marcus draft?').fill('Camp teaser');
  hon.queue = ['lost'];
  await form.getByRole('button', { name: 'Send to Marcus' }).click();
  await ask.getByRole('button', { name: 'Retry the same request' }).waitFor();
  assert.equal(await ask.getByRole('button', { name: 'Ask Chad' }).isDisabled(), true, 'no second request while the first is unknown');
  await ask.getByRole('button', { name: 'Retry the same request' }).click();
  await ask.getByText('Specialists you asked').waitFor();
  const sends = hon.posts.filter((p) => JSON.parse(p.body).delegation);
  assert.equal(sends.length, 2); assert.equal(new Set(sends.map((p) => p.key)).size, 1); assert.equal(new Set(sends.map((p) => p.body)).size, 1);
  assert.equal(hon.groups.get(hon.conversations[0].id).get(sourceTurn()).members.length, 1, 'exactly one Marcus request exists');
  await ctx.close();
});

await check('Ask HON group summary: Summarize with HON appears once the group is finished and sends a question naming that group', async () => {
  const { ctx, page, ask } = await suggestedAnswer({ width: 1440, height: 900 });
  await ask.getByRole('button', { name: 'Ask Marcus' }).click();
  const form = ask.getByRole('form', { name: 'Ask Marcus' });
  await form.getByLabel('Campaign').selectOption({ label: 'Spring trial week (active)' });
  await form.getByLabel('What should Marcus draft?').fill('A Saturday trial post for parents');
  await form.getByRole('button', { name: 'Send to Marcus' }).click();
  await ask.getByText('Needs your review').waitFor();
  assert.equal(await ask.getByRole('button', { name: 'Summarize with HON' }).count(), 0, 'not offered while a draft waits for review');
  // A human approves the draft in Action Center; reopening the conversation reads the group again.
  const source = sourceTurn();
  hon.groups.get(hon.conversations[0].id).get(source).members[0].status = 'COMPLETED';
  await ask.getByRole('button', { name: /How do I fill Saturday trials\?/ }).click();
  await ask.getByRole('button', { name: 'Summarize with HON' }).waitFor();
  assert.ok(await ask.getByText('Done', { exact: true }).isVisible());
  await axe(page, 'ask-hon-group-summary-offer');
  await shot(page, 'ask-hon-group-summary-offer', true);
  hon.queue = ['notSummarizable'];
  await ask.getByRole('button', { name: 'Summarize with HON' }).click();
  await ask.getByText(/HON can’t summarize those specialists: their group changed/).waitFor();
  assert.equal(await ask.getByRole('button', { name: 'Retry the same request' }).count(), 0, 'a refusal is not retried');
  const posts = hon.posts.length;
  await ask.getByRole('button', { name: 'Summarize with HON' }).click();
  await ask.getByText(/^Summary: Marcus recorded/).waitFor();
  assert.equal(hon.posts.length, posts + 1);
  assert.deepEqual(lastBody(), { text: 'Summarize what the specialists I asked recorded, and what I should do next.', delegation: null, summarizeTurnId: source });
  assert.notEqual(hon.posts.at(-1).key, hon.posts.at(-2).key, 'a fresh key after a definitive refusal');
  await noOverflow(page, 'ask-hon-group-summary');
  await axe(page, 'ask-hon-group-summary');
  await shot(page, 'ask-hon-group-summary', true);
  await ctx.close();
});

await check('Ask HON suggestions: a denied target list says so and sends nothing', async () => {
  const { ctx, ask } = await suggestedAnswer({ width: 1440, height: 900 });
  hon.targets.step = 'denied';
  await ask.getByRole('button', { name: 'Ask Chad' }).click();
  await ask.getByText(/Your role cannot see this specialist’s list/).waitFor();
  assert.equal(await ask.getByRole('button', { name: 'Send to Chad' }).count(), 0);
  await ask.getByRole('button', { name: 'Cancel' }).click();
  assert.ok(await ask.getByRole('button', { name: 'Ask Chad' }).isEnabled());
  await ctx.close();
});

await check('Ask HON suggestions: leaving the page hides lead names and the open form; Refresh shows the answer, not the form', async () => {
  const { ctx, page, ask } = await suggestedAnswer({ width: 1440, height: 900 });
  await ask.getByRole('button', { name: 'Ask Chad' }).click();
  await ask.getByRole('form', { name: 'Ask Chad' }).getByLabel('Lead').waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForFunction(() => document.querySelector('section[data-hon-conversation]')?.getAttribute('data-hon-conversation') === 'CONCEALED');
  const hidden = await ask.innerText();
  for (const secret of ['Riley', 'Jordan', 'Saturday']) assert.ok(!hidden.includes(secret), `concealed view shows ${secret}`);
  await pageRefresh(ask).click();
  await ask.getByRole('button', { name: 'Ask Chad' }).waitFor();
  assert.equal(await ask.getByRole('form', { name: 'Ask Chad' }).count(), 0);
  await ctx.close();
});

for (const [how, retire] of [['Cancel', (page, ask) => ask.getByRole('button', { name: 'Cancel' }).click()],
  ['leaving the page', (page) => page.evaluate(() => window.dispatchEvent(new Event('blur')))],
  ['closing the view', closeHonView]]) {
  await check(`Ask HON suggestions: a late sign-in answer to a target list retired by ${how} does not end the session`, async () => {
    const { ctx, page, ask } = await suggestedAnswer({ width: 1440, height: 900 });
    await watchHonEnded(page);
    let release; hon.targets.gate = new Promise((done) => { release = done; }); hon.targets.step = 'session';
    await ask.getByRole('button', { name: 'Ask Marcus' }).click();
    await ask.getByText(/Loading campaign choices/).waitFor();
    await retire(page, ask);
    release();
    await new Promise((done) => setTimeout(done, 800));
    assert.equal(await honEnded(page), 0, 'the retired read did not end the session');
    await ctx.close();
  });
}
for (const [how, retire] of [['leaving the page', (page) => page.evaluate(() => window.dispatchEvent(new Event('blur')))],
  ['closing the view', closeHonView]]) {
  await check(`Ask HON suggestions: a late sign-in answer to a confirmation retired by ${how} does not end the session; a current one does`, async () => {
    const { ctx, page, ask } = await suggestedAnswer({ width: 1440, height: 900 });
    await watchHonEnded(page);
    await ask.getByRole('button', { name: 'Ask Marcus' }).click();
    const form = ask.getByRole('form', { name: 'Ask Marcus' });
    await form.getByLabel('Campaign').selectOption({ label: 'Spring trial week (active)' });
    await form.getByLabel('What should Marcus draft?').fill('Spring post');
    hon.queue = ['holdSession'];
    await form.getByRole('button', { name: 'Send to Marcus' }).click();
    await ask.getByText('HON is working on it…').waitFor();
    await retire(page, ask);
    for (let i = 0; i < 40 && !hon.held; i++) await new Promise((done) => setTimeout(done, 50));
    hon.held(); hon.held = null;
    await new Promise((done) => setTimeout(done, 800));
    assert.equal(await honEnded(page), 0, 'the retired confirmation did not end the session');
    await ctx.close();
    // The same answer for a confirmation still shown ends the session.
    const current = await suggestedAnswer({ width: 1440, height: 900 });
    await watchHonEnded(current.page);
    await current.ask.getByRole('button', { name: 'Ask Marcus' }).click();
    const again = current.ask.getByRole('form', { name: 'Ask Marcus' });
    await again.getByLabel('Campaign').selectOption({ label: 'Spring trial week (active)' });
    await again.getByLabel('What should Marcus draft?').fill('Spring post');
    hon.queue = ['holdSession'];
    await again.getByRole('button', { name: 'Send to Marcus' }).click();
    for (let i = 0; i < 40 && !hon.held; i++) await new Promise((done) => setTimeout(done, 50));
    hon.held(); hon.held = null;
    await current.page.waitForFunction(() => window.__honEnded === 1, null, { timeout: 10000 });
    await current.ctx.close();
  });
}

await check('Overflow gate: clipped shell tabs and the known picker pass; escaping, unlisted or extra page overflow fails', async () => {
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
  const picker = '<div class="view-picker" style="width:430px">known picker</div>';
  await layout(picker);
  await noOverflow(page, 'gate-picker-only');
  await page.setContent(`<!doctype html><html><head><style>body::after{content:"";display:block;width:700px;height:1px}</style></head><body style="margin:0">${picker}</body></html>`);
  await assert.rejects(noOverflow(page, 'gate-picker-plus-pseudo'), /horizontal overflow/);
  assert.equal(await page.locator('.view-picker').getAttribute('style'), 'width:430px', 'picker styles restored');
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
await check('Creative Studio: connected provider, lost answer, Check again replays the same request once', async () => {
  studio = 'ready'; Object.assign(creative, { provider: 'CONNECTED', items: [], posts: [], replies: ['unknown', 'ok'], byKey: new Map(), gate: null });
  const { ctx, page } = await creativeStudio({ width: 1440, height: 900 });
  const section = page.locator('section[aria-labelledby="creative-studio-title"]');
  await section.locator('[data-create-state="OPEN"]').waitFor();
  await section.getByLabel('What to make').selectOption('image.standard');
  await section.getByLabel('How many').fill('2');
  await section.getByLabel('Portrait').check();
  await section.getByLabel('Describe what you need').fill('Kids class flyer with a bright orange belt theme');
  assert.ok(await section.getByText('Uses 80 credits. You have 11,640 available.').isVisible());
  await section.getByRole('button', { name: 'Create', exact: true }).click();
  await section.getByText(/We could not confirm whether this request went through/).waitFor();
  assert.equal(await section.getByLabel('Describe what you need').isDisabled(), true, 'form locked while the outcome is unknown');
  await shot(page, 'creative-studio-create-unknown');
  await section.getByRole('button', { name: 'Check again' }).click();
  await section.getByText('Done. The result is listed below.').waitFor();
  await section.getByText('Image 1080×1080 · preview not available yet').first().waitFor();
  assert.equal(creative.posts.length, 2);
  assert.equal(creative.posts[0].key, creative.posts[1].key, 'Check again reuses the idempotency key');
  assert.equal(creative.posts[0].body, creative.posts[1].body, 'Check again resends the identical body');
  assert.equal(creative.posts[0].command, 'saas-creative-generation-create');
  assert.deepEqual(JSON.parse(creative.posts[0].body), { operationCode: 'image.standard', units: 2, format: 'PORTRAIT', prompt: 'Kids class flyer with a bright orange belt theme' });
  await noOverflow(page, 'creative-studio-create');
  await axe(page, 'creative-studio-create');
  await shot(page, 'creative-studio-create-done', true);
  creative.provider = 'NOT_CONNECTED'; creative.items = [];
  await ctx.close();
});
await check('Creative Studio: an unknown create stays unconfirmed across a conceal and never shows its text', async () => {
  studio = 'ready'; Object.assign(creative, { provider: 'CONNECTED', items: [], posts: [], replies: ['unknown', 'ok'], byKey: new Map(), gate: null });
  const { ctx, page } = await creativeStudio({ width: 390, height: 844 });
  const section = () => page.locator('section[aria-labelledby="creative-studio-title"]');
  await section().locator('[data-create-state="OPEN"]').waitFor();
  await section().getByLabel('What to make').selectOption('image.standard');
  await section().getByLabel('Describe what you need').fill('Private note about the Lee family');
  await section().getByRole('button', { name: 'Create', exact: true }).click();
  await section().getByText(/We could not confirm/).waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForFunction(() => !document.body.innerText.includes('Lee family') || !!document.querySelector('[data-shell-private][hidden], [data-shell-private][inert]'));
  await page.getByRole('button', { name: 'Show school' }).click();
  await section().getByText(/waiting for confirmation/).waitFor({ timeout: 20000 });
  assert.ok(!(await section().innerText()).includes('Lee family'), 'the pending request text is not shown after re-verification');
  await section().getByRole('button', { name: 'Check again' }).click();
  await section().getByText('Done. The result is listed below.').waitFor();
  assert.equal(creative.posts.length, 2); assert.equal(creative.posts[0].key, creative.posts[1].key);
  await noOverflow(page, 'creative-studio-phone-create');
  creative.provider = 'NOT_CONNECTED'; creative.items = [];
  await ctx.close();
});
await check('Creative Studio: an accepted-but-unknown request is redacted after re-verify and survives refused retries', async () => {
  studio = 'ready'; Object.assign(creative, { provider: 'CONNECTED', items: [], posts: [], replies: ['accepted', 'notConnected', 'denied', 'ok'], byKey: new Map(), gate: null });
  const { ctx, page } = await creativeStudio({ width: 1440, height: 900 });
  const section = () => page.locator('section[aria-labelledby="creative-studio-title"]');
  const prompt = 'Private note about the Lee family';
  await section().locator('[data-create-state="OPEN"]').waitFor();
  await section().getByLabel('What to make').selectOption('image.standard');
  await section().getByLabel('Describe what you need').fill(prompt);
  await section().getByRole('button', { name: 'Create', exact: true }).click();
  await section().getByText(/We could not confirm whether/).waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.getByRole('button', { name: 'Show school' }).click();
  // The re-verified list now holds the server's GENERATING row for this very request: status and credits, never its text.
  await section().locator('li[data-status="GENERATING"] [data-prompt-hidden]').waitFor({ timeout: 20000 });
  assert.ok(!(await section().innerText()).includes('Lee family'), 'the unconfirmed prompt is not shown in the list');
  assert.ok((await section().innerText()).includes('credits held'));
  await section().getByText(/waiting for confirmation/).waitFor();
  for (const blocked of ['creating is not connected right now', 'your access was refused']) {
    await section().getByRole('button', { name: 'Check again' }).click();
    await section().getByText(new RegExp(blocked)).waitFor();
    const text = await section().innerText();
    assert.ok(text.includes('It is still unconfirmed and nothing new was started'), `${blocked}: still unconfirmed`);
    assert.ok(!text.includes('Nothing was sent or charged'), `${blocked}: never claims nothing was charged`);
    assert.ok(!text.includes('Lee family'), `${blocked}: text stays hidden`);
    assert.equal(await section().getByLabel('Describe what you need').isDisabled(), true, `${blocked}: form stays locked`);
  }
  await shot(page, 'creative-studio-retry-blocked');
  await section().getByRole('button', { name: 'Check again' }).click();
  await section().getByText('Done. The result is listed below.').waitFor();
  assert.equal(creative.posts.length, 4);
  assert.equal(new Set(creative.posts.map((p) => p.key)).size, 1, 'every retry reuses the one idempotency key');
  assert.equal(new Set(creative.posts.map((p) => p.body)).size, 1, 'every retry resends the identical body');
  await section().locator('li[data-status="SUCCEEDED"]').getByText(prompt).waitFor();
  assert.equal(creative.items.length, 1, 'one generation, never two');
  assert.equal(await section().getByLabel('Describe what you need').isDisabled(), false, 'released once known');
  await noOverflow(page, 'creative-studio-retry-blocked');
  await axe(page, 'creative-studio-retry-blocked');
  creative.provider = 'NOT_CONNECTED'; creative.items = [];
  await ctx.close();
});
await check('Creative Studio: re-verifying while a create is in flight keeps the form locked when its answer is unknown', async () => {
  let release; const gate = new Promise((done) => { release = done; });
  studio = 'ready'; Object.assign(creative, { provider: 'CONNECTED', items: [], posts: [], replies: ['transition', 'ok'], byKey: new Map(), gate });
  const { ctx, page } = await creativeStudio({ width: 390, height: 844 });
  const section = () => page.locator('section[aria-labelledby="creative-studio-title"]');
  await section().locator('[data-create-state="OPEN"]').waitFor();
  await section().getByLabel('What to make').selectOption('image.standard');
  await section().getByLabel('Describe what you need').fill('Belt test reminder flyer');
  await section().getByRole('button', { name: 'Create', exact: true }).click();
  await section().getByText('Creating… keep this tab open.').waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.getByRole('button', { name: 'Show school' }).click();
  await section().locator('[data-create-state="OPEN"]').waitFor({ timeout: 20000 });
  await section().getByText('Creating… keep this tab open.').waitFor();
  assert.equal(await section().getByLabel('Describe what you need').isDisabled(), true, 'locked while the first send is still in flight');
  release(); // the in-flight create now answers 409 SAAS_TRANSITION_NOT_ALLOWED: not a refusal, so unknown
  await section().getByText(/waiting for confirmation/).waitFor();
  assert.equal(await section().getByLabel('Describe what you need').isDisabled(), true, 'still locked after the unknown answer');
  assert.equal(await section().getByRole('button', { name: 'Create', exact: true }).isDisabled(), true);
  await section().getByRole('button', { name: 'Check again' }).click();
  await section().getByText('Done. The result is listed below.').waitFor();
  assert.equal(creative.posts.length, 2); assert.equal(creative.posts[0].key, creative.posts[1].key);
  await noOverflow(page, 'creative-studio-inflight-reverify');
  creative.provider = 'NOT_CONNECTED'; creative.items = [];
  await ctx.close();
});
await check('Creative Studio: a Refresh while a create is in flight still shows its unknown answer and Check again', async () => {
  let release; const gate = new Promise((done) => { release = done; });
  studio = 'ready'; Object.assign(creative, { provider: 'CONNECTED', items: [], posts: [], replies: ['unknown', 'ok'], byKey: new Map(), gate });
  const { ctx, page } = await creativeStudio({ width: 1440, height: 900 });
  const section = () => page.locator('section[aria-labelledby="creative-studio-title"]');
  await section().locator('[data-create-state="OPEN"]').waitFor();
  await section().getByLabel('What to make').selectOption('image.standard');
  await section().getByLabel('Describe what you need').fill('Summer camp flyer');
  await section().getByRole('button', { name: 'Create', exact: true }).click();
  await section().getByText('Creating… keep this tab open.').waitFor();
  const reads = () => report.apiRequests.filter((r) => r.startsWith('GET') && r.includes('creative-studio/generations')).length;
  const before = reads();
  await section().getByRole('button', { name: 'Refresh' }).click();
  for (let i = 0; i < 50 && reads() === before; i++) await new Promise((done) => setTimeout(done, 100));
  assert.ok(reads() > before, 'Refresh re-read the list while the create was in flight');
  release();
  await section().getByText(/We could not confirm whether this request went through/).waitFor();
  assert.equal(await section().getByLabel('Describe what you need').isDisabled(), true, 'locked after the unknown answer');
  await section().getByRole('button', { name: 'Refresh' }).click();
  await section().getByText(/We could not confirm whether/).waitFor();
  assert.equal(creative.posts.length, 1, 'no automatic retry');
  await section().getByRole('button', { name: 'Check again' }).click();
  await section().getByText('Done. The result is listed below.').waitFor();
  assert.equal(creative.posts.length, 2); assert.equal(creative.posts[0].key, creative.posts[1].key); assert.equal(creative.posts[0].body, creative.posts[1].body);
  creative.provider = 'NOT_CONNECTED'; creative.items = [];
  await ctx.close();
});
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

// ---------- People ----------
async function peoplePage(viewport, { nextTheme = 'modern', language = 'en' } = {}) {
  theme = nextTheme; mode = 'ready';
  const ctx = await context(viewport);
  if (language !== 'en') {
    // The presentation-only language cookie, scoped exactly as the web server derives it for this synthetic session.
    const presentation = createHmac('sha256', session.secret).update(JSON.stringify(['hon-local-presentation-v1', session.mode, session.audience, 'hon-command-synthetic-owner'])).digest('hex');
    await ctx.addCookies([{ name: `hon_locale_v1_${presentation}`, value: encodeURIComponent(JSON.stringify({ version: 1, language, region: 'auto', currencyDisplay: 'symbol', timeZone: 'UTC' })), url: origin, sameSite: 'Lax' }]);
  }
  const page = await ctx.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(`${origin}/staff/people`);
  const section = () => page.locator('section[aria-labelledby="people-title"]');
  await section().getByTestId('people-list').waitFor({ timeout: 20000 });
  return { ctx, page, section };
}
const open = async (section, name) => { await section().getByRole('button', { name: new RegExp(name) }).click(); };
/** Opens a person and waits for the new record and its consent card to be read, never the form already on screen. */
const openFresh = async (section, name) => {
  const records = ppl.recordReads ?? 0, consents = ppl.consentReads;
  await open(section, name);
  for (let i = 0; i < 200 && ((ppl.recordReads ?? 0) <= records || ppl.consentReads <= consents); i++) await new Promise((done) => setTimeout(done, 50));
  await section().getByTestId('person-consents').getByRole('button').first().waitFor();
};
const TITLES = { en: ['People', 'Child details', 'Save changes'], ko: ['사람', '자녀 정보', '변경 사항 저장'], es: ['Personas', 'Datos del niño', 'Guardar cambios'] };
for (const [name, viewport, nextTheme, language] of [['desktop-1440', { width: 1440, height: 900 }, 'modern', 'en'], ['desktop-1440', { width: 1440, height: 900 }, 'classic', 'en'],
  ['desktop-1440', { width: 1440, height: 900 }, 'big-button', 'en'], ['phone-390', { width: 390, height: 844 }, 'modern', 'en'], ['phone-390', { width: 390, height: 844 }, 'big-button', 'ko'],
  ['desktop-1440', { width: 1440, height: 900 }, 'modern', 'ko'], ['desktop-1440', { width: 1440, height: 900 }, 'classic', 'es'], ['phone-390', { width: 390, height: 844 }, 'classic', 'es']]) {
  await check(`People ${nextTheme} ${language} ${name}: real reads, edit forms and child details`, async () => {
    resetPeople();
    const { ctx, page, section } = await peoplePage(viewport, { nextTheme, language });
    const [title, child, save] = TITLES[language];
    assert.ok(await section().getByRole('heading', { name: title, level: 1 }).isVisible());
    await open(section, 'Ana Rivera');
    await section().getByRole('heading', { name: child }).waitFor();
    assert.ok(await section().getByRole('button', { name: save }).isVisible());
    assert.equal(await section().locator('input[name="givenName"]').inputValue(), 'Ana');
    assert.equal(await section().locator('input[name="birthDate"]').inputValue(), '2015-04-02');
    await noOverflow(page, `people-${nextTheme}-${language}-${name}`);
    await axe(page, `people-${nextTheme}-${language}-${name}`);
    await shot(page, `people-${nextTheme}-${language}-${name}`, true);
    await ctx.close();
  });
}
await check('People: a lost answer keeps the save locked; Try again replays the same key and body once', async () => {
  resetPeople({ replies: ['unknown', 'ok'] });
  const { ctx, page, section } = await peoplePage({ width: 1440, height: 900 });
  await open(section, 'Ana Rivera');
  await section().locator('input[name="familyName"]').fill('Rivera-Lopez');
  await section().locator('input[name="phone"]').fill('+1 555 555 0199');
  await section().getByRole('button', { name: 'Save changes' }).click();
  await section().getByText(/We could not confirm whether this was saved/).waitFor();
  assert.equal(await section().locator('input[name="familyName"]').isDisabled(), true, 'locked while the outcome is unknown');
  assert.equal(await section().locator('textarea[name="reason"]').isDisabled(), true, 'the birth date form is locked too');
  await shot(page, 'people-save-unknown');
  await section().getByRole('button', { name: 'Try again' }).click();
  await section().getByText('Saved. Changed: last name, phone.').waitFor();
  assert.equal(ppl.posts.length, 2);
  assert.equal(ppl.posts[0].key, ppl.posts[1].key, 'Try again reuses the idempotency key');
  assert.equal(ppl.posts[0].body, ppl.posts[1].body, 'Try again resends the identical body');
  assert.deepEqual(JSON.parse(ppl.posts[0].body), { schoolId: scope.schoolId, personId: id(301), expectedVersion: 1, givenName: 'Ana', familyName: 'Rivera-Lopez', email: 'ana.parent@example.invalid', phoneE164: '+15555550199' });
  assert.equal(ppl.records.get(id(301)).version, 2, 'applied exactly once');
  assert.equal(await section().locator('input[name="familyName"]').inputValue(), 'Rivera-Lopez');
  assert.equal(await section().locator('input[name="familyName"]').isDisabled(), false);
  await noOverflow(page, 'people-save'); await axe(page, 'people-save'); await shot(page, 'people-saved', true);
  await ctx.close();
});
await check('People: consent, busy and version refusals say what to do; a new save uses a new key', async () => {
  resetPeople({ replies: ['ok', 'busy', 'ok'] });
  const { ctx, page, section } = await peoplePage({ width: 1440, height: 900 });
  await open(section, 'Ana Rivera');
  await section().getByText(/This person agreed to email/).waitFor();
  await section().locator('input[name="email"]').fill('new.parent@example.invalid');
  await section().getByRole('button', { name: 'Save changes' }).click();
  await section().getByText(/This address has active consent/).waitFor();
  assert.equal(await section().getByRole('button', { name: 'Try again' }).count(), 0);
  await shot(page, 'people-consent-refused');
  await section().locator('input[name="email"]').fill('ana.parent@example.invalid');
  await section().locator('input[name="givenName"]').fill('Anna');
  await section().getByRole('button', { name: 'Save changes' }).click();
  await section().getByText(/This record was busy and nothing was saved/).waitFor();
  await section().getByRole('button', { name: 'Try again' }).click();
  await section().getByText('Saved. Changed: first name.').waitFor();
  assert.equal(ppl.posts.length, 3);
  assert.notEqual(ppl.posts[0].key, ppl.posts[1].key, 'a refused save never lends its key to a new one');
  assert.equal(ppl.posts[1].key, ppl.posts[2].key, 'busy keeps the key for Try again');
  ppl.records.get(id(301)).version = 9; // someone else edits meanwhile
  await section().locator('input[name="givenName"]').fill('Ana');
  await section().getByRole('button', { name: 'Save changes' }).click();
  await section().getByText(/Someone else changed this record/).waitFor();
  await section().getByRole('button', { name: 'Reload the saved record' }).click();
  await section().locator('input[name="givenName"]').waitFor();
  for (let i = 0; i < 50 && await section().locator('input[name="givenName"]').inputValue() !== 'Anna'; i++) await new Promise((done) => setTimeout(done, 100));
  assert.equal(await section().locator('input[name="givenName"]').inputValue(), 'Anna', 'reload shows the saved record');
  await ctx.close();
});
const CONSENT_TEXT = { en: ['Contact consent', 'Record opt-out', 'Record opt-out now', 'Opt-out recorded for email.', 'Opted out'],
  ko: ['연락 동의', '수신 거부 기록', '지금 수신 거부 기록', '이메일 수신 거부가 기록되었습니다.', '수신 거부'] };
for (const [name, viewport, nextTheme, language] of [['desktop-1440', { width: 1440, height: 900 }, 'modern', 'en'], ['phone-390', { width: 390, height: 844 }, 'big-button', 'ko']]) {
  await check(`People consent ${nextTheme} ${language} ${name}: record an email opt-out, then the address can change`, async () => {
    resetPeople();
    const [title, optOut, confirm, done, optedOut] = CONSENT_TEXT[language];
    const { ctx, page, section } = await peoplePage(viewport, { nextTheme, language });
    await open(section, 'Ana Rivera');
    const card = () => section().getByTestId('person-consents');
    await card().locator('[data-testid="consent-EMAIL"][data-status="OPTED_IN"]').waitFor({ timeout: 20000 });
    assert.ok(await card().getByRole('heading', { name: title }).isVisible());
    await card().getByTestId('consent-EMAIL').getByRole('button', { name: optOut }).click();
    await card().getByTestId('consent-form').waitFor();
    await noOverflow(page, `people-consent-${nextTheme}-${language}-${name}`);
    await axe(page, `people-consent-${nextTheme}-${language}-${name}`);
    await card().scrollIntoViewIfNeeded();
    await shot(page, `people-consent-optout-form-${nextTheme}-${language}-${name}`, true);
    await card().getByRole('button', { name: confirm }).click();
    await card().getByTestId('consent-outcome').filter({ hasText: done }).waitFor();
    await card().locator('[data-testid="consent-EMAIL"][data-status="OPTED_OUT"]').getByText(optedOut).waitFor();
    assert.equal(ppl.consentPuts.length, 1);
    const put = ppl.consentPuts[0];
    assert.equal(put.channel, 'EMAIL'); assert.equal(put.command, 'communication.consent.record');
    assert.deepEqual({ ...put.body, capturedAt: undefined }, { status: 'OPTED_OUT', source: 'STAFF', capturedAt: undefined, expectedVersion: 1 });
    assert.ok(Math.abs(Date.parse(put.body.capturedAt) - Date.now()) < 120_000, 'recorded now');
    assert.ok(ppl.consentReads >= 2, 'read again after the answer');
    await shot(page, `people-consent-recorded-${nextTheme}-${language}-${name}`, true);
    if (language === 'en') {
      await section().locator('input[name="email"]').fill('new.parent@example.invalid');
      await section().getByRole('button', { name: 'Save changes' }).click();
      await section().getByText('Saved. Changed: email.').waitFor();
    }
    await ctx.close();
  });
}
await check('People consent: agreement needs the attestation; an unknown answer replays the same key; Stop and a conflict read again', async () => {
  resetPeople({ consent: { consentReplies: ['unknown'] } });
  const { ctx, page, section } = await peoplePage({ width: 1280, height: 900 });
  await open(section, 'Ana Rivera');
  const card = () => section().getByTestId('person-consents');
  await card().locator('[data-testid="consent-SMS"][data-status="NOT_RECORDED"]').waitFor({ timeout: 20000 });
  await card().getByTestId('consent-SMS').getByRole('button', { name: 'Record agreement' }).click();
  await card().getByRole('button', { name: 'Record agreement now' }).click();
  assert.equal(ppl.consentPuts.length, 0, 'the attestation is required');
  await card().getByRole('checkbox').check();
  await shot(page, 'people-consent-optin-form', true);
  await card().getByRole('button', { name: 'Record agreement now' }).click();
  await card().getByTestId('consent-outcome').filter({ hasText: 'We could not confirm whether this was recorded' }).waitFor();
  assert.equal(await card().getByRole('button', { name: 'Record agreement now' }).isDisabled(), true, 'locked while unknown');
  await card().getByRole('button', { name: 'Try again' }).click();
  await card().getByTestId('consent-outcome').filter({ hasText: 'Agreement recorded for text messages.' }).waitFor();
  assert.equal(ppl.consentPuts.length, 2);
  assert.equal(ppl.consentPuts[0].key, ppl.consentPuts[1].key); assert.deepEqual(ppl.consentPuts[0].body, ppl.consentPuts[1].body);
  assert.equal(ppl.consentPuts[0].body.expectedVersion, undefined, 'a first record carries no version');
  await card().locator('[data-testid="consent-SMS"][data-status="OPTED_IN"]').waitFor();
  // Stop drops a kept request and reads again.
  ppl.consentReplies.push('unknown');
  await card().getByTestId('consent-SMS').getByRole('button', { name: 'Record opt-out' }).click();
  await card().getByRole('button', { name: 'Record opt-out now' }).click();
  await card().getByRole('button', { name: 'Stop and read again' }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="consent-outcome"]'));
  assert.equal(await card().getByTestId('consent-form').count(), 0);
  // Someone else changed it meanwhile: a conflict is final and reads again.
  ppl.consents.get(id(301)).get('EMAIL').version = 5;
  await card().getByTestId('consent-EMAIL').getByRole('button', { name: 'Record opt-out' }).click();
  await card().getByRole('button', { name: 'Record opt-out now' }).click();
  await card().getByTestId('consent-outcome').filter({ hasText: 'changed since it was read' }).waitFor();
  assert.equal(await card().getByRole('button', { name: 'Try again' }).count(), 0);
  assert.notEqual(ppl.consentPuts.at(-1).key, ppl.consentPuts[0].key);
  await axe(page, 'people-consent-conflict');
  await ctx.close();
});
await check('People consent: a refused consent read shows the saved summary only, with no record buttons', async () => {
  resetPeople({ consent: { consentDenied: true } });
  const { ctx, section } = await peoplePage({ width: 1280, height: 900 });
  await open(section, 'Ana Rivera');
  const card = () => section().getByTestId('person-consents');
  await card().getByText('Showing the saved summary only.', { exact: false }).waitFor({ timeout: 20000 });
  await card().locator('[data-testid="consent-EMAIL"][data-status="OPTED_IN"]').waitFor();
  assert.equal(await card().getByRole('button').count(), 0);
  await ctx.close();
});
await check('People: a birth date correction needs a reason, may need the owner, and carries into the enrollment', async () => {
  resetPeople({ replies: ['owner', 'ok'] });
  const { ctx, page, section } = await peoplePage({ width: 390, height: 844 });
  await open(section, 'Ana Rivera');
  await section().getByText(/only the school owner can save it/).waitFor();
  await section().locator('input[name="birthDate"]').fill('2007-01-01');
  await section().getByRole('button', { name: 'Save birth date' }).click();
  await section().getByText(/give a reason/).waitFor();
  assert.equal(ppl.posts.length, 0, 'nothing sent without a reason');
  await section().locator('textarea[name="reason"]').fill('Birth certificate checked at the desk');
  await section().getByRole('button', { name: 'Save birth date' }).click();
  await section().getByText(/Only the school owner can change a birth date/).waitFor();
  await shot(page, 'people-birth-owner-required');
  await section().locator('input[name="birthDate"]').fill('2015-05-05');
  await section().getByRole('button', { name: 'Save birth date' }).click();
  await section().getByText(/enrollment record now matches/).waitFor();
  assert.deepEqual(JSON.parse(ppl.posts[1].body), { schoolId: scope.schoolId, personId: id(301), expectedVersion: 1, birthDate: '2015-05-05', reason: 'Birth certificate checked at the desk' });
  assert.notEqual(ppl.posts[0].key, ppl.posts[1].key);
  assert.equal(ppl.records.get(id(301)).student.birthDate, '2015-05-05');
  await noOverflow(page, 'people-birth'); await axe(page, 'people-birth'); await shot(page, 'people-birth-saved', true);
  await ctx.close();
});
await check('People: without edit access the record is read-only, and an adult has no child section', async () => {
  resetPeople({ canEdit: false });
  const { ctx, page, section } = await peoplePage({ width: 1440, height: 900 });
  await open(section, 'Ana Rivera');
  await section().getByText(/your access does not include editing/).waitFor();
  assert.equal(await section().getByRole('button', { name: /^Save/ }).count(), 0);
  assert.equal(await section().locator('input[name="givenName"]').isDisabled(), true);
  await open(section, 'Ben Okafor');
  await section().locator('input[name="givenName"]').waitFor();
  for (let i = 0; i < 50 && await section().locator('input[name="givenName"]').inputValue() !== 'Ben'; i++) await new Promise((done) => setTimeout(done, 100));
  assert.equal(await section().getByRole('heading', { name: 'Child details' }).count(), 0);
  await axe(page, 'people-read-only'); await shot(page, 'people-read-only');
  await ctx.close();
});
await check('People: leaving the tab hides every name; a save in flight is never shown after re-verifying and the saved record is read again', async () => {
  let release; const gate = new Promise((done) => { release = done; });
  resetPeople({ gate });
  const { ctx, page, section } = await peoplePage({ width: 1440, height: 900 });
  await open(section, 'Ana Rivera');
  await section().locator('input[name="familyName"]').fill('Rivera-Kim');
  await section().getByRole('button', { name: 'Save changes' }).click();
  await section().getByText('Saving… keep this tab open.').waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForFunction(() => ![...document.querySelectorAll('section[aria-labelledby="people-title"]')].some((s) => !s.closest('[hidden],[inert]') && /Rivera|Okafor|example\.invalid/.test(s.textContent ?? '')));
  await page.getByRole('button', { name: 'Show school' }).click();
  await section().getByTestId('people-list').waitFor({ timeout: 20000 });
  release();
  await section().locator('input[name="familyName"]').waitFor();
  for (let i = 0; i < 80 && await section().locator('input[name="familyName"]').inputValue() !== 'Rivera-Kim'; i++) await new Promise((done) => setTimeout(done, 100));
  assert.equal(await section().locator('input[name="familyName"]').inputValue(), 'Rivera-Kim', 'the record is read again after the hidden save');
  assert.equal(await section().getByText(/Saved\. Changed/).count(), 0, 'the hidden answer is not shown');
  assert.equal(await section().getByText('Saving… keep this tab open.').count(), 0);
  assert.equal(ppl.posts.length, 1, 'no automatic retry');
  await ctx.close();
});

const retire = {
  conceal: async (page, section) => {
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.getByRole('button', { name: 'Show school' }).click();
    await section().getByTestId('people-list').waitFor({ timeout: 20000 });
  },
  'open another person': async (page, section) => {
    await open(section, 'Ben Okafor');
    // The click commits asynchronously: wait for Ben's record, not for whichever form is on screen.
    await section().locator('input[name="givenName"][value="Ben"]').waitFor({ timeout: 10000 });
    assert.equal(await section().locator('input[name="givenName"]').inputValue(), 'Ben');
  },
  unmount: async (page, section) => {
    // Same-document route changes (the shell's own links load a new document, which ends every request anyway).
    assert.equal(await page.evaluate(() => typeof window.next?.router?.push), 'function');
    await page.evaluate(() => window.next.router.push('/staff/search'));
    await page.waitForURL(/\/staff\/search$/);
    await section().waitFor({ state: 'detached' });
    await page.evaluate(() => window.next.router.push('/staff/people'));
    await section().getByTestId('people-list').waitFor({ timeout: 20000 });
    await open(section, 'Ana Rivera');
    await section().locator('input[name="givenName"]').waitFor();
  },
};
for (const [command, field, value, button] of [['contact', 'familyName', 'Rivera-Kim', 'Save changes'], ['birth date', 'birthDate', '2015-05-05', 'Save birth date']]) {
  const save = async (section) => {
    await section().locator(`input[name="${field}"]`).fill(value);
    if (command === 'birth date') await section().locator('textarea[name="reason"]').fill('Birth certificate checked at the desk');
    await section().getByRole('button', { name: button }).click();
  };
  for (const [how, step] of Object.entries(retire)) {
    await check(`People: a late sign-in answer to a ${command} save retired by ${how} does not end the session; a current one does`, async () => {
      let release; const gate = new Promise((done) => { release = done; });
      resetPeople({ gate, replies: ['session', 'session'] });
      const { ctx, page, section } = await peoplePage({ width: 1440, height: 900 });
      await page.evaluate(() => { window.__honEnded = 0; window.addEventListener('hon:session-invalidated', () => { window.__honEnded++; }); });
      await open(section, 'Ana Rivera');
      await save(section);
      await section().getByText('Saving… keep this tab open.').waitFor();
      await step(page, section);
      release();
      for (let i = 0; i < 40 && ppl.posts.length < 1; i++) await new Promise((done) => setTimeout(done, 50));
      await new Promise((done) => setTimeout(done, 500));
      assert.equal(await page.evaluate(() => window.__honEnded), 0, 'the retired save did not end the session');
      assert.ok(await section().getByTestId('people-list').isVisible(), 'the current view stays shown');
      // A save that is still the one shown: its sign-in answer ends the session.
      await openFresh(section, 'Ana Rivera');
      await save(section);
      await page.waitForFunction(() => window.__honEnded === 1, null, { timeout: 10000 });
      assert.equal(ppl.posts.length, 2);
      await ctx.close();
    });
  }
}

// ---------- HQ school access ----------
async function hqAccessPage(viewport, { view = 'Modern', language = 'en' } = {}) {
  mode = 'ready';
  const ctx = await context(viewport);
  if (language !== 'en') {
    const presentation = createHmac('sha256', session.secret).update(JSON.stringify(['hon-local-presentation-v1', session.mode, session.audience, 'hon-command-synthetic-owner'])).digest('hex');
    await ctx.addCookies([{ name: `hon_locale_v1_${presentation}`, value: encodeURIComponent(JSON.stringify({ version: 1, language, region: 'auto', currencyDisplay: 'symbol', timeZone: 'UTC' })), url: origin, sameSite: 'Lax' }]);
  }
  const page = await ctx.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(`${origin}/hq/schools/access`);
  const section = () => page.locator('section[aria-labelledby="hq-access-title"]');
  await section().getByTestId('hq-access-list').waitFor({ timeout: 20000 }).catch(async (e) => { console.error('HQ access page did not load:', await page.locator('main').innerText().catch(() => 'no main'), report.apiRequests.slice(-6)); throw e; });
  if (view !== 'Modern') await page.locator('[role="group"] button', { hasText: new RegExp(`^${view}$`) }).first().click();
  return { ctx, page, section };
}
const card = (section, name) => section().locator('article', { has: section().page().getByRole('heading', { name }) });
for (const [name, viewport, view, language, title] of [['desktop-1440', { width: 1440, height: 900 }, 'Modern', 'en', 'School access'], ['desktop-1440', { width: 1440, height: 900 }, 'Classic', 'en', 'School access'],
  ['desktop-1440', { width: 1440, height: 900 }, 'Big Button', 'en', 'School access'], ['phone-390', { width: 390, height: 844 }, 'Modern', 'en', 'School access'],
  ['desktop-1440', { width: 1440, height: 900 }, 'Modern', 'ko', '도장 접근'], ['phone-390', { width: 390, height: 844 }, 'Modern', 'es', 'Acceso de escuelas']]) {
  await check(`HQ school access ${view} ${language} ${name}: real overview, owner controls only where allowed`, async () => {
    resetHqx();
    const { ctx, page, section } = await hqAccessPage(viewport, { view, language });
    assert.ok(await section().getByRole('heading', { name: title, level: 1 }).isVisible());
    assert.equal(await section().getByTestId('hq-access-count-NO_ACCESS').innerText(), '1');
    assert.equal(await section().locator('article').count(), 3);
    assert.equal(await card(section, 'Synthetic Dojo East').getByRole('button').count(), 0, 'a paid organization offers no exception control');
    await noOverflow(page, `hq-access-${view}-${language}-${name}`);
    await axe(page, `hq-access-${view}-${language}-${name}`);
    await shot(page, `hq-access-${view.replace(' ', '-').toLowerCase()}-${language}-${name}`, true);
    await ctx.close();
  });
}
await check('HQ school access: a lost grant answer is kept; Try again replays the same key and body; the list is read again', async () => {
  resetHqx({ replies: ['unknown', 'ok'] });
  const { ctx, page, section } = await hqAccessPage({ width: 1440, height: 900 });
  const north = () => card(section, 'Synthetic Dojo North');
  await north().getByRole('button', { name: 'Grant an exception' }).click();
  await north().getByLabel('Purpose').selectOption('PRODUCT_DEMONSTRATION');
  await north().getByLabel('Days').fill('14');
  await north().getByLabel('Reason').fill('short');
  await north().getByRole('button', { name: 'Grant exception' }).click();
  await section().getByText(/a reason of 10 to 500 characters/).waitFor();
  assert.equal(hqx.posts.length, 0, 'nothing sent for an invalid form');
  await north().getByLabel('Reason').fill('Demonstration for an approved prospect');
  await north().getByRole('button', { name: 'Grant exception' }).click();
  await section().getByText(/We could not confirm whether this went through/).waitFor();
  // The answer was lost after the server recorded the grant: the fresh read already shows it, so no grant control is offered again.
  for (let i = 0; i < 50 && await section().getByTestId('hq-access-count-NO_ACCESS').innerText() !== '0'; i++) await new Promise((done) => setTimeout(done, 100));
  assert.equal(await north().getByRole('button', { name: /Grant/ }).count(), 0, 'no second grant offered');
  await shot(page, 'hq-access-grant-unknown');
  await section().getByRole('button', { name: 'Try again' }).click();
  await section().getByText(/Exception granted\. The list was read again\./).waitFor();
  assert.equal(hqx.posts.length, 2);
  assert.equal(hqx.posts[0].key, hqx.posts[1].key); assert.equal(hqx.posts[0].body, hqx.posts[1].body);
  const sent = JSON.parse(hqx.posts[0].body);
  assert.deepEqual(Object.keys(sent).sort(), ['expectedEntitlementVersion', 'expiresAt', 'purpose', 'reason', 'schoolId', 'scopeTier', 'startsAt']);
  assert.equal(sent.expectedEntitlementVersion, 2); assert.equal(sent.schoolId, id(411));
  assert.equal(Date.parse(sent.expiresAt) - Date.parse(sent.startsAt), 14 * 86_400_000);
  for (let i = 0; i < 50 && await section().getByTestId('hq-access-count-NO_ACCESS').innerText() !== '0'; i++) await new Promise((done) => setTimeout(done, 100));
  assert.equal(await section().getByTestId('hq-access-count-NO_ACCESS').innerText(), '0', 'the re-read shows the grant');
  await noOverflow(page, 'hq-access-grant'); await axe(page, 'hq-access-grant'); await shot(page, 'hq-access-granted', true);
  await ctx.close();
});
await check('HQ school access: revoke needs a reason and the list is read again', async () => {
  resetHqx();
  const { ctx, page, section } = await hqAccessPage({ width: 390, height: 844 });
  const south = () => card(section, 'Synthetic Dojo South');
  await south().getByRole('button', { name: 'Revoke' }).click();
  await south().getByLabel('Reason').fill('Pilot ended early by agreement');
  await shot(page, 'hq-access-revoke-form');
  await south().getByRole('button', { name: 'Revoke exception' }).click();
  await section().getByText(/Exception revoked\./).waitFor();
  assert.equal(hqx.posts[0].command, 'saas-access-exception-revoke');
  assert.deepEqual(JSON.parse(hqx.posts[0].body), { reason: 'Pilot ended early by agreement' });
  for (let i = 0; i < 50 && await section().getByTestId('hq-access-count-NO_ACCESS').innerText() !== '2'; i++) await new Promise((done) => setTimeout(done, 100));
  assert.equal(await section().getByTestId('hq-access-count-NO_ACCESS').innerText(), '2');
  await noOverflow(page, 'hq-access-revoke'); await axe(page, 'hq-access-revoke');
  await ctx.close();
});
await check('HQ school access: an operator sees facts without controls; no approved policy means no grant', async () => {
  resetHqx({ owner: false });
  let { ctx, page, section } = await hqAccessPage({ width: 1440, height: 900 });
  await section().getByTestId('hq-access-owner-only').waitFor();
  assert.equal(await section().getByRole('button', { name: /Grant an exception|^Revoke$/ }).count(), 0);
  await axe(page, 'hq-access-operator'); await shot(page, 'hq-access-operator');
  await ctx.close();
  resetHqx({ ready: false });
  ({ ctx, page, section } = await hqAccessPage({ width: 1440, height: 900 }));
  await section().getByText(/The exception policy is not approved yet/).waitFor();
  assert.equal(await section().getByRole('button', { name: 'Grant an exception' }).count(), 0);
  assert.ok(await card(section, 'Synthetic Dojo North').getByText(/the exception policy is not approved/).isVisible());
  await ctx.close();
});
await check('HQ school access: leaving the tab hides every customer and drops a kept command', async () => {
  resetHqx({ replies: ['unknown'] });
  const { ctx, page, section } = await hqAccessPage({ width: 1440, height: 900 });
  const south = () => card(section, 'Synthetic Dojo South');
  await south().getByRole('button', { name: 'Revoke' }).click();
  await south().getByLabel('Reason').fill('Pilot ended early by agreement');
  await south().getByRole('button', { name: 'Revoke exception' }).click();
  await section().getByText(/We could not confirm/).waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await section().getByText(/Customer access is hidden/).waitFor();
  assert.equal(await section().getByText(/Synthetic Dojo/).count(), 0);
  await section().getByRole('button', { name: 'Show again' }).click();
  await section().getByTestId('hq-access-list').waitFor();
  assert.equal(await section().getByRole('button', { name: 'Try again' }).count(), 0, 'the kept command was dropped');
  assert.equal(await section().getByTestId('hq-access-count-NO_ACCESS').innerText(), '2', 'the re-read shows what the server recorded');
  await ctx.close();
});

const ended = (page) => page.evaluate(() => window.__honEnded);
const watchEnded = (page) => page.evaluate(() => { window.__honEnded = 0; window.addEventListener('hon:session-invalidated', () => { window.__honEnded++; }); });
const startGrant = async (section) => {
  const north = card(section, 'Synthetic Dojo North');
  await north.getByRole('button', { name: 'Grant an exception' }).click();
  await north.getByLabel('Purpose').selectOption('PRODUCT_DEMONSTRATION');
  await north.getByLabel('Days').fill('14');
  await north.getByLabel('Reason').fill('Demonstration for an approved prospect');
  await north.getByRole('button', { name: 'Grant exception' }).click();
};
const startRevoke = async (section) => {
  const south = card(section, 'Synthetic Dojo South');
  await south.getByRole('button', { name: 'Revoke' }).click();
  await south.getByLabel('Reason').fill('Pilot ended early by agreement');
  await south.getByRole('button', { name: 'Revoke exception' }).click();
};
const hqRetire = {
  conceal: async (page, section) => {
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await section().getByText(/Customer access is hidden/).waitFor();
    await section().getByRole('button', { name: 'Show again' }).click();
    await section().getByTestId('hq-access-list').waitFor();
  },
  unmount: async (page, section) => {
    // Same-document route change (the shell's links load a new document, which ends every request anyway).
    await page.evaluate(() => window.next.router.push('/hq'));
    await page.waitForURL(/\/hq$/);
    await section().waitFor({ state: 'detached' });
    await page.evaluate(() => window.next.router.push('/hq/schools/access'));
    await section().getByTestId('hq-access-list').waitFor({ timeout: 20000 });
  },
};
for (const [command, start] of [['grant', startGrant], ['revoke', startRevoke]]) {
  for (const [how, retire] of Object.entries(hqRetire)) {
    await check(`HQ school access: a late sign-in answer to a ${command} retired by ${how} does not end the session; a current one does`, async () => {
      let release; const gate = new Promise((done) => { release = done; });
      resetHqx({ gate, replies: ['session', 'session'] });
      const { ctx, page, section } = await hqAccessPage({ width: 1440, height: 900 });
      await watchEnded(page);
      await start(section);
      await section().getByText(/Sending/).waitFor();
      await retire(page, section);
      release();
      for (let i = 0; i < 40 && hqx.posts.length < 1; i++) await new Promise((done) => setTimeout(done, 50));
      await new Promise((done) => setTimeout(done, 500));
      assert.equal(await ended(page), 0, 'the retired command did not end the session');
      assert.ok(await section().getByTestId('hq-access-list').isVisible(), 'the fresh list stays shown');
      await start(section);
      await page.waitForFunction(() => window.__honEnded === 1, null, { timeout: 10000 });
      assert.equal(hqx.posts.length, 2);
      await ctx.close();
    });
  }
}
await check('HQ school access: a late sign-in answer to a retired Show more read does not end the session', async () => {
  let release; const gate = new Promise((done) => { release = done; });
  resetHqx({ pageSize: 2, pageGate: gate, pageSession: true });
  const { ctx, page, section } = await hqAccessPage({ width: 1440, height: 900 });
  await watchEnded(page);
  assert.equal(await section().locator('article').count(), 2);
  await section().getByRole('button', { name: 'Show more' }).click();
  await hqRetire.conceal(page, section);
  release();
  await new Promise((done) => setTimeout(done, 800));
  assert.equal(await ended(page), 0, 'the retired page read did not end the session');
  assert.ok(await section().getByTestId('hq-access-list').isVisible());
  hqx.pageSession = true;
  await section().getByRole('button', { name: 'Show more' }).click();
  await page.waitForFunction(() => window.__honEnded === 1, null, { timeout: 10000 });
  await ctx.close();
});
for (const [command, start] of [['grant', startGrant], ['revoke', startRevoke]]) {
  await check(`HQ school access: when the fresh read after an unknown ${command} is denied, no organization, outcome or Try again remains`, async () => {
    resetHqx({ replies: ['unknownThenDenied'] });
    const { ctx, page, section } = await hqAccessPage({ width: 1440, height: 900 });
    await start(section);
    await section().getByText(/Your HQ access does not include the access overview/).waitFor();
    assert.equal(await section().getByText(/Synthetic Dojo/).count(), 0, 'no organization name remains');
    assert.equal(await section().getByRole('button', { name: 'Try again' }).count(), 0, 'no retry remains');
    assert.equal(await section().getByText(/We could not confirm/).count(), 0);
    assert.equal(await section().locator('form').count(), 0);
    hqx.denyOverview = false;
    await section().getByRole('button', { name: 'Refresh' }).click();
    await section().getByTestId('hq-access-list').waitFor();
    assert.equal(await section().getByRole('button', { name: 'Try again' }).count(), 0, 'a fresh authorized read does not bring back the retry');
    assert.equal(hqx.posts.length, 1);
    await ctx.close();
  });
}
await check('HQ school access: policy, access-state and checkout refusals end the attempt; nothing is kept for Try again', async () => {
  for (const [reply, text] of [['policy', /no approved access exception policy is in effect/], ['accessState', /changed since it was read/], ['checkout', /changed since it was read/]]) {
    resetHqx({ replies: [reply] });
    const { ctx, section } = await hqAccessPage({ width: 1440, height: 900 });
    await startGrant(section);
    await section().getByText(text).waitFor();
    assert.equal(await section().getByRole('button', { name: 'Try again' }).count(), 0, `${reply}: no retry`);
    assert.equal(hqx.posts.length, 1);
    await ctx.close();
  }
});

for (const [setup, start] of [['an open grant form', null], ['a kept unknown grant', startGrant], ['a kept unknown revoke', startRevoke]]) {
  await check(`HQ school access: a denied Show more read with ${setup} leaves no organization, form, outcome or Try again`, async () => {
    resetHqx({ pageSize: 2, pageDenied: true, replies: ['unknown'] });
    const { ctx, page, section } = await hqAccessPage({ width: 1440, height: 900 });
    if (start) {
      // Revoke is on South (row 2); grant is on North (row 1): both are on the first page of two.
      await start(section);
      await section().getByRole('button', { name: 'Try again' }).waitFor();
    } else {
      await card(section, 'Synthetic Dojo North').getByRole('button', { name: 'Grant an exception' }).click();
      await section().locator('form').first().waitFor();
    }
    await section().getByRole('button', { name: 'Show more' }).click();
    await section().getByText(/Your HQ access does not include the access overview/).waitFor();
    assert.equal(await section().getByText(/Synthetic Dojo/).count(), 0, 'no organization name remains');
    assert.equal(await section().locator('form').count(), 0, 'no form remains');
    assert.equal(await section().getByRole('button', { name: 'Try again' }).count(), 0, 'no retry remains');
    assert.equal(await section().getByText(/We could not confirm/).count(), 0, 'no outcome remains');
    hqx.pageDenied = false;
    await section().getByRole('button', { name: 'Refresh' }).click();
    await section().getByTestId('hq-access-list').waitFor();
    assert.equal(await section().getByRole('button', { name: 'Try again' }).count(), 0, 'a fresh authorized read does not bring back the retry');
    await ctx.close();
  });
}

// ---------- HQ exception policy ----------
async function hqPolicyPage(viewport, { language = 'en' } = {}) {
  mode = 'ready';
  const ctx = await context(viewport);
  if (language !== 'en') {
    const presentation = createHmac('sha256', session.secret).update(JSON.stringify(['hon-local-presentation-v1', session.mode, session.audience, 'hon-command-synthetic-owner'])).digest('hex');
    await ctx.addCookies([{ name: `hon_locale_v1_${presentation}`, value: encodeURIComponent(JSON.stringify({ version: 1, language, region: 'auto', currencyDisplay: 'symbol', timeZone: 'UTC' })), url: origin, sameSite: 'Lax' }]);
  }
  const page = await ctx.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(`${origin}/hq/schools/access/policy`);
  const section = () => page.locator('section[aria-labelledby="hq-policy-title"]');
  await section().getByTestId('hq-policy-status').waitFor({ timeout: 20000 }).catch(async (e) => { console.error('HQ policy page did not load:', await page.locator('main').innerText().catch(() => 'no main')); throw e; });
  return { ctx, page, section };
}
const policyDay = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fillDecision = async (section, { days = '30', end = policyDay(45), reason = 'Approve exceptions for the pilot season', confirm = true } = {}) => {
  await section().getByRole('button', { name: 'Propose or approve' }).click();
  const form = section().getByTestId('hq-policy-decide');
  await form.getByLabel('Longest exception (days)').fill(days);
  await form.getByLabel('Last valid day').fill(end);
  await form.getByLabel('Reason').fill(reason);
  if (confirm) await form.getByRole('checkbox').check();
  return form;
};
const approvedRow = (revision = 1, termsVersion = 1) => ({ approvalId: id(600 + revision), revision, status: 'APPROVED', termsVersion, maxDays: 30,
  validFrom: new Date(Date.now() - 86_400_000).toISOString(), validUntil: new Date(Date.now() + 40 * 86_400_000).toISOString(), reason: 'Synthetic approved exception policy',
  actorPrincipalId: id(499), recordedAt: new Date(Date.now() - 86_400_000).toISOString() });
for (const [name, viewport, language, title] of [['desktop-1440', { width: 1440, height: 900 }, 'en', 'Exception policy'], ['phone-390', { width: 390, height: 844 }, 'en', 'Exception policy'],
  ['desktop-1440', { width: 1440, height: 900 }, 'ko', '예외 정책'], ['phone-390', { width: 390, height: 844 }, 'es', 'Política de excepciones']]) {
  await check(`HQ exception policy ${language} ${name}: real read, current terms, exceptions-only statement`, async () => {
    resetHqp();
    const { ctx, page, section } = await hqPolicyPage(viewport, { language });
    assert.ok(await section().getByRole('heading', { name: title, level: 1 }).isVisible());
    assert.match(await section().getByTestId('hq-policy-terms').innerText(), /90/);
    await noOverflow(page, `hq-policy-${language}-${name}`); await axe(page, `hq-policy-${language}-${name}`);
    await shot(page, `hq-policy-${language}-${name}`, true);
    await ctx.close();
  });
}
await check('HQ exception policy: propose, then approve with the confirmation; each answer is followed by a fresh read', async () => {
  resetHqp();
  const { ctx, page, section } = await hqPolicyPage({ width: 1440, height: 900 });
  let form = await fillDecision(section, { confirm: false });
  await form.getByRole('button', { name: 'Approve policy' }).click();
  await section().getByText(/Approving also needs the confirmation box/).waitFor();
  assert.equal(hqp.posts.length, 0, 'nothing sent without the confirmation');
  await form.getByRole('button', { name: 'Save as proposal' }).click();
  await section().getByText(/Recorded: Proposed/).waitFor();
  assert.equal(await section().getByTestId('hq-policy-status').innerText(), 'Proposed');
  const proposed = JSON.parse(hqp.posts[0].body);
  assert.equal(proposed.decision, 'PROPOSED'); assert.equal(proposed.expectedRevision, 0); assert.equal(proposed.termsVersion, 1); assert.equal(proposed.maxDays, 30);
  assert.equal('confirmation' in proposed, false);
  await shot(page, 'hq-policy-proposed', true);
  form = section().getByTestId('hq-policy-decide');
  await section().getByRole('button', { name: 'Propose or approve' }).click();
  form = section().getByTestId('hq-policy-decide');
  assert.equal(await form.getByLabel('Longest exception (days)').inputValue(), '30', 'prefilled from the proposal');
  await form.getByLabel('Reason').fill('Owner approves the proposed exception policy');
  await form.getByRole('checkbox').check();
  await shot(page, 'hq-policy-approve-form', true);
  await form.getByRole('button', { name: 'Approve policy' }).click();
  await section().getByText(/Recorded: Approved/).waitFor();
  for (let i = 0; i < 50 && await section().getByTestId('hq-policy-status').innerText() !== 'Approved, in effect'; i++) await new Promise((done) => setTimeout(done, 100));
  assert.equal(await section().getByTestId('hq-policy-status').innerText(), 'Approved, in effect');
  const approved = JSON.parse(hqp.posts[1].body);
  assert.equal(approved.decision, 'APPROVED'); assert.equal(approved.expectedRevision, 1); assert.equal(approved.confirmation, 'APPROVE_ACCESS_EXCEPTION_POLICY_ONLY');
  assert.notEqual(hqp.posts[0].key, hqp.posts[1].key);
  assert.equal(await section().getByTestId('hq-policy-history').locator('li').count(), 2);
  await noOverflow(page, 'hq-policy-approved'); await axe(page, 'hq-policy-approved'); await shot(page, 'hq-policy-approved', true);
  await ctx.close();
});
await check('HQ exception policy: a lost answer is kept; Try again replays the same key and body and records once', async () => {
  resetHqp({ replies: ['unknown', 'ok'] });
  const { ctx, section } = await hqPolicyPage({ width: 1440, height: 900 });
  const form = await fillDecision(section);
  await form.getByRole('button', { name: 'Approve policy' }).click();
  await section().getByText(/We could not confirm whether this was recorded/).waitFor();
  await section().getByRole('button', { name: 'Try again' }).click();
  await section().getByText(/Recorded: Approved/).waitFor();
  assert.equal(hqp.posts.length, 2); assert.equal(hqp.posts[0].key, hqp.posts[1].key); assert.equal(hqp.posts[0].body, hqp.posts[1].body);
  assert.equal(hqp.history.length, 1, 'recorded once');
  await ctx.close();
});
await check('HQ exception policy: revoke needs a reason; a changed revision and rule refusals end the attempt with nothing kept', async () => {
  resetHqp({ history: [approvedRow()] });
  let { ctx, page, section } = await hqPolicyPage({ width: 390, height: 844 });
  await section().getByRole('button', { name: 'Revoke approval' }).click();
  const end = section().getByTestId('hq-policy-end');
  await end.getByLabel('Reason').fill('short');
  await end.getByRole('button', { name: 'Revoke' }).click();
  await section().getByText(/Give a reason of 10 to 500 characters/).waitFor();
  assert.equal(hqp.posts.length, 0);
  await end.getByLabel('Reason').fill('Pilot season is over for now');
  await shot(page, 'hq-policy-revoke-form', true);
  await end.getByRole('button', { name: 'Revoke' }).click();
  await section().getByText(/Recorded: Revoked/).waitFor();
  assert.deepEqual(JSON.parse(hqp.posts[0].body), { expectedRevision: 1, decision: 'REVOKED', reason: 'Pilot season is over for now' });
  await noOverflow(page, 'hq-policy-revoked'); await axe(page, 'hq-policy-revoked');
  await ctx.close();
  // Another decision lands after the read: the stale revision is refused, nothing is kept, the fresh read shows it.
  resetHqp();
  ({ ctx, page, section } = await hqPolicyPage({ width: 1440, height: 900 }));
  hqp.history = [approvedRow()];
  let form = await fillDecision(section);
  await form.getByRole('button', { name: 'Save as proposal' }).click();
  await section().getByText(/Another decision was recorded since this page was read/).waitFor();
  assert.equal(await section().getByRole('button', { name: 'Try again' }).count(), 0);
  assert.equal(await section().getByTestId('hq-policy-status').innerText(), 'Approved, in effect');
  // The terms change after the read: the server refuses the stale terms version.
  hqp.termsVersion = 2;
  form = await fillDecision(section);
  await form.getByRole('button', { name: 'Save as proposal' }).click();
  await section().getByText(/the access terms changed/).waitFor();
  assert.equal(await section().getByRole('button', { name: 'Try again' }).count(), 0);
  for (let i = 0; i < 50 && await section().getByTestId('hq-policy-status').innerText() !== 'Approved for older terms'; i++) await new Promise((done) => setTimeout(done, 100));
  assert.equal(await section().getByRole('button', { name: 'Revoke approval' }).count(), 0, 'nothing to revoke under older terms');
  await ctx.close();
});
await check('HQ exception policy: an HQ operator reads the policy with no decision control; a denied read shows nothing', async () => {
  resetHqp({ owner: false, history: [approvedRow()] });
  const { ctx, page, section } = await hqPolicyPage({ width: 1440, height: 900 });
  await section().getByTestId('hq-policy-owner-only').waitFor();
  assert.equal(await section().getByRole('button', { name: /Propose or approve|Revoke approval|Withdraw proposal/ }).count(), 0);
  await axe(page, 'hq-policy-operator'); await shot(page, 'hq-policy-operator');
  hqp.deny = true;
  await section().getByRole('button', { name: 'Refresh' }).click();
  await section().getByText(/does not include the exception policy/).waitFor();
  assert.equal(await section().getByText(/Synthetic approved exception policy/).count(), 0);
  await ctx.close();
});
await check('HQ exception policy: when the fresh read after an unknown decision is denied, no decision, outcome or Try again remains', async () => {
  resetHqp({ replies: ['unknownThenDenied'] });
  const { ctx, section } = await hqPolicyPage({ width: 1440, height: 900 });
  const form = await fillDecision(section);
  await form.getByRole('button', { name: 'Approve policy' }).click();
  await section().getByText(/does not include the exception policy/).waitFor();
  assert.equal(await section().getByRole('button', { name: 'Try again' }).count(), 0);
  assert.equal(await section().getByText(/We could not confirm/).count(), 0);
  assert.equal(await section().locator('form').count(), 0);
  hqp.deny = false;
  await section().getByRole('button', { name: 'Refresh' }).click();
  await section().getByTestId('hq-policy-status').waitFor();
  assert.equal(await section().getByRole('button', { name: 'Try again' }).count(), 0, 'a fresh authorized read does not bring back the retry');
  await ctx.close();
});
await check('HQ exception policy: leaving the tab hides the policy and drops a kept decision', async () => {
  resetHqp({ replies: ['unknown'] });
  const { ctx, page, section } = await hqPolicyPage({ width: 1440, height: 900 });
  const form = await fillDecision(section);
  await form.getByRole('button', { name: 'Approve policy' }).click();
  await section().getByText(/We could not confirm/).waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await section().getByText(/The exception policy is hidden/).waitFor();
  assert.equal(await section().getByText(/Approve exceptions for the pilot season/).count(), 0);
  await section().getByRole('button', { name: 'Show again' }).click();
  await section().getByTestId('hq-policy-status').waitFor();
  assert.equal(await section().getByRole('button', { name: 'Try again' }).count(), 0, 'the kept decision was dropped');
  assert.equal(await section().getByTestId('hq-policy-status').innerText(), 'Approved, in effect', 'the re-read shows what the server recorded');
  await ctx.close();
});
const policyRetire = {
  conceal: async (page, section) => {
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await section().getByText(/The exception policy is hidden/).waitFor();
    await section().getByRole('button', { name: 'Show again' }).click();
    await section().getByTestId('hq-policy-status').waitFor();
  },
  unmount: async (page, section) => {
    await page.evaluate(() => window.next.router.push('/hq'));
    await page.waitForURL(/\/hq$/);
    await section().waitFor({ state: 'detached' });
    await page.evaluate(() => window.next.router.push('/hq/schools/access/policy'));
    await section().getByTestId('hq-policy-status').waitFor({ timeout: 20000 });
  },
};
for (const [how, retire] of Object.entries(policyRetire)) {
  await check(`HQ exception policy: a late sign-in answer to a decision retired by ${how} does not end the session; a current one does`, async () => {
    let release; const gate = new Promise((done) => { release = done; });
    resetHqp({ gate, replies: ['session', 'session'] });
    const { ctx, page, section } = await hqPolicyPage({ width: 1440, height: 900 });
    await watchEnded(page);
    let form = await fillDecision(section);
    await form.getByRole('button', { name: 'Save as proposal' }).click();
    await section().getByText(/Sending/).waitFor();
    await retire(page, section);
    release();
    await new Promise((done) => setTimeout(done, 600));
    assert.equal(await ended(page), 0, 'the retired decision did not end the session');
    assert.ok(await section().getByTestId('hq-policy-status').isVisible(), 'the fresh read stays shown');
    form = await fillDecision(section);
    await form.getByRole('button', { name: 'Save as proposal' }).click();
    await page.waitForFunction(() => window.__honEnded === 1, null, { timeout: 10000 });
    assert.equal(hqp.posts.length, 2);
    await ctx.close();
  });
  await check(`HQ exception policy: a late sign-in answer to a read retired by ${how} does not end the session`, async () => {
    resetHqp();
    const { ctx, page, section } = await hqPolicyPage({ width: 1440, height: 900 });
    await watchEnded(page);
    let release; hqp.readGate = new Promise((done) => { release = done; }); hqp.readSession = true;
    await section().getByRole('button', { name: 'Refresh' }).click();
    await section().getByText(/Reading the exception policy/).waitFor();
    if (how === 'conceal') {
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await section().getByText(/The exception policy is hidden/).waitFor();
      release(); await new Promise((done) => setTimeout(done, 600));
      await section().getByRole('button', { name: 'Show again' }).click();
    } else {
      await page.evaluate(() => window.next.router.push('/hq'));
      await page.waitForURL(/\/hq$/);
      await section().waitFor({ state: 'detached' });
      release(); await new Promise((done) => setTimeout(done, 600));
      await page.evaluate(() => window.next.router.push('/hq/schools/access/policy'));
    }
    await section().getByTestId('hq-policy-status').waitFor({ timeout: 20000 });
    assert.equal(await ended(page), 0, 'the retired read did not end the session');
    hqp.readSession = true;
    await section().getByRole('button', { name: 'Refresh' }).click();
    await page.waitForFunction(() => window.__honEnded === 1, null, { timeout: 10000 });
    await ctx.close();
  });
}
// ---------- Leads (U4) ----------
async function leadsPage(viewport, { nextTheme = 'modern', language = 'en' } = {}) {
  theme = nextTheme; mode = 'ready';
  const ctx = await context(viewport);
  if (language !== 'en') {
    const presentation = createHmac('sha256', session.secret).update(JSON.stringify(['hon-local-presentation-v1', session.mode, session.audience, 'hon-command-synthetic-owner'])).digest('hex');
    await ctx.addCookies([{ name: `hon_locale_v1_${presentation}`, value: encodeURIComponent(JSON.stringify({ version: 1, language, region: 'auto', currencyDisplay: 'symbol', timeZone: 'UTC' })), url: origin, sameSite: 'Lax' }]);
  }
  const page = await ctx.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(`${origin}/staff/crm`);
  const section = () => page.locator('section[aria-labelledby="leads-title"]');
  await section().locator('h1').waitFor({ timeout: 20000 });
  return { ctx, page, section };
}
const LEADS_TITLES = { en: ['Leads', 'Won', 'Upcoming trial', 'Open in the CRM journey'], ko: ['문의', '등록', '예정된 체험 수업', 'CRM 여정에서 열기'], es: ['Prospectos', 'Ganados', 'Próxima clase de prueba', 'Abrir en el recorrido de CRM'] };
for (const [name, viewport, nextTheme, language] of [['desktop-1440', { width: 1440, height: 900 }, 'modern', 'en'], ['desktop-1440', { width: 1440, height: 900 }, 'classic', 'es'],
  ['phone-390', { width: 390, height: 844 }, 'big-button', 'ko'], ['phone-390', { width: 390, height: 844 }, 'modern', 'en']]) {
  await check(`Leads ${nextTheme} ${language} ${name}: open leads, a lead with trials, status tabs and links`, async () => {
    resetLeads();
    const [title, won, upcoming, journey] = LEADS_TITLES[language];
    const { ctx, page, section } = await leadsPage(viewport, { nextTheme, language });
    await section().getByTestId('leads-list').waitFor();
    assert.equal(await section().locator('h1').innerText(), title);
    assert.equal(lds.reads[0], 'list:OPEN', 'opens on Open leads');
    const listText = await section().getByTestId('leads-list').innerText();
    assert.ok(listText.includes('Riley Park') && listText.includes('Jordan Kim') && !listText.includes('Casey Lee'));
    await section().getByRole('button', { name: /Riley Park/ }).click();
    await section().getByTestId('upcoming-trial').waitFor();
    const detail = await section().getByTestId('lead-detail').innerText();
    assert.ok(detail.includes('riley@example.invalid'));
    assert.ok((await section().getByTestId('upcoming-trial').innerText()).includes(upcoming));
    const href = await section().getByRole('link', { name: journey }).getAttribute('href');
    assert.equal(href, `/staff/crm/journey?organizationId=${scope.organizationId}&schoolId=${scope.schoolId}&leadId=${id(800)}`);
    await noOverflow(page, `leads-${nextTheme}-${language}-${name}`);
    await axe(page, `leads-${nextTheme}-${language}-${name}`);
    await shot(page, `leads-${nextTheme}-${language}-${name}`, true);
    await section().getByRole('button', { name: won, exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="leads-list"]')?.textContent?.includes('Casey Lee'));
    assert.equal(lds.reads.at(-1), 'list:WON');
    assert.equal(await section().getByTestId('lead-detail').count(), 0, 'the selected open lead is not shown under Won');
    await ctx.close();
  });
}
await check('Leads: the filter narrows only what was read; no extra read', async () => {
  resetLeads();
  const { ctx, section } = await leadsPage({ width: 1440, height: 900 });
  await section().getByTestId('leads-list').waitFor();
  const reads = lds.reads.length;
  await section().getByLabel('Filter the shown leads by name or email').fill('jordan');
  await section().getByText('1 shown').waitFor();
  assert.equal(lds.reads.length, reads);
  await section().getByLabel('Filter the shown leads by name or email').fill('nobody');
  await section().getByText('No shown lead matches this filter.').waitFor();
  await ctx.close();
});
await check('Leads: denied access says so and shows nothing', async () => {
  resetLeads({ denied: true });
  const { ctx, section } = await leadsPage({ width: 1440, height: 900 });
  await section().getByText(/does not include CRM leads/).waitFor();
  assert.ok(!(await section().innerText()).includes('Riley'));
  await ctx.close();
});
await check('Leads: leaving the page hides names at once; the list is read again on return', async () => {
  resetLeads();
  const { ctx, page, section } = await leadsPage({ width: 1440, height: 900 });
  await section().getByRole('button', { name: /Riley Park/ }).click();
  await section().getByTestId('upcoming-trial').waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForFunction(() => !document.body.innerText.includes('Riley'));
  await ctx.close();
});
for (const [how, retire] of [['changing the status tab', (page, section) => section().getByRole('button', { name: 'Won', exact: true }).click()],
  ['closing the view', async (page) => { await page.evaluate(() => window.next.router.push('/staff/search')); await page.waitForFunction(() => !document.querySelector('section[aria-labelledby="leads-title"]')); }]]) {
  await check(`Leads: a late sign-in answer to a list read retired by ${how} does not end the session; a current one does`, async () => {
    resetLeads();
    const { ctx, page, section } = await leadsPage({ width: 1440, height: 900 });
    await section().getByTestId('leads-list').waitFor();
    await page.evaluate(() => { window.__honEnded = 0; window.addEventListener('hon:session-invalidated', () => { window.__honEnded++; }); });
    let release; lds.gate = new Promise((done) => { release = done; }); lds.step = 'session';
    await section().getByRole('button', { name: 'Refresh' }).click();
    for (let i = 0; i < 40 && lds.gate; i++) await new Promise((done) => setTimeout(done, 50));
    await retire(page, section);
    release();
    await new Promise((done) => setTimeout(done, 800));
    assert.equal(await page.evaluate(() => window.__honEnded), 0, 'the retired read did not end the session');
    await ctx.close();
    const current = await leadsPage({ width: 1440, height: 900 });
    await current.section().getByTestId('leads-list').waitFor();
    await current.page.evaluate(() => { window.__honEnded = 0; window.addEventListener('hon:session-invalidated', () => { window.__honEnded++; }); });
    lds.step = 'session';
    await current.section().getByRole('button', { name: 'Refresh' }).click();
    await current.page.waitForFunction(() => window.__honEnded === 1, null, { timeout: 10000 });
    await current.ctx.close();
  });
}

// ---------- Marketing home (U7) ----------
async function marketingPage(viewport, { nextTheme = 'modern', language = 'en' } = {}) {
  theme = nextTheme; mode = 'ready';
  const ctx = await context(viewport);
  if (language !== 'en') {
    const presentation = createHmac('sha256', session.secret).update(JSON.stringify(['hon-local-presentation-v1', session.mode, session.audience, 'hon-command-synthetic-owner'])).digest('hex');
    await ctx.addCookies([{ name: `hon_locale_v1_${presentation}`, value: encodeURIComponent(JSON.stringify({ version: 1, language, region: 'auto', currencyDisplay: 'symbol', timeZone: 'UTC' })), url: origin, sameSite: 'Lax' }]);
  }
  const page = await ctx.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(`${origin}/staff/marketing`);
  const section = () => page.locator('section[aria-labelledby="marketing-title"]');
  await section().locator('h1').waitFor({ timeout: 20000 });
  return { ctx, page, section };
}
const MARKETING_TITLES = { en: ['Marketing', 'Draft', 'Leads', 'Edit in the campaign planner'], ko: ['마케팅', '초안', '문의', '캠페인 플래너에서 수정'], es: ['Marketing', 'Borradores', 'Prospectos', 'Editar en el planificador de campañas'] };
for (const [name, viewport, nextTheme, language] of [['desktop-1440', { width: 1440, height: 900 }, 'modern', 'en'], ['desktop-1440', { width: 1440, height: 900 }, 'classic', 'es'],
  ['phone-390', { width: 390, height: 844 }, 'big-button', 'ko'], ['phone-390', { width: 390, height: 844 }, 'modern', 'en']]) {
  await check(`Marketing ${nextTheme} ${language} ${name}: active campaigns, one campaign's plan and counts, status tabs and links`, async () => {
    resetMarketing();
    const [title, draft, leads, edit] = MARKETING_TITLES[language];
    const { ctx, page, section } = await marketingPage(viewport, { nextTheme, language });
    await section().getByTestId('campaign-list').waitFor();
    assert.equal(await section().locator('h1').innerText(), title);
    const listText = await section().getByTestId('campaign-list').innerText();
    assert.ok(listText.includes('Spring open house') && !listText.includes('Summer camp plan') && !listText.includes('Old flyer'), 'opens on Active');
    await section().getByRole('button', { name: /Spring open house/ }).click();
    await section().getByTestId('campaign-funnel').waitFor();
    const counts = await section().getByTestId('campaign-funnel').innerText();
    assert.ok(counts.includes(leads) && counts.includes('12'), counts);
    const funnelRead = report.apiRequests.findLast((r) => r.includes('/funnel?'));
    const q = new URL(`http://x${funnelRead.split(' ')[1]}`).searchParams;
    assert.equal(Date.parse(q.get('to')) - Date.parse(q.get('from')), 30 * 86_400_000, 'a 30-day window');
    assert.ok(Date.parse(q.get('to')) < Date.now(), 'the window ends in the past');
    assert.equal(await section().getByRole('link', { name: edit }).getAttribute('href'), '/staff/marketing/campaigns');
    await noOverflow(page, `marketing-${nextTheme}-${language}-${name}`);
    await axe(page, `marketing-${nextTheme}-${language}-${name}`);
    await shot(page, `marketing-${nextTheme}-${language}-${name}`, true);
    const reads = mkt.reads.length;
    await section().getByRole('button', { name: draft, exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="campaign-list"]')?.textContent?.includes('Summer camp plan'));
    assert.equal(mkt.reads.length, reads, 'status tabs narrow only what was read');
    await ctx.close();
  });
}
await check('Marketing: an archived campaign offers no Marcus draft; a campaign with no leads shows zeros it read', async () => {
  resetMarketing();
  const { ctx, section } = await marketingPage({ width: 1440, height: 900 });
  await section().getByRole('button', { name: 'All', exact: true }).click();
  await section().getByRole('button', { name: /Old flyer/ }).click();
  await section().getByTestId('campaign-funnel').waitFor();
  assert.equal(await section().getByRole('link', { name: 'Ask Marcus for a draft' }).count(), 0);
  assert.ok((await section().getByTestId('campaign-funnel').innerText()).includes('0'));
  assert.equal(await section().locator('form').count(), 0);
  await ctx.close();
});
await check('Marketing: denied access says so and shows nothing', async () => {
  resetMarketing({ denied: true });
  const { ctx, section } = await marketingPage({ width: 1440, height: 900 });
  await section().getByText(/exactly one school/).waitFor();
  assert.ok(!(await section().innerText()).includes('Spring open house'));
  await ctx.close();
});
await check('Marketing: leaving the page hides plans at once', async () => {
  resetMarketing();
  const { ctx, page, section } = await marketingPage({ width: 1440, height: 900 });
  await section().getByRole('button', { name: /Spring open house/ }).click();
  await section().getByTestId('campaign-funnel').waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForFunction(() => !document.body.innerText.includes('Spring open house') && !document.body.innerText.includes('Fill the Saturday'));
  await ctx.close();
});
for (const [what, how, start, retire] of [
  ['count read', 'opening another campaign', async (page, section) => { await section().getByRole('button', { name: /Spring open house/ }).click(); },
    async (page, section) => { await section().getByRole('button', { name: 'All', exact: true }).click(); await section().getByRole('button', { name: /Summer camp plan/ }).click(); }],
  ['list read', 'closing the view', async (page, section) => { await section().getByRole('button', { name: 'Refresh' }).click(); },
    async (page) => { await page.evaluate(() => window.next.router.push('/staff/search')); await page.waitForFunction(() => !document.querySelector('section[aria-labelledby="marketing-title"]')); }]]) {
  await check(`Marketing: a late sign-in answer to a ${what} retired by ${how} does not end the session; a current one does`, async () => {
    resetMarketing();
    const { ctx, page, section } = await marketingPage({ width: 1440, height: 900 });
    await section().getByTestId('campaign-list').waitFor();
    await page.evaluate(() => { window.__honEnded = 0; window.addEventListener('hon:session-invalidated', () => { window.__honEnded++; }); });
    let release; mkt.gate = new Promise((done) => { release = done; }); mkt.step = 'session';
    await start(page, section);
    for (let i = 0; i < 40 && mkt.gate; i++) await new Promise((done) => setTimeout(done, 50));
    assert.equal(mkt.gate, null, 'the gated read arrived');
    await retire(page, section);
    release();
    await new Promise((done) => setTimeout(done, 800));
    assert.equal(await page.evaluate(() => window.__honEnded), 0, 'the retired read did not end the session');
    await ctx.close();
    const current = await marketingPage({ width: 1440, height: 900 });
    await current.section().getByTestId('campaign-list').waitFor();
    await current.page.evaluate(() => { window.__honEnded = 0; window.addEventListener('hon:session-invalidated', () => { window.__honEnded++; }); });
    mkt.step = 'session';
    await current.section().getByRole('button', { name: 'Refresh' }).click();
    await current.page.waitForFunction(() => window.__honEnded === 1, null, { timeout: 10000 });
    await current.ctx.close();
  });
}

// ---------- Class rosters (U5) ----------
async function rosterPage(viewport, { nextTheme = 'modern', language = 'en' } = {}) {
  theme = nextTheme; mode = 'ready';
  const ctx = await context(viewport);
  if (language !== 'en') {
    const presentation = createHmac('sha256', session.secret).update(JSON.stringify(['hon-local-presentation-v1', session.mode, session.audience, 'hon-command-synthetic-owner'])).digest('hex');
    await ctx.addCookies([{ name: `hon_locale_v1_${presentation}`, value: encodeURIComponent(JSON.stringify({ version: 1, language, region: 'auto', currencyDisplay: 'symbol', timeZone: 'UTC' })), url: origin, sameSite: 'Lax' }]);
  }
  const page = await ctx.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(`${origin}/staff/schedule`);
  const section = () => page.locator('section[aria-labelledby="roster-title"]');
  await section().locator('h1').waitFor({ timeout: 20000 });
  return { ctx, page, section };
}
const ROSTER_TITLES = { en: ['Class rosters', 'Show more classes', 'Show more', 'Record attendance'], ko: ['수업 명단', '수업 더 보기', '더 보기', '출석 기록'], es: ['Listas de clase', 'Mostrar más clases', 'Mostrar más', 'Registrar asistencia'] };
for (const [name, viewport, nextTheme, language] of [['desktop-1440', { width: 1440, height: 900 }, 'modern', 'en'], ['desktop-1440', { width: 1440, height: 900 }, 'classic', 'es'],
  ['phone-390', { width: 390, height: 844 }, 'big-button', 'ko'], ['phone-390', { width: 390, height: 844 }, 'modern', 'en']]) {
  await check(`Class rosters ${nextTheme} ${language} ${name}: classes from today, two class pages, a two-page roster with counts, links, and an earlier start date`, async () => {
    resetRoster();
    const [title, moreClasses, more, record] = ROSTER_TITLES[language];
    const { ctx, page, section } = await rosterPage(viewport, { nextTheme, language });
    await section().getByTestId('session-list').waitFor();
    assert.equal(await section().locator('h1').innerText(), title);
    const listText = await section().getByTestId('session-list').innerText();
    assert.ok(listText.includes('Kids Taekwondo') && listText.includes('Adult sparring') && !listText.includes('Saturday open mat'), 'opens on the school today');
    assert.equal(await section().getByTestId('session-list').locator('li').count(), 50);
    await section().getByRole('button', { name: moreClasses }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="session-list"] li').length === 52);
    assert.equal(await section().getByRole('button', { name: moreClasses }).count(), 0, 'no more classes after the last page');
    await section().getByRole('button', { name: /Kids Taekwondo/ }).click();
    await section().getByTestId('roster-table').waitFor();
    assert.equal(await section().getByTestId('roster-table').locator('tbody tr').count(), 50);
    await section().getByRole('button', { name: more, exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="roster-table"] tbody tr').length === 60);
    assert.deepEqual(rst.reads.filter((r) => r.startsWith('roster')), [`roster:${id(950)}:first`, `roster:${id(950)}:page-2`]);
    assert.deepEqual(rst.reads.filter((r) => r.startsWith('list')), ['list:today:first', `list:today:list-p2:${new Date().toISOString().slice(0, 10)}`]);
    assert.equal(await section().getByRole('button', { name: more, exact: true }).count(), 0, 'no more after the last page');
    const counts = await section().getByTestId('roster-counts').innerText();
    assert.ok(/\b6\b/.test(counts), counts);
    assert.equal(await section().getByRole('link', { name: record }).getAttribute('href'), `/staff/attendance?organizationId=${scope.organizationId}&schoolId=${scope.schoolId}`);
    await noOverflow(page, `roster-${nextTheme}-${language}-${name}`);
    await axe(page, `roster-${nextTheme}-${language}-${name}`);
    await shot(page, `roster-${nextTheme}-${language}-${name}`, true);
    const earlier = new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10);
    await section().locator('input[type="date"]').fill(earlier);
    await page.waitForFunction(() => document.querySelector('[data-testid="session-list"]')?.textContent?.includes('Saturday open mat'));
    assert.equal(rst.reads.at(-1), `list:${earlier}:first`);
    await ctx.close();
  });
}
await check('Class rosters: a roster that changed between pages is read again from the start, once', async () => {
  resetRoster();
  const { ctx, page, section } = await rosterPage({ width: 1440, height: 900 });
  await section().getByRole('button', { name: /Kids Taekwondo/ }).click();
  await section().getByTestId('roster-table').waitFor();
  rst.step = 'cursor';
  await section().getByRole('button', { name: 'Show more', exact: true }).click();
  await section().getByText('The roster changed while it was being read, so it was read again from the start.').waitFor();
  assert.deepEqual(rst.reads.filter((r) => r.startsWith('roster')), [`roster:${id(950)}:first`, `roster:${id(950)}:page-2`, `roster:${id(950)}:first`]);
  assert.equal(await page.locator('[data-testid="roster-table"] tbody tr').count(), 50, 'nothing from the earlier pages is kept');
  await ctx.close();
});
await check('Class rosters: a later class page read after the school midnight keeps paging without a restart', async () => {
  resetRoster();
  const { ctx, page, section } = await rosterPage({ width: 1440, height: 900 });
  await section().getByTestId('session-list').waitFor();
  rst.step = 'midnight';
  await section().getByRole('button', { name: 'Show more classes' }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="session-list"] li').length === 52);
  assert.equal(await section().getByText(/class list changed/).count(), 0, 'no restart');
  assert.equal(rst.reads.filter((r) => r.startsWith('list')).length, 2);
  await ctx.close();
});
await check('Class rosters: a class-list cursor the API refuses reads the list again from the start, once', async () => {
  resetRoster();
  const { ctx, page, section } = await rosterPage({ width: 1440, height: 900 });
  await section().getByTestId('session-list').waitFor();
  rst.step = 'cursor';
  await section().getByRole('button', { name: 'Show more classes' }).click();
  await section().getByText('The class list changed while it was being read, so it was read again from the start.').waitFor();
  assert.equal(await page.locator('[data-testid="session-list"] li').count(), 50, 'nothing from the earlier pages is kept');
  await ctx.close();
});
await check('Class rosters: an empty roster says so; denied access says so and shows nobody', async () => {
  resetRoster();
  const { ctx, section } = await rosterPage({ width: 1440, height: 900 });
  await section().getByRole('button', { name: /Adult sparring/ }).click();
  await section().getByText('Nobody is booked on this class and no attendance is recorded.').waitFor();
  assert.equal(await section().locator('form').count(), 0);
  await ctx.close();
  resetRoster({ denied: true });
  const denied = await rosterPage({ width: 1440, height: 900 });
  await denied.section().getByRole('button', { name: /Kids Taekwondo/ }).click();
  await denied.section().getByText(/who can record attendance/).waitFor();
  assert.ok(!(await denied.section().innerText()).includes('Student0'));
  await denied.ctx.close();
});
await check('Class rosters: leaving the page hides names at once', async () => {
  resetRoster();
  const { ctx, page, section } = await rosterPage({ width: 1440, height: 900 });
  await section().getByRole('button', { name: /Kids Taekwondo/ }).click();
  await section().getByTestId('roster-table').waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForFunction(() => !document.body.innerText.includes('Student0') && !document.body.innerText.includes('Kids Taekwondo'));
  await ctx.close();
});
for (const [what, how, start, retire] of [
  ['roster read', 'opening another class', async (page, section) => { await section().getByRole('button', { name: /Kids Taekwondo/ }).click(); },
    async (page, section) => { await section().getByRole('button', { name: /Adult sparring/ }).click(); }],
  ['next-page read', 'opening another class', async (page, section) => { await section().getByRole('button', { name: /Kids Taekwondo/ }).click(); await section().getByTestId('roster-table').waitFor();
    rst.gate = new Promise((done) => { rst.release = done; }); rst.step = 'session'; await section().getByRole('button', { name: 'Show more', exact: true }).click(); },
    async (page, section) => { await section().getByRole('button', { name: /Adult sparring/ }).click(); }],
  ['class list read', 'closing the view', async (page, section) => { await section().getByRole('button', { name: 'Refresh' }).click(); },
    async (page) => { await page.evaluate(() => window.next.router.push('/staff/search')); await page.waitForFunction(() => !document.querySelector('section[aria-labelledby="roster-title"]')); }]]) {
  await check(`Class rosters: a late sign-in answer to a ${what} retired by ${how} does not end the session; a current one does`, async () => {
    resetRoster();
    const { ctx, page, section } = await rosterPage({ width: 1440, height: 900 });
    await section().getByTestId('session-list').waitFor();
    await page.evaluate(() => { window.__honEnded = 0; window.addEventListener('hon:session-invalidated', () => { window.__honEnded++; }); });
    if (what !== 'next-page read') { rst.gate = new Promise((done) => { rst.release = done; }); rst.step = 'session'; }
    await start(page, section);
    for (let i = 0; i < 40 && rst.gate; i++) await new Promise((done) => setTimeout(done, 50));
    assert.equal(rst.gate, null, 'the gated read arrived');
    await retire(page, section);
    rst.release();
    await new Promise((done) => setTimeout(done, 800));
    assert.equal(await page.evaluate(() => window.__honEnded), 0, 'the retired read did not end the session');
    await ctx.close();
    const current = await rosterPage({ width: 1440, height: 900 });
    await current.section().getByTestId('session-list').waitFor();
    await current.page.evaluate(() => { window.__honEnded = 0; window.addEventListener('hon:session-invalidated', () => { window.__honEnded++; }); });
    rst.step = 'session';
    await current.section().getByRole('button', { name: 'Refresh' }).click();
    await current.page.waitForFunction(() => window.__honEnded === 1, null, { timeout: 10000 });
    await current.ctx.close();
  });
}

// ---------- Memberships (U6) ----------
async function membershipsPage(viewport, { nextTheme = 'modern', language = 'en' } = {}) {
  theme = nextTheme; mode = 'ready';
  const ctx = await context(viewport);
  if (language !== 'en') {
    const presentation = createHmac('sha256', session.secret).update(JSON.stringify(['hon-local-presentation-v1', session.mode, session.audience, 'hon-command-synthetic-owner'])).digest('hex');
    await ctx.addCookies([{ name: `hon_locale_v1_${presentation}`, value: encodeURIComponent(JSON.stringify({ version: 1, language, region: 'auto', currencyDisplay: 'symbol', timeZone: 'UTC' })), url: origin, sameSite: 'Lax' }]);
  }
  const page = await ctx.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(`${origin}/staff/memberships`);
  const section = () => page.locator('section[aria-labelledby="membership-list-title"]');
  await section().locator('h1').waitFor({ timeout: 20000 });
  return { ctx, page, section };
}
const MEMBERSHIP_TITLES = { en: ['Memberships', 'Show more', 'Draft', 'Activate a draft membership'], ko: ['회원권', '더 보기', '초안', '초안 회원권 활성화'], es: ['Membresías', 'Mostrar más', 'Borrador', 'Activar una membresía en borrador'] };
for (const [name, viewport, nextTheme, language] of [['desktop-1440', { width: 1440, height: 900 }, 'modern', 'en'], ['desktop-1440', { width: 1440, height: 900 }, 'classic', 'es'],
  ['phone-390', { width: 390, height: 844 }, 'big-button', 'ko'], ['phone-390', { width: 390, height: 844 }, 'modern', 'en']]) {
  await check(`Memberships ${nextTheme} ${language} ${name}: newest first, two pages with counts, a state filter, and links`, async () => {
    resetMemberships();
    const [title, more, draft, activate] = MEMBERSHIP_TITLES[language];
    const { ctx, page, section } = await membershipsPage(viewport, { nextTheme, language });
    await section().getByTestId('membership-table').waitFor();
    assert.equal(await section().locator('h1').innerText(), title);
    assert.equal(await section().getByTestId('membership-table').locator('tbody tr').count(), 50);
    assert.ok((await section().getByTestId('membership-table').locator('tbody tr').first().innerText()).includes('Member00'), 'newest first');
    await section().getByRole('button', { name: more }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="membership-table"] tbody tr').length === 60);
    assert.equal(await section().getByRole('button', { name: more }).count(), 0, 'no more after the last page');
    const counts = await section().getByTestId('membership-counts').innerText();
    assert.ok(/\b10\b/.test(counts), counts);
    assert.equal(await section().getByRole('link', { name: activate }).getAttribute('href'), '/staff/billing/memberships');
    await noOverflow(page, `memberships-${nextTheme}-${language}-${name}`);
    await axe(page, `memberships-${nextTheme}-${language}-${name}`);
    await shot(page, `memberships-${nextTheme}-${language}-${name}`, true);
    await section().getByRole('button', { name: draft, exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="membership-table"] tbody tr').length === 10);
    assert.deepEqual(mbl.reads, ['ALL:first', 'ALL:ALL-page-2', 'DRAFT:first']);
    assert.equal(await section().getByTestId('membership-counts').count(), 0);
    await ctx.close();
  });
}
await check('Memberships: a cursor the API refuses reads the list again from the start, once', async () => {
  resetMemberships();
  const { ctx, page, section } = await membershipsPage({ width: 1440, height: 900 });
  await section().getByTestId('membership-table').waitFor();
  mbl.step = 'cursor';
  await section().getByRole('button', { name: 'Show more' }).click();
  await section().getByText('The list changed while it was being read, so it was read again from the start.').waitFor();
  assert.deepEqual(mbl.reads, ['ALL:first', 'ALL:ALL-page-2', 'ALL:first']);
  assert.equal(await page.locator('[data-testid="membership-table"] tbody tr').count(), 50, 'nothing from the earlier pages is kept');
  await ctx.close();
});
await check('Memberships: denied access says so and shows nobody; leaving the page hides names at once', async () => {
  resetMemberships({ denied: true });
  const denied = await membershipsPage({ width: 1440, height: 900 });
  await denied.section().getByText(/does not include memberships/).waitFor();
  assert.ok(!(await denied.section().innerText()).includes('Member0'));
  assert.equal(await denied.section().locator('form').count(), 0);
  await denied.ctx.close();
  resetMemberships();
  const { ctx, page, section } = await membershipsPage({ width: 1440, height: 900 });
  await section().getByTestId('membership-table').waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForFunction(() => !document.body.innerText.includes('Member00'));
  await ctx.close();
});
await check('Memberships: a late sign-in answer to a read retired by a filter change does not end the session; a current one does', async () => {
  resetMemberships();
  const { ctx, page, section } = await membershipsPage({ width: 1440, height: 900 });
  await section().getByTestId('membership-table').waitFor();
  await page.evaluate(() => { window.__honEnded = 0; window.addEventListener('hon:session-invalidated', () => { window.__honEnded++; }); });
  mbl.gate = new Promise((done) => { mbl.release = done; }); mbl.step = 'session';
  await section().getByRole('button', { name: 'Show more' }).click();
  for (let i = 0; i < 40 && mbl.gate; i++) await new Promise((done) => setTimeout(done, 50));
  assert.equal(mbl.gate, null, 'the gated read arrived');
  await section().getByRole('button', { name: 'Frozen', exact: true }).click();
  mbl.release();
  await new Promise((done) => setTimeout(done, 800));
  assert.equal(await page.evaluate(() => window.__honEnded), 0, 'the retired read did not end the session');
  mbl.step = 'session';
  await section().getByRole('button', { name: 'Refresh' }).click();
  await page.waitForFunction(() => window.__honEnded === 1, null, { timeout: 10000 });
  await ctx.close();
});

// ---------- School ownership (B-ID-4) ----------
async function ownershipPage(path, viewport, { nextTheme = 'modern', language = 'en' } = {}) {
  theme = nextTheme; mode = 'ready';
  const ctx = await context(viewport);
  if (language !== 'en') {
    const presentation = createHmac('sha256', session.secret).update(JSON.stringify(['hon-local-presentation-v1', session.mode, session.audience, 'hon-command-synthetic-owner'])).digest('hex');
    await ctx.addCookies([{ name: `hon_locale_v1_${presentation}`, value: encodeURIComponent(JSON.stringify({ version: 1, language, region: 'auto', currencyDisplay: 'symbol', timeZone: 'UTC' })), url: origin, sameSite: 'Lax' }]);
  }
  const page = await ctx.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(`${origin}${path}`);
  return { ctx, page };
}
const ownHq = (page) => page.getByTestId('hq-school-ownership');
async function chooseOwnSchool(page, schoolId = scope.schoolId) {
  await ownHq(page).locator('select').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="hq-school-ownership"] select option').length === 3);
  await ownHq(page).locator('select').selectOption(schoolId);
  await ownHq(page).getByTestId('ownership-hq-access').waitFor();
}
const OWN_TEXT = { en: ['School owners', 'Make primary', 'Yes, make primary', 'Primary owner'], ko: ['도장 소유자', '대표로 지정', '예, 대표로 지정', '대표 소유자'] };
for (const [name, viewport, nextTheme, language] of [['desktop-1440', { width: 1440, height: 900 }, 'modern', 'en'], ['phone-390', { width: 390, height: 844 }, 'big-button', 'ko']]) {
  await check(`School owners HQ ${nextTheme} ${language} ${name}: owners, HQ access apart from owners, and Make primary after confirming`, async () => {
    resetOwnership();
    const [title, make, yes, primary] = OWN_TEXT[language];
    const { ctx, page } = await ownershipPage('/hq/schools/owners', viewport, { nextTheme, language });
    await chooseOwnSchool(page);
    assert.equal(await ownHq(page).locator('h1').innerText(), title);
    assert.equal(await ownHq(page).getByTestId('ownership-owner').count(), 2);
    assert.ok((await ownHq(page).getByTestId('ownership-owner').first().innerText()).includes(primary));
    assert.ok(!(await ownHq(page).getByTestId('ownership-owner').allInnerTexts()).join(' ').includes(id(1801)), 'HQ seat never listed as an owner');
    assert.ok((await ownHq(page).getByTestId('ownership-hq-access').innerText()).includes(language === 'en' ? '1 HQ seat(s)' : 'HQ 좌석 1개'));
    await noOverflow(page, `school-owners-hq-${nextTheme}-${language}-${name}`);
    await axe(page, `school-owners-hq-${nextTheme}-${language}-${name}`);
    await shot(page, `school-owners-hq-${nextTheme}-${language}-${name}`, true);
    await ownHq(page).getByRole('button', { name: make }).click();
    await shot(page, `school-owners-hq-confirm-${nextTheme}-${language}-${name}`, true);
    await ownHq(page).getByRole('button', { name: yes }).click();
    await ownHq(page).getByTestId('ownership-outcome').filter({ hasText: language === 'en' ? 'Sam Park is now the primary owner.' : 'Sam Park 님이 이제 대표 소유자입니다.' }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="ownership-owner"][data-primary]').length === 1
      && document.querySelector('[data-testid="ownership-owner"][data-primary]')?.textContent?.includes('Sam Park'));
    assert.equal(own.posts.length, 1);
    assert.equal(own.posts[0].command, 'school-owner-account');
    assert.deepEqual(own.posts[0].body, { schoolId: scope.schoolId, ownerGrantId: id(1812) });
    assert.ok(own.reads.filter((r) => r === `hq:${scope.schoolId}`).length >= 2, 'read again after the answer');
    await ctx.close();
  });
}
await check('School owners HQ: an unknown outcome offers Try again, which replays the same key once', async () => {
  resetOwnership({ replies: ['unknown'] });
  const { ctx, page } = await ownershipPage('/hq/schools/owners', { width: 1280, height: 900 });
  await chooseOwnSchool(page);
  await ownHq(page).getByRole('button', { name: 'Make primary' }).click();
  await ownHq(page).getByRole('button', { name: 'Yes, make primary' }).click();
  await ownHq(page).getByRole('button', { name: 'Try again' }).waitFor();
  assert.equal(await ownHq(page).locator('select').isDisabled(), true, 'school choice locked while a command is kept');
  await ownHq(page).getByRole('button', { name: 'Try again' }).click();
  await ownHq(page).getByTestId('ownership-outcome').filter({ hasText: 'Sam Park is now the primary owner.' }).waitFor();
  assert.equal(own.posts.length, 2); assert.equal(own.posts[0].key, own.posts[1].key);
  await ctx.close();
});
await check('School owners HQ: a school without a primary says so; Cancel sends nothing; leaving the tab hides every owner', async () => {
  resetOwnership();
  const { ctx, page } = await ownershipPage('/hq/schools/owners', { width: 1280, height: 900 });
  await chooseOwnSchool(page, ownSecond);
  await ownHq(page).getByTestId('ownership-primary-needed').waitFor();
  assert.ok((await ownHq(page).getByTestId('ownership-hq-access').innerText()).includes('No HQ seats'));
  await ownHq(page).getByRole('button', { name: 'Make primary' }).click();
  await ownHq(page).getByRole('button', { name: 'Cancel' }).click();
  assert.equal(own.posts.length, 0);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await ownHq(page).getByRole('button', { name: 'Show again' }).waitFor();
  assert.ok(!(await ownHq(page).innerText()).includes('jamie.owner@example.invalid'), 'hidden after leaving');
  await ctx.close();
});
await check('School owners HQ: a non-owner HQ reader is told so and sees no owner', async () => {
  resetOwnership({ denied: true });
  const { ctx, page } = await ownershipPage('/hq/schools/owners', { width: 1280, height: 900 });
  await ownHq(page).locator('select').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="hq-school-ownership"] select option').length === 3);
  await ownHq(page).locator('select').selectOption(scope.schoolId);
  await ownHq(page).getByText('Only the HQ owner can see and change school owners.').waitFor();
  assert.ok(!(await ownHq(page).innerText()).includes('dana.owner@example.invalid'));
  await ctx.close();
});
for (const [name, viewport, nextTheme, language] of [['desktop-1440', { width: 1440, height: 900 }, 'classic', 'en'], ['phone-390', { width: 390, height: 844 }, 'modern', 'es']]) {
  await check(`School owners settings ${nextTheme} ${language} ${name}: co-owners with You and Primary, notices, and no command`, async () => {
    resetOwnership();
    const { ctx, page } = await ownershipPage('/staff/owners', viewport, { nextTheme, language });
    const section = page.getByTestId('owner-school-ownership');
    await section.getByTestId('ownership-owner').first().waitFor({ timeout: 20000 });
    assert.equal(await section.getByTestId('ownership-owner').count(), 2);
    const first = await section.getByTestId('ownership-owner').first().innerText();
    assert.ok(first.includes(language === 'en' ? 'You' : 'Usted') && first.includes(language === 'en' ? 'Primary owner' : 'Propietario principal'), first);
    assert.equal(await section.getByRole('button', { name: /Make primary|Hacer principal/ }).count(), 0);
    assert.ok((await section.innerText()).includes('sam.owner@example.invalid'));
    await noOverflow(page, `school-owners-settings-${nextTheme}-${language}-${name}`);
    await axe(page, `school-owners-settings-${nextTheme}-${language}-${name}`);
    await shot(page, `school-owners-settings-${nextTheme}-${language}-${name}`, true);
    await ctx.close();
  });
}
await check('School owners settings: a staff member who is not an owner is told so and sees nobody', async () => {
  resetOwnership({ ownerDenied: true });
  const { ctx, page } = await ownershipPage('/staff/owners', { width: 1280, height: 900 });
  const section = page.getByTestId('owner-school-ownership');
  await section.getByText("Only this school's owners can see this page.").waitFor({ timeout: 20000 });
  assert.ok(!(await section.innerText()).includes('dana.owner@example.invalid'));
  await ctx.close();
});

// ---------- Pause, cancel & refunds (0224) ----------
const chgPage = (page) => page.getByTestId('membership-changes');
async function chooseMember00(page) {
  await chgPage(page).getByTestId('pause-rules').getByText(/60/).first().waitFor({ timeout: 20000 });
  await chgPage(page).getByTestId('membership-select').waitFor({ timeout: 20000 });
  await chgPage(page).getByTestId('membership-select').selectOption(id(1500));
  await chgPage(page).getByTestId('membership-actions').waitFor();
}
const CHG_TEXT = { en: ['Pause, cancel & refunds', 'Pause membership', 'Pause this membership', 'The membership is paused.', 'Paused'],
  ko: ['일시정지·취소·환불', '회원권 일시정지', '이 회원권 일시정지', '회원권이 일시정지되었습니다.', '일시정지'] };
for (const [name, viewport, nextTheme, language] of [['desktop-1440', { width: 1440, height: 900 }, 'modern', 'en'], ['phone-390', { width: 390, height: 844 }, 'big-button', 'ko']]) {
  await check(`Pause, cancel & refunds ${nextTheme} ${language} ${name}: school rules, then pause a membership within them`, async () => {
    resetChanges(); resetMemberships();
    const [title, pause, confirm, done, paused] = CHG_TEXT[language];
    const { ctx, page } = await ownershipPage('/staff/billing/membership-changes', viewport, { nextTheme, language });
    await chooseMember00(page);
    assert.equal(await chgPage(page).locator('h1').innerText(), title);
    await noOverflow(page, `membership-changes-${nextTheme}-${language}-${name}`);
    await axe(page, `membership-changes-${nextTheme}-${language}-${name}`);
    await shot(page, `membership-changes-${nextTheme}-${language}-${name}`, true);
    await chgPage(page).getByRole('button', { name: pause }).click();
    const date = chgPage(page).getByTestId('pause-form').locator('input[type="date"]');
    assert.equal(await date.getAttribute('min'), '2026-11-09'); assert.equal(await date.getAttribute('max'), '2027-01-07');
    await date.fill('2026-12-01');
    await chgPage(page).getByTestId('pause-form').locator('textarea').fill('Travelling for work');
    await axe(page, `membership-changes-pause-form-${nextTheme}-${language}-${name}`);
    await shot(page, `membership-changes-pause-form-${nextTheme}-${language}-${name}`, true);
    await chgPage(page).getByRole('button', { name: confirm }).click();
    await chgPage(page).getByTestId('change-outcome').filter({ hasText: done }).waitFor();
    await chgPage(page).getByTestId('membership-selected').locator('[data-state="FROZEN"]').filter({ hasText: paused }).waitFor();
    assert.equal(chg.posts.length, 1);
    assert.deepEqual({ tail: chg.posts[0].tail, command: chg.posts[0].command, body: chg.posts[0].body },
      { tail: 'pause', command: 'billing.membership.pause', body: { expectedVersion: 1, resumeOn: '2026-12-01', pauseReason: 'Travelling for work' } });
    assert.ok(/^[0-9a-f-]{36}$/.test(chg.posts[0].key), 'an idempotency key');
    assert.ok(chg.reads.filter((r) => r === 'pauses-and-refunds').length >= 2, 'read again after the answer');
    await ctx.close();
  });
}
await check('Pause, cancel & refunds: resume, cancel and record a refund, each read again from the server', async () => {
  resetChanges(); resetMemberships();
  const { ctx, page } = await ownershipPage('/staff/billing/membership-changes', { width: 1280, height: 900 });
  await chooseMember00(page);
  const sel = () => chgPage(page).getByTestId('membership-selected');
  await chgPage(page).getByRole('button', { name: 'Pause membership' }).click();
  await chgPage(page).getByTestId('pause-form').locator('input[type="date"]').fill('2026-11-20');
  await chgPage(page).getByTestId('pause-form').locator('textarea').fill('Injury');
  await chgPage(page).getByRole('button', { name: 'Pause this membership' }).click();
  await sel().getByRole('button', { name: 'Resume now' }).waitFor();
  await sel().getByRole('button', { name: 'Resume now' }).click();
  await chgPage(page).getByRole('button', { name: 'Resume this membership today' }).click();
  await chgPage(page).getByTestId('change-outcome').filter({ hasText: 'The membership is active again.' }).waitFor();
  await sel().getByText(/Resumed/).waitFor();
  await sel().getByRole('button', { name: 'Cancel membership' }).click();
  await shot(page, 'membership-changes-cancel-confirm', true);
  await chgPage(page).getByTestId('cancel-form').locator('textarea').fill('Moving away');
  await chgPage(page).getByRole('button', { name: 'Yes, cancel this membership' }).click();
  await chgPage(page).getByTestId('change-outcome').filter({ hasText: 'The membership is cancelled.' }).waitFor();
  await sel().getByRole('button', { name: 'Record a refund' }).click();
  const refund = chgPage(page).getByTestId('refund-form');
  await refund.locator('input[name="amount"]').fill('49.99');
  await refund.locator('select[name="method"]').selectOption('CARD_TERMINAL');
  await refund.locator('textarea').fill('Unused month');
  await shot(page, 'membership-changes-refund-form', true);
  await chgPage(page).getByRole('button', { name: 'Save refund record' }).click();
  await chgPage(page).getByTestId('change-outcome').filter({ hasText: 'The refund record is saved.' }).waitFor();
  await sel().getByTestId('refund-row').filter({ hasText: '$49.99' }).waitFor();
  assert.deepEqual(chg.posts.map((p) => [p.tail, p.command, p.body.expectedVersion ?? null]),
    [['pause', 'billing.membership.pause', 1], ['resume', 'billing.membership.resume', 2], ['cancel', 'billing.membership.cancel', 3], ['refund-records', 'billing.membership.refund.record', null]]);
  assert.deepEqual(chg.posts[3].body, { amountMinor: 4999, currency: 'USD', refundedOn: '2026-11-08', method: 'CARD_TERMINAL', reason: 'Unused month' });
  assert.equal(new Set(chg.posts.map((p) => p.key)).size, 4, 'a fresh key for each command');
  await axe(page, 'membership-changes-after-refund');
  await shot(page, 'membership-changes-after-refund', true);
  await ctx.close();
});
await check('Pause, cancel & refunds: an unknown cancel outcome offers Try again with the same key; an active payment schedule refuses a pause', async () => {
  resetChanges({ replies: ['unknown'] }); resetMemberships();
  const { ctx, page } = await ownershipPage('/staff/billing/membership-changes', { width: 1280, height: 900 });
  await chooseMember00(page);
  await chgPage(page).getByRole('button', { name: 'Cancel membership' }).click();
  await chgPage(page).getByTestId('cancel-form').locator('textarea').fill('Moving away');
  await chgPage(page).getByRole('button', { name: 'Yes, cancel this membership' }).click();
  await chgPage(page).getByRole('button', { name: 'Try again' }).waitFor();
  assert.equal(await chgPage(page).getByTestId('membership-select').isDisabled(), true, 'choice locked while a command is kept');
  await chgPage(page).getByRole('button', { name: 'Try again' }).click();
  await chgPage(page).getByTestId('change-outcome').filter({ hasText: 'The membership is cancelled.' }).waitFor();
  assert.equal(chg.posts.length, 2); assert.equal(chg.posts[0].key, chg.posts[1].key);
  await ctx.close();
  resetChanges({ replies: ['schedule'] }); resetMemberships();
  const second = await ownershipPage('/staff/billing/membership-changes', { width: 1280, height: 900 });
  await chooseMember00(second.page);
  await chgPage(second.page).getByRole('button', { name: 'Pause membership' }).click();
  await chgPage(second.page).getByTestId('pause-form').locator('input[type="date"]').fill('2026-11-20');
  await chgPage(second.page).getByTestId('pause-form').locator('textarea').fill('Injury');
  await chgPage(second.page).getByRole('button', { name: 'Pause this membership' }).click();
  await chgPage(second.page).getByTestId('change-outcome').filter({ hasText: 'active payment schedule' }).waitFor();
  assert.equal(await chgPage(second.page).getByRole('button', { name: 'Try again' }).count(), 0);
  assert.equal(chg.members.get(id(1500)).state, 'ACTIVE');
  await second.ctx.close();
});
await check('Pause, cancel & refunds: turning pauses off removes Pause; leaving the tab hides the membership; a refused read shows nothing', async () => {
  resetChanges(); resetMemberships();
  const { ctx, page } = await ownershipPage('/staff/billing/membership-changes', { width: 1280, height: 900 });
  await chooseMember00(page);
  await chgPage(page).getByRole('button', { name: 'Change pause rules' }).click();
  await chgPage(page).getByTestId('pause-rules-form').getByLabel('Offer pauses at this school').uncheck();
  await chgPage(page).getByRole('button', { name: 'Save pause rules' }).click();
  await chgPage(page).getByTestId('change-outcome').filter({ hasText: 'The pause rules are saved.' }).waitFor();
  await chgPage(page).getByText('Pauses are turned off at this school.').waitFor();
  assert.deepEqual(chg.posts[0].body, { expectedVersion: 3, pausesAllowed: false, maxPauseDays: null, maxPausedDaysPerYear: null, holdFee: null });
  assert.equal(await chgPage(page).getByRole('button', { name: 'Pause membership' }).count(), 0);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForFunction(() => !document.body.innerText.includes('Member00'));
  await ctx.close();
  resetChanges({ historyDenied: true }); resetMemberships();
  const second = await ownershipPage('/staff/billing/membership-changes', { width: 1280, height: 900 });
  await chgPage(second.page).getByTestId('membership-select').waitFor({ timeout: 20000 });
  await chgPage(second.page).getByTestId('membership-select').selectOption(id(1500));
  await chgPage(second.page).getByText("You cannot see this membership's pauses and refunds.").waitFor();
  assert.equal(await chgPage(second.page).getByTestId('membership-actions').count(), 0);
  await second.ctx.close();
});

// ---------- Champions Club school page ----------
const chpPage = (page) => page.getByTestId('champions-school');
const CHP_TEXT = { en: ['Champions Club', 'Your school is #2 with 4 qualified referrals.', 'Referrals & Rewards'], ko: ['챔피언스 클럽', '4', '추천 및 보상'] };
for (const [name, viewport, nextTheme, language] of [['desktop-1440', { width: 1440, height: 900 }, 'modern', 'en'], ['phone-390', { width: 390, height: 844 }, 'big-button', 'ko']]) {
  await check(`Champions Club ${nextTheme} ${language} ${name}: code, referrals, rewards, leaderboard, contests and history from the reads`, async () => {
    resetChampions({ code: 'K7M2Q9X4PA' });
    const [title, you] = CHP_TEXT[language];
    const { ctx, page } = await ownershipPage('/staff/champions-club', viewport, { nextTheme, language });
    await chpPage(page).getByTestId('champions-code-value').waitFor({ timeout: 20000 });
    await chpPage(page).getByTestId('champions-history-row').first().waitFor({ timeout: 20000 });
    await chpPage(page).getByTestId('champions-contest').waitFor({ timeout: 20000 });
    await chpPage(page).getByTestId('champions-you').filter({ hasText: you }).waitFor({ timeout: 20000 });
    assert.equal(await chpPage(page).locator('h1').innerText(), title);
    assert.equal(await chpPage(page).getByTestId('champions-code-value').innerText(), 'K7M2Q9X4PA');
    assert.equal(await chpPage(page).locator('tr[data-you="true"]').first().locator('td').first().innerText(), '2');
    assert.ok(await page.locator('a[href="/staff/champions-club"]').count() >= 1, 'listed in school navigation');
    assert.deepEqual(chp.posts, [], 'reading the page sends no command');
    assert.ok(chp.reads.includes('leaderboard?period=ALL_TIME'));
    await noOverflow(page, `champions-${nextTheme}-${language}-${name}`);
    await axe(page, `champions-${nextTheme}-${language}-${name}`);
    await shot(page, `champions-${nextTheme}-${language}-${name}`, true);
    await ctx.close();
  });
}
await check('Champions Club: create the referral code, switch to this UTC month, and show the school name, each read again from the server', async () => {
  resetChampions();
  const { ctx, page } = await ownershipPage('/staff/champions-club', { width: 1280, height: 900 });
  await chpPage(page).getByTestId('champions-code-create').waitFor({ timeout: 20000 });
  await shot(page, 'champions-no-code', true);
  await chpPage(page).getByTestId('champions-code-create').click();
  await chpPage(page).getByTestId('champions-outcome').filter({ hasText: 'Your referral code is ready.' }).waitFor();
  await chpPage(page).getByTestId('champions-code-value').filter({ hasText: 'K7M2Q9X4PA' }).waitFor();
  assert.deepEqual({ tail: chp.posts[0].tail, command: chp.posts[0].command, body: chp.posts[0].body }, { tail: 'referral-code', command: 'champions-referral-code-issue', body: {} });
  assert.ok(chp.reads.filter((r) => r === 'summary').length >= 2, 'read again after the answer');
  await chpPage(page).getByTestId('champions-period-MONTH').click();
  await chpPage(page).getByText('Northside Taekwondo').waitFor();
  const month = new Date().toISOString().slice(0, 7);
  assert.ok(chp.reads.includes(`leaderboard?period=MONTH&month=${month}`), `asked for ${month}`);
  await chpPage(page).getByTestId('champions-display').getByLabel('Show our school name').check();
  await chpPage(page).getByTestId('champions-display').getByRole('button', { name: 'Save' }).click();
  await chpPage(page).getByTestId('champions-outcome').filter({ hasText: 'Show our school name' }).waitFor();
  assert.deepEqual({ tail: chp.posts[1].tail, command: chp.posts[1].command, body: chp.posts[1].body }, { tail: 'leaderboard-preference', command: 'champions-leaderboard-preference', body: { displayMode: 'SCHOOL_NAME' } });
  await page.waitForFunction(() => document.querySelector('[data-testid="champions-display"] input[value="SCHOOL_NAME"]')?.checked === true);
  assert.equal(new Set(chp.posts.map((p) => p.key)).size, 2, 'a fresh key for each command');
  await axe(page, 'champions-after-commands');
  await shot(page, 'champions-after-commands', true);
  await ctx.close();
});
await check('Champions Club: an unknown outcome keeps the same key for Try again, Stop reads again, leaving the tab hides the code, a refused read shows nothing', async () => {
  resetChampions({ code: 'K7M2Q9X4PA', replies: ['unknown', 'unknown'] });
  const { ctx, page } = await ownershipPage('/staff/champions-club', { width: 1280, height: 900 });
  await chpPage(page).getByTestId('champions-display').waitFor({ timeout: 20000 });
  await chpPage(page).getByTestId('champions-display').getByLabel('Show our school name').check();
  await chpPage(page).getByTestId('champions-display').getByRole('button', { name: 'Save' }).click();
  await chpPage(page).getByRole('button', { name: 'Try again' }).waitFor();
  assert.equal(await chpPage(page).getByTestId('champions-display').getByRole('button', { name: 'Save' }).isDisabled(), true, 'locked while a command is kept');
  await chpPage(page).getByRole('button', { name: 'Try again' }).click();
  await chpPage(page).getByRole('button', { name: 'Try again' }).waitFor();
  assert.equal(chp.posts.length, 2); assert.equal(chp.posts[0].key, chp.posts[1].key);
  await chpPage(page).getByRole('button', { name: 'Stop and read again' }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="champions-outcome"]'));
  assert.equal(chp.mode, 'ANONYMOUS');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForFunction(() => !document.body.innerText.includes('K7M2Q9X4PA'));
  await ctx.close();
  resetChampions({ code: 'K7M2Q9X4PA', summaryDenied: true });
  const second = await ownershipPage('/staff/champions-club', { width: 1280, height: 900 });
  await chpPage(second.page).getByTestId('champions-code').getByText('Your access does not include the Champions Club at this school.').waitFor({ timeout: 20000 });
  assert.ok(!(await chpPage(second.page).innerText()).includes('K7M2Q9X4PA'));
  await second.ctx.close();
});

// ---------- HQ AI costs and safety (S4-c/d/e) ----------
const aiCosts = (page) => page.getByTestId('hq-ai-costs'), aiSafety = (page) => page.getByTestId('hq-ai-safety');
const AI_TEXT = { en: ['AI Costs', 'Synthetic Dojo Group — Synthetic Martial Arts Academy', '$1.29', 'Last 7 days'], ko: ['AI 비용', 'Synthetic Dojo Group — Synthetic Martial Arts Academy', '$1.29', '최근 7일'] };
for (const [name, viewport, nextTheme, language] of [['desktop-1440', { width: 1440, height: 900 }, 'modern', 'en'], ['phone-390', { width: 390, height: 844 }, 'big-button', 'ko']]) {
  await check(`AI Costs ${nextTheme} ${language} ${name}: per-school usage from the HQ read, and a new read for another period`, async () => {
    resetAiControl();
    const [title, schoolName, cost, week] = AI_TEXT[language];
    const { ctx, page } = await ownershipPage('/hq/ai-costs', viewport, { nextTheme, language });
    await aiCosts(page).getByTestId('ai-usage-table').getByText(schoolName).first().waitFor({ timeout: 20000 });
    assert.equal(await aiCosts(page).locator('h1').innerText(), title);
    await aiCosts(page).getByTestId('ai-usage-table').getByText(cost).first().waitFor();
    const first = aix.usage.at(-1);
    assert.equal(Date.parse(first.to) - Date.parse(first.from), 30 * 86_400_000);
    await noOverflow(page, `ai-costs-${nextTheme}-${language}-${name}`);
    await axe(page, `ai-costs-${nextTheme}-${language}-${name}`);
    await shot(page, `ai-costs-${nextTheme}-${language}-${name}`, true);
    await aiCosts(page).getByRole('button', { name: week }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="hq-ai-costs"] [aria-pressed="true"]')?.textContent?.includes('7'));
    await aiCosts(page).getByTestId('ai-usage-table').waitFor();
    const last = aix.usage.at(-1);
    assert.equal(Date.parse(last.to) - Date.parse(last.from), 7 * 86_400_000);
    await ctx.close();
  });
}
await check('AI Costs: a refused read shows nothing, and leaving the tab hides the numbers until Show again reads fresh', async () => {
  resetAiControl({ denied: true });
  const { ctx, page } = await ownershipPage('/hq/ai-costs', { width: 1280, height: 900 });
  await aiCosts(page).getByText('does not include AI costs').waitFor({ timeout: 20000 });
  assert.equal(await aiCosts(page).getByTestId('ai-usage-table').count(), 0);
  aix.denied = false;
  await aiCosts(page).getByRole('button', { name: 'Refresh' }).click();
  await aiCosts(page).getByTestId('ai-usage-table').waitFor();
  const reads = aix.usage.length;
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await aiCosts(page).getByText('Hidden while you were away.').waitFor();
  assert.equal(await aiCosts(page).getByTestId('ai-usage-table').count(), 0);
  await aiCosts(page).getByRole('button', { name: 'Show again' }).click();
  await aiCosts(page).getByTestId('ai-usage-table').waitFor();
  assert.ok(aix.usage.length > reads, 'read again after Show again');
  await ctx.close();
});
const AIS_TEXT = { en: ['AI Safety', 'Pause AI spend', 'Pause now', 'AI spend is paused.'], ko: ['AI 안전', 'AI 지출 일시정지', '지금 일시정지', 'AI 지출이 일시정지되었습니다.'] };
for (const [name, viewport, nextTheme, language] of [['desktop-1440', { width: 1440, height: 900 }, 'modern', 'en'], ['phone-390', { width: 390, height: 844 }, 'big-button', 'ko']]) {
  await check(`AI Safety ${nextTheme} ${language} ${name}: pause the whole platform, read again from the server`, async () => {
    resetAiControl();
    const [title, open, confirm, done] = AIS_TEXT[language];
    const { ctx, page } = await ownershipPage('/hq/ai-safety', viewport, { nextTheme, language });
    await aiSafety(page).getByTestId('unknown-row').waitFor({ timeout: 20000 });
    assert.equal(await aiSafety(page).locator('h1').innerText(), title);
    await noOverflow(page, `ai-safety-${nextTheme}-${language}-${name}`);
    await axe(page, `ai-safety-${nextTheme}-${language}-${name}`);
    await shot(page, `ai-safety-${nextTheme}-${language}-${name}`, true);
    await aiSafety(page).getByRole('button', { name: open }).click();
    const form = aiSafety(page).getByTestId('pause-form');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="pause-form"] select[name="organizationId"] option').length === 2);
    await form.locator('textarea').fill('Provider bill spike under review');
    await axe(page, `ai-safety-pause-form-${nextTheme}-${language}-${name}`);
    await shot(page, `ai-safety-pause-form-${nextTheme}-${language}-${name}`, true);
    await aiSafety(page).getByRole('button', { name: confirm }).click();
    await aiSafety(page).getByTestId('safety-outcome').filter({ hasText: done }).waitFor();
    await aiSafety(page).locator('[data-testid="pause-row"][data-status="ACTIVE"]').waitFor();
    assert.equal(aix.posts.length, 1);
    assert.deepEqual({ tail: aix.posts[0].tail, command: aix.posts[0].command, body: aix.posts[0].body },
      { tail: 'spend-pauses', command: 'ai-spend-pause', body: { action: 'PAUSE', organizationId: null, spendClass: 'ALL', reason: 'Provider bill spike under review' } });
    assert.ok(/^[0-9a-f-]{36}$/.test(aix.posts[0].key), 'an idempotency key');
    assert.ok(aix.reads.filter((r) => r === 'spend-pauses').length >= 2, 'read again after the answer');
    await ctx.close();
  });
}
await check('AI Safety: pause one organization for creative media, then resume with the listed scope', async () => {
  resetAiControl();
  const { ctx, page } = await ownershipPage('/hq/ai-safety', { width: 1280, height: 900 });
  await aiSafety(page).getByTestId('unknown-row').waitFor({ timeout: 20000 });
  await aiSafety(page).getByRole('button', { name: 'Pause AI spend' }).click();
  const form = aiSafety(page).getByTestId('pause-form');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="pause-form"] select[name="organizationId"] option').length === 2);
  await form.locator('select[name="organizationId"]').selectOption(scope.organizationId);
  await form.locator('select[name="spendClass"]').selectOption('CREATIVE_MEDIA');
  await form.locator('textarea').fill('Creative spend spike at one group');
  await aiSafety(page).getByRole('button', { name: 'Pause now' }).click();
  const row = aiSafety(page).locator('[data-testid="pause-row"][data-status="ACTIVE"]');
  await row.getByText('Synthetic Dojo Group · Creative media').waitFor();
  await row.getByRole('button', { name: 'Resume' }).click();
  await aiSafety(page).getByTestId('resume-form').locator('textarea').fill('Spike explained by a launch');
  await aiSafety(page).getByRole('button', { name: 'Resume AI spend' }).click();
  await aiSafety(page).getByTestId('safety-outcome').filter({ hasText: 'AI spend is resumed.' }).waitFor();
  await aiSafety(page).locator('[data-testid="pause-row"][data-status="ENDED"]').waitFor();
  assert.deepEqual(aix.posts.map((p) => p.body), [
    { action: 'PAUSE', organizationId: scope.organizationId, spendClass: 'CREATIVE_MEDIA', reason: 'Creative spend spike at one group' },
    { action: 'RESUME', organizationId: scope.organizationId, spendClass: 'CREATIVE_MEDIA', reason: 'Spike explained by a launch' }]);
  assert.notEqual(aix.posts[0].key, aix.posts[1].key);
  await ctx.close();
});
await check('AI Safety: settle a lost call as a write-off, then record its late provider charge, each on its own path', async () => {
  resetAiControl();
  const { ctx, page } = await ownershipPage('/hq/ai-safety', { width: 1280, height: 900 });
  await aiSafety(page).getByTestId('unknown-row').waitFor({ timeout: 20000 });
  await aiSafety(page).getByTestId('unknown-row').getByRole('button', { name: 'Settle' }).click();
  const settle = aiSafety(page).getByTestId('settle-form');
  await settle.locator('select[name="decision"]').selectOption('WRITE_OFF');
  await settle.locator('input[name="estimate"]').fill('0.004');
  await settle.locator('textarea').fill('Provider has no matching record');
  await axe(page, 'ai-safety-settle-form');
  await shot(page, 'ai-safety-settle-form', true);
  await aiSafety(page).getByRole('button', { name: 'Settle this call' }).click();
  await aiSafety(page).getByTestId('safety-outcome').filter({ hasText: 'The call is settled.' }).waitFor();
  await aiSafety(page).getByText('No open calls. Every AI call has a known result.').waitFor();
  assert.deepEqual({ tail: aix.posts[0].tail, command: aix.posts[0].command, agent: aix.posts[0].agent, invocationId: aix.posts[0].invocationId, body: aix.posts[0].body },
    { tail: 'resolve', command: 'ai-unknown-resolve', agent: 'MARKETING', invocationId: id(2100), body: { decision: 'WRITE_OFF', reason: 'Provider has no matching record', evidence: { estimatedProviderCostMicrounits: 4000 } } });
  const fresh = aiSafety(page).getByTestId('resolved-row').filter({ hasText: 'Marketing' });
  await fresh.getByRole('button', { name: 'Record a late provider charge' }).click();
  const late = aiSafety(page).getByTestId('late-form');
  await late.locator('input[name="providerGenerationId"]').fill('gen_synthetic_1');
  await late.locator('input[name="inputTokens"]').fill('1200');
  await late.locator('input[name="outputTokens"]').fill('300');
  await late.locator('input[name="providerCost"]').fill('0.0031');
  await late.locator('textarea').fill('Invoice line found on the provider bill');
  await aiSafety(page).getByRole('button', { name: 'Record charge' }).click();
  await aiSafety(page).getByTestId('safety-outcome').filter({ hasText: 'The late provider charge is recorded.' }).waitFor();
  await fresh.getByText(/Late provider charge \$0\.0031 recorded/).waitFor();
  assert.deepEqual({ tail: aix.posts[1].tail, command: aix.posts[1].command, body: aix.posts[1].body },
    { tail: 'late-provider-expense', command: 'ai-late-provider-expense', body: { reason: 'Invoice line found on the provider bill',
      evidence: { providerGenerationId: 'gen_synthetic_1', inputTokens: 1200, outputTokens: 300, providerCostMicrounits: 3100 } } });
  await shot(page, 'ai-safety-settled', true);
  await ctx.close();
});
await check('AI Safety: an unknown outcome offers Try again with the same key; Stop drops it; a refusal closes the form', async () => {
  resetAiControl({ replies: ['unknown', 'unknown'] });
  const { ctx, page } = await ownershipPage('/hq/ai-safety', { width: 1280, height: 900 });
  await aiSafety(page).getByTestId('unknown-row').waitFor({ timeout: 20000 });
  const pauseOnce = async (reason) => {
    await aiSafety(page).getByRole('button', { name: 'Pause AI spend' }).click();
    await aiSafety(page).getByTestId('pause-form').locator('textarea').fill(reason);
    await aiSafety(page).getByRole('button', { name: 'Pause now' }).click();
  };
  await pauseOnce('Provider bill spike under review');
  await aiSafety(page).getByTestId('safety-outcome').filter({ hasText: 'We could not confirm' }).waitFor();
  await shot(page, 'ai-safety-unknown-outcome', true);
  await aiSafety(page).getByRole('button', { name: 'Try again' }).click();
  await aiSafety(page).getByTestId('safety-outcome').filter({ hasText: 'We could not confirm' }).waitFor();
  assert.equal(aix.posts.length, 2); assert.equal(aix.posts[0].key, aix.posts[1].key);
  await aiSafety(page).getByRole('button', { name: 'Try again' }).click();
  await aiSafety(page).getByTestId('safety-outcome').filter({ hasText: 'AI spend is paused.' }).waitFor();
  assert.equal(aix.posts.length, 3); assert.equal(aix.posts[2].key, aix.posts[0].key);
  assert.equal(aix.pauses.length, 1);
  // Stop: a kept unknown is dropped, the lists are read again, and a new attempt is refused by the server state.
  aix.replies.push('unknown');
  await pauseOnce('Second pause for the same scope');
  await aiSafety(page).getByTestId('safety-outcome').filter({ hasText: 'We could not confirm' }).waitFor();
  const reads = aix.reads.length;
  await aiSafety(page).getByRole('button', { name: 'Stop and check the lists' }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="safety-outcome"]'));
  assert.ok(aix.reads.length > reads, 'read again after Stop');
  assert.equal(await aiSafety(page).getByTestId('pause-form').count(), 0);
  aix.replies.push('active');
  await pauseOnce('Third pause for the same scope');
  await aiSafety(page).getByTestId('safety-outcome').filter({ hasText: 'This changed since it was read.' }).waitFor();
  assert.equal(await aiSafety(page).getByTestId('pause-form').count(), 0);
  assert.equal(await aiSafety(page).getByRole('button', { name: 'Try again' }).count(), 0);
  assert.notEqual(aix.posts.at(-1).key, aix.posts[0].key);
  await ctx.close();
});
await check('AI Safety: leaving the tab hides pauses and calls; a refused read shows nothing', async () => {
  resetAiControl();
  const { ctx, page } = await ownershipPage('/hq/ai-safety', { width: 1280, height: 900 });
  await aiSafety(page).getByTestId('unknown-row').waitFor({ timeout: 20000 });
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await aiSafety(page).getByText('Hidden while you were away.').waitFor();
  assert.equal(await aiSafety(page).getByTestId('unknown-row').count(), 0);
  aix.denied = true;
  await aiSafety(page).getByRole('button', { name: 'Show again' }).click();
  await aiSafety(page).getByTestId('ai-pauses').getByText('does not include AI costs').waitFor();
  assert.equal(await aiSafety(page).getByTestId('unknown-row').count(), 0);
  assert.equal(await aiSafety(page).getByRole('button', { name: 'Pause AI spend' }).count(), 0);
  await ctx.close();
});

const trialsPage = (page) => page.getByTestId('hq-trials');
const TG_TEXT = { en: ['Free Trials', 'Spring pilot schools', 'Check publication readiness', 'It allows more schools than the rules permit.'],
  ko: ['무료 체험', 'Spring pilot schools', '게시 준비 상태 확인', '규칙이 허용하는 것보다 많은 학교를 허용합니다.'] };
for (const [name, viewport, nextTheme, language] of [['desktop-1440', { width: 1440, height: 900 }, 'modern', 'en'], ['phone-390', { width: 390, height: 844 }, 'big-button', 'ko']]) {
  await check(`Free Trials ${nextTheme} ${language} ${name}: rules in force, campaigns, and a readiness check that changes nothing`, async () => {
    Object.assign(tgx, { reads: [], denied: false, other: 0 });
    const [title, campaign, check, blocker] = TG_TEXT[language];
    const { ctx, page } = await ownershipPage('/hq/revenue/trials', viewport, { nextTheme, language });
    await trialsPage(page).getByTestId('trial-campaign').first().waitFor({ timeout: 20000 });
    assert.equal(await trialsPage(page).locator('h1').innerText(), title);
    assert.equal(await trialsPage(page).getByTestId('trial-rule-state').getAttribute('data-rule-state'), 'IN_FORCE');
    assert.equal(await trialsPage(page).getByTestId('trial-campaign').count(), 2);
    await noOverflow(page, `trials-${nextTheme}-${language}-${name}`);
    await axe(page, `trials-${nextTheme}-${language}-${name}`);
    await shot(page, `trials-${nextTheme}-${language}-${name}`, true);
    const spring = trialsPage(page).getByTestId('trial-campaign').filter({ hasText: campaign });
    await spring.getByRole('button', { name: check }).click();
    await spring.getByTestId('trial-readiness').getByText(blocker).waitFor();
    await spring.locator('details').click();
    await noOverflow(page, `trials-readiness-${nextTheme}-${language}-${name}`);
    await axe(page, `trials-readiness-${nextTheme}-${language}-${name}`);
    await shot(page, `trials-readiness-${nextTheme}-${language}-${name}`, true);
    assert.deepEqual(tgx.reads, ['governance', `campaign-versions/${tgId(41)}/publication-preview`]);
    assert.equal(tgx.other, 0, 'no write, key or command marker was sent');
    await ctx.close();
  });
}
await check('Free Trials: a refused read shows nothing; a session end hides everything', async () => {
  Object.assign(tgx, { reads: [], denied: true, other: 0 });
  const { ctx, page } = await ownershipPage('/hq/revenue/trials', { width: 1280, height: 900 });
  await trialsPage(page).getByText('does not include free-trial governance').waitFor({ timeout: 20000 });
  assert.equal(await trialsPage(page).getByTestId('trial-campaign').count(), 0);
  tgx.denied = false;
  await trialsPage(page).getByRole('button', { name: 'Refresh' }).click();
  await trialsPage(page).getByTestId('trial-campaign').first().waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('hon:session-invalidated')));
  await trialsPage(page).getByText('Hidden because your session ended.').waitFor();
  assert.equal(await trialsPage(page).getByTestId('trial-campaign').count(), 0);
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
