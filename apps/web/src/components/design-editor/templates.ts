import {
  CREATIVE_DESIGN_SIZES, blankCreativeDesignDocument, creativeDesignTextOk,
  type CreativeDesignDocument, type CreativeDesignElement, type CreativeDesignFont, type CreativeDesignSizeCode,
} from '@hon/contracts';
import { clampElement } from './model';
import { TEMPLATE_THEMES, templateWords, type ScheduleRow, type TemplateTheme, type ThemeWords } from './template-copy';

/**
 * Pro templates (E2; D2 had five plain ones). A template is a theme (what it is for: trial, camp, schedule...) in a
 * style (how it looks: bold, clean, fun, elegant), so 10 themes x 4 styles = 40. Each is laid out in fractions of the
 * page, with its own portrait and landscape arrangement, built in the browser in the person's language with the school's
 * accent color and contact line (0285 branding) when the person can read them, and saved as an ordinary new design:
 * nothing is stored for a template. Every result is a valid document for every size.
 */
export type Brand = Readonly<{ accent: string | null; contactLine: string | null }>;
export const NO_BRAND: Brand = { accent: null, contactLine: null };
export const TEMPLATE_STYLES = ['bold', 'clean', 'fun', 'elegant'] as const;
export type TemplateStyle = (typeof TEMPLATE_STYLES)[number];
export type TemplateId = `${TemplateTheme}-${TemplateStyle}`;
export const TEMPLATE_IDS: readonly TemplateId[] = TEMPLATE_THEMES.flatMap(theme => TEMPLATE_STYLES.map(style => `${theme}-${style}` as const));
export { TEMPLATE_THEMES, type TemplateTheme };

export function templateParts(id: TemplateId): { theme: TemplateTheme; style: TemplateStyle } {
  const [theme, style] = id.split('-') as [TemplateTheme, TemplateStyle];
  return { theme, style };
}
export function isTemplateId(value: string): value is TemplateId { return (TEMPLATE_IDS as readonly string[]).includes(value); }
/** The name a new design gets: the theme's name in the person's language. */
export function templateName(language: string, id: TemplateId): string { return templateWords(language).themes[templateParts(id).theme].name; }
/** The fonts a style uses, so a gallery can load them before drawing previews. */
export const STYLE_FONTS: Readonly<Record<TemplateStyle, readonly [CreativeDesignFont, CreativeDesignFont, ...CreativeDesignFont[]]>> = {
  bold: ['ANTON', 'MONTSERRAT', 'BEBAS'], clean: ['MONTSERRAT', 'POPPINS'], fun: ['BANGERS', 'NUNITO'], elegant: ['PLAYFAIR', 'RALEWAY'],
};

const DEFAULT_ACCENT = '#C8102E';
const r2 = (v: number) => Math.round(v * 100) / 100;

type Frame = { W: number; H: number; S: number; land: boolean };
type Text = Extract<CreativeDesignElement, { kind: 'text' }>;
type TextOpts = Partial<Omit<Text, 'kind' | 'id' | 'x' | 'y' | 'w' | 'h' | 'text' | 'size'>> & { fit?: boolean; maxH?: number };
const base = (id: string) => ({ id, rotation: 0, opacity: 1, locked: false });

/** A rough width of a line in ems (no canvas here): wide for Hangul and CJK, wider for capitals and digits. */
export function lineEms(line: string, bold: boolean, mono = false): number {
  let ems = 0;
  for (const c of line) ems += /[ᄀ-ᇿ⺀-鿿가-힯＀-￯]/.test(c) ? 1 : mono ? 0.62
    : /[A-Z0-9]/.test(c) ? (bold ? 0.78 : 0.7) : c === ' ' ? 0.3 : (bold ? 0.62 : 0.56);
  return ems;
}
/** How much wider (more than 1) or narrower than the Arial-like estimate each template font runs. */
const FONT_WIDTH: Partial<Record<CreativeDesignFont, number>> = {
  ANTON: 0.72, BEBAS: 0.66, OSWALD: 0.78, BANGERS: 0.8, MONTSERRAT: 1.12, POPPINS: 1.1, ARCHIVO_BLACK: 1.2, PLAYFAIR: 0.95, RALEWAY: 1.05, NUNITO: 1, MONO: 1,
};

const CJK = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]/;
/** Estimated width in ems of a run in a template font: Latin letters scaled by the font's width, Hangul and CJK (drawn by a system fallback) not. */
function emsIn(run: string, font: CreativeDesignFont, bold: boolean): number {
  const k = FONT_WIDTH[font] ?? 1;
  let ems = 0;
  for (const c of run) ems += CJK.test(c) ? 1 : lineEms(c, bold, font === 'MONO') * k;
  return ems;
}
/** Lines a greedy word wrap would make for this text at this size and box width (an estimate; the canvas wraps for real). */
export function estimateLines(words: string, size: number, width: number, font: CreativeDesignFont, bold: boolean): number {
  let lines = 0;
  for (const para of words.split('\n')) {
    let used = 0;
    lines += 1;
    for (const word of para.split(' ')) {
      const w = emsIn(word, font, bold) * size, space = used ? emsIn(' ', font, bold) * size : 0;
      if (used && used + space + w > width) { lines += 1; used = w; } else used += space + w;
    }
  }
  return lines;
}

/**
 * A text box at fractions of the page. `size` is a fraction of the short side. With `fit` the text keeps its written
 * lines and shrinks until the widest fits the box, so a long translation never wraps over the next item. With `maxH`
 * (a fraction of the page height) it also shrinks until its estimated lines fit that height.
 */
function text(f: Frame, id: string, words: string, fx: number, fy: number, fw: number, size: number, o: TextOpts = {}): Text {
  const { fit, maxH, ...rest } = o;
  const font = rest.font ?? 'SANS', bold = rest.bold ?? false, lineHeight = rest.lineHeight ?? 1.15, boxW = f.W * fw;
  const widest = fit ? Math.max(1, ...words.split('\n').map(l => emsIn(l, font, bold))) : 0;
  let px = Math.max(4, Math.min(f.S * size, widest ? (boxW * 0.92) / widest : Infinity));
  const lines = (at: number) => fit ? words.split('\n').length : estimateLines(words, at, boxW * 0.96, font, bold);
  // Hangul and CJK lines need room above and below even in a tight headline.
  const lh = CJK.test(words) ? Math.max(lineHeight, 1.12) : lineHeight;
  if (maxH) while (px > 4 && lines(px) * px * lh > f.H * maxH) px = Math.max(4, px * 0.94);
  px = r2(px);
  return { ...base(id), kind: 'text', x: r2(f.W * fx), y: r2(f.H * fy), w: r2(boxW), h: r2(px * lh * lines(px)), text: words, size: px,
    font, bold, italic: false, color: '#111111', align: 'center', ...rest, lineHeight: lh };
}
function rect(f: Frame, id: string, fx: number, fy: number, fw: number, fh: number, fill: string | null, o: Partial<Extract<CreativeDesignElement, { kind: 'rect' }>> = {}): CreativeDesignElement {
  return { ...base(id), kind: 'rect', x: r2(f.W * fx), y: r2(f.H * fy), w: r2(f.W * fw), h: r2(f.H * fh), fill, stroke: null, strokeWidth: 0, radius: 0, ...o };
}
function circle(f: Frame, id: string, cx: number, cy: number, diameterOfShort: number, fill: string, opacity = 1): CreativeDesignElement {
  const d = r2(f.S * diameterOfShort);
  return { ...base(id), opacity, kind: 'ellipse', x: r2(f.W * cx - d / 2), y: r2(f.H * cy - d / 2), w: d, h: d, fill, stroke: null, strokeWidth: 0 };
}
function line(f: Frame, id: string, fx: number, fy: number, fw: number, stroke: string, width: number): CreativeDesignElement {
  return { ...base(id), kind: 'line', x: r2(f.W * fx), y: r2(f.H * fy), w: r2(f.W * fw), h: 0, stroke, strokeWidth: r2(Math.max(0.5, f.S * width)) };
}

type TableLook = Readonly<{ font: CreativeDesignFont; color: string; strong: string; stripe: string | null; size: number }>;
/** The schedule as a real table: one row per class, day and time in their own columns, alternate rows shaded. */
function scheduleTable(f: Frame, rows: readonly ScheduleRow[], x: number, y0: number, w: number, y1: number, look: TableLook): CreativeDesignElement[] {
  const out: CreativeDesignElement[] = [], step = (y1 - y0) / rows.length;
  rows.forEach(([day, time, klass], i) => {
    const y = y0 + step * i, size = Math.min(look.size, (step * f.H * 0.42) / f.S);
    if (look.stripe && i % 2 === 0) out.push(rect(f, `row-${i}`, x, y, w, step, look.stripe, { radius: r2(f.S * 0.01) }));
    const mid = y + step / 2 - (size * f.S * 1.15) / 2 / f.H;
    out.push(text(f, `day-${i}`, day, x + w * 0.04, mid, w * 0.3, size, { font: look.font, bold: true, color: look.strong, align: 'left', fit: true }));
    out.push(text(f, `time-${i}`, time, x + w * 0.35, mid, w * 0.25, size, { font: look.font, color: look.color, align: 'left', fit: true }));
    out.push(text(f, `class-${i}`, klass, x + w * 0.6, mid, w * 0.37, size, { font: look.font, bold: true, color: look.strong, align: 'right', fit: true }));
  });
  return out;
}

type Ctx = Readonly<{ f: Frame; w: ThemeWords; rows: readonly ScheduleRow[] | null; accent: string; contact: string }>;
const opt = (words: string, make: (words: string) => CreativeDesignElement): CreativeDesignElement[] => words ? [make(words)] : [];

/** Bold: near-black page, huge condensed headline, a tilted accent band carrying the call to action. */
function bold({ f, w, rows, accent, contact }: Ctx): { background: string; elements: CreativeDesignElement[] } {
  const look: TableLook = { font: 'MONTSERRAT', color: '#CFCFCF', strong: '#FFFFFF', stripe: '#1F1F24', size: 0.04 };
  if (f.land) return { background: '#0E0E10', elements: [
    rect(f, 'slash', 0.52, -0.2, 0.7, 1.4, accent, { rotation: 8 }),
    text(f, 'kicker', w.kicker, 0.05, 0.1, 0.45, 0.05, { font: 'MONTSERRAT', bold: true, color: accent, align: 'left', fit: true }),
    rect(f, 'rule', 0.05, 0.2, 0.08, 0.012, accent),
    text(f, 'head', w.head, 0.05, 0.26, 0.45, 0.24, { maxH: 0.55, font: 'ANTON', color: '#FFFFFF', align: 'left', lineHeight: 0.98, fit: true }),
    ...(rows ? scheduleTable(f, rows, 0.6, 0.12, 0.36, 0.72, { ...look, stripe: null, color: '#FFFFFF' }) : [
      text(f, 'sub', w.sub, 0.6, 0.22, 0.34, 0.06, { maxH: 0.26, font: 'MONTSERRAT', bold: true, color: '#FFFFFF', align: 'left' }),
      ...opt(w.details, d => text(f, 'details', d, 0.6, 0.5, 0.34, 0.045, { maxH: 0.26, font: 'MONTSERRAT', color: '#FFFFFF', align: 'left' }))]),
    text(f, 'cta', w.cta, 0.6, 0.78, 0.36, 0.07, { font: 'BEBAS', color: '#FFFFFF', align: 'left', fit: true }),
    text(f, 'contact', contact, 0.05, 0.86, 0.45, 0.04, { font: 'MONTSERRAT', color: '#BBBBBB', align: 'left', fit: true }),
  ] };
  return { background: '#0E0E10', elements: [
    rect(f, 'slash', -0.2, rows ? 0.8 : 0.62, 1.4, 0.13, accent, { rotation: -6 }),
    text(f, 'kicker', w.kicker, 0.07, 0.06, 0.86, 0.035, { font: 'MONTSERRAT', bold: true, color: accent, align: 'left', fit: true }),
    rect(f, 'rule', 0.07, 0.11, 0.12, 0.006, accent),
    text(f, 'head', w.head, 0.07, 0.14, 0.86, 0.2, { maxH: 0.27, font: 'ANTON', color: '#FFFFFF', align: 'left', lineHeight: 0.98, fit: true }),
    ...(rows ? [
      text(f, 'sub', w.sub, 0.07, 0.42, 0.86, 0.035, { font: 'MONTSERRAT', color: '#DDDDDD', align: 'left', fit: true }),
      ...scheduleTable(f, rows, 0.07, 0.48, 0.86, 0.76, look),
    ] : [
      text(f, 'sub', w.sub, 0.07, 0.43, 0.8, 0.056, { maxH: 0.11, font: 'MONTSERRAT', bold: true, color: '#FFFFFF', align: 'left' }),
      ...opt(w.details, d => text(f, 'details', d, 0.07, 0.55, 0.8, 0.038, { maxH: 0.065, font: 'MONTSERRAT', color: '#BBBBBB', align: 'left' })),
    ]),
    text(f, 'cta', w.cta, 0.08, rows ? 0.825 : 0.645, 0.84, 0.07, { font: 'BEBAS', color: '#FFFFFF', rotation: -6, fit: true }),
    text(f, 'contact', contact, 0.07, 0.92, 0.86, 0.034, { font: 'MONTSERRAT', bold: true, color: '#FFFFFF', align: 'left', fit: true }),
  ] };
}

/** Clean: an accent top with the headline, a white card with the details, a pill button. */
function clean({ f, w, rows, accent, contact }: Ctx): { background: string; elements: CreativeDesignElement[] } {
  const look: TableLook = { font: 'POPPINS', color: '#555555', strong: '#1A1A1A', stripe: '#F2F4F7', size: 0.036 };
  if (f.land) return { background: '#F4F6FA', elements: [
    rect(f, 'panel', 0, 0, 0.46, 1, accent),
    text(f, 'kicker', w.kicker, 0.05, 0.12, 0.36, 0.045, { font: 'MONTSERRAT', bold: true, color: '#FFFFFF', align: 'left', fit: true }),
    text(f, 'head', w.head, 0.05, 0.24, 0.37, 0.17, { maxH: 0.55, font: 'MONTSERRAT', bold: true, color: '#FFFFFF', align: 'left', lineHeight: 1.02, fit: true }),
    text(f, 'contact', contact, 0.05, 0.86, 0.37, 0.035, { font: 'POPPINS', color: '#FFFFFF', align: 'left', fit: true }),
    rect(f, 'card', 0.5, 0.08, 0.46, 0.84, '#FFFFFF', { radius: r2(f.S * 0.04), stroke: '#E3E7EE', strokeWidth: r2(f.S * 0.003) }),
    ...(rows ? scheduleTable(f, rows, 0.53, 0.14, 0.4, 0.66, look) : [
      text(f, 'sub', w.sub, 0.54, 0.16, 0.38, 0.055, { maxH: 0.26, font: 'POPPINS', bold: true, color: '#1A1A1A', align: 'left' }),
      ...opt(w.details, d => text(f, 'details', d, 0.54, 0.44, 0.38, 0.042, { maxH: 0.26, font: 'POPPINS', color: '#555555', align: 'left' }))]),
    rect(f, 'pill', 0.54, 0.72, 0.38, 0.13, accent, { radius: r2(f.S * 0.065) }),
    text(f, 'cta', w.cta, 0.56, 0.755, 0.34, 0.05, { font: 'POPPINS', bold: true, color: '#FFFFFF', fit: true }),
  ] };
  return { background: '#F4F6FA', elements: [
    rect(f, 'top', 0, 0, 1, 0.46, accent),
    circle(f, 'ring', 0.92, 0.06, 0.5, '#FFFFFF', 0.12),
    text(f, 'kicker', w.kicker, 0.08, 0.07, 0.84, 0.032, { font: 'MONTSERRAT', bold: true, color: '#FFFFFF', fit: true }),
    text(f, 'head', w.head, 0.08, 0.13, 0.84, 0.13, { maxH: 0.23, font: 'MONTSERRAT', bold: true, color: '#FFFFFF', lineHeight: 1.02, fit: true }),
    rect(f, 'card', 0.07, 0.38, 0.86, 0.5, '#FFFFFF', { radius: r2(f.S * 0.04), stroke: '#E3E7EE', strokeWidth: r2(f.S * 0.002) }),
    ...(rows ? [
      text(f, 'sub', w.sub, 0.11, 0.41, 0.78, 0.032, { font: 'POPPINS', color: '#555555', fit: true }),
      ...scheduleTable(f, rows, 0.1, 0.46, 0.8, 0.7, look),
    ] : [
      text(f, 'sub', w.sub, 0.12, 0.44, 0.76, 0.052, { maxH: 0.13, font: 'POPPINS', bold: true, color: '#1A1A1A' }),
      ...opt(w.details, d => text(f, 'details', d, 0.12, 0.58, 0.76, 0.038, { maxH: 0.13, font: 'POPPINS', color: '#555555' })),
    ]),
    rect(f, 'pill', 0.2, 0.74, 0.6, 0.08, accent, { radius: r2(f.H * 0.04) }),
    text(f, 'cta', w.cta, 0.22, 0.758, 0.56, 0.044, { font: 'POPPINS', bold: true, color: '#FFFFFF', fit: true }),
    text(f, 'contact', contact, 0.08, 0.92, 0.84, 0.032, { font: 'POPPINS', color: '#555555', fit: true }),
  ] };
}

/** Fun: warm page, playful circles, a comic headline tilted a little, a dark button. */
function fun({ f, w, rows, accent, contact }: Ctx): { background: string; elements: CreativeDesignElement[] } {
  const ink = '#1B1B3A', sun = '#FFC93C', sea = '#2EC4B6';
  const look: TableLook = { font: 'NUNITO', color: ink, strong: ink, stripe: '#FFE7A3', size: 0.038 };
  if (f.land) return { background: '#FFF4D6', elements: [
    rect(f, 'big', -0.06, -0.12, 0.52, 1.24, accent, { radius: r2(f.S * 0.3) }), circle(f, 'sun', 0.97, 0.97, 0.5, sun), circle(f, 'dot', 0.42, 0.88, 0.16, sea),
    text(f, 'kicker', w.kicker, 0.05, 0.2, 0.36, 0.05, { font: 'NUNITO', bold: true, color: '#FFFFFF', fit: true }),
    text(f, 'head', w.head, 0.04, 0.32, 0.38, 0.2, { maxH: 0.5, font: 'BANGERS', color: '#FFFFFF', rotation: -4, lineHeight: 1, fit: true }),
    ...(rows ? scheduleTable(f, rows, 0.5, 0.1, 0.45, 0.66, look) : [
      text(f, 'sub', w.sub, 0.5, 0.14, 0.44, 0.06, { maxH: 0.26, font: 'NUNITO', bold: true, color: ink, align: 'left' }),
      ...opt(w.details, d => text(f, 'details', d, 0.5, 0.42, 0.44, 0.045, { maxH: 0.28, font: 'NUNITO', color: ink, align: 'left' }))]),
    rect(f, 'button', 0.5, 0.72, 0.38, 0.12, ink, { radius: r2(f.S * 0.06), rotation: -2 }),
    text(f, 'cta', w.cta, 0.52, 0.75, 0.34, 0.05, { font: 'BANGERS', color: sun, rotation: -2, fit: true }),
    text(f, 'contact', contact, 0.5, 0.9, 0.38, 0.035, { font: 'NUNITO', bold: true, color: ink, fit: true }),
  ] };
  return { background: '#FFF4D6', elements: [
    circle(f, 'big', 0.95, 0.02, 0.75, accent, 0.92), circle(f, 'sun', 0.02, 0.98, 0.6, sun), circle(f, 'dot', 0.12, 0.1, 0.12, sea),
    circle(f, 'dot2', 0.88, 0.62, 0.07, sea),
    text(f, 'kicker', w.kicker, 0.08, 0.1, 0.84, 0.036, { font: 'NUNITO', bold: true, color: ink, fit: true }),
    text(f, 'head', w.head, 0.06, 0.16, 0.88, 0.19, { maxH: 0.27, font: 'BANGERS', color: ink, rotation: -3, lineHeight: 1, fit: true }),
    ...(rows ? [
      ...scheduleTable(f, rows, 0.08, 0.44, 0.84, 0.7, look),
    ] : [
      text(f, 'sub', w.sub, 0.1, 0.46, 0.8, 0.054, { maxH: 0.13, font: 'NUNITO', bold: true, color: ink }),
      ...opt(w.details, d => text(f, 'details', d, 0.1, 0.6, 0.8, 0.04, { maxH: 0.12, font: 'NUNITO', color: '#3A3A55' })),
    ]),
    rect(f, 'button', 0.16, 0.74, 0.68, 0.085, ink, { radius: r2(f.H * 0.0425), rotation: -2 }),
    text(f, 'cta', w.cta, 0.18, 0.758, 0.64, 0.05, { font: 'BANGERS', color: sun, rotation: -2, fit: true }),
    text(f, 'contact', contact, 0.1, 0.9, 0.8, 0.034, { font: 'NUNITO', bold: true, color: ink, fit: true }),
  ] };
}

/** Elegant: cream paper, a double frame, a serif headline, a thin accent rule. */
function elegant({ f, w, rows, accent, contact }: Ctx): { background: string; elements: CreativeDesignElement[] } {
  const ink = '#1A1A1A', soft = '#5A5148';
  const look: TableLook = { font: 'RALEWAY', color: soft, strong: ink, stripe: null, size: 0.034 };
  const frames = [
    rect(f, 'frame', 0.035, 0.035 * f.W / f.H * (f.land ? 1 : 1), 0.93, 1 - 0.07 * f.W / f.H, null, { stroke: ink, strokeWidth: r2(f.S * 0.004) }),
    rect(f, 'frame2', 0.05, 0.05 * f.W / f.H, 0.9, 1 - 0.1 * f.W / f.H, null, { stroke: accent, strokeWidth: r2(f.S * 0.002) }),
  ];
  if (f.land) return { background: '#F7F1E8', elements: [
    ...frames,
    text(f, 'kicker', w.kicker, 0.1, 0.16, 0.38, 0.04, { font: 'RALEWAY', bold: true, color: accent, align: 'left', fit: true }),
    text(f, 'head', w.head, 0.1, 0.27, 0.38, 0.16, { maxH: 0.36, font: 'PLAYFAIR', bold: true, color: ink, align: 'left', lineHeight: 1.05, fit: true }),
    line(f, 'rule', 0.1, 0.66, 0.12, accent, 0.004),
    text(f, 'contact', contact, 0.1, 0.74, 0.38, 0.032, { font: 'RALEWAY', color: soft, align: 'left', fit: true }),
    ...(rows ? scheduleTable(f, rows, 0.52, 0.16, 0.4, 0.66, look) : [
      text(f, 'sub', w.sub, 0.54, 0.2, 0.36, 0.055, { maxH: 0.26, font: 'PLAYFAIR', italic: true, color: ink, align: 'left' }),
      ...opt(w.details, d => text(f, 'details', d, 0.54, 0.48, 0.36, 0.04, { maxH: 0.24, font: 'RALEWAY', color: soft, align: 'left' }))]),
    text(f, 'cta', w.cta, 0.54, 0.74, 0.36, 0.045, { font: 'RALEWAY', bold: true, color: accent, align: 'left', fit: true }),
  ] };
  return { background: '#F7F1E8', elements: [
    ...frames,
    text(f, 'kicker', w.kicker, 0.12, 0.11, 0.76, 0.034, { font: 'RALEWAY', bold: true, color: accent, fit: true }),
    text(f, 'head', w.head, 0.1, 0.16, 0.8, 0.13, { maxH: 0.27, font: 'PLAYFAIR', bold: true, color: ink, lineHeight: 1.05, fit: true }),
    line(f, 'rule', 0.42, rows ? 0.41 : 0.45, 0.16, accent, 0.003),
    ...(rows ? [
      ...scheduleTable(f, rows, 0.12, 0.45, 0.76, 0.7, look),
    ] : [
      text(f, 'sub', w.sub, 0.14, 0.5, 0.72, 0.054, { maxH: 0.12, font: 'PLAYFAIR', italic: true, color: ink }),
      ...opt(w.details, d => text(f, 'details', d, 0.14, 0.63, 0.72, 0.036, { maxH: 0.1, font: 'RALEWAY', color: soft })),
    ]),
    text(f, 'cta', w.cta, 0.12, 0.75, 0.76, 0.05, { font: 'RALEWAY', bold: true, color: accent, fit: true }),
    text(f, 'contact', contact, 0.12, 0.85, 0.76, 0.032, { font: 'RALEWAY', color: soft, fit: true }),
  ] };
}

const STYLE_LAYOUT: Readonly<Record<TemplateStyle, (ctx: Ctx) => { background: string; elements: CreativeDesignElement[] }>> = { bold, clean, fun, elegant };

/** Words that replace the template's starter words (E4: a Marcus draft). Schedule rows apply to the schedule theme only. */
export type TemplateCopy = Readonly<{ words: Omit<ThemeWords, 'name'>; schedule: readonly ScheduleRow[] | null }>;

/** A new document for the template at this size, or a blank one for null. Always a valid document for the size. */
export function templateDocument(id: TemplateId | null, code: CreativeDesignSizeCode, language: string, brand: Brand = NO_BRAND, copy: TemplateCopy | null = null): CreativeDesignDocument {
  const doc = blankCreativeDesignDocument(code);
  if (!id || !isTemplateId(id)) return doc;
  const size = CREATIVE_DESIGN_SIZES[code], { theme, style } = templateParts(id);
  const f: Frame = { W: size.width, H: size.height, S: Math.min(size.width, size.height), land: size.width > size.height * 1.15 };
  const words = templateWords(language);
  const accent = brand.accent ?? DEFAULT_ACCENT;
  const contact = brand.contactLine && creativeDesignTextOk(brand.contactLine) ? brand.contactLine : words.contact;
  const w: ThemeWords = copy ? { name: words.themes[theme].name, ...copy.words } : words.themes[theme];
  const page = STYLE_LAYOUT[style]({ f, w, rows: theme === 'schedule' ? (copy?.schedule ?? words.schedule) : null, accent, contact });
  const pages = [page, ...doc.pages.slice(1)];
  if (size.sides === 2) {
    // A postcard back: the message on the left, a line, and the right half left clear for the address and postage.
    pages[1] = { background: '#FFFFFF', elements: [
      text(f, 'back-msg', words.back, 0.06, 0.12, 0.4, 0.07, { bold: true, align: 'left', color: accent, font: STYLE_FONTS[style][0] }),
      text(f, 'back-contact', contact, 0.06, 0.7, 0.4, 0.045, { align: 'left', font: STYLE_FONTS[style][1] }),
      { ...base('back-rule'), kind: 'line', x: r2(f.W * 0.52), y: r2(f.H * 0.1), w: 0, h: r2(f.H * 0.8), stroke: '#BBBBBB', strokeWidth: 1 },
    ] };
  }
  return { v: 1, pages: pages.map(p => ({ ...p, elements: p.elements.map(e => clampElement(e, code)) })) };
}
