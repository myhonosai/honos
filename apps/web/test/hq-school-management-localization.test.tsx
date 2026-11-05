import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ language: 'en', view: 'modern' }));
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: state.language }, formattingLocale: state.language === 'ko' ? 'ko-KR' : state.language === 'es' ? 'es-ES' : 'en-US' }) }));
vi.mock('../src/components/hq-modern/shell', () => ({ useHqModern: () => ({ view: state.view }) }));
import { HqOnboardingPanel } from '../src/components/hq-onboarding-panel';
import { HqSchoolDirectory } from '../src/components/hq-school-directory';
import { hqSchoolText, hqSchoolStatus } from '../src/components/hq-school-management-copy';
afterEach(() => vi.restoreAllMocks());
it.each(['en', 'ko', 'es'].flatMap(language => ['modern', 'classic', 'big-button'].map(view => [language, view])))('%s/%s keeps localized, accessible school management inert on render', (language, view) => {
  state.language = language!; state.view = view!;
  const fetch = vi.spyOn(globalThis, 'fetch');
  const creation = renderToStaticMarkup(<HqOnboardingPanel />), directory = renderToStaticMarkup(<HqSchoolDirectory />);
  expect(creation).toContain(hqSchoolText(language!, 'createTitle'));
  expect(creation).toContain(hqSchoolText(language!, 'verifyOwner'));
  expect(creation).toContain(hqSchoolText(language!, 'provisionPolicy'));
  expect(directory).toContain(hqSchoolText(language!, 'directoryTitle'));
  for (const html of [creation, directory]) {
    expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"');
    expect(html).toContain('hidden="" inert=""');
    expect(html).not.toContain('Private Synthetic');
  }
  expect(creation).not.toMatch(/<form|<select/); expect(fetch).not.toHaveBeenCalled();
});
it('unknown operational status never becomes an active or successful school claim', () => {
  for (const language of ['en', 'ko', 'es']) {
    expect(hqSchoolStatus(language, 'PAYMENT_PENDING')).toBe(hqSchoolText(language, 'statusUnavailable'));
    expect(hqSchoolStatus(language, 'ACTIVE')).toBe(hqSchoolText(language, 'statusActive'));
  }
});
