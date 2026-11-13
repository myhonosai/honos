// Onboarding B6 (0333): class list and attendance-history CSV import, staged and reviewed like the 0226 student import.
// CLASSES rows become weekly class series (no sessions are created); ATTENDANCE rows become imported history for an
// existing student only: never a class session, booking or attendance record, so nothing live counts or reacts to them.

export const HISTORY_IMPORT_KINDS = ['CLASSES', 'ATTENDANCE'] as const;
export type HistoryImportKind = typeof HISTORY_IMPORT_KINDS[number];
export const HISTORY_IMPORT_FIELDS = {
  CLASSES: ['className', 'programName', 'weekdays', 'startTime', 'durationMinutes', 'capacity', 'roomName', 'bookingPolicy', 'startsOn'],
  ATTENDANCE: ['studentGivenName', 'studentFamilyName', 'birthDate', 'attendedOn', 'visits', 'className'],
} as const;
export const HISTORY_IMPORT_REQUIRED = {
  CLASSES: ['className', 'weekdays', 'startTime', 'durationMinutes'],
  ATTENDANCE: ['studentGivenName', 'studentFamilyName', 'attendedOn'],
} as const;
export type HistoryImportField = typeof HISTORY_IMPORT_FIELDS[HistoryImportKind][number];
export type HistoryImportMappingTarget = HistoryImportField | 'ignore';
export const HISTORY_IMPORT_MAX_BYTES = 262144;
export const HISTORY_IMPORT_MAX_ROWS = 1000;
export const HISTORY_IMPORT_MAX_COLUMNS = 24;

export interface HistoryImportUpload { kind: HistoryImportKind; csv: string; mapping: Record<string, HistoryImportMappingTarget> }
export interface HistoryImportDecisionInput { expectedVersion: number; decisions: { index: number; choice: 'IMPORT' | 'SKIP' }[] }
export interface HistoryImportFinalizeInput { expectedVersion: number; selectedIndices: number[] }

export interface HistoryImportBatch {
  id: string; kind: HistoryImportKind; version: number; status: 'STAGED' | 'FINALIZED';
  rowCount: number; validCount: number; importCount: number; skipCount: number; undecidedCount: number; importedCount: number;
  checksum: string; schoolToday: string; createdAt: string; finalizedAt: string | null;
}
export type HistoryImportCreated = { programId: string; seriesId: string } | { historyId: string };
export interface HistoryImportRow {
  index: number; raw: string[]; normalized: Partial<Record<HistoryImportField, string>>; errors: string[];
  choice: 'IMPORT' | 'SKIP' | null; matchedStudentProfileId: string | null; created: HistoryImportCreated | null;
}
export interface HistoryImportDetail { batch: HistoryImportBatch; headers: string[]; mapping: Record<string, HistoryImportMappingTarget>; rows: HistoryImportRow[] }
export interface HistoryImportList {
  batches: HistoryImportBatch[]; fields: typeof HISTORY_IMPORT_FIELDS; maxBytes: number; maxRows: number; maxColumns: number;
}
export interface ImportedAttendance {
  studentProfileId: string; totalVisits: number; firstOn: string | null; lastOn: string | null;
  entries: { attendedOn: string; visits: number; className: string | null; batchId: string }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function fail(what: string): never { throw new Error(`Unverified history import ${what}.`); }
function record(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(what);
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail(what);
  return value as Record<string, unknown>;
}
function count(value: unknown, max = 1000): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max; }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length <= max; }
function uuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
function closedInput(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error('VALIDATION_FAILED');
  return value as Record<string, unknown>;
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 999999999) throw new Error('VALIDATION_FAILED');
  return value as number;
}
function index(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > HISTORY_IMPORT_MAX_ROWS) throw new Error('VALIDATION_FAILED');
  return value as number;
}
export function isHistoryImportKind(value: unknown): value is HistoryImportKind { return (HISTORY_IMPORT_KINDS as readonly unknown[]).includes(value); }

/** Closed mapping rules, the same as the database: every header mapped once to a field of this kind; its required fields mapped. */
export function validateHistoryImportMapping(kind: HistoryImportKind, headers: readonly string[], mapping: unknown): Record<string, HistoryImportMappingTarget> {
  const m = closedInput(mapping, headers);
  const allowed: readonly string[] = HISTORY_IMPORT_FIELDS[kind];
  const values = Object.values(m);
  if (values.some(v => v !== 'ignore' && !allowed.includes(v as string))) throw new Error('VALIDATION_FAILED');
  const used = values.filter(v => v !== 'ignore') as string[];
  if (!used.length || new Set(used).size !== used.length || !HISTORY_IMPORT_REQUIRED[kind].every(f => used.includes(f))) throw new Error('VALIDATION_FAILED');
  return m as Record<string, HistoryImportMappingTarget>;
}
export function validateHistoryImportDecisionInput(value: unknown): HistoryImportDecisionInput {
  const input = closedInput(value, ['expectedVersion', 'decisions']);
  const expectedVersion = version(input.expectedVersion);
  if (!Array.isArray(input.decisions) || !input.decisions.length || input.decisions.length > HISTORY_IMPORT_MAX_ROWS) throw new Error('VALIDATION_FAILED');
  const decisions = input.decisions.map(item => {
    const d = closedInput(item, ['index', 'choice']);
    if (d.choice !== 'IMPORT' && d.choice !== 'SKIP') throw new Error('VALIDATION_FAILED');
    return { index: index(d.index), choice: d.choice as 'IMPORT' | 'SKIP' };
  });
  if (new Set(decisions.map(d => d.index)).size !== decisions.length) throw new Error('VALIDATION_FAILED');
  return { expectedVersion, decisions };
}
export function validateHistoryImportFinalizeInput(value: unknown): HistoryImportFinalizeInput {
  const input = closedInput(value, ['expectedVersion', 'selectedIndices']);
  const expectedVersion = version(input.expectedVersion);
  if (!Array.isArray(input.selectedIndices) || input.selectedIndices.length > HISTORY_IMPORT_MAX_ROWS) throw new Error('VALIDATION_FAILED');
  const selectedIndices = input.selectedIndices.map(index);
  if (new Set(selectedIndices).size !== selectedIndices.length) throw new Error('VALIDATION_FAILED');
  return { expectedVersion, selectedIndices };
}

export function verifyHistoryImportBatch(value: unknown): HistoryImportBatch {
  const b = record(value, ['id', 'kind', 'version', 'status', 'rowCount', 'validCount', 'importCount', 'skipCount', 'undecidedCount', 'importedCount',
    'checksum', 'schoolToday', 'createdAt', 'finalizedAt'], 'batch');
  if (!uuid(b.id) || !isHistoryImportKind(b.kind) || !Number.isSafeInteger(b.version) || (b.version as number) < 1
    || (b.status !== 'STAGED' && b.status !== 'FINALIZED') || !count(b.rowCount) || (b.rowCount as number) < 1
    || ![b.validCount, b.importCount, b.skipCount, b.undecidedCount, b.importedCount].every(x => count(x) && (x as number) <= (b.rowCount as number))
    || (b.importCount as number) + (b.skipCount as number) + (b.undecidedCount as number) !== b.rowCount
    || (b.importedCount as number) > (b.importCount as number) || (b.importCount as number) > (b.validCount as number)
    || typeof b.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(b.checksum) || typeof b.schoolToday !== 'string' || !DAY.test(b.schoolToday)
    || typeof b.createdAt !== 'string' || !ISO.test(b.createdAt)
    || (b.status === 'FINALIZED') !== (typeof b.finalizedAt === 'string' && ISO.test(b.finalizedAt))
    || (b.status === 'STAGED' && (b.finalizedAt !== null || b.importedCount !== 0))
    || (b.status === 'FINALIZED' && (b.importedCount !== b.importCount || b.undecidedCount !== 0))) fail('batch');
  return b as unknown as HistoryImportBatch;
}
function verifyRow(value: unknown, kind: HistoryImportKind, columns: number, finalized: boolean): HistoryImportRow {
  const r = record(value, ['index', 'raw', 'normalized', 'errors', 'choice', 'matchedStudentProfileId', 'created'], 'row');
  if (!count(r.index) || (r.index as number) < 1 || !Array.isArray(r.raw) || r.raw.length !== columns || !r.raw.every(x => text(x, 16384))
    || !Array.isArray(r.errors) || !r.errors.every(x => text(x, 80)) || (r.choice !== null && r.choice !== 'IMPORT' && r.choice !== 'SKIP')) fail('row');
  const n = r.normalized;
  if (!n || typeof n !== 'object' || Array.isArray(n)) fail('row');
  const allowed: readonly string[] = HISTORY_IMPORT_FIELDS[kind];
  for (const [k, v] of Object.entries(n)) if (!allowed.includes(k) || !text(v, 16384)) fail('row');
  if (r.errors.length && r.choice === 'IMPORT') fail('row');
  if (r.matchedStudentProfileId !== null && (kind !== 'ATTENDANCE' || !uuid(r.matchedStudentProfileId))) fail('row');
  if (r.created === null) { if (finalized && r.choice === 'IMPORT') fail('row'); }
  else {
    const c = kind === 'CLASSES' ? record(r.created, ['programId', 'seriesId'], 'row') : record(r.created, ['historyId'], 'row');
    if (r.choice !== 'IMPORT' || !Object.values(c).every(uuid) || (kind === 'ATTENDANCE' && r.matchedStudentProfileId === null)) fail('row');
  }
  return r as unknown as HistoryImportRow;
}
export function verifyHistoryImportDetail(value: unknown, batchId: string): HistoryImportDetail {
  const d = record(value, ['batch', 'headers', 'mapping', 'rows'], 'detail');
  const batch = verifyHistoryImportBatch(d.batch);
  if (batch.id !== batchId || !Array.isArray(d.headers) || !d.headers.length || d.headers.length > HISTORY_IMPORT_MAX_COLUMNS || !d.headers.every(h => text(h, 80))) fail('detail');
  try { validateHistoryImportMapping(batch.kind, d.headers as string[], d.mapping); } catch { fail('detail'); }
  if (!Array.isArray(d.rows) || d.rows.length !== batch.rowCount) fail('detail');
  const rows = d.rows.map(r => verifyRow(r, batch.kind, (d.headers as string[]).length, batch.status === 'FINALIZED'));
  if (rows.some((r, i) => r.index !== i + 1)) fail('detail');
  return { batch, headers: d.headers as string[], mapping: d.mapping as Record<string, HistoryImportMappingTarget>, rows };
}
export function verifyHistoryImportList(value: unknown): HistoryImportList {
  const l = record(value, ['batches', 'fields', 'maxBytes', 'maxRows', 'maxColumns'], 'list');
  if (!Array.isArray(l.batches) || l.batches.length > 25 || JSON.stringify(l.fields) !== JSON.stringify(HISTORY_IMPORT_FIELDS)
    || l.maxBytes !== HISTORY_IMPORT_MAX_BYTES || l.maxRows !== HISTORY_IMPORT_MAX_ROWS || l.maxColumns !== HISTORY_IMPORT_MAX_COLUMNS) fail('list');
  return { batches: l.batches.map(verifyHistoryImportBatch), fields: HISTORY_IMPORT_FIELDS, maxBytes: HISTORY_IMPORT_MAX_BYTES, maxRows: HISTORY_IMPORT_MAX_ROWS, maxColumns: HISTORY_IMPORT_MAX_COLUMNS };
}
export function verifyImportedAttendance(value: unknown, studentProfileId: string): ImportedAttendance {
  const a = record(value, ['studentProfileId', 'totalVisits', 'firstOn', 'lastOn', 'entries'], 'attendance');
  if (a.studentProfileId !== studentProfileId || !count(a.totalVisits, 5_000_000) || !Array.isArray(a.entries) || a.entries.length > 100
    || (a.firstOn !== null && !(typeof a.firstOn === 'string' && DAY.test(a.firstOn))) || (a.lastOn !== null && !(typeof a.lastOn === 'string' && DAY.test(a.lastOn)))
    || (a.totalVisits === 0) !== (a.firstOn === null) || (a.firstOn === null) !== (a.lastOn === null)) fail('attendance');
  for (const e of a.entries as unknown[]) {
    const x = record(e, ['attendedOn', 'visits', 'className', 'batchId'], 'attendance');
    if (typeof x.attendedOn !== 'string' || !DAY.test(x.attendedOn) || !count(x.visits, 5000) || (x.visits as number) < 1
      || (x.className !== null && !text(x.className, 120)) || !uuid(x.batchId)) fail('attendance');
  }
  return a as unknown as ImportedAttendance;
}
