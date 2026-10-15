import { describe, expect, it } from 'vitest';
import { AI_INVOCATION_PLANNING_LIMITS, AI_INVOCATION_PLANNING_TASKS } from '@hon/config';
import { actionDefinition, authorizeAction, canUseAction, validateAiInvocationPlanInput } from '../src/index.js';

const input = { expectedVersion: 1, expectedState: 'READY', agentKey: 'alex', modality: 'TEXT', taskClass: 'SUMMARIZE', inputBudget: 1000, outputBudget: 500, maxProviderCostMicrounits: 100_000 } as const;

describe('AI invocation planning metadata only', () => {
  it('normalizes only code-owned planning fields', () => {
    expect(validateAiInvocationPlanInput(input)).toEqual(input);
    expect(AI_INVOCATION_PLANNING_TASKS.SUMMARIZE).toEqual({ workType: 'AI_SUMMARIZE', riskClass: 'LOW' });
    expect(AI_INVOCATION_PLANNING_TASKS.ANALYZE.riskClass).toBe('MODERATE');
    expect(AI_INVOCATION_PLANNING_LIMITS.modality).toBe('TEXT');
  });
  it.each(['prompt', 'messages', 'output', 'secret', 'credentialSecretRef', 'providerId', 'modelId', 'policyId', 'routingPolicyId', 'budget', 'tier', 'riskClass', 'authorityMode', 'toolIds', 'actionRequestId', 'delegatedByPrincipalId', 'payload'])('rejects %s, never drops or hashes it', (key) => {
    expect(() => validateAiInvocationPlanInput({ ...input, [key]: 'forbidden' })).toThrow('VALIDATION_FAILED');
  });
  it.each([
    { modality: 'IMAGE' }, { taskClass: 'TOOL_EXECUTION' }, { agentKey: 'sk-raw-secret' },
    { expectedState: 'WORKING' }, { expectedState: 'COMPLETED' }, { expectedVersion: 0 },
    { inputBudget: 128001 }, { outputBudget: 16001 }, { inputBudget: 1.1 },
    { outputBudget: -1 }, { maxProviderCostMicrounits: 1000001 }, { maxProviderCostMicrounits: -1 },
  ])('rejects unsafe or unbounded metadata %j', (patch) => {
    expect(() => validateAiInvocationPlanInput({ ...input, ...patch })).toThrow('VALIDATION_FAILED');
  });
  it('requires every field and rejects null/arbitrary objects', () => {
    for (const value of [null, [], {}, { ...input, inputBudget: undefined }]) expect(() => validateAiInvocationPlanInput(value)).toThrow('VALIDATION_FAILED');
  });
  it('registers exact Complete-only, restricted, human planning metadata without a tool', () => {
    const action = actionDefinition('ai.invocation.plan')!;
    expect(action).toEqual({ code: 'ai.invocation.plan', requiredPermission: 'ai.invocation.plan', minimumTier: 'COMPLETE', platformAuthorityFloor: 'RESTRICTED', riskClass: 'MODERATE' });
    for (const tier of ['ESSENTIAL', 'CORE'] as const) expect(canUseAction(tier, action, new Set(['ai.invocation.plan']))).toEqual({ allowed: false, reason: 'TIER_ENTITLEMENT_REQUIRED' });
    expect(canUseAction('COMPLETE', action, new Set())).toEqual({ allowed: false, reason: 'PERMISSION_DENIED' });
    expect(canUseAction('COMPLETE', action, new Set(['ai.invocation.plan']))).toEqual({ allowed: true });
    expect(() => authorizeAction({ actionCode: action.code, tier: 'COMPLETE', grantedPermissions: new Set(['ai.invocation.plan']), authoritySources: { platform: action.platformAuthorityFloor, school: 'AUTO', agent: 'AUTO', dynamicRisk: 'AUTO' } })).toThrow('ACTION_RESTRICTED');
  });
});
