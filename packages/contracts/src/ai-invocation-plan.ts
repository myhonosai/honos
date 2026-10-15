import type { HonAiTeamAgentKey } from './ai-team.js';
import type { AiProviderId } from './ai-provider.js';

export const AI_INVOCATION_TASK_CLASSES = ['SUMMARIZE', 'ANALYZE'] as const;
export type AiInvocationTaskClass = (typeof AI_INVOCATION_TASK_CLASSES)[number];
export const AI_INVOCATION_PLANNING_STATES = ['READY', 'THINKING'] as const;
export type AiInvocationPlanningState = (typeof AI_INVOCATION_PLANNING_STATES)[number];

/** Internal server-only metadata. No prompt, content, route, tier or authority. */
export interface PlanAiInvocationInput {
  expectedVersion: number;
  expectedState: AiInvocationPlanningState;
  agentKey: HonAiTeamAgentKey;
  modality: 'TEXT';
  taskClass: AiInvocationTaskClass;
  /** Upper bounds in tokens for the first TEXT-only planning slice. */
  inputBudget: number;
  outputBudget: number;
  maxProviderCostMicrounits: number;
}

/** Immutable historical choice, NOT a provider result or executable authority. */
export interface AiInvocationPlanSummary {
  id: string;
  workItemId: string;
  workItemVersion: number;
  workItemState: AiInvocationPlanningState;
  agentKey: HonAiTeamAgentKey;
  modality: 'TEXT';
  taskClass: AiInvocationTaskClass;
  riskClass: 'LOW' | 'MODERATE';
  inputBudget: number;
  outputBudget: number;
  maxProviderCostMicrounits: number;
  estimatedProviderCostMicrounits: number;
  customerCreditEstimate: number;
  providerId: AiProviderId;
  modelId: string;
  catalogId: string;
  catalogVersion: number;
  routingPolicyId: string;
  routingPolicyVersion: number;
  providerVersion: number;
  requestHash: string;
  status: 'PLANNED';
  createdAt: string;
}

export type AiInvocationPlanningResult = {
  authority: 'UNCHANGED';
  execution: 'NOT_PERFORMED';
} & (
  | { status: 'PLANNED'; plan: AiInvocationPlanSummary; replayed: boolean }
  | { status: 'NO_CHOICE'; reason: 'NO_ELIGIBLE_ROUTE' | 'CUSTOMER_BUDGET_EXCEEDED'; plan: null; replayed: false }
);
