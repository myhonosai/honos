import { describe, expect, it, vi } from 'vitest';
import type { AiCatalogEntryWrite, AiProviderConnectionWrite, AiRouteRequest, AiRoutingRegistry, AiTaskProfileWrite, AiTaskProfileRegistry } from '@hon/contracts';
import { decideAiRoute, validateAiControlPlaneWrite, decideAiTaskProfileRoute, validateAiTaskProfilePreviewRequest } from '../src/index.js';

const organizationId = '11111111-1111-4111-8111-111111111111';
const schoolId = '22222222-2222-4222-8222-222222222222';
const policyId = '33333333-3333-4333-8333-333333333333';
const firstId = '44444444-4444-4444-8444-444444444444';
const secondId = '55555555-5555-4555-8555-555555555555';
const provider: AiProviderConnectionWrite = { providerId: 'OPENROUTER', displayName: 'HQ Text', state: 'CONFIGURED', credentialSecretRef: 'hon-secret:66666666-6666-4666-8666-666666666666', expectedVersion: 0 };
const entry: AiCatalogEntryWrite = { catalogId: firstId, providerId: 'OPENROUTER', modelId: 'approved/text-v1', displayName: 'Approved Text', capabilities: ['TEXT', 'TOOL_EXECUTION'], modalities: ['TEXT'], privacyControls: [], active: true, minimumTier: 'CORE', unitCostMicros: 10, costUnit: 'TOKEN', effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveUntil: null, expectedVersion: 0 };
const request: AiRouteRequest = { organizationId, schoolId, policyId, capability: 'TEXT', requiredModalities: ['TEXT'], costUnit: 'TOKEN', estimatedUnits: 10, budgetMicros: 200 };
function registry(): AiRoutingRegistry {
  const { expectedVersion: _, ...catalog } = entry;
  const catalogSnapshot = { ...catalog, privacyControls: catalog.privacyControls ?? [] };
  return {
    tenant: { organizationId, schoolId, tier: 'CORE', entitlementActive: true }, asOf: '2026-06-01T00:00:00.000Z',
    providers: [{ providerId: 'OPENROUTER', displayName: 'HQ Text', state: 'HEALTHY', credentialConfigured: true, version: 1 }, { providerId: 'DIRECT_LLM_API', displayName: 'HQ Fallback', state: 'HEALTHY', credentialConfigured: true, version: 1 }],
    catalog: [{ ...catalogSnapshot, version: 1 }, { ...catalogSnapshot, catalogId: secondId, providerId: 'DIRECT_LLM_API', modelId: 'approved/fallback-v1', unitCostMicros: 5, version: 1 }],
    policies: [{ organizationId, schoolId, policyId, capability: 'TEXT', active: true, minimumTier: 'CORE', maxCostMicros: 150, allowDegraded: false, catalogIds: [firstId, secondId], effectiveFrom: entry.effectiveFrom, effectiveUntil: null, version: 1 }],
  };
}

describe('HQ AI configuration validation', () => {
  it('accepts only an opaque UUID reference, not a credential value', () => {
    expect(validateAiControlPlaneWrite('PROVIDER', provider)).toEqual(provider);
    expect(validateAiControlPlaneWrite('PROVIDER', { ...provider, state: 'DISABLED', credentialSecretRef: null })).toMatchObject({ state: 'DISABLED' });
  });
  it.each(['sk-rejected-example', 'Bearer rejected-example', 'eyJhbGciOiJIUzI1NiJ9.example.signature', 'password=example', 'a'.repeat(48), 'https://unapproved.example', 'hon-secret:sk-rejected-example'])('rejects raw secret/ref value %s', (raw) => {
    expect(() => validateAiControlPlaneWrite('PROVIDER', { ...provider, credentialSecretRef: raw })).toThrow('VALIDATION_FAILED');
  });
  it.each(['apiKey', 'token', 'password', 'jwt', 'baseUrl', 'endpoint', 'metadata', 'tools', 'permissionCodes', 'authorityMode', 'delegatedByPrincipalId', 'actionRequestId'])('rejects forbidden config field %s rather than silently dropping it', (key) => {
    expect(() => validateAiControlPlaneWrite('PROVIDER', { ...provider, [key]: 'rejected' })).toThrow('VALIDATION_FAILED');
  });
  it('rejects arbitrary providers and raw secrets smuggled into non-secret metadata', () => {
    expect(() => validateAiControlPlaneWrite('PROVIDER', { ...provider, providerId: 'ARBITRARY' })).toThrow();
    for (const displayName of ['sk-rejected-example', 'Bearer value', 'password value', 'eyJheader.payload.signature', 'a'.repeat(48)]) expect(() => validateAiControlPlaneWrite('PROVIDER', { ...provider, displayName })).toThrow();
    expect(() => validateAiControlPlaneWrite('CATALOG', { ...entry, modelId: 'https://unapproved.example/model' })).toThrow();
  });
  it('rejects malformed references, untested configuration without reference, duplicate capabilities, fractional cost, and invalid windows', () => {
    expect(() => validateAiControlPlaneWrite('PROVIDER', { ...provider, credentialSecretRef: null })).toThrow();
    expect(() => validateAiControlPlaneWrite('CATALOG', { ...entry, capabilities: ['TEXT', 'TEXT'] })).toThrow();
    expect(() => validateAiControlPlaneWrite('CATALOG', { ...entry, unitCostMicros: 0.1 })).toThrow();
    expect(() => validateAiControlPlaneWrite('CATALOG', { ...entry, effectiveUntil: entry.effectiveFrom })).toThrow();
    expect(() => validateAiControlPlaneWrite('CATALOG', { ...entry, effectiveFrom: '2026-02-31T00:00:00.000Z' })).toThrow();
  });
});

describe('deterministic selection-only router', () => {
  it('selects registered primary and ordered fallback within the stricter budget', () => {
    expect(decideAiRoute(request, registry())).toMatchObject({ status: 'SELECTED', reason: 'PRIMARY', budgetMicros: 150, chosen: { providerId: 'OPENROUTER', catalogId: firstId, estimatedCostMicros: 100 }, fallbackCandidates: [{ catalogId: secondId, estimatedCostMicros: 50 }], authority: 'UNCHANGED', execution: 'NOT_PERFORMED' });
  });
  it.each(['DISABLED', 'CONFIGURED', 'UNAVAILABLE', 'DEGRADED'] as const)('skips %s without relaxing the policy', (state) => {
    const data = registry(); data.providers[0]!.state = state;
    expect(decideAiRoute(request, data)).toMatchObject({ status: 'SELECTED', reason: 'FALLBACK', chosen: { catalogId: secondId } });
  });
  it('uses degraded only when explicitly allowed, preserving fallback order', () => {
    const data = registry(); data.providers[0]!.state = 'DEGRADED'; data.policies[0]!.allowDegraded = true;
    expect(decideAiRoute(request, data)).toMatchObject({ status: 'SELECTED', reason: 'DEGRADED_ALLOWED', chosen: { catalogId: firstId } });
  });
  it('fails closed on missing credentials even if claimed healthy', () => {
    const data = registry(); data.providers.forEach((p) => { p.credentialConfigured = false; });
    expect(decideAiRoute(request, data)).toMatchObject({ status: 'DENIED', reason: 'NO_ELIGIBLE_CANDIDATE' });
  });
  it('enforces live policy tier and entitlement rather than caller tier', () => {
    const data = registry(); data.tenant.tier = 'ESSENTIAL';
    expect(decideAiRoute(request, data)).toMatchObject({ status: 'DENIED', reason: 'TIER_REQUIRED' });
    data.tenant.tier = 'COMPLETE'; data.tenant.entitlementActive = false;
    expect(decideAiRoute(request, data)).toMatchObject({ reason: 'TIER_REQUIRED' });
    expect(decideAiRoute({ ...request, tier: 'COMPLETE' } as AiRouteRequest, registry())).toMatchObject({ reason: 'INVALID_INPUT' });
  });
  it('fallback cannot bypass catalog tier, capability, modality, unit, or budget', () => {
    const data = registry(); data.providers[0]!.state = 'DISABLED';
    const fallback = data.catalog[1]!;
    for (const change of [{ minimumTier: 'COMPLETE' }, { capabilities: ['IMAGE'] }, { modalities: ['IMAGE'] }, { costUnit: 'REQUEST' }, { unitCostMicros: 16 }]) {
      const copy = structuredClone(data); Object.assign(copy.catalog[1]!, change);
      expect(decideAiRoute(request, copy)).toMatchObject({ status: 'DENIED', reason: 'NO_ELIGIBLE_CANDIDATE', authority: 'UNCHANGED' });
    }
    expect(fallback.minimumTier).toBe('CORE');
  });
  it('clamps request and policy budget and avoids overflow with integer micro-units', () => {
    expect(decideAiRoute({ ...request, budgetMicros: 60 }, registry())).toMatchObject({ reason: 'FALLBACK', chosen: { estimatedCostMicros: 50 }, budgetMicros: 60 });
    expect(decideAiRoute({ ...request, budgetMicros: 49 }, registry())).toMatchObject({ reason: 'NO_ELIGIBLE_CANDIDATE' });
    expect(decideAiRoute({ ...request, estimatedUnits: Number.MAX_SAFE_INTEGER }, registry())).toMatchObject({ reason: 'NO_ELIGIBLE_CANDIDATE' });
    expect(decideAiRoute({ ...request, estimatedUnits: 0 }, registry())).toMatchObject({ reason: 'INVALID_INPUT' });
  });
  it.each([{ active: false }, { effectiveFrom: '2027-01-01T00:00:00.000Z' }, { effectiveUntil: '2026-06-01T00:00:00.000Z' }])('rejects disabled/future/expired policy %j', (change) => {
    const data = registry(); Object.assign(data.policies[0]!, change);
    expect(decideAiRoute(request, data)).toMatchObject({ reason: 'POLICY_NOT_ACTIVE' });
  });
  it('skips inactive, future and expired catalogs', () => {
    for (const change of [{ active: false }, { effectiveFrom: '2027-01-01T00:00:00.000Z' }, { effectiveUntil: registry().asOf }]) {
      const data = registry(); Object.assign(data.catalog[0]!, change);
      expect(decideAiRoute(request, data)).toMatchObject({ reason: 'FALLBACK' });
    }
  });
  it('rejects cross-tenant or unregistered policy and does not discover another policy', () => {
    expect(decideAiRoute({ ...request, schoolId: secondId }, registry())).toMatchObject({ reason: 'POLICY_NOT_ACTIVE' });
    expect(decideAiRoute({ ...request, policyId: secondId }, registry())).toMatchObject({ reason: 'POLICY_NOT_ACTIVE' });
    const data = registry(); data.policies[0]!.catalogIds = [schoolId];
    expect(decideAiRoute(request, data)).toMatchObject({ reason: 'NO_ELIGIBLE_CANDIDATE' });
  });
  it('does not grant Action Engine authority or accept caller/fallback tool grants', () => {
    const data = registry();
    expect(decideAiRoute({ ...request, authorityMode: 'AUTO' } as AiRouteRequest, data)).toMatchObject({ reason: 'INVALID_INPUT', authority: 'UNCHANGED' });
    Object.assign(data.catalog[1]!, { permissions: ['billing.invoice.issue'], tools: ['arbitrary'] });
    expect(decideAiRoute(request, data)).toMatchObject({ reason: 'INVALID_INPUT' });
  });
  it('rejects an unregistered provider, duplicate registry IDs, or leaked credential reference', () => {
    const data = registry(); data.providers.push(data.providers[0]!);
    expect(decideAiRoute(request, data)).toMatchObject({ reason: 'INVALID_INPUT' });
    const other = registry(); Object.assign(other.providers[0]!, { providerId: 'UNAPPROVED' });
    expect(decideAiRoute(request, other)).toMatchObject({ reason: 'INVALID_INPUT' });
    const leaked = registry(); Object.assign(leaked.providers[0]!, { credentialSecretRef: provider.credentialSecretRef });
    expect(decideAiRoute(request, leaked)).toMatchObject({ reason: 'INVALID_INPUT' });
  });
  it('is deterministic, immutable, redacted, and performs no external side effects', () => {
    const network = vi.fn(() => { throw new Error('Network forbidden'); });
    vi.stubGlobal('fetch', network);
    try {
      const data = registry(); const before = JSON.stringify(data);
      expect(decideAiRoute(request, data)).toEqual(decideAiRoute(request, data));
      expect(JSON.stringify(data)).toBe(before); expect(network).not.toHaveBeenCalled();
      const decision = decideAiRoute({ ...request, policyId: 'sk-rejected-example' }, data);
      expect(JSON.stringify(decision)).not.toContain('sk-rejected');
      expect(JSON.stringify(decideAiRoute(request, data))).not.toMatch(/credential|secret|permission|tools/);
    } finally { vi.unstubAllGlobals(); }
  });
});

const profileId = '77777777-7777-4777-8777-777777777777';
const advancedId = '88888888-8888-4888-8888-888888888888';
const profile: AiTaskProfileWrite = {
  profileId, routingPolicyId: policyId, agentKey: 'marcus', taskCategory: 'MARCUS_MARKETING', costUnit: 'TOKEN', active: true,
  maxCostMicros: 140, defaultCatalogId: firstId, fallbackCatalogIds: [secondId], advancedCatalogId: advancedId,
  requiredCapabilities: ['TEXT', 'TOOL_EXECUTION'], requiredModalities: ['TEXT'], allowedProviderIds: ['OPENROUTER', 'DIRECT_LLM_API'],
  privacyControls: ['NO_TRAINING'], timeoutCategory: 'STANDARD', retryCategory: 'NONE', effectiveFrom: entry.effectiveFrom, effectiveUntil: null, expectedVersion: 0,
};
const taskRequest = { profileId, selection: 'DEFAULT' as const, estimatedUnits: 10 };
function profileRegistry(): AiTaskProfileRegistry {
  const data = registry();
  data.catalog.forEach((c) => { c.privacyControls = ['NO_TRAINING']; });
  data.catalog.push({ ...data.catalog[0]!, catalogId: advancedId, modelId: 'approved/advanced-v1', unitCostMicros: 12, privacyControls: ['NO_TRAINING', 'ZERO_RETENTION'] });
  data.policies[0]!.catalogIds.push(advancedId);
  const { expectedVersion: _, ...config } = profile;
  return { ...data, profile: { ...structuredClone(config), version: 1 } };
}
describe('HQ reviewed task-profile validation and pure selection', () => {
  it('accepts exact closed profile metadata and compatibility-safe catalog privacy attestations', () => {
    expect(validateAiControlPlaneWrite('TASK_PROFILE', profile)).toEqual(profile);
    expect(validateAiControlPlaneWrite('CATALOG', entry)).toEqual(entry);
    const { privacyControls: _, ...missing } = entry;
    expect(validateAiControlPlaneWrite('CATALOG', missing)).toEqual(missing);
    for (const privacyControls of [null, {}, ['NO_TRAINING', 'NO_TRAINING'], ['ENFORCED'], ['https://unapproved.example']]) {
      expect(() => validateAiControlPlaneWrite('CATALOG', { ...entry, privacyControls })).toThrow();
      expect(() => validateAiControlPlaneWrite('TASK_PROFILE', { ...profile, privacyControls })).toThrow();
    }
  });
  it('R1 (0287): accepts HON and Kai routing profiles and the new task categories, nothing else', () => {
    for (const [agentKey, taskCategory] of [['hon', 'HON_STANDARD'], ['hon', 'HON_DETAILED'], ['claire', 'BUSINESS_PERFORMANCE'], ['kai', 'KAI_TEACHING']] as const) {
      expect(validateAiControlPlaneWrite('TASK_PROFILE', { ...profile, agentKey, taskCategory })).toMatchObject({ agentKey, taskCategory });
    }
    for (const agentKey of ['HON', 'kai ', 'chase', 'olivia', 'system']) expect(() => validateAiControlPlaneWrite('TASK_PROFILE', { ...profile, agentKey })).toThrow();
    for (const taskCategory of ['HON_ADVANCED', 'hon_standard', 'TEACHING']) expect(() => validateAiControlPlaneWrite('TASK_PROFILE', { ...profile, taskCategory })).toThrow();
  });
  it.each(['prompt', 'output', 'url', 'endpoint', 'credentialSecretRef', 'apiKey', 'tools', 'permissions', 'authority', 'organizationId', 'schoolId', 'tenantSelector', 'actionRequestId', 'metadata'])('rejects forbidden profile and preview field %s', (key) => {
    expect(() => validateAiControlPlaneWrite('TASK_PROFILE', { ...profile, [key]: 'rejected' })).toThrow();
    expect(() => validateAiTaskProfilePreviewRequest({ ...taskRequest, [key]: 'rejected' })).toThrow();
  });
  it.each(['routingPolicyId', 'providerId', 'modelId', 'budgetMicros', 'requiredModalities', 'agentKey', 'taskCategory', 'tier'])('preview cannot override server-controlled %s', (key) => {
    expect(decideAiTaskProfileRoute({ ...taskRequest, [key]: 'rejected' }, profileRegistry())).toMatchObject({ reason: 'INVALID_INPUT', authority: 'UNCHANGED', execution: 'NOT_PERFORMED' });
  });
  it.each([{ agentKey: 'arbitrary' }, { taskCategory: 'arbitrary' }, { timeoutCategory: 1000 }, { retryCategory: 'FOREVER' }, { allowedProviderIds: [] }, { requiredCapabilities: [] }, { requiredModalities: ['TEXT', 'TEXT'] }, { advancedCatalogId: firstId }, { fallbackCatalogIds: [firstId] }, { fallbackCatalogIds: [secondId, secondId] }, { maxCostMicros: 0.5 }, { expectedVersion: 2147483647 }, { effectiveUntil: entry.effectiveFrom }, { effectiveFrom: '2026-02-31T00:00:00Z' }])('rejects invalid profile %j', (change) => {
    expect(() => validateAiControlPlaneWrite('TASK_PROFILE', { ...profile, ...change })).toThrow();
  });
  it('selects profile default and ordered fallbacks, regardless of policy order', () => {
    const data = profileRegistry(); data.policies[0]!.catalogIds.reverse();
    expect(decideAiTaskProfileRoute(taskRequest, data)).toMatchObject({ status: 'SELECTED', reason: 'PRIMARY', profileId, profileVersion: 1, policyVersion: 1, budgetMicros: 140, chosen: { catalogId: firstId }, fallbackCandidates: [{ catalogId: secondId }] });
    data.providers[0]!.state = 'DISABLED';
    expect(decideAiTaskProfileRoute(taskRequest, data)).toMatchObject({ reason: 'FALLBACK', chosen: { catalogId: secondId } });
    data.profile.defaultCatalogId = secondId; data.profile.fallbackCatalogIds = [firstId]; data.providers[0]!.state = 'HEALTHY';
    expect(decideAiTaskProfileRoute(taskRequest, data)).toMatchObject({ reason: 'PRIMARY', chosen: { catalogId: secondId }, fallbackCandidates: [{ catalogId: firstId }] });
  });
  it('ADVANCED selects only the explicitly approved advanced candidate and never silently defaults', () => {
    const data = profileRegistry();
    const input = { ...taskRequest, selection: 'ADVANCED' as const };
    expect(decideAiTaskProfileRoute(input, data)).toMatchObject({ reason: 'ADVANCED', chosen: { catalogId: advancedId }, fallbackCandidates: [] });
    data.catalog[2]!.active = false;
    expect(decideAiTaskProfileRoute(input, data)).toMatchObject({ reason: 'NO_ELIGIBLE_CANDIDATE', chosen: null });
    data.profile.advancedCatalogId = null;
    expect(decideAiTaskProfileRoute(input, data)).toMatchObject({ reason: 'ADVANCED_NOT_CONFIGURED', chosen: null });
  });
  it.each([{ active: false }, { effectiveFrom: '2027-01-01T00:00:00Z' }, { effectiveUntil: '2026-06-01T00:00:00Z' }])('enforces profile lifecycle %j', (change) => {
    const data = profileRegistry(); Object.assign(data.profile, change);
    expect(decideAiTaskProfileRoute(taskRequest, data)).toMatchObject({ reason: 'PROFILE_NOT_ACTIVE' });
  });
  it('requires exact attached policy approval including advanced and denies inactive policy', () => {
    const data = profileRegistry(); data.policies[0]!.catalogIds.pop();
    expect(decideAiTaskProfileRoute(taskRequest, data)).toMatchObject({ reason: 'POLICY_NOT_ACTIVE' });
    const inactive = profileRegistry(); inactive.policies[0]!.active = false;
    expect(decideAiTaskProfileRoute(taskRequest, inactive)).toMatchObject({ reason: 'POLICY_NOT_ACTIVE' });
    expect(decideAiTaskProfileRoute({ ...taskRequest, profileId: firstId }, profileRegistry())).toMatchObject({ reason: 'PROFILE_NOT_ACTIVE' });
  });
  it('all profile restrictions apply to fallback and advanced without relaxing live routing constraints', () => {
    for (const selection of ['DEFAULT', 'ADVANCED'] as const) {
      for (const filter of [{ allowedProviderIds: ['HEYGEN'] }, { requiredCapabilities: ['TEXT', 'IMAGE'] }, { requiredModalities: ['IMAGE'] }, { privacyControls: ['ZERO_RETENTION'] }, { costUnit: 'IMAGE' }, { maxCostMicros: 49 }]) {
        const data = profileRegistry(); Object.assign(data.profile, filter);
        if (selection === 'ADVANCED' && 'privacyControls' in filter) data.catalog[2]!.privacyControls = [];
        expect(decideAiTaskProfileRoute({ ...taskRequest, selection }, data)).toMatchObject({ reason: 'NO_ELIGIBLE_CANDIDATE', authority: 'UNCHANGED', execution: 'NOT_PERFORMED' });
      }
    }
  });
  it('reuses live entitlement, provider health, effective windows, and both tier/budget constraints', () => {
    const data = profileRegistry(); data.tenant.entitlementActive = false;
    expect(decideAiTaskProfileRoute(taskRequest, data)).toMatchObject({ reason: 'TIER_REQUIRED' });
    data.tenant.entitlementActive = true; data.tenant.tier = 'ESSENTIAL';
    expect(decideAiTaskProfileRoute(taskRequest, data)).toMatchObject({ reason: 'TIER_REQUIRED' });
    data.tenant.tier = 'CORE'; data.profile.maxCostMicros = 60;
    expect(decideAiTaskProfileRoute(taskRequest, data)).toMatchObject({ reason: 'FALLBACK', budgetMicros: 60, chosen: { estimatedCostMicros: 50 } });
    data.profile.maxCostMicros = 1000; data.policies[0]!.maxCostMicros = 60;
    expect(decideAiTaskProfileRoute(taskRequest, data)).toMatchObject({ reason: 'FALLBACK', budgetMicros: 60 });
    expect(decideAiTaskProfileRoute({ ...taskRequest, estimatedUnits: Number.MAX_SAFE_INTEGER }, data)).toMatchObject({ reason: 'NO_ELIGIBLE_CANDIDATE' });
    for (const change of [{ minimumTier: 'COMPLETE' }, { effectiveUntil: data.asOf }, { effectiveFrom: '2027-01-01T00:00:00Z' }]) {
      const copy = profileRegistry(); Object.assign(copy.catalog[2]!, change);
      expect(decideAiTaskProfileRoute({ ...taskRequest, selection: 'ADVANCED' }, copy)).toMatchObject({ reason: 'NO_ELIGIBLE_CANDIDATE' });
    }
    data.providers.forEach((p) => { p.state = 'CONFIGURED'; });
    expect(decideAiTaskProfileRoute(taskRequest, data)).toMatchObject({ reason: 'NO_ELIGIBLE_CANDIDATE' });
  });
  it('rejects corrupted/leaking registry; selection is immutable, deterministic, authority-neutral and has no I/O', () => {
    const data = profileRegistry(); const before = JSON.stringify(data); const network = vi.fn(); vi.stubGlobal('fetch', network);
    try {
      expect(decideAiTaskProfileRoute(taskRequest, data)).toEqual(decideAiTaskProfileRoute(taskRequest, data));
      expect(JSON.stringify(data)).toBe(before); expect(network).not.toHaveBeenCalled();
      Object.assign(data.profile, { prompt: 'rejected' });
      expect(decideAiTaskProfileRoute(taskRequest, data)).toMatchObject({ reason: 'INVALID_INPUT', profileId: '', authority: 'UNCHANGED', execution: 'NOT_PERFORMED' });
    } finally { vi.unstubAllGlobals(); }
  });
});
