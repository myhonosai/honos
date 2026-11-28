import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(join(__dirname, '..', 'src', 'components', rel), 'utf8');
// Pictographic emoji plus the symbol glyphs these screens used as icons.
const EMOJI = /[\p{Extended_Pictographic}★♥]/u;

describe('automations and custom tools use line icons, not emoji', () => {
  for (const file of ['automations/view.tsx', 'custom-tools/tools-home.tsx']) {
    it(`${file} has no emoji`, () => {
      const hit = read(file).split('\n').findIndex(line => EMOJI.test(line));
      expect(hit, `emoji on line ${hit + 1}`).toBe(-1);
      expect(read(file)).toContain("from '../school-shell/icons'");
    });
  }

  it('icon tiles take a neutral surface instead of a coloured wash', () => {
    const automations = read('automations/automations.module.css');
    const tools = read('custom-tools/custom-tools.module.css');
    expect(/\.nodeIcon \{[^}]*background: var\(--hon-surface-2/.test(automations)).toBe(true);
    expect(/\.icon \{[^}]*background: var\(--hon-surface-2[^}]*color: var\(--hon-text-muted/.test(tools)).toBe(true);
    expect(/\.icon \{[^}]*#123047/.test(tools)).toBe(false);
  });
});
