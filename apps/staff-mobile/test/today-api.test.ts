import { createStaffApi } from '../src/api/client';
import {
  CLASS_1, CLASS_LIST, ENTRY, ORG, RECORD, REQ, ROSTER, SCHOOL_A, STUDENT_1, STUDENT_2, clock, entry, jsonResponse, record, routeFetch,
} from './fixtures';

const school = { organizationId: ORG, schoolId: SCHOOL_A, schoolName: null };
const BASE = `/v1/organizations/${ORG}/schools/${SCHOOL_A}`;
const api = (fetchImpl: typeof fetch) => createStaffApi({ baseUrl: 'https://app.example.test/api', getToken: async () => 'staff.token', fetchImpl });
const path = (p: string) => `/api${BASE}${p}`;

describe('Today: classes', () => {
  it('reads the school list from the school\'s own today as a native read, and keeps only today', async () => {
    const f = routeFetch({ [path('/schedule/sessions/list')]: () => jsonResponse(200, CLASS_LIST) });
    const result = await api(f.impl).todayClasses(school);
    expect(result.ok && result.data.classes.map(c => c.name)).toEqual(['Kids Fundamentals', 'Adult BJJ']);
    expect(result.ok && result.data.more).toBe(false);
    expect(f.calls[0]!.url).toBe(`https://app.example.test${path('/schedule/sessions/list')}?limit=50`);
    expect(f.calls[0]!.init).toMatchObject({ method: 'GET', credentials: 'omit', headers: { Accept: 'application/json', Authorization: 'Bearer staff.token', 'X-HON-Human-Read': 'class-sessions' } });
    expect(Object.keys(f.calls[0]!.init.headers as object)).not.toContain('Origin');
  });
  it('refuses an answer that does not verify (extra field, wrong date echo, bad row)', async () => {
    for (const bad of [
      { ...CLASS_LIST, extra: 1 },
      { ...CLASS_LIST, meta: { ...CLASS_LIST.meta, fromDate: '2026-11-21' } },
      { ...CLASS_LIST, meta: { ...CLASS_LIST.meta, limit: 10 } },
      { ...CLASS_LIST, data: [{ ...CLASS_LIST.data[0], capacity: 0 }] },
      { ...CLASS_LIST, meta: { ...CLASS_LIST.meta, correlationId: CLASS_1 } },
    ]) {
      const f = routeFetch({ [path('/schedule/sessions/list')]: () => jsonResponse(200, bad) });
      expect(await api(f.impl).todayClasses(school)).toEqual({ ok: false, state: 'unavailable' });
    }
  });
  it.each([[401, 'signed-out'], [403, 'no-staff-access'], [500, 'unavailable']])('HTTP %i is %s', async (status, state) => {
    const f = routeFetch({ [path('/schedule/sessions/list')]: () => jsonResponse(status, { code: 'X' }) });
    expect(await api(f.impl).todayClasses(school)).toEqual({ ok: false, state });
  });
});

describe('Today: roster and marks', () => {
  const rosterPath = path(`/schedule/sessions/${CLASS_1}/roster`);
  const attendancePath = path(`/schedule/sessions/${CLASS_1}/attendance`);
  it('reads one class roster', async () => {
    const f = routeFetch({ [rosterPath]: () => jsonResponse(200, ROSTER) });
    const result = await api(f.impl).roster(school, CLASS_1);
    expect(result.ok && result.data.entries.map(e => e.givenName)).toEqual(['Test', 'Trial']);
    const dup = routeFetch({ [rosterPath]: () => jsonResponse(200, { ...ROSTER, data: [ROSTER.data[0], ROSTER.data[0]] }) });
    expect(await api(dup.impl).roster(school, CLASS_1)).toEqual({ ok: false, state: 'unavailable' });
  });
  it('a new mark is one attendance command with the booking\'s category, the key, and no browser headers', async () => {
    const f = routeFetch({ [attendancePath]: () => jsonResponse(201, { data: record(STUDENT_1, 'PRESENT', 1, { category: 'REGULAR_PARTICIPANT' }), meta: { requestId: REQ, correlationId: REQ, replayed: false } }) });
    const result = await api(f.impl).mark(school, CLASS_1, ROSTER.data[0] as never, 'PRESENT', 'key-1');
    expect(result).toEqual({ ok: true, data: { id: RECORD, status: 'PRESENT', category: 'REGULAR_PARTICIPANT', recordedAt: '2026-11-23T01:05:00.000Z', version: 1 } });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.init).toMatchObject({ method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', 'X-HON-Human-Command': 'attendance', 'Idempotency-Key': 'key-1', Authorization: 'Bearer staff.token' } });
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({ studentProfileId: STUDENT_1, status: 'PRESENT', category: 'REGULAR_PARTICIPANT', note: '' });
  });
  it('changing a mark re-reads the exact record and keeps its note, category and version', async () => {
    const f = routeFetch({ [attendancePath]: () => f.calls.length === 1
      ? jsonResponse(200, { data: record(STUDENT_2, 'LATE', 2, { note: 'Parent called' }), meta: { requestId: REQ, correlationId: REQ } })
      : jsonResponse(200, { data: record(STUDENT_2, 'PRESENT', 3, { note: 'Parent called' }), meta: { requestId: REQ, correlationId: REQ, replayed: false } }) });
    const result = await api(f.impl).mark(school, CLASS_1, ROSTER.data[1] as never, 'PRESENT', 'key-2');
    expect(result.ok).toBe(true);
    expect(f.calls[0]!.url).toContain(`?studentProfileId=${STUDENT_2}`);
    expect(JSON.parse(f.calls[1]!.init.body as string)).toEqual({ studentProfileId: STUDENT_2, status: 'PRESENT', category: 'TRIAL_STUDENT', note: 'Parent called', expectedVersion: 2 });
  });
  it('a record changed elsewhere is "changed" and nothing is sent', async () => {
    const f = routeFetch({ [attendancePath]: () => jsonResponse(200, { data: record(STUDENT_2, 'PRESENT', 3), meta: { requestId: REQ, correlationId: REQ } }) });
    expect(await api(f.impl).mark(school, CLASS_1, ROSTER.data[1] as never, 'LATE', 'k')).toEqual({ ok: false, state: 'changed' });
    expect(f.calls).toHaveLength(1);
  });
  it.each([
    [409, 'VERSION_CONFLICT', 'changed'], [409, 'VERSION_REQUIRED', 'changed'], [409, 'ATTENDANCE_CONFLICT', 'unknown'], [403, 'X', 'no-staff-access'],
    [400, 'VALIDATION_FAILED', 'rejected'], [503, 'ATTENDANCE_TIMEOUT', 'unknown'], [401, 'X', 'signed-out'],
  ])('a mark answered %i %s is %s', async (status, code, state) => {
    const f = routeFetch({ [attendancePath]: () => jsonResponse(status, { code }) });
    expect(await api(f.impl).mark(school, CLASS_1, ROSTER.data[0] as never, 'PRESENT', 'k')).toEqual({ ok: false, state });
  });
  it('a saved answer for another student or a different status is not trusted', async () => {
    const f = routeFetch({ [attendancePath]: () => jsonResponse(201, { data: record(STUDENT_2, 'PRESENT', 1), meta: { requestId: REQ, correlationId: REQ, replayed: false } }) });
    expect(await api(f.impl).mark(school, CLASS_1, ROSTER.data[0] as never, 'PRESENT', 'k')).toEqual({ ok: false, state: 'unknown' });
    const g = routeFetch({ [attendancePath]: () => jsonResponse(201, { data: record(STUDENT_1, 'LATE', 1), meta: { requestId: REQ, correlationId: REQ, replayed: false } }) });
    expect(await api(g.impl).mark(school, CLASS_1, ROSTER.data[0] as never, 'PRESENT', 'k')).toEqual({ ok: false, state: 'unknown' });
  });
});

describe('Today: my clock', () => {
  const clockPath = path('/staff/time/clock');
  it('reads the person\'s own clock', async () => {
    const f = routeFetch({ [clockPath]: () => jsonResponse(200, clock(entry())) });
    const result = await api(f.impl).clock(school);
    expect(result.ok && result.data.open?.entryId).toBe(ENTRY);
  });
  it('clock in sends version 0 with the punch command; the receipt must be the next, open entry', async () => {
    const f = routeFetch({ [clockPath]: () => jsonResponse(200, { data: entry(), meta: { requestId: REQ, correlationId: REQ, replayed: false } }) });
    const result = await api(f.impl).punch(school, 'CLOCK_IN', 0, 'key-3');
    expect(result.ok && result.data.entryId).toBe(ENTRY);
    expect(f.calls[0]!.init).toMatchObject({ method: 'POST', headers: { 'X-HON-Human-Command': 'staff_time.punch', 'Idempotency-Key': 'key-3', 'Content-Type': 'application/json' } });
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({ action: 'CLOCK_IN', expectedVersion: 0 });
    // A clock-out answer must be closed and one version on.
    const g = routeFetch({ [clockPath]: () => jsonResponse(200, { data: entry({ version: 2 }), meta: { requestId: REQ, correlationId: REQ, replayed: false } }) });
    expect(await api(g.impl).punch(school, 'CLOCK_OUT', 1, 'k')).toEqual({ ok: false, state: 'unknown' });
  });
  it('a clock already changed on another device is "changed"', async () => {
    const f = routeFetch({ [clockPath]: () => jsonResponse(409, { code: 'TIME_CLOCK_STATE_CHANGED' }) });
    expect(await api(f.impl).punch(school, 'CLOCK_IN', 0, 'k')).toEqual({ ok: false, state: 'changed' });
  });
  it('a network failure on a punch is offline (same key may be retried)', async () => {
    const impl = jest.fn(async () => { throw new Error('down'); }) as unknown as typeof fetch;
    expect(await api(impl).punch(school, 'CLOCK_IN', 0, 'k')).toEqual({ ok: false, state: 'offline' });
  });
});
