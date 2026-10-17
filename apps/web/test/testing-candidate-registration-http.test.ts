import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestingCandidateAccessError, TestingCandidateRejectedError, TestingCandidateUncertainError, parseTestingCandidateRegistration, prepareTestingCandidateRegistration,
  submitTestingCandidateRegistration, validateTestingCandidateDraft, type PreparedTestingCandidateRegistration } from '../src/components/testing-candidate-registration-http';
const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const ids = { organizationId: id('1'), schoolId: id('2'), testingEventId: id('3'), studentCurriculumEnrollmentId: id('4'), targetRankId: id('5') };
const command = prepareTestingCandidateRegistration(ids, '  Private note  ', id('9'));
const candidate = { id: id('a'), testingEventId: ids.testingEventId, studentCurriculumEnrollmentId: ids.studentCurriculumEnrollmentId, targetRankId: ids.targetRankId, result: 'PENDING', instructorNotes: 'Private note', version: 1, createdAt: '2026-10-16T12:00:00.123456+00:00' };
const envelope = (data: unknown, replayed = false) => ({ data, meta: { requestId: id('8'), correlationId: id('8'), replayed } });
const response = (data: unknown = candidate, replayed = false) => Response.json(envelope(data, replayed), { status: replayed ? 200 : 201 });
afterEach(() => vi.restoreAllMocks());

describe('bounded canonical candidate registration transport', () => {
  it('uses only the existing exact POST/body/marker and a frozen prepared command without allocating keys or reading', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response()).mockResolvedValueOnce(response(candidate, true)); const allocate = vi.spyOn(crypto, 'randomUUID');
    for (const replayed of [false, true]) expect(await submitTestingCandidateRegistration(command)).toEqual({ candidate, replayed });
    expect(fetcher.mock.calls[0]).toEqual([`/api/v1/organizations/${ids.organizationId}/schools/${ids.schoolId}/testing/events/${ids.testingEventId}/candidates`, {
      method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': id('9'), 'X-HON-Human-Command': 'testing' },
      body: JSON.stringify({ studentCurriculumEnrollmentId: ids.studentCurriculumEnrollmentId, targetRankId: ids.targetRankId, instructorNotes: 'Private note' }),
    }]);
    expect(fetcher.mock.calls[1]).toEqual(fetcher.mock.calls[0]); expect(allocate).not.toHaveBeenCalled(); expect(Object.isFrozen(command)).toBe(true); expect(Object.isFrozen(command.ids)).toBe(true);
    const receipt = parseTestingCandidateRegistration(envelope(candidate), command, 201); expect(Object.isFrozen(receipt)).toBe(true); expect(Object.isFrozen(receipt.candidate)).toBe(true);
  });
  it('bounds only local UUIDs and notes; normalizes canonical notes without authority, eligibility or ID selection', () => {
    for (const field of Object.keys(ids)) for (const bad of ['', 'Name', ' ' + id('1'), id('1') + '?x=1', 'https://evil.test/' + id('1'), null, ['UUID']]) expect(() => validateTestingCandidateDraft({ ...ids, [field]: bad } as typeof ids, '')).toThrow();
    expect(() => validateTestingCandidateDraft({ ...ids, source: 'HUMAN_UI' } as typeof ids, '')).toThrow();
    for (const note of ['x'.repeat(2001), '\u0000', '\u007f', null, { actor: id('1') }]) expect(() => validateTestingCandidateDraft(ids, note)).toThrow();
    expect(validateTestingCandidateDraft(ids, ' \n\t ')).toEqual({ studentCurriculumEnrollmentId: ids.studentCurriculumEnrollmentId, targetRankId: ids.targetRankId });
    expect(validateTestingCandidateDraft(ids, 'x'.repeat(2000)).instructorNotes).toHaveLength(2000);
    expect(prepareTestingCandidateRegistration(Object.fromEntries(Object.entries(ids).map(([field, value]) => [field, value.toUpperCase()])) as typeof ids, '  Private note  ', id('9'))).toEqual(command);
  });
  it('rejects any forged path/body/order/key/selector/authority before I/O', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const path of ['https://evil.test' + command.path, '//evil.test' + command.path, command.path + '?x=1', command.path + '/', command.path.replace('/candidates', '/roster'), command.path.replace('/events/', '/events/../events/')]) await expect(submitTestingCandidateRegistration({ ...command, path })).rejects.toThrow();
    for (const patch of [{ key: 'manual' }, { key: id('9').replace('-4999-', '-1999-') }, { ids: { ...ids, schoolId: id('b') } }, { ids: { ...ids, targetRankId: id('b') } }, { body: ' ' + command.body }, { body: '{invalid' }, { body: JSON.stringify({ ...JSON.parse(command.body), source: 'HUMAN_UI' }) }, { body: JSON.stringify({ ...JSON.parse(command.body), result: 'PENDING' }) }, { body: JSON.stringify({ targetRankId: ids.targetRankId, studentCurriculumEnrollmentId: ids.studentCurriculumEnrollmentId, instructorNotes: 'Private note' }) }, { body: 'x'.repeat(20001) }, { method: 'GET' }]) await expect(submitTestingCandidateRegistration({ ...command, ...patch } as PreparedTestingCandidateRegistration)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('accepts only a closed canonical PENDING/version-one receipt matching event, enrollment, rank and exact trimmed note', () => {
    for (const patch of [{ id: 'Name' }, { testingEventId: id('b') }, { studentCurriculumEnrollmentId: id('b') }, { targetRankId: id('b') }, ...['PASSED', 'DEFERRED', 'NOT_PASSED', 'WITHDRAWN', 'READY'].map(result => ({ result })), { version: 2 }, { version: '1' }, { version: 0 }, { createdAt: 'yesterday' }, { createdAt: '2026-02-30T00:00:00Z' }, { createdAt: '2026-10-16T24:00:00Z' }, { createdAt: '2026-10-16T12:00:00+14:30' }, { instructorNotes: 'Changed' }, { instructorNotes: null }, { actorPrincipalId: id('b') }, { audit: {} }, { eligible: true }, { capacity: 1 }]) expect(() => parseTestingCandidateRegistration(envelope({ ...candidate, ...patch }), command, 201)).toThrow();
    for (const field of Object.keys(candidate)) { const copy = { ...candidate } as Record<string, unknown>; delete copy[field]; expect(() => parseTestingCandidateRegistration(envelope(copy), command, 201)).toThrow(); }
    const { instructorNotes: _notes, ...withoutNote } = candidate; const empty = prepareTestingCandidateRegistration(ids, '', id('9'));
    expect(parseTestingCandidateRegistration(envelope(withoutNote), empty, 201).candidate).toEqual(withoutNote);
    expect(() => parseTestingCandidateRegistration(envelope(candidate), empty, 201)).toThrow();
    for (const value of [null, [envelope(candidate)], { ...envelope(candidate), authority: 'SECRET' }, { ...envelope(candidate), meta: { ...envelope(candidate).meta, source: 'AI' } }, { ...envelope(candidate), meta: { ...envelope(candidate).meta, correlationId: id('b') } }, { ...envelope(candidate), meta: { ...envelope(candidate).meta, replayed: 'false' } }]) expect(() => parseTestingCandidateRegistration(value, command, 201)).toThrow();
    expect(() => parseTestingCandidateRegistration(envelope(candidate, true), command, 201)).toThrow(); expect(() => parseTestingCandidateRegistration(envelope(candidate), command, 200)).toThrow();
  });
  it('separates access loss, definite rejection and the existing in-progress-key uncertainty without raw error display or automatic retry', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const status of [401, 403]) { fetcher.mockResolvedValueOnce(Response.json({ detail: 'SQL_SECRET' }, { status })); await expect(submitTestingCandidateRegistration(command)).rejects.toMatchObject({ status }); }
    for (const status of [400, 404, 405, 409, 413, 415, 422]) { fetcher.mockResolvedValueOnce(Response.json({ code: 'TESTING_CANDIDATE_ALREADY_REGISTERED', detail: 'SQL_SECRET' }, { status })); await expect(submitTestingCandidateRegistration(command)).rejects.toBeInstanceOf(TestingCandidateRejectedError); }
    fetcher.mockResolvedValueOnce(Response.json({ code: 'IDEMPOTENCY_IN_PROGRESS', detail: 'SQL_SECRET' }, { status: 409 })); await expect(submitTestingCandidateRegistration(command)).rejects.toBeInstanceOf(TestingCandidateUncertainError);
    fetcher.mockResolvedValueOnce(new Response('{invalid', { status: 409, headers: { 'Content-Type': 'application/json' } })); await expect(submitTestingCandidateRegistration(command)).rejects.not.toThrow('invalid');
    fetcher.mockRejectedValueOnce(new Error('NETWORK_SECRET')); await expect(submitTestingCandidateRegistration(command)).rejects.not.toThrow('NETWORK_SECRET');
    expect(fetcher).toHaveBeenCalledTimes(12); expect(new TestingCandidateAccessError(401).message).not.toContain('SQL_SECRET');
  });
  it('declines malformed, oversized, wrong-type, redirected, mismatched or noncanonical HTTP success as uncertain', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const cases = [new Response('{invalid', { status: 201, headers: { 'Content-Type': 'application/json' } }), new Response('x'.repeat(20001), { status: 201, headers: { 'Content-Type': 'application/json' } }), new Response(JSON.stringify(envelope(candidate)), { status: 201, headers: { 'Content-Type': 'text/html' } }), ...[200, 202, 204, 302, 503].map(status => new Response(null, { status })), response({ ...candidate, eligibility: true }), Response.json(envelope(candidate, true), { status: 201 })];
    const redirected = response(); Object.defineProperty(redirected, 'redirected', { value: true }); cases.push(redirected);
    for (const item of cases) { fetcher.mockResolvedValueOnce(item); await expect(submitTestingCandidateRegistration(command)).rejects.toBeInstanceOf(TestingCandidateUncertainError); }
    expect(fetcher).toHaveBeenCalledTimes(cases.length);
  });
});
