// This app's tsconfig carries no Node types; Jest runs the test in Node, so declare the two modules used.
declare const require: (id: string) => any;
declare const __dirname: string;
const { readFileSync, existsSync } = require('fs') as { readFileSync: (p: string) => { subarray: (a: number, b: number) => { toString: (e: string) => string }; readUInt32BE: (o: number) => number; [i: number]: number }; existsSync: (p: string) => boolean };
const { join } = require('path') as { join: (...p: string[]) => string };
import appConfig from '../app.json';

// HON Family uses the owner-approved HON OS "spirit orbit" logo (2026-11-19) instead of the Expo placeholder.
const root = join(__dirname, '..');
const png = (rel: string) => {
  const bytes = readFileSync(join(root, rel));
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] };
};

describe('HON Family brand assets', () => {
  const expo = appConfig.expo;
  it('points every icon and splash setting at a file that exists', () => {
    for (const rel of [expo.icon, expo.splash.image, expo.android.adaptiveIcon.foregroundImage,
      expo.android.adaptiveIcon.backgroundImage, expo.android.adaptiveIcon.monochromeImage]) expect(existsSync(join(root, rel))).toBe(true);
  });
  it('ships store-ready sizes: an opaque 1024 app icon, 1024 adaptive layers and splash', () => {
    expect(png(expo.icon)).toEqual({ width: 1024, height: 1024, colorType: 2 }); // RGB, no alpha (App Store rule)
    for (const rel of [expo.android.adaptiveIcon.foregroundImage, expo.android.adaptiveIcon.monochromeImage, expo.splash.image]) {
      expect(png(rel)).toMatchObject({ width: 1024, height: 1024, colorType: 6 }); // RGBA, transparent around the mark
    }
  });
  it('sets the white icon background and keeps the night splash', () => {
    expect(expo.android.adaptiveIcon.backgroundColor).toBe('#FFFFFF');
    expect(expo.splash.backgroundColor).toBe('#050A18');
  });
});

// Android masks the adaptive foreground to a circle of 66/108 of the canvas (about 313px of 1024 from
// the centre). Every drawn pixel of the foreground and themed (monochrome) layers must sit inside it.
const zlib = require('zlib') as { inflateSync: (b: unknown) => { [i: number]: number; length: number } };
const farthestOpaquePixel = (rel: string) => {
  const bytes = readFileSync(join(root, rel));
  const { width, height, colorType } = png(rel);
  expect(colorType).toBe(6);
  const chunks: number[][] = [];
  for (let at = 8; ;) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString('latin1');
    if (type === 'IDAT') { const part: number[] = []; for (let i = 0; i < length; i += 1) part.push(bytes[at + 8 + i] ?? 0); chunks.push(part); }
    if (type === 'IEND') break;
    at += 12 + length;
  }
  const raw = zlib.inflateSync(Uint8Array.from(chunks.flat()));
  const stride = width * 4; let prev = new Array<number>(stride).fill(0); let max = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0; const row = new Array<number>(stride).fill(0);
    for (let i = 0; i < stride; i += 1) {
      const x = raw[y * (stride + 1) + 1 + i] ?? 0; const a = i >= 4 ? row[i - 4] ?? 0 : 0; const b = prev[i] ?? 0; const c = i >= 4 ? prev[i - 4] ?? 0 : 0;
      const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter] ?? 0;
      row[i] = (x + pred) & 255;
    }
    for (let px = 0; px < width; px += 1) if ((row[px * 4 + 3] ?? 0) > 20) max = Math.max(max, Math.hypot(px + 0.5 - width / 2, y + 0.5 - height / 2));
    prev = row;
  }
  return max;
};

describe('HON Family Android adaptive icon', () => {
  it('keeps the whole mark inside the Android safe circle so no launcher mask clips a swoosh', () => {
    for (const rel of [appConfig.expo.android.adaptiveIcon.foregroundImage, appConfig.expo.android.adaptiveIcon.monochromeImage]) {
      expect(farthestOpaquePixel(rel)).toBeLessThanOrEqual(1024 * 33 / 108);
    }
  });
});
