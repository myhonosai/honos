import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateChampionsHqSchoolStatistics, validateChampionsRewardLedger, validateChampionsRewardProgram } from '@hon/contracts';
import { fixtureId, rewardLedgerFixture, rewardProgramFixture, schoolReferralFixture } from '../scripts/fixtures/hq-school-rewards.mjs';
import { loadHqSchoolReferrals, loadHqRewardLedger } from '../src/components/hq-modern/champions-school-rewards-http';
import { SchoolReferralResults, HqSchoolReferrals } from '../src/components/hq-modern/champions-school-referrals';
import { RewardLedgerResults, HqChampionsRewards } from '../src/components/hq-modern/champions-rewards';
import { DetailState } from '../src/components/hq-modern/champions-detail-shared';

const program = () => validateChampionsRewardProgram(rewardProgramFixture());
const school = () => validateChampionsHqSchoolStatistics(schoolReferralFixture());
const ledger = () => validateChampionsRewardLedger(rewardLedgerFixture());
const ok = (data: unknown) => ({ ok: true, json: async () => ({ data }) } as Response);
function reads(status: Parameters<typeof rewardLedgerFixture>[0] = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => String(path).includes('/statistics') ? ok(school())
    : String(path).includes('/ledger') ? ok(validateChampionsRewardLedger(rewardLedgerFixture(status))) : ok(program()));
}
afterEach(() => vi.restoreAllMocks());

describe('HQ school referrals and reward accounting', () => {
  it('binds canonical school UUIDs and uses only independently authorized fixed same-origin reads', async () => {
    const fetch = reads(); const controller = new AbortController();
    await expect(loadHqSchoolReferrals(fixtureId(1), controller.signal)).resolves.toEqual({ statistics: school(), program: program() });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const path of [`/api/v1/hq/champions/schools/${fixtureId(1)}/statistics`, '/api/v1/hq/champions/rewards/program']) expect(fetch).toHaveBeenCalledWith(path, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: controller.signal,
    });
  });
  it('rejects arbitrary selectors before network; no staff fallback, actor/scope or URL authority', async () => {
    const fetch = reads();
    for (const id of ['', '../rewards/ledger', `${fixtureId(1)}?role=OWNER`, 'school-name']) await expect(loadHqSchoolReferrals(id)).rejects.toMatchObject({ kind: 'INVALID_SELECTION' });
    await expect(loadHqRewardLedger('APPROVED&schoolId=private' as never)).rejects.toMatchObject({ kind: 'INVALID_SELECTION' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses server status filtering and preserves unfiltered authoritative liability groups', async () => {
    for (const status of [null, 'ACCRUED', 'APPROVED', 'REVERSAL_REVIEW', 'VOIDED'] as const) {
      const fetch = reads({ status }); const snapshot = await loadHqRewardLedger(status);
      expect(fetch).toHaveBeenCalledWith(`/api/v1/hq/champions/rewards/ledger${status ? `?status=${status}` : ''}`, expect.objectContaining({ method: 'GET', cache: 'no-store' }));
      expect(snapshot.ledger.liabilities).toEqual(ledger().liabilities);
      expect(snapshot.ledger.entries.every((e) => status === null || e.status === status)).toBe(true); fetch.mockRestore();
    }
  });
  it('fails closed if either read is denied and never reads error-body identities or reasons', async () => {
    for (const resource of ['/statistics', '/ledger', '/program']) for (const [status, kind] of [[401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [404, 'UNAVAILABLE'], [503, 'UNAVAILABLE']] as const) {
      const fetch = reads(); const json = vi.fn(async () => ({ privateEmail: 'secret@example.test' }));
      fetch.mockImplementation(async (path) => String(path).endsWith(resource) ? { ok: false, status, json } as unknown as Response
        : String(path).endsWith('/program') ? ok(program()) : String(path).endsWith('/ledger') ? ok(ledger()) : ok(school()));
      await expect(resource === '/ledger' ? loadHqRewardLedger(null) : loadHqSchoolReferrals(fixtureId(1))).rejects.toMatchObject({ kind });
      expect(json).not.toHaveBeenCalled(); fetch.mockRestore();
    }
  });
  it('rejects wrong-school records and a changed or unpublished milestone policy', async () => {
    const fetch = reads();
    for (const changed of [{ ...school(), schoolId: fixtureId(2) }, { ...school(), milestones: { ...school().milestones, program: { status: 'PUBLISHED', policyVersion: 3 } } }]) {
      fetch.mockImplementation(async (path) => String(path).endsWith('/statistics') ? ok(changed) : ok(program()));
      await expect(loadHqSchoolReferrals(fixtureId(1))).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    }
    fetch.mockImplementation(async (path) => String(path).endsWith('/statistics') ? ok(school()) : ok(rewardProgramFixture({ empty: true })));
    await expect(loadHqSchoolReferrals(fixtureId(1))).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
  });
  it('rejects private fields, malformed envelopes, invalid counts, invented fulfillment and financial activation', async () => {
    const fetch = reads();
    for (const data of [{ ...ledger(), privateSchool: 'secret' }, { ...ledger(), financialActivation: 'ENABLED' },
      { ...ledger(), entries: [{ ...ledger().entries[0], status: 'FULFILLED' }] }, { ...ledger(), entries: [{ ...ledger().entries[0], paidAt: 'today' }] }]) {
      fetch.mockImplementation(async (path) => String(path).includes('/ledger') ? ok(data) : ok(program()));
      await expect(loadHqRewardLedger(null)).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    }
    for (const data of [{ ...school(), privateOwner: 'secret' }, { ...school(), referrals: { ...school().referrals, qualified: -1 } }]) {
      fetch.mockImplementation(async (path) => String(path).includes('/statistics') ? ok(data) : ok(program()));
      await expect(loadHqSchoolReferrals(fixtureId(1))).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    }
    for (const envelope of [null, [], { data: ledger(), role: 'OWNER' }]) {
      fetch.mockResolvedValue({ ok: true, json: async () => envelope } as Response);
      await expect(loadHqRewardLedger(null)).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    }
  });
  it('rejects records outside the requested server status window without filtering them into apparent validity', async () => {
    reads(); await expect(loadHqRewardLedger('VOIDED')).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
  });
  it('keeps network/unreadable failures private and forwards abort cancellation', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private network'));
    await expect(loadHqRewardLedger(null)).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
    fetch.mockResolvedValue({ ok: true, json: async () => { throw new Error('private body'); } } as unknown as Response);
    await expect(loadHqSchoolReferrals(fixtureId(1))).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    const controller = new AbortController(); controller.abort(); const error = new Error('abort'); fetch.mockRejectedValue(error);
    await expect(loadHqRewardLedger(null, controller.signal)).rejects.toBe(error);
  });
  it('renders backend ranks, reached/next progress and limits without inferring later awards or school reward history', () => {
    const html = renderToStaticMarkup(<SchoolReferralResults data={{ statistics: school(), program: program() }}/>);
    expect(html).toContain('#1'); expect(html).toContain('Reached · backend reported'); expect(html).toContain('2 remaining · backend reported');
    expect(html).toContain('Later threshold · remaining not provided'); expect(html).toContain('Newest 50');
    expect(html).toContain('Complete school reward history unavailable'); expect(html).toContain('not an approved or fulfilled reward');
    const unknown = school(); unknown.milestones.reached = []; unknown.milestones.nextMilestone = null;
    const absent = renderToStaticMarkup(<SchoolReferralResults data={{ statistics: unknown, program: program() }}/>);
    expect(absent).not.toContain('Reached · backend reported'); expect(absent).not.toContain('2 remaining'); expect(absent).toContain('None reported');
  });
  it('renders aggregates beyond the recent list and all exact liability statuses, never completed benefits', () => {
    const html = renderToStaticMarkup(<RewardLedgerResults data={{ ledger: ledger(), program: program() }}/>);
    for (const text of ['450', 'USD 45,000.00', 'USD 100.00', 'Approved for future fulfillment', 'Reversal review required', 'Voided reward record', 'Lifetime membership', 'Newest 200', 'across all schools', 'not an applied credit or payment']) expect(html).toContain(text);
    expect(html).not.toMatch(/<button|<form/);
    const entry = ledger(); entry.entries[0]!.policyVersion = 1;
    expect(renderToStaticMarkup(<RewardLedgerResults data={{ ledger: entry, program: program() }}/>)).toContain('policy v1');
  });
  it('handles empty/unpublished results and escapes authorized user-controlled text', () => {
    const empty = renderToStaticMarkup(<RewardLedgerResults data={{ ledger: rewardLedgerFixture({ empty: true }), program: rewardProgramFixture({ empty: true }) }}/>);
    expect(empty).toContain('No non-voided liability groups'); expect(empty).toContain('No recent reward records'); expect(empty).toContain('No published reward policy');
    const s = schoolReferralFixture({ empty: true }); s.schoolName = '<script>school</script>';
    const html = renderToStaticMarkup(<SchoolReferralResults data={{ statistics: s, program: rewardProgramFixture({ empty: true }) }}/>);
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).toContain('No referral history events'); expect(html).toContain('Not ranked');
  });
  it('renders no facts or network reads before effects, exposes safe denied states and protects dynamic routes', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const html = renderToStaticMarkup(<><HqSchoolReferrals/><HqChampionsRewards/><DetailState state={{ key: 'x', kind: 'failed', failure: 'FORBIDDEN' }}/></>);
    expect(fetch).not.toHaveBeenCalled(); expect(html).not.toContain('data-school-records'); expect(html).not.toContain('USD 100.00'); expect(html).toContain('HQ access denied');
    for (const path of ['src/app/hq/growth/champions-club/schools/page.tsx', 'src/app/hq/growth/rewards/page.tsx']) {
      const source = readFileSync(path, 'utf8'); expect(source).toContain('force-dynamic'); expect(source).toContain('index: false');
    }
  });
});
