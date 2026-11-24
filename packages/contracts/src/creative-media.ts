// C3 (0671): HON's private storage for real creative provider results. The database authorizes every read and delete
// from the asset's own row (exact school, the 0216 creative actor) and fixes each object key; the API turns a read grant
// into a short-lived signed URL. A storage key is never shown to a browser.
import { championsDrift as drift, championsExactKeys as exactKeys, championsIsTimestamp as isTimestamp,
  championsIsUuid as isUuid, championsRecord as record } from './champions-club.js';

export const CREATIVE_STORAGE_KEY = /^creative\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[1-8]$/;
export const CREATIVE_STORED_MEDIA_TYPES = ['image/png', 'image/webp', 'video/mp4'] as const;
export type CreativeStoredMediaType = typeof CREATIVE_STORED_MEDIA_TYPES[number];
/** Database answers (runtime only, never sent to a browser). */
export interface CreativeAssetReadGrant { assetId: string; storageKey: string; mediaType: CreativeStoredMediaType; byteSize: number }
export interface CreativeAssetDeletionRecord { assetId: string; storageKey: string | null; deletedAt: string; removed: boolean }
/** API answers. */
export interface CreativeAssetView { assetId: string; mediaType: CreativeStoredMediaType; url: string; expiresAt: string }
export interface CreativeAssetDeletion { assetId: string; deletedAt: string; fileRemoved: boolean }

const isType = (v: unknown): v is CreativeStoredMediaType => (CREATIVE_STORED_MEDIA_TYPES as readonly unknown[]).includes(v);

export function validateCreativeAssetReadGrant(value: unknown): CreativeAssetReadGrant {
  const r = record(value, drift); exactKeys(r, ['assetId', 'storageKey', 'mediaType', 'byteSize'], drift);
  if (!isUuid(r.assetId) || typeof r.storageKey !== 'string' || !CREATIVE_STORAGE_KEY.test(r.storageKey) || !isType(r.mediaType)
    || !Number.isSafeInteger(r.byteSize) || (r.byteSize as number) < 1 || (r.byteSize as number) > 209_715_200) drift();
  return r as unknown as CreativeAssetReadGrant;
}
export function validateCreativeAssetDeletionRecord(value: unknown): CreativeAssetDeletionRecord {
  const r = record(value, drift); exactKeys(r, ['assetId', 'storageKey', 'deletedAt', 'removed'], drift);
  if (!isUuid(r.assetId) || typeof r.removed !== 'boolean' || !isTimestamp(r.deletedAt)
    || (r.removed ? r.storageKey !== null : typeof r.storageKey !== 'string' || !CREATIVE_STORAGE_KEY.test(r.storageKey))) drift();
  return r as unknown as CreativeAssetDeletionRecord;
}
export function validateCreativeAssetView(value: unknown): CreativeAssetView {
  const r = record(value, drift); exactKeys(r, ['assetId', 'mediaType', 'url', 'expiresAt'], drift);
  if (!isUuid(r.assetId) || !isType(r.mediaType) || typeof r.url !== 'string' || r.url.length > 4096 || !r.url.startsWith('https://') || !isTimestamp(r.expiresAt)) drift();
  return r as unknown as CreativeAssetView;
}
export function validateCreativeAssetDeletion(value: unknown): CreativeAssetDeletion {
  const r = record(value, drift); exactKeys(r, ['assetId', 'deletedAt', 'fileRemoved'], drift);
  if (!isUuid(r.assetId) || !isTimestamp(r.deletedAt) || typeof r.fileRemoved !== 'boolean') drift();
  return r as unknown as CreativeAssetDeletion;
}
