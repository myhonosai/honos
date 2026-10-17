import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { pendingCandidateScorecardHref, testingScorecardInitialIds } from '../src/components/testing-scorecard-handoff';
import { TestingScorecardWorkbench } from '../src/components/testing-scorecard-workbench';

const schoolId = '11111111-1111-4111-8111-111111111111';
const candidateId = '22222222-2222-4222-8222-222222222222';
const eventId = '33333333-3333-4333-8333-333333333333';
const blank = { schoolId: '', testingCandidateId: '', testingEventId: '' };

describe('PENDING candidate scorecard handoff', () => {
  it('builds a normal receipt link with exactly the three untrusted UUID selectors', () => {
    const href = pendingCandidateScorecardHref(schoolId, candidateId, eventId);
    expect(href).toBe(`/staff/testing/scorecards?schoolId=${schoolId}&testingCandidateId=${candidateId}&testingEventId=${eventId}`);
    const query = new URL(href!, 'https://hon.test').searchParams;
    expect([...query.keys()]).toEqual(['schoolId', 'testingCandidateId', 'testingEventId']);
    expect([query.get('schoolId'), query.get('testingCandidateId'), query.get('testingEventId')]).toEqual([schoolId, candidateId, eventId]);
    for (const forbidden of ['organizationId', 'studentCurriculumEnrollmentId', 'targetRankId', 'instructorNotes', 'receipt', 'status', 'permission', 'authority']) expect(query.has(forbidden)).toBe(false);
    expect(pendingCandidateScorecardHref('bad', candidateId, eventId)).toBeUndefined();
  });

  it('accepts only one closed UUID value for each allowed prefill field and fails closed otherwise', () => {
    expect(testingScorecardInitialIds({ schoolId: schoolId.toUpperCase(), testingCandidateId: candidateId.toUpperCase(), testingEventId: eventId.toUpperCase() })).toEqual({ schoolId, testingCandidateId: candidateId, testingEventId: eventId });
    for (const query of [undefined, null, 'bad', {}, { schoolId, testingCandidateId: candidateId }, { schoolId, testingCandidateId: candidateId, testingEventId: 'bad' }, { schoolId: [schoolId], testingCandidateId: candidateId, testingEventId: eventId }, { schoolId, testingCandidateId: candidateId, testingEventId: eventId, organizationId: schoolId }]) expect(testingScorecardInitialIds(query)).toEqual(blank);
  });

  it('renders a valid prefill idle with no request, scorecard state, evaluation, or automatic action until Load scorecard', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const markup = renderToStaticMarkup(<TestingScorecardWorkbench initialKnownIds={{ schoolId, testingCandidateId: candidateId, testingEventId: eventId }} />);
      expect(fetcher).not.toHaveBeenCalled();
      for (const value of [schoolId, candidateId, eventId, 'Load scorecard', 'No scorecard loaded']) expect(markup).toContain(value);
      expect(markup).not.toContain('Current protected scorecard state');
      expect(markup).not.toContain('Record independent evaluation');
      expect(renderToStaticMarkup(<TestingScorecardWorkbench initialKnownIds={{ schoolId, testingCandidateId: [candidateId], testingEventId: eventId }} />)).not.toContain(schoolId);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { fetcher.mockRestore(); }
  });

  it('keeps the handoff source selector-only and the route/component free of query-triggered scorecard authority or I/O', () => {
    const handoff = readFileSync('src/components/testing-scorecard-handoff.ts', 'utf8');
    const receiptUi = readFileSync('src/components/testing-candidate-registration-workbench.tsx', 'utf8');
    const route = readFileSync('src/app/staff/testing/scorecards/page.tsx', 'utf8');
    const scorecard = readFileSync('src/components/testing-scorecard-workbench.tsx', 'utf8');
    expect(receiptUi).toContain('pendingCandidateScorecardHref(ids.schoolId, receipt.candidate.id, receipt.candidate.testingEventId)');
    expect(receiptUi).toContain('<a href={scorecardHref}>Open independent testing scorecard</a>');
    expect(handoff).toContain('new URLSearchParams({ schoolId: schoolId.toLowerCase(), testingCandidateId: testingCandidateId.toLowerCase(), testingEventId: testingEventId.toLowerCase() })');
    expect(handoff).not.toMatch(/organizationId|studentCurriculumEnrollmentId|targetRankId|instructorNotes|receipt|status|permission|authority|fetch\(/i);
    expect(route).toContain('testingScorecardInitialIds(query)');
    expect(route).not.toMatch(/fetch\(|loadTestingScorecard|recordTestingScorecardEvaluation|organizationId|studentCurriculumEnrollmentId|targetRankId|instructorNotes|receipt|status/i);
    expect(scorecard).toContain('useState(() => testingScorecardInitialIds(initialKnownIds).schoolId)');
    expect(scorecard).not.toMatch(/useEffect|useSearchParams|window\.location|localStorage|sessionStorage/);
  });
});
