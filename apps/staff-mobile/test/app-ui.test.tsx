import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StaffApp } from '../src/StaffApp';
import type { StaffApi, WhereIWork } from '../src/api/client';
import { ORG, SCHOOL_A, SCHOOL_B } from './fixtures';

function fakeSession(initial: string | null) {
  let token = initial;
  const listeners = new Set<(t: string | null) => void>();
  return {
    token: async () => token,
    save: async (t: string) => { token = t; listeners.forEach(l => l(t)); },
    clear: jest.fn(async () => { token = null; listeners.forEach(l => l(null)); }),
    subscribe: (l: (t: string | null) => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  };
}
let n = 0;
const key = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const closedToday = { todayClasses: jest.fn(async () => ({ ok: false as const, state: 'no-staff-access' as const })), roster: jest.fn(), mark: jest.fn(),
  clock: jest.fn(async () => ({ ok: false as const, state: 'no-staff-access' as const })), punch: jest.fn() };
const api = (result: WhereIWork): StaffApi => ({ whereIWork: jest.fn(async () => result), ...closedToday });
const one: WhereIWork = { ok: true, data: { kind: 'one', school: { organizationId: ORG, schoolId: SCHOOL_A, schoolName: null } } };
const choose: WhereIWork = { ok: true, data: { kind: 'choose', schools: [
  { organizationId: ORG, schoolId: SCHOOL_A, schoolName: 'North Test School' },
  { organizationId: ORG, schoolId: SCHOOL_B, schoolName: 'South Test School' },
] } };

describe('HON Staff app shell', () => {
  it('signed out: offers sign-in and runs it', async () => {
    const session = fakeSession(null);
    const onSignIn = jest.fn(async () => { await session.save('t'); return 'signed-in' as const; });
    await render(<StaffApp api={api(one)} session={session} onSignIn={onSignIn} version="0.1.0" newKey={key} />);
    expect(await screen.findByText('HON Staff')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    expect(onSignIn).toHaveBeenCalled();
    expect(await screen.findByText('Your school')).toBeTruthy();
  });
  it('a failed sign-in says so and stays signed out', async () => {
    await render(<StaffApp api={api(one)} session={fakeSession(null)} onSignIn={async () => 'failed'} version="0.1.0" newKey={key} />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Sign-in did not finish. Please try again.')).toBeTruthy();
  });
  it('a build without a web address cannot sign in', async () => {
    await render(<StaffApp api={api(one)} session={fakeSession(null)} version="0.1.0" newKey={key} />);
    expect(await screen.findByText('This build cannot sign in yet. Please update the app.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });
  it('several schools: pick one, then switch back to the list', async () => {
    await render(<StaffApp api={api(choose)} session={fakeSession('t')} version="0.1.0" newKey={key} />);
    expect(await screen.findByText('Which school are you working at?')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'South Test School' }));
    expect(await screen.findByText('South Test School')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Switch school' }));
    expect(await screen.findByText('Which school are you working at?')).toBeTruthy();
  });
  it('one school: goes straight in, with no switch button', async () => {
    await render(<StaffApp api={api(one)} session={fakeSession('t')} version="0.1.0" newKey={key} />);
    expect(await screen.findByText('Your school')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Switch school' })).toBeNull();
  });
  it('honest about what is not built yet', async () => {
    await render(<StaffApp api={api(one)} session={fakeSession('t')} version="0.1.0" newKey={key} />);
    expect(await screen.findByText(/HON, Kai and the AI team come in the next update/)).toBeTruthy();
  });
  it('no staff access and HON unavailable each have their own screen', async () => {
    await render(<StaffApp api={api({ ok: false, state: 'no-staff-access' })} session={fakeSession('t')} version="0.1.0" newKey={key} />);
    expect(await screen.findByText('This account has no staff access at a HON school.')).toBeTruthy();
    await render(<StaffApp api={api({ ok: false, state: 'unavailable' })} session={fakeSession('t')} version="0.1.0" newKey={key} />);
    expect(await screen.findByText('HON is not available right now.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  });
  it('signed out by HON (expired session) wipes the token; sign out also wipes it', async () => {
    const expired = fakeSession('old');
    await render(<StaffApp api={api({ ok: false, state: 'signed-out' })} session={expired} version="0.1.0" newKey={key} />);
    expect(await screen.findByText('Sign in with your HON staff account.')).toBeTruthy();
    expect(expired.clear).toHaveBeenCalled();
    const s = fakeSession('t');
    await render(<StaffApp api={api(one)} session={s} version="0.1.0" newKey={key} />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Sign out' }));
    expect(s.clear).toHaveBeenCalled();
    expect(await screen.findByText('Sign in with your HON staff account.')).toBeTruthy();
  });
});
