import { WORK_ITEM_STATUSES, type WorkItemStatus } from '@hon/contracts';

export const WORK_ITEM_TERMINAL_STATUSES = ['COMPLETED', 'FAILED'] as const satisfies readonly WorkItemStatus[];

const allowedTransitions: Readonly<Record<WorkItemStatus, readonly WorkItemStatus[]>> = {
  READY: ['THINKING', 'WORKING', 'WAITING', 'WAITING_FOR_APPROVAL', 'NEEDS_ATTENTION', 'FAILED'],
  THINKING: ['WORKING', 'WAITING', 'WAITING_FOR_APPROVAL', 'NEEDS_ATTENTION', 'FAILED'],
  WORKING: ['WAITING', 'WAITING_FOR_APPROVAL', 'COMPLETED', 'NEEDS_ATTENTION', 'FAILED'],
  WAITING: ['READY', 'WORKING', 'WAITING_FOR_APPROVAL', 'NEEDS_ATTENTION', 'FAILED'],
  WAITING_FOR_APPROVAL: ['READY', 'WORKING', 'WAITING', 'NEEDS_ATTENTION', 'FAILED'],
  // Returning to READY is an explicit human triage action, not an automatic retry.
  NEEDS_ATTENTION: ['READY', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
};

export function isWorkItemStatus(value: unknown): value is WorkItemStatus {
  return typeof value === 'string' && (WORK_ITEM_STATUSES as readonly string[]).includes(value);
}

export function isTerminalWorkItemStatus(status: WorkItemStatus): boolean {
  return (WORK_ITEM_TERMINAL_STATUSES as readonly WorkItemStatus[]).includes(status);
}

export function canTransitionWorkItem(from: WorkItemStatus, to: WorkItemStatus): boolean {
  return allowedTransitions[from].includes(to);
}

/**
 * Validates the finite transition matrix without side effects. Terminal records
 * can never be silently reopened; any future retry must be a separately audited
 * product decision rather than a relaxed state-machine edge.
 */
export function assertWorkItemTransition(from: WorkItemStatus, to: WorkItemStatus): WorkItemStatus {
  if (!isWorkItemStatus(from) || !isWorkItemStatus(to)) {
    throw new Error('WORK_ITEM_STATUS_INVALID');
  }
  if (isTerminalWorkItemStatus(from)) {
    throw new Error('WORK_ITEM_TERMINAL_REOPEN_DENIED');
  }
  if (!canTransitionWorkItem(from, to)) {
    throw new Error('WORK_ITEM_TRANSITION_DENIED');
  }
  return to;
}
