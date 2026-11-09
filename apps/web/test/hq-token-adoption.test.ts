import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const css = (name: string) => readFileSync(new URL(`../src/components/hq-modern/${name}`, import.meta.url), 'utf8');

it('U9: HQ uses the shared HON token names with its own values, and no private HQ colour names remain', () => {
  const shell = css('hq-modern.module.css');
  expect(shell).toMatch(/\.shell\{--hon-bg:#080f1c;--hon-surface-solid:#101c2d;--hon-border:#253b54;--hon-text:#f2f6ff;--hon-text-muted:#b0c2db;--hon-accent-2:#36d6ff;/);
  for (const name of ['hq-modern.module.css', 'invoice-history.module.css']) expect(css(name)).not.toMatch(/--hq-(bg|panel|line|text|muted|cyan)\b/);
  // Every shared name HQ reads is one tokens.css defines.
  const tokens = readFileSync(new URL('../../../packages/design-system/src/tokens.css', import.meta.url), 'utf8');
  for (const used of new Set(shell.match(/var\(--hon-[a-z0-9-]+/g)?.map((v) => v.slice(4)) ?? [])) expect(tokens).toContain(`${used}:`);
});
