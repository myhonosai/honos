import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '../../../packages/design-system/src/tokens.css'), 'utf8');
const block = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
};

it('defines the base token groups on [data-hon-ui] only, never on :root or body', () => {
  const base = block('[data-hon-ui]');
  for (const token of ['--hon-bg', '--hon-surface', '--hon-border', '--hon-text', '--hon-text-muted', '--hon-accent', '--hon-accent-2',
    '--hon-success', '--hon-warning', '--hon-danger', '--hon-info', '--hon-focus', '--hon-font-sans', '--hon-font-display',
    '--hon-space-4', '--hon-radius-md', '--hon-control-h', '--hon-row-h', '--hon-rail-w', '--hon-dur']) expect(base).toContain(`${token}:`);
  expect(css).not.toMatch(/(^|\n)\s*(:root|body|html)\s*[{,]/);
});

it('gives Classic denser and Big Button larger controls than Modern', () => {
  const px = (selector: string, token: string) => Number(new RegExp(`${token}:\\s*(\\d+)px`).exec(block(selector))![1]);
  const modern = px('[data-hon-ui]', '--hon-control-h');
  expect(px("[data-hon-ui][data-hon-mode='classic']", '--hon-control-h')).toBeLessThan(modern);
  expect(px("[data-hon-ui][data-hon-mode='big-button']", '--hon-control-h')).toBeGreaterThanOrEqual(48);
});

it('removes motion for reduced-motion users', () => {
  expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*{\s*\[data-hon-ui\] { --hon-dur: 0ms; }/);
});

// Unslop pass (2026-11-28): the chrome stays quiet so the AI team portraits and the HON orb carry the colour.
it('keeps surfaces solid ink with neutral hairlines and no coloured glow', () => {
  const base = block('[data-hon-ui]');
  const value = (token: string) => (new RegExp(`${token}:\\s*([^;]+);`).exec(base)?.[1] ?? '').trim();
  for (const token of ['--hon-bg', '--hon-bg-raised', '--hon-rail', '--hon-surface', '--hon-surface-solid', '--hon-surface-2']) {
    const hex = value(token);
    expect(hex, token).toMatch(/^#[0-9a-f]{6}$/i);
    const [r = 0, , b = 0] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    // Ink, not navy: blue leads red by at most 24, so a surface never reads as a colour on its own.
    expect(b - r, token).toBeLessThanOrEqual(24);
  }
  for (const token of ['--hon-border', '--hon-border-strong']) expect(value(token), token).toMatch(/^rgba\(238, 240, 245, 0\.\d+\)$/);
  // The glow token is a plain hairline: no blur, no coloured spread.
  expect(value('--hon-glow')).toMatch(/^0 0 0 1px rgba\(238, 240, 245, 0\.\d+\)$/);
});
