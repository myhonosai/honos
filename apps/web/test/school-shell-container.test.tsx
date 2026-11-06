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
  const element = (background: string, image = 'none', attrs: Record<string, boolean> = {}) => ({
    closest: () => null, hasAttribute: (name: string) => Boolean(attrs[name]), _style: { backgroundColor: background, backgroundImage: image },
  }) as unknown as Element;
  vi.stubGlobal('getComputedStyle', (el: { _style: object }) => el._style);
  expect(shellNeedsLegacyCanvas(element('rgba(0, 0, 0, 0)'))).toBe(true);
  expect(shellNeedsLegacyCanvas(element('rgb(10, 16, 32)'))).toBe(false);
  expect(shellNeedsLegacyCanvas(element('rgba(0, 0, 0, 0)', 'linear-gradient(red, blue)'))).toBe(false);
  expect(shellNeedsLegacyCanvas(element('rgba(0, 0, 0, 0)', 'none', { 'data-hon-native': true }))).toBe(false);
  expect(shellNeedsLegacyCanvas(null)).toBe(false);
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
