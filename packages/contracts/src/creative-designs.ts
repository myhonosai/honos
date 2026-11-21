/**
 * Creative Studio design editor D1 (0617; docs/architecture/CREATIVE_DESIGN_EDITOR.md). A school's saved flyers, posters,
 * postcards and social graphics, and the photos placed in them. Seeing them needs creative.design.read; creating,
 * changing, archiving, restoring and uploading photos need creative.design.manage. Nothing here sends, publishes, prints,
 * charges or calls an AI service.
 */
export const CREATIVE_DESIGN_SIZE_CODES = ['FLYER_LETTER', 'FLYER_HALF', 'POSTER_11X17', 'POSTER_18X24', 'POSTCARD_4X6', 'POSTCARD_5X7',
  'SOCIAL_SQUARE', 'SOCIAL_STORY', 'EVENT_COVER'] as const;
export type CreativeDesignSizeCode = (typeof CREATIVE_DESIGN_SIZE_CODES)[number];
export type CreativeDesignSize = Readonly<{ code: CreativeDesignSizeCode; medium: 'PRINT' | 'SCREEN'; width: number; height: number; sides: 1 | 2 }>;
/** Print sizes in points (72 per inch, exported at 300 dpi); screen sizes in pixels. Postcards are landscape with a back. */
export const CREATIVE_DESIGN_SIZES: Readonly<Record<CreativeDesignSizeCode, CreativeDesignSize>> = {
  FLYER_LETTER: { code: 'FLYER_LETTER', medium: 'PRINT', width: 612, height: 792, sides: 1 },
  FLYER_HALF: { code: 'FLYER_HALF', medium: 'PRINT', width: 396, height: 612, sides: 1 },
  POSTER_11X17: { code: 'POSTER_11X17', medium: 'PRINT', width: 792, height: 1224, sides: 1 },
  POSTER_18X24: { code: 'POSTER_18X24', medium: 'PRINT', width: 1296, height: 1728, sides: 1 },
  POSTCARD_4X6: { code: 'POSTCARD_4X6', medium: 'PRINT', width: 432, height: 288, sides: 2 },
  POSTCARD_5X7: { code: 'POSTCARD_5X7', medium: 'PRINT', width: 504, height: 360, sides: 2 },
  SOCIAL_SQUARE: { code: 'SOCIAL_SQUARE', medium: 'SCREEN', width: 1080, height: 1080, sides: 1 },
  SOCIAL_STORY: { code: 'SOCIAL_STORY', medium: 'SCREEN', width: 1080, height: 1920, sides: 1 },
  EVENT_COVER: { code: 'EVENT_COVER', medium: 'SCREEN', width: 1920, height: 1005, sides: 1 },
};
export const CREATIVE_DESIGN_FONTS = ['SANS', 'SERIF', 'DISPLAY', 'ROUNDED', 'HANDWRITING', 'MONO'] as const;
export type CreativeDesignFont = (typeof CREATIVE_DESIGN_FONTS)[number];
export const CREATIVE_DESIGN_ELEMENT_KINDS = ['text', 'rect', 'ellipse', 'line', 'image', 'qr'] as const;
export type CreativeDesignElementKind = (typeof CREATIVE_DESIGN_ELEMENT_KINDS)[number];
export const CREATIVE_DESIGN_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type CreativeDesignStatus = (typeof CREATIVE_DESIGN_STATUSES)[number];
export const CREATIVE_DESIGN_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type CreativeDesignPhotoType = (typeof CREATIVE_DESIGN_PHOTO_TYPES)[number];
export const CREATIVE_DESIGN_LIMITS = {
  name: 80, text: 2000, elementsPerPage: 150, documentCharacters: 300_000, list: 1000, activeDesigns: 200, designs: 1000,
  photoBytes: 1_400_000, photos: 300, qrData: 200,
} as const;

/** Same-origin browser command names (the X-HON-Human-Command header). */
export const CREATIVE_DESIGNS_READ_COMMAND = 'creative.designs.read';
export const CREATIVE_DESIGN_SAVE_COMMAND = 'creative.design.save';
export const CREATIVE_DESIGN_STATUS_COMMAND = 'creative.design.status';
export const CREATIVE_DESIGN_PHOTO_COMMAND = 'creative.design.photo.add';

type Base = { id: string; x: number; y: number; w: number; h: number; rotation: number; opacity: number; locked: boolean };
export type CreativeDesignText = Base & { kind: 'text'; text: string; font: CreativeDesignFont; size: number; bold: boolean; italic: boolean;
  color: string; align: 'left' | 'center' | 'right'; lineHeight: number };
export type CreativeDesignRect = Base & { kind: 'rect'; fill: string | null; stroke: string | null; strokeWidth: number; radius: number };
export type CreativeDesignEllipse = Base & { kind: 'ellipse'; fill: string | null; stroke: string | null; strokeWidth: number };
export type CreativeDesignLine = Base & { kind: 'line'; stroke: string; strokeWidth: number };
export type CreativeDesignImage = Base & { kind: 'image'; imageId: string; fit: 'cover' | 'contain' };
/** A QR code for a link or short text (D2): drawn square in its box, dark modules in `color` on `background` (or clear). */
export type CreativeDesignQr = Base & { kind: 'qr'; data: string; color: string; background: string | null };
export type CreativeDesignElement = CreativeDesignText | CreativeDesignRect | CreativeDesignEllipse | CreativeDesignLine | CreativeDesignImage | CreativeDesignQr;
export interface CreativeDesignPage { background: string; elements: CreativeDesignElement[] }
export interface CreativeDesignDocument { v: 1; pages: CreativeDesignPage[] }

export interface CreativeDesignSummary {
  designId: string; name: string; sizeCode: CreativeDesignSizeCode; status: CreativeDesignStatus; version: number; createdAt: string; updatedAt: string;
}
export interface CreativeDesign extends CreativeDesignSummary { document: CreativeDesignDocument }
export interface CreativeDesignList { designs: CreativeDesignSummary[] }
export interface CreativeDesignsQuery { status?: CreativeDesignStatus }
export interface SaveCreativeDesignInput {
  designId: string | null; expectedVersion: number; name: string; sizeCode: CreativeDesignSizeCode; document: CreativeDesignDocument;
}
export interface SetCreativeDesignStatusInput { designId: string; expectedVersion: number; status: CreativeDesignStatus }
export interface CreativeDesignReceipt { design: CreativeDesign; replayed: boolean }
export interface AddCreativeDesignPhotoInput { mediaType: CreativeDesignPhotoType; data: string }
export interface CreativeDesignPhotoSummary { photoId: string; mediaType: CreativeDesignPhotoType; bytes: number; checksum: string; createdAt: string }
export interface CreativeDesignPhotoReceipt { photo: CreativeDesignPhotoSummary; replayed: boolean }
export interface CreativeDesignPhoto extends CreativeDesignPhotoSummary { data: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const COLOR = /^#[0-9A-F]{6}$/;
const ELEMENT_ID = /^[a-z0-9-]{1,40}$/;
const NAME_REFUSED = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/;
const TEXT_REFUSED = /[\u0000-\u0009\u000b-\u001f\u007f‎‏‪-‮⁦-⁩﻿]/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const QR_DATA = /^[\x20-\x7e]+$/;

/** Characters as the database counts them (code points, so an emoji is one). */
const size = (text: string): number => [...text].length;
function invalid(): never { throw new Error('Invalid creative design data.'); }
function record(value: unknown, keys: readonly string[], optional = false): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !keys.includes(key)) || (!optional && keys.some(key => !(key in row)))) invalid();
  return row;
}
function oneOf<T extends string>(value: unknown, list: readonly T[]): T {
  if (typeof value !== 'string' || !(list as readonly string[]).includes(value)) invalid();
  return value as T;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value; }
function instant(value: unknown): string { if (typeof value !== 'string' || !INSTANT.test(value) || new Date(value).toISOString() !== value) invalid(); return value; }
function version(value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > 999_999_999) invalid();
  return value;
}
function num(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid();
  return value;
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function color(value: unknown): string { if (typeof value !== 'string' || !COLOR.test(value)) invalid(); return value; }
function colorOrNull(value: unknown): string | null { return value === null ? null : color(value); }

export function creativeDesignNameOk(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && size(value) <= CREATIVE_DESIGN_LIMITS.name && value.trim() === value && !NAME_REFUSED.test(value);
}
/** What a QR code holds: 1..200 printable ASCII characters (a link, or a short code). */
export function creativeDesignQrDataOk(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= CREATIVE_DESIGN_LIMITS.qrData && QR_DATA.test(value);
}
export function creativeDesignTextOk(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && size(value) <= CREATIVE_DESIGN_LIMITS.text && !TEXT_REFUSED.test(value);
}

const BASE_KEYS = ['id', 'kind', 'x', 'y', 'w', 'h', 'rotation', 'opacity', 'locked'] as const;
const KIND_KEYS: Readonly<Record<CreativeDesignElementKind, readonly string[]>> = {
  text: ['text', 'font', 'size', 'bold', 'italic', 'color', 'align', 'lineHeight'],
  rect: ['fill', 'stroke', 'strokeWidth', 'radius'],
  ellipse: ['fill', 'stroke', 'strokeWidth'],
  line: ['stroke', 'strokeWidth'],
  image: ['imageId', 'fit'],
  qr: ['data', 'color', 'background'],
};

function element(value: unknown, page: CreativeDesignSize): CreativeDesignElement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const kind = oneOf((value as Record<string, unknown>).kind, CREATIVE_DESIGN_ELEMENT_KINDS);
  const row = record(value, [...BASE_KEYS, ...KIND_KEYS[kind]]);
  if (typeof row.id !== 'string' || !ELEMENT_ID.test(row.id)) invalid();
  const line = kind === 'line';
  const base: Base = {
    id: row.id,
    x: num(row.x, -2 * page.width, 3 * page.width), y: num(row.y, -2 * page.height, 3 * page.height),
    // A line runs from (x, y) by (w, h), so either may be zero or negative; every other element has a positive box.
    w: line ? num(row.w, -3 * page.width, 3 * page.width) : num(row.w, 0.01, 3 * page.width),
    h: line ? num(row.h, -3 * page.height, 3 * page.height) : num(row.h, 0.01, 3 * page.height),
    rotation: num(row.rotation, -360, 360), opacity: num(row.opacity, 0, 1), locked: bool(row.locked),
  };
  switch (kind) {
    case 'text':
      if (!creativeDesignTextOk(row.text)) invalid();
      return { ...base, kind, text: row.text, font: oneOf(row.font, CREATIVE_DESIGN_FONTS), size: num(row.size, 4, 600), bold: bool(row.bold),
        italic: bool(row.italic), color: color(row.color), align: oneOf(row.align, ['left', 'center', 'right'] as const), lineHeight: num(row.lineHeight, 0.8, 3) };
    case 'rect':
      return { ...base, kind, fill: colorOrNull(row.fill), stroke: colorOrNull(row.stroke), strokeWidth: num(row.strokeWidth, 0, 200), radius: num(row.radius, 0, 2000) };
    case 'ellipse':
      return { ...base, kind, fill: colorOrNull(row.fill), stroke: colorOrNull(row.stroke), strokeWidth: num(row.strokeWidth, 0, 200) };
    case 'line':
      return { ...base, kind, stroke: color(row.stroke), strokeWidth: num(row.strokeWidth, 0.5, 200) };
    case 'image':
      return { ...base, kind, imageId: uuid(row.imageId), fit: oneOf(row.fit, ['cover', 'contain'] as const) };
    case 'qr':
      if (!creativeDesignQrDataOk(row.data)) invalid();
      return { ...base, kind, data: row.data, color: color(row.color), background: colorOrNull(row.background) };
  }
}

/** A version-1 document for the given size: one page per side, closed element shapes, unique ids, at most 300,000 characters. */
export function validateCreativeDesignDocument(value: unknown, sizeCode: CreativeDesignSizeCode): CreativeDesignDocument {
  const page = CREATIVE_DESIGN_SIZES[sizeCode];
  const row = record(value, ['v', 'pages']);
  if (row.v !== 1 || !Array.isArray(row.pages) || row.pages.length !== page.sides) invalid();
  const ids = new Set<string>();
  const pages = row.pages.map(p => {
    const r = record(p, ['background', 'elements']);
    if (!Array.isArray(r.elements) || r.elements.length > CREATIVE_DESIGN_LIMITS.elementsPerPage) invalid();
    const elements = r.elements.map(e => element(e, page));
    for (const e of elements) { if (ids.has(e.id)) invalid(); ids.add(e.id); }
    return { background: color(r.background), elements };
  });
  const document: CreativeDesignDocument = { v: 1, pages };
  if (JSON.stringify(document).length > CREATIVE_DESIGN_LIMITS.documentCharacters) invalid();
  return document;
}
/** Every photo a document places, once each, in first-use order. */
export function creativeDesignPhotoIds(document: CreativeDesignDocument): string[] {
  return [...new Set(document.pages.flatMap(p => p.elements.flatMap(e => e.kind === 'image' ? [e.imageId] : [])))];
}
/** An empty document for a new design of this size: white pages, nothing on them. */
export function blankCreativeDesignDocument(sizeCode: CreativeDesignSizeCode): CreativeDesignDocument {
  return { v: 1, pages: Array.from({ length: CREATIVE_DESIGN_SIZES[sizeCode].sides }, () => ({ background: '#FFFFFF', elements: [] })) };
}

export function validateCreativeDesignsQuery(value: unknown): CreativeDesignsQuery {
  const row = record(value, ['status'], true);
  return 'status' in row ? { status: oneOf(row.status, CREATIVE_DESIGN_STATUSES) } : {};
}
export function validateSaveCreativeDesignInput(value: unknown): SaveCreativeDesignInput {
  const row = record(value, ['designId', 'expectedVersion', 'name', 'sizeCode', 'document']);
  const designId = row.designId === null ? null : uuid(row.designId);
  const expectedVersion = version(row.expectedVersion, 0);
  if ((designId === null) !== (expectedVersion === 0) || !creativeDesignNameOk(row.name)) invalid();
  const sizeCode = oneOf(row.sizeCode, CREATIVE_DESIGN_SIZE_CODES);
  return { designId, expectedVersion, name: row.name, sizeCode, document: validateCreativeDesignDocument(row.document, sizeCode) };
}
export function validateSetCreativeDesignStatusInput(value: unknown): SetCreativeDesignStatusInput {
  const row = record(value, ['designId', 'expectedVersion', 'status']);
  return { designId: uuid(row.designId), expectedVersion: version(row.expectedVersion, 1), status: oneOf(row.status, CREATIVE_DESIGN_STATUSES) };
}
/** A photo upload: a declared type and canonical base64 of 1..1,400,000 bytes. The server checks the bytes match the type. */
export function validateAddCreativeDesignPhotoInput(value: unknown): AddCreativeDesignPhotoInput {
  const row = record(value, ['mediaType', 'data']);
  const mediaType = oneOf(row.mediaType, CREATIVE_DESIGN_PHOTO_TYPES);
  if (typeof row.data !== 'string' || !row.data || !BASE64.test(row.data)) invalid();
  const bytes = row.data.length / 4 * 3 - (row.data.endsWith('==') ? 2 : row.data.endsWith('=') ? 1 : 0);
  if (bytes < 1 || bytes > CREATIVE_DESIGN_LIMITS.photoBytes) invalid();
  return { mediaType, data: row.data };
}

function summaryFields(row: Record<string, unknown>): CreativeDesignSummary {
  if (!creativeDesignNameOk(row.name)) invalid();
  const createdAt = instant(row.createdAt), updatedAt = instant(row.updatedAt);
  if (updatedAt < createdAt) invalid();
  return { designId: uuid(row.designId), name: row.name, sizeCode: oneOf(row.sizeCode, CREATIVE_DESIGN_SIZE_CODES),
    status: oneOf(row.status, CREATIVE_DESIGN_STATUSES), version: version(row.version, 1), createdAt, updatedAt };
}
export function verifyCreativeDesignSummary(value: unknown): CreativeDesignSummary {
  return summaryFields(record(value, ['designId', 'name', 'sizeCode', 'status', 'version', 'createdAt', 'updatedAt']));
}
export function verifyCreativeDesign(value: unknown): CreativeDesign {
  const row = record(value, ['designId', 'name', 'sizeCode', 'status', 'version', 'createdAt', 'updatedAt', 'document']);
  const summary = summaryFields(row);
  return { ...summary, document: validateCreativeDesignDocument(row.document, summary.sizeCode) };
}
/** A list answer: no duplicates, newest change first, every row in the asked status. */
export function verifyCreativeDesignList(value: unknown, query: CreativeDesignsQuery = {}): CreativeDesignList {
  const row = record(value, ['designs']);
  if (!Array.isArray(row.designs) || row.designs.length > CREATIVE_DESIGN_LIMITS.list) invalid();
  const designs = row.designs.map(verifyCreativeDesignSummary);
  if (new Set(designs.map(d => d.designId)).size !== designs.length) invalid();
  const status = query.status ?? 'ACTIVE';
  if (designs.some(d => d.status !== status)) invalid();
  for (let i = 1; i < designs.length; i++) if (designs[i - 1]!.updatedAt < designs[i]!.updatedAt) invalid();
  return { designs };
}
/** A command answer for the exact asked design: the next version, and the asked size or status when given. */
export function verifyCreativeDesignReceipt(value: unknown, expect: { version: number; designId?: string | null; sizeCode?: CreativeDesignSizeCode; status?: CreativeDesignStatus }): CreativeDesignReceipt {
  const row = record(value, ['design', 'replayed']);
  if (typeof row.replayed !== 'boolean') invalid();
  const design = verifyCreativeDesign(row.design);
  if (design.version !== expect.version || (expect.designId && design.designId !== expect.designId)
    || (expect.sizeCode && design.sizeCode !== expect.sizeCode) || (expect.status && design.status !== expect.status)) invalid();
  return { design, replayed: row.replayed };
}
function photoFields(row: Record<string, unknown>): CreativeDesignPhotoSummary {
  if (typeof row.checksum !== 'string' || !SHA256.test(row.checksum)) invalid();
  return { photoId: uuid(row.photoId), mediaType: oneOf(row.mediaType, CREATIVE_DESIGN_PHOTO_TYPES),
    bytes: num(row.bytes, 1, CREATIVE_DESIGN_LIMITS.photoBytes), checksum: row.checksum, createdAt: instant(row.createdAt) };
}
export function verifyCreativeDesignPhotoReceipt(value: unknown, expect: { mediaType: CreativeDesignPhotoType }): CreativeDesignPhotoReceipt {
  const row = record(value, ['photo', 'replayed']);
  if (typeof row.replayed !== 'boolean') invalid();
  const photo = photoFields(record(row.photo, ['photoId', 'mediaType', 'bytes', 'checksum', 'createdAt']));
  if (photo.mediaType !== expect.mediaType || !Number.isInteger(photo.bytes)) invalid();
  return { photo, replayed: row.replayed };
}
/** One photo with its bytes for the asked id; the byte count must match the base64. */
export function verifyCreativeDesignPhoto(value: unknown, photoId: string): CreativeDesignPhoto {
  const row = record(value, ['photoId', 'mediaType', 'bytes', 'checksum', 'createdAt', 'data']);
  const photo = photoFields(row);
  if (photo.photoId !== photoId) invalid();
  const data = validateAddCreativeDesignPhotoInput({ mediaType: photo.mediaType, data: row.data }).data;
  if (data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0) !== photo.bytes) invalid();
  return { ...photo, data };
}
