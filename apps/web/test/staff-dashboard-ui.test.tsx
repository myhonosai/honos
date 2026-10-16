import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { StaffDashboard } from '../src/components/staff-dashboard';
import { loadStaffDashboard, staffDashboardReportPath, StaffDashboardAccessError, verifyStaffDashboardSnapshot } from '../src/components/staff-dashboard-http';

const organizationId = '11111111-1111-4111-8111-111111111111';
const schoolId = '22222222-2222-4222-8222-222222222222';
const from = '2026-06-01T00:00:00.000Z';
const to = '2026-06-02T00:00:00.000Z';
const report = () => ({
  organizationId, schoolId, generatedAt: to, from, to,
  studentProfiles: { total: 3 },
  leads: { byStatus: { OPEN: 4, WON: 1, LOST: 2, ARCHIVED: 0 } },
  classSessions: { inRange: { scheduled: 5, completed: 6, cancelled: 7 } },
  attendance: { inRangeByStatus: { PRESENT: 8, LATE: 9, EXCUSED_ABSENCE: 10, UNEXCUSED_ABSENCE: 11, MAKEUP: 12 } },
  memberships: { byState: { DRAFT: 0, ACTIVE: 13, FROZEN: 1, CANCELLATION_PENDING: 2, CANCELLED: 3, EXPIRED: 4 } },
  invoices: { inRangeByStatus: { DRAFT: 0, ISSUED: 5, PAID: 6, VOID: 7, UNCOLLECTIBLE: 8 } },
  paymentAttempts: { inRangeByState: { PENDING: 0, PROCESSING: 1, SUCCEEDED: 2, FAILED: 3, REQUIRES_ACTION: 4, UNKNOWN: 5, REFUNDED: 6 } },
});
const response = (operationalSnapshot: unknown) => ({ ok: true, json: async () => ({ data: { operationalSnapshot }, meta: { requestId: 'id', correlationId: 'id' } }) }) as Response;

describe('staff operations dashboard', () => {
  it('uses exactly the existing same-origin read-only operations report and reconstructs its aggregate DTO', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(report()));
    try {
      expect(staffDashboardReportPath(organizationId.toUpperCase(), schoolId.toUpperCase())).toBe(`/api/v1/organizations/${organizationId}/schools/${schoolId}/reports/operations`);
      await expect(loadStaffDashboard(organizationId, schoolId)).resolves.toMatchObject({ organizationId, schoolId, memberships: { byState: { ACTIVE: 13 } } });
      expect(fetchSpy).toHaveBeenCalledWith(`/api/v1/organizations/${organizationId}/schools/${schoolId}/reports/operations`, expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' }));
      for (const unsafe of ['https://example.invalid', `${organizationId}/reports`, 'not-a-uuid']) expect(() => staffDashboardReportPath(unsafe, schoolId)).toThrow();
    } finally { fetchSpy.mockRestore(); }
  });

  it('fails closed on PII, notes, payment methods, private evidence, scope mismatch, and access denial', async () => {
    for (const patch of [{ personName: 'PRIVATE_PERSON' }, { rawNote: 'PRIVATE_NOTE' }, { paymentMethod: 'PRIVATE_PAYMENT' }, { actionEvidence: { raw: true } }, { schoolId: organizationId }]) {
      expect(() => verifyStaffDashboardSnapshot({ ...report(), ...patch }, organizationId, schoolId)).toThrow();
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 403 } as Response);
    try { await expect(loadStaffDashboard(organizationId, schoolId)).rejects.toBeInstanceOf(StaffDashboardAccessError); } finally { fetchSpy.mockRestore(); }
  });

  it('starts without fabricated metrics and exposes explicit unavailable states plus real managed-workflow links', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<StaffDashboard />);
      expect(fetchSpy).not.toHaveBeenCalled();
      for (const text of ['No verified school is selected', 'no contact data, notes, payment methods, private evidence']) expect(html).toContain(text);
      expect(html).not.toContain('31,850');
      expect(html).not.toContain('Ideal Martial Arts');
    } finally { fetchSpy.mockRestore(); }
  });

  it('is a protected no-index staff route and imports no mutation, automation, AI, voice, external, or execution client', () => {
    const route = readFileSync('src/app/staff/dashboard/page.tsx', 'utf8');
    const component = readFileSync('src/components/staff-dashboard.tsx', 'utf8');
    const http = readFileSync('src/components/staff-dashboard-http.ts', 'utf8');
    for (const text of ['verifySession', "redirect('/auth/login')", 'index: false', 'follow: false', 'force-dynamic']) expect(route).toContain(text);
    expect(component).toContain('setSnapshot(null)');
    for (const text of ['Student profiles', 'Current-school aggregate', 'Trial count unavailable', 'Revenue-plan summary unavailable', 'NOT COUNTED HERE']) expect(component).toContain(text);
    for (const href of ['/staff/search', '/staff/planning/revenue', '/staff/launch', '/staff/crm/follow-ups', '/staff/billing/renewals', '/staff/action-center/approvals', '/staff/work']) expect(component).toContain(href);
    expect(http).toContain("method: 'GET'");
    expect(http).toContain("credentials: 'same-origin'");
    expect(http).not.toMatch(/method:\s*'POST'|Idempotency-Key|X-HON-Human-Command|invokeLLM|executeAction|sendMessage|from\s+['"][^'"]*(?:voice|action|ai|provider)/i);
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    expect(manifest.routes.filter((item: { path: string }) => item.path === '/staff/dashboard')).toHaveLength(1);
  });
});
