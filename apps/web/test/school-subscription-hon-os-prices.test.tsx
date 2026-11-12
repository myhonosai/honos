import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HON_OS_PRODUCT, HON_OS_LAUNCH_PRICING_REFERENCE } from '@hon/contracts';
import { loadHonOsPrices } from '../src/components/school-subscription/http';
import { honOsOneTimeRows, honOsPriceRows, FOUNDER_REASON_COPY, ONE_TIME_ELIGIBILITY_COPY } from '../src/components/school-subscription/catalog';
import { HonOsOneTimeCard, HonOsPriceCard, HonOsPrices } from '../src/components/school-subscription/hon-os-prices';
import { SchoolSubscription } from '../src/components/school-subscription/subscription';
import { checkoutId, schoolContext } from '../scripts/fixtures/school-checkout.mjs';

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
const account = { context: { organizationId: schoolContext.organizationId, schoolId: schoolContext.schoolId }, plan: {} as never };
const AT = '2026-11-12T08:00:00.000Z';
const emptyOffers = (patch = {}) => ({ schoolId: schoolContext.schoolId, product: { ...HON_OS_PRODUCT, capabilities: [...HON_OS_PRODUCT.capabilities] },
  offerSetVersion: null, termsReference: null, offers: [], purchase: 'UNAVAILABLE', checkout: null, purchased: null, paidAccessProgram: 'INACTIVE', chargesEnabled: false, ...patch });
const founder = (patch = {}) => ({ organizationId: schoolContext.organizationId, schoolId: schoolContext.schoolId,
  pool: { capacity: 50, allocated: 12, remaining: 38, countingRule: 'FIRST_VERIFIED_SCHEDULE_PAYMENT', legacyFounderSalesCounted: false },
  organizationUsedFounderSpot: false,
  offers: [{ offerId: checkoutId(70), offerKind: 'FOUNDER_MONTHLY', billingInterval: 'MONTHLY', priceMinor: 19920, standardPriceMinor: 24900, available: true, reason: null },
    { offerId: checkoutId(71), offerKind: 'FOUNDER_ANNUAL', billingInterval: 'ANNUAL', priceMinor: 149400, standardPriceMinor: 209700, available: false, reason: 'FOUNDER_OFFER_LIMIT_REACHED' }],
  spotCountedAt: 'FIRST_VERIFIED_PAYMENT', spotReserved: false, checkoutAvailable: false, asOf: AT, ...patch });
afterEach(() => vi.restoreAllMocks());

describe('/staff/subscription HON OS standard and founder prices', () => {
  it('shows all four owner-approved prices, monthly and annual, when nothing is verified', () => {
    const rows = honOsPriceRows(null, null);
    expect(rows.map((r) => [r.kind, r.priceMinor, r.standardPriceMinor, r.source])).toEqual([
      ['REGULAR_MONTHLY', 24900, 24900, 'LAUNCH_REFERENCE'], ['REGULAR_ANNUAL', 209700, 209700, 'LAUNCH_REFERENCE'],
      ['FOUNDER_MONTHLY', 19920, 24900, 'LAUNCH_REFERENCE'], ['FOUNDER_ANNUAL', 149400, 209700, 'LAUNCH_REFERENCE']]);
    expect(rows.filter((r) => r.founder).every((r) => r.founderSpot?.state === 'UNVERIFIED')).toBe(true);
    expect(HON_OS_LAUNCH_PRICING_REFERENCE.standardAnnualPriceMinor).toBe(209700);
  });
  it('uses server prices and founder availability, and never shows a spot as available once used or sold out', () => {
    const rows = honOsPriceRows({ offerSetVersion: 1, offers: [{ offerKind: 'REGULAR_ANNUAL', priceMinor: 199900 }] } as never, founder() as never);
    expect(rows[1]).toMatchObject({ priceMinor: 199900, source: 'SERVER_OFFER' });
    expect(rows.filter((r) => r.kind !== 'REGULAR_ANNUAL').map((r) => r.source)).toEqual(['NOT_ON_SALE', 'NOT_ON_SALE', 'NOT_ON_SALE']);
    expect(honOsPriceRows({ offerSetVersion: null, offers: [] } as never, null).every((r) => r.source === 'LAUNCH_REFERENCE')).toBe(true);
    const closed = honOsPriceRows({ offerSetVersion: 3, offers: [{ offerKind: 'REGULAR_MONTHLY', priceMinor: 24900 }] } as never, null);
    expect(closed.map((r) => r.source)).toEqual(['SERVER_OFFER', 'NOT_ON_SALE', 'NOT_ON_SALE', 'NOT_ON_SALE']);
    expect(rows[2]!.founderSpot).toEqual({ state: 'AVAILABLE', reason: null });
    expect(rows[3]!.founderSpot).toEqual({ state: 'UNAVAILABLE', reason: 'FOUNDER_OFFER_LIMIT_REACHED' });
    const used = honOsPriceRows(null, founder({ offers: [], organizationUsedFounderSpot: true }) as never);
    expect(used.filter((r) => r.founder).map((r) => r.founderSpot?.reason)).toEqual(['FOUNDER_ALREADY_USED', 'FOUNDER_ALREADY_USED']);
    const sold = honOsPriceRows(null, founder({ offers: [], pool: { capacity: 50, allocated: 50, remaining: 0, countingRule: 'FIRST_VERIFIED_SCHEDULE_PAYMENT', legacyFounderSalesCounted: false } }) as never);
    expect(sold.filter((r) => r.founder).map((r) => r.founderSpot?.reason)).toEqual(['FOUNDER_SOLD_OUT', 'FOUNDER_SOLD_OUT']);
    expect(Object.keys(FOUNDER_REASON_COPY)).toHaveLength(5);
  });
  it('reads the exact school offers and founder availability with GET only, and tolerates one read failing', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => String(path).endsWith('founder-availability') ? ok(founder()) : ok(emptyOffers()));
    const abort = new AbortController(); const reads = await loadHonOsPrices(account, abort.signal);
    expect(reads.founder?.pool.remaining).toBe(38); expect(reads.offers?.offers).toEqual([]);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([`/api/v1/schools/${schoolContext.schoolId}/hon-os-offers`, `/api/v1/schools/${schoolContext.schoolId}/hon-os-founder-availability`]);
    for (const [, init] of fetch.mock.calls) expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: abort.signal });
    fetch.mockImplementation(async (path) => String(path).endsWith('founder-availability') ? new Response('{}', { status: 404 }) : ok(emptyOffers()));
    await expect(loadHonOsPrices(account)).resolves.toMatchObject({ founder: null });
  });
  it('refuses another school or organization, a reservation claim, or a checkout claim', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    for (const f of [founder({ schoolId: checkoutId(99) }), founder({ organizationId: checkoutId(99) })]) {
      fetch.mockImplementation(async (path) => String(path).endsWith('founder-availability') ? ok(f) : ok(emptyOffers()));
      await expect(loadHonOsPrices(account)).rejects.toMatchObject({ kind: 'INVALID' });
    }
    fetch.mockImplementation(async (path) => String(path).endsWith('founder-availability') ? ok(founder()) : ok(emptyOffers({ schoolId: checkoutId(99) })));
    await expect(loadHonOsPrices(account)).rejects.toMatchObject({ kind: 'INVALID' });
    for (const f of [founder({ spotReserved: true }), founder({ checkoutAvailable: true }), founder({ organizationUsedFounderSpot: true })]) {
      fetch.mockImplementation(async (path) => String(path).endsWith('founder-availability') ? ok(f) : ok(emptyOffers()));
      await expect(loadHonOsPrices(account)).resolves.toMatchObject({ founder: null });
    }
  });
  it('renders the four prices with founder terms and checkout off on the subscription page', () => {
    const html = renderToStaticMarkup(<HonOsPrices account={null}/>);
    for (const s of ['Standard monthly', 'Standard annual', 'Founder monthly', 'Founder annual', '$249', '$2,097', '$199.20', '$1,494', '/ year',
      '7-day grace period', 'Owner-approved launch price', 'Checkout for these prices is not open yet']) expect(html).toContain(s);
    expect(html).not.toContain('Server-returned offer');
    const [standard, , founderMonthly] = honOsPriceRows({ offerSetVersion: 2, offers: [] } as never, null);
    const closedFounder = renderToStaticMarkup(<HonOsPriceCard row={founderMonthly!}/>), closedStandard = renderToStaticMarkup(<HonOsPriceCard row={standard!}/>);
    expect(closedFounder).not.toContain('$199.20'); expect(closedStandard).not.toContain('$249'); expect(closedFounder).toContain('Not on sale now');
    const page = renderToStaticMarkup(<SchoolSubscription/>);
    expect(page).toContain('hon-os-prices-title'); expect(page).not.toContain('No new Essential or annual');
  });
  it('shows a lifetime offer HQ published, from the server only, and never a launch-reference lifetime price', () => {
    const lifetime = { offerCode: 'HON_OS_LIFETIME', offerKind: 'LIFETIME', billingInterval: 'ONE_TIME', founder: false, displayName: 'HON OS lifetime',
      priceMinor: 357600, refundWindowDays: 30, eligibility: 'ELIGIBLE' };
    const view = { offerSetVersion: 4, offers: [{ offerKind: 'REGULAR_MONTHLY', billingInterval: 'MONTHLY', priceMinor: 24900 }, lifetime,
      { ...lifetime, offerCode: 'HON_OS_FOUNDER_LIFETIME', offerKind: 'FOUNDER_LIFETIME', founder: true, displayName: 'Founder lifetime', refundWindowDays: null, eligibility: 'SOLD_OUT' }] };
    const rows = honOsOneTimeRows(view as never);
    expect(rows).toEqual([
      { offerCode: 'HON_OS_LIFETIME', displayName: 'HON OS lifetime', founder: false, priceMinor: 357600, refundWindowDays: 30, available: true, eligibility: 'ELIGIBLE' },
      { offerCode: 'HON_OS_FOUNDER_LIFETIME', displayName: 'Founder lifetime', founder: true, priceMinor: 357600, refundWindowDays: null, available: false, eligibility: 'SOLD_OUT' }]);
    expect(honOsOneTimeRows(null)).toEqual([]); expect(honOsOneTimeRows({ offerSetVersion: null, offers: [] } as never)).toEqual([]);
    expect(Object.keys(ONE_TIME_ELIGIBILITY_COPY)).toHaveLength(9);
    const html = renderToStaticMarkup(<ul><HonOsOneTimeCard row={rows[0]!}/><HonOsOneTimeCard row={rows[1]!}/></ul>);
    for (const s of ['HON OS lifetime', '$3,576', 'one-time', 'Paid once. It does not renew.', 'Refund window: 30 days.', 'Lifetime checkout is not open yet.', 'Sold out.', 'Server-returned offer']) expect(html).toContain(s);
    expect(html.match(/Refund window/g)).toHaveLength(1);
    expect(html).not.toMatch(/<form|<button|type="submit"/);
    expect(renderToStaticMarkup(<HonOsPrices account={null}/>)).not.toContain('data-kind="ONE_TIME"');
  });
});
