import { CREATIVE_PHOTO_AVATAR_DESCRIPTION, validateCreativePhotoAvatarInput, validateCreativePhotoDeleted, validateCreativePhotoImage, validateCreativePhotoReceipt,
  validateCreativePhotoRecords, validateCreativePhotoUploadInput, type CreativePhotoAvatarInput, type CreativePhotoDeleted, type CreativePhotoImage, type CreativePhotoReceipt,
  type CreativePhotoRecords, type CreativePhotoUploadInput } from '@hon/contracts';
import { accountClosed, saasUuid, validateCreativeAvatarInput, validateCreativeAvatarReceipt, validateCreativeAvatarVideoInput, validateCreativeAvatarVideoReceipt,
  validateCreativeAvatarVideoRecords, type CreativeAvatarVideoInput, type CreativeAvatarVideoReceipt, type CreativeAvatarVideoRecords, validateCreativeGenerationInput, validateCreativeGenerationReceipt,
  validateCreativeStudioAvatarList, validateCreativeStudioGenerationList, type CreativeAvatarInput, type CreativeAvatarReceipt, type CreativeGenerationInput,
  type CreativeGenerationReceipt, type CreativeStudioAvatarList, type CreativeStudioGenerationList } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * Creative Studio generations (CS1). The server decides the provider, model and price, authorizes the exact school and
 * reserves credits from that school's own wallet; the browser only sends the closed request and keeps one idempotency
 * key per request until its outcome is known.
 */
export type GenerationErrorKind =
  /** Session ended: nothing more is shown. */ 'SESSION'
  /** This person cannot use Creative Studio at this school. Definitive. */ | 'DENIED'
  /** No creative provider is connected; nothing was sent or charged. Definitive. */ | 'NOT_CONNECTED'
  /** A school rule refused it (credits, HQ pause, eligibility, too many in progress). Definitive. */ | 'REFUSED'
  /** The request was not accepted as sent. Definitive. */ | 'INVALID'
  /** The outcome is not known. Retry only the identical request with the same key. */ | 'UNKNOWN';
export class CreativeGenerationError extends Error {
  constructor(readonly kind: GenerationErrorKind, readonly code: string | null = null) { super(kind); }
}
export const CREATIVE_GENERATION_COMMAND = 'saas-creative-generation-create';
export const CREATIVE_AVATAR_COMMAND = 'saas-creative-avatar-create';
export const CREATIVE_AVATAR_VIDEO_COMMAND = 'saas-creative-avatar-video-create';
/**
 * Only these answers prove the request was refused before anything was accepted. Every other 409 or 422 (including an
 * unrecognized or missing code, or a conflict raised while recording a provider result) leaves the outcome unknown.
 */
const DEFINITIVE_CONFLICTS = new Set(['IDEMPOTENCY_KEY_REUSED']);
/** School rules the server checks before it reserves credits or calls a provider. Any other 422 stays unknown. */
const PRE_ACCEPTANCE_REFUSALS = new Set(['CREATIVE_TOO_MANY_IN_PROGRESS', 'SAAS_CREATIVE_AI_PAUSED_BY_HQ', 'SAAS_CREATIVE_PROGRAM_INACTIVE',
  'SAAS_CREATIVE_PAID_ACCESS_REQUIRED', 'SAAS_CREATIVE_RATES_NOT_PUBLISHED', 'SAAS_CREATIVE_WINDOW_UNAVAILABLE', 'SAAS_CREATIVE_WINDOW_NOT_PAID',
  'SAAS_CREATIVE_ENTITLEMENT_NOT_IN_EFFECT', 'SAAS_CREATIVE_AI_ACCESS_LAPSED', 'SAAS_CREATIVE_DEBIT_EXCEEDS_AVAILABLE']);
const isRuleRefusal = (code: string | null) => code !== null && PRE_ACCEPTANCE_REFUSALS.has(code);
/** Avatars (0276) are also refused before anything is reserved when HQ has not priced them, the rate is not an image, or the school has 12. */
const AVATAR_REFUSALS = new Set([...PRE_ACCEPTANCE_REFUSALS, 'SAAS_OPERATION_NOT_PRICED', 'CREATIVE_AVATAR_RATE_INVALID', 'CREATIVE_AVATAR_LIMIT_REACHED']);

/** Avatar videos (0277) are refused before anything is reserved when HQ has not priced them, the rate is not a video, or the avatar is not ready. */
const VIDEO_REFUSALS = new Set([...PRE_ACCEPTANCE_REFUSALS, 'SAAS_OPERATION_NOT_PRICED', 'CREATIVE_AVATAR_RATE_INVALID', 'CREATIVE_AVATAR_NOT_READY']);

const generationsPath = (schoolId: string) => `/api/v1/schools/${saasUuid(schoolId).toLowerCase()}/creative-studio/generations`;
const avatarsPath = (schoolId: string) => `/api/v1/schools/${saasUuid(schoolId).toLowerCase()}/creative-studio/avatars`;
const videosPath = (schoolId: string) => `/api/v1/schools/${saasUuid(schoolId).toLowerCase()}/creative-studio/avatar-videos`;
const photosPath = (schoolId: string) => `/api/v1/schools/${saasUuid(schoolId).toLowerCase()}/creative-studio/avatar-photos`;
export const CREATIVE_PHOTO_UPLOAD_COMMAND = 'saas-creative-avatar-photo-upload';
export const CREATIVE_PHOTO_DELETE_COMMAND = 'saas-creative-avatar-photo-delete';
export const CREATIVE_PHOTO_AVATAR_COMMAND = 'saas-creative-photo-avatar-create';
/** A photo avatar is refused before anything is reserved for the avatar reasons, or when the photo was deleted or the person left the staff. */
const PHOTO_AVATAR_REFUSALS = new Set([...AVATAR_REFUSALS, 'CREATIVE_AVATAR_WITHDRAWN']);
const json = /^application\/json(?:\s*;|$)/i;

async function body(response: Response): Promise<unknown> {
  if (!json.test(response.headers.get('content-type') ?? '')) return null;
  try { return await response.json(); } catch { return null; }
}
const codeOf = (value: unknown): string | null =>
  value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { code?: unknown }).code === 'string' ? (value as { code: string }).code : null;

export async function listCreativeGenerations(schoolId: string, signal: AbortSignal): Promise<CreativeStudioGenerationList> {
  const path = generationsPath(schoolId);
  const response = await fetch(path, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal });
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new CreativeGenerationError('SESSION'); }
  if (response.status === 403) throw new CreativeGenerationError('DENIED', codeOf(await body(response)));
  if (response.status !== 200) throw new CreativeGenerationError('UNKNOWN', codeOf(await body(response)));
  try {
    const list = validateCreativeStudioGenerationList(accountClosed(await response.json(), ['data']).data);
    if (list.generations.some(g => g.schoolId !== schoolId.toLowerCase())) throw new Error('school');
    return list;
  } catch { throw new CreativeGenerationError('UNKNOWN'); }
}

/** Validates the request before anything is sent. Throws INVALID for a request the contract would refuse. */
export function prepareCreativeGeneration(input: CreativeGenerationInput): CreativeGenerationInput {
  try { return validateCreativeGenerationInput(input); } catch { throw new CreativeGenerationError('INVALID', 'INVALID_SAAS_INPUT'); }
}

/** One create attempt. Repeating it with the same key and input never makes a second generation. */
export async function createCreativeGeneration(schoolId: string, input: CreativeGenerationInput, idempotencyKey: string, signal: AbortSignal): Promise<CreativeGenerationReceipt> {
  const path = generationsPath(schoolId), key = saasUuid(idempotencyKey).toLowerCase(), request = prepareCreativeGeneration(input);
  let response: Response;
  try {
    response = await fetch(path, { method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': CREATIVE_GENERATION_COMMAND, 'Idempotency-Key': key },
      body: JSON.stringify(request), signal });
  } catch { throw new CreativeGenerationError('UNKNOWN'); }
  const code = response.status === 200 ? null : codeOf(await body(response));
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new CreativeGenerationError('SESSION'); }
  if (response.status === 403) throw new CreativeGenerationError('DENIED', code);
  // 400 (not accepted) and 404 (school or generation not found) roll back before anything is reserved.
  if (response.status === 400 || response.status === 404) throw new CreativeGenerationError('INVALID', code);
  if (response.status === 422) throw new CreativeGenerationError(isRuleRefusal(code) ? 'REFUSED' : 'UNKNOWN', code);
  if (response.status === 409) throw new CreativeGenerationError(code !== null && DEFINITIVE_CONFLICTS.has(code) ? 'INVALID' : 'UNKNOWN', code);
  if (response.status === 503 && code === 'CREATIVE_PROVIDER_NOT_CONNECTED') throw new CreativeGenerationError('NOT_CONNECTED', code);
  if (response.status !== 200) throw new CreativeGenerationError('UNKNOWN', code);
  try {
    const receipt = validateCreativeGenerationReceipt(accountClosed(await response.json(), ['data']).data);
    const g = receipt.generation;
    if (g.schoolId !== schoolId.toLowerCase() || g.operationCode !== request.operationCode || g.units !== request.units || g.format !== request.format || g.prompt !== request.prompt) throw new Error('mismatch');
    return receipt;
  } catch { throw new CreativeGenerationError('UNKNOWN'); }
}

// ---------- A1 avatars (0276): the same closed, keyed, fail-unknown handling as a generation ----------
export async function listCreativeAvatars(schoolId: string, signal: AbortSignal): Promise<CreativeStudioAvatarList> {
  const response = await fetch(avatarsPath(schoolId), { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal });
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new CreativeGenerationError('SESSION'); }
  if (response.status === 403) throw new CreativeGenerationError('DENIED', codeOf(await body(response)));
  if (response.status !== 200) throw new CreativeGenerationError('UNKNOWN', codeOf(await body(response)));
  try {
    const list = validateCreativeStudioAvatarList(accountClosed(await response.json(), ['data']).data);
    if (list.avatars.some(a => a.schoolId !== schoolId.toLowerCase())) throw new Error('school');
    return list;
  } catch { throw new CreativeGenerationError('UNKNOWN'); }
}

export function prepareCreativeAvatar(input: CreativeAvatarInput): CreativeAvatarInput {
  try { return validateCreativeAvatarInput(input); } catch { throw new CreativeGenerationError('INVALID', 'INVALID_SAAS_INPUT'); }
}

/** One avatar create attempt. Repeating it with the same key and input never makes a second avatar or charge. */
export async function createCreativeAvatar(schoolId: string, input: CreativeAvatarInput, idempotencyKey: string, signal: AbortSignal): Promise<CreativeAvatarReceipt> {
  const path = avatarsPath(schoolId), key = saasUuid(idempotencyKey).toLowerCase(), request = prepareCreativeAvatar(input);
  let response: Response;
  try {
    response = await fetch(path, { method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': CREATIVE_AVATAR_COMMAND, 'Idempotency-Key': key },
      body: JSON.stringify(request), signal });
  } catch { throw new CreativeGenerationError('UNKNOWN'); }
  const code = response.status === 200 ? null : codeOf(await body(response));
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new CreativeGenerationError('SESSION'); }
  if (response.status === 403) throw new CreativeGenerationError('DENIED', code);
  if (response.status === 400 || response.status === 404) throw new CreativeGenerationError('INVALID', code);
  if (response.status === 422) throw new CreativeGenerationError(code !== null && AVATAR_REFUSALS.has(code) ? 'REFUSED' : 'UNKNOWN', code);
  if (response.status === 409) throw new CreativeGenerationError(code !== null && DEFINITIVE_CONFLICTS.has(code) ? 'INVALID' : 'UNKNOWN', code);
  if (response.status === 503 && code === 'CREATIVE_PROVIDER_NOT_CONNECTED') throw new CreativeGenerationError('NOT_CONNECTED', code);
  if (response.status !== 200) throw new CreativeGenerationError('UNKNOWN', code);
  try {
    const receipt = validateCreativeAvatarReceipt(accountClosed(await response.json(), ['data']).data);
    const a = receipt.avatar;
    if (a.schoolId !== schoolId.toLowerCase() || a.name !== request.name || a.style !== request.style || a.description !== request.description) throw new Error('mismatch');
    return receipt;
  } catch { throw new CreativeGenerationError('UNKNOWN'); }
}

// ---------- A2 avatar videos (0277): a READY avatar speaks a script; same closed, keyed, fail-unknown handling ----------
export async function listCreativeAvatarVideos(schoolId: string, signal: AbortSignal): Promise<CreativeAvatarVideoRecords> {
  const response = await fetch(videosPath(schoolId), { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal });
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new CreativeGenerationError('SESSION'); }
  if (response.status === 403) throw new CreativeGenerationError('DENIED', codeOf(await body(response)));
  if (response.status !== 200) throw new CreativeGenerationError('UNKNOWN', codeOf(await body(response)));
  try {
    const list = validateCreativeAvatarVideoRecords(accountClosed(await response.json(), ['data']).data);
    if (list.videos.some(v => v.schoolId !== schoolId.toLowerCase())) throw new Error('school');
    return list;
  } catch { throw new CreativeGenerationError('UNKNOWN'); }
}

export function prepareCreativeAvatarVideo(input: CreativeAvatarVideoInput): CreativeAvatarVideoInput {
  try { return validateCreativeAvatarVideoInput(input); } catch { throw new CreativeGenerationError('INVALID', 'INVALID_SAAS_INPUT'); }
}

/** One avatar video attempt. Repeating it with the same key and input never makes a second video or charge. */
export async function createCreativeAvatarVideo(schoolId: string, input: CreativeAvatarVideoInput, idempotencyKey: string, signal: AbortSignal): Promise<CreativeAvatarVideoReceipt> {
  const path = videosPath(schoolId), key = saasUuid(idempotencyKey).toLowerCase(), request = prepareCreativeAvatarVideo(input);
  let response: Response;
  try {
    response = await fetch(path, { method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': CREATIVE_AVATAR_VIDEO_COMMAND, 'Idempotency-Key': key },
      body: JSON.stringify(request), signal });
  } catch { throw new CreativeGenerationError('UNKNOWN'); }
  const code = response.status === 200 ? null : codeOf(await body(response));
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new CreativeGenerationError('SESSION'); }
  if (response.status === 403) throw new CreativeGenerationError('DENIED', code);
  // 400 (not accepted) and 404 (school or avatar not found) are answered before anything is reserved.
  if (response.status === 400 || response.status === 404) throw new CreativeGenerationError('INVALID', code);
  if (response.status === 422) throw new CreativeGenerationError(code !== null && VIDEO_REFUSALS.has(code) ? 'REFUSED' : 'UNKNOWN', code);
  if (response.status === 409) throw new CreativeGenerationError(code !== null && DEFINITIVE_CONFLICTS.has(code) ? 'INVALID' : 'UNKNOWN', code);
  if (response.status === 503 && code === 'CREATIVE_PROVIDER_NOT_CONNECTED') throw new CreativeGenerationError('NOT_CONNECTED', code);
  if (response.status !== 200) throw new CreativeGenerationError('UNKNOWN', code);
  try {
    const receipt = validateCreativeAvatarVideoReceipt(accountClosed(await response.json(), ['data']).data);
    const v = receipt.video;
    if (v.schoolId !== schoolId.toLowerCase() || v.avatarId !== request.avatarId.toLowerCase() || v.script !== request.script || v.seconds !== request.seconds
      || v.format !== request.format) throw new Error('mismatch');
    return receipt;
  } catch { throw new CreativeGenerationError('UNKNOWN'); }
}

// ---------- A3 photo avatars (0305): an adult staff member's own photo, signed consent, delete at any time ----------
const read = (path: string, signal: AbortSignal) => fetch(path, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
  referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal });
const command = (path: string, name: string, payload: unknown, signal: AbortSignal, key?: string) => fetch(path, { method: 'POST', credentials: 'same-origin', mode: 'same-origin',
  cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
  headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': name, ...(key ? { 'Idempotency-Key': key } : {}) },
  body: JSON.stringify(payload), signal });

/** The signed-in person's own consented photos (and, for a live school owner, every staff consent so they can delete one). */
export async function listCreativeAvatarPhotos(schoolId: string, signal: AbortSignal): Promise<CreativePhotoRecords> {
  const response = await read(photosPath(schoolId), signal);
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new CreativeGenerationError('SESSION'); }
  if (response.status === 403) throw new CreativeGenerationError('DENIED', codeOf(await body(response)));
  if (response.status !== 200) throw new CreativeGenerationError('UNKNOWN', codeOf(await body(response)));
  try {
    const list = validateCreativePhotoRecords(accountClosed(await response.json(), ['data']).data);
    if (list.photos.some(p => p.schoolId !== schoolId.toLowerCase())) throw new Error('school');
    return list;
  } catch { throw new CreativeGenerationError('UNKNOWN'); }
}

/** The image itself. The server returns it only to the person in it. */
export async function readCreativeAvatarPhotoImage(schoolId: string, consentId: string, signal: AbortSignal): Promise<CreativePhotoImage> {
  const consent = saasUuid(consentId).toLowerCase();
  const response = await read(`${photosPath(schoolId)}/${consent}/image`, signal);
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new CreativeGenerationError('SESSION'); }
  if (response.status === 403) throw new CreativeGenerationError('DENIED', codeOf(await body(response)));
  if (response.status !== 200) throw new CreativeGenerationError('UNKNOWN', codeOf(await body(response)));
  try {
    const image = validateCreativePhotoImage(accountClosed(await response.json(), ['data']).data);
    if (image.consentId !== consent) throw new Error('consent');
    return image;
  } catch { throw new CreativeGenerationError('UNKNOWN'); }
}

export function prepareCreativePhotoUpload(input: CreativePhotoUploadInput): CreativePhotoUploadInput {
  try { return validateCreativePhotoUploadInput(input); } catch { throw new CreativeGenerationError('INVALID', 'INVALID_SAAS_INPUT'); }
}

/** One upload attempt with the signed consent. Repeating it with the same key and input stores one photo, never two. */
export async function uploadCreativeAvatarPhoto(schoolId: string, input: CreativePhotoUploadInput, idempotencyKey: string, signal: AbortSignal): Promise<CreativePhotoReceipt> {
  const key = saasUuid(idempotencyKey).toLowerCase(), request = prepareCreativePhotoUpload(input);
  let response: Response;
  try { response = await command(photosPath(schoolId), CREATIVE_PHOTO_UPLOAD_COMMAND, request, signal, key); } catch { throw new CreativeGenerationError('UNKNOWN'); }
  const code = response.status === 200 ? null : codeOf(await body(response));
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new CreativeGenerationError('SESSION'); }
  if (response.status === 403) throw new CreativeGenerationError('DENIED', code);
  // 400 (not a clean photo, or consent not complete) and 404 (school not found) store nothing.
  if (response.status === 400 || response.status === 404) throw new CreativeGenerationError('INVALID', code);
  if (response.status === 409) throw new CreativeGenerationError(code !== null && DEFINITIVE_CONFLICTS.has(code) ? 'INVALID' : 'UNKNOWN', code);
  if (response.status !== 200) throw new CreativeGenerationError('UNKNOWN', code);
  try {
    const receipt = validateCreativePhotoReceipt(accountClosed(await response.json(), ['data']).data);
    const p = receipt.photo;
    if (p.schoolId !== schoolId.toLowerCase() || p.signatureName !== request.signatureName || p.contentType !== request.contentType) throw new Error('mismatch');
    return receipt;
  } catch { throw new CreativeGenerationError('UNKNOWN'); }
}

/** Delete a photo: the image is erased and its avatars and videos are withdrawn. Deleting twice is harmless. */
export async function deleteCreativeAvatarPhoto(schoolId: string, consentId: string, signal: AbortSignal): Promise<CreativePhotoDeleted> {
  const consent = saasUuid(consentId).toLowerCase();
  let response: Response;
  try { response = await command(`${photosPath(schoolId)}/${consent}/delete`, CREATIVE_PHOTO_DELETE_COMMAND, {}, signal); } catch { throw new CreativeGenerationError('UNKNOWN'); }
  const code = response.status === 200 ? null : codeOf(await body(response));
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new CreativeGenerationError('SESSION'); }
  if (response.status === 403) throw new CreativeGenerationError('DENIED', code);
  if (response.status === 400 || response.status === 404) throw new CreativeGenerationError('INVALID', code);
  if (response.status !== 200) throw new CreativeGenerationError('UNKNOWN', code);
  try {
    const deleted = validateCreativePhotoDeleted(accountClosed(await response.json(), ['data']).data);
    if (deleted.photo.consentId !== consent || deleted.photo.schoolId !== schoolId.toLowerCase()) throw new Error('mismatch');
    return deleted;
  } catch { throw new CreativeGenerationError('UNKNOWN'); }
}

export function prepareCreativePhotoAvatar(input: CreativePhotoAvatarInput): CreativePhotoAvatarInput {
  try { return validateCreativePhotoAvatarInput(input); } catch { throw new CreativeGenerationError('INVALID', 'INVALID_SAAS_INPUT'); }
}

/** One photo avatar attempt: an ordinary avatar (same price and rules) made from the person's own live photo. Same key = same avatar. */
export async function createCreativePhotoAvatar(schoolId: string, input: CreativePhotoAvatarInput, idempotencyKey: string, signal: AbortSignal): Promise<CreativeAvatarReceipt> {
  const key = saasUuid(idempotencyKey).toLowerCase(), request = prepareCreativePhotoAvatar(input);
  let response: Response;
  try { response = await command(`${photosPath(schoolId)}/avatars`, CREATIVE_PHOTO_AVATAR_COMMAND, request, signal, key); } catch { throw new CreativeGenerationError('UNKNOWN'); }
  const code = response.status === 200 ? null : codeOf(await body(response));
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new CreativeGenerationError('SESSION'); }
  if (response.status === 403) throw new CreativeGenerationError('DENIED', code);
  if (response.status === 400 || response.status === 404) throw new CreativeGenerationError('INVALID', code);
  if (response.status === 422) throw new CreativeGenerationError(code !== null && PHOTO_AVATAR_REFUSALS.has(code) ? 'REFUSED' : 'UNKNOWN', code);
  if (response.status === 409) throw new CreativeGenerationError(code !== null && DEFINITIVE_CONFLICTS.has(code) ? 'INVALID' : 'UNKNOWN', code);
  if (response.status === 503 && code === 'CREATIVE_PROVIDER_NOT_CONNECTED') throw new CreativeGenerationError('NOT_CONNECTED', code);
  if (response.status !== 200) throw new CreativeGenerationError('UNKNOWN', code);
  try {
    const receipt = validateCreativeAvatarReceipt(accountClosed(await response.json(), ['data']).data);
    const a = receipt.avatar;
    if (a.schoolId !== schoolId.toLowerCase() || a.name !== request.name || a.style !== request.style || a.description !== CREATIVE_PHOTO_AVATAR_DESCRIPTION) throw new Error('mismatch');
    return receipt;
  } catch { throw new CreativeGenerationError('UNKNOWN'); }
}
