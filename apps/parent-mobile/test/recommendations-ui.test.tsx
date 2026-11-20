import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ParentApp } from '../src/ParentApp';
import { createParentApi, type ParentApi } from '../src/api/client';
import { createSampleApi } from '../src/sample/sample-api';
import { seeAction } from '../src/home/Recommendations';
import type { FamilyJourneyRecommendation } from '@hon/contracts/journey-recommendations';
import { NOW } from './fixtures';

const signedOut = { token: async () => null, clear: async () => {}, subscribe: () => () => {} };
const now = () => new Date(NOW);
let n = 0;
const newKey = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const liveApi = createParentApi({ baseUrl: 'https://api.example.test', getToken: async () => null, fetchImpl: jest.fn() });

async function openHome(api: ParentApi) {
  await render(<ParentApp api={liveApi} session={signedOut} now={now} newKey={newKey} sampleApi={() => api} />);
  await fireEvent.press(await screen.findByRole('button', { name: 'Try with a sample family' }));
  await screen.findByRole('button', { name: 'Open Mia Sample journey' });
}

const base: FamilyJourneyRecommendation = { recommendationId: '77777777-7777-4777-8777-000000000003', program: 'Kids', rank: 'Yellow', triggerKind: 'RANK_REACHED',
  threshold: null, title: 'Camp', message: 'Try camp.', targetKind: 'ASK_SCHOOL', checkoutId: null, eventId: null, targetLabel: null };

describe('journey gift stops on Home (J3, 0603)', () => {
  it('maps each target to the app screen it opens, and "ask the school" has no other way in', () => {
    expect(seeAction({ ...base, targetKind: 'CHECKOUT' })).toEqual({ label: 'See how to join', go: { tab: 'More', area: 'checkout' } });
    expect(seeAction({ ...base, targetKind: 'EVENT' })).toEqual({ label: 'See the event', go: { tab: 'More', area: 'events' } });
    expect(seeAction({ ...base, targetKind: 'PRO_SHOP' })).toEqual({ label: 'Open the pro shop', go: { tab: 'More', area: 'shop' } });
    expect(seeAction(base)).toBeNull();
  });

  it('shows a gift stop as its own button; the banner still opens the journey', async () => {
    await openHome(createSampleApi(now));
    expect(await screen.findByRole('button', { name: 'From your school: Try summer camp' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'From your school: Time for sparring gear' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Leo Sample journey' })).toBeTruthy();
  });

  it('opens the school\'s words, and "See how to join" goes straight to Sign up & pay', async () => {
    await openHome(createSampleApi(now));
    await fireEvent.press(await screen.findByRole('button', { name: 'From your school: Try summer camp' }));
    expect(screen.getByText('Leo is moving fast! Camp is a fun week of forms and games.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'See how to join' }));
    expect(await screen.findByRole('button', { name: 'Back to More' })).toBeTruthy();
    expect(screen.getByText('Sign up & pay')).toBeTruthy();
  });

  it('"Not now" hides that gift for this visit and opens nothing', async () => {
    await openHome(createSampleApi(now));
    await fireEvent.press(await screen.findByRole('button', { name: 'From your school: Time for sparring gear' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'From your school: Time for sparring gear' })).toBeNull());
    expect(screen.getByRole('button', { name: 'From your school: Try summer camp' })).toBeTruthy();
  });

  it('shows no gift when the read fails, rather than a guess', async () => {
    await openHome({ ...createSampleApi(now), journeyRecommendations: async () => ({ ok: false as const, state: 'unavailable' as const }) } as ParentApi);
    await screen.findByRole('button', { name: 'Open Leo Sample journey' });
    expect(screen.queryByRole('button', { name: /From your school/ })).toBeNull();
  });
});
