import type { AiTaskProfileDecision, AiTaskProfileDenial, AiTaskProfilePreviewRequest, AiTaskProfileRegistry } from '@hon/contracts';
import { aiConfigEnum, aiConfigInteger, aiConfigObject, aiConfigUuid, validateAiTaskProfileWrite } from './ai-provider-validation.js';
import { decideAiRoute, validateAiRoutingRegistry } from './ai-provider-router.js';

export function validateAiTaskProfilePreviewRequest(input: unknown): AiTaskProfilePreviewRequest {
  const value = aiConfigObject(input, ['profileId', 'selection', 'estimatedUnits']);
  return { profileId: aiConfigUuid(value.profileId), selection: aiConfigEnum(value.selection, ['DEFAULT', 'ADVANCED'] as const), estimatedUnits: aiConfigInteger(value.estimatedUnits, 1) };
}
/** Pure selection only: timeout/retry are metadata, not scheduling or execution. */
export function decideAiTaskProfileRoute(input: AiTaskProfilePreviewRequest, registry: AiTaskProfileRegistry): AiTaskProfileDecision {
  const base = { contractVersion: 1 as const, profileId: '', profileVersion: null as number | null, selection: null as 'DEFAULT' | 'ADVANCED' | null, policyId: '', policyVersion: null as number | null, budgetMicros: 0, authority: 'UNCHANGED' as const, execution: 'NOT_PERFORMED' as const };
  const deny = (reason: AiTaskProfileDenial): AiTaskProfileDecision => ({ ...base, status: 'DENIED', reason, chosen: null, fallbackCandidates: [] });
  let request: AiTaskProfilePreviewRequest;
  try {
    request = validateAiTaskProfilePreviewRequest(input);
    aiConfigObject(registry, ['tenant', 'asOf', 'providers', 'catalog', 'policies', 'profile']);
    const { profile, ...routing } = registry;
    validateAiRoutingRegistry(routing);
    const { version, ...data } = profile;
    aiConfigInteger(version, 1); validateAiTaskProfileWrite({ ...data, expectedVersion: version });
  } catch { return deny('INVALID_INPUT'); }
  const profile = registry.profile;
  base.profileId = request.profileId; base.selection = request.selection;
  if (profile.profileId !== request.profileId) return deny('PROFILE_NOT_ACTIVE');
  base.profileVersion = profile.version; base.policyId = profile.routingPolicyId; base.budgetMicros = profile.maxCostMicros;
  const now = Date.parse(registry.asOf);
  if (!profile.active || Date.parse(profile.effectiveFrom) > now || (profile.effectiveUntil !== null && now >= Date.parse(profile.effectiveUntil))) return deny('PROFILE_NOT_ACTIVE');
  const policy = registry.policies.find((p) => p.policyId === profile.routingPolicyId);
  if (!policy || !profile.requiredCapabilities.includes(policy.capability)) return deny('POLICY_NOT_ACTIVE');
  base.policyVersion = policy.version; base.budgetMicros = Math.min(profile.maxCostMicros, policy.maxCostMicros);
  const allIds = [profile.defaultCatalogId, ...profile.fallbackCatalogIds, ...(profile.advancedCatalogId === null ? [] : [profile.advancedCatalogId])];
  // A corrupted/revoked approval never becomes an alternate route.
  if (allIds.some((id) => !policy.catalogIds.includes(id))) return deny('POLICY_NOT_ACTIVE');
  if (request.selection === 'ADVANCED' && profile.advancedCatalogId === null) return deny('ADVANCED_NOT_CONFIGURED');
  const ids = request.selection === 'ADVANCED' ? [profile.advancedCatalogId!] : [profile.defaultCatalogId, ...profile.fallbackCatalogIds];
  const catalog = registry.catalog.filter((c) => profile.allowedProviderIds.includes(c.providerId)
    && profile.requiredCapabilities.every((cap) => c.capabilities.includes(cap))
    && profile.privacyControls.every((control) => c.privacyControls.includes(control)));
  // Reuse exactly the live policy/entitlement/catalog/provider/economics rules.
  const result = decideAiRoute({ organizationId: registry.tenant.organizationId, schoolId: registry.tenant.schoolId, policyId: policy.policyId, capability: policy.capability, requiredModalities: profile.requiredModalities, costUnit: profile.costUnit, estimatedUnits: request.estimatedUnits, budgetMicros: profile.maxCostMicros }, {
    tenant: registry.tenant, asOf: registry.asOf, providers: registry.providers, catalog, policies: [{ ...policy, catalogIds: ids }],
  });
  const identity = { profileId: base.profileId, profileVersion: base.profileVersion, selection: request.selection };
  if (result.status === 'DENIED') return { ...result, ...identity };
  return { ...result, ...identity,
    reason: request.selection === 'ADVANCED' ? 'ADVANCED' : result.chosen.catalogId !== profile.defaultCatalogId ? 'FALLBACK' : result.reason };
}
