import { describe, expect, it, vi } from 'vitest';
import type { AiCatalogEntryWrite, AiProviderConnectionWrite, AiRouteRequest, AiRoutingRegistry } from '@hon/contracts';
import { decideAiRoute, validateAiControlPlaneWrite } from '../src/index.js';

const organizationId = '11111111-1111-4111-8111-111111111111';
const schoolId = '22222222-2222-4222-8222-222222222222';
const policyId = '33333333-3333-4333-8333-333333333333';
const firstId = '44444444-4444-4444-8444-444444444444';
const secondId = '55555555-5555-4555-8555-555555555555';
const provider: AiProviderConnectionWrite = { providerId: 'OPENROUTER', displayName: 'HQ Text', state: 'CONFIGURED', credentialSecretRef: 'hon-secret:66666666-6666-4666-8666-666666666666', expectedVersion: 0 };
const entry: AiCatalogEntryWrite = { catalogId: firstId, providerId: 'OPENROUTER', modelId: 'approved/text-v1', displayName: 'Approved Text', capabilities: ['TEXT', 'TOOL_EXECUTION'], modalities: ['TEXT'], active: true, minimumTier: 'CORE', unitCostMicros: 10, costUnit: 'TOKEN', effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveUntil: null, expectedVersion: 0 };
const request: AiRouteRequest = { organizationId, schoolId, policyId, capability: 'TEXT', requiredModalities: ['TEXT'], costUnit: 'TOKEN', estimatedUnits: 10, budgetMicros: 200 };
function registry(): AiRoutingRegistry {
  const { expectedVersion: _, ...catalog } = entry;
  return {
    tenant: { organizationId, schoolId, tier: 'CORE', entitlementActive: true }, asOf: '2026-06-01T00:00:00.000Z',
    providers: [{ providerId: 'OPENROUTER', displayName: 'HQ Text', state: 'HEALTHY', credentialConfigured: true, version: 1 }, { providerId: 'DIRECT_LLM_API', displayName: 'HQ Fallback', state: 'HEALTHY', credentialConfigured: true, version: 1 }],
    catalog: [{ ...catalog, version: 1 }, { ...catalog, catalogId: secondId, providerId: 'DIRECT_LLM_API', modelId: 'approved/fallback-v1', unitCostMicros: 5, version: 1 }],
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
