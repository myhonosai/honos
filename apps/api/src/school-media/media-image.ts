import { createHash } from 'node:crypto';
import { SCHOOL_MEDIA_LIMITS, type SchoolMediaType } from '@hon/contracts';
import { ImageRefused, stripImageMetadata } from '../paper-import/image-metadata.js';

/**
 * BL3a (0628) picture hygiene. A picture is accepted only as a well-formed JPEG, PNG or GIF whose first bytes say so. JPEG
 * and PNG go through the 0388 stripper (EXIF, XMP, IPTC, comments and text chunks removed). A JPEG keeps only its EXIF
 * orientation, rewritten as a minimal EXIF block that holds nothing else, so phone photos are not shown sideways. A GIF
 * keeps its frames, colour tables, frame timing and loop setting; comments, plain-text and every other application block
 * (XMP and the like) are removed, as is anything after the trailer. The size, SHA-256, width and height are those of the
 * cleaned bytes, which are exactly what is stored.
 */
export class MediaImageRefused extends Error { constructor() { super('MEDIA_IMAGE_REFUSED'); } }
const refuse = (): never => { throw new MediaImageRefused(); };

export interface PreparedMediaImage { mediaType: SchoolMediaType; bytes: Buffer; byteSize: number; sha256: string; width: number; height: number }

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function sniffMediaType(bytes: Buffer): SchoolMediaType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6))) return 'image/gif';
  return null;
}

/** Cleans and measures a picture whose declared type must match its bytes, or throws MediaImageRefused. */
export function prepareMediaImage(declared: string, input: Buffer): PreparedMediaImage {
  if (!Buffer.isBuffer(input) || input.length < 1 || input.length > SCHOOL_MEDIA_LIMITS.maxBytes) refuse();
  const mediaType = sniffMediaType(input);
  if (!mediaType || mediaType !== declared) refuse();
  let bytes: Buffer;
  try {
    if (mediaType === 'image/gif') bytes = stripGif(input);
    else if (mediaType === 'image/png') bytes = stripImageMetadata('image/png', input);
    else bytes = withOrientation(stripImageMetadata('image/jpeg', input), jpegOrientation(input));
  } catch (error) {
    if (error instanceof ImageRefused || error instanceof MediaImageRefused || error instanceof RangeError) refuse();
    throw error;
  }
  const { width, height } = measure(mediaType!, bytes!);
  if (width < 1 || height < 1 || width > SCHOOL_MEDIA_LIMITS.maxSide || height > SCHOOL_MEDIA_LIMITS.maxSide) refuse();
  if (bytes!.length < 1 || bytes!.length > SCHOOL_MEDIA_LIMITS.maxBytes) refuse();
  return { mediaType: mediaType!, bytes: bytes!, byteSize: bytes!.length, sha256: createHash('sha256').update(bytes!).digest('hex'), width, height };
}

function measure(type: SchoolMediaType, b: Buffer): { width: number; height: number } {
  if (type === 'image/png') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (type === 'image/gif') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  // JPEG: the first start-of-frame segment (SOF0-3, 5-7, 9-11, 13-15) carries the size.
  let pos = 2;
  while (pos + 4 <= b.length) {
    if (b[pos] !== 0xff) refuse();
    const marker = b[pos + 1]!;
    if (marker === 0xff) { pos += 1; continue; }
    if (marker === 0xd9 || marker === 0xda) break;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { pos += 2; continue; }
    const length = b.readUInt16BE(pos + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 7 || pos + 9 > b.length) refuse();
      return { height: b.readUInt16BE(pos + 5), width: b.readUInt16BE(pos + 7) };
    }
    pos += 2 + length;
  }
  return refuse();
}

/** The EXIF orientation (1-8) of the original JPEG, or 1 when there is none or it cannot be read. */
export function jpegOrientation(b: Buffer): number {
  let pos = 2;
  while (pos + 4 <= b.length && b[pos] === 0xff) {
    const marker = b[pos + 1]!;
    if (marker === 0xda || marker === 0xd9) return 1;
    const length = b.readUInt16BE(pos + 2);
    if (marker === 0xe1 && length >= 16 && pos + 2 + length <= b.length && b.toString('latin1', pos + 4, pos + 10) === 'Exif\0\0') {
      const tiff = pos + 10, end = pos + 2 + length;
      const order = b.toString('latin1', tiff, tiff + 2);
      if (order !== 'II' && order !== 'MM') return 1;
      const u16 = (at: number) => order === 'II' ? b.readUInt16LE(at) : b.readUInt16BE(at);
      const u32 = (at: number) => order === 'II' ? b.readUInt32LE(at) : b.readUInt32BE(at);
      if (u16(tiff + 2) !== 42) return 1;
      const ifd = tiff + u32(tiff + 4);
      if (ifd + 2 > end) return 1;
      const entries = u16(ifd);
      for (let i = 0; i < entries; i += 1) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > end) return 1;
        if (u16(entry) === 0x0112 && u16(entry + 2) === 3) {
          const value = u16(entry + 8);
          return value >= 1 && value <= 8 ? value : 1;
        }
      }
      return 1;
    }
    pos += 2 + length;
  }
  return 1;
}

/** Puts back a minimal EXIF block holding only the orientation (when it is not the default), right after SOI/APP0. */
export function withOrientation(b: Buffer, orientation: number): Buffer {
  if (orientation === 1) return b;
  const exif = Buffer.alloc(36);
  exif.writeUInt16BE(0xffe1, 0); exif.writeUInt16BE(34, 2);
  exif.write('Exif\0\0', 4, 'latin1');
  exif.write('MM', 10, 'latin1'); exif.writeUInt16BE(42, 12); exif.writeUInt32BE(8, 14);
  exif.writeUInt16BE(1, 18);
  exif.writeUInt16BE(0x0112, 20); exif.writeUInt16BE(3, 22); exif.writeUInt32BE(1, 24); exif.writeUInt16BE(orientation, 28); exif.writeUInt16BE(0, 30);
  exif.writeUInt32BE(0, 32);
  let at = 2;
  if (b[2] === 0xff && b[3] === 0xe0) at = 4 + b.readUInt16BE(4);
  return Buffer.concat([b.subarray(0, at), exif, b.subarray(at)]);
}

const GIF_KEPT_APPLICATIONS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0']);

/** Walks a GIF and copies only what draws it; refuses anything malformed. */
export function stripGif(b: Buffer): Buffer {
  if (b.length < 13 || !/^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) refuse();
  const out: Buffer[] = [];
  const packed = b[10]!;
  let pos = 13 + ((packed & 0x80) ? 3 * (1 << ((packed & 0x07) + 1)) : 0);
  if (pos > b.length) refuse();
  out.push(b.subarray(0, pos));
  let frames = 0;
  const subBlocks = (start: number): number => {
    let at = start;
    for (;;) {
      if (at >= b.length) refuse();
      const size = b[at]!;
      at += 1 + size;
      if (size === 0) return at;
    }
  };
  while (pos < b.length) {
    const introducer = b[pos]!;
    if (introducer === 0x3b) { out.push(Buffer.from([0x3b])); if (!frames) refuse(); return Buffer.concat(out); }
    if (introducer === 0x2c) {
      if (pos + 10 > b.length) refuse();
      const local = b[pos + 9]!;
      let at = pos + 10 + ((local & 0x80) ? 3 * (1 << ((local & 0x07) + 1)) : 0);
      if (at + 1 > b.length) refuse();
      at = subBlocks(at + 1); // LZW minimum code size, then the image data
      out.push(b.subarray(pos, at));
      frames += 1;
      pos = at;
      continue;
    }
    if (introducer === 0x21) {
      if (pos + 2 > b.length) refuse();
      const label = b[pos + 1]!;
      const end = subBlocks(pos + 2);
      if (label === 0xf9) out.push(b.subarray(pos, end));
      else if (label === 0xff && b[pos + 2] === 11 && GIF_KEPT_APPLICATIONS.has(b.toString('latin1', pos + 3, pos + 14))) out.push(b.subarray(pos, end));
      pos = end;
      continue;
    }
    refuse();
  }
  return refuse();
}
