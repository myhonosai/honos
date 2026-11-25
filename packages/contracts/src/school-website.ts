// WB2 (0361): school websites. A site is one validated document (theme + pages + typed sections from a closed library)
// that HON renders with escaped components. There is no HTML, script or style in a document, and no visitor data in
// a site: forms and booking buttons point at the school's own published lead forms (0075) and booking types (0286).
// The same rules are checked again by hon.school_website_document_ok in the database.

/** The first five follow proven martial arts school sites; NEON_GRID, EDITORIAL and BENTO (0660) show off a modern product look. */
export const WEBSITE_TEMPLATES = ['MODERN_CLEAN', 'FAMILY_FRIENDLY', 'BOLD_POWERFUL', 'TRADITIONAL', 'HIGH_CONVERSION', 'NEON_GRID', 'EDITORIAL', 'BENTO'] as const;
export type WebsiteTemplate = typeof WEBSITE_TEMPLATES[number];
export const WEBSITE_FONTS = ['MODERN', 'FRIENDLY', 'BOLD', 'CLASSIC', 'TECH', 'EDITORIAL'] as const;
export type WebsiteFont = typeof WEBSITE_FONTS[number];
export const WEBSITE_PAGE_KINDS = ['HOME', 'PROGRAM', 'LANDING', 'PROMOTION', 'CUSTOM'] as const;
export type WebsitePageKind = typeof WEBSITE_PAGE_KINDS[number];
export const WEBSITE_PALETTE_KEYS = ['primary', 'accent', 'background', 'surface', 'text'] as const;
export const WEBSITE_STATUSES = ['DRAFT', 'PUBLISHED', 'UNPUBLISHED'] as const;
export type WebsiteStatus = typeof WEBSITE_STATUSES[number];

export const WEBSITE_MAX_PAGES = 20;
export const WEBSITE_MAX_SECTIONS = 30;
export const WEBSITE_MAX_ITEMS = 24;
export const WEBSITE_MAX_DOCUMENT_BYTES = 262144;
export const WEBSITE_SCHEMA_VERSION = 1;

/** Field kinds: line = one line of text; para = text that may hold line breaks; href = '', https URL, '/' or '/page-slug', or '#section-id'. */
type Field = { kind: 'line' | 'para'; max: number } | { kind: 'href' } | { kind: 'image' } | { kind: 'publicId' } | { kind: 'enum'; values: readonly string[] };
type ItemSpec = Record<string, Field>;
interface SectionSpec { fields: Record<string, Field>; items?: { max: number; fields: ItemSpec } }
const line = (max: number): Field => ({ kind: 'line', max });
const para = (max: number): Field => ({ kind: 'para', max });
const href: Field = { kind: 'href' };
const image: Field = { kind: 'image' };

/** The closed section library. Every listed field is present in a section (strings may be empty unless noted). */
export const WEBSITE_SECTION_SPECS = {
  HERO: { fields: { heading: line(120), subheading: para(300), ctaLabel: line(40), ctaHref: href, imageUrl: image, layout: { kind: 'enum', values: ['CENTER', 'SPLIT'] } } },
  PROGRAMS: { fields: { heading: line(120), intro: para(400) }, items: { max: 12, fields: { name: line(80), ages: line(40), description: para(400), imageUrl: image } } },
  SCHEDULE: { fields: { heading: line(120), note: para(600) }, items: { max: WEBSITE_MAX_ITEMS, fields: { day: line(20), time: line(40), className: line(80) } } },
  TRIAL_CTA: { fields: { heading: line(120), body: para(400), ctaLabel: line(40), ctaHref: href } },
  LEAD_FORM: { fields: { heading: line(120), body: para(400), publicFormId: { kind: 'publicId' } } },
  BOOKING: { fields: { heading: line(120), body: para(400), ctaLabel: line(40), bookingPublicId: { kind: 'publicId' } } },
  FAQ: { fields: { heading: line(120) }, items: { max: 20, fields: { question: line(200), answer: para(1000) } } },
  TESTIMONIALS: { fields: { heading: line(120) }, items: { max: 12, fields: { quote: para(500), author: line(80) } } },
  INSTRUCTORS: { fields: { heading: line(120) }, items: { max: 12, fields: { name: line(80), title: line(80), bio: para(500), imageUrl: image } } },
  TEXT: { fields: { heading: line(120), body: para(4000) } },
  IMAGE: { fields: { imageUrl: image, alt: line(200), caption: line(200) } },
  VIDEO: { fields: { provider: { kind: 'enum', values: ['YOUTUBE', 'VIMEO'] }, videoId: line(20), title: line(120) } },
  CONTACT: { fields: { heading: line(120), address: para(300), phone: line(40), email: line(254), hours: para(300) } },
  PROMO_BANNER: { fields: { text: line(200), ctaLabel: line(40), ctaHref: href } },
  CHAT: { fields: { heading: line(120), body: para(300) } },
} as const satisfies Record<string, SectionSpec>;
export type WebsiteSectionType = keyof typeof WEBSITE_SECTION_SPECS;
export const WEBSITE_SECTION_TYPES = Object.keys(WEBSITE_SECTION_SPECS) as WebsiteSectionType[];

export interface WebsiteSection { id: string; type: WebsiteSectionType; props: Record<string, unknown> }
export interface WebsitePage {
  slug: string; kind: WebsitePageKind; title: string; inNav: boolean;
  seo: { title: string; description: string }; campaignId: string | null; sections: WebsiteSection[];
}
export interface WebsiteTheme { template: WebsiteTemplate; font: WebsiteFont; logoUrl: string; palette: Record<typeof WEBSITE_PALETTE_KEYS[number], string> }
export interface WebsiteDocument { schemaVersion: 1; theme: WebsiteTheme; pages: WebsitePage[] }

export interface WebsiteVersionSummary { version: number; source: 'PUBLISH' | 'ROLLBACK'; note: string; publishedAt: string; rolledBackFrom: number | null }
export interface SchoolWebsite {
  id: string; publicSlug: string; name: string; status: WebsiteStatus; draftRevision: number; publishedVersion: number | null;
  draft: WebsiteDocument; versions: WebsiteVersionSummary[]; createdAt: string; updatedAt: string;
}
/** The current school's site, or none yet. */
export interface SchoolWebsiteRead { website: SchoolWebsite | null; templates: readonly WebsiteTemplate[] }
export interface PublishedSchoolWebsite { publicSlug: string; schoolName: string; version: number; document: WebsiteDocument }

export interface CreateSchoolWebsiteInput { publicSlug: string; name: string; document: WebsiteDocument }
export interface SaveSchoolWebsiteDraftInput { expectedRevision: number; name: string; document: WebsiteDocument }
export interface PublishSchoolWebsiteInput { expectedRevision: number; note: string }
export interface RollbackSchoolWebsiteInput { expectedRevision: number; version: number; note: string }
export interface UnpublishSchoolWebsiteInput { expectedRevision: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX = /^#[0-9a-f]{6}$/;
export const WEBSITE_SLUG = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;
export const WEBSITE_PAGE_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const WEBSITE_SECTION_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
/** Pages HON adds to every published school site (privacy policy and terms); an owner page cannot take these addresses. */
export const WEBSITE_BUILT_IN_PAGE_SLUGS = ['privacy', 'terms'] as const;
export function websiteBuiltInPageSlug(slug: unknown): boolean {
  return typeof slug === 'string' && (WEBSITE_BUILT_IN_PAGE_SLUGS as readonly string[]).includes(slug);
}
export const WEBSITE_RESERVED_SLUGS = ['admin', 'api', 'app', 'hq', 'hon', 'staff', 'www', 'sites', 'static', 'assets', 'login', 'auth', 'support', 'help', 'mail', 'test'] as const;
const HTTPS = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/]*)?(?:\?[A-Za-z0-9\-._~%!$&'()*+,;=:@/?]*)?(?:#[A-Za-z0-9\-._~%!$&'()*+,;=:@/?]*)?$/;
const PUBLIC_ID = /^[a-f0-9]{48}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;
// Control characters (newline allowed only in paragraphs), bidi controls, zero-width characters and BOM.
const BAD_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029​-‏‪-‮⁠-⁯﻿]/;
const BAD_PARA = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029​-‏‪-‮⁠-⁯﻿]/;

function utf8Bytes(text: string): number {
  let n = 0;
  for (const ch of text) { const c = ch.codePointAt(0)!; n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  return n;
}
/** The document as PostgreSQL prints jsonb (", " and ": " separators), so the size limit matches the database's. */
function jsonbText(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(jsonbText).join(', ') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).map(([k, v]) => JSON.stringify(k) + ': ' + jsonbText(v)).join(', ') + '}';
  return JSON.stringify(value) ?? 'null';
}
function fail(what: string): never { throw new Error(`Invalid website ${what}.`); }
function object(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(what);
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail(what);
  return value as Record<string, unknown>;
}
export function websiteHrefOk(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value === '' || value === '/') return true;
  if (value.startsWith('/')) return WEBSITE_PAGE_SLUG.test(value.slice(1));
  if (value.startsWith('#')) return WEBSITE_SECTION_ID.test(value.slice(1));
  return value.length <= 500 && HTTPS.test(value);
}
/**
 * 0660: HON's own starter art, made once with Higgsfield and shipped with the app under /site-art/. Templates start with
 * it so a new site never looks empty. Children appear only in illustrations, never in photographs. The list is closed and
 * mirrored by the database validator; a school's own images stay https.
 */
export const WEBSITE_STARTER_ART = ['hero-bold', 'hero-family', 'hero-traditional', 'hero-modern', 'hero-conversion', 'program-little', 'program-kids', 'program-adults', 'hero-neon', 'hero-editorial', 'hero-bento'] as const;
export type WebsiteStarterArt = (typeof WEBSITE_STARTER_ART)[number];
export function websiteStarterArtUrl(name: WebsiteStarterArt): string { return `/site-art/${name}.webp`; }
const STARTER_ART_URLS: readonly string[] = WEBSITE_STARTER_ART.map(websiteStarterArtUrl);
export function websiteImageOk(value: unknown): boolean {
  return typeof value === 'string' && (value === '' || STARTER_ART_URLS.includes(value) || (value.length <= 500 && HTTPS.test(value)));
}
export function websiteSlugOk(value: unknown): value is string {
  return typeof value === 'string' && WEBSITE_SLUG.test(value) && !value.includes('--') && !(WEBSITE_RESERVED_SLUGS as readonly string[]).includes(value);
}
function fieldOk(field: Field, value: unknown): boolean {
  switch (field.kind) {
    case 'line': return typeof value === 'string' && value.length <= field.max && !BAD_LINE.test(value);
    case 'para': return typeof value === 'string' && value.length <= field.max && !BAD_PARA.test(value);
    case 'href': return websiteHrefOk(value);
    case 'image': return websiteImageOk(value);
    case 'publicId': return typeof value === 'string' && (value === '' || PUBLIC_ID.test(value));
    case 'enum': return typeof value === 'string' && field.values.includes(value);
  }
}
function sectionOk(value: unknown): WebsiteSection {
  const s = object(value, ['id', 'type', 'props'], 'section');
  if (typeof s.id !== 'string' || !WEBSITE_SECTION_ID.test(s.id)) fail('section id');
  if (typeof s.type !== 'string' || !(s.type in WEBSITE_SECTION_SPECS)) fail('section type');
  const spec: SectionSpec = WEBSITE_SECTION_SPECS[s.type as WebsiteSectionType];
  const keys = [...Object.keys(spec.fields), ...(spec.items ? ['items'] : [])];
  const props = object(s.props, keys, 'section fields');
  for (const [name, field] of Object.entries(spec.fields)) if (!fieldOk(field, props[name])) fail(`${s.type} ${name}`);
  if (s.type === 'VIDEO' && !VIDEO_ID.test(String(props.videoId))) fail('video id');
  if (spec.items) {
    const items = props.items;
    if (!Array.isArray(items) || items.length > spec.items.max) fail(`${s.type} items`);
    for (const item of items) {
      const i = object(item, Object.keys(spec.items.fields), `${s.type} item`);
      for (const [name, field] of Object.entries(spec.items.fields)) if (!fieldOk(field, i[name])) fail(`${s.type} item ${name}`);
    }
  }
  return s as unknown as WebsiteSection;
}
function pageOk(value: unknown): WebsitePage {
  const p = object(value, ['slug', 'kind', 'title', 'inNav', 'seo', 'campaignId', 'sections'], 'page');
  if (typeof p.slug !== 'string' || !WEBSITE_PAGE_SLUG.test(p.slug)) fail('page slug');
  if (typeof p.kind !== 'string' || !(WEBSITE_PAGE_KINDS as readonly string[]).includes(p.kind)) fail('page kind');
  if (!fieldOk(line(120), p.title) || !(p.title as string).trim()) fail('page title');
  if (typeof p.inNav !== 'boolean') fail('page navigation flag');
  const seo = object(p.seo, ['title', 'description'], 'page search settings');
  if (!fieldOk(line(70), seo.title) || !fieldOk(line(160), seo.description)) fail('page search settings');
  if (p.campaignId !== null && (typeof p.campaignId !== 'string' || !UUID.test(p.campaignId) || !['LANDING', 'PROMOTION'].includes(p.kind))) fail('page campaign');
  if (!Array.isArray(p.sections) || p.sections.length < 1 || p.sections.length > WEBSITE_MAX_SECTIONS) fail('page sections');
  const sections = p.sections.map(sectionOk);
  if (new Set(sections.map(s => s.id)).size !== sections.length) fail('section ids');
  return p as unknown as WebsitePage;
}
/** Throws unless the value is a complete, closed website document within every limit. */
export function validateWebsiteDocument(value: unknown): WebsiteDocument {
  const d = object(value, ['schemaVersion', 'theme', 'pages'], 'document');
  if (d.schemaVersion !== WEBSITE_SCHEMA_VERSION) fail('schema version');
  const t = object(d.theme, ['template', 'font', 'logoUrl', 'palette'], 'theme');
  if (typeof t.template !== 'string' || !(WEBSITE_TEMPLATES as readonly string[]).includes(t.template)) fail('template');
  if (typeof t.font !== 'string' || !(WEBSITE_FONTS as readonly string[]).includes(t.font)) fail('font');
  if (!websiteImageOk(t.logoUrl)) fail('logo');
  const palette = object(t.palette, WEBSITE_PALETTE_KEYS, 'palette');
  for (const k of WEBSITE_PALETTE_KEYS) if (typeof palette[k] !== 'string' || !HEX.test(palette[k] as string)) fail('palette colour');
  if (!Array.isArray(d.pages) || d.pages.length < 1 || d.pages.length > WEBSITE_MAX_PAGES) fail('pages');
  const pages = d.pages.map(pageOk);
  if (new Set(pages.map(p => p.slug)).size !== pages.length) fail('page slugs');
  if (pages[0]!.slug !== 'home' || pages[0]!.kind !== 'HOME' || pages.filter(p => p.kind === 'HOME').length !== 1) fail('home page');
  if (utf8Bytes(jsonbText(value)) > WEBSITE_MAX_DOCUMENT_BYTES) fail('document size');
  for (const page of pages) for (const s of page.sections) {
    const fields: Record<string, Field> = WEBSITE_SECTION_SPECS[s.type].fields;
    for (const [name, v] of Object.entries(s.props)) {
      if (fields[name]?.kind !== 'href') continue;
      if (typeof v === 'string' && v.startsWith('/') && v !== '/' && !pages.some(p => '/' + p.slug === v)) fail('link to a missing page');
    }
  }
  return value as WebsiteDocument;
}

function note(value: unknown): string {
  if (!fieldOk(line(200), value)) throw new Error('VALIDATION_FAILED');
  return value as string;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 999999998) throw new Error('VALIDATION_FAILED');
  return value as number;
}
function closedInput(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error('VALIDATION_FAILED');
  return value as Record<string, unknown>;
}
function siteName(value: unknown): string {
  if (!fieldOk(line(120), value) || !(value as string).trim() || (value as string).trim() !== value) throw new Error('VALIDATION_FAILED');
  return value as string;
}
/**
 * A document an owner saves: the full document rules plus no page at a built-in address. Enforced here (API input) only;
 * the 0361 database rule does not know these addresses, so a site published earlier with such a page still reads and the
 * built-in page takes that address.
 */
function ownerDocument(value: unknown): WebsiteDocument {
  const doc = validateWebsiteDocument(value);
  if (doc.pages.some(page => websiteBuiltInPageSlug(page.slug))) throw new Error('VALIDATION_FAILED');
  return doc;
}
export function validateCreateSchoolWebsiteInput(value: unknown): CreateSchoolWebsiteInput {
  const v = closedInput(value, ['publicSlug', 'name', 'document']);
  if (!websiteSlugOk(v.publicSlug)) throw new Error('VALIDATION_FAILED');
  return { publicSlug: v.publicSlug, name: siteName(v.name), document: ownerDocument(v.document) };
}
export function validateSaveSchoolWebsiteDraftInput(value: unknown): SaveSchoolWebsiteDraftInput {
  const v = closedInput(value, ['expectedRevision', 'name', 'document']);
  return { expectedRevision: revision(v.expectedRevision), name: siteName(v.name), document: ownerDocument(v.document) };
}
export function validatePublishSchoolWebsiteInput(value: unknown): PublishSchoolWebsiteInput {
  const v = closedInput(value, ['expectedRevision', 'note']);
  return { expectedRevision: revision(v.expectedRevision), note: note(v.note) };
}
export function validateRollbackSchoolWebsiteInput(value: unknown): RollbackSchoolWebsiteInput {
  const v = closedInput(value, ['expectedRevision', 'version', 'note']);
  return { expectedRevision: revision(v.expectedRevision), version: revision(v.version), note: note(v.note) };
}
export function validateUnpublishSchoolWebsiteInput(value: unknown): UnpublishSchoolWebsiteInput {
  const v = closedInput(value, ['expectedRevision']);
  return { expectedRevision: revision(v.expectedRevision) };
}

function verifyVersion(value: unknown): WebsiteVersionSummary {
  const v = object(value, ['version', 'source', 'note', 'publishedAt', 'rolledBackFrom'], 'version');
  if (!Number.isSafeInteger(v.version) || (v.version as number) < 1 || !['PUBLISH', 'ROLLBACK'].includes(v.source as string)
    || typeof v.note !== 'string' || typeof v.publishedAt !== 'string' || !ISO.test(v.publishedAt)
    || (v.rolledBackFrom !== null && !Number.isSafeInteger(v.rolledBackFrom))) fail('version');
  return v as unknown as WebsiteVersionSummary;
}
export function verifySchoolWebsite(value: unknown): SchoolWebsite {
  const w = object(value, ['id', 'publicSlug', 'name', 'status', 'draftRevision', 'publishedVersion', 'draft', 'versions', 'createdAt', 'updatedAt'], 'record');
  if (typeof w.id !== 'string' || !UUID.test(w.id) || !websiteSlugOk(w.publicSlug) || typeof w.name !== 'string'
    || !(WEBSITE_STATUSES as readonly string[]).includes(w.status as string) || !Number.isSafeInteger(w.draftRevision) || (w.draftRevision as number) < 1
    || (w.publishedVersion !== null && !Number.isSafeInteger(w.publishedVersion)) || ((w.status === 'PUBLISHED') !== (w.publishedVersion !== null))
    || typeof w.createdAt !== 'string' || !ISO.test(w.createdAt) || typeof w.updatedAt !== 'string' || !ISO.test(w.updatedAt)
    || !Array.isArray(w.versions) || w.versions.length > 100) fail('record');
  validateWebsiteDocument(w.draft);
  w.versions.forEach(verifyVersion);
  return w as unknown as SchoolWebsite;
}
export function verifySchoolWebsiteRead(value: unknown): SchoolWebsiteRead {
  const r = object(value, ['website', 'templates'], 'read');
  if (!Array.isArray(r.templates) || r.templates.join(',') !== WEBSITE_TEMPLATES.join(',')) fail('read');
  if (r.website !== null) verifySchoolWebsite(r.website);
  return r as unknown as SchoolWebsiteRead;
}
export function verifyPublishedSchoolWebsite(value: unknown, slug: string): PublishedSchoolWebsite {
  const p = object(value, ['publicSlug', 'schoolName', 'version', 'document'], 'published site');
  if (p.publicSlug !== slug || typeof p.schoolName !== 'string' || !p.schoolName || p.schoolName.length > 200
    || !Number.isSafeInteger(p.version) || (p.version as number) < 1) fail('published site');
  const doc = validateWebsiteDocument(p.document);
  // Internal identifiers stay inside HON: the public copy never carries a campaign id.
  if (doc.pages.some(page => page.campaignId !== null)) fail('published site');
  return p as unknown as PublishedSchoolWebsite;
}
