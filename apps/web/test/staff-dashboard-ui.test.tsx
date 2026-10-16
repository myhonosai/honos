import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { OwnerLaunchSavedStudentsProjection } from '@hon/contracts';
import { bookingForVerifiedDashboard, FirstClassBookingConfirmation, StaffDashboard } from '../src/components/staff-dashboard';
import { loadOwnerLaunchSavedStudents, loadStaffDashboard, ownerLaunchSavedStudentsPath, staffDashboardReportPath, StaffDashboardAccessError, verifyStaffDashboardSnapshot } from '../src/components/staff-dashboard-http';
import { loadOwnerLaunchFirstClassBookingContext } from '../src/components/owner-launch-http';

const organizationId = '11111111-1111-4111-8111-111111111111';
const schoolId = '22222222-2222-4222-8222-222222222222';
const from = '2026-06-01T00:00:00.000Z';
const to = '2026-06-02T00:00:00.000Z';
const report = () => ({
  organizationId, schoolId, generatedAt: to, from, to,
  studentProfiles: { total: 3 },
  leads: { byStatus: { OPEN: 4, WON: 1, LOST: 2, ARCHIVED: 0 } },
  classSessions: { inRange: { scheduled: 5, completed: 6, cancelled: 7 } },
  attendance: { inRangeByStatus: { PRESENT: 8, LATE: 9, EXCUSED_ABSENCE: 10, UNEXCUSED_ABSENCE: 11, MAKEUP: 12 } },
  memberships: { byState: { DRAFT: 0, ACTIVE: 13, FROZEN: 1, CANCELLATION_PENDING: 2, CANCELLED: 3, EXPIRED: 4 } },
  invoices: { inRangeByStatus: { DRAFT: 0, ISSUED: 5, PAID: 6, VOID: 7, UNCOLLECTIBLE: 8 } },
  paymentAttempts: { inRangeByState: { PENDING: 0, PROCESSING: 1, SUCCEEDED: 2, FAILED: 3, REQUIRES_ACTION: 4, UNKNOWN: 5, REFUNDED: 6 } },
});
const response = (operationalSnapshot: unknown) => ({ ok: true, json: async () => ({ data: { operationalSnapshot }, meta: { requestId: 'id', correlationId: 'id' } }) }) as Response;
const savedRegistration = { registrationId: '33333333-3333-4333-8333-333333333333', studentProfileId: '44444444-4444-4444-8444-444444444444', displayName: 'Saved Student', createdAt: to, registrationKind: 'NEW_ADULT_NO_GUARDIAN' as const, status: 'REGISTERED_NO_BOOKING' as const };
const savedStudents = { organizationId, schoolId, state: 'RECORDED_REGISTRATIONS' as const, registrations: [savedRegistration] } satisfies OwnerLaunchSavedStudentsProjection;
const bookingContext = { registrationId: savedRegistration.registrationId, student: { studentProfileId: savedRegistration.studentProfileId, displayName: 'Booking Read Name Is Not Used' }, classSession: { id: '55555555-5555-4555-8555-555555555555', name: 'First class', startsAt: '2026-06-03T10:00:00.000Z', endsAt: '2026-06-03T11:00:00.000Z', status: 'SCHEDULED', capacity: 10, bookingPolicy: 'OPTIONAL_BOOKING' }, booking: { id: '66666666-6666-4666-8666-666666666666', bookingKind: 'REGULAR', status: 'BOOKED', version: 1, recordedAt: to } } as const;
const recordedBooking = { state: 'RECORDED_BOOKING', context: bookingContext } as const;

describe('staff operations dashboard', () => {
  it('uses exactly the existing same-origin read-only operations report and reconstructs its aggregate DTO', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(report()));
    try {
      expect(staffDashboardReportPath(organizationId.toUpperCase(), schoolId.toUpperCase())).toBe(`/api/v1/organizations/${organizationId}/schools/${schoolId}/reports/operations`);
      await expect(loadStaffDashboard(organizationId, schoolId)).resolves.toMatchObject({ organizationId, schoolId, memberships: { byState: { ACTIVE: 13 } } });
      expect(fetchSpy).toHaveBeenCalledWith(`/api/v1/organizations/${organizationId}/schools/${schoolId}/reports/operations`, expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' }));
      for (const unsafe of ['https://example.invalid', `${organizationId}/reports`, 'not-a-uuid']) expect(() => staffDashboardReportPath(unsafe, schoolId)).toThrow();
    } finally { fetchSpy.mockRestore(); }
  });

  it('fails closed on PII, notes, payment methods, private evidence, scope mismatch, and access denial', async () => {
    for (const patch of [{ personName: 'PRIVATE_PERSON' }, { rawNote: 'PRIVATE_NOTE' }, { paymentMethod: 'PRIVATE_PAYMENT' }, { actionEvidence: { raw: true } }, { schoolId: organizationId }]) {
      expect(() => verifyStaffDashboardSnapshot({ ...report(), ...patch }, organizationId, schoolId)).toThrow();
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 403 } as Response);
    try { await expect(loadStaffDashboard(organizationId, schoolId)).rejects.toBeInstanceOf(StaffDashboardAccessError); } finally { fetchSpy.mockRestore(); }
  });

  it('loads saved student confirmation only from the fixed selector-free owner receipt read and rejects private fields', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ data: savedStudents }) } as Response);
    try {
      expect(ownerLaunchSavedStudentsPath()).toBe('/api/v1/owner-launch/saved-students');
      await expect(loadOwnerLaunchSavedStudents()).resolves.toEqual(savedStudents);
      expect(fetchSpy).toHaveBeenCalledWith('/api/v1/owner-launch/saved-students', expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' }));
    } finally { fetchSpy.mockRestore(); }
    for (const patch of [{ registrations: [{ ...savedStudents.registrations[0], familyId: organizationId }] }, { registrations: [{ ...savedStudents.registrations[0], birthDate: '2015-01-01' }] }, { state: 'NO_RECORDED_REGISTRATIONS' }]) {
      const malformed = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ data: { ...savedStudents, ...patch } }) } as Response);
      try { await expect(loadOwnerLaunchSavedStudents()).rejects.toThrow(); } finally { malformed.mockRestore(); }
    }
  });

  it('uses only the delivered fixed selector-free booking read and renders it only for a matching verified saved-student scope', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ data: recordedBooking }) } as Response);
    try {
      await expect(loadOwnerLaunchFirstClassBookingContext()).resolves.toEqual(recordedBooking);
      expect(fetchSpy).toHaveBeenCalledWith('/api/v1/owner-launch/first-class-booking-context', { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' });
    } finally { fetchSpy.mockRestore(); }

    const matched = bookingForVerifiedDashboard(recordedBooking, savedStudents, report());
    expect(matched).toEqual({ displayName: 'Saved Student', context: bookingContext });
    const card = renderToStaticMarkup(<FirstClassBookingConfirmation confirmation={matched!} />);
    for (const value of ['OWNER LAUNCH / FIRST-CLASS CONFIRMATION ONLY', 'Saved Student', 'First class', 'Class time', 'SCHEDULED', 'BOOKED', 'Confirmation only. This is not attendance, membership, payment, eligibility, parent access, or communication.']) expect(card).toContain(value);
    expect(card).not.toContain('Booking Read Name Is Not Used');
    expect(card).not.toMatch(/<(?:a|button|form|input)\b/);

    for (const booking of [
      { ...recordedBooking, context: { ...bookingContext, registrationId: organizationId } },
      { ...recordedBooking, context: { ...bookingContext, student: { ...bookingContext.student, studentProfileId: organizationId } } },
      { state: 'NO_RECORDED_BOOKING', context: null } as const,
    ]) expect(bookingForVerifiedDashboard(booking, savedStudents, report())).toBeNull();
    expect(bookingForVerifiedDashboard(recordedBooking, { ...savedStudents, schoolId: organizationId }, report())).toBeNull();
  });

  it('starts without fabricated metrics and exposes explicit unavailable states plus real managed-workflow links', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<StaffDashboard />);
      expect(fetchSpy).not.toHaveBeenCalled();
      for (const text of ['No verified school is selected', 'no contact data, notes, payment methods, private evidence']) expect(html).toContain(text);
      expect(html).not.toContain('Saved students');
      expect(html).not.toContain('31,850');
      expect(html).not.toContain('Ideal Martial Arts');
    } finally { fetchSpy.mockRestore(); }
  });

  it('is a protected no-index staff route and imports no mutation, automation, AI, voice, external, or execution client', () => {
    const route = readFileSync('src/app/staff/dashboard/page.tsx', 'utf8');
    const component = readFileSync('src/components/staff-dashboard.tsx', 'utf8');
    const http = readFileSync('src/components/staff-dashboard-http.ts', 'utf8');
    for (const text of ['verifySession', "redirect('/auth/login')", 'index: false', 'follow: false', 'force-dynamic']) expect(route).toContain(text);
    expect(component).toContain('setSnapshot(null)');
    expect(component).toContain('confirmation.organizationId !== next.organizationId');
    expect(component).toContain('confirmation.schoolId !== next.schoolId');
    expect(component).toContain('loadOwnerLaunchFirstClassBookingContext');
    expect(component).toContain('bookingForVerifiedDashboard(booking, confirmation, next)');
    expect(component).toContain('FIRST-CLASS CONFIRMATION ONLY');
    for (const text of ['Student profiles', 'Current-school aggregate', 'Trial count unavailable', 'Revenue-plan summary unavailable', 'NOT COUNTED HERE', 'Saved students', 'not a student or family directory']) expect(component).toContain(text);
    for (const href of ['/staff/search', '/staff/planning/revenue', '/staff/launch', '/staff/crm/follow-ups', '/staff/billing/renewals', '/staff/action-center/approvals', '/staff/work']) expect(component).toContain(href);
    expect(http).toContain("method: 'GET'");
    expect(http).toContain("credentials: 'same-origin'");
    expect(http).toContain("'/api/v1/owner-launch/saved-students'");
    expect(component).not.toContain('loadOwnerLaunchWithConfirmations');
    expect(component).not.toContain('loadOwnerLaunch(');
    expect(http).not.toMatch(/method:\s*'POST'|Idempotency-Key|X-HON-Human-Command|invokeLLM|executeAction|sendMessage|from\s+['"][^'"]*(?:voice|action|ai|provider)/i);
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    expect(manifest.routes.filter((item: { path: string }) => item.path === '/staff/dashboard')).toHaveLength(1);
  });
});
