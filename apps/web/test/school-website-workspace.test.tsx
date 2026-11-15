import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import {
  WEBSITE_TEMPLATES, applyWebsiteEdit, buildWebsiteFromTemplate, suggestWebsiteSlug, validateWebsiteDocument,
  type SchoolWebsite, type WebsiteDocument,
} from '@hon/contracts';
import { WebsiteView, type WebsiteViewProps } from '../src/components/school-website/view';
import { WebsiteError, websiteApi, websiteErrorFor, keepForRetry } from '../src/components/school-website/http';
import { websiteText } from '../src/components/school-website/copy';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const ORG = '11111111-1111-4111-8111-111111111111', SCHOOL = '22222222-2222-4222-8222-222222222222', KEY = '33333333-3333-4333-8333-333333333333';
const scope = { organizationId: ORG, schoolId: SCHOOL };

it('every template is a complete valid site filled with the school facts, and no template is AI or connects a form by itself', () => {
  for (const template of WEBSITE_TEMPLATES) {
    const doc = buildWebsiteFromTemplate(template, { schoolName: 'Tiger Dojo', phone: '+1 555 0100', email: 'hello@example.invalid', address: '1 Main St' });
    expect(() => validateWebsiteDocument(doc), template).not.toThrow();
    expect(doc.theme.template).toBe(template);
    expect(doc.pages[0]!.slug).toBe('home');
    expect(JSON.stringify(doc)).toContain('Tiger Dojo');
    const sections = doc.pages.flatMap(p => p.sections);
    expect(sections.filter(s => s.type === 'LEAD_FORM').every(s => s.props.publicFormId === '')).toBe(true);
    expect(sections.find(s => s.type === 'CONTACT')!.props.email).toBe('hello@example.invalid');
  }
  // Facts are cleaned: hidden characters and a bad email never reach the document.
  const odd = buildWebsiteFromTemplate('BOLD_POWERFUL', { schoolName: 'Ti\u202eger\u2028Dojo', email: 'not-an-email' });
  expect(JSON.stringify(odd)).not.toMatch(/\u202e|\u2028/);
  expect(odd.pages[0]!.sections.find(s => s.type === 'CONTACT')!.props.email).toBe('');
  expect(suggestWebsiteSlug('Tigér Dojo & Kids!')).toBe('tiger-dojo-kids');
  expect(suggestWebsiteSlug('K')).toBe('k-dojo');
});

it('edits are closed operations that always leave a valid document and never change the original', () => {
  const base = buildWebsiteFromTemplate('MODERN_CLEAN', { schoolName: 'Tiger Dojo' });
  const before = JSON.stringify(base);
  let d: WebsiteDocument = applyWebsiteEdit(base, { op: 'addPage', slug: 'halloween', title: 'Halloween camp', kind: 'PROMOTION' });
  expect(d.pages.at(-1)).toMatchObject({ slug: 'halloween', kind: 'PROMOTION', inNav: false });
  d = applyWebsiteEdit(d, { op: 'setSectionProp', page: 'home', section: 'hero', prop: 'ctaHref', value: '/halloween' });
  d = applyWebsiteEdit(d, { op: 'addSection', page: 'home', type: 'FAQ', after: 'hero' });
  expect(d.pages[0]!.sections.map(s => s.id).slice(0, 2)).toEqual(['hero', 'faq-2']);
  d = applyWebsiteEdit(d, { op: 'moveSection', page: 'home', section: 'faq-2', by: 1 });
  expect(d.pages[0]!.sections[2]!.id).toBe('faq-2');
  d = applyWebsiteEdit(d, { op: 'setTheme', theme: { font: 'CLASSIC', palette: { primary: '#000000' } } });
  expect(d.theme).toMatchObject({ font: 'CLASSIC', palette: { primary: '#000000', accent: '#f59e0b' } });
  // Removing a page empties links to it instead of leaving a broken link.
  d = applyWebsiteEdit(d, { op: 'removePage', page: 'halloween' });
  expect(d.pages[0]!.sections[0]!.props.ctaHref).toBe('');
  expect(JSON.stringify(base)).toBe(before);
  for (const bad of [
    { op: 'setSectionProp', page: 'home', section: 'hero', prop: 'ctaHref', value: 'javascript:alert(1)' },
    { op: 'setSectionProp', page: 'home', section: 'hero', prop: 'style', value: 'color:red' },
    { op: 'setSectionProp', page: 'home', section: 'hero', prop: 'heading', value: 'x'.repeat(121) },
    { op: 'setSectionProp', page: 'home', section: 'hero', prop: 'imageUrl', value: 'http://insecure.example.invalid/a.png' },
    { op: 'removePage', page: 'home' }, { op: 'addPage', slug: 'about', title: 'Again', kind: 'CUSTOM' },
    { op: 'moveSection', page: 'home', section: 'hero', by: -1 }, { op: 'setTheme', theme: { palette: { text: 'red' } } },
  ] as const) expect(() => applyWebsiteEdit(d, bad as never), JSON.stringify(bad)).toThrow(/Invalid website/);
});

const site = (patch: Partial<SchoolWebsite> = {}): SchoolWebsite => ({ id: '44444444-4444-4444-8444-444444444444', publicSlug: 'tiger-dojo', name: 'Tiger Dojo website', status: 'PUBLISHED',
  draftRevision: 4, publishedVersion: 2, draft: buildWebsiteFromTemplate('FAMILY_FRIENDLY', { schoolName: 'Tiger Dojo' }), createdAt: '2026-11-15T08:00:00.000Z', updatedAt: '2026-11-15T08:00:00.000Z',
  versions: [{ version: 2, source: 'PUBLISH', note: 'Fall update', publishedAt: '2026-11-15T09:00:00.000Z', rolledBackFrom: null },
    { version: 1, source: 'PUBLISH', note: '', publishedAt: '2026-11-15T08:30:00.000Z', rolledBackFrom: null }], ...patch });
const noop = () => undefined;
const props = (patch: Partial<WebsiteViewProps> = {}): WebsiteViewProps => {
  const w = site();
  return { language: 'en', locale: 'en-US', mode: 'modern', waiting: false, concealed: false, hasSchool: true, schoolName: 'Tiger Dojo',
    read: { state: 'READY', website: w }, draft: w.draft, name: w.name, dirty: false, start: { name: 'Tiger Dojo', slug: 'tiger-dojo', template: 'MODERN_CLEAN' },
    choices: { forms: [{ id: 'a'.repeat(48), label: 'Free class enquiry' }], bookings: [] }, tab: 'edit', device: 'desktop', pageSlug: 'home', sectionId: null,
    confirming: null, note: '', outcome: null, locked: false, canRetry: false, origin: 'https://app.example.invalid',
    on: { refresh: noop, start: noop, create: noop, tab: noop, device: noop, page: noop, section: noop, edit: noop, name: noop, note: noop, save: noop, discard: noop,
      publish: noop, confirm: noop, unpublish: noop, rollback: noop, retry: noop }, ...patch };
};

it('the workspace shows the start screen, then the editor with a draft preview, status, publish and history', () => {
  const start = renderToStaticMarkup(<WebsiteView {...props({ read: { state: 'READY', website: null }, draft: null })} />);
  for (const t of WEBSITE_TEMPLATES) expect(start).toContain(`data-template="${t}"`);
  expect(start).toContain('https://app.example.invalid/sites/tiger-dojo');
  expect(start).toContain('This is a template, not AI.');

  const editor = renderToStaticMarkup(<WebsiteView {...props()} />);
  expect(editor).toContain('Live');
  expect(editor).toContain('href="/sites/tiger-dojo"');
  expect(editor).toContain('data-mode="preview"');
  expect(editor).toContain('data-device="desktop"');
  expect(editor).toContain('Only you see this preview.');
  expect(editor).toContain('data-section-row="HERO"');
  expect(editor).toContain('All changes saved.');
  // A dirty draft cannot be published until it is saved.
  const dirty = renderToStaticMarkup(<WebsiteView {...props({ dirty: true })} />);
  expect(dirty).toContain('Save your changes before publishing.');
  expect(dirty).toMatch(/<button type="button" class="[^"]*" disabled="">Publish<\/button>/);
  // Editing a form section offers this school's published forms.
  const form = renderToStaticMarkup(<WebsiteView {...props({ sectionId: 'enquire' })} />);
  expect(form).toContain('Free class enquiry');
  expect(form).toContain('data-editing="enquire"');

  const history = renderToStaticMarkup(<WebsiteView {...props({ tab: 'history', confirming: 1 })} />);
  expect(history).toContain('data-version="2"');
  expect(history).toContain('Your current draft is replaced by that version');
  expect(renderToStaticMarkup(<WebsiteView {...props({ device: 'mobile', mode: 'big-button' })} />)).toMatch(/data-mode="big-button"[\s\S]*data-device="mobile"/);
});

it('the workspace speaks English, Korean and Spanish, and errors say whether anything changed', () => {
  expect(renderToStaticMarkup(<WebsiteView {...props({ language: 'ko' })} />)).toContain('초안 미리보기');
  expect(renderToStaticMarkup(<WebsiteView {...props({ language: 'es' })} />)).toContain('Vista previa del borrador');
  const unknown = renderToStaticMarkup(<WebsiteView {...props({ outcome: { kind: 'UNKNOWN', command: 'publish' }, canRetry: true })} />);
  expect(unknown).toContain('Try again');
  expect(renderToStaticMarkup(<WebsiteView {...props({ outcome: { kind: 'NOT_LIVE', command: 'publish' } })} />)).toContain(websiteText('en', 'e_NOT_LIVE'));
  expect(renderToStaticMarkup(<WebsiteView {...props({ read: { state: 'DENIED' } })} />)).toContain('Ask the school owner for access.');
});

it('the client sends each command once with its own command name and key, and keeps only unknown outcomes for retry', async () => {
  const w = site();
  const calls: [string, RequestInit][] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    calls.push([path, init]);
    return new Response(JSON.stringify({ data: w, meta: { replayed: false } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  const out = await websiteApi.command(scope, 'publish', { expectedRevision: 4, note: 'Go' }, KEY, AbortSignal.timeout(1000), () => true);
  expect(out.publicSlug).toBe('tiger-dojo');
  expect(calls[0]![0]).toBe(`/api/v1/organizations/${ORG}/schools/${SCHOOL}/website/publish`);
  expect(calls[0]![1]).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'error',
    headers: { 'X-HON-Human-Command': 'website.publish', 'Idempotency-Key': KEY } });
  // Invalid input never leaves the browser.
  await expect(websiteApi.command(scope, 'publish', { expectedRevision: 4, note: 'Go', extra: 1 }, KEY, AbortSignal.timeout(1000), () => true)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(websiteApi.command(scope, 'save', { expectedRevision: 4, name: 'x', document: { ...w.draft, schemaVersion: 2 } }, KEY, AbortSignal.timeout(1000), () => true)).rejects.toMatchObject({ kind: 'INVALID' });
  expect(calls).toHaveLength(1);
  expect(websiteErrorFor(409, 'VERSION_CONFLICT').kind).toBe('STALE');
  expect(websiteErrorFor(409, 'SCHOOL_WEBSITE_ADDRESS_TAKEN').kind).toBe('TAKEN');
  expect(websiteErrorFor(409, 'SCHOOL_WEBSITE_REFERENCE_NOT_LIVE').kind).toBe('NOT_LIVE');
  expect(websiteErrorFor(400, 'SCHOOL_WEBSITE_REFERENCE_INVALID').kind).toBe('REFERENCE');
  expect(websiteErrorFor(503, 'SCHOOL_WEBSITE_UNAVAILABLE').kind).toBe('UNKNOWN');
  expect(websiteErrorFor(409, 'SCHOOL_WEBSITE_BUSY').kind).toBe('UNKNOWN');
  expect(keepForRetry(new WebsiteError('UNKNOWN'))).toBe(true);
  expect(keepForRetry(new WebsiteError('STALE'))).toBe(false);
  // A changed answer shape is never shown as success.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { ...w, publicSlug: 'Bad Slug' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  await expect(websiteApi.command(scope, 'publish', { expectedRevision: 4, note: '' }, KEY, AbortSignal.timeout(1000), () => true)).rejects.toMatchObject({ kind: 'UNKNOWN' });
});
