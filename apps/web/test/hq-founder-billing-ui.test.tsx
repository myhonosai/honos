import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { founderBillingApi, FounderBillingError } from '../src/components/hq-founder-billing/http';
import { FounderBillingScreen } from '../src/components/hq-founder-billing/hq-founder-billing';
import { HQ_REVENUE } from '../src/components/hq-modern/catalog';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = '2026-11-12T08:00:00.000Z';
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const pool = (allocated = 2) => ({ capacity: 50, allocated, remaining: 50 - allocated, countingRule: 'FIRST_VERIFIED_SCHEDULE_PAYMENT', legacyFounderSalesCounted: false,
  spots: Array.from({ length: allocated }, (_, i) => ({ spotNumber: i + 1, organizationId: U(10 + i), schoolId: U(100 + i), bindingId: U(200 + i), offerId: U(300),
    offerKind: i % 2 ? 'FOUNDER_ANNUAL' : 'FOUNDER_MONTHLY', lockedPriceMinor: i % 2 ? 149400 : 19920, allocatedAt: AT })),
  heldWithoutSpot: allocated === 50 ? 1 : 0, checkoutAvailable: false, asOf: AT });
const item = { subjectKind: 'SCHEDULE_BINDING', subjectId: U(500), subjectVersion: 3, organizationId: U(60), schoolId: U(61), billingStatus: 'NEEDS_REVIEW',
  reason: 'FOUNDER_SPOT_UNAVAILABLE', heldItemCount: 1, heldAmountMinor: 19920, refundedAmountMinor: 0, fullyRefunded: false, receivedAt: AT, blocker: null,
  allowedDecisions: ['REFUND_OWED'], accessRetryAvailable: false, openResolution: null, providerActionExecuted: false };
const queue = (items: unknown[] = []) => ({ items, nextCursor: null, providerActionExecuted: false });
const signal = () => new AbortController().signal;
afterEach(() => vi.restoreAllMocks());

it('reads only the founder pool and the paid review queue with GET', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => ok(String(path).endsWith('founder-pool') ? pool() : queue()));
  const view = await founderBillingApi.load(signal(), () => true);
  expect(view.pool.allocated).toBe(2);
  expect(fetch.mock.calls.map((c) => c[0])).toEqual(['/api/v1/hq/saas/founder-pool', '/api/v1/hq/saas/paid-reviews']);
  for (const [, init] of fetch.mock.calls) expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
});

it('refuses drift, a checkout claim and a miscounted pool, and maps denial', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const bad of [{ ...pool(), checkoutAvailable: true }, { ...pool(), remaining: 49 }, { ...pool(), extra: 1 }]) {
    fetch.mockImplementation(async (path) => ok(String(path).endsWith('founder-pool') ? bad : queue()));
    await expect(founderBillingApi.load(signal(), () => true)).rejects.toMatchObject({ kind: 'INVALID' });
  }
  fetch.mockImplementation(async () => new Response('{}', { status: 403 }));
  await expect(founderBillingApi.load(signal(), () => true)).rejects.toBeInstanceOf(FounderBillingError);
  await expect(founderBillingApi.load(signal(), () => true)).rejects.toMatchObject({ kind: 'DENIED' });
});

it('shows counted spots, a sold-out pool and a held late payment without any action', () => {
  const html = renderToStaticMarkup(<FounderBillingScreen read={{ state: 'READY', view: { pool: pool(50) as never, reviews: queue([item]) as never } }} onRefresh={() => {}}/>);
  for (const s of ['Founder spots', '50 of 50', 'sold out', 'Spot 1 · Founder monthly · $199.20 / month', 'Spot 2 · Founder annual · $1,494 / year',
    'Paid after all 50 founder spots were taken', 'Held $199.20 in 1 payment', 'Waiting for the HQ owner to record a refund owed', 'never refunded automatically']) expect(html).toContain(s);
  expect(html).not.toMatch(/<form|type="submit"/);
  const empty = renderToStaticMarkup(<FounderBillingScreen read={{ state: 'READY', view: { pool: pool(0) as never, reviews: queue() as never } }} onRefresh={() => {}}/>);
  expect(empty).toContain('No founder spot has been counted yet.'); expect(empty).toContain('No payment is held for review.'); expect(empty).toContain('50 left');
  expect(renderToStaticMarkup(<FounderBillingScreen read={{ state: 'DENIED' }} onRefresh={() => {}}/>)).toContain('HQ owner and billing operators');
});

it('is reachable from HQ Revenue and declared in the route manifest', () => {
  expect(HQ_REVENUE.some((e) => e.path === '/hq/revenue/founder-billing' && e.title === 'Founder Billing')).toBe(true);
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string }[] };
  expect(manifest.routes.filter((r) => r.path === '/hq/revenue/founder-billing')).toHaveLength(1);
});
