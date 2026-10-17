import { CURRICULUM_PROGRESS_STATUSES, CURRICULUM_REQUIREMENT_KINDS, type CurriculumProgressStatus, type RecordCurriculumProgressInput, type StaffCurriculumEnrollmentDetails, type CurriculumProgressObservationSummary } from '@hon/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_MAX = 999_999_999;
export const PROGRESS_REQUIREMENTS_MAX = 100;
const RESPONSE_MAX = 400_000;
export const HUMAN_PROGRESS_STATUSES = Object.freeze([...CURRICULUM_PROGRESS_STATUSES]);
export type CurriculumProgressKnownIds = Readonly<{ organizationId: string; schoolId: string; curriculumId: string; enrollmentId: string }>;
export type PreparedCurriculumObservation = Readonly<{ path: string; ids: CurriculumProgressKnownIds; key: string; body: string }>;
export type CurriculumObservationReceipt = { observation: CurriculumProgressObservationSummary; replayed: boolean };
export class CurriculumProgressReadError extends Error {}
export class CurriculumProgressRejectedError extends Error {}
export class CurriculumProgressUncertainError extends Error {}
export class CurriculumProgressAccessError extends Error {
  constructor(readonly status: 401 | 403) { super('Current verified human session or curriculum progress access is unavailable. Inputs, snapshot, receipt and retry were cleared.'); }
}
function invalid(): never { throw new Error('Unverified exact curriculum progress contract. No current progress or observation outcome is assumed.'); }
function closed(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) invalid();
}
function uuid(value: unknown): asserts value is string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); }
function version(value: unknown, minimum = 1): void { if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > VERSION_MAX) invalid(); }
function status(value: unknown): asserts value is CurriculumProgressStatus { if (!HUMAN_PROGRESS_STATUSES.includes(value as CurriculumProgressStatus)) invalid(); }
// PostgreSQL JSON timestamps may have microseconds and a UTC offset, not JS's .000Z shape.
function timestamp(value: unknown): void {
  if (typeof value !== 'string') invalid();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) invalid();
  const [, y, m, d, h, minute, s, zone, zh, zm] = match;
  const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() + 1 !== Number(m) || date.getUTCDate() !== Number(d)
    || Number(h) > 23 || Number(minute) > 59 || Number(s) > 59 || (zone !== 'Z' && (Number(zh) > 14 || Number(zm) > 59 || (Number(zh) === 14 && Number(zm) !== 0)))) invalid();
}
export function validateCurriculumProgressIds(ids: CurriculumProgressKnownIds): void {
  closed(ids, ['organizationId', 'schoolId', 'curriculumId', 'enrollmentId']); Object.values(ids).forEach(uuid);
}
export function curriculumEnrollmentPath(ids: CurriculumProgressKnownIds): string {
  validateCurriculumProgressIds(ids);
  return `/api/v1/organizations/${ids.organizationId.toLowerCase()}/schools/${ids.schoolId.toLowerCase()}/curricula/${ids.curriculumId.toLowerCase()}/enrollments/${ids.enrollmentId.toLowerCase()}`;
}
function envelope(value: unknown): { data: unknown; replayed: boolean } {
  closed(value, ['data', 'meta']); closed(value.meta, ['requestId', 'correlationId', 'replayed']);
  uuid(value.meta.requestId); uuid(value.meta.correlationId);
  if (value.meta.requestId !== value.meta.correlationId || typeof value.meta.replayed !== 'boolean') invalid();
  return { data: value.data, replayed: value.meta.replayed };
}
function details(value: unknown, ids: CurriculumProgressKnownIds): StaffCurriculumEnrollmentDetails {
  validateCurriculumProgressIds(ids); closed(value, ['enrollment', 'requirements']);
  closed(value.enrollment, ['id', 'curriculumId', 'studentProfileId', 'currentRankId', 'version', 'status', 'enrolledAt']);
  const e = value.enrollment;
  for (const field of ['id', 'curriculumId', 'studentProfileId']) uuid(e[field]);
  if (e.currentRankId !== null) uuid(e.currentRankId);
  if ((e.id as string).toLowerCase() !== ids.enrollmentId.toLowerCase() || (e.curriculumId as string).toLowerCase() !== ids.curriculumId.toLowerCase()
    || !['ACTIVE', 'SUSPENDED', 'ARCHIVED'].includes(e.status as string)) invalid();
  version(e.version); timestamp(e.enrolledAt);
  if (!Array.isArray(value.requirements) || value.requirements.length > PROGRESS_REQUIREMENTS_MAX || (e.currentRankId === null && value.requirements.length !== 0)) invalid();
  const seen = new Set<string>(); const codes = new Set<string>();
  for (const r of value.requirements) {
    closed(r, ['id', 'rankId', 'code', 'kind', 'definition', 'required', 'version', 'progressVersion', 'status', 'recordedAt']);
    uuid(r.id); uuid(r.rankId);
    if (e.currentRankId === null || r.rankId.toLowerCase() !== (e.currentRankId as string).toLowerCase() || seen.has(r.id.toLowerCase())) invalid();
    seen.add(r.id.toLowerCase());
    if (typeof r.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(r.code) || codes.has(r.code)
      || !CURRICULUM_REQUIREMENT_KINDS.includes(r.kind as never) || typeof r.required !== 'boolean') invalid();
    codes.add(r.code);
    const definitionFields = r.definition && typeof r.definition === 'object' && Object.hasOwn(r.definition, 'description') ? ['label', 'description'] : ['label'];
    closed(r.definition, definitionFields);
    if (typeof r.definition.label !== 'string' || !r.definition.label.trim() || r.definition.label.length > 160 || /[\u0000-\u001f\u007f]/.test(r.definition.label)
      || (definitionFields.length === 2 && (typeof r.definition.description !== 'string' || r.definition.description.length > 2000))) invalid();
    version(r.version); version(r.progressVersion, 0);
    if (r.status === null) { if (r.recordedAt !== null) invalid(); }
    else { status(r.status); version(r.progressVersion); timestamp(r.recordedAt); }
  }
  // Freeze the verified response; descriptions are validated but never displayed by this workbench.
  for (const r of value.requirements) { Object.freeze(r.definition); Object.freeze(r); }
  Object.freeze(e); Object.freeze(value.requirements); Object.freeze(value);
  return value as unknown as StaffCurriculumEnrollmentDetails;
}
export function parseCurriculumEnrollment(value: unknown, ids: CurriculumProgressKnownIds): StaffCurriculumEnrollmentDetails {
  const parsed = envelope(value); if (parsed.replayed) invalid(); return details(parsed.data, ids);
}
export function validateCurriculumObservationDraft(ids: CurriculumProgressKnownIds, snapshot: StaffCurriculumEnrollmentDetails, requirementId: string, chosenStatus: unknown, note: unknown): RecordCurriculumProgressInput {
  details(snapshot, ids); uuid(requirementId); status(chosenStatus);
  if (snapshot.enrollment.status !== 'ACTIVE' || snapshot.enrollment.currentRankId === null
    || typeof note !== 'string' || note.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)) invalid();
  const requirement = snapshot.requirements.find(r => r.id.toLowerCase() === requirementId.toLowerCase());
  if (!requirement || requirement.progressVersion >= VERSION_MAX) invalid();
  return { requirementId: requirement.id.toLowerCase(), expectedRequirementVersion: requirement.version, expectedEnrollmentVersion: snapshot.enrollment.version,
    expectedProgressVersion: requirement.progressVersion, status: chosenStatus, ...(note === '' ? {} : { instructorNote: note }) };
}
/** Only the explicit confirmed submit handler allocates a UUID. This function never sends. */
export function prepareCurriculumObservation(ids: CurriculumProgressKnownIds, snapshot: StaffCurriculumEnrollmentDetails, requirementId: string, chosenStatus: CurriculumProgressStatus, note: string, key: string): PreparedCurriculumObservation {
  const input = validateCurriculumObservationDraft(ids, snapshot, requirementId, chosenStatus, note); uuid(key); if (key[14] !== '4') invalid();
  const normalized = Object.freeze(Object.fromEntries(Object.entries(ids).map(([field, value]) => [field, value.toLowerCase()])) as CurriculumProgressKnownIds);
  return Object.freeze({ path: `${curriculumEnrollmentPath(normalized)}/observations`, ids: normalized, key, body: JSON.stringify(input) });
}
function commandInput(command: PreparedCurriculumObservation): RecordCurriculumProgressInput {
  closed(command, ['path', 'ids', 'key', 'body']); validateCurriculumProgressIds(command.ids); uuid(command.key);
  if (command.key[14] !== '4' || command.path !== `${curriculumEnrollmentPath(command.ids)}/observations` || typeof command.body !== 'string' || command.body.length > 13_000) invalid();
  const input: unknown = JSON.parse(command.body);
  const fields = ['requirementId', 'expectedRequirementVersion', 'expectedEnrollmentVersion', 'expectedProgressVersion', 'status'];
  if (input && typeof input === 'object' && Object.hasOwn(input, 'instructorNote')) fields.push('instructorNote');
  closed(input, fields); uuid(input.requirementId); version(input.expectedRequirementVersion); version(input.expectedEnrollmentVersion); version(input.expectedProgressVersion, 0); status(input.status);
  if (Number(input.expectedProgressVersion) >= VERSION_MAX || (fields.length === 6 && (typeof input.instructorNote !== 'string' || input.instructorNote.length === 0 || input.instructorNote.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.instructorNote)))) invalid();
  if (command.body !== JSON.stringify({ requirementId: input.requirementId.toLowerCase(), expectedRequirementVersion: input.expectedRequirementVersion,
    expectedEnrollmentVersion: input.expectedEnrollmentVersion, expectedProgressVersion: input.expectedProgressVersion, status: input.status, ...(fields.length === 6 ? { instructorNote: input.instructorNote } : {}) })) invalid();
  return input as unknown as RecordCurriculumProgressInput;
}
export function parseCurriculumObservation(value: unknown, command: PreparedCurriculumObservation): CurriculumObservationReceipt {
  const input = commandInput(command); const parsed = envelope(value);
  closed(parsed.data, ['id', 'enrollmentId', 'requirementId', 'requirementVersion', 'enrollmentVersion', 'status', 'version', 'recordedAt']); const r = parsed.data;
  for (const field of ['id', 'enrollmentId', 'requirementId']) uuid(r[field]);
  version(r.requirementVersion); version(r.enrollmentVersion); version(r.version); status(r.status); timestamp(r.recordedAt);
  if ((r.enrollmentId as string).toLowerCase() !== command.ids.enrollmentId.toLowerCase() || (r.requirementId as string).toLowerCase() !== input.requirementId
    || r.requirementVersion !== input.expectedRequirementVersion || r.enrollmentVersion !== input.expectedEnrollmentVersion
    || r.version !== input.expectedProgressVersion + 1 || r.status !== input.status) invalid();
  return { observation: Object.freeze(r) as unknown as CurriculumProgressObservationSummary, replayed: parsed.replayed };
}
const posture = { credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' } as const;
async function json(response: Response): Promise<unknown> {
  if (response.status !== 200 || !response.ok || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  const text = await response.text(); if (text.length > RESPONSE_MAX) invalid(); return JSON.parse(text);
}
export async function loadCurriculumEnrollment(ids: CurriculumProgressKnownIds): Promise<StaffCurriculumEnrollmentDetails> {
  const path = curriculumEnrollmentPath(ids); let response: Response;
  try { response = await fetch(path, { ...posture, method: 'GET', headers: { Accept: 'application/json' } }); }
  catch { throw new CurriculumProgressReadError('Current enrollment could not be verified. No snapshot is shown; explicitly load again.'); }
  if (response.status === 401 || response.status === 403) throw new CurriculumProgressAccessError(response.status);
  try { return parseCurriculumEnrollment(await json(response), ids); }
  catch { throw new CurriculumProgressReadError('Current enrollment could not be verified within this bounded workbench. No snapshot is shown; explicitly load again.'); }
}
/** No automatic retry and no alternative route. Replay still passes current server authorization. */
export async function submitCurriculumObservation(command: PreparedCurriculumObservation): Promise<CurriculumObservationReceipt> {
  commandInput(command); let response: Response;
  try { response = await fetch(command.path, { ...posture, method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': command.key, 'X-HON-Human-Command': 'curriculum-progress' }, body: command.body }); }
  catch { throw new CurriculumProgressUncertainError('Observation outcome is uncertain. Only the exact in-memory command may be retried by a separate human action.'); }
  if (response.status === 401 || response.status === 403) throw new CurriculumProgressAccessError(response.status);
  if ([400, 404, 409, 413, 415, 422].includes(response.status)) throw new CurriculumProgressRejectedError('Observation rejected or versions conflicted. Snapshot and retry were cleared; explicitly reload the current enrollment before a new command.');
  try { return parseCurriculumObservation(await json(response), command); }
  catch { throw new CurriculumProgressUncertainError('No verified exact observation receipt was returned. Outcome is uncertain; only the unchanged in-memory command may be retried.'); }
}
