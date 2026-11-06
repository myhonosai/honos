import type { AiTeamReadiness, CurrentSchoolClassSession, HumanWorkQueueItem, LeadListItem, OperationalSnapshot, SchoolCommandCenterSnapshot } from '@hon/contracts';
import type { HomeSources } from '../src/components/home/model';

// Synthetic values only; no real school, family or student data.
export const ORG = '11111111-1111-4111-8111-111111111111', SCHOOL = '22222222-2222-4222-8222-222222222222';
export const NOW = new Date(2026, 10, 6, 9, 30);
const local = (hours: number, minutes = 0, dayOffset = 0) => new Date(2026, 10, 6 + dayOffset, hours, minutes).toISOString();
const w = (count: number) => ({ availability: 'AVAILABLE' as const, windowFrom: '2026-11-05T00:00:00.000Z', windowTo: '2026-11-06T00:00:00.000Z', count });

export const command = (over: Partial<SchoolCommandCenterSnapshot['metrics']> = {}): SchoolCommandCenterSnapshot => ({
  organizationId: ORG, schoolId: SCHOOL, entitlementTier: 'COMPLETE', generatedAt: '2026-11-06T09:00:00.000Z', dailyBriefing: '', recommendations: [],
  metrics: { newLeads24h: w(7), upcomingTrials24h: w(3), upcomingTestingEvents30d: w(1), pendingActionApprovals: { availability: 'AVAILABLE', count: 4 },
    outstandingWorkItems: { availability: 'AVAILABLE', count: 2 }, membershipTermsEnding30d: w(5),
    paidInvoicesCreated30d: { ...w(2), amountsByCurrency: [] }, unansweredInquiries: { availability: 'UNAVAILABLE', reason: 'x' },
    attendanceDecline: { availability: 'INSUFFICIENT_DATA', reason: 'x' }, trialConversion: { availability: 'UNAVAILABLE', reason: 'x' },
    revenue: { availability: 'UNAVAILABLE', reason: 'x' }, ...over } as SchoolCommandCenterSnapshot['metrics'],
});

export const operations = (): OperationalSnapshot => ({
  organizationId: ORG, schoolId: SCHOOL, generatedAt: '2026-11-06T09:00:00.000Z', from: '2026-10-07T09:00:00.000Z', to: '2026-11-06T09:00:00.000Z',
  studentProfiles: { total: 412 }, leads: { byStatus: { OPEN: 38, WON: 21, LOST: 9, ARCHIVED: 2 } },
  classSessions: { inRange: { scheduled: 30, completed: 88, cancelled: 2 } },
  attendance: { inRangeByStatus: { PRESENT: 1200, LATE: 40, EXCUSED_ABSENCE: 12, UNEXCUSED_ABSENCE: 30, MAKEUP: 17 } },
  memberships: { byState: { DRAFT: 3, ACTIVE: 286, FROZEN: 6, CANCELLATION_PENDING: 4, CANCELLED: 20, EXPIRED: 11 } },
  invoices: { inRangeByStatus: { DRAFT: 0, ISSUED: 4, PAID: 30, VOID: 0, UNCOLLECTIBLE: 0 } },
  paymentAttempts: { inRangeByState: { PENDING: 0, PROCESSING: 0, SUCCEEDED: 30, FAILED: 1, REQUIRES_ACTION: 0, UNKNOWN: 0, REFUNDED: 0 } },
});

const agent = (agentKey: 'marcus' | 'claire' | 'chad', agentName: string, credits: number, over: Partial<AiTeamReadiness['agents'][number]> = {}) => ({
  agentKey, agent: agentName, authorized: true, spendDecision: 'ALLOWED', route: 'CONFIGURED' as const, requestCredits: credits,
  providerRuntime: 'CONFIGURATION_REQUIRED' as const, available: false, blockedBy: 'PROVIDER_RUNTIME_NOT_CONFIGURED', ...over });
export const readiness = (agents?: AiTeamReadiness['agents']): AiTeamReadiness => ({
  organizationId: ORG, schoolId: SCHOOL, completeEntitlement: true, agentBudget: null, asOf: '2026-11-06T09:00:00.000Z', honConversation: { contract: true },
  agents: agents ?? [agent('marcus', 'MARKETING', 6), agent('claire', 'TEACHING', 6), agent('chad', 'CHAD_FOLLOW_UP', 3)],
});
export { agent as readinessAgent };

const session = (sessionId: string, name: string, startsAt: string, status: CurrentSchoolClassSession['status'] = 'SCHEDULED'): CurrentSchoolClassSession => ({
  sessionId, name, startsAt, endsAt: startsAt, roomName: 'Main mat', capacity: 20, bookingPolicy: 'WALK_IN', status, createdAt: '2026-10-01T00:00:00.000Z' });
export const sessions = (): CurrentSchoolClassSession[] => [
  session('a1', 'Little Tigers', local(16, 30)), session('a2', 'Adult Sparring', local(19)), session('a3', 'Cancelled class', local(17), 'CANCELLED'),
  session('a4', 'Tomorrow class', local(10, 0, 1)), session('a5', 'Morning Basics', local(7)),
];

const lead = (id: string, givenName: string, familyName: string, createdAt: string, status: LeadListItem['status'] = 'OPEN'): LeadListItem => ({
  id, status, pipelineStageId: ORG, primaryPersonId: SCHOOL, version: 1, createdAt, givenName, familyName });
export const leads = (): LeadListItem[] => [
  lead('l1', 'Avery', 'Sample', '2026-11-01T10:00:00.000Z'), lead('l2', 'Jordan', 'Example', '2026-11-05T10:00:00.000Z'),
  lead('l3', 'Won', 'Lead', '2026-11-06T08:00:00.000Z', 'WON'),
];

export const work = (): HumanWorkQueueItem[] => [
  { title: 'Call back trial family', workItemId: 'w1', version: 1, status: 'READY', priority: 'HIGH', dueAt: '2026-11-07T00:00:00.000Z', assigneeId: null },
  { title: 'Order belts', workItemId: 'w2', version: 1, status: 'READY', priority: 'LOW', dueAt: null, assigneeId: null },
];

export const ready = (): HomeSources => ({
  command: { state: 'READY', value: command() }, operations: { state: 'READY', value: operations() }, readiness: { state: 'READY', value: readiness() },
  leads: { state: 'READY', value: leads() }, sessions: { state: 'READY', value: sessions() }, work: { state: 'READY', value: work() },
});
