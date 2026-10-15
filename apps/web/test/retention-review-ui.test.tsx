import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RetentionReviewSignalsWorkbench } from '../src/components/retention-review-signals';
import { loadRetentionReviewSignals, retentionReviewPath } from '../src/components/retention-review-signals-http';

const schoolId = '11111111-1111-4111-8111-111111111111';
const membershipId = '22222222-2222-4222-8222-222222222222';
const observedAt = '2026-10-15T20:00:00.000Z';
function report() {
  return {
    schemaVersion: 'RETENTION_REVIEW_SIGNALS_V1', membershipId, observedAt,
    humanOnly: true, readOnly: true, evidenceOnly: true, predictionOrAutomaticAction: false,
    membershipTerm: { status: 'AVAILABLE', membershipState: 'ACTIVE', termStartedAt: '2026-01-01T00:00:00.000Z', termEndsAt: '2026-11-01T00:00:00.000Z', endingObservation: 'ENDING_WITHIN_30_DAYS', reason: null },
    renewalReview: { status: 'UNAVAILABLE', latestReviewState: null, recordedAt: null, reason: 'NO_EXPLICIT_RENEWAL_REVIEW_RECORDED' },
    followUp: { status: 'UNAVAILABLE', reason: 'NO_UNAMBIGUOUS_MEMBERSHIP_TO_FOLLOW_UP_RELATION' },
    attendance: { status: 'AVAILABLE', windowFrom: '2026-09-17T20:00:00.000Z', windowTo: observedAt, recordedAttendanceCount: 3, presentCount: 2, lateCount: 1, makeupCount: 0, excusedAbsenceCount: 0, unexcusedAbsenceCount: 0, reason: null },
    progression: { status: 'AVAILABLE', curriculumEnrollmentCount: 1, progressObservationCount: 0, testingRecordCount: 0, progressObservationAvailability: 'UNAVAILABLE', testingObservationAvailability: 'UNAVAILABLE', reason: null },
  };
}
const response = (retentionReviewSignals: unknown) => ({ ok: true, json: async () => ({ data: { retentionReviewSignals }, meta: { requestId: 'id', correlationId: 'id' } }) }) as Response;

describe('Retention Review Signals UI', () => {
  it('uses one same-origin no-store GET with known UUID selectors and verifies a strict redacted projection', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(report()));
    try {
      expect(retentionReviewPath(schoolId.toUpperCase(), membershipId.toUpperCase())).toBe(`/api/v1/staff/retention/review?schoolId=${schoolId}&membershipId=${membershipId}`);
      await expect(loadRetentionReviewSignals(schoolId, membershipId)).resolves.toMatchObject({ membershipId, evidenceOnly: true, predictionOrAutomaticAction: false });
      expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('/api/v1/staff/retention/review?'), expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' }));
      for (const unsafe of ['not-a-uuid', 'https://example.invalid', `${schoolId}/x`]) expect(() => retentionReviewPath(unsafe, membershipId)).toThrow();
    } finally { fetchSpy.mockRestore(); }
  });

  it('fails closed on private, scoring, predictive, missing-data, or scope-manipulated payloads', async () => {
    for (const patch of [
      { email: 'private@example.test' },
      { membershipId: schoolId },
      { attendance: { ...report().attendance, score: 88 } },
      { membershipTerm: { ...report().membershipTerm, endingObservation: 'CHURN_RISK' } },
      { followUp: { status: 'AVAILABLE', reason: null } },
    ]) {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ ...report(), ...patch }));
      try { await expect(loadRetentionReviewSignals(schoolId, membershipId)).rejects.toThrow(/could not be verified|verified redacted/i); }
      finally { fetchSpy.mockRestore(); }
    }
  });

  it('starts empty, declares its limits, protects its route, and includes no mutation or provider integration', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<RetentionReviewSignalsWorkbench />);
      expect(fetchSpy).not.toHaveBeenCalled();
      for (const text of ['Known-ID review only', 'Load Retention Review Signals', 'no score, prediction', 'No verified school and membership are selected']) expect(html).toContain(text);
    } finally { fetchSpy.mockRestore(); }
    const route = readFileSync('src/app/staff/retention/review/page.tsx', 'utf8');
    const component = readFileSync('src/components/retention-review-signals.tsx', 'utf8');
    const http = readFileSync('src/components/retention-review-signals-http.ts', 'utf8');
    for (const text of ['verifySession', "redirect('/auth/login')", 'index: false', 'follow: false', 'force-dynamic']) expect(route).toContain(text);
    expect(`${component}\n${http}`).not.toMatch(/method:\s*'POST'|Idempotency-Key|invokeLLM|executeAction|sendMessage|providerClient|paymentClient|refundMembership/i);
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    expect(manifest.routes.filter((item: { path: string }) => item.path === '/staff/retention/review')).toHaveLength(1);
  });
});
