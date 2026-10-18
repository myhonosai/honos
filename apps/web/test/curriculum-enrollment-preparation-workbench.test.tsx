import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { CurriculumEnrollmentPreparationWorkbench } from '../src/components/curriculum-enrollment-preparation-workbench';

const studentId = '33333333-3333-4333-8333-333333333333';
afterEach(() => vi.restoreAllMocks());
describe('explicit curriculum enrollment preparation workbench', () => {
  it('keeps a valid CRM student selector inert at initial render and exposes no technical scope/curriculum/rank input', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const key = vi.spyOn(crypto, 'randomUUID');
    const html = renderToStaticMarkup(<CurriculumEnrollmentPreparationWorkbench initialStudentProfileId={studentId} />);
    expect(html).toContain('Load one verified student’s current-school enrollment choices explicitly'); expect(html).toContain(`value="${studentId}"`);
    expect(html).toContain('Load enrollment choices'); expect(html).not.toContain('Organization UUID'); expect(html).not.toContain('School UUID'); expect(html).not.toContain('Curriculum UUID'); expect(html).not.toContain('Current rank UUID');
    expect(fetcher).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
  });

  it('isolates preparation from authority, automatic I/O, billing, membership and provider paths', () => {
    const source = readFileSync('src/components/curriculum-enrollment-preparation-workbench.tsx', 'utf8'); const http = readFileSync('src/components/curriculum-enrollment-preparation-http.ts', 'utf8');
    expect(source).toContain('Load enrollment choices'); expect(source).not.toMatch(/localStorage|sessionStorage|setInterval|setTimeout|\/people|\/families|\/billing|\/payment|\/membership|invokeLLM|executeAction|sendMessage|providerClient/);
    expect(source.match(/crypto\.randomUUID\(\)/g)).toHaveLength(1); expect(source).toContain('loadCurriculumEnrollmentPreparation(nextScope, studentProfileId)');
    expect(http).toContain("method: 'POST'"); expect(http).toContain("'X-HON-Human-Command': 'curriculum-enrollment-preparation'"); expect(http).not.toContain('Idempotency-Key'); expect(http).not.toMatch(/method:\s*'GET'/);
  });
});
