import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { scope } from './account-status-fixtures';

// The shell has verified a school: each page offers a pick list and keeps record-ID inputs only as a fallback.
vi.mock('../src/components/school-shell/page-school', () => ({ useShellSchool: () => scope, useShellSchoolInto: () => scope, ManualSchoolFields: ({ children }: { children?: unknown }) => children }));
const { CurriculumProgressWorkbench } = await import('../src/components/curriculum-progress-workbench');
const { PromotionReadinessWorkbench } = await import('../src/components/promotion-readiness-workbench');
const { TestingCandidateRegistrationWorkbench } = await import('../src/components/testing-candidate-registration-workbench');
const { TestingCandidateGradeWorkbench } = await import('../src/components/testing-candidate-grade-workbench');
const { PromotionDecisionWorkbench } = await import('../src/components/promotion-decision-workbench');
afterEach(() => { vi.restoreAllMocks(); });

const fallback = (html: string) => { const start = html.indexOf('<details data-id-fields="fallback"'); return html.slice(start, html.indexOf('</details>', start)); };

it.each([
  ['curriculum progress', () => <CurriculumProgressWorkbench />, 'Reading students…', ['curriculumId', 'enrollmentId']],
  ['promotion readiness', () => <PromotionReadinessWorkbench />, 'Reading students…', []],
  ['testing registration', () => <TestingCandidateRegistrationWorkbench />, 'Reading testing events…', ['testingEventId', 'studentCurriculumEnrollmentId', 'targetRankId']],
  ['candidate grade', () => <TestingCandidateGradeWorkbench />, 'Reading candidates…', ['candidateId', 'expectedVersion']],
  ['promotion decision', () => <PromotionDecisionWorkbench />, 'Reading candidates…', ['candidateId', 'expectedVersion']],
])('%s offers a pick list first and keeps ID inputs under a fallback, with no request during render', (_name, page, loading, fields) => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  const html = renderToStaticMarkup(page());
  expect(fetcher).not.toHaveBeenCalled();
  expect(html).toContain(loading);
  expect(html).toContain('<summary>Enter record IDs instead</summary>');
  for (const field of fields) expect(fallback(html)).toContain(`name="${field}"`);
  expect(html).not.toContain('name="organizationId"'); expect(html).not.toContain('name="schoolId"');
  expect(html).not.toMatch(/no directory, search/i);
});

it('Mass rank promotion opens on the group list, with the one-student form below it (L3)', () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  const html = renderToStaticMarkup(<PromotionDecisionWorkbench />);
  expect(fetcher).not.toHaveBeenCalled();
  expect(html).toContain('<h1>Mass rank promotion</h1>');
  expect(html.indexOf('data-mass-promotion')).toBeGreaterThan(-1);
  expect(html.indexOf('data-mass-promotion')).toBeLessThan(html.indexOf('One student at a time'));
  expect(html).toContain('Reading graded students…');
});
