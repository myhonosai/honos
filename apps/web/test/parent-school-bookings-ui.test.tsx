import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bookParentBookingType, bookParentEventSlot, cancelParentSchoolBooking, loadParentSchoolBookings, ParentSchoolBookingRefusal, schoolBookingAttempt } from '../src/components/parent-school-bookings-http';
import { ParentSchoolBookingsView, type ParentSchoolBookingsViewProps } from '../src/components/parent-school-bookings';

// 0431 parent school bookings web: same-origin commands with no family, name or contact sent; a refusal drops the key, an unknown outcome keeps it.
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const T1 = '2026-11-21T17:00:00.000Z', T2 = '2026-11-21T17:30:00.000Z';
const booking = { kind: 'EVENT', bookingId: C, parentId: B, title: 'Black Friday Sale', localDate: '2026-11-21', localStart: '09:00', localEnd: '09:30', startsAt: T1, status: 'BOOKED', version: 1, canCancel: true } as const;
const view = { canBook: true, timezone: 'America/Los_Angeles', contact: { name: 'Kim Family', email: 'kim@example.test' },
  events: [{ eventId: B, title: 'Black Friday Sale', description: 'Gear 30% off', place: 'Lobby', localDate: '2026-11-21', bookingId: null,
    slots: [{ slotId: A, localStart: '09:00', localEnd: '09:30', startsAt: T1, spotsLeft: 2 }, { slotId: C, localStart: '09:30', localEnd: '10:00', startsAt: T2, spotsLeft: 0 }] }],
  bookingTypes: [{ typeId: A, name: 'Belt test reservation', description: '', template: 'TEST_RESERVATION', durationMinutes: 30,
    questions: [{ label: 'Current belt', kind: 'TEXT', required: true }, { label: 'First test?', kind: 'YES_NO', required: false }], waiver: 'I accept the testing rules.', bookingId: null,
    times: [{ startsAt: T1, localDate: '2026-11-21', localStart: '09:00', localEnd: '09:30', spotsLeft: 1 }, { startsAt: T2, localDate: '2026-11-21', localStart: '09:30', localEnd: '10:00', spotsLeft: 0 }] }],
  bookings: [booking] };
afterEach(() => vi.restoreAllMocks());

describe('parent school bookings', () => {
  it('reads and sends same-origin commands to the fixed routes with only the closed bodies', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { data: view }))
      .mockResolvedValueOnce(json(201, { data: { booking, spotsLeft: 1 }, meta: { replayed: false } }))
      .mockResolvedValueOnce(json(201, { data: { booking: { ...booking, kind: 'BOOKING_TYPE' }, spotsLeft: 0 }, meta: { replayed: false } }))
      .mockResolvedValueOnce(json(200, { data: { booking: { ...booking, status: 'CANCELLED', version: 2, canCancel: false }, spotsLeft: 2 }, meta: { replayed: false } }));
    expect((await loadParentSchoolBookings()).contact?.name).toBe('Kim Family');
    expect(f.mock.calls[0]).toMatchObject(['/api/v1/parent/school-bookings', { method: 'GET', credentials: 'same-origin', mode: 'same-origin', headers: { Accept: 'application/json' } }]);
    await bookParentEventSlot(A, 'k1');
    expect(f.mock.calls[1]).toMatchObject(['/api/v1/parent/school-bookings/event-slots', { method: 'POST', headers: { 'X-HON-Human-Command': 'parent.school_booking.book', 'Idempotency-Key': 'k1' } }]);
    expect(JSON.parse(String((f.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({ slotId: A });
    await bookParentBookingType({ typeId: A, startsAt: T1, answers: ['Yellow', null], waiverAccepted: true }, 'k2');
    expect(f.mock.calls[2]).toMatchObject(['/api/v1/parent/school-bookings/booking-types', { method: 'POST' }]);
    expect(JSON.parse(String((f.mock.calls[2] as unknown as [string, RequestInit])[1].body))).toEqual({ typeId: A, startsAt: T1, answers: ['Yellow', null], waiverAccepted: true });
    await cancelParentSchoolBooking(C, 1, 'k3');
    expect(f.mock.calls[3]).toMatchObject([`/api/v1/parent/school-bookings/${C}/cancel`, { headers: { 'X-HON-Human-Command': 'parent.school_booking.cancel' } }]);
    expect(JSON.parse(String((f.mock.calls[3] as unknown as [string, RequestInit])[1].body))).toEqual({ expectedVersion: 1 });
  });

  it('a definite refusal is a refusal; a send still in progress or a 5xx is an unknown outcome', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(409, { code: 'PARENT_SCHOOL_BOOKING_FULL' })).mockResolvedValueOnce(json(409, { code: 'IDEMPOTENCY_IN_PROGRESS' }))
      .mockResolvedValueOnce(json(503, { code: 'PARENT_SCHOOL_BOOKING_UNAVAILABLE' }));
    await expect(bookParentEventSlot(A, 'k')).rejects.toBeInstanceOf(ParentSchoolBookingRefusal);
    const pending = await bookParentEventSlot(A, 'k').catch((e) => e);
    expect(pending).toBeInstanceOf(Error); expect(pending).not.toBeInstanceOf(ParentSchoolBookingRefusal);
    const down = await bookParentEventSlot(A, 'k').catch((e) => e);
    expect(down).not.toBeInstanceOf(ParentSchoolBookingRefusal);
    expect(schoolBookingAttempt('a', { action: 'a', key: 'x' }, () => 'y').key).toBe('x');
    expect(schoolBookingAttempt('b', { action: 'a', key: 'x' }, () => 'y').key).toBe('y');
  });

  const props = (over: Partial<ParentSchoolBookingsViewProps> = {}): ParentSchoolBookingsViewProps => ({ view: view as never, busy: false, acting: '', error: '', notice: '', lost: false, drafts: {}, ...over });
  it('shows the family bookings, open event slots and family booking forms; viewers only look', () => {
    const html = renderToStaticMarkup(<ParentSchoolBookingsView {...props()}/>);
    expect(html).toContain('Bookings are made as Kim Family, kim@example.test.');
    expect(html).toContain('Cancel booking');
    expect(html).toContain('09:00–09:30 · 2 left');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>09:30–10:00 · Full/);
    expect(html).toContain('Current belt');
    expect(html).toContain('I accept the testing rules.');
    expect(html).not.toContain('value="2026-11-21T17:30:00.000Z"');
    const viewer = renderToStaticMarkup(<ParentSchoolBookingsView {...props({ view: { ...view, canBook: false } as never })}/>);
    expect(viewer).toContain('View only');
    expect(viewer).not.toContain('Cancel booking');
    expect(viewer).not.toContain('parent-type-form');
    const nomail = renderToStaticMarkup(<ParentSchoolBookingsView {...props({ view: { ...view, canBook: false, contact: null } as never })}/>);
    expect(nomail).toContain('no email the school can use');
    const booked = renderToStaticMarkup(<ParentSchoolBookingsView {...props({ view: { ...view, events: [{ ...view.events[0], bookingId: C }] } as never })}/>);
    expect(booked).toContain('Your family is booked');
    expect(renderToStaticMarkup(<ParentSchoolBookingsView {...props({ error: 'Booking is not available on this account right now.', lost: true, view: null })}/>)).toContain('Sign in again');
  });

  it('is linked from the family home and listed in the route manifest', () => {
    expect(readFileSync('src/components/parent-home.tsx', 'utf8')).toContain('href="/parent/bookings"');
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string }[] };
    expect(manifest.routes.filter((r) => r.path === '/parent/bookings')).toHaveLength(1);
  });
});
