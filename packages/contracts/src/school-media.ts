/**
 * School media library BL3a (migration 0628). Owner decisions (David): 2026-11-18 "Email pictures, video as a link";
 * 2026-11-22 "Allow media storage". Staff upload JPEG, PNG or GIF pictures (up to 25 MiB) through the HON API, which strips
 * location and camera metadata before storing them in one private bucket. Each READY picture has a stable public link
 * /m/<linkToken> that redirects to a short-lived signed file link. Spec: docs/architecture/SCHOOL_MEDIA_LIBRARY.md.
 *
 * BL3c (migration 0654, David 2026-11-22 "Allow 720p copies"): videos (MP4, MOV, WebM up to 5 GiB) go from the browser
 * straight into the bucket through a one-time signed upload link. HON then makes a 720p copy and a poster with every
 * metadata field removed; only those are ever linked (/m/<token>, /m/<token>/poster and the video page /v/<token>).
 */

export const SCHOOL_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif'] as const;
export type SchoolMediaType = typeof SCHOOL_MEDIA_TYPES[number];
export const SCHOOL_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const;
export type SchoolVideoType = typeof SCHOOL_VIDEO_TYPES[number];
export const SCHOOL_VIDEO_COPY_STATES = ['QUEUED', 'WORKING', 'DONE', 'FAILED'] as const;
export type SchoolVideoCopyState = typeof SCHOOL_VIDEO_COPY_STATES[number];
export const SCHOOL_MEDIA_STATES = ['PENDING', 'READY'] as const;
export type SchoolMediaState = typeof SCHOOL_MEDIA_STATES[number];
export const SCHOOL_MEDIA_LIMITS = {
  title: 100, maxBytes: 26_214_400, maxSide: 20_000, list: 500,
  storedBytes: 5_368_709_120, monthBytes: 10_737_418_240,
  videoMaxBytes: 5_368_709_120, copyMaxSide: 1280, maxDurationMs: 1_800_000,
} as const;
export const SCHOOL_MEDIA_COMMANDS = {
  upload: 'marketing_media.upload', rename: 'marketing_media.rename', delete: 'marketing_media.delete',
  videoBegin: 'marketing_media.video_begin', videoFinish: 'marketing_media.video_finish',
} as const;
export const SCHOOL_MEDIA_READ_COMMAND = 'marketing_media.read';
/** The percent-encoded UTF-8 title travels in this header beside the raw picture bytes. */
export const SCHOOL_MEDIA_TITLE_HEADER = 'x-hon-media-title';
export const SCHOOL_MEDIA_LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;

interface SchoolMediaAssetBase {
  assetId: string; title: string; byteSize: number; state: SchoolMediaState; version: number;
  /** Present only once it can be shown (a READY picture, or a READY video whose copy is DONE): it opens at /m/<linkToken>. */
  linkToken: string | null;
  createdAt: string; readyAt: string | null; updatedAt: string;
}
export interface SchoolMediaPicture extends SchoolMediaAssetBase {
  kind: 'IMAGE'; mediaType: SchoolMediaType; width: number; height: number; copyState: null; durationMs: null;
}
/** A video. Width, height and duration are the 720p copy's, known once the copy is DONE. copyState is null while PENDING. */
export interface SchoolMediaVideo extends SchoolMediaAssetBase {
  kind: 'VIDEO'; mediaType: SchoolVideoType; width: number | null; height: number | null; copyState: SchoolVideoCopyState | null; durationMs: number | null;
}
export type SchoolMediaAsset = SchoolMediaPicture | SchoolMediaVideo;
export interface BeginSchoolVideoInput { title: string; mediaType: SchoolVideoType; byteSize: number }
/** The browser PUTs the file to uploadUrl (a one-time signed link for this video's fixed key), then asks to finish. */
export interface SchoolVideoUploadTicket { asset: SchoolMediaVideo; uploadUrl: string | null; replayed: boolean }
export interface FinishSchoolVideoInput { assetId: string }
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
  const row = record(value, ['assetId', 'kind', 'mediaType', 'title', 'byteSize', 'width', 'height', 'state', 'version', 'linkToken', 'copyState', 'durationMs', 'createdAt', 'readyAt', 'updatedAt']);
  const state = oneOf(row.state, SCHOOL_MEDIA_STATES);
  if (!schoolMediaTitleOk(row.title)) invalid();
  const linkToken = row.linkToken === null ? null : (typeof row.linkToken === 'string' && SCHOOL_MEDIA_LINK_TOKEN.test(row.linkToken) ? row.linkToken : invalid());
  const readyAt = row.readyAt === null ? null : instant(row.readyAt);
  if ((state === 'READY') !== (readyAt !== null)) invalid();
  const base = {
    assetId: uuid(row.assetId), title: row.title, state, version: count(row.version, 1, 999_999_999), linkToken,
    createdAt: instant(row.createdAt), readyAt, updatedAt: instant(row.updatedAt),
  };
  if (row.kind === 'IMAGE') {
    if ((state === 'READY') !== (linkToken !== null) || row.copyState !== null || row.durationMs !== null) invalid();
    return {
      ...base, kind: 'IMAGE', mediaType: oneOf(row.mediaType, SCHOOL_MEDIA_TYPES), byteSize: count(row.byteSize, 1, SCHOOL_MEDIA_LIMITS.maxBytes),
      width: count(row.width, 1, SCHOOL_MEDIA_LIMITS.maxSide), height: count(row.height, 1, SCHOOL_MEDIA_LIMITS.maxSide), copyState: null, durationMs: null,
    };
  }
  if (row.kind !== 'VIDEO') invalid();
  const copyState = row.copyState === null ? null : oneOf(row.copyState, SCHOOL_VIDEO_COPY_STATES);
  const done = copyState === 'DONE';
  if ((state === 'READY') !== (copyState !== null) || (state === 'READY' && done) !== (linkToken !== null)) invalid();
  if (done !== (row.width !== null) || done !== (row.height !== null) || done !== (row.durationMs !== null)) invalid();
  return {
    ...base, kind: 'VIDEO', mediaType: oneOf(row.mediaType, SCHOOL_VIDEO_TYPES), byteSize: count(row.byteSize, 1, SCHOOL_MEDIA_LIMITS.videoMaxBytes),
    width: done ? count(row.width, 1, SCHOOL_MEDIA_LIMITS.copyMaxSide) : null, height: done ? count(row.height, 1, SCHOOL_MEDIA_LIMITS.copyMaxSide) : null,
    copyState, durationMs: done ? count(row.durationMs, 1, SCHOOL_MEDIA_LIMITS.maxDurationMs) : null,
  };
}

export function validateBeginSchoolVideo(value: unknown): BeginSchoolVideoInput {
  const row = record(value, ['title', 'mediaType', 'byteSize']);
  if (!schoolMediaTitleOk(row.title)) invalid();
  return { title: row.title, mediaType: oneOf(row.mediaType, SCHOOL_VIDEO_TYPES), byteSize: count(row.byteSize, 1, SCHOOL_MEDIA_LIMITS.videoMaxBytes) };
}
export function validateFinishSchoolVideo(value: unknown): FinishSchoolVideoInput {
  const row = record(value, ['assetId']);
  return { assetId: uuid(row.assetId) };
}
/** The video type of a file: its declared type, or (when the browser gives none) its extension. Null when not a video HON takes. */
export function schoolVideoTypeOf(name: string, declared: string): SchoolVideoType | null {
  const type = declared.toLowerCase();
  if ((SCHOOL_VIDEO_TYPES as readonly string[]).includes(type)) return type as SchoolVideoType;
  if (type && type !== 'application/octet-stream') return null;
  const ext = /\.([A-Za-z0-9]{2,4})$/.exec(name)?.[1]?.toLowerCase();
  return ext === 'mp4' || ext === 'm4v' ? 'video/mp4' : ext === 'mov' ? 'video/quicktime' : ext === 'webm' ? 'video/webm' : null;
}
/** "0:42", "12:05", "1:02:03". */
export function formatSchoolVideoDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000)), h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
export interface SchoolVideoPage { schoolName: string; title: string; width: number; height: number; durationMs: number }
export function verifySchoolVideoPage(value: unknown): SchoolVideoPage {
  const row = record(value, ['schoolName', 'title', 'width', 'height', 'durationMs']);
  if (typeof row.schoolName !== 'string' || row.schoolName.length < 1 || row.schoolName.length > 200 || CONTROL.test(row.schoolName) || !schoolMediaTitleOk(row.title)) invalid();
  return {
    schoolName: row.schoolName, title: row.title, width: count(row.width, 1, SCHOOL_MEDIA_LIMITS.copyMaxSide), height: count(row.height, 1, SCHOOL_MEDIA_LIMITS.copyMaxSide),
    durationMs: count(row.durationMs, 1, SCHOOL_MEDIA_LIMITS.maxDurationMs),
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
