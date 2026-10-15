import type { AiInvocationTaskClass } from '@hon/contracts';

/** Must match the immutable SQL planning contract; these are not customer settings. */
export const AI_INVOCATION_PLANNING_LIMITS = {
  modality: 'TEXT',
  maxInputBudget: 128_000,
  maxOutputBudget: 16_000,
  maxProviderCostMicrounits: 1_000_000,
  tokensPerEstimatedCustomerCredit: 1_000,
} as const;

export const AI_INVOCATION_PLANNING_TASKS: Record<AiInvocationTaskClass, {
  workType: string;
  riskClass: 'LOW' | 'MODERATE';
}> = {
  SUMMARIZE: { workType: 'AI_SUMMARIZE', riskClass: 'LOW' },
  ANALYZE: { workType: 'AI_ANALYZE', riskClass: 'MODERATE' },
  DRAFT_MARKETING: { workType: 'AI_DRAFT_MARKETING', riskClass: 'MODERATE' },
  DRAFT_TEACHING: { workType: 'AI_DRAFT_TEACHING', riskClass: 'MODERATE' },
};
