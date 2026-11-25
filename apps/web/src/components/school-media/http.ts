import {
  SCHOOL_MEDIA_COMMANDS, SCHOOL_MEDIA_LIMITS, SCHOOL_MEDIA_TYPES, schoolMediaTitleOk, schoolVideoTypeOf, validateBeginSchoolVideo, validateDeleteSchoolMedia,
  validateRenameSchoolMedia, verifySchoolMediaAsset, verifySchoolMediaLibrary, type DeleteSchoolMediaInput, type RenameSchoolMediaInput, type SchoolMediaAsset,
  type SchoolMediaLibrary, type SchoolMediaVideo, type SchoolVideoType,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * Marketing > Media (0628). The list is a plain same-origin GET with no key; each command sends its own X-HON-Human-Command
 * name and an Idempotency-Key. An upload sends the picture's raw bytes with its type, and its title percent-encoded in
 * X-HON-Media-Title. The server checks the bytes, removes location and camera data, and decides the permission and caps.
 */
export type MediaErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed here. Nothing changed. */ | 'DENIED'
  /** Someone changed this since it was read. Nothing changed. */ | 'CHANGED'
  /** The picture is gone. Nothing changed. */ | 'GONE'
  /** Not a JPEG, PNG or GIF the server could read. Nothing stored. */ | 'NOT_PICTURE'
  /** Larger than 25 MB. Nothing stored. */ | 'TOO_LARGE'
  /** The school's 5 GB is used. Nothing stored. */ | 'FULL'
  /** 10 GB uploaded this month already. Nothing stored. */ | 'MONTH'
  /** Media storage is not switched on for HON. Nothing stored. */ | 'OFF'
  /** Other pictures are uploading, or too many requests. Nothing stored. */ | 'BUSY'
  /** The request was not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN'
  /** 0654: not an MP4, MOV or WebM video. Nothing kept. */ | 'NOT_VIDEO'
  /** 0654: a video larger than 5 GB. Nothing stored. */ | 'VIDEO_TOO_LARGE'
  /** 0654: the file did not reach storage. Try again (same key). */ | 'UPLOAD_MISSING'
  /** 0654: the stored file is not the size the video was started with. */ | 'UPLOAD_MISMATCH';
export class MediaError extends Error { constructor(readonly kind: MediaErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;
export type MediaScope = Readonly<{ organizationId: string; schoolId: string }>;
export type MediaUpload = Readonly<{ file: Blob; title: string }>;
export type VideoUpload = Readonly<{ file: Blob; title: string; mediaType: SchoolVideoType }>;

const RESPONSE_MAX = 900_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function envelope(value: unknown): { data: unknown; meta: Record<string, unknown> } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
  const meta = (value as { meta: unknown }).meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('shape');
  return { data: (value as { data: unknown }).data, meta: meta as Record<string, unknown> };
}
function id(value: string): string { if (typeof value !== 'string' || !UUID.test(value)) throw new MediaError('INVALID'); return value.toLowerCase(); }
function base(scope: MediaScope): string { return `/api/v1/organizations/${id(scope.organizationId)}/schools/${id(scope.schoolId)}/marketing/media`; }

type Command = Readonly<{ name: string; key: string; body: BodyInit; headers: Record<string, string> }>;
async function exchange(url: string, signal: AbortSignal, owned: Owned, command?: Command): Promise<{ status: number; value: unknown }> {
  const r = await fetch(url, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { ...command.headers, 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  // A retired request (aborted, or no longer the one shown) never ends a newer session.
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new MediaError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new MediaError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}

/** What a refused answer means. Only these exact answers are definitive; anything else (5xx, drift) is UNKNOWN. */
export function mediaErrorFor(status: number, code: string | null): MediaError {
  if (status === 403) return new MediaError('DENIED', code);
  if (status === 404) return new MediaError('GONE', code);
  if (status === 413) return new MediaError('TOO_LARGE', code);
  if (status === 429) return new MediaError('BUSY', code);
  if (status === 400) return new MediaError(code === 'MEDIA_IMAGE_REFUSED' ? 'NOT_PICTURE' : code === 'MEDIA_VIDEO_REFUSED' ? 'NOT_VIDEO' : 'INVALID', code);
  if (status === 409) {
    const kind = ({ VERSION_CONFLICT: 'CHANGED', MEDIA_STORAGE_FULL: 'FULL', MEDIA_MONTHLY_LIMIT: 'MONTH', MEDIA_DELETED: 'GONE', IDEMPOTENCY_KEY_REUSED: 'INVALID',
      MEDIA_UPLOAD_MISSING: 'UPLOAD_MISSING', MEDIA_UPLOAD_MISMATCH: 'UPLOAD_MISMATCH' } as Record<string, MediaErrorKind>)[code ?? ''];
    if (kind) return new MediaError(kind, code);
  }
  if (status === 503 && code === 'MEDIA_STORAGE_OFF') return new MediaError('OFF', code);
  if (status === 503 && code === 'MEDIA_BUSY') return new MediaError('BUSY', code);
  return new MediaError('UNKNOWN', code);
}

async function call<T>(url: string, signal: AbortSignal, owned: Owned, verify: (data: unknown, meta: Record<string, unknown>) => T, command?: Command): Promise<T> {
  if (command && (typeof command.key !== 'string' || !UUID.test(command.key))) throw new MediaError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(url, signal, owned, command); }
  catch (error) { if (error instanceof MediaError || (!command && signal.aborted)) throw error; throw new MediaError('UNKNOWN'); }
  if (answer.status !== 200) throw mediaErrorFor(answer.status, codeOf(answer.value));
  try { const e = envelope(answer.value); return verify(e.data, e.meta); } catch { throw new MediaError('UNKNOWN'); }
}
function checked<T>(validate: (value: unknown) => T, value: unknown): T { try { return validate(value); } catch { throw new MediaError('INVALID'); } }
const json = (body: object) => ({ body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

/** A file the browser may send: a JPEG, PNG or GIF of at most 25 MB (the server checks the bytes again). */
export function mediaFileProblem(file: { type: string; size: number }): 'NOT_PICTURE' | 'TOO_LARGE' | null {
  if (!(SCHOOL_MEDIA_TYPES as readonly string[]).includes(file.type)) return 'NOT_PICTURE';
  if (file.size < 1) return 'NOT_PICTURE';
  return file.size > SCHOOL_MEDIA_LIMITS.maxBytes ? 'TOO_LARGE' : null;
}
/** 0654: a video file the browser may send (MP4, MOV or WebM up to 5 GB), with its type; or why not. */
export function videoFileProblem(file: { name: string; type: string; size: number }): { mediaType: SchoolVideoType } | { problem: 'NOT_VIDEO' | 'VIDEO_TOO_LARGE' } {
  const mediaType = schoolVideoTypeOf(file.name, file.type);
  if (!mediaType || file.size < 1) return { problem: 'NOT_VIDEO' };
  return file.size > SCHOOL_MEDIA_LIMITS.videoMaxBytes ? { problem: 'VIDEO_TOO_LARGE' } : { mediaType };
}
/** Whether a picked file is a video (by type, or by extension when the browser gives no type). */
export const isVideoFile = (file: { name: string; type: string }) => file.type.startsWith('video/') || (!file.type && schoolVideoTypeOf(file.name, '') !== null);

/**
 * 0654: PUT a video straight to the one-time signed storage link (cross-origin, no cookies, no HON headers), reporting
 * progress. Resolves when storage answers 2xx; rejects otherwise. The server then checks what arrived.
 */
export function putVideo(url: string, file: Blob, mediaType: SchoolVideoType, signal: AbortSignal, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!/^https:\/\/[^/?#]+\/storage\/v1\/object\/upload\/sign\/[^?#]+\?token=[A-Za-z0-9._~-]+$/.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) { reject(new MediaError('INVALID')); return; }
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.withCredentials = false;
    xhr.setRequestHeader('Content-Type', mediaType);
    xhr.setRequestHeader('x-upsert', 'true');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) onProgress(Math.min(100, Math.floor((e.loaded / e.total) * 100))); };
    xhr.onload = () => { if (xhr.status >= 200 && xhr.status < 300) resolve(); else reject(new MediaError('UPLOAD_MISSING')); };
    xhr.onerror = () => reject(new MediaError('UPLOAD_MISSING'));
    xhr.onabort = () => reject(new MediaError('UPLOAD_MISSING'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

export const mediaApi = {
  library(scope: MediaScope, signal: AbortSignal, owned: Owned): Promise<SchoolMediaLibrary> {
    return call(base(scope), signal, owned, verifySchoolMediaLibrary);
  },
  async upload(scope: MediaScope, input: MediaUpload, key: string, signal: AbortSignal, owned: Owned): Promise<SchoolMediaAsset> {
    const problem = mediaFileProblem(input.file);
    if (problem) throw new MediaError(problem);
    if (!schoolMediaTitleOk(input.title)) throw new MediaError('INVALID');
    return call(`${base(scope)}/upload`, signal, owned, (data) => {
      const asset = verifySchoolMediaAsset(data);
      if (asset.state !== 'READY' || asset.mediaType !== input.file.type) throw new Error('drift');
      return asset;
    }, { name: SCHOOL_MEDIA_COMMANDS.upload, key, body: input.file, headers: { 'Content-Type': input.file.type, 'X-HON-Media-Title': encodeURIComponent(input.title) } });
  },
  /**
   * 0654: start (reserve + one-time link), PUT the file to storage, then finish (the server checks size and signature). A
   * retry with the same key gets a fresh link for the same video; a finished video answers as it is.
   */
  async uploadVideo(scope: MediaScope, input: VideoUpload, key: string, signal: AbortSignal, owned: Owned, onProgress: (percent: number) => void = () => undefined): Promise<SchoolMediaVideo> {
    const body = checked(validateBeginSchoolVideo, { title: input.title, mediaType: input.mediaType, byteSize: input.file.size });
    const ticket = await call(`${base(scope)}/video/begin`, signal, owned, (data) => {
      const row = data as { asset?: unknown; uploadUrl?: unknown } | null;
      if (!row || typeof row !== 'object' || Object.keys(row).length !== 2 || (row.uploadUrl !== null && typeof row.uploadUrl !== 'string')) throw new Error('drift');
      const asset = verifySchoolMediaAsset(row.asset);
      if (asset.kind !== 'VIDEO' || asset.byteSize !== body.byteSize || asset.mediaType !== body.mediaType) throw new Error('drift');
      if ((asset.state === 'PENDING') !== (row.uploadUrl !== null)) throw new Error('drift');
      return { asset, uploadUrl: row.uploadUrl as string | null };
    }, { name: SCHOOL_MEDIA_COMMANDS.videoBegin, key, ...json(body) });
    if (ticket.asset.state === 'READY') return ticket.asset;
    let putError: unknown = null;
    try { await putVideo(ticket.uploadUrl!, input.file, input.mediaType, signal, onProgress); } catch (error) { putError = error; }
    try {
      return await call(`${base(scope)}/video/finish`, signal, owned, (data) => {
        const asset = verifySchoolMediaAsset(data);
        if (asset.kind !== 'VIDEO' || asset.assetId !== ticket.asset.assetId || asset.state !== 'READY') throw new Error('drift');
        return asset;
      }, { name: SCHOOL_MEDIA_COMMANDS.videoFinish, key: globalThis.crypto.randomUUID(), ...json({ assetId: ticket.asset.assetId }) });
    } catch (error) {
      // The PUT failing first explains a missing file better than the finish answer.
      if (putError instanceof MediaError && error instanceof MediaError && error.kind === 'UPLOAD_MISSING') throw putError;
      throw error;
    }
  },
  async rename(scope: MediaScope, input: RenameSchoolMediaInput, key: string, signal: AbortSignal, owned: Owned): Promise<SchoolMediaAsset> {
    const body = checked(validateRenameSchoolMedia, input);
    return call(`${base(scope)}/rename`, signal, owned, (data) => {
      const asset = verifySchoolMediaAsset(data);
      if (asset.assetId !== body.assetId || asset.title !== body.title || asset.version !== body.expectedVersion + 1) throw new Error('drift');
      return asset;
    }, { name: SCHOOL_MEDIA_COMMANDS.rename, key, ...json(body) });
  },
  async remove(scope: MediaScope, input: DeleteSchoolMediaInput, key: string, signal: AbortSignal, owned: Owned): Promise<{ assetId: string; removed: boolean }> {
    const body = checked(validateDeleteSchoolMedia, input);
    return call(`${base(scope)}/delete`, signal, owned, (data) => {
      const row = data as { assetId?: unknown; removed?: unknown } | null;
      if (!row || typeof row !== 'object' || Object.keys(row).length !== 2 || row.assetId !== body.assetId || typeof row.removed !== 'boolean') throw new Error('drift');
      return { assetId: body.assetId, removed: row.removed };
    }, { name: SCHOOL_MEDIA_COMMANDS.delete, key, ...json(body) });
  },
};
export type MediaApi = typeof mediaApi;

/** The picture's stable link, as staff paste it into a message: /m/<token> on this site. */
export function mediaLink(origin: string, token: string): string { return `${origin.replace(/\/$/, '')}/m/${token}`; }
/** 0654: a video's page, as staff paste it into a text or email: /v/<token> on this site. */
export function videoPageLink(origin: string, token: string): string { return `${origin.replace(/\/$/, '')}/v/${token}`; }
/** Whether a failed command may be sent again with the same key: only when its outcome is not known, or nothing was sent. */
export const keepForRetry = (error: unknown) => !(error instanceof MediaError) || error.kind === 'UNKNOWN' || error.kind === 'BUSY' || error.kind === 'UPLOAD_MISSING';
