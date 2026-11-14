import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({ usePathname: () => '/staff/crm/leads' }));
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: 'en' }, scope: null }) }));
import { SchoolShell, shellPreferredSchool } from '../src/components/school-shell/shell';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';

it('accepts only one complete, well-formed organization + school pair as a candidate', () => {
  expect(shellPreferredSchool(`?organizationId=${A}&schoolId=${B}`)).toEqual({ organizationId: A, schoolId: B });
  expect(shellPreferredSchool(`?organizationId=${A.toUpperCase()}&schoolId=${B}&leadId=x`)).toEqual({ organizationId: A, schoolId: B });
  expect(shellPreferredSchool(`?organizationId=${A}`)).toBeNull();
  expect(shellPreferredSchool(`?organizationId=${A}&schoolId=not-a-uuid`)).toBeNull();
  expect(shellPreferredSchool('')).toBeNull();
});

it('first render shows the page, no school, no prefill and performs no read', () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  const html = renderToStaticMarkup(<SchoolShell sessionSubject="synthetic-owner"><p>page body</p></SchoolShell>);
  expect(html).toContain('page body'); expect(html).toContain('Loading your school');
  expect(html).not.toContain('organizationId='); expect(html).toContain('data-hon-mode="modern"');
  expect(fetcher).not.toHaveBeenCalled(); fetcher.mockRestore();
});

it('gives a light canvas only to unmigrated page roots that have no background of their own', async () => {
  const { shellNeedsLegacyCanvas } = await import('../src/components/school-shell/shell');
  const main = (background: string, image = 'none', attrs: Record<string, boolean> = {}) => ({
    firstElementChild: { closest: () => null, hasAttribute: (name: string) => Boolean(attrs[name]), _style: { backgroundColor: background, backgroundImage: image } },
    querySelector: () => null,
  }) as unknown as Element;
  vi.stubGlobal('getComputedStyle', (el: { _style: object }) => el._style);
  expect(shellNeedsLegacyCanvas(main('rgba(0, 0, 0, 0)'))).toBe(true);
  expect(shellNeedsLegacyCanvas(main('rgb(10, 16, 32)'))).toBe(false);
  expect(shellNeedsLegacyCanvas(main('rgba(0, 0, 0, 0)', 'linear-gradient(red, blue)'))).toBe(false);
  expect(shellNeedsLegacyCanvas(main('rgba(0, 0, 0, 0)', 'none', { 'data-hon-native': true }))).toBe(false);
  expect(shellNeedsLegacyCanvas(null)).toBe(false);
  vi.unstubAllGlobals();
});

it('decides the light canvas from the page heading: dark text on no surface gets it, light text or a painted surface never does', async () => {
  const { shellNeedsLegacyCanvas, shellColorLightness } = await import('../src/components/school-shell/shell');
  expect(shellColorLightness('rgb(255, 255, 255)')).toBeCloseTo(1);
  expect(shellColorLightness('rgba(0, 0, 0, 0.5)')).toBe(0);
  expect(shellColorLightness('color(srgb 1 1 1)')).toBeNull();
  type Fake = { _style: { backgroundColor: string; backgroundImage: string; color: string }; parentElement: Fake | null; heading?: Fake };
  const node = (parent: Fake | null, style: Partial<Fake['_style']> = {}): Fake =>
    ({ _style: { backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', color: 'rgb(0, 0, 0)', ...style }, parentElement: parent });
  const page = (wrapper: Partial<Fake['_style']>, card: Partial<Fake['_style']> | null, heading: Partial<Fake['_style']> | null) => {
    // The shell's main is painted (by the light canvas itself) and must never count.
    const main = node(null, { backgroundColor: 'rgb(245, 247, 251)' }), root = node(main, wrapper), inner = card ? node(root, card) : root;
    const h1 = heading ? node(inner, heading) : null;
    return Object.assign(main, { firstElementChild: Object.assign(root, { closest: () => null, hasAttribute: () => false }),
      querySelector: (selector: string) => (selector === 'h1' ? h1 : null) }) as unknown as Element;
  };
  vi.stubGlobal('getComputedStyle', (el: Fake) => el._style);
  // Leads: an unpainted wrapper holding dark text made for the old light body (dark on dark today).
  expect(shellNeedsLegacyCanvas(page({}, {}, { color: 'rgb(23, 34, 56)' }))).toBe(true);
  // Search: an unpainted wrapper holding light text made for the dark theme (light on white today).
  expect(shellNeedsLegacyCanvas(page({}, null, { color: 'rgb(231, 238, 249)' }))).toBe(false);
  // People: the heading sits on the page's own dark card.
  expect(shellNeedsLegacyCanvas(page({}, { backgroundColor: 'rgb(8, 20, 40)' }, { color: 'rgb(23, 34, 56)' }))).toBe(false);
  // No heading at all: keep the old rule (unpainted root gets the light canvas).
  expect(shellNeedsLegacyCanvas(page({}, null, null))).toBe(true);
  vi.unstubAllGlobals();
});

it('renders the school entry page bare: it is already the school chooser', async () => {
  vi.resetModules();
  vi.doMock('next/navigation', () => ({ usePathname: () => '/staff/entry' }));
  const { SchoolShell: Bare } = await import('../src/components/school-shell/shell');
  const html = renderToStaticMarkup(<Bare sessionSubject="synthetic-owner"><p>entry page</p></Bare>);
  expect(html).toBe('<p>entry page</p>');
  vi.doUnmock('next/navigation');
});

it('the page-level language strip yields to the shell only on shell-wrapped staff pages', async () => {
  const { isSchoolShellPath } = await import('../src/components/school-shell/paths');
  expect(isSchoolShellPath('/staff/crm/leads')).toBe(true);
  expect(isSchoolShellPath('/staff/dashboard')).toBe(true);
  expect(isSchoolShellPath('/staff/entry')).toBe(false);
  expect(isSchoolShellPath('/staffing')).toBe(false);
  expect(isSchoolShellPath('/hq/dashboard')).toBe(false);
  expect(isSchoolShellPath('/settings/language-region')).toBe(false);
});
