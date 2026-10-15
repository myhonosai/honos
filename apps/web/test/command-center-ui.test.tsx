import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SchoolCommandCenter } from '../src/components/school-command-center';
import { commandCenterPath, CommandCenterAccessError, loadCommandCenter, verifyCommandCenterSnapshot } from '../src/components/command-center-http';

const organizationId = '11111111-1111-4111-8111-111111111111';
const schoolId = '22222222-2222-4222-8222-222222222222';
const generatedAt = '2026-06-02T00:00:00.000Z';
const day = 86_400_000;
const at = (offset: number) => new Date(Date.parse(generatedAt) + offset).toISOString();
const windowMetric = (count: number, from: number, to: number) => ({ availability: 'AVAILABLE', windowFrom: at(from), windowTo: at(to), count });
function report() {
  const metrics = {
    newLeads24h: windowMetric(2, -day, 0), upcomingTrials24h: windowMetric(1, 0, day), upcomingTestingEvents30d: windowMetric(1, 0, 30 * day),
    pendingActionApprovals: { availability: 'AVAILABLE', count: 3 }, outstandingWorkItems: { availability: 'AVAILABLE', count: 4 }, membershipTermsEnding30d: windowMetric(5, 0, 30 * day),
    paidInvoicesCreated30d: { availability: 'AVAILABLE', windowFrom: at(-30 * day), windowTo: at(0), count: 2, amountsByCurrency: [{ currency: 'USD', count: 2, totalMinor: 4500 }] },
    unansweredInquiries: { availability: 'UNAVAILABLE', reason: 'No approved inquiry response-state projection exists.' }, attendanceDecline: { availability: 'INSUFFICIENT_DATA', reason: 'No approved attendance-decline policy or longitudinal projection exists.' }, trialConversion: { availability: 'UNAVAILABLE', reason: 'No authoritative trial-to-enrollment linkage is available.' }, revenue: { availability: 'UNAVAILABLE', reason: 'Current paid invoice state is not authoritative cash revenue or collection data.' },
  };
  return {
    organizationId, schoolId, entitlementTier: 'ESSENTIAL', generatedAt, metrics,
    dailyBriefing: 'Daily briefing: 2 new leads in the last 24 hours; 1 trial appointment scheduled in the next 24 hours; 1 testing event in the next 30 days; 5 membership terms ending in the next 30 days; 3 action approvals awaiting review; 4 outstanding durable work items.',
    recommendations: [
      { id: 'REVIEW_PENDING_APPROVALS', title: 'Review pending approvals', why: '3 current action requests are awaiting a qualified human review.', route: '/staff/action-center/approvals', action: 'NAVIGATE', automaticExecution: false },
      { id: 'REVIEW_OUTSTANDING_WORK', title: 'Review outstanding work', why: '4 durable work items remain in a nonterminal state.', route: '/staff/work', action: 'NAVIGATE', automaticExecution: false },
      { id: 'PREPARE_UPCOMING_TRIALS', title: 'Prepare upcoming trials', why: '1 scheduled trial appointment starts within 24 hours.', route: '/staff/search', action: 'NAVIGATE', automaticExecution: false },
      { id: 'REVIEW_NEW_LEADS', title: 'Review new leads', why: '2 CRM leads were created in the last 24 hours.', route: '/staff/search', action: 'NAVIGATE', automaticExecution: false },
      { id: 'PREPARE_MEMBERSHIP_RENEWALS', title: 'Prepare membership reviews', why: '5 active or cancellation-pending membership terms end within 30 days.', route: '/staff/billing/renewals', action: 'NAVIGATE', automaticExecution: false },
    ],
  };
}
const response = (commandCenter: unknown) => ({ ok: true, json: async () => ({ data: { commandCenter }, meta: { requestId: 'id', correlationId: 'id' } }) }) as Response;

describe('School Command Center UI', () => {
  it('uses exactly one same-origin GET projection and reconstructs the strict snapshot', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(report()));
    try {
      expect(commandCenterPath(organizationId.toUpperCase(), schoolId.toUpperCase())).toBe(`/api/v1/organizations/${organizationId}/schools/${schoolId}/command-center`);
      await expect(loadCommandCenter(organizationId, schoolId)).resolves.toMatchObject({ entitlementTier: 'ESSENTIAL', metrics: { newLeads24h: { count: 2 } } });
      expect(fetchSpy).toHaveBeenCalledWith(`/api/v1/organizations/${organizationId}/schools/${schoolId}/command-center`, expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' }));
      for (const unsafe of ['https://example.invalid', `${organizationId}/command-center`, 'not-a-uuid']) expect(() => commandCenterPath(unsafe, schoolId)).toThrow();
    } finally { fetchSpy.mockRestore(); }
  });

  it('fails closed on raw PII, invented state/reason, cross-scope response, unsafe route text, and access denial', async () => {
    for (const patch of [
      { email: 'PRIVATE@example.test' }, { schoolId: organizationId },
      { metrics: { ...report().metrics, newLeads24h: { ...report().metrics.newLeads24h, personName: 'PRIVATE_PERSON' } } },
      { recommendations: [{ ...report().recommendations[0], route: 'https://evil.test' }] },
      { metrics: { ...report().metrics, revenue: { availability: 'UNAVAILABLE', reason: 'invented revenue' } } },
    ]) expect(() => verifyCommandCenterSnapshot({ ...report(), ...patch }, organizationId, schoolId)).toThrow();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 403 } as Response);
    try { await expect(loadCommandCenter(organizationId, schoolId)).rejects.toBeInstanceOf(CommandCenterAccessError); } finally { fetchSpy.mockRestore(); }
  });

  it('starts empty without requesting a school snapshot or fabricating data', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<SchoolCommandCenter />);
      expect(fetchSpy).not.toHaveBeenCalled();
      for (const text of ['No verified school is selected', 'Human navigation only', 'Load Command Center']) expect(html).toContain(text);
      expect(html).not.toContain('31,850'); expect(html).not.toContain('Ideal Martial Arts');
    } finally { fetchSpy.mockRestore(); }
  });

  it('is a protected no-index route, only links conventional workflows, and imports no mutation/execution/provider client', () => {
    const route = readFileSync('src/app/staff/command-center/page.tsx', 'utf8');
    const component = readFileSync('src/components/school-command-center.tsx', 'utf8');
    const http = readFileSync('src/components/command-center-http.ts', 'utf8');
    for (const text of ['verifySession', "redirect('/auth/login')", 'index: false', 'follow: false', 'force-dynamic']) expect(route).toContain(text);
    const routeSources = `${component}\n${http}`;
    for (const href of ['/staff/dashboard', '/staff/search', '/staff/billing/renewals', '/staff/action-center/approvals', '/staff/work']) expect(routeSources).toContain(href);
    expect(component).toContain('localStorage'); expect(component).toContain('Restore all hidden sections and cards');
    expect(http).toContain("method: 'GET'"); expect(http).toContain("credentials: 'same-origin'");
    expect(http).not.toMatch(/method:\s*'POST'|Idempotency-Key|X-HON-Human-Command|invokeLLM|executeAction|sendMessage|provider|payment/i);
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    expect(manifest.routes.filter((item: { path: string }) => item.path === '/staff/command-center')).toHaveLength(1);
  });
});
