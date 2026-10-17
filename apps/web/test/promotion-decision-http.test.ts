import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromotionDecisionAccessError, PromotionDecisionRejectedError, PromotionDecisionUncertainError, parsePromotionDecision, preparePromotionDecision,
  submitPromotionDecision, validatePromotionDecisionDraft, type PreparedPromotionDecision } from '../src/components/promotion-decision-http';
const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const ids = { organizationId: id('1'), schoolId: id('2'), candidateId: id('a') };
const command = preparePromotionDecision(ids, 3, 'PROMOTED', '  Final rationale  ', id('9'));
const decision = { id: id('3'), testingCandidateId: ids.candidateId, studentCurriculumEnrollmentId: id('4'), priorRankId: id('5'), targetRankId: id('6'), status: 'PROMOTED', instructorPrincipalId: id('7'), rationale: 'Final rationale', decidedAt: '2026-10-16T12:00:00.123456+00:00', version: 1, createdAt: '2026-10-16T12:00:00.123456+00:00' };
const envelope = (data: unknown, replayed = false) => ({ data, meta: { requestId: id('8'), correlationId: id('8'), replayed } });
const response = (data: unknown = decision, replayed = false) => Response.json(envelope(data, replayed), { status: replayed ? 200 : 201 });
afterEach(() => vi.restoreAllMocks());

describe('bounded canonical promotion-decision transport', () => {
  it('sends the required expectedVersion in the exact relative POST body, no-store posture and testing marker; explicit replay sends identical bytes/key', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response()).mockResolvedValueOnce(response(decision, true)); const allocate = vi.spyOn(crypto, 'randomUUID');
    expect(await submitPromotionDecision(command)).toEqual({ decision: { id: decision.id, testingCandidateId: decision.testingCandidateId, studentCurriculumEnrollmentId: decision.studentCurriculumEnrollmentId, priorRankId: decision.priorRankId, targetRankId: decision.targetRankId, status: 'PROMOTED', decidedAt: decision.decidedAt, version: 1, createdAt: decision.createdAt }, replayed: false });
    expect((await submitPromotionDecision(command)).replayed).toBe(true);
    expect(fetcher.mock.calls[0]).toEqual([`/api/v1/organizations/${ids.organizationId}/schools/${ids.schoolId}/testing/candidates/${ids.candidateId}/promotion-decision`, {
      method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': id('9'), 'X-HON-Human-Command': 'testing' },
      body: JSON.stringify({ expectedVersion: 3, status: 'PROMOTED', rationale: 'Final rationale' }),
    }]);
    expect(fetcher.mock.calls[1]).toEqual(fetcher.mock.calls[0]); expect(allocate).not.toHaveBeenCalled();
    const receipt = parsePromotionDecision(envelope(decision), command, 201); expect(Object.isFrozen(receipt)).toBe(true); expect(Object.isFrozen(receipt.decision)).toBe(true); expect(receipt.decision).not.toHaveProperty('instructorPrincipalId'); expect(receipt.decision).not.toHaveProperty('rationale');
  });
  it('bounds exact UUIDs, positive version, closed final statuses and a required bounded rationale without discovery', () => {
    for (const field of Object.keys(ids)) for (const bad of ['', 'Name', ' ' + id('1'), id('1') + '\n', id('1') + '?x=1', null, ['UUID']]) expect(() => validatePromotionDecisionDraft({ ...ids, [field]: bad } as typeof ids, 3, 'PROMOTED', 'reason')).toThrow();
    for (const status of ['', 'PENDING', 'promoted', 'PASSED', null, 1, ['PROMOTED']]) expect(() => validatePromotionDecisionDraft(ids, 3, status, 'reason')).toThrow();
    for (const version of [0, -1, 1.1, '3', null, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) expect(() => validatePromotionDecisionDraft(ids, version, 'PROMOTED', 'reason')).toThrow();
    for (const rationale of ['', ' \n\t ', 'x'.repeat(2001), '\u0000', '\u007f', null, { actor: id('1') }]) expect(() => validatePromotionDecisionDraft(ids, 3, 'PROMOTED', rationale)).toThrow();
    for (const status of ['PROMOTED', 'DEFERRED', 'NOT_PROMOTED']) expect(validatePromotionDecisionDraft(ids, 1, status, ' rationale ').rationale).toBe('rationale');
    expect(preparePromotionDecision(Object.fromEntries(Object.entries(ids).map(([field, value]) => [field, value.toUpperCase()])) as typeof ids, 3, 'PROMOTED', '  Final rationale  ', id('9'))).toEqual(command);
  });
  it('rejects forged paths, bodies, selectors, authority fields and keys before any I/O', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const path of ['https://evil.test' + command.path, '//evil.test' + command.path, command.path + '?x=1', command.path + '#x', command.path + '/', command.path.replace('/promotion-decision', '/grade'), command.path.replace('/candidates/', '/candidates/../candidates/')]) await expect(submitPromotionDecision({ ...command, path })).rejects.toThrow();
    for (const patch of [{ key: 'manual' }, { key: id('9').replace('-4999-', '-1999-') }, { key: id('a').toUpperCase() }, { ids: { ...ids, candidateId: id('b') } }, { body: ' ' + command.body }, { body: '{invalid' }, { body: JSON.stringify({ ...JSON.parse(command.body), source: 'HUMAN_UI' }) }, { body: JSON.stringify({ ...JSON.parse(command.body), actor: id('1') }) }, { body: JSON.stringify({ status: 'PROMOTED', expectedVersion: 3, rationale: 'Final rationale' }) }, { body: 'x'.repeat(20001) }]) await expect(submitPromotionDecision({ ...command, ...patch } as PreparedPromotionDecision)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires the wholly closed canonical wire receipt, matching IDs/status/rationale and immutable version-one monotonicity', () => {
    for (const replayed of [false, true]) expect(parsePromotionDecision(envelope(decision, replayed), command, replayed ? 200 : 201)).toMatchObject({ replayed, decision: { id: decision.id, status: 'PROMOTED', version: 1 } });
    for (const patch of [{ testingCandidateId: id('b') }, { status: 'DEFERRED' }, { rationale: 'Changed' }, { version: 0 }, { version: 2 }, { instructorPrincipalId: 'private actor' }, { createdAt: 'yesterday' }, { audit: {} }, { outbox: {} }, { certificate: {} }]) expect(() => parsePromotionDecision(envelope({ ...decision, ...patch }), command, 201)).toThrow();
    for (const field of Object.keys(decision).filter(field => field !== 'priorRankId')) { const copy = { ...decision } as Record<string, unknown>; delete copy[field]; expect(() => parsePromotionDecision(envelope(copy), command, 201)).toThrow(); }
    const { priorRankId: _prior, ...withoutPrior } = decision; expect(parsePromotionDecision(envelope(withoutPrior), command, 201).decision).not.toHaveProperty('priorRankId');
    for (const value of [null, [envelope(decision)], { ...envelope(decision), authority: 'SECRET' }, { ...envelope(decision), meta: { ...envelope(decision).meta, correlationId: id('b') } }, { ...envelope(decision), meta: { ...envelope(decision).meta, replayed: 'false' } }]) expect(() => parsePromotionDecision(value, command, 201)).toThrow();
    expect(() => parsePromotionDecision(envelope(decision, false), command, 200)).toThrow(); expect(() => parsePromotionDecision(envelope(decision, true), command, 201)).toThrow();
  });
  it('distinguishes access clear, definite rejection and in-progress/transport uncertainty without automatic retry or error leakage', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const status of [401, 403]) { fetcher.mockResolvedValueOnce(Response.json({ detail: 'SQL_SECRET' }, { status })); await expect(submitPromotionDecision(command)).rejects.toMatchObject({ status }); }
    for (const status of [400, 404, 405, 409, 413, 415, 422]) { fetcher.mockResolvedValueOnce(Response.json({ code: 'VERSION_CONFLICT', detail: 'SQL_SECRET' }, { status })); await expect(submitPromotionDecision(command)).rejects.toBeInstanceOf(PromotionDecisionRejectedError); }
    fetcher.mockResolvedValueOnce(Response.json({ code: 'IDEMPOTENCY_IN_PROGRESS', detail: 'SQL_SECRET' }, { status: 409 })); await expect(submitPromotionDecision(command)).rejects.toBeInstanceOf(PromotionDecisionUncertainError);
    fetcher.mockRejectedValueOnce(new Error('NETWORK_SECRET')); await expect(submitPromotionDecision(command)).rejects.not.toThrow('NETWORK_SECRET');
    expect(new PromotionDecisionAccessError(401).message).not.toContain('SQL_SECRET');
  });
  it('treats malformed, oversized, wrong-type, redirect, wrong status or unexpected receipt as uncertain', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const cases = [new Response('{invalid', { status: 201, headers: { 'Content-Type': 'application/json' } }), new Response('x'.repeat(20001), { status: 201, headers: { 'Content-Type': 'application/json' } }), new Response(JSON.stringify(envelope(decision)), { status: 201, headers: { 'Content-Type': 'text/html' } }), ...[202, 204, 302, 503].map(status => new Response(null, { status })), response({ ...decision, version: 2 })];
    const redirected = response(); Object.defineProperty(redirected, 'redirected', { value: true }); cases.push(redirected);
    for (const item of cases) { fetcher.mockResolvedValueOnce(item); await expect(submitPromotionDecision(command)).rejects.toBeInstanceOf(PromotionDecisionUncertainError); }
  });
});
