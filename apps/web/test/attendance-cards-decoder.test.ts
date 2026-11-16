import * as z from '@zxing/library';
import { expect, it } from 'vitest';
import { attendanceCardCheckDigits } from '@hon/contracts';
import { code128cWidths, qrMatrix } from '../src/components/attendance-cards/codes';
import { cardCodeReader, decodeCardFrame } from '../src/components/attendance-cards/camera-decoder';

/** Synthetic camera frames: our printed codes drawn into an RGBA buffer, on a white page at several scales and offsets. */
const body = '583920174650283917465029', CODE = body + attendanceCardCheckDigits(body);
function frame(width: number, height: number, paint: (set: (x: number, y: number) => void) => void) {
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  paint((x, y) => { if (x < 0 || y < 0 || x >= width || y >= height) return; const p = (y * width + x) * 4; rgba[p] = 20; rgba[p + 1] = 20; rgba[p + 2] = 30; });
  return rgba;
}
const qrFrame = (module: number, ox: number, oy: number, w = 400, h = 300) => frame(w, h, set => {
  qrMatrix(CODE).forEach((row, y) => row.forEach((dark, x) => {
    if (dark) for (let dy = 0; dy < module; dy++) for (let dx = 0; dx < module; dx++) set(ox + x * module + dx, oy + y * module + dy);
  }));
});
const barFrame = (unit: number, w = 600, h = 160) => frame(w, h, set => {
  let x = 10 * unit; let bar = true;
  for (const width of code128cWidths(CODE)) {
    if (bar) for (let dx = 0; dx < width * unit; dx++) for (let y = 30; y < h - 30; y++) set(x + dx, y);
    x += width * unit; bar = !bar;
  }
});

it('reads a printed QR card code from a frame at several sizes and positions', () => {
  const reader = cardCodeReader(z);
  for (const [m, ox, oy] of [[4, 40, 30], [6, 150, 60], [9, 100, 40]] as const) expect(decodeCardFrame(z, reader, qrFrame(m, ox, oy), 400, 300)).toBe(CODE);
});

it('reads a printed Code128 card code from a frame', () => {
  const reader = cardCodeReader(z);
  for (const unit of [2, 3]) expect(decodeCardFrame(z, reader, barFrame(unit), 600, 160)).toBe(CODE);
});

it('returns null for a blank or broken frame and keeps working after a miss', () => {
  const reader = cardCodeReader(z);
  expect(decodeCardFrame(z, reader, frame(200, 200, () => {}), 200, 200)).toBeNull();
  expect(decodeCardFrame(z, reader, new Uint8ClampedArray(10), 200, 200)).toBeNull();
  expect(decodeCardFrame(z, reader, qrFrame(5, 60, 40), 400, 300)).toBe(CODE);
});
