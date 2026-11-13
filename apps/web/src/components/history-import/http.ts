import {
  HISTORY_IMPORT_FIELDS, HISTORY_IMPORT_MAX_BYTES, HISTORY_IMPORT_MAX_COLUMNS, HISTORY_IMPORT_REQUIRED, isHistoryImportKind,
  validateHistoryImportDecisionInput, validateHistoryImportFinalizeInput, validateHistoryImportMapping,
  verifyHistoryImportBatch, verifyHistoryImportDetail, verifyHistoryImportList,
  type HistoryImportBatch, type HistoryImportDecisionInput, type HistoryImportDetail, type HistoryImportFinalizeInput, type HistoryImportKind,
  type HistoryImportList, type HistoryImportMappingTarget,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * Class list and attendance-history CSV import (0333). Reads send no Idempotency-Key and no query string; each command sends
 * its own X-HON-Human-Command and an Idempotency-Key, so no call can be replayed as another. The server parses the CSV again
 * and decides every cell, the student match, the selection and the permission. A class import creates programs and weekly
 * class series only (no sessions); an attendance import records past visits for existing students only: never a class
 * session, booking, attendance record, membership, charge or message.
 */
export type ImportErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed for this staff member at this school. Nothing changed. */ | 'DENIED'
  /** The import is not available at this school. */ | 'GONE'
  /** The import changed since it was read. Nothing changed. */ | 'CHANGED'
  /** A class or visit in the import was added since it was staged. Nothing changed; stage the file again. */ | 'STALE'
  /** A row with problems was marked to import, or the row is already imported. Nothing changed. */ | 'NOT_IMPORTABLE'
  /** Not every row is decided, or the confirmation did not match the rows marked to import. Nothing changed. */ | 'SELECTION'
  /** The school's time zone is not usable. */ | 'TIMEZONE'
  /** The file or request was not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Too many requests. Nothing changed; the same request may be sent again later. */ | 'RATE'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class ImportError extends Error { constructor(readonly kind: ImportErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;
export type ImportScope = Readonly<{ organizationId: string; schoolId: string }>;
export type StagedUpload = Readonly<{ kind: HistoryImportKind; csv: string; mapping: Record<string, HistoryImportMappingTarget> }>;

const RESPONSE_MAX = 4_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
  return (value as { data: unknown }).data;
}
function base(scope: ImportScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new ImportError('INVALID');
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/history-imports`;
}
function batchPath(scope: ImportScope, batchId: string): string {
  if (!UUID.test(batchId)) throw new ImportError('INVALID');
  return `${base(scope)}/${batchId.toLowerCase()}`;
}

async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  // A retired request (aborted, or no longer the one shown) never ends a newer session.
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new ImportError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new ImportError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}

/** What a refused answer means. Only these exact answers are definitive; anything else (busy, a lock wait, 5xx, drift) is UNKNOWN. */
export function importErrorFor(status: number, code: string | null): ImportError {
  if (status === 403) return new ImportError('DENIED', code);
  if (status === 404) return new ImportError('GONE', code);
  if (status === 429) return new ImportError('RATE', code);
  if (status === 400) return new ImportError(code === 'HISTORY_IMPORT_ROW_NOT_IMPORTABLE' ? 'NOT_IMPORTABLE' : 'INVALID', code);
  if (status === 409) {
    if (code === 'VERSION_CONFLICT') return new ImportError('CHANGED', code);
    if (code === 'HISTORY_IMPORT_STALE') return new ImportError('STALE', code);
    if (code === 'HISTORY_IMPORT_SELECTION_REQUIRED') return new ImportError('SELECTION', code);
    if (code === 'SCHOOL_TIMEZONE_INVALID') return new ImportError('TIMEZONE', code);
    if (code === 'IDEMPOTENCY_KEY_REUSED' || code === 'IDEMPOTENCY_KEY_REQUIRED') return new ImportError('INVALID', code);
  }
  // HISTORY_IMPORT_BUSY, HISTORY_IMPORT_CONFLICT, 5xx: the same request may be sent again.
  return new ImportError('UNKNOWN', code);
}

async function read<T>(path: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned); }
  catch (error) { if (error instanceof ImportError || signal.aborted) throw error; throw new ImportError('UNKNOWN'); }
  if (answer.status !== 200) throw importErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new ImportError('UNKNOWN'); }
}
async function command<T>(path: string, name: string, body: unknown, key: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new ImportError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof ImportError) throw error; throw new ImportError('UNKNOWN'); }
  if (answer.status !== 200) throw importErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new ImportError('UNKNOWN'); }
}
function checked<T>(validate: () => T): T { try { return validate(); } catch { throw new ImportError('INVALID'); } }
const sameBatch = (batchId: string) => (v: unknown): HistoryImportBatch => {
  const batch = verifyHistoryImportBatch(v);
  if (batch.id.toLowerCase() !== batchId.toLowerCase()) throw new Error('batch');
  return batch;
};

const norm = (header: string) => header.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** Common column names in class-schedule and attendance exports from school management software and spreadsheets. */
const ALIASES: Readonly<Record<HistoryImportKind, ReadonlyArray<readonly [string, readonly string[]]>>> = {
  CLASSES: [
    ['className', ['class', 'class name', 'classname', 'name', 'title', 'class title', 'course', 'session name']],
    ['programName', ['program', 'program name', 'programme', 'style', 'discipline', 'martial art', 'category']],
    ['weekdays', ['days', 'day', 'weekdays', 'weekday', 'day of week', 'days of week', 'class days', 'meets on']],
    ['startTime', ['start', 'start time', 'time', 'begins', 'class time', 'starts at']],
    ['durationMinutes', ['duration', 'length', 'minutes', 'duration minutes', 'duration min', 'length minutes', 'mins']],
    ['capacity', ['capacity', 'max', 'max students', 'spots', 'size', 'class size', 'limit']],
    ['roomName', ['room', 'room name', 'location', 'studio', 'mat', 'area']],
    ['bookingPolicy', ['booking', 'booking policy', 'reservation', 'reservations']],
    ['startsOn', ['starts on', 'start date', 'first date', 'first class', 'begin date']],
  ],
  ATTENDANCE: [
    ['studentGivenName', ['first', 'first name', 'firstname', 'given name', 'student first name', 'member first name']],
    ['studentFamilyName', ['last', 'last name', 'lastname', 'surname', 'family name', 'student last name', 'member last name']],
    ['birthDate', ['dob', 'birth date', 'birthdate', 'date of birth', 'birthday', 'student birth date']],
    ['attendedOn', ['date', 'attended on', 'attended', 'attendance date', 'visit date', 'check in date', 'checkin date', 'check in', 'checkin', 'class date']],
    ['visits', ['visits', 'count', 'visit count', 'number of visits', 'classes attended', 'attendance count', 'times']],
    ['className', ['class', 'class name', 'classname', 'program', 'session']],
  ],
};
/** A suggested mapping from familiar header names; anything unknown, or a field already taken, is ignored. Staff review it before staging. */
export function guessMapping(kind: HistoryImportKind, headers: readonly string[]): Record<string, HistoryImportMappingTarget> {
  const used = new Set<string>(), out: Record<string, HistoryImportMappingTarget> = {};
  for (const header of headers) {
    const key = norm(header);
    const hit = ALIASES[kind].find(([field, names]) => !used.has(field) && names.includes(key));
    out[header] = hit ? hit[0] as HistoryImportMappingTarget : 'ignore';
    if (hit) used.add(hit[0]);
  }
  return out;
}
export type MappingProblem = 'REQUIRED' | 'DUPLICATE' | 'TOO_MANY_COLUMNS';
/** A mapping the server will accept: known fields of this kind at most once, the required ones present, at most 24 staged columns. */
export function mappingProblem(kind: HistoryImportKind, mapping: Readonly<Record<string, HistoryImportMappingTarget>>): MappingProblem | null {
  const used: string[] = Object.values(mapping).filter((v) => v !== 'ignore');
  if (Object.keys(mapping).length > HISTORY_IMPORT_MAX_COLUMNS && used.length > HISTORY_IMPORT_MAX_COLUMNS) return 'TOO_MANY_COLUMNS';
  const allowed: readonly string[] = HISTORY_IMPORT_FIELDS[kind];
  if (used.some((v) => !allowed.includes(v)) || new Set(used).size !== used.length) return 'DUPLICATE';
  if (!(HISTORY_IMPORT_REQUIRED[kind] as readonly string[]).every((f) => used.includes(f))) return 'REQUIRED';
  return null;
}
export const csvTooLarge = (text: string) => new TextEncoder().encode(text).length > HISTORY_IMPORT_MAX_BYTES;

export const historyImportApi = {
  /** The school's 25 most recent class and attendance imports and the published limits. */
  list(scope: ImportScope, signal: AbortSignal, owned: Owned): Promise<HistoryImportList> {
    return Promise.resolve().then(() => read(base(scope), verifyHistoryImportList, signal, owned));
  },
  /** One import with every row, its problems, the student match, the choice and (once imported) the created records. */
  detail(scope: ImportScope, batchId: string, signal: AbortSignal, owned: Owned): Promise<HistoryImportDetail> {
    return Promise.resolve().then(() => read(batchPath(scope, batchId), (v) => verifyHistoryImportDetail(v, batchId.toLowerCase()), signal, owned));
  },
  async stage(scope: ImportScope, upload: StagedUpload, key: string, signal: AbortSignal, owned: Owned): Promise<HistoryImportBatch> {
    const body = checked(() => {
      if (!isHistoryImportKind(upload.kind) || typeof upload.csv !== 'string' || !upload.csv || csvTooLarge(upload.csv)) throw new Error('upload');
      const mapping = validateHistoryImportMapping(upload.kind, Object.keys(upload.mapping), { ...upload.mapping });
      return { kind: upload.kind, csv: upload.csv, mapping };
    });
    return command(base(scope), 'history.import.stage', body, key, (v) => {
      const batch = verifyHistoryImportBatch(v);
      if (batch.kind !== body.kind) throw new Error('batch');
      return batch;
    }, signal, owned);
  },
  async decide(scope: ImportScope, batchId: string, input: HistoryImportDecisionInput, key: string, signal: AbortSignal, owned: Owned): Promise<HistoryImportBatch> {
    const path = `${batchPath(scope, batchId)}/decisions`, body = checked(() => validateHistoryImportDecisionInput(input));
    return command(path, 'history.import.decide', body, key, sameBatch(batchId), signal, owned);
  },
  async finalize(scope: ImportScope, batchId: string, input: HistoryImportFinalizeInput, key: string, signal: AbortSignal, owned: Owned): Promise<HistoryImportBatch> {
    const path = `${batchPath(scope, batchId)}/finalize`, body = checked(() => validateHistoryImportFinalizeInput(input));
    return command(path, 'history.import.finalize', body, key, sameBatch(batchId), signal, owned);
  },
};
export type HistoryImportApi = typeof historyImportApi;

/** Whether a failed command may be sent again with the same key: only when its outcome is not known, or nothing was sent (rate limit). */
export const keepForRetry = (error: unknown) => !(error instanceof ImportError) || error.kind === 'UNKNOWN' || error.kind === 'RATE';
