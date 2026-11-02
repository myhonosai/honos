import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JourneyError } from '../src/components/crm-journey/http';
import { parseTrialConflict, readTrialDetail, readTrialRecovery } from '../src/components/crm-journey/trial-recovery-http';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { organizationId: id(1), schoolId: id(2) }, lead = id(3);
const row = (patch: Record<string, unknown> = {}) => ({ id: id(8), crmLeadId: lead, appointmentType: 'TRIAL', status: 'SCHEDULED', startsAt: '2026-01-01T09:00:00.000Z', endsAt: '2026-01-01T10:00:00.000Z', createdByPrincipalId: id(6), version: 4, createdAt: '2025-12-01T12:00:00.000Z', updatedAt: '2026-01-01T11:00:00.000Z', ...patch });
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' };
const response = (data: unknown, patch: Record<string, unknown> = {}) => new Response(JSON.stringify({ data, meta: { requestId: id(20), correlationId: id(20) }, ...patch }), { headers });
const signal = () => new AbortController().signal;
const read = () => readTrialRecovery(scope, lead, signal());
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('reads only the actual fixed GET list path with no command/authority headers and private no-store behavior', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ activeTrial: null, trials: [] }));
  expect(await read()).toEqual({ activeTrial: null, trials: [] });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]![0]).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/crm/leads/${lead}/trials`);
  expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } });
  expect(Object.keys(fetcher.mock.calls[0]![1]!.headers!)).toEqual(['Accept']);
  expect(fetcher.mock.calls[0]![1]!.body).toBeUndefined();
});

it.each(['SCHEDULED','CANCELLED','COMPLETED','NO_SHOW'])('accepts saved %s detail at version greater than one without receipt or future-clock inference', async status => {
  const saved = row({ status }); const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(saved));
  expect(await readTrialDetail(scope, lead, saved.id, signal())).toEqual(saved);
  expect(fetcher.mock.calls[0]![0]).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/crm/appointments/${saved.id}`);
});

it('preserves saved optional text and PostgreSQL character limits without applying new-command normalization', async () => {
  const saved = row({ location: '  Existing room  ', notes: '🥋'.repeat(2000) });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(saved));
  expect(await readTrialDetail(scope, lead, saved.id, signal())).toEqual(saved);
});

it('keeps a separately verified older active trial outside a full newest-50 history', async () => {
  const trials = Array.from({ length: 50 }, (_, n) => row({ id: id(100 - n), status: 'CANCELLED', createdAt: '2026-02-01T00:00:00.000Z', location: '🥋'.repeat(160), notes: '🥋'.repeat(2000) }));
  const activeTrial = row(); vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ activeTrial, trials }));
  const result = await read(); expect(result.trials).toHaveLength(50); expect(result.activeTrial).toEqual(activeTrial);
  expect(result.trials.some(r => r.id === activeTrial.id)).toBe(false);
});

it('preserves backend history order and validates creation instants rather than startsAt or updatedAt', async () => {
  const trials = [row({ id: id(9), createdAt: '2026-02-02T00:00:00.000Z', startsAt: '2020-01-01T00:00:00.000Z' }), row({ id: id(8), createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2029-01-01T00:00:00.000Z' })];
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ activeTrial: null, trials }));
  expect((await read()).trials.map(r => r.id)).toEqual([id(9), id(8)]);
});

it('preserves ascending UUIDs at equal serialized times because distinct PostgreSQL microseconds can collapse to one JS millisecond', async () => {
  const trials = [row({ id: id(7) }), row({ id: id(8) })];
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ activeTrial: null, trials }));
  expect((await read()).trials.map(r => r.id)).toEqual([id(7), id(8)]);
});

it.each([
  { activeTrial: null, trials: Array.from({ length: 51 }, (_, n) => row({ id: id(n + 100) })) },
  { activeTrial: null, trials: [row(), row()] },
  { activeTrial: null, trials: [row(), row({ id: id(7), createdAt: '2026-02-01T00:00:00.000Z' })] },
  { activeTrial: null, trials: [row({ crmLeadId: id(99) })] },
  { activeTrial: row({ crmLeadId: id(99) }), trials: [] },
  { activeTrial: row({ status: 'COMPLETED' }), trials: [] },
  { activeTrial: row({ version: 5 }), trials: [row()] },
  { activeTrial: null, trials: [], complete: true },
])('rejects inconsistent, foreign, duplicate, unsorted or enhanced recovery data %#', async data => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(data));
  await expect(read()).rejects.toMatchObject({ kind: 'READ' });
});

it.each([
  { version: 0 }, { version: 1.5 }, { version: Number.MAX_SAFE_INTEGER + 1 }, { status: 'BOOKED' }, { appointmentType: 'CONSULTATION' },
  { id: 'not-an-id' }, { createdByPrincipalId: 'forged' }, { crmLeadId: id(99) }, { createdAt: '2026-02-30T00:00:00.000Z' },
  { startsAt: 'yesterday' }, { endsAt: '2026-01-01T09:00:00.000Z' }, { updatedAt: '2026-01-01' }, { location: 'x'.repeat(161) }, { notes: 'x'.repeat(2001) }, { extra: true },
])('rejects malformed saved detail %#', async patch => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(row(patch)));
  await expect(readTrialDetail(scope, lead, id(8), signal())).rejects.toMatchObject({ kind: 'READ' });
});

it('binds detail to both the requested appointment and exact lead', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(row({ id: id(9) })));
  await expect(readTrialDetail(scope, lead, id(8), signal())).rejects.toMatchObject({ kind: 'READ' });
});

it.each([
  { meta: { requestId: id(20), correlationId: id(21) } }, { meta: { requestId: 'forged', correlationId: 'forged' } },
  { meta: { requestId: id(20), correlationId: id(20), replayed: false } }, { meta: null }, { extra: true },
])('requires the exact read envelope and equal verified UUID metadata %#', async patch => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ activeTrial: null, trials: [] }, patch));
  await expect(read()).rejects.toMatchObject({ kind: 'READ' });
});

it.each([401,403,404,409,503])('maps HTTP %s without reading error bodies, exposing detail or automatically retrying', async status => {
  let invalidations = 0; window.addEventListener(HON_SESSION_INVALIDATED_EVENT, () => invalidations++);
  const result = new Response('PRIVATE_UPSTREAM_DETAIL', { status }); const body = vi.spyOn(result, 'text');
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(result);
  await expect(read()).rejects.toMatchObject({ kind: status === 401 ? 'SESSION' : status === 403 ? 'DENIED' : 'READ', status });
  expect(invalidations).toBe(status === 401 ? 1 : 0); expect(body).not.toHaveBeenCalled(); expect(result.bodyUsed).toBe(false); expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([
  new Response('{}', { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'private, no-store' } }),
  new Response('{}', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, no-store' } }),
  new Response('{}', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private' } }),
  new Response('{', { headers }),
])('rejects unverified content/cache policies and malformed JSON %#', async result => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(result); await expect(read()).rejects.toMatchObject({ kind: 'READ' });
});

it('refuses redirected or different-origin responses and sanitizes transport exceptions', async () => {
  vi.stubGlobal('location', { origin: 'https://hon.example' });
  const fetcher = vi.spyOn(globalThis, 'fetch');
  const redirected = response({ activeTrial: null, trials: [] }); Object.defineProperty(redirected, 'redirected', { value: true });
  const foreign = response({ activeTrial: null, trials: [] }); Object.defineProperty(foreign, 'url', { value: 'https://evil.example/private' });
  for (const result of [redirected, foreign]) { fetcher.mockReset().mockResolvedValue(result); await expect(read()).rejects.toMatchObject({ kind: 'READ' }); expect(fetcher).toHaveBeenCalledTimes(1); }
  fetcher.mockReset().mockRejectedValue(new Error('PRIVATE_UPSTREAM_DETAIL'));
  await expect(read()).rejects.toMatchObject({ message: 'READ' }); expect(fetcher).toHaveBeenCalledTimes(1);
});

it('rejects invalid selectors before any request', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  await expect(readTrialRecovery(scope, 'x?school=other', signal())).rejects.toBeInstanceOf(JourneyError);
  await expect(readTrialDetail({ ...scope, schoolId: 'wrong' }, lead, id(8), signal())).rejects.toMatchObject({ kind: 'READ' });
  await expect(readTrialDetail(scope, lead, 'invalid', signal())).rejects.toMatchObject({ kind: 'READ' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('propagates caller cancellation, does not start an aborted read, and bounds the request with a timeout', async () => {
  const caller = new AbortController(), deadline = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => { expect(ms).toBe(15000); return deadline.signal; });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_path, options) => {
    caller.abort(); expect(options?.signal?.aborted).toBe(true); return response({ activeTrial: null, trials: [] });
  });
  await expect(readTrialRecovery(scope, lead, caller.signal)).rejects.toMatchObject({ kind: 'READ' });
  fetcher.mockClear(); await expect(readTrialRecovery(scope, lead, caller.signal)).rejects.toMatchObject({ kind: 'READ' }); expect(fetcher).not.toHaveBeenCalled();
});

it('cancels a stalled response body on timeout and discards a late response', async () => {
  const deadline = new AbortController(); vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  let opened!: () => void, cancelled = false; const ready = new Promise<void>(resolve => { opened = resolve; });
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const getReader = body.getReader.bind(body); vi.spyOn(body, 'getReader').mockImplementation(() => { opened(); return getReader(); });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { headers }));
  const pending = read(); await ready; deadline.abort(); await expect(pending).rejects.toMatchObject({ kind: 'READ' }); expect(cancelled).toBe(true);
});

it('bounds actual response bytes rather than trusting Content-Length and rejects invalid UTF-8', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(reader) { reader.enqueue(new Uint8Array(512 * 1024 + 1)); }, cancel() { cancelled = true; } });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { headers: { ...headers, 'Content-Length': '1' } }));
  await expect(read()).rejects.toMatchObject({ kind: 'READ' }); expect(cancelled).toBe(true);
  fetcher.mockResolvedValue(new Response(new Uint8Array([0xff, 0xfe]), { headers })); await expect(read()).rejects.toMatchObject({ kind: 'READ' });
});

it('returns only the recognized existing conflict row, independently of proposed times and without raw detail', () => {
  const existing = row({ version: 7, location: 'Existing room', notes: 'Saved note' });
  expect(parseTrialConflict({ code: 'TRIAL_ALREADY_SCHEDULED', detail: 'PRIVATE_UPSTREAM_DETAIL', existingAppointment: existing }, lead)).toEqual(existing);
  expect(JSON.stringify(parseTrialConflict({ code: 'TRIAL_ALREADY_SCHEDULED', detail: 'PRIVATE_UPSTREAM_DETAIL', existingAppointment: existing }, lead))).not.toContain('PRIVATE_UPSTREAM_DETAIL');
  for (const value of [null, {}, { code: 'OTHER_CONFLICT' }, 'TRIAL_ALREADY_SCHEDULED']) expect(parseTrialConflict(value, lead)).toBeNull();
});

it.each([
  { detail: undefined }, { detail: {} }, { existingAppointment: undefined }, { existingAppointment: row({ crmLeadId: id(99) }) },
  { existingAppointment: row({ status: 'CANCELLED' }) }, { existingAppointment: row({ version: 0 }) }, { extra: 'not accepted' },
])('throws for malformed recognized conflict instead of falling back to a different command %#', patch => {
  expect(() => parseTrialConflict({ code: 'TRIAL_ALREADY_SCHEDULED', detail: 'Current trial exists.', existingAppointment: row(), ...patch }, lead)).toThrow(JourneyError);
});
