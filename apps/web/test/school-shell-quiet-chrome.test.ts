import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Unslop pass (2026-11-28): the school menu and header stay quiet so the AI team and HON carry the colour.
const css = readFileSync(join(__dirname, '../src/components/school-shell/shell.module.css'), 'utf8');
const rule = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
};

it('uses sentence case labels, never uppercase tracked ones', () => {
  expect(css).not.toMatch(/text-transform:\s*uppercase/);
  for (const selector of ['.eyebrow', '.navHeading', '.menuSection h2', '.searchResults h2']) expect(rule(selector)).not.toMatch(/letter-spacing/);
});

it('draws the chrome without hue gradients or coloured glows', () => {
  expect(css).not.toMatch(/linear-gradient/);
  for (const selector of ['.shell', '.rail', '.askHon', '.honOrb', '.honLauncher', ".nav a[aria-current='page']"]) {
    expect(rule(selector), selector).not.toMatch(/radial-gradient\([^)]*rgba\(47, 123, 255|box-shadow:\s*0 0 \d+px|0 6px 22px rgba\(36, 110, 255/);
  }
  expect(rule('.shell')).not.toMatch(/gradient/);
  expect(rule('.menuIcon')).not.toMatch(/gradient/);
  expect(rule('.searchIcon')).not.toMatch(/gradient/);
});

it('marks the current page with a surface step, not a gradient pill', () => {
  const active = rule(".nav a[aria-current='page']");
  expect(active).toContain('background: var(--hon-surface-2)');
  expect(active).toContain('inset 0 1px 0');
});
