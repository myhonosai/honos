import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const session = vi.hoisted(() => ({ require: vi.fn<() => Promise<{ externalSubject: string; viewKey: string }>>() }));
vi.mock('../src/server/require-web-session', () => ({ requireVerifiedWebSession: session.require }));
import StaffLayout from '../src/app/staff/layout';
import StaffCurriculumProgressPage, { dynamic, metadata } from '../src/app/staff/curriculum/progress/page';
import { CurriculumProgressWorkbench } from '../src/components/curriculum-progress-workbench';
afterEach(() => vi.restoreAllMocks());
describe('protected human curriculum progress route', () => {
  it('inherits the fail-closed existing signed staff session boundary', async () => {
    const child = React.createElement('p', null, 'protected child');
    session.require.mockRejectedValueOnce(new Error('redirect:/auth/login'));
    await expect(StaffLayout({ children: child })).rejects.toThrow('redirect:/auth/login');
    session.require.mockResolvedValueOnce({ externalSubject: 'synthetic-staff', viewKey: 'k' }); expect((await StaffLayout({ children: child }) as React.ReactElement<{ children: unknown }>).props.children).toBe(child);
    expect(session.require).toHaveBeenCalledTimes(2);
  });
  it('is dynamic/noindex and sends no query, selector prefill, read or command on the route', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const key = vi.spyOn(crypto, 'randomUUID');
    const page = StaffCurriculumProgressPage(); expect(page.type).toBe(CurriculumProgressWorkbench); expect(page.props).toEqual({});
    expect(dynamic).toBe('force-dynamic'); expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(fetcher).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
    expect(readFileSync('src/app/staff/curriculum/progress/page.tsx', 'utf8')).not.toMatch(/searchParams|organizationId|schoolId|enrollmentId|fetch\(|loadCurriculumEnrollment|prepareCurriculumObservation/);
  });
  it('declares exactly the new page once and preserves all existing normalized page routes', () => {
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    expect(Object.keys(manifest)).toEqual(['routes']);
    expect(manifest.routes.filter((r: { path: string }) => r.path === '/staff/curriculum/progress')).toEqual([{ path: '/staff/curriculum/progress', title: 'HON | Human Curriculum Progress' }]);
    const paths: string[] = [];
    function walk(dir: string, segments: string[]): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== 'api') walk(join(dir, entry.name), entry.name.startsWith('(') ? segments : [...segments, entry.name.replace(/^\[(?:\.\.\.)?(.+)\]$/, ':$1')]);
        else if (entry.name === 'page.tsx') paths.push('/' + segments.join('/'));
      }
    }
    walk('src/app', []);
    const declared = manifest.routes.map((r: { path: string }) => r.path);
    expect(new Set(declared).size).toBe(declared.length); expect(declared.sort()).toEqual(paths.sort());
  });
});
