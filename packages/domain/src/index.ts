import { ACTION_CATALOG } from '@hon/config';
import type {
  ActionAuthorityMode,
  HonTier,
  RegisteredAction,
  TenantScope,
} from '@hon/contracts';

export * from './action-engine.js';
export * from './action-gate.js';
export * from './usage-economics.js';
export * from './work-item-state.js';
export * from './ai-provider-validation.js';
export * from './ai-provider-router.js';
export * from './ai-model-evaluation.js';

export interface AuthorityPolicySources {
  platform: ActionAuthorityMode;
  organization?: ActionAuthorityMode;
  school?: ActionAuthorityMode;
  agent?: ActionAuthorityMode;
  dynamicRisk?: ActionAuthorityMode;
}

const authorityRank: Record<ActionAuthorityMode, number> = {
  AUTO: 0,
  CONFIRM: 1,
  RESTRICTED: 2,
};

const tierRank: Record<HonTier, number> = {
  ESSENTIAL: 0,
  CORE: 1,
  COMPLETE: 2,
};

export function resolveEffectiveAuthority(sources: AuthorityPolicySources): ActionAuthorityMode {
  return (Object.values(sources).filter(Boolean) as ActionAuthorityMode[]).reduce(
    (mostRestrictive, candidate) =>
      authorityRank[candidate] > authorityRank[mostRestrictive] ? candidate : mostRestrictive,
    sources.platform,
  );
}

export function actionDefinition(actionCode: string): RegisteredAction | undefined {
  return ACTION_CATALOG.find((action) => action.code === actionCode);
}

export function canUseAction(
  tier: HonTier,
  action: RegisteredAction,
  grantedPermissions: ReadonlySet<string>,
): { allowed: true } | { allowed: false; reason: 'TIER_ENTITLEMENT_REQUIRED' | 'PERMISSION_DENIED' } {
  if (tierRank[tier] < tierRank[action.minimumTier]) {
    return { allowed: false, reason: 'TIER_ENTITLEMENT_REQUIRED' };
  }

  if (!grantedPermissions.has(action.requiredPermission)) {
    return { allowed: false, reason: 'PERMISSION_DENIED' };
  }

  return { allowed: true };
}

export interface TenantScopedEntity extends TenantScope {
  id: string;
}

export function assertEntityInScope(entity: TenantScopedEntity, scope: TenantScope): void {
  if (entity.organizationId !== scope.organizationId || entity.schoolId !== scope.schoolId) {
    throw new Error('TENANT_SCOPE_DENIED');
  }
}

export * from './ai-invocation-planning.js';

export * from './automation-rule-planning.js';

export * from './ai-task-profile-router.js';
export * from './attendance-policy.js';

export * from './classpass.js';
export * from './kiosk.js';
