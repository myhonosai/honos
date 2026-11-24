import React from 'react';
import { Share } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ParentApp } from '../src/ParentApp';
import { createParentApi, type ParentApi } from '../src/api/client';
import { createSampleApi } from '../src/sample/sample-api';
import { verifyParentReferrals } from '@hon/contracts/family-referrals';
import { shareText } from '../src/more/ReferArea';
import { NOW } from './fixtures';

// 0604 More > Refer a friend: the family's link, counts and the school's reward; never a friend's name.
const signedOut = { token: async () => null, clear: async () => {}, subscribe: () => () => {} };
const now = () => new Date(NOW);
let n = 0;
const newKey = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const liveApi = createParentApi({ baseUrl: 'https://api.example.test', getToken: async () => null, fetchImpl: jest.fn() });
const URL = 'https://app.hon.example/refer/0123456789abcdef';
const view = (patch: Record<string, unknown> = {}) => verifyParentReferrals({ schoolName: 'Dojo', on: true, referrerReward: 'One free month', friendOffer: 'Free trial week',
  rules: 'After the first paid month.', shareMessage: 'Come train!', canShare: true, shareUrl: null, counts: { referred: 2, joined: 1, rewarded: 1 },
  referrals: [{ referredAt: '2026-11-12T17:00:00Z', status: 'JOINED', reward: 'GIVEN' }, { referredAt: '2026-11-01T17:00:00Z', status: 'INTERESTED', reward: 'PENDING' }], ...patch });

async function openRefer(api: ParentApi) {
  await render(<ParentApp api={liveApi} session={signedOut} now={now} newKey={newKey} sampleApi={() => api} />);
  await fireEvent.press(await screen.findByRole('button', { name: 'Try with a sample family' }));
  await screen.findByRole('button', { name: 'Open Mia Sample journey' });
  await fireEvent.press(screen.getByRole('tab', { name: 'More' }));
  await fireEvent.press(await screen.findByRole('button', { name: 'Open Refer a friend' }));
}
let shareSpy: jest.SpyInstance;
beforeEach(() => { shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never); });
afterEach(() => shareSpy.mockRestore());

describe('refer a friend', () => {
  it('shows the reward, counts and referrals, then gets the link once and opens the share sheet', async () => {
    const referralLink = jest.fn(async () => ({ ok: true as const, data: { shareUrl: URL }, replayed: false }));
    const api = { ...createSampleApi(now), sampleMode: false, referrals: async () => ({ ok: true as const, data: view() }), referralLink } as ParentApi;
    await openRefer(api);
    expect(await screen.findByText('One free month')).toBeTruthy();
    expect(screen.getByText('Your friend gets: Free trial week')).toBeTruthy();
    expect(screen.getByText(/Nothing is paid or charged in the app/)).toBeTruthy();
    expect(screen.getByText('Reward given')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Share my referral link' }));
    expect(referralLink).toHaveBeenCalledTimes(1);
    expect(shareSpy).toHaveBeenCalledWith({ message: `Come train!\n${URL}` });
    await fireEvent.press(screen.getByRole('button', { name: 'Share my referral link' }));
    expect(referralLink).toHaveBeenCalledTimes(1);
    expect(shareSpy).toHaveBeenCalledTimes(2);
  });

  it('a viewer sees the program but cannot share; a school without a program says so', async () => {
    await openRefer({ ...createSampleApi(now), sampleMode: false, referrals: async () => ({ ok: true as const, data: view({ canShare: false }) }) } as ParentApi);
    expect(await screen.findByText(/Only a parent or guardian/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Share my referral link' })).toBeNull();
  });

  it('a school without a program says so', async () => {
    const off = verifyParentReferrals({ schoolName: 'Dojo', on: false, referrerReward: null, friendOffer: null, rules: null, shareMessage: null, canShare: false, shareUrl: null,
      counts: { referred: 0, joined: 0, rewarded: 0 }, referrals: [] });
    await openRefer({ ...createSampleApi(now), sampleMode: false, referrals: async () => ({ ok: true as const, data: off }) } as ParentApi);
    expect(await screen.findByText(/doesn't have a referral program right now/)).toBeTruthy();
  });

  it('the sample family never shares a real link', async () => {
    await openRefer(createSampleApi(now));
    await fireEvent.press(await screen.findByRole('button', { name: 'Share my referral link' }));
    expect(shareSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/no real link to share/)).toBeTruthy();
  });

  it('a failed read shows an error, never old data', async () => {
    await openRefer({ ...createSampleApi(now), sampleMode: false, referrals: async () => ({ ok: false as const, state: 'unavailable' as const }) } as ParentApi);
    expect(await screen.findByText('Referrals are unavailable')).toBeTruthy();
  });

  it('client: GET read and a closed POST link with the command marker', async () => {
    const fetchImpl = jest.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/link') ? { data: { shareUrl: URL } } : { data: view({ shareUrl: URL }) }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const api = createParentApi({ baseUrl: 'https://api.example.test', getToken: async () => 'tok', fetchImpl: fetchImpl as never });
    expect((await api.referrals()).ok).toBe(true);
    const out = await api.referralLink(newKey());
    expect(out.ok && out.data.shareUrl).toBe(URL);
    const [path, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(path).toBe('https://api.example.test/v1/parent/referrals/link');
    expect(init.headers).toMatchObject({ 'x-hon-human-command': 'parent.referrals.link' });
    expect(init.body).toBe('{}');
    expect(shareText(null, URL)).toBe(URL);
  });
});
