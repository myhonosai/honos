import {
  validateCurriculumEnrollmentPreparationInput, verifyCurriculumEnrollmentPreparationApiResponse,
  type CurriculumEnrollmentPreparation, type CurriculumEnrollmentPreparationInput,
} from '@hon/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESPONSE_MAX = 384_000;

export type EnrollmentPreparationScope = Readonly<{ organizationId: string; schoolId: string }>;
export type { CurriculumEnrollmentPreparation };
export class CurriculumEnrollmentPreparationRejectedError extends Error {
  constructor() { super('No verified enrollment choices were returned for this exact current-school student. No curriculum or rank was selected.'); }
}
export class CurriculumEnrollmentPreparationAccessError extends CurriculumEnrollmentPreparationRejectedError {
  constructor(readonly status: 401 | 403) { super(); this.message = 'Current verified human session, exact school curriculum permission, or active entitlement is unavailable. Enrollment preparation was cleared.'; }
}

function invalid(): never { throw new Error('The enrollment preparation result could not be verified. No curriculum or rank was selected.'); }
function scopePart(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value.toLowerCase(); }
function validateScope(scope: EnrollmentPreparationScope): void { scopePart(scope.organizationId); scopePart(scope.schoolId); }
function responsePath(scope: EnrollmentPreparationScope): string {
  validateScope(scope);
  return `/api/v1/organizations/${scopePart(scope.organizationId)}/schools/${scopePart(scope.schoolId)}/curricula/enrollment-preparation`;
}

/** Local syntax validation only. Scope and student selectors never establish authority. */
export function validateEnrollmentPreparationInput(scope: EnrollmentPreparationScope, studentProfileId: string): void {
  validateScope(scope); validateCurriculumEnrollmentPreparationInput({ studentProfileId });
}
export function curriculumEnrollmentPreparationPath(scope: EnrollmentPreparationScope): string { return responsePath(scope); }

/** Uses the same closed, ordered, redacted contract verifier that the API service uses. */
export function parseCurriculumEnrollmentPreparation(value: unknown, expectedStudentProfileId: string): CurriculumEnrollmentPreparation {
  const expectedStudentId = scopePart(expectedStudentProfileId);
  const response = verifyCurriculumEnrollmentPreparationApiResponse(value);
  if (response.data.student.id !== expectedStudentId) invalid();
  return response.data;
}

/** One explicit user-requested read. It does not allocate an idempotency key or execute an enrollment command. */
export async function loadCurriculumEnrollmentPreparation(scope: EnrollmentPreparationScope, studentProfileId: string): Promise<CurriculumEnrollmentPreparation> {
  validateEnrollmentPreparationInput(scope, studentProfileId); const normalizedStudentId = scopePart(studentProfileId);
  const input: CurriculumEnrollmentPreparationInput = { studentProfileId: normalizedStudentId }; let response: Response;
  try {
    response = await fetch(responsePath(scope), {
      method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'curriculum-enrollment-preparation' },
      body: JSON.stringify(input),
    });
  } catch { throw new CurriculumEnrollmentPreparationRejectedError(); }
  if (response.status === 401 || response.status === 403) throw new CurriculumEnrollmentPreparationAccessError(response.status);
  if ([400, 404, 405, 409, 413, 415, 422].includes(response.status)) throw new CurriculumEnrollmentPreparationRejectedError();
  try {
    if (!response.ok || response.status !== 200 || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
    const body = await response.text(); if (body.length > RESPONSE_MAX) invalid(); return parseCurriculumEnrollmentPreparation(JSON.parse(body), normalizedStudentId);
  } catch { throw new CurriculumEnrollmentPreparationRejectedError(); }
}
