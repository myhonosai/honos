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
