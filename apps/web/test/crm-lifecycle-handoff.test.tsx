import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { crmFollowUpHref, crmFollowUpLeadId, terminalTrialFollowUpHref } from '../src/components/crm-follow-up-handoff';
import { CrmFollowUpsWorkbench } from '../src/components/crm-follow-ups-workbench';
import { loadFollowUps } from '../src/components/crm-follow-ups-http';

const leadId = '11111111-1111-4111-8111-111111111111';
const organizationId = '22222222-2222-4222-8222-222222222222';

function terminalReceipt(status: 'COMPLETED' | 'NO_SHOW' | 'CANCELLED' | 'SCHEDULED') {
  return { crmLeadId: leadId, status };
}

describe('bounded CRM lifecycle handoff', () => {
  it('builds a lead-row link with only one valid leadId query value', () => {
    const href = crmFollowUpHref(leadId);
    expect(href).toBe(`/staff/crm/follow-ups?leadId=${leadId}`);
    const parsed = new URL(href!, 'https://hon.test');
    expect([...parsed.searchParams.keys()]).toEqual(['leadId']);
    expect(parsed.searchParams.get('leadId')).toBe(leadId);
    expect(parsed.searchParams.toString()).not.toContain(organizationId);
    expect(crmFollowUpHref('not-a-uuid')).toBeUndefined();

    const source = readFileSync('src/components/crm-leads-workbench.tsx', 'utf8');
    expect(source).toContain('crmFollowUpHref(lead.id)');
    expect(source).not.toContain('/staff/crm/follow-ups?organizationId=');
  });

  it('offers the same link only from a current terminal trial receipt, never SCHEDULED', () => {
    for (const status of ['COMPLETED', 'NO_SHOW', 'CANCELLED'] as const) {
      expect(terminalTrialFollowUpHref(terminalReceipt(status))).toBe(`/staff/crm/follow-ups?leadId=${leadId}`);
    }
    expect(terminalTrialFollowUpHref(terminalReceipt('SCHEDULED'))).toBeUndefined();
    expect(terminalTrialFollowUpHref({ crmLeadId: 'bad', status: 'COMPLETED' })).toBeUndefined();

    const source = readFileSync('src/components/trial-appointment-workbench.tsx', 'utf8');
    expect(source).toContain('terminalTrialFollowUpHref(appointment)');
    expect(source).toContain('appointment ? terminalTrialFollowUpHref(appointment) : undefined');
  });

  it('keeps a valid follow-up prefill idle and out of the form until an explicit queue load', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<CrmFollowUpsWorkbench initialLeadId={leadId} />);
      expect(fetcher).not.toHaveBeenCalled();
      expect(html).toContain('Load / refresh queue');
      expect(html).not.toContain(leadId);
      expect(html).not.toContain('Create follow-up record');
    } finally { fetcher.mockRestore(); }

    const source = readFileSync('src/components/crm-follow-ups-workbench.tsx', 'utf8');
    expect(source).toContain("const prefilledLeadId = after === null ? pendingLeadId.current : ''; pendingLeadId.current='';");
    expect(source).toContain('const c = await loadFollowUps(queue,status,after); setContext(c); setDraft(initial(c.principalId,prefilledLeadId));');
    expect(source).toContain("pendingLeadId.current='';setQueue");
    expect(source).toContain("pendingLeadId.current='';setStatus");
  });

  it('ignores malformed query input and still requires the existing explicit authorized queue read', async () => {
    for (const value of [undefined, 'bad', `${leadId}?status=OPEN`, [leadId], `${leadId}x`]) {
      expect(crmFollowUpLeadId(value)).toBeUndefined();
    }
    expect(crmFollowUpLeadId(leadId)).toBe(leadId);

    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 403, json: async () => ({ detail: 'DENIED' }) } as Response);
    try {
      await expect(loadFollowUps('mine', 'OPEN')).rejects.toThrow('Current exact school permission');
      expect(fetcher).toHaveBeenCalledWith('/api/v1/staff/crm/follow-ups?queue=mine&status=OPEN', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
    } finally { fetcher.mockRestore(); }
  });

  it('retains only normal anchors and no client persistence, lead lookup, automation, message, provider, or action capability', () => {
    const handoff = readFileSync('src/components/crm-follow-up-handoff.ts', 'utf8');
    const followUps = readFileSync('src/components/crm-follow-ups-workbench.tsx', 'utf8');
    const route = readFileSync('src/app/staff/crm/follow-ups/page.tsx', 'utf8');
    expect(handoff).toContain('new URLSearchParams({ leadId: verifiedLeadId })');
    expect(handoff).not.toMatch(/fetch\(|localStorage|sessionStorage|invokeLLM|sendMessage|executeAction|automation/i);
    expect(followUps).not.toMatch(/localStorage|sessionStorage|setInterval|setTimeout|readLead|invokeLLM|sendMessage|executeAction|automation/i);
    expect(route).toContain("dynamic = 'force-dynamic'");
    expect(route).toContain('crmFollowUpLeadId(query.leadId)');
    expect(route).not.toMatch(/fetch\(|localStorage|sessionStorage/);
  });
});
