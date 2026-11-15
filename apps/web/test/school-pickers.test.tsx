import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PICKER_LIMIT, pickerApi, verifyCandidates, verifyEnrollments, verifyTestingEvents, type PickerCandidate, type PickerEnrollment } from '../src/components/school-pickers/http';
import { IdFields, PickListView, candidateLabel, enrollmentLabel, testingEventLabel } from '../src/components/school-pickers/pickers';
import { id, scope } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
const meta = { requestId: id(5), correlationId: id(5), limit: PICKER_LIMIT };
const signal = () => new AbortController().signal;
const enrollment = (n: number, over: Partial<PickerEnrollment> = {}): PickerEnrollment => ({ enrollmentId: id(100 + n), curriculumId: id(200), curriculumName: 'Kids Karate', studentProfileId: id(300 + n),
  givenName: 'Avery', familyName: 'Sample', currentRankId: id(400), currentRankName: 'White', nextRankId: id(401), nextRankName: 'Yellow', version: 1, ...over });
const candidate = (n: number, over: Partial<PickerCandidate> = {}): PickerCandidate => ({ candidateId: id(500 + n), version: 2, result: 'PENDING', testingEventId: id(600), testingEventName: 'Spring test',
  startsAt: '2026-12-01T17:00:00.000Z', studentProfileId: id(300 + n), givenName: 'Blake', familyName: 'Sample', curriculumName: 'Kids Karate', targetRankId: id(401), targetRankName: 'Yellow', ...over });
const event = { testingEventId: id(600), name: 'Spring test', curriculumId: id(200), curriculumName: 'Kids Karate', startsAt: '2026-12-01T17:00:00.000Z', status: 'OPEN' };

it('reads each list for the verified school with a fixed purpose and a bounded search', async () => {
  const f = vi.fn(async () => json({ data: [enrollment(1)], meta }));
  vi.stubGlobal('fetch', f);
  await expect(pickerApi.enrollments(scope, 'testing', '  Ave ', signal())).resolves.toEqual([enrollment(1)]);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/pickers/enrollments?for=testing&search=Ave`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  vi.stubGlobal('fetch', f.mockImplementation(async () => json({ data: [candidate(1)], meta })));
  await pickerApi.candidates(scope, 'grade', 'x'.repeat(200), signal());
  expect((f.mock.calls[1] as unknown as [string])[0]).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/pickers/testing-candidates?for=grade&search=${'x'.repeat(120)}`);
  vi.stubGlobal('fetch', f.mockImplementation(async () => json({ data: [event], meta })));
  await expect(pickerApi.testingEvents(scope, signal())).resolves.toEqual([event]);
  expect((f.mock.calls[2] as unknown as [string])[0]).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/pickers/testing-events`);
});

it('maps refusals to DENIED and anything unexpected to UNAVAILABLE, never to a partial list', async () => {
  for (const status of [401, 403]) { vi.stubGlobal('fetch', vi.fn(async () => json({}, status))); await expect(pickerApi.testingEvents(scope, signal())).rejects.toMatchObject({ kind: 'DENIED' }); }
  for (const response of [json({}, 500), new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } }), json({ data: [event], meta: { ...meta, limit: 10 } })]) {
    vi.stubGlobal('fetch', vi.fn(async () => response)); await expect(pickerApi.testingEvents(scope, signal())).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
  }
  await expect(pickerApi.testingEvents({ organizationId: 'nope', schoolId: scope.schoolId }, signal())).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
});

it('accepts only the exact closed shapes, allowed results per purpose and unique rows', () => {
  const body = (data: unknown[]) => ({ data, meta });
  expect(verifyEnrollments(body([enrollment(1), enrollment(2, { currentRankId: null, currentRankName: null, nextRankId: null, nextRankName: null })]))).toHaveLength(2);
  for (const bad of [{ ...enrollment(1), extra: 1 }, enrollment(1, { enrollmentId: 'x' }), enrollment(1, { currentRankName: null }), enrollment(1, { version: 0 }), enrollment(1, { givenName: '' })]) {
    expect(() => verifyEnrollments(body([bad]))).toThrow();
  }
  expect(() => verifyEnrollments(body([enrollment(1), enrollment(1)]))).toThrow();
  expect(() => verifyEnrollments({ data: [], meta, more: true })).toThrow();
  expect(() => verifyEnrollments({ data: Array.from({ length: 51 }, (_, i) => enrollment(i)), meta })).toThrow();
  expect(() => verifyTestingEvents(body([{ ...event, status: 'COMPLETED' }]))).toThrow();
  expect(verifyCandidates(body([candidate(1)]), 'grade')).toHaveLength(1);
  expect(() => verifyCandidates(body([candidate(1)]), 'decision')).toThrow();
  expect(verifyCandidates(body([candidate(1, { result: 'PASSED' }), candidate(2, { result: 'NOT_PASSED' }), candidate(3, { result: 'DEFERRED' })]), 'decision')).toHaveLength(3);
  expect(() => verifyCandidates(body([candidate(1, { result: 'PASSED' })]), 'grade')).toThrow();
});

it('labels rows by name, curriculum and rank, never by record ID', () => {
  expect(enrollmentLabel(enrollment(1), false)).toBe('Avery Sample · Kids Karate · White');
  expect(enrollmentLabel(enrollment(1), true)).toBe('Avery Sample · Kids Karate · White → Yellow');
  expect(enrollmentLabel(enrollment(1, { currentRankId: null, currentRankName: null }), false)).toBe('Avery Sample · Kids Karate · No rank yet');
  expect(testingEventLabel(event as never)).toBe('Spring test · Kids Karate · Dec 1, 2026 · Open');
  expect(candidateLabel(candidate(1))).toBe('Blake Sample · Spring test · Testing for Yellow · Not graded yet');
  for (const label of [enrollmentLabel(enrollment(1), true), candidateLabel(candidate(1))]) expect(label).not.toMatch(/[0-9a-f]{8}-/);
});

it('renders loading, empty, denied, unavailable and ready states, and tucks ID inputs under a fallback', () => {
  const copy = { label: 'Student', choose: 'Choose a student', search: 'Find a student', loading: 'Reading students…', empty: 'No students match.', denied: 'No access here.' };
  const view = (list: Parameters<typeof PickListView<PickerEnrollment>>[0]['list']) => renderToStaticMarkup(<PickListView copy={copy} list={list} keyOf={(i) => i.enrollmentId}
    describe={(i) => enrollmentLabel(i, false)} value={id(101)} search="" disabled={false} />);
  const ready = view({ state: 'READY', items: [enrollment(1), enrollment(2, { givenName: 'Jordan' })] });
  expect(ready).toContain('>Find a student</label>'); expect(ready).toContain('>Student</label>');
  expect(ready).toContain(`<option value="${id(101)}" selected="">Avery Sample · Kids Karate · White</option>`);
  expect(ready).toContain('Jordan Sample');
  expect(view({ state: 'READY', items: [] })).toContain('No students match.');
  expect(view({ state: 'LOADING' })).toContain('Reading students…');
  expect(view({ state: 'UNAVAILABLE' })).toContain('could not be loaded');
  const denied = view({ state: 'DENIED' }); expect(denied).toContain('No access here.'); expect(denied).not.toContain('<select');
  expect(renderToStaticMarkup(<IdFields manual={false}><input name="x" /></IdFields>)).toMatch(/^<details data-id-fields="fallback" class="[^"]+"><summary>Enter record IDs instead<\/summary><input name="x"\/><\/details>$/);
  expect(renderToStaticMarkup(<IdFields manual><input name="x" /></IdFields>)).toBe('<input name="x"/>');
});
