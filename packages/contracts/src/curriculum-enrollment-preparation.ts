export const CURRICULUM_ENROLLMENT_PREPARATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const CURRICULUM_ENROLLMENT_PREPARATION_MAX_CURRICULA = 250;
export const CURRICULUM_ENROLLMENT_PREPARATION_MAX_RANKS_PER_CURRICULUM = 250;

/** The sole caller-selected value; tenant, school, actor, source and authority are server-derived. */
export interface CurriculumEnrollmentPreparationInput {
  studentProfileId: string;
}

/** A deliberately narrow direct-human preparation projection for one known active student. */
export interface CurriculumEnrollmentPreparation {
  student: { id: string; displayName: string };
  curricula: Array<{
    id: string;
    name: string;
    ranks: Array<{ id: string; name: string; progressionOrder: number }>;
  }>;
}

export interface CurriculumEnrollmentPreparationApiResponse {
  data: CurriculumEnrollmentPreparation;
  meta: { requestId: string; correlationId: string; replayed: false };
}

function invalid(): never {
  throw new Error('The curriculum enrollment preparation projection could not be verified.');
}

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.hasOwn(object, key))) invalid();
  return object;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !CURRICULUM_ENROLLMENT_PREPARATION_UUID.test(value)) invalid();
  return value.toLowerCase();
}

/** Existing curriculum and rank command limits make this projection bounded and presentation-safe. */
function name(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value
    || Array.from(value).length > maximum || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value)) invalid();
  return value;
}

function compareNameAndId(left: { name: string; id: string }, right: { name: string; id: string }): number {
  // PostgreSQL uses COLLATE "C" for the matching projection order. Safe display
  // names exclude control/bidi characters, so this byte/code-point ordering is stable.
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

/** Rejects every contextual or selector field beyond the one explicit student UUID. */
export function validateCurriculumEnrollmentPreparationInput(value: unknown): asserts value is CurriculumEnrollmentPreparationInput {
  const input = closed(value, ['studentProfileId']);
  uuid(input.studentProfileId);
}

/**
 * Verifies the exact response shape and ordering. No directory, contact, enrollment,
 * billing, permission, tenant, audit, or provider fact can pass this boundary.
 */
export function verifyCurriculumEnrollmentPreparation(value: unknown): CurriculumEnrollmentPreparation {
  const projection = closed(value, ['student', 'curricula']);
  const student = closed(projection.student, ['id', 'displayName']);
  const studentId = uuid(student.id);
  // A canonical person has bounded given/family names; displayName joins them once.
  const displayName = name(student.displayName, 201);
  if (!Array.isArray(projection.curricula) || projection.curricula.length > CURRICULUM_ENROLLMENT_PREPARATION_MAX_CURRICULA) invalid();

  const curriculumIds = new Set<string>();
  let previousCurriculum: { name: string; id: string } | undefined;
  const curricula = projection.curricula.map((value) => {
    const curriculum = closed(value, ['id', 'name', 'ranks']);
    const id = uuid(curriculum.id);
    const curriculumName = name(curriculum.name, 140);
    if (curriculumIds.has(id)) invalid();
    if (previousCurriculum && compareNameAndId({ name: curriculumName, id }, previousCurriculum) <= 0) invalid();
    previousCurriculum = { name: curriculumName, id };
    curriculumIds.add(id);
    if (!Array.isArray(curriculum.ranks) || curriculum.ranks.length > CURRICULUM_ENROLLMENT_PREPARATION_MAX_RANKS_PER_CURRICULUM) invalid();

    const rankIds = new Set<string>();
    let previousRank: { progressionOrder: number; name: string; id: string } | undefined;
    const ranks = curriculum.ranks.map((value) => {
      const rank = closed(value, ['id', 'name', 'progressionOrder']);
      const rankId = uuid(rank.id);
      const rankName = name(rank.name, 120);
      const progressionOrder = rank.progressionOrder;
      if (typeof progressionOrder !== 'number' || !Number.isSafeInteger(progressionOrder) || progressionOrder < 1 || progressionOrder > 2_147_483_647 || rankIds.has(rankId)) invalid();
      if (previousRank && (progressionOrder < previousRank.progressionOrder
        || (progressionOrder === previousRank.progressionOrder && compareNameAndId({ name: rankName, id: rankId }, previousRank) <= 0))) invalid();
      previousRank = { progressionOrder, name: rankName, id: rankId };
      rankIds.add(rankId);
      return { id: rankId, name: rankName, progressionOrder };
    });
    return { id, name: curriculumName, ranks };
  });
  return { student: { id: studentId, displayName }, curricula };
}

/** Verifies the standard no-replay response envelope without allowing metadata expansion. */
export function verifyCurriculumEnrollmentPreparationApiResponse(value: unknown): CurriculumEnrollmentPreparationApiResponse {
  const response = closed(value, ['data', 'meta']);
  const meta = closed(response.meta, ['requestId', 'correlationId', 'replayed']);
  const requestId = uuid(meta.requestId);
  const correlationId = uuid(meta.correlationId);
  if (meta.replayed !== false) invalid();
  return { data: verifyCurriculumEnrollmentPreparation(response.data), meta: { requestId, correlationId, replayed: false } };
}
