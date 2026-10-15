import { communityClosed, communityText, communityUuid, communityVersion, type CommunityContext } from './community.js';
export type MarketplaceContext = CommunityContext;
export const MARKETPLACE_CATEGORIES = ['OPERATIONS', 'STAFFING', 'CURRICULUM'] as const;
export const MARKETPLACE_MODULES = ['WORK_ITEMS', 'STAFF_PLANNING', 'CURRICULUM'] as const;
export const MARKETPLACE_REQUIRED_PERMISSIONS = {
  WORK_ITEMS: ['work_item.read', 'work_item.manage'],
  STAFF_PLANNING: ['staff.availability.manage'],
  CURRICULUM: ['curriculum.manage'],
} as const;
export type MarketplaceModule = typeof MARKETPLACE_MODULES[number];
export interface MarketplaceInput {
  expectedVersion: number; title: string; category: typeof MARKETPLACE_CATEGORIES[number];
  assetKind: 'TEMPLATE' | 'BLUEPRINT'; targetModule: MarketplaceModule; requiredPermissions: string[];
  releaseNotes: string; previewText: string; status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
}
export interface MarketplaceAsset extends Omit<MarketplaceInput, 'expectedVersion'> { id: string; version: number }
export interface MarketplaceSelection {
  id: string; assetId: string; assetVersion: number; version: 1;
  status: 'REQUIRES_REVIEW'; enabled: false; asset: MarketplaceAsset | null;
}
export interface MarketplaceAccess { canBrowse: boolean; canCreate: boolean; canSave: boolean; executionAllowed: false }
export interface MarketplacePage<T> { items: T[]; nextAfter: string | null; executionAllowed: false }
export interface MarketplaceHistory { id: string; items: Array<{ version: number; status: MarketplaceInput['status'] }>; nextBefore: number | null; executionAllowed: false }
export const MARKETPLACE_HELP = 'Private human marketplace: browse and save for review only. No purchase, installation, import or automation. Assets are descriptive templates and blueprints, not executable. Published releases require manual platform curation of each exact version. Current verified owner permission and explicit community organization/profile opt-in are required to browse or save. Never enter school private data, customer PII, names or contacts, credentials, URLs, attachments, code or scripts. Saving creates only a disabled requires review selection; it changes no configuration or school operations. No AI, provider or Action Engine execution.';
function invalid(): never { throw new Error('Closed descriptive marketplace contract required.'); }
/** Conservative syntax denial; human curation still reviews semantic confidentiality. */
export function marketplaceText(v: unknown, max: number): asserts v is string {
  communityText(v, max);
  if (/[{}\[\]`$=;]|\b(?:password|credential|secret|token|api[_ -]?key|bearer|ssh|select|insert|delete|script|javascript|python|curl|eval|function|import|require|https?)\b/i.test(v as string)) invalid();
}
export function validateMarketplaceInput(v: unknown): asserts v is MarketplaceInput {
  communityClosed(v, ['expectedVersion', 'title', 'category', 'assetKind', 'targetModule', 'requiredPermissions', 'releaseNotes', 'previewText', 'status']);
  communityVersion(v.expectedVersion); if (v.expectedVersion > 999999997) invalid();
  marketplaceText(v.title, 100); marketplaceText(v.releaseNotes, 400); marketplaceText(v.previewText, 1600);
  if (!MARKETPLACE_CATEGORIES.includes(v.category as never) || !['TEMPLATE', 'BLUEPRINT'].includes(v.assetKind as string)
    || !MARKETPLACE_MODULES.includes(v.targetModule as never) || !['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(v.status as string)
    || (v.expectedVersion === 0 && v.status !== 'DRAFT')) invalid();
  const allowed: readonly string[] = MARKETPLACE_REQUIRED_PERMISSIONS[v.targetModule as MarketplaceModule];
  if (!Array.isArray(v.requiredPermissions) || v.requiredPermissions.length < 1 || v.requiredPermissions.length > allowed.length
    || v.requiredPermissions.some((x, i, a) => typeof x !== 'string' || !allowed.includes(x) || (i > 0 && a[i - 1] >= x))) invalid();
}
export function verifyMarketplaceAsset(v: unknown, published = false): MarketplaceAsset {
  communityClosed(v, ['id', 'version', 'title', 'category', 'assetKind', 'targetModule', 'requiredPermissions', 'releaseNotes', 'previewText', 'status']);
  communityUuid(v.id); communityVersion(v.version, 1);
  validateMarketplaceInput({ expectedVersion: 1, title: v.title, category: v.category, assetKind: v.assetKind, targetModule: v.targetModule,
    requiredPermissions: v.requiredPermissions, releaseNotes: v.releaseNotes, previewText: v.previewText, status: v.status });
  if (published && v.status !== 'PUBLISHED') invalid(); return v as unknown as MarketplaceAsset;
}
export function verifyMarketplaceSelection(v: unknown): MarketplaceSelection {
  communityClosed(v, ['id', 'assetId', 'assetVersion', 'version', 'status', 'enabled', 'asset']);
  communityUuid(v.id); communityUuid(v.assetId); communityVersion(v.assetVersion, 1);
  if (v.version !== 1 || v.status !== 'REQUIRES_REVIEW' || v.enabled !== false) invalid();
  if (v.asset !== null) { const a = verifyMarketplaceAsset(v.asset, true); if (a.id !== v.assetId || a.version !== v.assetVersion) invalid(); }
  return v as unknown as MarketplaceSelection;
}
export function verifyMarketplaceAccess(v: unknown): MarketplaceAccess {
  communityClosed(v, ['canBrowse', 'canCreate', 'canSave', 'executionAllowed']);
  if (['canBrowse', 'canCreate', 'canSave'].some(k => typeof v[k] !== 'boolean') || v.executionAllowed !== false || (v.canSave && !v.canBrowse)) invalid();
  return v as unknown as MarketplaceAccess;
}
export function verifyMarketplacePage<T extends { id: string }>(v: unknown, item: (v: unknown) => T): MarketplacePage<T> {
  communityClosed(v, ['items', 'nextAfter', 'executionAllowed']);
  if (!Array.isArray(v.items) || v.items.length > 30 || v.executionAllowed !== false) invalid();
  let prior = ''; for (const x of v.items) { const r = item(x); if (r.id <= prior) invalid(); prior = r.id; }
  if (v.nextAfter !== null) { communityUuid(v.nextAfter); if (v.items.length !== 30 || v.nextAfter !== prior) invalid(); }
  return v as unknown as MarketplacePage<T>;
}
export function verifyMarketplaceHistory(v: unknown): MarketplaceHistory {
  communityClosed(v, ['id', 'items', 'nextBefore', 'executionAllowed']); communityUuid(v.id);
  if (!Array.isArray(v.items) || v.items.length > 30 || v.executionAllowed !== false) invalid();
  let prior = 999999999; for (const x of v.items) { communityClosed(x, ['version', 'status']); communityVersion(x.version, 1);
    if (x.version >= prior || !['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(x.status as string)) invalid(); prior = x.version; }
  if (v.nextBefore !== null) { communityVersion(v.nextBefore, 1); if (v.items.length !== 30 || v.nextBefore !== prior) invalid(); }
  return v as unknown as MarketplaceHistory;
}
export function validateMarketplaceSelection(v: unknown): asserts v is { assetVersion: number; expectedVersion: 0 } {
  communityClosed(v, ['assetVersion', 'expectedVersion']); communityVersion(v.assetVersion, 1); if (v.expectedVersion !== 0) invalid();
}
