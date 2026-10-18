import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const session = vi.hoisted(() => ({ require: vi.fn<() => Promise<void>>() }));
vi.mock('../src/server/require-web-session', () => ({ requireVerifiedWebSession: session.require }));
import StaffLayout from '../src/app/staff/layout';
import StaffBillingAccountsPage, { dynamic, metadata } from '../src/app/staff/billing/accounts/page';
import { BillingAccountWorkbench } from '../src/components/billing-account-workbench';
afterEach(() => vi.restoreAllMocks());

describe('protected dynamic human billing account route', () => {
  it('cannot render without the shared verified staff session layout', async () => {
    const child = React.createElement('p', null, 'private'); session.require.mockRejectedValueOnce(new Error('redirect:/auth/login'));
    await expect(StaffLayout({ children: child })).rejects.toThrow('redirect:/auth/login'); session.require.mockResolvedValueOnce(); expect(await StaffLayout({ children: child })).toBe(child);
  });
  it('is dynamic/noindex and begins with no URL selector, transport, or idempotency allocation', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const allocate = vi.spyOn(crypto, 'randomUUID');
    const page = StaffBillingAccountsPage(); expect(page.type).toBe(BillingAccountWorkbench); expect(page.props).toEqual({});
    expect(dynamic).toBe('force-dynamic'); expect(metadata.robots).toEqual({ index: false, follow: false }); expect(fetcher).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
    expect(readFileSync('src/app/staff/billing/accounts/page.tsx', 'utf8')).not.toMatch(/searchParams|organizationId|schoolId|fetch\(|prepareBilling|submitBilling/);
  });
  it('declares exactly one billing account workbench route and no account detail/history route', () => {
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    expect(manifest.routes.filter((route: { path: string }) => route.path.startsWith('/staff/billing/accounts'))).toEqual([{ path: '/staff/billing/accounts', title: 'HON | Human Billing Account Workbench' }]);
    expect(new Set(manifest.routes.map((route: { path: string }) => route.path)).size).toBe(manifest.routes.length);
  });
});
