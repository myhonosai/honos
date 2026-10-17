import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { ParentPlannedAbsenceHistory } from '../src/components/parent-planned-absence-history';
import { loadParentPlannedAbsenceHistory, ParentPlannedAbsenceHistoryAccessError } from '../src/components/parent-planned-absence-history-http';
import { verifyParentPlannedAbsenceHistoryView, type ParentPlannedAbsenceHistoryView } from '@hon/contracts';

const id = '11111111-1111-4111-8111-111111111111';
const from = '2026-01-01T00:00:00.000Z', to = new Date(Date.parse(from) + 271 * 86_400_000).toISOString(), generatedAt = '2026-06-01T00:00:00.000Z';
const view = (): ParentPlannedAbsenceHistoryView => ({ generatedAt, from, to, accessLevel: 'PRIMARY_GUARDIAN', requests: { status: 'AVAILABLE', limited: false, items: [{ child: { displayName: 'Authorized child' }, startsAt: '2026-02-01T09:00:00.000Z', endsAt: '2026-02-01T11:00:00.000Z', status: 'APPROVED', submittedAt: '2026-01-20T09:00:00.000Z', reviewedAt: '2026-01-21T09:00:00.000Z' }] } });
const response = (data: unknown) => Response.json({ data, meta: { requestId: id, correlationId: id } });

describe('family-safe planned-absence history', () => {
  it('has one fixed same-origin credentialed GET, no selector, and strict redacted DTO verification', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(view()));
    try {
      await expect(loadParentPlannedAbsenceHistory()).resolves.toEqual(view());
      expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/v1/parent/planned-absences/history', expect.objectContaining({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' }));
      for (const secret of ['familyId', 'studentProfileId', 'schoolId', 'requestId', 'reviewedByPrincipalId', 'reason', 'reviewNote', 'schedule', 'attendance', 'makeup', 'roster', 'aiAction']) expect(() => verifyParentPlannedAbsenceHistoryView({ ...view(), [secret]: 'PRIVATE' })).toThrow();
      expect(() => verifyParentPlannedAbsenceHistoryView({ ...view(), accessLevel: 'VIEWER' })).toThrow();
      expect(() => verifyParentPlannedAbsenceHistoryView({ ...view(), requests: { ...view().requests, items: [{ ...view().requests.items[0]!, reviewer: 'PRIVATE' }] } })).toThrow();
    } finally { fetcher.mockRestore(); }
  });

  it('rejects unsafe timing, private nested data, fabricated history bounds, and unsafe envelopes', async () => {
    expect(() => verifyParentPlannedAbsenceHistoryView({ ...view(), from: '2026-02-01T00:00:00.000Z' })).toThrow();
    expect(() => verifyParentPlannedAbsenceHistoryView({ ...view(), requests: { ...view().requests, items: [{ ...view().requests.items[0]!, endsAt: '2026-02-01T08:00:00.000Z' }] } })).toThrow();
    expect(() => verifyParentPlannedAbsenceHistoryView({ ...view(), requests: { ...view().requests, items: [{ ...view().requests.items[0]!, status: 'SUBMITTED', reviewedAt: '2026-01-21T09:00:00.000Z' }] } })).toThrow();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: view(), meta: { requestId: id, correlationId: id, familyId: id } }));
    try { await expect(loadParentPlannedAbsenceHistory()).rejects.toThrow('could not be verified'); } finally { fetcher.mockRestore(); }
  });

  it.each([401, 403])('clears content for %s permission loss without consuming upstream details', async status => {
    const json = vi.fn(); const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status, json } as unknown as Response);
    try { await expect(loadParentPlannedAbsenceHistory()).rejects.toBeInstanceOf(ParentPlannedAbsenceHistoryAccessError); expect(json).not.toHaveBeenCalled(); } finally { fetcher.mockRestore(); }
  });

  it('starts in a real loading state without SSR fetches or fabricated family history', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try { const html = renderToStaticMarkup(<ParentPlannedAbsenceHistory/>); expect(fetcher).not.toHaveBeenCalled(); expect(html).toContain('loading recorded planned-absence status'); expect(html).toContain('Submission only. No automatic outcome.'); expect(html).not.toMatch(/Avery|Ideal Martial Arts|PRIVATE_|Eian/); } finally { fetcher.mockRestore(); }
  });

  it('protects/no-indexes the dynamic route and keeps human submission separate from read-only redacted history', () => {
    const route = readFileSync('src/app/parent/planned-absences/page.tsx', 'utf8'); const component = readFileSync('src/components/parent-planned-absence-history.tsx', 'utf8'); const http = readFileSync('src/components/parent-planned-absence-history-http.ts', 'utf8');
    for (const token of ['cookieValue', 'verifySession', "redirect('/auth/login')", 'force-dynamic', 'index: false', 'follow: false']) expect(route).toContain(token);
    expect(route).not.toMatch(/searchParams|familyId|studentProfileId|requestId/);
    for (const token of ['No planned-absence request for a current child', 'Guardian family access unavailable', 'No verified absence history shown', 'setView(null)', 'pending.current?.abort()', "'visibilitychange'"]) expect(component).toContain(token);
    expect(component).not.toMatch(/useSearchParams|localStorage|sessionStorage|schoolId|familyId|invokeLLM|executeAction|sendMessage|reviewNote/i);
    expect(http + component).not.toMatch(/invokeLLM|executeAction|sendMessage|from\s+['"][^'"]*(?:voice|action|ai\/|provider|billing)/i);
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')); expect(manifest.routes.filter((route: { path: string }) => route.path === '/parent/planned-absences')).toEqual([{ path: '/parent/planned-absences', title: 'HON | Planned absence history' }]);
  });
});
