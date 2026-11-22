/**
 * Disposable local browser proof for the U1 school shell and the U2 school Home. Synthetic fixtures only:
 * every /api request is answered in the browser by this script. No database,
 * provider, payment or production backend is used. Requires `pnpm build` first.
 *
 *   HON_SHELL_BROWSER_LOCAL=1 HON_SHELL_BROWSER_RESULTS=<dir> node apps/web/scripts/school-shell-browser.mjs
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

if (process.env.HON_SHELL_BROWSER_LOCAL !== '1') throw new Error('Opt in with HON_SHELL_BROWSER_LOCAL=1.');
for (const key of ['DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY']) {
  if (process.env[key]) throw new Error('Browser verification refuses inherited database/provider credentials.');
}
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = process.env.HON_SHELL_BROWSER_RESULTS;
assert(results, 'HON_SHELL_BROWSER_RESULTS is required.');
const { chromium } = createRequire(import.meta.url)(process.env.HON_SHELL_PLAYWRIGHT ?? 'playwright');
await mkdir(results, { recursive: true });
// Optional: path to axe-core's axe.min.js for a WCAG 2.1 AA scan of the shell and Home.
const axeSource = process.env.HON_SHELL_AXE ? await (await import('node:fs/promises')).readFile(process.env.HON_SHELL_AXE, 'utf8') : null;
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

// Rank setup (0622) synthetic fixtures: one program with three belts, two students. The mock keeps belts added in this run.
const rsRank = (n, name, color, order, students, requirements = [], classes = 0, days = 0) => ({ id: id(700 + n), name, color, order, version: 1, classes, days, students, requirements });
let rankSetupState = null;
const rankSetup = () => rankSetupState ??= { programs: [{ id: id(690), name: 'Kids Taekwondo', version: 1, ranks: [
  rsRank(1, 'White belt', '#FFFFFF', 1, 1, [{ id: id(721), code: 'FRONT_KICK', kind: 'TECHNIQUE', label: 'Front kick, both legs', description: '', required: true, version: 1 },
    { id: id(722), code: 'RESPECT', kind: 'CHARACTER', label: 'Bows in and out of class', description: '', required: true, version: 1 }], 24, 60),
  rsRank(2, 'Yellow belt', '#FACC15', 2, 1, [{ id: id(723), code: 'TAEGEUK_1', kind: 'TECHNIQUE', label: 'Taegeuk 1', description: 'Whole form without help.', required: true, version: 1 }]),
  rsRank(3, 'Orange belt', '#F97316', 3, 0)] }, { id: id(691), name: 'Adult Karate', version: 1, ranks: [] }],
  students: [{ enrollmentId: id(731), programId: id(690), studentProfileId: id(741), givenName: 'Avery', familyName: 'Sample', currentRankId: id(701), version: 1 },
    { enrollmentId: id(732), programId: id(690), studentProfileId: id(742), givenName: 'Rowan', familyName: 'Example', currentRankId: id(702), version: 1 }] };
// Parent app > Curriculum synthetic fixtures (names and links are placeholders).
const pcRes = (n, patch) => ({ id: id(1000 + n), curriculumId: id(960), rankId: null, cycleId: null, kind: 'VIDEO', url: `https://www.youtube.com/watch?v=sample${n}`, title: `Sample ${n}`, description: '', audience: 'PARENT', status: 'ACTIVE', version: 1, ...patch });
const pcSettings = (patch) => ({ saved: true, version: 3, displayMode: 'CYCLE', showInApp: true, rankShowEarlier: false, rankShowNext: false, cycleRotation: 'AUTO', cycleAnchorDate: '2026-11-02', cycleLengthWeeks: 2, cycleShowNext: true, ...patch });
const parentCurriculum = () => ({ timeZone: 'America/Los_Angeles', curricula: [
  { id: id(960), name: 'Little Dragons', modelCode: 'ROTATIONAL', lifecycle: 'PUBLISHED', ranks: [],
    app: { curriculumId: id(960), settings: pcSettings({}), cycles: [['Cycle 1: Stances', 961], ['Cycle 2: Kicks', 962], ['Cycle 3: Forms', 963]].map(([name, n], i) => ({ id: id(n), name, position: i + 1, version: 1 })),
      cycleState: { today: '2026-11-19', current: { id: id(962), name: 'Cycle 2: Kicks', startsOn: '2026-11-16', endsOn: '2026-11-29' }, next: { id: id(963), name: 'Cycle 3: Forms', startsOn: '2026-11-30' } } },
    resources: [pcRes(1, { cycleId: id(962), title: 'Front kick drill', description: 'Practice 10 each side.' }), pcRes(2, { cycleId: id(962), kind: 'DOCUMENT', title: 'Kicks checklist', url: 'https://drive.google.com/file/d/sample2' }),
      pcRes(3, { cycleId: id(961), title: 'Horse stance' }), pcRes(4, { kind: 'LINK', title: 'Student handbook', url: 'https://example.com/handbook' })] },
  { id: id(970), name: 'Adult Karate', modelCode: 'LINEAR', lifecycle: 'PUBLISHED', ranks: [['White', '#FFFFFF', 971], ['Yellow', '#FFD400', 972], ['Orange', '#FF8A00', 973]].map(([name, color, n], i) => ({ id: id(n), name, color, order: i + 1 })),
    app: { curriculumId: id(970), settings: pcSettings({ displayMode: 'RANK', cycleRotation: 'STAFF_PICK', cycleAnchorDate: null, cycleLengthWeeks: null, rankShowNext: true }), cycles: [], cycleState: { today: '2026-11-19', current: null, next: null } },
    resources: [pcRes(5, { curriculumId: id(970), rankId: id(971), title: 'White belt form' })] }] });
const parentCurriculumPreview = () => ({ childDisplayName: 'Avery Sample', curricula: [{ curriculumName: 'Little Dragons', mode: 'CYCLE', rank: null, cycle: { name: 'Cycle 2: Kicks', startsOn: '2026-11-16', endsOn: '2026-11-29', rotation: 'AUTO' },
  next: { name: 'Cycle 3: Forms', startsOn: '2026-11-30' }, sections: [{ label: 'CURRENT', items: [{ title: 'Front kick drill', description: 'Practice 10 each side.', kind: 'VIDEO', url: 'https://www.youtube.com/watch?v=sample1' },
    { title: 'Kicks checklist', description: '', kind: 'DOCUMENT', url: 'https://drive.google.com/file/d/sample2' }] }, { label: 'ALL', items: [{ title: 'Student handbook', description: '', kind: 'LINK', url: 'https://example.com/handbook' }] }] }] });
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
const textRows = () => [
  { conversationId: id(901), channel: 'SMS', contactAddress: '+15555550101', contactName: 'Avery Sample', personId: id(850), leadId: id(201), leadStatus: 'OPEN', leadStage: 'Trial booked', status: 'OPEN', unread: 1,
    tags: ['trial'], assignedTo: null, lastMessage: { direction: 'INBOUND', preview: 'Can we move the trial to Thursday?', mediaCount: 0, at: at(-1800_000) }, lastMessageAt: at(-1800_000), lastInboundAt: at(-1800_000), version: 3 },
  { conversationId: id(902), channel: 'SMS', contactAddress: '+15555550199', contactName: null, personId: null, leadId: null, leadStatus: null, leadStage: null, status: 'OPEN', unread: 0,
    tags: [], assignedTo: null, lastMessage: { direction: 'OUTBOUND', preview: 'Thanks for reaching out!', mediaCount: 0, at: at(-day) }, lastMessageAt: at(-day), lastInboundAt: at(-day - 60_000), version: 2 },
];
const textThread = () => [
  { messageId: id(911), direction: 'INBOUND', author: 'CONTACT', staffName: null, body: 'Hi, is the kids class open on Tuesday?', mediaCount: 0, at: at(-day), delivery: null },
  { messageId: id(912), direction: 'OUTBOUND', author: 'STAFF', staffName: 'Synthetic Owner', body: 'Yes! 4:30 PM. Want me to book a free trial?', mediaCount: 0, at: at(-day + 600_000), delivery: 'DELIVERED' },
  { messageId: id(913), direction: 'INBOUND', author: 'CONTACT', staffName: null, body: 'Can we move the trial to Thursday?', mediaCount: 0, at: at(-1800_000), delivery: null },
];
// Corner HON pop-up (2026-11-19): two synthetic HON conversations, read-only.
const honDetail = { mode: 'STANDARD', step: 1, maxSteps: 3, truncated: false, canContinue: false, continuesTurnId: null, suggestions: [], followUps: [], sources: [] };
const honConversations = [[901, 'Plan this week', 'What should I focus on this week?', 'Follow up the 5 new leads first, then confirm the 2 trials tomorrow.'],
  [902, 'Belt testing', 'When is the next belt test?', 'One testing event is scheduled in the next 30 days.']].map(([n, title, question, answer]) => ({
  id: id(n), title, createdAt: iso(), updatedAt: iso(), turnCount: 1, status: 'COMPLETED', turns: [
    { turnId: id(n + 50), role: 'HUMAN', text: question, createdAt: iso(), status: 'COMPLETED', reason: null, references: { workItemId: null, actionRequestId: null, invocationId: null }, replyDetail: null },
    { turnId: id(n + 50), role: 'hon', text: answer, createdAt: iso(), status: 'COMPLETED', reason: null, references: { workItemId: id(n + 60), actionRequestId: null, invocationId: id(n + 70) }, replyDetail: honDetail }] }));
function honApi(route, path, base) {
  if (path === `${base}/readiness`) return json(route, 200, { data: { contract: true, providerRoute: true, entitlement: true, authorization: true, availableAgentKeys: [], honReply: true, businessPerformance: false, availableAnalystKeys: [], asOf: iso() }, meta: { requestId: 'r', correlationId: 'r' } });
  if (path === `${base}/conversations`) return json(route, 200, { data: { items: honConversations.map(({ turns, ...rest }) => rest), nextCursor: null } });
  const thread = honConversations.find((c) => path === `${base}/conversations/${c.id}`);
  if (thread) return json(route, 200, { data: thread });
  if (honConversations.some((c) => path === `${base}/conversations/${c.id}/orchestrations`)) return json(route, 200, { data: { items: [] } });
  return json(route, 403, { code: 'FORBIDDEN' });
}
const json = (route, status, body) => route.fulfill({ status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }, body: JSON.stringify(body) });
function api(route) {
  const url = new URL(route.request().url()), path = url.pathname, method = route.request().method();
  report.apiRequests.push(`${method} ${path}`);
  if (path === '/api/identity/me' && sessionEnded) return json(route, 401, { error: { code: 'UNAUTHENTICATED' } });
  if (path === '/api/identity/me') return json(route, 200, { data: { externalSubject: 'shell-synthetic-owner', displayName: 'Synthetic Owner' } });
  if (path === '/api/v1/staff/current-reporting-school') return json(route, 200, { data: multi ? { state: 'MANUAL_ENTRY_REQUIRED' } : { state: 'RESOLVED', ...schoolA } });
  if (path === '/api/v1/staff/reporting-schools') return json(route, 200, { data: multi
    ? { state: 'SELECTION_REQUIRED', schools: [{ ...schoolA, organizationName: 'Synthetic Dojo Group', schoolName: 'Synthetic North Academy' }, { ...schoolB, organizationName: 'Synthetic Dojo Group', schoolName: 'Synthetic South Academy' }] }
    : { state: 'MANUAL_ENTRY_REQUIRED' } });
  if (path === '/api/v1/staff/work') return json(route, 200, { data: work(multi ? schoolB : schoolA) });
  for (const scope of [schoolA, schoolB]) {
    const prefix = `/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}`;
    if (path.startsWith(`${prefix}/hon/`)) return honApi(route, path, `${prefix}/hon`);
    if (path === `${prefix}/command-center`) return json(route, 200, { data: { commandCenter: commandCenter(scope) }, meta: {} });
    if (path === `${prefix}/ai/team/capabilities`) return readinessDenied ? json(route, 403, { code: 'AI_TEAM_READINESS_FORBIDDEN' }) : json(route, 200, { data: readiness(scope), meta: { requestId: 'r', correlationId: 'r' } });
    if (path === `${prefix}/crm/leads`) return leadsGate ? leadsGate.then(() => json(route, 200, { data: leads(), meta: {} })) : json(route, 200, { data: leads(), meta: {} });
    if (path === `${prefix}/schedule/sessions`) return json(route, 200, { data: sessions(), meta: { requestId: id(700), correlationId: id(700) } });
    // Texts > Conversations (0364) and Parent app (0330): synthetic inboxes for the TE3a layout checks.
    if (path === `${prefix}/conversations`) return json(route, 200, { data: { conversations: textRows(), nextCursor: null, unreadConversations: 1, canManage: true }, meta: {} });
    if (path === `${prefix}/conversations/${id(901)}`) return json(route, 200, { data: { conversation: textRows()[0], contact: { person: { personId: id(850), givenName: 'Avery', familyName: 'Sample',
      phone: '+15555550101', email: 'avery@example.test', smsConsent: 'OPTED_IN' }, lead: { leadId: id(201), status: 'OPEN', pipeline: 'Kids', stage: 'Trial booked', source: 'Website', createdAt: at(-2 * day) },
      nextAppointment: null, peopleWithNumber: 1, schoolCanText: true }, messages: textThread(), hasOlder: false, canManage: true }, meta: {} });
    if (path === `${prefix}/family-messages`) return json(route, 200, { data: { threads: [{ threadId: id(951), familyId: id(961), familyName: 'Sample family', lastMessageAt: at(-3600_000), lastFrom: 'FAMILY',
      messageCount: 2, unreadCount: 1, version: 2 }, { threadId: id(952), familyId: id(962), familyName: 'Example family', lastMessageAt: at(-2 * day), lastFrom: 'SCHOOL', messageCount: 3, unreadCount: 0, version: 3 }], unreadThreads: 1 }, meta: {} });
    if (path === `${prefix}/family-messages/${id(951)}`) return json(route, 200, { data: { threadId: id(951), familyId: id(961), familyName: 'Sample family', version: 2, unreadCount: 1,
      messages: [{ messageId: id(971), from: 'SCHOOL', mine: true, body: 'Welcome to the parent app!', sentAt: at(-day) }, { messageId: id(972), from: 'FAMILY', mine: false, body: 'Thanks! Is there class on Friday?', sentAt: at(-3600_000) }] }, meta: {} });
    if (path === `${prefix}/people`) return json(route, 200, { data: [['Avery', 'Sample', '+15555550101', 'avery@example.test'], ['Rowan', 'Example', null, 'rowan@example.test']]
      .map(([givenName, familyName, phoneE164, email], i) => ({ id: id(850 + i), givenName, familyName, email, phoneE164, version: 1, createdAt: iso() })), meta: { requestId: id(860), correlationId: id(860) } });
    // Texts > History, Templates, Opted out (TE3b over 0585/0586): synthetic rows, newest first.
    // Email (TE4) asks with channel=EMAIL: synthetic emails with a subject.
    const asked = new URL(route.request().url()).searchParams.get('channel');
    if (path === `${prefix}/communications/history` && asked === 'EMAIL') return json(route, 200, { data: { nextCursor: null, messages: [
      ['Avery Sample', 'avery@example.test', 'Your trial class is booked', 'Hi Avery, your trial class is Thursday at 5 PM.', 'STAFF', 'DELIVERED', 'DELIVERED', 'Kim Placeholder', 1],
      ['Rowan Example', 'rowan@example.test', 'Belt testing this Saturday', 'Belt testing starts at 10 AM. Please arrive early.', 'CAMPAIGN', 'FAILED', 'FAILED', null, 2],
    ].map(([personName, address, subject, preview, origin, delivery, outcome, by, n]) => ({ messageId: id(970 - n), personId: id(850), personName, address, channel: 'EMAIL', subject, preview,
      at: new Date(Date.parse(at(-n * 3600_000))).toISOString(), origin, delivery, outcome, by })) }, meta: {} });
    if (path === `${prefix}/communications/opted-out` && asked === 'EMAIL') return json(route, 200, { data: { nextCursor: null, contacts: [
      ['Sample Parent', 'parent@example.test', 'STAFF', 2]].map(([personName, address, source, n]) => ({ consentId: id(965 - n), personId: id(860 + n),
      personName, address, channel: 'EMAIL', source, optedOutAt: new Date(Date.parse(at(-n * day))).toISOString(), at: new Date(Date.parse(at(-n * day))).toISOString() })) }, meta: {} });
    if (path === `${prefix}/communications/templates` && method === 'GET' && asked === 'EMAIL') {
      const status = new URL(route.request().url()).searchParams.get('status') ?? 'ACTIVE';
      return json(route, 200, { data: { templates: status !== 'ACTIVE' ? [] : [
        ['Trial welcome', 'Welcome to {{school_name}}, {{first_name}}', 'Hi {{first_name}},\n\nThanks for booking a trial class. Wear comfortable clothes and bring water.\n\nSee you soon!', 1],
        ['Belt testing', 'Belt testing this Saturday', 'Hi {{first_name}}, belt testing starts at 10 AM on Saturday. Please arrive 15 minutes early.', 2],
      ].map(([name, subject, body, n]) => ({ templateId: id(975 + n), channel: 'EMAIL', name, subject, body, status: 'ACTIVE', version: 1,
        createdAt: new Date(Date.parse(at(-10 * day))).toISOString(), updatedAt: new Date(Date.parse(at(-n * day))).toISOString() })) }, meta: {} });
    }
    if (path === `${prefix}/communications/history`) return json(route, 200, { data: { nextCursor: null, messages: [
      ['Avery Sample', '+15555550101', 'See you at the trial class on Thursday at 5 PM!', 'STAFF', 'DELIVERED', 'DELIVERED', 'Kim Placeholder', 1],
      ['Rowan Example', null, 'Reminder: belt testing is this Saturday at 10 AM.', 'CAMPAIGN', 'FAILED', 'FAILED', null, 2],
      ['Avery Sample', '+15555550101', 'Thanks for your message, a coach will text you back soon.', 'AUTOMATION', 'SENDING', 'IN_PROGRESS', null, 3],
      ['Kim Placeholder', '+15555550103', 'Yes, Thursday works. See you then.', 'CONVERSATION', 'ACCEPTED', 'DELIVERED', 'Avery Sample', 4],
    ].map(([personName, address, preview, origin, delivery, outcome, by, n]) => ({ messageId: id(990 - n), personId: id(850), personName, address, channel: 'SMS', subject: null, preview,
      at: new Date(Date.parse(at(-n * 3600_000))).toISOString(), origin, delivery, outcome, by })) }, meta: {} });
    if (path === `${prefix}/communications/opted-out`) return json(route, 200, { data: { nextCursor: null, contacts: [
      ['Sample Parent', '+15555550110', 'RECIPIENT', 1], ['Example Guardian', '+15555550111', 'STAFF', 5]].map(([personName, address, source, n]) => ({ consentId: id(995 - n), personId: id(860 + n),
      personName, address, channel: 'SMS', source, optedOutAt: new Date(Date.parse(at(-n * day))).toISOString(), at: new Date(Date.parse(at(-n * day))).toISOString() })) }, meta: {} });
    if (path === `${prefix}/communications/templates` && method === 'GET') {
      const status = new URL(route.request().url()).searchParams.get('status') ?? 'ACTIVE';
      return json(route, 200, { data: { templates: status !== 'ACTIVE' ? [] : [
        ['Class cancelled', 'Hi {{first_name}}, class is cancelled tonight because of the weather. See you next time!', 1],
        ['Missed class', 'Hi {{first_name}}, we missed you at class this week. Reply here if you need a new time.', 2],
        ['Trial reminder', 'Hi {{first_name}}, this is {{school_name}}. Your trial class is tomorrow. Wear comfortable clothes and bring water.', 3],
      ].map(([name, body, n]) => ({ templateId: id(980 + n), channel: 'SMS', name, subject: null, body, status: 'ACTIVE', version: 1,
        createdAt: new Date(Date.parse(at(-10 * day))).toISOString(), updatedAt: new Date(Date.parse(at(-n * day))).toISOString() })) }, meta: {} });
    }
    if (path === `${prefix}/staff-roles/lists`) return json(route, 200, { data: { roles: [{ id: id(880), code: 'CUSTOM_FRONT_DESK', name: 'Front desk', version: 1, permissionCodes: ['school.view', 'crm.lead.read'] }], grants: [] }, meta: {} });
    if (path === `${prefix}/staff-roles/permissions`) return json(route, 200, { data: [['school.view', 'View the school', false], ['attendance.record', 'Record attendance', false], ['attendance.cards.manage', 'Choose how attendance cards look', true], ['crm.lead.read', 'Read leads', false], ['billing.refund.create', 'Create refunds', true]]
      .map(([code, description, sensitive]) => ({ code, description, sensitive })), meta: {} });
    // Rank setup (0622): read, and adding a belt appends it at the end.
    if (path === `/api/v1/staff/schools/${scope.schoolId}/rank-setup`) return json(route, 200, { data: rankSetup(), meta: { requestId: id(750), correlationId: id(750), replayed: false } });
    if (method === 'POST' && path === `/api/v1/staff/schools/${scope.schoolId}/rank-setup/programs/${id(690)}/ranks`) {
      const body = JSON.parse(route.request().postData() ?? '{}'), p = rankSetup().programs[0];
      p.ranks.push(rsRank(p.ranks.length + 10, body.name, body.color, p.ranks.length + 1, 0, [], body.classes, body.days)); p.version += 1;
      return json(route, 200, { data: p, meta: { requestId: id(751), correlationId: id(751), replayed: false } });
    }
    // Quick setup creates the program and all its belts in one command; removing a belt closes the order up.
    if (method === 'POST' && path === `/api/v1/staff/schools/${scope.schoolId}/rank-setup/quick-setup`) {
      const body = JSON.parse(route.request().postData() ?? '{}');
      const p = { id: id(692), name: body.name, version: 1, ranks: body.ranks.map((b, i) => rsRank(50 + i, b.name, b.color, i + 1, 0, [], b.classes, b.days)) };
      rankSetup().programs.push(p);
      return json(route, 200, { data: p, meta: { requestId: id(752), correlationId: id(752), replayed: false } });
    }
    if (method === 'POST' && /\/rank-setup\/programs\/[0-9a-f-]{36}\/ranks\/[0-9a-f-]{36}\/remove$/.test(path)) {
      const [, pid, rid] = path.match(/programs\/([0-9a-f-]{36})\/ranks\/([0-9a-f-]{36})\/remove$/), p = rankSetup().programs.find((x) => x.id === pid);
      p.ranks = p.ranks.filter((k) => k.id !== rid).map((k, i) => ({ ...k, order: i + 1 }));
      return json(route, 200, { data: p, meta: { requestId: id(753), correlationId: id(753), replayed: false } });
    }
    // Parent app > Curriculum (0605/0610): one cycle-based and one rank-based synthetic curriculum.
    if (method === 'POST' && /\/parent-app\/curriculum\/[0-9a-f-]{36}\/cycles$/.test(path)) return json(route, 409, { code: 'CYCLE_NAME_TAKEN' });
    if (path === `/api/v1/staff/schools/${scope.schoolId}/parent-app/curriculum`) return json(route, 200, { data: parentCurriculum(), meta: { requestId: id(990), correlationId: id(990), replayed: false } });
    if (path === `/api/v1/staff/schools/${scope.schoolId}/parent-app/curriculum/preview/${id(820)}`) return json(route, 200, { data: parentCurriculumPreview(), meta: { requestId: id(991), correlationId: id(991), replayed: false } });
    if (path === `${prefix}/journey-recommendations`) return json(route, 200, { data: { recommendations: [], programs: [], checkouts: [], events: [] }, meta: { requestId: id(992), correlationId: id(992), replayed: false } });
    if (path === `${prefix}/pickers/enrollments`) return json(route, 200, { data: [['Avery', 'Sample'], ['Rowan', 'Example']].map(([givenName, familyName], i) => ({ enrollmentId: id(980 + i),
      curriculumId: new URL(route.request().url()).searchParams.get('curriculumId') ?? id(960), curriculumName: 'Little Dragons', studentProfileId: id(820 + i), givenName, familyName, currentRankId: null, currentRankName: null, nextRankId: null, nextRankName: null, version: 1 })),
      meta: { requestId: id(985), correlationId: id(985), limit: 50 } });
    if (path === `${prefix}/pickers/students`) return json(route, 200, { data: [['Kim', 'Placeholder', 743], ['Jordan', 'Sample', 744]].map(([givenName, familyName, n]) => ({ studentProfileId: id(n), givenName, familyName })),
      meta: { requestId: id(745), correlationId: id(745), limit: 50 } });
    if (path === `${prefix}/pickers/staff`) return json(route, 200, { data: [['Avery Sample', 870], ['Rowan Example', 871], ['Kim Placeholder', 872]]
      .map(([displayName, n]) => ({ principalId: id(n), displayName })), meta: { requestId: id(875), correlationId: id(875), limit: 200 } });
    if (path === `${prefix}/pickers/testing-candidates`) return json(route, 200, { data: [['Avery', 'Sample', 'PASSED'], ['Rowan', 'Example', 'PASSED'], ['Kim', 'Placeholder', 'DEFERRED']]
      .map(([givenName, familyName, result], i) => ({ candidateId: id(800 + i), version: 2, result, testingEventId: id(810), testingEventName: 'Synthetic spring test', startsAt: at(-day),
        studentProfileId: id(820 + i), givenName, familyName, curriculumName: 'Synthetic curriculum', targetRankId: id(830), targetRankName: 'Yellow belt' })), meta: { requestId: id(840), correlationId: id(840), limit: 50 } });
    // Top-bar search (2026-11-21): the staff search read for leads and classes, synthetic rows only.
    if (path === `${prefix}/search`) return json(route, 200, { data: { search: { organizationId: scope.organizationId, schoolId: scope.schoolId, results: [
      { kind: 'LEAD', entityId: id(201), title: 'Avery Sample', subtitle: 'Open lead', route: `/staff/search/${scope.organizationId}/${scope.schoolId}/LEAD/${id(201)}` },
      { kind: 'CLASS_SESSION', entityId: id(100), title: 'Little Tigers', subtitle: 'Scheduled class', route: `/staff/search/${scope.organizationId}/${scope.schoolId}/CLASS_SESSION/${id(100)}` }] } }, meta: {} });
    if (path === `${prefix}/reports/operations`) return json(route, 200, { data: { operationalSnapshot: snapshot(scope) }, meta: {} });
    if (path === `${prefix}/interface-theme`) {
      if (method === 'PUT') theme = JSON.parse(route.request().postData() ?? '{}').interfaceTheme ?? theme;
      return json(route, 200, { data: { interfaceTheme: theme, selectedVia: 'SETTINGS', updatedAt: iso() }, meta: {} });
    }
  }
  return json(route, 403, { code: 'FORBIDDEN' });
}

const probe = createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const session = { mode: 'OIDC', audience: 'school-shell-browser-synthetic', secret: randomBytes(32).toString('hex') };
const server = spawn(join(webRoot, 'node_modules/.bin/next'), ['start', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: webRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'production', HON_DEPLOYMENT_ENVIRONMENT: 'preview', NEXT_TELEMETRY_DISABLED: '1', HON_API_BASE_URL: 'http://127.0.0.1:9', HON_AUTH_MODE: session.mode, HON_SESSION_AUDIENCE: session.audience, HON_SESSION_JWT_SECRET: session.secret }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; i < 240; i += 1) { try { const r = await fetch(`${origin}/auth/login`); if (r.status < 500) break; } catch { /* starting */ } await new Promise((done) => setTimeout(done, 500)); }

const browser = await chromium.launch();
async function open(viewport, path, { language, clock } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await ctx.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: 'shell-synthetic-owner' }, session), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/api/')) return api(route);
    return route.continue();
  });
  // Voice is not part of this proof. Some headless Chromium builds terminate the page when the
  // on-device speech recognition service is probed, so speech recognition is left out here.
  await ctx.addInitScript(() => { for (const name of ['SpeechRecognition', 'webkitSpeechRecognition']) { try { Object.defineProperty(window, name, { value: undefined, configurable: true }); } catch { /* keep */ } } });
  const page = await ctx.newPage();
  if (clock) await page.clock.install();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(`${origin}${path}`);
  if (language) await page.evaluate((l) => { document.documentElement.lang = l; }, language);
  return { ctx, page };
}
// Optional HON_SHELL_BROWSER_ONLY=<text>: run only the checks whose name contains it.
const only = process.env.HON_SHELL_BROWSER_ONLY ?? null;
async function check(name, work) { if (only && !name.includes(only)) return; try { await work(); report.checks.push(name); } catch (error) { report.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); } }
async function shot(page, name) { await page.screenshot({ path: join(results, `${name}.png`) }); report.screenshots.push(`${name}.png`); }
async function noOverflow(page) {
  const offenders = await page.evaluate(() => [...document.querySelectorAll('[data-hon-ui] *')]
    .filter((e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.right > window.innerWidth + 1 && s.position !== 'fixed' && !e.closest('[data-drawer="closed"]') && !e.closest('nav[aria-label] a') ; })
    .slice(0, 5).map((e) => `${e.tagName}.${e.className}`));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `page scrolls horizontally: ${offenders.join(', ')}`);
}
const viewports = { desktop: { width: 1440, height: 900 }, tablet: { width: 834, height: 1112 }, phone: { width: 390, height: 844 } };

for (const mode of ['modern', 'classic', 'big-button']) for (const [size, viewport] of Object.entries(viewports)) {
  await check(`dashboard ${mode} ${size}`, async () => {
    theme = mode; multi = false;
    const { ctx, page } = await open(viewport, '/staff/dashboard');
    await page.waitForFunction((value) => document.querySelector('[data-hon-ui="school"]')?.getAttribute('data-hon-mode') === value, mode);
    await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
    const href = await page.locator('nav[aria-label="School navigation"] a[data-nav="home"]').getAttribute('href');
    assert.equal(href, `/staff/dashboard?organizationId=${schoolA.organizationId}&schoolId=${schoolA.schoolId}`);
    await page.waitForSelector('[data-kpi="activeMemberships"][data-state="VALUE"]');
    await page.waitForSelector('[data-agent="kai"][data-status="PROVIDER_OFF"]');
    await page.getByText('Little Tigers').waitFor(); await page.getByText('Call back trial family').waitFor(); await page.getByText('Rowan Example').waitFor();
    assert.equal(await page.locator('[data-kpi="activeMemberships"] strong').textContent(), '131');
    assert.equal(await page.locator('[data-locale-utility] select').count(), 1, 'exactly one language selector');
    assert.equal(await page.locator('[data-locale-utility] select').isVisible(), true, 'language selector reachable at every width');
    assert.equal(await page.locator('[data-kpi="revenue"]').getAttribute('data-state'), 'NOT_CONNECTED');
    assert.equal(await page.locator('[data-agent="claire"]').getAttribute('data-status'), 'UNKNOWN');
    await page.waitForTimeout(150);
    await noOverflow(page);
    await axeScan(page, `home-${mode}-${size}`);
    await shot(page, `u2-home-${mode}-${size}`);
    if (size === 'desktop') { await page.screenshot({ path: join(results, `u2-home-${mode}-desktop-full.png`), fullPage: true }); report.screenshots.push(`u2-home-${mode}-desktop-full.png`); }
    await ctx.close();
  });
}
await check('art style chip redraws the team without changing availability, and is remembered on this device', async () => {
  theme = 'modern'; multi = false; const { ctx, page } = await open(viewports.desktop, '/staff/dashboard');
  await page.waitForSelector('[data-agent="kai"][data-status="PROVIDER_OFF"]');
  assert.equal(await page.locator('[data-agent="chad"] img').getAttribute('src'), '/ai/chad.webp');
  for (const [label, style] of [['Illustrated', 'illustrated'], ['Chibi', 'chibi']]) {
    await page.getByRole('group', { name: 'Team art style' }).getByRole('button', { name: label, exact: true }).click();
    await page.waitForSelector(`[data-art="${style}"]`);
    assert.equal(await page.locator('[data-agent="chad"] img').getAttribute('src'), `/ai/chad-${style}.webp`);
    assert.equal(await page.locator('[data-agent="kai"]').getAttribute('data-status'), 'PROVIDER_OFF');
    assert.equal(await page.locator('[data-agent="claire"]').getAttribute('data-status'), 'UNKNOWN');
    await page.waitForTimeout(300); await shot(page, `u2-home-art-${style}-desktop`);
  }
  await page.reload(); await page.waitForSelector('[data-art="chibi"]');
  assert.equal(await page.locator('[data-hon-corner]').count(), 0, 'no corner HON on the dashboard');
  // The HON workspace follows the same chosen style and shows the HON core orb.
  await page.goto(origin + '/staff/hon');
  await page.waitForSelector('img[src="/ai/chad-chibi.webp"]');
  assert.equal(await page.locator('img[src="/ai/hon-core.webp"]').count() > 0, true, 'HON workspace shows the HON core');
  assert.equal(await page.locator('img[src="/ai/kai-chibi.webp"]').count() > 0, true, 'Kai follows the chosen style');
  await page.waitForTimeout(400); await shot(page, 'u3-hon-workspace-chibi-desktop');
  await ctx.close();
});
await check('HON waits in the corner on other pages', async () => {
  theme = 'classic'; multi = false; const { ctx, page } = await open(viewports.desktop, '/staff/work');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  assert.equal(await page.locator('button[data-hon-corner][aria-haspopup="dialog"]').isVisible(), true);
  await page.waitForTimeout(500); await shot(page, 'u2-hon-corner-classic-desktop'); await ctx.close();
});
for (const [mode, size] of [['modern', 'desktop'], ['classic', 'desktop'], ['big-button', 'desktop'], ['modern', 'phone'], ['big-button', 'phone']]) {
  await check(`corner HON opens a pop-up over the page and expands to the same conversation (${mode} ${size})`, async () => {
    theme = mode; multi = false; const { ctx, page } = await open(viewports[size], '/staff/work');
    await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
    await page.getByText('Call back trial family').waitFor();
    // Something the person was in the middle of on this page: scrolled and typed, never saved.
    const field = page.locator('#hon-main input:not([type=hidden]):not([type=checkbox]):not([type=radio]), #hon-main textarea').locator('visible=true').first();
    const typed = (await field.count()) ? 'Half-written note' : null;
    if (typed) await field.fill(typed);
    await page.evaluate(() => window.scrollTo(0, 200)); const scrolled = await page.evaluate(() => window.scrollY);
    const corner = page.locator('button[data-hon-corner]');
    await corner.click();
    const dialog = page.getByRole('dialog', { name: 'HON' });
    await dialog.waitFor();
    assert.equal(new URL(page.url()).pathname, '/staff/work', 'opening HON never leaves the page');
    // Docked chat (owner 2026-11-22): not modal, anchored in the bottom-right corner where the orb was, never full screen.
    assert.equal(await dialog.getAttribute('aria-modal'), 'false');
    assert.equal(await corner.isVisible(), false, 'the orb steps aside while the chat is open');
    await page.waitForTimeout(300);
    const box = await dialog.boundingBox(), view = page.viewportSize();
    assert.equal(view.width - (box.x + box.width) <= 24, true, 'docked at the right edge');
    assert.equal(box.y >= 40 && view.height - (box.y + box.height) <= 100, true, 'docked at the bottom, page still visible above');
    if (size === 'phone') { const bar = await page.locator('nav[aria-label="Quick navigation"]').boundingBox(); assert.equal(box.y + box.height <= bar.y, true, 'sits above the bottom bar'); }
    await shot(page, `p1-hon-dock-empty-${mode}-${size}`);
    await dialog.getByText(/Past conversations/).click();
    await dialog.getByRole('button', { name: /Plan this week/ }).click();
    await dialog.getByText('Follow up the 5 new leads first').waitFor();
    await dialog.getByText(/Past conversations/).click();
    await dialog.getByRole('textbox').fill('Half-typed question');
    await page.waitForTimeout(300); await shot(page, `p1-hon-popup-${mode}-${size}`);
    // Minimize: it shrinks back into the corner orb and the page is exactly as it was.
    await dialog.getByRole('button', { name: 'Minimize HON' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await corner.isVisible(), true, 'the orb is back in the corner');
    assert.equal(new URL(page.url()).pathname, '/staff/work');
    if (typed) assert.equal(await field.inputValue(), typed, 'unsaved typing on the page is kept');
    assert.equal(await page.evaluate(() => window.scrollY), scrolled, 'scroll position is kept');
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-hon-corner')), true, 'focus returns to the corner button');
    // Reopen: the same conversation is still open.
    await corner.click(); await dialog.waitFor();
    await dialog.getByText('Follow up the 5 new leads first').waitFor();
    assert.equal(await dialog.getByRole('textbox').inputValue(), 'Half-typed question', 'minimizing keeps a half-typed message');
    // Escape minimizes too; Close ends the window, and the orb returns either way.
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    await corner.click(); await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Close HON' }).click(); await dialog.waitFor({ state: 'detached' });
    assert.equal(await corner.isVisible(), true);
    await corner.click(); await dialog.waitFor();
    await dialog.getByText('Follow up the 5 new leads first').waitFor();
    // Expand: the full workspace opens the same conversation, with a way back to this page.
    const expand = dialog.getByRole('link', { name: 'Full workspace' });
    assert.equal(await expand.getAttribute('href'), '/staff/hon?return=%2Fstaff%2Fwork');
    if (size === 'desktop') {
      await expand.click(); await page.waitForURL('**/staff/hon?return=%2Fstaff%2Fwork');
      await page.getByText('Follow up the 5 new leads first').waitFor();
      assert.equal(await page.locator('[aria-current="true"]', { hasText: 'Plan this week' }).count() > 0, true, 'same conversation selected');
      assert.equal(await page.getByRole('link', { name: 'Back to your page' }).getAttribute('href'), '/staff/work');
      await page.waitForTimeout(300); await shot(page, `p1-hon-expanded-${mode}-${size}`);
    }
    await ctx.close();
  });
}
for (const mode of ['modern', 'big-button']) {
  await check(`corner HON phone bottom bar lines up icons and one-line labels (${mode})`, async () => {
    theme = mode; multi = false; const { ctx, page } = await open(viewports.phone, '/staff/work');
    await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
    const slots = await page.evaluate(() => [...document.querySelectorAll('nav[aria-label="Quick navigation"] > *')].map((slot) => {
      const icon = slot.querySelector('svg').getBoundingClientRect(), label = slot.querySelector('span'), text = label.getBoundingClientRect();
      return { name: label.textContent, iconTop: Math.round(icon.top), textTop: Math.round(text.top), lines: Math.round(text.height / parseFloat(getComputedStyle(label).lineHeight)), clipped: label.scrollWidth > label.clientWidth + 1 };
    }));
    assert.deepEqual(slots.map((slot) => slot.name), ['Dashboard', 'Contacts', 'Pipeline', 'Calendar', 'More']);
    assert.equal(new Set(slots.map((slot) => slot.iconTop)).size, 1, `icons share one line: ${JSON.stringify(slots)}`);
    assert.equal(new Set(slots.map((slot) => slot.textTop)).size, 1, `labels share one line: ${JSON.stringify(slots)}`);
    assert.equal(slots.every((slot) => slot.lines === 1 && !slot.clipped), true, `one unclipped line each: ${JSON.stringify(slots)}`);
    await page.waitForTimeout(300); await shot(page, `p1-bottom-bar-${mode}-phone`); await ctx.close();
  });
}
await check('classic sidebar shows the owner menu headings with their pages, and the current page', async () => {
  theme = 'classic'; multi = false; const { ctx, page } = await open(viewports.desktop, '/staff/billing/invoices');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  const nav = page.locator('nav[aria-label="School navigation"]');
  assert.equal(await nav.locator('[data-nav-section]').count(), 12);
  assert.equal(await nav.locator('a[data-nav="invoices"]').getAttribute('aria-current'), 'page');
  assert.equal(await page.locator('[data-shell-groups]').count(), 0, 'no third level');
  await page.waitForTimeout(250); await axeScan(page, 'sidebar-classic'); await shot(page, 'l1-sidebar-classic-desktop');
  await page.setViewportSize({ width: 1440, height: 1600 }); await page.waitForTimeout(150); await shot(page, 'l1-sidebar-classic-desktop-tall');
  await ctx.close();
});
await check('modern top bar shows the everyday pages and More', async () => {
  theme = 'modern'; multi = false; const { ctx, page } = await open(viewports.desktop, '/staff/crm/follow-ups');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  const visible = await page.locator('nav[aria-label="School navigation"] a[data-nav]').evaluateAll((links) => links.filter((a) => a.offsetParent !== null).map((a) => a.dataset.nav));
  assert.deepEqual(visible, ['home', 'classes', 'attendance', 'students', 'crm', 'messages']);
  await noOverflow(page); await shot(page, 'l1-topbar-modern-desktop'); await ctx.close();
});
for (const mode of ['modern', 'big-button']) await check(`${mode} menu panel lists every area`, async () => {
  theme = mode; multi = false; const { ctx, page } = await open(viewports.desktop, '/staff/work');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const panel = page.getByRole('dialog', { name: 'Menu' }); await panel.waitFor();
  // Owner menu (2026-11-16): eleven headings plus Settings; one card per page (27 pages: Shopify and Ads added, then Parent app split from Texts on 2026-11-19).
  assert.equal(await panel.locator('[data-menu-section]').count(), 12);
  assert.equal(await panel.locator('[data-menu]').count(), 27);
  await page.waitForTimeout(250); await axeScan(page, `menu-${mode}`); await shot(page, `u2-menu-${mode}-desktop`);
  await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached' }); await ctx.close();
});
const privateNow = (page, trigger) => page.evaluate((how) => {
  if (how === 'hidden') { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); }
  else window.dispatchEvent(new Event(how));
  // Read in the same task as the event: concealment must not wait for a re-render.
  const nodes = [...document.querySelectorAll('[data-shell-private]')];
  if (how === 'hidden') delete document.visibilityState;
  return { count: nodes.length, concealed: nodes.every((node) => node.hidden && node.inert) };
}, trigger);
const phaseIs = (page, phase) => page.waitForFunction((value) => document.querySelector('[data-phase]')?.getAttribute('data-phase') === value, phase);
const saverNow = (page, how) => page.evaluate((how) => {
  if (how === 'hidden' || how === 'visible') {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => how });
    document.dispatchEvent(new Event('visibilitychange')); delete document.visibilityState;
  } else window.dispatchEvent(new Event(how));
  // Read in the same task as the event: the screensaver must not wait for a later render.
  return { saver: Boolean(document.querySelector('[data-screensaver]')), phase: document.querySelector('[data-phase]')?.getAttribute('data-phase') };
}, how);
await check('away shows a screensaver instead of hiding the school; tapping returns to the same page and school with a quiet re-check', async () => {
  theme = 'modern'; multi = false;
  const { ctx, page } = await open(viewports.desktop, '/staff/dashboard', { clock: true });
  await phaseIs(page, 'READY'); await page.waitForSelector('[data-kpi="students"][data-state="VALUE"]');
  const url = page.url(), identities = () => report.apiRequests.filter((line) => line === 'GET /api/identity/me').length;
  // Blur (another window, the address bar) does nothing at all.
  assert.deepEqual(await saverNow(page, 'blur'), { saver: false, phase: 'READY' });
  await page.evaluate(() => { window.__saverShown = 0; window.addEventListener('hon:screensaver-shown', () => { window.__saverShown += 1; }); });
  // Hidden (phone backgrounded, tab switched): screensaver at once, school kept.
  assert.deepEqual(await saverNow(page, 'hidden'), { saver: true, phase: 'READY' }, 'screensaver covers the app synchronously');
  assert.equal(await page.locator('[data-home="ready"]').count(), 1, 'the page stays mounted under the screensaver');
  assert.equal(await page.evaluate(() => window.__saverShown), 1, 'the shell announces the screensaver so hands-free voice turns off');
  // Back within 30 seconds: lifts by itself, quietly re-checks, nothing to re-choose.
  let before = identities();
  assert.deepEqual(await saverNow(page, 'visible'), { saver: true, phase: 'READY' });
  await page.waitForSelector('[data-screensaver]', { state: 'detached' });
  await page.waitForTimeout(300);
  assert.equal(identities() > before, true, 'returning re-checks the signed-in identity');
  assert.equal(page.url(), url); await phaseIs(page, 'READY'); assert.equal(await page.locator('[data-home="ready"]').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Show school', exact: true }).count(), 0, 'no Show school step any more');
  // Five idle minutes: screensaver; a tap returns to the same page and school.
  await page.clock.fastForward('05:01');
  await page.waitForSelector('[data-screensaver]');
  assert.equal(await page.evaluate(() => window.__saverShown), 2, 'idle also announces the screensaver');
  await page.waitForTimeout(400); await axeScan(page, 'screensaver'); await shot(page, 'screensaver-modern-desktop');
  before = identities();
  await page.getByRole('dialog', { name: 'Screensaver' }).click({ position: { x: 40, y: 40 } });
  await page.waitForSelector('[data-screensaver]', { state: 'detached' }); await page.waitForTimeout(300);
  assert.equal(identities() > before, true, 'a tap re-checks the signed-in identity');
  await phaseIs(page, 'READY'); assert.equal(page.url(), url); assert.equal(await page.locator('[data-home="ready"]').count(), 1);
  // Any key lifts it too.
  await saverNow(page, 'hidden'); await page.clock.fastForward('01:00'); await saverNow(page, 'visible');
  assert.equal(await page.locator('[data-screensaver]').count(), 1, 'a long absence waits for a tap');
  await page.keyboard.press('Enter'); await page.waitForSelector('[data-screensaver]', { state: 'detached' });
  // Session end still clears everything and asks for sign-in.
  await saverNow(page, 'hon:session-invalidated'); await phaseIs(page, 'SESSION');
  assert.equal(await page.locator('[data-home="ready"]').count(), 0, 'session end still hides the dashboard');
  assert.equal(await page.getByRole('button', { name: 'Show school', exact: true }).count(), 0, 'an ended session cannot be restored in place');
  await saverNow(page, 'blur'); await page.waitForTimeout(200);
  assert.equal(await page.locator('[data-phase]').getAttribute('data-phase'), 'SESSION', 'a later blur never downgrades an ended session');
  await ctx.close();
});
await check('quiet re-check after the screensaver moves an ended session to sign in again', async () => {
  theme = 'modern'; multi = false;
  const { ctx, page } = await open(viewports.desktop, '/staff/dashboard');
  await phaseIs(page, 'READY'); await page.waitForSelector('[data-home="ready"]');
  await saverNow(page, 'hidden'); sessionEnded = true; await saverNow(page, 'visible');
  await phaseIs(page, 'SESSION'); sessionEnded = false;
  assert.equal(await page.locator('[data-home="ready"]').count(), 0); await ctx.close();
});
for (const mode of ['modern', 'big-button', 'classic']) await check(`screensaver on a phone (${mode})`, async () => {
  theme = mode; multi = false; const { ctx, page } = await open(viewports.phone, '/staff/dashboard');
  await phaseIs(page, 'READY'); await saverNow(page, 'hidden');
  await page.waitForTimeout(400); await noOverflow(page); await shot(page, `screensaver-${mode}-phone`); await ctx.close();
});
await check('menu panel keeps keyboard focus inside and returns it to the opener', async () => {
  theme = 'modern'; multi = false; const { ctx, page } = await open(viewports.desktop, '/staff/work');
  await phaseIs(page, 'READY');
  const opener = page.getByRole('button', { name: 'Open navigation' }); await opener.focus(); await page.keyboard.press('Enter');
  const panel = page.getByRole('dialog', { name: 'Menu' }); await panel.waitFor();
  for (let i = 0; i < 70; i += 1) {
    await page.keyboard.press(i % 3 === 0 ? 'Shift+Tab' : 'Tab');
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), true, 'focus left the open menu');
  }
  assert.equal(await page.evaluate(() => Boolean(document.getElementById('hon-main')?.closest('[inert]'))), true, 'the page behind the menu is inert');
  await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Open navigation', 'focus returns to the menu button');
  await ctx.close();
});
await check('home shows a refused AI readiness as hidden, never as available', async () => {
  theme = 'modern'; multi = false; readinessDenied = true; const { ctx, page } = await open(viewports.desktop, '/staff/dashboard');
  await page.waitForSelector('[data-agent="chad"][data-status="HIDDEN"]');
  assert.equal(await page.locator('[data-status="READY"]').count(), 0);
  await page.waitForSelector('[data-kpi="students"][data-state="VALUE"]');
  readinessDenied = false; await ctx.close();
});
await check('operations report keeps the previous dashboard on its own route', async () => {
  theme = 'modern'; multi = false; const { ctx, page } = await open(viewports.desktop, `/staff/operations?organizationId=${schoolA.organizationId}&schoolId=${schoolA.schoolId}`);
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  assert.equal(await page.locator('nav[aria-label="Pages in this section"] a[aria-current="page"]').textContent(), 'Operations report');
  await page.waitForTimeout(800); await shot(page, 'u2-operations-report-desktop'); await ctx.close();
});
for (const path of ['/staff/crm/lead-memberships', '/staff/account-status', '/staff/work', '/staff/crm/follow-ups']) {
  await check(`axe on ${path} inside the shell`, async () => {
    theme = 'modern'; multi = false; const { ctx, page } = await open(viewports.desktop, path);
    await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
    await page.waitForTimeout(600); await axeScan(page, path); await ctx.close();
  });
}
await check('school entry renders without the shell', async () => {
  const { ctx, page } = await open(viewports.desktop, '/staff/entry');
  await page.waitForTimeout(500);
  assert.equal(await page.locator('[data-hon-ui="school"]').count(), 0); await ctx.close();
});
await check('section tabs on follow-ups (desktop)', async () => {
  theme = 'modern'; const { ctx, page } = await open(viewports.desktop, '/staff/crm/follow-ups');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  assert.equal(await page.locator('nav[aria-label="Pages in this section"] a[aria-current="page"]').textContent(), 'Follow-ups');
  assert.equal(await page.locator('a[data-nav="crm"]').getAttribute('aria-current'), 'page');
  await shot(page, 'u1-follow-ups-tabs-desktop'); await ctx.close();
});
for (const mode of ['modern', 'classic', 'big-button']) for (const size of ['desktop', 'phone']) await check(`Tests shows six numbered steps, not tabs (${mode} ${size})`, async () => {
  theme = mode; const { ctx, page } = await open(viewports[size], '/staff/testing/candidates/grade');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  assert.deepEqual(await page.locator('nav[data-shell-steps] a').evaluateAll(links => links.map(a => a.textContent)),
    ['1Who is ready', '2Sign-ups', '3Register', '4Grade', '5Scorecards', '6Certificates']);
  assert.equal(await page.locator('nav[data-shell-steps] a[aria-current="step"]').textContent(), '4Grade');
  assert.equal(await page.locator('[data-shell-tabs]').count(), 0);
  await noOverflow(page); await shot(page, `l3-test-steps-${mode}-${size}`); await ctx.close();
});
await check('Mass rank promotion opens on the graded students with one decision for a picked group', async () => {
  theme = 'modern'; const { ctx, page } = await open(viewports.desktop, '/staff/testing/promotion-decisions');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.getByText('Rowan Example', { exact: false }).first().waitFor();
  await page.getByRole('button', { name: 'Pick everyone who passed' }).click();
  assert.equal(await page.locator('[data-mass-promotion] input[type="checkbox"][name^="pick-"]:checked').count(), 2);
  await page.locator('textarea[name="massRationale"]').fill('Synthetic reason');
  assert.equal(await page.getByRole('button', { name: 'Record decision for 2 students' }).isDisabled(), true, 'needs the confirm first');
  assert.equal(report.apiRequests.some(r => r.startsWith('POST') && r.includes('promotion-decision')), false);
  await shot(page, 'l3-mass-promotion-desktop'); await ctx.close();
});
for (const mode of ['modern', 'big-button']) for (const size of ['desktop', 'phone']) await check(`Texts > Conversations: list, open a thread, contact details (${mode} ${size})`, async () => {
  theme = mode; const { ctx, page } = await open(viewports[size], '/staff/texts');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.getByRole('button', { name: /Avery Sample/ }).first().click();
  await page.getByText('Can we move the trial to Thursday?').last().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Apply' }).count(), 0, 'no Apply button');
  assert.equal(await page.locator('[data-texts-conversations]').evaluate(el => /[0-9a-f]{8}-[0-9a-f]{4}/i.test(el.textContent ?? '')), false, 'no IDs shown');
  assert.equal(report.apiRequests.some(r => r.startsWith('POST')), false);
  await shot(page, `te3a-texts-conversations-${mode}-${size}`); await ctx.close();
});
await check('Parent app is its own page laid out like the texts inbox (TE3a)', async () => {
  theme = 'modern'; const { ctx, page } = await open(viewports.desktop, '/staff/family-messages');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.getByRole('heading', { name: 'Parent app', exact: true }).first().waitFor();
  await page.getByRole('button', { name: /Sample family/ }).click();
  await page.getByText('Thanks! Is there class on Friday?').waitFor();
  assert.equal(await page.locator('[data-compose]').count(), 0, 'no composer on the parent app page');
  await shot(page, 'te3a-parent-app-desktop'); await ctx.close();
});
for (const size of ['desktop', 'phone']) await check(`Rank setup: belts in order, what each needs, students, add a belt (${size})`, async () => {
  theme = 'modern'; rankSetupState = null; const { ctx, page } = await open(viewports[size], '/staff/curriculum/ranks');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.getByRole('heading', { name: 'Belts, first to last' }).waitFor();
  await page.getByRole('button', { name: 'What this belt needs (2)' }).click();
  await page.getByText('Bows in and out of class').waitFor();
  assert.equal(await page.getByText(/[0-9a-f]{8}-[0-9a-f]{4}-/).count(), 0, 'no ids on the page');
  await noOverflow(page);
  await page.screenshot({ path: join(results, `rank-setup-${size}.png`), fullPage: true }); report.screenshots.push(`rank-setup-${size}.png`);
  await page.getByRole('textbox', { name: 'Next belt' }).fill('Green belt'); await page.getByRole('button', { name: 'Green', exact: true }).last().click();
  await page.getByRole('button', { name: 'Add belt' }).click();
  await page.getByText('Added Green belt.').waitFor();
  assert.equal(await page.getByRole('article', { name: 'Green belt' }).count(), 1, 'the new belt is listed last');
  await page.getByText('24 classes and 60 days to move up').waitFor();
  await page.getByRole('button', { name: /Adult Karate/ }).click();
  await page.getByText('No belts yet.').waitFor();
  // Quick setup: pick the art, answer, check the list, create; then a belt can be removed afterwards.
  await page.getByRole('button', { name: 'Quick setup for a new program' }).click();
  await page.getByRole('button', { name: /Brazilian Jiu-Jitsu \(adults\)/ }).click();
  await page.getByText('3. Check the list (21 belts, first to last)').waitFor();
  await page.getByLabel('Stripes on each belt').selectOption('0');
  await page.getByText('3. Check the list (5 belts, first to last)').waitFor();
  await page.getByLabel('Name of belt 1', { exact: true }).fill('White belt (new student)');
  await noOverflow(page);
  await page.screenshot({ path: join(results, `rank-setup-quick-${size}.png`), fullPage: true }); report.screenshots.push(`rank-setup-quick-${size}.png`);
  await page.getByRole('button', { name: 'Create Adult BJJ with 5 belts' }).click();
  await page.getByText('Created Adult BJJ with 5 belts.').waitFor();
  assert.equal(await page.getByRole('article', { name: 'White belt (new student)' }).count(), 1, 'the edited name was saved');
  await page.getByRole('article', { name: 'Blue belt' }).getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('button', { name: 'Remove this belt' }).click();
  await page.getByRole('button', { name: 'Yes, remove Blue belt' }).click();
  await page.getByText('Removed Blue belt.').waitFor();
  assert.equal(await page.getByRole('article', { name: 'Blue belt' }).count(), 0, 'the belt is gone');
  await ctx.close();
});
for (const size of ['desktop', 'phone']) await check(`Parent app > Curriculum: cycle-based and rank-based setup, preview (${size})`, async () => {
  theme = 'modern'; const { ctx, page } = await open(viewports[size], '/staff/parent-app/curriculum');
  const posts = () => report.apiRequests.filter(r => r.startsWith('POST')).length, postsBefore = posts();
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.getByText('Now: Cycle 2: Kicks, through Sun, Nov 29.').waitFor();
  assert.ok(await page.getByText('Not in the app yet').count() >= 1, 'cycle and document material is labeled');
  await page.getByRole('combobox', { name: 'Student' }).selectOption({ label: 'Avery Sample · Little Dragons · No rank yet' });
  await page.locator('[data-preview]').waitFor();
  assert.equal(await page.getByRole('combobox', { name: 'Student' }).inputValue(), id(980), 'the picked student stays selected');
  await page.getByText(/^No recommendations for .+ yet\.$/).waitFor();
  assert.equal(posts(), postsBefore, 'nothing saved by looking');
  await page.screenshot({ path: join(results, `pca3-cycle-${size}.png`), fullPage: true }); report.screenshots.push(`pca3-cycle-${size}.png`);
  // A refused command keeps what was typed (review P3): the mock refuses every new cycle as a duplicate name.
  await page.getByLabel('New cycle').fill('Cycle 2: Kicks'); await page.getByLabel('New cycle').press('Enter');
  await page.getByRole('alert').filter({ hasText: 'already has that name' }).waitFor();
  assert.equal(await page.getByLabel('New cycle').inputValue(), 'Cycle 2: Kicks', 'a refused cycle name stays in the field');
  await page.getByRole('button', { name: /Adult Karate/ }).click();
  await page.getByRole('heading', { name: 'Material by rank' }).waitFor();
  await page.screenshot({ path: join(results, `pca3-rank-${size}.png`), fullPage: true }); report.screenshots.push(`pca3-rank-${size}.png`);
  await ctx.close();
});
await check('Texts > Send: type a name, pick the contact, nothing sent before Send (TE3a)', async () => {
  theme = 'modern'; const { ctx, page } = await open(viewports.desktop, '/staff/texts/send');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.getByRole('heading', { name: 'Send a text', exact: true }).first().waitFor();
  await page.locator('input[name="composeQuery"]').fill('Sample');
  await page.getByRole('button', { name: /Rowan Example/ }).click();
  await page.getByText('No mobile number: this contact cannot get texts').waitFor();
  await page.locator('textarea[name="composeContent"]').fill('Hi {{first_name}}');
  await page.getByText('Hi Rowan', { exact: false }).first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true, 'no mobile number, no text');
  assert.equal(report.apiRequests.some(r => r.startsWith('POST') && r.includes('communications/messages')), false);
  await shot(page, 'te3a-texts-send-desktop'); await ctx.close();
});
for (const mode of ['modern', 'big-button']) for (const size of ['desktop', 'phone']) await check(`Texts > History, Templates, Opted out (TE3b ${mode} ${size})`, async () => {
  theme = mode;
  let { ctx, page } = await open(viewports[size], '/staff/texts/history');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.getByRole('heading', { name: 'Text history', exact: true }).first().waitFor();
  await page.getByRole('button', { name: /Rowan Example/ }).click();
  await page.locator('[data-drawer]').getByText('No address on file').first().waitFor();
  assert.equal(await page.locator('[data-message-history]').evaluate(el => /[0-9a-f]{8}-[0-9a-f]{4}/i.test(el.textContent ?? '')), false, 'no IDs shown');
  if (size === 'phone') await noOverflow(page);
  await shot(page, `te3b-texts-history-${mode}-${size}`); await ctx.close();
  ({ ctx, page } = await open(viewports[size], '/staff/texts/templates'));
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.getByRole('heading', { name: 'Class cancelled' }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Use in Send' }).first().getAttribute('href'), `/staff/texts/send?template=${id(981)}`);
  if (size === 'phone') await noOverflow(page);
  await shot(page, `te3b-texts-templates-${mode}-${size}`);
  await page.getByRole('button', { name: 'New text template' }).click();
  await page.locator('input[name="templateName"]').fill('Belt testing');
  await page.locator('textarea[name="templateBody"]').fill('Hi {{first_name}}, belt testing is Saturday. {{nickname}}');
  await page.getByText('Not a merge tag: {{nickname}}').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save template' }).isDisabled(), true, 'a stray tag cannot be saved');
  await shot(page, `te3b-texts-template-editor-${mode}-${size}`); await ctx.close();
  ({ ctx, page } = await open(viewports[size], '/staff/texts/opted-out'));
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.getByText('Replied STOP', { exact: true }).waitFor();
  if (size === 'phone') await noOverflow(page);
  await shot(page, `te3b-texts-opted-out-${mode}-${size}`); await ctx.close();
  assert.equal(report.apiRequests.some(r => r.startsWith('POST') && r.includes('/communications/')), false, 'nothing saved or sent');
});
await check('Send shows the message box and merge tags before a contact is picked (owner ask 2026-11-21)', async () => {
  theme = 'modern'; const { ctx, page } = await open(viewports.desktop, '/staff/texts/send');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.locator('textarea[name="composeContent"]').waitFor();
  await page.getByRole('combobox', { name: 'Insert a merge tag' }).waitFor();
  await page.getByText('Pick a contact above to send.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
  await shot(page, 'te4-texts-send-empty-desktop'); await ctx.close();
});
for (const mode of ['modern', 'big-button']) for (const size of ['desktop', 'phone']) await check(`Email > Send, History, Templates, Opted out (TE4 ${mode} ${size})`, async () => {
  theme = mode;
  let { ctx, page } = await open(viewports[size], `/staff/email?template=${id(976)}`);
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.getByRole('heading', { name: 'Send an email', exact: true }).first().waitFor();
  assert.equal(await page.locator('a[href="/staff/email"]').count() > 0, true, 'Email is in the menu');
  await page.locator('input[name="composeSubject"]').waitFor();
  assert.equal(await page.locator('input[name="composeSubject"]').inputValue(), 'Welcome to {{school_name}}, {{first_name}}');
  await page.locator('input[name="composeQuery"]').fill('Sample');
  await page.getByRole('button', { name: /Rowan Example/ }).click();
  await page.locator('[data-email-preview]').getByText('Welcome to', { exact: false }).waitFor();
  await page.locator('[data-email-preview]').getByText(', Rowan', { exact: false }).first().waitFor();
  assert.equal(report.apiRequests.some(r => r.startsWith('POST') && r.includes('communications/messages')), false);
  if (size === 'phone') await noOverflow(page);
  await shot(page, `te4-email-send-${mode}-${size}`); await ctx.close();
  ({ ctx, page } = await open(viewports[size], '/staff/email/history'));
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.getByRole('heading', { name: 'Email history', exact: true }).first().waitFor();
  await page.getByText('Belt testing this Saturday', { exact: false }).first().waitFor();
  if (size === 'phone') await noOverflow(page);
  await shot(page, `te4-email-history-${mode}-${size}`); await ctx.close();
  ({ ctx, page } = await open(viewports[size], '/staff/email/templates'));
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.getByRole('heading', { name: 'Trial welcome' }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Use in Send' }).first().getAttribute('href'), `/staff/email?template=${id(976)}`);
  if (size === 'phone') await noOverflow(page);
  await shot(page, `te4-email-templates-${mode}-${size}`); await ctx.close();
  ({ ctx, page } = await open(viewports[size], '/staff/email/opted-out'));
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.getByText('Staff recorded', { exact: true }).waitFor();
  if (size === 'phone') await noOverflow(page);
  await shot(page, `te4-email-opted-out-${mode}-${size}`); await ctx.close();
  assert.equal(report.apiRequests.some(r => r.startsWith('POST') && r.includes('/communications/')), false, 'nothing saved or sent');
});
await check('Texts > Send starts from a template picked on Templates (TE3b)', async () => {
  theme = 'modern'; const { ctx, page } = await open(viewports.desktop, `/staff/texts/send?template=${id(981)}`);
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.locator('input[name="composeQuery"]').fill('Sample');
  await page.getByRole('button', { name: /Avery Sample/ }).click();
  await page.getByText('Hi Avery, class is cancelled tonight', { exact: false }).first().waitFor();
  assert.equal(await page.locator('select[name="useTemplate"]').inputValue(), id(981));
  assert.equal(report.apiRequests.some(r => r.startsWith('POST') && r.includes('communications/messages')), false);
  await shot(page, 'te3b-texts-send-from-template-desktop'); await ctx.close();
});
for (const mode of ['modern', 'classic', 'big-button']) for (const size of ['desktop', 'phone']) await check(`Staff opens on names; a name opens its card (${mode} ${size})`, async () => {
  theme = mode; const { ctx, page } = await open(viewports[size], '/staff/team/invitations');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.getByRole('heading', { name: 'Your staff (3)' }).waitFor();
  assert.ok(report.apiRequests.some(r => r.startsWith('GET') && r.endsWith('/pickers/staff')));
  assert.equal(await page.locator('[data-staff-directory]').evaluate(el => /[0-9a-f]{8}-[0-9a-f]{4}/i.test(el.textContent ?? '')), false, 'no IDs shown');
  await page.locator('input[name="staffSearch"]').fill('rowan');
  assert.deepEqual(await page.locator('[data-staff-directory] ul[aria-label="Staff"] button').evaluateAll(b => b.map(x => x.textContent)), ['Rowan Example']);
  await page.getByRole('button', { name: 'Rowan Example' }).click();
  const card = page.locator('[data-staff-card]');
  await card.waitFor();
  assert.deepEqual(await card.locator('a').evaluateAll(a => a.map(x => [x.getAttribute('href'), x.textContent])),
    [['/staff/roles', 'Roles & permissions'], ['/staff/team/availability', 'Availability'], ['/staff/instructor-qualifications', 'Qualifications'], ['/staff/documents', 'Documents']]);
  const box = await card.boundingBox(); const width = page.viewportSize().width;
  assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, 'card fits on screen');
  await noOverflow(page); await shot(page, `l5-staff-card-${mode}-${size}`);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'staff-card-close', 'focus moves into the card');
  await page.keyboard.press('Escape'); await card.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Rowan Example', 'focus returns to the name');
  await ctx.close();
});
for (const mode of ['modern', 'classic', 'big-button']) for (const size of ['desktop', 'phone']) await check(`Roles & permissions shows a checklist by area, not typed codes (${mode} ${size})`, async () => {
  theme = mode; const { ctx, page } = await open(viewports[size], '/staff/roles');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.getByRole('heading', { name: 'Roles & permissions', level: 1 }).waitFor();
  const list = page.locator('[data-permission-checklist=""]'); await list.waitFor();
  assert.deepEqual(await list.locator('fieldset').evaluateAll(f => f.map(x => x.getAttribute('data-area'))), ['general', 'attendance', 'leads', 'finance']);
  assert.ok((await list.locator('fieldset[data-area="attendance"]').textContent()).includes('Take attendance, including scan check-in'));
  assert.equal(await page.locator('textarea').count(), 0, 'no typed codes');
  assert.equal(await page.getByText('CUSTOM_', { exact: false }).count(), 0, 'no role code to type');
  await page.locator('input[name="permission-attendance.cards.manage"]').check();
  assert.equal(report.apiRequests.some(r => r.startsWith('POST') && r.includes('staff-roles')), false);
  assert.equal(await page.locator('nav[data-shell-tabs] a[aria-current="page"]').textContent(), 'Roles & permissions');
  await noOverflow(page); await shot(page, `perm-checklist-${mode}-${size}`); await ctx.close();
});
for (const size of ['desktop', 'phone']) await check(`Settings tabs wrap instead of scrolling (${size})`, async () => {
  theme = 'classic'; const { ctx, page } = await open(viewports[size], '/staff/settings/branding');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  const row = page.locator('nav[data-shell-tabs][data-wrap="true"]');
  assert.equal(await row.evaluate(nav => nav.scrollWidth <= nav.clientWidth + 1), true, 'no sideways scroll');
  await noOverflow(page); await shot(page, `l4-settings-tabs-${size}`); await ctx.close();
});
await check('Classic drawer opens and closes with Escape (phone)', async () => {
  theme = 'classic'; const { ctx, page } = await open(viewports.phone, '/staff/crm/leads');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.waitForSelector('[data-drawer="open"]'); await page.waitForTimeout(250);
  await shot(page, 'u1-drawer-open-phone');
  await page.keyboard.press('Escape'); await page.waitForSelector('[data-drawer="closed"]', { state: 'attached' });
  await ctx.close();
});
await check('multi-school staff choose a named school; the dashboard reloads for that school', async () => {
  theme = 'modern'; multi = true; const { ctx, page } = await open(viewports.desktop, '/staff/work');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'CHOICE');
  await shot(page, 'u1-school-choice-desktop');
  await Promise.all([page.waitForURL(/\/staff\/dashboard\?organizationId=/), page.getByRole('button', { name: /Synthetic South Academy/ }).click()]);
  assert.ok(page.url().endsWith(`organizationId=${schoolB.organizationId}&schoolId=${schoolB.schoolId}`));
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.waitForFunction(() => document.querySelector('[data-phase] strong')?.textContent === 'Synthetic South Academy');
  await shot(page, 'u1-school-chosen-desktop'); await ctx.close();
});
for (const [mode, size] of [['modern', 'desktop'], ['big-button', 'desktop'], ['modern', 'phone']]) {
  await check(`a click outside the Menu box closes it (${mode} ${size})`, async () => {
    theme = mode; multi = false; const { ctx, page } = await open(viewports[size], '/staff/work');
    await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
    const opener = size === 'phone' ? page.locator('nav[aria-label="Quick navigation"] button[aria-expanded]') : page.locator('button[aria-label="Open navigation"]').or(page.locator('[data-nav-more]')).first();
    if (size !== 'phone' && !(await opener.isVisible())) await page.evaluate(() => document.querySelector('[data-nav-more]')?.click()); else await opener.click();
    await page.waitForSelector('[role="dialog"][aria-label="Menu"]');
    await page.waitForTimeout(150); await shot(page, `gs-menu-open-${mode}-${size}`);
    const box = await page.locator('[role="dialog"][aria-label="Menu"]').boundingBox();
    // Beside the box when there is room, else below it.
    const x = box.x > 40 ? box.x / 2 : box.x + box.width / 2, y = box.x > 40 ? box.y + 200 : box.y + box.height + 15;
    await page.mouse.click(x, y);
    await page.waitForSelector('[role="dialog"][aria-label="Menu"]', { state: 'detached' });
    await page.getByText('Call back trial family').waitFor();
    await ctx.close();
  });
}
for (const [mode, size] of [['modern', 'desktop'], ['classic', 'desktop'], ['big-button', 'desktop'], ['modern', 'phone']]) {
  await check(`top-bar search finds contacts, leads, classes and pages (${mode} ${size})`, async () => {
    theme = mode; multi = false; const { ctx, page } = await open(viewports[size], '/staff/work');
    await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
    await page.getByText('Call back trial family').waitFor();
    await page.locator('[data-global-search-open]').click();
    const input = page.getByRole('combobox', { name: 'Search contacts, leads, classes and pages' });
    await input.waitFor();
    await page.waitForTimeout(150); await shot(page, `gs-search-empty-${mode}-${size}`);
    await input.fill('av');
    await page.waitForSelector('[data-search-group="CONTACTS"] a');
    await page.waitForSelector('[data-search-group="LEADS"] a');
    assert.equal(await page.locator('[data-search-group="CONTACTS"] a').first().getAttribute('href'), `/staff/people?person=${id(850)}`);
    await page.waitForTimeout(100); await shot(page, `gs-search-results-${mode}-${size}`);
    await input.fill('invoi');
    await page.waitForSelector('[data-search-group="PAGES"] a[href="/staff/billing/invoices"]');
    await shot(page, `gs-search-pages-${mode}-${size}`);
    await noOverflow(page);
    // Esc closes and returns to the page; Ctrl+K opens again; a click outside closes.
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-global-search]', { state: 'detached' });
    await page.keyboard.press('Control+k');
    await input.waitFor();
    await page.mouse.click(10, viewports[size].height - 10);
    await page.waitForSelector('[data-global-search]', { state: 'detached' });
    // Keyboard: arrows and Enter open the highlighted page.
    await page.keyboard.press('Control+k'); await input.fill('planned abs');
    await page.waitForSelector('[data-search-group="PAGES"] a');
    await page.keyboard.press('ArrowDown');
    await Promise.all([page.waitForURL(/\/staff\/attendance\/planned-absences/), page.keyboard.press('Enter')]);
    await ctx.close();
  });
}
await check('view switch saves the personal preference', async () => {
  theme = 'modern'; multi = false; const { ctx, page } = await open(viewports.desktop, '/staff/work');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.getByRole('button', { name: 'Platform view: Classic', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-hon-ui="school"]')?.getAttribute('data-hon-mode') === 'classic');
  await page.getByText('Saved for you at this school').waitFor();
  assert.equal(theme, 'classic'); await ctx.close();
});
await check('session invalidation conceals the school and removes prefill', async () => {
  theme = 'modern'; multi = false; const { ctx, page } = await open(viewports.desktop, '/staff/work');
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'READY');
  await page.evaluate(() => window.dispatchEvent(new Event('hon:session-invalidated')));
  await page.waitForFunction(() => document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'SESSION');
  assert.equal(await page.locator('[data-hon-ui] a[href*="organizationId="]').count(), 0);
  await shot(page, 'u1-session-ended-desktop'); await ctx.close();
});

await browser.close(); server.kill('SIGTERM');
report.pageErrors = [...new Set(report.pageErrors)];
await writeFile(join(results, 'school-shell-browser-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ checks: report.checks.length, failures: report.failures, pageErrors: report.pageErrors.slice(0, 5) }, null, 2));
if (report.failures.length) { console.error(serverLog.slice(-3000)); process.exitCode = 1; }
