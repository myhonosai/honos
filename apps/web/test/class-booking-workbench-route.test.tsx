import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const session = vi.hoisted(() => ({ require: vi.fn<() => Promise<void>>() }));
vi.mock('../src/server/require-web-session', () => ({ requireVerifiedWebSession: session.require }));
import StaffLayout from '../src/app/staff/layout';
import StaffClassBookingsPage, { dynamic, metadata } from '../src/app/staff/schedule/bookings/page';
import { ClassBookingWorkbench } from '../src/components/class-booking-workbench';
afterEach(() => vi.restoreAllMocks());

describe('protected staff manual class-booking page', () => {
  it('inherits the existing fail-closed staff session gate and renders only after it succeeds', async () => {
    const child = React.createElement('p', null, 'protected child');
    session.require.mockRejectedValueOnce(new Error('redirect:/auth/login'));
    await expect(StaffLayout({ children: child })).rejects.toThrow('redirect:/auth/login');
    session.require.mockResolvedValueOnce();
    expect(await StaffLayout({ children: child })).toBe(child);
    expect(session.require).toHaveBeenCalledTimes(2);
  });
  it('is dynamic/no-index and has no query, prefill, IDs, directory reads or auto commands', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const key = vi.spyOn(crypto, 'randomUUID');
    const page = StaffClassBookingsPage();
    expect(page.type).toBe(ClassBookingWorkbench); expect(page.props).toEqual({});
    expect(dynamic).toBe('force-dynamic'); expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(fetcher).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
    const source = readFileSync('src/app/staff/schedule/bookings/page.tsx', 'utf8');
    expect(source).not.toMatch(/searchParams|initialScope|organizationId|schoolId|sessionId|studentProfileId|fetch\(|load[A-Z]|submitClassBooking|prepareClassBooking/);
  });
  it('declares the exact route once in the unchanged complete static route manifest', () => {
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    expect(Object.keys(manifest)).toEqual(['routes']);
    expect(manifest.routes.filter((route: { path: string }) => route.path === '/staff/schedule/bookings')).toEqual([{ path: '/staff/schedule/bookings', title: 'HON | Staff Manual Class Booking' }]);
    expect(new Set(manifest.routes.map((route: { path: string }) => route.path)).size).toBe(manifest.routes.length);
  });
});
