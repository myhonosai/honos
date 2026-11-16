import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: 'en' } }), useOptionalLocale: () => null }));
import { NO_SCHOOL_SHELL, SchoolShellProvider, type SchoolShellState } from '../src/components/school-shell/context';
import { TeachingStudioWorkbench } from '../src/components/teaching-studio-workbench';
import { TeachingStudioUiError, loadTeachingAccess, teachingStudioPath } from '../src/components/teaching-studio-http';

const schoolId = '22222222-2222-4222-8222-222222222222';
const studentId = '44444444-4444-4444-8444-444444444444';
const ready: SchoolShellState = { ...NO_SCHOOL_SHELL, phase: 'READY', selection: { organizationId: '11111111-1111-4111-8111-111111111111', schoolId }, schoolName: 'Sunrise' };

describe('Teaching Studio UI', () => {
  it('uses fixed same-origin read paths and refuses invalid selectors', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ data: { canRead: true, canManageLessons: false, canManageResources: false, canRecordAssessments: false } }) } as Response);
    try {
      expect(teachingStudioPath.access(schoolId)).toBe(`/api/v1/staff/teaching-studio/access?schoolId=${schoolId}`);
      expect(teachingStudioPath.assessments(schoolId, studentId)).toBe(`/api/v1/staff/teaching-studio/students/${studentId}/assessments?schoolId=${schoolId}`);
      await expect(loadTeachingAccess(schoolId)).resolves.toMatchObject({ canRead: true });
      expect(fetchSpy).toHaveBeenCalledWith(teachingStudioPath.access(schoolId), expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' }));
      expect(() => teachingStudioPath.access('not-a-uuid')).toThrow();
    } finally { fetchSpy.mockRestore(); }
  });

  it('opens on the signed-in school with no ID boxes or policy text', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<SchoolShellProvider value={ready}><TeachingStudioWorkbench /></SchoolShellProvider>);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(html).toContain('Teaching studio');
      for (const text of ['UUID', 'Known selectors', 'never grant access', 'What this page never does', 'Known school and student', 'Load Teaching Studio', 'paired reference', 'Action Engine'])
        expect(html).not.toContain(text);
    } finally { fetchSpy.mockRestore(); }
  });

  it('picks students and target ranks by name and keeps the page free of record-ID inputs', () => {
    const component = readFileSync('src/components/teaching-studio-workbench.tsx', 'utf8');
    for (const text of ['StudentPicker', 'RankPicker', 'useShellSchool']) expect(component).toContain(text);
    for (const text of ['student profile UUID', 'curriculum UUID', 'rank UUID', 'TEACHING_STUDIO_HELP', 'Known target', 'Known student', 'never updates', 'No URL, attachment']) expect(component).not.toContain(text);
  });

  it('is a protected no-index human workbench with route manifest coverage and no provider or autonomous execution import', () => {
    const route = readFileSync('src/app/staff/teaching-studio/page.tsx', 'utf8');
    const component = readFileSync('src/components/teaching-studio-workbench.tsx', 'utf8');
    const http = readFileSync('src/components/teaching-studio-http.ts', 'utf8');
    for (const text of ['verifySession', "redirect('/auth/login')", 'index: false', 'follow: false', 'force-dynamic']) expect(route).toContain(text);
    expect(`${component}\n${http}`).not.toMatch(/invokeLLM|executeAction|sendMessage|from ['"].*provider/i);
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    expect(manifest.routes.filter((item: { path: string }) => item.path === '/staff/teaching-studio')).toHaveLength(1);
    expect(new TeachingStudioUiError('denied', 403).status).toBe(403);
  });
});
