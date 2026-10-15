/** Internal UI commands, NOT Action Engine tools. No provider, financial, AI or communication executor exists. */
export const DOCUMENT_COMMAND_REGISTRY = [
  { code: 'document.template.create', requiredPermission: 'document.template.create', minimumTier: 'ESSENTIAL', sensitive: true, source: 'HUMAN_UI', principalType: 'HUMAN_USER', execution: 'HUMAN_ONLY' },
  { code: 'document.template.version', requiredPermission: 'document.template.version', minimumTier: 'ESSENTIAL', sensitive: true, source: 'HUMAN_UI', principalType: 'HUMAN_USER', execution: 'HUMAN_ONLY' },
  { code: 'document.publish', requiredPermission: 'document.publish', minimumTier: 'ESSENTIAL', sensitive: true, source: 'HUMAN_UI', principalType: 'HUMAN_USER', execution: 'HUMAN_ONLY' },
  { code: 'document.acknowledge', requiredPermission: 'document.acknowledge', parentAuthority: 'VERIFIED_FAMILY_GUARDIAN_RESOLVER', minimumTier: 'ESSENTIAL', sensitive: true, source: 'HUMAN_UI', principalType: 'HUMAN_USER', execution: 'HUMAN_ONLY' },
] as const;
