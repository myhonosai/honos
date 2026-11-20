import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { verifyParentJourneyView } from '@hon/contracts/parent-journey-view';
import { ParentApp } from '../src/ParentApp';
import type { ParentApi, ParentRead } from '../src/api/client';
import { journeyBody, NOW } from './fixtures';

function fakeSession(token: string | null) {
  let current = token;
  const listeners = new Set<(t: string | null) => void>();
  return {
    token: jest.fn(async () => current),
    save: jest.fn(async (t: string) => { current = t; listeners.forEach(l => l(t)); }),
    clear: jest.fn(async () => { current = null; listeners.forEach(l => l(null)); }),
    subscribe: (l: (t: string | null) => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  };
}
function fakeApi(journey: ParentRead<ReturnType<typeof verifyParentJourneyView>>, zone: string | null = 'America/Los_Angeles'): ParentApi {
  return { journey: jest.fn(async () => journey), schoolTimeZone: jest.fn(async () => zone), classBookings: jest.fn(async () => ({ ok: false, state: 'unavailable' })),
    announcements: jest.fn(async () => ({ ok: false, state: 'unavailable' })), attendanceStreaks: jest.fn(async () => ({ ok: false, state: 'unavailable' })) } as unknown as ParentApi;
}
const ok = { ok: true as const, data: verifyParentJourneyView(journeyBody()) };
const now = () => new Date(NOW);

describe('Parent app shell', () => {
  it('shows the five tabs with Eian in the middle', async () => {
    await render(<ParentApp api={fakeApi(ok)} session={fakeSession('t')} now={now} />);
    await screen.findByRole('button', { name: 'Open Test Child A journey' });
    const labels = ['Home', 'Schedule', 'Eian', 'Messages', 'More'].map(l => screen.getByRole('tab', { name: l }));
    expect(labels).toHaveLength(5);
  });

  it('home: progress is a belt path with the next requirement, from the school\'s records only', async () => {
    await render(<ParentApp api={fakeApi(ok)} session={fakeSession('t')} now={now} />);
    await screen.findByRole('button', { name: 'Open Test Child A journey' });
    expect(screen.getByText('Next: Form 1')).toBeTruthy();
    expect(screen.getByText('Test has 1 of 3 done. Keep going!')).toBeTruthy();
    expect(screen.getByLabelText('Front kick: met')).toBeTruthy();
    expect(screen.getByLabelText('Respect: still to come, optional')).toBeTruthy();
    expect(screen.getByText('1/3')).toBeTruthy();
    // A child whose requirements the school did not return says so instead of drawing a path.
    expect(screen.getByText("Requirements aren't available right now.")).toBeTruthy();
  });

  it('signed out: shows sign-in and never calls a family read', async () => {
    const api = fakeApi(ok);
    await render(<ParentApp api={api} session={fakeSession(null)} now={now} />);
    expect(await screen.findByText(/Sign in to your school/)).toBeTruthy();
    expect(api.journey).not.toHaveBeenCalled();
  });

  it('home: shows every authorized child and the next class across the family', async () => {
    await render(<ParentApp api={fakeApi(ok)} session={fakeSession('t')} now={now} />);
    expect((await screen.findAllByText('Test Child A')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Test Child B').length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/Next class: Juniors for Test Child B/)).toBeTruthy();
  });

  it('home: choosing a child scopes the next class to that child', async () => {
    await render(<ParentApp api={fakeApi(ok)} session={fakeSession('t')} now={now} />);
    await screen.findByRole('button', { name: 'Open Test Child A journey' });
    await fireEvent.press(screen.getByRole('button', { name: 'Show Test Child A' }));
    expect(screen.getByLabelText(/Next class: Little Dragons for Test Child A, Waitlisted/)).toBeTruthy();
  });

  it('journey: opening a child shows recorded requirements without inventing missing ones', async () => {
    await render(<ParentApp api={fakeApi(ok)} session={fakeSession('t')} now={now} />);
    await screen.findByRole('button', { name: 'Open Test Child A journey' });
    await fireEvent.press(screen.getByRole('button', { name: 'Open Test Child A journey' }));
    expect(await screen.findByText('Front kick')).toBeTruthy();
    expect(screen.getByText('Met')).toBeTruthy();
    expect(screen.getByText('Not recorded yet')).toBeTruthy();
    expect(screen.getByText('Best Forms')).toBeTruthy();
  });

  it('access revoked: wipes family data and says access ended', async () => {
    const api = fakeApi(ok);
    await render(<ParentApp api={api} session={fakeSession('t')} now={now} />);
    await screen.findByRole('button', { name: 'Open Test Child A journey' });
    (api.journey as jest.Mock).mockResolvedValueOnce({ ok: false, state: 'access-denied' });
    await fireEvent.press(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText(/no longer has access/)).toBeTruthy();
    expect(screen.queryAllByText('Test Child A')).toHaveLength(0);
  });

  it('expired session: clears the stored session and returns to sign-in', async () => {
    const session = fakeSession('t');
    await render(<ParentApp api={fakeApi({ ok: false, state: 'signed-out' })} session={session} now={now} />);
    expect(await screen.findByText(/Sign in to your school/)).toBeTruthy();
    expect(session.clear).toHaveBeenCalled();
  });

  it('several families and none chosen: asks to choose and does not pick one', async () => {
    await render(<ParentApp api={fakeApi({ ok: false, state: 'choose-family' })} session={fakeSession('t')} now={now} />);
    expect(await screen.findByText(/linked to more than one school or family/)).toBeTruthy();
  });

  it('offline: says so and shows no family data', async () => {
    await render(<ParentApp api={fakeApi({ ok: false, state: 'offline' })} session={fakeSession('t')} now={now} />);
    expect(await screen.findByText(/can't reach HON/)).toBeTruthy();
  });

  it('sign out removes the session', async () => {
    const session = fakeSession('t');
    await render(<ParentApp api={fakeApi(ok)} session={session} now={now} />);
    await screen.findByRole('button', { name: 'Open Test Child A journey' });
    await fireEvent.press(screen.getByRole('tab', { name: 'More' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(session.clear).toHaveBeenCalled());
    expect(await screen.findByText(/Sign in to your school/)).toBeTruthy();
  });

  it('sign in: the button starts native sign-in and a failure is explained without signing in', async () => {
    const onSignIn = jest.fn(async () => 'failed' as const);
    await render(<ParentApp api={fakeApi(ok)} session={fakeSession(null)} now={now} onSignIn={onSignIn} />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Sign in' }));
    expect(onSignIn).toHaveBeenCalled();
    expect(await screen.findByText(/couldn't finish signing in/)).toBeTruthy();
  });
});
