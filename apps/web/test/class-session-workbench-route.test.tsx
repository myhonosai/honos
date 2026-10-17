import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const session = vi.hoisted(() => ({ require: vi.fn<() => Promise<void>>() }));
vi.mock('../src/server/require-web-session', () => ({ requireVerifiedWebSession: session.require }));
import StaffLayout from '../src/app/staff/layout';
import StaffClassSessionCreatePage, { dynamic, metadata } from '../src/app/staff/schedule/sessions/create/page';
import { ClassSessionWorkbench } from '../src/components/class-session-workbench';
afterEach(() => vi.restoreAllMocks());

describe('protected staff class-session creation page', () => {
  it('inherits the fail-closed staff session layout before the workbench can render', async () => {
    const child = React.createElement('p', null, 'protected child');
    session.require.mockRejectedValueOnce(new Error('redirect:/auth/login'));
    await expect(StaffLayout({ children: child })).rejects.toThrow('redirect:/auth/login');
    session.require.mockResolvedValueOnce(); expect(await StaffLayout({ children: child })).toBe(child);
  });
  it('is dynamic/noindex, renders only the idle workbench, and has no selector/prefill/auto command', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const key = vi.spyOn(crypto, 'randomUUID');
    const page = StaffClassSessionCreatePage(); expect(page.type).toBe(ClassSessionWorkbench); expect(page.props).toEqual({});
    expect(dynamic).toBe('force-dynamic'); expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(fetcher).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
    const source = readFileSync('src/app/staff/schedule/sessions/create/page.tsx', 'utf8');
    expect(source).not.toMatch(/searchParams|initialScope|organizationId|schoolId|programId|fetch\(|load[A-Z]|submitClassSession|prepareClassSession/);
  });
  it('declares the exact route once in the static route manifest', () => {
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    expect(Object.keys(manifest)).toEqual(['routes']);
    expect(manifest.routes.filter((route: { path: string }) => route.path === '/staff/schedule/sessions/create')).toEqual([{ path: '/staff/schedule/sessions/create', title: 'HON | Human Class-session Creation' }]);
    expect(new Set(manifest.routes.map((route: { path: string }) => route.path)).size).toBe(manifest.routes.length);
  });
});
