import { TEACHING_STUDIO_PERMISSIONS } from '@hon/contracts';

/** Conventional staff authoring only; deliberately absent from Action Engine and tool registries. */
export const TEACHING_STUDIO_COMMAND_REGISTRY = TEACHING_STUDIO_PERMISSIONS.map(code => ({
  code, requiredPermission: code, minimumTier: 'ESSENTIAL' as const,
  source: 'HUMAN_UI' as const, principalType: 'HUMAN_USER' as const,
  execution: 'HUMAN_ONLY' as const, instructionalOnly: true as const,
}));
