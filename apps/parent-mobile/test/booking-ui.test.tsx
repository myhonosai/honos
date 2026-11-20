import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { verifyParentJourneyView } from '@hon/contracts/parent-journey-view';
import { verifyParentClassBookingChoices } from '@hon/contracts/parent-class-booking';
import { ParentApp } from '../src/ParentApp';
import type { ParentApi } from '../src/api/client';
import { CHILD_A, NOW, SESSION_1, booking, choicesBody, journeyBody } from './fixtures';

const session = { token: async () => 't', clear: async () => {}, subscribe: () => () => {} };
const choices = (o?: Parameters<typeof choicesBody>[0]) => ({ ok: true as const, data: verifyParentClassBookingChoices(choicesBody(o).data) });
function fakeApi(overrides: Partial<Record<keyof ParentApi, jest.Mock>>) {
  return {
    journey: jest.fn(async () => ({ ok: true, data: verifyParentJourneyView(journeyBody()) })),
    schoolTimeZone: jest.fn(async () => 'America/Los_Angeles'),
    classBookings: jest.fn(async () => choices()),
    bookClass: jest.fn(), cancelBooking: jest.fn(), announcements: jest.fn(async () => ({ ok: false, state: 'unavailable' })), attendanceStreaks: jest.fn(async () => ({ ok: false, state: 'unavailable' })), journeyRecommendations: jest.fn(async () => ({ ok: false, state: 'unavailable' })),
    ...overrides,
  } as unknown as ParentApi & Record<string, jest.Mock>;
}
let n = 0;
const newKey = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
async function openSchedule(api: ParentApi) {
  await render(<ParentApp api={api} session={session} now={() => new Date(NOW)} newKey={newKey} />);
  await screen.findByRole('button', { name: 'Open Test Child A journey' });
  await fireEvent.press(screen.getByRole('tab', { name: 'Schedule' }));
  return screen.findByRole('button', { name: 'Book Little Dragons for Test Child A' });
}

describe('booking from the Schedule tab', () => {
  beforeEach(() => { n = 0; });

  it('books only after the parent confirms, then re-reads', async () => {
    const api = fakeApi({ bookClass: jest.fn(async () => ({ ok: true, replayed: false, data: { booking: booking({ sessionId: SESSION_1 }), spotsLeft: 2 } })) });
    await fireEvent.press(await openSchedule(api));
    expect(api.bookClass).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm booking' }));
    expect(await screen.findByText('Booked.')).toBeTruthy();
    expect(api.bookClass).toHaveBeenCalledWith({ studentProfileId: CHILD_A, sessionId: SESSION_1 }, '00000000-0000-4000-8000-000000000001');
    expect(api.classBookings).toHaveBeenCalledTimes(2);
    // The reward moment repeats what the server confirmed, and Continue closes it.
    expect(screen.getByText("You're booked!")).toBeTruthy();
    expect(screen.getByText(/^Test Child A · Little Dragons, /)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.queryByText("You're booked!")).toBeNull();
  });

  it('a waitlist place is never shown as booked', async () => {
    const api = fakeApi({ bookClass: jest.fn(async () => ({ ok: true, replayed: false, data: { booking: booking({ sessionId: SESSION_1, status: 'WAITLISTED' }), spotsLeft: 0 } })) });
    await fireEvent.press(await openSchedule(api));
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm booking' }));
    expect(await screen.findByText(/Added to the waitlist/)).toBeTruthy();
    expect(screen.queryByText('Booked.')).toBeNull();
    expect(screen.queryByText("You're booked!")).toBeNull();
  });

  it('unknown result: re-reads, offers a retry, and the retry reuses the same key', async () => {
    const bookClass = jest.fn()
      .mockResolvedValueOnce({ ok: false, state: 'unknown' })
      .mockResolvedValueOnce({ ok: true, replayed: true, data: { booking: booking({ sessionId: SESSION_1 }), spotsLeft: 2 } });
    const api = fakeApi({ bookClass });
    await fireEvent.press(await openSchedule(api));
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm booking' }));
    expect(await screen.findByText(/could not confirm this/)).toBeTruthy();
    expect(screen.queryByText('Booked.')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Booked.')).toBeTruthy();
    expect(bookClass.mock.calls[0][1]).toBe(bookClass.mock.calls[1][1]);
  });

  it('unknown result that actually landed: the re-read shows it, no retry offered', async () => {
    const classBookings = jest.fn().mockResolvedValueOnce(choices()).mockResolvedValue(choices({ s1: { booking: booking({ sessionId: SESSION_1, bookingId: '55555555-5555-4555-8555-555555555555' }) } }));
    const api = fakeApi({ classBookings, bookClass: jest.fn(async () => ({ ok: false, state: 'unknown' })) });
    await fireEvent.press(await openSchedule(api));
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm booking' }));
    expect(await screen.findByText('Booked.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(api.bookClass).toHaveBeenCalledTimes(1);
    expect(screen.getByText("You're booked!")).toBeTruthy();
  });

  it('unknown result: no reward moment until HON confirms', async () => {
    const api = fakeApi({ bookClass: jest.fn(async () => ({ ok: false, state: 'unknown' })) });
    await fireEvent.press(await openSchedule(api));
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm booking' }));
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText("You're booked!")).toBeNull();
  });

  it('a refusal says why and changes nothing on screen', async () => {
    const api = fakeApi({ bookClass: jest.fn(async () => ({ ok: false, state: 'refused', code: 'PARENT_CLASS_BOOKING_FULL' })) });
    await fireEvent.press(await openSchedule(api));
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm booking' }));
    expect(await screen.findByText('This class is full.')).toBeTruthy();
    expect(screen.queryByText("You're booked!")).toBeNull();
  });

  it('cancels with the booking version after confirmation', async () => {
    const api = fakeApi({ cancelBooking: jest.fn(async () => ({ ok: true, replayed: false, data: { booking: booking({ status: 'CANCELLED', canCancel: false, version: 2 }), spotsLeft: 6 } })) });
    await openSchedule(api);
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel Juniors for Test Child A' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm cancel' }));
    expect(await screen.findByText('Booking cancelled.')).toBeTruthy();
    expect(api.cancelBooking).toHaveBeenCalledWith('44444444-4444-4444-8444-444444444444', 1, expect.any(String));
  });

  it('view-only access shows no Book buttons', async () => {
    const api = fakeApi({ classBookings: jest.fn(async () => choices({ canBook: false, s2: { booking: booking({ canCancel: false }) } })) });
    await render(<ParentApp api={api} session={session} now={() => new Date(NOW)} newKey={newKey} />);
    await screen.findByRole('button', { name: 'Open Test Child A journey' });
    await fireEvent.press(screen.getByRole('tab', { name: 'Schedule' }));
    expect(await screen.findByText(/see classes but not book them/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Book / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Cancel / })).toBeNull();
  });
});
