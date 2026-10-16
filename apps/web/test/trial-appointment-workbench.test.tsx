import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { TrialAppointmentWorkbench } from '../src/components/trial-appointment-workbench';
import { recordTrialOutcome, scheduleTrial, trialOutcomePath, trialSchedulePath } from '../src/components/trial-appointment-http';

const organizationId = '11111111-1111-4111-8111-111111111111';
const schoolId = '22222222-2222-4222-8222-222222222222';
const leadId = '33333333-3333-4333-8333-333333333333';
const appointmentId = '44444444-4444-4444-8444-444444444444';
const principalId = '55555555-5555-4555-8555-555555555555';
const scheduled = { id: appointmentId, crmLeadId: leadId, appointmentType: 'TRIAL', status: 'SCHEDULED', startsAt: '2027-02-03T09:00:00.000Z', endsAt: '2027-02-03T10:00:00.000Z', location: 'Studio A', notes: 'Private preparation', createdByPrincipalId: principalId, version: 1, createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z' } as const;
const response = (data: unknown) => ({ ok: true, status: 201, json: async () => ({ data, meta: {} }) }) as Response;

describe('human trial appointment workbench', () => {
  it('starts without a request, fabricated trial receipt, delivery, or outcome controls', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<TrialAppointmentWorkbench />);
      expect(fetcher).not.toHaveBeenCalled();
      expect(html).toContain('Schedule and record a trial');
      expect(html).toContain('Appointment facts only.');
      expect(html).not.toContain('Current command receipt');
      expect(html).not.toContain('calendar invitation');
      expect(html).not.toContain('Record final outcome');
    } finally { fetcher.mockRestore(); }
  });

  it('uses only exact same-origin human commands and rejects false scheduling receipts', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(scheduled));
    const input = { startsAt: scheduled.startsAt, endsAt: scheduled.endsAt, location: 'Studio A', notes: 'Private preparation' };
    try {
      expect(await scheduleTrial(organizationId, schoolId, leadId, input, appointmentId)).toEqual(scheduled);
      expect(fetcher).toHaveBeenCalledWith(trialSchedulePath(organizationId, schoolId, leadId), expect.objectContaining({ method: 'POST', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', headers: expect.objectContaining({ 'Idempotency-Key': appointmentId, 'X-HON-Human-Command': 'crm-trial-appointment' }) }));
      for (const patch of [{ status: 'COMPLETED' }, { appointmentType: 'CONSULTATION' }, { crmLeadId: organizationId }, { startsAt: '2027-02-03T09:01:00.000Z' }, { endsAt: '2027-02-03T10:01:00.000Z' }, { version: 2 }, { membershipId: organizationId }, { calendarDelivery: 'SENT' }]) {
        fetcher.mockResolvedValue(response({ ...scheduled, ...patch }));
        await expect(scheduleTrial(organizationId, schoolId, leadId, input, appointmentId)).rejects.toThrow('Unverified trial appointment result');
      }
      for (const value of ['https://evil.test', 'bad']) expect(() => trialSchedulePath(value, schoolId, leadId)).toThrow();
    } finally { fetcher.mockRestore(); }
  });

  it('records a final outcome only against the exact current scheduled receipt and never treats it as conversion', async () => {
    const completed = { ...scheduled, status: 'COMPLETED', version: 2, updatedAt: '2027-02-03T11:00:00.000Z' } as const;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(completed));
    try {
      expect(await recordTrialOutcome(organizationId, schoolId, scheduled, { status: 'COMPLETED', expectedVersion: 1, outcomeNotes: 'Human observation' }, principalId)).toEqual(completed);
      expect(fetcher).toHaveBeenCalledWith(trialOutcomePath(organizationId, schoolId, appointmentId), expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'Idempotency-Key': principalId }) }));
      for (const patch of [{ version: 3 }, { status: 'SCHEDULED' }, { crmLeadId: organizationId }, { enrollmentId: organizationId }]) {
        fetcher.mockResolvedValue(response({ ...completed, ...patch }));
        await expect(recordTrialOutcome(organizationId, schoolId, scheduled, { status: 'COMPLETED', expectedVersion: 1 }, principalId)).rejects.toThrow('Unverified trial appointment result');
      }
      expect(() => trialOutcomePath(organizationId, schoolId, 'bad')).toThrow();
    } finally { fetcher.mockRestore(); }
  });

  it('registers a bounded staff route and retains no automation or browser persistence capability', () => {
    const source = readFileSync('src/components/trial-appointment-workbench.tsx', 'utf8');
    const route = readFileSync('src/app/staff/crm/trials/page.tsx', 'utf8');
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    expect(source).toContain('Retry exact retained request');
    expect(source).toContain('immediately verified scheduled receipt');
    expect(source).not.toMatch(/localStorage|sessionStorage|setInterval|invokeLLM|sendMessage|executeAction|calendarDelivery/);
    expect(route).toContain('TrialAppointmentWorkbench');
    expect(manifest.routes.filter((entry: { path: string }) => entry.path === '/staff/crm/trials')).toHaveLength(1);
  });
});
