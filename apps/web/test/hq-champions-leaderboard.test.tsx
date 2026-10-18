import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateChampionsHqLeaderboard } from '@hon/contracts';
import { HqChampionsReadError, loadHqChampionsLeaderboard, type LeaderboardSelection } from '../src/components/hq-modern/champions-http';
import { HqChampionsLeaderboard, LeaderboardResults } from '../src/components/hq-modern/leaderboard';

function board() {
  return {
    period: 'ALL_TIME', month: null, totalRanked: 3, limit: 100, countsOnly: 'QUALIFIED', timeZone: 'UTC',
    standings: [
      { rank: 1, position: 1, schoolId: '00000000-0000-4000-8000-000000000001', schoolName: 'Zeta School', organizationId: '00000000-0000-4000-8000-000000000101', organizationName: 'Zeta Organization', qualifiedReferrals: 8, pendingReferrals: 2, reachedAt: '2026-08-01T00:00:00.000Z', displayMode: 'ANONYMOUS' },
      { rank: 1, position: 2, schoolId: '00000000-0000-4000-8000-000000000002', schoolName: 'Alpha School', organizationId: '00000000-0000-4000-8000-000000000102', organizationName: 'Alpha Organization', qualifiedReferrals: 8, pendingReferrals: 0, reachedAt: '2026-08-02T00:00:00.000Z', displayMode: 'SCHOOL_NAME' },
      { rank: 3, position: 3, schoolId: '00000000-0000-4000-8000-000000000003', schoolName: 'Cedar School', organizationId: '00000000-0000-4000-8000-000000000103', organizationName: 'Cedar Organization', qualifiedReferrals: 4, pendingReferrals: 1, reachedAt: '2026-08-03T00:00:00.000Z', displayMode: 'ANONYMOUS' },
    ],
    held: [{ schoolId: '00000000-0000-4000-8000-000000000004', schoolName: 'Private HQ Review School', reasonCode: 'FRAUD_REVIEW', qualifiedReferrals: 12, placedAt: '2026-08-04T00:00:00.000Z' }],
  };
}
const response = (data: unknown) => ({ ok: true, json: async () => ({ data }) }) as Response;
afterEach(() => vi.restoreAllMocks());

describe('HQ Champions Club read integration', () => {
  it('uses a fixed HQ-only authenticated no-store GET, rejects redirects and forwards cancellation', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(board()));
    const controller = new AbortController();
    await expect(loadHqChampionsLeaderboard({ period: 'ALL_TIME' }, controller.signal)).resolves.toEqual(board());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/api/v1/hq/champions/leaderboard?period=ALL_TIME', {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: controller.signal,
    });
  });
  it('serializes only the closed monthly selectors and binds the response to the selected period', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ ...board(), period: 'MONTH', month: '2026-08' }));
    await loadHqChampionsLeaderboard({ period: 'MONTH', month: '2026-08' });
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/v1/hq/champions/leaderboard?period=MONTH&month=2026-08');
    fetch.mockResolvedValue(response(board()));
    await expect(loadHqChampionsLeaderboard({ period: 'MONTH', month: '2026-08' })).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    fetch.mockResolvedValue(response({ ...board(), period: 'MONTH', month: '2026-09' }));
    await expect(loadHqChampionsLeaderboard({ period: 'MONTH', month: '2026-08' })).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
  });
  it('refuses scope, identity, authority and invalid filter injection before any transport', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    for (const input of [
      { period: 'ALL_TIME', schoolId: 'private' }, { period: 'ALL_TIME', role: 'OWNER' }, { period: 'ALL_TIME', month: '2026-08' },
      { period: 'MONTH' }, { period: 'MONTH', month: '2026-08&schoolId=private' }, { period: 'CONTEST' },
    ]) await expect(loadHqChampionsLeaderboard(input as LeaderboardSelection)).rejects.toMatchObject({ kind: 'INVALID_FILTER' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fails closed on school-safe responses, raw/private fields, ordering drift and malformed envelopes', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const row = board().standings[0]!;
    for (const value of [
      { ...board(), secret: 'private' }, { ...board(), standings: [{ ...row, email: 'private@example.test' }] },
      { ...board(), standings: [...board().standings].reverse() }, { ...board(), standings: [{ ...row, qualifiedReferrals: 0 }] },
      { ...board(), standings: [{ rank: 1, displayName: null, anonymous: true, qualifiedReferrals: 8, isYou: false }], limit: 25 },
      { ...board(), countsOnly: 'PENDING' }, { ...board(), held: [{ ...board().held[0], ownerEmail: 'private@example.test' }] },
    ]) {
      fetch.mockResolvedValue(response(value));
      await expect(loadHqChampionsLeaderboard({ period: 'ALL_TIME' })).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    }
    for (const value of [{ data: board(), permission: 'OWNER' }, { data: { leaderboard: board() } }, null]) {
      fetch.mockResolvedValue({ ok: true, json: async () => value } as Response);
      await expect(loadHqChampionsLeaderboard({ period: 'ALL_TIME' })).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    }
  });
  it('never reads denial bodies or falls back from HQ to school access', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    for (const [status, kind] of [[401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [400, 'INVALID_FILTER'], [404, 'UNAVAILABLE'], [503, 'UNAVAILABLE']] as const) {
      const json = vi.fn(async () => ({ data: board() }));
      fetch.mockResolvedValue({ ok: false, status, json } as unknown as Response);
      await expect(loadHqChampionsLeaderboard({ period: 'ALL_TIME' })).rejects.toMatchObject({ kind });
      expect(json).not.toHaveBeenCalled();
    }
    expect(fetch.mock.calls.every(([path]) => String(path).startsWith('/api/v1/hq/champions/leaderboard?'))).toBe(true);
  });
  it('maps network and unreadable response failures without echoing server details', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private provider detail'));
    await expect(loadHqChampionsLeaderboard({ period: 'ALL_TIME' })).rejects.toEqual(new HqChampionsReadError('UNAVAILABLE'));
    fetch.mockResolvedValue({ ok: true, json: async () => { throw Error('private response detail'); } } as unknown as Response);
    await expect(loadHqChampionsLeaderboard({ period: 'ALL_TIME' })).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
  });
  it('preserves official ties and positions, renders held schools separately, and escapes names', () => {
    const data = validateChampionsHqLeaderboard(board());
    const html = renderToStaticMarkup(<LeaderboardResults board={data}/>);
    expect(html.indexOf('Zeta School')).toBeLessThan(html.indexOf('Alpha School'));
    expect(html).toContain('Ties share rank');
    expect(html).toContain('Position'); expect(html).toContain('Anonymous in school standings');
    expect(html.indexOf('Private HQ Review School')).toBeGreaterThan(html.indexOf('</table>'));
    expect(html).toContain('Confidential HQ reviews'); expect(html).toContain('not a finding of fraud');
    data.standings[0]!.schoolName = '<script>alert(1)</script>';
    expect(renderToStaticMarkup(<LeaderboardResults board={data}/>)).toContain('&lt;script&gt;');
    expect(renderToStaticMarkup(<LeaderboardResults board={data}/>)).not.toContain('<script>');
  });
  it('distinguishes an authorized empty result from unavailable data', () => {
    const data = validateChampionsHqLeaderboard({ ...board(), standings: [], totalRanked: 0, held: [] });
    const html = renderToStaticMarkup(<LeaderboardResults board={data}/>);
    expect(html).toContain('No ranked schools for this period');
    expect(html).not.toContain('Zeta School');
  });
  it('server-renders no operational rows or hold information and keeps the route no-index', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const html = renderToStaticMarkup(<HqChampionsLeaderboard/>);
    expect(fetch).not.toHaveBeenCalled(); expect(html).toContain('Loading authorized standings');
    expect(html).not.toMatch(/Zeta School|Private HQ Review School|FRAUD_REVIEW/);
    const route = readFileSync('src/app/hq/growth/leaderboard/page.tsx', 'utf8');
    expect(route).toContain('HqChampionsLeaderboard'); expect(route).toContain('force-dynamic'); expect(route).toContain('index: false');
  });
});
