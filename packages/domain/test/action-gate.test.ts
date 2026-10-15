import { describe, expect, it } from 'vitest';
import { authorizeAction } from '../src/index.js';

describe('HON Action Engine command gate', () => {
  it('uses a registered action and carries its platform authority floor', () => {
    expect(authorizeAction({
      actionCode: 'crm.trial.schedule',
      tier: 'ESSENTIAL',
      grantedPermissions: new Set(['crm.trial.schedule']),
      authoritySources: { platform: 'AUTO', school: 'AUTO' },
    })).toMatchObject({
      effectiveAuthority: 'AUTO',
      action: { code: 'crm.trial.schedule' },
    });
  });

  it('does not allow configuration to weaken a registered financial authority floor', () => {
    expect(authorizeAction({
      actionCode: 'billing.invoice.issue',
      tier: 'COMPLETE',
      grantedPermissions: new Set(['billing.invoice.issue']),
      authoritySources: { platform: 'AUTO', school: 'AUTO', agent: 'AUTO' },
    })).toMatchObject({ effectiveAuthority: 'CONFIRM' });
  });

  it('rejects restricted actions before it can create an executable request', () => {
    expect(() => authorizeAction({
      actionCode: 'billing.refund.create',
      tier: 'COMPLETE',
      grantedPermissions: new Set(['billing.refund.create']),
      authoritySources: { platform: 'AUTO' },
    })).toThrow('ACTION_RESTRICTED');
  });
});
