import { describe, expect, it } from 'vitest';
import {
  canCreateExecutableAction,
  canTransitionAction,
  transitionAction,
  validateApprovalBinding,
} from '../src/index.js';

describe('HON Action Engine state machine', () => {
  it('does not allow an unknown provider result to become success without reconciliation', () => {
    expect(canTransitionAction('UNKNOWN', 'SUCCEEDED')).toBe(false);
    expect(canTransitionAction('UNKNOWN', 'RECONCILING')).toBe(true);
    expect(canTransitionAction('RECONCILING', 'SUCCEEDED')).toBe(true);
  });

  it('requires validation before a confirmation can await approval', () => {
    expect(() => transitionAction('RECEIVED', 'AWAITING_APPROVAL')).toThrow('Invalid Action Engine transition');
    expect(transitionAction('VALIDATING', 'AWAITING_APPROVAL')).toBe('AWAITING_APPROVAL');
  });

  it('rejects stale approval bindings before execution', () => {
    const binding = {
      actionRequestId: 'action-1',
      requestedByPrincipalId: 'requestor-1',
      reviewerPrincipalId: 'reviewer-1',
      normalizedPayloadHash: 'payload-a',
      policyVersion: 4,
      expiresAt: new Date('2026-10-15T00:00:00.000Z'),
    };
    expect(() => validateApprovalBinding(binding, {
      actionRequestId: 'action-1',
      requestedByPrincipalId: 'requestor-1',
      reviewerPrincipalId: 'reviewer-1',
      normalizedPayloadHash: 'payload-b',
      policyVersion: 4,
      now: new Date('2026-10-14T00:00:00.000Z'),
      reviewerHasPermission: true,
    })).toThrow('APPROVAL_PAYLOAD_STALE');
  });

  it('rejects a requestor approving their own action', () => {
    const binding = {
      actionRequestId: 'action-1',
      requestedByPrincipalId: 'principal-1',
      reviewerPrincipalId: 'principal-1',
      normalizedPayloadHash: 'payload-a',
      policyVersion: 4,
      expiresAt: new Date('2026-10-15T00:00:00.000Z'),
    };
    expect(() => validateApprovalBinding(binding, {
      actionRequestId: 'action-1',
      requestedByPrincipalId: 'principal-1',
      reviewerPrincipalId: 'principal-1',
      normalizedPayloadHash: 'payload-a',
      policyVersion: 4,
      now: new Date('2026-10-14T00:00:00.000Z'),
      reviewerHasPermission: true,
    })).toThrow('APPROVAL_SELF_REVIEW_DENIED');
  });

  it('binds an approval to its qualified reviewer', () => {
    const binding = {
      actionRequestId: 'action-1',
      requestedByPrincipalId: 'requestor-1',
      reviewerPrincipalId: 'reviewer-1',
      normalizedPayloadHash: 'payload-a',
      policyVersion: 4,
      expiresAt: new Date('2026-10-15T00:00:00.000Z'),
    };
    expect(() => validateApprovalBinding(binding, {
      actionRequestId: 'action-1',
      requestedByPrincipalId: 'requestor-1',
      reviewerPrincipalId: 'reviewer-2',
      normalizedPayloadHash: 'payload-a',
      policyVersion: 4,
      now: new Date('2026-10-14T00:00:00.000Z'),
      reviewerHasPermission: true,
    })).toThrow('APPROVAL_REVIEWER_MISMATCH');
  });

  it('will not create an executable action for Restricted authority', () => {
    expect(canCreateExecutableAction('RESTRICTED')).toBe(false);
    expect(canCreateExecutableAction('CONFIRM')).toBe(true);
  });
});
