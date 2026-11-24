/**
 * School media library BL3a (migration 0628). Owner decisions (David): 2026-11-18 "Email pictures, video as a link";
 * 2026-11-22 "Allow media storage". Staff upload JPEG, PNG or GIF pictures (up to 25 MiB) through the HON API, which strips
 * location and camera metadata before storing them in one private bucket. Each READY picture has a stable public link
 * /m/<linkToken> that redirects to a short-lived signed file link. Spec: docs/architecture/SCHOOL_MEDIA_LIBRARY.md.
 */

export const SCHOOL_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif'] as const;
export type SchoolMediaType = typeof SCHOOL_MEDIA_TYPES[number];
export const SCHOOL_MEDIA_STATES = ['PENDING', 'READY'] as const;
export type SchoolMediaState = typeof SCHOOL_MEDIA_STATES[number];
export const SCHOOL_MEDIA_LIMITS = {
  title: 100, maxBytes: 26_214_400, maxSide: 20_000, list: 500,
  storedBytes: 5_368_709_120, monthBytes: 10_737_418_240,
} as const;
export const SCHOOL_MEDIA_COMMANDS = { upload: 'marketing_media.upload', rename: 'marketing_media.rename', delete: 'marketing_media.delete' } as const;
export const SCHOOL_MEDIA_READ_COMMAND = 'marketing_media.read';
/** The percent-encoded UTF-8 title travels in this header beside the raw picture bytes. */
export const SCHOOL_MEDIA_TITLE_HEADER = 'x-hon-media-title';
export const SCHOOL_MEDIA_LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface SchoolMediaAsset {
  assetId: string; kind: 'IMAGE'; mediaType: SchoolMediaType; title: string; byteSize: number; width: number; height: number;
  state: SchoolMediaState; version: number;
  /** Present only while READY: the picture opens at /m/<linkToken>. */
  linkToken: string | null;
  createdAt: string; readyAt: string | null; updatedAt: string;
}
export interface SchoolMediaUsage { storedBytes: number; storedLimitBytes: number; monthBytes: number; monthLimitBytes: number }
export interface SchoolMediaLibrary { assets: SchoolMediaAsset[]; usage: SchoolMediaUsage }
export interface RenameSchoolMediaInput { assetId: string; expectedVersion: number; title: string }
export interface DeleteSchoolMediaInput { assetId: string; expectedVersion: number }
export interface SchoolMediaReceipt { asset: SchoolMediaAsset; replayed: boolean }
export interface SchoolMediaDeleteReceipt { assetId: string; removed: boolean; replayed: boolean }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function invalid(): never { throw new Error('Invalid school media data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
const uuid = (v: unknown): string => { if (typeof v !== 'string' || !UUID.test(v)) invalid(); return v.toLowerCase(); };
const instant = (v: unknown): string => { if (typeof v !== 'string' || !INSTANT.test(v) || Number.isNaN(Date.parse(v))) invalid(); return v; };
const count = (v: unknown, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) invalid();
  return v;
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T => { if (!(allowed as readonly unknown[]).includes(v)) invalid(); return v as T; };

/** One trimmed line of 1-100 characters with no control characters (mirrors hon.school_media_title_ok). */
export function schoolMediaTitleOk(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= SCHOOL_MEDIA_LIMITS.title && !/^\s|\s$/.test(v) && !CONTROL.test(v);
}
/** A title from a file name: the name without its extension, tidied to one line, or "Picture". */
export function schoolMediaTitleFromFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SCHOOL_MEDIA_LIMITS.title).trim();
  return base || 'Picture';
}

export function verifySchoolMediaAsset(value: unknown): SchoolMediaAsset {
  const row = record(value, ['assetId', 'kind', 'mediaType', 'title', 'byteSize', 'width', 'height', 'state', 'version', 'linkToken', 'createdAt', 'readyAt', 'updatedAt']);
  const state = oneOf(row.state, SCHOOL_MEDIA_STATES);
  if (row.kind !== 'IMAGE' || !schoolMediaTitleOk(row.title)) invalid();
  const linkToken = row.linkToken === null ? null : (typeof row.linkToken === 'string' && SCHOOL_MEDIA_LINK_TOKEN.test(row.linkToken) ? row.linkToken : invalid());
  const readyAt = row.readyAt === null ? null : instant(row.readyAt);
  if ((state === 'READY') !== (linkToken !== null) || (state === 'READY') !== (readyAt !== null)) invalid();
  return {
    assetId: uuid(row.assetId), kind: 'IMAGE', mediaType: oneOf(row.mediaType, SCHOOL_MEDIA_TYPES), title: row.title,
    byteSize: count(row.byteSize, 1, SCHOOL_MEDIA_LIMITS.maxBytes), width: count(row.width, 1, SCHOOL_MEDIA_LIMITS.maxSide),
    height: count(row.height, 1, SCHOOL_MEDIA_LIMITS.maxSide), state, version: count(row.version, 1, 999_999_999), linkToken,
    createdAt: instant(row.createdAt), readyAt, updatedAt: instant(row.updatedAt),
  };
}

export function verifySchoolMediaLibrary(value: unknown): SchoolMediaLibrary {
  const row = record(value, ['assets', 'usage']);
  if (!Array.isArray(row.assets) || row.assets.length > SCHOOL_MEDIA_LIMITS.list) invalid();
  const usage = record(row.usage, ['storedBytes', 'storedLimitBytes', 'monthBytes', 'monthLimitBytes']);
  const assets = row.assets.map(verifySchoolMediaAsset);
  if (new Set(assets.map(asset => asset.assetId)).size !== assets.length) invalid();
  return {
    assets,
    usage: {
      storedBytes: count(usage.storedBytes, 0, Number.MAX_SAFE_INTEGER), storedLimitBytes: count(usage.storedLimitBytes, 1, Number.MAX_SAFE_INTEGER),
      monthBytes: count(usage.monthBytes, 0, Number.MAX_SAFE_INTEGER), monthLimitBytes: count(usage.monthLimitBytes, 1, Number.MAX_SAFE_INTEGER),
    },
  };
}

export function validateRenameSchoolMedia(value: unknown): RenameSchoolMediaInput {
  const row = record(value, ['assetId', 'expectedVersion', 'title']);
  if (!schoolMediaTitleOk(row.title)) invalid();
  return { assetId: uuid(row.assetId), expectedVersion: count(row.expectedVersion, 1, 999_999_999), title: row.title };
}
export function validateDeleteSchoolMedia(value: unknown): DeleteSchoolMediaInput {
  const row = record(value, ['assetId', 'expectedVersion']);
  return { assetId: uuid(row.assetId), expectedVersion: count(row.expectedVersion, 1, 999_999_999) };
}
export function verifySchoolMediaReceipt(value: unknown): SchoolMediaReceipt {
  const row = record(value, ['asset', 'replayed']);
  if (typeof row.replayed !== 'boolean') invalid();
  return { asset: verifySchoolMediaAsset(row.asset), replayed: row.replayed };
}
export function verifySchoolMediaDeleteReceipt(value: unknown): SchoolMediaDeleteReceipt {
  const row = record(value, ['assetId', 'removed', 'replayed']);
  if (typeof row.removed !== 'boolean' || typeof row.replayed !== 'boolean') invalid();
  return { assetId: uuid(row.assetId), removed: row.removed, replayed: row.replayed };
}

/** "1.2 MB", "340 KB", "5 GB": decimal-free below 10 of a unit is one decimal. */
export function formatSchoolMediaBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  if (unit === 0) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)} ${units[unit]}`;
}
