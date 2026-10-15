import { actionDefinition, canUseAction, resolveEffectiveAuthority, type AuthorityPolicySources } from './index.js';
import type { ActionAuthorityMode, HonTier, RegisteredAction } from '@hon/contracts';

export interface ActionGateInput {
  actionCode: string;
  tier: HonTier;
  grantedPermissions: ReadonlySet<string>;
  authoritySources: AuthorityPolicySources;
}

export interface AuthorizedAction {
  action: RegisteredAction;
  effectiveAuthority: ActionAuthorityMode;
}

export function authorizeAction(input: ActionGateInput): AuthorizedAction {
  const action = actionDefinition(input.actionCode);
  if (!action) throw new Error('ACTION_NOT_REGISTERED');

  const entitlement = canUseAction(input.tier, action, input.grantedPermissions);
  if (!entitlement.allowed) throw new Error(entitlement.reason);

  const effectiveAuthority = resolveEffectiveAuthority({
    ...input.authoritySources,
    platform: action.platformAuthorityFloor,
  });
  if (effectiveAuthority === 'RESTRICTED') throw new Error('ACTION_RESTRICTED');

  return { action, effectiveAuthority };
}
