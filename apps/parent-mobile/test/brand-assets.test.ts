import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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
