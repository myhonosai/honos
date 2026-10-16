import {
  AI_CAPABILITIES, AI_CONNECTION_STATES, AI_MODALITIES, AI_PROVIDER_IDS, HON_TIERS,
  type AiRouteCandidate, type AiRouteDecision, type AiRouteDenial, type AiRouteRequest, type AiRoutingRegistry,
} from '@hon/contracts';
import { AI_COST_UNITS, aiConfigEnum, aiConfigInteger, aiConfigObject, aiConfigUuid, validateAiControlPlaneWrite } from './ai-provider-validation.js';

const tierRank = { ESSENTIAL: 0, CORE: 1, COMPLETE: 2 } as const;
export function validateAiRouteRequest(input: unknown): AiRouteRequest {
  const value = aiConfigObject(input, ['organizationId', 'schoolId', 'policyId', 'capability', 'requiredModalities', 'costUnit', 'estimatedUnits', 'budgetMicros']);
  if (!Array.isArray(value.requiredModalities) || value.requiredModalities.length < 1 || value.requiredModalities.length > AI_MODALITIES.length) throw new Error('VALIDATION_FAILED');
  const requiredModalities = value.requiredModalities.map((item) => aiConfigEnum(item, AI_MODALITIES));
  if (new Set(requiredModalities).size !== requiredModalities.length) throw new Error('VALIDATION_FAILED');
  return {
    organizationId: aiConfigUuid(value.organizationId), schoolId: aiConfigUuid(value.schoolId), policyId: aiConfigUuid(value.policyId),
    capability: aiConfigEnum(value.capability, AI_CAPABILITIES), requiredModalities,
    costUnit: aiConfigEnum(value.costUnit, AI_COST_UNITS), estimatedUnits: aiConfigInteger(value.estimatedUnits, 1), budgetMicros: aiConfigInteger(value.budgetMicros),
  };
}
export function validateAiRoutingRegistry(registry: AiRoutingRegistry): void {
  aiConfigObject(registry, ['tenant', 'asOf', 'providers', 'catalog', 'policies']);
  aiConfigObject(registry.tenant, ['organizationId', 'schoolId', 'tier', 'entitlementActive']);
  aiConfigUuid(registry.tenant.organizationId); aiConfigUuid(registry.tenant.schoolId);
  aiConfigEnum(registry.tenant.tier, HON_TIERS);
  if (typeof registry.tenant.entitlementActive !== 'boolean' || typeof registry.asOf !== 'string' || !Number.isFinite(Date.parse(registry.asOf))) throw new Error('VALIDATION_FAILED');
  for (const collection of [registry.providers, registry.catalog, registry.policies]) if (!Array.isArray(collection)) throw new Error('VALIDATION_FAILED');
  for (const provider of registry.providers) {
    aiConfigObject(provider, ['providerId', 'displayName', 'state', 'credentialConfigured', 'version']);
    aiConfigEnum(provider.providerId, AI_PROVIDER_IDS); aiConfigEnum(provider.state, AI_CONNECTION_STATES); aiConfigInteger(provider.version, 1);
    if (typeof provider.credentialConfigured !== 'boolean') throw new Error('VALIDATION_FAILED');
    // Validate metadata without accepting or carrying a credential ref.
    validateAiControlPlaneWrite('PROVIDER', { providerId: provider.providerId, displayName: provider.displayName, state: 'DISABLED', credentialSecretRef: null, expectedVersion: provider.version });
  }
  for (const entry of registry.catalog) {
    const { version, ...data } = entry;
    aiConfigInteger(version, 1); validateAiControlPlaneWrite('CATALOG', { ...data, expectedVersion: version });
  }
  for (const policy of registry.policies) {
    const { version, ...data } = policy;
    aiConfigInteger(version, 1); validateAiControlPlaneWrite('POLICY', { ...data, expectedVersion: version });
  }
  if (new Set(registry.providers.map((p) => p.providerId)).size !== registry.providers.length
    || new Set(registry.catalog.map((p) => p.catalogId)).size !== registry.catalog.length
    || new Set(registry.policies.map((p) => p.policyId)).size !== registry.policies.length) throw new Error('VALIDATION_FAILED');
}
/** No I/O, credentials, LLM calls, worker, tools, or permission grants. */
export function decideAiRoute(input: AiRouteRequest, registry: AiRoutingRegistry): AiRouteDecision {
  const base = { contractVersion: 1 as const, policyId: '', policyVersion: null as number | null, budgetMicros: 0, authority: 'UNCHANGED' as const, execution: 'NOT_PERFORMED' as const };
  const deny = (reason: AiRouteDenial): AiRouteDecision => ({ ...base, status: 'DENIED', reason, chosen: null, fallbackCandidates: [] });
  let request: AiRouteRequest;
  try { request = validateAiRouteRequest(input); validateAiRoutingRegistry(registry); } catch { return deny('INVALID_INPUT'); }
  base.policyId = request.policyId;
  base.budgetMicros = request.budgetMicros;
  const tenant = registry.tenant;
  const now = Date.parse(registry.asOf);
  const effective = (item: { active: boolean; effectiveFrom: string; effectiveUntil: string | null }) => item.active && Date.parse(item.effectiveFrom) <= now && (item.effectiveUntil === null || now < Date.parse(item.effectiveUntil));
  const policy = registry.policies.find((p) => p.policyId === request.policyId && p.organizationId === tenant.organizationId && p.schoolId === tenant.schoolId);
  if (tenant.organizationId !== request.organizationId || tenant.schoolId !== request.schoolId || !policy || policy.capability !== request.capability || !effective(policy)) return deny('POLICY_NOT_ACTIVE');
  base.policyVersion = policy.version;
  base.budgetMicros = Math.min(request.budgetMicros, policy.maxCostMicros);
  if (!tenant.entitlementActive || tierRank[tenant.tier] < tierRank[policy.minimumTier]) return deny('TIER_REQUIRED');
  const candidates: AiRouteCandidate[] = [];
  for (const catalogId of policy.catalogIds) {
    const entry = registry.catalog.find((c) => c.catalogId === catalogId);
    if (!entry || !effective(entry) || entry.costUnit !== request.costUnit || tierRank[tenant.tier] < tierRank[entry.minimumTier]
      || !entry.capabilities.includes(request.capability) || request.requiredModalities.some((m) => !entry.modalities.includes(m))) continue;
    const provider = registry.providers.find((p) => p.providerId === entry.providerId);
    if (!provider || !provider.credentialConfigured || (provider.state !== 'HEALTHY' && !(provider.state === 'DEGRADED' && policy.allowDegraded))) continue;
    const cost = BigInt(entry.unitCostMicros) * BigInt(request.estimatedUnits);
    if (cost > BigInt(base.budgetMicros)) continue;
    candidates.push({ catalogId, providerId: entry.providerId, modelId: entry.modelId, estimatedCostMicros: Number(cost), costUnit: entry.costUnit, state: provider.state as 'HEALTHY' | 'DEGRADED' });
  }
  const chosen = candidates[0];
  if (!chosen) return deny('NO_ELIGIBLE_CANDIDATE');
  return { ...base, status: 'SELECTED', reason: chosen.state === 'DEGRADED' ? 'DEGRADED_ALLOWED' : chosen.catalogId === policy.catalogIds[0] ? 'PRIMARY' : 'FALLBACK', chosen, fallbackCandidates: candidates.slice(1) };
}
