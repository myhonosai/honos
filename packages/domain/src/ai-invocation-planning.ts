import {
  AI_INVOCATION_TASK_CLASSES, AI_INVOCATION_PLANNING_STATES, AI_INVOCATION_PLANNING_AGENT_KEYS,
  type PlanAiInvocationInput,
} from '@hon/contracts';
import { AI_INVOCATION_PLANNING_LIMITS } from '@hon/config';
import { aiConfigEnum, aiConfigInteger, aiConfigObject } from './ai-provider-validation.js';

/** Unknown fields fail closed before any transaction, hash, log or persistence. */
export function validateAiInvocationPlanInput(input: unknown): PlanAiInvocationInput {
  const value = aiConfigObject(input, ['expectedVersion', 'expectedState', 'agentKey', 'modality', 'taskClass', 'inputBudget', 'outputBudget', 'maxProviderCostMicrounits']);
  const expectedVersion = aiConfigInteger(value.expectedVersion, 1);
  const inputBudget = aiConfigInteger(value.inputBudget, 1);
  const outputBudget = aiConfigInteger(value.outputBudget, 1);
  const maxProviderCostMicrounits = aiConfigInteger(value.maxProviderCostMicrounits);
  if (expectedVersion > 2_147_483_646 || inputBudget > AI_INVOCATION_PLANNING_LIMITS.maxInputBudget
    || outputBudget > AI_INVOCATION_PLANNING_LIMITS.maxOutputBudget
    || maxProviderCostMicrounits > AI_INVOCATION_PLANNING_LIMITS.maxProviderCostMicrounits) throw new Error('VALIDATION_FAILED');
  return {
    expectedVersion, expectedState: aiConfigEnum(value.expectedState, AI_INVOCATION_PLANNING_STATES),
    agentKey: aiConfigEnum(value.agentKey, AI_INVOCATION_PLANNING_AGENT_KEYS),
    modality: aiConfigEnum(value.modality, [AI_INVOCATION_PLANNING_LIMITS.modality]),
    taskClass: aiConfigEnum(value.taskClass, AI_INVOCATION_TASK_CLASSES),
    inputBudget, outputBudget, maxProviderCostMicrounits,
  };
}
