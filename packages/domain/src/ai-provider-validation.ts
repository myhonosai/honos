import {
  AI_CAPABILITIES, AI_CONNECTION_STATES, AI_MODALITIES, AI_PROVIDER_IDS, HON_TIERS,
  AI_PRIVACY_CONTROLS, AI_TASK_TIMEOUT_CATEGORIES, AI_TASK_RETRY_CATEGORIES, AI_TASK_PROFILE_AGENT_KEYS, AI_MODEL_EVALUATION_TASK_CATEGORIES,
  type AiCatalogEntryWrite, type AiControlPlaneKind, type AiProviderConnectionWrite, type AiRoutingPolicyWrite, type AiTaskProfileWrite,
} from '@hon/contracts';

export const AI_COST_UNITS = ['TOKEN', 'SECOND', 'IMAGE', 'VIDEO', 'REQUEST'] as const;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_REF = /^hon-secret:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Defense in depth, not a general DLP promise. Narrow field grammars and the
// UUID-only reference prevent raw credentials from being accepted as config.
const SECRET_LIKE = /(?:sk[-_]|pk[-_]|gh[pousr]_|xox[baprs]-|AKIA|AIza|eyJ|bearer|api[ _-]?key|access[ _-]?token|password|passwd|jwt|private[ _-]?key|-----BEGIN|https?:|[A-Za-z0-9_+\/-]{32,})/i;

export function aiConfigObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('VALIDATION_FAILED');
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.hasOwn(object, key))) throw new Error('VALIDATION_FAILED');
  return object;
}
export function aiConfigInteger(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error('VALIDATION_FAILED');
  return value;
}
export function aiConfigEnum<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error('VALIDATION_FAILED');
  return value as T;
}
export function aiConfigUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new Error('VALIDATION_FAILED');
  return value.toLowerCase();
}
function safeText(value: unknown, model = false): string {
  const grammar = model ? /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/ : /^[a-zA-Z0-9][a-zA-Z0-9 .,'()-]{0,79}$/;
  if (typeof value !== 'string' || !grammar.test(value) || SECRET_LIKE.test(value)) throw new Error('VALIDATION_FAILED');
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('VALIDATION_FAILED');
  return value;
}
function list<T extends string>(value: unknown, allowed: readonly T[], minimum = 1): T[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > allowed.length) throw new Error('VALIDATION_FAILED');
  const result = value.map((item) => aiConfigEnum(item, allowed));
  if (new Set(result).size !== result.length) throw new Error('VALIDATION_FAILED');
  return result;
}
function window(object: Record<string, unknown>): { effectiveFrom: string; effectiveUntil: string | null } {
  function timestamp(value: unknown): string {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('VALIDATION_FAILED');
    const parsed = new Date(value).toISOString();
    if (parsed.slice(0, 19) !== value.slice(0, 19)) throw new Error('VALIDATION_FAILED');
    return parsed;
  }
  const effectiveFrom = timestamp(object.effectiveFrom);
  const effectiveUntil = object.effectiveUntil === null ? null : timestamp(object.effectiveUntil);
  if (effectiveUntil !== null && effectiveUntil <= effectiveFrom) throw new Error('VALIDATION_FAILED');
  return { effectiveFrom, effectiveUntil };
}
export function validateAiControlPlaneWrite(kind: AiControlPlaneKind, input: unknown): AiProviderConnectionWrite | AiCatalogEntryWrite | AiRoutingPolicyWrite | AiTaskProfileWrite {
  if (kind === 'TASK_PROFILE') return validateAiTaskProfileWrite(input);
  if (kind === 'PROVIDER') {
    const object = aiConfigObject(input, ['providerId', 'displayName', 'state', 'credentialSecretRef', 'expectedVersion']);
    const ref = object.credentialSecretRef;
    if (ref !== null && (typeof ref !== 'string' || !SECRET_REF.test(ref))) throw new Error('VALIDATION_FAILED');
    const state = aiConfigEnum(object.state, AI_CONNECTION_STATES);
    if (state !== 'DISABLED' && ref === null) throw new Error('VALIDATION_FAILED');
    return { providerId: aiConfigEnum(object.providerId, AI_PROVIDER_IDS), displayName: safeText(object.displayName), state, credentialSecretRef: ref as string | null, expectedVersion: aiConfigVersion(object.expectedVersion) };
  }
  if (kind === 'CATALOG') {
    const legacyKeys = ['catalogId', 'providerId', 'modelId', 'displayName', 'capabilities', 'modalities', 'active', 'minimumTier', 'unitCostMicros', 'costUnit', 'effectiveFrom', 'effectiveUntil', 'expectedVersion'];
    const object = input && typeof input === 'object' && !Array.isArray(input) && Object.hasOwn(input, 'privacyControls')
      ? aiConfigObject(input, [...legacyKeys.slice(0, 6), 'privacyControls', ...legacyKeys.slice(6)])
      : aiConfigObject(input, legacyKeys);
    const privacyControls = Object.hasOwn(object, 'privacyControls')
      ? list(object.privacyControls, AI_PRIVACY_CONTROLS, 0)
      : undefined;
    return {
      catalogId: aiConfigUuid(object.catalogId), providerId: aiConfigEnum(object.providerId, AI_PROVIDER_IDS),
      modelId: safeText(object.modelId, true), displayName: safeText(object.displayName),
      capabilities: list(object.capabilities, AI_CAPABILITIES), modalities: list(object.modalities, AI_MODALITIES),
      ...(privacyControls === undefined ? {} : { privacyControls }),
      active: boolean(object.active), minimumTier: aiConfigEnum(object.minimumTier, HON_TIERS),
      unitCostMicros: aiConfigInteger(object.unitCostMicros), costUnit: aiConfigEnum(object.costUnit, AI_COST_UNITS),
      ...window(object), expectedVersion: aiConfigVersion(object.expectedVersion),
    };
  }
  if (kind !== 'POLICY') throw new Error('VALIDATION_FAILED');
  const object = aiConfigObject(input, ['policyId', 'organizationId', 'schoolId', 'capability', 'active', 'minimumTier', 'maxCostMicros', 'allowDegraded', 'catalogIds', 'effectiveFrom', 'effectiveUntil', 'expectedVersion']);
  if (!Array.isArray(object.catalogIds) || object.catalogIds.length < 1 || object.catalogIds.length > 8) throw new Error('VALIDATION_FAILED');
  const catalogIds = object.catalogIds.map(aiConfigUuid);
  if (new Set(catalogIds).size !== catalogIds.length) throw new Error('VALIDATION_FAILED');
  return {
    policyId: aiConfigUuid(object.policyId), organizationId: aiConfigUuid(object.organizationId), schoolId: aiConfigUuid(object.schoolId),
    capability: aiConfigEnum(object.capability, AI_CAPABILITIES), active: boolean(object.active),
    minimumTier: aiConfigEnum(object.minimumTier, HON_TIERS), maxCostMicros: aiConfigInteger(object.maxCostMicros),
    allowDegraded: boolean(object.allowDegraded), catalogIds, ...window(object), expectedVersion: aiConfigVersion(object.expectedVersion),
  };
}

function aiConfigVersion(value: unknown): number {
  const version = aiConfigInteger(value);
  if (version > 2147483646) throw new Error('VALIDATION_FAILED');
  return version;
}
export function validateAiTaskProfileWrite(input: unknown): AiTaskProfileWrite {
  const object = aiConfigObject(input, ['profileId', 'routingPolicyId', 'agentKey', 'taskCategory', 'costUnit', 'active', 'maxCostMicros', 'defaultCatalogId', 'fallbackCatalogIds', 'advancedCatalogId', 'requiredCapabilities', 'requiredModalities', 'allowedProviderIds', 'privacyControls', 'timeoutCategory', 'retryCategory', 'effectiveFrom', 'effectiveUntil', 'expectedVersion']);
  if (!Array.isArray(object.fallbackCatalogIds) || object.fallbackCatalogIds.length > 7) throw new Error('VALIDATION_FAILED');
  const defaultCatalogId = aiConfigUuid(object.defaultCatalogId);
  const fallbackCatalogIds = object.fallbackCatalogIds.map(aiConfigUuid);
  const advancedCatalogId = object.advancedCatalogId === null ? null : aiConfigUuid(object.advancedCatalogId);
  const ids = [defaultCatalogId, ...fallbackCatalogIds, ...(advancedCatalogId === null ? [] : [advancedCatalogId])];
  if (new Set(ids).size !== ids.length || ids.length > 8) throw new Error('VALIDATION_FAILED');
  return {
    profileId: aiConfigUuid(object.profileId), routingPolicyId: aiConfigUuid(object.routingPolicyId),
    agentKey: aiConfigEnum(object.agentKey, AI_TASK_PROFILE_AGENT_KEYS), taskCategory: aiConfigEnum(object.taskCategory, AI_MODEL_EVALUATION_TASK_CATEGORIES),
    costUnit: aiConfigEnum(object.costUnit, AI_COST_UNITS), active: boolean(object.active), maxCostMicros: aiConfigInteger(object.maxCostMicros),
    defaultCatalogId, fallbackCatalogIds, advancedCatalogId,
    requiredCapabilities: list(object.requiredCapabilities, AI_CAPABILITIES), requiredModalities: list(object.requiredModalities, AI_MODALITIES),
    allowedProviderIds: list(object.allowedProviderIds, AI_PROVIDER_IDS), privacyControls: list(object.privacyControls, AI_PRIVACY_CONTROLS, 0),
    timeoutCategory: aiConfigEnum(object.timeoutCategory, AI_TASK_TIMEOUT_CATEGORIES), retryCategory: aiConfigEnum(object.retryCategory, AI_TASK_RETRY_CATEGORIES),
    ...window(object), expectedVersion: aiConfigVersion(object.expectedVersion),
  };
}
