import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { legacyFillTag, legacyInkTag, legacyLineTag, shellRecolorLegacy } from '../src/components/school-shell/legacy-recolor';

// Consistent look C1 (owner 2026-11-19, "lot that is miss match in aesthetics"): older pages written for a light body
// are recoloured onto the dark tokens instead of sitting on a light card inside the dark shell.
describe('legacy page colours map onto the dark tokens', () => {
  it('turns dark text into token text, keeping meaning for coloured text', () => {
    expect(legacyInkTag('rgb(23, 34, 56)')).toBe('text'); // #172238 body text
    expect(legacyInkTag('rgb(82, 97, 123)')).toBe('muted'); // #52617b secondary text
    expect(legacyInkTag('rgb(146, 53, 31)')).toBe('danger'); // #92351f error text
    expect(legacyInkTag('rgb(22, 97, 66)')).toBe('success'); // #166142 saved notice
    expect(legacyInkTag('rgb(99, 72, 25)')).toBe('warning'); // #634819 caution
    expect(legacyInkTag('rgb(29, 79, 196)')).toBe('info'); // #1d4fc4 links
    expect(legacyInkTag('rgb(238, 243, 255)')).toBeNull(); // already light
    expect(legacyInkTag('rgba(0, 0, 0, 0)')).toBeNull();
    expect(legacyInkTag('color(srgb 0 0 0)')).toBeNull();
  });

  it('turns light surfaces into panels or soft status tints, and blue fills into the accent', () => {
    expect(legacyFillTag('rgb(255, 255, 255)')).toBe('panel');
    expect(legacyFillTag('rgb(246, 248, 252)')).toBe('panel'); // #f6f8fc row
    expect(legacyFillTag('rgb(238, 244, 253)')).toBe('info'); // #eef4fd note
    expect(legacyFillTag('rgb(255, 240, 237)')).toBe('danger'); // #fff0ed error box
    expect(legacyFillTag('rgb(234, 248, 241)')).toBe('success'); // #eaf8f1 notice
    expect(legacyFillTag('rgb(255, 247, 230)')).toBe('warning'); // #fff7e6
    expect(legacyFillTag('rgb(36, 90, 196)')).toBe('accent'); // #245ac4 primary button
    expect(legacyFillTag('rgb(8, 17, 42)')).toBeNull(); // already dark
    expect(legacyFillTag('rgba(255, 255, 255, 0.02)')).toBeNull(); // practically transparent
  });

  it('softens light borders only', () => {
    expect(legacyLineTag('rgb(220, 227, 238)', '1px')).toBe('line');
    expect(legacyLineTag('rgb(52, 107, 229)', '4px')).toBeNull(); // a deliberate accent edge stays
    expect(legacyLineTag('rgb(220, 227, 238)', '0px')).toBeNull();
  });
});

type Fake = { tagName: string; style: Record<string, string>; attrs: Map<string, string>; inSvg?: boolean };
const el = (tagName: string, style: Record<string, string>, inSvg = false): Fake => ({ tagName, style, attrs: new Map(), inSvg });
const asElement = (f: Fake) => ({
  tagName: f.tagName.toUpperCase(),
  closest: (s: string) => (s === 'svg' && f.inSvg ? {} : null),
  getAttribute: (k: string) => (k === 'class' ? f.attrs.get('class') ?? f.tagName : null),
  setAttribute: (k: string, v: string) => f.attrs.set(k, v),
  removeAttribute: (k: string) => f.attrs.delete(k),
  _f: f,
});

describe('shellRecolorLegacy', () => {
  it('tags each element from its own colours and clears stale tags, skipping drawings', () => {
    const page = el('main', { color: 'rgb(23, 34, 56)', backgroundColor: 'rgba(0, 0, 0, 0)', borderTopColor: 'rgb(0, 0, 0)', borderTopWidth: '0px' });
    const card = el('section', { color: 'rgb(23, 34, 56)', backgroundColor: 'rgb(255, 255, 255)', borderTopColor: 'rgb(220, 227, 238)', borderTopWidth: '1px' });
    const light = el('p', { color: 'rgb(238, 243, 255)', backgroundColor: 'rgba(0, 0, 0, 0)', borderTopColor: 'rgb(0, 0, 0)', borderTopWidth: '0px' });
    light.attrs.set('data-hon-ink', 'text'); // left over from an earlier state
    const icon = el('path', { color: 'rgb(23, 34, 56)', backgroundColor: 'rgb(255, 255, 255)', borderTopColor: 'rgb(0, 0, 0)', borderTopWidth: '0px' }, true);
    const items = [page, card, light, icon].map(asElement);
    const main = { querySelectorAll: () => items } as unknown as Element;
    vi.stubGlobal('getComputedStyle', (e: { _f: Fake }) => e._f.style);
    shellRecolorLegacy(main);
    vi.unstubAllGlobals();
    expect(Object.fromEntries(page.attrs)).toEqual({ 'data-hon-ink': 'text' });
    expect(Object.fromEntries(card.attrs)).toEqual({ 'data-hon-ink': 'text', 'data-hon-fill': 'panel', 'data-hon-line': 'line' });
    expect(light.attrs.size).toBe(0);
    expect(icon.attrs.size).toBe(0);
  });

  it('stops after the element limit', () => {
    const many = Array.from({ length: 5 }, () => el('p', { color: 'rgb(23, 34, 56)', backgroundColor: 'rgba(0, 0, 0, 0)', borderTopColor: 'rgb(0, 0, 0)', borderTopWidth: '0px' }));
    const main = { querySelectorAll: () => many.map(asElement) } as unknown as Element;
    vi.stubGlobal('getComputedStyle', (e: { _f: Fake }) => e._f.style);
    shellRecolorLegacy(main, 3);
    vi.unstubAllGlobals();
    expect(many.filter(m => m.attrs.size > 0)).toHaveLength(3);
  });

  it('measures an element again only when its class or inline style changes, without its old tags', () => {
    const card = el('section', { color: 'rgb(23, 34, 56)', backgroundColor: 'rgb(255, 255, 255)', borderTopColor: 'rgb(0, 0, 0)', borderTopWidth: '0px' });
    const item = asElement(card), main = { querySelectorAll: () => [item] } as unknown as Element, seen = new WeakMap<Element, string>();
    const reads: Array<string | undefined> = [];
    vi.stubGlobal('getComputedStyle', (e: { _f: Fake }) => { reads.push(e._f.attrs.get('data-hon-fill')); return e._f.style; });
    shellRecolorLegacy(main, 6000, seen);
    shellRecolorLegacy(main, 6000, seen);
    expect(reads).toEqual([undefined]);
    card.attrs.set('class', 'error'); card.style.backgroundColor = 'rgb(255, 240, 237)';
    shellRecolorLegacy(main, 6000, seen);
    vi.unstubAllGlobals();
    expect(reads).toEqual([undefined, undefined]);
    expect(card.attrs.get('data-hon-fill')).toBe('danger');
  });
});

describe('the light card is gone', () => {
  const shellCss = readFileSync('src/components/school-shell/shell.module.css', 'utf8');
  const globalCss = readFileSync('src/components/school-shell/shell-global.css', 'utf8');
  const shellTsx = readFileSync('src/components/school-shell/shell.tsx', 'utf8');

  it('no longer paints older pages light', () => {
    const legacy = shellCss.slice(shellCss.indexOf(".main[data-canvas='legacy-light'] {"));
    expect(legacy.slice(0, legacy.indexOf('}'))).not.toMatch(/#f5f7fb|#172238|color-scheme: light/);
  });

  it('recolours every tag with tokens only', () => {
    const adapter = globalCss.slice(globalCss.indexOf('Consistent look C1'));
    for (const tag of ['text', 'muted', 'danger', 'success', 'warning', 'info']) expect(adapter).toContain(`[data-hon-ink='${tag}']`);
    for (const tag of ['page', 'panel', 'info', 'danger', 'success', 'warning', 'accent']) expect(adapter).toContain(`[data-hon-fill='${tag}']`);
    expect(adapter).toContain("[data-hon-line='line']");
    const declarations = adapter.replace(/\/\*[\s\S]*?\*\//g, '').match(/(color|background|border-color)\s*:[^;}]*/g) ?? [];
    for (const d of declarations) expect(d, d).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|\bwhite\b/i);
  });

  it('uses one title size and drops the spaced area label above it', () => {
    expect(globalCss).toMatch(/legacy-light'\] h1[^{]*{[^}]*font-size: var\(--hon-text-2xl\)/);
    expect(globalCss).toMatch(/legacy-light'\] header > p:first-child:has\(\+ h1\)[^{]*{[^}]*display: none/);
  });

  it('decides from the page as written and keeps the decision once the heading is in, so it never flips', () => {
    const effect = shellTsx.slice(shellTsx.indexOf("const main = document.getElementById('hon-main');"), shellTsx.indexOf('classify();'));
    expect(effect.indexOf("main.removeAttribute('data-canvas')")).toBeLessThan(effect.indexOf('const classify'));
    expect(effect).toMatch(/const legacy = decided \?\? shellNeedsLegacyCanvas\(main\)/);
    expect(effect).toMatch(/if \(main\.querySelector\('h1, h2'\)\) decided = legacy/);
    expect(effect).toContain('shellRecolorLegacy(main)');
  });
});

describe('pages that paint their own light page are recoloured too', () => {
  it('treats a heading on a light surface (Conversations, Lead memberships) as an older page, and a dark one as native', async () => {
    const { shellNeedsLegacyCanvas } = await import('../src/components/school-shell/shell');
    type Node = { _style: { backgroundColor: string; backgroundImage: string; color: string }; parentElement: Node | null };
    const node = (parent: Node | null, bg: string, color = 'rgb(23, 34, 56)'): Node => ({ _style: { backgroundColor: bg, backgroundImage: 'none', color }, parentElement: parent });
    const page = (rootBg: string, headingColor: string | null) => {
      const main = node(null, 'rgba(0, 0, 0, 0)'), root = node(main, rootBg), h1 = headingColor ? node(root, 'rgba(0, 0, 0, 0)', headingColor) : null;
      return Object.assign(main, { firstElementChild: Object.assign(root, { closest: () => null, hasAttribute: () => false }),
        querySelector: (s: string) => (s === 'h1' ? h1 : null) }) as unknown as Element;
    };
    vi.stubGlobal('getComputedStyle', (e: Node) => e._style);
    expect(shellNeedsLegacyCanvas(page('rgb(245, 247, 251)', 'rgb(23, 34, 56)'))).toBe(true);
    expect(shellNeedsLegacyCanvas(page('rgb(255, 255, 255)', null))).toBe(true);
    expect(shellNeedsLegacyCanvas(page('rgb(8, 18, 31)', 'rgb(234, 244, 251)'))).toBe(false);
    expect(shellNeedsLegacyCanvas(page('rgb(8, 18, 31)', null))).toBe(false);
    vi.unstubAllGlobals();
  });

  it('lets the page root sit on the shell background instead of becoming a card', () => {
    const child = el('div', { color: 'rgb(23, 34, 56)', backgroundColor: 'rgb(245, 247, 251)', borderTopColor: 'rgb(0, 0, 0)', borderTopWidth: '0px' });
    const main = { querySelectorAll: () => [item] } as unknown as Element;
    const item = Object.assign(asElement(child), { parentElement: main });
    vi.stubGlobal('getComputedStyle', (e: { _f: Fake }) => e._f.style);
    shellRecolorLegacy(main);
    vi.unstubAllGlobals();
    expect(child.attrs.get('data-hon-fill')).toBe('page');
  });
});
