// Paper import (0388): photos or scans of student cards, contracts or attendance sheets. HON reads the pages into a
// table with the columns of an existing import; staff check the table beside the photo, then send it to the existing
// staged import (0226 students and guardians, 0333 attendance history), where every row is decided before anything is
// saved. Readers: AI_ROUTE (0559, HON on the AI team's provider, under the S4 spend controls), NONE (staff typed the rows,
// no AI) and the stand-in SYNTHETIC, which reads only the built-in sample pages and never sends a page anywhere.
import { STUDENT_IMPORT_FIELDS } from './student-imports.js';
import { HISTORY_IMPORT_FIELDS } from './history-imports.js';

export const PAPER_IMPORT_KINDS = ['STUDENT_CARDS', 'CONTRACTS', 'ATTENDANCE_SHEETS'] as const;
export type PaperImportKind = typeof PAPER_IMPORT_KINDS[number];
export type PaperImportTarget = 'STUDENTS' | 'ATTENDANCE';
export const PAPER_IMPORT_TARGET: Readonly<Record<PaperImportKind, PaperImportTarget>> = { STUDENT_CARDS: 'STUDENTS', CONTRACTS: 'STUDENTS', ATTENDANCE_SHEETS: 'ATTENDANCE' };
export const PAPER_IMPORT_COLUMNS: Readonly<Record<PaperImportTarget, readonly string[]>> = { STUDENTS: STUDENT_IMPORT_FIELDS, ATTENDANCE: HISTORY_IMPORT_FIELDS.ATTENDANCE };
export const PAPER_IMPORT_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type PaperImportMediaType = typeof PAPER_IMPORT_MEDIA_TYPES[number];
export const PAPER_IMPORT_MAX_PAGES = 10;
export const PAPER_IMPORT_MAX_PAGE_BYTES = 1400000;
export const PAPER_IMPORT_MAX_ROWS = 200;
export const PAPER_IMPORT_MAX_CELL = 200;
export const PAPER_IMPORT_RETENTION_DAYS = 30;

export type PaperImportStatus = 'OPEN' | 'READ' | 'SENT' | 'DELETED';
export type PaperImportReadOutcome = 'SAMPLE_READ' | 'NOT_READABLE' | 'AI_READ' | 'TYPED';
export type PaperImportReader = 'SYNTHETIC' | 'AI_ROUTE' | 'NONE';
const READER_OUTCOMES: Readonly<Record<PaperImportReader, readonly PaperImportReadOutcome[]>> = {
  SYNTHETIC: ['SAMPLE_READ', 'NOT_READABLE'], AI_ROUTE: ['AI_READ', 'NOT_READABLE'], NONE: ['TYPED'],
};
/** HON's reading of a set on the AI route (0559): the shared text proposal's status and reason, never its content. */
export const PAPER_READING_STATUSES = ['PENDING', 'CONFIGURATION_REQUIRED', 'BLOCKED', 'SENDING', 'UNKNOWN', 'FAILED', 'RESULT_RECORDED', 'RESULT_REJECTED', 'APPLIED', 'DISMISSED'] as const;
export type PaperReadingStatus = typeof PAPER_READING_STATUSES[number];
export const PAPER_READING_REASONS = ['CONFIGURATION_REQUIRED', 'NO_ELIGIBLE_ROUTE', 'CUSTOMER_BUDGET_EXCEEDED', 'AI_SPEND_STOPPED', 'UNSUPPORTED_PROVIDER',
  'INVALID_REQUEST', 'PROVIDER_REJECTED', 'PROVIDER_UNKNOWN', 'ROUTE_STALE', 'RESULT_BUDGET_EXCEEDED', 'RESULT_INVALID', 'SUBJECT_STALE', 'GATE_CLOSED'] as const;
export type PaperReadingReason = typeof PAPER_READING_REASONS[number];
export interface PaperReadingState { status: PaperReadingStatus; reason: PaperReadingReason | null }
/** The PAPER_READING kind row (0559): plan budgets and the most one reading may cost (micro-USD). */
export const PAPER_READING_AI_LIMITS = { inputTokens: 40000, outputTokens: 16000, maxProviderCostMicrounits: 250000 } as const;
export interface PaperImportSummary {
  id: string; kind: PaperImportKind; target: PaperImportTarget; version: number; status: PaperImportStatus; pageCount: number;
  reader: PaperImportReader | null; readOutcome: PaperImportReadOutcome | null; sentBatchId: string | null;
  createdAt: string; expiresAt: string; readAt: string | null; sentAt: string | null; deletedAt: string | null; deleteReason: 'STAFF' | 'EXPIRED' | null;
}
export interface PaperImportPageInfo { pageNo: number; mediaType: PaperImportMediaType; bytes: number; checksum: string }
export interface PaperImportDetail { set: PaperImportSummary; columns: string[]; rows: string[][]; unsure: boolean[][]; pages: PaperImportPageInfo[]; aiReading: PaperReadingState | null }
export interface PaperImportList { sets: PaperImportSummary[]; maxPages: number; maxPageBytes: number; maxRows: number; retentionDays: number }
export interface PaperImportPage { pageNo: number; mediaType: PaperImportMediaType; data: string }
export interface PaperImportTable { rows: string[][]; unsure: boolean[][] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX64 = /^[a-f0-9]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// A cell is one line of plain text: no control, bidi-override, zero-width or replacement (U+FFFD) characters, and no lone surrogate.
const UNSAFE_CELL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿\uFFFD]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function fail(what: string): never { throw new Error(`Unverified paper import ${what}.`); }
function record(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(what);
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail(what);
  return value as Record<string, unknown>;
}
function count(value: unknown, min: number, max: number): value is number { return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max; }
function iso(value: unknown, nullable = false): boolean { return (nullable && value === null) || (typeof value === 'string' && ISO.test(value)); }
function invalid(): never { throw new Error('VALIDATION_FAILED'); }
function closedInput(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) invalid();
  return value as Record<string, unknown>;
}
function version(value: unknown): number { if (!count(value, 1, 999999999)) invalid(); return value as number; }

export function isPaperImportKind(value: unknown): value is PaperImportKind { return (PAPER_IMPORT_KINDS as readonly unknown[]).includes(value); }
export function paperImportColumns(kind: PaperImportKind): readonly string[] { return PAPER_IMPORT_COLUMNS[PAPER_IMPORT_TARGET[kind]]; }
export function isPaperImportCell(value: unknown): value is string {
  return typeof value === 'string' && value.length <= PAPER_IMPORT_MAX_CELL && value.trim() === value && !UNSAFE_CELL.test(value);
}

/**
 * The table shape the database accepts: 0..200 rows of exactly one cell per column, and a matching unsure matrix. With no
 * kind (the API before it knows the set), every row must have the width of one of the two targets.
 */
export function validatePaperImportTable(kind: PaperImportKind | null, rows: unknown, unsure: unknown): PaperImportTable {
  const first = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0].length : 0;
  const width = kind ? paperImportColumns(kind).length : Object.values(PAPER_IMPORT_COLUMNS).some((c) => c.length === first) ? first : -1;
  if (!Array.isArray(rows) || !Array.isArray(unsure) || rows.length > PAPER_IMPORT_MAX_ROWS || unsure.length !== rows.length) invalid();
  rows.forEach((row, i) => {
    const flags = unsure[i];
    if (!Array.isArray(row) || row.length !== width || !row.every(isPaperImportCell)) invalid();
    if (!Array.isArray(flags) || flags.length !== width || !flags.every((f) => typeof f === 'boolean')) invalid();
  });
  return { rows: rows as string[][], unsure: unsure as boolean[][] };
}

export function validatePaperImportCreateInput(value: unknown): { kind: PaperImportKind } {
  const v = closedInput(value, ['kind']);
  if (!isPaperImportKind(v.kind)) invalid();
  return { kind: v.kind };
}
export function validatePaperImportPageInput(value: unknown): { expectedVersion: number; mediaType: PaperImportMediaType; data: string } {
  const v = closedInput(value, ['data', 'expectedVersion', 'mediaType']);
  if (!(PAPER_IMPORT_MEDIA_TYPES as readonly unknown[]).includes(v.mediaType) || typeof v.data !== 'string' || !v.data
    || v.data.length > Math.ceil(PAPER_IMPORT_MAX_PAGE_BYTES / 3) * 4 || v.data.length % 4 !== 0 || !BASE64.test(v.data)) invalid();
  return { expectedVersion: version(v.expectedVersion), mediaType: v.mediaType as PaperImportMediaType, data: v.data as string };
}
export function validatePaperImportVersionInput(value: unknown): { expectedVersion: number } {
  return { expectedVersion: version(closedInput(value, ['expectedVersion']).expectedVersion) };
}
export function validatePaperImportSaveInput(kind: PaperImportKind | null, value: unknown): { expectedVersion: number } & PaperImportTable {
  const v = closedInput(value, ['expectedVersion', 'rows', 'unsure']);
  return { expectedVersion: version(v.expectedVersion), ...validatePaperImportTable(kind, v.rows, v.unsure) };
}

export function verifyPaperImportSummary(value: unknown): PaperImportSummary {
  const v = record(value, ['id', 'kind', 'target', 'version', 'status', 'pageCount', 'reader', 'readOutcome', 'sentBatchId', 'createdAt', 'expiresAt', 'readAt', 'sentAt', 'deletedAt', 'deleteReason'], 'set');
  if (typeof v.id !== 'string' || !UUID.test(v.id) || !isPaperImportKind(v.kind) || v.target !== PAPER_IMPORT_TARGET[v.kind] || !count(v.version, 1, 999999999)
    || !['OPEN', 'READ', 'SENT', 'DELETED'].includes(v.status as string) || !count(v.pageCount, 0, PAPER_IMPORT_MAX_PAGES)
    || (v.reader !== null && !(Object.keys(READER_OUTCOMES).includes(v.reader as string)
      && READER_OUTCOMES[v.reader as PaperImportReader].includes(v.readOutcome as PaperImportReadOutcome)))
    || (v.sentBatchId !== null && (typeof v.sentBatchId !== 'string' || !UUID.test(v.sentBatchId)))
    || !iso(v.createdAt) || !iso(v.expiresAt) || !iso(v.readAt, true) || !iso(v.sentAt, true) || !iso(v.deletedAt, true)
    || (v.deleteReason !== null && v.deleteReason !== 'STAFF' && v.deleteReason !== 'EXPIRED')
    || ((v.status === 'DELETED') !== (v.deletedAt !== null)) || ((v.deletedAt === null) !== (v.deleteReason === null))
    || ((v.readAt === null) !== (v.reader === null)) || ((v.reader === null) !== (v.readOutcome === null))
    || ((v.sentAt === null) !== (v.sentBatchId === null)) || (v.status === 'READ' && v.readAt === null) || (v.status === 'SENT' && v.sentAt === null)) fail('set');
  return v as unknown as PaperImportSummary;
}
export function verifyPaperImportList(value: unknown): PaperImportList {
  const v = record(value, ['sets', 'maxPages', 'maxPageBytes', 'maxRows', 'retentionDays'], 'list');
  if (!Array.isArray(v.sets) || v.sets.length > 50 || v.maxPages !== PAPER_IMPORT_MAX_PAGES || v.maxPageBytes !== PAPER_IMPORT_MAX_PAGE_BYTES
    || v.maxRows !== PAPER_IMPORT_MAX_ROWS || v.retentionDays !== PAPER_IMPORT_RETENTION_DAYS) fail('list');
  v.sets.forEach(verifyPaperImportSummary);
  return v as unknown as PaperImportList;
}
export function verifyPaperImportDetail(value: unknown): PaperImportDetail {
  const v = record(value, ['set', 'columns', 'rows', 'unsure', 'pages', 'aiReading'], 'detail');
  const set = verifyPaperImportSummary(v.set);
  const columns = paperImportColumns(set.kind);
  if (!Array.isArray(v.columns) || v.columns.join(',') !== columns.join(',') || !Array.isArray(v.pages) || v.pages.length !== set.pageCount) fail('detail');
  try { validatePaperImportTable(set.kind, v.rows, v.unsure); } catch { fail('table'); }
  if (set.status === 'DELETED' && ((v.rows as unknown[]).length || set.pageCount)) fail('detail');
  if (v.aiReading !== null) {
    const a = record(v.aiReading, ['status', 'reason'], 'reading');
    if (!(PAPER_READING_STATUSES as readonly unknown[]).includes(a.status) || (a.reason !== null && !(PAPER_READING_REASONS as readonly unknown[]).includes(a.reason))) fail('reading');
  }
  (v.pages as unknown[]).forEach((page, i) => {
    const p = record(page, ['pageNo', 'mediaType', 'bytes', 'checksum'], 'page');
    if (p.pageNo !== i + 1 || !(PAPER_IMPORT_MEDIA_TYPES as readonly unknown[]).includes(p.mediaType) || !count(p.bytes, 1, PAPER_IMPORT_MAX_PAGE_BYTES)
      || typeof p.checksum !== 'string' || !HEX64.test(p.checksum)) fail('page');
  });
  return v as unknown as PaperImportDetail;
}
export function verifyPaperImportPage(value: unknown): PaperImportPage {
  const v = record(value, ['pageNo', 'mediaType', 'data'], 'page image');
  if (!count(v.pageNo, 1, PAPER_IMPORT_MAX_PAGES) || !(PAPER_IMPORT_MEDIA_TYPES as readonly unknown[]).includes(v.mediaType)
    || typeof v.data !== 'string' || !v.data || v.data.length % 4 !== 0 || !BASE64.test(v.data)) fail('page image');
  return v as unknown as PaperImportPage;
}

/**
 * The model's answer to a reading (0559), as the API keeps it: exactly {rows, unsure}, one array of cells per row in the
 * column order of the kind, and a matching matrix of booleans. Each cell is trimmed and inner whitespace is joined to one
 * space; a cell that is still not plain text of up to 200 characters is left blank and marked unsure (never shortened or
 * guessed). Returns null when the answer is not that table at all, so the reading is recorded as not readable.
 */
export function parsePaperReadingAnswer(kind: PaperImportKind, value: unknown): PaperImportTable | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'rows,unsure') return null;
  const { rows, unsure } = value as { rows: unknown; unsure: unknown };
  const width = paperImportColumns(kind).length;
  if (!Array.isArray(rows) || !Array.isArray(unsure) || rows.length > PAPER_IMPORT_MAX_ROWS || unsure.length !== rows.length) return null;
  const outRows: string[][] = [], outUnsure: boolean[][] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i], flags = unsure[i];
    if (!Array.isArray(row) || row.length !== width || !Array.isArray(flags) || flags.length !== width || !flags.every((f) => typeof f === 'boolean')) return null;
    const cells: string[] = [], marks: boolean[] = [];
    for (let j = 0; j < width; j++) {
      const raw = row[j];
      if (typeof raw !== 'string') return null;
      const cell = raw.replace(/\s+/g, ' ').trim();
      const ok = isPaperImportCell(cell);
      cells.push(ok ? cell : ''); marks.push(ok ? flags[j] as boolean : true);
    }
    if (cells.some((c) => c !== '')) { outRows.push(cells); outUnsure.push(marks); }
  }
  return validatePaperImportTable(kind, outRows, outUnsure);
}
