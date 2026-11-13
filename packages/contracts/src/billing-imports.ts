// Onboarding B7 (0334): membership and opening-balance CSV import, staged and reviewed like the 0226 student import.
// Each imported row becomes, for one existing student, an ACTIVE membership with its activation evidence, an ACTIVE
// payment schedule with the imported terms (which the school-pay autopay cycle bills once the payer is enrolled), and an
// ISSUED invoice for any opening balance. Nothing here charges a card, contacts a processor or sends a message.

export const BILLING_IMPORT_FIELDS = ['studentGivenName', 'studentFamilyName', 'birthDate', 'payerGivenName', 'payerFamilyName', 'planName', 'amount',
  'currency', 'frequency', 'startedOn', 'endsOn', 'nextChargeOn', 'balanceOwed', 'balanceDueOn'] as const;
export const BILLING_IMPORT_REQUIRED = ['studentGivenName', 'studentFamilyName', 'planName', 'amount', 'frequency', 'startedOn', 'nextChargeOn'] as const;
/** Values the database adds to a normalized row after matching: the plan code, whether it matched the catalog, and minor-unit amounts. */
export const BILLING_IMPORT_DERIVED = ['planCode', 'planMatched', 'amountMinor', 'balanceMinor'] as const;
export type BillingImportField = typeof BILLING_IMPORT_FIELDS[number];
export type BillingImportMappingTarget = BillingImportField | 'ignore';
export const BILLING_IMPORT_MAX_BYTES = 262144;
export const BILLING_IMPORT_MAX_ROWS = 1000;
export const BILLING_IMPORT_MAX_COLUMNS = 24;

export interface BillingImportUpload { csv: string; mapping: Record<string, BillingImportMappingTarget> }
export interface BillingImportDecisionInput { expectedVersion: number; decisions: { index: number; choice: 'IMPORT' | 'SKIP' }[] }
export interface BillingImportFinalizeInput { expectedVersion: number; selectedIndices: number[] }

export interface BillingImportBatch {
  id: string; kind: 'MEMBERSHIPS'; version: number; status: 'STAGED' | 'FINALIZED';
  rowCount: number; validCount: number; importCount: number; skipCount: number; undecidedCount: number; importedCount: number; balanceCount: number;
  checksum: string; schoolToday: string; schoolTimezone: string; createdAt: string; finalizedAt: string | null;
}
export interface BillingImportCreated { billingAccountId: string; membershipId: string; scheduleId: string; invoiceId: string | null }
export interface BillingImportRow {
  index: number; raw: string[]; normalized: Record<string, string | boolean>; errors: string[];
  choice: 'IMPORT' | 'SKIP' | null; matchedStudentProfileId: string | null; payerPersonId: string | null; payerName: string | null;
  created: BillingImportCreated | null;
}
export interface BillingImportDetail { batch: BillingImportBatch; headers: string[]; mapping: Record<string, BillingImportMappingTarget>; rows: BillingImportRow[] }
export interface BillingImportList {
  batches: BillingImportBatch[]; fields: typeof BILLING_IMPORT_FIELDS; required: typeof BILLING_IMPORT_REQUIRED; maxBytes: number; maxRows: number; maxColumns: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function fail(what: string): never { throw new Error(`Unverified billing import ${what}.`); }
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
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > BILLING_IMPORT_MAX_ROWS) throw new Error('VALIDATION_FAILED');
  return value as number;
}

/** Closed mapping rules, the same as the database: every header mapped once to a field (or ignored); the required fields mapped. */
export function validateBillingImportMapping(headers: readonly string[], mapping: unknown): Record<string, BillingImportMappingTarget> {
  const m = closedInput(mapping, headers);
  const allowed: readonly string[] = BILLING_IMPORT_FIELDS;
  const values = Object.values(m);
  if (values.some(v => v !== 'ignore' && !allowed.includes(v as string))) throw new Error('VALIDATION_FAILED');
  const used = values.filter(v => v !== 'ignore') as string[];
  if (!used.length || new Set(used).size !== used.length || !BILLING_IMPORT_REQUIRED.every(f => used.includes(f))) throw new Error('VALIDATION_FAILED');
  return m as Record<string, BillingImportMappingTarget>;
}
export function validateBillingImportDecisionInput(value: unknown): BillingImportDecisionInput {
  const input = closedInput(value, ['expectedVersion', 'decisions']);
  const expectedVersion = version(input.expectedVersion);
  if (!Array.isArray(input.decisions) || !input.decisions.length || input.decisions.length > BILLING_IMPORT_MAX_ROWS) throw new Error('VALIDATION_FAILED');
  const decisions = input.decisions.map(item => {
    const d = closedInput(item, ['index', 'choice']);
    if (d.choice !== 'IMPORT' && d.choice !== 'SKIP') throw new Error('VALIDATION_FAILED');
    return { index: index(d.index), choice: d.choice as 'IMPORT' | 'SKIP' };
  });
  if (new Set(decisions.map(d => d.index)).size !== decisions.length) throw new Error('VALIDATION_FAILED');
  return { expectedVersion, decisions };
}
export function validateBillingImportFinalizeInput(value: unknown): BillingImportFinalizeInput {
  const input = closedInput(value, ['expectedVersion', 'selectedIndices']);
  const expectedVersion = version(input.expectedVersion);
  if (!Array.isArray(input.selectedIndices) || input.selectedIndices.length > BILLING_IMPORT_MAX_ROWS) throw new Error('VALIDATION_FAILED');
  const selectedIndices = input.selectedIndices.map(index);
  if (new Set(selectedIndices).size !== selectedIndices.length) throw new Error('VALIDATION_FAILED');
  return { expectedVersion, selectedIndices };
}

export function verifyBillingImportBatch(value: unknown): BillingImportBatch {
  const b = record(value, ['id', 'kind', 'version', 'status', 'rowCount', 'validCount', 'importCount', 'skipCount', 'undecidedCount', 'importedCount',
    'balanceCount', 'checksum', 'schoolToday', 'schoolTimezone', 'createdAt', 'finalizedAt'], 'batch');
  if (!uuid(b.id) || b.kind !== 'MEMBERSHIPS' || !Number.isSafeInteger(b.version) || (b.version as number) < 1
    || (b.status !== 'STAGED' && b.status !== 'FINALIZED') || !count(b.rowCount) || (b.rowCount as number) < 1
    || ![b.validCount, b.importCount, b.skipCount, b.undecidedCount, b.importedCount, b.balanceCount].every(x => count(x) && (x as number) <= (b.rowCount as number))
    || (b.importCount as number) + (b.skipCount as number) + (b.undecidedCount as number) !== b.rowCount
    || (b.importedCount as number) > (b.importCount as number) || (b.importCount as number) > (b.validCount as number)
    || (b.balanceCount as number) > (b.importedCount as number)
    || typeof b.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(b.checksum) || typeof b.schoolToday !== 'string' || !DAY.test(b.schoolToday)
    || !text(b.schoolTimezone, 64) || !b.schoolTimezone
    || typeof b.createdAt !== 'string' || !ISO.test(b.createdAt)
    || (b.status === 'FINALIZED') !== (typeof b.finalizedAt === 'string' && ISO.test(b.finalizedAt))
    || (b.status === 'STAGED' && (b.finalizedAt !== null || b.importedCount !== 0))
    || (b.status === 'FINALIZED' && (b.importedCount !== b.importCount || b.undecidedCount !== 0))) fail('batch');
  return b as unknown as BillingImportBatch;
}
function verifyRow(value: unknown, columns: number, finalized: boolean): BillingImportRow {
  const r = record(value, ['index', 'raw', 'normalized', 'errors', 'choice', 'matchedStudentProfileId', 'payerPersonId', 'payerName', 'created'], 'row');
  if (!count(r.index) || (r.index as number) < 1 || !Array.isArray(r.raw) || r.raw.length !== columns || !r.raw.every(x => text(x, 16384))
    || !Array.isArray(r.errors) || !r.errors.every(x => text(x, 80)) || (r.choice !== null && r.choice !== 'IMPORT' && r.choice !== 'SKIP')) fail('row');
  const n = r.normalized;
  if (!n || typeof n !== 'object' || Array.isArray(n)) fail('row');
  const allowed: readonly string[] = [...BILLING_IMPORT_FIELDS, ...BILLING_IMPORT_DERIVED];
  for (const [k, v] of Object.entries(n)) if (!allowed.includes(k) || !(k === 'planMatched' ? typeof v === 'boolean' : text(v, 16384))) fail('row');
  if (r.errors.length && r.choice === 'IMPORT') fail('row');
  // A row without problems always carries its matched student and payer; a row with problems carries neither.
  if (r.errors.length ? (r.matchedStudentProfileId !== null || r.payerPersonId !== null) : (!uuid(r.matchedStudentProfileId) || !uuid(r.payerPersonId))) fail('row');
  if (r.payerName !== null && (!text(r.payerName, 200) || r.payerPersonId === null)) fail('row');
  if (r.created === null) { if (finalized && r.choice === 'IMPORT') fail('row'); }
  else {
    const c = record(r.created, ['billingAccountId', 'membershipId', 'scheduleId', 'invoiceId'], 'row');
    if (r.choice !== 'IMPORT' || !uuid(c.billingAccountId) || !uuid(c.membershipId) || !uuid(c.scheduleId) || (c.invoiceId !== null && !uuid(c.invoiceId))) fail('row');
  }
  return r as unknown as BillingImportRow;
}
export function verifyBillingImportDetail(value: unknown, batchId: string): BillingImportDetail {
  const d = record(value, ['batch', 'headers', 'mapping', 'rows'], 'detail');
  const batch = verifyBillingImportBatch(d.batch);
  if (batch.id !== batchId || !Array.isArray(d.headers) || !d.headers.length || d.headers.length > BILLING_IMPORT_MAX_COLUMNS || !d.headers.every(h => text(h, 80))) fail('detail');
  try { validateBillingImportMapping(d.headers as string[], d.mapping); } catch { fail('detail'); }
  if (!Array.isArray(d.rows) || d.rows.length !== batch.rowCount) fail('detail');
  const rows = d.rows.map(r => verifyRow(r, (d.headers as string[]).length, batch.status === 'FINALIZED'));
  if (rows.some((r, i) => r.index !== i + 1)) fail('detail');
  return { batch, headers: d.headers as string[], mapping: d.mapping as Record<string, BillingImportMappingTarget>, rows };
}
export function verifyBillingImportList(value: unknown): BillingImportList {
  const l = record(value, ['batches', 'fields', 'required', 'maxBytes', 'maxRows', 'maxColumns'], 'list');
  if (!Array.isArray(l.batches) || l.batches.length > 25 || JSON.stringify(l.fields) !== JSON.stringify(BILLING_IMPORT_FIELDS)
    || JSON.stringify(l.required) !== JSON.stringify(BILLING_IMPORT_REQUIRED)
    || l.maxBytes !== BILLING_IMPORT_MAX_BYTES || l.maxRows !== BILLING_IMPORT_MAX_ROWS || l.maxColumns !== BILLING_IMPORT_MAX_COLUMNS) fail('list');
  return { batches: l.batches.map(verifyBillingImportBatch), fields: BILLING_IMPORT_FIELDS, required: BILLING_IMPORT_REQUIRED,
    maxBytes: BILLING_IMPORT_MAX_BYTES, maxRows: BILLING_IMPORT_MAX_ROWS, maxColumns: BILLING_IMPORT_MAX_COLUMNS };
}
