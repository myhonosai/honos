import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CurriculumEnrollmentPreparationAccessError, CurriculumEnrollmentPreparationRejectedError,
  curriculumEnrollmentPreparationPath, loadCurriculumEnrollmentPreparation, parseCurriculumEnrollmentPreparation,
  validateEnrollmentPreparationInput, type EnrollmentPreparationScope,
} from '../src/components/curriculum-enrollment-preparation-http';

const id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const scope: EnrollmentPreparationScope = { organizationId: id('1'), schoolId: id('2') };
const studentId = id('3');
const projection = {
  student: { id: studentId, displayName: 'Jordan Kim' },
  curricula: [
    { id: id('7'), name: 'Adult Fundamentals', ranks: [] },
    { id: id('4'), name: 'Kids Fundamentals', ranks: [{ id: id('5'), name: 'White Belt', progressionOrder: 1 }, { id: id('6'), name: 'Yellow Belt', progressionOrder: 2 }] },
  ],
};
const envelope = (data: unknown) => ({ data, meta: { requestId: id('8'), correlationId: id('8'), replayed: false } });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(status === 200 ? envelope(data) : data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

afterEach(() => vi.restoreAllMocks());
describe('curriculum enrollment preparation transport', () => {
  it('accepts only the closed redacted current-student projection', () => {
    expect(validateEnrollmentPreparationInput(scope, studentId)).toBeUndefined(); expect(curriculumEnrollmentPreparationPath(scope)).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/curricula/enrollment-preparation`);
    expect(parseCurriculumEnrollmentPreparation(envelope(projection), studentId)).toEqual(projection);
    const failures = [
      { student: { id: studentId, displayName: 'Jordan Kim', email: 'hidden' }, curricula: [] },
      { student: { id: id('9'), displayName: 'Jordan Kim' }, curricula: [] },
      { student: { id: studentId, displayName: 'Jordan Kim' }, curricula: [{ ...projection.curricula[0], private: 'no' }] },
      { student: { id: studentId, displayName: 'Jordan Kim' }, curricula: [{ ...projection.curricula[1], ranks: [{ id: id('5'), name: 'White Belt', progressionOrder: 1 }, { id: id('5'), name: 'Duplicate', progressionOrder: 2 }] }] },
      { student: { id: studentId, displayName: 'Jordan Kim' }, curricula: [{ ...projection.curricula[1], ranks: [{ id: id('5'), name: 'White Belt', progressionOrder: 0 }] }] },
    ];
    for (const malformed of failures) expect(() => parseCurriculumEnrollmentPreparation(envelope(malformed), studentId)).toThrow();
    for (const badScope of [{ organizationId: 'bad', schoolId: scope.schoolId }, { organizationId: scope.organizationId, schoolId: '' }] as EnrollmentPreparationScope[]) expect(() => validateEnrollmentPreparationInput(badScope, studentId)).toThrow();
  });

  it('posts one explicit exact-student preparation request with the feature-specific human marker and no idempotency key', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(projection)); const key = vi.spyOn(crypto, 'randomUUID');
    await expect(loadCurriculumEnrollmentPreparation(scope, studentId)).resolves.toEqual(projection);
    const [path, options] = fetcher.mock.calls[0]!; expect(path).toBe(curriculumEnrollmentPreparationPath(scope)); expect(options).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', body: JSON.stringify({ studentProfileId: studentId }) });
    expect((options as RequestInit).headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'curriculum-enrollment-preparation' }); expect(key).not.toHaveBeenCalled();
  });

  it('clears preparation on access loss and rejects malformed, not-found, cross-origin, or uncertain responses without a selected projection', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const status of [401, 403] as const) { fetcher.mockResolvedValueOnce(response({ detail: 'hidden' }, status)); await expect(loadCurriculumEnrollmentPreparation(scope, studentId)).rejects.toMatchObject({ status }); }
    for (const status of [400, 404, 405, 409, 413, 415, 422]) { fetcher.mockResolvedValueOnce(response({ detail: 'hidden' }, status)); await expect(loadCurriculumEnrollmentPreparation(scope, studentId)).rejects.toBeInstanceOf(CurriculumEnrollmentPreparationRejectedError); }
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(envelope(projection)), { status: 200, headers: { 'Content-Type': 'text/plain' } })); await expect(loadCurriculumEnrollmentPreparation(scope, studentId)).rejects.toBeInstanceOf(CurriculumEnrollmentPreparationRejectedError);
    fetcher.mockRejectedValueOnce(new Error('NETWORK_SECRET')); await expect(loadCurriculumEnrollmentPreparation(scope, studentId)).rejects.toBeInstanceOf(CurriculumEnrollmentPreparationRejectedError);
    expect(fetcher).toHaveBeenCalledTimes(11); expect(CurriculumEnrollmentPreparationAccessError).toBeDefined();
  });
});
