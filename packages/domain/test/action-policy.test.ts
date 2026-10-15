import { describe, expect, it } from 'vitest';
import { actionDefinition, canUseAction, resolveEffectiveAuthority } from '../src/index.js';

describe('HON Action Engine policy invariants', () => {
  it('always selects the most restrictive authority source', () => {
    expect(resolveEffectiveAuthority({
      platform: 'AUTO',
      organization: 'AUTO',
      school: 'CONFIRM',
      agent: 'AUTO',
      dynamicRisk: 'RESTRICTED',
    })).toBe('RESTRICTED');
  });

  it('does not permit a lower tier to invoke a Core billing action', () => {
    const action = actionDefinition('billing.invoice.issue');
    expect(action).toBeDefined();
    expect(canUseAction('ESSENTIAL', action!, new Set(['billing.invoice.issue']))).toEqual({
      allowed: false,
      reason: 'TIER_ENTITLEMENT_REQUIRED',
    });
  });

  it('requires the registered permission even at the appropriate tier', () => {
    const action = actionDefinition('billing.invoice.issue');
    expect(action).toBeDefined();
    expect(canUseAction('COMPLETE', action!, new Set())).toEqual({
      allowed: false,
      reason: 'PERMISSION_DENIED',
    });
  });

  it('allows only a qualified principal to invoke the registered action', () => {
    const action = actionDefinition('crm.trial.schedule');
    expect(action).toBeDefined();
    expect(canUseAction('ESSENTIAL', action!, new Set(['crm.trial.schedule']))).toEqual({ allowed: true });
  });
});
