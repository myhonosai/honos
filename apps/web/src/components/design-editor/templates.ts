import {
  CREATIVE_DESIGN_SIZES, blankCreativeDesignDocument, creativeDesignTextOk,
  type CreativeDesignDocument, type CreativeDesignElement, type CreativeDesignSizeCode,
} from '@hon/contracts';
import { clampElement } from './model';
import { designText, type DesignKey } from './copy';

/**
 * Starter templates (D2). Each is laid out in fractions of the page so one template fits every size, built in the browser
 * in the person's language, and saved as an ordinary new design: nothing is stored for a template. The school's accent
 * color and contact line (0285 branding) are used when the person can read them.
 */
export type Brand = Readonly<{ accent: string | null; contactLine: string | null }>;
export const NO_BRAND: Brand = { accent: null, contactLine: null };
export const TEMPLATE_IDS = ['trial', 'openHouse', 'camp', 'promotion', 'schedule'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];
export const TEMPLATE_NAMES: Readonly<Record<TemplateId, DesignKey>> = { trial: 'tplTrial', openHouse: 'tplOpenHouse', camp: 'tplCamp', promotion: 'tplPromotion', schedule: 'tplSchedule' };

const DEFAULT_ACCENT = '#C8102E';
const r2 = (v: number) => Math.round(v * 100) / 100;

type Frame = { W: number; H: number; S: number; portrait: boolean };
type Text = Extract<CreativeDesignElement, { kind: 'text' }>;
const base = (id: string) => ({ id, rotation: 0, opacity: 1, locked: false });

/** A rough width of a line in ems (no canvas here): wide for Hangul and CJK, wider for capitals and digits. */
export function lineEms(line: string, bold: boolean, mono = false): number {
  let ems = 0;
  for (const c of line) ems += /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(c) ? 1 : mono ? 0.62
    : /[A-Z0-9]/.test(c) ? (bold ? 0.78 : 0.7) : c === ' ' ? 0.3 : (bold ? 0.62 : 0.56);
  return ems;
}
/** Text that must stay on its written lines (headlines and the schedule) shrinks to fit; other text wraps. */
const FIT = new Set(['head', 'sched', 'cta', 'tag']);
function text(f: Frame, id: string, words: string, fx: number, fy: number, fw: number, sizeOfShort: number, o: Partial<Text> = {}): Text {
  // The headline shrinks until each written line fits the box width, so a long translation never wraps over the next line.
  const widest = FIT.has(id) ? Math.max(1, ...words.split('\n').map(line => lineEms(line, o.bold ?? false, o.font === 'MONO'))) : 0;
  // 0.9: room for fonts that run wider than the estimate.
  const size = r2(Math.max(4, Math.min(f.S * sizeOfShort, widest ? (f.W * fw * 0.9) / widest : Infinity))), lineHeight = o.lineHeight ?? 1.15, lines = words.split('\n').length;
  return { ...base(id), kind: 'text', x: r2(f.W * fx), y: r2(f.H * fy), w: r2(f.W * fw), h: r2(size * lineHeight * lines), text: words, font: 'SANS', size,
    bold: false, italic: false, color: '#111111', align: 'center', lineHeight, ...o };
}
function rect(f: Frame, id: string, fx: number, fy: number, fw: number, fh: number, fill: string, radius = 0): CreativeDesignElement {
  return { ...base(id), kind: 'rect', x: r2(f.W * fx), y: r2(f.H * fy), w: r2(f.W * fw), h: r2(f.H * fh), fill, stroke: null, strokeWidth: 0, radius: r2(radius) };
}
function circle(f: Frame, id: string, cx: number, cy: number, diameterOfShort: number, fill: string, opacity = 1): CreativeDesignElement {
  const d = r2(f.S * diameterOfShort);
  return { ...base(id), opacity, kind: 'ellipse', x: r2(f.W * cx - d / 2), y: r2(f.H * cy - d / 2), w: d, h: d, fill, stroke: null, strokeWidth: 0 };
}

/** A new document for the template at this size, or a blank one for null. Always a valid document for the size. */
export function templateDocument(id: TemplateId | null, code: CreativeDesignSizeCode, language: string, brand: Brand = NO_BRAND): CreativeDesignDocument {
  const doc = blankCreativeDesignDocument(code);
  if (!id) return doc;
  const size = CREATIVE_DESIGN_SIZES[code];
  const f: Frame = { W: size.width, H: size.height, S: Math.min(size.width, size.height), portrait: size.height >= size.width };
  const t = (key: DesignKey) => designText(language, key);
  const accent = brand.accent ?? DEFAULT_ACCENT;
  const contact = brand.contactLine && creativeDesignTextOk(brand.contactLine) ? brand.contactLine : t('tContact');
  const tall = f.portrait ? 1 : 0.8; // landscape pages get slightly smaller type
  let page: { background: string; elements: CreativeDesignElement[] };
  switch (id) {
    case 'trial':
      page = { background: '#FFFFFF', elements: [
        rect(f, 'band', 0, 0, 1, 0.34, accent),
        text(f, 'head', t('tTrialHead'), 0.06, 0.1, 0.88, 0.12 * tall, { bold: true, font: 'DISPLAY', color: '#FFFFFF' }),
        text(f, 'sub', t('tTrialSub'), 0.1, 0.44, 0.8, 0.05 * tall),
        text(f, 'cta', t('tTrialCta'), 0.1, 0.62, 0.8, 0.065 * tall, { bold: true, color: accent }),
        rect(f, 'rule', 0.3, 0.78, 0.4, 0.004, '#111111'),
        text(f, 'contact', contact, 0.06, 0.84, 0.88, 0.04 * tall),
      ] };
      break;
    case 'openHouse':
      page = { background: '#101820', elements: [
        circle(f, 'glow', 0.85, 0.15, 0.7, accent, 0.85),
        circle(f, 'dot', 0.1, 0.9, 0.3, accent, 0.5),
        text(f, 'head', t('tOpenHead'), 0.06, 0.3, 0.88, 0.14 * tall, { bold: true, font: 'DISPLAY', color: '#FFFFFF', align: 'left' }),
        text(f, 'tag', t('tOpenSub'), 0.06, 0.48, 0.88, 0.06 * tall, { bold: true, color: '#FFD98A', align: 'left' }),
        text(f, 'body', t('tOpenBody'), 0.06, 0.6, 0.88, 0.045 * tall, { color: '#FFFFFF', align: 'left' }),
        text(f, 'contact', contact, 0.06, 0.86, 0.88, 0.038 * tall, { color: '#DDDDDD', align: 'left' }),
      ] };
      break;
    case 'camp':
      page = { background: '#FFF8E7', elements: [
        circle(f, 'sun', 0.5, 0.2, 0.36, '#FFC23D'),
        text(f, 'head', t('tCampHead'), 0.05, 0.4, 0.9, 0.13 * tall, { bold: true, font: 'ROUNDED', color: accent }),
        text(f, 'tag', t('tCampSub'), 0.1, 0.56, 0.8, 0.055 * tall, { bold: true }),
        text(f, 'body', t('tCampBody'), 0.1, 0.67, 0.8, 0.045 * tall),
        rect(f, 'base', 0, 0.82, 1, 0.18, accent),
        text(f, 'contact', contact, 0.06, 0.87, 0.88, 0.04 * tall, { color: '#FFFFFF' }),
      ] };
      break;
    case 'promotion':
      page = { background: '#FFFFFF', elements: [
        rect(f, 'frame', 0.04, 0.04, 0.92, 0.92, '#111111', f.S * 0.03),
        rect(f, 'inner', 0.07, 0.07, 0.86, 0.86, '#FFFFFF', f.S * 0.02),
        rect(f, 'belt', 0.07, 0.3, 0.86, 0.06, accent),
        text(f, 'head', t('tPromoHead'), 0.1, 0.12, 0.8, 0.1 * tall, { bold: true, font: 'SERIF' }),
        text(f, 'sub', t('tPromoSub'), 0.12, 0.44, 0.76, 0.05 * tall, { italic: true, font: 'SERIF' }),
        text(f, 'body', t('tPromoBody'), 0.12, 0.66, 0.76, 0.05 * tall, { bold: true }),
        text(f, 'contact', contact, 0.1, 0.84, 0.8, 0.035 * tall),
      ] };
      break;
    case 'schedule':
      page = { background: '#F4F6FA', elements: [
        rect(f, 'band', 0, 0, 1, 0.2, accent),
        text(f, 'head', t('tSchedHead'), 0.05, 0.06, 0.9, 0.09 * tall, { bold: true, font: 'DISPLAY', color: '#FFFFFF' }),
        text(f, 'sched', t('tSchedBody'), 0.08, 0.3, 0.84, 0.045 * tall, { align: 'left', lineHeight: 1.8, font: 'MONO' }),
        text(f, 'contact', contact, 0.06, 0.86, 0.88, 0.038 * tall),
      ] };
      break;
  }
  const pages = [page, ...doc.pages.slice(1)];
  if (size.sides === 2) {
    // A postcard back: the message on the left, a line, and the right half left clear for the address and postage.
    pages[1] = { background: '#FFFFFF', elements: [
      text(f, 'back-msg', t('tBack'), 0.06, 0.12, 0.4, 0.07, { bold: true, align: 'left', color: accent }),
      text(f, 'back-contact', contact, 0.06, 0.7, 0.4, 0.045, { align: 'left' }),
      { ...base('back-rule'), kind: 'line', x: r2(f.W * 0.52), y: r2(f.H * 0.1), w: 0, h: r2(f.H * 0.8), stroke: '#BBBBBB', strokeWidth: 1 },
    ] };
  }
  return { v: 1, pages: pages.map(p => ({ ...p, elements: p.elements.map(e => clampElement(e, code)) })) };
}
