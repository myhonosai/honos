import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Unslop pass (2026-11-28): on Home the HON orb and the team portraits carry the colour; the chrome around them stays quiet.
const css = readFileSync(join(__dirname, '../src/components/home/home.module.css'), 'utf8');
const rule = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
};

it('has no gradient text, hue gradients, coloured glows or uppercase labels', () => {
  expect(css).not.toMatch(/background-clip:\s*text/);
  expect(css).not.toMatch(/linear-gradient|radial-gradient/);
  expect(css).not.toMatch(/box-shadow:\s*0 0 \d+px/);
  expect(css).not.toMatch(/text-transform:\s*uppercase/);
  expect(css).not.toMatch(/font-weight:\s*(800|900)/);
});

it('gives each bar chart one accent, on its first row only', () => {
  expect(rule('.track span')).toContain('background: var(--hon-text-subtle)');
  expect(rule('.bars > div:first-child .track span')).toContain('background: var(--hon-accent)');
});

it('keeps area tiles neutral instead of rainbow', () => {
  expect(rule('.areaIcon')).toContain('background: var(--hon-surface-2)');
  expect(css).not.toMatch(/\.areas li:nth-child/);
});
