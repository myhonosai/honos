import { describe, expect, it } from 'vitest';
import { canTransitionAction, transitionAction } from '../src/index.js';

describe('HON Action Engine execution transitions', () => {
  it('allows execution only from an approved action', () => {
    expect(transitionAction('APPROVED', 'EXECUTING')).toBe('EXECUTING');
    expect(canTransitionAction('AWAITING_APPROVAL', 'EXECUTING')).toBe(false);
    expect(canTransitionAction('DENIED', 'EXECUTING')).toBe(false);
    expect(canTransitionAction('EXPIRED', 'EXECUTING')).toBe(false);
  });

  it('requires reconciliation after an unknown execution outcome', () => {
    expect(transitionAction('EXECUTING', 'UNKNOWN')).toBe('UNKNOWN');
    expect(canTransitionAction('UNKNOWN', 'SUCCEEDED')).toBe(false);
    expect(transitionAction('UNKNOWN', 'RECONCILING')).toBe('RECONCILING');
  });
});
