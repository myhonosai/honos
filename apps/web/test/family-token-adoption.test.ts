import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const css = (name: string) => readFileSync(new URL(`../src/components/${name}`, import.meta.url), 'utf8');
const tokens = readFileSync(new URL('../../../packages/design-system/src/tokens.css', import.meta.url), 'utf8');

it('U8-2: family home and journey read the shared HON token names, mapped to the family theme values', () => {
  for (const name of ['parent-home.module.css', 'parent-journey.module.css']) {
    const sheet = css(name);
    // The aliases point at the legacy family variables, so every family theme (and .theme-classic) keeps its colours.
    expect(sheet).toMatch(/^\.page \{ --hon-bg: var\(--surface\); --hon-surface-solid: var\(--paper\); --hon-border: var\(--line\); --hon-text: var\(--text\); --hon-text-muted: var\(--muted\); --hon-accent: var\(--teal\); --hon-info-soft: var\(--teal-soft\); --hon-danger: var\(--coral\);/);
    // Outside that one alias line no rule reads a legacy colour name.
    const body = sheet.slice(sheet.indexOf('\n'));
    expect(body).not.toMatch(/var\(--(surface|paper|line|text|muted|teal|teal-soft|coral)\)/);
    // Every shared name read is one tokens.css defines.
    for (const used of new Set(sheet.match(/var\(--hon-[a-z0-9-]+/g)?.map((v) => v.slice(4)) ?? [])) expect(tokens).toContain(`${used}:`);
  }
});
