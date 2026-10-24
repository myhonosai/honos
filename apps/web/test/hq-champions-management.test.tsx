import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateChampionsOverview, validateChampionsProgram } from '@hon/contracts';
import { loadHqChampionsManagement } from '../src/components/hq-modern/champions-management-http';
import { ChampionsManagementResults, HqChampionsManagement, formatChampionsLiability } from '../src/components/hq-modern/champions-management';

function data() {
  return {
    overview: validateChampionsOverview({
      program: { status: 'PUBLISHED', policyVersion: 7, paymentVerificationSource: 'HQ_OWNER_ATTESTATION' },
      rewardProgram: { status: 'POLICY_UNDECIDED', policyVersion: null, clawbackRule: null },
      referralCodes: { active: 200, schoolsWithCode: 190 }, attributions: { qualified: 1200, pending: 400, rejected: 300, refunded: 200, reversed: 100 },
      rankedSchools: 150, leaderboardHolds: 9,
      rewardLiabilities: { entries: 250, creditMinor: 199999, freeMonths: 18, prizes: 2, lifetimeMemberships: 1, inReview: 8, approved: 10 },
      contests: { draft: 0, scheduled: 0, active: 0, paused: 0, ended: 0, pendingWinnerApproval: 0, completed: 0, cancelled: 0, startDue: 0, endDue: 0 },
      contestLiabilities: { pendingWinnerCostMinor: 123456, approvedWinnerCostMinor: 10000 }, currency: 'USD', financialActivation: 'DISABLED', automaticTransitions: 'NOT_CONFIGURED',
    }),
    program: validateChampionsProgram({ published: {
      policyId: '00000000-0000-4000-8000-000000000201', policyVersion: 7, status: 'PUBLISHED',
      attributionWindowDays: 90, refundWindowDays: 30, minimumPaidDays: 60, minimumPaidInvoices: 2,
      paymentVerificationSource: 'HQ_OWNER_ATTESTATION', welcomeCreditMinor: 10000, termsReference: '<script>untrusted terms</script>',
      currency: 'USD', financialRewards: 'DISABLED', createdAt: '2026-08-01T00:00:00.000Z', publishedAt: '2026-08-02T00:00:00.000Z',
    }, drafts: [], financialRewards: 'DISABLED' }),
  };
}
function mockReads() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => ({ ok: true, json: async () => ({ data: String(path).endsWith('/overview') ? data().overview : data().program }) } as Response));
}
afterEach(() => vi.restoreAllMocks());

describe('HQ Champions management overview', () => {
  it('uses only two fixed authenticated no-store GETs, no selectors/body/authority and forwards cancellation', async () => {
    const fetch = mockReads(); const controller = new AbortController();
    await expect(loadHqChampionsManagement(controller.signal)).resolves.toEqual(data());
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const path of ['/api/v1/hq/champions/overview', '/api/v1/hq/champions/program']) expect(fetch).toHaveBeenCalledWith(path, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: controller.signal,
    });
  });
  it('does not read or expose errors and rejects the whole overview if either read is denied', async () => {
    for (const resource of ['overview', 'program']) for (const [status, kind] of [[401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [404, 'UNAVAILABLE'], [503, 'UNAVAILABLE']] as const) {
      const json = vi.fn(async () => ({ privateEmail: 'private@example.test' }));
      const fetch = mockReads();
      fetch.mockImplementation(async (path) => String(path).endsWith(`/${resource}`) ? { ok: false, status, json } as unknown as Response
        : { ok: true, json: async () => ({ data: resource === 'overview' ? data().program : data().overview }) } as Response);
      await expect(loadHqChampionsManagement()).rejects.toMatchObject({ kind });
      expect(json).not.toHaveBeenCalled(); fetch.mockRestore();
    }
  });
  it('rejects private fields, noncanonical counts, financial activation, scheduling and malformed envelopes', async () => {
    const fetch = mockReads();
    for (const patch of [
      { privateSchools: ['secret'] }, { financialActivation: 'ENABLED' }, { automaticTransitions: 'CRON' },
      { attributions: { ...data().overview.attributions, qualified: -1 } },
      { rewardLiabilities: { ...data().overview.rewardLiabilities, paid: 10 } },
    ]) {
      fetch.mockImplementation(async (path) => ({ ok: true, json: async () => ({ data: String(path).endsWith('/overview') ? { ...data().overview, ...patch } : data().program }) } as Response));
      await expect(loadHqChampionsManagement()).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    }
    for (const envelope of [null, [], { data: data().overview, role: 'OWNER' }, { data: { overview: data().overview } }]) {
      fetch.mockResolvedValue({ ok: true, json: async () => envelope } as Response);
      await expect(loadHqChampionsManagement()).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    }
  });
  it('refuses configuration changed between the separate reads', async () => {
    const fetch = mockReads();
    for (const program of [{ ...data().program, published: null }, { ...data().program, published: { ...data().program.published!, policyVersion: 8 } },
      { ...data().program, published: { ...data().program.published!, paymentVerificationSource: 'HON_BILLING' } }]) {
      fetch.mockImplementation(async (path) => ({ ok: true, json: async () => ({ data: String(path).endsWith('/overview') ? data().overview : program }) } as Response));
      await expect(loadHqChampionsManagement()).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    }
  });
  it('maps unreadable/network failures to safe states and preserves abort rejection', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private network details'));
    await expect(loadHqChampionsManagement()).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
    fetch.mockResolvedValue({ ok: true, json: async () => { throw new Error('private body'); } } as unknown as Response);
    await expect(loadHqChampionsManagement()).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    const controller = new AbortController(); controller.abort(); const error = new Error('aborted');
    fetch.mockRejectedValue(error); await expect(loadHqChampionsManagement(controller.signal)).rejects.toBe(error);
  });
  it('renders full server aggregates beyond list limits, exact minor units and unfulfilled reward distinctions', () => {
    const html = renderToStaticMarkup(<ChampionsManagementResults data={data()}/>);
    expect(html).toContain('2,200'); expect(html).toContain('1,200'); expect(html).toContain('USD 1,999.99'); expect(html).toContain('250');
    expect(html).toContain('not AI credits'); expect(html).toContain('Approved for future fulfillment'); expect(html).toContain('Reversal review required');
    expect(html).toContain('not paid'); expect(html).toContain('Policy undecided');
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).not.toMatch(/<button|<form/);
    expect(formatChampionsLiability(Number.MAX_SAFE_INTEGER)).toBe('USD 90,071,992,547,409.91');
    expect(formatChampionsLiability(0)).toBe('USD 0.00');
  });
  it('preserves exact totals beyond safe Number summation without deriving awards', () => {
    const snapshot = data();
    snapshot.overview.attributions = { qualified: Number.MAX_SAFE_INTEGER, pending: Number.MAX_SAFE_INTEGER, rejected: 0, refunded: 0, reversed: 0 };
    expect(renderToStaticMarkup(<ChampionsManagementResults data={snapshot}/>)).toContain('18,014,398,509,481,982');
  });
  it('distinguishes an authorized zero aggregate and unpublished terms from missing services', () => {
    const snapshot = data(); snapshot.program.published = null;
    snapshot.overview.program = { status: 'POLICY_UNDECIDED', policyVersion: null, paymentVerificationSource: null };
    snapshot.overview.attributions = { qualified: 0, pending: 0, rejected: 0, refunded: 0, reversed: 0 };
    snapshot.overview.rewardLiabilities.entries = 0;
    const html = renderToStaticMarkup(<ChampionsManagementResults data={snapshot}/>);
    expect(html).toContain('No referrals recorded'); expect(html).toContain('No published qualification policy');
    expect(html).not.toContain('Configured welcome credit'); expect(html).toContain('No non-voided reward liabilities');
  });
  it('renders no operational facts before authorization; both existing routes remain dynamic and no-index', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const html = renderToStaticMarkup(<HqChampionsManagement pagePath="/hq/growth"/>);
    expect(fetch).not.toHaveBeenCalled(); expect(html).toContain('Loading authorized Champions Club'); expect(html).not.toContain('data-champions-total');
    for (const path of ['src/app/hq/growth/page.tsx', 'src/app/hq/growth/champions-club/page.tsx']) {
      const route = readFileSync(path, 'utf8'); expect(route).toContain('HqChampionsManagement'); expect(route).toContain('force-dynamic'); expect(route).toContain('index: false');
    }
  });
});
