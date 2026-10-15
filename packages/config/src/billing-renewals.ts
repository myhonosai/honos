import { BILLING_RENEWAL_PERMISSIONS } from '@hon/contracts';
/** Shared school finance/manager records. No self shortcut, AI or automation action. */
export const BILLING_RENEWAL_COMMAND_REGISTRY = [{
  code: 'billing.renewal.manage', requiredPermission: BILLING_RENEWAL_PERMISSIONS[1],
  additionalPermission: BILLING_RENEWAL_PERMISSIONS[0], minimumTier: 'ESSENTIAL' as const,
  source: 'HUMAN_UI' as const, principalType: 'HUMAN_USER' as const, execution: 'HUMAN_ONLY' as const,
}];
