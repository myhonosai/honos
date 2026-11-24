import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StaffApp } from '../src/StaffApp';
import type { StaffApi } from '../src/api/client';
import { verifyRosterPage, verifyStudentSearch, verifyTodayClasses } from '../src/api/today';
import { verifyMyTimeClock } from '@hon/contracts/staff-time-clock';
import { CLASS_1, CLASS_LIST, FOUND, ORG, RECORD, ROSTER, SCHOOL_A, STUDENT_1, WALK_IN, clock, entry } from './fixtures';

function fakeSession() {
  return { token: async () => 't', save: async () => {}, clear: jest.fn(async () => {}), subscribe: () => () => {} };
}
let n = 0;
const newKey = jest.fn(() => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`);
const school = { organizationId: ORG, schoolId: SCHOOL_A, schoolName: null };
function fakeApi(patch: Partial<StaffApi> = {}): StaffApi {
  return {
    whereIWork: async () => ({ ok: true, data: { kind: 'one', school } }),
    todayClasses: jest.fn(async () => ({ ok: true as const, data: verifyTodayClasses(CLASS_LIST) })),
    roster: jest.fn(async () => ({ ok: true as const, data: verifyRosterPage(ROSTER) })),
    mark: jest.fn(async () => ({ ok: true as const, data: { id: RECORD, status: 'PRESENT' as const, category: 'REGULAR_PARTICIPANT', recordedAt: '2026-11-23T01:05:00.000Z', version: 1 } })),
    clock: jest.fn(async () => ({ ok: true as const, data: verifyMyTimeClock(clock(null).data) })),
    punch: jest.fn(async () => ({ ok: true as const, data: verifyMyTimeClock(clock(entry()).data).open! })),
    findStudents: jest.fn(async () => ({ ok: true as const, data: verifyStudentSearch(FOUND) })),
    myAgents: jest.fn(async () => ({ ok: false as const, state: 'no-staff-access' as const })),
    startConversation: jest.fn(),
    ask: jest.fn(),
    findContacts: jest.fn(), contactCard: jest.fn(), inbox: jest.fn(), conversation: jest.fn(), markRead: jest.fn(), reply: jest.fn(),
    ...patch,
  };
}
const app = (api: StaffApi, session = fakeSession()) => render(<StaffApp api={api} session={session} version="0.1.0" newKey={newKey} />);

describe('Today screen', () => {
  it('shows my clock and today\'s classes in school time, with cancelled classes marked', async () => {
    await app(fakeApi());
    expect(await screen.findByText('You are not clocked in.')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Kids Fundamentals, 5:00 PM – 6:00 PM' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Adult BJJ, 7:00 PM – 8:00 PM, cancelled' })).toBeTruthy();
    expect(screen.queryByText('Tomorrow Class')).toBeNull();
  });
  it('clock in: one punch at version 0, then the clock is read again', async () => {
    const api = fakeApi();
    await app(api);
    await fireEvent.press(await screen.findByRole('button', { name: 'Clock in' }));
    expect(api.punch).toHaveBeenCalledWith(school, 'CLOCK_IN', 0, expect.any(String));
    expect(await screen.findByText('Clocked in.')).toBeTruthy();
    expect(api.clock).toHaveBeenCalledTimes(2);
  });
  it('an unknown punch outcome keeps the same key for the retry', async () => {
    const punch = jest.fn(async () => ({ ok: false as const, state: 'unknown' as const }));
    await app(fakeApi({ punch }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Clock in' }));
    expect(await screen.findByText('Not sure it saved. Tap the same button again to retry safely.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Clock in' }));
    expect(punch).toHaveBeenCalledTimes(2);
    expect((punch.mock.calls[0] as unknown[])[3]).toBe((punch.mock.calls[1] as unknown[])[3]);
  });
  it('each section has its own "not for your role" state', async () => {
    await app(fakeApi({ clock: async () => ({ ok: false, state: 'no-staff-access' }) }));
    expect(await screen.findByText('Not available for your role at this school.')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Kids Fundamentals, 5:00 PM – 6:00 PM' })).toBeTruthy();
  });
  it('open a class, mark a student present, and go back', async () => {
    const api = fakeApi();
    await app(api);
    await fireEvent.press(await screen.findByRole('button', { name: 'Kids Fundamentals, 5:00 PM – 6:00 PM' }));
    expect(await screen.findByText('Test Student')).toBeTruthy();
    expect(screen.getByText('Not marked')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Late: Trial Kid', selected: true })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Present: Test Student' }));
    expect(api.mark).toHaveBeenCalledWith(school, CLASS_1, expect.objectContaining({ studentProfileId: STUDENT_1 }), 'PRESENT', expect.any(String));
    expect(await screen.findByRole('button', { name: 'Present: Test Student', selected: true })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Back to Today' }));
    expect(await screen.findByText('My clock')).toBeTruthy();
  });
  it('a mark changed elsewhere says so and reloads the roster', async () => {
    const api = fakeApi({ mark: jest.fn(async () => ({ ok: false as const, state: 'changed' as const })) });
    await app(api);
    await fireEvent.press(await screen.findByRole('button', { name: 'Kids Fundamentals, 5:00 PM – 6:00 PM' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Absent: Test Student' }));
    expect(await screen.findByText('This changed somewhere else. Showing the latest.')).toBeTruthy();
    expect(api.roster).toHaveBeenCalledTimes(2);
  });
  it('a 401 in any section wipes the token and signs out', async () => {
    const session = fakeSession();
    await app(fakeApi({ clock: async () => ({ ok: false, state: 'signed-out' }) }), session);
    expect(await screen.findByText('Your session ended. Please sign in again.')).toBeTruthy();
    expect(session.clear).toHaveBeenCalled();
  });
  it('add a student by searching: a walk-in is marked present and the roster is read again', async () => {
    const api = fakeApi();
    await app(api);
    await fireEvent.press(await screen.findByRole('button', { name: 'Kids Fundamentals, 5:00 PM – 6:00 PM' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Add a student' }));
    await fireEvent.changeText(screen.getByLabelText('Student name'), 'wal');
    await fireEvent.press(screen.getByRole('button', { name: 'Search' }));
    expect(api.findStudents).toHaveBeenCalledWith(school, 'wal');
    await fireEvent.press(await screen.findByRole('button', { name: 'Mark present: Walk In' }));
    expect(api.mark).toHaveBeenCalledWith(school, CLASS_1, expect.objectContaining({ studentProfileId: WALK_IN, booking: null, attendance: null }), 'PRESENT', expect.any(String));
    expect(api.roster).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('button', { name: 'Add a student' })).toBeTruthy();
  });
  it('a searched student already on the roster is marked through their roster row', async () => {
    const api = fakeApi();
    await app(api);
    await fireEvent.press(await screen.findByRole('button', { name: 'Kids Fundamentals, 5:00 PM – 6:00 PM' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Add a student' }));
    await fireEvent.changeText(screen.getByLabelText('Student name'), 'test');
    await fireEvent.press(screen.getByRole('button', { name: 'Search' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Mark present: Test Student' }));
    expect(api.mark).toHaveBeenCalledWith(school, CLASS_1, expect.objectContaining({ studentProfileId: STUDENT_1, booking: expect.objectContaining({ kind: 'REGULAR' }) }), 'PRESENT', expect.any(String));
  });
  it('search needs at least two letters', async () => {
    const api = fakeApi();
    await app(api);
    await fireEvent.press(await screen.findByRole('button', { name: 'Kids Fundamentals, 5:00 PM – 6:00 PM' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Add a student' }));
    await fireEvent.changeText(screen.getByLabelText('Student name'), 'w');
    await fireEvent.press(screen.getByRole('button', { name: 'Search' }));
    expect(api.findStudents).not.toHaveBeenCalled();
  });
});
