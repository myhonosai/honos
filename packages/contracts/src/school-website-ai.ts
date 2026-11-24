import {
  WEBSITE_FONTS, WEBSITE_PAGE_KINDS, WEBSITE_PAGE_SLUG, WEBSITE_PALETTE_KEYS, WEBSITE_SECTION_SPECS, WEBSITE_SECTION_TYPES, WEBSITE_TEMPLATES,
  type WebsiteDocument, type WebsitePageKind, type WebsiteSectionType,
} from './school-website.js';
import { applyWebsiteEdit, type WebsiteEdit } from './school-website-templates.js';

/**
 * WB5 (0550): AI website edits. The owner asks in words; Marcus answers with a summary and a closed list of edits.
 * A proposal changes nothing until the owner applies it, which is an ordinary draft save (0361) that re-validates the
 * whole document. These rules keep the AI to text and layout: it can never choose an image, a form or booking page, or a
 * link that leaves the site, because it could invent one. The owner sets those in the editor.
 */
export const WEBSITE_AI_LIMITS = { inputTokens: 16000, outputTokens: 4000, maxProviderCostMicrounits: 150000, maxEdits: 25, maxResultBytes: 24576 } as const;
export const WEBSITE_AI_OPS = ['setText', 'addSection', 'removeSection', 'moveSection', 'addPage', 'removePage', 'setPage', 'setTheme'] as const;
export type WebsiteAiOp = typeof WEBSITE_AI_OPS[number];
export const WEBSITE_AI_STATUSES = ['PENDING', 'CONFIGURATION_REQUIRED', 'BLOCKED', 'SENDING', 'UNKNOWN', 'FAILED', 'RESULT_RECORDED', 'RESULT_REJECTED', 'APPLIED', 'DISMISSED'] as const;
export type WebsiteAiStatus = typeof WEBSITE_AI_STATUSES[number];
export const WEBSITE_AI_REASONS = ['CONFIGURATION_REQUIRED', 'NO_ELIGIBLE_ROUTE', 'CUSTOMER_BUDGET_EXCEEDED', 'AI_SPEND_STOPPED', 'UNSUPPORTED_PROVIDER',
  'INVALID_REQUEST', 'PROVIDER_REJECTED', 'PROVIDER_UNKNOWN', 'ROUTE_STALE', 'RESULT_BUDGET_EXCEEDED', 'RESULT_INVALID', 'SUBJECT_STALE', 'GATE_CLOSED',
  // 0670: an edit paid from creative credits that could not reserve them (nothing was sent).
  'CREATIVE_CREDITS_EXHAUSTED', 'CREATIVE_NOT_PRICED', 'CREATIVE_NOT_ELIGIBLE', 'CREATIVE_EDIT_IN_PROGRESS'] as const;
export type WebsiteAiReason = typeof WEBSITE_AI_REASONS[number];
/**
 * 0670: what the next AI website edit is paid with. CREATIVE_CREDITS when the creative program is on, the school is
 * eligible for creative credits and HQ published the website rate; otherwise INCLUDED_AI (the 0550 allowance), which is
 * what trial and unpaid schools use. Owner decisions 2026-11-24.
 */
export type WebsiteAiPrice =
  | { paidWith: 'CREATIVE_CREDITS'; creditsPerEdit: number; availableCredits: number }
  | { paidWith: 'INCLUDED_AI'; creditsPerEdit: null; availableCredits: null };
export function verifyWebsiteAiPrice(value: unknown): WebsiteAiPrice {
  const fail = (): never => { throw new Error('SCHOOL_WEBSITE_AI_RESPONSE_DRIFT'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join() !== 'availableCredits,creditsPerEdit,paidWith') fail();
  const count = (n: unknown, min: number) => Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= 1_000_000_000;
  if (v.paidWith === 'INCLUDED_AI' && v.creditsPerEdit === null && v.availableCredits === null) return { paidWith: 'INCLUDED_AI', creditsPerEdit: null, availableCredits: null };
  if (v.paidWith === 'CREATIVE_CREDITS' && count(v.creditsPerEdit, 1) && count(v.availableCredits, 0))
    return { paidWith: 'CREATIVE_CREDITS', creditsPerEdit: v.creditsPerEdit as number, availableCredits: v.availableCredits as number };
  return fail();
}

type Props = Record<string, unknown>;
export type WebsiteAiEdit =
  | { op: 'setText'; page: string; section: string; prop: string; value: unknown }
  | { op: 'addSection'; page: string; type: WebsiteSectionType; after: string | null; props?: Props }
  | { op: 'removeSection'; page: string; section: string }
  | { op: 'moveSection'; page: string; section: string; by: -1 | 1 }
  | { op: 'addPage'; slug: string; title: string; kind: 'PROGRAM' | 'LANDING' | 'PROMOTION' | 'CUSTOM'; sections?: { type: WebsiteSectionType; props?: Props }[] }
  | { op: 'removePage'; page: string }
  | { op: 'setPage'; page: string; title?: string; inNav?: boolean; seo?: { title?: string; description?: string } }
  | { op: 'setTheme'; template?: string; font?: string; palette?: Partial<Record<typeof WEBSITE_PALETTE_KEYS[number], string>> };
export interface WebsiteAiProposal { summary: string; edits: WebsiteAiEdit[] }
export interface WebsiteAiEditRequest { expectedRevision: number; request: string }
export interface WebsiteAiEditView {
  id: string; status: WebsiteAiStatus; reason: WebsiteAiReason | null; request: string; baseRevision: number; mine: boolean;
  summary: string | null; edits: WebsiteAiEdit[] | null; problems: string[]; createdAt: string; updatedAt: string;
}
export interface WebsiteAiApplyInput { expectedRevision: number }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keysWithin = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(k => allowed.includes(k));
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
const SECRETISH = /(-----BEGIN|Bearer\s+|\bsk[-_][A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_-]+\.eyJ|(?:api[ _-]?key|password|secret|authorization)\s*[:=])/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bytes = (v: unknown) => { const s = JSON.stringify(v); let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3; } return n; };

/** The owner's request: the draft revision it is about and up to 1,000 characters of plain text. */
export function validateWebsiteAiEditRequest(value: unknown): WebsiteAiEditRequest {
  if (!isObject(value) || Object.keys(value).sort().join(',') !== 'expectedRevision,request') throw new Error('Invalid website AI request.');
  const { expectedRevision, request } = value;
  if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1 || (expectedRevision as number) > 999999999) throw new Error('Invalid website AI request.');
  if (typeof request !== 'string' || request !== request.trim() || request.length < 1 || request.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(request) || SECRETISH.test(request)) throw new Error('Invalid website AI request.');
  return { expectedRevision: expectedRevision as number, request };
}
export function validateWebsiteAiApplyInput(value: unknown): WebsiteAiApplyInput {
  if (!isObject(value) || Object.keys(value).join(',') !== 'expectedRevision' || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 1) throw new Error('Invalid website AI apply.');
  return { expectedRevision: value.expectedRevision as number };
}

/** The closed shape the database stores (0550 hon.school_website_ai_proposal_ok). Field values are checked when applied. */
export function validateWebsiteAiProposal(value: unknown): WebsiteAiProposal {
  if (!isObject(value) || Object.keys(value).sort().join(',') !== 'edits,summary') throw new Error('Invalid website proposal.');
  const { summary, edits } = value;
  if (typeof summary !== 'string' || summary.length < 1 || summary.length > 300 || CONTROL.test(summary.replace(/\n/g, ' '))) throw new Error('Invalid website proposal.');
  if (!Array.isArray(edits) || edits.length > WEBSITE_AI_LIMITS.maxEdits) throw new Error('Invalid website proposal.');
  for (const e of edits) if (!isObject(e) || typeof e.op !== 'string' || !(WEBSITE_AI_OPS as readonly string[]).includes(e.op) || JSON.stringify(e).length > 4000) throw new Error('Invalid website proposal.');
  if (bytes(value) > WEBSITE_AI_LIMITS.maxResultBytes) throw new Error('Invalid website proposal.');
  return { summary, edits: edits as WebsiteAiEdit[] };
}

/** The AI may set text, choices and links inside the site only. Images, form and booking links stay the owner's. */
function aiValueOk(type: WebsiteSectionType, prop: string, value: unknown): boolean {
  const spec = WEBSITE_SECTION_SPECS[type] as { fields: Record<string, { kind: string }>; items?: { fields: Record<string, { kind: string }> } };
  if (prop === 'items' && spec.items) {
    if (!Array.isArray(value)) return false;
    return value.every(item => isObject(item) && Object.entries(item).every(([k, v]) => { const f = spec.items!.fields[k]; return !!f && fieldOk(f.kind, v); }));
  }
  const field = spec.fields[prop];
  return !!field && fieldOk(field.kind, value);
}
const LOCKED = ['image', 'publicId'];
function fieldOk(kind: string, value: unknown): boolean {
  if (kind === 'image' || kind === 'publicId') return value === '';
  if (kind === 'href') return typeof value === 'string' && (value === '' || value === '/' || /^\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(value) || /^#[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(value));
  return true; // text and choices: the document validator decides
}

export interface WebsiteAiApplied { document: WebsiteDocument; applied: number; problems: string[] }
/**
 * Applies a proposal to a draft one edit at a time. An edit that does not fit is skipped and named in problems; the rest
 * still apply. The result is a valid document (each step is re-validated) that the owner previews before saving.
 */
export function applyWebsiteAiEdits(document: WebsiteDocument, edits: readonly unknown[]): WebsiteAiApplied {
  let doc = document, applied = 0; const problems: string[] = [];
  edits.forEach((raw, n) => {
    try { doc = applyOne(doc, raw); applied++; }
    catch { problems.push(`Change ${n + 1} (${isObject(raw) && typeof raw.op === 'string' ? raw.op.slice(0, 20) : 'unknown'}) could not be applied.`); }
  });
  return { document: doc, applied, problems: problems.slice(0, 50) };
}

function str(v: unknown, max = 60): string { if (typeof v !== 'string' || v.length > max) throw new Error('bad'); return v; }
function sectionType(v: unknown): WebsiteSectionType { if (typeof v !== 'string' || !(WEBSITE_SECTION_TYPES as string[]).includes(v)) throw new Error('bad'); return v as WebsiteSectionType; }
function setProps(doc: WebsiteDocument, page: string, section: string, type: WebsiteSectionType, props: unknown): WebsiteDocument {
  if (props === undefined) return doc;
  if (!isObject(props)) throw new Error('bad');
  for (const [prop, value] of Object.entries(props)) {
    if (!aiValueOk(type, prop, value)) throw new Error('bad');
    doc = applyWebsiteEdit(doc, { op: 'setSectionProp', page, section, prop, value });
  }
  return doc;
}
function added(before: WebsiteDocument, after: WebsiteDocument, page: string): string {
  const old = new Set(before.pages.find(p => p.slug === page)!.sections.map(s => s.id));
  const fresh = after.pages.find(p => p.slug === page)!.sections.find(s => !old.has(s.id));
  if (!fresh) throw new Error('bad'); return fresh.id;
}
function applyOne(doc: WebsiteDocument, raw: unknown): WebsiteDocument {
  if (!isObject(raw)) throw new Error('bad');
  const e = raw as Record<string, unknown>;
  switch (e.op) {
    case 'setText': {
      if (!keysWithin(e, ['op', 'page', 'section', 'prop', 'value'])) throw new Error('bad');
      const page = str(e.page), section = str(e.section), prop = str(e.prop, 40);
      const s = doc.pages.find(p => p.slug === page)?.sections.find(x => x.id === section);
      if (!s || !aiValueOk(s.type, prop, e.value)) throw new Error('bad');
      const spec = WEBSITE_SECTION_SPECS[s.type] as { fields: Record<string, { kind: string }>; items?: { fields: Record<string, { kind: string }> } };
      // An existing image, form, booking page or campaign is the owner's choice: the AI can neither set nor clear it.
      if (prop !== 'items' && LOCKED.includes(spec.fields[prop]!.kind)) throw new Error('bad');
      let value = e.value;
      if (prop === 'items' && spec.items) {
        const old = Array.isArray(s.props.items) ? s.props.items as Record<string, unknown>[] : [];
        value = (e.value as Record<string, unknown>[]).map((item, i) => {
          const kept: Record<string, unknown> = { ...item };
          for (const [k, f] of Object.entries(spec.items!.fields)) if (LOCKED.includes(f.kind)) kept[k] = old[i]?.[k] ?? '';
          return kept;
        });
      }
      return applyWebsiteEdit(doc, { op: 'setSectionProp', page, section, prop, value });
    }
    case 'addSection': {
      if (!keysWithin(e, ['op', 'page', 'type', 'after', 'props'])) throw new Error('bad');
      const page = str(e.page), type = sectionType(e.type), after = e.after === null || e.after === undefined ? null : str(e.after);
      const next = applyWebsiteEdit(doc, { op: 'addSection', page, type, after });
      return setProps(next, page, added(doc, next, page), type, e.props);
    }
    case 'removeSection': {
      if (!keysWithin(e, ['op', 'page', 'section'])) throw new Error('bad');
      return applyWebsiteEdit(doc, { op: 'removeSection', page: str(e.page), section: str(e.section) });
    }
    case 'moveSection': {
      if (!keysWithin(e, ['op', 'page', 'section', 'by']) || (e.by !== 1 && e.by !== -1)) throw new Error('bad');
      return applyWebsiteEdit(doc, { op: 'moveSection', page: str(e.page), section: str(e.section), by: e.by });
    }
    case 'addPage': {
      if (!keysWithin(e, ['op', 'slug', 'title', 'kind', 'sections'])) throw new Error('bad');
      const slug = str(e.slug, 40), title = str(e.title, 80), kind = e.kind;
      if (!WEBSITE_PAGE_SLUG.test(slug) || typeof kind !== 'string' || kind === 'HOME' || !(WEBSITE_PAGE_KINDS as readonly string[]).includes(kind)) throw new Error('bad');
      let next = applyWebsiteEdit(doc, { op: 'addPage', slug, title, kind: kind as Exclude<WebsitePageKind, 'HOME'> });
      const list = e.sections === undefined ? [] : e.sections;
      if (!Array.isArray(list) || list.length > 12) throw new Error('bad');
      list.forEach((raw, i) => {
        if (!isObject(raw) || !keysWithin(raw, ['type', 'props'])) throw new Error('bad');
        const type = sectionType(raw.type);
        // The new page starts with a hero; a first HERO in the list fills it instead of adding a second one.
        if (i === 0 && type === 'HERO') { next = setProps(next, slug, 'hero', type, raw.props); return; }
        const before = next; next = applyWebsiteEdit(next, { op: 'addSection', page: slug, type, after: null });
        next = setProps(next, slug, added(before, next, slug), type, raw.props);
      });
      return next;
    }
    case 'removePage': {
      if (!keysWithin(e, ['op', 'page'])) throw new Error('bad');
      return applyWebsiteEdit(doc, { op: 'removePage', page: str(e.page) });
    }
    case 'setPage': {
      if (!keysWithin(e, ['op', 'page', 'title', 'inNav', 'seo'])) throw new Error('bad');
      const page = doc.pages.find(p => p.slug === e.page); if (!page) throw new Error('bad');
      const seo = e.seo === undefined ? {} : e.seo; if (!isObject(seo) || !keysWithin(seo, ['title', 'description'])) throw new Error('bad');
      if (e.inNav !== undefined && typeof e.inNav !== 'boolean') throw new Error('bad');
      return applyWebsiteEdit(doc, { op: 'setPage', page: page.slug, title: e.title === undefined ? page.title : str(e.title, 80), inNav: e.inNav === undefined ? page.inNav : e.inNav as boolean,
        seo: { title: seo.title === undefined ? page.seo.title : str(seo.title, 70), description: seo.description === undefined ? page.seo.description : str(seo.description, 160) } });
    }
    case 'setTheme': {
      if (!keysWithin(e, ['op', 'template', 'font', 'palette'])) throw new Error('bad');
      if (e.template !== undefined && !(WEBSITE_TEMPLATES as readonly unknown[]).includes(e.template)) throw new Error('bad');
      if (e.font !== undefined && !(WEBSITE_FONTS as readonly unknown[]).includes(e.font)) throw new Error('bad');
      if (e.palette !== undefined && (!isObject(e.palette) || !keysWithin(e.palette, WEBSITE_PALETTE_KEYS))) throw new Error('bad');
      return applyWebsiteEdit(doc, { op: 'setTheme', theme: { ...(e.template ? { template: e.template as never } : {}), ...(e.font ? { font: e.font as never } : {}), ...(e.palette ? { palette: e.palette as never } : {}) } });
    }
    default: throw new Error('bad');
  }
}

/** Server responses. */
export function verifyWebsiteAiEditView(value: unknown): WebsiteAiEditView {
  if (!isObject(value)) throw new Error('Invalid website AI view.');
  const keys = ['baseRevision', 'createdAt', 'edits', 'id', 'mine', 'problems', 'reason', 'request', 'status', 'summary', 'updatedAt'];
  const v = value as Record<string, unknown>;
  const extra = Object.keys(v).filter(k => !keys.includes(k) && k !== 'recorded');
  if (extra.length || keys.some(k => !Object.hasOwn(v, k))) throw new Error('Invalid website AI view.');
  if (typeof v.id !== 'string' || !UUID.test(v.id) || !(WEBSITE_AI_STATUSES as readonly unknown[]).includes(v.status)
    || !(v.reason === null || (WEBSITE_AI_REASONS as readonly unknown[]).includes(v.reason)) || typeof v.request !== 'string'
    || !Number.isSafeInteger(v.baseRevision) || typeof v.mine !== 'boolean' || !(v.summary === null || typeof v.summary === 'string')
    || !(v.edits === null || Array.isArray(v.edits)) || !Array.isArray(v.problems) || !v.problems.every(p => typeof p === 'string')
    || typeof v.createdAt !== 'string' || !ISO.test(v.createdAt) || typeof v.updatedAt !== 'string' || !ISO.test(v.updatedAt)) throw new Error('Invalid website AI view.');
  return { id: v.id, status: v.status as WebsiteAiStatus, reason: v.reason as WebsiteAiReason | null, request: v.request, baseRevision: v.baseRevision as number,
    mine: v.mine, summary: v.summary as string | null, edits: v.edits as WebsiteAiEdit[] | null, problems: v.problems as string[], createdAt: v.createdAt, updatedAt: v.updatedAt };
}
export function verifyWebsiteAiEditList(value: unknown): WebsiteAiEditView[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('Invalid website AI list.');
  return value.map(verifyWebsiteAiEditView);
}
