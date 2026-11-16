/**
 * Camera code reading for browsers without BarcodeDetector (Safari, iPad). It reads one video frame at a time on the
 * device with the open-source ZXing decoder (Apache-2.0, pinned). It is loaded only when needed, and makes no network calls.
 * It reads only the two formats cards print: QR and Code128.
 */
export type FrameDetector = { detect(source: CanvasImageSource): Promise<readonly { rawValue: string }[]> };

type Zxing = typeof import('@zxing/library');
type Reader = InstanceType<Zxing['MultiFormatReader']>;

/** Builds a reader limited to the card formats. */
export function cardCodeReader(z: Zxing): Reader {
  const hints = new Map<unknown, unknown>([
    [z.DecodeHintType.POSSIBLE_FORMATS, [z.BarcodeFormat.QR_CODE, z.BarcodeFormat.CODE_128]],
    [z.DecodeHintType.TRY_HARDER, true],
  ]);
  const reader = new z.MultiFormatReader();
  reader.setHints(hints as Map<never, never>);
  return reader;
}

/** Reads one RGBA frame. Returns the text of the first card code found, or null. */
export function decodeCardFrame(z: Zxing, reader: Reader, rgba: Uint8ClampedArray, width: number, height: number): string | null {
  if (width <= 0 || height <= 0 || rgba.length < width * height * 4) return null;
  const luminance = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < luminance.length; i += 1, p += 4) luminance[i] = (rgba[p]! * 299 + rgba[p + 1]! * 587 + rgba[p + 2]! * 114) / 1000;
  try {
    const bitmap = new z.BinaryBitmap(new z.HybridBinarizer(new z.RGBLuminanceSource(luminance, width, height)));
    return reader.decodeWithState(bitmap).getText();
  } catch { return null; } finally { reader.reset(); }
}

const MAX_SIDE = 960;

/** A BarcodeDetector-shaped reader that works from a <video> element through a canvas. */
export async function openFallbackDetector(): Promise<FrameDetector | null> {
  if (typeof document === 'undefined') return null;
  const z = await import('@zxing/library');
  const reader = cardCodeReader(z);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  return {
    async detect(source) {
      const video = source as HTMLVideoElement;
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) return [];
      const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
      canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = context.getImageData(0, 0, canvas.width, canvas.height);
      const text = decodeCardFrame(z, reader, frame.data, frame.width, frame.height);
      return text ? [{ rawValue: text }] : [];
    },
  };
}
