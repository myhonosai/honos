import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCurrentStaffReportingSchool, verifyCurrentStaffReportingSchool } from '../src/components/current-staff-reporting-school-http';
import { StaffDashboardAccessError } from '../src/components/staff-dashboard-http';

const scope = { state: 'RESOLVED', organizationId: '11111111-1111-4111-8111-111111111111', schoolId: '22222222-2222-4222-8222-222222222222' } as const;
const reply = (value: unknown, headers: Record<string, string> = { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json; charset=utf-8' }) => new Response(JSON.stringify(value), { status: 200, headers });
afterEach(() => vi.restoreAllMocks());

describe('selector-free current staff reporting school transport', () => {
  it('accepts only a rebuilt minimal resolved scope or identifier-free manual-required state', () => {
    expect(verifyCurrentStaffReportingSchool({ data: scope })).toEqual(scope);
    expect(verifyCurrentStaffReportingSchool({ data: { state: 'MANUAL_ENTRY_REQUIRED' } })).toEqual({ state: 'MANUAL_ENTRY_REQUIRED' });
    for (const invalid of [null, [], {}, { data: null }, { data: [] }, { data: { state: 'UNKNOWN' } }, { data: { ...scope, schoolId: 'bad' } }, { data: { ...scope, organizationId: null } }, { data: { state: 'RESOLVED' } }, { data: scope, meta: {} }, { data: { ...scope, principalId: 'PRIVATE' } }, { data: { ...scope, role: 'OWNER' } }, { data: { ...scope, tier: 'COMPLETE' } }, { data: { state: 'MANUAL_ENTRY_REQUIRED', schoolId: scope.schoolId } }, { data: { state: 'MANUAL_ENTRY_REQUIRED', candidates: [] } }, { data: { state: 'MANUAL_ENTRY_REQUIRED', count: 0 } }]) expect(() => verifyCurrentStaffReportingSchool(invalid)).toThrow();
  });

  it('makes a single fixed credentialed same-origin no-store read without arguments or command input', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply({ data: scope }));
    await expect(loadCurrentStaffReportingSchool()).resolves.toEqual(scope);
    expect(fetch.mock.calls).toEqual([['/api/v1/staff/current-reporting-school', { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } }]]);
  });

  it('rejects successful but malformed, cacheable, non-JSON, redirected, or foreign URL responses', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    for (const response of [reply({ data: { ...scope, candidates: [] } }), reply({ data: scope }, { 'Content-Type': 'application/json' }), reply({ data: scope }, { 'Cache-Control': 'private, max-age=60', 'Content-Type': 'application/json' }), reply({ data: scope }, { 'Cache-Control': 'no-store', 'Content-Type': 'text/html' }), new Response('not JSON', { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' } })]) {
      fetch.mockResolvedValue(response); await expect(loadCurrentStaffReportingSchool()).rejects.toThrow();
    }
    const redirected = reply({ data: scope }); Object.defineProperty(redirected, 'redirected', { value: true });
    fetch.mockResolvedValue(redirected); await expect(loadCurrentStaffReportingSchool()).rejects.toThrow();
    const foreign = reply({ data: scope }); Object.defineProperty(foreign, 'url', { value: 'https://foreign.example.invalid/api/v1/staff/current-reporting-school' });
    fetch.mockResolvedValue(foreign); await expect(loadCurrentStaffReportingSchool()).rejects.toThrow();
  });

  it('propagates 401/403/503 without trusting an error body or exposing any scope', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    for (const status of [401, 403, 503]) {
      const response = new Response(JSON.stringify({ data: scope }), { status });
      const json = vi.spyOn(response, 'json'); fetch.mockResolvedValue(response);
      await expect(loadCurrentStaffReportingSchool()).rejects.toMatchObject({ status });
      expect(json).not.toHaveBeenCalled();
    }
    fetch.mockRejectedValue(new TypeError('Network unavailable'));
    await expect(loadCurrentStaffReportingSchool()).rejects.toThrow('Network unavailable');
    fetch.mockResolvedValue(new Response('', { status: 403 }));
    await expect(loadCurrentStaffReportingSchool()).rejects.toBeInstanceOf(StaffDashboardAccessError);
  });
});
