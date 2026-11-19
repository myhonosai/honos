import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ParentApp } from '../src/ParentApp';
import { createParentApi, type ParentApi } from '../src/api/client';
import { createSampleApi } from '../src/sample/sample-api';
import { bookingTypeInput, draftReady } from '../src/more/EventsArea';
import { NOW, jsonResponse } from './fixtures';

const signedOut = { token: async () => null, clear: async () => {}, subscribe: () => () => {} };
const now = () => new Date(NOW);
let n = 0;
const newKey = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const liveApi = createParentApi({ baseUrl: 'https://api.example.test', getToken: async () => null, fetchImpl: jest.fn() });

async function openEvents(api: ParentApi) {
  await render(<ParentApp api={liveApi} session={signedOut} now={now} newKey={newKey} sampleApi={() => api} />);
  await fireEvent.press(await screen.findByRole('button', { name: 'Try with a sample family' }));
  await screen.findByRole('button', { name: 'Open Mia Sample journey' });
  await fireEvent.press(screen.getByRole('tab', { name: 'More' }));
  await fireEvent.press(await screen.findByRole('button', { name: 'Open Events & bookings' }));
  await screen.findByText('Holiday open house');
}

describe('events and bookings in the app', () => {
  it('books an open event time after confirming, shows it as booked, then cancels it', async () => {
    await openEvents(createSampleApi(now));
    expect(screen.getByText('11:00–12:00 · Full')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Book Holiday open house at 10:00, 12 left' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Confirm booking' }));
    expect(await screen.findByText(/^Booked: Holiday open house/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Your family is booked')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel Holiday open house' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Confirm cancel' }));
    expect(await screen.findByText(/^Cancelled: Holiday open house/)).toBeTruthy();
  });

  it('a family booking needs a time before it can be confirmed', async () => {
    await openEvents(createSampleApi(now));
    await fireEvent.press(screen.getByRole('button', { name: 'Pick a time for Private lesson' }));
    expect(screen.queryByRole('button', { name: 'Confirm booking' })).toBeNull();
    await fireEvent.press(screen.getAllByRole('button', { name: /at 16:00, 1 left/ })[0]!);
    await fireEvent.press(await screen.findByRole('button', { name: 'Confirm booking' }));
    expect(await screen.findByText(/^Booked: Private lesson/)).toBeTruthy();
  });

  it('a lost answer is never shown as booked, and Try again resends with the same key', async () => {
    const keys: string[] = [];
    const base = createSampleApi(now);
    let calls = 0;
    const api = { ...base, bookSchoolEventSlot: async (slotId: string, key: string) => { keys.push(key); return calls++ === 0 ? { ok: false as const, state: 'unknown' as const } : base.bookSchoolEventSlot(slotId, key); } } as ParentApi;
    await openEvents(api);
    await fireEvent.press(screen.getByRole('button', { name: 'Book Holiday open house at 10:00, 12 left' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Confirm booking' }));
    expect(await screen.findByText(/could not confirm this with your school yet/)).toBeTruthy();
    expect(screen.queryByText(/^Booked:/)).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/^Booked: Holiday open house/)).toBeTruthy();
    expect(keys[0]).toBe(keys[1]);
  });

  it('a refusal shows the school reason', async () => {
    const api = { ...createSampleApi(now), bookSchoolEventSlot: async () => ({ ok: false as const, state: 'refused' as const, code: 'PARENT_SCHOOL_BOOKING_FULL' }) } as ParentApi;
    await openEvents(api);
    await fireEvent.press(screen.getByRole('button', { name: 'Book Holiday open house at 10:00, 12 left' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Confirm booking' }));
    expect(await screen.findByText('That time is full. Please pick another.')).toBeTruthy();
  });

  it('builds the booking-type input like the web page and requires required answers and the waiver', () => {
    const t = { typeId: '11111111-1111-4111-8111-111111111111', name: 'Belt test', description: '', template: 'TEST_RESERVATION' as const, durationMinutes: 30,
      questions: [{ label: 'Belt', kind: 'TEXT' as const, required: true }, { label: 'First test?', kind: 'YES_NO' as const, required: false }], waiver: 'Rules', bookingId: null, times: [] };
    const d = { startsAt: '2026-11-20T00:00:00.000Z', answers: ['  Yellow ', null], waiverAccepted: false };
    expect(draftReady(t, d)).toBe(false);
    expect(draftReady(t, { ...d, waiverAccepted: true })).toBe(true);
    expect(draftReady(t, { ...d, answers: [' ', null], waiverAccepted: true })).toBe(false);
    expect(bookingTypeInput(t, { ...d, waiverAccepted: true })).toEqual({ typeId: t.typeId, startsAt: d.startsAt, answers: ['Yellow', null], waiverAccepted: true });
  });

  it('cancel sends only the expected version, as the cancel command', async () => {
    const bookingId = '44444444-4444-4444-8444-444444444444';
    const booking = { kind: 'EVENT', bookingId, parentId: '55555555-5555-4555-8555-555555555555', title: 'Open house', localDate: '2026-11-27', localStart: '10:00', localEnd: '11:00',
      startsAt: '2026-11-27T18:00:00.000Z', status: 'CANCELLED', version: 3, canCancel: false };
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { data: { booking, spotsLeft: 4 }, meta: { replayed: false } }));
    const api = createParentApi({ baseUrl: 'https://api.example.test', getToken: async () => 'tok', fetchImpl });
    const result = await api.cancelSchoolBooking(bookingId, 2, 'key-0000000000000001');
    expect(result.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://api.example.test/v1/parent/school-bookings/${bookingId}/cancel`);
    expect(init.headers['x-hon-human-command']).toBe('parent.school_booking.cancel');
    expect(JSON.parse(init.body)).toEqual({ expectedVersion: 2 });
  });
});
