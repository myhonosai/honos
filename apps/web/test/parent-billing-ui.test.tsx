import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { verifyParentBillingView, type ParentBillingView } from '@hon/contracts';
import { ParentBilling } from '../src/components/parent-billing';
import { loadParentBilling, ParentBillingAccessError } from '../src/components/parent-billing-http';
const id = '11111111-1111-4111-8111-111111111111'; const at = '2026-01-01T00:00:00.000Z';
const view = (): ParentBillingView => ({ generatedAt: at, accessLevel: 'PRIMARY_GUARDIAN', memberships: { status: 'AVAILABLE', limited: false, items: [{ participant: { displayName: 'Authorized child', linkage: 'CURRENT_FAMILY_STUDENT' }, payerLinkage: 'CURRENT_FAMILY_DESIGNATED_BILLING_CONTACT', state: 'ACTIVE', termStartedAt: at, termEndsAt: null }] }, invoices: { status: 'AVAILABLE', limited: false, items: [{ participant: { displayName: 'Authorized child', linkage: 'CURRENT_FAMILY_STUDENT' }, status: 'ISSUED', currency: 'USD', totalMinor: 12000, dueAt: null, paymentAttempts: { status: 'AVAILABLE', limited: false, items: [{ state: 'PENDING', amountMinor: 12000, currency: 'USD', initiatedAt: at, reconciledAt: null }] } }] } });
const response = (data: unknown) => Response.json({ data, meta: { requestId: id, correlationId: id } });

describe('family-safe parent billing observations', () => {
  it('has one fixed same-origin credentialed GET and rejects authority, payer, provider and token DTO fields', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(view()));
    try {
      await expect(loadParentBilling()).resolves.toEqual(view());
      expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/v1/parent/billing', expect.objectContaining({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' }));
      for (const field of ['familyId', 'studentId', 'schoolId', 'accountId', 'invoiceId', 'paymentId', 'payerName', 'providerCode', 'providerToken', 'paymentMethod', 'cardNumber', 'planCode', 'schedule', 'action']) expect(() => verifyParentBillingView({ ...view(), [field]: 'PRIVATE' })).toThrow();
      const nested = view(); if (nested.invoices.status === 'AVAILABLE') nested.invoices.items[0] = { ...nested.invoices.items[0]!, paymentAttempts: { ...nested.invoices.items[0]!.paymentAttempts, items: [{ ...nested.invoices.items[0]!.paymentAttempts.items[0]!, providerCode: 'PRIVATE' } as never] } }; expect(() => verifyParentBillingView(nested)).toThrow();
    } finally { fetcher.mockRestore(); }
  });
  it('rejects impossible or fabricated terms/payment facts and invalid envelopes', async () => {
    const badTerm = view(); if (badTerm.memberships.status === 'AVAILABLE') badTerm.memberships.items[0] = { ...badTerm.memberships.items[0]!, termEndsAt: '2025-01-01T00:00:00.000Z' }; expect(() => verifyParentBillingView(badTerm)).toThrow();
    const uncertain = view(); uncertain.invoices = { status: 'UNAVAILABLE', reason: 'PAYER_LINK_UNVERIFIED' }; expect(() => verifyParentBillingView(uncertain)).toThrow();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: view(), meta: { requestId: id, correlationId: id, familyId: id } }));
    try { await expect(loadParentBilling()).rejects.toThrow('could not be verified'); fetcher.mockResolvedValue(new Response('<html>Login</html>', { headers: { 'Content-Type': 'text/html' } })); await expect(loadParentBilling()).rejects.toThrow('could not be verified'); } finally { fetcher.mockRestore(); }
  });
  it.each([401, 403])('clears access loss for %s without reading an upstream payload', async status => {
    const json = vi.fn(); const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status, json } as unknown as Response);
    try { await expect(loadParentBilling()).rejects.toBeInstanceOf(ParentBillingAccessError); expect(json).not.toHaveBeenCalled(); } finally { fetcher.mockRestore(); }
  });
  it('renders a loading state with no SSR fetch, no invented records and explicit non-action language', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try { const html = renderToStaticMarkup(<ParentBilling/>); expect(fetcher).not.toHaveBeenCalled(); expect(html).toContain('Loading billing observations'); expect(html).not.toMatch(/Authorized child|Visa|Stripe|Eian/); } finally { fetcher.mockRestore(); }
  });
  it('protects/no-indexes the route and has no client mutation, provider, storage or selector behavior', () => {
    const route = readFileSync('src/app/parent/billing/page.tsx', 'utf8'); const component = readFileSync('src/components/parent-billing.tsx', 'utf8'); const http = readFileSync('src/components/parent-billing-http.ts', 'utf8');
    for (const token of ['cookieValue', 'verifySession', "redirect('/auth/login')", 'force-dynamic', 'index: false', 'follow: false']) expect(route).toContain(token);
    expect(route).not.toMatch(/searchParams|familyId|studentId|schoolId/); expect(component).toContain('setView(null)'); expect(component).toContain('pending.current?.abort()'); expect(component).toContain("'visibilitychange'"); expect(component).not.toMatch(/<input|useSearchParams|localStorage|sessionStorage/);
    expect(http + component).not.toMatch(/method:\s*'POST'|Idempotency-Key|X-HON-Human-Command|invokeLLM|executeAction|sendMessage|paymentMethod|providerToken|cardNumber/i);
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')); expect(manifest.routes.filter((route: { path: string }) => route.path === '/parent/billing')).toHaveLength(1);
  });
});
