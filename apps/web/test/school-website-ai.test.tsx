import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { buildWebsiteFromTemplate, type SchoolWebsite } from '@hon/contracts';
import { WebsiteAiPanel } from '../src/components/school-website/ai-panel';
import { WebsiteAiError, websiteAiApi, websiteAiErrorFor } from '../src/components/school-website/ai-http';
import { websiteAiText } from '../src/components/school-website/ai-copy';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const ORG = '11111111-1111-4111-8111-111111111111', SCHOOL = '22222222-2222-4222-8222-222222222222', KEY = '33333333-3333-4333-8333-333333333333', ID = '44444444-4444-4444-8444-444444444444';
const scope = { organizationId: ORG, schoolId: SCHOOL };
const view = (patch = {}) => ({ id: ID, status: 'RESULT_RECORDED', reason: null, request: 'Warmer welcome', baseRevision: 3, mine: true, summary: 'A warmer welcome.',
  edits: [{ op: 'setText', page: 'home', section: 'hero', prop: 'heading', value: 'Welcome' }], problems: [], createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:00.000Z', ...patch });
const site = (): SchoolWebsite => ({ id: ID, publicSlug: 'tiger-dojo', name: 'Tiger Dojo', status: 'DRAFT', draftRevision: 3, publishedVersion: null,
  draft: buildWebsiteFromTemplate('MODERN_CLEAN', { schoolName: 'Tiger Dojo' }), versions: [], createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:00.000Z' });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

it('asking Marcus is one same-origin POST with its own human command and key, and the answer is verified', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return json(200, { data: view() }); }));
  const out = await websiteAiApi.request(scope, { expectedRevision: 3, request: 'Warmer welcome' }, KEY, AbortSignal.timeout(1000), () => true);
  expect(out.status).toBe('RESULT_RECORDED');
  expect(calls[0]!.url).toBe(`/api/v1/organizations/${ORG}/schools/${SCHOOL}/website/ai-edits`);
  const h = calls[0]!.init.headers as Record<string, string>;
  expect([calls[0]!.init.method, calls[0]!.init.credentials, calls[0]!.init.redirect, h['X-HON-Human-Command'], h['Idempotency-Key']]).toEqual(['POST', 'same-origin', 'error', 'website.ai.request', KEY]);
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ expectedRevision: 3, request: 'Warmer welcome' });
  // Authority-looking fields are refused before anything is sent.
  await expect(websiteAiApi.request(scope, { expectedRevision: 3, request: 'x', schoolId: SCHOOL }, KEY, AbortSignal.timeout(1000), () => true)).rejects.toMatchObject({ kind: 'INVALID' });
  expect(calls).toHaveLength(1);
});

it('apply and dismiss each have their own command; a drifted answer is UNKNOWN', async () => {
  const seen: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    seen.push(`${(init.headers as Record<string, string>)['X-HON-Human-Command']} ${url.split('/ai-edits')[1]}`);
    return url.endsWith('/apply') ? json(200, { data: { website: site(), suggestion: view({ status: 'APPLIED' }) } }) : json(200, { data: view({ status: 'DISMISSED', edits: null }) });
  }));
  expect((await websiteAiApi.apply(scope, ID, { expectedRevision: 3 }, KEY, AbortSignal.timeout(1000), () => true)).suggestion.status).toBe('APPLIED');
  expect((await websiteAiApi.dismiss(scope, ID, KEY, AbortSignal.timeout(1000), () => true)).status).toBe('DISMISSED');
  expect(seen).toEqual([`website.ai.apply /${ID}/apply`, `website.ai.dismiss /${ID}/dismiss`]);
  vi.stubGlobal('fetch', vi.fn(async () => json(200, { data: { ...view(), extra: 1 } })));
  await expect(websiteAiApi.dismiss(scope, ID, KEY, AbortSignal.timeout(1000), () => true)).rejects.toMatchObject({ kind: 'UNKNOWN' });
});

it('only exact answers are definitive; everything else keeps the key as UNKNOWN', () => {
  expect(websiteAiErrorFor(403, 'SCHOOL_WEBSITE_AI_SPEND_STOPPED').kind).toBe('PAUSED');
  expect(websiteAiErrorFor(403, 'SCHOOL_WEBSITE_AI_FORBIDDEN').kind).toBe('NO_ACCESS');
  expect(websiteAiErrorFor(409, 'SCHOOL_WEBSITE_AI_STALE').kind).toBe('STALE');
  expect(websiteAiErrorFor(409, 'VERSION_CONFLICT').kind).toBe('STALE');
  expect(websiteAiErrorFor(409, 'SCHOOL_WEBSITE_AI_DOES_NOT_FIT').kind).toBe('DOES_NOT_FIT');
  expect(websiteAiErrorFor(409, 'SCHOOL_WEBSITE_AI_NOT_OPEN').kind).toBe('GONE');
  for (const [s, c] of [[503, 'SCHOOL_WEBSITE_AI_PERSISTENCE_UNKNOWN'], [409, 'SCHOOL_WEBSITE_AI_CONFLICT'], [500, null]] as const) expect(websiteAiErrorFor(s, c).kind).toBe('UNKNOWN');
  expect(new WebsiteAiError('UNKNOWN').kind).toBe('UNKNOWN');
});

it('the panel explains what Marcus can do, waits for a saved draft, and reads in all three languages', () => {
  const noop = () => undefined;
  const html = renderToStaticMarkup(<WebsiteAiPanel scope={scope} site={site()} dirty={true} busy={false} language="en" device="desktop" schoolName="Tiger Dojo" onApplied={noop} onBusy={noop}
    api={{ ...websiteAiApi, list: async () => [] }} />);
  expect(html).toContain('Build and change your website with Marcus');
  expect(html).toContain('Message Marcus');
  expect(html).toContain('He answers with changes you can preview first');
  expect(html).toContain('Save your changes first');
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Ask Marcus<\/button>/);
  expect(html).toContain('never picks images, forms, booking pages or outside links');
  for (const lang of ['ko', 'es']) expect(websiteAiText(lang, 'title')).not.toBe(websiteAiText('en', 'title'));
  expect(websiteAiText('ko', 'left', { n: '10' })).toContain('10');
});

it('the start form lets the owner describe the school so Marcus builds the first draft', async () => {
  const { WebsiteView } = await import('../src/components/school-website/view');
  const noop = () => undefined;
  const on = new Proxy({}, { get: () => noop }) as never;
  const base = { language: 'en', locale: 'en-US', mode: 'modern', waiting: false, concealed: false, hasSchool: true, schoolName: 'Tiger Dojo',
    read: { state: 'READY', website: null } as const, draft: null, name: '', dirty: false, choices: { forms: [], bookings: [] }, tab: 'edit' as const, device: 'desktop' as const,
    pageSlug: 'home', sectionId: null, confirming: null, note: '', outcome: null, locked: false, canRetry: false, origin: 'https://app.example', on };
  const empty = renderToStaticMarkup(<WebsiteView {...base} start={{ name: 'Tiger Dojo', slug: 'tiger-dojo', template: 'MODERN_CLEAN', describe: '' }} />);
  expect(empty).toContain('Describe your school and the website you want');
  expect(empty).toContain('data-website-describe');
  expect(empty).toMatch(/<button type="submit"[^>]*>Create website<\/button>/);
  const described = renderToStaticMarkup(<WebsiteView {...base} start={{ name: 'Tiger Dojo', slug: 'tiger-dojo', template: 'MODERN_CLEAN', describe: 'Kids taekwondo in Austin' }} />);
  expect(described).toMatch(/<button type="submit"[^>]*>Build my website with Marcus<\/button>/);
  for (const lang of ['ko', 'es']) expect(websiteAiText(lang, 'building')).not.toBe(websiteAiText('en', 'building'));
});
