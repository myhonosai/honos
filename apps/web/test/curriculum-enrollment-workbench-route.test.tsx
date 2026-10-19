import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const session = vi.hoisted(() => ({ require: vi.fn<() => Promise<void>>() }));
vi.mock('../src/server/require-web-session', () => ({ requireVerifiedWebSession: session.require }));
import StaffLayout from '../src/app/staff/layout';
import StaffCurriculumEnrollmentsPage, { dynamic, metadata } from '../src/app/staff/curriculum/enrollments/page';
import { CurriculumEnrollmentPreparationWorkbench } from '../src/components/curriculum-enrollment-preparation-workbench';

afterEach(() => vi.restoreAllMocks());
describe('protected curriculum enrollment route', () => {
  it('inherits staff protection and accepts only one inert student-profile selector', async () => {
    const child = React.createElement('p', null, 'protected'); session.require.mockRejectedValueOnce(new Error('redirect:/auth/login'));
    await expect(StaffLayout({ children: child })).rejects.toThrow('redirect:/auth/login'); session.require.mockResolvedValueOnce(); expect(await StaffLayout({ children: child })).toBe(child);
    const studentProfileId = '44444444-4444-4444-8444-444444444444'; const fetcher = vi.spyOn(globalThis, 'fetch'); const key = vi.spyOn(crypto, 'randomUUID');
    const page = await StaffCurriculumEnrollmentsPage({ searchParams: Promise.resolve({ studentProfileId }) });
    expect(page.type).toBe(CurriculumEnrollmentPreparationWorkbench); expect(page.props).toEqual({ initialStudentProfileId: studentProfileId }); expect(dynamic).toBe('force-dynamic'); expect(metadata.robots).toEqual({ index: false, follow: false }); expect(fetcher).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
    for (const value of [undefined, '', 'not-a-uuid', '44444444-4444-0444-8444-444444444444', [studentProfileId], [studentProfileId, '55555555-5555-4555-8555-555555555555']]) {
      const params = value === undefined ? {} : { studentProfileId: value as string | string[] };
      const empty = await StaffCurriculumEnrollmentsPage({ searchParams: Promise.resolve(params) });
      expect(empty.props).toEqual({});
    }
    const different = await StaffCurriculumEnrollmentsPage({ searchParams: Promise.resolve({ studentProfileId: '55555555-5555-4555-8555-555555555555' }) });
    expect(different.props).toEqual({ initialStudentProfileId: '55555555-5555-4555-8555-555555555555' });
    const route = readFileSync('src/app/staff/curriculum/enrollments/page.tsx', 'utf8');
    expect(route).toContain('normalizeInitialStudentProfileId'); expect(route).toContain("key={initialStudentProfileId ?? 'empty'}"); expect(route).not.toMatch(/fetch\(|loadCurrent|loadCurriculumEnrollmentPreparation|prepareCurriculumEnrollment|organizationId|schoolId|curriculumId|currentRankId/);
  });
  it('declares the route once and keeps source page routes synchronized in the manifest', () => {
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')); expect(manifest.routes.filter((route: { path: string }) => route.path === '/staff/curriculum/enrollments')).toEqual([{ path: '/staff/curriculum/enrollments', title: 'HON | Human Curriculum Enrollment' }]);
    const paths: string[] = [];
    function walk(dir: string, segments: string[]): void { for (const entry of readdirSync(dir, { withFileTypes: true })) { if (entry.isDirectory() && entry.name !== 'api') walk(join(dir, entry.name), entry.name.startsWith('(') ? segments : [...segments, entry.name.replace(/^\[(?:\.\.\.)?(.+)\]$/, ':$1')]); else if (entry.name === 'page.tsx') paths.push('/' + segments.join('/')); } }
    walk('src/app', []); expect(new Set(manifest.routes.map((route: { path: string }) => route.path)).size).toBe(manifest.routes.length); expect(manifest.routes.map((route: { path: string }) => route.path).sort()).toEqual(paths.sort());
  });
});
