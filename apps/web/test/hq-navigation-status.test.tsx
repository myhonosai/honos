import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateSaasPaymentsView } from '@hon/contracts';
import { saasOverviewFixture } from '../scripts/fixtures/hq-saas-review.mjs';

const nav = vi.hoisted(() => ({ path: '/hq' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.path }));
import { HQ_AI, HQ_INBOX, HQ_NAV, HQ_NAV_GROUPS, HQ_REVENUE, HQ_SETTINGS, hqGroupContains, hqNavLinks, hqNavMatch, hqPageLabel } from '../src/components/hq-modern/catalog';
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
  it('groups HQ into seven agency-style sections without changing any URL', () => {
    expect(HQ_NAV.map((item) => item.title)).toEqual(['Home', 'Schools', 'Plans & Billing', 'Grow', 'Messages & Support', 'AI Team', 'Settings']);
    expect(HQ_REVENUE.map((item) => item.path)).toEqual(['/hq/pricing-offers', '/hq/marketing/promotions', '/hq/revenue', '/hq/revenue/business-numbers', '/hq/revenue/invoices', '/hq/revenue/trials', '/hq/revenue/founder-billing', '/hq/creative-credits', '/hq/revenue/sign-up-limits']);
    expect(HQ_AI.map((item) => item.path)).toEqual(['/hq/executives', '/hq/ai-costs', '/hq/conversation-ai', '/hq/ai-safety']);
    expect(HQ_INBOX.map((item) => item.path)).toEqual(['/hq/approvals', '/hq/support', '/hq/communications', '/hq/communications/numbers']);
    expect(HQ_SETTINGS.map((item) => item.path)).toEqual(['/hq/founder-setup', '/hq/ai-providers', '/hq/integrations/zernio']);
    const links = hqNavLinks().map((item) => item.path);
    expect(new Set(links).size).toBe(links.length);
    for (const path of links) expect(existsSync(`src/app${path}/page.tsx`)).toBe(true);
    // Every HQ page in the app is reachable from the menu, except detail pages and the growth overview's own sub-pages.
    const pages = (readdirSync('src/app/hq', { recursive: true }) as string[]).filter((file) => file.endsWith('page.tsx') && !file.includes('['))
      .map((file) => `/hq${file === 'page.tsx' ? '' : `/${file.replace(/\/page\.tsx$/, '')}`}`);
    for (const page of pages) expect(hqNavMatch(page), page).not.toBeNull();
    expect(Object.values(HQ_NAV_GROUPS).map((group) => group.key)).toEqual(['schools', 'billing', 'growth', 'inbox', 'ai', 'settings']);
  });

  it('keeps page labels and opens only the group that holds the current page', () => {
    expect(hqPageLabel('/hq/revenue')).toBe('Revenue');
    expect(hqPageLabel('/hq/schools')).toBe('Schools');
    expect(hqPageLabel('/hq/pricing-offers')).toBe('Pricing & Offers');
    expect(hqPageLabel('/hq/ai-providers')).toBe('AI Providers');
    expect(hqPageLabel('/hq/executives')).toBe('Executive Team');
    expect(hqPageLabel('/hq/marketing/promotions')).toBe('Plan promotions');
    const billing = HQ_NAV_GROUPS['/hq/revenue']!, ai = HQ_NAV_GROUPS['/hq/executives']!, growth = HQ_NAV_GROUPS['/hq/growth']!, inbox = HQ_NAV_GROUPS['/hq/support']!;
    expect(hqGroupContains(billing, '/hq/revenue/invoices/00000000-0000-4000-8000-000000000001')).toBe(true);
    expect(hqGroupContains(billing, '/hq/pricing-offers')).toBe(true);
    expect(hqGroupContains(billing, '/hq/marketing/promotions')).toBe(true);
    expect(hqGroupContains(growth, '/hq/marketing/promotions')).toBe(false);
    expect(hqGroupContains(growth, '/hq/marketing/creative')).toBe(true);
    expect(hqGroupContains(inbox, '/hq/communications/numbers')).toBe(true);
    expect(hqGroupContains(ai, '/hq/executives/chase')).toBe(true);
    expect(hqGroupContains(ai, '/hq/revenue')).toBe(false);
    expect(hqNavMatch('/hq')).toBe('/hq');
    expect(hqNavMatch('/hq/communications/numbers')).toBe('/hq/communications/numbers');
    expect(hqNavMatch('/hq/schools/access/policy')).toBe('/hq/schools/access/policy');
  });

  it('renders one shared navigation in the rail and drawer with only the current child marked', () => {
    nav.path = '/hq/marketing/promotions';
    const html = renderToStaticMarkup(<HqModernShell><p>child</p></HqModernShell>);
    expect(html.match(/aria-label="HQ navigation"/g)).toHaveLength(2);
    expect(html.match(/aria-current="page"/g)).toHaveLength(2);
    expect(html.match(/<a[^>]*aria-current="page"[^>]*href="\/hq\/marketing\/promotions"|<a[^>]*href="\/hq\/marketing\/promotions"[^>]*aria-current="page"/g)).toHaveLength(2);
    expect(html.match(/<details[^>]*data-hq-nav-group="billing"[^>]*open=""|<details[^>]*open=""[^>]*data-hq-nav-group="billing"/g)).toHaveLength(2);
    expect(html).not.toMatch(/<details[^>]*open=""[^>]*data-hq-nav-group="growth"|<details[^>]*data-hq-nav-group="growth"[^>]*open=""/);
    nav.path = '/hq';
  });

  it('keeps the page frame quiet: display choices in the header, no policy sentence in the footer', () => {
    nav.path = '/hq/support';
    const html = renderToStaticMarkup(<HqModernShell><p>child</p></HqModernShell>);
    expect(html).not.toContain('HQ remains separate from school CRM');
    expect(html).not.toContain('Presentation only');
    expect(html).not.toContain('One governed workspace');
    expect(html).toMatch(/<header[^>]*>.*data-hq-appearance.*<\/header>/s);
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
    for (const text of ['Payments &amp; credits', 'Taking payments', 'Real-money checkout', 'AI credits']) expect(html).toContain(text);
    expect(html.match(/Loading…/g)).toHaveLength(3);
    expect(html).not.toMatch(/Test mode|Disabled|Inactive|data-commercial-state|paid access|Paid-access/i);
    const source = readFileSync('src/components/hq-modern/commercial-status-http.ts', 'utf8');
    expect(source).not.toMatch(/method:\s*'POST'|Idempotency-Key|program\/|organizationId/);
  });
});
