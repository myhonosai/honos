import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const session = vi.hoisted(() => ({ require: vi.fn<() => Promise<void>>() }));
vi.mock('../src/server/require-web-session', () => ({ requireVerifiedWebSession: session.require }));
import StaffLayout from '../src/app/staff/layout';
import StaffCurriculumEnrollmentsPage, { dynamic, metadata } from '../src/app/staff/curriculum/enrollments/page';
import { CurriculumEnrollmentWorkbench } from '../src/components/curriculum-enrollment-workbench';

afterEach(() => vi.restoreAllMocks());
describe('protected curriculum enrollment route', () => {
  it('inherits staff protection and is dynamic/noindex with no prefill, I/O, or key allocation', async () => {
    const child = React.createElement('p', null, 'protected'); session.require.mockRejectedValueOnce(new Error('redirect:/auth/login'));
    await expect(StaffLayout({ children: child })).rejects.toThrow('redirect:/auth/login'); session.require.mockResolvedValueOnce(); expect(await StaffLayout({ children: child })).toBe(child);
    const fetcher = vi.spyOn(globalThis, 'fetch'); const key = vi.spyOn(crypto, 'randomUUID'); const page = StaffCurriculumEnrollmentsPage();
    expect(page.type).toBe(CurriculumEnrollmentWorkbench); expect(page.props).toEqual({}); expect(dynamic).toBe('force-dynamic'); expect(metadata.robots).toEqual({ index: false, follow: false }); expect(fetcher).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
    expect(readFileSync('src/app/staff/curriculum/enrollments/page.tsx', 'utf8')).not.toMatch(/searchParams|fetch\(|organizationId|schoolId|curriculumId|studentProfileId|prepareCurriculumEnrollment/);
  });
  it('declares the route once and keeps source page routes synchronized in the manifest', () => {
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')); expect(manifest.routes.filter((route: { path: string }) => route.path === '/staff/curriculum/enrollments')).toEqual([{ path: '/staff/curriculum/enrollments', title: 'HON | Human Curriculum Enrollment' }]);
    const paths: string[] = [];
    function walk(dir: string, segments: string[]): void { for (const entry of readdirSync(dir, { withFileTypes: true })) { if (entry.isDirectory() && entry.name !== 'api') walk(join(dir, entry.name), entry.name.startsWith('(') ? segments : [...segments, entry.name.replace(/^\[(?:\.\.\.)?(.+)\]$/, ':$1')]); else if (entry.name === 'page.tsx') paths.push('/' + segments.join('/')); } }
    walk('src/app', []); expect(new Set(manifest.routes.map((route: { path: string }) => route.path)).size).toBe(manifest.routes.length); expect(manifest.routes.map((route: { path: string }) => route.path).sort()).toEqual(paths.sort());
  });
});
