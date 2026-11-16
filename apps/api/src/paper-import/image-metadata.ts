import type { PaperImportMediaType } from '@hon/contracts';

/**
 * Paper import (0388) image hygiene. A page is accepted only as a well-formed JPEG, PNG or WebP whose first bytes match
 * the declared type. Metadata that can carry location, camera, owner or free text is removed before the page is stored:
 * every JPEG APPn segment except JFIF, Adobe and an ICC colour profile (so EXIF, XMP, IPTC, MPF previews and maker
 * comments go), COM segments, and anything after the end-of-image marker (such as appended preview images); PNG tEXt, zTXt, iTXt and eXIf chunks plus anything after IEND; WebP EXIF and XMP chunks (and their
 * VP8X flags). The database refuses any page that still carries them.
 */
export class ImageRefused extends Error { constructor() { super('PAPER_IMPORT_IMAGE_REFUSED'); } }
const refuse = (): never => { throw new ImageRefused(); };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function sniffImageType(bytes: Buffer): PaperImportMediaType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Returns the page without metadata, or throws ImageRefused when the bytes are not a well-formed image of that type. */
export function stripImageMetadata(type: PaperImportMediaType, bytes: Buffer): Buffer {
  if (sniffImageType(bytes) !== type) refuse();
  if (type === 'image/jpeg') return stripJpeg(bytes);
  if (type === 'image/png') return stripPng(bytes);
  return stripWebp(bytes);
}

/**
 * Which JPEG segments stay: everything that draws the picture, plus APP0 (JFIF), APP14 (Adobe colour transform) and an
 * APP2 ICC colour profile. Every other APPn (EXIF, XMP, IPTC, MPF previews, Ducky/PictureInfo comments, maker notes) and
 * COM are dropped, wherever they appear.
 */
function keepJpegSegment(b: Buffer, pos: number, marker: number, length: number): boolean {
  if (marker === 0xfe) return false;
  if (marker < 0xe0 || marker > 0xef) return true;
  if (marker === 0xe0 || marker === 0xee) return true;
  return marker === 0xe2 && length >= 14 && b.toString('latin1', pos + 4, pos + 16) === 'ICC_PROFILE\0';
}

function stripJpeg(b: Buffer): Buffer {
  const out: Buffer[] = [b.subarray(0, 2)];
  let pos = 2, scanning = false;
  while (pos < b.length) {
    if (scanning) {
      // Entropy-coded data: copy until the next real marker (0xFF not followed by a stuffed 0x00 or a restart marker).
      const start = pos;
      while (pos < b.length && !(b[pos] === 0xff && pos + 1 < b.length && b[pos + 1] !== 0x00 && !(b[pos + 1]! >= 0xd0 && b[pos + 1]! <= 0xd7) && b[pos + 1] !== 0xff)) pos++;
      if (pos >= b.length) refuse();
      out.push(b.subarray(start, pos));
      scanning = false;
      continue;
    }
    if (b[pos] !== 0xff || pos + 1 >= b.length) refuse();
    const marker = b[pos + 1]!;
    if (marker === 0xff) { pos++; continue; }
    if (marker === 0xd9) { out.push(Buffer.from([0xff, 0xd9])); return Buffer.concat(out); }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { out.push(b.subarray(pos, pos + 2)); pos += 2; continue; }
    if (pos + 4 > b.length) refuse();
    const length = b.readUInt16BE(pos + 2);
    if (length < 2 || pos + 2 + length > b.length) refuse();
    if (keepJpegSegment(b, pos, marker, length)) out.push(b.subarray(pos, pos + 2 + length));
    pos += 2 + length;
    if (marker === 0xda) scanning = true;
  }
  return refuse();
}

function stripPng(b: Buffer): Buffer {
  const out: Buffer[] = [PNG_SIGNATURE];
  let pos = 8, first = true, image = false;
  while (pos + 12 <= b.length) {
    const length = b.readUInt32BE(pos), type = b.toString('latin1', pos + 4, pos + 8);
    if (length > b.length || pos + 12 + length > b.length || (first && type !== 'IHDR')) refuse();
    first = false;
    if (type === 'IDAT') image = true;
    if (!['tEXt', 'zTXt', 'iTXt', 'eXIf'].includes(type)) out.push(b.subarray(pos, pos + 12 + length));
    pos += 12 + length;
    if (type === 'IEND') { if (!image) refuse(); return Buffer.concat(out); }
  }
  return refuse();
}

function stripWebp(b: Buffer): Buffer {
  if (b.readUInt32LE(4) + 8 > b.length) refuse();
  const end = b.readUInt32LE(4) + 8, chunks: Buffer[] = [];
  let pos = 12, image = false;
  while (pos < end) {
    if (pos + 8 > end) refuse();
    const type = b.toString('latin1', pos, pos + 4), length = b.readUInt32LE(pos + 4), padded = length + (length % 2);
    if (pos + 8 + length > end) refuse();
    if (type === 'VP8 ' || type === 'VP8L') image = true;
    if (type === 'VP8X') {
      const chunk = Buffer.from(b.subarray(pos, pos + 8 + padded));
      if (chunk.length >= 9) chunk[8] = chunk[8]! & ~0x0c;
      chunks.push(chunk);
    } else if (type !== 'EXIF' && type !== 'XMP ') chunks.push(b.subarray(pos, Math.min(pos + 8 + padded, end)));
    pos += 8 + padded;
  }
  if (!image || pos !== end) refuse();
  const body = Buffer.concat(chunks), header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(body.length + 4, 4); header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}
