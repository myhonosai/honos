import type { HonTier, TenantScope } from './index.js';
import { HON_AI_TEAM_AGENT_KEYS } from './ai-team.js';

/** Code-owned adapter registry; adding a provider requires a reviewed code change. */
export const AI_PROVIDER_IDS = Object.freeze(['OPENROUTER', 'DIRECT_LLM_API', 'HEYGEN', 'HIGGSFIELD'] as const);
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
  /** HQ attestation metadata only; never proof of external enforcement. */
  privacyControls: AiPrivacyControl[];
  active: boolean;
  minimumTier: HonTier;
  /** Integer USD micro-units per declared billable unit; not floating dollars. */
  unitCostMicros: number;
  costUnit: 'TOKEN' | 'SECOND' | 'IMAGE' | 'VIDEO' | 'REQUEST';
  effectiveFrom: string;
  effectiveUntil: string | null;
  version: number;
}
/**
 * `privacyControls` was added after the first catalog contract. Omission keeps
 * the current persisted attestation on update (or the safe empty default on
 * create); an explicit list replaces it. Read snapshots always include it.
 */
export type AiCatalogEntryWrite = Omit<AiCatalogEntry, 'version' | 'privacyControls'> & {
  privacyControls?: AiPrivacyControl[];
  expectedVersion: number;
};
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
export type AiControlPlaneKind = 'PROVIDER' | 'CATALOG' | 'POLICY' | 'TASK_PROFILE';
export interface AiControlPlaneSnapshot {
  providers: AiProviderConnection[];
  catalog: AiCatalogEntry[];
  policies: AiRoutingPolicy[];
  taskProfiles: AiTaskProfile[];
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
export interface AiRoutingRegistry extends Omit<AiControlPlaneSnapshot, 'taskProfiles'> {
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

/** Closed selection metadata. No prompts, secrets, URLs, tools, scope or authority. */
export const AI_PRIVACY_CONTROLS = ['NO_TRAINING', 'ZERO_RETENTION'] as const;
export type AiPrivacyControl = (typeof AI_PRIVACY_CONTROLS)[number];
export const AI_TASK_TIMEOUT_CATEGORIES = ['QUICK', 'STANDARD', 'EXTENDED'] as const;
export const AI_TASK_RETRY_CATEGORIES = ['NONE', 'TRANSIENT_ONCE'] as const;
/** Task profiles may also route HON itself and Kai (R1, 0242); these keys select metadata only, never authority. */
export const AI_TASK_PROFILE_AGENT_KEYS = [...HON_AI_TEAM_AGENT_KEYS, 'hon', 'kai'] as const;
export type AiTaskProfileAgentKey = (typeof AI_TASK_PROFILE_AGENT_KEYS)[number];
export interface AiTaskProfile {
  profileId: string;
  routingPolicyId: string;
  agentKey: AiTaskProfileAgentKey;
  taskCategory: import('./ai-model-evaluation.js').AiModelEvaluationTaskCategory;
  costUnit: AiCatalogEntry['costUnit'];
  active: boolean;
  maxCostMicros: number;
  defaultCatalogId: string;
  fallbackCatalogIds: string[];
  advancedCatalogId: string | null;
  requiredCapabilities: AiCapability[];
  requiredModalities: AiModality[];
  allowedProviderIds: AiProviderId[];
  privacyControls: AiPrivacyControl[];
  timeoutCategory: (typeof AI_TASK_TIMEOUT_CATEGORIES)[number];
  retryCategory: (typeof AI_TASK_RETRY_CATEGORIES)[number];
  effectiveFrom: string;
  effectiveUntil: string | null;
  version: number;
}
export type AiTaskProfileWrite = Omit<AiTaskProfile, 'version'> & { expectedVersion: number };
export interface AiTaskProfilePreviewRequest {
  profileId: string;
  selection: 'DEFAULT' | 'ADVANCED';
  estimatedUnits: number;
}
export interface AiTaskProfileRegistry extends AiRoutingRegistry { profile: AiTaskProfile }
export type AiTaskProfileDenial = AiRouteDenial | 'PROFILE_NOT_ACTIVE' | 'ADVANCED_NOT_CONFIGURED';
export type AiTaskProfileDecision = {
  contractVersion: 1;
  profileId: string;
  profileVersion: number | null;
  selection: 'DEFAULT' | 'ADVANCED' | null;
  policyId: string;
  policyVersion: number | null;
  budgetMicros: number;
  authority: 'UNCHANGED';
  execution: 'NOT_PERFORMED';
} & (
  | { status: 'SELECTED'; reason: 'PRIMARY' | 'FALLBACK' | 'DEGRADED_ALLOWED' | 'ADVANCED'; chosen: AiRouteCandidate; fallbackCandidates: AiRouteCandidate[] }
  | { status: 'DENIED'; reason: AiTaskProfileDenial; chosen: null; fallbackCandidates: [] }
);
