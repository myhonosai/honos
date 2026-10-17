import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const session = vi.hoisted(() => ({ require: vi.fn<() => Promise<void>>() }));
vi.mock('../src/server/require-web-session', () => ({ requireVerifiedWebSession: session.require }));
import StaffLayout from '../src/app/staff/layout';
import StaffTestingCandidateGradePage, { dynamic, metadata } from '../src/app/staff/testing/candidates/grade/page';
import { TestingCandidateGradeWorkbench } from '../src/components/testing-candidate-grade-workbench';
afterEach(() => vi.restoreAllMocks());
describe('protected human candidate outcome route', () => {
  it('inherits the existing fail-closed verified staff session boundary', async () => {
    const child = React.createElement('p', null, 'protected child'); session.require.mockRejectedValueOnce(new Error('redirect:/auth/login'));
    await expect(StaffLayout({ children: child })).rejects.toThrow('redirect:/auth/login'); session.require.mockResolvedValueOnce(); expect(await StaffLayout({ children: child })).toBe(child); expect(session.require).toHaveBeenCalledTimes(2);
  });
  it('is dynamic/noindex with no route prefill, query props, automatic command or key allocation', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const key = vi.spyOn(crypto, 'randomUUID');
    const page = StaffTestingCandidateGradePage(); expect(page.type).toBe(TestingCandidateGradeWorkbench); expect(page.props).toEqual({});
    expect(dynamic).toBe('force-dynamic'); expect(metadata.robots).toEqual({ index: false, follow: false }); expect(fetcher).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
    expect(readFileSync('src/app/staff/testing/candidates/grade/page.tsx', 'utf8')).not.toMatch(/searchParams|organizationId|schoolId|candidateId|fetch\(|submitTestingCandidateGrade/);
  });
  it('declares exactly one new page and keeps every existing source page route in the manifest', () => {
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')); expect(Object.keys(manifest)).toEqual(['routes']);
    expect(manifest.routes.filter((r: { path: string }) => r.path === '/staff/testing/candidates/grade')).toEqual([{ path: '/staff/testing/candidates/grade', title: 'HON | Human Testing Candidate Outcome' }]);
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
