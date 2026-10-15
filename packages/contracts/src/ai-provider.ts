import type { HonTier, TenantScope } from './index.js';

/** Code-owned adapter registry; adding a provider requires a reviewed code change. */
export const AI_PROVIDER_IDS = ['OPENROUTER', 'DIRECT_LLM_API', 'HEYGEN', 'HIGGSFIELD'] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];
export const AI_CONNECTION_STATES = ['DISABLED', 'CONFIGURED', 'HEALTHY', 'DEGRADED', 'UNAVAILABLE'] as const;
export type AiConnectionState = (typeof AI_CONNECTION_STATES)[number];
export const AI_CAPABILITIES = ['TEXT', 'VOICE_INPUT', 'VOICE_OUTPUT', 'IMAGE', 'VIDEO', 'EMBEDDING', 'TOOL_EXECUTION'] as const;
export type AiCapability = (typeof AI_CAPABILITIES)[number];
export const AI_MODALITIES = ['TEXT', 'VOICE_INPUT', 'VOICE_OUTPUT', 'IMAGE', 'VIDEO', 'EMBEDDING'] as const;
export type AiModality = (typeof AI_MODALITIES)[number];

export interface AiProviderConnection {
  providerId: AiProviderId;
  displayName: string;
  state: AiConnectionState;
  credentialConfigured: boolean;
  version: number;
}
export interface AiProviderConnectionWrite {
  providerId: AiProviderId;
  displayName: string;
  state: AiConnectionState;
  /** Only hon-secret:<UUID v4>; no dereferencing exists in this foundation. */
  credentialSecretRef: string | null;
  expectedVersion: number;
}
export interface AiCatalogEntry {
  catalogId: string;
  providerId: AiProviderId;
  modelId: string;
  displayName: string;
  capabilities: AiCapability[];
  modalities: AiModality[];
  active: boolean;
  minimumTier: HonTier;
  /** Integer USD micro-units per declared billable unit; not floating dollars. */
  unitCostMicros: number;
  costUnit: 'TOKEN' | 'SECOND' | 'IMAGE' | 'VIDEO' | 'REQUEST';
  effectiveFrom: string;
  effectiveUntil: string | null;
  version: number;
}
export type AiCatalogEntryWrite = Omit<AiCatalogEntry, 'version'> & { expectedVersion: number };
export interface AiRoutingPolicy extends TenantScope {
  policyId: string;
  capability: AiCapability;
  active: boolean;
  minimumTier: HonTier;
  maxCostMicros: number;
  /** Explicit health override; CONFIGURED is never treated as tested health. */
  allowDegraded: boolean;
  catalogIds: string[];
  effectiveFrom: string;
  effectiveUntil: string | null;
  version: number;
}
export type AiRoutingPolicyWrite = Omit<AiRoutingPolicy, 'version'> & { expectedVersion: number };
export type AiControlPlaneKind = 'PROVIDER' | 'CATALOG' | 'POLICY';
export interface AiControlPlaneSnapshot {
  providers: AiProviderConnection[];
  catalog: AiCatalogEntry[];
  policies: AiRoutingPolicy[];
}
export interface AiRouteRequest extends TenantScope {
  policyId: string;
  capability: AiCapability;
  requiredModalities: AiModality[];
  costUnit: AiCatalogEntry['costUnit'];
  estimatedUnits: number;
  budgetMicros: number;
}
/** Trusted live registry snapshot, never caller-supplied tenant entitlement. */
export interface AiRoutingRegistry extends AiControlPlaneSnapshot {
  tenant: TenantScope & { tier: HonTier; entitlementActive: boolean };
  asOf: string;
}
export interface AiRouteCandidate {
  catalogId: string;
  providerId: AiProviderId;
  modelId: string;
  estimatedCostMicros: number;
  costUnit: AiCatalogEntry['costUnit'];
  state: 'HEALTHY' | 'DEGRADED';
}
export type AiRouteDenial = 'INVALID_INPUT' | 'POLICY_NOT_ACTIVE' | 'TIER_REQUIRED' | 'NO_ELIGIBLE_CANDIDATE';
/** Selection is NOT permission, tool access, approval, or Action Engine authority. */
export type AiRouteDecision = {
  contractVersion: 1;
  policyId: string;
  policyVersion: number | null;
  budgetMicros: number;
  authority: 'UNCHANGED';
  execution: 'NOT_PERFORMED';
} & (
  | { status: 'SELECTED'; reason: 'PRIMARY' | 'FALLBACK' | 'DEGRADED_ALLOWED'; chosen: AiRouteCandidate; fallbackCandidates: AiRouteCandidate[] }
  | { status: 'DENIED'; reason: AiRouteDenial; chosen: null; fallbackCandidates: [] }
);
