import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EMPTY_SCHOOL_BRANDING } from '@hon/contracts';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { BrandingError, brandingApi, brandingErrorFor, keepForRetry } from '../src/components/school-branding/http';
import { brandingFrom, draftFrom, draftProblems, sameDraft, saveInput } from '../src/components/school-branding/draft';
import { SchoolBrandingView, type SchoolBrandingViewProps } from '../src/components/school-branding/view';
import { id } from './account-status-fixtures';

// 0268: a school owner sets the logo, color, cover photo and contact line its booking and checkout pages show.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), key = id(77), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5), correlationId: id(5) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as BrandingError; } throw new Error('expected a failure'); };
const look = { logoUrl: 'https://tigerkim.example.com/logo.png', coverUrl: 'https://tigerkim.example.com/cover.jpg', accentColor: '#c81e1e', contactLine: '(555) 010-0100 · 123 Main St' };
const saved = (over: Record<string, unknown> = {}) => ({ ...look, version: 3, updatedAt: '2026-11-12T10:00:00.000Z', ...over });
const empty = { ...EMPTY_SCHOOL_BRANDING, version: 0, updatedAt: null };

it('reads branding as a plain same-origin GET with no key and no x-hon header, and refuses drift', async () => {
  const f = stub(json({ data: { branding: saved() }, meta }));
  expect((await brandingApi.read({ organizationId: org.toUpperCase(), schoolId: school }, signal(), () => true)).version).toBe(3);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/settings/branding`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
  expect(Object.keys(init.headers as object).some((k) => /^x-hon|idempotency/i.test(k))).toBe(false);
  stub(json({ data: { branding: empty }, meta }));
  expect((await brandingApi.read(scope, signal(), () => true)).version).toBe(0);
  for (const bad of [{ branding: saved(), extra: 1 }, { branding: saved({ logoUrl: 'javascript:alert(1)' }) }, { branding: saved({ accentColor: 'red' }) },
    { branding: { ...empty, logoUrl: look.logoUrl } }, { branding: saved({ updatedAt: null }) }]) {
    stub(json({ data: bad, meta }));
    expect((await fails(brandingApi.read(scope, signal(), () => true))).kind).toBe('UNKNOWN');
  }
});

it('saves with its own human-command header and key, and accepts only the next version', async () => {
  const input = { branding: look, expectedVersion: 3 };
  const f = stub(json({ data: { branding: saved({ version: 4 }) }, meta: { ...meta, replayed: false } }));
  expect((await brandingApi.save(scope, input, key, signal(), () => true)).version).toBe(4);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/settings/branding`);
  expect(init).toMatchObject({ method: 'POST', referrerPolicy: 'no-referrer', headers: { 'X-HON-Human-Command': 'school_branding.save', 'Idempotency-Key': key } });
  expect(JSON.parse(String(init.body))).toEqual(input);
  for (const bad of [saved({ version: 3 }), saved({ version: 5 })]) {
    stub(json({ data: { branding: bad }, meta }));
    expect((await fails(brandingApi.save(scope, input, key, signal(), () => true))).kind).toBe('UNKNOWN');
  }
  // Bad input or key never reaches the network.
  const none = stub(json({}));
  expect((await fails(brandingApi.save(scope, { branding: { ...look, accentColor: 'red' }, expectedVersion: 3 }, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(brandingApi.save(scope, input, 'not-a-key', signal(), () => true))).kind).toBe('INVALID');
  expect(none).not.toHaveBeenCalled();
});

it('maps only exact refusals to definite kinds; anything else keeps the key for an identical retry', () => {
  expect(brandingErrorFor(403, 'SCHOOL_BRANDING_FORBIDDEN').kind).toBe('DENIED');
  expect(brandingErrorFor(409, 'VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(brandingErrorFor(409, 'IDEMPOTENCY_KEY_REUSED').kind).toBe('INVALID');
  expect(brandingErrorFor(400, 'VALIDATION_FAILED').kind).toBe('INVALID');
  for (const [status, code] of [[409, 'SCHOOL_BRANDING_CONFLICT'], [409, 'IDEMPOTENCY_IN_PROGRESS'], [503, 'SCHOOL_BRANDING_UNAVAILABLE'], [500, null]] as const) {
    const error = brandingErrorFor(status, code);
    expect(error.kind).toBe('UNKNOWN'); expect(keepForRetry(error)).toBe(true);
  }
  expect(keepForRetry(new BrandingError('CHANGED'))).toBe(false);
  expect(keepForRetry(new BrandingError('RATE'))).toBe(true);
});

it('turns what staff type into the closed shape, names every problem, and saves against the verified version', () => {
  const draft = draftFrom(saved());
  expect(brandingFrom(draft)).toEqual(look);
  expect(brandingFrom({ logoUrl: '  ', coverUrl: '', accentColor: ' #C81E1E ', contactLine: ' Call us ' })).toEqual({ logoUrl: null, coverUrl: null, accentColor: '#c81e1e', contactLine: 'Call us' });
  expect(draftProblems(draft)).toEqual([]);
  expect(draftProblems({ ...draft, logoUrl: 'http://x.example.com/a.png' })[0]).toContain('https://');
  expect(draftProblems({ ...draft, coverUrl: `https://x.example.com/${'a'.repeat(500)}` })[0]).toContain('too long');
  expect(draftProblems({ ...draft, accentColor: 'red' })[0]).toContain('#c81e1e');
  expect(draftProblems({ ...draft, contactLine: '<b>hi</b>' })[0]).toContain('< or >');
  expect(sameDraft(draft, draftFrom(saved()))).toBe(true);
  expect(saveInput(verified(), draft)).toEqual({ branding: look, expectedVersion: 3 });
  expect(() => saveInput(verified(), { ...draft, accentColor: 'red' })).toThrow();
});
function verified() { return { ...look, version: 3, updatedAt: '2026-11-12T10:00:00.000Z' }; }

const props = (over: Partial<SchoolBrandingViewProps> = {}): SchoolBrandingViewProps => ({
  language: 'en-US', waiting: false, concealed: false, hasSchool: true, schoolName: 'Tiger Kim TKD', read: { state: 'READY', read: verified() },
  draft: draftFrom(verified()), dirty: false, problems: [], outcome: null, locked: false, canRetry: false, ...over });

it('shows the fields, a live preview from safe values only, and the version', () => {
  const html = renderToStaticMarkup(<SchoolBrandingView {...props()}/>);
  expect(html).toContain('Version 3'); expect(html).toContain('Tiger Kim TKD');
  expect(html).toContain(`value="${look.logoUrl}"`); expect(html).toContain('value="#c81e1e"');
  expect(html).toContain(`src="${look.coverUrl}"`); expect(html).toContain('referrerPolicy="no-referrer"');
  expect(html).toContain('background:#c81e1e');
  // Saving needs a change.
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save branding<\/button>/); expect(html).not.toContain('Discard changes');
  const unsafe = renderToStaticMarkup(<SchoolBrandingView {...props({ dirty: true, draft: { ...draftFrom(verified()), logoUrl: 'javascript:alert(1)', accentColor: 'red' }, problems: ['x'] })}/>);
  expect(unsafe).not.toContain('src="javascript:'); expect(unsafe).toContain('background:#1d4ed8'); expect(unsafe).toContain('Discard changes');
  expect(unsafe).toMatch(/<button[^>]*disabled=""[^>]*>Save branding<\/button>/);
  const fresh = renderToStaticMarkup(<SchoolBrandingView {...props({ read: { state: 'READY', read: empty }, draft: draftFrom(empty) })}/>);
  expect(fresh).toContain('Not set yet');
});

it('shows outcomes plainly and hides everything when concealed or not allowed', () => {
  const unknown = renderToStaticMarkup(<SchoolBrandingView {...props({ outcome: { kind: 'UNKNOWN' }, canRetry: true, locked: true })}/>);
  expect(unknown).toContain('Try again sends the exact same save'); expect(unknown).toContain('Try again</button>');
  expect(renderToStaticMarkup(<SchoolBrandingView {...props({ outcome: { kind: 'CHANGED' } })}/>)).toContain('Your edits are still here');
  expect(renderToStaticMarkup(<SchoolBrandingView {...props({ read: { state: 'DENIED' } })}/>)).toContain('manage school branding permission');
  const hidden = renderToStaticMarkup(<SchoolBrandingView {...props({ concealed: true })}/>);
  expect(hidden).toContain('Hidden while this tab'); expect(hidden).not.toContain(look.logoUrl);
});

it('is a protected dynamic noindex page in the settings menu and the route manifest, with nothing kept in storage', () => {
  const pageSource = readFileSync('src/app/staff/settings/branding/page.tsx', 'utf8');
  expect(pageSource).toContain("export const dynamic = 'force-dynamic'"); expect(pageSource).toContain('requireVerifiedWebSession'); expect(pageSource).toContain('index: false');
  expect(pageSource).not.toMatch(/searchParams|organizationId|schoolId|fetch\(/);
  expect(schoolShellActiveRoute('/staff/settings/branding')?.href).toBe('/staff/settings/branding');
  expect(SCHOOL_SHELL_NAV.find((n) => n.key === 'settings')?.routes.some((r) => r.href === '/staff/settings/branding')).toBe(true);
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
  expect(manifest.routes.filter((r: { path: string }) => r.path === '/staff/settings/branding')).toEqual([{ path: '/staff/settings/branding', title: 'HON | School branding' }]);
  const source = ['school-branding.tsx', 'http.ts', 'view.tsx', 'draft.ts'].map((f) => readFileSync(`src/components/school-branding/${f}`, 'utf8')).join('\n');
  expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|dangerouslySetInnerHTML/);
});
