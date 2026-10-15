import { CRM_FOLLOW_UP_PERMISSIONS } from '@hon/contracts';
/** Direct human UI only. Not Action Engine actions or automation/AI proposals. */
export const CRM_FOLLOW_UP_COMMAND_REGISTRY = CRM_FOLLOW_UP_PERMISSIONS.map(code => ({
  code, requiredPermission: code, additionalPermission: 'crm.lead.read' as const,
  minimumTier: 'ESSENTIAL' as const, source: 'HUMAN_UI' as const,
  principalType: 'HUMAN_USER' as const, execution: 'HUMAN_ONLY' as const,
}));
