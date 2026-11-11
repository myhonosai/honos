import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const session = vi.hoisted(() => ({ require: vi.fn<() => Promise<{ externalSubject: string; viewKey: string }>>() }));
vi.mock('../src/server/require-web-session', () => ({ requireVerifiedWebSession: session.require }));
import StaffLayout from '../src/app/staff/layout';
import StaffClassBookingsPage, { dynamic, metadata } from '../src/app/staff/schedule/bookings/page';
import { ClassBookingEntry } from '../src/components/class-booking-entry';
afterEach(() => vi.restoreAllMocks());
const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const selectors = { organizationId: id('1'), schoolId: id('2'), sessionId: id('3') };

describe('protected staff manual class-booking page', () => {
  it('inherits the existing fail-closed staff session gate and renders only after it succeeds', async () => {
    const child = React.createElement('p', null, 'protected child');
    session.require.mockRejectedValueOnce(new Error('redirect:/auth/login'));
    await expect(StaffLayout({ children: child })).rejects.toThrow('redirect:/auth/login');
    session.require.mockResolvedValueOnce({ externalSubject: 'synthetic-staff', viewKey: 'k' });
    expect((await StaffLayout({ children: child }) as React.ReactElement<{ children: unknown }>).props.children).toBe(child);
    expect(session.require).toHaveBeenCalledTimes(2);
  });
  it('is dynamic/no-index and accepts only the exact closed three-UUID handoff without any automatic command', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const key = vi.spyOn(crypto, 'randomUUID');
    const page = await StaffClassBookingsPage({ searchParams: Promise.resolve(selectors) });
    expect(page.type).toBe(ClassBookingEntry); expect(page.props).toEqual({ initialPrefill: selectors });
    expect(dynamic).toBe('force-dynamic'); expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(fetcher).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
    const source = readFileSync('src/app/staff/schedule/bookings/page.tsx', 'utf8');
    for (const query of [
      { ...selectors, studentProfileId: id('4') },
      { ...selectors, schoolId: [selectors.schoolId, selectors.schoolId] },
      { ...selectors, sessionId: `${selectors.sessionId}?studentProfileId=${id('4')}` },
      { organizationId: selectors.organizationId, schoolId: selectors.schoolId },
    ]) expect((await StaffClassBookingsPage({ searchParams: Promise.resolve(query) })).props).toEqual({ initialPrefill: undefined });
    expect(source).toContain('searchParams'); expect(source).toContain('exactClassBookingSelectorPrefill');
    expect(source).not.toMatch(/studentProfileId|bookingKind|fetch\(|load[A-Z]|submitClassBooking|prepareClassBooking/);
  });
  it('declares the exact route once in the unchanged complete static route manifest', () => {
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    expect(Object.keys(manifest)).toEqual(['routes']);
    expect(manifest.routes.filter((route: { path: string }) => route.path === '/staff/schedule/bookings')).toEqual([{ path: '/staff/schedule/bookings', title: 'HON | Staff Manual Class Booking' }]);
    expect(new Set(manifest.routes.map((route: { path: string }) => route.path)).size).toBe(manifest.routes.length);
  });
});
