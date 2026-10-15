import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { ParentTestingRegistration } from '../src/components/parent-testing-registration';
import { StaffTestingRegistrationWorkbench } from '../src/components/staff-testing-registration-workbench';
import { loadParentTestingRegistrations, loadStaffTestingRegistrations, reviewStaffTestingRegistration, submitParentTestingInterest, TestingRegistrationAccessError } from '../src/components/testing-registration-http';
import { verifyParentTestingRegistrationView } from '@hon/contracts';
const [childId, eventId, interestId] = ['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'] as const;
const iso = '2026-11-01T10:00:00.000Z';
const parent = { children: [{ studentProfileId: childId, displayName: 'Authorized Child' }], events: [{ testingEventId: eventId, name: 'Existing open test', startsAt: iso, endsAt: null }], registrations: [{ childName: 'Authorized Child', eventName: 'Existing open test', startsAt: iso, status: 'SUBMITTED', submittedAt: iso, reviewedAt: null }] } as const;
const staff = { registrations: [{ id: interestId, childName: 'Authorized Child', eventName: 'Existing open test', startsAt: iso, status: 'SUBMITTED', parentNote: 'Please review', submittedAt: iso, reviewedAt: null, version: 1 }], limited: false } as const;
const response = (data: unknown) => Response.json({ data, meta: { requestId: childId, correlationId: childId } });
describe('human testing registration UI', () => {
  it('uses only fixed same-origin endpoints with a direct human marker and retained idempotency keys', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(parent));
    try {
      await expect(loadParentTestingRegistrations()).resolves.toEqual(parent);
      expect(fetcher).toHaveBeenLastCalledWith('/api/v1/parent/testing', expect.objectContaining({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' }));
      fetcher.mockResolvedValue(response({ status: 'SUBMITTED', submittedAt: iso, version: 1 }));
      await expect(submitParentTestingInterest({ studentProfileId: childId, testingEventId: eventId, note: 'Please review' }, 'parent-key')).resolves.toEqual({ status: 'SUBMITTED', submittedAt: iso, version: 1 });
      expect(fetcher).toHaveBeenLastCalledWith('/api/v1/parent/testing/interests', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'X-HON-Human-Command': 'testing-registration', 'Idempotency-Key': 'parent-key' }) }));
      fetcher.mockResolvedValue(response(staff)); await expect(loadStaffTestingRegistrations()).resolves.toEqual(staff);
      fetcher.mockResolvedValue(response({ id: interestId, status: 'WAITLISTED', reviewedAt: iso, version: 2 }));
      await expect(reviewStaffTestingRegistration(interestId, { decision: 'WAITLIST', expectedVersion: 1 }, 'staff-key')).resolves.toMatchObject({ status: 'WAITLISTED' });
      expect(fetcher).toHaveBeenLastCalledWith(`/api/v1/staff/testing/registrations/${interestId}/decision`, expect.objectContaining({ method: 'POST', credentials: 'same-origin', headers: expect.objectContaining({ 'Idempotency-Key': 'staff-key' }) }));
    } finally { fetcher.mockRestore(); }
  });
  it('strictly rejects parent data that leaks family/staff/rank/eligibility/candidate/payment or an invalid status lifecycle', () => {
    for (const patch of [{ familyId: interestId }, { principalId: interestId }, { reviewer: 'private' }, { eligibility: 'yes' }, { candidateId: interestId }, { payment: 'private' }, { registrations: [{ ...parent.registrations[0], status: 'ACCEPTED', reviewedAt: null }] }]) expect(() => verifyParentTestingRegistrationView({ ...parent, ...patch })).toThrow();
  });
  it('clears sensitive views on access loss and renders no fabricated event, eligibility, payment, roster, message, AI or action controls during SSR', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const family = renderToStaticMarkup(<ParentTestingRegistration/>), queue = renderToStaticMarkup(<StaffTestingRegistrationWorkbench/>);
      expect(fetcher).not.toHaveBeenCalled();
      for (const text of ['Share interest. Your instructors decide.', 'No automatic decision or payment.', 'Queue remains hidden until verified', 'Decision, not admission.']) expect(family + queue).toContain(text);
      expect(family + queue).not.toMatch(/credit card|checkout|send message|invokeLLM|executeAction|candidate roster/i);
    } finally { fetcher.mockRestore(); }
    const failed = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 403 } as Response);
    try { await expect(loadParentTestingRegistrations()).rejects.toBeInstanceOf(TestingRegistrationAccessError); } finally { failed.mockRestore(); }
  });
  it('auth-protects both pages and keeps the parent status display redacted from staff review detail', () => {
    const parentRoute = readFileSync('src/app/parent/testing/page.tsx', 'utf8'), staffRoute = readFileSync('src/app/staff/testing/registrations/page.tsx', 'utf8');
    for (const route of [parentRoute, staffRoute]) for (const token of ['verifySession', "redirect('/auth/login')", 'force-dynamic', 'index: false']) expect(route).toContain(token);
    const component = readFileSync('src/components/parent-testing-registration.tsx', 'utf8'), http = readFileSync('src/components/testing-registration-http.ts', 'utf8');
    expect(component).not.toMatch(/\.parentNote|\.reviewer|candidateId|familyId|principalId/); expect(http).not.toMatch(/fetch\(['"]https?:\/\/|invokeLLM|executeAction|sendMessage|checkout|payment/i);
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')); expect(manifest.routes.filter((r: { path: string }) => r.path === '/parent/testing')).toHaveLength(1); expect(manifest.routes.filter((r: { path: string }) => r.path === '/staff/testing/registrations')).toHaveLength(1);
  });
});
