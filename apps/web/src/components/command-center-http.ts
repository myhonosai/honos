import type { CommandCenterMetrics, CommandCenterRecommendation, SchoolCommandCenterSnapshot } from '@hon/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNSAFE = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
const routes = ['/staff/action-center/approvals', '/staff/work', '/staff/search', '/staff/billing/renewals'] as const;
const unavailable = {
  unansweredInquiries: ['UNAVAILABLE', 'No approved inquiry response-state projection exists.'],
  attendanceDecline: ['INSUFFICIENT_DATA', 'No approved attendance-decline policy or longitudinal projection exists.'],
  trialConversion: ['UNAVAILABLE', 'No authoritative trial-to-enrollment linkage is available.'],
  revenue: ['UNAVAILABLE', 'Current paid invoice state is not authoritative cash revenue or collection data.'],
} as const;

export class CommandCenterAccessError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
type Row = Record<string, unknown>;
function invalid(): never { throw new Error('Command Center data was not a verified aggregate-only snapshot.'); }
function record(value: unknown, keys: readonly string[]): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const source = value as Row;
  if (Object.keys(source).length !== keys.length || keys.some(key => !Object.hasOwn(source, key))) invalid();
  return source;
}
function count(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(); return value; }
function string(value: unknown, max = 240): string { if (typeof value !== 'string' || !value || value.length > max || UNSAFE.test(value)) invalid(); return value; }
function timestamp(value: unknown): string { const parsed = new Date(string(value, 80)); if (!Number.isFinite(parsed.getTime())) invalid(); return parsed.toISOString(); }
function id(value: unknown, expected: string): string { const result = string(value, 36).toLowerCase(); if (!UUID.test(result) || result !== expected) invalid(); return result; }
function availableWindow(value: unknown, duration: number) {
  const source = record(value, ['availability', 'windowFrom', 'windowTo', 'count']);
  if (source.availability !== 'AVAILABLE') invalid();
  const windowFrom = timestamp(source.windowFrom); const windowTo = timestamp(source.windowTo);
  if (Date.parse(windowTo) - Date.parse(windowFrom) !== duration) invalid();
  return { availability: 'AVAILABLE' as const, windowFrom, windowTo, count: count(source.count) };
}
function availableCount(value: unknown) {
  const source = record(value, ['availability', 'count']);
  if (source.availability !== 'AVAILABLE') invalid();
  return { availability: 'AVAILABLE' as const, count: count(source.count) };
}
function unavailableFact(value: unknown, expected: readonly ['UNAVAILABLE' | 'INSUFFICIENT_DATA', string]) {
  const source = record(value, ['availability', 'reason']);
  if (source.availability !== expected[0] || string(source.reason) !== expected[1]) invalid();
  return { availability: expected[0] as 'UNAVAILABLE' | 'INSUFFICIENT_DATA', reason: expected[1] };
}
function paidInvoices(value: unknown) {
  const source = record(value, ['availability', 'windowFrom', 'windowTo', 'count', 'amountsByCurrency']);
  if (source.availability !== 'AVAILABLE' || !Array.isArray(source.amountsByCurrency)) invalid();
  const windowFrom = timestamp(source.windowFrom); const windowTo = timestamp(source.windowTo);
  if (Date.parse(windowTo) - Date.parse(windowFrom) !== 30 * 86_400_000) invalid();
  let sum = 0; let prior = ''; const seen = new Set<string>();
  const amountsByCurrency = source.amountsByCurrency.map(value => {
    const item = record(value, ['currency', 'count', 'totalMinor']); const currency = string(item.currency, 3);
    if (!/^[A-Z]{3}$/.test(currency) || seen.has(currency) || currency <= prior) invalid();
    seen.add(currency); prior = currency;
    const itemCount = count(item.count); sum += itemCount; if (!Number.isSafeInteger(sum)) invalid();
    return { currency, count: itemCount, totalMinor: count(item.totalMinor) };
  });
  const metricCount = count(source.count); if (metricCount !== sum) invalid();
  return { availability: 'AVAILABLE' as const, windowFrom, windowTo, count: metricCount, amountsByCurrency };
}
function expectedBriefing(metrics: CommandCenterMetrics): string {
  const values: string[] = [];
  if (metrics.newLeads24h.count) values.push(`${metrics.newLeads24h.count} new ${metrics.newLeads24h.count === 1 ? 'lead' : 'leads'} in the last 24 hours`);
  if (metrics.upcomingTrials24h.count) values.push(`${metrics.upcomingTrials24h.count} trial ${metrics.upcomingTrials24h.count === 1 ? 'appointment' : 'appointments'} scheduled in the next 24 hours`);
  if (metrics.upcomingTestingEvents30d.count) values.push(`${metrics.upcomingTestingEvents30d.count} testing ${metrics.upcomingTestingEvents30d.count === 1 ? 'event' : 'events'} in the next 30 days`);
  if (metrics.membershipTermsEnding30d.count) values.push(`${metrics.membershipTermsEnding30d.count} membership ${metrics.membershipTermsEnding30d.count === 1 ? 'term' : 'terms'} ending in the next 30 days`);
  if (metrics.pendingActionApprovals.count) values.push(`${metrics.pendingActionApprovals.count} action ${metrics.pendingActionApprovals.count === 1 ? 'approval' : 'approvals'} awaiting review`);
  if (metrics.outstandingWorkItems.count) values.push(`${metrics.outstandingWorkItems.count} outstanding durable ${metrics.outstandingWorkItems.count === 1 ? 'work item' : 'work items'}`);
  return values.length ? `Daily briefing: ${values.join('; ')}.` : 'Daily briefing: no counted priorities are currently recorded in the available Command Center metrics.';
}
function expectedRecommendations(metrics: CommandCenterMetrics): CommandCenterRecommendation[] {
  const result: CommandCenterRecommendation[] = [];
  if (metrics.pendingActionApprovals.count) result.push({ id: 'REVIEW_PENDING_APPROVALS', title: 'Review pending approvals', why: `${metrics.pendingActionApprovals.count} current action ${metrics.pendingActionApprovals.count === 1 ? 'request is' : 'requests are'} awaiting a qualified human review.`, route: '/staff/action-center/approvals', action: 'NAVIGATE', automaticExecution: false });
  if (metrics.outstandingWorkItems.count) result.push({ id: 'REVIEW_OUTSTANDING_WORK', title: 'Review outstanding work', why: `${metrics.outstandingWorkItems.count} durable ${metrics.outstandingWorkItems.count === 1 ? 'work item remains' : 'work items remain'} in a nonterminal state.`, route: '/staff/work', action: 'NAVIGATE', automaticExecution: false });
  if (metrics.upcomingTrials24h.count) result.push({ id: 'PREPARE_UPCOMING_TRIALS', title: 'Prepare upcoming trials', why: `${metrics.upcomingTrials24h.count} scheduled trial ${metrics.upcomingTrials24h.count === 1 ? 'appointment starts' : 'appointments start'} within 24 hours.`, route: '/staff/search', action: 'NAVIGATE', automaticExecution: false });
  if (metrics.newLeads24h.count) result.push({ id: 'REVIEW_NEW_LEADS', title: 'Review new leads', why: `${metrics.newLeads24h.count} CRM ${metrics.newLeads24h.count === 1 ? 'lead was' : 'leads were'} created in the last 24 hours.`, route: '/staff/search', action: 'NAVIGATE', automaticExecution: false });
  if (metrics.membershipTermsEnding30d.count) result.push({ id: 'PREPARE_MEMBERSHIP_RENEWALS', title: 'Prepare membership reviews', why: `${metrics.membershipTermsEnding30d.count} active or cancellation-pending membership ${metrics.membershipTermsEnding30d.count === 1 ? 'term ends' : 'terms end'} within 30 days.`, route: '/staff/billing/renewals', action: 'NAVIGATE', automaticExecution: false });
  return result;
}

/** Selector IDs only. The server independently resolves human/school/tier authority. */
export function commandCenterPath(organizationId: string, schoolId: string): string {
  const organization = organizationId.trim().toLowerCase(); const school = schoolId.trim().toLowerCase();
  if (!UUID.test(organization) || !UUID.test(school)) throw new Error('Enter the exact organization and school UUIDs from your staff context.');
  return `/api/v1/organizations/${organization}/schools/${school}/command-center`;
}

export function verifyCommandCenterSnapshot(value: unknown, organizationId: string, schoolId: string): SchoolCommandCenterSnapshot {
  const organization = organizationId.trim().toLowerCase(); const school = schoolId.trim().toLowerCase();
  const source = record(value, ['organizationId', 'schoolId', 'entitlementTier', 'generatedAt', 'metrics', 'dailyBriefing', 'recommendations']);
  const sourceMetrics = record(source.metrics, ['newLeads24h', 'upcomingTrials24h', 'upcomingTestingEvents30d', 'pendingActionApprovals', 'outstandingWorkItems', 'membershipTermsEnding30d', 'paidInvoicesCreated30d', 'unansweredInquiries', 'attendanceDecline', 'trialConversion', 'revenue']);
  const metrics: CommandCenterMetrics = {
    newLeads24h: availableWindow(sourceMetrics.newLeads24h, 86_400_000),
    upcomingTrials24h: availableWindow(sourceMetrics.upcomingTrials24h, 86_400_000),
    upcomingTestingEvents30d: availableWindow(sourceMetrics.upcomingTestingEvents30d, 30 * 86_400_000),
    pendingActionApprovals: availableCount(sourceMetrics.pendingActionApprovals),
    outstandingWorkItems: availableCount(sourceMetrics.outstandingWorkItems),
    membershipTermsEnding30d: availableWindow(sourceMetrics.membershipTermsEnding30d, 30 * 86_400_000),
    paidInvoicesCreated30d: paidInvoices(sourceMetrics.paidInvoicesCreated30d),
    unansweredInquiries: unavailableFact(sourceMetrics.unansweredInquiries, unavailable.unansweredInquiries),
    attendanceDecline: unavailableFact(sourceMetrics.attendanceDecline, unavailable.attendanceDecline),
    trialConversion: unavailableFact(sourceMetrics.trialConversion, unavailable.trialConversion),
    revenue: unavailableFact(sourceMetrics.revenue, unavailable.revenue),
  };
  const recommendations = expectedRecommendations(metrics);
  if (string(source.dailyBriefing, 1_000) !== expectedBriefing(metrics) || !Array.isArray(source.recommendations) || JSON.stringify(source.recommendations) !== JSON.stringify(recommendations)) invalid();
  if (recommendations.some(item => !(routes as readonly string[]).includes(item.route))) invalid();
  const entitlementTier = string(source.entitlementTier, 10);
  if (!['ESSENTIAL', 'CORE', 'COMPLETE'].includes(entitlementTier)) invalid();
  return { organizationId: id(source.organizationId, organization), schoolId: id(source.schoolId, school), entitlementTier: entitlementTier as SchoolCommandCenterSnapshot['entitlementTier'], generatedAt: timestamp(source.generatedAt), metrics, dailyBriefing: expectedBriefing(metrics), recommendations };
}

export async function loadCommandCenter(organizationId: string, schoolId: string): Promise<SchoolCommandCenterSnapshot> {
  const response = await fetch(commandCenterPath(organizationId, schoolId), { method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const message = response.status === 401 ? 'Sign in with a verified human staff session, then load the Command Center.'
      : response.status === 403 ? 'Command Center access is not authorized for this current school. Content was cleared.'
        : 'The Command Center snapshot is unavailable. No result is shown.';
    throw new (response.status === 401 || response.status === 403 ? CommandCenterAccessError : Error)(message, response.status);
  }
  let envelope: unknown;
  try { envelope = await response.json(); } catch { throw new Error('The Command Center response could not be verified.'); }
  const root = record(envelope, ['data', 'meta']); const data = record(root.data, ['commandCenter']);
  return verifyCommandCenterSnapshot(data.commandCenter, organizationId, schoolId);
}
