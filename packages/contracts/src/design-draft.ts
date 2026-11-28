import { MERCH_AI_REASONS, MERCH_AI_STATUSES, type MerchAiReason, type MerchAiStatus } from './shopify-merch-ai.js';
import { CREATIVE_DESIGN_SIZE_CODES, type CreativeDesignSizeCode } from './creative-designs.js';

/**
 * Design AI draft (0705, E4a). In Creative Studio > New design a school describes the flyer it wants and Marcus answers with
 * up to three options on the shared AI text proposals (0550). An option is a template (theme and look) and the words to put
 * on it; the browser builds the design from the template, so a draft can never be a document the 0617 check refuses. A draft
 * changes nothing until a person picks an option and saves it with the ordinary design save command.
 */
export const DESIGN_DRAFT_COMMAND = 'design-draft';
export const DESIGN_DRAFT_LIMITS = { inputTokens: 6000, outputTokens: 3000, maxProviderCostMicrounits: 40000, maxResultBytes: 8192, brief: 600, options: 3,
  scheduleRows: 6, cell: 30, draftBytes: 7400 } as const;
/** The E2 template themes and looks (apps/web design-editor templates.ts); the web test proves they match. */
export const DESIGN_DRAFT_THEMES = ['trial', 'openHouse', 'camp', 'promotion', 'schedule', 'tournament', 'referral', 'afterSchool', 'birthday', 'holiday'] as const;
export const DESIGN_DRAFT_STYLES = ['bold', 'clean', 'fun', 'elegant'] as const;
export const DESIGN_DRAFT_LANGUAGES = ['en', 'ko', 'es'] as const;
/** Characters per word, and line breaks allowed (only the headline may break once). */
export const DESIGN_DRAFT_WORDS = { kicker: { max: 60, lines: 0 }, head: { max: 40, lines: 1 }, sub: { max: 140, lines: 0 }, details: { max: 160, lines: 0 }, cta: { max: 80, lines: 0 } } as const;
export type DesignDraftTheme = (typeof DESIGN_DRAFT_THEMES)[number];
export type DesignDraftStyle = (typeof DESIGN_DRAFT_STYLES)[number];
export type DesignDraftLanguage = (typeof DESIGN_DRAFT_LANGUAGES)[number];
export type DesignDraftWords = Readonly<Record<keyof typeof DESIGN_DRAFT_WORDS, string>>;
export type DesignDraftRow = readonly [day: string, time: string, klass: string];

export interface DesignDraftBrief { brief: string; size: CreativeDesignSizeCode; language: DesignDraftLanguage }
export interface DesignDraftOption { theme: DesignDraftTheme; style: DesignDraftStyle; words: DesignDraftWords; schedule: DesignDraftRow[] | null }
export interface DesignDraft { options: DesignDraftOption[] }
export interface DesignDraftView {
  id: string; status: MerchAiStatus; reason: MerchAiReason | null; brief: DesignDraftBrief; mine: boolean;
  draft: DesignDraft | null; problems: string[]; createdAt: string; updatedAt: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The 0617 design text rule (no control or direction characters but a line break) plus no < or >.
const REFUSED = /[\u0000-\u0009\u000b-\u001f\u007f‎‏‪-‮⁦-⁩﻿<>]/;
const LOOSE_LINE = /(^|\n)[ \t]|[ \t](\n|$)|\n\n/;
const bytes = (v: unknown) => { const s = JSON.stringify(v); let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3; } return n; };
const chars = (v: string) => [...v].length;
// hon.marketing_safe_text (0089) counted in characters as PostgreSQL counts them (code points, not UTF-16 units).
const CONTROL = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SECRETISH = /(-----BEGIN|Bearer\s+|\bsk[-_][A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_-]+\.eyJ|(?:api[ _-]?key|password|secret|authorization)\s*[:=])/i;
const safeText = (v: string, max: number) => { const n = chars(v.replace(/^ +| +$/g, '')); return n >= 1 && n <= max && !CONTROL.test(v) && !SECRETISH.test(v); };
const fail = (what: string): never => { throw new Error(`Invalid design draft ${what}.`); };

/** One word on a design, exactly as 0705 hon.design_draft_word_ok takes it. */
export function designDraftWordOk(v: unknown, max: number, lines: number, mayBeEmpty = false): v is string {
  if (typeof v !== 'string' || chars(v) > max || v !== v.trim() || REFUSED.test(v) || LOOSE_LINE.test(v)) return false;
  if (v === '') return mayBeEmpty;
  return (v.split('\n').length - 1) <= lines && safeText(v, max);
}

/** The brief, exactly as the database takes it (0705 hon.design_draft_brief_ok). */
export function validateDesignDraftBrief(value: unknown): DesignDraftBrief {
  if (!isObject(value) || !exactKeys(value, ['brief', 'size', 'language'])) return fail('brief');
  const { brief, size, language } = value;
  if (typeof brief !== 'string' || brief !== brief.trim() || !safeText(brief, DESIGN_DRAFT_LIMITS.brief)) return fail('brief');
  if (typeof size !== 'string' || !(CREATIVE_DESIGN_SIZE_CODES as readonly string[]).includes(size)) return fail('brief');
  if (typeof language !== 'string' || !(DESIGN_DRAFT_LANGUAGES as readonly string[]).includes(language)) return fail('brief');
  return { brief, size: size as CreativeDesignSizeCode, language: language as DesignDraftLanguage };
}

/** The closed shape the database stores (0705 hon.design_draft_ok). */
export function validateDesignDraft(value: unknown): DesignDraft {
  if (!isObject(value) || !exactKeys(value, ['options']) || !Array.isArray(value.options) || value.options.length < 1 || value.options.length > DESIGN_DRAFT_LIMITS.options) return fail('draft');
  const options = value.options.map((o: unknown): DesignDraftOption => {
    if (!isObject(o) || !exactKeys(o, ['theme', 'style', 'words', 'schedule'])) return fail('draft');
    if (typeof o.theme !== 'string' || !(DESIGN_DRAFT_THEMES as readonly string[]).includes(o.theme)) return fail('draft');
    if (typeof o.style !== 'string' || !(DESIGN_DRAFT_STYLES as readonly string[]).includes(o.style)) return fail('draft');
    const w = o.words;
    if (!isObject(w) || !exactKeys(w, Object.keys(DESIGN_DRAFT_WORDS))) return fail('draft');
    for (const [key, rule] of Object.entries(DESIGN_DRAFT_WORDS)) if (!designDraftWordOk(w[key], rule.max, rule.lines, key === 'details')) return fail('draft');
    let schedule: DesignDraftRow[] | null = null;
    if (o.schedule !== null) {
      if (o.theme !== 'schedule' || !Array.isArray(o.schedule) || o.schedule.length < 1 || o.schedule.length > DESIGN_DRAFT_LIMITS.scheduleRows) return fail('draft');
      schedule = o.schedule.map((row: unknown): DesignDraftRow => {
        if (!Array.isArray(row) || row.length !== 3 || !row.every(c => designDraftWordOk(c, DESIGN_DRAFT_LIMITS.cell, 0))) return fail('draft');
        return [row[0], row[1], row[2]] as DesignDraftRow;
      });
    }
    const words = Object.fromEntries(Object.keys(DESIGN_DRAFT_WORDS).map(k => [k, w[k] as string])) as DesignDraftWords;
    return { theme: o.theme as DesignDraftTheme, style: o.style as DesignDraftStyle, words, schedule };
  });
  // The database measures jsonb text (a space after each colon and comma), so compact JSON stays under its 8,192.
  if (bytes(value) > DESIGN_DRAFT_LIMITS.draftBytes) return fail('draft');
  return { options };
}

/** Tidies what a model commonly gets slightly wrong before validation: padded words, a missing schedule, "\r\n".
 * Nothing else is repaired. */
export function normalizeDesignDraftAnswer(value: unknown): unknown {
  if (!isObject(value) || !Array.isArray(value.options)) return value;
  const text = (v: unknown) => typeof v === 'string' ? v.replace(/\r\n?/g, '\n').split('\n').map(l => l.trim()).join('\n').trim() : v;
  return { ...value, options: value.options.map((o: unknown) => {
    if (!isObject(o)) return o;
    const words = isObject(o.words) ? Object.fromEntries(Object.entries(o.words).map(([k, v]) => [k, text(v)])) : o.words;
    const schedule = o.schedule === undefined || (Array.isArray(o.schedule) && o.schedule.length === 0) ? null
      : Array.isArray(o.schedule) ? o.schedule.map((r: unknown) => Array.isArray(r) ? r.map(text) : r) : o.schedule;
    return { ...o, theme: text(o.theme), style: typeof o.style === 'string' ? o.style.trim().toLowerCase() : o.style, words, schedule };
  }) };
}

export function verifyDesignDraftView(value: unknown): DesignDraftView {
  if (!isObject(value) || !exactKeys(value, ['id', 'status', 'reason', 'brief', 'mine', 'draft', 'problems', 'createdAt', 'updatedAt'])) return fail('view');
  const v = value;
  if (typeof v.id !== 'string' || !UUID.test(v.id) || typeof v.status !== 'string' || !(MERCH_AI_STATUSES as readonly string[]).includes(v.status)
    || !(v.reason === null || (typeof v.reason === 'string' && (MERCH_AI_REASONS as readonly string[]).includes(v.reason))) || typeof v.mine !== 'boolean'
    || typeof v.createdAt !== 'string' || !ISO.test(v.createdAt) || typeof v.updatedAt !== 'string' || !ISO.test(v.updatedAt)
    || !Array.isArray(v.problems) || v.problems.some(x => typeof x !== 'string' || x.length < 1 || x.length > 160)) return fail('view');
  const brief = validateDesignDraftBrief(v.brief);
  const open = v.status === 'RESULT_RECORDED' || v.status === 'APPLIED';
  if (!open && v.draft !== null) return fail('view');
  return { id: v.id, status: v.status as MerchAiStatus, reason: v.reason as MerchAiReason | null, brief, mine: v.mine, draft: open ? validateDesignDraft(v.draft) : null,
    problems: v.problems as string[], createdAt: v.createdAt, updatedAt: v.updatedAt };
}
export function verifyDesignDraftList(value: unknown): DesignDraftView[] {
  if (!Array.isArray(value) || value.length > 5) return fail('list');
  return value.map(verifyDesignDraftView);
}
