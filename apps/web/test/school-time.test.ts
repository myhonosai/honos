import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyCrmSchoolClock } from '@hon/contracts';
import { formatInSchool, instantToSchoolLocal, readSchoolClock, schoolClockPath, schoolLocalToInstant } from '../src/components/school-time';

const ORG = '11111111-1111-4111-8111-111111111111', SCHOOL = '22222222-2222-4222-8222-222222222222';
const clock = { schoolId: SCHOOL, schoolTimezone: 'America/Los_Angeles', localToday: '2026-11-08', asOf: '2026-11-09T05:40:00.000Z' };

describe('school wall time to instant (B-CRM-3)', () => {
  it('converts summer and winter times with the zone offset', () => {
    expect(schoolLocalToInstant('2026-07-01T10:00', 'America/Los_Angeles')).toEqual({ state: 'OK', instant: '2026-07-01T17:00:00.000Z', ambiguous: false });
    expect(schoolLocalToInstant('2026-12-01T10:00', 'America/Los_Angeles')).toEqual({ state: 'OK', instant: '2026-12-01T18:00:00.000Z', ambiguous: false });
    expect(schoolLocalToInstant('2026-12-01T10:00:30', 'Asia/Seoul')).toEqual({ state: 'OK', instant: '2026-12-01T01:00:30.000Z', ambiguous: false });
    expect(schoolLocalToInstant('2026-12-01T10:00', 'UTC')).toEqual({ state: 'OK', instant: '2026-12-01T10:00:00.000Z', ambiguous: false });
  });
  it('refuses a time skipped by daylight saving and flags a repeated time (earlier instant)', () => {
    expect(schoolLocalToInstant('2026-03-08T02:30', 'America/Los_Angeles')).toEqual({ state: 'NONEXISTENT' });
    expect(schoolLocalToInstant('2026-11-01T01:30', 'America/Los_Angeles')).toEqual({ state: 'OK', instant: '2026-11-01T08:30:00.000Z', ambiguous: true });
  });
  it('refuses impossible dates, malformed input and unknown zones', () => {
    for (const [v, z] of [['2026-02-30T10:00', 'UTC'], ['2026-07-01 10:00', 'UTC'], ['2026-07-01T24:00', 'UTC'], ['2026-07-01T10:00', 'Mars/Base']]) {
      expect(schoolLocalToInstant(v!, z!).state).toBe('INVALID');
    }
  });
  it('round-trips an instant to the school wall time and formats it in school time', () => {
    expect(instantToSchoolLocal('2026-07-01T17:00:00.000Z', 'America/Los_Angeles')).toBe('2026-07-01T10:00');
    expect(instantToSchoolLocal('2026-12-01T01:00:00.000Z', 'Asia/Seoul')).toBe('2026-12-01T10:00');
    expect(formatInSchool('2026-07-01T17:00:00.000Z', 'America/Los_Angeles', 'en-US')).toMatch(/10:00.*PDT$/);
  });
});

describe('school clock read (B-CRM-3)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('verifies the closed shape and the shown school', () => {
    expect(verifyCrmSchoolClock(clock, SCHOOL.toUpperCase())).toEqual(clock);
    for (const bad of [{ ...clock, schoolId: ORG }, { ...clock, extra: 1 }, { ...clock, localToday: '2026-02-30' }, { ...clock, asOf: '2026-11-09T05:40:00Z' },
      { ...clock, schoolTimezone: 'Not a zone!' }, (({ asOf: _a, ...rest }) => rest)(clock)]) {
      expect(() => verifyCrmSchoolClock(bad, SCHOOL)).toThrow();
    }
  });
  it('reads the server clock and falls back to UNAVAILABLE on any failure', async () => {
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => new Response(JSON.stringify({ data: clock, meta: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const scope = { organizationId: ORG, schoolId: SCHOOL };
    expect(await readSchoolClock(scope, new AbortController().signal)).toEqual({ state: 'READY', clock });
    expect(fetchMock.mock.calls[0]![0]).toBe(schoolClockPath(scope));
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('GET');
    for (const response of [new Response('{}', { status: 403 }), new Response(JSON.stringify({ data: { ...clock, schoolId: ORG } }), { status: 200 }), new Response('not json', { status: 200 })]) {
      vi.stubGlobal('fetch', vi.fn(async () => response));
      expect(await readSchoolClock(scope, new AbortController().signal)).toEqual({ state: 'UNAVAILABLE' });
    }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network'); }));
    expect(await readSchoolClock(scope, new AbortController().signal)).toEqual({ state: 'UNAVAILABLE' });
  });
});
