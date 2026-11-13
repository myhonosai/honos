// Creative Studio avatars (A1, migration 0276) closed contracts. An avatar is a school's own AI presenter look: a name, a
// style and a description, made by ONE CS1 generation (0216) with the HQ-priced operation avatar.create (IMAGE, 1 unit,
// PORTRAIT) and paid from that school's creative wallet (0202). Clients never choose the operation, units, provider,
// model, price or school. The avatar's status is derived from its creation generation, so an HQ resolution shows up
// without touching the avatar. No provider identity, model, cost or HQ note is ever part of a school view.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsTimestamp as isTimestamp,
  championsIsUuid as isUuid, championsRecord as record } from './champions-club.js';
import { CREATIVE_GENERATION_FORMATS, CREATIVE_STUDIO_PROVIDER_STATES, isCreativePrompt, validateCreativeGeneration, type CreativeGeneration, type CreativeGenerationFormat, type CreativeGenerationStatus,
  type CreativeStudioProviderState } from './creative-studio.js';
import { validateSaasCreativeBalance, type SaasCreativeBalance } from './saas-creative-wallet.js';

export const CREATIVE_AVATAR_OPERATION = 'avatar.create';
export const CREATIVE_AVATAR_STYLES = ['REALISTIC', 'ILLUSTRATED', 'CHIBI'] as const;
export type CreativeAvatarStyle = typeof CREATIVE_AVATAR_STYLES[number];
export const CREATIVE_AVATAR_STATUSES = ['CREATING', 'READY', 'UNDER_REVIEW', 'NOT_CREATED'] as const;
export type CreativeAvatarStatus = typeof CREATIVE_AVATAR_STATUSES[number];
/** Limits shared by the database (0276) and the API. maxPerSchool counts avatars that are not failed or refunded. */
export const CREATIVE_AVATAR_LIMITS = { nameCharacters: 40, maxPerSchool: 12, listLimit: 50 } as const;

/** Operation codes reserved for avatars: only the avatar routes may create them. */
export function isCreativeAvatarOperation(operationCode: string): boolean { return operationCode.startsWith('avatar.'); }

/** The avatar status a school sees for the status of its creation generation. */
export function creativeAvatarStatus(status: CreativeGenerationStatus): CreativeAvatarStatus {
  switch (status) {
    case 'GENERATING': return 'CREATING';
    case 'SUCCEEDED': return 'READY';
    case 'UNDER_REVIEW': return 'UNDER_REVIEW';
    default: return 'NOT_CREATED';
  }
}

export interface CreativeAvatarInput { name: string; style: CreativeAvatarStyle; description: string }
export interface CreativeAvatar {
  avatarId: string; schoolId: string; name: string; style: CreativeAvatarStyle; description: string; status: CreativeAvatarStatus; createdAt: string;
  /** The avatar's creation generation (credits, status, result metadata). */
  generation: CreativeGeneration;
}
export interface CreativeAvatarRecords { avatars: CreativeAvatar[]; limit: 50 }
export interface CreativeStudioAvatarList extends CreativeAvatarRecords { provider: CreativeStudioProviderState }
export interface CreativeAvatarReceipt { avatar: CreativeAvatar; balance: SaasCreativeBalance; replayed: boolean }

// One line, printable, trimmed: no control, line-break or bidi-override characters.
const NAME_UNSAFE = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/;
export function isCreativeAvatarName(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= CREATIVE_AVATAR_LIMITS.nameCharacters && value.trim() === value && !NAME_UNSAFE.test(value);
}
const has = (list: readonly unknown[], value: unknown) => list.includes(value);

export function validateCreativeAvatarInput(value: unknown): CreativeAvatarInput {
  const input = record(value, invalid); exactKeys(input, ['name', 'style', 'description'], invalid);
  if (!isCreativeAvatarName(input.name) || !has(CREATIVE_AVATAR_STYLES, input.style) || !isCreativePrompt(input.description)) invalid();
  return { name: input.name as string, style: input.style as CreativeAvatarStyle, description: input.description as string };
}

export function validateCreativeAvatar(value: unknown): CreativeAvatar {
  const a = record(value, drift);
  exactKeys(a, ['avatarId', 'schoolId', 'name', 'style', 'description', 'status', 'createdAt', 'generation'], drift);
  if (!isUuid(a.avatarId) || !isUuid(a.schoolId) || !isCreativeAvatarName(a.name) || !has(CREATIVE_AVATAR_STYLES, a.style) || !isCreativePrompt(a.description)
    || !has(CREATIVE_AVATAR_STATUSES, a.status) || !isTimestamp(a.createdAt)) drift();
  const g = validateCreativeGeneration(a.generation);
  if (g.schoolId !== a.schoolId || g.operationCode !== CREATIVE_AVATAR_OPERATION || g.mediaKind !== 'IMAGE' || g.units !== 1 || g.format !== 'PORTRAIT'
    || g.prompt !== a.description || g.createdAt !== a.createdAt || creativeAvatarStatus(g.status) !== a.status) drift();
  return a as unknown as CreativeAvatar;
}
function validateAvatarArray(value: unknown): void {
  if (!Array.isArray(value) || value.length > CREATIVE_AVATAR_LIMITS.listLimit) drift();
  const list = (value as unknown[]).map(validateCreativeAvatar);
  if (new Set(list.map(a => a.avatarId)).size !== list.length || new Set(list.map(a => a.schoolId)).size > 1) drift();
  for (let i = 1; i < list.length; i++) if (Date.parse(list[i - 1]!.createdAt) < Date.parse(list[i]!.createdAt)) drift();
}
/** The database read (0276): one school's newest avatars. */
export function validateCreativeAvatarRecords(value: unknown): CreativeAvatarRecords {
  const r = record(value, drift); exactKeys(r, ['avatars', 'limit'], drift);
  if (r.limit !== CREATIVE_AVATAR_LIMITS.listLimit) drift();
  validateAvatarArray(r.avatars);
  return r as unknown as CreativeAvatarRecords;
}
/** The API list view: the records plus whether a provider is connected (server runtime, never a client choice). */
export function validateCreativeStudioAvatarList(value: unknown): CreativeStudioAvatarList {
  const r = record(value, drift); exactKeys(r, ['provider', 'avatars', 'limit'], drift);
  if (!has(CREATIVE_STUDIO_PROVIDER_STATES, r.provider) || r.limit !== CREATIVE_AVATAR_LIMITS.listLimit) drift();
  validateAvatarArray(r.avatars);
  return r as unknown as CreativeStudioAvatarList;
}
export function validateCreativeAvatarReceipt(value: unknown): CreativeAvatarReceipt {
  const r = record(value, drift); exactKeys(r, ['avatar', 'balance', 'replayed'], drift);
  if (typeof r.replayed !== 'boolean') drift();
  validateCreativeAvatar(r.avatar); validateSaasCreativeBalance(r.balance);
  return r as unknown as CreativeAvatarReceipt;
}

// ---------- A2 avatar videos (migration 0277) ----------
// An avatar video is one of the school's READY avatars speaking a script, made by ONE CS1 generation of the HQ-priced
// operation avatar.video (VIDEO, one unit per second). The script is the generation's prompt.
export const CREATIVE_AVATAR_VIDEO_OPERATION = 'avatar.video';
/** Limits shared by the database (0277) and the API. */
export const CREATIVE_AVATAR_VIDEO_LIMITS = { minSeconds: 5, maxSeconds: 60, listLimit: 50 } as const;

export interface CreativeAvatarVideoInput { avatarId: string; script: string; seconds: number; format: CreativeGenerationFormat }
export interface CreativeAvatarVideo {
  videoId: string; schoolId: string; avatarId: string; script: string; seconds: number; format: CreativeGenerationFormat;
  status: CreativeAvatarStatus; createdAt: string;
  /** The video's generation (credits, status, result metadata). */
  generation: CreativeGeneration;
}
export interface CreativeAvatarVideoRecords { videos: CreativeAvatarVideo[]; limit: 50 }
export interface CreativeAvatarVideoReceipt { video: CreativeAvatarVideo; balance: SaasCreativeBalance; replayed: boolean }

const isSeconds = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= CREATIVE_AVATAR_VIDEO_LIMITS.minSeconds && v <= CREATIVE_AVATAR_VIDEO_LIMITS.maxSeconds;

export function validateCreativeAvatarVideoInput(value: unknown): CreativeAvatarVideoInput {
  const input = record(value, invalid); exactKeys(input, ['avatarId', 'script', 'seconds', 'format'], invalid);
  if (!isUuid(input.avatarId) || !isCreativePrompt(input.script) || !isSeconds(input.seconds) || !has(CREATIVE_GENERATION_FORMATS, input.format)) invalid();
  return { avatarId: input.avatarId as string, script: input.script as string, seconds: input.seconds as number, format: input.format as CreativeGenerationFormat };
}

export function validateCreativeAvatarVideo(value: unknown): CreativeAvatarVideo {
  const v = record(value, drift);
  exactKeys(v, ['videoId', 'schoolId', 'avatarId', 'script', 'seconds', 'format', 'status', 'createdAt', 'generation'], drift);
  if (!isUuid(v.videoId) || !isUuid(v.schoolId) || !isUuid(v.avatarId) || !isCreativePrompt(v.script) || !isSeconds(v.seconds)
    || !has(CREATIVE_GENERATION_FORMATS, v.format) || !has(CREATIVE_AVATAR_STATUSES, v.status) || !isTimestamp(v.createdAt)) drift();
  const g = validateCreativeGeneration(v.generation);
  if (g.schoolId !== v.schoolId || g.operationCode !== CREATIVE_AVATAR_VIDEO_OPERATION || g.mediaKind !== 'VIDEO' || g.units !== v.seconds || g.format !== v.format
    || g.prompt !== v.script || g.createdAt !== v.createdAt || creativeAvatarStatus(g.status) !== v.status) drift();
  return v as unknown as CreativeAvatarVideo;
}
/** The database read (0277): one school's newest avatar videos. */
export function validateCreativeAvatarVideoRecords(value: unknown): CreativeAvatarVideoRecords {
  const r = record(value, drift); exactKeys(r, ['videos', 'limit'], drift);
  if (r.limit !== CREATIVE_AVATAR_VIDEO_LIMITS.listLimit || !Array.isArray(r.videos) || r.videos.length > CREATIVE_AVATAR_VIDEO_LIMITS.listLimit) drift();
  const list = (r.videos as unknown[]).map(validateCreativeAvatarVideo);
  if (new Set(list.map(v => v.videoId)).size !== list.length || new Set(list.map(v => v.schoolId)).size > 1) drift();
  for (let i = 1; i < list.length; i++) if (Date.parse(list[i - 1]!.createdAt) < Date.parse(list[i]!.createdAt)) drift();
  return r as unknown as CreativeAvatarVideoRecords;
}
export function validateCreativeAvatarVideoReceipt(value: unknown): CreativeAvatarVideoReceipt {
  const r = record(value, drift); exactKeys(r, ['video', 'balance', 'replayed'], drift);
  if (typeof r.replayed !== 'boolean') drift();
  validateCreativeAvatarVideo(r.video); validateSaasCreativeBalance(r.balance);
  return r as unknown as CreativeAvatarVideoReceipt;
}

// ---------- A3 photo avatars (migration 0305) ----------
// An adult staff member may make an avatar from THEIR OWN photo (owner decision 2026-11-12), after signing the likeness
// consent below. The photo never leaves HON while no real provider is connected; the person can delete it at any time
// (a live school owner can too), which erases the image and withdraws the avatar and its videos. Students, children and
// anybody else are never allowed: the database ties the photo, the consent and the photo avatar to the signed-in person.
export const CREATIVE_PHOTO_CONSENT_VERSION = 'HON-LIKENESS-2026-11-12';
export const CREATIVE_PHOTO_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type CreativePhotoContentType = typeof CREATIVE_PHOTO_CONTENT_TYPES[number];
export const CREATIVE_PHOTO_STATUSES = ['ACTIVE', 'WITHDRAWN', 'INACTIVE'] as const;
export type CreativePhotoStatus = typeof CREATIVE_PHOTO_STATUSES[number];
export const CREATIVE_PHOTO_WITHDRAWN_REASONS = ['DELETED_BY_SUBJECT', 'DELETED_BY_OWNER', 'REPLACED'] as const;
export type CreativePhotoWithdrawnReason = typeof CREATIVE_PHOTO_WITHDRAWN_REASONS[number];
/** The fixed look description of every photo avatar (0305 sets it; the photo itself is never described in words). */
export const CREATIVE_PHOTO_AVATAR_DESCRIPTION = 'An avatar of the staff member, made from their own consented photo.';
/** Limits shared by the database (0305), the API and the web form. */
export const CREATIVE_PHOTO_LIMITS = { minBytes: 64, maxBytes: 1_048_576, signatureMin: 2, signatureMax: 80, listLimit: 50 } as const;

/** What the person signs: three attestations and their typed name, for one photo of themselves. */
export interface CreativePhotoUploadInput {
  consentVersion: typeof CREATIVE_PHOTO_CONSENT_VERSION; ownLikeness: true; adult: true; marketingUse: true;
  signatureName: string; contentType: CreativePhotoContentType;
  /** Base64 image bytes (no data: prefix). */
  photo: string;
}
export interface CreativePhotoConsent {
  consentId: string; schoolId: string; mine: boolean; signatureName: string; consentVersion: string; contentType: CreativePhotoContentType;
  byteSize: number; status: CreativePhotoStatus; withdrawnReason: CreativePhotoWithdrawnReason | null; withdrawnAt: string | null;
  avatarIds: string[]; createdAt: string;
}
export interface CreativePhotoRecords { photos: CreativePhotoConsent[]; canManageAll: boolean; limit: 50 }
export interface CreativePhotoReceipt { photo: CreativePhotoConsent; replayed: boolean }
export interface CreativePhotoDeleted { photo: CreativePhotoConsent }
export interface CreativePhotoImage { consentId: string; contentType: CreativePhotoContentType; photo: string }
export interface CreativePhotoAvatarInput { consentId: string; name: string; style: CreativeAvatarStyle }

export function isCreativePhotoSignature(value: unknown): value is string {
  return typeof value === 'string' && value.length >= CREATIVE_PHOTO_LIMITS.signatureMin && value.length <= CREATIVE_PHOTO_LIMITS.signatureMax
    && value.trim() === value && !NAME_UNSAFE.test(value);
}
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** Decoded size of a canonical base64 string, or -1. */
export function creativePhotoBase64Bytes(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 || !BASE64.test(value)) return -1;
  return value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
}

export function validateCreativePhotoUploadInput(value: unknown): CreativePhotoUploadInput {
  const input = record(value, invalid);
  exactKeys(input, ['consentVersion', 'ownLikeness', 'adult', 'marketingUse', 'signatureName', 'contentType', 'photo'], invalid);
  const size = creativePhotoBase64Bytes(input.photo);
  if (input.consentVersion !== CREATIVE_PHOTO_CONSENT_VERSION || input.ownLikeness !== true || input.adult !== true || input.marketingUse !== true
    || !isCreativePhotoSignature(input.signatureName) || !has(CREATIVE_PHOTO_CONTENT_TYPES, input.contentType)
    || size < CREATIVE_PHOTO_LIMITS.minBytes || size > CREATIVE_PHOTO_LIMITS.maxBytes) invalid();
  return { consentVersion: CREATIVE_PHOTO_CONSENT_VERSION, ownLikeness: true, adult: true, marketingUse: true, signatureName: input.signatureName as string,
    contentType: input.contentType as CreativePhotoContentType, photo: input.photo as string };
}

export function validateCreativePhotoConsent(value: unknown): CreativePhotoConsent {
  const c = record(value, drift);
  exactKeys(c, ['consentId', 'schoolId', 'mine', 'signatureName', 'consentVersion', 'contentType', 'byteSize', 'status', 'withdrawnReason', 'withdrawnAt', 'avatarIds', 'createdAt'], drift);
  if (!isUuid(c.consentId) || !isUuid(c.schoolId) || typeof c.mine !== 'boolean' || !isCreativePhotoSignature(c.signatureName)
    || c.consentVersion !== CREATIVE_PHOTO_CONSENT_VERSION || !has(CREATIVE_PHOTO_CONTENT_TYPES, c.contentType)
    || !Number.isInteger(c.byteSize) || (c.byteSize as number) < CREATIVE_PHOTO_LIMITS.minBytes || (c.byteSize as number) > CREATIVE_PHOTO_LIMITS.maxBytes
    || !has(CREATIVE_PHOTO_STATUSES, c.status) || !isTimestamp(c.createdAt) || !Array.isArray(c.avatarIds) || !(c.avatarIds as unknown[]).every(isUuid)) drift();
  const withdrawn = c.withdrawnReason !== null;
  if (withdrawn ? !has(CREATIVE_PHOTO_WITHDRAWN_REASONS, c.withdrawnReason) || !isTimestamp(c.withdrawnAt) || c.status !== 'WITHDRAWN' : c.withdrawnAt !== null) drift();
  return c as unknown as CreativePhotoConsent;
}
export function validateCreativePhotoRecords(value: unknown): CreativePhotoRecords {
  const r = record(value, drift); exactKeys(r, ['photos', 'canManageAll', 'limit'], drift);
  if (r.limit !== CREATIVE_PHOTO_LIMITS.listLimit || typeof r.canManageAll !== 'boolean' || !Array.isArray(r.photos) || r.photos.length > CREATIVE_PHOTO_LIMITS.listLimit) drift();
  const list = (r.photos as unknown[]).map(validateCreativePhotoConsent);
  if (new Set(list.map(p => p.consentId)).size !== list.length || new Set(list.map(p => p.schoolId)).size > 1) drift();
  if (!r.canManageAll && list.some(p => !p.mine)) drift();
  return r as unknown as CreativePhotoRecords;
}
export function validateCreativePhotoReceipt(value: unknown): CreativePhotoReceipt {
  const r = record(value, drift); exactKeys(r, ['photo', 'replayed'], drift);
  if (typeof r.replayed !== 'boolean' || validateCreativePhotoConsent(r.photo).mine !== true) drift();
  return r as unknown as CreativePhotoReceipt;
}
export function validateCreativePhotoDeleted(value: unknown): CreativePhotoDeleted {
  const r = record(value, drift); exactKeys(r, ['photo'], drift);
  if (validateCreativePhotoConsent(r.photo).status !== 'WITHDRAWN') drift();
  return r as unknown as CreativePhotoDeleted;
}
export function validateCreativePhotoImage(value: unknown): CreativePhotoImage {
  const r = record(value, drift); exactKeys(r, ['consentId', 'contentType', 'photo'], drift);
  const size = creativePhotoBase64Bytes(r.photo);
  if (!isUuid(r.consentId) || !has(CREATIVE_PHOTO_CONTENT_TYPES, r.contentType) || size < CREATIVE_PHOTO_LIMITS.minBytes || size > CREATIVE_PHOTO_LIMITS.maxBytes) drift();
  return r as unknown as CreativePhotoImage;
}
export function validateCreativePhotoAvatarInput(value: unknown): CreativePhotoAvatarInput {
  const input = record(value, invalid); exactKeys(input, ['consentId', 'name', 'style'], invalid);
  if (!isUuid(input.consentId) || !isCreativeAvatarName(input.name) || !has(CREATIVE_AVATAR_STYLES, input.style)) invalid();
  return { consentId: input.consentId as string, name: input.name as string, style: input.style as CreativeAvatarStyle };
}
