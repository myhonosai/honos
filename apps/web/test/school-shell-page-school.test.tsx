import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: 'en' } }), useOptionalLocale: () => null }));
import { NO_SCHOOL_SHELL, SchoolShellProvider, type SchoolShellState } from '../src/components/school-shell/context';
import { ManualSchoolFields, useShellSchool } from '../src/components/school-shell/page-school';
import { AttendanceWorkbench } from '../src/components/attendance-workbench';
import { TeachingStudioWorkbench } from '../src/components/teaching-studio-workbench';
import { StaffRoleAdmin } from '../src/components/staff-role-admin';
import { ClassSessionsRead } from '../src/components/class-sessions-read';

const school = { organizationId: '11111111-1111-4111-8111-111111111111', schoolId: '22222222-2222-4222-8222-222222222222' };
const ready: SchoolShellState = { ...NO_SCHOOL_SHELL, phase: 'READY', selection: school, schoolName: 'Sunrise' };
const inShell = (node: React.ReactElement, value: SchoolShellState = ready) => renderToStaticMarkup(<SchoolShellProvider value={value}>{node}</SchoolShellProvider>);
const Probe = () => <p>{useShellSchool()?.schoolId ?? 'none'}<ManualSchoolFields><label>School UUID</label></ManualSchoolFields></p>;
const ID_BOX = /Organization UUID|School UUID|school UUID|school ID</;

describe('pages take the school from the shell', () => {
  it('exposes only a READY selection and hides the manual fields only then', () => {
    expect(inShell(<Probe />)).toBe(`<p>${school.schoolId}</p>`);
    for (const phase of ['IDLE', 'LOADING', 'CHOICE', 'CONCEALED', 'SESSION', 'DENIED'] as const)
      expect(inShell(<Probe />, { ...NO_SCHOOL_SHELL, phase, selection: phase === 'CONCEALED' ? null : school }), phase).toBe('<p>none<label>School UUID</label></p>');
  });

  it.each([['attendance', <AttendanceWorkbench />], ['teaching studio', <TeachingStudioWorkbench />], ['staff roles', <StaffRoleAdmin />], ['class sessions', <ClassSessionsRead />]] as const)(
    '%s shows no organization or school ID box inside the shell, and keeps them outside it', (_name, page) => {
      const fetcher = vi.spyOn(globalThis, 'fetch');
      expect(inShell(page)).not.toMatch(ID_BOX);
      expect(renderToStaticMarkup(page)).toMatch(ID_BOX);
      expect(fetcher).not.toHaveBeenCalled(); fetcher.mockRestore();
    });

  it('every school page that had school ID boxes now uses the shell school', () => {
    const pages = ['achievements-workbench', 'action-approvals-workbench', 'attendance-workbench', 'class-booking-workbench', 'class-session-workbench', 'class-sessions-read',
      'community-workbench', 'curriculum-progress-workbench', 'document-workbench', 'invoice-workbench', 'marketplace-workbench', 'promotion-decision-workbench',
      'promotion-readiness-workbench', 'retention-review-signals', 'revenue-planning-workbench', 'school-command-center', 'school-health-score', 'staff-dashboard',
      'staff-role-admin', 'teaching-studio-workbench', 'testing-candidate-grade-workbench', 'testing-candidate-registration-workbench', 'testing-certificate-workbench',
      'testing-scorecard-workbench', 'trial-appointment-workbench'];
    for (const page of pages) expect(readFileSync(`src/components/${page}.tsx`, 'utf8'), page).toContain('useShellSchoolInto(');
  });
});
