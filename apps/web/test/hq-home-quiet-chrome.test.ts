import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Unslop pass (2026-11-28): the last rules in the HQ stylesheet win, so the quiet ink block must stay at the end.
const css = readFileSync(join(__dirname, '../src/components/hq-modern/hq-modern.module.css'), 'utf8');
const tail = css.slice(css.indexOf('/* Unslop pass'));

it('keeps the unslop block as the last word on HQ cards, labels and the headline', () => {
  expect(tail.length).toBeGreaterThan(0);
  for (const selector of ['.panel,.performanceTile,.commandBar{', '.stageExecutive{', '.assistantPanel{', '.appearance{']) {
    expect(tail, selector).toContain(selector);
    const rule = tail.slice(tail.indexOf(selector), tail.indexOf('}', tail.indexOf(selector)));
    expect(rule, selector).toContain('backdrop-filter:none');
    expect(rule, selector).not.toMatch(/gradient/);
  }
  expect(tail).toContain('.topbar h1{font-weight:600;letter-spacing:-.02em;text-shadow:none}');
  expect(tail).toMatch(/\.eyebrow,\.topbar \.eyebrow\{[^}]*text-transform:none/);
});
