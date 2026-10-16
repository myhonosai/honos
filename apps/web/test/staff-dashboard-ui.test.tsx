import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { OwnerLaunchMembershipDraftConfirmation, OwnerLaunchProjection, OwnerLaunchSavedStudentsProjection } from '@hon/contracts';
import { bookingForVerifiedDashboard, membershipDraftForVerifiedDashboard, OwnerWorkflowProgressCard, ownerContextMatchesVerifiedDashboard, savedStudentForVerifiedDashboard, type OwnerWorkflowProgress, StaffDashboard } from '../src/components/staff-dashboard';
import { loadOwnerLaunchSavedStudents, loadStaffDashboard, ownerLaunchSavedStudentsPath, staffDashboardReportPath, StaffDashboardAccessError, verifyStaffDashboardSnapshot } from '../src/components/staff-dashboard-http';
import { loadOwnerLaunch, loadOwnerLaunchFirstClassBookingContext, loadOwnerLaunchMembershipDraft } from '../src/components/owner-launch-http';

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
const ownerContext = { organizationId, schoolId, schoolName: 'Verified owner school', tier: 'ESSENTIAL', program: { id: '77777777-7777-4777-8777-777777777777', version: 1, status: 'DRAFT' }, classSession: { id: bookingContext.classSession.id, programId: '77777777-7777-4777-8777-777777777777', version: 1, status: 'SCHEDULED' }, registration: { registrationId: savedRegistration.registrationId, studentProfileId: savedRegistration.studentProfileId, enrollmentId: '88888888-8888-4888-8888-888888888888', programId: '77777777-7777-4777-8777-777777777777', classSessionId: bookingContext.classSession.id, status: 'REGISTERED_NO_BOOKING', createdAt: to }, guardianChildRegistration: null } satisfies OwnerLaunchProjection;
const recordedDraft = { state: 'RECORDED_DRAFT', receipt: { registrationId: savedRegistration.registrationId, membershipId: '99999999-9999-4999-8999-999999999999', state: 'DRAFT', membershipVersion: 1, planCode: 'OPAQUE-CONFIRMED', termStartedAt: '2026-06-03T00:00:00.000Z', termEndsAt: '2027-06-03T00:00:00.000Z', currency: 'USD', recordedAt: to } } satisfies OwnerLaunchMembershipDraftConfirmation;

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

  it('uses only the four delivered selector-free no-store reads after the report and renders receipt-aligned progress without actions', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => {
      const data = path === `/api/v1/organizations/${organizationId}/schools/${schoolId}/reports/operations` ? { data: { operationalSnapshot: report() }, meta: { requestId: 'id', correlationId: 'id' } }
        : path === '/api/v1/owner-launch' ? { data: ownerContext }
          : path === '/api/v1/owner-launch/saved-students' ? { data: savedStudents }
            : path === '/api/v1/owner-launch/first-class-booking-context' ? { data: recordedBooking }
              : { data: recordedDraft };
      return { ok: true, status: 200, json: async () => data } as Response;
    });
    try {
      await expect(loadStaffDashboard(organizationId, schoolId)).resolves.toMatchObject({ organizationId, schoolId });
      await expect(loadOwnerLaunch()).resolves.toEqual(ownerContext);
      await expect(loadOwnerLaunchSavedStudents()).resolves.toEqual(savedStudents);
      await expect(loadOwnerLaunchFirstClassBookingContext()).resolves.toEqual(recordedBooking);
      await expect(loadOwnerLaunchMembershipDraft()).resolves.toEqual(recordedDraft);
      expect(fetchSpy.mock.calls.map(([path]) => path)).toEqual([
        `/api/v1/organizations/${organizationId}/schools/${schoolId}/reports/operations`,
        '/api/v1/owner-launch', '/api/v1/owner-launch/saved-students', '/api/v1/owner-launch/first-class-booking-context', '/api/v1/owner-launch/membership-draft',
      ]);
      for (const index of [1, 3, 4]) expect(fetchSpy.mock.calls[index]![1]).toEqual({ method: 'GET', headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' });
      expect(fetchSpy.mock.calls[2]![1]).toEqual({ method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } });
    } finally { fetchSpy.mockRestore(); }

    expect(ownerContextMatchesVerifiedDashboard(ownerContext, report())).toBe(true);
    const saved = savedStudentForVerifiedDashboard(ownerContext, savedStudents, report());
    expect(saved).not.toBeNull();
    expect(saved).not.toBe('NO_RECORDED');
    const verified = saved as Exclude<typeof saved, null | 'NO_RECORDED'>;
    const booking = bookingForVerifiedDashboard(recordedBooking, ownerContext, verified);
    expect(booking).toEqual({ displayName: 'Saved Student', context: bookingContext });
    expect(membershipDraftForVerifiedDashboard(recordedDraft, verified)).toEqual(recordedDraft.receipt);
    const progress: OwnerWorkflowProgress = { savedStudent: { state: 'RECORDED', verified }, booking: { state: 'RECORDED', confirmation: booking! }, membershipDraft: { state: 'RECORDED', receipt: recordedDraft.receipt } };
    const card = renderToStaticMarkup(<OwnerWorkflowProgressCard progress={progress} />);
    for (const value of ['OWNER LAUNCH / CONFIRMATION ONLY', 'Saved-workflow progress', 'School context', 'Verified current dashboard report', 'Saved Student', 'Matching saved registration', 'First class', 'BOOKED', 'DRAFT recorded', 'DRAFT only: saved configuration, NOT active', 'Confirmation-only view']) expect(card).toContain(value);
    expect(card).not.toContain('Booking Read Name Is Not Used');
    expect(card).not.toMatch(/<(?:a|button|form|input)\b/);
  });

  it('fails closed for owner/report/saved/booking/DRAFT mismatches and shows no-recorded only from exact source states', () => {
    expect(ownerContextMatchesVerifiedDashboard({ ...ownerContext, organizationId: schoolId }, report())).toBe(false);
    expect(savedStudentForVerifiedDashboard({ ...ownerContext, schoolId: organizationId }, savedStudents, report())).toBeNull();
    expect(savedStudentForVerifiedDashboard(ownerContext, { ...savedStudents, registrations: [{ ...savedRegistration, registrationId: organizationId }] }, report())).toBeNull();
    const noSavedContext = { ...ownerContext, registration: null };
    expect(savedStudentForVerifiedDashboard(noSavedContext, { organizationId, schoolId, state: 'NO_RECORDED_REGISTRATIONS', registrations: [] }, report())).toBe('NO_RECORDED');
    const saved = savedStudentForVerifiedDashboard(ownerContext, savedStudents, report()) as Exclude<ReturnType<typeof savedStudentForVerifiedDashboard>, null | 'NO_RECORDED'>;
    for (const booking of [
      { ...recordedBooking, context: { ...bookingContext, registrationId: organizationId } },
      { ...recordedBooking, context: { ...bookingContext, student: { ...bookingContext.student, studentProfileId: organizationId } } },
      { ...recordedBooking, context: { ...bookingContext, classSession: { ...bookingContext.classSession, id: organizationId } } },
      { state: 'NO_RECORDED_BOOKING', context: null } as const,
    ]) expect(bookingForVerifiedDashboard(booking, ownerContext, saved)).toBeNull();
    expect(membershipDraftForVerifiedDashboard({ ...recordedDraft, receipt: { ...recordedDraft.receipt, registrationId: organizationId } }, saved)).toBeNull();
    expect(membershipDraftForVerifiedDashboard({ state: 'NO_RECORDED_DRAFT', receipt: null }, saved)).toBeNull();
    const noRecorded: OwnerWorkflowProgress = { savedStudent: { state: 'NO_RECORDED' }, booking: null, membershipDraft: null };
    const card = renderToStaticMarkup(<OwnerWorkflowProgressCard progress={noRecorded} />);
    expect(card).toContain('No recorded saved student');
    expect(card).not.toContain('First class booking');
    expect(card).not.toContain('Membership DRAFT');
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

  it('is a protected no-index staff route and adds only the verified current-school presentation preference save, never a dashboard business mutation or execution client', () => {
    const route = readFileSync('src/app/staff/dashboard/page.tsx', 'utf8');
    const component = readFileSync('src/components/staff-dashboard.tsx', 'utf8');
    const http = readFileSync('src/components/staff-dashboard-http.ts', 'utf8');
    const preference = readFileSync('src/components/interface-theme-preference.ts', 'utf8');
    for (const text of ['verifySession', "redirect('/auth/login')", 'index: false', 'follow: false', 'force-dynamic']) expect(route).toContain(text);
    expect(component).toContain('setSnapshot(null)');
    expect(component).toContain('generation.current');
    expect(component).toContain('loadOwnerLaunch()');
    expect(component).toContain('ownerContextMatchesVerifiedDashboard(ownerContext, next)');
    expect(component).toContain('savedStudentForVerifiedDashboard(ownerContext, savedStudents, next)');
    expect(component).toContain('loadOwnerLaunchFirstClassBookingContext');
    expect(component).toContain('loadOwnerLaunchMembershipDraft');
    expect(component).toContain('bookingForVerifiedDashboard(bookingResult.value, ownerContext, saved)');
    expect(component).toContain('membershipDraftForVerifiedDashboard(draftResult.value, saved)');
    expect(component).toContain('OWNER LAUNCH / CONFIRMATION ONLY');
    expect(component).toContain('PlatformViewSelector');
    expect(component).toContain('loadInterfaceThemePreference(scope)');
    expect(component).toContain("saveInterfaceThemePreference(scope, next, crypto.randomUUID(), 'SETTINGS')");
    expect(component).toContain('change touch targets and density only');
    expect(component).toContain('if (!selection)');
    for (const text of ['Student profiles', 'Current-school aggregate', 'Trial count unavailable', 'Revenue-plan summary unavailable', 'NOT COUNTED HERE', 'Saved-workflow progress', 'Confirmation-only view']) expect(component).toContain(text);
    for (const href of ['/staff/search', '/staff/crm/leads', '/staff/crm/trials', '/staff/planning/revenue', '/staff/launch', '/staff/crm/follow-ups', '/staff/billing/renewals', '/staff/action-center/approvals', '/staff/work']) expect(component).toContain(href);
    expect(http).toContain("method: 'GET'");
    expect(http).toContain("credentials: 'same-origin'");
    expect(http).toContain("'/api/v1/owner-launch/saved-students'");
    expect(component).not.toContain('loadOwnerLaunchWithConfirmations');
    expect(component).not.toContain('loadOwnerLaunchWithDraft');
    expect(http).not.toMatch(/method:\s*'POST'|Idempotency-Key|X-HON-Human-Command|invokeLLM|executeAction|sendMessage|from\s+['"][^'"]*(?:voice|action|ai|provider)/i);
    expect(preference).toContain("selectedVia: SavedSelectedVia = 'ONBOARDING'");
    expect(preference).toContain("value !== 'ONBOARDING' && value !== 'SETTINGS'");
    expect(preference).not.toMatch(/localStorage|sessionStorage|invokeLLM|executeAction|sendMessage|provider/i);
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    expect(manifest.routes.filter((item: { path: string }) => item.path === '/staff/dashboard')).toHaveLength(1);
  });
});
