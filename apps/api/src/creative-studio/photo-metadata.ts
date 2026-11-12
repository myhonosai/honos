/**
 * A3 photo avatars (0305): remove embedded metadata (EXIF location and camera data, XMP, IPTC, text comments) from a
 * staff member's own photo before it is stored. The image data itself is copied byte for byte; nothing is decoded or
 * re-encoded. A file that does not parse cleanly as its declared type is refused, never stored as-is.
 */
export class PhotoMetadataError extends Error {}

const fail = (): never => { throw new PhotoMetadataError('PHOTO_UNREADABLE'); };

/** JPEG: keep JFIF (APP0), ICC colour profiles (APP2 "ICC_PROFILE") and Adobe colour info (APP14); drop every other APPn and comments. */
function jpeg(src: Buffer): Buffer {
  if (src.length < 4 || src[0] !== 0xff || src[1] !== 0xd8) fail();
  const out: Buffer[] = [src.subarray(0, 2)];
  let i = 2;
  for (;;) {
    if (i + 4 > src.length || src[i] !== 0xff) fail();
    while (src[i + 1] === 0xff) i++; // fill bytes
    if (i + 4 > src.length) fail();
    const marker = src[i + 1]!;
    if (marker === 0xd9) { out.push(src.subarray(i, i + 2)); return Buffer.concat(out); }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { out.push(src.subarray(i, i + 2)); i += 2; continue; }
    const length = src.readUInt16BE(i + 2);
    if (length < 2 || i + 2 + length > src.length) fail();
    const end = i + 2 + length;
    if (marker === 0xda) { out.push(src.subarray(i)); return Buffer.concat(out); } // start of scan: the rest is image data
    const app = marker >= 0xe0 && marker <= 0xef;
    const keep = !app && marker !== 0xfe ? true
      : marker === 0xe0 || marker === 0xee || (marker === 0xe2 && src.subarray(i + 4, i + 16).toString('latin1') === 'ICC_PROFILE\0');
    if (keep) out.push(src.subarray(i, end));
    i = end;
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

/** PNG: drop the EXIF, text and timestamp chunks; every other chunk (with its CRC) is copied unchanged. */
function png(src: Buffer): Buffer {
  if (src.length < 8 || !src.subarray(0, 8).equals(PNG_SIGNATURE)) fail();
  const out: Buffer[] = [PNG_SIGNATURE];
  let i = 8;
  for (;;) {
    if (i + 12 > src.length) fail();
    const length = src.readUInt32BE(i);
    const type = src.subarray(i + 4, i + 8).toString('latin1');
    const end = i + 12 + length;
    if (!/^[A-Za-z]{4}$/.test(type) || end > src.length) fail();
    if (!PNG_DROP.has(type)) out.push(src.subarray(i, end));
    i = end;
    if (type === 'IEND') return Buffer.concat(out);
  }
}

/** WebP: drop the EXIF and XMP chunks and clear their flags in the VP8X header; recompute the RIFF size. */
function webp(src: Buffer): Buffer {
  if (src.length < 20 || src.subarray(0, 4).toString('latin1') !== 'RIFF' || src.subarray(8, 12).toString('latin1') !== 'WEBP') fail();
  const declared = src.readUInt32LE(4) + 8;
  if (declared > src.length || declared < 20) fail();
  const chunks: Buffer[] = [];
  let i = 12;
  while (i < declared) {
    if (i + 8 > declared) fail();
    const type = src.subarray(i, i + 4).toString('latin1');
    const size = src.readUInt32LE(i + 4);
    const end = i + 8 + size + (size % 2);
    if (end > declared) fail();
    if (type === 'VP8X') {
      if (size < 10) fail();
      const chunk = Buffer.from(src.subarray(i, end));
      chunk[8] = chunk[8]! & ~0x0c; // clear the EXIF (0x08) and XMP (0x04) flags
      chunks.push(chunk);
    } else if (type !== 'EXIF' && type !== 'XMP ') chunks.push(src.subarray(i, end));
    i = end;
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(body.length + 4, 4); header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}

export function stripPhotoMetadata(contentType: 'image/jpeg' | 'image/png' | 'image/webp', bytes: Buffer): Buffer {
  switch (contentType) {
    case 'image/jpeg': return jpeg(bytes);
    case 'image/png': return png(bytes);
    case 'image/webp': return webp(bytes);
    default: return fail();
  }
}
