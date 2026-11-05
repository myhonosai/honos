import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ language: 'en' }));
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: h.language } }) }));
import { SchoolEntry } from '../src/components/school-entry/workbench';
import { AccessNotice } from '../src/components/school-entry/access-notice';
import { entryText } from '../src/components/school-entry/copy';
it.each(['en', 'ko', 'es'])('%s renders persistent status, three presentation controls and honest unavailable copy without data reads', language => {
  h.language = language; const f = vi.spyOn(globalThis, 'fetch');
  const html = renderToStaticMarkup(<SchoolEntry sessionSubject="synthetic-school-owner" />);
  expect(html).toContain(entryText(language, 'title')); expect(html).toContain('role="status"'); expect(html).toContain('aria-live="polite"');
  for (const key of ['modern', 'classic', 'big', 'unavailableHelp'] as const) expect(html).toContain(entryText(language, key));
  expect(html).not.toContain('/staff/crm/journey?'); expect(f).not.toHaveBeenCalled(); f.mockRestore();
});
it.each(['en', 'ko', 'es'])('%s neutral access page preserves family/HQ/staff separation and ordinary protected links', language => {
  h.language = language; const html = renderToStaticMarkup(<AccessNotice />);
  for (const href of ['/hq', '/staff/entry', '/parent', '/auth/continue', '/auth/login']) expect(html).toContain(`href="${href}"`);
  expect(html).not.toContain('organizationId'); expect(html).not.toContain('schoolId');
});
