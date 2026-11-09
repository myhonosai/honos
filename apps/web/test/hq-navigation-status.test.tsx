import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateSaasPaymentsView } from '@hon/contracts';
import { saasOverviewFixture } from '../scripts/fixtures/hq-saas-review.mjs';

const nav = vi.hoisted(() => ({ path: '/hq' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.path }));
import { HQ_AI, HQ_GROWTH, HQ_NAV, HQ_NAV_GROUPS, HQ_REVENUE, hqGroupContains, hqPageLabel } from '../src/components/hq-modern/catalog';
import { HqModernShell } from '../src/components/hq-modern/shell';
import { HqCommercialStatusError, loadHqCreditProgramStatus, loadHqPaymentProgramStatus } from '../src/components/hq-modern/commercial-status-http';
import { CommercialStatus } from '../src/components/hq-modern/commercial-status';

const paymentsView = (status: 'DISABLED' | 'TEST_MODE' = 'DISABLED') => validateSaasPaymentsView({
  program: status === 'DISABLED'
    ? { status, provider: null, mode: null, liveMode: 'UNAVAILABLE', testTaxReference: null, authorizationReference: null, version: 1, changedAt: '2026-10-19T00:00:00.000Z', cardDataStored: false, refundExecution: 'UNAVAILABLE' }
    : { status, provider: 'STRIPE', mode: 'TEST', liveMode: 'UNAVAILABLE', testTaxReference: 'tax-test-ref', authorizationReference: 'owner-test-ref', version: 2, changedAt: '2026-10-19T00:00:00.000Z', cardDataStored: false, refundExecution: 'UNAVAILABLE' },
  checkouts: [], events: [],
  reconciliation: { openPastExpiry: 0, createdWithoutProviderSession: 0, paidNeedsReview: 0, eventsNeedingReview: 0, awaitingAsyncPayment: 0 },
  asOf: '2026-10-24T00:00:00.000Z',
});
const ok = (data: unknown) => ({ ok: true, json: async () => ({ data }) } as Response);
afterEach(() => vi.restoreAllMocks());

describe('HQ navigation groups', () => {
  it('places Pricing & Offers under Revenue and AI Providers under AI without changing any URL', () => {
    expect(HQ_REVENUE.map((item) => item.path)).toEqual(['/hq/revenue', '/hq/revenue/invoices', '/hq/revenue/trials', '/hq/pricing-offers']);
    expect(HQ_AI.map((item) => item.path)).toEqual(['/hq/executives', '/hq/ai-costs', '/hq/creative-credits', '/hq/ai-safety', '/hq/ai-providers']);
    const topLevel = HQ_NAV.map((item) => item.path);
    for (const moved of ['/hq/pricing-offers', '/hq/ai-providers', '/hq/ai-costs', '/hq/ai-safety']) expect(topLevel).not.toContain(moved);
    for (const entry of [...HQ_NAV, ...HQ_REVENUE, ...HQ_AI, ...HQ_GROWTH]) expect(existsSync(`src/app${entry.path}/page.tsx`)).toBe(true);
    expect(Object.values(HQ_NAV_GROUPS).map((group) => group.key)).toEqual(['schools', 'revenue', 'ai', 'growth']);
  });

  it('keeps page labels and opens only the group that holds the current page', () => {
    expect(hqPageLabel('/hq/revenue')).toBe('Revenue');
    expect(hqPageLabel('/hq/pricing-offers')).toBe('Pricing & Offers');
    expect(hqPageLabel('/hq/ai-providers')).toBe('AI Providers');
    expect(hqPageLabel('/hq/executives')).toBe('Executive Team');
    const revenue = HQ_NAV_GROUPS['/hq/revenue']!, ai = HQ_NAV_GROUPS['/hq/executives']!;
    expect(hqGroupContains(revenue, '/hq/revenue/invoices/00000000-0000-4000-8000-000000000001')).toBe(true);
    expect(hqGroupContains(revenue, '/hq/pricing-offers')).toBe(true);
    expect(hqGroupContains(ai, '/hq/executives/chase')).toBe(true);
    expect(hqGroupContains(ai, '/hq/revenue')).toBe(false);
  });

  it('renders one shared navigation in the rail and drawer with the current child marked', () => {
    nav.path = '/hq/pricing-offers';
    const html = renderToStaticMarkup(<HqModernShell><p>child</p></HqModernShell>);
    expect(html.match(/aria-label="HQ navigation"/g)).toHaveLength(2);
    expect(html.match(/<a[^>]*aria-current="page"[^>]*href="\/hq\/pricing-offers"|<a[^>]*href="\/hq\/pricing-offers"[^>]*aria-current="page"/g)).toHaveLength(2);
    expect(html.match(/<details[^>]*data-hq-nav-group="revenue"[^>]*open=""|<details[^>]*open=""[^>]*data-hq-nav-group="revenue"/g)).toHaveLength(2);
    expect(html).not.toMatch(/<details[^>]*open=""[^>]*data-hq-nav-group="ai"|<details[^>]*data-hq-nav-group="ai"[^>]*open=""/);
    nav.path = '/hq';
  });

  it('removes duplicated navigation and presentation controls from Schools and AI Providers', () => {
    const shell = readFileSync('src/components/hq-modern/shell.tsx', 'utf8');
    expect(shell).not.toContain('ContentElement');
    const schools = readFileSync('src/components/hq-school-directory.tsx', 'utf8');
    expect(schools).not.toMatch(/<nav|<main|PRESENTATION_MODES|setPresentation/);
    const providers = readFileSync('src/components/hq-ai-provider-control.tsx', 'utf8');
    expect(providers).not.toMatch(/<main|HQ command center|styles\.brand|<h1/);
    expect(providers).toContain('aria-label="AI provider control sections"');
  });
});

describe('HQ commercial program status', () => {
  it('reads only the two fixed authorized GETs and keeps only program fields', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => ok(String(path).endsWith('/payments') ? paymentsView('TEST_MODE') : saasOverviewFixture().credits));
    const payments = await loadHqPaymentProgramStatus();
    const credits = await loadHqCreditProgramStatus();
    expect(payments).toEqual({ status: 'TEST_MODE', mode: 'TEST', liveMode: 'UNAVAILABLE', refundExecution: 'UNAVAILABLE', changedAt: '2026-10-19T00:00:00.000Z', asOf: '2026-10-24T00:00:00.000Z' });
    expect(Object.keys(credits).sort()).toEqual(['changedAt', 'overage', 'purchases', 'status', 'topUps']);
    for (const suffix of ['payments', 'credits']) expect(fetch).toHaveBeenCalledWith(`/api/v1/hq/saas/${suffix}`, expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' }));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fails closed on denied, unavailable, augmented or wrapped responses', async () => {
    for (const [status, kind] of [[401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [503, 'UNAVAILABLE']] as const) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status } as Response);
      await expect(loadHqPaymentProgramStatus()).rejects.toMatchObject({ kind });
      vi.restoreAllMocks();
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({ ...paymentsView(), program: { ...paymentsView().program, status: 'LIVE' } }));
    await expect(loadHqPaymentProgramStatus()).rejects.toEqual(expect.any(HqCommercialStatusError));
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ data: saasOverviewFixture().credits, extra: true }) } as Response);
    await expect(loadHqCreditProgramStatus()).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
  });

  it('renders verifying states before the reads and never a hardcoded program state', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const html = renderToStaticMarkup(<CommercialStatus/>);
    expect(fetch).not.toHaveBeenCalled();
    for (const text of ['Commercial programs', 'Payment program', 'Live checkout', 'AI credit program', 'Read-only · server reported']) expect(html).toContain(text);
    expect(html.match(/Verifying…/g)).toHaveLength(3);
    expect(html).not.toMatch(/Test mode|Disabled|Inactive|data-commercial-state|paid access|Paid-access/i);
    const source = readFileSync('src/components/hq-modern/commercial-status-http.ts', 'utf8');
    expect(source).not.toMatch(/method:\s*'POST'|Idempotency-Key|program\/|organizationId/);
  });
});
