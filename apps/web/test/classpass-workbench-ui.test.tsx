import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ClassPassWorkbench } from '../src/components/classpass-workbench';

const organizationId = '10000000-0000-4000-8000-000000000001';
const schoolId = '10000000-0000-4000-8000-000000000002';

describe('ClassPass verified-scope handoff', () => {
  it('uses prefilled selectors only and performs no automatic record read or command', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<ClassPassWorkbench initialScope={{ organizationId, schoolId }} />);
      expect(html).toContain(`value="${organizationId}"`);
      expect(html).toContain(`value="${schoolId}"`);
      expect(html).toContain('no record or command runs until a direct human selects an operation');
      expect(html).not.toContain('ADMITTED_REDEEMED');
      expect(fetcher).not.toHaveBeenCalled();
    } finally { fetcher.mockRestore(); }
  });

  it('keeps URL prefill bounded to the existing guarded route and direct-human transport', () => {
    const workbench = readFileSync('src/components/classpass-workbench.tsx', 'utf8');
    const route = readFileSync('src/app/staff/classpass/page.tsx', 'utf8');
    const dashboard = readFileSync('src/components/staff-dashboard.tsx', 'utf8');
    const commandCenter = readFileSync('src/components/school-command-center.tsx', 'utf8');
    expect(workbench).toContain('initialScope');
    expect(workbench).not.toMatch(/useEffect|fetch\(|localStorage|sessionStorage|invokeLLM|executeAction/);
    expect(route).toContain("dynamic = 'force-dynamic'");
    expect(route).toContain('ClassPassWorkbenchEntry');
    expect(route).not.toContain('searchParams');
    expect(route).not.toContain('verifySession');
    expect(dashboard).toContain("return '/staff/classpass';");
    expect(commandCenter).toContain("return '/staff/classpass';");
  });

  it('opens on the signed-in school with no school ID fields', () => {
    const html = renderToStaticMarkup(<ClassPassWorkbench shellScope={{ organizationId, schoolId }} />);
    expect(html).toContain('This uses the school you are signed in to.');
    expect(html).not.toContain(organizationId); expect(html).not.toContain(schoolId);
    expect(html).not.toContain('>organizationId<'); expect(html).not.toContain('>schoolId<');
    expect(renderToStaticMarkup(<ClassPassWorkbench shellScope={null} />)).toContain('Choose your school at the top of the page first.');
  });
});
