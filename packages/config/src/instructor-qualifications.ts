import { INSTRUCTOR_QUALIFICATION_PERMISSIONS } from '@hon/contracts';

/**
 * Conventional human-recorded evidence only. These records deliberately have no
 * Action Engine tool, AI, automation, provider, scheduler, testing, payroll, or
 * employment-effect adapter.
 */
export const INSTRUCTOR_QUALIFICATION_COMMAND_REGISTRY = INSTRUCTOR_QUALIFICATION_PERMISSIONS.map(code => ({
  code,
  requiredPermission: code,
  minimumTier: 'ESSENTIAL' as const,
  source: 'HUMAN_UI' as const,
  principalType: 'HUMAN_USER' as const,
  execution: 'HUMAN_ONLY' as const,
  inertEvidence: true as const,
  eligibilityDecision: false as const,
}));
