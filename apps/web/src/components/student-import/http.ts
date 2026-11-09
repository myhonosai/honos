import {
  STUDENT_IMPORT_FIELDS, STUDENT_IMPORT_MAX_BYTES, STUDENT_IMPORT_MAX_COLUMNS,
  validateStudentImportDecisionInput, validateStudentImportFinalizeInput, verifyStudentImportBatch, verifyStudentImportDetail, verifyStudentImportList,
  type StudentImportBatch, type StudentImportDecisionInput, type StudentImportDetail, type StudentImportFinalizeInput, type StudentImportList,
  type StudentImportMappingTarget,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * Student and guardian CSV import (0226). Reads send no Idempotency-Key and no query string; each command sends its own
 * X-HON-Human-Command and an Idempotency-Key, so no call can be replayed as another. The server parses the CSV again and
 * decides every cell, the guardian rule, the selection and the permission. Importing creates people, families, family links
 * and student profiles only: never a membership, charge, account, invitation or message.
 */
export type ImportErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed for this staff member at this school. Nothing changed. */ | 'DENIED'
  /** The import is not available at this school. */ | 'GONE'
  /** The import changed since it was read. Nothing changed. */ | 'CHANGED'
  /** A row with problems was marked to import, or the row is already imported. Nothing changed. */ | 'NOT_IMPORTABLE'
  /** Not every row is decided, or the confirmation did not match the rows marked to import. Nothing changed. */ | 'SELECTION'
  /** The school's time zone is not usable. */ | 'TIMEZONE'
  /** The file or request was not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Too many requests. Nothing changed; the same request may be sent again later. */ | 'RATE'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class ImportError extends Error { constructor(readonly kind: ImportErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;
export type ImportScope = Readonly<{ organizationId: string; schoolId: string }>;
export type StagedUpload = Readonly<{ csv: string; mapping: Record<string, StudentImportMappingTarget> }>;

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
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/student-imports`;
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

/** What a refused answer means. Only these exact answers are definitive; anything else (busy, 5xx, drift) is UNKNOWN. */
export function importErrorFor(status: number, code: string | null): ImportError {
  if (status === 403) return new ImportError('DENIED', code);
  if (status === 404) return new ImportError('GONE', code);
  if (status === 429) return new ImportError('RATE', code);
  if (status === 400) return new ImportError(code === 'STUDENT_IMPORT_ROW_NOT_IMPORTABLE' ? 'NOT_IMPORTABLE' : 'INVALID', code);
  if (status === 409) {
    if (code === 'VERSION_CONFLICT') return new ImportError('CHANGED', code);
    if (code === 'STUDENT_IMPORT_SELECTION_REQUIRED') return new ImportError('SELECTION', code);
    if (code === 'SCHOOL_TIMEZONE_INVALID') return new ImportError('TIMEZONE', code);
    if (code === 'IDEMPOTENCY_KEY_REUSED' || code === 'IDEMPOTENCY_KEY_REQUIRED') return new ImportError('INVALID', code);
  }
  // STUDENT_IMPORT_BUSY, STUDENT_IMPORT_CONFLICT (a lock wait), 5xx: the same request may be sent again.
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
const sameBatch = (batchId: string) => (v: unknown): StudentImportBatch => {
  const batch = verifyStudentImportBatch(v);
  if (batch.id.toLowerCase() !== batchId.toLowerCase()) throw new Error('batch');
  return batch;
};

/** The header row of a CSV (RFC 4180 quoting), for the column mapping. Null when it is not a usable header row. */
export function csvHeaders(text: string): string[] | null {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const cells: string[] = [];
  let cell = '', quoted = false, i = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') { if (source[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') { cells.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') break;
    else cell += ch;
  }
  if (quoted) return null;
  cells.push(cell);
  if (!cells.length || cells.length > STUDENT_IMPORT_MAX_COLUMNS || new Set(cells).size !== cells.length || cells.some((h) => !h.trim() || h.length > 80)) return null;
  return cells;
}

const GUESSES: ReadonlyArray<readonly [RegExp, StudentImportMappingTarget]> = [
  [/^(parent|guardian|mother|father|mom|dad)[ _-]*(first|given)/i, 'guardianGivenName'], [/^(parent|guardian|mother|father|mom|dad)[ _-]*(last|family|sur)/i, 'guardianFamilyName'],
  [/^(parent|guardian|mother|father|mom|dad)[ _-]*e-?mail/i, 'guardianEmail'], [/^(parent|guardian|mother|father|mom|dad)[ _-]*(phone|mobile|cell)/i, 'guardianMobile'],
  [/^(student[ _-]*)?(first|given)[ _-]*name$|^first$/i, 'studentGivenName'], [/^(student[ _-]*)?(last|family|sur)[ _-]*name$|^last$/i, 'studentFamilyName'],
  [/^(birth[ _-]*date|date[ _-]*of[ _-]*birth|dob|birthday)$/i, 'birthDate'], [/^(student[ _-]*)?e-?mail$/i, 'studentEmail'],
  [/^(student[ _-]*)?(phone|mobile|cell)$/i, 'studentMobile'], [/^(family|household)([ _-]*(id|key|name|code))?$/i, 'familyKey'],
];
/** A suggested mapping from familiar header names; anything unknown, or a field already taken, is ignored. Staff review it before staging. */
export function guessMapping(headers: readonly string[]): Record<string, StudentImportMappingTarget> {
  const used = new Set<string>(), out: Record<string, StudentImportMappingTarget> = {};
  for (const header of headers) {
    const hit = GUESSES.find(([pattern, field]) => pattern.test(header.trim()) && !used.has(field));
    out[header] = hit ? hit[1] : 'ignore';
    if (hit) used.add(hit[1]);
  }
  return out;
}
/** A mapping the server will accept: every column once, known fields at most once, student names present, guardian names together. */
export function mappingProblem(mapping: Readonly<Record<string, StudentImportMappingTarget>>): 'STUDENT_NAMES' | 'DUPLICATE' | 'GUARDIAN_NAMES' | 'GUARDIAN_CONTACT' | null {
  const used = Object.values(mapping).filter((v) => v !== 'ignore');
  if (used.some((v) => !(STUDENT_IMPORT_FIELDS as readonly string[]).includes(v))) return 'DUPLICATE';
  if (new Set(used).size !== used.length) return 'DUPLICATE';
  if (!used.includes('studentGivenName') || !used.includes('studentFamilyName')) return 'STUDENT_NAMES';
  if (used.includes('guardianGivenName') !== used.includes('guardianFamilyName')) return 'GUARDIAN_NAMES';
  if ((used.includes('guardianEmail') || used.includes('guardianMobile')) && !used.includes('guardianGivenName')) return 'GUARDIAN_CONTACT';
  return null;
}
export const csvTooLarge = (text: string) => new TextEncoder().encode(text).length > STUDENT_IMPORT_MAX_BYTES;

export const studentImportApi = {
  /** The school's 25 most recent imports and the published limits. */
  list(scope: ImportScope, signal: AbortSignal, owned: Owned): Promise<StudentImportList> {
    return Promise.resolve().then(() => read(base(scope), verifyStudentImportList, signal, owned));
  },
  /** One import with every row, its problems, suggestions, choice and (once imported) the created records. */
  detail(scope: ImportScope, batchId: string, signal: AbortSignal, owned: Owned): Promise<StudentImportDetail> {
    return Promise.resolve().then(() => read(batchPath(scope, batchId), (v) => verifyStudentImportDetail(v, batchId.toLowerCase()), signal, owned));
  },
  async stage(scope: ImportScope, upload: StagedUpload, key: string, signal: AbortSignal, owned: Owned): Promise<StudentImportBatch> {
    const body = checked(() => {
      if (typeof upload.csv !== 'string' || !upload.csv || csvTooLarge(upload.csv) || mappingProblem(upload.mapping)) throw new Error('upload');
      return { csv: upload.csv, mapping: { ...upload.mapping } };
    });
    return command(base(scope), 'students.import.stage', body, key, verifyStudentImportBatch, signal, owned);
  },
  async decide(scope: ImportScope, batchId: string, input: StudentImportDecisionInput, key: string, signal: AbortSignal, owned: Owned): Promise<StudentImportBatch> {
    const path = `${batchPath(scope, batchId)}/decisions`, body = checked(() => validateStudentImportDecisionInput(input));
    return command(path, 'students.import.decide', body, key, sameBatch(batchId), signal, owned);
  },
  async finalize(scope: ImportScope, batchId: string, input: StudentImportFinalizeInput, key: string, signal: AbortSignal, owned: Owned): Promise<StudentImportBatch> {
    const path = `${batchPath(scope, batchId)}/finalize`, body = checked(() => validateStudentImportFinalizeInput(input));
    return command(path, 'students.import.finalize', body, key, sameBatch(batchId), signal, owned);
  },
};
export type StudentImportApi = typeof studentImportApi;

/** Whether a failed command may be sent again with the same key: only when its outcome is not known, or nothing was sent (rate limit). */
export const keepForRetry = (error: unknown) => !(error instanceof ImportError) || error.kind === 'UNKNOWN' || error.kind === 'RATE';
