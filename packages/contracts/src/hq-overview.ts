/**
 * Fixed HQ presentation catalog. These entries are not principals, model IDs,
 * tools, roles, authority grants, cost records, or runtime identity selectors.
 */
export const HON_HQ_EXECUTIVE_KEYS = [
  'hon',
  'chase',
  'mia',
  'ethan',
  'olivia',
  'ryan',
  'sophia',
] as const;
export type HonHqExecutiveKey = (typeof HON_HQ_EXECUTIVE_KEYS)[number];

/** Bounded, presentation-only HQ focus labels; they grant no access or tools. */
export const HON_HQ_EXECUTIVE_DOMAINS = [
  'EXECUTIVE_COORDINATION',
  'GROWTH',
  'CUSTOMER_SUCCESS',
  'PRODUCT',
  'FINANCE',
  'REVENUE',
  'OPERATIONS',
] as const;
export type HonHqExecutiveDomain = (typeof HON_HQ_EXECUTIVE_DOMAINS)[number];

export interface HonHqExecutiveCatalogEntry {
  executiveKey: HonHqExecutiveKey;
  displayName: string;
  title: string;
  domain: HonHqExecutiveDomain;
  summary: string;
  /** HQ-1 has no persisted executive workspace or durable HQ work implementation. */
  workspace: {
    availability: 'UNAVAILABLE';
    state: 'NO_RECORDED_WORK';
    reason: 'HQ executive workspaces are not active in HQ-1.';
  };
}

/**
 * Code-owned presentation catalog for the approved HQ hierarchy. It is entirely
 * separate from school-level AI employee identities and performs no selection.
 */
export const HON_HQ_EXECUTIVE_CATALOG: readonly HonHqExecutiveCatalogEntry[] = Object.freeze([
  {
    executiveKey: 'hon',
    displayName: 'HON',
    title: 'Executive AI Coordinator',
    domain: 'EXECUTIVE_COORDINATION',
    summary: 'Bounded coordinator for explanation, consolidation, and future governed delegation.',
    workspace: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: 'HQ executive workspaces are not active in HQ-1.' },
  },
  {
    executiveKey: 'chase',
    displayName: 'Chase',
    title: 'Growth Executive',
    domain: 'GROWTH',
    summary: 'Presentation catalog entry for HQ growth work once durable scope and evidence exist.',
    workspace: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: 'HQ executive workspaces are not active in HQ-1.' },
  },
  {
    executiveKey: 'mia',
    displayName: 'Mia',
    title: 'Customer Success Executive',
    domain: 'CUSTOMER_SUCCESS',
    summary: 'Presentation catalog entry for HQ customer-success work once durable scope and evidence exist.',
    workspace: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: 'HQ executive workspaces are not active in HQ-1.' },
  },
  {
    executiveKey: 'ethan',
    displayName: 'Ethan',
    title: 'Product Executive',
    domain: 'PRODUCT',
    summary: 'Presentation catalog entry for HQ product work once durable scope and evidence exist.',
    workspace: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: 'HQ executive workspaces are not active in HQ-1.' },
  },
  {
    executiveKey: 'olivia',
    displayName: 'Olivia',
    title: 'Finance Executive',
    domain: 'FINANCE',
    summary: 'Presentation catalog entry for HQ finance work once an authoritative financial projection exists.',
    workspace: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: 'HQ executive workspaces are not active in HQ-1.' },
  },
  {
    executiveKey: 'ryan',
    displayName: 'Ryan',
    title: 'Revenue Executive',
    domain: 'REVENUE',
    summary: 'Presentation catalog entry for HQ revenue work once an authoritative financial projection exists.',
    workspace: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: 'HQ executive workspaces are not active in HQ-1.' },
  },
  {
    executiveKey: 'sophia',
    displayName: 'Sophia',
    title: 'Operations Executive',
    domain: 'OPERATIONS',
    summary: 'Presentation catalog entry for HQ operations work once durable scope and evidence exist.',
    workspace: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: 'HQ executive workspaces are not active in HQ-1.' },
  },
]);

export const HQ_OVERVIEW_CALLER_ROLES = ['OWNER', 'OPERATOR'] as const;
export type HqOverviewCallerRole = (typeof HQ_OVERVIEW_CALLER_ROLES)[number];

export interface HqOverviewOnboardingCounts {
  availability: 'AVAILABLE';
  requestCount: number;
  inProgressRequestCount: number;
  completedRequestCount: number;
}

/** Counts only; neither provider identity nor credential configuration is exposed. */
export interface HqOverviewProviderStateCounts {
  disabled: number;
  configured: number;
  healthy: number;
  degraded: number;
  unavailable: number;
}

export interface HqOverviewUnavailable {
  availability: 'UNAVAILABLE';
  reason: string;
}

/**
 * Closed, HQ-only projection. It intentionally omits all identifiers, names,
 * credentials, models, tenant selection, authority, prompts, results, costs,
 * financial values, action evidence, and per-school detail.
 */
export interface HqPlatformOverview {
  asOf: string;
  callerHqRole: HqOverviewCallerRole;
  organizationCount: number;
  schoolCount: number;
  onboarding: HqOverviewOnboardingCounts;
  configuredProviderStates: HqOverviewProviderStateCounts;
  taskProfileCount: number;
  financialMetrics: HqOverviewUnavailable;
  aiUsage: HqOverviewUnavailable;
  durableHqWork: HqOverviewUnavailable & { state: 'NO_RECORDED_WORK' };
}

export const HQ_OVERVIEW_UNAVAILABLE_REASONS = {
  financialMetrics: 'No authoritative HQ financial MRR, ARR, cash, or gross-margin projection is available.',
  aiUsage: 'No authoritative HQ AI usage or cost projection is available.',
  durableHqWork: 'No durable HQ executive work is recorded or active in HQ-1.',
} as const;
