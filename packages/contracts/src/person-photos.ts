/** 0390: one contact photo per person at one exact school. Images carry no metadata; the database refuses any that does. */
import { accountClosed, accountUuid } from './school-owner-invitations.js';

export const PERSON_PHOTO_HUMAN_COMMAND = 'school-person-photo' as const;
export const PERSON_PHOTO_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type PersonPhotoMediaType = typeof PERSON_PHOTO_MEDIA_TYPES[number];
export const PERSON_PHOTO_MAX_BYTES = 400_000;
/** The longest base64 text of a photo of PERSON_PHOTO_MAX_BYTES. */
export const PERSON_PHOTO_MAX_BASE64 = Math.ceil(PERSON_PHOTO_MAX_BYTES / 3) * 4;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const SHA = /^[a-f0-9]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
function fail(response: boolean): never { throw new Error(response ? 'PERSON_PHOTO_RESPONSE_INVALID' : 'PERSON_PHOTO_INPUT_INVALID'); }
function closed(v: unknown, keys: readonly string[], response: boolean): Record<string, unknown> { try { return accountClosed(v, keys); } catch { fail(response); } }
function id(v: unknown, response: boolean): string { try { return accountUuid(v).toLowerCase(); } catch { fail(response); } }
function version(v: unknown, response: boolean): number { if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 999_999_999) fail(response); return v as number; }
function mediaType(v: unknown, response: boolean): PersonPhotoMediaType { if (!(PERSON_PHOTO_MEDIA_TYPES as readonly unknown[]).includes(v)) fail(response); return v as PersonPhotoMediaType; }
function data(v: unknown, response: boolean): string {
  if (typeof v !== 'string' || v.length < 4 || v.length > PERSON_PHOTO_MAX_BASE64 || v.length % 4 !== 0 || !BASE64.test(v)) fail(response);
  return v;
}

export interface PersonPhotoSetInput { schoolId: string; personId: string; expectedVersion: number | null; mediaType: PersonPhotoMediaType; data: string }
/** Closed body: expectedVersion is null when the person has no photo yet, else the current photo's version. */
export function validatePersonPhotoSetInput(v: unknown): PersonPhotoSetInput {
  const o = closed(v, ['schoolId', 'personId', 'expectedVersion', 'mediaType', 'data'], false);
  return Object.freeze({ schoolId: id(o.schoolId, false), personId: id(o.personId, false),
    expectedVersion: o.expectedVersion === null ? null : version(o.expectedVersion, false), mediaType: mediaType(o.mediaType, false), data: data(o.data, false) });
}
export interface PersonPhotoRemoveInput { schoolId: string; personId: string; expectedVersion: number }
export function validatePersonPhotoRemoveInput(v: unknown): PersonPhotoRemoveInput {
  const o = closed(v, ['schoolId', 'personId', 'expectedVersion'], false);
  return Object.freeze({ schoolId: id(o.schoolId, false), personId: id(o.personId, false), expectedVersion: version(o.expectedVersion, false) });
}

export interface PersonPhoto { mediaType: PersonPhotoMediaType; data: string; checksum: string; version: number; updatedAt: string }
export interface PersonPhotoRead { personId: string; photo: PersonPhoto | null }
export function validatePersonPhotoRead(v: unknown): PersonPhotoRead {
  const o = closed(v, ['personId', 'photo'], true);
  if (o.photo === null) return Object.freeze({ personId: id(o.personId, true), photo: null });
  const p = closed(o.photo, ['mediaType', 'data', 'checksum', 'version', 'updatedAt'], true);
  if (typeof p.checksum !== 'string' || !SHA.test(p.checksum) || typeof p.updatedAt !== 'string' || !ISO.test(p.updatedAt)) fail(true);
  return Object.freeze({ personId: id(o.personId, true), photo: Object.freeze({ mediaType: mediaType(p.mediaType, true), data: data(p.data, true),
    checksum: p.checksum as string, version: version(p.version, true), updatedAt: p.updatedAt as string }) });
}

export interface PersonPhotoSummary { personId: string; mediaType: PersonPhotoMediaType; bytes: number; checksum: string; version: number; updatedAt: string }
function summary(v: unknown): PersonPhotoSummary {
  const o = closed(v, ['personId', 'mediaType', 'bytes', 'checksum', 'version', 'updatedAt'], true);
  if (!Number.isInteger(o.bytes) || (o.bytes as number) < 1 || (o.bytes as number) > PERSON_PHOTO_MAX_BYTES
    || typeof o.checksum !== 'string' || !SHA.test(o.checksum) || typeof o.updatedAt !== 'string' || !ISO.test(o.updatedAt)) fail(true);
  return Object.freeze({ personId: id(o.personId, true), mediaType: mediaType(o.mediaType, true), bytes: o.bytes as number, checksum: o.checksum as string,
    version: version(o.version, true), updatedAt: o.updatedAt as string });
}
export interface PersonPhotoSetResult { photo: PersonPhotoSummary; replaced: boolean; replayed: boolean }
export function validatePersonPhotoSetResult(v: unknown): PersonPhotoSetResult {
  const o = closed(v, ['photo', 'replaced', 'replayed'], true);
  if (typeof o.replaced !== 'boolean' || typeof o.replayed !== 'boolean') fail(true);
  return Object.freeze({ photo: summary(o.photo), replaced: o.replaced, replayed: o.replayed });
}
export interface PersonPhotoRemoveResult { personId: string; removed: true; replayed: boolean }
export function validatePersonPhotoRemoveResult(v: unknown): PersonPhotoRemoveResult {
  const o = closed(v, ['personId', 'removed', 'replayed'], true);
  if (o.removed !== true || typeof o.replayed !== 'boolean') fail(true);
  return Object.freeze({ personId: id(o.personId, true), removed: true, replayed: o.replayed });
}
