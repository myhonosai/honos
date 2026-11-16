import {
  validatePaperImportCreateInput, validatePaperImportPageInput, validatePaperImportSaveInput, validatePaperImportVersionInput,
  verifyPaperImportDetail, verifyPaperImportList, verifyPaperImportPage, verifyPaperImportSummary,
  type PaperImportDetail, type PaperImportKind, type PaperImportList, type PaperImportMediaType, type PaperImportPage, type PaperImportSummary,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * Paper import (0388, 0389): photos or scans read into a table that staff check, then sent to the existing staged import. Reads
 * send no Idempotency-Key; each command sends its own X-HON-Human-Command and (except the one reading per set and typing
 * the rows) an Idempotency-Key. The server strips image metadata, decides the AI spend, checks every cell and the permission.
 */
export type PaperErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed for this staff member at this school. Nothing changed. */ | 'DENIED'
  /** HON reading is not available for this school right now (an AI pause or access). Nothing was read. */ | 'AI_BLOCKED'
  /** HON reading needs the AI team (Complete) and AI permission. Nothing was read; typing the rows is open. */ | 'AI_FORBIDDEN'
  /** Another staff member started HON's reading of this set. Typing the rows is open. */ | 'READING_OWNED'
  /** HON is reading this set right now. */ | 'READING_BUSY'
  /** HON's paid answer could not be saved: held for HQ, never sent again. Not retried. */ | 'READING_UNKNOWN'
  /** Not found, or the photos were deleted. */ | 'GONE'
  /** The set changed since it was read, or is past that step. Nothing changed. */ | 'CHANGED'
  /** The photo was not accepted (type, size, or not a real image). Nothing changed. */ | 'IMAGE'
  /** This photo is already in the set. */ | 'DUPLICATE'
  /** The table has no filled row. */ | 'EMPTY'
  /** The request was not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Too many requests. Nothing changed. */ | 'RATE'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class PaperError extends Error { constructor(readonly kind: PaperErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;
export type PaperScope = Readonly<{ organizationId: string; schoolId: string }>;

const RESPONSE_MAX = 4_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
  return (value as { data: unknown }).data;
}
function base(scope: PaperScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new PaperError('INVALID');
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/paper-imports`;
}
function setPath(scope: PaperScope, setId: string): string {
  if (!UUID.test(setId)) throw new PaperError('INVALID');
  return `${base(scope)}/${setId.toLowerCase()}`;
}

type Command = Readonly<{ name: string; body: string; key: string | null }>;
async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Command): Promise<{ status: number; value: unknown }> {
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, ...(command.key ? { 'Idempotency-Key': command.key } : {}) } : {}) },
    ...(command ? { body: command.body } : {}) });
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new PaperError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new PaperError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}

/** What a refused answer means. Only these exact answers are definitive; anything else is UNKNOWN. */
export function paperErrorFor(status: number, code: string | null): PaperError {
  if (status === 403) return new PaperError(code === 'PAPER_IMPORT_AI_BLOCKED' ? 'AI_BLOCKED' : code === 'PAPER_IMPORT_AI_FORBIDDEN' ? 'AI_FORBIDDEN' : 'DENIED', code);
  if (status === 503 && code === 'PAPER_IMPORT_READING_UNKNOWN') return new PaperError('READING_UNKNOWN', code);
  if (status === 404) return new PaperError('GONE', code);
  if (status === 429) return new PaperError('RATE', code);
  if (status === 400) return new PaperError(code === 'PAPER_IMPORT_IMAGE_REFUSED' ? 'IMAGE' : code === 'PAPER_IMPORT_TABLE_EMPTY' ? 'EMPTY' : 'INVALID', code);
  if (status === 409) {
    if (code === 'PAPER_IMPORT_PAGE_DUPLICATE') return new PaperError('DUPLICATE', code);
    if (code === 'PAPER_IMPORT_READING_OWNED') return new PaperError('READING_OWNED', code);
    if (code === 'PAPER_IMPORT_READING_BUSY') return new PaperError('READING_BUSY', code);
    if (code && ['VERSION_CONFLICT', 'PAPER_IMPORT_ALREADY_READ', 'PAPER_IMPORT_NOT_EDITABLE', 'PAPER_IMPORT_READING_STALE'].includes(code)) return new PaperError('CHANGED', code);
    if (code === 'IDEMPOTENCY_KEY_REUSED' || code === 'IDEMPOTENCY_KEY_REQUIRED') return new PaperError('INVALID', code);
  }
  return new PaperError('UNKNOWN', code);
}

async function read<T>(path: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned); }
  catch (error) { if (error instanceof PaperError || signal.aborted) throw error; throw new PaperError('UNKNOWN'); }
  if (answer.status !== 200) throw paperErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new PaperError('UNKNOWN'); }
}
async function command<T>(path: string, name: string, body: unknown, key: string | null, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  if (key !== null && (typeof key !== 'string' || !UUID.test(key))) throw new PaperError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof PaperError) throw error; throw new PaperError('UNKNOWN'); }
  if (answer.status !== 200) throw paperErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new PaperError('UNKNOWN'); }
}
function checked<T>(validate: () => T): T { try { return validate(); } catch { throw new PaperError('INVALID'); } }
const sameSet = (setId: string) => (v: unknown): PaperImportSummary => {
  const set = verifyPaperImportSummary(v);
  if (set.id.toLowerCase() !== setId.toLowerCase()) throw new Error('set');
  return set;
};
const sameDetail = (setId: string) => (v: unknown): PaperImportDetail => {
  const detail = verifyPaperImportDetail(v);
  if (detail.set.id.toLowerCase() !== setId.toLowerCase()) throw new Error('set');
  return detail;
};

export const paperImportApi = {
  list(scope: PaperScope, signal: AbortSignal, owned: Owned): Promise<PaperImportList> {
    return Promise.resolve().then(() => read(base(scope), verifyPaperImportList, signal, owned));
  },
  detail(scope: PaperScope, setId: string, signal: AbortSignal, owned: Owned): Promise<PaperImportDetail> {
    return Promise.resolve().then(() => read(setPath(scope, setId), sameDetail(setId), signal, owned));
  },
  page(scope: PaperScope, setId: string, pageNo: number, signal: AbortSignal, owned: Owned): Promise<PaperImportPage> {
    return Promise.resolve().then(() => {
      if (!Number.isSafeInteger(pageNo) || pageNo < 1 || pageNo > 10) throw new PaperError('INVALID');
      return read(`${setPath(scope, setId)}/pages/${pageNo}`, verifyPaperImportPage, signal, owned);
    });
  },
  async create(scope: PaperScope, kind: PaperImportKind, key: string, signal: AbortSignal, owned: Owned): Promise<PaperImportSummary> {
    const body = checked(() => validatePaperImportCreateInput({ kind }));
    return command(base(scope), 'students.paper_import.create', body, key, verifyPaperImportSummary, signal, owned);
  },
  async addPage(scope: PaperScope, setId: string, input: { expectedVersion: number; mediaType: PaperImportMediaType; data: string }, key: string, signal: AbortSignal, owned: Owned): Promise<PaperImportSummary> {
    const body = checked(() => validatePaperImportPageInput(input));
    return command(`${setPath(scope, setId)}/pages`, 'students.paper_import.page', body, key, sameSet(setId), signal, owned);
  },
  /** One reading per set: no key; a repeat returns the table already read. */
  async read(scope: PaperScope, setId: string, expectedVersion: number, signal: AbortSignal, owned: Owned): Promise<PaperImportDetail> {
    const body = checked(() => validatePaperImportVersionInput({ expectedVersion }));
    return command(`${setPath(scope, setId)}/reading`, 'students.paper_import.reading', body, null, sameDetail(setId), signal, owned);
  },
  /** "Type the rows myself" (0389): no AI, nothing spent, no key; a repeat returns the set as it stands. */
  async typeRows(scope: PaperScope, setId: string, expectedVersion: number, signal: AbortSignal, owned: Owned): Promise<PaperImportDetail> {
    const body = checked(() => validatePaperImportVersionInput({ expectedVersion }));
    return command(`${setPath(scope, setId)}/typed`, 'students.paper_import.typed', body, null, sameDetail(setId), signal, owned);
  },
  async save(scope: PaperScope, setId: string, kind: PaperImportKind, input: { expectedVersion: number; rows: string[][]; unsure: boolean[][] }, key: string, signal: AbortSignal, owned: Owned): Promise<PaperImportSummary> {
    const body = checked(() => validatePaperImportSaveInput(kind, input));
    return command(`${setPath(scope, setId)}/table`, 'students.paper_import.save', body, key, sameSet(setId), signal, owned);
  },
  async send(scope: PaperScope, setId: string, expectedVersion: number, key: string, signal: AbortSignal, owned: Owned): Promise<PaperImportSummary> {
    const body = checked(() => validatePaperImportVersionInput({ expectedVersion }));
    return command(`${setPath(scope, setId)}/send`, 'students.paper_import.send', body, key, sameSet(setId), signal, owned);
  },
  async remove(scope: PaperScope, setId: string, key: string, signal: AbortSignal, owned: Owned): Promise<PaperImportSummary> {
    return command(`${setPath(scope, setId)}/delete`, 'students.paper_import.delete', {}, key, sameSet(setId), signal, owned);
  },
};
export type PaperImportApi = typeof paperImportApi;

/** Whether a failed command may be sent again with the same key: only when its outcome is not known, or it was rate limited. */
export const keepForRetry = (error: unknown) => !(error instanceof PaperError) || error.kind === 'UNKNOWN' || error.kind === 'RATE';

/**
 * A photo ready to send. A JPEG is always redrawn (which turns it the way the camera held it, since the server removes the
 * camera's orientation tag with the rest of its metadata); a PNG or WebP of at most 1.4 MB is sent as it is; anything
 * larger is redrawn as a JPEG of at most 2400 px on the long side. The server strips metadata again whatever is sent.
 */
export const PHOTO_LONG_SIDE = 2400;
export type PreparedPhoto = { ok: true; mediaType: PaperImportMediaType; data: string } | { ok: false; problem: 'TOO_BIG' | 'UNREADABLE' };
export async function preparePhoto(file: Blob, maxBytes = 1400000): Promise<PreparedPhoto> {
  const type = file.type as PaperImportMediaType, accepted = ['image/jpeg', 'image/png', 'image/webp'].includes(type);
  const canDraw = typeof createImageBitmap === 'function' && typeof document !== 'undefined';
  if (accepted && file.size <= maxBytes && (type !== 'image/jpeg' || !canDraw)) return { ok: true, mediaType: type, data: await toBase64(file) };
  if (!file.type.startsWith('image/') || !canDraw) return { ok: false, problem: accepted ? 'TOO_BIG' : 'UNREADABLE' };
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { return { ok: false, problem: 'UNREADABLE' }; }
  try {
    for (const side of [PHOTO_LONG_SIDE, 1800, 1400]) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/jpeg', 0.85));
      if (blob && blob.size <= maxBytes) return { ok: true, mediaType: 'image/jpeg', data: await toBase64(blob) };
    }
    return { ok: false, problem: 'TOO_BIG' };
  } finally { bitmap.close(); }
}
async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** At most 200 UTF-16 units, never ending in half of a surrogate pair. */
export function clipCell(value: string): string {
  if (value.length <= 200) return value;
  const cut = value.slice(0, 200);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}
/** The table as staff edit it: one line of plain text per cell, trimmed, with nothing the server refuses. */
export function cleanCell(value: string): string {
  const plain = value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufffd]/g, ' ').replace(/\s+/g, ' ').trim();
  return clipCell(plain).trim();
}
