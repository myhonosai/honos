import { AUTOMATION_RULE_PERMISSIONS } from '@hon/contracts';
/** Never part of ACTION_CATALOG or any tool/execution registry. */
export const AUTOMATION_RULE_COMMAND_REGISTRY = AUTOMATION_RULE_PERMISSIONS.map(code => ({
  code, requiredPermission: code, minimumTier: 'ESSENTIAL' as const, source: 'HUMAN_UI' as const,
  principalType: 'HUMAN_USER' as const, execution: 'CONFIGURATION_ONLY' as const, configurationOnly: true as const,
}));
/** Stable implemented v1 metadata only; payment-failed is deliberately absent. */
export const AUTOMATION_RULE_TRIGGER_REGISTRY = [
  { kind: 'LEAD_CREATED', eventType: 'crm.lead.created', schemaVersion: 1, minimumTier: 'ESSENTIAL' },
  { kind: 'TRIAL_NO_SHOW', eventType: 'crm.trial.outcome.recorded', schemaVersion: 1, status: 'NO_SHOW', minimumTier: 'ESSENTIAL' },
] as const;
