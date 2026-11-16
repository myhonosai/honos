/**
 * In-repo encoders for attendance card codes (0394), with no extra dependency and no network.
 *
 * Both encoders take the 26-digit card code. Code 128 uses code set C (two digits per symbol). QR uses version 1 with
 * error correction level M in numeric mode, which holds up to 34 digits: room to spare for 26. Either kind is read by the
 * same scanner, which simply types the digits.
 */

/** Code 128 bar and space widths (in modules) for values 0..105, then the stop symbol. */
const CODE128 = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 '
  + '223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 '
  + '132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 '
  + '312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 '
  + '241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 '
  + '411311 113141 114131 311141 411131 211412 211214 211232 2331112').split(' ');
const START_C = 105, STOP = 106;

/** The alternating bar/space widths of a Code 128 set C symbol for an even number of digits (bars first). */
export function code128cWidths(digits: string): number[] {
  if (!/^(?:\d\d)+$/.test(digits)) throw new Error('CODE128C_DIGITS');
  const values = [START_C];
  for (let i = 0; i < digits.length; i += 2) values.push(Number(digits.slice(i, i + 2)));
  values.push(values.reduce((sum, v, i) => sum + v * Math.max(i, 1), 0) % 103);
  values.push(STOP);
  return values.flatMap(v => [...CODE128[v]!].map(Number));
}

/** A Code 128 barcode as one SVG path (dark bars) with a 10-module quiet zone on each side. */
export function code128Svg(digits: string, height = 40): Readonly<{ width: number; height: number; path: string }> {
  const widths = code128cWidths(digits);
  let x = 10, path = '';
  widths.forEach((w, i) => { if (i % 2 === 0) path += `M${x} 0h${w}v${height}h-${w}z`; x += w; });
  return { width: x + 10, height, path };
}

// ---- QR version 1-M, numeric mode -------------------------------------------------------------------------------------
const SIZE = 21, DATA_CODEWORDS = 16, EC_CODEWORDS = 10;
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z & 0xff;
}
function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0); result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) { result[j] = gfMul(result[j]!, root); if (j + 1 < degree) result[j]! ^= result[j + 1]!; }
    root = gfMul(root, 2);
  }
  return result;
}
/** Reed-Solomon error correction codewords for the data codewords. */
export function reedSolomon(data: readonly number[], degree = EC_CODEWORDS): number[] {
  const divisor = rsDivisor(degree), result = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!; result.push(0);
    divisor.forEach((d, i) => { result[i]! ^= gfMul(d, factor); });
  }
  return result;
}
/** The 16 data codewords of a version 1-M numeric symbol. */
export function qrNumericCodewords(digits: string): number[] {
  if (!/^\d{1,34}$/.test(digits)) throw new Error('QR_DIGITS');
  const bits: number[] = [];
  const put = (value: number, length: number) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0001, 4); put(digits.length, 10);
  for (let i = 0; i < digits.length; i += 3) { const group = digits.slice(i, i + 3); put(Number(group), group.length * 3 + 1); }
  const capacity = DATA_CODEWORDS * 8;
  put(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; out.length < DATA_CODEWORDS; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

type Grid = boolean[][];
const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0, (_x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
];
function functionPatterns(): { modules: Grid; fixed: Grid } {
  const modules: Grid = Array.from({ length: SIZE }, () => new Array<boolean>(SIZE).fill(false));
  const fixed: Grid = Array.from({ length: SIZE }, () => new Array<boolean>(SIZE).fill(false));
  const set = (x: number, y: number, dark: boolean) => { modules[y]![x] = dark; fixed[y]![x] = true; };
  for (let i = 0; i < SIZE; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [SIZE - 4, 3], [3, SIZE - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, dist = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) set(x, y, dist !== 2 && dist !== 4);
    }
  }
  drawFormat(set, 0); // reserve the format areas; redrawn with the chosen mask
  return { modules, fixed };
}
function drawFormat(set: (x: number, y: number, dark: boolean) => void, mask: number): void {
  const data = (0b00 << 3) | mask; // error correction level M
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412, bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(SIZE - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, SIZE - 15 + i, bit(i));
  set(8, SIZE - 8, true);
}
function penalty(m: Grid): number {
  let score = 0;
  for (const line of [...m, ...m[0]!.map((_, x) => m.map(row => row[x]!))]) {
    let run = 1;
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && line[i] === line[i - 1]) run++;
      else { if (run >= 5) score += run - 2; run = 1; }
    }
  }
  for (let y = 0; y < SIZE - 1; y++) for (let x = 0; x < SIZE - 1; x++) {
    const c = m[y]![x]; if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) score += 3;
  }
  const dark = m.flat().filter(Boolean).length;
  return score + Math.floor(Math.abs(dark * 20 - SIZE * SIZE * 10) / (SIZE * SIZE)) * 10;
}
/** The 21 × 21 QR module grid (true = dark) for up to 34 digits. */
export function qrMatrix(digits: string): Grid {
  const data = qrNumericCodewords(digits), all = [...data, ...reedSolomon(data)];
  const { modules, fixed } = functionPatterns();
  let i = 0;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < SIZE; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? SIZE - 1 - vert : vert;
      if (!fixed[y]![x] && i < all.length * 8) { modules[y]![x] = ((all[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1; i++; }
    }
  }
  let best: Grid | null = null, bestScore = Infinity;
  MASKS.forEach((mask, n) => {
    const m = modules.map((row, y) => row.map((dark, x) => fixed[y]![x] ? dark : dark !== mask(x, y)));
    drawFormat((x, y, dark) => { m[y]![x] = dark; }, n);
    const s = penalty(m); if (s < bestScore) { bestScore = s; best = m; }
  });
  return best!;
}
/** A QR code as one SVG path (dark modules) with a 4-module quiet zone; the viewBox is 29 × 29. */
export function qrSvg(digits: string): Readonly<{ size: number; path: string }> {
  const m = qrMatrix(digits);
  let path = '';
  m.forEach((row, y) => row.forEach((dark, x) => { if (dark) path += `M${x + 4} ${y + 4}h1v1h-1z`; }));
  return { size: SIZE + 8, path };
}
