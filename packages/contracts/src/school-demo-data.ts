/**
 * 0446: demo data a school owner can load to try HON and remove again with one action, before importing real records.
 * Every demo row is registered in the database; removal deletes only those rows (and what staff added to demo people),
 * never a real record. Demo people are never texted, emailed or charged. The database validates every rule here again.
 */
export const SCHOOL_DEMO_DATA_COUNT_KEYS = ['adultStudents', 'attendance', 'classSessions', 'classes', 'families', 'guardians', 'invoices', 'leads',
  'memberships', 'overdueInvoices', 'payments', 'programs', 'students'] as const;
export type SchoolDemoDataCountKey = typeof SCHOOL_DEMO_DATA_COUNT_KEYS[number];
export type SchoolDemoDataCounts = Readonly<Record<SchoolDemoDataCountKey, number>>;

export type SchoolDemoDataView =
  | Readonly<{ status: 'NONE'; setId: null; version: null; loadedAt: null; counts: null; lastRemovedAt: string | null }>
  | Readonly<{ status: 'LOADED'; setId: string; version: number; loadedAt: string; counts: SchoolDemoDataCounts; lastRemovedAt: string | null }>;

export interface RemoveSchoolDemoDataInput { setId: string; expectedVersion: number }

/** Refusal codes the API returns for these commands. DEMO_DATA_IN_USE carries the table names that point at demo records. */
export const SCHOOL_DEMO_DATA_ERRORS = ['DEMO_DATA_FORBIDDEN', 'DEMO_DATA_ALREADY_LOADED', 'DEMO_DATA_NOT_LOADED', 'DEMO_DATA_IN_USE',
  'DEMO_DATA_REMOVE_FAILED', 'VERSION_CONFLICT', 'IDEMPOTENCY_KEY_REUSED', 'VALIDATION_FAILED'] as const;
export const SCHOOL_DEMO_DATA_LOAD_COMMAND = 'school.demo_data.load';
export const SCHOOL_DEMO_DATA_REMOVE_COMMAND = 'school.demo_data.remove';

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TABLE = /^[a-z][a-z0-9_]{0,62}$/;
const VIEW_KEYS = ['counts', 'lastRemovedAt', 'loadedAt', 'setId', 'status', 'version'];

function invalid(): never { throw new Error('Invalid school demo data.'); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  const own = Object.keys(row).sort();
  if (own.length !== keys.length || own.some((key, i) => key !== [...keys].sort()[i])) invalid();
  return row;
}
const instant = (v: unknown): string => { if (typeof v !== 'string' || !INSTANT.test(v) || Number.isNaN(Date.parse(v))) invalid(); return v; };
const count = (v: unknown): number => { if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100_000) invalid(); return v; };

export function verifySchoolDemoDataCounts(value: unknown): SchoolDemoDataCounts {
  const row = exact(value, SCHOOL_DEMO_DATA_COUNT_KEYS);
  return Object.freeze(Object.fromEntries(SCHOOL_DEMO_DATA_COUNT_KEYS.map(key => [key, count(row[key])]))) as SchoolDemoDataCounts;
}

/** The status the server sends. With `expect`, the answer must be the state that command leads to. */
export function verifySchoolDemoDataView(value: unknown, expect?: 'LOADED' | 'NONE'): SchoolDemoDataView {
  const row = exact(value, VIEW_KEYS);
  const lastRemovedAt = row.lastRemovedAt === null ? null : instant(row.lastRemovedAt);
  if (expect !== undefined && row.status !== expect) invalid();
  if (row.status === 'NONE') {
    if (row.setId !== null || row.version !== null || row.loadedAt !== null || row.counts !== null) invalid();
    return Object.freeze({ status: 'NONE', setId: null, version: null, loadedAt: null, counts: null, lastRemovedAt });
  }
  if (row.status !== 'LOADED' || typeof row.setId !== 'string' || !UUID.test(row.setId)
    || typeof row.version !== 'number' || !Number.isInteger(row.version) || row.version < 1 || row.version > 999_999_999) invalid();
  return Object.freeze({ status: 'LOADED', setId: row.setId, version: row.version, loadedAt: instant(row.loadedAt),
    counts: verifySchoolDemoDataCounts(row.counts), lastRemovedAt });
}

export function validateRemoveSchoolDemoDataInput(value: unknown): RemoveSchoolDemoDataInput {
  const row = exact(value, ['expectedVersion', 'setId']);
  if (typeof row.setId !== 'string' || !UUID.test(row.setId)) invalid();
  const v = row.expectedVersion;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 999_999_999) invalid();
  return { setId: row.setId, expectedVersion: v };
}
export function validateLoadSchoolDemoDataInput(value: unknown): Record<string, never> {
  exact(value, []);
  return {};
}

/** The table names in a DEMO_DATA_IN_USE refusal (what still points at demo records), for the screen to explain. */
export function verifySchoolDemoDataInUseTables(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50 || value.some(t => typeof t !== 'string' || !TABLE.test(t))) invalid();
  return [...new Set(value as string[])];
}
