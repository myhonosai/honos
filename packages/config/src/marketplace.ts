/** Descriptive human UI only. Never registered as Action Engine tools or automation targets. */
export const MARKETPLACE_COMMAND_REGISTRY = [
  { code: 'marketplace.browse', requiredPermission: 'marketplace.asset.read', capacity: 'OWNER' },
  { code: 'marketplace.asset', requiredPermission: 'marketplace.asset.manage', capacity: 'OWNER_OPERATOR' },
  { code: 'marketplace.selection', requiredPermission: 'marketplace.selection.save', capacity: 'OWNER' },
].map(c => ({ ...c, minimumTier: 'ESSENTIAL' as const, source: 'HUMAN_UI' as const, principalType: 'HUMAN_USER' as const,
  requiresCommunityOptIn: true as const, executionAllowed: false as const, purchaseAllowed: false as const, installationAllowed: false as const }));
