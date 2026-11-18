import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ language: 'en' }));
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: state.language } }) }));
import { ParentPortalLink, parentPortalButton, parentPortalText, parentPortalUrl } from '../src/components/family-access/parent-portal-link';
import { FamilyAccessWorkspace } from '../src/components/family-access/workbench';
afterEach(() => { state.language = 'en'; vi.restoreAllMocks(); });

it('builds the portal address from the site origin only, never a path, query or person', () => {
  expect(parentPortalUrl('https://app.myhonos.com')).toBe('https://app.myhonos.com/parent');
  expect(parentPortalUrl('https://app.myhonos.com/staff/family-access?schoolId=x#frag')).toBe('https://app.myhonos.com/parent');
  expect(() => parentPortalUrl('not a url')).toThrow();
});

it('makes a plain escaped website link with nothing framed and no script', () => {
  const html = parentPortalButton('https://app.myhonos.com/parent', 'Parent "portal" <b>');
  expect(html).toBe('<a href="https://app.myhonos.com/parent" target="_blank" rel="noopener">Parent &quot;portal&quot; &lt;b&gt;</a>');
  expect(html).not.toMatch(/<script|<iframe|javascript:/i);
});

it.each(['en', 'ko', 'es'])('%s shows the link, the website button code and how families get access, with no network call', language => {
  state.language = language;
  const fetcher = vi.spyOn(globalThis, 'fetch');
  const html = renderToStaticMarkup(<ParentPortalLink origin="https://app.myhonos.com" />);
  expect(html).toContain('data-testid="parent-portal-link"');
  expect(html).toContain('value="https://app.myhonos.com/parent"');
  expect(html).toContain(parentPortalText(language, 'copyLink'));
  expect(html).toContain(parentPortalText(language, 'how'));
  expect(html).toContain(parentPortalButton('https://app.myhonos.com/parent', parentPortalText(language, 'buttonLabel')).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
  expect(fetcher).not.toHaveBeenCalled();
});

it('appears on the staff Family access page but not on the parent invitation acceptance page', () => {
  expect(renderToStaticMarkup(<FamilyAccessWorkspace sessionSubject="synthetic-owner" />)).toContain('data-testid="parent-portal-link"');
  expect(renderToStaticMarkup(<FamilyAccessWorkspace sessionSubject="synthetic-parent" acceptance />)).not.toContain('parent-portal-link');
});
