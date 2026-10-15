import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SchoolHealthScore } from '../src/components/school-health-score';
import { HealthScoreAccessError, healthScorePath, loadSchoolHealthScore, verifySchoolHealthScoreSnapshot } from '../src/components/health-score-http';

const organizationId = '11111111-1111-4111-8111-111111111111';
const schoolId = '22222222-2222-4222-8222-222222222222';
const generatedAt = '2026-06-02T00:00:00.000Z';
const day = 86_400_000;
const range = (days: number) => ({ windowFrom: new Date(Date.parse(generatedAt) - days * day).toISOString(), windowTo: generatedAt });
function report() {
  return {
    organizationId, schoolId, entitlementTier: 'ESSENTIAL', formulaVersion: 'SCHOOL_HEALTH_SCORE_V1', generatedAt,
    weights: { attendanceEngagement: 35, pipelineTrial: 25, retention: 25, operations: 15 },
    categories: {
      attendanceEngagement: { status: 'AVAILABLE', ...range(28), evidence: { completedSessions: 4, recordedAttendanceObservations: 20, engagedAttendanceObservations: 15 }, reasons: [], score: 75 },
      pipelineTrial: { status: 'AVAILABLE', ...range(56), evidence: { leadsCreated: 5, trialAppointments: 4, trialOutcomesRecorded: 3 }, reasons: [], score: 75 },
      retention: { status: 'AVAILABLE', ...range(90), evidence: { membershipTermsEnded: 5, renewalReviewsRecorded: 4 }, reasons: [], score: 80 },
      operations: { status: 'AVAILABLE', ...range(28), evidence: { pendingApprovals: 1, outstandingWorkItems: 2 }, reasons: [], score: 80 },
    },
    overall: { status: 'AVAILABLE', reasons: [], score: 77 },
    indicatorStatement: 'Operational indicator only. It is not a forecast, cancellation/churn certainty, cash-revenue measure, or recommendation for consequential changes.',
  };
}
const response = (healthScore: unknown) => ({ ok: true, json: async () => ({ data: { healthScore }, meta: { requestId: 'id', correlationId: 'id' } }) }) as Response;

describe('School Health Score UI', () => {
  it('uses exactly one same-origin GET projection and verifies the fixed deterministic snapshot', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(report()));
    try {
      expect(healthScorePath(organizationId.toUpperCase(), schoolId.toUpperCase())).toBe(`/api/v1/organizations/${organizationId}/schools/${schoolId}/health-score`);
      await expect(loadSchoolHealthScore(organizationId, schoolId)).resolves.toMatchObject({ formulaVersion: 'SCHOOL_HEALTH_SCORE_V1', overall: { status: 'AVAILABLE', score: 77 } });
      expect(fetchSpy).toHaveBeenCalledWith(`/api/v1/organizations/${organizationId}/schools/${schoolId}/health-score`, expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' }));
      for (const unsafe of ['https://example.invalid', `${organizationId}/health-score`, 'not-a-uuid']) expect(() => healthScorePath(unsafe, schoolId)).toThrow();
    } finally { fetchSpy.mockRestore(); }
  });

  it('fails closed on unknown/PII-shaped payloads, bad formula/window/reason/score, cross-scope response, and access denial', async () => {
    for (const patch of [
      { email: 'PRIVATE@example.test' }, { schoolId: organizationId },
      { categories: { ...report().categories, attendanceEngagement: { ...report().categories.attendanceEngagement, personName: 'PRIVATE_PERSON' } } },
      { categories: { ...report().categories, pipelineTrial: { ...report().categories.pipelineTrial, windowTo: generatedAt.replace('00.000', '01.000') } } },
      { overall: { status: 'AVAILABLE', reasons: [], score: 0 } },
      { formulaVersion: 'AI_HEALTH_V9' },
    ]) expect(() => verifySchoolHealthScoreSnapshot({ ...report(), ...patch }, organizationId, schoolId)).toThrow();
    const insufficient: any = report();
    insufficient.categories.operations = { status: 'INSUFFICIENT_DATA', ...range(28), evidence: { pendingApprovals: 0, outstandingWorkItems: 0 }, reasons: ['NO_RECENT_OPERATIONS_WORKLOAD_SAMPLE'] };
    insufficient.overall = { status: 'INSUFFICIENT_DATA', reasons: [{ category: 'OPERATIONS', reasons: ['NO_RECENT_OPERATIONS_WORKLOAD_SAMPLE'] }] };
    expect(verifySchoolHealthScoreSnapshot(insufficient, organizationId, schoolId).overall).toEqual(insufficient.overall);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 403 } as Response);
    try { await expect(loadSchoolHealthScore(organizationId, schoolId)).rejects.toBeInstanceOf(HealthScoreAccessError); } finally { fetchSpy.mockRestore(); }
  });

  it('starts with an honest empty/scope state and never fabricates a score without a selected verified school', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<SchoolHealthScore />);
      expect(fetchSpy).not.toHaveBeenCalled();
      for (const text of ['No verified school is selected', 'Load Health Score', 'Operational indicator only']) expect(html).toContain(text);
      expect(html).not.toContain('Overall operational indicator: 77'); expect(html).not.toContain('Ideal Martial Arts');
    } finally { fetchSpy.mockRestore(); }
  });

  it('is a protected no-index route with formula/evidence/insufficiency states, local hide/restore, manifest registration, and no mutation/action/provider import', () => {
    const route = readFileSync('src/app/staff/health-score/page.tsx', 'utf8');
    const component = readFileSync('src/components/school-health-score.tsx', 'utf8');
    const http = readFileSync('src/components/health-score-http.ts', 'utf8');
    for (const text of ['verifySession', "redirect('/auth/login')", 'index: false', 'follow: false', 'force-dynamic']) expect(route).toContain(text);
    for (const text of ['INSUFFICIENT DATA', 'No overall score is shown', 'EVIDENCE AND SOURCES', 'Restore all hidden panels']) expect(component).toContain(text);
    expect(http).toContain('SCHOOL_HEALTH_SCORE_V1');
    expect(component).toContain('localStorage'); expect(http).toContain("method: 'GET'"); expect(http).toContain("credentials: 'same-origin'");
    expect(`${component}\n${http}`).not.toMatch(/method:\s*'POST'|Idempotency-Key|X-HON-Human-Command|invokeLLM|executeAction|sendMessage|from ['"].*provider/i);
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    expect(manifest.routes.filter((item: { path: string }) => item.path === '/staff/health-score')).toHaveLength(1);
  });
});
