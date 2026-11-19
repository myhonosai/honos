/**
 * Consistent look C1 (owner 2026-11-19). Older school pages were written for a light page body. Instead of painting
 * a light card behind them inside the dark shell, the shell tags each element by the colours it was written with and
 * `shell-global.css` maps those tags onto the dark design tokens. Tags are read with the recolouring switched off,
 * so they always describe the page's own colours. Transitional: areas drop out as their stylesheets move to tokens.
 */
type Rgba = { r: number; g: number; b: number; a: number };
export type LegacyFamily = 'danger' | 'warning' | 'success' | 'info';
export type LegacyInk = 'text' | 'muted' | LegacyFamily;
export type LegacyFill = 'page' | 'panel' | 'accent' | LegacyFamily;

function parse(color: string): Rgba | null {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(color.trim());
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: alpha };
}
const lightness = ({ r, g, b }: Rgba) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const chroma = ({ r, g, b }: Rgba) => (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
function family({ r, g, b }: Rgba): LegacyFamily {
  const max = Math.max(r, g, b), c = max - Math.min(r, g, b);
  let hue = max === r ? 60 * (((g - b) / c) % 6) : max === g ? 60 * ((b - r) / c + 2) : 60 * ((r - g) / c + 4);
  if (hue < 0) hue += 360;
  if (hue < 15 || hue >= 330) return 'danger';
  if (hue < 65) return 'warning';
  if (hue < 170) return 'success';
  return 'info';
}

/** Text colour: dark text becomes token text; coloured dark text keeps its meaning (error, saved, caution, link). */
export function legacyInkTag(color: string): LegacyInk | null {
  const c = parse(color);
  if (!c || c.a === 0 || lightness(c) >= 0.5) return null;
  if (chroma(c) >= 0.2) return family(c);
  return lightness(c) < 0.22 ? 'text' : 'muted';
}

/** Background: white and near-white become panels, light tints become soft status tints, blue fills the accent. */
export function legacyFillTag(color: string): LegacyFill | null {
  const c = parse(color);
  if (!c || c.a < 0.1) return null;
  const l = lightness(c);
  if (l >= 0.75) return chroma(c) >= 12 / 255 ? family(c) : 'panel';
  if (l >= 0.15 && chroma(c) > 0.35 && family(c) === 'info') return 'accent';
  return null;
}

/** Border: light hairlines become the token border; deliberate coloured edges stay. */
export function legacyLineTag(color: string, width: string): 'line' | null {
  const c = parse(color);
  return c && c.a > 0 && Number.parseFloat(width) > 0 && lightness(c) >= 0.6 ? 'line' : null;
}

const TAGS = ['data-hon-ink', 'data-hon-fill', 'data-hon-line'] as const;

const measured = new WeakMap<Element, string>();

/**
 * Tags elements under `main` (up to `limit`) from their own colours. Only new or changed elements (class or inline
 * style) are measured, with their old tags removed first, so the page is never re-laid out as a whole and a tag
 * always describes the colour the element was written with. Drawings (SVG) keep their colours.
 */
export function shellRecolorLegacy(main: Element, limit = 6000, seen: WeakMap<Element, string> = measured): void {
  const elements = main.querySelectorAll('*');
  const count = Math.min(elements.length, limit);
  for (let i = 0; i < count; i += 1) {
    const element = elements[i]!;
    if (element.closest('svg')) continue;
    const signature = `${element.getAttribute('class') ?? ''}|${element.getAttribute('style') ?? ''}`;
    if (seen.get(element) === signature) continue;
    TAGS.forEach(name => element.removeAttribute(name));
    const style = getComputedStyle(element);
    // A page that paints its own light body sits on the shell background instead of becoming one big card.
    const fill = legacyFillTag(style.backgroundColor);
    const values = [legacyInkTag(style.color), fill === 'panel' && element.parentElement === main ? 'page' : fill, legacyLineTag(style.borderTopColor, style.borderTopWidth)];
    TAGS.forEach((name, index) => { const value = values[index]; if (value) element.setAttribute(name, value); });
    seen.set(element, signature);
  }
}
