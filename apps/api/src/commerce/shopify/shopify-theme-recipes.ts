import type { ShopifyThemeFile } from './shopify-adapter.js';

/**
 * TB1: the ready-made theme changes HON can prepare without AI. Each recipe reads the theme's own JSON files and returns the
 * new contents; nothing here talks to Shopify. A recipe never touches Liquid, assets or files it does not name, keeps every
 * key it does not own, and running it twice gives the same file (so a repeat is "no change").
 */
export type ThemeRecipe =
  | { recipe: 'SCHOOL_COLORS'; primary: string; secondary: string | null }
  | { recipe: 'SIZE_GUIDE'; text: string }
  | { recipe: 'PICKUP_NOTE'; text: string };
export const THEME_RECIPES = ['SCHOOL_COLORS', 'SIZE_GUIDE', 'PICKUP_NOTE'] as const;
export const THEME_RECIPE_FILES: Record<ThemeRecipe['recipe'], readonly string[]> = {
  SCHOOL_COLORS: ['config/settings_data.json'], SIZE_GUIDE: ['templates/product.json'], PICKUP_NOTE: ['templates/cart.json'],
};
export interface ThemeFileChange { filename: string; before: string; after: string }
export type ThemeRecipeResult = { ok: true; files: ThemeFileChange[] } | { ok: false; problem: 'FILE_MISSING' | 'UNSUPPORTED_THEME' };

const HEX = /^#[0-9A-F]{6}$/;
/** The recipe exactly as HON accepts it from a person: closed keys, upper-case hex colours, plain text with limits. */
export function themeRecipe(v: unknown): ThemeRecipe | null {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  const keys = o ? Object.keys(o).sort().join(',') : '';
  const text = (t: unknown, max: number) => typeof t === 'string' && t.trim().length >= 1 && t.length <= max && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(t) ? t.trim() : null;
  if (o?.recipe === 'SCHOOL_COLORS' && keys === 'primary,recipe,secondary' && typeof o.primary === 'string' && HEX.test(o.primary)
    && (o.secondary === null || (typeof o.secondary === 'string' && HEX.test(o.secondary)))) return { recipe: 'SCHOOL_COLORS', primary: o.primary, secondary: o.secondary as string | null };
  if (o?.recipe === 'SIZE_GUIDE' && keys === 'recipe,text' && text(o.text, 2000)) return { recipe: 'SIZE_GUIDE', text: text(o.text, 2000)! };
  if (o?.recipe === 'PICKUP_NOTE' && keys === 'recipe,text' && text(o.text, 500)) return { recipe: 'PICKUP_NOTE', text: text(o.text, 500)! };
  return null;
}

/** Shopify JSON theme files may start with a generated /* ... *\/ comment; it is kept as it was. */
function parse(content: string): { head: string; data: Record<string, unknown> } | null {
  const m = /^\s*\/\*[\s\S]*?\*\/\s*/.exec(content), head = m ? m[0] : '';
  try { const d = JSON.parse(content.slice(head.length)) as unknown; return d && typeof d === 'object' && !Array.isArray(d) ? { head, data: d as Record<string, unknown> } : null; }
  catch { return null; }
}
const render = (head: string, data: unknown) => head + JSON.stringify(data, null, 2);
const rec = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Plain text as theme rich text: escaped, blank lines start paragraphs. */
export function richText(text: string): string { return text.split(/\n{2,}/).map(p => '<p>' + p.split('\n').map(escapeHtml).join('<br>') + '</p>').join(''); }
/** Black or white, whichever reads better on the colour (WCAG relative luminance). */
export function labelOn(hex: string): '#FFFFFF' | '#121212' {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(x => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  const l = 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  return (1.05) / (l + 0.05) >= (l + 0.05) / 0.05 ? '#FFFFFF' : '#121212';
}

function schoolColors(data: Record<string, unknown>, primary: string, secondary: string | null): boolean {
  const schemes = rec(rec(data.current)?.color_schemes);
  if (!schemes || !Object.keys(schemes).length) return false;
  for (const [, scheme] of Object.entries(schemes)) {
    const st = rec(rec(scheme)?.settings);
    if (!st) return false;
    st.button = primary; st.button_label = labelOn(primary); st.secondary_button_label = secondary ?? primary;
  }
  return true;
}
function sizeGuide(data: Record<string, unknown>, text: string): boolean {
  const sections = rec(data.sections);
  const main = sections && Object.values(sections).map(rec).find(s => s?.type === 'main-product');
  if (!main) return false;
  const blocks = rec(main.blocks) ?? {}, order = Array.isArray(main.block_order) ? main.block_order.filter(x => typeof x === 'string') as string[] : [];
  blocks.hon_size_guide = { type: 'collapsible_tab', settings: { heading: 'Size guide', icon: 'ruler', content: richText(text) } };
  if (!order.includes('hon_size_guide')) { const at = order.indexOf('buy_buttons'); order.splice(at < 0 ? order.length : at + 1, 0, 'hon_size_guide'); }
  main.blocks = blocks; main.block_order = order;
  return true;
}
function pickupNote(data: Record<string, unknown>, text: string): boolean {
  const sections = rec(data.sections), order = Array.isArray(data.order) ? data.order.filter(x => typeof x === 'string') as string[] : null;
  if (!sections || !order) return false;
  sections['hon-pickup-note'] = { type: 'rich-text', blocks: { text: { type: 'text', settings: { text: richText(text) } } }, block_order: ['text'], settings: {} };
  if (!order.includes('hon-pickup-note')) { const at = order.indexOf('cart-items'); order.splice(at < 0 ? order.length : at + 1, 0, 'hon-pickup-note'); }
  data.order = order;
  return true;
}

/** The new contents of the recipe's files, from the theme's current ones. */
export function applyThemeRecipe(r: ThemeRecipe, current: readonly ShopifyThemeFile[]): ThemeRecipeResult {
  const files: ThemeFileChange[] = [];
  for (const filename of THEME_RECIPE_FILES[r.recipe]) {
    const f = current.find(x => x.filename === filename);
    if (!f) return { ok: false, problem: 'FILE_MISSING' };
    const p = parse(f.content);
    if (!p) return { ok: false, problem: 'UNSUPPORTED_THEME' };
    const ok = r.recipe === 'SCHOOL_COLORS' ? schoolColors(p.data, r.primary, r.secondary)
      : r.recipe === 'SIZE_GUIDE' ? sizeGuide(p.data, r.text) : pickupNote(p.data, r.text);
    if (!ok) return { ok: false, problem: 'UNSUPPORTED_THEME' };
    const after = render(p.head, p.data);
    files.push({ filename, before: f.content, after: after.trim() === f.content.trim() ? f.content : after });
  }
  return { ok: true, files };
}
