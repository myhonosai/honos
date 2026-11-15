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

const fallback = (html: string) => html.slice(html.indexOf('<details data-id-fields="fallback"'), html.indexOf('</details>'));

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
