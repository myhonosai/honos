import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const session = vi.hoisted(() => ({ require: vi.fn<() => Promise<{ externalSubject: string; viewKey: string }>>() }));
vi.mock('../src/server/require-web-session', () => ({ requireVerifiedWebSession: session.require }));
import StaffLayout from '../src/app/staff/layout';
import StaffPromotionDecisionPage, { dynamic, metadata } from '../src/app/staff/testing/promotion-decisions/page';
import { PromotionDecisionWorkbench } from '../src/components/promotion-decision-workbench';
afterEach(() => vi.restoreAllMocks());

describe('protected final human promotion-decision route', () => {
  it('inherits the existing fail-closed verified staff session boundary', async () => {
    const child = React.createElement('p', null, 'protected child'); session.require.mockRejectedValueOnce(new Error('redirect:/auth/login'));
    await expect(StaffLayout({ children: child })).rejects.toThrow('redirect:/auth/login'); session.require.mockResolvedValueOnce({ externalSubject: 'synthetic-staff', viewKey: 'k' }); expect((await StaffLayout({ children: child }) as React.ReactElement<{ children: unknown }>).props.children).toBe(child); expect(session.require).toHaveBeenCalledTimes(2);
  });
  it('is dynamic/noindex and blank with no route prefill, command, I/O or idempotency-key allocation', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const key = vi.spyOn(crypto, 'randomUUID');
    const page = StaffPromotionDecisionPage(); expect(page.type).toBe(PromotionDecisionWorkbench); expect(page.props).toEqual({});
    expect(dynamic).toBe('force-dynamic'); expect(metadata.robots).toEqual({ index: false, follow: false }); expect(fetcher).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
    expect(readFileSync('src/app/staff/testing/promotion-decisions/page.tsx', 'utf8')).not.toMatch(/searchParams|organizationId|schoolId|candidateId|fetch\(|submitPromotionDecision/);
  });
  it('declares the route once and keeps every source page route in the public manifest', () => {
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')); expect(Object.keys(manifest)).toEqual(['routes']);
    expect(manifest.routes.filter((r: { path: string }) => r.path === '/staff/testing/promotion-decisions')).toEqual([{ path: '/staff/testing/promotion-decisions', title: 'HON | Final Human Promotion Decision' }]);
    const paths: string[] = [];
    function walk(dir: string, segments: string[]): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== 'api') walk(join(dir, entry.name), entry.name.startsWith('(') ? segments : [...segments, entry.name.replace(/^\[(?:\.\.\.)?(.+)\]$/, ':$1')]);
        else if (entry.name === 'page.tsx') paths.push('/' + segments.join('/'));
      }
    }
    walk('src/app', []); const declared = manifest.routes.map((r: { path: string }) => r.path); expect(new Set(declared).size).toBe(declared.length); expect(declared.sort()).toEqual(paths.sort());
  });
});
