import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CrmLeadRegistrationWorkbench, registrationCurriculumEnrollmentHref } from '../src/components/crm-lead-registration-workbench';

const leadId = '33333333-3333-4333-8333-333333333333';

describe('direct-human CRM lead registration route', () => {
  it('renders an inert registration review with only an opaque prefill selector', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<CrmLeadRegistrationWorkbench initialLeadId={leadId} />);
      expect(fetcher).not.toHaveBeenCalled();
      expect(html).toContain('Register from an authorized CRM lead');
      expect(html).toContain(leadId);
      expect(html).toContain('Lead UUID selector');
      expect(html).toContain('There is no generic CRM/person/family directory or lead auto-load here.');
      expect(html).not.toContain('Load lead');
      expect(html).not.toContain('Send message');
      expect(html).not.toContain('Start enrollment');
      expect(html).not.toContain('Create membership');
    } finally {
      fetcher.mockRestore();
    }
  });

  it('keeps the dynamic noindex route under the shared staff session layout and declares it once', () => {
    const route = readFileSync('src/app/staff/crm/register/page.tsx', 'utf8');
    const layout = readFileSync('src/app/staff/layout.tsx', 'utf8');
    const source = readFileSync('src/components/crm-lead-registration-workbench.tsx', 'utf8');
    const list = readFileSync('src/components/crm-leads-workbench.tsx', 'utf8');
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: Array<{ path: string; title: string }> };
    expect(route).toContain("export const dynamic='force-dynamic'");
    expect(route).toContain('index:false');
    expect(route).toContain('follow:false');
    expect(route).toContain('initialLeadId');
    expect(route).not.toMatch(/fetch\(|loadCrmLead|loadCrmTrial|prepareCrmLeadRegistration/);
    expect(layout).toContain('await requireVerifiedWebSession()');
    expect(source).toContain('loadCurrentStaffReportingSchool');
    expect(source).toContain('loadStaffReportingSchools');
    expect(source).not.toMatch(/localStorage|sessionStorage|invokeLLM|executeAction|sendMessage|PaymentService|ProviderService|checkout/);
    expect(list).toContain('registrationHref(registrationSelected.id)');
    expect(list).toContain('carries only its untrusted lead UUID');
    expect(manifest.routes.filter(entry => entry.path === '/staff/crm/register')).toEqual([{ path: '/staff/crm/register', title: 'HON | Direct-human CRM registration review' }]);
  });

  it('offers only a selector-only separate curriculum preparation path after a registered receipt', () => {
    const href = registrationCurriculumEnrollmentHref(leadId);
    expect(href).toBe(`/staff/curriculum/enrollments?studentProfileId=${leadId}`);
    const query = new URL(`https://hon.test${href}`).searchParams;
    expect([...query.keys()]).toEqual(['studentProfileId']);
    expect(query.get('studentProfileId')).toBe(leadId);
    for (const invalid of ['', 'not-a-uuid', leadId.replace('-4', '-0')]) expect(registrationCurriculumEnrollmentHref(invalid)).toBeUndefined();
    const source = readFileSync('src/components/crm-lead-registration-workbench.tsx', 'utf8');
    expect(source).toContain("result?.result.outcome==='REGISTERED'");
    expect(source).toContain('Prepare separate human curriculum enrollment');
    expect(source).toContain("new URLSearchParams({studentProfileId:normalized})");
    expect(source).not.toMatch(/URLSearchParams\(\{[^}]*?(?:leadId|sourceContactPersonId|familyId|registrationPath|recordedAt|organizationId|schoolId)/);
  });
});
