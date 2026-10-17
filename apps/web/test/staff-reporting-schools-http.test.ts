import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadStaffReportingSchools, verifyStaffReportingSchools } from '../src/components/staff-reporting-schools-http';

const school = { organizationId: '11111111-1111-4111-8111-111111111111', schoolId: '22222222-2222-4222-8222-222222222222', organizationName: 'École Organization', schoolName: 'North School' };
const schools = [school, { ...school, schoolId: '33333333-3333-4333-8333-333333333333', schoolName: 'South School' }];
const selection = { state: 'SELECTION_REQUIRED', schools };
const reply = (value: unknown, headers: Record<string, string> = { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json; charset=utf-8' }) => new Response(JSON.stringify(value), { status: 200, headers });
afterEach(() => vi.restoreAllMocks());

describe('dashboard-only reporting school choices', () => {
  it('reconstructs only a closed bounded choice list or a reason/count/identifier-free manual state', () => {
    const actual = verifyStaffReportingSchools({ data: selection });
    expect(actual).toEqual(selection); expect(actual).not.toBe(selection);
    expect(verifyStaffReportingSchools({ data: { state: 'MANUAL_ENTRY_REQUIRED' } })).toEqual({ state: 'MANUAL_ENTRY_REQUIRED' });
    for (const data of [null, [], {}, { state: 'UNKNOWN' }, { ...selection, count: 2 }, { ...selection, roles: [] }, { ...selection, schools: [] }, { ...selection, schools: [school] }, { ...selection, schools: [school, school] }, { ...selection, schools: Array(21).fill(school) }, { ...selection, schools: {} }, { state: 'MANUAL_ENTRY_REQUIRED', schools: [] }, { state: 'MANUAL_ENTRY_REQUIRED', count: 0 }, { state: 'MANUAL_ENTRY_REQUIRED', reason: 'family' }, { state: 'MANUAL_ENTRY_REQUIRED', schoolId: school.schoolId }]) expect(() => verifyStaffReportingSchools({ data })).toThrow();
    for (const patch of [{ schoolId: 'bad' }, { organizationId: null }, { principalId: 'PRIVATE' }, { role: 'OWNER' }, { permissions: ['reporting.view'] }, { tier: 'COMPLETE' }, { schoolName: '' }, { schoolName: ' '.repeat(4) }, { schoolName: ' padded ' }, { schoolName: 'x'.repeat(121) }, { schoolName: '\u202eSpoof' }, { schoolName: 'Unsafe\nName' }, { schoolName: '\u0000' }, { organizationName: null }, { organizationName: 'x'.repeat(121) }]) {
      expect(() => verifyStaffReportingSchools({ data: { ...selection, schools: [{ ...school, ...patch }, schools[1]] } })).toThrow();
    }
    for (const envelope of [null, [], {}, { data: selection, meta: {} }]) expect(() => verifyStaffReportingSchools(envelope)).toThrow();
  });

  it('accepts exactly the hard maximum and normalizes IDs, never names or unknown fields', () => {
    const choices = Array.from({ length: 20 }, (_, index) => ({ ...school, schoolId: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}` }));
    expect(verifyStaffReportingSchools({ data: { state: 'SELECTION_REQUIRED', schools: choices } })).toEqual({ state: 'SELECTION_REQUIRED', schools: choices });
  });

  it('takes no arguments and makes a fixed same-origin credentialed no-store read with no delegation inputs', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply({ data: selection }));
    await expect(loadStaffReportingSchools()).resolves.toEqual(selection);
    expect(fetch.mock.calls).toEqual([['/api/v1/staff/reporting-schools', { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } }]]);
  });

  it('rejects cacheable/non-JSON/redirected/foreign/extra/malformed success responses', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    for (const response of [reply({ data: { ...selection, extra: true } }), reply({ data: selection }, { 'Content-Type': 'application/json' }), reply({ data: selection }, { 'Cache-Control': 'private, max-age=60', 'Content-Type': 'application/json' }), reply({ data: selection }, { 'Cache-Control': 'no-store', 'Content-Type': 'text/html' }), new Response('not JSON', { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' } })]) {
      fetch.mockResolvedValue(response); await expect(loadStaffReportingSchools()).rejects.toThrow();
    }
    const redirected = reply({ data: selection }); Object.defineProperty(redirected, 'redirected', { value: true });
    fetch.mockResolvedValue(redirected); await expect(loadStaffReportingSchools()).rejects.toThrow();
    for (const url of ['https://foreign.example.invalid/api/v1/staff/reporting-schools', 'http://localhost/api/v1/staff/reporting-schools?schoolId=forged']) {
      const foreign = reply({ data: selection }); Object.defineProperty(foreign, 'url', { value: url });
      fetch.mockResolvedValue(foreign); await expect(loadStaffReportingSchools()).rejects.toThrow();
    }
  });

  it('does not parse denied/error bodies or turn them into choices', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    for (const status of [401, 403, 503]) {
      const response = new Response(JSON.stringify({ data: selection }), { status });
      const json = vi.spyOn(response, 'json'); fetch.mockResolvedValue(response);
      await expect(loadStaffReportingSchools()).rejects.toMatchObject({ status }); expect(json).not.toHaveBeenCalled();
    }
  });
});
