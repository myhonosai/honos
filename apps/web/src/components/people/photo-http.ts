import { PERSON_PHOTO_HUMAN_COMMAND, accountClosed, accountUuid, validatePersonPhotoRead, validatePersonPhotoRemoveInput, validatePersonPhotoRemoveResult,
  validatePersonPhotoSetInput, validatePersonPhotoSetResult, type PersonPhotoMediaType, type PersonPhotoRead, type PersonPhotoRemoveResult,
  type PersonPhotoSetResult } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * Contact photo of one person at the selected school (0390). The server decides authority from the verified session; the
 * browser names the school and person and sends one closed body per command with the exact human-command marker and an
 * idempotency key. Photos are shrunk to a small JPEG in the browser first (which also drops camera and location data);
 * the API strips metadata again and the database refuses any that remains.
 */
export type PhotoErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed to see or change photos at this school. Nothing changed. */ | 'DENIED'
  /** The person is not at this school. */ | 'MISSING'
  /** The photo changed since it was read. Nothing changed. */ | 'CONFLICT'
  /** The image or request was not accepted. Nothing changed. */ | 'INVALID'
  /** The same request is still being saved; it may be sent again. */ | 'BUSY'
  /** The outcome is not known; only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class PhotoError extends Error { constructor(readonly kind: PhotoErrorKind, readonly code: string | null = null) { super(kind); } }
export type PhotoScope = Readonly<{ schoolId: string }>;
export type Owned = () => boolean;

const RESPONSE_MAX = 720_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** What a refused answer means. Only these exact answers are definitive; anything else is UNKNOWN. */
export function photoErrorFor(status: number, code: string | null): PhotoError {
  if (status === 403) return new PhotoError('DENIED', code);
  if (status === 404 && code === 'PERSON_PHOTO_NOT_FOUND') return new PhotoError('MISSING', code);
  if (status === 400) return new PhotoError('INVALID', code);
  if (status === 409 && code === 'PERSON_PHOTO_VERSION_CONFLICT') return new PhotoError('CONFLICT', code);
  if (status === 409 && code === 'PERSON_PHOTO_KEY_REUSED') return new PhotoError('INVALID', code);
  if (status === 503 && code === 'PERSON_PHOTO_BUSY') return new PhotoError('BUSY', code);
  return new PhotoError('UNKNOWN', code);
}
/** Only an unknown outcome or a request still in progress keeps the exact request for Try again. */
export const keepPhotoForRetry = (error: unknown) => !(error instanceof PhotoError) || error.kind === 'UNKNOWN' || error.kind === 'BUSY';

async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  let r: Response;
  try {
    r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': PERSON_PHOTO_HUMAN_COMMAND, 'Idempotency-Key': command.key } : {}) },
      ...(command ? { body: command.body } : {}) });
  } catch (error) { if (signal.aborted && !command) throw error; throw new PhotoError('UNKNOWN'); }
  if (signal.aborted && !command) signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new PhotoError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  let text: string;
  try { text = await r.text(); } catch { throw new PhotoError('UNKNOWN'); }
  if (text.length > RESPONSE_MAX) throw new PhotoError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
const dataOf = (v: unknown) => accountClosed(v, ['data']).data;

export const photoApi = {
  async read(scope: PhotoScope, personId: string, signal: AbortSignal, owned: Owned): Promise<PersonPhotoRead> {
    let path: string;
    try { path = `/api/v1/school/schools/${accountUuid(scope.schoolId).toLowerCase()}/people/${accountUuid(personId).toLowerCase()}/photo`; } catch { throw new PhotoError('INVALID'); }
    const { status, value } = await exchange(path, signal, owned);
    if (status !== 200) throw photoErrorFor(status, codeOf(value));
    let read: PersonPhotoRead;
    try { read = validatePersonPhotoRead(dataOf(value)); } catch { throw new PhotoError('UNKNOWN'); }
    if (!same(read.personId, personId)) throw new PhotoError('UNKNOWN');
    return read;
  },
  /** Save a photo. expectedVersion is null when the person has none yet. The same key and body replay the saved answer. */
  async set(scope: PhotoScope, personId: string, expectedVersion: number | null, mediaType: PersonPhotoMediaType, data: string, key: string, signal: AbortSignal, owned: Owned)
    : Promise<PersonPhotoSetResult> {
    let body, k: string;
    try { body = validatePersonPhotoSetInput({ schoolId: scope.schoolId, personId, expectedVersion, mediaType, data }); k = accountUuid(key); } catch { throw new PhotoError('INVALID'); }
    const { status, value } = await exchange('/api/v1/school/people/photo', signal, owned, { body: JSON.stringify(body), key: k });
    if (status !== 200) throw photoErrorFor(status, codeOf(value));
    try {
      const result = validatePersonPhotoSetResult(dataOf(value));
      if (!same(result.photo.personId, personId) || result.photo.version !== (expectedVersion === null ? 1 : expectedVersion + 1)) throw new Error('mismatch');
      return result;
    } catch { throw new PhotoError('UNKNOWN'); }
  },
  async remove(scope: PhotoScope, personId: string, expectedVersion: number, key: string, signal: AbortSignal, owned: Owned): Promise<PersonPhotoRemoveResult> {
    let body, k: string;
    try { body = validatePersonPhotoRemoveInput({ schoolId: scope.schoolId, personId, expectedVersion }); k = accountUuid(key); } catch { throw new PhotoError('INVALID'); }
    const { status, value } = await exchange('/api/v1/school/people/photo/remove', signal, owned, { body: JSON.stringify(body), key: k });
    if (status !== 200) throw photoErrorFor(status, codeOf(value));
    try {
      const result = validatePersonPhotoRemoveResult(dataOf(value));
      if (!same(result.personId, personId)) throw new Error('mismatch');
      return result;
    } catch { throw new PhotoError('UNKNOWN'); }
  },
};
export type PhotoApi = typeof photoApi;

/** Largest side of a stored contact photo, in pixels. */
export const PHOTO_MAX_SIDE = 600;
/** The size a photo is drawn at: the longest side at most PHOTO_MAX_SIDE, never enlarged. */
export function photoSize(width: number, height: number): Readonly<{ width: number; height: number }> {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
/**
 * Redraws a picked or captured image as a JPEG of at most 600 pixels: smaller to send and store, and the redraw keeps only
 * pixels (no camera, owner or location data). Returns the base64 text, or null when the file is not a readable image.
 */
export async function shrinkPhoto(file: Blob): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = photoSize(bitmap.width, bitmap.height);
    if (!width) return null;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'); if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height); bitmap.close();
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob || blob.size > 400_000) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  } catch { return null; }
}
