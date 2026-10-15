/** Not Action Engine tools, provider actions, public APIs or automation targets. */
export const COMMUNITY_COMMAND_REGISTRY = [
  { code: 'community.profile', requiredPermission: 'community.participate' },
  { code: 'community.content', requiredPermission: 'community.participate' },
  { code: 'community.organization', requiredPermission: 'community.organization.manage' },
].map(c => ({ ...c, verification: 'MANUALLY_VERIFIED_OWNER_OPERATOR' as const, minimumTier: 'ESSENTIAL' as const, source: 'HUMAN_UI' as const, principalType: 'HUMAN_USER' as const, execution: 'HUMAN_ONLY' as const, executionAllowed: false as const }));
