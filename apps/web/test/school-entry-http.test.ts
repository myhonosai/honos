import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { schoolEntryApi } from '../src/components/school-entry/http';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const a = { organizationId: id(1), schoolId: id(2) }, b = { organizationId: id(3), schoolId: id(4) };
const zeroes = (keys: string[]) => Object.fromEntries(keys.map(k => [k, 0]));
const report = { ...a, generatedAt: '2026-11-04T00:00:00Z', from: '2026-11-01T00:00:00Z', to: '2026-11-04T00:00:00Z', studentProfiles: { total: 0 },
  leads: { byStatus: zeroes(['OPEN', 'WON', 'LOST', 'ARCHIVED']) }, classSessions: { inRange: { scheduled: 0, completed: 0, cancelled: 0 } },
  attendance: { inRangeByStatus: zeroes(['PRESENT', 'LATE', 'EXCUSED_ABSENCE', 'UNEXCUSED_ABSENCE', 'MAKEUP']) },
  memberships: { byState: zeroes(['DRAFT', 'ACTIVE', 'FROZEN', 'CANCELLATION_PENDING', 'CANCELLED', 'EXPIRED']) },
  invoices: { inRangeByStatus: zeroes(['DRAFT', 'ISSUED', 'PAID', 'VOID', 'UNCOLLECTIBLE']) }, paymentAttempts: { inRangeByState: zeroes(['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'REQUIRES_ACTION', 'UNKNOWN', 'REFUNDED']) } };
const response = (data: unknown, status = 200) => Response.json({ data }, { status, headers: { 'Cache-Control': 'private, no-store' } });
const signal = () => new AbortController().signal;
let invalidated: ReturnType<typeof vi.fn>;
beforeEach(() => { const w = new EventTarget(); invalidated = vi.fn(); w.addEventListener(HON_SESSION_INVALIDATED_EVENT, invalidated); vi.stubGlobal('window', w); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('uses fixed closed selector-free current/choice reads and never sends roles or write requests', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ state: 'RESOLVED', ...a })).mockResolvedValueOnce(response({ state: 'SELECTION_REQUIRED', schools: [a, b].map((s, i) => ({ ...s, organizationName: `Org ${i}`, schoolName: `School ${i}` })) }));
  expect(await schoolEntryApi.current(signal())).toEqual({ state: 'RESOLVED', ...a }); expect((await schoolEntryApi.choices(signal())).state).toBe('SELECTION_REQUIRED');
  expect(f.mock.calls.map(([p]) => p)).toEqual(['/api/v1/staff/current-reporting-school', '/api/v1/staff/reporting-schools']);
  for (const [, options] of f.mock.calls) expect(options).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: expect.any(AbortSignal) });
});
it.each([401, 403, 404, 409, 503])('HTTP %s is never an empty school list; only 401 invalidates the session', async status => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ state: 'MANUAL_ENTRY_REQUIRED' }, status));
  await expect(schoolEntryApi.current(signal())).rejects.toMatchObject({ kind: status === 401 ? 'SESSION' : status === 403 ? 'DENIED' : 'UNAVAILABLE' });
  expect(invalidated).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
});
it('verifies the exact current identity, rejects changed users and exposes no raw server error', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response({ externalSubject: 'owner-a', displayName: 'PRIVATE' }));
  await expect(schoolEntryApi.identity('owner-a', signal())).resolves.toBeUndefined();
  await expect(schoolEntryApi.identity('owner-b', signal())).rejects.toMatchObject({ kind: 'IDENTITY' });
  f.mockResolvedValue(response({ externalSubject: 'owner-a', role: 'OWNER' })); await expect(schoolEntryApi.identity('owner-a', signal())).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
});
it('reuses the exact-school aggregate validator and retains no report values', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: { operationalSnapshot: report }, meta: {} }));
  await expect(schoolEntryApi.verifySchool(a, signal())).resolves.toBeUndefined();
  expect(f.mock.calls[0]![0]).toBe(`/api/v1/organizations/${a.organizationId}/schools/${a.schoolId}/reports/operations`);
  await expect(schoolEntryApi.verifySchool(b, signal())).rejects.toThrow();
  f.mockResolvedValue(Response.json({ data: { operationalSnapshot: { ...report, students: [{ name: 'PRIVATE' }] } }, meta: {} }));
  await expect(schoolEntryApi.verifySchool(a, signal())).rejects.toThrow();
});
it('rejects expanded and unsupported selection contracts rather than inventing eligibility', async () => {
  const f = vi.spyOn(globalThis, 'fetch');
  for (const data of [{ state: 'RESOLVED', ...a, role: 'OWNER' }, { state: 'RESOLVED', ...a, schoolId: 'forged' }, { state: 'MANUAL_ENTRY_REQUIRED', schools: [a] }, { state: 'SUSPENDED', ...a }]) {
    f.mockResolvedValue(response(data)); await expect(schoolEntryApi.current(signal())).rejects.toThrow();
  }
});
it('refuses redirects, missing cache controls, malformed and oversized results', async () => {
  const f = vi.spyOn(globalThis, 'fetch');
  const redirected = response({ state: 'RESOLVED', ...a }); Object.defineProperty(redirected, 'redirected', { value: true });
  for (const reply of [redirected, Response.json({ data: { state: 'RESOLVED', ...a } }), new Response('{bad', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }), response({ state: 'RESOLVED', ...a, private: 'x'.repeat(17000) })]) {
    f.mockResolvedValue(reply); await expect(schoolEntryApi.current(signal())).rejects.toThrow();
  }
});
it('enforces the stream limit even when oversized content is otherwise valid closed JSON plus whitespace', async () => {
  const valid = JSON.stringify({ data: { state: 'RESOLVED', ...a } });
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(valid + ' '.repeat(65536 - valid.length), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }));
  await expect(schoolEntryApi.current(signal())).resolves.toEqual({ state: 'RESOLVED', ...a });
  f.mockResolvedValue(new Response(valid + ' '.repeat(65537), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': '1' } }));
  await expect(schoolEntryApi.current(signal())).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
});
it('cancels a stalled response body on read invalidation', async () => {
  const cancel = vi.fn(), abort = new AbortController();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }));
  const task = schoolEntryApi.current(abort.signal); await Promise.resolve(); abort.abort(); await expect(task).rejects.toThrow(); expect(cancel).toHaveBeenCalledOnce();
});
