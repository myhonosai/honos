/** Durable work-item states. Transitions are enforced by the pure domain policy. */
export const WORK_ITEM_STATUSES = [
  'READY',
  'THINKING',
  'WORKING',
  'WAITING',
  'WAITING_FOR_APPROVAL',
  'COMPLETED',
  'NEEDS_ATTENTION',
  'FAILED',
] as const;

export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

/** Human commands can create only an unassigned READY item; actor and scope are server-derived. */
export interface CreateWorkItemInput {
  workType: string;
  subjectType?: string | undefined;
  subjectId?: string | undefined;
  payload?: Record<string, unknown> | undefined;
}

/** A human-only, optimistic-concurrency-protected work-item state transition. */
export interface TransitionWorkItemInput {
  targetStatus: WorkItemStatus;
  expectedVersion: number;
  result?: Record<string, unknown> | undefined;
  errorReason?: string | undefined;
}

/**
 * Deliberately limited scoped projection. It excludes assigned-principal data,
 * raw payload, raw result, and error text so a list operation cannot become a
 * broad identity or arbitrary-payload enumeration API.
 */
export interface WorkItemSummary {
  id: string;
  workType: string;
  status: WorkItemStatus;
  subjectType?: string | undefined;
  subjectId?: string | undefined;
  version: number;
  createdAt: string;
  updatedAt: string;
}
