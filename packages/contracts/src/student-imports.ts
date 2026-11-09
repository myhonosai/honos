// B-CRM-7 (0226): student and guardian CSV import. Staging, row decisions and finalize create people, families,
// family links and student profiles only: never a membership, plan, schedule, invoice, payment, enrollment, account,
// invitation, consent or message.

export const STUDENT_IMPORT_FIELDS = ['studentGivenName', 'studentFamilyName', 'birthDate', 'studentEmail', 'studentMobile',
  'guardianGivenName', 'guardianFamilyName', 'guardianEmail', 'guardianMobile', 'familyKey'] as const;
export type StudentImportField = typeof STUDENT_IMPORT_FIELDS[number];
export type StudentImportMappingTarget = StudentImportField | 'ignore';
export const STUDENT_IMPORT_MAX_BYTES = 262144;
export const STUDENT_IMPORT_MAX_ROWS = 1000;
export const STUDENT_IMPORT_MAX_COLUMNS = 24;

export interface StudentImportUpload { csv: string; mapping: Record<string, StudentImportMappingTarget> }
export interface StudentImportDecisionInput { expectedVersion: number; decisions: { index: number; choice: 'IMPORT' | 'SKIP' }[] }
export interface StudentImportFinalizeInput { expectedVersion: number; selectedIndices: number[] }

export interface StudentImportBatch {
  id: string; version: number; status: 'STAGED' | 'FINALIZED';
  rowCount: number; validCount: number; importCount: number; skipCount: number; undecidedCount: number; importedCount: number;
  checksum: string; schoolToday: string; createdAt: string; finalizedAt: string | null;
}
export interface StudentImportGuardian { givenName: string; familyName: string; email: string; mobile: string }
export type StudentImportSuggestion =
  | { personId: string; reason: 'STUDENT_EMAIL' | 'STUDENT_PHONE' | 'GUARDIAN_EMAIL' | 'GUARDIAN_PHONE' | 'STUDENT_NAME_AND_BIRTH_DATE' }
  | { rowIndex: number; reason: 'SAME_STUDENT_IN_FILE' };
export interface StudentImportRow {
  index: number; raw: string[];
  normalized: Partial<Record<StudentImportField, string>> & { guardian: StudentImportGuardian | null };
  errors: string[]; suggestions: StudentImportSuggestion[]; choice: 'IMPORT' | 'SKIP' | null;
  created: { familyId: string; guardianPersonId: string | null; studentPersonId: string; studentProfileId: string } | null;
}
export interface StudentImportDetail { batch: StudentImportBatch; headers: string[]; mapping: Record<string, StudentImportMappingTarget>; rows: StudentImportRow[] }
export interface StudentImportList { batches: StudentImportBatch[]; fields: readonly StudentImportField[]; maxBytes: number; maxRows: number; maxColumns: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SUGGESTION_PEOPLE = ['STUDENT_EMAIL', 'STUDENT_PHONE', 'GUARDIAN_EMAIL', 'GUARDIAN_PHONE', 'STUDENT_NAME_AND_BIRTH_DATE'];

function fail(what: string): never { throw new Error(`Unverified student import ${what}.`); }
function record(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(what);
  const actual = Object.keys(value).sort().join(',');
  if (actual !== [...keys].sort().join(',')) fail(what);
  return value as Record<string, unknown>;
}
function count(value: unknown, max = 1000): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max; }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length <= max; }
function closedInput(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error('VALIDATION_FAILED');
  return value as Record<string, unknown>;
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 999999999) throw new Error('VALIDATION_FAILED');
  return value as number;
}
function index(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > STUDENT_IMPORT_MAX_ROWS) throw new Error('VALIDATION_FAILED');
  return value as number;
}

/** Closed mapping rules, the same as the database: every header mapped once; the student's names are required; guardian names come together. */
export function validateStudentImportMapping(headers: readonly string[], mapping: unknown): Record<string, StudentImportMappingTarget> {
  const m = closedInput(mapping, headers);
  const values = Object.values(m);
  if (values.some(v => v !== 'ignore' && !(STUDENT_IMPORT_FIELDS as readonly unknown[]).includes(v))) throw new Error('VALIDATION_FAILED');
  const used = values.filter(v => v !== 'ignore') as StudentImportField[];
  if (!used.length || new Set(used).size !== used.length || !used.includes('studentGivenName') || !used.includes('studentFamilyName')
    || used.includes('guardianGivenName') !== used.includes('guardianFamilyName')
    || ((used.includes('guardianEmail') || used.includes('guardianMobile')) && !used.includes('guardianGivenName'))) throw new Error('VALIDATION_FAILED');
  return m as Record<string, StudentImportMappingTarget>;
}
export function validateStudentImportDecisionInput(value: unknown): StudentImportDecisionInput {
  const input = closedInput(value, ['expectedVersion', 'decisions']);
  const expectedVersion = version(input.expectedVersion);
  if (!Array.isArray(input.decisions) || !input.decisions.length || input.decisions.length > STUDENT_IMPORT_MAX_ROWS) throw new Error('VALIDATION_FAILED');
  const decisions = input.decisions.map(item => {
    const d = closedInput(item, ['index', 'choice']);
    if (d.choice !== 'IMPORT' && d.choice !== 'SKIP') throw new Error('VALIDATION_FAILED');
    return { index: index(d.index), choice: d.choice as 'IMPORT' | 'SKIP' };
  });
  if (new Set(decisions.map(d => d.index)).size !== decisions.length) throw new Error('VALIDATION_FAILED');
  return { expectedVersion, decisions };
}
export function validateStudentImportFinalizeInput(value: unknown): StudentImportFinalizeInput {
  const input = closedInput(value, ['expectedVersion', 'selectedIndices']);
  const expectedVersion = version(input.expectedVersion);
  if (!Array.isArray(input.selectedIndices) || input.selectedIndices.length > STUDENT_IMPORT_MAX_ROWS) throw new Error('VALIDATION_FAILED');
  const selectedIndices = input.selectedIndices.map(index);
  if (new Set(selectedIndices).size !== selectedIndices.length) throw new Error('VALIDATION_FAILED');
  return { expectedVersion, selectedIndices };
}

export function verifyStudentImportBatch(value: unknown): StudentImportBatch {
  const b = record(value, ['id', 'version', 'status', 'rowCount', 'validCount', 'importCount', 'skipCount', 'undecidedCount', 'importedCount',
    'checksum', 'schoolToday', 'createdAt', 'finalizedAt'], 'batch');
  if (typeof b.id !== 'string' || !UUID.test(b.id) || !Number.isSafeInteger(b.version) || (b.version as number) < 1
    || (b.status !== 'STAGED' && b.status !== 'FINALIZED') || !count(b.rowCount) || (b.rowCount as number) < 1
    || ![b.validCount, b.importCount, b.skipCount, b.undecidedCount, b.importedCount].every(x => count(x) && (x as number) <= (b.rowCount as number))
    || (b.importCount as number) + (b.skipCount as number) + (b.undecidedCount as number) !== b.rowCount
    || (b.importedCount as number) > (b.importCount as number) || (b.importCount as number) > (b.validCount as number)
    || typeof b.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(b.checksum) || typeof b.schoolToday !== 'string' || !DAY.test(b.schoolToday)
    || typeof b.createdAt !== 'string' || !ISO.test(b.createdAt)
    || (b.status === 'FINALIZED') !== (typeof b.finalizedAt === 'string' && ISO.test(b.finalizedAt))
    || (b.status === 'STAGED' && (b.finalizedAt !== null || b.importedCount !== 0))
    || (b.status === 'FINALIZED' && (b.importedCount !== b.importCount || b.undecidedCount !== 0))) fail('batch');
  return b as unknown as StudentImportBatch;
}
function verifyGuardian(value: unknown): StudentImportGuardian | null {
  if (value === null) return null;
  const g = record(value, ['givenName', 'familyName', 'email', 'mobile'], 'guardian');
  if (![g.givenName, g.familyName, g.email, g.mobile].every(x => text(x, 16384)) || !(g.givenName as string) || !(g.familyName as string)) fail('guardian');
  return g as unknown as StudentImportGuardian;
}
function verifyRow(value: unknown, columns: number, finalized: boolean): StudentImportRow {
  const r = record(value, ['index', 'raw', 'normalized', 'errors', 'suggestions', 'choice', 'created'], 'row');
  if (!count(r.index) || (r.index as number) < 1 || !Array.isArray(r.raw) || r.raw.length !== columns || !r.raw.every(x => text(x, 16384))
    || !Array.isArray(r.errors) || !r.errors.every(x => text(x, 80)) || !Array.isArray(r.suggestions) || r.suggestions.length > 20
    || (r.choice !== null && r.choice !== 'IMPORT' && r.choice !== 'SKIP')) fail('row');
  const n = r.normalized;
  if (!n || typeof n !== 'object' || Array.isArray(n) || !('guardian' in n)) fail('row');
  for (const [k, v] of Object.entries(n)) {
    if (k === 'guardian') continue;
    if (!(STUDENT_IMPORT_FIELDS as readonly string[]).includes(k) || !text(v, 16384)) fail('row');
  }
  verifyGuardian((n as Record<string, unknown>).guardian);
  for (const s of r.suggestions as unknown[]) {
    const keys = s && typeof s === 'object' ? Object.keys(s).sort().join(',') : '';
    const x = s as Record<string, unknown>;
    if (keys === 'personId,reason') { if (typeof x.personId !== 'string' || !UUID.test(x.personId) || !SUGGESTION_PEOPLE.includes(x.reason as string)) fail('row'); }
    else if (keys === 'reason,rowIndex') { if (!count(x.rowIndex) || x.reason !== 'SAME_STUDENT_IN_FILE') fail('row'); }
    else fail('row');
  }
  if (r.errors.length && r.choice === 'IMPORT') fail('row');
  if (r.created === null) { if (finalized && r.choice === 'IMPORT') fail('row'); }
  else {
    const c = record(r.created, ['familyId', 'guardianPersonId', 'studentPersonId', 'studentProfileId'], 'row');
    if (r.choice !== 'IMPORT' || ![c.familyId, c.studentPersonId, c.studentProfileId].every(x => typeof x === 'string' && UUID.test(x))
      || (c.guardianPersonId !== null && (typeof c.guardianPersonId !== 'string' || !UUID.test(c.guardianPersonId)))) fail('row');
  }
  return r as unknown as StudentImportRow;
}
export function verifyStudentImportDetail(value: unknown, batchId: string): StudentImportDetail {
  const d = record(value, ['batch', 'headers', 'mapping', 'rows'], 'detail');
  const batch = verifyStudentImportBatch(d.batch);
  if (batch.id !== batchId || !Array.isArray(d.headers) || !d.headers.length || d.headers.length > STUDENT_IMPORT_MAX_COLUMNS || !d.headers.every(h => text(h, 80))) fail('detail');
  try { validateStudentImportMapping(d.headers as string[], d.mapping); } catch { fail('detail'); }
  if (!Array.isArray(d.rows) || d.rows.length !== batch.rowCount) fail('detail');
  const rows = d.rows.map(r => verifyRow(r, (d.headers as string[]).length, batch.status === 'FINALIZED'));
  if (rows.some((r, i) => r.index !== i + 1)) fail('detail');
  return { batch, headers: d.headers as string[], mapping: d.mapping as Record<string, StudentImportMappingTarget>, rows };
}
export function verifyStudentImportList(value: unknown): StudentImportList {
  const l = record(value, ['batches', 'fields', 'maxBytes', 'maxRows', 'maxColumns'], 'list');
  if (!Array.isArray(l.batches) || l.batches.length > 25 || JSON.stringify(l.fields) !== JSON.stringify(STUDENT_IMPORT_FIELDS)
    || l.maxBytes !== STUDENT_IMPORT_MAX_BYTES || l.maxRows !== STUDENT_IMPORT_MAX_ROWS || l.maxColumns !== STUDENT_IMPORT_MAX_COLUMNS) fail('list');
  return { batches: l.batches.map(verifyStudentImportBatch), fields: STUDENT_IMPORT_FIELDS, maxBytes: STUDENT_IMPORT_MAX_BYTES, maxRows: STUDENT_IMPORT_MAX_ROWS, maxColumns: STUDENT_IMPORT_MAX_COLUMNS };
}
