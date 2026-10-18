import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CrmLeadsWorkbench } from '../src/components/crm-leads-workbench';
import { crmLeadListPath, loadCrmLeads } from '../src/components/crm-leads-http';

const organizationId = '11111111-1111-4111-8111-111111111111';
const schoolId = '22222222-2222-4222-8222-222222222222';
const leadId = '33333333-3333-4333-8333-333333333333';
const personId = '44444444-4444-4444-8444-444444444444';
const row = { id: leadId, status: 'OPEN', pipelineStageId: organizationId, primaryPersonId: personId, version: 1, createdAt: '2026-10-16T00:00:00.000Z', givenName: 'Ari', familyName: 'Stone', email: null, phoneE164: null, nextFollowUpAt: null } as const;
const response = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data, meta: {} }) }) as Response;

describe('bounded conventional CRM lead list', () => {
  it('starts empty without fetching, a lead receipt, or a contact action', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<CrmLeadsWorkbench />);
      expect(fetcher).not.toHaveBeenCalled();
      expect(html).toContain('Current school CRM leads');
      expect(html).toContain('No verified school list is loaded.');
      expect(html).not.toContain('Ari Stone');
      expect(html).not.toContain('Send message');
      expect(html).not.toContain('Record trial appointment');
    } finally { fetcher.mockRestore(); }
  });

  it('exposes dedicated trigger-only automation tabs without a CRM fact handoff', () => {
    const source = readFileSync('src/components/crm-leads-workbench.tsx', 'utf8');
    const automationTabs = source.slice(source.indexOf('crm-lead-automation'), source.indexOf('crm-lead-scope'));
    expect(automationTabs).toContain('CRM automation tabs');
    expect(automationTabs).toContain('href="/staff/automation/rules?trigger=LEAD_CREATED"');
    expect(automationTabs).toContain('href="/staff/automation/rules?trigger=TRIAL_NO_SHOW"');
    expect(automationTabs).toContain('Lead automation');
    expect(automationTabs).toContain('No-show automation');
    expect([...automationTabs.matchAll(/href="([^"]+)"/g)].map((match) => match[1])).toEqual([
      '/staff/automation/rules?trigger=LEAD_CREATED',
      '/staff/automation/rules?trigger=TRIAL_NO_SHOW'
    ]);
  });

  it('keeps URL scope prefill inert and never exposes its UUIDs or performs an automatic CRM list read or command', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<CrmLeadsWorkbench initialScope={{ organizationId, schoolId }} />);
      expect(html).not.toContain(organizationId);
      expect(html).not.toContain(schoolId);
      expect(html).not.toContain('Organization UUID');
      expect(html).not.toContain('School UUID');
      expect(html).toContain('No verified school list is loaded.');
      expect(fetcher).not.toHaveBeenCalled();
    } finally { fetcher.mockRestore(); }
  });

  it('clears scope and configured intake stages when inactive, then requires a fresh reporting-school resolution on return', () => {
    const source = readFileSync('src/components/crm-leads-workbench.tsx', 'utf8');
    expect(source).toContain('scopeEpoch.current++; resolverRead.current = null; selectorRead.current = null; clearList(); setScope(null);');
    expect(source).toContain("setScopeState('RESOLVING')");
    expect(source).toContain("window.addEventListener('blur', leave)");
    expect(source).toContain("window.addEventListener('focus', resume)");
    expect(source).toContain("document.addEventListener('visibilitychange', visibility)");
    expect(source).toContain('setScopeReload(value => value + 1)');
    expect(source).toContain('}, [scopeReload]);');
  });

  it('uses the existing fixed same-origin list route and rejects extended, duplicate, or malformed lead projections', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response([row]));
    try {
      expect(await loadCrmLeads(organizationId, schoolId, 'OPEN')).toEqual([{ ...row, email: undefined, phoneE164: undefined, nextFollowUpAt: undefined }]);
      expect(fetcher).toHaveBeenCalledWith(crmLeadListPath(organizationId, schoolId, 'OPEN'), expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' }));
      for (const patch of [{ secret: 'extra' }, { status: 'SCHEDULED' }, { id: 'bad' }, { email: ' ' }, { nextFollowUpAt: 'not-time' }]) {
        fetcher.mockResolvedValue(response([{ ...row, ...patch }]));
        await expect(loadCrmLeads(organizationId, schoolId, 'OPEN')).rejects.toThrow('Unverified CRM lead list');
      }
      fetcher.mockResolvedValue(response([row, row]));
      await expect(loadCrmLeads(organizationId, schoolId, 'OPEN')).rejects.toThrow('Unverified CRM lead list');
      for (const value of ['bad', 'https://evil.test']) expect(() => crmLeadListPath(value, schoolId, 'OPEN')).toThrow();
    } finally { fetcher.mockRestore(); }
  });

  it('keeps the trial handoff as untrusted selector prefill with no automatic command', () => {
    const source = readFileSync('src/components/crm-leads-workbench.tsx', 'utf8');
    const trial = readFileSync('src/components/trial-appointment-workbench.tsx', 'utf8');
    const trialRoute = readFileSync('src/app/staff/crm/trials/page.tsx', 'utf8');
    const leadRoute = readFileSync('src/app/staff/crm/leads/page.tsx', 'utf8');
    const dashboard = readFileSync('src/components/staff-dashboard.tsx', 'utf8');
    const commandCenter = readFileSync('src/components/school-command-center.tsx', 'utf8');
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    expect(source).toContain('Prepare trial appointment');
    expect(source).toContain('does not load or create an appointment');
    expect(source).not.toMatch(/localStorage|sessionStorage|invokeLLM|sendMessage|executeAction|fetch\(/);
    expect(trial).toContain('initialScope');
    expect(trialRoute).toContain("dynamic = 'force-dynamic'");
    expect(trialRoute).toContain('initialScope');
    expect(leadRoute).toContain("dynamic = 'force-dynamic'");
    expect(leadRoute).toContain('initialScope');
    expect(dashboard).toContain('crmScopeHref');
    expect(commandCenter).toContain('crmScopeHref');
    expect(manifest.routes.filter((entry: { path: string }) => entry.path === '/staff/crm/leads')).toHaveLength(1);
  });
});
