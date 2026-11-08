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
  if (path === '/api/v1/hq/overview') return json(route, 200, { data: { overview: { asOf: '2026-10-24T15:00:00.000Z', callerHqRole: hqx.owner ? 'OWNER' : 'OPERATOR', organizationCount: 3, schoolCount: 3,
    onboarding: { availability: 'AVAILABLE', requestCount: 0, inProgressRequestCount: 0, completedRequestCount: 0 }, configuredProviderStates: { disabled: 0, configured: 0, healthy: 0, degraded: 0, unavailable: 0 }, taskProfileCount: 0,
    financialMetrics: { availability: 'UNAVAILABLE', reason: 'No authoritative HQ financial MRR, ARR, cash, or gross-margin projection is available.' },
    aiUsage: { availability: 'UNAVAILABLE', reason: 'No authoritative HQ AI usage or cost projection is available.' },
    durableHqWork: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: 'No durable HQ executive work is recorded or active in HQ-1.' } } } });
  if (path.startsWith('/api/v1/hq/saas/')) { const answered = await hqAccessApi(route, path, method, url); if (answered !== null) return answered; }
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
const hqx = { owner: true, ready: true, orgs: [], posts: [], replies: [], byKey: new Map(), gate: null };
const HQX_T = '2026-10-01T00:00:00.000Z';
const hqEnt = (o) => o.ent && { ...o.ent, inEffect: o.ent.status === 'ACTIVE' && Date.parse(o.ent.effectiveFrom) <= Date.now() && (!o.ent.effectiveUntil || Date.parse(o.ent.effectiveUntil) > Date.now()) };
function resetHqx(over = {}) {
  hqx.orgs = [
    { id: id(401), name: 'Synthetic Dojo North', created: '2026-09-01T00:00:00.000Z', schools: [[id(411), 'North Academy', 'ACTIVE']], state: 'PROVISIONED', ent: { tier: 'COMPLETE', status: 'SUSPENDED', effectiveFrom: HQX_T, effectiveUntil: null, version: 2 }, exception: null, subscription: null, owner: 'PENDING' },
    { id: id(402), name: 'Synthetic Dojo South', created: '2026-09-02T00:00:00.000Z', schools: [[id(412), 'South Academy', 'ACTIVE']], state: 'PROVISIONED', ent: { tier: 'COMPLETE', status: 'ACTIVE', effectiveFrom: HQX_T, effectiveUntil: '2026-12-30T00:00:00.000Z', version: 3 },
      exception: { exceptionId: id(452), schoolId: id(412), purpose: 'APPROVED_PILOT', scopeTier: 'COMPLETE', startsAt: HQX_T, expiresAt: '2026-12-30T00:00:00.000Z', reason: 'Approved pilot for a fixture partner' }, subscription: null, owner: 'ACCEPTED' },
    { id: id(403), name: 'Synthetic Dojo East', created: '2026-09-03T00:00:00.000Z', schools: [[id(413), 'East Academy', 'ACTIVE']], state: 'PAYMENT_ACTIVE', ent: { tier: 'COMPLETE', status: 'ACTIVE', effectiveFrom: HQX_T, effectiveUntil: null, version: 5 }, exception: null,
      subscription: { subscriptionId: id(463), status: 'ACTIVE', planCode: 'COMPLETE', billingInterval: 'MONTH' }, owner: 'ACCEPTED' }];
  Object.assign(hqx, { owner: true, ready: true, posts: [], replies: [], byKey: new Map(), gate: null }, over);
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
function hqOverview(statusFilter) {
  const rows = hqx.orgs.map(hqRow);
  const summary = Object.fromEntries(['AWAITING_FIRST_PAYMENT', 'EXCEPTION_IN_EFFECT', 'EXCEPTION_SCHEDULED', 'PAID_ACCESS', 'PROVISIONED_ACCESS', 'NO_ACCESS'].map((k) => [k, rows.filter((r) => r.accessStatus === k).length]));
  return { viewer: { canGrantAndRevokeExceptions: hqx.owner }, paidAccessProgram: 'INACTIVE',
    exceptionPolicy: hqx.ready ? { ready: true, maxDays: 90, validUntil: '2027-10-01T00:00:00.000Z', maxScheduleAheadDays: 30 } : { ready: false, maxDays: null, validUntil: null, maxScheduleAheadDays: 30 },
    summary: { ...summary, total: rows.length }, organizations: rows.filter((r) => !statusFilter || r.accessStatus === statusFilter), limit: 25, nextCursor: null, asOf: new Date().toISOString() };
}
const hqAccessView = (o) => { const ent = hqEnt(o), inEffect = ent?.inEffect === true;
  return { organizationId: o.id, state: o.state, source: !inEffect ? 'NONE' : o.state === 'PAYMENT_ACTIVE' ? 'PAYMENT_ACTIVATED' : 'PROVISIONED', entitlement: ent,
    capabilities: inEffect ? [...SAAS_PLAN_CAPABILITIES[ent.tier]] : [], paidAccessProgram: 'INACTIVE' }; };
async function hqAccessApi(route, path, method, url) {
  if (path === '/api/v1/hq/saas/access-overview' && method === 'GET') return json(route, 200, { data: hqOverview(url.searchParams.get('status')) }, { 'Cache-Control': 'private, no-store' });
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
  return json(route, 200, { data }, { 'Cache-Control': 'private, no-store' });
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
  const selectors = await page.evaluate(() => ['[role="dialog"]', 'section[aria-labelledby="hon-band-title"]', 'main[data-variant]', 'section[aria-labelledby="hq-access-title"]'].filter((s) => document.querySelector(s)));
  const result = await run(selectors);
  report.accessibility.push({ name, scope: selectors, violations: result, wholePage: await run(null) });
  const serious = result.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  assert.equal(serious.length, 0, `${name}: ${JSON.stringify(serious)}`);
}
// The existing Platform View picker (not part of this change) overflows in Classic at
// phone width; it is recorded as a pre-existing finding and excluded from this gate.
async function noOverflow(page, name) {
  const offenders = await page.evaluate(() => [...document.querySelectorAll('body *')]
    .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(e).position !== 'fixed')
    .map((e) => ({ el: `${e.tagName}.${e.className}`, preExisting: !!e.closest('.view-picker') })));
  const preExisting = offenders.filter((o) => o.preExisting);
  if (preExisting.length) report.preExistingFindings.push(`${name ?? 'page'}: Platform View picker overflows (${preExisting.length} elements)`);
  assert.deepEqual(offenders.filter((o) => !o.preExisting), [], 'horizontal overflow');
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
