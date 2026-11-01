import type {
  CommandCenterMetrics,
  CommandCenterRecommendation,
  CurrentSchoolClassSession,
  FollowUpQueueItem,
  LeadListItem,
  OperationalSnapshot,
} from '@hon/contracts';

// REFERENCE SAMPLE DATA ONLY. Every value below is illustrative and is typed against the
// real read contracts (OperationsReport, Command Center, class-session read, lead list and
// follow-up queue) so a live version can swap this module for the authorized reads without
// changing the presentation. Nothing here is a tenant fact.

export const SAMPLE_GENERATED_AT = '2026-10-18T16:05:00.000Z';
export const SAMPLE_TIME_ZONE = 'America/Los_Angeles';

const ORG = '00000000-0000-4000-8000-000000000001';
const SCHOOL = '00000000-0000-4000-8000-000000000002';
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const SAMPLE_SCHOOLS = [
  { id: SCHOOL, name: 'Sunrise Taekwondo', location: 'Main location · Sample' },
  { id: id(3), name: 'Sunrise Taekwondo', location: 'Eastside location · Sample' },
] as const;

export const SAMPLE_SNAPSHOT: OperationalSnapshot = {
  organizationId: ORG,
  schoolId: SCHOOL,
  generatedAt: SAMPLE_GENERATED_AT,
  from: '2026-09-18T07:00:00.000Z',
  to: '2026-10-18T07:00:00.000Z',
  studentProfiles: { total: 142 },
  leads: { byStatus: { OPEN: 23, WON: 61, LOST: 18, ARCHIVED: 4 } },
  classSessions: { inRange: { scheduled: 18, completed: 96, cancelled: 2 } },
  attendance: { inRangeByStatus: { PRESENT: 1184, LATE: 63, EXCUSED_ABSENCE: 71, UNEXCUSED_ABSENCE: 48, MAKEUP: 22 } },
  memberships: { byState: { DRAFT: 3, ACTIVE: 128, FROZEN: 4, CANCELLATION_PENDING: 2, CANCELLED: 19, EXPIRED: 11 } },
  invoices: { inRangeByStatus: { DRAFT: 4, ISSUED: 9, PAID: 112, VOID: 1, UNCOLLECTIBLE: 0 } },
  paymentAttempts: { inRangeByState: { PENDING: 0, PROCESSING: 1, SUCCEEDED: 110, FAILED: 3, REQUIRES_ACTION: 1, UNKNOWN: 1, REFUNDED: 0 } },
};

// Exact unavailable reasons returned by apps/api/src/reports/command-center.service.ts.
export const SAMPLE_METRICS: CommandCenterMetrics = {
  newLeads24h: { availability: 'AVAILABLE', count: 4 },
  upcomingTrials24h: { availability: 'AVAILABLE', count: 3 },
  upcomingTestingEvents30d: { availability: 'AVAILABLE', count: 1 },
  pendingActionApprovals: { availability: 'AVAILABLE', count: 2 },
  outstandingWorkItems: { availability: 'AVAILABLE', count: 5 },
  membershipTermsEnding30d: { availability: 'AVAILABLE', count: 7 },
  paidInvoicesCreated30d: {
    availability: 'AVAILABLE', count: 112, windowFrom: '2026-09-18T07:00:00.000Z', windowTo: '2026-10-18T07:00:00.000Z',
    amountsByCurrency: [{ currency: 'USD', count: 112, totalMinor: 1612800 }],
  },
  unansweredInquiries: { availability: 'UNAVAILABLE', reason: 'No approved inquiry response-state projection exists.' },
  attendanceDecline: { availability: 'INSUFFICIENT_DATA', reason: 'No approved attendance-decline policy or longitudinal projection exists.' },
  trialConversion: { availability: 'UNAVAILABLE', reason: 'No authoritative trial-to-enrollment linkage is available.' },
  revenue: { availability: 'UNAVAILABLE', reason: 'Current paid invoice state is not authoritative cash revenue or collection data.' },
};

// Same titles, wording and fixed routes as the deterministic Command Center recommendations.
export const SAMPLE_RECOMMENDATIONS: CommandCenterRecommendation[] = [
  { id: 'REVIEW_PENDING_APPROVALS', title: 'Review pending approvals', why: '2 current action requests are awaiting a qualified human review.', route: '/staff/action-center/approvals', action: 'NAVIGATE', automaticExecution: false },
  { id: 'REVIEW_OUTSTANDING_WORK', title: 'Review outstanding work', why: '5 durable work items remain in a nonterminal state.', route: '/staff/work', action: 'NAVIGATE', automaticExecution: false },
  { id: 'PREPARE_UPCOMING_TRIALS', title: 'Prepare upcoming trials', why: '3 scheduled trial appointments start within 24 hours.', route: '/staff/search', action: 'NAVIGATE', automaticExecution: false },
  { id: 'REVIEW_NEW_LEADS', title: 'Review new leads', why: '4 CRM leads were created in the last 24 hours.', route: '/staff/search', action: 'NAVIGATE', automaticExecution: false },
  { id: 'PREPARE_MEMBERSHIP_RENEWALS', title: 'Prepare membership reviews', why: '7 active or cancellation-pending membership terms end within 30 days.', route: '/staff/billing/renewals', action: 'NAVIGATE', automaticExecution: false },
];

const session = (n: number, name: string, startsAt: string, endsAt: string, roomName: string | null, capacity: number, bookingPolicy: CurrentSchoolClassSession['bookingPolicy'] = 'OPTIONAL_BOOKING', status: CurrentSchoolClassSession['status'] = 'SCHEDULED'): CurrentSchoolClassSession => ({
  sessionId: id(100 + n), name, startsAt, endsAt, roomName, capacity, bookingPolicy, status, createdAt: '2026-09-01T17:00:00.000Z',
});

export const SAMPLE_SESSIONS: CurrentSchoolClassSession[] = [
  session(1, 'Little Tigers (Ages 4–6)', '2026-10-18T23:00:00.000Z', '2026-10-18T23:40:00.000Z', 'Main mat', 16),
  session(2, 'Kids Taekwondo (Ages 7–12)', '2026-10-18T23:45:00.000Z', '2026-10-19T00:30:00.000Z', 'Main mat', 18),
  session(3, 'Intermediate Forms', '2026-10-19T00:30:00.000Z', '2026-10-19T01:15:00.000Z', 'Studio B', 16, 'REQUIRED_BOOKING'),
  session(4, 'Teen & Adult', '2026-10-19T01:15:00.000Z', '2026-10-19T02:15:00.000Z', 'Main mat', 20, 'WALK_IN'),
  session(5, 'Black Belt Club', '2026-10-19T02:15:00.000Z', '2026-10-19T03:00:00.000Z', 'Studio B', 12, 'REQUIRED_BOOKING', 'CANCELLED'),
];

const lead = (n: number, givenName: string, familyName: string, status: LeadListItem['status'], createdAt: string, nextFollowUpAt?: string): LeadListItem => ({
  id: id(200 + n), status, pipelineStageId: id(300), primaryPersonId: id(400 + n), version: 1, createdAt, givenName, familyName, nextFollowUpAt,
});

export const SAMPLE_LEADS: LeadListItem[] = [
  lead(1, 'Ethan', 'Parker', 'OPEN', '2026-10-18T15:12:00.000Z', '2026-10-18T22:00:00.000Z'),
  lead(2, 'Sophia', 'Lee', 'OPEN', '2026-10-18T13:40:00.000Z', '2026-10-19T17:00:00.000Z'),
  lead(3, 'Daniel', 'Kim', 'OPEN', '2026-10-17T21:05:00.000Z', '2026-10-19T18:30:00.000Z'),
  lead(4, 'Olivia', 'Garcia', 'WON', '2026-10-16T18:22:00.000Z'),
  lead(5, 'Mason', 'Clark', 'OPEN', '2026-10-16T16:10:00.000Z'),
  lead(6, 'Ava', 'Martinez', 'LOST', '2026-10-15T19:48:00.000Z'),
];

const followUp = (n: number, priority: FollowUpQueueItem['priority'], dueAt: string | null): FollowUpQueueItem => ({
  followUpId: id(500 + n), leadId: id(200 + n), assigneeId: id(600), version: 1, status: 'OPEN', priority, dueAt,
});

export const SAMPLE_FOLLOW_UPS: { item: FollowUpQueueItem; leadName: string }[] = [
  { item: followUp(1, 'HIGH', '2026-10-18T22:00:00.000Z'), leadName: 'Ethan Parker' },
  { item: followUp(2, 'NORMAL', '2026-10-19T17:00:00.000Z'), leadName: 'Sophia Lee' },
  { item: followUp(3, 'HIGH', '2026-10-17T20:00:00.000Z'), leadName: 'Daniel Kim' },
  { item: followUp(5, 'LOW', null), leadName: 'Mason Clark' },
];

export const SAMPLE_OWNER = { name: 'David Kim', role: 'School owner' } as const;
