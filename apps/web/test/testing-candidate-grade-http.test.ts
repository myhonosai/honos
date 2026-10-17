import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestingCandidateGradeAccessError, TestingCandidateGradeRejectedError, TestingCandidateGradeUncertainError, parseTestingCandidateGrade, prepareTestingCandidateGrade,
  submitTestingCandidateGrade, validateTestingCandidateGradeDraft, type PreparedTestingCandidateGrade } from '../src/components/testing-candidate-grade-http';
const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const ids = { organizationId: id('1'), schoolId: id('2'), candidateId: id('a') };
const command = prepareTestingCandidateGrade(ids, 'PASSED', 3, '  Private note  ', id('9'));
const candidate = { id: ids.candidateId, testingEventId: id('3'), studentCurriculumEnrollmentId: id('4'), targetRankId: id('5'), result: 'PASSED', instructorNotes: 'Private note', version: 4, createdAt: '2026-10-16T12:00:00.123456+00:00' };
const envelope = (data: unknown, replayed = false) => ({ data, meta: { requestId: id('8'), correlationId: id('8'), replayed } });
const response = (data: unknown = candidate, replayed = false) => Response.json(envelope(data, replayed), { status: 200 });
afterEach(() => vi.restoreAllMocks());

describe('bounded canonical candidate outcome transport', () => {
  it('sends only the exact existing POST, closed body and testing marker; explicit replay sends identical bytes/key without allocation', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response()).mockResolvedValueOnce(response(candidate, true)); const allocate = vi.spyOn(crypto, 'randomUUID');
    for (const replayed of [false, true]) expect(await submitTestingCandidateGrade(command)).toEqual({ candidate, replayed });
    expect(fetcher.mock.calls[0]).toEqual([`/api/v1/organizations/${ids.organizationId}/schools/${ids.schoolId}/testing/candidates/${ids.candidateId}/grade`, {
      method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': id('9'), 'X-HON-Human-Command': 'testing' },
      body: JSON.stringify({ result: 'PASSED', instructorNotes: 'Private note', expectedVersion: 3 }),
    }]);
    expect(fetcher.mock.calls[1]).toEqual(fetcher.mock.calls[0]); expect(allocate).not.toHaveBeenCalled(); expect(Object.isFrozen(command)).toBe(true); expect(Object.isFrozen(command.ids)).toBe(true);
    const receipt = parseTestingCandidateGrade(envelope(candidate), command, 200); expect(Object.isFrozen(receipt)).toBe(true); expect(Object.isFrozen(receipt.candidate)).toBe(true);
  });
  it('bounds three exact UUIDs, a closed outcome, safe positive expected version and bounded normalized note without discovery', () => {
    for (const field of Object.keys(ids)) for (const bad of ['', 'Name', ' ' + id('1'), id('1') + '\n', id('1') + '?x=1', 'https://evil.test/' + id('1'), null, ['UUID']]) expect(() => validateTestingCandidateGradeDraft({ ...ids, [field]: bad } as typeof ids, 'PASSED', 3, '')).toThrow();
    for (const result of ['', 'PENDING', 'passed', 'READY', null, 1, ['PASSED']]) expect(() => validateTestingCandidateGradeDraft(ids, result, 3, '')).toThrow();
    for (const version of [0, -1, 1.1, '3', null, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) expect(() => validateTestingCandidateGradeDraft(ids, 'PASSED', version, '')).toThrow();
    expect(validateTestingCandidateGradeDraft(ids, 'PASSED', Number.MAX_SAFE_INTEGER - 1, '').expectedVersion).toBe(Number.MAX_SAFE_INTEGER - 1);
    expect(() => validateTestingCandidateGradeDraft({ ...ids, source: 'HUMAN_UI' } as typeof ids, 'PASSED', 3, '')).toThrow();
    for (const note of ['x'.repeat(2001), '\u0000', '\u007f', null, { actor: id('1') }]) expect(() => validateTestingCandidateGradeDraft(ids, 'PASSED', 3, note)).toThrow();
    for (const result of ['PASSED', 'DEFERRED', 'NOT_PASSED', 'WITHDRAWN']) expect(validateTestingCandidateGradeDraft(ids, result, 1, ' \n\t ')).toEqual({ result, expectedVersion: 1 });
    expect(validateTestingCandidateGradeDraft(ids, 'PASSED', 3, 'x'.repeat(2000)).instructorNotes).toHaveLength(2000);
    expect(prepareTestingCandidateGrade(Object.fromEntries(Object.entries(ids).map(([field, value]) => [field, value.toUpperCase()])) as typeof ids, 'PASSED', 3, '  Private note  ', id('9'))).toEqual(command);
  });
  it('rejects forged paths, bodies, selectors, authority and keys before any I/O', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const path of ['https://evil.test' + command.path, '//evil.test' + command.path, command.path + '?x=1', command.path + '#x', command.path + '/', command.path.replace('/grade', '/promotion-decision'), command.path.replace('/candidates/', '/candidates/../candidates/')]) await expect(submitTestingCandidateGrade({ ...command, path })).rejects.toThrow();
    await expect(submitTestingCandidateGrade({ ...command, key: id('9') + '\n' })).rejects.toThrow();
    for (const patch of [{ key: 'manual' }, { key: id('9').replace('-4999-', '-1999-') }, { key: id('a').toUpperCase() }, { ids: { ...ids, schoolId: id('b') } }, { ids: { ...ids, candidateId: id('b') } }, { body: ' ' + command.body }, { body: '{invalid' }, { body: JSON.stringify({ ...JSON.parse(command.body), source: 'HUMAN_UI' }) }, { body: JSON.stringify({ ...JSON.parse(command.body), result: 'PENDING' }) }, { body: JSON.stringify({ ...JSON.parse(command.body), expectedVersion: '3' }) }, { body: JSON.stringify({ expectedVersion: 3, result: 'PASSED', instructorNotes: 'Private note' }) }, { body: 'x'.repeat(20001) }, { method: 'GET' }]) await expect(submitTestingCandidateGrade({ ...command, ...patch } as PreparedTestingCandidateGrade)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('accepts each closed outcome only at expectedVersion+1 including original-version replays', () => {
    for (const result of ['PASSED', 'DEFERRED', 'NOT_PASSED', 'WITHDRAWN']) for (const replayed of [false, true]) {
      const prepared = prepareTestingCandidateGrade(ids, result, 3, 'Private note', id('9'));
      expect(parseTestingCandidateGrade(envelope({ ...candidate, result }, replayed), prepared, 200)).toEqual({ candidate: { ...candidate, result }, replayed });
    }
    // A replay must not manufacture a later live version or increment again.
    for (const replayed of [false, true]) for (const version of [1, 3, 5, '4', 4.1, null]) expect(() => parseTestingCandidateGrade(envelope({ ...candidate, version }, replayed), command, 200)).toThrow();
  });
  it('requires a wholly closed matching candidate/note/version envelope; never accepts partial/private/downstream facts', () => {
    for (const patch of [{ id: candidate.id + '\n' }, { createdAt: candidate.createdAt + '\n' }]) expect(() => parseTestingCandidateGrade(envelope({ ...candidate, ...patch }), command, 200)).toThrow();
    for (const patch of [{ id: id('b') }, { testingEventId: 'Name' }, { studentCurriculumEnrollmentId: 'Name' }, { targetRankId: 'Name' }, ...['PENDING', 'DEFERRED', 'NOT_PASSED', 'WITHDRAWN', 'READY'].map(result => ({ result })), { createdAt: 'yesterday' }, { createdAt: '2026-02-30T00:00:00Z' }, { createdAt: '2026-10-16T24:00:00Z' }, { createdAt: '2026-10-16T12:00:00+14:30' }, { instructorNotes: 'Changed' }, { instructorNotes: null }, { actorPrincipalId: id('b') }, { audit: {} }, { eligible: true }, { promoted: true }, { certificate: {} }]) expect(() => parseTestingCandidateGrade(envelope({ ...candidate, ...patch }), command, 200)).toThrow();
    for (const field of Object.keys(candidate)) { const copy = { ...candidate } as Record<string, unknown>; delete copy[field]; expect(() => parseTestingCandidateGrade(envelope(copy), command, 200)).toThrow(); }
    const { instructorNotes: _notes, ...withoutNote } = candidate; const empty = prepareTestingCandidateGrade(ids, 'PASSED', 3, '', id('9'));
    expect(parseTestingCandidateGrade(envelope(withoutNote), empty, 200).candidate).toEqual(withoutNote); expect(() => parseTestingCandidateGrade(envelope(candidate), empty, 200)).toThrow();
    for (const value of [null, [envelope(candidate)], { ...envelope(candidate), authority: 'SECRET' }, { ...envelope(candidate), meta: { ...envelope(candidate).meta, source: 'AI' } }, { ...envelope(candidate), meta: { ...envelope(candidate).meta, correlationId: id('b') } }, { ...envelope(candidate), meta: { ...envelope(candidate).meta, replayed: 'false' } }]) expect(() => parseTestingCandidateGrade(value, command, 200)).toThrow();
    for (const status of [201, 202, 204, 302]) for (const replayed of [false, true]) expect(() => parseTestingCandidateGrade(envelope(candidate, replayed), command, status)).toThrow();
  });
  it('distinguishes access clear, definite version/reused-key rejection and in-progress uncertainty without error leaks or automatic retry', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const status of [401, 403]) { fetcher.mockResolvedValueOnce(Response.json({ detail: 'SQL_SECRET' }, { status })); await expect(submitTestingCandidateGrade(command)).rejects.toMatchObject({ status }); }
    for (const status of [400, 404, 405, 409, 413, 415, 422]) { fetcher.mockResolvedValueOnce(Response.json({ code: 'VERSION_CONFLICT', detail: 'SQL_SECRET' }, { status })); await expect(submitTestingCandidateGrade(command)).rejects.toBeInstanceOf(TestingCandidateGradeRejectedError); }
    fetcher.mockResolvedValueOnce(Response.json({ code: 'IDEMPOTENCY_IN_PROGRESS', detail: 'SQL_SECRET' }, { status: 409 })); await expect(submitTestingCandidateGrade(command)).rejects.toBeInstanceOf(TestingCandidateGradeUncertainError);
    fetcher.mockResolvedValueOnce(new Response('{invalid', { status: 409, headers: { 'Content-Type': 'application/json' } })); await expect(submitTestingCandidateGrade(command)).rejects.not.toThrow('invalid');
    fetcher.mockRejectedValueOnce(new Error('NETWORK_SECRET')); await expect(submitTestingCandidateGrade(command)).rejects.not.toThrow('NETWORK_SECRET');
    expect(fetcher).toHaveBeenCalledTimes(12); expect(new TestingCandidateGradeAccessError(401).message).not.toContain('SQL_SECRET');
  });
  it('treats malformed, oversized, wrong-type, redirected, mismatched or wrong-status success as uncertain', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const cases = [new Response('{invalid', { status: 200, headers: { 'Content-Type': 'application/json' } }), new Response('x'.repeat(20001), { status: 200, headers: { 'Content-Type': 'application/json' } }), new Response(JSON.stringify(envelope(candidate)), { status: 200, headers: { 'Content-Type': 'text/html' } }), ...[201, 202, 204, 302, 503].map(status => new Response(null, { status })), response({ ...candidate, eligibility: true }), response({ ...candidate, version: 5 }, true)];
    const redirected = response(); Object.defineProperty(redirected, 'redirected', { value: true }); cases.push(redirected);
    for (const item of cases) { fetcher.mockResolvedValueOnce(item); await expect(submitTestingCandidateGrade(command)).rejects.toBeInstanceOf(TestingCandidateGradeUncertainError); }
    expect(fetcher).toHaveBeenCalledTimes(cases.length);
  });
});
