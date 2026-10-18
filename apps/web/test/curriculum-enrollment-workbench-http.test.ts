import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CurriculumEnrollmentAccessError, CurriculumEnrollmentRejectedError, CurriculumEnrollmentUncertainError,
  curriculumEnrollmentCommandPath, parseCurriculumEnrollmentReceipt, prepareCurriculumEnrollment,
  submitCurriculumEnrollment, validateCurriculumEnrollmentDraft,
  type CurriculumEnrollmentKnownIds,
} from '../src/components/curriculum-enrollment-workbench-http';

const id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const ids: CurriculumEnrollmentKnownIds = { organizationId: id('1'), schoolId: id('2'), curriculumId: id('3'), studentProfileId: id('4'), currentRankId: id('5') };
const command = prepareCurriculumEnrollment(ids, id('9'));
const enrollment = { id: id('6'), studentProfileId: id('4'), currentRankId: id('5'), curriculumId: id('3'), version: 1, status: 'ACTIVE', enrolledAt: '2026-10-18T08:00:00.000Z' };
const envelope = (data: unknown, replayed = false) => ({ data, meta: { requestId: id('7'), correlationId: id('7'), replayed } });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(envelope(data, status === 200 && false)), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

afterEach(() => vi.restoreAllMocks());
describe('curriculum enrollment workbench transport', () => {
  it('accepts exact known required UUIDs and a blank deliberately unranked rank only', () => {
    expect(() => validateCurriculumEnrollmentDraft({ ...ids, currentRankId: '' })).not.toThrow();
    for (const patch of [{ organizationId: '' }, { schoolId: 'not-a-uuid' }, { curriculumId: id('6').replace('-4', '-0') }, { studentProfileId: null }, { currentRankId: 'bad' }] as unknown as CurriculumEnrollmentKnownIds[]) {
      expect(() => validateCurriculumEnrollmentDraft({ ...ids, ...patch })).toThrow();
    }
    const unranked = prepareCurriculumEnrollment({ ...ids, currentRankId: '' }, id('9'));
    expect(unranked.body).toBe(JSON.stringify({ studentProfileId: ids.studentProfileId, currentRankId: null }));
    expect(unranked.path).toBe(curriculumEnrollmentCommandPath(unranked.ids));
    expect(command).toEqual({ path: curriculumEnrollmentCommandPath(ids), ids, key: id('9'), body: JSON.stringify({ studentProfileId: ids.studentProfileId, currentRankId: ids.currentRankId }) });
  });
  it('accepts only a closed matching ACTIVE canonical receipt', () => {
    expect(parseCurriculumEnrollmentReceipt(envelope(enrollment), command)).toEqual({ enrollment, replayed: false });
    for (const patch of [
      { studentProfileId: id('6') }, { currentRankId: null }, { curriculumId: id('6') }, { status: 'SUSPENDED' }, { version: 0 }, { enrolledAt: 'not-time' }, { privateEvidence: 'NO' },
    ]) expect(() => parseCurriculumEnrollmentReceipt(envelope({ ...enrollment, ...patch }), command)).toThrow();
    for (const field of Object.keys(enrollment)) { const copy = { ...enrollment } as Record<string, unknown>; delete copy[field]; expect(() => parseCurriculumEnrollmentReceipt(envelope(copy), command)).toThrow(); }
    const unranked = prepareCurriculumEnrollment({ ...ids, currentRankId: '' }, id('9'));
    expect(parseCurriculumEnrollmentReceipt(envelope({ ...enrollment, currentRankId: null }), unranked).enrollment.currentRankId).toBeNull();
  });
  it('posts only the canonical same-origin no-store command with its retained idempotency key', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(enrollment));
    await expect(submitCurriculumEnrollment(command)).resolves.toEqual({ enrollment, replayed: false });
    expect(fetcher).toHaveBeenCalledWith(command.path, expect.objectContaining({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', body: command.body }));
    const options = fetcher.mock.calls[0]![1] as RequestInit;
    expect(options.headers).toMatchObject({ Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': command.key, 'X-HON-Human-Command': 'curriculum-progress' });
  });
  it('classifies rejection, access loss, malformed success and network loss without leaking response details', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const status of [400, 404, 409, 413, 415, 422]) { fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'SECRET' }), { status })); await expect(submitCurriculumEnrollment(command)).rejects.toBeInstanceOf(CurriculumEnrollmentRejectedError); }
    for (const status of [401, 403] as const) { fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'SECRET' }), { status })); await expect(submitCurriculumEnrollment(command)).rejects.toMatchObject({ status }); }
    fetcher.mockResolvedValueOnce(response({ ...enrollment, status: 'SUSPENDED' })); await expect(submitCurriculumEnrollment(command)).rejects.toBeInstanceOf(CurriculumEnrollmentUncertainError);
    fetcher.mockRejectedValueOnce(new Error('NETWORK_SECRET')); await expect(submitCurriculumEnrollment(command)).rejects.toBeInstanceOf(CurriculumEnrollmentUncertainError);
    expect(fetcher).toHaveBeenCalledTimes(10);
  });
});
