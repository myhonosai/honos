import { CREATIVE_DESIGN_LIMITS, type CreativeDesignPhotoType } from '@hon/contracts';

/**
 * Photos for the design editor (D1, 0617). A picked file is drawn onto a canvas (which drops its camera and location
 * metadata in the browser too; the API strips it again) and shrunk until it fits the school's 1.4 MB per-photo limit.
 * Stored photos come back as base64 and are decoded with createImageBitmap, so no data: or blob: image URL is needed.
 */
export const PHOTO_MAX_SIDE = 2400;
const ATTEMPTS: readonly (readonly [number, number])[] = [[1, 0.9], [1, 0.8], [0.8, 0.8], [0.65, 0.75], [0.5, 0.7], [0.35, 0.65], [0.25, 0.6]];

/** The size to draw a w×h picture at so its long side is at most `max`, never enlarged. */
export function fitWithin(w: number, h: number, max = PHOTO_MAX_SIDE): { w: number; h: number } {
  if (!(w > 0) || !(h > 0)) return { w: 0, h: 0 };
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** PNG keeps transparency (logos); everything else becomes JPEG. */
export function outputType(fileType: string): CreativeDesignPhotoType { return fileType === 'image/png' ? 'image/png' : 'image/jpeg'; }

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data), out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export type PreparedPhoto = { mediaType: CreativeDesignPhotoType; data: string; width: number; height: number };
type Encoder = (source: ImageBitmap, w: number, h: number, type: CreativeDesignPhotoType, quality: number) => Promise<Blob | null>;

function canvasEncoder(source: ImageBitmap, w: number, h: number, type: CreativeDesignPhotoType, quality: number): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  if (type === 'image/jpeg') { ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, w, h); }
  ctx.drawImage(source, 0, 0, w, h);
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

/** Shrinks and re-encodes the picture until it fits the limit; a PNG that will not fit falls back to JPEG. Null if it cannot. */
export async function preparePhoto(source: ImageBitmap, fileType: string, encode: Encoder = canvasEncoder, limit = CREATIVE_DESIGN_LIMITS.photoBytes): Promise<PreparedPhoto | null> {
  const base = fitWithin(source.width, source.height);
  if (!base.w) return null;
  const types: CreativeDesignPhotoType[] = outputType(fileType) === 'image/png' ? ['image/png', 'image/jpeg'] : ['image/jpeg'];
  for (const type of types) {
    for (const [scale, quality] of type === 'image/png' ? ATTEMPTS.slice(0, 4) : ATTEMPTS) {
      const w = Math.max(1, Math.round(base.w * scale)), h = Math.max(1, Math.round(base.h * scale));
      const blob = await encode(source, w, h, type, quality);
      if (!blob || blob.size < 1 || blob.size > limit) continue;
      return { mediaType: type, data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())), width: w, height: h };
    }
  }
  return null;
}

/** Decodes a stored photo for painting. */
export function decodePhoto(mediaType: CreativeDesignPhotoType, data: string): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([base64ToBytes(data) as BlobPart], { type: mediaType }));
}
