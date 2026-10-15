import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TeachingStudioWorkbench } from '../src/components/teaching-studio-workbench';
import { TeachingStudioUiError, loadTeachingAccess, teachingStudioPath } from '../src/components/teaching-studio-http';

const schoolId = '22222222-2222-4222-8222-222222222222';
const studentId = '44444444-4444-4444-8444-444444444444';

describe('Teaching Studio UI', () => {
  it('uses fixed same-origin known-ID read paths and refuses invalid selectors', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ data: { canRead: true, canManageLessons: false, canManageResources: false, canRecordAssessments: false } }) } as Response);
    try {
      expect(teachingStudioPath.access(schoolId)).toBe(`/api/v1/staff/teaching-studio/access?schoolId=${schoolId}`);
      expect(teachingStudioPath.assessments(schoolId, studentId)).toBe(`/api/v1/staff/teaching-studio/students/${studentId}/assessments?schoolId=${schoolId}`);
      await expect(loadTeachingAccess(schoolId)).resolves.toMatchObject({ canRead: true });
      expect(fetchSpy).toHaveBeenCalledWith(teachingStudioPath.access(schoolId), expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' }));
      expect(() => teachingStudioPath.access('not-a-uuid')).toThrow();
    } finally { fetchSpy.mockRestore(); }
  });

  it('starts honestly without any school data, directory, automatic progression, or provider interaction', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<TeachingStudioWorkbench />);
      expect(fetchSpy).not.toHaveBeenCalled();
      for (const text of ['No verified school is selected', 'Load Teaching Studio', 'Known selectors never grant access']) expect(html).toContain(text);
      expect(html).toContain('do not update student curriculum progress, testing, promotion, rank, attendance');
    } finally { fetchSpy.mockRestore(); }
  });

  it('is a protected no-index human workbench with route manifest coverage and no provider or autonomous execution import', () => {
    const route = readFileSync('src/app/staff/teaching-studio/page.tsx', 'utf8');
    const component = readFileSync('src/components/teaching-studio-workbench.tsx', 'utf8');
    const http = readFileSync('src/components/teaching-studio-http.ts', 'utf8');
    for (const text of ['verifySession', "redirect('/auth/login')", 'index: false', 'follow: false', 'force-dynamic']) expect(route).toContain(text);
    expect(component).toContain('TEACHING_STUDIO_HELP');
    expect(component).toContain('No URL, attachment, script, upload, external fetch, or provider content');
    expect(`${component}\n${http}`).not.toMatch(/invokeLLM|executeAction|sendMessage|from ['"].*provider/i);
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    expect(manifest.routes.filter((item: { path: string }) => item.path === '/staff/teaching-studio')).toHaveLength(1);
    expect(new TeachingStudioUiError('denied', 403).status).toBe(403);
  });
});
