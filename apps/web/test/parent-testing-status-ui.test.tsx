import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { verifyParentTestingStatusView, type ParentTestingStatusView } from '@hon/contracts';
import { ParentTestingStatus } from '../src/components/parent-testing-status';
import { loadParentTestingStatus, ParentTestingStatusAccessError } from '../src/components/parent-testing-status-http';

const id = '11111111-1111-4111-8111-111111111111'; const at = '2026-11-01T10:00:00.000Z';
const view = (): ParentTestingStatusView => ({ generatedAt: at, accessLevel: 'PRIMARY_GUARDIAN', children: { status: 'AVAILABLE', limited: false, items: [{ displayName: 'Authorized child', upcomingEvent: { label: 'Existing event', startsAt: at, endsAt: null }, candidates: { status: 'AVAILABLE', limited: false, items: [{ event: { label: 'Existing event', startsAt: at, endsAt: null }, overallStatus: 'PENDING' }] }, registrationInterests: { status: 'AVAILABLE', limited: false, items: [{ event: { label: 'Existing event', startsAt: at, endsAt: null }, status: 'SUBMITTED', submittedAt: at, reviewedAt: null }] }, certificate: { status: 'UNAVAILABLE', reason: 'PAYER_LINK_UNVERIFIED' } }] } });
const response = (data: unknown) => Response.json({ data, meta: { requestId: id, correlationId: id } });

describe('parent-safe testing status', () => {
  it('uses one fixed credentialed same-origin GET and rejects identifiers, evaluator/criteria, rank, promotion, and certificate detail fields', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(view()));
    try {
      await expect(loadParentTestingStatus()).resolves.toEqual(view());
      expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/v1/parent/testing/status', expect.objectContaining({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' }));
      for (const field of ['familyId', 'studentProfileId', 'schoolId', 'organizationId', 'candidateId', 'evaluatorId', 'criteria', 'comment', 'rank', 'promotion', 'certificateId', 'downloadUrl', 'payment', 'eligibility']) expect(() => verifyParentTestingStatusView({ ...view(), [field]: 'PRIVATE' })).toThrow();
      const nested = view(); if (nested.children.items[0]) nested.children.items[0] = { ...nested.children.items[0], candidates: { ...nested.children.items[0].candidates, items: [{ ...nested.children.items[0].candidates.items[0]!, evaluator: 'PRIVATE' } as never] } };
      expect(() => verifyParentTestingStatusView(nested)).toThrow();
    } finally { fetcher.mockRestore(); }
  });
  it('rejects unsafe envelopes and clears access loss without consuming an upstream payload', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: view(), meta: { requestId: id, correlationId: id, familyId: id } }));
    try { await expect(loadParentTestingStatus()).rejects.toThrow('could not be verified'); } finally { fetcher.mockRestore(); }
    const json = vi.fn(); const failed = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 403, json } as unknown as Response);
    try { await expect(loadParentTestingStatus()).rejects.toBeInstanceOf(ParentTestingStatusAccessError); expect(json).not.toHaveBeenCalled(); } finally { failed.mockRestore(); }
  });
  it('renders a loading state with no SSR fetch, no invented testing record, and explicit non-action language', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try { const html = renderToStaticMarkup(<ParentTestingStatus/>); expect(fetcher).not.toHaveBeenCalled(); expect(html).toContain('Loading current family testing status'); expect(html).not.toMatch(/Authorized child|checkout|credit card|send message|issue certificate|download certificate|invokeLLM/i); } finally { fetcher.mockRestore(); }
  });
  it('has a no-index guarded route and no client mutation, selector, provider, AI, Action Engine, voice, or storage behavior', () => {
    const route = readFileSync('src/app/parent/testing/page.tsx', 'utf8'); const component = readFileSync('src/components/parent-testing-status.tsx', 'utf8'); const http = readFileSync('src/components/parent-testing-status-http.ts', 'utf8');
    for (const token of ['cookieValue', 'verifySession', "redirect('/auth/login')", 'force-dynamic', 'index: false', 'follow: false']) expect(route).toContain(token);
    expect(route).not.toMatch(/searchParams|familyId|studentId|schoolId/); expect(component).toContain('setView(null)'); expect(component).toContain('pending.current?.abort()'); expect(component).toContain("'visibilitychange'"); expect(component).not.toMatch(/<input|useSearchParams|localStorage|sessionStorage/);
    expect(http + component).not.toMatch(/method:\s*'POST'|Idempotency-Key|X-HON-Human-Command|invokeLLM|executeAction|sendMessage|paymentMethod|providerToken|cardNumber/i);
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')); expect(manifest.routes.filter((entry: { path: string }) => entry.path === '/parent/testing')).toHaveLength(1);
  });
});
