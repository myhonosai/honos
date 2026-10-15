import type { ActionAuthorityMode } from '@hon/contracts';

export const ACTION_REQUEST_STATUSES = [
  'RECEIVED',
  'VALIDATING',
  'AWAITING_APPROVAL',
  'APPROVED',
  'DENIED',
  'EXPIRED',
  'EXECUTING',
  'SUCCEEDED',
  'FAILED',
  'UNKNOWN',
  'RECONCILING',
] as const;

export type ActionRequestStatus = (typeof ACTION_REQUEST_STATUSES)[number];

const allowedTransitions: Readonly<Record<ActionRequestStatus, readonly ActionRequestStatus[]>> = {
  RECEIVED: ['VALIDATING', 'FAILED'],
  VALIDATING: ['AWAITING_APPROVAL', 'APPROVED', 'DENIED', 'FAILED'],
  AWAITING_APPROVAL: ['APPROVED', 'DENIED', 'EXPIRED'],
  APPROVED: ['EXECUTING', 'EXPIRED', 'FAILED'],
  DENIED: [],
  EXPIRED: [],
  EXECUTING: ['SUCCEEDED', 'FAILED', 'UNKNOWN'],
  SUCCEEDED: [],
  FAILED: [],
  UNKNOWN: ['RECONCILING'],
  RECONCILING: ['SUCCEEDED', 'FAILED', 'UNKNOWN'],
};

export interface ApprovalBinding {
  actionRequestId: string;
  requestedByPrincipalId: string;
  reviewerPrincipalId: string;
  normalizedPayloadHash: string;
  policyVersion: number;
  expiresAt: Date;
}

export interface ApprovalCandidate {
  actionRequestId: string;
  requestedByPrincipalId: string;
  reviewerPrincipalId: string;
  normalizedPayloadHash: string;
  policyVersion: number;
  now: Date;
  reviewerHasPermission: boolean;
}

export function canTransitionAction(from: ActionRequestStatus, to: ActionRequestStatus): boolean {
  return allowedTransitions[from].includes(to);
}

export function transitionAction(from: ActionRequestStatus, to: ActionRequestStatus): ActionRequestStatus {
  if (!canTransitionAction(from, to)) {
    throw new Error(`Invalid Action Engine transition: ${from} → ${to}`);
  }
  return to;
}

export function validateApprovalBinding(binding: ApprovalBinding, candidate: ApprovalCandidate): void {
  if (!candidate.reviewerHasPermission) throw new Error('APPROVAL_REVIEWER_PERMISSION_DENIED');
  if (binding.actionRequestId !== candidate.actionRequestId) throw new Error('APPROVAL_ACTION_MISMATCH');
  if (binding.requestedByPrincipalId !== candidate.requestedByPrincipalId) throw new Error('APPROVAL_REQUESTOR_MISMATCH');
  if (binding.reviewerPrincipalId !== candidate.reviewerPrincipalId) throw new Error('APPROVAL_REVIEWER_MISMATCH');
  if (candidate.requestedByPrincipalId === candidate.reviewerPrincipalId) throw new Error('APPROVAL_SELF_REVIEW_DENIED');
  if (binding.normalizedPayloadHash !== candidate.normalizedPayloadHash) throw new Error('APPROVAL_PAYLOAD_STALE');
  if (binding.policyVersion !== candidate.policyVersion) throw new Error('APPROVAL_POLICY_STALE');
  if (binding.expiresAt <= candidate.now) throw new Error('APPROVAL_EXPIRED');
}

export function requiresApproval(mode: ActionAuthorityMode): boolean {
  return mode === 'CONFIRM';
}

export function canCreateExecutableAction(mode: ActionAuthorityMode): boolean {
  return mode !== 'RESTRICTED';
}
