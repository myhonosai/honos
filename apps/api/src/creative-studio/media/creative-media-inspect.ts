import type { CreativeAssetMediaType, SaasCreativeMediaKind } from '@hon/contracts';

/**
 * C3: what a stored file really is, read from its bytes (never from the provider's claim or a file name), with metadata
 * removed. Only PNG and WebP still images and MP4 video are accepted; anything else, or anything malformed, is refused.
 *
 * - PNG: only image-critical chunks are kept (text, EXIF, time and every other ancillary chunk is dropped).
 * - WebP: single-frame only; EXIF and XMP chunks are dropped and their flags cleared.
 * - MP4: `udta` and `meta` boxes are overwritten in place as `free` boxes of the same size, so no sample offset moves.
 */
export interface InspectedCreativeMedia {
  mediaType: CreativeAssetMediaType; width: number; height: number; durationSeconds: number | null; bytes: Buffer;
}
export class CreativeMediaRejected extends Error { constructor(readonly why: string) { super(`creative media rejected: ${why}`); } }
const reject = (why: string): never => { throw new CreativeMediaRejected(why); };
const MAX_SIDE = 8192;

export function inspectCreativeMedia(input: Buffer, kind: SaasCreativeMediaKind): InspectedCreativeMedia {
  if (!Buffer.isBuffer(input) || input.length < 16) reject('too small');
  if (kind === 'IMAGE') {
    if (input.subarray(0, 8).equals(PNG_SIGNATURE)) return png(input);
    if (input.toString('latin1', 0, 4) === 'RIFF' && input.toString('latin1', 8, 12) === 'WEBP') return webp(input);
    return reject('not a PNG or WebP image');
  }
  if (kind === 'VIDEO') return mp4(input);
  return reject('unsupported media kind');
}

const side = (n: number) => Number.isSafeInteger(n) && n >= 1 && n <= MAX_SIDE;

// ---------- PNG ----------
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs', 'bKGD']);
function png(b: Buffer): InspectedCreativeMedia {
  const kept: Buffer[] = [PNG_SIGNATURE];
  let at = 8, first = true, ended = false, width = 0, height = 0, idat = false;
  while (at < b.length) {
    if (at + 12 > b.length) reject('truncated PNG chunk');
    const length = b.readUInt32BE(at), type = b.toString('latin1', at + 4, at + 8), end = at + 12 + length;
    if (length > 0x7fffffff || end > b.length || !/^[A-Za-z]{4}$/.test(type)) reject('malformed PNG chunk');
    if (first) {
      if (type !== 'IHDR' || length !== 13) reject('PNG must start with IHDR');
      width = b.readUInt32BE(at + 8); height = b.readUInt32BE(at + 12); first = false;
    }
    if (type === 'IDAT') idat = true;
    if (PNG_KEEP.has(type)) kept.push(b.subarray(at, end));
    at = end;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended || !idat || at !== b.length) reject('PNG must end with IEND after image data');
  if (!side(width) || !side(height)) reject('PNG dimensions out of range');
  return { mediaType: 'image/png', width, height, durationSeconds: null, bytes: Buffer.concat(kept) };
}

// ---------- WebP ----------
function webp(b: Buffer): InspectedCreativeMedia {
  if (b.readUInt32LE(4) + 8 !== b.length) reject('WebP size mismatch');
  const chunks: { type: string; data: Buffer; raw: Buffer }[] = [];
  let at = 12;
  while (at < b.length) {
    if (at + 8 > b.length) reject('truncated WebP chunk');
    const type = b.toString('latin1', at, at + 4), size = b.readUInt32LE(at + 4), end = at + 8 + size + (size % 2);
    if (end > b.length) reject('malformed WebP chunk');
    chunks.push({ type, data: b.subarray(at + 8, at + 8 + size), raw: b.subarray(at, end) });
    at = end;
  }
  if (!chunks.length) reject('empty WebP');
  if (chunks.some(c => c.type === 'ANIM' || c.type === 'ANMF')) reject('animated WebP is not accepted');
  let width = 0, height = 0;
  const frame = chunks.find(c => c.type === 'VP8 ' || c.type === 'VP8L');
  if (!frame) reject('WebP without image data');
  const f = frame!.data;
  if (frame!.type === 'VP8 ') {
    if (f.length < 10 || f[3] !== 0x9d || f[4] !== 0x01 || f[5] !== 0x2a) reject('malformed VP8 frame');
    width = f.readUInt16LE(6) & 0x3fff; height = f.readUInt16LE(8) & 0x3fff;
  } else {
    if (f.length < 5 || f[0] !== 0x2f) reject('malformed VP8L frame');
    const bits = f.readUInt32LE(1);
    width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
  }
  const out: Buffer[] = [];
  for (const c of chunks) {
    if (c.type === 'EXIF' || c.type === 'XMP ') continue;
    if (c.type === 'VP8X') {
      if (c.data.length < 10) reject('malformed VP8X');
      const copy = Buffer.from(c.raw);
      copy[8] = copy[8]! & ~0x0c; // clear the EXIF (0x08) and XMP (0x04) flags
      const cw = c.data.readUIntLE(4, 3) + 1, ch = c.data.readUIntLE(7, 3) + 1;
      if (cw !== width || ch !== height) reject('WebP canvas and frame sizes differ');
      out.push(copy); continue;
    }
    out.push(c.raw);
  }
  if (!side(width) || !side(height)) reject('WebP dimensions out of range');
  const body = Buffer.concat(out), header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(body.length + 4, 4); header.write('WEBP', 8, 'latin1');
  return { mediaType: 'image/webp', width, height, durationSeconds: null, bytes: Buffer.concat([header, body]) };
}

// ---------- MP4 ----------
interface Box { type: string; start: number; content: number; end: number }
function boxes(b: Buffer, from: number, to: number): Box[] {
  const list: Box[] = [];
  let at = from;
  while (at < to) {
    if (at + 8 > to) reject('truncated MP4 box');
    let size = b.readUInt32BE(at), content = at + 8;
    const type = b.toString('latin1', at + 4, at + 8);
    if (size === 1) {
      if (at + 16 > to) reject('truncated MP4 box');
      const big = b.readBigUInt64BE(at + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) reject('MP4 box too large');
      size = Number(big); content = at + 16;
    } else if (size === 0) size = to - at;
    if (size < content - at || at + size > to || !/^[\x20-\x7e]{4}$/.test(type)) reject('malformed MP4 box');
    list.push({ type, start: at, content, end: at + size });
    at += size;
  }
  return list;
}
const child = (b: Buffer, parent: Box, type: string) => boxes(b, parent.content, parent.end).filter(x => x.type === type);
function mp4(input: Buffer): InspectedCreativeMedia {
  const b = Buffer.from(input);
  const top = boxes(b, 0, b.length);
  if (top[0]?.type !== 'ftyp') reject('not an MP4 file');
  const moovs = top.filter(x => x.type === 'moov');
  if (moovs.length !== 1 || !top.some(x => x.type === 'mdat')) reject('MP4 needs one moov and media data');
  const moov = moovs[0]!;
  const mvhd = child(b, moov, 'mvhd')[0] ?? reject('MP4 without mvhd');
  const v = b[mvhd.content];
  const timescale = v === 1 ? b.readUInt32BE(mvhd.content + 20) : b.readUInt32BE(mvhd.content + 12);
  const duration = v === 1 ? Number(b.readBigUInt64BE(mvhd.content + 24)) : b.readUInt32BE(mvhd.content + 16);
  if (!timescale || !Number.isFinite(duration) || duration <= 0) reject('MP4 duration unknown');
  const seconds = duration / timescale;
  if (!(seconds > 0) || seconds > 600) reject('MP4 duration out of range');
  let width = 0, height = 0;
  for (const trak of child(b, moov, 'trak')) {
    const mdia = child(b, trak, 'mdia')[0]; const hdlr = mdia ? child(b, mdia, 'hdlr')[0] : undefined;
    if (!hdlr || b.toString('latin1', hdlr.content + 8, hdlr.content + 12) !== 'vide') continue;
    const tkhd = child(b, trak, 'tkhd')[0] ?? reject('video track without tkhd');
    const at = b[tkhd.content] === 1 ? tkhd.content + 88 : tkhd.content + 76;
    if (at + 8 > tkhd.end) reject('malformed tkhd');
    width = b.readUInt32BE(at) >>> 16; height = b.readUInt32BE(at + 4) >>> 16;
    break;
  }
  if (!side(width) || !side(height)) reject('MP4 without a video track of valid size');
  // Metadata boxes become free space of the same size (no offsets move).
  const blank = (x: Box) => { b.write('free', x.start + 4, 'latin1'); b.fill(0, x.content, x.end); };
  for (const x of top) if (x.type === 'udta' || x.type === 'meta') blank(x);
  for (const x of boxes(b, moov.content, moov.end)) {
    if (x.type === 'udta' || x.type === 'meta') blank(x);
    if (x.type === 'trak') for (const y of boxes(b, x.content, x.end)) if (y.type === 'udta' || y.type === 'meta') blank(y);
  }
  return { mediaType: 'video/mp4', width, height, durationSeconds: Math.ceil(seconds), bytes: b };
}
