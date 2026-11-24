import { QRCodeDecoderErrorCorrectionLevel, QRCodeEncoder } from '@zxing/library';
import { creativeDesignQrDataOk } from '@hon/contracts';

/**
 * QR modules for a design's QR element (D2), encoded in the browser with the encoder the app already ships (walk-in
 * cards). Error correction M; the caller adds the 4-module quiet zone. Results are cached by text, since painting runs
 * on every drag frame.
 */
const cache = new Map<string, readonly boolean[][]>();

export function qrModules(data: string): readonly boolean[][] | null {
  if (!creativeDesignQrDataOk(data)) return null;
  const hit = cache.get(data);
  if (hit) return hit;
  let rows: boolean[][];
  try {
    const matrix = QRCodeEncoder.encode(data, QRCodeDecoderErrorCorrectionLevel.M).getMatrix();
    rows = Array.from({ length: matrix.getHeight() }, (_, y) => Array.from({ length: matrix.getWidth() }, (_, x) => matrix.get(x, y) === 1));
  } catch { return null; }
  if (cache.size > 50) cache.delete(cache.keys().next().value!);
  cache.set(data, rows);
  return rows;
}

/** Quiet zone, in modules, on each side (the QR standard asks for 4). */
export const QR_QUIET = 4;
