import { STAFF_AVAILABILITY_PERMISSIONS } from '@hon/contracts';
/** Metadata only: these are never executable Action Engine tools. */
export const STAFF_AVAILABILITY_COMMAND_REGISTRY = STAFF_AVAILABILITY_PERMISSIONS.map(code => ({
  code, requiredPermission: code, minimumTier: 'ESSENTIAL' as const,
  source: 'HUMAN_UI' as const, principalType: 'HUMAN_USER' as const,
  execution: 'HUMAN_ONLY' as const, planningOnly: true as const,
}));
