import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const session = vi.hoisted(() => ({ require: vi.fn<() => Promise<{ externalSubject: string; viewKey: string }>>() }));
vi.mock('../src/server/require-web-session', () => ({ requireVerifiedWebSession: session.require }));
import StaffLayout from '../src/app/staff/layout';
import StaffInvoicesPage, { dynamic, metadata } from '../src/app/staff/billing/invoices/page';
import { InvoiceWorkbench } from '../src/components/invoice-workbench';
afterEach(() => vi.restoreAllMocks());
describe('protected dynamic human invoice route', () => {
  it('cannot render a staff child without the verified signed-session layout', async () => {
    const child = React.createElement('p', null, 'private');
    session.require.mockRejectedValueOnce(new Error('redirect:/auth/login'));
    await expect(StaffLayout({ children: child })).rejects.toThrow('redirect:/auth/login');
    session.require.mockResolvedValueOnce({ externalSubject: 'synthetic-staff', viewKey: 'k' }); expect((await StaffLayout({ children: child }) as React.ReactElement<{ children: unknown }>).props.children).toBe(child);
  });
  it('is dynamic/noindex, starts with no selectors or prefill and allocates no transport/key', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const allocate = vi.spyOn(crypto, 'randomUUID');
    const page = StaffInvoicesPage(); expect(page.type).toBe(InvoiceWorkbench); expect(page.props).toEqual({});
    expect(dynamic).toBe('force-dynamic'); expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(fetcher).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
    expect(readFileSync('src/app/staff/billing/invoices/page.tsx', 'utf8')).not.toMatch(/searchParams|initialScope|organizationId|schoolId|fetch\(|load[A-Z]|submitInvoiceCommand|prepareInvoice/);
  });
  it('declares only the exact new page once and no read/detail/payer/invoice-ID route', () => {
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    expect(Object.keys(manifest)).toEqual(['routes']);
    expect(manifest.routes.filter((route: { path: string }) => route.path.startsWith('/staff/billing/invoices'))).toEqual([{ path: '/staff/billing/invoices', title: 'HON | Human Invoice Workbench' }]);
    expect(new Set(manifest.routes.map((route: { path: string }) => route.path)).size).toBe(manifest.routes.length);
  });
});
