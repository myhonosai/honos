import type { TenantScope } from './index.js';

/** Closed status vocabulary; unavailable is deliberate and is never a zero count. */
export const COMMAND_CENTER_AVAILABILITY = ['AVAILABLE', 'UNAVAILABLE', 'INSUFFICIENT_DATA'] as const;
export type CommandCenterAvailability = (typeof COMMAND_CENTER_AVAILABILITY)[number];
export type CommandCenterTier = 'ESSENTIAL' | 'CORE' | 'COMPLETE';

export interface CommandCenterAvailableCount {
  availability: 'AVAILABLE';
  count: number;
  windowFrom?: string;
  windowTo?: string;
}
export interface CommandCenterUnavailable {
  availability: 'UNAVAILABLE' | 'INSUFFICIENT_DATA';
  reason: string;
}
export type CommandCenterCountFact = CommandCenterAvailableCount | CommandCenterUnavailable;

/** Current PAID invoice state in a creation window; explicitly not cash revenue. */
export interface CommandCenterPaidInvoices extends CommandCenterAvailableCount {
  availability: 'AVAILABLE';
  windowFrom: string;
  windowTo: string;
  amountsByCurrency: Array<{ currency: string; count: number; totalMinor: number }>;
}

export interface CommandCenterMetrics {
  /** CRM leads created in [windowFrom, windowTo), regardless of current lead state. */
  newLeads24h: CommandCenterAvailableCount;
  /** SCHEDULED TRIAL appointments with starts_at in [windowFrom, windowTo). */
  upcomingTrials24h: CommandCenterAvailableCount;
  /** DRAFT, OPEN, or CLOSED testing events with starts_at in [windowFrom, windowTo). */
  upcomingTestingEvents30d: CommandCenterAvailableCount;
  /** Current AWAITING_APPROVAL action requests whose expiry has not passed. */
  pendingActionApprovals: CommandCenterAvailableCount;
  /** Current nonterminal durable work: excludes COMPLETED and FAILED. */
  outstandingWorkItems: CommandCenterAvailableCount;
  /** ACTIVE/CANCELLATION_PENDING memberships with a recorded term end in the forward window. */
  membershipTermsEnding30d: CommandCenterAvailableCount;
  /** Current PAID invoices created in the trailing window; never payment/cash revenue. */
  paidInvoicesCreated30d: CommandCenterPaidInvoices;
  unansweredInquiries: CommandCenterUnavailable;
  attendanceDecline: CommandCenterUnavailable;
  trialConversion: CommandCenterUnavailable;
  revenue: CommandCenterUnavailable;
}

export const COMMAND_CENTER_RECOMMENDATION_IDS = [
  'REVIEW_PENDING_APPROVALS',
  'REVIEW_OUTSTANDING_WORK',
  'PREPARE_UPCOMING_TRIALS',
  'REVIEW_NEW_LEADS',
  'PREPARE_MEMBERSHIP_RENEWALS',
] as const;
export type CommandCenterRecommendationId = (typeof COMMAND_CENTER_RECOMMENDATION_IDS)[number];

/** Code-owned same-origin navigation only. A card never executes a command. */
export interface CommandCenterRecommendation {
  id: CommandCenterRecommendationId;
  title: string;
  why: string;
  route: '/staff/action-center/approvals' | '/staff/work' | '/staff/search' | '/staff/billing/renewals';
  action: 'NAVIGATE';
  automaticExecution: false;
}

/** Exact database projection: aggregate/status facts only, with no display text or routes. */
export interface SchoolCommandCenterProjection extends TenantScope {
  entitlementTier: CommandCenterTier;
  generatedAt: string;
  metrics: CommandCenterMetrics;
}

export interface SchoolCommandCenterSnapshot extends SchoolCommandCenterProjection {
  /** Deterministic template text derived only from metrics in this DTO. */
  dailyBriefing: string;
  /** Fixed priority order, optional cards only; no generated action or write. */
  recommendations: CommandCenterRecommendation[];
}

export interface SchoolCommandCenterResponse {
  commandCenter: SchoolCommandCenterSnapshot;
}
