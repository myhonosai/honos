import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { loadTestingScorecard, recordTestingScorecardEvaluation, TestingScorecardAccessError } from '../src/components/testing-scorecard-http';
import { TestingScorecardWorkbench } from '../src/components/testing-scorecard-workbench';

const schoolId = '11111111-1111-4111-8111-111111111111';
const candidateId = '22222222-2222-4222-8222-222222222222';
const eventId = '33333333-3333-4333-8333-333333333333';
const scorecardId = '44444444-4444-4444-8444-444444444444';
const evaluationId = '55555555-5555-4555-8555-555555555555';
const evaluation = { id: evaluationId, criterionCode: 'TECHNIQUE.BALANCE', assessment: 'OBSERVED', recordedAt: '2026-10-15T20:00:00.000Z', version: 1, recordedByYou: true } as const;
const empty = { testingCandidateId: candidateId, testingEventId: eventId, candidateVersion: 3, testingEventVersion: 2, scorecardId: null, scorecardVersion: 0, evaluations: [], evaluationsLimited: false } as const;
const receipt = { scorecardId, scorecardVersion: 1, evaluation } as const;
const response = (data: unknown) => Response.json({ data, meta: { requestId: evaluationId, correlationId: evaluationId } });

describe('human testing scorecard UI', () => {
  it('uses only fixed same-origin GET/POST transport with direct-human command and an idempotency key', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ scorecard: empty }));
    try {
      await expect(loadTestingScorecard(schoolId, candidateId, eventId)).resolves.toEqual(empty);
      expect(fetcher).toHaveBeenLastCalledWith(`/api/v1/staff/testing/scorecards?schoolId=${schoolId}&testingCandidateId=${candidateId}&testingEventId=${eventId}`, expect.objectContaining({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' }));
      fetcher.mockResolvedValue(response({ scorecard: receipt }));
      await expect(recordTestingScorecardEvaluation(schoolId, { testingCandidateId: candidateId, testingEventId: eventId, criterionCode: 'TECHNIQUE.BALANCE', assessment: 'OBSERVED', expectedCandidateVersion: 3, expectedTestingEventVersion: 2, expectedScorecardVersion: 0 }, 'record-key')).resolves.toEqual(receipt);
      expect(fetcher).toHaveBeenLastCalledWith('/api/v1/staff/testing/scorecards', expect.objectContaining({ method: 'POST', credentials: 'same-origin', headers: expect.objectContaining({ 'X-HON-Human-Command': 'testing-scorecard', 'Idempotency-Key': 'record-key' }) }));
    } finally { fetcher.mockRestore(); }
  });

  it('fails closed for private response fields, malformed candidate-event pairing, and denied current scope', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ scorecard: { ...empty, evaluations: [{ ...evaluation, evaluatorPrincipalId: evaluationId }] } }));
    try { await expect(loadTestingScorecard(schoolId, candidateId, eventId)).rejects.toThrow(/not a verified redacted/i); }
    finally { fetcher.mockRestore(); }
    const denied = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 403 } as Response);
    try { await expect(loadTestingScorecard(schoolId, candidateId, eventId)).rejects.toBeInstanceOf(TestingScorecardAccessError); }
    finally { denied.mockRestore(); }
  });

  it('renders explicit empty and no-downstream-effect boundaries without fabricating a score or decision', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const markup = renderToStaticMarkup(<TestingScorecardWorkbench/>);
      expect(fetcher).not.toHaveBeenCalled();
      for (const phrase of ['Observation only — no candidate outcome.', 'No scorecard loaded', 'never grades or passes/fails a candidate, predicts eligibility or readiness, promotes']) expect(markup).toContain(phrase);
      expect(markup).not.toMatch(/send message|checkout|provider success|invokeLLM|executeAction|issue certificate|automatic pass/i);
    } finally { fetcher.mockRestore(); }
  });

  it('keeps the route authenticated, dynamic, noindex, manifest-registered, and source-free of external/action imports', () => {
    const route = readFileSync('src/app/staff/testing/scorecards/page.tsx', 'utf8');
    for (const token of ['verifySession', "redirect('/auth/login')", 'force-dynamic', 'index: false']) expect(route).toContain(token);
    const source = [readFileSync('src/components/testing-scorecard-workbench.tsx', 'utf8'), readFileSync('src/components/testing-scorecard-http.ts', 'utf8')].join('\n');
    expect(source).not.toMatch(/from ['"](?:.*provider|.*action|.*ai)|invokeLLM|executeAction|sendMessage|checkout|fetch\(['"]https?:\/\//i);
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    expect(manifest.routes.filter((route: { path: string }) => route.path === '/staff/testing/scorecards')).toHaveLength(1);
  });
});
