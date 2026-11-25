// C3 (0691): HON's private storage for real creative provider results. The database authorizes every read and delete
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

// ---------- C4 (0692): human review ----------
export const CREATIVE_REVIEW_DECISIONS = ['APPROVED', 'REJECTED'] as const;
export type CreativeReviewDecision = typeof CREATIVE_REVIEW_DECISIONS[number];
export interface CreativeAssetReviewInput { decision: CreativeReviewDecision }
export interface CreativeAssetReview { assetId: string; review: CreativeReviewDecision; reviewedAt: string; reviewedBySelf: boolean }
export interface CreativeReviewQueueItem {
  assetId: string; generationId: string; ordinal: number; mediaType: CreativeStoredMediaType; width: number; height: number;
  durationSeconds: number | null; storedAt: string; requestedBySelf: boolean;
}
export interface CreativeReviewQueue { limit: number; assets: CreativeReviewQueueItem[] }
export const CREATIVE_REVIEW_QUEUE_LIMIT = 50;

export function validateCreativeAssetReviewInput(value: unknown): CreativeAssetReviewInput {
  const fail = () => { throw new TypeError('INVALID_SAAS_INPUT'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const r = value as Record<string, unknown>;
  if (Object.keys(r).length !== 1 || !(CREATIVE_REVIEW_DECISIONS as readonly unknown[]).includes(r.decision)) fail();
  return { decision: r.decision as CreativeReviewDecision };
}
export function validateCreativeAssetReview(value: unknown): CreativeAssetReview {
  const r = record(value, drift); exactKeys(r, ['assetId', 'review', 'reviewedAt', 'reviewedBySelf'], drift);
  if (!isUuid(r.assetId) || !(CREATIVE_REVIEW_DECISIONS as readonly unknown[]).includes(r.review) || !isTimestamp(r.reviewedAt) || typeof r.reviewedBySelf !== 'boolean') drift();
  return r as unknown as CreativeAssetReview;
}
const isDim = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= 8192;
export function validateCreativeReviewQueue(value: unknown): CreativeReviewQueue {
  const q = record(value, drift); exactKeys(q, ['limit', 'assets'], drift);
  if (!Number.isSafeInteger(q.limit) || (q.limit as number) < 1 || (q.limit as number) > CREATIVE_REVIEW_QUEUE_LIMIT
    || !Array.isArray(q.assets) || q.assets.length > (q.limit as number)) drift();
  let previous = '';
  for (const item of q.assets as unknown[]) {
    const a = record(item, drift);
    exactKeys(a, ['assetId', 'generationId', 'ordinal', 'mediaType', 'width', 'height', 'durationSeconds', 'storedAt', 'requestedBySelf'], drift);
    if (!isUuid(a.assetId) || !isUuid(a.generationId) || !Number.isSafeInteger(a.ordinal) || (a.ordinal as number) < 1 || (a.ordinal as number) > 8
      || !isType(a.mediaType) || !isDim(a.width) || !isDim(a.height) || !isTimestamp(a.storedAt) || typeof a.requestedBySelf !== 'boolean'
      || (a.mediaType === 'video/mp4' ? !(Number.isSafeInteger(a.durationSeconds) && (a.durationSeconds as number) >= 1 && (a.durationSeconds as number) <= 600) : a.durationSeconds !== null)) drift();
    const key = `${a.storedAt as string}|${a.assetId as string}`;
    if (key <= previous) drift(); // oldest first, no repeats
    previous = key;
  }
  return q as unknown as CreativeReviewQueue;
}
