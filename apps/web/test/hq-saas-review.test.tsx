import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateSaasCatalogView, validateSaasSubscriptionList, validateSaasCreditProgramView, validateSaasOrganizationSubscription, validateSaasPaymentStanding, validateSaasOrganizationCredits } from '@hon/contracts';
import { saasId, saasOverviewFixture, saasAccountFixture } from '../scripts/fixtures/hq-saas-review.mjs';
import { loadHqSaasReview, loadHqSaasAccount } from '../src/components/hq-modern/saas-review-http';
import { HqSaasReview, SaasInventory, SaasCatalogAndCosts, SaasAccountResults, formatSaasMoney } from '../src/components/hq-modern/saas-review';

const ok = (data: unknown) => ({ ok: true, json: async () => ({ data }) } as Response);
function mocks(status: Parameters<typeof saasOverviewFixture>[0] = {}) {
  const root = saasOverviewFixture(status), account = saasAccountFixture();
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => {
    const resource = String(path).split('/').at(-1)!;
    return ok(String(path).includes('/organizations/') ? resource === 'subscription' ? account.subscription : resource === 'payment-standing' ? account.standing : account.credits
      : resource === 'catalog' ? root.catalog : resource.startsWith('subscriptions') ? root.subscriptions : root.credits);
  });
}
afterEach(() => vi.restoreAllMocks());

describe('HON HQ subscription account review', () => {
  it('uses canonical closed projections for every synthetic verification fixture', () => {
    const o = saasOverviewFixture(); expect(validateSaasCatalogView(o.catalog)).toEqual(o.catalog); expect(validateSaasSubscriptionList(o.subscriptions)).toEqual(o.subscriptions); expect(validateSaasCreditProgramView(o.credits)).toEqual(o.credits);
    for (const id of [1, 2, 3, 4]) for (const empty of [false, true]) {
      const a = saasAccountFixture({ organizationId: saasId(id), empty });
      expect(validateSaasOrganizationSubscription(a.subscription)).toEqual(a.subscription); expect(validateSaasPaymentStanding(a.standing)).toEqual(a.standing); expect(validateSaasOrganizationCredits(a.credits)).toEqual(a.credits);
    }
  });
  it('uses six fixed authenticated no-store HQ GETs and forwards cancellation, never school/family or commands', async () => {
    const fetch = mocks(); const controller = new AbortController();
    await loadHqSaasReview(null, controller.signal); await loadHqSaasAccount(saasId(1), controller.signal);
    expect(fetch).toHaveBeenCalledTimes(6);
    for (const suffix of ['catalog', 'subscriptions', 'credits', `organizations/${saasId(1)}/subscription`, `organizations/${saasId(1)}/payment-standing`, `organizations/${saasId(1)}/credits`]) expect(fetch).toHaveBeenCalledWith(`/api/v1/hq/saas/${suffix}`, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: controller.signal,
    });
  });
  it('refuses invalid selectors without network and binds status-window responses', async () => {
    const fetch = mocks();
    for (const id of ['', '../credits', `${saasId(1)}?role=OWNER`, 'organization-name']) await expect(loadHqSaasAccount(id)).rejects.toMatchObject({ kind: 'INVALID_SELECTION' });
    await expect(loadHqSaasReview('IN_SERVICE&schoolId=x' as never)).rejects.toMatchObject({ kind: 'INVALID_SELECTION' }); expect(fetch).not.toHaveBeenCalled();
    await expect(loadHqSaasReview('SUSPENDED')).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    fetch.mockRestore();
    for (const status of [null, 'IN_SERVICE', 'PENDING_ACTIVATION', 'SUSPENDED', 'VOIDED'] as const) {
      const filtered = mocks({ status }); await expect(loadHqSaasReview(status)).resolves.toMatchObject({ subscriptions: saasOverviewFixture({ status }).subscriptions });
      expect(filtered).toHaveBeenCalledWith(`/api/v1/hq/saas/subscriptions${status ? `?status=${status}` : ''}`, expect.objectContaining({ method: 'GET' })); filtered.mockRestore();
    }
  });
  it('fails closed on each independent service denial without reading private error bodies', async () => {
    for (const [resource, account] of [['catalog', false], ['subscriptions', false], ['credits', false], ['subscription', true], ['payment-standing', true], ['credits', true]] as const) for (const [status, kind] of [[401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [404, 'UNAVAILABLE'], [503, 'UNAVAILABLE']] as const) {
      const fetch = mocks(); const fallback = fetch.getMockImplementation()!; const json = vi.fn(async () => ({ privateEmail: 'secret@example.test' }));
      fetch.mockImplementation(async (path, init) => String(path).split('/').at(-1) === resource ? { ok: false, status, json } as unknown as Response : fallback(path, init));
      await expect(account ? loadHqSaasAccount(saasId(1)) : loadHqSaasReview(null)).rejects.toMatchObject({ kind });
      expect(json).not.toHaveBeenCalled(); fetch.mockRestore();
    }
  });
  it('rejects wrong organization/current subscription and nested cross-organization records', async () => {
    const fetch = mocks(); const a = saasAccountFixture();
    for (const patch of [
      { subscription: { ...a.subscription, organizationId: saasId(2) } }, { standing: { ...a.standing, organizationId: saasId(2) } },
      { credits: { ...a.credits, subscriptionId: saasId(999) } }, { subscription: { ...a.subscription, current: { ...a.subscription.current!, organizationId: saasId(2) } } },
      { credits: { ...a.credits, allowances: [{ ...a.credits.allowances[0]!, organizationId: saasId(2) }] } },
      { credits: { ...a.credits, reservations: [{ ...a.credits.reservations[0]!, organizationId: saasId(2) }] } },
    ]) {
      const changed = { ...a, ...patch };
      fetch.mockImplementation(async (path) => ok(String(path).endsWith('/subscription') ? changed.subscription : String(path).endsWith('/payment-standing') ? changed.standing : changed.credits));
      await expect(loadHqSaasAccount(saasId(1))).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    }
  });
  it('rejects activation drift, invented verified payments, private fields and malformed envelopes', async () => {
    const fetch = mocks(), o = saasOverviewFixture();
    for (const changed of [{ ...o.catalog, chargesEnabled: true }, { ...o.catalog, paymentProvider: 'STRIPE' }, { ...o.catalog, ownerEmail: 'secret' }]) {
      fetch.mockImplementation(async (path) => ok(String(path).endsWith('/catalog') ? changed : String(path).endsWith('/credits') ? o.credits : o.subscriptions));
      await expect(loadHqSaasReview(null)).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    }
    for (const envelope of [null, [], { data: o.catalog, authority: 'OWNER' }]) { fetch.mockResolvedValue({ ok: true, json: async () => envelope } as Response); await expect(loadHqSaasReview(null)).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' }); }
    const a = saasAccountFixture();
    for (const standing of [{ ...a.standing, evidence: { ...a.standing.evidence, providerVerified: 1 } }, { ...a.standing, verified: { ...a.standing.verified, firstPaidAt: '2026-10-01T00:00:00.000Z' } }]) {
      fetch.mockImplementation(async (path) => ok(String(path).endsWith('/subscription') ? a.subscription : String(path).endsWith('/payment-standing') ? standing : a.credits));
      await expect(loadHqSaasAccount(saasId(1))).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    }
  });
  it('keeps network/JSON failures private and propagates abort rejection', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('private network'));
    await expect(loadHqSaasReview(null)).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
    fetch.mockResolvedValue({ ok: true, json: async () => { throw Error('private body'); } } as unknown as Response);
    await expect(loadHqSaasAccount(saasId(1))).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    const controller = new AbortController(); controller.abort(); const error = Error('abort'); fetch.mockRejectedValue(error);
    await expect(loadHqSaasAccount(saasId(1), controller.signal)).rejects.toBe(error);
  });
  it('preserves exact minor/micro units and renders authoritative inventory rather than list-derived totals', () => {
    expect(formatSaasMoney(Number.MAX_SAFE_INTEGER)).toBe('USD 90,071,992,547,409.91'); expect(formatSaasMoney(1, 6)).toBe('USD 0.000001'); expect(formatSaasMoney(1234567, 6)).toBe('USD 1.234567');
    const o = saasOverviewFixture(); const html = renderToStaticMarkup(<><SaasInventory catalog={o.catalog}/><SaasCatalogAndCosts data={o}/></>);
    expect(html).toContain('43'); expect(html).toContain('26'); expect(html).toContain('USD 50.000000'); expect(html).toContain('HQ owner-verified provider billing'); expect(html).toContain('Legacy only');
    const empty = renderToStaticMarkup(<><SaasInventory catalog={saasOverviewFixture({ empty: true }).catalog}/><SaasCatalogAndCosts data={saasOverviewFixture({ empty: true })}/></>);
    expect(empty).toContain('Unavailable / undecided'); expect(empty).toContain('No verified provider-cost evidence'); expect(empty).toContain('No published catalog');
  });
  it('renders real account balances, attestation distinctions and unknown costs without issuing benefits', () => {
    const html = renderToStaticMarkup(<SaasAccountResults data={saasAccountFixture()}/>);
    for (const text of ['3,800', '5,000', 'OUTCOME UNKNOWN', 'Provider usage cost not recorded', 'USD 1.234567', 'Recorded standing · includes HQ attestations', 'Provider-verified standing', 'not processor confirmation', 'not configured', 'newest']) {
      if (text === 'newest') expect(html).toMatch(/Newest 50/); else expect(html).toContain(text);
    }
    expect(html).not.toMatch(/<button|<form/);
    const mismatch = renderToStaticMarkup(<SaasAccountResults data={saasAccountFixture({ mismatch: true })}/>); expect(mismatch).toContain('MISMATCH');
  });
  it('handles no subscription/entitlement/usage and escapes authorized names', () => {
    const a = saasAccountFixture({ empty: true }); a.subscription.organizationName = '<script>name</script>';
    const html = renderToStaticMarkup(<SaasAccountResults data={a}/>);
    for (const text of ['No current subscription', 'No entitlement record', 'No allowance records', 'No premium reservations', '&lt;script&gt;']) expect(html).toContain(text);
    expect(html).not.toContain('<script>');
  });
  it('shows no facts before authorization and preserves the existing dynamic HQ route', () => {
    const fetch = vi.spyOn(globalThis, 'fetch'); const html = renderToStaticMarkup(<HqSaasReview/>);
    expect(fetch).not.toHaveBeenCalled(); expect(html).toContain('Loading authorized subscription records'); expect(html).not.toContain('data-saas-account'); expect(html).not.toContain('data-saas-inventory');
    const route = readFileSync('src/app/hq/revenue/page.tsx', 'utf8'); expect(route).toContain('HqSaasReview'); expect(route).toContain('force-dynamic'); expect(route).toContain('index: false');
  });
});
