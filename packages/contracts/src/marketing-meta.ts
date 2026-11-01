/** META-1 selection metadata only. No credential, provider grant or connection receipt. */
export const META_ASSET_KINDS = Object.freeze([
  'FACEBOOK_PAGE', 'INSTAGRAM_PROFESSIONAL_ACCOUNT', 'AD_ACCOUNT', 'LEAD_FORM',
] as const);
export type MetaAssetKind = typeof META_ASSET_KINDS[number];

export const META_CAPABILITIES = Object.freeze([
  'ADS_REPORTING', 'LEAD_RETRIEVAL', 'PUBLISHING', 'COMMENTS', 'MESSAGING',
  'ADS_MANAGEMENT', 'SOCIAL_INSIGHTS',
] as const);
export type MetaCapability = typeof META_CAPABILITIES[number];
export const META_LOGIN_ROUTES = Object.freeze(['FACEBOOK_BUSINESS_LOGIN', 'INSTAGRAM_LOGIN'] as const);
export type MetaLoginRoute = typeof META_LOGIN_ROUTES[number];
export const META_COMMUNICATION_MODES = Object.freeze(['MANUAL', 'AI_ASSISTED', 'AI_AUTOMATED'] as const);
export type MetaCommunicationMode = typeof META_COMMUNICATION_MODES[number];

/** Compatibility is NOT provider eligibility, HON permission, entitlement or consent. */
export const META_ASSET_CAPABILITIES: Readonly<Record<MetaAssetKind, readonly MetaCapability[]>> = Object.freeze({
  FACEBOOK_PAGE: Object.freeze<MetaCapability[]>(['PUBLISHING', 'COMMENTS', 'MESSAGING', 'SOCIAL_INSIGHTS']),
  INSTAGRAM_PROFESSIONAL_ACCOUNT: Object.freeze<MetaCapability[]>(['PUBLISHING', 'COMMENTS', 'MESSAGING', 'SOCIAL_INSIGHTS']),
  AD_ACCOUNT: Object.freeze<MetaCapability[]>(['ADS_REPORTING', 'ADS_MANAGEMENT']),
  LEAD_FORM: Object.freeze<MetaCapability[]>(['LEAD_RETRIEVAL']),
});

export interface MetaAssetIntent {
  readonly assetKind: MetaAssetKind;
  /** Opaque untrusted selector; discovered identity and ownership must be verified server-side. */
  readonly providerAssetId: string;
  readonly requestedCapabilities: readonly MetaCapability[];
}
export interface MetaConnectionIntent {
  readonly schemaVersion: 1;
  /** Untrusted selector, never the source of tenant authority. */
  readonly schoolId: string;
  readonly loginRoute: MetaLoginRoute;
  readonly assets: readonly MetaAssetIntent[];
}
export interface MetaUnavailableHealth {
  readonly provider: 'META';
  readonly configuration: 'UNCONFIGURED';
  readonly connection: 'NOT_CONNECTED';
  readonly externalExecutionAvailable: false;
  readonly automatedActionsAvailable: false;
  readonly capabilities: readonly {
    readonly capability: MetaCapability;
    readonly state: 'UNAVAILABLE';
    readonly reason: 'META_RUNTIME_NOT_IMPLEMENTED';
  }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function invalid(): never { throw new Error('INVALID_META_CONNECTION_INTENT'); }
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) return invalid();
  // JSON-like data only; accessors must not execute while normalizing an intent.
  if (keys.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) return invalid();
  return value as Record<string, unknown>;
}
export function validateMetaSchoolSelector(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) return invalid();
  return value.toLowerCase();
}

/** Closed DTO for an in-memory intent. No endpoint accepts this DTO in this slice. */
export function validateMetaConnectionIntent(value: unknown): MetaConnectionIntent {
  const root = closed(value, ['schemaVersion', 'schoolId', 'loginRoute', 'assets']);
  if (root.schemaVersion !== 1 || !META_LOGIN_ROUTES.includes(root.loginRoute as MetaLoginRoute)
    || !Array.isArray(root.assets) || root.assets.length < 1 || root.assets.length > 20) return invalid();
  const schoolId = validateMetaSchoolSelector(root.schoolId);
  const seen = new Set<string>();
  const assets: MetaAssetIntent[] = [];
  // for-of visits sparse entries too: array holes must not evade validation.
  for (const raw of root.assets) {
    const item = closed(raw, ['assetKind', 'providerAssetId', 'requestedCapabilities']);
    if (!META_ASSET_KINDS.includes(item.assetKind as MetaAssetKind)
      || typeof item.providerAssetId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(item.providerAssetId)
      || !Array.isArray(item.requestedCapabilities) || item.requestedCapabilities.length < 1
      || item.requestedCapabilities.length > META_CAPABILITIES.length) return invalid();
    const assetKind = item.assetKind as MetaAssetKind;
    if (root.loginRoute === 'INSTAGRAM_LOGIN' && assetKind !== 'INSTAGRAM_PROFESSIONAL_ACCOUNT') return invalid();
    const key = `${assetKind}:${item.providerAssetId}`;
    if (seen.has(key)) return invalid();
    seen.add(key);
    const capabilities: MetaCapability[] = [];
    for (const capability of item.requestedCapabilities) {
      if (!META_CAPABILITIES.includes(capability as MetaCapability)
        || !META_ASSET_CAPABILITIES[assetKind].includes(capability as MetaCapability)
        || capabilities.includes(capability as MetaCapability)) return invalid();
      capabilities.push(capability as MetaCapability);
    }
    // Canonical capability order avoids treating checkbox order as a different intent.
    capabilities.sort((a, b) => META_CAPABILITIES.indexOf(a) - META_CAPABILITIES.indexOf(b));
    assets.push(Object.freeze({ assetKind, providerAssetId: item.providerAssetId,
      requestedCapabilities: Object.freeze(capabilities) }));
  }
  assets.sort((a, b) => a.assetKind < b.assetKind ? -1 : a.assetKind > b.assetKind ? 1
    : a.providerAssetId < b.providerAssetId ? -1 : a.providerAssetId > b.providerAssetId ? 1 : 0);
  return Object.freeze({ schemaVersion: 1, schoolId, loginRoute: root.loginRoute as MetaLoginRoute,
    assets: Object.freeze(assets) });
}

/** Only the unavailable foundation shape is valid. A future connected shape needs separate reviewed contracts. */
export function validateMetaUnavailableHealth(value: unknown): MetaUnavailableHealth {
  const root = closed(value, ['provider', 'configuration', 'connection', 'externalExecutionAvailable',
    'automatedActionsAvailable', 'capabilities']);
  if (root.provider !== 'META' || root.configuration !== 'UNCONFIGURED' || root.connection !== 'NOT_CONNECTED'
    || root.externalExecutionAvailable !== false || root.automatedActionsAvailable !== false
    || !Array.isArray(root.capabilities) || root.capabilities.length !== META_CAPABILITIES.length) return invalid();
  const capabilities: MetaUnavailableHealth['capabilities'][number][] = [];
  for (const [index, raw] of root.capabilities.entries()) {
    const item = closed(raw, ['capability', 'state', 'reason']);
    if (item.capability !== META_CAPABILITIES[index] || item.state !== 'UNAVAILABLE'
      || item.reason !== 'META_RUNTIME_NOT_IMPLEMENTED') return invalid();
    capabilities.push(Object.freeze({ capability: item.capability as MetaCapability,
      state: 'UNAVAILABLE', reason: 'META_RUNTIME_NOT_IMPLEMENTED' }));
  }
  return Object.freeze({ provider: 'META', configuration: 'UNCONFIGURED', connection: 'NOT_CONNECTED',
    externalExecutionAvailable: false, automatedActionsAvailable: false, capabilities: Object.freeze(capabilities) });
}
