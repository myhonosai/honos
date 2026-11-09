import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ language: 'en' }));
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: h.language } }) }));
import { SchoolAccountStatus } from '../src/components/account-status/workbench';
import { accountText } from '../src/components/account-status/copy';
import { AccessNotice } from '../src/components/school-entry/access-notice';
import { SchoolEntry } from '../src/components/school-entry/workbench';
it.each(['en', 'ko', 'es'])('%s has persistent accessible status, labeled selectors, all three modes and honest unavailable budgets', language => {
  h.language = language; const f = vi.spyOn(globalThis, 'fetch'); const html = renderToStaticMarkup(<SchoolAccountStatus sessionSubject="synthetic-owner"/>);
  for (const key of ['title', 'org', 'school', 'modern', 'classic', 'big', 'agentTitle', 'agentHelp'] as const) expect(html).toContain(accountText(language, key).replaceAll('&', '&amp;'));
  expect(html).toContain('role="status"'); expect(html).toContain('aria-live="polite"'); expect(html).toContain('aria-atomic="true"'); expect(html).not.toContain('/staff/subscription'); expect(f).not.toHaveBeenCalled(); f.mockRestore();
});
it.each(['en', 'ko', 'es'])('%s recovery links remain fixed and discoverable without verified reporting access', language => {
  h.language = language;
  for (const component of [<AccessNotice/>, <SchoolEntry sessionSubject="synthetic-owner"/>]) {
    const html = renderToStaticMarkup(component); expect(html).toContain('href="/staff/account-status"'); expect(html).not.toContain('/staff/account-status?');
  }
});
