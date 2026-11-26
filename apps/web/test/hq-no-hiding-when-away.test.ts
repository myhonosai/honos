import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Owner 2026-11-26 ("Hq do not need hidden", "no screensaver or hideaway" in HQ): HQ pages stay on screen when the
 * tab or window loses focus, goes to the background or is put away. Only a session end (or a school change) hides
 * HQ facts. This guards every HQ page component against the old blur / hidden-tab / page-hide concealment returning.
 */
const root = 'src/components';
const hqDirs = readdirSync(root).filter(name => name.startsWith('hq-') && statSync(join(root, name)).isDirectory());
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
});
// The HQ plan editor (hq-modern/pricing-offers) is being rebuilt in its own change and drops this there.
const pending = new Set([join(root, 'hq-modern/pricing-offers.tsx')]);
const hqFiles = [
  ...hqDirs.flatMap(dir => files(join(root, dir))),
  ...readdirSync(root).filter(name => /^hq-.*\.(ts|tsx)$/.test(name)).map(name => join(root, name)),
  join(root, 'school-ownership/hq-school-ownership.tsx'),
  join(root, 'zernio-integration/workbench.tsx'),
].filter(path => !pending.has(path));

describe('HQ pages do not hide when the person looks away', () => {
  it('covers the HQ pages that used to hide', () => {
    for (const path of ['hq-support/model.ts', 'hq-contests/model.ts', 'hq-access/hq-access.tsx', 'hq-school-directory-controller.ts', 'hq-onboarding-controller.ts', 'hq-creative-credits/hq-creative-credits.tsx'])
      expect(hqFiles).toContain(join(root, path));
  });
  it.each(hqFiles)('%s listens for no blur, hidden-tab or page-hide signal', path => {
    const source = readFileSync(path, 'utf8');
    expect(source).not.toMatch(/addEventListener\(\s*'blur'/);
    expect(source).not.toMatch(/addEventListener\(\s*'pagehide'/);
    expect(source).not.toMatch(/\[\s*'blur'|'blur',\s*'pagehide'/);
    // A visibility listener may only restore (re-read) after a session or school change, never hide.
    expect(source).not.toMatch(/visibilityState\s*(===\s*'hidden'|!==\s*'visible')/);
  });
  it('session end still hides HQ support, contests and access', () => {
    for (const path of ['hq-support/model.ts', 'hq-contests/model.ts', 'hq-access/hq-access.tsx'])
      expect(readFileSync(join(root, path), 'utf8')).toContain('addEventListener(HON_SESSION_INVALIDATED_EVENT');
  });
});
